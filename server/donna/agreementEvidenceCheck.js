// Agreement evidence check — a READ-ONLY, deterministic reconciliation-EVIDENCE
// report for any agreement (contract, lease, loan, service deal, APA…). NOT a
// matcher, NOT a reconciler.
//
// Division of labour (CLAUDE.md trust-the-strong-LLM principle):
//
//   • The strong LLM reads the agreement and extracts the structured
//     commercial obligations (contract.js OBLIGATION_SCHEMA: payer/payee,
//     amount, currency, frequency, dates). That extraction is the
//     INTELLIGENCE and is never re-implemented here.
//   • THIS module does only ARITHMETIC: it compares the already-extracted
//     numeric obligations against a set of transactions and reports where the
//     numbers, dates, parties and agreement references line up, where an
//     expected payment is missing, and what extra deposits are unexplained.
//
// It is the same kind of correctness scaffolding as totals math
// (subtotal+tax==total): a deterministic check over values the model already
// produced — never a substitute for the model's judgement. It therefore:
//
//   • NEVER reconciles or posts anything, and creates no rows. It returns a
//     CheckReport object for the operator to read.
//   • NEVER emits the load-bearing match verdict. Deciding that bank line X
//     reconciles obligation Y (across FX, processors, partial settlement) is
//     the strong-LLM reconciliation matcher's job (reconciliationLlmCore). This
//     report is EVIDENCE that feeds the operator / that call's context, not a
//     replacement for it.
//   • Uses plain boolean checks (amount within tolerance · counterparty name ·
//     date window · agreement reference present), NOT a weighted score — there
//     is no "amount×0.45 + date×0.30 + party×0.25" verdict here (Failure B).
//
// Direction-agnostic: an APA's revenue_commitment / deposit obligations check
// against incoming deposits; a lease's rent or a loan's repayments check
// against OUTGOING payments — same shape, opposite sign. Amounts compare on
// absolute value and the candidate counterparty is the EXTERNAL party (the
// firm's / client's own names are excluded), so both directions work and a
// bank line carrying our own name is never mistaken for the counterparty.

const MAX_OBLIGATIONS = 25;
const MAX_TRANSACTIONS = 500;
const MAX_EXTRAS = 25;

// Tolerances are deterministic and overridable. Amount: 1 cent OR 1% of the
// larger side (FX rounding, fee skim). Date: a calendar month either side, so a
// payment that lands a few weeks off a scheduled date still counts as on-time.
const DEFAULT_AMOUNT_ABS = 0.01;
const DEFAULT_AMOUNT_PCT = 0.01;
const DEFAULT_DATE_WINDOW_DAYS = 31;

const num = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const absAmount = (value) => {
  const n = num(value);
  return n == null ? null : Math.abs(n);
};

const toTime = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

// Lower-cased, punctuation-stripped, common company-suffix-trimmed name so
// "Example Holdings Oy" and "EXAMPLE HOLDINGS" compare equal. Deterministic.
const COMPANY_SUFFIXES = /\b(oy|oyj|ab|ltd|limited|llc|inc|gmbh|plc|pte|bv|as|sa|srl|kg|co|corp|company|holdings?)\b/g;
const normalizeName = (value) =>
  String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// One party name appears in the other (after normalisation), both non-empty.
const nameMatches = (a, b) => {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
};

const ONE_DAY = 24 * 60 * 60 * 1000;

// Normalize an LLM-extracted obligation to the fields the check needs. Only the
// numeric/temporal/party facts — the comparison never reads prose.
const normalizeObligation = (obligation = {}, index) => ({
  index,
  obligation_type: obligation.obligation_type || null,
  payer: obligation.payer || null,
  payee: obligation.payee || null,
  amount: absAmount(obligation.amount),
  currency: obligation.currency || null,
  // The date a one-off is due; recurring obligations anchor on their start.
  dueTime: toTime(obligation.start_date) ?? toTime(obligation.end_date),
  dueDate: obligation.start_date || obligation.end_date || null
});

