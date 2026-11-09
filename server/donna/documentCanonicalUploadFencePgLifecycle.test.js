// One canonical document per (firm, client, bytes), enforced by the database.
//
// `registerDocumentInDb` (parseDocumentsDb.js) collapses a byte-identical
// re-upload onto the canonical row it reads (Layer 2, RT-10). A read-then-insert
// alone cannot hold under concurrency: several simultaneous first uploads of the
// same bytes each read "no canonical" and each insert one. Migration 164 makes
// `documents_firm_client_checksum_idx` a partial UNIQUE index over the collapse
// query's own notion of a canonical row, and the writer turns a lost race into the
// ordinary collapse. Everything here goes through the real upload-url → PUT →
// register routes and the real migration runner on PostgreSQL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadApplianceFixture } from './fixtures/appliance/index.js';
import { deleteDocumentInDb, syncDocumentsAndTransactionsInDb } from './db/documents.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = '164_documents_canonical_checksum_unique';
const TRIALS = 4;
const CONCURRENT = 8;

const canonicalRows = (appliance, clientId, checksum) => appliance.query(
  `select id, parse_status, parse_run_id from documents
    where firm_id = $1 and client_id = $2 and checksum_sha256 = $3
      and duplicate_of is null and parse_status not in ('duplicate_pending', 'failed')`,
  [appliance.firmId, clientId, checksum]
).then((result) => result.rows);

const runMigrations = (appliance) => spawnSync(process.execPath, ['scripts/migrate_firm_db.js'], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: appliance.databaseUrl },
  encoding: 'utf8'
});

