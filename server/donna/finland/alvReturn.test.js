import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINLAND_ALV_RETURN_FLAG_KEY,
  alvReturnBoxMapProvenance,
  assertAlvReturnFoots,
  buildAlvReturnFromLedgerLines,
  resolveAlvPeriod,
  verokausiCadenceForProfile,
  verokausiBasisForProfile,
  DEFAULT_VEROKAUSI_CADENCE,
  VEROKAUSI_CADENCES
} from './alvReturn.js';
import { buildSalesInvoiceJournal } from '../ledger.js';
import { ALV_SPLIT_CONTROL, alvOutputCodeForRate } from './alvCodes.js';

// 2026-07-27 — `ledger.js` no longer imports `finland/alvCodes.js`; the per-rate
// code map and the ALV control account are INJECTED (gap 8's fourth edge,
// deleted from the isolation-listed post path). This is the profile firmDb's FI
// writer passes, built from the SAME frozen vocabulary the builder used to reach
// for directly — so the integration assertion below is unchanged and doubles as
// the byte-identity check for this lane.
const FI_TAX_POSTING = { outputCodeForRate: alvOutputCodeForRate, control: ALV_SPLIT_CONTROL.out };

const line = ({ account = '3000', type = 'revenue', tax = null, debit = 0, credit = 0, journal = 'j-1', no = 1, role = null } = {}) => ({
  journal_id: journal,
  line_no: no,
  account_code: account,
  account_type: type,
  tax_type: tax,
  debit,
  credit,
  ...(role ? { role } : {})
});

// FI-3 slice S — the split convention's role-marked VAT legs (D-FI3-S3): what
// the journal builders post next to every domestic-rate coded base line.
const outputLeg = ({ vat, no, journal = 'j-1' }) =>
  line({ account: '2939', type: 'liability', credit: vat, no, journal, role: 'alv_output' });
const inputLeg = ({ vat, no, journal = 'j-1' }) =>
  line({ account: '2940', type: 'liability', debit: vat, no, journal, role: 'alv_input_deductible' });

test('FI-3 flag key is the config-plane FINLAND_ALV_RETURN', () => {
  assert.equal(FINLAND_ALV_RETURN_FLAG_KEY, 'FINLAND_ALV_RETURN');
});

test('verokausiCadenceForProfile resolves the client filing cadence, monthly by default (F-FI3-3)', () => {
  assert.equal(DEFAULT_VEROKAUSI_CADENCE, 'month');
  assert.deepEqual(VEROKAUSI_CADENCES, ['month', 'quarter', 'year']);
  // Absent / empty / unknown ⇒ the D3 monthly default.
  assert.equal(verokausiCadenceForProfile({}), 'month');
  assert.equal(verokausiCadenceForProfile({ verokausi: '' }), 'month');
  assert.equal(verokausiCadenceForProfile({ verokausi: 'bogus' }), 'month');
  assert.equal(verokausiCadenceForProfile(null), 'month');
  // Canonical values pass through.
  assert.equal(verokausiCadenceForProfile({ verokausi: 'quarter' }), 'quarter');
  assert.equal(verokausiCadenceForProfile({ verokausi: 'year' }), 'year');
  // Common aliases + casing normalise (defensive against hand-set / legacy values).
  assert.equal(verokausiCadenceForProfile({ verokausi: 'Quarterly' }), 'quarter');
  assert.equal(verokausiCadenceForProfile({ verokausi: 'annual' }), 'year');
  assert.equal(verokausiCadenceForProfile({ verokausi: 'kuukausi' }), 'month');
});

test('resolveAlvPeriod parses month, quarter, and year verokausi keys', () => {
  assert.deepEqual(resolveAlvPeriod('2026-06'), { key: '2026-06', type: 'month', starts_on: '2026-06-01', ends_on: '2026-06-30' });
  assert.deepEqual(resolveAlvPeriod('2024-02'), { key: '2024-02', type: 'month', starts_on: '2024-02-01', ends_on: '2024-02-29' }); // leap year
  assert.deepEqual(resolveAlvPeriod('2026-q2'), { key: '2026-Q2', type: 'quarter', starts_on: '2026-04-01', ends_on: '2026-06-30' });
  assert.deepEqual(resolveAlvPeriod('2026-Q4'), { key: '2026-Q4', type: 'quarter', starts_on: '2026-10-01', ends_on: '2026-12-31' });
  assert.deepEqual(resolveAlvPeriod('2026'), { key: '2026', type: 'year', starts_on: '2026-01-01', ends_on: '2026-12-31' });
});

