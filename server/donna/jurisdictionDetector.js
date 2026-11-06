// Pure-function jurisdiction detector. Takes signals from a parsed
// bank statement and returns the inferred jurisdiction + a confidence
// level. Never writes to the database — the caller (a recorder in
// firmDb.js) decides whether to apply the inference.
//
// The detector intentionally never writes the authoritative
// `jurisdiction` field; that's an operator confirmation. This module
// only suggests, it doesn't decide. See
// docs/jurisdiction-services-accounting-plan.md for the full design.

// ── Lookup tables ───────────────────────────────────────────────────────────
// Conservative starter set. Adding a bank, currency, IBAN prefix, or
// tax-id pattern improves accuracy without code changes elsewhere.
// Multi-country brands (HSBC, Citi, Standard Chartered, …) live in the
// branded sub-keys ("hsbc uk", "hsbc hong kong") rather than the bare
// name, because the bare name is ambiguous.

const BANK_TO_JURISDICTION = {
  // SG
  'dbs bank': 'sg', 'dbs': 'sg', 'posb': 'sg',
  'ocbc': 'sg', 'oversea-chinese': 'sg',
  'uob': 'sg', 'united overseas bank': 'sg',
  // GB
  'barclays': 'gb', 'lloyds': 'gb', 'natwest': 'gb', 'nat west': 'gb',
  'hsbc uk': 'gb', 'santander uk': 'gb',
  'monzo': 'gb', 'starling': 'gb', 'revolut ltd': 'gb',
  // US
  'jpmorgan chase': 'us', 'chase bank': 'us', 'jpmorgan': 'us',
  'wells fargo': 'us', 'bank of america': 'us', 'citibank n.a.': 'us',
  'us bank': 'us', 'u.s. bank': 'us', 'pnc bank': 'us', 'capital one': 'us',
  // AU
  'commonwealth bank of australia': 'au', 'cba australia': 'au',
  'westpac': 'au', 'national australia bank': 'au', 'nab australia': 'au',
  'anz australia': 'au',
  // HK
  'hsbc hong kong': 'hk', 'hang seng bank': 'hk',
  'bank of china (hong kong)': 'hk', 'boc hong kong': 'hk',
  'standard chartered hong kong': 'hk',
  // NZ
  'asb bank': 'nz', 'kiwibank': 'nz', 'bnz': 'nz', 'bank of new zealand': 'nz',
  // MY
  'maybank malaysia': 'my', 'cimb bank malaysia': 'my',
  // CA
  'royal bank of canada': 'ca', 'td canada trust': 'ca',
  'bank of montreal': 'ca', 'scotiabank canada': 'ca',
  // AE
  'emirates nbd': 'ae', 'first abu dhabi bank': 'ae',
  'abu dhabi commercial bank': 'ae', 'mashreq': 'ae', 'rakbank': 'ae',
  'dubai islamic bank': 'ae', 'abu dhabi islamic bank': 'ae', 'wio bank': 'ae'
};

// Currency → list of jurisdictions where this is the primary domestic
// currency. Single-element lists are strong signals (medium); multi-
// element / global currencies (USD, EUR) are omitted because they
// don't discriminate.
const CURRENCY_TO_JURISDICTIONS = {
  SGD: ['sg'],
  HKD: ['hk'],
  GBP: ['gb'],
  AUD: ['au'],
  NZD: ['nz'],
  MYR: ['my'],
  CAD: ['ca'],
  AED: ['ae']
  // USD, EUR omitted — non-discriminating.
};

// IBAN country prefix (first 2 chars of an IBAN) → jurisdiction.
// SG / HK / US don't use IBAN domestically (US has limited issuance);
// the prefixes we list are the ones whose presence on an account
// number is a strong signal.
const IBAN_PREFIX_TO_JURISDICTION = {
  GB: 'gb',
  AU: 'au',
  NZ: 'nz',
  CA: 'ca',
  MY: 'my',
  // The UAE mandates IBAN for domestic transfers, so an AE prefix on a
  // statement account is a strong signal.
  AE: 'ae'
};

// Date format heuristic. Only `MM/DD/YYYY` (US) is discriminating;
// everywhere else uses `DD/MM/YYYY` so a DD/MM date doesn't narrow
// the jurisdiction much beyond "not US".
const DATE_FORMAT_TO_JURISDICTIONS = {
  'MM/DD/YYYY': ['us'],
  'MM/DD/YY': ['us']
};

