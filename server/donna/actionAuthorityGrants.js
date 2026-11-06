// action_authority_grants — the D6 generalization of the 040 grant engine
// (migration 095). ONE scoped, ceilinged, auto-suspend-on-correction authority
// store with a DOMAIN column, instead of a fourth per-domain copy
// (docs/design-donna-outbound-actions-execution-plan.md D6; the gap analysis
// flagged the 040/054/083 triplication as the anti-pattern).
//
// Live consumer in M2: the outbound executor's authority-resolution seam
// (actionExecutor.js) — a domain='outbound' grant scoped to a counterparty ×
// action type lets a specific counterparty's sends execute unattended once the
// D4 settlement signal makes that graduation honest. The three legacy copies
// (reconciliation 040, ledger-sync 054, inventory 083) keep their own tables;
// their domains are in the 095 CHECK so migrating them later is a data move.
//
// DORMANT BY CONSTRUCTION at ship time: no runtime surface mints grants yet
// (the mint below is the tested writer for the future owner surface), so the
// executor's lookup finds nothing. Graduating any OUTBOUND_* flag to 'auto'
// additionally stays refused by AUTO_FORBIDDEN_FLAGS until Kari's D1 call is
// recorded — this module widens no live behavior on its own.
//
// Self-service doctrine (2026-07-23): the OWNER is the only human in the loop,
// so the OWNER is the only runtime minting authority — a grant is the owner
// saying "Donna may keep doing this without asking". `system` may mint only on
// the audited migration path with an originating human authority recorded in
// provenance (the 040 guard, kept verbatim in spirit).
//
// Every check fails CLOSED: a doubt means no grant, which means the action
// rests on the owner — never a silent auto-execute.

