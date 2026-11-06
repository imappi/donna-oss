// DMEM-R1 MX-1 — the live-repair EXECUTION RECEIPT contract as code.
//
// docs/design-donna-memory-remediation.md §7.3 (the immutable receipt shape and the
// completion equation) with §7.4 folded in for LIVE_ERASURE. Pure leaf: no I/O, no runtime,
// no import beyond node:crypto (via manifestContract.js) and its two siblings.
//
// The receipt "cannot make a failed, partial, rolled-back, or indeterminate operation appear
// complete". This validator enforces that in two layers: the receipt's own claimed numbers
// must satisfy the §7.3 equation (completionEquation), AND those claims must equal what the
// per-target results actually support when read against the manifest (deriveCompletion).
// A receipt that reports a failure honestly passes; a receipt that reports a failure and
// claims `completed` is refused.

import {
  OPERATION_CLASSES,
  SEMANTIC_CLASSIFICATIONS,
  canonicalDigest,
  createValidator,
  isPlainObject,
  isInteger,
  isScalar,
  isCurrency,
  isDecimalString,
  compareDecimalStrings,
  validateLiveRepairManifest
} from './manifestContract.js';
import { erasureBalance, frozenCopySet, classifyErasureDisposition, validateErasureResult } from './erasureResult.js';

// ---------------------------------------------------------------------------
// Closed vocabularies (§7.3)
// ---------------------------------------------------------------------------

export const RECEIPT_SCHEMA_VERSIONS = Object.freeze(['live-repair-receipt/1']);
export const PRECONDITION_RESULTS = Object.freeze(['passed', 'refused']);
export const ACTION_RESULTS = Object.freeze(['changed', 'already_satisfied', 'refused', 'failed', 'indeterminate']);
export const POSTCONDITION_RESULTS = Object.freeze(['passed', 'failed', 'indeterminate']);
export const COMPENSATION_RESULTS = Object.freeze(['not_required', 'completed', 'failed', 'indeterminate']);
export const COMPLETION_STATUSES = Object.freeze(['completed', 'refused', 'failed', 'partial', 'indeterminate', 'rolled_back']);
export const ROLLBACK_STATUSES = Object.freeze(['not_required', 'completed', 'failed', 'indeterminate']);

// after_observed.classification may be `unknown_if_indeterminate` ONLY on an indeterminate action.
export const OBSERVED_CLASSIFICATIONS = Object.freeze([...SEMANTIC_CLASSIFICATIONS, 'unknown_if_indeterminate']);

// Closed follow-up codes a completion may carry (§7.3 "remaining_follow_up: closed codes only").
export const FOLLOW_UP_CODES = Object.freeze([
  'separately_approved_delete',
  'soak_pending',
  'provider_status_lookup',
  'explicit_resolution_required',
  'legal_hold_review',
  'external_limitation_disclosed',
  'rollback_verification',
  'new_manifest_required'
]);

// Closed per-result error codes (§7.3 "error: closed code plus bounded detail or null").
export const RESULT_ERROR_CODES = Object.freeze([
  'precondition_refused',
  'lock_timeout',
  'statement_timeout',
  'stop_threshold',
  'limit_exceeded',
  'provider_error',
  'provider_indeterminate',
  'postcondition_failed',
  'compensation_failed',
  'digest_mismatch',
  'unexpected'
]);

const EQUATION_FIELDS = Object.freeze([
  'required_declared', 'verified_changed', 'verified_already_satisfied', 'permitted_held_or_limited', 'unresolved'
]);

const RECEIPT_FIELDS = Object.freeze([
  'schema_version', 'receipt_id', 'operation_id', 'operation_class', 'manifest_digest', 'authorization', 'execution',
  'results', 'totals', 'completion', 'receipt_digest'
]);

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

// receipt_digest covers every receipt field except itself.
export function receiptDigest(receipt) {
  const { receipt_digest: _omitted, ...rest } = receipt;
  return canonicalDigest(rest);
}

export function withReceiptDigest(receipt) {
  return { ...receipt, receipt_digest: receiptDigest(receipt) };
}

