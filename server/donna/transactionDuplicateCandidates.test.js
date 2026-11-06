// Per-transaction duplicate-candidate index — unit tests (Slice F duplicate_risk flag source).
//
// Load-bearing properties:
//   - finds OTHER rows (different id, same client) by the strong external-id identity OR the
//     spottable amount+date+currency identity — asserted via the query shape + params;
//   - the focus row is anchored (firm + client + id) and excluded from its own candidate set;
//   - a query that genuinely finds nothing → [] (the snapshot CLEARS duplicate_risk), while a
//     read it could not answer (missing args / pre-migration) → null (the snapshot stays UNKNOWN)
//     — the deliberate asymmetry vs clientAccountHistory, because here empty means "clear";
//   - a non-soft error propagates (never silently swallowed).

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadDuplicateCandidateIdsForTransaction } from './transactionDuplicateCandidates.js';

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

test('returns deduped candidate ids, anchoring on (firm, client, focus id)', async () => {
  const client = makeMockClient([() => ({ rows: [
    { id: 'txn-dup-a' },
    { id: 'txn-dup-a' }, // dupe collapses
    { id: 'txn-dup-b' }
  ] })]);
  const ids = await loadDuplicateCandidateIdsForTransaction({
    client, firmId: 'firm-1', clientId: 'honeybee-1', transactionId: 'txn-focus'
  });
  assert.deepEqual(ids, ['txn-dup-a', 'txn-dup-b']);
  assert.deepEqual(client.calls[0].params, ['firm-1', 'honeybee-1', 'txn-focus']);
});

test('matches by external id OR amount+date+currency, and excludes the focus row itself', async () => {
  const client = makeMockClient([() => ({ rows: [] })]);
  await loadDuplicateCandidateIdsForTransaction({ client, firmId: 'f', clientId: 'c', transactionId: 't' });
  const sql = client.calls[0].sql;
  assert.match(sql, /external_transaction_id/);
  assert.match(sql, /transaction_date/);
  assert.match(sql, /money_in/);
  assert.match(sql, /money_out/);
  assert.match(sql, /other\.id <> focus\.id/, 'the focus row is never its own duplicate');
  assert.match(sql, /currency is not distinct from/, 'cross-currency same-amount is not a duplicate');
});

test('a query that ran and found nothing → [] (snapshot clears duplicate_risk)', async () => {
  const client = makeMockClient([() => ({ rows: [] })]);
  assert.deepEqual(
    await loadDuplicateCandidateIdsForTransaction({ client, firmId: 'f', clientId: 'c', transactionId: 't' }),
    []
  );
});

test('null / blank ids in the result are normalized out', async () => {
  const client = makeMockClient([() => ({ rows: [
    { id: 'txn-a' }, { id: null }, { id: '  ' }, { id: ' txn-b ' }
  ] })]);
  assert.deepEqual(
    await loadDuplicateCandidateIdsForTransaction({ client, firmId: 'f', clientId: 'c', transactionId: 't' }),
    ['txn-a', 'txn-b']
  );
});

test('missing args → null without a query (snapshot stays unknown, never falsely clear)', async () => {
  const client = makeMockClient([() => ({ rows: [{ id: 'x' }] })]);
  assert.equal(await loadDuplicateCandidateIdsForTransaction({ firmId: 'f', clientId: 'c', transactionId: 't' }), null);
  assert.equal(await loadDuplicateCandidateIdsForTransaction({ client, clientId: 'c', transactionId: 't' }), null);
  assert.equal(await loadDuplicateCandidateIdsForTransaction({ client, firmId: 'f', transactionId: 't' }), null);
  assert.equal(await loadDuplicateCandidateIdsForTransaction({ client, firmId: 'f', clientId: 'c' }), null);
  assert.equal(client.calls.length, 0);
});

test('pre-migration (missing table/column) soft-fails to null (unknown, NOT a false clear)', async () => {
  const noTable = makeMockClient([() => { const e = new Error('no table'); e.code = '42P01'; throw e; }]);
  assert.equal(await loadDuplicateCandidateIdsForTransaction({ client: noTable, firmId: 'f', clientId: 'c', transactionId: 't' }), null);
  const noColumn = makeMockClient([() => { const e = new Error('no column'); e.code = '42703'; throw e; }]);
  assert.equal(await loadDuplicateCandidateIdsForTransaction({ client: noColumn, firmId: 'f', clientId: 'c', transactionId: 't' }), null);
});

test('a non-soft error propagates (never silently swallowed)', async () => {
  const client = makeMockClient([() => { const e = new Error('boom'); e.code = '08006'; throw e; }]);
  await assert.rejects(
    () => loadDuplicateCandidateIdsForTransaction({ client, firmId: 'f', clientId: 'c', transactionId: 't' }),
    /boom/
  );
});
