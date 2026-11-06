-- 063 — Finland FI-4: tilikausi (fiscal year) entity. ADDITIVE.
--
-- A tilikausi is the statutory unit of account for a Finnish book (Kirjanpitolaki):
-- the boundary of the financial statement, the tax year, and — via FI-5 — the
-- reset boundary for gap-free voucher numbering (tositenumero). This table stores
-- explicit start/end dates so the model never has to assume a year boundary.
--
-- Phase-1 scope is the single-entry (cash-basis) non-ALV toiminimi, which is
-- calendar-year by law; off-calendar years (double-entry / Oy) arrive in Phase 2.
-- See docs/design-donna-finland-tilikausi-tositenumero.md.
--
-- next_tosite_no is RESERVED for FI-5 (the gap-free voucher counter lives on the
-- tilikausi row). No code reads or writes it until FI-5 lands; it is inert here.

create table if not exists fiscal_years (
  id             text primary key,
  firm_id        text not null references firms(id) on delete cascade,
  client_id      text not null references clients(id) on delete cascade,
  label          text not null,                                     -- tax-year key, e.g. '2026'
  starts_on      date not null,
  ends_on        date not null,
  status         text not null default 'open'
                   check (status in ('open', 'closing', 'closed')),
  next_tosite_no integer not null default 1,                        -- reserved for FI-5; inert until then
  closed_at      timestamptz,
  closed_by      text,
  payload        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint fiscal_years_bounds_ck check (ends_on >= starts_on),
  unique (firm_id, client_id, starts_on),
  unique (firm_id, client_id, label)
);

create index if not exists fiscal_years_firm_client_idx
  on fiscal_years(firm_id, client_id, starts_on);