// ---------------------------------------------------------------------------
// The §7.3 completion equation over the receipt's CLAIMED values
// ---------------------------------------------------------------------------

const int = (value) => (isInteger(value) ? value : NaN);

export function completionEquation(receipt) {
  const totals = isPlainObject(receipt?.totals) ? receipt.totals : {};
  const completion = isPlainObject(receipt?.completion) ? receipt.completion : {};
  const equation = isPlainObject(completion.required_target_equation) ? completion.required_target_equation : {};
  const declared_targets = int(totals.declared_targets);
  const result_targets = int(totals.result_targets);
  const undeclared_targets_touched = int(totals.undeclared_targets_touched);
  const required_declared = int(equation.required_declared);
  const verified_changed = int(equation.verified_changed);
  const verified_already_satisfied = int(equation.verified_already_satisfied);
  const permitted_held_or_limited = int(equation.permitted_held_or_limited);
  const unresolved = int(equation.unresolved);
  const sum = verified_changed + verified_already_satisfied + permitted_held_or_limited;
  const checks = {
    targets_equal: declared_targets === result_targets,
    undeclared_zero: undeclared_targets_touched === 0,
    required_sum: required_declared === sum,
    unresolved_zero: unresolved === 0,
    equation_balances_claimed: completion.equation_balances === true,
    all_required_postconditions_passed: completion.all_required_postconditions_passed === true,
    within_manifest_limits: totals.within_manifest_limits === true
  };
  return {
    declared_targets,
    result_targets,
    undeclared_targets_touched,
    required_declared,
    verified_changed,
    verified_already_satisfied,
    permitted_held_or_limited,
    unresolved,
    sum,
    checks,
    balances: Object.values(checks).every(Boolean)
  };
}

// ---------------------------------------------------------------------------
// What the results actually support, read against the manifest
// ---------------------------------------------------------------------------

// The latest result per target (highest ordinal, then array order): rollback and compensation
// APPEND results (§7.3), so the last one is the target's current observed outcome.
function latestResultsByTarget(results) {
  const latest = new Map();
  results.forEach((result, position) => {
    if (!isPlainObject(result) || typeof result.target_id !== 'string') return;
    const ordinal = isInteger(result.ordinal) ? result.ordinal : position + 1;
    const current = latest.get(result.target_id);
    if (!current || ordinal >= current.ordinal) latest.set(result.target_id, { ordinal, result });
  });
  return latest;
}

function classifyLatest(result, target, isErasure) {
  if (!result) return 'unresolved';
  const postconditionPassed = result.postcondition_result === 'passed';
  if (isErasure) {
    const extension = result.erasure_result;
    if (!isPlainObject(extension) || extension.copy_class_id !== target.copy_class_id || extension.target_id !== target.target_id) {
      return 'unresolved';
    }
    const { permitted, limited } = classifyErasureDisposition(extension);
    if (!permitted) return 'unresolved';
    if (limited) return 'permitted_held_or_limited';
  }
  if (!postconditionPassed) return 'unresolved';
  if (result.action_result === 'changed') return 'verified_changed';
  if (result.action_result === 'already_satisfied') return 'verified_already_satisfied';
  return 'unresolved';
}

export function deriveCompletion(receipt, manifest) {
  const targets = Array.isArray(manifest?.targets) ? manifest.targets.filter(isPlainObject) : [];
  const results = Array.isArray(receipt?.results) ? receipt.results : [];
  const latest = latestResultsByTarget(results);
  const isErasure = manifest?.operation_class === 'LIVE_ERASURE';
  const derived = {
    declared_targets: targets.length,
    result_targets: [...latest.keys()].filter((id) => targets.some((target) => target.target_id === id)).length,
    required_declared: 0,
    verified_changed: 0,
    verified_already_satisfied: 0,
    permitted_held_or_limited: 0,
    unresolved: 0,
    all_required_postconditions_passed: true
  };
  for (const target of targets) {
    if (target.required_for_completion !== true) continue;
    derived.required_declared += 1;
    const entry = latest.get(target.target_id);
    const outcome = classifyLatest(entry ? entry.result : null, target, isErasure);
    derived[outcome] += 1;
    if (!entry || entry.result.postcondition_result !== 'passed') derived.all_required_postconditions_passed = false;
  }
  return derived;
}

