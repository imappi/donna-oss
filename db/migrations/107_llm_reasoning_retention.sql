-- Tier 2 retention — the 90-day clock on llm_decisions.llm_reasoning.
-- Policy:  docs/donna-data-lifecycle-policy.md (Kari, 2026-07-28).
-- Decision: docs/donna-kernel-audit/decisions-2026-07-28.md, questions 3 and 5.
--
-- THE THREE TIERS, so this migration's scope is unambiguous:
--   1. structured decision receipt (verdict, confidence, signals, blockers,
--      final state, model id, prompt version, config snapshot, correction
--      lineage) — RETAINED, subject to the client-deletion policy.
--   2. curated model reasoning (llm_reasoning) — 90 DAYS. This migration.
--   3. raw provider envelope (llm_raw_response) — NOT CAPTURED by default;
--      migration 105 built its clock, and it stays a prospective control until
--      capture is separately authorized against the nine conditions in the
--      policy doc §3.
--
-- WHY THIS IS THE COLUMN THAT MATTERED. Migration 105's clock guards
-- llm_raw_response, which is NULL on every row ever written (no caller passes
-- it). llm_reasoning is the column that IS populated — five of six
-- recordLlmDecision call sites — with the model's prose about a specific
-- invoice, counterparty and amount. So this migration is the one that makes the
-- retention position real rather than prospective.
--
-- COST OF REDACTION, VERIFIED: llm_reasoning has ZERO database readers. Its one
-- apparent consumer (louisPipeline.js:54) interpolates reasoning into Louis's QA
-- prompt, but evaluatePipelineDecision is called with an IN-MEMORY decision
-- object built at decision time, before the row exists. Nothing reads the column
-- back. Redacting it breaks no code path in the tree.
--
-- THE ORDINARY WRITER'S IMMUTABILITY RULE IS NOT WEAKENED. Migration 045 (as
-- amended by 105) freezes this table fail-closed BY SUBTRACTION. This migration
-- adds a SECOND redaction-shaped exemption, independently gated, with its own
-- write-once stamp — it does not widen the six-element annotation allow-list,
-- and it does not make llm_reasoning editable. Only DESTRUCTION is permitted.

-- ── The tier-2 redaction receipt ────────────────────────────────────────────
-- Its own stamp, deliberately NOT reusing llm_raw_response_redacted_at: the two
-- tiers have independent lifecycles (tier 3 may never be captured at all), and a
-- shared stamp could not say which payload was destroyed when. Nullability
-- carries the same meaning as its tier-3 sibling:
--   llm_reasoning is null AND llm_reasoning_redacted_at is null
--     ⇒ this decision never recorded reasoning (the sixth call site)
--   llm_reasoning is null AND llm_reasoning_redacted_at is not null
--     ⇒ it did, and retention destroyed it, then.
alter table llm_decisions add column if not exists llm_reasoning_redacted_at timestamptz;

-- ── The sweep's index ───────────────────────────────────────────────────────
-- Partial on the un-redacted population, so it SHRINKS as the sweep converges.
-- NOTE, unlike 105's sibling index: this one is NOT empty on creation. Nearly
-- every existing row carries reasoning, so this is a real index build on a
-- populated table, and the first sweep does real work (bounded per run by the
-- sweep's limit, converging over several runs). That is the tier-2 clock
-- actually engaging — expect a large first-run `reasoning_redacted` count that
-- then falls toward zero, and stays near zero in steady state.
create index if not exists idx_llm_decisions_reasoning_retention
  on llm_decisions (created_at)
  where llm_reasoning is not null;

-- ── Two independent redaction-shaped exemptions ─────────────────────────────
-- Each tier is gated on its OWN four-clause destruction transition. Keying the
-- exemption on the SHAPE of the transition rather than on a column name is what
-- stops it becoming a general edit hatch: a column named in an allow-list may
-- change to anything, at any time, by any writer; a column exempted only while
-- being destroyed-and-stamped may only ever be destroyed.
--
-- Per-column properties, all enforced HERE rather than trusted to the caller:
--   * the stamp is MANDATORY  — nulling a payload without stamping is refused,
--                               so a redaction can never be silent;
--   * the stamp is WRITE-ONCE — an already-redacted row cannot be re-stamped,
--                               so the receipt cannot be forged after the fact;
--   * only DESTRUCTION passes — setting either column to a different value is
--                               an EDIT, and is refused;
--   * everything else stays frozen, including a redaction bundled with any
--     other change, and including any future column (fail-closed subtraction).
--
-- Refusal matrix (each row is a test in llmDecisionRetention.test.js):
--   reasoning → null, no stamp              → refused (the null shows in the diff)
--   reasoning → some other value            → refused (an EDIT is not a redaction)
--   stamp llm_reasoning_redacted_at alone   → refused (frozen by default)
--   re-stamp an already-redacted reasoning  → refused (write-once)
--   redact reasoning AND change final_state → refused (outside the exemption)
--   redact reasoning AND edit raw           → refused (raws own gate fails)
--   redact BOTH, each correctly shaped      → permitted (the client-delete case)
--   any future prediction column            → frozen (subtraction unchanged)
create or replace function llm_decisions_freeze_prediction()
returns trigger as $$
declare
  -- UNCHANGED from migration 045. Tests pin these six exactly; widening this
  -- array is what the transition-shaped design exists to prevent.
  allowed constant text[] := array[
    'human_outcome', 'human_outcome_at', 'reversal_metadata',
    'louis_verdict', 'louis_evaluated_at', 'resolved_at'
  ];
  -- Tier 3 (migration 105) — unchanged.
  raw_redaction constant boolean :=
        old.llm_raw_response is not null
    and new.llm_raw_response is null
    and old.llm_raw_response_redacted_at is null
    and new.llm_raw_response_redacted_at is not null;
  -- Tier 2 (this migration) — the same shape, independently gated.
  reasoning_redaction constant boolean :=
        old.llm_reasoning is not null
    and new.llm_reasoning is null
    and old.llm_reasoning_redacted_at is null
    and new.llm_reasoning_redacted_at is not null;
  exempt text[];
begin
  exempt := allowed;
  if raw_redaction then
    exempt := exempt || array['llm_raw_response', 'llm_raw_response_redacted_at'];
  end if;
  if reasoning_redaction then
    exempt := exempt || array['llm_reasoning', 'llm_reasoning_redacted_at'];
  end if;

  if (to_jsonb(old) - exempt) is distinct from (to_jsonb(new) - exempt) then
    raise exception
      'llm_decisions is append-only (§4): a prediction column may not be updated after insert. Only annotation columns (%) may change, plus a retention REDACTION of llm_reasoning or llm_raw_response (non-null → null, stamping the matching *_redacted_at, once). Record a correction as a NEW superseding receipt linked via previous_decision_id.',
      array_to_string(allowed, ', ')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

-- The trigger binding is unchanged; re-created so this migration is
-- self-contained if the trigger was ever dropped by hand.
drop trigger if exists llm_decisions_freeze_prediction_trg on llm_decisions;
create trigger llm_decisions_freeze_prediction_trg
  before update on llm_decisions
  for each row
  execute function llm_decisions_freeze_prediction();
