// Donna — the S3 roster read (docs/design-donna-specialist-roles.md §5 S3):
// ONE compressed, persisted-state projection of the bench for the Team screen.
//
// Laws this module carries:
//   - Render the persisted verdict: every field here is read from stores the
//     writers already maintain (client_assignments, action_authority_grants,
//     client_capability_config, the owner Actions surface). Nothing is a fresh
//     UI-layer inference and nothing is freeform.
//   - INV-S8 (two-shape status line): the per-role projection counts items
//     whose next commitment is the OWNER's; everything else is a tracked
//     Donna-side continuation. "All handled" / "N waiting on you" render from
//     these counts alone.
//   - INV-S9 (certified means gated): `certification_claim` derives from the
//     S6 claim ladder (roleCertification.certificationClaimForRole) —
//     'autonomous' ONLY on a signed green manifest record, fail-closed to
//     'preview' otherwise. No role carries a signed record today, so every
//     card still reads 'preview'; the UI must never claim past it.
//   - INV-S10: the roster READS authority (envelope + grants); the only
//     writers are roleEmployment.js's four, reached through the API routes.
//
// The bench UI flag rides the config control plane (the rollout-flags rail):
// born dormant (envFallback () => false), staged per client by the operator
// lever. Ladder for a UI surface: off/dry_run = hidden (the static preview
// keeps rendering), shadow = the live roster shows read-only, canary/auto =
// the hire/approve/thread surfaces act.

import {
  ROLE_DEFINITIONS, AI_PROFILES
} from './roleRegistry.js';
import { compileRoleEnvelope } from './roleEmployment.js';
import { certificationClaimForRole, certificationSummaryForRole } from './roleCertification.js';
import { readRoleTeamwork } from './roleEvents.js';
import {
  clientFlagActs, clientFlagObserves, readClientConfigSnapshot
} from '../clientConfig.js';
import { readOwnerActionsSurface } from '../outbound/ownerActionsSurface.js';

export const SPECIALIST_ROLE_BENCH_FLAG_KEY = 'SPECIALIST_ROLE_BENCH_UI';

export const benchUiMode = ({ snapshot = null, env = process.env } = {}) => {
  const acts = clientFlagActs({
    flagKey: SPECIALIST_ROLE_BENCH_FLAG_KEY, snapshot, envFallback: () => false, env
  });
  const observes = clientFlagObserves({
    flagKey: SPECIALIST_ROLE_BENCH_FLAG_KEY, snapshot, envFallback: () => false, env
  });
  if (acts) return 'act';
  if (observes) return 'shadow';
  return 'off';
};

// One row per (firm, client, role) — the deterministic assignment id plus the
// 117 partial unique guarantee it. Ended rows are returned too: the roster is
// honest about a role that WAS hired and ended (the card renders it un-hired;
// the receipt trail holds the history).
export const listSpecialistAssignments = async (client, { firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return [];
  const { rows } = await client.query(
    `select id, role, principal_type, principal_id, ai_profile, status, starts_at, ends_at
       from client_assignments
      where firm_id = $1 and client_id = $2 and assignment_kind = 'specialist_role'
      order by role`,
    [firmId, clientId]
  );
  return rows;
};

// Standing authority minted through the role approval surface: role provenance
// is what separates these from other grants on the shared plane. Revoked rows
// are excluded — the card lists what stands, the audit trail lists what stood.
export const listRoleAuthorityGrants = async (client, { firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return [];
  const { rows } = await client.query(
    `select id, domain, action_type, scope_kind, scope_key, amount_ceiling, currency,
            status, use_count, correction_count, expires_at, review_after, provenance, created_at
       from action_authority_grants
      where firm_id = $1 and client_id = $2
        and provenance->>'role_id' is not null
        and status in ('proposed', 'active', 'suspended')
      order by created_at`,
    [firmId, clientId]
  );
  return rows;
};

// INV-S8. waiting_on_owner = items whose next commitment is the owner's:
// sends held for their approval, escalated cases, cases missing an owner fact.
// failed/stale rows stay Donna-side continuations (retry/re-claim is hers),
// auto_sent/earned/owner_replies are FYI surfaces — none of them block.
// The counts come from the SAME gather the owner Actions tab renders
// (readOwnerActionsSurface), so the roster line and the tab can never
// disagree about what is on the owner.
export const projectionFromOwnerSurface = (surface = {}) => {
  const approvals = surface.pending?.length || 0;
  const escalated = surface.escalated?.length || 0;
  const needsInput = surface.needs_input?.length || 0;
  return {
    waiting_on_owner: approvals + escalated + needsInput,
    breakdown: { approvals, escalated, needs_input: needsInput },
    pipeline_active: !!surface.pipeline_active,
    source: 'owner_actions_surface'
  };
};

// The roster read. `deps` exists for tests only — production callers take the
// real owner-surface gather.
export const readRoleRoster = async (client, {
  firmId, clientId, env = process.env, deps = {}
} = {}) => {
  if (!client || !firmId || !clientId) {
    throw new Error('readRoleRoster requires client, firmId, clientId');
  }
  const readOwnerSurface = deps.readOwnerActionsSurface || readOwnerActionsSurface;
  const readTeamwork = deps.readRoleTeamwork || readRoleTeamwork;
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const mode = benchUiMode({ snapshot, env });
  const assignments = await listSpecialistAssignments(client, { firmId, clientId });
  const grants = await listRoleAuthorityGrants(client, { firmId, clientId });
  const assignmentByRole = new Map(assignments.map((row) => [row.role, row]));

  // The projection is read only for a role that is actively hired — an
  // un-hired role has no workstream to project (and no gather is spent on it).
  const collectionsActive = assignmentByRole.get('invoicing_collections')?.status === 'active';
  const collectionsProjection = collectionsActive
    ? projectionFromOwnerSurface(await readOwnerSurface(client, { firmId, clientId, env }))
    : null;

  // S5 teamwork narration source: the persisted role-event RECEIPTS
  // (roleEvents readRoleTeamwork — render-the-persisted-verdict; the
  // deterministic narration lives in the view-model, INV-S5). Gathered only
  // while some role is actively hired — an empty bench has no teamwork to
  // narrate and spends no gather.
  const anyActive = assignments.some((row) => row.status === 'active');
  const teamwork = anyActive ? await readTeamwork(client, { firmId, clientId }) : [];

  const roles = ROLE_DEFINITIONS.map((role) => {
    const assignment = assignmentByRole.get(role.id) || null;
    const profile = AI_PROFILES[role.default_ai_profile] || null;
    return {
      id: role.id,
      title: role.title,
      responsibilities: role.responsibilities,
      action_set: role.action_set,
      capability_class: role.capability_class,
      certification_claim: certificationClaimForRole(role),
      certification: certificationSummaryForRole(role),
      profile: profile ? { persona: profile.persona, mascot: profile.mascot } : null,
      assignment: assignment
        ? {
            id: assignment.id,
            status: assignment.status,
            principal_type: assignment.principal_type,
            principal_id: assignment.principal_id,
            ai_profile: assignment.ai_profile,
            starts_at: assignment.starts_at,
            ends_at: assignment.ends_at
          }
        : null,
      envelope: compileRoleEnvelope({ role, snapshot }),
      grants: grants.filter((grant) => grant.provenance?.role_id === role.id),
      projection: role.id === 'invoicing_collections' ? collectionsProjection : null
    };
  });

  return { bench: { mode, flag_key: SPECIALIST_ROLE_BENCH_FLAG_KEY }, roles, teamwork };
};
