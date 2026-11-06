-- 144 — DMEM-R1 W2 (audit §4.3 reservation 144): the versioned deterministic
-- projection store — `memory_projections`.
--
-- ADDITIVE ONLY, DARK. A projection is what a confirmed claim revision set
-- deterministically materializes into for the executing plane (a client_rules
-- row, a firm_facts row, a coding policy) — doctrine §2.4: "Rule materialization
-- is deterministic from confirmed claim revisions. The projection records its
-- source revision set and generation. Plane A separately records whether the
-- projection may be used." W3's projection gateway is the ONLY writer that will
-- ever fill this table; nothing on this tree writes it (fixtures only).
--
-- What is enforced IN THE DATABASE (plan v1.0 W2 exit gate):
--   unauthorized projection  a projection row must name its approval receipt
--                            (an audit_events row of the SAME firm) and every
--                            source revision must exist in the SAME tenant. A
--                            projection with no receipt, a foreign receipt, or a
--                            source claim from another tenant is refused.
--   INV-26                   the approval receipt (confirming the claim) and the
--                            activation receipt (authorizing the projection to
--                            ACT) are two columns; a projection may be 'current'
--                            with activation null — current means "the
--                            materialization is the one the rebuild produces",
--                            NOT "acts". Acting is plane A's separate transition.
--   INV-06 / temporal        one fully scoped logical slot has at most one
--   overlap                  current revision PER INSTANT: two current rows for
--                            one (tenant, kind, slot) may coexist only with
--                            disjoint half-open business-effective intervals;
--                            an overlapping current row is refused (advisory
--                            xact lock on the slot + range overlap test — the
--                            tree carries no extension, so this is a trigger,
--                            not an EXCLUDE constraint).
--   mutable history          after insert only current_state may change, and
--                            only forwards (current → superseded | retired,
--                            stamping superseded_at); every other column is
--                            frozen. A rebuild that produces different output
--                            is a NEW revision, never an edit.
--   rebuild digest           `rebuild_digest` is the canonical digest of the
--                            deterministic rebuild output (MX-1's
--                            canonicalDigest, audit §6.1), so a later rebuild
--                            proves byte-identity or supersedes.

