import { getAppUser } from "@/lib/auth";
import ProductsView from "@/components/products/ProductsView";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const user = await getAppUser();
  if (!user) return null;
  return <ProductsView isManager={(user.role === "manager" || user.role === "admin")} user={user} />;
}
