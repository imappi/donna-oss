// Standing delegated authority for material reconciliation matches — the
// in-product surface (routes). The grant store (reconciliationAuthorityGrants.js,
// migration 040), its lookup (findActiveAuthorityGrant) and its accept seam
// (applyDelegatedAuthority) already exist; this module adds only the HUMAN
// surface over them: a firm authority previews, mints, lists, approves,
// re-activates, suspends and revokes a client's grants.
//
// Authority law (each fails CLOSED — a doubt refuses, nothing is force-granted):
//   - WHO. A grant is minted, approved or re-activated only by a NAMED,
//     firm-side authority, mapped onto the store's RUNTIME_MINT_ACTOR_TYPES:
//       firm member (access_level owner / role owner|admin)  → 'admin'
//       firm member (any other)                             → 'firm_operator'
//       internal staff seat at PARTNER (seat or per-entity) → 'accountant'
//     The capability half is the one verb → class table (seatActionClasses:
//     the four *_reconciliation_authority verbs are policy_change → partner)
//     resolved through operatorCapability.resolveCapabilityClass, ENFORCED
//     unconditionally here (no OPERATOR_CAPABILITY_ENFORCE staging and no
//     fail-open on a read error: these routes change who governs autonomy).
//     Refused: the client-side owner / portal principal (an owner supplies
//     evidence, an owner does not govern autonomy), legacy non-seat
//     collaborators (reviewer class), junior/senior seats, external seats
//     (engagement-bounded outsiders), a bare access token that names no
//     person, and the system itself (no route ever mints with actor 'system').
//   - WHERE. assertFirmAccess confines the caller to the client; every grant
//     read and write is keyed (firm_id, client_id, id), so a grant id from
//     another client is simply not found.
//   - WHAT. The scope is DERIVED from the held example match by the same pure
//     classifier the accept path uses (classifyReconciliationArchetype) — the
//     request body never supplies scope, archetype or action. accept_and_post
//     is refused; only accept_match is grantable.
//   - WHETHER IT ACTS. The existing delegated-authority flag
//     (RECONCILIATION_DELEGATED_AUTHORITY via clientFlagActs, the same
//     predicate the lookup reads) still decides whether grants act. While it is
//     off for the client, mint / approve / re-activate are refused (they would
//     be inert) and the list says so; suspend / revoke stay available.
//   - RECEIPT. Every write runs in one transaction with its audit row naming
//     the acting principal; a failed receipt rolls the change back.
//
// Confirming a single held match stays the line-level PATCH
// /reconciliation-matches/:id (updateReconciliationMatchInDb), which stamps a
// one-time authority_receipt on that match and never mints a grant.

import {
  assertFirmAccess,
  getAssignmentRoleForPrincipal,
  isFirmDatabaseConfigured,
  resolveDesktopClientCreationPrincipal,
  withFirmDbClient
} from './firmDb.js';
import { clientFlagActs, readClientConfigSnapshot } from './clientConfig.js';
import {
  DELEGATED_AUTHORITY_FLAG_KEY,
  FEW_SHOT_LIMIT,
  delegatedAuthorityCanaryAllows,
  delegationGateProof,
  normalizeCurrency
} from './reconciliationLlmCore.js';
import { classifyReconciliationArchetype } from './reconciliationArchetype.js';
import {
  RUNTIME_MINT_ACTOR_TYPES,
  buildAuthorityGrantId,
  grantRowAllowsAutoAccept,
  listAuthorityGrantsForClient,
  mintAuthorityGrant,
  transitionAuthorityGrant
} from './reconciliationAuthorityGrants.js';
import { authorizeActionType, resolveCapabilityClass } from './operatorCapability.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';

export const RECONCILIATION_AUTHORITY_ROUTES = Object.freeze({
  list: '/reconciliation-authority-grants',
  preview: '/reconciliation-authority-grants/preview',
  mint: '/reconciliation-authority-grants/mint',
  approve: '/reconciliation-authority-grants/approve',
  suspend: '/reconciliation-authority-grants/suspend',
  revoke: '/reconciliation-authority-grants/revoke'
});

export const RECONCILIATION_AUTHORITY_VERBS = Object.freeze({
  mint: 'grant_reconciliation_authority',
  approve: 'approve_reconciliation_authority',
  suspend: 'suspend_reconciliation_authority',
  revoke: 'revoke_reconciliation_authority'
});

