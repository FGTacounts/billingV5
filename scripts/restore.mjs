#!/usr/bin/env node
/**
 * Famlist Billing — read a backup produced by scripts/backup.mjs.
 *
 *   node scripts/restore.mjs <file.enc>                 what's inside
 *   node scripts/restore.mjs <file.enc> --out data.json decrypt to a file
 *   node scripts/restore.mjs <file.enc> --table orders  print one table
 *
 * This deliberately DECRYPTS AND INSPECTS rather than writing to your live
 * database. Restoring is a decision, not a command you should be able to run
 * by accident at 2am — see scripts/BACKUP-RUNBOOK.md for the actual steps.
 *
 * Needs BACKUP_PASSPHRASE in .env.local, the same one used to create it.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");

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

function decrypt(file, passphrase) {
  const tmpOut = path.join(os.tmpdir(), `fgt-restore-${process.pid}.gz`);
  try {
    execFileSync(
      "openssl",
      [
        "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
        "-in", file, "-out", tmpOut, "-pass", "env:FGT_BACKUP_PASS",
      ],
      { env: { ...process.env, FGT_BACKUP_PASS: passphrase }, stdio: "pipe" }
    );
    return gunzipSync(fs.readFileSync(tmpOut));
  } catch (e) {
    // openssl's own message here is "bad decrypt", which sends people looking
    // for a corrupt file when the cause is almost always the wrong passphrase.
    throw new Error(
      "Could not decrypt. The passphrase in .env.local does not match the one " +
        "used to create this backup, or the file is damaged."
    );
  } finally {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
}

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node scripts/restore.mjs <file.enc> [--out data.json] [--table NAME]");
    process.exit(1);
  }
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);

  const env = loadEnv();
  const passphrase = env.BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error("BACKUP_PASSPHRASE is missing from .env.local");

  const payload = JSON.parse(decrypt(file, passphrase).toString("utf8"));

  const outIdx = rest.indexOf("--out");
  const tableIdx = rest.indexOf("--table");

  if (tableIdx !== -1) {
    const name = rest[tableIdx + 1];
    const rows = payload.data?.[name];
    if (!rows) throw new Error(`No table "${name}" in this backup.`);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (outIdx !== -1) {
    const out = rest[outIdx + 1] ?? "backup.json";
    fs.writeFileSync(out, JSON.stringify(payload, null, 2), { mode: 0o600 });
    console.log(`Decrypted to ${out} — this file is PLAIN TEXT. Delete it when you are done.`);
    return;
  }

  console.log(`Backup taken:  ${payload.generatedAt}`);
  console.log(`From:          ${payload.source}`);
  console.log(`Format:        ${payload.format}\n`);
  const counts = payload.tableCounts ?? {};
  const width = Math.max(...Object.keys(counts).map((k) => k.length));
  for (const [t, n] of Object.entries(counts)) {
    console.log(`  ${t.padEnd(width)}  ${String(n).padStart(6)} rows`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n  ${"TOTAL".padEnd(width)}  ${String(total).padStart(6)} rows`);
  console.log("\nThis only reads the backup. To restore, see scripts/BACKUP-RUNBOOK.md");
}

try {
  main();
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}
