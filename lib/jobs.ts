import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The queue rule 8 asks for, on top of one Postgres table
 * (scratchpad/RUN-ME-23-job-queue.sql).
 *
 * There is no worker process and no Redis, because there is no budget for
 * either and no host to run them on. What there is: a row per piece of work,
 * claimed by a conditional UPDATE, and a worker request that picks that row
 * up. Everything here runs through the CALLER's own Supabase client, never
 * service-role, so the row rules on `jobs` are doing real work — a person can
 * only queue, claim and finish their own jobs.
 */

export const JOB_KINDS = [
  "invoices.zip",
  "orders.import",
  "scan.order",
  "scan.articles",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  requested_by: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const JOB_COLUMNS =
  "id, kind, status, requested_by, params, result, error, created_at, started_at, finished_at";

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

/**
 * Thrown when the `jobs` table is not there yet.
 *
 * Every caller catches this and does the work inline instead, the same way
 * fetchProductsServer() retries without the columns a migration has not added
 * yet (lib/products-server.ts). Queueing is an improvement to how the work is
 * run, not a precondition for running it: an owner who has not pasted
 * RUN-ME-23 yet still gets their invoices.
 */
export class JobQueueUnavailable extends Error {
  constructor() {
    super("The job queue isn't set up yet.");
    this.name = "JobQueueUnavailable";
  }
}

/**
 * Is this PostgREST complaining that `jobs` does not exist?
 *
 * 42P01 is Postgres' own "undefined table". PGRST205 is PostgREST refusing
 * before Postgres is asked, because the table is not in its schema cache —
 * which is what actually comes back on a fresh database, and why matching on
 * the code alone is not enough.
 */
function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .*jobs.* does not exist|could not find the table/i.test(error.message ?? "");
}

function rethrow(error: { code?: string; message?: string } | null): never {
  if (missingTable(error)) throw new JobQueueUnavailable();
  throw new Error(error?.message ?? "The job queue could not be reached.");
}

/**
 * Put work on the queue. Returns as soon as one row is written — this is the
 * whole of what the request the user is waiting on has to do.
 */
export async function enqueueJob(
  db: SupabaseClient,
  kind: JobKind,
  params: Record<string, unknown>,
  requestedBy: string
): Promise<JobRow> {
  const { data, error } = await db
    .from("jobs")
    .insert({ kind, params, requested_by: requestedBy, status: "queued" })
    .select(JOB_COLUMNS)
    .single();
  if (error) rethrow(error);
  return data as JobRow;
}

/**
 * Take a named job, if it is still there to be taken.
 *
 * The guard is in the statement: `status = 'queued'` is part of the UPDATE's
 * WHERE clause, so two workers racing for the same row both send the same
 * statement and exactly one of them gets a row back. The loser gets null and
 * stops. Reading the status first and then writing it would let both read
 * 'queued' and both proceed.
 */
export async function claimJob(db: SupabaseClient, id: string): Promise<JobRow | null> {
  const { data, error } = await db
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "queued")
    .select(JOB_COLUMNS)
    .maybeSingle();
  if (error) rethrow(error);
  return (data as JobRow | null) ?? null;
}

/**
 * Take the oldest queued job the caller is allowed to see.
 *
 * The select only nominates candidates; the claim is still the conditional
 * UPDATE above, so losing a race costs one more attempt rather than doing
 * somebody else's work twice. This is how a worker with no particular job in
 * mind finds one — /api/jobs/run called with an empty body, which is how a
 * job whose first worker request never landed gets picked up.
 *
 * `unstarted` restricts that to jobs that have produced nothing yet. It
 * matters for work that returns through the response rather than the row: an
 * invoice export half-built for somebody else's browser would hand its
 * remaining slices to whoever claimed it blind, and they would assemble a zip
 * missing everything built before they arrived. A job with a null result has
 * no such tail to lose.
 */
export async function claimNextJob(
  db: SupabaseClient,
  opts: { kind?: JobKind; requestedBy?: string; unstarted?: boolean } = {}
): Promise<JobRow | null> {
  let q = db
    .from("jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(10);
  if (opts.kind) q = q.eq("kind", opts.kind);
  if (opts.requestedBy) q = q.eq("requested_by", opts.requestedBy);
  if (opts.unstarted) q = q.is("result", null);

  const { data, error } = await q;
  if (error) rethrow(error);

  for (const candidate of (data ?? []) as { id: string }[]) {
    const claimed = await claimJob(db, candidate.id);
    if (claimed) return claimed;
  }
  return null;
}

/**
 * Hand a part-finished job back to the queue with its progress recorded.
 *
 * Work that cannot fit in one request — 200 invoice PDFs — is done a slice at
 * a time, and between slices the row goes back to 'queued' so it is claimable
 * again rather than sitting 'running' forever behind a browser tab that may
 * already be closed.
 */
export async function releaseJob(
  db: SupabaseClient,
  id: string,
  progress: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from("jobs")
    .update({ status: "queued", result: progress })
    .eq("id", id);
  if (error) rethrow(error);
}

export async function finishJob(
  db: SupabaseClient,
  id: string,
  result: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from("jobs")
    .update({ status: "done", result, error: null, finished_at: new Date().toISOString() })
    .eq("id", id);
  if (error) rethrow(error);
}

/**
 * Record why a job failed.
 *
 * Deliberately swallows its own errors. This is called from a catch block,
 * and a queue that cannot write the failure down must not replace the real
 * reason with a complaint about itself — the caller still throws the original.
 */
export async function failJob(db: SupabaseClient, id: string, message: string): Promise<void> {
  try {
    await db
      .from("jobs")
      .update({
        status: "failed",
        error: message.slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch {
    // Nothing useful left to do here.
  }
}

export async function readJob(db: SupabaseClient, id: string): Promise<JobRow | null> {
  const { data, error } = await db
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) rethrow(error);
  return (data as JobRow | null) ?? null;
}
