import { createHash } from 'node:crypto';

import { canonicalJson } from './unitExecutionReceipt.js';

export const FRESH_ENTITY_DIAGNOSTIC_VERSION = 'eaw.fresh-entity-diagnostic.v1';
export const FICTIONAL_REPRODUCER_VERSION = 'eaw.fictional-reproducer.v1';

export const FRESH_ENTITY_DIAGNOSTIC_STAGES = Object.freeze([
  'create_path',
  'build_and_migration',
  'canonical_identity',
  'config_chart_authority',
  'first_upload',
  'worker_stage',
]);

const OBSERVED_STATUSES = new Set(['passed', 'failed', 'incomplete', 'not_reached']);
const SHA256 = /^[0-9a-f]{64}$/;
const REPRODUCER_PATH = /^data\/worlds\/reproducers\/[a-z0-9][a-z0-9._/-]*\.json$/;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildFreshEntityDiagnosticReceipt({
  incidentId,
  observedAt,
  firmId,
  clientId,
  creationPath,
  stages,
  retainedArtifact = null,
  fictionalReproducer = null,
  diagnosticWallTimeMs = 0,
} = {}) {
  for (const [name, value] of Object.entries({ incidentId, observedAt, firmId, clientId, creationPath })) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  }
  if (Number.isNaN(Date.parse(observedAt))) throw new TypeError('observedAt must be an ISO timestamp');
  if (!Number.isSafeInteger(diagnosticWallTimeMs) || diagnosticWallTimeMs < 0) throw new TypeError('diagnosticWallTimeMs must be a non-negative safe integer');

  const normalizedStages = validateAndCopyStages(stages);
  const firstDivergence = normalizedStages.find(({ status }) => status === 'failed' || status === 'incomplete') ?? null;
  const artifact = validateArtifactMetadata(retainedArtifact);
  const reproducer = validateReproducerMetadata(fictionalReproducer, incidentId, firstDivergence?.stage ?? null);
  const status = firstDivergence?.status === 'failed'
    ? 'failed'
    : firstDivergence?.status === 'incomplete'
      ? 'incomplete'
      : 'passed';

  const body = {
    version: FRESH_ENTITY_DIAGNOSTIC_VERSION,
    incident_id: incidentId,
    observed_at: observedAt,
    entity: { firm_id: firmId, client_id: clientId, creation_path: creationPath },
    status,
    stages: normalizedStages,
    first_divergence: firstDivergence
      ? {
          stage: firstDivergence.stage,
          status: firstDivergence.status,
          reason_code: firstDivergence.reason_code,
          receipt_ids: [...firstDivergence.receipt_ids],
        }
      : null,
    replay_artifact: artifact,
    fictional_reproducer: reproducer,
    replay_eligibility: artifact
      ? { status: 'pending_byte_verification' }
      : { status: 'refused', reason: 'retained_authorized_artifact_required' },
    protected_corpus_eligibility: artifact && reproducer
      ? { status: 'pending_byte_verification' }
      : { status: 'refused', reason: artifact ? 'fictional_reproducer_required' : 'retained_authorized_artifact_required' },
    spend: {
      status: 'known_zero_model',
      modelSpendUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      solveCalls: 0,
      wallTimeMs: diagnosticWallTimeMs,
      providerResponses: [],
      modelIds: [],
      pricingSource: { status: 'not_applicable', reason: 'deterministic_zero_model_diagnostic' },
      configurationDigest: sha256Hex(canonicalJson({
        version: FRESH_ENTITY_DIAGNOSTIC_VERSION,
        stages: FRESH_ENTITY_DIAGNOSTIC_STAGES,
        creation_path: creationPath,
      })),
      artifactDigests: [sha256Hex(canonicalJson({
        replay_artifact_sha256: artifact?.sha256 ?? null,
        fictional_reproducer_sha256: reproducer?.sha256 ?? null,
      }))],
      basis: 'deterministic_zero_model_diagnostic',
    },
  };
  return Object.freeze({ ...body, receipt_digest: sha256Hex(canonicalJson(body)) });
}

export function evaluateFreshEntityReplayAdmission({
  receipt,
  retainedArtifactBytes,
  fictionalReproducerBytes = null,
  protectedCorpus = false,
} = {}) {
  const receiptValidation = validateDiagnosticReceipt(receipt);
  if (!receiptValidation.ok) return refusal('diagnostic_receipt_invalid', receiptValidation.errors);
  if (!receipt.replay_artifact) return refusal('retained_authorized_artifact_required');
  if (retainedArtifactBytes == null) return refusal('retained_artifact_bytes_required');
  if (sha256Hex(retainedArtifactBytes) !== receipt.replay_artifact.sha256) return refusal('retained_artifact_digest_mismatch');

  if (!protectedCorpus) {
    return Object.freeze({ admitted: true, scope: 'diagnostic_replay', artifact_id: receipt.replay_artifact.artifact_id });
  }
  if (!receipt.fictional_reproducer) return refusal('fictional_reproducer_required');
  if (fictionalReproducerBytes == null) return refusal('fictional_reproducer_bytes_required');
  if (sha256Hex(fictionalReproducerBytes) !== receipt.fictional_reproducer.sha256) return refusal('fictional_reproducer_digest_mismatch');

  let reproducer;
  try {
    reproducer = JSON.parse(Buffer.from(fictionalReproducerBytes).toString('utf8'));
  } catch {
    return refusal('fictional_reproducer_invalid_json');
  }
  const errors = validateFictionalReproducer(reproducer, receipt);
  if (errors.length) return refusal('fictional_reproducer_invalid', errors);
  return Object.freeze({
    admitted: true,
    scope: 'protected_corpus',
    artifact_id: receipt.replay_artifact.artifact_id,
    world_id: reproducer.world_id,
    reproducer_path: receipt.fictional_reproducer.path,
  });
}

