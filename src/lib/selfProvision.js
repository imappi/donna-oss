// Self-serve workspace provisioning — the client half of the signup funnel's
// post-auth step. Calls /api/donna/firms/self-provision (via firmFetch, so the
// Supabase bearer + 401-refresh apply) to turn the just-authenticated owner into
// a client workspace, returning its id so the funnel can route to /client/:id.
//
// The server is idempotent per owner, so calling this on every post-auth landing
// is safe — a returning owner gets their existing workspace back (created:false).

import { firmFetch, coerceErrorMessage } from './firmApi.js';
import { readPendingOffer } from './pendingOffer.js';

// Explicit existing-owner confirmation never reads or redeems a pending offer.
export const revalidateExistingOwnerWorkspace = async ({ action, confirmed, reviewDigest, signal }) => {
  const response = await firmFetch('/api/donna/firms/self-provision', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ owner_revalidation: { action,
      ...(['confirm', 'recovery_request', 'recovery_cancel'].includes(action) ? { confirmed, review_digest: reviewDigest } : {}) } }), signal
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(coerceErrorMessage(body.error, `Workspace confirmation failed (${response.status}).`)), { status: response.status, code: body.code });
  return body;
};

export const provisionWorkspace = async ({ signal } = {}) => {
  // Seed the new client's band from the offer the funnel stashed before auth, so
  // the portal can price the plan without re-asking. Authoritative billing_band_id
  // still lands via the Checkout webhook; this is just the head start.
  const offer = readPendingOffer();
  const response = await firmFetch('/api/donna/firms/self-provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      band_id: offer?.bandId || null,
      company_name: offer?.companyName || null,
      jurisdiction: offer?.jurisdiction || null,
      entity_type: offer?.entityType || null,
      incorporation_date: offer?.incorporationDate || null
    }),
    signal
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(coerceErrorMessage(body.error, `Workspace setup failed (${response.status}).`));
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return { clientId: body.client_id, created: Boolean(body.created) };
};

// The accounting-firm signup: a verified identity with no workspace provisions
// its OWN firm and becomes its administrator (server: firmSelfProvision.js).
// Idempotent per identity — a retry or repeated login returns the existing
// firm (created:false) instead of a second workspace.
export const provisionFirmWorkspace = async ({ firmName, ownerName, signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/self-provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ workspace: 'firm', firm_name: firmName, owner_name: ownerName }),
    signal
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(coerceErrorMessage(body.error, `Firm setup failed (${response.status}).`));
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return { firmId: body.firm_id, memberId: body.member_id, created: Boolean(body.created) };
};
