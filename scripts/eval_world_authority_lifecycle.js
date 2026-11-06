import {
  buildAuthorityGrantId,
  findActiveAuthorityGrant,
  grantRowAllowsAutoAccept,
  suspendGrantAfterCorrection,
} from '../server/donna/reconciliationAuthorityGrants.js';
import {
  AUTHORITY_PLANE_PURGE_AUDIT_ACTION,
  recordAuthorityPlaneWipeReceipt,
  snapshotAuthorityPlaneForClient,
} from '../server/donna/authorityPlaneReceipt.js';
import { DELEGATED_AUTHORITY_FLAG_KEY } from '../server/donna/reconciliationLlmCore.js';

export const AUTO_SUSPEND_ACTION = 'reconciliation_authority_grant.auto_suspended';
const AS_OF = new Date('2026-08-19T00:00:00.000Z');
const AUTHORIZATION = Object.freeze({
  band: 'suggested', reasons: ['above_materiality_ceiling'],
  gates: { A: true, B: true, C: true, D: true, E: false },
});

export function bindProductionOperations(module = {}) {
  const names = ['buildAuthorityGrantId', 'findActiveAuthorityGrant', 'grantRowAllowsAutoAccept',
    'suspendGrantAfterCorrection', 'snapshotAuthorityPlaneForClient',
    'recordAuthorityPlaneWipeReceipt', 'AUTHORITY_PLANE_PURGE_AUDIT_ACTION'];
  const missing = names.filter((name) => name === 'AUTHORITY_PLANE_PURGE_AUDIT_ACTION'
    ? typeof module[name] !== 'string' : typeof module[name] !== 'function');
  if (missing.length) throw Object.assign(new Error(`Production authority boundary is missing: ${missing.join(', ')}`), { code: 'EAW_AUTHORITY_BOUNDARY_INCOMPLETE' });
  return Object.freeze(Object.fromEntries(names.map((name) => [name, module[name]])));
}

export const productionOperations = bindProductionOperations({
  buildAuthorityGrantId, findActiveAuthorityGrant, grantRowAllowsAutoAccept,
  suspendGrantAfterCorrection, snapshotAuthorityPlaneForClient,
  recordAuthorityPlaneWipeReceipt, AUTHORITY_PLANE_PURGE_AUDIT_ACTION,
});

export function createFakeAuthorityStore({ firmId = 'eaw-authority-firm', clientId = 'eaw-authority-firm-client-1' } = {}) {
  const state = { firmId, clientId, grants: [], flags: [], auditEvents: [], actionGrants: [], roleAssignments: [], clientExists: true };
  const client = { query: async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes("select to_regclass('public.")) {
      const table = normalized.match(/public\.([a-z_]+)/)?.[1];
      return { rows: [{ present: ['client_capability_config', 'reconciliation_authority_grants'].includes(table) ? table : null }] };
    }
    if (normalized.startsWith('select * from reconciliation_authority_grants')) {
      return { rows: state.grants.filter((row) => row.firm_id === params[0] && row.client_id === params[1] && row.archetype === params[2] && row.scope_key === params[3]).map((row) => structuredClone(row)) };
    }
    if (normalized.startsWith('update reconciliation_authority_grants')) {
      const row = state.grants.find((grant) => grant.firm_id === params[0] && grant.id === params[1]);
      if (!row) return { rows: [] };
      row.correction_count += 1; row.status = row.status === 'revoked' ? 'revoked' : 'suspended';
      return { rows: [{ id: row.id, client_id: row.client_id, status: row.status, correction_count: row.correction_count }] };
    }
    if (normalized.startsWith('select flag_key, stage')) return { rows: state.flags.map((row) => structuredClone(row)) };
    if (normalized.startsWith('select id, scope_kind')) return { rows: state.grants.map(({ id, scope_kind, scope_key, archetype, action, amount_ceiling, currency, status, source }) => ({ id, scope_kind, scope_key, archetype, action, amount_ceiling, currency, status, source })) };
    if (normalized.startsWith('insert into audit_events')) {
      const autoSuspend = normalized.includes('auto_suspended');
      state.auditEvents.push(autoSuspend
        ? { firm_id: params[0], client_id: params[1], action: AUTO_SUSPEND_ACTION, resource_id: params[2], metadata: JSON.parse(params[3]) }
        : { firm_id: params[0], client_id: params[1], action: params[2], resource_id: params[1], metadata: JSON.parse(params[3]) });
      return { rows: [] };
    }
    throw Object.assign(new Error(`Unexpected fake-store SQL: ${normalized}`), { code: 'EAW_FAKE_SQL_UNSUPPORTED' });
  } };
  return Object.freeze({
    state, client,
    addGrant(overrides = {}) {
      const scopeKind = overrides.scope_kind || 'merchant'; const scopeKey = overrides.scope_key || 'merchant/acme'; const action = 'accept_match';
      const row = { id: buildAuthorityGrantId({ firmId, clientId, scopeKind, scopeKey, action }), firm_id: firmId, client_id: clientId, scope_kind: scopeKind, scope_key: scopeKey, archetype: 'verified_card_payment', action, amount_ceiling: 1000, currency: 'GBP', status: 'active', source: 'accountant_approval', correction_count: 0, valid_from: '2026-01-01T00:00:00Z', expires_at: null, review_after: null, ...overrides };
      state.grants.push(row); return structuredClone(row);
    },
    readGrant(id) { const row = state.grants.find((grant) => grant.id === id); return row ? structuredClone(row) : null; },
    resetClient() { state.grants.length = 0; state.flags.length = 0; state.actionGrants.length = 0; state.roleAssignments.length = 0; state.clientExists = false; },
  });
}

