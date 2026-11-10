import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HOST_CERTIFICATE_A_VERSION,
  HOST_CERTIFICATE_RENEWAL_INTERVAL_MS,
  HOST_CERTIFICATE_REQUIRED_TABLES,
  HOST_CERTIFICATE_VALIDITY_MS,
  HOST_QUEUE_PARSE_DOCUMENT_FUNCTION_ID,
  evaluateHostCertificateFreshness,
  configPlaneCheck,
  observeHostCertificateA
} from './hostCertificateA.js';
import { ENTITY_READINESS_ADMISSION_FLAG } from './clientConfig.js';
import { PARSE_DOCUMENT_FUNCTION_ID } from './desktop/parseDocumentJob.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OBSERVED_AT = '2026-08-29T12:00:00.000Z';
const migrations = readdirSync(path.join(ROOT, 'db', 'migrations'))
  .filter((file) => file.endsWith('.sql')).map((file) => file.replace(/\.sql$/, '')).sort();

const makeQuery = () => async (sql) => {
  const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  if (text.includes("current_setting('server_version_num')")) return { rows: [{ server_version_num: 160015, version: 'PostgreSQL 16.15' }] };
  if (text.startsWith('select version from schema_migrations')) return { rows: migrations.map((version) => ({ version })) };
  if (text.includes('to_regclass')) return { rows: HOST_CERTIFICATE_REQUIRED_TABLES.map((name) => ({ name, present: true })) };
  if (text === 'select now() as database_now') return { rows: [{ database_now: OBSERVED_AT }] };
  if (text.includes("from local_jobs")) return { rows: [{ pending: 0, running: 0, succeeded: 0, dead: 0, cancelled: 0, expired_running: 0, retrying: 0, dead_unsuperseded: 0 }] };
  if (text.startsWith('select function_id, last_enqueued_tick')) return { rows: [{ function_id: 'worker-a', last_enqueued_tick: OBSERVED_AT }] };
  if (text.startsWith('select distinct flag_key')) return { rows: [{ flag_key: 'TEST_ACTIVE_FLAG' }] };
  throw new Error(`Unexpected query: ${text}`);
};

const makeStorage = () => {
  const objects = new Map();
  return {
    ops: {
      put: async ({ key, bytes }) => { objects.set(key, Buffer.from(bytes)); },
      createUpload: async () => { throw new Error('local probe must not request a signed upload'); },
      read: async ({ key }) => objects.get(key),
      list: async ({ prefix }) => [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([name, bytes]) => ({ name, size: bytes.length })),
      delete: async ({ keys }) => {
        let deleted = 0;
        for (const key of keys) if (objects.delete(key)) deleted += 1;
        return { deleted, errors: [] };
      }
    },
    objects
  };
};

const env = {
  DATABASE_URL: 'postgresql://example.invalid/donna',
  DONNA_DESKTOP_BLOB_DIR: '/tmp/host-cert-test',
  DONNA_BUILD_COMMIT_SHA: 'abc123',
  DONNA_BUILD_DIRTY: 'false',
  OPENAI_API_KEY: 'present-not-a-secret-in-this-test',
  ANTHROPIC_API_KEY: 'present-not-a-secret-in-this-test',
  TYPESAFE_API_KEY: 'present-not-a-secret-in-this-test'
};
const manifest = [{
  functionId: 'worker-a', kind: 'inngest-cron', cron: '* * * * *', maxAttempts: 1,
  concurrency: 1, leaseMs: 1000, timeoutMs: 1000, handlerVersion: '1', run: async () => {}
}];

