"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Minus, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchGrvs, fetchGrvItems, createGrv, approveGrv, type GrvRow } from "@/lib/queries/grv";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchProducts } from "@/lib/queries/products";
import type { AppUser, Customer, Product } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import Button from "@/components/ui/Button";
import Sheet from "@/components/ui/Sheet";
import { Label, TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Badge";

export default function GrvSection({ user }: { user: AppUser }) {
  const [grvs, setGrvs] = useState<GrvRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);

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
        <h2 className="text-headline font-semibold">Returns (GRV)</h2>
        {/* Muted tier, not primary — GRV should still read as a real
            button, just a less prominent one than cash/cheque collection. */}
        <Button tier="plain" onClick={() => setShowNew(true)}>+ New return</Button>
      </div>

      {grvs.length === 0 ? (
        <div className="text-caption text-secondary">No returns logged.</div>
      ) : (
        <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
          {grvs.map((g) => (
            <div key={g.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
              <button className="text-left" onClick={() => setViewingId(g.id)}>
                <div className="text-subhead font-medium hover:text-accent">{g.customer?.name ?? "—"}</div>
                <div className="text-caption text-secondary">
                  {new Date(g.created_at).toLocaleDateString()} · {formatAed(g.totalValue)}
                </div>
              </button>
              {g.status === "approved" ? (
                <Pill tone="accent">Approved</Pill>
              ) : (user.role === "manager" || user.role === "admin") ? (
                confirmingId === g.id ? (
                  <div className="flex gap-2">
                    <button className="text-caption text-secondary" onClick={() => setConfirmingId(null)}>Cancel</button>
                    <Button tier="danger" onClick={() => approve(g.id)}>Confirm approve</Button>
                  </div>
                ) : (
                  <Button tier="tinted" onClick={() => setConfirmingId(g.id)}>Approve</Button>
                )
              ) : (
                <Pill tone="warning">Pending</Pill>
              )}
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <NewGrvSheet user={user} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />
      )}

      {viewingId && (
        <GrvItemsSheet
          grv={grvs.find((g) => g.id === viewingId)!}
          onClose={() => setViewingId(null)}
        />
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
    <Sheet open onClose={onClose} title={`Return — ${grv.customer?.name ?? "—"}`}>
      {!items ? (
        <div className="text-secondary text-subhead py-10 text-center">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-secondary text-subhead py-10 text-center">No items on this return.</div>
      ) : (
        <div className="border border-hairline rounded-card divide-y divide-hairline">
          {items.map((it) => (
            <div key={it.id} className="px-3.5 py-2.5 flex items-center justify-between text-subhead">
              <span>{it.name ?? it.product_id}</span>
              <span className="tabular-nums text-secondary">
                Qty {it.qty} · {formatAed(it.unit_value * it.qty)}
              </span>
            </div>
          ))}
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
      title="New return (GRV)"
      footer={
        <Button tier="primary" disabled={saving || !customer || lines.length === 0} onClick={save}>
          {saving ? "Saving…" : "Log return"}
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
          <button className="text-caption text-accent font-medium" onClick={() => setCustomer(null)}>Change</button>
        </div>
      )}

      <Label>Returned items</Label>
      <TextInput placeholder="Search products" value={productSearch} onChange={(e) => setProductSearch(e.target.value)} />
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
