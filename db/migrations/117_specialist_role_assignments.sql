-- 117 — Specialist role assignments (S2 of docs/design-donna-specialist-roles.md
-- §5: the employment contract, split from authorization — INV-S10).
--
-- RoleAssignment (§1) lands on its named substrate: `client_assignments`
-- (migration 001) grows the columns the assignment shape needs, instead of a
-- new store. One table now carries two ASSIGNMENT KINDS:
--
--   'capability'      — the day-one rows: a human principal's per-client
--                       capability role (viewer/reviewer/…), read by
--                       firmDb.getAssignmentRoleForPrincipal. Unchanged
--                       semantics; every pre-117 row backfills to this kind.
--   'specialist_role' — S2's rows: an occupant (AI or human) HIRED into a
--                       bench role (roleRegistry.js). `role` holds the
--                       RoleDefinition id; `ai_profile` names the persona for
--                       AI occupants only (validateRoleAssignment's shape law).
--
-- Hiring mints NO consequential authority (INV-S10): an assignment row is
-- employment, not permission. Standing authority stays on the existing plane
-- (client_capability_config stages + action_authority_grants), minted only by
-- the explicit approval surface (roles/roleEmployment.js) and receipted.
--
-- The day-one table unique (client_id, principal_type, principal_id) becomes a
-- CAPABILITY-only partial unique so a human principal can hold BOTH a
-- capability assignment and a specialist role on the same client (§12: humans
-- occupy the same roles). selfProvisionDb's owner-assignment upsert re-targets
-- the partial index in the same commit — ship migration + code together.
-- Specialist rows get their own law: ONE occupant per role per client
-- (role-before-identity; a re-hire reuses the row, history lives in the
-- role.hired/role.ended receipts).
--
-- Everything here still dies with its client via the 001 FK cascade; the
-- authority-plane wipe receipt (authorityPlaneReceipt.js) now snapshots the
-- dying specialist assignments and action_authority_grants too — a client
-- reset un-hires the bench loudly, never silently (the firm-memory rail).

alter table client_assignments
  add column if not exists assignment_kind text not null default 'capability';
alter table client_assignments
  drop constraint if exists client_assignments_assignment_kind_check;
alter table client_assignments
  add constraint client_assignments_assignment_kind_check
  check (assignment_kind in ('capability', 'specialist_role'));

-- RoleAssignment.status (§1 vocabulary, pinned to roleRegistry.ASSIGNMENT_STATUSES).
-- Capability rows rest at the default 'active'; endRoleAssignment sets 'ended'
-- AND ends_at, so the day-one time-bounded access reads keep working unchanged.
alter table client_assignments
  add column if not exists status text not null default 'active';
alter table client_assignments
  drop constraint if exists client_assignments_status_check;
alter table client_assignments
  add constraint client_assignments_status_check
  check (status in ('proposed', 'active', 'suspended', 'ended'));

-- Persona lives on the AI OCCUPANT, never the role (§1). Human rows keep null.
alter table client_assignments
  add column if not exists ai_profile text;

-- AI occupants become a first-class principal type. 'ai_occupant' rows are
-- never returned for human auth principals (principal_type never matches), so
-- the access reads cannot conflate them with collaborators.
alter table client_assignments
  drop constraint if exists client_assignments_principal_type_check;
alter table client_assignments
  add constraint client_assignments_principal_type_check
  check (principal_type in ('firm_member', 'firm_collaborator', 'ai_occupant'));

-- The unique split: capability rows keep the day-one key; specialist rows key
-- on (firm, client, role) — one occupant per role per client.
alter table client_assignments
  drop constraint if exists client_assignments_client_id_principal_type_principal_id_key;
create unique index if not exists client_assignments_capability_uniq
  on client_assignments(client_id, principal_type, principal_id)
  where assignment_kind = 'capability';
create unique index if not exists client_assignments_specialist_role_uniq
  on client_assignments(firm_id, client_id, role)
  where assignment_kind = 'specialist_role';

-- Flag stage rows written by the hire flow carry their provenance in `source`
-- ('role_hire'), so the authority-plane wipe receipt and the census can tell a
-- hire-compiled envelope from a manual canary at a glance.
alter table client_capability_config
  drop constraint if exists client_capability_config_source_check;
alter table client_capability_config
  add constraint client_capability_config_source_check
  check (source in ('default', 'cohort', 'manual', 'emergency_override', 'role_hire'));
