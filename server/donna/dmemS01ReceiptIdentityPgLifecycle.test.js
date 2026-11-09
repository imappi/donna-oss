// DMEM-R1 W0 — S01, receipt identity (forensic §13.1; docs/audit-2026-09-04-memory-re-baseline.md
// §1 canaries 1–2; ACC-C01, ACC-C02).
//
// RT-10's containment is PINNED. Two similar Screwfix receipts one day apart (distinct
// bytes) and one byte-identical re-upload go through the real routes: the twins
// are distinct documents, the duplicate auto-collapses at register (RT-10), and
// the byte-hash index is unique over canonical rows (migration 164), so a
// concurrent first upload cannot create two (raced through the routes in
// documentCanonicalUploadFencePgLifecycle.test.js). The live Exxon case — when every line × document
// edge is `suggested` and the firm confirms ONE, the crossed suggestions used to
// survive the single-link confirm (`updateReconciliationMatchInDb`, db/reconcile.js)
// and a surviving `suggested` edge suppresses the evidence ask on its line
// (db/asks.js). FI-04 (DMEM-R1 W4) flipped L1: the single confirm now retires
// them under the group pairing's contract (retireCrossedSuggestionsWithClient).

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';
import { layerMessage, seedBankLine } from './testSupport/dmemFixtureSupport.js';
import { loadApplianceFixture } from './fixtures/appliance/index.js';
import { updateReconciliationMatchInDb } from './firmDb.js';

const S = 'S01';
export const S01_FINGERPRINTS = Object.freeze({
  L1: layerMessage(S, 1, 'confirming one edge retires the crossed suggested edges on its line and on its document in the same transaction'),
  L1b: layerMessage(S, 1, 'the byte-hash index on documents (firm_id, client_id, checksum_sha256) is unique, so a concurrent first upload cannot create two rows')
});

// The second twin: the same receipt a day later with a different till number —
// the recording body patched the way a real second receipt would differ.
const shiftedExtraction = () => {
  const recording = loadRecording('unified_extraction/screwfix-receipt');
  const body = JSON.parse(JSON.stringify(recording.body));
  const text = body.content[0].text.split('2026-08-22').join('2026-08-23').split('4471-2208-0193').join('4471-2308-0217');
  body.content[0].text = text;
  return { status: recording.status, body };
};

