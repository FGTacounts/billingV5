import type { JobKind } from "@/lib/jobs";

/**
 * The browser half of the queue (rule 8).
 *
 * A screen calls runQueuedJob(), which writes the job, then drives the worker
 * route one slice at a time and reports progress as it goes. Nothing here
 * holds a single long connection open, which is the point: the request that
 * used to time out is now a series of short ones.
 *
 * `null` means the queue is not installed on this database yet — the caller
 * falls back to the old inline endpoint rather than losing the feature. Same
 * retreat as fetchProductsServer() re-querying without the columns a
 * migration has not added (lib/products-server.ts).
 *
 * The type import is erased at build time, so the server-only module it names
 * never reaches the browser bundle.
 */

export interface JobProgress {
  done: number;
  total: number;
}

export interface JobFile {
  name: string;
  /** base64, because it crossed a JSON response. */
  base64: string;
}

export interface JobRunResult {
  result: Record<string, unknown> | null;
  /** Collected across every slice, in the order they were built. */
  files: JobFile[];
}

// A job that never reports itself complete would otherwise loop forever. At
// INVOICE_SLICE = 20 the largest job in the app is ten requests, so this is
// two orders of magnitude of headroom and still a finite number.
const MAX_SLICES = 500;

/** Writes the job row. Returns its id, or null if there is no queue. */
export async function startJob(
  kind: JobKind,
  params: Record<string, unknown> = {}
): Promise<string | null> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Couldn't queue that.");
  if (data.queued === false) return null;
  return (data.jobId as string) ?? null;
}

/**
 * Queue the work and see it through.
 *
 * `file` is re-sent with each slice, so a document scan carries its image
 * without that image ever being written to a database row. `onProgress` is
 * called after every slice with real counts — the screen shows how far it has
 * actually got, not an animation standing in for one.
 */
export async function runQueuedJob(
  kind: JobKind,
  params: Record<string, unknown> = {},
  opts: { file?: File; onProgress?: (p: JobProgress) => void } = {}
): Promise<JobRunResult | null> {
  const jobId = await startJob(kind, params);
  if (!jobId) return null;

  const files: JobFile[] = [];

  for (let slice = 0; slice < MAX_SLICES; slice++) {
    let res: Response;
    if (opts.file) {
      const fd = new FormData();
      fd.append("jobId", jobId);
      fd.append("file", opts.file);
      res = await fetch("/api/jobs/run", { method: "POST", body: fd });
    } else {
      res = await fetch("/api/jobs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "That job failed.");
    // The table went away between queueing and running. Vanishingly unlikely,
    // but the answer is the same as never having had it: do it inline.
    if (data.queued === false) return null;

    if (Array.isArray(data.files)) files.push(...(data.files as JobFile[]));
    if (data.progress) opts.onProgress?.(data.progress as JobProgress);

    if (data.complete) {
      if (data.status === "failed") throw new Error(data.error ?? "That job failed.");
      return { result: (data.result as Record<string, unknown>) ?? null, files };
    }
  }

  throw new Error("That job didn't finish. Try again.");
}
