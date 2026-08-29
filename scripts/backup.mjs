#!/usr/bin/env node
/**
 * Famlist Billing — nightly encrypted backup to Google Drive.
 *
 *   node scripts/backup.mjs
 *
 * What it does, in order:
 *   1. Discovers every table in the database, so tables added later are
 *      included automatically — nothing here to remember to update.
 *   2. Exports all rows, paging through large tables.
 *   3. Gzips the result.
 *   4. Encrypts it with AES-256 *before* it leaves this machine.
 *   5. Uploads it to a Google Drive folder.
 *   6. Prunes old copies: keeps every backup from the last 30 days, plus the
 *      first of each month for 5 years (UAE VAT record-keeping).
 *
 * Needs two new values in .env.local (the rest are already there):
 *   BACKUP_PASSPHRASE        a long random passphrase
 *   BACKUP_DRIVE_FOLDER_ID   the Drive folder to upload into
 *
 * IF YOU LOSE THE PASSPHRASE THE BACKUPS CANNOT BE RECOVERED. There is no
 * reset and no support line. Keep it in a password manager — somewhere other
 * than the Google account holding the backups, or a single account
 * compromise costs you both halves at once.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { JWT } from "google-auth-library";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE_SIZE = 1000;

// Views duplicate a real table's rows, and PostgREST exposes functions under
// rpc/. Neither belongs in a data backup.
const SKIP = (name) => name.startsWith("rpc/") || name.endsWith("_safe");

function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) throw new Error("Could not find .env.local");
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

function required(env, key, hint) {
  const v = env[key];
  if (!v) throw new Error(`${key} is missing from .env.local — ${hint}`);
  return v;
}

// ----------------------------------------------------------- export data --

async function listTables(url, key) {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Could not list tables (HTTP ${res.status})`);
  const spec = await res.json();
  return Object.keys(spec.paths ?? {})
    .map((p) => p.replace(/^\//, ""))
    .filter((n) => n && !SKIP(n))
    .sort();
}

async function exportTable(url, key, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${from + PAGE_SIZE - 1}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// --------------------------------------------------------------- encrypt --

function encrypt(buffer, passphrase) {
  const tmpIn = path.join(os.tmpdir(), `fgt-backup-${process.pid}.gz`);
  const tmpOut = `${tmpIn}.enc`;
  fs.writeFileSync(tmpIn, buffer, { mode: 0o600 });
  try {
    // Passphrase goes via an env var, not argv — command lines are visible to
    // every other process on the machine via `ps`.
    execFileSync(
      "openssl",
      [
        "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt",
        "-in", tmpIn, "-out", tmpOut, "-pass", "env:FGT_BACKUP_PASS",
      ],
      { env: { ...process.env, FGT_BACKUP_PASS: passphrase }, stdio: "pipe" }
    );
    return fs.readFileSync(tmpOut);
  } finally {
    for (const f of [tmpIn, tmpOut]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ------------------------------------------------------------------ drive --

async function driveToken(email, privateKey) {
  const jwt = new JWT({
    email,
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const { access_token } = await jwt.getAccessToken();
  if (!access_token) throw new Error("Google refused the service-account credentials");
  return access_token;
}

async function driveUpload(token, folderId, filename, bytes) {
  const boundary = `fgt${Date.now()}`;
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive upload failed (HTTP ${res.status}): ${await res.text()}`);
  return res.json();
}

async function driveList(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&pageSize=1000&orderBy=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Could not list the backup folder (HTTP ${res.status})`);
  return (await res.json()).files ?? [];
}

async function driveDelete(token, id) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Keep everything from the last 30 days, then the earliest backup of each
 * calendar month for 5 years. Anything else goes.
 *
 * Deliberately decides from the filename date, not Drive's createdTime: a
 * re-upload of an old file would otherwise look recent and survive forever.
 */
function toPrune(files, now = new Date()) {
  const dated = files
    .map((f) => ({ f, m: f.name.match(/(\d{4})-(\d{2})-(\d{2})/) }))
    .filter((x) => x.m)
    .map(({ f, m }) => ({ file: f, date: new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`), month: `${m[1]}-${m[2]}` }))
    .sort((a, b) => a.date - b.date);

  const dayMs = 86_400_000;
  const keepDailyAfter = now.getTime() - 30 * dayMs;
  const keepMonthlyAfter = now.getTime() - 5 * 365 * dayMs;
  const firstOfMonth = new Map();
  for (const d of dated) if (!firstOfMonth.has(d.month)) firstOfMonth.set(d.month, d.file.id);

  return dated
    .filter((d) => {
      if (d.date.getTime() >= keepDailyAfter) return false;              // recent
      if (d.date.getTime() < keepMonthlyAfter) return true;              // beyond 5 years
      return firstOfMonth.get(d.month) !== d.file.id;                    // not the month's keeper
    })
    .map((d) => d.file);
}

// -------------------------------------------------------------------- run --

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const env = loadEnv();

  const url = required(env, "NEXT_PUBLIC_SUPABASE_URL", "this should already be set");
  const key = required(env, "SUPABASE_SERVICE_ROLE_KEY", "this should already be set");
  const passphrase = required(
    env,
    "BACKUP_PASSPHRASE",
    "add a long random passphrase. Losing it makes every backup unreadable."
  );
  const folderId = required(
    env,
    "BACKUP_DRIVE_FOLDER_ID",
    "create a Drive folder, share it with your service account, and put its ID here"
  );

  if (passphrase.length < 16) {
    throw new Error("BACKUP_PASSPHRASE is too short — use at least 16 characters.");
  }

  console.log("Reading database…");
  const tables = await listTables(url, key);
  const data = {};
  const counts = {};
  for (const t of tables) {
    const rows = await exportTable(url, key, t);
    data[t] = rows;
    counts[t] = rows.length;
    console.log(`  ${t.padEnd(24)} ${rows.length} rows`);
  }

  const stamp = new Date().toISOString();
  const payload = {
    generatedAt: stamp,
    source: url,
    format: "famlist-backup-v1",
    tableCounts: counts,
    data,
  };

  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const gz = gzipSync(json, { level: 9 });
  const enc = encrypt(gz, passphrase);

  const filename = `famlist-backup-${stamp.slice(0, 10)}-${stamp.slice(11, 19).replace(/:/g, "")}.json.gz.enc`;
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    `\n${tables.length} tables, ${totalRows} rows — ` +
      `${(json.length / 1024).toFixed(0)} KB raw, ${(enc.length / 1024).toFixed(0)} KB encrypted`
  );

  if (dryRun) {
    const out = path.join(ROOT, "scratchpad", filename);
    fs.writeFileSync(out, enc, { mode: 0o600 });
    console.log(`\nDry run — nothing uploaded. Wrote ${out}`);
    return;
  }

  console.log("Uploading to Drive…");
  const token = await driveToken(
    required(env, "GOOGLE_SERVICE_ACCOUNT_EMAIL", "this should already be set"),
    required(env, "GOOGLE_PRIVATE_KEY", "this should already be set")
  );
  const uploaded = await driveUpload(token, folderId, filename, enc);
  console.log(`  uploaded ${uploaded.name}`);

  const existing = await driveList(token, folderId);
  const stale = toPrune(existing);
  for (const f of stale) {
    await driveDelete(token, f.id);
    console.log(`  pruned ${f.name}`);
  }
  console.log(`\nDone. ${existing.length + 1 - stale.length} backups in the folder.`);
}

main().catch((e) => {
  console.error(`\nBackup FAILED: ${e.message}`);
  process.exit(1);
});
