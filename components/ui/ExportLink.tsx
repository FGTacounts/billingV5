import { Download } from "lucide-react";

export default function ExportLink({ type, label = "Export Excel" }: { type: string; label?: string }) {
  return (
    <a
      href={`/api/export/excel?type=${type}`}
      className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent transition"
    >
      <Download size={14} /> {label}
    </a>
  );
}
