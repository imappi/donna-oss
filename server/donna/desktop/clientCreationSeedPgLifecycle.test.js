// BF-1 — real HTTP route + PostgreSQL lifecycle proof for fail-closed
// desktop client initialization.
//
// The narrow hostPlaneSeed unit test proves the writer propagates an injected
// seed error. This test proves the production composition that mocks cannot:
// an actual /firms/clients request reaches createClientInDb, PostgreSQL rejects
// the first governed config-row insert, the whole client transaction rolls
// back, and the same request succeeds idempotently once the dependency heals.
//
// OPT-IN like the other real-PG lifecycle suites: DONNA_PG_TEST_URL must name
// a scratch PostgreSQL role that may CREATE DATABASE. The test applies the real
// migrations to a throwaway database and invokes handleDonnaApiRequest without
// opening a socket.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { handleDonnaApiRequest } from '../api.js';
import { ENTITY_READINESS_ADMISSION_FLAG } from '../clientConfig.js';
import { __endFirmDbPoolForTests } from '../firmDb.js';
import { ENTITY_READINESS_NEW_CLIENT_REASON } from '../runtimeReadinessEnrollment.js';
import { DESKTOP_CLIENT_FLAG_SEEDS } from './hostPlaneSeed.js';
import { makeJevTrialProvider } from '../jevTrialProvider.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FIRM_ID = 'firm-bf1';
const CLIENT_ID = 'client-bf1';
const ACCESS_TOKEN = 'bf1-route-token';

const restoreEnv = (key, prior) => {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
};

const requestClientCreate = async (method = 'POST') => {
  const body = JSON.stringify({
    firm_id: FIRM_ID,
    profile: {
      id: CLIENT_ID,
      companyName: 'BF-1 Apiary Ltd',
      jurisdiction: 'GB',
      entityType: 'gb-ltd'
    },
    queue: [{ id: 'queue-bf1', queue_label: 'First client work' }]
  });
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = `/api/donna/firms/clients${method === 'DELETE' ? `/${CLIENT_ID}?firm_id=${FIRM_ID}` : ''}`;
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'x-donna-access-token': ACCESS_TOKEN
  };

  let responseBody = '';
  let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  const headers = new Map();
  const res = {
    statusCode: 200,
    setHeader: (name, value) => headers.set(String(name).toLowerCase(), value),
    end: (value = '') => {
      responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      resolveEnded();
    }
  };

  await handleDonnaApiRequest(req, res);
  await ended;
  return {
    statusCode: res.statusCode,
    headers,
    body: responseBody ? JSON.parse(responseBody) : null
  };
};

