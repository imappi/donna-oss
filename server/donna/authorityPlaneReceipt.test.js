import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITY_PLANE_PURGE_AUDIT_ACTION,
  snapshotAuthorityPlaneForClient,
  recordAuthorityPlaneWipeReceipt
} from './authorityPlaneReceipt.js';

const makeFakeClient = ({
  flags = [], grants = [], actionGrants = [], roleAssignments = [],
  present = {}, specialistColumns = true
} = {}) => {
  const tables = {
    client_capability_config: true,
    reconciliation_authority_grants: true,
    action_authority_grants: true,
    client_assignments: true,
    ...present
  };
  const inserts = [];
  return {
    inserts,
    query: async (sql, params) => {
      if (sql.includes('to_regclass')) {
        const table = Object.keys(tables).find((t) => sql.includes(`'public.${t}'`));
        return { rows: [{ present: table && tables[table] ? 'public.x' : null }] };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: specialistColumns && tables.client_assignments ? [{ present: 1 }] : [] };
      }
      if (sql.includes('from client_capability_config')) {
        assert.deepEqual(params, ['firm-1', 'honeybee']);
        return { rows: flags };
      }
      if (sql.includes('from reconciliation_authority_grants')) {
        assert.deepEqual(params, ['firm-1', 'honeybee']);
        return { rows: grants };
      }
      if (sql.includes('from action_authority_grants')) {
        assert.deepEqual(params, ['firm-1', 'honeybee']);
        return { rows: actionGrants };
      }
      if (sql.includes('from client_assignments')) {
        assert.deepEqual(params, ['firm-1', 'honeybee']);
        return { rows: roleAssignments };
      }
      if (sql.includes('insert into audit_events')) {
        inserts.push({ sql, params });
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }
  };
};

const CANARY_FLAG = { flag_key: 'LEDGER_AUTO_POST', stage: 'canary', source: 'manual', reason: 'r', set_by_actor_type: 'system', set_by_actor_id: null, valid_from: 't' };
const SEED_FLAG = { flag_key: 'CODING_AUTO_POST', stage: 'auto', source: 'default', reason: 'desktop_host_default', set_by_actor_type: 'system', set_by_actor_id: null, valid_from: 't' };
const GRANT = { id: 'g1', scope_kind: 'merchant', scope_key: 'sonoran', archetype: 'recurring_rent_lease', action: 'accept_match', amount_ceiling: '900', currency: 'USD', status: 'active', source: 'operator_one_click' };
const ACTION_GRANT = { id: 'ag1', domain: 'outbound', action_type: 'send_receivable_reminder', scope_kind: 'counterparty', scope_key: 'p-9', amount_ceiling: '500', currency: 'GBP', status: 'active', source: 'owner_approval', provenance: { role_id: 'invoicing_collections' } };
const ROLE_ROW = { id: 'ra1', role: 'invoicing_collections', principal_type: 'ai_occupant', principal_id: 'donna_ai', ai_profile: 'clara', status: 'active' };

test('receipt: staged flags + grants are snapshotted into one audit event before the cascade', async () => {
  const client = makeFakeClient({ flags: [CANARY_FLAG, SEED_FLAG], grants: [GRANT] });
  const lines = [];
  const out = await recordAuthorityPlaneWipeReceipt({
    client, firmId: 'firm-1', clientId: 'honeybee', logger: { log: (l) => lines.push(l) }
  });
  assert.deepEqual(out, { recorded: true, flags: 2, grants: 1, action_grants: 0, role_assignments: 0 });
  assert.equal(client.inserts.length, 1);
  const [firmId, clientId, action, payload] = client.inserts[0].params;
  assert.equal(firmId, 'firm-1');
  assert.equal(clientId, 'honeybee');
  assert.equal(action, AUTHORITY_PLANE_PURGE_AUDIT_ACTION);
  const parsed = JSON.parse(payload);
  assert.deepEqual(parsed.flags.map((f) => f.flag_key), ['LEDGER_AUTO_POST', 'CODING_AUTO_POST']);
  assert.deepEqual(parsed.grants.map((g) => g.id), ['g1']);
  // The console line leads with the manually staged rows — the ones no seed restores.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /LEDGER_AUTO_POST\(canary\)/);
  assert.doesNotMatch(lines[0], /CODING_AUTO_POST\(auto\)/);
});