test('resolveAlvPeriod refuses malformed keys with a typed 400', () => {
  for (const bad of ['2026-13', '2026-Q5', 'June 2026', '', null, '2026-6']) {
    assert.throws(() => resolveAlvPeriod(bad), (e) => e.statusCode === 400 && e.code === 'FINLAND_ALV_PERIOD_INVALID');
  }
});

test('domestic output and input tax land in 301/307 and net into 308', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      // Post-split convention (slice S): net base lines + role-marked VAT legs.
      line({ account: '3000', type: 'revenue', tax: 'ALV_25_5_OUTPUT', credit: 1000 }),
      outputLeg({ vat: 255, no: 2 }),
      line({ account: '6800', type: 'expense', tax: 'ALV_14_INPUT', debit: 200, no: 3 }),
      inputLeg({ vat: 28, no: 4 })
    ]
  });
  assert.equal(result.alvReturn.boxes['301'], 255);
  assert.equal(result.alvReturn.boxes['307'], 28);
  assert.equal(result.alvReturn.boxes['308'], 227);
  assert.equal(result.alvReturn.payable, 227);
  assert.equal(result.alvReturn.refund, false);
  assert.equal(result.alvReturn.nilReturn, false);
  assert.equal(result.review.status, 'ready');
  assert.deepEqual(result.review.blockers, []);
  // The cross-check ran and agreed (D-FI3-S5).
  assert.equal(result.review.controlCheck.ran, true);
  assert.deepEqual(result.review.controlCheck.outputTax, { expected: 255, actual: 255 });
  assert.deepEqual(result.review.controlCheck.domesticDeductible, { expected: 28, actual: 28 });
});

// FI-13 13.4 AR-ALV split — the INTEGRATION proof: the journal buildSalesInvoiceJournal
// posts for an ALV-registered sale feeds the return engine cleanly. The coded
// per-rate revenue leg drives the base-code walk (301) and the role-marked 2939
// leg makes the control cross-check agree — no uncoded-revenue / control-mismatch
// blocker. This is the contract the two isolation-listed pieces share.
test('FI-13 13.4: a buildSalesInvoiceJournal ALV split posts return-clean lines (base code + control cross-check agree)', () => {
  const journal = buildSalesInvoiceJournal({
    invoice: {
      invoiceNumber: '2026010', date: '2026-06-15',
      subtotal: 1000, alvTotal: 255, total: 1255, alvExempt: false,
      buyer: { name: 'Asiakas Oy' },
      lines: [{ description: 'konsultointi', quantity: 1, unitPrice: 1000, alvRate: 25.5, net: 1000, alv: 255 }]
    },
    taxPosting: FI_TAX_POSTING
  });
  // Map the journal's account-nested lines to the flat ledger_lines shape the
  // return engine reads (the DB writer persists tax_type + payload.role likewise).
  const lines = journal.lines.map((jl, i) => ({
    journal_id: 'j-ar', line_no: i + 1,
    account_code: jl.account.code, account_type: jl.account.type,
    tax_type: jl.account.tax_type, role: jl.account.role,
    debit: jl.debit, credit: jl.credit
  }));
  const result = buildAlvReturnFromLedgerLines({ period: '2026-06', lines });
  assert.equal(result.alvReturn.boxes['301'], 255);
  assert.equal(result.alvReturn.payable, 255);
  assert.equal(result.review.status, 'ready');
  assert.deepEqual(result.review.blockers, []);
  assert.equal(result.review.controlCheck.ran, true);
  assert.deepEqual(result.review.controlCheck.outputTax, { expected: 255, actual: 255 });
});

