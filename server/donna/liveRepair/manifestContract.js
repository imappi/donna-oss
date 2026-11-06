// DMEM-R1 MX-1 — the live-repair MANIFEST contract as code.
//
// docs/design-donna-memory-remediation.md §7.1 (operation classes) and §7.2 (the immutable
// manifest shape); docs/plan-2026-09-02-memory-remediation-v1.md §8 (the live-data policy
// these shapes serve); docs/plan-2026-09-02-memory-remediation-slices.md §5 MX-1.
//
// This module is a PURE LEAF: closed vocabularies as frozen arrays, a canonical digest, and
// a validator over plain objects. No I/O, no database, no runtime behaviour, no flag, and no
// import beyond node:crypto. It refuses; it never executes. The runner, the read-only
// inspector identity, the copy-class registry (W5) and every real manifest instance (LR-*)
// are later waves and do not exist here.
//
// Every refusal is { path, code } with `code` drawn from CONTRACT_ERROR_CODES — the one
// closed list shared by the manifest, receipt and erasure validators.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Closed vocabularies (§7.1, §7.2)
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_VERSIONS = Object.freeze(['live-repair-manifest/1']);

export const OPERATION_CLASSES = Object.freeze([
  'LIVE_CANARY',
  'LIVE_REPAIR',
  'LIVE_ERASURE',
  'OBJECT_RELOCATION',
  'AUTHORITATIVE_CUTOVER',
  'DESTRUCTIVE_CONTRACT'
]);

export const TARGET_TYPES = Object.freeze(['row', 'object', 'schema', 'external', 'copy_class']);

// A locator's `kind` must equal its target's `target_type`; each kind has a fixed field set.
export const LOCATOR_KINDS = Object.freeze(['row', 'object', 'schema', 'external', 'copy_class']);

export const RUNTIME_PROFILES = Object.freeze(['supervised_desktop_local']);
export const FORBIDDEN_TARGET_KINDS = Object.freeze(['cloud_database', 'undeclared_object_root']);
export const DRY_RUN_RUNNER_CLASSES = Object.freeze(['read_only_inspector']);
export const INDETERMINATE_OUTCOME_POLICIES = Object.freeze(['reconcile', 'stop_for_explicit_resolution']);
export const PREDICATE_OPERATORS = Object.freeze(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
export const SCHEMA_OBJECT_KINDS = Object.freeze(['table', 'column', 'index', 'constraint', 'sequence', 'function', 'trigger', 'view']);

// The registered actions a step, compensation or rollback step may name. Closed here; a
// later wave that registers a runner extends THIS list in the same commit as the runner.
export const REGISTERED_ACTIONS = Object.freeze([
  'row_update',
  'row_insert',
  'row_delete',
  'row_reclassify',
  'object_copy',
  'object_hash_verify',
  'pointer_switch',
  'object_delete',
  'schema_apply',
  'external_request',
  'copy_class_erase',
  'noop_verify'
]);

// Closed semantic classifications for a target's before/after state (§7.2) and a result's
// observed state (§7.3). Drawn from plan v1.0 §8's default classifications and §6/§7.4.
export const SEMANTIC_CLASSIFICATIONS = Object.freeze([
  'active',
  'confirmed',
  'proposed',
  'legacy_ai',
  'unproven',
  'quarantined_compatibility',
  'historical_context_unavailable',
  'sent',
  'not_sent',
  'demo_prefixed',
  'canonical',
  'relocated',
  'pointer_switched',
  'duplicate',
  'stale',
  'erased',
  'content_free_proof',
  'held',
  'absent'
]);

// The ONE closed error-code list for every validator in this directory.
export const CONTRACT_ERROR_CODES = Object.freeze([
  'missing_field',
  'unknown_field',
  'wrong_type',
  'unknown_enum_value',
  'invalid_instant',
  'value_out_of_bounds',
  'forbidden_value',
  'dynamic_locator',
  'empty_collection',
  'duplicate_identifier',
  'non_contiguous_ordinals',
  'undeclared_target',
  'class_mismatch',
  'digest_mismatch',
  'manifest_mismatch',
  'future_result_in_manifest',
  'missing_result',
  'undeclared_targets_touched',
  'totals_mismatch',
  'completion_equation_unbalanced',
  'erasure_balance_open'
]);

// Top-level keys that belong to a RECEIPT; their presence on a manifest is the §7.2
// "never contains a future execution result or receipt" refusal.
const FUTURE_RESULT_KEYS = Object.freeze([
  'results', 'receipt', 'receipt_id', 'receipt_digest', 'completion', 'totals', 'execution', 'authorization'
]);

// ---------------------------------------------------------------------------
// Canonical digest
// ---------------------------------------------------------------------------

// Canonical JSON: object keys sorted (code-unit order), no insignificant whitespace,
// `undefined`-valued keys omitted (as JSON.stringify does), arrays in order. UTF-8 bytes
// of that string are what the sha256 covers.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function canonicalDigest(value) {
  return createHash('sha256').update(Buffer.from(canonicalJson(value), 'utf8')).digest('hex');
}

