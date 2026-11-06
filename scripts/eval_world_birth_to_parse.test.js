import assert from 'node:assert/strict';
import test from 'node:test';

import { continueGate2aLifecycle, runGate2a } from './eval_world_birth_to_parse.js';

const ENV_KEYS = ['DONNA_DESKTOP_BLOB_DIR', 'DONNA_ACCESS_TOKEN'];

function fakeOps({ registerStatus = 200 } = {}) {
  const state = {
    calls: [],
    created: false,
    client: false,
    blob: false,
    document: null,
    transactions: [],
    audit: [],
  };
  const addAudit = (action) => state.audit.push({ id: state.audit.length + 1, action });
  const response = (statusCode, json) => ({ statusCode, json, body: JSON.stringify(json) });
  return {
    state,
    isFirmDatabaseConfigured: () => true,
    renderWorldArtifacts: async (world) => (await import('../server/donna/world/worldRenderer.js')).renderWorldArtifacts(world),
    createFirmInDb: async () => {
      state.calls.push('createFirmInDb'); state.created = true; addAudit('firm.eaw_created');
      return { op: 'firm_created' };
    },
    requestApi: async ({ method, url, body }) => {
      state.calls.push(`${method} ${url.split('?')[0]}`);
      if (url.endsWith('/clients')) {
        state.client = true; addAudit('client.create'); addAudit('entity.provisioning.attempt');
        return response(200, { clients: [{ id: 'created' }] });
      }
      if (url.endsWith('/upload-url')) {
        const payload = JSON.parse(body);
        return response(200, {
          provider: 'local_blob', bucket: 'evidence', key: 'gate2a/key',
          signed_url: 'http://local/api/donna/evidence-local?token=fake',
          checksum_sha256: payload.checksum_sha256, content_type: payload.mime_type,
        });
      }
      if (url.startsWith('/api/donna/evidence-local')) {
        state.blob = true;
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const { createHash } = await import('node:crypto');
        state.hash = createHash('sha256').update(bytes).digest('hex');
        state.byteLength = bytes.length;
        return response(200, { content_hash: state.hash, byte_length: bytes.length });
      }
      if (url.endsWith('/register')) {
        if (registerStatus !== 200) return response(registerStatus, { code: 'REGISTER_FAILED', error: 'registration refused' });
        const payload = JSON.parse(body).documents[0];
        state.document = {
          ...payload, parse_status: 'pending', parse_run_id: '11111111-1111-4111-8111-111111111111',
          parse_summary: {}, payload,
        };
        addAudit('document.parse.queued');
        return response(200, { documents: [{ ...state.document, event_sent: false }] });
      }
      throw new Error(`Unexpected fake route ${method} ${url}`);
    },
    // RT-08: the worker stage dispatches the parse-document local job the
    // register route enqueued (no drain route call).
    dispatchQueuedParseJobsOnce: async () => {
      state.calls.push('dispatchQueuedParseJobsOnce');
      state.document.parse_status = 'completed';
      state.document.parse_summary = { transaction_count: 1 };
      state.transactions = [{
        id: 'tx-1', document_id: state.document.id, transaction_date: '2026-08-05',
        money_in: 100, money_out: 0, currency: 'GBP', status: 'needs_review',
        payload: { source: 'async_parse', source_document_id: state.document.id },
      }];
      addAudit('document.parse.completed');
      return {
        function_id: 'parse-document',
        rounds: 1,
        settled: [{ kind: 'job_settled', job_id: 1, function_id: 'parse-document', status: 'succeeded' }],
      };
    },
    queryFirmDb: async (sql) => {
      if (sql.includes('(select count(*)::int from clients')) return { rows: [{ clients: state.client ? 1 : 0, documents: state.document ? 1 : 0, transactions: state.transactions.length }] };
      if (sql.includes('from clients where')) return { rows: state.client ? [{ id: 'client', firm_id: 'firm', jurisdiction: 'GB', entity_type: 'gb-ltd', profile: {} }] : [] };
      if (sql.includes('from entity_readiness_sagas')) return { rows: state.client ? [{ state: 'ready', latest_attempt_id: 3 }] : [] };
      if (sql.includes('from runtime_host_readiness where')) return { rows: [{ status: 'PASS', latest_attempt_id: 2 }] };
      if (sql.includes('from documents where')) return { rows: state.document ? [state.document] : [] };
      if (sql.includes('from transactions where')) return { rows: state.transactions };
      if (sql.includes("from audit_events where")) return { rows: state.audit };
      if (sql.includes('from local_evidence_objects where')) return { rows: state.blob ? [{ bucket: 'evidence', key: 'gate2a/key', content_hash: state.hash, byte_length: state.byteLength }] : [] };
      if (sql.includes('(select count(*)::int from firm_members')) return { rows: [{ firm_members: 1 }] };
      throw new Error(`Unexpected fake query ${sql}`);
    },
    deleteEvidenceObjects: async (args) => { state.calls.push('deleteEvidenceObjects'); state.storageDeleteArgs = args; state.blob = false; return { deleted: args.keys.length, errors: [] }; },
    deleteFirmInDb: async () => { state.calls.push('deleteFirmInDb'); return { residue_verified: true }; },
    countFirmResidueInDb: async () => { state.calls.push('countFirmResidueInDb'); return { residue_rows: 0 }; },
  };
}

