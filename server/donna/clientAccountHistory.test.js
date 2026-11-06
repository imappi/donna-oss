// Client account-coding history — unit tests (Slice F first_use_account flag source).
//
// Load-bearing properties:
//   - reads PERSISTED codings only (the snapshot's first-use signal must not be defeated
//     by the focus row's own volatile proposal — that exclusion is enforced in the SQL,
//     asserted here via the query shape + params);
//   - the focus transaction is excluded so a row never counts as its own precedent;
//   - a genuine empty history → [] (the snapshot flags every account first-use), while a
//     read FAILURE is left to the caller (this returns [] only on pre-migration);
//   - missing args → [] without a query; pre-migration (missing table) soft-fails to [].

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadKnownAccountKeysForClient } from './clientAccountHistory.js';

const makeMockClient = (responders = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const responder = responders.shift();
      return responder ? responder({ sql, params }) : { rows: [] };
    }
  };
};

test('returns the deduped account keys, querying by (firm, client) excluding the focus tx', async () => {
  const client = makeMockClient([() => ({ rows: [
    { code: '6000', payload_code: null, payload_name: 'Rent' },
    { code: '6000', payload_code: '4000', payload_name: null } // dupe '6000' collapses; '4000' adds
  ] })]);
  const keys = await loadKnownAccountKeysForClient({
    client, firmId: 'firm-1', clientId: 'honeybee-1', excludeTransactionId: 'txn-focus'
  });
  assert.deepEqual(keys, ['6000', 'Rent', '4000']);
  assert.deepEqual(client.calls[0].params, ['firm-1', 'honeybee-1', 'txn-focus']);
  assert.match(client.calls[0].sql, /from transactions t/);
});

test('reads persisted codings only — never the ai_suggestion proposal', async () => {
  const client = makeMockClient([() => ({ rows: [] })]);
  await loadKnownAccountKeysForClient({ client, firmId: 'f', clientId: 'c' });
  const sql = client.calls[0].sql;
  assert.match(sql, /account_code/);
  assert.match(sql, /account_name/);
  assert.equal(/ai_suggestion/.test(sql), false, 'the volatile proposal must not seed known accounts');
});

test('null fields / blanks / untrimmed values are normalized and filtered', async () => {
  const client = makeMockClient([() => ({ rows: [
    { code: '6000', payload_code: null, payload_name: '' },
    { code: '  ', payload_code: ' 4000 ', payload_name: null }
  ] })]);
  const keys = await loadKnownAccountKeysForClient({ client, firmId: 'f', clientId: 'c' });
  assert.deepEqual(keys, ['6000', '4000']);
});

test('genuine empty history → [] (caller flags every account first-use)', async () => {
  const client = makeMockClient([() => ({ rows: [] })]);
  assert.deepEqual(await loadKnownAccountKeysForClient({ client, firmId: 'f', clientId: 'c' }), []);
});

test('missing args → [] without a query', async () => {
  const client = makeMockClient([() => ({ rows: [{ key: 'x' }] })]);
  assert.deepEqual(await loadKnownAccountKeysForClient({ firmId: 'f', clientId: 'c' }), []);
  assert.deepEqual(await loadKnownAccountKeysForClient({ client, clientId: 'c' }), []);
  assert.equal(client.calls.length, 0);
});

test('pre-migration (missing table) soft-fails to []', async () => {
  const client = makeMockClient([() => { const e = new Error('no table'); e.code = '42P01'; throw e; }]);
  assert.deepEqual(await loadKnownAccountKeysForClient({ client, firmId: 'f', clientId: 'c' }), []);
});

test('a non-soft error propagates (never silently swallowed)', async () => {
  const client = makeMockClient([() => { const e = new Error('boom'); e.code = '08006'; throw e; }]);
  await assert.rejects(() => loadKnownAccountKeysForClient({ client, firmId: 'f', clientId: 'c' }), /boom/);
});
