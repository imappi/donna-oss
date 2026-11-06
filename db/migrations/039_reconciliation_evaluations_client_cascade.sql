-- Migration 039 — reconciliation_evaluations: cascade-delete with the client.
--
-- reconciliation_evaluations (migration 028) was created with `client_id text
-- not null` and NO foreign key — unlike reconciliation_matches, which carries
-- `client_id ... references clients(id) on delete cascade`. So deleteClientInDb's
-- single cascade `delete from clients` (firmDb.js) — whose own comment asserts
-- "every client-keyed table is declared ... on delete cascade" — left evaluation
-- verdicts STANDING after a client delete.
--
-- Because client ids are deterministic (slug-based), a delete + re-upload
-- re-attached the orphaned verdicts to the rebuilt client. That is a
-- "firm memory dies with its client" violation (CLAUDE.md) and a
-- "render the persisted verdict" hazard — a stale verdict re-surfacing under a
-- fresh book. Confirmed live on the Honeybee shakedown (2026-06-22): evaluations
-- dated 2026-06-10..06-21 survived a 2026-06-22 delete + recreate and re-attached
-- to the new client row.
--
-- Fix: bring the table in line with every other client-keyed table — purge the
-- already-accumulated orphans, then add the on-delete-cascade FK so the client
-- delete removes its evaluations in one shot going forward. Idempotent;
-- safe to re-run.

-- 1. Remove orphans whose client no longer exists. Required before the FK can be
--    added (a dangling client_id would violate it) AND the one-time repair for
--    rows already accumulated across prior delete/recreate cycles (e.g. Honeybee).
delete from reconciliation_evaluations re
 where not exists (select 1 from clients c where c.id = re.client_id);

-- 2. Add the cascade FK (drop-if-exists first so the migration is idempotent).
--    Mirrors reconciliation_matches.client_id, so a client delete now cascades
--    its evaluation verdicts the same way it cascades its match rows.
alter table reconciliation_evaluations
  drop constraint if exists reconciliation_evaluations_client_id_fkey;

alter table reconciliation_evaluations
  add constraint reconciliation_evaluations_client_id_fkey
  foreign key (client_id) references clients(id) on delete cascade;
