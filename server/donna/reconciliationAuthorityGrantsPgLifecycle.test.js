// Standing delegated authority, granted in the product — the real-PostgreSQL
// proof through the real HTTP routes and the real supplier-bill evaluation path
// (runSupplierBillReconciliationLlmForDocument, the strong model scripted at
// fetchImpl). Synthetic world: a quarterly rent bill from a fictional landlord,
// 1 200 GBP against a 500 GBP materiality ceiling, so every match is MATERIAL:
// the model and gates A–D authorise it and only Gate E holds it.
//
//   1. A held match projects hanging (never terminal) and counts as held.
//   2. A business owner and a junior seat are refused (receipted); a bare
//      confirm of the held match is one-time: it reconciles that line, stamps
//      authority_receipt { standing:false } and mints nothing.
//   3. A partner seat previews and mints from the next held match; the receipt
//      names the partner. The example itself stays held (two separate acts).
//   4. The next matching bill auto-accepts with the delegated-authority
//      receipt, projects auto_reconciled, and the held count drops.
//   5. A human rejection of that auto-accept auto-suspends the grant; the
//      list shows the suspension and its cause; the next bill is held again.
//   6. Re-activation (with a reason) restores it; the next bill auto-accepts.
//   7. Revocation takes effect on the next evaluation: held again.
//   8. A learned-pattern grant is proposed, never acts, then acts once a
//      partner approves it.
//   9. Isolation: a grant id or match id from another client is not reachable;
//      a seat not assigned to the other client is refused; the other client's
//      grants view is empty and says the delegated-authority flag is off.
// Skips without DONNA_PG_TEST_URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

import { handleDonnaApiRequest } from './api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, withFirmDbClient } from './firmDb.js';
import { runSupplierBillReconciliationLlmForDocument } from './supplierBillReconciliationLlm.js';
import { computeConvergenceForTransactions } from './reconcileConvergenceState.js';
import { mintAuthorityGrant } from './reconciliationAuthorityGrants.js';
import { setClientFlagStage } from './clientConfig.js';
import { delegationGateProof } from './reconciliationLlmCore.js';

const FIRM = 'firm-ra';
const A = 'client-ra-a';
const B = 'client-ra-b';
const PEOPLE = {
  operator: 'operator@ledgerlight.example',
  partner: 'partner@ledgerlight.example',
  junior: 'junior@ledgerlight.example',
  owner: 'owner@pierpoint-studio.example'
};

