// GET  /api/admin/submissions/:folderId   submission, AI quote and review
// POST /api/admin/submissions/:folderId   { action: "price" | "approve" | "sent" | "reopen", finalCredit?, note? }
import { adminJson } from '../_middleware.js';
import {
  getAccessToken, getFolder, getRootFolderId, readJsonFile, writeJsonFile, setAppProperties,
} from '../../../_lib/drive.js';
import { priceSubmission } from '../../../_lib/pricing.js';
import { BENCHMARKS, CONDITION_RATES, AGE_FACTORS, MATERIAL_FACTORS } from '../../../_lib/valuation.js';

async function loadFolder(env, folderId) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId || '')) return null;
  const token = await getAccessToken(env);
  const folder = await getFolder(token, folderId).catch(() => null);
  if (!folder || folder.trashed) return null;
  const rootId = await getRootFolderId(env, token);
  if (!(folder.parents || []).includes(rootId)) return null;
  return { token, folder };
}

export async function onRequestGet({ env, params }) {
  const loaded = await loadFolder(env, params.folderId);
  if (!loaded) return adminJson(404, { ok: false, error: 'Submission not found.' });
  const { token, folder } = loaded;
  const [submission, quote, review] = await Promise.all([
    readJsonFile(token, folder.id, 'submission.json'),
    readJsonFile(token, folder.id, 'quote.json'),
    readJsonFile(token, folder.id, 'review.json'),
  ]);
  return adminJson(200, {
    ok: true,
    folderId: folder.id,
    status: (folder.appProperties || {}).status || 'new',
    error: (folder.appProperties || {}).error || null,
    submission,
    quote,
    review,
    labels: {
      types: Object.fromEntries(Object.entries(BENCHMARKS).map(([k, v]) => [k, v.name])),
      conditions: Object.fromEntries(Object.entries(CONDITION_RATES).map(([k, v]) => [k, v.label])),
      ages: Object.keys(AGE_FACTORS),
      materials: Object.keys(MATERIAL_FACTORS),
    },
  });
}

export async function onRequestPost({ request, env, params, data }) {
  const loaded = await loadFolder(env, params.folderId);
  if (!loaded) return adminJson(404, { ok: false, error: 'Submission not found.' });
  const { token, folder } = loaded;

  let body;
  try {
    body = await request.json();
  } catch {
    return adminJson(400, { ok: false, error: 'Invalid request.' });
  }

  const action = body && body.action;
  const review = (await readJsonFile(token, folder.id, 'review.json')) || { history: [] };
  const stamp = { by: data.adminEmail, at: new Date().toISOString() };

  if (action === 'price') {
    try {
      const quote = await priceSubmission(env, folder.id, { force: body.force === true });
      return adminJson(200, { ok: true, quote });
    } catch (err) {
      const code = err.code || 'internal';
      const status = code === 'busy' || code === 'already_approved' ? 409 : code === 'ai:not_configured' ? 503 : code === 'ai:quota' ? 429 : 502;
      return adminJson(status, { ok: false, error: err.message, code });
    }
  }

  if (action === 'approve') {
    const finalCredit = Math.round(Number(body.finalCredit));
    if (!Number.isFinite(finalCredit) || finalCredit < 0 || finalCredit > 5_000_000) {
      return adminJson(400, { ok: false, error: 'Enter a valid credit amount.' });
    }
    const note = String(body.note || '').slice(0, 1000);
    Object.assign(review, { finalCredit, note, approvedBy: stamp.by, approvedAt: stamp.at, sentAt: null });
    review.history.push({ action: 'approve', finalCredit, ...stamp });
    await writeJsonFile(token, folder.id, 'review.json', review);
    await setAppProperties(token, folder.id, { status: 'approved', finalCredit: String(finalCredit) });
    return adminJson(200, { ok: true, review });
  }

  if (action === 'sent') {
    review.sentAt = stamp.at;
    review.sentBy = stamp.by;
    review.history.push({ action: 'sent', ...stamp });
    await writeJsonFile(token, folder.id, 'review.json', review);
    await setAppProperties(token, folder.id, { status: 'sent' });
    return adminJson(200, { ok: true, review });
  }

  if (action === 'reopen') {
    review.history.push({ action: 'reopen', ...stamp });
    await writeJsonFile(token, folder.id, 'review.json', review);
    const props = folder.appProperties || {};
    await setAppProperties(token, folder.id, { status: props.minCredit ? 'priced' : 'new' });
    return adminJson(200, { ok: true, review });
  }

  return adminJson(400, { ok: false, error: 'Unknown action.' });
}
