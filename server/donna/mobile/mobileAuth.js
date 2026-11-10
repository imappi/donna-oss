// Mobile authentication: the contract's token pair over the identity provider
// this deployment already uses (Supabase Auth, the same password grant the web
// app's src/lib/supabaseAuth.js performs in the browser), and the ONE question
// the mobile surface asks of a verified identity: is this a client-side owner,
// and which books are theirs?
//
// The owner principal (decided here, nowhere else on this surface):
//   - verified by the identity provider (the same /auth/v1/user check every
//     firm route runs — resolveSubmittedDonnaAuth in api.js, injected);
//   - holds NO firm_members row in any firm (a firm member is staff);
//   - resolves, through the existing getFirmPrincipalForAuth, to a
//     firm_collaborator WITHOUT a seat role whose role is 'owner' — the same
//     rule getAuthorizedFirmSnapshotFromDb uses to give a collaborator the
//     owner surface (db/authority.js). A staff seat, or a legacy non-seat
//     staff collaborator (bookkeeper, reviewer…), is refused, not narrowed;
//   - has at least one current client_assignments row
//     (getAllowedClientIdsForPrincipal — the same time-bounded read
//     assertFirmAccess uses). Each assigned client is one contract Entity.
// The shared DONNA_ACCESS_TOKEN is never accepted here: it is the admin token.
import { createHash } from 'node:crypto';

import {
  getAllowedClientIdsForPrincipal,
  getFirmPrincipalForAuth,
  queryFirmDb
} from '../firmDb.js';

export const mobileError = (status, code, message, extra = {}) =>
  Object.assign(new Error(message), { statusCode: status, code, ...extra });

// ── Identity provider (Supabase Auth's GoTrue endpoints) ────────────────────

const providerConfig = (getConfig) => {
  const config = typeof getConfig === 'function' ? getConfig() : null;
  if (!config?.url || !config?.publishableKey) {
    throw mobileError(503, 'IDENTITY_PROVIDER_NOT_CONFIGURED', 'Sign-in is not configured on this server.');
  }
  return config;
};

