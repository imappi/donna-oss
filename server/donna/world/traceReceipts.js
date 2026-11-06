export const TRACE_RECEIPTS_VERSION = 'proof0.traceReceipts.v2';
export const LEGACY_TRACE_RECEIPTS_VERSION = 'proof0.traceReceipts.v1';

export const MODEL_PROVENANCE_CLASSIFICATIONS = Object.freeze({
  LEGACY_UNPROVEN: 'legacy_unproven',
  RESPONSE_PROVEN: 'response_proven',
  CONFIGURED_FALLBACK: 'configured_fallback',
});

const MODEL_ARTIFACT_FIELDS = Object.freeze([
  'provider', 'base_model_id', 'base_model_digest', 'adapter_id',
  'adapter_digest', 'quantization', 'runtime', 'runtime_version',
  'vision_projector_digest', 'tool_protocol_version', 'prompt_snapshot_id',
  'retrieval_snapshot_id', 'routing_snapshot_id', 'hardware_profile',
  'execution_mode', 'model_id_source', 'network_egress', 'fallback_occurred',
]);
const SHA256 = /^[0-9a-f]{64}$/;

export const OBSERVABLE_TRACE_STAGES = Object.freeze([
  'observed_evidence',
  'extracted_structured_state',
  'retrieved_context_and_memory',
  'candidate_state_alternatives',
  'tool_calls_and_arithmetic',
  'policy_references',
  'uncertainty_branch',
  'authority_decision',
  'owner_ask_and_response',
  'posting_reconciliation_or_blocked_obligation',
  'final_close_and_external_state',
]);

const STAGE_INDEX = new Map(OBSERVABLE_TRACE_STAGES.map((stage, index) => [stage, index]));

export function createDecisionReceipt({
  decisionId,
  worldId,
  capabilityId,
  stage,
  obligationIds = [],
  evidenceRefs = [],
  retrievedMemoryRefs = [],
  policyRefs = [],
  admissibleBranches = [],
  selectedAction,
  authorityBasis,
  sourceTrust,
  reversibility,
  externalConsequence,
  nextState,
  modelId,
  model_source,
  model_artifact,
  runtimeSnapshot = {},
  oracleFailureIds = [],
  expectedState,
  observedState,
  confidence,
  sequence,
} = {}) {
  const receiptVersion = model_source === undefined && model_artifact === undefined
    ? LEGACY_TRACE_RECEIPTS_VERSION
    : TRACE_RECEIPTS_VERSION;
  const receipt = {
    receiptVersion,
    decisionId,
    worldId,
    capabilityId,
    stage,
    obligationIds: [...obligationIds],
    evidenceRefs: [...evidenceRefs],
    retrievedMemoryRefs: [...retrievedMemoryRefs],
    policyRefs: [...policyRefs],
    admissibleBranches: [...admissibleBranches],
    selectedAction,
    authorityBasis,
    sourceTrust,
    reversibility,
    externalConsequence,
    nextState,
    modelId,
    runtimeSnapshot: { ...runtimeSnapshot },
    oracleFailureIds: [...oracleFailureIds],
    expectedState,
    observedState,
    confidence,
    sequence,
  };
  // Omission is deliberate: historical Proof-0 receipts retain their original
  // shape and are classified as unproven rather than silently modernised.
  if (model_source !== undefined) receipt.model_source = model_source;
  if (model_artifact !== undefined) receipt.model_artifact = cloneJsonObject(model_artifact);
  return receipt;
}

export function validateDecisionReceipt(receipt) {
  const errors = [];
  if (!isPlainObject(receipt)) return { ok: false, version: TRACE_RECEIPTS_VERSION, errors: ['receipt must be an object'] };
  for (const field of ['receiptVersion', 'decisionId', 'worldId', 'capabilityId', 'stage', 'selectedAction', 'authorityBasis', 'sourceTrust', 'reversibility', 'externalConsequence', 'nextState', 'modelId']) {
    if (typeof receipt[field] !== 'string' || receipt[field].trim() === '') errors.push(`${field} must be a non-empty string`);
  }
  if (![TRACE_RECEIPTS_VERSION, LEGACY_TRACE_RECEIPTS_VERSION].includes(receipt.receiptVersion)) {
    errors.push(`receiptVersion must be ${TRACE_RECEIPTS_VERSION} or ${LEGACY_TRACE_RECEIPTS_VERSION}`);
  }
  if (!STAGE_INDEX.has(receipt.stage)) errors.push(`stage must be one of ${OBSERVABLE_TRACE_STAGES.join(', ')}`);
  for (const field of ['obligationIds', 'evidenceRefs', 'retrievedMemoryRefs', 'policyRefs', 'admissibleBranches', 'oracleFailureIds']) {
    if (!Array.isArray(receipt[field])) errors.push(`${field} must be an array`);
  }
  if (!isPlainObject(receipt.runtimeSnapshot)) errors.push('runtimeSnapshot must be an object');
  const provenance = validateModelProvenance(receipt, errors);
  return { ok: errors.length === 0, version: TRACE_RECEIPTS_VERSION, provenance, errors };
}