test('a credit note nets against the period base before the rate is applied', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ tax: 'ALV_25_5_OUTPUT', credit: 1000 }),
      line({ tax: 'ALV_25_5_OUTPUT', debit: 200, no: 2 }) // hyvityslasku
    ]
  });
  assert.equal(result.alvReturn.boxes['301'], round(800 * 0.255));
});
const round = (n) => Math.round(n * 100) / 100;

test('self-assessed EU goods acquisition fills 313 + 305 + 307 and is 308-neutral', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [line({ account: '4000', type: 'expense', tax: 'ALV_EU_ACQUISITION', debit: 1000 })]
  });
  assert.equal(result.alvReturn.boxes['313'], 1000);
  assert.equal(result.alvReturn.boxes['305'], 255);
  assert.equal(result.alvReturn.boxes['307'], 255);
  assert.equal(result.alvReturn.boxes['308'], 0);
  assert.equal(result.alvReturn.selfAssessedFullyDeductible, true);
});

test('EU service purchase and import fill their own field trios', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-Q1',
    lines: [
      line({ account: '4400', type: 'expense', tax: 'ALV_EU_SERVICE_ACQUISITION', debit: 400 }),
      line({ account: '4000', type: 'expense', tax: 'ALV_IMPORT', debit: 800, no: 2 })
    ]
  });
  assert.equal(result.alvReturn.boxes['314'], 400);
  assert.equal(result.alvReturn.boxes['306'], 102);
  assert.equal(result.alvReturn.boxes['310'], 800);
  assert.equal(result.alvReturn.boxes['304'], 204);
  assert.equal(result.alvReturn.boxes['307'], 306);
  assert.equal(result.alvReturn.boxes['308'], 0);
});

test('reverse-charge construction purchase fills 320 + 318 + 307', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [line({ account: '4400', type: 'expense', tax: 'ALV_REVERSE_CHARGE_PURCHASE', debit: 2000 })]
  });
  assert.equal(result.alvReturn.boxes['320'], 2000);
  assert.equal(result.alvReturn.boxes['318'], 510);
  assert.equal(result.alvReturn.boxes['307'], 510);
  assert.equal(result.alvReturn.boxes['308'], 0);
});

test('zero-rated export, EU supplies, and reverse-charge sales report base-only fields', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ tax: 'ALV_0_OUTPUT', credit: 100 }),
      line({ tax: 'ALV_EU_SUPPLY', credit: 200, no: 2 }),
      line({ tax: 'ALV_EU_SERVICE_SUPPLY', credit: 300, no: 3 }),
      line({ tax: 'ALV_REVERSE_CHARGE_SALES', credit: 400, no: 4 })
    ]
  });
  assert.equal(result.alvReturn.boxes['309'], 100);
  assert.equal(result.alvReturn.boxes['311'], 200);
  assert.equal(result.alvReturn.boxes['312'], 300);
  assert.equal(result.alvReturn.boxes['319'], 400);
  assert.equal(result.alvReturn.boxes['308'], 0);
  assert.equal(result.review.status, 'ready');
});

test('exempt and out-of-scope lines are not reported on the return', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ tax: 'ALV_EXEMPT', credit: 900 }),
      line({ account: '6800', type: 'expense', tax: 'ALV_OUT_OF_SCOPE', debit: 50, no: 2 })
    ]
  });
  for (const [field, value] of Object.entries(result.alvReturn.boxes)) {
    assert.equal(value, 0, `field ${field} expected 0`);
  }
  // Coded (just not reportable) lines are not "uncoded" — no blocker, but the
  // return is also not nil: the lines DID resolve to a treatment.
  assert.deepEqual(result.review.blockers, []);
});

test('FIK-V: a non-deductible purchase is coded, unreported and never a deduction; on revenue it is incompatible', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ account: '6800', type: 'expense', tax: 'ALV_NONDEDUCTIBLE_INPUT', debit: 125.5 }),
      line({ account: '6800', type: 'expense', tax: 'ALV_25_5_INPUT', debit: 200, no: 2 }),
      inputLeg({ vat: 51, no: 3 })
    ]
  });
  assert.deepEqual(result.review.blockers, []);
  assert.equal(result.review.uncodedExpenseLineCount, 0, 'coded, not an uncoded expense');
  assert.equal(result.alvReturn.boxes['307'], 51, 'only the deductible neighbour deducts');
  assert.equal(result.alvReturn.boxes['308'], -51);
  const onRevenue = buildAlvReturnFromLedgerLines({
    period: '2026-06', lines: [line({ tax: 'ALV_NONDEDUCTIBLE_INPUT', credit: 80 })]
  });
  assert.deepEqual(onRevenue.review.blockers, ['incompatible_tax_lines']);
});

