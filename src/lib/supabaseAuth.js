import { clearFirmAccess, getAuthSession, getAuthSessionRevision, saveAuthSession } from './accessToken.js';
import { parseOAuthRedirect, stripOAuthParamsFromSearch } from './oauthRedirect.js';

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || '';
const SUPABASE_PUBLISHABLE_KEY = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || '';

export const isSupabaseAuthConfigured = () => Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

const persistSession = (body, options) => {
  saveAuthSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
    user: body.user || null
  }, options);
};

export const signInWithPassword = async ({ email, password }) => {
  if (!isSupabaseAuthConfigured()) {
    throw new Error('Supabase Auth is not configured for this deployment.');
  }

  const revision = getAuthSessionRevision();
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: String(email || '').trim(),
      password
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error_description || body.msg || body.error || 'Sign in failed.');
  }

  if (getAuthSessionRevision() !== revision) throw new Error('Sign-in was superseded. Please try again.');
  persistSession(body);
  return body;
};

// Create a Supabase account. Two response shapes depending on the
// project's email-confirmation toggle (a dashboard-side setting we can't
// read, so both are handled):
//   - confirmations OFF → GoTrue returns a full session; we persist it
//     and the caller can proceed straight to the workspace fetch.
//   - confirmations ON → GoTrue returns the bare user record with no
//     access_token; the account exists but can't sign in until the
//     emailed confirmation link is clicked.
export const signUp = async ({ email, password, redirectPath = '/firms' }) => {
  if (!isSupabaseAuthConfigured()) {
    throw new Error('Supabase Auth is not configured for this deployment.');
  }

  // The email-confirmation link redirects to `redirect_to` (with the session
  // in the URL hash, consumed by consumeOAuthRedirect on landing). Without
  // this, GoTrue falls back to the project's Site URL — which defaults to
  // http://localhost:3000 and produces a dead confirmation link in prod. We
  // target the origin the user actually signed up from + redirectPath (the
  // signup funnel passes '/start' so an OWNER lands on provisioning, not the
  // firm console). NOTE: this URL must still be in Supabase Auth → URL
  // configuration → Redirect URLs allow-list, or GoTrue ignores it and falls
  // back to Site URL.
  const redirectTo =
    typeof window !== 'undefined' ? `${window.location.origin}${redirectPath}` : '';
  const signupUrl = redirectTo
    ? `${SUPABASE_URL}/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`
    : `${SUPABASE_URL}/auth/v1/signup`;

  const revision = getAuthSessionRevision();
  const response = await fetch(signupUrl, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: String(email || '').trim(),
      password
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error_description || body.msg || body.error || 'Sign up failed.');
  }

  if (getAuthSessionRevision() !== revision) throw new Error('Sign-up was superseded. Please try again.');
  if (body.access_token) {
    persistSession(body);
    return { confirmationRequired: false, session: body };
  }
  return { confirmationRequired: true, session: null };
};

// Request a password-reset email. GoTrue always returns 200 here (it won't
// reveal whether an email is registered), so the caller shows "check your
// inbox" regardless. The reset link lands on /reset-password with a recovery
// session in the hash; that route must be in Supabase Auth → Redirect URLs or
// GoTrue falls back to the project's Site URL (the localhost trap).
export const requestPasswordReset = async ({ email }) => {
  if (!isSupabaseAuthConfigured()) {
    throw new Error('Supabase Auth is not configured for this deployment.');
  }
  const redirectTo = typeof window !== 'undefined' ? `${window.location.origin}/reset-password` : '';
  const url = redirectTo
    ? `${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`
    : `${SUPABASE_URL}/auth/v1/recover`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email || '').trim() })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error_description || body.msg || body.error || 'Could not send the reset email.');
  }
  return { ok: true };
};

// Re-send the signup confirmation email (for "I never got it / it expired").
// Same redirect/allow-list caveat as signUp.
export const resendConfirmation = async ({ email, redirectPath = '/firms' }) => {
  if (!isSupabaseAuthConfigured()) {
    throw new Error('Supabase Auth is not configured for this deployment.');
  }
  const redirectTo = typeof window !== 'undefined' ? `${window.location.origin}${redirectPath}` : '';
  const url = redirectTo
    ? `${SUPABASE_URL}/auth/v1/resend?redirect_to=${encodeURIComponent(redirectTo)}`
    : `${SUPABASE_URL}/auth/v1/resend`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'signup', email: String(email || '').trim() })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error_description || body.msg || body.error || 'Could not resend the confirmation email.');
  }
  return { ok: true };
};

