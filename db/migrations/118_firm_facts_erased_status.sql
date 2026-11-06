-- 118 (renumbered from 117 — the specialist-roles bench minted 117 the same day; prefix-collision fix, re-run-safe): firm_facts gains the 'erased' status (godmode build-spec PR-10, G1c).
--
-- The erase writer (firmFacts.js eraseFirmFact — "delete this personal
-- information") scrubs-and-rekeys a fact into a privacy tombstone with
-- status='erased': content replaced by sha-256 integrity receipts, the row
-- re-keyed to a content-free id, and re-minting the erased content blocked
-- forever via provenance.erased_id_hash (restore-after-erasure). Migration
-- 030's status CHECK only knew active/dismissed; this widens it. The column
-- default and every reader filter (status='active') are unchanged, so
-- nothing behaves differently until the erase writer runs.
--
-- No new table — the 032/110 per-migration RLS discipline is untouched.

alter table firm_facts drop constraint if exists firm_facts_status_check;
alter table firm_facts add constraint firm_facts_status_check
  check (status in ('active', 'dismissed', 'erased'));