// ---------------------------------------------------------------------------
// Receipt sections
// ---------------------------------------------------------------------------

function validateAuthorization(v, authorization, path, manifest) {
  if (!v.object(authorization, path, [
    'authorization_receipt_id', 'authorization_class', 'authorization_source_identifier', 'authorized_manifest_digest', 'authorized_at'
  ])) return;
  v.string(authorization.authorization_receipt_id, v.join(path, 'authorization_receipt_id'));
  if (v.enumeration(authorization.authorization_class, v.join(path, 'authorization_class'), OPERATION_CLASSES)
    && authorization.authorization_class !== manifest.operation_class) {
    v.fail(v.join(path, 'authorization_class'), 'class_mismatch');
  }
  v.string(authorization.authorization_source_identifier, v.join(path, 'authorization_source_identifier'));
  if (v.hexDigest(authorization.authorized_manifest_digest, v.join(path, 'authorized_manifest_digest'))
    && authorization.authorized_manifest_digest !== manifest.manifest_digest) {
    v.fail(v.join(path, 'authorized_manifest_digest'), 'manifest_mismatch');
  }
  v.instant(authorization.authorized_at, v.join(path, 'authorized_at'));
}

function validateExecution(v, execution, path, manifest, status) {
  if (!v.object(execution, path, [
    'runner_identity', 'started_at', 'finished_at', 'target_environment_fingerprint', 'code_revision', 'schema_fingerprint',
    'configuration_fingerprint', 'preflight_digest', 'dry_run_output_digest', 'stop_threshold_events'
  ])) return;
  v.string(execution.runner_identity, v.join(path, 'runner_identity'));
  const startedOk = v.instant(execution.started_at, v.join(path, 'started_at'));
  const finishedPath = v.join(path, 'finished_at');
  if (v.present(execution.finished_at, finishedPath)) {
    if (execution.finished_at === null) {
      // null only while explicitly in progress: a finished claim needs a finish instant.
      if (status === 'completed' || status === 'rolled_back') v.fail(finishedPath, 'forbidden_value');
    } else if (v.instant(execution.finished_at, finishedPath) && startedOk
      && Date.parse(execution.finished_at) < Date.parse(execution.started_at)) {
      v.fail(finishedPath, 'value_out_of_bounds');
    }
  }

  // The runner reports what it observed; a run that went ahead on a different host, database,
  // object root, revision or schema than the manifest expected is a lie unless it REFUSED.
  const refused = status === 'refused';
  const expected = manifest.target_environment;
  const fingerprintPath = v.join(path, 'target_environment_fingerprint');
  const observed = execution.target_environment_fingerprint;
  if (v.object(observed, fingerprintPath, ['host_fingerprint', 'database_oid', 'database_name', 'object_root'])) {
    for (const key of ['host_fingerprint', 'database_oid', 'database_name']) {
      if (v.string(observed[key], v.join(fingerprintPath, key)) && !refused && observed[key] !== expected[key]) {
        v.fail(v.join(fingerprintPath, key), 'manifest_mismatch');
      }
    }
    const rootPath = v.join(fingerprintPath, 'object_root');
    if (v.object(observed.object_root, rootPath, ['realpath', 'device_id'])) {
      for (const key of ['realpath', 'device_id']) {
        if (v.string(observed.object_root[key], v.join(rootPath, key)) && !refused
          && observed.object_root[key] !== expected.object_root[key]) {
          v.fail(v.join(rootPath, key), 'manifest_mismatch');
        }
      }
    }
  }
  for (const key of ['code_revision', 'schema_fingerprint', 'configuration_fingerprint']) {
    const ok = key === 'code_revision' ? v.string(execution[key], v.join(path, key)) : v.hexDigest(execution[key], v.join(path, key));
    if (ok && !refused && execution[key] !== manifest.input_baseline[key]) v.fail(v.join(path, key), 'manifest_mismatch');
  }
  v.hexDigest(execution.preflight_digest, v.join(path, 'preflight_digest'));
  if (v.hexDigest(execution.dry_run_output_digest, v.join(path, 'dry_run_output_digest'))
    && execution.dry_run_output_digest !== manifest.dry_run.output_digest) {
    v.fail(v.join(path, 'dry_run_output_digest'), 'manifest_mismatch');
  }
  const eventsPath = v.join(path, 'stop_threshold_events');
  if (v.array(execution.stop_threshold_events, eventsPath)) {
    execution.stop_threshold_events.forEach((event, i) => {
      const eventPath = v.index(eventsPath, i);
      if (!v.object(event, eventPath, ['observed_at', 'metric', 'value'])) return;
      v.instant(event.observed_at, v.join(eventPath, 'observed_at'));
      v.string(event.metric, v.join(eventPath, 'metric'));
      if (!isScalar(event.value) || event.value === null) v.fail(v.join(eventPath, 'value'), 'wrong_type');
    });
  }
}

