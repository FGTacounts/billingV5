import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchProductsServer } from "@/lib/products-server";
import { scanOrderImage, aiConfigured } from "@/lib/ai-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A photo of a handwritten order or a supplier invoice, turned into order
// lines. Open to every signed-in role — taking an order off a paper pad is
// the salesman's job, and it is the reason this exists.
//
// The catalogue is read with the non-manager column set, so no cost price is
// in scope on this path whoever is scanning.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  if (!aiConfigured()) {
    return NextResponse.json(
      { error: "Scanning isn't set up. Ask your administrator to add a GEMINI_API_KEY." },
      { status: 503 }
    );
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No image was uploaded" }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json(
        { error: "That image is over 8MB. Take the photo again at a smaller size." },
        { status: 400 }
      );
    }

    const products = await fetchProductsServer(supabaseAdmin(), { isManager: false, activeOnly: true });
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const scanned = await scanOrderImage(
      base64,
      file.type || "image/jpeg",
      products.map((p) => ({ sku: p.sku, name: p.name }))
    );

    // Match each scanned line to a real product: the code first, then the
    // barcode, then the description. A line that matches nothing is still
    // returned, so the person can see what was read and fix it rather than
    // wondering why it vanished.
    const bySku = new Map(products.map((p) => [p.sku.toLowerCase(), p]));
    const byBarcode = new Map(
      products.filter((p) => p.barcode).map((p) => [String(p.barcode).toLowerCase(), p])
    );

    const lines = scanned.lines.map((line) => {
      const code = line.articleNum.toLowerCase();
      let match = bySku.get(code) ?? byBarcode.get(code);
      if (!match && line.description) {
        const d = line.description.toLowerCase();
        match =
          products.find((p) => p.name.toLowerCase() === d) ??
          products.find(
            (p) => p.name.toLowerCase().includes(d) || d.includes(p.name.toLowerCase())
          );
      }
      return {
        productId: match?.id ?? null,
        sku: match?.sku ?? line.articleNum,
        description: match?.name ?? line.description,
        quantity: line.quantity,
        // What to show in the review table.
        price: line.price ?? match?.price ?? 0,
        // Kept separate: a price actually written on the paper is what was
        // agreed with the customer and should override the remembered one,
        // whereas a price we filled in from the catalogue should not.
        scannedPrice: line.price,
        matched: !!match,
        scannedAs: line.articleNum || line.description,
      };
    });

    return NextResponse.json({ ok: true, customer: scanned.customer, lines });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "The scan failed" },
      { status: 500 }
    );
  }
}
