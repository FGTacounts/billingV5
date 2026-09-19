#!/usr/bin/env node
/**
 * Famlist Billing — the tenancy check CLAUDE.md rule 3 asks for.
 *
 *   npm run test:tenancy
 *
 * WHAT THIS ACTUALLY TESTS, AND WHY
 *
 * Rule 3 has two halves. Only one of them is real in this database today.
 *
 * The half that is real, and is what this checks: nobody reaches any data
 * without signing in. The anon key is embedded in the web app and in the
 * phone app, so it is exactly that — public. Anyone can read it out of a
 * built page or an unzipped .ipa. On 4 September 2026 that key alone
 * returned real rows from eight tables and could insert into `zones`;
 * RUN-ME-13 closed it. This script is what stops it reopening: it discovers
 * every table the key can see and proves each one refuses an anonymous read
 * and an anonymous write.
 *
 * It also watches the shape of the database. This application serves one
 * business and deliberately has no tenancy column (2026-09-12 — the owner
 * settled it: this is not being sold to anyone else). If an `org_id` ever
 * turns up, either that decision has changed or something was added by
 * mistake, and both are worth stopping for.
 *
 * NOTHING IS WRITTEN. The write probe sends a deliberately malformed id, so
 * a table that wrongly accepts the write still rejects the row — the error
 * tells us the permission exists without creating anything.
 *
 * Needs the two public values already in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * SUPABASE_SERVICE_ROLE_KEY is optional and is used for one thing only:
 * listing the tables, so a table added later is checked without anyone
 * remembering to add it here. Without it the check falls back to the list
 * below and says so. The probing itself is always done with the public key —
 * that is the whole point.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Views mirror a real table's rows and are checked through it; PostgREST
// exposes functions under rpc/, which are not tables.
const SKIP = (name) => name.startsWith("rpc/");

// Postgres says "you may not" with this one code, whether the refusal came
// from a missing grant or from a row-level security policy. Anything else
// means the statement got far enough to be judged on its contents, which
// means the permission was there.
const PERMISSION_DENIED = "42501";

function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) {
    throw new Error("Could not find .env.local — this check needs the project's own Supabase URL and anon key.");
  }
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

function required(env, key) {
  const v = env[key];
  if (!v) throw new Error(`${key} is missing from .env.local`);
  return v;
}

/**
 * The tables this app reads or writes. Only the fallback: the check prefers
 * to discover them, so that a table added later is covered automatically.
 * Kept in step with `grep -rhoE '\.from\("[a-z_]+"' app lib components`.
 */
const KNOWN_TABLES = [
  "app_settings", "customer_change_requests", "customer_discounts",
  "customer_prices", "customers", "expenses", "grv_items", "grv_returns",
  "news_posts", "notifications", "order_items", "order_status_log", "orders",
  "payment_delay_notes", "payment_extension_requests", "payment_orders",
  "payments", "products", "purchases", "route_visits", "users",
  "zone_countries", "zones",
];

/** Asks PostgREST what exists. Returns null when this key may not ask. */
async function readSpec(url, key) {
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function listTables(url, anonKey, serviceKey) {
  // The public key being unable to list anything is itself the door being
  // shut, and is reported as such below.
  const anonSpec = await readSpec(url, anonKey);
  const spec = anonSpec ?? (serviceKey ? await readSpec(url, serviceKey) : null);

  if (!spec) {
    return {
      tables: KNOWN_TABLES,
      definitions: {},
      source: "the list in this file (no key could read the schema)",
      anonCanListSchema: false,
    };
  }
  return {
    tables: Object.keys(spec.paths ?? {})
      .map((p) => p.replace(/^\//, ""))
      .filter((n) => n && !SKIP(n))
      .sort(),
    definitions: spec.definitions ?? {},
    source: anonSpec ? "the public key's own view of the schema" : "the service key",
    anonCanListSchema: Boolean(anonSpec),
  };
}

/** Can the public key read anything here? */
async function probeRead(url, key, table) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return { ok: true, note: `refused (HTTP ${res.status})` };
  const rows = await res.json().catch(() => []);
  if (Array.isArray(rows) && rows.length === 0) {
    return { ok: true, note: "no rows" };
  }
  return { ok: false, note: `RETURNED ${Array.isArray(rows) ? rows.length : "?"} ROW(S)` };
}

/**
 * A column whose type will not accept the word "no", so a write aimed at it
 * can never persist whatever the permissions say. Without one, there is no
 * way to ask the question without risking a real row, so the write probe is
 * skipped for that table rather than guessed at.
 */
function unwritableColumn(definition) {
  const props = definition?.properties ?? {};
  for (const [name, meta] of Object.entries(props)) {
    const format = String(meta?.format ?? "");
    if (/^(uuid|integer|bigint|smallint|numeric|real|double precision|boolean|timestamp|date|time)/.test(format)) {
      return name;
    }
  }
  return null;
}

/**
 * Can the public key write here?
 *
 * The value sent is the wrong type for the column it names, so a table that
 * wrongly permits the write still cannot store the row — nothing is ever
 * created. What is being read is WHICH refusal comes back: Postgres checks
 * the privilege before it judges the value, so "permission denied" means the
 * door is shut and a complaint about the value means it was not.
 */
async function probeWrite(url, key, table, definition) {
  const column = unwritableColumn(definition);
  if (!column) return { ok: true, note: "not probed (no safely-typed column)", skipped: true };

  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ [column]: "no" }),
  });
  if (res.ok) return { ok: false, note: "ACCEPTED THE WRITE" };
  const body = await res.json().catch(() => ({}));
  if (body?.code === PERMISSION_DENIED) return { ok: true, note: "refused" };
  // PostgREST turned the request away before Postgres saw it, so nothing was
  // learned about the permission either way.
  if (String(body?.code ?? "").startsWith("PGRST")) {
    return { ok: true, note: `not probed (${body.code})`, skipped: true };
  }
  return { ok: false, note: `permitted, then rejected on value (${body?.code ?? res.status})` };
}

