"use client";

import { toast } from "@/lib/toast";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { friendlyError } from "@/lib/errors";
import { useRef, useState } from "react";
import { Upload, Download } from "lucide-react";
import { parseSpreadsheetFile, downloadSampleCsv } from "@/lib/spreadsheet";
import { remapHeaders } from "@/lib/importAliases";

export default function ImportCsvButton({
  endpoint,
  onImported,
  label = "Import",
  sample,
  aliases,
  askStockMode = false,
}: {
  endpoint: string;
  onImported: () => void;
  // Products carry stock, so an import of SKUs you already hold has to ask
  // whether the file's quantities replace what is on the shelf or add to it.
  // Getting that wrong silently changes inventory, so we ask rather than
  // assume.
  askStockMode?: boolean;
  label?: string;
  // Offers a "Sample" download next to Import (§Products/§Customers) — a
  // one-row CSV template so the user knows exactly which columns to fill
  // in, with required ones starred.
  sample?: {
    filename: string;
    headers: { key: string; required?: boolean }[];
    // A function lets the caller compute something live at download time
    // (§Customers: "make sure the customer code starts from the next
    // number") instead of a stale hardcoded example.
    example: Record<string, string | number> | (() => Promise<Record<string, string | number>>);
  };
  // Recognizes the user's real spreadsheet headers ("ARTICLE", "CUSTOMER
  // NAME", "VAT NO", …) as aliases for our snake_case field names, so a
  // sheet exported straight from their existing files uploads as-is — see
  // lib/importAliases.ts (sourced from FGT_Billing_Supabase_Schema.xlsx).
  aliases?: Record<string, string[]>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, unknown>[] | null>(null);

  async function send(rows: Record<string, unknown>[], stockMode?: string) {
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stockMode ? { rows, stockMode } : { rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      onImported();
      const detail =
        data.updated != null && data.created != null
          ? ` (${data.created} new, ${data.updated} updated)`
          : "";
      toast.success(`Imported ${data.count} row${data.count === 1 ? "" : "s"}${detail}.`);
    } catch (e) {
      toast.error(friendlyError(e, "Import failed"));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function handleFile(file: File) {
    setBusy(true);
    try {
      let rows = await parseSpreadsheetFile(file);
      if (rows.length === 0) {
        toast.error("That file didn't have any rows to import.");
        return;
      }
      if (aliases) rows = remapHeaders(rows, aliases);
      if (askStockMode) {
        setPending(rows as Record<string, unknown>[]);
        setBusy(false);
        return;
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      onImported();
      toast.success(`Imported ${data.count} row${data.count === 1 ? "" : "s"}.`);
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
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent disabled:opacity-50"
      >
        <Upload size={14} /> {busy ? "Importing…" : label}
      </button>
      {sample && (
        <button
          onClick={async () => {
            const example = typeof sample.example === "function" ? await sample.example() : sample.example;
            downloadSampleCsv(sample.filename, sample.headers, example);
          }}
          className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent"
        >
          <Download size={14} /> Sample
        </button>
      )}

      {/* Asked only when the file is already parsed, so the question is
          concrete: we know how many rows are about to land. */}
      {pending && (
        <Sheet
          open
          onClose={() => setPending(null)}
          title="Stock for products you already have"
          footer={
            <Button tier="plain" onClick={() => setPending(null)}>
              Cancel
            </Button>
          }
        >
          <p className="text-subhead text-secondary mb-4">
            {pending.length} row{pending.length === 1 ? "" : "s"} to import. For any
            product already in your catalogue, what should happen to the stock?
          </p>
          <div className="flex flex-col gap-2">
            {[
              {
                mode: "keep",
                title: "Keep my current stock",
                body: "Update prices, names and other details, but leave quantities exactly as they are. Safest if this is a price list.",
              },
              {
                mode: "add",
                title: "Add the file's quantities to my stock",
                body: "Use this for a delivery or a new shipment — 40 in the file plus 10 on the shelf becomes 50.",
              },
              {
                mode: "replace",
                title: "Replace my stock with the file's",
                body: "Use this after a stock count — the file becomes the truth. Existing quantities are overwritten.",
              },
            ].map((opt) => (
              <button
                key={opt.mode}
                onClick={() => send(pending, opt.mode)}
                disabled={busy}
                className="text-left p-4 rounded-card border border-hairline hover:border-accent/50 hover:bg-accent/8 transition-colors hover:!opacity-100 disabled:opacity-50"
              >
                <div className="text-subhead font-semibold">{opt.title}</div>
                <div className="text-caption text-secondary mt-0.5">{opt.body}</div>
              </button>
            ))}
          </div>
          <p className="text-caption text-secondary mt-4">
            A blank stock cell always leaves that product&rsquo;s quantity alone,
            whichever option you pick.
          </p>
        </Sheet>
      )}
    </div>
  );
}
