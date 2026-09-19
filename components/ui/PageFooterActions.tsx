import type { ReactNode } from "react";

/**
 * A quiet strip at the foot of a page for the actions people reach for
 * rarely — Arrange, Import, Export, sample downloads.
 *
 * The top of a page is the most valuable space on it, and it should carry
 * the one thing you came to do. Utilities that get used once a month were
 * competing with that; down here they are still one glance away without
 * taxing every visit.
 */
export default function PageFooterActions({
  children,
  note,
}: {
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="mt-8 pt-5 border-t border-hairline flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
      {children}
      {note && <p className="w-full text-center text-caption text-secondary">{note}</p>}
    </div>
  );
}
