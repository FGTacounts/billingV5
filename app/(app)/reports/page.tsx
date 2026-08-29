import { redirect } from "next/navigation";
import { getAppUser } from "@/lib/auth";
import ReportsView from "@/components/reports/ReportsView";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const user = await getAppUser();
  if (!user) return null;
  if ((user.role !== "manager" && user.role !== "admin")) redirect("/dashboard");
  return <ReportsView />;
}
