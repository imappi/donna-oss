// Doc-first terminal drain Slice 3 — the ask + FYI legs
// (docs/donna-doc-first-terminal-drain-plan.md §3/§6, Kari's §8 answers:
// doc asks JOIN the per-client batch; auto-explain FYIs ride the standard
// owner digest). Pins:
//   1. drafter surface: schema carries document_asks; input carries
//      document_items + explained_documents; sanitize enforces shape
//      (handed ids only, dedupe, empty-question ask demotes to skip)
//   2. draft assembler: the doc-candidate gather is gated on the SAME plane
//      flag the drain acts under (∅ ⇒ no gather, byte-identical); the
//      explained-FYI gather is marker-gated and always runs; both reach the
//      drafter and the batch payload persists explained_fyi_document_ids
//   3. send: a document_asks 'ask' mints a DOC-anchored evidence request
//      (transaction_id null, request_payload.document_id — the anchor
//      Slice 1's awaiting_owner projection and the drain's already-asked
//      skip read); the explained-doc FYI markers flip owner_notified true
//      exactly once; the send audit carries both counts
//   4. sendability: a doc ask counts toward auto-send; explained-doc FYIs
//      alone do NOT (standard-digest posture — Kari's §8 call)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAskDraftInput,
  buildAskMessageSchema,
  sanitizeAskMessageDraft,
  DOC_ASK_EVIDENCE_TYPES
} from './askPipeline.js';
import {
  __draftClientAskBatchWithClient,
  __sendClientAskBatchWithClient
} from './firmDb.js';
import { draftAskCount, isSendableDraft } from './askAutoSendProducer.js';
import { DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY } from './documentDispositionShape.js';

