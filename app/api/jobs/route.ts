import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { enqueueJob, readJob, isJobKind, JobQueueUnavailable } from "@/lib/jobs";
import { roleAllowsJob } from "@/lib/job-runners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The front of the queue (rule 8).
 *
 * POST writes one row and returns its id. That is deliberately all it does —
 * no PDFs, no spreadsheet, no AI call — so the request the user is actually
 * waiting on finishes in milliseconds however much work it just asked for.
 * /api/jobs/run is what does the work afterwards.
 *
 * GET answers "how far has it got", for a screen that wants to show progress
 * without holding a connection open.
 *
 * Both run as the caller (supabaseCaller, never service-role), so the row
 * rules from RUN-ME-23 decide what they can queue and see.
 *
 * If RUN-ME-23 has not been run, this answers `queued: false` rather than
 * failing: the caller then does the work the old inline way. Same shape of
 * retreat as fetchProductsServer() retrying without columns a migration has
 * not added yet.
 */

const QUEUE_NOT_INSTALLED = {
  ok: false as const,
  queued: false as const,
  reason: "queue-not-installed" as const,
};

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    kind?: unknown;
    params?: Record<string, unknown>;
  };

  if (!isJobKind(body.kind)) {
    return NextResponse.json({ error: "Unknown kind of work" }, { status: 400 });
  }
  // The same gate the inline handler applies, applied here too: a job must
  // not be queueable by someone who could not have asked for it directly.
  if (!roleAllowsJob(body.kind, user)) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  try {
    const job = await enqueueJob(supabaseCaller(), body.kind, body.params ?? {}, user.id);
    return NextResponse.json({ ok: true, queued: true, jobId: job.id, status: job.status });
  } catch (e) {
    if (e instanceof JobQueueUnavailable) return NextResponse.json(QUEUE_NOT_INSTALLED);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Which job?" }, { status: 400 });

  try {
    const job = await readJob(supabaseCaller(), id);
    if (!job) return NextResponse.json({ error: "No such job" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      queued: true,
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      complete: job.status === "done" || job.status === "failed",
      // While the job runs this is its progress; once it is done it is what
      // the job produced. See RUN-ME-23's comment on the column.
      result: job.result,
      error: job.error,
    });
  } catch (e) {
    if (e instanceof JobQueueUnavailable) return NextResponse.json(QUEUE_NOT_INSTALLED);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
