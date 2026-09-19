"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { updatePayment, type PaymentRow } from "@/lib/queries/payments";
import { formatAed } from "@/lib/money";
import { t } from "@/lib/i18n";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";

// Edit-after-logging (§Payments: "everything can be edited by the user who
// sends the payment afterwards, but the manager is notified about the
// changes"). Saving re-cuts the payment's per-invoice slices from the new
// amount + discount — against the invoices it was already on, oldest first —
// because the slices, not payments.amount, are what an invoice ages against.
// A manager or admin can also change the discount and put a confirmed payment
// back to pending.
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
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await updatePayment(supabaseBrowser(), payment.id, {
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
          <Button tier="primary" disabled={saving || !amount} onClick={save}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="text-caption text-secondary mb-3">
        {payment.customer?.name ?? t("common.notSet")} · {t("payments.originally")} {formatAed(payment.amount)}
      </div>

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
