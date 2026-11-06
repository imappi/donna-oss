import { toLocalIsoDay, toUtcDayMs } from './dates.js';
import { clientFlagActs } from './clientConfig.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Client-scoped auto-match canary, read INLINE to keep this widely-imported
// module free of the reconciliationLlmCore import — that forms a cycle via firmDb
// (reconciliationLlmCore → firmDb → transactionIntel) that TDZ-crashes on load.
// clientConfig.js has no firmDb edge (it imports only node:crypto), so importing
// clientFlagActs here is cycle-safe. Faithful mirror of
// reconciliationLlmCore.clientAllowedToAutoMatch — KEEP the flag key + env parsing
// in lockstep with core's AUTO_MATCH_FLAG_KEY.
//
// 0A.10 — routed through the config control plane: a client_capability_config row
// for this client decides (canary/auto act; off carves the client OUT); no row ⇒
// this env predicate (envFallback), byte-identical. configSnapshot is threaded in
// from refreshTransactionIntelForClient (which has the db client in scope) — this
// pure module never reads the db itself.
const AUTO_MATCH_FLAG_KEY = 'RECONCILIATION_AUTO_MATCH';
const clientAllowedToAutoMatch = (clientId, { configSnapshot = null, env = process.env } = {}) => clientFlagActs({
  flagKey: AUTO_MATCH_FLAG_KEY,
  snapshot: configSnapshot,
  envFallback: () => {
    const raw = env?.RECONCILIATION_AUTO_MATCH_CLIENTS;
    if (!raw) return true;
    const allow = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (!allow.length) return true;
    const id = clientId == null ? '' : String(clientId).trim();
    return !!id && allow.includes(id);
  },
  env
});

export const CATEGORY_ACCOUNTS = {
  income: 'Revenue',
  founder_draws: 'Director drawings',
  investor_inflows: 'Share capital',
  team_payroll: 'Payroll',
  contractors: 'Professional fees',
  saas_tools: 'Software subscriptions',
  meals_entertainment: 'Meals and entertainment',
  travel: 'Travel',
  loan_repayments: 'Loan repayment',
  intercompany: 'Intercompany transfer',
  taxes_fees: 'Taxes and bank fees',
  office_ops: 'Office operations',
  unknown: 'Suspense'
};

const PASSENGER_TRANSPORT_MERCHANTS = new Set(['taxi', 'uber', 'grab', 'bolt', 'cabify', 'freenow']);

export const normalizeIntelText = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(pte\.?|ltd\.?|private|limited|inc\.?|llc|gmbh|oy|ab)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

