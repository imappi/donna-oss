import { createHash } from 'node:crypto';

import { validateCausalWorld } from './worldValidity.js';

export const SHRINKER_VERSION = 'proof0.shrinker.v1';

const SHRINKABLE_COLLECTIONS = Object.freeze(['observations', 'events', 'artifacts', 'hiddenFacts', 'entities']);

/**
 * Deterministically removes world records while preserving the externally
 * scored failure receipt. The predicate is run twice before a reduction is
 * accepted: disagreement is quarantined rather than promoted as a fixture.
 */
export async function shrinkFailingWorld({ worldSpec, failureReceipt, evaluateFailure, validateCandidate = validateCausalWorld, maxEvaluations = 1_000 } = {}) {
  const inputErrors = validateInputs({ worldSpec, failureReceipt, evaluateFailure, validateCandidate, maxEvaluations });
  if (inputErrors.length > 0) return result({ errors: inputErrors });

  const initialValidity = safelyValidate(validateCandidate, worldSpec);
  if (!initialValidity.ok) return result({ errors: initialValidity.errors.map((error) => `worldSpec.${error}`) });

  const target = failureSignature(failureReceipt);
  let current = clone(worldSpec);
  let evaluations = 0;
  const removed = [];
  const quarantine = [];

  for (const collection of SHRINKABLE_COLLECTIONS) {
    for (const item of [...current[collection]]) {
      if (evaluations + 2 > maxEvaluations) {
        return result({ world: current, target, evaluations, removed, quarantine, exhausted: true });
      }
      const candidate = removeAndPrune(current, collection, item.id);
      const validity = safelyValidate(validateCandidate, candidate);
      if (!validity.ok) continue;

      const first = await safelyEvaluate(evaluateFailure, candidate);
      const second = await safelyEvaluate(evaluateFailure, candidate);
      evaluations += 2;
      if (!first.ok || !second.ok) {
        quarantine.push({ collection, id: item.id, reason: 'predicate_error', errors: [...first.errors, ...second.errors] });
        continue;
      }
      const firstSignature = failureSignature(first.receipt);
      const secondSignature = failureSignature(second.receipt);
      if (firstSignature !== secondSignature) {
        quarantine.push({ collection, id: item.id, reason: 'predicate_nondeterministic', observedSignatures: [firstSignature, secondSignature] });
        continue;
      }
      if (firstSignature === target) {
        current = candidate;
        removed.push({ collection, id: item.id });
      }
    }
  }

  return result({ world: current, target, evaluations, removed, quarantine });
}

function validateInputs({ worldSpec, failureReceipt, evaluateFailure, validateCandidate, maxEvaluations }) {
  const errors = [];
  if (!isObject(worldSpec)) errors.push('worldSpec must be an object');
  if (!isObject(failureReceipt)) errors.push('failureReceipt must be an object');
  if (typeof evaluateFailure !== 'function') errors.push('evaluateFailure must be a function');
  if (typeof validateCandidate !== 'function') errors.push('validateCandidate must be a function');
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 2) errors.push('maxEvaluations must be a safe integer of at least 2');
  if (isObject(failureReceipt) && failureSignature(failureReceipt) === null) errors.push('failureReceipt must name failureClass, earliestObservableDivergence, and consequence');
  return errors;
}

function removeAndPrune(world, collection, id) {
  const candidate = clone(world);
  candidate[collection] = candidate[collection].filter((item) => item.id !== id);

  // Removing a causal event also removes its descendants and observations.
  let changed = true;
  while (changed) {
    const eventIds = new Set(candidate.events.map((event) => event.id));
    const before = candidate.events.length;
    candidate.events = candidate.events.filter((event) => (event.causalParents ?? []).every((parentId) => eventIds.has(parentId)));
    changed = candidate.events.length !== before;
  }
  const eventIds = new Set(candidate.events.map((event) => event.id));
  const artifactIds = new Set(candidate.artifacts.map((artifact) => artifact.id));
  const factIds = new Set(candidate.hiddenFacts.map((fact) => fact.id));
  candidate.observations = candidate.observations.filter((observation) =>
    (observation.eventId === undefined || eventIds.has(observation.eventId)) &&
    (observation.artifactId === undefined || artifactIds.has(observation.artifactId)) &&
    (observation.hiddenFactRefs ?? []).every((factId) => factIds.has(factId)));
  return candidate;
}

function failureSignature(receipt) {
  if (!isObject(receipt) || typeof receipt.failureClass !== 'string' || !isObject(receipt.earliestObservableDivergence) || !isObject(receipt.consequence)) return null;
  return stableJson({ failureClass: receipt.failureClass, earliestObservableDivergence: receipt.earliestObservableDivergence, consequence: receipt.consequence });
}

async function safelyEvaluate(predicate, candidate) {
  try {
    const value = await predicate(clone(candidate));
    const receipt = value?.receipt ?? value?.failureReceipt ?? value;
    return { ok: isObject(receipt), receipt, errors: isObject(receipt) ? [] : ['predicate did not return a failure receipt'] };
  } catch (error) {
    return { ok: false, receipt: null, errors: [`predicate threw: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function safelyValidate(validator, candidate) {
  try {
    const value = validator(candidate);
    return value?.ok === true ? { ok: true, errors: [] } : { ok: false, errors: Array.isArray(value?.errors) ? value.errors : ['validator refused candidate'] };
  } catch (error) {
    return { ok: false, errors: [`validator threw: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function result({ world = null, target = null, evaluations = 0, removed = [], quarantine = [], errors = [], exhausted = false }) {
  return { ok: errors.length === 0, version: SHRINKER_VERSION, world, digest: world ? createHash('sha256').update(stableJson(world)).digest('hex') : null, targetSignature: target, evaluations, removed, quarantine, exhausted, errors };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function clone(value) {
  return structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
