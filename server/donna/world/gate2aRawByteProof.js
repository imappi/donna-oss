import { createHash } from 'node:crypto';

import {
  FRESH_ENTITY_DIAGNOSTIC_STAGES,
  buildFreshEntityDiagnosticReceipt,
} from './freshEntityDiagnostic.js';
import { canonicalJson } from './unitExecutionReceipt.js';
import { validateCausalWorld } from './worldValidity.js';
import { validateWorldSpec } from './worldSchema.js';

export const GATE2A_RAW_BYTE_RECEIPT_VERSION = 'eaw.gate2a.raw-byte.v1';
export const GATE2A_WORLD_PATH = 'data/worlds/gate2a-raw-byte-month.json';

const SHA256 = /^[0-9a-f]{64}$/;

export const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex');

export function validateGate2aWorld(world) {
  const errors = [];
  const shape = validateWorldSpec(world);
  if (!shape.ok) errors.push(...shape.errors);
  const causal = validateCausalWorld(world);
  if (!causal.ok) errors.push(...causal.errors.map((error) => `validity.${error}`));

  const gate = world?.gate2a;
  if (!isObject(gate)) {
    errors.push('gate2a must be an object');
  } else {
    for (const key of ['firstDocumentArtifactId', 'filename', 'mimeType', 'documentKind', 'documentType']) {
      if (!clean(gate[key])) errors.push(`gate2a.${key} must be a non-empty string`);
    }
    if (gate.mimeType !== 'application/pdf') {
      errors.push('gate2a.mimeType must be application/pdf so the mounted intake retains the raw bytes');
    }
    if (gate.documentKind !== 'bank_statement' || gate.documentType !== 'bank_statement') {
      errors.push('gate2a first document must use the bank_statement product lane');
    }
    if (!isObject(gate.profile)) errors.push('gate2a.profile must be an object');
    for (const key of ['companyName', 'entityType', 'jurisdiction']) {
      if (!clean(gate.profile?.[key])) errors.push(`gate2a.profile.${key} must be a non-empty string`);
    }
  }

  const matching = Array.isArray(world?.artifacts)
    ? world.artifacts.filter(({ id }) => id === gate?.firstDocumentArtifactId)
    : [];
  if (matching.length !== 1) errors.push('gate2a.firstDocumentArtifactId must identify exactly one declared artifact');
  if (matching[0]?.format !== 'pdf') errors.push('gate2a first document artifact must render as pdf');

  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

export function selectGate2aRenderedArtifact({ world, rendered } = {}) {
  const validation = validateGate2aWorld(world);
  if (!validation.ok) throw coded('EAW_GATE2A_WORLD_INVALID', validation.errors.join('; '));
  if (!rendered?.ok) throw coded('EAW_GATE2A_RENDER_FAILED', (rendered?.errors || []).join('; '));
  const selected = (rendered.artifacts || []).filter(({ id }) => id === world.gate2a.firstDocumentArtifactId);
  if (selected.length !== 1) {
    throw coded('EAW_GATE2A_ARTIFACT_MISSING', 'The renderer did not return exactly one first-document artifact.');
  }
  const artifact = selected[0];
  const bytes = Buffer.from(artifact.contentBase64, 'base64');
  if (!bytes.length) throw coded('EAW_GATE2A_ARTIFACT_EMPTY', 'The rendered first document has no raw bytes.');
  return Object.freeze({
    artifact,
    bytes,
    raw_sha256: sha256Bytes(bytes),
    byte_length: bytes.length,
  });
}

export function orderedDiagnosticStages(stageResults = {}) {
  let divergenceSeen = false;
  return FRESH_ENTITY_DIAGNOSTIC_STAGES.map((stage) => {
    const result = stageResults[stage] || null;
    if (divergenceSeen || !result) {
      divergenceSeen = true;
      return {
        stage,
        status: 'not_reached',
        reason_code: result?.reason_code || 'prior_stage_not_terminal',
        receipt_ids: [],
      };
    }
    const status = result.status || 'passed';
    if (status === 'failed' || status === 'incomplete') divergenceSeen = true;
    return {
      stage,
      status,
      reason_code: status === 'passed' ? null : clean(result.reason_code) || 'stage_failed',
      receipt_ids: uniqueStrings(result.receipt_ids),
    };
  });
}

export function buildGate2aRawByteReceipt({
  world,
  worldPath = GATE2A_WORLD_PATH,
  renderedArtifact,
  firmId,
  clientId,
  documentId,
  observedAt,
  stageResults,
  routeReceipts = {},
  persisted = {},
  isolation = {},
  cleanup = null,
  failure = null,
  wallTimeMs = 0,
} = {}) {
  const validation = validateGate2aWorld(world);
  if (!validation.ok) throw coded('EAW_GATE2A_WORLD_INVALID', validation.errors.join('; '));
  for (const [key, value] of Object.entries({ firmId, clientId, documentId, observedAt, worldPath })) {
    if (!clean(value)) throw new TypeError(`${key} must be a non-empty string`);
  }
  if (Number.isNaN(Date.parse(observedAt))) throw new TypeError('observedAt must be an ISO timestamp');
  if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs < 0) throw new TypeError('wallTimeMs must be a non-negative safe integer');
  if (!renderedArtifact || !Buffer.isBuffer(renderedArtifact.bytes)) {
    throw new TypeError('renderedArtifact must include the exact raw Buffer');
  }

  const stages = orderedDiagnosticStages(stageResults);
  const diagnostic = buildFreshEntityDiagnosticReceipt({
    incidentId: `gate2a/${world.worldId}`,
    observedAt,
    firmId,
    clientId,
    creationPath: 'desktop_firm_intake',
    stages,
    retainedArtifact: {
      artifact_id: world.gate2a.firstDocumentArtifactId,
      sha256: renderedArtifact.raw_sha256,
      retention_status: 'retained',
      source_class: 'fictional_eaw_world',
      authorization: {
        status: 'authorized',
        purpose: 'diagnostic_replay',
        authority_id: 'eaw_isolated_firm_operator',
      },
    },
    diagnosticWallTimeMs: wallTimeMs,
  });

  const sourceInventory = buildSourceInventory({
    world,
    worldPath,
    renderedArtifact,
    documentId,
    routeReceipts,
    persisted,
  });
  const successErrors = diagnostic.status === 'passed'
    ? validateSuccessfulInventory({ sourceInventory, persisted, isolation, cleanup })
    : [];
  const normalizedFailure = failure
    ? { code: clean(failure.code) || 'EAW_GATE2A_FAILED', message: clean(failure.message) || 'Gate 2A failed.' }
    : null;
  const status = normalizedFailure || diagnostic.status !== 'passed' || successErrors.length
    ? (diagnostic.status === 'incomplete' ? 'incomplete' : 'failed')
    : 'passed';
  const effectiveFailure = normalizedFailure || (successErrors.length
    ? { code: 'EAW_GATE2A_INVENTORY_MISMATCH', message: successErrors.join('; ') }
    : null);
  const body = {
    version: GATE2A_RAW_BYTE_RECEIPT_VERSION,
    status,
    scope: {
      gate: '2A',
      claim: 'raw_bytes_to_terminal_parse_only',
      excludes: ['live_model', 'reconciliation', 'coding', 'owner_ask', 'ledger_post', 'quiescence', 'C1'],
    },
    observed_at: observedAt,
    world: {
      world_id: world.worldId,
      seed: world.seed,
      path: worldPath,
      spec_sha256: sha256Bytes(canonicalJson(world)),
    },
    entity: { firm_id: firmId, client_id: clientId, document_id: documentId },
    product_handshake: {
      sequence: [
        'POST /api/donna/firms/clients',
        'POST /api/donna/firms/documents/upload-url',
        'PUT /api/donna/evidence-local',
        'POST /api/donna/firms/documents/register',
        'dispatch local_jobs parse-document (the run the register route enqueued)',
      ],
      terminal: sourceInventory.handshake_terminal,
      first_workload_visible: sourceInventory.handshake_terminal === 'ready_document_work_queued'
        || sourceInventory.handshake_terminal === 'explicit_first_workload_failure',
    },
    source_inventory: sourceInventory,
    isolation: normalizeIsolation(isolation),
    first_divergence: diagnostic.first_divergence,
    diagnostic,
    cleanup: jsonSafe(cleanup),
    spend: {
      status: 'known_zero_model',
      modelSpendUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      solveCalls: 0,
      wallTimeMs,
      providerResponses: [],
      modelIds: [],
      pricingSource: { status: 'not_applicable', reason: 'gate2a_stops_before_live_model' },
      configurationDigest: sha256Bytes(canonicalJson({
        version: GATE2A_RAW_BYTE_RECEIPT_VERSION,
        path: 'desktop_firm_intake/local_blob/register/local_jobs:parse-document',
        model_lanes: 'disabled_for_gate2a',
      })),
      artifactDigests: [renderedArtifact.raw_sha256],
      basis: 'deterministic_raw_byte_parse_proof',
    },
    failure: effectiveFailure,
  };
  return Object.freeze({ ...body, receipt_digest: sha256Bytes(canonicalJson(body)) });
}