export const canonicalMerchantPattern = (value = '') => {
  const raw = String(value || '');
  const normalizedFull = normalizeIntelText(raw);
  if (!normalizedFull) return '';
  if (/\bfinnair\b/.test(normalizedFull)) return 'finnair';
  if (/\b(?:taxi|cab)\b/.test(normalizedFull)) return 'taxi';
  if (/\b(?:ubr|uber)\b/.test(normalizedFull)) return 'uber';
  if (/\bcabify\b/.test(normalizedFull)) return 'cabify';
  if (/\bbolt\b/.test(normalizedFull)) return 'bolt';
  if (/\bgrab\b/.test(normalizedFull)) return 'grab';
  if (/\b(?:freenow|free now)\b/.test(normalizedFull)) return 'freenow';

  const firstCounterpartySegment = (raw.split('|')[0].split(',')[0] || raw).split('*')[0] || raw;
  const cleaned = firstCounterpartySegment
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.[^\s,|]+/gi, ' ')
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}\b/gi, ' ')
    .replace(/\b(?:ref|reference|invoice|inv|txn|tx|no)\s*[:#-]?\s*[a-z0-9-]{3,}\b/gi, ' ')
    .replace(/\b[A-Z]{2,}[-/]?\d{3,}[A-Z0-9-]*\b/g, ' ')
    .replace(/\b(?=[a-z0-9]*\d)[a-z0-9]{3,}\b/gi, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\b(?:eur|usd|sgd|gbp|aud|cad|jpy)\b\s*\d[\d,.]*/gi, ' ')
    .replace(/\b[*x]{2,}\d+\b/gi, ' ');
  const stopWords = new Set([
    'ach',
    'autopay',
    'card',
    'c',
    'chk',
    'com',
    'credit',
    'debit',
    'dep',
    'deposit',
    'epay',
    'epayment',
    'eur',
    'esp',
    'gbp',
    'mobile',
    'net',
    'online',
    'org',
    'pay',
    'payment',
    'pmt',
    'pmts',
    'pos',
    'purchase',
    'pymt',
    'recurring',
    'sgd',
    'singapore',
    'transfer',
    'usd',
    'wire',
    'withdrawal',
    'www',
    'xfer'
  ]);
  const seenTokens = new Set();
  const tokens = normalizeIntelText(cleaned)
    .split(' ')
    .filter((token) => {
      if (!token || token.length <= 1 || /\d/.test(token) || stopWords.has(token) || seenTokens.has(token)) return false;
      seenTokens.add(token);
      return true;
    });

  if (tokens.length > 0) return tokens.slice(0, 3).join(' ');
  const seenFallbackTokens = new Set();
  return normalizedFull
    .split(' ')
    .filter((token) => {
      if (!token || token.length <= 1 || /\d/.test(token) || stopWords.has(token) || seenFallbackTokens.has(token)) return false;
      seenFallbackTokens.add(token);
      return true;
    })
    .slice(0, 3)
    .join(' ');
};

// D2 (2026-07-07): a clean display contact for a KNOWN multi-payee cluster
// pattern (taxis, ride-hail), so a merchant rule minted from ONE member —
// "TAXI LICENCIA 0000" — exports a generic cluster contact ("Taxi") instead of
// stamping the whole cluster with that one member's specific payee. Scoped
// deliberately (Kari, 2026-07-07: "generic only for cluster patterns"): a
// pattern NOT in this map returns '' so a single-supplier rule keeps its
// specific legal name ("Example Oy" stays "Example Oy", never genericized). No
// location qualifier — deriving "— <city>" would need fragile description
// parsing (intelligence-substituting scaffolding we don't add).
const CLUSTER_CONTACT_LABELS = new Map([
  ['taxi', 'Taxi'],
  ['uber', 'Uber'],
  ['grab', 'Grab'],
  ['bolt', 'Bolt'],
  ['cabify', 'Cabify'],
  ['freenow', 'FreeNow']
]);
export const clusterContactLabel = (pattern = '') => {
  const key = String(pattern || '').trim().toLowerCase();
  return CLUSTER_CONTACT_LABELS.get(key) || CLUSTER_CONTACT_LABELS.get(canonicalMerchantPattern(pattern)) || '';
};

const slugify = (value = '') => normalizeIntelText(value).replace(/\s+/g, '-').slice(0, 80) || 'unknown';

const amountFor = (transaction = {}) => Number(transaction.money_in || transaction.money_out || transaction.amount || 0);

const LOW_MATERIALITY_AMOUNT = 25;

// ISO-4217 codes a multi-currency account is plausibly denominated in. A CLOSED
// reference set (a validator, not a heuristic): it lets us read a "Buy/Sell <CCY>"
// leg as a real currency conversion from the line's structure, without
// keyword-matching the bank's wording.
const ISO_CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD', 'CHF', 'JPY', 'CNY', 'HKD', 'NZD',
  'SEK', 'NOK', 'DKK', 'INR', 'AED', 'ZAR', 'MXN', 'BRL', 'PLN', 'THB', 'MYR',
  'IDR', 'PHP', 'KRW', 'TRY', 'ILS', 'SAR', 'CZK', 'HUF'
]);