// Tax identifier regex patterns. Each match implies a single
// jurisdiction with high confidence — these strings have country-
// specific shapes that don't collide.
const TAX_ID_PATTERNS = [
  { regex: /\buen[\s:.\-]*\d{8,10}[a-z]\b/i, jurisdiction: 'sg', label: 'UEN' },
  { regex: /\bgst\s*(?:reg(?:n|istration)?\.?\s*)?(?:no\.?\s*)?[:.\-]?\s*\d{8,12}[a-z]\b/i, jurisdiction: 'sg', label: 'GST reg' },
  { regex: /\babn[\s:.\-]*\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b/i, jurisdiction: 'au', label: 'ABN' },
  { regex: /\bnzbn[\s:.\-]*\d{13}\b/i, jurisdiction: 'nz', label: 'NZBN' },
  { regex: /\bvat\s*(?:reg(?:n|istration)?\.?\s*)?(?:no\.?\s*)?[:.\-]?\s*gb\s*\d{9,12}\b/i, jurisdiction: 'gb', label: 'GB VAT' },
  { regex: /\bcompany\s*(?:no|number)\.?\s*[:.\-]?\s*\d{8}\b/i, jurisdiction: 'gb', label: 'Companies House no.' },
  { regex: /\bein[\s:.\-]*\d{2}-\d{7}\b/i, jurisdiction: 'us', label: 'EIN' },
  // FTA Tax Registration Number — 15 digits, printed as 'TRN 100…' on UAE
  // tax invoices and statements.
  { regex: /\btrn[\s:.\-]*\d{15}\b/i, jurisdiction: 'ae', label: 'TRN' }
];

// Confidence rank for ordering. `conflicted` sits below high because
// a conflict resolution means we couldn't pick — the UI shows both
// candidates and asks the operator.
export const CONFIDENCE_RANK = { conflicted: 0, low: 1, medium: 2, high: 3 };

// ── Signal collection ──────────────────────────────────────────────────────
// Each fire produces one signal:
//   { kind, jurisdiction, confidence, evidence }
// Confidence is per-signal-kind initial weight; combineSignals can
// bump 2× medium → high when the jurisdictions agree.

const SIGNAL_BASELINE = {
  bank_name: 'high',
  iban: 'high',
  tax_id: 'high',
  currency: 'medium',
  date_format: 'low'
};

const findBankJurisdiction = (bankName) => {
  if (!bankName) return null;
  const norm = String(bankName).trim().toLowerCase();
  if (!norm) return null;
  // Longest match wins so "hsbc uk" hits before a bare "hsbc" would
  // ever land (HSBC is intentionally not in the bare list).
  let best = null;
  for (const [key, jurisdiction] of Object.entries(BANK_TO_JURISDICTION)) {
    if (norm.includes(key) && (!best || key.length > best.key.length)) {
      best = { key, jurisdiction };
    }
  }
  return best;
};

const ibanCountry = (accountNumber) => {
  if (!accountNumber) return null;
  const norm = String(accountNumber).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d/.test(norm)) return null;
  const prefix = norm.slice(0, 2);
  const jurisdiction = IBAN_PREFIX_TO_JURISDICTION[prefix] || null;
  return jurisdiction ? { prefix, jurisdiction } : null;
};