// Set a new password using the (recovery) session captured from the reset link.
// Authenticated by the stored access token, so it must run after the recovery
// landing persisted the session. On success GoTrue returns the updated user;
// the caller can then send the visitor into the app.
export const updatePassword = async ({ password }) => {
  if (!isSupabaseAuthConfigured()) {
    throw new Error('Supabase Auth is not configured for this deployment.');
  }
  const session = getAuthSession();
  if (!session?.access_token) {
    throw new Error('Your reset link has expired. Request a new one.');
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ password })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error_description || body.msg || body.error || 'Could not update your password.');
  }
  return body;
};

// Kick off the GoTrue-hosted Google OAuth flow (implicit grant — tokens
// come back in the URL hash, consumed by consumeOAuthRedirect below).
// Lands back exactly where the user started (path + query, no hash) so
// firm vs client-portal routing is preserved. The landing URL must be
// allowed by Supabase Auth → URL configuration (Site URL or additional
// redirect URLs).
export const startGoogleSignIn = (redirectPath) => {
  if (!isSupabaseAuthConfigured()) {
    throw new Error('Supabase Auth is not configured for this deployment.');
  }
  // Default: land back exactly where the user started (firm gate flow). The
  // marketing landing passes an explicit path (e.g. '/firms') so a Google
  // sign-in started from '/welcome' lands the authenticated user in the app
  // instead of bouncing back onto the always-landing page. The target must be
  // allowed by Supabase Auth → URL configuration.
  const redirectTo = redirectPath
    ? `${window.location.origin}${redirectPath}`
    : `${window.location.origin}${window.location.pathname}${window.location.search}`;
  console.info('[auth] Google sign-in: redirecting to GoTrue authorize, will land on', redirectTo);
  window.location.assign(
    `${SUPABASE_URL}/auth/v1/authorize?provider=google&prompt=select_account&redirect_to=${encodeURIComponent(redirectTo)}`
  );
};

