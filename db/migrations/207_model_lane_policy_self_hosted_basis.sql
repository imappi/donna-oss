-- The self-hosted, UNQUALIFIED seat (the owner's decision of 2026-11-10:
-- "an OpenAI-compatible base URL setting, so it runs on a local model" —
-- yes, as an explicit opt-in that is never the default).
--
-- One more BASIS for a model_lane_policy row: 'self_hosted_unqualified'.
-- The row seats a model of the operator's own choosing — served by their own
-- OpenAI-compatible endpoint — as one named company's deciding model on a lane
-- that declares it can take one (modelLanes.js `selfHosted`). It is the honest
-- label for what it is: the model is NOT in any lane's qualified set (the
-- store refuses a qualified id under this basis), it never counts as
-- promotion or graduation evidence, and every receipt and surface says an
-- unqualified model decided. The store enforces the rest: a named client
-- (never firm-wide), an active firm member, a reason, and the audit receipt
-- in the same transaction.
--
-- Additive: existing rows keep their basis; an installation that never seats
-- a self-hosted model is unchanged. The column default stays 'experiment'.

alter table model_lane_policy
  drop constraint if exists model_lane_policy_basis_check;

alter table model_lane_policy
  add constraint model_lane_policy_basis_check
  check (basis in ('experiment', 'promotion', 'self_hosted_unqualified'));

-- A self-hosted seat is client-scoped only (the store's rule, held here too).
alter table model_lane_policy
  drop constraint if exists model_lane_policy_self_hosted_client_scoped;

alter table model_lane_policy
  add constraint model_lane_policy_self_hosted_client_scoped
  check (basis <> 'self_hosted_unqualified' or client_id is not null);
