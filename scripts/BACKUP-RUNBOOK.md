# Famlist Billing — backup and restore

## What this protects you from

Your data lives in one place: a hosted Supabase database. This adds a second,
independent copy that **you** hold, encrypted, so that losing the Supabase
account — or someone deleting the wrong thing — is recoverable.

It does **not** replace Supabase's own backups. Check which plan you are on:
the free tier has effectively none, Pro gives daily backups kept for 7 days.
This is the second layer, not the first.

---

## One-time setup

### 1. Create the passphrase

Generate something long and random, and put it in a password manager first:

```bash
openssl rand -base64 32
```

> **If you lose this passphrase, every backup becomes permanently unreadable.**
> There is no reset and no support line. Store it somewhere other than the
> Google account that holds the backups — otherwise one compromised account
> costs you both halves at once.

### 2. Create the Drive folder

1. In Google Drive, make a folder — e.g. `Famlist Backups`.
2. Share it with your service account
   (`famlist-billing-app@familist-497101.iam.gserviceaccount.com`) as **Editor**.
3. Open the folder. Its ID is the last part of the URL:
   `https://drive.google.com/drive/folders/`**`1AbCdEf...`**

### 3. Add both to `.env.local`

```
BACKUP_PASSPHRASE="the passphrase you generated"
BACKUP_DRIVE_FOLDER_ID="the folder ID"
```

Keep that file at permissions `600` (`chmod 600 .env.local`). It also holds
your service-role key, which bypasses every permission rule in the database.

### 4. Prove it works before you rely on it

```bash
node scripts/backup.mjs --dry-run
```

Writes an encrypted file locally and uploads nothing. You should see a row
count for every table.

---

## Running it

```bash
node scripts/backup.mjs
```

Exports every table, gzips, encrypts with AES-256, uploads to Drive, then
prunes: **everything from the last 30 days**, plus **the first backup of each
month for 5 years**. Five years is not arbitrary — UAE VAT rules require tax
records be kept that long.

### Automate it (nightly at 2am)

```bash
crontab -e
```

Add, with the path adjusted:

```
0 2 * * * cd /Users/muhammedbilal/Downloads/famlist-billing-web && /opt/homebrew/bin/node scripts/backup.mjs >> /tmp/famlist-backup.log 2>&1
```

Cron only runs while the Mac is awake. If this machine sleeps overnight, the
backup silently never happens — which is the worst failure mode, because you
find out when you need it. Either keep the machine awake, or run this on a
server. **Check the log weekly.**

---

## Restoring

### See what a backup contains

```bash
node scripts/restore.mjs famlist-backup-2026-08-28-020000.json.gz.enc
```

### Pull one table out

```bash
node scripts/restore.mjs <file> --table orders
```

### Decrypt the whole thing

```bash
node scripts/restore.mjs <file> --out recovered.json
```

The output is **plain text containing every customer, price and payment**.
Delete it when you are done.

### Actually putting data back

There is deliberately no "restore everything" button — an accidental run
would overwrite live data with an old copy. The sequence is:

1. **Do not touch the live database yet.** Create a new Supabase project to
   restore into, so you can compare before committing.
2. Recreate the schema by running the SQL files in `scratchpad/` in order.
3. Decrypt with `--out`, then load the tables **in dependency order** —
   `users`, `customers`, `products`, `zones`, then `orders`, `order_items`,
   `payments`, `payment_orders`, then the rest. Loading `orders` before
   `customers` fails on the foreign keys.
4. Check row counts against the backup's own summary.
5. Only then point the app at it by changing `NEXT_PUBLIC_SUPABASE_URL` and
   the keys in `.env.local`.

---

## What this does *not* cover

- **Files in Drive** — product photos, cheque photos and invoice PDFs are
  stored in Google Drive, not the database, so they are not in these backups.
  A copy inside the same Drive account would not be independent anyway. If
  those matter, mirror that folder to a different provider.
- **Schema** — this backs up rows, not table definitions. The schema is
  reproducible from the SQL files in `scratchpad/`. If you want true
  schema-and-data dumps, install `pg_dump` (`brew install libpq`), get the
  database password from the Supabase dashboard, and use that instead.
- **A second provider.** Backups sit in the same Google account as the photos.
  That is one account away from losing both. Copying the backup folder to a
  different provider closes that gap.

---

## Test your restore twice a year

Put it in the calendar. An untested backup is a guess. Decrypt the most recent
file, load it into a scratch Supabase project, and confirm the app runs
against it. Fifteen minutes, twice a year, is what turns this from a folder of
files into an actual recovery plan.
