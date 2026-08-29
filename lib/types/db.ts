// Hand-written types matching the *confirmed* live Supabase schema (verified
// via PostgREST column probing with the service-role key — no SQL/dashboard
// access available). The schema was substantially redesigned once already
// during this build (leaner column set, several fields dropped entirely —
// see the plan doc / conversation for the diff). Treat this as the current
// source of truth; re-verify before assuming a field exists.

// Admin (§Next Updates: "new ADMIN role with full settings control...
// including managing Managers' own permissions") is a superset of Manager —
// every `role === "manager"` check in the app also accepts "admin" (see the
// paired `role !== "manager"` guards), so Admin gets identical access to
// everything Manager has, plus the Users tab can assign/edit Admin and
// Manager roles for anyone, including other managers.
export type UserRole = "salesman" | "manager" | "warehouse" | "admin";

export type OrderStatus =
  | "draft"
  | "pending"
  | "rejected"
  | "accepted"
  | "waiting"
  | "picking"
  | "packed"
  | "approved"
  | "edit_requested"
  | "delivering"
  | "delivered"
  | "cancelled";

export type PaymentStatus = "pending" | "confirmed";
export type ChequeStatus = "pending" | "cleared" | "bounced" | "returned";
export type ExtensionStatus = "pending" | "approved" | "rejected";
export type GrvStatus = "pending" | "approved";
export type ExpenseType = "fixed" | "variable" | "purchase";
export type DiscountType = "percent" | "amount";

export interface UserPreferences {
  theme?: "system" | "light" | "dark";
  dashboardLayout?: string[];
  averageSaleRangeDays?: number;
  // Custom date range (Dashboard §"average sales widget") — ISO date
  // strings (YYYY-MM-DD). Takes priority over averageSaleRangeDays when
  // both are set; cleared when the user picks a preset instead.
  averageSaleFrom?: string;
  averageSaleTo?: string;
  notificationsEnabled?: boolean;
  // Manager-only "Sheet View" setting (Order Flow & Additions §6/§7):
  // downloads default to article order; when true, picked/unpicked items
  // are separated instead.
  downloadSeparateMarked?: boolean;
  // Warehouse Picking screen's last-used sort/view (§8.4), remembered
  // per-user the same way averageSaleRangeDays already is.
  pickingSort?: "unpicked" | "article" | "rack";
  // "Sort/adjust-view" options the user has explicitly pinned as buttons
  // on the page — nothing shows by default (§Customers/§Products).
  pinnedCustomerFilters?: string[];
  // Real ascending/descending sort (§Customers: "sort options should
  // contain normal sort options such as highest to lowest, ascending to
  // descending") — separate from pinnedCustomerFilters above, which is the
  // All/Overdue/Excellent condition filter, not a sort order.
  pinnedCustomerSort?: string[];
  pinnedProductSort?: string[];
  // Adjust View (§Products) — which optional table columns are shown, and
  // which named default view (if any) is currently applied. Undefined
  // productColumns means "use the applied view's defaults", not "show
  // nothing" — see PRODUCT_VIEWS in ProductsView.tsx.
  productColumns?: string[];
  productView?: string;
  // User-saved Adjust View presets (§Next Updates: "allow creating custom
  // Adjust-View presets") — each is a {key,label,columns[]} tuple, same
  // shape as PRODUCT_VIEWS, applied via productView pointing at its key.
  productCustomViews?: { key: string; label: string; columns: string[] }[];
  // Expense (§Expense): fixed/variable/all/purchase sub-tabs are shown by
  // default under both Salesman and Overview — the user can remove them
  // via Adjust view. Undefined means "shown" (the default).
  expenseSubTabsVisible?: boolean;
  // Customers Adjust View (§Customers) — same pattern as productColumns/
  // productView above.
  customerColumns?: string[];
  customerView?: string;
  // Orders Adjust View (§Next Updates: "Adjust View option in the all
  // orders subtab") — same pattern as productColumns/customerColumns.
  ordersColumns?: string[];
  // Sales page Arrange (§Next Updates: "unify split-widget sizes with an
  // Arrange section") — same shape as dashboardLayout.
  salesLayout?: string[];
  // §Global: "Users can change the currency in the settings" — a display
  // conversion only, never what's actually stored/invoiced (always AED).
  displayCurrency?: string;
  // §Global: "user can choose default quick-download format: PDF, Excel, or
  // Both (both buttons appear per row); default is PDF only." Excel stays
  // Manager-only wherever it appears, same as every other Excel export.
  quickDownloadFormat?: "pdf" | "excel" | "both";
  // Dashboard widgets switched off in Arrange (§Dashboard: optional
  // widgets that are hidden by default).
  dashboardHidden?: string[];
  // §Global: navigation keyboard shortcuts — off by default; the scheme is
  // a "g then <key>" chord, with per-route keys remappable in Settings.
  navShortcutsEnabled?: boolean;
  navShortcutKeys?: Record<string, string>;
  // §Global: "colorful color theme option — uses colors to differentiate
  // between things." Off by default; colours repeating labels (categories,
  // expense types) by a stable per-label hue.
  colorfulData?: boolean;
  // Per-widget Full/Half/Quarter overrides, keyed by widget id.
  dashboardSizes?: Record<string, "full" | "half" | "quarter">;
  salesSizes?: Record<string, "full" | "half" | "quarter">;
}

