import { getAppUser } from "@/lib/auth";
import SettingsView from "@/components/settings/SettingsView";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getAppUser();
  if (!user) return null;
  return <SettingsView user={user} />;
}
