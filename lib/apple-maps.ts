import "server-only";
import crypto from "node:crypto";

// Apple MapKit — server-side credentials and token minting.
//
// The .p8 is a signing key: anyone holding it can issue tokens against your
// Apple Maps quota until it is revoked. It never leaves the server. The
// browser gets a short-lived JWT instead, which is what MapKit JS expects.

const TOKEN_TTL_SECONDS = 30 * 60; // Apple allows up to 7 days; short is safer.

function privateKey(): string {
  const b64 = process.env.APPLE_MAPS_PRIVATE_KEY_BASE64;
  if (!b64) throw new Error("Apple Maps is not configured");
  return Buffer.from(b64, "base64").toString("utf8");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function appleMapsConfigured(): boolean {
  return Boolean(
    process.env.APPLE_MAPS_TEAM_ID &&
      process.env.APPLE_MAPS_KEY_ID &&
      process.env.APPLE_MAPS_PRIVATE_KEY_BASE64
  );
}

/**
 * A signed MapKit developer token.
 *
 * `origin` binds the token to one website so a leaked token cannot be used
 * from anywhere else. Apple rejects the token if the page's origin does not
 * match, so it must be exactly the scheme+host the app is served from.
 */
export function mintDeveloperToken(origin?: string): { token: string; expiresIn: number } {
  const teamId = process.env.APPLE_MAPS_TEAM_ID;
  const keyId = process.env.APPLE_MAPS_KEY_ID;
  if (!teamId || !keyId) throw new Error("Apple Maps is not configured");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: teamId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  if (origin) payload.origin = origin;

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  // ES256 signatures must be raw R||S (64 bytes). Node emits DER for EC keys
  // unless told otherwise, and a DER signature is silently rejected by Apple
  // — it looks like a bad key rather than a bad encoding.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey(),
    dsaEncoding: "ieee-p1363",
  });

  return {
    token: `${signingInput}.${base64url(signature)}`,
    expiresIn: TOKEN_TTL_SECONDS,
  };
}

/**
 * Exchanges the developer token for an access token for the Apple Maps
 * *Server* API (maps-api.apple.com), which is what the ETA endpoint needs.
 * Cached until shortly before it expires — Apple rate-limits this exchange.
 */
let serverToken: { value: string; expiresAt: number } | null = null;

export async function appleMapsAccessToken(): Promise<string> {
  if (serverToken && Date.now() < serverToken.expiresAt - 60_000) return serverToken.value;

  // No origin here: this token is used server-to-server, not from a page.
  const { token } = mintDeveloperToken();
  const res = await fetch("https://maps-api.apple.com/v1/token", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Apple Maps rejected the credentials (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { accessToken: string; expiresInSeconds: number };
  serverToken = {
    value: data.accessToken,
    expiresAt: Date.now() + (data.expiresInSeconds ?? 1800) * 1000,
  };
  return serverToken.value;
}

const API = "https://maps-api.apple.com/v1";

export interface Place {
  label: string;
  lat: number;
  lon: number;
}

/** Address text -> coordinates. Returns null when Apple can't place it. */
export async function geocode(query: string): Promise<Place | null> {
  const token = await appleMapsAccessToken();
  const res = await fetch(`${API}/geocode?q=${encodeURIComponent(query)}&limitToCountries=AE`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: { name?: string; formattedAddressLines?: string[]; coordinate?: { latitude: number; longitude: number } }[];
  };
  const hit = data.results?.[0];
  if (!hit?.coordinate) return null;
  return {
    label: hit.formattedAddressLines?.join(", ") || hit.name || query,
    lat: hit.coordinate.latitude,
    lon: hit.coordinate.longitude,
  };
}

export interface Eta {
  seconds: number;
  metres: number;
}

// Apple takes at most 10 destinations per call.
const MAX_DESTINATIONS = 10;

/** Travel time and distance from one origin to many destinations. */
export async function etasFrom(origin: Place, destinations: Place[]): Promise<(Eta | null)[]> {
  const token = await appleMapsAccessToken();
  const out: (Eta | null)[] = [];

  for (let i = 0; i < destinations.length; i += MAX_DESTINATIONS) {
    const batch = destinations.slice(i, i + MAX_DESTINATIONS);
    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lon}`,
      destinations: batch.map((d) => `${d.lat},${d.lon}`).join("|"),
      transportType: "Automobile",
    });
    const res = await fetch(`${API}/etas?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      out.push(...batch.map(() => null));
      continue;
    }
    const data = (await res.json()) as {
      etas?: { destination: { latitude: number; longitude: number }; expectedTravelTimeSeconds?: number; distanceMeters?: number }[];
    };
    // Apple does not guarantee the response order matches the request, so
    // match each result back to its destination by coordinate.
    for (const d of batch) {
      const hit = (data.etas ?? []).find(
        (e) =>
          Math.abs(e.destination.latitude - d.lat) < 1e-5 &&
          Math.abs(e.destination.longitude - d.lon) < 1e-5
      );
      out.push(
        hit
          ? { seconds: hit.expectedTravelTimeSeconds ?? 0, metres: hit.distanceMeters ?? 0 }
          : null
      );
    }
  }
  return out;
}

/**
 * Order the stops into a short route, starting from `origin`.
 *
 * Apple has no equivalent of Google's waypoint optimisation, so this does it
 * here: nearest-neighbour to get a sensible route, then 2-opt to untangle any
 * crossings it left behind. For the ten to twenty stops a salesman covers in
 * a day that lands within a few percent of optimal, which is well inside the
 * noise of real traffic.
 */
export function orderStops(matrix: (number | null)[][], count: number): number[] {
  const cost = (a: number, b: number) => matrix[a]?.[b] ?? Number.MAX_SAFE_INTEGER / 4;

  // Nearest neighbour from the origin (node 0); stops are nodes 1..count.
  const unvisited = new Set<number>();
  for (let i = 1; i <= count; i++) unvisited.add(i);
  const route: number[] = [];
  let current = 0;
  while (unvisited.size) {
    let best = -1;
    let bestCost = Infinity;
    for (const n of unvisited) {
      const c = cost(current, n);
      if (c < bestCost) {
        bestCost = c;
        best = n;
      }
    }
    route.push(best);
    unvisited.delete(best);
    current = best;
  }

  // 2-opt: repeatedly reverse a segment if doing so shortens the route.
  const legLength = (r: number[]) => {
    let total = 0;
    let prev = 0;
    for (const n of r) {
      total += cost(prev, n);
      prev = n;
    }
    return total;
  };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const candidate = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
        if (legLength(candidate) < legLength(route) - 1) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  // Back to zero-based stop indices for the caller.
  return route.map((n) => n - 1);
}