function validateObserved(v, observed, path, { after }) {
  if (!v.object(observed, path, ['classification', 'digest', 'version_or_generation'])) return;
  v.enumeration(observed.classification, v.join(path, 'classification'), after ? OBSERVED_CLASSIFICATIONS : SEMANTIC_CLASSIFICATIONS);
  const digestPath = v.join(path, 'digest');
  if (after && isPlainObject(observed.digest)) {
    if (v.object(observed.digest, digestPath, ['unavailable_with_reason'])) {
      v.boundedString(observed.digest.unavailable_with_reason, v.join(digestPath, 'unavailable_with_reason'), 2000);
    }
  } else {
    v.hexDigest(observed.digest, digestPath);
  }
  v.versionOrGeneration(observed.version_or_generation, v.join(path, 'version_or_generation'));
}

function validateResult(v, result, path, manifest, targetsById, frozenPairs, firstSeen, seenAttempts) {
  const isErasure = manifest.operation_class === 'LIVE_ERASURE';
  const required = [
    'ordinal', 'target_id', 'attempt_id', 'started_at', 'finished_at', 'precondition_result', 'before_observed', 'action_result',
    'transaction_or_provider_reference', 'after_observed', 'postcondition_result', 'compensation_result', 'proof', 'error'
  ];
  if (!v.object(result, path, isErasure ? [...required, 'erasure_result'] : required)) return;

  const target = typeof result.target_id === 'string' ? targetsById.get(result.target_id) : undefined;
  if (v.string(result.target_id, v.join(path, 'target_id')) && !target) v.fail(v.join(path, 'target_id'), 'undeclared_target');
  if (v.string(result.attempt_id, v.join(path, 'attempt_id'))) {
    const key = `${result.target_id} ${result.attempt_id}`;
    if (seenAttempts.has(key)) v.fail(v.join(path, 'attempt_id'), 'duplicate_identifier');
    seenAttempts.add(key);
  }
  const startedOk = v.instant(result.started_at, v.join(path, 'started_at'));
  if (v.instant(result.finished_at, v.join(path, 'finished_at')) && startedOk
    && Date.parse(result.finished_at) < Date.parse(result.started_at)) {
    v.fail(v.join(path, 'finished_at'), 'value_out_of_bounds');
  }

  const preconditionOk = v.enumeration(result.precondition_result, v.join(path, 'precondition_result'), PRECONDITION_RESULTS);
  const actionOk = v.enumeration(result.action_result, v.join(path, 'action_result'), ACTION_RESULTS);
  if (preconditionOk && actionOk && result.precondition_result === 'refused' && result.action_result !== 'refused') {
    v.fail(v.join(path, 'action_result'), 'forbidden_value');
  }

  validateObserved(v, result.before_observed, v.join(path, 'before_observed'), { after: false });
  // The FIRST result for a target that passed its precondition must have observed the manifest's
  // frozen before-state; later (rollback / compensation) results observe what the attempt left.
  if (target && preconditionOk && result.precondition_result === 'passed' && !firstSeen.has(result.target_id)
    && isPlainObject(result.before_observed)) {
    firstSeen.add(result.target_id);
    const beforePath = v.join(path, 'before_observed');
    if (result.before_observed.digest !== target.before.digest) v.fail(v.join(beforePath, 'digest'), 'manifest_mismatch');
    if (result.before_observed.version_or_generation !== target.before.version_or_generation) {
      v.fail(v.join(beforePath, 'version_or_generation'), 'manifest_mismatch');
    }
  }

  v.string(result.transaction_or_provider_reference, v.join(path, 'transaction_or_provider_reference'));
  validateObserved(v, result.after_observed, v.join(path, 'after_observed'), { after: true });
  if (isPlainObject(result.after_observed) && result.after_observed.classification === 'unknown_if_indeterminate'
    && result.action_result !== 'indeterminate') {
    v.fail(v.join(path, 'after_observed.classification'), 'forbidden_value');
  }
  v.enumeration(result.postcondition_result, v.join(path, 'postcondition_result'), POSTCONDITION_RESULTS);
  v.enumeration(result.compensation_result, v.join(path, 'compensation_result'), COMPENSATION_RESULTS);

  const proofPath = v.join(path, 'proof');
  if (v.object(result.proof, proofPath, ['output', 'digest'])) {
    if (v.present(result.proof.output, v.join(proofPath, 'output'))
      && !(typeof result.proof.output === 'string' || isPlainObject(result.proof.output))) {
      v.fail(v.join(proofPath, 'output'), 'wrong_type');
    }
    v.hexDigest(result.proof.digest, v.join(proofPath, 'digest'));
  }

  const errorPath = v.join(path, 'error');
  if (v.present(result.error, errorPath) && result.error !== null) {
    if (v.object(result.error, errorPath, ['code', 'detail'])) {
      v.enumeration(result.error.code, v.join(errorPath, 'code'), RESULT_ERROR_CODES);
      v.boundedString(result.error.detail, v.join(errorPath, 'detail'), 2000);
    }
  } else if (result.error === null && result.action_result === 'failed') {
    v.fail(errorPath, 'forbidden_value');
  }

  if (isErasure) {
    validateErasureResult(v, result.erasure_result, v.join(path, 'erasure_result'), target, frozenPairs, result.target_id);
  }
}