/**
 * This database serves one business and has no tenancy column, on purpose.
 * A column appearing is not automatically wrong, but it is never an accident
 * worth ignoring — so it is reported, loudly, rather than quietly accepted.
 * With no schema to read, this cannot be judged and says so.
 */
function checkTenantColumn(definitions, tables) {
  if (Object.keys(definitions).length === 0) {
    return { failures: [], summary: "not checked (the schema could not be read from here)" };
  }
  const withColumn = tables.filter((t) =>
    Object.keys(definitions[t]?.properties ?? {}).includes("org_id")
  );
  if (withColumn.length === 0) {
    return {
      failures: [],
      summary: "one business, no tenancy column — as decided on 2026-09-12. See docs/DECISIONS.md.",
    };
  }
  return {
    failures: withColumn,
    summary:
      `${withColumn.length} table(s) now carry org_id, which this database is not supposed to have`,
  };
}

async function main() {
  const env = loadEnv();
  const url = required(env, "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
  const key = required(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");

  console.log("Tenancy check — what the public key can reach without signing in\n");

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || null;
  const { tables, definitions, source, anonCanListSchema } =
    await listTables(url, key, serviceKey);

  console.log(`  Tables from ${source}.`);
  console.log(
    anonCanListSchema
      ? "  NOTE: the public key can list the schema. Not a failure on its own, but it\n        tells an attacker exactly what to aim at.\n"
      : "  Good: the public key cannot even list the schema.\n"
  );
  if (tables.length === 0) {
    console.log("Nothing to check.\n");
  }

  const failures = [];
  const notProbed = [];
  const width = Math.max(...tables.map((t) => t.length), 12);

  for (const table of tables) {
    const read = await probeRead(url, key, table);
    const write = await probeWrite(url, key, table, definitions[table]);
    const ok = read.ok && write.ok;
    if (!ok) failures.push({ table, read, write });
    if (write.skipped) notProbed.push(table);
    const mark = ok ? "OK  " : "FAIL";
    console.log(
      `  ${mark}  ${table.padEnd(width)}  read: ${read.note.padEnd(26)} write: ${write.note}`
    );
  }

  const tenancy = checkTenantColumn(definitions, tables);
  console.log(`\nTenancy model — ${tenancy.summary}`);
  for (const table of tenancy.failures) {
    console.log(`  FAIL  ${table} has an org_id`);
  }
  if (tenancy.failures.length > 0) {
    console.log("\n  CLAUDE.md rule 3 says this database serves one business and carries no");
    console.log("  tenancy column. Either that decision has changed — in which case change");
    console.log("  the rule and this check with it — or a column was added by mistake.");
  }

  const total = failures.length + tenancy.failures.length;
  const skipped = notProbed.length;
  if (total === 0) {
    console.log(`\nPASS — ${tables.length} table(s) refuse anonymous reads.`);
    if (skipped > 0) {
      console.log(`       ${skipped} could not have their write side probed safely: ` +
                  `${notProbed.join(", ")}.`);
      console.log("       Reads are refused on all of them, which is the half that leaks data.");
    }
    console.log("");
    process.exit(0);
  }

  console.log(`\nFAIL — ${total} problem(s).\n`);
  if (failures.length > 0) {
    const readable = failures.filter((f) => !f.read.ok);
    if (readable.length > 0) {
      console.log("A table above HANDED OVER ROWS to a caller with no login. That is the");
      console.log("leak RUN-ME-13 closed on 4 September 2026. Revoke the grant and give the");
      console.log("table a policy, the way scratchpad/RUN-ME-13-close-the-public-door.sql does.\n");
    }
    const writable = failures.filter((f) => f.read.ok && !f.write.ok);
    if (writable.length > 0) {
      console.log("A table above let the write attempt past the permission check. Nothing was");
      console.log("written — the value sent cannot be stored — but the privilege is there and");
      console.log("should not be. scratchpad/RUN-ME-22-safe-views-are-read-only.sql removes the");
      console.log("one this found; a new one needs the same treatment.\n");
    }
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(`\nCould not run the check: ${e.message}\n`);
  process.exit(2);
});
