// AI pricing for one submission:
//   1. Claude Haiku 5.5 looks at the photos, picks the calculator categories and
//      searches OLX / Interwood / Habitt for comparable listings (web search tool).
//   2. The calculator in valuation.js turns those picks into a credit range and
//      applies the OLX cap.
//   3. quote.json is written to the submission's Drive folder and the folder's
//      status moves to "priced" (or "failed").
//
// Needs the Pages secret ANTHROPIC_API_KEY. Optional: OLX_CAP_PCT (default 70).

import Anthropic from '@anthropic-ai/sdk';
import {
  BENCHMARKS, CONDITION_RATES, AGE_FACTORS, MATERIAL_FACTORS, DEFAULT_AGE_KEY,
  DEFAULT_OLX_CAP_PCT, calculateCredit, applyOlxCap,
} from './valuation.js';
import {
  getAccessToken, getFolder, readJsonFile, downloadFile, writeJsonFile, setAppProperties,
} from './drive.js';

export const MODEL = 'claude-haiku-5-5';
const MAX_PHOTOS_TO_SEND = 6;
// A run older than this is treated as abandoned (e.g. the background task was cut off).
export const STALE_PRICING_MS = 3 * 60 * 1000;

const TYPE_KEYS = Object.keys(BENCHMARKS);
const CONDITION_KEYS = Object.keys(CONDITION_RATES);
const AGE_KEYS = [...Object.keys(AGE_FACTORS), 'unknown'];
const MATERIAL_KEYS = Object.keys(MATERIAL_FACTORS);
const CONFIDENCE = ['high', 'medium', 'low'];

const ASSESSMENT_TOOL = {
  name: 'submit_assessment',
  description: 'Submit the final assessment of the furniture in the photos, with the comparable listings you found. Call this exactly once, at the end.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'itemDescription', 'typeKey', 'typeConfidence', 'materialKey', 'materialConfidence',
      'conditionKey', 'conditionConfidence', 'conditionNotes', 'ageKey', 'photoIssues',
      'searchQuery', 'comparables',
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
      comparables: {
        type: 'array',
        description: 'Listings found by web search that are genuinely similar. Only include listings whose price you actually saw in the search results. Empty if none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'listingType', 'title', 'priceRs', 'url', 'similarity'],
          properties: {
            source: { type: 'string', enum: ['olx', 'interwood', 'habitt', 'other'] },
            listingType: { type: 'string', enum: ['used', 'new'] },
            title: { type: 'string' },
            priceRs: { type: 'integer', description: 'Asking price in Pakistani rupees, as a whole number.' },
            url: { type: 'string' },
            similarity: { type: 'string', enum: CONFIDENCE },
          },
        },
      },
    },
  },
};

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 4,
  allowed_domains: ['olx.com.pk', 'interwood.pk', 'habitt.com'],
  user_location: { type: 'approximate', city: 'Islamabad', country: 'PK', timezone: 'Asia/Karachi' },
};

const SYSTEM_PROMPT = `You assess used furniture for FurniSwap, a furniture trade-in business in Islamabad and Rawalpindi, Pakistan. A customer has sent photos of furniture they want to trade in. Your assessment feeds a fixed pricing formula, and a FurniSwap team member reviews every quote before the customer sees it.

Your job:
1. Look carefully at all photos. Decide which category best fits the main item, what it is mostly made of, and its condition. Judge condition strictly from what is visible: scratches, stains, torn or faded fabric, sagging cushions, loose joints, peeling veneer. If an important part isn't visible, lower your confidence instead of guessing.
2. Use web search to find comparable listings and their prices in Pakistani rupees:
   - used listings on olx.com.pk, preferably in Islamabad or Rawalpindi
   - new prices for similar items on interwood.pk or habitt.com
   Make at most 4 searches. Only report a listing when its price appears in the search results; never invent or estimate a price or a URL.
3. Call submit_assessment once with your answer.

Material guide: sheesham, acacia and teak/oak are solid woods; "hardwood" is other solid wood; "mdf-chipboard" covers MDF, particle board and laminate; "mixed-other" covers metal, glass, cane, plastic or unclear mixes. Solid wood and veneer can look alike in photos, so say "low" confidence unless grain, edges or joints make it clear.

Category guide: a set counts by total seats (3+2 is sofa-5, 3+2+1+1 is sofa-7). Use "other" only when nothing else fits.`;