// manifest_digest covers every manifest field except itself.
export function manifestDigest(manifest) {
  const { manifest_digest: _omitted, ...rest } = manifest;
  return canonicalDigest(rest);
}

export function withManifestDigest(manifest) {
  return { ...manifest, manifest_digest: manifestDigest(manifest) };
}

// ---------------------------------------------------------------------------
// Validation toolkit (shared by the receipt and erasure validators)
// ---------------------------------------------------------------------------

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const HEX_DIGEST_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const WILDCARD_RE = /[*%?[\]{}]/;
const DYNAMIC_LOCATOR_KEYS = new Set([
  'query', 'sql', 'where', 'filter', 'prefix', 'suffix', 'glob', 'pattern', 'regex', 'like', 'ilike',
  'match', 'all', 'any', 'select', 'discovery', 'wildcard', 'starts_with', 'ends_with', 'contains', 'in'
]);

export const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const isInstant = (value) => typeof value === 'string' && INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value));
export const isHexDigest = (value) => typeof value === 'string' && HEX_DIGEST_RE.test(value);
export const isDecimalString = (value) => typeof value === 'string' && DECIMAL_RE.test(value);
export const isCurrency = (value) => typeof value === 'string' && CURRENCY_RE.test(value);
export const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
export const isInteger = (value) => Number.isInteger(value);
export const isScalar = (value) =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

// Exact decimal comparison on decimal strings (no floats): returns -1 | 0 | 1.
export function compareDecimalStrings(a, b) {
  const parse = (text) => {
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    return { negative, whole, fraction };
  };
  const left = parse(a);
  const right = parse(b);
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const toBig = ({ negative, whole, fraction }) => {
    const magnitude = BigInt(`${whole}${fraction.padEnd(scale, '0')}` || '0');
    return negative ? -magnitude : magnitude;
  };
  const l = toBig(left);
  const r = toBig(right);
  return l < r ? -1 : l > r ? 1 : 0;
}