test('receipt: the bench dies loudly — specialist assignments + action grants ride the same receipt (S2)', async () => {
  const client = makeFakeClient({
    flags: [CANARY_FLAG], grants: [], actionGrants: [ACTION_GRANT], roleAssignments: [ROLE_ROW]
  });
  const lines = [];
  const out = await recordAuthorityPlaneWipeReceipt({
    client, firmId: 'firm-1', clientId: 'honeybee', logger: { log: (l) => lines.push(l) }
  });
  assert.deepEqual(out, { recorded: true, flags: 1, grants: 0, action_grants: 1, role_assignments: 1 });
  const parsed = JSON.parse(client.inserts[0].params[3]);
  assert.deepEqual(parsed.action_grants.map((g) => g.id), ['ag1']);
  assert.deepEqual(parsed.role_assignments.map((r) => r.role), ['invoicing_collections']);
  assert.match(lines[0], /bench un-hired: invoicing_collections/);
});

test('receipt: an empty plane records nothing — no event, no log', async () => {
  const client = makeFakeClient({ flags: [], grants: [] });
  const lines = [];
  const out = await recordAuthorityPlaneWipeReceipt({
    client, firmId: 'firm-1', clientId: 'honeybee', logger: { log: (l) => lines.push(l) }
  });
  assert.deepEqual(out, { recorded: false, flags: 0, grants: 0, action_grants: 0, role_assignments: 0 });
  assert.equal(client.inserts.length, 0);
  assert.equal(lines.length, 0);
});

test('receipt: pre-migration tables skip silently — deletion is never blocked', async () => {
  const client = makeFakeClient({
    flags: [CANARY_FLAG],
    grants: [GRANT],
    actionGrants: [ACTION_GRANT],
    roleAssignments: [ROLE_ROW],
    present: {
      client_capability_config: false,
      reconciliation_authority_grants: false,
      action_authority_grants: false,
      client_assignments: false
    }
  });
  const out = await recordAuthorityPlaneWipeReceipt({ client, firmId: 'firm-1', clientId: 'honeybee', logger: { log: () => {} } });
  assert.deepEqual(out, { recorded: false, flags: 0, grants: 0, action_grants: 0, role_assignments: 0 });
  assert.equal(client.inserts.length, 0);
});

test('receipt: a pre-117 client_assignments (no assignment_kind column) skips the bench read', async () => {
  const client = makeFakeClient({
    flags: [CANARY_FLAG], roleAssignments: [ROLE_ROW], specialistColumns: false
  });
  const out = await recordAuthorityPlaneWipeReceipt({ client, firmId: 'firm-1', clientId: 'honeybee', logger: { log: () => {} } });
  assert.deepEqual(out, { recorded: true, flags: 1, grants: 0, action_grants: 0, role_assignments: 0 });
});

test('receipt: baseline-seed-only flags still receipt durably, but the line says so', async () => {
  const client = makeFakeClient({ flags: [SEED_FLAG], grants: [] });
  const lines = [];
  const out = await recordAuthorityPlaneWipeReceipt({
    client, firmId: 'firm-1', clientId: 'honeybee', logger: { log: (l) => lines.push(l) }
  });
  assert.deepEqual(out, { recorded: true, flags: 1, grants: 0, action_grants: 0, role_assignments: 0 });
  assert.equal(client.inserts.length, 1);
  assert.match(lines[0], /baseline seeds only/);
});

test('snapshot: missing args return an empty plane without touching the db', async () => {
  const out = await snapshotAuthorityPlaneForClient({ client: null, firmId: 'f', clientId: 'c' });
  assert.deepEqual(out, { flags: [], grants: [], action_grants: [], role_assignments: [] });
});
