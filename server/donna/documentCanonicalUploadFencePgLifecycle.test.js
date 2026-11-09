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
import { markParseDuplicatePendingInDb } from './parseDocumentsDb.js';
import { PARSE_DOCUMENT_FUNCTION_ID } from './desktop/parseDocumentJob.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = '164_documents_canonical_checksum_unique';
const TRIALS = 4;
const CONCURRENT = 8;
const RETRY_TRIALS = 30;
const RETRY_STAGGER_MS = 0.6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// The other two writers that can make a row canonical again: a manual retry
// of a failed upload (/documents/retry-parse) and the period-overlap resolver
// (/documents/<id>/resolve-duplicate create / replace). Each settles a lost
// race on the index the way /documents/register does — the losing row becomes
// a harmless receipt pointing at the canonical that won — and never hands the
// operator a raw database error.
test(
  'real PG (appliance): retry-parse and resolve-duplicate settle onto the one canonical of their bytes',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const source = loadApplianceFixture('receipt_screwfix');
      const bytesFor = (tag) => Buffer.concat([source.bytes, Buffer.from(`\n%${tag}\n`)]);
      const upload = (bytes, filename = 'fence-receipt.pdf') => appliance.uploadDocument({
        clientId, bytes, filename, mimeType: 'application/pdf', documentType: 'receipt'
      });
      const route = (requestPath, body) => appliance.api.request({
        method: 'POST', path: `/api/donna/firms${requestPath}`, auth: true, body: { firm_id: firmId, ...body }
      });
      const retry = (documentId) => route('/documents/retry-parse', { document_ids: [documentId] });
      const resolve = (documentId, action) =>
        route(`/documents/${encodeURIComponent(documentId)}/resolve-duplicate`, { action });
      const rowsFor = async (checksum) => (await appliance.query(
        `select id, parse_status, duplicate_of, parse_run_id, parse_summary from documents
          where firm_id = $1 and client_id = $2 and checksum_sha256 = $3 order by created_at, id`,
        [firmId, clientId, checksum]
      )).rows;
      const receipts = async (action, ids) => (await appliance.query(
        `select resource_id, metadata from audit_events
          where firm_id = $1 and action = $2 and resource_id = any($3::text[]) order by created_at, id`,
        [firmId, action, ids]
      )).rows;
      const unresolvedOverlapAsks = async (documentId) => (await appliance.read.asks(clientId)).filter((ask) =>
        ask.evidence_type === 'statement_overlap' && ask.request_payload?.document_id === documentId
        && ['draft', 'open', 'replied'].includes(ask.status));
      // A parse that fails deterministically through the real job (a rejected
      // provider key: one attempt, document rests `failed` on the manual retry).
      const failParses = async () => {
        appliance.providers.script('document_routing', [{ recording: 'document_routing/screwfix-receipt', times: Infinity }]);
        appliance.providers.script('unified_extraction', [{
          status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, times: Infinity
        }]);
        await appliance.tick({ functions: [PARSE_DOCUMENT_FUNCTION_ID] });
      };
      // The worker's period-overlap writer turns a parsing canonical into the
      // owner's `duplicate_pending` question (the overlap decision itself is
      // not under test here, so the Jev seam is stubbed out).
      const markOverlap = async (documentId, duplicateOf) => {
        const row = await appliance.read.document(documentId);
        const marked = await markParseDuplicatePendingInDb({
          firmId, documentId, parseRunId: row.parse_run_id, duplicateOf, reason: 'period_overlap',
          existingFilename: 'earlier-statement.pdf', askDeps: { decideJevException: async () => null }
        });
        assert.equal(marked?.parse_status, 'duplicate_pending');
      };

      await t.test('neighbour: an ordinary retry of a failed upload with no competing upload re-queues it', async () => {
        const failed = await upload(bytesFor('retry-alone'));
        await failParses();
        const before = await appliance.read.document(failed.documentId);
        assert.equal(before.parse_status, 'failed', JSON.stringify(before.parse_error));
        const response = await retry(failed.documentId);
        assert.equal(response.status, 200, response.text);
        assert.deepEqual(response.json.skipped, []);
        assert.equal(response.json.documents?.[0]?.id, failed.documentId);
        const after = await appliance.read.document(failed.documentId);
        assert.equal(after.parse_status, 'pending');
        assert.equal(after.duplicate_of, null);
        assert.notEqual(after.parse_run_id, before.parse_run_id, 'a new run');
        assert.equal((await receipts('document.parse.retry', [failed.documentId])).length, 1);
      });

      await t.test(`${RETRY_TRIALS} trials of a retry racing a fresh upload of the same bytes: one canonical, one harmless receipt, no raw error`, async () => {
        const failed = [];
        for (let trial = 0; trial < RETRY_TRIALS; trial += 1) failed.push(await upload(bytesFor(`retry-race-${trial}`)));
        await failParses();
        const outcomes = [];
        for (let trial = 0; trial < RETRY_TRIALS; trial += 1) {
          const { documentId: failedId, checksum } = failed[trial];
          assert.equal((await appliance.read.document(failedId)).parse_status, 'failed');
          // Stagger the retry across the upload's whole register window so the
          // trials cover retry-first, upload-first and the overlap between.
          const [retried, fresh] = await Promise.all([
            sleep(Math.round(trial * RETRY_STAGGER_MS)).then(() => retry(failedId)),
            upload(bytesFor(`retry-race-${trial}`))
          ]);
          assert.equal(retried.status, 200, `trial ${trial}: ${retried.text}`);
          const rows = await rowsFor(checksum);
          assert.equal(rows.length, 2, JSON.stringify(rows));
          const canonicals = rows.filter((row) => row.duplicate_of === null && !['failed', 'duplicate_pending'].includes(row.parse_status));
          assert.equal(canonicals.length, 1, `trial ${trial}: ${JSON.stringify(rows)}`);
          const [canonical] = canonicals;
          assert.equal(canonical.parse_status, 'pending');
          assert.equal(rows.filter((row) => row.parse_status === 'pending').length, 1, 'exactly one row parses these bytes');
          const other = rows.find((row) => row.id !== canonical.id);
          assert.equal(other.duplicate_of, canonical.id, `trial ${trial}: ${JSON.stringify(rows)}`);
          assert.equal(other.parse_run_id === null || other.parse_status === 'failed', true);
          if (canonical.id === failedId) {
            // The retry won: the upload collapsed onto the retried row.
            outcomes.push('retry_won');
            assert.equal(other.id, fresh.documentId);
            assert.equal(other.parse_status, 'skipped');
            assert.equal(other.parse_summary?.reason, 'duplicate_auto_collapsed');
            assert.equal((await receipts('document.duplicate.auto_collapsed', [fresh.documentId])).length, 1);
            assert.equal(retried.json.documents?.[0]?.id, failedId);
          } else {
            // The upload won: the failed row is its superseded receipt and the
            // retry says so instead of re-queuing it.
            outcomes.push('upload_won');
            assert.equal(canonical.id, fresh.documentId);
            assert.equal(other.id, failedId);
            assert.equal(other.parse_status, 'failed');
            assert.equal((await receipts('document.duplicate.failed_upload_superseded', [failedId])).length, 1);
            assert.deepEqual(retried.json.documents, []);
            assert.deepEqual(retried.json.skipped?.map((row) => [row.id, row.reason, row.duplicate_of]),
              [[failedId, 'superseded_by_canonical', fresh.documentId]]);
          }
          assert.equal((await receipts('document.parse.retry', [failedId])).length, outcomes.at(-1) === 'retry_won' ? 1 : 0);
        }
        t.diagnostic(`outcomes: ${JSON.stringify(outcomes)}`);
        assert.ok(outcomes.includes('retry_won') && outcomes.includes('upload_won'), `both orders were exercised: ${JSON.stringify(outcomes)}`);
      });

      await t.test('resolve-duplicate create on a placeholder whose bytes were re-uploaded collapses onto that upload; a retry that loses the index is superseded', async () => {
        const earlier = await upload(bytesFor('overlap-earlier'), 'earlier-statement.pdf');
        const placeholderBytes = bytesFor('overlap-placeholder');
        const placeholder = await upload(placeholderBytes, 'later-statement.pdf');
        const collapsedEarly = await upload(placeholderBytes, 'later-statement.pdf');
        assert.equal((await appliance.read.document(collapsedEarly.documentId)).duplicate_of, placeholder.documentId);
        await markOverlap(placeholder.documentId, earlier.documentId);
        // The owner re-uploads the same file while the question is open. The
        // placeholder is outside the canonical set, so this upload becomes the
        // canonical of those bytes — the shape that made `create` hit the index.
        const reupload = await upload(placeholderBytes, 'later-statement.pdf');
        assert.equal((await appliance.read.document(reupload.documentId)).duplicate_of, null);
        assert.equal((await unresolvedOverlapAsks(placeholder.documentId)).length, 1, 'the overlap question is on the owner');

        const created = await resolve(placeholder.documentId, 'create');
        assert.equal(created.status, 200, created.text);
        assert.equal(created.json.applied, true);
        assert.equal(created.json.parse_run_id, null, 'nothing new parses');
        assert.equal(created.json.event_sent, null);
        assert.equal(created.json.document?.duplicate_of, reupload.documentId);
        const rows = await rowsFor(placeholder.checksum);
        assert.deepEqual(rows.filter((row) => row.duplicate_of === null).map((row) => row.id), [reupload.documentId]);
        const settled = rows.find((row) => row.id === placeholder.documentId);
        assert.equal(settled.parse_status, 'skipped');
        assert.equal(settled.parse_run_id, null);
        assert.equal(settled.parse_summary?.reason, 'duplicate_auto_collapsed');
        assert.equal(settled.parse_summary?.existing_document_id, reupload.documentId);
        assert.equal(rows.find((row) => row.id === collapsedEarly.documentId).duplicate_of, reupload.documentId,
          'the row collapsed onto the placeholder follows it to the canonical');
        const collapseReceipts = await receipts('document.duplicate.auto_collapsed', [placeholder.documentId]);
        assert.equal(collapseReceipts.length, 1);
        assert.equal(collapseReceipts[0].metadata.via, 'resolve_duplicate');
        const [resolution] = await receipts('document.parse.duplicate_resolved', [placeholder.documentId]);
        assert.equal(resolution.metadata.action, 'create');
        assert.equal(resolution.metadata.outcome, 'collapsed_onto_canonical');
        assert.equal(resolution.metadata.collapsed_onto, reupload.documentId);
        assert.deepEqual(resolution.metadata.collapse_repointed_duplicates, { [collapsedEarly.documentId]: reupload.documentId });
        assert.equal(resolution.metadata.owner_asks_resolved, 1);
        assert.deepEqual(await unresolvedOverlapAsks(placeholder.documentId), [], 'the decision closed the question');
        const again = await resolve(placeholder.documentId, 'create');
        assert.equal(again.status, 200, again.text);
        assert.equal(again.json.applied, false, 'idempotent');

        // Neighbour: with no competing canonical, create re-queues the placeholder as before.
        const loneBytes = bytesFor('overlap-lone');
        const lone = await upload(loneBytes, 'lone-statement.pdf');
        await markOverlap(lone.documentId, earlier.documentId);
        // A re-upload that then FAILS leaves an unsuperseded failed row of the
        // same bytes outside the index; create takes the index back.
        const failedTwin = await upload(loneBytes, 'lone-statement.pdf');
        await failParses();
        assert.equal((await appliance.read.document(failedTwin.documentId)).parse_status, 'failed');
        const requeued = await resolve(lone.documentId, 'create');
        assert.equal(requeued.status, 200, requeued.text);
        assert.ok(requeued.json.parse_run_id, 'create minted a run');
        const loneRow = await appliance.read.document(lone.documentId);
        assert.deepEqual([loneRow.parse_status, loneRow.duplicate_of], ['pending', null]);
        // Retrying the failed twin now loses the index to that canonical: it is
        // superseded with the ordinary receipt, never a raw unique violation.
        const lost = await retry(failedTwin.documentId);
        assert.equal(lost.status, 200, lost.text);
        assert.deepEqual(lost.json.documents, []);
        assert.deepEqual(lost.json.skipped?.map((row) => [row.id, row.reason, row.duplicate_of]),
          [[failedTwin.documentId, 'superseded_by_canonical', lone.documentId]]);
        const twin = await appliance.read.document(failedTwin.documentId);
        assert.deepEqual([twin.parse_status, twin.duplicate_of], ['failed', lone.documentId]);
        assert.equal((await receipts('document.duplicate.failed_upload_superseded', [failedTwin.documentId])).length, 1);
        assert.deepEqual((await canonicalRows(appliance, clientId, lone.checksum)).map((row) => row.id), [lone.documentId]);
      });

      await t.test('resolve-duplicate replace promotes one heir of the replaced canonical, points the rest at it, and unwinds its accounting', async () => {
        const earlierBytes = bytesFor('replace-earlier');
        const earlier = await upload(earlierBytes, 'earlier-statement.pdf');
        const heir = await upload(earlierBytes, 'earlier-statement.pdf');
        const sibling = await upload(earlierBytes, 'earlier-statement.pdf');
        const later = await upload(bytesFor('replace-later'), 'later-statement.pdf');
        await markOverlap(later.documentId, earlier.documentId);

        // The replaced statement's consequences: two imported lines, and a bank
        // line elsewhere whose confirmed match points at the statement.
        const imported = [`${earlier.documentId}-line-1`, `${earlier.documentId}-line-2`];
        const bankLine = `${earlier.documentId}-bank-line`;
        const matchId = `${earlier.documentId}-match`;
        await appliance.query(
          `insert into transactions (id, firm_id, client_id, document_id, money_out, status)
           select id, $1, $2, $3, 12.5, 'needs_review' from unnest($4::text[]) as id`,
          [firmId, clientId, earlier.documentId, imported]
        );
        await appliance.query(
          `insert into transactions (id, firm_id, client_id, money_out, status, reconciliation_status, reconciled_at, payload)
           values ($1, $2, $3, 12.5, 'needs_review', 'reconciled', now(), $4::jsonb)`,
          [bankLine, firmId, clientId, JSON.stringify({
            reconciliation_match_id: matchId, reconciliation_match_type: 'document',
            reconciliation_match_object_id: earlier.documentId, reconciliation_status: 'reconciled', support_status: 'kept'
          })]
        );
        await appliance.query(
          `insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, match_amount, status)
           values ($1, $2, $3, $4, 'document', $5, 12.5, 'confirmed')`,
          [matchId, firmId, clientId, bankLine, earlier.documentId]
        );

        const replaced = await resolve(later.documentId, 'replace');
        assert.equal(replaced.status, 200, replaced.text);
        assert.equal(replaced.json.applied, true);
        assert.equal(replaced.json.deleted_document_id, earlier.documentId);
        assert.ok(replaced.json.parse_run_id);

        assert.equal(await appliance.read.document(earlier.documentId), null, 'the replaced statement is gone');
        assert.deepEqual((await canonicalRows(appliance, clientId, earlier.checksum)).map((row) => row.id), [heir.documentId],
          'the oldest collapsed row is the one heir');
        assert.equal((await appliance.read.document(sibling.documentId)).duplicate_of, heir.documentId);
        const laterRow = await appliance.read.document(later.documentId);
        assert.deepEqual([laterRow.parse_status, laterRow.duplicate_of, laterRow.parse_run_id],
          ['pending', null, replaced.json.parse_run_id]);

        assert.deepEqual((await appliance.query('select id from transactions where firm_id = $1 and id = any($2::text[])', [firmId, imported])).rows, [],
          'the imported lines are deleted with their statement');
        assert.deepEqual((await appliance.query('select id from reconciliation_matches where firm_id = $1 and id = $2', [firmId, matchId])).rows, []);
        const [unwound] = (await appliance.query('select reconciliation_status, reconciled_at, payload from transactions where firm_id = $1 and id = $2', [firmId, bankLine])).rows;
        assert.equal(unwound.reconciliation_status, 'needs_review');
        assert.equal(unwound.reconciled_at, null);
        assert.deepEqual(unwound.payload, { support_status: 'kept' }, 'only the match link is stripped');

        const [resolution] = await receipts('document.parse.duplicate_resolved', [later.documentId]);
        assert.equal(resolution.metadata.action, 'replace');
        assert.deepEqual(resolution.metadata.promoted_duplicates, [heir.documentId]);
        assert.deepEqual(resolution.metadata.repointed_duplicates, { [sibling.documentId]: heir.documentId });
        assert.equal(resolution.metadata.deleted_document_id, earlier.documentId);
        assert.equal(resolution.metadata.transactions_deleted, 2);
        assert.equal(resolution.metadata.transaction_matches_unwound, 1);
        assert.equal(resolution.metadata.match_rows_deleted, 1);
        assert.equal(resolution.metadata.outcome, undefined, 'an ordinary replace, not a collapse');
      });
    } finally {
      await appliance.stop();
    }
  }
);