export function validateDiagnosticReceipt(receipt) {
  const errors = [];
  if (!isObject(receipt)) return { ok: false, errors: ['receipt must be an object'] };
  if (receipt.version !== FRESH_ENTITY_DIAGNOSTIC_VERSION) errors.push(`version must be ${FRESH_ENTITY_DIAGNOSTIC_VERSION}`);
  for (const [name, value] of Object.entries({
    incident_id: receipt.incident_id,
    observed_at: receipt.observed_at,
    firm_id: receipt.entity?.firm_id,
    client_id: receipt.entity?.client_id,
    creation_path: receipt.entity?.creation_path,
  })) {
    if (typeof value !== 'string' || value.trim() === '') errors.push(`${name} must be a non-empty string`);
  }
  if (typeof receipt.observed_at === 'string' && Number.isNaN(Date.parse(receipt.observed_at))) errors.push('observed_at must be an ISO timestamp');
  if (!SHA256.test(receipt.receipt_digest ?? '')) errors.push('receipt_digest must be a lowercase SHA-256 digest');
  else {
    const { receipt_digest: _ignored, ...body } = receipt;
    if (sha256Hex(canonicalJson(body)) !== receipt.receipt_digest) errors.push('receipt_digest does not match receipt contents');
  }
  let normalizedStages = null;
  try { normalizedStages = validateAndCopyStages(receipt.stages); } catch (error) { errors.push(error.message); }
  try { validateArtifactMetadata(receipt.replay_artifact); } catch (error) { errors.push(error.message); }
  try {
    validateReproducerMetadata(receipt.fictional_reproducer, receipt.incident_id, receipt.first_divergence?.stage ?? null);
  } catch (error) { errors.push(error.message); }
  if (normalizedStages) {
    const divergence = normalizedStages.find(({ status }) => status === 'failed' || status === 'incomplete') ?? null;
    const expectedStatus = divergence?.status ?? 'passed';
    if (receipt.status !== expectedStatus) errors.push('status does not match the first observed divergence');
    const expectedDivergence = divergence
      ? { stage: divergence.stage, status: divergence.status, reason_code: divergence.reason_code, receipt_ids: [...divergence.receipt_ids] }
      : null;
    if (!canonicalEqual(receipt.first_divergence, expectedDivergence)) errors.push('first_divergence does not match the ordered stage observations');
  }
  const expectedReplay = receipt.replay_artifact
    ? { status: 'pending_byte_verification' }
    : { status: 'refused', reason: 'retained_authorized_artifact_required' };
  if (!canonicalEqual(receipt.replay_eligibility, expectedReplay)) errors.push('replay_eligibility does not match retained artifact authority');
  const expectedProtected = receipt.replay_artifact && receipt.fictional_reproducer
    ? { status: 'pending_byte_verification' }
    : { status: 'refused', reason: receipt.replay_artifact ? 'fictional_reproducer_required' : 'retained_authorized_artifact_required' };
  if (!canonicalEqual(receipt.protected_corpus_eligibility, expectedProtected)) errors.push('protected_corpus_eligibility does not match replay evidence');
  if (!isObject(receipt.spend)
    || receipt.spend.status !== 'known_zero_model'
    || receipt.spend.modelSpendUsd !== 0
    || receipt.spend.inputTokens !== 0
    || receipt.spend.outputTokens !== 0
    || receipt.spend.solveCalls !== 0
    || !Number.isSafeInteger(receipt.spend.wallTimeMs)
    || receipt.spend.wallTimeMs < 0
    || !Array.isArray(receipt.spend.providerResponses)
    || receipt.spend.providerResponses.length !== 0
    || !Array.isArray(receipt.spend.modelIds)
    || receipt.spend.modelIds.length !== 0
    || receipt.spend.pricingSource?.status !== 'not_applicable'
    || !SHA256.test(receipt.spend.configurationDigest ?? '')
    || !Array.isArray(receipt.spend.artifactDigests)
    || receipt.spend.artifactDigests.length !== 1
    || !receipt.spend.artifactDigests.every((digest) => SHA256.test(digest))
    || receipt.spend.basis !== 'deterministic_zero_model_diagnostic') {
    errors.push('spend must explicitly receipt the deterministic zero-model diagnostic');
  }
  return { ok: errors.length === 0, errors };
}

