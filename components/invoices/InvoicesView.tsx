"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { useEffect, useState, useMemo } from "react";
import { FileBadge, Download, Search } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchOrders, type OrderRow } from "@/lib/queries/orders";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import { runQueuedJob, type JobProgress } from "@/lib/jobs-client";
import Sheet from "@/components/ui/Sheet";

type SortKey = "newest" | "oldest" | "invoice_desc" | "invoice_asc";

export default function InvoicesView({ isManager }: { isManager: boolean }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<OrderRow | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  // How many invoices the queue has actually built, not an animation standing
  // in for one. Null until the first slice comes back.
  const [zipProgress, setZipProgress] = useState<JobProgress | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("newest");

  useEffect(() => {
    fetchOrders(supabaseBrowser(), { status: ["delivered"], limit: 500 }).then((rows) => {
      setOrders(rows);
      setLoading(false);
    });
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    let rows = orders;
    if (term) {
      rows = rows.filter(
        (o) =>
          (o.customer?.name ?? "").toLowerCase().includes(term) ||
          (o.invoice_number ?? "").toLowerCase().includes(term)
      );
    }
    const sorted = [...rows];
    switch (sortKey) {
      case "newest": sorted.sort((a, b) => new Date(b.billed_at ?? b.updated_at).getTime() - new Date(a.billed_at ?? a.updated_at).getTime()); break;
      case "oldest": sorted.sort((a, b) => new Date(a.billed_at ?? a.updated_at).getTime() - new Date(b.billed_at ?? b.updated_at).getTime()); break;
      case "invoice_desc": sorted.sort((a, b) => Number(b.invoice_number ?? 0) - Number(a.invoice_number ?? 0)); break;
      case "invoice_asc": sorted.sort((a, b) => Number(a.invoice_number ?? 0) - Number(b.invoice_number ?? 0)); break;
    }
    return sorted;
  }, [orders, search, sortKey]);

  // However the zip was built, this is how it reaches the user — unchanged
  // from the single-request version, because the end of a download is the one
  // part of this that was never the problem.
  function saveZip(blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tax-invoices-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadAll() {
    setDownloadingAll(true);
    setZipProgress(null);
    try {
      // Rule 8. Two hundred invoice PDFs in one request is what dies at the
      // platform timeout, so the export goes on the queue and comes back
      // twenty at a time — each slice its own short request, each one
      // reporting how many invoices are actually built. The file is
      // assembled here once the last slice has arrived.
      const job = await runQueuedJob("invoices.zip", {}, { onProgress: setZipProgress });

      if (job) {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        for (const file of job.files) zip.file(file.name, file.base64, { base64: true });
        saveZip(await zip.generateAsync({ type: "blob" }));
      } else {
        // No jobs table on this database yet (RUN-ME-23 not run). Build it in
        // one request exactly as this screen always did, rather than losing
        // the feature over a migration the owner has not pasted — the same
        // retreat lib/products-server.ts makes for a missing column.
        const res = await fetch("/api/invoices/download-all");
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? t("invoices.downloadFailed"));
        }
        saveZip(await res.blob());
      }
    } catch (e) {
      toast.error(friendlyError(e, t("invoices.downloadFailed")));
    } finally {
      setDownloadingAll(false);
      setZipProgress(null);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">{t("nav.invoices")}</h1>
        {isManager && orders.length > 0 && (
          <button
            onClick={downloadAll}
            disabled={downloadingAll}
            className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent disabled:opacity-50 min-h-[44px]"
          >
            <Download size={14} />{" "}
            <span className="tabular-nums">
              {!downloadingAll
                ? t("invoices.downloadAll")
                : zipProgress
                  ? t("jobs.zippingProgress", {
                      done: zipProgress.done,
                      total: zipProgress.total,
                    })
                  : t("invoices.zipping")}
            </span>
          </button>
        )}
      </div>

      {/* A real measurement, not a spinner: the total is known the moment the
          job is planned, and the bar moves once per slice actually built.
          Same bar as the target progress on Reports. */}
      {downloadingAll && zipProgress && (
        <div
          className="h-2 rounded-full bg-canvas overflow-hidden mb-5"
          role="progressbar"
          aria-valuenow={zipProgress.done}
          aria-valuemin={0}
          aria-valuemax={zipProgress.total}
          aria-label={t("jobs.zippingProgress", {
            done: zipProgress.done,
            total: zipProgress.total,
          })}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{
              inlineSize: `${Math.round(
                (zipProgress.done / Math.max(1, zipProgress.total)) * 100
              )}%`,
            }}
          />
        </div>
      )}

      {!loading && orders.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-secondary" />
            <input
              className="w-full ps-9 pe-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
              placeholder={t("invoices.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="px-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="newest">{t("invoices.sortNewestFirst")}</option>
            <option value="oldest">{t("invoices.sortOldestFirst")}</option>
            <option value="invoice_desc">{t("invoices.sortInvoiceHighToLow")}</option>
            <option value="invoice_asc">{t("invoices.sortInvoiceLowToHigh")}</option>
          </select>
        </div>
      )}

      {loading ? (
        <SkeletonList rows={6} />
      ) : orders.length === 0 ? (
        <EmptyState icon={FileBadge} title={t("invoices.noFinalizedInvoicesYet")} />
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title={t("invoices.noInvoicesMatchSearch")} />
      ) : (
        <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
          {visible.map((o) => (
            <button
              key={o.id}
              onClick={() => setViewing(o)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] text-left"
            >
              <div>
                <div className="text-subhead font-semibold">
                  {t("invoices.listRowTitle", {
                    invoice: o.invoice_number
                      ? t("invoices.hashInvoiceNumber", { n: o.invoice_number })
                      : t("invoices.noInvoiceNumber"),
                    customer: o.customer?.name ?? t("common.notSet"),
                  })}
                </div>
                <div className="text-caption text-secondary">
                  {t("invoices.deliveredOn", { date: new Date(o.billed_at ?? o.updated_at).toLocaleDateString() })}
                </div>
              </div>
              <a
                href={`/api/invoice-pdf?orderId=${o.id}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="p-1.5 text-secondary hover:text-accent shrink-0"
                aria-label={t("invoices.downloadInvoice")}
              >
                <Download size={16} />
              </a>
            </button>
          ))}
        </div>
      )}

      {viewing && (
        <Sheet
          open
          onClose={() => setViewing(null)}
          title={
            viewing.invoice_number
              ? t("invoices.invoiceNumberTitle", { n: viewing.invoice_number })
              : t("invoices.invoice")
          }
        >
          <div className="py-8 flex flex-col items-center gap-6">
            <a
              href={`/api/invoice-pdf?orderId=${viewing.id}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent font-semibold text-subhead"
            >
              {t("invoices.viewTaxInvoicePdf")}
            </a>

            <DeliveryProof invoiceNumber={viewing.invoice_number ?? null} />
          </div>
        </Sheet>
      )}
    </div>
  );
}


/**
 * Photos taken when the order was handed over.
 *
 * Fetched only when asked for rather than on opening the invoice: it is a
 * round trip to Drive, and most of the time somebody opening an invoice wants
 * the PDF.
 */
function DeliveryProof({ invoiceNumber }: { invoiceNumber: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [files, setFiles] = useState<
    { id: string; name: string; webViewLink: string; thumbnailLink: string | null }[]
  >([]);

  if (!invoiceNumber) return null;

  async function look() {
    setState("loading");
    try {
      const res = await fetch(`/api/orders/delivery-proof?invoiceNumber=${encodeURIComponent(invoiceNumber!)}`);
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch {
      setFiles([]);
    }
    setState("done");
  }

  if (state === "idle") {
    return (
      <button onClick={look} className="text-subhead font-semibold text-secondary hover:text-accent">
        {t("invoices.checkDeliveryProof")}
      </button>
    );
  }

  if (state === "loading") {
    return <span className="text-subhead text-secondary">{t("invoices.looking")}</span>;
  }

  if (files.length === 0) {
    return (
      <span className="text-caption text-secondary text-center max-w-[36ch]">
        {t("invoices.noProofPhotos")}
      </span>
    );
  }

  return (
    <div className="w-full">
      <div className="text-caption text-secondary mb-2 text-center">
        {files.length === 1 ? t("invoices.onePhoto") : t("invoices.nPhotos", { n: files.length })} {t("invoices.fromThisDelivery")}
      </div>
      <div className="flex flex-wrap gap-3 justify-center">
        {files.map((f) => (
          <a
            key={f.id}
            href={f.webViewLink}
            target="_blank"
            rel="noreferrer"
            className="block rounded-card overflow-hidden border border-hairline hover:border-accent/50 transition-colors"
            title={f.name}
          >
            {f.thumbnailLink ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={f.thumbnailLink} alt={f.name} className="w-28 h-28 object-cover" />
            ) : (
              <span className="w-28 h-28 grid place-items-center text-caption text-secondary px-2 text-center">
                {f.name}
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