export interface AppUser {
  id: string;
  auth_user_id: string;
  username: string;
  full_name: string;
  role: UserRole;
  email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Neither is selected by getAppUser() — that runs on every request, and
  // both columns may not exist until the preferences migration is run (see
  // scratchpad/preferences-migration.sql). Fetched separately, lazily,
  // wherever needed, so a missing column can't break auth app-wide.
  preferences?: UserPreferences | null;
  phone?: string | null;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  group_name: string | null;
  address: string | null;
  phone: string | null;
  district: string | null;
  vat_number: string | null;
  overdue_threshold_days: number; // per-customer override, defaults to 90 in DB
  is_active: boolean;
  created_at: string;
  updated_at: string;
  salesman_id: string | null; // assigned salesman
  // ISO 3166-1 alpha-2 (e.g. "AE") — resolves the customer's zone/VAT/
  // currency (§Global zones). May not exist until
  // scratchpad/zones-and-payer-details-migration.sql is run; optional so a
  // missing column never breaks a Customer fetch elsewhere.
  country_code?: string | null;
}

export interface ProductCategory {
  id: string;
  name: string;
}

export interface Product {
  id: string;
  sku: string;
  // The DB collapsed name+description into one `description` column
  // (Problems and Updates §Products: "Name and description of the product
  // is same thing — so only include description"). Mapped to `name` here
  // at the query layer (lib/queries/products.ts) so this stays the one
  // field every screen already reads/writes as the product's title —
  // avoids an app-wide rename across 8 files for what's really a DB-side
  // column rename.
  name: string;
  price: number;
  // No products_safe view anymore — Manager-only masking of cost/stock is
  // done by fetchProducts() selecting a narrower column list for
  // non-Manager roles, not by a safe view. null here means "not selected
  // for this caller's role," same meaning as before.
  cost: number | null;
  default_qty: number | null;
  barcode: string | null;
  rack_location: string | null;
  is_active: boolean;
  stock_on_hand: number | null;
  category: string | null; // new `Product_category` column
  // Manager-entered overrides for the four figures the app otherwise derives
  // from purchase/sales history (VAC, VAC China, stock arrival, stock
  // holding). null = "not set, keep computing it". Optional because the
  // columns don't exist until scratchpad/product-manual-fields-migration.sql
  // is run, and are never selected for non-Manager sessions.
  vac_override?: number | null;
  vac_china_override?: number | null;
  stock_arrival_date?: string | null; // ISO date; displayed as days-since
  stock_holding_days_override?: number | null;
}

