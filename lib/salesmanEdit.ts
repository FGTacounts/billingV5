// When a salesman may change the lines of an order.
//
// Their own order while it is a draft or pending — and, since 2026-10-12,
// while it is in picking (owner: "change for the web", so the web allows what
// the phone and the Mac always have). Picking is where an order lands when a
// manager grants an edit request, which is the point: the salesman who asked
// can then make the change. Stock has not moved at that stage (approval
// moves it), so a changed line needs nothing else changed with it.
//
// One copy of the rule, for the three line routes (update-item, add-item,
// remove-item) and for the order screen that decides what to offer.

export const SALESMAN_EDITABLE_STATUSES = ["draft", "pending", "picking"];

/** A salesman's own order, at the one stage past acceptance where it is theirs to change. */
export function isOwnOrderInPicking(
  order: { status: string; salesman_id: string | null },
  user: { id: string; role: string }
): boolean {
  return order.status === "picking" && user.role === "salesman" && order.salesman_id === user.id;
}
