import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { importOrders, JobInputError, type ImportRow } from "@/lib/job-runners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A day's orders, imported from one spreadsheet.
//
// THIS IS NOW THE FALLBACK. Rule 8 puts the import on the queue: the Import
// button queues `orders.import` and the worker route runs it, so the request
// the manager is waiting on writes one row and returns. This route is what
// runs on a database where RUN-ME-23-job-queue.sql has not been applied, so
// importing still works without it.
//
// The import itself is importOrders() in lib/job-runners.ts — one copy, run
// from here and from the worker, with the rules it has always had: rows are
// grouped by invoice, unknown SKUs are reported rather than invented, and
// every order arrives `pending` for a manager to review.

export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const { rows } = (await req.json().catch(() => ({}))) as { rows?: ImportRow[] };

  try {
    const outcome = await importOrders(admin, rows ?? [], caller.id);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (e) {
    if (e instanceof JobInputError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "The import failed" },
      { status: 500 }
    );
  }
}
