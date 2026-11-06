// Ask lifecycle honesty (RT-11, docs/plan-2026-09-01-runtime-refactor-slices.md;
// audit F-17 / F-16, decisions D3 + D4) — real PostgreSQL lifecycle proof.
//
// Three laws, each proven on the real joins rather than a mock:
//   (a) D3 — a document AUTO-MATCH answers only the asks that asked for that
//       evidence (supporting_document / bank_statement). A purpose question
//       stays OPEN and the match is recorded on it (request_payload) so the
//       drafter can shorten the question. Round-4 §B: Feb-16 Union Coop and
//       Feb-19 Amazon "wholly for the café rather than personal?" asks were
//       "answered" by an amount-matched receipt.
//   (b) D4 — Donna's own auto_explain ("clearly business, immaterial") retracts
//       an open purpose/document ask on the same line — receipted
//       (client_evidence_request.retracted) — when RECONCILE_AUTO_EXPLAIN_RETRACTS
//       acts; a shadow row only receipts the would-retract; no row does nothing.
//   (c) the #1959 treatment — a drafted ask whose line Donna auto-explained
//       between draft and send goes STALE at send (superseded_before_send +
//       ASK_BATCH_STALE), so the batch never mints a question about a line
//       Donna already settled; and the draft gather never admits such a line.

import test from 'node:test';
import {askBatchStaleness} from '../../src/lib/askBatchView.js';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { cascadeAutoMatch } from './reconciliationTriage.js';
import {
  AUTO_EXPLAIN_RETRACTS_FLAG_KEY,
  EVIDENCE_RESOLVABLE_ASK_TYPES,
  retractAsksSettledByAutoExplain
} from './reconciliationTwinAging.js';
import { readClientConfigSnapshot, setClientFlagStage } from './clientConfig.js';
import { BANK_LINE_DISPOSITION_FAMILY, BANK_LINE_DISPOSITION_TARGET_TYPE } from './bankLineDispositionShape.js';
import {
  __draftClientAskBatchWithClient,
  sendClientAskBatchInDb,
  withFirmDbClient,
  __endFirmDbPoolForTests
} from './firmDb.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRM = 'firm-asklife';
const CLIENT = 'client-asklife';

const bootScratchDatabase = async () => {
  const dbName = `donna_asklife_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const scratchUrl = new URL(PG_URL);
  scratchUrl.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: scratchUrl.toString() });
  await seed.connect();
  const supabaseOnly = new Set([
    '010_evidence_object_storage.sql',
    '032_lock_down_public_rls.sql',
    '060_procountor_api_key.sql'
  ]);
  const files = (await readdir(path.join(ROOT, 'db', 'migrations')))
    .filter((file) => file.endsWith('.sql') && !supabaseOnly.has(file))
    .sort();
  for (const file of files) {
    await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
  }
  await seed.query(`insert into firms (id, name, slug) values ($1, 'Ask Lifecycle Firm', 'ask-lifecycle-firm')`, [FIRM]);
  await seed.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'Ask Lifecycle Client')`, [CLIENT, FIRM]);
  const stop = async () => {
    await seed.end().catch(() => {});
    await admin.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  };
  return { seed, scratchUrl: scratchUrl.toString(), stop };
};

const insertTransaction = (seed, { id, description, moneyOut, status = 'pending', payload = {} }) => seed.query(
  `insert into transactions
     (id, firm_id, client_id, transaction_date, description, money_out, currency, reconciliation_status, payload)
   values ($1, $2, $3, '2026-02-16', $4, $5, 'AED', $6, $7::jsonb)`,
  [id, FIRM, CLIENT, description, moneyOut, status, JSON.stringify(payload)]
);

const insertAsk = (seed, { id, transactionId, evidenceType, status = 'open', createdBy = 'ask_batch', question = 'Question?' }) => seed.query(
  `insert into client_evidence_requests
     (id, firm_id, client_id, transaction_id, status, evidence_type, question, request_payload, created_by, audience)
   values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, 'client')`,
  [id, FIRM, CLIENT, transactionId, status, evidenceType, question, createdBy]
);

