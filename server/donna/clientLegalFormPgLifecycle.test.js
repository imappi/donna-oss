// BF-2 — real HTTP route + PostgreSQL lifecycle proof for the client legal-form
// identity boundary.
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

import { entityTypeCaptureState } from '../../src/lib/clientAxes.js';
import { handleDonnaApiRequest } from './api.js';
import { __endFirmDbPoolForTests, getClientChatProfileFromDb } from './firmDb.js';
import { gbEntityType } from './gb/entity.js';
import { resolvePackIdForJurisdiction } from './outbound/packs.js';
import { usEntityType } from './us/entity.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIRM_ID = 'firm-bf2';
const ACCESS_TOKEN = 'bf2-route-token';

const restoreEnv = (key, prior) => {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
};

const requestJson = async ({ method = 'GET', url, body = null } = {}) => {
  const encoded = body == null ? '' : JSON.stringify(body);
  const req = Readable.from(encoded ? [Buffer.from(encoded)] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    ...(encoded
      ? {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(encoded))
        }
      : {}),
    'x-donna-access-token': ACCESS_TOKEN
  };

  let responseBody = '';
  let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (value = '') => {
      responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      resolveEnded();
    }
  };

  await handleDonnaApiRequest(req, res);
  await ended;
  return {
    statusCode: res.statusCode,
    body: responseBody ? JSON.parse(responseBody) : null
  };
};

const createClient = ({ id, companyName, jurisdiction, entityType }) =>
  requestJson({
    method: 'POST',
    url: '/api/donna/firms/clients',
    body: {
      firm_id: FIRM_ID,
      profile: { id, companyName, jurisdiction, entityType }
    }
  });

