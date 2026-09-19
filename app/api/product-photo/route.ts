import { NextRequest, NextResponse } from "next/server";
import { findProductPhoto, fetchDriveFileBytes, fetchDriveThumbnail } from "@/lib/google-drive";
import { getAppUser } from "@/lib/auth";
import { createHash } from "node:crypto";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Checking who is asking costs two round trips to Supabase (verify the token,
// read the staff row). A product grid asks for a hundred photos in the same
// second with the same login, so that was two hundred identical checks.
//
// A login that has just been verified is remembered for one minute, by a hash
// of the credential it presented — never the credential itself. Nothing is
// served without a verified login: the first photo of every minute still does
// the full check, and a forged or missing credential never gets into this map
// because only a SUCCESSFUL check writes to it. The cost is that a member of
// staff who is deactivated can still load product PHOTOS for up to a minute
// longer. This shortcut exists in this route only; nothing that reads or
// writes business data uses it.
const VERIFIED_FOR_MS = 60_000;
const verified = new Map<string, number>();

function credentialKey(req: NextRequest): string | null {
  const bearer = req.headers.get("authorization");
  const session = req.cookies
    .getAll()
    .filter((c) => c.name.startsWith("sb-"))
    .map((c) => `${c.name}=${c.value}`)
    .join(";");
  const presented = bearer || session;
  return presented ? createHash("sha256").update(presented).digest("hex") : null;
}

async function isSignedIn(req: NextRequest): Promise<boolean> {
  const key = credentialKey(req);
  const now = Date.now();
  if (key) {
    const until = verified.get(key);
    if (until && until > now) return true;
  }
  const user = await getAppUser();
  if (!user) return false;
  if (key) {
    verified.set(key, now + VERIFIED_FOR_MS);
    if (verified.size > 500) for (const [k, v] of verified) if (v <= now) verified.delete(k);
  }
  return true;
}

export async function GET(req: NextRequest) {
  if (!(await isSignedIn(req))) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const sku = req.nextUrl.searchParams.get("sku");
  if (!sku) return NextResponse.json({ error: t("products.skuRequired") }, { status: 400 });

  try {
    const file = await findProductPhoto(sku);
    if (!file) {
      // Cache the miss too. Most of a catalogue has no photo, and without
      // this every one of those products re-asked on every single page view.
      return new NextResponse(null, {
        status: 404,
        headers: { "Cache-Control": "private, max-age=3600" },
      });
    }
    // A grid asks for a width and gets Drive's thumbnail at that size. Only
    // the zoomed detail view asks for the original — CLAUDE.md is explicit
    // that a grid never gets a full-resolution image, and this endpoint was
    // handing every tile the whole file.
    const requested = Number(req.nextUrl.searchParams.get("w"));
    const width = Number.isFinite(requested) && requested > 0 ? Math.min(1024, Math.round(requested)) : null;

    let image: { bytes: ArrayBuffer; contentType: string } | null = null;
    if (width) image = await fetchDriveThumbnail(file.id, width);
    // No thumbnail yet (Drive has not rendered one for a new upload) — the
    // original is better than an empty tile.
    const { bytes, contentType } = image ?? (await fetchDriveFileBytes(file.id));
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": contentType,
        // Product photos essentially never change, and the URL is keyed by
        // SKU. Five minutes meant re-downloading every image through the
        // server several times an hour; a day with background revalidation
        // means the second visit is instant.
        "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("products.driveError") },
      { status: 502 }
    );
  }
}
