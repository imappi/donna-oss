export const LEARNING_ARTIFACT_SCHEMA_VERSION = 'eaw.learning.v1';

const TOP_LEVEL_FIELDS = new Set([
  'version', 'caseFamilyId', 'partitionKey', 'task', 'visibleState',
  'admissibleTargets', 'hardConstraints', 'oracle', 'provenance'
]);
const VISIBLE_STATE_FIELDS = new Set([
  'observations', 'artifactRefs', 'retrievedMemory', 'availableTools', 'authority'
]);
const PROVENANCE_FIELDS = new Set([
  'caseOrigin', 'labelOrigin', 'solverModel', 'solverModelRole',
  'vendorOutputCopiedIntoTarget', 'containsRealCustomerData',
  'trainingEligibility', 'evaluationEligibility'
]);
const ELIGIBILITY = new Set(['eligible', 'ineligible']);
const LABEL_ORIGINS = new Set(['oracle', 'adjudicated_human', 'frontier_output', 'student_rollout']);
const MODEL_ROLES = new Set(['none', 'frontier', 'student', 'open_weight_teacher']);
const HIDDEN_KEY = /^(?:hidden(?:Facts?|Truth|State|World)|privileged(?:Facts?|Truth|State)|expectedClose|oracleProjection)$/i;

/**
 * Validate the eaw.learning.v1 record shape without compiling, persisting, or
 * canonicalising a learning artifact. The caller remains responsible for
 * resolving references against its sealed world store.
 */
export function validateLearningArtifactSchema(value) {
  const errors = [];
  if (!isPlainObject(value)) return result(['learning artifact shape must be an object']);

  rejectUnsupported(value, TOP_LEVEL_FIELDS, 'artifact', errors);
  requiredString(value.version, 'version', errors);
  if (value.version !== LEARNING_ARTIFACT_SCHEMA_VERSION) errors.push(`version must be ${LEARNING_ARTIFACT_SCHEMA_VERSION}`);
  requiredString(value.caseFamilyId, 'caseFamilyId', errors);
  requiredString(value.partitionKey, 'partitionKey', errors);
  validateTask(value.task, errors);
  validateVisibleState(value.visibleState, errors);
  validateTargets(value.admissibleTargets, errors);
  validateConstraints(value.hardConstraints, errors);
  validateOracle(value.oracle, errors);
  validateProvenance(value.provenance, errors);

  return result(errors);
}

function validateTask(task, errors) {
  if (!isPlainObject(task)) return errors.push('task must be an object');
  rejectUnsupported(task, new Set(['taskId', 'capabilityId', 'obligationIds']), 'task', errors);
  requiredString(task.taskId, 'task.taskId', errors);
  requiredString(task.capabilityId, 'task.capabilityId', errors);
  stringArray(task.obligationIds, 'task.obligationIds', errors, { nonEmpty: true });
}

function validateVisibleState(state, errors) {
  if (!isPlainObject(state)) return errors.push('visibleState must be an object');
  rejectUnsupported(state, VISIBLE_STATE_FIELDS, 'visibleState', errors);
  jsonArray(state.observations, 'visibleState.observations', errors);
  stringArray(state.artifactRefs, 'visibleState.artifactRefs', errors);
  jsonArray(state.retrievedMemory, 'visibleState.retrievedMemory', errors);
  stringArray(state.availableTools, 'visibleState.availableTools', errors);
  if (!isPlainObject(state.authority)) errors.push('visibleState.authority must be an object');
  const leak = findHiddenKey(state);
  if (leak) errors.push(`visibleState must not contain hidden or privileged truth (${leak})`);
}

function validateTargets(targets, errors) {
  if (!Array.isArray(targets) || targets.length === 0) return errors.push('admissibleTargets must be a non-empty action set');
  const seen = new Set();
  targets.forEach((target, index) => {
    const path = `admissibleTargets[${index}]`;
    if (!isPlainObject(target)) return errors.push(`${path} must be an object`);
    rejectUnsupported(target, new Set(['actionType', 'arguments']), path, errors);
    requiredString(target.actionType, `${path}.actionType`, errors);
    if (!isPlainObject(target.arguments)) errors.push(`${path}.arguments must be an object`);
    const identity = stableJson(target);
    if (seen.has(identity)) errors.push(`${path} duplicates another admissible action`);
    seen.add(identity);
  });
}

