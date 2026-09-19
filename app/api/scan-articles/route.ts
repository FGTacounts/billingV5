import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { aiConfigured, type ScannedArticle } from "@/lib/ai-scan";
import { scanArticlesPreview, existingProductSkus, JobInputError } from "@/lib/job-runners";

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
//
// Rule 8 applies to phase 1 only, and phase 1 is now queued as
// `scan.articles`: this route's reading half is the fallback for a database
// without RUN-ME-23-job-queue.sql. Phase 2 is one insert of rows the manager
// has already checked — it is not long-running work and stays where it is.

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
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
        return NextResponse.json({ error: t("products.couldntReadApprovedRows") }, { status: 400 });
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return NextResponse.json({ error: t("products.noRowsToAdd") }, { status: 400 });
      }

      // Re-check for duplicates at save time, in case the catalogue changed
      // while the manager was reviewing.
      const existing = await existingProductSkus(admin);
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
        { error: t("products.scanNotConfigured") },
        { status: 503 }
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: t("products.noFileUploaded") }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: t("products.fileTooLarge") }, { status: 400 });
    }

    const mime =
      file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const { articles, duplicates } = await scanArticlesPreview(admin, base64, mime);

    return NextResponse.json({ ok: true, preview: true, articles, duplicates });
  } catch (e) {
    if (e instanceof JobInputError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : t("products.scanFailed") },
      { status: 500 }
    );
  }
}
