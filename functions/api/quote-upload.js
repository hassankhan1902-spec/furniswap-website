// Cloudflare Pages Function: POST /api/quote-upload
//
// Receives the photo-quote form (name, phone, compressed photos), creates a
// folder per submission in Google Drive and stores the photos plus a
// submission.json there. Phase 2 (AI pricing) will read these folders.
//
// Environment variables (Cloudflare Pages → Settings → Variables and Secrets):
//   GOOGLE_CLIENT_ID       OAuth client ID          (required)
//   GOOGLE_CLIENT_SECRET   OAuth client secret      (required, secret)
//   GOOGLE_REFRESH_TOKEN   refresh token, drive.file scope (required, secret)
//   DRIVE_ROOT_FOLDER_ID   optional; if unset, a "FurniSwap Quotes" folder is
//                          found or created in the account's My Drive
//   TURNSTILE_SECRET       optional; when set, a valid Turnstile token is required

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024; // browser compresses to ~400KB
const ROOT_FOLDER_NAME = 'FurniSwap Quotes';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let cachedRootFolderId = null;
let cachedToken = null; // { value, expiresAt }

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
      console.error('quote-upload: Google credentials are not configured');
      return json(503, 'Photo upload is not available yet. Please send your photos on WhatsApp.');
    }

    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_PHOTOS * MAX_PHOTO_BYTES + 64 * 1024) {
      return json(413, 'Photos are too large. Please try fewer photos.');
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return json(400, 'Invalid form submission.');
    }

    // Honeypot: real visitors never fill this hidden field.
    if (String(form.get('website') || '').trim()) {
      return json(200, null, { ok: true, id: makeId() });
    }

    if (env.TURNSTILE_SECRET) {
      const token = String(form.get('cf-turnstile-response') || '');
      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (!(await verifyTurnstile(env.TURNSTILE_SECRET, token, ip))) {
        return json(403, 'Security check failed. Please refresh the page and try again.');
      }
    }

    const name = cleanName(form.get('name'));
    if (!name) return json(400, 'Please enter your name.');

    const phone = normalizePhone(form.get('phone'));
    if (!phone) return json(400, 'Please enter a valid WhatsApp number.');

    const lang = form.get('lang') === 'ur' ? 'ur' : 'en';

    const photos = form.getAll('photos').filter(f => typeof f === 'object' && f && 'arrayBuffer' in f);
    if (!photos.length) return json(400, 'Please add at least one photo.');
    if (photos.length > MAX_PHOTOS) return json(400, `Please send at most ${MAX_PHOTOS} photos.`);
    for (const p of photos) {
      if (!String(p.type || '').startsWith('image/')) return json(400, 'Only image files can be uploaded.');
      if (p.size > MAX_PHOTO_BYTES) return json(413, 'One of the photos is too large.');
    }

    const id = makeId();
    const createdAt = new Date().toISOString();
    const token = await getAccessToken(env);
    const rootId = await getRootFolderId(env, token);
    const folder = await driveCreate(token, { name: `${id} - ${name}`, mimeType: FOLDER_MIME, parents: [rootId] });

    const uploaded = [];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const fileName = `${id}-photo-${i + 1}.jpg`;
      const file = await driveUpload(token, { name: fileName, parents: [folder.id] }, p.type || 'image/jpeg', await p.arrayBuffer());
      uploaded.push({ name: fileName, fileId: file.id, bytes: p.size });
    }

    const submission = {
      id,
      createdAt,
      status: 'new',
      source: 'website',
      lang,
      customer: { name, whatsapp: phone },
      photos: uploaded,
      driveFolderId: folder.id,
    };
    await driveUpload(
      token,
      { name: 'submission.json', parents: [folder.id] },
      'application/json',
      new TextEncoder().encode(JSON.stringify(submission, null, 2)),
    );

    return json(200, null, { ok: true, id });
  } catch (err) {
    console.error('quote-upload failed:', err && err.stack ? err.stack : err);
    // Short, non-sensitive failure code (e.g. "google_auth:invalid_grant", "drive:403")
    // so problems can be diagnosed from the browser's network tab.
    const code = (err && err.code) || 'internal';
    return json(500, null, {
      ok: false,
      error: 'Something went wrong while saving your photos. Please try again or send them on WhatsApp.',
      code,
    });
  }
}

// ---------------------------------------------------------------- helpers

function json(status, error, body) {
  return new Response(JSON.stringify(body || { ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// FS-YYYYMMDD-XXXX, using an alphabet without look-alike characters.
function makeId() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `FS-${ymd}-${suffix}`;
}

function cleanName(raw) {
  const s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>"'\\/]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s.length >= 2 ? s : null;
}

// Same rules as normalizePhone() in index.html. The browser sends international
// numbers as bare digits (the "+" is dropped), so 11+ digits not starting with
// 92 are accepted as international here.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D/g, '');
  const intl = s.startsWith('+') || d.startsWith('00');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^03\d{9}$/.test(d)) return '92' + d.slice(1);
  if (/^3\d{9}$/.test(d)) return '92' + d;
  if (/^923\d{9}$/.test(d)) return d;
  if (/^[1-9]\d{9,14}$/.test(d) && !d.startsWith('92') && (intl || d.length >= 11)) return d;
  return null;
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

async function getAccessToken(env) {
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

async function getRootFolderId(env, token) {
  if (env.DRIVE_ROOT_FOLDER_ID) return env.DRIVE_ROOT_FOLDER_ID;
  if (cachedRootFolderId) return cachedRootFolderId;

  const q = `name = '${ROOT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await driveJson(res, 'find root folder');
  if (data.files && data.files.length) {
    cachedRootFolderId = data.files[0].id;
  } else {
    cachedRootFolderId = (await driveCreate(token, { name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME })).id;
  }
  return cachedRootFolderId;
}

async function driveCreate(token, metadata) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  return driveJson(res, `create "${metadata.name}"`);
}

// Multipart upload (metadata + content in one request); fine for files < 5MB.
async function driveUpload(token, metadata, mimeType, bytes) {
  const boundary = 'fs' + crypto.randomUUID().replace(/-/g, '');
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return driveJson(res, `upload "${metadata.name}"`);
}

async function driveJson(res, what) {
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
