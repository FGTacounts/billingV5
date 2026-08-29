import { redirect } from "next/navigation";
import { getAppUser, hasAuthSession, landingPathFor } from "@/lib/auth";
import LoginForm from "@/components/LoginForm";
import SignedInNoProfile from "@/components/SignedInNoProfile";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getAppUser();
  if (user) redirect(landingPathFor(user.role));

  // A Supabase Auth session exists but has no matching `users` row — show a
  // clear message instead of silently re-rendering the login form (which
  // would look like the password was wrong) or bouncing back and forth with
  // middleware forever.
  if (await hasAuthSession()) return <SignedInNoProfile />;

  return <LoginForm />;
}
