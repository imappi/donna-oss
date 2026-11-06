// MCP consent surface tests (mcpConsent.js) — the owner-side read + write.
//
// Load-bearing properties:
//   - fail-closed read: no row ⇒ stage null / exposed false; the kill switch
//     (CLIENT_CONFIG_FORCE_DISABLE) reads as force_disabled AND kills every
//     exposed bit while the recorded stage stays visible (honest UI);
//   - a client-scoped principal's list is filtered to their own ventures;
//   - the write maps ONLY expose→canary / revoke→off (auto is unexpressible),
//     goes through setClientFlagStage with actor_type 'owner' + the real
//     principal id, verifies the entity exists first, and rolls back cleanly
//     when the writer fails;
//   - with the REAL writer, the audit row lands in the same transaction as
//     the config row (no silent consent change).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listEntityExposure,
  setEntityExposure,
  MCP_EXPOSE_STAGE,
  MCP_REVOKE_STAGE
} from './mcpConsent.js';
import { MCP_ENTITY_EXPOSE_FLAG_KEY } from './mcpReadSurface.js';
import { setClientFlagStage } from '../clientConfig.js';

const CLIENT_ROWS = [
  { id: 'alpha', company_name: 'Alpha Oy', status: 'active' },
  { id: 'beta', company_name: 'Beta Ltd', status: 'active' }
];

const fakeDb = (rowsByPattern = {}) => {
  const calls = [];
  const dbClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, rows] of Object.entries(rowsByPattern)) {
        if (sql.includes(pattern)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    }
  };
  return { dbClient, calls };
};

const depsFor = ({ dbClient, snapshots = {}, env = {} } = {}) => ({
  withFirmDbClient: async (fn) => fn(dbClient),
  readClientConfigSnapshot: async (_db, { clientId }) => snapshots[clientId] || {},
  env
});

test('listEntityExposure fail-closed: no config row ⇒ stage null, exposed false', async () => {
  const { dbClient } = fakeDb({ 'from clients': CLIENT_ROWS });
  const out = await listEntityExposure({ firmId: 'f1', deps: depsFor({ dbClient }) });
  assert.equal(out.flag_key, MCP_ENTITY_EXPOSE_FLAG_KEY);
  assert.equal(out.force_disabled, false);
  assert.equal(out.entities.length, 2);
  for (const entity of out.entities) {
    assert.equal(entity.stage, null);
    assert.equal(entity.exposed, false);
  }
  // ONE consent covers every chat surface; the screen lists them from here.
  assert.deepEqual(out.surfaces.map((s) => s.id), ['claude_desktop_mcp', 'chatgpt_app', 'claude_remote']);
  assert.deepEqual(out.surfaces.map((s) => s.label), ['Claude Desktop (local extension)', 'ChatGPT (Donna app)', 'Claude (remote connector)']);
  for (const s of out.surfaces) assert.ok(s.transport, `${s.id} names its transport`);
});

test('listEntityExposure: canary row acts, off row does not', async () => {
  const { dbClient } = fakeDb({ 'from clients': CLIENT_ROWS });
  const snapshots = {
    alpha: { [MCP_ENTITY_EXPOSE_FLAG_KEY]: { stage: 'canary', source: 'manual' } },
    beta: { [MCP_ENTITY_EXPOSE_FLAG_KEY]: { stage: 'off', source: 'manual' } }
  };
  const out = await listEntityExposure({ firmId: 'f1', deps: depsFor({ dbClient, snapshots }) });
  const [alpha, beta] = out.entities;
  assert.deepEqual({ stage: alpha.stage, exposed: alpha.exposed }, { stage: 'canary', exposed: true });
  assert.deepEqual({ stage: beta.stage, exposed: beta.exposed }, { stage: 'off', exposed: false });
});

test('listEntityExposure under the kill switch: force_disabled true, exposure dead, recorded stage still visible', async () => {
  const { dbClient } = fakeDb({ 'from clients': CLIENT_ROWS });
  const snapshots = { alpha: { [MCP_ENTITY_EXPOSE_FLAG_KEY]: { stage: 'canary', source: 'manual' } } };
  const out = await listEntityExposure({
    firmId: 'f1',
    deps: depsFor({ dbClient, snapshots, env: { CLIENT_CONFIG_FORCE_DISABLE: MCP_ENTITY_EXPOSE_FLAG_KEY } })
  });
  assert.equal(out.force_disabled, true);
  const alpha = out.entities.find((e) => e.id === 'alpha');
  assert.equal(alpha.stage, 'canary');
  assert.equal(alpha.exposed, false);
});

test('listEntityExposure scopes a client-scoped principal to their own ventures', async () => {
  const { dbClient } = fakeDb({ 'from clients': CLIENT_ROWS });
  const out = await listEntityExposure({
    firmId: 'f1',
    allowedClientIds: ['beta'],
    deps: depsFor({ dbClient })
  });
  assert.deepEqual(out.entities.map((e) => e.id), ['beta']);
});

