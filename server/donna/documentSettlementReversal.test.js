// The late-bank-line reversal guard — detection funnel + producer + FYI lane
// (documentSettlementReversal.js; detection in
// firmDb.applyDocumentPaymentStatusAfterMatch). Mock-pg harness mirrors
// documentSettlementEntry.test.js. Pins:
//   1. detection: the guarded marker merge fires ONLY on an entry-settled doc
//      with a settled match and no reversal, audits in-transaction, and the
//      funnel reports lateBankLineDetected to the interactive writers
//   2. the reversal gather DERIVES from the documents × matches join (never
//      the detection marker), and the ENTRY producer's gather now refuses a
//      doc that already carries a settled match (the forward-direction close)
//   3. the proposal card validates the 034 contract; deterministic — no model
//   4. producer forks: flag ∅ inert · shadow mints only · act reverses via
//      postLedgerAdjustmentInDb (reverseOriginal, no lines) + marker + audit
//      + receipt · derived idempotency self-heals off ledger_journals ·
//      failed checks rest proposed · a throwing post never merges the marker
//   5. the FYI lane: drafter input settlement_reversals, batch payload ids,
//      the send chokepoint's exactly-once flip, never auto-sendable alone

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runDocumentSettlementReversalsForClient,
  DOCUMENT_SETTLEMENT_REVERSAL_PROPOSAL_TYPE,
  documentSettlementReversalProposalId,
  SETTLEMENT_REVERSAL_AUTHORITY_BASIS,
  __GATHER_SQL,
  __buildReversalProposalCard,
  __buildReversalChecks,
  __reversalReasonFor
} from './documentSettlementReversal.js';
import { __GATHER_SQL as __ENTRY_GATHER_SQL } from './documentSettlementEntry.js';
import { validateOperatorContract, PROPOSAL_CARD_SCHEMA } from './operatorContract.js';
import {
  applyDocumentPaymentStatusAfterMatch,
  __draftClientAskBatchWithClient,
  __sendClientAskBatchWithClient
} from './firmDb.js';
import { buildAskDraftInput } from './askPipeline.js';
import { draftAskCount, isSendableDraft } from './askAutoSendProducer.js';
import { DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY } from './documentDispositionShape.js';

// ── Mock client (documentSettlementEntry.test.js pattern) ─────────────

const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        return { rows: response.rows || [], rowCount: (response.rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const FLAG_ROW = (stage) => ({
  flag_key: DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY, stage, source: 'manual', client_id: 'client-1'
});

const SETTLEMENT_ENTRY = {
  journal_id: 'lj-settle-1',
  posted_at: '2026-07-18T10:00:00Z',
  amount: 41.2,
  currency: 'USD',
  expense_account: '449 · Motor vehicle expenses',
  owner_funds_account: '901 · Director loan',
  settlement_channel: 'personal_card',
  authority_basis: 'immaterial_auto_explain',
  owner_notified: true
};

const REVERSAL_DOC_ROW = {
  id: 'doc-exxon-1',
  document_type: 'receipt',
  vendor_name: 'Exxon',
  customer_name: null,
  filename: 'exxon.pdf',
  total_amount: 41.2,
  currency: 'USD',
  document_date: '2026-05-14',
  payment_status: 'paid',
  updated_at: '2026-07-20T10:00:00Z',
  settlement_entry: SETTLEMENT_ENTRY,
  match_id: 'recon-match-1',
  bank_transaction_id: 'tx-1',
  match_status: 'auto_matched'
};

// Canned-response keys (distinctive substrings within the producer's flow).
const cannedConfig = (rows) => ({ match: 'from client_capability_config', rows });
const cannedGather = (rows) => ({ match: "'reversal' is null", rows });
const cannedExistingReversal = (rows) => ({ match: 'reversal_of_journal_id =', rows });
const cannedSettlementJournal = (rows) => ({ match: 'select id, status from ledger_journals', rows });
const cannedExistingCard = (rows) => ({ match: 'from proposal_cards', rows });
const cannedCardInsert = (rows) => ({ match: 'insert into proposal_cards', rows });
const cannedMarkerMerge = (rows) => ({ match: "'{settlement_entry,reversal}'", rows });
const cannedDocAudit = (rows) => ({ match: "'ledger.reverse_document_settlement'", rows });

const runProducer = async ({
  stage = null,
  gatherRows = [REVERSAL_DOC_ROW],
  existingReversalRows = [],
  settlementJournalRows = [{ id: 'lj-settle-1', status: 'posted' }],
  existingCardRows = [],
  postAdjustmentImpl = null,
  documentIds = null
} = {}) => {
  const client = makeMockClient([
    cannedConfig(stage ? [FLAG_ROW(stage)] : []),
    cannedGather(gatherRows),
    ...gatherRows.map(() => cannedExistingReversal(existingReversalRows)),
    ...gatherRows.map(() => cannedSettlementJournal(settlementJournalRows)),
    ...gatherRows.map(() => cannedExistingCard(existingCardRows)),
    ...gatherRows.map((row) => cannedCardInsert([{ id: documentSettlementReversalProposalId(row.id) }])),
    ...gatherRows.map((row) => cannedMarkerMerge([{ id: row.id }])),
    ...gatherRows.map(() => cannedDocAudit([{ id: 77 }]))
  ]);
  const postCalls = [];
  const stats = await runDocumentSettlementReversalsForClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentIds,
    postAdjustmentFn: postAdjustmentImpl || (async (args) => {
      postCalls.push(args);
      return { ledger_adjustment: { journals: [{ ledger_journal_id: 'lj-rev-1' }] } };
    })
  });
  return { client, stats, postCalls };
};

