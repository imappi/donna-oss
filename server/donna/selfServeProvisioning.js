// Self-serve workspace provisioning — the FIRM-SHELL fallback entry point.
//
// A brand-new authenticated user (verified Supabase identity, no firm
// membership) who lands on the FIRM shell (not the /start funnel) hits the firm
// snapshot, gets a 401/403 from assertFirmAccess, and the app would otherwise
// show "Workspace pending". This module turns that dead-end into a live
// workspace — but it does NOT re-implement provisioning.
//
// The SINGLE provisioning implementation lives in selfProvisionDb.js
// (selfProvisionClientWorkspace). This module is a thin FEATURE-GATED wrapper
// over it so the firm-shell fallback and the /start funnel (WorkspaceProvisioner
// -> /self-provision) mint BYTE-IDENTICAL workspaces: role 'owner',
// services_engaged ['bank_reconciliation'], the email-prefix name-heal on a
// returning owner, and deterministic sha(firm|email) ids.
//
// History (Kari's call, 2026-06-28): #675 originally shipped a PARALLEL
// implementation here that drifted from #673's funnel path — no bank
// auto-scope, role 'client_owner' instead of 'owner', email-as-company-name,
// sha(firm:userId) ids, and a camelCase `clientId` return that the App.jsx
// firm-shell redirect (which reads `client_id`) never matched, so the redirect
// could never fire even with the gate on. Converged onto the one implementation
// so the two entry points can no longer diverge.
//
// Reversibility: gated behind DONNA_SELF_SERVE_PROVISIONING. Off (default) =
// the endpoint declines (api.js) and the app keeps the manual "Workspace
// pending" flow, byte-identical to before. NOTE the gate scopes ONLY this
// firm-shell fallback; the /start funnel path provisions unconditionally.

import { selfProvisionClientWorkspace } from './selfProvisionDb.js';

export const isSelfServeProvisioningEnabled = (env = process.env) =>
  env?.DONNA_SELF_SERVE_PROVISIONING === 'true';

// Mint (or idempotently resolve the existing) workspace for a verified owner
// who reached the firm shell. Delegates to the single implementation and maps
// its { clientId, created } onto the shape the App.jsx firm-shell fallback
// reads: `client_id` (snake_case, matching the /self-provision response
// contract) so the /client/<id> redirect actually fires. `provisioned`/
// `clientId` are kept for any caller still reading the older field names.
export const provisionClientWorkspaceForAuth = async ({
  firmId,
  auth,
  deps = {}
} = {}) => {
  const { provision = selfProvisionClientWorkspace } = deps;
  const { clientId, created } = await provision({ firmId, auth });
  return {
    provisioned: created,
    client_id: clientId,
    clientId
  };
};