test('real PG + real HTTP: a firm grants, uses, suspends, re-activates, revokes and approves standing authority for material matches; owners and juniors cannot; clients are isolated', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL required',
  timeout: 300_000
}, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `donna_recon_authority_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  __setFirmDbPoolForTests(pool);
  const env = {
    DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'not-a-person-token',
    SUPABASE_URL: 'https://authority-auth.invalid', SUPABASE_ANON_KEY: 'test-key',
    DONNA_AUTH_ALLOWED_EMAILS: Object.values(PEOPLE).join(','),
    OPENAI_API_KEY: 'test-only-no-network', ANTHROPIC_API_KEY: 'test-only-no-network',
    RECONCILIATION_AUTO_MATCH_POLICY: 'true',
    RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING: '500',
    RECONCILIATION_DELEGATED_AUTHORITY: '',
    RECONCILIATION_MATERIAL_AUTO_FYI: ''
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  // A forced drop at teardown ends this pool's idle sessions; handled here so
  // that expected disconnect is never an uncaught exception.
  pool.on('error', () => {});
  t.after(async () => {
    // Post-response reads may still be in flight. Keep THIS pool installed
    // (so nothing lazily opens a second pool from DATABASE_URL) until every
    // client is back and idle, drop the scratch database, then release it.
    for (let i = 0; i < 100 && pool.totalCount !== pool.idleCount; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await admin.query(`drop database if exists "${name}" with (force)`);
    await pool.end().catch(() => {});
    __resetFirmDbPoolForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await admin.end();
  });

  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, root), 'utf8'));
  }

  // ── The world ──────────────────────────────────────────────────────────────
  await pool.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'Ledgerlight Partners','ledgerlight','GB','GBP')", [FIRM]);
  for (const [id, company] of [[A, 'Pierpoint Studio Ltd'], [B, 'Saltmarsh Bakery Ltd']]) {
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,status,profile) values($1,$2,$3,'gb','active',$4)`,
      [id, FIRM, company, { jurisdiction: 'gb', accounting_system: 'none' }]);
  }
  // The existing delegated-authority flag acts for A only (staged here as the
  // world's precondition — the product never stages it).
  await setClientFlagStage(pool, { firmId: FIRM, clientId: A, flagKey: 'RECONCILIATION_DELEGATED_AUTHORITY', stage: 'auto', source: 'manual', reason: 'authority proof world' });
  await pool.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
    values('m-operator',$1,'u-operator',$2,'Operator','member','active','staff')`, [FIRM, PEOPLE.operator]);
  for (const [id, email, seat, role] of [['c-partner', PEOPLE.partner, 'partner', 'bookkeeper'], ['c-junior', PEOPLE.junior, 'junior', 'bookkeeper'], ['c-owner', PEOPLE.owner, null, 'owner']]) {
    await pool.query(`insert into firm_collaborators(id,firm_id,user_id,email,name,role,status,seat_role,affiliation)
      values($1,$2,$3,$4,$1,$5,'active',$6,'internal')`, [id, FIRM, `u-${id}`, email, role, seat]);
    await pool.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role)
      values($1,$2,$3,'firm_collaborator',$4,$5)`, [`as-${id}`, FIRM, A, id, seat || role]);
  }

  const server = createServer((req, res) => Promise.resolve(handleDonnaApiRequest(req, res)).catch((error) => {
    res.statusCode = error.statusCode || 500; res.end(JSON.stringify({ error: error.message, code: error.code }));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = (who, method, route, body = null) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: `/api/donna/firms${route}`, method,
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const get = (who, route) => call(who, 'GET', `${route}&firm_id=${FIRM}`);
  const post = (who, route, body) => call(who, 'POST', route, { firm_id: FIRM, ...body });

  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://authority-auth.invalid/auth/v1/user', `no network: ${endpoint}`);
    const who = String(init?.headers?.Authorization || init?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    return { ok: true, json: async () => ({ id: who === 'operator' ? 'u-operator' : `u-c-${who}`, email: PEOPLE[who] }) };
  });

  // The strong model, scripted: settle the bill on the candidate whose
  // money_out equals the bill total, at 0.95, with amount + vendor evidence.
  const modelCalls = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const prompt = String(request.messages?.[0]?.content || '');
    assert.match(String(request.system || ''), /^You match a parsed supplier bill/);
    const total = Number(/total_amount=([\d.]+)/.exec(prompt)?.[1] ?? /total=([\d.]+)/.exec(prompt)?.[1]);
    const candidates = [...prompt.matchAll(/candidate_ref=(candidate_\d+)\n\s*date=[^\n]*\n\s*money_out=([\d.]+)/g)]
      .map((m) => ({ ref: m[1], amount: Number(m[2]) }));
    modelCalls.push({ total, candidates });
    const hit = candidates.find((c) => Math.abs(c.amount - total) < 0.005) || candidates[0];
    const reply = hit
      ? { proposals: [{ candidate_ref: hit.ref, confidence: 0.95, reasoning: 'The quarterly rent paid to the landlord; amount and payee agree.', hops: ['amount_exact', 'vendor_overlap'] }], unmatchable_reason: null }
      : { proposals: [], unmatchable_reason: 'no_plausible_match' };
    return { ok: true, status: 200, json: async () => ({ model: 'scripted-strong-model', content: [{ text: JSON.stringify(reply) }] }) };
  };

  let seq = 0;
  // Each bank line arrives coded to the rent account (account_code 7100, the
  // classifier's established-account evidence) and out of the coding review
  // queue, so the projection's coding axis stays out of the authority proof.
  const bill = async ({ clientId = A, vendor = 'Harbour Lane Properties Ltd', date, amount = 1200 }) => {
    seq += 1;
    const docId = `bill-${seq}`; const txId = `tx-${seq}`;
    await pool.query(`insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, vendor_name, total_amount, currency,
        document_date, reference_number, payment_status, extraction_confidence, parse_summary, payload)
      values ($1,$2,$3,$4,'supplier_bill','received','completed',$5,$6,'GBP',$7,$8,'unpaid',0.97,$9::jsonb,'{}'::jsonb)`,
      [docId, FIRM, clientId, `${docId}.pdf`, vendor, amount, date, `RENT-${seq}`, JSON.stringify({ summary: 'Quarterly rent for the studio premises', warnings: [] })]);
    await pool.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, raw_description, money_in, money_out, currency, status, account_code, payload, coding_state)
      values ($1,$2,$3,$4,$5,$5,0,$6,'GBP','categorized','7100','{}'::jsonb,null)`,
      [txId, FIRM, clientId, date, `${vendor.toUpperCase()} RENT`, amount]);
    return { docId, txId };
  };
  const evaluate = (clientId, documentId) => withFirmDbClient((client) => runSupplierBillReconciliationLlmForDocument({
    client, firmId: FIRM, clientId, documentId, apiKeyOverride: 'sk-test', fetchImpl
  }));
  const matchFor = async (docId) => (await pool.query('select * from reconciliation_matches where matched_object_id=$1', [docId])).rows[0];
  const projection = async (txId) => (await withFirmDbClient((client) => computeConvergenceForTransactions(client, { firmId: FIRM, transactionIds: [txId] })))[0].derived;
  // Held for authority = a HANGING line whose live match is held only by the
  // materiality gate (the persisted affirmative gate receipt). The projection's
  // gather feeds its matchHeldPendingAuthority input from the same receipt, so
  // an uncovered held line projects matched_pending_authority_no_grant; the
  // count is read from the receipt, joined to the projected state.
  const heldCount = async (clientId) => {
    const { rows } = await pool.query(`select m.bank_transaction_id, m.payload from reconciliation_matches m
      where m.firm_id=$1 and m.client_id=$2 and m.status='suggested'`, [FIRM, clientId]);
    const held = rows.filter((r) => delegationGateProof(r.payload?.authorization)).map((r) => r.bank_transaction_id);
    if (!held.length) return 0;
    const out = await withFirmDbClient((client) => computeConvergenceForTransactions(client, { firmId: FIRM, transactionIds: held }));
    return out.filter((r) => r.derived.state === 'hanging').length;
  };
  const isHanging = async (txId) => assert.equal((await projection(txId)).state, 'hanging');
  const audits = async (action) => (await pool.query('select actor_type, actor_id, resource_id, metadata from audit_events where firm_id=$1 and action=$2 order by id', [FIRM, action])).rows;
  const settledPrior = async ({ clientId = A, vendor, date }) => {
    const { docId, txId } = await bill({ clientId, vendor, date });
    await pool.query("update documents set payment_status='paid' where id=$1", [docId]);
    await pool.query("update transactions set reconciliation_status='reconciled' where id=$1", [txId]);
    await pool.query(`insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload)
      values ($1,$2,$3,$4,'supplier_bill',$5,'confirmed',1200,'{}'::jsonb)`, [`m-prior-${docId}`, FIRM, clientId, txId, docId]);
  };
  const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

  // ── 1. A material match is held, hanging on authority ───────────────────────
  await settledPrior({ vendor: 'Harbour Lane Properties Ltd', date: '2024-10-01' });
  const q1 = await bill({ date: '2025-01-06' });
  await evaluate(A, q1.docId);
  let m1 = await matchFor(q1.docId);
  assert.equal(m1.status, 'suggested', JSON.stringify(m1.payload?.authorization));
  assert.deepEqual(m1.payload.authorization.reasons, ['above_materiality_ceiling']);
  assert.deepEqual(m1.payload.authorization.gates, { A: true, B: true, C: true, D: true, E: false });
  await isHanging(q1.txId);
  // The gather feeds the held input: the line hangs on authority, by name.
  assert.equal((await projection(q1.txId)).reason, 'matched_pending_authority_no_grant');
  assert.equal(await heldCount(A), 1);

  // ── 2. Refusals, then a confirm that is one-time only ───────────────────────
  let res = await get('owner', `/reconciliation-authority-grants?client_id=${A}`);
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, 'CLIENT_SIDE_PRINCIPAL', JSON.stringify(res.body));
  const mintBody = (matchId, extra = {}) => ({ client_id: A, match_id: matchId, amount_ceiling: 1500, currency: 'GBP', review_after: inDays(90), acknowledged: true, reason: 'Quarterly studio rent', ...extra });
  res = await post('owner', '/reconciliation-authority-grants/mint', mintBody(m1.id));
  assert.equal(res.status, 403); assert.equal(res.body.code, 'CLIENT_SIDE_PRINCIPAL');
  res = await post('junior', '/reconciliation-authority-grants/mint', mintBody(m1.id));
  assert.equal(res.status, 403); assert.equal(res.body.code, 'CAPABILITY_REQUIRED');
  const refused = await audits('reconciliation_authority_grant.refused');
  assert.deepEqual(refused.map((r) => [r.actor_id, r.metadata.code, r.metadata.verb]), [
    [PEOPLE.owner, 'CLIENT_SIDE_PRINCIPAL', 'grant_reconciliation_authority'],
    [PEOPLE.junior, 'CAPABILITY_REQUIRED', 'grant_reconciliation_authority']
  ]);
  res = await post('partner', '/reconciliation-authority-grants/mint', mintBody(m1.id, { acknowledged: undefined }));
  assert.equal(res.status, 400); assert.equal(res.body.code, 'GRANT_NOT_ACKNOWLEDGED', 'nothing is pre-ticked');
  res = await post('partner', '/reconciliation-authority-grants/mint', mintBody(m1.id, { action: 'accept_and_post' }));
  assert.equal(res.status, 400); assert.equal(res.body.code, 'GRANT_ACTION_UNSUPPORTED');
  assert.equal((await pool.query('select count(*)::int n from reconciliation_authority_grants')).rows[0].n, 0);

  res = await call('operator', 'PATCH', `/reconciliation-matches/${m1.id}`, { firm_id: FIRM, patch: { status: 'confirmed',
    authorization: { authority_receipt: { standing: true, grant_id: 'forged' } } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  m1 = await matchFor(q1.docId);
  assert.equal(m1.status, 'confirmed');
  assert.equal(m1.payload.authorization.authority_receipt.kind, 'one_time_confirm');
  assert.equal(m1.payload.authorization.authority_receipt.standing, false, 'a body-supplied receipt is never accepted');
  assert.equal(m1.payload.authorization.authority_receipt.grant_id, null);
  assert.equal(m1.payload.authorization.authority_receipt.confirmed_by, PEOPLE.operator);
  assert.deepEqual(m1.payload.authorization.gates, { A: true, B: true, C: true, D: true, E: false }, 'the gate receipt rides through');
  assert.equal((await pool.query('select count(*)::int n from reconciliation_authority_grants')).rows[0].n, 0, 'confirming mints no grant');
  assert.equal(await heldCount(A), 0);

  // ── 3. Authorise future matches like this (partner seat) ────────────────────
  const q2 = await bill({ date: '2025-04-16' });
  await evaluate(A, q2.docId);
  const m2 = await matchFor(q2.docId);
  assert.equal(m2.status, 'suggested');
  res = await get('partner', `/reconciliation-authority-grants/preview?client_id=${A}&match_id=${m2.id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const preview = res.body.preview;
  assert.equal(preview.eligible, true, JSON.stringify(preview));
  assert.equal(preview.archetype, 'recurring_rent_lease');
  assert.equal(preview.scope_kind, 'merchant');
  assert.equal(preview.scope.account, '7100');
  assert.equal(preview.action, 'accept_match');
  assert.deepEqual([preview.amount, preview.currency, preview.example.match_id], [1200, 'GBP', m2.id]);
  res = await post('partner', '/reconciliation-authority-grants/mint', mintBody(m2.id, { amount_ceiling: 900 }));
  assert.equal(res.status, 400); assert.equal(res.body.code, 'GRANT_CEILING_BELOW_EXAMPLE');
  res = await post('partner', '/reconciliation-authority-grants/mint', mintBody(m2.id, { currency: 'EUR' }));
  assert.equal(res.status, 400); assert.equal(res.body.code, 'GRANT_CURRENCY_MISMATCH');
  res = await post('partner', '/reconciliation-authority-grants/mint', mintBody(m2.id));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const grantId = res.body.minted.id;
  let grant = res.body.grants.find((g) => g.id === grantId);
  assert.deepEqual([grant.status, grant.scope_key, grant.amount_ceiling, grant.currency, grant.authorized_by_actor_type, grant.authorized_by_actor_id, grant.source, grant.inert_reason],
    ['active', preview.scope_key, 1500, 'GBP', 'accountant', PEOPLE.partner, 'accountant_approval', null]);
  assert.equal(grant.example.match_id, m2.id);
  const minted = await audits('reconciliation_authority_grant.minted');
  assert.equal(minted.length, 1);
  assert.deepEqual([minted[0].actor_type, minted[0].actor_id, minted[0].metadata.granted_by.seat_role, minted[0].metadata.example.match_id],
    ['accountant', PEOPLE.partner, 'partner', m2.id]);
  assert.equal((await matchFor(q2.docId)).status, 'suggested', 'minting a grant never confirms the example');
  res = await post('partner', '/reconciliation-authority-grants/mint', mintBody(m2.id));
  assert.equal(res.status, 409); assert.equal(res.body.reason, 'grant_exists');
  await call('operator', 'PATCH', `/reconciliation-matches/${m2.id}`, { firm_id: FIRM, patch: { status: 'confirmed' } });

  // ── 4. The next matching material bill auto-accepts under the grant ─────────
  const q3 = await bill({ date: '2025-07-26' });
  const heldBefore = await heldCount(A);
  await evaluate(A, q3.docId);
  const m3 = await matchFor(q3.docId);
  assert.equal(m3.status, 'auto_matched', JSON.stringify(m3.payload.authorization));
  assert.deepEqual(m3.payload.authorization.reasons, ['delegated_authority']);
  assert.equal(m3.payload.authorization.delegated_authority.grant_id, grantId);
  assert.equal(m3.payload.authorization.gates.E, false, 'the grant bypassed Gate E only');
  assert.equal((await projection(q3.txId)).state, 'auto_reconciled', JSON.stringify(await projection(q3.txId)));
  assert.equal(await heldCount(A), heldBefore, 'no new held line');
  res = await get('operator', `/reconciliation-authority-grants?client_id=${A}`);
  grant = res.body.grants.find((g) => g.id === grantId);
  assert.equal(res.body.delegated_authority_acts, true);
  assert.equal(grant.use_count, 1);
  assert.ok(grant.last_used_at);

  // ── 5. A human correction auto-suspends the grant ───────────────────────────
  res = await call('operator', 'PATCH', `/reconciliation-matches/${m3.id}`, { firm_id: FIRM, patch: { status: 'rejected' } });
  assert.equal(res.status, 200);
  res = await get('partner', `/reconciliation-authority-grants?client_id=${A}`);
  grant = res.body.grants.find((g) => g.id === grantId);
  assert.deepEqual([grant.status, grant.correction_count, grant.inert_reason], ['suspended', 1, 'suspended']);
  assert.deepEqual([grant.last_auto_suspension.reason, grant.last_auto_suspension.match_id], ['match_rejected', m3.id]);
  const q4 = await bill({ date: '2025-11-03' });
  await evaluate(A, q4.docId);
  assert.equal((await matchFor(q4.docId)).status, 'suggested', 'a suspended grant does not act');
  await isHanging(q4.txId);

  // ── 6. Re-activation by a partner, with a reason and a receipt ──────────────
  res = await post('partner', '/reconciliation-authority-grants/approve', { client_id: A, grant_id: grantId, review_after: inDays(60) });
  assert.equal(res.status, 400); assert.equal(res.body.code, 'GRANT_REASON_REQUIRED');
  res = await post('junior', '/reconciliation-authority-grants/approve', { client_id: A, grant_id: grantId, review_after: inDays(60), reason: 'x' });
  assert.equal(res.status, 403);
  res = await post('partner', '/reconciliation-authority-grants/approve', { client_id: A, grant_id: grantId, review_after: inDays(60), reason: 'Reviewed: the rejected line was a duplicate upload' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.transition, 'reactivate');
  grant = res.body.grants.find((g) => g.id === grantId);
  assert.deepEqual([grant.status, grant.correction_count, grant.inert_reason], ['active', 0, null]);
  const reactivated = await audits('reconciliation_authority_grant.reactivated');
  assert.deepEqual([reactivated[0].actor_id, reactivated[0].metadata.prior_correction_count, reactivated[0].metadata.from_status], [PEOPLE.partner, 1, 'suspended']);
  await call('operator', 'PATCH', `/reconciliation-matches/${(await matchFor(q4.docId)).id}`, { firm_id: FIRM, patch: { status: 'confirmed' } });
  const q5 = await bill({ date: '2026-02-12' });
  await evaluate(A, q5.docId);
  assert.equal((await matchFor(q5.docId)).status, 'auto_matched');

  // ── 7. Revocation takes effect on the next evaluation ───────────────────────
  res = await post('operator', '/reconciliation-authority-grants/revoke', { client_id: A, grant_id: grantId, reason: 'The lease ends this quarter' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  grant = res.body.grants.find((g) => g.id === grantId);
  assert.deepEqual([grant.status, grant.revoked_by_actor_id, grant.revoked_reason], ['revoked', PEOPLE.operator, 'The lease ends this quarter']);
  assert.equal((await audits('reconciliation_authority_grant.revoked'))[0].actor_type, 'firm_operator');
  const q6 = await bill({ date: '2026-05-24' });
  await evaluate(A, q6.docId);
  assert.equal((await matchFor(q6.docId)).status, 'suggested');
  await isHanging(q6.txId);

  // ── 8. A learned-pattern grant is proposed, inert, then approved ────────────
  await settledPrior({ vendor: 'Quayside Lettings Ltd', date: '2024-10-02' });
  const s1 = await bill({ vendor: 'Quayside Lettings Ltd', date: '2025-01-07', amount: 800 });
  await evaluate(A, s1.docId);
  const sm1 = await matchFor(s1.docId);
  const storagePreview = (await get('partner', `/reconciliation-authority-grants/preview?client_id=${A}&match_id=${sm1.id}`)).body.preview;
  const proposed = await withFirmDbClient((client) => mintAuthorityGrant({ client, firmId: FIRM, clientId: A,
    scopeKind: storagePreview.scope_kind, scopeKey: storagePreview.scope_key, archetype: storagePreview.archetype,
    amountCeiling: 1000, currency: 'GBP', authorizedByActorType: 'accountant', authorizedByActorId: PEOPLE.partner,
    source: 'learned_from_pattern', status: 'active', provenance: { pattern: 'synthetic' } }));
  assert.equal(proposed.status, 'proposed', 'a learned pattern only proposes');
  await call('operator', 'PATCH', `/reconciliation-matches/${sm1.id}`, { firm_id: FIRM, patch: { status: 'confirmed' } });
  const s2 = await bill({ vendor: 'Quayside Lettings Ltd', date: '2025-04-17', amount: 800 });
  await evaluate(A, s2.docId);
  assert.equal((await matchFor(s2.docId)).status, 'suggested', 'a proposed grant never acts');
  res = await post('owner', '/reconciliation-authority-grants/approve', { client_id: A, grant_id: proposed.id, review_after: inDays(30), reason: 'ok' });
  assert.equal(res.status, 403);
  res = await post('partner', '/reconciliation-authority-grants/approve', { client_id: A, grant_id: proposed.id, review_after: inDays(30), reason: 'Storage unit rent, recurring' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.transition, 'approve');
  assert.equal((await audits('reconciliation_authority_grant.approved'))[0].actor_id, PEOPLE.partner);
  await call('operator', 'PATCH', `/reconciliation-matches/${(await matchFor(s2.docId)).id}`, { firm_id: FIRM, patch: { status: 'confirmed' } });
  const s3 = await bill({ vendor: 'Quayside Lettings Ltd', date: '2025-07-27', amount: 800 });
  await evaluate(A, s3.docId);
  const sm3 = await matchFor(s3.docId);
  assert.equal(sm3.status, 'auto_matched');
  assert.equal(sm3.payload.authorization.delegated_authority.grant_id, proposed.id);

  // ── 9. Isolation across clients ─────────────────────────────────────────────
  res = await post('partner', '/reconciliation-authority-grants/suspend', { client_id: B, grant_id: proposed.id, reason: 'x' });
  assert.equal(res.status, 403, 'a seat cannot reach a client it is not assigned to');
  res = await post('operator', '/reconciliation-authority-grants/suspend', { client_id: B, grant_id: proposed.id, reason: 'x' });
  assert.equal(res.status, 404, "another client's grant id is not found under this client");
  res = await post('operator', '/reconciliation-authority-grants/mint', { ...mintBody(sm3.id), client_id: B });
  assert.equal(res.status, 404, "another client's match is not found under this client");
  res = await get('operator', `/reconciliation-authority-grants?client_id=${B}`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.grants.length, res.body.delegated_authority_acts], [0, false]);
  await settledPrior({ clientId: B, vendor: 'Harbour Lane Properties Ltd', date: '2024-10-03' });
  const b1 = await bill({ clientId: B, date: '2025-01-08' });
  await evaluate(B, b1.docId);
  const bm1 = await matchFor(b1.docId);
  res = await get('operator', `/reconciliation-authority-grants/preview?client_id=${B}&match_id=${bm1.id}`);
  assert.deepEqual([res.body.preview.eligible, res.body.preview.ineligible_reason], [false, 'delegated_authority_off']);
  res = await post('operator', '/reconciliation-authority-grants/mint', { ...mintBody(bm1.id), client_id: B });
  assert.equal(res.status, 409); assert.equal(res.body.code, 'DELEGATED_AUTHORITY_OFF');
  // Still active on A, untouched by the refused cross-client calls.
  assert.equal((await pool.query('select status from reconciliation_authority_grants where id=$1', [proposed.id])).rows[0].status, 'active');
  assert.ok(modelCalls.length >= 10, `the scripted model decided every bill (${modelCalls.length})`);
});