test('Host Certificate A is deterministic, zero-model, observe-only, and proves storage deletion', async () => {
  const firstStorage = makeStorage();
  const first = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: makeQuery(), storageOps: firstStorage.ops,
    fetchImpl: async () => { throw new Error('Certificate A must make no network call in local-storage mode'); }
  });
  const secondStorage = makeStorage();
  const second = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: makeQuery(), storageOps: secondStorage.ops,
    fetchImpl: async () => { throw new Error('Certificate A must make no network call in local-storage mode'); }
  });
  assert.equal(first.status, 'PASS');
  assert.deepEqual(second, first);
  assert.equal(first.product_state_persisted, false);
  assert.equal(first.model_inference_calls, 0);
  assert.equal(first.model_spend_usd, 0);
  assert.equal(first.freshness.renewal_interval_ms, HOST_CERTIFICATE_RENEWAL_INTERVAL_MS);
  assert.equal(first.freshness.validity_ms, HOST_CERTIFICATE_VALIDITY_MS);
  assert.ok(first.checks.find(({ id }) => id === 'config_control_plane').detail.supported_keys
    .includes(ENTITY_READINESS_ADMISSION_FLAG));
  assert.ok(first.checks.find(({ id }) => id === 'config_control_plane').detail.supported_keys
    .includes('BANK_LINE_DISPOSITION'));
  assert.equal(firstStorage.objects.size, 0, 'transient probe object is deleted');
  const modelRoutes = first.checks.find(({ id }) => id === 'model_routes');
  assert.equal(modelRoutes.status, 'PASS');
  assert.deepEqual(modelRoutes.detail.dark_providers, []);
  assert.deepEqual(modelRoutes.detail.dark_lanes, []);
  assert.ok(
    modelRoutes.detail.lanes.every(({ credential_present, expected_model }) => credential_present === true && expected_model === undefined),
    'v5 receipts credential presence per lane and carries no model expectation — modelLanes.js is the only model registry'
  );
  assert.match(first.receipt_digest, /^[a-f0-9]{64}$/);
});

test('v5: an OpenAI-only host is PASS — dark lanes are receipts, and key presence never rewrites the compatibility digest', async () => {
  assert.equal(HOST_CERTIFICATE_A_VERSION, 'donna.host-certificate-a.v9');
  const observe = (overrides) => observeHostCertificateA({
    env: { ...env, ...overrides }, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: makeQuery(), storageOps: makeStorage().ops
  });
  const bothKeys = await observe({});
  const openaiOnly = await observe({ ANTHROPIC_API_KEY: '' });
  const noKeys = await observe({ OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '   ' });

  assert.equal(openaiOnly.status, 'PASS', 'the laptop case: one provider key keeps the host PASS');
  const routes = openaiOnly.checks.find(({ id }) => id === 'model_routes');
  assert.equal(routes.status, 'PASS', 'a missing optional credential is never INCOMPLETE');
  assert.deepEqual(routes.detail.dark_providers, ['anthropic']);
  // RT-12: the unified extractor is provider-agnostic — LIT through the
  // OpenAI key on an OpenAI-only host; the receipt names which provider lit it.
  assert.ok(!routes.detail.dark_lanes.includes('unified_extraction'), 'the unified lane is lit by any one of its providers');
  assert.ok(routes.detail.dark_lanes.includes('reconciliation_reasoning'));
  assert.ok(!routes.detail.dark_lanes.includes('transaction_coding'));
  assert.equal(routes.detail.lanes.find(({ lane_id }) => lane_id === 'transaction_coding').credential_present, true);
  const unifiedLane = routes.detail.lanes.find(({ lane_id }) => lane_id === 'unified_extraction');
  assert.equal(unifiedLane.credential_present, true);
  assert.deepEqual(unifiedLane.providers, ['anthropic', 'openai']);
  assert.deepEqual(unifiedLane.lit_providers, ['openai']);
  assert.equal(routes.detail.identity_proof, 'lane_inventory_only_not_model_proven');

  assert.equal(noKeys.status, 'PASS', 'a keyless host is still compatible; every lane is dark and the receipt says so');
  const noKeyRoutes = noKeys.checks.find(({ id }) => id === 'model_routes');
  assert.deepEqual(noKeyRoutes.detail.dark_providers, ['anthropic', 'openai']);
  assert.ok(noKeyRoutes.detail.dark_lanes.includes('unified_extraction'), 'with no key on either provider the unified lane is dark');

  assert.equal(openaiOnly.compatibility_digest, bothKeys.compatibility_digest, 'adding or removing a key never rewrites the host compatibility digest');
  assert.equal(noKeys.compatibility_digest, bothKeys.compatibility_digest);
  assert.notEqual(openaiOnly.receipt_digest, bothKeys.receipt_digest, 'the receipt itself still records which lanes were dark');
  assert.ok(!JSON.stringify(bothKeys).includes(env.OPENAI_API_KEY), 'no key value reaches the certificate');
});

