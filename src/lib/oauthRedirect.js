// Pure parser for the GoTrue OAuth redirect landing. Supabase's implicit
// flow returns the session in the URL HASH
// (#access_token=…&refresh_token=…&expires_in=…); errors can land in
// either the hash or the query string (?error=…&error_description=…).
//
// Kept free of window / import.meta so it runs under plain `node`: the
// dev container has no prod egress, so a real OAuth round-trip can only
// be tested by Kari on a deploy — this parser is the piece of the
// redirect path we can pin with tests beforehand.

const toParams = (raw, prefix) => {
  const value = String(raw || '');
  return new URLSearchParams(value.startsWith(prefix) ? value.slice(1) : value);
};

export const parseOAuthRedirect = ({ hash = '', search = '' } = {}) => {
  const hashParams = toParams(hash, '#');
  const searchParams = toParams(search, '?');

  const accessToken = hashParams.get('access_token');
  if (accessToken) {
    const expiresIn = Number(hashParams.get('expires_in'));
    return {
      type: 'session',
      // GoTrue stamps the link kind in the hash. A password-recovery link lands
      // as a session with type=recovery — the app must force a new password
      // rather than silently treating it as a normal sign-in.
      recovery: hashParams.get('type') === 'recovery',
      session: {
        access_token: accessToken,
        refresh_token: hashParams.get('refresh_token') || '',
        expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
        user: null
      }
    };
  }

  const message =
    hashParams.get('error_description') ||
    searchParams.get('error_description') ||
    hashParams.get('error') ||
    searchParams.get('error');
  if (message) {
    // error_code (e.g. otp_expired, access_denied) lets the UI offer the right
    // recovery — "this link expired, request a fresh one" — instead of a raw
    // GoTrue string on a dead page.
    const code = hashParams.get('error_code') || searchParams.get('error_code') || null;
    return { type: 'error', message, code };
  }

  return null;
};

// Remove GoTrue's error params from a query string while preserving any
// app params (?entity=…&tab=…) so the post-redirect URL cleanup doesn't
// clobber routing state.
export const stripOAuthParamsFromSearch = (search = '') => {
  const params = toParams(search, '?');
  ['error', 'error_code', 'error_description'].forEach((key) => params.delete(key));
  const next = params.toString();
  return next ? `?${next}` : '';
};
