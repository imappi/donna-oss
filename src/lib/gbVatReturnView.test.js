import assert from 'node:assert/strict'; import test from 'node:test';
import { buildGbVatReturnViewModel, ownerVatReturnCardState } from './gbVatReturnView.js';
test('nine-box GB return renders digit keys, due/repayment, and filing honesty', () => { const base = { period: { periodKey: '24A1', startsOn: '2026-01-01', endsOn: '2026-03-31', dueOn: '2026-05-07' }, vatReturn: { boxes: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), i + 1])), outcome: 'repayment', netVat: -4 } }; const view = buildGbVatReturnViewModel(base); assert.equal(view.boxRows.length, 9); assert.equal(view.boxRows[4].display, '£5.00'); assert.equal(view.outcomeLabel, 'Repayment £4.00'); assert.match(view.honesty, /filing not connected/i); });
test('incomplete return refuses honestly', () => { assert.equal(buildGbVatReturnViewModel({ period: {}, vatReturn: { boxes: {} } }).status, 'refused'); });

test('owner card: dark surface and null envelope render nothing', () => {
  assert.equal(ownerVatReturnCardState(null), null);
  assert.equal(ownerVatReturnCardState({ surface_acts: false, prepared: null, refusal: null }), null);
});

test('owner card: a prepared return renders, carrying the full nine-box view', () => {
  const prepared = { period: { periodKey: '24A1', startsOn: '2026-01-01', endsOn: '2026-03-31', dueOn: '2026-05-07' }, vatReturn: { boxes: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), 0])), outcome: 'due', netVat: 0 } };
  const card = ownerVatReturnCardState({ surface_acts: true, prepared, refusal: null });
  assert.equal(card.kind, 'prepared');
  assert.equal(card.view.boxRows.length, 9);
});

test('owner card: owner-fact refusals surface as honest blockers, internal ones render nothing', () => {
  const blocked = ownerVatReturnCardState({ surface_acts: true, prepared: null, refusal: { code: 'GB_VAT_REGISTRATION_NOT_ESTABLISHED' } });
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.message, /VAT registration status/);
  const partial = ownerVatReturnCardState({ surface_acts: true, prepared: null, refusal: { code: 'GB_VAT_REGISTRATION_PARTIAL_PERIOD' } });
  assert.equal(partial.kind, 'blocked');
  for (const code of ['GB_VAT_RETURN_NOT_REGISTERED_FOR_PERIOD', 'GB_VAT_PERIOD_NOT_ESTABLISHED', 'GB_VAT_TREATMENT_NOT_ESTABLISHED', 'GB_VAT_RETURN_MISFOOT_BOX_3']) {
    assert.equal(ownerVatReturnCardState({ surface_acts: true, prepared: null, refusal: { code } }), null, code);
  }
});
