-- 092 — Receivable collection cases (M1, G5): persisted per-invoice CHASE
-- state, alongside — NEVER replacing — computed settlement (the gap-5 verdict:
-- read-time settlement is the paid-truth and cannot carry collection state).
-- docs/design-donna-outbound-actions-execution-plan.md §1 M1.1.
--
-- The case answers "which reminder tier, paused, disputed, escalated, when is
-- the next step due" across restarts; the paid-truth guard (G4) answers "is it
-- actually still owed" fresh at every send. A case NEVER shortcuts the guard.
--
-- Two-terminal-states over case statuses — a case RESTS only as:
--   - settled  (terminal: the paid-truth guard saw settlement; receipted on
--     the action's cancel or the case's own audit event), or
--   - stopped  (terminal: honest stop — owner declined, recipient suppressed,
--     cadence out of road; reason on status_reason), or
--   - on the OWNER: escalated (cadence exhausted), paused / disputed (owner
--     verbs), or open-with-a-gap (no recipient channel / missing render
--     values, surfaced by the G9 digest as a needs-input row).
-- 'open' with next_due_at set is transient work the hourly sweep drains.
--
-- Anchors mirror outbound_actions: 'document' (parsed sales invoices — the US
-- launch lane) and 'issued_invoice' (Donna-issued — lights up with M2/M3).
-- Everything dies with its client via FK cascade (090/091 convention).

create table if not exists receivable_cases (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  anchor_type text not null
    check (anchor_type in ('document', 'issued_invoice')),
  anchor_id text not null,
  target_party_id text references client_parties(id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'paused', 'disputed', 'escalated', 'settled', 'stopped')),
  -- 0 = no reminder sent yet; N = pack cadence step N executed.
  current_step integer not null default 0,
  next_due_at timestamptz,
  pack_id text not null,
  invoice_number text,
  amount numeric,
  currency text,
  due_date date,
  last_action_id text,
  last_sent_at timestamptz,
  opened_reason text not null default 'overdue_detected',
  -- Why the case rests where it rests (paused/disputed/escalated/stopped
  -- reasons; open-state gaps like 'missing_payment_instructions').
  status_reason text,
  settled_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One case per anchor: re-detection is an idempotent no-op.
create unique index if not exists receivable_cases_anchor_idx
  on receivable_cases(firm_id, client_id, anchor_type, anchor_id);
-- The digest/sweep scans: cases by status and due time.
create index if not exists receivable_cases_status_idx
  on receivable_cases(firm_id, client_id, status, next_due_at);
create index if not exists receivable_cases_party_idx
  on receivable_cases(target_party_id);

-- ── RLS-native (mirror 090/091) ──────────────────────────────────────────────
alter table receivable_cases enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on receivable_cases from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on receivable_cases from authenticated;
  end if;
end $$;
