import type { OrderStatus, ChequeStatus } from "@/lib/types/db";

type Tone = "accent" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASSES: Record<Tone, string> = {
  accent: "bg-accent/15 text-accent",
  warning: "bg-warning/15 text-[--status-warning]",
  danger: "bg-danger/15 text-[--status-danger]",
  info: "bg-info/15 text-[--status-info]",
  neutral: "bg-secondary/15 text-secondary",
};

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-caption font-semibold whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

const SQUARE_FILL: Record<Tone, string> = {
  accent: "bg-accent",
  warning: "bg-[--status-warning]",
  danger: "bg-[--status-danger]",
  info: "bg-[--status-info]",
  neutral: "bg-secondary/40",
};

// A solid color-coded square rather than a text pill (§Customers: "Status
// badge should be a square with color marking specific to each status") —
// sized/cornered to read clearly as a square (not shrink into a dot), with
// the status name printed beside it so it's legible at a glance, not just
// on hover.
export function StatusSquare({ tone, label, showLabel = true }: { tone: Tone; label: string; showLabel?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span
        className={`inline-block w-4 h-4 rounded-well shrink-0 ring-1 ring-black/10 dark:ring-white/15 ${SQUARE_FILL[tone]}`}
        role="img"
        aria-label={label}
      />
      {showLabel && <span className="text-caption font-medium text-secondary whitespace-nowrap">{label}</span>}
    </span>
  );
}

const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  draft: "neutral",
  pending: "warning",
  rejected: "danger",
  accepted: "info",
  waiting: "warning",
  picking: "warning",
  packed: "info",
  approved: "accent",
  edit_requested: "info",
  delivering: "info",
  delivered: "accent",
  cancelled: "neutral",
};

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Draft",
  pending: "Pending",
  rejected: "Rejected",
  accepted: "Accepted",
  waiting: "Waiting",
  picking: "Picking",
  packed: "Packed",
  approved: "Approved",
  edit_requested: "Edit requested",
  delivering: "Delivering",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function OrderStatusPill({ status }: { status: OrderStatus }) {
  return <Pill tone={ORDER_STATUS_TONE[status]}>{ORDER_STATUS_LABEL[status]}</Pill>;
}

const CHEQUE_TONE: Record<ChequeStatus, Tone> = {
  pending: "warning",
  cleared: "accent",
  bounced: "danger",
  returned: "danger",
};

export function ChequeStatusPill({ status }: { status: ChequeStatus }) {
  return <Pill tone={CHEQUE_TONE[status]}>{status[0].toUpperCase() + status.slice(1)}</Pill>;
}
