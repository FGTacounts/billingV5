"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useState, useEffect, useCallback, useRef } from "react";
import { springEnter } from "@/lib/motion";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Plus, Minus, Trash2, AlertTriangle, Image as ImageIcon } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchProducts } from "@/lib/queries/products";
import { customerCondition } from "@/lib/queries/aging";
import type { AppUser, Customer, Product, CustomerDiscount } from "@/lib/types/db";
import { applyDiscount } from "@/lib/money";
import { formatAed } from "@/lib/money";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { Label, TextInput, Recommended } from "@/components/ui/Field";
import BarcodeScanButton from "@/components/ui/BarcodeScanButton";
import LogPaymentSheet from "@/components/payments/LogPaymentSheet";
import ImportOrderLinesButton, { type ImportedLine } from "./ImportOrderLinesButton";
import ScanOrderButton, { type ScannedOrderLine } from "./ScanOrderButton";

interface Line {
  product: Product;
  qty: number;
  price: number;
  recommendedReason: "sticky_price" | "discount" | null;
}

export default function NewOrderSheet({
  user,
  onClose,
  onCreated,
  initialProducts,
}: {
  user: AppUser;
  onClose: () => void;
  onCreated: () => void;
  // Products chosen on the Products screen before the order was opened, so
  // picking happens where the photos and prices are rather than in a search
  // box inside this sheet.
  initialProducts?: Product[];
}) {
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newCustomerNote, setNewCustomerNote] = useState("");
  const [useNewCustomer, setUseNewCustomer] = useState(false);

  // The article search is always available rather than hidden behind a
  // button — typing an article is the main thing this screen is for.
  const [addingProduct, setAddingProduct] = useState(true);
  const [showPhotoPicker, setShowPhotoPicker] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  // §Orders: role-routed notes. A Manager picks who the note goes to
  // (Warehouse or Salesman); anyone else creating an order is a Salesman,
  // whose note always goes to the Manager only.
  const [noteText, setNoteText] = useState("");
  const [noteRecipient, setNoteRecipient] = useState<"warehouse" | "salesman">("warehouse");

  const [customerDiscount, setCustomerDiscount] = useState<CustomerDiscount | null>(null);
  // Order-total discount (Manager-only, §3A) — "100% = no discount" is the
  // convention the spec asks for in the UI, converted to/from the existing
  // customer_discounts "% off" convention (discount_value=5 means 5% off)
  // that applyDiscount() and every other reader of this table already use.
  const [orderDiscountPct, setOrderDiscountPct] = useState(100);
  const isManager = (user.role === "manager" || user.role === "admin");

  const [holdWarning, setHoldWarning] = useState<{ condition: string; oldestDays: number } | null>(null);
  const [holdReason, setHoldReason] = useState<string | null>(null);
  // "Continue to payment" (§Next Updates: overdue-customer pop-up) — jumps
  // into the payment-collection flow for this customer without leaving the
  // order in progress; the order sheet is still here underneath once
  // they're done.
  const [collectingPayment, setCollectingPayment] = useState(false);

  const [saving, setSaving] = useState(false);
  // §Orders: "if a user accidentally exits while taking an order, prompt to
  // confirm exit or save as draft (only if products were added)" — an empty
  // cart has nothing worth losing, so it closes immediately like before.
  const [confirmExit, setConfirmExit] = useState(false);

  useEffect(() => {
    if (!customerSearch) { setCustomerResults([]); return; }
    const t = setTimeout(async () => {
      const supabase = supabaseBrowser();
      setCustomerResults(await fetchCustomers(supabase, { search: customerSearch }));
    }, 200);
    return () => clearTimeout(t);
  }, [customerSearch]);

  useEffect(() => {
    if (!addingProduct) return;
    const t = setTimeout(async () => {
      const supabase = supabaseBrowser();
      setProductResults(await fetchProducts(supabase, { search: productSearch || undefined }));
    }, 200);
    return () => clearTimeout(t);
  }, [productSearch, addingProduct]);

  const selectCustomer = useCallback(async (c: Customer) => {
    setCustomer(c);
    setCustomerSearch("");
    setCustomerResults([]);
    setHoldWarning(null);
    setHoldReason(null);
    const supabase = supabaseBrowser();
    // customer_discounts is currently missing from the live schema
    // (confirmed via PostgREST introspection) — remembered order-total
    // discounts can't persist until it exists again. Degrades to "no
    // remembered discount" rather than breaking customer selection.
    const [{ condition, oldestDays }, discountResult] = await Promise.all([
      customerCondition(supabase, c.id),
      supabase
        .from("customer_discounts")
        .select("customer_id, discount_type, discount_value, updated_at")
        .eq("customer_id", c.id)
        .maybeSingle(),
    ]);
    if (condition === "bad" || oldestDays > c.overdue_threshold_days) {
      setHoldWarning({ condition, oldestDays });
    }
    const cd = discountResult.error ? null : (discountResult.data as CustomerDiscount) ?? null;
    setCustomerDiscount(cd);
    setOrderDiscountPct(cd && cd.discount_type === "percent" ? 100 - cd.discount_value : 100);
  }, []);

  // Manager-only (§3A): re-derives every current line's price from its
  // catalog price × pct/100 — a fresh recompute, not a compounding
  // multiply, so re-entering the same pct twice is idempotent. Would
  // persist to customer_discounts to remember as "last time" for next
  // order, but that table doesn't exist in the live schema right now — the
  // discount still applies to this order, it just won't be remembered.
  async function applyOrderDiscount(pct: number) {
    setOrderDiscountPct(pct);
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        price: l.product.price * (pct / 100),
        recommendedReason: pct === 100 ? l.recommendedReason : "discount",
      }))
    );
    if (!customer) return;
    const supabase = supabaseBrowser();
    try {
      const { error } = await supabase
        .from("customer_discounts")
        .upsert(
          { customer_id: customer.id, discount_type: "percent", discount_value: 100 - pct, updated_at: new Date().toISOString() },
          { onConflict: "customer_id" }
        );
      if (error) throw error;
      setCustomerDiscount({ customer_id: customer.id, discount_type: "percent", discount_value: 100 - pct, updated_at: new Date().toISOString() });
    } catch {
      // Table doesn't exist yet — the discount is still applied locally to
      // this order, it just won't be remembered for next time.
    }
  }

  // "Use [Customer]'s last prices" (§3B) — re-applies remembered per-item
  // sticky prices (customer_prices), falling back to the remembered
  // order-total discount, across every line currently in the order. Same
  // lookup addProduct() does automatically for a newly-added line, just
  // run manually across the whole cart at once (e.g. for lines added
  // before the customer was picked, or to undo a manual override).
  async function useLastPrices() {
    if (!customer || lines.length === 0) return;
    const supabase = supabaseBrowser();
    const { data: stickyPrices } = await supabase
      .from("customer_prices")
      .select("product_id, price")
      .eq("customer_id", customer.id)
      .in("product_id", lines.map((l) => l.product.id));
    const priceByProduct = new Map((stickyPrices ?? []).map((p) => [p.product_id, p.price]));
    setLines((prev) =>
      prev.map((l) => {
        const sticky = priceByProduct.get(l.product.id);
        if (sticky != null) return { ...l, price: sticky, recommendedReason: "sticky_price" as const };
        if (customerDiscount) return { ...l, price: applyDiscount(l.product.price, customerDiscount), recommendedReason: "discount" as const };
        return l;
      })
    );
  }

  // Bulk SKU/Qty import (§Orders). Same sticky-price / customer-discount
  // resolution addProduct() does per line, but with one batched
  // customer_prices lookup instead of one request per imported row.
  // Seeded once, on open. Reuses the import path so a pre-picked product gets
  // the same sticky customer price and default quantity as any other line.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !initialProducts || initialProducts.length === 0) return;
    seeded.current = true;
    addImportedLines(initialProducts.map((product) => ({ product, qty: product.default_qty || 1 })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProducts]);

  async function addImportedLines(imported: ImportedLine[]) {
    const priceByProduct = new Map<string, number>();
    if (customer) {
      const { data } = await supabaseBrowser()
        .from("customer_prices")
        .select("product_id, price")
        .eq("customer_id", customer.id)
        .in("product_id", imported.map((l) => l.product.id));
      for (const row of data ?? []) priceByProduct.set(row.product_id, row.price);
    }

    setLines((prev) => {
      const next = [...prev];
      for (const { product, qty, price: stated } of imported) {
        const existing = next.findIndex((l) => l.product.id === product.id);
        if (existing !== -1) {
          next[existing] = {
            ...next[existing],
            qty: next[existing].qty + qty,
            ...(stated != null ? { price: stated } : {}),
          };
          continue;
        }
        const sticky = priceByProduct.get(product.id);
        let price = product.price;
        let recommendedReason: Line["recommendedReason"] = null;
        if (stated != null) {
          // A price written on the document that was imported or scanned is
          // what was agreed with the customer, so it wins over the price we
          // would otherwise remember for them.
          price = stated;
        } else if (sticky != null) {
          price = sticky;
          recommendedReason = "sticky_price";
        } else if (customerDiscount) {
          price = applyDiscount(product.price, customerDiscount);
          recommendedReason = "discount";
        }
        next.push({ product, qty, price, recommendedReason });
      }
      return next;
    });
  }

  // Lines read off a photographed order pad or invoice. They arrive already
  // matched to real products by /api/scan-order, so they go in through the
  // same path as an import — which means sticky pricing and the customer's
  // discount still apply to any line the paper didn't put a price on.
  async function addScannedLines(scanned: ScannedOrderLine[], scannedCustomer: string | null) {
    const supabase = supabaseBrowser();
    const ids = scanned.map((l) => l.productId).filter((id): id is string => !!id);
    if (ids.length === 0) return;
    const all = await fetchProducts(supabase);
    const byId = new Map(all.map((p) => [p.id, p]));
    const lines: ImportedLine[] = scanned.flatMap((l) => {
      const product = l.productId ? byId.get(l.productId) : undefined;
      if (!product) return [];
      return [{ product, qty: l.quantity, ...(l.scannedPrice != null ? { price: l.scannedPrice } : {}) }];
    });
    await addImportedLines(lines);

    // The customer is only ever a suggestion — the scan reads a shop name off
    // a piece of paper, and picking the wrong account here would put the
    // order on someone else's statement. Offer it, never apply it.
    if (scannedCustomer && !customer && !useNewCustomer) {
      setCustomerSearch(scannedCustomer);
    }
  }

  async function addProduct(p: Product) {
    const supabase = supabaseBrowser();
    let price = p.price;
    let recommendedReason: Line["recommendedReason"] = null;
    if (customer) {
      const { data: cp } = await supabase
        .from("customer_prices")
        .select("price")
        .eq("customer_id", customer.id)
        .eq("product_id", p.id)
        .maybeSingle();
      if (cp?.price != null) {
        price = cp.price;
        recommendedReason = "sticky_price";
      } else if (customerDiscount) {
        price = applyDiscount(p.price, customerDiscount);
        recommendedReason = "discount";
      }
    }
    setLines((prev) => {
      const existing = prev.find((l) => l.product.id === p.id);
      if (existing) {
        return prev.map((l) =>
          l.product.id === p.id ? { ...l, qty: l.qty + (p.default_qty || 1) } : l
        );
      }
      return [...prev, { product: p, qty: p.default_qty || 1, price, recommendedReason }];
    });
    setProductSearch("");
    setProductResults([]);
    // Deliberately not closing the search row: an order is usually several
    // lines, and closing it after each one meant pressing + again before you
    // could type the next article.
    setShowPhotoPicker(false);
  }

  function updateQty(productId: string, qty: number) {
    setLines((prev) =>
      prev
        .map((l) => (l.product.id === productId ? { ...l, qty: Math.max(0, qty) } : l))
        .filter((l) => l.qty > 0)
    );
  }

  // Typing into the qty input (as opposed to the +/- steppers, which always
  // land on a deliberate final value) shouldn't drop the row the instant the
  // field is momentarily empty/0 mid-edit — only the steppers and blur do
  // the zero-removes-row cleanup.
  function setLineQtyRaw(productId: string, qty: number) {
    setLines((prev) => prev.map((l) => (l.product.id === productId ? { ...l, qty: Math.max(0, qty) } : l)));
  }
  function commitQty(productId: string) {
    setLines((prev) => prev.filter((l) => l.product.id !== productId || l.qty > 0));
  }

  // Per-product price override (§Orders: "option to change individual item
  // price") — the customer's last-billed price already seeds `line.price`
  // via useLastPrices/recommendedReason, this just lets it be edited too.
  function updatePrice(productId: string, price: number) {
    setLines((prev) =>
      prev.map((l) => (l.product.id === productId ? { ...l, price: Math.max(0, price), recommendedReason: null } : l))
    );
  }

  function removeLine(productId: string) {
    setLines((prev) => prev.filter((l) => l.product.id !== productId));
  }

  // Arrow-key navigation across the line-item grid (§Orders: "arrow-key
  // navigation between columns of an order") — cellRefs[row][col], col 0 =
  // Price input, col 1 = Qty input (their visual left-to-right order).
  // Up/Down move within a column across rows; Left/Right move within a row
  // across columns. type="number" inputs don't support the selection APIs
  // (selectionStart is always null), so unlike a text field there's no
  // "cursor at the edge" to detect — every arrow press just navigates,
  // spreadsheet-style, which is also what was actually asked for here.
  const cellRefs = useRef<(HTMLInputElement | null)[][]>([]);
  function handleCellKeyDown(e: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) {
    const grid = cellRefs.current;
    let target: HTMLInputElement | null | undefined;
    if (e.key === "ArrowDown") target = grid[row + 1]?.[col];
    else if (e.key === "ArrowUp") target = grid[row - 1]?.[col];
    else if (e.key === "ArrowRight") target = grid[row]?.[col + 1];
    else if (e.key === "ArrowLeft") target = grid[row]?.[col - 1];
    if (target) {
      e.preventDefault();
      target.focus();
      target.select();
    }
  }

  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const vat = subtotal * 0.05;
  const total = subtotal + vat;
  // The mockup's totals block shows Subtotal *before* discount and then the
  // discount on its own line, so it has to be reconstructed from each line's
  // list price rather than reusing the discounted subtotal above.
  const grossSubtotal = lines.reduce((s, l) => s + l.product.price * l.qty, 0);
  const discountTotal = Math.max(0, grossSubtotal - subtotal);
  // Mockup prints amounts as "720 AED" (suffix), not "AED 720".
  const aedSuffix = (n: number) =>
    `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AED`;
  // GP needs unit_cost, which is null on a non-Manager session (masked at
  // the query layer) — only computable/shown for a Manager.
  const gp = isManager ? lines.reduce((s, l) => s + (l.price - (l.product.cost ?? 0)) * l.qty, 0) : null;
  const gpPct = gp !== null && subtotal > 0 ? Math.round((gp / subtotal) * 100) : null;
  const canSave = (customer || (useNewCustomer && newCustomerNote.trim())) && lines.length > 0;

  async function save(status: "draft" | "pending") {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch("/api/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: customer?.id ?? null,
          new_customer_note: useNewCustomer ? newCustomerNote.trim() : null,
          warehouse_note: isManager && noteRecipient === "warehouse" ? noteText.trim() || null : null,
          salesman_note: isManager && noteRecipient === "salesman" ? noteText.trim() || null : null,
          manager_note: !isManager ? noteText.trim() || null : null,
          status,
          hold_reason: holdReason,
          lines: lines.map((line) => ({
            product_id: line.product.id,
            sku: line.product.sku,
            description: line.product.name,
            unit_price: line.price,
            ordered_qty: line.qty,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save order");
      onCreated();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to save order"));
    } finally {
      setSaving(false);
    }
  }

  // Mockup prints the date as "20 AUG 2025" — short, uppercase.
  const today = new Date()
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
  const roleLabel = isManager ? "Manager" : user.role === "warehouse" ? "Warehouse" : "Salesman";

  function attemptClose() {
    if (lines.length > 0) setConfirmExit(true);
    else onClose();
  }

  return (
    <>
      <Sheet
        open
        onClose={attemptClose}
        title="New order"
        footer={
          <>
            <Button tier="plain" disabled={saving} onClick={() => save("draft")}>
              Save draft
            </Button>
            <Button tier="primary" disabled={saving || !canSave} onClick={() => save("pending")}>
              {saving ? "Sending…" : "Send order"}
            </Button>
          </>
        }
      >
        {/* Header (§Orders "New order" mockup): a small role/Date caption
            sitting above each bold value, not a single inline line. */}
        <div className="flex items-end justify-between mb-4 rounded-card bg-canvas px-4 py-3">
          <div>
            <div className="text-caption text-secondary leading-none mb-1">{roleLabel}</div>
            <div className="text-title font-bold leading-none">{user.full_name}</div>
          </div>
          <div className="text-right">
            <div className="text-caption text-secondary leading-none mb-1">Date</div>
            <div className="text-title font-bold leading-none tabular-nums">{today}</div>
          </div>
        </div>

        {/* CUSTOMER header — uppercase label with the green add-customer
            button on the right, as in the mockup. */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-caption text-secondary font-semibold uppercase tracking-wide">Customer</span>
          {!customer && !useNewCustomer && (
            <button
              onClick={() => setUseNewCustomer(true)}
              className="w-7 h-7 rounded-full bg-accent text-white grid place-items-center shrink-0"
              aria-label="New customer"
              title="New customer"
            >
              <Plus size={15} />
            </button>
          )}
        </div>
        {!customer && !useNewCustomer && (
          <>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
              <TextInput
                className="pl-9"
                placeholder="Search customers"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
              />
            </div>
            {customerResults.length > 0 && (
              <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-48 overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0"
                    onClick={() => selectCustomer(c)}
                  >
                    <div className="font-medium">{c.name}</div>
                    <div className="text-caption text-secondary">{c.code} · {c.district}</div>
                  </button>
                ))}
              </div>
            )}
            <button
              className="flex items-center gap-1 text-caption text-accent font-medium mt-2"
              onClick={() => setUseNewCustomer(true)}
            >
              <Plus size={13} /> New customer{!isManager && " (requires Manager approval)"}
            </button>
          </>
        )}

        {customer && (
          <div className="flex items-center justify-between p-3 rounded-card bg-canvas mb-1">
            <div>
              <div className="font-medium text-subhead">{customer.name}</div>
              <div className="text-caption text-secondary">{customer.code} · {customer.district}</div>
            </div>
            <button className="text-caption text-accent font-medium" onClick={() => setCustomer(null)}>
              Change
            </button>
          </div>
        )}

        {customer && lines.length > 0 && (
          <button
            onClick={useLastPrices}
            className="w-full text-left px-3 py-2 mb-1 rounded-card bg-accent/8 text-accent text-caption font-semibold"
          >
            Use {customer.name}&rsquo;s last prices
          </button>
        )}

        {isManager && customer && (
          <div>
            <Label>Order discount</Label>
            <div className="flex items-center gap-2">
              <TextInput
                type="number"
                className="max-w-[90px]"
                value={orderDiscountPct}
                onChange={(e) => setOrderDiscountPct(Number(e.target.value))}
                onBlur={(e) => applyOrderDiscount(Math.max(0, Math.min(100, Number(e.target.value) || 100)))}
              />
              <span className="text-caption text-secondary">% (100% = no discount)</span>
            </div>
          </div>
        )}

        {useNewCustomer && !customer && (
          <div>
            <Label>
              {isManager
                ? "New customer name (placeholder — create the real record afterward)"
                : "New customer name (placeholder — Manager will create the real record)"}
            </Label>
            <div className="flex gap-2">
              <TextInput value={newCustomerNote} onChange={(e) => setNewCustomerNote(e.target.value)} />
              <button className="text-caption text-secondary" onClick={() => setUseNewCustomer(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {holdReason && !holdWarning && (
          <div className="mt-3 p-3 rounded-card bg-canvas text-caption text-secondary">
            Note for manager: <span className="text-primary">{holdReason}</span>
          </div>
        )}

        <div className="flex items-center justify-between mt-4 mb-1.5 gap-3 flex-wrap">
          <Label>Items</Label>
          <div className="flex items-center gap-3">
            <ImportOrderLinesButton onImported={addImportedLines} />
            <ScanOrderButton onLines={addScannedLines} />
            <button
              onClick={() => setAddingProduct((v) => !v)}
              className="w-7 h-7 rounded-full border border-hairline grid place-items-center text-secondary hover:text-accent hover:border-accent/50"
              aria-label="Add product"
              title="Add product"
            >
              <Plus size={15} />
            </button>
            <button
              onClick={() => setShowPhotoPicker(true)}
              className="w-7 h-7 rounded-full border border-hairline grid place-items-center text-secondary hover:text-accent hover:border-accent/50"
              aria-label="Pick product from photos"
              title="Pick from photos"
            >
              <ImageIcon size={14} />
            </button>
          </div>
        </div>

        {addingProduct && (
          <div className="mb-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
                <TextInput
                  autoFocus
                  className="pl-9"
                  placeholder="Article, type, brand, description…"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                />
              </div>
              <BarcodeScanButton onScan={(value) => setProductSearch(value)} />
            </div>
            {productResults.length > 0 && (
              <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-48 overflow-y-auto">
                {productResults.map((p) => (
                  <button
                    key={p.id}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0 flex justify-between"
                    onClick={() => addProduct(p)}
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

        {lines.length === 0 ? (
          <p className="text-caption text-secondary py-2">No items yet — search for an article above.</p>
        ) : (
          <div className="border border-hairline rounded-card overflow-x-auto">
            <table className="w-full text-subhead min-w-[480px]">
              <thead>
                <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
                  <th className="px-2.5 py-2 font-medium w-8">#</th>
                  <th className="px-2.5 py-2 font-medium">Article</th>
                  <th className="px-2.5 py-2 font-medium">Description</th>
                  <th className="px-2.5 py-2 font-medium text-right tabular-nums">Price</th>
                  <th className="px-2.5 py-2 font-medium text-center">Qty</th>
                  <th className="px-2.5 py-2 font-medium text-right tabular-nums">Total</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.product.id} className="border-b border-hairline last:border-0 align-top">
                    <td className="px-2.5 py-2.5 text-secondary tabular-nums">{i + 1}</td>
                    <td className="px-2.5 py-2.5 font-medium whitespace-nowrap">{l.product.sku}</td>
                    <td className="px-2.5 py-2.5">
                      <div className="truncate max-w-[260px]">{l.product.name}</div>
                      {l.recommendedReason === "sticky_price" && (
                        <Recommended>Same as last time</Recommended>
                      )}
                      {l.recommendedReason === "discount" && (
                        <span className="text-caption text-accent">Discount applied</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">
                      <input
                        ref={(el) => {
                          if (!cellRefs.current[i]) cellRefs.current[i] = [];
                          cellRefs.current[i][0] = el;
                        }}
                        type="number"
                        min={0}
                        step="0.01"
                        value={l.price}
                        onChange={(e) => updatePrice(l.product.id, Number(e.target.value) || 0)}
                        onKeyDown={(e) => handleCellKeyDown(e, i, 0)}
                        className="w-20 text-right tabular-nums px-1.5 py-1 rounded-inner border border-hairline bg-canvas"
                      />
                    </td>
                    <td className="px-2.5 py-2.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          className="w-6 h-6 rounded-inner border border-hairline grid place-items-center shrink-0"
                          onClick={() => updateQty(l.product.id, l.qty - 1)}
                        >
                          <Minus size={11} />
                        </button>
                        <input
                          ref={(el) => {
                            if (!cellRefs.current[i]) cellRefs.current[i] = [];
                            cellRefs.current[i][1] = el;
                          }}
                          type="number"
                          min={0}
                          step="1"
                          value={l.qty}
                          onChange={(e) => setLineQtyRaw(l.product.id, Number(e.target.value) || 0)}
                          onBlur={() => commitQty(l.product.id)}
                          onKeyDown={(e) => handleCellKeyDown(e, i, 1)}
                          className="w-11 text-center tabular-nums font-medium px-1 py-1 rounded-inner border border-hairline bg-canvas"
                        />
                        <button
                          className="w-6 h-6 rounded-inner border border-hairline grid place-items-center shrink-0"
                          onClick={() => updateQty(l.product.id, l.qty + 1)}
                        >
                          <Plus size={11} />
                        </button>
                      </div>
                    </td>
                    {/* Plain number, no currency prefix — the mockup's table reads
                        "120", with the currency only in the totals block. */}
                    <td className="px-2.5 py-2.5 text-right tabular-nums font-medium whitespace-nowrap">
                      {(l.price * l.qty).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-2.5 py-2.5">
                      <button onClick={() => removeLine(l.product.id)} className="text-secondary hover:text-[--status-danger]">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* "+ Search article … [camera]" row, sitting directly beneath the
            table as in the mockup — the way you add the next line, rather
            than a toolbar floating above the table. */}
        <button
          onClick={() => setAddingProduct(true)}
          className="w-full flex items-center gap-2.5 mt-1.5 px-3 py-2.5 rounded-card border border-hairline text-left hover:border-accent/50 transition-colors"
        >
          <span className="w-6 h-6 rounded-full bg-accent/12 text-accent grid place-items-center shrink-0">
            <Plus size={14} />
          </span>
          <span className="flex-1 text-subhead text-secondary">Search article</span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              setShowPhotoPicker(true);
            }}
            className="w-7 h-7 rounded-full grid place-items-center text-[--status-info] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            role="button"
            aria-label="Pick product from photos"
            title="Pick from photos"
          >
            <ImageIcon size={16} />
          </span>
        </button>

        {lines.length > 0 && (
          <div className="mt-3 rounded-card bg-canvas p-3.5 space-y-1.5">
            <div className="flex items-center justify-between text-subhead">
              <span className="font-semibold">Subtotal</span>
              <span className="tabular-nums font-semibold">{aedSuffix(grossSubtotal)}</span>
            </div>
            {gp !== null && (
              <div className="flex items-center justify-between text-subhead">
                <span className="font-semibold">GP</span>
                <span className="tabular-nums font-semibold">
                  {gpPct !== null ? `${gp.toFixed(2)} (${gpPct}%) AED` : aedSuffix(gp)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-subhead">
              <span className="font-semibold">VAT (5%)</span>
              <span className="tabular-nums font-semibold">{aedSuffix(vat)}</span>
            </div>
            {/* Discount line — in the mockup and previously missing entirely. */}
            <div className="flex items-center justify-between text-subhead">
              <span className="font-semibold">Discount</span>
              <span className="tabular-nums font-semibold">{aedSuffix(discountTotal)}</span>
            </div>
            <div className="flex items-center justify-between text-headline font-bold pt-1.5 border-t border-hairline">
              <span>Total</span>
              <span className="tabular-nums">{aedSuffix(total)}</span>
            </div>
          </div>
        )}

        <div className="mt-4">
          {isManager ? (
            <div className="flex items-center justify-between mb-1.5">
              <Label>Note for</Label>
              <div className="flex rounded-card border border-hairline overflow-hidden">
                {(["warehouse", "salesman"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setNoteRecipient(r)}
                    className={`px-3 py-1 text-caption font-semibold capitalize ${
                      noteRecipient === r ? "bg-accent text-white" : "text-secondary"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Label>Note for manager</Label>
          )}
          <textarea
            className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[64px]"
            placeholder={
              isManager
                ? `Anything the ${noteRecipient} should know about this order`
                : "Anything the manager should know about this order"
            }
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
          />
        </div>
      </Sheet>

      {showPhotoPicker && (
        <ProductPhotoPicker onClose={() => setShowPhotoPicker(false)} onSelect={addProduct} />
      )}

      {holdWarning && customer && !collectingPayment && (
        <OverduePaymentPrompt
          days={holdWarning.oldestDays}
          reason={holdReason}
          onReasonChange={setHoldReason}
          onCancel={() => {
            setHoldWarning(null);
            setHoldReason(null);
            setCustomer(null);
          }}
          onCollect={() => setCollectingPayment(true)}
          onNoteSaved={() => setHoldWarning(null)}
        />
      )}

      {collectingPayment && customer && (
        <LogPaymentSheet
          user={user}
          preselectedCustomer={customer}
          onClose={() => setCollectingPayment(false)}
          onSaved={() => {
            setCollectingPayment(false);
            setHoldWarning(null);
            setHoldReason(null);
          }}
        />
      )}

      {confirmExit && (
        <AnimatePresence>
          <motion.div
            className="fixed inset-0 z-[70] bg-black/30 backdrop-blur-[2px] flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <motion.div
              className="glass w-full max-w-sm rounded-sheet overflow-hidden"
              initial={{ y: 16, opacity: 0, scale: 0.97 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 12, opacity: 0 }}
              transition={springEnter}
            >
              <div className="p-5">
                <div className="flex gap-2.5 items-start">
                  <AlertTriangle size={20} className="text-[--status-warning] shrink-0 mt-0.5" />
                  <div>
                    <div className="text-headline font-bold">Discard this order?</div>
                    <div className="text-subhead text-secondary mt-0.5">
                      {lines.length} item{lines.length === 1 ? "" : "s"} added — leaving now loses them unless you save as a draft.
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 px-5 pb-5">
                <Button
                  tier="primary"
                  disabled={saving || !canSave}
                  onClick={() => save("draft")}
                >
                  {saving ? "Saving…" : "Save as draft"}
                </Button>
                <Button tier="danger" disabled={saving} onClick={onClose}>
                  Discard
                </Button>
                <Button tier="plain" disabled={saving} onClick={() => setConfirmExit(false)}>
                  Keep editing
                </Button>
              </div>
            </motion.div>
          </motion.div>
        </AnimatePresence>
      )}
    </>
  );
}

// Overdue-customer pop-up (§Next Updates: "when the user selects a customer
// with overdue payment... cancel, continue to payment, or give a note to
// the manager") — blocks silently proceeding with the order until the
// salesman picks one of the three.
function OverduePaymentPrompt({
  days,
  reason,
  onReasonChange,
  onCancel,
  onCollect,
  onNoteSaved,
}: {
  days: number;
  reason: string | null;
  onReasonChange: (v: string) => void;
  onCancel: () => void;
  onCollect: () => void;
  onNoteSaved: () => void;
}) {
  const [showReasonInput, setShowReasonInput] = useState(false);
  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[70] bg-black/30 backdrop-blur-[2px] flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      >
        <motion.div
          className="glass w-full max-w-sm rounded-sheet overflow-hidden"
          initial={{ y: 16, opacity: 0, scale: 0.97 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 12, opacity: 0 }}
          transition={springEnter}
        >
          <div className="p-5">
            <div className="flex gap-2.5 items-start mb-4">
              <AlertTriangle size={20} className="text-[--status-danger] shrink-0 mt-0.5" />
              <div>
                <div className="text-headline font-bold">Payment collection</div>
                <div className="text-subhead text-secondary mt-0.5">
                  This customer is <strong className="text-primary">{days} days</strong> overdue on an invoice.
                </div>
              </div>
            </div>
            {showReasonInput ? (
              <>
                <Label>Note for manager</Label>
                <TextInput
                  placeholder="Why wasn't the payment collected?"
                  value={reason ?? ""}
                  onChange={(e) => onReasonChange(e.target.value)}
                  autoFocus
                />
              </>
            ) : null}
          </div>
          <div className="flex gap-2 justify-end px-5 py-3.5 border-t border-hairline">
            {showReasonInput ? (
              <>
                <Button tier="plain" onClick={() => setShowReasonInput(false)}>Back</Button>
                <Button tier="primary" disabled={!reason?.trim()} onClick={onNoteSaved}>Save note</Button>
              </>
            ) : (
              <>
                <Button tier="plain" onClick={onCancel}>Cancel</Button>
                <Button tier="tinted" onClick={() => setShowReasonInput(true)}>Give a note</Button>
                <Button tier="primary" onClick={onCollect}>Continue to payment</Button>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// "Select products in the photo view" (§Orders "New order" mockup) — a
// simple photo-grid picker over the same catalog, not a novel AI/photo-
// recognition feature. Tapping a tile adds that product straight to the
// order, same as picking it from the text search.
function ProductPhotoPicker({ onClose, onSelect }: { onClose: () => void; onSelect: (p: Product) => void }) {
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(async () => {
      const supabase = supabaseBrowser();
      setProducts(await fetchProducts(supabase, { search: search || undefined }));
      setLoading(false);
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <Sheet open onClose={onClose} title="Select product">
      <div className="relative mb-3">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
        <TextInput
          autoFocus
          className="pl-9"
          placeholder="Search products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {loading ? (
        <p className="text-caption text-secondary">Loading…</p>
      ) : products.length === 0 ? (
        <p className="text-caption text-secondary">No products found.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {products.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelect(p)}
              className="text-left bg-surface border border-hairline rounded-card overflow-hidden hover:border-accent/50 transition"
            >
              <div className="aspect-square bg-canvas relative">
                <img
                  src={`/api/product-photo?sku=${encodeURIComponent(p.sku)}`}
                  alt={p.name}
                  className="w-full h-full object-cover"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                  loading="lazy"
                />
              </div>
              <div className="p-2.5">
                <div className="text-caption font-semibold truncate">{p.sku}</div>
                <div className="text-caption text-secondary truncate">{p.name}</div>
                <div className="text-subhead font-semibold tabular-nums mt-1">{formatAed(p.price)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
