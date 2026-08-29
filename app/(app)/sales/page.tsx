import { redirect } from "next/navigation";
import { getAppUser } from "@/lib/auth";
import SalesView from "@/components/sales/SalesView";

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const user = await getAppUser();
  if (!user) return null;
  if (user.role === "warehouse") redirect("/dashboard");
  return <SalesView user={user} />;
}
