// RT-03 (audit F-03) — the one request-scoped firm resolver.
//
// Two resolvers existed: the env-only resolveConfiguredDefaultFirmId (frozen
// at 'donna-demo-firm' when nothing is configured) and the LIVE
// DEFAULT_FIRM_ID binding the desktop boot re-points to the sole minted
// firm. Route code that reached for the env resolver — or a literal — kept
// scoping a real firm's requests to the demo tenant. Request-scoped code
// now has exactly one door: explicit firm on the request, else the live
// default. Never the env resolver, never a literal.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  adoptResolvedDefaultFirmId,
  getDefaultFirmId,
  resolveConfiguredDefaultFirmId
} from './firmDb.js';
import { resolveRequestFirmId, resolveAuthenticatedMemberFirm } from './requestFirm.js';
import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

const DEMO_FIRM_ID = 'donna-demo-firm';
const ADOPTED_FIRM_ID = 'firm-test-x';
const TOKEN = 'request-firm-seam-token';
const auth = { authorization: `Bearer ${TOKEN}` };

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

test('resolveRequestFirmId: the request wins — body, then query, then the principal — trimmed', () => {
  const live = getDefaultFirmId();
  assert.equal(resolveRequestFirmId({ body: { firm_id: '  firm-body  ' } }), 'firm-body');
  assert.equal(resolveRequestFirmId({ body: { firmId: 'firm-camel' } }), 'firm-camel');
  assert.equal(
    resolveRequestFirmId({ body: { firm_id: 'firm-body' }, query: new URLSearchParams('firm_id=firm-query') }),
    'firm-body'
  );
  assert.equal(resolveRequestFirmId({ query: new URLSearchParams('firm_id=firm-query') }), 'firm-query');
  assert.equal(resolveRequestFirmId({ query: { firm_id: 'firm-plain-query' } }), 'firm-plain-query');
  assert.equal(resolveRequestFirmId({ body: {}, query: new URLSearchParams(''), auth: { firmId: 'firm-auth' } }), 'firm-auth');
  assert.equal(resolveRequestFirmId({ body: { firm_id: '   ' }, query: null, auth: null }), live);
  assert.equal(resolveRequestFirmId({}), live);
  assert.equal(resolveRequestFirmId(), live);
});

test('resolveRequestFirmId: with nothing named it follows the LIVE default the boot re-pointed, not the env resolver', async () => {
  const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-request-firm-'));
  const prior = {
    DONNA_DEFAULT_FIRM_ID: process.env.DONNA_DEFAULT_FIRM_ID,
    DONNA_DESKTOP_BLOB_DIR: process.env.DONNA_DESKTOP_BLOB_DIR
  };
  try {
    // The first-run shape: nothing configured, desktop host, one minted firm.
    delete process.env.DONNA_DEFAULT_FIRM_ID;
    process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
    assert.equal(getDefaultFirmId(), DEMO_FIRM_ID, 'load-time default is the demo tenant');
    assert.equal(resolveRequestFirmId({}), DEMO_FIRM_ID);

    adoptResolvedDefaultFirmId(ADOPTED_FIRM_ID, { reason: 'rt03_test_boot', logger: { log: () => {} } });

    assert.equal(getDefaultFirmId(), ADOPTED_FIRM_ID, 'the getter reads the live binding');
    assert.equal(resolveRequestFirmId({}), ADOPTED_FIRM_ID, 'the resolver follows it');
    // The split the audit named: the env resolver still says demo. Boot/config
    // code may keep it; request-scoped code must not.
    assert.equal(resolveConfiguredDefaultFirmId(), DEMO_FIRM_ID);
  } finally {
    restoreEnv('DONNA_DEFAULT_FIRM_ID', prior.DONNA_DEFAULT_FIRM_ID);
    restoreEnv('DONNA_DESKTOP_BLOB_DIR', prior.DONNA_DESKTOP_BLOB_DIR);
    await rm(blobDir, { recursive: true, force: true });
  }
});

