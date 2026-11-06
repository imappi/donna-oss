-- 146 — DMEM-R1 W2 (audit §4.3 reservation 146): `claim_generation` on the claim
-- and on its dependents, plus the outbox / local-job claim columns behind the
-- generation-checked dispatch fence (INV-27).
--
-- ADDITIVE ONLY, DARK. Naming per the DMEM common block: the generation compared
-- at commit is `claim_generation`; "admitted generation" (migration 133) is a
-- different thing and stays; nothing is named just `generation`.
--
--   memories.claim_generation      NOT NULL DEFAULT 1 on the claim. It ADVANCES IN
--                                  THE DATABASE: the trigger below bumps it
--                                  whenever the revision's lifecycle state changes
--                                  (active → superseded / dismissed / erased, or an
--                                  epistemic state change) — so a dependent that
--                                  recorded generation N is stale the moment the
--                                  claim moved, without any writer remembering to
--                                  bump it. The existing 085 columns keep their
--                                  meaning exactly; existing rows read 1.
--   dependents (nullable)          the generation a dependent was derived under.
--                                  NULL = legacy, not generation-bound (W3's
--                                  dry-run backfill decides; W4's writers compare
--                                  a non-null value at their commit boundary):
--                                  memory_dependencies, reconciliation_matches,
--                                  reconciliation_evaluations, client_rules,
--                                  firm_facts, client_evidence_requests,
--                                  memory_candidates.expected_claim_generation
--                                  (the claim generation a candidate was staged
--                                  against — promotion must find it current).
--   local_jobs.claim_generation    NOT NULL DEFAULT 1 — the compare-and-swap
--                                  generation `claimNextLocalJob` checks at the
--                                  dispatch linearization point (localJobQueue.js):
--                                  an invalidation bumps it and a claimer holding
--                                  the old generation LOSES the claim. Every
--                                  existing row reads 1 and the legacy claim (no
--                                  expected generation) is byte-identical.
--   loop_event_outbox              claim_generation / expected_claim_generation +
--                                  the dispatch-fence columns (who acquired the
--                                  fence, when) so the outbox worker's crossing
--                                  from queued to dispatching is a recorded,
--                                  generation-checked event (doctrine §2.6).

-- ── the claim ────────────────────────────────────────────────────────────────
alter table memories add column if not exists claim_generation bigint not null default 1;
alter table memories drop constraint if exists memories_claim_generation_positive;
alter table memories add constraint memories_claim_generation_positive check (claim_generation >= 1);

create or replace function memories_claim_generation_advance() returns trigger
  language plpgsql as $$
begin
  if new.record_state is distinct from old.record_state
     or new.epistemic_state is distinct from old.epistemic_state then
    new.claim_generation := old.claim_generation + 1;
  elsif new.claim_generation < old.claim_generation then
    raise exception
      'memories_claim_generation: the claim generation never moves backwards (% → %)', old.claim_generation, new.claim_generation
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists memories_claim_generation_advance on memories;
create trigger memories_claim_generation_advance
  before update on memories
  for each row execute function memories_claim_generation_advance();

-- ── the dependents (nullable: legacy = not generation-bound) ─────────────────
alter table memory_dependencies add column if not exists claim_generation bigint;
alter table memory_candidates add column if not exists expected_claim_generation bigint;
alter table reconciliation_matches add column if not exists claim_generation bigint;
alter table reconciliation_evaluations add column if not exists claim_generation bigint;
alter table client_rules add column if not exists claim_generation bigint;
alter table firm_facts add column if not exists claim_generation bigint;
alter table client_evidence_requests add column if not exists claim_generation bigint;

-- ── the dispatch fence columns ───────────────────────────────────────────────
alter table local_jobs add column if not exists claim_generation bigint not null default 1;
alter table local_jobs drop constraint if exists local_jobs_claim_generation_positive;
alter table local_jobs add constraint local_jobs_claim_generation_positive check (claim_generation >= 1);

alter table loop_event_outbox add column if not exists claim_generation bigint;
alter table loop_event_outbox add column if not exists expected_claim_generation bigint;
alter table loop_event_outbox add column if not exists dispatch_fence_worker_id text;
alter table loop_event_outbox add column if not exists dispatch_fence_acquired_at timestamptz;
