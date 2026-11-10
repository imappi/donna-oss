// A held material match is a transition, never a resting state — proven on
// real PostgreSQL through the real writers.
//
// Synthetic world: a fictional studio pays quarterly rent to a fictional
// landlord, 1 200 GBP against a 500 GBP materiality ceiling. The bank line is
// already CODED (coding_state 'applied', rent account 7100) before the bill
// arrives, so the coding axis alone would read it finished. The real
// supplier-bill evaluation (runSupplierBillReconciliationLlmForDocument, the
// strong model scripted at fetchImpl) authorises the match on gates A–D and
// the materiality ceiling (Gate E) holds it: `suggested`, reasons
// ['above_materiality_ceiling']. Every write goes through withFirmDbClient,
// the pool the convergence settle hook is installed on, so the PERSISTED
// column is what is asserted — and the nightly recompute must agree with it.
//
//   1. Held, no covering grant → the column reads hanging under
//      matched_pending_authority_no_grant, never auto_reconciled. (On the
//      pre-fix tree the gather never fed matchHeldPendingAuthority, so this
//      line was persisted auto_reconciled / coding_state:applied.)
//   2. A partner mints a standing grant from the example; the example stays
//      held (minting never confirms) but is now covered: the line keeps its
//      pre-existing outcome, re-derived from the grant write itself.
//   3. The grant is revoked: the held line hangs again.
//   4. A person confirms the match: the line is finished, auto_reconciled.
//   At every step recomputeConvergenceDrift reports no drift and no mark
//   rests on the row.
// Skips without DONNA_PG_TEST_URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

import { withFirmDbClient, __endFirmDbPoolForTests } from './firmDb.js';
import { runSupplierBillReconciliationLlmForDocument } from './supplierBillReconciliationLlm.js';
import { computeConvergenceForTransactions, recomputeConvergenceDrift } from './reconcileConvergenceState.js';
import { mintAuthorityGrant, transitionAuthorityGrant } from './reconciliationAuthorityGrants.js';
import { deriveGrantPreview } from './reconciliationAuthorityRoutes.js';
import { setClientFlagStage } from './clientConfig.js';
import { updateReconciliationMatchInDb } from './firmDb.js';

const FIRM = 'firm-held';
const CLIENT = 'client-held';
const VENDOR = 'Harbour Lane Properties Ltd';
const PARTNER = 'partner@ledgerlight.example';