export interface Order {
  id: string;
  status: OrderStatus;
  customer_id: string | null;
  salesman_id: string | null;
  new_customer_note: string | null;
  // Role-routed notes (§Orders: "if a salesman writes a note, it's for the
  // manager only; if a manager writes a note, it's either for the salesman
  // or the warehouse; if warehouse writes a note, it's for the manager
  // only") — three separate directed channels, not one shared field.
  warehouse_note: string | null; // Manager -> Warehouse
  manager_note: string | null; // Salesman or Warehouse -> Manager
  salesman_note: string | null; // Manager -> Salesman
  invoice_number: string | null; // DB column is `text`, not numeric
  // May not exist until scratchpad/customer-prices-rls-fix.sql is run —
  // optional so a missing column never breaks an order fetch.
  po_number?: string | null;
  rejected_at: string | null;
  total: number | null;
  subtotal: number | null;
  vat_amount: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  sku: string; // required (NOT NULL) — snapshot at order time
  description: string | null; // snapshot at order time
  unit_price: number;
  unit_cost: number | null; // null for non-Manager sessions (order_items_safe)
  ordered_qty: number;
  picked_qty: number | null;
  picked_by_id: string | null;
  picked_at: string | null;
  // order_items_safe doesn't expose created_at at all (confirmed live).
}

export interface OrderStatusLog {
  id: string;
  order_id: string;
  changed_by: string;
  changed_at: string;
}

export interface Payment {
  id: string;
  customer_id: string;
  collector_id: string; // who collected it (required)
  amount: number;
  status: PaymentStatus;
  cheque_number: string | null;
  cheque_bank: string | null;
  cheque_date: string | null;
  cheque_status: ChequeStatus | null;
  cheque_photo_ref: string | null; // Drive file reference
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentOrder {
  payment_id: string;
  order_id: string;
}

export interface PaymentDelayNote {
  id: string;
  order_id: string;
  note: string;
  added_by: string; // required
  created_at: string;
}

export interface PaymentExtensionRequest {
  id: string;
  order_id: string;
  requested_by: string;
  requested_due_date: string; // required — the new due date being asked for
  status: ExtensionStatus;
  approved_by: string | null;
  reason: string | null;
  created_at: string;
}

export interface GrvReturn {
  id: string;
  customer_id: string;
  submitted_by: string; // required — who logged the return
  status: GrvStatus;
  approved_by: string | null;
  created_at: string;
}

export interface GrvItem {
  id: string;
  grv_id: string;
  product_id: string;
  qty: number;
  unit_value: number; // required — value per unit at time of return
}

export interface Expense {
  id: string;
  type: ExpenseType;
  category: string | null;
  amount: number;
  description: string | null;
  notes: string | null;
  date: string;
  logged_by: string; // required
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string | null;
  body: string | null;
  is_read: boolean;
  created_at: string;
}

export interface CustomerPrice {
  customer_id: string;
  product_id: string;
  price: number;
  updated_at: string;
}

export interface CustomerDiscount {
  customer_id: string;
  discount_type: DiscountType;
  discount_value: number;
  updated_at: string;
}

// Single-row settings table (not key/value — confirmed via probing).
export interface AppSettings {
  id: number;
  product_photos_drive_folder_id: string | null;
  private_uploads_drive_folder_id: string | null;
  overdue_threshold_days: number;
  vat_rate: number;
  invoice_start_number: number;
  // Manager-configurable app-wide accent palette (§Next Updates) — may not
  // exist live yet, same "flag it, degrade gracefully" treatment as the
  // other recently-added columns.
  accent_theme?: string | null;
  // Google Maps API key for the Planning tab's route optimization (§Next
  // Updates: "hidden for all users until the key is inputted by the
  // manager/admin"). Server-only — never selected via the browser client,
  // only checked for presence in app/(app)/layout.tsx via supabaseAdmin()
  // and used server-side in app/api/planning/route.ts.
  google_maps_api_key?: string | null;
}
