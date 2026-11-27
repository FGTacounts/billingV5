// The road a salesman's device drove, as points from public.location_points
// (RUN-ME-46), turned into what the Planning map draws: lines and a distance.
//
// No imports, on purpose: it is plain arithmetic and the phone does the same
// in DrivenRouteSheet.swift. Change one, change both.

export interface TrailPoint {
  /** ISO instant the device took the fix. */
  t: string;
  lat: number;
  lon: number;
  /** The device's own estimate of how far off the fix may be, in metres. */
  acc: number | null;
}

/**
 * A pause longer than this, ending more than GAP_METRES from where it began,
 * means nothing was recorded in between (out of signal, location turned off,
 * the app closed) — not that the van flew in a straight line. The line is
 * broken there, and the jump is not counted as distance driven. A long stop
 * at a shop ends near where it began and stays joined.
 */
export const GAP_MINUTES = 20;
export const GAP_METRES = 1000;

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two points, in metres. */
export function haversineMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The points as unbroken stretches, oldest first. Expects them sorted by time. */
export function splitTrail(points: readonly TrailPoint[]): TrailPoint[][] {
  const segments: TrailPoint[][] = [];
  let current: TrailPoint[] = [];
  for (const point of points) {
    const previous = current[current.length - 1];
    if (previous) {
      const minutes = (Date.parse(point.t) - Date.parse(previous.t)) / 60_000;
      if (minutes > GAP_MINUTES && haversineMetres(previous, point) > GAP_METRES) {
        segments.push(current);
        current = [];
      }
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Distance driven along the stretches, in whole metres. Gaps count nothing. */
export function trailDistanceMetres(segments: readonly TrailPoint[][]): number {
  let total = 0;
  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++) total += haversineMetres(segment[i - 1], segment[i]);
  }
  return Math.round(total);
}

/**
 * Somewhere the device stayed: points that all sit within STOP_METRES of the
 * first of them, for at least STOP_MINUTES. The device records a point only
 * after moving ~150 m, so standing still produces no points — the stay runs
 * from the first point there to the first point recorded after leaving.
 * If what comes next is a gap (see splitTrail), the stay ends at its own last
 * point instead: nobody knows when the device left.
 */
export const STOP_METRES = 250;
export const STOP_MINUTES = 5;

export interface Stop {
  lat: number;
  lon: number;
  /** ISO instants: first point there, and when it was seen leaving. */
  from: string;
  to: string;
  minutes: number;
}

export function findStops(points: readonly TrailPoint[]): Stop[] {
  const stops: Stop[] = [];
  let i = 0;
  while (i < points.length) {
    const anchor = points[i];
    let j = i + 1;
    while (j < points.length && haversineMetres(anchor, points[j]) <= STOP_METRES) j++;
    // points[i..j-1] are the run; points[j] (if any) is the first one away.
    const lastHere = points[j - 1];
    const next = points[j];
    let leftAt = lastHere.t;
    if (next) {
      const minutes = (Date.parse(next.t) - Date.parse(lastHere.t)) / 60_000;
      const isGap = minutes > GAP_MINUTES && haversineMetres(lastHere, next) > GAP_METRES;
      if (!isGap) leftAt = next.t;
    }
    const minutes = Math.round((Date.parse(leftAt) - Date.parse(anchor.t)) / 60_000);
    if (minutes >= STOP_MINUTES) {
      const run = points.slice(i, j);
      stops.push({
        lat: run.reduce((n, p) => n + p.lat, 0) / run.length,
        lon: run.reduce((n, p) => n + p.lon, 0) / run.length,
        from: anchor.t,
        to: leftAt,
        minutes,
      });
    }
    i = j;
  }
  return stops;
}

// ---- The replay: the day's line drawing itself when it opens ------------
//
// Owner, 2026-11-27: "make a fluid animation of the path they take each day
// when opened", and chose a ~4 second replay over the 400 ms cap in
// CLAUDE.md — the one exception to it (docs/DECISIONS.md). The line grows
// along the road at a pace set by distance, not by the clock, so a long
// drive and a short hop both read as one steady stroke; gaps are skipped.
// Eased in and out (a cosine), not sprung: a spring front-loads the motion
// and would draw most of the day in the first second.

export const REPLAY_MS = 4000;

/** 0→1 progress for 0→1 time, gentle at both ends. */
export function replayEase(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

type LatLon = { lat: number; lon: number };

export interface ReplayGeometry {
  segments: LatLon[][];
  /** Metres from the start of the whole line to each point. */
  along: number[][];
  total: number;
}

export function replayGeometry(segments: readonly LatLon[][]): ReplayGeometry {
  let total = 0;
  const along = segments.map((segment) =>
    segment.map((point, i) => {
      if (i > 0) total += haversineMetres(segment[i - 1], point);
      return total;
    })
  );
  return { segments: segments.map((s) => [...s]), along, total };
}

/**
 * The line as it stands `metres` into the replay: each stretch cut where the
 * head has reached (an empty stretch is one not reached yet), and the head.
 */
export function trailUpTo(geometry: ReplayGeometry, metres: number): { partial: LatLon[][]; head: LatLon | null } {
  let head: LatLon | null = null;
  const partial = geometry.segments.map((segment, s) => {
    const along = geometry.along[s];
    if (!segment.length || metres < along[0]) return [];
    const out: LatLon[] = [segment[0]];
    head = segment[0];
    for (let i = 1; i < segment.length; i++) {
      if (along[i] <= metres) {
        out.push(segment[i]);
        head = segment[i];
        continue;
      }
      const span = along[i] - along[i - 1];
      const f = span > 0 ? (metres - along[i - 1]) / span : 0;
      const a = segment[i - 1];
      const b = segment[i];
      const cut = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
      out.push(cut);
      head = cut;
      break;
    }
    return out;
  });
  return { partial, head };
}

/** How far into the replay the line passes closest to a place. */
export function distanceAlong(geometry: ReplayGeometry, place: LatLon): number {
  let best = Infinity;
  let at = 0;
  geometry.segments.forEach((segment, s) =>
    segment.forEach((point, i) => {
      const d = haversineMetres(point, place);
      if (d < best) {
        best = d;
        at = geometry.along[s][i];
      }
    })
  );
  return at;
}