// ── 1. The detection funnel (the REAL firmDb writer against mock pg) ──

test('detection — an entry-settled doc on a settle cascade gets the marker + in-txn audit', async () => {
  const client = makeMockClient([
    {
      match: "'{settlement_entry,late_bank_line}'",
      rows: [{ client_id: 'client-1', settlement_journal_id: 'lj-settle-1' }]
    }
  ]);
  const out = await applyDocumentPaymentStatusAfterMatch({
    client, firmId: 'firm-1', matchId: 'recon-match-1',
    matchedObjectType: 'receipt', documentId: 'doc-exxon-1'
  });
  assert.equal(out.lateBankLineDetected, true);

  const marker = client.calls.find((c) => c.sql.includes("'{settlement_entry,late_bank_line}'"));
  assert.ok(marker, 'the guarded marker merge ran');
  assert.ok(marker.sql.includes("coalesce(payload->'settlement_entry'->>'journal_id', '') <> ''"),
    'only entry-settled docs fire');
  assert.ok(marker.sql.includes("payload->'settlement_entry'->'late_bank_line' is null"),
    'write-once marker');
  assert.ok(marker.sql.includes("payload->'settlement_entry'->'reversal' is null"),
    'an already-reversed doc never re-fires');
  assert.ok(!marker.sql.includes('reconciliation_matches'),
    'the settle context IS the settled-match proof — no subquery in the funnel');
  const merged = JSON.parse(marker.params[2]);
  assert.equal(merged.needs_ledger_adjustment, true, 'the surfaced state IS needs_ledger_adjustment');
  assert.equal(merged.match_id, 'recon-match-1');

  const audit = client.calls.find((c) => c.sql.includes("'document.settlement_late_bank_line'"));
  assert.ok(audit, 'detection audits in the same transaction');
  const metadata = JSON.parse(audit.params[3]);
  assert.equal(metadata.settlement_journal_id, 'lj-settle-1');
});

test('detection — a plain doc (no settlement entry) is a silent no-op reporting false', async () => {
  const client = makeMockClient([]);
  const out = await applyDocumentPaymentStatusAfterMatch({
    client, firmId: 'firm-1', matchId: 'recon-match-2',
    matchedObjectType: 'receipt', documentId: 'doc-plain-1'
  });
  assert.equal(out.lateBankLineDetected, false);
  assert.ok(!client.calls.some((c) => c.sql.includes("'document.settlement_late_bank_line'")),
    'no audit without a detection');
});