test('a refund period reports negative 308 with refund: true', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [line({ account: '6800', type: 'expense', tax: 'ALV_25_5_INPUT', debit: 1000 })]
  });
  assert.equal(result.alvReturn.boxes['308'], -255);
  assert.equal(result.alvReturn.refund, true);
});

test('uncoded revenue is a blocker; uncoded expense is only an info count (D-FI3-A4)', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ tax: null, credit: 500 }),
      line({ account: '6800', type: 'expense', tax: null, debit: 100, no: 2 }),
      line({ account: '6800', type: 'expense', tax: 'SG_FOREIGN_CODE', debit: 60, no: 3 })
    ]
  });
  assert.equal(result.review.status, 'needs_review');
  assert.deepEqual(result.review.blockers, ['uncoded_revenue_lines']);
  assert.deepEqual(result.review.uncodedRevenueLines, [
    { journal_id: 'j-1', line_no: 1, account_code: '3000', tax_type: null, amount: 500 }
  ]);
  assert.equal(result.review.uncodedExpenseLineCount, 2);
});

test('code↔account incompatibilities are surfaced as blockers (D-FI3-A5)', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      // Output code on an expense account.
      line({ account: '6800', type: 'expense', tax: 'ALV_25_5_OUTPUT', debit: 100 }),
      // Input code on a revenue account.
      line({ account: '3000', type: 'revenue', tax: 'ALV_14_INPUT', credit: 200, no: 2 }),
      // Any ALV code on an ALV control account (holds tax, not base).
      line({ account: '2939', type: 'liability', tax: 'ALV_25_5_OUTPUT', credit: 300, no: 3 })
    ]
  });
  assert.equal(result.review.status, 'needs_review');
  assert.deepEqual(result.review.blockers, ['incompatible_tax_lines']);
  assert.equal(result.review.incompatibleLines.length, 3);
  // Incompatible lines contribute NOTHING to the boxes — surfaced, not summed.
  assert.equal(result.alvReturn.boxes['301'], 0);
  assert.equal(result.alvReturn.boxes['307'], 0);
});

test('input codes on asset accounts are legitimate (fixed-asset purchase VAT deducts)', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ account: '1200', type: 'fixed_asset', tax: 'ALV_25_5_INPUT', debit: 4000 }),
      inputLeg({ vat: 1020, no: 2 })
    ]
  });
  assert.deepEqual(result.review.blockers, []);
  assert.equal(result.alvReturn.boxes['307'], 1020);
});

test('slice S: coded domestic lines WITHOUT control legs block — the D-FI3-S7 retroactivity catch', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [line({ tax: 'ALV_25_5_OUTPUT', credit: 1000 })] // gross-era posting: no leg
  });
  assert.equal(result.review.status, 'needs_review');
  assert.deepEqual(result.review.blockers, ['control_account_mismatch']);
  assert.deepEqual(result.review.controlCheck.outputTax, { expected: 255, actual: 0 });
});

test('slice S: a broken/edited control leg blocks; per-line rounding drift within tolerance does not', () => {
  const broken = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ tax: 'ALV_25_5_OUTPUT', credit: 1000 }),
      outputLeg({ vat: 200, no: 2 }) // hand-edited: should be 255
    ]
  });
  assert.deepEqual(broken.review.blockers, ['control_account_mismatch']);

  const drift = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      // Two lines whose per-line splits round a cent away from the period sum.
      line({ tax: 'ALV_25_5_OUTPUT', credit: 100.4 }),
      outputLeg({ vat: 25.6, no: 2 }),
      line({ tax: 'ALV_25_5_OUTPUT', credit: 100.4, no: 3 }),
      outputLeg({ vat: 25.6, no: 4 })
    ]
  });
  // Period-sum tax = round2(200.8 × 0.255) = 51.20; legs = 51.20 — and even a
  // cent of drift stays under max(0.02, 0.01 × legs).
  assert.equal(drift.review.blockers.includes('control_account_mismatch'), false);
});

