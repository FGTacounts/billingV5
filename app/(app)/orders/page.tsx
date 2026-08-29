import { getAppUser } from "@/lib/auth";
import OrdersView from "@/components/orders/OrdersView";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const user = await getAppUser();
  if (!user) return null;
  return <OrdersView user={user} scope="all" />;
}
