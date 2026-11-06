// Client-side self-serve workspace provisioning.
//
// When a freshly-authenticated user has no firm workspace yet, the firm
// snapshot 401/403s and the app would otherwise show the manual "Workspace
// pending" state. This wrapper asks the server to mint a scoped client-owner
// workspace for the verified identity; on success the app routes the user into
// their new portal (/client/<id>) where the stashed funnel offer redeems into
// Stripe.
//
// Reuses firmFetch so the Supabase auth headers (and the 401 refresh-retry)
// apply exactly as they do for every other firm/portal request.

import { firmFetch, coerceErrorMessage } from './firmApi.js';

// Returns { provisioned, client_id, ... } on success. Throws on failure with a
// `.code` the caller can branch on:
//   - SELF_SERVE_PROVISIONING_DISABLED — the feature env is off; the caller
//     should fall back to the manual "Workspace pending" flow.
//   - anything else — a real error; same fallback, surfaced if useful.
export const provisionWorkspace = async ({ signal } = {}) => {
  const response = await firmFetch('/api/donna/firms/provision-workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
    signal
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      coerceErrorMessage(body.error, `Workspace provisioning failed with ${response.status}`)
    );
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
};
