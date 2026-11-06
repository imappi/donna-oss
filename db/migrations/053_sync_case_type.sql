-- 053 — add the 'sync' case type to the Loops spine (INT-4, ledger-integrations
-- finish plan §2). External-sync failures and mirror drift surface as FIRM cases
-- (Kari decision #3, 2026-07-06) anchored on the transaction/journal whose export
-- broke. A dedicated case type — rather than reusing 'reconciliation' — because
-- the deterministic case id is (firm, client, case_type, primary_object): a sync
-- failure on an already-RESOLVED reconciliation case would land its blocker on a
-- terminal case, where the terminal verdict outranks open blockers and the
-- failure becomes invisible (the exact silent-failure violation INT-4 closes).
--
-- The blocker vocabulary (external_sync_pending / external_sync_failed, owner
-- external_connector) already shipped in 033 — this only widens the case_type
-- CHECK. Postgres auto-names inline CHECKs <table>_<column>_check; drop-then-add
-- keeps this idempotent for a re-run.

alter table bookkeeping_cases
  drop constraint if exists bookkeeping_cases_case_type_check;

alter table bookkeeping_cases
  add constraint bookkeeping_cases_case_type_check
  check (case_type in ('evidence', 'coding', 'reconciliation', 'upload', 'sync'));
