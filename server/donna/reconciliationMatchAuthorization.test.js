// Donna — per-transaction reconciliation-match authorization reader (Slice G) unit tests.
// Load-bearing properties:
//   - reads the latest match's persisted payload.authorization for the focus bank line
//   - returns null (→ NO match check) when there is no match, no authorization, or a soft-fail
//   - missing args → null without querying
//   - a pre-migration / unknown-column soft-fail degrades to null (never throws)

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadMatchAuthorizationForTransaction } from './reconciliationMatchAuthorization.js';

const makeMockClient = (responder = null) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (responder?.throw) throw responder.throw;
      return { rows: responder?.rows || [], rowCount: (responder?.rows || []).length };
    }
  };
};

test('returns the persisted authorization for the latest match of the focus tx', async () => {
  const authorization = { band: 'auto_matched', reasons: ['delegated_authority'] };
  const c = makeMockClient({ rows: [{ authorization }] });
  const out = await loadMatchAuthorizationForTransaction({ client: c, firmId: 'f', clientId: 'cl', transactionId: 'txn_1' });
  assert.deepEqual(out, authorization);
  // queries reconciliation_matches by bank_transaction_id, newest first, limit 1
  assert.match(c.calls[0].sql, /from reconciliation_matches/);
  assert.match(c.calls[0].sql, /bank_transaction_id = \$3/);
  assert.match(c.calls[0].sql, /order by created_at desc/);
  assert.match(c.calls[0].sql, /limit 1/);
  assert.deepEqual(c.calls[0].params, ['f', 'cl', 'txn_1']);
});

test('no match row → null (no match check)', async () => {
  const c = makeMockClient({ rows: [] });
  assert.equal(await loadMatchAuthorizationForTransaction({ client: c, firmId: 'f', clientId: 'cl', transactionId: 'txn_1' }), null);
});

test('match exists but no authorization persisted → null', async () => {
  const c = makeMockClient({ rows: [{ authorization: null }] });
  assert.equal(await loadMatchAuthorizationForTransaction({ client: c, firmId: 'f', clientId: 'cl', transactionId: 'txn_1' }), null);
});

test('a non-object authorization value → null (never a fabricated receipt)', async () => {
  const c = makeMockClient({ rows: [{ authorization: 'corrupt' }] });
  assert.equal(await loadMatchAuthorizationForTransaction({ client: c, firmId: 'f', clientId: 'cl', transactionId: 'txn_1' }), null);
});

test('missing args → null without querying', async () => {
  const c = makeMockClient({ rows: [{ authorization: { band: 'auto_matched' } }] });
  assert.equal(await loadMatchAuthorizationForTransaction({ client: c, firmId: 'f', clientId: 'cl' }), null);
  assert.equal(await loadMatchAuthorizationForTransaction({ client: null, firmId: 'f', clientId: 'cl', transactionId: 't' }), null);
  assert.equal(c.calls.length, 0);
});

test('pre-migration / unknown-column soft-fail → null (degrades, never throws)', async () => {
  for (const code of ['42P01', '42703']) {
    const err = new Error('boom'); err.code = code;
    const c = makeMockClient({ throw: err });
    assert.equal(await loadMatchAuthorizationForTransaction({ client: c, firmId: 'f', clientId: 'cl', transactionId: 'txn_1' }), null);
  }
});

test('a genuine DB error still throws (not swallowed)', async () => {
  const err = new Error('connection reset'); err.code = '08006';
  const c = makeMockClient({ throw: err });
  await assert.rejects(
    () => loadMatchAuthorizationForTransaction({ client: c, firmId: 'f', clientId: 'cl', transactionId: 'txn_1' }),
    /connection reset/
  );
});
