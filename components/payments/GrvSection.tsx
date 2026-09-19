"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Minus, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchGrvs, fetchGrvItems, createGrv, approveGrv, saveGrv, deleteGrv, type GrvRow } from "@/lib/queries/grv";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchProducts } from "@/lib/queries/products";
import type { AppUser, Customer, Product } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import { t } from "@/lib/i18n";
import Button from "@/components/ui/Button";
import Sheet from "@/components/ui/Sheet";
import { Label, TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Badge";

export default function GrvSection({ user }: { user: AppUser }) {
  const [grvs, setGrvs] = useState<GrvRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const isManager = user.role === "manager" || user.role === "admin";

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    setGrvs(await fetchGrvs(supabase));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(id: string) {
    const supabase = supabaseBrowser();
    await approveGrv(supabase, id, user.id);
    setConfirmingId(null);
    load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-headline font-semibold">{t("payments.returnsGrv")}</h2>
        {/* Muted tier, not primary — GRV should still read as a real
            button, just a less prominent one than cash/cheque collection. */}
        <Button tier="plain" onClick={() => setShowNew(true)}>{t("payments.newReturn")}</Button>
      </div>

      {grvs.length === 0 ? (
        <div className="text-caption text-secondary">{t("payments.noReturnsLogged")}</div>
      ) : (
        <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
          {grvs.map((g) => (
            <div key={g.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
              <button className="text-left" onClick={() => setViewingId(g.id)}>
                <div className="text-subhead font-medium hover:text-accent">{g.customer?.name ?? t("common.notSet")}</div>
                <div className="text-caption text-secondary tabular-nums">
                  {new Date(g.created_at).toLocaleDateString()} · {formatAed(g.creditValue)}
                  {g.lineCount === 0 && ` · ${t("payments.grvNeedsProducts")}`}
                </div>
              </button>
              {g.status === "approved" ? (
                <Pill tone="accent">{t("payments.approved")}</Pill>
              ) : isManager && g.lineCount === 0 ? (
                <Button tier="tinted" onClick={() => setViewingId(g.id)}>{t("payments.grvAddProducts")}</Button>
              ) : isManager ? (
                confirmingId === g.id ? (
                  <div className="flex gap-2">
                    <button className="text-caption text-secondary" onClick={() => setConfirmingId(null)}>{t("common.cancel")}</button>
                    <Button tier="danger" onClick={() => approve(g.id)}>{t("payments.confirmApprove")}</Button>
                  </div>
                ) : (
                  <Button tier="tinted" onClick={() => setConfirmingId(g.id)}>{t("payments.approve")}</Button>
                )
              ) : (
                <Pill tone="warning">{t("payments.pending")}</Pill>
              )}
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <NewGrvSheet user={user} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />
      )}

      {viewingId && grvs.some((g) => g.id === viewingId) && (
        isManager ? (
          <GrvEditSheet
            user={user}
            grv={grvs.find((g) => g.id === viewingId)!}
            onClose={() => setViewingId(null)}
            onChanged={() => { setViewingId(null); load(); }}
          />
        ) : (
          <GrvItemsSheet
            grv={grvs.find((g) => g.id === viewingId)!}
            onClose={() => setViewingId(null)}
          />
        )
      )}
    </div>
  );
}

function GrvItemsSheet({ grv, onClose }: { grv: GrvRow; onClose: () => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof fetchGrvItems>> | null>(null);

  useEffect(() => {
    fetchGrvItems(supabaseBrowser(), grv.id).then(setItems);
  }, [grv.id]);

  return (
    <Sheet open onClose={onClose} title={t("payments.returnTitle", { name: grv.customer?.name ?? t("common.notSet") })}>
      {!items ? (
        <div className="text-secondary text-subhead py-10 text-center">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <div className="text-secondary text-subhead py-10 text-center">{t("payments.noItemsOnReturn")}</div>
      ) : (
        <div className="border border-hairline rounded-card divide-y divide-hairline">
          {items.map((it) => (
            <div key={it.id} className="px-3.5 py-2.5 flex items-center justify-between text-subhead">
              <span>{it.name ?? it.product_id}</span>
              <span className="tabular-nums text-secondary">
                {t("payments.qty")} {it.qty} · {formatAed(it.unit_value * it.qty)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

// Manager/admin: open a return, enter or correct the products that came back,
// change the amount credited, and approve it. This is where a request raised
// while collecting a payment gets its products — without them the GRV product
// report has nothing to count, so approval waits for at least one line.
function GrvEditSheet({
  user,
  grv,
  onClose,
  onChanged,
}: {
  user: AppUser;
  grv: GrvRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lines, setLines] = useState<{ product_id: string; label: string; qty: number; unit_value: number }[] | null>(null);
  const [amount, setAmount] = useState(grv.amount != null ? String(grv.amount) : "");
  const [notes, setNotes] = useState(grv.notes ?? "");
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    fetchGrvItems(supabaseBrowser(), grv.id).then((items) =>
      setLines(items.map((it) => ({
        product_id: it.product_id,
        label: [it.sku, it.name].filter(Boolean).join(" — ") || it.product_id,
        qty: it.qty,
        unit_value: it.unit_value,
      })))
    );
  }, [grv.id]);

  useEffect(() => {
    if (!productSearch) { setProductResults([]); return; }
    const timer = setTimeout(async () => setProductResults(await fetchProducts(supabaseBrowser(), { search: productSearch })), 200);
    return () => clearTimeout(timer);
  }, [productSearch]);

  const linesTotal = (lines ?? []).reduce((sum, l) => sum + l.qty * l.unit_value, 0);
  const patch = () => ({
    amount: amount.trim() === "" ? null : Math.max(0, Number(amount) || 0),
    notes: notes.trim() || null,
    lines: (lines ?? []).map((l) => ({ product_id: l.product_id, qty: l.qty, unit_value: l.unit_value })),
  });

  async function run(work: () => Promise<void>, failed: string) {
    setBusy(true);
    try {
      await work();
      onChanged();
    } catch (e) {
      toast.error(friendlyError(e, failed));
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(() => saveGrv(supabaseBrowser(), grv.id, patch()), t("payments.grvSaveFailed"));
  const saveAndApprove = () =>
    run(async () => {
      const supabase = supabaseBrowser();
      await saveGrv(supabase, grv.id, patch());
      await approveGrv(supabase, grv.id, user.id);
    }, t("payments.grvSaveFailed"));
  const remove = () => run(() => deleteGrv(supabaseBrowser(), grv.id), t("payments.grvDeleteFailed"));

  const setLine = (productId: string, change: Partial<{ qty: number; unit_value: number }>) =>
    setLines((prev) => (prev ?? []).map((l) => (l.product_id === productId ? { ...l, ...change } : l)));

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("payments.returnTitle", { name: grv.customer?.name ?? t("common.notSet") })}
      footer={
        <>
          <Button tier="plain" disabled={busy || !lines} onClick={save}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
          {grv.status !== "approved" && (
            <Button tier="primary" disabled={busy || !lines || lines.length === 0} onClick={saveAndApprove}>
              {t("payments.grvSaveAndApprove")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex items-center justify-between p-3 rounded-card bg-canvas mb-3">
        <div className="font-medium text-subhead">
          {grv.customer?.name ?? t("common.notSet")}{" "}
          {grv.customer?.code && <span className="text-caption text-secondary">({grv.customer.code})</span>}
        </div>
        {grv.status === "approved" ? <Pill tone="accent">{t("payments.approved")}</Pill> : <Pill tone="warning">{t("payments.pending")}</Pill>}
      </div>

      <Label>{t("payments.grvCreditAmount")}</Label>
      <div className="flex items-center gap-2">
        <TextInput
          type="number"
          value={amount}
          placeholder={t("payments.grvValuedFromProducts")}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1"
        />
        <span className="text-caption text-secondary shrink-0">{t("payments.aed")}</span>
      </div>
      <p className="text-caption text-secondary mt-1.5">{t("payments.grvCreditAmountHint")}</p>

      <Label>{t("payments.returnedItems")}</Label>
      <TextInput placeholder={t("payments.searchProducts")} value={productSearch} onChange={(e) => setProductSearch(e.target.value)} />
      {productResults.length > 0 && (
        <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-40 overflow-y-auto">
          {productResults.map((p) => (
            <button
              key={p.id}
              className="w-full text-start px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0"
              onClick={() => {
                setLines((prev) => {
                  const list = prev ?? [];
                  if (list.some((l) => l.product_id === p.id)) {
                    return list.map((l) => (l.product_id === p.id ? { ...l, qty: l.qty + 1 } : l));
                  }
                  return [...list, { product_id: p.id, label: `${p.sku} — ${p.name}`, qty: 1, unit_value: p.price }];
                });
                setProductSearch("");
                setProductResults([]);
              }}
            >
              {p.sku} — {p.name}
            </button>
          ))}
        </div>
      )}

      {!lines ? (
        <div className="mt-3 space-y-2">
          <div className="skeleton h-12 rounded-card" />
          <div className="skeleton h-12 rounded-card" />
        </div>
      ) : lines.length === 0 ? (
        <p className="text-caption text-secondary mt-3">{t("payments.grvNoProductsYet")}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {lines.map((l) => (
            <div key={l.product_id} className="p-2.5 rounded-card bg-canvas">
              <div className="flex items-center gap-2">
                <div className="flex-1 text-subhead min-w-0 truncate">{l.label}</div>
                <button
                  aria-label={t("common.remove")}
                  className="w-11 h-11 grid place-items-center"
                  onClick={() => setLines((prev) => (prev ?? []).filter((x) => x.product_id !== l.product_id))}
                >
                  <Trash2 size={15} className="text-secondary" />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-caption text-secondary">{t("payments.qty")}</span>
                <TextInput
                  type="number"
                  value={String(l.qty)}
                  onChange={(e) => setLine(l.product_id, { qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                  className="!w-20 tabular-nums"
                />
                <span className="text-caption text-secondary">{t("payments.grvUnitValue")}</span>
                <TextInput
                  type="number"
                  value={String(l.unit_value)}
                  onChange={(e) => setLine(l.product_id, { unit_value: Math.max(0, Number(e.target.value) || 0) })}
                  className="!w-24 tabular-nums"
                />
                <span className="flex-1 text-end text-subhead tabular-nums">{formatAed(l.qty * l.unit_value)}</span>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between text-subhead font-semibold pt-1">
            <span>{t("payments.grvProductsTotal")}</span>
            <span className="tabular-nums">{formatAed(linesTotal)}</span>
          </div>
        </div>
      )}

      <Label>{t("payments.notes")}</Label>
      <textarea
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[60px]"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      {grv.status !== "approved" && (
        <div className="mt-4">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <Button tier="plain" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</Button>
              <Button tier="danger" disabled={busy} onClick={remove}>{t("payments.grvConfirmDelete")}</Button>
            </div>
          ) : (
            <Button tier="plain" onClick={() => setConfirmDelete(true)}>{t("payments.grvDelete")}</Button>
          )}
        </div>
      )}
    </Sheet>
  );
}

function NewGrvSheet({
  user,
  onClose,
  onCreated,
}: {
  user: AppUser;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [lines, setLines] = useState<{ product: Product; qty: number }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!search) { setResults([]); return; }
    const t = setTimeout(async () => setResults(await fetchCustomers(supabaseBrowser(), { search })), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const t = setTimeout(async () => setProductResults(await fetchProducts(supabaseBrowser(), { search: productSearch || undefined })), 200);
    return () => clearTimeout(t);
  }, [productSearch]);

  async function save() {
    if (!customer || lines.length === 0) return;
    setSaving(true);
    try {
      const supabase = supabaseBrowser();
      await createGrv(
        supabase,
        customer.id,
        user.id,
        lines.map((l) => ({ product_id: l.product.id, qty: l.qty, unit_value: l.product.price }))
      );
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("payments.newReturnGrv")}
      footer={
        <Button tier="primary" disabled={saving || !customer || lines.length === 0} onClick={save}>
          {saving ? t("common.saving") : t("payments.logReturn")}
        </Button>
      }
    >
      {!customer ? (
        <>
          <Label>{t("payments.customer")}</Label>
          <TextInput placeholder={t("payments.searchCustomers")} value={search} onChange={(e) => setSearch(e.target.value)} />
          {results.length > 0 && (
            <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-48 overflow-y-auto">
              {results.map((c) => (
                <button
                  key={c.id}
                  className="w-full text-left px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0"
                  onClick={() => { setCustomer(c); setSearch(""); setResults([]); }}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-between p-3 rounded-card bg-canvas mb-3">
          <div className="font-medium text-subhead">{customer.name}</div>
          <button className="text-caption text-accent font-medium" onClick={() => setCustomer(null)}>{t("payments.change")}</button>
        </div>
      )}

      <Label>{t("payments.returnedItems")}</Label>
      <TextInput placeholder={t("payments.searchProducts")} value={productSearch} onChange={(e) => setProductSearch(e.target.value)} />
      {productResults.length > 0 && (
        <div className="mt-1 border border-hairline rounded-card overflow-hidden max-h-40 overflow-y-auto">
          {productResults.map((p) => (
            <button
              key={p.id}
              className="w-full text-left px-3.5 py-2.5 hover:bg-canvas text-subhead border-b border-hairline last:border-0"
              onClick={() => {
                setLines((prev) => {
                  const existing = prev.find((l) => l.product.id === p.id);
                  if (existing) return prev.map((l) => (l.product.id === p.id ? { ...l, qty: l.qty + 1 } : l));
                  return [...prev, { product: p, qty: 1 }];
                });
                setProductSearch("");
                setProductResults([]);
              }}
            >
              {p.sku} — {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-2">
        {lines.map((l) => (
          <div key={l.product.id} className="flex items-center gap-2 p-2.5 rounded-card bg-canvas">
            <div className="flex-1 text-subhead">{l.product.name}</div>
            <button
              className="w-7 h-7 rounded-inner border border-hairline grid place-items-center"
              onClick={() => setLines((prev) => prev.map((x) => (x.product.id === l.product.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}
            >
              <Minus size={13} />
            </button>
            <span className="w-6 text-center tabular-nums">{l.qty}</span>
            <button
              className="w-7 h-7 rounded-inner border border-hairline grid place-items-center"
              onClick={() => setLines((prev) => prev.map((x) => (x.product.id === l.product.id ? { ...x, qty: x.qty + 1 } : x)))}
            >
              <Plus size={13} />
            </button>
            <button onClick={() => setLines((prev) => prev.filter((x) => x.product.id !== l.product.id))}>
              <Trash2 size={15} className="text-secondary" />
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
