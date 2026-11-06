-- AE VAT return preparation: the FTA-assigned tax-period store.
--
-- Deliberately NOT vat_periods (migration 111): that table is the HMRC/MTD
-- projection — it demands a vrn and an hmrc_obligation_payload synced from
-- the obligations API. The FTA assigns tax periods and due dates PER
-- REGISTRANT (the due-date clock is client data, never a pack constant) and
-- EmaraTax has no obligations sync in the build, so AE periods are RECORDED
-- from the owner's EmaraTax view through an audited writer
-- (server/donna/ae/vatPeriods.js) with the record's provenance in `source`.
-- Design: docs/design-donna-ae-vat-return.md (build-state entry 2026-08-30).

create table if not exists ae_vat_periods (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- The registrant's TRN, taken from the persisted vat_registration record
  -- at record time — never caller-supplied, so a period cannot be recorded
  -- against a number the profile does not hold.
  trn text not null,
  -- The owner-visible period label from EmaraTax (e.g. 'Apr-Jun 2026').
  -- Opaque; never parsed or reconstructed.
  period_key text not null,
  start_date date not null,
  end_date date not null,
  due_date date not null,
  status text not null check (status in ('open', 'fulfilled')),
  -- Record provenance: who recorded it, from what (an EmaraTax screen, an
  -- FTA letter), and any due-date deviation note the writer computed.
  source jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, client_id, period_key)
);

create index if not exists ae_vat_periods_client_dates_idx
  on ae_vat_periods (firm_id, client_id, start_date, end_date);

alter table ae_vat_periods enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on ae_vat_periods from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on ae_vat_periods from authenticated;
  end if;
end $$;