function validateTotals(v, totals, path, manifest, derived) {
  if (!v.object(totals, path, [
    'declared_targets', 'result_targets', 'undeclared_targets_touched', 'rows_changed', 'objects_changed',
    'accounting_amount_changed_by_currency', 'within_manifest_limits'
  ])) return;
  if (v.integer(totals.declared_targets, v.join(path, 'declared_targets')) && totals.declared_targets !== derived.declared_targets) {
    v.fail(v.join(path, 'declared_targets'), 'totals_mismatch');
  }
  if (v.integer(totals.result_targets, v.join(path, 'result_targets')) && totals.result_targets !== derived.result_targets) {
    v.fail(v.join(path, 'result_targets'), 'totals_mismatch');
  }
  const undeclaredPath = v.join(path, 'undeclared_targets_touched');
  if (v.present(totals.undeclared_targets_touched, undeclaredPath)) {
    if (!isInteger(totals.undeclared_targets_touched)) v.fail(undeclaredPath, 'wrong_type');
    else if (totals.undeclared_targets_touched !== 0) v.fail(undeclaredPath, 'undeclared_targets_touched');
  }
  const rowsOk = v.integer(totals.rows_changed, v.join(path, 'rows_changed'));
  const objectsOk = v.integer(totals.objects_changed, v.join(path, 'objects_changed'));

  const amountsPath = v.join(path, 'accounting_amount_changed_by_currency');
  let amountsOk = false;
  if (v.present(totals.accounting_amount_changed_by_currency, amountsPath)) {
    const amounts = totals.accounting_amount_changed_by_currency;
    if (!isPlainObject(amounts)) v.fail(amountsPath, 'wrong_type');
    else {
      amountsOk = true;
      for (const [currency, amount] of Object.entries(amounts)) {
        if (!isCurrency(currency)) {
          v.fail(v.join(amountsPath, currency), 'unknown_enum_value');
          amountsOk = false;
        }
        if (!isDecimalString(amount)) {
          v.fail(v.join(amountsPath, currency), 'wrong_type');
          amountsOk = false;
        }
      }
    }
  }

  const withinPath = v.join(path, 'within_manifest_limits');
  if (v.boolean(totals.within_manifest_limits, withinPath) && totals.within_manifest_limits === true) {
    const limits = manifest.limits;
    let over = false;
    if (rowsOk && totals.rows_changed > limits.maximum_rows) over = true;
    if (objectsOk && totals.objects_changed > limits.maximum_objects) over = true;
    if (amountsOk) {
      const ceiling = limits.maximum_accounting_amount;
      for (const [currency, amount] of Object.entries(totals.accounting_amount_changed_by_currency)) {
        if (ceiling.currency === 'not_applicable' || currency !== ceiling.currency) {
          if (compareDecimalStrings(amount, '0') !== 0) over = true;
        } else {
          const magnitude = amount.startsWith('-') ? amount.slice(1) : amount;
          if (compareDecimalStrings(magnitude, ceiling.amount) > 0) over = true;
        }
      }
    }
    if (over) v.fail(withinPath, 'forbidden_value');
  }
}

