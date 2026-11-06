-- Donna Loops — Phase 6: the memory-candidate staging front for firm_facts.
--
-- memory_candidates is the GOVERNANCE front-gate to firm_facts (Layer 2 memory,
-- migration 030). A correction or client reply distils into firm knowledge; the
-- candidate is the auditable, human-reviewable record of THAT learning before it
-- is trusted unattended. candidate_type ∈ fact·example·policy·playbook_gap
-- (contract §4); a 'fact' candidate carries firm_facts-shaped content (scope /
-- subject / fact / confidence) so promotion maps 1:1 onto saveFirmFact.
--
-- Lifecycle (status): suggested → promoted (minted into firm_facts) | dismissed
-- (a human "no" — never auto-resurrected, the firm_facts on-conflict discipline)
-- | conflicted (contradicts an active fact; awaits a human call). Phase 6.0 ships
-- the substrate + the firm_facts→candidate governance backfill (status reflects
-- the persisted fact: active→promoted, dismissed→dismissed). The forward
-- correction→suggested producer + promote/dismiss writes are later flag-gated
-- slices.
--
-- client_id is a PLAIN column (NOT a clients FK), the firm_facts / Loops-spine
-- pattern: the clients delete-cascade does not reach these rows, so the explicit
-- purgeMemoryCandidatesForDeletedClient (folded into
-- purgeLoopsShadowForDeletedClient, run inside the client-delete transaction) is
-- load-bearing — firm memory dies with its client (rail #5), candidates included.
--
-- A 'fact' candidate carries firm_facts-shaped content (scope / subject / fact /
-- confidence, mirroring 030's vocab) so promotion maps 1:1 onto saveFirmFact;
-- those columns are null for non-fact candidate types.
--
-- Migration number: 036. 033 is the spine, 034 the proposal cards, 035 the
-- ledger canonical-role column; this slots after them (renumbered from 035 to
-- deconflict with the ledger migration that took 035 in parallel). SHADOW-only at
-- the app layer (LOOPS_SHADOW); no reads drive UI, no LLM, no external calls, no
-- accounting writes ship with it.

create table if not exists memory_candidates (
  id              text primary key,
  firm_id         text not null references firms(id) on delete cascade,
  client_id       text not null,
  candidate_type  text not null
                    check (candidate_type in ('fact', 'example', 'policy', 'playbook_gap')),
  status          text not null default 'suggested'
                    check (status in ('suggested', 'promoted', 'dismissed', 'conflicted')),
  source          text not null,
  scope           text check (scope in ('merchant', 'client', 'jurisdiction', 'firm')),
  subject         text,
  fact            text,
  confidence      text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  provenance      jsonb not null default '{}'::jsonb,
  model           text,
  minted_fact_id  text,
  case_id         text,
  decided_at      timestamptz,
  decided_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists memory_candidates_client_status_idx
  on memory_candidates (client_id, status);
create index if not exists memory_candidates_subject_idx
  on memory_candidates (firm_id, scope, subject, status);
create index if not exists memory_candidates_case_idx
  on memory_candidates (case_id);

-- ── RLS-native (same posture as 033/034) ─────────────────────────────────────
-- The server connects as the table-owner role (RLS-exempt); the browser never
-- queries this table. ENABLE (not FORCE) so the owner stays exempt; revoke the
-- Supabase anon/authenticated roles entirely. Guarded so a dev DB without those
-- roles still applies cleanly.
alter table memory_candidates enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on memory_candidates from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on memory_candidates from authenticated;
  end if;
end $$;