import crypto from 'node:crypto';
import { assertEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';

export const ACTION_GRANT_DOMAINS = Object.freeze([
  'outbound', 'reconciliation', 'ledger_sync', 'inventory'
]);
export const ACTION_GRANT_SCOPE_KINDS = Object.freeze([
  'counterparty', 'merchant', 'account_pair'
]);
export const ACTION_GRANT_SOURCES = Object.freeze([
  'owner_approval', 'learned_from_pattern', 'migration'
]);
export const ACTION_GRANT_STATUSES = Object.freeze([
  'proposed', 'active', 'suspended', 'revoked'
]);

// Runtime mint = the OWNER (the only human in the loop under the 2026-07-23
// re-amendment). `system` only via the audited migration path.
export const ACTION_GRANT_RUNTIME_MINT_ACTOR_TYPES = Object.freeze(['owner']);

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

const toEpoch = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const normalizeCurrency = (value) => String(value || '').trim().toUpperCase();

// Deterministic id: the same grant (firm + client + domain + action + scope)
// upserts into the same row. The client id IS part of the key — a grant is
// client-scoped governance (the 040 convention).
export const buildActionAuthorityGrantId = ({
  firmId, clientId, domain, actionType, scopeKind, scopeKey
} = {}) => {
  const hash = crypto
    .createHash('sha256')
    .update([firmId, clientId, domain, actionType, scopeKind, scopeKey].join('|'))
    .digest('hex')
    .slice(0, 16);
  const slug = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'unknown';
  return ['action-grant', slug(domain), slug(clientId), hash].join('-');
};

// Pure guard: may THIS grant row carry THIS execution right now? Every clause
// fails closed (the 040 grantRowAllowsAutoAccept discipline, generalized).
export const grantRowAllowsAutoExecute = (
  grant,
  { domain, actionType, amount, currency, asOf = new Date() } = {}
) => {
  if (!grant || typeof grant !== 'object') return false;
  if (grant.domain !== domain) return false;
  if (grant.action_type !== actionType) return false;
  // Only an ACTIVE grant executes — proposed / suspended / revoked never do.
  if (grant.status !== 'active') return false;
  // A grant whose later use was corrected is unusable until re-reviewed.
  if (Number(grant.correction_count) > 0) return false;
  // Required ceiling — never an accidental unlimited grant.
  const ceiling = Number(grant.amount_ceiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (value > ceiling) return false;
  if (normalizeCurrency(grant.currency) !== normalizeCurrency(currency)) return false;
  // Validity window: not before valid_from, not at/after expires_at, not
  // at/past the mandatory review_after.
  const now = toEpoch(asOf);
  if (now == null) return false;
  const validFrom = toEpoch(grant.valid_from);
  if (validFrom != null && validFrom > now) return false;
  const expiresAt = toEpoch(grant.expires_at);
  if (expiresAt != null && expiresAt <= now) return false;
  const reviewAfter = toEpoch(grant.review_after);
  if (reviewAfter != null && reviewAfter <= now) return false;
  return true;
};

// The executor's lookup. Returns the covering grant row or null (→ the action
// rests on the owner). Fails closed on every doubt; pre-migration soft-fail.
export const findActiveActionAuthorityGrant = async (client, {
  firmId, clientId, domain, actionType,
  scopeKind = 'counterparty', scopeKey,
  amount, currency, asOf = new Date()
} = {}) => {
  if (!client || !firmId || !clientId) return null;
  if (!ACTION_GRANT_DOMAINS.includes(domain)) return null;
  if (!actionType || !scopeKey) return null;
  if (!ACTION_GRANT_SCOPE_KINDS.includes(scopeKind)) return null;
  await assertEntityReadinessAdmissionWithClient({
    client,
    firmId,
    clientId,
    boundary: 'action_authority',
    resourceType: 'action_authority',
    resourceId: `${domain}:${actionType}:${scopeKey}`
  });
  let result;
  try {
    result = await client.query(
      `select * from action_authority_grants
        where firm_id = $1 and client_id = $2 and domain = $3
          and action_type = $4 and scope_kind = $5 and scope_key = $6
        order by updated_at desc`,
      [firmId, clientId, domain, actionType, scopeKind, scopeKey]
    );
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }
  for (const grant of result.rows || []) {
    if (grantRowAllowsAutoExecute(grant, { domain, actionType, amount, currency, asOf })) {
      return grant;
    }
  }
  return null;
};

// Stamp a use (the executor calls this in the finalize transaction so the
// grant's history is reconstructable from the row alone).
export const recordActionGrantUse = async (client, { firmId, grantId } = {}) => {
  if (!client || !firmId || !grantId) return null;
  try {
    const { rows } = await client.query(
      `update action_authority_grants
          set use_count = use_count + 1, last_used_at = now(), updated_at = now()
        where firm_id = $1 and id = $2
        returning id, use_count`,
      [firmId, grantId]
    );
    return rows[0] || null;
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }
};

// Auto-suspend on correction (the 040 Slice-5 pattern): when the owner later
// corrects/disputes something a grant auto-executed, the grant suspends BEFORE
// its next use. A revoked grant stays revoked; the counter still bumps.
export const suspendActionGrantAfterCorrection = async (client, {
  firmId, grantId, reason = 'post_grant_correction', resourceId = null
} = {}) => {
  if (!client || !firmId || !grantId) return null;
  let result;
  try {
    result = await client.query(
      `update action_authority_grants
          set correction_count = correction_count + 1,
              status = case when status = 'revoked' then 'revoked' else 'suspended' end,
              updated_at = now()
        where firm_id = $1 and id = $2
        returning id, client_id, status, correction_count`,
      [firmId, grantId]
    );
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }
  if (!result.rows.length) return null;
  const row = result.rows[0];
  try {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'action_authority_grant.auto_suspended', 'action_authority_grant', $3, $4::jsonb)`,
      [firmId, row.client_id, grantId, JSON.stringify({
        reason, resource_id: resourceId,
        correction_count: Number(row.correction_count), status: row.status
      })]
    );
  } catch (auditError) {
    if (!missingTables(auditError)) {
      console.warn('[actionAuthorityGrants] auto-suspend audit failed', auditError?.message || auditError);
    }
  }
  return { id: grantId, status: row.status, correction_count: Number(row.correction_count) };
};

// Mint (or idempotently upsert) a grant. Guards before any write:
//   - runtime mint requires the OWNER (self-service: nobody else can grant
//     standing authority over their book); `system` only on the audited
//     migration path with provenance.originating_authority;
//   - required ceiling + currency;
//   - learned_from_pattern may only PROPOSE, never activate.
// Returns { id, inserted, status } or null when a guard rejects the mint.
export const mintActionAuthorityGrant = async (client, {
  firmId, clientId, domain, actionType,
  scopeKind = 'counterparty', scopeKey,
  amountCeiling, currency,
  authorizedByActorType, authorizedByActorId = null,
  source, provenance = {}, status = 'active',
  validFrom = null, expiresAt = null, reviewAfter = null,
  policyVersion = null, model = null,
  isMigration = false
} = {}) => {
  if (!client || !firmId || !clientId) return null;
  if (!ACTION_GRANT_DOMAINS.includes(domain)) return null;
  if (!actionType || !scopeKey) return null;
  if (!ACTION_GRANT_SCOPE_KINDS.includes(scopeKind)) return null;
  if (!ACTION_GRANT_SOURCES.includes(source)) return null;

  const runtimeAuthority = ACTION_GRANT_RUNTIME_MINT_ACTOR_TYPES.includes(authorizedByActorType);
  const migrationSystem =
    isMigration
    && authorizedByActorType === 'system'
    && !!provenance
    && !!provenance.originating_authority;
  if (!runtimeAuthority && !migrationSystem) return null;

  const ceiling = Number(amountCeiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  if (!currency) return null;

  let effectiveStatus = status;
  if (source === 'learned_from_pattern' && effectiveStatus === 'active') effectiveStatus = 'proposed';
  if (!ACTION_GRANT_STATUSES.includes(effectiveStatus)) return null;

  const id = buildActionAuthorityGrantId({ firmId, clientId, domain, actionType, scopeKind, scopeKey });
  let result;
  try {
    result = await client.query(
      `insert into action_authority_grants (
         id, firm_id, client_id, domain, action_type, scope_kind, scope_key,
         amount_ceiling, currency, authorized_by_actor_type, authorized_by_actor_id,
         source, provenance, status, valid_from, expires_at, review_after,
         policy_version, model
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11,
         $12, $13::jsonb, $14, coalesce($15, now()), $16, $17,
         $18, $19
       )
       on conflict (id) do update set
         amount_ceiling = excluded.amount_ceiling,
         currency = excluded.currency,
         authorized_by_actor_type = excluded.authorized_by_actor_type,
         authorized_by_actor_id = excluded.authorized_by_actor_id,
         source = excluded.source,
         provenance = action_authority_grants.provenance || excluded.provenance,
         status = excluded.status,
         expires_at = excluded.expires_at,
         review_after = excluded.review_after,
         policy_version = excluded.policy_version,
         model = excluded.model,
         updated_at = now()
       returning id, (xmax = 0) as inserted, status`,
      [id, firmId, clientId, domain, actionType, scopeKind, scopeKey,
        ceiling, currency, authorizedByActorType, authorizedByActorId,
        source, JSON.stringify(provenance || {}), effectiveStatus,
        validFrom, expiresAt, reviewAfter, policyVersion, model]
    );
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }

  const inserted = Boolean(result.rows[0]?.inserted);
  if (inserted) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, 'action_authority_grant.minted', 'action_authority_grant', $5, $6::jsonb)`,
      [firmId, clientId, authorizedByActorType, authorizedByActorId, id, JSON.stringify({
        domain, action_type: actionType, scope_kind: scopeKind, scope_key: scopeKey,
        amount_ceiling: ceiling, currency, source, status: effectiveStatus, model
      })]
    );
  }
  return { id, inserted, status: result.rows[0]?.status || effectiveStatus };
};

