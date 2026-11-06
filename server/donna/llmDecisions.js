import { randomUUID } from 'node:crypto';

export const recordLlmDecision = async ({
  client,
  firmId,
  clientId,
  decisionType,
  targetType,
  targetId,
  modelName = null,
  promptVersion = null,
  deterministicSignals = {},
  confidence = {},
  lane = null,
  policyBlockers = [],
  llmReasoning = null,
  llmRawResponse = null,
  finalState = null,
  // Phase 0B.1 bridge: the config snapshot this decision ran under
  // (clientConfig.persistConfigSnapshot). null ⇒ un-stamped, byte-identical to pre-bridge.
  configSnapshotId = null,
  // Phase 0C correction chain (§4): set ONLY on a superseding receipt — the id of the
  // receipt this one corrects, plus why. null on a normal prediction ⇒ byte-identical
  // to pre-0C. Fork A: this is the correction lineage, not a generic per-target history.
  previousDecisionId = null,
  correctionReason = null,
  // M3 / S1 (migration 106) — model-call telemetry from the llmCall envelope,
  // via telemetryForDecision(). null ⇒ every column below is null and the
  // insert is byte-identical to pre-M3, which is what keeps the four
  // un-instrumented writers unchanged. Deliberately does NOT carry a raw
  // response: the envelope never captures one (llmCall.js rail 2).
  telemetry = null
} = {}) => {
  const id = `llmd-${randomUUID()}`;
  const t = telemetry || {};

  await client.query(
    `insert into llm_decisions (
      id, firm_id, client_id, decision_type, target_type, target_id,
      model_name, prompt_version, deterministic_signals, confidence,
      lane, policy_blockers, llm_reasoning, llm_raw_response, final_state,
      config_snapshot_id, previous_decision_id, correction_reason,
      usage, root_execution_type, root_execution_id,
      parent_execution_type, parent_execution_id,
      latency_ms, attempt_count, provider_attempt_id, prompt_sections
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9::jsonb, $10::jsonb,
      $11, $12, $13, $14::jsonb, $15,
      $16, $17, $18,
      $19::jsonb, $20, $21,
      $22, $23,
      $24, $25, $26, $27::jsonb
    )`,
    [
      id,
      firmId,
      clientId,
      decisionType,
      targetType,
      targetId,
      modelName,
      promptVersion,
      JSON.stringify(deterministicSignals),
      JSON.stringify(confidence),
      lane,
      policyBlockers,
      llmReasoning,
      llmRawResponse != null ? JSON.stringify(llmRawResponse) : null,
      finalState,
      configSnapshotId,
      previousDecisionId,
      correctionReason,
      t.usage != null ? JSON.stringify(t.usage) : null,
      t.rootExecutionType ?? null,
      t.rootExecutionId ?? null,
      t.parentExecutionType ?? null,
      t.parentExecutionId ?? null,
      t.latencyMs ?? null,
      t.attemptCount ?? null,
      t.providerAttemptId ?? null,
      t.promptSections != null ? JSON.stringify(t.promptSections) : null
    ]
  );

  return id;
};

export const recordHumanOutcome = async ({
  client,
  decisionId,
  outcome,
  metadata = null
} = {}) => {
  // The original receipt keeps its allow-listed annotation (human_outcome / resolved_at /
  // reversal_metadata) — that is NOT a prediction edit, so the 045 immutability trigger
  // permits it. RETURNING the prediction identity so a correction can be linked to it.
  const result = await client.query(
    `update llm_decisions
     set human_outcome = $1,
         human_outcome_at = now(),
         reversal_metadata = $2::jsonb,
         resolved_at = now()
     where id = $3
       and client_id is not null
     returning id, firm_id, client_id, decision_type, target_type, target_id`,
    [
      outcome,
      metadata != null ? JSON.stringify(metadata) : null,
      decisionId
    ]
  );

  if (result.rowCount === 0) return false;

  // Phase 0C correction chain (§4): a CORRECTION — the human disagreed (edited / rejected)
  // — writes a NEW superseding receipt linked to the original via previous_decision_id,
  // never overwriting it. 'confirmed' is agreement, not a correction, so no chain link.
  // The superseding receipt carries the corrected final_state, no model_name (human-
  // authored) and no config_snapshot_id (no config drove it). corrected_by (the operator
  // id) is deferred to the actor-attribution slice (pod-safety gap #1).
  if (outcome === 'edited' || outcome === 'rejected') {
    const original = result.rows[0];
    const correctedState = outcome === 'edited'
      ? (metadata?.firm_account_code || null)
      : 'rejected';
    await recordLlmDecision({
      client,
      firmId: original.firm_id,
      clientId: original.client_id,
      decisionType: original.decision_type,
      targetType: original.target_type,
      targetId: original.target_id,
      finalState: correctedState,
      previousDecisionId: original.id,
      correctionReason: outcome === 'edited' ? 'human_edited' : 'human_rejected'
    });
  }

  return result.rowCount > 0;
};

export const recordLouisVerdict = async ({
  client,
  decisionId,
  verdict
} = {}) => {
  const result = await client.query(
    `update llm_decisions
     set louis_verdict = $1::jsonb,
         louis_evaluated_at = now()
     where id = $2
       and client_id is not null
     returning id`,
    [
      JSON.stringify(verdict),
      decisionId
    ]
  );

  return result.rowCount > 0;
};
