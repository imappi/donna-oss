-- 068 — Finland G-6 (FI-15): prepayment-register (ennakkoperintärekisteri)
-- awareness. ADDITIVE.
--
-- Two subjects, one append-only check ledger:
--   • 'self'     — the CLIENT's own registration. Not being in the register
--                  means the client's customers must withhold tax from work-
--                  compensation (työkorvaus) payments — commercially serious,
--                  and removal usually signals filing/payment neglect.
--   • 'supplier' — a service supplier's registration, checked BEFORE the
--                  client pays a service invoice: paying an unregistered
--                  provider for work normally obliges the PAYER to withhold
--                  (ennakonpidätys, EPL §25). Donna flags and escalates to the
--                  owner; it never executes a withholding.
--
-- Rows are APPEND-ONLY receipts of a dated registry check (YTJ) — no updates;
-- the latest (checked_on, created_at) wins at read time and staleness
-- evaluates at read time against the policy TTL
-- (server/donna/finland/prepaymentRegister.js). status is a CLOSED enum of
-- what the registry SAID ('registered' / 'not_registered') plus 'unknown'
-- (lookup attempted, no answer) — freshness is never a stored state.
-- source is closed: 'ytj_manual' today (a human checked ytj.fi and recorded
-- it); 'ytj_open_data' is reserved for the automated avoindata.prh.fi lookup
-- (network-open follow-up — the API is proxy-blocked from the build
-- container, so the adapter ships only once verified against the live API).
-- Recording is a firm action, audited in-transaction (audit-as-precondition)
-- with the acting member attributed.
-- Design: docs/design-donna-finland-production-readiness.md (gap G-6).

create table if not exists prepayment_register_checks (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  subject_type text not null check (subject_type in ('self', 'supplier')),
  -- Y-tunnus (validated shape + checksum at the writer) when known; a manual
  -- supplier check may only have the name.
  business_id text,
  -- Supplier display name as recorded, plus the normalized matching key
  -- (lower/trim/collapsed whitespace) that joins checks to supplier-bill
  -- vendor names at read time. Null for subject_type 'self'.
  counterparty_name text,
  counterparty_key text,
  status text not null check (status in ('registered', 'not_registered', 'unknown')),
  checked_on date not null,
  source text not null default 'ytj_manual' check (source in ('ytj_manual', 'ytj_open_data')),
  -- Free-form pointer to the verification (e.g. the YTJ page consulted).
  reference text,
  note text,
  recorded_by text,
  created_at timestamptz not null default now()
);

create index if not exists prepayment_register_checks_client_idx
  on prepayment_register_checks(firm_id, client_id, subject_type);

create index if not exists prepayment_register_checks_counterparty_idx
  on prepayment_register_checks(firm_id, client_id, counterparty_key)
  where counterparty_key is not null;
