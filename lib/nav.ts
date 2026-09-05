import type { UserRole } from "./types/db";

// Icon is a string key, not a component reference — a Server Component
// (app/(app)/layout.tsx) builds this list and hands it to Client Components
// (Sidebar/MobileNav), and passing a raw function/component across that
// boundary is a hard Next.js error ("Functions cannot be passed directly to
// Client Components"). The key is resolved to an actual Lucide icon
// client-side, in components/nav/icons.ts.
export type NavIconKey =
  | "dashboard"
  | "customers"
  | "products"
  | "orders"
  | "picking"
  | "sales"
  | "expense"
  | "payments"
  | "invoices"
  | "reports"
  | "settings"
  | "planning";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconKey;
}

const ALL = {
  dashboard: { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  customers: { href: "/customers", label: "Customers", icon: "customers" },
  products: { href: "/products", label: "Products", icon: "products" },
  orders: { href: "/orders", label: "Orders", icon: "orders" },
  picking: { href: "/picking", label: "Picking", icon: "picking" },
  sales: { href: "/sales", label: "Sales", icon: "sales" },
  expense: { href: "/expense", label: "Expense", icon: "expense" },
  payments: { href: "/payments", label: "Payments", icon: "payments" },
  invoices: { href: "/invoices", label: "Invoices", icon: "invoices" },
  reports: { href: "/reports", label: "Reports", icon: "reports" },
  settings: { href: "/settings", label: "Settings", icon: "settings" },
  planning: { href: "/planning", label: "Planning", icon: "planning" },
} satisfies Record<string, NavItem>;

// Not baked into BY_ROLE below — Planning's visibility is dynamic (only
// once a Manager/Admin has entered a Google Maps API key in Settings, §Next
// Updates: "remains hidden for all users until the key is inputted"), not a
// fixed per-role thing. app/(app)/layout.tsx checks server-side and splices
// this in for Salesman/Manager/Admin when a key is configured.
export const PLANNING_NAV_ITEM: NavItem = ALL.planning;

const BY_ROLE: Record<UserRole, NavItem[]> = {
  // Customers, Payments, Invoices are accessible to every role (view/log-only
  // where the permission matrix says so) — Salesman/Warehouse just reach
  // them one tap deeper via the mobile "More" sheet / desktop sidebar rather
  // than the 4 primary tabs (see primaryNavFor/secondaryNavFor below).
  salesman: [ALL.dashboard, ALL.orders, ALL.sales, ALL.products, ALL.customers, ALL.payments, ALL.invoices, ALL.settings],
  warehouse: [ALL.dashboard, ALL.orders, ALL.picking, ALL.products, ALL.customers, ALL.payments, ALL.invoices, ALL.settings],
  manager: [
    ALL.dashboard,
    ALL.customers,
    ALL.products,
    ALL.orders,
    ALL.sales,
    ALL.expense,
    ALL.payments,
    ALL.invoices,
    ALL.reports,
    ALL.settings,
  ],
  // Admin is a copy of Manager's nav — every page Manager can reach, Admin
  // can too, plus the Users tab (already Manager-visible) gets Admin-only
  // capabilities once inside Settings.
  admin: [
    ALL.dashboard,
    ALL.customers,
    ALL.products,
    ALL.orders,
    ALL.sales,
    ALL.expense,
    ALL.payments,
    ALL.invoices,
    ALL.reports,
    ALL.settings,
  ],
};

export function navFor(role: UserRole): NavItem[] {
  return BY_ROLE[role];
}

// Mobile bottom bar shows at most 4 primary items per role (matches the
// native app's tab pattern); everything else sits one tap deeper behind a
// "More" sheet. Desktop's Sidebar ignores this split and shows navFor(role)
// in full — there's room for all of it there.
const PRIMARY_BY_ROLE: Record<UserRole, NavItem[]> = {
  salesman: [ALL.dashboard, ALL.orders, ALL.sales, ALL.products],
  warehouse: [ALL.dashboard, ALL.orders, ALL.picking, ALL.products],
  manager: [ALL.dashboard, ALL.orders, ALL.customers, ALL.sales],
  admin: [ALL.dashboard, ALL.orders, ALL.customers, ALL.sales],
};

/** How many destinations fit across the bottom bar before it gets cramped. */
export const MAX_PRIMARY_NAV = 4;

/**
 * The destinations in the bottom bar.
 *
 * `chosen` is the user's own selection from Settings, kept as hrefs. Anything
 * in it that this role cannot reach is ignored rather than trusted — the list
 * is a display preference, never a grant of access.
 */
export function primaryNavFor(role: UserRole, chosen?: string[]): NavItem[] {
  const allowed = BY_ROLE[role];
  if (chosen && chosen.length > 0) {
    const picked = chosen
      .map((href) => allowed.find((i) => i.href === href))
      .filter((i): i is NavItem => Boolean(i))
      .slice(0, MAX_PRIMARY_NAV);
    if (picked.length > 0) return picked;
  }
  return PRIMARY_BY_ROLE[role];
}

/** Everything else, reached through More. */
export function secondaryNavFor(role: UserRole, chosen?: string[]): NavItem[] {
  const primaryHrefs = new Set(primaryNavFor(role, chosen).map((i) => i.href));
  return BY_ROLE[role].filter((i) => !primaryHrefs.has(i.href));
}
