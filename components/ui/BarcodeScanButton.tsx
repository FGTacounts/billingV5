"use client";

import { toast } from "@/lib/toast";
import { useEffect, useRef, useState } from "react";
import { ScanBarcode, X } from "lucide-react";

// Browser-native BarcodeDetector (Chrome/Edge/Android; no Safari support as
// of this build) instead of pulling in a JS decoding library — keeps this
// deliberate, single-purpose control (§0.4: "no floating scan/camera button
// anywhere — explicitly removed") cheap to ship and easy to rip out.
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => {
      detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
    };
  }
}

export default function BarcodeScanButton({ onScan }: { onScan: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef(false);

  const supported = typeof window !== "undefined" && "BarcodeDetector" in window;

  async function start() {
    if (!supported) {
      toast.error("Barcode scanning isn't supported in this browser — try Chrome, or search by SKU/name instead.");
      return;
    }
    setError(null);
    setOpen(true);
    stopRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new window.BarcodeDetector!({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"],
      });
      const loop = async () => {
        if (stopRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          if (codes.length > 0) {
            onScan(codes[0].rawValue);
            stop();
            return;
          }
        } catch {
          // transient decode errors are normal mid-scan — just keep trying
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch {
      setError("Camera access denied or unavailable.");
    }
  }

  function stop() {
    stopRef.current = true;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setOpen(false);
  }

  useEffect(() => () => stop(), []);

  return (
    <>
      <button
        type="button"
        onClick={start}
        className="p-2.5 rounded-full border border-hairline text-secondary hover:text-accent shrink-0"
        aria-label="Scan barcode"
        title="Scan barcode"
      >
        <ScanBarcode size={15} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6">
          <div className="bg-surface rounded-card overflow-hidden max-w-sm w-full">
            <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
              <span className="text-subhead font-semibold">Scan barcode</span>
              <button onClick={stop} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="aspect-square bg-black relative">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
            </div>
            {error && <div className="px-4 py-3 text-caption text-[--status-danger]">{error}</div>}
          </div>
        </div>
      )}
    </>
  );
}
