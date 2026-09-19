import { getAppUser } from "@/lib/auth";
import PaymentsView from "@/components/payments/PaymentsView";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const user = await getAppUser();
  if (!user) return null;
  return <PaymentsView user={user} />;
}
