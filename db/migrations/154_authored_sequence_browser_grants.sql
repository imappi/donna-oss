-- Browser roles use Auth/Storage, never application sequences. Table RLS does
-- not govern nextval/setval. These 25 migration-authored public sequences had
-- browser rwU ACLs in the 2026-09-13 hosted catalog observation.
-- Keep sequence values/ownership/dependencies and explicit server grants intact.
do $$
declare
  sequence_name text;
begin
  foreach sequence_name in array array[
    'convergence_marks_id_seq',
    'inventory_allocations_id_seq',
    'inventory_anomalies_id_seq',
    'inventory_backorders_id_seq',
    'inventory_command_receipts_id_seq',
    'inventory_count_lines_id_seq',
    'inventory_count_sessions_id_seq',
    'inventory_journal_allocations_id_seq',
    'inventory_operations_id_seq',
    'inventory_posting_attempts_id_seq',
    'inventory_posting_incidents_id_seq',
    'inventory_posting_journals_id_seq',
    'inventory_purchase_order_lines_id_seq',
    'inventory_purchase_orders_id_seq',
    'inventory_reservations_id_seq',
    'inventory_sales_order_lines_id_seq',
    'inventory_sales_orders_id_seq',
    'inventory_supplier_acknowledgements_id_seq',
    'inventory_valuation_allowances_id_seq',
    'local_jobs_id_seq',
    'memory_candidate_events_id_seq',
    'memory_dependencies_id_seq',
    'memory_evidence_links_id_seq',
    'runtime_host_readiness_attempts_id_seq',
    'statutory_blocker_events_id_seq'
  ] loop
    execute format('revoke all privileges on sequence public.%I from public', sequence_name);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all privileges on sequence public.%I from anon', sequence_name);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all privileges on sequence public.%I from authenticated', sequence_name);
    end if;
  end loop;
end
$$;
