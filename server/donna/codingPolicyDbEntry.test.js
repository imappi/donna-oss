import assert from 'node:assert/strict';
import test from 'node:test';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { getClientAccountOptionsFromDb, resolveClientCodingPolicyWithClient, suggestTransactionCodingInDb, updateTransactionReviewItemInDb } from './db/coding.js';
import { getClientChatProfileFromDb, getClientJurisdictionForEnrichment } from './db/clients.js';
import { __recodeTransactionAfterClientReplyWithClient } from './db/asks.js';
import { readClientConfigSnapshot } from './clientConfig.js';

const fixture = ({ jurisdiction = 'gb', profile = {}, configError = false, synced = false } = {}) => {
  const calls = [];
  const row = { id: 'client', company_name: 'Policy fixture', jurisdiction, profile };
  const tx = { id: 'tx', client_id: 'client', transaction_date: '2026-01-12', coding_state: 'proposed', payload: {} };
  const client = {
    release() {},
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('from client_capability_config')) {
        if (configError) throw Object.assign(new Error('config unavailable'), { code: '42P01' });
        return { rows: [{ flag_key: 'FINLAND_ALV_CODING', stage: 'auto', client_id: 'client' }] };
      }
      if (text.includes('from cohort_capability_config')) return { rows: [] };
      if (text.includes('from clients')) return { rows: [row] };
      if (text.includes('from xero_accounts')) return { rows: synced ? [{ id: 'a', name: 'External expenses', code: '400' }] : [] };
      if (text.includes('from transaction_review_queue')) return { rows: [{ id: 'review', item_type: 'transaction', item_id: 'tx', client_id: 'client', status: 'open', payload: {} }] };
      if (text.includes('from transactions')) return { rows: [tx] };
      if (text.includes('insert into audit_events')) return { rows: [{ id: String(calls.length), action: params[2], resource_id: params[3], metadata: typeof params[4] === 'string' && params[4].startsWith('{') ? JSON.parse(params[4]) : {} }] };
      return { rows: [] };
    }
  };
  return { client, calls, row, tx };
};
const install = (f) => __setFirmDbPoolForTests({ connect: async () => f.client, query: (...args) => f.client.query(...args) });
const noAccountingWrites = (calls) => assert.equal(calls.some(({ text }) => /(?:update|insert into) (?:transactions|transaction_review_queue|ledger_)/i.test(text)), false);

test('persisted jurisdiction owns all six policies despite foreign rollout flags', async () => {
  for (const jurisdiction of ['sg', 'fi', 'gb', 'ae', 'us', 'au']) {
    const f = fixture({ jurisdiction });
    const policy = await resolveClientCodingPolicyWithClient({ client: f.client, firmId: 'firm', clientId: 'client', jurisdiction: 'fi' });
    assert.equal(policy.jurisdiction, jurisdiction);
    assert.equal(policy.status, 'resolved');
  }
});

test('configuration read keeps legacy soft mode but strict mode preserves the failure', async () => {
  const f = fixture({ configError: true });
  assert.deepEqual(await readClientConfigSnapshot(f.client, { firmId: 'firm', clientId: 'client' }), {});
  await assert.rejects(readClientConfigSnapshot(f.client, { firmId: 'firm', clientId: 'client', strict: true }), { code: '42P01' });
  await assert.rejects(resolveClientCodingPolicyWithClient({ client: f.client, firmId: 'firm', clientId: 'client' }), { code: 'coding_policy_unavailable' });
});

test('synced chart menu still requires policy and does not choose a foreign suspense name', async () => {
  const f = fixture({ jurisdiction: 'fi', synced: true }); install(f);
  try {
    const menu = await getClientAccountOptionsFromDb({ firmId: 'firm', clientId: 'client' });
    assert.ok(menu.includes('External expenses'));
    const firstClientRead = f.calls.findIndex(({ text }) => text.includes('from clients'));
    const chartRead = f.calls.findIndex(({ text }) => text.includes('from xero_accounts'));
    assert.ok(firstClientRead >= 0 && firstClientRead < chartRead);
  } finally { __resetFirmDbPoolForTests(); }
});

test('menu, chat, single suggestion and reply recode refuse conflicting identity before provider or accounting effects', async () => {
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error('provider must remain untouched'); };
  try {
    for (const operation of ['menu', 'chat', 'single', 'reply']) {
      const f = fixture({ jurisdiction: 'gb', profile: { jurisdiction: 'sg' }, synced: true }); install(f);
      const run = operation === 'menu' ? () => getClientAccountOptionsFromDb({ firmId: 'firm', clientId: 'client' })
        : operation === 'chat' ? () => getClientChatProfileFromDb({ firmId: 'firm', clientId: 'client' })
          : operation === 'single' ? () => suggestTransactionCodingInDb({ firmId: 'firm', transactionId: 'tx' })
            : () => __recodeTransactionAfterClientReplyWithClient({ client: f.client, firmId: 'firm', clientId: 'client', transactionId: 'tx', suggestFn: async () => { providerCalls += 1; } });
      await assert.rejects(run, { code: 'jurisdiction_context_conflict' }, operation);
      noAccountingWrites(f.calls);
      assert.ok(f.calls.some(({ text, params }) => text.includes('insert into audit_events') && params[2] === 'transaction.coding.policy_failed'), `${operation} has durable incident`);
      __resetFirmDbPoolForTests();
    }
    assert.equal(providerCalls, 0);
  } finally { globalThis.fetch = originalFetch; __resetFirmDbPoolForTests(); }
});

