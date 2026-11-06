import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeForm1099NecReadiness,
  evaluateForm1099NecFromDb,
  form1099NecCalendar,
  FORM_1099_NEC_THRESHOLD_USD,
  MISSING_FACT_KEYS,
  MISSING_FACT_PROMPTS
} from './form1099Nec.js';

const line = (over = {}) => ({
  posted: true,
  calendar_year: 2025,
  currency: 'USD',
  party_id: 'p1',
  amount: 600,
  transaction_id: 'tx1',
  ...over
});

const lines = [line()];

const contractor = (over = {}) => ({
  id: 'p1',
  display_name: 'Pat',
  detail: { contractor_classification_verdict: 'independent contractor', ...over }
});

test('calendar rolls a weekend January 31 to the next weekday, and says so', () => {
  const out = form1099NecCalendar(2025); // 2026-01-31 is a Saturday
  assert.equal(out.recipient_copy_due_on, '2026-02-02');
  assert.equal(out.irs_due_on, out.recipient_copy_due_on);
  assert.equal(out.date_posture, 'weekend_rolled_federal_holidays_not_applied');
  assert.equal(out.provenance.asOf, '2026-07-27');
});

test('calendar leaves a weekday January 31 alone', () => {
  assert.equal(form1099NecCalendar(2023).recipient_copy_due_on, '2024-01-31'); // Wednesday
});

test('an invalid calendar year refuses', () => {
  assert.throws(() => form1099NecCalendar('soon'), { code: 'US_1099_YEAR_INVALID' });
  assert.throws(() => form1099NecCalendar(1999), { code: 'US_1099_YEAR_INVALID' });
});

// $600 "or more" — the boundary is the single most consequential number here.
test('the $600 threshold includes exactly $600 and excludes $599.99', () => {
  assert.equal(FORM_1099_NEC_THRESHOLD_USD, 600);
  const at = computeForm1099NecReadiness({
    calendarYear: 2025, ledgerLines: [line({ amount: 600 })], parties: [contractor()]
  });
  assert.equal(at.payees.length, 1);
  const under = computeForm1099NecReadiness({
    calendarYear: 2025, ledgerLines: [line({ amount: 599.99 })], parties: [contractor()]
  });
  assert.deepEqual(under.payees, []);
});

test('payments aggregate across lines before the threshold is applied', () => {
  const out = computeForm1099NecReadiness({
    calendarYear: 2025,
    ledgerLines: [line({ amount: 300.005 }), line({ amount: 300 })],
    parties: [contractor()]
  });
  assert.equal(out.payees.length, 1);
  assert.equal(out.payees[0].reportable_payments_usd, 600.01);
});

test('unposted, non-USD, other-year and payee-less lines are not reportable evidence', () => {
  const out = computeForm1099NecReadiness({
    calendarYear: 2025,
    ledgerLines: [
      line({ posted: false, amount: 5000 }),
      line({ currency: 'EUR', amount: 5000 }),
      line({ calendar_year: 2024, amount: 5000 }),
      line({ party_id: '', amount: 5000 })
    ],
    parties: [contractor()]
  });
  assert.deepEqual(out.payees, []);
});

test('a contractor missing tax details lands on the owner, with human copy', () => {
  const out = computeForm1099NecReadiness({
    calendarYear: 2025, ledgerLines: lines, parties: [contractor()]
  });
  const payee = out.payees[0];
  assert.equal(payee.classification, 'contractor');
  assert.equal(payee.status, 'owner_ask_required');
  assert.deepEqual(payee.missing_facts, ['w9', 'tin', 'address']);
  // Owner copy never leaks machine field names. ('address' is also an ordinary
  // English word, so the check is for snake_case tokens and the bare
  // comma-joined key list — the shapes only a machine would write.)
  assert.ok(!/[a-z]+_[a-z]+/.test(payee.owner_ask), payee.owner_ask);
  assert.ok(!payee.owner_ask.includes(payee.missing_facts.join(', ')));
  assert.ok(!payee.owner_ask.includes('w9'));
  assert.ok(payee.owner_ask.includes('Pat'));
  assert.ok(payee.owner_ask.includes(MISSING_FACT_PROMPTS.w9));
});

