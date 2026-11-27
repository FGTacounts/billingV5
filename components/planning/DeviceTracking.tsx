"use client";

import { useEffect, useMemo, useState } from "react";
import { Smartphone, Tablet, Laptop, MapPin, Route } from "lucide-react";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/Card";
import { TextInput } from "@/components/ui/Field";
import { EmptyState, Skeleton } from "@/components/ui/Empty";
import { findStops, splitTrail, trailDistanceMetres, type Stop, type TrailPoint } from "@/lib/routeTrail";
import RouteMap, { placeName, type RouteMapStop } from "./RouteMap";

// Devices — where every iPhone, iPad and Mac with the app is, and where each
// one went on a given day (owner, 2026-11-27: "i should be able to check
// where the device is. and which all locations the user/device has been to …
// give the data only to the admin and not the manager … for all devices/user
// types"). The app writes it (RouteTracker.swift, RUN-ME-46/48); admins read
// it here. The phone and the Mac show the same in DeviceTrackingSheet.swift.
//
// Until RUN-ME-48 has been run /api/planning/devices answers
// `available: false` and this renders nothing.

interface Device {
  deviceId: string;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  platform: string | null;
  model: string | null;
  name: string | null;
  appVersion: string | null;
  lastSeenAt: string;
  lastFixAt: string | null;
  lat: number | null;
  lon: number | null;
  acc: number | null;
}

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The browser's own midnight-to-midnight for a yyyy-mm-dd. */
function dayBounds(value: string): { from: Date; to: Date } | null {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return { from: new Date(y, m - 1, d), to: new Date(y, m - 1, d + 1) };
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
}

function distanceText(metres: number): string {
  return metres < 1000
    ? t("planning.distanceMetres", { n: metres })
    : t("planning.distanceKm", { n: (metres / 1000).toFixed(1) });
}

