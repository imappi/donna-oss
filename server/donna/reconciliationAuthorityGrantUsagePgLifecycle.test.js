// A standing-authority grant's usage has one owner: the persisted accept
// receipts (reconciliation_matches.payload.authorization.delegated_authority
// .grant_id, written with the acceptance). The grants view already reads them;
// the delegated-authority metrics must read the same fact, not the
// use_count / last_used_at columns the accept path never writes.
//
// Real PostgreSQL. Synthetic world: one firm, one client, two active grants;
// one of them auto-accepted one match and was later corrected.
// Skips without DONNA_PG_TEST_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

import { listAuthorityGrantsForClient } from './reconciliationAuthorityGrants.js';
import { computeDelegatedAuthorityMetrics } from './reconciliationDelegatedAuthorityMetrics.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const FIRM = 'firm-usage';
const CLIENT = 'client-usage';

test('real PG: the grants view and the delegated-authority metrics agree on which grants were used', {
  skip: !pgUrl && 'DONNA_PG_TEST_URL required', timeout: 300_000
}, async (t) => {
  const name = `donna_grant_usage_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  t.after(async () => {
    await db.end();
    await admin.query(`drop database "${name}" with (force)`);
    await admin.end();
  });
  await db.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, root), 'utf8'));
  }

  await db.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Synthetic Ledger Partners',$1,'GB','GBP')", [FIRM]);
  await db.query("insert into clients(id,firm_id,company_name,jurisdiction,status,profile) values($1,$2,'Synthetic Studio Ltd','gb','active','{}'::jsonb)", [CLIENT, FIRM]);
  for (const [id, scopeKey, corrections] of [['grant-used', 'harbour-lane-properties', 1], ['grant-idle', 'northgate-storage', 0]]) {
    await db.query(`insert into reconciliation_authority_grants
        (id, firm_id, client_id, scope_kind, scope_key, archetype, action, amount_ceiling, currency,
         authorized_by_actor_type, authorized_by_actor_id, source, status, correction_count)
      values ($1,$2,$3,'counterparty',$4,'recurring_rent_lease','accept_match',2000,'GBP',
         'firm_collaborator','c-partner','operator_one_click','active',$5)`,
    [id, FIRM, CLIENT, scopeKey, corrections]);
  }
  // The receipt the accept path persists with a delegated acceptance.
  await db.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, payload)
    values ('tx-rent', $1, $2, '2026-10-01', 'HARBOUR LANE RENT', 'HARBOUR LANE RENT', 0, 1200, 'GBP', 'categorized', '{}'::jsonb)`, [FIRM, CLIENT]);
  await db.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
    values ('m-rent', $1, $2, 'tx-rent', 'supplier_bill', 'bill-rent', 'auto_matched', 1200, $3::jsonb)`,
  [FIRM, CLIENT, JSON.stringify({ authorization: { reasons: ['delegated_authority'], delegated_authority: { grant_id: 'grant-used' } } })]);

  const grants = await listAuthorityGrantsForClient({ client: db, firmId: FIRM, clientId: CLIENT });
  const used = grants.find((g) => g.id === 'grant-used');
  const idle = grants.find((g) => g.id === 'grant-idle');
  assert.equal(used.use_count, 1, 'the grants view counts the accept receipt');
  assert.ok(used.last_used_at);
  assert.equal(idle.use_count, 0);

  const metrics = await computeDelegatedAuthorityMetrics({ client: db, firmId: FIRM, clientId: CLIENT });
  assert.equal(metrics.delegated_accept_count, 1);
  // One grant was used, and it was corrected: the correction rate over USED
  // grants is 1, the same fact the grants view shows.
  assert.equal(metrics.post_grant_correction_rate, 1, JSON.stringify(metrics));

  // The store's own counter columns are not a second source: nothing writes
  // them, and no reader may disagree with the receipts because of them.
  const columns = (await db.query("select use_count, last_used_at from reconciliation_authority_grants where id = 'grant-used'")).rows[0];
  assert.equal(columns.use_count, 0, 'the accept path does not maintain the column');
});
