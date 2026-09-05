import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Team news — one message a manager writes once and everybody sees.
//
// This is the same `news_posts` table the phone app already reads and writes,
// so a notice posted from either side reaches everyone. On a database that
// does not have the table yet, reading returns an empty list rather than
// breaking the bell, and posting says what is missing.

function missingTable(code?: string): boolean {
  return code === "42P01" || code === "PGRST205";
}

export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from("news_posts")
    .select("id, created_at, author, author_role, title, body")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return NextResponse.json({ news: [], supported: !missingTable(error.code) });
  return NextResponse.json({ news: data ?? [], supported: true });
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { title, body } = (await req.json()) as { title?: string; body?: string };
  const message = (body ?? "").trim();
  if (!message) return NextResponse.json({ error: "Write a message first." }, { status: 400 });

  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from("news_posts")
    .insert({
      posted_by: user.id,
      author: user.full_name,
      author_role: user.role,
      title: (title ?? "").trim(),
      body: message,
    })
    .select("id");
  if (error) {
    return NextResponse.json(
      {
        error: missingTable(error.code)
          ? "Team news isn't set up on the database yet. Ask your administrator."
          : error.message,
      },
      { status: 400 }
    );
  }
  // A write the database declines is not an error — it changes nothing and
  // reports success — so an empty result is the only sign it did not apply.
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "That didn't post. Ask your administrator." }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const supabase = supabaseServer();
  const { error } = await supabase.from("news_posts").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