// Revoke a standing grant — the owner withdrawing delegated authority (the
// mint's inverse, same owner-only law). Idempotence favors the FIRST
// revocation: an already-revoked grant returns null so its original
// revoked_reason is never overwritten. Returns the revoked row (with
// provenance, so callers can attribute the employment-level receipt) or null.
export const revokeActionAuthorityGrant = async (client, {
  firmId, grantId, revokedByActorType = 'owner', revokedByActorId = null, reason = null
} = {}) => {
  if (!client || !firmId || !grantId) return null;
  if (!ACTION_GRANT_RUNTIME_MINT_ACTOR_TYPES.includes(revokedByActorType)) return null;
  let result;
  try {
    result = await client.query(
      `update action_authority_grants
          set status = 'revoked', revoked_by_actor_id = $3, revoked_reason = $4, updated_at = now()
        where firm_id = $1 and id = $2 and status <> 'revoked'
        returning id, client_id, domain, action_type, scope_kind, scope_key, status, provenance`,
      [firmId, grantId, revokedByActorId, reason]
    );
  } catch (error) {
    if (missingTables(error)) return null;
    throw error;
  }
  if (!result.rows.length) return null;
  const row = result.rows[0];
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, 'action_authority_grant.revoked', 'action_authority_grant', $5, $6::jsonb)`,
    [firmId, row.client_id, revokedByActorType, revokedByActorId, grantId, JSON.stringify({
      domain: row.domain, action_type: row.action_type,
      scope_kind: row.scope_kind, scope_key: row.scope_key, reason
    })]
  );
  return row;
};
