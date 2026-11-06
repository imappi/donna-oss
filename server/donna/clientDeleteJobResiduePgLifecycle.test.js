// A deleted client's local_jobs rows must die with it — real PostgreSQL.
//
// local_jobs names its client only inside payload (client_id / clientId), so
// the clients cascade never reaches it, and entityCertificateB's birth residue
// proof counts exactly those rows in every status. 2026-09-08, on the laptop:
// Kampaamo Kultalanka Oy was deleted from the Profile tab and re-created under
// the same deterministic id; the birth failed prior_client_residue:local_jobs
// (31 rows of the deleted life's parse and clock jobs) on cold_create and on
// both boot heals, exhausted, and every upload was refused at upload_sign with
// "Donna is completing a runtime readiness recovery". This fixture births a
// client, gives it job rows in three statuses and both payload spellings,
// deletes it, and proves: zero rows for the id, a neighbour's rows untouched,
// the client.delete receipt carrying the counts, and the certificate snapshot
// the residue proof reads showing no local_jobs residue for a second birth.
//
// Written first and watched fail on the pre-fix tree (31 → 3 rows survived
// the delete; the snapshot counted them; the receipt said nothing).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { enqueueLocalJob } from './desktop/localJobQueue.js';
import { readEntityCertificateSnapshot } from './entityCertificateB.js';
import {
  __endFirmDbPoolForTests,
  createClientInDb,
  deleteClientInDb,
  queryFirmDb
} from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-job-residue-pg';
const MEMBER_ID = 'member-job-residue-pg';
const CLIENT_ID = 'client-job-residue-pg';
const NEIGHBOUR_ID = 'client-job-residue-neighbour';

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const principal = {
  principalType: 'firm_member',
  principalId: MEMBER_ID,
  authoritySource: 'authenticated_firm_create_route'
};