// Normalize a transaction defensively across the shapes the feed/snapshot use.
const normalizeTransaction = (tx = {}) => ({
  id: tx.id || tx.transaction_id || null,
  amount: absAmount(tx.amount ?? tx.transaction_amount),
  time: toTime(tx.date || tx.transaction_date || tx.value_date),
  date: tx.date || tx.transaction_date || tx.value_date || null,
  party: tx.counterparty || tx.contact_name || tx.merchant || tx.description || '',
  desc: tx.description || '',
  text: `${tx.description || ''} ${tx.reference || ''} ${tx.counterparty || tx.contact_name || ''}`.trim()
});

const makeAmountMatcher = (options) => {
  const abs = num(options.amountToleranceAbs) ?? DEFAULT_AMOUNT_ABS;
  const pct = num(options.amountTolerancePct) ?? DEFAULT_AMOUNT_PCT;
  return (a, b) => {
    if (a == null || b == null) return false;
    return Math.abs(a - b) <= Math.max(abs, pct * Math.max(Math.abs(a), Math.abs(b)));
  };
};

// Contract-level reference tokens (reference_number + references[]) the LLM
// pulled from the header — e.g. "INV047". A transaction whose text contains one
// is tied to THIS contract, which is what lifts an amount coincidence to a real
// match and disambiguates equal-amount candidates.
const referenceTokens = (contract = {}) => {
  const raw = [];
  if (contract.reference_number) raw.push(contract.reference_number);
  for (const r of Array.isArray(contract.references) ? contract.references : []) {
    if (typeof r === 'string') raw.push(r);
    else if (r && typeof r === 'object' && r.value) raw.push(r.value);
  }
  return raw
    .map((token) => normalizeName(token))
    .filter((token) => token.length >= 3);
};

const transactionHasReference = (tx, tokens) => {
  if (!tokens.length) return false;
  const text = normalizeName(tx.text);
  return tokens.some((token) => text.includes(token));
};

