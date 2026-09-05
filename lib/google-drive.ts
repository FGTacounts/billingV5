// Server-only Google Drive access for product photos, cheque/delivery
// (private) uploads, and auto-saved Tax Invoice PDFs. Same service-account
// JWT pattern the old Sheets-era lib/drive.ts used (google-auth-library
// signs the RS256 JWT -> access token exchange), but folder IDs now come
// from `app_settings` instead of env vars, and this adds upload support.

import "server-only";
import { JWT } from "google-auth-library";
import { supabaseServer } from "./supabase/server";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const SCOPES = ["https://www.googleapis.com/auth/drive"];

let cachedClient: JWT | null = null;

function fromJsonObject(json: unknown): { email: string; key: string } | null {
  const obj = json as { client_email?: string; private_key?: string } | null;
  if (obj?.client_email && obj?.private_key) {
    return {
      email: String(obj.client_email),
      key: String(obj.private_key).replace(/\\n/g, "\n").trim(),
    };
  }
  return null;
}

function loadCredentials(): { email: string; key: string } {
  const b64 = (process.env.GOOGLE_CREDENTIALS_BASE64 || "").trim();
  if (b64) {
    try {
      const r = fromJsonObject(JSON.parse(Buffer.from(b64, "base64").toString("utf8")));
      if (r) return r;
    } catch {
      /* fall through */
    }
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
  const key = (process.env.GOOGLE_PRIVATE_KEY || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n/g, "\n")
    .trim();
  return { email, key };
}

function client(): JWT {
  if (cachedClient) return cachedClient;
  const { email, key } = loadCredentials();
  if (!email || !key) {
    throw new Error(
      "Google Drive is not configured — set GOOGLE_CREDENTIALS_BASE64 (or GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY)."
    );
  }
  cachedClient = new JWT({ email, key, scopes: SCOPES });
  return cachedClient;
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await client().authorize();
  return { Authorization: `Bearer ${token.access_token}` };
}

// app_settings is a single row with named columns (vat_rate, accent_theme,
// etc. — same shape every other reader in this app already uses), not a
// key/value table. This used to query it as `select value where key = ...`,
// which never matched any row — the real reason product photos always
// 502'd with "is not set" even after the folder ID and Drive credentials
// were both configured correctly.
type FolderColumn =
  | "product_photos_drive_folder_id"
  | "private_uploads_drive_folder_id"
  | "cheque_drive_folder_id"
  | "invoice_proof_drive_folder_id";

export async function getSetting(column: FolderColumn): Promise<string | null> {
  const supabase = supabaseServer();
  const { data } = await supabase
    .from("app_settings")
    .select(column)
    .limit(1)
    .maybeSingle();
  return (data as Record<string, string | null> | null)?.[column] ?? null;
}

export async function productPhotosFolderId(): Promise<string> {
  const id = await getSetting("product_photos_drive_folder_id");
  if (!id) throw new Error("app_settings.product_photos_drive_folder_id is not set");
  return id;
}

export async function privateUploadsFolderId(): Promise<string> {
  const id = await getSetting("private_uploads_drive_folder_id");
  if (!id) throw new Error("app_settings.private_uploads_drive_folder_id is not set");
  return id;
}

/**
 * Where delivery proof photos go. Falls back to the general private uploads
 * folder when the dedicated one has not been set, so proof is never lost just
 * because a folder is unconfigured.
 *
 * The column does not exist before RUN-ME-5, and asking for a column that
 * isn't there is an error rather than an empty answer, so that case is caught
 * and treated as "not set".
 */
export async function invoiceProofFolderId(): Promise<string> {
  try {
    const id = await getSetting("invoice_proof_drive_folder_id");
    if (id) return id;
  } catch {
    // Column not added yet.
  }
  return privateUploadsFolderId();
}

/** Where cheque photos go. Same fallback for the same reason. */
export async function chequeFolderId(): Promise<string> {
  try {
    const id = await getSetting("cheque_drive_folder_id");
    if (id) return id;
  } catch {
    // Column not added yet.
  }
  return privateUploadsFolderId();
}

/**
 * Delivery proof file name, e.g. INV4300_30AUG26.
 *
 * The invoice number is what makes a proof findable later: the Invoices screen
 * looks up proof by this prefix rather than from a column on the order, since
 * the order table has nowhere to store it. An order without a number yet falls
 * back to its id so the upload still has a stable name.
 */
export function deliveryProofName(invoiceNumber: string | null, orderId: string, when: Date, index = 0): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const day = String(when.getDate()).padStart(2, "0");
  const stamp = `${day}${months[when.getMonth()]}${String(when.getFullYear()).slice(-2)}`;
  const base = invoiceNumber ? `INV${invoiceNumber}` : `ORD${orderId.slice(0, 8)}`;
  // A second photo of the same delivery gets _2, _3 … so nothing overwrites.
  return index === 0 ? `${base}_${stamp}` : `${base}_${stamp}_${index + 1}`;
}

