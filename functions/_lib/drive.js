// Google Drive helpers (OAuth refresh token, drive.file scope) using plain fetch.
// Each quote submission is a folder under "FurniSwap Quotes" holding the photos,
// submission.json and (after AI pricing) quote.json. The folder's appProperties
// carry the workflow status so the admin page can list submissions cheaply.

export const ROOT_FOLDER_NAME = 'FurniSwap Quotes';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

let cachedRootFolderId = null;
let cachedToken = null; // { value, expiresAt }

export function hasGoogleCredentials(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

export async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(`Google token exchange failed (${res.status}): ${data.error || ''} ${data.error_description || ''}`);
    err.code = `google_auth:${String(data.error || res.status).replace(/[^a-z0-9_]/gi, '')}`;
    throw err;
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

export async function getRootFolderId(env, token) {
  if (env.DRIVE_ROOT_FOLDER_ID) return env.DRIVE_ROOT_FOLDER_ID;
  if (cachedRootFolderId) return cachedRootFolderId;
  const q = `name = '${ROOT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
  const data = await driveGet(token, `/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`, 'find root folder');
  cachedRootFolderId = data.files && data.files.length
    ? data.files[0].id
    : (await driveCreate(token, { name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME })).id;
  return cachedRootFolderId;
}

export async function driveCreate(token, metadata) {
  const res = await fetch(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  return driveJson(res, `create "${metadata.name}"`);
}

// Multipart upload (metadata + content in one request); fine for files < 5MB.
export async function driveUpload(token, metadata, mimeType, bytes) {
  const boundary = 'fs' + crypto.randomUUID().replace(/-/g, '');
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return driveJson(res, `upload "${metadata.name}"`);
}

// Replaces the content of an existing file.
export async function driveUpdateContent(token, fileId, mimeType, bytes) {
  const res = await fetch(`${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: bytes,
  });
  return driveJson(res, `update ${fileId}`);
}

// Creates or replaces a JSON file by name inside a folder.
export async function writeJsonFile(token, folderId, name, obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
  const existing = await findFile(token, folderId, name);
  if (existing) return driveUpdateContent(token, existing.id, 'application/json', bytes);
  return driveUpload(token, { name, parents: [folderId] }, 'application/json', bytes);
}

export async function findFile(token, folderId, name) {
  const q = `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  const data = await driveGet(token, `/files?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '1' })}`, `find ${name}`);
  return data.files && data.files[0] ? data.files[0] : null;
}

export async function readJsonFile(token, folderId, name) {
  const file = await findFile(token, folderId, name);
  if (!file) return null;
  const res = await fetch(`${API}/files/${encodeURIComponent(file.id)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) await driveJson(res, `read ${name}`);
  return res.json();
}

export async function downloadFile(token, fileId) {
  const res = await fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) await driveJson(res, `download ${fileId}`);
  return res;
}

export async function getFolder(token, folderId) {
  return driveGet(token, `/files/${encodeURIComponent(folderId)}?fields=id,name,createdTime,appProperties,trashed,parents`, 'get folder');
}

// Lists submission folders under the root, newest first.
export async function listSubmissionFolders(env, token, pageSize = 100) {
  const rootId = await getRootFolderId(env, token);
  const q = `'${rootId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const params = new URLSearchParams({ q, fields: 'files(id,name,createdTime,appProperties)', orderBy: 'createdTime desc', pageSize: String(pageSize) });
  const data = await driveGet(token, `/files?${params}`, 'list submissions');
  return data.files || [];
}

// Merges key/values into a folder's appProperties (values must be strings ≤ ~100 bytes).
export async function setAppProperties(token, fileId, props) {
  const res = await fetch(`${API}/files/${encodeURIComponent(fileId)}?fields=id,appProperties`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appProperties: props }),
  });
  return driveJson(res, `set properties on ${fileId}`);
}

async function driveGet(token, path, what) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return driveJson(res, what);
}

export async function driveJson(res, what) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error && data.error.message ? data.error.message : res.statusText;
    const err = new Error(`Google Drive ${what} failed (${res.status}): ${msg}`);
    const reason = data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    err.code = `drive:${res.status}${reason ? ':' + String(reason).replace(/[^a-z0-9_]/gi, '') : ''}`;
    throw err;
  }
  return data;
}
