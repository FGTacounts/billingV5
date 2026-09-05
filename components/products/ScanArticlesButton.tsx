"use client";

import { useRef, useState } from "react";
import { ScanLine, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";

// A supplier invoice or price list, read once and turned into products.
//
// Two phases on purpose: the AI reads the document once, the manager checks
// what it read, and only then is anything saved. Re-scanning to save would
// cost a second request and could come back subtly different from what was
// approved.

interface ScannedArticle {
  sku: string;
  name: string;
  price: number;
  cost: number;
  default_qty: number;
  stock_on_hand: number;
  rack_location: string;
  barcode: string;
}

export default function ScanArticlesButton({ onAdded }: { onAdded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ScannedArticle[] | null>(null);
  const [duplicates, setDuplicates] = useState<string[]>([]);

  function close() {
    setOpen(false);
    setRows(null);
    setError(null);
    setDuplicates([]);
    setBusy(false);
    setSaving(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function read(file: File) {
    setBusy(true);
    setError(null);
    setRows(null);
    setOpen(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/scan-articles", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "The scan failed");
      else {
        setRows(data.articles ?? []);
        setDuplicates(data.duplicates ?? []);
      }
    } catch {
      setError("Couldn't reach the server while scanning.");
    }
    setBusy(false);
  }

  async function save() {
    if (!rows || rows.length === 0) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("articles", JSON.stringify(rows));
      const res = await fetch("/api/scan-articles", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't save the products");
      toast.success(
        `Added ${data.added} product${data.added === 1 ? "" : "s"}.` +
          (data.duplicates?.length ? ` ${data.duplicates.length} already existed.` : "")
      );
      onAdded();
      close();
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't save the products"));
      setSaving(false);
    }
  }

  function edit(i: number, patch: Partial<ScannedArticle>) {
    setRows((prev) => prev && prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  return (
    <>
      <Button
        tier="plain"
        onClick={() => fileRef.current?.click()}
        className="flex items-center gap-1.5 text-caption"
      >
        <ScanLine size={15} /> Scan invoice
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        hidden
        onChange={(e) => e.target.files?.[0] && read(e.target.files[0])}
      />

      {open && (
        <Sheet
          open
          onClose={() => !busy && !saving && close()}
          title="Products read from the invoice"
          footer={
            <>
              <Button tier="plain" disabled={busy || saving} onClick={close}>
                Discard
              </Button>
              <Button
                tier="primary"
                disabled={busy || saving || !rows || rows.length === 0}
                onClick={save}
              >
                {saving ? "Adding…" : `Add ${rows?.length ?? 0} product${rows?.length === 1 ? "" : "s"}`}
              </Button>
            </>
          }
        >
          {busy && (
            <p className="text-subhead text-secondary py-4 text-center">
              Reading the document. This takes a few seconds.
            </p>
          )}

          {error && (
            <div className="p-3 rounded-card bg-[--status-danger]/10 text-[--status-danger] text-subhead mb-3">
              {error}
            </div>
          )}

          {duplicates.length > 0 && (
            <p className="text-caption text-secondary mb-3">
              Already in the catalogue and left out: {duplicates.join(", ")}
            </p>
          )}

          {rows && rows.length > 0 && (
            <>
              <p className="text-caption text-secondary mb-2">
                Check these before adding. The selling price is deliberately left at
                zero — set it yourself once the product is in.
              </p>
              <div className="border border-hairline rounded-card overflow-x-auto">
                <table className="w-full text-subhead min-w-[520px]">
                  <thead>
                    <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
                      <th className="px-2.5 py-2 font-medium">SKU</th>
                      <th className="px-2.5 py-2 font-medium">Description</th>
                      <th className="px-2.5 py-2 font-medium text-right">Cost</th>
                      <th className="px-2.5 py-2 font-medium text-right">Qty in</th>
                      <th className="px-2.5 py-2 font-medium">Barcode</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-b border-hairline last:border-0">
                        <td className="px-2.5 py-2">
                          <input
                            className="w-24 px-1.5 py-1 rounded-inner border border-hairline bg-canvas"
                            value={r.sku}
                            onChange={(e) => edit(i, { sku: e.target.value })}
                          />
                        </td>
                        <td className="px-2.5 py-2">
                          <input
                            className="w-full min-w-[140px] px-1.5 py-1 rounded-inner border border-hairline bg-canvas"
                            value={r.name}
                            onChange={(e) => edit(i, { name: e.target.value })}
                          />
                        </td>
                        <td className="px-2.5 py-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            className="w-20 text-right tabular-nums px-1.5 py-1 rounded-inner border border-hairline bg-canvas"
                            value={r.cost}
                            onChange={(e) => edit(i, { cost: Number(e.target.value) || 0 })}
                          />
                        </td>
                        <td className="px-2.5 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            className="w-16 text-right tabular-nums px-1.5 py-1 rounded-inner border border-hairline bg-canvas"
                            value={r.stock_on_hand}
                            onChange={(e) =>
                              edit(i, { stock_on_hand: Math.max(0, Number(e.target.value) || 0) })
                            }
                          />
                        </td>
                        <td className="px-2.5 py-2">
                          <input
                            className="w-32 px-1.5 py-1 rounded-inner border border-hairline bg-canvas"
                            value={r.barcode}
                            onChange={(e) => edit(i, { barcode: e.target.value })}
                          />
                        </td>
                        <td className="px-2.5 py-2">
                          <button
                            onClick={() => setRows((prev) => prev && prev.filter((_, idx) => idx !== i))}
                            className="text-secondary hover:text-[--status-danger]"
                            aria-label="Remove this row"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {rows && rows.length === 0 && !error && (
            <p className="text-subhead text-secondary py-4 text-center">
              Every product on that invoice is already in the catalogue.
            </p>
          )}
        </Sheet>
      )}
    </>
  );
}
