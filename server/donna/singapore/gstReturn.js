// SG-3 (compute-half) — the Singapore GST F5 return engine. Pure aggregation,
// mirroring finland/alvReturn.js 1:1: roll a prescribed accounting period's
// posted ledger lines into the F5 per-box totals and the box-8 net position.
// This COMPUTES and RENDERS a verdict; it does NOT persist a `gst_returns` row
// (the DB caller does, mirroring the alv_returns lifecycle), does NOT file to
// IRAS (the transmit seam is gstReturnTransmit.js + iras/submitGstF5.js), and
// never re-decides a tax treatment: it reads the persisted `tax_type` verdicts
// the coder wrote (render-the-persisted-verdict).
//
// KEEP-layer: per-box arithmetic (tax = base × rate on the period sum per code)
// and the F5 identities (box 4 = 1+2+3; box 8 = 6−7) are deterministic IRAS
// validation rules, not model judgment. Code↔account compatibility and uncoded
// revenue are surfaced as blockers — a read model can't refuse a posting, so
// "refuse" here means the return is `needs_review` with the lines named.

import {
  GST_F5_BOXES,
  GST_F5_BOX_PROVENANCE,
  GST_SUPPLY_BOXES_IN_4,
  KNOWN_SG_GST_CODES,
  resolveGstEntry
} from './gstCodes.js';
import { GST_ACCOUNT_CODES, resolveSgAccount } from './sfrsChart.js';
import { toUtcIsoDay } from '../dates.js';

// The GST return compute flag. Config-plane stage (migration 042 pattern), read
// via clientFlagActs with envFallback () => false — never an env pair.
export const SINGAPORE_GST_RETURN_FLAG_KEY = 'SINGAPORE_GST_RETURN';

// The compute-and-file lane flag. Separate from the compute flag: a statutory
// outbound submission gets its own staged authority (the per-channel 042
// posture), starting dark. Config-plane only, envFallback () => false.
export const SINGAPORE_GST_FILING_FLAG_KEY = 'SINGAPORE_GST_FILING';

// The gst_returns lifecycle vocabulary (CLOSED — two-terminal-states applied to
// the return: a pending draft is ON THE OWNER via its confirm ask; filed and
// cancelled are terminal-with-receipt). Pinned by migrations.test.js against
// the 089 CHECK constraint so SQL and runtime can never drift.
export const GST_RETURN_STATUSES = Object.freeze(['draft_pending_confirmation', 'filed', 'cancelled']);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const badPeriod = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'SINGAPORE_GST_PERIOD_INVALID';
  return error;
};

// UTC on purpose: the month end is Date.UTC arithmetic on a bare calendar
// day — the host zone must not move it.
const lastDayOfMonth = (year, month1based) => toUtcIsoDay(Date.UTC(year, month1based, 0));

// resolveGstPeriod(period) — parse a prescribed-accounting-period key into
// calendar bounds. Accepted shapes: 'YYYY-MM' (month), 'YYYY-QN' (quarter).
// Which cadence a given client USES is IRAS-assigned client data
// (profile.gst_period via gstPeriodCadenceForProfile); the engine supports
// both. A YEAR key is refused — Singapore has no annual GST accounting period
// (the deliberate difference from resolveAlvPeriod).
export const resolveGstPeriod = (period) => {
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
  throw badPeriod(`GST period must be YYYY-MM or YYYY-QN (got "${period}"); Singapore has no annual GST accounting period.`);
};

// The F5 filing deadline: one month after the end of the prescribed accounting
// period (GST-registered businesses file and pay within a month of period end).
// Deterministic calendar arithmetic; provenance rides the box map's stamp.
export const gstFilingDueDate = (period = {}) => {
  const ends = String(period.ends_on || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ends)) return null;
  const [y, m] = ends.split('-').map(Number);
  return lastDayOfMonth(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
};

const emptyBoxes = () => {
  const boxes = {};
  for (const box of Object.keys(GST_F5_BOXES)) boxes[box] = 0;
  return boxes;
};

