-- 141 — DMEM-R1 W2 (docs/plan-2026-09-02-memory-remediation-slices.md §5 W2;
-- docs/audit-2026-09-04-memory-re-baseline.md §4.3 reservation 141): the fully
-- scoped candidate identity + the append-only candidate state events.
--
-- ADDITIVE ONLY, DARK. Every column below is nullable or defaulted, no existing
-- column changes meaning, nothing is backfilled (a backfill is W3's dry-run) and
-- no live writer fills any of it while MEMORY_MODEL_V2 is off: memoryCandidates.js
-- keeps its byte-identical statements (its scoped-identity wiring is sequenced
-- AFTER W1's fail-closed actions — audit §4.3 collisions). The fixtures under
-- server/donna/dmemW2*.test.js are the only rows these receive until then.
--
-- What the plan v1.0 "Wave 2" list requires of candidate identity, column by column
-- (doctrine §2.2: "Candidate identity is deterministic over claim kind, fully scoped
-- logical slot, normalized proposed value, and independent evidence set"):
--   scoped_identity          the opaque v2 id (memoryModel.js buildScopedCandidateIdentity:
--                            tenant + legal entity + subject class + applicability +
--                            normalized value + evidence-set fingerprint). The legacy
--                            `id` (036) stays the primary key; the two coexist until
--                            W3's backfill and W6's cutover. Unique where present.
--   subject_class            the fact class the candidate proposes for (its
--                            fact-class contract decides thresholds and conflicts).
--   applicability            the explicit dimensions (memoryModel.js applicability
--                            shape: every dimension is value | any | unspecified —
--                            an absent dimension is unspecified, NEVER a wildcard).
--   normalized_value         the normalized proposed value (raw stays in provenance).
--   evidence_fingerprint     the digest of the INDEPENDENT evidence set.
--   dependence_group         the evidence dependence group the staging evidence
--                            belongs to (derivatives of one source share it — a
--                            re-OCR or paraphrase is the same group, never new
--                            support; INV-08).
--   origin / asserted_by     the assertion origin vocabulary + principal (INV-25).
--   candidate_version        the row's optimistic-concurrency version. W1's
--                            fail-closed promote/dismiss present `expected_version`
--                            and compare it against THIS column; every state event
--                            records the version it was written at.
--   review_deadline_at /     the review clock and the expiry clock (doctrine §4.1:
--   expires_at               review time and retention time are distinct axes).
--   rejected_evidence_       evidence ids whose re-observation must not resurrect a
--   suppression              dismissed candidate (the firm_facts "human no" discipline,
--                            made data).
--
-- memory_candidate_events is the append-only lifecycle log (plan v1.0 W2:
-- "Database-enforced append-only semantics for lifecycle"). Enforced IN THE
-- DATABASE by trigger (the 119 / 037 shape, errcode restrict_violation):
--   UPDATE is forbidden outright — an event is a fact about the past.
--   DELETE is forbidden EXCEPT as the tail of its parent's lifecycle death: the
--   candidate row is gone (memory_candidates ON DELETE CASCADE — the client-delete
--   purge, rail "firm memory dies with its client") or the firm row is gone (the
--   firms cascade). Both are recognised the way 119 recognises the client-delete
--   set-null cascade: the parent no longer exists when the referencing row's
--   trigger fires. A direct `delete from memory_candidate_events` while the
--   candidate still exists is refused. No GUC hatch — nothing in JS can widen it.

alter table memory_candidates add column if not exists scoped_identity text;
alter table memory_candidates add column if not exists subject_class text;
alter table memory_candidates add column if not exists applicability jsonb;
alter table memory_candidates add column if not exists normalized_value jsonb;
alter table memory_candidates add column if not exists evidence_fingerprint text;
alter table memory_candidates add column if not exists dependence_group text;
alter table memory_candidates add column if not exists origin text;
alter table memory_candidates add column if not exists asserted_by_principal_id text;
alter table memory_candidates add column if not exists candidate_version integer not null default 1;
alter table memory_candidates add column if not exists review_deadline_at timestamptz;
alter table memory_candidates add column if not exists expires_at timestamptz;
alter table memory_candidates add column if not exists rejected_evidence_suppression jsonb;

alter table memory_candidates drop constraint if exists memory_candidates_candidate_version_positive;
alter table memory_candidates add constraint memory_candidates_candidate_version_positive
  check (candidate_version >= 1);
alter table memory_candidates drop constraint if exists memory_candidates_applicability_shape;
alter table memory_candidates add constraint memory_candidates_applicability_shape
  check (applicability is null or jsonb_typeof(applicability) = 'object');
alter table memory_candidates drop constraint if exists memory_candidates_origin_vocabulary;
alter table memory_candidates add constraint memory_candidates_origin_vocabulary
  check (origin is null or origin in ('owner_asserted', 'operator_asserted', 'distilled_from_document', 'third_party_reported', 'model_inferred'));

-- The scoped identity is unique where present (legacy rows stay null).
create unique index if not exists memory_candidates_scoped_identity_idx
  on memory_candidates (firm_id, scoped_identity) where scoped_identity is not null;
create index if not exists memory_candidates_dependence_group_idx
  on memory_candidates (firm_id, dependence_group) where dependence_group is not null;

create table if not exists memory_candidate_events (
  id              bigint generated always as identity primary key,
  firm_id         text not null references firms(id) on delete cascade,
  client_id       text not null,
  candidate_id    text not null references memory_candidates(id) on delete cascade,
  -- Monotonic per candidate; the unique index is the concurrency backstop.
  event_seq       integer not null check (event_seq >= 1),
  event_type      text not null check (event_type in
                    ('staged', 'evidence_appended', 'conflicted', 'version_bumped',
                     'promoted', 'dismissed', 'expired', 'superseded', 'erased')),
  from_status     text,
  to_status       text,
  -- The candidate_version the event was written at (W1's expected_version compare).
  candidate_version integer not null check (candidate_version >= 1),
  actor_type      text not null,
  actor_id        text,
  reason          text,
  -- Content-free by contract: ids, digests, classes, states — never subject/fact text.
  payload         jsonb not null default '{}'::jsonb,
  recorded_at     timestamptz not null default now()
);

create unique index if not exists memory_candidate_events_candidate_seq_idx
  on memory_candidate_events (candidate_id, event_seq);
create index if not exists memory_candidate_events_firm_client_idx
  on memory_candidate_events (firm_id, client_id, recorded_at);

create or replace function memory_candidate_events_append_only_guard() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'memory_candidate_events_append_only: UPDATE on memory_candidate_events is forbidden (DMEM-R1 W2, INV-04/INV-17) — a lifecycle event is a fact about the past; corrections append a new event'
      using errcode = 'restrict_violation';
  end if;
  -- DELETE: only as the tail of the parent's lifecycle death (the parent row is
  -- already gone when a referential cascade reaches this row).
  if not exists (select 1 from memory_candidates where id = old.candidate_id)
     or not exists (select 1 from firms where id = old.firm_id) then
    return old;
  end if;
  raise exception
    'memory_candidate_events_append_only: DELETE on memory_candidate_events is forbidden (DMEM-R1 W2) outside the candidate / firm lifecycle cascade — events die with their candidate, never alone'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists memory_candidate_events_append_only on memory_candidate_events;
create trigger memory_candidate_events_append_only
  before update or delete on memory_candidate_events
  for each row execute function memory_candidate_events_append_only_guard();

-- ── RLS-native (the 036 / 085 posture) ───────────────────────────────────────
alter table memory_candidate_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on memory_candidate_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on memory_candidate_events from authenticated;
  end if;
end $$;
