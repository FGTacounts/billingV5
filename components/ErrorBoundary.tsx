"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Catches a render error in one screen instead of losing the whole app.
 *
 * Without this, a single component throwing takes React's whole tree with
 * it and the person is left looking at a blank white page with no way back —
 * which is what happened in the previous version of this app. The nav, the
 * sidebar and the rest of the chrome sit outside this boundary, so they
 * survive; only the page that failed is replaced, and it offers a way to
 * try again without reloading everything.
 */
interface Props {
  children: ReactNode;
  /** Remounting on a route change clears a stale error automatically. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // A different page is a fresh start; don't hold the old failure on screen.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // No error-reporting service is wired up, so this is the only record.
    console.error("Screen failed to render:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 px-6 text-center">
        <div className="w-14 h-14 rounded-full grid place-items-center bg-[--status-warning]/12 text-[--status-warning]">
          <AlertTriangle size={26} strokeWidth={1.5} />
        </div>
        <div className="text-headline font-semibold">This screen didn&rsquo;t load</div>
        <p className="text-subhead text-secondary max-w-[42ch]">
          Nothing was saved or lost. Try again, and if it keeps happening tell
          your administrator what you were doing.
        </p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-card border border-hairline text-subhead font-semibold text-secondary hover:text-accent hover:border-accent/50 transition-colors"
        >
          <RefreshCw size={15} /> Try again
        </button>
        {/* The message itself is worth showing: it is usually the fastest
            way for an administrator to tell a data problem from a bug. */}
        <code className="mt-2 text-caption text-secondary/70 max-w-[46ch] break-words">
          {error.message}
        </code>
      </div>
    );
  }
}
