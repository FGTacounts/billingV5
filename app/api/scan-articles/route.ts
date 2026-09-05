import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { scanArticlesDoc, aiConfigured, type ScannedArticle } from "@/lib/ai-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A supplier invoice or price list, turned into products. Manager/Admin only,
// because it writes cost prices.
//
// Two phases, and only the first one costs an AI request:
//   1. POST a file           -> the AI reads it once and a preview comes back.
//   2. POST the reviewed rows -> written straight to the catalogue, no AI call.
// That keeps it to one request per document and guarantees what gets saved is
// exactly what the manager approved — a re-scan could read it differently.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  async function existingSkus(): Promise<Set<string>> {
    const { data } = await admin!.from("products").select("sku");
    return new Set((data ?? []).map((p: { sku: string }) => p.sku.toLowerCase()));
  }

  try {
    const form = await req.formData();
    const approved = form.get("articles");

    // ---- Phase 2: save the reviewed rows (no AI) ----
    if (typeof approved === "string" && approved.length > 0) {
      let rows: ScannedArticle[];
      try {
        rows = JSON.parse(approved);
      } catch {
        return NextResponse.json({ error: "Couldn't read the approved rows." }, { status: 400 });
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return NextResponse.json({ error: "There are no rows to add." }, { status: 400 });
      }

      // Re-check for duplicates at save time, in case the catalogue changed
      // while the manager was reviewing.
      const existing = await existingSkus();
      const fresh = rows.filter((a) => a.sku && !existing.has(String(a.sku).toLowerCase()));
      const duplicates = rows
        .filter((a) => existing.has(String(a.sku).toLowerCase()))
        .map((a) => a.sku);

      if (fresh.length === 0) {
        return NextResponse.json({ ok: true, added: 0, duplicates });
      }

      const { error } = await admin.from("products").insert(
        fresh.map((a) => ({
          sku: String(a.sku).trim(),
          // The catalogue keeps a product's name in `description`.
          description: String(a.name ?? "").trim(),
          price: Number(a.price) || 0,
          cost: Number(a.cost) || 0,
          default_qty: Math.max(1, Math.round(Number(a.default_qty) || 1)),
          stock_on_hand: Math.max(0, Math.round(Number(a.stock_on_hand) || 0)),
          rack_location: String(a.rack_location ?? "").trim() || null,
          barcode: String(a.barcode ?? "").trim() || null,
          is_active: true,
        }))
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });

      return NextResponse.json({ ok: true, added: fresh.length, duplicates });
    }

    // ---- Phase 1: read the document (one AI request) ----
    if (!aiConfigured()) {
      return NextResponse.json(
        { error: "Scanning isn't set up. Ask your administrator to add a GEMINI_API_KEY." },
        { status: 503 }
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file was uploaded" }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "That file is over 8MB." }, { status: 400 });
    }

    const mime =
      file.type ||
      (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const parsed = await scanArticlesDoc(base64, mime);
    if (parsed.length === 0) {
      return NextResponse.json(
        { error: "No product rows were found in that document." },
        { status: 400 }
      );
    }

    const existing = await existingSkus();
    const fresh = parsed.filter((a) => !existing.has(a.sku.toLowerCase()));
    const duplicates = parsed.filter((a) => existing.has(a.sku.toLowerCase())).map((a) => a.sku);

    return NextResponse.json({ ok: true, preview: true, articles: fresh, duplicates });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "The scan failed" },
      { status: 500 }
    );
  }
}