function durationText(minutes: number): string {
  return minutes < 60
    ? t("planning.minutesShort", { n: minutes })
    : t("planning.hoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

function personOf(d: Device): string {
  return d.userName ?? t("planning.devicesUnknownPerson");
}

function deviceLabel(d: Device): string {
  return [d.platform, d.name && d.name !== d.platform ? d.name : null, d.model].filter(Boolean).join(" · ");
}

function DeviceIcon({ platform }: { platform: string | null }) {
  const Icon = platform === "iPad" ? Tablet : platform === "Mac" ? Laptop : Smartphone;
  return <Icon size={16} className="text-secondary shrink-0" aria-hidden />;
}

export default function DeviceTracking() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [day, setDay] = useState(todayInput);
  const [points, setPoints] = useState<TrailPoint[] | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [dayError, setDayError] = useState<string | null>(null);
  const [placeNames, setPlaceNames] = useState<Record<string, string | null>>({});

  // The device list, once per visit to the page. No polling (egress, Nov
  // 2026): opening the page again is the refresh.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/planning/devices")
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error || t("planning.devicesCouldntLoad"));
        return data as { available: boolean; devices: Device[] };
      })
      .then((data) => {
        if (cancelled) return;
        setAvailable(data.available);
        setDevices(data.devices ?? []);
      })
      .catch((e) => {
        if (!cancelled) setDevicesError(e instanceof Error ? e.message : t("planning.devicesCouldntLoad"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The chosen device's day.
  useEffect(() => {
    const bounds = dayBounds(day);
    if (!selectedId || !bounds) {
      setPoints(null);
      return;
    }
    let cancelled = false;
    setLoadingDay(true);
    setDayError(null);
    const query = new URLSearchParams({
      deviceId: selectedId,
      from: bounds.from.toISOString(),
      to: bounds.to.toISOString(),
    });
    fetch(`/api/planning/track?${query}`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error || t("planning.trackCouldntLoad"));
        return data as { available: boolean; points: TrailPoint[] };
      })
      .then((data) => {
        if (!cancelled) setPoints(data.points ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setDayError(e instanceof Error ? e.message : t("planning.trackCouldntLoad"));
        setPoints(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDay(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, day]);

  const segments = useMemo(() => (points ? splitTrail(points) : []), [points]);
  const metres = useMemo(() => trailDistanceMetres(segments), [segments]);
  const stops = useMemo<Stop[]>(() => (points ? findStops(points) : []), [points]);

  // An address for each place, one lookup at a time (Apple rate-limits the
  // geocoder), remembered for the visit.
  const stopsKey = stops.map((s) => `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`).join("|");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const stop of stops.slice(0, 40)) {
        const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
        if (key in placeNames) continue;
        const name = await placeName(stop.lat, stop.lon);
        if (cancelled) return;
        setPlaceNames((current) => ({ ...current, [key]: name }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopsKey]);

  if (available === false) return null;

  const selected = devices?.find((d) => d.deviceId === selectedId) ?? null;
  const placed = (devices ?? []).filter((d) => d.lat != null && d.lon != null);
  const devicePins: RouteMapStop[] = placed.map((d) => ({
    customerId: d.deviceId,
    name: personOf(d),
    subtitle: `${d.platform ?? ""} · ${d.lastFixAt ? dateTimeFormat.format(new Date(d.lastFixAt)) : ""}`,
    lat: d.lat!,
    lon: d.lon!,
    tone: d.deviceId === selectedId ? "accent" : "neutral",
    glyph: (personOf(d).trim()[0] ?? "?").toUpperCase(),
    accessibilityLabel: `${personOf(d)}, ${deviceLabel(d)}`,
  }));

  const bounds = dayBounds(day);
  const dateLabel = bounds ? dateFormat.format(bounds.from) : day;
  const first = points?.[0];
  const last = points?.[points.length - 1];
  const fromLabel = first ? timeFormat.format(new Date(first.t)) : "";
  const toLabel = last ? timeFormat.format(new Date(last.t)) : "";

  const placeLabel = (stop: Stop): string | null => {
    const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
    return key in placeNames ? placeNames[key] ?? t("planning.placesUnknown", { lat: stop.lat.toFixed(4), lon: stop.lon.toFixed(4) }) : null;
  };
  const placePins: RouteMapStop[] = stops.map((stop, i) => ({
    customerId: `place-${i}`,
    name: placeLabel(stop) ?? t("planning.placesLooking"),
    subtitle: `${timeFormat.format(new Date(stop.from))} – ${timeFormat.format(new Date(stop.to))}`,
    lat: stop.lat,
    lon: stop.lon,
    tone: "accent",
    accessibilityLabel: t("planning.placePinLabel", {
      n: i + 1,
      place: placeLabel(stop) ?? "",
      from: timeFormat.format(new Date(stop.from)),
      to: timeFormat.format(new Date(stop.to)),
    }),
  }));

  return (
    <>
      <Card className="p-4 mb-5">
        <h2 className="text-headline font-semibold">{t("planning.devicesTitle")}</h2>
        <p className="text-caption text-secondary mb-3">{t("planning.devicesHint")}</p>

        {devicesError ? (
          <p className="text-caption text-[--status-danger]">{devicesError}</p>
        ) : devices == null ? (
          <div className="space-y-2">
            <Skeleton className="h-[320px] w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" style={{ animationDelay: "90ms" }} />
          </div>
        ) : devices.length === 0 ? (
          <EmptyState icon={Smartphone} title={t("planning.devicesNone")} />
        ) : (
          <>
            {devicePins.length > 0 && (
              <RouteMap
                className="!mb-3 !p-0 !shadow-none"
                stops={devicePins}
                connectStops={false}
                ariaLabel={t("planning.devicesMapAriaLabel", { n: devicePins.length })}
              />
            )}
            <ul className="divide-y divide-hairline">
              {devices.map((d) => {
                const isSelected = d.deviceId === selectedId;
                return (
                  <li key={d.deviceId}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(isSelected ? null : d.deviceId)}
                      aria-pressed={isSelected}
                      aria-label={t("planning.devicesShowDay", { name: personOf(d) })}
                      className={`w-full min-h-[44px] text-start px-2 py-2.5 grid gap-1 sm:grid-cols-[1.2fr_1.4fr_1fr_1fr] sm:items-center rounded-inner transition-colors duration-150 ease-out ${
                        isSelected ? "bg-accent/10" : "hover:bg-primary/[0.04]"
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <DeviceIcon platform={d.platform} />
                        <span className="text-subhead font-semibold truncate">{personOf(d)}</span>
                        {d.userRole && <span className="text-caption text-secondary capitalize">{d.userRole}</span>}
                      </span>
                      <span className="text-caption text-secondary truncate">{deviceLabel(d)}</span>
                      <span className="text-caption tabular-nums">
                        {d.lastFixAt ? (
                          <>
                            <MapPin size={12} className="inline -mt-0.5 me-1 text-secondary" aria-hidden />
                            {dateTimeFormat.format(new Date(d.lastFixAt))}
                          </>
                        ) : (
                          <span className="text-secondary">{t("planning.devicesNoPosition")}</span>
                        )}
                      </span>
                      <span className="text-caption text-secondary tabular-nums">{ago(d.lastSeenAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      {selected && (
        <Card className="p-4 mb-5">
          <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
            <div className="min-w-0">
              <h2 className="text-headline font-semibold truncate">
                {personOf(selected)} · {t("planning.drivenTitle", { date: dateLabel })}
              </h2>
              <p className="text-caption text-secondary truncate">{deviceLabel(selected)}</p>
            </div>
            <div>
              <label htmlFor="device-day" className="text-caption text-secondary font-semibold block">
                {t("planning.drivenDate")}
              </label>
              <TextInput
                id="device-day"
                type="date"
                value={day}
                max={todayInput()}
                onChange={(e) => setDay(e.target.value)}
                className="mt-1 tabular-nums"
              />
            </div>
          </div>

          <div aria-live="polite">
            {loadingDay ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-[320px] md:h-[420px] w-full" />
              </div>
            ) : dayError ? (
              <p className="text-caption text-[--status-danger]">{dayError}</p>
            ) : !points || points.length === 0 ? (
              <EmptyState
                icon={Route}
                title={`${t("planning.drivenNothing", { date: dateLabel })} ${t("planning.drivenNothingHint")}`}
              />
            ) : (
              <>
                <p className="text-subhead font-medium tabular-nums mb-2">
                  {t("planning.drivenSummary", {
                    distance: distanceText(metres),
                    from: fromLabel,
                    to: toLabel,
                    points: points.length,
                  })}
                </p>
                <RouteMap
                  className="!mb-0 !p-0 !shadow-none"
                  trail={segments}
                  stops={placePins}
                  origin={first ? { label: fromLabel, lat: first.lat, lon: first.lon } : null}
                  finish={last && points.length > 1 ? { label: toLabel, lat: last.lat, lon: last.lon } : null}
                  ariaLabel={t("planning.drivenMapAriaLabel", {
                    name: personOf(selected),
                    date: dateLabel,
                    distance: distanceText(metres),
                    from: fromLabel,
                    to: toLabel,
                  })}
                />
                {segments.length > 1 && <p className="text-caption text-secondary mt-2">{t("planning.drivenGaps")}</p>}

                <h3 className="text-subhead font-semibold mt-4 mb-1">{t("planning.placesTitle")}</h3>
                {stops.length === 0 ? (
                  <p className="text-caption text-secondary">{t("planning.placesNone")}</p>
                ) : (
                  <ol className="divide-y divide-hairline">
                    {stops.map((stop, i) => (
                      <li key={`${stop.from}-${i}`} className="flex items-start gap-3 py-2">
                        <span className="w-6 h-6 rounded-full bg-accent/12 text-accent text-caption font-semibold grid place-items-center shrink-0 tabular-nums">
                          {i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-subhead truncate">
                            {placeLabel(stop) ?? <span className="text-secondary">{t("planning.placesLooking")}</span>}
                          </span>
                          <span className="block text-caption text-secondary tabular-nums">
                            {t("planning.placesStay", {
                              from: timeFormat.format(new Date(stop.from)),
                              to: timeFormat.format(new Date(stop.to)),
                              duration: durationText(stop.minutes),
                            })}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
