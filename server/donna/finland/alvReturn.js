// FI-3 (compute-half) — the Finnish ALV return engine (ALV-ilmoitus / veroilmoitus
// oma-aloitteisista veroista, arvonlisäveron tiedot). Pure aggregation: roll a
// verokausi's posted ledger lines into the VSRALVKV per-field totals and the
// field-308 net payable. This COMPUTES and RENDERS a verdict; it does NOT persist
// an `alv_returns` row (that lands with the notify/file lane once D3 gives it a
// terminal state — two-terminal-states applied to the return lifecycle), does NOT
// file to OmaVero (FI-8), and never re-decides a tax treatment: it reads the
// persisted `tax_type` verdicts the coder wrote (render-the-persisted-verdict).
// Design + decisions D-FI3-A1…A6: docs/design-donna-finland-fi3-alv-return.md.
//
// KEEP-layer: per-field arithmetic (tax = base × rate on the period sum per code)
// and the 308 identity (308 = 301+302+303+304+305+306+318 − 307) are deterministic
// VSRALVKV rules, not model judgment. Code↔account compatibility and uncoded
// revenue are surfaced as blockers — a read model can't refuse a posting, so
// "refuse" here means the return is `needs_review` with the lines named.

import {
  ALV_RETURN_BOXES,
  ALV_RETURN_BOX_PROVENANCE,
  ALV_TAX_FIELDS_IN_308,
  KNOWN_ALV_CODES,
  resolveAlvEntry
} from './alvCodes.js';
import { ALV_ACCOUNT_CODES, resolveAccount } from './tilikartta.js';
import { toUtcIsoDay } from '../dates.js';

// FI-3 — the ALV return compute flag. Config-plane stage (migration 042 pattern),
// read via clientFlagActs with envFallback () => false — never an env pair. No
// FINLAND_TILIKAUSI dependency: the verokausi is calendar-based, not tilikausi-based.
export const FINLAND_ALV_RETURN_FLAG_KEY = 'FINLAND_ALV_RETURN';

// FI-3 slice P — the compute-and-file lane flag (D3, Kari 2026-07-10). Separate
// from the compute flag: a statutory outbound submission gets its own staged
// authority (the per-channel 042 posture), starting dark. Config-plane only,
// envFallback () => false — never an env pair.
export const FINLAND_ALV_FILING_FLAG_KEY = 'FINLAND_ALV_FILING';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const badPeriod = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'FINLAND_ALV_PERIOD_INVALID';
  return error;
};

// UTC on purpose: the month end is Date.UTC arithmetic on a bare calendar
// day — the host zone must not move it.
const lastDayOfMonth = (year, month1based) => toUtcIsoDay(Date.UTC(year, month1based, 0));

// The ALV filing cadences (verokausi), stored as the period TYPE resolveAlvPeriod
// speaks. D3 (Kari, 2026-07-10): monthly is the default verokausi.
export const VEROKAUSI_CADENCES = ['month', 'quarter', 'year'];
export const DEFAULT_VEROKAUSI_CADENCE = 'month';

// verokausiCadenceForProfile(profile) — the client's assigned ALV filing cadence,
// read from the (validated) clients.profile.verokausi DATA field. Pure; unknown /
// absent ⇒ the D3 monthly default. The profile writer normalises to the canonical
// vocabulary, but this stays defensive (aliases + casing) so a hand-set or legacy
// value still resolves rather than silently defaulting.
export const verokausiCadenceForProfile = (profile = {}) => {
  const raw = String(profile?.verokausi || '').trim().toLowerCase();
  if (!raw) return DEFAULT_VEROKAUSI_CADENCE;
  if (VEROKAUSI_CADENCES.includes(raw)) return raw;
  const alias = {
    monthly: 'month', kuukausi: 'month',
    quarterly: 'quarter', neljannes: 'quarter', neljännes: 'quarter',
    yearly: 'year', annual: 'year', annually: 'year', vuosi: 'year'
  }[raw];
  return alias || DEFAULT_VEROKAUSI_CADENCE;
};

