import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { fetchGrvExport } from "@/lib/queries/grv";
import { buildGrvWorkbook } from "@/lib/grvExcel";
import { invoiceDate } from "@/lib/invoice-template";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Goods returns (GRV) as a spreadsheet, laid out by lib/grvExcel.ts.
// `grvId` exports one return; without it, every return, one block per
// customer. Read through the caller's own session, so it shows exactly
// the returns, customers and products that person can already see.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const grvId = params.get("grvId") ?? undefined;
  // `from` / `to` (instants) limit "every return" to a period — Reports →
  // GRV sends the one its picker shows. Without them, every return.
  const from = params.get("from");
  const to = params.get("to");
  const period =
    from && to && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to))
      ? { from: new Date(from), to: new Date(to) }
      : undefined;
  const customers = await fetchGrvExport(supabaseCaller(), grvId, period);
  if (grvId && customers.length === 0) return NextResponse.json({ error: t("grvExcel.notFound") }, { status: 404 });

  const wb = buildGrvWorkbook(customers);
  const buffer = await wb.xlsx.writeBuffer();
  const single = grvId ? customers[0] : null;
  const fileName = single
    ? `${single.returns[0].label} ${single.name}`.replace(/[^\w .-]+/g, "").trim() || "GRV"
    : period
      ? `GRV ${invoiceDate(period.from.toISOString())} - ${invoiceDate(period.to.toISOString())}`
      : `GRV ${invoiceDate(new Date().toISOString())}`;
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}.xlsx"`,
    },
  });
}
