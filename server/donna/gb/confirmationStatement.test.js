import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GB_CONFIRMATION_STATEMENT_FLAG_KEY,
  GB_CONFIRMATION_STATEMENT_PROVENANCE,
  assertGbConfirmationReviewPeriodsContiguous,
  assertGbSicCodes,
  assertGbStatementOfCapitalFoots,
  buildGbConfirmationStatement,
  deriveGbConfirmationReviewPeriod,
  gbConfirmationReviewPeriodLengthDays,
  gbConfirmationStatementEnabled,
  resolveGbNextConfirmationReviewPeriod
} from './confirmationStatement.js';

const hasCode = (code, statusCode) => (error) => error.code === code && (statusCode == null || error.statusCode === statusCode);
const ordinary = { class: 'Ordinary', shares_issued: 100, nominal_value_per_share: 1, aggregate_nominal_value: 100, currency: 'GBP' };
const capital = { share_classes: [ordinary], total_issued_shares: 100, total_aggregate_nominal_value: 100 };
const validStatement = {
  company_number: '12345678',
  review_period: { starts_on: '2025-03-15', ends_on: '2026-03-14' },
  registered_office: '1 High Street, London',
  registered_email: 'company@example.com',
  sic_codes: ['62012'],
  officers: [{ name: 'A Director' }],
  psc_statement: { has_psc: false, exemption_reason: 'No registrable PSC' },
  statement_of_capital: capital,
  shareholders: [{ name: 'A Shareholder' }]
};

test('derives first review periods with anniversary and leap-day clamping', () => {
  assert.deepEqual(deriveGbConfirmationReviewPeriod('2025-03-15'), { starts_on: '2025-03-15', ends_on: '2026-03-14' });
  assert.deepEqual(deriveGbConfirmationReviewPeriod('2024-02-29'), { starts_on: '2024-02-29', ends_on: '2025-02-27' });
});

test('first review period refuses missing, malformed, and impossible incorporation dates', () => {
  for (const value of ['', '2025/03/15', '2025-02-30']) {
    assert.throws(() => deriveGbConfirmationReviewPeriod(value), hasCode('GB_CONFIRMATION_REVIEW_PERIOD_INCORPORATION_DATE_NOT_ESTABLISHED', 422));
  }
});

test('derives the next review period and refuses a bad prior end', () => {
  assert.deepEqual(resolveGbNextConfirmationReviewPeriod('2026-03-14'), { starts_on: '2026-03-15', ends_on: '2027-03-14' });
  assert.throws(() => resolveGbNextConfirmationReviewPeriod('bad'), hasCode('GB_CONFIRMATION_REVIEW_PERIOD_END_NOT_ESTABLISHED', 422));
});

test('review-period length is inclusive and invalid input returns NaN', () => {
  assert.equal(gbConfirmationReviewPeriodLengthDays('2025-03-15', '2026-03-14'), 365);
  assert.equal(Number.isNaN(gbConfirmationReviewPeriodLengthDays('bad', '2026-03-14')), true);
});

test('contiguity accepts adjacency and sorts its return', () => {
  const first = { starts_on: '2025-03-15', ends_on: '2026-03-14' };
  const second = { starts_on: '2026-03-15', ends_on: '2027-03-14' };
  assert.deepEqual(assertGbConfirmationReviewPeriodsContiguous([second, first]), [first, second]);
});

test('contiguity names a gap', () => {
  assert.throws(() => assertGbConfirmationReviewPeriodsContiguous([
    { starts_on: '2025-03-15', ends_on: '2026-03-14' },
    { starts_on: '2026-03-16', ends_on: '2027-03-15' }
  ]), hasCode('GB_CONFIRMATION_REVIEW_PERIOD_GAP', 409));
});

test('contiguity names an overlap', () => {
  assert.throws(() => assertGbConfirmationReviewPeriodsContiguous([
    { starts_on: '2025-03-15', ends_on: '2026-03-14' },
    { starts_on: '2026-03-14', ends_on: '2027-03-13' }
  ]), hasCode('GB_CONFIRMATION_REVIEW_PERIOD_OVERLAP', 409));
});

test('a single share class foots', () => {
  assert.deepEqual(assertGbStatementOfCapitalFoots(capital), { ...capital, currency: 'GBP' });
});

