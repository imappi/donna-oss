// Self-serve workspace provisioning — the missing bridge in the signup funnel.
//
// Before this, a freshly-authenticated business owner (a Supabase user with no
// firm membership) was routed to the firm console and 401'd: there was no way
// for a non-member to create a workspace, and `POST /clients` requires a firm
// member. This turns that owner into a billable CLIENT under the Donna firm,
// with the owner bound as a client-scoped collaborator + a client_assignment —
// exactly the principal the portal entitlement gate
// (clientSubscriptionDb.assertClientEntitled) already targets.
//
// Entity model (Kari's call, 2026-06-28): ONE Donna firm; each signup is a
// client under it; the owner is a firm_collaborator (access_level
// client_scoped, role 'owner'). NOT a firm-per-signup — that diverges from the
// founder-led DFY model (the founder/pod service customers under one firm).
//
// Kept OUT of firmDb.js (the reconcile/coding engine) on purpose, mirroring
// clientSubscriptionDb.js: a thin module over queryFirmDb + the existing
// createClientInDb, never new reconcile logic.
//
// IDEMPOTENT per owner: the client/collaborator/assignment ids are DETERMINISTIC
// from (firm_id, email), and every write is an upsert. So a retry after a
// partial failure converges onto the SAME rows instead of leaking a second
// workspace — without needing one cross-statement transaction around
// createClientInDb (which manages its own).

import { selfProvisionId as idFor } from './selfProvisionIdentity.js';
import { requestDeletedOwnerRecovery } from './deletedOwnerRecovery.js';

import {
  queryFirmDb,
  withFirmDbClient,
  DEFAULT_FIRM_ID,
  assertFirmScopeAllowed,
  resolveConfiguredDefaultFirmId,
  createClientInDb
} from './firmDb.js';
import { resolveProvisioningPolicy } from './provisioningPolicyRegistry.js';
import { canonicalizeClientLegalForm } from './clientLegalForm.js';
import { SUPPORTED_SELF_SERVE_JURISDICTIONS } from '../../src/lib/qualificationGate.js';
import { toUtcIsoDay } from './dates.js';
import { revalidateExistingOwnerForPilot } from './existingOwnerRevalidation.js';

// The owner is a client-scoped collaborator with this role — distinct from the
// pod's default 'bookkeeper', so a future owner-vs-pod policy can tell them
// apart, and so findOwnedClientId only ever returns a workspace the user OWNS.
const OWNER_ROLE = 'owner';

// The CORE bookkeeping intake a self-serve owner is seeded with. You cannot do a
// close from bank statements alone, so this MUST include sales invoices and
// supplier bills/receipts, not just bank rec (SERVICE_TO_TILE maps these to the
// bank/sales/bills portal tiles). Single source of truth for both the fresh
// create and the returning-owner heal below. Payroll/loan tracking are
// intentionally omitted (not universal; the firm broadens scope later).
const CORE_SELF_SERVE_SERVICES = ['bank_reconciliation', 'sales_invoicing', 'bills_and_expenses'];

// Should a returning self-serve owner's existing services_engaged be healed up
// to the core intake? ONLY the "incomplete legacy self-serve" shapes — absent,
// explicit [], or the OLD bank-only seed (`['bank_reconciliation']`, what the
// pre-#679 create wrote). A richer/different explicit scope (the firm added
// sales/bills/payroll/etc.) is a deliberate decision and is left untouched.
// Pure + exported for unit coverage.
export const needsCoreServicesHeal = (existing) => {
  if (existing == null) return true; // legacy absent → no scope ever set
  if (!Array.isArray(existing)) return false; // unknown shape → don't touch
  if (existing.length === 0) return true; // explicit [] → "unscoped" placeholder
  return existing.length === 1 && existing[0] === 'bank_reconciliation'; // old self-serve seed
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export const normalizeProvisionJurisdiction = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const jurisdiction = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(jurisdiction)) {
    const error = new Error('Jurisdiction must be a valid ISO-2 country code.');
    error.statusCode = 400;
    error.code = 'PROVISION_JURISDICTION_INVALID';
    throw error;
  }
  return jurisdiction;
};

