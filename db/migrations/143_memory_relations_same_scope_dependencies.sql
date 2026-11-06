-- 143 — DMEM-R1 W2 (audit §4.3 reservation 143): same-owner / same-scope
-- constraints on `memory_relations`, and the dependency rows that tie a claim to
-- what was derived from it.
--
-- ADDITIVE ONLY, DARK. `memory_relations` (085) has NO reader on the tree
-- (audit SF-M-34) and its only writer is the dark V2 supersede path; the guard
-- below changes nothing that path does today (a supersession is same-slot by
-- construction) and refuses what the doctrine forbids (INV-12: no relation
-- crosses an unauthorized tenant / legal-entity boundary; plan v1.0 W2:
-- "Same-owner/scope constraints on relations and dependencies"). A cross-scope
-- relation fails at the DATABASE boundary, whatever JS asked for.
--
-- memory_dependencies: one row per (claim, dependent object) — the plane-S
-- objects that were derived from, or decided under, a claim revision (a
-- projection, a match, an evaluation, an ask, a rule row, a fact row, a decision,
-- a commitment). Correction causality (W4, doctrine §2.6 step 4) reads these to
-- make every dependent ineligible atomically; W3's projection gateway writes the
-- 'projection' rows. Two things are enforced in the database: the claim must
-- exist in the SAME tenant (an orphan or cross-tenant dependency is refused), and
-- the dependent must EXIST in the table its kind names (the closed kind → table
-- map below; a dependency on a row that is not there is an orphan write). The
-- row's identity is frozen after insert; only its state may move
-- (current → stale → invalidated), never backwards.

-- ── memory_relations: same tenant, same lifecycle owner, same scope ──────────
create or replace function memory_relations_same_scope_guard() returns trigger
  language plpgsql as $$
declare
  src memories%rowtype;
  tgt memories%rowtype;
begin
  select * into src from memories where memory_id = new.source_memory_id;
  select * into tgt from memories where memory_id = new.target_memory_id;
  if src.memory_id is null or tgt.memory_id is null then
    raise exception
      'memory_relations_scope: relation names a memory that does not exist (source %, target %)',
      new.source_memory_id, new.target_memory_id
      using errcode = 'foreign_key_violation';
  end if;
  if src.tenant_id <> new.tenant_id or tgt.tenant_id <> new.tenant_id then
    raise exception
      'memory_relations_scope: relation tenant % does not match both memories (source %, target %) — INV-12',
      new.tenant_id, src.tenant_id, tgt.tenant_id
      using errcode = 'check_violation';
  end if;
  if src.lifecycle_owner_type <> tgt.lifecycle_owner_type or src.lifecycle_owner_id <> tgt.lifecycle_owner_id then
    raise exception
      'memory_relations_scope: cross-owner relation refused (source owner %:%, target owner %:%) — a relation never crosses a lifecycle owner (INV-12)',
      src.lifecycle_owner_type, src.lifecycle_owner_id, tgt.lifecycle_owner_type, tgt.lifecycle_owner_id
      using errcode = 'check_violation';
  end if;
  if src.scope_type <> tgt.scope_type or src.scope_id <> tgt.scope_id then
    raise exception
      'memory_relations_scope: cross-scope relation refused (source scope %:%, target scope %:%) — a relation never crosses a scope (INV-12)',
      src.scope_type, src.scope_id, tgt.scope_type, tgt.scope_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists memory_relations_same_scope on memory_relations;
create trigger memory_relations_same_scope
  before insert or update on memory_relations
  for each row execute function memory_relations_same_scope_guard();

-- ── memory_dependencies ──────────────────────────────────────────────────────
create table if not exists memory_dependencies (
  id               bigint generated always as identity primary key,
  tenant_id        text not null references firms(id) on delete cascade,
  memory_id        text not null references memories(memory_id) on delete cascade,
  memory_revision  integer not null check (memory_revision >= 1),
  dependent_kind   text not null check (dependent_kind in
                     ('projection', 'match', 'evaluation', 'ask', 'rule', 'fact', 'decision', 'commitment')),
  dependent_id     text not null,
  state            text not null default 'current' check (state in ('current', 'stale', 'invalidated')),
  recorded_at      timestamptz not null default now(),
  invalidated_at   timestamptz,
  invalidation_reason text,
  constraint memory_dependencies_invalidation_is_stamped check (
    (state = 'current' and invalidated_at is null)
    or (state <> 'current' and invalidated_at is not null)
  )
);

