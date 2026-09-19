"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/motion";
import { Card } from "@/components/ui/Card";
import { t } from "@/lib/i18n";

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
  stops,
  origin,
  className = "",
}: {
  stops: RouteMapStop[];
  origin?: RouteMapOrigin | null;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  // 1. Credentials, script, map instance — once.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const first = await fetchToken().catch(() => null);
      if (cancelled) return;
      if (!first) {
        setUnavailable(true);
        return;
      }

      try {
        await loadMapKitScript();
      } catch {
        if (!cancelled) setUnavailable(true);
        return;
      }
      if (cancelled) return;

      const mapkit = window.mapkit;
      if (!mapkit || !containerRef.current) return;

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
  const stopsKey = stops.map((s) => `${s.customerId}:${s.lat}:${s.lon}:${s.tone}`).join("|");
  const originKey = origin ? `${origin.lat}:${origin.lon}` : "";

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
    stops.forEach((stop, i) => {
      annotations.push(
        new mapkit.MarkerAnnotation(coordinate(stop.lat, stop.lon), {
          color: token(TONE_VARIABLE[stop.tone], accent),
          glyphText: String(i + 1),
          title: stop.name,
          subtitle: stop.subtitle ?? "",
          accessibilityLabel: t("planning.mapStopLabel", { n: i + 1, name: stop.name }),
        })
      );
    });

    const path = [
      ...(origin ? [coordinate(origin.lat, origin.lon)] : []),
      ...stops.map((s) => coordinate(s.lat, s.lon)),
    ];

    const lineStyle = new mapkit.Style({ lineWidth: 3, lineJoin: "round", strokeColor: accent });
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
  }, [ready, stopsKey, originKey, reducedMotion]);

  // Nothing at all rather than an empty card: with no Apple Maps credentials
  // the page must look exactly the way it looked before there was a map.
  if (unavailable) return null;

  return (
    <Card className={`p-2 mb-5 ${className}`}>
      <div
        ref={containerRef}
        className="w-full h-[320px] md:h-[420px] rounded-inner overflow-hidden bg-canvas"
        role="region"
        aria-label={t("planning.mapAriaLabel", { n: stops.length })}
      />
    </Card>
  );
}
