"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { motion } from "framer-motion";
import { springEnter, EASE_OUT, durations, usePrefersReducedMotion, respectMotion } from "@/lib/motion";

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();

  async function submit() {
    if (!username || !password) return;
    setLoading(true);
    setError(null);
    const supabase = supabaseBrowser();

    // Username maps to a synthetic address (§4) — computed directly rather
    // than looked up, so this works even though `users` correctly requires
    // authentication to read (no pre-login table access needed at all).
    // A real email (Order Flow & Additions §6/§10) needs one extra
    // server-side lookup first to resolve it back to a username, since the
    // actual Supabase Auth identity is always the synthetic address.
    let resolvedUsername = username.trim();
    if (resolvedUsername.includes("@")) {
      try {
        const res = await fetch("/api/auth/resolve-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: resolvedUsername }),
        });
        const data = await res.json();
        if (data.username) resolvedUsername = data.username;
      } catch {
        // fall through — try the typed value as-is
      }
    }
    const email = `${resolvedUsername.toLowerCase()}@fgtbilling.internal`;

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError("Unknown username or password.");
      setLoading(false);
      return;
    }

    router.replace("/");
    router.refresh();
  }

  return (
    <div className="relative min-h-[100dvh] grid place-items-center bg-gradient-to-br from-[#5ccaa6] to-[#2f8c70] p-6 overflow-hidden">
      {/* Two slow, very soft light blooms behind the gradient. They give the
          background depth without ever competing with the form — the sort of
          thing you notice only if it's missing. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-1/3 -left-1/4 w-[80vw] h-[80vw] max-w-[720px] max-h-[720px] rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(circle, rgba(255,255,255,0.55), transparent 65%)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-1/3 -right-1/4 w-[70vw] h-[70vw] max-w-[620px] max-h-[620px] rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(circle, rgba(255,255,255,0.4), transparent 65%)" }}
      />

      <motion.div
        className="relative w-full max-w-[380px] text-center"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={respectMotion(springEnter, reduced)}
      >
        <motion.div
          className="w-20 h-20 rounded-full bg-white/30 text-white text-4xl font-bold grid place-items-center mx-auto mb-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={respectMotion({ ...springEnter, delay: 0.06 }, reduced)}
        >
          F
        </motion.div>
        <h1 className="text-white text-[32px] font-bold tracking-[0.08em] m-0">
          FAMLIST
        </h1>
        <p className="text-white/85 mt-0.5 mb-7 tracking-wide">Billing System</p>

        <motion.div
          className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-sheet p-5 text-left shadow-overlay"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={respectMotion({ duration: durations.normal, ease: EASE_OUT, delay: 0.1 }, reduced)}
        >
          <label className="block text-[12px] font-semibold tracking-wide text-white/90 mt-3.5 mb-1.5">
            USERNAME OR EMAIL
          </label>
          <input
            className="w-full p-3 rounded-card border-none bg-white/20 text-white placeholder-white/60 outline-none focus:ring-2 focus:ring-white/60"
            placeholder="username or email"
            value={username}
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />

          <label className="block text-[12px] font-semibold tracking-wide text-white/90 mt-3.5 mb-1.5">
            PASSWORD
          </label>
          <input
            className="w-full p-3 rounded-card border-none bg-white/20 text-white placeholder-white/60 outline-none focus:ring-2 focus:ring-white/60"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />

          <button
            className="w-full mt-5 p-3.5 rounded-card border-none bg-white font-semibold text-base shadow-raised hover:shadow-floating disabled:opacity-60 disabled:shadow-none inline-flex items-center justify-center gap-2"
            style={{ color: "#2f8c70" }}
            disabled={loading || !username || !password}
            onClick={submit}
            type="button"
          >
            {loading && (
              <span
                aria-hidden
                className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"
              />
            )}
            {loading ? "Logging in…" : "Login"}
          </button>

          {/* The error shakes once rather than just appearing — a wrong
              password should be felt, not read. */}
          {error && (
            <motion.div
              className="mt-3.5 p-2.5 rounded-inner bg-red-500/30 border border-white/20 text-white text-[13px]"
              initial={reduced ? false : { opacity: 0, x: 0 }}
              animate={reduced ? {} : { opacity: 1, x: [0, -7, 6, -4, 2, 0] }}
              transition={reduced ? { duration: 0 } : { duration: 0.4, ease: EASE_OUT }}
            >
              {error}
            </motion.div>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}