const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return { rows: [] };
      }
      // This fixture is not enrolled in the pilot. Its scoped enrollment read
      // must not consume a reserved general config snapshot.
      if (text.includes('client_capability_config') && params?.[2] === 'INTERNAL_PILOT_ACCESS') return { rows: [] };
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        return { rows: response.rows || [], rowCount: (response.rows || []).length };
      }
      if (text.startsWith('select t.id') && text.includes('t.id = any($3::text[])')) {
        const rows = (params?.[2] || []).map((id) => ({ id }));
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('select d.id') && text.includes('d.id = any($3::text[])')) {
        const rows = (params?.[2] || []).map((id) => ({ id }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const CLIENT_ROW = {
  id: 'client-1',
  firm_id: 'firm-1',
  company_name: 'Honeybee Hills Apiary',
  jurisdiction: 'US',
  profile: { entityType: 'LLC' }
};

// A chase_evidence doc as the doc-candidate gather projects it.
const DOC_CANDIDATE_ROW = {
  id: 'doc-exxon-1',
  document_type: 'receipt',
  vendor_name: 'Exxon',
  customer_name: null,
  filename: 'exxon.pdf',
  total_amount: 41.2,
  currency: 'USD',
  document_date: '2026-05-14',
  disposition_payload: {
    policy_version: 'document_no_line_disposition_v1',
    disposition: 'chase_evidence',
    downgraded_from: 'auto_explain',
    materiality: 'material',
    expense_kind: 'fuel',
    settlement_channel: 'uncovered_account',
    confidence: 0.85,
    reasoning: 'Material fuel spend; the paying card has no statement in the feed.',
    matcher_mode: 'act'
  }
};

// A needs_human doc as the doc-candidate gather projects it: the model could
// not tell what the item IS (business-vs-personal unclear), so it escalates to
// the owner as a business-purpose question rather than hanging firm-side.
const NEEDS_HUMAN_DOC_ROW = {
  id: 'doc-cafe-3',
  document_type: 'receipt',
  vendor_name: 'Cafe Bar Magia',
  customer_name: null,
  filename: 'cafe.pdf',
  total_amount: 15.2,
  currency: 'PLN',
  document_date: '2026-07-17',
  disposition_payload: {
    policy_version: 'document_no_line_disposition_v1',
    disposition: 'needs_human',
    materiality: 'immaterial',
    expense_kind: 'unknown',
    settlement_channel: 'unknown',
    confidence: 0.55,
    reasoning: 'A small cafe charge in PLN for a US apiary is plausibly personal; business purpose unclear.',
    matcher_mode: 'act'
  }
};

// An auto-explained doc awaiting its one-time FYI, as the FYI gather projects it.
const EXPLAINED_DOC_ROW = {
  document_id: 'doc-chevron-2',
  document_type: 'receipt',
  vendor_name: 'Chevron',
  customer_name: null,
  filename: 'chevron.pdf',
  total_amount: 9.82,
  currency: 'USD',
  document_date: '2026-05-20',
  no_line_disposition: {
    disposition: 'auto_explain',
    expense_kind: 'fuel',
    settlement_channel: 'personal_card',
    owner_notified: false
  }
};

const DOC_MODEL_DRAFT = {
  subject: 'One receipt to clarify',
  message_markdown: '## Questions\n1. How was the Exxon receipt paid?\n\n**Explained without a bank line**\n- Chevron $9.82 …',
  summary: 'One doc ask, one explained-doc FYI.',
  items: [],
  statement_requests: [],
  document_asks: [
    {
      document_id: 'doc-exxon-1',
      disposition: 'ask',
      question: 'How was the May 14 Exxon receipt ($41.20) paid — cash, a personal card, or a card we should have statements for?',
      evidence_type: 'payment_method',
      skip_reason: ''
    }
  ]
};

// Canned-response keys (distinctive substrings; array ORDER disambiguates
// keys that appear in more than one query — see askBatch.test.js).
const cannedClient = (rows) => ({ match: 'from clients', rows });
const cannedConfig = (rows) => ({ match: 'from client_capability_config', rows });
const cannedCandidates = (rows) => ({ match: 'ai_suggestion_status', rows });
const cannedMovements = (rows) => ({ match: 'coded_account', rows });
const cannedAppliedFyi = (rows) => ({ match: 'material_auto_fyi', rows });
const cannedCodingFyi = (rows) => ({ match: 'coding_auto_post', rows });
// The doc-candidate SQL is the only draft query containing matcher_mode…
const cannedDocCandidates = (rows) => ({ match: 'matcher_mode', rows });
// …and the doc-FYI SQL the only one reading no_line_disposition→owner_notified.
const cannedDocExplainedFyi = (rows) => ({ match: "no_line_disposition'->>'owner_notified'", rows });
const cannedCoverage = (rows) => ({ match: 'statement_summary', rows });
const cannedOpenRequests = (rows) => ({ match: 'from client_evidence_requests', rows });
const cannedEvalMax = (rows) => ({ match: 'max(evaluated_at)', rows });
const cannedBatchInsert = (rows) => ({ match: 'insert into client_ask_batches', rows });

const DOC_FLAG_CANARY = {
  flag_key: DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, stage: 'canary', source: 'manual', client_id: 'client-1'
};

// ── 1. drafter surface ───────────────────────────────────────────────────────

await test('schema requires document_asks with the doc evidence-type vocabulary', () => {
  const schema = buildAskMessageSchema();
  assert.ok(schema.required.includes('document_asks'));
  const docAsks = schema.properties.document_asks.items;
  assert.deepEqual(docAsks.required, ['document_ref', 'disposition', 'question', 'evidence_type', 'skip_reason']);
  assert.deepEqual(docAsks.properties.disposition.enum, ['ask']);
  assert.equal(docAsks.properties.question.minLength, 1);
  assert.deepEqual(docAsks.properties.evidence_type.enum, [...DOC_ASK_EVIDENCE_TYPES]);
  assert.ok(DOC_ASK_EVIDENCE_TYPES.includes('payment_method'), 'the payment-method lane exists');
  assert.ok(DOC_ASK_EVIDENCE_TYPES.includes('bank_statement'), 'the statement-request lane exists');
});

await test('buildAskDraftInput carries document_items with their disposition verdict + explained_documents', () => {
  const input = buildAskDraftInput({
    documentItems: [{
      id: 'doc-exxon-1',
      document_type: 'receipt',
      counterparty: 'Exxon',
      filename: 'exxon.pdf',
      amount: 41.2,
      currency: 'USD',
      date: '2026-05-14',
      disposition: DOC_CANDIDATE_ROW.disposition_payload
    }],
    explainedDocuments: [{
      document_id: 'doc-chevron-2',
      document_type: 'receipt',
      counterparty: 'Chevron',
      amount: 9.82,
      currency: 'USD',
      date: '2026-05-20',
      expense_kind: 'fuel',
      settlement_channel: 'personal_card'
    }]
  });
  const doc = input.document_items[0];
  assert.equal(doc.document_ref, 'document_1');
  assert.equal(doc.disposition.settlement_channel, 'uncovered_account');
  assert.equal(doc.disposition.downgraded_from, 'auto_explain');
  assert.equal(doc.disposition.materiality, 'material');
  const explained = input.explained_documents[0];
  assert.equal(explained.document_ref, 'document_2');
  assert.equal(explained.settlement_channel, 'personal_card');
  assert.equal(explained.expense_kind, 'fuel');
});

await test('sanitize keeps only handed doc ids and defaults evidence_type', () => {
  const draft = sanitizeAskMessageDraft(
    {
      ...DOC_MODEL_DRAFT,
      document_asks: [
        ...DOC_MODEL_DRAFT.document_asks,
        // a doc we never handed the model → dropped
        { document_id: 'doc-invented-9', disposition: 'ask', question: 'Q?', evidence_type: 'payment_method', skip_reason: '' },
        { document_id: 'doc-weird-3', disposition: 'ask', question: 'How was this paid?', evidence_type: 'weird_type', skip_reason: '' }
      ]
    },
    { documentItems: [{ id: 'doc-exxon-1' }, { id: 'doc-weird-3' }] }
  );
  assert.equal(draft.document_asks.length, 2, 'unknown doc dropped');
  assert.equal(draft.document_asks[0].document_id, 'doc-exxon-1');
  assert.equal(draft.document_asks[0].evidence_type, 'payment_method');
  assert.equal(draft.document_asks[1].document_id, 'doc-weird-3');
  assert.equal(draft.document_asks[1].disposition, 'ask');
  assert.equal(draft.document_asks[1].evidence_type, 'payment_method', 'out-of-vocabulary type defaulted');
  assert.equal(draft.counts.document_asks, 2);
});

await test('sanitize refuses duplicate, skipped, missing, or empty-question unresolved documents', () => {
  const base = {
    document_id: 'doc-exxon-1', disposition: 'ask', question: 'How was this paid?',
    evidence_type: 'payment_method', skip_reason: ''
  };
  for (const [documentAsks, failure] of [
    [[base, { ...base }], 'duplicate'],
    [[{ ...base, disposition: 'skip', question: '' }], 'nonterminal_skip'],
    [[], 'missing'],
    [[{ ...base, question: '' }], 'empty_question']
  ]) {
    assert.throws(
      () => sanitizeAskMessageDraft(
        { ...DOC_MODEL_DRAFT, document_asks: documentAsks },
        { documentItems: [{ id: 'doc-exxon-1' }] }
      ),
      (error) => error.code === 'ASK_PIPELINE_BAD_DRAFT'
        && error.details.failures.some((entry) => entry.endsWith(failure))
    );
  }
});

// ── 2. draft assembler ───────────────────────────────────────────────────────

const runDraft = async ({
  configRows = [], docCandidateRows = [], explainedRows = [], freshnessDocRows
} = {}) => {
  let drafterInput = null;
  const responses = [
    cannedClient([CLIENT_ROW]),
    cannedConfig(configRows),
    cannedCandidates([]),
    cannedMovements([]),
    cannedAppliedFyi([]),
    cannedCodingFyi([]),
    cannedDocCandidates(docCandidateRows),
    cannedDocExplainedFyi(explainedRows),
    cannedCoverage([]),
    cannedOpenRequests([]),
    cannedEvalMax([{ last_evaluated_at: '2026-07-05T08:00:00Z' }])
  ];
  if (freshnessDocRows !== undefined) {
    responses.push({ match: 'd.id = any($3::text[])', rows: freshnessDocRows });
  }
  responses.push(cannedBatchInsert([{ id: 'ask-batch-doc', status: 'draft', payload: {} }]));
  const client = makeMockClient(responses);
  const result = await __draftClientAskBatchWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    draftFn: async (input) => {
      drafterInput = input;
      return {
        draft: {
          ...DOC_MODEL_DRAFT,
          document_asks: docCandidateRows.map((row) => ({
            document_id: row.id,
            disposition: 'ask',
            question: `Please clarify ${row.vendor_name || row.customer_name || row.id}.`,
            evidence_type: row.disposition_payload?.disposition === 'needs_human'
              ? 'business_purpose'
              : 'payment_method',
            skip_reason: ''
          }))
        },
        model: 'gpt-5.4',
        response_id: ''
      };
    }
  });
  return { client, result, drafterInput };
};

await test('DB stage=canary → doc candidates gathered and handed to the drafter with their verdict', async () => {
  const { client, drafterInput } = await runDraft({
    configRows: [DOC_FLAG_CANARY],
    docCandidateRows: [DOC_CANDIDATE_ROW],
    explainedRows: [EXPLAINED_DOC_ROW]
  });
  const docQuery = client.calls.find((c) => c.sql.includes('matcher_mode'));
  assert.ok(docQuery, 'the doc-candidate gather ran under the canary');
  assert.ok(docQuery.sql.includes("latest.payload->>'disposition' in ('chase_evidence', 'needs_human')"),
    'both non-settling doc verdicts (chase_evidence + needs_human) feed the ask lane');
  assert.ok(docQuery.sql.includes("ev.payload->>'matcher_mode' = 'act'"),
    'shadow verdicts can never feed an owner ask (reader #4)');
  const item = drafterInput.documentItems[0];
  assert.equal(item.id, 'doc-exxon-1');
  assert.equal(item.counterparty, 'Exxon');
  assert.equal(item.disposition.settlement_channel, 'uncovered_account');
  const explained = drafterInput.explainedDocuments[0];
  assert.equal(explained.document_id, 'doc-chevron-2');
  assert.equal(explained.settlement_channel, 'personal_card');
});

await test('needs_human docs also feed the ask lane, carrying their verdict to the drafter (the hanging-violation close)', async () => {
  const { drafterInput } = await runDraft({
    configRows: [DOC_FLAG_CANARY],
    docCandidateRows: [NEEDS_HUMAN_DOC_ROW]
  });
  const item = drafterInput.documentItems.find((d) => d.id === 'doc-cafe-3');
  assert.ok(item, 'the needs_human doc was gathered as a candidate');
  assert.equal(item.disposition.disposition, 'needs_human',
    'the verdict rides along so the drafter can pick business_purpose over payment_method');
  assert.equal(item.disposition.settlement_channel, 'unknown');
});

await test('DB stage=canary → the batch payload persists explained_fyi_document_ids + doc input stats', async () => {
  const { client } = await runDraft({
    configRows: [DOC_FLAG_CANARY],
    docCandidateRows: [DOC_CANDIDATE_ROW],
    explainedRows: [EXPLAINED_DOC_ROW]
  });
  const insert = client.calls.find((c) => c.sql.includes('insert into client_ask_batches'));
  const payload = JSON.parse(insert.params[7]);
  assert.deepEqual(payload.explained_fyi_document_ids, ['doc-chevron-2']);
  assert.equal(payload.input_stats.document_items, 1);
  assert.equal(payload.input_stats.explained_documents, 1);
});

await test('flag ∅ → the doc-candidate gather never runs (byte-identical); the marker-gated FYI gather still does', async () => {
  const { client, result } = await runDraft({
    configRows: [],
    explainedRows: []
  });
  assert.ok(!client.calls.some((c) => c.sql.includes('matcher_mode')),
    'no doc-candidate query for an un-enrolled client');
  assert.ok(client.calls.some((c) => c.sql.includes("no_line_disposition'->>'owner_notified'")),
    'the FYI gather is marker-gated, not flag-gated — an already-settled doc still gets its FYI');
  assert.equal(result.batch, null, 'nothing else to draft → nothing_to_ask');
  assert.equal(result.reason, 'nothing_to_ask');
});

await test('doc items alone make a draft (the doc-only client is no longer nothing_to_ask)', async () => {
  const { result, drafterInput } = await runDraft({
    configRows: [DOC_FLAG_CANARY],
    docCandidateRows: [DOC_CANDIDATE_ROW]
  });
  assert.ok(drafterInput, 'the drafter ran for a doc-only population');
  assert.ok(result.batch, 'a draft batch landed');
});

await test('generation freshness refuses a doc ask whose disposition settled during drafting', async () => {
  await assert.rejects(
    runDraft({
      configRows: [DOC_FLAG_CANARY],
      docCandidateRows: [DOC_CANDIDATE_ROW],
      freshnessDocRows: []
    }),
    (error) => error.code === 'ASK_BATCH_STALE_DURING_DRAFT'
      && error.details.stale_document_ids.includes('doc-exxon-1')
  );
});

// ── 3. send ─────────────────────────────────────────────────────────────────

const SENDABLE_DOC_BATCH_ROW = {
  id: 'ask-batch-doc',
  firm_id: 'firm-1',
  client_id: 'client-1',
  status: 'draft',
  payload: {
    draft: DOC_MODEL_DRAFT,
    explained_fyi_document_ids: ['doc-chevron-2']
  }
};

const cannedBatchForUpdate = (rows) => ({ match: 'for update', rows });
const cannedDocLookup = (rows) => ({ match: 'select id, document_type, vendor_name', rows });
const cannedEvidenceInsert = (rows) => ({ match: 'insert into client_evidence_requests', rows });
const cannedBatchSentUpdate = (rows) => ({ match: "set status = 'sent'", rows });
const cannedDocFyiFlip = (rows) => ({ match: "'{no_line_disposition,owner_notified}'", rows });

await test('send mints the DOC-anchored request: transaction_id null, request_payload.document_id set, no needs_client flip', async () => {
  const client = makeMockClient([
    cannedBatchForUpdate([SENDABLE_DOC_BATCH_ROW]),
    cannedDocLookup([{
      id: 'doc-exxon-1', document_type: 'receipt', vendor_name: 'Exxon', customer_name: null,
      filename: 'exxon.pdf', total_amount: 41.2, currency: 'USD', document_date: '2026-05-14'
    }]),
    cannedEvidenceInsert([{ id: 'evr-doc-1', status: 'open', request_payload: {}, response_payload: {} }]),
    cannedDocFyiFlip([{ id: 'doc-chevron-2' }]),
    cannedBatchSentUpdate([{ ...SENDABLE_DOC_BATCH_ROW, status: 'sent', sent_at: '2026-07-05T12:00:00Z' }])
  ]);

  const batch = await __sendClientAskBatchWithClient({
    client,
    firmId: 'firm-1',
    batchId: 'ask-batch-doc',
    clientId: 'client-1',
    actorId: 'kari@books.example'
  });

  const insert = client.calls.find((c) => c.sql.includes('insert into client_evidence_requests'));
  assert.ok(insert, 'the doc ask minted an evidence request');
  assert.equal(insert.params[3], null, 'transaction_id stays null — the anchor is the document');
  assert.equal(insert.params[5], 'payment_method', 'the drafter-chosen lane ships');
  const requestPayload = JSON.parse(insert.params[7]);
  assert.equal(requestPayload.document_id, 'doc-exxon-1',
    'request_payload.document_id matches openOwnerAskDocIdsFrom + the drain already-asked skip');
  assert.equal(requestPayload.amount, 41.2);
  assert.equal(requestPayload.ask_batch_id, 'ask-batch-doc');
  assert.ok(!client.calls.some((c) => c.sql.includes("'needs_client'")),
    'no transaction to flip — the doc anchor has no needs_client side-effect');

  const audit = client.calls.find((c) => c.sql.includes('ask_batch.send'));
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.document_ask_count, 1);
  assert.equal(metadata.doc_explained_fyi_notified, 1);
  assert.equal(metadata.evidence_request_count, 1);
  assert.equal(batch.status, 'sent');
});

