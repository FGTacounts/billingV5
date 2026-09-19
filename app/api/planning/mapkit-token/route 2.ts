import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { appleMapsConfigured, mintDeveloperToken } from "@/lib/apple-maps";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";
// Every call mints a fresh, short-lived JWT — there is nothing here worth a
// cache, and a cached one would be handed out after it had expired.
export const dynamic = "force-dynamic";

// MapKit JS credentials for the Planning map.
//
// The .p8 signing key stays on the server — it is not behind NEXT_PUBLIC_ and
// never will be (rule 4). What the browser gets is the same short-lived,
// origin-bound developer token lib/apple-maps.ts already mints for the
// server-side ETA calls, which is exactly what MapKit JS's
// authorizationCallback expects.
//
// When Apple Maps is not configured this answers `{ configured: false }` with
// a 200 rather than an error: the map is an enhancement on top of the stop
// list, never a gate in front of it, so the page has to be able to ask and
// carry on quietly.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  if (!appleMapsConfigured()) return NextResponse.json({ configured: false });

  // Apple refuses the token if the page's origin does not match the one it
  // was signed for, so it has to be the origin the app is actually served
  // from — the Origin header when the browser sends one, the request's own
  // origin otherwise.
  const origin = req.headers.get("origin") || req.nextUrl.origin;

  try {
    const { token, expiresIn } = mintDeveloperToken(origin);
    return NextResponse.json({ configured: true, token, expiresIn });
  } catch {
    // A malformed key is the administrator's problem to fix, not something
    // to throw in a salesman's face mid-route: the list still works.
    return NextResponse.json({ configured: false });
  }
}
