"use client";

import { useRef, useState } from "react";
import { Camera, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "@/lib/toast";
import { tap, tapSuccess } from "@/lib/haptics";
import { formatAed } from "@/lib/money";
import Sheet from "@/components/ui/Sheet";
import Button from "@/components/ui/Button";

// Reading a paper order with the camera. A deliberate, single-purpose
// control sitting with the other ways of adding lines (§0.4 rules out a
// floating camera button, so this is a button in the Items row like the
// barcode scanner and the photo picker beside it).
//
// Nothing is added to the order until the lines have been reviewed: the AI
// reads handwriting well but not perfectly, and a wrong quantity on an
// invoice is worse than typing it out.

export interface ScannedOrderLine {
  productId: string | null;
  sku: string;
  description: string;
  quantity: number;
  price: number;
  /** Set only when a price was actually written on the document. */
  scannedPrice: number | null;
  matched: boolean;
  scannedAs: string;
}

export default function ScanOrderButton({
  onLines,
}: {
  // Only matched lines are handed over — the caller resolves them against
  // the catalogue by id.
  onLines: (lines: ScannedOrderLine[], customer: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [lines, setLines] = useState<ScannedOrderLine[] | null>(null);
  const [customer, setCustomer] = useState<string | null>(null);

  function reset() {
    setLines(null);
    setError(null);
    setCustomer(null);
    setBusy(false);
    // The object URL is the only thing here holding memory.
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    setLines(null);
    setPreview(URL.createObjectURL(file));
    setOpen(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/scan-order", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "The scan failed");
      } else {
        setLines(data.lines ?? []);
        setCustomer(data.customer ?? null);
        tapSuccess();
      }
    } catch {
      setError("Couldn't reach the server while scanning.");
    }
    setBusy(false);
  }

  const matched = lines?.filter((l) => l.matched) ?? [];

  function use() {
    if (matched.length === 0) return;
    onLines(matched, customer);
    toast.success(`Added ${matched.length} line${matched.length === 1 ? "" : "s"} from the photo.`);
    close();
  }

  return (
    <>
      <button
        onClick={() => {
          tap();
          fileRef.current?.click();
        }}
        className="w-7 h-7 rounded-full border border-hairline grid place-items-center text-secondary hover:text-accent hover:border-accent/50"
        aria-label="Scan a written order"
        title="Scan a written order"
        type="button"
      >
        <Camera size={14} />
      </button>
      {/* capture="environment" opens the rear camera on a phone and a file
          picker on a desktop. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />

      {open && (
        <Sheet
          open
          onClose={() => !busy && close()}
          title="Scanned order"
          footer={
            <>
              <Button tier="plain" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button
                tier="plain"
                disabled={busy}
                onClick={() => {
                  reset();
                  fileRef.current?.click();
                }}
              >
                Take another
              </Button>
              <Button tier="primary" disabled={busy || matched.length === 0} onClick={use}>
                Add {matched.length} line{matched.length === 1 ? "" : "s"}
              </Button>
            </>
          }
        >
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="The document that was scanned"
              className="w-full max-h-56 object-contain rounded-card bg-canvas mb-4"
            />
          )}

          {busy && (
            <p className="text-subhead text-secondary py-4 text-center">
              Reading the handwriting. This takes a few seconds.
            </p>
          )}

          {error && (
            <div className="p-3 rounded-card bg-[--status-danger]/10 text-[--status-danger] text-subhead mb-3">
              {error}
            </div>
          )}

          {customer && (
            <p className="text-subhead mb-3">
              <span className="text-secondary">Customer read as</span>{" "}
              <span className="font-semibold">{customer}</span>
              <span className="text-caption text-secondary"> — pick the real customer above.</span>
            </p>
          )}

          {lines && lines.length > 0 && (
            <div className="border border-hairline rounded-card overflow-hidden">
              <table className="w-full text-subhead">
                <thead>
                  <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 font-medium text-center">Qty</th>
                    <th className="px-3 py-2 font-medium text-right tabular-nums">Price</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr
                      key={i}
                      className={`border-b border-hairline last:border-0 ${
                        l.matched ? "" : "bg-[--status-warning]/8"
                      }`}
                    >
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{l.description || l.sku}</div>
                        {l.matched ? (
                          <div className="text-caption text-secondary">{l.sku}</div>
                        ) : (
                          <div className="text-caption text-[--status-warning] flex items-center gap-1">
                            <AlertTriangle size={11} /> No product matches &ldquo;{l.scannedAs}&rdquo;
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <input
                          type="number"
                          min={1}
                          className="w-14 text-center tabular-nums px-1.5 py-1 rounded-inner border border-hairline bg-canvas"
                          value={l.quantity}
                          onChange={(e) => {
                            const qty = Math.max(1, Number(e.target.value) || 1);
                            setLines(
                              (prev) => prev && prev.map((x, idx) => (idx === i ? { ...x, quantity: qty } : x))
                            );
                          }}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatAed(l.price)}</td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => setLines((prev) => prev && prev.filter((_, idx) => idx !== i))}
                          className="text-secondary hover:text-[--status-danger]"
                          aria-label="Remove this line"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {lines && lines.length === 0 && !error && (
            <p className="text-subhead text-secondary py-4 text-center">
              No product lines were found. Try a straighter, better-lit photo.
            </p>
          )}

          {lines && matched.length < lines.length && (
            <p className="text-caption text-secondary mt-3">
              The highlighted lines match nothing in the catalogue and will be left out. Add
              them by hand, or correct the code on the product.
            </p>
          )}
        </Sheet>
      )}
    </>
  );
}
