// 2026-09-21 — hosted Kampaamo: one failed SYNTHETIC storage probe turned the
// host certificate INCOMPLETE, revoked every enrolled entity's admission and
// stamped all 36 bank lines of a batch Stalled (3 auto_reconciled, 23 on the
// owner, 10 hanging). This proof drives the real readiness → activity →
// rendering path on real PostgreSQL with the real local evidence adapter, the
// real Host A observer, real Entity B provisioning, the real admission
// evaluator, the real firm snapshot and the mounted period classifier:
//
//  1. the synthetic probe fails while real storage operations work — the host
//     stays PASS, admission stays allowed, settled rows keep their outcomes;
//  2. a real upload failure is its own isolated receipt;
//  3. an incompatible host (schema) still blocks the mutation, while the batch
//     is a bounded shared wait and settled rows are preserved;
//  4. recovery resumes the same rows without recreating the company or the
//     material; 5. an unrelated upload does not reopen settled rows.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { buildDesktopHandlerManifest } from './desktop/handlerManifest.js';
import { createLocalScheduler } from './desktop/localScheduler.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, createClientInDb, getFirmSnapshotFromDb, queryFirmDb, withFirmDbClient } from './firmDb.js';
import { observeHostCertificateA } from './hostCertificateA.js';
import { createEvidenceSignedUploadUrl, deleteEvidenceObjects, fetchEvidenceObjectBytes, listEvidenceObjects, storeLocalEvidenceBytes } from './evidenceStorage.js';
import { buildHostOperationalFailureCertificate, hostReadinessIsMutationReady, persistHostReadinessAttempt, provisionEntityReadiness } from './runtimeReadiness.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';
import { activityBatchSummaries, buildPeriodOverview, streamEntryState } from '../../src/lib/periodOverview.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'fi-probe-firm', MEMBER = 'fi-probe-operator', CLIENT = 'kampaamo-probe';
const ENV_KEYS = ['DONNA_DESKTOP_BLOB_DIR', 'DONNA_BUILD_COMMIT_SHA', 'DONNA_BUILD_DIRTY', 'DONNA_RUNTIME_BUILD_DIRTY',
  'DONNA_DESKTOP_SCHEDULER', 'DONNA_DEFAULT_FIRM_ID', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VERCEL', 'VERCEL_PROJECT_ID', 'VERCEL_ENV'];
const minutes = (base, n) => new Date(Date.parse(base) + n * 60_000).toISOString();

test('real PG: a failed synthetic storage probe never revokes admission or settled outcomes; real refusals stay bounded and isolated',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required — the readiness→activity→rendering path is not exercised' }, async (t) => {
  const name = `donna_storage_probe_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-storage-probe-'));
  const priorEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await seed.end();
    await admin.query(`drop database "${name}"`); await admin.end();
    await rm(blobDir, { recursive: true, force: true });
  });
  await seed.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, migrations), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,'FI Probe Firm','fi-probe-firm','FI','EUR')", [FIRM]);
  await seed.query("insert into firm_members(id,firm_id,email,name,role,status) values($1,$2,'operator@probe.invalid','Operator','admin','active')", [MEMBER, FIRM]);
  for (const key of ['VERCEL', 'VERCEL_PROJECT_ID', 'VERCEL_ENV']) delete process.env[key];
  Object.assign(process.env, { DONNA_DESKTOP_BLOB_DIR: blobDir, DONNA_BUILD_COMMIT_SHA: 'storage-probe-proof', DONNA_BUILD_DIRTY: 'false',
    DONNA_RUNTIME_BUILD_DIRTY: 'false', DONNA_DESKTOP_SCHEDULER: 'on', DONNA_DEFAULT_FIRM_ID: FIRM,
    OPENAI_API_KEY: 'presence-only', ANTHROPIC_API_KEY: 'presence-only' });
  const manifest = buildDesktopHandlerManifest({ rootDir: ROOT });
  const scheduler = createLocalScheduler({ manifest, client: seed, pollIntervalMs: 60 * 60 * 1000 });
  await scheduler.initialize();

  // The incident shape: the adapter is configured and real keys work, but the
  // synthetic probe key is refused (here at the write; production saw a 4xx PUT).
  const realOps = { put: storeLocalEvidenceBytes, createUpload: createEvidenceSignedUploadUrl, read: fetchEvidenceObjectBytes, list: listEvidenceObjects, delete: deleteEvidenceObjects };
  const incidentOps = { ...realOps, put: async (args) => {
    if (String(args.key).startsWith('__host_certificate_a__/')) throw Object.assign(new Error('synthetic probe refused: /blobs?token=never-persisted'), { code: 'HOST_STORAGE_UPLOAD_FAILED' });
    return storeLocalEvidenceBytes(args);
  } };
  const observe = (storageOps, observedAt = new Date().toISOString()) => observeHostCertificateA({
    env: process.env, rootDir: ROOT, observedAt, manifest, schedulerEnabled: true, query: queryFirmDb, storageOps });
  const bootAt = new Date().toISOString();
  const booted = await observe(incidentOps, bootAt);
  const bootStorage = booted.checks.find(check => check.id === 'evidence_storage');
  assert.equal(booted.status, 'PASS', JSON.stringify(booted.checks.filter(check => check.status !== 'PASS')));
  assert.equal(bootStorage.status, 'PASS');
  assert.equal(bootStorage.detail.provider, 'local_blob');
  assert.deepEqual(bootStorage.detail.lifecycle_probe.error, { code: 'HOST_STORAGE_UPLOAD_FAILED' });
  assert.equal(bootStorage.detail.lifecycle_probe.operation, 'adapter_write');
  assert.ok(!JSON.stringify(booted).includes('token='), 'the persisted receipt carries a code, not the adapter message');
  await persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate: booted, eventType: 'boot' });
  const hostRow = (await seed.query('select status, reason_code from runtime_host_readiness')).rows[0];
  assert.deepEqual(hostRow, { status: 'PASS', reason_code: null });
  assert.equal(hostReadinessIsMutationReady({ certificate: booted, asOf: bootAt }), true);

  // Real storage operations are the authority: a real key writes and reads back.
  const realBytes = Buffer.from('{"real":"upload"}');
  await storeLocalEvidenceBytes({ bucket: 'donna-evidence', key: `${FIRM}/${CLIENT}/statement.json`, bytes: realBytes, contentType: 'application/json' });
  assert.ok(Buffer.from(await fetchEvidenceObjectBytes({ bucket: 'donna-evidence', key: `${FIRM}/${CLIENT}/statement.json` })).equals(realBytes));

  await createClientInDb({ firmId: FIRM, profile: { id: CLIENT, companyName: 'Kampaamo Probe Oy', jurisdiction: 'FI', entityType: 'fi-oy', defaultCurrency: 'EUR' },
    creationPrincipal: { principalType: 'firm_member', principalId: MEMBER, authoritySource: 'storage_probe_real_pg' } });
  const provisioned = await provisionEntityReadiness({ withFirmDbClientFn: withFirmDbClient, firmId: FIRM, clientId: CLIENT,
    creationPath: 'desktop_firm_intake', observedAt: bootAt, initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER },
    authorityBasis: { source: 'storage_probe_real_pg', principal_id: MEMBER } });
  assert.equal(provisioned.row.state, 'ready', JSON.stringify(provisioned.certificate?.checks?.filter(check => check.status !== 'PASS')));
  const admission = () => withFirmDbClient(client => evaluateEntityReadinessAdmissionWithClient({ client, firmId: FIRM, clientId: CLIENT, boundary: 'document_register' }));
  const admitted = await admission();
  assert.equal(admitted.enforced, true);
  assert.equal(admitted.allowed, true, JSON.stringify(admitted));

  // The mixed batch: one statement, one matched bill, one still-unread source,
  // one genuinely failed upload; a hanging line, a line on the owner, a settled line.
  const uploadedAt = bootAt;
  const runId = () => '11111111-1111-4111-8111-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
  const docs = [
    ['statement', 'bank_statement', 'completed', null], ['bill', 'supplier_bill', 'completed', null],
    ['unread', 'unknown', 'pending', null], ['broken', 'unknown', 'failed', { retryable: false, code: 'DOCUMENT_UNREADABLE' }]
  ];
  for (const [id, type, status, error] of docs) {
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,document_date,parse_status,parse_run_id,parse_error,payload,created_at)
      values($1,$2,$3,$4,$5,'2026-09-15',$6,$7,$8,'{"batch_id":"upload"}',$9)`, [id, FIRM, CLIENT, `${id}.pdf`, type, status, runId(), error ? JSON.stringify(error) : null, uploadedAt]);
  }
  const lines = [
    ['hanging', 'needs_review', 'proposed', 'hanging', 'coding_state:proposed', '{}'],
    ['asked', 'needs_review', 'asked', 'on_owner', 'client_evidence_request:open', '{}'],
    ['settled', 'reconciled', 'posted', 'auto_reconciled', 'coding_state:posted', '{"ledger_journal_id":"journal-settled"}']
  ];
  for (const [id, status, coding, convergence, reason, payload] of lines) {
    await seed.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,money_out,currency,status,coding_state,convergence_state,convergence_reason,payload,created_at)
      values($1,$2,$3,'statement','2026-09-15',42.5,'EUR',$4,$5,$6,$7,$8::jsonb,$9)`, [id, FIRM, CLIENT, status, coding, convergence, reason, payload, uploadedAt]);
  }
  await seed.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,evidence_type,question,request_payload,audience,created_at)
    values('ask-1',$1,$2,'asked','open','business_purpose','What was this 42.50 EUR charge for?','{}','client',$3)`, [FIRM, CLIENT, uploadedAt]);
  await seed.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,payload)
    values('match-settled',$1,$2,'settled','supplier_bill','bill',42.5,0.99,'auto_matched','{}')`, [FIRM, CLIENT]);

  const render = async (observedAt) => {
    const snapshot = await getFirmSnapshotFromDb({ firmId: FIRM, observedAt });
    const byId = new Map(snapshot.transactions.map(tx => [tx.id, tx]));
    const lane = state => snapshot.transactions.filter(tx => tx.convergence_state === state);
    const [period] = buildPeriodOverview({ openRows: lane('hanging'), ownerRows: lane('on_owner'), reconciledRows: lane('auto_reconciled'), transactions: snapshot.transactions });
    const document = id => streamEntryState('document', { document: snapshot.documents.find(doc => doc.id === id) });
    return { snapshot, byId, counts: period.counts, document,
      state: id => streamEntryState({ hanging: 'open', on_owner: 'owner', auto_reconciled: 'reconciled' }[byId.get(id).convergence_state], byId.get(id)) };
  };

  // 1. Probe failed, host PASS: inside the batch window only the owed row is
  // Processing and the batch speaks once in its summary; settled rows and
  // owner questions render their persisted verdict throughout (2026-09-23).
  const during = await render(minutes(uploadedAt, 5));
  assert.equal(during.snapshot.runtimeReadinessHost.mutation_ready, true);
  assert.equal(during.snapshot.clients.find(client => client.id === CLIENT).runtime_readiness.mutation_ready, true);
  assert.deepEqual(during.counts, { needsInput: 1, processing: 1, stalled: 0, reconciled: 1, remaining: 2 });
  const [summary] = activityBatchSummaries([...during.snapshot.transactions, ...during.snapshot.documents]);
  assert.deepEqual({ done: summary.done, on_owner: summary.on_owner, in_progress: summary.in_progress, reading: summary.reading },
    { done: 1, on_owner: 1, in_progress: 1, reading: ['unread.pdf'] });
  assert.equal(during.document('broken'), 'stalled', 'a real failed upload is its own receipt');
  assert.equal(during.byId.get('hanging').processing_activity.reason_code, undefined);
  const after = await render(minutes(uploadedAt, 31));
  assert.deepEqual(after.counts, { needsInput: 1, processing: 0, stalled: 1, reconciled: 1, remaining: 2 }, 'settled rows and owner questions keep their outcomes');
  assert.equal(after.byId.get('hanging').processing_activity.reason_code, 'processing_cycle_expired');
  assert.equal(after.byId.get('settled').processing_activity, null);
  assert.equal(after.byId.get('asked').processing_activity, null);
  assert.equal(after.document('broken'), 'stalled');
  assert.equal(after.snapshot.documents.find(doc => doc.id === 'broken').processing_activity.reason_code, 'source_processing_failed');
  assert.equal(after.snapshot.documents.find(doc => doc.id === 'unread').processing_activity.reason_code, 'processing_cycle_expired');
  assert.equal(after.snapshot.documents.find(doc => doc.id === 'statement').processing_activity, null);

  // 2. A real host incompatibility still blocks the mutation. The batch is a
  // bounded shared wait, never mass Stalled; settled rows are preserved.
  const incompatible = buildHostOperationalFailureCertificate({ certificate: booted, checkId: 'database_schema', reasonCode: 'fixture_schema_incompatible', observedAt: new Date().toISOString() });
  await persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate: incompatible, eventType: 'retry' });
  const refused = await admission();
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason_code, 'fixture_schema_incompatible');
  const outageDuring = await render(minutes(uploadedAt, 5));
  const outageReadiness = outageDuring.snapshot.clients.find(client => client.id === CLIENT).runtime_readiness;
  assert.equal(outageReadiness.effective_state, 'host_unavailable');
  assert.equal(outageReadiness.reason_code, 'fixture_schema_incompatible', 'the shared problem is named once, on the workspace readiness card');
  assert.deepEqual(outageDuring.counts, { needsInput: 1, processing: 1, stalled: 0, reconciled: 1, remaining: 2 });
  assert.equal(outageDuring.byId.get('hanging').processing_activity.phase, 'waiting_for_host');
  const outageAfter = await render(minutes(uploadedAt, 31));
  assert.deepEqual(outageAfter.counts, { needsInput: 1, processing: 0, stalled: 1, reconciled: 1, remaining: 2 }, 'never mass Stalled, never indefinite Processing');
  assert.equal(outageAfter.byId.get('hanging').processing_activity.reason_code, 'processing_cycle_expired');
  assert.equal(outageAfter.byId.get('settled').processing_activity, null);
  assert.equal(outageAfter.byId.get('asked').processing_activity, null);

  // 3. Recovery: a fresh PASS renewal readmits the same rows. No new client,
  // document or line is minted and nothing is re-uploaded.
  const before = (await seed.query('select (select count(*) from clients) c, (select count(*) from documents) d, (select count(*) from transactions) t, (select count(*) from local_evidence_objects) b')).rows[0];
  const renewed = await observe(realOps);
  assert.equal(renewed.status, 'PASS');
  assert.equal(renewed.checks.find(check => check.id === 'evidence_storage').detail.lifecycle_probe.status, 'PASS');
  assert.equal(renewed.compatibility_digest, booted.compatibility_digest, 'a recovered probe does not rewrite the host generation');
  await persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate: renewed, eventType: 'renewal' });
  const readmitted = await admission();
  assert.equal(readmitted.allowed, true, JSON.stringify(readmitted));
  const recovered = await render(minutes(uploadedAt, 5));
  assert.equal(recovered.snapshot.runtimeReadinessHost.mutation_ready, true);
  assert.deepEqual(recovered.counts, { needsInput: 1, processing: 1, stalled: 0, reconciled: 1, remaining: 2 });
  const afterRecovery = (await seed.query('select (select count(*) from clients) c, (select count(*) from documents) d, (select count(*) from transactions) t, (select count(*) from local_evidence_objects) b')).rows[0];
  assert.deepEqual(afterRecovery, before);

  // 4. An unrelated later upload opens its own cycle and does not reopen the settled rows.
  await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,document_date,parse_status,parse_run_id,payload,created_at)
    values('later',$1,$2,'later.pdf','unknown','2026-09-18','pending',$3,'{"batch_id":"second"}',$4)`, [FIRM, CLIENT, runId(), minutes(uploadedAt, 40)]);
  const unrelated = await render(minutes(uploadedAt, 45));
  assert.deepEqual(unrelated.counts, { needsInput: 1, processing: 0, stalled: 1, reconciled: 1, remaining: 2 });
  assert.equal(unrelated.document('later'), 'processing');
});
