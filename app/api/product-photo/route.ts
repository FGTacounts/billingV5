import { NextRequest, NextResponse } from "next/server";
import { findProductPhoto, fetchDriveFileBytes } from "@/lib/google-drive";
import { getAppUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sku = req.nextUrl.searchParams.get("sku");
  if (!sku) return NextResponse.json({ error: "sku is required" }, { status: 400 });

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
    const { bytes, contentType } = await fetchDriveFileBytes(file.id);
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
      { error: err instanceof Error ? err.message : "Drive error" },
      { status: 502 }
    );
  }
}
