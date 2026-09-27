import type { OrderStatus } from "@/lib/types/db";

// An order is a sale from the moment it is approved: that is when it takes an
// invoice number, is billed, and comes off the shelf. There is no delivery
// step after it (owner, 2026-09-27).
//
// `delivering` and `delivered` are still here because orders from before the
// step was removed carry them, and they are sales like any other approved
// order. Nothing sets either status any more.
export const BILLED_STATUSES: OrderStatus[] = ["approved", "delivering", "delivered"];