test('v5: model_routes is an inventory check — a malformed lane registry FAILs the host, a missing credential never does', async () => {
  const receipt = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: makeQuery(), storageOps: makeStorage().ops,
    modelLanes: [
      { id: 'transaction_coding', kind: 'deciding', endpointClass: 'openai', modules: ['server/donna/transactionLlm.js'] },
      { id: 'transaction_coding', kind: 'deciding', endpointClass: 'openai', modules: ['server/donna/transactionLlm.js'] },
      { id: 'Bad Lane', kind: 'mystery', endpointClass: 'carrier_pigeon', modules: [] }
    ]
  });
  assert.equal(receipt.status, 'FAIL', 'a drifted lane registry is a build defect, not an incomplete probe');
  const routes = receipt.checks.find(({ id }) => id === 'model_routes');
  assert.equal(routes.status, 'FAIL');
  assert.deepEqual(routes.detail.failures, [
    'lane_id_duplicate:transaction_coding',
    'lane_id_invalid:Bad Lane',
    'lane_kind_unknown:Bad Lane',
    'lane_provider_unknown:Bad Lane',
    'lane_modules_missing:Bad Lane'
  ]);
  assert.equal(routes.detail.lanes.find(({ lane_id }) => lane_id === 'Bad Lane').credential_present, null);
});

test('compatible Host A renewals keep one compatibility digest while freshness expires at the declared boundary', async () => {
  const first = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: makeQuery(), storageOps: makeStorage().ops
  });
  const renewedAt = '2026-08-29T12:05:00.000Z';
  const renewedQuery = makeQuery();
  const second = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: renewedAt, manifest, schedulerEnabled: true,
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === 'select now() as database_now') return { rows: [{ database_now: renewedAt }] };
      return renewedQuery(sql, params);
    },
    storageOps: makeStorage().ops
  });
  assert.equal(second.status, 'PASS');
  assert.equal(second.compatibility_digest, first.compatibility_digest);
  assert.notEqual(second.receipt_digest, first.receipt_digest);
  assert.deepEqual(
    evaluateHostCertificateFreshness({ certificate: first, asOf: '2026-08-29T12:05:00.000Z' }),
    { status: 'fresh', reason: null, renewal_due: true, valid_until: '2026-08-29T12:15:00.000Z' }
  );
  assert.deepEqual(
    evaluateHostCertificateFreshness({ certificate: first, asOf: '2026-08-29T12:15:00.000Z' }),
    { status: 'expired', reason: 'host_certificate_expired' }
  );
});

test('workspace-only dirt is receipted but only runtime dirt fails Host A', async () => {
  const workspaceDirty = await observeHostCertificateA({
    env: { ...env, DONNA_BUILD_DIRTY: 'true', DONNA_RUNTIME_BUILD_DIRTY: 'false' },
    rootDir: ROOT,
    observedAt: OBSERVED_AT,
    manifest,
    schedulerEnabled: true,
    query: makeQuery(),
    storageOps: makeStorage().ops
  });
  assert.equal(workspaceDirty.status, 'PASS');
  assert.deepEqual(workspaceDirty.checks.find(({ id }) => id === 'source_build'), {
    id: 'source_build',
    status: 'PASS',
    detail: {
      commit_sha: 'abc123',
      dirty: false,
      workspace_dirty: true,
      dirty_scope: 'desktop-accounting-runtime.v1',
      reason: 'workspace_dirty_runtime_clean'
    }
  });

  const runtimeDirty = await observeHostCertificateA({
    env: { ...env, DONNA_BUILD_DIRTY: 'true', DONNA_RUNTIME_BUILD_DIRTY: 'true' },
    rootDir: ROOT,
    observedAt: OBSERVED_AT,
    manifest,
    schedulerEnabled: true,
    query: makeQuery(),
    storageOps: makeStorage().ops
  });
  assert.equal(runtimeDirty.status, 'FAIL');
  assert.equal(runtimeDirty.checks.find(({ id }) => id === 'source_build').detail.reason, 'dirty_runtime_build');
});

