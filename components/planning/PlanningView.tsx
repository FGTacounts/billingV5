"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { MapPin, Search, Clock, Play, Square, GripVertical, ChevronUp, ChevronDown } from "lucide-react";
import { motion } from "framer-motion";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchRoutePriorities, type RouteStop, type PriorityTier } from "@/lib/queries/planning";
import type { AppUser } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import { springLayout, respectMotion, usePrefersReducedMotion } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { Pill } from "@/components/ui/Badge";
import { TextInput } from "@/components/ui/Field";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import RouteMap, { type RouteMapStop, type RouteMapOrigin } from "./RouteMap";

const TIER_TONE: Record<PriorityTier, "danger" | "accent" | "warning" | "neutral"> = {
  overdue: "danger",
  due: "warning",
  excellentIdle: "accent",
  idle: "warning",
  normal: "neutral",
};

interface RouteLeg {
  distanceText: string;
  durationText: string;
  startAddress: string;
  endAddress: string;
}

/** Where a stop sits on the map, once /api/planning/directions has placed it. */
interface StopCoordinate {
  lat: number;
  lon: number;
  label: string;
}

/** A visit as the server holds it. `id` is null while an optimistic one is in flight. */
interface Visit {
  id: string | null;
  customerId: string;
  customerName: string | null;
  arrivedAt: string;
  departedAt: string | null;
}