// The longest a person may grant before Donna asks them to look again.
export const MAX_GRANT_REVIEW_DAYS = 366;
const DAY_MS = 86_400_000;

const refusal = (message, statusCode, code, extra = {}) =>
  Object.assign(new Error(message), { statusCode, code, ...extra });

const actorIdFor = (principal) =>
  principal?.email || principal?.userId || principal?.principalId || null;

const SEAT_LADDER = new Set(['junior', 'senior', 'partner']);

// THE decision — pure. Given the resolved principal (desktop token already
// resolved to its named member) and its per-client capability assignment role,
// may it take a governance action, and as which store actor type?
//   { allowed: true, actorType, actorId, capability }
//   { allowed: false, code, message, capability? }
// `actionType` null = a read (list / preview): any firm-side principal.
export const decideGrantAuthority = ({ principal = null, assignmentRole = null, actionType = null } = {}) => {
  if (!principal) return { allowed: false, code: 'NO_PRINCIPAL', message: 'Sign in to manage authority.' };
  const actorId = actorIdFor(principal);
  const type = principal.principalType;
  if (type === 'access_token') {
    return { allowed: false, code: 'UNNAMED_PRINCIPAL', message: 'Authority is granted by a named person; this token names no one.' };
  }
  if (type === 'firm_member') {
    if (!actorId) return { allowed: false, code: 'UNNAMED_PRINCIPAL', message: 'Authority is granted by a named person.' };
    const admin = principal.accessLevel === 'owner' || ['owner', 'admin'].includes(String(principal.role || '').toLowerCase());
    const capability = actionType ? authorizeActionType({ actionType, capabilityClass: 'founder' }) : null;
    return { allowed: true, actorType: admin ? 'admin' : 'firm_operator', actorId, capability };
  }
  if (type !== 'firm_collaborator') {
    return { allowed: false, code: 'NOT_FIRM_SIDE', message: 'Only the firm can manage standing authority.' };
  }
  if (!principal.seatRole) {
    // The self-serve owner / portal principal shape: evidence, never autonomy.
    if (String(principal.role || '').toLowerCase() === 'owner') {
      return { allowed: false, code: 'CLIENT_SIDE_PRINCIPAL', message: 'A business owner supplies evidence; standing authority is the firm’s decision.' };
    }
  } else if (principal.affiliation === 'external') {
    return { allowed: false, code: 'EXTERNAL_SEAT', message: 'External seats cannot grant or change a client’s standing authority.' };
  }
  if (!actorId) return { allowed: false, code: 'UNNAMED_PRINCIPAL', message: 'Authority is granted by a named person.' };
  // Reads: any remaining firm-side collaborator (staff seat or a legacy
  // firm-surface collaborator) may see the client's grants.
  if (!actionType) return { allowed: true, actorType: null, actorId, capability: null };
  // Writes: legacy non-seat collaborators are outside the seat model (their
  // capability is staged, and an 'owner' assignment row would read as founder),
  // so they never govern authority — fail closed.
  if (!principal.seatRole) {
    return { allowed: false, code: 'NOT_A_SEAT', message: 'Only a firm member or a partner seat can change standing authority.' };
  }
  // The per-entity override: an assignment row carrying a seat-ladder role
  // outranks the seat row; any other assignment role is ignored for seats.
  const role = String(assignmentRole || '').toLowerCase();
  const capabilityClass = resolveCapabilityClass({ principal, assignmentRole: SEAT_LADDER.has(role) ? role : null });
  const capability = authorizeActionType({ actionType, capabilityClass });
  if (!capability.allowed) {
    return { allowed: false, code: 'CAPABILITY_REQUIRED', message: `Your seat (${capability.capability_class}) cannot change standing authority — it needs ${capability.required_class}.`, capability };
  }
  return { allowed: true, actorType: 'accountant', actorId, capability };
};

// The parts of a recurring_rent_lease scope key, for display only.
export const describeScopeKey = (scopeKey) => {
  const parts = {};
  for (const piece of String(scopeKey || '').split('|')) {
    const idx = piece.indexOf(':');
    if (idx > 0) parts[piece.slice(0, idx)] = piece.slice(idx + 1);
  }
  return { merchant: parts.merchant || null, document_type: parts.doc || null, account: parts.acct || null };
};

