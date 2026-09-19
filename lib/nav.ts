import type { UserRole } from "./types/db";
import { t } from "./i18n";

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
  | "delivery"
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
  dashboard: { href: "/dashboard", label: t("nav.dashboard"), icon: "dashboard" },
  customers: { href: "/customers", label: t("nav.customers"), icon: "customers" },
  products: { href: "/products", label: t("nav.products"), icon: "products" },
  orders: { href: "/orders", label: t("nav.orders"), icon: "orders" },
  // Delivery is a stage of Orders, not a screen of its own — this is a way to
  // reach it directly, the way the phone's warehouse has a Delivery section
  // (AppNavigation.WarehouseSection.delivery). The Orders page reads `stage`
  // and opens on that stage; nothing about the stage itself changes.
  delivery: { href: "/orders?stage=delivering", label: t("nav.delivery"), icon: "delivery" },
  sales: { href: "/sales", label: t("nav.sales"), icon: "sales" },
  expense: { href: "/expense", label: t("nav.expense"), icon: "expense" },
  payments: { href: "/payments", label: t("nav.payments"), icon: "payments" },
  invoices: { href: "/invoices", label: t("nav.invoices"), icon: "invoices" },
  reports: { href: "/reports", label: t("nav.reports"), icon: "reports" },
  settings: { href: "/settings", label: t("nav.settings"), icon: "settings" },
  planning: { href: "/planning", label: t("nav.planning"), icon: "planning" },
} satisfies Record<string, NavItem>;

// Not baked into BY_ROLE below — Planning's visibility is dynamic (only
// once a Manager/Admin has entered a Google Maps API key in Settings, §Next
// Updates: "remains hidden for all users until the key is inputted"), not a
// fixed per-role thing. app/(app)/layout.tsx checks server-side and splices
// this in for Salesman/Manager/Admin when a key is configured.
export const PLANNING_NAV_ITEM: NavItem = ALL.planning;

// Likewise dynamic: whether the business tracks a delivery step at all lives
// in `app_settings.delivery_enabled` (see lib/deliveryStep.ts). Where it is
// off, the Orders page has no Delivery stage, so the destination is dropped
// from the nav rather than pointing at a stage that is not there.
export const DELIVERY_NAV_ITEM: NavItem = ALL.delivery;

export function withoutDelivery(items: NavItem[]): NavItem[] {
  return items.filter((item) => item.href !== ALL.delivery.href);
}

const BY_ROLE: Record<UserRole, NavItem[]> = {
  // Customers, Payments, Invoices are accessible to every role (view/log-only
  // where the permission matrix says so) — Salesman/Warehouse just reach
  // them one tap deeper via the mobile "More" sheet / desktop sidebar rather
  // than the 4 primary tabs (see primaryNavFor/secondaryNavFor below).
  salesman: [ALL.dashboard, ALL.orders, ALL.sales, ALL.products, ALL.customers, ALL.payments, ALL.invoices, ALL.settings],
  warehouse: [ALL.dashboard, ALL.orders, ALL.products, ALL.delivery, ALL.customers, ALL.payments, ALL.invoices, ALL.settings],
  manager: [
    ALL.dashboard,
    ALL.customers,
    ALL.products,
    ALL.orders,
    ALL.delivery,
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
    ALL.delivery,
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

function matchesQuery(query: string, current: URLSearchParams): boolean {
  let matches = true;
  new URLSearchParams(query).forEach((value, key) => {
    if (current.get(key) !== value) matches = false;
  });
  return matches;
}

/**
 * Whether this destination is the one currently open.
 *
 * A destination can pin a query (`/orders?stage=delivering`), so the path
 * alone is no longer the whole answer: Delivery is open only when that
 * parameter is set, and plain Orders yields to it when it is, so the two
 * never light up together. `items` is the list being drawn, which is where
 * those siblings are looked for.
 */
export function isNavItemActive(
  item: NavItem,
  items: NavItem[],
  pathname: string,
  current: URLSearchParams
): boolean {
  const [path, query] = item.href.split("?");
  if (pathname !== path && !pathname.startsWith(path + "/")) return false;
  if (query) return matchesQuery(query, current);
  return !items.some((other) => {
    const [otherPath, otherQuery] = other.href.split("?");
    return Boolean(otherQuery) && otherPath === path && matchesQuery(otherQuery, current);
  });
}

// Mobile bottom bar shows at most 4 primary items per role (matches the
// native app's tab pattern); everything else sits one tap deeper behind a
// "More" sheet. Desktop's Sidebar ignores this split and shows navFor(role)
// in full — there's room for all of it there.
const PRIMARY_BY_ROLE: Record<UserRole, NavItem[]> = {
  salesman: [ALL.dashboard, ALL.orders, ALL.sales, ALL.products],
  warehouse: [ALL.dashboard, ALL.orders, ALL.products, ALL.customers],
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
