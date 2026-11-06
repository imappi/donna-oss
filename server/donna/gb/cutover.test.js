import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGbOpeningBalanceIntake } from './cutover.js';
import { resolveGbOpeningBalanceInbound, GB_OPENING_BALANCE_ASK_KIND } from './openingBalanceRoute.js';

const chart = [
  { code: 'B1', name: 'Bank', account_type: 'bank', normal_balance: 'debit', canonical_role: 'asset.cash' },
  { code: 'E1', name: 'Retained earnings', account_type: 'equity', normal_balance: 'credit', canonical_role: 'equity.retained_earnings' }
];
const intake = { as_of: '2026-04-01', fiscal_period_id: 'fy-gb-1', chart, declaredLines: [{ canonical_role: 'asset.cash', debit: 100, credit: 0 }, { canonical_role: 'equity.retained_earnings', debit: 0, credit: 100 }] };

test('GBP intake maps only unique canonical roles and never account names or default codes', () => {
  const result = normalizeGbOpeningBalanceIntake(intake);
  assert.equal(result.terminal, 'proposal');
  assert.deepEqual(result.proposal.openingLines.map((line) => line.account.code), ['B1', 'E1']);
  const ambiguous = normalizeGbOpeningBalanceIntake({ ...intake, chart: [...chart, { ...chart[0], code: 'B2' }] });
  assert.equal(ambiguous.code, 'GB_OPENING_BALANCE_CANONICAL_ROLE_REQUIRED');
});

test('a sole-trader opening balance lands owner capital on its own role beside retained earnings', () => {
  const soleTraderChart = [
    ...chart,
    { code: 'E2', name: 'Owner capital introduced', account_type: 'equity', normal_balance: 'credit', canonical_role: 'equity.owner_capital' }
  ];
  const result = normalizeGbOpeningBalanceIntake({
    ...intake,
    chart: soleTraderChart,
    declaredLines: [
      { canonical_role: 'asset.cash', debit: 100, credit: 0 },
      { canonical_role: 'equity.owner_capital', debit: 0, credit: 60 },
      { canonical_role: 'equity.retained_earnings', debit: 0, credit: 40 }
    ]
  });
  assert.equal(result.terminal, 'proposal');
  assert.deepEqual(result.proposal.openingLines.map((line) => line.account.code), ['B1', 'E2', 'E1']);
});

test('unknown statutory carry-forward facts refuse rather than guess', () => {
  assert.throws(() => normalizeGbOpeningBalanceIntake({ statutoryCarryForwards: [{ kind: 'corporation_tax_loss', amount_gbp: 10 }] }), (error) => error.code === 'GB_CUTOVER_RULE_UNCONFIRMED');
});

test('owner lifecycle keeps exactly one ask and resolves posted, cancelled, and stale answers', async () => {
  const created = []; const resolved = []; const posted = [];
  const deps = { actorId: 'owner-1', authorityBasis: { source: 'owner_confirmation', providerMessageId: 'msg-1', phoneHash: 'phone-1' }, createAsk: async (row) => { created.push(row); return { id: `ask-${created.length}`, ...row }; }, resolveAsk: async (row) => resolved.push(row), postImpl: async (row) => { posted.push(row); return { journal_id: 'journal-1' }; } };
  const original = { id: 'ask-1', evidence_type: GB_OPENING_BALANCE_ASK_KIND, request_payload: { kind: GB_OPENING_BALANCE_ASK_KIND } };
  const proposed = await resolveGbOpeningBalanceInbound({ firmId: 'firm-1', clientId: 'client-1', ask: original, intake, ...deps });
  assert.equal(proposed.action, 'request_confirmation');
  assert.equal(resolved.at(-1).resolutionNote, 'gb_opening_balance_confirmation_requested');
  const confirmed = await resolveGbOpeningBalanceInbound({ firmId: 'firm-1', clientId: 'client-1', ask: proposed.ask, replyText: 'yes', currentFiscalPeriodId: 'fy-gb-1', ...deps });
  assert.equal(confirmed.action, 'confirm_and_post');
  assert.equal(posted.length, 1);
  assert.equal(resolved.at(-1).resolutionNote, 'gb_opening_balance_posted');
  const cancelled = await resolveGbOpeningBalanceInbound({ firmId: 'firm-1', clientId: 'client-1', ask: original, replyText: 'cancel', ...deps });
  assert.equal(cancelled.action, 'cancelled');
  assert.equal(resolved.at(-1).resolutionNote, 'gb_opening_balance_cancelled');
  const stale = await resolveGbOpeningBalanceInbound({ firmId: 'firm-1', clientId: 'client-1', ask: proposed.ask, replyText: 'yes', currentFiscalPeriodId: 'fy-new', ...deps });
  assert.equal(stale.action, 'stale');
  assert.equal(resolved.at(-1).resolutionNote, 'gb_opening_balance_stale');
});
