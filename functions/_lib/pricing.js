// AI pricing for one submission, entirely on Cloudflare:
//   1. A Workers AI vision model looks at the photos and picks the calculator
//      categories (type, material, condition, age).
//   2. The calculator in valuation.js turns those picks into a credit range.
//      There is no automatic market search: open models on Workers AI can't
//      search the web, and OLX blocks automated access. The admin page links
//      to an OLX search so the team can check prices by hand.
//   3. quote.json is written to the submission's Drive folder and the folder's
//      status moves to "priced" (or "failed").
//
// Needs the Workers AI binding named AI (Pages → Settings → Bindings).
// Optional env vars: AI_MODEL (default DEFAULT_MODEL below), OLX_CAP_PCT.
//
// The previous Claude Haiku version is parked in functions/_legacy/anthropic/.

import {
  BENCHMARKS, CONDITION_RATES, AGE_FACTORS, MATERIAL_FACTORS, DEFAULT_AGE_KEY,
  DEFAULT_OLX_CAP_PCT, calculateCredit, applyOlxCap,
} from './valuation.js';
import {
  getAccessToken, getFolder, readJsonFile, downloadFile, writeJsonFile, setAppProperties,
} from './drive.js';

export const DEFAULT_MODEL = '@cf/google/gemma-4-26b-a4b-it';

// Models compared by the admin benchmark. A "#nothink" suffix turns the model's
// reasoning step off (only for models that have one).
export const BENCHMARK_MODELS = [
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/google/gemma-4-26b-a4b-it#nothink',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/qwen/qwen3.8-27b',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
];

// Workers AI bills in Neurons: $0.011 per 1,000, with 10,000 free per day.
export const USD_PER_NEURON = 0.011 / 1000;
export const FREE_NEURONS_PER_DAY = 10000;

const MAX_PHOTOS_TO_SEND = 4;
// A run older than this is treated as abandoned (e.g. the background task was cut off).
export const STALE_PRICING_MS = 3 * 60 * 1000;

const TYPE_KEYS = Object.keys(BENCHMARKS);
const CONDITION_KEYS = Object.keys(CONDITION_RATES);
const AGE_KEYS = [...Object.keys(AGE_FACTORS), 'unknown'];
const MATERIAL_KEYS = Object.keys(MATERIAL_FACTORS);
const CONFIDENCE = ['high', 'medium', 'low'];

const ASSESSMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'itemDescription', 'typeKey', 'typeConfidence', 'materialKey', 'materialConfidence',
    'conditionKey', 'conditionConfidence', 'conditionNotes', 'ageKey', 'photoIssues', 'searchQuery',
  ],
  properties: {
    itemDescription: { type: 'string', description: 'One sentence: what the item is, size, colour, style, visible brand.' },
    typeKey: { type: 'string', enum: TYPE_KEYS },
    typeConfidence: { type: 'string', enum: CONFIDENCE },
    materialKey: { type: 'string', enum: MATERIAL_KEYS },
    materialConfidence: { type: 'string', enum: CONFIDENCE },
    conditionKey: { type: 'string', enum: CONDITION_KEYS },
    conditionConfidence: { type: 'string', enum: CONFIDENCE },
    conditionNotes: { type: 'string', description: 'Visible wear, damage or repairs, or "none visible".' },
    ageKey: { type: 'string', enum: AGE_KEYS, description: 'Use "unknown" unless the photos give real evidence of age.' },
    photoIssues: { type: 'string', description: 'Problems that limit the assessment (blurry, item cut off, several items), or "" if none.' },
    searchQuery: { type: 'string', description: 'The search phrase a person would type on OLX to find this item.' },
  },
};

const SYSTEM_PROMPT = `You assess used furniture for FurniSwap, a furniture trade-in business in Islamabad and Rawalpindi, Pakistan. A customer has sent photos of furniture they want to trade in. Your answer feeds a fixed pricing formula, and a FurniSwap team member reviews every quote before the customer sees it.

Look carefully at all photos. Decide which category best fits the main item, what it is mostly made of, and its condition. Judge condition strictly from what is visible: scratches, stains, torn or faded fabric, sagging cushions, loose joints, peeling veneer. If an important part isn't visible, lower your confidence instead of guessing.

Allowed values:
- typeKey: ${TYPE_KEYS.map(k => `${k} (${BENCHMARKS[k].name})`).join(', ')}
- materialKey: ${MATERIAL_KEYS.join(', ')}
- conditionKey: ${CONDITION_KEYS.map(k => `${k} (${CONDITION_RATES[k].label})`).join(', ')}
- ageKey: ${AGE_KEYS.join(', ')} (years; use "unknown" unless the photos show real evidence of age)
- confidences: high, medium, low

Material guide: sheesham, acacia and teak/oak are solid woods; "hardwood" is other solid wood; "mdf-chipboard" covers MDF, particle board and laminate; "mixed-other" covers metal, glass, cane, plastic or unclear mixes. Solid wood and veneer can look alike in photos, so say "low" confidence unless grain, edges or joints make it clear.

Category guide: a set counts by total seats (3+2 is sofa-5, 3+2+1+1 is sofa-7). Use "other" only when nothing else fits.

Reply with one JSON object only, with exactly these keys: ${ASSESSMENT_SCHEMA.required.join(', ')}.`;

