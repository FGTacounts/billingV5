import { redirect } from "next/navigation";
import { getAppUser } from "@/lib/auth";
import ExpenseView from "@/components/expense/ExpenseView";

export const dynamic = "force-dynamic";

export default async function ExpensePage() {
  const user = await getAppUser();
  if (!user) return null;
  if ((user.role !== "manager" && user.role !== "admin")) redirect("/dashboard");
  return <ExpenseView user={user} />;
}
