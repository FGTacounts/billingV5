"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { updatePayment, fetchPaymentInvoiceChoices, type PaymentRow } from "@/lib/queries/payments";
import { fetchCustomers } from "@/lib/queries/customers";
import type { InvoiceAging } from "@/lib/queries/aging";
import type { Customer } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import { t } from "@/lib/i18n";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";
import { SkeletonList } from "@/components/ui/Empty";

// The payment's created_at as a local yyyy-mm-dd, for a date input.
function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Edit-after-logging (§Payments: "everything can be edited by the user who
// sends the payment afterwards, but the manager is notified about the
// changes"). Saving re-cuts the payment's per-invoice slices from the new
// amount + discount — against the invoices it was already on, oldest first —
// because the slices, not payments.amount, are what an invoice ages against.
// A manager or admin can also change the discount and the date the money was
// received, and put a confirmed payment back to pending. Whoever can edit can
// move the payment to another customer and tick which invoices it pays
// (2026-10-05; both had been left out on 2026-09-18).
export default function EditPaymentSheet({
  payment,
  isManager,
  onClose,
  onSaved,
}: {
  payment: PaymentRow;
  isManager: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [paymentType, setPaymentType] = useState<"cash" | "cheque">(payment.cheque_number ? "cheque" : "cash");
  const [amount, setAmount] = useState(String(payment.amount));
  const [discount, setDiscount] = useState(payment.discount_amount ? String(payment.discount_amount) : "");
  const [status, setStatus] = useState<"pending" | "confirmed">(payment.status === "confirmed" ? "confirmed" : "pending");
  const [bank, setBank] = useState(payment.cheque_bank ?? "");
  const [chequeNumber, setChequeNumber] = useState(payment.cheque_number ?? "");
  const [chequeDate, setChequeDate] = useState(payment.cheque_date ?? new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState(payment.notes ?? "");
  const [receivedOn, setReceivedOn] = useState(localDay(payment.created_at));
  const [customer, setCustomer] = useState<Pick<Customer, "id" | "name" | "code"> | null>(payment.customer);
  const [changingCustomer, setChangingCustomer] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<InvoiceAging[] | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const customerId = customer?.id ?? payment.customer_id;

  useEffect(() => {
    if (!search) { setResults([]); return; }
    const timer = setTimeout(async () => {
      setResults(await fetchCustomers(supabaseBrowser(), { search }));
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  // The invoices this payment can go against, re-read when the customer
  // changes. Its own invoices start ticked; another customer's start blank.
  useEffect(() => {
    let live = true;
    setInvoices(null);
    fetchPaymentInvoiceChoices(supabaseBrowser(), payment, customerId)
      .then(({ invoices: inv, currentOrderIds }) => {
        if (!live) return;
        setInvoices(inv);
        setSelectedOrders(new Set(currentOrderIds));
      })
      .catch((e) => {
        if (!live) return;
        setInvoices([]);
        toast.error(friendlyError(e, t("payments.failedToLoadInvoices")));
      });
    return () => { live = false; };
  }, [payment, customerId]);

  function toggleOrder(orderId: string) {
    setSelectedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  // Same time of day, new day — only when the day really changed, so an
  // untouched date never rewrites created_at.
  function receivedAt(): string | undefined {
    if (!isManager || !receivedOn || receivedOn === localDay(payment.created_at)) return undefined;
    const [y, m, d] = receivedOn.split("-").map(Number);
    const at = new Date(payment.created_at);
    at.setFullYear(y, m - 1, d);
    // Today at a time of day still to come would be a payment from the future.
    return (at.getTime() > Date.now() ? new Date() : at).toISOString();
  }

  async function save() {
    setSaving(true);
    try {
      await updatePayment(supabaseBrowser(), payment.id, {
        customer_id: customerId !== payment.customer_id ? customerId : undefined,
        created_at: receivedAt(),
        // Nothing ticked: oldest first across all of the customer's invoices.
        // No list to tick (none owed, or it failed to load): the invoices the
        // payment was already on go first, as before.
        orderIds: invoices?.length ? [...selectedOrders] : undefined,
        amount: Number(amount) || 0,
        // A collector editing their own payment cannot touch the discount or
        // the status; what was there stays there.
        discount_amount: isManager ? Number(discount) || 0 : payment.discount_amount ?? 0,
        status: isManager && status !== payment.status ? status : undefined,
        bank: paymentType === "cheque" ? bank || null : null,
        cheque_number: paymentType === "cheque" ? chequeNumber || null : null,
        cheque_date: paymentType === "cheque" ? chequeDate || null : null,
        notes: notes || null,
      });
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e, t("payments.failedToUpdatePayment")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("payments.editPayment")}
      footer={
        <>
          <Button tier="plain" onClick={onClose}>{t("common.cancel")}</Button>
          <Button tier="primary" disabled={saving || !amount || invoices === null || changingCustomer} onClick={save}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="text-caption text-secondary mb-3">
        {payment.customer?.name ?? t("common.notSet")} · {t("payments.originally")}{" "}
        <span className="tabular-nums">{formatAed(payment.amount)}</span>
      </div>

      <Label>{t("payments.customer")}</Label>
      {changingCustomer ? (
        <>
          <TextInput
            autoFocus
            placeholder={t("payments.searchCustomers")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {results.length > 0 && (
            <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-48 overflow-y-auto">
              {results.map((c) => (
                <button
                  key={c.id}
                  className="w-full text-start px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0"
                  onClick={() => {
                    setCustomer({ id: c.id, name: c.name, code: c.code });
                    setChangingCustomer(false);
                    setSearch("");
                  }}
                >
                  {c.name} <span className="text-secondary text-caption">({c.code})</span>
                </button>
              ))}
            </div>
          )}
          <button
            className="mt-1.5 text-caption text-accent font-medium min-h-[44px]"
            onClick={() => { setChangingCustomer(false); setSearch(""); }}
          >
            {t("common.cancel")}
          </button>
        </>
      ) : (
        <div className="flex items-center justify-between p-3 rounded-card bg-canvas mb-1">
          <div className="font-medium text-subhead">
            {customer?.name ?? t("common.notSet")}
            {customer?.code && <span className="text-caption text-secondary"> ({customer.code})</span>}
          </div>
          <button className="text-caption text-accent font-medium min-h-[44px] px-2" onClick={() => setChangingCustomer(true)}>
            {t("payments.change")}
          </button>
        </div>
      )}
      {customerId !== payment.customer_id && (
        <p className="text-caption text-[--status-warning] mt-1">
          {t("payments.moveCustomerHint", { from: payment.customer?.name ?? t("common.notSet") })}
        </p>
      )}

      {isManager && (
        <>
          <Label>{t("payments.receivedOn")}</Label>
          <TextInput
            type="date"
            value={receivedOn}
            max={localDay(new Date().toISOString())}
            onChange={(e) => setReceivedOn(e.target.value)}
            className="!w-auto"
          />
        </>
      )}

      <Label>{t("payments.paymentType")}</Label>
      <div className="flex rounded-card border border-hairline overflow-hidden mb-3">
        <button
          onClick={() => setPaymentType("cheque")}
          className={`flex-1 py-2.5 text-subhead font-medium ${paymentType === "cheque" ? "bg-black/10 dark:bg-white/15" : ""}`}
        >
          {t("payments.cheque")}
        </button>
        <button
          onClick={() => setPaymentType("cash")}
          className={`flex-1 py-2.5 text-subhead font-medium ${paymentType === "cash" ? "bg-black/10 dark:bg-white/15" : ""}`}
        >
          {t("payments.cash")}
        </button>
      </div>

      <Label>{t("payments.amount")}</Label>
      <div className="flex items-center gap-2">
        <TextInput type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1" />
        <span className="text-caption text-secondary shrink-0">{t("payments.aed")}</span>
      </div>

      {isManager && (
        <>
          <Label>{t("payments.discount")}</Label>
          <div className="flex items-center gap-2">
            <TextInput type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} className="flex-1" />
            <span className="text-caption text-secondary shrink-0">{t("payments.aed")}</span>
          </div>
        </>
      )}

      <Label>{t("payments.invoicesToPay")}</Label>
      {invoices === null ? (
        <SkeletonList rows={3} />
      ) : invoices.length === 0 ? (
        <p className="text-caption text-secondary">{t("payments.noOutstandingOrders")}</p>
      ) : (
        <div className="border border-hairline rounded-card divide-y divide-hairline max-h-64 overflow-y-auto">
          {invoices.map((inv) => (
            <label
              key={inv.orderId}
              className={`flex items-center justify-between gap-3 px-3 py-2.5 min-h-[44px] text-subhead cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03] ${
                inv.daysOutstanding > 90 ? "bg-danger/8" : ""
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <input type="checkbox" checked={selectedOrders.has(inv.orderId)} onChange={() => toggleOrder(inv.orderId)} />
                <span className="truncate">
                  {new Date(inv.invoiceDate).toLocaleDateString()} · #{inv.invoiceNumber ?? t("common.notSet")}
                </span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="tabular-nums text-secondary">{formatAed(inv.balance)}</span>
                <span
                  className={`text-caption font-semibold tabular-nums ${
                    inv.daysOutstanding > 90 ? "text-[--status-danger]" : "text-secondary"
                  }`}
                >
                  {t("payments.daysOutstandingShort", { n: inv.daysOutstanding })}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      <p className="text-caption text-secondary mt-1.5">{t("payments.editReallocatesHint")}</p>

      {isManager && (
        <>
          <Label>{t("payments.status")}</Label>
          <div className="flex rounded-card border border-hairline overflow-hidden mb-1">
            {(["pending", "confirmed"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`flex-1 py-2.5 text-subhead font-medium ${status === s ? "bg-black/10 dark:bg-white/15" : ""}`}
              >
                {s === "pending" ? t("payments.pending") : t("payments.confirmed")}
              </button>
            ))}
          </div>
        </>
      )}

      {paymentType === "cheque" && (
        <div className="mt-4">
          <Label>{t("payments.chequeNumber")}</Label>
          <TextInput value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
          <Label>{t("payments.bankName")}</Label>
          <TextInput value={bank} onChange={(e) => setBank(e.target.value)} />
          <Label>{t("payments.chequeDate")}</Label>
          <TextInput type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} className="!w-auto" />
        </div>
      )}

      <Label>{t("payments.notes")}</Label>
      <textarea
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[70px]"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
    </Sheet>
  );
}
