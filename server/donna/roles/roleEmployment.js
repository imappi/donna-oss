// Donna — the employment contract (S2 of docs/design-donna-specialist-roles.md
// §5): hiring a role is SPLIT from authorizing it (INV-S10 — pre-assigned is
// not pre-authorized).
//
// Two surfaces, deliberately separate:
//
//   HIRE (hireRole / endRoleAssignment) — compiles the role's envelope from
//   the roleRegistry authority_template and stages the observe/propose/ask
//   posture, minting NO consequential grants. A fresh occupant can observe,
//   reason, prepare, propose, and ask — nothing more. The assignment row lands
//   on `client_assignments` (migration 001 + 117), the RoleAssignment
//   substrate named by the design's §1.
//
//   APPROVE (approveRoleGrant / revokeRoleGrant) — the explicit surface where
//   the principal delegates standing authority per grant SHAPE ("send reminder
//   #1 automatically", "up to <ceiling>"), minted with ceilings/expiry/
//   review_after through the EXISTING generalized grant store
//   (actionAuthorityGrants.js, migration 095) and graduating on the earned-auto
//   ladder (migration 100). No new authority machinery — presets and approvals
//   over the existing plane.
//
// Every hire/end/approval/revocation is receipted (role.hired, role.ended,
// role.grant_approved, role.grant_revoked) in the same transaction as its
// write — the two-terminal discipline applied to employment itself.
//
// The OWNER is the only runtime actor on every writer here (the 2026-07-23
// self-service doctrine, same law the grant store enforces): nobody else can
// hire a teammate onto a book or hand it standing authority.
//
// The envelope's stage law (hireStageForFlag): a hire stages a lane flag to
// 'canary' ONLY where the lane's acting mode is structurally ask-first — the
// OUTBOUND_* family, whose A2 gate caps every canary verdict at
// hold_for_approval (per-item owner approval) and whose 'auto' terminal is
// refused by AUTO_FORBIDDEN_FLAGS — so canary IS the propose/ask posture
// there, not an execution grant. Every other lane stages 'shadow' (observe
// only) until it defines a structurally ask-first acting mode of its own.
// A hire never LOWERS an existing stage and never touches canary/auto rows —
// the compiler only stages UP to the hire posture.

import crypto from 'node:crypto';

import {
  findRoleDefinition, validateRoleAssignment
} from './roleRegistry.js';
import { readClientConfigSnapshot, setClientFlagStage } from '../clientConfig.js';
import {
  mintActionAuthorityGrant, revokeActionAuthorityGrant
} from '../actionAuthorityGrants.js';

export const ROLE_EMPLOYMENT_AUDIT_ACTIONS = Object.freeze({
  hired: 'role.hired',
  ended: 'role.ended',
  grantApproved: 'role.grant_approved',
  grantRevoked: 'role.grant_revoked'
});

// The AI occupant principal: Donna's runtime wearing the role (design §1 —
// receipts read `principal=donna_ai · role=<id>`). Persona (Clara/Vera/Milo)
// rides ai_profile on the assignment, never the principal id.
export const AI_OCCUPANT_PRINCIPAL_ID = 'donna_ai';

// Provenance value for flag rows staged by a hire (117 extends the 042 source
// CHECK with it; migrations.test.js pins the two together).
export const ROLE_HIRE_CONFIG_SOURCE = 'role_hire';

// grant SHAPE (the registry's authority_template vocabulary) → the grant
// store's DOMAIN. A shape without a mapping cannot be approved — fail closed.
export const GRANT_SHAPE_DOMAINS = Object.freeze({
  standing_send_authority: 'outbound',
  inventory_posting_authority: 'inventory'
});

// grant SHAPE → the action families it may cover. THE server home for this
// map (team-screen recede, 2026-08-14: the desk form is gone, so the chat
// verbs and the team-context build both resolve delegability HERE — the FE
// no longer carries a copy). approveRoleGrant still re-verifies
// authority ⊆ leash independently; this map only answers "which offered
// shape covers this verb".
export const GRANT_SHAPE_ACTION_FAMILIES = Object.freeze({
  standing_send_authority: Object.freeze(['issue_invoice', 'send_quote', 'send_receivable_reminder']),
  inventory_posting_authority: Object.freeze(['post_inventory_journal'])
});

// The verbs the owner could delegate to this role: the union of its offered
// shapes' families, intersected with its own leash.
export const grantableActionsForRole = (role) => {
  if (!role?.authority_template) return [];
  return role.authority_template.grant_shapes
    .flatMap((shape) => GRANT_SHAPE_ACTION_FAMILIES[shape.kind] || [])
    .filter((verb) => role.action_set.includes(verb));
};

