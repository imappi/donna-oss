import { clearOwnerClientId } from './ownerPersona.js';

const ACCESS_TOKEN_KEY = 'donna.access_token.v1';
const AUTH_SESSION_KEY = 'donna.auth_session.v1';
let sessionRevision = 0;
let sessionEpoch = 0;
export const getAuthSessionEpoch = () => sessionEpoch;

// Bind async auth work to both this tab's lifecycle and cross-tab storage.
export const getAuthSessionRevision = () => {
  const session = getAuthSession();
  return JSON.stringify([sessionRevision, session?.access_token || '', session?.refresh_token || '']);
};

export const getAccessToken = () => {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(ACCESS_TOKEN_KEY) || '';
};

export const saveAccessToken = (token) => {
  if (typeof window === 'undefined') return;
  const normalized = String(token || '').trim();
  if (normalized) {
    clearAuthSession();
    window.localStorage.setItem(ACCESS_TOKEN_KEY, normalized);
  } else {
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  }
};

export const clearAccessToken = () => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
};

export const getAuthSession = () => {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTH_SESSION_KEY) || 'null');
    return parsed?.access_token ? parsed : null;
  } catch {
    return null;
  }
};

export const saveAuthSession = (session, { refresh = false } = {}) => {
  if (typeof window === 'undefined') return;
  const previous = getAuthSession();
  if (previous?.access_token !== session?.access_token || previous?.refresh_token !== session?.refresh_token) {
    sessionRevision += 1;
    if (!refresh) sessionEpoch += 1;
  }
  if (session?.access_token) {
    clearAccessToken();
    window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  } else {
    window.localStorage.removeItem(AUTH_SESSION_KEY);
  }
};

export const clearAuthSession = () => {
  if (typeof window === 'undefined') return;
  sessionRevision += 1;
  sessionEpoch += 1;
  window.localStorage.removeItem(AUTH_SESSION_KEY);
};

export const clearFirmAccess = () => {
  clearAccessToken();
  clearAuthSession();
  // Drop the owner persona too: a signed-out / dead session must not leave the
  // next user on this device routed into the previous owner's portal.
  clearOwnerClientId();
};

export const getBearerToken = () => getAuthSession()?.access_token || getAccessToken();

// True when there's any stored credential we can attempt to use. Lets
// the app render a loading state on refresh instead of flashing the
// sign-in form while we verify the stored session against the server.
export const hasStoredAuth = () => Boolean(getAuthSession()?.access_token || getAccessToken());

export const withAccessHeaders = (headers = {}) => {
  const donnaToken = getAccessToken();
  const bearerToken = getAuthSession()?.access_token || donnaToken;
  return {
    ...headers,
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(bearerToken ? { 'X-Donna-Access-Token': bearerToken } : {})
  };
};

export const isAccessRequiredError = (error) =>
  error?.code === 'AUTH_REQUIRED' || error?.status === 401;
