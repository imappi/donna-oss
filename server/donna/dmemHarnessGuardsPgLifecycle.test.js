// DMEM-R1 W0 — the harness guards (docs/audit-2026-09-04-memory-re-baseline.md §7;
// plan v1.0 §7 W0 exit gate: "a hostile safety probe proves workers cannot connect
// to or write through the privileged appliance role", "seeded mutations prove the
// harness detects missing scope, state, time, transaction, and dependency
// fences"). Both are EXPECTED TO PASS on this tree — they pin the guard W0 adds,
// not a defect.
//
//   1. INV-24: `bootApplianceForTest` refuses a DONNA_PG_TEST_URL whose cluster
//      matches a recorded appliance fingerprint file — by database OID, cluster
//      system identifier, socket path, data directory, host fingerprint or
//      object-root realpath — and refuses the appliance database NAME with no file
//      at all; the refusal lands BEFORE `create database` (the cluster's database
//      list is unchanged). A file that records a genuinely different cluster lets
//      the boot proceed.
//   2. Seeded mutations: on a fresh scratch database every fence check is empty;
//      one deliberately broken row per fence (scope · state · time · transaction ·
//      dependency), written straight to SQL past every writer, is caught by
//      exactly its check and by no other.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

import {
  APPLIANCE_FINGERPRINT_REFUSED,
  APPLIANCE_FINGERPRINT_SCHEMA,
  applianceFingerprintMatch,
  applianceHarnessSkipReason,
  assertNotApplianceCluster,
  bootApplianceForTest,
  buildApplianceFingerprintRecord,
  observeConnectionFingerprint,
  recordApplianceFingerprint
} from './testSupport/applianceHarness.js';
import { FENCE_NAMES, runFenceChecks } from './testSupport/dmemFixtureSupport.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';

const listDatabases = async () => {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  try {
    return (await admin.query('select datname from pg_database where not datistemplate order by datname')).rows.map((r) => r.datname);
  } finally {
    await admin.end();
  }
};

test('applianceFingerprintMatch decides every dimension deterministically', () => {
  const recorded = {
    schema: APPLIANCE_FINGERPRINT_SCHEMA,
    database_names: ['donna_local'],
    database_oids: ['16400'],
    system_identifiers: ['7000000000000000001'],
    socket_paths: ['/tmp/.s.PGSQL.55433'],
    data_directories: ['/srv/appliance/pgdata'],
    host_fingerprints: [{ hostname: 'mini.local', machine_id: 'abc123' }],
    object_roots: ['/srv/appliance/evidence']
  };
  const clean = { url_database: 'postgres', database_name: 'postgres', databases: [{ name: 'postgres', oid: '5' }], system_identifier: '1', socket_paths: ['/var/run/postgresql/.s.PGSQL.5432'], data_directory: '/var/lib/pg', host: { hostname: 'ci', machine_id: 'zzz' }, object_root_realpath: '/tmp/x' };
  assert.equal(applianceFingerprintMatch(clean, recorded), null, 'a foreign cluster matches nothing');
  assert.equal(applianceFingerprintMatch({ ...clean, url_database: 'donna_local' }, null)?.dimension, 'database name', 'the built-in name refuses without a file');
  assert.equal(applianceFingerprintMatch(clean, recorded, { scratchDbName: 'donna_local' })?.dimension, 'database name');
  assert.equal(applianceFingerprintMatch({ ...clean, databases: [{ name: 'other', oid: '16400' }] }, recorded)?.dimension, 'database OID');
  assert.equal(applianceFingerprintMatch({ ...clean, system_identifier: '7000000000000000001' }, recorded)?.dimension, 'cluster system identifier');
  assert.equal(applianceFingerprintMatch({ ...clean, socket_paths: ['/tmp/.s.PGSQL.55433'] }, recorded)?.dimension, 'socket path');
  assert.equal(applianceFingerprintMatch({ ...clean, data_directory: '/srv/appliance/pgdata' }, recorded)?.dimension, 'data directory');
  assert.equal(applianceFingerprintMatch({ ...clean, host: { hostname: 'x', machine_id: 'abc123' } }, recorded)?.dimension, 'host fingerprint');
  assert.equal(applianceFingerprintMatch({ ...clean, object_root_realpath: '/srv/appliance/evidence' }, recorded)?.dimension, 'object root');
});

