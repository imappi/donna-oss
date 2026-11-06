import { validateCausalWorld } from './worldValidity.js';

export const SIBLING_WORLD_VERSION = 'proof0.siblingWorld.v1';

/**
 * Derive the hidden causal sibling by applying only the counterfactual
 * replacement declared on the source world. No seed, clock, model, or caller
 * supplied mutation participates in derivation.
 */
export function deriveSiblingWorld(worldSpec) {
  const errors = validateDerivationInput(worldSpec);
  if (errors.length > 0) return siblingResult({ errors });

  const mutation = worldSpec.counterfactualMutation;
  const sibling = structuredClone(worldSpec);
  const factIndex = sibling.hiddenFacts.findIndex(({ id }) => id === mutation.declaredFactId);
  sibling.hiddenFacts[factIndex] = {
    ...sibling.hiddenFacts[factIndex],
    ...structuredClone(mutation.replacement),
  };
  sibling.worldId = `${worldSpec.worldId}::sibling::${mutation.id}`;

  const validity = validateCausalWorld(sibling);
  if (!validity.ok) {
    return siblingResult({
      errors: validity.errors.map((error) => `derivedWorld.${error}`),
      sourceWorldId: worldSpec.worldId,
      mutationId: mutation.id,
    });
  }

  return siblingResult({
    world: sibling,
    sourceWorldId: worldSpec.worldId,
    mutationId: mutation.id,
    declaredFactId: mutation.declaredFactId,
  });
}

function validateDerivationInput(worldSpec) {
  const validity = validateCausalWorld(worldSpec);
  if (!validity.ok) return validity.errors.map((error) => `sourceWorld.${error}`);

  const errors = [];
  const mutation = worldSpec.counterfactualMutation;
  if (!isPlainObject(mutation)) {
    return ['counterfactualMutation must be a declared object'];
  }
  if (!isNonEmptyString(mutation.id)) {
    errors.push('counterfactualMutation.id must be a non-empty string');
  }
  if (!isNonEmptyString(mutation.declaredFactId)) {
    errors.push('counterfactualMutation.declaredFactId must be a non-empty string');
  }
  if (!Array.isArray(mutation.changedFactIds) || mutation.changedFactIds.length !== 1 || mutation.changedFactIds[0] !== mutation.declaredFactId) {
    errors.push('counterfactualMutation.changedFactIds must contain exactly the declaredFactId');
  }
  if (!isPlainObject(mutation.replacement) || Object.keys(mutation.replacement).length === 0) {
    errors.push('counterfactualMutation.replacement must be a non-empty object');
  } else if (Object.hasOwn(mutation.replacement, 'id')) {
    errors.push('counterfactualMutation.replacement must not change the declared fact id');
  }

  const matchingFacts = worldSpec.hiddenFacts.filter((fact) => isPlainObject(fact) && fact.id === mutation.declaredFactId);
  if (matchingFacts.length !== 1) {
    errors.push('counterfactualMutation.declaredFactId must identify exactly one hidden fact');
  }

  if (isPlainObject(mutation.expectedTreatmentChange) && matchingFacts.length === 1 && isPlainObject(mutation.replacement)) {
    const { from, to } = mutation.expectedTreatmentChange;
    if (from !== matchingFacts[0].expectedTreatment) {
      errors.push('counterfactualMutation.expectedTreatmentChange.from must match the source fact treatment');
    }
    if (to !== mutation.replacement.expectedTreatment) {
      errors.push('counterfactualMutation.expectedTreatmentChange.to must match the replacement treatment');
    }
    if (from === to) {
      errors.push('counterfactualMutation must declare a treatment-changing replacement');
    }
  }

  return errors;
}

function siblingResult({ world = null, sourceWorldId = null, mutationId = null, declaredFactId = null, errors = [] }) {
  return {
    ok: errors.length === 0,
    version: SIBLING_WORLD_VERSION,
    world,
    sourceWorldId,
    mutationId,
    declaredFactId,
    errors,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}
