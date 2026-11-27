"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/motion";
import { Card } from "@/components/ui/Card";
import { t } from "@/lib/i18n";
import { REPLAY_MS, distanceAlong, replayEase, replayGeometry, trailUpTo } from "@/lib/routeTrail";

// The Planning map (parity with the phone, which draws the same pins and
// route line in `Map { ... MapPolyline }`).
//
// MapKit JS, on the Apple Maps credentials this app already holds — no second
// mapping account, no second key, nothing new to pay for. The signing key
// stays on the server; this asks /api/planning/mapkit-token for the
// short-lived, origin-bound JWT MapKit expects and hands that to
// `authorizationCallback`.
//
// The map is an enhancement on top of the stop list, never a gate in front of
// it: if the token route says Apple Maps is not configured, or the script
// cannot be reached, this renders nothing at all and the page is exactly the
// page it was before.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    mapkit?: any;
  }
}

const MAPKIT_SRC = "https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js";

export type MapPinTone = "danger" | "accent" | "warning" | "neutral";

export interface RouteMapStop {
  customerId: string;
  name: string;
  subtitle?: string;
  lat: number;
  lon: number;
  tone: MapPinTone;
  /** What the pin shows. The stop's place in the list (1, 2, 3…) when absent. */
  glyph?: string;
  /** Read out instead of "Stop n: name". */
  accessibilityLabel?: string;
  /** A colour token for the pin (e.g. "--stay-30"), instead of `tone`'s. */
  color?: string;
}

export interface RouteMapOrigin {
  label: string;
  lat: number;
  lon: number;
}

// Pin colour comes from the same semantic tokens the pills beside the stop
// names use, read off the document at draw time — MapKit wants a colour
// string, so the alternative would have been raw hex in a component.
const TONE_VARIABLE: Record<MapPinTone, string> = {
  danger: "--status-danger",
  accent: "--accent",
  warning: "--status-warning",
  neutral: "--text-secondary",
};

function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

let scriptPromise: Promise<void> | null = null;

function loadMapKitScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.mapkit) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${MAPKIT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("MapKit JS could not be loaded")));
    if (!existing) {
      script.src = MAPKIT_SRC;
      script.async = true;
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
    }
  }).catch((e) => {
    // Let a later mount try again rather than caching the failure forever.
    scriptPromise = null;
    throw e;
  });
  return scriptPromise;
}

let initialised = false;

/**
 * MapKit loaded and initialised, or null when Apple Maps is not configured
 * or cannot be reached. Shared by the maps and by `placeName`.
 */
async function ensureMapKit(): Promise<any | null> {
  const first = await fetchToken().catch(() => null);
  if (!first) return null;
  try {
    await loadMapKitScript();
  } catch {
    return null;
  }
  const mapkit = window.mapkit;
  if (!mapkit) return null;
  if (!initialised) {
    initialised = true;
    mapkit.init({
      authorizationCallback: (done: (t: string) => void) => {
        // Called again whenever the token nears expiry, so this asks the
        // server each time rather than replaying the first one.
        fetchToken()
          .then((t) => done(t ?? first))
          .catch(() => done(first));
      },
    });
  }
  return mapkit;
}

/**
 * A short address for a coordinate ("Al Rigga Rd, Deira"), from Apple's
 * reverse geocoder, or null. Used for the "Places visited" list.
 */
