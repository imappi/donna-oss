-- 119: audit_events becomes append-only IN THE DATABASE (godmode build-spec
-- G2 PR-16, §0(8)) — enforced by trigger, not asserted in review.
--
-- The trail this protects is the receipt layer everything else stands on:
-- consequence diffs, reverse plans, the G5 restore drill. Until now
-- append-only was a convention (zero DELETE sites, one sanctioned UPDATE
-- site, both grep-verified per review); this migration makes the database
-- refuse what review used to catch. Mirrors 037's loop_goal_append_only_guard
-- (the guard + errcode pattern) and 045's to_jsonb(old) - allowed shape check
-- (fail-closed: a column added later is frozen automatically).
--
-- DELETE is forbidden outright. Deliberate consequence, recorded here: 001
-- declares firm_id ON DELETE CASCADE, so deleting a firms row would cascade a
-- DELETE into audit_events — which this trigger now refuses, making firm-row
-- teardown fail LOUDLY. No firm-delete site exists in the tree today; a real
-- firm offboarding must decide what happens to the audit trail deliberately
-- (retention/export is a governance call), never lose it to a cascade. There
-- is intentionally NO purge escape hatch here — unlike 037's loop tables,
-- audit_events does NOT die with its client (the client-delete rail purges
-- firm_facts, not the trail; WHO/WHEN survives).
--
-- UPDATE is forbidden except two exact shapes:
--
--   1. The erasure scrub (firmFacts.js eraseFirmFact, build-spec PR-10):
--      content-bearing metadata is replaced by the sha-256 receipt
--      (content_scrubbed: true) and resource_id may move to the privacy
--      tombstone; id, firm_id, client_id, actors, action and created_at all
--      survive — WHAT is gone, WHO/WHEN is not. The privacy promise and the
--      append-only promise reconcile in this shape instead of trading off.
--
--   2. The client-delete referential action: 001 declares client_id
--      REFERENCES clients(id) ON DELETE SET NULL, and that cascade is an
--      ordinary UPDATE this trigger sees — refusing it would break client
--      deletion. Admitted only in its exact meaning: nothing but client_id
--      changes, it changes to null, and the clients row is already gone
--      (the referential action runs after the parent delete). Nulling
--      attribution while the client still exists is refused — that is
--      laundering, not a cascade.
--
-- No new table; the 032/110 per-migration RLS discipline is untouched.

create or replace function audit_events_append_only_guard() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'audit_events_append_only: DELETE on audit_events is forbidden (G2 PR-16) — the trail is append-only; firm teardown must handle retention deliberately, never via cascade'
      using errcode = 'restrict_violation';
  end if;

  -- Shape 1: the erasure scrub. Only resource_id/metadata may differ, and the
  -- new metadata must carry the scrub receipt.
  if (to_jsonb(old) - array['resource_id', 'metadata'])
       is not distinct from (to_jsonb(new) - array['resource_id', 'metadata'])
     and new.metadata @> '{"content_scrubbed": true}'::jsonb then
    return new;
  end if;

  -- Shape 2: the client-delete set-null cascade. Only client_id may differ,
  -- only to null, and only once the clients row is actually gone.
  if (to_jsonb(old) - 'client_id') is not distinct from (to_jsonb(new) - 'client_id')
     and new.client_id is null
     and not exists (select 1 from clients where id = old.client_id) then
    return new;
  end if;

  raise exception
    'audit_events_append_only: UPDATE on audit_events is forbidden (G2 PR-16) outside the erasure-scrub shape (content_scrubbed receipt; only resource_id/metadata move) and the client-delete set-null cascade (only client_id, to null, client row gone)'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists audit_events_append_only on audit_events;
create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function audit_events_append_only_guard();
