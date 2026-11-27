// Cloudflare Pages Function: POST /api/quote-upload
//
// Receives the photo-quote form (name, phone, compressed photos), creates a
// folder per submission in Google Drive and stores the photos plus a
// submission.json there. Then starts AI pricing in the background
// (functions/_lib/pricing.js); if that doesn't finish, the admin page retries it.
//
// Environment variables (Cloudflare Pages → Settings → Variables and Secrets):
//   GOOGLE_CLIENT_ID       OAuth client ID          (required)
//   GOOGLE_CLIENT_SECRET   OAuth client secret      (required, secret)
//   GOOGLE_REFRESH_TOKEN   refresh token, drive.file scope (required, secret)
//   DRIVE_ROOT_FOLDER_ID   optional; if unset, a "FurniSwap Quotes" folder is
//                          found or created in the account's My Drive
//   TURNSTILE_SECRET       optional; when set, a valid Turnstile token is required
//   AI (binding)           optional Workers AI binding; when set, uploads are priced automatically
//   GEMINI_API_KEY, GEMINI_MODEL, AI_GATEWAY_ID
//                          optional; OLX comparables via Gemini + Google Search (see _lib/market.js)
//   NOTIFY_EMAIL_TO, CF_ACCOUNT_ID, CF_EMAIL_API_TOKEN
//                          optional; when set, each upload emails the owner (see _lib/notify.js)

import {
  FOLDER_MIME, hasGoogleCredentials, getAccessToken, getRootFolderId, driveCreate, driveUpload,
} from '../_lib/drive.js';
import { aiEnabled, priceSubmission } from '../_lib/pricing.js';
import { sendUploadNotification } from '../_lib/notify.js';

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024; // browser compresses to ~400KB

export async function onRequestPost({ request, env, waitUntil }) {
  try {
    if (!hasGoogleCredentials(env)) {
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
    const folder = await driveCreate(token, {
      name: `${id} - ${name}`,
      mimeType: FOLDER_MIME,
      parents: [rootId],
      appProperties: { fsId: id, status: 'new' },
    });

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

    // Email the owner in the background; never blocks or fails the upload.
    if (typeof waitUntil === 'function') {
      waitUntil(sendUploadNotification(env, submission).catch(e => console.error('notify failed:', e)));
    }

    // Price in the background; the customer doesn't wait for it. Failures are
    // recorded on the folder and retried from the admin page.
    if (aiEnabled(env) && typeof waitUntil === 'function') {
      waitUntil(priceSubmission(env, folder.id).catch(() => {}));
    }

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
