import { getAppUser } from "@/lib/auth";
import InvoicesView from "@/components/invoices/InvoicesView";

export const dynamic = "force-dynamic";

// Every role reaches this archive (§4: "same archive as every role" —
// downloading here always gets the Tax Invoice, regardless of who's
// looking). Only delivered orders appear; nothing here needs GP/cost.
export default async function InvoicesPage() {
  const user = await getAppUser();
  if (!user) return null;
  return <InvoicesView isManager={(user.role === "manager" || user.role === "admin")} />;
}
