// Concurrent registrations of one stored file converge on one document.
//
// `registerDocumentInDb` (parseDocumentsDb.js) answers a replayed registration
// of a stored object from its Layer 1 read (storage_object_key match). Two
// registrations of the same stored object that run at the same moment both
// read "nothing yet" and both insert; `documents_storage_object_unique`
// (migration 011) refuses the second. The checksum fence (migration 164, pull
// requests #12 and #17) already turns a lost race on the canonical-bytes index
// into the ordinary collapse; this file proves the storage-object index settles
// the same way: the loser reads the winner and answers it as a replay, with the
// winner's parse run and no receipt of its own.
//
// The ordering is forced, not hoped for. A gate connection holds a SHARE lock
// on `audit_events`, so the first registration inserts its document row and
// then waits, uncommitted, at its receipt. The second registration is started
// only once the first is parked there, and the gate is released only once the
// second is waiting on the first: on its row in the unique index, or (same
// document id) on the writer's per-document lock, before its Layer 1 read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import pg from 'pg';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadApplianceFixture } from './fixtures/appliance/index.js';
import { PARSE_DOCUMENT_FUNCTION_ID } from './desktop/parseDocumentJob.js';

const STRESS_TRIALS = 40;
const STRESS_CONCURRENT = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe, what, { timeoutMs = 15_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

test(
  'real PG (appliance): concurrent registrations of one stored file return one document',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const source = loadApplianceFixture('receipt_screwfix');

      // upload-url → signed PUT: a stored object nobody has registered yet.
      const storeObject = async (tag, bytes = Buffer.concat([source.bytes, Buffer.from(`\n%storage-race-${tag}\n`)])) => {
        const checksum = createHash('sha256').update(bytes).digest('hex');
        const signed = await appliance.api.request({
          method: 'POST', path: '/api/donna/firms/documents/upload-url', auth: true,
          body: { firm_id: firmId, client_id: clientId, filename: `${tag}.pdf`, mime_type: 'application/pdf', size: bytes.length, checksum_sha256: checksum }
        });
        assert.equal(signed.status, 200, JSON.stringify(signed.json));
        const url = new URL(signed.json.signed_url, appliance.baseUrl);
        const put = await appliance.api.request({
          method: 'PUT', path: `${url.pathname}${url.search}`,
          headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: bytes
        });
        assert.equal(put.status, 200, JSON.stringify(put.json));
        return { tag, bytes, checksum, bucket: signed.json.bucket, key: signed.json.key, provider: signed.json.provider };
      };

      const register = (stored, documentId) => appliance.api.request({
        method: 'POST', path: '/api/donna/firms/documents/register', auth: true,
        body: {
          firm_id: firmId,
          documents: [{
            id: documentId,
            client_id: clientId,
            filename: `${stored.tag}.pdf`,
            document_type: 'receipt',
            source: 'firm_intake',
            storage_bucket: stored.bucket,
            storage_object_key: stored.key,
            checksum_sha256: stored.checksum,
            file_storage: {
              mode: 'object_storage', provider: stored.provider, bucket: stored.bucket, key: stored.key,
              checksum_sha256: stored.checksum, filename: `${stored.tag}.pdf`, mime_type: 'application/pdf', size: stored.bytes.length
            }
          }]
        }
      });

      const backends = async () => (await appliance.query(
        `select a.pid, a.query, l.locktype, l.mode
           from pg_stat_activity a
           join pg_locks l on l.pid = a.pid and not l.granted
          where a.datname = current_database()`
      )).rows;

      // Registration A inserts its row, then parks uncommitted at its receipt;
      // registration B runs into A's row in the unique index; then A commits.
      const forceOrder = async (first, second) => {
        const gate = new pg.Client({ connectionString: appliance.databaseUrl });
        await gate.connect();
        try {
          await gate.query('begin');
          await gate.query('lock table audit_events in share mode');
          const a = first();
          const parkedA = await waitFor(async () => (await backends())
            .find((row) => row.locktype === 'relation' && /insert into audit_events/i.test(row.query)), 'the first registration to park at its receipt');
          const b = second();
          // Under another id it runs into the first one's row in the unique
          // index; under the same id it waits for the first before it reads.
          await waitFor(async () => (await backends())
            .find((row) => row.pid !== parkedA.pid && ((row.locktype === 'transactionid' && /insert into documents/i.test(row.query))
              || row.locktype === 'advisory')),
          'the second registration to wait on the first one');
          await gate.query('rollback');
          return await Promise.all([a, b]);
        } finally {
          await gate.end().catch(() => {});
        }
      };

      const documentsAt = async (key) => (await appliance.query(
        `select id, parse_status, parse_run_id, duplicate_of from documents
          where firm_id = $1 and client_id = $2 and storage_object_key = $3`,
        [firmId, clientId, key]
      )).rows;
      const receiptsFor = async (ids) => (await appliance.query(
        `select resource_id, action from audit_events
          where firm_id = $1 and resource_id = any($2::text[])
            and action in ('document.parse.queued', 'document.duplicate.auto_collapsed', 'document.physical_evidence.received')
          order by id`,
        [firmId, ids]
      )).rows;
      const parseJobsFor = async (documentId) => (await appliance.query(
        `select dedupe_key from local_jobs where function_id = $1 and payload::text like $2`,
        [PARSE_DOCUMENT_FUNCTION_ID, `%${documentId}%`]
      )).rows;

      await t.test('a second registration of the stored file under another id, forced to lose: 200 with the winner', async () => {
        const stored = await storeObject('another-id');
        const winnerId = `${clientId}-race-a`;
        const loserId = `${clientId}-race-b`;
        const [a, b] = await forceOrder(() => register(stored, winnerId), () => register(stored, loserId));
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.equal(b.status, 200, `the loser is answered, not a 500: ${JSON.stringify(b.json)}`);
        const won = a.json.documents[0];
        const lost = b.json.documents[0];
        assert.equal(won.id, winnerId);
        assert.equal(lost.id, winnerId, 'the loser returns the document that won');
        assert.equal(lost.parse_run_id, won.parse_run_id, 'the same parse run');
        assert.equal(lost.parse_status, 'pending');

        const rows = await documentsAt(stored.key);
        assert.deepEqual(rows.map((row) => row.id), [winnerId], 'one document for the stored file');
        assert.deepEqual(await receiptsFor([winnerId, loserId]), [{ resource_id: winnerId, action: 'document.parse.queued' }],
          'one registration receipt; the loser claims no document');
        assert.deepEqual((await parseJobsFor(winnerId)).map((row) => row.dedupe_key), [won.parse_run_id], 'one parse job');
        assert.equal((await parseJobsFor(loserId)).length, 0, 'no parse is started for the loser');
      });

      await t.test('the same registration twice (a double tap), forced to overlap: one document, one parse', async () => {
        const stored = await storeObject('double-tap');
        const id = `${clientId}-race-tap`;
        const [a, b] = await forceOrder(() => register(stored, id), () => register(stored, id));
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.equal(b.status, 200, JSON.stringify(b.json));
        assert.equal(b.json.documents[0].id, id);
        assert.equal(b.json.documents[0].parse_run_id, a.json.documents[0].parse_run_id);
        assert.deepEqual((await documentsAt(stored.key)).map((row) => row.id), [id]);
        assert.deepEqual(await receiptsFor([id]), [{ resource_id: id, action: 'document.parse.queued' }]);
        assert.equal((await parseJobsFor(id)).length, 1);
      });

      await t.test('two registrations of a byte twin of a canonical, forced to overlap: one collapsed row, one receipt', async () => {
        const original = await storeObject('twin-original');
        const canonicalId = `${clientId}-race-canonical`;
        const first = await register(original, canonicalId);
        assert.equal(first.status, 200, JSON.stringify(first.json));
        const twin = await storeObject('twin-copy', original.bytes);
        const winnerId = `${clientId}-race-twin-a`;
        const loserId = `${clientId}-race-twin-b`;
        const [a, b] = await forceOrder(() => register(twin, winnerId), () => register(twin, loserId));
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.equal(b.status, 200, `the loser is answered, not a 500: ${JSON.stringify(b.json)}`);
        assert.equal(a.json.documents[0].duplicate_of, canonicalId);
        assert.equal(b.json.documents[0].id, winnerId, 'the loser returns the collapsed row that won');
        assert.equal(b.json.documents[0].duplicate_of, canonicalId);
        assert.equal(b.json.documents[0].parse_run_id, null, 'a collapsed duplicate never parses');

        assert.deepEqual((await documentsAt(twin.key)).map((row) => row.id), [winnerId]);
        assert.deepEqual(await receiptsFor([winnerId, loserId]), [{ resource_id: winnerId, action: 'document.duplicate.auto_collapsed' }],
          'one collapse receipt; the loser writes none');
        assert.equal((await parseJobsFor(winnerId)).length + (await parseJobsFor(loserId)).length, 0);
      });

      // The deadlock the phone's retry found (one 500 in forty trials on a
      // loaded machine), forced. PostgreSQL's report named both sides:
      //   the winner's commit-time convergence settle
      //     (`update documents set convergence_state … where id = X`; never a
      //     HOT update, convergence_state is indexed) adds a documents_pkey
      //     entry for X and waits on the retry's speculative token;
      //   the retry's `insert … on conflict (id) do nothing` passed its id
      //     check before the winner's row existed, holds a speculative
      //     documents_pkey entry for X, and waits on the winner's transaction
      //     in documents_storage_object_unique.
      // The settle only changes convergence_as_of on a new document, so it is
      // a HOT update (no index entry, no wait) unless the row's heap page is
      // full: that, and the timing, is why it was one trial in forty. Forced:
      //   - a gate holds the documents TOAST table (REINDEX inside a
      //     transaction); the retry carries a field too large to store inline,
      //     so it parks there having checked the id;
      //   - the original (small, inline) inserts its row and parks at its
      //     receipt behind the audit gate;
      //   - a filler session fills the rest of that heap page with
      //     uncommitted rows, so the settle's new row version must go to
      //     another page and enter documents_pkey;
      //   - the toast gate opens: the retry runs into the original's row; then
      //     the audit gate opens and the original commits.
      await t.test('a retry that checked the id before the first row existed, forced: the first one\'s commit does not deadlock with it', async () => {
        const stored = await storeObject('settle-deadlock');
        const id = `${clientId}-race-settle`;
        const toast = (await appliance.query(
          "select reltoastrelid::regclass::text as name from pg_class where oid = 'documents'::regclass"
        )).rows[0].name;
        const registerWith = (extra) => appliance.api.request({
          method: 'POST', path: '/api/donna/firms/documents/register', auth: true,
          body: {
            firm_id: firmId,
            documents: [{
              id, client_id: clientId, filename: `${stored.tag}.pdf`, document_type: 'receipt', source: 'firm_intake',
              storage_bucket: stored.bucket, storage_object_key: stored.key, checksum_sha256: stored.checksum,
              file_storage: {
                mode: 'object_storage', provider: stored.provider, bucket: stored.bucket, key: stored.key,
                checksum_sha256: stored.checksum, filename: `${stored.tag}.pdf`, mime_type: 'application/pdf', size: stored.bytes.length
              },
              ...extra
            }]
          }
        });
        const waiting = async (pid) => (await backends()).filter((row) => pid == null || row.pid === pid);
        const toastGate = new pg.Client({ connectionString: appliance.databaseUrl });
        const auditGate = new pg.Client({ connectionString: appliance.databaseUrl });
        const filler = new pg.Client({ connectionString: appliance.databaseUrl });
        await toastGate.connect();
        await auditGate.connect();
        await filler.connect();
        try {
          await auditGate.query('begin');
          await auditGate.query('lock table audit_events in share mode');
          await toastGate.query('begin');
          await toastGate.query(`reindex table ${toast}`);

          // The retry: past its id check, parked storing its large payload.
          const retry = registerWith({ client_note: Array.from({ length: 300 }, (_, i) => createHash('sha256').update(`settle-${i}`).digest('hex')).join('') });
          const retryPark = await waitFor(async () => (await waiting())
            .find((row) => row.locktype === 'relation' && /insert into documents/i.test(row.query)), 'the retry to park after its id check');
          // The original: inserts its row and parks at its receipt (or, once
          // registrations of one document are serialised, waits for the retry).
          const original = registerWith({});
          const originalPark = await waitFor(async () => (await waiting())
            .find((row) => row.pid !== retryPark.pid && (row.locktype === 'advisory'
              || (row.locktype === 'relation' && /insert into audit_events/i.test(row.query)))), 'the original to park');
          // Fill the last heap page (where the original's row went) with
          // small uncommitted rows until one lands on another page.
          await filler.query('begin');
          let firstBlock = null;
          for (let i = 0; i < 400; i += 1) {
            const placed = (await filler.query(
              "insert into documents (id, firm_id, client_id, filename) values ($1, $2, $3, 'f') returning (ctid::text::point)[0]::int as block",
              [`${id}-filler-${i}`, firmId, clientId]
            )).rows[0].block;
            if (firstBlock == null) firstBlock = placed;
            else if (placed !== firstBlock) break;
          }
          await toastGate.query('rollback');
          // The retry runs into the original's row (or, serialised, reaches its own receipt).
          await waitFor(async () => (await waiting(retryPark.pid))
            .find((row) => row.locktype === 'transactionid'
              || (row.locktype === 'relation' && /insert into audit_events/i.test(row.query))), 'the retry to reach the original\'s row or its receipt');
          await auditGate.query('rollback');
          const [r, o] = await Promise.all([retry, original]);
          assert.equal(r.status, 200, `the retry is answered, not a 500: ${JSON.stringify(r.json)}`);
          assert.equal(o.status, 200, `the original is answered, not a 500: ${JSON.stringify(o.json)}`);
          assert.equal(originalPark.locktype, 'advisory', 'the second registration of a document waits for the first, before it reads');
          assert.equal(r.json.documents[0].id, id);
          assert.equal(o.json.documents[0].id, id);
          assert.equal(o.json.documents[0].parse_run_id, r.json.documents[0].parse_run_id, 'the same parse run');
          assert.deepEqual((await documentsAt(stored.key)).map((row) => row.id), [id], 'one document');
          assert.deepEqual(await receiptsFor([id]), [{ resource_id: id, action: 'document.parse.queued' }], 'one receipt');
          assert.equal((await parseJobsFor(id)).length, 1, 'one parse job');
        } finally {
          for (const gate of [toastGate, auditGate, filler]) await gate.query('rollback').catch(() => {});
          for (const gate of [toastGate, auditGate, filler]) await gate.end().catch(() => {});
        }
      });

      await t.test(`${STRESS_TRIALS} trials of ${STRESS_CONCURRENT} simultaneous identical registrations (the phone's shape): all 200, one document each`, async () => {
        const failures = [];
        for (let trial = 0; trial < STRESS_TRIALS; trial += 1) {
          const stored = await storeObject(`stress-${trial}`);
          const id = `${clientId}-race-stress-${trial}`;
          const responses = await Promise.all(Array.from({ length: STRESS_CONCURRENT }, () => register(stored, id)));
          for (const response of responses) {
            if (response.status !== 200) failures.push(`${trial}: ${response.status} ${response.json?.error}`);
          }
          const rows = await documentsAt(stored.key);
          assert.deepEqual(rows.map((row) => row.id), [id], `trial ${trial}`);
          assert.equal(new Set(responses.filter((r) => r.status === 200).map((r) => r.json.documents[0].parse_run_id)).size, 1, `trial ${trial}: one parse run`);
          assert.equal((await receiptsFor([id])).length, 1, `trial ${trial}: one receipt`);
        }
        assert.deepEqual(failures, []);
      });
    } finally {
      await appliance.stop();
    }
  }
);