const delegatedAuthorityActs = async (client, { firmId, clientId, env = process.env }) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  return clientFlagActs({
    flagKey: DELEGATED_AUTHORITY_FLAG_KEY,
    snapshot,
    envFallback: () => delegatedAuthorityCanaryAllows(clientId, env),
    env
  });
};

// Read the held example match and derive EXACTLY what a grant from it would
// cover — the same classifier inputs the orchestrators feed the lookup.
export const deriveGrantPreview = async (client, { firmId, clientId, matchId }) => {
  const matchResult = await client.query(
    `select id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount, payload
       from reconciliation_matches where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, matchId]
  );
  const match = matchResult.rows[0];
  if (!match) throw refusal('Match not found.', 404, 'MATCH_NOT_FOUND');
  const authorization = match.payload?.authorization || null;
  const held = match.status === 'suggested' && delegationGateProof(authorization);
  const bankLine = (await client.query(
    `select id, money_in, money_out, currency, transaction_date, description, raw_description,
            payload->>'contact' as contact, account_code, category
       from transactions where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, match.bank_transaction_id]
  )).rows[0] || null;
  const document = (await client.query(
    `select id, document_type, vendor_name, reference_number, filename, parse_summary, total_amount, currency, document_date
       from documents where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, match.matched_object_id]
  )).rows[0] || null;
  // The orchestrators' few-shot roster (latest settled matches of this family)
  // is the classifier's recurring-vendor evidence; read it the same way.
  const recent = (await client.query(
    `select d.vendor_name
       from reconciliation_matches m
       join documents d on d.id = m.matched_object_id
      where m.firm_id = $1 and m.client_id = $2 and m.matched_object_type = $3
        and m.status in ('confirmed', 'auto_matched') and m.id <> $4
      order by m.created_at desc
      limit $5`,
    [firmId, clientId, match.matched_object_type, match.id, FEW_SHOT_LIMIT]
  )).rows;
  const classification = classifyReconciliationArchetype({
    proposal: null,
    bankLine,
    document,
    firmContext: { recentConfirmedMatches: recent }
  });
  const amount = Number(match.match_amount ?? bankLine?.money_out ?? 0);
  const currency = normalizeCurrency(bankLine?.currency || document?.currency);
  const archetype = classification.archetype;
  const scopeKey = classification.scopeKey;
  const scopeKind = classification.scopeKind;
  let existing = null;
  if (archetype && scopeKey) {
    const id = buildAuthorityGrantId({ firmId, clientId, scopeKind, scopeKey, action: 'accept_match' });
    existing = (await client.query(
      `select id, status from reconciliation_authority_grants where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, id]
    )).rows[0] || null;
  }
  const flagActs = await delegatedAuthorityActs(client, { firmId, clientId });
  const ineligibleReason = !held
    ? 'not_held_for_authority'
    : !archetype
      ? 'not_pre_authorisable'
      : existing
        ? 'grant_exists'
        : !flagActs
          ? 'delegated_authority_off'
          : null;
  return {
    match_id: match.id,
    held_for_authority: held,
    eligible: ineligibleReason == null,
    ineligible_reason: ineligibleReason,
    delegated_authority_acts: flagActs,
    archetype,
    scope_kind: scopeKind,
    scope_key: scopeKey,
    scope: describeScopeKey(scopeKey),
    action: 'accept_match',
    amount,
    currency,
    model: authorization?.model || null,
    existing_grant: existing,
    example: {
      match_id: match.id,
      bank_transaction_id: match.bank_transaction_id,
      document_id: match.matched_object_id,
      document_type: document?.document_type || null,
      vendor_name: document?.vendor_name || null,
      amount,
      currency,
      date: bankLine?.transaction_date || null,
      description: bankLine?.description || null
    }
  };
};

