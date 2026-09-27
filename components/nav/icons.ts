"use client";

import {
  LayoutGrid,
  Users,
  Package,
  FileText,
  BarChart3,
  CreditCard,
  Banknote,
  FileBadge,
  PieChart,
  Settings,
  Route,
  type LucideIcon,
} from "lucide-react";
import type { NavIconKey } from "@/lib/nav";

export const NAV_ICONS: Record<NavIconKey, LucideIcon> = {
  dashboard: LayoutGrid,
  customers: Users,
  products: Package,
  orders: FileText,
  sales: BarChart3,
  expense: CreditCard,
  payments: Banknote,
  invoices: FileBadge,
  reports: PieChart,
  settings: Settings,
  planning: Route,
};