export function createValidator() {
  const errors = [];
  const fail = (path, code) => {
    if (!CONTRACT_ERROR_CODES.includes(code)) throw new Error(`unknown contract error code: ${code}`);
    errors.push({ path, code });
  };
  const join = (path, key) => (path ? `${path}.${key}` : key);
  const index = (path, i) => `${path}[${i}]`;

  // Checks presence + object-ness + field closure. Returns true when the object is usable.
  const object = (value, path, required, optional = []) => {
    if (value === undefined) {
      fail(path, 'missing_field');
      return false;
    }
    if (!isPlainObject(value)) {
      fail(path, 'wrong_type');
      return false;
    }
    for (const key of required) if (value[key] === undefined) fail(join(path, key), 'missing_field');
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(join(path, key), 'unknown_field');
    return true;
  };

  const present = (value, path) => {
    if (value === undefined) {
      fail(path, 'missing_field');
      return false;
    }
    return true;
  };

  const string = (value, path) => {
    if (!present(value, path)) return false;
    if (!isNonEmptyString(value)) {
      fail(path, typeof value === 'string' ? 'value_out_of_bounds' : 'wrong_type');
      return false;
    }
    return true;
  };

  const boundedString = (value, path, maxLength) => {
    if (!string(value, path)) return false;
    if (value.length > maxLength) {
      fail(path, 'value_out_of_bounds');
      return false;
    }
    return true;
  };

  const enumeration = (value, path, vocabulary) => {
    if (!present(value, path)) return false;
    if (typeof value !== 'string') {
      fail(path, 'wrong_type');
      return false;
    }
    if (!vocabulary.includes(value)) {
      fail(path, 'unknown_enum_value');
      return false;
    }
    return true;
  };

  const instant = (value, path) => {
    if (!present(value, path)) return false;
    if (!isInstant(value)) {
      fail(path, 'invalid_instant');
      return false;
    }
    return true;
  };

  const hexDigest = (value, path) => {
    if (!present(value, path)) return false;
    if (!isHexDigest(value)) {
      fail(path, typeof value === 'string' ? 'value_out_of_bounds' : 'wrong_type');
      return false;
    }
    return true;
  };

  const integer = (value, path, { min = 0 } = {}) => {
    if (!present(value, path)) return false;
    if (!isInteger(value)) {
      fail(path, 'wrong_type');
      return false;
    }
    if (value < min) {
      fail(path, 'value_out_of_bounds');
      return false;
    }
    return true;
  };

  const boolean = (value, path) => {
    if (!present(value, path)) return false;
    if (typeof value !== 'boolean') {
      fail(path, 'wrong_type');
      return false;
    }
    return true;
  };

  const exactly = (value, path, expected) => {
    if (!present(value, path)) return false;
    if (value !== expected) {
      fail(path, 'forbidden_value');
      return false;
    }
    return true;
  };

  const array = (value, path, { nonEmpty = false } = {}) => {
    if (!present(value, path)) return false;
    if (!Array.isArray(value)) {
      fail(path, 'wrong_type');
      return false;
    }
    if (nonEmpty && value.length === 0) {
      fail(path, 'empty_collection');
      return false;
    }
    return true;
  };

  // A scalar or a `not_applicable` sentinel.
  const scalarOrNotApplicable = (value, path) => {
    if (!present(value, path)) return false;
    if (!(isScalar(value) && value !== null)) {
      fail(path, 'wrong_type');
      return false;
    }
    return true;
  };

  // version_or_generation: an expected/observed value — string or integer.
  const versionOrGeneration = (value, path) => {
    if (!present(value, path)) return false;
    if (!(isNonEmptyString(value) || isInteger(value))) {
      fail(path, 'wrong_type');
      return false;
    }
    return true;
  };

  // A deterministic predicate: { subject, operator, value } with a scalar value.
  const predicate = (value, path) => {
    if (!object(value, path, ['subject', 'operator', 'value'])) return false;
    string(value.subject, join(path, 'subject'));
    enumeration(value.operator, join(path, 'operator'), PREDICATE_OPERATORS);
    if (!isScalar(value.value)) fail(join(path, 'value'), 'wrong_type');
    return true;
  };

  const predicates = (value, path) => {
    if (!array(value, path)) return false;
    value.forEach((item, i) => predicate(item, index(path, i)));
    return true;
  };

  // Ordinals must be exactly 1..n in array order.
  const ordinals = (items, path) => {
    items.forEach((item, i) => {
      if (!isPlainObject(item)) return;
      if (item.ordinal === undefined) {
        fail(join(index(path, i), 'ordinal'), 'missing_field');
        return;
      }
      if (!isInteger(item.ordinal)) {
        fail(join(index(path, i), 'ordinal'), 'wrong_type');
        return;
      }
      if (item.ordinal !== i + 1) fail(join(index(path, i), 'ordinal'), 'non_contiguous_ordinals');
    });
  };

  return {
    errors, fail, join, index, object, present, string, boundedString, enumeration, instant, hexDigest,
    integer, boolean, exactly, array, scalarOrNotApplicable, versionOrGeneration, predicate, predicates, ordinals,
    result: () => ({ ok: errors.length === 0, errors: errors.slice() })
  };
}

