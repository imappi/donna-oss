// Donna Inventory I4·posting — P7 §13 authority reader (fake-pg). Asserts the reader is strictly
// READ-ONLY (every query a SELECT), the per-grant daily/period aggregate wiring, and the
// authorizeInventoryPosting composer's fail-closed behavior.
//   node --test server/donna/inventory/postingAuthorityDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadActiveInventoryPostingGrants,
  readPostedAggregatesByGrant,
  gatherInventoryPostingAuthorityState,
  authorizeInventoryPosting
} from './postingAuthorityDb.js';

const activeGrant = (over = {}) => ({
  id: 'g1', status: 'active', correction_count: 0,
  allowed_posting_kinds: ['receipt'], allowed_accounts: ['asset.inventory', 'liability.grni'],
  per_journal_ceiling: 1000, daily_aggregate_ceiling: 5000, period_aggregate_ceiling: 20000,
  currency: 'EUR', confidence_floor: null, evidence_required: false, jurisdiction: null,
  valid_from: '2026-01-01T00:00:00Z', expires_at: null, review_after: null, updated_at: '2026-07-10',
  ...over
});

// Fake pg: seeds the active-grant SELECT + the daily/period aggregate SELECTs (distinguished by the
// date clause), and records every query so we can assert SELECT-only.
const fake = ({ grants = [], daily = [], period = [], throwCode = null } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (throwCode) { const e = new Error('missing'); e.code = throwCode; throw e; }
      if (sql.includes('from inventory_posting_authority_grants')) return { rows: grants };
      if (sql.includes('group by a.authority_grant_id')) {
        return { rows: sql.includes('journal_date >=') ? period : daily };
      }
      return { rows: [] };
    }
  };
};

test('reader is READ-ONLY — every query is a SELECT', async () => {
  const tx = fake({ grants: [activeGrant()], daily: [{ grant_id: 'g1', total: 400 }], period: [{ grant_id: 'g1', total: 1200 }] });
  await gatherInventoryPostingAuthorityState({ client: tx, firmId: 'f1', clientId: 'c1', journalDate: '2026-07-12', periodStart: '2026-07-01', periodEnd: '2026-07-31' });
  assert.ok(tx.queries.length >= 3);
  for (const q of tx.queries) assert.match(q.sql.trim().toLowerCase(), /^select/, `read-only: ${q.sql.slice(0, 40)}`);
});

test('loadActiveInventoryPostingGrants selects only active grants for the client', async () => {
  const tx = fake({ grants: [activeGrant()] });
  const rows = await loadActiveInventoryPostingGrants(tx, 'f1', 'c1');
  assert.equal(rows.length, 1);
  const sel = tx.queries[0];
  assert.match(sel.sql, /status = 'active'/);
  assert.deepEqual(sel.params, ['f1', 'c1']);
});

test('readPostedAggregatesByGrant sums per grant for the day and the period windows', async () => {
  const tx = fake({ daily: [{ grant_id: 'g1', total: 400 }, { grant_id: 'g2', total: 100 }], period: [{ grant_id: 'g1', total: 4800 }] });
  const agg = await readPostedAggregatesByGrant(tx, 'f1', 'c1', { journalDate: '2026-07-12', periodStart: '2026-07-01', periodEnd: '2026-07-31' });
  assert.equal(agg.daily.get('g1'), 400);
  assert.equal(agg.daily.get('g2'), 100);
  assert.equal(agg.period.get('g1'), 4800);
  // The aggregate sums POSTED attempts, keyed on authority_grant_id.
  const dailyQ = tx.queries.find((q) => q.sql.includes('journal_date = $3'));
  assert.match(dailyQ.sql, /a\.outcome = 'posted'/);
  assert.match(dailyQ.sql, /a\.authority_grant_id is not null/);
});

test('authorizeInventoryPosting: within-envelope + fresh day authorizes', async () => {
  const tx = fake({ grants: [activeGrant()], daily: [], period: [] });
  const v = await authorizeInventoryPosting({
    client: tx, firmId: 'f1', clientId: 'c1',
    proposed: { postingKind: 'receipt', amount: 400, currency: 'EUR', accountRoles: ['asset.inventory', 'liability.grni'] },
    journalDate: '2026-07-12', periodStart: '2026-07-01', periodEnd: '2026-07-31', asOf: new Date('2026-07-12T12:00:00Z')
  });
  assert.equal(v.authorized, true);
  assert.equal(v.grant.id, 'g1');
});

test('authorizeInventoryPosting: an already-near-ceiling day denies daily_aggregate_ceiling', async () => {
  const tx = fake({ grants: [activeGrant()], daily: [{ grant_id: 'g1', total: 4800 }], period: [{ grant_id: 'g1', total: 4800 }] });
  const v = await authorizeInventoryPosting({
    client: tx, firmId: 'f1', clientId: 'c1',
    proposed: { postingKind: 'receipt', amount: 400, currency: 'EUR', accountRoles: ['asset.inventory'] },
    journalDate: '2026-07-12', periodStart: '2026-07-01', periodEnd: '2026-07-31', asOf: new Date('2026-07-12T12:00:00Z')
  });
  assert.equal(v.authorized, false);
  assert.equal(v.reason, 'daily_aggregate_ceiling');
  assert.equal(v.grant.id, 'g1');
});

test('authorizeInventoryPosting: no active grant escalates no_grant', async () => {
  const tx = fake({ grants: [] });
  const v = await authorizeInventoryPosting({ client: tx, firmId: 'f1', clientId: 'c1', proposed: { postingKind: 'receipt', amount: 400, currency: 'EUR', accountRoles: [] }, asOf: new Date() });
  assert.equal(v.authorized, false);
  assert.equal(v.reason, 'no_grant');
  assert.equal(v.grant, null);
});

test('reader degrades to empty (escalate) when the 083 table is absent (pre-migration)', async () => {
  const tx = fake({ throwCode: '42P01' });
  const state = await gatherInventoryPostingAuthorityState({ client: tx, firmId: 'f1', clientId: 'c1' });
  assert.deepEqual(state.grants, []);
  const v = await authorizeInventoryPosting({ client: fake({ throwCode: '42P01' }), firmId: 'f1', clientId: 'c1', proposed: { postingKind: 'receipt', amount: 1, currency: 'EUR', accountRoles: [] }, asOf: new Date() });
  assert.equal(v.reason, 'no_grant');
});
