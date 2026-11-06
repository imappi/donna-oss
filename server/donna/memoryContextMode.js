// Donna — BizOS Slice 2c-iii (sub-PR 4): the memory-context MODE resolver +
// the SECURITY-SUSPENSION control (§G / §N-A, amendments 3 + 10).
//
// "Fail closed" and "roll back" are DIFFERENT emergencies and must be different
// controls:
//
//   MEMORY_CONTEXT_SECURITY_SUSPEND  → no v2 AND no legacy memory (controlled
//                                      no-memory). "Memory access may be unsafe —
//                                      use NEITHER path." Falling back to the
//                                      less-governed legacy paste during an ACL /
//                                      cross-client / integrity incident is exactly
//                                      the wrong response.
//   CLIENT_CONFIG_FORCE_DISABLE      → legacy memory (operational rollback). "v2
//                                      has an operational problem — deliberately
//                                      restore legacy." (Handled by clientFlagActs
//                                      returning false → the seam's legacy branch.)
//   per-client stage                 → off / shadow / canary.
//
// Strict precedence: suspension  →  force-disable  →  per-client stage.
//
// The suspension control is KILL-CLASS: env may KILL a behaviour (never silently
// ENABLE one) — and suspension WITHHOLDS memory, so an env kill is legitimate for
// incident speed (config-plane rail). It is fleet-wide, born false, and AUDITED:
// the seam writes one `memory_context.security_suspended` audit row per withheld
// turn (`buildSecuritySuspensionAuditEvent`) so the incident has a trail.
//
// Pure leaf: no DB, no model. The seam (sub-PR 7) calls `resolveMemoryMode` once,
// into the immutable request snapshot — so a mid-request flip never mixes modes.

import { memoryRetrievalV2Acts } from './memoryRetrieval.js';

export const MEMORY_CONTEXT_SECURITY_SUSPEND_KEY = 'MEMORY_CONTEXT_SECURITY_SUSPEND';

// The three resolved modes the seam acts on.
export const MEMORY_MODES = Object.freeze(['suspended', 'v2', 'legacy']);

const ENV_TRUTHY = Object.freeze(new Set(['1', 'true', 'on', 'yes', 'all']));

// The env kill (big red button) — fleet-wide, incident-speed. Born false: an unset
// / empty / falsey value never suspends.
export const securitySuspendedByEnv = (env = process.env) =>
  ENV_TRUTHY.has(String(env?.[MEMORY_CONTEXT_SECURITY_SUSPEND_KEY] ?? '').trim().toLowerCase());

// Suspended iff the env kill is on OR a config-plane row for the suspend key is at
// any non-`off` stage (per-firm targeted suspension, durable + audited via the
// config writer). A missing row / `off` stage / empty config never suspends
// (invariant #3 — empty config never broadens; here it never withholds either).
export const securitySuspended = ({ configSnapshot = null, env = process.env } = {}) => {
  if (securitySuspendedByEnv(env)) return true;
  const row = configSnapshot && typeof configSnapshot === 'object'
    ? configSnapshot[MEMORY_CONTEXT_SECURITY_SUSPEND_KEY] : null;
  return !!(row && typeof row === 'object' && row.stage && row.stage !== 'off');
};

// resolveMemoryMode({ configSnapshot, env }) → 'suspended' | 'v2' | 'legacy'
//
// The single §D `mode = resolveMemoryMode(snapshot.config)`, with the §G
// precedence baked in:
//   1. suspension wins over everything → 'suspended' (neither v2 nor legacy).
//   2. else the acting dual decides: canary/auto (never auto yet, §M) → 'v2'.
//   3. else (off / shadow / dry_run / force-disabled) → 'legacy'.
// Because memoryRetrievalV2Acts already returns false under force-disable and any
// non-acting stage, force-disable collapses to 'legacy' here — the operational
// rollback — exactly as §G requires.
export const resolveMemoryMode = ({ configSnapshot = null, env = process.env } = {}) => {
  if (securitySuspended({ configSnapshot, env })) return 'suspended';
  if (memoryRetrievalV2Acts({ snapshot: configSnapshot, env })) return 'v2';
  return 'legacy';
};

// The audit row the seam writes for a withheld (suspended) turn. Shaped to the
// audit_events insert (firm_id, client_id, actor_type, action, resource_type,
// resource_id, metadata). `withheld: ['v2','legacy']` records that BOTH paths were
// deliberately withheld — the controlled no-memory response, not a legacy fallback.
export const buildSecuritySuspensionAuditEvent = ({
  firmId = null, clientId = null, source = 'env', retrievalId = null, purposeId = null
} = {}) => ({
  firm_id: firmId,
  client_id: clientId,
  actor_type: 'system',
  action: 'memory_context.security_suspended',
  resource_type: 'memory_context',
  resource_id: MEMORY_CONTEXT_SECURITY_SUSPEND_KEY,
  metadata: {
    source,
    retrieval_id: retrievalId,
    purpose_id: purposeId,
    withheld: ['v2', 'legacy']
  }
});
