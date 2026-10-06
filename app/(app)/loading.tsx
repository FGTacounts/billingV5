import { Skeleton, SkeletonList } from "@/components/ui/Empty";

// Shown the instant a page is clicked, while the server checks who is signed
// in and builds the page. Without it the old screen sat there unchanged until
// the new one arrived, which read as the app not having heard the click.
// The sidebar and top bar stay put — this only fills the content area, with
// the same title bar and rows each screen shows while its own data loads.
export default function Loading() {
  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto" aria-busy="true">
      <Skeleton className="h-8 w-40 mb-2" />
      <SkeletonList rows={6} />
    </div>
  );
}