test(
  'real PG (appliance): concurrent first uploads of one file leave exactly one canonical document',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const source = loadApplianceFixture('receipt_screwfix');
      const upload = (bytes, filename = 'fence-receipt.pdf') => appliance.uploadDocument({
        clientId, bytes, filename, mimeType: 'application/pdf', documentType: 'receipt'
      });

      await t.test('the byte-hash index is a partial unique index over canonical rows', async () => {
        const rows = (await appliance.query(
          `select indexname, indexdef from pg_indexes
            where tablename = 'documents' and indexname like 'documents_firm_client_checksum%'
            order by indexname`
        )).rows;
        const unique = rows.find((row) => row.indexname === 'documents_firm_client_checksum_idx');
        assert.match(unique?.indexdef || '', /CREATE UNIQUE INDEX/);
        assert.match(unique.indexdef, /duplicate_of IS NULL/);
        assert.match(unique.indexdef, /duplicate_pending/);
        const lookup = rows.find((row) => row.indexname === 'documents_firm_client_checksum_lookup_idx');
        assert.ok(lookup && !/UNIQUE/.test(lookup.indexdef), 'the non-unique lookup index is kept for the other by-checksum readers');
      });

      await t.test(`${TRIALS} trials of ${CONCURRENT} simultaneous identical uploads: one canonical each, the rest collapse`, async () => {
        const perTrial = [];
        for (let trial = 0; trial < TRIALS; trial += 1) {
          const bytes = Buffer.concat([source.bytes, Buffer.from(`\n%fence-trial-${trial}\n`)]);
          const uploads = await Promise.all(Array.from({ length: CONCURRENT }, () => upload(bytes)));
          const checksum = uploads[0].checksum;
          const canonicals = await canonicalRows(appliance, clientId, checksum);
          perTrial.push(canonicals.length);
          if (canonicals.length !== 1) continue; // recorded; asserted across all trials below
          const [canonical] = canonicals;
          assert.equal(canonical.parse_status, 'pending');
          const losers = uploads.filter((u) => u.documentId !== canonical.id);
          for (const loser of losers) {
            const row = await appliance.read.document(loser.documentId);
            assert.equal(row.parse_status, 'skipped', `${loser.documentId}: ${JSON.stringify(row.parse_summary)}`);
            assert.equal(row.duplicate_of, canonical.id);
            assert.equal(row.parse_run_id, null, 'a collapsed duplicate never parses');
            assert.equal(row.parse_summary?.reason, 'duplicate_auto_collapsed');
            assert.equal(loser.registered?.parse_summary?.reason, 'duplicate_auto_collapsed', 'the route answers the collapse');
          }
          const receipts = (await appliance.query(
            `select resource_id from audit_events
              where firm_id = $1 and action = 'document.duplicate.auto_collapsed' and resource_id = any($2::text[])`,
            [firmId, losers.map((u) => u.documentId)]
          )).rows;
          assert.equal(receipts.length, CONCURRENT - 1, 'one collapse receipt per losing upload');
        }
        t.diagnostic(`canonical rows per trial: ${JSON.stringify(perTrial)}`);
        assert.deepEqual(perTrial, Array(TRIALS).fill(1), `canonical rows per trial: ${JSON.stringify(perTrial)}`);
      });

      await t.test(`neighbour: ${CONCURRENT} simultaneous similar-but-different files stay distinct canonicals`, async () => {
        const uploads = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) =>
          upload(Buffer.concat([source.bytes, Buffer.from(`\n%fence-distinct-${i}\n`)]), `fence-distinct-${i}.pdf`)));
        assert.equal(new Set(uploads.map((u) => u.checksum)).size, CONCURRENT);
        for (const u of uploads) {
          const row = await appliance.read.document(u.documentId);
          assert.equal(row.parse_status, 'pending', u.documentId);
          assert.equal(row.duplicate_of, null, u.documentId);
        }
      });

      await t.test('deleting a canonical promotes one heir and points the other collapsed rows at it', async () => {
        const bytes = Buffer.concat([source.bytes, Buffer.from('\n%fence-heir\n')]);
        const first = await upload(bytes);
        const second = await upload(bytes);
        const third = await upload(bytes);
        assert.equal((await appliance.read.document(third.documentId)).duplicate_of, first.documentId);
        await deleteDocumentInDb({ firmId, documentId: first.documentId });
        const canonicals = await canonicalRows(appliance, clientId, first.checksum);
        assert.deepEqual(canonicals.map((row) => row.id), [second.documentId], 'the oldest collapsed row is the heir');
        assert.equal((await appliance.read.document(third.documentId)).duplicate_of, second.documentId);

        // The /documents/sync replacement delete repoints through the same helper.
        const synced = Buffer.concat([source.bytes, Buffer.from('\n%fence-heir-sync\n')]);
        const [a, b, c] = [await upload(synced), await upload(synced), await upload(synced)];
        await syncDocumentsAndTransactionsInDb({ firmId, documents: [], transactions: [], replaceDocumentIds: [a.documentId] });
        assert.equal(await appliance.read.document(a.documentId), null, 'the replaced canonical is gone');
        assert.deepEqual((await canonicalRows(appliance, clientId, a.checksum)).map((row) => row.id), [b.documentId]);
        assert.equal((await appliance.read.document(c.documentId)).duplicate_of, b.documentId);
      });

      await t.test('the migration refuses a database that already holds two canonicals, leaves it untouched, builds after the repair, and re-runs as a no-op', async () => {
        const bytes = Buffer.concat([source.bytes, Buffer.from('\n%fence-legacy\n')]);
        const legacy = await upload(bytes);
        // Rewind to the pre-164 schema and plant the defect the old index allowed.
        await appliance.query(`
          drop index documents_firm_client_checksum_idx;
          alter index documents_firm_client_checksum_lookup_idx rename to documents_firm_client_checksum_idx;
          delete from schema_migrations where version = '${MIGRATION}';
        `);
        const twinId = `${legacy.documentId}-legacy-twin`;
        await appliance.query(
          `insert into documents (id, firm_id, client_id, filename, document_type, status, storage_bucket, storage_object_key, checksum_sha256, parse_status, payload)
           select $1, firm_id, client_id, filename, document_type, status, storage_bucket, storage_object_key || '-twin', checksum_sha256, 'completed', payload
             from documents where firm_id = $2 and id = $3`,
          [twinId, firmId, legacy.documentId]
        );
        const before = await appliance.query('select id, duplicate_of, parse_status, updated_at from documents where firm_id = $1 order by id', [firmId]);

        const refused = runMigrations(appliance);
        assert.notEqual(refused.status, 0, 'the runner exits non-zero');
        assert.match(refused.stderr, /canonical/i);
        assert.match(refused.stderr, new RegExp(legacy.checksum), 'the refusal names the duplicated group');
        assert.match(refused.stderr, /keep the oldest/i, 'the refusal tells the operator the repair');
        const after = await appliance.query('select id, duplicate_of, parse_status, updated_at from documents where firm_id = $1 order by id', [firmId]);
        assert.deepEqual(after.rows, before.rows, 'no row was rewritten');
        const indexes = (await appliance.query(
          "select indexname, indexdef from pg_indexes where tablename = 'documents' and indexname like 'documents_firm_client_checksum%'"
        )).rows;
        assert.deepEqual(indexes.map((row) => row.indexname), ['documents_firm_client_checksum_idx'], 'nothing half-built');
        assert.doesNotMatch(indexes[0].indexdef, /UNIQUE/);
        assert.equal((await appliance.query('select 1 from schema_migrations where version = $1', [MIGRATION])).rows.length, 0);

        // The operator's repair: keep the oldest, remove the rest through the normal delete path.
        await deleteDocumentInDb({ firmId, documentId: twinId });
        const built = runMigrations(appliance);
        assert.equal(built.status, 0, built.stderr);
        assert.match(built.stdout, new RegExp(`Applied ${MIGRATION}\\.sql`));
        const rebuilt = (await appliance.query(
          "select indexdef from pg_indexes where tablename = 'documents' and indexname = 'documents_firm_client_checksum_idx'"
        )).rows[0];
        assert.match(rebuilt.indexdef, /CREATE UNIQUE INDEX/);

        const again = runMigrations(appliance);
        assert.equal(again.status, 0, again.stderr);
        assert.match(again.stdout, new RegExp(`Skipping ${MIGRATION}\\.sql`));
        // The file itself is idempotent too, not only the runner's ledger.
        await appliance.query(readFileSync(path.join(ROOT, 'db', 'migrations', `${MIGRATION}.sql`), 'utf8'));
      });
    } finally {
      await appliance.stop();
    }
  }
);