test('superseded dead cron ticks are residue, unsuperseded dead work fails the host', async () => {
  const query = makeQuery();
  let queueParams = null;
  const residueQuery = (deadUnsuperseded) => async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (text.includes('from local_jobs')) {
      queueParams = params;
      return { rows: [{ pending: 0, running: 0, succeeded: 153194, dead: 72, cancelled: 0, expired_running: 0, retrying: 0, dead_unsuperseded: deadUnsuperseded }] };
    }
    return query(sql, params);
  };
  const residue = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: residueQuery(0), storageOps: makeStorage().ops
  });
  assert.equal(residue.status, 'PASS', 'dead cron ticks superseded by later successes do not gate the host');
  // $1 the manifest cron functions (superseded by a later success); $2 the
  // per-document parse job, accounted for by its document's stored outcome
  // (the real-PG proof is parseDocumentDeadJobPgLifecycle.test.js).
  assert.deepEqual(queueParams, [['worker-a'], 'parse-document'], 'the queue probe names the manifest cron functions and the parse job');
  assert.equal(HOST_QUEUE_PARSE_DOCUMENT_FUNCTION_ID, PARSE_DOCUMENT_FUNCTION_ID, 'the observer\'s parse function id is the parse job\'s own');
  const queue = residue.checks.find(({ id }) => id === 'database_schema').detail.queue;
  assert.equal(queue.dead, 72, 'residue stays visible in the receipt');
  assert.equal(queue.dead_unsuperseded, 0);
  const lostWork = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: residueQuery(1), storageOps: makeStorage().ops
  });
  assert.equal(lostWork.status, 'FAIL', 'unsuperseded dead work still fails the host');
  assert.equal(lostWork.checks.find(({ id }) => id === 'database_schema').status, 'FAIL');
});

test('a reached-but-drifted host is FAIL, not an incomplete or green manifest', async () => {
  const query = makeQuery();
  const driftedQuery = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (text.includes("current_setting('server_version_num')")) return { rows: [{ server_version_num: 150014, version: 'PostgreSQL 15.14' }] };
    if (text.includes('from local_jobs')) return { rows: [{ pending: 0, running: 0, succeeded: 0, dead: 1, cancelled: 0, expired_running: 0, retrying: 0, dead_unsuperseded: 1 }] };
    return query(sql, params);
  };
  const storage = makeStorage();
  const receipt = await observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: driftedQuery, storageOps: storage.ops
  });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.checks.find(({ id }) => id === 'database_schema').status, 'FAIL');
});

test('cloud storage probe obeys a JSON-only bucket through the real evidence adapter lifecycle', async (t) => {
  const { storageCheck, canonicalHostJson } = await import('./hostCertificateA.js');
  const { createEvidenceSignedUploadUrl, fetchEvidenceObjectBytes, listEvidenceObjects, deleteEvidenceObjects } = await import('./evidenceStorage.js');
  const probeEnv = { SUPABASE_URL: 'https://storage-probe.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key', DONNA_DESKTOP_BLOB_DIR: '' };
  for (const [key, value] of Object.entries(probeEnv)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const objects = new Map(), operations = [];
  let probeKey;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    const json = (value, status = 200) => Response.json(value, { status });
    if (options.method === 'POST' && pathname.startsWith('/storage/v1/object/upload/sign/donna-evidence/')) {
      probeKey = pathname.slice('/storage/v1/object/upload/sign/donna-evidence/'.length);
      operations.push('sign');
      assert.deepEqual(JSON.parse(options.body), { expiresIn: 300 });
      return json({ url: `/object/upload/sign/donna-evidence/${probeKey}?token=synthetic` });
    }
    if (options.method === 'PUT') {
      operations.push('put');
      // Same restriction as the hosted bucket: octet-stream is not admitted.
      if (options.headers['Content-Type'] !== 'application/json') return json({ message: 'mime type not supported' }, 400);
      assert.match(probeKey, /^__host_certificate_a__\/[a-f0-9]{24}\.json$/);
      assert.equal(options.headers['x-upsert'], 'false');
      const parsed = JSON.parse(options.body.toString('utf8'));
      assert.deepEqual(parsed, { certificate_version: HOST_CERTIFICATE_A_VERSION, commit_sha: 'synthetic-commit' });
      assert.equal(options.body.toString('utf8'), canonicalHostJson(parsed));
      objects.set(probeKey, Buffer.from(options.body));
      return json({ Key: probeKey });
    }
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key');
    if (options.method === 'GET') {
      operations.push('read');
      assert.equal(pathname, `/storage/v1/object/donna-evidence/${probeKey}`);
      return new Response(objects.get(probeKey));
    }
    if (pathname === '/storage/v1/object/list/donna-evidence') {
      operations.push('list');
      const { prefix } = JSON.parse(options.body);
      assert.equal(prefix, '__host_certificate_a__/');
      return json([...objects].map(([key, bytes]) => ({ id: 'synthetic-object', name: key.slice(prefix.length), metadata: { size: bytes.length } })));
    }
    if (options.method === 'DELETE') {
      operations.push('delete');
      assert.equal(pathname, '/storage/v1/object/donna-evidence');
      assert.deepEqual(JSON.parse(options.body), { prefixes: [probeKey] });
      objects.delete(probeKey);
      return json([{ name: probeKey }]);
    }
    throw new Error(`Unexpected storage operation: ${options.method} ${pathname}`);
  });
  const result = await storageCheck({
    env: probeEnv, observedAt: OBSERVED_AT, commitSha: 'synthetic-commit', fetchImpl: globalThis.fetch,
    signal: new AbortController().signal,
    storageOps: { createUpload: createEvidenceSignedUploadUrl, read: fetchEvidenceObjectBytes, list: listEvidenceObjects, delete: deleteEvidenceObjects }
  });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.deepEqual(operations, ['sign', 'put', 'read', 'list', 'delete', 'list']);
  assert.deepEqual(result.detail.operations, ['signed_write', 'service_read', 'list', 'delete', 'list_after_delete']);
  assert.equal(objects.size, 0);
});


