// AE ae_vat_return deadline watch — pure-half invariants.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AE_VAT_RETURN_DEADLINE_LEAD_DAYS,
  aeVatReturnDeadlineAskId,
  aeVatReturnPeriodIntakeAskId,
  buildAeVatReturnDeadlineQuestion,
  buildAeVatReturnPeriodIntakeQuestion,
  classifyAeVatReturnPeriodDeadline
} from './vatReturnDeadlines.js';

const PERIOD = { periodKey: 'Apr-Jun 2026', startsOn: '2026-04-01', endsOn: '2026-06-30', dueOn: '2026-07-28' };

test('the flag key and lead window are pinned', () => {
  assert.equal(AE_VAT_RETURN_DEADLINE_LEAD_DAYS, 14);
});

test('classification: scheduled outside the lead window, due_soon at both boundary days, overdue past due', () => {
  assert.equal(classifyAeVatReturnPeriodDeadline({ period: PERIOD, asOf: '2026-07-13' }).state, 'scheduled');
  assert.deepEqual(classifyAeVatReturnPeriodDeadline({ period: PERIOD, asOf: '2026-07-14' }), { state: 'due_soon', daysUntilDue: 14 });
  assert.deepEqual(classifyAeVatReturnPeriodDeadline({ period: PERIOD, asOf: '2026-07-28' }), { state: 'due_soon', daysUntilDue: 0 });
  assert.deepEqual(classifyAeVatReturnPeriodDeadline({ period: PERIOD, asOf: '2026-07-29' }), { state: 'overdue', daysUntilDue: -1 });
});

test('classification reads snake_case rows from the store too', () => {
  assert.equal(classifyAeVatReturnPeriodDeadline({ period: { due_date: '2026-07-28' }, asOf: '2026-07-20' }).state, 'due_soon');
});

test('ask ids are deterministic: one per period, one intake per client-year', () => {
  assert.equal(
    aeVatReturnDeadlineAskId({ firmId: 'f1', clientId: 'c1', periodId: 'p1' }),
    'vat-return-deadline-f1-c1-p1'
  );
  assert.equal(
    aeVatReturnPeriodIntakeAskId({ firmId: 'f1', clientId: 'c1', year: 2026 }),
    'vat-return-period-intake-f1-c1-2026'
  );
});

test('a prepared due-soon question states the figures, the customs check, and who files', () => {
  const question = buildAeVatReturnDeadlineQuestion({
    period: PERIOD,
    classification: { state: 'due_soon', daysUntilDue: 10 },
    vatReturn: { netVat: 1250.5, outcome: 'payment' }
  });
  assert.match(question, /due 2026-07-28/);
  assert.match(question, /net VAT payable of AED 1250\.50/);
  assert.match(question, /customs-populated goods-imports figure/);
  assert.match(question, /I cannot file on your behalf/);
});

test('an overdue refund-position question names the overdue state and the refund', () => {
  const question = buildAeVatReturnDeadlineQuestion({
    period: PERIOD,
    classification: { state: 'overdue', daysUntilDue: -3 },
    vatReturn: { netVat: -400, outcome: 'refund' }
  });
  assert.match(question, /was due 2026-07-28 and is now overdue/);
  assert.match(question, /refund position of AED 400\.00/);
});

test('a blocked question carries the named refusal and asks for the missing piece', () => {
  const question = buildAeVatReturnDeadlineQuestion({
    period: PERIOD,
    classification: { state: 'due_soon', daysUntilDue: 5 },
    refusal: { code: 'AE_VAT_EMIRATE_NOT_ESTABLISHED', message: "Standard-rated supplies require the client's establishment emirate." }
  });
  assert.match(question, /cannot finish preparing it yet: Standard-rated supplies require/);
  assert.match(question, /I cannot file on your behalf/);
});

test('a scheduled classification never builds a question — the caller must not ask', () => {
  assert.equal(
    buildAeVatReturnDeadlineQuestion({ period: PERIOD, classification: { state: 'scheduled', daysUntilDue: 30 } }),
    null
  );
  assert.equal(buildAeVatReturnDeadlineQuestion({ period: PERIOD }), null);
});

test('the intake question says why Donna cannot see the periods and what to reply with', () => {
  const question = buildAeVatReturnPeriodIntakeQuestion();
  assert.match(question, /FTA assigns your VAT return periods and due dates individually/);
  assert.match(question, /start and end dates.*due date/);
});
