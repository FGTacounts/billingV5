"use client";

import { useEffect, useMemo, useState } from "react";
import { Smartphone, Tablet, Laptop, MapPin, Route, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { EmptyState, Skeleton } from "@/components/ui/Empty";
import {
  STAY_BANDS,
  findStops,
  nearestFiveMinutes,
  roundToFive,
  splitTrail,
  stayBand,
  trailDistanceMetres,
  type Stop,
  type TrailPoint,
} from "@/lib/routeTrail";
import RouteMap, { placeName, type RouteMapStop } from "./RouteMap";

// Devices — where every iPhone, iPad and Mac with the app is, and where each
// one went on a given day (owner, 2026-11-27: "i should be able to check
// where the device is. and which all locations the user/device has been to …
// give the data only to the admin"), on ONE map ("make it one map instead of
// two. It shows the current location of the device + the route"):
//
//   - nobody picked: every device where it is now;
//   - a device picked: where it is now, its route for the day (replayed),
//     and every place it stayed 20 minutes or more, coloured by how long
//     ("green for 20mins, blue for 30+ … 45mins, 1hr, 2hr, 3hr"), times and
//     lengths rounded to 5 minutes.
//
// The app writes it (RouteTracker.swift, RUN-ME-46/48); admins read it here.
// The phone and the Mac show the same in DeviceTrackingSheet.swift. Until
// RUN-ME-48 has been run /api/planning/devices answers `available: false`
// and this renders nothing.

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

const BAND_LABEL: Record<string, string> = {
  "--stay-20": t("planning.stayBand20"),
  "--stay-30": t("planning.stayBand30"),
  "--stay-45": t("planning.stayBand45"),
  "--stay-60": t("planning.stayBand60"),
  "--stay-120": t("planning.stayBand120"),
  "--stay-180": t("planning.stayBand180"),
};

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

/** "~35 min", "~1 hr 5 min", "~2 hr" — rounded to the nearest 5 minutes. */
function stayLength(minutes: number): string {
  const rounded = roundToFive(minutes);
  const text =
    rounded < 60
      ? t("planning.minutesShort", { n: rounded })
      : rounded % 60 === 0
        ? t("planning.hoursShort", { h: rounded / 60 })
        : t("planning.hoursMinutes", { h: Math.floor(rounded / 60), m: rounded % 60 });
  return t("planning.stayAbout", { duration: text });
}

function stayTimes(stop: Stop): { from: string; to: string } {
  return {
    from: timeFormat.format(nearestFiveMinutes(stop.from)),
    to: timeFormat.format(nearestFiveMinutes(stop.to)),
  };
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

function Swatch({ token }: { token: string }) {
  return <span className="w-3 h-3 rounded-full shrink-0" style={{ background: `var(${token})` }} aria-hidden />;
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
  const stays = useMemo<Stop[]>(() => (points ? findStops(points) : []), [points]);

  // An address for each stay, one lookup at a time (Apple rate-limits the
  // geocoder), remembered for the visit.
  const staysKey = stays.map((s) => `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`).join("|");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const stay of stays.slice(0, 40)) {
        const key = `${stay.lat.toFixed(4)},${stay.lon.toFixed(4)}`;
        if (key in placeNames) continue;
        const name = await placeName(stay.lat, stay.lon);
        if (cancelled) return;
        setPlaceNames((current) => ({ ...current, [key]: name }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staysKey]);

  if (available === false) return null;

  const selected = devices?.find((d) => d.deviceId === selectedId) ?? null;
  const bounds = dayBounds(day);
  const dateLabel = bounds ? dateFormat.format(bounds.from) : day;
  const first = points?.[0];
  const last = points?.[points.length - 1];
  const fromLabel = first ? timeFormat.format(new Date(first.t)) : "";
  const toLabel = last ? timeFormat.format(new Date(last.t)) : "";

  const placeLabel = (stay: Stop): string | null => {
    const key = `${stay.lat.toFixed(4)},${stay.lon.toFixed(4)}`;
    if (!(key in placeNames)) return null;
    return placeNames[key] ?? t("planning.placesUnknown", { lat: stay.lat.toFixed(4), lon: stay.lon.toFixed(4) });
  };

  // ---- What the one map shows -------------------------------------------
  let mapProps: React.ComponentProps<typeof RouteMap> | null = null;
  if (!selected) {
    const pins: RouteMapStop[] = (devices ?? [])
      .filter((d) => d.lat != null && d.lon != null)
      .map((d) => ({
        customerId: d.deviceId,
        name: personOf(d),
        subtitle: `${d.platform ?? ""} · ${d.lastFixAt ? dateTimeFormat.format(new Date(d.lastFixAt)) : ""}`,
        lat: d.lat!,
        lon: d.lon!,
        tone: "neutral",
        glyph: (personOf(d).trim()[0] ?? "?").toUpperCase(),
        accessibilityLabel: `${personOf(d)}, ${deviceLabel(d)}`,
      }));
    if (pins.length) {
      mapProps = {
        stops: pins,
        connectStops: false,
        ariaLabel: t("planning.devicesMapAriaLabel", { n: pins.length }),
      };
    }
  } else {
    const current =
      selected.lat != null && selected.lon != null
        ? {
            lat: selected.lat,
            lon: selected.lon,
            label: selected.lastFixAt ? dateTimeFormat.format(new Date(selected.lastFixAt)) : "",
          }
        : null;
    const stayPins: RouteMapStop[] = stays.map((stay, i) => {
      const times = stayTimes(stay);
      const place = placeLabel(stay);
      return {
        customerId: `stay-${i}`,
        name: stayLength(stay.minutes),
        subtitle: [t("planning.stayPinSubtitle", times), place].filter(Boolean).join(" · "),
        lat: stay.lat,
        lon: stay.lon,
        tone: "accent",
        color: stayBand(stay.minutes).token,
        accessibilityLabel: t("planning.placePinLabel", {
          n: i + 1,
          duration: stayLength(stay.minutes),
          place: place ?? "",
          ...times,
        }),
      };
    });
    const hasRoute = !loadingDay && !dayError && points && points.length > 0;
    if (hasRoute || current) {
      mapProps = {
        trail: hasRoute ? segments : [],
        stops: hasRoute ? stayPins : [],
        origin: hasRoute && first ? { label: fromLabel, lat: first.lat, lon: first.lon } : null,
        current,
        ariaLabel: hasRoute
          ? t("planning.drivenMapAriaLabel", {
              name: personOf(selected),
              date: dateLabel,
              distance: distanceText(metres),
              from: fromLabel,
              to: toLabel,
            })
          : t("planning.devicesNowLabel", { time: current?.label ?? "" }),
      };
    }
  }

  const bandsUsed = new Set(stays.map((s) => stayBand(s.minutes).token));

  return (
    <Card className="p-4 mb-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <h2 className="text-headline font-semibold truncate">
            {selected ? `${personOf(selected)} · ${t("planning.drivenTitle", { date: dateLabel })}` : t("planning.devicesTitle")}
          </h2>
          <p className="text-caption text-secondary truncate">
            {selected ? deviceLabel(selected) : t("planning.devicesHint")}
          </p>
        </div>
        {selected && (
          <div className="flex items-end gap-2">
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
            <Button tier="plain" onClick={() => setSelectedId(null)} className="flex items-center gap-1.5 min-h-[44px]">
              <X size={14} aria-hidden /> {t("planning.devicesAll")}
            </Button>
          </div>
        )}
      </div>

      {devicesError ? (
        <p className="text-caption text-[--status-danger]">{devicesError}</p>
      ) : devices == null ? (
        <div className="space-y-2">
          <Skeleton className="h-[360px] md:h-[480px] w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" style={{ animationDelay: "90ms" }} />
        </div>
      ) : devices.length === 0 ? (
        <EmptyState icon={Smartphone} title={t("planning.devicesNone")} />
      ) : (
        <>
          {/* The one map. */}
          <div aria-live="polite">
            {selected && loadingDay ? (
              <Skeleton className="h-[360px] md:h-[480px] w-full mb-3" />
            ) : mapProps ? (
              <RouteMap className="!mb-3 !p-0 !shadow-none [&>div]:!h-[360px] md:[&>div]:!h-[480px]" {...mapProps} />
            ) : null}
          </div>

          {selected && (
            <div className="mb-4" aria-live="polite">
              {dayError ? (
                <p className="text-caption text-[--status-danger]">{dayError}</p>
              ) : loadingDay ? (
                <Skeleton className="h-4 w-56" />
              ) : !points || points.length === 0 ? (
                <EmptyState
                  icon={Route}
                  title={`${t("planning.drivenNothing", { date: dateLabel })} ${t("planning.drivenNothingHint")}`}
                />
              ) : (
                <>
                  <p className="text-subhead font-medium tabular-nums">
                    {t("planning.drivenSummary", {
                      distance: distanceText(metres),
                      from: fromLabel,
                      to: toLabel,
                      points: points.length,
                    })}
                  </p>
                  {segments.length > 1 && <p className="text-caption text-secondary">{t("planning.drivenGaps")}</p>}

                  {/* What the colours mean. Every band is listed; the ones
                      on today's map are full strength. */}
                  <div className="mt-3" role="group" aria-label={t("planning.stayLegend")}>
                    <div className="text-caption text-secondary font-semibold mb-1">{t("planning.stayLegend")}</div>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {STAY_BANDS.map((band) => (
                        <li
                          key={band.token}
                          className={`flex items-center gap-1.5 text-caption tabular-nums ${bandsUsed.has(band.token) ? "" : "opacity-40"}`}
                        >
                          <Swatch token={band.token} />
                          {BAND_LABEL[band.token]}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <h3 className="text-subhead font-semibold mt-4 mb-1">{t("planning.placesTitle")}</h3>
                  {stays.length === 0 ? (
                    <p className="text-caption text-secondary">{t("planning.placesNone")}</p>
                  ) : (
                    <ol className="divide-y divide-hairline">
                      {stays.map((stay, i) => {
                        const band = stayBand(stay.minutes);
                        const times = stayTimes(stay);
                        return (
                          <li key={`${stay.from}-${i}`} className="flex items-start gap-3 py-2">
                            <span
                              className="w-7 h-7 rounded-full text-caption font-semibold grid place-items-center shrink-0 tabular-nums text-white"
                              style={{ background: `var(${band.token})` }}
                            >
                              {i + 1}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-subhead truncate">
                                {placeLabel(stay) ?? <span className="text-secondary">{t("planning.placesLooking")}</span>}
                              </span>
                              <span className="block text-caption text-secondary tabular-nums">
                                {t("planning.placesStay", times)}
                              </span>
                            </span>
                            <span className="text-subhead font-semibold tabular-nums shrink-0">
                              {stayLength(stay.minutes)}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </>
              )}
            </div>
          )}

          {!selected && <p className="text-caption text-secondary mb-2">{t("planning.devicesPick")}</p>}

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
  );
}
