-- Reconciliation evaluation verdicts — one row per (firm, client,
-- target, matcher family), upserted to the LAST evaluation.
--
-- Until this table, a matcher run that proposed nothing left no
-- persisted trace: the model's unmatchable_reason
-- (no_plausible_match / insufficient_bank_feed / already_settled / …)
-- survived only in function logs, so "evaluated and found nothing"
-- was indistinguishable from "never evaluated". Absence of a row is
-- not a verdict. This stamp is the trigger surface for the
-- ask-pipeline and for the artifact's no-match / pending states.
--
-- This is NOT a match table. A zero-proposal verdict is an evaluation
-- result, not a candidate pair — candidate pairs stay in
-- reconciliation_matches, and a live match row always outranks this
-- stamp (renderers consult matches first). Do not write no-match
-- pseudo-rows into reconciliation_matches; the bankLineAutoExplain
-- self-reference rows already taught us what that overload costs.
--
-- verdict vocabulary (written by reconciliationLlmCore):
--   'proposed'      — the matcher wrote >= 1 proposal this pass
--   'no_match'      — the model returned zero proposals;
--                     unmatchable_reason carries its stated reason
--   'no_candidates' — no eligible bank lines survived window +
--                     suppression filters; the model was not called
create table if not exists reconciliation_evaluations (
  id                 text primary key,
  firm_id            text not null,
  client_id          text not null,
  target_type        text not null,
  target_id          text not null,
  matcher_family     text not null,
  matcher_mode       text not null default 'llm',
  verdict            text not null,
  unmatchable_reason text,
  proposal_count     integer not null default 0,
  candidate_count    integer not null default 0,
  eligible_count     integer not null default 0,
  model              text,
  payload            jsonb not null default '{}'::jsonb,
  evaluated_at       timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

-- The upsert key: last evaluation per target per matcher family.
create unique index if not exists uq_reconciliation_evaluations_target
  on reconciliation_evaluations (firm_id, client_id, target_type, target_id, matcher_family);

create index if not exists idx_reconciliation_evaluations_firm_client
  on reconciliation_evaluations (firm_id, client_id);
