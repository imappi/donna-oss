// Authenticated transport adapter for the existing bounded setup writer.
import { assertFirmAccess } from './firmDb.js';
import { prepareFinnishHostedPilotInDb, reviewFinnishHostedPilotInDb } from './hostedPilot.js';
import { operateDeletedOwnerRecovery } from './deletedOwnerRecovery.js';

const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };
export const handleFinnishPilotOperator = async ({ auth, firmId, clientId, method, body = {}, recovery = false }, deps = {}) => {
  const authorize = deps.authorize || assertFirmAccess;
  if (!firmId || !clientId) fail('PILOT_SCOPE_REQUIRED', 'Select a firm and client.');
  // Recovery must not pass through the legacy email fallback or NULL-id
  // auto-binding in assertFirmAccess, including on a read-only review.
  if (recovery || Object.hasOwn(body || {}, 'owner_recovery')) {
    if (!['GET', 'POST'].includes(method) || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['firm_id', 'owner_recovery'].includes(key))
      || (method === 'POST' && body.owner_recovery?.action !== 'approve')) {
      fail('PILOT_INPUT_INVALID', 'Review the owner recovery request before approving it.');
    }
    return (deps.recover || operateDeletedOwnerRecovery)({ firmId, clientId, auth,
      request: method === 'GET' ? { action: 'review' } : body.owner_recovery });
  }
  const access = await authorize({ firmId, auth, clientIds: [clientId], requireMember: true });
  const principal = access.principal;
  // An unrestricted shared token is not an identified member. No desktop
  // founder resolution or caller actor/authority fields can upgrade this gate.
  if (principal?.principalType !== 'firm_member' || !principal.principalId) {
    fail('PILOT_OPERATOR_REQUIRED', 'An authenticated active firm member must prepare this pilot.', 403);
  }
  const scope = { firmId, clientId, actorId: principal.principalId };
  if (method === 'GET') return (deps.review || reviewFinnishHostedPilotInDb)(scope);
  if (method !== 'POST') fail('PILOT_METHOD_NOT_ALLOWED', 'Use review or prepare.', 405);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('PILOT_INPUT_INVALID', 'Expected a setup object.');
  if (Object.keys(body).some(key => !['firm_id', 'profile_patch', 'client_version', 'confirmed'].includes(key))) {
    fail('PILOT_INPUT_INVALID', 'Unexpected setup fields. Review the client again.');
  }
  const profile = body.profile_patch;
  const fields = ['companyName', 'jurisdiction', 'entityType', 'accountingCurrency', 'accounting_system', 'accounting_view', 'accountingBasis'];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || Object.keys(profile).length !== fields.length || fields.some(key => typeof profile[key] !== 'string')) {
    fail('PILOT_INPUT_INVALID', 'Confirm the complete Finnish pilot profile.');
  }
  if (body.confirmed !== true || typeof body.client_version !== 'string' || !/^[a-f0-9]{64}$/.test(body.client_version)) {
    fail('PILOT_CONFIRMATION_REQUIRED', 'Review this client and explicitly confirm the profile before preparing.');
  }
  return (deps.prepare || prepareFinnishHostedPilotInDb)({ ...scope, profilePatch: profile, expectedClientVersion: body.client_version });
};