test('named review Apply rejects foreign tax and records failure after rollback', async () => {
  const f = fixture({ jurisdiction: 'gb' }); install(f);
  try {
    await assert.rejects(() => updateTransactionReviewItemInDb({ firmId: 'firm', reviewItemId: 'review', patch: { review_state: 'accepted', proposed_account: 'Office expenses', tax_treatment: 'GST 9%' }, returnSnapshot: false }), { code: 'coding_policy_invalid' });
    noAccountingWrites(f.calls);
    const rollback = f.calls.findIndex(({ text }) => text === 'rollback');
    const receipt = f.calls.findIndex(({ text, params }) => text.includes('insert into audit_events') && params[2] === 'transaction.coding.policy_failed');
    assert.ok(rollback >= 0 && receipt > rollback, 'rollback cannot erase the policy incident');
  } finally { __resetFirmDbPoolForTests(); }
});

test('reply decision cannot overwrite a terminal line or apply a stale business date', async () => {
  const { codingPolicyReceipt } = await import('./codingPolicy.js');
  for (const change of ['terminal', 'date']) {
    const f = fixture({ jurisdiction: 'gb' });
    const operation = () => __recodeTransactionAfterClientReplyWithClient({
      client: f.client, firmId: 'firm', clientId: 'client', transactionId: 'tx',
      suggestFn: async ({ clientProfile }) => {
        const result = { source: 'openai', proposed_account: 'Office expenses', confidence: 'high', evidence_required: false,
          tax_treatment: clientProfile.codingPolicy.taxTreatmentOptions[0], coding_policy: codingPolicyReceipt(clientProfile.codingPolicy) };
        if (change === 'terminal') f.tx.coding_state = 'posted';
        else f.tx.transaction_date = '2026-02-12';
        return result;
      }
    });
    if (change === 'terminal') assert.equal((await operation()).skipped, 'terminal_or_missing_transaction');
    else await assert.rejects(operation, { code: 'jurisdiction_context_conflict' });
    noAccountingWrites(f.calls);
  }
});

test('AI chat Apply refuses missing lineage and changed GB entity before review-case minting', async () => {
  const { codingPolicyReceipt, resolveCodingPolicy } = await import('./codingPolicy.js');
  const { applyFeedChatAction } = await import('./feedChatApply.js');
  for (const stale of ['missing', 'entity']) {
    const f = fixture({ jurisdiction: 'gb' }); f.row.entity_type = 'gb-sole-trader'; install(f);
    let minted = 0; let written = 0;
    const receipt = codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'gb', entityType: 'gb-ltd', businessDate: f.tx.transaction_date }));
    try {
      const outcome = await applyFeedChatAction({ firmId: 'firm', clientId: 'client', action: {
        type: 'apply_category', account_name: 'Office expenses', account_code: '400', transaction_ids: ['tx'],
        ...(stale === 'entity' ? { coding_policy_by_transaction: { tx: receipt } } : {})
      }, deps: {
        queryFirmDb: (...args) => f.client.query(...args),
        getClientAccountingSystemFromDb: async () => 'none',
        ensureTransactionReviewItemInDb: async () => { minted++; return 'review'; },
        updateTransactionReviewItemInDb: async () => { written++; }
      } });
      assert.equal(outcome.applied, false);
      assert.equal(minted, 0); assert.equal(written, 0);
      noAccountingWrites(f.calls);
      assert.ok(f.calls.some(({ text, params }) => text.includes('insert into audit_events') && params[2] === 'transaction.coding.policy_failed'));
    } finally { __resetFirmDbPoolForTests(); }
  }
});

test('persisted entity column and profile cannot silently select different owner policies', async () => {
  const f = fixture({ jurisdiction: 'gb', profile: { entityType: 'gb-sole-trader' } });
  f.row.entity_type = 'gb-ltd';
  await assert.rejects(() => resolveClientCodingPolicyWithClient({ client: f.client, firmId: 'firm', clientId: 'client' }),
    (error) => error.code === 'jurisdiction_context_conflict' && error.details.reason === 'profile_entity_conflict');
});

test('mark-personal AI action cannot synthesize a country-specific account when its model named none', async () => {
  const { validateCodingPolicyForChatActionInDb } = await import('./db/coding.js');
  const { codingPolicyReceipt, resolveCodingPolicy } = await import('./codingPolicy.js');
  const f = fixture({ jurisdiction: 'gb' }); install(f);
  try {
    await assert.rejects(() => validateCodingPolicyForChatActionInDb({ firmId: 'firm', clientId: 'client', transactionId: 'tx', action: {
      type: 'mark_personal', coding_policy: codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'gb', businessDate: f.tx.transaction_date }))
    } }), (error) => error.code === 'coding_policy_invalid' && error.details.reason === 'coding_account_missing');
    noAccountingWrites(f.calls);
  } finally { __resetFirmDbPoolForTests(); }
});

test('optional connector enrichment uses only coherent canonical persisted country', async () => {
  for (const [jurisdiction, profile, expected] of [
    ['sg', { jurisdiction: 'sg' }, 'sg'], ['uk', { jurisdiction: 'gb' }, 'gb'],
    [null, { jurisdiction: 'sg' }, null], ['gb', { jurisdiction: 'sg' }, null],
    ['gb', { jurisdiction: 'nonsense' }, null], ['gb', {}, 'gb']
  ]) {
    const f = fixture({ jurisdiction, profile });
    assert.equal(await getClientJurisdictionForEnrichment({ client: f.client, firmId: 'firm', clientId: 'client' }), expected);
    noAccountingWrites(f.calls);
  }
});