// Structural FX-conversion detail — a FACT about the line's shape, not a keyword.
// A multi-currency "Buy/Sell <ISO currency> <amount>" leg whose currency is a
// real currency OTHER than the account's own is a conversion between the firm's
// own wallets (buy USD 1,000, pay EUR 930.00 out of the EUR account). The legacy
// gate required the literal word "conversion" in the line, so a bank that labels
// the same event just "Buy USD 1000.00" fell through to `unknown` → Suspense — a
// human bookkeeper sees the two currencies and calls it in two seconds. Reading
// the currency mismatch from the structure fixes that; the "conversion" keyword
// stays as an OR so a line that DOES carry it (or whose account currency is
// unknown) is never regressed. Same retirement class as the Failure-A name regex
// — see CLAUDE.md "intelligence-substituting scaffolding".
export const conversionDetailFor = (transaction = {}) => {
  const source = `${transaction.source_line || ''} ${transaction.description || ''} ${transaction.raw_description || ''}`;
  const leg = source.match(/\b(buy|sell)\s+([a-z]{3})\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const namedCurrency = leg?.[2]?.toUpperCase() || '';
  const accountCurrency = String(transaction.account_currency || transaction.currency || '').trim().toUpperCase();
  const crossesCurrency = ISO_CURRENCY_CODES.has(namedCurrency) && namedCurrency !== accountCurrency;
  if (!crossesCurrency && !/\bconversion\b/i.test(source)) return null;
  return {
    action: leg?.[1] ? leg[1].toLowerCase() : '',
    counterCurrency: namedCurrency,
    counterAmount: leg?.[3] ? Number(leg[3].replace(/,/g, '')) : null
  };
};

const isMultiCurrencyConversion = (transaction = {}) => Boolean(conversionDetailFor(transaction));

const conversionSupportNoteFor = (transaction = {}) => {
  const detail = conversionDetailFor(transaction);
  const accountCurrency = transaction.account_currency || transaction.currency || '';
  const amount = amountFor(transaction);
  const movement = Number(transaction.money_in || 0) > 0 ? 'received' : 'converted';
  const counter = detail?.counterCurrency && detail.counterAmount
    ? `${detail.action || 'conversion'} ${detail.counterCurrency} ${detail.counterAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : 'currency conversion';
  return `Wise/Airwallex multi-currency account conversion: ${movement} ${accountCurrency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} against ${counter}. Bank statement line is the support; treat as internal treasury movement unless separate FX fees are shown.`;
};

const directionFor = (transaction = {}) => {
  if (Number(transaction.money_in || 0) > 0) return 'money_in';
  if (Number(transaction.money_out || 0) > 0) return 'money_out';
  return amountFor(transaction) === 0 ? 'zero' : 'unknown';
};

export const daysBetween = (a, b) => {
  if (!a || !b) return Infinity;
  const aTime = toUtcDayMs(a);
  const bTime = toUtcDayMs(b);
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return Infinity;
  return Math.abs(aTime - bTime) / DAY_MS;
};

export const amountMatches = (a, b, tolerance = 0.01) => Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;

// Wider tolerance helper for tier 5 (amount_near_vendor). Returns true when
// |a-b| is within max(|larger|*absolutePct, absoluteUnits). Designed for
// FX-margin / tax-component variance on otherwise-clean card receipts.
export const amountWithinTolerance = (a, b, { absolutePct = 0.05, absoluteUnits = 10 } = {}) => {
  const numA = Number(a);
  const numB = Number(b);
  if (!Number.isFinite(numA) || !Number.isFinite(numB)) return false;
  const denom = Math.max(Math.abs(numA), Math.abs(numB));
  const bound = Math.max(denom * absolutePct, absoluteUnits);
  return Math.abs(numA - numB) <= bound;
};

export const textOverlaps = (left = '', right = '') => {
  const leftNorm = normalizeIntelText(left);
  const rightNorm = normalizeIntelText(right);
  if (!leftNorm || !rightNorm) return false;
  return leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm);
};

export const extractReferenceTokens = (value = '') => {
  const tokens = new Set();
  const raw = String(value || '');
  for (const match of raw.matchAll(/\b(?:inv|invoice|bill|ref|reference|payment|txn|tx|no\.?)\s*[:#-]?\s*([a-z0-9-]{4,})\b/gi)) {
    tokens.add(match[1].toLowerCase());
  }
  for (const match of raw.matchAll(/\b[A-Z]{2,}[-/]?[0-9]{3,}[A-Z0-9-]*\b/g)) {
    tokens.add(match[0].toLowerCase());
  }
  return tokens;
};

const inferCategory = (transaction = {}) => {
  const account = normalizeIntelText(transaction.proposed_account || transaction.account_code || '');
  const description = normalizeIntelText(transaction.description || transaction.raw_description || '');
  const moneyIn = Number(transaction.money_in || 0);

  if (isMultiCurrencyConversion(transaction) || /intercompany|transfer|conversion|exchange|wise charges/.test(`${account} ${description}`)) return 'intercompany';
  if (moneyIn > 0) {
    // No "founder" token here: who injects share capital is a judgement
    // for the strong coder from the client's principals/agreement, not a
    // word baked into the fallback. Generic equity terms stay.
    if (/share|capital|investment|investor/.test(description)) return 'investor_inflows';
    return 'income';
  }
  // No keyword guess for director drawings. A prior rule here
  // (a regex of one director's own names) hardcoded specific identities — tuned to one
  // book where that person is the director — so it stamped ANY payee sharing
  // those tokens (e.g. a family member with the same surname) as a director
  // drawing and asserted it as fact. Who is a director is a judgement for the
  // strong coder + real director facts (entityFacts / the firm's statutory
  // docs), never a name regex. Unexplained owner-like outflows fall through to
  // `unknown` (Suspense) for the coder to decide. Do not re-add a name/role
  // keyword here. See CLAUDE.md "intelligence-substituting scaffolding" (Failure A).
  if (/payroll|salary|cpf/.test(`${account} ${description}`)) return 'team_payroll';
  if (/contractor|professional|accounting|legal|consult/.test(account)) return 'contractors';
  if (/software|subscription|saas|aws|google|microsoft|openai|stripe/.test(`${account} ${description}`)) return 'saas_tools';
  // No hardcoded merchant NAMES in these category guesses. The demo book's
  // own merchants used to leak in here (a café and its street -> meals,
  // finnair -> travel) — specific identities doing load-bearing
  // classification, the same anti-pattern as the Failure-A name regex. A
  // named merchant is recognised by a client rule or the strong coder, never
  // a name baked in here. Generic category words stay. See CLAUDE.md
  // "intelligence-substituting scaffolding".
  if (/meal|entertainment|restaurant|cafe|coffee|bakery|bistro/.test(`${account} ${description}`)) return 'meals_entertainment';
  if (/travel|hotel|airline|transport|grab|flight|uber|ubr|taxi|cabify|bolt|freenow|free now/.test(`${account} ${description}`)) return 'travel';
  if (/loan/.test(account)) return 'loan_repayments';
  if (/tax|fee|bank fee|filing|iras|hmrc|irs|vero/.test(`${account} ${description}`)) return 'taxes_fees';
  if (/office|rent|telecom|insurance/.test(account)) return 'office_ops';
  return 'unknown';
};

const categoryForAccount = (account = '') => {
  const normalized = normalizeIntelText(account);
  const match = Object.entries(CATEGORY_ACCOUNTS).find(([, value]) => normalizeIntelText(value) === normalized);
  return match?.[0] || '';
};

const descriptionForRule = (transaction = {}) =>
  normalizeIntelText(`${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''}`);

export const clientRuleMatchFor = (transaction = {}, clientRules = []) => {
  const txText = descriptionForRule(transaction);
  const txMerchantPattern = canonicalMerchantPattern(`${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''} ${transaction.source_line || ''}`);
  if (!txText) return null;

  let best = null;
  for (const rule of clientRules) {
    // DMEM-R1 W1 (INV-02, S09/L2): a deterministic consumer applies only a
    // CURRENT rule. A `proposed` (model-minted, ungoverned) or `retired` row is
    // never authority, whatever the caller handed in; a rule with no status
    // (the FE's local rule list) keeps matching as before.
    if (!rule || (rule.status != null && rule.status !== 'active')) continue;
    if (!['merchant_category', 'merchant_account', 'pattern'].includes(String(rule.rule_type || ''))) continue;
    const pattern = canonicalMerchantPattern(rule.pattern_text || rule.payload?.merchant_pattern || rule.payload?.merchant_name || '');
    if (pattern.length < 3) continue;
    if (txMerchantPattern !== pattern && !txText.includes(pattern)) continue;
    if (!best || pattern.length > best.pattern.length) {
      best = { rule, pattern };
    }
  }

  if (!best) return null;
  const accountCode = best.rule.account_code || best.rule.payload?.account_code || best.rule.payload?.proposed_account || '';
  const category = best.rule.category_override || categoryForAccount(accountCode) || 'unknown';
  return {
    id: best.rule.id,
    label: best.rule.payload?.label || best.rule.pattern_text || best.pattern,
    category,
    account_code: accountCode || CATEGORY_ACCOUNTS[category] || CATEGORY_ACCOUNTS.unknown,
    confidence: Number(best.rule.payload?.confidence || 0.9),
    support_note: best.rule.payload?.support_note || best.rule.notes || '',
    tax_treatment: best.rule.payload?.tax_treatment || '',
    // D2: a known cluster pattern always resolves to its generic label, so even a
    // legacy rule that persisted a first-member payee ("TAXI LICENCIA 0000")
    // reads back as "Taxi" without a backfill; non-cluster rules keep their name.
    contact: clusterContactLabel(best.pattern) || best.rule.payload?.contact || best.rule.payload?.merchant_name || '',
    auto_explain_limit: Number(best.rule.payload?.auto_explain_limit || LOW_MATERIALITY_AMOUNT)
  };
};

const lowMaterialityRuleCovers = (transaction = {}, ruleMatch = null) =>
  Boolean(ruleMatch) && directionFor(transaction) === 'money_out' && amountFor(transaction) <= Number(ruleMatch.auto_explain_limit || LOW_MATERIALITY_AMOUNT);

const contextualSupportFor = (transaction = {}, category = '') => {
  if (category !== 'travel' || directionFor(transaction) !== 'money_out') return null;
  const merchantPattern = canonicalMerchantPattern(`${transaction.description || ''} ${transaction.raw_description || ''} ${transaction.contact || ''} ${transaction.source_line || ''}`);
  const transportLimit = PASSENGER_TRANSPORT_MERCHANTS.has(merchantPattern) ? 50 : 0;
  if (!transportLimit || amountFor(transaction) > transportLimit) return null;
  return {
    label: merchantPattern === 'taxi' ? 'Taxi / passenger transport' : `${merchantPattern[0].toUpperCase()}${merchantPattern.slice(1)} passenger transport`,
    support_note: 'Low-value passenger transport during business travel. Bank statement line is sufficient unless the trip purpose is unclear.',
    confidence: 0.78
  };
};

const documentAmount = (document = {}) =>
  document.total_amount ??
  document.totalAmount ??
  document.statement_summary?.ending_balance ??
  document.amount ??
  null;

const documentDate = (document = {}) =>
  document.document_date ||
  document.documentDate ||
  document.due_date ||
  document.date ||
  (document.uploaded_at ? toLocalIsoDay(document.uploaded_at) : ''); // host-local day (audit F-11)

const documentCounterparty = (document = {}) =>
  document.vendor_name ||
  document.customer_name ||
  document.vendorName ||
  document.customerName ||
  document.counterparty ||
  document.issuer ||
  '';

const documentReference = (document = {}) =>
  document.reference_number ||
  document.referenceNumber ||
  document.invoice_number ||
  document.bill_number ||
  document.payment_reference ||
  '';

const isAccountingDocument = (document = {}) =>
  !['bank_statement', 'bank-statement'].includes(String(document.document_type || document.doc_type || '').toLowerCase());

const shortHash = (value = '') => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

const makeStableId = (prefix, ...parts) => {
  const raw = parts.map((part) => String(part || '')).join('|');
  return `${prefix}-${parts.map(slugify).join('-')}`.slice(0, 118) + `-${shortHash(raw)}`;
};

const makeMatchId = (...parts) => makeStableId('recon', ...parts);
const makeReviewId = (...parts) => makeStableId('tx-review', ...parts);

const bestDocumentMatchFor = (transaction, documents = []) => {
  const txAmount = amountFor(transaction);
  const txDate = transaction.date || transaction.transaction_date || '';
  const txText = `${transaction.description || ''} ${transaction.raw_description || ''}`;
  const txReferences = extractReferenceTokens(txText);
  let best = null;

  documents.filter(isAccountingDocument).forEach((document) => {
    const docAmount = Number(documentAmount(document));
    const docDate = documentDate(document);
    const docCounterparty = documentCounterparty(document);
    const docReference = documentReference(document);
    const docReferences = extractReferenceTokens(`${docReference} ${document.filename || ''}`);
    const dateGap = daysBetween(txDate, docDate);
    const amountOk = Number.isFinite(docAmount) && amountMatches(txAmount, docAmount);
    const vendorOk = textOverlaps(txText, docCounterparty);
    const referenceOk = [...txReferences].some((token) => docReferences.has(token));

    let confidence = 0;
    let reason = '';
    if (referenceOk && amountOk && dateGap <= 14) {
      confidence = 0.98;
      reason = 'Exact reference, amount, and date-window match.';
    } else if (amountOk && vendorOk && dateGap <= 7) {
      confidence = 0.92;
      reason = 'Exact amount, same counterparty, and close date.';
    } else if (amountOk && dateGap === 0) {
      confidence = 0.82;
      reason = 'Receipt/document amount matches same-day bank movement.';
    } else if (vendorOk && dateGap <= 14) {
      confidence = 0.68;
      reason = 'Counterparty matches, but amount may differ because of fees, tax, FX, or partial payment.';
    }

    if (confidence > (best?.confidence || 0)) {
      best = { document, confidence, reason, amount: Number.isFinite(docAmount) ? docAmount : txAmount };
    }
  });

  return best;
};

const transferMatchesFor = (transaction, transactions = []) => {
  const txAmount = amountFor(transaction);
  const txDate = transaction.date || transaction.transaction_date || '';
  const txDirection = directionFor(transaction);
  if (!txAmount || txDirection === 'zero' || txDirection === 'unknown') return null;

  const oppositeDirection = txDirection === 'money_in' ? 'money_out' : 'money_in';
  const description = normalizeIntelText(transaction.description || transaction.raw_description || '');
  const looksLikeTransfer = /transfer|conversion|exchange|internal|between accounts|wise charges/.test(description);

  const candidate = transactions.find((other) => {
    if (!other?.id || other.id === transaction.id) return false;
    if (directionFor(other) !== oppositeDirection) return false;
    if (!amountMatches(txAmount, amountFor(other), Math.max(0.01, txAmount * 0.01))) return false;
    if (daysBetween(txDate, other.date || other.transaction_date || '') > 3) return false;
    const otherDescription = normalizeIntelText(other.description || other.raw_description || '');
    return looksLikeTransfer || /transfer|conversion|exchange|internal|between accounts|wise charges/.test(otherDescription);
  });

  return candidate
    ? {
        transaction: candidate,
        confidence: looksLikeTransfer ? 0.94 : 0.84,
        reason: 'Opposite bank movement with matching amount and close date; likely internal transfer.'
      }
    : null;
};

// Provenance marker stamped into enrichment-only patches (step-aside mode),
// so "who set this category while a governed lane owned settling" stays
// answerable from the transaction payload itself.
export const INTEL_ENRICHMENT_ONLY_PROVENANCE = 'transaction_intel:enrichment_only';

// stepAside (2026-08-17, Kari's dated go: "go intel step-aside"): when a
// governed model lane is seated for this (firm, client) — the CALLER reads
// model_lane_policy and passes the verdict in; this module stays db-free —
// intel keeps job 1 (enrichment) but stops jobs 2 and 3: no
// reconciliation_status / support_status settling, no reconciliation_matches
// rows (transfer pairs included), no review items derived from its own
// settling. The full legacy analysis still runs internally so the suppressed
// work is COUNTED for the caller's receipt — an invisible behavior change on
// the reconcile path is the anti-pattern this slice exists to kill. With
// stepAside false the output is byte-identical to the legacy analyzer.
export const analyzeTransactionIntel = ({ firmId = 'donna-demo-firm', documents = [], transactions = [], clientRules = [], configSnapshot = null, stepAside = false } = {}) => {
  const transactionPatches = [];
  const matches = [];
  const reviewItems = [];
  let settlesSuppressed = 0;
  let matchRowsSuppressed = 0;
  let reviewItemsSuppressed = 0;

  transactions.forEach((transaction) => {
    if (!transaction?.id || !transaction?.client_id) return;
    const alreadyHandled =
      transaction.status === 'approved' ||
      transaction.support_status === 'explained' ||
      transaction.support_status === 'rule_explained' ||
      ['explained', 'reconciled'].includes(transaction.reconciliation_status);

    const ruleMatch = clientRuleMatchFor(transaction, clientRules);
    const conversionDetail = conversionDetailFor(transaction);
    const conversionCoversSupport = Boolean(conversionDetail);
    const category = ruleMatch?.category || inferCategory(transaction);
    const contextualSupport = contextualSupportFor(transaction, category);
    const transfer = transferMatchesFor(transaction, transactions);
    const documentMatch = transfer ? null : bestDocumentMatchFor(transaction, documents);
    const bestMatch = transfer
      ? {
          type: 'transfer',
          id: transfer.transaction.id,
          amount: amountFor(transaction),
          confidence: transfer.confidence,
          reason: transfer.reason
        }
      : documentMatch
        ? {
            type: documentMatch.document.document_type || 'document',
            id: documentMatch.document.id,
            amount: documentMatch.amount,
            confidence: documentMatch.confidence,
            reason: documentMatch.reason
          }
        : null;

    const ruleCoversSupport = conversionCoversSupport || lowMaterialityRuleCovers(transaction, ruleMatch) || Boolean(contextualSupport);
    // Document evidence outranks a bank-line-only explanation: a strong
    // document match must not be silently swallowed by a low-materiality
    // rule / contextual heuristic (the Exxon 25-07-29 class — see
    // CLAUDE.md). Transfers keep their existing precedence.
    const docMatchOutranksRule = !transfer && Boolean(documentMatch) && documentMatch.confidence >= 0.92;
    const ruleExplains = ruleCoversSupport && !docMatchOutranksRule;
    const reconciliationStatus = alreadyHandled
      ? transaction.support_status === 'explained'
        ? 'explained'
        : transaction.reconciliation_status === 'reconciled'
          ? 'reconciled'
          : transaction.status === 'approved'
            ? 'approved'
            : transaction.reconciliation_status
      : ruleExplains
        ? 'explained'
      : bestMatch?.confidence >= 0.92
        ? 'auto_reconciled'
        : bestMatch
          ? 'needs_review'
          : 'needs_review';
    const confidenceScore = bestMatch?.confidence || ruleMatch?.confidence || contextualSupport?.confidence || (category === 'unknown' ? 0.3 : 0.62);
    const cleanedDescription = normalizeIntelText(transaction.description || transaction.raw_description || '');

    const patch = {
      id: transaction.id,
      firm_id: firmId,
      client_id: transaction.client_id,
      raw_description: transaction.raw_description || transaction.description || '',
      cleaned_description: cleanedDescription,
      direction: directionFor(transaction),
      category,
      account_code: conversionCoversSupport
        ? CATEGORY_ACCOUNTS.intercompany
        : ruleMatch?.account_code ||
          (['', 'suspense'].includes(normalizeIntelText(transaction.account_code || transaction.proposed_account || ''))
            ? CATEGORY_ACCOUNTS[category] || CATEGORY_ACCOUNTS.unknown
            : transaction.account_code || transaction.proposed_account) ||
          CATEGORY_ACCOUNTS[category] ||
          CATEGORY_ACCOUNTS.unknown,
      confidence_score: confidenceScore,
      reconciliation_status: reconciliationStatus,
      // Already-handled lines keep their existing support stamp — a
      // re-run must not re-stamp 'rule_explained' over a line whose
      // explanation a document match has since superseded.
      support_status: !alreadyHandled && ruleExplains ? 'rule_explained' : transaction.support_status || '',
      support_note: !alreadyHandled && conversionCoversSupport
        ? conversionSupportNoteFor(transaction)
        : !alreadyHandled && ruleExplains
          ? ruleMatch?.support_note || contextualSupport?.support_note || `Matched client rule: ${ruleMatch.label}.`
          : transaction.support_note || '',
      matched_client_rule_id: ruleMatch?.id || '',
      matched_client_rule_label: ruleMatch?.label || '',
      tax_treatment: conversionCoversSupport ? 'Out of scope' : ruleMatch?.tax_treatment || transaction.tax_treatment || '',
      contact: conversionCoversSupport ? 'Wise / Airwallex' : ruleMatch?.contact || transaction.contact || '',
      conversion_detail: conversionDetail || null
    };

    if (stepAside) {
      // A settle is a status this run would have STAMPED — pass-throughs on
      // already-handled lines don't count (their guard behavior is unchanged
      // either way, since the enrichment-only write never touches status).
      if (!alreadyHandled && ['explained', 'auto_reconciled'].includes(reconciliationStatus)) settlesSuppressed += 1;
      transactionPatches.push({
        ...patch,
        reconciliation_status: null,
        support_status: '',
        support_note: '',
        intel_provenance: INTEL_ENRICHMENT_ONLY_PROVENANCE
      });
    } else {
      transactionPatches.push(patch);
    }

    if (bestMatch && stepAside) {
      matchRowsSuppressed += 1;
    } else if (bestMatch) {
      matches.push({
        id: makeMatchId(transaction.client_id, transaction.id, bestMatch.type, bestMatch.id),
        firm_id: firmId,
        client_id: transaction.client_id,
        bank_transaction_id: transaction.id,
        matched_object_type: bestMatch.type,
        matched_object_id: bestMatch.id,
        match_amount: bestMatch.amount,
        match_confidence: bestMatch.confidence,
        match_reason: bestMatch.reason,
        // Client-scoped auto-match canary (RECONCILIATION_AUTO_MATCH_CLIENTS):
        // the legacy transaction_intel matcher promotes to auto_matched on raw
        // confidence (>=0.92) and never went through authorizeMatch, so it must
        // honor the same allowlist as every other matcher. No-op without an
        // allowlist; otherwise a non-allowlisted client is held to 'suggested'.
        status: (bestMatch.confidence >= 0.92 && clientAllowedToAutoMatch(transaction.client_id, { configSnapshot })) ? 'auto_matched' : 'suggested',
        created_by: 'system',
        payload: {
          source: 'transaction_intel',
          category,
          matched_client_rule_id: ruleMatch?.id || '',
          transaction_description: transaction.description || '',
          confidence_label: bestMatch.confidence >= 0.92 ? 'high' : 'medium'
        }
      });
    }

    if (!alreadyHandled && !ruleExplains && (!bestMatch || bestMatch.confidence < 0.92) && stepAside) {
      reviewItemsSuppressed += 1;
    } else if (!alreadyHandled && !ruleExplains && (!bestMatch || bestMatch.confidence < 0.92)) {
      const reason = bestMatch
        ? 'Suggested reconciliation needs reviewer confirmation.'
        : category === 'unknown'
          ? 'Unmatched and uncategorized bank transaction.'
          : 'No supporting document or transfer match found.';
      reviewItems.push({
        id: makeReviewId(transaction.client_id, transaction.id, reason),
        firm_id: firmId,
        client_id: transaction.client_id,
        item_type: bestMatch ? 'reconciliation_match' : 'transaction',
        item_id: bestMatch?.id || transaction.id,
        reason,
        priority: category === 'unknown' || !bestMatch ? 'high' : 'normal',
        status: 'open',
        payload: {
          source: 'transaction_intel',
          transaction_id: transaction.id,
          amount: amountFor(transaction),
          direction: directionFor(transaction),
          category,
          confidence_score: confidenceScore
        }
      });
    }
  });

  if (!stepAside) return { transactionPatches, matches, reviewItems };
  return {
    transactionPatches,
    matches,
    reviewItems,
    stepAside: {
      lines_enriched: transactionPatches.length,
      settles_suppressed: settlesSuppressed,
      match_rows_suppressed: matchRowsSuppressed,
      review_items_suppressed: reviewItemsSuppressed
    }
  };
};