create table if not exists memory_projections (
  projection_id        text primary key,
  tenant_id            text not null references firms(id) on delete cascade,
  -- The legal entity the projection serves (plain, the 085 pattern: lifecycle
  -- death is the explicit purge W3 adds with the writer, never a silent cascade).
  owner_client_id      text,
  projection_kind      text not null check (projection_kind in ('client_rule', 'firm_fact', 'coding_policy')),
  -- The fully scoped logical slot (independent of the value — INV-06).
  logical_slot         text not null,
  revision             integer not null check (revision >= 1),
  -- The confirmed claim revisions this materialization was built from:
  -- [{ memory_id, revision, claim_generation }] — and their set digest.
  source_revision_set  jsonb not null,
  source_revision_set_digest text not null,
  -- The generation of the source claims at build time (compared at every
  -- application writer's commit — INV-27; W4).
  claim_generation     bigint not null default 1 check (claim_generation >= 1),
  -- INV-26: two distinct receipts. approval = the claim confirmation receipt
  -- (required); activation = plane A's separate "may act" receipt (optional).
  approval_receipt_id  bigint not null,
  approval_actor_type  text not null,
  approval_actor_id    text,
  activation_receipt_id bigint,
  current_state        text not null default 'current' check (current_state in ('current', 'superseded', 'retired')),
  applicability        jsonb,
  effective_from       date,
  effective_to         date,
  rebuild_digest       text not null,
  -- Where the materialization landed (the client_rules / firm_facts row), if it did.
  target_table         text,
  target_id            text,
  built_at             timestamptz not null default now(),
  superseded_at        timestamptz,
  constraint memory_projections_source_set_is_array check (
    jsonb_typeof(source_revision_set) = 'array' and jsonb_array_length(source_revision_set) >= 1
  ),
  constraint memory_projections_applicability_shape check (
    applicability is null or jsonb_typeof(applicability) = 'object'
  ),
  constraint memory_projections_effective_interval_half_open check (
    effective_from is null or effective_to is null or effective_from < effective_to
  ),
  constraint memory_projections_superseded_is_stamped check (
    (current_state = 'current' and superseded_at is null)
    or (current_state <> 'current' and superseded_at is not null)
  )
);

create unique index if not exists memory_projections_slot_revision_idx
  on memory_projections (tenant_id, projection_kind, logical_slot, revision);
create index if not exists memory_projections_current_slot_idx
  on memory_projections (tenant_id, projection_kind, logical_slot) where current_state = 'current';
create index if not exists memory_projections_owner_idx
  on memory_projections (tenant_id, owner_client_id);

create or replace function memory_projections_guard() returns trigger
  language plpgsql as $$
declare
  source jsonb;
  source_tenant text;
  overlapping text;
begin
  if tg_op = 'UPDATE' then
    if new.projection_id <> old.projection_id or new.tenant_id <> old.tenant_id
       or new.owner_client_id is distinct from old.owner_client_id
       or new.projection_kind <> old.projection_kind or new.logical_slot <> old.logical_slot
       or new.revision <> old.revision or new.source_revision_set <> old.source_revision_set
       or new.source_revision_set_digest <> old.source_revision_set_digest
       or new.claim_generation <> old.claim_generation
       or new.approval_receipt_id <> old.approval_receipt_id
       or new.approval_actor_type <> old.approval_actor_type
       or new.approval_actor_id is distinct from old.approval_actor_id
       or new.activation_receipt_id is distinct from old.activation_receipt_id
       or new.applicability is distinct from old.applicability
       or new.effective_from is distinct from old.effective_from
       or new.effective_to is distinct from old.effective_to
       or new.rebuild_digest <> old.rebuild_digest
       or new.target_table is distinct from old.target_table
       or new.target_id is distinct from old.target_id
       or new.built_at <> old.built_at then
      raise exception
        'memory_projections_frozen: a projection revision is immutable after insert (DMEM-R1 W2) — a changed rebuild is a new revision'
        using errcode = 'restrict_violation';
    end if;
    if old.current_state <> 'current' and new.current_state <> old.current_state then
      raise exception
        'memory_projections_state: % → % is not a forward transition (a superseded or retired projection never becomes current again)',
        old.current_state, new.current_state
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Unauthorized projection: the approval receipt must be a receipt of this firm.
  if not exists (select 1 from audit_events a where a.id = new.approval_receipt_id and a.firm_id = new.tenant_id) then
    raise exception
      'memory_projections_unauthorized: approval_receipt_id % is not an audit receipt of tenant % — a projection without its confirmation receipt is refused (INV-26)',
      new.approval_receipt_id, new.tenant_id
      using errcode = 'check_violation';
  end if;
  if new.activation_receipt_id is not null
     and not exists (select 1 from audit_events a where a.id = new.activation_receipt_id and a.firm_id = new.tenant_id) then
    raise exception
      'memory_projections_unauthorized: activation_receipt_id % is not an audit receipt of tenant % (INV-26)',
      new.activation_receipt_id, new.tenant_id
      using errcode = 'check_violation';
  end if;
  -- Every source revision must be a claim of the SAME tenant.
  for source in select * from jsonb_array_elements(new.source_revision_set) loop
    if jsonb_typeof(source) <> 'object' or not (source ? 'memory_id') then
      raise exception
        'memory_projections_unauthorized: source_revision_set entries are { memory_id, revision, claim_generation } objects'
        using errcode = 'check_violation';
    end if;
    select tenant_id into source_tenant from memories where memory_id = source->>'memory_id';
    if source_tenant is null then
      raise exception
        'memory_projections_unauthorized: source claim % does not exist (an orphan source is refused)', source->>'memory_id'
        using errcode = 'foreign_key_violation';
    end if;
    if source_tenant <> new.tenant_id then
      raise exception
        'memory_projections_unauthorized: source claim % belongs to tenant %, not % (INV-12)', source->>'memory_id', source_tenant, new.tenant_id
        using errcode = 'check_violation';
    end if;
  end loop;

  -- Temporal overlap: at most one current revision per slot per instant.
  if new.current_state = 'current' then
    perform pg_advisory_xact_lock(
      hashtextextended('memory-projection-slot:' || new.tenant_id || ':' || new.projection_kind || ':' || new.logical_slot, 0)
    );
    select p.projection_id into overlapping
      from memory_projections p
     where p.tenant_id = new.tenant_id
       and p.projection_kind = new.projection_kind
       and p.logical_slot = new.logical_slot
       and p.current_state = 'current'
       and p.projection_id <> new.projection_id
       and daterange(p.effective_from, p.effective_to, '[)') && daterange(new.effective_from, new.effective_to, '[)')
     limit 1;
    if overlapping is not null then
      raise exception
        'memory_projections_temporal_overlap: slot %/% already has current projection % over an overlapping business-effective interval (INV-06: one settled current revision per slot per instant)',
        new.projection_kind, new.logical_slot, overlapping
        using errcode = 'exclusion_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists memory_projections_guard on memory_projections;
create trigger memory_projections_guard
  before insert or update on memory_projections
  for each row execute function memory_projections_guard();

-- Projections die with their tenant (and, once W3's purge exists, with their
-- legal entity through that explicit purge); a direct delete is refused.
create or replace function memory_projections_delete_guard() returns trigger
  language plpgsql as $$
begin
  if not exists (select 1 from firms where id = old.tenant_id) then
    return old;
  end if;
  if coalesce(current_setting('donna.allow_append_only_purge', true), '') = 'on' then
    return old;  -- the sanctioned lifecycle purge (rail: firm memory dies with its client)
  end if;
  raise exception
    'memory_projections_append_only: DELETE on memory_projections is forbidden (DMEM-R1 W2) outside the tenant cascade / the lifecycle purge — retire or supersede, never delete'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists memory_projections_delete_guard on memory_projections;
create trigger memory_projections_delete_guard
  before delete on memory_projections
  for each row execute function memory_projections_delete_guard();

-- ── RLS-native (the 085 posture) ─────────────────────────────────────────────
alter table memory_projections enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on memory_projections from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on memory_projections from authenticated;
  end if;
end $$;