create unique index if not exists memory_dependencies_claim_dependent_idx
  on memory_dependencies (memory_id, dependent_kind, dependent_id);
create index if not exists memory_dependencies_dependent_idx
  on memory_dependencies (tenant_id, dependent_kind, dependent_id);

create or replace function memory_dependencies_guard() returns trigger
  language plpgsql as $$
declare
  claim_tenant text;
  dependent_table text;
  dependent_key text;
  found_dependent boolean;
begin
  if tg_op = 'UPDATE' then
    -- Identity is frozen; only the state axis moves, and only forwards.
    if new.tenant_id <> old.tenant_id or new.memory_id <> old.memory_id
       or new.memory_revision <> old.memory_revision or new.dependent_kind <> old.dependent_kind
       or new.dependent_id <> old.dependent_id or new.recorded_at <> old.recorded_at then
      raise exception
        'memory_dependencies_frozen: a dependency row''s identity is immutable (DMEM-R1 W2); record a new row instead'
        using errcode = 'restrict_violation';
    end if;
    if (old.state = 'stale' and new.state = 'current') or (old.state = 'invalidated' and new.state <> 'invalidated') then
      raise exception
        'memory_dependencies_state: % → % is not a forward transition (INV-11: a stale or invalidated dependent cannot regain authority)',
        old.state, new.state
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select tenant_id into claim_tenant from memories where memory_id = new.memory_id;
  if claim_tenant is null then
    raise exception
      'memory_dependencies_scope: memory % does not exist (orphan dependency refused)', new.memory_id
      using errcode = 'foreign_key_violation';
  end if;
  if claim_tenant <> new.tenant_id then
    raise exception
      'memory_dependencies_scope: dependency tenant % does not match the claim tenant % (INV-12)', new.tenant_id, claim_tenant
      using errcode = 'check_violation';
  end if;

  -- The closed kind → table map: the dependent must exist where its kind says.
  case new.dependent_kind
    when 'projection' then dependent_table := 'memory_projections'; dependent_key := 'projection_id';
    when 'match' then dependent_table := 'reconciliation_matches'; dependent_key := 'id';
    when 'evaluation' then dependent_table := 'reconciliation_evaluations'; dependent_key := 'id';
    when 'ask' then dependent_table := 'client_evidence_requests'; dependent_key := 'id';
    when 'rule' then dependent_table := 'client_rules'; dependent_key := 'id';
    when 'fact' then dependent_table := 'firm_facts'; dependent_key := 'id';
    when 'decision' then dependent_table := 'llm_decisions'; dependent_key := 'id';
    when 'commitment' then dependent_table := 'outbound_actions'; dependent_key := 'id';
  end case;
  if to_regclass(dependent_table) is null then
    raise exception
      'memory_dependencies_orphan: dependent table % is not present on this database', dependent_table
      using errcode = 'undefined_table';
  end if;
  execute format('select exists (select 1 from %I where %I = $1)', dependent_table, dependent_key)
    into found_dependent using new.dependent_id;
  if not found_dependent then
    raise exception
      'memory_dependencies_orphan: % % does not exist — an orphan dependency write is refused (DMEM-R1 W2)',
      new.dependent_kind, new.dependent_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists memory_dependencies_guard on memory_dependencies;
create trigger memory_dependencies_guard
  before insert or update on memory_dependencies
  for each row execute function memory_dependencies_guard();

-- Dependencies die with their claim / tenant, never alone.
create or replace function memory_dependencies_delete_guard() returns trigger
  language plpgsql as $$
begin
  if not exists (select 1 from memories where memory_id = old.memory_id)
     or not exists (select 1 from firms where id = old.tenant_id) then
    return old;
  end if;
  raise exception
    'memory_dependencies_append_only: DELETE on memory_dependencies is forbidden (DMEM-R1 W2) outside the claim / tenant lifecycle cascade — invalidate, never delete'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists memory_dependencies_delete_guard on memory_dependencies;
create trigger memory_dependencies_delete_guard
  before delete on memory_dependencies
  for each row execute function memory_dependencies_delete_guard();

-- ── RLS-native (the 085 posture) ─────────────────────────────────────────────
alter table memory_dependencies enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on memory_dependencies from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on memory_dependencies from authenticated;
  end if;
end $$;
