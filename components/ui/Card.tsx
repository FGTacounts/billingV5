import type { HTMLAttributes } from "react";

export function Card({
  className = "",
  interactive = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  // Cards that are themselves a control (clickable widgets, list tiles)
  // lift slightly on hover and give under a press. Static cards stay put —
  // a surface that reacts to the pointer without doing anything is noise.
  interactive?: boolean;
}) {
  const motionClasses = interactive
    ? "transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-floating active:translate-y-0 active:scale-[0.995] active:duration-75 cursor-pointer"
    : "";
  return <div className={`glass rounded-card ${motionClasses} ${className}`} {...props} />;
}

export function CardHeader({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-hairline">
      <div className="text-headline font-semibold">{title}</div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="p-5">
      <div className="text-caption text-secondary">{label}</div>
      <div className="text-title font-bold mt-1.5 tabular-nums">{value}</div>
      {sub && <div className="text-caption text-secondary mt-1">{sub}</div>}
    </Card>
  );
}
