import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A day's orders, imported from one spreadsheet.
//
// Rows are grouped by their invoice column into whole orders; without one,
// the entire file is read as a single order. Every SKU has to exist in the
// catalogue — an unknown code is skipped and reported rather than quietly
// creating a line nobody can pick.
//
// Service-role, because order lines carry a cost snapshot taken from
// products.cost, which the importing session cannot read (same reason
// /api/orders/create is service-role).
//
// Orders arrive as `pending`, so a manager still reviews every one before it
// reaches the warehouse, and no invoice number is issued here.

interface ImportRow {
  invoice?: string;
  customer?: string;
  sku?: string;
  qty?: string;
  price?: string;
  salesman?: string;
}

function num(v: string | undefined): number {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const { rows } = (await req.json()) as { rows?: ImportRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "That file had no rows to import." }, { status: 400 });
  }

  // ---- Resolve the catalogue and the customers ----
  const { data: products, error: prodErr } = await admin
    .from("products")
    .select("id, sku, description, price, cost");
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });
  const bySku = new Map((products ?? []).map((p) => [p.sku.trim().toLowerCase(), p]));

  const { data: customers } = await admin.from("customers").select("id, code, name").eq("is_active", true);
  const byCode = new Map((customers ?? []).map((c) => [c.code.trim().toLowerCase(), c]));
  const byName = new Map((customers ?? []).map((c) => [c.name.trim().toLowerCase(), c]));

  const { data: salesmen } = await admin.from("users").select("id, full_name, username").eq("is_active", true);
  const salesmanByName = new Map(
    (salesmen ?? []).flatMap((u) => [
      [u.full_name.trim().toLowerCase(), u.id] as const,
      [u.username.trim().toLowerCase(), u.id] as const,
    ])
  );

  // ---- Group rows into orders ----
  const groups = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const key = (r.invoice ?? "").trim() || "__single__";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  // Anything already waiting for review with the same customer and the same
  // items is the same order — re-running an import must not double it up.
  const { data: pending } = await admin
    .from("orders")
    .select("id, customer_id, new_customer_note")
    .eq("status", "pending");
  const pendingIds = (pending ?? []).map((o) => o.id);
  const existingFingerprints = new Set<string>();
  if (pendingIds.length) {
    const { data: pendingItems } = await admin
      .from("order_items")
      .select("order_id, product_id, ordered_qty")
      .in("order_id", pendingIds);
    const linesByOrder = new Map<string, string[]>();
    for (const it of pendingItems ?? []) {
      const list = linesByOrder.get(it.order_id) ?? [];
      list.push(`${it.product_id}:${it.ordered_qty}`);
      linesByOrder.set(it.order_id, list);
    }
    for (const o of pending ?? []) {
      const lines = (linesByOrder.get(o.id) ?? []).sort();
      if (lines.length === 0) continue;
      existingFingerprints.add(`${o.customer_id ?? o.new_customer_note ?? ""}|${lines.join(",")}`);
    }
  }

  const unknownSkus = new Set<string>();
  const created: string[] = [];
  let skippedDuplicates = 0;

  for (const [key, groupRows] of groups) {
    // Merge repeated SKUs inside one order rather than creating two lines.
    const lines = new Map<string, { productId: string; sku: string; description: string; qty: number; price: number; cost: number | null }>();
    let customerId: string | null = null;
    let customerNote: string | null = null;
    let salesmanId: string | null = null;

    for (const r of groupRows) {
      const rawCustomer = (r.customer ?? "").trim();
      if (rawCustomer && !customerId && !customerNote) {
        const match = byCode.get(rawCustomer.toLowerCase()) ?? byName.get(rawCustomer.toLowerCase());
        if (match) customerId = match.id;
        else customerNote = rawCustomer;
      }
      const rawSalesman = (r.salesman ?? "").trim();
      if (rawSalesman && !salesmanId) salesmanId = salesmanByName.get(rawSalesman.toLowerCase()) ?? null;

      const rawSku = (r.sku ?? "").trim();
      if (!rawSku) continue;
      const product = bySku.get(rawSku.toLowerCase());
      if (!product) {
        unknownSkus.add(rawSku);
        continue;
      }
      const qty = Math.max(1, Math.round(num(r.qty) || 1));
      const stated = num(r.price);
      const existing = lines.get(product.id);
      if (existing) {
        existing.qty += qty;
      } else {
        lines.set(product.id, {
          productId: product.id,
          sku: product.sku,
          description: product.description ?? "",
          qty,
          // A price in the file is what was agreed; otherwise the catalogue.
          price: stated > 0 ? stated : product.price,
          cost: product.cost ?? null,
        });
      }
    }

    if (lines.size === 0) continue;
    if (!customerId && !customerNote) continue;

    const fingerprint = `${customerId ?? customerNote ?? ""}|${[...lines.values()]
      .map((l) => `${l.productId}:${l.qty}`)
      .sort()
      .join(",")}`;
    if (existingFingerprints.has(fingerprint)) {
      skippedDuplicates += 1;
      continue;
    }

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .insert({
        customer_id: customerId,
        new_customer_note: customerNote,
        salesman_id: salesmanId ?? caller.id,
        status: "pending",
        // Says where it came from, so a manager reviewing it knows it was
        // not typed in by a salesman on the road.
        manager_note: key === "__single__" ? "Imported" : `Imported (${key})`,
      })
      .select("id")
      .single();
    if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });

    const { error: itemsErr } = await admin.from("order_items").insert(
      [...lines.values()].map((l) => ({
        order_id: order.id,
        product_id: l.productId,
        sku: l.sku,
        description: l.description,
        unit_price: l.price,
        unit_cost: l.cost,
        ordered_qty: l.qty,
      }))
    );
    if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 400 });

    existingFingerprints.add(fingerprint);
    created.push(order.id as string);
  }

  if (created.length === 0) {
    return NextResponse.json(
      {
        error:
          unknownSkus.size > 0
            ? `No orders created. These codes aren't in the catalogue: ${[...unknownSkus].slice(0, 8).join(", ")}`
            : skippedDuplicates > 0
            ? "Every order in that file has already been imported."
            : "No orders could be read from that file.",
      },
      { status: 400 }
    );
  }

  const notes: string[] = [];
  if (skippedDuplicates > 0) {
    notes.push(
      `${skippedDuplicates} order${skippedDuplicates === 1 ? " was" : "s were"} already imported and skipped.`
    );
  }
  if (unknownSkus.size > 0) {
    notes.push(`Codes not in the catalogue were left out: ${[...unknownSkus].slice(0, 8).join(", ")}.`);
  }

  return NextResponse.json({
    ok: true,
    count: created.length,
    skippedDuplicates,
    unknownSkus: [...unknownSkus],
    note: notes.join(" "),
  });
}