test('Host A declares the optional Jev config plane before any client enrolls', async () => {
  const result = await configPlaneCheck({query:async sql=>{
    assert.match(sql,/^select distinct flag_key from client_capability_config/);
    return {rows:[]};
  }});
  assert.equal(result.status,'PASS');
  assert.ok(result.detail.supported_keys.includes('JEV_RECONCILIATION'));
  assert.ok(result.detail.supported_keys.includes('JEV_HELD_PLAN_COMPLETION'));
  assert.ok(result.detail.supported_keys.includes('CODING_CORRECTION_AUTO_APPLY'));
  assert.ok(result.detail.supported_keys.includes('CODING_OWNER_TRANSFER_POST'));
  assert.deepEqual(result.detail.active_database_keys,[],'declaring support creates no capability enrollment');
});

// v6 (2026-09-21): the synthetic storage lifecycle exchange is monitoring. A
// failed probe is a code-only receipt inside a PASS configuration check; it
// cannot turn the certificate INCOMPLETE/FAIL, cannot revoke mutation
// admission, and cannot rewrite the compatibility digest every entity
// generation was certified against.
test('v6: a failed storage lifecycle probe is a receipt — the host stays PASS, admitted and digest-stable', async () => {
  const { hostReadinessIsMutationReady } = await import('./runtimeReadiness.js');
  const observe = (storageOps) => observeHostCertificateA({
    env, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true, query: makeQuery(), storageOps
  });
  const healthy = await observe(makeStorage().ops);
  const healthyStorage = healthy.checks.find(({ id }) => id === 'evidence_storage');
  assert.equal(healthy.status, 'PASS');
  assert.equal(healthyStorage.detail.provider, 'local_blob');
  assert.deepEqual(healthyStorage.detail.operations, ['adapter_write', 'service_read', 'list', 'delete', 'list_after_delete']);
  assert.equal(healthyStorage.detail.lifecycle_probe.status, 'PASS');
  assert.deepEqual(healthyStorage.detail.lifecycle_probe.operations_completed, healthyStorage.detail.operations);

  // The incident shape: the synthetic write is refused while the adapter is configured.
  const refusing = makeStorage();
  refusing.ops.put = async () => { throw Object.assign(new Error('disk quota exceeded at /var/blobs?token=never-persisted'), { code: 'HOST_STORAGE_UPLOAD_FAILED' }); };
  const probeFailed = await observe(refusing.ops);
  const storage = probeFailed.checks.find(({ id }) => id === 'evidence_storage');
  assert.equal(probeFailed.status, 'PASS', 'a transient synthetic write failure is not a host health verdict');
  assert.equal(storage.status, 'PASS');
  assert.deepEqual(storage.detail.lifecycle_probe, {
    observed_at: OBSERVED_AT, operations_completed: [], byte_length: storage.detail.lifecycle_probe.byte_length,
    probe_key_digest: storage.detail.lifecycle_probe.probe_key_digest,
    status: 'FAIL', reason: 'storage_lifecycle_probe_failed', operation: 'adapter_write', http_status: null,
    error: { code: 'HOST_STORAGE_UPLOAD_FAILED' }, cleanup_required: false
  });
  assert.ok(!JSON.stringify(probeFailed).includes('token='), 'the receipt carries a code, never the adapter message');
  assert.ok(!JSON.stringify(probeFailed).includes('disk quota'));
  assert.equal(probeFailed.compatibility_digest, healthy.compatibility_digest, 'a probe outcome never rewrites the compatibility digest');
  assert.equal(hostReadinessIsMutationReady({ certificate: probeFailed, asOf: OBSERVED_AT }), true);
  assert.equal(refusing.objects.size, 0);

  // A later stage fails after the write: the stage is named, the probe object is cleaned up.
  const mismatching = makeStorage();
  const realRead = mismatching.ops.read;
  mismatching.ops.read = async (args) => Buffer.concat([await realRead(args), Buffer.from('x')]);
  const readFailed = await observe(mismatching.ops);
  const readStorage = readFailed.checks.find(({ id }) => id === 'evidence_storage');
  assert.equal(readFailed.status, 'PASS');
  assert.equal(readStorage.detail.lifecycle_probe.status, 'FAIL');
  assert.equal(readStorage.detail.lifecycle_probe.operation, 'service_read');
  assert.equal(readStorage.detail.lifecycle_probe.error.code, 'HOST_STORAGE_READ_MISMATCH');
  assert.deepEqual(readStorage.detail.lifecycle_probe.operations_completed, ['adapter_write']);
  assert.equal(readStorage.detail.lifecycle_probe.cleanup_required, false, 'the best-effort delete removed the probe');
  assert.equal(mismatching.objects.size, 0);
  assert.equal(readFailed.compatibility_digest, healthy.compatibility_digest);

  // Unconfigured storage is still a deployment gap, not a probe outcome.
  const unconfigured = await observeHostCertificateA({
    env: { ...env, DONNA_DESKTOP_BLOB_DIR: '' }, rootDir: ROOT, observedAt: OBSERVED_AT, manifest, schedulerEnabled: true,
    query: makeQuery(), storageOps: makeStorage().ops
  });
  assert.equal(unconfigured.checks.find(({ id }) => id === 'evidence_storage').status, 'INCOMPLETE');
  assert.equal(unconfigured.checks.find(({ id }) => id === 'evidence_storage').detail.reason, 'storage_not_configured');
  assert.notEqual(unconfigured.status, 'PASS');
});