await test('send flips owner_notified exactly for the batch explained-FYI docs (idempotence guard in SQL)', async () => {
  const client = makeMockClient([
    cannedBatchForUpdate([{
      ...SENDABLE_DOC_BATCH_ROW,
      payload: {
        draft: { ...DOC_MODEL_DRAFT, document_asks: [] },
        explained_fyi_document_ids: ['doc-chevron-2']
      }
    }]),
    cannedDocFyiFlip([{ id: 'doc-chevron-2' }]),
    cannedBatchSentUpdate([{ ...SENDABLE_DOC_BATCH_ROW, status: 'sent' }])
  ]);
  await __sendClientAskBatchWithClient({ client, firmId: 'firm-1', batchId: 'ask-batch-doc', clientId: 'client-1' });
  const flip = client.calls.find((c) => c.sql.includes("'{no_line_disposition,owner_notified}'"));
  assert.ok(flip, 'the doc FYI flip ran on send');
  assert.deepEqual(flip.params[1], ['doc-chevron-2'], 'flips exactly the batch ids');
  assert.ok(flip.sql.includes("payload->'no_line_disposition'->>'disposition' = 'auto_explain'"),
    'guarded to auto_explain rows');
  assert.ok(flip.sql.includes("coalesce(payload->'no_line_disposition'->>'owner_notified', '') = 'false'"),
    'guarded to still-false rows — idempotent');
});

