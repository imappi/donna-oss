import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import pg from 'pg';
import { prepareCiHostPostgres } from '../../../scripts/prepare_ci_host_postgres.js';
import donnaRouter from '../../../api/donna-router.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../db/pool.js';
import { getSingaporeGstReturnFromDb, createGstReturnDraftInDb, cancelGstReturnInDb,
  getGstReturnByIdInDb, getGstReturnForPeriodInDb, markGstReturnFiledInDb,
  startSingaporeGstReturnFilingInDb } from './statutoryDb.js';
import { resolveGstPeriod } from './gstReturn.js';
import { GST_F5_BOXES, resolveGstEntry } from './gstCodes.js';

import { getSingaporeGstDraftArtifactFromDb } from './gstReturnArtifact.js';
import { readSingaporeGstSourceReadiness } from './gstSourceReadiness.js';
import { retainedNativeMarkerSql } from '../nativeChartLineage.js';
import { extractBankStatementFromBase64 } from '../bankStatement.js';
import { buildStatementPayloadPatch } from '../inngest/parseDocument.js';

const scope = { firmId: 'sg6-firm-a', clientId: 'sg6-client-a' };
const period = resolveGstPeriod('2026-Q2');
const readAt = '2026-09-24T12:00:00.000Z';
const actorId = 'sg6-member-a';
const authUsers = {
  member: { id: 'sg6-user-a', email: 'sg6-a@example.invalid' },
  other: { id: 'sg6-user-b', email: 'sg6-b@example.invalid' },
  owner: { id: 'sg6-user-owner', email: 'sg6-owner@example.invalid' },
  external: { id: 'sg6-user-external', email: 'sg6-external@example.invalid' }
};

