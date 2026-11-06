-- Descent-ladder challenger receipts (spec: docs/design-donna-qwen-descent-ladder.md
-- §3.4, slice Q2). One append-only row per shadow-challenger run: which lane,
-- which deciding artifact vs which challenger artifact (both response-sourced,
-- both carrying model_source provenance), what the comparison found, and what
-- the run cost.
--
-- AUDIT-plane store (donna-memory-architecture.md): receipts, never a
-- retrieval substrate — no row is ever read into a prompt, and nothing on a
-- decision path reads this table. The usage column doubles as the R&D spend
-- ledger: the per-client monthly token cap is a SUM over (firm, client,
-- month) here, so cost ownership (Donna's, never the customer's meter) is
-- enforceable from the receipts themselves.
--
-- Retention posture (llmCall rail 1/2 extended): divergence_summary carries
-- CLASSIFICATION and field/size-level detail only — never full prompt or
-- response text. Reconstruction for EAW fixture promotion goes through the
-- durable domain objects behind the execution ref.

create table if not exists model_challenger_runs (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  lane text not null,
  -- The deciding call's typed execution ref (llmCall rail 3) — the join key
  -- back to the case the deciding model actually decided.
  root_execution_type text not null,
  root_execution_id text not null,
  -- { model, model_source } for the deciding call as it ran.
  deciding jsonb not null,
  -- { model, model_source, model_artifact } for the challenger — the full
  -- §23.3-shape artifact, hosted-API fields explicitly null, never fabricated.
  challenger jsonb not null,
  outcome text not null check (outcome in ('match', 'divergence', 'challenger_error', 'parse_failure')),
  -- Null on match/error; a lane × failure-class taxonomy value on divergence.
  failure_class text,
  divergence_summary jsonb,
  -- Normalized challenger usage from llmCall telemetry — the spend ledger.
  usage jsonb,
  created_at timestamptz not null default now()
);

-- The cap sum and the per-lane gap table are the two read shapes.
create index if not exists model_challenger_runs_spend_idx
  on model_challenger_runs(firm_id, client_id, created_at);
create index if not exists model_challenger_runs_lane_idx
  on model_challenger_runs(lane, created_at);

-- RLS — server-only table (the harness reaches it through the pooled service
-- role); browser roles get nothing. ENABLE + guarded revoke, never FORCE
-- (the 037/042/100/114 house pattern).
alter table model_challenger_runs enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on model_challenger_runs from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on model_challenger_runs from authenticated;
  end if;
end $$;
