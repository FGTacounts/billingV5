"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";

// Finds the nearest scrollable ancestor so this works wherever it's dropped
// (the app's scroll container is <main overflow-y-auto>, not the window).
function findScrollParent(el: HTMLElement | null): HTMLElement | Window {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return window;
}

// In-page tab/widget bar that recedes as the user scrolls down and
// reappears on scroll-up, with a hysteresis threshold (~2x its own height)
// so a small scroll or rubber-band bounce doesn't flicker it in and out —
// the "standard iOS collapsing-header feel" (§0.3). Not sticky/fixed chrome;
// once hidden, a floating scroll-to-top button takes over.
export default function ScrollAwayTabs({ children }: { children: ReactNode }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const scrollParentRef = useRef<HTMLElement | Window | null>(null);
  const lastTop = useRef(0);

  useEffect(() => {
    if (!barRef.current) return;
    const parent = findScrollParent(barRef.current);
    scrollParentRef.current = parent;
    const barHeight = barRef.current.offsetHeight || 48;
    const hideThreshold = barHeight * 2;

    const getTop = () => (parent === window ? window.scrollY : (parent as HTMLElement).scrollTop);

    function onScroll() {
      const top = getTop();
      const delta = top - lastTop.current;
      if (top <= hideThreshold) setHidden(false);
      else if (delta > 2) setHidden(true);
      else if (delta < -2) setHidden(false);
      lastTop.current = top;
    }

    parent.addEventListener("scroll", onScroll, { passive: true });
    return () => parent.removeEventListener("scroll", onScroll);
  }, []);

  function scrollToTop() {
    const parent = scrollParentRef.current;
    if (!parent) return;
    if (parent === window) window.scrollTo({ top: 0, behavior: "smooth" });
    else (parent as HTMLElement).scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <>
      <div
        ref={barRef}
        className={`transition-all duration-200 ease-out overflow-hidden ${
          hidden ? "max-h-0 opacity-0 -translate-y-2" : "max-h-[480px] opacity-100 translate-y-0"
        }`}
      >
        {children}
      </div>
      {hidden && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-20 md:bottom-6 right-6 z-40 w-11 h-11 rounded-full bg-accent text-white shadow-lg grid place-items-center hover:bg-accent-strong transition-transform active:scale-95"
          aria-label="Scroll to top"
        >
          <ArrowUp size={18} />
        </button>
      )}
    </>
  );
}
