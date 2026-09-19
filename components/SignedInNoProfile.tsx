"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { t } from "@/lib/i18n";

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
        <h1 className="text-white text-[26px] font-bold m-0">{t("account.notSetUp")}</h1>
        <p className="text-white/85 mt-3 leading-relaxed">
          {t("account.noProfileExplanation")}
        </p>
        <button
          onClick={signOut}
          disabled={loading}
          className="w-full mt-6 p-3.5 rounded-card border-none bg-white text-[#2f8c70] font-semibold disabled:opacity-70"
        >
          {loading ? t("nav.signingOut") : t("nav.signOut")}
        </button>
      </div>
    </div>
  );
}