const gotrue = async (getConfig, path, { body, bearer } = {}) => {
  const config = providerConfig(getConfig);
  let response;
  try {
    response = await fetch(`${config.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: config.publishableKey,
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw mobileError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
  }
  const json = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, json };
};

const tokenPairFrom = (json) => {
  const accessToken = String(json?.access_token || '');
  const refreshToken = String(json?.refresh_token || '');
  if (!accessToken || !refreshToken) throw mobileError(502, 'IDENTITY_PROVIDER_BAD_RESPONSE', 'Sign-in returned no session.');
  const expiresIn = Number.isInteger(json?.expires_in) ? json.expires_in : Number.parseInt(json?.expires_in, 10);
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: Number.isFinite(expiresIn) ? expiresIn : 3600 };
};

export const passwordGrant = async (getConfig, { email, password }) => {
  const result = await gotrue(getConfig, 'token?grant_type=password', { body: { email, password } });
  if (!result.ok) {
    // GoTrue answers 400 invalid_grant for a wrong password AND an unknown
    // email; both are the same 401 here (no account enumeration).
    if (result.status >= 500) throw mobileError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
    if (result.status === 429) throw mobileError(429, 'SIGN_IN_RATE_LIMITED', 'Too many sign-in attempts. Try again later.');
    throw mobileError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  return tokenPairFrom(result.json);
};

export const refreshGrant = async (getConfig, { refreshToken }) => {
  const result = await gotrue(getConfig, 'token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
  if (!result.ok) {
    if (result.status >= 500) throw mobileError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
    throw mobileError(401, 'AUTH_REQUIRED', 'The session has expired. Sign in again.');
  }
  return tokenPairFrom(result.json);
};

// Revokes ONLY the session of the token in hand at the provider. The scope is
// explicit: the provider's logout defaults to every session of the user, which
// would sign an owner out of the web portal when they sign out on the phone,
// and end a staff member's web session when the phone refuses them.
// Best-effort by design on the refusal path (a staff sign-in is refused
// whether or not this lands).
export const revokeSession = async (getConfig, accessToken) => {
  const result = await gotrue(getConfig, 'logout?scope=local', { bearer: accessToken });
  return result.ok || result.status === 401;
};

// ── Sign-in rate limit ──────────────────────────────────────────────────────
// A fixed window per email and per client address. In-process: on a
// multi-instance host each instance counts separately, so this is a floor in
// front of the identity provider's own limit, not a replacement for it.
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
export const SIGN_IN_MAX_PER_EMAIL = 5;
export const SIGN_IN_MAX_PER_ADDRESS = 30;

export const createSignInLimiter = ({ now = () => Date.now() } = {}) => {
  const buckets = new Map();
  const hit = (key, limit) => {
    const at = now();
    const bucket = buckets.get(key);
    if (!bucket || at - bucket.start >= SIGN_IN_WINDOW_MS) {
      buckets.set(key, { start: at, count: 1 });
      return { allowed: true };
    }
    bucket.count += 1;
    return bucket.count <= limit
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: Math.ceil((bucket.start + SIGN_IN_WINDOW_MS - at) / 1000) };
  };
  return {
    check({ email, address }) {
      if (buckets.size > 50_000) buckets.clear();
      const emailKey = `e:${createHash('sha256').update(String(email || '').toLowerCase()).digest('hex')}`;
      const verdicts = [hit(emailKey, SIGN_IN_MAX_PER_EMAIL), hit(`a:${address || 'unknown'}`, SIGN_IN_MAX_PER_ADDRESS)];
      const refused = verdicts.find((verdict) => !verdict.allowed);
      return refused || { allowed: true };
    },
    reset() { buckets.clear(); }
  };
};

// ── The owner principal ─────────────────────────────────────────────────────

const STAFF_REFUSAL = () => mobileError(403, 'MOBILE_OWNER_ONLY',
  'The Donna app is for business owners. Sign in to Donna on the web to use a firm or staff account.');

// Turn a verified identity into the mobile principal, or refuse.
// Returns { identity, owners: [{ firmId, principal, clientIds }] }.
export const resolveMobileOwner = async (auth) => {
  if (auth?.type !== 'supabase_user' || (!auth.userId && !auth.email)) {
    throw mobileError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  }
  const userId = String(auth.userId || '');
  const email = String(auth.email || '').trim().toLowerCase();
  const member = await queryFirmDb(
    `select 1 from firm_members where status = 'active'
       and (($1 <> '' and user_id = $1) or ($2 <> '' and lower(email) = $2)) limit 1`,
    [userId, email]
  );
  if (member.rows.length) throw STAFF_REFUSAL();
  const collaborators = await queryFirmDb(
    `select firm_id, seat_role from firm_collaborators
      where status in ('active', 'invited')
        and (($1 <> '' and user_id = $1) or ($2 <> '' and lower(email) = $2))
      order by firm_id`,
    [userId, email]
  );
  if (collaborators.rows.some((row) => row.seat_role)) throw STAFF_REFUSAL();
  const firmIds = [...new Set(collaborators.rows.map((row) => row.firm_id))];
  const owners = [];
  for (const firmId of firmIds) {
    const principal = await getFirmPrincipalForAuth({ firmId, auth });
    if (!principal) continue; // e.g. an expired assignment window suspended it
    if (principal.principalType !== 'firm_collaborator' || principal.seatRole || principal.role !== 'owner') {
      throw STAFF_REFUSAL();
    }
    const clientIds = await getAllowedClientIdsForPrincipal({ firmId, principal });
    if (Array.isArray(clientIds) && clientIds.length) owners.push({ firmId, principal, clientIds: [...new Set(clientIds)].sort() });
  }
  if (!owners.length) {
    throw mobileError(403, 'NO_BOOKS', 'This account is not linked to any business books yet.');
  }
  return { identity: { userId, email }, owners };
};

// The entity (one Donna client) → its firm, for an already-resolved owner.
// Unknown or foreign entities are 404, never 403: the phone must not learn
// whether another business exists.
export const ownerScopeForEntity = (owner, entityId) => {
  const match = owner.owners.find((entry) => entry.clientIds.includes(entityId));
  if (!match) throw mobileError(404, 'NOT_FOUND', 'No such business in this account.');
  return { firmId: match.firmId, clientId: entityId, principal: match.principal };
};
