"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { useEffect, useState, useCallback, useMemo } from "react";
import { CalendarClock, ChevronDown, ChevronRight, FileDown, Layers } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchOrders, type OrderRow } from "@/lib/queries/orders";
import { fetchOutstandingInvoices, extendOrderDueDate, type InvoiceAging } from "@/lib/queries/aging";
import { deleteCustomer } from "@/lib/queries/customers";
import type { AppUser, Customer } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import LogPaymentSheet from "@/components/payments/LogPaymentSheet";

// Customer Detail (Problems and Updates — Customers §): name/code header,
// The Statement (date/inv/amount/days, oldest→newest) — one list of what
// this customer still owes. It used to sit beside an Orders list saying the
// same thing in different words; collecting starts from the statement now,
// Edit/Delete (Manager) or Request Edit (Salesman) bottom-left, a
// selection mode + Save bottom-right. Selecting statement rows and
// continuing hands off straight into the payment-collection flow with
// those orders pre-picked.
export default function CustomerDetailView({
  customer,
  user,
  onClose,
  onEdit,
  onDeleted,
}: {
  customer: Customer;
  user: AppUser;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const isManager = (user.role === "manager" || user.role === "admin");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceAging[]>([]);
  const [loading, setLoading] = useState(true);
  const [paidOpen, setPaidOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collecting, setCollecting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // "Request edit" used to set a flag, relabel itself "Edit requested", and do
  // nothing else — no request was raised and no manager was told. It now opens
  // the same editor a manager gets, and what is typed goes for approval.
  // Per-order due-date extension (§Next Updates: "extend the payment
  // threshold for a specific order too, not only the customer threshold").
  const [extendingOrderId, setExtendingOrderId] = useState<string | null>(null);
  const [extendDate, setExtendDate] = useState("");
  const [savingExtension, setSavingExtension] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    const [orderRows, invoiceRows] = await Promise.all([
      // One order, purely to name the salesman in the header — the list
      // this used to fill has gone, and pulling 200 orders plus every line
      // of every one of them to compute a column nobody sees is not free.
      isManager ? fetchOrders(supabase, { customerId: customer.id, limit: 1 }) : Promise.resolve([]),
      fetchOutstandingInvoices(supabase, customer.id, true),
    ]);
    setOrders(orderRows);
    // oldest -> newest throughout the statement, per spec
    invoiceRows.sort((a, b) => new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime());
    setInvoices(invoiceRows);

    setLoading(false);
  }, [customer.id, isManager]);

  useEffect(() => {
    load();
  }, [load]);



  // The salesman named in the header. A Salesman session doesn't load the
  // Orders list at all, so fall back to the signed-in user when the account
  // is assigned to them — which is the only case they can be looking at.
  const assignedSalesman = useMemo(() => {
    const fromOrders = orders.find((o) => o.salesman?.full_name)?.salesman?.full_name;
    if (fromOrders) return fromOrders;
    if (customer.salesman_id && customer.salesman_id === user.id) return user.full_name;
    return null;
  }, [orders, customer.salesman_id, user.id, user.full_name]);

  const outstandingInvoices = invoices.filter((i) => i.balance > 0.01);
  const paidInvoices = invoices.filter((i) => i.balance <= 0.01);
  const paidTotal = paidInvoices.reduce((s, i) => s + i.total, 0);

  function toggleSelect(orderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  async function saveExtension(orderId: string) {
    setSavingExtension(true);
    try {
      await extendOrderDueDate(supabaseBrowser(), orderId, extendDate || null);
      setExtendingOrderId(null);
      load();
    } catch (e) {
      toast.error(friendlyError(e, t("customers.extendDueDateFailed")));
    } finally {
      setSavingExtension(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await deleteCustomer(supabaseBrowser(), customer.id);
      onDeleted();
    } catch (e) {
      toast.error(friendlyError(e, t("customers.deleteCustomerFailed")));
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (collecting) {
    return (
      <LogPaymentSheet
        user={user}
        preselectedCustomer={customer}
        preselectedOrderIds={[...selected]}
        onClose={() => setCollecting(false)}
        onSaved={() => {
          setCollecting(false);
          setSelecting(false);
          setSelected(new Set());
          load();
        }}
      />
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={customer.name}
      headerExtra={
        <div className="flex items-center gap-1">
          <a
            href={`/api/customers/statement?customerId=${customer.id}&format=pdf`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-2 py-1 rounded-inner text-caption font-semibold text-secondary hover:text-accent hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
            title={t("customers.downloadStatementPdf")}
          >
            <FileDown size={14} /> {t("customers.pdf")}
          </a>
          {isManager && (
            <a
              href={`/api/customers/statement?customerId=${customer.id}&format=excel`}
              className="flex items-center gap-1 px-2 py-1 rounded-inner text-caption font-semibold text-secondary hover:text-accent hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
              title={t("customers.downloadStatementExcel")}
            >
              <FileDown size={14} /> {t("customers.excel")}
            </a>
          )}
          {/* A chain trades under several branch codes but settles one
              account. Without this a manager pulls a statement per branch and
              adds them up by hand — "Day To Day" is 23 shops. Manager/Admin
              only: it exposes the other branches' trading. */}
          {isManager && customer.group_name && (
            <>
              <span aria-hidden className="mx-0.5 w-px h-4 bg-black/10 dark:bg-white/15" />
              <a
                href={`/api/customers/statement?group=${encodeURIComponent(customer.group_name)}&format=pdf`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 px-2 py-1 rounded-inner text-caption font-semibold text-secondary hover:text-accent hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                title={t("customers.groupStatementPdfTitle", { group: customer.group_name })}
              >
                <Layers size={14} /> {t("customers.groupPdf")}
              </a>
              <a
                href={`/api/customers/statement?group=${encodeURIComponent(customer.group_name)}&format=excel`}
                className="flex items-center gap-1 px-2 py-1 rounded-inner text-caption font-semibold text-secondary hover:text-accent hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                title={t("customers.groupStatementExcelTitle", { group: customer.group_name })}
              >
                <Layers size={14} /> {t("customers.groupExcel")}
              </a>
            </>
          )}
        </div>
      }
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            {isManager ? (
              confirmDelete ? (
                <>
                  <Button tier="plain" onClick={() => setConfirmDelete(false)}>{t("customers.neverMind")}</Button>
                  <Button tier="danger" disabled={deleting} onClick={doDelete}>
                    {deleting ? t("customers.deleting") : t("customers.confirmDelete")}
                  </Button>
                </>
              ) : (
                <>
                  <Button tier="plain" className="text-[--status-danger]" onClick={() => setConfirmDelete(true)}>
                    {t("common.delete")}
                  </Button>
                  <Button tier="tinted" onClick={onEdit}>{t("common.edit")}</Button>
                </>
              )
            ) : (
              <Button tier="tinted" onClick={onEdit}>
                {t("customers.suggestChange")}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selecting && selected.size > 0 && (
              <Button tier="primary" onClick={() => setCollecting(true)}>
                {t("customers.continueCount", { n: selected.size })}
              </Button>
            )}
            <Button
              tier={selecting ? "tinted" : "plain"}
              onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }}
            >
              {selecting ? t("customers.cancelSelect") : t("customers.select")}
            </Button>
            <Button tier="primary" onClick={onClose}>{t("common.save")}</Button>
          </div>
        </div>
      }
    >
      {/* The two mockups arrange this header differently by role: Manager
          View puts code / district · VAT on the left and the overdue window
          + salesman on the right; Salesman View swaps them. */}
      <div className="mb-4 flex items-start justify-between gap-4">
        {isManager ? (
          <>
            <div className="min-w-0">
              <div className="text-caption text-secondary">{customer.code}</div>
              <div className="text-caption text-secondary mt-0.5 truncate">
                {[customer.district, customer.vat_number].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-subhead font-bold tabular-nums">
                {t("customers.nDaysUpper", { n: customer.overdue_threshold_days })}
              </div>
              {assignedSalesman && (
                <div className="text-subhead font-bold truncate">{assignedSalesman}</div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="min-w-0">
              {assignedSalesman && (
                <div className="text-subhead font-bold truncate">{assignedSalesman}</div>
              )}
              <div className="text-subhead font-bold tabular-nums">
                {t("customers.nDaysUpper", { n: customer.overdue_threshold_days })}
              </div>
            </div>
            <div className="text-right shrink-0 text-caption text-secondary">
              <div className="font-semibold text-primary tabular-nums">{customer.code}</div>
              {customer.vat_number && <div className="tabular-nums">{customer.vat_number}</div>}
              {customer.district && <div>{customer.district}</div>}
            </div>
          </>
        )}
      </div>

      {loading ? (
        <div className="text-center py-10 text-secondary text-subhead">{t("common.loading")}</div>
      ) : (
        <div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-caption font-semibold text-secondary uppercase">{t("customers.statement")}</div>
              <div className="text-title font-bold tabular-nums">
                {formatAed(outstandingInvoices.reduce((s, i) => s + i.balance, 0))}
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 pb-1.5 text-[10px] uppercase text-secondary font-semibold">
              <span>{t("customers.colDate")}</span>
              <span className="text-right w-14">{t("customers.colInvNo")}</span>
              <span className="text-right w-24">{t("customers.colAmount")}</span>
              <span className="text-right w-14">{t("customers.colDays")}</span>
            </div>
            <div className="border border-hairline rounded-card divide-y divide-hairline max-h-72 overflow-y-auto">
              {outstandingInvoices.length === 0 ? (
                <div className="p-3 text-caption text-secondary">{t("customers.nothingOutstanding")}</div>
              ) : (
                outstandingInvoices.map((inv) => (
                  <div
                    key={inv.orderId}
                    className={inv.daysOutstanding > 90 ? "bg-danger/8" : ""}
                  >
                    <label
                      className={`grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-3 py-2 text-subhead ${
                        selecting ? "cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {selecting && (
                          <input
                            type="checkbox"
                            checked={selected.has(inv.orderId)}
                            onChange={() => toggleSelect(inv.orderId)}
                          />
                        )}
                        <span className="min-w-0">
                          <span className="block text-subhead font-semibold uppercase leading-tight">
                            {new Date(inv.invoiceDate).toLocaleDateString("en-GB", {
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                          {inv.extendedDueDate && (
                            <span className="block text-[10px] text-accent truncate">
                              {t("customers.extendedTo", { date: new Date(inv.extendedDueDate).toLocaleDateString() })}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="text-right w-14 tabular-nums font-bold">
                        {inv.invoiceNumber ?? t("common.notSet")}
                      </span>
                      <span className="text-right w-24 tabular-nums font-bold">
                        {formatAed(inv.balance)}
                      </span>
                      <span className="flex items-center justify-end gap-1.5 shrink-0">
                        <span
                          className={`text-right w-14 text-caption font-bold ${
                            inv.daysOutstanding > 90 ? "text-[--status-danger]" : "text-secondary"
                          }`}
                        >
                          {t("customers.daysShort", { n: inv.daysOutstanding })}
                        </span>
                        {isManager && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setExtendingOrderId(extendingOrderId === inv.orderId ? null : inv.orderId);
                              setExtendDate(inv.extendedDueDate ?? "");
                            }}
                            className="text-secondary hover:text-accent shrink-0"
                            aria-label={t("customers.extendDueDate")}
                            title={t("customers.extendDueDate")}
                          >
                            <CalendarClock size={14} />
                          </button>
                        )}
                      </span>
                    </label>
                    {extendingOrderId === inv.orderId && (
                      <div className="flex items-center gap-2 px-3 pb-2.5">
                        <TextInput
                          type="date"
                          value={extendDate}
                          onChange={(e) => setExtendDate(e.target.value)}
                          className="!w-auto flex-1"
                        />
                        <Button tier="plain" onClick={() => setExtendingOrderId(null)}>{t("common.cancel")}</Button>
                        <Button tier="primary" disabled={savingExtension} onClick={() => saveExtension(inv.orderId)}>
                          {savingExtension ? t("common.saving") : t("common.save")}
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
        <button
          onClick={() => setPaidOpen((v) => !v)}
          className="flex items-center gap-1.5 text-subhead font-semibold"
        >
          {paidOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {t("customers.paidOrders")}
          <span className="text-caption text-secondary font-normal">
            {paidInvoices.length === 1
              ? t("customers.paidOrdersSummaryOne", { n: paidInvoices.length, total: formatAed(paidTotal) })
              : t("customers.paidOrdersSummaryMany", { n: paidInvoices.length, total: formatAed(paidTotal) })}
          </span>
        </button>
        {/* The main statement carries only what is still owed; this is the
            other half — what has been paid — for a customer who asks. */}
        {paidInvoices.length > 0 && (
          <a
            href={`/api/customers/statement?customerId=${customer.id}&format=pdf&scope=paid`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-2 py-2.5 rounded-inner text-caption font-semibold text-secondary hover:text-accent hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
            title={t("customers.downloadPaidStatement")}
          >
            <FileDown size={14} /> {t("customers.paidStatement")}
          </a>
        )}
        </div>
        {paidOpen && (
          <div className="border border-hairline rounded-card divide-y divide-hairline mt-2 max-h-56 overflow-y-auto">
            {paidInvoices.length === 0 ? (
              <div className="p-3 text-caption text-secondary">{t("customers.noPaidOrders")}</div>
            ) : (
              paidInvoices.map((inv) => (
                <div key={inv.orderId} className="flex items-center justify-between px-3 py-2 text-subhead">
                  <span className="text-caption text-secondary">
                    {new Date(inv.invoiceDate).toLocaleDateString()} · #{inv.invoiceNumber ?? t("common.notSet")}
                  </span>
                  <span className="tabular-nums">{formatAed(inv.total)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
