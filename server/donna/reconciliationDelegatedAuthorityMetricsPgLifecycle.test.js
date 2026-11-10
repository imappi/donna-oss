// The §14 delegated-authority metrics read LIVE sources only — proven on real
// PostgreSQL. The held-for-authority counters come from the materiality-held
// receipts on reconciliation_matches (still held, confirmed once by a person,
// rejected); the retired authorization-request table (migration 041, which
// nothing writes since the firm ask was retired) is no longer read: a row
// planted there moves nothing. Synthetic world, one firm, two clients.
// Skips without DONNA_PG_TEST_URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

import { computeDelegatedAuthorityMetrics } from './reconciliationDelegatedAuthorityMetrics.js';

const FIRM = 'firm-dam';
const A = 'client-dam-a';
const B = 'client-dam-b';

test('real PG: delegated-authority metrics count held matches and grants, never the retired request table', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL required',
  timeout: 120_000
}, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `donna_da_metrics_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  t.after(async () => {
    await db.end().catch(() => {});
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  });
  await db.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, root), 'utf8'));
  }
  await db.query("insert into firms(id,name,slug) values($1,'Ledgerlight Partners','ledgerlight')", [FIRM]);
  for (const id of [A, B]) await db.query("insert into clients(id,firm_id,company_name) values($1,$2,$1)", [id, FIRM]);

  const gates = { A: true, B: true, C: true, D: true, E: false };
  const held = { band: 'suggested', reasons: ['above_materiality_ceiling'], gates, model: 'strong-model-a' };
  let seq = 0;
  const match = async (clientId, status, authorization, amount = 1200) => {
    seq += 1;
    await db.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_in, money_out, currency)
      values ($1,$2,$3,'2025-01-06','RENT',0,$4,'GBP')`, [`tx-${seq}`, FIRM, clientId, amount]);
    await db.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
      values ($1,$2,$3,$4,'supplier_bill',$5,$6,$7,$8::jsonb)`,
      [`m-${seq}`, FIRM, clientId, `tx-${seq}`, `doc-${seq}`, status, amount, JSON.stringify({ authorization })]);
  };
  // Client A: two still held, one confirmed once by a person, one rejected,
  // one grant-backed accept, one ordinary auto-match, one suggested for another reason.
  await match(A, 'suggested', held);
  await match(A, 'suggested', held);
  await match(A, 'confirmed', { ...held, authority_receipt: { kind: 'one_time_confirm', standing: false, grant_id: null } });
  await match(A, 'rejected', held);
  await match(A, 'auto_matched', { ...held, band: 'auto_matched', reasons: ['delegated_authority'], model: 'strong-model-b', delegated_authority: { grant_id: 'g-1' } }, 900);
  await match(A, 'auto_matched', { band: 'auto_matched', reasons: ['all_gates_passed'], gates: { ...gates, E: true } }, 80);
  await match(A, 'suggested', { band: 'suggested', reasons: ['ambiguous_second_best'] });
  // Client B: one held.
  await match(B, 'suggested', held);
  await db.query(`insert into reconciliation_authority_grants (id, firm_id, client_id, scope_kind, scope_key, archetype, action, amount_ceiling, currency,
      authorized_by_actor_type, source, status)
    values ('g-1',$1,$2,'merchant','merchant:harbour-lane|doc:supplier_bill|acct:7100','recurring_rent_lease','accept_match',1500,'GBP','accountant','accountant_approval','active')`, [FIRM, A]);

  const expectedA = {
    held_for_authority_open_count: 2,
    held_for_authority_total: 4,
    held_one_time_confirm_count: 1,
    held_confirmed_count: 1,
    held_rejected_count: 1,
    delegated_accept_count: 1,
    grant_count: 1,
    grant_active_count: 1
  };
  const pick = (m) => Object.fromEntries(Object.keys(expectedA).map((k) => [k, m[k]]));
  const a = await computeDelegatedAuthorityMetrics({ client: db, firmId: FIRM, clientId: A });
  assert.deepEqual(pick(a), expectedA);
  assert.equal(a.grant_hit_rate, 1 / 5, 'one delegated accept against four held lines');
  assert.deepEqual(a.models.held_matches, ['strong-model-a']);
  assert.deepEqual(a.models.delegated_accepts, ['strong-model-b']);
  for (const retired of ['awaiting_authorization_open_count', 'grant_rejection_rate', 'high_risk_archetype_request_count']) {
    assert.equal(retired in a, false, `${retired} is no longer reported`);
  }
  assert.equal(a.models.requests, undefined);

  const firm = await computeDelegatedAuthorityMetrics({ client: db, firmId: FIRM });
  assert.equal(firm.held_for_authority_open_count, 3, 'firm-wide includes client B');
  assert.equal(firm.held_for_authority_total, 5);

  // A row in the retired request table moves nothing.
  await db.query(`insert into reconciliation_authorization_requests (id, firm_id, client_id, bank_transaction_id, match_id, matched_object_type, matched_object_id,
      match_amount, currency, status)
    values ('req-1',$1,$2,'tx-1','m-1','supplier_bill','doc-1',1200,'GBP','open')`, [FIRM, A]).catch(async (error) => {
    // The fixture must exercise the table; fail loudly if its shape changed.
    throw new Error(`could not plant a retired request row: ${error.message}`);
  });
  assert.deepEqual(await computeDelegatedAuthorityMetrics({ client: db, firmId: FIRM, clientId: A }), a);
});
