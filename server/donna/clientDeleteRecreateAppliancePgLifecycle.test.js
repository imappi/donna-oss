// Delete → re-create is boring — real PostgreSQL, the real desktop path
// (stability lane, docs/finding-2026-09-23-delete-recreate-stability.md §7).
//
// Kari, 2026-09-23: "Every time I delete an org, re-create it, I have some
// runtime issues. This is more like a rule rather than exception." This
// fixture drives ONE company through two lives under the SAME client id (ids
// are deterministic, so every re-create reuses the deleted id):
//
//   life 1: create → readiness ready → bank statement upload → parse → the
//           batch coder codes both lines;
//   delete through the real DELETE route;
//   life 2: re-create the same id → readiness ready → the SAME statement
//           bytes again → parse → both lines coded.
//
// It fails on any residue (a deleted life's row, job or authority surviving),
// on any hanging state (a refused admission, a non-completed parse, a
// duplicate-collapsed re-upload, an uncoded line, a parse job not succeeded),
// and on the certificate judging the new life by the old life's receipts.
//
// Scope, stated honestly: this is the DESKTOP runtime (Host A local, the local
// scheduler). The hosted-only links — Supabase storage upload intents, the
// cloud Host A dependency proofs — are covered by their own cloud suites and
// by P1; everything shared (delete writer, birth certificate, saga, admission,
// parse, coder, convergence) runs here for real.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';
import { loadRecording } from './testSupport/recordedProviders.js';

const CODING_RECORDING = 'transaction_coding/kestrel-two-lines-coded';

const codingRecordingFor = ({ payoutTransactionId, ochreTransactionId }) => {
  const recording = loadRecording(CODING_RECORDING);
  const body = JSON.parse(JSON.stringify(recording.body));
  const text = body.output[0].content[0].text;
  body.output[0].content[0].text = text
    .split('__TX_PAYOUT__').join(payoutTransactionId)
    .split('__TX_OCHRE__').join(ochreTransactionId);
  return { status: recording.status, body };
};

