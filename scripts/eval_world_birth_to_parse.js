#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { handleDonnaApiRequest } from '../server/donna/api.js';
import { dispatchQueuedParseJobsOnce } from '../server/donna/desktop/parseDocumentJob.js';
import { deleteEvidenceObjects } from '../server/donna/evidenceStorage.js';
import {
  countFirmResidueInDb,
  createFirmInDb,
  deleteFirmInDb,
  isFirmDatabaseConfigured,
  queryFirmDb,
} from '../server/donna/firmDb.js';
import {
  GATE2A_RAW_BYTE_RECEIPT_VERSION,
  GATE2A_WORLD_PATH,
  buildGate2aRawByteReceipt,
  selectGate2aRenderedArtifact,
  validateGate2aWorld,
} from '../server/donna/world/gate2aRawByteProof.js';
import { renderWorldArtifacts } from '../server/donna/world/worldRenderer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ENV_OVERRIDES = Object.freeze({
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  AUTO_AI_CODING_ENABLED: '0',
  INNGEST_EVENT_KEY: '',
  INNGEST_SIGNING_KEY: '',
  CLIENT_CONFIG_FORCE_DISABLE: 'DOCUMENT_ROUTER_ENABLED,MODEL_CHALLENGER',
  PARSE_DRAIN_THRESHOLD_SECONDS: '0',
});

export function assertGate2aRunIdentity({ runToken, firmId, clientId, documentId } = {}) {
  if (!/^[a-z0-9-]+$/.test(runToken || '')) {
    throw coded('EAW_RUN_TOKEN_REQUIRED', 'A deterministic lowercase --run-token is required.');
  }
  if (!/^eaw-[a-z0-9-]+$/.test(firmId || '')) throw coded('EAW_FIRM_ID_REQUIRED', 'Gate 2A requires an isolated eaw- firm id.');
  if (clientId !== `${firmId}-client-1`) throw coded('EAW_CLIENT_ID_REQUIRED', 'Gate 2A client identity must belong uniquely to its run firm.');
  if (documentId !== `${clientId}-first-document`) throw coded('EAW_DOCUMENT_ID_REQUIRED', 'Gate 2A document identity must belong uniquely to its run client.');
}

export function bindProductionOperations(overrides = {}) {
  return Object.freeze({
    isFirmDatabaseConfigured,
    createFirmInDb,
    deleteFirmInDb,
    countFirmResidueInDb,
    deleteEvidenceObjects,
    queryFirmDb,
    requestApi,
    dispatchQueuedParseJobsOnce,
    renderWorldArtifacts,
    ...overrides,
  });
}

// The scheduler's log lines go to stderr: stdout is the receipt channel.
const quietDispatchLogger = () => ({
  log: () => {},
  info: () => {},
  warn: (...args) => console.error(...args),
  error: (...args) => console.error(...args),
});

export async function loadGate2aWorld({ readFile = fs.readFile, worldPath = GATE2A_WORLD_PATH } = {}) {
  const world = JSON.parse(await readFile(path.join(ROOT, worldPath), 'utf8'));
  const validation = validateGate2aWorld(world);
  if (!validation.ok) throw coded('EAW_GATE2A_WORLD_INVALID', validation.errors.join('; '));
  return world;
}

