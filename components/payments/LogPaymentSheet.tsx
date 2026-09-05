"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useState, useEffect, useMemo } from "react";
import { Camera, ArrowLeft, ImageIcon, Check, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchOutstandingInvoices, type InvoiceAging } from "@/lib/queries/aging";
import { createPayment, fetchLastChequeDetails } from "@/lib/queries/payments";
import { InvoiceTemplate } from "@/lib/invoice-template";
import type { AppUser, Customer } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";
import ScanCheque from "./ScanCheque";

// Two-step collection flow (Problems and Updates — Payments/Customers §):
// pick customer + which outstanding orders this collection covers, then a
// dedicated "Collect" step with payment type, GRV credit, cheque details
// (recipient defaults to the company name, editable), and a balance readout
// that reacts live to amount + GRV. Deselecting orders is allowed on the
// Collect step; selecting *more* orders means going back a step, matching
// the spec's "selecting more orders requires going back" note.
export default function LogPaymentSheet({
  user,
  onClose,
  onSaved,
  preselectedCustomer,
  preselectedOrderIds,
}: {
  user: AppUser;
  onClose: () => void;
  onSaved: () => void;
  preselectedCustomer?: Customer;
  preselectedOrderIds?: string[];
}) {
  const isManager = user.role === "manager" || user.role === "admin";
  const [step, setStep] = useState<"select" | "collect">(preselectedCustomer ? "collect" : "select");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(preselectedCustomer ?? null);
  const [invoices, setInvoices] = useState<InvoiceAging[]>([]);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set(preselectedOrderIds ?? []));

  const [paymentType, setPaymentType] = useState<"cash" | "cheque">("cash");
  const [amount, setAmount] = useState("");
  const [showGrv, setShowGrv] = useState(false);
  const [grvAmount, setGrvAmount] = useState("");
  // §Payments: "Manager has the ability to add a discount to the payment
  // when collecting" — reduces the outstanding balance the same way a GRV
  // credit does, without requiring matching cash/cheque.
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountAmount, setDiscountAmount] = useState("");
  const [bank, setBank] = useState("");
  const [chequeNumber, setChequeNumber] = useState("");
  const [payerDetails, setPayerDetails] = useState("");
  const [recipientName, setRecipientName] = useState(InvoiceTemplate.companyName);
  const [editingRecipient, setEditingRecipient] = useState(false);
  const [chequeDate, setChequeDate] = useState(new Date().toISOString().slice(0, 10));
  const [chequePhoto, setChequePhoto] = useState<Blob | null>(null);
  const [notes, setNotes] = useState("");
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmPartial, setConfirmPartial] = useState(false);
  // §Payments: "a reason should be provided when not paying full price of
  // an order" — required before a partial collection can be confirmed.
  const [partialReason, setPartialReason] = useState("");

  useEffect(() => {
    if (!search) { setResults([]); return; }
    const t = setTimeout(async () => {
      const supabase = supabaseBrowser();
      setResults(await fetchCustomers(supabase, { search }));
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  async function loadInvoices(c: Customer) {
    const supabase = supabaseBrowser();
    const inv = await fetchOutstandingInvoices(supabase, c.id);
    // Oldest to newest throughout, per spec.
    inv.sort((a, b) => new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime());
    setInvoices(inv);
  }

  // §Customers: "bank name and customer details should be saved/remembered
  // for next time" — pre-fill from whatever cheque this customer last paid
  // with, if any.
  async function prefillLastCheque(c: Customer) {
    const supabase = supabaseBrowser();
    const { bank: lastBank, payerDetails: lastPayerDetails } = await fetchLastChequeDetails(supabase, c.id);
    if (lastBank) setBank(lastBank);
    if (lastPayerDetails) setPayerDetails(lastPayerDetails);
  }

  async function selectCustomer(c: Customer) {
    setCustomer(c);
    setSearch("");
    setResults([]);
    await loadInvoices(c);
    prefillLastCheque(c);
  }

  useEffect(() => {
    if (preselectedCustomer) {
      loadInvoices(preselectedCustomer);
      prefillLastCheque(preselectedCustomer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedInvoices = useMemo(
    () => invoices.filter((i) => selectedOrders.has(i.orderId)),
    [invoices, selectedOrders]
  );
  const selectedTotal = selectedInvoices.reduce((s, i) => s + i.balance, 0);
  const allOutstandingTotal = invoices.reduce((s, i) => s + i.balance, 0);
  // No orders picked = apply from the oldest outstanding orders automatically.
  const displayInvoices = selectedOrders.size > 0 ? selectedInvoices : invoices;
  const displayTotal = selectedOrders.size > 0 ? selectedTotal : allOutstandingTotal;

  const amountNum = Number(amount) || 0;
  const grvNum = Number(grvAmount) || 0;
  const discountNum = isManager ? Number(discountAmount) || 0 : 0;
  const covered = amountNum + grvNum + discountNum;
  const balance = Math.max(0, displayTotal - covered);
  const isPartial = covered > 0 && covered < displayTotal;
  const exceedsAll = covered > allOutstandingTotal + 0.01;

  function toggleOrder(orderId: string) {
    setSelectedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  async function doSave() {
    if (!customer) return;
    setSaving(true);
    try {
      const supabase = supabaseBrowser();

      let chequePhotoRef: string | null = null;
      if (chequePhoto) {
        const form = new FormData();
        form.set("photo", chequePhoto, "cheque.jpg");
        // Lets the server name the file after the customer — CUSTOMERNAME1,
        // CUSTOMERNAME2 — rather than after the moment it was uploaded.
        form.set("customerId", customer.id);
        const res = await fetch("/api/payments/upload-cheque-photo", { method: "POST", body: form });
        const data = await res.json();
        if (res.ok) chequePhotoRef = data.ref;
      }

      // Apply oldest-first across the selected orders, then — if there's
      // still money left over — cascade into the customer's other
      // outstanding orders (also oldest-first), per "if customer pays extra
      // ... deducted from next oldest orders."
      let remaining = amountNum;
      const allocations: { orderId: string; amount: number }[] = [];
      const applyTo = (list: InvoiceAging[]) => {
        for (const inv of list) {
          if (remaining <= 0) break;
          const applied = Math.min(remaining, inv.balance);
          if (applied > 0) {
            allocations.push({ orderId: inv.orderId, amount: applied });
            remaining -= applied;
          }
        }
      };
      applyTo(selectedInvoices);
      applyTo(invoices.filter((i) => !selectedOrders.has(i.orderId)));

      const grvNote = grvNum > 0 ? `GRV credit applied: ${formatAed(grvNum)}.` : "";
      const discountNote = discountNum > 0 ? `Discount applied by ${user.full_name}: ${formatAed(discountNum)}.` : "";
      const partialNote = isPartial ? `Partial payment reason: ${partialReason.trim()}` : "";
      const combinedNotes = [notes.trim(), grvNote, discountNote, partialNote].filter(Boolean).join(" ");

      await createPayment(supabase, {
        customer_id: customer.id,
        collected_by: user.id,
        amount: amountNum,
        bank: paymentType === "cheque" ? bank || null : null,
        cheque_number: paymentType === "cheque" ? chequeNumber || null : null,
        cheque_date: paymentType === "cheque" ? chequeDate || null : null,
        cheque_photo_ref: chequePhotoRef,
        payer_details: paymentType === "cheque" ? payerDetails || null : null,
        notes: combinedNotes || null,
        allocations,
      });
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to log payment"));
    } finally {
      setSaving(false);
      setConfirmPartial(false);
    }
  }

  function attemptCollect() {
    if (!customer || amountNum <= 0) return;
    if (isPartial && !confirmPartial) {
      setConfirmPartial(true);
      return;
    }
    doSave();
  }

  if (step === "select") {
    return (
      <Sheet
        open
        onClose={onClose}
        title="Log payment"
        footer={
          <Button
            tier="primary"
            disabled={!customer || invoices.length === 0}
            onClick={() => setStep("collect")}
          >
            Continue
          </Button>
        }
      >
        {!customer ? (
          <>
            <Label>Customer</Label>
            <TextInput placeholder="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} />
            {results.length > 0 && (
              <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-48 overflow-y-auto">
                {results.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0"
                    onClick={() => selectCustomer(c)}
                  >
                    {c.name} <span className="text-secondary text-caption">({c.code})</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between p-3 rounded-card bg-canvas mb-3">
              <div className="font-medium text-subhead">
                {customer.name} <span className="text-caption text-secondary">({customer.code})</span>
              </div>
              <button
                className="text-caption text-accent font-medium"
                onClick={() => { setCustomer(null); setInvoices([]); setSelectedOrders(new Set()); }}
              >
                Change
              </button>
            </div>

            {invoices.length === 0 ? (
              <p className="text-caption text-secondary">No outstanding orders for this customer.</p>
            ) : (
              <>
                <Label>Orders to collect against (oldest first)</Label>
                <div className="border border-hairline rounded-card divide-y divide-hairline max-h-64 overflow-y-auto">
                  {invoices.map((inv) => (
                    <label
                      key={inv.orderId}
                      className={`flex items-center justify-between px-3 py-2.5 text-subhead cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03] ${
                        inv.daysOutstanding > 90 ? "bg-danger/8" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <input
                          type="checkbox"
                          checked={selectedOrders.has(inv.orderId)}
                          onChange={() => toggleOrder(inv.orderId)}
                        />
                        <span className="truncate">
                          {new Date(inv.invoiceDate).toLocaleDateString()} · #{inv.invoiceNumber ?? "—"}
                        </span>
                      </span>
                      <span className="flex items-center gap-3 shrink-0">
                        <span className="tabular-nums text-secondary">{formatAed(inv.balance)}</span>
                        <span
                          className={`text-caption font-semibold ${
                            inv.daysOutstanding > 90 ? "text-[--status-danger]" : "text-secondary"
                          }`}
                        >
                          {inv.daysOutstanding}d
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {selectedOrders.size > 0 && (
                  <div className="flex items-center justify-between mt-3 text-subhead font-semibold">
                    <span>Selected total</span>
                    <span className="tabular-nums">{formatAed(selectedTotal)}</span>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </Sheet>
    );
  }

  // step === "collect"
  return (
    <Sheet
      open
      onClose={onClose}
      // The mockup titles this screen with the customer, not the action —
      // when you're collecting, who you're collecting from is the heading.
      title={customer?.name ?? "Log payment"}
      headerExtra={
        <Button
          tier="primary"
          disabled={saving || amountNum <= 0}
          onClick={attemptCollect}
          className="!py-1.5 !px-3.5 text-caption"
        >
          {saving ? "…" : "Collect"}
        </Button>
      }
    >
      <button
        onClick={() => setStep("select")}
        className="flex items-center gap-1 text-caption font-semibold text-secondary hover:text-primary mb-2"
      >
        <ArrowLeft size={14} /> Back
      </button>
      {customer && <div className="text-headline font-bold text-secondary mb-3">{customer.code}</div>}

      {selectedOrders.size === 0 && displayInvoices.length > 0 && (
        <p className="text-caption text-secondary mb-2">
          No specific orders selected — this collection will apply to the oldest outstanding orders first.
        </p>
      )}
      <div className="border border-hairline rounded-card divide-y divide-hairline mb-2">
        {displayInvoices.map((inv) => (
          <div
            key={inv.orderId}
            className={`flex items-center justify-between px-3 py-2 text-subhead ${
              inv.daysOutstanding > 90 ? "bg-danger/8" : ""
            }`}
          >
            <span className="flex items-center gap-2 min-w-0">
              {selectedOrders.size > 0 && <Check size={14} className="text-accent shrink-0" />}
              <span className="truncate">
                {new Date(inv.invoiceDate).toLocaleDateString()} · #{inv.invoiceNumber ?? "—"}
              </span>
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <span className="tabular-nums">{formatAed(inv.balance)}</span>
              <span
                className={`text-caption font-semibold tabular-nums ${
                  inv.daysOutstanding > 90 ? "text-[--status-danger]" : "text-secondary"
                }`}
              >
                {inv.daysOutstanding}d
              </span>
              {selectedOrders.has(inv.orderId) && (
                <button
                  type="button"
                  onClick={() => toggleOrder(inv.orderId)}
                  className="p-0.5 text-secondary hover:text-[--status-danger]"
                  aria-label="Deselect order"
                  title="Deselect order"
                >
                  <X size={14} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mb-4 text-subhead font-semibold">
        <span>Total</span>
        <span className="tabular-nums underline">{formatAed(displayTotal)}</span>
      </div>

      <Label>Payment type</Label>
      <div className="flex rounded-card border border-hairline overflow-hidden mb-3">
        <button
          onClick={() => setPaymentType("cheque")}
          className={`flex-1 py-2.5 text-subhead font-medium ${paymentType === "cheque" ? "bg-black/10 dark:bg-white/15" : ""}`}
        >
          Cheque
        </button>
        <button
          onClick={() => setPaymentType("cash")}
          className={`flex-1 py-2.5 text-subhead font-medium ${paymentType === "cash" ? "bg-black/10 dark:bg-white/15" : ""}`}
        >
          Cash
        </button>
      </div>

      <Label>Amount</Label>
      <div className="flex items-center gap-2">
        <TextInput type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1" />
        <span className="text-caption text-secondary shrink-0">AED</span>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-caption text-secondary">Balance</span>
        <span className={`text-caption tabular-nums font-semibold ${balance > 0 ? "text-[--status-warning]" : "text-accent"}`}>
          {formatAed(balance)}
        </span>
      </div>
      {exceedsAll && (
        <p className="text-caption text-[--status-danger] mt-1">
          This exceeds the customer&rsquo;s total outstanding balance ({formatAed(allOutstandingTotal)}).
        </p>
      )}

      <div className="mt-3">
        <Button tier="tinted" onClick={() => setShowGrv((v) => !v)} className="!px-3 !py-1.5 text-caption">
          {showGrv ? "Remove" : "+ Add"} Goods Return Voucher
        </Button>
      </div>
      {showGrv && (
        <div className="mt-2 p-3 rounded-card bg-canvas">
          <Label>Goods Return Voucher</Label>
          <div className="flex items-center gap-2">
            <TextInput type="number" value={grvAmount} onChange={(e) => setGrvAmount(e.target.value)} className="flex-1" />
            <span className="text-caption text-secondary shrink-0">AED</span>
          </div>
        </div>
      )}

      {isManager && (
        <div className="mt-2">
          <Button tier="tinted" onClick={() => setShowDiscount((v) => !v)} className="!px-3 !py-1.5 text-caption">
            {showDiscount ? "Remove" : "+ Add"} discount
          </Button>
        </div>
      )}
      {isManager && showDiscount && (
        <div className="mt-2 p-3 rounded-card bg-canvas">
          <Label>Discount</Label>
          <div className="flex items-center gap-2">
            <TextInput type="number" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} className="flex-1" />
            <span className="text-caption text-secondary shrink-0">AED</span>
          </div>
          <p className="text-caption text-secondary mt-1.5">
            Waives this much of the balance without requiring matching cash/cheque — recorded in the payment notes.
          </p>
        </div>
      )}

      {paymentType === "cheque" && (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <Label>Cheque Details</Label>
            <Button
              tier="tinted"
              onClick={() => setScanning(true)}
              className="!px-3 !py-1.5 text-caption flex items-center gap-1"
            >
              <Camera size={14} /> Scan
            </Button>
          </div>
          <TextInput placeholder="Cheque number" value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
          <TextInput className="mt-2" placeholder="Bank name" value={bank} onChange={(e) => setBank(e.target.value)} />
          <TextInput
            className="mt-2"
            placeholder="Customer details"
            value={payerDetails}
            onChange={(e) => setPayerDetails(e.target.value)}
          />
          <div className="flex items-center justify-between mt-3 text-subhead">
            {editingRecipient ? (
              <TextInput
                autoFocus
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                onBlur={() => setEditingRecipient(false)}
                className="flex-1"
              />
            ) : (
              <>
                <span>{recipientName}</span>
                <button className="text-caption text-accent font-medium" onClick={() => setEditingRecipient(true)}>
                  Edit
                </button>
              </>
            )}
          </div>
          <div className="flex items-center justify-between mt-3 text-subhead">
            <span>Cheque date</span>
            <TextInput
              type="date"
              value={chequeDate}
              onChange={(e) => setChequeDate(e.target.value)}
              className="!w-auto"
            />
          </div>
          <div className="flex items-center justify-between mt-3 text-subhead">
            <span>Image of cheque</span>
            {chequePhoto ? (
              <ImageIcon size={16} className="text-accent" />
            ) : (
              <span className="text-caption text-secondary">Not scanned</span>
            )}
          </div>
        </div>
      )}

      <Label>Notes</Label>
      <textarea
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[70px]"
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      {confirmPartial && (
        <div className="mt-4 p-3.5 rounded-card bg-warning/10 border border-warning/30">
          <p className="text-subhead mb-2">
            This only covers {formatAed(covered)} of the {formatAed(displayTotal)} outstanding — the rest stays
            outstanding.
          </p>
          <Label>Reason for partial payment *</Label>
          <TextInput
            autoFocus
            placeholder="e.g. customer short on cash, disputed item, promised balance next week"
            value={partialReason}
            onChange={(e) => setPartialReason(e.target.value)}
          />
          <div className="flex gap-2 mt-3">
            <Button tier="plain" onClick={() => setConfirmPartial(false)}>Cancel</Button>
            <Button tier="primary" disabled={saving || !partialReason.trim()} onClick={doSave}>
              {saving ? "Saving…" : "Confirm"}
            </Button>
          </div>
        </div>
      )}

      {scanning && (
        <ScanCheque
          onClose={() => setScanning(false)}
          onScanned={(data) => {
            if (data.bank) setBank(data.bank);
            if (data.chequeNumber) setChequeNumber(data.chequeNumber);
            if (data.date) setChequeDate(data.date);
            if (data.amount) setAmount(String(data.amount));
            if (data.photo) setChequePhoto(data.photo);
            setScanning(false);
          }}
        />
      )}
    </Sheet>
  );
}
