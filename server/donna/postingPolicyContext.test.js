import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { isFenceContention, isUnexpectedFailure } from './db/codingPolicyContext.js';
import { assertPostingSuggestionLineage, assertPostingContextReceipt, resolvePostingContextWithClient, postingSourceReceipt, assertPostingSourceReceipt } from './db/postingPolicyContext.js';

const judged = resolveCodingPolicy({ jurisdiction: 'gb', businessDate: '2026-09-04' });
const current = resolveCodingPolicy({ jurisdiction: 'ae', businessDate: '2026-09-05' });
const context = { codingPolicy: current };
const staleSuggestion = {
  proposed_account: 'Office expenses', tax_treatment: 'NO_VAT',
  coding_policy: codingPolicyReceipt(judged)
};

const refusesStale = (transaction) => assert.throws(
  () => assertPostingSuggestionLineage(context, transaction),
  (error) => error.code === 'jurisdiction_context_conflict',
  'a changed display/coding field is not proof of an attributable human correction'
);

test('posting refuses stale AI lineage even when a pre-existing category or effective tax differs', () => {
  for (const fields of [
    {}, { category: 'Uncategorized' }, { proposed_account: 'Different account' },
    { account_name: 'Different account' }, { xero_account_name: 'Different account' },
    { tax_treatment: 'STANDARD_5' }, { category: 'Different account', tax_treatment: 'STANDARD_5' }
  ]) {
    refusesStale({ ai_suggestion: staleSuggestion, ...fields });
  }
});

test('the current accepted policy receipt permits an explicit correction without rewriting the historical AI suggestion', () => {
  const transaction = {
    category: 'Different account', tax_treatment: 'STANDARD_5', ai_suggestion: staleSuggestion,
    accepted_coding_policy: codingPolicyReceipt(current)
  };
  const before = structuredClone(transaction);
  assert.doesNotThrow(() => assertPostingSuggestionLineage(context, transaction));
  assert.deepEqual(transaction, before, 'lineage validation does not rewrite historical judgment');
});

test('an old or wrong accepted policy receipt cannot disarm current policy validation', () => {
  const currentReceipt = codingPolicyReceipt(current);
  for (const accepted of [
    codingPolicyReceipt(judged),
    { ...currentReceipt, jurisdiction: 'gb' },
    { ...currentReceipt, businessDate: '2026-09-04' },
    {}
  ]) {
    refusesStale({ ai_suggestion: staleSuggestion, accepted_coding_policy: accepted, category: 'Different account' });
    refusesStale({ accepted_coding_policy: accepted, category: 'Different account' });
  }
});

test('persisted identity, base configuration and cohort SQL failures become typed recoverable policy failures', async () => {
  for (const failedRead of ['from clients', 'from client_capability_config', 'from cohort_capability_config']) {
    const client = { query: async (sql) => {
      if (sql.includes(failedRead)) throw Object.assign(new Error('Read unavailable'), { code: '08006' });
      if (sql.includes('from clients')) return { rows: [{ jurisdiction: 'gb', profile: {} }] };
      return { rows: [] };
    } };
    await assert.rejects(() => resolvePostingContextWithClient({ client, firmId: 'fixture-firm', clientId: 'fixture-client', businessDate: '2026-09-05' }),
      (error) => error.code === 'coding_policy_unavailable' && error.details.cause === '08006');
  }
});

test('a transient database condition at the posting context is passed through as itself, never a policy failure', async () => {
  for (const code of ['55P03', '40001', '40P01']) {
    const client = { query: async (sql) => {
      if (sql.includes('from clients')) throw Object.assign(new Error('transient'), { code });
      return { rows: [] };
    } };
    await assert.rejects(() => resolvePostingContextWithClient({ client, firmId: 'fixture-firm', clientId: 'fixture-client', businessDate: '2026-09-05' }),
      (error) => error.code === code && error.statusCode === 409 && error.retryable === true);
  }
});