// resolveAlvPeriod(period) — parse a verokausi key into calendar bounds.
// Accepted shapes: 'YYYY-MM' (month), 'YYYY-QN' (quarter), 'YYYY' (year).
// Which length a given client USES is Verohallinto-assigned client data (D3 /
// D-FI3-A3); the engine supports all three, so FI-3 does not block on D3.
export const resolveAlvPeriod = (period) => {
  const key = String(period || '').trim().toUpperCase();
  let match = key.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    return {
      key,
      type: 'month',
      starts_on: `${match[1]}-${match[2]}-01`,
      ends_on: lastDayOfMonth(year, month)
    };
  }
  match = key.match(/^(\d{4})-Q([1-4])$/);
  if (match) {
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const startMonth = (quarter - 1) * 3 + 1;
    return {
      key,
      type: 'quarter',
      starts_on: `${match[1]}-${String(startMonth).padStart(2, '0')}-01`,
      ends_on: lastDayOfMonth(year, startMonth + 2)
    };
  }
  match = key.match(/^(\d{4})$/);
  if (match) {
    return { key, type: 'year', starts_on: `${match[1]}-01-01`, ends_on: `${match[1]}-12-31` };
  }
  throw badPeriod(`ALV period must be YYYY-MM, YYYY-QN, or YYYY (got "${period}").`);
};

const emptyBoxes = () => {
  const boxes = {};
  for (const field of Object.keys(ALV_RETURN_BOXES)) boxes[field] = 0;
  return boxes;
};

// assertAlvReturnFoots(alvReturn) — the VSRALVKV 308 identity, recomputed. A
// KEEP-layer self-check: the builder runs it before returning, and any future
// persist/notify lane must run it again before acting on a stored verdict.
export const assertAlvReturnFoots = (alvReturn = {}) => {
  const boxes = alvReturn.boxes || {};
  const taxTotal = ALV_TAX_FIELDS_IN_308.reduce((sum, field) => round2(sum + num(boxes[field])), 0);
  const expected = round2(taxTotal - num(boxes['307']));
  if (round2(num(boxes['308'])) !== expected || round2(num(alvReturn.payable)) !== expected) {
    const error = new Error(
      `ALV return does not foot: 308=${boxes['308']} payable=${alvReturn.payable} expected=${expected}.`
    );
    error.code = 'FINLAND_ALV_RETURN_MISFOOT';
    throw error;
  }
  return true;
};

const compactLineRef = (line, signedAmount) => ({
  journal_id: line.journal_id ?? null,
  line_no: line.line_no ?? null,
  account_code: line.account_code ?? null,
  tax_type: line.tax_type ?? null,
  amount: round2(signedAmount)
});

// Resolve the account type behind a line: the joined/denormalized line field
// first, then the supplied accounts, then the tilikartta (pure, deterministic).
const lineAccountType = (line, accountsById, accountsByCode) => {
  if (line.account_type) return String(line.account_type);
  const account = accountsById.get(line.account_id) || accountsByCode.get(String(line.account_code || ''));
  if (account?.account_type) return String(account.account_type);
  return resolveAccount(line.account_code)?.account_type || null;
};