export async function placeName(lat: number, lon: number): Promise<string | null> {
  const mapkit = await ensureMapKit();
  if (!mapkit) return null;
  return new Promise((resolve) => {
    try {
      new mapkit.Geocoder({ getsUserLocation: false }).reverseLookup(
        new mapkit.Coordinate(lat, lon),
        (error: unknown, data: any) => {
          const place = !error && data?.results?.length ? data.results[0] : null;
          if (!place) return resolve(null);
          const parts = [place.name, place.subLocality ?? place.locality].filter(
            (part: unknown, i: number, all: unknown[]) => typeof part === "string" && part && all.indexOf(part) === i
          );
          resolve(parts.length ? parts.join(", ") : place.formattedAddress ?? null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/** Fetches a fresh developer token every time MapKit asks for one. */
async function fetchToken(): Promise<string | null> {
  const res = await fetch("/api/planning/mapkit-token");
  if (!res.ok) return null;
  const data = (await res.json()) as { configured?: boolean; token?: string };
  return data.configured && data.token ? data.token : null;
}

function currentColorScheme(mapkit: any): any {
  const attr = document.documentElement.getAttribute("data-theme");
  const dark =
    attr === "dark" ||
    (attr !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return dark ? mapkit.Map.ColorSchemes.Dark : mapkit.Map.ColorSchemes.Light;
}

export default function RouteMap({
  stops = [],
  origin,
  trail,
  finish,
  current,
  connectStops = true,
  ariaLabel,
  className = "",
}: {
  stops?: RouteMapStop[];
  origin?: RouteMapOrigin | null;
  /**
   * A road already driven (the "Route driven" card): stretches of recorded
   * points, drawn as they are — no directions are asked for, the device has
   * already said where it went. When given, `origin` is its first point and
   * `finish` its last.
   */
  trail?: { lat: number; lon: number }[][];
  finish?: RouteMapOrigin | null;
  /** Where the device is now: its own marker, always shown, never replayed. */
  current?: RouteMapOrigin | null;
  /**
   * False for pins that are not a journey (where every device is now): no
   * line between them and no directions asked for.
   */
  connectStops?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  // The place pins of a trail, by id, so an address arriving later renames
  // its pin without restarting the replay.
  const trailPinsRef = useRef<Map<string, any>>(new Map());
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  // 1. Credentials, script, map instance — once.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const mapkit = await ensureMapKit();
      if (cancelled) return;
      if (!mapkit) {
        setUnavailable(true);
        return;
      }
      if (!containerRef.current) return;

      mapRef.current = new mapkit.Map(containerRef.current, {
        colorScheme: currentColorScheme(mapkit),
        showsCompass: mapkit.FeatureVisibility.Adaptive,
        showsScale: mapkit.FeatureVisibility.Adaptive,
        showsZoomControl: true,
        isRotationEnabled: false,
      });
      setReady(true);
    })();

    return () => {
      cancelled = true;
      try {
        mapRef.current?.destroy?.();
      } catch {
        // Already gone.
      }
      mapRef.current = null;
    };
  }, []);

  // 2. Follow the app's light/dark setting, the way every other surface does.
  useEffect(() => {
    if (!ready) return;
    const apply = () => {
      const mapkit = window.mapkit;
      if (mapkit && mapRef.current) mapRef.current.colorScheme = currentColorScheme(mapkit);
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", apply);
      observer.disconnect();
    };
  }, [ready]);

  // 3. Pins and the route line. Redrawn whenever the stops or their order
  //    change — dragging a stop up the list moves its number on the map too.
  // Names too: a place's address arrives after its pin is drawn.
  const stopsKey = stops.map((s) => `${s.customerId}:${s.lat}:${s.lon}:${s.tone}:${s.glyph ?? ""}:${s.name}`).join("|");
  const originKey = origin ? `${origin.lat}:${origin.lon}` : "";
  const finishKey = finish ? `${finish.lat}:${finish.lon}` : "";
  const currentKey = current ? `${current.lat}:${current.lon}:${current.label}` : "";
  // A day's trail is fetched once per salesman and date; its length and both
  // ends are enough to tell one from another.
  // A trail is redrawn (and replayed) only when the trail or a pin's position
  // changes — not when a place's address arrives, which only renames a pin.
  const positionsKey = stops.map((s) => `${s.customerId}:${s.lat}:${s.lon}:${s.tone}:${s.color ?? ""}:${s.glyph ?? ""}`).join("|");
  const trailKey = trail
    ? `${trail.length}:${trail.reduce((n, s) => n + s.length, 0)}:${trail[0]?.[0]?.lat}:${trail.at(-1)?.at(-1)?.lon}`
    : "";

  useEffect(() => {
    if (!ready) return;
    const mapkit = window.mapkit;
    const map = mapRef.current;
    if (!mapkit || !map) return;

    let cancelled = false;
    const accent = token("--accent", "green");

    const coordinate = (lat: number, lon: number) => new mapkit.Coordinate(lat, lon);

    const annotations: any[] = [];
    if (origin) {
      annotations.push(
        new mapkit.MarkerAnnotation(coordinate(origin.lat, origin.lon), {
          color: accent,
          glyphText: "▶", // start of the run
          title: t("planning.mapStart"),
          subtitle: origin.label,
          accessibilityLabel: t("planning.mapStartLabel", { label: origin.label }),
        })
      );
    }
    if (finish) {
      annotations.push(
        new mapkit.MarkerAnnotation(coordinate(finish.lat, finish.lon), {
          color: token("--text-secondary", accent),
          glyphText: "■", // where the recording ended
          title: t("planning.drivenFinish"),
          subtitle: finish.label,
          accessibilityLabel: t("planning.drivenFinishLabel", { time: finish.label }),
        })
      );
    }
    stops.forEach((stop, i) => {
      annotations.push(
        new mapkit.MarkerAnnotation(coordinate(stop.lat, stop.lon), {
          color: token(stop.color ?? TONE_VARIABLE[stop.tone], accent),
          glyphText: stop.glyph ?? String(i + 1),
          title: stop.name,
          subtitle: stop.subtitle ?? "",
          accessibilityLabel: stop.accessibilityLabel ?? t("planning.mapStopLabel", { n: i + 1, name: stop.name }),
        })
      );
    });

    const path = [
      ...(origin ? [coordinate(origin.lat, origin.lon)] : []),
      ...stops.map((s) => coordinate(s.lat, s.lon)),
    ];

    const lineStyle = new mapkit.Style({ lineWidth: 3, lineJoin: "round", strokeColor: accent });

    if (trail || !connectStops) {
      // A driven route is drawn heavier, over a pale casing, so it reads
      // against busy streets (owner: "make sure it is clear and easy to see").
      const trailStyle = new mapkit.Style({ lineWidth: 5, lineJoin: "round", lineCap: "round", strokeColor: accent });
      const casingStyle = new mapkit.Style({
        lineWidth: 9,
        lineJoin: "round",
        lineCap: "round",
        strokeColor: token("--bg-surface", "white"),
        strokeOpacity: 0.85,
      });
      const segments = (trail ?? []).filter((segment) => segment.length >= 2);
      const casings = segments.map(
        (segment) => new mapkit.PolylineOverlay(segment.map((p) => coordinate(p.lat, p.lon)), { style: casingStyle })
      );
      const lines = segments.map(
        (segment) => new mapkit.PolylineOverlay(segment.map((p) => coordinate(p.lat, p.lon)), { style: trailStyle })
      );
      const currentPin = current
        ? new mapkit.MarkerAnnotation(coordinate(current.lat, current.lon), {
            color: token("--text-primary", "black"),
            glyphText: "●",
            title: t("planning.devicesNow"),
            subtitle: current.label,
            displayPriority: 1000,
            accessibilityLabel: t("planning.devicesNowLabel", { time: current.label }),
          })
        : null;
      const originPin = origin ? annotations[0] : null;
      const finishPin = finish ? annotations[origin ? 1 : 0] : null;
      const stopPins = annotations.slice(annotations.length - stops.length);
      trailPinsRef.current = new Map(stops.map((stop, i) => [stop.customerId, stopPins[i]]));
      const padding = new mapkit.Padding({ top: 48, right: 48, bottom: 48, left: 48 });

      map.removeAnnotations(map.annotations);
      map.removeOverlays(map.overlays);

      // The replay (owner, 2026-11-27): the day's line draws itself along the
      // road over REPLAY_MS, a dot leading it, each place appearing as the
      // dot reaches it. Not with reduced motion — the finished line, at once.
      const replay = !!trail && segments.length > 0 && !reducedMotion;
      if (!replay) {
        const all = currentPin ? [...annotations, currentPin] : annotations;
        if (all.length) map.addAnnotations(all);
        if (lines.length) map.addOverlays([...casings, ...lines]);
        if (all.length || lines.length) {
          map.showItems([...all, ...lines], { animate: !reducedMotion, padding });
        }
        return;
      }

      // Frame the whole day — and where the device is now — first, so the
      // camera holds still while it draws.
      map.addOverlays([...casings, ...lines]);
      if (currentPin) map.addAnnotation(currentPin);
      map.showItems(currentPin ? [currentPin, ...lines] : lines, { animate: true, padding });
      if (originPin) map.addAnnotation(originPin);

      const geometry = replayGeometry(segments);
      const reachAt = stops.map((stop) => distanceAlong(geometry, stop));
      const shown = new Set<number>();

      const dot = document.createElement("div");
      dot.style.cssText = `width:14px;height:14px;border-radius:9999px;background:${accent};border:3px solid ${token("--bg-surface", "white")};box-shadow:0 1px 3px rgb(0 0 0 / 0.3);`;
      const head = new mapkit.Annotation(coordinate(segments[0][0].lat, segments[0][0].lon), () => dot, {
        calloutEnabled: false,
        enabled: false,
        displayPriority: 1000,
      });
      map.addAnnotation(head);

      let frame = 0;
      const startedAt = performance.now();
      const draw = (now: number) => {
        if (cancelled || !mapRef.current) return;
        const progress = Math.min(1, (now - startedAt) / REPLAY_MS);
        const metres = replayEase(progress) * geometry.total;
        const { partial, head: at } = trailUpTo(geometry, metres);
        partial.forEach((points, i) => {
          const visible = points.length >= 2;
          lines[i].visible = visible;
          casings[i].visible = visible;
          if (visible) {
            const coords = points.map((p) => coordinate(p.lat, p.lon));
            lines[i].points = coords;
            casings[i].points = coords;
          }
        });
        if (at) head.coordinate = coordinate(at.lat, at.lon);
        reachAt.forEach((reach, i) => {
          if (reach <= metres && !shown.has(i)) {
            shown.add(i);
            map.addAnnotation(stopPins[i]);
          }
        });
        if (progress < 1) {
          frame = requestAnimationFrame(draw);
          return;
        }
        map.removeAnnotation(head);
        stopPins.forEach((pin, i) => {
          if (!shown.has(i)) map.addAnnotation(pin);
        });
        if (finishPin) map.addAnnotation(finishPin);
      };
      frame = requestAnimationFrame(draw);

      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    // Drawn straight away so there is always a line between the pins; the
    // real road geometry replaces it below once Apple has worked it out.
    const straight =
      path.length >= 2 ? [new mapkit.PolylineOverlay(path, { style: lineStyle })] : [];

    map.removeAnnotations(map.annotations);
    map.removeOverlays(map.overlays);
    if (annotations.length) map.addAnnotations(annotations);
    if (straight.length) map.addOverlays(straight);
    if (annotations.length) {
      map.showItems([...annotations, ...straight], {
        animate: !reducedMotion,
        padding: new mapkit.Padding({ top: 48, right: 48, bottom: 48, left: 48 }),
      });
    }

    // Road geometry, leg by leg — the same thing MKDirections draws on the
    // phone. Each leg falls back to its straight segment on its own, so a
    // single unroutable pair does not cost the whole line.
    if (path.length >= 2) {
      const directions = new mapkit.Directions();
      const legs = path.slice(0, -1).map(
        (from: any, i: number) =>
          new Promise<any>((resolve) => {
            directions.route(
              {
                origin: from,
                destination: path[i + 1],
                transportType: mapkit.Directions.Transport.Automobile,
              },
              (error: unknown, data: any) => {
                const route = !error && data?.routes?.length ? data.routes[0] : null;
                resolve(route?.polyline ?? null);
              }
            );
          })
      );

      Promise.all(legs).then((polylines) => {
        if (cancelled || !mapRef.current) return;
        if (!polylines.some(Boolean)) return;
        const drawn = polylines.map((polyline, i) => {
          if (polyline) {
            polyline.style = lineStyle;
            return polyline;
          }
          return new mapkit.PolylineOverlay([path[i], path[i + 1]], { style: lineStyle });
        });
        map.removeOverlays(straight);
        map.addOverlays(drawn);
      });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, trail ? positionsKey : stopsKey, originKey, finishKey, currentKey, trailKey, connectStops, reducedMotion]);

  // A trail's place pins take their names as the addresses arrive, without
  // redrawing — a redraw would restart the replay.
  useEffect(() => {
    if (!trail) return;
    stops.forEach((stop, i) => {
      const pin = trailPinsRef.current.get(stop.customerId);
      if (!pin) return;
      pin.title = stop.name;
      pin.subtitle = stop.subtitle ?? "";
      pin.accessibilityLabel = stop.accessibilityLabel ?? t("planning.mapStopLabel", { n: i + 1, name: stop.name });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopsKey]);

  // Nothing at all rather than an empty card: with no Apple Maps credentials
  // the page must look exactly the way it looked before there was a map.
  if (unavailable) return null;

  return (
    <Card className={`p-2 mb-5 ${className}`}>
      <div
        ref={containerRef}
        className="w-full h-[320px] md:h-[420px] rounded-inner overflow-hidden bg-canvas"
        role="region"
        aria-label={ariaLabel ?? t("planning.mapAriaLabel", { n: stops.length })}
      />
    </Card>
  );
}