test('setEntityExposure grant: canary via the audited writer, owner-attributed, fresh state returned', async () => {
  const { dbClient, calls } = fakeDb({ 'from clients where': [CLIENT_ROWS[0]] });
  const writes = [];
  const out = await setEntityExposure({
    firmId: 'f1',
    clientId: 'alpha',
    expose: true,
    actorId: 'kari@books.example',
    deps: {
      ...depsFor({
        dbClient,
        snapshots: { alpha: { [MCP_ENTITY_EXPOSE_FLAG_KEY]: { stage: 'canary', source: 'manual' } } }
      }),
      setClientFlagStage: async (_db, args) => {
        writes.push(args);
        return { id: 'row-1', stage: args.stage };
      }
    }
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].flagKey, MCP_ENTITY_EXPOSE_FLAG_KEY);
  assert.equal(writes[0].stage, MCP_EXPOSE_STAGE);
  assert.equal(writes[0].stage, 'canary');
  assert.equal(writes[0].clientId, 'alpha');
  assert.equal(writes[0].source, 'manual');
  assert.equal(writes[0].actorType, 'owner');
  assert.equal(writes[0].actorId, 'kari@books.example');
  assert.equal(out.exposed, true);
  assert.equal(out.stage, 'canary');
  assert.equal(out.entity.id, 'alpha');
  assert.ok(calls.some((c) => c.sql === 'begin') && calls.some((c) => c.sql === 'commit'));
});

test('setEntityExposure revoke maps to off — auto is unexpressible from this surface', async () => {
  const { dbClient } = fakeDb({ 'from clients where': [CLIENT_ROWS[0]] });
  const writes = [];
  const out = await setEntityExposure({
    firmId: 'f1',
    clientId: 'alpha',
    expose: false,
    deps: {
      ...depsFor({
        dbClient,
        snapshots: { alpha: { [MCP_ENTITY_EXPOSE_FLAG_KEY]: { stage: 'off', source: 'manual' } } }
      }),
      setClientFlagStage: async (_db, args) => {
        writes.push(args);
        return { id: 'row-2', stage: args.stage };
      }
    }
  });
  assert.equal(writes[0].stage, MCP_REVOKE_STAGE);
  assert.equal(writes[0].stage, 'off');
  assert.notEqual(MCP_EXPOSE_STAGE, 'auto');
  assert.notEqual(MCP_REVOKE_STAGE, 'auto');
  assert.equal(out.exposed, false);
});

test('setEntityExposure refuses a nameless or boolean-less request', async () => {
  const { dbClient } = fakeDb();
  await assert.rejects(
    () => setEntityExposure({ firmId: 'f1', clientId: '', expose: true, deps: depsFor({ dbClient }) }),
    (err) => err.statusCode === 400 && err.code === 'CLIENT_REQUIRED'
  );
  await assert.rejects(
    () => setEntityExposure({ firmId: 'f1', clientId: 'alpha', expose: 'yes', deps: depsFor({ dbClient }) }),
    (err) => err.statusCode === 400 && err.code === 'EXPOSE_REQUIRED'
  );
});

test('setEntityExposure 404s an entity outside the firm, without writing', async () => {
  const { dbClient, calls } = fakeDb({ 'from clients where': [] });
  await assert.rejects(
    () => setEntityExposure({ firmId: 'f1', clientId: 'ghost', expose: true, deps: depsFor({ dbClient }) }),
    (err) => err.statusCode === 404 && err.code === 'CLIENT_NOT_FOUND'
  );
  assert.ok(!calls.some((c) => c.sql === 'begin'));
});

test('setEntityExposure rolls back and propagates when the writer fails (no silent consent change)', async () => {
  const { dbClient, calls } = fakeDb({ 'from clients where': [CLIENT_ROWS[0]] });
  await assert.rejects(
    () => setEntityExposure({
      firmId: 'f1',
      clientId: 'alpha',
      expose: true,
      deps: {
        ...depsFor({ dbClient }),
        setClientFlagStage: async () => { throw new Error('writer down'); }
      }
    }),
    /writer down/
  );
  assert.ok(calls.some((c) => c.sql === 'rollback'));
  assert.ok(!calls.some((c) => c.sql === 'commit'));
});

test('with the REAL writer: config row and audit row land in the same transaction, actor_type owner', async () => {
  const { dbClient, calls } = fakeDb({ 'from clients where': [CLIENT_ROWS[0]] });
  const out = await setEntityExposure({
    firmId: 'f1',
    clientId: 'alpha',
    expose: true,
    actorId: 'kari@books.example',
    deps: {
      withFirmDbClient: async (fn) => fn(dbClient),
      readClientConfigSnapshot: async () => ({ [MCP_ENTITY_EXPOSE_FLAG_KEY]: { stage: 'canary', source: 'manual' } }),
      setClientFlagStage, // the real one
      env: {}
    }
  });
  const beginIdx = calls.findIndex((c) => c.sql === 'begin');
  const commitIdx = calls.findIndex((c) => c.sql === 'commit');
  const configIdx = calls.findIndex((c) => c.sql.includes('insert into client_capability_config'));
  const auditIdx = calls.findIndex((c) => c.sql.includes('insert into audit_events'));
  assert.ok(beginIdx >= 0 && commitIdx > beginIdx);
  assert.ok(configIdx > beginIdx && configIdx < commitIdx, 'config row inside the transaction');
  assert.ok(auditIdx > beginIdx && auditIdx < commitIdx, 'audit row inside the transaction');
  const auditParams = calls[auditIdx].params;
  assert.equal(auditParams[2], 'owner');
  const configParams = calls[configIdx].params;
  assert.equal(configParams[4], 'canary');
  assert.equal(configParams[8], 'kari@books.example');
  assert.equal(out.exposed, true);
});
