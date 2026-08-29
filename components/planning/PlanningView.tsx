"use client";

import { useEffect, useState, useCallback } from "react";
import { MapPin, Search, Clock, Play, Square } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchRoutePriorities, type RouteStop, type PriorityTier } from "@/lib/queries/planning";
import type { AppUser } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { Pill } from "@/components/ui/Badge";
import { TextInput } from "@/components/ui/Field";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";

const TIER_TONE: Record<PriorityTier, "danger" | "accent" | "warning" | "neutral"> = {
  overdue: "danger",
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

// Route optimization (§Next Updates Planning: "salesman enters a city and
// gets the best route... prioritizing overdue-payment customers, excellent
// customers idle 1+ months, customers idle 2-3+ months; salesman logs time
// at stop; manager can see every salesman's route"). Only reachable when a
// Manager/Admin has configured a Google Maps API key — see app/(app)/
// layout.tsx and app/(app)/planning/page.tsx for the hide/redirect gates.
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
  const [activeVisit, setActiveVisit] = useState<{ customerId: string; startedAt: number } | null>(null);
  const [visitLog, setVisitLog] = useState<{ customerId: string; name: string; minutes: number }[]>([]);

  useEffect(() => {
    if (!isManager) return;
    supabaseBrowser()
      .from("users")
      .select("id, full_name")
      .eq("role", "salesman")
      .then(({ data }) => setSalesmen(data ?? []));
  }, [isManager]);

  const search = useCallback(async () => {
    setLoading(true);
    setRouteLegs(null);
    setRouteOrder(null);
    setRouteError(null);
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
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : "Couldn't get a route");
    } finally {
      setRouting(false);
    }
  }

  function startVisit(stop: RouteStop) {
    setActiveVisit({ customerId: stop.customerId, startedAt: Date.now() });
  }

  function endVisit(stop: RouteStop) {
    if (!activeVisit || activeVisit.customerId !== stop.customerId) return;
    const minutes = Math.max(1, Math.round((Date.now() - activeVisit.startedAt) / 60000));
    setVisitLog((prev) => [...prev, { customerId: stop.customerId, name: stop.name, minutes }]);
    setActiveVisit(null);
  }

  const orderedStops = routeOrder ? routeOrder.map((i) => stops[i]).filter(Boolean) : stops;

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">Planning</h1>
      </div>

      <Card className="p-4 mb-5">
        <div className="grid sm:grid-cols-3 gap-3">
          {isManager && (
            <div>
              <label className="text-caption text-secondary font-semibold">Salesman</label>
              <select
                className="w-full mt-1 px-3 py-2 rounded-card border border-hairline bg-surface text-subhead"
                value={selectedSalesman}
                onChange={(e) => setSelectedSalesman(e.target.value)}
              >
                <option value="">All salesmen</option>
                {salesmen.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="text-caption text-secondary font-semibold">City / district</label>
            <div className="relative mt-1">
              <MapPin size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Deira"
                className="w-full pl-9 pr-3 py-2 rounded-card border border-hairline bg-surface text-subhead"
              />
            </div>
          </div>
          <div>
            <label className="text-caption text-secondary font-semibold">Starting point</label>
            <TextInput value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="Warehouse address" className="mt-1" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Button tier="plain" onClick={search} className="flex items-center gap-1.5">
            <Search size={14} /> Refresh list
          </Button>
          <Button tier="primary" disabled={routing || !origin.trim() || stops.length === 0} onClick={getRoute}>
            {routing ? "Getting route…" : "Get route"}
          </Button>
        </div>
        {routeError && <div className="mt-2 text-caption text-[--status-danger]">{routeError}</div>}
      </Card>

      {loading ? (
        <SkeletonList rows={5} />
      ) : stops.length === 0 ? (
        <EmptyState icon={MapPin} title="No customers match this city yet" />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-hairline">
            {orderedStops.map((stop, i) => {
              const leg = routeLegs?.[i];
              const isActive = activeVisit?.customerId === stop.customerId;
              return (
                <div key={stop.customerId} className="px-4 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {routeOrder && <span className="text-caption font-bold text-accent tabular-nums">{i + 1}.</span>}
                        <span className="text-subhead font-semibold truncate">{stop.name}</span>
                      </div>
                      <div className="text-caption text-secondary truncate">
                        {stop.code} {stop.district ? `· ${stop.district}` : ""}
                        {stop.daysIdle != null ? ` · idle ${stop.daysIdle}d` : " · no orders yet"}
                        {stop.overdueAmount > 0 ? ` · overdue ${formatAed(stop.overdueAmount)}` : ""}
                      </div>
                      {leg && (
                        <div className="text-caption text-secondary mt-1">
                          {leg.distanceText} · {leg.durationText} from previous stop
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {stop.tier !== "normal" && <Pill tone={TIER_TONE[stop.tier]}>{stop.reason}</Pill>}
                      {!isManager && (
                        isActive ? (
                          <button
                            onClick={() => endVisit(stop)}
                            className="p-2 rounded-full bg-danger/12 text-[--status-danger]"
                            aria-label="End visit"
                            title="End visit"
                          >
                            <Square size={14} />
                          </button>
                        ) : (
                          <button
                            onClick={() => startVisit(stop)}
                            disabled={!!activeVisit}
                            className="p-2 rounded-full bg-accent/12 text-accent disabled:opacity-30"
                            aria-label="Start visit"
                            title="Start visit"
                          >
                            <Play size={14} />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {visitLog.length > 0 && (
        <Card className="p-4 mt-5">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock size={14} className="text-secondary" />
            <span className="text-subhead font-semibold">Today's visits</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {visitLog.map((v, i) => (
              <div key={i} className="flex items-center justify-between text-caption">
                <span className="text-secondary">{v.name}</span>
                <span className="tabular-nums font-medium">{v.minutes} min</span>
              </div>
            ))}
          </div>
          <p className="text-caption text-secondary mt-2">
            Session-only for now — ask to have this saved permanently and shared with your manager.
          </p>
        </Card>
      )}
    </div>
  );
}
