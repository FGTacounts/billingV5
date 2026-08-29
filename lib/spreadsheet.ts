import * as XLSX from "xlsx";

// One parser for csv/xls/xlsx alike (§Products: "support for all kinds of
// spreadsheet formats, csv, xls, xlsx…") — SheetJS reads all three from the
// same array-buffer entry point, so there's no format-specific branching.
// Header cells are normalized (lowercased, trimmed, spaces/dashes to
// underscores) so a human-typed sheet ("Stock On Hand", "Rack") lines up
// with the snake_case field names the import routes expect.
export async function parseSpreadsheetFile(file: File): Promise<Record<string, string>[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];

  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  if (rows.length === 0) return [];

  const headers = (rows[0] as string[]).map(normalizeHeader);
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => String(cell).trim() !== ""))
    .map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = String(row[i] ?? "").trim();
      });
      return obj;
    });
}

function normalizeHeader(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

// Client-side "download sample sheet" (§Products/§Customers: "give them an
// option to download sample data sheet") — a plain CSV with the header row
// (marking required columns) and one filled-in example row.
export function downloadSampleCsv(filename: string, headers: { key: string; required?: boolean }[], example: Record<string, string | number>) {
  const headerRow = headers.map((h) => (h.required ? `${h.key}*` : h.key)).join(",");
  const exampleRow = headers.map((h) => csvEscape(String(example[h.key] ?? ""))).join(",");
  const csv = `${headerRow}\n${exampleRow}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
