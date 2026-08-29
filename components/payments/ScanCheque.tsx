"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X, Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";

const UAE_BANKS = [
  "ENBD", "EMIRATES NBD", "ADCB", "ABU DHABI COMMERCIAL", "FAB", "FIRST ABU DHABI",
  "RAK BANK", "RAKBANK", "CBD", "COMMERCIAL BANK OF DUBAI", "MASHREQ", "DIB",
  "DUBAI ISLAMIC", "ADIB", "ABU DHABI ISLAMIC", "HSBC", "CITI", "NBF", "SIB",
  "SHARJAH ISLAMIC", "UNB", "UNION NATIONAL",
];

interface Parsed {
  bank: string | null;
  chequeNumber: string | null;
  date: string | null;
  amount: number | null;
  photo: Blob | null;
}

function parseChequeText(text: string): Omit<Parsed, "photo"> {
  const upper = text.toUpperCase();
  const bank = UAE_BANKS.find((b) => upper.includes(b)) ?? null;

  const dateMatch = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  let date: string | null = null;
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    const year = y.length === 2 ? `20${y}` : y;
    date = `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const numMatch = text.match(/\b(\d{6,10})\b/);
  const chequeNumber = numMatch ? numMatch[1] : null;

  // Amount Box (§Parts of a Check: "$ 10.00") — the numeric figure is far
  // more reliably OCR'd than the handwritten Amount Line words, so it's the
  // primary source. Falls back to a bare "12.00"-shaped number near a
  // currency marker (AED/DHS) for cheques without a "$" glyph.
  let amount: number | null = null;
  const dollarMatch = text.match(/\$\s*([\d,]+\.\d{2})/);
  const aedMatch = text.match(/\b(?:AED|DHS)\s*([\d,]+\.\d{2})/i);
  const raw = dollarMatch?.[1] ?? aedMatch?.[1];
  if (raw) {
    const n = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) amount = n;
  }

  return { bank, chequeNumber, date, amount };
}

export default function ScanCheque({
  onScanned,
  onClose,
}: {
  onScanned: (data: Parsed) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => setError("Camera access denied. Use a file instead."));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  async function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    await runOcr(canvas);
  }

  async function runOcr(canvas: HTMLCanvasElement) {
    setScanning(true);
    setProgress(0);
    try {
      const photo = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85)
      );
      const Tesseract = await import("tesseract.js");
      const { data } = await Tesseract.recognize(canvas, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text") setProgress(Math.round(m.progress * 100));
        },
      });
      onScanned({ ...parseChequeText(data.text), photo });
    } catch {
      setError("Couldn't read the cheque — enter details manually.");
    } finally {
      setScanning(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = async () => {
      const canvas = canvasRef.current!;
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      await runOcr(canvas);
    };
    img.src = URL.createObjectURL(file);
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black flex flex-col">
      <div className="flex items-center justify-between p-4 text-white">
        <span className="text-subhead font-medium">Scan cheque</span>
        <button onClick={onClose}><X size={20} /></button>
      </div>
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {error ? (
          <div className="text-white text-center px-6">
            <p className="mb-3">{error}</p>
            <label className="inline-block px-4 py-2.5 rounded-card bg-white text-black font-medium cursor-pointer transition-opacity hover:opacity-85 active:opacity-70">
              Choose photo
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
            </label>
          </div>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="max-w-full max-h-full" />
        )}
        {scanning && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-white gap-2">
            <Loader2 className="animate-spin" size={28} />
            <span className="text-subhead">Reading cheque… {progress}%</span>
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      {!error && (
        <div className="p-5 flex justify-center">
          <button
            onClick={capture}
            disabled={scanning}
            className="w-16 h-16 rounded-full bg-white grid place-items-center disabled:opacity-50"
          >
            <Camera size={26} className="text-black" />
          </button>
        </div>
      )}
    </div>
  );
}