// The offered shape covering ONE verb, or null (fail closed — an unmapped
// verb cannot be granted through any surface).
export const offeredShapeForAction = (role, actionType) => {
  if (!role?.authority_template) return null;
  const shape = role.authority_template.grant_shapes
    .find((s) => (GRANT_SHAPE_ACTION_FAMILIES[s.kind] || []).includes(actionType));
  return shape ? shape.kind : null;
};

const STAGE_RANK = Object.freeze({ off: 0, dry_run: 1, shadow: 2, canary: 3, auto: 4 });

// The stage law, machine-checked in roleEmployment.test.js. See the header.
export const hireStageForFlag = (flagKey) =>
  String(flagKey || '').startsWith('OUTBOUND_') ? 'canary' : 'shadow';

// Deterministic id: one row per (firm, client, role) — re-hire reuses it
// (the 095 buildActionAuthorityGrantId convention).
export const buildRoleAssignmentId = ({ firmId, clientId, roleId } = {}) => {
  const hash = crypto
    .createHash('sha256')
    .update([firmId, clientId, roleId].join('|'))
    .digest('hex')
    .slice(0, 16);
  const slug = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'unknown';
  return ['role-assign', slug(roleId), slug(clientId), hash].join('-');
};

// Pure envelope planner: template flags × current stages → what a hire would
// stage. Only stages UP to the hire posture; an unknown/garbage current stage
// is left untouched (staging up on a value we can't rank would be widening on
// doubt — fail closed).
export const compileRoleEnvelope = ({ role, snapshot = null } = {}) => {
  if (!role) return { flags: [], grant_shapes_offered: [] };
  const flags = role.authority_template.flags.map((flagKey) => {
    const current = snapshot?.[flagKey]?.stage ?? null;
    const target = hireStageForFlag(flagKey);
    const stageUp = current == null
      ? true
      : STAGE_RANK[current] < STAGE_RANK[target];
    return {
      flag_key: flagKey,
      from: current,
      to: stageUp ? target : current,
      action: stageUp ? 'stage' : 'keep'
    };
  });
  return { flags, grant_shapes_offered: role.authority_template.grant_shapes };
};

const assertOwnerActor = (actorType, what) => {
  if (actorType !== 'owner') {
    throw new Error(`${what} is an OWNER action (self-service doctrine) — got actor_type '${actorType}'`);
  }
};

const auditEmployment = (client, {
  firmId, clientId, actorType, actorId, action, resourceId, metadata
}) => client.query(
  `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
   values ($1, $2, $3, $4, $5, 'role_assignment', $6, $7::jsonb)`,
  [firmId, clientId, actorType, actorId, action, resourceId, JSON.stringify(metadata)]
);

// The active occupant of a role on a client, or null. Exported for the chat
// seam's callers and the (S3) roster UI.
export const readActiveSpecialistAssignment = async (client, { firmId, clientId, roleId } = {}) => {
  if (!client || !firmId || !clientId || !roleId) return null;
  const { rows } = await client.query(
    `select * from client_assignments
      where firm_id = $1 and client_id = $2 and role = $3
        and assignment_kind = 'specialist_role' and status = 'active'
      limit 1`,
    [firmId, clientId, roleId]
  );
  return rows[0] || null;
};