test(
  'real PG (appliance, DMEM S01): twins are distinct and the duplicate collapses; a single-link confirm retires its crossed suggested edges',
  { skip: applianceHarnessSkipReason() },
  async (t) => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    try {
      const { firmId } = appliance;
      const { clientId } = await appliance.createClient();
      const lineA = await seedBankLine(appliance.query, { firmId, clientId, id: `${clientId}-tx-screwfix-a`, date: '2026-08-22', description: 'SCREWFIX DIRECT LTD', moneyOut: 42.99 });
      const lineB = await seedBankLine(appliance.query, { firmId, clientId, id: `${clientId}-tx-screwfix-b`, date: '2026-08-23', description: 'SCREWFIX DIRECT LTD', moneyOut: 42.99 });

      appliance.providers.script('document_routing', ['document_routing/screwfix-receipt', 'document_routing/screwfix-receipt']);
      appliance.providers.script('unified_extraction', ['unified_extraction/screwfix-receipt', shiftedExtraction()]);
      appliance.providers.script('reconciliation_reasoning', ['reconciliation_reasoning/no-plausible-match', 'reconciliation_reasoning/no-plausible-match']);
      appliance.providers.script('document_disposition', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'document disposition is not what this fixture proves' } }, times: Infinity }]);
      appliance.providers.script('transaction_coding', [{ status: 418, body: { error: { type: 'fixture_lane_dark', message: 'coding is not what this fixture proves' } }, times: Infinity }]);
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const source = loadApplianceFixture('receipt_screwfix');
      const twinBytes = Buffer.concat([source.bytes, Buffer.from('\n%dmem-w0-twin-2026-08-23\n')]);
      const docA = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
      const docB = await appliance.uploadDocument({ clientId, bytes: twinBytes, filename: 'screwfix-receipt-2026-08-23.pdf', mimeType: 'application/pdf', documentType: 'receipt' });
      const tick = await appliance.tick();
      const rowA = await appliance.read.document(docA.documentId);
      const rowB = await appliance.read.document(docB.documentId);
      assert.equal(rowA.parse_status, 'completed', JSON.stringify({ parse: rowA.parse_error, jobs: tick.jobs.map((j) => [j.function_id, j.status, j.last_error]), calls: appliance.providers.calls.map((c) => [c.lane, c.status]) }));
      assert.equal(rowB.parse_status, 'completed', JSON.stringify({ parse: rowB.parse_error }));

      await t.test('L1a database state — similar twins are distinct documents; a byte-identical re-upload collapses (RT-10)', async () => {
        assert.notEqual(rowA.checksum_sha256, rowB.checksum_sha256, layerMessage(S, 1, 'the twins carry distinct byte hashes'));
        assert.equal(String(rowB.document_date).slice(0, 10), '2026-08-23', layerMessage(S, 1, 'the second twin is a day later'));
        const duplicate = await appliance.uploadDocument({ clientId, fixture: 'receipt_screwfix' });
        const dupRow = await appliance.read.document(duplicate.documentId);
        assert.equal(dupRow.parse_status, 'skipped', layerMessage(S, 1, `the byte-identical re-upload is collapsed at register: ${JSON.stringify(dupRow.parse_summary)}`));
        assert.equal(dupRow.duplicate_of, docA.documentId, layerMessage(S, 1, 'the collapse points at the canonical document'));
      });

      await t.test('L1b database state — the byte-hash identity is enforced by a unique index', async () => {
        const index = (await appliance.query("select indexdef from pg_indexes where tablename = 'documents' and indexname = 'documents_firm_client_checksum_idx'")).rows[0];
        assert.ok(index, layerMessage(S, 1, 'the checksum index exists (migrations 011, 164)'));
        assert.match(index.indexdef, /CREATE UNIQUE INDEX/, S01_FINGERPRINTS.L1b);
      });

      // ── The live Exxon state: every line × document edge suggested. ──
      // A third same-amount line carries a lone suggestion to docA only (the
      // 2×1 tie): once docA is confirmed elsewhere that edge is dead and was the
      // line's ONLY edge, so its retirement is what makes the line askable again.
      const lineC = await seedBankLine(appliance.query, { firmId, clientId, id: `${clientId}-tx-screwfix-c`, date: '2026-08-24', description: 'SCREWFIX DIRECT LTD', moneyOut: 42.99 });
      const insertSuggested = async (line, doc) => {
        const id = `${line}-${doc}-suggested`;
        await appliance.query(
          `insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, match_amount, match_confidence, match_reason, status, created_by, payload)
           values ($1, $2, $3, $4, 'document', $5, 42.99, 0.71, 'same amount one day apart', 'suggested', 'system', '{"source":"dmem_w0_crossed_edges"}'::jsonb)`,
          [id, firmId, clientId, line, doc]
        );
        return id;
      };
      const edges = [];
      for (const [line, doc] of [[lineA, docA.documentId], [lineA, docB.documentId], [lineB, docA.documentId], [lineB, docB.documentId]]) {
        edges.push(await insertSuggested(line, doc));
      }
      const loneEdge = await insertSuggested(lineC, docA.documentId);
      await updateReconciliationMatchInDb({ firmId, matchId: edges[0], patch: { status: 'confirmed', reviewer_note: 'This receipt is the 22 Aug payment.' }, actorId: 'dmem-w0', returnSnapshot: false });
      const after = (await appliance.read.matches(clientId)).filter((row) => edges.includes(row.id) || row.id === loneEdge);
      const statusOf = (id) => after.find((row) => row.id === id)?.status;

      await t.test('L1 database state — a single-link confirm retires the crossed suggestions', async () => {
        assert.equal(statusOf(edges[0]), 'confirmed', layerMessage(S, 1, 'the chosen edge is confirmed'));
        const crossed = after.filter((row) => row.id !== edges[0] && (row.bank_transaction_id === lineA || row.matched_object_id === docA.documentId));
        assert.deepEqual(crossed.map((row) => [row.id, row.status]), crossed.map((row) => [row.id, 'rejected']), S01_FINGERPRINTS.L1);
        assert.equal(statusOf(edges[3]), 'suggested', layerMessage(S, 1, 'the valid remaining pairing (line B ↔ receipt B) stays live'));
        const receipts = (await appliance.read.audit({ clientId, action: 'reconciliation_match.update' }))
          .filter((row) => row.metadata?.reason === 'crossed_suggestion_retired');
        assert.deepEqual(
          receipts.map((row) => row.resource_id).sort(),
          [edges[1], edges[2], loneEdge].sort(),
          layerMessage(S, 1, 'each retired edge carries its own crossed_suggestion_retired receipt')
        );
        assert.ok(receipts.every((row) => row.metadata.confirmed_match_id === edges[0] && row.actor_id === 'dmem-w0'), layerMessage(S, 1, 'the receipts name the confirm and its actor'));
      });

      await t.test('L2 ask surface — every remaining line stays actionable (no dead suggestion suppresses its ask)', async () => {
        // The ask gather skips a line holding a live suggested/settled match
        // (db/asks.js). A live match on a remaining line must therefore point
        // at a document nobody has settled; a line with none is askable.
        const live = (await appliance.query(
          `select m.bank_transaction_id, m.matched_object_id,
                  exists (select 1 from reconciliation_matches s
                           where s.matched_object_id = m.matched_object_id
                             and s.status in ('auto_matched', 'confirmed')) as document_settled
             from reconciliation_matches m
            where m.firm_id = $1 and m.client_id = $2 and m.bank_transaction_id = any($3::text[])
              and m.status in ('suggested', 'auto_matched', 'confirmed')`,
          [firmId, clientId, [lineB, lineC]]
        )).rows;
        assert.deepEqual(live.map((row) => [row.bank_transaction_id, row.matched_object_id]), [[lineB, docB.documentId]], layerMessage(S, 2, 'line B keeps only its valid pairing; line C keeps nothing dead'));
        assert.equal(live[0].document_settled, false, layerMessage(S, 2, 'line B\'s remaining suggestion points at a receipt no line has settled'));
      });

      await t.test('L1 neighbour — an instalment split is not crossed: a part-paid invoice keeps its other line live', async () => {
        const invoiceId = `${clientId}-doc-split-invoice`;
        await appliance.query(
          `insert into documents (id, firm_id, client_id, filename, document_type, status, parse_status, customer_name, total_amount, currency, document_date, payment_status, payload)
           values ($1, $2, $3, 'split-invoice.pdf', 'sales_invoice', 'received', 'completed', 'Split Customer Ltd', 100, 'GBP', '2026-08-01', 'unpaid', '{}'::jsonb)`,
          [invoiceId, firmId, clientId]
        );
        const first = await seedBankLine(appliance.query, { firmId, clientId, id: `${clientId}-tx-split-1`, date: '2026-08-10', description: 'SPLIT CUSTOMER LTD', moneyIn: 50 });
        const second = await seedBankLine(appliance.query, { firmId, clientId, id: `${clientId}-tx-split-2`, date: '2026-08-24', description: 'SPLIT CUSTOMER LTD', moneyIn: 50 });
        const splitEdges = [];
        for (const line of [first, second]) {
          const id = `${line}-split-suggested`;
          await appliance.query(
            `insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, match_amount, match_confidence, match_reason, status, created_by, payload)
             values ($1, $2, $3, $4, 'sales_invoice', $5, 50, 0.7, 'instalment', 'suggested', 'system', '{}'::jsonb)`,
            [id, firmId, clientId, line, invoiceId]
          );
          splitEdges.push(id);
        }
        await updateReconciliationMatchInDb({ firmId, matchId: splitEdges[0], patch: { status: 'confirmed' }, actorId: 'dmem-w0', returnSnapshot: false });
        const rows = (await appliance.read.matches(clientId)).filter((row) => splitEdges.includes(row.id));
        assert.deepEqual(splitEdges.map((id) => rows.find((row) => row.id === id).status), ['confirmed', 'suggested'], layerMessage(S, 1, 'the second instalment stays a live suggestion'));
        const invoice = await appliance.read.document(invoiceId);
        assert.equal(invoice.payment_status, 'partial', layerMessage(S, 1, 'the invoice is part-paid, so it is not consumed'));
      });

      await t.test('L3 receipt — the confirm is receipted with its actor', async () => {
        const receipts = (await appliance.read.audit({ clientId, action: 'reconciliation_match.update' })).filter((row) => row.resource_id === edges[0]);
        assert.ok(receipts.length >= 1, layerMessage(S, 3, 'the confirm wrote its audit receipt'));
      });

      await t.test('L4 accounting outcome — the confirmed line is reconciled; the persisted column names its honest rest (matched, uncoded)', async () => {
        const line = (await appliance.read.transactions(clientId)).find((tx) => tx.id === lineA);
        assert.equal(line.reconciliation_status, 'reconciled', layerMessage(S, 4, 'the confirmed line is reconciled'));
        // The coder was scripted dark, so the line is matched but never coded: the
        // persisted two-terminal verdict (RT-13/RT-17) says so — read from the
        // column, never re-derived here.
        assert.equal(line.convergence_state, 'hanging', layerMessage(S, 4, `the persisted column carries the verdict: ${line.convergence_reason}`));
        assert.equal(line.convergence_reason, 'matched_but_uncoded', layerMessage(S, 4, 'a matched, uncoded line rests hanging under its own reason key'));
      });
    } finally {
      await appliance.stop();
    }
  }
);