await test('send without explained-FYI docs issues no doc flip (back-compat)', async () => {
  const client = makeMockClient([
    cannedBatchForUpdate([{
      ...SENDABLE_DOC_BATCH_ROW,
      payload: { draft: { ...DOC_MODEL_DRAFT, document_asks: [] } }
    }]),
    cannedBatchSentUpdate([{ ...SENDABLE_DOC_BATCH_ROW, status: 'sent' }])
  ]);
  await __sendClientAskBatchWithClient({ client, firmId: 'firm-1', batchId: 'ask-batch-doc', clientId: 'client-1' });
  assert.ok(!client.calls.some((c) => c.sql.includes("'{no_line_disposition,owner_notified}'")),
    'no flip when the batch carries no explained-FYI docs');
});

// ── 4. sendability ──────────────────────────────────────────────────────────

await test('a doc ask counts toward auto-send; explained-doc FYIs alone do not (standard digest)', () => {
  const docAskOnly = { draft: { items: [], statement_requests: [], document_asks: DOC_MODEL_DRAFT.document_asks } };
  assert.equal(draftAskCount(docAskOnly), 1);
  assert.equal(isSendableDraft(docAskOnly), true, 'a doc ask is a genuine owner question');

  const fyiOnly = { draft: { items: [], statement_requests: [], document_asks: [] }, explained_fyi_document_ids: ['doc-chevron-2'] };
  assert.equal(draftAskCount(fyiOnly), 0);
  assert.equal(isSendableDraft(fyiOnly), false,
    'pure explained-FYI batches wait for a question-bearing batch or a manual send');

  const skipOnly = { draft: { items: [], statement_requests: [], document_asks: [{ document_id: 'd1', disposition: 'skip', question: '', evidence_type: 'payment_method', skip_reason: 'covered' }] } };
  assert.equal(draftAskCount(skipOnly), 0, 'doc skips never count');
});