// The names a transaction's counterparty may match for THIS obligation: the
// EXTERNAL side of the agreement, never the firm's / client's own name. The
// header counterparty_name is external by construction; each obligation's
// payer/payee are added unless they're an explicit own/client name (ownNames).
// So a rent obligation (payer = us, payee = landlord) matches the landlord, and
// a bank line carrying our own name is never taken as the counterparty.
const externalCounterparties = (obligation, contract, ownNames) => {
  const seen = new Set();
  const out = [];
  for (const name of [contract.counterparty_name, obligation.payer, obligation.payee]) {
    if (!name) continue;
    if (ownNames.some((own) => nameMatches(name, own))) continue;
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
};

// Build the read-only evidence report. Pure: no I/O, no clock — `now` and all
// tolerances are injectable so the report is fully deterministic and testable.
export const buildAgreementEvidenceCheck = ({ contract = {}, transactions = [], options = {} } = {}) => {
  const rawObligations = Array.isArray(contract.obligations) ? contract.obligations : [];
  const obligations = rawObligations
    .slice(0, MAX_OBLIGATIONS)
    .map(normalizeObligation)
    .filter((o) => o.amount != null && o.amount > 0); // only numeric obligations are checkable

  const txns = (Array.isArray(transactions) ? transactions : [])
    .slice(0, MAX_TRANSACTIONS)
    .map(normalizeTransaction)
    .filter((t) => t.amount != null && t.amount > 0);

  const amountsMatch = makeAmountMatcher(options);
  const dateWindowMs = (num(options.dateWindowDays) ?? DEFAULT_DATE_WINDOW_DAYS) * ONE_DAY;
  const tokens = referenceTokens(contract);
  // Explicit own/client names to exclude from candidate counterparties, so the
  // firm's own side of an obligation is never matched as the external party.
  const ownNames = [
    ...(Array.isArray(options.ownNames) ? options.ownNames : []),
    ...(Array.isArray(options.clientNames) ? options.clientNames : [])
  ].filter(Boolean);

  const claimed = new Set(); // transaction indices already attributed to an obligation
  const results = [];

  for (const o of obligations) {
    const counterparties = externalCounterparties(o, contract, ownNames);
    // Candidates: unclaimed transactions whose amount matches within tolerance.
    const candidates = [];
    txns.forEach((t, i) => {
      if (claimed.has(i)) return;
      if (!amountsMatch(o.amount, t.amount)) return;
      const partyMatch = counterparties.some((name) => nameMatches(t.party, name));
      const referenceMatch = transactionHasReference(t, tokens);
      const dateDist = o.dueTime != null && t.time != null ? Math.abs(o.dueTime - t.time) : Infinity;
      candidates.push({ i, t, partyMatch, referenceMatch, dateDist, dateClose: dateDist <= dateWindowMs });
    });

    if (candidates.length === 0) {
      results.push(missingResult(o));
      continue;
    }

    // Order deterministically: identity first (reference, then party), then the
    // nearest date, then transaction order. Identity + date disambiguate equal
    // installment amounts — that is NOT ambiguity, it is the schedule resolving.
    candidates.sort(compareCandidates);
    const best = candidates[0];
    const runnerUp = candidates[1] || null;
    const hasIdentity = candidateRank(best) > 0;
    const tiedAtTop = runnerUp != null && sameQuality(best, runnerUp);

    let status;
    let note = null;
    if (hasIdentity && !tiedAtTop) {
      status = 'matched';
    } else if (hasIdentity && tiedAtTop) {
      status = 'ambiguous';
      note = `Amount and identity fit ${candidates.filter((c) => sameQuality(best, c)).length} transactions equally — confirm which settles this.`;
    } else if (candidates.length === 1) {
      status = 'matched'; // amount (± date) only — a lone candidate, identity-blind
      note = best.dateClose
        ? 'Matched on amount and date only — no party or reference confirmation.'
        : 'Matched on amount only — no party, reference, or date confirmation.';
    } else if (best.dateClose && candidates.filter((c) => c.dateClose).length === 1) {
      status = 'matched'; // one in-window candidate; the rest are far off the date
      note = 'Matched on amount and date only — no party or reference confirmation.';
    } else {
      status = 'ambiguous'; // several equal-amount deposits, nothing to tell them apart
      note = `${candidates.length} transactions share this amount with nothing to tell them apart — confirm which (if any) settles this.`;
    }

    claimed.add(best.i);
    results.push({
      obligationIndex: o.index,
      status,
      amount: o.amount,
      currency: o.currency,
      dueDate: o.dueDate,
      transactionId: best.t.id,
      variance: Number((best.t.amount - o.amount).toFixed(2)),
      checks: { amount: true, party: best.partyMatch, reference: best.referenceMatch, date: best.dateClose },
      note
    });
  }

  // Extras: incoming transactions not attributed to any obligation. Surfaced
  // (not judged) so the operator sees deposits the agreement does not explain —
  // e.g. a "HR Consultation" / "DTT" deposit alongside scheduled installments.
  const extras = [];
  txns.forEach((t, i) => {
    if (claimed.has(i)) return;
    extras.push({
      transactionId: t.id,
      amount: t.amount,
      date: t.date,
      counterparty: truncate(t.party, 80),
      description: truncate(t.desc || t.party, 80),
      note: 'Incoming deposit not tied to any extracted obligation.'
    });
  });

  const totals = buildTotals(obligations, results, txns, claimed);
  const matchedTotalFallback = !results.some((r) => r.status === 'matched')
    && obligations.length > 0
    && amountsMatch(totals.expected, totals.observedAll);

  return {
    // A CHECK verdict, never a reconciliation verdict.
    status: deriveOverallStatus(results, obligations, matchedTotalFallback),
    confidence: deriveConfidence(results, obligations, matchedTotalFallback),
    summary: buildSummary(results, obligations, extras, matchedTotalFallback),
    obligations: results,
    extras: extras.slice(0, MAX_EXTRAS),
    totals,
    // Honest about its own boundary: this is evidence, not a posting.
    posted: false,
    reconciled: false
  };
};

// Identity weight: a contract reference outranks a party-name match; amount
// alone is rank 0. Deliberately a discrete ordering, not a tunable score.
const candidateRank = (c) => (c.referenceMatch ? 2 : 0) + (c.partyMatch ? 1 : 0);

// Deterministic ordering: identity, then nearest date, then transaction order.
const compareCandidates = (a, b) =>
  candidateRank(b) - candidateRank(a)
  || (b.dateClose ? 1 : 0) - (a.dateClose ? 1 : 0)
  || a.dateDist - b.dateDist
  || a.i - b.i;

// Two candidates the check genuinely cannot separate: same identity weight,
// same in/out-of-window date, same date distance. Only THIS is "ambiguous".
const sameQuality = (a, b) =>
  candidateRank(a) === candidateRank(b) && a.dateClose === b.dateClose && a.dateDist === b.dateDist;

const missingResult = (o) => ({
  obligationIndex: o.index,
  status: 'missing',
  amount: o.amount,
  currency: o.currency,
  dueDate: o.dueDate,
  transactionId: null,
  variance: null,
  checks: { amount: false, party: false, reference: false, date: false },
  note: 'No transaction matches this expected amount.'
});

const truncate = (value, max) => {
  const str = String(value == null ? '' : value).trim();
  return str.length > max ? `${str.slice(0, max)}…` : str;
};

const buildTotals = (obligations, results, txns, claimed) => {
  const expected = obligations.reduce((sum, o) => sum + (o.amount || 0), 0);
  const observed = results
    .filter((r) => r.transactionId != null && r.status !== 'missing')
    .reduce((sum, r) => sum + ((r.amount || 0) + (r.variance || 0)), 0);
  const observedAll = txns.reduce((sum, t) => sum + (t.amount || 0), 0);
  return {
    expected: Number(expected.toFixed(2)),
    observed: Number(observed.toFixed(2)),
    observedAll: Number(observedAll.toFixed(2)),
    variance: Number((observed - expected).toFixed(2))
  };
};

const deriveOverallStatus = (results, obligations, matchedTotalFallback) => {
  if (obligations.length === 0) return 'no_obligations';
  if (matchedTotalFallback) return 'matched_on_total';
  const missing = results.filter((r) => r.status === 'missing').length;
  const ambiguous = results.filter((r) => r.status === 'ambiguous').length;
  const matched = results.filter((r) => r.status === 'matched').length;
  if (matched === results.length) return 'matched';
  if (matched === 0 && ambiguous === 0) return 'unmatched';
  return 'partial';
};

const deriveConfidence = (results, obligations, matchedTotalFallback) => {
  if (obligations.length === 0) return 'low';
  if (matchedTotalFallback) return 'low'; // totals agree but no per-row identity
  const confirmed = results.filter((r) => r.status === 'matched' && (r.checks.reference || r.checks.party)).length;
  const missing = results.filter((r) => r.status === 'missing').length;
  const ambiguous = results.filter((r) => r.status === 'ambiguous').length;
  if (confirmed === results.length) return 'high';
  if (missing === 0 && ambiguous === 0) return 'medium'; // all matched, but amount/date only
  return 'low';
};

const buildSummary = (results, obligations, extras, matchedTotalFallback) => {
  if (obligations.length === 0) return 'No numeric obligations extracted to check.';
  if (matchedTotalFallback) {
    return `Totals agree but no per-payment match — ${obligations.length} obligation${obligations.length === 1 ? '' : 's'} reconcile only in aggregate.`;
  }
  const matched = results.filter((r) => r.status === 'matched').length;
  const missing = results.filter((r) => r.status === 'missing').length;
  const ambiguous = results.filter((r) => r.status === 'ambiguous').length;
  const parts = [`${matched}/${results.length} obligations have a matching deposit`];
  if (missing) parts.push(`${missing} missing`);
  if (ambiguous) parts.push(`${ambiguous} ambiguous`);
  if (extras.length) parts.push(`${extras.length} unexplained deposit${extras.length === 1 ? '' : 's'}`);
  return `${parts.join(' · ')}.`;
};

export const __test = { normalizeName, nameMatches, referenceTokens };
