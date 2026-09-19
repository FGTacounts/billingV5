import { redirect } from "next/navigation";

// The Picking tab is gone: the warehouse picks from Orders, which shows the
// same queue split into Waiting/Picking/Packed/Delivering stages instead of
// one flat list. Kept as a redirect so old bookmarks and the saved bottom-bar
// preference land somewhere useful rather than on a 404.
export default function PickingPage() {
  redirect("/orders");
}
