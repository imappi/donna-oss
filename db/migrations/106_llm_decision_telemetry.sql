-- Model-call telemetry on the decision receipt — kernel-audit M3 / S1, gap G3.
-- Design: docs/donna-kernel-audit/llm-call-envelope-design.md.
--
-- G3: 31 modules call a provider directly with no shared envelope and exactly
-- one captures usage, so the tree cannot answer tokens-per-outcome,
-- calls-per-task, or retry cost. `server/donna/llmCall.js` is the envelope;
-- these are the columns its output lands in.
--
-- THE HOME IS llm_decisions, NOT A NEW TABLE. gap-analysis §4 ("false gaps"):
-- "a new receipts store — apply_receipts + outbound receipts + llm_decisions
-- cover the three receipt classes; G3 adds columns/keys, not tables."
--
-- ONE TYPED EXECUTION REF, NOT A NULLABLE UNION. The plan's §S1 specifies an
-- attribution key `{work_ref | case_id | run_id | action_id}`; G3 REVISED that
-- to "ONE typed root_execution_ref + optional parent (never a nullable union)",
-- and S1 was never updated to say so. G3 is binding: four nullable columns are
-- not one identity and cannot be joined on. So the ref is a (type, id) PAIR,
-- indexed together — the join that turns `tokens_per_outcome` into a query.
--
-- NO TRIGGER CHANGE IS NEEDED, AND THAT IS THE POINT. Migration 045 (as amended
-- by 105) freezes this table fail-closed BY SUBTRACTION: everything not in the
-- six-element annotation allow-list is immutable after insert, INCLUDING any
-- column added later. Every column below is therefore frozen on arrival. A test
-- in migrations.test.js pins that, because "additive columns are frozen" is the
-- kind of invariant that stays true by accident until someone changes the
-- mechanism.
--
-- All columns are NULLABLE and ADDITIVE: every existing row and every existing
-- writer is byte-identical after this migration. recordLlmDecision's telemetry
-- argument defaults to null.

-- Normalized token usage { input_tokens, output_tokens, total_tokens, provider }
-- plus the untouched provider blob under `provider_usage`, so a normalization
-- bug is diagnosable rather than silently producing plausible wrong numbers.
alter table llm_decisions add column if not exists usage jsonb;

-- The typed root execution reference — TWO columns, deliberately, never a union.
alter table llm_decisions add column if not exists root_execution_type text;
alter table llm_decisions add column if not exists root_execution_id text;

-- The optional parent, same typed shape. A sub-call (e.g. a repair pass) points
-- at its parent; a top-level call carries null.
alter table llm_decisions add column if not exists parent_execution_type text;
alter table llm_decisions add column if not exists parent_execution_id text;

-- TYPED fields, not buried in a blob — G3 is explicit that token/latency/retry
-- are typed. attempt_count is what makes retry COST answerable at all.
alter table llm_decisions add column if not exists latency_ms integer;
alter table llm_decisions add column if not exists attempt_count integer;
alter table llm_decisions add column if not exists provider_attempt_id text;

-- Section byte/char accounting computed AT REQUEST CONSTRUCTION, because
-- provider `usage` cannot decompose a prompt into system/tools/context/history/
-- results. SIZES ONLY — never section contents. That is G14's explicit
-- mitigation ("the wrapper stores section SIZES, never section contents") and
-- it is why this measurement slice does not re-widen the data surface migration
-- 105's retention control just narrowed. llmCall.js enforces it; llmCall.test.js
-- pins it by serializing the telemetry and searching for the content.
alter table llm_decisions add column if not exists prompt_sections jsonb;

-- The attribution join: "what did this outcome cost?" Partial, so it covers
-- exactly the instrumented population and stays small while adoption is
-- deliberately limited to the first loop + the intent compiler.
create index if not exists idx_llm_decisions_root_execution
  on llm_decisions (root_execution_type, root_execution_id)
  where root_execution_id is not null;