// Launch-scope enforcement (critical-path §5): a DECLARED jurisdiction outside
// the self-serve set refuses before any row is written. Until now the scope
// lived only in the browser gate (qualificationGate.js) — a drifted or bypassed
// funnel could mint a workspace that then dead-ends at checkout
// (BILLING_JURISDICTION_UNSUPPORTED — the right refusal at the wrong time).
// The set is IMPORTED from the FE gate so the two layers cannot drift; which
// jurisdictions are in it is Kari's call (2026-07-31: GB advertised, FI
// accepted for invited owners — see publicAvailability.js), not this module's.
//
// null passes THROUGH: a qualified owner who opens their auth link on another
// device has no stashed offer, so /self-provision legitimately arrives with no
// jurisdiction; refusing that would strand a real signup on the provisioner's
// error screen. The null-jurisdiction workspace is the sanctioned degraded
// path — the portal chases the missing profile facts, and checkout still
// enforces billing eligibility.
export const assertProvisionJurisdictionSupported = (jurisdiction) => {
  if (jurisdiction == null) return null;
  if (!SUPPORTED_SELF_SERVE_JURISDICTIONS.has(jurisdiction)) {
    const error = new Error(`Donna self-serve signup is not yet available for jurisdiction "${jurisdiction}".`);
    error.statusCode = 409;
    error.code = 'PROVISION_JURISDICTION_UNSUPPORTED';
    throw error;
  }
  return jurisdiction;
};

export const normalizeProvisionEntityType = ({ jurisdiction, entityType } = {}) => {
  let canonical = null;
  try {
    canonical = canonicalizeClientLegalForm({ jurisdiction, entityType }).canonical;
  } catch (cause) {
    if (jurisdiction !== 'GB') throw cause;
    const error = new Error(`Unsupported GB entity type: ${JSON.stringify(entityType)}.`);
    error.statusCode = 400;
    error.code = 'PROVISION_GB_ENTITY_TYPE_INVALID';
    error.details = cause?.details || null;
    error.cause = cause;
    throw error;
  }
  if (jurisdiction === 'GB' && canonical && !['gb-ltd', 'gb-sole-trader'].includes(canonical)) {
    const error = new Error(`Unsupported GB entity type: ${JSON.stringify(entityType)}.`);
    error.statusCode = 400;
    error.code = 'PROVISION_GB_ENTITY_TYPE_INVALID';
    error.details = {
      supplied_legal_form: entityType == null ? null : String(entityType),
      jurisdiction: 'GB',
      canonical_options: ['gb-ltd', 'gb-sole-trader'],
      correction: 'choose_supported_legal_form'
    };
    throw error;
  }
  return canonical;
};

export const normalizeProvisionIncorporationDate = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const date = String(value).trim();
  // toUtcIsoDay round-trips a bare day and refuses an impossible one.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || toUtcIsoDay(date) !== date) {
    const error = new Error('Incorporation date must be a valid YYYY-MM-DD date.');
    error.statusCode = 400;
    error.code = 'PROVISION_INCORPORATION_DATE_INVALID';
    throw error;
  }
  return date;
};

