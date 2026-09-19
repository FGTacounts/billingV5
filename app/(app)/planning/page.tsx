import { redirect } from "next/navigation";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appleMapsConfigured } from "@/lib/apple-maps";
import PlanningView from "@/components/planning/PlanningView";

export const dynamic = "force-dynamic";

export default async function PlanningPage() {
  const user = await getAppUser();
  if (!user) return null;
  if (user.role === "warehouse") redirect("/dashboard");

  // Direct-URL guard — the nav link is already hidden without a key, but a
  // typed-in URL shouldn't reach the feature either (§Next Updates: "hidden
  // for all users until the key is inputted").
  if (!appleMapsConfigured()) redirect("/dashboard");

  return <PlanningView user={user} />;
}