test(
  'real route + PG: a desktop seed failure creates no client and the retry converges once',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — BF-1 real route lifecycle not exercised' },
  async () => {
    const dbName = `donna_bf1_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorPoolMax = process.env.DATABASE_POOL_MAX;
    const priorDesktopBlobDir = process.env.DONNA_DESKTOP_BLOB_DIR;
    const priorAccessToken = process.env.DONNA_ACCESS_TOKEN;

    try {
      const supabaseOnly = new Set([
        '010_evidence_object_storage.sql',
        '032_lock_down_public_rls.sql',
        '060_procountor_api_key.sql'
      ]);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
      }

      await seed.query(
        `insert into firms (id, name, slug)
         values ($1, 'BF-1 Route Firm', 'bf1-route-firm')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status, access_level)
         values ('bf1-route-owner', $1, 'owner@bf1.example.invalid',
                 'BF-1 Route Owner', 'admin', 'active', 'owner')`,
        [FIRM_ID]
      );
      await seed.query(`
        create function bf1_refuse_client_plane_seed() returns trigger
        language plpgsql as $$
        begin
          raise exception 'BF-1 injected client-plane seed failure' using errcode = 'P0001';
        end;
        $$;
        create trigger bf1_refuse_client_plane_seed
          before insert on client_capability_config
          for each row execute function bf1_refuse_client_plane_seed();
      `);

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '2';
      process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/donna-bf1-test-blobs';
      process.env.DONNA_ACCESS_TOKEN = ACCESS_TOKEN;

      const priorConsoleError = console.error;
      let failed;
      console.error = () => {};
      try {
        failed = await requestClientCreate();
      } finally {
        console.error = priorConsoleError;
      }

      assert.equal(failed.statusCode, 503);
      assert.equal(failed.body.code, 'CLIENT_RUNTIME_INITIALIZATION_FAILED');
      assert.deepEqual(failed.body.details, {
        stage: 'desktop_client_plane_seed',
        client_id: CLIENT_ID,
        retryable: true
      });
      assert.match(failed.body.error, /no client was created/i);

      const afterFailure = await seed.query(
        `select
           (select count(*)::int from clients where firm_id = $1 and id = $2) as clients,
           (select count(*)::int from client_capability_config where firm_id = $1 and client_id = $2) as flags,
           (select count(*)::int from queue_items where firm_id = $1 and client_id = $2) as queue_items,
           (select count(*)::int from audit_events where firm_id = $1 and client_id = $2) as audits`,
        [FIRM_ID, CLIENT_ID]
      );
      assert.deepEqual(afterFailure.rows[0], { clients: 0, flags: 0, queue_items: 0, audits: 0 },
        'the rejected initializer leaves no apparently active client or partial sidecars');

      await seed.query('drop trigger bf1_refuse_client_plane_seed on client_capability_config');
      await seed.query('drop function bf1_refuse_client_plane_seed()');

      const retry = await requestClientCreate();
      assert.equal(retry.statusCode, 200);
      const retriedClient = retry.body.clients.find((client) => client.id === CLIENT_ID);
      assert.ok(retriedClient);
      assert.equal(retriedClient.runtime_readiness.state, 'failed',
        'the real route persists a visible Entity B failure when Host A is absent');

      const replay = await requestClientCreate();
      assert.equal(replay.statusCode, 200);

      const afterRetry = await seed.query(
        `select
           (select count(*)::int from clients where firm_id = $1 and id = $2) as clients,
           (select count(*)::int from client_capability_config
             where firm_id = $1 and client_id = $2 and valid_to is null) as live_flags,
           (select count(distinct flag_key)::int from client_capability_config
             where firm_id = $1 and client_id = $2 and valid_to is null) as distinct_flags,
           (select count(*)::int from queue_items
             where firm_id = $1 and client_id = $2 and id = 'queue-bf1') as queue_items,
           (select count(*)::int from entity_readiness_sagas
             where firm_id = $1 and client_id = $2) as readiness_sagas,
           (select count(*)::int from audit_events
             where firm_id = $1 and client_id = $2
               and action = 'entity.provisioning.attempt') as readiness_attempts`,
        [FIRM_ID, CLIENT_ID]
      );
      assert.deepEqual(afterRetry.rows[0], {
        clients: 1,
        live_flags: DESKTOP_CLIENT_FLAG_SEEDS.length + 1,
        distinct_flags: DESKTOP_CLIENT_FLAG_SEEDS.length + 1,
        queue_items: 1,
        readiness_sagas: 1,
        readiness_attempts: 1
      }, 'retry/replay converges to one client, one readiness saga and one immutable attempt');
      const readinessFlag = await seed.query(
        `select stage, source, reason
           from client_capability_config
          where firm_id = $1 and client_id = $2 and flag_key = $3 and valid_to is null`,
        [FIRM_ID, CLIENT_ID, ENTITY_READINESS_ADMISSION_FLAG]
      );
      assert.deepEqual(readinessFlag.rows, [{
        stage: 'canary',
        source: 'default',
        reason: ENTITY_READINESS_NEW_CLIENT_REASON
      }], 'the twelfth row is the one exact new-client readiness enrollment');
      // The actual deletion + creation routes must restore first-line routing
      // without a one-off model policy, expiry or manual enrollment.
      const deleted = await requestClientCreate('DELETE');
      assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
      assert.equal((await requestClientCreate()).statusCode, 200);
      let calls = 0;
      const env = { DONNA_DESKTOP_BLOB_DIR: '/tmp/donna-bf1-test-blobs', TYPESAFE_MODEL: 'fixture-first-line' };
      const provider = await makeJevTrialProvider({ client: seed, firmId: FIRM_ID, clientId: CLIENT_ID, env,
        provider: async request => { calls += 1; return { model: request.model, answers: {} }; } });
      assert.equal((await provider({ model: env.TYPESAFE_MODEL })).model, env.TYPESAFE_MODEL);
      assert.equal(calls, 1);
      assert.equal((await seed.query('select count(*)::int as n from model_lane_policy')).rows[0].n, 0);
    } finally {
      await __endFirmDbPoolForTests();
      restoreEnv('DATABASE_URL', priorDatabaseUrl);
      restoreEnv('DATABASE_POOL_MAX', priorPoolMax);
      restoreEnv('DONNA_DESKTOP_BLOB_DIR', priorDesktopBlobDir);
      restoreEnv('DONNA_ACCESS_TOKEN', priorAccessToken);
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
);
