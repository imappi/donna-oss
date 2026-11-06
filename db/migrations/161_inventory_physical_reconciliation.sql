-- Physical observations extend existing count rows; neither observations nor
-- reconciliation cases own stock. Only the inventory operation writer does.
alter table inventory_count_sessions add column if not exists physical_reconciliation boolean not null default false;
alter table inventory_count_lines alter column counted_quantity drop not null;
alter table inventory_count_lines
  add column if not exists expected_quantity numeric(24,8),
  add column if not exists physical_status text,
  add column if not exists physical_basis jsonb,
  add column if not exists physical_observation jsonb,
  add column if not exists physical_resolution jsonb,
  add column if not exists case_id text references bookkeeping_cases(id) on delete set null,
  add column if not exists anomaly_id bigint references inventory_anomalies(id);
alter table inventory_count_lines drop constraint if exists inventory_physical_status_check;
alter table inventory_count_lines add constraint inventory_physical_status_check check (
  physical_status is null or physical_status in ('awaiting_observation','matched','variance','uncertain','recount_required','dismissed','applied'));
alter table inventory_count_lines drop constraint if exists inventory_physical_basis_check;
alter table inventory_count_lines add constraint inventory_physical_basis_check check (
  physical_status is null or (expected_quantity is not null and physical_basis is not null));
create index if not exists inventory_physical_sessions_idx on inventory_count_sessions(firm_id,client_id,opened_at desc) where physical_reconciliation;
-- Existing inventory tables are service-only; never grant browser writes to the new fields.
