// SG — PayNow / GIRO / FAST bank-statement rail recognition. Pure functions
// over statement-line descriptors, the SG analogue of the format-specific
// parsing the handoff names ("the bank-statement parser is format-specific; SG
// formats differ"). SG bank statements (DBS/POSB, OCBC, UOB) carry rail-
// specific descriptor shapes — PayNow transfers with UEN/mobile proxies, GIRO
// deductions with billing-organisation prefixes, FAST/MEPS credits — and
// recognising the rail is CONTEXT for the strong classifier, never a
// classification by itself (trust-the-strong-LLM: this module extracts
// structure; the model decides what the line IS).
//
// Consumed as optional enrichment by the bank-line classifier's context
// assembly — additive, no existing parser is modified.

const clean = (value) => String(value || '').trim();

export const SG_PAYMENT_RAILS = Object.freeze(['paynow', 'giro', 'fast', 'mepsplus', 'nets', 'card']);

// Descriptor markers per rail, matched case-insensitively against the
// statement line text. Ordered specific → generic (PayNow lines often also say
// FAST — PayNow wins; the transfer rode PayNow addressing over FAST clearing).
const RAIL_MARKERS = [
  { rail: 'paynow', re: /\bpaynow\b|\bpay\s*now\b/i },
  { rail: 'giro', re: /\bgiro\b|\bstanding\s+instruction\b/i },
  { rail: 'fast', re: /\bfast\b(?:\s+(?:payment|transfer|credit|debit))?/i },
  { rail: 'mepsplus', re: /\bmeps\+?\b/i },
  { rail: 'nets', re: /\bnets\b/i },
  { rail: 'card', re: /\bvisa\b|\bmastercard\b|\bdebit\s+card\b|\bcredit\s+card\b/i }
];

// PayNow proxy shapes: a UEN (with optional 3-char suffix for sub-accounts),
// or a Singapore mobile (+65 8/9xxx xxxx). Structural only — the proxy is a
// counterparty HINT, never an identity verdict.
const UEN_PROXY_RE = /\b(?:\d{8}|\d{9}|(?:19|20)\d{2}\d{5}|[TSR]\d{2}[A-Z]{2}\d{4})[A-Z](?:[A-Z0-9]{3})?\b/;
const MOBILE_PROXY_RE = /(?:\+?65[\s-]?)?[89]\d{3}[\s-]?\d{4}\b/;

// classifySgStatementRail(description) → { rail, proxy, proxyKind } | null.
// Null when no SG rail marker is present (the line is not rail-classifiable —
// the caller falls through to its normal path). `proxy` is the PayNow
// addressing hint when one is visible in the text.
export const classifySgStatementRail = (description = '') => {
  const text = clean(description);
  if (!text) return null;
  const hit = RAIL_MARKERS.find(({ re }) => re.test(text));
  if (!hit) return null;
  let proxy = null;
  let proxyKind = null;
  if (hit.rail === 'paynow') {
    const uen = text.toUpperCase().match(UEN_PROXY_RE);
    const mobile = text.match(MOBILE_PROXY_RE);
    if (uen) { proxy = uen[0]; proxyKind = 'uen'; }
    else if (mobile) { proxy = mobile[0].replace(/[+\s-]/g, ''); proxyKind = 'mobile'; }
  }
  return { rail: hit.rail, proxy, proxyKind };
};

// A GIRO deduction descriptor usually names the billing organisation after the
// rail marker ("GIRO PAYMENT - SP SERVICES", "GIRO-IRAS"). Extract the trailing
// organisation text as a counterparty hint. Pure string surgery; empty → null.
export const giroCounterpartyHint = (description = '') => {
  const text = clean(description);
  const match = text.match(/giro(?:\s+(?:payment|deduction|collection))?\s*[-–:]?\s*(.{3,80})$/i);
  if (!match) return null;
  const hint = clean(match[1]).replace(/\s{2,}/g, ' ');
  return hint || null;
};

// buildSgRailContext(line) — the enrichment envelope the classifier context
// assembly spreads in: { sg_rail, sg_rail_proxy, sg_rail_proxy_kind,
// sg_rail_counterparty_hint } or {} when nothing recognised. Reads the common
// statement-line text fields defensively.
export const buildSgRailContext = (line = {}) => {
  const fields = [...new Set([line.description, line.reference, line.narrative, line.details,
    line.structured_reference, line.raw_description, line.source_line]
    .filter((value) => typeof value === 'string')
    .map(clean)
    .filter(Boolean))];
  const text = fields.join(' · ');
  const rail = classifySgStatementRail(text);
  if (!rail) return {};
  const context = { sg_rail: rail.rail };
  if (rail.proxy) {
    context.sg_rail_proxy = rail.proxy;
    context.sg_rail_proxy_kind = rail.proxyKind;
  }
  if (rail.rail === 'giro') {
    // Keep a billing hint attached to its own descriptor, not a concatenation
    // of unrelated reference fields or a duplicate raw source line.
    const hint = fields.map(giroCounterpartyHint).find(Boolean);
    if (hint) context.sg_rail_counterparty_hint = hint;
  }
  return context;
};