// assertGstF5Foots(gstReturn) — the F5 identities, recomputed. A KEEP-layer
// self-check: the builder runs it before returning, and any persist/notify/
// transmit lane must run it again before acting on a stored verdict.
//   • box 4 = box 1 + box 2 + box 3
//   • box 8 = box 6 − box 7 (== payable)
export const assertGstF5Foots = (gstReturn = {}) => {
  const boxes = gstReturn.boxes || {};
  const expected4 = GST_SUPPLY_BOXES_IN_4.reduce((sum, box) => round2(sum + num(boxes[box])), 0);
  const expected8 = round2(num(boxes['6']) - num(boxes['7']));
  if (round2(num(boxes['4'])) !== expected4) {
    const error = new Error(`GST F5 does not foot: box 4=${boxes['4']} expected=${expected4} (1+2+3).`);
    error.code = 'SINGAPORE_GST_RETURN_MISFOOT';
    throw error;
  }
  if (round2(num(boxes['8'])) !== expected8 || round2(num(gstReturn.payable)) !== expected8) {
    const error = new Error(
      `GST F5 does not foot: box 8=${boxes['8']} payable=${gstReturn.payable} expected=${expected8} (6−7).`
    );
    error.code = 'SINGAPORE_GST_RETURN_MISFOOT';
    throw error;
  }
  return true;
};

// Balance-sheet account types never carry a GST base. Anything else that moves
// in the period is P&L activity. The raw ledger account_type is a free string
// (Xero-mirrored SG charts carry sales / otherincome / REVENUE / OVERHEADS /
// DIRECTCOSTS / DEPRECIATN), so it is normalised ONCE, here, into
// revenue | expense | balance_sheet | unclassified (the ledgerReadModel
// classifiers' vocabulary, kept pure). A type in none of those is UNCLASSIFIED:
// the calculation cannot attribute it, so it must not pass silently.
const BALANCE_SHEET_TYPE = /asset|bank|liabilit|equity|inventory|receivable|payable|loan|creditcard|cash/;
const REVENUE_TYPE = /revenue|income|sales/;
const EXPENSE_TYPE = /expense|overhead|cost|depreciat/;
const classifyAccountType = (type) => {
  const key = String(type || '').toLowerCase().replace(/[\s_-]/g, '');
  if (BALANCE_SHEET_TYPE.test(key)) return 'balance_sheet';
  if (REVENUE_TYPE.test(key)) return 'revenue';
  if (EXPENSE_TYPE.test(key)) return 'expense';
  return 'unclassified';
};

// P&L accounts that are outside GST by their nature, never by a coder's choice:
// depreciation (a non-cash allocation of a cost whose GST was claimed at
// purchase) and FX gain/loss. The account is identified through the chart's own
// statutory group / canonical role — no second classifier — so a quarter whose
// only movement is one of these is a nil return, not an uncoded book.
const NON_GST_CANONICAL_ROLES = new Set(['expense.fx']);
const isNonGstByNature = (line) =>
  resolveSgAccount(line.account_code)?.statutory_group === 'depreciation'
  || NON_GST_CANONICAL_ROLES.has(String(line.canonical_role || ''));

const compactLineRef = (line, signedAmount) => ({
  journal_id: line.journal_id ?? null,
  line_no: line.line_no ?? null,
  account_code: line.account_code ?? null,
  tax_type: line.tax_type ?? null,
  amount: round2(signedAmount)
});

// Resolve the account type behind a line: the joined/denormalized line field
// first, then the supplied accounts, then the SFRS chart (pure, deterministic).
const lineAccountType = (line, accountsById, accountsByCode) => {
  if (line.account_type) return String(line.account_type);
  const account = accountsById.get(line.account_id) || accountsByCode.get(String(line.account_code || ''));
  if (account?.account_type) return String(account.account_type);
  return resolveSgAccount(line.account_code)?.account_type || null;
};