// buildAlvReturnFromLedgerLines({ period, lines, accounts }) — the FI-3 aggregation.
//
// `period` is a resolveAlvPeriod result (or a key string); `lines` are POSTED
// ledger lines for the period (net amounts — the base rides on the P&L/asset
// line, never on an ALV control account); `accounts` (optional) resolves
// account_type when the lines don't carry it. Returns { period, alvReturn,
// review } — the caller wraps provenance.
export const buildAlvReturnFromLedgerLines = ({ period, lines = [], accounts = [] } = {}) => {
  const resolvedPeriod = typeof period === 'string' ? resolveAlvPeriod(period) : period;
  if (!resolvedPeriod?.starts_on || !resolvedPeriod?.ends_on) {
    throw badPeriod('ALV return requires a resolved period.');
  }

  const accountsById = new Map();
  const accountsByCode = new Map();
  for (const account of accounts) {
    if (account?.id) accountsById.set(account.id, account);
    if (account?.code) accountsByCode.set(String(account.code), account);
  }

  const basePerCode = new Map(); // code → summed signed base
  const incompatibleLines = [];
  const uncodedRevenueLines = [];
  const controlLegs = []; // FI-3 slice S — the role-marked VAT legs (D-FI3-S5)
  let unmarkedControlMovement = 0;
  let uncodedExpenseLineCount = 0;
  let contributingLines = 0;

  for (const line of Array.isArray(lines) ? lines : []) {
    const debit = num(line.debit);
    const credit = num(line.credit);
    const accountType = lineAccountType(line, accountsById, accountsByCode);
    const code = String(line.tax_type || '').trim().toUpperCase();
    const known = code && KNOWN_ALV_CODES.has(code);

    // FI-3 slice S (D-FI3-S3/S5): a split's VAT leg is ROLE-marked (the role
    // rides ledger_lines.payload and is spread onto the line by the reader).
    // It is a control entry, never a base — collect it for the cross-check and
    // keep it out of the base walk.
    const role = String(line.role || '').trim();
    if (role === 'alv_output' || role === 'alv_input_deductible') {
      controlLegs.push({ role, signed: role === 'alv_output' ? credit - debit : debit - credit });
      continue;
    }

    if (!known) {
      // D-FI3-A4: uncoded revenue in an ALV-registered book is potentially
      // unreported output tax → blocker. Uncoded expenses only under-claim a
      // deduction (a right, not an obligation) → info count.
      if (accountType === 'revenue') {
        const signed = credit - debit;
        if (signed !== 0) uncodedRevenueLines.push(compactLineRef(line, signed));
      } else if (accountType === 'expense') {
        if (debit - credit !== 0) uncodedExpenseLineCount += 1;
      } else if (ALV_ACCOUNT_CODES.has(String(line.account_code || ''))) {
        // Unmarked movement on a control account (a manual journal, or a
        // future settlement posting): surfaced as INFO, not a blocker — the
        // dangerous case (an ALV CODE on a control account) is already the
        // D-FI3-A5 blocker below.
        unmarkedControlMovement = round2(unmarkedControlMovement + (debit - credit));
      }
      continue;
    }

    const entry = resolveAlvEntry(code);

    // D-FI3-A5 — conservative code↔account compatibility (the §4.3 KEEP invariant).
    const onControlAccount = ALV_ACCOUNT_CODES.has(String(line.account_code || ''));
    const outOnExpense = entry.direction === 'out' && accountType === 'expense';
    const inOnRevenue = entry.direction === 'in' && accountType === 'revenue';
    if (onControlAccount || outOnExpense || inOnRevenue) {
      const signed = entry.direction === 'in' ? debit - credit : credit - debit;
      incompatibleLines.push(compactLineRef(line, signed));
      continue;
    }

    if (!entry.return_boxes) continue; // exempt / out-of-scope: not reported

    // D-FI3-A1: signed net base — output codes read credit−debit, input codes
    // debit−credit, so credit notes/adjustments net out.
    const base = entry.direction === 'in' ? debit - credit : credit - debit;
    if (base === 0) continue;
    basePerCode.set(code, (basePerCode.get(code) || 0) + base);
    contributingLines += 1;
  }

  const boxes = emptyBoxes();
  // FI-3 slice S — the DOMESTIC deductible share of 307 (the split-posted part;
  // self-assessed deductions have no control legs in v1 per D-FI3-S1).
  let expectedDomesticDeductible = 0;
  for (const [code, rawBase] of basePerCode) {
    const entry = resolveAlvEntry(code);
    const base = round2(rawBase);
    // D-FI3-A1: tax on the PERIOD SUM per code (the return's own convention),
    // not per-line rounding.
    const tax = round2((base * entry.rate) / 100);
    if (entry.return_boxes.base) boxes[entry.return_boxes.base] = round2(boxes[entry.return_boxes.base] + base);
    if (entry.return_boxes.tax) boxes[entry.return_boxes.tax] = round2(boxes[entry.return_boxes.tax] + tax);
    // D-FI3-A2: self-assessed codes (and plain input codes) deduct in 307 under
    // the v1 full-deduction-right default; the assumption is surfaced below.
    if (entry.return_boxes.deductible) {
      boxes[entry.return_boxes.deductible] = round2(boxes[entry.return_boxes.deductible] + tax);
    }
    if (entry.direction === 'in' && ['standard', 'reduced'].includes(entry.kind)) {
      expectedDomesticDeductible = round2(expectedDomesticDeductible + tax);
    }
  }

  const taxTotal = ALV_TAX_FIELDS_IN_308.reduce((sum, field) => round2(sum + boxes[field]), 0);
  boxes['308'] = round2(taxTotal - boxes['307']);

  // FI-3 slice S (D-FI3-S5) — the control-account cross-check: two independent
  // computations of the same statutory number must agree. The role-marked VAT
  // legs (posting-time arithmetic) vs the computed boxes (return-time period-sum
  // arithmetic); tolerance covers per-line-vs-period-sum rounding drift. Runs
  // only when the book HAS split-relevant activity — a book with neither legs
  // nor domestic coded lines has nothing to cross-check.
  const expectedOutputTax = round2(num(boxes['301']) + num(boxes['302']) + num(boxes['303']));
  const actualOutputTax = round2(controlLegs.filter((l) => l.role === 'alv_output').reduce((s, l) => s + l.signed, 0));
  const actualDomesticDeductible = round2(controlLegs.filter((l) => l.role === 'alv_input_deductible').reduce((s, l) => s + l.signed, 0));
  const controlCheckRan = controlLegs.length > 0 || expectedOutputTax !== 0 || expectedDomesticDeductible !== 0;
  const controlTolerance = Math.max(0.02, round2(0.01 * controlLegs.length));
  const controlMismatch = controlCheckRan && (
    Math.abs(round2(actualOutputTax - expectedOutputTax)) > controlTolerance
    || Math.abs(round2(actualDomesticDeductible - expectedDomesticDeductible)) > controlTolerance
  );
  const controlCheck = {
    ran: controlCheckRan,
    outputTax: { expected: expectedOutputTax, actual: actualOutputTax },
    domesticDeductible: { expected: expectedDomesticDeductible, actual: actualDomesticDeductible },
    tolerance: controlTolerance,
    legCount: controlLegs.length,
    unmarkedControlMovement: round2(unmarkedControlMovement)
  };

  const alvReturn = {
    boxes,
    payable: boxes['308'],
    refund: boxes['308'] < 0,
    // D-FI3-A6: a nil return is a VALID return (Verohallinto requires a filing
    // for every period even with no activity), never a blocker.
    nilReturn: contributingLines === 0,
    selfAssessedFullyDeductible: true
  };
  assertAlvReturnFoots(alvReturn);

  const blockers = [];
  if (uncodedRevenueLines.length) blockers.push('uncoded_revenue_lines');
  if (incompatibleLines.length) blockers.push('incompatible_tax_lines');
  // D-FI3-S5/S7: a disagreement between the posted VAT legs and the computed
  // boxes blocks — it catches pre-split gross-coded lines, a broken split, and
  // manual edits alike. Never a silent wrong return.
  if (controlMismatch) blockers.push('control_account_mismatch');

  return {
    period: resolvedPeriod,
    alvReturn,
    review: {
      status: blockers.length ? 'needs_review' : 'ready',
      blockers,
      uncodedRevenueLines,
      incompatibleLines,
      uncodedExpenseLineCount,
      controlCheck
    }
  };
};

// The provenance stamp the DB caller attaches — the box map's confirmation state
// travels WITH every rendered verdict (the-model-id-is-part-of-the-receipt
// discipline, applied to statutory reference data).
export const alvReturnBoxMapProvenance = () => ({ ...ALV_RETURN_BOX_PROVENANCE });
