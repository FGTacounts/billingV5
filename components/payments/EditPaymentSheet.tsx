"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { updatePayment, type PaymentRow } from "@/lib/queries/payments";
import { formatAed } from "@/lib/money";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";

// Edit-after-logging (§Payments: "everything can be edited by the user who
// sends the payment afterwards, but the manager is notified about the
// changes"). Only the fields that live directly on the payment row are
// editable here — re-picking which orders it applies against is a bigger,
// separate feature the spec doesn't ask this screen to cover.
export default function EditPaymentSheet({
  payment,
  onClose,
  onSaved,
}: {
  payment: PaymentRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [paymentType, setPaymentType] = useState<"cash" | "cheque">(payment.cheque_number ? "cheque" : "cash");
  const [amount, setAmount] = useState(String(payment.amount));
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
        bank: paymentType === "cheque" ? bank || null : null,
        cheque_number: paymentType === "cheque" ? chequeNumber || null : null,
        cheque_date: paymentType === "cheque" ? chequeDate || null : null,
        notes: notes || null,
      });
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to update payment"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit payment"
      footer={
        <>
          <Button tier="plain" onClick={onClose}>Cancel</Button>
          <Button tier="primary" disabled={saving || !amount} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="text-caption text-secondary mb-3">
        {payment.customer?.name ?? "—"} · originally {formatAed(payment.amount)}
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

      {paymentType === "cheque" && (
        <div className="mt-4">
          <Label>Cheque number</Label>
          <TextInput value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
          <Label>Bank name</Label>
          <TextInput value={bank} onChange={(e) => setBank(e.target.value)} />
          <Label>Cheque date</Label>
          <TextInput type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} className="!w-auto" />
        </div>
      )}

      <Label>Notes</Label>
      <textarea
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[70px]"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
    </Sheet>
  );
}