const askRow = async (seed, id) => (await seed.query(
  'select id, status, evidence_type, resolved_by, request_payload, response_payload from client_evidence_requests where id = $1',
  [id]
)).rows[0];

const auditRows = async (seed, action) => (await seed.query(
  'select resource_type, resource_id, metadata from audit_events where firm_id = $1 and action = $2 order by id',
  [FIRM, action]
)).rows;

test(
  'real PG: an auto-match resolves only the asks that asked for that evidence; a purpose ask stays open with the match recorded (D3)',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG ask lifecycle not exercised in this run' },
  async () => {
    const { seed, stop } = await bootScratchDatabase();
    try {
      assert.deepEqual([...EVIDENCE_RESOLVABLE_ASK_TYPES].sort(), ['bank_statement', 'supporting_document']);
      await insertTransaction(seed, { id: 'tx-unioncoop', description: 'UNION COOP', moneyOut: 238.5 });
      await insertAsk(seed, { id: 'ask-purpose', transactionId: 'tx-unioncoop', evidenceType: 'business_purpose', question: 'Wholly for the café rather than personal?' });
      await insertAsk(seed, { id: 'ask-doc', transactionId: 'tx-unioncoop', evidenceType: 'supporting_document', createdBy: 'coding_auto_post' });
      await insertAsk(seed, { id: 'ask-replied-doc', transactionId: 'tx-unioncoop', evidenceType: 'supporting_document', status: 'replied' });
      await seed.query(
        `update transactions set payload = payload || $2::jsonb where id = $1`,
        ['tx-unioncoop', JSON.stringify({ evidence_request: { id: 'ask-purpose', status: 'open', evidence_type: 'business_purpose' } })]
      );

      await seed.query('begin');
      await cascadeAutoMatch({
        client: seed,
        firmId: FIRM,
        clientId: CLIENT,
        matchId: 'match-unioncoop',
        bankTransactionId: 'tx-unioncoop',
        matchedObjectType: 'receipt',
        documentId: 'doc-unioncoop-receipt'
      });
      await seed.query('commit');

      const doc = await askRow(seed, 'ask-doc');
      assert.equal(doc.status, 'resolved', 'the document ask is answered by the document');
      assert.equal(doc.resolved_by, 'system');
      assert.equal(doc.response_payload.auto_resolved_by_match, true);
      assert.deepEqual(doc.response_payload.document_ids, ['doc-unioncoop-receipt']);
      const repliedDoc = await askRow(seed, 'ask-replied-doc');
      assert.equal(repliedDoc.status, 'resolved', 'a replied document ask resolves too (unchanged contract)');

      const purpose = await askRow(seed, 'ask-purpose');
      assert.equal(purpose.status, 'open', 'an amount match proves the charge exists, not what it was for');
      assert.equal(purpose.resolved_by, null);
      assert.equal(purpose.request_payload.matched_document_id, 'doc-unioncoop-receipt', 'the match is recorded on the open ask');
      assert.equal(purpose.request_payload.matched_reconciliation_match_id, 'match-unioncoop');
      assert.equal(purpose.request_payload.matched_object_type, 'receipt');
      assert.ok(purpose.request_payload.match_recorded_at, 'the recording is dated');

      const tx = (await seed.query(`select reconciliation_status, payload from transactions where id = 'tx-unioncoop'`)).rows[0];
      assert.equal(tx.reconciliation_status, 'explained', 'the match cascade still settles the line');
      assert.equal(tx.payload.evidence_request.status, 'open', 'the embedded copy mirrors the still-open purpose ask, never a resolved one');

      const resolvedAudit = await auditRows(seed, 'client_evidence_request.auto_resolved_by_match');
      assert.equal(resolvedAudit.length, 1);
      assert.deepEqual(resolvedAudit[0].metadata.resolved_request_ids.sort(), ['ask-doc', 'ask-replied-doc']);
      assert.deepEqual(resolvedAudit[0].metadata.retained_request_ids, ['ask-purpose']);
      assert.deepEqual([...resolvedAudit[0].metadata.resolvable_evidence_types].sort(), ['bank_statement', 'supporting_document']);
      const recordedAudit = await auditRows(seed, 'client_evidence_request.match_recorded');
      assert.equal(recordedAudit.length, 1);
      assert.equal(recordedAudit[0].resource_type, 'client_evidence_request');
      assert.equal(recordedAudit[0].resource_id, 'ask-purpose');
      assert.equal(recordedAudit[0].metadata.matched_document_id, 'doc-unioncoop-receipt');
    } finally {
      await stop();
    }
  }
);