function validateAndCopyStages(stages) {
  if (!Array.isArray(stages) || stages.length !== FRESH_ENTITY_DIAGNOSTIC_STAGES.length) {
    throw new TypeError('stages must contain every fresh-entity diagnostic stage exactly once');
  }
  let divergenceSeen = false;
  return stages.map((entry, index) => {
    if (!isObject(entry) || entry.stage !== FRESH_ENTITY_DIAGNOSTIC_STAGES[index]) {
      throw new TypeError(`stages[${index}].stage must be ${FRESH_ENTITY_DIAGNOSTIC_STAGES[index]}`);
    }
    if (!OBSERVED_STATUSES.has(entry.status)) throw new TypeError(`stages[${index}].status is invalid`);
    if (!Array.isArray(entry.receipt_ids) || entry.receipt_ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw new TypeError(`stages[${index}].receipt_ids must be an array of non-empty strings`);
    }
    if (entry.status !== 'not_reached' && entry.receipt_ids.length === 0) {
      throw new TypeError(`stages[${index}] observed status requires at least one receipt id`);
    }
    if (entry.status === 'passed' && divergenceSeen) {
      throw new TypeError(`stages[${index}] cannot pass after the first divergence`);
    }
    if (entry.status === 'not_reached' && !divergenceSeen) {
      throw new TypeError(`stages[${index}] cannot be not_reached before a divergence`);
    }
    if (divergenceSeen && entry.status !== 'not_reached') {
      throw new TypeError(`stages[${index}] must be not_reached after the first divergence`);
    }
    if (entry.status === 'failed' || entry.status === 'incomplete') divergenceSeen = true;
    const reasonCode = typeof entry.reason_code === 'string' && entry.reason_code.trim() ? entry.reason_code.trim() : null;
    if (entry.status !== 'passed' && !reasonCode) throw new TypeError(`stages[${index}].reason_code is required`);
    return Object.freeze({
      stage: entry.stage,
      status: entry.status,
      reason_code: reasonCode,
      receipt_ids: Object.freeze([...entry.receipt_ids]),
    });
  });
}

function validateArtifactMetadata(value) {
  if (value == null) return null;
  if (!isObject(value)) throw new TypeError('retainedArtifact must be an object');
  if (typeof value.artifact_id !== 'string' || value.artifact_id.trim() === '') throw new TypeError('retainedArtifact.artifact_id is required');
  if (!SHA256.test(value.sha256 ?? '')) throw new TypeError('retainedArtifact.sha256 must be a lowercase SHA-256 digest');
  if (value.retention_status !== 'retained') throw new TypeError('retainedArtifact.retention_status must be retained');
  if (!isObject(value.authorization)
    || value.authorization.status !== 'authorized'
    || value.authorization.purpose !== 'diagnostic_replay'
    || typeof value.authorization.authority_id !== 'string'
    || value.authorization.authority_id.trim() === '') {
    throw new TypeError('retainedArtifact requires explicit diagnostic_replay authorization');
  }
  return Object.freeze({
    artifact_id: value.artifact_id,
    sha256: value.sha256,
    retention_status: value.retention_status,
    source_class: value.source_class ?? 'unknown',
    authorization: Object.freeze({ ...value.authorization }),
  });
}

function validateReproducerMetadata(value, incidentId, divergenceStage) {
  if (value == null) return null;
  if (!isObject(value) || value.fictional !== true) throw new TypeError('fictionalReproducer must be explicitly fictional');
  if (typeof value.world_id !== 'string' || value.world_id.trim() === '') throw new TypeError('fictionalReproducer.world_id is required');
  if (!REPRODUCER_PATH.test(value.path ?? '')) throw new TypeError('fictionalReproducer.path must stay under data/worlds/reproducers');
  if (!SHA256.test(value.sha256 ?? '')) throw new TypeError('fictionalReproducer.sha256 must be a lowercase SHA-256 digest');
  if (value.incident_id !== incidentId) throw new TypeError('fictionalReproducer.incident_id must match the diagnostic incident');
  if (value.expected_divergence_stage !== divergenceStage) throw new TypeError('fictionalReproducer.expected_divergence_stage must match the first divergence');
  return Object.freeze({ ...value });
}

function validateFictionalReproducer(reproducer, receipt) {
  const errors = [];
  if (!isObject(reproducer)) return ['reproducer must be an object'];
  if (reproducer.version !== FICTIONAL_REPRODUCER_VERSION) errors.push(`version must be ${FICTIONAL_REPRODUCER_VERSION}`);
  if (reproducer.fictional !== true) errors.push('fictional must be true');
  if (reproducer.incident_id !== receipt.incident_id) errors.push('incident_id must match the diagnostic receipt');
  if (reproducer.world_id !== receipt.fictional_reproducer.world_id) errors.push('world_id must match the diagnostic receipt');
  if (reproducer.expected_divergence_stage !== receipt.first_divergence?.stage) errors.push('expected_divergence_stage must match the first divergence');
  if (!Array.isArray(reproducer.assertions) || reproducer.assertions.length === 0) errors.push('assertions must be a non-empty array');
  return errors;
}

function refusal(reason, errors = []) {
  return Object.freeze({ admitted: false, reason, errors: Object.freeze([...errors]) });
}

function canonicalEqual(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
