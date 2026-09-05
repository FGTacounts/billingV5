"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useRef, useState } from "react";
import { Upload, Download } from "lucide-react";
import { parseSpreadsheetFile, downloadSampleCsv } from "@/lib/spreadsheet";
import { fetchProducts } from "@/lib/queries/products";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Product } from "@/lib/types/db";

// §Orders: "add an import option + sample file: one column SKU, one column
// Qty." Unlike the Products/Customers importers this doesn't POST rows to
// an endpoint — it resolves each SKU against the catalogue and hands the
// matched products back to NewOrderSheet, which adds them as order lines
// through its normal addProduct path (so sticky pricing and per-customer
// discounts still apply exactly as if they'd been added by hand).
const SKU_KEYS = ["sku", "article", "item", "code", "product", "product_code"];
const QTY_KEYS = ["qty", "quantity", "qnty", "count", "units"];

function pick(row: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

export interface ImportedLine {
  product: Product;
  qty: number;
  /**
   * A price the source document actually stated. When set it overrides the
   * customer's remembered price — a figure written on the paper is what was
   * agreed with them. A spreadsheet import leaves it unset, so those lines
   * price exactly as a hand-added one does.
   */
  price?: number;
}

export default function ImportOrderLinesButton({
  onImported,
}: {
  onImported: (lines: ImportedLine[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setBusy(true);
    try {
      const rows = await parseSpreadsheetFile(file);
      if (rows.length === 0) {
        toast.error("That file didn't have any rows to import.");
        return;
      }

      const wanted = rows
        .map((r) => ({ sku: pick(r, SKU_KEYS), qty: Number(pick(r, QTY_KEYS)) || 0 }))
        .filter((r) => r.sku !== "");
      if (wanted.length === 0) {
        toast.error("Couldn't find a SKU column. Download the sample file to see the expected format.");
        return;
      }

      // One catalogue fetch, then match locally — a per-row search request
      // would be dozens of round-trips for a normal-sized order sheet.
      const products = await fetchProducts(supabaseBrowser(), {});
      const bySku = new Map(products.map((p) => [p.sku.trim().toLowerCase(), p]));

      const matched: ImportedLine[] = [];
      const missing: string[] = [];
      for (const w of wanted) {
        const product = bySku.get(w.sku.toLowerCase());
        if (!product) {
          missing.push(w.sku);
          continue;
        }
        matched.push({ product, qty: w.qty > 0 ? w.qty : product.default_qty || 1 });
      }

      if (matched.length === 0) {
        toast.error(`None of the ${wanted.length} SKUs in that file matched a product.`);
        return;
      }
      onImported(matched);
      if (missing.length > 0) {
        toast.error(
          `Added ${matched.length} item${matched.length === 1 ? "" : "s"}. ` +
            `${missing.length} SKU${missing.length === 1 ? "" : "s"} didn't match a product: ${missing.slice(0, 10).join(", ")}` +
            (missing.length > 10 ? `, +${missing.length - 10} more` : "")
        );
      }
    } catch (e) {
      toast.error(friendlyError(e, "Import failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleFile(file);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent disabled:opacity-50"
      >
        <Upload size={14} /> {busy ? "Importing…" : "Import items"}
      </button>
      <button
        type="button"
        onClick={() =>
          downloadSampleCsv(
            "order_items_sample.csv",
            [{ key: "SKU", required: true }, { key: "Qty", required: true }],
            { SKU: "BTT270", Qty: 12 }
          )
        }
        className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent"
      >
        <Download size={14} /> Sample
      </button>
    </div>
  );
}