const seedAutoExplainedLine = async (seed, { id, description, moneyOut, model = 'claude-opus-4-8', materiality = 'immaterial', downgradedFrom = null }) => {
  await insertTransaction(seed, {
    id, description, moneyOut,
    status: 'explained',
    payload: { support_basis: 'bank_line', support_status: 'bank_line_explained', bank_line_disposition_explained: true }
  });
  await seed.query(
    `insert into reconciliation_evaluations
       (id, firm_id, client_id, target_type, target_id, matcher_family, verdict, unmatchable_reason, model, payload)
     values ($1, $2, $3, $4, $5, $6, 'auto_explained', null, $7, $8::jsonb)`,
    [`eval-${id}`, FIRM, CLIENT, BANK_LINE_DISPOSITION_TARGET_TYPE, id, BANK_LINE_DISPOSITION_FAMILY, model, JSON.stringify({
      disposition: 'auto_explain',
      materiality,
      materiality_ceiling: 500,
      downgraded_from: downgradedFrom,
      confidence: 0.93,
      expense_kind: 'tolls_and_parking',
      reasoning: 'A small recurring Salik toll from a known operator; immaterial, clearly business.'
    })]
  );
};

test(
  'real PG: auto_explain retracts an open purpose ask with a receipt when the flag acts, receipts only at shadow, nothing without a row (D4)',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG ask lifecycle not exercised in this run' },
  async () => {
    const { seed, stop } = await bootScratchDatabase();
    try {
      // Jan-13 Salik / Jan-23 Zoho (round-4 §A4): auto-explained at 16:20,
      // still carrying the 16:04 batch ask.
      await seedAutoExplainedLine(seed, { id: 'tx-salik', description: 'SALIK RECHARGE', moneyOut: 50 });
      await insertAsk(seed, { id: 'ask-salik-purpose', transactionId: 'tx-salik', evidenceType: 'business_purpose' });
      await seedAutoExplainedLine(seed, { id: 'tx-zoho', description: 'ZOHO SUBSCRIPTION', moneyOut: 45 });
      await insertAsk(seed, { id: 'ask-zoho-doc', transactionId: 'tx-zoho', evidenceType: 'supporting_document', createdBy: 'coding_auto_post' });
      // Never retracted: a replied ask (the reply lane owns it), an owner-fact
      // ask (a draw is never "operating noise"), a statement-coverage ask, and
      // a line whose auto_explain the Keep layer downgraded (material).
      await seedAutoExplainedLine(seed, { id: 'tx-replied', description: 'NOL TOPUP', moneyOut: 20 });
      await insertAsk(seed, { id: 'ask-replied', transactionId: 'tx-replied', evidenceType: 'business_purpose', status: 'replied' });
      await seedAutoExplainedLine(seed, { id: 'tx-ownerfact', description: 'OWNER TRANSFER', moneyOut: 30 });
      await insertAsk(seed, { id: 'ask-ownerfact', transactionId: 'tx-ownerfact', evidenceType: 'owner_fact', createdBy: 'coding_auto_post' });
      await insertAsk(seed, { id: 'ask-statement', transactionId: 'tx-ownerfact', evidenceType: 'bank_statement' });
      await seedAutoExplainedLine(seed, { id: 'tx-material', description: 'DEWA', moneyOut: 900, materiality: 'material', downgradedFrom: 'auto_explain' });
      await insertAsk(seed, { id: 'ask-material', transactionId: 'tx-material', evidenceType: 'business_purpose' });
      // A line explained by a DOCUMENT match is D3's territory, not D4's.
      await insertTransaction(seed, { id: 'tx-docmatched', description: 'CARREFOUR', moneyOut: 120, status: 'explained', payload: { auto_explained: true, auto_explain_source: 'llm_triage', reconciliation_match_type: 'receipt' } });
      await insertAsk(seed, { id: 'ask-docmatched', transactionId: 'tx-docmatched', evidenceType: 'business_purpose' });

      // No plane row ⇒ nothing happens (envFallback false — born on the plane).
      await seed.query('begin');
      const off = await retractAsksSettledByAutoExplain(seed, {
        firmId: FIRM, clientId: CLIENT, configSnapshot: await readClientConfigSnapshot(seed, { firmId: FIRM, clientId: CLIENT })
      });
      await seed.query('commit');
      assert.equal(off.skipped, true);
      assert.equal(off.reason, 'flag_off');
      assert.equal((await askRow(seed, 'ask-salik-purpose')).status, 'open');
      assert.equal((await auditRows(seed, 'client_evidence_request.retracted')).length, 0);
      assert.equal((await auditRows(seed, 'client_evidence_request.would_retract')).length, 0);

      // Shadow ⇒ the would-retract is receipted, nothing changes.
      await seed.query('begin');
      await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: AUTO_EXPLAIN_RETRACTS_FLAG_KEY, stage: 'shadow', source: 'manual', reason: 'test' });
      const shadow = await retractAsksSettledByAutoExplain(seed, {
        firmId: FIRM, clientId: CLIENT, configSnapshot: await readClientConfigSnapshot(seed, { firmId: FIRM, clientId: CLIENT })
      });
      await seed.query('commit');
      assert.equal(shadow.skipped, false);
      assert.equal(shadow.acts, false);
      assert.deepEqual(shadow.retracted_request_ids, []);
      assert.deepEqual([...shadow.observed_request_ids].sort(), ['ask-salik-purpose', 'ask-zoho-doc']);
      assert.equal((await askRow(seed, 'ask-salik-purpose')).status, 'open');
      const wouldRetract = await auditRows(seed, 'client_evidence_request.would_retract');
      assert.deepEqual(wouldRetract.map((row) => row.resource_id).sort(), ['ask-salik-purpose', 'ask-zoho-doc']);
      // Idempotent at shadow: a second sweep does not receipt the same ask twice.
      await seed.query('begin');
      await retractAsksSettledByAutoExplain(seed, {
        firmId: FIRM, clientId: CLIENT, configSnapshot: await readClientConfigSnapshot(seed, { firmId: FIRM, clientId: CLIENT })
      });
      await seed.query('commit');
      assert.equal((await auditRows(seed, 'client_evidence_request.would_retract')).length, 2);

      // Auto ⇒ retract with a receipt.
      await seed.query('begin');
      await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: AUTO_EXPLAIN_RETRACTS_FLAG_KEY, stage: 'auto', source: 'default', reason: 'desktop_host_default' });
      const acted = await retractAsksSettledByAutoExplain(seed, {
        firmId: FIRM, clientId: CLIENT, configSnapshot: await readClientConfigSnapshot(seed, { firmId: FIRM, clientId: CLIENT })
      });
      await seed.query('commit');
      assert.equal(acted.acts, true);
      assert.deepEqual([...acted.retracted_request_ids].sort(), ['ask-salik-purpose', 'ask-zoho-doc']);

      for (const id of ['ask-salik-purpose', 'ask-zoho-doc']) {
        const row = await askRow(seed, id);
        assert.equal(row.status, 'resolved', `${id} is retracted`);
        assert.equal(row.resolved_by, 'system');
        assert.equal(row.response_payload.retracted, true);
        assert.equal(row.response_payload.retracted_by, 'auto_explain');
        assert.equal(row.response_payload.retraction_source, 'bank_line_disposition');
        assert.equal(row.response_payload.retraction_model, 'claude-opus-4-8', 'the model id rides the receipt');
        assert.ok(row.response_payload.retracted_at);
      }
      for (const id of ['ask-replied', 'ask-ownerfact', 'ask-statement', 'ask-material', 'ask-docmatched']) {
        const row = await askRow(seed, id);
        assert.notEqual(row.status, 'resolved', `${id} must never be retracted by an auto_explain`);
        assert.equal(row.response_payload.retracted, undefined);
      }

      const receipts = await auditRows(seed, 'client_evidence_request.retracted');
      assert.deepEqual(receipts.map((row) => row.resource_id).sort(), ['ask-salik-purpose', 'ask-zoho-doc']);
      const salik = receipts.find((row) => row.resource_id === 'ask-salik-purpose');
      assert.equal(salik.resource_type, 'client_evidence_request');
      assert.equal(salik.metadata.transaction_id, 'tx-salik');
      assert.equal(salik.metadata.evidence_type, 'business_purpose');
      assert.equal(salik.metadata.retraction_source, 'bank_line_disposition');
      assert.equal(salik.metadata.evaluation_id, 'eval-tx-salik');
      assert.equal(salik.metadata.model, 'claude-opus-4-8');
      assert.equal(salik.metadata.materiality, 'immaterial');
      assert.equal(salik.metadata.flag_stage, 'auto');

      // The retraction lane (RECONCILE_RETRACTION_AUTOSEND) tells the owner:
      // the retracted rows are gathered exactly like match-resolved ones.
      await seed.query('begin');
      await setClientFlagStage(seed, { firmId: FIRM, clientId: CLIENT, flagKey: 'RECONCILE_RETRACTION_AUTOSEND', stage: 'auto', source: 'default', reason: 'desktop_host_default' });
      await seed.query('commit');
      let drafterInput = null;
      const result = await __draftClientAskBatchWithClient({
        client: seed,
        firmId: FIRM,
        clientId: CLIENT,
        actorId: 'system',
        draftFn: async (input) => {
          drafterInput = input;
          return {
            draft: { subject: 'All clear', message_markdown: 'Nothing to ask.', summary: '', items: [], statement_requests: [], document_asks: [], counts: { ask: 0, notify: 0, skip: 0, statement_requests: 0 } },
            model: 'test-drafter',
            response_id: ''
          };
        }
      });
      assert.ok(result.batch, `a retraction-only draft is minted: ${JSON.stringify(result)}`);
      const retracted = result.batch.draft?.retracted_items || [];
      assert.deepEqual(retracted.map((item) => item.request_id).sort(), ['ask-salik-purpose', 'ask-zoho-doc']);
      assert.ok(retracted.every((item) => item.reason === 'auto_explained'), JSON.stringify(retracted));
      assert.match(result.batch.draft.message_markdown, /settled the following ourselves/i);
      const batchRow = (await seed.query('select payload from client_ask_batches where id = $1', [result.batch.id])).rows[0];
      assert.deepEqual([...batchRow.payload.retracted_request_ids].sort(), ['ask-salik-purpose', 'ask-zoho-doc']);
      assert.equal(drafterInput?.codingItems?.length ?? 0, 0, 'no explained line is re-fed to the drafter');

      // Sending it flips retraction_notified on exactly those rows (told once).
      process.env.DATABASE_URL = seedUrlOf(seed);
      process.env.DATABASE_POOL_MAX = '1';
      const sent = await sendClientAskBatchInDb({ firmId: FIRM, clientId: CLIENT, batchId: result.batch.id, actorId: 'system' });
      assert.equal(sent.status, 'sent');
      for (const id of ['ask-salik-purpose', 'ask-zoho-doc']) {
        assert.equal((await askRow(seed, id)).response_payload.retraction_notified, true);
      }
    } finally {
      await __endFirmDbPoolForTests().catch(() => {});
      await stop();
    }
  }
);

