"use client";

import { Fragment, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { springLayout } from "@/lib/motion";
import { motion } from "framer-motion";
import { Minus, Plus, GripVertical, Check } from "lucide-react";
import { SIZE_SPAN, type WidgetSize } from "./WidgetArrange";
import { WIDGET_CATALOG, isCatalogKey } from "@/components/widgets/catalog";
import { WidgetContextMenu } from "./WidgetContextMenu";

// §Global Arrange: "users drag to move widgets; a minus sign on each widget
// removes it… the panel opens from the bottom of the screen, hides while
// dragging, reappears when stopped. Complete same functionality as Apple's
// widgets."
//
// Pointer-events based rather than HTML5 drag-and-drop, because HTML5 DnD
// doesn't fire on touch — this has to work on the iPad the salesmen use.
// Reordering happens live as you drag over a neighbour, so the layout
// settles under your finger the way iOS does it.

// Shows where a dragged widget would land.
function DropSlot() {
  return (
    <div className="lg:col-span-2 min-h-[336px] rounded-card border-2 border-dashed border-accent/60 bg-accent/8 grid place-items-center">
      <span className="text-subhead font-semibold text-accent">Drop here</span>
    </div>
  );
}

const CATEGORIES = ["Sales", "Customers", "Products", "Payments", "Expense"] as const;

export interface ArrangeGridProps<K extends string> {
  order: K[];
  hidden: K[];
  sizes: Record<K, WidgetSize>;
  labels: Record<K, string>;
  render: (key: K) => ReactNode;
  editing: boolean;
  onReorder: (next: K[]) => void;
  onToggleHidden: (key: K, insertAt?: number) => void;
  onChangeSize: (key: K, size: WidgetSize) => void;
  onDoneEditing: () => void;
  // Adds a widget borrowed from another tab (§Global Arrange). Omit to keep
  // the gallery limited to this page's own widgets.
  onAddFromCatalog?: (key: string, insertAt?: number) => void;
  // Widgets that are a strip of figures rather than a chart card. They keep
  // their natural height — forcing a chart's height on a row of stat tiles
  // leaves most of the card empty.
  autoHeightKeys?: readonly string[];
}


/**
 * A live, scaled-down render of the actual widget — so you can see what you
 * are about to place rather than guessing from a name like "categorySales".
 * The real component is rendered inside a fixed box and scaled with a
 * transform, and made inert so nothing inside it can be clicked or fetched
 * on interaction.
 */
function WidgetPreview({ children }: { children: ReactNode }) {
  return (
    <div className="w-[188px] h-[104px] rounded-inner overflow-hidden bg-canvas border border-hairline relative shrink-0">
      <div
        aria-hidden
        className="absolute top-0 left-0 origin-top-left pointer-events-none select-none"
        style={{ width: 470, height: 260, transform: "scale(0.4)" }}
      >
        {children}
      </div>
    </div>
  );
}

export function ArrangeGrid<K extends string>({
  order,
  hidden,
  sizes,
  labels,
  render,
  editing,
  onReorder,
  onToggleHidden,
  onChangeSize,
  onDoneEditing,
  onAddFromCatalog,
  autoHeightKeys = [],
}: ArrangeGridProps<K>) {
  const [dragKey, setDragKey] = useState<K | null>(null);
  // Dragging a widget OUT of the gallery and onto the page. Tracked separately
  // from reordering an existing widget: this one has no place in the grid yet,
  // so it follows the pointer as a ghost and we work out where it would land.
  const [galleryDrag, setGalleryDrag] = useState<
    { key: string; label: string; fromCatalog: boolean; x: number; y: number } | null
  >(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const visible = order.filter((k) => !hidden.includes(k));
  const hiddenKeys = order.filter((k) => hidden.includes(k));

  function handlePointerDown(e: React.PointerEvent, key: K) {
    if (!editing) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragKey(key);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragKey || !containerRef.current) return;
    // Which widget is under the pointer right now?
    const over = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => (el as HTMLElement).closest?.("[data-widget-key]"))
      .find(Boolean) as HTMLElement | undefined;
    const overKey = over?.dataset.widgetKey as K | undefined;
    if (!overKey || overKey === dragKey) return;

    const next = [...order];
    const from = next.indexOf(dragKey);
    const to = next.indexOf(overKey);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
  }

  function endDrag() {
    setDragKey(null);
  }

  // Where in the visible order would a drop at these coordinates land? Returns
  // the index to insert before, or the end of the list when the pointer is
  // past everything.
  function dropIndexAt(x: number, y: number): number {
    const cards = [...(containerRef.current?.querySelectorAll("[data-widget-key]") ?? [])];
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      // Before this card if the pointer is above its row, or left of its
      // midpoint while inside its row.
      if (y < r.top) return i;
      if (y <= r.bottom && x < r.left + r.width / 2) return i;
    }
    return cards.length;
  }

  function startGalleryDrag(
    e: React.PointerEvent,
    key: string,
    label: string,
    fromCatalog: boolean
  ) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setGalleryDrag({ key, label, fromCatalog, x: e.clientX, y: e.clientY });
  }

  function moveGalleryDrag(e: React.PointerEvent) {
    if (!galleryDrag) return;
    setGalleryDrag({ ...galleryDrag, x: e.clientX, y: e.clientY });
    // Only show a drop position once the pointer is actually over the grid.
    const grid = containerRef.current?.getBoundingClientRect();
    const overGrid =
      grid &&
      e.clientX >= grid.left &&
      e.clientX <= grid.right &&
      e.clientY >= grid.top &&
      e.clientY <= grid.bottom;
    setDropAt(overGrid ? dropIndexAt(e.clientX, e.clientY) : null);
  }

  function endGalleryDrag() {
    if (galleryDrag && dropAt !== null) {
      if (galleryDrag.fromCatalog) onAddFromCatalog?.(galleryDrag.key, dropAt);
      else onToggleHidden(galleryDrag.key as K, dropAt);
    }
    setGalleryDrag(null);
    setDropAt(null);
  }

  return (
    <>
      <div ref={containerRef} className="grid grid-cols-1 lg:grid-cols-4 gap-3 items-stretch">
        {visible.map((key, i) => (
          <Fragment key={`slot-${key}`}>
            {dropAt === i && <DropSlot />}
          <motion.div
            key={key}
            layout
            data-widget-key={key}
            transition={springLayout}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={`${
              autoHeightKeys.includes(key)
                ? SIZE_SPAN[sizes[key]].replace(/ ?min-h-\[[^\]]+\]/, "")
                : SIZE_SPAN[sizes[key]]
            } relative ${
              dragKey === key ? "opacity-60 z-20" : ""
            } ${editing ? "select-none" : ""}`}
            style={editing ? { touchAction: "none" } : undefined}
          >
            {editing && (
              <>
                {/* Remove — the minus badge, exactly the iOS affordance */}
                <button
                  onClick={() => onToggleHidden(key)}
                  className="absolute -top-2 -left-2 z-30 w-6 h-6 rounded-full bg-[--status-danger] text-white grid place-items-center shadow-floating"
                  aria-label={`Remove ${labels[key]}`}
                  title={`Remove ${labels[key]}`}
                >
                  <Minus size={14} />
                </button>
                {/* Drag handle */}
                <div
                  onPointerDown={(e) => handlePointerDown(e, key)}
                  className="absolute -top-2 -right-2 z-30 w-6 h-6 rounded-full bg-surface border border-hairline text-secondary grid place-items-center shadow-floating cursor-grab active:cursor-grabbing"
                  aria-label={`Drag ${labels[key]}`}
                  title="Drag to move"
                >
                  <GripVertical size={13} />
                </div>
                {/* The Q/H/F pills that used to float here are gone —
                    right-clicking the widget does sizing now, and three
                    overlapping pills on every card made arrange mode a mess. */}
              </>
            )}
            {/* Right-click (or long-press) any widget to resize or remove it,
                with no mode to enter — the rest of the page stays live. */}
            <WidgetContextMenu
              className={`h-full ${editing ? "pointer-events-none" : ""}`}
              size={sizes[key]}
              label={labels[key]}
              onChangeSize={(s) => onChangeSize(key, s)}
              onRemove={() => onToggleHidden(key)}
            >
              {render(key)}
            </WidgetContextMenu>
          </motion.div>
          </Fragment>
        ))}
        {dropAt !== null && dropAt >= visible.length && <DropSlot />}
      </div>

      {/* Follows the pointer while dragging a widget out of the gallery, so
          it is obvious something is being carried rather than just clicked. */}
      {galleryDrag &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-[80] pointer-events-none px-3 py-2 rounded-card surface-panel shadow-overlay text-subhead font-semibold"
            style={{ left: galleryDrag.x + 14, top: galleryDrag.y + 14 }}
          >
            {galleryDrag.label}
          </div>,
          document.body
        )}

      {/* Bottom gallery panel — the "widget gallery" of everything currently
          removed. Hides while a drag is in progress and comes back when it
          stops, per the spec. */}
      {editing && (
        <motion.div
          initial={{ y: 120, opacity: 0 }}
          animate={{ y: dragKey ? 160 : 0, opacity: dragKey ? 0 : 1 }}
          transition={springLayout}
          className="fixed left-0 right-0 bottom-0 z-40 md:pl-[var(--sidebar-w,0px)]"
        >
          <div className="mx-3 mb-3 md:mx-6 md:mb-6 glass rounded-sheet shadow-floating p-4">
            <div className="flex items-center justify-between mb-3 gap-3">
              <span className="text-headline font-semibold">Widget gallery</span>
              <button
                onClick={onDoneEditing}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-card bg-accent text-white text-caption font-semibold"
              >
                <Check size={14} /> Done
              </button>
            </div>
            <div className="max-h-[38vh] overflow-y-auto flex flex-col gap-3">
              {hiddenKeys.length > 0 && (
                <div>
                  <div className="text-caption text-secondary font-semibold uppercase tracking-wide mb-1.5">
                    This page
                  </div>
                  <div className="flex gap-3 flex-wrap">
                    {hiddenKeys.map((key) => (
                      <button
                        key={key}
                        onClick={() => onToggleHidden(key)}
                        onPointerDown={(e) => startGalleryDrag(e, key, labels[key], false)}
                        onPointerMove={moveGalleryDrag}
                        onPointerUp={endGalleryDrag}
                        onPointerCancel={endGalleryDrag}
                        title="Click to add, or drag onto the page"
                        className="group flex flex-col gap-1.5 p-2 rounded-card border border-hairline hover:border-accent/50 transition-colors hover:!opacity-100 touch-none cursor-grab active:cursor-grabbing"
                      >
                        <WidgetPreview>{render(key)}</WidgetPreview>
                        <span className="flex items-center gap-1.5 text-subhead group-hover:text-accent">
                          <Plus size={14} /> {labels[key]}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Widgets borrowed from other tabs, grouped by category. */}
              {onAddFromCatalog &&
                CATEGORIES.map((category) => {
                  const items = WIDGET_CATALOG.filter(
                    (w) => w.category === category && !order.includes(w.key as K)
                  );
                  if (items.length === 0) return null;
                  return (
                    <div key={category}>
                      <div className="text-caption text-secondary font-semibold uppercase tracking-wide mb-1.5">
                        {category}
                      </div>
                      <div className="flex gap-3 flex-wrap">
                        {items.map((w) => (
                          <button
                            key={w.key}
                            onClick={() => onAddFromCatalog(w.key)}
                            onPointerDown={(e) => startGalleryDrag(e, w.key, w.label, true)}
                            onPointerMove={moveGalleryDrag}
                            onPointerUp={endGalleryDrag}
                            onPointerCancel={endGalleryDrag}
                            title="Click to add, or drag onto the page"
                            className="group flex flex-col gap-1.5 p-2 rounded-card border border-hairline hover:border-accent/50 transition-colors hover:!opacity-100 touch-none cursor-grab active:cursor-grabbing"
                          >
                            <WidgetPreview>{w.render()}</WidgetPreview>
                            <span className="flex items-center gap-1.5 text-subhead group-hover:text-accent">
                              <Plus size={14} /> {w.label}
                            </span>
                            <span className="text-caption text-secondary text-left">from {w.from}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}

              {hiddenKeys.length === 0 && !onAddFromCatalog && (
                <p className="text-caption text-secondary">
                  Every widget is on the page. Tap a minus to take one off, drag the handle to move
                  it, or use the size buttons to make it quarter, half or full width.
                </p>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </>
  );
}