test('real PG: a coded line whose material match is held for authority persists hanging until a grant covers it or a person decides', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL required',
  timeout: 300_000
}, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `donna_held_match_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() });
  await seed.connect();
  const env = {
    DATABASE_URL: url.toString(),
    OPENAI_API_KEY: 'test-only-no-network', ANTHROPIC_API_KEY: 'test-only-no-network',
    RECONCILIATION_AUTO_MATCH_POLICY: 'true',
    RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: '500',
    RECONCILIATION_DELEGATED_AUTHORITY: '',
    RECONCILIATION_MATERIAL_AUTO_FYI: ''
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    await __endFirmDbPoolForTests().catch(() => {});
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  await seed.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, root), 'utf8'));
  }
  await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Ledgerlight Partners','ledgerlight','GB','GBP')", [FIRM]);
  await seed.query(`insert into clients(id,firm_id,company_name,jurisdiction,status,profile) values($1,$2,'Pierpoint Studio Ltd','gb','active',$3)`,
    [CLIENT, FIRM, { jurisdiction: 'gb', accounting_system: 'none' }]);
  await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: 'RECONCILIATION_DELEGATED_AUTHORITY', stage: 'auto', source: 'manual', reason: 'held-match proof world' });

  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const prompt = String(request.messages?.[0]?.content || '');
    const total = Number(/total_amount=([\d.]+)/.exec(prompt)?.[1] ?? /total=([\d.]+)/.exec(prompt)?.[1]);
    const candidates = [...prompt.matchAll(/candidate_ref=(candidate_\d+)\n\s*date=[^\n]*\n\s*money_out=([\d.]+)/g)]
      .map((m) => ({ ref: m[1], amount: Number(m[2]) }));
    const hit = candidates.find((c) => Math.abs(c.amount - total) < 0.005) || candidates[0];
    const reply = hit
      ? { proposals: [{ candidate_ref: hit.ref, confidence: 0.95, reasoning: 'The quarterly rent paid to the landlord; amount and payee agree.', hops: ['amount_exact', 'vendor_overlap'] }], unmatchable_reason: null }
      : { proposals: [], unmatchable_reason: 'no_plausible_match' };
    return { ok: true, status: 200, json: async () => ({ model: 'scripted-strong-model', content: [{ text: JSON.stringify(reply) }] }) };
  };

  // A settled prior quarter: the recurring-vendor evidence the archetype needs.
  await seed.query(`insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, vendor_name, total_amount, currency,
      document_date, reference_number, payment_status, extraction_confidence, parse_summary, payload)
    values ('bill-prior',$1,$2,'bill-prior.pdf','supplier_bill','received','completed',$3,1200,'GBP','2024-10-01','RENT-0','paid',0.97,$4::jsonb,'{}'::jsonb)`,
    [FIRM, CLIENT, VENDOR, JSON.stringify({ summary: 'Quarterly rent for the studio premises', warnings: [] })]);
  await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, account_code, reconciliation_status, payload, coding_state)
    values ('tx-prior',$1,$2,'2024-10-01',$3,$3,0,1200,'GBP','categorized','7100','reconciled','{}'::jsonb,'applied')`, [FIRM, CLIENT, `${VENDOR.toUpperCase()} RENT`]);
  await seed.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
    values ('m-prior',$1,$2,'tx-prior','supplier_bill','bill-prior','confirmed',1200,'{}'::jsonb)`, [FIRM, CLIENT]);

  // The line under test: already coded to rent, the bill not yet matched.
  await withFirmDbClient((client) => client.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, account_code, payload, coding_state)
    values ('tx-q1',$1,$2,'2025-01-06',$3,$3,0,1200,'GBP','categorized','7100','{}'::jsonb,'applied')`, [FIRM, CLIENT, `${VENDOR.toUpperCase()} RENT`]));
  await withFirmDbClient((client) => client.query(`insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, vendor_name, total_amount, currency,
      document_date, reference_number, payment_status, extraction_confidence, parse_summary, payload)
    values ('bill-q1',$1,$2,'bill-q1.pdf','supplier_bill','received','completed',$3,1200,'GBP','2025-01-06','RENT-1','unpaid',0.97,$4::jsonb,'{}'::jsonb)`,
    [FIRM, CLIENT, VENDOR, JSON.stringify({ summary: 'Quarterly rent for the studio premises', warnings: [] })]));

  const persisted = async () => {
    const row = (await seed.query('select convergence_state, convergence_reason from transactions where firm_id=$1 and id=$2', [FIRM, 'tx-q1'])).rows[0];
    return { state: row.convergence_state, reason: row.convergence_reason };
  };
  const marks = async () => Number((await seed.query("select count(*)::int n from convergence_marks where firm_id=$1 and target_id='tx-q1'", [FIRM])).rows[0].n);
  // Column == fresh derivation == expected, no mark resting, nightly agrees.
  const expectRest = async (expected, label) => {
    const fresh = (await computeConvergenceForTransactions(seed, { firmId: FIRM, transactionIds: ['tx-q1'], verdictOnly: true }))[0].derived;
    assert.deepEqual(await persisted(), expected, `${label}: the persisted column`);
    assert.deepEqual({ state: fresh.state, reason: fresh.reason }, expected, `${label}: a fresh derivation`);
    assert.equal(await marks(), 0, `${label}: no unsettled mark rests on the line`);
    const drift = await recomputeConvergenceDrift(seed, { firmId: FIRM, clientId: CLIENT });
    assert.equal(drift.drift_count, 0, `${label}: the nightly recompute agrees ${JSON.stringify(drift.drifted_sample)}`);
  };

  // Before any match the coded line is finished by Donna.
  await withFirmDbClient((client) => client.query('update firms set name = name where id = $1', [FIRM]));
  await expectRest({ state: 'auto_reconciled', reason: 'coding_state:applied' }, 'coded, unmatched');

  // ── 1. Held, no covering grant ──────────────────────────────────────────────
  await withFirmDbClient((client) => runSupplierBillReconciliationLlmForDocument({
    client, firmId: FIRM, clientId: CLIENT, documentId: 'bill-q1', apiKeyOverride: 'sk-test', fetchImpl
  }));
  const match = (await seed.query("select * from reconciliation_matches where matched_object_id='bill-q1'")).rows[0];
  assert.equal(match.status, 'suggested', JSON.stringify(match.payload?.authorization));
  assert.deepEqual(match.payload.authorization.reasons, ['above_materiality_ceiling']);
  assert.deepEqual(match.payload.authorization.gates, { A: true, B: true, C: true, D: true, E: false });
  assert.equal(match.bank_transaction_id, 'tx-q1');
  await expectRest({ state: 'hanging', reason: 'matched_pending_authority_no_grant' }, 'held, no grant');

  // ── 2. A covering active grant: the existing outcome is kept ───────────────
  const preview = await deriveGrantPreview(seed, { firmId: FIRM, clientId: CLIENT, matchId: match.id });
  assert.equal(preview.eligible, true, JSON.stringify(preview));
  const minted = await withFirmDbClient((client) => mintAuthorityGrant({
    client, firmId: FIRM, clientId: CLIENT, scopeKind: preview.scope_kind, scopeKey: preview.scope_key,
    archetype: preview.archetype, amountCeiling: 1500, currency: 'GBP', authorizedByActorType: 'accountant',
    authorizedByActorId: PARTNER, source: 'accountant_approval', status: 'active',
    reviewAfter: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    provenance: { granted_by: { actor_id: PARTNER }, example: { match_id: match.id } }
  }));
  assert.equal(minted.status, 'active');
  assert.equal((await seed.query('select status from reconciliation_matches where id=$1', [match.id])).rows[0].status, 'suggested', 'minting never confirms the example');
  await expectRest({ state: 'auto_reconciled', reason: 'coding_state:applied' }, 'held, covered by an active grant');

  // ── 3. Revoked: hanging again ──────────────────────────────────────────────
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    await transitionAuthorityGrant({ client, firmId: FIRM, clientId: CLIENT, grantId: minted.id, transition: 'revoke',
      actorType: 'accountant', actorId: PARTNER, reason: 'The lease ends this quarter' });
    await client.query('commit');
  });
  await expectRest({ state: 'hanging', reason: 'matched_pending_authority_no_grant' }, 'held, grant revoked');

  // ── 4. A person decides: finished ─────────────────────────────────────────
  await updateReconciliationMatchInDb({ firmId: FIRM, matchId: match.id, patch: { status: 'confirmed' }, actorId: PARTNER, returnSnapshot: false });
  const after = await persisted();
  assert.equal(after.state, 'auto_reconciled', JSON.stringify(after));
  await expectRest(after, 'confirmed by a person');
});