const seedUrlOf = (seed) => {
  const url = new URL(PG_URL);
  url.pathname = `/${seed.connectionParameters.database}`;
  return url.toString();
};

test(
  'real PG: the draft gather never admits a line Donna settled, and a drafted anchor auto-explained before send goes stale (the #1959 treatment)',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — real-PG ask lifecycle not exercised in this run' },
  async () => {
    const { seed, stop } = await bootScratchDatabase();
    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorPoolMax = process.env.DATABASE_POOL_MAX;
    try {
      const suggested = {
        ai_suggestion_status: 'suggested',
        ai_suggestion: { proposed_account: 'Tolls & parking', confidence: 'medium', evidence_required: true, suggested_at: Date.parse('2026-02-16T08:00:00Z') }
      };
      // A coded-suggested line still bare: gathered. The same shape already
      // auto-explained by the disposition pass: NOT gathered (it is settled).
      await insertTransaction(seed, { id: 'tx-bare', description: 'OFFICE DEPOT', moneyOut: 140, payload: suggested });
      await insertTransaction(seed, {
        id: 'tx-explained', description: 'SALIK RECHARGE', moneyOut: 50, status: 'explained',
        payload: { ...suggested, ai_suggestion_applied_at:Date.parse('2026-02-17T08:00:00Z'), support_basis: 'bank_line', support_status: 'bank_line_explained', bank_line_disposition_explained: true }
      });
      let drafterInput = null;
      const drafted = await __draftClientAskBatchWithClient({
        client: seed,
        firmId: FIRM,
        clientId: CLIENT,
        actorId: 'system',
        draftFn: async (input) => {
          drafterInput = input;
          return {
            draft: {
              subject: 'One question',
              message_markdown: 'What was the Office Depot charge for?',
              summary: '',
              items: input.codingItems.map((item) => ({
                transaction_id: item.id, disposition: 'ask', question: 'What was this for?', evidence_type: 'business_purpose'
              })),
              statement_requests: [],
              document_asks: [],
              counts: { ask: input.codingItems.length, notify: 0, skip: 0, statement_requests: 0 }
            },
            model: 'test-drafter',
            response_id: ''
          };
        }
      });
      assert.deepEqual(drafterInput.codingItems.map((item) => item.id), ['tx-bare'], 'only the bare line reaches the drafter');
      assert.ok(drafted.batch);
      const snapshot=(await seed.query('select payload from transactions where client_id=$1',[CLIENT])).rows;
      assert.equal(askBatchStaleness({batch:drafted.batch,transactions:snapshot}).stale,false,
        'the real persisted draft covers applied verdicts on completed rows omitted from the ask gather');
      assert.equal(askBatchStaleness({batch:drafted.batch,transactions:[...snapshot,
        {ai_suggestion_applied_at:Date.parse(drafted.batch.verdicts_as_of)+1}]}).stale,true,
        'a later application still makes the draft stale; generation does not mask changes');

      // The race: Donna auto-explains the drafted line AFTER the draft, BEFORE the send.
      await seed.query(
        `update transactions set reconciliation_status = 'explained', payload = payload || $2::jsonb where id = $1`,
        ['tx-bare', JSON.stringify({ support_basis: 'bank_line', support_status: 'bank_line_explained', bank_line_disposition_explained: true })]
      );
      process.env.DATABASE_URL = seedUrlOf(seed);
      process.env.DATABASE_POOL_MAX = '1';
      await assert.rejects(
        sendClientAskBatchInDb({ firmId: FIRM, clientId: CLIENT, batchId: drafted.batch.id, actorId: 'system' }),
        (error) => error.code === 'ASK_BATCH_STALE' && error.details.stale_transaction_ids.includes('tx-bare')
      );
      const batch = (await seed.query('select status, payload from client_ask_batches where id = $1', [drafted.batch.id])).rows[0];
      assert.equal(batch.status, 'superseded');
      assert.deepEqual(batch.payload.superseded_before_send.stale_transaction_ids, ['tx-bare']);
      const asks = await seed.query('select count(*)::int as count from client_evidence_requests where client_id = $1', [CLIENT]);
      assert.equal(asks.rows[0].count, 0, 'no question about a settled line ever reaches the owner');
    } finally {
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorPoolMax === undefined) delete process.env.DATABASE_POOL_MAX; else process.env.DATABASE_POOL_MAX = priorPoolMax;
      await __endFirmDbPoolForTests().catch(() => {});
      await stop();
    }
  }
);
