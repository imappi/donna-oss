import { createHash } from 'node:crypto';

import { classifyModelProvenance, MODEL_PROVENANCE_CLASSIFICATIONS } from './traceReceipts.js';
import { canonicalJson } from './unitExecutionReceipt.js';

export const MODEL_QUALIFICATION_VERSION = 'eaw.model-qualification.v1';
export const MODEL_DEMOTION_VERSION = 'eaw.model-demotion.v1';

const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_FIELDS = Object.freeze([
  'provider', 'base_model_id', 'base_model_digest', 'adapter_id', 'adapter_digest',
  'quantization', 'runtime', 'runtime_version', 'vision_projector_digest',
  'tool_protocol_version', 'prompt_snapshot_id', 'retrieval_snapshot_id',
  'routing_snapshot_id', 'hardware_profile', 'execution_mode', 'model_id_source',
  'network_egress', 'fallback_occurred',
]);
const RECEIPT_FIELDS = new Set([
  'version', 'qualificationId', 'authorityBasis', 'modelSource', 'modelArtifact',
  'solverDigest', 'configOverride', 'receiptDigest',
]);
const CONFIG_FIELDS = new Set(['active', 'source', 'valueDigest']);

export function createQualifiedArtifactReceipt({
  qualificationId, authorityBasis, modelSource, modelArtifact, solverDigest,
  configOverride,
} = {}) {
  const receipt = {
    version: MODEL_QUALIFICATION_VERSION,
    qualificationId,
    authorityBasis,
    modelSource,
    modelArtifact: cloneJson(modelArtifact),
    solverDigest,
    configOverride: cloneJson(configOverride),
  };
  receipt.receiptDigest = computeQualifiedArtifactDigest(receipt);
  const validation = validateQualifiedArtifactReceipt(receipt);
  if (!validation.ok) throw new TypeError(validation.errors.join('; '));
  return deepFreeze(receipt);
}

