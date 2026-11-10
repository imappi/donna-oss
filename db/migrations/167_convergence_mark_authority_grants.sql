-- 167 — A standing authority grant is a convergence input.
--
-- A material match held by the materiality ceiling (reconciliation_matches
-- status 'suggested', payload.authorization reasons ['above_materiality_ceiling'])
-- is a transition, never a resting state: the bank line it names hangs
-- (`matched_pending_authority_no_grant`) unless a standing grant covers the
-- match, in which case the line keeps the verdict of its other axes. The
-- projection (reconcileConvergenceState.js) now reads both facts in its one
-- gather, so a change to a client's grants changes the verdict of that
-- client's held lines — and, as with migration 137's six input tables, the
-- write plane must record that a re-derivation is owed.
--
-- The trigger computes NOTHING (the law stays in JS): any insert, update or
-- delete of a grant marks every bank line of the same client that carries a
-- live 'suggested' match. Grants are few and change rarely; the marks settle
-- in the grant writer's own transaction through the pool hook, like every
-- other mark.
--
-- Backfill: every bank line that carries a 'suggested' match today owes a
-- re-derivation, because the gather never fed the held input before this
-- change. Those lines may move from auto_reconciled to hanging — the intended,
-- more cautious direction.

create or replace function convergence_mark_from_authority_grant() returns trigger
  language plpgsql as $$
declare
  r reconciliation_authority_grants%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  insert into convergence_marks (firm_id, client_id, target_type, target_id, source)
  select distinct m.firm_id, m.client_id, 'transaction', m.bank_transaction_id, 'reconciliation_authority_grants'
    from reconciliation_matches m
   where m.firm_id = r.firm_id and m.client_id = r.client_id
     and m.status = 'suggested' and m.bank_transaction_id is not null;
  return null;
end;
$$;
drop trigger if exists reconciliation_authority_grants_convergence_mark on reconciliation_authority_grants;
create trigger reconciliation_authority_grants_convergence_mark
  after insert or update or delete on reconciliation_authority_grants
  for each row execute function convergence_mark_from_authority_grant();

insert into convergence_marks (firm_id, client_id, target_type, target_id, source)
select distinct m.firm_id, m.client_id, 'transaction', m.bank_transaction_id, 'migration_167'
  from reconciliation_matches m
 where m.status = 'suggested' and m.bank_transaction_id is not null;
