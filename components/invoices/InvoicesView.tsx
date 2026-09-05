"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useEffect, useState, useMemo } from "react";
import { FileBadge, Download, Search } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchOrders, type OrderRow } from "@/lib/queries/orders";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import Sheet from "@/components/ui/Sheet";

type SortKey = "newest" | "oldest" | "invoice_desc" | "invoice_asc";

export default function InvoicesView({ isManager }: { isManager: boolean }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<OrderRow | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
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
      case "newest": sorted.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()); break;
      case "oldest": sorted.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()); break;
      case "invoice_desc": sorted.sort((a, b) => Number(b.invoice_number ?? 0) - Number(a.invoice_number ?? 0)); break;
      case "invoice_asc": sorted.sort((a, b) => Number(a.invoice_number ?? 0) - Number(b.invoice_number ?? 0)); break;
    }
    return sorted;
  }, [orders, search, sortKey]);

  async function downloadAll() {
    setDownloadingAll(true);
    try {
      const res = await fetch("/api/invoices/download-all");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tax-invoices-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(friendlyError(e, "Download failed"));
    } finally {
      setDownloadingAll(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">Invoices</h1>
        {isManager && orders.length > 0 && (
          <button
            onClick={downloadAll}
            disabled={downloadingAll}
            className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent disabled:opacity-50"
          >
            <Download size={14} /> {downloadingAll ? "Zipping…" : "Download all"}
          </button>
        )}
      </div>

      {!loading && orders.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
            <input
              className="w-full pl-9 pr-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
              placeholder="Search customer or invoice #"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="px-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="invoice_desc">Invoice # (high to low)</option>
            <option value="invoice_asc">Invoice # (low to high)</option>
          </select>
        </div>
      )}

      {loading ? (
        <SkeletonList rows={6} />
      ) : orders.length === 0 ? (
        <EmptyState icon={FileBadge} title="No finalized invoices yet" />
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title="No invoices match your search" />
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
                  {o.invoice_number ? `#${o.invoice_number}` : "No invoice #"} — {o.customer?.name ?? "—"}
                </div>
                <div className="text-caption text-secondary">
                  Delivered {new Date(o.updated_at).toLocaleDateString()}
                </div>
              </div>
              <a
                href={`/api/invoice-pdf?orderId=${o.id}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="p-1.5 text-secondary hover:text-accent shrink-0"
                aria-label="Download invoice"
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
          title={viewing.invoice_number ? `Invoice #${viewing.invoice_number}` : "Invoice"}
        >
          <div className="py-8 flex flex-col items-center gap-6">
            <a
              href={`/api/invoice-pdf?orderId=${viewing.id}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent font-semibold text-subhead"
            >
              View Tax Invoice PDF
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
        Check delivery proof
      </button>
    );
  }

  if (state === "loading") {
    return <span className="text-subhead text-secondary">Looking&hellip;</span>;
  }

  if (files.length === 0) {
    return (
      <span className="text-caption text-secondary text-center max-w-[36ch]">
        No proof photos were taken for this delivery.
      </span>
    );
  }

  return (
    <div className="w-full">
      <div className="text-caption text-secondary mb-2 text-center">
        {files.length === 1 ? "1 photo" : `${files.length} photos`} from this delivery
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
