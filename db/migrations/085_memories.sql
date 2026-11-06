-- Donna — BizOS Slice 2b: the governed `memories` store + `memory_relations` +
-- the memory-candidate v2 target columns (design-donna-bizos-slice-2-memory-v2.md
-- §3-§8, directionally approved with pinned gates, Kari 2026-07-12).
--
-- `memories` hosts all NEW memory under the memory.v1 contract (memoryModel.js —
-- the CHECK vocabularies below are pinned to that runtime by migrations.test.js).
-- firm_facts stays FROZEN and authoritative for its legacy lifecycle (§7 two-store
-- transitional topology); nothing new lands there.
--
-- The load-bearing structural invariants, in the TABLE (not just the validator):
--   - ONE ACTIVE VERSION PER SLOT: partial unique index on memory_key where
--     record_state = 'active'. A changed value is a NEW memory_id (revision+1,
--     `supersedes` link) — receipted content never changes under its id.
--   - EXACTLY ONE LIFECYCLE ROOT: four typed root columns (owner_user_id /
--     owner_organisation_id / owner_client_id / owner_ephemeral_ref), CHECKed to
--     match lifecycle_owner_type and equal lifecycle_owner_id. Deletion/retention
--     authority is never ambiguous (§6).
--   - ERASED IS SCRUBBED: record_state = 'erased' requires the content columns
--     (structured_value / source_text / source_refs / observed_alias) null and
--     erased_at set — scrub-in-place is one unambiguous operation; the id/key stay
--     to prevent accidental resurrection (§6). Non-erased rows must CARRY their
--     source_text + source_refs (the words as said are part of the contract).
--   - QUARANTINE: an ACTIVE row with a distilled_from_document / third_party_reported
--     origin must carry activation_confirmation — third-party content never mints
--     active memory silently (§8; the validator enforces the confirmation's shape).
--   - REFUSED CLASSES CANNOT REST HERE: predicate_class allows only the storable
--     classes (contextual / authoritative_attribute_reference / unclassified) —
--     prohibited_secret is refused outright and preference_candidate routes to the
--     D-PA-5 preference contract, so neither may exist as a row.
--
-- Lifecycle-root columns are PLAIN (no users/clients FK — the firm_facts / Loops
-- pattern): lifecycle death is an explicit, in-transaction purge
-- (purgeMemoriesForDeletedLegalEntity in memoriesDb.js, wired into the client
-- delete), not a silent cascade. tenant_id DOES cascade from firms — the tenant
-- boundary is absolute.
--
-- memory_relations: contradiction/confirmation/etc. are many-to-many EDGES, never
-- a single nullable pointer (§4 amendment 7). supersedes_memory_id stays on-row as
-- well (the common single-parent case) — the edge table is the general form.
--
-- memory_candidates (036) gains the §8 amendment-18 columns: target_contract
-- (which contract a promote mints into — the ONE governed staging transition,
-- promoteMemoryCandidate, routes on it) + contract_payload (the versioned v2
-- candidate payload; 036's flat columns cannot represent the v2 contract) +
-- minted_memory_id (the promote receipt for memory-targeted candidates).
--
-- Writers: server/donna/memoriesDb.js — dark behind MEMORY_MODEL_V2 (config-plane,
-- envFallback false; never an env pair). Nothing reads or writes these tables live.

create table if not exists memories (
  -- Identity (§3): two identities + a version. memory_id is ONE immutable
  -- assertion/version ('mem-…'); memory_key the keyed-HMAC logical slot ('memk-…').
  memory_id       text primary key,
  memory_key      text not null,
  revision        integer not null check (revision >= 1),
  content_hash    text not null,
  schema_version  text not null default 'memory.v1' check (schema_version = 'memory.v1'),

  -- Five separated identity concerns (§3) — never inferred from one another.
  tenant_id       text not null references firms(id) on delete cascade,
  scope_type      text not null check (scope_type in
                    ('user_private', 'organisation', 'legal_entity', 'team', 'project', 'contact_relationship')),
  scope_id        text not null,
  lifecycle_owner_type text not null check (lifecycle_owner_type in
                    ('user', 'organisation', 'legal_entity', 'ephemeral')),
  lifecycle_owner_id   text not null,
  -- The typed lifecycle roots (exactly one non-null, matching the owner type).
  owner_user_id         text,
  owner_organisation_id text,
  owner_client_id       text,
  owner_ephemeral_ref   text,
  subject_type    text not null,
  subject_id      text not null,
  observed_alias  text,

  -- Content (§4).
  kind            text not null check (kind in
                    ('assertion', 'relationship_context', 'episodic_context', 'temporal_marker')),
  predicate       text not null,
  predicate_class text not null check (predicate_class in
                    ('contextual', 'authoritative_attribute_reference', 'unclassified')),
  structured_value jsonb,
  source_text     text,
  source_refs     jsonb,

  -- Provenance (§4 amendment 6): origin ≠ transport ≠ extraction model.
  asserted_by_principal_id text not null,
  assertion_origin text not null check (assertion_origin in
                    ('owner_asserted', 'operator_asserted', 'distilled_from_document', 'third_party_reported')),
  transport_actor text,
  extraction_model_id text,
  extraction_prompt_version text,
  validator_version text,
  activation_confirmation jsonb,

  -- Time: truth validity and data retention are DIFFERENT axes (§4).
  observed_at     timestamptz not null,
  recorded_at     timestamptz not null,
  valid_from      timestamptz,
  valid_until     timestamptz,
  retention_policy_id text,
  retain_until    timestamptz,
  review_after    timestamptz,
  last_confirmed_at timestamptz,

  -- Confidences never collapsed; truth_confidence null = honest unknown.
  assertion_confidence text not null check (assertion_confidence in ('low', 'medium', 'high')),
  truth_confidence text check (truth_confidence is null or truth_confidence in ('low', 'medium', 'high')),

  -- Two independent sensitivity axes (§5 amendment 16).
  confidentiality text not null check (confidentiality in ('internal', 'confidential', 'restricted')),
  personal_data_class text not null check (personal_data_class in ('none', 'personal', 'sensitive_personal')),

  -- Two clean state axes (§4 amendment 7).
  record_state    text not null default 'active' check (record_state in
                    ('active', 'dismissed', 'superseded', 'erased')),
  epistemic_state text not null default 'asserted' check (epistemic_state in
                    ('asserted', 'verified', 'disputed', 'contradicted', 'unknown')),
  record_version  integer not null default 1 check (record_version >= 1),
  supersedes_memory_id text,   -- plain column (see header); the general form is memory_relations
  erased_at       timestamptz,
  creation_provenance jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint memories_one_lifecycle_root check (
    (lifecycle_owner_type = 'user'
       and owner_user_id is not null and owner_user_id = lifecycle_owner_id
       and owner_organisation_id is null and owner_client_id is null and owner_ephemeral_ref is null)
    or (lifecycle_owner_type = 'organisation'
       and owner_organisation_id is not null and owner_organisation_id = lifecycle_owner_id
       and owner_user_id is null and owner_client_id is null and owner_ephemeral_ref is null)
    or (lifecycle_owner_type = 'legal_entity'
       and owner_client_id is not null and owner_client_id = lifecycle_owner_id
       and owner_user_id is null and owner_organisation_id is null and owner_ephemeral_ref is null)
    or (lifecycle_owner_type = 'ephemeral'
       and owner_ephemeral_ref is not null and owner_ephemeral_ref = lifecycle_owner_id
       and owner_user_id is null and owner_organisation_id is null and owner_client_id is null)
  ),
  constraint memories_erased_is_scrubbed check (
    (record_state = 'erased'
       and structured_value is null and source_text is null
       and source_refs is null and observed_alias is null
       and erased_at is not null)
    or (record_state <> 'erased'
       and erased_at is null
       and source_text is not null and source_refs is not null)
  ),
  constraint memories_quarantine_confirmed check (
    record_state <> 'active'
    or assertion_origin not in ('distilled_from_document', 'third_party_reported')
    or activation_confirmation is not null
  ),
  constraint memories_user_private_user_lifecycle check (
    scope_type <> 'user_private' or lifecycle_owner_type = 'user'
  )
);

-- One ACTIVE version per logical slot (§3).
create unique index if not exists memories_one_active_per_key
  on memories (memory_key) where record_state = 'active';
-- Revisions are monotonic within a slot; the unique index is the concurrency backstop.
create unique index if not exists memories_key_revision_idx
  on memories (memory_key, revision);
create index if not exists memories_tenant_scope_idx
  on memories (tenant_id, scope_type, scope_id, record_state);
create index if not exists memories_tenant_subject_idx
  on memories (tenant_id, subject_type, subject_id);
create index if not exists memories_lifecycle_root_idx
  on memories (tenant_id, lifecycle_owner_type, lifecycle_owner_id);

create table if not exists memory_relations (
  tenant_id        text not null references firms(id) on delete cascade,
  source_memory_id text not null references memories(memory_id) on delete cascade,
  relation         text not null check (relation in
                     ('supersedes', 'contradicts', 'confirms', 'duplicates', 'corrects')),
  target_memory_id text not null references memories(memory_id) on delete cascade,
  created_by       text,
  created_at       timestamptz not null default now(),
  primary key (source_memory_id, relation, target_memory_id),
  constraint memory_relations_no_self check (source_memory_id <> target_memory_id)
);

create index if not exists memory_relations_target_idx
  on memory_relations (target_memory_id);

-- ── memory_candidates: the §8 amendment-18 v2 columns ────────────────────────
-- The ONE governed staging transition (promoteMemoryCandidate) routes on
-- target_contract: 'firm_fact' keeps the legacy saveFirmFact path byte-identical;
-- 'memory' mints into the memories store via saveMemory (promotion IS the recorded
-- activation confirmation for quarantined origins); 'preference' / 'policy' are
-- REFUSED at promote until those D-PA-5 contracts exist — a candidate routed out
-- must never silently become memory or a firm fact.
alter table memory_candidates
  add column if not exists target_contract text not null default 'firm_fact'
    check (target_contract in ('firm_fact', 'memory', 'preference', 'policy'));
alter table memory_candidates
  add column if not exists contract_payload jsonb;
alter table memory_candidates
  add column if not exists minted_memory_id text;

-- ── RLS-native (the 033/034/036 posture) ─────────────────────────────────────
-- The server connects as the table-owner role (RLS-exempt); the browser never
-- queries these tables. ENABLE (not FORCE) so the owner stays exempt; revoke the
-- Supabase anon/authenticated roles entirely. Guarded so a dev DB without those
-- roles still applies cleanly.
alter table memories enable row level security;
alter table memory_relations enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on memories from anon;
    revoke all on memory_relations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on memories from authenticated;
    revoke all on memory_relations from authenticated;
  end if;
end $$;
