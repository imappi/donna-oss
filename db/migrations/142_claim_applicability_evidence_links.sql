-- 142 — DMEM-R1 W2 (audit §4.3 reservation 142): claim applicability, the
-- evidence-link store, and the INV-25 provenance fields on `memories` — plus the
-- same applicability / business-effective interval on the two transitional
-- projections (`client_rules`, `firm_facts`) that W3 rebuilds from claims.
--
-- ADDITIVE ONLY, DARK. Nullable or defaulted columns, no meaning change, no
-- backfill (W3's dry-run). The ONE constraint this migration touches on an
-- existing column is a WIDENING: 085 pinned `schema_version = 'memory.v1'`; the
-- memory.v2 contract (memoryModel.js) is now admissible alongside it. The version
-- is a FIELD on every row (never inferred from which columns are filled): a v1
-- row stays v1 and readable forever; only a row that declares 'memory.v2' must
-- carry the v2 shape (`memories_v2_carries_applicability`).
--
-- Applicability (doctrine §2.5, §4.1): every dimension the fact-class contract
-- requires is an EXPLICIT typed value — `{ kind: 'value', value }`,
-- `{ kind: 'any' }` (a permitted wildcard, declared) or `{ kind: 'unspecified' }`.
-- A null column is a legacy row whose dimensions were never declared; it is NOT
-- a wildcard (memoryModel.js applicabilityMatches treats unspecified as "matches
-- only a context that does not require the dimension").
--
-- Business-effective time is a DATE interval, half-open `[effective_from,
-- effective_to)` (doctrine §4.1), normalized in the legal entity's accounting
-- timezone by the writer — distinct from the 085 `valid_from` / `valid_until`
-- truth-validity instants and from `retain_until` retention. The projections
-- name theirs `valid_from` / `valid_until` because that is the vocabulary the
-- S05 acceptance fixture and the RT-07 date discipline already use for rules.
--
-- memory_evidence_links (INV-08, plan v1.0 W2 "Evidence links that distinguish
-- repeated processing from independent corroboration"): one row per (claim,
-- evidence identity). `corroboration_class` is a COLUMN, decided at write time
-- from the dependence group — 'independent' when the link's dependence_group is
-- new for the claim, 'repeated' when the claim already has support from that
-- group. Two things are enforced IN THE DATABASE: a claim can hold at most ONE
-- independent link per dependence group (re-OCR / paraphrase / re-observation of
-- the same source can only ever be 'repeated' — the partial unique index), and a
-- link's tenant must be its claim's tenant (the trigger; INV-12).

-- ── memories: the v2 contract becomes admissible; applicability + provenance ──
alter table memories drop constraint if exists memories_schema_version_check;
alter table memories add constraint memories_schema_version_check
  check (schema_version in ('memory.v1', 'memory.v2'));

alter table memories add column if not exists applicability jsonb;
alter table memories add column if not exists applicability_version text;
alter table memories add column if not exists effective_from date;
alter table memories add column if not exists effective_to date;
alter table memories add column if not exists evidence_fingerprint text;
-- INV-25 provenance: source object / excerpt, raw + normalized value, validation
-- confidence, confirmation history, correction / supersession / invalidation
-- reason, consuming decision references, the promotion receipt.
alter table memories add column if not exists source_object_type text;
alter table memories add column if not exists source_object_id text;
alter table memories add column if not exists source_object_version text;
alter table memories add column if not exists source_excerpt text;
alter table memories add column if not exists raw_value jsonb;
alter table memories add column if not exists normalized_value jsonb;
alter table memories add column if not exists validation_confidence text;
alter table memories add column if not exists confirmation_history jsonb not null default '[]'::jsonb;
alter table memories add column if not exists supersession_reason text;
alter table memories add column if not exists invalidation_reason text;
alter table memories add column if not exists consuming_decision_refs jsonb not null default '[]'::jsonb;
alter table memories add column if not exists promotion_receipt_id text;

alter table memories drop constraint if exists memories_applicability_shape;
alter table memories add constraint memories_applicability_shape
  check (applicability is null or jsonb_typeof(applicability) = 'object');
alter table memories drop constraint if exists memories_v2_carries_applicability;
alter table memories add constraint memories_v2_carries_applicability
  check (schema_version <> 'memory.v2' or applicability is not null);
alter table memories drop constraint if exists memories_effective_interval_half_open;
alter table memories add constraint memories_effective_interval_half_open
  check (effective_from is null or effective_to is null or effective_from < effective_to);
alter table memories drop constraint if exists memories_validation_confidence_vocabulary;
alter table memories add constraint memories_validation_confidence_vocabulary
  check (validation_confidence is null or validation_confidence in ('low', 'medium', 'high'));
alter table memories drop constraint if exists memories_confirmation_history_is_array;
alter table memories add constraint memories_confirmation_history_is_array
  check (jsonb_typeof(confirmation_history) = 'array');
alter table memories drop constraint if exists memories_consuming_decision_refs_is_array;
alter table memories add constraint memories_consuming_decision_refs_is_array
  check (jsonb_typeof(consuming_decision_refs) = 'array');

-- ── The transitional projections carry the same dimensions (W3 fills them) ──
alter table client_rules add column if not exists valid_from date;
alter table client_rules add column if not exists valid_until date;
alter table client_rules add column if not exists jurisdiction text;
alter table client_rules add column if not exists applicability jsonb;
alter table client_rules drop constraint if exists client_rules_effective_interval_half_open;
alter table client_rules add constraint client_rules_effective_interval_half_open
  check (valid_from is null or valid_until is null or valid_from < valid_until);
alter table client_rules drop constraint if exists client_rules_applicability_shape;
alter table client_rules add constraint client_rules_applicability_shape
  check (applicability is null or jsonb_typeof(applicability) = 'object');

alter table firm_facts add column if not exists applicability jsonb;
alter table firm_facts add column if not exists effective_from date;
alter table firm_facts add column if not exists effective_to date;
alter table firm_facts drop constraint if exists firm_facts_effective_interval_half_open;
alter table firm_facts add constraint firm_facts_effective_interval_half_open
  check (effective_from is null or effective_to is null or effective_from < effective_to);
alter table firm_facts drop constraint if exists firm_facts_applicability_shape;
alter table firm_facts add constraint firm_facts_applicability_shape
  check (applicability is null or jsonb_typeof(applicability) = 'object');

-- ── memory_evidence_links ────────────────────────────────────────────────────
create table if not exists memory_evidence_links (
  id                    bigint generated always as identity primary key,
  tenant_id             text not null references firms(id) on delete cascade,
  memory_id             text not null references memories(memory_id) on delete cascade,
  -- The observation-envelope identity (memoryModel.js buildEvidenceIdentity):
  -- deterministic over the source object identity + version + excerpt digest.
  evidence_id           text not null,
  evidence_kind         text not null check (evidence_kind in
                          ('document', 'message', 'transaction', 'correction', 'registry', 'observation', 'assertion')),
  source_object_type    text,
  source_object_id      text,
  source_object_version text,
  -- Derivatives of one underlying source share the group: the unit of
  -- independence (INV-08).
  dependence_group      text not null,
  corroboration_class   text not null check (corroboration_class in ('independent', 'repeated')),
  observed_at           timestamptz,
  recorded_at           timestamptz not null default now(),
  recorded_by_principal_id text,
  -- Content-free by contract (ids, digests, versions).
  payload               jsonb not null default '{}'::jsonb
);

-- One link per (claim, evidence identity): a same-source replay is idempotent.
create unique index if not exists memory_evidence_links_memory_evidence_idx
  on memory_evidence_links (memory_id, evidence_id);
-- At most ONE independent corroboration per dependence group per claim.
create unique index if not exists memory_evidence_links_one_independent_per_group_idx
  on memory_evidence_links (memory_id, dependence_group) where corroboration_class = 'independent';
create index if not exists memory_evidence_links_tenant_group_idx
  on memory_evidence_links (tenant_id, dependence_group);

create or replace function memory_evidence_links_same_tenant_guard() returns trigger
  language plpgsql as $$
declare
  claim_tenant text;
begin
  select tenant_id into claim_tenant from memories where memory_id = new.memory_id;
  if claim_tenant is null then
    raise exception
      'memory_evidence_links_scope: memory % does not exist (orphan evidence link refused)', new.memory_id
      using errcode = 'foreign_key_violation';
  end if;
  if claim_tenant <> new.tenant_id then
    raise exception
      'memory_evidence_links_scope: evidence link tenant % does not match the claim tenant % (INV-12: no evidence crosses a tenant boundary)',
      new.tenant_id, claim_tenant
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists memory_evidence_links_same_tenant on memory_evidence_links;
create trigger memory_evidence_links_same_tenant
  before insert or update on memory_evidence_links
  for each row execute function memory_evidence_links_same_tenant_guard();

-- Append-only: a link is a fact about what supported the claim when. UPDATE is
-- forbidden; DELETE only as the tail of the claim's / tenant's lifecycle death.
create or replace function memory_evidence_links_append_only_guard() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'memory_evidence_links_append_only: UPDATE on memory_evidence_links is forbidden (DMEM-R1 W2, INV-08) — evidence support is appended, never rewritten'
      using errcode = 'restrict_violation';
  end if;
  if not exists (select 1 from memories where memory_id = old.memory_id)
     or not exists (select 1 from firms where id = old.tenant_id) then
    return old;
  end if;
  raise exception
    'memory_evidence_links_append_only: DELETE on memory_evidence_links is forbidden (DMEM-R1 W2) outside the claim / tenant lifecycle cascade'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists memory_evidence_links_append_only on memory_evidence_links;
create trigger memory_evidence_links_append_only
  before update or delete on memory_evidence_links
  for each row execute function memory_evidence_links_append_only_guard();

-- ── RLS-native (the 085 posture) ─────────────────────────────────────────────
alter table memory_evidence_links enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on memory_evidence_links from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on memory_evidence_links from authenticated;
  end if;
end $$;