test(
  'real route + PG: US/GB aliases persist canonically, pack routing resolves, and legacy rows have a correction path',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — BF-2 real route lifecycle not exercised' },
  async () => {
    const dbName = `donna_bf2_${Date.now().toString(36)}_${process.pid}`;
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
    const priorStripeKey = process.env.STRIPE_SECRET_KEY;

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
         values ($1, 'BF-2 Route Firm', 'bf2-route-firm')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status, access_level)
         values ('bf2-route-owner', $1, 'owner@bf2.example.invalid',
                 'BF-2 Route Owner', 'admin', 'active', 'owner')`,
        [FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '1';
      process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/donna-bf2-test-blobs';
      process.env.DONNA_ACCESS_TOKEN = ACCESS_TOKEN;
      delete process.env.STRIPE_SECRET_KEY;

      const usCreated = await createClient({
        id: 'bf2-us-llc',
        companyName: 'BF-2 Honeybee LLC',
        jurisdiction: 'US',
        entityType: 'Limited liability company'
      });
      assert.equal(usCreated.statusCode, 200);

      const gbCreated = await createClient({
        id: 'bf2-gb-ltd',
        companyName: 'BF-2 Apiary Limited',
        jurisdiction: 'UK',
        entityType: 'Limited company'
      });
      assert.equal(gbCreated.statusCode, 200);

      const persisted = await seed.query(
        `select id, jurisdiction, entity_type, profile
           from clients
          where firm_id = $1 and id = any($2::text[])
          order by id`,
        [FIRM_ID, ['bf2-us-llc', 'bf2-gb-ltd']]
      );
      const byId = new Map(persisted.rows.map((row) => [row.id, row]));
      const us = byId.get('bf2-us-llc');
      const gb = byId.get('bf2-gb-ltd');
      assert.equal(us.entity_type, 'us-llc');
      assert.equal(us.profile.entityType, 'us-llc');
      assert.equal(usEntityType(us), 'llc');
      assert.equal(resolvePackIdForJurisdiction(us.jurisdiction), 'us');
      assert.equal(gb.jurisdiction, 'GB', 'UK alias is stored as the pack jurisdiction');
      assert.equal(gb.entity_type, 'gb-ltd');
      assert.equal(gbEntityType(gb), 'ltd');
      assert.equal(resolvePackIdForJurisdiction(gb.jurisdiction), 'gb');

      // The snapshot is intentionally a storage view; runtime coding markers
      // are attached only when a model/menu context is built. Exercise that
      // real context boundary so this proves the canonical identity reaches
      // the country-pack router used by production intelligence.
      const usRuntimeProfile = await getClientChatProfileFromDb({
        firmId: FIRM_ID,
        clientId: 'bf2-us-llc'
      });
      const gbRuntimeProfile = await getClientChatProfileFromDb({
        firmId: FIRM_ID,
        clientId: 'bf2-gb-ltd'
      });
      assert.equal(usRuntimeProfile.entity_type, 'us-llc');
      assert.equal(usRuntimeProfile.codingPolicy.jurisdiction, 'us');
      assert.equal(gbRuntimeProfile.entity_type, 'gb-ltd');
      assert.equal(gbRuntimeProfile.codingPolicy.jurisdiction, 'gb');

      const ambiguous = await createClient({
        id: 'bf2-ambiguous-corp',
        companyName: 'BF-2 Ambiguous Corp',
        jurisdiction: 'US',
        entityType: 'Corporation'
      });
      assert.equal(ambiguous.statusCode, 422);
      assert.equal(ambiguous.body.code, 'CLIENT_LEGAL_FORM_AMBIGUOUS');
      assert.deepEqual(ambiguous.body.details.canonical_options, ['us-c-corp', 'us-s-corp']);
      assert.equal(
        Number((await seed.query('select count(*) from clients where id = $1', ['bf2-ambiguous-corp'])).rows[0].count),
        0,
        'ambiguous intake refuses before persistence'
      );

      await seed.query(
        `insert into clients
          (id, firm_id, company_name, entity_type, jurisdiction, status, profile, legal_names)
         values
          ('bf2-legacy-gb', $1, 'BF-2 Legacy Limited', 'Limited company', 'GB', 'active',
           '{"companyName":"BF-2 Legacy Limited","entityType":"Limited company","jurisdiction":"GB"}'::jsonb,
           array['BF-2 Legacy Limited'])`,
        [FIRM_ID]
      );

      const legacySnapshot = await requestJson({
        url: `/api/donna/firms/snapshot?firm_id=${encodeURIComponent(FIRM_ID)}`
      });
      assert.equal(legacySnapshot.statusCode, 200);
      const legacyClient = legacySnapshot.body.clients.find((client) => client.id === 'bf2-legacy-gb');
      const compatibility = entityTypeCaptureState(legacyClient);
      assert.equal(compatibility.show, true);
      assert.equal(compatibility.compatibilityStatus, 'alias');
      assert.equal(compatibility.suggestedEntityType, 'gb-ltd');

      const healed = await requestJson({
        method: 'POST',
        url: '/api/donna/firms/clients/bf2-legacy-gb/profile',
        body: {
          firm_id: FIRM_ID,
          profile_patch: { entity_type: compatibility.suggestedEntityType }
        }
      });
      assert.equal(healed.statusCode, 200);
      const healedRow = (await seed.query(
        `select entity_type, profile->>'entityType' as camel, profile->>'entity_type' as snake
           from clients where firm_id = $1 and id = 'bf2-legacy-gb'`,
        [FIRM_ID]
      )).rows[0];
      assert.deepEqual(healedRow, { entity_type: 'gb-ltd', camel: 'gb-ltd', snake: 'gb-ltd' });
    } finally {
      await __endFirmDbPoolForTests();
      restoreEnv('DATABASE_URL', priorDatabaseUrl);
      restoreEnv('DATABASE_POOL_MAX', priorPoolMax);
      restoreEnv('DONNA_DESKTOP_BLOB_DIR', priorDesktopBlobDir);
      restoreEnv('DONNA_ACCESS_TOKEN', priorAccessToken);
      restoreEnv('STRIPE_SECRET_KEY', priorStripeKey);
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
