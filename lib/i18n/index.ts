import { en, type MessageKey } from "./en";

export type { MessageKey };
export { en };

type Vars = Record<string, string | number>;

/**
 * Look up a user-facing string.
 *
 * A plain function, not a hook: it reads one module-level object and holds no
 * state, so the same call works in a server component, a client component, a
 * route handler and a plain module. A key that is not in the catalogue is a
 * TypeScript error rather than a silently empty string.
 *
 * Interpolation is named placeholders in the English string:
 *   t("orders.cutToShelf", { sku, from, to })
 * A placeholder with no matching variable is left as written, so a mistake
 * shows up in the UI as `{name}` instead of disappearing.
 */
export function t(key: MessageKey, vars?: Vars): string {
  const template: string = en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}
