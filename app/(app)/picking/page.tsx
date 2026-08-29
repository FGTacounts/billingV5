import { redirect } from "next/navigation";
import { getAppUser } from "@/lib/auth";
import OrdersView from "@/components/orders/OrdersView";

export const dynamic = "force-dynamic";

export default async function PickingPage() {
  const user = await getAppUser();
  if (!user) return null;
  if (user.role !== "warehouse") redirect("/orders");
  return <OrdersView user={user} scope="picking" />;
}