export function classifyModelProvenance(receipt) {
  const errors = [];
  const provenance = validateModelProvenance(receipt, errors);
  return { ok: errors.length === 0, version: TRACE_RECEIPTS_VERSION, provenance, errors };
}

export function findEarliestObservableDivergence({ oracleVerdict, traceReceipts }) {
  const failures = Array.isArray(oracleVerdict?.failures) ? oracleVerdict.failures : [];
  if (failures.length === 0) return { ok: true, version: TRACE_RECEIPTS_VERSION, divergence: null, errors: [] };

  const errors = [];
  const candidates = [];
  for (const receipt of Array.isArray(traceReceipts) ? traceReceipts : []) {
    const validation = validateDecisionReceipt(receipt);
    if (!validation.ok) errors.push(...validation.errors.map((error) => `${receipt?.decisionId ?? 'receipt'}.${error}`));
    if (isDivergent(receipt) && matchesOracleFailures(receipt.oracleFailureIds, failures)) candidates.push(receipt);
  }
  if (errors.length > 0) return { ok: false, version: TRACE_RECEIPTS_VERSION, divergence: null, errors };

  const earliest = candidates.sort(compareTraceOrder)[0];
  return {
    ok: true,
    version: TRACE_RECEIPTS_VERSION,
    divergence: earliest ? divergenceFromReceipt(earliest) : fallbackDivergence(failures),
    errors: [],
  };
}

export function buildFailureReceipt({ failureId, worldSpec, failureClass, oracleVerdict, traceReceipts, loadBearingFact = null, consequence = {}, reproductionPredicate = 'oracle_verdict_failures_recur', permittedPatchSurfaces = [], protectedSurfaces = [] }) {
  const divergenceResult = findEarliestObservableDivergence({ oracleVerdict, traceReceipts });
  if (!divergenceResult.ok) return { ok: false, version: TRACE_RECEIPTS_VERSION, errors: divergenceResult.errors, receipt: null };
  return {
    ok: true,
    version: TRACE_RECEIPTS_VERSION,
    errors: [],
    receipt: {
      receiptVersion: TRACE_RECEIPTS_VERSION,
      failureId,
      worldId: worldSpec?.worldId,
      capabilityId: worldSpec?.manifest?.capabilityId,
      failureClass,
      earliestObservableDivergence: divergenceResult.divergence,
      loadBearingFact,
      consequence: { ...consequence },
      protectedGate: 'oracle_suite',
      reproductionPredicate,
      permittedPatchSurfaces: [...permittedPatchSurfaces],
      protectedSurfaces: [...protectedSurfaces],
      oracleReceiptIds: (oracleVerdict?.receipts ?? []).map(({ id }) => id),
      oracleFailures: [...(oracleVerdict?.failures ?? [])],
    },
  };
}

function isDivergent(receipt) {
  return receipt && typeof receipt.expectedState === 'string' && typeof receipt.observedState === 'string' && receipt.expectedState !== receipt.observedState;
}

function matchesOracleFailures(ids = [], failures) {
  return ids.length === 0 || ids.some((id) => failures.some((failure) => failure.includes(id)));
}

function compareTraceOrder(left, right) {
  return (STAGE_INDEX.get(left.stage) - STAGE_INDEX.get(right.stage)) || Number(left.sequence ?? 0) - Number(right.sequence ?? 0) || left.decisionId.localeCompare(right.decisionId);
}

function divergenceFromReceipt(receipt) {
  return { stage: receipt.stage, expectedState: receipt.expectedState, observedState: receipt.observedState, confidence: receipt.confidence ?? 'medium', decisionId: receipt.decisionId };
}

