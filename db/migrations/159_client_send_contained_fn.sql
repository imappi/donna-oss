-- F-32 (2026-09-29): SQL twin of internalPilotAccess.js
-- readInternalPilotSendContainmentWithClient, used by the convergence gather
-- (reconcileConvergenceState.js ASK_DELIVERY_SQL) to decide whether a never-sent
-- client draft ask can ever be sent. A plpgsql function so the relations it
-- reads are bound at EXECUTION, and only when a never-sent client draft exists:
-- the gather's planning no longer depends on client_capability_config /
-- audit_events being readable (a config-store outage must not fail every
-- snapshot read). Pinned equal to the JS reader by
-- convergenceUndeliverableAskPgLifecycle.test.js.
--
-- Runbook: CREATE OR REPLACE FUNCTION is idempotent and takes only a catalog
-- lock; no table is rewritten or scanned. Rollback: drop function
-- donna_client_send_contained(text, text) AFTER reverting the code that calls it.
create or replace function donna_client_send_contained(p_firm text, p_client text)
returns boolean
language plpgsql
stable
as $$
begin
  return exists (
    select 1 from client_capability_config cc
    left join lateral (
      select a.created_at from audit_events a
       where a.firm_id = p_firm and a.client_id = p_client
         and a.action = 'pilot.send_containment_released'
         and a.actor_type in ('firm_member', 'seat')
         and a.resource_type = 'client' and a.resource_id = p_client
         and a.metadata->>'version' = 'donna.fi-hosted-pilot-send-release.v1'
         and a.metadata->>'firm_id' = p_firm
         and a.metadata->>'client_id' = p_client
         and a.metadata->>'actor_id' = a.actor_id
       order by a.id desc limit 1) rel on true
    where cc.firm_id = p_firm and cc.client_id = p_client
      and cc.flag_key = 'INTERNAL_PILOT_ACCESS' and cc.source = 'manual'
      and cc.reason in ('donna.fi-hosted-pilot.v1', 'donna.sg-hosted-review.v1')
      and (rel.created_at is null or (cc.valid_from > rel.created_at and cc.stage = 'canary')));
end;
$$;