function validateCompletion(v, completion, path, receipt, manifest, derived) {
  if (!v.object(completion, path, [
    'status', 'required_target_equation', 'equation_balances', 'all_required_postconditions_passed', 'rollback_status',
    'remaining_follow_up'
  ])) return;
  const statusOk = v.enumeration(completion.status, v.join(path, 'status'), COMPLETION_STATUSES);

  const equationPath = v.join(path, 'required_target_equation');
  if (v.object(completion.required_target_equation, equationPath, EQUATION_FIELDS)) {
    for (const field of EQUATION_FIELDS) {
      const fieldPath = v.join(equationPath, field);
      if (v.integer(completion.required_target_equation[field], fieldPath)
        && completion.required_target_equation[field] !== derived[field]) {
        v.fail(fieldPath, 'completion_equation_unbalanced');
      }
    }
  }

  const derivedBalances = derived.required_declared === derived.verified_changed + derived.verified_already_satisfied
    + derived.permitted_held_or_limited && derived.unresolved === 0;
  if (v.boolean(completion.equation_balances, v.join(path, 'equation_balances'))
    && completion.equation_balances !== derivedBalances) {
    v.fail(v.join(path, 'equation_balances'), 'completion_equation_unbalanced');
  }
  if (v.boolean(completion.all_required_postconditions_passed, v.join(path, 'all_required_postconditions_passed'))
    && completion.all_required_postconditions_passed !== derived.all_required_postconditions_passed) {
    v.fail(v.join(path, 'all_required_postconditions_passed'), 'completion_equation_unbalanced');
  }
  const rollbackOk = v.enumeration(completion.rollback_status, v.join(path, 'rollback_status'), ROLLBACK_STATUSES);

  const followUpPath = v.join(path, 'remaining_follow_up');
  if (v.array(completion.remaining_follow_up, followUpPath)) {
    const seen = new Set();
    completion.remaining_follow_up.forEach((code, i) => {
      if (v.enumeration(code, v.index(followUpPath, i), FOLLOW_UP_CODES)) {
        if (seen.has(code)) v.fail(v.index(followUpPath, i), 'duplicate_identifier');
        seen.add(code);
      }
    });
  }

  if (!statusOk) return;
  if (completion.status === 'completed') {
    // §7.3: completed requires the claimed equation to balance AND the results to support it.
    const claimed = completionEquation(receipt);
    if (!claimed.balances || !derivedBalances || !derived.all_required_postconditions_passed
      || derived.declared_targets !== derived.result_targets) {
      v.fail(v.join(path, 'status'), 'completion_equation_unbalanced');
    }
    if (rollbackOk && completion.rollback_status !== 'not_required') v.fail(v.join(path, 'rollback_status'), 'forbidden_value');
    if (manifest.operation_class === 'LIVE_ERASURE' && !erasureBalance(receipt, manifest).balances) {
      v.fail(v.join(path, 'status'), 'erasure_balance_open');
    }
  } else if (completion.status === 'rolled_back') {
    if (rollbackOk && completion.rollback_status !== 'completed') v.fail(v.join(path, 'rollback_status'), 'forbidden_value');
  }
}