function buildSourceInventory({ world, worldPath, renderedArtifact, documentId, routeReceipts, persisted }) {
  const document = persisted.document || null;
  const transactions = Array.isArray(persisted.transactions) ? persisted.transactions : [];
  const registerDocument = routeReceipts.register?.documents?.[0] || null;
  const ready = persisted.readiness?.state === 'ready';
  const queued = Boolean(registerDocument?.parse_run_id || document?.parse_run_id);
  const explicitFailure = Boolean(routeReceipts.first_workload_failure);
  return {
    declared: {
      world_path: worldPath,
      event_ids: world.events.map(({ id }) => id),
      observation_ids: world.observations.map(({ id }) => id),
      artifact_ids: world.artifacts.map(({ id }) => id),
    },
    first_document: {
      artifact_id: renderedArtifact.artifact.id,
      filename: world.gate2a.filename,
      mime_type: world.gate2a.mimeType,
      document_type: world.gate2a.documentType,
      renderer_version: renderedArtifact.artifact.rendererVersion,
      renderer_base64_payload_sha256: renderedArtifact.artifact.sha256,
      raw_bytes_sha256: renderedArtifact.raw_sha256,
      byte_length: renderedArtifact.byte_length,
    },
    storage: persisted.storage ? {
      provider: routeReceipts.upload_sign?.provider || null,
      bucket: persisted.storage.bucket,
      key: persisted.storage.key,
      content_hash: persisted.storage.content_hash,
      byte_length: Number(persisted.storage.byte_length),
      put_content_hash: routeReceipts.blob_put?.content_hash || null,
      signed_checksum_sha256: routeReceipts.upload_sign?.checksum_sha256 || null,
    } : null,
    registration: document ? {
      id: document.id,
      source: document.source,
      document_type: document.document_type,
      storage_bucket: document.storage_bucket,
      storage_object_key: document.storage_object_key,
      checksum_sha256: document.checksum_sha256,
      parse_status: document.parse_status,
      parse_run_id: document.parse_run_id,
      parse_transaction_count: Number(document.parse_summary?.transaction_count || 0),
      route_parse_run_id: registerDocument?.parse_run_id || null,
      event_sent: registerDocument?.event_sent ?? null,
    } : null,
    parsed_transactions: transactions.map((row) => ({
      id: row.id,
      document_id: row.document_id,
      transaction_date: isoDay(row.transaction_date),
      money_in: Number(row.money_in || 0),
      money_out: Number(row.money_out || 0),
      currency: row.currency || null,
      status: row.status || null,
      source: row.payload?.source || null,
      source_document_id: row.payload?.source_document_id || null,
    })),
    persisted_counts: normalizeCounts(persisted.counts),
    audit_receipts: (persisted.audit_events || []).map(({ id, action }) => ({ id: String(id), action })),
    injection_guard: {
      interpreted_row_injection: false,
      documents_sync_route_invoked: false,
      normalized_transaction_seed_invoked: false,
      required_document_source: 'firm_intake',
      required_transaction_source: 'async_parse',
    },
    handshake_terminal: ready && queued
      ? 'ready_document_work_queued'
      : explicitFailure ? 'explicit_first_workload_failure' : 'missing_terminal_handshake',
  };
}

