// DMEM-R1 MX-1 — the LIVE_ERASURE result extension and the erasure balance.
//
// docs/design-donna-memory-remediation.md §7.4 (the per-pair erasure result) read with §6
// (the frozen copy set; `erasure_pending` until every required target has a permitted
// terminal result) and §7.3 (`permitted_held_or_limited` never means erased; every
// limitation is disclosed separately).
//
// Pure leaf. The balance is computed over the FROZEN copy_class_id × target_id set the
// MANIFEST declares — never over whatever results the runner happened to produce. The
// copy-class registry that would prove a `copy_class_id` is registered is W5's file and
// does not exist here; this module checks the pair against the manifest, not the registry.

import { isPlainObject, isInteger, isInstant } from './manifestContract.js';

export const ERASURE_DISPOSITIONS = Object.freeze([
  'erased',
  'content_free_proof_retained',
  'held',
  'externally_limited',
  'failed',
  'indeterminate'
]);

export const ERASURE_MECHANISMS = Object.freeze([
  'delete', 'redact', 'rekey', 'destroy_key', 'revoke', 'expire', 'provider_request'
]);

// The closed hold / limitation codes a registered copy-class policy may name (§7.3: a
// permitted hold or external limitation is only ever one the policy explicitly allows).
export const HOLD_OR_LIMITATION_CODES = Object.freeze([
  'legal_hold',
  'regulatory_retention',
  'backup_immutable_window',
  'provider_cannot_delete',
  'provider_request_pending',
  'in_flight_fenced'
]);

export const ERASURE_DISPOSITION_SUMMARIES = Object.freeze([
  'erased',
  'erased_with_disclosed_limitations',
  'erasure_pending'
]);

const PERMITTED_TERMINAL = new Set(['erased', 'content_free_proof_retained']);
const LIMITED = new Set(['held', 'externally_limited']);

const ERASURE_RESULT_FIELDS = Object.freeze([
  'copy_class_id', 'target_id', 'required_for_completion', 'disposition', 'mechanism', 'verification_digest',
  'retention_expiry', 'hold_or_limitation_code', 'resurrection_fence_verified', 'restore_reapplication_verified'
]);

// The frozen copy set: one pair per manifest target carrying a copy_class_id, in manifest order.
export function frozenCopySet(manifest) {
  const targets = Array.isArray(manifest?.targets) ? manifest.targets : [];
  const pairs = [];
  for (const target of targets) {
    if (!isPlainObject(target) || typeof target.copy_class_id !== 'string' || typeof target.target_id !== 'string') continue;
    pairs.push({
      copy_class_id: target.copy_class_id,
      target_id: target.target_id,
      required_for_completion: target.required_for_completion === true
    });
  }
  return pairs;
}

// A pair's result is PERMITTED terminal when it is erased / proof-retained, or held /
// externally limited under a closed limitation code. `permitted` never means erased.
export function classifyErasureDisposition(erasureResult) {
  if (!isPlainObject(erasureResult)) return { disposition: null, permitted: false, limited: false };
  const disposition = typeof erasureResult.disposition === 'string' ? erasureResult.disposition : null;
  if (PERMITTED_TERMINAL.has(disposition)) return { disposition, permitted: true, limited: false };
  if (LIMITED.has(disposition) && typeof erasureResult.hold_or_limitation_code === 'string'
    && HOLD_OR_LIMITATION_CODES.includes(erasureResult.hold_or_limitation_code)) {
    return { disposition, permitted: true, limited: true };
  }
  return { disposition, permitted: false, limited: LIMITED.has(disposition) };
}

// Latest result (highest ordinal, then array order) whose erasure_result names the pair.
function latestResultForPair(results, pair) {
  let latest = null;
  let latestOrdinal = -Infinity;
  results.forEach((result, position) => {
    const extension = isPlainObject(result) ? result.erasure_result : undefined;
    if (!isPlainObject(extension)) return;
    if (extension.copy_class_id !== pair.copy_class_id || extension.target_id !== pair.target_id) return;
    const ordinal = isInteger(result.ordinal) ? result.ordinal : position + 1;
    if (ordinal >= latestOrdinal) {
      latest = result;
      latestOrdinal = ordinal;
    }
  });
  return latest;
}