export async function uploadAndRegisterRawDocument({
  ops,
  firmId,
  clientId,
  documentId,
  filename,
  mimeType,
  documentType,
  bytes,
  uploadedAt,
  batchId,
  note,
} = {}) {
  if (!ops?.requestApi) throw coded('EAW_API_OPERATION_REQUIRED', 'The mounted API operation is required.');
  if (![firmId, clientId, documentId, filename, mimeType, documentType, batchId].every((value) => typeof value === 'string' && value.trim())) {
    throw coded('EAW_RAW_DOCUMENT_IDENTITY_REQUIRED', 'Raw document registration requires complete deterministic identity.');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw coded('EAW_RAW_DOCUMENT_BYTES_REQUIRED', 'Raw document bytes are required.');
  if (!Number.isFinite(uploadedAt)) throw coded('EAW_RAW_DOCUMENT_TIME_REQUIRED', 'Raw document uploadedAt must be an epoch timestamp.');
  const receipts = {};
  let storageRef = null;
  try {
    const rawChecksum = sha256(bytes);
    const signed = await ops.requestApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: authenticatedJsonHeaders(),
      body: JSON.stringify({
        firm_id: firmId,
        client_id: clientId,
        filename,
        mime_type: mimeType,
        size: bytes.length,
        checksum_sha256: rawChecksum,
      }),
    });
    receipts.upload_sign = signed.json;
    assertApi(signed, 200, 'EAW_RAW_DOCUMENT_UPLOAD_SIGN_FAILED');
    storageRef = { bucket: signed.json.bucket, key: signed.json.key };

    // Origin-relative in local mode (evidenceStorage.js); only path + search
    // are used, against the ops' own transport.
    const signedUrl = new URL(signed.json.signed_url, 'http://127.0.0.1');
    const put = await ops.requestApi({
      method: 'PUT',
      url: `${signedUrl.pathname}${signedUrl.search}`,
      headers: { 'content-type': mimeType, 'x-upsert': 'false' },
      body: bytes,
    });
    receipts.blob_put = put.json;
    assertApi(put, 200, 'EAW_RAW_DOCUMENT_BLOB_PUT_FAILED');

    const registration = await ops.requestApi({
      method: 'POST',
      url: '/api/donna/firms/documents/register',
      headers: authenticatedJsonHeaders(),
      body: JSON.stringify({
        firm_id: firmId,
        documents: [{
          id: documentId,
          client_id: clientId,
          filename,
          document_type: documentType,
          uploaded_at: uploadedAt,
          source: 'firm_intake',
          storage_bucket: signed.json.bucket,
          storage_object_key: signed.json.key,
          checksum_sha256: rawChecksum,
          file_storage: {
            mode: 'object_storage',
            provider: signed.json.provider,
            bucket: signed.json.bucket,
            key: signed.json.key,
            checksum_sha256: rawChecksum,
            filename,
            mime_type: mimeType,
            size: bytes.length,
            note: note || 'EAW raw document routed through the mounted product contract.',
          },
          batch_id: batchId,
        }],
      }),
    });
    receipts.register = registration.json;
    assertApi(registration, 200, 'EAW_RAW_DOCUMENT_REGISTER_FAILED');
    const registered = registration.json?.documents?.[0];
    if (!registered?.parse_run_id || registered?.parse_status !== 'pending') {
      throw coded('EAW_RAW_DOCUMENT_NOT_QUEUED', 'The product handshake did not persist pending parse work.');
    }
    return Object.freeze({ rawChecksum, storageRef, registered, receipts });
  } catch (error) {
    throw Object.assign(error, { rawDocumentReceipts: receipts, storageRef });
  }
}