// Is each held match covered RIGHT NOW by a standing grant that would act on
// it? The convergence gather's covering-grant input (reconcileConvergenceState
// readCoveredHeldMatchIds): a held match with a covering grant keeps the
// line's other axes; without one the line hangs. READ-ONLY by construction —
// it derives the scope exactly as the preview above does (the accept path's
// classifier over the same bank line, document and few-shot roster), then
// applies the accept path's own gates: the delegated-authority flag, the
// readiness admission (evaluated without its blocked receipt and without a row
// lock, since a projection must never write or wait), and the per-row grant
// guard grantRowAllowsAutoAccept at the match amount and currency. Every doubt
// (a vanished match, no archetype, a pre-040 database) reads NOT covered, which
// fails toward hanging. Returns the Set of covered match ids.
export const readHeldMatchGrantCoverage = async (client, { firmId, held = [], asOf = new Date(), env = process.env } = {}) => {
  const covered = new Set();
  for (const { clientId, matchId } of Array.isArray(held) ? held : []) {
    if (!clientId || !matchId) continue;
    let preview;
    try {
      preview = await deriveGrantPreview(client, { firmId, clientId, matchId });
    } catch (error) {
      if (error?.code === 'MATCH_NOT_FOUND' || error?.code === '42P01' || error?.code === '42703') continue;
      throw error;
    }
    if (!preview.held_for_authority || !preview.delegated_authority_acts) continue;
    if (!preview.archetype || !preview.scope_key) continue;
    const readiness = await evaluateEntityReadinessAdmissionWithClient({
      client, firmId, clientId, boundary: 'reconciliation_authority', lock: false, env
    });
    if (!readiness.allowed) continue;
    // The same candidate rows findActiveAuthorityGrant scans, the same guard.
    const grants = (await client.query(
      `select * from reconciliation_authority_grants
        where firm_id = $1 and client_id = $2 and archetype = $3 and scope_key = $4`,
      [firmId, clientId, preview.archetype, preview.scope_key]
    )).rows || [];
    if (grants.some((grant) => grantRowAllowsAutoAccept(grant, { matchAmount: preview.amount, currency: preview.currency, asOf }))) {
      covered.add(matchId);
    }
  }
  return covered;
};

const parseFutureDate = (value, label, { asOf }) => {
  if (value == null || value === '') return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw refusal(`${label} is not a date.`, 400, 'GRANT_DATE_INVALID');
  if (ms <= asOf.getTime()) throw refusal(`${label} must be in the future.`, 400, 'GRANT_TIME_BOUND_PAST');
  if (ms > asOf.getTime() + MAX_GRANT_REVIEW_DAYS * DAY_MS) {
    throw refusal(`${label} may be at most ${MAX_GRANT_REVIEW_DAYS} days ahead.`, 400, 'GRANT_TIME_BOUND_TOO_FAR');
  }
  return new Date(ms).toISOString();
};

const timeBound = (body, { asOf }) => {
  const reviewAfter = parseFutureDate(body?.review_after, 'The review date', { asOf });
  const expiresAt = parseFutureDate(body?.expires_at, 'The expiry date', { asOf });
  if (!reviewAfter && !expiresAt) throw refusal('Set a review-after or expiry date.', 400, 'GRANT_TIME_BOUND_REQUIRED');
  return { reviewAfter, expiresAt };
};

// Who is acting, re-resolved on the transaction's own connection.
const resolveActing = async (client, { firmId, clientId, access, actionType }) => {
  let principal = access.principal;
  if (principal?.principalType === 'access_token') {
    // On the desktop host the appliance token stands for exactly one named
    // owner member (the client-create precedent); elsewhere it names no one.
    try {
      principal = await resolveDesktopClientCreationPrincipal({ firmId, principal });
    } catch {
      principal = access.principal;
    }
  }
  const assignmentRole = principal?.principalType === 'firm_collaborator'
    ? await getAssignmentRoleForPrincipal({ firmId, clientId, principal, dbClient: client })
    : null;
  return { principal, decision: decideGrantAuthority({ principal, assignmentRole, actionType }) };
};

const principalReceipt = (principal) => ({
  principal_type: principal?.principalType || null,
  principal_id: principal?.principalId || null,
  email: principal?.email || null,
  seat_role: principal?.seatRole || null
});

