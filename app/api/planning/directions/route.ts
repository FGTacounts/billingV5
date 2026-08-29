import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import {
  appleMapsConfigured,
  geocode,
  etasFrom,
  orderStops,
  type Place,
} from "@/lib/apple-maps";

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
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}

function km(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { origin, stops } = (await req.json()) as { origin: string; stops: string[] };
  if (!origin || !Array.isArray(stops) || stops.length === 0) {
    return NextResponse.json({ error: "origin and stops are required" }, { status: 400 });
  }
  if (!appleMapsConfigured()) {
    return NextResponse.json(
      { error: "Maps aren't set up yet — ask your administrator." },
      { status: 501 }
    );
  }
  if (stops.length > MAX_STOPS) {
    return NextResponse.json(
      { error: `That's ${stops.length} stops — plan up to ${MAX_STOPS} at a time.` },
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
        { error: `Couldn't find "${origin}" on the map. Try a more complete address.` },
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
        { error: "None of those addresses could be found on the map." },
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
      summary: `${legs.length} stops · ${km(totalMetres)} · ${minutes(totalSeconds)} driving`,
      unplaceable,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not work out a route" },
      { status: 502 }
    );
  }
}