function validateConstraints(constraints, errors) {
  if (!Array.isArray(constraints) || constraints.length === 0) return errors.push('hardConstraints must be a non-empty array');
  constraints.forEach((constraint, index) => {
    const path = `hardConstraints[${index}]`;
    if (!isPlainObject(constraint)) return errors.push(`${path} must be an object`);
    rejectUnsupported(constraint, new Set(['constraintId', 'kind', 'receiptIds']), path, errors);
    requiredString(constraint.constraintId, `${path}.constraintId`, errors);
    requiredString(constraint.kind, `${path}.kind`, errors);
    stringArray(constraint.receiptIds, `${path}.receiptIds`, errors, { nonEmpty: true });
  });
}

function validateOracle(oracle, errors) {
  if (!isPlainObject(oracle)) return errors.push('oracle must be an object');
  rejectUnsupported(oracle, new Set(['oracleVersion', 'policyPackVersion', 'receiptIds', 'counterfactualGroupId']), 'oracle', errors);
  requiredString(oracle.oracleVersion, 'oracle.oracleVersion', errors);
  requiredString(oracle.policyPackVersion, 'oracle.policyPackVersion', errors);
  stringArray(oracle.receiptIds, 'oracle.receiptIds', errors, { nonEmpty: true });
  if (oracle.counterfactualGroupId !== null) requiredString(oracle.counterfactualGroupId, 'oracle.counterfactualGroupId', errors);
}

function validateProvenance(provenance, errors) {
  if (!isPlainObject(provenance)) return errors.push('provenance must be an object');
  rejectUnsupported(provenance, PROVENANCE_FIELDS, 'provenance', errors);
  requiredString(provenance.caseOrigin, 'provenance.caseOrigin', errors);
  if (!LABEL_ORIGINS.has(provenance.labelOrigin)) errors.push('provenance.labelOrigin is invalid');
  if (provenance.solverModel !== null) requiredString(provenance.solverModel, 'provenance.solverModel', errors);
  if (!MODEL_ROLES.has(provenance.solverModelRole)) errors.push('provenance.solverModelRole is invalid');
  for (const field of ['vendorOutputCopiedIntoTarget', 'containsRealCustomerData']) {
    if (typeof provenance[field] !== 'boolean') errors.push(`provenance.${field} must be a boolean`);
  }
  for (const field of ['trainingEligibility', 'evaluationEligibility']) {
    if (!ELIGIBILITY.has(provenance[field])) errors.push(`provenance.${field} must be eligible or ineligible`);
  }
  if ((provenance.labelOrigin === 'frontier_output' || provenance.solverModelRole === 'frontier' || provenance.vendorOutputCopiedIntoTarget === true)
    && provenance.trainingEligibility !== 'ineligible') {
    errors.push('frontier/vendor output is training-ineligible by default');
  }
  if (provenance.containsRealCustomerData === true) {
    if (provenance.trainingEligibility !== 'ineligible') errors.push('real customer data is training-ineligible');
    if (provenance.evaluationEligibility !== 'ineligible') errors.push('real customer data is evaluation-ineligible in this schema');
  }
}

function rejectUnsupported(value, allowed, path, errors) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is unsupported`);
}
function requiredString(value, path, errors) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${path} must be a non-empty string`);
}
function stringArray(value, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) return errors.push(`${path} must be ${nonEmpty ? 'a non-empty' : 'an'} array of unique non-empty strings`);
  const seen = new Set();
  value.forEach((item) => {
    if (typeof item !== 'string' || item.trim() === '') errors.push(`${path} entries must be non-empty strings`);
    else if (seen.has(item)) errors.push(`${path} entries must be unique`);
    seen.add(item);
  });
}
function jsonArray(value, path, errors) {
  if (!Array.isArray(value)) errors.push(`${path} must be an array`);
  else if (!isJsonValue(value)) errors.push(`${path} must contain only JSON values`);
}
function findHiddenKey(value, path = 'visibleState') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findHiddenKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (HIDDEN_KEY.test(key)) return `${path}.${key}`;
      const found = findHiddenKey(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isJsonValue(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function result(errors) { return { ok: errors.length === 0, version: LEARNING_ARTIFACT_SCHEMA_VERSION, errors }; }
