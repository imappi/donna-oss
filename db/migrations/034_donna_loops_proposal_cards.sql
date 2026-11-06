-- Donna Loops — Phase 2: durable proposal cards + deterministic preflight.
--
-- These four tables are the PERSISTED, immutable form of the in-memory Operator
-- Contract shapes that already exist in server/donna/operatorContract.js:
--   proposal_cards   ← ProposalCard v2   (operatorContract.js PROPOSAL_CARD_SCHEMA)
--   proposal_targets ← targets[] + preconditions[] (NORMALIZED into rows)
--   check_reports    ← CheckReport       (operatorContract.js CHECK_REPORT_SCHEMA)
--   apply_receipts   ← ApplyReceipt v2   (operatorContract.js APPLY_RECEIPT_SCHEMA)
-- Field names REUSE the contract verbatim (Phase 0 §3d/§3e/§3i) — this migration
-- does not mint synonyms. The persistence layer (proposalStore.js) validates every
-- row against those schemas before insert.
--
-- INVARIANTS this schema encodes:
--   INV-9  Proposal cards are immutable + snapshot-bound. The CONTENT columns are
--          write-once; a change creates a NEW card (supersede, never mutate). Only
--          the lifecycle pointer (status / superseded_by_proposal_id) transitions,
--          and only via the controlled supersede/withdraw helpers — never the
--          proposal's targets/detail/checks. check_reports + apply_receipts rows are
--          fully append-only.
--   INV-10 Apply is deterministic (re-read, verify version, run deterministic
--          checks). proposal_targets.object_version_at_proposal is the existing
--          optimistic-concurrency token (= preconditions.expected_updated_at,
--          operatorContract.js PRECONDITION_SCHEMA); pre/post_state_hash + per-target
--          apply_status enable snapshot-bound stale-apply detection and partial apply.
--   INV-11 No external API in a core DB txn — nothing here calls out; the outbox
--          (033) carries real side effects in a later phase.
-- Preflight that fills check_reports is DETERMINISTIC ONLY (totals / version /
-- authority / period) — no LLM (Plan v2 §6.2). model_name/prompt_version exist on
-- proposal_cards + check_reports per rail #2 ("the model id is the receipt"); a
-- deterministic preflight report simply leaves them null.
--
-- Migration number 034: 033 is the Loops spine; 032 is reserved for the anticipated
-- RLS lockdown (not yet in repo). These tables are RLS-native anyway.
--
-- client_id / case_id / proposal_id are PLAIN columns (the firm_facts +
-- bookkeeping_cases pattern), NOT FKs to clients/cases. The clients delete cascade
-- does not reach these rows, so the explicit purge (purgeLoopsShadowForDeletedClient,
-- caseManager.js, run inside the client-delete transaction) is load-bearing (rail #5).
-- firm_id keeps its firms FK so a firm teardown still cascades.

-- ── 1. proposal_cards — the immutable ProposalCard (one row per card) ────────
create table if not exists proposal_cards (
  id                       text primary key,
  firm_id                  text not null references firms(id) on delete cascade,
  client_id                text not null,
  case_id                  text,
  proposal_type            text not null,
  triage_source            text not null
                             check (triage_source in (
                               'diagnostic', 'state_correction', 'memory_candidate', 'policy_request',
                               'engineering_escalation', 'unsupported', 'question'
                             )),
  plan_id                  text,
  writer                   text,
  reversibility            text
                             check (reversibility is null or reversibility in (
                               'recode_before_posting', 'reversible_via_adjustment', 'irreversible_external'
                             )),
  review_mode              text not null
                             check (review_mode in (
                               'operator_one_click', 'accountant_approval', 'client_confirmation',
                               'second_reviewer', 'engineering'
                             )),
  blast_radius             jsonb not null default '{}'::jsonb,
  before_after             jsonb not null default '[]'::jsonb,
  before_after_total       integer not null default 0,
  detail                   jsonb not null default '{}'::jsonb,
  warnings                 jsonb not null default '[]'::jsonb,
  check_status             text
                             check (check_status is null or check_status in (
                               'pass', 'warning', 'requires_review', 'fail'
                             )),
  status                   text not null default 'proposed'
                             check (status in ('proposed', 'superseded', 'applied', 'withdrawn', 'expired')),
  supersedes_proposal_id   text,
  superseded_by_proposal_id text,
  snapshot_id              text,
  trigger_event_id         text,
  model_name               text,
  prompt_version           text,
  operator_words           text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists proposal_cards_client_status_idx
  on proposal_cards (client_id, status);
create index if not exists proposal_cards_case_idx
  on proposal_cards (case_id);
create index if not exists proposal_cards_supersedes_idx
  on proposal_cards (supersedes_proposal_id);

-- ── 2. proposal_targets — targets[] + preconditions[] normalized into rows ───
-- object_version_at_proposal binds the target to the object snapshot the card was
-- built against (optimistic concurrency). apply_status drives partial apply.
create table if not exists proposal_targets (
  id                        text primary key,
  firm_id                   text not null references firms(id) on delete cascade,
  client_id                 text not null,
  proposal_id               text not null,
  object_type               text,
  object_id                 text not null,
  object_version_at_proposal text,
  pre_state_hash            text,
  post_state_hash           text,
  check_status              text
                              check (check_status is null or check_status in (
                                'pass', 'warning', 'requires_review', 'fail'
                              )),
  apply_status              text not null default 'pending'
                              check (apply_status in ('pending', 'applied', 'skipped', 'failed', 'superseded')),
  apply_error               text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (proposal_id, object_type, object_id)
);

create index if not exists proposal_targets_proposal_idx
  on proposal_targets (proposal_id);
create index if not exists proposal_targets_object_idx
  on proposal_targets (object_type, object_id);

-- ── 3. check_reports — the deterministic preflight verdict (append-only) ─────
-- status is the worst of the member checks (CHECK_STATUSES severity order, the
-- operatorContract summarizeCheckReport rule). checks holds the member array.
create table if not exists check_reports (
  id              text primary key,
  firm_id         text not null references firms(id) on delete cascade,
  client_id       text not null,
  proposal_id     text not null,
  status          text not null
                    check (status in ('pass', 'warning', 'requires_review', 'fail')),
  checks          jsonb not null default '[]'::jsonb,
  model_name      text,
  prompt_version  text,
  created_at      timestamptz not null default now()
);

create index if not exists check_reports_proposal_idx
  on check_reports (proposal_id);

-- ── 4. apply_receipts — the persisted ApplyReceipt v2 (append-only) ──────────
-- proposal_id is nullable (a generation receipt has none, per APPLY_RECEIPT_SCHEMA).
-- Self-reported fields (facts_used etc.) are telemetry/governance ONLY and may not
-- gate (operatorContract.js self-licensing rule) — persisted, never read by a check.
create table if not exists apply_receipts (
  id                     text primary key,
  firm_id                text not null references firms(id) on delete cascade,
  client_id              text not null,
  case_id                text,
  proposal_id            text,
  model                  text not null,
  prompt_version         text,
  context_snapshot_id    text,
  candidate_ids_seen     jsonb not null default '[]'::jsonb,
  candidate_ids_rejected jsonb not null default '[]'::jsonb,
  facts_available        jsonb not null default '[]'::jsonb,
  facts_used             jsonb not null default '[]'::jsonb,
  facts_conflicted       jsonb not null default '[]'::jsonb,
  examples_available     jsonb not null default '[]'::jsonb,
  examples_used          jsonb not null default '[]'::jsonb,
  playbooks_used         jsonb not null default '[]'::jsonb,
  policies_used          jsonb not null default '[]'::jsonb,
  checks                 jsonb,
  final_writer           text,
  audit_event_ids        jsonb not null default '[]'::jsonb,
  rows_touched           jsonb not null default '[]'::jsonb,
  per_target             jsonb not null default '[]'::jsonb,
  operator_words         text,
  created_at             timestamptz not null default now()
);

create index if not exists apply_receipts_proposal_idx
  on apply_receipts (proposal_id);
create index if not exists apply_receipts_client_idx
  on apply_receipts (firm_id, client_id);

-- ── RLS-native (same posture as 033) ─────────────────────────────────────────
-- The server connects as the table-owner role (RLS-exempt); the browser never
-- queries these. ENABLE (not FORCE) so the owner stays exempt; revoke the Supabase
-- anon/authenticated roles entirely. Guarded so a dev DB without those roles still
-- applies cleanly.
alter table proposal_cards    enable row level security;
alter table proposal_targets  enable row level security;
alter table check_reports     enable row level security;
alter table apply_receipts    enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on proposal_cards, proposal_targets, check_reports, apply_receipts from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on proposal_cards, proposal_targets, check_reports, apply_receipts from authenticated;
  end if;
end $$;