// ---------------------------------------------------------------------------
// Locators (§7.2: exact typed locator; no wildcard, query, glob, prefix, list, discovery)
// ---------------------------------------------------------------------------

const LOCATOR_FIELDS = Object.freeze({
  row: Object.freeze({ required: ['kind', 'table', 'primary_key'], optional: ['schema'] }),
  object: Object.freeze({ required: ['kind', 'root', 'relpath', 'content_digest'], optional: [] }),
  schema: Object.freeze({ required: ['kind', 'object_kind', 'name'], optional: ['schema', 'parent'] }),
  external: Object.freeze({ required: ['kind', 'provider', 'resource_id'], optional: ['endpoint'] }),
  copy_class: Object.freeze({ required: ['kind', 'copy_class_id', 'locator_fields'], optional: [] })
});

// Walks every leaf of a locator: dynamic keys and wildcard-bearing or list-shaped values are
// refused wherever they sit. Identifiers must be exact scalars.
function walkLocatorLeaves(v, value, path) {
  if (Array.isArray(value)) {
    v.fail(path, 'dynamic_locator');
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const childPath = v.join(path, key);
      if (DYNAMIC_LOCATOR_KEYS.has(key)) {
        v.fail(childPath, 'dynamic_locator');
        continue;
      }
      walkLocatorLeaves(v, value[key], childPath);
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length === 0 || WILDCARD_RE.test(value) || value.endsWith('/') || value.includes('..')) v.fail(path, 'dynamic_locator');
    return;
  }
  if (value === null || typeof value === 'object' || typeof value === 'function') v.fail(path, 'wrong_type');
}

