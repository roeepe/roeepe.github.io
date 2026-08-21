// Google Drive from the phone: sign-in, resumable upload, and result polling.
//
// Scope is drive.file only — the app can touch files it created and nothing
// else in the Drive. That constrains the design in a useful way: every result
// file is created here first as an empty placeholder, and the worker (Colab or
// the Actions runner) *updates* that file by id. Nothing ever needs broader
// access to read a result back.

import { store, sleep } from "./util.js";

const GIS = "https://accounts.google.com/gsi/client";
export const SCOPE = "https://www.googleapis.com/auth/drive.file";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

let tokenClient = null;
let token = null;            // {access_token, expiresAt}

export function getClientId() { return store.get("google.clientId", ""); }
export function setClientId(id) { store.set("google.clientId", (id || "").trim()); token = null; tokenClient = null; }

function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS}"]`);
    if (existing) { existing.addEventListener("load", resolve); existing.addEventListener("error", reject); return; }
    const s = document.createElement("script");
    s.src = GIS; s.async = true; s.defer = true;
    s.onload = resolve; s.onerror = () => reject(new Error("לא הצלחתי לטעון את ספריית ההזדהות של Google"));
    document.head.appendChild(s);
  });
}

export function signedIn() { return !!token && token.expiresAt > Date.now() + 60_000; }

/** @param {boolean} interactive false = try to refresh silently */
export async function signIn({ interactive = true } = {}) {
  const clientId = getClientId();
  if (!clientId) throw new Error("חסר Google OAuth Client ID — הגדירו אותו במסך ההגדרות");
  if (signedIn()) return token;
  await loadGIS();

  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        token = { access_token: resp.access_token, expiresAt: Date.now() + (resp.expires_in || 3600) * 1000 };
        resolve(token);
      },
      error_callback: (err) => reject(new Error(err?.message || "ההזדהות בוטלה")),
    });
    tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" });
  });
}

export function signOut() {
  if (token?.access_token) { try { window.google?.accounts?.oauth2?.revoke(token.access_token); } catch { /* ignore */ } }
  token = null;
}

async function auth() {
  if (!signedIn()) await signIn({ interactive: true });
  return { Authorization: `Bearer ${token.access_token}` };
}

async function api(url, init = {}, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = { ...(await auth()), ...(init.headers || {}) };
    const r = await fetch(url, { ...init, headers });
    if (r.ok) return r;
    if (r.status === 401 && attempt < 1) { token = null; continue; }
    if ((r.status === 429 || r.status >= 500) && attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
    throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

// ── folders & metadata ──────────────────────────────────────────────────────

export async function ensureFolder(name = "ivrit-transcribe") {
  const cached = store.get("google.folderId");
  if (cached) {
    try { await api(`${API}/${cached}?fields=id,trashed`); return cached; } catch { store.del("google.folderId"); }
  }
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  const found = await (await api(`${API}?q=${q}&fields=files(id,name)&pageSize=5`)).json();
  if (found.files?.length) { store.set("google.folderId", found.files[0].id); return found.files[0].id; }

  const created = await (await api(API, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  })).json();
  store.set("google.folderId", created.id);
  return created.id;
}

/** Gives an address (the Actions service account) write access to a file or folder. */
export async function shareWith(fileId, email, role = "writer") {
  return (await api(`${API}/${fileId}/permissions?sendNotificationEmail=false`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "user", role, emailAddress: email }),
  })).json();
}

export async function createFile({ name, parents = [], mimeType = "application/json", content = "" }) {
  const boundary = "-----ivrit" + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents, mimeType }) +
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  return (await api(`${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  })).json();
}

export async function updateFileContent(fileId, content, mimeType = "application/json") {
  return (await api(`${UPLOAD}/${fileId}?uploadType=media&fields=id`, {
    method: "PATCH", headers: { "Content-Type": `${mimeType}; charset=UTF-8` }, body: content,
  })).json();
}

export async function getFileText(fileId) {
  const r = await api(`${API}/${fileId}?alt=media`);
  return r.text();
}

export async function getFileMeta(fileId, fields = "id,name,size,modifiedTime,md5Checksum,webViewLink") {
  return (await api(`${API}/${fileId}?fields=${encodeURIComponent(fields)}`)).json();
}

// ── resumable upload ────────────────────────────────────────────────────────

const CHUNK = 8 * 1024 * 1024;   // 8 MB — small enough to retry cheaply on mobile data

/**
 * Uploads a recording with a resumable session, retrying individual chunks.
 * A dropped connection costs one chunk, not the whole file.
 */
export async function uploadFile(file, { name, parents = [], onProgress = () => {}, signal } = {}) {
  const meta = { name: name || file.name, parents };
  const start = await api(`${UPLOAD}?uploadType=resumable&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Upload-Content-Type": file.type || "application/octet-stream", "X-Upload-Content-Length": String(file.size) },
    body: JSON.stringify(meta),
  });
  const session = start.headers.get("Location");
  if (!session) throw new Error("Drive לא החזיר כתובת להעלאה");

  let offset = 0;
  let attempt = 0;
  while (offset < file.size) {
    if (signal?.aborted) throw new Error("ההעלאה בוטלה");
    const end = Math.min(file.size, offset + CHUNK);
    const blob = file.slice(offset, end);
    try {
      const r = await fetch(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${file.size}` },
        body: blob, signal,
      });
      if (r.status === 308) {
        const range = r.headers.get("Range");
        offset = range ? parseInt(range.split("-")[1], 10) + 1 : end;
        attempt = 0;
        onProgress({ loaded: offset, total: file.size, ratio: offset / file.size });
        continue;
      }
      if (r.ok) {
        onProgress({ loaded: file.size, total: file.size, ratio: 1 });
        return r.json();
      }
      throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (++attempt > 5) throw e;
      await sleep(1000 * 2 ** attempt);
      // Ask the server how much it actually kept before resending.
      const probe = await fetch(session, { method: "PUT", headers: { "Content-Range": `bytes */${file.size}` } });
      if (probe.status === 308) {
        const range = probe.headers.get("Range");
        offset = range ? parseInt(range.split("-")[1], 10) + 1 : offset;
      } else if (probe.ok) return probe.json();
    }
  }
  throw new Error("ההעלאה הסתיימה בלי תשובה מ-Drive");
}

// ── polling for a worker's result ───────────────────────────────────────────

/**
 * Watches a placeholder file until the worker writes a finished payload into it.
 * Backs off from 3 s to 20 s so a two-hour job does not cost hundreds of requests.
 */
export async function pollResult(fileId, { timeoutMs = 6 * 3600 * 1000, onTick = () => {}, signal } = {}) {
  const started = Date.now();
  let wait = 3000;
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error("ההמתנה בוטלה");
    try {
      const text = await getFileText(fileId);
      const payload = text.trim() ? JSON.parse(text) : null;
      onTick({ elapsedMs: Date.now() - started, payload });
      if (payload?.status === "done" || payload?.status === "error") return payload;
    } catch (e) {
      onTick({ elapsedMs: Date.now() - started, error: String(e.message || e) });
    }
    await sleep(wait);
    wait = Math.min(20000, wait * 1.3);
  }
  throw new Error("פג הזמן בהמתנה לתוצאה");
}

export const driveFileLink = (id) => `https://drive.google.com/file/d/${id}/view`;
export const driveFolderLink = (id) => `https://drive.google.com/drive/folders/${id}`;
