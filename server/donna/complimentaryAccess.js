// Complimentary (free) access, represented on the config control plane.
//
// A self-service firm workspace is born with ONE firm-default row
// (`client_id is null`) for COMPLIMENTARY_ACCESS. The existing billing-context
// reader (clientSubscriptionDb.getClientBillingContext) treats an acting row as
// entitlement — beside the pilot's `internal_pilot` basis — so every existing
// gate (assertClientEntitled, /billing/status, the portal gate, MCP) works
// unchanged and the Stripe mirror columns stay NULL: nothing is recorded as
// paid. It grants entitlement ONLY: no processing, outbound, filing or
// readiness authority rides on it (those keys are seeded per client, and the
// outbound/filing lanes are born `off`). Switching to paid onboarding later is
// a config write (stage the firm-default row `off`, or scope it to a cohort);
// the checkout + webhook path then takes over without replacing this flow.
import { clientFlagActs, readClientConfigSnapshot } from './clientConfig.js';

export const COMPLIMENTARY_ACCESS_FLAG = 'COMPLIMENTARY_ACCESS';
export const COMPLIMENTARY_ACCESS_VERSION = 'donna.complimentary-access.v1';
export const COMPLIMENTARY_ENTITLEMENT_BASIS = 'complimentary';

// Resolves through the ordinary snapshot reader so client > cohort > firm
// default precedence and CLIENT_CONFIG_FORCE_DISABLE stay the one authority.
export const readComplimentaryAccessWithClient = async (client, { firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return false;
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  return clientFlagActs({ flagKey: COMPLIMENTARY_ACCESS_FLAG, snapshot, envFallback: () => false });
};