// Prices one submission folder. Returns the quote object that was saved.
export async function priceSubmission(env, folderId, { force = false } = {}) {
  if (!env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set');
    err.code = 'ai:not_configured';
    throw err;
  }
  const token = await getAccessToken(env);
  const folder = await getFolder(token, folderId);
  const props = folder.appProperties || {};

  if (!force && props.status === 'pricing' && Date.now() - Number(props.pricingStartedAt || 0) < STALE_PRICING_MS) {
    const err = new Error('Pricing is already running for this submission');
    err.code = 'busy';
    throw err;
  }
  if (!force && ['approved', 'sent'].includes(props.status)) {
    const err = new Error('Submission is already approved');
    err.code = 'already_approved';
    throw err;
  }

  await setAppProperties(token, folderId, { status: 'pricing', pricingStartedAt: String(Date.now()) });

  try {
    const submission = await readJsonFile(token, folderId, 'submission.json');
    if (!submission) {
      const err = new Error('submission.json missing');
      err.code = 'no_submission';
      throw err;
    }

    const images = [];
    for (const p of (submission.photos || []).slice(0, MAX_PHOTOS_TO_SEND)) {
      const res = await downloadFile(token, p.fileId);
      const bytes = new Uint8Array(await res.arrayBuffer());
      images.push({ mediaType: normalizeImageType(res.headers.get('content-type')), data: toBase64(bytes) });
    }
    if (!images.length) {
      const err = new Error('No photos to assess');
      err.code = 'no_photos';
      throw err;
    }

    const ai = await runAssessment(env, images);
    const a = ai.assessment;
    const ageKey = a.ageKey === 'unknown' ? DEFAULT_AGE_KEY : a.ageKey;
    const capPct = Number(env.OLX_CAP_PCT) > 0 ? Number(env.OLX_CAP_PCT) : DEFAULT_OLX_CAP_PCT;
    const comparables = (a.comparables || []).filter(c => c && c.priceRs > 0 && /^https?:\/\//.test(c.url));
    const credit = applyOlxCap(calculateCredit(a.typeKey, a.conditionKey, ageKey, a.materialKey), comparables, capPct);

    const flags = [];
    if (credit.olx.count < 3) flags.push('low_market_data');
    if ([a.typeConfidence, a.conditionConfidence].includes('low')) flags.push('needs_human_look');
    if (a.materialConfidence === 'low') flags.push('material_uncertain');
    if (a.ageKey === 'unknown') flags.push('age_assumed');
    if (a.photoIssues) flags.push('photo_issues');
    if (credit.olx.applied) flags.push('olx_cap_applied');

    const quote = {
      version: 1,
      submissionId: submission.id,
      pricedAt: new Date().toISOString(),
      model: MODEL,
      assessment: { ...a, ageKeyUsed: ageKey },
      comparables,
      credit,
      flags,
      usage: ai.usage,
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

async function runAssessment(env, images) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });

  const content = [
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    {
      type: 'text',
      text: `These ${images.length} photo(s) show one customer's furniture. Assess the main item, search for comparable listings, then call submit_assessment.`,
    },
  ];
  const messages = [{ role: 'user', content }];
  const usage = { inputTokens: 0, outputTokens: 0, webSearches: 0, requests: 0 };
  let nudged = false;

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      tools: [WEB_SEARCH_TOOL, ASSESSMENT_TOOL],
      tool_choice: { type: 'auto' },
      messages,
    });
    usage.requests++;
    usage.inputTokens += response.usage?.input_tokens || 0;
    usage.outputTokens += response.usage?.output_tokens || 0;
    usage.webSearches += response.usage?.server_tool_use?.web_search_requests || 0;

    if (response.stop_reason === 'refusal') {
      const err = new Error('The AI declined to assess these photos');
      err.code = 'ai:refusal';
      throw err;
    }

    const call = response.content.find(b => b.type === 'tool_use' && b.name === ASSESSMENT_TOOL.name);
    if (call) return { assessment: call.input, usage };

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue; // server-side search still running
    if (response.stop_reason === 'max_tokens') {
      const err = new Error('AI response was cut off');
      err.code = 'ai:max_tokens';
      throw err;
    }
    if (nudged) break;
    nudged = true;
    messages.push({ role: 'user', content: 'Please call submit_assessment now with your assessment and any comparables you found.' });
  }
  const err = new Error('AI did not return an assessment');
  err.code = 'ai:no_assessment';
  throw err;
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