// Route pin at the seam: the live default above is now ADOPTED_FIRM_ID for
// this process (adopt is one-way, as on the appliance). The upload-url route
// without firm_id must key and admit under it — not under the demo literal.
const withSeamEnv = async (run) => {
  const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-request-firm-seam-'));
  const keys = ['DONNA_ACCESS_TOKEN', 'DATABASE_URL', 'DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.DONNA_ACCESS_TOKEN = TOKEN;
    process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
    delete process.env.DONNA_DEFAULT_FIRM_ID;
    process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
    return await run();
  } finally {
    for (const key of keys) restoreEnv(key, prior[key]);
    await rm(blobDir, { recursive: true, force: true });
  }
};

const signBody = (overrides = {}) => ({
  client_id: 'client-1',
  filename: 'statement.pdf',
  mime_type: 'application/pdf',
  size: 1024,
  ...overrides
});

const admissionLookups = (pool) =>
  pool.matching(/from client_capability_config/i).map(({ params }) => params.slice(0, 2));

const ownedUploadPool = (firmId) => createApiSeamPool([
  [/^select id from clients where firm_id = \$1 and id = \$2 and status <> \$3$/, ({ params }) => ({
    rows: params[0] === firmId && params[1] === 'client-1' && params[2] === 'deleted' ? [{ id: 'client-1' }] : []
  })],
  [/^select id from clients where firm_id=\$1 and id=\$2 for share nowait$/, ({ params }) => ({
    rows: params[0] === firmId && params[1] === 'client-1' ? [{ id: 'client-1' }] : []
  })]
]);

test('upload-url without firm_id keys and admits under the live default, never the demo literal', async () => {
  await withSeamEnv(async () => {
    assert.equal(getDefaultFirmId(), ADOPTED_FIRM_ID, 'process-level live default from the adopt above');
    const pool = ownedUploadPool(ADOPTED_FIRM_ID);
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: signBody(),
      pool
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.provider, 'local_blob');
    assert.ok(
      String(response.json.key).startsWith(`${ADOPTED_FIRM_ID}/client-1/`),
      `key must be under the live default firm, got ${response.json.key}`
    );
    assert.equal(String(response.json.key).startsWith(`${DEMO_FIRM_ID}/`), false);
    assert.deepEqual(admissionLookups(pool), [[ADOPTED_FIRM_ID, 'client-1']],
      'upload_sign admission was evaluated for the live default firm');
  });
});