async function executeGate2aLifecycle({
  runToken,
  actor,
  world,
  worldPath = GATE2A_WORLD_PATH,
  ops = bindProductionOperations(),
  observedAt = new Date().toISOString(),
  clock = monotonicMilliseconds,
  continuation = null,
} = {}) {
  const startedAt = clock();
  const firmId = `eaw-${runToken}`;
  const clientId = `${firmId}-client-1`;
  const documentId = `${clientId}-first-document`;
  const effectiveActor = actor || null;
  assertGate2aRunIdentity({ runToken, firmId, clientId, documentId });
  if (!effectiveActor?.type || !effectiveActor?.id) {
    throw coded('EAW_ACTOR_REQUIRED', 'Gate 2A needs the real operator actor type and id.');
  }
  if (!ops.isFirmDatabaseConfigured()) {
    throw coded('EAW_DB_UNCONFIGURED', 'Gate 2A requires the configured production PostgreSQL boundary.');
  }
  if (!process.env.DONNA_DESKTOP_BLOB_DIR) {
    throw coded('EAW_LOCAL_STORAGE_REQUIRED', 'Gate 2A requires the desktop local object-store path.');
  }
  if (!process.env.DONNA_ACCESS_TOKEN) {
    throw coded('EAW_ACCESS_TOKEN_REQUIRED', 'Gate 2A needs the authenticated desktop access token.');
  }

  const declaredWorld = world || await loadGate2aWorld({ worldPath });
  const rendered = await ops.renderWorldArtifacts(declaredWorld);
  const selected = selectGate2aRenderedArtifact({ world: declaredWorld, rendered });
  const rawChecksum = sha256(selected.bytes);
  const stageResults = {};
  const routeReceipts = {};
  let currentStage = 'create_path';
  let created = false;
  let persisted = { expected_document_id: documentId, transactions: [], audit_events: [], counts: {} };
  let isolation = {};
  let cleanup = null;
  let failure = null;
  let storageRef = null;
  const storageRefs = [];
  let continuationResult = null;
  let continuationFailure = null;

  try {
    const firmCreate = await ops.createFirmInDb({
      firmId,
      name: `EAW Gate 2A ${declaredWorld.worldId}`,
      jurisdiction: 'GB',
      currency: 'GBP',
      actor: effectiveActor,
      member: {
        id: `${firmId}-member-1`,
        name: 'Gate 2A Isolated Operator',
        email: `gate2a-${runToken}@example.invalid`,
      },
    });
    created = true;
    routeReceipts.firm_create = firmCreate;

    const create = await ops.requestApi({
      method: 'POST',
      url: '/api/donna/firms/clients',
      headers: authenticatedJsonHeaders(),
      body: JSON.stringify({
        firm_id: firmId,
        profile: { ...declaredWorld.gate2a.profile, id: clientId },
        queue: [],
      }),
    });
    routeReceipts.client_create = apiReceipt(create);
    assertApi(create, 200, 'EAW_GATE2A_CREATE_FAILED');
    persisted = await readGate2aInventory({ ops, firmId, clientId, documentId });
    stageResults.create_path = stage('passed', auditIds(persisted.audit_events, ['firm.eaw_created', 'client.create']));

    currentStage = 'build_and_migration';
    if (persisted.host?.status !== 'PASS') {
      throw coded('EAW_GATE2A_HOST_NOT_READY', 'The current persisted Host Certificate A is not PASS.');
    }
    stageResults.build_and_migration = stage('passed', [`runtime_host_readiness_attempt:${persisted.host.latest_attempt_id}`]);

    currentStage = 'canonical_identity';
    if (persisted.client?.entity_type !== 'gb-ltd' || persisted.client?.jurisdiction !== 'GB') {
      throw coded('EAW_GATE2A_IDENTITY_DIVERGED', 'The create route did not persist the canonical GB limited-company identity.');
    }
    stageResults.canonical_identity = stage('passed', auditIds(persisted.audit_events, ['client.create']));

    currentStage = 'config_chart_authority';
    if (persisted.readiness?.state !== 'ready') {
      throw coded(
        'EAW_GATE2A_ENTITY_NOT_READY',
        `Entity readiness is ${persisted.readiness?.state || 'missing'} (${persisted.readiness?.reason_code || 'reason unavailable'}; ${persisted.readiness?.responsible_system || 'system unavailable'}).`,
      );
    }
    stageResults.config_chart_authority = stage('passed', [
      `entity_readiness_attempt:${persisted.readiness.latest_attempt_id}`,
      ...auditIds(persisted.audit_events, ['entity.provisioning.attempt']),
    ]);

    currentStage = 'first_upload';
    await withModelLanesDisabled(async () => {
      try {
        const uploaded = await uploadAndRegisterRawDocument({
          ops,
          firmId,
          clientId,
          documentId,
          filename: declaredWorld.gate2a.filename,
          mimeType: declaredWorld.gate2a.mimeType,
          documentType: declaredWorld.gate2a.documentType,
          bytes: selected.bytes,
          uploadedAt: Date.parse(`${declaredWorld.effectiveDate}T00:00:00.000Z`),
          batchId: `${runToken}-first-intake`,
          note: 'Gate 2A first intake document routed through the mounted product contract.',
        });
        routeReceipts.upload_sign = uploaded.receipts.upload_sign;
        routeReceipts.blob_put = uploaded.receipts.blob_put;
        routeReceipts.register = uploaded.receipts.register;
        storageRef = uploaded.storageRef;
        storageRefs.push(storageRef);
      } catch (error) {
        routeReceipts.upload_sign = error.rawDocumentReceipts?.upload_sign;
        routeReceipts.blob_put = error.rawDocumentReceipts?.blob_put;
        routeReceipts.register = error.rawDocumentReceipts?.register;
        storageRef = error.storageRef;
        if (storageRef) storageRefs.push(storageRef);
        if (error.rawDocumentReceipts?.register) {
          routeReceipts.first_workload_failure = {
            code: error.code || 'EAW_GATE2A_REGISTER_FAILED',
            message: error.message,
          };
        }
        throw error;
      }
    });
    persisted = await readGate2aInventory({ ops, firmId, clientId, documentId, storageRef });
    stageResults.first_upload = stage('passed', auditIds(persisted.audit_events, ['document.parse.queued']));

    currentStage = 'worker_stage';
    await withModelLanesDisabled(async () => {
      // RT-08: the register route enqueued the parse as a `parse-document`
      // local job; the worker stage dispatches that queue once — the real
      // handler over the real durable steps — instead of the per-minute drain
      // backstop, which no longer touches a row the queue owns.
      const dispatched = await ops.dispatchQueuedParseJobsOnce({
        client: { query: (text, params) => ops.queryFirmDb(text, params) },
        logger: quietDispatchLogger(),
      });
      routeReceipts.parse_dispatch = dispatched;
      if (!dispatched?.settled?.length) {
        throw coded('EAW_GATE2A_PARSE_JOB_MISSING', 'No parse-document job was dispatched for the registered document.');
      }
    });
    persisted = await readGate2aInventory({ ops, firmId, clientId, documentId, storageRef });
    if (persisted.document?.parse_status !== 'completed') {
      throw coded(
        'EAW_GATE2A_PARSE_NOT_COMPLETED',
        `First document parse finished as ${persisted.document?.parse_status || 'missing'}.`,
      );
    }
    stageResults.worker_stage = stage('passed', auditIds(persisted.audit_events, ['document.parse.completed']));
    isolation = await readGate2aIsolation({ ops, firmId, clientId });
    if (typeof continuation === 'function') {
      try {
        continuationResult = await continuation(Object.freeze({
          world: declaredWorld,
          worldPath,
          rendered,
          firstArtifact: selected,
          firmId,
          clientId,
          documentId,
          actor: effectiveActor,
          ops,
          observedAt,
          persisted,
          isolation,
          routeReceipts,
          registerStorageRef(ref) {
            if (!ref?.bucket || !ref?.key) throw coded('EAW_STORAGE_REF_INVALID', 'Continuation storage refs require bucket and key.');
            if (!storageRefs.some((item) => item.bucket === ref.bucket && item.key === ref.key)) storageRefs.push({ bucket: ref.bucket, key: ref.key });
          },
        }));
      } catch (error) {
        continuationFailure = error instanceof Error ? error : coded('EAW_CONTINUATION_FAILED', String(error));
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : coded('EAW_GATE2A_FAILED', String(error));
    if (!stageResults[currentStage]) {
      stageResults[currentStage] = stage('failed', [`failure:${failure.code || 'EAW_GATE2A_FAILED'}`], failure.code || 'EAW_GATE2A_FAILED');
    }
    if (currentStage === 'first_upload' && !routeReceipts.first_workload_failure) {
      routeReceipts.first_workload_failure = { code: failure.code || 'EAW_GATE2A_FIRST_WORKLOAD_FAILED', message: failure.message };
    }
    try {
      persisted = await readGate2aInventory({ ops, firmId, clientId, documentId, storageRef });
      isolation = await readGate2aIsolation({ ops, firmId, clientId });
    } catch { /* first divergence remains the useful result */ }
  } finally {
    if (created) {
      const cleanupError = [];
      let storageDelete = null;
      let deleteReceipt = null;
      let residue = null;
      if (storageRefs.length) {
        try {
          const byBucket = new Map();
          for (const ref of storageRefs) byBucket.set(ref.bucket, [...(byBucket.get(ref.bucket) || []), ref.key]);
          const deletes = [];
          for (const [bucket, keys] of byBucket) deletes.push(await ops.deleteEvidenceObjects({ bucket, keys }));
          storageDelete = deletes.length === 1 ? deletes[0] : deletes;
        } catch (error) {
          cleanupError.push({ code: error.code || 'EAW_GATE2A_STORAGE_CLEANUP_FAILED', message: error.message });
        }
      }
      try { deleteReceipt = await ops.deleteFirmInDb({ firmId, actor: effectiveActor }); }
      catch (error) { cleanupError.push({ code: error.code || 'EAW_GATE2A_RETIRE_FAILED', message: error.message }); }
      try { residue = await ops.countFirmResidueInDb({ firmId, clientIds: [clientId] }); }
      catch (error) { cleanupError.push({ code: error.code || 'EAW_GATE2A_RESIDUE_PROBE_FAILED', message: error.message }); }
      cleanup = {
        storage_delete: storageDelete,
        delete_receipt: deleteReceipt,
        post_delete_residue: residue,
        errors: cleanupError,
      };
      if (cleanupError.length || !deleteReceipt?.residue_verified || residue?.residue_rows !== 0) {
        failure ||= coded('EAW_GATE2A_CLEANUP_FAILED', 'Gate 2A retirement did not prove zero unintended residue.');
      }
    }
  }

  const receipt = buildGate2aRawByteReceipt({
    world: declaredWorld,
    worldPath,
    renderedArtifact: selected,
    firmId,
    clientId,
    documentId,
    observedAt,
    stageResults,
    routeReceipts,
    persisted,
    isolation,
    cleanup,
    failure,
    wallTimeMs: Math.max(0, Math.round(clock() - startedAt)),
  });
  if (receipt.status !== 'passed') {
    const error = failure || coded(receipt.failure?.code || 'EAW_GATE2A_FAILED', receipt.failure?.message || 'Gate 2A failed.');
    throw Object.assign(error, { receipt });
  }
  if (continuationFailure) {
    throw Object.assign(continuationFailure, { gate2aReceipt: receipt, continuationResult });
  }
  return { receipt, continuationResult };
}

export async function runGate2a(options = {}) {
  const result = await executeGate2aLifecycle(options);
  return result.receipt;
}

// Gate 2B composes the already-proven birth-to-parse path inside the same
// isolated lifecycle, then Gate 2A retains ownership of retirement. The
// continuation receives persisted reads and production operations only; it
// cannot replace or skip the mounted create/upload/register/worker sequence.
export async function continueGate2aLifecycle({ continuation, ...options } = {}) {
  if (typeof continuation !== 'function') throw coded('EAW_CONTINUATION_REQUIRED', 'A Gate 2A lifecycle continuation is required.');
  return executeGate2aLifecycle({ ...options, continuation });
}

export async function readGate2aInventory({ ops, firmId, clientId, documentId, storageRef = null } = {}) {
  const [client, readiness, host, document, transactions, counts, auditEvents, storage] = await Promise.all([
    ops.queryFirmDb(
      'select id, firm_id, jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2',
      [firmId, clientId],
    ),
    ops.queryFirmDb(
      `select state, latest_attempt_id, ready_dependency_digest, reason_code, responsible_system
         from entity_readiness_sagas where firm_id = $1 and client_id = $2`,
      [firmId, clientId],
    ),
    ops.queryFirmDb(
      `select status, latest_attempt_id, compatibility_digest, receipt_digest
         from runtime_host_readiness where host_id = 'desktop-local'`,
      [],
    ),
    ops.queryFirmDb(
      `select id, client_id, source, document_type, storage_bucket, storage_object_key,
              checksum_sha256, parse_status, parse_run_id::text, parse_summary, payload
         from documents where firm_id = $1 and id = $2`,
      [firmId, documentId],
    ),
    ops.queryFirmDb(
      `select id, document_id, transaction_date, money_in, money_out, currency, status, payload
         from transactions where firm_id = $1 and client_id = $2 order by id`,
      [firmId, clientId],
    ),
    ops.queryFirmDb(
      `select
         (select count(*)::int from clients where firm_id = $1) as clients,
         (select count(*)::int from documents where firm_id = $1) as documents,
         (select count(*)::int from transactions where firm_id = $1) as transactions`,
      [firmId],
    ),
    ops.queryFirmDb(
      `select id, action from audit_events where firm_id = $1 order by id`,
      [firmId],
    ),
    storageRef?.bucket && storageRef?.key
      ? ops.queryFirmDb(
          `select bucket, key, content_hash, byte_length, content_type
             from local_evidence_objects where bucket = $1 and key = $2`,
          [storageRef.bucket, storageRef.key],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    expected_document_id: documentId,
    client: client.rows?.[0] || null,
    readiness: readiness.rows?.[0] || null,
    host: host.rows?.[0] || null,
    document: document.rows?.[0] || null,
    transactions: transactions.rows || [],
    counts: counts.rows?.[0] || {},
    audit_events: auditEvents.rows || [],
    storage: storage.rows?.[0] || null,
  };
}

export async function readGate2aIsolation({ ops, firmId, clientId } = {}) {
  const result = await ops.queryFirmDb(
    `select
       (select count(*)::int from firm_members where firm_id = $1) as firm_members,
       (select count(*)::int from client_evidence_requests where firm_id = $1 and client_id = $2) as client_evidence_requests,
       (select count(*)::int from ledger_journals where firm_id = $1 and client_id = $2) as ledger_journals,
       (select count(*)::int from message_delivery_ledger where client_id = $2) as message_delivery_ledger,
       (select count(*)::int from outbound_actions where firm_id = $1 and client_id = $2) as outbound_actions,
       (select count(*)::int from xero_connections where firm_id = $1 and client_id = $2) as xero_connections,
       (select count(*)::int from qbo_connections where firm_id = $1 and client_id = $2) as qbo_connections,
       (select count(*)::int from procountor_connections where firm_id = $1 and client_id = $2) as procountor_connections,
       (select count(*)::int from hmrc_connections where firm_id = $1 and client_id = $2) as hmrc_connections`,
    [firmId, clientId],
  );
  return { external_destinations: 'isolated', counts: result.rows?.[0] || {} };
}

export async function requestApi({ method = 'GET', url, headers = {}, body } = {}) {
  const bytes = body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const req = Readable.from(bytes);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return new Promise((resolve, reject) => {
    const responseHeaders = new Map();
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader(name, value) { responseHeaders.set(String(name).toLowerCase(), value); },
      getHeader(name) { return responseHeaders.get(String(name).toLowerCase()); },
      write(chunk) { chunks.push(Buffer.from(chunk)); },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        const responseBody = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = responseBody ? JSON.parse(responseBody) : null; } catch { /* binary response */ }
        resolve({ statusCode: this.statusCode, headers: Object.fromEntries(responseHeaders), body: responseBody, json });
      },
    };
    Promise.resolve(handleDonnaApiRequest(req, res)).catch(reject);
  });
}

async function withModelLanesDisabled(work) {
  const prior = Object.fromEntries(Object.keys(MODEL_ENV_OVERRIDES).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(MODEL_ENV_OVERRIDES)) process.env[key] = value;
    return await work();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function authenticatedJsonHeaders() {
  return {
    authorization: `Bearer ${process.env.DONNA_ACCESS_TOKEN}`,
    'content-type': 'application/json',
  };
}

function stage(status, receiptIds, reasonCode = null) {
  const ids = [...new Set((receiptIds || []).map(String).filter(Boolean))];
  return { status, receipt_ids: ids.length ? ids : [`gate2a:${status}`], reason_code: reasonCode };
}

function auditIds(events, actions) {
  const wanted = new Set(actions);
  return (events || []).filter(({ action }) => wanted.has(action)).map(({ id, action }) => `audit_event:${id}:${action}`);
}

function apiReceipt(response) {
  return { status_code: response?.statusCode || null, code: response?.json?.code || null, error: response?.json?.error || null };
}

function assertApi(response, expected, code) {
  if (response?.statusCode === expected) return;
  throw coded(code, response?.json?.error || response?.body || `Expected HTTP ${expected}, received ${response?.statusCode || 'none'}.`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? null : args[index + 1];
  };
  const output = value('--output');
  try {
    const receipt = await runGate2a({
      runToken: value('--run-token'),
      actor: { type: value('--actor-type') || 'operator', id: value('--actor-id') },
    });
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (output) await fs.writeFile(output, text, { flag: 'wx' });
    else process.stdout.write(text);
  } catch (error) {
    const body = error.receipt || {
      version: GATE2A_RAW_BYTE_RECEIPT_VERSION,
      status: 'failed',
      failure: { code: error.code || 'EAW_GATE2A_FAILED', message: error.message },
    };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    if (output) await fs.writeFile(output, text, { flag: 'wx' });
    else process.stderr.write(text);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