function fallbackDivergence(failures) {
  return { stage: 'final_close_and_external_state', expectedState: 'admissible_close', observedState: failures.join(' | '), confidence: 'uncertain' };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateModelProvenance(receipt, errors) {
  const hasSource = Object.hasOwn(receipt, 'model_source');
  const hasArtifact = Object.hasOwn(receipt, 'model_artifact');
  const legacy = receipt.receiptVersion === LEGACY_TRACE_RECEIPTS_VERSION;
  if (legacy) {
    if (hasSource || hasArtifact) errors.push(`${LEGACY_TRACE_RECEIPTS_VERSION} receipts cannot contain model provenance`);
    return {
      classification: MODEL_PROVENANCE_CLASSIFICATIONS.LEGACY_UNPROVEN,
      reason: 'legacy receipt has a model id but no response or artifact provenance',
    };
  }
  if (!hasSource || !hasArtifact) {
    errors.push('model_source and model_artifact must be supplied together');
    return { classification: MODEL_PROVENANCE_CLASSIFICATIONS.LEGACY_UNPROVEN, reason: 'incomplete provenance record' };
  }
  if (!['provider_response', 'configured_fallback'].includes(receipt.model_source)) {
    errors.push('model_source must be provider_response or configured_fallback');
  }
  const artifact = receipt.model_artifact;
  if (!isPlainObject(artifact)) {
    errors.push('model_artifact must be an object');
    return { classification: MODEL_PROVENANCE_CLASSIFICATIONS.LEGACY_UNPROVEN, reason: 'invalid provenance record' };
  }
  for (const field of MODEL_ARTIFACT_FIELDS) {
    if (!Object.hasOwn(artifact, field)) errors.push(`model_artifact.${field} is required`);
  }
  for (const field of Object.keys(artifact)) {
    if (!MODEL_ARTIFACT_FIELDS.includes(field)) errors.push(`model_artifact.${field} is unsupported`);
  }
  for (const field of MODEL_ARTIFACT_FIELDS.filter((name) => !['network_egress', 'fallback_occurred'].includes(name))) {
    validateApplicableValue(artifact[field], `model_artifact.${field}`, errors);
  }
  if (!['local_only', 'hybrid', 'frontier'].includes(artifact.execution_mode)) {
    errors.push('model_artifact.execution_mode must be local_only, hybrid, or frontier');
  }
  if (!['provider_response', 'configured_fallback'].includes(artifact.model_id_source)) {
    errors.push('model_artifact.model_id_source must be provider_response or configured_fallback');
  }
  if (artifact.model_id_source !== receipt.model_source) errors.push('model_source must equal model_artifact.model_id_source');
  if (typeof artifact.base_model_id === 'string' && artifact.base_model_id !== receipt.modelId) errors.push('model_artifact.base_model_id must equal the receipt modelId');
  if (typeof artifact.network_egress !== 'boolean') errors.push('model_artifact.network_egress must be a boolean');
  if (typeof artifact.fallback_occurred !== 'boolean') errors.push('model_artifact.fallback_occurred must be a boolean');

  for (const field of ['base_model_digest', 'adapter_digest', 'vision_projector_digest']) {
    if (typeof artifact[field] === 'string' && !SHA256.test(artifact[field])) errors.push(`model_artifact.${field} must be a lowercase SHA-256 digest`);
  }
  if (['local_only', 'hybrid'].includes(artifact.execution_mode)) {
    for (const field of ['provider', 'base_model_id', 'base_model_digest', 'quantization', 'runtime', 'runtime_version', 'hardware_profile']) {
      if (typeof artifact[field] !== 'string' || artifact[field].trim() === '') errors.push(`model_artifact.${field} must be known for ${artifact.execution_mode} execution`);
    }
    const adapterKnown = typeof artifact.adapter_id === 'string' && artifact.adapter_id.trim() !== '' && typeof artifact.adapter_digest === 'string' && SHA256.test(artifact.adapter_digest);
    const adapterAbsent = isNotApplicable(artifact.adapter_id) && isNotApplicable(artifact.adapter_digest);
    if (!adapterKnown && !adapterAbsent) {
      errors.push(`model_artifact.adapter_id and model_artifact.adapter_digest must be paired known values or paired not_applicable for ${artifact.execution_mode} execution`);
    }
    if (typeof artifact.vision_projector_digest !== 'string' && !isNotApplicable(artifact.vision_projector_digest)) {
      errors.push(`model_artifact.vision_projector_digest must be a known digest or not_applicable for ${artifact.execution_mode} execution`);
    }
  }
  if (artifact.execution_mode === 'local_only') {
    if (artifact.network_egress !== false) errors.push('local_only execution requires network_egress false');
    if (artifact.fallback_occurred !== false) errors.push('local_only execution cannot have fallback_occurred true');
  }
  if (artifact.execution_mode === 'frontier' && artifact.network_egress !== true) errors.push('frontier execution requires network_egress true');
  if (receipt.model_source === 'provider_response' && artifact.fallback_occurred !== false) errors.push('provider_response provenance cannot claim fallback_occurred true');
  if (receipt.model_source === 'configured_fallback' && artifact.fallback_occurred !== true) errors.push('configured_fallback provenance requires fallback_occurred true');

  return receipt.model_source === 'configured_fallback'
    ? { classification: MODEL_PROVENANCE_CLASSIFICATIONS.CONFIGURED_FALLBACK, reason: 'model id came from configured fallback' }
    : { classification: MODEL_PROVENANCE_CLASSIFICATIONS.RESPONSE_PROVEN, reason: 'model id came from provider response' };
}

function validateApplicableValue(value, path, errors) {
  if (typeof value === 'string' && value.trim() !== '') return;
  if (isPlainObject(value) && value.status === 'not_applicable' && Object.keys(value).length === 1) return;
  if (isPlainObject(value) && value.status === 'unknown' && typeof value.reason === 'string' && value.reason.trim() !== '' && Object.keys(value).every((key) => ['status', 'reason'].includes(key))) return;
  errors.push(`${path} must be a known non-empty string, { status: 'not_applicable' }, or { status: 'unknown', reason }`);
}

function isNotApplicable(value) {
  return isPlainObject(value) && value.status === 'not_applicable' && Object.keys(value).length === 1;
}

function cloneJsonObject(value) {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isPlainObject(item) ? { ...item } : item]));
}