function validateLocator(v, locator, path, targetType) {
  if (!v.present(locator, path)) return;
  if (!isPlainObject(locator)) {
    v.fail(path, 'wrong_type');
    return;
  }
  // Dynamic shapes are refused before the field-set check so the refusal names the real problem.
  walkLocatorLeaves(v, locator, path);
  if (!v.enumeration(locator.kind, v.join(path, 'kind'), LOCATOR_KINDS)) return;
  if (locator.kind !== targetType) v.fail(v.join(path, 'kind'), 'forbidden_value');
  const fields = LOCATOR_FIELDS[locator.kind];
  for (const key of fields.required) if (locator[key] === undefined) v.fail(v.join(path, key), 'missing_field');
  const allowed = new Set([...fields.required, ...fields.optional]);
  for (const key of Object.keys(locator)) {
    if (!allowed.has(key) && !DYNAMIC_LOCATOR_KEYS.has(key)) v.fail(v.join(path, key), 'unknown_field');
  }
  switch (locator.kind) {
    case 'row':
      if (locator.primary_key !== undefined) {
        if (!isPlainObject(locator.primary_key)) v.fail(v.join(path, 'primary_key'), 'wrong_type');
        else if (Object.keys(locator.primary_key).length === 0) v.fail(v.join(path, 'primary_key'), 'empty_collection');
      }
      break;
    case 'object':
      if (locator.content_digest !== undefined) v.hexDigest(locator.content_digest, v.join(path, 'content_digest'));
      if (typeof locator.relpath === 'string' && locator.relpath.startsWith('/')) v.fail(v.join(path, 'relpath'), 'forbidden_value');
      break;
    case 'schema':
      if (locator.object_kind !== undefined) v.enumeration(locator.object_kind, v.join(path, 'object_kind'), SCHEMA_OBJECT_KINDS);
      break;
    case 'copy_class':
      if (locator.locator_fields !== undefined) {
        if (!isPlainObject(locator.locator_fields)) v.fail(v.join(path, 'locator_fields'), 'wrong_type');
        else if (Object.keys(locator.locator_fields).length === 0) v.fail(v.join(path, 'locator_fields'), 'empty_collection');
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Manifest sections
// ---------------------------------------------------------------------------

function validateTargetEnvironment(v, environment, path) {
  if (!v.object(environment, path, [
    'runtime_profile', 'host_fingerprint', 'database_oid', 'database_name', 'object_root', 'forbidden_targets'
  ])) return;
  v.enumeration(environment.runtime_profile, v.join(path, 'runtime_profile'), RUNTIME_PROFILES);
  v.string(environment.host_fingerprint, v.join(path, 'host_fingerprint'));
  v.string(environment.database_oid, v.join(path, 'database_oid'));
  v.string(environment.database_name, v.join(path, 'database_name'));
  if (v.object(environment.object_root, v.join(path, 'object_root'), ['realpath', 'device_id'])) {
    const root = environment.object_root;
    if (v.string(root.realpath, v.join(path, 'object_root.realpath')) && !root.realpath.startsWith('/')) {
      v.fail(v.join(path, 'object_root.realpath'), 'forbidden_value');
    }
    v.string(root.device_id, v.join(path, 'object_root.device_id'));
  }
  const forbiddenPath = v.join(path, 'forbidden_targets');
  if (v.array(environment.forbidden_targets, forbiddenPath, { nonEmpty: true })) {
    environment.forbidden_targets.forEach((item, i) => v.enumeration(item, v.index(forbiddenPath, i), FORBIDDEN_TARGET_KINDS));
    for (const kind of FORBIDDEN_TARGET_KINDS) {
      if (!environment.forbidden_targets.includes(kind)) v.fail(forbiddenPath, 'forbidden_value');
    }
  }
}

function validateAuthorizationRequirement(v, requirement, path, operationClass) {
  if (!v.object(requirement, path, ['class', 'manifest_digest_required', 'source_identifier_required_in_receipt'])) return;
  if (v.enumeration(requirement.class, v.join(path, 'class'), OPERATION_CLASSES) && operationClass !== undefined) {
    if (requirement.class !== operationClass) v.fail(v.join(path, 'class'), 'class_mismatch');
  }
  v.exactly(requirement.manifest_digest_required, v.join(path, 'manifest_digest_required'), true);
  v.exactly(requirement.source_identifier_required_in_receipt, v.join(path, 'source_identifier_required_in_receipt'), true);
}

function validateInputBaseline(v, baseline, path) {
  const fields = [
    'code_revision', 'schema_fingerprint', 'configuration_fingerprint', 'database_snapshot_fingerprint', 'object_snapshot_fingerprint'
  ];
  if (!v.object(baseline, path, fields)) return;
  v.string(baseline.code_revision, v.join(path, 'code_revision'));
  for (const key of fields.slice(1)) v.hexDigest(baseline[key], v.join(path, key));
}

function validateLimits(v, limits, path) {
  if (!v.object(limits, path, [
    'maximum_rows', 'maximum_objects', 'maximum_accounting_amount', 'locks', 'statement_timeout_ms', 'lock_timeout_ms',
    'canary_duration_ms', 'stop_thresholds'
  ])) return;
  v.integer(limits.maximum_rows, v.join(path, 'maximum_rows'));
  v.integer(limits.maximum_objects, v.join(path, 'maximum_objects'));
  const amountPath = v.join(path, 'maximum_accounting_amount');
  if (v.object(limits.maximum_accounting_amount, amountPath, ['amount', 'currency'])) {
    const amount = limits.maximum_accounting_amount;
    if (v.present(amount.amount, v.join(amountPath, 'amount')) && !isDecimalString(amount.amount)) v.fail(v.join(amountPath, 'amount'), 'wrong_type');
    else if (isDecimalString(amount.amount) && amount.amount.startsWith('-')) v.fail(v.join(amountPath, 'amount'), 'value_out_of_bounds');
    if (v.present(amount.currency, v.join(amountPath, 'currency')) && !(isCurrency(amount.currency) || amount.currency === 'not_applicable')) {
      v.fail(v.join(amountPath, 'currency'), typeof amount.currency === 'string' ? 'unknown_enum_value' : 'wrong_type');
    }
  }
  const locksPath = v.join(path, 'locks');
  if (v.array(limits.locks, locksPath)) {
    const seen = new Set();
    limits.locks.forEach((lock, i) => {
      if (v.string(lock, v.index(locksPath, i))) {
        if (seen.has(lock)) v.fail(v.index(locksPath, i), 'duplicate_identifier');
        seen.add(lock);
      }
    });
  }
  v.integer(limits.statement_timeout_ms, v.join(path, 'statement_timeout_ms'), { min: 1 });
  v.integer(limits.lock_timeout_ms, v.join(path, 'lock_timeout_ms'), { min: 1 });
  const canaryPath = v.join(path, 'canary_duration_ms');
  if (v.present(limits.canary_duration_ms, canaryPath)) {
    if (limits.canary_duration_ms !== 'not_applicable' && !isInteger(limits.canary_duration_ms)) v.fail(canaryPath, 'wrong_type');
    else if (isInteger(limits.canary_duration_ms) && limits.canary_duration_ms < 1) v.fail(canaryPath, 'value_out_of_bounds');
  }
  const thresholdsPath = v.join(path, 'stop_thresholds');
  if (v.array(limits.stop_thresholds, thresholdsPath)) {
    limits.stop_thresholds.forEach((item, i) => {
      const itemPath = v.index(thresholdsPath, i);
      if (!v.object(item, itemPath, ['metric', 'operator', 'value'])) return;
      v.string(item.metric, v.join(itemPath, 'metric'));
      v.enumeration(item.operator, v.join(itemPath, 'operator'), PREDICATE_OPERATORS);
      if (!isScalar(item.value) || item.value === null) v.fail(v.join(itemPath, 'value'), 'wrong_type');
    });
  }
}

function validateTarget(v, target, path, operationClass, seenIds) {
  if (!v.object(target, path, [
    'target_id', 'target_type', 'locator', 'scope', 'before', 'after', 'required_for_completion'
  ], ['copy_class_id'])) return;
  if (v.string(target.target_id, v.join(path, 'target_id'))) {
    if (seenIds.has(target.target_id)) v.fail(v.join(path, 'target_id'), 'duplicate_identifier');
    seenIds.add(target.target_id);
  }
  const typeOk = v.enumeration(target.target_type, v.join(path, 'target_type'), TARGET_TYPES);
  validateLocator(v, target.locator, v.join(path, 'locator'), typeOk ? target.target_type : undefined);

  const scopePath = v.join(path, 'scope');
  if (v.object(target.scope, scopePath, ['tenant', 'legal_entity', 'subject'], ['source_object', 'operation'])) {
    for (const key of Object.keys(target.scope)) v.string(target.scope[key], v.join(scopePath, key));
  }

  // copy_class_id is required when content-bearing; a LIVE_ERASURE freezes its copy set from
  // it, so there every target must carry one. A copy_class target always carries its class.
  const copyClassPath = v.join(path, 'copy_class_id');
  if (target.copy_class_id !== undefined) {
    v.string(target.copy_class_id, copyClassPath);
    if (typeOk && target.target_type === 'copy_class' && isPlainObject(target.locator) && typeof target.locator.copy_class_id === 'string'
      && target.locator.copy_class_id !== target.copy_class_id) {
      v.fail(copyClassPath, 'forbidden_value');
    }
  } else if (operationClass === 'LIVE_ERASURE' || target.target_type === 'copy_class') {
    v.fail(copyClassPath, 'missing_field');
  }

  const beforePath = v.join(path, 'before');
  if (v.object(target.before, beforePath, ['classification', 'digest', 'version_or_generation'])) {
    v.enumeration(target.before.classification, v.join(beforePath, 'classification'), SEMANTIC_CLASSIFICATIONS);
    v.hexDigest(target.before.digest, v.join(beforePath, 'digest'));
    v.versionOrGeneration(target.before.version_or_generation, v.join(beforePath, 'version_or_generation'));
  }
  const afterPath = v.join(path, 'after');
  if (v.object(target.after, afterPath, ['classification', 'digest_or_predicate'])) {
    v.enumeration(target.after.classification, v.join(afterPath, 'classification'), SEMANTIC_CLASSIFICATIONS);
    const dop = target.after.digest_or_predicate;
    const dopPath = v.join(afterPath, 'digest_or_predicate');
    if (v.present(dop, dopPath)) {
      if (typeof dop === 'string') v.hexDigest(dop, dopPath);
      else v.predicate(dop, dopPath);
    }
  }
  v.boolean(target.required_for_completion, v.join(path, 'required_for_completion'));
}

function validateTargetIds(v, targetIds, path, declaredIds) {
  if (!v.array(targetIds, path, { nonEmpty: true })) return;
  const seen = new Set();
  targetIds.forEach((id, i) => {
    const idPath = v.index(path, i);
    if (!v.string(id, idPath)) return;
    if (!declaredIds.has(id)) v.fail(idPath, 'undeclared_target');
    if (seen.has(id)) v.fail(idPath, 'duplicate_identifier');
    seen.add(id);
  });
}

function validateStep(v, step, path, declaredIds, seenKeys) {
  if (!v.object(step, path, [
    'ordinal', 'target_ids', 'action', 'preconditions', 'transaction_boundary', 'idempotency_key', 'postconditions',
    'external_endpoint_and_action', 'indeterminate_outcome_policy', 'compensation'
  ])) return;
  validateTargetIds(v, step.target_ids, v.join(path, 'target_ids'), declaredIds);
  v.enumeration(step.action, v.join(path, 'action'), REGISTERED_ACTIONS);
  v.predicates(step.preconditions, v.join(path, 'preconditions'));
  v.string(step.transaction_boundary, v.join(path, 'transaction_boundary'));
  if (v.string(step.idempotency_key, v.join(path, 'idempotency_key'))) {
    if (seenKeys.has(step.idempotency_key)) v.fail(v.join(path, 'idempotency_key'), 'duplicate_identifier');
    seenKeys.add(step.idempotency_key);
  }
  v.predicates(step.postconditions, v.join(path, 'postconditions'));

  const externalPath = v.join(path, 'external_endpoint_and_action');
  const external = step.external_endpoint_and_action;
  if (v.present(external, externalPath) && external !== 'not_applicable') {
    if (v.object(external, externalPath, ['endpoint', 'action'])) {
      v.string(external.endpoint, v.join(externalPath, 'endpoint'));
      v.string(external.action, v.join(externalPath, 'action'));
    }
  }
  if (external === 'not_applicable' && step.action === 'external_request') v.fail(externalPath, 'forbidden_value');

  v.enumeration(step.indeterminate_outcome_policy, v.join(path, 'indeterminate_outcome_policy'), INDETERMINATE_OUTCOME_POLICIES);

  const compensationPath = v.join(path, 'compensation');
  const compensation = step.compensation;
  if (v.present(compensation, compensationPath)) {
    if (!isPlainObject(compensation)) v.fail(compensationPath, 'wrong_type');
    else {
      const keys = Object.keys(compensation);
      if (keys.length === 1 && keys[0] === 'action') v.enumeration(compensation.action, v.join(compensationPath, 'action'), REGISTERED_ACTIONS);
      else if (keys.length === 1 && keys[0] === 'impossible_with_reason') v.boundedString(compensation.impossible_with_reason, v.join(compensationPath, 'impossible_with_reason'), 2000);
      else v.fail(compensationPath, 'forbidden_value');
    }
  }
}

function validateDryRun(v, dryRun, path) {
  if (!v.object(dryRun, path, ['runner_identity_class', 'output_digest', 'observed_at', 'passed'])) return;
  v.enumeration(dryRun.runner_identity_class, v.join(path, 'runner_identity_class'), DRY_RUN_RUNNER_CLASSES);
  v.hexDigest(dryRun.output_digest, v.join(path, 'output_digest'));
  v.instant(dryRun.observed_at, v.join(path, 'observed_at'));
  v.exactly(dryRun.passed, v.join(path, 'passed'), true);
}

function validateRecovery(v, recovery, path, declaredIds) {
  if (!v.object(recovery, path, [
    'backup_reference', 'backup_digest', 'backup_verified_at', 'rollback_steps', 'rollback_postconditions'
  ])) return;
  v.string(recovery.backup_reference, v.join(path, 'backup_reference'));
  v.hexDigest(recovery.backup_digest, v.join(path, 'backup_digest'));
  v.instant(recovery.backup_verified_at, v.join(path, 'backup_verified_at'));
  const stepsPath = v.join(path, 'rollback_steps');
  if (v.array(recovery.rollback_steps, stepsPath)) {
    v.ordinals(recovery.rollback_steps, stepsPath);
    recovery.rollback_steps.forEach((step, i) => {
      const stepPath = v.index(stepsPath, i);
      if (!v.object(step, stepPath, ['ordinal', 'target_ids', 'action'])) return;
      validateTargetIds(v, step.target_ids, v.join(stepPath, 'target_ids'), declaredIds);
      v.enumeration(step.action, v.join(stepPath, 'action'), REGISTERED_ACTIONS);
    });
  }
  v.predicates(recovery.rollback_postconditions, v.join(path, 'rollback_postconditions'));
}

const MANIFEST_FIELDS = Object.freeze([
  'schema_version', 'operation_id', 'operation_class', 'purpose', 'created_at', 'expires_at', 'target_environment',
  'authorization_requirement', 'input_baseline', 'limits', 'targets', 'steps', 'dry_run', 'recovery', 'manifest_digest'
]);

// ---------------------------------------------------------------------------
// validateLiveRepairManifest
// ---------------------------------------------------------------------------

export function validateLiveRepairManifest(manifest) {
  const v = createValidator();
  if (!isPlainObject(manifest)) {
    v.fail('', 'wrong_type');
    return v.result();
  }
  for (const key of Object.keys(manifest)) {
    if (FUTURE_RESULT_KEYS.includes(key)) v.fail(key, 'future_result_in_manifest');
    else if (!MANIFEST_FIELDS.includes(key)) v.fail(key, 'unknown_field');
  }
  for (const key of MANIFEST_FIELDS) if (manifest[key] === undefined) v.fail(key, 'missing_field');

  v.enumeration(manifest.schema_version, 'schema_version', MANIFEST_SCHEMA_VERSIONS);
  v.string(manifest.operation_id, 'operation_id');
  const classOk = v.enumeration(manifest.operation_class, 'operation_class', OPERATION_CLASSES);
  const operationClass = classOk ? manifest.operation_class : undefined;
  v.boundedString(manifest.purpose, 'purpose', 2000);
  const createdOk = v.instant(manifest.created_at, 'created_at');
  const expiresOk = v.instant(manifest.expires_at, 'expires_at');
  if (createdOk && expiresOk && Date.parse(manifest.expires_at) <= Date.parse(manifest.created_at)) v.fail('expires_at', 'value_out_of_bounds');

  validateTargetEnvironment(v, manifest.target_environment, 'target_environment');
  validateAuthorizationRequirement(v, manifest.authorization_requirement, 'authorization_requirement', operationClass);
  validateInputBaseline(v, manifest.input_baseline, 'input_baseline');
  validateLimits(v, manifest.limits, 'limits');

  const declaredIds = new Set();
  if (v.array(manifest.targets, 'targets', { nonEmpty: true })) {
    manifest.targets.forEach((target, i) => validateTarget(v, target, v.index('targets', i), operationClass, declaredIds));
  }
  if (v.array(manifest.steps, 'steps', { nonEmpty: true })) {
    v.ordinals(manifest.steps, 'steps');
    const seenKeys = new Set();
    manifest.steps.forEach((step, i) => validateStep(v, step, v.index('steps', i), declaredIds, seenKeys));
  }
  validateDryRun(v, manifest.dry_run, 'dry_run');
  validateRecovery(v, manifest.recovery, 'recovery', declaredIds);

  if (manifest.manifest_digest !== undefined) {
    if (v.hexDigest(manifest.manifest_digest, 'manifest_digest') && manifest.manifest_digest !== manifestDigest(manifest)) {
      v.fail('manifest_digest', 'digest_mismatch');
    }
  }
  return v.result();
}
