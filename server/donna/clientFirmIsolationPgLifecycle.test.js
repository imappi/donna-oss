// BF-3 — real HTTP route + PostgreSQL lifecycle proof for firm-safe client
// identity.
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

import { handleDonnaApiRequest } from './api.js';
import { __endFirmDbPoolForTests } from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const OWNER_FIRM_ID = 'firm-bf3-owner';
const REQUESTER_FIRM_ID = 'firm-bf3-requester';
const CLIENT_ID = 'same-company-123456';
const MEMBER_ID = 'member-bf3-owner';
const ASSIGNMENT_ID = 'assignment-bf3-owner';
const ACCESS_TOKEN = 'bf3-route-token';

const restoreEnv = (key, prior) => {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
};

const requestClientCreate = async ({ firmId, companyName, queueId, idScope }) => {
  const body = JSON.stringify({
    firm_id: firmId,
    id_scope: idScope,
    profile: {
      id: CLIENT_ID,
      companyName,
      uen: '123456',
      jurisdiction: 'US',
      entityType: 'us-llc'
    },
    queue: [{ id: queueId, queue_label: 'Owner intake' }]
  });
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/api/donna/firms/clients';
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
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

test(
  'real route + PG: a second firm cannot reassign a colliding client id or its owner',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — BF-3 real route lifecycle not exercised' },
  async () => {
    const dbName = `donna_bf3_${Date.now().toString(36)}_${process.pid}`;
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
         values
           ($1, 'BF-3 Owner Firm', 'bf3-owner-firm'),
           ($2, 'BF-3 Requester Firm', 'bf3-requester-firm')`,
        [OWNER_FIRM_ID, REQUESTER_FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '2';
      delete process.env.DONNA_DESKTOP_BLOB_DIR;
      process.env.DONNA_ACCESS_TOKEN = ACCESS_TOKEN;

      const ownerCreate = await requestClientCreate({
        firmId: OWNER_FIRM_ID,
        companyName: 'Original Owner LLC',
        queueId: 'queue-bf3-owner'
      });
      assert.equal(ownerCreate.statusCode, 200);
      assert.ok(ownerCreate.body.clients.some((client) => client.id === CLIENT_ID));

      // Give the original client concrete ownership state. The collision must
      // preserve both the clients.firm_id authority boundary and the attached
      // principal assignment, not merely leave a readable client row behind.
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status, access_level)
         values ($1, $2, 'owner@bf3.example', 'BF-3 Owner', 'owner', 'active', 'staff')`,
        [MEMBER_ID, OWNER_FIRM_ID]
      );
      await seed.query(
        `insert into client_assignments
          (id, firm_id, client_id, principal_type, principal_id, role, access_level)
         values ($1, $2, $3, 'firm_member', $4, 'owner', 'staff')`,
        [ASSIGNMENT_ID, OWNER_FIRM_ID, CLIENT_ID, MEMBER_ID]
      );

      const readOriginal = async () => ({
        client: (await seed.query(
          `select id, firm_id, company_name, uen, entity_type, profile, updated_at::text
             from clients where id = $1`,
          [CLIENT_ID]
        )).rows[0],
        assignment: (await seed.query(
          `select id, firm_id, client_id, principal_type, principal_id, role,
                  access_level, assignment_kind, starts_at::text, ends_at::text,
                  updated_at::text
             from client_assignments where id = $1`,
          [ASSIGNMENT_ID]
        )).rows[0]
      });
      const beforeConflict = await readOriginal();

      const conflict = await requestClientCreate({
        firmId: REQUESTER_FIRM_ID,
        companyName: 'Attempted Reassignment LLC',
        queueId: 'queue-bf3-requester'
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.body.code, 'CLIENT_ID_FIRM_CONFLICT');
      assert.deepEqual(conflict.body.details, {
        client_id: CLIENT_ID,
        requested_firm_id: REQUESTER_FIRM_ID,
        correction: 'choose_firm_scoped_client_id'
      });
      assert.doesNotMatch(conflict.body.error, new RegExp(OWNER_FIRM_ID), 'the receipt does not disclose the owning firm');

      const afterConflict = await readOriginal();
      assert.deepEqual(afterConflict, beforeConflict, 'the first firm client and owner assignment are byte-for-byte unchanged');

      const requesterSideEffects = (await seed.query(
        `select
           (select count(*)::int from clients where firm_id = $1 and id = $2) as clients,
           (select count(*)::int from queue_items where firm_id = $1 and client_id = $2) as queue_items,
           (select count(*)::int from audit_events where firm_id = $1 and client_id = $2) as audits,
           (select count(*)::int from client_assignments where firm_id = $1 and client_id = $2) as assignments`,
        [REQUESTER_FIRM_ID, CLIENT_ID]
      )).rows[0];
      assert.deepEqual(requesterSideEffects, {
        clients: 0,
        queue_items: 0,
        audits: 0,
        assignments: 0
      }, 'the refused firm receives no client or client-scoped sidecars');

      const replay = await requestClientCreate({
        firmId: REQUESTER_FIRM_ID,
        companyName: 'Attempted Reassignment LLC',
        queueId: 'queue-bf3-requester'
      });
      assert.deepEqual(replay, conflict, 'repeated collisions return the same stable refusal receipt');
      assert.deepEqual(await readOriginal(), beforeConflict, 'a repeated refusal is also mutation-free');

      // Ordinary web intake may open a separate book for that SAME company.
      // Keep the explicit-ID refusal above: an ID is never transfer authority.
      const intakeArgs = {
        firmId: REQUESTER_FIRM_ID, companyName: 'Original Owner LLC',
        queueId: 'queue-bf3-owner', idScope: 'firm'
      };
      const created = await requestClientCreate(intakeArgs);
      assert.equal(created.statusCode, 200);
      const bookId = created.body.created_client_id;
      assert.ok(bookId);
      assert.notEqual(bookId, CLIENT_ID);
      assert.ok(created.body.clients.some((row) => row.id === bookId));
      assert.deepEqual(await readOriginal(), beforeConflict);
      const readBooks = async () => (await seed.query(
        'select id, firm_id, uen from clients where uen = $1 order by firm_id', ['123456']
      )).rows;
      assert.deepEqual(await readBooks(), [
        { id: CLIENT_ID, firm_id: OWNER_FIRM_ID, uen: '123456' },
        { id: bookId, firm_id: REQUESTER_FIRM_ID, uen: '123456' }
      ]);
      const welcome = (await seed.query(
        'select id, client_id, payload from queue_items where firm_id = $1', [REQUESTER_FIRM_ID]
      )).rows;
      assert.equal(welcome.length, 1);
      assert.notEqual(welcome[0].id, 'queue-bf3-owner');
      assert.equal(welcome[0].client_id, bookId);
      assert.equal(welcome[0].payload.client_id, bookId);
      assert.equal((await seed.query('select firm_id from queue_items where id = $1', ['queue-bf3-owner'])).rows[0].firm_id, OWNER_FIRM_ID);
      assert.equal((await requestClientCreate(intakeArgs)).body.created_client_id, bookId);
      assert.equal((await readBooks()).length, 2, 'retry does not create a third book');
      assert.deepEqual(await readOriginal(), beforeConflict, 'other firm book remains untouched after retry');
      const legacy = await requestClientCreate({
        firmId: OWNER_FIRM_ID, companyName: 'Original Owner LLC',
        queueId: 'queue-bf3-owner', idScope: 'firm'
      });
      assert.equal(legacy.body.created_client_id, CLIENT_ID, 'same-firm legacy book is reused');
      assert.equal((await readBooks()).length, 2);
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