test('two share classes foot', () => {
  const preference = { class: 'Preference', shares_issued: 50, nominal_value_per_share: 2, aggregate_nominal_value: 100, currency: 'GBP' };
  const input = { share_classes: [ordinary, preference], total_issued_shares: 150, total_aggregate_nominal_value: 200 };
  assert.deepEqual(assertGbStatementOfCapitalFoots(input), { ...input, currency: 'GBP' });
});

test('capital refuses a class that does not foot', () => {
  assert.throws(() => assertGbStatementOfCapitalFoots({ ...capital, share_classes: [{ ...ordinary, aggregate_nominal_value: 99 }] }), hasCode('GB_STATEMENT_OF_CAPITAL_CLASS_UNBALANCED', 409));
});

test('capital refuses totals that do not foot', () => {
  assert.throws(() => assertGbStatementOfCapitalFoots({ ...capital, total_issued_shares: 99 }), hasCode('GB_STATEMENT_OF_CAPITAL_TOTALS_UNBALANCED', 409));
});

test('capital refuses empty classes and mixed currencies', () => {
  assert.throws(() => assertGbStatementOfCapitalFoots({ share_classes: [] }), hasCode('GB_STATEMENT_OF_CAPITAL_EMPTY', 422));
  assert.throws(() => assertGbStatementOfCapitalFoots({ ...capital, share_classes: [ordinary, { ...ordinary, currency: 'EUR' }] }), hasCode('GB_STATEMENT_OF_CAPITAL_MIXED_CURRENCY', 422));
});

test('SIC codes validate shape and count, and dedupe in order', () => {
  assert.deepEqual(assertGbSicCodes(['62012']), ['62012']);
  assert.deepEqual(assertGbSicCodes(['62012', '62020', '63110', '58290']), ['62012', '62020', '63110', '58290']);
  assert.deepEqual(assertGbSicCodes(['62012', '62012', '62020']), ['62012', '62020']);
  for (const value of [[], ['1', '2', '3', '4', '5'], ['6201']]) {
    assert.throws(() => assertGbSicCodes(value), hasCode('GB_CONFIRMATION_SIC_CODES_INVALID', 422));
  }
});

test('builds an owner-attestation draft with validated content', () => {
  const result = buildGbConfirmationStatement(validStatement);
  assert.equal(result.owner_confirmation_required, true);
  assert.deepEqual(result.content.sic_codes, ['62012']);
  assert.deepEqual(result.content.statement_of_capital, { ...capital, currency: 'GBP' });
  assert.equal(result.provenance_ref, 'GB_CONFIRMATION_STATEMENT_PROVENANCE');
});

test('builder refuses every missing required part by name', () => {
  const cases = [
    ['company_number', 'bad', 'GB_CONFIRMATION_COMPANY_NUMBER_INVALID'],
    ['review_period', undefined, 'GB_CONFIRMATION_REVIEW_PERIOD_NOT_ESTABLISHED'],
    ['registered_office', '', 'GB_CONFIRMATION_REGISTERED_OFFICE_MISSING'],
    ['registered_email', '', 'GB_CONFIRMATION_REGISTERED_EMAIL_MISSING'],
    ['officers', [], 'GB_CONFIRMATION_OFFICERS_MISSING'],
    ['psc_statement', undefined, 'GB_CONFIRMATION_PSC_STATEMENT_MISSING']
  ];
  for (const [key, value, code] of cases) {
    assert.throws(() => buildGbConfirmationStatement({ ...validStatement, [key]: value }), hasCode(code, 422));
  }
});

test('a company limited by guarantee may omit share capital', () => {
  const { statement_of_capital, ...withoutCapital } = validStatement;
  assert.equal(buildGbConfirmationStatement(withoutCapital).content.statement_of_capital, null);
});

test('config-plane flag is born off and enabled by an acting snapshot', () => {
  assert.equal(GB_CONFIRMATION_STATEMENT_FLAG_KEY, 'GB_CONFIRMATION_STATEMENT');
  assert.equal(gbConfirmationStatementEnabled({}), false);
  assert.equal(gbConfirmationStatementEnabled({ snapshot: { GB_CONFIRMATION_STATEMENT: { stage: 'auto' } } }), true);
});

test('all remembered rules remain in one unverified, noted provenance block', () => {
  assert.equal(GB_CONFIRMATION_STATEMENT_PROVENANCE.confirmedAgainstPrimary, false);
  assert.ok(GB_CONFIRMATION_STATEMENT_PROVENANCE.verificationNote);
  for (const rule of Object.values(GB_CONFIRMATION_STATEMENT_PROVENANCE.rules)) assert.ok(rule.note);
});