test('detection — a returned row WITHOUT a settlement journal id never reads as a detection', async () => {
  const client = makeMockClient([
    { match: "'{settlement_entry,late_bank_line}'", rows: [{ id: 'doc-x', parse_status: 'completed' }] }
  ]);
  const out = await applyDocumentPaymentStatusAfterMatch({
    client, firmId: 'firm-1', matchId: 'recon-match-3',
    matchedObjectType: 'receipt', documentId: 'doc-x'
  });
  assert.equal(out.lateBankLineDetected, false, 'shape-validated: journal id required');
  assert.ok(!client.calls.some((c) => c.sql.includes("'document.settlement_late_bank_line'")));
});

test('detection — the sum-based REVERT path (unpaid) skips the guard entirely', async () => {
  const client = makeMockClient([
    { match: 'select total_amount from documents', rows: [{ total_amount: 100 }] },
    { match: 'coalesce(sum(case when matched_object_id=$3 then match_amount', rows: [{ settled: 0 }] }
  ]);
  const out = await applyDocumentPaymentStatusAfterMatch({
    client, firmId: 'firm-1', matchId: 'recon-match-4',
    matchedObjectType: 'sales_invoice', documentId: 'doc-inv-1'
  });
  assert.equal(out.lateBankLineDetected, false);
  assert.ok(!client.calls.some((c) => c.sql.includes("'{settlement_entry,late_bank_line}'")),
    'no settled match remains — nothing to guard');
});

// ── 2. Gather derivations (the two directions of the same close) ──────

test('reversal gather — derives from the doc × settled-match join, never the marker', () => {
  assert.ok(__GATHER_SQL.includes("coalesce(d.payload->'settlement_entry'->>'journal_id', '') <> ''"),
    'entry-settled docs only');
  assert.ok(__GATHER_SQL.includes("d.payload->'settlement_entry'->'reversal' is null"),
    'a reversed doc never re-gathers');
  assert.ok(__GATHER_SQL.includes("m.status in ('confirmed', 'auto_matched')"),
    'settled matches only');
  assert.ok(__GATHER_SQL.includes("m.matched_object_type <> 'bank_line'"),
    'doc-side matches only');
  assert.ok(!__GATHER_SQL.includes('late_bank_line'),
    'the detection marker is the render surface, NOT the gather key');
});

test('entry gather — refuses a doc that already carries a settled match (forward close)', () => {
  assert.ok(__ENTRY_GATHER_SQL.includes('not exists'),
    'the entry producer must never mint an owner-funds entry for a bank-settled doc');
  assert.ok(__ENTRY_GATHER_SQL.includes("m.status in ('confirmed', 'auto_matched')"),
    'keyed on settled matches');
});

// ── 3. The proposal card ──────────────────────────────────────────────

test('card — validates the 034 contract; deterministic Keep-layer shape', () => {
  const checks = __buildReversalChecks({
    settlementJournalRow: { id: 'lj-settle-1', status: 'posted' },
    match: { match_id: 'recon-match-1', bank_transaction_id: 'tx-1' }
  });
  assert.equal(checks.status, 'pass');
  const card = __buildReversalProposalCard({
    document: REVERSAL_DOC_ROW,
    settlementEntry: SETTLEMENT_ENTRY,
    match: { match_id: 'recon-match-1', bank_transaction_id: 'tx-1', match_status: 'auto_matched' },
    checks,
    reason: __reversalReasonFor(REVERSAL_DOC_ROW, { match_id: 'recon-match-1', bank_transaction_id: 'tx-1' })
  });
  const { ok, errors } = validateOperatorContract(PROPOSAL_CARD_SCHEMA, card);
  assert.ok(ok, `contract violation: ${errors.join('; ')}`);
  assert.equal(card.proposal_id, 'docsettlerev-doc-exxon-1');
  assert.equal(card.type, DOCUMENT_SETTLEMENT_REVERSAL_PROPOSAL_TYPE);
  assert.equal(card.triage_source, 'state_correction');
  assert.equal(card.writer, 'postLedgerAdjustmentInDb');
  assert.equal(card.reversibility, 'reversible_via_adjustment');
  assert.equal(card.detail.authority_basis, SETTLEMENT_REVERSAL_AUTHORITY_BASIS);
  assert.equal(card.detail.settlement_journal_id, 'lj-settle-1');
  assert.equal(card.detail.match_id, 'recon-match-1');
});