// Consume a GoTrue OAuth redirect landing, once per page load. Must run
// BEFORE anything reads stored auth (App's firmAccessStatus initializer
// calls hasStoredAuth synchronously) — which is why this is synchronous:
// the implicit flow needs no network call. Memoized so React StrictMode's
// double initializer invocation sees the same result instead of a second,
// empty parse of the already-stripped URL.
//
// Returns null (no OAuth params present), { session: true } (tokens
// captured and persisted), or { error } (GoTrue bounced the sign-in).
let consumedOAuthRedirect;
export const consumeOAuthRedirect = () => {
  if (consumedOAuthRedirect !== undefined) return consumedOAuthRedirect;
  consumedOAuthRedirect = null;
  if (typeof window === 'undefined') return consumedOAuthRedirect;

  const parsed = parseOAuthRedirect({
    hash: window.location.hash,
    search: window.location.search
  });
  if (!parsed) return consumedOAuthRedirect;

  if (parsed.type === 'session') {
    persistSession(parsed.session);
    console.info(
      '[auth] OAuth redirect: session captured from URL hash; expires_in =',
      parsed.session.expires_in
    );
  } else {
    console.warn('[auth] OAuth redirect returned an error:', parsed.message);
  }

  // Drop the tokens/error from the address bar (and browser history)
  // while preserving app query params like ?entity=…&tab=….
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${stripOAuthParamsFromSearch(window.location.search)}`
  );

  consumedOAuthRedirect =
    parsed.type === 'session'
      ? { session: true, recovery: Boolean(parsed.recovery) }
      : { error: parsed.message, code: parsed.code || null };
  return consumedOAuthRedirect;
};

// Exchange the stored refresh_token for a fresh access_token. Supabase
// access tokens expire (~1h by default), so without this every browser
// refresh past expiry would 401 and kick the user back to the sign-in
// form even though they have a perfectly good long-lived refresh token.
//
// Returns the new session body on success, or null when refresh isn't
// possible (no refresh token, Supabase not configured, refresh
// rejected). On rejection we clear the stored session so the caller
// can drop straight to the gate without retrying.
let inflightRefresh = null;
let inflightRefreshRevision = null;
export const refreshAuthSession = async () => {
  if (!isSupabaseAuthConfigured()) return null;
  const session = getAuthSession();
  if (!session?.refresh_token) return null;

  // De-dupe concurrent callers (snapshot fetch + chat init firing the
  // first 401 at the same time should result in one refresh, not two).
  const revision = getAuthSessionRevision();
  if (inflightRefresh && inflightRefreshRevision === revision) return inflightRefresh;
  inflightRefreshRevision = revision;

  inflightRefresh = (async () => {
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (getAuthSessionRevision() !== revision) return null;
      if (!response.ok) {
        clearFirmAccess();
        return null;
      }
      const body = await response.json().catch(() => null);
      if (getAuthSessionRevision() !== revision) return null;
      if (!body?.access_token) {
        clearFirmAccess();
        return null;
      }
      persistSession(body, { refresh: true });
      return body;
    } catch {
      return null;
    } finally {
      if (inflightRefreshRevision === revision) {
        inflightRefresh = null;
        inflightRefreshRevision = null;
      }
    }
  })();

  return inflightRefresh;
};

// Implicit OAuth supplies tokens but no user. Resolve display identity from
// GoTrue's verified user endpoint; never decode claims as identity authority.
let inflightIdentity = null;
let inflightIdentityRevision = null;
export const hydrateAuthUser = async () => {
  if (!isSupabaseAuthConfigured()) return null;
  const session = getAuthSession();
  if (!session?.access_token || session.user?.email) return session?.user || null;
  const revision = getAuthSessionRevision();
  if (inflightIdentity && inflightIdentityRevision === revision) return inflightIdentity;
  inflightIdentityRevision = revision;
  inflightIdentity = (async () => {
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) return null;
      const user = await response.json();
      if (!user?.id || !user?.email || getAuthSessionRevision() !== revision) return null;
      saveAuthSession({ ...session, user });
      window.dispatchEvent(new window.Event('donna:auth-user'));
      return user;
    } catch {
      return null;
    } finally {
      if (inflightIdentityRevision === revision) {
        inflightIdentity = null;
        inflightIdentityRevision = null;
      }
    }
  })();
  return inflightIdentity;
};

// ── OAuth 2.1 server consent (the hosted chat surface) ─────────────────────
//
// Supabase's OAuth 2.1 server (docs/design-donna-chatgpt-app-build-brief.md
// §8 F3) redirects the owner to /oauth/consent?authorization_id=… and leaves
// the consent decision to the app. These two calls are the GoTrue REST
// endpoints the supabase-js `auth.oauth.getAuthorizationDetails` /
// `approveAuthorization` / `denyAuthorization` helpers wrap (this codebase
// talks to GoTrue over fetch, not supabase-js). Both need the owner's session
// bearer; GoTrue also checks the browser Origin against the project's
// redirect allow-list, which is why the page lives on the app's own origin.

const oauthAuthorizationRequest = async ({ authorizationId, method = 'GET', body = null }) => {
  if (!isSupabaseAuthConfigured()) {
    throw new Error('Supabase Auth is not configured for this deployment.');
  }
  const session = getAuthSession();
  if (!session?.access_token) {
    const err = new Error('Sign in to continue.');
    err.status = 401;
    throw err;
  }
  const id = encodeURIComponent(String(authorizationId || '').trim());
  const suffix = method === 'POST' ? '/consent' : '';
  const response = await fetch(`${SUPABASE_URL}/auth/v1/oauth/authorizations/${id}${suffix}`, {
    method,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(
      payload.error_description || payload.msg || payload.message || payload.error || 'The sign-in server refused the request.'
    );
    err.status = response.status;
    err.code = payload.error_code || payload.code || null;
    throw err;
  }
  return payload;
};

// GET the pending authorization: either { authorization_id, client:{id,name,
// uri,logo_uri}, user:{id,email}, scope, redirect_uri } to render, or
// { redirect_url } when this owner already consented to this client (GoTrue
// auto-approves and the page should just follow the redirect).
export const fetchOAuthAuthorization = ({ authorizationId }) =>
  oauthAuthorizationRequest({ authorizationId });

// POST the owner's decision; GoTrue answers { redirect_url } for both
// 'approve' (carrying the code) and 'deny' (carrying error=access_denied).
export const decideOAuthAuthorization = ({ authorizationId, action }) => {
  if (action !== 'approve' && action !== 'deny') {
    throw new Error(`Unknown consent action '${String(action)}'.`);
  }
  return oauthAuthorizationRequest({ authorizationId, method: 'POST', body: { action } });
};