test('v6: a refused signed PUT through the real cloud adapter records the stage and HTTP status, never the URL or body', async (t) => {
  const { storageCheck } = await import('./hostCertificateA.js');
  const { createEvidenceSignedUploadUrl, fetchEvidenceObjectBytes, listEvidenceObjects, deleteEvidenceObjects } = await import('./evidenceStorage.js');
  const probeEnv = { SUPABASE_URL: 'https://storage-probe.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key', DONNA_DESKTOP_BLOB_DIR: '' };
  for (const [key, value] of Object.entries(probeEnv)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const operations = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    if (options.method === 'POST' && pathname.startsWith('/storage/v1/object/upload/sign/donna-evidence/')) {
      operations.push('sign');
      return Response.json({ url: `/object/upload/sign/donna-evidence/${pathname.slice('/storage/v1/object/upload/sign/donna-evidence/'.length)}?token=synthetic-signed-token` });
    }
    if (options.method === 'PUT') {
      operations.push('put');
      return Response.json({ statusCode: '400', error: 'InvalidRequest', message: 'mime type not supported: secret-bucket-detail' }, { status: 400 });
    }
    throw new Error(`Unexpected storage operation after a refused PUT: ${options.method} ${pathname}`);
  });
  const result = await storageCheck({
    env: probeEnv, observedAt: OBSERVED_AT, commitSha: 'synthetic-commit', fetchImpl: globalThis.fetch,
    signal: new AbortController().signal,
    storageOps: { createUpload: createEvidenceSignedUploadUrl, read: fetchEvidenceObjectBytes, list: listEvidenceObjects, delete: deleteEvidenceObjects }
  });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.detail.provider, 'supabase_storage');
  assert.deepEqual(result.detail.operations, ['signed_write', 'service_read', 'list', 'delete', 'list_after_delete']);
  assert.deepEqual(operations, ['sign', 'put']);
  const probe = result.detail.lifecycle_probe;
  assert.equal(probe.status, 'FAIL');
  assert.equal(probe.operation, 'signed_write');
  assert.equal(probe.http_status, 400);
  assert.deepEqual(probe.error, { code: 'HOST_STORAGE_UPLOAD_FAILED' });
  assert.deepEqual(probe.operations_completed, []);
  const serialized = JSON.stringify(result);
  for (const secret of ['token=', 'synthetic-signed-token', 'secret-bucket-detail', 'mime type', 'synthetic-test-key', 'storage-probe.invalid']) {
    assert.ok(!serialized.includes(secret), `receipt must not carry ${secret}`);
  }
});
