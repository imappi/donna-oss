// Owner persona signal — the persisted client-side flag that makes routing
// persona-AWARE instead of persona-blind.
//
// The problem it solves: a self-serve business OWNER is a client, not a firm
// member. But the app's default routing assumed "any stored session = firm
// member" and bounced every authenticated visit on `/` (and any stale `/firms`
// link) into the firm/admin console — stranding owners on a surface that 401s
// them. See docs/session-handoff-2026-06-30-signup-persona-routing-*.md.
//
// The signal is the owner's own workspace id (`client-self-…`, minted by
// selfProvisionClientWorkspace). It is written at the ONLY two places an owner
// is routed into their portal after provisioning — WorkspaceProvisioner's
// `/start` success and App's firm-snapshot-401 → self-provision success. A firm
// MEMBER never provisions (their snapshot doesn't 401), so the signal is only
// ever set for the owner persona; routing keys off it, not an inference.
//
// One key, one shape, one accessor — mirrors pendingOffer.js so the writers and
// readers can't drift on where this lives. Cleared by clearFirmAccess (sign-out
// / dead session) so a different user on the same device never inherits it.

export const OWNER_CLIENT_ID_KEY = 'donna.owner_client_id.v1';

// Persist the owner's provisioned workspace id. No-op for a falsy id (never
// stamp the persona on an empty value).
export const rememberOwnerClientId = (clientId) => {
  try {
    if (typeof window === 'undefined') return;
    const normalized = String(clientId || '').trim();
    if (!normalized) return;
    window.localStorage.setItem(OWNER_CLIENT_ID_KEY, normalized);
  } catch {
    /* storage unavailable — non-fatal; routing falls back to the member default. */
  }
};

// The owner's workspace id, or null if this session has no owner persona on
// record (a firm member, a signed-out visitor, or a fresh device).
export const readOwnerClientId = () => {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(OWNER_CLIENT_ID_KEY);
    const normalized = String(raw || '').trim();
    return normalized || null;
  } catch {
    return null;
  }
};

export const clearOwnerClientId = () => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(OWNER_CLIENT_ID_KEY);
    }
  } catch {
    /* non-fatal */
  }
};