test(
  'real PG (appliance): a DSN whose cluster matches the recorded appliance fingerprint is refused before any create database; a foreign record lets the boot proceed',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'donna-fingerprint-'));
    try {
      // The CI cluster, recorded AS IF it were the appliance.
      const { file, record } = await recordApplianceFingerprint({ adminUrl: PG_URL, objectRoot: process.env.DONNA_DESKTOP_BLOB_DIR || null, file: path.join(dir, 'appliance-fingerprint.json') });
      assert.equal(record.schema, APPLIANCE_FINGERPRINT_SCHEMA);
      assert.ok(record.database_oids.length > 0, 'the record carries the cluster database OIDs');
      assert.ok(record.database_names.includes('donna_local'), 'the built-in appliance name is always recorded');
      assert.ok(!record.database_names.includes('postgres'), 'a system database name is never recorded');

      let refused = null;
      await assert.rejects(
        bootApplianceForTest({ applianceFingerprintFile: file }),
        (error) => {
          assert.equal(error.code, APPLIANCE_FINGERPRINT_REFUSED, `refused with the guard code: ${error.message}`);
          assert.ok(['database OID', 'cluster system identifier', 'socket path', 'data directory', 'host fingerprint', 'object root'].includes(error.dimension), `a fingerprint dimension named the refusal: ${error.dimension}`);
          assert.equal(error.source, file);
          refused = error;
          return true;
        }
      );
      // "Before any create database", exactly: the refusal names the scratch
      // database the boot would have provisioned, and it does not exist. (A
      // whole-list before/after comparison is NOT concurrency-safe — another
      // harness boot on the same cluster may add its own scratch database.)
      assert.ok(refused.scratchDbName, 'the refusal names the scratch database it did not create');
      assert.ok(!(await listDatabases()).includes(refused.scratchDbName), 'the refused boot created no database');

      // The built-in NAME refuses with no file at all, without dialling.
      const named = new URL(PG_URL);
      named.pathname = '/donna_local';
      await assert.rejects(
        assertNotApplianceCluster({ adminUrl: named.toString(), file: path.join(dir, 'absent.json') }),
        (error) => error.code === APPLIANCE_FINGERPRINT_REFUSED && error.dimension === 'database name'
      );

      // A record of a genuinely different cluster: the boot proceeds.
      const observed = await observeConnectionFingerprint(PG_URL, { objectRoot: null });
      const foreign = buildApplianceFingerprintRecord({
        ...observed,
        database_name: 'donna_local',
        databases: [{ name: 'donna_local', oid: '999999' }],
        system_identifier: '1',
        socket_paths: ['/nowhere/.s.PGSQL.1'],
        data_directory: '/nowhere/pgdata',
        host: { hostname: 'somewhere-else', machine_id: 'not-this-machine' },
        object_root_realpath: '/nowhere/evidence'
      });
      const foreignFile = path.join(dir, 'foreign.json');
      await writeFile(foreignFile, JSON.stringify(foreign));
      const appliance = await bootApplianceForTest({ applianceFingerprintFile: foreignFile, now: new Date('2026-09-04T09:00:00.000Z') });
      try {
        assert.ok(appliance.firmId.startsWith('eaw-appliance-'), 'the boot minted its isolated firm');
      } finally {
        await appliance.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'real PG (appliance): seeded mutations — every fence check is empty on a fresh book and each catches exactly its seeded row',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-04T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const baseline = await runFenceChecks(appliance.query, { firmId });
      for (const fence of FENCE_NAMES) assert.deepEqual(baseline[fence], [], `${fence} fence is clean on a fresh book`);

      // scope: a rule on this firm naming a client of ANOTHER firm (the FK is satisfied — the fence is not the FK).
      const otherFirm = `${firmId}-other`;
      await appliance.query("insert into firms (id, name, slug, jurisdiction, default_currency) values ($1, 'Other Firm', $1, 'GB', 'GBP')", [otherFirm]);
      await appliance.query("insert into clients (id, firm_id, company_name, jurisdiction) values ($1, $2, 'Other Client Ltd', 'GB')", [`${otherFirm}-client-1`, otherFirm]);
      const scopeRule = `${clientId}-seed-scope-rule`;
      await appliance.query(
        `insert into client_rules (id, firm_id, client_id, rule_type, pattern_text, account_code, status, created_by, payload)
         values ($1, $2, $3, 'merchant_category', 'seeded scope', '6100', 'active', 'human', '{}'::jsonb)`,
        [scopeRule, firmId, `${otherFirm}-client-1`]
      );
      // state: a candidate that claims promotion with nothing minted.
      const stateCandidate = `${clientId}-seed-state-candidate`;
      await appliance.query(
        `insert into memory_candidates (id, firm_id, client_id, candidate_type, status, source, scope, subject, fact)
         values ($1, $2, $3, 'fact', 'promoted', 'seed', 'merchant', 'seeded merchant', 'seeded fact')`,
        [stateCandidate, firmId, clientId]
      );
      // time: a fact whose updated_at precedes its created_at.
      const timeFact = `${clientId}-seed-time-fact`;
      await appliance.query(
        `insert into firm_facts (id, firm_id, scope, subject, fact, provenance, status, created_at, updated_at)
         values ($1, $2, 'firm', 'seeded subject', 'seeded time fact', '{}'::jsonb, 'dismissed', now(), now() - interval '1 day')`,
        [timeFact, firmId]
      );
      // transaction: an ACTIVE mint-shaped rule (payload.source) with no merchant_rule_saved receipt.
      const txnRule = `${clientId}-seed-transaction-rule`;
      await appliance.query(
        `insert into client_rules (id, firm_id, client_id, rule_type, pattern_text, account_code, status, created_by, payload)
         values ($1, $2, $3, 'merchant_category', 'seeded transaction', '6100', 'active', 'ai', '{"source":"ai_batch"}'::jsonb)`,
        [txnRule, firmId, clientId]
      );
      // dependency: a candidate pointing at a fact that does not exist.
      const depCandidate = `${clientId}-seed-dependency-candidate`;
      await appliance.query(
        `insert into memory_candidates (id, firm_id, client_id, candidate_type, status, source, scope, subject, fact, minted_fact_id)
         values ($1, $2, $3, 'fact', 'suggested', 'seed', 'merchant', 'seeded dep', 'seeded dep fact', 'firm-fact-does-not-exist')`,
        [depCandidate, firmId, clientId]
      );

      const seeded = await runFenceChecks(appliance.query, { firmId });
      const ids = (fence) => seeded[fence].map((v) => `${v.table}:${v.id}`).sort();
      assert.deepEqual(ids('scope'), [`client_rules:${scopeRule}`], 'the scope fence catches exactly the cross-firm rule');
      assert.deepEqual(ids('state'), [`memory_candidates:${stateCandidate}`], 'the state fence catches exactly the hollow promotion');
      assert.deepEqual(ids('time'), [`firm_facts:${timeFact}`], 'the time fence catches exactly the inverted clock');
      assert.deepEqual(ids('transaction'), [`client_rules:${txnRule}`], 'the transaction fence catches exactly the receipt-less mint');
      assert.deepEqual(ids('dependency'), [`memory_candidates:${depCandidate}`], 'the dependency fence catches exactly the dangling pointer');
    } finally {
      await appliance.stop();
    }
  }
);
