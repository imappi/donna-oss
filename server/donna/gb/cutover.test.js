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

test('GB opening-balance owner questions follow the owner language; English and the reply word unchanged', async () => {
  const run = async (args) => {
    const created = [];
    const deps = { actorId: 'owner-1', createAsk: async (row) => { created.push(row); return { id: 'ask-next', ...row }; }, resolveAsk: async () => {} };
    const original = { id: 'ask-1', evidence_type: GB_OPENING_BALANCE_ASK_KIND, request_payload: { kind: GB_OPENING_BALANCE_ASK_KIND } };
    const result = await resolveGbOpeningBalanceInbound({ firmId: 'firm-1', clientId: 'client-1', ask: original, ...deps, ...args });
    return { result, question: created[0].question };
  };
  // Confirm request: a Finnish owner read the English line before this change.
  assert.equal((await run({ intake })).question, 'Please confirm this GBP opening trial balance by replying “yes”.');
  const fiConfirm = await run({ intake, language: 'fi' });
  assert.equal(fiConfirm.question, 'Vahvista tämä avaava tase (GBP) vastaamalla “yes”.');
  // The word the Finnish line invites is the word the route reads.
  const invited = fiConfirm.question.match(/“([^”]+)”/u)[1];
  const posted = [];
  const confirmed = await resolveGbOpeningBalanceInbound({
    firmId: 'firm-1', clientId: 'client-1', ask: fiConfirm.result.ask, replyText: invited, currentFiscalPeriodId: 'fy-gb-1', language: 'fi',
    actorId: 'owner-1', authorityBasis: { source: 'owner_confirmation', providerMessageId: 'msg-1', phoneHash: 'phone-1' },
    resolveAsk: async () => {}, postImpl: async (row) => { posted.push(row); return { journal_id: 'journal-1' }; }
  });
  assert.equal(confirmed.action, 'confirm_and_post');
  assert.equal(posted.length, 1);

  // Intake questions: the inbound path sends no intake, so the declaration ask.
  assert.equal((await run({})).question, 'Please provide the GBP opening trial balance with each line mapped to a canonical role.');
  assert.equal((await run({ language: 'fi' })).question, 'Lähetä avaava tase punnissa (GBP) niin, että jokainen rivi on liitetty tilin rooliin.');
  const ambiguous = { ...intake, chart: [...chart, { ...chart[0], code: 'B2' }] };
  assert.equal((await run({ intake: ambiguous })).question, 'Please map one account for each missing or ambiguous role: asset.cash.');
  assert.equal((await run({ intake: ambiguous, language: 'fi' })).question, 'Liitä yksi tili jokaiseen puuttuvaan tai epäselvään rooliin: asset.cash.');
  const mismatched = { ...intake, chart: [...chart, { code: 'R1', name: 'Debtors', account_type: 'asset', normal_balance: 'debit', canonical_role: 'asset.accounts_receivable' }], declaredLines: [...intake.declaredLines, { canonical_role: 'asset.accounts_receivable', debit: 0, credit: 0 }], openReceivables: [{ amount_gbp: 12.5 }] };
  assert.equal((await run({ intake: mismatched })).question, 'Please reconcile the open_receivables difference of GBP 12.50.');
  const fiMismatch = await run({ intake: mismatched, language: 'fi' });
  assert.equal(fiMismatch.question, 'Täsmäytä kohdan open_receivables erotus, 12,50 GBP.');
  // The persisted verdict is the same in both languages.
  assert.equal(fiMismatch.result.verdict.code, 'GB_OPENING_BALANCE_CONTROL_MISMATCH');
});
