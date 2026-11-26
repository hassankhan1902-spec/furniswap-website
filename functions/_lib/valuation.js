// Trade-in credit calculator shared by the AI pricing step and the admin page.
// The numbers mirror ValuationEngine in index.html (the public calculator):
// keep both in sync when benchmarks or factors change.

export const BENCHMARKS = {
  'sofa-5': { name: '5-Seater Sofa Suite (3+2)', base: 95000 },
  'sofa-7': { name: '7-Seater Sofa Suite (3+2+1+1)', base: 135000 },
  'sofa-l': { name: 'L-Shape Corner Sectional', base: 155000 },
  'sofa-1': { name: 'Single Armchair / Accent Chair', base: 32000 },
  'table-center': { name: 'Center / Coffee Table (Solid Wood)', base: 26000 },
  'bed-king': { name: 'King Size Bed Frame', base: 75000 },
  'bed-queen': { name: 'Queen Size Bed Frame', base: 62000 },
  'bed-suite': { name: 'Master Bed + 2 Side Tables + Dresser', base: 145000 },
  'dining-6': { name: '6-Seater Dining Set (Table + 6 Chairs)', base: 90000 },
  'dining-4': { name: '4-Seater Dining Set (Table + 4 Chairs)', base: 58000 },
  'dining-8': { name: '8-Seater Dining Suite (Table + 8 Chairs)', base: 150000 },
  'storage-2': { name: '2-Door Wardrobe / Cupboard', base: 45000 },
  'storage-3': { name: '3-Door Wardrobe with Mirrors', base: 75000 },
  'storage-4': { name: '4-Door Master Wardrobe Unit', base: 110000 },
  'credenza': { name: 'Console / TV Credenza Unit', base: 48000 },
  'other': { name: 'Other Custom Furniture Piece', base: 50000 },
};

export const CONDITION_RATES = {
  'like-new': { min: 0.42, max: 0.52, label: 'Like New' },
  'good': { min: 0.30, max: 0.40, label: 'Good' },
  'fair': { min: 0.18, max: 0.28, label: 'Fair' },
  'poor': { min: 0.08, max: 0.16, label: 'Heavily Worn' },
};

export const AGE_FACTORS = {
  'under-1': 1.05,
  '1-3': 1.0,
  '3-5': 0.88,
  '5-10': 0.72,
  '10-plus': 0.58,
};

export const MATERIAL_FACTORS = {
  'sheesham': 1.15,
  'acacia': 1.10,
  'teak-oak': 1.18,
  'hardwood': 1.0,
  'mdf-chipboard': 0.85,
  'mixed-other': 0.95,
};

// Used when the AI can't tell the age from the photos.
export const DEFAULT_AGE_KEY = '3-5';

// Credit is capped at this share of the median OLX used price, when enough
// comparable listings were found. Overridable with the OLX_CAP_PCT env var.
export const DEFAULT_OLX_CAP_PCT = 70;
export const MIN_OLX_COMPARABLES = 3;

const roundTo500 = n => Math.round(n / 500) * 500;

// Same formula as ValuationEngine.calculate() in index.html.
export function calculateCredit(typeKey, conditionKey, ageKey, materialKey) {
  const bench = BENCHMARKS[typeKey] || BENCHMARKS.other;
  const cond = CONDITION_RATES[conditionKey] || CONDITION_RATES.good;
  const ageFac = AGE_FACTORS[ageKey] || AGE_FACTORS[DEFAULT_AGE_KEY];
  const matFac = MATERIAL_FACTORS[materialKey] || 1.0;

  const baseVal = bench.base * ageFac * matFac;
  let minCredit = roundTo500(baseVal * cond.min);
  let maxCredit = roundTo500(baseVal * cond.max);
  if (minCredit < 4000) minCredit = 4000;
  if (maxCredit < minCredit + 2000) maxCredit = minCredit + 3000;

  return {
    typeKey, conditionKey, ageKey, materialKey,
    benchmark: bench.base,
    ageFactor: ageFac,
    materialFactor: matFac,
    conditionRate: { min: cond.min, max: cond.max },
    minCredit,
    maxCredit,
  };
}

export function median(values) {
  const v = values.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

// Applies the OLX cap to a calculateCredit() result.
// comparables: [{ source, listingType, priceRs, similarity }]
export function applyOlxCap(credit, comparables, capPct = DEFAULT_OLX_CAP_PCT) {
  const olxUsed = (comparables || []).filter(c =>
    c && c.source === 'olx' && c.listingType === 'used' &&
    (c.similarity === 'high' || c.similarity === 'medium') && c.priceRs > 0);
  const olxMedian = median(olxUsed.map(c => c.priceRs));
  const result = {
    ...credit,
    olx: { count: olxUsed.length, median: olxMedian, capPct, cap: null, applied: false },
  };
  if (olxUsed.length >= MIN_OLX_COMPARABLES && olxMedian) {
    const cap = roundTo500(olxMedian * capPct / 100);
    result.olx.cap = cap;
    if (credit.maxCredit > cap) {
      result.olx.applied = true;
      result.maxCredit = Math.max(cap, 2000);
      result.minCredit = Math.min(credit.minCredit, roundTo500(result.maxCredit * 0.85));
    }
  }
  return result;
}
