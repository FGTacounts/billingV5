import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { scanOrderLines } from "@/lib/job-runners";
import { aiConfigured } from "@/lib/ai-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A photo of a handwritten order or a supplier invoice, turned into order
// lines. Open to every signed-in role — taking an order off a paper pad is
// the salesman's job, and it is the reason this exists.
//
// THIS IS NOW THE FALLBACK. Rule 8 puts the scan on the queue: the camera
// button queues `scan.order` and the worker route makes the AI call, so a
// scan that fails leaves a row saying why instead of a sheet that sat there
// and then said "the scan failed". This route is what runs when
// RUN-ME-23-job-queue.sql has not been applied yet.
//
// The catalogue is read with the non-manager column set (scanOrderLines in
// lib/job-runners.ts), so no cost price is in scope on this path whoever is
// scanning.

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  if (!aiConfigured()) {
    return NextResponse.json(
      { error: t("products.scanNotConfigured") },
      { status: 503 }
    );
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: t("products.noImageUploaded") }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json(
        { error: t("products.imageTooLarge8mb") },
        { status: 400 }
      );
    }

    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const { customer, lines } = await scanOrderLines(
      supabaseAdmin(),
      base64,
      file.type || "image/jpeg"
    );

    return NextResponse.json({ ok: true, customer, lines });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : t("products.scanFailed") },
      { status: 500 }
    );
  }
}