async function withEnv(work) {
  const prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/gate2a-fake-blobs';
  process.env.DONNA_ACCESS_TOKEN = 'gate2a-fake-token';
  try { return await work(); }
  finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('Gate 2A runner uses only create, signed raw upload, register and parse routes before retirement', async () => {
  const ops = fakeOps();
  const receipt = await withEnv(() => runGate2a({
    runToken: 'unit-success',
    actor: { type: 'operator', id: 'member-1' },
    ops,
    observedAt: '2026-08-30T08:00:00.000Z',
    clock: (() => { let value = 0; return () => value += 5; })(),
  }));
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(ops.state.calls, [
    'createFirmInDb',
    'POST /api/donna/firms/clients',
    'POST /api/donna/firms/documents/upload-url',
    'PUT /api/donna/evidence-local',
    'POST /api/donna/firms/documents/register',
    'dispatchQueuedParseJobsOnce',
    'deleteEvidenceObjects',
    'deleteFirmInDb',
    'countFirmResidueInDb',
  ]);
  assert.equal(receipt.source_inventory.injection_guard.documents_sync_route_invoked, false);
  assert.equal(receipt.scope.claim, 'raw_bytes_to_terminal_parse_only');
});

test('Gate 2A runner receipts registration as the first divergence and still retires the isolated firm', async () => {
  const ops = fakeOps({ registerStatus: 500 });
  await assert.rejects(
    withEnv(() => runGate2a({
      runToken: 'unit-register-failure',
      actor: { type: 'operator', id: 'member-1' },
      ops,
      observedAt: '2026-08-30T08:00:00.000Z',
    })),
    (error) => {
      assert.equal(error.receipt.status, 'failed');
      assert.equal(error.receipt.first_divergence.stage, 'first_upload');
      assert.equal(error.receipt.product_handshake.terminal, 'explicit_first_workload_failure');
      return true;
    },
  );
  assert.ok(ops.state.calls.includes('deleteFirmInDb'));
  assert.ok(!ops.state.calls.some((call) => call.includes('/documents/sync')));
});

test('Gate 2B can continue only after terminal parse and Gate 2A still owns complete retirement', async () => {
  const ops = fakeOps();
  const result = await withEnv(() => continueGate2aLifecycle({
    runToken: 'unit-continuation',
    actor: { type: 'operator', id: 'member-1' },
    ops,
    observedAt: '2026-08-30T08:00:00.000Z',
    continuation: async (context) => {
      assert.equal(context.persisted.document.parse_status, 'completed');
      assert.equal(context.persisted.transactions.length, 1);
      context.registerStorageRef({ bucket: 'evidence', key: 'gate2b/supporting-document' });
      return { next: 'reconciliation' };
    },
  }));
  assert.equal(result.receipt.status, 'passed');
  assert.deepEqual(result.continuationResult, { next: 'reconciliation' });
  assert.deepEqual(ops.state.storageDeleteArgs, {
    bucket: 'evidence', keys: ['gate2a/key', 'gate2b/supporting-document'],
  });
  assert.ok(ops.state.calls.indexOf('dispatchQueuedParseJobsOnce') < ops.state.calls.indexOf('deleteEvidenceObjects'));
});

test('a failed Gate 2B continuation cannot launder Gate 2A or skip retirement', async () => {
  const ops = fakeOps();
  await assert.rejects(
    withEnv(() => continueGate2aLifecycle({
      runToken: 'unit-continuation-failure',
      actor: { type: 'operator', id: 'member-1' },
      ops,
      observedAt: '2026-08-30T08:00:00.000Z',
      continuation: async () => { throw Object.assign(new Error('downstream refused'), { code: 'EAW_GATE2B_REFUSED' }); },
    })),
    (error) => {
      assert.equal(error.code, 'EAW_GATE2B_REFUSED');
      assert.equal(error.gate2aReceipt.status, 'passed');
      return true;
    },
  );
  assert.ok(ops.state.calls.includes('deleteFirmInDb'));
  assert.ok(ops.state.calls.includes('countFirmResidueInDb'));
});
