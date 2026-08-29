import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

interface ImportRow {
  code: string;
  name: string;
  group_name?: string | null;
  district?: string | null;
  address?: string | null;
  phone?: string | null;
  vat_number?: string | null;
  overdue_threshold_days?: number;
  is_active?: boolean;
}

// Manager-only bulk import (§Part 4 Phase 2), mirroring the products import
// route — upserts on `code` (the customer's natural unique key) so
// re-running an updated customer list corrects rows instead of duplicating.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { rows } = (await req.json()) as { rows: ImportRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No rows to import" }, { status: 400 });
  }

  const clean = rows
    .filter((r) => r.code && r.name)
    .map((r) => ({
      code: r.code,
      name: r.name,
      group_name: r.group_name || null,
      district: r.district || null,
      address: r.address || null,
      phone: r.phone || null,
      vat_number: r.vat_number || null,
      overdue_threshold_days: r.overdue_threshold_days != null ? Number(r.overdue_threshold_days) || 90 : 90,
      is_active: r.is_active === undefined ? true : String(r.is_active).toLowerCase() !== "false",
    }));

  if (clean.length === 0) {
    return NextResponse.json({ error: "Every row needs at least code and name" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin.from("customers").upsert(clean, { onConflict: "code" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, count: clean.length });
}