test('slice S: a role-preserving reversal NETS the cross-check — the recode path stays green (H-1)', () => {
  // The correction writers carry payload.role through reversals
  // (__reverseLedgerLine / __insertLedgerCorrectionJournal, firmDb.js): a
  // reversed control leg must cancel the original in the cross-check sums, or
  // every correction of a split-posted journal wedges the period in a
  // permanent control_account_mismatch.
  const reversedOnly = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      // Original split sale: net base 1000 @ 25.5 + role-marked leg.
      line({ tax: 'ALV_25_5_OUTPUT', credit: 1000 }),
      outputLeg({ vat: 255, no: 2 }),
      // Its reversal (debit/credit flipped, tax_type AND role preserved).
      line({ tax: 'ALV_25_5_OUTPUT', debit: 1000, journal: 'j-rev', no: 1 }),
      line({ account: '2939', type: 'liability', debit: 255, journal: 'j-rev', no: 2, role: 'alv_output' })
    ]
  });
  assert.deepEqual(reversedOnly.review.blockers, []);
  // The bases net to zero (nilReturn stays false — there WAS activity; the
  // return simply reports zeros).
  assert.equal(reversedOnly.alvReturn.boxes['301'], 0);
  assert.equal(reversedOnly.alvReturn.boxes['308'], 0);
  assert.deepEqual(reversedOnly.review.controlCheck.outputTax, { expected: 0, actual: 0 });

  // Reverse + corrected re-post (recode 25,5 % → 14 %): only the corrected
  // coding survives, boxes and legs agree.
  const recoded = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      line({ tax: 'ALV_25_5_OUTPUT', credit: 1000 }),
      outputLeg({ vat: 255, no: 2 }),
      line({ tax: 'ALV_25_5_OUTPUT', debit: 1000, journal: 'j-rev', no: 1 }),
      line({ account: '2939', type: 'liability', debit: 255, journal: 'j-rev', no: 2, role: 'alv_output' }),
      line({ tax: 'ALV_14_OUTPUT', credit: 1000, journal: 'j-repost', no: 1 }),
      outputLeg({ vat: 140, journal: 'j-repost', no: 2 })
    ]
  });
  assert.deepEqual(recoded.review.blockers, []);
  assert.equal(recoded.alvReturn.boxes['301'], 0);
  assert.equal(recoded.alvReturn.boxes['302'], 140);
  assert.deepEqual(recoded.review.controlCheck.outputTax, { expected: 140, actual: 140 });
});

test('slice S: self-assessed codes need no control legs (D-FI3-S1) and unmarked control movement is INFO, not a blocker', () => {
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [
      // EU acquisition: both 308 sides computed from the base, no legs posted.
      line({ account: '4000', type: 'expense', tax: 'ALV_EU_ACQUISITION', debit: 1000 }),
      // A manual journal touched 2939 without a role mark: surfaced, not blocked.
      line({ account: '2939', type: 'liability', tax: null, debit: 40, no: 2 })
    ]
  });
  assert.deepEqual(result.review.blockers, []);
  assert.equal(result.review.controlCheck.unmarkedControlMovement, 40);
});

test('308 settlement: the OmaVero payment (DR 2939, tax NONE) rests in the INFO lane, never a blocker', () => {
  // What the posting seam produces for the settlement bank line: the coder's
  // 'Suoritettava arvonlisävero' verdict resolves to the coded 2939 row and the
  // control-account guard posts it uncoded (tax_type 'NONE', role 'counterparty').
  const result = buildAlvReturnFromLedgerLines({
    period: '2026-07',
    lines: [
      line({ account: '3000', type: 'revenue', tax: 'ALV_25_5_OUTPUT', credit: 1000 }),
      outputLeg({ vat: 255, no: 2 }),
      // Last period's 308 payable, paid via OmaVero this period.
      line({ account: '2939', type: 'liability', tax: 'NONE', debit: 812.4, no: 3, role: 'counterparty' })
    ]
  });
  assert.deepEqual(result.review.blockers, []);
  assert.equal(result.review.controlCheck.unmarkedControlMovement, 812.4);
  // The current period's own boxes are untouched by the settlement.
  assert.equal(result.alvReturn.boxes['301'], 255);
  assert.deepEqual(result.review.controlCheck.outputTax, { expected: 255, actual: 255 });
});

