import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { aiConfigured } from "@/lib/ai-scan";
import {
  claimJob,
  claimNextJob,
  finishJob,
  failJob,
  releaseJob,
  readJob,
  JobQueueUnavailable,
  type JobRow,
} from "@/lib/jobs";
import {
  roleAllowsJob,
  planInvoiceExport,
  buildInvoiceSlice,
  importOrders,
  scanOrderLines,
  scanArticlesPreview,
  JobInputError,
  INVOICE_SLICE,
  type ImportRow,
  type InvoiceFile,
} from "@/lib/job-runners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The worker.
 *
 * WHY IT IS A ROUTE AND NOT A PROCESS
 *
 * This app deploys to a serverless host. There is no machine that stays up
 * between requests to drain a queue, and cost discipline rules out renting
 * one, or a hosted queue, or Redis. So the worker is a request — but not the
 * request the user is waiting on. The button POSTs to /api/jobs, gets an id
 * back immediately, and then drives this route. That is the honest version of
 * rule 8 on this infrastructure, and it buys the three things the rule is
 * actually for:
 *
 *   • the handler the user's click hits does no heavy work and returns fast;
 *   • work too big for one request is done a slice at a time, so the bulk
 *     invoice export stops dying at the platform timeout;
 *   • a failure is written onto the job row, so "it just spun and nothing
 *     happened" becomes a row saying what went wrong and when.
 *
 * Everything touching `jobs` goes through the caller's own client, so the
 * RLS from RUN-ME-23 is what stops one person running another's work.
 * Service-role appears only where the work itself always needed it — order
 * lines carry a cost snapshot the importing session cannot read.
 */

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

interface SliceOutcome {
  complete: boolean;
  /** Written to the job row. Progress while running, the result when done. */
  state: Record<string, unknown>;
  /** Returned to the caller and never stored — PDFs do not belong in a row. */
  files?: InvoiceFile[];
  progress?: { done: number; total: number };
}

/** The running state a part-built invoice export carries between slices. */
interface InvoiceProgress {
  orderIds?: string[];
  names?: string[];
  done?: number;
  total?: number;
}

async function runSlice(job: JobRow, file: File | null, callerId: string): Promise<SliceOutcome> {
  const db = supabaseCaller();

  switch (job.kind) {
    // The one that times out today: up to 200 PDFs. Each request builds
    // INVOICE_SLICE of them and hands the job back to the queue, so no single
    // request is ever asked to do all of it.
    case "invoices.zip": {
      const state = (job.result ?? {}) as InvoiceProgress;
      const orderIds = state.orderIds ?? (await planInvoiceExport(db));
      const names = state.names ?? [];
      const done = state.done ?? 0;

      const slice = orderIds.slice(done, done + INVOICE_SLICE);
      const files = await buildInvoiceSlice(db, slice, names);

      const nextNames = [...names, ...files.map((f) => f.name)];
      const nextDone = done + slice.length;
      const complete = nextDone >= orderIds.length;

      return {
        complete,
        files,
        progress: { done: nextDone, total: orderIds.length },
        state: complete
          ? { total: orderIds.length, built: nextNames.length }
          : { orderIds, names: nextNames, done: nextDone, total: orderIds.length },
      };
    }

    case "orders.import": {
      const rows = (job.params?.rows ?? []) as ImportRow[];
      const outcome = await importOrders(supabaseAdmin(), rows, callerId);
      return {
        complete: true,
        state: { ...outcome },
        progress: { done: outcome.count, total: outcome.count },
      };
    }

    // The file is not stored on the job row — an 8MB photo as base64 in jsonb
    // is a row nobody wants. It rides along with this request instead, which
    // is the only request that needs it.
    case "scan.order": {
      const { base64, mime } = await readUpload(file, "image/jpeg");
      const outcome = await scanOrderLines(supabaseAdmin(), base64, mime);
      return { complete: true, state: { ...outcome }, progress: { done: 1, total: 1 } };
    }

    case "scan.articles": {
      const fallbackMime = (file?.name ?? "").toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : "image/jpeg";
      const { base64, mime } = await readUpload(file, fallbackMime);
      const outcome = await scanArticlesPreview(supabaseAdmin(), base64, mime);
      return { complete: true, state: { ...outcome }, progress: { done: 1, total: 1 } };
    }
  }
}

async function readUpload(file: File | null, fallbackMime: string) {
  if (!file) throw new JobInputError("No file was uploaded");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new JobInputError("That file is over 8MB. Take the photo again at a smaller size.");
  }
  return {
    base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
    mime: file.type || fallbackMime,
  };
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // A scan arrives as multipart because it carries the document; everything
  // else is a bare job id.
  let jobId: string | null = null;
  let file: File | null = null;
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    const id = form.get("jobId");
    jobId = typeof id === "string" && id ? id : null;
    const upload = form.get("file");
    file = upload instanceof File ? upload : null;
  } else {
    const body = (await req.json().catch(() => ({}))) as { jobId?: string };
    jobId = body.jobId ?? null;
  }

  const db = supabaseCaller();

  let job: JobRow | null;
  try {
    // Claiming is a conditional UPDATE, so two tabs racing for the same job
    // cannot both get it. With no id, the caller's own oldest job that has
    // produced nothing yet is picked up instead — that is a job whose first
    // worker request never landed. One already part-built is deliberately
    // left alone: its earlier slices went to a browser that is not this one.
    job = jobId
      ? await claimJob(db, jobId)
      : await claimNextJob(db, { requestedBy: user.id, unstarted: true });
  } catch (e) {
    if (e instanceof JobQueueUnavailable) {
      return NextResponse.json({ ok: false, queued: false, reason: "queue-not-installed" });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  if (!job) {
    // Nothing was claimable. Either somebody else has it, or it is already
    // finished — both of which the caller would rather be told than retry.
    const existing = jobId ? await readJob(db, jobId).catch(() => null) : null;
    if (!existing) {
      return NextResponse.json({ error: "That job isn't waiting to be run." }, { status: 404 });
    }
    return NextResponse.json({
      ok: existing.status !== "failed",
      queued: true,
      jobId: existing.id,
      status: existing.status,
      complete: existing.status === "done" || existing.status === "failed",
      result: existing.result,
      error: existing.error,
    });
  }

  if (!roleAllowsJob(job.kind, user)) {
    await failJob(db, job.id, "Manager access required");
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  if ((job.kind === "scan.order" || job.kind === "scan.articles") && !aiConfigured()) {
    const message = "Scanning isn't set up. Ask your administrator to add a GEMINI_API_KEY.";
    await failJob(db, job.id, message);
    return NextResponse.json({ error: message }, { status: 503 });
  }

  try {
    const outcome = await runSlice(job, file, user.id);

    if (outcome.complete) await finishJob(db, job.id, outcome.state);
    else await releaseJob(db, job.id, outcome.state);

    return NextResponse.json({
      ok: true,
      queued: true,
      jobId: job.id,
      kind: job.kind,
      status: outcome.complete ? "done" : "queued",
      complete: outcome.complete,
      progress: outcome.progress,
      result: outcome.complete ? outcome.state : null,
      files: outcome.files,
    });
  } catch (e) {
    // The whole reason for the row: a failure is recorded against the job
    // instead of disappearing with the connection.
    const message = e instanceof Error ? e.message : "The job failed";
    await failJob(db, job.id, message);
    return NextResponse.json(
      { error: message, jobId: job.id, status: "failed", complete: true },
      { status: e instanceof JobInputError ? e.status : 500 }
    );
  }
}
