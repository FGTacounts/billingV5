import { NextResponse } from "next/server";
import JSZip from "jszip";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { planInvoiceExport, buildInvoiceSlice, JobInputError } from "@/lib/job-runners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Manager-only bulk export (§1.9 "Per-row Download, 'Download All' bulk").
//
// THIS IS NOW THE FALLBACK, not the main path. Rule 8 says long-running work
// goes on a queue, and building up to 200 PDFs in one request is the clearest
// breach of it in the codebase — it is what dies at the platform timeout. The
// Invoices screen queues `invoices.zip` instead (lib/jobs-client.ts) and
// builds the file twenty invoices at a time.
//
// This route stays because a database where RUN-ME-23-job-queue.sql has not
// been run has no queue to put the work on, and the manager should still get
// their invoices. Same shape of retreat as fetchProductsServer() re-querying
// without the columns a migration has not added yet.
//
// The work itself lives in lib/job-runners.ts, so this and the worker cannot
// drift apart — and neither can either of them drift from the per-row
// /api/invoice-pdf route, which shares the same PDF builder.

export async function GET() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const supabase = supabaseCaller();

  try {
    const orderIds = await planInvoiceExport(supabase);
    const files = await buildInvoiceSlice(supabase, orderIds, []);

    const zip = new JSZip();
    for (const file of files) zip.file(file.name, Buffer.from(file.base64, "base64"));
    const zipBytes = await zip.generateAsync({ type: "uint8array" });

    return new NextResponse(Buffer.from(zipBytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="tax-invoices-${new Date()
          .toISOString()
          .slice(0, 10)}.zip"`,
      },
    });
  } catch (e) {
    if (e instanceof JobInputError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "The export failed" },
      { status: 500 }
    );
  }
}
