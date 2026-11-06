// The per-capability model-qualification table (technical plan §7, v2.1
// "task-level model routing"). Qualification is per CAPABILITY, not per
// app: each load-bearing task maps to its qualified backends; unqualified
// backends are usable only for experimental, non-load-bearing work. This
// module is the SCHEMA plus the current static policy — the signed,
// versioned, rollback-protected model-policy FEED (tether, M2) delivers
// future values of exactly this shape; nothing else in the runtime should
// invent its own routing source.
//
// Encoded law, not configuration:
//   - ledger_commit is NOT a routable capability. Commit routes to the
//     deterministic kernel; a policy that tries to declare backends for it
//     is invalid, whoever signed it.
//   - In the 'bridge' state every capability must have at least one
//     qualified CLOUD backend — a keyless install exists only at
//     'sovereign' (a first-run powered by an unqualified local model is a
//     broken product).
//   - A backend becomes qualified for a capability ONLY through the
//     graduation bar (graduationBar.js) — never sizing folklore.

import {
  GRADUATION_CAPABILITIES, LEDGER_COMMIT_CAPABILITY, MODEL_STATES
} from './graduationBar.js';

export const MODEL_POLICY_FORMAT = 'donna-model-policy/1';

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai']);
const KNOWN_PROVIDERS = new Set([...CLOUD_PROVIDERS, 'local_openai_compatible']);

export const validateModelPolicy = (policy) => {
  if (!policy || policy.format !== MODEL_POLICY_FORMAT) {
    throw new Error(`Model policy must declare format ${MODEL_POLICY_FORMAT}.`);
  }
  if (!MODEL_STATES.includes(policy.state)) {
    throw new Error(`Model policy state must be one of ${MODEL_STATES.join('/')}, got "${policy.state}".`);
  }
  if (!policy.as_of) throw new Error('Model policy needs an as_of date.');
  const capabilities = policy.capabilities || {};

  if (LEDGER_COMMIT_CAPABILITY in capabilities) {
    throw new Error('ledger_commit routes to the deterministic kernel — it must not appear in a model policy.');
  }
  for (const name of Object.keys(capabilities)) {
    if (!GRADUATION_CAPABILITIES.includes(name)) {
      throw new Error(`Unknown capability in model policy: ${name}`);
    }
  }
  for (const name of GRADUATION_CAPABILITIES) {
    const row = capabilities[name];
    if (!row) throw new Error(`Model policy is missing capability: ${name}`);
    for (const backend of [...(row.qualified || []), ...(row.experimental || [])]) {
      if (!backend?.provider || !KNOWN_PROVIDERS.has(backend.provider)) {
        throw new Error(`Capability ${name}: unknown provider "${backend?.provider}".`);
      }
    }
    if (policy.state === 'bridge') {
      const hasQualifiedCloud = (row.qualified || []).some((b) => CLOUD_PROVIDERS.has(b.provider));
      if (!hasQualifiedCloud) {
        throw new Error(
          `Capability ${name}: the bridge state requires at least one qualified cloud backend.`
        );
      }
    }
  }
  return true;
};

export const resolveQualifiedBackends = (policy, capability) => {
  if (capability === LEDGER_COMMIT_CAPABILITY) {
    throw new Error('ledger_commit is deterministic-kernel-only; there are no backends to resolve.');
  }
  validateModelPolicy(policy);
  const row = policy.capabilities[capability];
  if (!row) throw new Error(`Unknown capability: ${capability}`);
  return row.qualified || [];
};

// The current policy: Bridge. Provider-level in v0 — model-id pinning (and
// deprecation dates, minimum runtime version) arrives with the signed feed;
// today the concrete model ids stay where they already live, in the
// per-module env-driven defaults the receipts record. The local slot exists
// on every capability as EXPERIMENTAL only: usable for shadow evaluation
// (plan §7 v2.1), never for load-bearing calls, until the graduation bar
// says otherwise.
const bridgeRow = () => ({
  qualified: [{ provider: 'anthropic' }, { provider: 'openai' }],
  experimental: [{ provider: 'local_openai_compatible' }]
});

export const CURRENT_MODEL_POLICY = Object.freeze({
  format: MODEL_POLICY_FORMAT,
  state: 'bridge',
  as_of: '2026-08-03',
  source: 'static-v0 (pre-tether); the signed feed replaces this value, not this shape',
  capabilities: Object.freeze(
    Object.fromEntries(GRADUATION_CAPABILITIES.map((name) => [name, bridgeRow()]))
  )
});
