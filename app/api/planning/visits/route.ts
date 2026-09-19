import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Time logged at a stop (§Next Updates Planning: "salesman logs time at
// stop; manager can see every salesman's route").
//
// The clock used to live in React state, so a reload lost the morning's
// visits. It lives in public.route_visits now — one row per visit, opened on
// arrival and closed on departure — which both this app and the phone can
// read.
//
// Until scratchpad/RUN-ME-21-visit-log.sql has been run the table is not
// there. Same shape of fallback as fetchProductsServer's missing-column
// retry: report `available: false` rather than failing, and the Planning
// page carries on with the session-only timer it has always had.

/** A PostgREST error that means "that table does not exist yet". */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // 42P01 = undefined_table; PGRST205 = not in PostgREST's schema cache.
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /route_visits/i.test(error.message ?? "") && /does not exist|schema cache/i.test(error.message ?? "");
}

const UNAVAILABLE = { available: false as const, visits: [] as Visit[] };

interface Visit {
  id: string;
  customerId: string;
  customerName: string | null;
  arrivedAt: string;
  departedAt: string | null;
}

interface VisitRow {
  id: string;
  customer_id: string;
  arrived_at: string;
  departed_at: string | null;
  // PostgREST embeds a to-one relation as an object, but types it as
  // possibly an array — a visit has exactly one customer either way.
  customers?: { name: string | null } | { name: string | null }[] | null;
}

// The name is embedded rather than looked up in the page's stop list: the
// list is filtered to one city, and a visit logged in a city the salesman
// has since navigated away from would otherwise come back nameless.
const COLUMNS = "id, customer_id, arrived_at, departed_at, customers(name)";

function toVisit(row: VisitRow): Visit {
  const customer = Array.isArray(row.customers) ? row.customers[0] : row.customers;
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: customer?.name ?? null,
    arrivedAt: row.arrived_at,
    departedAt: row.departed_at,
  };
}

/**
 * The caller's own visits.
 *
 * `since` is an ISO instant the client works out from its own midnight —
 * the server has no idea what day it is where the salesman is standing.
 * Falls back to the last 24 hours when it is absent or unparseable.
 */
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const sinceParam = req.nextUrl.searchParams.get("since");
  const parsed = sinceParam ? Date.parse(sinceParam) : NaN;
  const since = Number.isNaN(parsed) ? new Date(Date.now() - 24 * 60 * 60 * 1000) : new Date(parsed);

  const { data, error } = await supabaseCaller()
    .from("route_visits")
    .select(COLUMNS)
    .eq("salesman_id", user.id)
    .gte("arrived_at", since.toISOString())
    .order("arrived_at", { ascending: true });

  if (error) {
    if (isMissingTable(error)) return NextResponse.json(UNAVAILABLE);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ available: true, visits: ((data ?? []) as VisitRow[]).map(toVisit) });
}

/** Arrived — opens a visit. */
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const { customerId } = (await req.json()) as { customerId?: string };
  if (!customerId) return NextResponse.json({ error: t("planning.customerIdRequired") }, { status: 400 });

  const { data, error } = await supabaseCaller()
    .from("route_visits")
    .insert({ customer_id: customerId, salesman_id: user.id })
    .select(COLUMNS)
    .single();

  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ available: false });
    // The partial unique index refuses a second open visit — say what that
    // actually means rather than passing on a constraint name.
    if (error.code === "23505") {
      return NextResponse.json({ error: t("planning.visitAlreadyRunning") }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ available: true, visit: toVisit(data as VisitRow) });
}

/** Left — closes the visit. The server stamps the time, not the browser. */
export async function PATCH(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const { visitId } = (await req.json()) as { visitId?: string };
  if (!visitId) return NextResponse.json({ error: t("planning.visitIdRequired") }, { status: 400 });

  const { data, error } = await supabaseCaller()
    .from("route_visits")
    .update({ departed_at: new Date().toISOString() })
    .eq("id", visitId)
    .is("departed_at", null)
    .select(COLUMNS)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ available: false });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) return NextResponse.json({ error: t("planning.visitAlreadyClosed") }, { status: 404 });
  return NextResponse.json({ available: true, visit: toVisit(data as VisitRow) });
}