// ── owner language: the deterministic "Already handled" section ─────────────
// It is appended to the drafted message, so it follows the language the draft
// was written in (the drafter's receipt); English stays byte-identical.
const runRetractionDraft = async ({ language, clientRow = CLIENT_ROW }) => {
  const client = makeMockClient([
    cannedClient([clientRow]),
    cannedConfig([{ flag_key: 'RECONCILE_RETRACTION_AUTOSEND', stage: 'canary', source: 'manual', client_id: 'client-1' }]),
    { match: 'retracted_by_auto_explain', rows: [
      { request_id: 'ask-r1', transaction_id: 'tx-r1', retracted_by_auto_explain: false, transaction_date: '2026-06-02', description: 'MAANVUOKRA ESIMERKKI', money_out: 831.35, money_in: 0, currency: 'EUR' },
      { request_id: 'ask-r2', transaction_id: 'tx-r2', retracted_by_auto_explain: true, transaction_date: '2026-06-09', description: 'PYSÄKÖINTI ESIMERKKI', money_out: 4.5, money_in: 0, currency: 'EUR' }
    ] },
    cannedEvalMax([{ last_evaluated_at: '2026-07-05T08:00:00Z' }]),
    cannedBatchInsert([{ id: 'ask-batch-retraction', status: 'draft', payload: {} }])
  ]);
  let drafted = null;
  await __draftClientAskBatchWithClient({
    client, firmId: 'firm-1', clientId: 'client-1',
    draftFn: async () => {
      drafted = { subject: 'All clear', message_markdown: 'All clear.', summary: '', items: [], statement_requests: [], document_asks: [], counts: { ask: 0, notify: 0, skip: 0, statement_requests: 0 } };
      return { draft: drafted, model: 'gpt-5.4', response_id: '', ...(language ? { language } : {}) };
    }
  });
  return drafted.message_markdown;
};