export function computeQualifiedArtifactDigest(receipt) {
  if (!isPlainObject(receipt)) throw new TypeError('qualified receipt must be an object');
  const { receiptDigest: _digest, ...body } = receipt;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function validateQualifiedArtifactReceipt(receipt) {
  const errors = [];
  if (!isPlainObject(receipt)) return result(errors.concat('qualified receipt must be an object'));
  for (const field of Object.keys(receipt)) if (!RECEIPT_FIELDS.has(field)) errors.push(`qualified.${field} is unsupported`);
  if (receipt.version !== MODEL_QUALIFICATION_VERSION) errors.push(`qualified.version must be ${MODEL_QUALIFICATION_VERSION}`);
  requiredString(receipt.qualificationId, 'qualified.qualificationId', errors);
  requiredString(receipt.authorityBasis, 'qualified.authorityBasis', errors);
  validateRunIdentity({
    model_source: receipt.modelSource,
    model_artifact: receipt.modelArtifact,
    solverDigest: receipt.solverDigest,
    configOverride: receipt.configOverride,
  }, 'qualified', errors);
  if (receipt.modelSource !== 'provider_response') errors.push('qualified.modelSource must be provider_response');
  if (!SHA256.test(receipt.receiptDigest ?? '')) errors.push('qualified.receiptDigest must be a lowercase SHA-256 digest');
  else {
    try {
      if (computeQualifiedArtifactDigest(receipt) !== receipt.receiptDigest) errors.push('qualified.receiptDigest does not match canonical qualified content');
    } catch {
      errors.push('qualified receipt must contain only canonical JSON values');
    }
  }
  return result(errors);
}

export function evaluateModelQualification({ qualifiedReceipt, runReceipt } = {}) {
  const qualifiedValidation = validateQualifiedArtifactReceipt(qualifiedReceipt);
  const runErrors = [];
  validateRunIdentity(runReceipt, 'run', runErrors);

  const mismatchPaths = [];
  if (qualifiedValidation.ok && isPlainObject(runReceipt)) {
    compare('model_source', qualifiedReceipt.modelSource, runReceipt.model_source, mismatchPaths);
    if (isPlainObject(runReceipt.model_artifact)) for (const field of ARTIFACT_FIELDS) compare(`model_artifact.${field}`, qualifiedReceipt.modelArtifact[field], runReceipt.model_artifact[field], mismatchPaths);
    compare('solverDigest', qualifiedReceipt.solverDigest, runReceipt.solverDigest, mismatchPaths);
    if (isPlainObject(runReceipt.configOverride)) for (const field of CONFIG_FIELDS) compare(`configOverride.${field}`, qualifiedReceipt.configOverride[field], runReceipt.configOverride[field], mismatchPaths);
  }

  const fallback = runReceipt?.model_source === 'configured_fallback'
    || runReceipt?.model_artifact?.model_id_source === 'configured_fallback'
    || runReceipt?.model_artifact?.fallback_occurred === true;
  const reasons = [
    ...qualifiedValidation.errors.map((error) => `qualified_invalid:${error}`),
    ...runErrors.map((error) => `run_invalid:${error}`),
    ...(fallback ? ['configured_fallback_refused'] : []),
    ...mismatchPaths.map((path) => `artifact_mismatch:${path}`),
  ].sort();
  if (reasons.length === 0) {
    return deepFreeze({
      ok: true,
      admitted: true,
      version: MODEL_QUALIFICATION_VERSION,
      qualificationId: qualifiedReceipt.qualificationId,
      qualifiedReceiptDigest: qualifiedReceipt.receiptDigest,
      demotionReceipt: null,
    });
  }

  const body = {
    version: MODEL_DEMOTION_VERSION,
    qualificationId: isNonEmpty(qualifiedReceipt?.qualificationId) ? qualifiedReceipt.qualificationId : 'unproven',
    qualifiedReceiptDigest: SHA256.test(qualifiedReceipt?.receiptDigest ?? '') ? qualifiedReceipt.receiptDigest : null,
    disposition: 'refused',
    reasons: [...new Set(reasons)],
  };
  const demotionReceipt = { ...body, receiptDigest: createHash('sha256').update(canonicalJson(body)).digest('hex') };
  return deepFreeze({ ok: true, admitted: false, version: MODEL_QUALIFICATION_VERSION, qualificationId: body.qualificationId, qualifiedReceiptDigest: body.qualifiedReceiptDigest, demotionReceipt });
}

function validateRunIdentity(receipt, prefix, errors) {
  if (!isPlainObject(receipt)) return errors.push(`${prefix} receipt must be an object`);
  if (!['provider_response', 'configured_fallback'].includes(receipt.model_source)) errors.push(`${prefix}.model_source must be provider_response or configured_fallback`);
  const artifact = receipt.model_artifact;
  if (!isPlainObject(artifact)) errors.push(`${prefix}.model_artifact must be an object`);
  else {
    for (const field of ARTIFACT_FIELDS) if (!Object.hasOwn(artifact, field)) errors.push(`${prefix}.model_artifact.${field} is required`);
    for (const field of Object.keys(artifact)) if (!ARTIFACT_FIELDS.includes(field)) errors.push(`${prefix}.model_artifact.${field} is unsupported`);
    const provenance = classifyModelProvenance({ receiptVersion: 'proof0.traceReceipts.v2', modelId: artifact.base_model_id, model_source: receipt.model_source, model_artifact: artifact });
    for (const error of provenance.errors) errors.push(`${prefix}.${error}`);
    if (receipt.model_source === 'provider_response' && provenance.provenance.classification !== MODEL_PROVENANCE_CLASSIFICATIONS.RESPONSE_PROVEN) errors.push(`${prefix}.model provenance is not response-proven`);
  }
  if (!SHA256.test(receipt.solverDigest ?? '')) errors.push(`${prefix}.solverDigest must be a lowercase SHA-256 digest`);
  validateConfigOverride(receipt.configOverride, prefix, errors);
}

function validateConfigOverride(config, prefix, errors) {
  if (!isPlainObject(config)) return errors.push(`${prefix}.configOverride must be an object`);
  for (const field of CONFIG_FIELDS) if (!Object.hasOwn(config, field)) errors.push(`${prefix}.configOverride.${field} is required`);
  for (const field of Object.keys(config)) if (!CONFIG_FIELDS.has(field)) errors.push(`${prefix}.configOverride.${field} is unsupported`);
  if (typeof config.active !== 'boolean') errors.push(`${prefix}.configOverride.active must be a boolean`);
  requiredString(config.source, `${prefix}.configOverride.source`, errors);
  if (config.active === false && (config.source !== 'none' || config.valueDigest !== null)) errors.push(`${prefix}.configOverride inactive state must use source none and valueDigest null`);
  if (config.active === true && !SHA256.test(config.valueDigest ?? '')) errors.push(`${prefix}.configOverride active valueDigest must be a lowercase SHA-256 digest`);
}

function compare(path, expected, actual, mismatches) {
  try {
    if (canonicalJson(expected) !== canonicalJson(actual)) mismatches.push(path);
  } catch {
    mismatches.push(path);
  }
}
function requiredString(value, field, errors) { if (!isNonEmpty(value)) errors.push(`${field} must be a non-empty string`); }
function isNonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function cloneJson(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
function result(errors) { return { ok: errors.length === 0, version: MODEL_QUALIFICATION_VERSION, errors }; }
