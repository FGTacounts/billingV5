import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// §Orders: role-routed notes. Each field can only be written by the role(s)
// that channel is actually from — Warehouse/Salesman can set manager_note
// (their outbound note to the Manager); only a Manager can set
// warehouse_note/salesman_note (their outbound notes to those roles).
const FIELDS = ["manager_note", "warehouse_note", "salesman_note"] as const;
type NoteField = (typeof FIELDS)[number];

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const { orderId, field, text } = (await req.json()) as { orderId: string; field: NoteField; text: string };
  if (!orderId || !FIELDS.includes(field)) {
    return NextResponse.json({ error: t("orders.orderIdAndFieldRequired") }, { status: 400 });
  }

  const isManager = user.role === "manager" || user.role === "admin";
  if (field === "manager_note") {
    if (!(isManager || user.role === "warehouse" || user.role === "salesman")) {
      return NextResponse.json({ error: t("orders.notAllowed") }, { status: 403 });
    }
  } else if (!isManager) {
    return NextResponse.json({ error: t("orders.onlyManagerCanSetNote") }, { status: 403 });
  }

  const supabase = supabaseCaller();
  const { error } = await supabase.from("orders").update({ [field]: text.trim() || null }).eq("id", orderId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