/** The prefix the Invoices screen searches to find every proof for an invoice. */
export function deliveryProofPrefix(invoiceNumber: string): string {
  return `INV${invoiceNumber}_`;
}

/**
 * Cheque photo file name, e.g. CUSTOMERNAME1 — the customer's name followed by
 * how many cheques they have had. Letters and digits only, so the name is safe
 * as a file name whatever the customer is called.
 */
export function chequePhotoName(customerName: string, paymentNumber: number): string {
  const cleaned = customerName.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${cleaned || "CUSTOMER"}${paymentNumber}`;
}

interface DriveFile {
  id: string;
  mimeType: string;
}

let photoCache: { map: Map<string, DriveFile>; folderId: string; at: number } | null = null;
// One shared walk in progress. Without this, a page showing 50 products fires
// 50 photo requests at once and every one of them walks the entire Drive
// folder tree from scratch — dozens of sequential Drive calls each. That is
// why photos were slow and why some never appeared at all: the parallel walks
// hit Drive's rate limit and the losers failed. Now the first request does the
// work and the other 49 wait on the same promise.
let photoMapInFlight: { folderId: string; promise: Promise<Map<string, DriveFile>> } | null = null;
// Walking the whole photo folder tree measured at ~18 SECONDS on this
// catalogue. With a 5-minute TTL someone paid that every five minutes. Photos
// change rarely, and uploading one calls invalidatePhotoCache() so a new photo
// still appears immediately — so the map can live much longer, and past that
// we serve the stale map instantly and refresh behind the scenes rather than
// making anyone wait again.
const TTL_MS = 60 * 60 * 1000;      // an hour before it is considered stale
const STALE_MAX_MS = 24 * 60 * 60 * 1000; // beyond a day, wait for a fresh walk

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim().toLowerCase();
}

// The folder isn't flat — it holds category subfolders (e.g. "TURTEES",
// "SUNGLASS LOW PRICE") with the actual photos nested inside those, not
// sitting directly in the top-level folder. This used to only ever list the
// top level's direct children, which are all folders, so no photo was ever
// found for any SKU even with working credentials — walks the whole tree
// (breadth-first) instead.
async function loadPhotoMap(folderId: string): Promise<Map<string, DriveFile>> {
  const cached =
    photoCache && photoCache.folderId === folderId ? photoCache : null;
  const age = cached ? Date.now() - cached.at : Infinity;

  if (cached && age < TTL_MS) return cached.map;

  const refresh = () => {
    if (photoMapInFlight && photoMapInFlight.folderId === folderId) {
      return photoMapInFlight.promise;
    }
    const promise = walkPhotoFolder(folderId).finally(() => {
      photoMapInFlight = null;
    });
    photoMapInFlight = { folderId, promise };
    return promise;
  };

  // Stale but usable: hand back what we have straight away and refresh in the
  // background, so nobody waits out an 18-second walk for a map that is only
  // slightly out of date.
  if (cached && age < STALE_MAX_MS) {
    refresh().catch(() => {
      /* keep serving the stale map; the next call will try again */
    });
    return cached.map;
  }

  return refresh();
}

async function walkPhotoFolder(folderId: string): Promise<Map<string, DriveFile>> {
  const map = new Map<string, DriveFile>();
  const headers = await authHeader();
  const queue: string[] = [folderId];
  const visited = new Set<string>();

  while (queue.length) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${currentId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(`${DRIVE_BASE}/files?${params.toString()}`, {
        headers,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
      const json = await res.json();
      for (const f of json.files ?? []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          queue.push(f.id);
        } else if (typeof f.mimeType === "string" && f.mimeType.startsWith("image/")) {
          map.set(baseName(f.name), { id: f.id, mimeType: f.mimeType });
        }
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
  }

  photoCache = { map, folderId, at: Date.now() };
  return map;
}

// Called after a photo upload so the new file shows immediately instead of
// waiting out the 5-minute map cache.
export function invalidatePhotoCache() {
  photoCache = null;
  photoMapInFlight = null;
}

/**
 * Ask Drive for one file by name, without walking anything.
 *
 * The folder map is far more efficient once it exists — one walk answers
 * every SKU — but building it takes ~18 seconds on this catalogue, and until
 * then every photo request was stuck behind it. So on a cold start we answer
 * this SKU directly (about a third of a second) while the map builds in the
 * background, and once it is ready everything switches to the map.
 */
async function findPhotoByDirectSearch(sku: string): Promise<DriveFile | null> {
  const headers = await authHeader();
  // Drive has no exact-name-without-extension match, so search on the stem
  // and confirm the basename ourselves.
  const escaped = sku.replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name contains '${escaped}' and mimeType contains 'image/' and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: "20",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`${DRIVE_BASE}/files?${params.toString()}`, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = await res.json();
  const wanted = sku.trim().toLowerCase();
  const hit = (json.files ?? []).find(
    (f: { name: string }) => baseName(f.name) === wanted
  );
  return hit ? { id: hit.id, mimeType: hit.mimeType } : null;
}

export async function findProductPhoto(sku: string): Promise<DriveFile | null> {
  const folderId = await productPhotosFolderId();

  // Map already built (or usably stale)? Use it — it is a lookup, not a call.
  const cached = photoCache && photoCache.folderId === folderId ? photoCache : null;
  if (cached && Date.now() - cached.at < STALE_MAX_MS) {
    // Still refresh in the background when stale; loadPhotoMap handles that.
    void loadPhotoMap(folderId);
    return cached.map.get(sku.trim().toLowerCase()) ?? null;
  }

  // Cold. Start the map for everyone who comes after, but do not wait on it —
  // answer this request with a direct lookup instead.
  void loadPhotoMap(folderId).catch(() => {});
  try {
    return await findPhotoByDirectSearch(sku);
  } catch {
    return null;
  }
}

export async function fetchDriveFileBytes(
  fileId: string
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const headers = await authHeader();
  const res = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Drive fetch failed (${res.status})`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { bytes: await res.arrayBuffer(), contentType };
}