// Today's route, as somebody arranged it by hand, kept on this device so a
// reload or a trip to another screen does not throw the morning's plan away.
// Keyed by the day and by whose route it is; yesterday's is simply never read
// again. Browser storage on purpose: it is one person's working order for one
// day, not a record anybody else needs.
function routeKey(salesmanId: string): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `planning.route.${day}.${salesmanId || "all"}`;
}
function readSavedRoute(salesmanId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(routeKey(salesmanId));
    const ids = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(ids) && ids.length ? (ids as string[]) : null;
  } catch {
    return null;
  }
}
function writeSavedRoute(salesmanId: string, ids: string[] | null) {
  try {
    if (ids) window.localStorage.setItem(routeKey(salesmanId), JSON.stringify(ids));
    else window.localStorage.removeItem(routeKey(salesmanId));
  } catch {
    // Private window or blocked storage: the order still holds for this visit.
  }
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function minutesBetween(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
}

// Route optimization (§Next Updates Planning: "salesman enters a city and
// gets the best route... prioritizing overdue-payment customers, excellent
// customers idle 1+ months, customers idle 2-3+ months; salesman logs time
// at stop; manager can see every salesman's route"). Only reachable when a
// Manager/Admin has configured a maps key — see app/(app)/layout.tsx and
// app/(app)/planning/page.tsx for the hide/redirect gates.
export default function PlanningView({ user }: { user: AppUser }) {
  const isManager = user.role === "manager" || user.role === "admin";
  const [salesmen, setSalesmen] = useState<{ id: string; full_name: string }[]>([]);
  const [selectedSalesman, setSelectedSalesman] = useState(isManager ? "" : user.id);
  const [city, setCity] = useState("");
  const [loading, setLoading] = useState(false);
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [origin, setOrigin] = useState("");
  const [routing, setRouting] = useState(false);
  const [routeLegs, setRouteLegs] = useState<RouteLeg[] | null>(null);
  const [routeOrder, setRouteOrder] = useState<number[] | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  // Where each stop is, and where the run starts from — filled in by the same
  // geocoding the route ordering already does, so the map costs no extra
  // lookups.
  const [stopCoords, setStopCoords] = useState<Record<string, StopCoordinate>>({});
  const [originPlace, setOriginPlace] = useState<RouteMapOrigin | null>(null);
  // The order the salesman has put the stops in by hand, as customer ids
  // (parity with the phone's `moveStop`). Null until they touch it, so the
  // generated order is what shows until then.
  const [handOrder, setHandOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const [visits, setVisits] = useState<Visit[]>([]);
  // null while we are still asking; false when RUN-ME-21-visit-log.sql has
  // not been run yet, in which case the timer stays session-only exactly as
  // it was before.
  const [visitsSaved, setVisitsSaved] = useState<boolean | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isManager) return;
    supabaseBrowser()
      .from("users")
      .select("id, full_name")
      .eq("role", "salesman")
      .then(({ data }) => setSalesmen(data ?? []));
  }, [isManager]);

  // Today's visits, so a reload does not lose the morning. The day boundary
  // is the browser's midnight — the server has no idea what day it is where
  // the salesman is standing.
  useEffect(() => {
    if (isManager) return;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    let cancelled = false;
    fetch(`/api/planning/visits?since=${encodeURIComponent(midnight.toISOString())}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { available?: boolean; visits?: Visit[] } | null) => {
        if (cancelled || !data) return;
        setVisitsSaved(!!data.available);
        if (data.available) setVisits(data.visits ?? []);
      })
      .catch(() => {
        if (!cancelled) setVisitsSaved(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isManager]);

  const search = useCallback(async () => {
    setLoading(true);
    setRouteLegs(null);
    setRouteOrder(null);
    setRouteError(null);
    // The list is always the recommended one unless today's was rearranged by
    // hand on this device — then that arrangement is what comes back.
    setHandOrder(city ? null : readSavedRoute(selectedSalesman));
    setStopCoords({});
    setOriginPlace(null);
    try {
      const rows = await fetchRoutePriorities(supabaseBrowser(), {
        city: city || undefined,
        salesmanId: selectedSalesman || undefined,
      });
      setStops(rows);
    } finally {
      setLoading(false);
    }
  }, [city, selectedSalesman]);

  useEffect(() => {
    search();
  }, [search]);

  async function getRoute() {
    if (!origin.trim() || stops.length === 0) return;
    setRouting(true);
    setRouteError(null);
    try {
      const res = await fetch("/api/planning/directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin,
          stops: stops.map((s) => s.address || `${s.name}, ${s.district ?? ""}`),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRouteLegs(data.legs);
      setRouteOrder(data.waypointOrder);
      // A freshly generated order replaces whatever was arranged by hand —
      // the salesman asked for a new route.
      setHandOrder(null);
      writeSavedRoute(selectedSalesman, null);
      setOriginPlace(data.originPlace ?? null);
      const coords: Record<string, StopCoordinate> = {};
      for (const place of (data.places ?? []) as { index: number; label: string; lat: number; lon: number }[]) {
        const stop = stops[place.index];
        if (stop) coords[stop.customerId] = { lat: place.lat, lon: place.lon, label: place.label };
      }
      setStopCoords(coords);
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : t("planning.couldntGetRoute"));
    } finally {
      setRouting(false);
    }
  }

  const activeVisit = visits.find((v) => !v.departedAt) ?? null;
  const finishedVisits = visits.filter((v) => v.departedAt);

  async function startVisit(stop: RouteStop) {
    if (activeVisit) return;
    // Optimistic: the clock starts under the finger, not after a round trip.
    const optimistic: Visit = {
      id: null,
      customerId: stop.customerId,
      customerName: stop.name,
      arrivedAt: new Date().toISOString(),
      departedAt: null,
    };
    const previous = visits;
    setVisits([...visits, optimistic]);
    if (visitsSaved === false) return; // Session-only, nothing to save to.

    try {
      const res = await fetch("/api/planning/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: stop.customerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("planning.couldntStartVisit"));
      if (data.available === false) {
        setVisitsSaved(false);
        return; // Keep the optimistic row; it just won't outlive the tab.
      }
      setVisitsSaved(true);
      setVisits((current) =>
        current.map((v) => (v === optimistic ? { ...data.visit, customerName: data.visit.customerName ?? stop.name } : v))
      );
    } catch (e) {
      setVisits(previous); // Real rollback — the timer stops as if never started.
      toast.error(e instanceof Error ? e.message : t("planning.couldntStartVisit"));
    }
  }

  async function endVisit(stop: RouteStop) {
    if (!activeVisit || activeVisit.customerId !== stop.customerId) return;
    const previous = visits;
    const departedAt = new Date().toISOString();
    setVisits(visits.map((v) => (v === activeVisit ? { ...v, departedAt } : v)));
    if (visitsSaved === false || !activeVisit.id) return;

    try {
      const res = await fetch("/api/planning/visits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitId: activeVisit.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("planning.couldntEndVisit"));
      if (data.available === false) {
        setVisitsSaved(false);
        return;
      }
      setVisits((current) => current.map((v) => (v.id === activeVisit.id ? { ...v, ...data.visit } : v)));
    } catch (e) {
      setVisits(previous); // Rollback — the visit is still running.
      toast.error(e instanceof Error ? e.message : t("planning.couldntEndVisit"));
    }
  }

  // The generated order, then whatever the salesman has rearranged on top.
  const generatedStops = routeOrder ? routeOrder.map((i) => stops[i]).filter(Boolean) : stops;
  let orderedStops = generatedStops;
  if (handOrder) {
    const remaining = new Map(generatedStops.map((s) => [s.customerId, s]));
    const arranged: RouteStop[] = [];
    for (const id of handOrder) {
      const stop = remaining.get(id);
      if (stop) {
        arranged.push(stop);
        remaining.delete(id);
      }
    }
    orderedStops = [...arranged, ...remaining.values()];
  }

  // A leg is "from the previous stop", so once the order is changed by hand
  // the generated ones describe a journey nobody is making any more. Hidden
  // rather than shown against the wrong pair.
  const legsApply = !handOrder;
  const numbered = routeOrder != null;

  function setOrder(next: RouteStop[]) {
    const ids = next.map((s) => s.customerId);
    setHandOrder(ids);
    if (!city) writeSavedRoute(selectedSalesman, ids);
  }

  function backToRecommended() {
    setHandOrder(null);
    writeSavedRoute(selectedSalesman, null);
    setAnnouncement(t("planning.backToRecommendedDone"));
  }

  function moveBy(stop: RouteStop, delta: number) {
    const from = orderedStops.findIndex((s) => s.customerId === stop.customerId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= orderedStops.length) return;
    setOrder(moveItem(orderedStops, from, to));
    setAnnouncement(t("planning.movedToPosition", { name: stop.name, position: to + 1, total: orderedStops.length }));
  }

  // Pointer-based drag, the same way the widget grid does it — HTML5
  // drag-and-drop never fires on touch, and this has to work on the tablet in
  // the van. The list reorders live under the finger.
  function handlePointerDown(e: React.PointerEvent, stop: RouteStop) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragId(stop.customerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragId || !listRef.current) return;
    const over = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => (el as HTMLElement).closest?.("[data-stop-id]"))
      .find(Boolean) as HTMLElement | undefined;
    const overId = over?.dataset.stopId;
    if (!overId || overId === dragId) return;
    const from = orderedStops.findIndex((s) => s.customerId === dragId);
    const to = orderedStops.findIndex((s) => s.customerId === overId);
    if (from < 0 || to < 0) return;
    setOrder(moveItem(orderedStops, from, to));
  }

  function endDrag() {
    if (dragId) {
      const stop = orderedStops.find((s) => s.customerId === dragId);
      const at = orderedStops.findIndex((s) => s.customerId === dragId);
      if (stop && at >= 0)
        setAnnouncement(t("planning.movedToPosition", { name: stop.name, position: at + 1, total: orderedStops.length }));
    }
    setDragId(null);
  }

  // Only the stops Apple could actually place. One unplaceable address
  // leaves a gap in the pins, not a broken map.
  const mapStops: RouteMapStop[] = [];
  for (const stop of orderedStops) {
    const place = stopCoords[stop.customerId];
    if (!place) continue;
    mapStops.push({
      customerId: stop.customerId,
      name: stop.name,
      subtitle: place.label,
      lat: place.lat,
      lon: place.lon,
      tone: TIER_TONE[stop.tier],
    });
  }

  const layoutTransition = respectMotion(springLayout, reducedMotion);

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">{t("nav.planning")}</h1>
      </div>

      <Card className="p-4 mb-5">
        <div className="grid sm:grid-cols-3 gap-3">
          {isManager && (
            <div>
              <label className="text-caption text-secondary font-semibold">{t("nav.role.salesman")}</label>
              <select
                className="w-full mt-1 px-3 py-2 rounded-card border border-hairline bg-surface text-subhead"
                value={selectedSalesman}
                onChange={(e) => setSelectedSalesman(e.target.value)}
              >
                <option value="">{t("planning.allSalesmen")}</option>
                {salesmen.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="text-caption text-secondary font-semibold">{t("planning.cityDistrict")}</label>
            <div className="relative mt-1">
              <MapPin size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-secondary" />
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder={t("planning.cityPlaceholder")}
                className="w-full ps-9 pe-3 py-2 rounded-card border border-hairline bg-surface text-subhead"
              />
            </div>
          </div>
          <div>
            <label className="text-caption text-secondary font-semibold">{t("planning.startingPoint")}</label>
            <TextInput value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder={t("planning.originPlaceholder")} className="mt-1" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Button tier="plain" onClick={search} className="flex items-center gap-1.5">
            <Search size={14} /> {t("planning.refreshList")}
          </Button>
          <Button tier="primary" disabled={routing || !origin.trim() || stops.length === 0} onClick={getRoute}>
            {routing ? t("planning.gettingRoute") : t("planning.getRoute")}
          </Button>
        </div>
        {routeError && <div className="mt-2 text-caption text-[--status-danger]">{routeError}</div>}
      </Card>

      {/* The map (parity with the phone). Appears once the stops have been
          placed on it — before that, and whenever Apple Maps is not set up,
          the page is the list it has always been. */}
      {mapStops.length > 0 && <RouteMap stops={mapStops} origin={originPlace} />}

      {/* Announces a reorder to a screen reader, which cannot see the row
          slide. */}
      <div aria-live="polite" className="sr-only">{announcement}</div>

      {loading ? (
        <SkeletonList rows={5} />
      ) : stops.length === 0 ? (
        <EmptyState icon={MapPin} title={t("planning.noCustomersMatch")} />
      ) : (
        <Card className="overflow-hidden">
          <div ref={listRef} className="divide-y divide-hairline">
            {orderedStops.map((stop, i) => {
              const leg = legsApply ? routeLegs?.[i] : undefined;
              const isActive = activeVisit?.customerId === stop.customerId;
              return (
                <motion.div
                  key={stop.customerId}
                  layout
                  transition={layoutTransition}
                  data-stop-id={stop.customerId}
                  onPointerMove={handlePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  style={{ touchAction: dragId ? "none" : undefined }}
                  className={`px-4 py-3.5 ${dragId === stop.customerId ? "opacity-60 relative z-10" : ""}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {numbered && <span className="text-caption font-bold text-accent tabular-nums">{i + 1}.</span>}
                        <span className="text-subhead font-semibold truncate">{stop.name}</span>
                      </div>
                      <div className="text-caption text-secondary truncate">
                        {stop.code} {stop.district ? `· ${stop.district}` : ""}
                        {stop.daysIdle != null ? ` · ${t("planning.idleDays", { days: stop.daysIdle })}` : ` · ${t("planning.noOrdersYet")}`}
                        {stop.overdueAmount > 0 ? ` · ${t("planning.overdueAmount", { amount: formatAed(stop.overdueAmount) })}` : ""}
                        {stop.outstandingAmount > stop.overdueAmount
                          ? ` · ${t("planning.toCollect", { amount: formatAed(stop.outstandingAmount) })}`
                          : ""}
                      </div>
                      {leg && (
                        <div className="text-caption text-secondary mt-1">
                          {leg.distanceText} · {leg.durationText} {t("planning.fromPreviousStop")}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {stop.tier !== "normal" && <Pill tone={TIER_TONE[stop.tier]}>{stop.reason}</Pill>}

                      {/* Reordering by hand (parity with the phone's
                          `moveStop`). Drag for the mouse and the tablet, the
                          two arrows for a keyboard — drag alone would put the
                          feature out of reach of anyone not using a pointer. */}
                      <button
                        type="button"
                        onClick={() => moveBy(stop, -1)}
                        disabled={i === 0}
                        className="w-11 h-11 grid place-items-center rounded-full text-secondary hover:text-primary hover:bg-primary/[0.04] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150 ease-out"
                        aria-label={t("planning.moveUpLabel", { name: stop.name })}
                        title={t("planning.moveUp")}
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveBy(stop, 1)}
                        disabled={i === orderedStops.length - 1}
                        className="w-11 h-11 grid place-items-center rounded-full text-secondary hover:text-primary hover:bg-primary/[0.04] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150 ease-out"
                        aria-label={t("planning.moveDownLabel", { name: stop.name })}
                        title={t("planning.moveDown")}
                      >
                        <ChevronDown size={16} />
                      </button>
                      <div
                        onPointerDown={(e) => handlePointerDown(e, stop)}
                        className="w-11 h-11 grid place-items-center rounded-full text-secondary cursor-grab active:cursor-grabbing touch-none"
                        aria-hidden
                        title={t("planning.dragToReorder")}
                      >
                        <GripVertical size={16} />
                      </div>

                      {!isManager && (
                        isActive ? (
                          <button
                            onClick={() => endVisit(stop)}
                            className="w-11 h-11 grid place-items-center rounded-full bg-danger/12 text-[--status-danger]"
                            aria-label={t("planning.endVisitLabel", { name: stop.name })}
                            title={t("planning.endVisit")}
                          >
                            <Square size={14} />
                          </button>
                        ) : (
                          <button
                            onClick={() => startVisit(stop)}
                            disabled={!!activeVisit}
                            className="w-11 h-11 grid place-items-center rounded-full bg-accent/12 text-accent disabled:opacity-30"
                            aria-label={t("planning.startVisitLabel", { name: stop.name })}
                            title={t("planning.startVisit")}
                          >
                            <Play size={14} />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </Card>
      )}

      {handOrder && (
        <div className="flex items-center justify-between gap-3 flex-wrap mt-2">
          <p className="text-caption text-secondary">
            {routeLegs ? t("planning.orderChangedByHand") : t("planning.routeEditedByHand")}
          </p>
          <Button tier="plain" onClick={backToRecommended}>{t("planning.backToRecommended")}</Button>
        </div>
      )}

      {finishedVisits.length > 0 && (
        <Card className="p-4 mt-5">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock size={14} className="text-secondary" />
            <span className="text-subhead font-semibold">{t("planning.todaysVisits")}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {finishedVisits.map((v, i) => (
              <div key={v.id ?? i} className="flex items-center justify-between text-caption">
                <span className="text-secondary">{v.customerName ?? t("planning.customer")}</span>
                <span className="tabular-nums font-medium">
                  {t("planning.minutesShort", { n: minutesBetween(v.arrivedAt, v.departedAt!) })}
                </span>
              </div>
            ))}
          </div>
          {visitsSaved === false && (
            <p className="text-caption text-secondary mt-2">
              {t("planning.sessionOnlyVisits")}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
