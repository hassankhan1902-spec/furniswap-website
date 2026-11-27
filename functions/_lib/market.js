// OLX comparables from Google's index, via Gemini with Grounding with Google Search.
//
// OLX blocks automated browsers (Cloudflare Browser Rendering got a 503), so we
// never fetch olx.com.pk ourselves. Gemini runs Google searches limited to OLX
// and reports the listings it saw. Everything it returns is checked here, and
// the team reviews every quote anyway.
//
// Env vars (Cloudflare Pages → Settings → Variables and Secrets):
//   GEMINI_API_KEY   secret; when unset, quotes are priced without market data
//   GEMINI_MODEL     optional, default DEFAULT_GEMINI_MODEL
//   AI_GATEWAY_ID    optional; route the call through Cloudflare AI Gateway
//   CF_ACCOUNT_ID    needed only with AI_GATEWAY_ID

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const TIMEOUT_MS = 25000;
const MAX_LISTINGS = 8;
const MIN_PRICE = 1000;
const MAX_PRICE = 2000000;
const SIMILARITY = ['high', 'medium', 'low'];

export function marketEnabled(env) {
  return Boolean(env && env.GEMINI_API_KEY);
}

function endpoint(env, model) {
  const path = `v1beta/models/${encodeURIComponent(model)}:generateContent`;
  if (env.AI_GATEWAY_ID && env.CF_ACCOUNT_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/google-ai-studio/${path}`;
  }
  return `https://generativelanguage.googleapis.com/${path}`;
}

function buildPrompt(a) {
  return `Find used furniture listings on olx.com.pk that match this item, so a trade-in business can compare prices.

Item: ${a.itemDescription}
Search phrase: ${a.searchQuery || ''}
Condition seen in photos: ${a.conditionKey}

Use Google Search with site:olx.com.pk. Prefer listings in Islamabad or Rawalpindi, then other Pakistani cities. Only report listings you actually saw in the search results, with the asking price in Pakistani rupees as shown. Never invent a listing, URL or price. Skip new-furniture shops, wanted ads, and listings with no price.

Reply with only this JSON, no other text:
{"listings":[{"title":"...","priceRs":12345,"url":"https://www.olx.com.pk/item/...","city":"...","similarity":"high|medium|low"}]}
similarity: high = same kind of item and similar size/style; medium = same kind, different size or style; low = loosely related.
Return at most ${MAX_LISTINGS} listings. If you found none, return {"listings":[]}.`;
}

// Returns { comparables, search }. Never throws: a failed search returns no
// comparables and search.error, and the quote falls back to manual checking.
export async function findOlxComparables(env, assessment) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const started = Date.now();
  const search = { model, queries: [], ms: 0, inputTokens: 0, outputTokens: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(env, model), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(assessment) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && (data.error.status || data.error.message)) || '';
      throw new Error(`gemini:${res.status}${msg ? ' ' + String(msg).slice(0, 80) : ''}`);
    }
    const cand = (data.candidates || [])[0] || {};
    const gm = cand.groundingMetadata || {};
    search.queries = (gm.webSearchQueries || []).slice(0, 10).map(String);
    const u = data.usageMetadata || {};
    search.inputTokens = u.promptTokenCount || 0;
    search.outputTokens = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);

    const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('').trim();
    const parsed = parseJson(text);
    const raw = parsed && Array.isArray(parsed.listings) ? parsed.listings : [];

    // Grounding evidence: did any search result Gemini used come from OLX?
    // (Chunk URIs are usually Google redirect links, so the title/domain is
    // what identifies the site.)
    const chunks = (gm.groundingChunks || []).map(c => c && c.web).filter(Boolean);
    const olxGrounded = chunks.some(w => /olx\.com\.pk/i.test(`${w.title || ''} ${w.uri || ''}`));
    search.groundingChunks = chunks.length;
    search.olxGrounded = olxGrounded;

    search.listingsReturned = raw.length;
    return { comparables: cleanListings(raw, olxGrounded), search: { ...search, ms: Date.now() - started } };
  } catch (err) {
    const error = err && err.name === 'AbortError' ? 'gemini:timeout' : String((err && err.message) || err).slice(0, 120);
    console.error('findOlxComparables failed:', error);
    return { comparables: [], search: { ...search, ms: Date.now() - started, error } };
  } finally {
    clearTimeout(timer);
  }
}

function cleanListings(raw, olxGrounded) {
  const seen = new Set();
  const out = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    let url;
    try { url = new URL(String(l.url || '')); } catch { continue; }
    if (url.protocol !== 'https:' || !/^(www\.)?olx\.com\.pk$/i.test(url.hostname)) continue;
    url.hash = '';
    const key = url.href.replace(/\/$/, '');
    if (seen.has(key)) continue;
    const priceRs = Math.round(Number(String(l.priceRs).replace(/[^\d.]/g, '')));
    if (!(priceRs >= MIN_PRICE && priceRs <= MAX_PRICE)) continue;
    seen.add(key);
    let similarity = SIMILARITY.includes(String(l.similarity).toLowerCase()) ? String(l.similarity).toLowerCase() : 'low';
    // Without any OLX search result behind the answer, don't let it move the price.
    if (!olxGrounded) similarity = 'low';
    out.push({
      source: 'olx',
      listingType: 'used',
      title: String(l.title || '').slice(0, 140),
      priceRs,
      url: url.href,
      city: String(l.city || '').slice(0, 40),
      similarity,
    });
    if (out.length >= MAX_LISTINGS) break;
  }
  return out;
}

function parseJson(text) {
  if (!text) return null;
  const t = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* try the first {...} block */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* none */ } }
  return null;
}