test(
  'real PG: deleting a client purges its payload-keyed local_jobs, receipts the counts, and leaves no birth residue for the same id',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — the delete residue path is not exercised on real PG' },
  async () => {
    const dbName = `donna_job_residue_${Date.now().toString(36)}_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-job-residue-blobs-'));
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DEFAULT_FIRM_ID', 'DONNA_DESKTOP_BLOB_DIR'];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

    try {
      await seed.query(`
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean,
          file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (
          id uuid default gen_random_uuid() primary key,
          bucket_id text references storage.buckets(id), name text, metadata jsonb);
      `);
      const migrations = (await readdir(path.join(ROOT, 'db', 'migrations')))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      for (const file of migrations) {
        await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
        await seed.query(
          'insert into schema_migrations (version) values ($1) on conflict (version) do nothing',
          [file.replace(/\.sql$/, '')]
        );
      }
      await seed.query(
        `insert into firms (id, name, slug, jurisdiction, default_currency)
         values ($1, 'Job Residue Firm', 'job-residue-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@job-residue.test', 'Residue Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      // deleteClientInDb holds one pooled connection for its transaction and
      // reads the post-delete snapshot on another: one connection deadlocks.
      process.env.DATABASE_POOL_MAX = '4';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;

      for (const id of [CLIENT_ID, NEIGHBOUR_ID]) {
        await createClientInDb({
          firmId: FIRM_ID,
          creationPrincipal: principal,
          profile: { id, companyName: `Residue ${id}`, jurisdiction: 'GB', entityType: 'gb-ltd', accounting_system: 'none' }
        });
      }

      // The deleted life's job history: a pending parse job, a succeeded clock
      // tick, a dead one under the other payload spelling — and a neighbour's
      // job that must survive.
      const pending = await enqueueLocalJob({ client: seed, functionId: 'parse-document', payload: { client_id: CLIENT_ID, document_id: 'doc-1' } });
      const succeeded = await enqueueLocalJob({ client: seed, functionId: 'convergence-clock', payload: { client_id: CLIENT_ID } });
      const dead = await enqueueLocalJob({ client: seed, functionId: 'bank-line-disposition', payload: { clientId: CLIENT_ID } });
      const neighbour = await enqueueLocalJob({ client: seed, functionId: 'parse-document', payload: { client_id: NEIGHBOUR_ID, document_id: 'doc-2' } });
      await seed.query(`update local_jobs set status = 'succeeded', completed_at = now() where id = $1`, [succeeded.id]);
      await seed.query(`update local_jobs set status = 'dead', last_error = 'provider dark' where id = $1`, [dead.id]);
      assert.ok(pending && neighbour, 'jobs enqueued');

      // readEntityCertificateSnapshot fans its reads out with Promise.all; a
      // pg.Client is one connection, so serialize them (the certificate script's
      // pattern).
      let queryTail = Promise.resolve();
      const query = (text, params) => {
        const pending = queryTail.then(() => seed.query(text, params));
        queryTail = pending.then(() => undefined, () => undefined);
        return pending;
      };
      const before = await readEntityCertificateSnapshot({ query, firmId: FIRM_ID, clientId: CLIENT_ID });
      assert.equal(before.special_residue.local_jobs, 3, 'the residue proof counts every status and both payload spellings');

      await deleteClientInDb({ firmId: FIRM_ID, clientId: CLIENT_ID, revokeAtProvider: false });

      const remaining = await seed.query(
        `select id, status from local_jobs where payload->>'client_id' = $1 or payload->>'clientId' = $1`,
        [CLIENT_ID]
      );
      assert.equal(remaining.rows.length, 0, `job rows survived the delete: ${JSON.stringify(remaining.rows)}`);
      const neighbourRows = await seed.query(`select id from local_jobs where id = $1`, [neighbour.id]);
      assert.equal(neighbourRows.rows.length, 1, 'the neighbour client keeps its job');

      const receipt = await seed.query(
        `select metadata from audit_events
          where firm_id = $1 and action = 'client.delete' and resource_id = $2
          order by id desc limit 1`,
        [FIRM_ID, CLIENT_ID]
      );
      assert.deepEqual(receipt.rows[0]?.metadata?.local_jobs_purged, {
        total: 3,
        by_status: { pending: 1, succeeded: 1, dead: 1 }
      }, 'the client.delete receipt names what died');

      // The second birth under the same id: the snapshot the residue proof
      // reads carries no local_jobs residue any more.
      await createClientInDb({
        firmId: FIRM_ID,
        creationPrincipal: principal,
        profile: { id: CLIENT_ID, companyName: 'Residue reborn', jurisdiction: 'GB', entityType: 'gb-ltd', accounting_system: 'none' }
      });
      const reborn = await readEntityCertificateSnapshot({ query, firmId: FIRM_ID, clientId: CLIENT_ID });
      assert.equal(reborn.special_residue.local_jobs, 0, 'a re-birth under the same id sees no job residue');
      assert.equal(typeof queryFirmDb, 'function');

      // Receipts belong to one life (2026-09-23 stability lane). The id is
      // reused, and audit_events keep the deleted life's receipts under the
      // same resource_id; the certificate may judge the new life only by
      // receipts written after the delete — plus the one authority purge the
      // delete itself wrote, the reset bridge.
      const deleteId = Number((await seed.query(
        `select max(id) as id from audit_events where firm_id = $1 and action = 'client.delete' and resource_id = $2`,
        [FIRM_ID, CLIENT_ID])).rows[0].id);
      assert.ok(deleteId > 0, 'the delete is receipted');
      assert.deepEqual(reborn.creation_receipts.map(({ id }) => Number(id) > deleteId), [true],
        'exactly one creation receipt, and it is the new life\'s');
      assert.ok(reborn.authority_purge_receipts.length <= 1
        && reborn.authority_purge_receipts.every(({ id }) => Number(id) > deleteId),
      'only the bridging purge written by the delete');
      assert.ok(reborn.profile_receipts.every(({ id }) => Number(id) > deleteId), 'no profile receipt from the deleted life');

      // The hazard itself: a third life whose own creation receipt is missing
      // must not be vouched for by the earlier lives' receipts.
      await deleteClientInDb({ firmId: FIRM_ID, clientId: CLIENT_ID, revokeAtProvider: false });
      await seed.query(
        `insert into clients (id, firm_id, company_name, jurisdiction, entity_type)
         values ($1, $2, 'Residue unreceipted', 'GB', 'gb-ltd')`,
        [CLIENT_ID, FIRM_ID]
      );
      const unreceipted = await readEntityCertificateSnapshot({ query, firmId: FIRM_ID, clientId: CLIENT_ID });
      assert.deepEqual(unreceipted.creation_receipts, [],
        'no creation receipt of an earlier life may stand in for the current life\'s missing one');
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      await seed.end().catch(() => {});
      await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
      await rm(blobDir, { recursive: true, force: true }).catch(() => {});
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
    }
  }
);
