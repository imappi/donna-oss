// Payout / deposit-slip reconciliation — the family WRAPPER (RT-18). Owns
// what the LLM orchestrator (payoutReconciliationLlm.js) may not: the
// PAYOUT_MATCHER_ENABLED gate, the per-run model-lane policy read and the
// reverse-shadow challenger hook (both need firmDb access, and the Llm
// module stays writer-free so the challenger registry can import its prompt
// builders). Same shape as paymentConfirmationReconciliation.js minus the
// weighted fallback: the family was born on the strong path, so there is no
// scorer to fall back to — a self-disabled matcher (no key) returns its
// DISABLED stats and the statement-side orchestrator logs the suppression;
// an infrastructure throw propagates to the caller's per-document
// try/catch (counted, never silent).
//
// The gate is the existing `*_MATCHER_ENABLED` desktop-default pattern
// (hostRuntimeDefaults.js supplies 'true' at appliance boot; env stays the
// kill switch; cloud default off) — not a new plane flag: this is the same
// wave every sibling matcher rides.

import { withFirmDbClient } from './firmDb.js';
import { readLaneDecidingPolicy } from './modelLanePolicy.js';
import {
  RECONCILIATION_REASONING_LANE,
  makeReconciliationReasoningChallengerHook
} from './reconciliationReasoningChallenger.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { ZERO_STATS, DISABLED_STATS } from './reconciliationLlmCore.js';
import { runPayoutReconciliationLlmForDocument } from './payoutReconciliationLlm.js';
// The provider-failure contract (2026-09-13, reconciliationProviderFailure.js):
// a typed provider failure from the LLM matcher — a missing/rejected key, a
// rate limit, an outage, a reset socket, a hung request, an unreadable body —
// is receipted on the document and re-driven by the convergence clock. It
// NEVER enters the weighted body below: the weighted matcher is a heuristic
// replacement decision, and a provider failure is not a matching judgment.
import {
  clearReconciliationProviderFailureWithClient,
  isProviderFailure,
  providerFailureFromDisabledStats,
  providerFailureStats
} from './reconciliationProviderFailure.js';

export const PAYOUT_MATCHER_FLAG = 'PAYOUT_MATCHER_ENABLED';

const FLAG_ENABLED = () => {
  const raw = process?.env?.[PAYOUT_MATCHER_FLAG];
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

export const runPayoutReconciliationForDocument = async ({
  client,
  firmId,
  clientId,
  documentId
} = {}) => {
  if (!FLAG_ENABLED()) return DISABLED_STATS(`${PAYOUT_MATCHER_FLAG} not enabled`);
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();

  let decidingPolicy = null;
  try {
    decidingPolicy = await readLaneDecidingPolicy({
      client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE
    });
  } catch { decidingPolicy = null; } // missing table => no policy, byte-identical
  const policyModel = typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  const policyActive = Boolean(policyModel) && !policyModel.startsWith('claude');
  let challengerHook = null;
  if (policyActive) {
    const challengerSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    challengerHook = makeReconciliationReasoningChallengerHook({
      family: 'payout_statement',
      firmId,
      clientId,
      snapshot: challengerSnapshot,
      withClient: withFirmDbClient
    });
  }

  let stats;
  try {
    stats = await runPayoutReconciliationLlmForDocument({
      client,
      firmId,
      clientId,
      documentId,
      decidingPolicy,
      challengerHook
    });
  } catch (error) {
    // A typed provider failure is a TRANSPORT fact: receipted on the document
    // and re-driven by the convergence clock (reconciliationProviderFailure.js);
    // never a verdict. Anything else fails loud, as before.
    if (isProviderFailure(error)) {
      return providerFailureStats({ client, firmId, clientId, documentId, family: 'payout_statement', failure: error, logTag: 'payoutReconciliation', zeroStats: ZERO_STATS });
    }
    throw error;
  }
  const keyMissing = providerFailureFromDisabledStats(stats);
  if (keyMissing) {
    // No Anthropic key: a provisioning gap on the OPERATOR — receipted, re-driven once a key exists.
    return providerFailureStats({ client, firmId, clientId, documentId, family: 'payout_statement', failure: keyMissing, logTag: 'payoutReconciliation', zeroStats: ZERO_STATS });
  }
  if (!stats?.disabled) {
    await clearReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId, logTag: 'payoutReconciliation' });
  }
  if (stats?.disabled) {
    console.warn('[payoutReconciliation] LLM matcher disabled — no weighted fallback exists for this family', {
      documentId,
      reason: stats.disabled_reason || null,
      policy_model: policyModel
    });
  }
  return stats;
};