// A refused governance write is receipted too (who tried, what, why) — the
// refusal itself is the safe state, so it commits on its own.
const receiptRefusal = async (client, { firmId, clientId, principal, verb, decision, grantId = null, matchId = null }) => {
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, 'reconciliation_authority_grant.refused', 'reconciliation_authority_grant', $5, $6::jsonb)`,
    [firmId, clientId, principal?.seatRole ? 'seat' : (principal?.principalType || 'unknown'), actorIdFor(principal) || 'unknown',
      grantId || matchId || clientId,
      JSON.stringify({ verb, code: decision.code, required_class: decision.capability?.required_class || null,
        capability_class: decision.capability?.capability_class || null, match_id: matchId, ...principalReceipt(principal) })]
  );
};

const listPayload = async (client, { firmId, clientId }) => ({
  client_id: clientId,
  delegated_authority_acts: await delegatedAuthorityActs(client, { firmId, clientId }),
  grants: await listAuthorityGrantsForClient({ client, firmId, clientId })
});

const send = (res, statusCode, body) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

// One transaction: resolve + authorize the actor, run `work`, commit. A
// refusal commits only its own receipt.
const governedWrite = async ({ firmId, clientId, access, verb, run, grantId = null, matchId = null }) =>
  withFirmDbClient(async (client) => {
    let committed = null;
    await client.query('begin');
    try {
      const { principal, decision } = await resolveActing(client, { firmId, clientId, access, actionType: verb });
      if (!decision.allowed || (decision.actorType && !RUNTIME_MINT_ACTOR_TYPES.includes(decision.actorType))) {
        await receiptRefusal(client, { firmId, clientId, principal, verb, decision, grantId, matchId });
        await client.query('commit');
        throw refusal(decision.message || 'Not allowed.', 403, decision.code || 'GRANT_AUTHORITY_REQUIRED');
      }
      const out = await run(client, { principal, decision });
      await client.query('commit');
      committed = out;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
    // The write is committed; a failed refresh read must not report it as failed.
    const fresh = await listPayload(client, { firmId, clientId }).catch(() => null);
    return { ...committed, ...(fresh || { grants: null }) };
  });

const mint = async ({ firmId, clientId, access, body }) => {
  const matchId = String(body?.match_id || '');
  if (!matchId) throw refusal('match_id is required.', 400, 'MATCH_REQUIRED');
  if (body?.action != null && body.action !== 'accept_match') {
    throw refusal('Only accepting matches can be delegated; posting authority is not available.', 400, 'GRANT_ACTION_UNSUPPORTED');
  }
  if (body?.acknowledged !== true) {
    throw refusal('Tick the confirmation to grant standing authority.', 400, 'GRANT_NOT_ACKNOWLEDGED');
  }
  const asOf = new Date();
  const { reviewAfter, expiresAt } = timeBound(body, { asOf });
  return governedWrite({
    firmId, clientId, access, verb: RECONCILIATION_AUTHORITY_VERBS.mint, matchId,
    run: async (client, { principal, decision }) => {
      const preview = await deriveGrantPreview(client, { firmId, clientId, matchId });
      if (!preview.eligible) {
        throw refusal('This match cannot be pre-authorised.', 409,
          preview.ineligible_reason === 'delegated_authority_off' ? 'DELEGATED_AUTHORITY_OFF' : 'GRANT_NOT_ELIGIBLE',
          { reason: preview.ineligible_reason, existing_grant: preview.existing_grant });
      }
      const ceiling = Number(body?.amount_ceiling);
      if (!Number.isFinite(ceiling) || ceiling <= 0) throw refusal('Set an amount ceiling above zero.', 400, 'GRANT_CEILING_REQUIRED');
      if (ceiling < preview.amount) throw refusal('The ceiling must cover this example match.', 400, 'GRANT_CEILING_BELOW_EXAMPLE');
      if (normalizeCurrency(body?.currency) !== preview.currency) {
        throw refusal(`The grant must be in ${preview.currency}, the currency of this match.`, 400, 'GRANT_CURRENCY_MISMATCH');
      }
      const reason = String(body?.reason || '').trim() || null;
      const minted = await mintAuthorityGrant({
        client, firmId, clientId,
        scopeKind: preview.scope_kind,
        scopeKey: preview.scope_key,
        archetype: preview.archetype,
        action: 'accept_match',
        amountCeiling: ceiling,
        currency: preview.currency,
        authorizedByActorType: decision.actorType,
        authorizedByActorId: decision.actorId,
        source: decision.actorType === 'accountant' ? 'accountant_approval' : 'operator_one_click',
        provenance: {
          flow: 'authorise_future_matches_like_this',
          granted_by: principalReceipt(principal),
          example: preview.example,
          reason
        },
        status: 'active',
        reviewAfter,
        expiresAt,
        model: preview.model
      });
      // The store refuses (null) on any guard; a genuine insert is the only
      // success here — an upsert onto an existing row would skip its receipt.
      if (!minted || !minted.inserted) throw refusal('The grant could not be recorded.', 409, 'GRANT_MINT_REFUSED');
      return { minted };
    }
  });
};

const transition = async ({ firmId, clientId, access, body, route }) => {
  const grantId = String(body?.grant_id || '');
  if (!grantId) throw refusal('grant_id is required.', 400, 'GRANT_REQUIRED');
  const asOf = new Date();
  const activating = route === 'approve';
  const bound = activating ? timeBound(body, { asOf }) : { reviewAfter: null, expiresAt: null };
  return governedWrite({
    firmId, clientId, access, verb: RECONCILIATION_AUTHORITY_VERBS[route], grantId,
    run: async (client, { principal, decision }) => {
      let name = route;
      if (activating) {
        const current = (await client.query(
          `select status from reconciliation_authority_grants where firm_id = $1 and client_id = $2 and id = $3 for update`,
          [firmId, clientId, grantId]
        )).rows[0];
        if (!current) throw refusal('Grant not found.', 404, 'GRANT_NOT_FOUND');
        name = current.status === 'proposed' ? 'approve' : 'reactivate';
        if (!(await delegatedAuthorityActs(client, { firmId, clientId }))) {
          throw refusal('Delegated authority is off for this client; an approved grant would not act.', 409, 'DELEGATED_AUTHORITY_OFF');
        }
      }
      const result = await transitionAuthorityGrant({
        client, firmId, clientId, grantId,
        transition: name,
        actorType: decision.actorType,
        actorId: decision.actorId,
        reason: body?.reason,
        reviewAfter: bound.reviewAfter,
        expiresAt: bound.expiresAt,
        receipt: principalReceipt(principal),
        asOf
      });
      return { transition: name, result };
    }
  });
};

// Route entry. Returns true when it handled the request.
export const handleReconciliationAuthorityRequest = async ({ req, res, requestUrl, readBody, defaultFirmId }) => {
  const path = requestUrl.pathname;
  const isGet = req.method === 'GET';
  const isPost = req.method === 'POST';
  const writeRoute = (isPost && (
    (path === '/reconciliation-authority-grants/mint' && 'mint')
    || (path === '/reconciliation-authority-grants/approve' && 'approve')
    || (path === '/reconciliation-authority-grants/suspend' && 'suspend')
    || (path === '/reconciliation-authority-grants/revoke' && 'revoke'))) || null;
  const readRoute = (isGet && (
    (path === '/reconciliation-authority-grants' && 'list')
    || (path === '/reconciliation-authority-grants/preview' && 'preview'))) || null;
  if (!writeRoute && !readRoute) return false;
  if (!isFirmDatabaseConfigured()) {
    send(res, 503, { error: 'Firm database is not configured.' });
    return true;
  }
  const body = writeRoute ? await readBody() : null;
  const firmId = (writeRoute ? body?.firm_id : requestUrl.searchParams.get('firm_id')) || defaultFirmId;
  const clientId = String((writeRoute ? body?.client_id : requestUrl.searchParams.get('client_id')) || '');
  if (!clientId) {
    send(res, 400, { error: 'client_id is required.' });
    return true;
  }
  try {
    const access = await assertFirmAccess({ firmId, auth: req.donnaAuth, clientIds: [clientId] });
    let out;
    if (readRoute) {
      out = await withFirmDbClient(async (client) => {
        const { decision } = await resolveActing(client, { firmId, clientId, access, actionType: null });
        if (!decision.allowed) throw refusal(decision.message, 403, decision.code);
        if (readRoute === 'preview') {
          const matchId = String(requestUrl.searchParams.get('match_id') || '');
          if (!matchId) throw refusal('match_id is required.', 400, 'MATCH_REQUIRED');
          return { preview: await deriveGrantPreview(client, { firmId, clientId, matchId }) };
        }
        return listPayload(client, { firmId, clientId });
      });
    } else if (writeRoute === 'mint') {
      out = await mint({ firmId, clientId, access, body });
    } else {
      out = await transition({ firmId, clientId, access, body, route: writeRoute });
    }
    send(res, writeRoute === 'mint' ? 201 : 200, out);
  } catch (error) {
    send(res, error?.statusCode || 500, {
      error: error?.message || 'Unknown error',
      code: error?.code || null,
      ...(error?.reason ? { reason: error.reason } : {}),
      ...(error?.existing_grant ? { existing_grant: error.existing_grant } : {})
    });
  }
  return true;
};
