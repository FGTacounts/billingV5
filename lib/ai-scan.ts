// Reading photographs of paperwork — a handwritten order pad, a supplier
// invoice — with Google's Gemini vision models.
//
// SECURITY: the key is read from GEMINI_API_KEY on the server and never
// leaves it. The browser only ever posts the image to our own /api routes.
//
// PRIVACY: on Gemini's free tier Google may use submitted content to improve
// their models, and what goes through here is supplier invoices and customer
// names. Use a paid tier if that matters.

import "server-only";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Fast, cheap, and good at handwriting. Override with GEMINI_MODEL if the
// account has access to something else.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export function aiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function callGemini(parts: GeminiPart[], systemPrompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set on the server");

  const res = await fetch(`${BASE}/${MODEL}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        // Reading a document is not a creative task; the same photo should
        // give the same answer twice.
        temperature: 0,
        // Ask for raw JSON so there are no markdown fences to unwrap.
        responseMimeType: "application/json",
      },
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error("The AI is rate limited right now. Wait a minute and try again.");
    }
    if (res.status === 404) {
      throw new Error(
        `The AI model "${MODEL}" isn't available on this key. Set GEMINI_MODEL to one that is.`
      );
    }
    throw new Error(`AI error ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.map((p: GeminiPart) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("The AI returned nothing — try a clearer photo.");
  return text;
}

function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last resort: pull the outermost JSON object or array out of the text.
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error("Could not read the AI's answer as JSON.");
  }
}

// ---- Orders -------------------------------------------------------------

export interface ScannedLine {
  articleNum: string;
  description: string;
  quantity: number;
  price: number | null;
}

export interface ScannedOrder {
  customer: string | null;
  lines: ScannedLine[];
}

const ORDER_PROMPT = `You read order sheets and supplier invoices for a UAE trading company.
The image may be a HANDWRITTEN order, a printed invoice, or a photo of either.
Extract every product line item.

Return ONLY JSON shaped exactly like:
{"customer": string|null, "lines": [{"articleNum": string, "description": string, "quantity": number, "price": number|null}]}

Rules:
- articleNum is the product/SKU/item code (e.g. "T20", "HBG420"). If no code is written, use "".
- description is the product name as written. If absent, use "".
- quantity is a positive integer. If unreadable, use 1.
- price is the unit price as a number, or null if not shown. Never guess a price.
- customer is the shop/customer name if visible, else null.
- Ignore totals, VAT, headers, and signatures — only real product lines.
- Read handwriting carefully; prefer an empty string over an invented value.`;

export async function scanOrderImage(
  base64: string,
  mimeType: string,
  knownArticles: { sku: string; name: string }[]
): Promise<ScannedOrder> {
  // A compact catalogue hint makes code and name matching far more accurate.
  const hint = knownArticles
    .slice(0, 400)
    .map((a) => `${a.sku}=${a.name}`)
    .join("; ");

  const parts: GeminiPart[] = [
    { inline_data: { mime_type: mimeType, data: base64 } },
    {
      text: hint
        ? `Known catalogue (code=name). Match to these codes where possible:\n${hint}`
        : "No catalogue provided.",
    },
  ];
  const raw = await callGemini(parts, ORDER_PROMPT);
  const out = parseJson<ScannedOrder>(raw);
  return {
    customer: out.customer ?? null,
    lines: Array.isArray(out.lines)
      ? out.lines
          .map((l) => ({
            articleNum: String(l.articleNum ?? "").trim(),
            description: String(l.description ?? "").trim(),
            quantity: Math.max(1, Math.round(Number(l.quantity) || 1)),
            price: l.price == null || isNaN(Number(l.price)) ? null : Number(l.price),
          }))
          .filter((l) => l.articleNum || l.description)
      : [],
  };
}

// ---- Products -----------------------------------------------------------

export interface ScannedArticle {
  sku: string;
  name: string;
  price: number;
  cost: number;
  default_qty: number;
  stock_on_hand: number;
  rack_location: string;
  barcode: string;
}

const ARTICLE_PROMPT = `You read supplier invoices and price lists for a UAE trading company and turn them into product rows.

Return ONLY JSON: {"articles": [{"sku": string, "name": string, "price": number, "cost": number, "default_qty": number, "stock_on_hand": number, "rack_location": string, "barcode": string}]}

Rules:
- sku = supplier item code. Required; skip any line without one.
- name = product description.
- cost = the unit cost the SUPPLIER charges (the invoice's unit price).
- price = 0. The selling price is decided by a person later — never invent it.
- default_qty = 1. stock_on_hand = quantity received on the invoice, or 0 if unclear.
- rack_location = "" unless a location is printed.
- barcode = the EAN/UPC digits if printed, else "".
- Ignore totals, VAT, and shipping lines.`;

export async function scanArticlesDoc(
  base64: string,
  mimeType: string
): Promise<ScannedArticle[]> {
  const parts: GeminiPart[] = [{ inline_data: { mime_type: mimeType, data: base64 } }];
  const raw = await callGemini(parts, ARTICLE_PROMPT);
  const out = parseJson<{ articles: ScannedArticle[] }>(raw);
  const list = Array.isArray(out.articles) ? out.articles : [];
  return list
    .map((a) => ({
      sku: String(a.sku ?? "").trim(),
      name: String(a.name ?? "").trim(),
      price: Number(a.price) || 0,
      cost: Number(a.cost) || 0,
      default_qty: Math.max(1, Math.round(Number(a.default_qty) || 1)),
      stock_on_hand: Math.max(0, Math.round(Number(a.stock_on_hand) || 0)),
      rack_location: String(a.rack_location ?? "").trim(),
      barcode: String(a.barcode ?? "").trim(),
    }))
    .filter((a) => a.sku);
}
