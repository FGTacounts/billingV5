"use client";

import { useSyncExternalStore } from "react";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

// Module-level store rather than a React context, so any module can raise a
// toast without the caller needing a hook or a provider in scope. That
// matters here: these replace ~28 bare alert() calls scattered through
// event handlers and catch blocks, many of them not in render position.
let toasts: Toast[] = [];
const subscribers = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const fn of subscribers) fn();
}

// Errors stay up longer — you may need to read an error, you rarely need to
// read a confirmation.
const DURATION: Record<ToastTone, number> = {
  success: 3200,
  error: 6000,
  info: 4200,
};

function push(tone: ToastTone, message: string) {
  const id = nextId++;
  toasts = [...toasts, { id, tone, message }];
  emit();
  setTimeout(() => dismiss(id), DURATION[tone]);
  return id;
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string) => push("success", message),
  error: (message: string) => push("error", message),
  info: (message: string) => push("info", message),
};

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
const getSnapshot = () => toasts;
// Stable empty array for SSR — a fresh [] each call would make
// useSyncExternalStore think the value changed on every render.
const EMPTY: Toast[] = [];
const getServerSnapshot = () => EMPTY;

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
