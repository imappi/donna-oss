import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORLD_BASELINE_VERSION = 'eaw.world-baseline.v1';
export const WORLD_BASELINE_ROOT = fileURLToPath(new URL('../../../data/worlds/baselines/', import.meta.url));

const IDENTITY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LIFECYCLE_KEYS = Object.freeze(['worldSchema', 'renderer', 'policyPack', 'oracle', 'corpus']);
const RECEIPT_KEYS = new Set([
  'version', 'suiteId', 'capabilityId', 'familyId', 'worldId', 'lifecycle',
  'solverDigest', 'modelId', 'modelSource', 'liveRunReceipt', 'result', 'digest',
]);

export function baselinePath(identity, { root = WORLD_BASELINE_ROOT } = {}) {
  if (path.resolve(root) !== path.resolve(WORLD_BASELINE_ROOT)) throw new TypeError('baseline root must be the single EAW-owned baseline root');
  const parts = ['suiteId', 'capabilityId', 'familyId', 'worldId'].map((key) => {
    const value = identity?.[key];
    if (typeof value !== 'string' || !IDENTITY.test(value)) throw new TypeError(`${key} must be a safe baseline identity`);
    return value;
  });
  const target = path.resolve(WORLD_BASELINE_ROOT, `${parts.join('--')}.json`);
  if (path.dirname(target) !== path.resolve(WORLD_BASELINE_ROOT)) throw new TypeError('baseline path escapes the EAW baseline root');
  return target;
}

export function computeWorldBaselineDigest(receipt) {
  if (!isObject(receipt)) throw new TypeError('baseline receipt must be an object');
  const { digest: _digest, ...body } = receipt;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function validateWorldBaseline(receipt, { requireAssurance = true } = {}) {
  const errors = [];
  if (!isObject(receipt)) return result(['baseline receipt must be an object']);
  if (receipt.version !== WORLD_BASELINE_VERSION) errors.push(`version must be ${WORLD_BASELINE_VERSION}`);
  for (const key of Object.keys(receipt)) if (!RECEIPT_KEYS.has(key)) errors.push(`${key} is unsupported`);
  for (const key of ['suiteId', 'capabilityId', 'familyId', 'worldId']) {
    if (typeof receipt[key] !== 'string' || !IDENTITY.test(receipt[key])) errors.push(`${key} must be a safe baseline identity`);
  }
  if (!isObject(receipt.lifecycle)) errors.push('lifecycle must be an object');
  else {
    for (const key of LIFECYCLE_KEYS) requiredString(receipt.lifecycle[key], `lifecycle.${key}`, errors);
    for (const key of Object.keys(receipt.lifecycle)) if (!LIFECYCLE_KEYS.includes(key)) errors.push(`lifecycle.${key} is unsupported`);
  }
  if (!SHA256.test(receipt.solverDigest ?? '')) errors.push('solverDigest must be a lowercase SHA-256 digest');
  requiredString(receipt.modelId, 'modelId', errors);
  if (!['provider_response', 'configured_fallback', 'legacy_unproven'].includes(receipt.modelSource)) {
    errors.push('modelSource must be provider_response, configured_fallback, or legacy_unproven');
  }
  if (!isObject(receipt.liveRunReceipt)) errors.push('liveRunReceipt must be an object');
  else {
    requiredString(receipt.liveRunReceipt.receiptId, 'liveRunReceipt.receiptId', errors);
    if (receipt.liveRunReceipt.completed !== true) errors.push('liveRunReceipt.completed must be true');
    if (!SHA256.test(receipt.liveRunReceipt.resultDigest ?? '')) errors.push('liveRunReceipt.resultDigest must be a lowercase SHA-256 digest');
    if (receipt.liveRunReceipt.modelId !== receipt.modelId) errors.push('liveRunReceipt.modelId must equal modelId');
    if (receipt.liveRunReceipt.modelSource !== receipt.modelSource) errors.push('liveRunReceipt.modelSource must equal modelSource');
  }
  if (!Object.hasOwn(receipt, 'result')) errors.push('result is required');
  if (requireAssurance && receipt.modelSource !== 'provider_response') errors.push('assurance baselines require response-proven model provenance');
  if (!SHA256.test(receipt.digest ?? '')) errors.push('digest must be a lowercase SHA-256 digest');
  else {
    try { if (computeWorldBaselineDigest(receipt) !== receipt.digest) errors.push('digest does not match canonical baseline content'); }
    catch { errors.push('baseline must contain only canonical JSON values'); }
  }
  return result(errors);
}

export function compareWorldBaseline(baseline, candidate) {
  const baselineValidation = validateWorldBaseline(baseline);
  const candidateValidation = validateWorldBaseline(candidate);
  const errors = [
    ...baselineValidation.errors.map((error) => `baseline.${error}`),
    ...candidateValidation.errors.map((error) => `candidate.${error}`),
  ];
  if (errors.length) return { ok: false, compatible: false, errors };
  for (const key of ['suiteId', 'capabilityId', 'familyId', 'worldId', 'solverDigest', 'modelId', 'modelSource']) {
    if (baseline[key] !== candidate[key]) errors.push(`${key} mismatch`);
  }
  for (const key of LIFECYCLE_KEYS) if (baseline.lifecycle[key] !== candidate.lifecycle[key]) errors.push(`lifecycle.${key} mismatch`);
  return { ok: errors.length === 0, compatible: errors.length === 0, errors };
}

export async function loadWorldBaseline(identity) {
  const target = baselinePath(identity);
  await assertRootIsCanonical();
  const metadata = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (metadata?.isSymbolicLink()) throw new Error('baseline file must not be a symlink');
  let text;
  try { text = await readFile(target, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('baseline does not exist');
    throw error;
  }
  let receipt;
  try { receipt = JSON.parse(text); } catch { throw new Error('existing baseline is malformed JSON'); }
  const validation = validateWorldBaseline(receipt);
  if (!validation.ok) throw new Error(`existing baseline is invalid: ${validation.errors.join('; ')}`);
  return receipt;
}

export async function saveWorldBaseline(receipt, { io = {} } = {}) {
  const validation = validateWorldBaseline(receipt);
  if (!validation.ok) throw new TypeError(validation.errors.join('; '));
  const target = baselinePath(receipt);
  await assertRootIsCanonical();
  const openFile = io.open ?? open;
  const linkFile = io.link ?? link;
  const unlinkFile = io.unlink ?? unlink;
  const temp = `${target}.pending-${receipt.digest}`;
  let handle;
  try {
    handle = await openFile(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${canonicalJson(receipt)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await linkFile(temp, target);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('baseline already exists; overwrite is forbidden');
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlinkFile(temp).catch(() => {});
  }
  return target;
}

async function assertRootIsCanonical() {
  const resolved = await realpath(WORLD_BASELINE_ROOT);
  if (resolved !== path.resolve(WORLD_BASELINE_ROOT)) throw new Error('EAW baseline root must not be a symlink');
}

function requiredString(value, field, errors) { if (typeof value !== 'string' || value.trim() === '') errors.push(`${field} must be a non-empty string`); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function result(errors) { return { ok: errors.length === 0, version: WORLD_BASELINE_VERSION, errors }; }
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new TypeError('unsupported canonical JSON value');
}
