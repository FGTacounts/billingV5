"use client";

import { useEffect, useMemo, useState } from "react";
import { Route } from "lucide-react";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/Card";
import { TextInput } from "@/components/ui/Field";
import { EmptyState, Skeleton } from "@/components/ui/Empty";
import { splitTrail, trailDistanceMetres, type TrailPoint } from "@/lib/routeTrail";
import RouteMap from "./RouteMap";

// "Route driven" — the road a salesman's iPhone or iPad recorded on one day
// (owner, 2026-11-27: "track where the salesmen go … the route path should be
// logged each day"). The phone writes it (RouteTracker.swift, RUN-ME-46); a
// manager picks the salesman and the date here and sees the line on the map.
// The phone and the Mac show the same thing in DrivenRouteSheet.swift.
//
// Until RUN-ME-46 has been run the endpoint answers `available: false` and
// this renders nothing, so the page is the page it was.

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The browser's own midnight-to-midnight for a yyyy-mm-dd. */
function dayBounds(value: string): { from: Date; to: Date } | null {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d + 1);
  return { from, to };
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

function distanceText(metres: number): string {
  return metres < 1000
    ? t("planning.distanceMetres", { n: metres })
    : t("planning.distanceKm", { n: (metres / 1000).toFixed(1) });
}

export default function DrivenRoute({ salesmen }: { salesmen: { id: string; full_name: string }[] }) {
  const [salesmanId, setSalesmanId] = useState("");
  const [day, setDay] = useState(todayInput);
  const [points, setPoints] = useState<TrailPoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bounds = dayBounds(day);
    if (!salesmanId || !bounds) {
      setPoints(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      salesmanId,
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
        if (cancelled) return;
        setAvailable(data.available);
        setPoints(data.points ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t("planning.trackCouldntLoad"));
        setPoints(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [salesmanId, day]);

  const segments = useMemo(() => (points ? splitTrail(points) : []), [points]);
  const metres = useMemo(() => trailDistanceMetres(segments), [segments]);

  // RUN-ME-46 not run yet: nothing at all.
  if (available === false) return null;

  const salesmanName = salesmen.find((s) => s.id === salesmanId)?.full_name ?? "";
  const bounds = dayBounds(day);
  const dateLabel = bounds ? dateFormat.format(bounds.from) : day;
  const first = points?.[0];
  const last = points?.[points.length - 1];
  const fromLabel = first ? timeFormat.format(new Date(first.t)) : "";
  const toLabel = last ? timeFormat.format(new Date(last.t)) : "";
  const hasGaps = segments.length > 1;

  return (
    <Card className="p-4 mb-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-headline font-semibold">{t("planning.drivenTitle")}</h2>
          <p className="text-caption text-secondary">{t("planning.drivenHint")}</p>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <div>
          <label htmlFor="driven-salesman" className="text-caption text-secondary font-semibold">
            {t("nav.role.salesman")}
          </label>
          <select
            id="driven-salesman"
            className="w-full mt-1 px-3 py-2 rounded-card border border-hairline bg-surface text-subhead"
            value={salesmanId}
            onChange={(e) => setSalesmanId(e.target.value)}
          >
            <option value="">{t("planning.drivenPickSalesman")}</option>
            {salesmen.map((s) => (
              <option key={s.id} value={s.id}>{s.full_name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="driven-date" className="text-caption text-secondary font-semibold">
            {t("planning.drivenDate")}
          </label>
          <TextInput
            id="driven-date"
            type="date"
            value={day}
            max={todayInput()}
            onChange={(e) => setDay(e.target.value)}
            className="mt-1 tabular-nums"
          />
        </div>
      </div>

      <div className="mt-4" aria-live="polite">
        {!salesmanId ? (
          <p className="text-caption text-secondary">{t("planning.drivenPickSalesmanHint")}</p>
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-[320px] md:h-[420px] w-full" />
          </div>
        ) : error ? (
          <p className="text-caption text-[--status-danger]">{error}</p>
        ) : !points || points.length === 0 ? (
          <EmptyState
            icon={Route}
            title={`${t("planning.drivenNothing", { name: salesmanName, date: dateLabel })} ${t("planning.drivenNothingHint")}`}
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
              className="!mb-0"
              trail={segments}
              origin={first ? { label: fromLabel, lat: first.lat, lon: first.lon } : null}
              finish={last && points.length > 1 ? { label: toLabel, lat: last.lat, lon: last.lon } : null}
              ariaLabel={t("planning.drivenMapAriaLabel", {
                name: salesmanName,
                date: dateLabel,
                distance: distanceText(metres),
                from: fromLabel,
                to: toLabel,
              })}
            />
            {hasGaps && <p className="text-caption text-secondary mt-2">{t("planning.drivenGaps")}</p>}
          </>
        )}
      </div>
    </Card>
  );
}