await test('owner language — the "Already handled" section is byte-identical English and Finnish for a Finnish draft', async () => {
  assert.equal(await runRetractionDraft({ language: 'en' }), [
    'All clear.',
    '**Already handled — you can ignore these**',
    "We've since found the supporting material for the following, so there's no need to send that material again:",
    '- 2026-06-02 — EUR 831.35 — MAANVUOKRA ESIMERKKI',
    "We've since settled the following ourselves — small, recurring and clearly business, so no receipt or explanation is needed:",
    '- 2026-06-09 — EUR 4.50 — PYSÄKÖINTI ESIMERKKI',
    ''
  ].join('\n'));
  const finnish = [
    'All clear.',
    '**Nämä on jo hoidettu, voit jättää ne huomiotta**',
    'Löysimme sittemmin tositteet seuraaviin, joten niitä ei tarvitse enää lähettää:',
    '- 2.6.2026, 831,35 EUR, MAANVUOKRA ESIMERKKI',
    'Kirjasimme seuraavat itse: ne ovat pieniä, toistuvia ja selvästi liiketoimintaan liittyviä, joten kuittia tai selitystä ei tarvita:',
    '- 9.6.2026, 4,50 EUR, PYSÄKÖINTI ESIMERKKI',
    ''
  ].join('\n');
  assert.equal(await runRetractionDraft({ language: 'fi' }), finnish);
  // A drafter that reports no language: the one resolver on the client profile.
  assert.equal(await runRetractionDraft({ clientRow: { ...CLIENT_ROW, jurisdiction: 'FI', profile: { jurisdiction: 'FI' } } }), finnish);
});
