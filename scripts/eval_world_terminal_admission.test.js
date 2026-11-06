import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTerminalAdmission } from './eval_world_terminal_admission.js';

const grant = (overrides = {}) => ({
  action: 'accept_match', status: 'active', correction_count: 0,
  amount_ceiling: '1000', currency: 'GBP', valid_from: '2026-01-01T00:00:00Z',
  expires_at: null, review_after: null, ...overrides,
});
const authorityContext = { matchAmount: 100, currency: 'GBP', action: 'accept_match', asOf: new Date('2026-08-19T00:00:00Z') };
const ask = (itemId = 'item-1') => ({ id: 'ask-1', owner_type: 'client', status: 'open', affected_item_ids: [itemId] });
const base = (overrides = {}) => ({
  itemId: 'item-1', confidence: 0.95, targetState: {}, authorityGrant: grant(), authorityContext,
  period: { locked: false, label: '2026-08', journal_date: '2026-08-19' },
  persisted: { reconciliationStatus: 'explained' }, ...overrides,
});

test('admits a confident, authorized, open-period production projection to auto-post', async () => {
  const result = await evaluateTerminalAdmission(base());
  assert.equal(result.verdict, 'auto_post');
  assert.equal(result.terminal_state, 'auto_reconciled');
  assert.deepEqual(result.invariants_checked, ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']);
  assert.deepEqual(result.production_proof, { status: 'pending', dependency: 'Unit 40' });
});

test('admits a genuine open client ask as the only non-post resting state', async () => {
  const result = await evaluateTerminalAdmission(base({
    confidence: 0.5, ownerAsk: ask(), persisted: {},
  }));
  assert.equal(result.verdict, 'owner_open');
  assert.equal(result.terminal_state, 'on_owner');
  assert.equal(result.owner_ask_id, 'ask-1');
});

test('pins authority refusal on the owner rather than firm-side limbo', async () => {
  const result = await evaluateTerminalAdmission(base({
    authorityGrant: grant({ status: 'suspended' }), ownerAsk: ask(), persisted: {},
  }));
  assert.equal(result.verdict, 'authority_refusal');
  assert.equal(result.authority, 'refused');
  assert.equal(result.terminal_state, 'on_owner');
});

test('the firmDb statutory period guard refuses a locked-period post', async () => {
  const result = await evaluateTerminalAdmission(base({
    period: { locked: true, label: '2026-08', journal_date: '2026-08-19' },
    ownerAsk: ask(), persisted: {},
  }));
  assert.equal(result.verdict, 'locked_period_refusal');
  assert.equal(result.period, 'locked');
  assert.equal(result.preflight.status, 'fail');
  assert.equal(result.terminal_state, 'on_owner');
});

for (const invalidAsk of [
  null,
  { id: 'ask-1', owner_type: 'firm', status: 'open', affected_item_ids: ['item-1'] },
  { id: 'ask-1', owner_type: 'client', status: 'resolved', affected_item_ids: ['item-1'] },
  { id: 'ask-1', owner_type: 'client', status: 'open', affected_item_ids: ['another-item'] },
]) {
  test('no third resting state is representable by a refusal snapshot', async () => {
    await assert.rejects(
      evaluateTerminalAdmission(base({ authorityGrant: null, ownerAsk: invalidAsk, persisted: {} })),
      /cannot rest without a real open owner ask/,
    );
  });
}

for (const disposition of ['needs_human', 'chase_receipt']) {
  test(`does not settle caller/firm-labelled ${disposition}`, async () => {
    await assert.rejects(
      evaluateTerminalAdmission(base({ authorityGrant: null, persisted: { disposition } })),
      new RegExp(`projection=hanging`),
    );
  });
}

test('caller-labelled T2 is ignored rather than admitted', async () => {
  await assert.rejects(
    evaluateTerminalAdmission(base({ authorityGrant: null, terminal_state: 'T2', persisted: {} })),
    /cannot rest without a real open owner ask/,
  );
});
