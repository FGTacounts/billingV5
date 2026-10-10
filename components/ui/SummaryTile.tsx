import { Skeleton } from "@/components/ui/Empty";

// One figure in a page's summary card (Expenses, Customers): a label, the
// number, and a line under it. Drawn the same as the tiles in the Products
// summary. `value` undefined means the figure is still loading.
export function SummaryTile({ label, value, sub }: { label: string; value?: string; sub?: string }) {
  return (
    <div className="rounded-card border border-hairline p-3 min-w-0">
      <div className="text-caption text-secondary">{label}</div>
      {value === undefined ? (
        <>
          <Skeleton className="h-7 w-3/4 mt-1.5" />
          <Skeleton className="h-4 w-1/2 mt-1.5" />
        </>
      ) : (
        <>
          {/* Never cut short: on a phone the figure is set a size down, and
              a long one wraps after "AED" rather than losing its end. */}
          <div className="text-headline sm:text-title font-bold mt-1 tabular-nums">{value}</div>
          {sub && <div className="text-caption text-secondary mt-0.5 tabular-nums">{sub}</div>}
        </>
      )}
    </div>
  );
}

// The ranked list beside the tiles. `rows` undefined means still loading.
// A row is its rank, a name (with an optional quieter note after it), a small
// detail and an amount. One grid for the whole list, so the figures line up
// down the rows whatever their length. On a phone the detail gives its room
// to the name.
export function SummaryList<T>({
  title,
  rows,
  empty,
  keyOf,
  name,
  note,
  detail,
  amount,
}: {
  title: string;
  rows?: T[];
  empty: string;
  keyOf: (row: T) => string;
  name: (row: T) => string;
  note?: (row: T) => string;
  detail: (row: T) => string;
  amount: (row: T) => string;
}) {
  return (
    <div className="rounded-card border border-hairline p-3 min-w-0">
      <div className="text-caption font-semibold text-secondary mb-2">{title}</div>
      {!rows ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-subhead text-secondary py-2">{empty}</div>
      ) : (
        <ol className="grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-3">
          {rows.map((row, i) => (
            <li
              key={keyOf(row)}
              className="col-span-full grid grid-cols-subgrid items-baseline py-1.5 border-b border-hairline last:border-b-0"
            >
              <span className="text-caption text-secondary tabular-nums">{i + 1}</span>
              <span className="min-w-0 truncate">
                <span className="text-subhead font-semibold">{name(row)}</span>
                {note?.(row) && <span className="text-caption text-secondary ms-2">{note(row)}</span>}
              </span>
              <span className="hidden sm:block text-caption text-secondary tabular-nums whitespace-nowrap text-end">
                {detail(row)}
              </span>
              <span className="text-subhead font-semibold tabular-nums whitespace-nowrap text-end">{amount(row)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
