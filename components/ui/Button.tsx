"use client";

import type { ButtonHTMLAttributes } from "react";

type Tier = "primary" | "tinted" | "plain" | "danger";

// Each tier gets its own hover treatment rather than all of them relying on
// the global opacity fade — a filled button should deepen, a tinted one
// should gain tint, and a plain one should gain text contrast. The shared
// press scale lives in globals.css so one-off buttons behave the same.
const TIER_CLASSES: Record<Tier, string> = {
  primary:
    "bg-accent text-white font-semibold shadow-raised hover:bg-accent-strong hover:shadow-floating hover:!opacity-100",
  tinted:
    "bg-accent/12 text-accent font-semibold hover:bg-accent/18 hover:!opacity-100",
  plain:
    "bg-transparent text-secondary font-medium hover:text-primary hover:bg-primary/[0.04] hover:!opacity-100",
  danger:
    "bg-[--status-danger] text-white font-semibold shadow-raised hover:brightness-95 hover:shadow-floating hover:!opacity-100",
};

export default function Button({
  tier = "tinted",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tier?: Tier }) {
  return (
    <button
      className={`px-4 py-2.5 rounded-card text-subhead select-none transition-[background-color,box-shadow,color,transform,filter] duration-150 ease-out disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none ${TIER_CLASSES[tier]} ${className}`}
      {...props}
    />
  );
}
