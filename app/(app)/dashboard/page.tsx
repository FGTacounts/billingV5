import { getAppUser } from "@/lib/auth";
import DashboardView from "@/components/dashboard/DashboardView";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getAppUser();
  if (!user) return null;
  return <DashboardView user={user} />;
}