test('a fully-documented contractor is ready with no owner ask', () => {
  const out = computeForm1099NecReadiness({
    calendarYear: 2025,
    ledgerLines: lines,
    parties: [contractor({ w9_status: 'received', tin: '12-3456789', address: '1 Main St' })]
  });
  assert.equal(out.payees[0].status, 'ready');
  assert.deepEqual(out.payees[0].missing_facts, []);
  assert.equal(out.payees[0].owner_ask, null);
});

test('a persisted not-contractor verdict is terminal, not an owner ask', () => {
  const out = computeForm1099NecReadiness({
    calendarYear: 2025,
    ledgerLines: lines,
    parties: [{ id: 'p1', display_name: 'Pat', detail: { classification_verdict: 'W-2 employee' } }]
  });
  assert.equal(out.payees[0].classification, 'not_contractor');
  assert.equal(out.payees[0].status, 'handled_not_reportable');
  assert.equal(out.payees[0].owner_ask, null);
});

// The fact-vs-knowledge fork: an unclassified payee is asked how they WORKED,
// never asked to render the classification verdict themselves.
test('an unclassified payee is asked for relationship facts, not for the verdict', () => {
  const out = computeForm1099NecReadiness({
    calendarYear: 2025,
    ledgerLines: [line({ description: '1099 contractor payment' })],
    parties: [{ id: 'p1', display_name: 'Pat' }]
  });
  const payee = out.payees[0];
  assert.equal(payee.classification, 'unknown'); // never inferred from the description
  assert.deepEqual(payee.missing_facts, ['working_relationship']);
  assert.ok(payee.owner_ask.includes('who set their hours'));
  assert.ok(!/contractor or employee/i.test(payee.owner_ask));
  assert.ok(!/classif/i.test(payee.owner_ask));
});

test('every missing-fact key has owner-facing prompt copy', () => {
  for (const key of MISSING_FACT_KEYS) {
    assert.equal(typeof MISSING_FACT_PROMPTS[key], 'string');
    assert.ok(MISSING_FACT_PROMPTS[key].length > 0);
  }
});

test('the I/O route is dark until the flag acts, and uses the injected ask writer', async () => {
  let calls = 0;
  const io = {
    firmId: 'f',
    clientId: 'c',
    calendarYear: 2025,
    readLedgerLines: async () => lines,
    readParties: async () => [{ id: 'p1' }],
    createEvidenceRequest: async (ask) => { calls++; return ask; },
    actorId: 'owner-1'
  };
  const dark = await evaluateForm1099NecFromDb(io);
  assert.equal(dark.action, 'skipped');
  assert.equal(dark.reason, 'flag_off');
  assert.equal(calls, 0);

  const out = await evaluateForm1099NecFromDb({ ...io, flagActs: true });
  assert.equal(calls, 1);
  assert.equal(out.action, 'evaluated');
  assert.equal(out.asks[0].transactionId, 'tx1');
  assert.equal(out.asks[0].evidenceType, 'contractor_tax_details');
  assert.equal(out.asks[0].actorId, 'owner-1');
});

// Atomicity: a missing anchor must refuse the WHOLE evaluation. A partially
// written batch would leave some owner questions live and the rest silently
// dropped — neither terminal.
test('a payee with no anchoring transaction refuses before any ask is written', async () => {
  let calls = 0;
  const anchorless = [
    line({ party_id: 'p1', transaction_id: 'tx1' }),
    line({ party_id: 'p2', transaction_id: null })
  ];
  await assert.rejects(
    () => evaluateForm1099NecFromDb({
      firmId: 'f',
      clientId: 'c',
      calendarYear: 2025,
      flagActs: true,
      readLedgerLines: async () => anchorless,
      readParties: async () => [{ id: 'p1' }, { id: 'p2' }],
      createEvidenceRequest: async (ask) => { calls++; return ask; },
      actorId: 'owner-1'
    }),
    { code: 'US_1099_ASK_ANCHOR_REQUIRED', partyId: 'p2' }
  );
  assert.equal(calls, 0, 'no ask may be written when any anchor is missing');
});
