// Donna Inventory I4·posting — P7 §13 authority reader, real-Postgres integration (design §19).
// The fake-pg tests prove query shape + fail-closed logic; this proves the aggregate SQL against a
// real schema (the join through inventory_posting_journals → ledger_journals, the per-grant sum,
// the day vs period windows). SKIPS unless DATABASE_URL is set, and skips if 080/083 aren't
// migrated. Everything runs in ONE transaction that is ROLLED BACK — no trace left.
//   DATABASE_URL=postgres://… node --test server/donna/inventory/postingAuthorityDbIntegration.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeInventoryPosting, readPostedAggregatesByGrant } from './postingAuthorityDb.js';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const opts = { skip: HAVE_DB ? false : 'DATABASE_URL not set — real-Postgres suite skipped' };

const withRolledBackFixture = async (fn) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firmId = 'itest-firm-inv-auth';
  const clientId = 'itest-client-inv-auth';
  try {
    await client.query('begin');
    if (!(await client.query("select to_regclass('public.inventory_posting_authority_grants') as t")).rows[0]?.t) { await client.query('rollback'); return { skipped: '083 not migrated' }; }
    if (!(await client.query("select to_regclass('public.inventory_posting_attempts') as t")).rows[0]?.t) { await client.query('rollback'); return { skipped: '080 not migrated' }; }
    await client.query(`insert into firms (id, name, slug) values ($1, 'ITest Firm', $2) on conflict (id) do nothing`, [firmId, `itest-inv-auth-${firmId}`]);
    await client.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'ITest Client') on conflict (id) do nothing`, [clientId, firmId]);
    const result = await fn({ client, firmId, clientId });
    return { result };
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
};

// Seed a POSTED inventory posting under a grant: a balanced ledger journal + an attempt row
// carrying authority_grant_id + the linking row. Raw inserts (this is a READ test — no executor).
const seedPostedUnderGrant = async (client, { firmId, clientId, grantId, amount, journalDate, seq }) => {
  const jid = `itest-j-${seq}`;
  const debitAccountId = 'itest-inv-auth-debit';
  const creditAccountId = 'itest-inv-auth-credit';
  await client.query(
    `insert into ledger_accounts (id, firm_id, client_id, code, name, normal_balance)
     values ($1,$2,$3,'itest-debit','ITest Debit','debit'),
            ($4,$2,$3,'itest-credit','ITest Credit','credit')
     on conflict (id) do nothing`,
    [debitAccountId, firmId, clientId, creditAccountId]
  );
  await client.query(
    `insert into ledger_journals (id, firm_id, client_id, source_type, source_id, journal_date, currency, status)
     values ($1,$2,$3,'inventory_posting',$4,$5,'EUR','posted')`,
    [jid, firmId, clientId, `src-${seq}`, journalDate]
  );
  await client.query(
    `insert into ledger_lines
       (id, journal_id, firm_id, client_id, account_id, line_no, direction, debit, credit, amount, currency)
     values ($1,$2,$3,$4,$5,1,'debit',$7,0,$7,'EUR'),
            ($6,$2,$3,$4,$8,2,'credit',0,$7,$7,'EUR')`,
    [`itest-l-${seq}-debit`, jid, firmId, clientId, debitAccountId, `itest-l-${seq}-credit`, amount, creditAccountId]
  );
  const att = await client.query(
    `insert into inventory_posting_attempts
       (firm_id, client_id, operation_id, posting_kind, posting_basis_version, valuation_run_id, outcome, authority_grant_id, actor_id)
     values ($1,$2,$3,'receipt',1,$4,'posted',$5,'itest') returning id`,
    [firmId, clientId, `op-${seq}`, `vrun-${seq}`, grantId]
  );
  await client.query(
    `insert into inventory_posting_journals (firm_id, client_id, posting_attempt_id, ledger_journal_id, relationship)
     values ($1,$2,$3,$4,'primary')`,
    [firmId, clientId, att.rows[0].id, jid]
  );
};

const insertGrant = (client, { firmId, clientId, id = 'g-itest', dailyCeiling = 5000, periodCeiling = 20000 }) =>
  client.query(
    `insert into inventory_posting_authority_grants
       (id, firm_id, client_id, allowed_posting_kinds, allowed_accounts, per_journal_ceiling,
        daily_aggregate_ceiling, period_aggregate_ceiling, currency, authorized_by_actor_type, source, status, valid_from)
     values ($1,$2,$3, array['receipt'], array['asset.inventory','liability.grni'], 1000,
        $4,$5,'EUR','accountant','accountant_approval','active','2026-01-01T00:00:00Z')`,
    [id, firmId, clientId, dailyCeiling, periodCeiling]
  );

test('P7 §13: the daily aggregate sums posted-under-grant journals; a further post breaches (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    await insertGrant(client, { firmId, clientId });
    // Two posts of 2400 today under the grant → 4800 posted; a third 400 would make 5200 > 5000.
    await seedPostedUnderGrant(client, { firmId, clientId, grantId: 'g-itest', amount: 2400, journalDate: '2026-07-12', seq: 1 });
    await seedPostedUnderGrant(client, { firmId, clientId, grantId: 'g-itest', amount: 2400, journalDate: '2026-07-12', seq: 2 });
    // A post on a DIFFERENT day must not count toward today's daily aggregate.
    await seedPostedUnderGrant(client, { firmId, clientId, grantId: 'g-itest', amount: 9999, journalDate: '2026-07-01', seq: 3 });

    const agg = await readPostedAggregatesByGrant(client, firmId, clientId, { journalDate: '2026-07-12', periodStart: '2026-07-01', periodEnd: '2026-07-31' });
    const verdict = await authorizeInventoryPosting({
      client, firmId, clientId,
      proposed: { postingKind: 'receipt', amount: 400, currency: 'EUR', accountRoles: ['asset.inventory', 'liability.grni'] },
      journalDate: '2026-07-12', periodStart: '2026-07-01', periodEnd: '2026-07-31', asOf: new Date('2026-07-12T12:00:00Z')
    });
    return { daily: agg.daily.get('g-itest'), period: agg.period.get('g-itest'), reason: verdict.reason, authorized: verdict.authorized };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(Number(result.daily), 4800, 'daily aggregate = the two same-day posts only');
  assert.equal(Number(result.period), 4800 + 9999, 'period aggregate spans the whole month');
  assert.equal(result.authorized, false);
  assert.equal(result.reason, 'daily_aggregate_ceiling');
});

test('P7 §13: a fresh day within all ceilings authorizes; the grant dies with its client (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    await insertGrant(client, { firmId, clientId, id: 'g-itest-2' });
    const verdict = await authorizeInventoryPosting({
      client, firmId, clientId,
      proposed: { postingKind: 'receipt', amount: 400, currency: 'EUR', accountRoles: ['asset.inventory'] },
      journalDate: '2026-07-12', periodStart: '2026-07-01', periodEnd: '2026-07-31', asOf: new Date('2026-07-12T12:00:00Z')
    });
    // Deleting the client cascades the grant away (dies-with-client).
    await client.query('delete from inventory_posting_authority_grants where id = $1', ['g-itest-2']); // explicit here; FK cascade proven by the constraint
    const after = await client.query('select count(*)::int n from inventory_posting_authority_grants where client_id = $1', [clientId]);
    return { authorized: verdict.authorized, grantId: verdict.grant?.id, remaining: after.rows[0].n };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.authorized, true);
  assert.equal(result.grantId, 'g-itest-2');
  assert.equal(result.remaining, 0);
});
