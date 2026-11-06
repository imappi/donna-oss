import { createHash } from 'node:crypto';

export const UNIT_EXECUTION_RECEIPT_VERSION = 'eaw.unit-execution.v1';

const ALLOWED_KEYS = new Set([
  'version', 'unit', 'attempt', 'changedPaths', 'commands', 'usage', 'blockers',
  'provenance', 'evidenceDigest'
]);
const EAW_PATHS = [
  /^server\/donna\/world\/.+$/,
  /^data\/worlds\/.+$/,
  /^scripts\/eval_world_[^/]+$/,
  /^docs\/codex-execution-log-eaw\.md$/
];
const ASCII_CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40}$/;

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('canonical JSON supports only JSON values');
}

export function computeUnitExecutionDigest(receipt) {
  if (!isPlainObject(receipt)) throw new TypeError('receipt must be an object');
  const { evidenceDigest: _ignored, ...evidence } = receipt;
  return createHash('sha256').update(canonicalJson(evidence)).digest('hex');
}

export function validateUnitExecutionReceipt(receipt, { seenIdentities = [], expectedProvenance } = {}) {
  const errors = [];
  if (!isPlainObject(receipt)) return result(['receipt must be an object']);

  for (const key of Object.keys(receipt)) if (!ALLOWED_KEYS.has(key)) errors.push(`unsupported field: ${key}`);
  if (receipt.version !== UNIT_EXECUTION_RECEIPT_VERSION) errors.push(`version must be ${UNIT_EXECUTION_RECEIPT_VERSION}`);
  if (!Number.isSafeInteger(receipt.unit) || receipt.unit < 1 || receipt.unit > 999999) {
    errors.push('unit must be a safe integer from 1 through 999999');
  }
  if (typeof receipt.attempt !== 'string' || !/^attempt-[A-Z]$/.test(receipt.attempt)) {
    errors.push('attempt must match attempt-[A-Z]');
  }
  const identity = `${receipt.unit}:${receipt.attempt}`;
  const identities = new Set();
  for (const seen of seenIdentities) {
    const seenIdentity = typeof seen === 'string' ? seen : `${seen?.unit}:${seen?.attempt}`;
    if (identities.has(seenIdentity)) errors.push(`duplicate existing identity: ${seenIdentity}`);
    identities.add(seenIdentity);
  }
  if (identities.has(identity)) errors.push(`duplicate unit/attempt identity: ${identity}`);

  validatePaths(receipt.changedPaths, errors);
  validateCommands(receipt.commands, errors);
  validateUsage(receipt.usage, errors);
  if (!Array.isArray(receipt.blockers) || receipt.blockers.some((item) => typeof item !== 'string' || item.trim() === '')) {
    errors.push('blockers must be an array of non-empty strings');
  }
  validateProvenance(receipt.provenance, expectedProvenance, errors);
  if (!SHA256.test(receipt.evidenceDigest ?? '')) errors.push('evidenceDigest must be a lowercase SHA-256 digest');
  else {
    try {
      if (computeUnitExecutionDigest(receipt) !== receipt.evidenceDigest) errors.push('evidenceDigest does not match canonical evidence');
    } catch {
      errors.push('receipt evidence must contain only canonical JSON values');
    }
  }
  return result(errors);
}

export function validateCanonicalUnitExecutionReceipt(text, options) {
  if (typeof text !== 'string') return result(['receipt JSON must be a string']);
  let receipt;
  try { receipt = JSON.parse(text); } catch { return result(['receipt JSON must parse']); }
  const validation = validateUnitExecutionReceipt(receipt, options);
  if (validation.ok && `${canonicalJson(receipt)}\n` !== text) return result(['receipt JSON must be canonical with one trailing newline']);
  return validation;
}

function validatePaths(paths, errors) {
  if (!Array.isArray(paths) || paths.length === 0) return errors.push('changedPaths must be a non-empty array');
  const seen = new Set();
  for (const path of paths) {
    if (typeof path !== 'string' || path === '' || ASCII_CONTROL_CHARACTER.test(path) || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..') || /(?:\s->\s|@\{)/.test(path)) {
      errors.push(`changed path is not a normalized repository path: ${String(path)}`);
    } else if (!EAW_PATHS.some((pattern) => pattern.test(path))) errors.push(`changed path is outside EAW namespaces: ${path}`);
    if (seen.has(path)) errors.push(`duplicate changed path: ${path}`);
    seen.add(path);
  }
}

function validateCommands(commands, errors) {
  if (!Array.isArray(commands) || commands.length === 0) return errors.push('commands must be a non-empty array');
  commands.forEach((entry, index) => {
    if (!isPlainObject(entry)) return errors.push(`commands[${index}] must be an object`);
    if (typeof entry.command !== 'string' || entry.command.trim() === '') errors.push(`commands[${index}].command must be non-empty`);
    if (!['passed', 'failed', 'warning'].includes(entry.result)) errors.push(`commands[${index}].result is invalid`);
    if (!Number.isInteger(entry.exitCode) || entry.exitCode < 0 || entry.exitCode > 255) errors.push(`commands[${index}].exitCode must be an integer from 0 through 255`);
    if (entry.result === 'passed' && entry.exitCode !== 0) errors.push(`commands[${index}] passed result requires exitCode 0`);
    if (entry.result === 'failed' && entry.exitCode === 0) errors.push(`commands[${index}] failed result requires a non-zero exitCode`);
    if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '') errors.push(`commands[${index}].evidence must be non-empty`);
    for (const key of Object.keys(entry)) if (!['command', 'result', 'exitCode', 'evidence'].includes(key)) errors.push(`commands[${index}] unsupported field: ${key}`);
  });
}

function validateUsage(usage, errors) {
  if (!isPlainObject(usage) || !['known', 'unknown'].includes(usage.status)) return errors.push('usage.status must be known or unknown');
  if (usage.status === 'unknown') {
    if (Object.keys(usage).length !== 1) errors.push('unknown usage must not contain fabricated zero or measured fields');
    return;
  }
  const keys = ['status', 'modelSpendUsd', 'inputTokens', 'outputTokens', 'solveCalls'];
  for (const key of Object.keys(usage)) if (!keys.includes(key)) errors.push(`usage unsupported field: ${key}`);
  if (!Number.isFinite(usage.modelSpendUsd) || usage.modelSpendUsd < 0) errors.push('usage.modelSpendUsd must be a non-negative finite number');
  for (const key of ['inputTokens', 'outputTokens', 'solveCalls']) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) errors.push(`usage.${key} must be a non-negative safe integer`);
  }
}

function validateProvenance(provenance, expected, errors) {
  if (!isPlainObject(provenance)) return errors.push('provenance must be an object');
  for (const key of Object.keys(provenance)) if (!['state', 'baseCommit', 'baseTree'].includes(key)) errors.push(`provenance unsupported field: ${key}`);
  if (provenance.state !== 'pre_commit') errors.push('provenance.state must be pre_commit; a receipt cannot self-claim its resulting commit');
  if (!GIT_OID.test(provenance.baseCommit ?? '')) errors.push('provenance.baseCommit must be a lowercase Git object id');
  if (!GIT_OID.test(provenance.baseTree ?? '')) errors.push('provenance.baseTree must be a lowercase Git object id');
  if (expected && (provenance.baseCommit !== expected.baseCommit || provenance.baseTree !== expected.baseTree)) errors.push('provenance does not match independently observed base commit/tree');
}

function result(errors) { return { ok: errors.length === 0, version: UNIT_EXECUTION_RECEIPT_VERSION, errors }; }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