export const collectJurisdictionSignals = (input = {}) => {
  const signals = [];

  // Bank name
  const bankHit = findBankJurisdiction(input.bankName);
  if (bankHit) {
    signals.push({
      kind: 'bank_name',
      jurisdiction: bankHit.jurisdiction,
      confidence: SIGNAL_BASELINE.bank_name,
      evidence: `Bank "${input.bankName}" → ${bankHit.jurisdiction.toUpperCase()}`
    });
  }

  // IBAN
  const ibanHit = ibanCountry(input.accountNumber);
  if (ibanHit) {
    signals.push({
      kind: 'iban',
      jurisdiction: ibanHit.jurisdiction,
      confidence: SIGNAL_BASELINE.iban,
      evidence: `IBAN prefix "${ibanHit.prefix}" → ${ibanHit.jurisdiction.toUpperCase()}`
    });
  }

  // Currency
  if (input.currency) {
    const code = String(input.currency).trim().toUpperCase();
    const list = CURRENCY_TO_JURISDICTIONS[code];
    if (list && list.length === 1) {
      signals.push({
        kind: 'currency',
        jurisdiction: list[0],
        confidence: SIGNAL_BASELINE.currency,
        evidence: `Currency ${code} → ${list[0].toUpperCase()}`
      });
    }
  }

  // Date format
  if (input.dateFormat) {
    const list = DATE_FORMAT_TO_JURISDICTIONS[input.dateFormat];
    if (list && list.length === 1) {
      signals.push({
        kind: 'date_format',
        jurisdiction: list[0],
        confidence: SIGNAL_BASELINE.date_format,
        evidence: `Date format ${input.dateFormat} → ${list[0].toUpperCase()}`
      });
    }
  }

  // Tax id — scan a concatenation of text-bearing fields once.
  const textPool = [input.text, input.statementAddress, input.taxIdentifier]
    .filter((v) => typeof v === 'string')
    .join(' ');
  if (textPool) {
    for (const { regex, jurisdiction, label } of TAX_ID_PATTERNS) {
      const match = textPool.match(regex);
      if (match) {
        signals.push({
          kind: 'tax_id',
          jurisdiction,
          confidence: SIGNAL_BASELINE.tax_id,
          evidence: `${label} pattern "${match[0].trim()}" → ${jurisdiction.toUpperCase()}`
        });
      }
    }
  }

  return signals;
};

// ── Combination ────────────────────────────────────────────────────────────
// Rules per the plan:
//   - 2+ jurisdictions at high confidence → conflicted (return null
//     jurisdiction).
//   - 1 high signal → high.
//   - 2+ signals on the same jurisdiction (any confidence) → bump to
//     high (the "currency + bank-name + date-format agreement" case).
//   - 1 medium signal → medium.
//   - 1 low signal → low.
//   - No signals → null.

export const combineJurisdictionSignals = (signals = []) => {
  if (!signals.length) return null;

  // Group by jurisdiction.
  const byJurisdiction = new Map();
  for (const sig of signals) {
    if (!byJurisdiction.has(sig.jurisdiction)) byJurisdiction.set(sig.jurisdiction, []);
    byJurisdiction.get(sig.jurisdiction).push(sig);
  }

  // Per-jurisdiction summary: max signal confidence + signal count.
  const summaries = [...byJurisdiction.entries()].map(([jurisdiction, sigs]) => {
    const max = sigs.reduce(
      (acc, s) => (CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[acc] ? s.confidence : acc),
      'low'
    );
    return { jurisdiction, signals: sigs, maxConfidence: max, count: sigs.length };
  });

  // Conflict: more than one jurisdiction implied at HIGH baseline.
  const highCount = summaries.filter((s) => s.maxConfidence === 'high').length;
  if (highCount > 1) {
    return {
      jurisdiction: null,
      confidence: 'conflicted',
      evidence: summaries
        .filter((s) => s.maxConfidence === 'high')
        .map((s) => s.signals[0].evidence)
        .join(' · '),
      signals
    };
  }

  // Sort by (max confidence desc, count desc); first is the winner.
  summaries.sort(
    (a, b) =>
      CONFIDENCE_RANK[b.maxConfidence] - CONFIDENCE_RANK[a.maxConfidence] ||
      b.count - a.count
  );
  const top = summaries[0];

  // Final confidence: if 2+ signals agree on this jurisdiction, bump
  // to high regardless of individual signal confidence.
  let finalConfidence = top.maxConfidence;
  if (top.count >= 2) finalConfidence = 'high';

  return {
    jurisdiction: top.jurisdiction,
    confidence: finalConfidence,
    evidence: top.signals.map((s) => s.evidence).join(' · '),
    signals
  };
};

// Public entry — collect signals, combine, return the inference (or
// null when there are no signals at all).
export const detectJurisdictionFromBankStatement = (input = {}) => {
  const signals = collectJurisdictionSignals(input);
  return combineJurisdictionSignals(signals);
};

// Exposed for introspection / tests.
export const __INTERNALS__ = {
  BANK_TO_JURISDICTION,
  CURRENCY_TO_JURISDICTIONS,
  IBAN_PREFIX_TO_JURISDICTION,
  DATE_FORMAT_TO_JURISDICTIONS,
  TAX_ID_PATTERNS,
  SIGNAL_BASELINE
};
