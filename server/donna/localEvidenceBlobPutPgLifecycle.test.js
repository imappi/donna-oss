// Local blob PUT — single-connection contract, real PostgreSQL proof.
//
// Regression for the 2026-08-31 desktop freeze: an enforced (readiness-
// admitted) blob PUT held its admission-transaction connection and then
// asked the SAME pool for a second connection to write the blob-index row.
// With DATABASE_POOL_MAX=2 (the shared default) a multi-file drop wedged
// the entire runtime — every upload frozen at "Uploading 0%", every other
// DB-backed request queued behind the dead pool, and the eventual restart
// surfaced as RUNTIME_UNAVAILABLE / write EPIPE on the tray rows.
//
// The proof here is maximal: a ONE-connection pool must be able to absorb
// several concurrent enforced PUTs. If any part of the PUT path ever goes
// back to the pool while holding a connection again, this test fails loudly
// (pool acquisition now times out instead of waiting forever).

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

import { handleDonnaApiRequest } from './api.js';
import { ENTITY_READINESS_ADMISSION_FLAG, setClientFlagStage } from './clientConfig.js';
import { buildDesktopHandlerManifest } from './desktop/handlerManifest.js';
import { createLocalScheduler } from './desktop/localScheduler.js';
import {
  __endFirmDbPoolForTests,
  createClientInDb,
  queryFirmDb,
  withFirmDbClient
} from './firmDb.js';
import { observeHostCertificateA } from './hostCertificateA.js';
import { localEvidenceFetch } from './localEvidencePut.js';
import { persistHostReadinessAttempt, provisionEntityReadiness } from './runtimeReadiness.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM_ID = 'firm-blob-put-pool-pg';
const MEMBER_ID = 'member-blob-put-pool-pg';
const CLIENT_ID = 'client-blob-put-pool-pg';
const ACCESS_TOKEN = 'blob-put-pool-runtime-token';
const CONCURRENT_PUTS = 3;

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const createResponse = (resolve) => {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 200,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* binary response */ }
      resolve({ statusCode: this.statusCode, headers: Object.fromEntries(headers), body, json });
    }
  };
};

const requestApi = async ({ method = 'GET', url, headers = {}, body } = {}) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return new Promise((resolve, reject) => {
    const res = createResponse(resolve);
    Promise.resolve(handleDonnaApiRequest(req, res)).catch(reject);
  });
};