// ---------------------------------------------------------------------------
// validateLiveRepairReceipt
// ---------------------------------------------------------------------------

export function validateLiveRepairReceipt(receipt, manifest) {
  const manifestResult = validateLiveRepairManifest(manifest);
  if (!manifestResult.ok) {
    return { ok: false, errors: manifestResult.errors.map(({ path, code }) => ({ path: path ? `manifest.${path}` : 'manifest', code })) };
  }

  const v = createValidator();
  if (!isPlainObject(receipt)) {
    v.fail('', 'wrong_type');
    return v.result();
  }
  for (const key of Object.keys(receipt)) if (!RECEIPT_FIELDS.includes(key)) v.fail(key, 'unknown_field');
  for (const key of RECEIPT_FIELDS) if (receipt[key] === undefined) v.fail(key, 'missing_field');

  v.enumeration(receipt.schema_version, 'schema_version', RECEIPT_SCHEMA_VERSIONS);
  v.string(receipt.receipt_id, 'receipt_id');
  if (v.string(receipt.operation_id, 'operation_id') && receipt.operation_id !== manifest.operation_id) v.fail('operation_id', 'manifest_mismatch');
  if (v.enumeration(receipt.operation_class, 'operation_class', OPERATION_CLASSES) && receipt.operation_class !== manifest.operation_class) {
    v.fail('operation_class', 'manifest_mismatch');
  }
  if (v.hexDigest(receipt.manifest_digest, 'manifest_digest') && receipt.manifest_digest !== manifest.manifest_digest) {
    v.fail('manifest_digest', 'manifest_mismatch');
  }

  const status = isPlainObject(receipt.completion) && typeof receipt.completion.status === 'string' ? receipt.completion.status : undefined;
  validateAuthorization(v, receipt.authorization, 'authorization', manifest);
  validateExecution(v, receipt.execution, 'execution', manifest, status);

  // Authorization precedes execution; execution precedes expiry (unless the runner refused).
  if (isPlainObject(receipt.authorization) && isPlainObject(receipt.execution)) {
    const authorizedAt = Date.parse(receipt.authorization.authorized_at);
    const startedAt = Date.parse(receipt.execution.started_at);
    if (!Number.isNaN(authorizedAt) && !Number.isNaN(startedAt)) {
      if (startedAt < authorizedAt) v.fail('execution.started_at', 'value_out_of_bounds');
      if (status !== 'refused' && startedAt > Date.parse(manifest.expires_at)) v.fail('execution.started_at', 'value_out_of_bounds');
    }
  }

  const targetsById = new Map(manifest.targets.map((target) => [target.target_id, target]));
  const frozenPairs = frozenCopySet(manifest);
  if (v.array(receipt.results, 'results', { nonEmpty: true })) {
    v.ordinals(receipt.results, 'results');
    const firstSeen = new Set();
    const seenAttempts = new Set();
    receipt.results.forEach((result, i) => validateResult(v, result, v.index('results', i), manifest, targetsById, frozenPairs, firstSeen, seenAttempts));
    // Every declared target has a result (§7.3: "Each target has one result even when no change was needed").
    const covered = new Set(receipt.results.filter(isPlainObject).map((result) => result.target_id));
    manifest.targets.forEach((target, i) => {
      if (!covered.has(target.target_id)) v.fail(v.index('targets', i), 'missing_result');
    });
  }

  const derived = deriveCompletion(receipt, manifest);
  validateTotals(v, receipt.totals, 'totals', manifest, derived);
  validateCompletion(v, receipt.completion, 'completion', receipt, manifest, derived);

  if (receipt.receipt_digest !== undefined) {
    if (v.hexDigest(receipt.receipt_digest, 'receipt_digest') && receipt.receipt_digest !== receiptDigest(receipt)) {
      v.fail('receipt_digest', 'digest_mismatch');
    }
  }
  return v.result();
}