// HIRE. Creates (or reactivates) the assignment, compiles + stages the
// envelope, receipts role.hired — and mints NOTHING consequential (INV-S10).
// Default occupant is the AI bench (donna_ai wearing the role's default
// profile); a human occupant is passed explicitly (§12 — same substrate).
// An active row with the SAME occupant is idempotent (hired:false, no receipt
// churn); an active row with a DIFFERENT occupant refuses — replacing an
// occupant is end-then-hire, two deliberate receipted acts, never a silent
// swap.
export const hireRole = async (client, {
  firmId, clientId, roleId,
  occupant = null,
  actorType = 'owner', actorId = null, reason = null
} = {}) => {
  if (!client || !firmId || !clientId) throw new Error('hireRole requires client, firmId, clientId');
  assertOwnerActor(actorType, 'hireRole');
  const role = findRoleDefinition(roleId);
  if (!role) throw new Error(`hireRole: unknown role '${roleId}'`);

  const occ = occupant || {
    actor_type: 'ai',
    principal_type: 'ai_occupant',
    principal_id: AI_OCCUPANT_PRINCIPAL_ID,
    ai_profile: role.default_ai_profile
  };
  const shape = {
    role: role.id,
    occupant: occ.principal_id,
    actor_type: occ.actor_type,
    scope: role.default_scope,
    grants: [],
    status: 'active',
    ...(occ.actor_type === 'ai' ? { ai_profile: occ.ai_profile } : {})
  };
  const problems = validateRoleAssignment(shape);
  if (problems.length) throw new Error(`hireRole: invalid assignment — ${problems.join('; ')}`);

  const existing = await client.query(
    `select id, principal_type, principal_id, status from client_assignments
      where firm_id = $1 and client_id = $2 and role = $3 and assignment_kind = 'specialist_role'
      for update`,
    [firmId, clientId, role.id]
  );
  const row = existing.rows[0] || null;
  if (row && row.status === 'active') {
    const sameOccupant = row.principal_type === occ.principal_type && row.principal_id === occ.principal_id;
    if (sameOccupant) return { hired: false, assignment_id: row.id, envelope: null };
    throw new Error(
      `hireRole: role '${role.id}' is occupied by ${row.principal_type}:${row.principal_id} — end that assignment first (no silent occupant swap)`
    );
  }

  const assignmentId = row?.id || buildRoleAssignmentId({ firmId, clientId, roleId: role.id });
  await client.query(
    `insert into client_assignments
       (id, firm_id, client_id, principal_type, principal_id, role, access_level,
        assignment_kind, status, ai_profile, starts_at, ends_at)
     values ($1, $2, $3, $4, $5, $6, 'client_scoped', 'specialist_role', 'active', $7, now(), null)
     on conflict (firm_id, client_id, role) where assignment_kind = 'specialist_role'
     do update set
       principal_type = excluded.principal_type,
       principal_id = excluded.principal_id,
       ai_profile = excluded.ai_profile,
       status = 'active',
       starts_at = now(),
       ends_at = null,
       updated_at = now()`,
    [assignmentId, firmId, clientId, occ.principal_type, occ.principal_id, role.id,
      occ.actor_type === 'ai' ? occ.ai_profile : null]
  );

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const envelope = compileRoleEnvelope({ role, snapshot });
  for (const flag of envelope.flags) {
    if (flag.action !== 'stage') continue;
    await setClientFlagStage(client, {
      firmId, clientId, flagKey: flag.flag_key, stage: flag.to,
      source: ROLE_HIRE_CONFIG_SOURCE,
      reason: reason || `role hire: ${role.id}`,
      actorType, actorId
    });
  }

  await auditEmployment(client, {
    firmId, clientId, actorType, actorId,
    action: ROLE_EMPLOYMENT_AUDIT_ACTIONS.hired,
    resourceId: assignmentId,
    metadata: {
      role_id: role.id,
      occupant: { principal_type: occ.principal_type, principal_id: occ.principal_id, actor_type: occ.actor_type, ai_profile: shape.ai_profile ?? null },
      envelope,
      grants_minted: [],
      reason
    }
  });
  return { hired: true, assignment_id: assignmentId, envelope };
};

// END. Sets status='ended' + ends_at (the day-one time-bound reads keep
// working), receipts role.ended. Flags and grants are deliberately NOT
// auto-lowered — the envelope's lanes may also carry Donna-core work the owner
// relies on — so the receipt lists them as the lower/revoke checklist (the
// authorityPlaneReceipt philosophy: loud, never silent).
export const endRoleAssignment = async (client, {
  firmId, clientId, roleId, actorType = 'owner', actorId = null, reason = null
} = {}) => {
  if (!client || !firmId || !clientId) throw new Error('endRoleAssignment requires client, firmId, clientId');
  assertOwnerActor(actorType, 'endRoleAssignment');
  const role = findRoleDefinition(roleId);
  if (!role) throw new Error(`endRoleAssignment: unknown role '${roleId}'`);

  const result = await client.query(
    `update client_assignments
        set status = 'ended', ends_at = now(), updated_at = now()
      where firm_id = $1 and client_id = $2 and role = $3
        and assignment_kind = 'specialist_role' and status <> 'ended'
      returning id, principal_type, principal_id, ai_profile`,
    [firmId, clientId, role.id]
  );
  const row = result.rows[0] || null;
  if (!row) return { ended: false, assignment_id: null };

  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const flagsLeft = role.authority_template.flags.map((flagKey) => ({
    flag_key: flagKey, stage: snapshot?.[flagKey]?.stage ?? null
  }));
  const grants = await client.query(
    `select id, domain, action_type, scope_kind, scope_key, amount_ceiling, currency, status
       from action_authority_grants
      where firm_id = $1 and client_id = $2 and provenance->>'role_id' = $3
        and status in ('proposed', 'active', 'suspended')
      order by created_at`,
    [firmId, clientId, role.id]
  );

  await auditEmployment(client, {
    firmId, clientId, actorType, actorId,
    action: ROLE_EMPLOYMENT_AUDIT_ACTIONS.ended,
    resourceId: row.id,
    metadata: {
      role_id: role.id,
      occupant: { principal_type: row.principal_type, principal_id: row.principal_id, ai_profile: row.ai_profile },
      reason,
      flags_left_as_is: flagsLeft,
      grants_left_live: grants.rows,
      note: 'Flags and grants are NOT auto-lowered on end — lower/revoke deliberately; this receipt is the checklist.'
    }
  });
  return { ended: true, assignment_id: row.id, grants_left_live: grants.rows };
};