test(
  'real PG/local storage: concurrent enforced blob PUTs drain a ONE-connection pool (nested-acquisition deadlock regression)',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — blob PUT pool regression not exercised' },
  async () => {
    const dbName = `donna_blob_put_pool_${Date.now().toString(36)}_${process.pid}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), 'donna-blob-put-pool-'));
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL);
    scratchUrl.pathname = `/${dbName}`;
    const seed = new pg.Client({ connectionString: scratchUrl.toString() });
    await seed.connect();

    const envKeys = [
      'DATABASE_URL',
      'DATABASE_POOL_MAX',
      'DATABASE_POOL_CONNECT_TIMEOUT_MS',
      'DONNA_DEFAULT_FIRM_ID',
      'DONNA_DESKTOP_BLOB_DIR',
      'DONNA_BUILD_COMMIT_SHA',
      'DONNA_BUILD_DIRTY',
      'DONNA_DESKTOP_SCHEDULER',
      'DONNA_ACCESS_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY'
    ];
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
         values ($1, 'Blob Pool Firm', 'blob-put-pool-firm', 'GB', 'GBP')`,
        [FIRM_ID]
      );
      await seed.query(
        `insert into firm_members (id, firm_id, email, name, role, status)
         values ($1, $2, 'founder@blobpool.test', 'Blob Pool Founder', 'admin', 'active')`,
        [MEMBER_ID, FIRM_ID]
      );

      process.env.DATABASE_URL = scratchUrl.toString();
      process.env.DATABASE_POOL_MAX = '4';
      // Short acquisition timeout: if the PUT path ever re-grows a nested
      // pool acquisition, the starved inner acquire fails in seconds (a
      // loud 500 on the PUT below) instead of deadlocking the test run.
      process.env.DATABASE_POOL_CONNECT_TIMEOUT_MS = '5000';
      process.env.DONNA_DEFAULT_FIRM_ID = FIRM_ID;
      process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
      process.env.DONNA_BUILD_COMMIT_SHA = 'blob-put-pool-build';
      process.env.DONNA_BUILD_DIRTY = 'false';
      process.env.DONNA_DESKTOP_SCHEDULER = 'on';
      process.env.DONNA_ACCESS_TOKEN = ACCESS_TOKEN;
      process.env.OPENAI_API_KEY = 'blob-put-pool-presence-only';
      process.env.ANTHROPIC_API_KEY = 'blob-put-pool-presence-only';

      const manifest = buildDesktopHandlerManifest({ rootDir: ROOT });
      const scheduler = createLocalScheduler({
        manifest,
        client: seed,
        pollIntervalMs: 60 * 60 * 1000
      });
      await scheduler.initialize();
      const observedAt = new Date().toISOString();
      const hostCertificate = await observeHostCertificateA({
        env: process.env,
        rootDir: ROOT,
        observedAt,
        manifest,
        schedulerEnabled: true,
        query: (text, params) => queryFirmDb(text, params)
      });
      assert.equal(hostCertificate.status, 'PASS', JSON.stringify(hostCertificate.checks, null, 2));
      await persistHostReadinessAttempt({
        withFirmDbClientFn: withFirmDbClient,
        certificate: hostCertificate,
        eventType: 'boot'
      });

      await createClientInDb({
        firmId: FIRM_ID,
        profile: {
          id: CLIENT_ID,
          companyName: 'Blob Pool Apiary Ltd',
          jurisdiction: 'GB',
          entityType: 'gb-ltd'
        },
        creationPrincipal: {
          principalType: 'firm_member',
          principalId: MEMBER_ID,
          authoritySource: 'blob_put_pool_pg'
        }
      });
      const ready = await provisionEntityReadiness({
        withFirmDbClientFn: withFirmDbClient,
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        creationPath: 'desktop_firm_intake',
        observedAt,
        initiatingPrincipal: { actor_type: 'firm_member', actor_id: MEMBER_ID },
        authorityBasis: { source: 'blob_put_pool_pg', principal_id: MEMBER_ID }
      });
      assert.equal(ready.row.state, 'ready');

      // Explicit manual canary → the PUT route takes the ENFORCED branch
      // (admission transaction + generation-bound token), which is the
      // branch that deadlocked in production.
      await setClientFlagStage(seed, {
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        flagKey: ENTITY_READINESS_ADMISSION_FLAG,
        stage: 'canary',
        source: 'manual',
        reason: 'blob PUT pool regression',
        actorType: 'firm_member',
        actorId: MEMBER_ID
      });
      assert.equal((await seed.query(
        'select state from entity_readiness_sagas where firm_id = $1 and client_id = $2',
        [FIRM_ID, CLIENT_ID]
      )).rows[0].state, 'ready');

      // Sign the batch up front (signing is cheap and was never the wedge).
      const bodies = Array.from(
        { length: CONCURRENT_PUTS },
        (_, index) => Buffer.from(`concurrent-blob-put-${index}-${'x'.repeat(64)}`)
      );
      const signedUrls = [];
      for (let index = 0; index < CONCURRENT_PUTS; index += 1) {
        const signed = await requestApi({
          method: 'POST',
          url: '/api/donna/firms/documents/upload-url',
          headers: {
            authorization: `Bearer ${ACCESS_TOKEN}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            firm_id: FIRM_ID,
            client_id: CLIENT_ID,
            filename: `burst-${index}.pdf`,
            mime_type: 'application/pdf',
            size: bodies[index].length
          })
        });
        assert.equal(signed.statusCode, 200, signed.body);
        assert.equal(signed.json.provider, 'local_blob');
        signedUrls.push(new URL(signed.json.signed_url, 'http://127.0.0.1'));
      }

      // The storm runs on a pool of ONE. Every enforced PUT must complete
      // holding exactly one connection end to end; a second acquisition
      // anywhere inside the hold starves and fails the assertions below.
      await __endFirmDbPoolForTests();
      process.env.DATABASE_POOL_MAX = '1';

      const puts = await Promise.race([
        Promise.all(signedUrls.map((url, index) => requestApi({
          method: 'PUT',
          url: `${url.pathname}${url.search}`,
          headers: { 'content-type': 'application/pdf' },
          body: bodies[index]
        }))),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('concurrent blob PUTs deadlocked on a one-connection pool')),
            60_000
          );
          timer.unref?.();
        })
      ]);
      for (const [index, put] of puts.entries()) {
        assert.equal(put.statusCode, 200, `PUT ${index}: ${put.body}`);
        assert.ok(put.json?.content_hash, `PUT ${index} returned a content hash`);
      }

      // The Node-side transport (inbound owner media has no origin to fetch
      // from) runs the SAME enforced PUT in-process, still on the pool of one.
      const inProcessBody = Buffer.from(`in-process-blob-put-${'y'.repeat(64)}`);
      const inProcessSigned = await requestApi({
        method: 'POST',
        url: '/api/donna/firms/documents/upload-url',
        headers: { authorization: `Bearer ${ACCESS_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          firm_id: FIRM_ID,
          client_id: CLIENT_ID,
          filename: 'in-process.pdf',
          mime_type: 'application/pdf',
          size: inProcessBody.length
        })
      });
      assert.equal(inProcessSigned.statusCode, 200, inProcessSigned.body);
      const inProcess = await localEvidenceFetch(inProcessSigned.json.signed_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' },
        body: inProcessBody
      });
      assert.equal(inProcess.status, 200);
      const inProcessJson = await inProcess.json();
      assert.ok(inProcessJson.content_hash, 'the in-process PUT returns the same receipt shape');
      assert.equal(inProcessJson.Key, `${inProcessSigned.json.bucket}/${inProcessSigned.json.key}`);
      // and it is not a second door: a GET token or a foreign path is refused loudly
      await assert.rejects(
        localEvidenceFetch('/api/donna/firms/snapshot', { method: 'PUT', body: inProcessBody }),
        (error) => error?.code === 'EVIDENCE_LOCAL_TRANSPORT_UNSUPPORTED'
      );
      const forged = await localEvidenceFetch('/api/donna/evidence-local?token=not-a-token', {
        method: 'PUT',
        body: inProcessBody
      });
      assert.equal(forged.status, 403);

      assert.equal(
        Number((await seed.query('select count(*)::int as blobs from local_evidence_objects')).rows[0].blobs),
        CONCURRENT_PUTS + 1
      );
      assert.equal(
        (await readdir(blobDir, { recursive: true }))
          .filter((file) => String(file).endsWith('.bin')).length,
        CONCURRENT_PUTS + 1
      );
    } finally {
      // A REGRESSED run leaves the pool's clients checked out forever, and a
      // plain pool.end() then waits on them just as forever — turning the
      // failure into a suite hang. Bound the drain so the deadlock reports
      // as this test's own crisp failure instead.
      await Promise.race([
        __endFirmDbPoolForTests(),
        new Promise((resolve) => { setTimeout(resolve, 5000).unref?.(); })
      ]);
      for (const key of envKeys) restoreEnv(key, priorEnv[key]);
      await seed.end().catch(() => {});
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [dbName]
      ).catch(() => {});
      await admin.query(`drop database if exists "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
      await rm(blobDir, { recursive: true, force: true });
    }
  }
);