// §7.4: the erasure balance over the frozen copy set.
//   frozen_pairs = erased + content_free_proof_retained + permitted_held_or_limited
//                + not_permitted (failed | indeterminate | limited-without-code) + missing
//   balances ⇔ missing = 0 ∧ unresolved (required pairs without a permitted result) = 0
// A non-required pair without a permitted result is disclosed (not_required_unresolved), not blocking;
// a MISSING result on any frozen pair keeps the balance open — the runner must report every pair.
export function erasureBalance(receipt, manifest) {
  const frozen = frozenCopySet(manifest);
  const results = Array.isArray(receipt?.results) ? receipt.results : [];
  const counts = {
    erased: 0,
    content_free_proof_retained: 0,
    permitted_held_or_limited: 0,
    failed: 0,
    indeterminate: 0,
    not_permitted_held_or_limited: 0,
    missing: 0,
    unresolved: 0,
    not_required_unresolved: 0
  };
  const pairs = [];
  const limitations = [];
  for (const pair of frozen) {
    const result = latestResultForPair(results, pair);
    const extension = result ? result.erasure_result : null;
    const { disposition, permitted, limited } = classifyErasureDisposition(extension);
    if (!result) counts.missing += 1;
    else if (disposition === 'erased') counts.erased += 1;
    else if (disposition === 'content_free_proof_retained') counts.content_free_proof_retained += 1;
    else if (permitted && limited) counts.permitted_held_or_limited += 1;
    else if (disposition === 'failed') counts.failed += 1;
    else if (disposition === 'indeterminate') counts.indeterminate += 1;
    else counts.not_permitted_held_or_limited += 1;
    if (!permitted) {
      if (pair.required_for_completion) counts.unresolved += 1;
      else if (result) counts.not_required_unresolved += 1;
    }
    if (permitted && limited) {
      limitations.push({
        copy_class_id: pair.copy_class_id,
        target_id: pair.target_id,
        disposition,
        hold_or_limitation_code: extension.hold_or_limitation_code
      });
    }
    pairs.push({
      copy_class_id: pair.copy_class_id,
      target_id: pair.target_id,
      required_for_completion: pair.required_for_completion,
      disposition,
      mechanism: extension && typeof extension.mechanism === 'string' ? extension.mechanism : null,
      hold_or_limitation_code: extension && typeof extension.hold_or_limitation_code === 'string' ? extension.hold_or_limitation_code : null,
      permitted,
      result_ordinal: result && isInteger(result.ordinal) ? result.ordinal : null
    });
  }
  // Nothing is proven erased over an empty frozen set: a manifest that froze no copy class
  // cannot balance, however few results the runner produced.
  const balances = frozen.length > 0 && counts.missing === 0 && counts.unresolved === 0;
  const disposition_summary = !balances
    ? 'erasure_pending'
    : counts.permitted_held_or_limited > 0 ? 'erased_with_disclosed_limitations' : 'erased';
  return {
    frozen_pairs: frozen.length,
    ...counts,
    balances,
    disposition_summary,
    limitations,
    pairs
  };
}

// Field-level validation of one result's erasure_result against its frozen target. Called by
// the receipt validator; `target` is the manifest target the result names (or undefined).
export function validateErasureResult(v, erasureResult, path, target, frozenPairs, resultTargetId) {
  if (!v.object(erasureResult, path, ERASURE_RESULT_FIELDS)) return;
  const copyClassOk = v.string(erasureResult.copy_class_id, v.join(path, 'copy_class_id'));
  const targetIdOk = v.string(erasureResult.target_id, v.join(path, 'target_id'));
  if (targetIdOk && resultTargetId !== undefined && erasureResult.target_id !== resultTargetId) {
    v.fail(v.join(path, 'target_id'), 'forbidden_value');
  }
  if (copyClassOk && targetIdOk) {
    const inFrozenSet = frozenPairs.some(
      (pair) => pair.copy_class_id === erasureResult.copy_class_id && pair.target_id === erasureResult.target_id
    );
    if (!inFrozenSet) v.fail(v.join(path, 'copy_class_id'), 'undeclared_target');
  }
  if (v.boolean(erasureResult.required_for_completion, v.join(path, 'required_for_completion')) && target
    && erasureResult.required_for_completion !== target.required_for_completion) {
    v.fail(v.join(path, 'required_for_completion'), 'manifest_mismatch');
  }
  const dispositionOk = v.enumeration(erasureResult.disposition, v.join(path, 'disposition'), ERASURE_DISPOSITIONS);
  v.enumeration(erasureResult.mechanism, v.join(path, 'mechanism'), ERASURE_MECHANISMS);
  v.hexDigest(erasureResult.verification_digest, v.join(path, 'verification_digest'));
  const expiryPath = v.join(path, 'retention_expiry');
  if (v.present(erasureResult.retention_expiry, expiryPath) && erasureResult.retention_expiry !== 'not_applicable'
    && !isInstant(erasureResult.retention_expiry)) {
    v.fail(expiryPath, 'invalid_instant');
  }
  const codePath = v.join(path, 'hold_or_limitation_code');
  const code = erasureResult.hold_or_limitation_code;
  if (v.present(code, codePath) && code !== null) {
    if (typeof code !== 'string') v.fail(codePath, 'wrong_type');
    else if (!HOLD_OR_LIMITATION_CODES.includes(code)) v.fail(codePath, 'unknown_enum_value');
    else if (dispositionOk && !LIMITED.has(erasureResult.disposition)) v.fail(codePath, 'forbidden_value');
  }
  v.boolean(erasureResult.resurrection_fence_verified, v.join(path, 'resurrection_fence_verified'));
  v.boolean(erasureResult.restore_reapplication_verified, v.join(path, 'restore_reapplication_verified'));
}