// Required evidence, not an optional seam suite. All schemas and mutations are
// confined to a uniquely owned disposable database. No provider calls/asks.
test('SG-6 real PostgreSQL lifecycle and authenticated HTTP draft artifact', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable DONNA_PG_TEST_URL is required for SG-6');
  const config = JSON.parse(await readFile(new URL('../../../vercel.json', import.meta.url), 'utf8'));
  const rewrite = config.rewrites.find(rule => rule.source === '/api/donna/firms/reports/singapore-gst-f5-draft');
  assert.equal(rewrite?.destination, '/api/donna-router?path=firms/reports/singapore-gst-f5-draft');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const database = `sg6_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${database}`;
  let seed, pool, server;
  const closedSockets = [];
  const realFetch = globalThis.fetch;
  const env = { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'sg6-unused-operator-token',
    SUPABASE_URL: 'https://sg6-auth.invalid', SUPABASE_ANON_KEY: 'fixture-only',
    SUPABASE_PUBLISHABLE_KEY: undefined, DONNA_AUTH_ALLOWED_EMAILS: '',
    DONNA_DESKTOP_BLOB_DIR: undefined, SINGAPORE_GST_RETURN: 'true',
    SINGAPORE_GST_RETURN_CLIENTS: '*', CLIENT_CONFIG_FORCE_DISABLE: undefined };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  await admin.query(`create database "${database}"`);
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    globalThis.fetch = realFetch;
    __resetFirmDbPoolForTests();
    if (pool) { await pool.end(); await Promise.all(closedSockets); }
    if (seed) await seed.end();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await admin.query(`drop database "${database}"`);
    await admin.end();
  });
  await prepareCiHostPostgres({ databaseUrl: url.toString() });
  seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const migrationRoot = new URL('../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, migrationRoot), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  t.diagnostic(`PostgreSQL ${(await seed.query('show server_version')).rows[0].server_version}; complete migration chain applied`);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  pool.on('connect', client => closedSockets.push(new Promise(resolve => client.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  globalThis.fetch = async (target, options) => {
    assert.equal(String(target), 'https://sg6-auth.invalid/auth/v1/user', 'no provider or filing network allowed');
    const user = authUsers[String(options.headers.Authorization).replace('Bearer ', '')];
    return new Response(JSON.stringify(user || {}), { status: user ? 200 : 401 });
  };
  // Apply the actual configured hosted rewrite, preserving the request query,
  // then drive the production router and authenticated handler over HTTP.
  server = http.createServer((req, res) => {
    const incoming = new URL(req.url, 'http://fixture');
    if (incoming.pathname !== rewrite.source) { res.statusCode = 404; res.end('{}'); return; }
    const target = new URL(rewrite.destination, 'http://fixture');
    for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
    req.url = target.pathname + target.search;
    donnaRouter(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = ({ token = 'member', firm = scope.firmId, client = scope.clientId,
    key = period.key, extra = '', method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const params = new URLSearchParams({ client_id: client, period: key });
    if (firm !== null) params.set('firm_id', firm);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/donna/firms/reports/singapore-gst-f5-draft?${params}${extra}`,
      method, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.end();
  });
  for (const suffix of ['a', 'b']) {
    await seed.query('insert into firms(id,name,slug) values($1,$1,$1)', [`sg6-firm-${suffix}`]);
    const user = authUsers[suffix === 'a' ? 'member' : 'other'];
    await seed.query(`insert into firm_members(id,firm_id,user_id,email,name,role)
      values($1,$2,$3,$4,'SG6 member','owner')`, [`sg6-member-${suffix}`, `sg6-firm-${suffix}`, user.id, user.email]);
  }
  for (const [id, firm, country, currency] of [
    ['sg6-client-a', scope.firmId, 'SG', 'SGD'], ['sg6-sibling', scope.firmId, 'sg', 'SGD'],
    ['sg6-client-b', 'sg6-firm-b', 'SG', 'SGD'], ['sg6-foreign', scope.firmId, 'GB', 'GBP']
  ]) {
    await seed.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile)
      values($1,$2,$1,$3,$4)`, [id, firm, country, { accountingCurrency: currency, gst_period: 'quarter' }]);
  }
  for (const kind of ['owner', 'external']) {
    const user = authUsers[kind];
    await seed.query(`insert into firm_collaborators(id,firm_id,user_id,email,name,seat_role,affiliation)
      values($1,$2,$3,$4,$1,$5,$6)`, [`sg6-${kind}`, scope.firmId, user.id, user.email,
      kind === 'external' ? 'junior' : null, kind === 'external' ? 'external' : 'internal']);
    await seed.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role)
      values($1,$2,$3,'firm_collaborator',$1,'owner')`, [`sg6-${kind}`, scope.firmId, scope.clientId]);
  }
  const enable = async (client, firm = scope.firmId) => seed.query(`insert into client_capability_config
    (id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,'SINGAPORE_GST_RETURN','canary','manual')`,
  [`flag-${client}`, firm, client]);
  const compute = (overrides = {}) => getSingaporeGstReturnFromDb({ ...scope, period: period.key, readAt, ...overrides });
  const count = async table => Number((await seed.query(`select count(*) from ${table}`)).rows[0].count);

  await t.test('authentication, member scope, identity and config-plane refusal before export', async () => {
    assert.equal((await request({ token: null })).status, 401);
    assert.equal((await request({ token: 'other' })).status, 403);
    assert.equal((await request({ token: 'owner' })).status, 403);
    assert.equal((await request({ token: 'external' })).status, 403);
    assert.equal((await request({ client: 'sg6-client-b' })).status, 404);
    assert.equal((await request()).body.code, 'SINGAPORE_GST_RETURN_DISABLED', 'env pair cannot grant access');
    await enable(scope.clientId); await enable('sg6-sibling'); await enable('sg6-client-b', 'sg6-firm-b');
    await enable('sg6-foreign');
    assert.equal((await request({ client: 'sg6-foreign' })).body.code, 'SINGAPORE_GST_DRAFT_JURISDICTION_REQUIRED');
    assert.equal((await request({ client: '' })).status, 400);
    assert.equal((await request({ key: '2026' })).status, 400);
  });

  // Synthetic historical posted ledger, not SG-8 posting evidence. Standard
  // local supplies only; NO reverse-charge treatment is endorsed by this proof.
  const rate = resolveGstEntry('GST_SR_9_OUTPUT').rate;
  const tax = 1000 * rate / 100;
  const addJournal = async ({ id, client = scope.clientId, firm = scope.firmId, date = '2026-04-01',
    status = 'posted', currency = 'SGD', coded = true, amount = 1000 } = {}) => {
    await seed.query(`insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
      values($1,$2,$3,'sg6_synthetic_fixture',$1,$4,$5,$6)`, [id, firm, client, date, currency, status]);
    const gst = coded ? amount * rate / 100 : 0;
    for (const [number, code, type, debit, credit, taxType, role] of [
      [1, '3000', 'revenue', 0, amount, coded ? 'GST_SR_9_OUTPUT' : null, null],
      [2, '2950', 'liability', 0, gst, null, 'gst_output'],
      [3, '1910', 'asset', amount + gst, 0, null, null]
    ]) {
      const account = `${client}-${code}`;
      await seed.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,currency)
        values($1,$2,$3,$4,$4,$5,$6) on conflict do nothing`, [account, firm, client, code, type, currency]);
      await seed.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,line_no,
        direction,debit,credit,amount,currency,tax_type,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`${id}-${number}`, id, firm, client, account, code, number, debit ? 'debit' : 'credit',
        debit, credit, debit || credit, currency, taxType, role ? { role } : {}]);
    }
  };
  await addJournal({ id: 'sg6-ready' });
  await addJournal({ id: 'sg6-draft', status: 'draft', amount: 2000 });
  await addJournal({ id: 'sg6-outside', date: '2026-03-31', amount: 3000 });
  await addJournal({ id: 'sg6-decoy', client: 'sg6-sibling', amount: 7000 });
  await addJournal({ id: 'sg6-firm-decoy', firm: 'sg6-firm-b', client: 'sg6-client-b', amount: 9000 });
  let ready, draft;
  await t.test('registered HTTP serializer preserves exact computation, source and draft meaning without writes', async () => {
    ready = await compute();
    assert.equal(ready.review.status, 'ready');
    assert.equal(ready.gstReturn.boxes['1'], 1000);
    assert.equal(ready.gstReturn.boxes['6'], tax);
    assert.equal(ready.gstReturn.boxes['8'], tax);
    assert.equal(ready.gstReturn.boxes['13'], 1000);
    const before = await count('audit_events');
    const response = await request({ firm: null }); // actual browser-style authenticated firm default
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers['content-disposition'], 'attachment; filename="donna-sg-gst-f5-draft-2026-Q2.json"');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const artifact = response.body;
    assert.equal(artifact.artifact_type, 'singapore_gst_f5_draft');
    assert.equal(artifact.scope, 'draft_for_firm_review');
    assert.equal(artifact.currency, 'SGD');
    assert.equal(artifact.firm_id, scope.firmId); assert.equal(artifact.client_id, scope.clientId);
    assert.deepEqual(artifact.period, period);
    assert.deepEqual(artifact.gstReturn, ready.gstReturn);
    assert.deepEqual(artifact.review, ready.review);
    assert.deepEqual(artifact.box_definitions, GST_F5_BOXES);
    assert.deepEqual(artifact.provenance.boxMap, ready.provenance.boxMap);
    assert.equal(artifact.provenance.boxMap.confirmedAgainstPrimary, ready.provenance.boxMap.confirmedAgainstPrimary);
    assert.equal(artifact.as_of, artifact.provenance.readAt);
    assert.ok(Number.isFinite(Date.parse(artifact.as_of)));
    assert.equal(artifact.filing.submitted, false);
    assert.match(artifact.limitations.join(' '), /not yet coded or split at posting.*Qualified professional review is still pending/);
    assert.equal(await count('gst_returns'), 0);
    assert.equal(await count('client_evidence_requests'), 0);
    assert.equal(await count('audit_events'), before);
    const repeat = await request();
    assert.deepEqual(repeat.body.gstReturn, artifact.gstReturn);
    assert.equal((await request({ client: 'sg6-sibling' })).body.gstReturn.boxes['1'], 7000);
    assert.equal((await request({ token: 'other', firm: 'sg6-firm-b', client: 'sg6-client-b' })).body.gstReturn.boxes['1'], 9000);
  });

  await t.test('ready draft persists once; scoped readers and duplicate period guard use real storage', async () => {
    draft = await createGstReturnDraftInDb({ ...scope, period, verdict: ready, actorId });
    assert.equal(draft.status, 'draft_pending_confirmation');
    assert.deepEqual(draft.verdict, ready);
    assert.equal(draft.created_by, actorId);
    assert.equal(draft.filing_receipt, null);
    assert.deepEqual(await getGstReturnByIdInDb({ ...scope, gstReturnId: draft.id }), draft);
    assert.equal((await getGstReturnForPeriodInDb({ ...scope, periodKey: '2026-q2' })).id, draft.id);
    assert.equal(await getGstReturnByIdInDb({ firmId: 'sg6-firm-b', clientId: scope.clientId, gstReturnId: draft.id }), null);
    assert.equal(await getGstReturnByIdInDb({ ...scope, clientId: 'sg6-sibling', gstReturnId: draft.id }), null);
    await assert.rejects(createGstReturnDraftInDb({ ...scope, period, verdict: ready, actorId }), { code: 'GST_RETURN_ALREADY_LIVE' });
    const events = (await seed.query("select * from audit_events where resource_id=$1 and action='gst_return.draft_created'", [draft.id])).rows;
    assert.equal(events.length, 1); assert.equal(events[0].actor_id, actorId);
    assert.equal(events[0].metadata.payable, tax); assert.equal(events[0].metadata.model, null);
    const sibling = await createGstReturnDraftInDb({ ...scope, clientId: 'sg6-sibling', period, verdict: await compute({ clientId: 'sg6-sibling' }), actorId });
    assert.notEqual(sibling.id, draft.id);
    await cancelGstReturnInDb({ ...scope, clientId: 'sg6-sibling', gstReturnId: sibling.id, actorId });
  });

  await t.test('writer refuses foreign firm/client pairs before creating a row or audit', async () => {
    const before = await count('gst_returns');
    const audits = await count('audit_events');
    await assert.rejects(createGstReturnDraftInDb({ ...scope, clientId: 'sg6-missing', period, verdict: ready, actorId }), { statusCode: 404 });
    await assert.rejects(createGstReturnDraftInDb({ ...scope, firmId: 'sg6-firm-b', period, verdict: ready, actorId }), { statusCode: 404 });
    assert.equal(await count('gst_returns'), before);
    assert.equal(await count('audit_events'), audits);
  });

  await t.test('draft boundary rechecks arithmetic and canonical period; valid quarter and month remain available', async () => {
    const before = await count('gst_returns');
    const audits = await count('audit_events');
    const nil = await compute({ period: '2026-Q3' });
    await assert.rejects(createGstReturnDraftInDb({ ...scope, period: { ...nil.period, ends_on: '2026-08-31' }, verdict: nil, actorId }),
      { code: 'SINGAPORE_GST_PERIOD_INVALID' });
    const invalid = structuredClone(ready);
    invalid.gstReturn.boxes['4'] += 1;
    await assert.rejects(createGstReturnDraftInDb({ ...scope, period, verdict: invalid, actorId }),
      { code: 'SINGAPORE_GST_RETURN_MISFOOT' });
    await assert.rejects(createGstReturnDraftInDb({ ...scope, period: nil.period, verdict: ready, actorId }),
      { code: 'SINGAPORE_GST_PERIOD_INVALID' });
    assert.equal(await count('gst_returns'), before);
    assert.equal(await count('audit_events'), audits);
    assert.equal(await getGstReturnForPeriodInDb({ ...scope, periodKey: nil.period.key }), null);
    const validQuarter = await createGstReturnDraftInDb({ ...scope, period: nil.period, verdict: nil, actorId });
    await cancelGstReturnInDb({ ...scope, gstReturnId: validQuarter.id, actorId });
    const monthly = await compute({ period: '2026-12' });
    const { period: omitted, ...withoutPeriod } = monthly;
    const validMonth = await createGstReturnDraftInDb({ ...scope, period: omitted, verdict: withoutPeriod, actorId });
    assert.equal(validMonth.period_type, 'month');
    assert.equal(validMonth.verdict.period, undefined, 'legacy filing start omits verdict.period');
    await cancelGstReturnInDb({ ...scope, gstReturnId: validMonth.id, actorId });
  });

  await t.test('audit failure rolls back draft and cancellation; valid cancel permits a fresh draft; stale transition refuses', async () => {
    await seed.query(`create function sg6_refuse_audit() returns trigger language plpgsql as $$
      begin if new.action in ('gst_return.draft_created','gst_return.cancelled') then raise exception 'SG6_AUDIT_FAILURE'; end if; return new; end $$;
      create trigger sg6_audit_failure before insert on audit_events for each row execute function sg6_refuse_audit()`);
    const before = await count('gst_returns');
    await assert.rejects(createGstReturnDraftInDb({ ...scope, period: resolveGstPeriod('2026-Q3'), verdict: await compute({ period: '2026-Q3' }), actorId }), /SG6_AUDIT_FAILURE/);
    assert.equal(await count('gst_returns'), before);
    await assert.rejects(cancelGstReturnInDb({ ...scope, gstReturnId: draft.id, actorId }), /SG6_AUDIT_FAILURE/);
    assert.equal((await getGstReturnByIdInDb({ ...scope, gstReturnId: draft.id })).status, 'draft_pending_confirmation');
    await seed.query('drop trigger sg6_audit_failure on audit_events');
    await assert.rejects(cancelGstReturnInDb({ ...scope, clientId: 'sg6-sibling', gstReturnId: draft.id, actorId }), { code: 'GST_RETURN_NOT_PENDING' });
    const basis = { source: 'sg6_synthetic_owner_cancellation' };
    const cancelled = await cancelGstReturnInDb({ ...scope, gstReturnId: draft.id, actorId, authorityBasis: basis, reason: 'fixture_cancel' });
    assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.authority_basis, basis);
    const audit = (await seed.query("select * from audit_events where resource_id=$1 and action='gst_return.cancelled'", [draft.id])).rows[0];
    assert.equal(audit.actor_id, actorId); assert.deepEqual(audit.metadata.authority_basis, basis);
    await assert.rejects(cancelGstReturnInDb({ ...scope, gstReturnId: draft.id, actorId }), { code: 'GST_RETURN_NOT_PENDING' });
    await assert.rejects(markGstReturnFiledInDb({ ...scope, gstReturnId: draft.id, actorId }), { code: 'GST_RETURN_AUTHORITY_REQUIRED' });
    await assert.rejects(markGstReturnFiledInDb({ ...scope, gstReturnId: draft.id, actorId, authorityBasis: { source: 'synthetic_storage_only' } }), { code: 'GST_RETURN_NOT_PENDING' });
    const replacement = await createGstReturnDraftInDb({ ...scope, period, verdict: ready, actorId });
    assert.notEqual(replacement.id, draft.id);
    assert.equal((await getGstReturnForPeriodInDb({ ...scope, periodKey: period.key })).id, replacement.id);
    await cancelGstReturnInDb({ ...scope, gstReturnId: replacement.id, actorId });
  });

  await t.test('unready and nil computations keep their exact source status; no draft or filing activation', async () => {
    await addJournal({ id: 'sg6-uncoded', date: '2026-07-01', coded: false });
    const unready = await compute({ period: '2026-Q3' });
    assert.equal(unready.review.status, 'needs_review');
    assert.ok(unready.review.blockers.includes('uncoded_revenue_lines'));
    const response = await request({ key: '2026-Q3' });
    assert.equal(response.status, 200); assert.deepEqual(response.body.review, unready.review);
    assert.equal(response.body.filing.submitted, false);
    await assert.rejects(createGstReturnDraftInDb({ ...scope, period: unready.period, verdict: unready, actorId }), { code: 'GST_RETURN_NEEDS_REVIEW' });
    assert.equal((await getGstReturnForPeriodInDb({ ...scope, periodKey: '2026-Q3' })).status, 'cancelled', 'no replacement draft for an unready computation');
    const nil = await request({ key: '2026-Q4' });
    assert.equal(nil.body.gstReturn.nilReturn, true); assert.equal(nil.body.review.status, 'ready');
    assert.equal(nil.body.scope, 'draft_for_firm_review');
    assert.deepEqual(nil.body.provenance.boxMap, (await compute({ period: '2026-Q4' })).provenance.boxMap);
    // Gross-only posting (SG-8 unbuilt): a fully posted, gross-coded period
    // exported through the real route is not ready; the coded Q2 fixture is.
    await seed.query(`insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
      values('sg6-gross','${scope.firmId}','${scope.clientId}','sg6_synthetic_fixture','sg6-gross','2027-01-15','SGD','posted')`);
    for (const [n, code, type, debit, credit, taxType] of [[1, '7000', 'expense', 1090, 0, 'INPUTY24'], [2, '1910', 'asset', 0, 1090, null]]) {
      const account = `${scope.clientId}-${code}`;
      await seed.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,currency)
        values($1,$2,$3,$4,$4,$5,'SGD') on conflict do nothing`, [account, scope.firmId, scope.clientId, code, type]);
      await seed.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,line_no,
        direction,debit,credit,amount,currency,tax_type,payload)
        values($1,'sg6-gross',$2,$3,$4,$5,$6,$7,$8,$9,$10,'SGD',$11,'{}')`,
      [`sg6-gross-${n}`, scope.firmId, scope.clientId, account, code, n, debit ? 'debit' : 'credit', debit, credit, debit || credit, taxType]);
    }
    const gross = await request({ key: '2027-Q1' });
    assert.equal(gross.status, 200);
    assert.equal(gross.body.review.status, 'needs_review');
    assert.ok(gross.body.review.blockers.includes('gst_not_coded_at_posting'));
    assert.equal(gross.body.gstReturn.nilReturn, true);
    assert.equal((await request()).body.review.status, 'ready', 'the correctly coded fixture stays ready');
    await assert.rejects(startSingaporeGstReturnFilingInDb({ ...scope, period: period.key, actorId }), { code: 'SINGAPORE_GST_FILING_DISABLED' });
    assert.equal(await count('client_evidence_requests'), 0);
    assert.equal(await count('corppass_mandates'), 0);
  });

  await proveSourceReadiness({ t, seed, pool, request, enable, addJournal, firmId: scope.firmId, readAt });

  await t.test('current identity, profile conflicts and ledger denomination cannot be relabelled SGD', async () => {
    for (const profile of [{}, { accountingCurrency: 'USD' }, { accountingCurrency: 'SGD', baseCurrency: 'USD' },
      { accountingCurrency: 'SGD', jurisdiction: 'GB' }]) {
      await seed.query('update clients set profile=$1 where id=$2', [profile, scope.clientId]);
      assert.equal((await request({ extra: '&currency=SGD&jurisdiction=SG' })).status, 409);
    }
    await seed.query('update clients set profile=$1 where id=$2', [{ accountingCurrency: 'SGD' }, scope.clientId]);
    await addJournal({ id: 'sg6-foreign-currency', date: '2026-10-01', currency: 'USD' });
    assert.equal((await request({ key: '2026-Q4' })).body.code, 'SINGAPORE_GST_DRAFT_LEDGER_IDENTITY_INVALID');
    assert.equal((await request()).status, 200, 'neighboring SGD period remains available');
  });
});

