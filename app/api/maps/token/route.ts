import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { appleMapsConfigured, mintDeveloperToken } from "@/lib/apple-maps";

export const runtime = "nodejs";

// Short-lived MapKit token for the browser. The signing key itself never
// leaves the server — this is the whole reason the endpoint exists.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!appleMapsConfigured()) {
    return NextResponse.json({ error: "Maps are not set up yet." }, { status: 501 });
  }

  try {
    // Bind the token to the site it is being served to, so a copied token is
    // useless anywhere else.
    const origin = req.nextUrl.origin;
    const { token, expiresIn } = mintDeveloperToken(origin);
    return NextResponse.json(
      { token, expiresIn },
      // Cache well inside the token's own lifetime.
      { headers: { "Cache-Control": "private, max-age=900" } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create a maps token" },
      { status: 500 }
    );
  }
}
