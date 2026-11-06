import { createHash } from 'node:crypto';

export const LIFECYCLE_RECEIPT_VERSION = 'eaw.lifecycle.v1';
export const LIFECYCLE_COMPONENTS = Object.freeze([
  'world_schema',
  'renderer',
  'policy_pack',
  'oracle',
  'corpus',
]);
export const LIFECYCLE_ACTIONS = Object.freeze(['recompile', 'rederive', 'reaudit', 'retire']);

const COMPONENTS = new Set(LIFECYCLE_COMPONENTS);
const ACTIONS = new Set(LIFECYCLE_ACTIONS);
const OUTCOMES = new Set(['preserved', 'recompiled', 'rederived', 'reaudited', 'retired']);
const REAUDIT_DISPOSITIONS = new Set(['not_required', 'pending', 'approved', 'rejected']);
const SHA256 = /^[0-9a-f]{64}$/;

export function computeLifecycleReceiptDigest(receipt) {
  if (!isPlainObject(receipt)) throw new TypeError('receipt must be an object');
  const { digest: _digest, ...body } = receipt;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function createLifecycleReceipt(input) {
  const receipt = cloneJson({ version: LIFECYCLE_RECEIPT_VERSION, ...input });
  receipt.digest = computeLifecycleReceiptDigest(receipt);
  const validation = validateLifecycleReceipt(receipt);
  if (!validation.ok) throw new TypeError(validation.errors.join('; '));
  return deepFreeze(receipt);
}

export function validateLifecycleReceipt(receipt) {
  const errors = [];
  if (!isPlainObject(receipt)) return result(['receipt must be an object']);
  if (receipt.version !== LIFECYCLE_RECEIPT_VERSION) errors.push(`version must be ${LIFECYCLE_RECEIPT_VERSION}`);
  requiredString(receipt.receiptId, 'receiptId', errors);
  if (!COMPONENTS.has(receipt.component)) errors.push(`component must be one of ${LIFECYCLE_COMPONENTS.join(', ')}`);
  if (!ACTIONS.has(receipt.action)) errors.push(`action must be one of ${LIFECYCLE_ACTIONS.join(', ')}`);
  requiredString(receipt.fromVersion, 'fromVersion', errors);
  if (receipt.action === 'retire') {
    if (receipt.toVersion !== null) errors.push('retire requires toVersion null');
  } else {
    requiredString(receipt.toVersion, 'toVersion', errors);
    if (receipt.toVersion === receipt.fromVersion) errors.push('fromVersion and toVersion must be independently explicit and different');
  }

  validateCases(receipt, errors);
  validateReview(receipt, errors);
  validatePolicyLifecycle(receipt, errors);

  if (!SHA256.test(receipt.digest ?? '')) errors.push('digest must be a lowercase SHA-256 digest');
  else {
    try {
      if (computeLifecycleReceiptDigest(receipt) !== receipt.digest) errors.push('digest does not match canonical receipt content');
    } catch {
      errors.push('receipt must contain only canonical JSON values');
    }
  }
  return result(errors);
}

function validateCases(receipt, errors) {
  if (!uniqueStrings(receipt.affectedCaseIds)) {
    errors.push('affectedCaseIds must be a non-empty unique string array');
    return;
  }
  if (!Array.isArray(receipt.caseDispositions)) {
    errors.push('caseDispositions must be an array');
    return;
  }
  const dispositions = new Map();
  for (const disposition of receipt.caseDispositions) {
    if (!isPlainObject(disposition) || typeof disposition.caseId !== 'string' || !OUTCOMES.has(disposition.outcome)) {
      errors.push('each case disposition requires a caseId and supported outcome');
      continue;
    }
    if (dispositions.has(disposition.caseId)) errors.push(`duplicate case disposition: ${disposition.caseId}`);
    dispositions.set(disposition.caseId, disposition.outcome);
  }
  const affected = new Set(receipt.affectedCaseIds);
  for (const caseId of affected) if (!dispositions.has(caseId)) errors.push(`affected case has no disposition: ${caseId}`);
  for (const caseId of dispositions.keys()) if (!affected.has(caseId)) errors.push(`case disposition is not affected: ${caseId}`);

  const tombstones = Array.isArray(receipt.tombstones) ? receipt.tombstones : [];
  if (!Array.isArray(receipt.tombstones)) errors.push('tombstones must be an array');
  const tombstoned = new Set();
  for (const tombstone of tombstones) {
    if (!isPlainObject(tombstone) || typeof tombstone.caseId !== 'string') {
      errors.push('each tombstone requires a caseId');
      continue;
    }
    requiredString(tombstone.reason, `tombstone.${tombstone.caseId}.reason`, errors);
    requiredString(tombstone.coverageGap, `tombstone.${tombstone.caseId}.coverageGap`, errors);
    requiredString(tombstone.retiredVersion, `tombstone.${tombstone.caseId}.retiredVersion`, errors);
    if (tombstone.retiredVersion !== receipt.fromVersion) errors.push(`tombstone ${tombstone.caseId} must preserve fromVersion`);
    if (tombstoned.has(tombstone.caseId)) errors.push(`duplicate tombstone: ${tombstone.caseId}`);
    tombstoned.add(tombstone.caseId);
  }
  for (const [caseId, outcome] of dispositions) {
    if ((receipt.action === 'retire' || outcome === 'retired') && !tombstoned.has(caseId)) errors.push(`retired case requires tombstone and coverage gap: ${caseId}`);
    if (receipt.action === 'retire' && outcome !== 'retired') errors.push(`retire requires retired disposition: ${caseId}`);
  }
  for (const caseId of tombstoned) if (dispositions.get(caseId) !== 'retired') errors.push(`tombstone requires retired case disposition: ${caseId}`);
}

function validateReview(receipt, errors) {
  if (!Array.isArray(receipt.loadBearingDiffs)) {
    errors.push('loadBearingDiffs must be an array');
    return;
  }
  for (const diff of receipt.loadBearingDiffs) {
    if (!isPlainObject(diff)) {
      errors.push('loadBearingDiffs entries must be objects');
      continue;
    }
    requiredString(diff.path, 'loadBearingDiff.path', errors);
    requiredString(diff.before, 'loadBearingDiff.before', errors);
    requiredString(diff.after, 'loadBearingDiff.after', errors);
  }
  if (receipt.loadBearingDiffs.length > 0 || receipt.action === 'reaudit') {
    if (!isPlainObject(receipt.externalReview)) return errors.push('load-bearing diffs and reaudit require externalReview');
    requiredString(receipt.externalReview.reviewerId, 'externalReview.reviewerId', errors);
    requiredString(receipt.externalReview.reviewedAt, 'externalReview.reviewedAt', errors);
    requiredString(receipt.externalReview.basis, 'externalReview.basis', errors);
    if (!['approved', 'rejected'].includes(receipt.externalReview.disposition)) errors.push('externalReview.disposition must be approved or rejected');
  }
}

function validatePolicyLifecycle(receipt, errors) {
  if (receipt.component !== 'policy_pack') return;
  requiredString(receipt.effectiveDate, 'effectiveDate', errors);
  if (!REAUDIT_DISPOSITIONS.has(receipt.reauditDisposition)) {
    errors.push(`reauditDisposition must be one of ${[...REAUDIT_DISPOSITIONS].join(', ')}`);
  }
  if (receipt.action === 'reaudit' && !['approved', 'rejected'].includes(receipt.reauditDisposition)) {
    errors.push('policy reaudit requires an approved or rejected reauditDisposition');
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new TypeError('unsupported canonical JSON value');
}

function uniqueStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '') && new Set(value).size === value.length;
}
function requiredString(value, field, errors) { if (typeof value !== 'string' || value.trim() === '') errors.push(`${field} must be a non-empty string`); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function result(errors) { return { ok: errors.length === 0, version: LIFECYCLE_RECEIPT_VERSION, errors }; }