test('card — a missing settlement journal fails checks (surfaced, never guessed around)', () => {
  const checks = __buildReversalChecks({ settlementJournalRow: null, match: { match_id: 'recon-match-1' } });
  assert.equal(checks.status, 'fail');
});

// ── 4. Producer forks ─────────────────────────────────────────────────

test('producer — flag ∅ is inert (born on the plane; no env fallback)', async () => {
  const { client, stats, postCalls } = await runProducer({ stage: null });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'flag_off');
  assert.equal(postCalls.length, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes("'reversal' is null")), 'no gather at ∅');
});

test('producer — shadow mints the card and NEVER touches the ledger', async () => {
  const { client, stats, postCalls } = await runProducer({ stage: 'shadow' });
  assert.equal(stats.mode, 'shadow');
  assert.equal(stats.gathered, 1);
  assert.equal(stats.cards_minted, 1);
  assert.equal(stats.reversed, 0);
  assert.equal(postCalls.length, 0, 'shadow posts nothing');
  assert.ok(!client.calls.some((c) => c.sql.includes("'{settlement_entry,reversal}'")),
    'shadow merges no marker');
});

test('producer — act reverses via the named writer: reverseOriginal, no adjustment lines', async () => {
  const { client, stats, postCalls } = await runProducer({ stage: 'canary' });
  assert.equal(stats.mode, 'act');
  assert.equal(stats.reversed, 1);
  assert.deepEqual(stats.reversed_document_ids, ['doc-exxon-1']);
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].originalJournalId, 'lj-settle-1');
  assert.equal(postCalls[0].reverseOriginal, true);
  assert.deepEqual(postCalls[0].lines, [], 'a pure reversal — no replacement lines');
  assert.ok(postCalls[0].reason.includes('Late bank line'), 'the correction reason is named');

  const merge = client.calls.find((c) => c.sql.includes("'{settlement_entry,reversal}'"));
  assert.ok(merge, 'the reversal marker merged onto the doc');
  assert.ok(merge.sql.includes("payload->'settlement_entry'->'reversal' is null"),
    'write-once guarded');
  const reversal = JSON.parse(merge.params[3]);
  assert.equal(reversal.journal_id, 'lj-rev-1');
  assert.equal(reversal.owner_notified, false, 'the correction FYI is owed');
  assert.equal(reversal.authority_basis, SETTLEMENT_REVERSAL_AUTHORITY_BASIS);
  assert.equal(reversal.reason, 'late_bank_line');
  const resolved = JSON.parse(merge.params[4]);
  assert.equal(resolved.needs_ledger_adjustment, false, 'the surfaced violation resolves');

  const audit = client.calls.find((c) => c.sql.includes("'ledger.reverse_document_settlement'"));
  assert.ok(audit, 'the doc-scoped audit is in the marker transaction');
  const metadata = JSON.parse(audit.params[3]);
  assert.equal(metadata.reversal_journal_id, 'lj-rev-1');
  assert.equal(metadata.original_journal_id, 'lj-settle-1');
  assert.deepEqual(metadata.before_state.settlement_entry, SETTLEMENT_ENTRY);

  const receipt = client.calls.find((c) => c.sql.includes('insert into apply_receipts'));
  assert.ok(receipt, 'the apply receipt persisted');
});

test('producer — derived idempotency: an existing reversal journal self-heals, never double-posts', async () => {
  const { client, stats, postCalls } = await runProducer({
    stage: 'canary',
    existingReversalRows: [{ id: 'lj-rev-existing' }]
  });
  assert.equal(stats.self_healed, 1);
  assert.equal(stats.reversed, 0);
  assert.equal(postCalls.length, 0, 'the ledger row is the source of truth — no second reversal');
  const merge = client.calls.find((c) => c.sql.includes("'{settlement_entry,reversal}'"));
  assert.ok(merge, 'the missing marker is healed off the found journal');
  assert.equal(JSON.parse(merge.params[3]).journal_id, 'lj-rev-existing');
});

