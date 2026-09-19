import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

interface ImportRow {
  code: string;
  name: string;
  group_name?: string | null;
  district?: string | null;
  address?: string | null;
  phone?: string | null;
  vat_number?: string | null;
  overdue_threshold_days?: number | string;
  country_code?: string | null;
  salesman?: string | null;
  is_active?: boolean | string;
}

const said = (v: unknown): v is string | number | boolean => v !== undefined && v !== null && String(v).trim() !== "";

// Manager-only bulk import (§Part 4 Phase 2), mirroring the products import
// route — upserts on `code` (the customer's natural unique key) so
// re-running an updated customer list corrects rows instead of duplicating.
//
// Only Code and Customer Name are needed. Every other column is optional, and
// optional means two things: a NEW customer gets the default for anything the
// sheet leaves out, and an EXISTING customer keeps what they already have. A
// blank cell is "the sheet did not say", never "erase this" — a sheet of codes
// and phone numbers must not wipe every address in the book.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { rows } = (await req.json()) as { rows: ImportRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: t("customers.importNoRows") }, { status: 400 });
  }

  const usable = rows
    .map((r) => ({ ...r, code: String(r.code ?? "").trim(), name: String(r.name ?? "").trim() }))
    .filter((r) => r.code && r.name);
  if (usable.length === 0) {
    return NextResponse.json({ error: t("customers.importNeedsCodeAndName") }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Salesman is written as a person's name; the table wants their id.
  const staffByName = new Map<string, string>();
  if (usable.some((r) => said(r.salesman))) {
    const { data: staff } = await admin.from("users").select("id, full_name, username");
    for (const u of staff ?? []) {
      if (u.full_name) staffByName.set(String(u.full_name).trim().toLowerCase(), u.id as string);
      if (u.username) staffByName.set(String(u.username).trim().toLowerCase(), u.id as string);
    }
  }

  const COLUMNS =
    "code, name, group_name, district, address, phone, vat_number, overdue_threshold_days, country_code, salesman_id, is_active";
  const existing = new Map<string, Record<string, unknown>>();
  const codes = usable.map((r) => r.code);
  for (let i = 0; i < codes.length; i += 500) {
    const { data } = await admin.from("customers").select(COLUMNS).in("code", codes.slice(i, i + 500));
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) existing.set(row.code as string, row);
  }

  const unknownSalesmen = new Set<string>();
  const byCode = new Map<string, Record<string, unknown>>();
  for (const r of usable) {
    // What the sheet actually said, and nothing else.
    const stated: Record<string, unknown> = { code: r.code, name: r.name };
    if (said(r.group_name)) stated.group_name = String(r.group_name).trim();
    if (said(r.district)) stated.district = String(r.district).trim();
    if (said(r.address)) stated.address = String(r.address).trim();
    if (said(r.phone)) stated.phone = String(r.phone).trim();
    if (said(r.vat_number)) stated.vat_number = String(r.vat_number).trim();
    if (said(r.overdue_threshold_days)) stated.overdue_threshold_days = Number(r.overdue_threshold_days) || 90;
    if (said(r.country_code)) stated.country_code = String(r.country_code).trim().toUpperCase().slice(0, 2);
    if (said(r.is_active)) stated.is_active = !["false", "no", "0", "inactive"].includes(String(r.is_active).trim().toLowerCase());
    if (said(r.salesman)) {
      const id = staffByName.get(String(r.salesman).trim().toLowerCase());
      if (id) stated.salesman_id = id;
      else unknownSalesmen.add(String(r.salesman).trim());
    }

    const base = existing.get(r.code) ?? {
      group_name: null,
      district: null,
      address: null,
      phone: null,
      vat_number: null,
      overdue_threshold_days: 90,
      country_code: null,
      salesman_id: null,
      is_active: true,
    };
    // A code repeated in one sheet would make the upsert touch a row twice,
    // which Postgres refuses; the later row wins, as it would in a spreadsheet.
    byCode.set(r.code, { ...base, ...(byCode.get(r.code) ?? {}), ...stated });
  }

  const payload = [...byCode.values()];
  const { error } = await admin.from("customers").upsert(payload, { onConflict: "code" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const updated = payload.filter((r) => existing.has(r.code as string)).length;
  return NextResponse.json({
    ok: true,
    count: payload.length,
    created: payload.length - updated,
    updated,
    // Named rather than silently dropped, so the sheet can be corrected.
    unknownSalesmen: [...unknownSalesmen].slice(0, 10),
  });
}
