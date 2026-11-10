-- 172 — Finland FI-3: a live ALV return may not overlap another live return of
-- the same client. ADDITIVE; changes no existing row.
--
-- 066's alv_returns_live_period_idx is unique per period KEY. After a verokausi
-- change (month ↔ quarter ↔ year) a monthly '2026-09' return could be drafted
-- while a pending or filed quarterly '2026-Q3' already covered the same dates,
-- so the same sales and purchases could be reported twice. The draft writer
-- (__createAlvReturnDraftWithClient) refuses that inside its own transaction
-- with ALV_RETURN_PERIOD_OVERLAP; this trigger is the database backstop for
-- any other path that writes the table.
--
-- Why a trigger and not EXCLUDE USING gist: an exclusion constraint validates
-- every existing row and cannot be added NOT VALID. Rows the bug may already
-- have produced (a filed quarter plus a pending month over the same dates) are
-- history and must not be altered or deleted by a migration, so the rule
-- applies to NEW claims on dates only:
--   • an INSERT of a live row (draft_pending_confirmation | filed);
--   • an UPDATE that makes a non-live row live, or moves a live row's dates
--     or owner.
-- A status change between the two live states (pending → filed) is not a new
-- claim and is left to the filing path; existing overlaps stay visible to the
-- detection query in the PR, not silently resolved here.
--
-- Concurrency: the guard takes the same per-client transaction-scoped
-- advisory lock as the draft writer, so two overlapping inserts in parallel
-- transactions serialise and the second one sees the first.
--
-- Live states mirror 066's partial index (cancelled frees its dates).

create or replace function alv_returns_live_period_overlap_guard() returns trigger
  language plpgsql as $$
declare
  clash record;
begin
  if new.status not in ('draft_pending_confirmation', 'filed') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status in ('draft_pending_confirmation', 'filed')
     and old.firm_id = new.firm_id and old.client_id = new.client_id
     and old.starts_on = new.starts_on and old.ends_on = new.ends_on then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alv-return-periods:' || new.firm_id || ':' || new.client_id, 0));
  select id, period_key, status into clash
    from alv_returns
   where firm_id = new.firm_id
     and client_id = new.client_id
     and id <> new.id
     and status in ('draft_pending_confirmation', 'filed')
     and starts_on <= new.ends_on
     and ends_on >= new.starts_on
   order by starts_on
   limit 1;
  if found then
    raise exception
      'alv_returns_live_period_overlap: % (% – %) overlaps live return % (%, %)',
      new.period_key, new.starts_on, new.ends_on, clash.period_key, clash.status, clash.id
      using errcode = 'exclusion_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists alv_returns_live_period_overlap_guard on alv_returns;
create trigger alv_returns_live_period_overlap_guard
  before insert or update of status, starts_on, ends_on, firm_id, client_id on alv_returns
  for each row execute function alv_returns_live_period_overlap_guard();

-- The overlap read (writer + trigger) scans one client's live rows by date.
create index if not exists alv_returns_live_dates_idx
  on alv_returns(firm_id, client_id, starts_on, ends_on)
  where status in ('draft_pending_confirmation', 'filed');
