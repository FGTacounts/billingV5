"use client";

// Lightweight offline-tolerant queue for Warehouse picking on a weak mobile
// connection (§Part 4 Phase 2). Not a full service-worker/PWA rebuild — just
// enough that a picked-qty tap made mid-dead-zone survives and replays once
// the connection comes back, instead of silently failing or blocking the
// picker's flow.
const QUEUE_KEY = "fgt-offline-pick-queue";

export interface QueuedPick {
  itemId: string;
  pickedQty: number;
  queuedAt: string;
}

function readQueue(): QueuedPick[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedPick[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

// Later queued update for the same item supersedes the earlier one — only
// the final picked_qty for each item matters once it syncs.
export function queuePickUpdate(itemId: string, pickedQty: number) {
  const queue = readQueue().filter((q) => q.itemId !== itemId);
  queue.push({ itemId, pickedQty, queuedAt: new Date().toISOString() });
  writeQueue(queue);
}

export function getQueuedPickItemIds(): string[] {
  return readQueue().map((q) => q.itemId);
}

export function hasQueuedPicks(): boolean {
  return readQueue().length > 0;
}

// Replays every queued update against the real API route. Entries that
// fail (still offline, or a genuine server error) stay queued for the next
// attempt; entries that succeed are removed.
export async function flushPickQueue(): Promise<{ synced: string[]; failed: string[] }> {
  const queue = readQueue();
  if (queue.length === 0) return { synced: [], failed: [] };

  const synced: string[] = [];
  const failed: string[] = [];
  for (const entry of queue) {
    try {
      const res = await fetch("/api/orders/update-picked-qty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: entry.itemId, pickedQty: entry.pickedQty }),
      });
      if (res.ok) synced.push(entry.itemId);
      else failed.push(entry.itemId);
    } catch {
      failed.push(entry.itemId);
    }
  }
  writeQueue(queue.filter((q) => failed.includes(q.itemId)));
  return { synced, failed };
}