test(
  'real PG (appliance): delete → re-create the same company leaves no residue and no hanging state; the new life reaches coded lines again',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-08-31T09:00:00.000Z') });
    const firmId = appliance.firmId;
    const clientId = `${firmId}-client-1`;
    const count = async (sql, params) => Number((await appliance.query(sql, params)).rows[0].n);

    // One life: upload the two-line statement, tick, and prove it parsed and
    // both lines carry the coder's verdict. Returns the life's document id.
    const liveOneLife = async (label) => {
      appliance.providers.reset();
      appliance.providers.script('document_routing', ['document_routing/kestrel-bank-statement']);
      appliance.providers.script('bank_statement_extraction', ['bank_statement_extraction/kestrel-barclays-two-lines']);
      appliance.providers.script('bank_line_disposition', [
        'bank_line_disposition/kestrel-ochre-debit-chase-receipt',
        'bank_line_disposition/kestrel-paylink-credit-chase-evidence'
      ]);
      appliance.providers.script('ask_drafting', [{ status: 503, times: Infinity }]);
      const statement = await appliance.uploadDocument({ clientId, fixture: 'bank_statement_two_lines' });
      assert.equal(statement.registered?.parse_status, 'pending', `${label}: the upload was admitted and registered`);
      const payoutTransactionId = `${statement.documentId}-tx-0`;
      const ochreTransactionId = `${statement.documentId}-tx-1`;
      appliance.providers.script('transaction_coding', [codingRecordingFor({ payoutTransactionId, ochreTransactionId })]);

      const tick = await appliance.tick();
      const document = await appliance.read.document(statement.documentId);
      assert.equal(document.parse_status, 'completed', `${label}: ${JSON.stringify({
        stage: document.parse_stage, error: document.parse_error, summary: document.parse_summary?.reason,
        jobs: tick.jobs.map((j) => [j.function_id, j.status, j.last_error])
      })}`);
      const parseJobs = (await appliance.read.jobs({ functionId: 'parse-document' }))
        .filter((job) => job.dedupe_key === statement.registered.parse_run_id);
      assert.deepEqual(parseJobs.map((job) => job.status), ['succeeded'], `${label}: exactly one parse job, succeeded`);

      const lines = await appliance.read.transactions(clientId);
      assert.deepEqual(lines.map((tx) => tx.id).sort(), [payoutTransactionId, ochreTransactionId].sort(),
        `${label}: exactly this life's two lines`);
      for (const tx of lines) {
        assert.ok(tx.payload?.ai_suggestion?.proposed_account, `${label}: line ${tx.id} is coded`);
        assert.ok(tx.coding_state, `${label}: line ${tx.id} carries a coding state`);
      }
      return statement.documentId;
    };

    try {
      // ── Life 1 ──
      const first = await appliance.createClient({ id: clientId });
      assert.equal(first.readiness?.state, 'ready', `life 1 birth: ${JSON.stringify(first.readiness)}`);
      const firstDocumentId = await liveOneLife('life 1');

      // ── Delete through the real route ──
      const deleted = await appliance.api.request({
        method: 'DELETE',
        path: `/api/donna/firms/clients/${encodeURIComponent(clientId)}?firm_id=${encodeURIComponent(firmId)}`,
        auth: true
      });
      assert.equal(deleted.status, 200, `DELETE client: ${JSON.stringify(deleted.json)}`);
      const deleteReceipt = (await appliance.read.audit({ action: 'client.delete' }))
        .filter((row) => row.resource_id === clientId).at(-1);
      assert.ok(deleteReceipt, 'the delete is receipted');

      // Nothing of life 1 survives under the id.
      for (const table of ['documents', 'transactions', 'entity_readiness_sagas', 'client_capability_config',
        'reconciliation_authority_grants', 'client_evidence_requests', 'transaction_review_queue']) {
        assert.equal(await count(`select count(*) as n from ${table} where firm_id = $1 and client_id = $2`, [firmId, clientId]), 0,
          `residue: ${table} still holds life 1 rows`);
      }
      assert.equal(await count(
        `select count(*) as n from local_jobs where payload->>'client_id' = $1 or payload->>'clientId' = $1`, [clientId]), 0,
      'residue: life 1 jobs survived the delete');

      // ── Life 2: the same id ──
      const second = await appliance.createClient({ id: clientId });
      assert.equal(second.readiness?.state, 'ready', `life 2 birth (no residue, no exhaustion): ${JSON.stringify(second.readiness)}`);
      assert.equal(second.readiness?.retry_state, 'idle', 'life 2 is born ready, not recovering');
      assert.ok(second.flags.some((row) => row.flag_key === 'DOCUMENT_EXTRACTORS_ENABLED'), 'life 2 re-staged its flags at birth');

      // The certificate judged the new life by the new life's receipts: the
      // creation receipt it reads (the latest for this resource) was written
      // after the delete, and the saga's attempt is a fresh one.
      const creates = (await appliance.read.audit({ action: 'client.create' })).filter((row) => row.resource_id === clientId);
      assert.equal(creates.length, 2, 'one client.create per life');
      assert.ok(Number(creates.at(-1).id) > Number(deleteReceipt.id), 'the judged creation receipt belongs to life 2');
      const attempt = (await appliance.query('select metadata from audit_events where id = $1',
        [second.readiness.latest_attempt_id])).rows[0]?.metadata;
      assert.ok(Number(second.readiness.latest_attempt_id) > Number(deleteReceipt.id), 'the ready verdict is a life-2 attempt');
      assert.notEqual(attempt?.saga_id, undefined, 'the attempt names its saga');

      const secondDocumentId = await liveOneLife('life 2');
      assert.notEqual(secondDocumentId, firstDocumentId, 'life 2 has its own document');

      // No admission refusal anywhere in life 2.
      const refusals = (await appliance.read.audit({ clientId, action: 'runtime.readiness_admission_blocked' }))
        .filter((row) => Number(row.id) > Number(deleteReceipt.id));
      assert.deepEqual(refusals.map((row) => [row.metadata?.boundary, row.metadata?.reason_code]), [],
        'life 2 was never refused at an admission boundary');
    } finally {
      await appliance.stop();
    }
  }
);
