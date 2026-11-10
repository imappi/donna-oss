-- 175 — The cover of a held match is a convergence input, wherever it lives.
--
-- A material match held by the materiality ceiling (reconciliation_matches
-- status 'suggested', payload.authorization reasons ['above_materiality_ceiling'])
-- hangs its bank line (`matched_pending_authority_no_grant`) unless a standing
-- grant covers it RIGHT NOW (reconciliationAuthorityRoutes.readHeldMatchGrantCoverage).
-- Migration 174 marks a client's held lines when its grants change. Coverage
-- also reads, and can lose, three other things that 174 does not watch:
--   - the delegated-authority switch (RECONCILIATION_DELEGATED_AUTHORITY:
--     client_capability_config, the firm default row included, and
--     cohort_capability_config through client_cohort_members);
--   - the readiness admission: the client's explicit ENTITY_READINESS_ADMISSION
--     row (client_capability_config), its entity_readiness_sagas row, and this
--     runtime host's runtime_host_readiness row;
--   - the clock (a grant's review_after / expires_at, a host certificate's
--     valid_until). Time passing changes no row; the scheduled coding-convergence
--     tick re-derives these lines (reconcileConvergenceState.settleCoveredHeldMatchLines).
-- The triggers below make each row change re-derive the affected lines inside
-- the writer's own transaction (the marks settle at its commit through the pool
-- hook, like every other mark). As in 137 / 174 they compute NOTHING about the
-- rule: the law stays in JS.
--
-- WHICH lines: those with a live held match whose persisted verdict is not
-- already `matched_pending_authority_no_grant` (convergence_covered_held_lines).
-- Only those can lose a cover, so every re-derivation these sources cause moves
-- a line toward hanging or leaves it where it is — never from hanging to done.
-- The candidate filter is a SUPERSET of the JS receipt reader (it checks that the
-- reasons CONTAIN the ceiling; JS checks that they are only the ceiling), so no
-- held line is missed; the derivation decides.
--
-- Backfill: every candidate line today owes one re-derivation (a grant may have
-- passed its date, or a switch been staged off, since it was last derived).
-- Lines may move from auto_reconciled / on_owner to hanging — the intended,
-- more cautious direction.

create or replace function convergence_covered_held_lines(p_firm_id text, p_client_id text)
returns table (firm_id text, client_id text, transaction_id text)
  language sql stable as $$
  select distinct m.firm_id, m.client_id, m.bank_transaction_id
    from reconciliation_matches m
    join transactions t on t.firm_id = m.firm_id and t.id = m.bank_transaction_id
   where (p_firm_id is null or m.firm_id = p_firm_id)
     and (p_client_id is null or m.client_id = p_client_id)
     and m.status = 'suggested'
     and m.bank_transaction_id is not null
     and m.payload->'authorization'->>'band' = 'suggested'
     and coalesce(m.payload->'authorization'->'reasons', '[]'::jsonb) ? 'above_materiality_ceiling'
     and t.convergence_reason is distinct from 'matched_pending_authority_no_grant'
$$;

-- p_firm_id null = every firm (a host-wide input); p_client_id null = the whole firm.
create or replace function convergence_mark_covered_held_lines(p_firm_id text, p_client_id text, p_source text)
returns void
  language plpgsql as $$
begin
  insert into convergence_marks (firm_id, client_id, target_type, target_id, source)
  select l.firm_id, l.client_id, 'transaction', l.transaction_id, p_source
    from convergence_covered_held_lines(p_firm_id, p_client_id) l;
end;
$$;

-- The switch and the readiness flag row. A firm-default row (client_id null)
-- re-derives the whole firm's candidates. Other flags do not feed coverage
-- directly; a flag that is a readiness dependency reaches the saga trigger
-- below through migration 127's invalidation.
create or replace function convergence_mark_held_from_client_config() returns trigger
  language plpgsql as $$
