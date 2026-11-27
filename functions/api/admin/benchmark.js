// Compare Workers AI models on one submission's photos.
// GET  /api/admin/benchmark?folderId=...   saved runs for that submission
// POST /api/admin/benchmark                { folderId, models?: string[] }
// Runs every model on the same photos in parallel, computes each model's credit
// range, and saves the run to benchmark.json in the submission's Drive folder.
// It never touches quote.json or the submission's status.
import { adminJson } from './_middleware.js';
import { getAccessToken, getFolder, getRootFolderId, readJsonFile, writeJsonFile } from '../../_lib/drive.js';
import {
  BENCHMARK_MODELS, FREE_NEURONS_PER_DAY, aiEnabled, assessPhotos, loadPhotos, quoteFromAssessment,
} from '../../_lib/pricing.js';

const MAX_SAVED_RUNS = 10;
const MODEL_RE = /^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+(#nothink)?$/i;

async function loadFolder(env, folderId) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId || '')) return null;
  const token = await getAccessToken(env);
  const folder = await getFolder(token, folderId).catch(() => null);
  if (!folder || folder.trashed) return null;
  const rootId = await getRootFolderId(env, token);
  if (!(folder.parents || []).includes(rootId)) return null;
  return { token, folder };
}

export async function onRequestGet({ env, request }) {
  const folderId = new URL(request.url).searchParams.get('folderId');
  const loaded = await loadFolder(env, folderId);
  if (!loaded) return adminJson(404, { ok: false, error: 'Submission not found.' });
  const saved = await readJsonFile(loaded.token, loaded.folder.id, 'benchmark.json');
  return adminJson(200, { ok: true, models: BENCHMARK_MODELS, freeNeuronsPerDay: FREE_NEURONS_PER_DAY, runs: (saved && saved.runs) || [] });
}

export async function onRequestPost({ env, request, data }) {
  if (!aiEnabled(env)) return adminJson(503, { ok: false, error: 'Workers AI binding "AI" is not configured.', code: 'ai:not_configured' });

  let body;
  try { body = await request.json(); } catch { return adminJson(400, { ok: false, error: 'Invalid request.' }); }

  const loaded = await loadFolder(env, body && body.folderId);
  if (!loaded) return adminJson(404, { ok: false, error: 'Submission not found.' });
  const { token, folder } = loaded;

  const models = Array.isArray(body.models) && body.models.length
    ? [...new Set(body.models.map(String))].filter(m => MODEL_RE.test(m)).slice(0, 8)
    : BENCHMARK_MODELS;
  if (!models.length) return adminJson(400, { ok: false, error: 'No valid models.' });

  const submission = await readJsonFile(token, folder.id, 'submission.json');
  if (!submission) return adminJson(404, { ok: false, error: 'submission.json missing.' });
  const [images, review] = await Promise.all([
    loadPhotos(token, submission),
    readJsonFile(token, folder.id, 'review.json'),
  ]);
  if (!images.length) return adminJson(400, { ok: false, error: 'No photos.' });

  const results = await Promise.all(models.map(async model => {
    const started = Date.now();
    try {
      const { assessment, usage } = await assessPhotos(env, images, model);
      const { credit, flags } = quoteFromAssessment(env, assessment);
      return { model, ok: true, assessment, minCredit: credit.minCredit, maxCredit: credit.maxCredit, flags, usage };
    } catch (err) {
      return { model, ok: false, error: String(err.message || err).slice(0, 200), code: err.code || 'error', ms: Date.now() - started };
    }
  }));

  const run = {
    at: new Date().toISOString(),
    by: data.adminEmail,
    photos: images.length,
    finalCredit: review && review.finalCredit != null ? review.finalCredit : null,
    results,
  };
  const saved = (await readJsonFile(token, folder.id, 'benchmark.json')) || { runs: [] };
  saved.runs = [run, ...(saved.runs || [])].slice(0, MAX_SAVED_RUNS);
  await writeJsonFile(token, folder.id, 'benchmark.json', saved);

  return adminJson(200, { ok: true, freeNeuronsPerDay: FREE_NEURONS_PER_DAY, run });
}
