// Server-only Google Drive access for product photos, cheque/delivery
// (private) uploads, and auto-saved Tax Invoice PDFs. Same service-account
// JWT pattern the old Sheets-era lib/drive.ts used (google-auth-library
// signs the RS256 JWT -> access token exchange), but folder IDs now come
// from `app_settings` instead of env vars, and this adds upload support.

import "server-only";
import { JWT } from "google-auth-library";
import { supabaseCaller } from "./supabase/server";

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
  // Caller-aware: works for the browser (cookies) and the phone (Bearer).
  const supabase = supabaseCaller();
  const { data } = await supabase
    .from("app_settings")
    .select(column)
    .limit(1)
    .maybeSingle();
  return (data as Record<string, string | null> | null)?.[column] ?? null;
}

// Asked once per PHOTO, which on a product grid is hundreds of times a minute,
// and the answer changes perhaps once in the life of the business. Held for
// five minutes; a settings change is picked up by then at the latest.
let photosFolderCache: { id: string; at: number } | null = null;
const PHOTOS_FOLDER_TTL_MS = 5 * 60 * 1000;

export async function productPhotosFolderId(): Promise<string> {
  if (photosFolderCache && Date.now() - photosFolderCache.at < PHOTOS_FOLDER_TTL_MS) return photosFolderCache.id;
  const id = await getSetting("product_photos_drive_folder_id");
  if (!id) throw new Error("app_settings.product_photos_drive_folder_id is not set");
  photosFolderCache = { id, at: Date.now() };
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
  thumbCache.clear();
  thumbLinkCache.clear();
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

// ---------------------------------------------------------------------------
// Thumbnails, held in memory
//
// WHY: on 2026-09-12 grid tiles were switched from the original file to
// Drive's thumbnail. Fewer bytes — but it turned one call to Google into two
// (ask for the thumbnail's link, then fetch it), in sequence, for every tile,
// for every person, every time. A grid of a hundred products was two hundred
// round trips to Google behind a login check each. That is the slowness the
// owner reported on 2026-09-18 ("slower than previous versions").
//
// A product photo is the same picture for everybody and almost never changes,
// so the server keeps what it has already fetched:
//   • the bytes of each thumbnail, by file and width — a repeat tile costs no
//     call to Google at all, for anyone;
//   • the thumbnail's link, which is good for hours — a new width of a known
//     file costs one call instead of two;
//   • one fetch per thumbnail at a time — fifty phones opening the catalogue
//     together wait on the same request rather than each making their own.
// Uploading a photo clears all of it (invalidatePhotoCache), so a new picture
// still shows at once. Bounded, so it cannot grow without limit: the least
// recently used thumbnails go first.
// ---------------------------------------------------------------------------
type Thumb = { bytes: ArrayBuffer; contentType: string };
const THUMB_TTL_MS = 12 * 60 * 60 * 1000;
const THUMB_MAX_BYTES = 48 * 1024 * 1024;
const THUMB_LINK_TTL_MS = 45 * 60 * 1000;
const thumbCache = new Map<string, { thumb: Thumb; at: number }>();
const thumbLinkCache = new Map<string, { link: string; at: number }>();
const thumbInFlight = new Map<string, Promise<Thumb | null>>();
let thumbBytesHeld = 0;

function rememberThumb(key: string, thumb: Thumb) {
  const old = thumbCache.get(key);
  if (old) thumbBytesHeld -= old.thumb.bytes.byteLength;
  thumbCache.delete(key);
  thumbCache.set(key, { thumb, at: Date.now() });
  thumbBytesHeld += thumb.bytes.byteLength;
  // A Map iterates in insertion order and a hit is re-inserted, so the first
  // key is always the one nobody has asked for in the longest time.
  for (const [k, v] of thumbCache) {
    if (thumbBytesHeld <= THUMB_MAX_BYTES) break;
    thumbCache.delete(k);
    thumbBytesHeld -= v.thumb.bytes.byteLength;
  }
}

async function thumbnailLink(fileId: string, fresh = false): Promise<string | null> {
  const held = thumbLinkCache.get(fileId);
  if (!fresh && held && Date.now() - held.at < THUMB_LINK_TTL_MS) return held.link;
  const headers = await authHeader();
  const meta = await fetch(
    `${DRIVE_BASE}/files/${fileId}?fields=thumbnailLink&supportsAllDrives=true`,
    { headers, cache: "no-store" }
  );
  if (!meta.ok) return null;
  const { thumbnailLink: link } = (await meta.json()) as { thumbnailLink?: string };
  if (!link) return null;
  thumbLinkCache.set(fileId, { link, at: Date.now() });
  return link;
}

/**
 * Drive's own thumbnail for a file, at the requested width.
 *
 * Drive renders and caches these itself, so this costs a fraction of the
 * original both in bytes and in time, and nothing has to be generated or
 * stored on our side. Returns null when Drive has no thumbnail yet — a
 * freshly uploaded file, usually — and the caller falls back to the
 * original rather than showing nothing.
 */
export async function fetchDriveThumbnail(fileId: string, width: number): Promise<Thumb | null> {
  const key = `${fileId}@${width}`;
  const hit = thumbCache.get(key);
  if (hit && Date.now() - hit.at < THUMB_TTL_MS) {
    thumbCache.delete(key);
    thumbCache.set(key, hit); // most recently used goes to the back
    return hit.thumb;
  }
  const pending = thumbInFlight.get(key);
  if (pending) return pending;

  const work = (async (): Promise<Thumb | null> => {
    // The thumbnail host is public-but-unguessable and does not take the
    // service account's Authorization header.
    const fetchSized = async (link: string) =>
      // Drive hands back a link ending in =s220 (or similar); asking for the
      // width we actually render avoids scaling a too-small image up.
      fetch(link.replace(/=s\d+(-c)?$/, `=s${width}`), { cache: "no-store" });

    let link = await thumbnailLink(fileId);
    if (!link) return null;
    let res = await fetchSized(link);
    // A remembered link that has since expired: ask for a new one, once.
    if (!res.ok) {
      link = await thumbnailLink(fileId, true);
      if (!link) return null;
      res = await fetchSized(link);
    }
    if (!res.ok) return null;
    const thumb = {
      bytes: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") || "image/jpeg",
    };
    rememberThumb(key, thumb);
    return thumb;
  })().finally(() => thumbInFlight.delete(key));

  thumbInFlight.set(key, work);
  return work;
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

// ── Generic listing/search/upload, for the iOS photo browser ──────────────
//
// The phone used to talk to Drive directly, which meant shipping the
// service-account private key inside the .ipa — an unzippable archive. These
// three helpers back /api/drive/* so the phone can browse the same folders
// through the server, holding no credential of its own.

export interface DriveListing {
  files: DriveProofFile[];
  nextPageToken: string | null;
}

const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,modifiedTime,thumbnailLink,webViewLink)";

async function driveQuery(q: string, pageToken?: string | null, pageSize = 200): Promise<DriveListing> {
  const headers = await authHeader();
  const params = new URLSearchParams({
    q,
    fields: LIST_FIELDS,
    pageSize: String(pageSize),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    orderBy: "folder,name",
  });
  if (pageToken) params.set("pageToken", pageToken);

  const res = await fetch(`${DRIVE_BASE}/files?${params}`, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
  const json = (await res.json()) as { files?: DriveProofFile[]; nextPageToken?: string };
  return { files: json.files ?? [], nextPageToken: json.nextPageToken ?? null };
}

/**
 * Everything inside one folder, one page at a time.
 *
 * `namePrefix` and `imagesOnly` exist because the proof/cheque viewers want
 * "the images in this folder whose name starts with X" — pushing that into
 * the Drive query keeps the phone from downloading a whole folder to throw
 * most of it away.
 */
export async function listDriveFolder(
  folderId: string,
  pageToken?: string | null,
  opts: { namePrefix?: string | null; imagesOnly?: boolean } = {}
): Promise<DriveListing> {
  const clauses = [`'${folderId.replace(/'/g, "\\'")}' in parents`, "trashed = false"];
  if (opts.namePrefix) clauses.push(`name contains '${opts.namePrefix.replace(/'/g, "\\'")}'`);
  if (opts.imagesOnly) clauses.push("mimeType contains 'image/'");
  return driveQuery(clauses.join(" and "), pageToken);
}

/** Name search across the whole Drive the service account can see. */
/**
 * Folder ids the photo library legitimately spans: its root plus the folders
 * directly inside it, which is how the library is arranged (Products → a
 * folder per category → the photos). Cached for a minute, because a search
 * box asks on every keystroke and the shape of the library changes rarely.
 */
let photoScopeCache: { ids: string[]; at: number } | null = null;
const PHOTO_SCOPE_TTL_MS = 60_000;

async function photoLibraryScope(): Promise<string[]> {
  if (photoScopeCache && Date.now() - photoScopeCache.at < PHOTO_SCOPE_TTL_MS) {
    return photoScopeCache.ids;
  }
  const root = await productPhotosFolderId();
  const { files } = await driveQuery(
    `'${root}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    null,
    200
  );
  const ids = [root, ...files.map((f) => f.id)];
  photoScopeCache = { ids, at: Date.now() };
  return ids;
}

/**
 * Search the PRODUCT PHOTO LIBRARY, and only that.
 *
 * This used to search everything the service account could see. Both callers
 * are photo browsers, but the account can also see the private uploads
 * folder — cheque photos, delivery proof, invoice PDFs — so any signed-in
 * salesman typing a customer's name into the photo search got back pictures
 * of that customer's cheques. Nobody had to do anything wrong for that to
 * happen; it was one unscoped query.
 *
 * Drive's query language cannot search a subtree, so the scope is named
 * explicitly: the library root and the category folders inside it.
 */
export async function searchDrive(text: string, pageToken?: string | null): Promise<DriveListing> {
  const scope = await photoLibraryScope();
  const parents = scope.map((id) => `'${id}' in parents`).join(" or ");
  return driveQuery(
    `name contains '${text.replace(/'/g, "\\'")}' and trashed = false and (${parents})`,
    pageToken
  );
}
