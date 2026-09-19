"use client";

import { toast } from "@/lib/toast";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";
import { friendlyError } from "@/lib/errors";
import { useRef, useState } from "react";
import { Upload, Download } from "lucide-react";
import { parseSpreadsheetFile, downloadSampleCsv } from "@/lib/spreadsheet";
import { remapHeaders } from "@/lib/importAliases";
import { runQueuedJob } from "@/lib/jobs-client";
import type { JobKind } from "@/lib/jobs";
import { t } from "@/lib/i18n";

export default function ImportCsvButton({
  endpoint,
  onImported,
  label = t("ui.import"),
  sample,
  aliases,
  askStockMode = false,
  jobKind,
  unit = "row",
}: {
  endpoint: string;
  onImported: () => void;
  // Rule 8. An import that names a job kind is queued instead of being done
  // inside the request the user is waiting on: /api/jobs writes one row and
  // returns, and /api/jobs/run does the work. `endpoint` is still what runs
  // if the jobs table is not there (RUN-ME-23-job-queue.sql), so an importer
  // never stops working over a migration the owner has not pasted yet.
  jobKind?: JobKind;
  // What one imported thing is called, for the message afterwards. Products
  // and customers arrive a row at a time; an order import turns many rows
  // into a few orders, and saying "3 rows" there would be wrong.
  unit?: string;
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
      if (!res.ok) throw new Error(data.error ?? t("ui.importFailed"));
      onImported();
      const detail =
        data.updated != null && data.created != null
          ? ` ${t("ui.importCounts", { created: data.created, updated: data.updated })}`
          : "";
      // A route can add a sentence of its own — what it skipped and why —
      // which is worth more than the count on its own.
      const note = typeof data.note === "string" && data.note ? ` ${data.note}` : "";
      toast.success(
        `${t("ui.importedCount", {
          count: data.count,
          unit: `${unit}${data.count === 1 ? "" : "s"}`,
          detail,
        })}${note}`
      );
    } catch (e) {
      toast.error(friendlyError(e, t("ui.importFailed")));
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
        toast.error(t("ui.noRowsInFile"));
        return;
      }
      if (aliases) rows = remapHeaders(rows, aliases);
      if (askStockMode) {
        setPending(rows as Record<string, unknown>[]);
        setBusy(false);
        return;
      }
      // Queued when the caller named a kind. runQueuedJob returns null when
      // this database has no jobs table, and then this falls through to the
      // inline endpoint below — the same retreat lib/products-server.ts makes
      // when a migration has not been run.
      let data: Record<string, unknown> | null = null;
      if (jobKind) {
        const job = await runQueuedJob(jobKind, { rows });
        if (job) data = job.result ?? {};
      }

      if (!data) {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows }),
        });
        data = await res.json();
        if (!res.ok) throw new Error((data?.error as string) ?? t("ui.importFailed"));
      }

      onImported();
      const count = Number(data?.count ?? 0);
      toast.success(count === 1 ? t("ui.importedRowOne") : t("ui.importedRowMany", { count }));
    } catch (e) {
      toast.error(friendlyError(e, t("ui.importFailed")));
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
        <Upload size={14} /> {busy ? t("ui.importing") : label}
      </button>
      {sample && (
        <button
          onClick={async () => {
            const example = typeof sample.example === "function" ? await sample.example() : sample.example;
            downloadSampleCsv(sample.filename, sample.headers, example);
          }}
          className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent"
        >
          <Download size={14} /> {t("ui.sample")}
        </button>
      )}

      {/* Asked only when the file is already parsed, so the question is
          concrete: we know how many rows are about to land. */}
      {pending && (
        <Sheet
          open
          onClose={() => setPending(null)}
          title={t("ui.stockForExistingProducts")}
          footer={
            <Button tier="plain" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
          }
        >
          <p className="text-subhead text-secondary mb-4">
            {pending.length === 1
              ? t("ui.oneRowToImport")
              : t("ui.rowsToImport", { count: pending.length })}
          </p>
          <div className="flex flex-col gap-2">
            {[
              {
                mode: "keep",
                title: t("ui.stockKeepTitle"),
                body: t("ui.stockKeepBody"),
              },
              {
                mode: "add",
                title: t("ui.stockAddTitle"),
                body: t("ui.stockAddBody"),
              },
              {
                mode: "replace",
                title: t("ui.stockReplaceTitle"),
                body: t("ui.stockReplaceBody"),
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
          <p className="text-caption text-secondary mt-4">{t("ui.blankStockCellNote")}</p>
        </Sheet>
      )}
    </div>
  );
}
