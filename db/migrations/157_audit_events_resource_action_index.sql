-- Native-chart retained-marker and receipt lookups (nativeChartLineage.js
-- retainedNativeMarkerSql / readNativeChartReceipts, the statement triggers of
-- migration 156) all probe audit_events by (firm_id, resource_id, action) and
-- order/bound by id. audit_events only had PK(id) and (firm_id, client_id,
-- created_at), so every probe scanned the firm's whole audit history, on every
-- ledger write and on every statement against the 10 trigger-carrying tables.
--
-- One full (not partial) index: the migration-156 trigger and the marker use
-- action = 'x', action in (...) and an OR of two action branches, and a partial
-- index is only chosen when the planner can prove the predicate for each.
--
-- scripts/migrate_firm_db.js wraps every migration in BEGIN/COMMIT, so this
-- cannot be CREATE INDEX CONCURRENTLY. A large production audit_events table
-- may need the same statement run by hand first (CONCURRENTLY, outside a
-- transaction); this migration is then a no-op.
create index if not exists audit_events_firm_resource_action_idx
  on audit_events (firm_id, resource_id, action, id);