export function aiEnabled(env) {
  return !!(env && env.AI && typeof env.AI.run === 'function');
}

export function currentModel(env) {
  return String((env && env.AI_MODEL) || DEFAULT_MODEL).trim();
}

// Downloads up to `max` photos of a submission as data URLs.
export async function loadPhotos(token, submission, max = MAX_PHOTOS_TO_SEND) {
  const images = [];
  for (const p of (submission.photos || []).slice(0, max)) {
    const res = await downloadFile(token, p.fileId);
    const bytes = new Uint8Array(await res.arrayBuffer());
    images.push(`data:${normalizeImageType(res.headers.get('content-type'))};base64,${toBase64(bytes)}`);
  }
  return images;
}

// Runs one model on the photos. Returns { assessment, usage }.
// modelSpec is a Workers AI model id, optionally with "#nothink".
export async function assessPhotos(env, images, modelSpec) {
  if (!aiEnabled(env)) throw codedError('Workers AI binding "AI" is not configured', 'ai:not_configured');
  if (!images.length) throw codedError('No photos to assess', 'no_photos');
  const [model, variant] = String(modelSpec).split('#');
  const started = Date.now();

  const run = imgs => {
    const inputs = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            ...imgs.map(url => ({ type: 'image_url', image_url: { url } })),
            { type: 'text', text: `These ${imgs.length} photo(s) show one customer's furniture. Assess the main item and reply with the JSON object.` },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'assessment', schema: ASSESSMENT_SCHEMA, strict: true } },
      max_tokens: 4000,
      temperature: 0.2,
    };
    if (variant === 'nothink') inputs.chat_template_kwargs = { enable_thinking: false };
    return env.AI.run(model, inputs);
  };

  let imagesSent = images.length;
  let result;
  try {
    result = await run(images);
  } catch (err) {
    // Some models accept only one image per request; retry with the first photo.
    if (images.length < 2) throw wrapAiError(err);
    imagesSent = 1;
    try { result = await run(images.slice(0, 1)); } catch (err2) { throw wrapAiError(err2); }
  }

  const u = (result && result.usage) || {};
  const neurons = Number(u.neurons) || 0;
  const usage = {
    model: modelSpec,
    imagesSent,
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    neurons: Math.round(neurons * 10) / 10,
    costUsd: Math.round(neurons * USD_PER_NEURON * 1e6) / 1e6,
    ms: Date.now() - started,
  };

  const assessment = normalizeAssessment(parseModelJson(result));
  return { assessment, usage };
}

// Turns an assessment into the credit range and review flags.
export function quoteFromAssessment(env, a) {
  const ageKey = a.ageKey === 'unknown' ? DEFAULT_AGE_KEY : a.ageKey;
  const capPct = Number(env.OLX_CAP_PCT) > 0 ? Number(env.OLX_CAP_PCT) : DEFAULT_OLX_CAP_PCT;
  const credit = applyOlxCap(calculateCredit(a.typeKey, a.conditionKey, ageKey, a.materialKey), [], capPct);
  const flags = ['market_check_manual'];
  if ([a.typeConfidence, a.conditionConfidence].includes('low')) flags.push('needs_human_look');
  if (a.materialConfidence === 'low') flags.push('material_uncertain');
  if (a.ageKey === 'unknown') flags.push('age_assumed');
  if (a.photoIssues) flags.push('photo_issues');
  return { ageKey, credit, flags };
}