// buildGstF5FromLedgerLines({ period, lines, accounts }) — the SG-3 aggregation.
//
// `period` is a resolveGstPeriod result (or a key string); `lines` are POSTED
// ledger lines for the period (net amounts — the base rides on the P&L/asset
// line, never on a GST control account); `accounts` (optional) resolves
// account_type when the lines don't carry it. Returns { period, gstReturn,
// review } — the caller wraps provenance.
export const buildGstF5FromLedgerLines = ({ period, lines = [], accounts = [] } = {}) => {
  const resolvedPeriod = typeof period === 'string' ? resolveGstPeriod(period) : period;
  if (!resolvedPeriod?.starts_on || !resolvedPeriod?.ends_on) {
    throw badPeriod('GST F5 requires a resolved period.');
  }

  const accountsById = new Map();
  const accountsByCode = new Map();
  for (const account of accounts) {
    if (account?.id) accountsById.set(account.id, account);
    if (account?.code) accountsByCode.set(String(account.code), account);
  }

  const basePerCode = new Map(); // code → summed signed base
  const incompatibleLines = [];
  const inputTaxAssessmentLines = []; // RC recovery cannot be inferred from the GST code.
  const uncodedRevenueLines = [];
  const controlLegs = []; // the role-marked GST legs (the D-FI3-S5 twin)
  let unmarkedControlMovement = 0;
  let uncodedExpenseLineCount = 0;
  let contributingLines = 0;
  let knownInputCodedLines = 0; // input-side lines carrying any known GST code (incl. no-GST / out of scope)
  let uncodedPnlLineCount = 0; // uncoded P&L movement of any classified/unclassified type
  let unclassifiedUncodedLineCount = 0; // uncoded, and neither revenue/expense nor balance-sheet
  let revenueTotal = 0; // box 13 — accounting revenue, independent of coding

  for (const line of Array.isArray(lines) ? lines : []) {
    const debit = num(line.debit);
    const credit = num(line.credit);
    const accountType = lineAccountType(line, accountsById, accountsByCode);
    const accountClass = classifyAccountType(accountType);
    const code = String(line.tax_type || '').trim().toUpperCase();
    const known = code && KNOWN_SG_GST_CODES.has(code);

    // Box 13 (Revenue) reports ACCOUNTING revenue for the period regardless of
    // GST coding — every revenue-type line contributes, coded or not.
    if (accountClass === 'revenue') revenueTotal = round2(revenueTotal + (credit - debit));

    // A split's GST leg is ROLE-marked (the role rides ledger_lines.payload and
    // is spread onto the line by the reader). It is a control entry, never a
    // base — collect it for the cross-check and keep it out of the base walk.
    const role = String(line.role || '').trim();
    if (role === 'gst_output' || role === 'gst_input_claimable') {
      controlLegs.push({ role, signed: role === 'gst_output' ? credit - debit : debit - credit });
      continue;
    }

    if (!known) {
      if (accountClass !== 'balance_sheet' && debit - credit !== 0 && !isNonGstByNature(line)) {
        uncodedPnlLineCount += 1;
        if (accountClass === 'unclassified') unclassifiedUncodedLineCount += 1;
      }
      // Uncoded revenue in a GST-registered book is potentially unreported
      // output tax → blocker. Uncoded expenses only under-claim an input tax
      // credit (a right, not an obligation) → info count. (The D-FI3-A4 twin.)
      if (accountClass === 'revenue') {
        const signed = credit - debit;
        if (signed !== 0) uncodedRevenueLines.push(compactLineRef(line, signed));
      } else if (accountClass === 'expense') {
        if (debit - credit !== 0 && !isNonGstByNature(line)) uncodedExpenseLineCount += 1;
      } else if (GST_ACCOUNT_CODES.has(String(line.account_code || ''))) {
        // Unmarked movement on a control account (a manual journal, or the
        // IRAS settlement posting): surfaced as INFO, not a blocker — the
        // dangerous case (a GST CODE on a control account) is the blocker below.
        unmarkedControlMovement = round2(unmarkedControlMovement + (debit - credit));
      }
      continue;
    }

    const entry = resolveGstEntry(code);

    // Conservative code↔account compatibility (the D-FI3-A5 twin).
    const onControlAccount = GST_ACCOUNT_CODES.has(String(line.account_code || ''));
    const outOnExpense = entry.direction === 'out' && accountClass === 'expense';
    const inOnRevenue = entry.direction === 'in' && accountClass === 'revenue';
    // An account type the calculation cannot classify cannot be proven
    // compatible with the code either — named, never silently dropped from
    // box 13 / the base walk.
    if (onControlAccount || outOnExpense || inOnRevenue || accountClass === 'unclassified') {
      const signed = entry.direction === 'in' ? debit - credit : credit - debit;
      incompatibleLines.push(compactLineRef(line, signed));
      continue;
    }

    if (entry.direction === 'in' || (entry.direction === 'both' && accountClass === 'expense')) knownInputCodedLines += 1;
    if (!entry.return_boxes) continue; // no-GST / out-of-scope: not reported

    // Signed net base — output codes read credit−debit, input codes
    // debit−credit, so credit notes/adjustments net out (the D-FI3-A1 twin).
    const base = entry.direction === 'in' ? debit - credit : credit - debit;
    if (base === 0) continue;
    if (entry.requiresInputTaxAssessment) {
      inputTaxAssessmentLines.push(compactLineRef(line, base));
    }
    basePerCode.set(code, (basePerCode.get(code) || 0) + base);
    contributingLines += 1;
  }

  const boxes = emptyBoxes();
  // The DOMESTIC claimable share of box 7 (the split-posted part; import GST
  // and self-assessed RC deductions have no control legs in v1).
  let expectedDomesticClaimable = 0;
  for (const [code, rawBase] of basePerCode) {
    const entry = resolveGstEntry(code);
    const base = round2(rawBase);
    // Tax on the PERIOD SUM per code (the return's own convention), not
    // per-line rounding.
    const tax = round2((base * entry.rate) / 100);
    const baseBoxes = Array.isArray(entry.return_boxes.base) ? entry.return_boxes.base : [entry.return_boxes.base];
    for (const box of baseBoxes.filter(Boolean)) boxes[box] = round2(boxes[box] + base);
    if (entry.return_boxes.scheme) boxes[entry.return_boxes.scheme] = round2(boxes[entry.return_boxes.scheme] + base);
    if (entry.return_boxes.tax) boxes[entry.return_boxes.tax] = round2(boxes[entry.return_boxes.tax] + tax);
    // IRAS Completing GST Return, boxes 7/14 (2026-09-24): RC recovery is
    // conditional. Leave its input credit unassessed and block the draft; zero
    // here is a provisional omission, not a finding that no credit is allowed.
    // Source: SG_GST_CODES reverse-charge provenance in gstCodes.js.
    if (entry.return_boxes.deductible && !entry.requiresInputTaxAssessment) {
      boxes[entry.return_boxes.deductible] = round2(boxes[entry.return_boxes.deductible] + tax);
    }
    if (entry.direction === 'in' && entry.kind === 'standard') {
      expectedDomesticClaimable = round2(expectedDomesticClaimable + tax);
    }
  }

  boxes['4'] = GST_SUPPLY_BOXES_IN_4.reduce((sum, box) => round2(sum + boxes[box]), 0);
  boxes['8'] = round2(boxes['6'] - boxes['7']);
  boxes['13'] = round2(revenueTotal);

  // The control-account cross-check (the D-FI3-S5 twin): two independent
  // computations of the same statutory number must agree. The role-marked GST
  // legs (posting-time arithmetic) vs the computed boxes (return-time
  // period-sum arithmetic); tolerance covers per-line-vs-period-sum rounding
  // drift. Runs only when the book HAS split-relevant activity.
  const expectedOutputTax = round2(num(boxes['6']));
  const actualOutputTax = round2(controlLegs.filter((l) => l.role === 'gst_output').reduce((s, l) => s + l.signed, 0));
  const actualDomesticClaimable = round2(controlLegs.filter((l) => l.role === 'gst_input_claimable').reduce((s, l) => s + l.signed, 0));
  const controlCheckRan = controlLegs.length > 0 || expectedOutputTax !== 0 || expectedDomesticClaimable !== 0;
  // Honest per-leg drift is <= half a cent per rounded leg plus half a cent on
  // the period sum, so the allowance is 0.5c per leg + 1c — NOT a cent per leg,
  // which would hide a wrong leg of up to N cents in an N-leg book. Unrounded on
  // purpose (0.015 must not round to 0.02); compared with a float epsilon.
  const controlTolerance = Math.round((0.005 * controlLegs.length + 0.01) * 1e4) / 1e4;
  const CONTROL_EPSILON = 1e-9;
  // The output-tax cross-check compares the SPLIT-POSTED share only: RC
  // imported-services tax reports in box 6 but posts no control leg in v1, so
  // its share is excluded from the expectation before comparing.
  const rcTaxInBox6 = round2([...basePerCode.entries()].reduce((sum, [code, rawBase]) => {
    const entry = resolveGstEntry(code);
    if (entry.kind !== 'reverse_charge' || !entry.return_boxes?.tax) return sum;
    return round2(sum + round2((round2(rawBase) * entry.rate) / 100));
  }, 0));
  const expectedSplitOutputTax = round2(expectedOutputTax - rcTaxInBox6);
  const controlMismatch = controlCheckRan && (
    Math.abs(round2(actualOutputTax - expectedSplitOutputTax)) > controlTolerance + CONTROL_EPSILON
    || Math.abs(round2(actualDomesticClaimable - expectedDomesticClaimable)) > controlTolerance + CONTROL_EPSILON
  );
  const controlCheck = {
    ran: controlCheckRan,
    outputTax: { expected: expectedSplitOutputTax, actual: actualOutputTax },
    domesticClaimable: { expected: expectedDomesticClaimable, actual: actualDomesticClaimable },
    tolerance: controlTolerance,
    legCount: controlLegs.length,
    unmarkedControlMovement: round2(unmarkedControlMovement)
  };

  const gstReturn = {
    boxes,
    payable: boxes['8'],
    refund: boxes['8'] < 0,
    // A nil F5 is a VALID return (IRAS requires a filing for every prescribed
    // accounting period even with no activity), never a blocker. Box 13 revenue
    // alone (uncoded books aside) does not clear the nil flag — coded activity does.
    nilReturn: contributingLines === 0,
    fullInputTaxCreditAssumed: inputTaxAssessmentLines.length === 0
  };
  assertGstF5Foots(gstReturn);

  const blockers = [];
  if (inputTaxAssessmentLines.length) blockers.push('reverse_charge_input_tax_assessment_required');
  if (uncodedRevenueLines.length) blockers.push('uncoded_revenue_lines');
  if (incompatibleLines.length) blockers.push('incompatible_tax_lines');
  // Singapore posting is gross-only today (SG-8 unbuilt): P&L movement carries
  // no SG GST code, so a nil/partial figure is a NON-computation, not a return.
  // Blocks when uncoded EXPENSE movement (depreciation / FX excepted — outside
  // GST by nature) sits in a book where NOTHING on the input side is coded (a
  // coded sale beside 40 uncoded gross expenses is still a gross-only book whose
  // box 5/7 under-claims), or when uncoded movement sits on an account type the
  // calculation cannot classify. Once any input-side line is coded (including
  // no-GST / out of scope), remaining uncoded expenses are an info count
  // (under-claiming an input tax credit is a right, not an obligation).
  // Skipped when uncoded_revenue_lines already names the cause.
  const notCodedAtPosting = !uncodedRevenueLines.length
    && (unclassifiedUncodedLineCount > 0 || (uncodedExpenseLineCount > 0 && knownInputCodedLines === 0));
  if (notCodedAtPosting) blockers.push('gst_not_coded_at_posting');
  // A negative supply/purchase/tax box (credit notes and adjustments exceeding
  // the period's supplies) is not a filing shape this engine can vouch for —
  // IRAS acceptance of a negative F5 box is unconfirmed — so it needs review.
  // Box 8 alone may legitimately be negative (a refund: input tax > output tax).
  const negativeBoxes = ['1', '2', '3', '5', '6', '7'].filter((box) => boxes[box] < 0);
  if (negativeBoxes.length) blockers.push('negative_return_box');
  // A disagreement between the posted GST legs and the computed boxes blocks —
  // it catches pre-split gross-coded lines, a broken split, and manual edits
  // alike. Never a silent wrong return.
  if (controlMismatch) blockers.push('control_account_mismatch');

  return {
    period: resolvedPeriod,
    gstReturn,
    review: {
      status: blockers.length ? 'needs_review' : 'ready',
      blockers,
      uncodedRevenueLines,
      incompatibleLines,
      inputTaxAssessmentLines,
      uncodedExpenseLineCount,
      uncodedPnlLineCount,
      unclassifiedUncodedLineCount,
      negativeBoxes,
      controlCheck
    }
  };
};

// The provenance stamp the DB caller attaches — the box map's confirmation
// state travels WITH every rendered verdict (the-model-id-is-part-of-the-
// receipt discipline, applied to statutory reference data).
export const gstF5BoxMapProvenance = () => ({ ...GST_F5_BOX_PROVENANCE });