test('upload-url with an explicit firm_id keys and admits under that firm', async () => {
  await withSeamEnv(async () => {
    const pool = ownedUploadPool('firm-explicit');
    const response = await requestDonnaApi({
      method: 'POST',
      url: '/api/donna/firms/documents/upload-url',
      headers: auth,
      body: signBody({ firm_id: 'firm-explicit' }),
      pool
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(String(response.json.key).startsWith('firm-explicit/client-1/'), response.json.key);
    assert.deepEqual(admissionLookups(pool), [['firm-explicit', 'client-1']]);
  });
});

// Cloud semantics stay frozen: an explicitly configured DONNA_DEFAULT_FIRM_ID
// wins at call time over the live binding (the rule adoptResolvedDefaultFirmId
// already enforces — it refuses to re-point when one is configured). A cloud
// route that provisions under the configured firm and then reads the default
// for its readiness call must land on the same firm.
test('getDefaultFirmId: a configured DONNA_DEFAULT_FIRM_ID wins over the live binding', () => {
  const prior = process.env.DONNA_DEFAULT_FIRM_ID;
  try {
    process.env.DONNA_DEFAULT_FIRM_ID = '  firm-configured  ';
    assert.equal(getDefaultFirmId(), 'firm-configured');
    assert.equal(resolveRequestFirmId({}), 'firm-configured');
    assert.equal(resolveRequestFirmId({ body: { firm_id: 'firm-body' } }), 'firm-body');
    delete process.env.DONNA_DEFAULT_FIRM_ID;
    assert.equal(getDefaultFirmId(), ADOPTED_FIRM_ID, 'unset → the live binding again');
  } finally {
    restoreEnv('DONNA_DEFAULT_FIRM_ID', prior);
  }
});

test('a sole owner principal in a non-default firm resolves to that firm; default-firm and ambiguous owners keep the default', async () => {
  const prior = process.env.DONNA_DEFAULT_FIRM_ID;
  process.env.DONNA_DEFAULT_FIRM_ID = 'deployment-firm';
  try {
    const auth = { type: 'supabase_user', staff: false, userId: 'u', email: 'owner@example.test' };
    const owners = (rows) => async (sql) => ({ rows: sql.includes('firm_collaborators') ? rows : [] });
    assert.deepEqual(await resolveAuthenticatedMemberFirm({ auth, queryFn: owners([{ firm_id: 'firm-x', owner: true }]) }), { firmId: 'firm-x', ambiguous: false });
    assert.deepEqual(await resolveAuthenticatedMemberFirm({ auth, queryFn: owners([{ firm_id: 'deployment-firm', owner: true }]) }), { firmId: null, ambiguous: false });
    assert.deepEqual(await resolveAuthenticatedMemberFirm({ auth, queryFn: owners([{ firm_id: 'firm-x', owner: true }, { firm_id: 'firm-y', owner: true }]) }), { firmId: null, ambiguous: false });
    assert.deepEqual(await resolveAuthenticatedMemberFirm({ auth, queryFn: owners([{ firm_id: 'firm-x', owner: true }, { firm_id: 'firm-s', owner: false }]) }), { firmId: 'firm-s', ambiguous: false },
      'a seat keeps its prior resolution');
  } finally {
    restoreEnv('DONNA_DEFAULT_FIRM_ID', prior);
  }
});

test('member firm selection is database membership, refuses ambiguous membership, and falls back to a sole collaborator firm', async () => {
  let calls = 0;
  const queryFn = async (_sql, params) => { calls++; assert.deepEqual(params, ['u', 'member@example.test']); return { rows: [{firm_id:'a'}] }; };
  const auth = {type:'supabase_user',staff:true,userId:'u',email:'MEMBER@example.test'};
  assert.deepEqual(await resolveAuthenticatedMemberFirm({auth,queryFn}), {firmId:'a',ambiguous:false});
  // A self-provisioned firm administrator is never on a staff allowlist: the
  // membership row is the authority (2026-09-16).
  assert.deepEqual(await resolveAuthenticatedMemberFirm({auth:{...auth,staff:false},queryFn}), {firmId:'a',ambiguous:false});
  assert.deepEqual(await resolveAuthenticatedMemberFirm({auth:{...auth,type:'access_token'},queryFn}), {firmId:null,ambiguous:false});
  assert.equal(calls, 2);
  assert.deepEqual(await resolveAuthenticatedMemberFirm({auth,queryFn:async()=>({rows:[{firm_id:'a'},{firm_id:'b'}]})}), {firmId:null,ambiguous:true});
  // No membership: an invited/active SEAT collaborator resolves to its single
  // firm; several seat firms keep the deployment default (not ambiguous).
  const collaboratorOnly = (rows) => async (sql) => { if (sql.includes('firm_collaborators')) assert.match(sql, /seat_role is not null/); return { rows: sql.includes('firm_collaborators') ? rows : [] }; };
  assert.deepEqual(await resolveAuthenticatedMemberFirm({auth,queryFn:collaboratorOnly([{firm_id:'c'}])}), {firmId:'c',ambiguous:false});
  assert.deepEqual(await resolveAuthenticatedMemberFirm({auth,queryFn:collaboratorOnly([{firm_id:'c'},{firm_id:'d'}])}), {firmId:null,ambiguous:false});
  assert.deepEqual(await resolveAuthenticatedMemberFirm({auth,queryFn:collaboratorOnly([])}), {firmId:null,ambiguous:false});
});