// Prices one submission folder. Returns the quote object that was saved.
export async function priceSubmission(env, folderId, { force = false } = {}) {
  if (!aiEnabled(env)) throw codedError('Workers AI binding "AI" is not configured', 'ai:not_configured');
  const token = await getAccessToken(env);
  const folder = await getFolder(token, folderId);
  const props = folder.appProperties || {};

  if (!force && props.status === 'pricing' && Date.now() - Number(props.pricingStartedAt || 0) < STALE_PRICING_MS) {
    throw codedError('Pricing is already running for this submission', 'busy');
  }
  if (!force && ['approved', 'sent'].includes(props.status)) {
    throw codedError('Submission is already approved', 'already_approved');
  }

  await setAppProperties(token, folderId, { status: 'pricing', pricingStartedAt: String(Date.now()) });

  try {
    const submission = await readJsonFile(token, folderId, 'submission.json');
    if (!submission) throw codedError('submission.json missing', 'no_submission');

    const images = await loadPhotos(token, submission);
    const model = currentModel(env);
    const { assessment: a, usage } = await assessPhotos(env, images, model);
    const { ageKey, credit, flags } = quoteFromAssessment(env, a);

    const quote = {
      version: 2,
      submissionId: submission.id,
      pricedAt: new Date().toISOString(),
      model,
      assessment: { ...a, ageKeyUsed: ageKey },
      comparables: [],
      credit,
      flags,
      usage,
    };
    await writeJsonFile(token, folderId, 'quote.json', quote);
    await setAppProperties(token, folderId, {
      status: 'priced',
      pricingStartedAt: '',
      minCredit: String(credit.minCredit),
      maxCredit: String(credit.maxCredit),
      typeKey: a.typeKey,
      flags: flags.join(',').slice(0, 100),
      error: '',
    });
    return quote;
  } catch (err) {
    console.error('priceSubmission failed:', err && err.stack ? err.stack : err);
    await setAppProperties(token, folderId, {
      status: 'failed',
      pricingStartedAt: '',
      error: String(err.code || err.name || 'error').slice(0, 90),
    }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------- helpers

// Workers AI returns either OpenAI-style choices or { response }, and the
// answer may be an object, a JSON string, or JSON wrapped in a code fence.
function parseModelJson(result) {
  const choice = result && Array.isArray(result.choices) ? result.choices[0] : null;
  let out = result && result.response != null ? result.response : choice && choice.message && choice.message.content;
  if (out && typeof out === 'object') return out;
  if (typeof out !== 'string' || !out.trim()) {
    const reason = choice && choice.finish_reason === 'length' ? 'ai:max_tokens' : 'ai:empty';
    throw codedError('The model returned no answer', reason);
  }
  out = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(out);
  } catch {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    throw codedError('The model did not return valid JSON', 'ai:bad_json');
  }
}

// Checks the model's picks against the allowed values. Small slips (case,
// spaces) are fixed; anything outside the lists fails the run.
function normalizeAssessment(raw) {
  const pick = (v, allowed, field, fallback) => {
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, '-');
    if (allowed.includes(s)) return s;
    if (fallback !== undefined) return fallback;
    throw codedError(`The model gave an invalid ${field}: ${String(v).slice(0, 40)}`, `ai:bad_${field}`);
  };
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  return {
    itemDescription: text(raw.itemDescription, 300),
    typeKey: pick(raw.typeKey, TYPE_KEYS, 'type'),
    typeConfidence: pick(raw.typeConfidence, CONFIDENCE, 'confidence', 'low'),
    materialKey: pick(raw.materialKey, MATERIAL_KEYS, 'material', 'mixed-other'),
    materialConfidence: pick(raw.materialConfidence, CONFIDENCE, 'confidence', 'low'),
    conditionKey: pick(raw.conditionKey, CONDITION_KEYS, 'condition'),
    conditionConfidence: pick(raw.conditionConfidence, CONFIDENCE, 'confidence', 'low'),
    conditionNotes: text(raw.conditionNotes, 300),
    ageKey: pick(raw.ageKey, AGE_KEYS, 'age', 'unknown'),
    photoIssues: text(raw.photoIssues, 200),
    searchQuery: text(raw.searchQuery, 80),
  };
}

function wrapAiError(err) {
  const msg = String((err && err.message) || err || 'Workers AI error');
  let code = 'ai:error';
  if (/daily free allocation|neurons|4006|upgrade/i.test(msg)) code = 'ai:quota';
  else if (/not found|no such model|5007/i.test(msg)) code = 'ai:no_model';
  else if (/rate limit|429|3040/i.test(msg)) code = 'ai:rate_limited';
  return codedError(msg.slice(0, 200), code);
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeImageType(contentType) {
  const t = String(contentType || '').split(';')[0].trim().toLowerCase();
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(t) ? t : 'image/jpeg';
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