test('producer — a missing settlement journal rests proposed (visible, no post)', async () => {
  const { stats, postCalls } = await runProducer({
    stage: 'canary',
    settlementJournalRows: []
  });
  assert.equal(stats.rested_proposed, 1);
  assert.equal(stats.reversed, 0);
  assert.equal(postCalls.length, 0);
});

test('producer — a throwing post leaves the card proposed and merges NO marker', async () => {
  const { client, stats } = await runProducer({
    stage: 'canary',
    postAdjustmentImpl: async () => { throw new Error('LEDGER_ADJUSTMENT_DATE_LOCKED'); }
  });
  assert.equal(stats.post_failures, 1);
  assert.equal(stats.reversed, 0);
  assert.ok(!client.calls.some((c) => c.sql.includes("'{settlement_entry,reversal}'")),
    'no marker without a posted reversal — the next sweep retries');
});

test('producer — an empty scoped documentIds is a zero-work no-op', async () => {
  const { stats } = await runProducer({ stage: 'canary', documentIds: [] });
  assert.equal(stats.gathered, 0);
});

// ── 5. FYI lane ───────────────────────────────────────────────────────

test('drafter input — settlement_reversals carries the correction + the bank line it matched', () => {
  const input = buildAskDraftInput({
    settlementReversals: [{
      document_id: 'doc-exxon-1',
      document_type: 'receipt',
      counterparty: 'Exxon',
      amount: 41.2,
      currency: 'USD',
      date: '2026-05-14',
      expense_account: '449 · Motor vehicle expenses',
      settlement_channel: 'personal_card',
      bank_line_date: '2026-05-16',
      bank_line_description: 'POS EXXON 4412'
    }]
  });
  const reversed = input.settlement_reversals[0];
  assert.equal(reversed.document_ref, 'document_1');
  assert.equal(reversed.bank_line_date, '2026-05-16');
  assert.equal(reversed.bank_line_description, 'POS EXXON 4412');
});

const CLIENT_ROW = {
  id: 'client-1', firm_id: 'firm-1', company_name: 'Honeybee Hills Apiary',
  jurisdiction: 'US', profile: { entityType: 'LLC' }
};
const REVERSAL_FYI_ROW = {
  document_id: 'doc-exxon-1',
  document_type: 'receipt',
  vendor_name: 'Exxon',
  customer_name: null,
  filename: 'exxon.pdf',
  total_amount: 41.2,
  currency: 'USD',
  document_date: '2026-05-14',
  settlement_entry: {
    ...SETTLEMENT_ENTRY,
    reversal: { journal_id: 'lj-rev-1', bank_transaction_id: 'tx-1', owner_notified: false }
  },
  bank_line_date: '2026-05-16',
  bank_line_description: 'POS EXXON 4412'
};
const REVERSAL_DRAFT = {
  subject: 'Your May books',
  message_markdown: '**Corrected: these turned out to be on your statement**\n- Exxon $41.20 …',
  summary: 'One reversal correction FYI.',
  items: [],
  statement_requests: [],
  document_asks: []
};

const runFyiDraft = async ({ reversalRows = [] } = {}) => {
  let drafterInput = null;
  const client = makeMockClient([
    { match: 'from clients', rows: [CLIENT_ROW] },
    { match: 'from client_capability_config', rows: [] },
    { match: "reversal'->>'owner_notified'", rows: reversalRows },
    { match: 'max(evaluated_at)', rows: [{ last_evaluated_at: '2026-07-05T08:00:00Z' }] },
    { match: 'insert into client_ask_batches', rows: [{ id: 'ask-batch-1', status: 'draft', payload: {} }] }
  ]);
  const result = await __draftClientAskBatchWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    draftFn: async (input) => {
      drafterInput = input;
      return { draft: REVERSAL_DRAFT, model: 'gpt-5.4', response_id: '' };
    }
  });
  return { client, result, drafterInput };
};

