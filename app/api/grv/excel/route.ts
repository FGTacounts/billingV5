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

  const grvId = req.nextUrl.searchParams.get("grvId") ?? undefined;
  const customers = await fetchGrvExport(supabaseCaller(), grvId);
  if (grvId && customers.length === 0) return NextResponse.json({ error: t("grvExcel.notFound") }, { status: 404 });

  const wb = buildGrvWorkbook(customers);
  const buffer = await wb.xlsx.writeBuffer();
  const single = grvId ? customers[0] : null;
  const fileName = single
    ? `${single.returns[0].label} ${single.name}`.replace(/[^\w .-]+/g, "").trim() || "GRV"
    : `GRV ${invoiceDate(new Date().toISOString())}`;
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}.xlsx"`,
    },
  });
}
