"use client";

import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import type { UserPreferences } from "@/lib/types/db";

const LOCAL_KEY = "fgt-preferences";

function readLocal(): UserPreferences {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeLocal(prefs: UserPreferences) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — the server copy is still authoritative */
  }
}

// Server-persisted preferences (§0.3/§1.2/§1.11) with a localStorage cache
// for instant first paint and offline resilience — the server copy wins
// once the initial GET resolves, localStorage is never the source of truth.
//
// This is a single module-level store shared by every consumer rather than
// per-hook state. Previously each usePreferences() call ran its own
// useEffect fetch, so one dashboard load fired /api/preferences six-plus
// times (measured: up to 4.2s each) — and, worse, the copies drifted: a
// setting changed in Settings didn't reach the Sidebar's copy until a full
// reload. One fetch, one state, broadcast to all subscribers fixes both.
let state: UserPreferences = {};
let loaded = false;
let inFlight: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

function setState(next: UserPreferences) {
  state = next;
  emit();
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = fetch("/api/preferences")
    .then((r) => r.json())
    .then((data) => {
      const server = (data.preferences ?? {}) as UserPreferences;
      setState({ ...readLocal(), ...state, ...server });
      writeLocal({ ...readLocal(), ...server });
    })
    .catch(() => {
      // Offline / failed — fall back to whatever was cached locally.
      setState({ ...readLocal(), ...state });
    })
    .finally(() => {
      loaded = true;
      inFlight = null;
      emit();
    });
  return inFlight;
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

const getSnapshot = () => state;
const getLoadedSnapshot = () => loaded;
// SSR always sees the empty defaults, so the client's first render matches
// and hydration doesn't diverge where a preference gates what renders.
// Must be a stable reference — returning a fresh {} each call makes
// useSyncExternalStore see a changed snapshot on every render and warn about
// (and risk) an infinite re-render loop.
const EMPTY_PREFERENCES: UserPreferences = Object.freeze({}) as UserPreferences;
const getServerSnapshot = () => EMPTY_PREFERENCES;
const getServerLoaded = () => false;

export function usePreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isLoaded = useSyncExternalStore(subscribe, getLoadedSnapshot, getServerLoaded);
  // Applied post-hydration only, same reason as above.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!hydrated) {
      setHydrated(true);
      if (!loaded && !inFlight) setState({ ...readLocal(), ...state });
    }
    ensureLoaded();
  }, [hydrated]);

  const update = useCallback((patch: Partial<UserPreferences>) => {
    const next = { ...state, ...patch };
    writeLocal(next);
    setState(next);
    fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, []);

  return { preferences, update, loaded: isLoaded };
}