await test('draft — the reversal-FYI gather is marker-gated and reaches the drafter + batch payload', async () => {
  const { client, result, drafterInput } = await runFyiDraft({ reversalRows: [REVERSAL_FYI_ROW] });
  const gather = client.calls.find((c) => c.sql.includes("reversal'->>'owner_notified'"));
  assert.ok(gather, 'the reversal-FYI gather always runs (marker-gated, not flag-gated)');
  assert.ok(gather.sql.includes("coalesce(d.payload->'settlement_entry'->'reversal'->>'journal_id', '') <> ''"),
    'only POSTED reversals FYI');
  assert.ok(drafterInput, 'a reversal-only population still drafts');
  assert.equal(drafterInput.settlementReversals[0].document_id, 'doc-exxon-1');
  assert.equal(drafterInput.settlementReversals[0].bank_line_date, '2026-05-16');
  const insert = client.calls.find((c) => c.sql.includes('insert into client_ask_batches'));
  const payload = JSON.parse(insert.params[7]);
  assert.deepEqual(payload.settlement_reversal_fyi_document_ids, ['doc-exxon-1']);
  assert.equal(payload.input_stats.reversed_settlements, 1);
  assert.ok(result.batch, 'the draft landed');
});

await test('send — flips settlement_entry.reversal.owner_notified exactly once + audits the count', async () => {
  const batchRow = {
    id: 'ask-batch-1', firm_id: 'firm-1', client_id: 'client-1', status: 'draft',
    payload: { draft: REVERSAL_DRAFT, settlement_reversal_fyi_document_ids: ['doc-exxon-1'] }
  };
  const client = makeMockClient([
    { match: 'for update', rows: [batchRow] },
    { match: "'{settlement_entry,reversal,owner_notified}'", rows: [{ id: 'doc-exxon-1' }] },
    { match: "set status = 'sent'", rows: [{ ...batchRow, status: 'sent' }] }
  ]);
  await __sendClientAskBatchWithClient({ client, firmId: 'firm-1', batchId: 'ask-batch-1', clientId: 'client-1' });
  const flip = client.calls.find((c) => c.sql.includes("'{settlement_entry,reversal,owner_notified}'"));
  assert.ok(flip, 'the reversal FYI flip ran on send');
  assert.deepEqual(flip.params[1], ['doc-exxon-1']);
  assert.ok(flip.sql.includes("coalesce(payload->'settlement_entry'->'reversal'->>'journal_id', '') <> ''"),
    'guarded to reversed rows');
  assert.ok(flip.sql.includes("coalesce(payload->'settlement_entry'->'reversal'->>'owner_notified', '') = 'false'"),
    'guarded to still-false rows — idempotent');
  const audit = client.calls.find((c) => c.sql.includes('ask_batch.send'));
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.settlement_reversal_fyi_notified, 1);
});

await test('send — no reversal ids in the batch → no flip (back-compat)', async () => {
  const batchRow = {
    id: 'ask-batch-1', firm_id: 'firm-1', client_id: 'client-1', status: 'draft',
    payload: { draft: REVERSAL_DRAFT }
  };
  const client = makeMockClient([
    { match: 'for update', rows: [batchRow] },
    { match: "set status = 'sent'", rows: [{ ...batchRow, status: 'sent' }] }
  ]);
  await __sendClientAskBatchWithClient({ client, firmId: 'firm-1', batchId: 'ask-batch-1', clientId: 'client-1' });
  assert.ok(!client.calls.some((c) => c.sql.includes("'{settlement_entry,reversal,owner_notified}'")));
});

test('sendability — reversal FYIs alone never auto-send (standard digest)', () => {
  const reversalOnly = {
    draft: { items: [], statement_requests: [], document_asks: [] },
    settlement_reversal_fyi_document_ids: ['doc-exxon-1']
  };
  assert.equal(draftAskCount(reversalOnly), 0);
  assert.equal(isSendableDraft(reversalOnly), false);
});
