import { redirect } from "next/navigation";
import { getAppUser } from "@/lib/auth";
import { navFor, primaryNavFor, secondaryNavFor, PLANNING_NAV_ITEM } from "@/lib/nav";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appleMapsConfigured } from "@/lib/apple-maps";
import Sidebar from "@/components/nav/Sidebar";
import MobileNav from "@/components/nav/MobileNav";
import Topbar from "@/components/nav/Topbar";
import OfflineSyncBanner from "@/components/OfflineSyncBanner";
import PageTransition from "@/components/nav/PageTransition";
import Toaster from "@/components/ui/Toaster";

export const dynamic = "force-dynamic";

// Server-only check — no credential reaches the client, only this boolean
// (§Next Updates Planning: "remains hidden for all users until the key is
// inputted"). Now keyed on the Apple Maps credentials in the environment,
// since route planning runs on Apple Maps.
async function isMapsConfigured(): Promise<boolean> {
  return appleMapsConfigured();
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getAppUser();
  if (!user) redirect("/login");

  const mapsConfigured =
    user.role === "salesman" || user.role === "manager" || user.role === "admin"
      ? await isMapsConfigured()
      : false;

  // Spread into new arrays — navFor()/secondaryNavFor() return references
  // into the module-level BY_ROLE map, and mutating those would leak across
  // every subsequent request in this process.
  const items = [...navFor(user.role)];
  const primary = primaryNavFor(user.role);
  const secondary = [...secondaryNavFor(user.role)];
  if (mapsConfigured) {
    items.push(PLANNING_NAV_ITEM);
    secondary.push(PLANNING_NAV_ITEM);
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <Sidebar items={items} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar user={user} />
        <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
          <PageTransition>{children}</PageTransition>
        </main>
        <Toaster />
      </div>
      <MobileNav primary={primary} secondary={secondary} />
      {(user.role === "warehouse" || (user.role === "manager" || user.role === "admin")) && <OfflineSyncBanner />}
    </div>
  );
}
