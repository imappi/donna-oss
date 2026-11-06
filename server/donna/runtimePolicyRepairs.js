// Mounted operational consumer. The audit lifecycle owns acknowledgment;
// existing accounting consumers retain every decision and posting gate.
import { withFirmDbClient, readClientConfigSnapshotInDb, suggestTransactionCodingInDb } from './firmDb.js';
import {
  requestRuntimePolicyIncidentRetry, completeRuntimePolicyIncidentRetry
} from './runtimePolicyIncidentDb.js';
import { retryOwnerReplyProcessingInDb } from './ownerReplyRecovery.js';
import { sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { readRetainedProcessingScopeInDb, EntityReadinessAdmissionError } from './runtimeReadinessAdmission.js';

export const retryRuntimePolicyIncidentInDb = async ({ firmId, failureId, principal, idempotencyKey, repairNote }) => {
  const args = { firmId, failureId, principal };
  const started = await withFirmDbClient((client) => requestRuntimePolicyIncidentRetry({
    ...args, client, idempotencyKey, repairNote
  }));
  if (!started.execute) {
    const completion = started.request.completion;
    return { incident: started.incident, executed: false, recovered: completion?.outcome === 'recovered', completion: completion || null };
  }

  const incident = started.incident;
  let errorCode = null;
  try {
    if (incident.operation === 'owner_reply') {
      const reply = await retryOwnerReplyProcessingInDb({
        firmId, clientId: incident.client_id, transactionId: incident.transaction_id,
        evidenceRequestId: incident.evidence_request_id,
        expectedReplyKey: incident.reply_key, expectedFailureId: incident.failure_id,
        actorId: principal.principalId
      });
      errorCode = reply.results.find((item) => item.error || item.code)?.code || null;
    } else if (incident.operation === 'coding') {
      const reply = await retryOwnerReplyProcessingInDb({
        firmId, clientId: incident.client_id, transactionId: incident.transaction_id,
        actorId: principal.principalId
      });
      if (!reply.eligible_replies) {
        await suggestTransactionCodingInDb({ firmId, transactionId: incident.transaction_id });
      } else {
        errorCode = reply.results.find((item) => item.error || item.code)?.code || null;
      }
    } else if (incident.operation === 'posting') {
      // Recheck already-admitted retries at execution too. A lease is not
      // permission to outlive the retained scope; completion below stays open.
      const scope = await readRetainedProcessingScopeInDb({ firmId, clientId: incident.client_id });
      if (!scope.allowed) throw new EntityReadinessAdmissionError(scope);
      const configSnapshot = await readClientConfigSnapshotInDb({ firmId, clientId: incident.client_id });
      const result = await sweepLedgerAutoPost({
        firmId, clientId: incident.client_id, transactionId: incident.transaction_id, configSnapshot
      });
      errorCode = result.gated ? result.reason : result.refused ? 'posting_refused' : !result.posted ? 'posting_not_eligible' : null;
    }
  } catch (error) {
    errorCode = error?.code || 'runtime_repair_failed';
  }
  // Derive closure from the writer's exact receipt, even when the transport
  // failed after a commit. A successful HTTP call is not accounting evidence.
  const completion = await withFirmDbClient((client) => completeRuntimePolicyIncidentRetry({
    ...args, client, requestId: started.request.id, errorCode
  }));
  return { executed: true, recovered: completion.outcome === 'recovered', completion };
};
