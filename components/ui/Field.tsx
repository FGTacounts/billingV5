import type { InputHTMLAttributes } from "react";

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-caption font-semibold text-secondary mt-3.5 mb-1.5">
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-primary text-subhead outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition ${props.className ?? ""}`}
    />
  );
}

export function Recommended({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-caption text-accent font-medium mt-1">
      Recommended: {children}
    </div>
  );
}