test('an empty period is a READY nil return, never a blocker (D-FI3-A6)', () => {
  const result = buildAlvReturnFromLedgerLines({ period: '2026-06', lines: [] });
  assert.equal(result.review.status, 'ready');
  assert.equal(result.alvReturn.nilReturn, true);
  assert.equal(result.alvReturn.boxes['308'], 0);
});

test('account type falls back to the supplied accounts, then the tilikartta', () => {
  // No account_type on the line; resolved from the accounts arg.
  const viaAccounts = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [{ journal_id: 'j-1', line_no: 1, account_id: 'a-1', account_code: '9999', tax_type: null, debit: 0, credit: 700 }],
    accounts: [{ id: 'a-1', code: '9999', account_type: 'revenue' }]
  });
  assert.deepEqual(viaAccounts.review.blockers, ['uncoded_revenue_lines']);

  // No account_type anywhere; 3000 resolves to revenue via the tilikartta.
  const viaTilikartta = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [{ journal_id: 'j-1', line_no: 1, account_code: '3000', tax_type: null, debit: 0, credit: 700 }]
  });
  assert.deepEqual(viaTilikartta.review.blockers, ['uncoded_revenue_lines']);
});

test('assertAlvReturnFoots trips on a tampered verdict', () => {
  const good = buildAlvReturnFromLedgerLines({
    period: '2026-06',
    lines: [line({ tax: 'ALV_25_5_OUTPUT', credit: 1000 })]
  });
  assert.equal(assertAlvReturnFoots(good.alvReturn), true);
  const tampered = { ...good.alvReturn, boxes: { ...good.alvReturn.boxes, 307: 100 } };
  assert.throws(() => assertAlvReturnFoots(tampered), (e) => e.code === 'FINLAND_ALV_RETURN_MISFOOT');
});

test('box-map provenance travels with the verdict and is honest about the primary', () => {
  const provenance = alvReturnBoxMapProvenance();
  assert.equal(provenance.confirmedAgainstPrimary, false);
  assert.ok(provenance.source.includes('VSRALVKV'));
});

test('verokausiBasisForProfile reports where the cadence came from without changing it', () => {
  // Nothing recorded: the monthly default, shown as a default.
  assert.deepEqual(verokausiBasisForProfile({}), {
    cadence: 'month', defaulted: true, recorded: { verokausi: null, alv_registration_tax_period: null }, disagreement: false
  });
  // Recorded and agreeing.
  assert.deepEqual(verokausiBasisForProfile({ verokausi: 'quarter', alv_registration: { status: 'registered', tax_period: 'quarter' } }), {
    cadence: 'quarter', defaulted: false, recorded: { verokausi: 'quarter', alv_registration_tax_period: 'quarter' }, disagreement: false
  });
  // The two places disagree: verokausi is still the one in use, the disagreement is reported.
  const split = verokausiBasisForProfile({ verokausi: 'month', alv_registration: { status: 'registered', tax_period: 'quarter' } });
  assert.equal(split.cadence, verokausiCadenceForProfile({ verokausi: 'month' }));
  assert.equal(split.disagreement, true);
  assert.equal(split.defaulted, false);
  // Only the registration records a period: the default applies AND disagrees.
  assert.deepEqual(verokausiBasisForProfile({ alv_registration: { status: 'registered', tax_period: 'year' } }), {
    cadence: 'month', defaulted: true, recorded: { verokausi: null, alv_registration_tax_period: 'year' }, disagreement: true
  });
  // An unrecognised verokausi falls back exactly as before, and says so.
  const junk = verokausiBasisForProfile({ verokausi: 'fortnightly' });
  assert.equal(junk.cadence, 'month');
  assert.equal(junk.defaulted, true);
  assert.equal(verokausiBasisForProfile({ verokausi: 'Neljännes' }).recorded.verokausi, 'quarter', 'aliases still resolve');
});