// Supplement to SG-6's existing full-schema HTTP harness. These are synthetic
// persisted source/lifecycle fixtures, not a second intake or posting proof.
const proveSourceReadiness = async ({ t, seed, pool, request, enable, addJournal, firmId, readAt }) => {
  const clientId = 'sg6b-processing';
  const args = { firmId, clientId, readAt, period: '2026-Q3' };
  await seed.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
    values($1,$2,'SG6B synthetic processing client','SG','sg-pte',$3)`,
  [clientId, firmId, { legalForm: 'sg-pte', accountingCurrency: 'SGD', accountingSystem: 'none', serviceScope: 'management_books' }]);
  await enable(clientId);
  const get = async (key = '2026-Q3') => {
    const response = await request({ client: clientId, key });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const doc = async (id, { status = 'completed', type = 'supplier_bill', date = '2026-09-30',
    summary = {}, duplicate = null, payload = {}, client = clientId, firm = firmId } = {}) => {
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,document_date,
      parse_status,parse_summary,duplicate_of,total_amount,payload,uploaded_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,100,$10,'2026-10-15')`,
    [id, firm, client, `${id}-October-2026.pdf`, type, date, status, summary, duplicate, payload]);
  };
  const tx = async (id, source, date = '2026-09-30', client = clientId, coding = 'proposed') => {
    await seed.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,
      description,money_out,currency,coding_state) values($1,$2,$3,$4,$5,$1,100,'SGD',$6)`,
    [id, firmId, client, source, date, coding]);
  };
  const concerns = artifact => artifact.source_readiness.concerns;
  const ids = artifact => concerns(artifact).map(row => row.target_id).sort();
  const noWrites = async fn => {
    const tables = ['documents', 'transactions', 'ledger_journals', 'ledger_lines', 'gst_returns',
      'client_evidence_requests', 'audit_events', 'client_capability_config', 'reconciliation_matches'];
    const snapshot = async () => {
      const result = {};
      for (const table of tables) result[table] = (await seed.query(`select to_jsonb(r) as row from ${table} r order by id`)).rows;
      return result;
    };
    const before = await snapshot();
    const value = await fn();
    assert.deepEqual(await snapshot(), before, 'export performs zero persisted side effects');
    return value;
  };

  await t.test('empty posted input remains arithmetically nil but unfinished local sources change review', async () => {
    const empty = await get();
    assert.equal(empty.source_readiness.observation, 'no_local_sources');
    assert.equal(empty.review.status, 'ready');
    await doc('sg6b-invoice');
    await doc('sg6b-statement', { type: 'bank_statement', date: null,
      payload: { statement_summary: { period_start: '2026-09-01', period_end: '2026-09-30' } },
      summary: { period_start_date: '2026-09-01', period_end_date: '2026-09-30', statement_period: '2026-09', transaction_count: 3 } });
    for (let n = 1; n <= 3; n++) await tx(`sg6b-bank-${n}`, 'sg6b-statement');
    const raw = await getSingaporeGstReturnFromDb(args);
    assert.equal(raw.review.status, 'ready', 'pins original ledger-only ready-nil observation');
    assert.equal(raw.gstReturn.nilReturn, true);
    const draft = await noWrites(get);
    assert.deepEqual(draft.gstReturn, empty.gstReturn);
    assert.deepEqual(draft.calculation_review, raw.review);
    assert.equal(draft.review.status, 'needs_review');
    assert.deepEqual(ids(draft), ['sg6b-bank-1', 'sg6b-bank-2', 'sg6b-bank-3', 'sg6b-invoice']);
    assert.equal(draft.source_readiness.transactions.length, 3, 'no review sidecar required');
    await assert.rejects(createGstReturnDraftInDb({ firmId, clientId, period: draft.period, verdict: draft }),
      { code: 'GST_RETURN_NEEDS_REVIEW' });
    assert.equal((await get('2026-Q2')).source_readiness.observation, 'no_local_sources');
  });

  await t.test('unknown period stays explicit across periods; no filename or upload-time attribution', async () => {
    await doc('sg6b-pending', { type: 'unknown', status: 'pending', date: null });
    for (const key of ['2026-Q2', '2026-Q3', '2026-Q4']) {
      const result = await get(key);
      const item = concerns(result).find(row => row.target_id === 'sg6b-pending');
      assert.equal(item.period_scope, 'period_unknown');
      assert.deepEqual(item.reasons, ['period_unknown', 'source_processing']);
      assert.equal(result.review.status, 'needs_review');
      assert.equal(result.gstReturn.nilReturn, true);
    }
    await seed.query("update documents set parse_status='failed', duplicate_of='sg6b-invoice' where id='sg6b-pending'");
    assert.equal((await get('2026-Q2')).source_readiness.observation, 'no_local_sources');
  });

  await t.test('source failures own their consequences once; known intervals and boundaries are inclusive', async () => {
    await doc('sg6b-failed', { type: 'bank_statement', status: 'failed', date: null,
      payload: { statement_summary: { period_start: '2026-09-30', period_end: '2026-10-01' } },
      summary: { period_start_date: '2026-09-30', period_end_date: '2026-10-01', statement_period: '2026-09-30 to 2026-10-01' } });
    await tx('sg6b-failed-child-a', 'sg6b-failed');
    await tx('sg6b-failed-child-b', 'sg6b-failed');
    const result = await get();
    const item = concerns(result).find(row => row.target_id === 'sg6b-failed');
    assert.deepEqual(item.related_transaction_ids, ['sg6b-failed-child-a', 'sg6b-failed-child-b']);
    assert.ok(!ids(result).includes('sg6b-failed-child-a'));
    assert.equal(result.source_readiness.transactions.filter(row => row.document_id === 'sg6b-failed').length, 2);
    assert.ok(ids(await get('2026-Q4')).includes('sg6b-failed'));
    assert.ok(!ids(await get('2026-Q2')).includes('sg6b-failed'));
    await doc('sg6b-known-pending', { status: 'processing', type: 'bank_statement', date: null,
      payload: { statement_summary: { period_start: '2026-10-01', period_end: '2026-10-31' } },
      summary: { period_start_date: '2026-10-01', period_end_date: '2026-10-31', statement_period: '2026-10' } });
    assert.ok(!ids(await get()).includes('sg6b-known-pending'));
    assert.ok(ids(await get('2026-Q4')).includes('sg6b-known-pending'));
    await doc('sg6b-zero-statement', { type: 'bank_statement',
      payload: { statement_summary: { period_start: '2026-09-01', period_end: '2026-09-30' } },
      summary: { transaction_count: 0, statement_period: '2026-09' } });
    assert.ok(concerns(await get()).find(row => row.target_id === 'sg6b-zero-statement').reasons.includes('statement_import_unverified'));
  });

  await t.test('declared malformed intervals and observed-row bounds cannot hide uncertain source coverage', async () => {
    for (const [id, summary] of [
      ['sg6b-activity-only', { period_start_date: '2026-10-01', period_end_date: '2026-10-31' }],
      ['sg6b-partial-period', { period_start_date: '2026-10-01' }],
      ['sg6b-malformed-period', { statement_period: 'not a period' }],
      ['sg6b-invalid-period', { period_start_date: '2026-02-30', period_end_date: '2026-03-31' }],
      ['sg6b-conflicting-period', { period_start_date: '2026-10-01', period_end_date: '2026-10-31', statement_period: '2026-09' }]
    ]) {
      await doc(id, { type: 'bank_statement', status: 'pending', date: '2026-10-01', summary });
      const item = (await get()).source_readiness.documents.find(row => row.id === id);
      assert.equal(item.period_scope, 'period_unknown', `${id}: out-of-period fallback must not hide source`);
      assert.equal(item.dates, null);
      await seed.query('update documents set parse_status=$2,duplicate_of=$3 where id=$1', [id, 'failed', 'sg6b-invoice']);
    }
    await doc('sg6b-no-interval', { type: 'bank_statement', status: 'pending', date: null });
    await tx('sg6b-no-interval-child', 'sg6b-no-interval', '2026-10-01');
    const incomplete = (await get()).source_readiness.documents.find(row => row.id === 'sg6b-no-interval');
    assert.equal(incomplete.period_scope, 'period_unknown');
    assert.equal(incomplete.observed_activity_dates.starts_on, '2026-10-01');
    await seed.query("update documents set parse_status='failed',duplicate_of='sg6b-invoice' where id='sg6b-no-interval'");
    await doc('sg6b-dated-neighbor', { status: 'pending', date: '2026-10-01' });
    assert.ok(!ids(await get()).includes('sg6b-dated-neighbor'));
    await doc('sg6b-header-range', { type: 'bank_statement', status: 'pending', date: null,
      payload: { statement_summary: { period_start: '2026-09-01', period_end: '2026-09-30' } },
      summary: { period_start_date: '2026-09-15', period_end_date: '2026-09-20', statement_period: '2026-09' } });
    const header = (await get()).source_readiness.documents.find(row => row.id === 'sg6b-header-range');
    assert.equal(header.dates.starts_on, '2026-09-01');
    assert.equal(header.dates.ends_on, '2026-09-30');
    assert.ok(!ids(await get('2026-Q4')).includes('sg6b-header-range'));
  });

  await t.test('real extractor labels do not establish coverage; persisted printed headers do', async () => {
    const csv = 'Date,Description,Debit,Credit,Balance,Currency\n'
      + '2026-09-15,Office supplies,100,,900,SGD\n'
      + '2026-09-16,Tax payment,20,,880,SGD\n'
      + '2026-09-20,Transfer,30,,850,SGD\n';
    const printed = 'Statement period: 2026-09-01 to 2026-09-30\n';
    for (const [id, prefix, filename, expected] of [
      ['sg6b-real-header', printed, 'source.csv', 'in_period'],
      ['sg6b-real-activity', '', 'source.csv', 'period_unknown'],
      ['sg6b-real-filename', '', '2026-10-01-to-2026-10-31.csv', 'period_unknown'],
      ['sg6b-real-conflict', printed, '2026-10-01-to-2026-10-31.csv', 'period_unknown']
    ]) {
      const extracted = await extractBankStatementFromBase64({
        base64: Buffer.from(prefix + csv).toString('base64'), filename,
        mimeType: 'text/csv', ledgerCurrency: 'SGD', llmFirst: false
      });
      assert.equal(extracted.transactions.length, 3);
      const payload = buildStatementPayloadPatch(extracted) || {};
      if (prefix) assert.deepEqual(
        [payload.statement_summary.period_start, payload.statement_summary.period_end], ['2026-09-01', '2026-09-30']);
      else assert.ok(!payload.statement_summary?.period_start, 'headerless CSV has no canonical period');
      assert.equal(extracted.period_label, filename === 'source.csv'
        ? (prefix ? '2026-09-01 to 2026-09-30' : '2026-09') : '2026-10-01 to 2026-10-31');
      await doc(id, { type: 'bank_statement', date: null, payload,
        summary: { source: 'async_parse', transaction_count: 3, statement_period: extracted.period_label,
          period_start_date: '2026-09-15', period_end_date: '2026-09-20' } });
      for (const [index, row] of extracted.transactions.entries()) await tx(`${id}-${index}`, id, row.date);
      const item = (await noWrites(get)).source_readiness.documents.find(row => row.id === id);
      assert.equal(item.period_scope, expected, id);
      assert.deepEqual([item.observed_activity_dates.starts_on, item.observed_activity_dates.ends_on],
        ['2026-09-15', '2026-09-20']);
      if (expected === 'in_period') {
        assert.deepEqual(item.dates, { starts_on: '2026-09-01', ends_on: '2026-09-30', basis: 'persisted_statement_header' });
        assert.deepEqual(item.reasons, []);
        assert.ok(!(await get('2026-Q4')).source_readiness.documents.some(row => row.id === id));
      } else {
        assert.equal(item.dates, null);
        assert.deepEqual(item.reasons, ['period_unknown']);
        for (const key of ['2026-Q2', '2026-Q4']) {
          const unknown = (await get(key)).source_readiness.documents.find(row => row.id === id);
          assert.equal(unknown.period_scope, 'period_unknown');
        }
        await seed.query('update documents set parse_status=$2,duplicate_of=$3 where id=$1', [id, 'failed', 'sg6b-invoice']);
      }
    }
  });

  await t.test('header shapes and conflicting period evidence fail closed; legacy header survives', async () => {
    const header = { period_start: '2026-10-01', period_end: '2026-10-31' };
    for (const [id, payload, summary] of [
      ['missing', {}, { statement_period: '2026-10' }],
      ['malformed', { statement_summary: '2026-10' }, {}],
      ['array', { statement_summary: [header] }, {}],
      ['partial', { statement_summary: { period_start: '2026-10-01' } }, {}],
      ['invalid', { statement_summary: { period_start: '2026-02-30', period_end: '2026-10-31' } }, {}],
      ['reversed', { statement_summary: { period_start: '2026-10-31', period_end: '2026-10-01' } }, {}],
      ['homes-conflict', { statement_summary: header, statementSummary: { period_start: '2026-09-01', period_end: '2026-09-30' } }, {}],
      ['activity-conflict', { statement_summary: header }, { period_start_date: '2026-09-30', period_end_date: '2026-10-15' }],
      ['activity-partial', { statement_summary: header }, { period_start_date: '2026-10-15' }],
      ['label-malformed', { statement_summary: header }, { statement_period: 'not a period' }],
      ['label-conflict', { statement_summary: header }, { statement_period: '2026-09' }]
    ]) {
      const target = `sg6b-header-${id}`;
      await doc(target, { type: 'bank_statement', status: 'pending', date: '2026-10-01', payload, summary });
      const item = (await get()).source_readiness.documents.find(row => row.id === target);
      assert.equal(item.period_scope, 'period_unknown', id);
      assert.equal(item.dates, null, id);
      await seed.query('update documents set parse_status=$2,duplicate_of=$3 where id=$1', [target, 'failed', 'sg6b-invoice']);
    }
    for (const [id, payload] of [
      ['legacy', { statementSummary: header }],
      ['both', { statement_summary: header, statementSummary: header }]
    ]) {
      const target = `sg6b-header-${id}`;
      await doc(target, { type: 'bank_statement', status: 'pending', date: null, payload,
        summary: { source: 'documents_sync', transaction_count: 0 } });
      assert.ok(!(await get()).source_readiness.documents.some(row => row.id === target));
      const item = (await get('2026-Q4')).source_readiness.documents.find(row => row.id === target);
      assert.equal(item.period_scope, 'in_period');
      assert.equal(item.dates.basis, 'persisted_statement_header');
    }
  });

  await t.test('matched is not posted; rejected and superseded verdicts do not settle a source', async () => {
    await seed.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,
      matched_object_type,matched_object_id,status) values('sg6b-match',$1,$2,'sg6b-bank-1','supplier_bill','sg6b-invoice','confirmed')`, [firmId, clientId]);
    const matched = await get();
    assert.ok(ids(matched).includes('sg6b-bank-1'));
    assert.ok(!ids(matched).includes('sg6b-invoice'), 'bank concern carries exact matched document identity');
    assert.deepEqual(concerns(matched).find(row => row.target_id === 'sg6b-bank-1').matched_document_ids, ['sg6b-invoice']);
    await seed.query("update reconciliation_matches set status='rejected' where id='sg6b-match'");
    assert.ok(ids(await get()).includes('sg6b-invoice'));
    await doc('sg6b-collapsed', { status: 'skipped', date: null, duplicate: 'sg6b-invoice' });
    assert.ok(!ids(await get()).includes('sg6b-collapsed'));
    await doc('sg6b-unclassified', { type: 'unknown' });
    assert.ok(concerns(await get()).find(row => row.target_id === 'sg6b-unclassified').reasons.includes('source_state_unknown'));
    await doc('sg6b-duplicate-question', { status: 'duplicate_pending' });
    assert.ok(concerns(await get()).find(row => row.target_id === 'sg6b-duplicate-question').reasons.includes('duplicate_unresolved'));
    await doc('sg6b-no-settlement', { payload: { no_line_disposition: { decision_engine: 'jev',
      disposition: 'no_settlement', accounting_complete: false, evidence_packet_sha256: 'synthetic',
      scope: { transaction_ids: [], absence_proven: false } } } });
    const assessed = (await get()).source_readiness.documents.find(row => row.id === 'sg6b-no-settlement');
    assert.equal(assessed.convergence.reason, 'no_settlement_in_scope');
    assert.ok(assessed.reasons.includes('document_unfinished'));
  });

  await t.test('separate posted neighbor, terminal disposition and other scopes remain honest', async () => {
    // Supplementary historical accounting fixture, never posted into processing client.
    const postedClient = 'sg6-sibling';
    await doc('sg6b-posted-statement', { client: postedClient, type: 'bank_statement',
      payload: { statement_summary: { period_start: '2026-09-01', period_end: '2026-09-30' } },
      summary: { statement_period: '2026-09' } });
    await tx('sg6b-posted-tx', 'sg6b-posted-statement', '2026-09-30', postedClient, 'posted');
    await addJournal({ id: 'sg6b-posted-journal', client: postedClient, date: '2026-09-30' });
    await seed.query("update ledger_journals set source_type='transaction',source_id='sg6b-posted-tx' where id='sg6b-posted-journal'");
    await doc('sg6b-posted-doc', { client: postedClient });
    await seed.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,
      matched_object_type,matched_object_id,status) values('sg6b-posted-match',$1,$2,'sg6b-posted-tx','supplier_bill','sg6b-posted-doc','confirmed')`, [firmId, postedClient]);
    await doc('sg6b-terminal-doc', { client: postedClient, payload: { no_line_disposition: { disposition: 'auto_explain' } } });
    const neighbor = await request({ client: postedClient, key: '2026-Q3' });
    assert.equal(neighbor.status, 200);
    assert.equal(neighbor.body.review.status, 'ready');
    assert.deepEqual(concerns(neighbor.body), []);
    assert.ok(!JSON.stringify((await get()).source_readiness).includes('sg6b-posted'));
    await doc('sg6b-other-firm', { client: 'sg6-client-b', firm: 'sg6-firm-b', status: 'pending', date: null });
    assert.ok(!JSON.stringify((await get()).source_readiness).includes('sg6b-other-firm'));
    const empty = await get('2026-Q1');
    assert.equal(empty.source_readiness.observation, 'no_local_sources');
    assert.match(empty.source_readiness.assumptions.join(' '), /does not.*filing qualification/);
  });

  await t.test('one read-only snapshot survives a concurrent source transition; next export refreshes', async () => {
    const connection = await pool.connect();
    const queries = [];
    let changed = false;
    const wrapped = { query: async (sql, values) => {
      queries.push(sql);
      const result = await connection.query(sql, values);
      if (!changed && sql.includes('from documents where firm_id')) {
        changed = true;
        await seed.query("update documents set parse_status='failed',duplicate_of='sg6b-invoice' where id='sg6b-known-pending'");
      }
      return result;
    } };
    try {
      const observed = await getSingaporeGstDraftArtifactFromDb({ ...args, period: '2026-Q4', withFirmDbClientFn: fn => fn(wrapped) });
      assert.equal(observed.source_readiness.documents.find(row => row.id === 'sg6b-known-pending').parse_status, 'processing');
      assert.ok(ids(observed).includes('sg6b-known-pending'));
      assert.equal(queries[0], 'begin isolation level repeatable read read only');
      assert.equal(queries.at(-1), 'commit');
      const normalize = sql => sql.replace(/\s+/g, ' ').trim();
      const nativeDiscovery = normalize(`with targets as materialized (select id,firm_id,client_id from transactions
        where firm_id=$1 and id=any($2::text[])), scopes as materialized (
          select distinct firm_id,client_id from targets
        ), marked as materialized (select * from scopes t where ${retainedNativeMarkerSql('t')})
        select t.id,t.client_id from targets t join marked m on m.firm_id=t.firm_id and m.client_id=t.client_id order by t.id`);
      const assertReadOnlyQueries = statements => {
        assert.equal(statements[0], 'begin isolation level repeatable read read only');
        assert.equal(statements.at(-1), 'commit');
        assert.equal(statements.filter(sql => /^\s*begin\b/i.test(sql)).length, 1);
        assert.equal(statements.filter(sql => /^\s*commit\b/i.test(sql)).length, 1);
        assert.ok(statements.slice(1, -1).every(sql => /^\s*select\b/i.test(sql)
          || normalize(sql) === nativeDiscovery), 'only SELECTs and the exact native discovery CTE; no nested controls');
      };
      assertReadOnlyQueries(queries);
      assert.equal(queries.filter(sql => normalize(sql) === nativeDiscovery).length, 1, 'the actual native discovery read ran');
      for (const forbidden of [
        'with changed as (delete from transactions returning id) select * from changed',
        'begin', 'commit', 'savepoint nested', 'rollback'
      ]) assert.throws(() => assertReadOnlyQueries([queries[0], forbidden, ...queries.slice(1)]));
    } finally { connection.release(); }
    assert.ok(!ids(await get('2026-Q4')).includes('sg6b-known-pending'));
  });

  await t.test('query failure and short convergence gathers refuse, never empty readiness', async () => {
    const connection = await pool.connect();
    try {
      for (const failure of ['query', 'short']) {
        const wrapped = { query: async (sql, values) => {
          if (failure === 'query' && sql.includes('from documents where firm_id')) throw Object.assign(new Error('SG6B_SOURCE_QUERY_FAILED'), { code: '42P01' });
          if (failure === 'short' && sql.includes('from transactions t')) return { rows: [] };
          return connection.query(sql, values);
        } };
        await assert.rejects(readSingaporeGstSourceReadiness({ ...args, period: resolveGstPeriod(args.period), client: wrapped }),
          failure === 'query' ? { code: '42P01' } : { code: 'SINGAPORE_GST_SOURCE_READ_INCOMPLETE' });
      }
    } finally { connection.release(); }
    await noWrites(get);
    assert.equal(Number((await seed.query('select count(*) from ledger_journals where client_id=$1', [clientId])).rows[0].count), 0);
    await seed.query("update documents set duplicate_of='sg6b-other-firm' where id='sg6b-collapsed'");
    const foreign = await request({ client: clientId, key: '2026-Q3' });
    assert.equal(foreign.status, 409);
    assert.equal(foreign.body.code, 'SINGAPORE_GST_SOURCE_READ_INCOMPLETE');
    await seed.query("update documents set duplicate_of='sg6b-invoice' where id='sg6b-collapsed'");
  });
};
