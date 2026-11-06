-- 122 — Ask audience: one question primitive, three audiences
-- (docs/design-donna-universal-mentions.md §5; CLAUDE.md two-terminal-states
-- GENERALIZED 2026-08-27).
--
-- `client_evidence_requests` becomes the ONE fact-question store for every
-- audience: the client/owner (every row before this migration — the default
-- keeps them byte-identical), a SEAT (a customer-side human principal:
-- firm_member / firm_collaborator), or an AGENT (a hired bench occupant /
-- the runtime operator). The lifecycle enum, identity ladder
-- (askIdentity.js), generation/merge machinery and send-count accounting are
-- audience-agnostic already and are NOT touched.
--
-- The audience is a COLUMN, not request_payload metadata, for the same
-- reason actor attribution is (pod-safety #1): every open-ask reader must be
-- able to filter on it in SQL, because an un-audienced colleague ask would
-- silently classify on_owner and launder firm-side limbo as terminal — the
-- exact failure reconcileConvergenceState.js exists to prevent. The schema
-- rehearsed this concept twice before promoting it here:
-- bookkeeping_case_blockers.owner_type (033) is the enum shape, and
-- request_payload.escalated_to_firm (the re-ask cadence) is a working
-- client->firm re-audiencing as a JSONB marker.
--
-- Addressee: NULL for the client audience (the addressee IS the client —
-- delivery resolves it from channel bindings, as today). A seat/agent ask
-- names its principal, in the same (principal_type, principal_id) vocabulary
-- client_assignments uses. Enforced by CHECK, fail-closed.

alter table client_evidence_requests
  add column if not exists audience text not null default 'client';
alter table client_evidence_requests
  drop constraint if exists client_evidence_requests_audience_check;
alter table client_evidence_requests
  add constraint client_evidence_requests_audience_check
  check (audience in ('client', 'seat', 'agent'));

alter table client_evidence_requests
  add column if not exists addressee_principal_type text;
alter table client_evidence_requests
  add column if not exists addressee_principal_id text;
alter table client_evidence_requests
  drop constraint if exists client_evidence_requests_addressee_check;
alter table client_evidence_requests
  add constraint client_evidence_requests_addressee_check
  check (
    (audience = 'client'
      and addressee_principal_type is null
      and addressee_principal_id is null)
    or (audience = 'seat'
      and addressee_principal_type in ('firm_member', 'firm_collaborator')
      and addressee_principal_id is not null)
    or (audience = 'agent'
      and addressee_principal_type = 'ai_occupant'
      and addressee_principal_id is not null)
  );

-- Identity (108) gains the audience: asking the owner and asking a colleague
-- about the SAME receipt are two live questions, not a duplicate — but two
-- seat-asks on one anchor still collapse to ONE live question (don't chase
-- two colleagues with the same blocker; the first addressee holds it). The
-- mint's deterministic id includes the audience for non-client rows
-- (firmDb.js), so cross-audience rows can never collide on `id` either.
drop index if exists client_evidence_requests_active_anchor_idx;
create unique index if not exists client_evidence_requests_active_anchor_idx
  on client_evidence_requests (firm_id, client_id, canonical_anchor, blocker_code, generation, audience)
  where canonical_anchor is not null and status in ('draft', 'open', 'replied');
