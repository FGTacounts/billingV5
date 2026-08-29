"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, X, Package, Truck, FileEdit, Ban, Clock, Pencil } from "lucide-react";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useRealtimeTable } from "@/lib/realtime/useRealtimeTable";
import {
  fetchOrder,
  fetchOrderItems,
  acceptOrder,
  rejectOrder,
  resubmitOrder,
  sendDraft,
  startPicking,
  markPacked,
  requestEdit,
  denyEditRequest,
  startDelivering,
  cancelOrder,
  notify,
  daysUntilPurge,
  type OrderRow,
  type OrderItemRow,
} from "@/lib/queries/orders";
import { requestExtension } from "@/lib/queries/payments";
import { fetchSalesmen } from "@/lib/queries/expenses";
import { fetchCustomers } from "@/lib/queries/customers";
import type { AppUser } from "@/lib/types/db";
import { subtotal, vat, total, formatAed, effectiveQty } from "@/lib/money";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { TextInput, Label } from "@/components/ui/Field";
import { OrderStatusPill, Pill } from "@/components/ui/Badge";
import { tap, tapSuccess } from "@/lib/haptics";
import { queuePickUpdate, getQueuedPickItemIds } from "@/lib/offline-queue";

export default function OrderDetail({
  orderId,
  user,
  onClose,
  onChanged,
}: {
  orderId: string;
  user: AppUser;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [pendingSyncIds, setPendingSyncIds] = useState<string[]>(() => getQueuedPickItemIds());
  const [editingRackId, setEditingRackId] = useState<string | null>(null);
  const [rackDraft, setRackDraft] = useState("");
  // Line-item qty/price edits on not-yet-accepted orders (§Next Updates
  // Orders: "make order data editable") — scoped server-side to
  // draft/pending, see app/api/orders/update-item/route.ts.
  const [editingQtyId, setEditingQtyId] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState("");
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  // §Orders: Warehouse can send a note to the Manager during picking.
  const [editingManagerNote, setEditingManagerNote] = useState(false);
  const [managerNoteDraft, setManagerNoteDraft] = useState("");
  const [savingManagerNote, setSavingManagerNote] = useState(false);
  // §Orders: "Manager has complete flexibility over an order at any stage
  // (invoice number, customer, salesman, PO number editable)".
  const [showEditFields, setShowEditFields] = useState(false);
  const { preferences, update: updatePrefs } = usePreferences();
  const pickingSort = preferences.pickingSort ?? "unpicked";

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const [o, its] = await Promise.all([
      fetchOrder(supabase, orderId),
      fetchOrderItems(supabase, orderId),
    ]);
    setOrder(o);
    setItems(its);
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  // Bug fix (Order Flow & Additions §8): with more than one Warehouse
  // picker on the same order, this sheet had no way to learn about a
  // concurrent picker's tick — each session's `items` snapshot only ever
  // refreshed after ITS OWN edit. A second picker acting on their now-stale
  // local copy could silently overwrite the first picker's progress (a
  // "spontaneous unpick"). Subscribing here closes that staleness window —
  // any change to this order's items, from any session, reloads for
  // everyone looking at it.
  useRealtimeTable("order_items", () => load(), `order_id=eq.${orderId}`);

  async function run(fn: () => Promise<void>, successHaptic = true) {
    setBusy(true);
    try {
      await fn();
      if (successHaptic) tapSuccess();
      await load();
      onChanged();
    } catch (e) {
      toast.error(friendlyError(e, "Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  // The signature picking checkmark (§0.4) gets the optimistic-update
  // treatment §0.2/§0.4 call "required, not optional": the row updates the
  // instant you commit a quantity, the network call reconciles quietly in
  // the background, and a failure rolls the row back with an error toast
  // rather than making the pick wait on a round-trip. A genuine network
  // failure (weak-connection Warehouse floor, §Part 4 Phase 2) is handled
  // differently from a real server error: it queues the pick for automatic
  // replay instead of rolling back a tap the picker visibly just made.
  const pickMutation = useMutation({
    mutationFn: async ({ itemId, pickedQty }: { itemId: string; pickedQty: number }) => {
      if (!navigator.onLine) {
        queuePickUpdate(itemId, pickedQty);
        return { queued: true };
      }
      try {
        const res = await fetch("/api/orders/update-picked-qty", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId, pickedQty }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to update picked quantity");
        return { queued: false };
      } catch (e) {
        if (e instanceof TypeError) {
          // fetch() itself failed (no connectivity) rather than the server
          // returning an error — queue it rather than discarding the pick.
          queuePickUpdate(itemId, pickedQty);
          return { queued: true };
        }
        throw e;
      }
    },
    onMutate: async ({ itemId, pickedQty }) => {
      const previous = items;
      setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, picked_qty: pickedQty } : it)));
      return { previous };
    },
    onSuccess: (result, vars) => {
      if (result.queued) {
        setPendingSyncIds((prev) => (prev.includes(vars.itemId) ? prev : [...prev, vars.itemId]));
      } else {
        setPendingSyncIds((prev) => prev.filter((id) => id !== vars.itemId));
        tapSuccess();
      }
    },
    onError: (e, _vars, context) => {
      if (context) setItems(context.previous);
      toast.error(friendlyError(e, "Something went wrong"));
    },
    onSettled: (result) => {
      // A queued (offline) update must NOT trigger a reload — the server
      // hasn't actually changed, so refetching would just overwrite the
      // optimistic value we're deliberately holding onto until it syncs.
      if (!result?.queued) load();
    },
  });

  function changeQty(item: OrderItemRow, pickedQty: number) {
    pickMutation.mutate({ itemId: item.id, pickedQty });
  }

  // Select All / Deselect All (§8's Warehouse Picking section) — fires the
  // same per-item optimistic mutation as a single tap, just for every row
  // that isn't already at the target state.
  function selectAll() {
    for (const it of items) {
      if (it.picked_qty !== it.ordered_qty) changeQty(it, it.ordered_qty);
    }
  }
  function deselectAll() {
    for (const it of items) {
      if ((it.picked_qty ?? 0) !== 0) changeQty(it, 0);
    }
  }

  async function saveRack(productId: string) {
    const location = rackDraft;
    setEditingRackId(null);
    await fetch("/api/products/rack", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, rackLocation: location }),
    });
    load();
  }

  async function saveItemField(itemId: string, patch: { orderedQty?: number } | { unitPrice?: number }) {
    setEditingQtyId(null);
    setEditingPriceId(null);
    const res = await fetch("/api/orders/update-item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, ...patch }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Failed to save");
    }
    load();
  }

  async function saveManagerNote() {
    setSavingManagerNote(true);
    try {
      const res = await fetch("/api/orders/set-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, field: "manager_note", text: managerNoteDraft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save note");
      }
      setEditingManagerNote(false);
      load();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to save note"));
    } finally {
      setSavingManagerNote(false);
    }
  }

  // Sort control (§8.4) — remembered per-user via preferences, same
  // pattern as the Average Sale date-range memory. "Unpicked first" is the
  // default so the picker always sees what's left to do at the top.
  const sortedItems = useMemo(() => {
    const copy = [...items];
    if (pickingSort === "article") {
      copy.sort((a, b) => (a.sku || "").localeCompare(b.sku || ""));
    } else if (pickingSort === "rack") {
      copy.sort((a, b) => (a.product?.rack_location || "").localeCompare(b.product?.rack_location || ""));
    } else {
      copy.sort((a, b) => {
        const aDone = a.picked_qty === a.ordered_qty ? 1 : 0;
        const bDone = b.picked_qty === b.ordered_qty ? 1 : 0;
        return aDone - bDone;
      });
    }
    return copy;
  }, [items, pickingSort]);

  if (loading || !order) {
    return (
      <Sheet open onClose={onClose} title="Order">
        <div className="text-secondary text-subhead py-10 text-center">Loading…</div>
      </Sheet>
    );
  }

  const isManager = (user.role === "manager" || user.role === "admin");
  const isWarehouse = user.role === "warehouse";
  const isSalesman = user.role === "salesman";
  const purgeDays = daysUntilPurge(order.rejected_at);
  // §Next Updates Orders: "make order data editable" — scoped to
  // draft/pending, own order or Manager; later stages go through the
  // existing pick/edit-request flow instead.
  const canEditItems =
    ["draft", "pending"].includes(order.status) && (isManager || order.salesman_id === user.id);

  return (
    <>
    <Sheet
      open
      onClose={onClose}
      title={order.invoice_number ? `Invoice #${order.invoice_number}` : `Order · ${order.status}`}
      headerExtra={
        <div className="flex items-center gap-3">
          {order.status !== "draft" && (
            <>
              <a
                href={`/api/invoice-pdf?orderId=${order.id}`}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-accent hover:border-accent/50 transition-colors"
              >
                Export PDF
              </a>
              {isManager && (
                <a
                  href={`/api/orders/excel?orderId=${order.id}`}
                  className="px-3 py-1.5 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-accent hover:border-accent/50 transition-colors"
                >
                  Export Excel
                </a>
              )}
            </>
          )}
          {isManager && (
            <Button tier="tinted" onClick={() => setShowEditFields(true)} className="!px-3 !py-1.5 text-caption">
              Edit details
            </Button>
          )}
        </div>
      }
      footer={
        <OrderActions
          order={order}
          user={user}
          busy={busy}
          confirmReject={confirmReject}
          setConfirmReject={setConfirmReject}
          run={run}
        />
      }
    >
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <OrderStatusPill status={order.status} />
        {order.status === "rejected" && purgeDays != null && (
          <Pill tone={purgeDays <= 5 ? "danger" : "warning"}>
            {purgeDays <= 0
              ? "Purging today"
              : `Permanently deleted in ${purgeDays} day${purgeDays === 1 ? "" : "s"} unless resubmitted`}
          </Pill>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-subhead mb-5">
        <Field label="Customer" value={order.customer?.name ?? order.new_customer_note ?? "—"} />
        {order.salesman?.full_name && <Field label="Salesman" value={order.salesman.full_name} />}
        {order.customer?.district && <Field label="District" value={order.customer.district} />}
        <Field label="Created" value={new Date(order.created_at).toLocaleString()} />
      </div>

      {/* Role-routed notes (§Orders) — each channel only rendered for the
          roles it's actually relevant to: Manager sees all three, Warehouse
          only sees the Manager->Warehouse and their own Warehouse->Manager
          note, Salesman only sees Manager->Salesman and their own
          Salesman->Manager note. */}
      {order.warehouse_note && (isWarehouse || isManager) && (
        <div className="mb-3 p-3 rounded-card bg-canvas">
          <div className="text-caption text-secondary font-semibold mb-1">Note for warehouse</div>
          <div className="text-subhead">{order.warehouse_note}</div>
        </div>
      )}
      {order.salesman_note && (isSalesman || isManager) && (
        <div className="mb-3 p-3 rounded-card bg-canvas">
          <div className="text-caption text-secondary font-semibold mb-1">Note for salesman</div>
          <div className="text-subhead">{order.salesman_note}</div>
        </div>
      )}
      {order.manager_note && (isSalesman || isWarehouse || isManager) && (
        <div className="mb-3 p-3 rounded-card bg-canvas">
          <div className="text-caption text-secondary font-semibold mb-1">Note for manager</div>
          <div className="text-subhead">{order.manager_note}</div>
        </div>
      )}

      {isWarehouse && ["waiting", "picking", "packed"].includes(order.status) && (
        <div className="mb-5">
          {editingManagerNote ? (
            <div className="p-3 rounded-card bg-canvas">
              <Label>Note for manager</Label>
              <textarea
                autoFocus
                className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[64px]"
                value={managerNoteDraft}
                onChange={(e) => setManagerNoteDraft(e.target.value)}
              />
              <div className="flex gap-2 mt-2">
                <Button tier="plain" onClick={() => setEditingManagerNote(false)}>Cancel</Button>
                <Button tier="tinted" disabled={savingManagerNote} onClick={saveManagerNote}>
                  {savingManagerNote ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : (
            <Button tier="plain" onClick={() => { setManagerNoteDraft(order.manager_note ?? ""); setEditingManagerNote(true); }}>
              {order.manager_note ? "Edit note for manager" : "+ Add note for manager"}
            </Button>
          )}
        </div>
      )}

      {(isWarehouse || isManager) && ["waiting", "picking"].includes(order.status) && (
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <div className="flex rounded-card border border-hairline overflow-hidden">
            {(["unpicked", "article", "rack"] as const).map((s) => (
              <button
                key={s}
                onClick={() => updatePrefs({ pickingSort: s })}
                className={`px-2.5 py-1 text-caption font-medium ${
                  pickingSort === s ? "bg-accent text-white" : "text-secondary"
                }`}
              >
                {s === "unpicked" ? "Unpicked first" : s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button tier="tinted" onClick={selectAll}>Select all</Button>
            <Button tier="plain" onClick={deselectAll}>Deselect all</Button>
          </div>
        </div>
      )}

      <div className="border border-hairline rounded-card overflow-hidden mb-4">
        <table className="w-full text-subhead">
          <thead>
            <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
              <th className="px-3 py-2.5 font-medium">Item</th>
              {(items.some((it) => it.product?.rack_location) ||
                ((isWarehouse || isManager) && ["waiting", "picking"].includes(order.status))) && (
                <th className="px-3 py-2.5 font-medium">Rack</th>
              )}
              <th className="px-3 py-2.5 font-medium text-right">Qty</th>
              <th className="px-3 py-2.5 font-medium text-right tabular-nums">Price</th>
              <th className="px-3 py-2.5 font-medium text-right tabular-nums">Total</th>
              {isManager && items.some((it) => it.unit_cost != null) && (
                <th className="px-3 py-2.5 font-medium text-right tabular-nums">GP</th>
              )}
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((it) => {
              const canPick =
                (isWarehouse || isManager) && ["waiting", "picking"].includes(order.status);
              const showStrike =
                it.picked_qty != null && it.picked_qty !== it.ordered_qty;
              const qty = effectiveQty(it);
              const lineTotal = it.unit_price * qty;
              const lineCost = (it.unit_cost ?? 0) * qty;
              const lineGp = lineTotal - lineCost;
              const lineGpPct = lineTotal > 0 ? (lineGp / lineTotal) * 100 : 0;
              return (
                <tr key={it.id} className="border-b border-hairline last:border-0">
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{it.description ?? it.product_id}</div>
                    <div className="text-caption text-secondary">{it.sku}</div>
                  </td>
                  {(items.some((x) => x.product?.rack_location) ||
                    ((isWarehouse || isManager) && ["waiting", "picking"].includes(order.status))) && (
                    <td className="px-3 py-2.5 text-secondary">
                      {editingRackId === it.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            autoFocus
                            className="w-16 px-1.5 py-1 rounded-inner border border-hairline text-caption"
                            value={rackDraft}
                            onChange={(e) => setRackDraft(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && saveRack(it.product_id)}
                            onBlur={() => saveRack(it.product_id)}
                          />
                        </div>
                      ) : (isWarehouse || isManager) && ["waiting", "picking"].includes(order.status) ? (
                        <button
                          className="flex items-center gap-1 hover:text-accent"
                          onClick={() => {
                            setRackDraft(it.product?.rack_location ?? "");
                            setEditingRackId(it.id);
                          }}
                        >
                          {it.product?.rack_location || "—"}
                          <Pencil size={11} />
                        </button>
                      ) : (
                        it.product?.rack_location || ""
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {canPick ? (
                      <div className="flex items-center justify-end gap-2">
                        {showStrike && (
                          <span className="line-through text-secondary text-caption">
                            {it.ordered_qty}
                          </span>
                        )}
                        {pendingSyncIds.includes(it.id) && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-[--status-warning] shrink-0"
                            title="Not yet synced — will send automatically when back online"
                          />
                        )}
                        <input
                          type="number"
                          min={0}
                          className="w-16 px-2 py-1 rounded-inner border border-hairline text-right tabular-nums"
                          defaultValue={it.picked_qty ?? it.ordered_qty}
                          onBlur={(e) => {
                            const v = Math.max(0, Number(e.target.value));
                            if (v !== (it.picked_qty ?? it.ordered_qty)) {
                              tap();
                              changeQty(it, v);
                            }
                          }}
                        />
                      </div>
                    ) : canEditItems ? (
                      editingQtyId === it.id ? (
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          className="w-16 px-2 py-1 rounded-inner border border-hairline text-right tabular-nums"
                          value={qtyDraft}
                          onChange={(e) => setQtyDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && saveItemField(it.id, { orderedQty: Math.max(0, Number(qtyDraft)) })}
                          onBlur={() => saveItemField(it.id, { orderedQty: Math.max(0, Number(qtyDraft)) })}
                        />
                      ) : (
                        <button
                          className="flex items-center gap-1 hover:text-accent ml-auto"
                          onClick={() => {
                            setQtyDraft(String(it.ordered_qty));
                            setEditingQtyId(it.id);
                          }}
                        >
                          {it.ordered_qty}
                          <Pencil size={11} />
                        </button>
                      )
                    ) : showStrike ? (
                      <>
                        <span className="line-through text-secondary mr-1">{it.ordered_qty}</span>
                        {it.picked_qty}
                      </>
                    ) : (
                      effectiveQty(it)
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {canEditItems ? (
                      editingPriceId === it.id ? (
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          step="0.01"
                          className="w-20 px-2 py-1 rounded-inner border border-hairline text-right tabular-nums"
                          value={priceDraft}
                          onChange={(e) => setPriceDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && saveItemField(it.id, { unitPrice: Math.max(0, Number(priceDraft)) })}
                          onBlur={() => saveItemField(it.id, { unitPrice: Math.max(0, Number(priceDraft)) })}
                        />
                      ) : (
                        <button
                          className="flex items-center gap-1 hover:text-accent ml-auto"
                          onClick={() => {
                            setPriceDraft(String(it.unit_price));
                            setEditingPriceId(it.id);
                          }}
                        >
                          {formatAed(it.unit_price)}
                          <Pencil size={11} />
                        </button>
                      )
                    ) : (
                      formatAed(it.unit_price)
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">{formatAed(lineTotal)}</td>
                  {isManager && items.some((x) => x.unit_cost != null) && (
                    <td
                      className={`px-3 py-2.5 text-right tabular-nums font-medium ${
                        it.unit_cost == null
                          ? "text-secondary"
                          : lineGp >= 0
                          ? "text-accent"
                          : "text-[--status-danger]"
                      }`}
                    >
                      {it.unit_cost == null ? "—" : `${formatAed(lineGp)} · ${Math.round(lineGpPct)}%`}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Before approval, orders.subtotal/vat_amount/total default to 0 (not
          null) — live-recompute from items (fallback VAT rate, §money.ts)
          whenever the stored total is still that unset 0. Once approved
          they're the authoritative billed amounts (real vat_rate from
          app_settings), so prefer those over recomputing. */}
      <div className="ml-auto w-full max-w-[260px] space-y-1.5 text-subhead">
        <Row label="Subtotal" value={formatAed(order.subtotal || subtotal(items))} />
        <Row label="VAT" value={formatAed(order.vat_amount || vat(items))} />
        <Row label="Total" value={formatAed(order.total || total(items))} bold />
        {isManager && items.some((it) => it.unit_cost != null) && (
          <Row
            label="Gross profit"
            value={formatAed(
              subtotal(items) -
                items.reduce((s, it) => s + (it.unit_cost ?? 0) * effectiveQty(it), 0)
            )}
          />
        )}
      </div>

      {!["draft", "cancelled"].includes(order.status) && (
        <ExtensionRequest orderId={order.id} user={user} />
      )}
    </Sheet>
    {showEditFields && (
      <EditOrderFieldsSheet
        order={order}
        onClose={() => setShowEditFields(false)}
        onSaved={() => {
          setShowEditFields(false);
          load();
        }}
      />
    )}
    </>
  );
}

// §Orders: "Manager has complete flexibility over an order at any stage
// (invoice number, customer, salesman, PO number editable)" — a Manager-only
// sheet layered over the order detail, independent of status.
function EditOrderFieldsSheet({
  order,
  onClose,
  onSaved,
}: {
  order: OrderRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState(order.invoice_number ?? "");
  const [poNumber, setPoNumber] = useState("");
  const [poSupported, setPoSupported] = useState(true);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<{ id: string; name: string; code: string }[]>([]);
  const [customerId, setCustomerId] = useState(order.customer_id ?? "");
  const [customerName, setCustomerName] = useState(order.customer?.name ?? "");
  const [salesmen, setSalesmen] = useState<{ id: string; name: string }[]>([]);
  const [salesmanId, setSalesmanId] = useState(order.salesman_id ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = supabaseBrowser();
    fetchSalesmen(supabase).then(setSalesmen);
    supabase
      .from("orders")
      .select("po_number")
      .eq("id", order.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) { setPoSupported(false); return; }
        setPoNumber((data as { po_number: string | null } | null)?.po_number ?? "");
      });
  }, [order.id]);

  useEffect(() => {
    if (!customerSearch) { setCustomerResults([]); return; }
    const t = setTimeout(async () => {
      const supabase = supabaseBrowser();
      const rows = await fetchCustomers(supabase, { search: customerSearch });
      setCustomerResults(rows.map((c) => ({ id: c.id, name: c.name, code: c.code })));
    }, 200);
    return () => clearTimeout(t);
  }, [customerSearch]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/orders/edit-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: order.id,
          invoice_number: invoiceNumber.trim() || null,
          customer_id: customerId || null,
          salesman_id: salesmanId || null,
          ...(poSupported ? { po_number: poNumber.trim() || null } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit order details"
      footer={
        <>
          <Button tier="plain" onClick={onClose}>Cancel</Button>
          <Button tier="primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Label>Invoice number</Label>
      <TextInput value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />

      <Label>PO number{!poSupported && " (not available yet)"}</Label>
      <TextInput value={poNumber} onChange={(e) => setPoNumber(e.target.value)} disabled={!poSupported} />

      <Label>Customer</Label>
      {customerId && !customerSearch ? (
        <div className="flex items-center justify-between p-3 rounded-card bg-canvas">
          <span className="text-subhead">{customerName}</span>
          <button
            className="text-caption text-accent font-medium"
            onClick={() => { setCustomerId(""); setCustomerName(""); }}
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <TextInput placeholder="Search customers" value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
          {customerResults.length > 0 && (
            <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-40 overflow-y-auto">
              {customerResults.map((c) => (
                <button
                  key={c.id}
                  className="w-full text-left px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0"
                  onClick={() => { setCustomerId(c.id); setCustomerName(c.name); setCustomerSearch(""); setCustomerResults([]); }}
                >
                  {c.name} <span className="text-caption text-secondary">({c.code})</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <Label>Salesman</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
        value={salesmanId}
        onChange={(e) => setSalesmanId(e.target.value)}
      >
        <option value="">— none —</option>
        {salesmen.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </Sheet>
  );
}

function ExtensionRequest({ orderId, user }: { orderId: string; user: AppUser }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!reason.trim() || !dueDate) return;
    setSaving(true);
    try {
      await requestExtension(supabaseBrowser(), orderId, user.id, dueDate, reason.trim());
      setSent(true);
    } catch (e) {
      toast.error(friendlyError(e, "Failed to request extension"));
    } finally {
      setSaving(false);
    }
  }

  if (sent) {
    return (
      <div className="mt-4 text-caption text-secondary flex items-center gap-1.5">
        <Clock size={13} /> Extension requested — awaiting Manager decision.
      </div>
    );
  }

  return (
    <div className="mt-4">
      {!open ? (
        <button
          className="text-caption font-semibold text-secondary flex items-center gap-1.5"
          onClick={() => setOpen(true)}
        >
          <Clock size={13} /> Request payment extension
        </button>
      ) : (
        <div className="p-3 rounded-card bg-canvas">
          <TextInput
            placeholder="Reason for the extension"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
          <TextInput
            className="mt-2"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <div className="flex gap-3 mt-2">
            <Button tier="plain" onClick={() => setOpen(false)}>Cancel</Button>
            <Button tier="primary" disabled={saving || !reason.trim() || !dueDate} onClick={submit}>
              {saving ? "Sending…" : "Submit request"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption text-secondary">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold text-headline" : "text-secondary"}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function OrderActions({
  order,
  user,
  busy,
  confirmReject,
  setConfirmReject,
  run,
}: {
  order: OrderRow;
  user: AppUser;
  busy: boolean;
  confirmReject: boolean;
  setConfirmReject: (v: boolean) => void;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const supabase = supabaseBrowser();
  const isManager = (user.role === "manager" || user.role === "admin");
  const isWarehouse = user.role === "warehouse";
  const isSalesman = user.role === "salesman";

  if (order.status === "draft" && isSalesman) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => sendDraft(supabase, order.id, user.id))}>
        Send order
      </Button>
    );
  }

  if (order.status === "pending" && isManager) {
    if (confirmReject) {
      return (
        <>
          <Button tier="plain" onClick={() => setConfirmReject(false)}>Never mind</Button>
          <Button
            tier="danger"
            disabled={busy}
            onClick={() => run(() => rejectOrder(supabase, order.id, user.id))}
          >
            Confirm reject
          </Button>
        </>
      );
    }
    return (
      <>
        <Button tier="plain" disabled={busy} onClick={() => setConfirmReject(true)} className="flex items-center gap-1.5">
          <X size={15} /> Reject
        </Button>
        <Button
          tier="primary"
          disabled={busy}
          onClick={() => run(() => acceptOrder(supabase, order.id, user.id))}
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> Accept
        </Button>
      </>
    );
  }

  if (order.status === "rejected" && (isSalesman || isManager)) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => resubmitOrder(supabase, order.id, user.id))}>
        Resubmit
      </Button>
    );
  }

  // Manager gets every action available at this status combined into one
  // toolbar — the natural next step (pick/pack) Warehouse also has, plus
  // Manager's own cancel/skip-ahead-and-approve options (§Next Updates:
  // "complete flexibility over orders... pick/pack/deliver/accept/reject/
  // approve at any given state or time").
  if (order.status === "waiting" && isManager) {
    return (
      <>
        <Button
          tier="plain"
          disabled={busy}
          onClick={() => {
            if (confirm("Cancel this order?")) run(() => cancelOrder(supabase, order.id, user.id));
          }}
          className="flex items-center gap-1.5 text-[--status-danger]"
        >
          <Ban size={15} /> Cancel
        </Button>
        <Button tier="tinted" disabled={busy} onClick={() => run(() => startPicking(supabase, order.id, user.id))} className="flex items-center gap-1.5">
          <Package size={15} /> Start picking
        </Button>
        <Button
          tier="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await fetch("/api/orders/approve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId: order.id }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "Approval failed");
            })
          }
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> Approve now (skip picking)
        </Button>
      </>
    );
  }

  if (order.status === "waiting" && isWarehouse) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => startPicking(supabase, order.id, user.id))} className="flex items-center gap-1.5">
        <Package size={15} /> Start picking
      </Button>
    );
  }

  if (order.status === "picking" && isManager) {
    return (
      <>
        <Button
          tier="plain"
          disabled={busy}
          onClick={() => {
            if (confirm("Cancel this order?")) run(() => cancelOrder(supabase, order.id, user.id));
          }}
          className="flex items-center gap-1.5 text-[--status-danger]"
        >
          <Ban size={15} /> Cancel
        </Button>
        <Button tier="tinted" disabled={busy} onClick={() => run(() => markPacked(supabase, order.id, user.id))} className="flex items-center gap-1.5">
          <Check size={15} /> Mark packed
        </Button>
        <Button
          tier="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await fetch("/api/orders/approve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId: order.id }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "Approval failed");
            })
          }
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> Approve now (skip picking)
        </Button>
      </>
    );
  }

  if (order.status === "picking" && isWarehouse) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => markPacked(supabase, order.id, user.id))} className="flex items-center gap-1.5">
        <Check size={15} /> Mark packed
      </Button>
    );
  }

  if (order.status === "packed" && isManager) {
    return (
      <Button
        tier="primary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const res = await fetch("/api/orders/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orderId: order.id }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Approval failed");
          })
        }
      >
        Approve
      </Button>
    );
  }

  // "accepted" has no Warehouse-visible action yet (picking hasn't been
  // sent to a waiting queue) — Manager can still cancel or jump straight to
  // approval from here.
  if (order.status === "accepted" && isManager) {
    return (
      <>
        <Button
          tier="plain"
          disabled={busy}
          onClick={() => {
            if (confirm("Cancel this order?")) run(() => cancelOrder(supabase, order.id, user.id));
          }}
          className="flex items-center gap-1.5 text-[--status-danger]"
        >
          <Ban size={15} /> Cancel order
        </Button>
        <Button
          tier="tinted"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await fetch("/api/orders/approve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId: order.id }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "Approval failed");
            })
          }
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> Approve now (skip picking)
        </Button>
      </>
    );
  }

  if (order.status === "approved" && (isWarehouse || isManager)) {
    return (
      <>
        {isWarehouse && (
          <Button
            tier="plain"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await requestEdit(supabase, order.id, user.id);
                const { data: managers } = await supabase.from("users").select("id").in("role", ["manager", "admin"]);
                for (const m of managers ?? []) {
                  await notify(supabase, m.id, "edit_requested", "Edit requested", "Warehouse requested to edit an approved order");
                }
              })
            }
            className="flex items-center gap-1.5"
          >
            <FileEdit size={15} /> Request edit
          </Button>
        )}
        <Button
          tier="primary"
          disabled={busy}
          onClick={() => run(() => startDelivering(supabase, order.id, user.id))}
          className="flex items-center gap-1.5"
        >
          <Truck size={15} /> Send for delivery
        </Button>
      </>
    );
  }

  if (order.status === "edit_requested" && isManager) {
    return (
      <>
        <Button
          tier="plain"
          disabled={busy}
          onClick={() => run(() => denyEditRequest(supabase, order.id, user.id))}
        >
          Deny
        </Button>
        <Button
          tier="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await fetch("/api/orders/grant-edit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId: order.id }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "Failed");
            })
          }
        >
          Grant edit
        </Button>
      </>
    );
  }

  if (order.status === "delivering" && (isWarehouse || isManager)) {
    return (
      <label className="px-4 py-2.5 rounded-card text-subhead transition-all bg-accent text-white font-semibold hover:bg-accent-strong active:scale-[0.97] cursor-pointer flex items-center gap-1.5">
        <Truck size={15} /> {busy ? "Confirming…" : "Confirm delivered"}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            run(async () => {
              const form = new FormData();
              form.set("orderId", order.id);
              if (file) form.set("photo", file);
              const res = await fetch("/api/orders/finalize-delivery", { method: "POST", body: form });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "Failed to confirm delivery");
            });
          }}
        />
      </label>
    );
  }

  return null;
}
