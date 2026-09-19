import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import {
  appleMapsConfigured,
  geocode,
  etasFrom,
  orderStops,
  type Place,
} from "@/lib/apple-maps";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Route planning, on Apple Maps.
//
// Apple has no equivalent of Google's `optimize:true`, which is what this
// used to lean on — so the ordering happens here instead: geocode the stops,
// ask Apple for travel times between them, then solve the order. Same
// response shape as before, so the Planning page did not have to change.
//
// Capped because the ETA matrix costs one call per ten destinations per row;
// a day's route is well under this.
const MAX_STOPS = 20;

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return t("planning.minutesShort", { n: m });
  const h = Math.floor(m / 60);
  return t("planning.hoursMinutes", { h, m: m % 60 });
}

function km(metres: number): string {
  return metres < 1000
    ? t("planning.distanceMetres", { n: Math.round(metres) })
    : t("planning.distanceKm", { n: (metres / 1000).toFixed(1) });
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const { origin, stops } = (await req.json()) as { origin: string; stops: string[] };
  if (!origin || !Array.isArray(stops) || stops.length === 0) {
    return NextResponse.json({ error: t("planning.originAndStopsRequired") }, { status: 400 });
  }
  if (!appleMapsConfigured()) {
    return NextResponse.json(
      { error: t("planning.mapsNotConfigured") },
      { status: 501 }
    );
  }
  if (stops.length > MAX_STOPS) {
    return NextResponse.json(
      { error: t("planning.tooManyStops", { count: stops.length, max: MAX_STOPS }) },
      { status: 400 }
    );
  }

  try {
    // 1. Addresses to coordinates.
    const [originPlace, ...stopPlaces] = await Promise.all([
      geocode(origin),
      ...stops.map((s) => geocode(s)),
    ]);
    if (!originPlace) {
      return NextResponse.json(
        { error: t("planning.originNotFound", { origin }) },
        { status: 422 }
      );
    }

    // A customer whose address can't be placed is reported rather than
    // silently dropped — otherwise a rep just never visits them and nobody
    // knows why.
    const unplaceable = stops.filter((_, i) => !stopPlaces[i]);
    const placed: Place[] = [];
    const placedIndex: number[] = [];
    stopPlaces.forEach((p, i) => {
      if (p) {
        placed.push(p);
        placedIndex.push(i);
      }
    });
    if (placed.length === 0) {
      return NextResponse.json(
        { error: t("planning.noAddressesFound") },
        { status: 422 }
      );
    }

    // 2. Travel times between every pair — origin first, then each stop.
    const nodes: Place[] = [originPlace, ...placed];
    const rows = await Promise.all(
      nodes.map(async (from) => {
        const etas = await etasFrom(from, nodes);
        return etas.map((e) => (e ? e.seconds : null));
      })
    );

    // 3. Solve the order.
    const order = orderStops(rows, placed.length);

    // 4. Describe each leg for the UI.
    const legs: { distanceText: string; durationText: string; startAddress: string; endAddress: string }[] = [];
    let totalSeconds = 0;
    let totalMetres = 0;
    let from = originPlace;
    for (const idx of order) {
      const to = placed[idx];
      const [eta] = await etasFrom(from, [to]);
      const seconds = eta?.seconds ?? 0;
      const metres = eta?.metres ?? 0;
      totalSeconds += seconds;
      totalMetres += metres;
      legs.push({
        distanceText: km(metres),
        durationText: minutes(seconds),
        startAddress: from.label,
        endAddress: to.label,
      });
      from = to;
    }

    return NextResponse.json({
      // Indices back into the caller's original stops array.
      waypointOrder: order.map((i) => placedIndex[i]),
      legs,
      summary: t("planning.routeSummary", {
        stops: legs.length,
        distance: km(totalMetres),
        duration: minutes(totalSeconds),
      }),
      unplaceable,
      // The coordinates the ordering was worked out from. Added so the
      // Planning map can drop a pin per stop and draw the route line without
      // geocoding the same addresses a second time from the browser — every
      // stop here was already placed above. `index` points back into the
      // caller's original stops array, same as waypointOrder.
      originPlace: { label: originPlace.label, lat: originPlace.lat, lon: originPlace.lon },
      places: placed.map((p, i) => ({
        index: placedIndex[i],
        label: p.label,
        lat: p.lat,
        lon: p.lon,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : t("planning.couldNotWorkOutRoute") },
      { status: 502 }
    );
  }
}
