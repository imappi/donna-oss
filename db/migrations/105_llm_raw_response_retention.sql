-- Decision-receipt retention — the 90-day clock on llm_raw_response.
-- Design: docs/donna-kernel-audit/telemetry-retention-design.md
-- Policy:  docs/donna-kernel-audit/decisions-2026-07-28.md, decision 4 (Kari,
--          2026-07-28) — 90-day retention on llm_decisions.llm_raw_response,
--          firm-member-only access. The receipt row itself (verdict, reasoning,
--          confidence, model id, config snapshot, correction lineage) is
--          retained INDEFINITELY.
--
-- READ THIS BEFORE ASSUMING THIS MIGRATION CLOSES A LEAK (design note §1):
-- llm_decisions.llm_raw_response is NULL on every row in production, because no
-- production caller has ever passed a value for it — recordLlmDecision defaults
-- `llmRawResponse = null` (llmDecisions.js:17) and all six call sites omit it.
-- This is therefore a PROSPECTIVE control, landed while the column is empty and
-- before M3's llmCall seam begins populating it: the migration runs against no
-- hot data, the partial index below is empty on creation, and the guard is
-- already standing when the first raw response arrives. It is NOT a remediation
-- of a live exposure, and nothing downstream should describe it as one.
--
-- The column that actually carries free-form model prose on these rows is
-- llm_reasoning, which decision 4 explicitly RETAINS. This migration does not
-- touch it. See the design note §6 — that question is back with Kari.

-- ── The per-row redaction receipt ────────────────────────────────────────────
-- Nullability is meaningful, and it is the whole reason this column exists:
--   llm_raw_response is null AND llm_raw_response_redacted_at is null
--     ⇒ this decision NEVER recorded a raw response (every row today)
--   llm_raw_response is null AND llm_raw_response_redacted_at is not null
--     ⇒ it did, and the retention sweep destroyed it, then.
-- Without this the two states are indistinguishable and the sweep is
-- unauditable. It is deliberately NOT added to the freeze trigger's `allowed`
-- annotation array below — it may only ever be written as part of the redaction
-- transition itself, which makes it write-once.
alter table llm_decisions add column if not exists llm_raw_response_redacted_at timestamptz;

-- ── The sweep's index ────────────────────────────────────────────────────────
-- Partial on the un-redacted population, so it SHRINKS as the sweep works and a
-- converged deployment pays ~nothing per run. Empty on creation (see the header),
-- which is also the cheapest possible moment to add it.
create index if not exists idx_llm_decisions_raw_response_retention
  on llm_decisions (created_at)
  where llm_raw_response is not null;

-- ── The narrow exemption to migration 045's immutability trigger ─────────────
-- Migration 045 froze this table fail-closed BY SUBTRACTION: everything except
-- six named annotation columns is immutable after insert, and any future column
-- is frozen by default. That property is load-bearing — it is what makes a
-- receipt a receipt — and it survives this migration unchanged.
--
-- WHY NOT JUST ADD llm_raw_response TO `allowed`: that array lists columns which
-- may change to ANYTHING, at ANY time, by ANY writer. Putting a prediction
-- column in it would convert a retention exemption into a general edit hatch on
-- verbatim model output — a future writer could rewrite a raw response and the
-- trigger would wave it through. So the exemption is keyed on the SHAPE OF THE
-- TRANSITION, not on a column name: only a one-way DESTRUCTION (non-null → null)
-- that simultaneously stamps its own receipt is permitted.
--
-- Two properties fall out of the four clauses, and both are enforced by the
-- database rather than trusted to the caller:
--   * the stamp is MANDATORY — nulling llm_raw_response without setting
--     llm_raw_response_redacted_at is refused, so a redaction can never be
--     silent ("nothing silent", pushed down into the schema);
--   * the stamp is WRITE-ONCE — an already-redacted row cannot be re-stamped,
--     so the receipt cannot be forged after the fact.
--
-- Refusal matrix (each row is a test in llmDecisionRetention.test.js):
--   null with no stamp                       → refused (the null shows in the diff)
--   llm_raw_response = some other value      → refused (an EDIT is not a redaction)
--   stamp redacted_at alone                  → refused (frozen by default)
--   re-stamp an already-redacted row         → refused (write-once)
--   redact AND change final_state            → refused (outside the exemption)
--   redact AND change llm_reasoning          → refused (outside the exemption)
--   any future prediction column             → frozen (subtraction is unchanged)
--   the sweep's exact four-clause UPDATE     → permitted
create or replace function llm_decisions_freeze_prediction()
returns trigger as $$
declare
  -- UNCHANGED from migration 045. A test pins these six exactly; widening this
  -- array is the thing this design exists to prevent.
  allowed constant text[] := array[
    'human_outcome', 'human_outcome_at', 'reversal_metadata',
    'louis_verdict', 'louis_evaluated_at', 'resolved_at'
  ];
  -- The ONE permitted prediction-column mutation, and it is a DELETION rather
  -- than an edit. All four clauses must hold together.
  redaction constant boolean :=
        old.llm_raw_response is not null              -- there was something to redact
    and new.llm_raw_response is null                  -- and it is DESTROYED, not edited
    and old.llm_raw_response_redacted_at is null      -- write-once: not already redacted
    and new.llm_raw_response_redacted_at is not null; -- and the receipt is stamped
  exempt text[];
begin
  if redaction then
    exempt := allowed || array['llm_raw_response', 'llm_raw_response_redacted_at'];
  else
    exempt := allowed;
  end if;

  if (to_jsonb(old) - exempt) is distinct from (to_jsonb(new) - exempt) then
    raise exception
      'llm_decisions is append-only (§4): a prediction column may not be updated after insert. Only annotation columns (%) may change, plus the retention redaction of llm_raw_response (non-null → null, stamping llm_raw_response_redacted_at, once). Record a correction as a NEW superseding receipt linked via previous_decision_id.',
      array_to_string(allowed, ', ')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

-- The trigger binding itself is unchanged from 045; re-created here so this
-- migration is self-contained if 045's trigger was ever dropped by hand.
drop trigger if exists llm_decisions_freeze_prediction_trg on llm_decisions;
create trigger llm_decisions_freeze_prediction_trg
  before update on llm_decisions
  for each row
  execute function llm_decisions_freeze_prediction();