// Uploads a file into a folder (used for cheque/delivery photos -> the
// private uploads folder, and auto-saved Tax Invoice PDFs). Returns the new
// file's webViewLink for storing on the row (payments.cheque_photo_url,
// orders.delivery_proof_url / invoice_pdf_url).
export async function uploadToDrive(
  folderId: string,
  filename: string,
  bytes: Buffer | Uint8Array,
  mimeType: string
): Promise<{ id: string; webViewLink: string }> {
  const headers = await authHeader();
  const metadata = { name: filename, parents: [folderId] };
  const boundary = `-------drive-${Date.now()}`;
  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];
  const body = Buffer.concat([
    Buffer.from(bodyParts[0] + bodyParts[1], "utf8"),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);

  const res = await fetch(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) {
    throw new Error(`Drive upload failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export interface DriveProofFile {
  id: string;
  name: string;
  webViewLink: string;
  thumbnailLink: string | null;
}

/**
 * Every file in a folder whose name starts with `prefix`.
 *
 * This is how proof photos are found. The orders table has no column to record
 * an uploaded file against, so the file name carries the link instead — which
 * is the reason the naming format matters rather than being cosmetic.
 */
export async function findFilesByPrefix(folderId: string, prefix: string): Promise<DriveProofFile[]> {
  const headers = await authHeader();
  // A single quote inside a Drive query string has to be escaped or the query
  // is rejected outright.
  const safePrefix = prefix.replace(/'/g, "\\'");
  const q = `'${folderId}' in parents and name contains '${safePrefix}' and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,webViewLink,thumbnailLink)",
    pageSize: "50",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`${DRIVE_BASE}/files?${params}`, { headers });
  if (!res.ok) return [];
  const data = (await res.json()) as { files?: DriveProofFile[] };
  // `name contains` matches anywhere in the name, so keep only true prefixes.
  return (data.files ?? []).filter((f) => f.name.startsWith(prefix));
}
