// Delegated authority for material reconciliation matches — the grant store.
// Slice 1 of the #5 design:
// docs/proposal-2026-06-23-delegated-authority-material-matches.md.
//
// A grant is a SCOPED, standing, AUTHORITY-minted record that lets Donna
// auto-accept a MATERIAL reconciliation match — one the strong model + the A–E
// gate stack already authorized on everything EXCEPT the materiality ceiling
// (Gate E). With a covering grant the match auto-reconciles honestly (terminal
// 1) instead of resting on a per-line firm click (the two-terminal-states
// first principle, CLAUDE.md).
//
// This module is the AUTHORITY layer only. It decides WHETHER the model's match
// executes unattended; it NEVER re-decides, re-ranks, or rescues WHICH line
// settles what — that stays the model's A–D judgment. The lookup may bypass
// Gate E and nothing else. Every check below fails CLOSED: a doubt surfaces the
// match as 'suggested', it never hides or force-accepts one.
//
// Mirrors the firmFacts.js store conventions (deterministic id, upsert + audit
// on genuine insert, pre-migration soft-fail). A grant dies with its client via
// the client_id FK cascade (migration 040), so there is no provenance-purge
// like firm_facts needs.

import crypto from 'node:crypto';

import {
  delegationGateProof,
  grantAuthority,
  normalizeCurrency,
  delegatedAuthorityCanaryAllows,
  delegatedAuthorityClientScoped,
  DELEGATED_AUTHORITY_FLAG_KEY
} from './reconciliationLlmCore.js';
// 0A.8 — the config control plane shim. clientFlagActs only; readClientConfigSnapshot is
// NOT imported here: the snapshot is resolved ONCE per run in the orchestrator (shared with
// twin-date / material-auto-fyi) and threaded in via the configSnapshot param, so the
// authority module adds NO db read of its own (preserving the fail-closed db-round-trip
// assertions). snapshot null ⇒ clientFlagActs falls back to the env predicate (byte-identical).
import { clientFlagActs } from './clientConfig.js';
import { checkEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';

export const GRANT_SCOPE_KINDS = ['merchant', 'counterparty', 'account_pair'];
export const GRANT_ARCHETYPES = ['recurring_rent_lease', 'verified_card_payment', 'internal_transfer'];
export const GRANT_ACTIONS = ['accept_match', 'accept_and_post'];
export const GRANT_STATUSES = ['proposed', 'active', 'suspended', 'revoked'];
export const GRANT_SOURCES = ['operator_one_click', 'accountant_approval', 'learned_from_pattern'];

// Runtime mint requires a firm-side AUTHORITY actor. `system` is deliberately
// EXCLUDED here (it is in loopExecutionPolicy.AUTHORITY_ACTOR_TYPES for
// suspensions/migrations) so the system can never grant ITSELF standing
// auto-accept authority — guard 5.1. `system` may mint only on the audited
// migration path, with an originating human authority recorded in provenance.
export const RUNTIME_MINT_ACTOR_TYPES = ['firm_operator', 'accountant', 'admin'];

const toEpoch = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// Deterministic id: the same grant (firm + client + scope + action) upserts into
// the same row. UNLIKE firm_facts, the client id IS part of the key — a grant is
// client-scoped governance, not cross-client identity memory, so two clients in
// one firm with the same scope must never collide on one row.
export const buildAuthorityGrantId = ({ firmId, clientId, scopeKind, scopeKey, action } = {}) => {
  const hash = crypto
    .createHash('sha256')
    .update([firmId, clientId, scopeKind, scopeKey, action].join('|'))
    .digest('hex')
    .slice(0, 16);
  const slug = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'unknown';
  return ['recon-grant', slug(clientId), slug(scopeKey), hash].join('-');
};

// Pure guard: may THIS grant row auto-accept THIS match right now? Every clause
// fails closed. Factored out of findActiveAuthorityGrant so the safety
// invariants (§9) are unit-testable directly against a row object.
export const grantRowAllowsAutoAccept = (
  grant,
  { matchAmount, currency, action = 'accept_match', asOf = new Date() } = {}
) => {
  if (!grant || typeof grant !== 'object') return false;
  // V1 supports only accept_match; an accept_and_post row fails closed (no
  // posting authority yet — guard 5.3).
  if (action !== 'accept_match') return false;
  if (grant.action !== 'accept_match') return false;
  // Only an ACTIVE grant executes — proposed / suspended / revoked never do.
  if (grant.status !== 'active') return false;
  // A grant whose later use was corrected is unusable until re-reviewed
  // (auto-suspend lands in Slice 5; the lookup also fails it closed now).
  if (Number(grant.correction_count) > 0) return false;
  // Required ceiling — never an accidental unlimited grant.
  const ceiling = Number(grant.amount_ceiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
  const amount = Number(matchAmount);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (amount > ceiling) return false;
  if (normalizeCurrency(grant.currency) !== normalizeCurrency(currency)) return false;
  // Validity window: not before valid_from, not at/after expires_at, not at/past
  // the mandatory review_after.
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

// The §9 lookup. Returns the covering grant row, or null (→ the match stays
// 'suggested' and routes to the bounded authorization transition, Slice 3).
// Fails closed on every doubt. The archetype/scope_key derivation from the
// document + proposal is Slice 4's job; this function takes them already
// derived, plus `firstUseAccountInvolved` (the new-account precondition).
export const findActiveAuthorityGrant = async ({
  client,
  firmId,
  clientId,
  authorization,
  matchAmount,
  currency,
  archetype,
  scopeKey,
  action = 'accept_match',
  firstUseAccountInvolved = false,
  asOf = new Date(),
  env = process.env,
  // 0A.8 — the per-run config snapshot, threaded from the orchestrator (resolved once,
  // shared with the matcher's other flags). null ⇒ env fallback (byte-identical).
  configSnapshot = null
} = {}) => {
  if (!client || !firmId || !clientId) return null;
  // Slice 6 — the §15 canary GATES the whole auto-accept: even a covering active
  // grant may not execute for a client the firm has not put on the delegated-
  // authority allowlist. Fails closed (→ the match stays 'suggested' and the ask
  // producer drives it to a terminal), mirroring RECONCILIATION_AUTO_MATCH_CLIENTS.
  // This is the chokepoint EVERY auto-accept routes through (applyDelegatedAuthority
  // calls it), so this one gate covers all four orchestrators. It is an ADDITIONAL
  // gate, never a replacement — the A–D proof, first-use, accept_match-only and the
  // per-row grantRowAllowsAutoAccept guards below all still apply.
  // 0A.8 — routed through the config control plane: a client_capability_config row
  // (DB stage) decides, else the env canary (envFallback). Fail-closed both ways.
  if (!clientFlagActs({
    flagKey: DELEGATED_AUTHORITY_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => delegatedAuthorityCanaryAllows(clientId, env),
    env
  })) return null;
  // Safety gate 1 (the key fix): the receipt must AFFIRMATIVELY prove A–D true
  // and E false. Never infer A–D from reason strings. Bypass Gate E only.
  if (!delegationGateProof(authorization)) return null;
  // Safety gate 2: never auto-accept anything touching a first-use / unapproved
  // account (guard 5.6) — checked before we even look for a grant.
  if (firstUseAccountInvolved) return null;
  // V1 supports only accept_match requests.
  if (action !== 'accept_match') return null;
  if (!archetype || !scopeKey) return null;

  const readiness = await checkEntityReadinessAdmissionWithClient({
    client,
    firmId,
    clientId,
    boundary: 'reconciliation_authority',
    resourceType: 'reconciliation_authority',
    resourceId: `${archetype}:${scopeKey}`
  });
  if (!readiness.allowed) return null;

  let result;
  try {
    result = await client.query(
      `select * from reconciliation_authority_grants
        where firm_id = $1 and client_id = $2 and archetype = $3 and scope_key = $4
        order by updated_at desc`,
      [firmId, clientId, archetype, scopeKey]
    );
  } catch (error) {
    // Pre-migration deploy: no authority table → no delegated authority, never a
    // dead matcher call. (Same posture as firmFacts / loadKnownCounterparties.)
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }

  for (const grant of result.rows || []) {
    if (grantRowAllowsAutoAccept(grant, { matchAmount, currency, action, asOf })) return grant;
  }
  return null;
};

// Slice 2 of the #5 design — the accept-path seam the per-direction
// orchestrators call between authorizeMatch() and upsertMatchAndCascade().
// Given the freshly-computed in-memory authorization receipt plus the line's
// already-derived archetype + scope_key, IF the match is materiality-held
// (delegationGateProof) AND a covering ACTIVE grant exists, it upgrades the
// receipt to an auto_matched 'delegated_authority' one via core's
// grantAuthority — so the existing upsert→cascade auto-reconciles the line
// (terminal 1). Otherwise it returns the authorization UNCHANGED: no grant means
// the line stays 'suggested' and routes to the bounded authorization transition
// (Slice 3's job), never a silent accept.
//
// Lives in the STORE, not core, because it needs the grant lookup; keeping it
// here preserves the acyclic DAG (orchestrator → {core, store}, store → core,
// core → neither). Fail-closed by construction: every doubt inside
// findActiveAuthorityGrant / grantRowAllowsAutoAccept returns null → the
// authorization passes through untouched.
//
// SEQUENCING (handoff): archetype + scope_key derivation is Slice 4's job. Until
// it lands, callers pass archetype = null, so findActiveAuthorityGrant returns
// null and this is a NO-OP at runtime — the safe, behavior-preserving default.
// `proposal` and `document` are accepted now (the orchestrators have them in
// scope) so Slice 4 can plug classification in here without re-touching the four
// call sites; they are unused in V1, where archetype/scopeKey arrive pre-derived.
export const applyDelegatedAuthority = async ({
  client,
  firmId,
  clientId,
  authorization,
  // Slice 4 classification inputs — accepted now so wiring them in later does
  // not re-touch the four call sites; unused in V1 (archetype/scopeKey arrive
  // pre-derived). Intentionally not destructured into locals to avoid dead refs.
  proposal: _proposal = null,
  document: _document = null,
  matchAmount,
  currency,
  archetype = null,
  scopeKey = null,
  action = 'accept_match',
  firstUseAccountInvolved = false,
  asOf = new Date(),
  env = process.env,
  // 0A.8 — the per-run config snapshot, threaded from the orchestrator (resolved once,
  // shared with the matcher's other flags). null ⇒ env fallback (byte-identical).
  configSnapshot = null
} = {}) => {
  // Slice 6 — the §15 canary gates the whole auto-accept; mirror of the gate
  // inside findActiveAuthorityGrant so a closed canary skips the db round-trip
  // entirely. Closed → the authorization passes through UNCHANGED (the held line
  // stays 'suggested' and the canary-gated ask producer drives it to a terminal).
  // 0A.8 — routed through the config plane (same snapshot threaded to the inner
  // findActiveAuthorityGrant so both gates agree). clientFlagActs is a pure in-memory
  // check (no db read), so the closed-canary "no db round-trip" property is preserved.
  if (!clientFlagActs({
    flagKey: DELEGATED_AUTHORITY_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => delegatedAuthorityCanaryAllows(clientId, env),
    env
  })) return authorization;
  // Cheap fast-path: not a materiality-held match → never delegated, skip the
  // db round-trip. findActiveAuthorityGrant re-checks this (the affirmative gate
  // proof is the authoritative guard); this only avoids a needless query.
  if (!delegationGateProof(authorization)) return authorization;

  const grant = await findActiveAuthorityGrant({
    client,
    firmId,
    clientId,
    authorization,
    matchAmount,
    currency,
    archetype,
    scopeKey,
    action,
    firstUseAccountInvolved,
    asOf,
    env,
    configSnapshot
  });
  if (!grant) return authorization;

  // The grant only bypasses Gate E; grantAuthority preserves the A–D proof. Stamp
  // whether a client allowlist scoped this accept (env-state, not grant-state) so
  // "auto-executed under the <client>-only canary" is reconstructable from the
  // receipt alone (CLAUDE.md "the model id is the receipt"), paired with the
  // match's client_id — the delegated-authority twin of the auto-match receipt's
  // policy.client_scoped.
  const upgraded = grantAuthority(authorization, grant);
  return {
    ...upgraded,
    delegated_authority: {
      ...upgraded.delegated_authority,
      client_scoped: delegatedAuthorityClientScoped(env)
    }
  };
};

// #5 Slice 5 — the PRODUCER side of auto-suspend-on-correction. The ENFORCEMENT
// side already lives in grantRowAllowsAutoAccept (`correction_count > 0` fails
// closed). When a human later corrects/rejects a match a grant auto-accepted,
// bump that grant's correction_count and suspend it BEFORE its next use, so the
// next findActiveAuthorityGrant fails closed (§9, §14 post-grant-correction).
//
// Conventions mirror the rest of the store: deterministic write, audit-on-write,
// pre-migration soft-fail. A REVOKED grant stays revoked (a stronger governance
// "no" than suspended) but still has its correction_count bumped for the metric.
// Idempotent-ish: a second correction just re-bumps the counter; status holds.
// Designed to run POST-COMMIT on an autocommit connection (like the loops
// producers) — a caught 42P01 there cannot abort an open transaction.
export const suspendGrantAfterCorrection = async ({
  client,
  firmId,
  grantId,
  matchId = null,
  reason = 'post_grant_correction'
} = {}) => {
  if (!client || !firmId || !grantId) return null;
  let result;
  try {
    result = await client.query(
      `update reconciliation_authority_grants
          set correction_count = correction_count + 1,
              status = case when status = 'revoked' then 'revoked' else 'suspended' end,
              updated_at = now()
        where firm_id = $1 and id = $2
        returning id, client_id, status, correction_count`,
      [firmId, grantId]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }
  if (!result.rows.length) return null;
  const row = result.rows[0];
  try {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'reconciliation_authority_grant.auto_suspended', 'reconciliation_authority_grant', $3, $4::jsonb)`,
      [
        firmId,
        row.client_id,
        grantId,
        JSON.stringify({ reason, match_id: matchId, correction_count: row.correction_count, status: row.status })
      ]
    );
  } catch (auditError) {
    // The suspend is the load-bearing write; a failed audit must not mask it.
    if (auditError?.code !== '42P01' && auditError?.code !== '42703') {
      console.warn('[reconciliationAuthorityGrants] auto-suspend audit failed', auditError?.message || auditError);
    }
  }
  return { id: grantId, status: row.status, correction_count: Number(row.correction_count) };
};

// Mint (or idempotently upsert) a grant. Enforces the authority boundary, the
// required ceiling, and the learned-pattern-proposes-only rule before any write.
// Returns { id, inserted, status } or null when a guard rejects the mint.
export const mintAuthorityGrant = async ({
  client,
  firmId,
  clientId,
  scopeKind,
  scopeKey,
  archetype,
  action = 'accept_match',
  amountCeiling,
  currency,
  authorizedByActorType,
  authorizedByActorId = null,
  source,
  provenance = {},
  status = 'active',
  validFrom = null,
  expiresAt = null,
  reviewAfter = null,
  policyVersion = null,
  model = null,
  // Audited migration/backfill path: the ONLY way `system` may appear as the
  // authorizing actor, and only with an originating human authority recorded in
  // provenance.originating_authority.
  isMigration = false
} = {}) => {
  if (!client || !firmId || !clientId) return null;
  if (!GRANT_SCOPE_KINDS.includes(scopeKind)) return null;
  if (!scopeKey) return null;
  if (!GRANT_ARCHETYPES.includes(archetype)) return null;
  if (!GRANT_ACTIONS.includes(action)) return null;
  if (!GRANT_SOURCES.includes(source)) return null;

  // Authority guard (5.1): runtime mint requires firm_operator/accountant/admin.
  // `system` is allowed ONLY on the migration path with an originating authority.
  const runtimeAuthority = RUNTIME_MINT_ACTOR_TYPES.includes(authorizedByActorType);
  const migrationSystem =
    isMigration &&
    authorizedByActorType === 'system' &&
    !!provenance &&
    !!provenance.originating_authority;
  if (!runtimeAuthority && !migrationSystem) return null;

  // Required ceiling — no accidental unlimited grant.
  const ceiling = Number(amountCeiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  if (!currency) return null;

  // learned_from_pattern may only PROPOSE, never activate (guard 5.2): a learned
  // pattern that asked to be active is coerced to 'proposed'. Activation needs an
  // explicit authority approval (a later slice / an operator action).
  let effectiveStatus = status;
  if (source === 'learned_from_pattern' && effectiveStatus === 'active') effectiveStatus = 'proposed';
  if (!GRANT_STATUSES.includes(effectiveStatus)) return null;

  const id = buildAuthorityGrantId({ firmId, clientId, scopeKind, scopeKey, action });

  let result;
  try {
    result = await client.query(
      `insert into reconciliation_authority_grants (
         id, firm_id, client_id, scope_kind, scope_key, archetype, action,
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
         archetype = excluded.archetype,
         authorized_by_actor_type = excluded.authorized_by_actor_type,
         authorized_by_actor_id = excluded.authorized_by_actor_id,
         source = excluded.source,
         provenance = reconciliation_authority_grants.provenance || excluded.provenance,
         status = excluded.status,
         expires_at = excluded.expires_at,
         review_after = excluded.review_after,
         policy_version = excluded.policy_version,
         model = excluded.model,
         updated_at = now()
       returning id, (xmax = 0) as inserted, status`,
      [
        id,
        firmId,
        clientId,
        scopeKind,
        scopeKey,
        archetype,
        action,
        ceiling,
        currency,
        authorizedByActorType,
        authorizedByActorId,
        source,
        JSON.stringify(provenance || {}),
        effectiveStatus,
        validFrom,
        expiresAt,
        reviewAfter,
        policyVersion,
        model
      ]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }

  const inserted = Boolean(result.rows[0]?.inserted);
  if (inserted) {
    // Audit only on a genuine insert (idempotent re-mint doesn't spam the trail),
    // same discipline as saveFirmFact. The minting authority is the actor.
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, 'reconciliation_authority_grant.minted', 'reconciliation_authority_grant', $5, $6::jsonb)`,
      [
        firmId,
        clientId,
        authorizedByActorType,
        authorizedByActorId,
        id,
        JSON.stringify({
          scope_kind: scopeKind,
          scope_key: scopeKey,
          archetype,
          action,
          amount_ceiling: ceiling,
          currency,
          source,
          status: effectiveStatus,
          model
        })
      ]
    );
  }
  return { id, inserted, status: result.rows[0]?.status || effectiveStatus };
};

// Slice G — load a client's ACTIVE authority grants (the materiality-threshold
// source for the case snapshot's riskContext). Returns the lean ceiling rows; the
// pure `materialityThresholdFromGrants` (authorityEnvelope.js) does the filtering +
// most-conservative pick, so this stays a thin read. NOT the auto-accept lookup —
// that is findActiveAuthorityGrant (scope/archetype-keyed, with the fail-closed
// guards). This is a read-only aggregate: it never decides whether a match executes.
//
// Pre-migration soft-fail (42P01/42703 → []), matching the rest of the store: a
// 039-but-not-040 deploy yields no threshold, so the snapshot keeps the honest
// `materiality_band: unknown` rather than throwing.
export const loadActiveGrantsForClient = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return [];
  try {
    const result = await client.query(
      `select id, amount_ceiling, currency, status, correction_count
         from reconciliation_authority_grants
        where firm_id = $1 and client_id = $2 and status = 'active'`,
      [firmId, clientId]
    );
    return result.rows || [];
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return [];
    throw error;
  }
};
