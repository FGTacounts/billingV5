"use client";

import { toast } from "@/lib/toast";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/errors";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, X, Package, Truck, FileEdit, Ban, Clock, Pencil, Search, Trash2, Undo2, RotateCcw } from "lucide-react";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { useApprovalSettings } from "@/lib/hooks/useApprovalSettings";
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
  reopenOrderWithoutApproval,
  denyEditRequest,
  startDelivering,
  cancelOrder,
  daysUntilPurge,
  type OrderRow,
  type OrderItemRow,
} from "@/lib/queries/orders";
import { requestExtension } from "@/lib/queries/payments";
import { deleteOrder } from "@/lib/queries/orders";
import { billingDateColumn } from "@/lib/billingDate";
import { invalidateOrderFacts } from "@/lib/queries/dashboard";
import { invalidateAging } from "@/lib/queries/aging";
import { fetchSalesmen } from "@/lib/queries/expenses";
import type { Seller } from "@/lib/queries/sales";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchProducts } from "@/lib/queries/products";
import type { AppUser, Product } from "@/lib/types/db";
import { subtotal, vat, total, formatAed, effectiveQty, lineDiscountPercent } from "@/lib/money";
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
  const [editingStockId, setEditingStockId] = useState<string | null>(null);
  const [stockDraft, setStockDraft] = useState("");
  // Line-item qty/price edits on not-yet-accepted orders (§Next Updates
  // Orders: "make order data editable") — scoped server-side to
  // draft/pending, see app/api/orders/update-item/route.ts.
  const [editingQtyId, setEditingQtyId] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState("");
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  // Manager's per-product discount: typed as a percentage off the list price,
  // stored as the unit price it produces (see update-item/route.ts).
  const [editingDiscountId, setEditingDiscountId] = useState<string | null>(null);
  const [discountDraft, setDiscountDraft] = useState("");
  // Manager pricing tools: set a line's price from a target margin, or set
  // the whole order's subtotal and let the lines follow.
  const [editingGpId, setEditingGpId] = useState<string | null>(null);
  const [gpDraft, setGpDraft] = useState("");
  const [editingSubtotal, setEditingSubtotal] = useState(false);
  const [subtotalDraft, setSubtotalDraft] = useState("");
  // A line added to or taken off an order that has already been written —
  // the phone's addArticle/remove on the picking screen. Same rule as the
  // qty/price edit above and enforced in the same place: see
  // app/api/orders/add-item + remove-item.
  const [addingItem, setAddingItem] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState<Product[]>([]);
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

  // Debounced article search, the same shape (and the same 200ms) as the one
  // on the new-order sheet, so adding a line here feels like adding one there.
  useEffect(() => {
    if (!addingItem) return;
    const t = setTimeout(async () => {
      const supabase = supabaseBrowser();
      setProductResults(await fetchProducts(supabase, { search: productSearch || undefined }));
    }, 200);
    return () => clearTimeout(t);
  }, [productSearch, addingItem]);

  async function run(fn: () => Promise<void>, successHaptic = true) {
    setBusy(true);
    try {
      await fn();
      if (successHaptic) tapSuccess();
      await load();
      onChanged();
    } catch (e) {
      toast.error(friendlyError(e, t("common.unknownError")));
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
        if (!res.ok) throw new Error(data.error ?? t("orders.updatePickedQtyFailed"));
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
      toast.error(friendlyError(e, t("common.unknownError")));
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

  async function saveStock(item: OrderItemRow) {
    const value = Number(stockDraft);
    setEditingStockId(null);
    if (!Number.isFinite(value) || value < 0) return;
    if (value === (item.product?.stock_on_hand ?? -1)) return;
    const res = await fetch("/api/products/stock", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: item.product_id, stockOnHand: value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? t("orders.saveStockFailed"));
    }
    load();
  }

  async function saveItemField(
    itemId: string,
    patch: { orderedQty?: number } | { unitPrice?: number } | { discountPercent?: number }
  ) {
    setEditingQtyId(null);
    setEditingPriceId(null);
    setEditingDiscountId(null);
    const res = await fetch("/api/orders/update-item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, ...patch }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? t("orders.saveFailed"));
    }
    load();
  }

  // Adds an article to an order that has already been written. The price
  // comes from the server (the customer's remembered price, else the list
  // price) rather than being decided here, so it matches what the same
  // article would have cost had it been on the order from the start.
  async function addItem(p: Product) {
    setProductSearch("");
    setProductResults([]);
    await run(async () => {
      const res = await fetch("/api/orders/add-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, productId: p.id, qty: p.default_qty || 1 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("orders.addArticleFailed"));
    });
  }

  // Optimistic, with a real rollback: the row goes the moment it is tapped
  // and comes back if the server refuses.
  async function removeItem(item: OrderItemRow) {
    const previous = items;
    setItems((prev) => prev.filter((x) => x.id !== item.id));
    try {
      const res = await fetch("/api/orders/remove-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("orders.removeLineFailed"));
      tapSuccess();
      await load();
      onChanged();
    } catch (e) {
      setItems(previous);
      toast.error(friendlyError(e, t("orders.removeLineFailed")));
    }
  }

  // Pricing from the margin instead of the price. A manager quotes in gross
  // profit far more often than in dirhams per unit, and working the price out
  // by hand is where mistakes happen.
  //
  // price = cost / (1 − gp/100). Cost is never touched — it is what was paid,
  // and the invoice's discount column is derived from the gap between the
  // list price and what is actually charged.
  async function saveLineGpPercent(item: OrderItemRow, targetPct: number) {
    setEditingGpId(null);
    if (item.unit_cost == null || item.unit_cost <= 0) {
      toast.error(t("orders.noCostForMargin"));
      return;
    }
    // 100% would need an infinite price; below -500% is a typo, not an intent.
    const pct = Math.max(-500, Math.min(99, targetPct));
    const price = Math.round((item.unit_cost / (1 - pct / 100)) * 100) / 100;
    await saveItemField(item.id, { unitPrice: price });
  }

  // Agreeing a round number for the whole order. Every line's price moves by
  // the same proportion, so the mix of the order is preserved and the invoice
  // shows the difference as a discount per line.
  async function applySubtotalOverride(target: number) {
    setEditingSubtotal(false);
    const current = subtotal(items);
    if (!(target > 0) || current <= 0) return;
    if (Math.abs(target - current) < 0.005) return;
    const factor = target / current;
    if (
      !confirm(
        t("orders.subtotalOverrideConfirm", { target: formatAed(target) }) +
          (items.length === 1
            ? t("orders.subtotalOverrideDeltaOne", {
                direction: factor < 1 ? t("orders.aReduction") : t("orders.anIncrease"),
                pct: Math.abs(Math.round((1 - factor) * 1000) / 10),
                n: items.length,
              })
            : t("orders.subtotalOverrideDeltaMany", {
                direction: factor < 1 ? t("orders.aReduction") : t("orders.anIncrease"),
                pct: Math.abs(Math.round((1 - factor) * 1000) / 10),
                n: items.length,
              }))
      )
    )
      return;

    setBusy(true);
    try {
      for (const it of items) {
        const price = Math.round(it.unit_price * factor * 100) / 100;
        if (price === it.unit_price) continue;
        const res = await fetch("/api/orders/update-item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: it.id, unitPrice: price }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? t("orders.changeLineFailed"));
        }
      }
      await load();
      onChanged();
    } catch (e) {
      toast.error(friendlyError(e, t("orders.setSubtotalFailed")));
    } finally {
      setBusy(false);
    }
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
        throw new Error(data.error ?? t("orders.saveNoteFailed"));
      }
      setEditingManagerNote(false);
      load();
    } catch (e) {
      toast.error(friendlyError(e, t("orders.saveNoteFailed")));
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
      <Sheet open onClose={onClose} title={t("orders.orderTitle")}>
        <div className="text-secondary text-subhead py-10 text-center">{t("common.loading")}</div>
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
  // Once accepted the order is the warehouse's: a line that is not on the
  // shelf can come off it and a forgotten one can go on, by the warehouse or
  // a manager, until approval moves stock (add-item / remove-item routes,
  // same rule). Quantity and price edits keep the narrower canEditItems.
  const canRemoveItems =
    canEditItems ||
    (["waiting", "picking", "packed"].includes(order.status) && (isManager || isWarehouse));
  // A manager may delete any order; a salesman only their own, and only
  // while it is still theirs to change.
  const canDelete =
    isManager ||
    (order.salesman_id === user.id && ["draft", "pending"].includes(order.status));

  return (
    <>
    <Sheet
      open
      onClose={onClose}
      title={
        order.invoice_number
          ? t("orders.invoiceNumberTitle", { invoiceNumber: order.invoice_number })
          : t("orders.orderWithStatus", { status: order.status })
      }
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
                {t("orders.exportPdf")}
              </a>
              {isManager && (
                <a
                  href={`/api/orders/excel?orderId=${order.id}`}
                  className="px-3 py-1.5 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-accent hover:border-accent/50 transition-colors"
                >
                  {t("orders.exportExcel")}
                </a>
              )}
            </>
          )}
          {isManager && (
            <Button tier="tinted" onClick={() => setShowEditFields(true)} className="!px-3 !py-1.5 text-caption">
              {t("orders.editDetails")}
            </Button>
          )}
          {/* §Orders: an order can be deleted, and deleting it puts the
              stock back and takes it off the statement. It goes to the Trash
              rather than away, so nothing is lost by a mis-tap. */}
          {canDelete && (
            <Button
              tier="plain"
              disabled={busy}
              onClick={() => {
                const label = order.invoice_number
                  ? t("orders.invoiceLabel", { invoiceNumber: order.invoice_number })
                  : t("orders.thisOrder");
                if (!confirm(t("orders.deleteOrderConfirm", { label }))) {
                  return;
                }
                run(async () => {
                  const result = await deleteOrder(order.id);
                  const parts: string[] = [t("orders.movedToTrash")];
                  if (result.stockRestored)
                    parts.push(t("orders.backInStock", { n: result.stockRestored }));
                  if (result.paymentsReleased) {
                    parts.push(
                      result.paymentsReleased === 1
                        ? t("orders.paymentReleasedOne", { n: result.paymentsReleased })
                        : t("orders.paymentsReleasedMany", { n: result.paymentsReleased })
                    );
                  }
                  toast.success(parts.join(" "));
                  onClose();
                });
              }}
              className="!px-3 !py-1.5 text-caption text-[--status-danger]"
            >
              {t("common.delete")}
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
        {/* An order that was changed after it was sent says so, beside its
            status — same pill as an edited payment carries (§Payments:
            "shows as edited"). Absent until RUN-ME-19 has been run. */}
        {order.edited_at && (
          <span title={t("orders.editedAt", { date: new Date(order.edited_at).toLocaleString() })}>
            <Pill tone="warning">{t("orders.edited")}</Pill>
          </span>
        )}
        {order.status === "rejected" && purgeDays != null && (
          <Pill tone={purgeDays <= 5 ? "danger" : "warning"}>
            {purgeDays <= 0
              ? t("orders.purgingToday")
              : purgeDays === 1
                ? t("orders.purgeInDaysOne", { n: purgeDays })
                : t("orders.purgeInDaysMany", { n: purgeDays })}
          </Pill>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-subhead mb-5">
        <Field
          label={t("orders.customer")}
          value={order.customer?.name ?? order.new_customer_note ?? t("common.notSet")}
        />
        {order.salesman?.full_name && <Field label={t("orders.salesman")} value={order.salesman.full_name} />}
        {order.customer?.district && <Field label={t("orders.district")} value={order.customer.district} />}
        <Field label={t("orders.created")} value={new Date(order.created_at).toLocaleString()} />
      </div>

      {/* Role-routed notes (§Orders) — each channel only rendered for the
          roles it's actually relevant to: Manager sees all three, Warehouse
          only sees the Manager->Warehouse and their own Warehouse->Manager
          note, Salesman only sees Manager->Salesman and their own
          Salesman->Manager note. */}
      {order.warehouse_note && (isWarehouse || isManager) && (
        <div className="mb-3 p-3 rounded-card bg-canvas">
          <div className="text-caption text-secondary font-semibold mb-1">{t("orders.noteForWarehouse")}</div>
          <div className="text-subhead">{order.warehouse_note}</div>
        </div>
      )}
      {order.salesman_note && (isSalesman || isManager) && (
        <div className="mb-3 p-3 rounded-card bg-canvas">
          <div className="text-caption text-secondary font-semibold mb-1">{t("orders.noteForSalesman")}</div>
          <div className="text-subhead">{order.salesman_note}</div>
        </div>
      )}
      {order.manager_note && (isSalesman || isWarehouse || isManager) && (
        <div className="mb-3 p-3 rounded-card bg-canvas">
          <div className="text-caption text-secondary font-semibold mb-1">{t("orders.noteForManager")}</div>
          <div className="text-subhead">{order.manager_note}</div>
        </div>
      )}

      {isWarehouse && ["waiting", "picking", "packed"].includes(order.status) && (
        <div className="mb-5">
          {editingManagerNote ? (
            <div className="p-3 rounded-card bg-canvas">
              <Label>{t("orders.noteForManager")}</Label>
              <textarea
                autoFocus
                className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[64px]"
                value={managerNoteDraft}
                onChange={(e) => setManagerNoteDraft(e.target.value)}
              />
              <div className="flex gap-2 mt-2">
                <Button tier="plain" onClick={() => setEditingManagerNote(false)}>{t("common.cancel")}</Button>
                <Button tier="tinted" disabled={savingManagerNote} onClick={saveManagerNote}>
                  {savingManagerNote ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </div>
          ) : (
            <Button tier="plain" onClick={() => { setManagerNoteDraft(order.manager_note ?? ""); setEditingManagerNote(true); }}>
              {order.manager_note ? t("orders.editNoteForManager") : t("orders.addNoteForManager")}
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
                {s === "unpicked" ? t("orders.unpickedFirst") : s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button tier="tinted" onClick={selectAll}>{t("orders.selectAll")}</Button>
            <Button tier="plain" onClick={deselectAll}>{t("orders.deselectAll")}</Button>
          </div>
        </div>
      )}

      <div className="border border-hairline rounded-card overflow-hidden mb-4">
        <table className="w-full text-subhead">
          <thead>
            <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
              <th className="px-3 py-2.5 font-medium">{t("orders.headerItem")}</th>
              {(items.some((it) => it.product?.rack_location) ||
                ((isWarehouse || isManager) && ["waiting", "picking"].includes(order.status))) && (
                <th className="px-3 py-2.5 font-medium">{t("orders.headerRack")}</th>
              )}
              {(isWarehouse || isManager) && ["waiting", "picking"].includes(order.status) && (
                <th className="px-3 py-2.5 font-medium text-right">{t("orders.headerSoh")}</th>
              )}
              <th className="px-3 py-2.5 font-medium text-right">{t("orders.headerQty")}</th>
              <th className="px-3 py-2.5 font-medium text-right tabular-nums">{t("orders.headerPrice")}</th>
              {isManager && (
                <th className="px-3 py-2.5 font-medium text-right tabular-nums">{t("orders.headerDiscount")}</th>
              )}
              <th className="px-3 py-2.5 font-medium text-right tabular-nums">{t("common.total")}</th>
              {isManager && items.some((it) => it.unit_cost != null) && (
                <th className="px-3 py-2.5 font-medium text-right tabular-nums">{t("orders.gp")}</th>
              )}
              {canRemoveItems && <th className="px-3 py-2.5 font-medium"><span className="sr-only">{t("common.remove")}</span></th>}
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
                          {it.product?.rack_location || t("common.notSet")}
                          <Pencil size={11} />
                        </button>
                      ) : (
                        it.product?.rack_location || ""
                      )}
                    </td>
                  )}
                  {/* The shelf count, correctable right here. A mismatch is
                      found while picking, and making someone report it later
                      is how the figure stays wrong. */}
                  {canPick && (
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {editingStockId === it.id ? (
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          className="w-16 px-1.5 py-1 rounded-inner border border-hairline text-right tabular-nums"
                          value={stockDraft}
                          onChange={(e) => setStockDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && saveStock(it)}
                          onBlur={() => saveStock(it)}
                        />
                      ) : (
                        <button
                          className={`flex items-center gap-1 ms-auto hover:text-accent ${
                            (it.product?.stock_on_hand ?? 0) <= 0 ? "text-[--status-danger]" : "text-secondary"
                          }`}
                          title={t("orders.correctShelfCount")}
                          onClick={() => {
                            setStockDraft(String(it.product?.stock_on_hand ?? 0));
                            setEditingStockId(it.id);
                          }}
                        >
                          {it.product?.stock_on_hand ?? t("common.notSet")}
                          <Pencil size={11} />
                        </button>
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
                            title={t("orders.notYetSynced")}
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
                          className="flex items-center gap-1 hover:text-accent ms-auto"
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
                        <span className="line-through text-secondary me-1">{it.ordered_qty}</span>
                        {it.picked_qty}
                      </>
                    ) : (
                      effectiveQty(it)
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {/* A price is the manager's to change (2026-09-21); the
                        route refuses anyone else. */}
                    {canEditItems && isManager ? (
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
                          className="flex items-center gap-1 hover:text-accent ms-auto"
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
                  {isManager && (
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {(() => {
                        const listPrice = it.product?.price ?? 0;
                        const pct = lineDiscountPercent(listPrice, it.unit_price);
                        const label = pct > 0 ? `${pct}%` : t("common.notSet");
                        if (!canEditItems || listPrice <= 0) return <span className={pct > 0 ? "" : "text-secondary"}>{label}</span>;
                        const commit = () =>
                          saveItemField(it.id, { discountPercent: Math.min(100, Math.max(0, Number(discountDraft) || 0)) });
                        return editingDiscountId === it.id ? (
                          <input
                            autoFocus
                            type="number"
                            min={0}
                            max={100}
                            step="0.5"
                            aria-label={t("orders.discountForNamed", { name: it.description ?? it.sku })}
                            className="w-16 px-2 py-1 rounded-inner border border-hairline text-right tabular-nums"
                            value={discountDraft}
                            onChange={(e) => setDiscountDraft(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && commit()}
                            onBlur={commit}
                          />
                        ) : (
                          <button
                            className="flex items-center gap-1 hover:text-accent ms-auto"
                            title={t("orders.setLineDiscount", { price: formatAed(listPrice) })}
                            onClick={() => {
                              setDiscountDraft(pct > 0 ? String(pct) : "");
                              setEditingDiscountId(it.id);
                            }}
                          >
                            <span className={pct > 0 ? "" : "text-secondary"}>{label}</span>
                            <Pencil size={11} />
                          </button>
                        );
                      })()}
                    </td>
                  )}
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
                      {it.unit_cost == null ? (
                        t("common.notSet")
                      ) : canEditItems ? (
                        // Typing a margin here sets the price. Cost stays put.
                        editingGpId === it.id ? (
                          <input
                            autoFocus
                            type="number"
                            step="0.1"
                            max={99}
                            className="w-16 px-1.5 py-1 rounded-inner border border-hairline text-right tabular-nums"
                            value={gpDraft}
                            onChange={(e) => setGpDraft(e.target.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && saveLineGpPercent(it, Number(gpDraft))
                            }
                            onBlur={() => saveLineGpPercent(it, Number(gpDraft))}
                          />
                        ) : (
                          <button
                            className="flex items-center gap-1 hover:text-accent ms-auto"
                            title={t("orders.setPriceFromMargin")}
                            onClick={() => {
                              setGpDraft(lineGpPct.toFixed(1));
                              setEditingGpId(it.id);
                            }}
                          >
                            {formatAed(lineGp)} · {Math.round(lineGpPct)}%
                            <Pencil size={11} />
                          </button>
                        )
                      ) : (
                        `${formatAed(lineGp)} · ${Math.round(lineGpPct)}%`
                      )}
                    </td>
                  )}
                  {canRemoveItems && (
                    <td className="px-3 py-2.5 text-right">
                      <button
                        className="p-1.5 -m-1.5 text-secondary hover:text-[--status-danger] transition-colors"
                        title={t("orders.removeThisLine")}
                        aria-label={t("orders.removeNamed", { name: it.description ?? it.sku })}
                        onClick={() => {
                          tap();
                          removeItem(it);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* A forgotten article, added where the order is being read rather than
          by starting a second order. Same search, same debounce and same
          result row as the new-order sheet. */}
      {canRemoveItems && (
        <div className="mb-4">
          {!addingItem ? (
            <Button tier="plain" onClick={() => setAddingItem(true)} className="flex items-center gap-1.5">
              <Search size={15} /> {t("orders.addArticle")}
            </Button>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-secondary" />
                  <TextInput
                    autoFocus
                    className="ps-9"
                    placeholder={t("orders.articleSearchPlaceholder")}
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                  />
                </div>
                <Button
                  tier="plain"
                  onClick={() => {
                    setAddingItem(false);
                    setProductSearch("");
                    setProductResults([]);
                  }}
                >
                  {t("common.done")}
                </Button>
              </div>
              {productResults.length > 0 && (
                <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-48 overflow-y-auto">
                  {productResults.map((p) => (
                    <button
                      key={p.id}
                      disabled={busy}
                      className="w-full text-left px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0 flex justify-between disabled:opacity-40"
                      onClick={() => addItem(p)}
                    >
                      <span>
                        <span className="font-medium">{p.sku}</span> — {p.name}
                      </span>
                      <span className="tabular-nums text-secondary">{formatAed(p.price)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Before approval, orders.subtotal/vat_amount/total default to 0 (not
          null) — live-recompute from items (fallback VAT rate, §money.ts)
          whenever the stored total is still that unset 0. Once approved
          they're the authoritative billed amounts (real vat_rate from
          app_settings), so prefer those over recomputing. */}
      <div className="ms-auto w-full max-w-[260px] space-y-1.5 text-subhead">
        {isManager && canEditItems ? (
          <div className="flex justify-between items-center text-secondary">
            <span>{t("orders.subtotal")}</span>
            {editingSubtotal ? (
              <input
                autoFocus
                type="number"
                min={0}
                step="0.01"
                className="w-24 px-2 py-1 rounded-inner border border-hairline text-right tabular-nums"
                value={subtotalDraft}
                onChange={(e) => setSubtotalDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applySubtotalOverride(Number(subtotalDraft))}
                onBlur={() => applySubtotalOverride(Number(subtotalDraft))}
              />
            ) : (
              <button
                className="tabular-nums flex items-center gap-1 hover:text-accent"
                title={t("orders.setSubtotalHint")}
                onClick={() => {
                  setSubtotalDraft(subtotal(items).toFixed(2));
                  setEditingSubtotal(true);
                }}
              >
                {formatAed(order.subtotal || subtotal(items))}
                <Pencil size={11} />
              </button>
            )}
          </div>
        ) : (
          <Row label={t("orders.subtotal")} value={formatAed(order.subtotal || subtotal(items))} />
        )}
        <Row label={t("orders.vat")} value={formatAed(order.vat_amount || vat(items))} />
        <Row label={t("common.total")} value={formatAed(order.total || total(items))} bold />
        {isManager && items.some((it) => it.unit_cost != null) && (
          <Row
            label={t("orders.grossProfit")}
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
// <input type="date"> speaks YYYY-MM-DD in the viewer's own timezone.
function localDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The picked day at the order's original time of day, as UTC ISO — so two
// orders billed the same day keep the order they were billed in.
function moveToDate(originalIso: string | null | undefined, day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const at = originalIso ? new Date(originalIso) : new Date();
  const moved = new Date(at);
  moved.setFullYear(y, m - 1, d);
  return moved.toISOString();
}

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
  const [salesmen, setSalesmen] = useState<Seller[]>([]);
  const [salesmanId, setSalesmanId] = useState(order.salesman_id ?? "");
  const [saving, setSaving] = useState(false);
  // The billing date — the date this order counts on in sales, aging and
  // statements, and the date printed on its invoice. Editable only once
  // RUN-ME-27 has added the column; until then it is shown and disabled,
  // like the PO number before its migration.
  const billedAtOriginal = order.billed_at ?? order.updated_at;
  const [billedOn, setBilledOn] = useState(localDateInput(billedAtOriginal));
  const [billedSupported, setBilledSupported] = useState(false);

  useEffect(() => {
    const supabase = supabaseBrowser();
    fetchSalesmen(supabase).then(setSalesmen);
    billingDateColumn(supabase).then((col) => setBilledSupported(col === "billed_at"));
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
          ...(salesmanId ? { salesman_id: salesmanId } : {}),
          ...(poSupported ? { po_number: poNumber.trim() || null } : {}),
          // Sent only when it was actually changed: writing it at all marks
          // the date as set by hand, which stops status changes moving it.
          ...(billedSupported && billedOn && billedOn !== localDateInput(billedAtOriginal)
            ? { billed_at: moveToDate(billedAtOriginal, billedOn) }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("orders.saveFailed"));
      // Sales and aging are cached, and both are bucketed by this date.
      invalidateOrderFacts();
      invalidateAging();
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e, t("orders.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("orders.editOrderDetails")}
      footer={
        <>
          <Button tier="plain" onClick={onClose}>{t("common.cancel")}</Button>
          <Button tier="primary" disabled={saving} onClick={save}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <Label>{t("orders.invoiceNumber")}</Label>
      <TextInput value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />

      <Label>
        {t("orders.poNumber")}
        {!poSupported && t("orders.notAvailableYet")}
      </Label>
      <TextInput value={poNumber} onChange={(e) => setPoNumber(e.target.value)} disabled={!poSupported} />

      <Label>
        {t("orders.billingDate")}
        {!billedSupported && t("orders.notAvailableYet")}
      </Label>
      <TextInput
        type="date"
        className="tabular-nums"
        value={billedOn}
        onChange={(e) => setBilledOn(e.target.value)}
        disabled={!billedSupported}
      />
      <p className="text-caption text-secondary mt-1">{t("orders.billingDateHint")}</p>

      <Label>{t("orders.customer")}</Label>
      {customerId && !customerSearch ? (
        <div className="flex items-center justify-between p-3 rounded-card bg-canvas">
          <span className="text-subhead">{customerName}</span>
          <button
            className="text-caption text-accent font-medium"
            onClick={() => { setCustomerId(""); setCustomerName(""); }}
          >
            {t("orders.change")}
          </button>
        </div>
      ) : (
        <>
          <TextInput placeholder={t("orders.searchCustomers")} value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
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

      {/* An order always names whoever billed it — there is no "none" any
          more, and the server refuses one. Someone who has since left the
          roster still appears here while they are on this order, so saving
          the sheet cannot quietly reassign the sale to the first name in
          the list. */}
      <Label>{t("orders.salesman")}</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
        value={salesmanId}
        onChange={(e) => setSalesmanId(e.target.value)}
      >
        {!salesmanId && <option value="">{t("orders.chooseOption")}</option>}
        {order.salesman && !salesmen.some((s) => s.id === order.salesman!.id) && (
          <option value={order.salesman.id}>{order.salesman.full_name}</option>
        )}
        {salesmen.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.role === "salesman" ? "" : ` (${s.role})`}
          </option>
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
      toast.error(friendlyError(e, t("orders.requestExtensionFailed")));
    } finally {
      setSaving(false);
    }
  }

  if (sent) {
    return (
      <div className="mt-4 text-caption text-secondary flex items-center gap-1.5">
        <Clock size={13} /> {t("orders.extensionRequested")}
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
          <Clock size={13} /> {t("orders.requestPaymentExtension")}
        </button>
      ) : (
        <div className="p-3 rounded-card bg-canvas">
          <TextInput
            placeholder={t("orders.extensionReason")}
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
            <Button tier="plain" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button tier="primary" disabled={saving || !reason.trim() || !dueDate} onClick={submit}>
              {saving ? t("orders.sending") : t("orders.submitRequest")}
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
  // Undoing an approval puts stock back and un-bills an invoice, so it asks
  // first — the same two-step the reject button uses.
  const [confirmUnapprove, setConfirmUnapprove] = useState(false);
  const approvals = useApprovalSettings();

  // One approval call for every Approve button below. The server cuts any
  // line to what the shelf holds; when it has, the approver is told which
  // SKUs and by how much, because the invoice now says less than the
  // customer asked for and somebody has to know that.
  async function approve() {
    const res = await fetch("/api/orders/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? t("orders.approvalFailed"));
    const capped = (data.capped ?? []) as { sku: string; from: number; to: number }[];
    if (capped.length > 0) {
      toast.info(
        t("orders.approvedCutToShelf") +
          capped.map((c) => `${c.sku} ${c.from} → ${c.to}`).join(", ")
      );
    }
  }

  // Takes an approved order back to packed: the stock goes back on the shelf
  // and the billed figures are cleared. The invoice number stays with the
  // order, so approving it again does not consume a second one.
  async function unapprove() {
    const res = await fetch("/api/orders/unapprove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? t("orders.undoApprovalFailed"));
    setConfirmUnapprove(false);
    const parts = [t("orders.backToPacked")];
    if (data.stockRestored) parts.push(t("orders.backInStock", { n: data.stockRestored }));
    if (data.invoiceNumber)
      parts.push(t("orders.invoiceKept", { invoiceNumber: data.invoiceNumber }));
    toast.info(parts.join(" "));
  }

  // A packed order back into picking so it can be reworked (the phone's
  // "reopen for repack"). Nothing has been billed or deducted yet at packed.
  async function reopen() {
    const res = await fetch("/api/orders/reopen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: order.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? t("orders.reopenFailed"));
  }

  if (order.status === "draft" && isSalesman) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => sendDraft(supabase, order.id, user.id))}>
        {t("orders.sendOrder")}
      </Button>
    );
  }

  if (order.status === "pending" && isManager) {
    if (confirmReject) {
      return (
        <>
          <Button tier="plain" onClick={() => setConfirmReject(false)}>{t("orders.neverMind")}</Button>
          <Button
            tier="danger"
            disabled={busy}
            onClick={() => run(() => rejectOrder(supabase, order.id, user.id))}
          >
            {t("orders.confirmReject")}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button tier="plain" disabled={busy} onClick={() => setConfirmReject(true)} className="flex items-center gap-1.5">
          <X size={15} /> {t("orders.reject")}
        </Button>
        <Button
          tier="primary"
          disabled={busy}
          onClick={() => run(() => acceptOrder(supabase, order.id, user.id))}
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> {t("orders.accept")}
        </Button>
      </>
    );
  }

  if (order.status === "rejected" && (isSalesman || isManager)) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => resubmitOrder(supabase, order.id, user.id))}>
        {t("orders.resubmit")}
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
            if (confirm(t("orders.cancelThisOrderConfirm"))) run(() => cancelOrder(supabase, order.id, user.id));
          }}
          className="flex items-center gap-1.5 text-[--status-danger]"
        >
          <Ban size={15} /> {t("common.cancel")}
        </Button>
        <Button tier="tinted" disabled={busy} onClick={() => run(() => startPicking(supabase, order.id, user.id))} className="flex items-center gap-1.5">
          <Package size={15} /> {t("orders.startPicking")}
        </Button>
        <Button
          tier="primary"
          disabled={busy}
          onClick={() =>
            run(approve)
          }
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> {t("orders.approveNowSkipPicking")}
        </Button>
      </>
    );
  }

  if (order.status === "waiting" && isWarehouse) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => startPicking(supabase, order.id, user.id))} className="flex items-center gap-1.5">
        <Package size={15} /> {t("orders.startPicking")}
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
            if (confirm(t("orders.cancelThisOrderConfirm"))) run(() => cancelOrder(supabase, order.id, user.id));
          }}
          className="flex items-center gap-1.5 text-[--status-danger]"
        >
          <Ban size={15} /> {t("common.cancel")}
        </Button>
        <Button tier="tinted" disabled={busy} onClick={() => run(() => markPacked(supabase, order.id, user.id, user.full_name))} className="flex items-center gap-1.5">
          <Check size={15} /> {t("orders.markPacked")}
        </Button>
        <Button
          tier="primary"
          disabled={busy}
          onClick={() =>
            run(approve)
          }
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> {t("orders.approveNowSkipPicking")}
        </Button>
      </>
    );
  }

  if (order.status === "picking" && isWarehouse) {
    return (
      <Button tier="primary" disabled={busy} onClick={() => run(() => markPacked(supabase, order.id, user.id, user.full_name))} className="flex items-center gap-1.5">
        <Check size={15} /> {t("orders.markPacked")}
      </Button>
    );
  }

  // Packed is the warehouse's own handover point, so the warehouse can take
  // it back — a box found wrong is found by the person who packed it.
  if (order.status === "packed" && (isWarehouse || isManager)) {
    return (
      <>
        <Button
          tier="plain"
          disabled={busy}
          onClick={() => run(reopen)}
          className="flex items-center gap-1.5"
        >
          <RotateCcw size={15} /> {t("orders.reopenForRepacking")}
        </Button>
        {isManager && (
          <Button
            tier="primary"
            disabled={busy}
            onClick={() =>
              run(approve)
            }
          >
            {t("orders.approve")}
          </Button>
        )}
      </>
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
            if (confirm(t("orders.cancelThisOrderConfirm"))) run(() => cancelOrder(supabase, order.id, user.id));
          }}
          className="flex items-center gap-1.5 text-[--status-danger]"
        >
          <Ban size={15} /> {t("orders.cancelOrder")}
        </Button>
        <Button
          tier="tinted"
          disabled={busy}
          onClick={() =>
            run(approve)
          }
          className="flex items-center gap-1.5"
        >
          <Check size={15} /> {t("orders.approveNowSkipPicking")}
        </Button>
      </>
    );
  }

  if (order.status === "approved" && (isWarehouse || isManager)) {
    if (confirmUnapprove) {
      return (
        <>
          <Button tier="plain" onClick={() => setConfirmUnapprove(false)}>{t("orders.neverMind")}</Button>
          <Button tier="danger" disabled={busy} onClick={() => run(unapprove)}>
            {t("orders.confirmUndoApproval")}
          </Button>
        </>
      );
    }
    return (
      <>
        {isManager && (
          <Button
            tier="plain"
            disabled={busy}
            onClick={() => setConfirmUnapprove(true)}
            className="flex items-center gap-1.5 text-[--status-danger]"
            title={t("orders.undoApprovalHint")}
          >
            <Undo2 size={15} /> {t("orders.undoApproval")}
          </Button>
        )}
        {isWarehouse && (
          <Button
            tier="plain"
            disabled={busy}
            onClick={() =>
              run(async () => {
                // Where the admin has switched this request off, the warehouse
                // reopens the order itself. Otherwise it goes to the managers,
                // who are told by requestEdit.
                if (approvals.orderEdits) await requestEdit(supabase, order.id, user.id);
                else await reopenOrderWithoutApproval(supabase, order.id);
              })
            }
            className="flex items-center gap-1.5"
          >
            <FileEdit size={15} /> {approvals.orderEdits ? t("orders.requestEdit") : t("orders.reopenForEdit")}
          </Button>
        )}
        <Button
          tier="primary"
          disabled={busy}
          onClick={() => run(() => startDelivering(supabase, order.id, user.id))}
          className="flex items-center gap-1.5"
        >
          <Truck size={15} /> {t("orders.sendForDelivery")}
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
          {t("orders.deny")}
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
              if (!res.ok) throw new Error(data.error ?? t("orders.failed"));
            })
          }
        >
          {t("orders.grantEdit")}
        </Button>
      </>
    );
  }

  if (order.status === "delivering" && (isWarehouse || isManager)) {
    return (
      <label className="px-4 py-2.5 rounded-card text-subhead transition-all bg-accent text-white font-semibold hover:bg-accent-strong active:scale-[0.97] cursor-pointer flex items-center gap-1.5">
        <Truck size={15} /> {busy ? t("orders.confirming") : t("orders.confirmDelivered")}
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
              if (!res.ok) throw new Error(data.error ?? t("orders.confirmDeliveryFailed"));
            });
          }}
        />
      </label>
    );
  }

  return null;
}