// APPROVE. The explicit delegation act: the owner turns one of the role's
// offered grant SHAPES into a standing, ceilinged, time-bounded grant on the
// existing plane. Guards, all fail-closed:
//   - the shape must be offered by the role's authority_template;
//   - the action must be inside the role's action_set (a grant may never
//     exceed the leash — authority ⊆ action_set ⊆ canonical namespace);
//   - the role must be actively hired (no authority without employment);
//   - a time bound is REQUIRED (expiresAt or reviewAfter — the 095 doctrine);
//   - the store's own guards (owner mint, ceiling+currency) still bind.
export const approveRoleGrant = async (client, {
  firmId, clientId, roleId, grantShape,
  actionType, scopeKind = 'counterparty', scopeKey,
  amountCeiling, currency,
  expiresAt = null, reviewAfter = null,
  actorType = 'owner', actorId = null, reason = null, model = null
} = {}) => {
  if (!client || !firmId || !clientId) throw new Error('approveRoleGrant requires client, firmId, clientId');
  assertOwnerActor(actorType, 'approveRoleGrant');
  const role = findRoleDefinition(roleId);
  if (!role) throw new Error(`approveRoleGrant: unknown role '${roleId}'`);
  const shape = role.authority_template.grant_shapes.find((g) => g.kind === grantShape);
  if (!shape) throw new Error(`approveRoleGrant: role '${role.id}' does not offer grant shape '${grantShape}'`);
  const domain = GRANT_SHAPE_DOMAINS[grantShape];
  if (!domain) throw new Error(`approveRoleGrant: grant shape '${grantShape}' has no domain mapping`);
  if (!role.action_set.includes(actionType)) {
    throw new Error(`approveRoleGrant: action '${actionType}' is outside role '${role.id}' action_set — a grant may never exceed the leash`);
  }
  if (!expiresAt && !reviewAfter) {
    throw new Error('approveRoleGrant: a time bound is required (expiresAt or reviewAfter)');
  }
  const assignment = await readActiveSpecialistAssignment(client, { firmId, clientId, roleId: role.id });
  if (!assignment) {
    throw new Error(`approveRoleGrant: role '${role.id}' is not actively hired on this client — hire before granting`);
  }

  const minted = await mintActionAuthorityGrant(client, {
    firmId, clientId, domain, actionType,
    scopeKind, scopeKey, amountCeiling, currency,
    authorizedByActorType: actorType, authorizedByActorId: actorId,
    source: 'owner_approval', status: 'active',
    expiresAt, reviewAfter, model,
    provenance: { role_id: role.id, assignment_id: assignment.id, grant_shape: grantShape, reason }
  });
  if (!minted) {
    throw new Error('approveRoleGrant: the authority store refused the mint (owner actor, positive ceiling, and currency are required)');
  }

  await auditEmployment(client, {
    firmId, clientId, actorType, actorId,
    action: ROLE_EMPLOYMENT_AUDIT_ACTIONS.grantApproved,
    resourceId: minted.id,
    metadata: {
      role_id: role.id,
      assignment_id: assignment.id,
      grant_id: minted.id,
      grant_shape: grantShape,
      domain,
      action_type: actionType,
      scope_kind: scopeKind,
      scope_key: scopeKey,
      amount_ceiling: amountCeiling,
      currency,
      expires_at: expiresAt,
      review_after: reviewAfter,
      reason
    }
  });
  return { grant_id: minted.id, inserted: minted.inserted, status: minted.status };
};

// REVOKE. Owner withdraws a standing grant; the store writer records the
// plane-level receipt, this adds the employment-level one.
export const revokeRoleGrant = async (client, {
  firmId, clientId, grantId, actorType = 'owner', actorId = null, reason = null
} = {}) => {
  if (!client || !firmId || !grantId) throw new Error('revokeRoleGrant requires client, firmId, grantId');
  assertOwnerActor(actorType, 'revokeRoleGrant');
  const revoked = await revokeActionAuthorityGrant(client, {
    firmId, grantId, revokedByActorType: actorType, revokedByActorId: actorId, reason
  });
  if (!revoked) return { revoked: false, grant_id: grantId };

  await auditEmployment(client, {
    firmId,
    clientId: clientId ?? revoked.client_id ?? null,
    actorType, actorId,
    action: ROLE_EMPLOYMENT_AUDIT_ACTIONS.grantRevoked,
    resourceId: grantId,
    metadata: {
      grant_id: grantId,
      role_id: revoked.provenance?.role_id ?? null,
      domain: revoked.domain,
      action_type: revoked.action_type,
      scope_kind: revoked.scope_kind,
      scope_key: revoked.scope_key,
      reason
    }
  });
  return { revoked: true, grant_id: grantId, role_id: revoked.provenance?.role_id ?? null };
};
