import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { createServer } from 'node:http';
import { inngest } from './inngest/client.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, withFirmDbClient, getFirmSnapshotFromDb } from './firmDb.js';
import { selfProvisionClientWorkspace } from './selfProvisionDb.js';
import { prepareFinnishHostedPilotInDb } from './hostedPilot.js';
import { observeEntityCertificateB } from './entityCertificateB.js';
import { setClientFlagStage } from './clientConfig.js';
import { observeCloudHostCertificateA, observeCloudDatabase } from './cloudHostCertificateA.js';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { persistHostReadinessAttempt, provisionEntityReadiness, listTargetedEntityReadinessRecoveryCandidates } from './runtimeReadiness.js';
import { evaluateEntityReadinessAdmissionWithClient, runWithEntityReadinessWorkerAdmission } from './runtimeReadinessAdmission.js';
import { renewCloudHostReadinessIfDue } from './cloudRuntimeReadiness.js';
import { runParseCronTask } from './api.js';
import { createExecutionBudget, runWithExecutionBudget } from './executionBudget.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: cloud observation, scoped host admission, dependency invalidation and existing recovery stay truthful',
  { skip: !pgUrl && 'INCOMPLETE: DONNA_PG_TEST_URL required; no cloud/PG17/provider certificate is claimed' }, async t => {
    const name = `donna_cloud_readiness_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(pgUrl); url.pathname = `/${name}`;
    const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
    const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 });
    const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
    __setFirmDbPoolForTests(pool);
    const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: 'cloud-proof', DONNA_DESKTOP_BLOB_DIR: '',
      VERCEL: '1', VERCEL_PROJECT_ID: 'prj_cloud_proof', VERCEL_ENV: 'preview', VERCEL_DEPLOYMENT_ID: 'dpl_cloud_proof',
      VERCEL_GIT_COMMIT_SHA: 'cloud-source-proof', SUPABASE_URL: 'https://cloud-proof.invalid',
      SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SERVICE_KEY: '', SUPABASE_SECRET_KEY: '',
      DONNA_HOST_ATTESTATION_PUBLIC_KEY: '',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
    t.after(async () => {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await seed.end();
      await admin.query(`drop database "${name}"`); await admin.end();
    });
    await seed.query(`create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
    const dir = new URL('../../db/migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()) {
      await seed.query(await readFile(new URL(file, dir), 'utf8'));
      await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
    }
    await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values('cloud-proof','Cloud proof','cloud-proof','FI','EUR')");
    await seed.query("insert into firm_members(id,firm_id,email,name,role,status) values('cloud-operator','cloud-proof','operator@cloud.invalid','Operator','admin','active')");
    const { clientId } = await selfProvisionClientWorkspace({ auth: { userId: 'cloud-owner', email: 'owner@cloud.invalid' },
      companyName: 'Cloud Proof Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
    await prepareFinnishHostedPilotInDb({ firmId: 'cloud-proof', clientId, actorId: 'cloud-operator',
      profilePatch: { companyName: 'Cloud Proof Oy', jurisdiction: 'FI', entityType: 'fi-oy',
        accountingCurrency: 'EUR', accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' } });
    const at = new Date().toISOString(), identity = resolveRuntimeHostIdentity();
    const query = (sql, params) => seed.query(sql, params);
    const certificate = await observeCloudHostCertificateA({ observedAt: at, query });
    assert.equal(certificate.status, 'INCOMPLETE');
    const db = certificate.checks.find(check => check.id === 'database_schema');
    assert.equal(db.detail.required_server_major, 17);
    assert.deepEqual(db.detail.missing_columns, []);
    assert.deepEqual(db.detail.missing_migrations, []);
    assert.equal(certificate.checks.find(check => check.id === 'evidence_storage').status, 'INCOMPLETE');
    await persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate, hostId: identity.host_id });
    assert.equal((await seed.query("select count(*)::int n from runtime_host_readiness where host_id='desktop-local'")).rows[0].n, 0);
    assert.equal((await seed.query("select count(*)::int n from client_capability_config where flag_key='ENTITY_READINESS_ADMISSION'")).rows[0].n, 0, 'observer never enrolls');
    const baseline = (await seed.query('select flag_key,stage,source,reason from client_capability_config where client_id=$1 and valid_to is null order by flag_key', [clientId])).rows;
    const manifest = JSON.parse(await readFile(new URL('../../data/worlds/admitted-entity-profiles.json', import.meta.url)));
    assert.deepEqual(baseline, [...manifest.capability_manifests['fi-cloud-pilot.v1'].required_baseline, { flag_key:'FISCAL_PERIOD_INTAKE',stage:'canary',source:'manual',reason:'donna.fi-hosted-pilot.v1' }].sort((a,b) => a.flag_key.localeCompare(b.flag_key)));

    const observeCapabilities = async () => (await observeEntityCertificateB({ query, firmId:'cloud-proof',clientId,
      profileId:'fi-oy.self-provision.vercel.none.management-books.fi-cloud-pilot-v1',hostCertificate:certificate,observedAt:at }))
      .checks.find(check=>check.id==='client_capabilities');
    assert.equal((await observeCapabilities()).status,'PASS');
    for (const mutant of [{stage:'off',source:'manual'}, {stage:'canary',source:'default'}]) {
      await setClientFlagStage(seed,{firmId:'cloud-proof',clientId,flagKey:'FISCAL_PERIOD_INTAKE',...mutant,reason:'test wrong posture',actorType:'firm_member',actorId:'cloud-operator'});
      const check=await observeCapabilities();assert.equal(check.status,'FAIL');
      assert.ok(check.detail.failures.includes('admitted_extension_posture_mismatch:FISCAL_PERIOD_INTAKE'));
    }
    await setClientFlagStage(seed,{firmId:'cloud-proof',clientId,flagKey:'FISCAL_PERIOD_INTAKE',stage:'canary',source:'manual',reason:'donna.fi-hosted-pilot.v1',actorType:'firm_member',actorId:'cloud-operator'});
    assert.equal((await observeCapabilities()).status,'PASS');

    await setClientFlagStage(seed, { firmId: 'cloud-proof', clientId, flagKey: 'ENTITY_READINESS_ADMISSION',
      stage: 'canary', source: 'manual', reason: 'isolated cloud refusal proof', actorType: 'firm_member', actorId: 'cloud-operator' });
    const provision = () => provisionEntityReadiness({ withFirmDbClientFn: withFirmDbClient, firmId: 'cloud-proof', clientId,
      creationPath: 'self_provision', observedAt: new Date().toISOString() });
    const result = await provision();
    assert.equal(result.certificate.status, 'INCOMPLETE', JSON.stringify(result.certificate.checks));
    assert.equal(result.row.reason_code, 'host_certificate_not_pass');
    assert.equal(result.row.attempt_count, 0, 'host wait never consumes entity attempts');
    assert.ok(result.certificate.checks.filter(check => check.id !== 'host_compatibility').every(check => check.status === 'PASS'), JSON.stringify(result.certificate.checks));
    assert.equal((await listTargetedEntityReadinessRecoveryCandidates({ withFirmDbClientFn: withFirmDbClient })).length, 1);
    let worked = false;
    await assert.rejects(withFirmDbClient(client => runWithEntityReadinessWorkerAdmission({ client, firmId: 'cloud-proof', clientId,
      work: async () => { worked = true; } })), { code: 'ENTITY_READINESS_ADMISSION_BLOCKED' });
    assert.equal(worked, false);
    const snapshot = await getFirmSnapshotFromDb({ firmId: 'cloud-proof' });
    assert.equal(snapshot.runtimeReadinessHost.runtime_host, 'vercel');
    assert.equal(snapshot.runtimeReadinessHost.mutation_ready, false);
    const visible = snapshot.clients.find(row => row.id === clientId).runtime_readiness;
    assert.equal(visible.waiting_for_host, true);
    assert.equal(visible.detail.includes('desktop'), false);
    assert.equal(visible.mutation_ready, false);

    // A historical ready projection is fixture state, not a new certificate.
    // The real migration trigger invalidates it after an unrelated profile edit.
    await seed.query("update entity_readiness_sagas set state='ready',ready_dependency_digest='fixture-generation',observed_dependency_digest='fixture-generation',retry_state='idle',next_retry_at=null where client_id=$1", [clientId]);
    const decision = await evaluateEntityReadinessAdmissionWithClient({ client: seed, firmId: 'cloud-proof', clientId, boundary: 'upload_sign', lock: false });
    assert.equal(decision.allowed, false, 'ready entity cannot launder an incomplete cloud host');
    // Host row locks serialize actual admission reads and host renewal writes.
    await seed.query('begin');
    await evaluateEntityReadinessAdmissionWithClient({ client: seed, firmId: 'cloud-proof', clientId, boundary: 'upload_sign' });
    const nextCertificate = await observeCloudHostCertificateA({ observedAt: new Date().toISOString(), query });
    const writing = persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate: nextCertificate, hostId: identity.host_id, eventType: 'renewal' });
    let waiting = false;
    try {
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        waiting = (await admin.query("select 1 from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query like 'select attempt_count%runtime_host_readiness%'", [name])).rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'renewal waits on admission host row lock');
    } finally { await seed.query('commit'); await writing; }
    await seed.query("update clients set profile=profile || '{\"accountingBasis\":\"cash\"}'::jsonb where id=$1", [clientId]);
    assert.equal((await seed.query('select state from entity_readiness_sagas where client_id=$1', [clientId])).rows[0].state, 'failed');

    await seed.query('begin');
    await seed.query('alter table documents rename column parse_stage to missing_parse_stage');
    const drift = await observeCloudDatabase({ query, rootDir: process.cwd(), observedAt: new Date().toISOString() });
    assert.ok(drift.detail.missing_columns.includes('documents.parse_stage'));
    assert.notEqual(drift.detail.physical_schema_digest, db.detail.physical_schema_digest);
    await seed.query('rollback');

    // Actual existing recovery worker, with no provider call or customer send:
    // a stuck run gets its existing resumable STUCK receipt despite host refusal.
    await seed.query(`insert into documents(id,firm_id,client_id,filename,parse_status,parse_run_id,parse_heartbeat_at)
      values('cloud-stuck','cloud-proof',$1,'synthetic-stuck.pdf','processing',gen_random_uuid(),now()-interval '10 minutes')`, [clientId]);
    const recovery = await runParseCronTask({ task: 'stuck', authorizedAs: 'isolated_test' });
    assert.equal(recovery.stuck.failed_count, 1);
    const document = (await seed.query("select parse_status,parse_error from documents where id='cloud-stuck'")).rows[0];
    assert.equal(document.parse_status, 'failed'); assert.equal(document.parse_error.code, 'STUCK');
    assert.equal(document.parse_error.retryable, true);
    assert.equal((await seed.query("select count(*)::int n from audit_events where action='document.parse.failed' and resource_id='cloud-stuck'")).rows[0].n, 1);

    const before = (await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n;
    assert.equal((await renewCloudHostReadinessIfDue()).reason, 'renewal_not_due');
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_next';
    const renewed = (await runParseCronTask({ task: 'outbox', authorizedAs: 'isolated_test' })).runtime_readiness;
    assert.equal(renewed.status, 'INCOMPLETE');
    assert.equal((await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n, before + 1);
    assert.notEqual((await seed.query('select compatibility_digest from runtime_host_readiness')).rows[0].compatibility_digest, certificate.compatibility_digest);
    const expired = await observeCloudHostCertificateA({ observedAt: new Date(Date.now() - 16 * 60_000).toISOString(), query });
    await persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate: expired, hostId: identity.host_id, eventType: 'retry' });
    assert.equal((await renewCloudHostReadinessIfDue()).status, 'INCOMPLETE', 'expired cloud observation renews but never manufactures a missing attestation or configuration');
    // Exercise real runner selection/receipts and the actual HTTP storage adapter.
    // Only the event transport is simulated; no external worker is invoked.
    const originalSend = inngest.send;
    inngest.send = async () => ({ ids: ['isolated-transport-receipt'] });
    try {
      // Seven successful storage exchanges can exceed both the former 5s
      // storage bound and 15s observer bound without any individual hang.
      // Exercise the existing outbox -> renewal -> actual HTTP adapters -> PG
      // receipt. The missing attestation, PG17 schema qualification, Inngest
      // signing key and provider credentials must still keep Host incomplete.
      const probeObjects = new Map(), exchanges = [];
      let perExchangeDelay = 2300, requestOpened = null, requestClosed = null;
      const healthyStorage = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const pathname = new URL(req.url, 'http://localhost').pathname;
        await requestOpened?.();
        res.once('close', () => requestClosed?.());
        await new Promise(resolve => {
          const timer = setTimeout(resolve, perExchangeDelay);
          res.once('close', () => { clearTimeout(timer); resolve(); });
        });
        if (res.destroyed) return;
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && pathname.endsWith('/deployment-attestation.json')) {
          exchanges.push('attestation'); res.end('{}');
        } else if (req.method === 'POST' && pathname.includes('/upload/sign/')) {
          exchanges.push('sign');
          const key = pathname.split('/donna-evidence/')[1];
          res.end(JSON.stringify({ url: `http://127.0.0.1:${healthyStorage.address().port}/put/${key}` }));
        } else if (req.method === 'PUT') {
          exchanges.push('put'); probeObjects.set(pathname.slice('/put/'.length), body); res.end('{}');
        } else if (req.method === 'GET') {
          exchanges.push('read'); const bytes = probeObjects.get(pathname.split('/donna-evidence/')[1]);
          res.statusCode = bytes ? 200 : 404; res.end(bytes || '{}');
        } else if (req.method === 'POST' && pathname.includes('/object/list/')) {
          exchanges.push('list');
          res.end(JSON.stringify([...probeObjects.keys()].map(key => ({ id: key, name: key.split('/').at(-1), metadata: { size: probeObjects.get(key).length } }))));
        } else if (req.method === 'DELETE') {
          exchanges.push('delete');
          const deleted = JSON.parse(body).prefixes.filter(key => probeObjects.delete(key));
          res.end(JSON.stringify(deleted.map(name => ({ name }))));
        } else { res.statusCode = 404; res.end('{}'); }
      });
      await new Promise(resolve => healthyStorage.listen(0, '127.0.0.1', resolve));
      try {
        process.env.SUPABASE_URL = `http://127.0.0.1:${healthyStorage.address().port}`;
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-proof-key';
        process.env.DONNA_HOST_ATTESTATION_PUBLIC_KEY = 'synthetic-presence-only';
        process.env.VERCEL_DEPLOYMENT_ID = 'dpl_slow_healthy_storage';
        const documentId = 'cloud-outbox-slow-healthy';
        await seed.query(`insert into documents(id,firm_id,client_id,filename,parse_status,parse_run_id,parse_enqueued_at)
          values($1,'cloud-proof',$2,'synthetic-outbox.pdf','pending',gen_random_uuid(),now()-interval '1 minute')`, [documentId, clientId]);
        let outboxBeforeStorage = false;
        requestOpened = async () => {
          requestOpened = null;
          outboxBeforeStorage = Boolean((await seed.query('select parse_event_sent_at from documents where id=$1', [documentId])).rows[0].parse_event_sent_at);
        };
        const beforeSlow = (await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n;
        const started = Date.now();
        const slow = await runParseCronTask({ task: 'outbox', authorizedAs: 'isolated_test' });
        assert.equal(slow.outbox.resent, 1);
        assert.equal(outboxBeforeStorage, true);
        assert.ok((await seed.query('select parse_event_sent_at from documents where id=$1', [documentId])).rows[0].parse_event_sent_at);
        assert.equal(slow.runtime_readiness.status, 'INCOMPLETE', 'healthy storage never invents a missing attestation or configuration');
        const receipt = (await seed.query('select certificate from runtime_host_readiness_attempts order by id desc limit 1')).rows[0].certificate;
        const storageReceipt = receipt.checks.find(check => check.id === 'evidence_storage');
        assert.equal(storageReceipt.status, 'PASS', JSON.stringify(storageReceipt));
        assert.equal(storageReceipt.detail.lifecycle_probe.status, 'PASS');
        assert.deepEqual(storageReceipt.detail.lifecycle_probe.operations_completed, storageReceipt.detail.operations);
        assert.deepEqual(slow.runtime_readiness.probe_failures.filter(failure => failure.check === 'evidence_storage'), []);
        assert.ok(Date.now() - started > 15000, 'healthy aggregate exchange exceeds the former enclosing bound');
        assert.deepEqual(exchanges, ['attestation', 'sign', 'put', 'read', 'list', 'delete', 'list']);
        assert.equal(probeObjects.size, 0, 'the actual probe is deleted before its storage PASS');
        assert.equal((await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n, beforeSlow + 1);

        // A shorter parent still owns cancellation. Close the real exchange
        // and the checked-out PG client before returning, never write late.
        perExchangeDelay = 10000;
        for (const mode of ['expiry', 'abort']) {
          process.env.VERCEL_DEPLOYMENT_ID = `dpl_parent_${mode}_storage`;
          const parent = createExecutionBudget({ timeoutMs: 2000, label: 'synthetic-short-parent' });
          let parentTimer, opened = false;
          const closedHttp = new Promise(resolve => { requestClosed = resolve; });
          requestOpened = () => {
            opened = true;
            if (mode === 'abort') parentTimer = setTimeout(() => parent.abort('synthetic_parent_cancelled'), 50);
          };
          let ownedPid, ownedEnded;
          pool.once('acquire', connection => { ownedPid = connection.processID; ownedEnded = new Promise(resolve => connection.once('end', resolve)); });
          const cancelled = await runWithExecutionBudget(parent, () => renewCloudHostReadinessIfDue({ logger: { error() {} } }));
          clearTimeout(parentTimer);
          assert.equal(opened, true);
          assert.equal(cancelled.reason, 'CLOUD_OBSERVATION_DEADLINE');
          await closedHttp; await ownedEnded;
          assert.equal((await seed.query('select count(*)::int n from pg_stat_activity where pid=$1', [ownedPid])).rows[0].n, 0);
          await new Promise(resolve => setImmediate(resolve));
          assert.equal((await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n, beforeSlow + 1, 'cancelled observer cannot append a late receipt');
        }
      } finally {
        process.env.DONNA_HOST_ATTESTATION_PUBLIC_KEY = '';
        healthyStorage.closeAllConnections();
        await new Promise(resolve => healthyStorage.close(resolve));
      }
      for (const phase of ['headers', 'body', 'put_body']) {
        const documentId = `cloud-outbox-${phase}`;
        let sentBeforeProbe = false, requestClosed;
        const closedRequest = new Promise(resolve => { requestClosed = resolve; });
        const server = createServer(async (req, res) => {
          req.resume();
          if (phase === 'put_body' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/probe-put` }));
            return;
          }
          sentBeforeProbe = Boolean((await seed.query('select parse_event_sent_at from documents where id=$1', [documentId])).rows[0].parse_event_sent_at);
          res.once('close', requestClosed);
          if (phase !== 'headers') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{'); // Headers arrive, but the body never completes.
          }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
          process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
          process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-proof-key';
          process.env.VERCEL_DEPLOYMENT_ID = `dpl_timeout_${phase}`;
          await seed.query(`insert into documents(id,firm_id,client_id,filename,parse_status,parse_run_id,parse_enqueued_at)
            values($1,'cloud-proof',$2,'synthetic-outbox.pdf','pending',gen_random_uuid(),now()-interval '1 minute')`, [documentId, clientId]);
          const run = await runParseCronTask({ task: 'outbox', authorizedAs: 'isolated_test' });
          assert.equal(run.outbox.resent, 1);
          assert.equal(sentBeforeProbe, true, `${phase}: durable outbox receipt precedes storage observation`);
          assert.equal(run.runtime_readiness.status, 'INCOMPLETE');
          const probeFailure = run.runtime_readiness.probe_failures.find(failure => failure.check === 'evidence_storage');
          assert.equal(probeFailure?.code, 'CLOUD_STORAGE_PROBE_TIMEOUT', JSON.stringify(run.runtime_readiness));
          assert.equal(probeFailure.probe, 'lifecycle');
          const persisted = await seed.query('select certificate from runtime_host_readiness_attempts order by id desc limit 1');
          const storage = persisted.rows[0].certificate.checks.find(check => check.id === 'evidence_storage');
          // v6: the timed-out exchange is a receipt inside a PASS configuration
          // check; the certificate stays INCOMPLETE only for the missing
          // attestation and configuration, never for the probe.
          assert.equal(storage.status, 'PASS', JSON.stringify(storage));
          assert.equal(storage.detail.lifecycle_probe.status, 'FAIL');
          assert.equal(storage.detail.lifecycle_probe.error.code, 'CLOUD_STORAGE_PROBE_TIMEOUT');
          assert.equal(storage.detail.lifecycle_probe.cleanup_required, phase === 'put_body');
          assert.ok(!JSON.stringify(storage).includes('127.0.0.1'), 'no endpoint or signed URL in the persisted receipt');
          await closedRequest;
          const attempts = (await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n;
          // Closing the actual exchange is the cancellation barrier; no detached
          // observer remains to mint a second receipt after the runner settles.
          await new Promise(resolve => setImmediate(resolve));
          assert.equal((await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n, attempts);
        } finally {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
      }
      process.env.SUPABASE_URL = env.SUPABASE_URL;
      process.env.SUPABASE_SERVICE_ROLE_KEY = '';
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_locked_observation';
      const attempts = (await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n;
      await seed.query('begin');
      await seed.query('lock table runtime_host_readiness in access exclusive mode');
      try {
        const blocked = await renewCloudHostReadinessIfDue({ logger: { error() {} } });
        assert.equal(blocked.status, 'INCOMPLETE');
        assert.ok(['57014', '55P03'].includes(blocked.reason), JSON.stringify(blocked));
      } finally { await seed.query('rollback'); }
      assert.equal((await seed.query('select count(*)::int n from runtime_host_readiness_attempts')).rows[0].n, attempts, 'cancelled SQL cannot write late');
      const restored = await pool.query("select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock");
      assert.deepEqual(restored.rows[0], { statement: '0', lock: '0' });
    } finally { inngest.send = originalSend; }
    assert.equal((await seed.query('select count(*)::int n from ledger_journals')).rows[0].n, 0);
    assert.equal((await seed.query('select count(*)::int n from client_evidence_requests')).rows[0].n, 0);
  });