export const seedGbDefaultChartIfEmpty = async ({ firmId, clientId, entityType = null, dbClient = null } = {}) => {
  const chart = resolveProvisioningPolicy('gb').defaultChart(entityType);
  const run = async (client) => {
  await client.query('begin');
  try {
    const existing = await client.query('select 1 from ledger_accounts where firm_id = $1 and client_id = $2 limit 1 for update', [firmId, clientId]);
    if (existing.rows.length) { await client.query('commit'); return { seeded: false, count: 0 }; }
    for (const account of chart) {
      await client.query(
        `insert into ledger_accounts (id, firm_id, client_id, code, name, account_type, normal_balance, canonical_role, status, payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9::jsonb)
         on conflict (id) do nothing`,
        [idFor('gb-account', clientId, account.code), firmId, clientId, account.code, account.name_en, account.account_type, account.normal_balance, account.canonical_role, JSON.stringify({ source: 'gb_default_chart' })]
      );
    }
    await client.query('commit');
    return { seeded: true, count: chart.length };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  };
  return dbClient ? run(dbClient) : withFirmDbClient(run);
};

// ─── Authorization: this endpoint is a BOOTSTRAP, not a firm-binding tool ────
//
// `/self-provision` and `/provision-workspace` are deliberately reachable
// without a membership check — a brand-new owner has no membership, which is
// the whole point. That makes the request body the ONLY thing naming a firm,
// and nothing here ever authorized it: `assertFirmScopeAllowed` is a demo-firm
// isolation guard (it returns true for every real firm id), not an
// authorization check. So a validated bearer could name ANY firm and be bound
// into it as an active `client_scoped` principal.
//
// The entity model recorded at the top of this file (Kari, 2026-06-28) is the
// rule the code never enforced: ONE firm, every signup a client under it —
// explicitly NOT a firm-per-signup. A caller-named firm is therefore never
// legitimate here, so we refuse it outright rather than silently redirecting
// to the default (a silent redirect binds someone somewhere they did not ask
// for, and leaves no signal that a caller tried).
//
// Note this also closes a bypass: `assertFirmScopeAllowed` refuses the DEMO
// firm in production, and naming an arbitrary firm id used to route around
// that guard. The check now runs on the resolved target, which a caller
// cannot influence.
export class ProvisionFirmScopeError extends Error {
  constructor(firmId) {
    super(
      'Workspace provisioning is scoped to this deployment\'s firm; a caller-supplied ' +
      `firm_id ("${firmId}") is not accepted.`
    );
    this.name = 'ProvisionFirmScopeError';
    this.statusCode = 403;
    this.code = 'PROVISION_FIRM_NOT_ALLOWED';
  }
}

// Raised when an existing `firm_collaborators` row for (firm, email) is NOT
// this owner's own principal. Provisioning refuses instead of adopting it —
// see ownerRowIsAdoptable.
export class ProvisionPrincipalConflictError extends Error {
  constructor(email) {
    super(
      `An existing collaborator for "${email}" cannot be claimed by self-serve provisioning. ` +
      'A firm member must resolve this account.'
    );
    this.name = 'ProvisionPrincipalConflictError';
    this.statusCode = 409;
    this.code = 'PROVISION_PRINCIPAL_CONFLICT';
  }
}

// May this self-provision call adopt an existing firm_collaborators row?
//
// The previous upsert answered "always", via
//   on conflict (firm_id, email) do update set
//     user_id = coalesce(firm_collaborators.user_id, excluded.user_id),
//     role    = excluded.role,      -- ← rewrites ANY role to 'owner'
//     status  = 'active',           -- ← reactivates a suspended principal
// which turns an unauthenticated-by-membership endpoint into a privilege
// grant: a limited collaborator becomes an owner, a suspended one comes back,
// and the preserved foreign `user_id` still resolves for the ORIGINAL user
// while the new caller resolves by email (the auth lookup matches
// `user_id = $2 OR lower(email) = $3`, firmDb.js).
//
// The only row this path may touch is one that is ALREADY this owner's own
// principal. Anything else is refused and left exactly as it was — a
// self-serve endpoint must never be able to change someone's authority.
// Pure + exported for unit coverage.
export const ownerRowIsAdoptable = (row, { userId } = {}) => {
  if (!row) return true; // nothing there — a clean insert
  // Never elevate a bookkeeper (or any other role) to owner.
  if (row.role !== OWNER_ROLE) return false;
  // Never widen scope; an owner principal is client_scoped by construction.
  if (row.access_level !== 'client_scoped') return false;
  // Never reactivate. Re-enabling a disabled principal is a deliberate
  // administrative act, not a side effect of hitting the signup endpoint.
  if (row.status !== 'active') return false;
  // Never claim a row already bound to a DIFFERENT identity. An unbound row
  // (user_id null) is the ordinary invite/first-login case and may be claimed
  // by the authenticated holder of that email.
  const bound = String(row.user_id || '').trim();
  if (bound && bound !== String(userId || '').trim()) return false;
  return true;
};

const OWNER_ROW_COLUMNS = 'id, user_id, role, status, access_level';

// Stable, identity-keyed ids: re-running provisioning for the same owner
// re-targets the same rows (the idempotency guarantee above).
export const resolveProvisionIdentity = (auth) => ({
  email: normalizeEmail(auth?.email),
  userId: String(auth?.userId || '').trim()
});

// The client this owner already owns, or null. Doubles as the idempotency probe
// and the post-auth "where do I send them" lookup. Joins through the OWNER
// collaborator so a pod assignment can never masquerade as an owned workspace.
export const findOwnedClientId = async ({ firmId = DEFAULT_FIRM_ID, email } = {}) => {
  const clean = normalizeEmail(email);
  if (!clean) return null;
  const result = await queryFirmDb(
    `select ca.client_id
       from firm_collaborators fc
       join client_assignments ca
         on ca.firm_id = fc.firm_id
        and ca.principal_type = 'firm_collaborator'
        and ca.principal_id = fc.id
      where fc.firm_id = $1
        and lower(fc.email) = $2
        and fc.role = $3
      order by ca.created_at asc
      limit 1`,
    [firmId, clean, OWNER_ROLE]
  );
  return result.rows[0]?.client_id || null;
};

// Cheap precondition: would binding this owner hit a conflicting principal?
//
// Run BEFORE the client row is created. bindOwnerPrincipal re-checks the same
// thing under a row lock (that is the authoritative enforcement); this exists
// so a refusal happens before `createClientInDb` commits, rather than after —
// otherwise every refused call would leave a durable, inaccessible orphan
// client, which is exactly the F-35 failure mode this must not amplify.
export const assertOwnerPrincipalBindable = async ({ firmId, email, userId } = {}) => {
  const result = await queryFirmDb(
    `select ${OWNER_ROW_COLUMNS} from firm_collaborators where firm_id = $1 and lower(email) = $2 limit 1`,
    [firmId, normalizeEmail(email)]
  );
  if (!ownerRowIsAdoptable(result.rows[0] || null, { userId })) {
    throw new ProvisionPrincipalConflictError(normalizeEmail(email));
  }
};

// Bind the owner principal (collaborator) + the client_assignment, atomic
// together so a workspace is never half-bound. Converges on retry — but only
// ever onto THIS owner's own principal (ownerRowIsAdoptable); a conflicting
// row is refused, never rewritten.
// The binder body, on a caller's open transaction. Exported for the firm
// owner-invite acceptance (clientOwnerInvitesDb.js), which must consume its
// invite and bind the owner in ONE transaction; self-signup keeps calling
// bindOwnerPrincipal below, byte-identical. `assignmentId` defaults to the
// self-signup id; an invite passes a per-client id so one owner principal can
// hold assignments on several of the same firm's clients.
export const bindOwnerPrincipalWithClient = async (client, {
  firmId, email, userId, clientId, displayName, assignmentId = null
} = {}) => {
  const collaboratorId = idFor('collab-owner', firmId, email);
  // `for update` closes the check-then-write window: a concurrent
  // provision for the same (firm, email) serializes behind this lock
  // instead of both passing the adoptability check.
  const locked = await client.query(
    `select ${OWNER_ROW_COLUMNS} from firm_collaborators
      where firm_id = $1 and lower(email) = $2 limit 1 for update`,
    [firmId, email]
  );
  let existingRow = locked.rows[0] || null;
  if (!ownerRowIsAdoptable(existingRow, { userId })) {
    throw new ProvisionPrincipalConflictError(email);
  }

  let realCollaboratorId = existingRow?.id || collaboratorId;
  if (existingRow) {
    // Adoption is deliberately NARROW: fill in a missing user_id and
    // nothing else. role / status / access_level are never rewritten —
    // that rewrite WAS the vulnerability.
    await client.query(
      `update firm_collaborators
          set user_id = coalesce(user_id, $2), updated_at = now()
        where id = $1`,
      [existingRow.id, userId || null]
    );
  } else {
    const inserted = await client.query(
      `insert into firm_collaborators (id, firm_id, user_id, email, name, role, status, access_level)
       values ($1, $2, $3, $4, $5, $6, 'active', 'client_scoped')
       on conflict (firm_id, email) do nothing
       returning id`,
      [collaboratorId, firmId, userId || null, email, displayName, OWNER_ROLE]
    );
    if (inserted.rows[0]) {
      realCollaboratorId = inserted.rows[0].id;
    } else {
      // Lost an insert race (the row appeared between the locked read and
      // the insert). Re-read and re-check — never blind-adopt the winner.
      const raced = await client.query(
        `select ${OWNER_ROW_COLUMNS} from firm_collaborators
          where firm_id = $1 and lower(email) = $2 limit 1 for update`,
        [firmId, email]
      );
      existingRow = raced.rows[0] || null;
      if (!ownerRowIsAdoptable(existingRow, { userId })) {
        throw new ProvisionPrincipalConflictError(email);
      }
      realCollaboratorId = existingRow?.id || collaboratorId;
    }
  }
  await client.query(
    `insert into client_assignments (id, firm_id, client_id, principal_type, principal_id, role, access_level)
     values ($1, $2, $3, 'firm_collaborator', $4, $5, 'client_scoped')
     on conflict (client_id, principal_type, principal_id) where assignment_kind = 'capability' do nothing`,
    [assignmentId || idFor('assign-owner', firmId, email), firmId, clientId, realCollaboratorId, OWNER_ROLE]
  );
  return { collaboratorId: realCollaboratorId };
};

const bindOwnerPrincipal = async ({ firmId, email, userId, clientId, displayName } = {}) => {
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await bindOwnerPrincipalWithClient(client, { firmId, email, userId, clientId, displayName });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// Apply the owner-supplied company name to their EXISTING workspace on a
// (re-)signup. The owner is the authority on their own business name, so a name
// entered in the funnel WINS over whatever is currently stored. This fixes the
// scary case where a returning/recreated owner (same email → same deterministic
// workspace) was stuck on a STALE name from a prior signup — e.g. they signed up
// as "Santa Barbers" but the workspace still read "Kari Corp" left behind by a
// client that was deleted out-of-band (the auth user was removed but the Donna
// client row was not). The earlier "heal only the email-prefix fallback" rule
// silently dropped the new name whenever the stale name was a real one.
//
// Scoped + safe: only fires when a non-empty companyName is supplied, which (via
// readPendingOffer) happens on a FUNNEL signup — NOT on an ordinary returning
// login, because the offer is cleared after redeem (ClientPortalGate). So it does
// not re-clobber on every visit, and it converges (once company_name == desired
// the WHERE matches nothing). Updates ONLY company_name + profile.companyName;
// the rest of the profile jsonb (services_engaged, jurisdiction, …) is intact.
// No-op when companyName is empty or already matches. Returns true iff a row
// changed.
export const applyOwnerCompanyName = async ({ firmId = DEFAULT_FIRM_ID, clientId, companyName } = {}) => {
  const desired = String(companyName || '').trim();
  if (!desired || !clientId) return false;
  const result = await queryFirmDb(
    `update clients
        set company_name = $3,
            profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{companyName}', to_jsonb($3::text), true),
            updated_at = now()
      where id = $1
        and firm_id = $2
        and company_name is distinct from $3
      returning id`,
    [clientId, firmId, desired]
  );
  return result.rowCount > 0;
};

// Heal a returning self-serve owner's services_engaged up to the CORE intake.
// Sibling of applyOwnerCompanyName, and for the same reason: a self-serve owner
// (re-)signing up through the funnel should land on the real "what I need from
// you" checklist — bank + sales + bills — not a bank-only stub. The idempotent
// provisioning path deliberately does NOT re-run createClientInDb (it would
// clobber firm-side profile edits), which is exactly why a workspace created by
// the PRE-#679 self-serve path (seeded `['bank_reconciliation']`) stayed stuck
// on a single tile after the create-path fix landed.
//
// Scoped + safe + convergent, three ways:
//   - Gated on a non-empty companyName, i.e. a FUNNEL signup (the offer is
//     cleared after redeem), NOT an ordinary returning login — same gate the
//     name heal uses, so it does not re-fire on every visit.
//   - The WHERE only matches the incomplete legacy shapes (absent / [] /
//     bank-only seed; see needsCoreServicesHeal). A richer scope a firm set is
//     never clobbered.
//   - Once written it equals CORE_SELF_SERVE_SERVICES, so a later call matches
//     nothing and is a no-op.
// Writes ONLY profile.services_engaged (jsonb). Returns true iff a row changed.
export const applyOwnerCoreServices = async ({ firmId = DEFAULT_FIRM_ID, clientId, companyName } = {}) => {
  if (!clientId || !String(companyName || '').trim()) return false;
  const result = await queryFirmDb(
    `update clients
        set profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{services_engaged}', $3::jsonb, true),
            updated_at = now()
      where id = $1
        and firm_id = $2
        and (
          profile->'services_engaged' is null
          or profile->'services_engaged' = '[]'::jsonb
          or profile->'services_engaged' = '["bank_reconciliation"]'::jsonb
        )
      returning id`,
    [clientId, firmId, JSON.stringify(CORE_SELF_SERVE_SERVICES)]
  );
  return result.rowCount > 0;
};

// Heal a returning self-serve owner's accounting_system to the explicit 'none'.
// Third sibling of the name/services heals, closing critical-path §5b(a): only
// the literal 'none' takes the Donna-ledger branch on the posting path
// (firmDb.js ~11179), so a self-serve workspace born with the key ABSENT falls
// through to the Xero builder, whose mirror is empty — every post fails and the
// portal reports all zeros. A self-serve owner has no connector at signup;
// 'none' (books live in the Donna ledger) is the honest default, and the
// noneAdapter/buildDonnaLedgerWriteback machinery behind it is first-class.
//
// Scoped + safe + convergent, same three ways as the services heal: gated on a
// FUNNEL signup (non-empty companyName), the WHERE only matches an absent/empty
// value — a deliberate choice (xero/qbo/procountor, or an operator's explicit
// 'none') is never clobbered — and once written it matches nothing. No
// provenance stamp on purpose: set_by/set_at mark a deliberate operator/owner
// CHOICE (stampProfileProvenance), and a seeded default is not one.
export const applyOwnerDefaultAccountingSystem = async ({ firmId = DEFAULT_FIRM_ID, clientId, companyName } = {}) => {
  if (!clientId || !String(companyName || '').trim()) return false;
  const result = await queryFirmDb(
    `update clients
        set profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{accounting_system}', '"none"'::jsonb, true),
            updated_at = now()
      where id = $1
        and firm_id = $2
        and coalesce(profile->>'accounting_system', '') = ''
      returning id`,
    [clientId, firmId]
  );
  return result.rowCount > 0;
};

// Create (or return the existing) workspace for an authenticated owner.
// Returns { clientId, created }. Throws 401 if the auth carries no email or
// stable user id (e.g. the shared access token / cron secret — not a person to
// provision or attribute).
// `deps` is injectable for unit tests; production omits it and uses the real
// DB-backed helpers.
export const selfProvisionClientWorkspace = async ({
  // Not caller-controlled. A supplied value is VALIDATED against the
  // deployment's configured firm and refused if it differs — it is never
  // used to choose a firm. See ProvisionFirmScopeError.
  firmId = null,
  auth,
  companyName = null,
  bandId = null,
  jurisdiction = null,
  entityType = null,
  incorporationDate = null,
  ownerRevalidation = null,
  deps = {}
} = {}) => {
  const {
    scopeCheck = assertFirmScopeAllowed,
    resolveDefaultFirmId = resolveConfiguredDefaultFirmId,
    findOwned = findOwnedClientId,
    createClient = createClientInDb,
    assertBindable = assertOwnerPrincipalBindable,
    bindOwner = bindOwnerPrincipal,
    applyName = applyOwnerCompanyName,
    applyCoreServices = applyOwnerCoreServices,
    applyDefaultAccountingSystem = applyOwnerDefaultAccountingSystem,
    seedGbChart = seedGbDefaultChartIfEmpty
  } = deps;

  // Resolve the target firm from CONFIGURATION, then refuse a request that
  // named a different one. Order matters: scopeCheck now runs on the resolved
  // target, so naming an arbitrary firm id can no longer route around the
  // production demo-firm guard.
  const configuredFirmId = resolveDefaultFirmId();
  const requestedFirmId = firmId == null ? null : String(firmId).trim();
  if (requestedFirmId && requestedFirmId !== configuredFirmId) {
    throw new ProvisionFirmScopeError(requestedFirmId);
  }
  const targetFirmId = configuredFirmId;

  const normalizedJurisdiction = assertProvisionJurisdictionSupported(normalizeProvisionJurisdiction(jurisdiction));
  const normalizedEntityType = normalizeProvisionEntityType({ jurisdiction: normalizedJurisdiction, entityType });
  const normalizedIncorporationDate = normalizeProvisionIncorporationDate(incorporationDate);

  scopeCheck(targetFirmId);
  const { email, userId } = resolveProvisionIdentity(auth);
  if (!email || !userId) {
    const error = new Error('A signed-in account is required to set up a workspace.');
    error.statusCode = 401;
    error.code = 'PROVISION_AUTH_REQUIRED';
    throw error;
  }

  if (ownerRevalidation !== null) {
    if (auth?.type !== 'supabase_user') {
      throw Object.assign(new Error('A verified signed-in owner is required.'), { code: 'PROVISION_AUTH_REQUIRED', statusCode: 401 });
    }
    const operation = ['recovery_review', 'recovery_request', 'recovery_cancel'].includes(ownerRevalidation?.action)
      ? requestDeletedOwnerRecovery : revalidateExistingOwnerForPilot;
    return operation({ firmId: targetFirmId,
      clientId: idFor('client-self', targetFirmId, email), userId, email, request: ownerRevalidation });
  }

  const existing = await findOwned({ firmId: targetFirmId, email });
  if (existing) {
    // Returning navigation must still belong to this active owner principal.
    // Reuse the birth guard; never adopt a foreign or suspended identity.
    await assertBindable({ firmId: targetFirmId, email, userId });
    // Idempotent path: provisioning returns the existing workspace WITHOUT
    // re-running the createClientInDb upsert (which would clobber firm-side
    // profile edits like services_engaged / jurisdiction). Two surgical heals
    // instead, each scoped to a funnel signup and convergent:
    //   - the owner's business name from THIS signup is authoritative
    //     (applyOwnerCompanyName), and
    //   - their services_engaged is healed up to the core intake IF it is still
    //     an incomplete legacy shape (applyOwnerCoreServices) — this is what was
    //     missing: a workspace seeded by the pre-#679 self-serve path stayed
    //     bank-only because the create-path fix never reached the existing path.
    await applyName({ firmId: targetFirmId, clientId: existing, companyName });
    await applyCoreServices({ firmId: targetFirmId, clientId: existing, companyName });
    await applyDefaultAccountingSystem({ firmId: targetFirmId, clientId: existing, companyName });
    return { clientId: existing, created: false };
  }

  // Refuse a conflicting principal BEFORE the client row is committed.
  // bindOwner re-checks under a row lock (that is the enforcement); this is
  // ordering, so a refusal never leaves an orphan client behind (F-35).
  await assertBindable({ firmId: targetFirmId, email, userId });

  const clientId = idFor('client-self', targetFirmId, email);
  const displayName = String(companyName || '').trim() || email.split('@')[0] || 'My business';
  // The owner PERSON's name is not the company's: it is the name the identity
  // provider holds for them (auth.name), or nothing. Readers fall back to the
  // email address for a principal with no name.
  const ownerName = String(auth?.name || '').trim() || null;

  // Client row first (createClientInDb runs its own transaction). The
  // deterministic id makes this a safe upsert on retry. profile.email is what
  // the billing context (clientSubscriptionDb mapRow) reads to pre-fill Checkout.
  //
  // services_engaged: a self-serve owner has already CHOSEN their product at
  // checkout — there is no firm "let's scope it together" conversation. Seed the
  // CORE bookkeeping intake (CORE_SELF_SERVE_SERVICES) so the portal renders the
  // real "what I need from you" checklist on first visit instead of the
  // firm-model "not scoped yet" placeholder. The returning-owner path heals the
  // same set; see applyOwnerCoreServices.
  await createClient({
    firmId: targetFirmId,
    creationPrincipal: {
      principalType: 'supabase_user',
      principalId: userId,
      authoritySource: 'authenticated_self_provision_route'
    },
    profile: {
      id: clientId,
      companyName: displayName,
      email,
      jurisdiction: normalizedJurisdiction,
      entityType: normalizedEntityType,
      incorporationDate: normalizedIncorporationDate,
      billing_band_id: bandId || null,
      services_engaged: [...CORE_SELF_SERVE_SERVICES],
      // §5b(a): explicit 'none' — books live in the Donna ledger. Only the
      // literal 'none' takes the Donna branch on the posting path; a client
      // left NULL falls through to the Xero builder and reports all zeros.
      // 'none' is always offered (accountingSystemAvailability short-circuits),
      // and connecting Xero/QBO later is an operator profile write.
      accounting_system: 'none'
    }
  });
  if (normalizedJurisdiction === 'GB') await seedGbChart({ firmId: targetFirmId, clientId, entityType: normalizedEntityType });
  await bindOwner({ firmId: targetFirmId, email, userId, clientId, displayName: ownerName });

  return { clientId, created: true };
};