declare
  r client_capability_config%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.flag_key in ('RECONCILIATION_DELEGATED_AUTHORITY', 'ENTITY_READINESS_ADMISSION')
     or (tg_op = 'UPDATE' and old.flag_key in ('RECONCILIATION_DELEGATED_AUTHORITY', 'ENTITY_READINESS_ADMISSION')) then
    perform convergence_mark_covered_held_lines(r.firm_id, r.client_id, 'client_capability_config');
  end if;
  return null;
end;
$$;
drop trigger if exists client_capability_config_convergence_mark_held on client_capability_config;
create trigger client_capability_config_convergence_mark_held
  after insert or update or delete on client_capability_config
  for each row execute function convergence_mark_held_from_client_config();

-- A cohort's switch row: every client that is, or was, a member of the cohort.
create or replace function convergence_mark_held_from_cohort_config() returns trigger
  language plpgsql as $$
declare
  r cohort_capability_config%rowtype;
  member record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.flag_key = 'RECONCILIATION_DELEGATED_AUTHORITY'
     or (tg_op = 'UPDATE' and old.flag_key = 'RECONCILIATION_DELEGATED_AUTHORITY') then
    for member in
      select distinct cm.client_id from client_cohort_members cm
       where cm.firm_id = r.firm_id and cm.cohort_key = r.cohort_key
    loop
      perform convergence_mark_covered_held_lines(r.firm_id, member.client_id, 'cohort_capability_config');
    end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists cohort_capability_config_convergence_mark_held on cohort_capability_config;
create trigger cohort_capability_config_convergence_mark_held
  after insert or update or delete on cohort_capability_config
  for each row execute function convergence_mark_held_from_cohort_config();

-- A client joining or leaving a cohort changes which cohort switch rows it reads.
create or replace function convergence_mark_held_from_cohort_member() returns trigger
  language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform convergence_mark_covered_held_lines(old.firm_id, old.client_id, 'client_cohort_members');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform convergence_mark_covered_held_lines(new.firm_id, new.client_id, 'client_cohort_members');
  end if;
  return null;
end;
$$;
drop trigger if exists client_cohort_members_convergence_mark_held on client_cohort_members;
create trigger client_cohort_members_convergence_mark_held
  after insert or update or delete on client_cohort_members
  for each row execute function convergence_mark_held_from_cohort_member();

-- The entity's readiness saga: only the fields the admission reads.
create or replace function convergence_mark_held_from_readiness_saga() returns trigger
  language plpgsql as $$
declare
  r entity_readiness_sagas%rowtype;
begin
  if tg_op = 'UPDATE'
     and old.state is not distinct from new.state
     and old.ready_dependency_digest is not distinct from new.ready_dependency_digest
     and old.observed_dependency_digest is not distinct from new.observed_dependency_digest
     and old.host_compatibility_digest is not distinct from new.host_compatibility_digest
     and old.admitted_profile_id is not distinct from new.admitted_profile_id then
    return null;
  end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  perform convergence_mark_covered_held_lines(r.firm_id, r.client_id, 'entity_readiness_sagas');
  return null;
end;
$$;
drop trigger if exists entity_readiness_sagas_convergence_mark_held on entity_readiness_sagas;
create trigger entity_readiness_sagas_convergence_mark_held
  after insert or update or delete on entity_readiness_sagas
  for each row execute function convergence_mark_held_from_readiness_saga();

-- The runtime host's readiness: host-wide, so every firm's candidates.
create or replace function convergence_mark_held_from_host_readiness() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.compatibility_digest is not distinct from new.compatibility_digest
     and old.latest_attempt_id is not distinct from new.latest_attempt_id
     and old.valid_until is not distinct from new.valid_until then
    return null;
  end if;
  perform convergence_mark_covered_held_lines(null, null, 'runtime_host_readiness');
  return null;
end;
$$;
drop trigger if exists runtime_host_readiness_convergence_mark_held on runtime_host_readiness;
create trigger runtime_host_readiness_convergence_mark_held
  after insert or update or delete on runtime_host_readiness
  for each row execute function convergence_mark_held_from_host_readiness();

select convergence_mark_covered_held_lines(null, null, 'migration_175');
