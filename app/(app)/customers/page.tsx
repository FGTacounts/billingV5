import { getAppUser } from "@/lib/auth";
import CustomersView from "@/components/customers/CustomersView";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const user = await getAppUser();
  if (!user) return null;
  return <CustomersView user={user} isManager={(user.role === "manager" || user.role === "admin")} />;
}
