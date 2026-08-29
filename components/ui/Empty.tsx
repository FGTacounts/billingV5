import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center rise-in">
      {/* The icon sits in a soft well rather than floating bare on the
          canvas, which stops an empty state reading as a failed render. */}
      <div className="w-14 h-14 rounded-full grid place-items-center bg-secondary/8 text-secondary">
        <Icon size={26} strokeWidth={1.5} />
      </div>
      <div className="text-subhead text-secondary max-w-[38ch]">{title}</div>
      {action}
    </div>
  );
}

export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  // `.skeleton` is a sweeping sheen (globals.css) rather than a flat pulse —
  // it reads as loading rather than as a broken grey box, and it collapses
  // to a static tint under prefers-reduced-motion.
  return <div className={`skeleton rounded-card ${className}`} style={style} />;
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-14 w-full"
          // Each row's sheen starts slightly later, so the sweep travels
          // down the list instead of every row flashing in lockstep.
          style={{ animationDelay: `${i * 90}ms` }}
        />
      ))}
    </div>
  );
}
