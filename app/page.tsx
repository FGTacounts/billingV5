import { redirect } from "next/navigation";
import { getAppUser, landingPathFor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getAppUser();
  redirect(user ? landingPathFor(user.role) : "/login");
}