const lookup = (ops, store, grant) => ops.findActiveAuthorityGrant({
  client: store.client, firmId: store.state.firmId, clientId: store.state.clientId,
  authorization: AUTHORIZATION, matchAmount: 500, currency: 'GBP',
  archetype: grant.archetype, scopeKey: grant.scope_key, asOf: AS_OF,
  configSnapshot: { [DELEGATED_AUTHORITY_FLAG_KEY]: { stage: 'auto', source: 'eaw_fixture' } }, env: {},
});

export async function driveCorrectionLifecycle({ store, ownerCorrection, grantId, ops = productionOperations } = {}) {
  if (ownerCorrection?.type !== 'owner_correction') throw Object.assign(new Error('A persisted owner_correction event is required.'), { code: 'EAW_OWNER_CORRECTION_REQUIRED' });
  const before = store.readGrant(grantId);
  if (!before) throw Object.assign(new Error('Correction grant is absent.'), { code: 'EAW_GRANT_REQUIRED' });
  await ops.suspendGrantAfterCorrection({ client: store.client, firmId: store.state.firmId, grantId, matchId: ownerCorrection.targetEventId, reason: 'owner_correction' });
  const persisted = store.readGrant(grantId);
  const nextMatch = await lookup(ops, store, persisted);
  return Object.freeze({ persisted, auditEvent: structuredClone(store.state.auditEvents.find((event) => event.action === AUTO_SUSPEND_ACTION && event.resource_id === grantId) || null), nextMatch, rowAllowsAutoAccept: ops.grantRowAllowsAutoAccept(persisted, { matchAmount: 500, currency: 'GBP', asOf: AS_OF }) });
}

export async function driveClientReset({ store, ops = productionOperations } = {}) {
  const before = await ops.snapshotAuthorityPlaneForClient({ client: store.client, firmId: store.state.firmId, clientId: store.state.clientId });
  const receipt = await ops.recordAuthorityPlaneWipeReceipt({ client: store.client, firmId: store.state.firmId, clientId: store.state.clientId, logger: { log() {} } });
  store.resetClient();
  const after = await ops.snapshotAuthorityPlaneForClient({ client: store.client, firmId: store.state.firmId, clientId: store.state.clientId });
  return Object.freeze({ before, receipt, after, auditEvent: structuredClone(store.state.auditEvents.find((event) => event.action === ops.AUTHORITY_PLANE_PURGE_AUDIT_ACTION) || null) });
}
