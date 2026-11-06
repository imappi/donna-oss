-- Decision receipts v2 — immutability + correction chain — Phase 0C.1
-- (docs/donna-self-awareness-plan.md §4 "The replay contract — decision receipt v2").
--
-- §4: "Receipts are immutable and append-only. A correction does not edit a receipt — it
-- writes a *new* one ... linked to the prior via previous_decision_id. The result is a
-- verifiable decision chain: how Donna's understanding of a line evolved, never
-- overwritten." This migration lands the substrate for that chain. CLAUDE.md "Keep" layer
-- — system-correctness plumbing, never a cage of intelligence-substituting rules.
--
-- TWO FORKS, decided 2026-06-27 (session claude/donna-decision-ledger-0c-r7qrda):
--   Fork A — chain semantics: previous_decision_id is the CORRECTION lineage ONLY (a
--     superseding receipt → the exact receipt it corrects), NOT a generic per-target
--     history. Matches §4 verbatim.
--   Fork B — immutability: a column-scoped BEFORE UPDATE trigger, FAIL-CLOSED ALLOW-LIST.
--     Everything is frozen after insert EXCEPT the six known annotation columns. This is
--     faithful to "freeze the prediction columns, allow the annotation columns" AND
--     protects the unnamed prediction columns (prompt_version / lane / policy_blockers /
--     llm_reasoning / llm_raw_response) plus any future column by default. Verified against
--     the only two post-insert writers in the tree (recordHumanOutcome / recordLouisVerdict,
--     server/donna/llmDecisions.js) — both touch ONLY allow-listed annotation columns, so
--     the trigger breaks neither.
--
-- corrected_by (the operator id, §4) is DEFERRED to the actor-attribution slice
-- (pod-safety gap #1) — today it would only ever be 'system', and baking a placeholder
-- column into the receipt substrate is exactly the wrong-shape risk 0C was held back to
-- avoid. We add only the two fields the populating slice (recordHumanOutcome) actually
-- lands: previous_decision_id + correction_reason.

-- ── The correction-chain link ─────────────────────────────────────────────────────────
-- Plain text + nullable, mirroring the sibling link config_snapshot_id (migration 044): a
-- decision that is not a correction carries null (byte-identical to pre-0C). Not a FK by
-- intent — same loose posture as config_snapshot_id, and it sidesteps purge/insert-ordering
-- coupling on an append-only audit table. The id it holds is the receipt being superseded.
alter table llm_decisions add column if not exists previous_decision_id text;

-- Why Donna's understanding changed (e.g. 'human_edited' / 'human_rejected'). Nullable;
-- set only on a superseding receipt.
alter table llm_decisions add column if not exists correction_reason text;

-- Walk a correction chain backwards ("what did this receipt supersede?").
create index if not exists idx_llm_decisions_previous
  on llm_decisions (previous_decision_id)
  where previous_decision_id is not null;

-- ── Fork B: fail-closed immutability trigger ──────────────────────────────────────────
-- Raise on any UPDATE that changes a column OTHER than the allow-listed annotation set.
-- to_jsonb(row) - allowed strips the allowed keys, so the comparison is "did anything
-- else change?". A future prediction column is frozen automatically (fail-closed). The
-- six allowed columns are exactly what recordHumanOutcome (human_outcome /
-- human_outcome_at / reversal_metadata / resolved_at) and recordLouisVerdict
-- (louis_verdict / louis_evaluated_at) write — both keep working unchanged.
create or replace function llm_decisions_freeze_prediction()
returns trigger as $$
declare
  allowed constant text[] := array[
    'human_outcome', 'human_outcome_at', 'reversal_metadata',
    'louis_verdict', 'louis_evaluated_at', 'resolved_at'
  ];
begin
  if (to_jsonb(old) - allowed) is distinct from (to_jsonb(new) - allowed) then
    raise exception
      'llm_decisions is append-only (§4): a prediction column may not be updated after insert. Only annotation columns (%) may change; record a correction as a NEW superseding receipt linked via previous_decision_id.',
      array_to_string(allowed, ', ')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists llm_decisions_freeze_prediction_trg on llm_decisions;
create trigger llm_decisions_freeze_prediction_trg
  before update on llm_decisions
  for each row
  execute function llm_decisions_freeze_prediction();