function validateSuccessfulInventory({ sourceInventory, persisted, isolation, cleanup }) {
  const errors = [];
  const first = sourceInventory.first_document;
  const storage = sourceInventory.storage;
  const registration = sourceInventory.registration;
  const transactions = sourceInventory.parsed_transactions;
  const hashes = [
    first.raw_bytes_sha256,
    storage?.content_hash,
    storage?.put_content_hash,
    storage?.signed_checksum_sha256,
    registration?.checksum_sha256,
  ];
  if (!hashes.every((value) => SHA256.test(value || '')) || new Set(hashes).size !== 1) {
    errors.push('raw/upload/storage/document SHA-256 lineage is not exact');
  }
  if (storage?.byte_length !== first.byte_length) errors.push('storage byte length differs from rendered raw bytes');
  if (sourceInventory.handshake_terminal !== 'ready_document_work_queued') errors.push('product handshake did not persist ready + queued work');
  if (persisted.host?.status !== 'PASS') errors.push('current Host A is not PASS');
  if (persisted.readiness?.state !== 'ready') errors.push('entity readiness is not ready');
  if (registration?.id !== persisted.expected_document_id) errors.push('the persisted registration is not the declared first document');
  if (registration?.source !== 'firm_intake') errors.push('the first document did not retain source=firm_intake');
  if (registration?.document_type !== 'bank_statement') errors.push('the first document left the bank-statement lane');
  if (registration?.parse_status !== 'completed') errors.push('the parse did not reach completed');
  if (!registration?.parse_run_id || registration.parse_run_id !== registration.route_parse_run_id) errors.push('registration/worker parse_run_id lineage diverged');
  if (!transactions.length) errors.push('the parser produced no source transaction');
  if (transactions.length !== sourceInventory.persisted_counts.transactions) errors.push('transaction inventory count is incomplete');
  if (registration?.parse_transaction_count !== transactions.length) errors.push('parse summary transaction count differs from persisted inventory');
  for (const transaction of transactions) {
    if (transaction.document_id !== registration?.id || transaction.source_document_id !== registration?.id) {
      errors.push(`transaction ${transaction.id} is not anchored to the first document`);
    }
    if (transaction.source !== 'async_parse') errors.push(`transaction ${transaction.id} was not produced by async_parse`);
  }
  const counts = sourceInventory.persisted_counts;
  if (counts.clients !== 1 || counts.documents !== 1) errors.push('isolated firm source counts are not exactly one client and one document');
  const normalizedIsolation = normalizeIsolation(isolation);
  for (const [name, count] of Object.entries(normalizedIsolation.counts)) {
    const expected = name === 'firm_members' ? 1 : 0;
    if (count !== expected) errors.push(`isolation.${name} expected ${expected}, received ${count}`);
  }
  if (normalizedIsolation.external_destinations !== 'isolated') errors.push('external destinations are not proved isolated');
  if (!cleanup?.delete_receipt?.residue_verified || cleanup?.post_delete_residue?.residue_rows !== 0) {
    errors.push('EAW retirement did not prove zero unintended residue');
  }
  return errors;
}

function normalizeCounts(counts = {}) {
  return Object.freeze({
    clients: Number(counts.clients || 0),
    documents: Number(counts.documents || 0),
    transactions: Number(counts.transactions || 0),
  });
}

function normalizeIsolation(isolation = {}) {
  const counts = {};
  for (const name of [
    'firm_members',
    'client_evidence_requests',
    'ledger_journals',
    'message_delivery_ledger',
    'outbound_actions',
    'xero_connections',
    'qbo_connections',
    'procountor_connections',
    'hmrc_connections',
  ]) counts[name] = Number(isolation?.counts?.[name] || 0);
  return Object.freeze({
    external_destinations: isolation.external_destinations || 'unproved',
    counts: Object.freeze(counts),
  });
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function isoDay(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

function clean(value) {
  return String(value ?? '').trim();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function jsonSafe(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}
