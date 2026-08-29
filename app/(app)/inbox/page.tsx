import { redirect } from "next/navigation";
import { getAppUser } from "@/lib/auth";
import InboxView from "@/components/inbox/InboxView";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const user = await getAppUser();
  if (!user) redirect("/login");
  return <InboxView user={user} />;
}