test('one classifier: transient conditions, named refusals and unexpected failures are told apart', () => {
  for (const code of ['55P03', '40001', '40P01']) assert.equal(isFenceContention({ code }), true);
  for (const code of ['23505', '08006', 'LEDGER_LOCKED_PERIOD_IMMUTABLE', undefined]) assert.equal(isFenceContention({ code }), false);
  for (const error of [new TypeError('bug'), { code: '23514' }, { code: 'XX000' }, { code: 'ECONNRESET', errno: -104, syscall: 'read' }, { code: '' }])
    assert.equal(isUnexpectedFailure(error), true, JSON.stringify(error));
  for (const code of ['LEDGER_LOCKED_PERIOD_IMMUTABLE', 'posting_policy_invalid', 'jurisdiction_unresolved', 'TRANSACTION_ALV_TREATMENT_UNRESOLVED', 'CODING_CORRECTION_AUTHORITY_REQUIRED'])
    assert.equal(isUnexpectedFailure({ code }), false, code);
});

test('missing persisted identity keeps its owner-fact error instead of being disguised as a configuration outage', async () => {
  const client = { query: async () => ({ rows: [] }) };
  await assert.rejects(() => resolvePostingContextWithClient({ client, firmId: 'fixture-firm', clientId: 'fixture-client' }),
    (error) => error.code === 'jurisdiction_unresolved');
});

test('revoked settlement admission invalidates the prepared posting receipt before a coding swap', async () => {
  for (const flag of ['FINLAND_AR_SETTLEMENT', 'FINLAND_EINVOICE_RECEIVE']) {
    let acts = true;
    const client = { query: async (sql) => {
      if (sql.includes('from clients')) return { rows: [{ jurisdiction: 'fi', profile: { accounting_system: 'none' } }] };
      if (sql.includes('from client_capability_config')) return { rows: [{ flag_key: flag, stage: acts ? 'auto' : 'off', client_id: 'fixture-client' }] };
      return { rows: [] };
    } };
    const args = { client, firmId: 'fixture-firm', clientId: 'fixture-client', businessDate: '2026-09-05' };
    const prepared = await resolvePostingContextWithClient(args);
    acts = false;
    const current = await resolvePostingContextWithClient(args);
    assert.throws(() => assertPostingContextReceipt(current, prepared.receipt),
      (error) => error.code === 'jurisdiction_context_conflict' && error.details.reason === 'posting_policy_receipt_conflict');
  }
});


test('prepared posting source receipt covers every effective account field consumed by the writeback builder', () => {
  const transaction = { id: 'tx', client_id: 'client', date: '2026-09-05', money_out: 100,
    account_code: '6100', category: 'Professional fees', coding_state: 'applied' };
  const receipt = postingSourceReceipt(transaction);
  for (const field of ['account_name', 'account_label', 'xero_account_id', 'xero_account_code', 'xero_account_name']) {
    assert.throws(() => assertPostingSourceReceipt({ ...transaction, [field]: 'changed' }, receipt),
      (error) => error.code === 'jurisdiction_context_conflict', `${field} changes the effective coding`);
  }
});


test('source receipt pins bank selection hints and both currency homes', () => {
  const tx = { id: 'source', date: '2026-09-05', currency: 'GBP', account_currency: 'GBP' };
  const receipt = postingSourceReceipt(tx);
  for (const field of ['xero_bank_account_code', 'xeroBankAccountCode', 'bank_account_code', 'bankAccountCode',
    'source_account_code', 'sourceAccountCode', 'xero_bank_account_id', 'xeroBankAccountId',
    'bank_account_id', 'bankAccountId', 'currency', 'account_currency']) {
    assert.throws(() => assertPostingSourceReceipt({ ...tx, [field]: 'changed' }, receipt),
      (error) => error.details?.reason === 'posting_source_changed', field);
  }
});
