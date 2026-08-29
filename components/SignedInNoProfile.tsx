"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function SignedInNoProfile() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function signOut() {
    setLoading(true);
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="min-h-[100dvh] grid place-items-center bg-gradient-to-br from-[#5ccaa6] to-[#2f8c70] p-6">
      <div className="w-full max-w-[420px] text-center">
        <div className="w-20 h-20 rounded-full bg-white/30 text-white text-4xl font-bold grid place-items-center mx-auto mb-2.5">
          !
        </div>
        <h1 className="text-white text-[26px] font-bold m-0">Account not set up</h1>
        <p className="text-white/85 mt-3 leading-relaxed">
          You're signed in, but there's no FGT Billing profile linked to this account yet.
          Ask your Manager to add you in Settings &rarr; Users, or check that your account
          was created correctly.
        </p>
        <button
          onClick={signOut}
          disabled={loading}
          className="w-full mt-6 p-3.5 rounded-card border-none bg-white text-[#2f8c70] font-semibold disabled:opacity-70"
        >
          {loading ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
