// Slice 4b — the settlement LEDGER ENTRY: producer + named writer + FYI lane
// (docs/donna-settlement-answer-and-ledger-entry-plan.md §3). Mock-pg +
// mock-fetch harness mirrors documentDispositionLlm.test.js. Pins:
//   1. the account parser's handed-ids-only sanitizer (exact / unique
//      case-insensitive match; inventions → null; garbage → fallback)
//   2. the proposal card validates the 034 contract and the producer's
//      shadow / act / below-floor / not-in-chart forks
//   3. the producer's flag gating (∅ inert), money-in exclusion, and
//      existing-card idempotency (act consumes the PERSISTED card, no re-ask)
//   4. the named writer: period-lock refusals, the journal payload receipt,
//      the payment_status flip + settlement_entry merge + explained-FYI
//      supersede, and the in-transaction audit with before_state
//   5. the FYI lane: drafter input recorded_settlements, batch payload
//      settlement_fyi_document_ids, the send chokepoint's exactly-once flip,
//      and that recorded FYIs alone do NOT make a draft auto-sendable

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSettlementAccountResponse,
  buildSettlementAccountUserPrompt,
  runDocumentSettlementEntriesForClient,
  getSettlementAccountConfidenceFloor,
  DEFAULT_SETTLEMENT_ACCOUNT_CONFIDENCE_FLOOR,
  SETTLEMENT_MONEY_IN_TYPES,
  SETTLEMENT_ENTRY_CHANNELS,
  DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY,
  DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE,
  documentSettlementProposalId,
  __buildSettlementProposalCard,
  __buildSettlementChecks
} from './documentSettlementEntry.js';
import { validateOperatorContract, PROPOSAL_CARD_SCHEMA } from './operatorContract.js';
import {
  postDocumentSettlementJournalWithClient,
  DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT,
  __draftClientAskBatchWithClient,
  __sendClientAskBatchWithClient
} from './firmDb.js';
import { buildAskDraftInput } from './askPipeline.js';
import { draftAskCount, isSendableDraft } from './askAutoSendProducer.js';

// RT-11b (2026-09-02): the disposition ceiling FOLLOWS THE PACK (reconciliation.
// disposition_ceiling, resolved from the client's canonical jurisdiction); env
// is the only override and no pack ⇒ the guard fails closed. The fixtures in
// this file carry display-string / packless jurisdictions, so the ceiling is
// pinned through the env override here (the same convention the family-matcher
// tests use for RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING). The pack path
// itself is pinned in dispositionMateriality.test.js and the RT-11b appliance
// fixture (materialityCeilingPackAppliancePgLifecycle.test.js).
process.env.DISPOSITION_MATERIALITY_CEILING = '500';

// ── Mock client / fetch (documentDispositionLlm.test.js pattern) ──────

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

const makeFetchOk = (responseBody) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: 'claude-opus-4-8-returned',
    content: [{ text: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody) }]
  })
});
const fetchMustNotRun = async () => {
  throw new Error('the strong model must not be called on this path');
};

const CHART = ['Motor vehicle expenses', 'Office operations', 'Suspense'];

const SETTLED_DOC_ROW = {
  id: 'doc-exxon-1',
  document_type: 'receipt',
  vendor_name: 'Exxon',
  customer_name: null,
  filename: 'exxon.pdf',
  total_amount: 41.2,
  currency: 'USD',
  document_date: '2026-05-14',
  payment_status: 'unpaid',
  updated_at: '2026-07-01T10:00:00Z',
  no_line_disposition: {
    disposition: 'auto_explain',
    materiality: 'immaterial',
    expense_kind: 'fuel',
    settlement_channel: 'personal_card',
    confidence: 0.92,
    owner_notified: false
  }
};
const OWNER_CONFIRMED_DOC_ROW = {
  ...SETTLED_DOC_ROW,
  id: 'doc-sonoran-2',
  vendor_name: 'Sonoran Property',
  total_amount: 831.35,
  no_line_disposition: {
    disposition: 'auto_explain',
    materiality: 'material',
    expense_kind: 'rent',
    settlement_channel: 'cash',
    confidence: 0.95,
    verdict_source: 'owner_reply',
    evidence_request_id: 'evr-son-1',
    owner_notified: true
  }
};

const GOOD_ACCOUNT = { account: 'Motor vehicle expenses', confidence: 0.9, reasoning: 'Fuel receipt.' };

// Canned-response keys (distinctive substrings within the producer's flow).
const cannedConfig = (rows) => ({ match: 'from client_capability_config', rows });
const cannedGather = (rows) => ({ match: "no_line_disposition'->>'settlement_channel'", rows });
const cannedExistingCard = (rows) => ({ match: 'from proposal_cards', rows });
const cannedLedgerAccount = (rows) => ({ match: 'from ledger_accounts', rows });
const cannedIdentity = (rows) => ({ match: 'from clients where firm_id', rows });
const cannedCardInsert = (rows) => ({ match: 'insert into proposal_cards', rows });

const FLAG_ROW = (stage) => ({
  flag_key: DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY, stage, source: 'manual', client_id: 'client-1'
});

const runProducer = async ({
  stage = null,
  gatherRows = [SETTLED_DOC_ROW],
  existingCardRows = [],
  ledgerAccountRows = [{ code: '449', name: 'Motor vehicle expenses', account_type: 'expense', tax_type: 'INPUTY24', canonical_role: null }],
  fetchImpl = makeFetchOk(GOOD_ACCOUNT),
  postJournalFn = null,
  documentIds = null
} = {}) => {
  const client = makeMockClient([
    cannedConfig(stage ? [FLAG_ROW(stage)] : []),
    cannedGather(gatherRows),
    ...gatherRows.map(() => cannedExistingCard(existingCardRows)),
    ...gatherRows.map(() => cannedLedgerAccount(ledgerAccountRows)),
    cannedIdentity([{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [], jurisdiction: 'US' }]),
    ...gatherRows.map((row) => cannedCardInsert([{ id: documentSettlementProposalId(row.id) }]))
  ]);
  const postCalls = [];
  const stats = await runDocumentSettlementEntriesForClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentIds,
    env: {},
    apiKeyOverride: 'test-key',
    modelOverride: 'claude-opus-4-8',
    fetchImpl,
    accountOptionsFn: async () => [...CHART],
    postJournalFn: postJournalFn || (async (args) => {
      postCalls.push(args);
      return { journal_id: `lj-${args.document.id}`, audit_event_id: '42' };
    })
  });
  return { client, stats, postCalls };
};

// ── Constants ─────────────────────────────────────────────────────────

test('constants — flag key, proposal type, channels, money-in lock-step, floor', () => {
  assert.equal(DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY, 'DOCUMENT_SETTLEMENT_LEDGER_ENTRY');
  assert.equal(DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE, 'document_settlement_entry');
  assert.deepEqual([...SETTLEMENT_ENTRY_CHANNELS], ['cash', 'personal_card']);
  assert.deepEqual([...SETTLEMENT_MONEY_IN_TYPES], ['sales_invoice', 'issued_receipt'],
    'lock-step with documentDispositionLlm MONEY_IN_TYPES — money-in cash settles are a different journal');
  assert.equal(documentSettlementProposalId('doc-1'), 'docsettle-doc-1');
  assert.equal(DEFAULT_SETTLEMENT_ACCOUNT_CONFIDENCE_FLOOR, 0.75);
  assert.equal(getSettlementAccountConfidenceFloor(), 0.75);
  assert.deepEqual(
    Object.freeze({ ...DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT }),
    { code: '901', name: 'Director loan', type: 'liability', canonical_role: 'liability.director_loan', tax_type: 'NONE' },
    'the DONNA_COA 901 seed is the owner-funds credit account (plan decision #2)'
  );
});

// ── Parser (handed-ids-only) ──────────────────────────────────────────

test('parser — exact chart name passes through with clamped confidence', () => {
  const out = parseSettlementAccountResponse(
    JSON.stringify({ account: 'Motor vehicle expenses', confidence: 0.9, reasoning: 'Fuel.' }),
    { accountOptions: CHART }
  );
  assert.equal(out.account, 'Motor vehicle expenses');
  assert.equal(out.confidence, 0.9);
  assert.equal(out.reasoning, 'Fuel.');
});

test('parser — a unique case-insensitive match canonicalizes to the chart spelling', () => {
  const out = parseSettlementAccountResponse(
    JSON.stringify({ account: 'motor VEHICLE expenses', confidence: 0.8, reasoning: '' }),
    { accountOptions: CHART }
  );
  assert.equal(out.account, 'Motor vehicle expenses');
});

test('parser — an invented account is refused (null), never ratified', () => {
  const out = parseSettlementAccountResponse(
    JSON.stringify({ account: 'Fuel & petrol (new)', confidence: 0.99, reasoning: '' }),
    { accountOptions: CHART }
  );
  assert.equal(out.account, null);
});

test('parser — garbage / non-object JSON falls back safe', () => {
  assert.equal(parseSettlementAccountResponse('not json at all', { accountOptions: CHART }).account, null);
  assert.equal(parseSettlementAccountResponse('[1,2]', { accountOptions: CHART }).account, null);
  assert.equal(parseSettlementAccountResponse(JSON.stringify({ confidence: 'NaN' }), { accountOptions: CHART }).confidence, 0);
});

// ── Prompt builder ────────────────────────────────────────────────────

test('prompt — doc header + disposition receipt + chart, never raw content', () => {
  const prompt = buildSettlementAccountUserPrompt({
    document: SETTLED_DOC_ROW,
    disposition: SETTLED_DOC_ROW.no_line_disposition,
    accountOptions: CHART,
    firmContext: null
  });
  assert.ok(prompt.includes('counterparty="Exxon"'));
  assert.ok(prompt.includes('settlement_channel=personal_card'));
  assert.ok(prompt.includes('expense_kind=fuel'));
  assert.ok(prompt.includes('- Motor vehicle expenses'));
  assert.ok(prompt.includes('- Suspense'));
});

// ── Card shape ────────────────────────────────────────────────────────

const buildCard = ({ proposal = GOOD_ACCOUNT, doc = SETTLED_DOC_ROW } = {}) => {
  const checks = __buildSettlementChecks({
    document: doc, proposal, confidenceFloor: 0.75
  });
  return {
    checks,
    card: __buildSettlementProposalCard({
      document: doc,
      disposition: doc.no_line_disposition,
      proposal,
      expenseAccountRow: { code: '449', name: 'Motor vehicle expenses', type: 'expense', tax_type: 'INPUTY24' },
      ownerFundsLabel: '901 · Director loan',
      authorityBasis: doc.no_line_disposition.verdict_source === 'owner_reply' ? 'owner_reply' : 'immaterial_auto_explain',
      checks,
      model: 'claude-opus-4-8'
    })
  };
};

test('card — validates the 034 operator contract and carries the receipt fields', () => {
  const { card, checks } = buildCard({});
  const { ok, errors } = validateOperatorContract(PROPOSAL_CARD_SCHEMA, card);
  assert.ok(ok, `contract violation: ${errors.join('; ')}`);
  assert.equal(card.proposal_id, 'docsettle-doc-exxon-1');
  assert.equal(card.type, DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE);
  assert.equal(card.triage_source, 'state_correction');
  assert.equal(card.writer, 'postDocumentSettlementJournalWithClient');
  assert.equal(card.reversibility, 'reversible_via_adjustment');
  assert.equal(card.review_mode, 'accountant_approval');
  assert.equal(card.blast_radius.documents, 1);
  assert.equal(card.blast_radius.client_visible, true);
  assert.equal(checks.status, 'pass');
  assert.equal(card.detail.authority_basis, 'immaterial_auto_explain');
  assert.equal(card.detail.owner_funds_account, '901 · Director loan');
  assert.ok(card.before_after[0].after.settlement_journal.includes('449 · Motor vehicle expenses'));
  assert.ok(card.before_after[0].after.settlement_journal.includes('901 · Director loan'));
});

test('card — an owner-confirmed settle carries the owner_reply authority basis', () => {
  const { card } = buildCard({ doc: OWNER_CONFIRMED_DOC_ROW });
  assert.equal(card.detail.authority_basis, 'owner_reply');
  assert.equal(card.detail.evidence_request_id, 'evr-son-1');
  assert.equal(card.detail.verdict_source, 'owner_reply');
});

test('checks — below-floor confidence is requires_review; a missing account is fail', () => {
  const below = __buildSettlementChecks({
    document: SETTLED_DOC_ROW,
    proposal: { account: 'Motor vehicle expenses', confidence: 0.4 },
    confidenceFloor: 0.75
  });
  assert.equal(below.status, 'requires_review');
  const missing = __buildSettlementChecks({
    document: SETTLED_DOC_ROW,
    proposal: { account: null, confidence: 0.99 },
    confidenceFloor: 0.75
  });
  assert.equal(missing.status, 'fail');
});

// ── Producer forks ────────────────────────────────────────────────────

test('producer — flag ∅ → disabled, byte-identical (no gather, no LLM)', async () => {
  const { client, stats, postCalls } = await runProducer({ stage: null, fetchImpl: fetchMustNotRun });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'flag_off');
  assert.ok(!client.calls.some((c) => c.sql.includes('from documents')), 'no gather ran');
  assert.equal(postCalls.length, 0);
});

test('producer — off/dry_run stages stay inert', async () => {
  for (const stage of ['off', 'dry_run']) {
    const { stats } = await runProducer({ stage, fetchImpl: fetchMustNotRun });
    assert.equal(stats.disabled, true, `${stage} must not observe`);
  }
});

test('producer — shadow: card minted + sized, NO post, NO receipt', async () => {
  const { client, stats, postCalls } = await runProducer({ stage: 'shadow' });
  assert.equal(stats.mode, 'shadow');
  assert.equal(stats.gathered, 1);
  assert.equal(stats.cards_minted, 1);
  assert.equal(stats.posted, 0);
  assert.equal(postCalls.length, 0);
  const cardInsert = client.calls.find((c) => c.sql.includes('insert into proposal_cards'));
  assert.ok(cardInsert, 'the proposal card persisted');
  assert.equal(cardInsert.params[0], 'docsettle-doc-exxon-1', 'deterministic one-card-per-doc id');
  assert.equal(cardInsert.params[4], DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE);
  assert.ok(!client.calls.some((c) => c.sql.includes('insert into apply_receipts')), 'no receipt at shadow');
});

test('producer — canary act: card minted + posted through the named writer + apply receipt', async () => {
  const { client, stats, postCalls } = await runProducer({ stage: 'canary' });
  assert.equal(stats.mode, 'act');
  assert.equal(stats.cards_minted, 1);
  assert.equal(stats.posted, 1);
  assert.deepEqual(stats.posted_document_ids, ['doc-exxon-1']);
  assert.equal(postCalls.length, 1);
  const post = postCalls[0];
  assert.equal(post.document.id, 'doc-exxon-1');
  assert.equal(post.expenseAccount.name, 'Motor vehicle expenses');
  assert.equal(post.expenseAccount.code, '449', 'chart row enrichment — never a name-only duplicate mint');
  assert.equal(post.settlement.settlement_channel, 'personal_card');
  assert.equal(post.authorityBasis, 'immaterial_auto_explain');
  const receipt = client.calls.find((c) => c.sql.includes('insert into apply_receipts'));
  assert.ok(receipt, 'the apply receipt persisted');
  assert.equal(receipt.params[4], 'docsettle-doc-exxon-1');
  assert.ok(client.calls.some((c) => c.sql.includes("update proposal_cards set status = 'applied'")),
    'the card flips applied');
});

test('producer — act + below-floor confidence: card rests proposed, no post', async () => {
  const { stats, postCalls } = await runProducer({
    stage: 'canary',
    fetchImpl: makeFetchOk({ account: 'Motor vehicle expenses', confidence: 0.5, reasoning: 'Unsure.' })
  });
  assert.equal(stats.cards_minted, 1);
  assert.equal(stats.posted, 0);
  assert.equal(stats.rested_proposed, 1);
  assert.equal(postCalls.length, 0);
});

test('producer — act + account not on the handed chart: card rests proposed with the fail check', async () => {
  const { stats, postCalls } = await runProducer({
    stage: 'canary',
    fetchImpl: makeFetchOk({ account: 'Invented account', confidence: 0.99, reasoning: '' }),
    ledgerAccountRows: []
  });
  assert.equal(stats.cards_minted, 1);
  assert.equal(stats.posted, 0);
  assert.equal(stats.rested_proposed, 1);
  assert.equal(postCalls.length, 0);
});

test('producer — existing card + shadow: skipped without a second model call', async () => {
  const { stats } = await runProducer({
    stage: 'shadow',
    existingCardRows: [{ id: 'docsettle-doc-exxon-1', status: 'proposed', check_status: 'pass', detail: {} }],
    fetchImpl: fetchMustNotRun
  });
  assert.equal(stats.cards_existing, 1);
  assert.equal(stats.cards_minted, 0);
});

test('producer — existing appliable card + act: posts from the PERSISTED card detail, no re-ask', async () => {
  const { stats, postCalls } = await runProducer({
    stage: 'canary',
    existingCardRows: [{
      id: 'docsettle-doc-exxon-1', status: 'proposed', check_status: 'pass',
      detail: {
        expense_account: 'Motor vehicle expenses', expense_account_code: '449',
        authority_basis: 'immaterial_auto_explain', model: 'claude-opus-4-8'
      }
    }],
    fetchImpl: fetchMustNotRun
  });
  assert.equal(stats.cards_existing, 1);
  assert.equal(stats.posted, 1);
  assert.equal(postCalls[0].expenseAccount.code, '449');
});

test('producer — existing below-floor card + act: rests proposed (the visible exception)', async () => {
  const { stats, postCalls } = await runProducer({
    stage: 'canary',
    existingCardRows: [{
      id: 'docsettle-doc-exxon-1', status: 'proposed', check_status: 'requires_review',
      detail: { expense_account: 'Motor vehicle expenses' }
    }],
    fetchImpl: fetchMustNotRun
  });
  assert.equal(stats.rested_proposed, 1);
  assert.equal(postCalls.length, 0);
});

test('producer — the gather excludes money-in kinds and keys on the settled channels', async () => {
  const { client } = await runProducer({ stage: 'shadow', gatherRows: [] });
  const gather = client.calls.find((c) => c.sql.includes("no_line_disposition'->>'settlement_channel'"));
  assert.ok(gather, 'the gather ran');
  assert.deepEqual(gather.params[2], ['cash', 'personal_card']);
  assert.deepEqual(gather.params[3], ['sales_invoice', 'issued_receipt'], 'money-in excluded');
  assert.ok(gather.sql.includes("payload->'no_line_disposition'->>'disposition' = 'auto_explain'"),
    'only settled verdicts gather');
  assert.ok(gather.sql.includes("coalesce(d.payload->'settlement_entry'->>'journal_id', '') = ''"),
    'a doc with an entry never re-gathers (idempotent)');
});

test('producer — owner-confirmed material settle posts with the owner_reply authority', async () => {
  const { postCalls } = await runProducer({
    stage: 'canary',
    gatherRows: [OWNER_CONFIRMED_DOC_ROW],
    fetchImpl: makeFetchOk({ account: 'Office operations', confidence: 0.85, reasoning: 'Rent.' }),
    ledgerAccountRows: []
  });
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].authorityBasis, 'owner_reply');
  assert.equal(postCalls[0].settlement.verdict_source, 'owner_reply');
  assert.equal(postCalls[0].settlement.evidence_request_id, 'evr-son-1');
});

// ── The named writer ──────────────────────────────────────────────────

const WRITER_DOC = {
  id: 'doc-exxon-1',
  document_type: 'receipt',
  vendor_name: 'Exxon',
  filename: 'exxon.pdf',
  total_amount: 41.2,
  currency: 'USD',
  document_date: '2026-05-14'
};
const writerResponses = ({
  existingJournal = [],
  lockedPeriod = [],
  beforeState = [{ payment_status: 'unpaid', settlement_entry: null, no_line_owner_notified: 'false' }]
} = {}) => [
  { match: 'select * from documents', rows: [WRITER_DOC] },
  { match: 'select jurisdiction, entity_type, profile', rows: [{jurisdiction:'us',profile:{}}] },
  { match: 'from ledger_journals lj', rows: existingJournal },
  { match: 'from close_periods', rows: lockedPeriod },
  { match: "payload->'settlement_entry' as settlement_entry", rows: beforeState },
  { match: 'insert into audit_events', rows: [{ id: 42 }] }
];

const runWriter = async ({ responses = writerResponses({}), overrides = {} } = {}) => {
  const client = makeMockClient(responses);
  const result = await postDocumentSettlementJournalWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    document: WRITER_DOC,
    expenseAccount: { account_code: '449', account_name: 'Motor vehicle expenses', xero_account_type: 'EXPENSE' },
    settlement: { settlement_channel: 'personal_card', verdict_source: null, evidence_request_id: null },
    authorityBasis: 'immaterial_auto_explain',
    model: 'claude-opus-4-8',
    ...overrides
  });
  return { client, result };
};

await test('writer — happy path: journal + lines + doc flip + supersede + audit, all receipted', async () => {
  const { client, result } = await runWriter({});

  const journalInsert = client.calls.find((c) => c.sql.includes('insert into ledger_journals'));
  assert.ok(journalInsert, 'the journal row landed');
  assert.equal(journalInsert.params[3], 'document_settlement');
  assert.equal(journalInsert.params[4], 'doc-exxon-1');
  const journalPayload = JSON.parse(journalInsert.params[8]);
  assert.equal(journalPayload.source, 'native_ledger_document_settlement');
  assert.equal(journalPayload.authority_basis, 'immaterial_auto_explain');
  assert.equal(journalPayload.model, 'claude-opus-4-8');
  assert.equal(journalPayload.settlement.document_id, 'doc-exxon-1');
  assert.equal(journalPayload.settlement.settlement_channel, 'personal_card');

  const lineInserts = client.calls.filter((c) => c.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 2, 'one debit + one credit');
  assert.equal(lineInserts[0].params[8], 'debit');
  assert.equal(lineInserts[0].params[5], '449');
  assert.equal(lineInserts[1].params[8], 'credit');
  assert.equal(lineInserts[1].params[5], '901', 'CR 901 Director loan');

  const docUpdate = client.calls.find((c) => c.sql.includes("set payment_status = 'paid'"));
  assert.ok(docUpdate, 'the document flipped to the persisted settled state');
  assert.ok(docUpdate.sql.includes("'{no_line_disposition,owner_notified}', 'true'::jsonb"),
    'the recorded-FYI supersedes the weaker explained-FYI — never two digest lines');
  const merge = JSON.parse(docUpdate.params[3]);
  assert.equal(merge.settlement_entry.owner_notified, false, 'the recorded FYI is owed');
  assert.equal(merge.settlement_entry.journal_id, result.journal_id);
  assert.equal(merge.settlement_entry.expense_account, '449 · Motor vehicle expenses');
  assert.equal(merge.settlement_entry.owner_funds_account, '901 · Director loan');
  assert.equal(merge.settlement_entry.authority_basis, 'immaterial_auto_explain');
  assert.equal(merge.settlement_entry.settlement_channel, 'personal_card');

  const audit = client.calls.find((c) => c.sql.includes("'ledger.post_document_settlement'"));
  assert.ok(audit, 'the audit event is in-transaction');
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.before_state.payment_status, 'unpaid', 'before_state rides the audit (reversible)');
  assert.equal(metadata.authority_basis, 'immaterial_auto_explain');
  assert.equal(metadata.model, 'claude-opus-4-8');
  assert.equal(result.audit_event_id, '42');
  assert.ok(result.journal_id, 'the deterministic journal id returns');
});

await test('writer — an existing journal inside a locked period refuses 409', async () => {
  await assert.rejects(
    runWriter({ responses: writerResponses({ existingJournal: [{ id: 'lj-1', close_period_id: 'cp-1' }] }) }),
    (error) => error.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && error.statusCode === 409
  );
});

await test('writer — a journal date inside a locked period refuses 409 (dated-adjustment path)', async () => {
  await assert.rejects(
    runWriter({ responses: writerResponses({ lockedPeriod: [{ id: 'cp-2' }] }) }),
    (error) => error.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && error.statusCode === 409
  );
});

await test('writer — builder refusals propagate (missing expense account)', async () => {
  await assert.rejects(
    runWriter({ overrides: { expenseAccount: {} } }),
    (error) => error.code === 'LEDGER_MISSING_COUNTERPARTY_ACCOUNT'
  );
});

await test('writer — a vanished document aborts the transaction (404, nothing silent)', async () => {
  await assert.rejects(
    runWriter({ responses: writerResponses({ beforeState: [] }) }),
    (error) => error.code === 'DOCUMENT_SETTLEMENT_DOC_NOT_FOUND'
  );
});

// ── FYI lane ──────────────────────────────────────────────────────────

test('drafter input — recorded_settlements carries the posted receipt fields', () => {
  const input = buildAskDraftInput({
    recordedSettlements: [{
      document_id: 'doc-exxon-1',
      document_type: 'receipt',
      counterparty: 'Exxon',
      amount: 41.2,
      currency: 'USD',
      date: '2026-05-14',
      expense_account: '449 · Motor vehicle expenses',
      settlement_channel: 'personal_card'
    }]
  });
  const recorded = input.recorded_settlements[0];
  assert.equal(recorded.document_ref, 'document_1');
  assert.equal(recorded.expense_account, '449 · Motor vehicle expenses');
  assert.equal(recorded.settlement_channel, 'personal_card');
});

const CLIENT_ROW = {
  id: 'client-1', firm_id: 'firm-1', company_name: 'Honeybee Hills Apiary',
  jurisdiction: 'US', profile: { entityType: 'LLC' }
};
const RECORDED_FYI_ROW = {
  document_id: 'doc-exxon-1',
  document_type: 'receipt',
  vendor_name: 'Exxon',
  customer_name: null,
  filename: 'exxon.pdf',
  total_amount: 41.2,
  currency: 'USD',
  document_date: '2026-05-14',
  settlement_entry: {
    journal_id: 'lj-1',
    expense_account: '449 · Motor vehicle expenses',
    settlement_channel: 'personal_card',
    owner_notified: false
  }
};
const RECORDED_DRAFT = {
  subject: 'Your June books',
  message_markdown: '**Recorded as paid from your own funds**\n- Exxon $41.20 …',
  summary: 'One recorded settlement FYI.',
  items: [],
  statement_requests: [],
  document_asks: []
};

const runFyiDraft = async ({ settlementRows = [] } = {}) => {
  let drafterInput = null;
  const client = makeMockClient([
    { match: 'from clients', rows: [CLIENT_ROW] },
    { match: 'from client_capability_config', rows: [] },
    { match: 'ai_suggestion_status', rows: [] },
    { match: 'coded_account', rows: [] },
    { match: 'material_auto_fyi', rows: [] },
    { match: 'coding_auto_post', rows: [] },
    { match: "no_line_disposition'->>'owner_notified'", rows: [] },
    { match: "settlement_entry'->>'owner_notified'", rows: settlementRows },
    { match: 'statement_summary', rows: [] },
    { match: 'from client_evidence_requests', rows: [] },
    { match: 'max(evaluated_at)', rows: [{ last_evaluated_at: '2026-07-05T08:00:00Z' }] },
    { match: 'insert into client_ask_batches', rows: [{ id: 'ask-batch-1', status: 'draft', payload: {} }] }
  ]);
  const result = await __draftClientAskBatchWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    draftFn: async (input) => {
      drafterInput = input;
      return { draft: RECORDED_DRAFT, model: 'gpt-5.4', response_id: '' };
    }
  });
  return { client, result, drafterInput };
};

await test('draft — the settlement-FYI gather is marker-gated and reaches the drafter + batch payload', async () => {
  const { client, result, drafterInput } = await runFyiDraft({ settlementRows: [RECORDED_FYI_ROW] });
  const gather = client.calls.find((c) => c.sql.includes("settlement_entry'->>'owner_notified'"));
  assert.ok(gather, 'the settlement-FYI gather always runs (marker-gated, not flag-gated)');
  assert.ok(gather.sql.includes("j.status in ('posted','closed') and j.reversed_at is null"),
    'only POSTED entries FYI');
  assert.ok(drafterInput, 'a recorded-settlement-only population still drafts');
  assert.equal(drafterInput.recordedSettlements[0].document_id, 'doc-exxon-1');
  assert.equal(drafterInput.recordedSettlements[0].expense_account, '449 · Motor vehicle expenses');
  const insert = client.calls.find((c) => c.sql.includes('insert into client_ask_batches'));
  const payload = JSON.parse(insert.params[7]);
  assert.deepEqual(payload.settlement_fyi_document_ids, ['doc-exxon-1']);
  assert.equal(payload.input_stats.recorded_settlements, 1);
  assert.ok(result.batch, 'the draft landed');
});

await test('draft — no settlement markers → empty lane, nothing_to_ask stays intact', async () => {
  const { result } = await runFyiDraft({ settlementRows: [] });
  assert.equal(result.batch, null);
  assert.equal(result.reason, 'nothing_to_ask');
});

await test('send — flips settlement_entry.owner_notified exactly once for the batch ids + audits the count', async () => {
  const batchRow = {
    id: 'ask-batch-1', firm_id: 'firm-1', client_id: 'client-1', status: 'draft',
    payload: { draft: RECORDED_DRAFT, settlement_fyi_document_ids: ['doc-exxon-1'] }
  };
  const client = makeMockClient([
    { match: 'for update', rows: [batchRow] },
    { match: "'{settlement_entry,owner_notified}'", rows: [{ id: 'doc-exxon-1' }] },
    { match: "set status = 'sent'", rows: [{ ...batchRow, status: 'sent' }] }
  ]);
  await __sendClientAskBatchWithClient({ client, firmId: 'firm-1', batchId: 'ask-batch-1', clientId: 'client-1' });
  const flip = client.calls.find((c) => c.sql.includes("'{settlement_entry,owner_notified}'"));
  assert.ok(flip, 'the settlement FYI flip ran on send');
  assert.deepEqual(flip.params[1], ['doc-exxon-1']);
  assert.ok(flip.sql.includes("coalesce(payload->'settlement_entry'->>'journal_id', '') <> ''"),
    'guarded to posted rows');
  assert.ok(flip.sql.includes("coalesce(payload->'settlement_entry'->>'owner_notified', '') = 'false'"),
    'guarded to still-false rows — idempotent');
  const audit = client.calls.find((c) => c.sql.includes('ask_batch.send'));
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.settlement_fyi_notified, 1);
});

await test('send — no settlement ids in the batch → no flip (back-compat)', async () => {
  const batchRow = {
    id: 'ask-batch-1', firm_id: 'firm-1', client_id: 'client-1', status: 'draft',
    payload: { draft: RECORDED_DRAFT }
  };
  const client = makeMockClient([
    { match: 'for update', rows: [batchRow] },
    { match: "set status = 'sent'", rows: [{ ...batchRow, status: 'sent' }] }
  ]);
  await __sendClientAskBatchWithClient({ client, firmId: 'firm-1', batchId: 'ask-batch-1', clientId: 'client-1' });
  assert.ok(!client.calls.some((c) => c.sql.includes("'{settlement_entry,owner_notified}'")));
});

test('sendability — recorded-settlement FYIs alone never auto-send (standard digest)', () => {
  const recordedOnly = {
    draft: { items: [], statement_requests: [], document_asks: [] },
    settlement_fyi_document_ids: ['doc-exxon-1']
  };
  assert.equal(draftAskCount(recordedOnly), 0);
  assert.equal(isSendableDraft(recordedOnly), false);
});

// ── F1 — the settlement post is a terminalizing auto path: the deterministic
// immateriality ceiling binds the 'immaterial_auto_explain' authority basis
// (defense-in-depth behind the parser-side ceiling); the owner's word exempts.
test('checks — F1: an immaterial_auto_explain entry above the ceiling fails (rests proposed); owner_reply is exempt', () => {
  const bigDoc = { ...SETTLED_DOC_ROW, total_amount: 900 };
  const held = __buildSettlementChecks({
    document: bigDoc,
    proposal: { account: 'Motor vehicle expenses', confidence: 0.95 },
    confidenceFloor: 0.75,
    authorityBasis: 'immaterial_auto_explain',
    materialityCeiling: 500
  });
  assert.equal(held.status, 'fail', 'above-ceiling unprompted settle refuses to post — the visible exception');
  assert.ok(held.checks.some((c) => c.name === 'materiality_ceiling' && c.status === 'fail'));

  const ownerAuthorized = __buildSettlementChecks({
    document: bigDoc,
    proposal: { account: 'Motor vehicle expenses', confidence: 0.95 },
    confidenceFloor: 0.75,
    authorityBasis: 'owner_reply',
    materialityCeiling: 500
  });
  assert.equal(ownerAuthorized.status, 'pass', 'the owner\'s answer IS the material authorization');

  const below = __buildSettlementChecks({
    document: SETTLED_DOC_ROW,
    proposal: { account: 'Motor vehicle expenses', confidence: 0.95 },
    confidenceFloor: 0.75,
    authorityBasis: 'immaterial_auto_explain',
    materialityCeiling: 500
  });
  assert.equal(below.status, 'pass', 'below the ceiling nothing changes');
});

// ── The #1748 shape (2026-08-19 follow-up): a seated non-claude rung ──
// decides the expense-account pick keyless over the compatible endpoint; an
// active policy with no endpoint fails LOUD; transport-class failures skip
// the doc (no null-account card off an HTTP error); a mismatch aborts.

const Q7_POLICY = { deciding_model: 'qwen/qwen3.8-27b', basis: 'experiment' };
const setCompatibleEnv = () => {
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://compat.test/v1';
  process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-compat';
};
const clearCompatibleEnv = () => {
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
};
const compatibleFetchOk = (responseBody, seen = [], servedModel = 'qwen/qwen3.8-27b') => async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body) });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      model: servedModel,
      choices: [{ message: { content: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody) } }],
      usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }
    })
  };
};

const policyProducerClient = ({ gatherRows = [SETTLED_DOC_ROW] } = {}) => makeMockClient([
  cannedConfig([FLAG_ROW('shadow')]),
  cannedGather(gatherRows),
  ...gatherRows.map(() => cannedExistingCard([])),
  ...gatherRows.map(() => cannedLedgerAccount([{ code: '449', name: 'Motor vehicle expenses', account_type: 'expense', tax_type: 'INPUTY24', canonical_role: null }])),
  cannedIdentity([{ id: 'client-1', company_name: 'Honeybee Hills Apiary LLC', legal_names: [], jurisdiction: 'US' }]),
  ...gatherRows.map((row) => cannedCardInsert([{ id: documentSettlementProposalId(row.id) }]))
]);

test('policy — a seated non-claude rung does NOT require the Anthropic key: keyless producer decides over the compatible endpoint; the card detail carries policy_basis (Kari, 2026-08-19)', async () => {
  setCompatibleEnv();
  try {
    const seen = [];
    const client = policyProducerClient({});
    const stats = await runDocumentSettlementEntriesForClient({
      client, firmId: 'firm-1', clientId: 'client-1', env: {},
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: compatibleFetchOk(GOOD_ACCOUNT, seen),
      accountOptionsFn: async () => [...CHART],
      postJournalFn: async () => ({ journal_id: 'lj-x', audit_event_id: '1' })
    });
    assert.notEqual(stats.disabled_reason, 'no_anthropic_api_key',
      'choosing qwen must never require an Anthropic key');
    assert.equal(stats.cards_minted, 1);
    assert.equal(seen.length, 1, 'the rung decided — over the compatible endpoint, never anthropic');
    assert.equal(seen[0].url, 'https://compat.test/v1/chat/completions');
    assert.equal(seen[0].body.model, 'qwen/qwen3.8-27b');

    const insert = client.calls.find((c) => c.sql.includes('insert into proposal_cards'));
    assert.ok(insert, 'the card is the durable receipt');
    const detailParam = (insert.params || []).find((p) => typeof p === 'string' && p.includes('policy_basis'));
    assert.ok(detailParam, 'the card carries the policy receipt');
    const parsed = JSON.parse(detailParam);
    const detail = parsed.detail || parsed;
    assert.equal(detail.policy_basis, 'experiment');
    assert.equal(detail.policy_model, 'qwen/qwen3.8-27b');
    assert.equal(detail.model_source, 'response_proven');
  } finally {
    clearCompatibleEnv();
  }
});

test('policy — an active policy with no compatible endpoint fails LOUD after the flag gate: policy_endpoint_unconfigured', async () => {
  clearCompatibleEnv();
  const client = makeMockClient([cannedConfig([FLAG_ROW('shadow')])]);
  const stats = await runDocumentSettlementEntriesForClient({
    client, firmId: 'firm-1', clientId: 'client-1', env: {},
    apiKeyOverride: 'test-key', decidingPolicy: Q7_POLICY,
    accountOptionsFn: async () => [...CHART],
    postJournalFn: async () => ({})
  });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'policy_endpoint_unconfigured',
    'never a silent fallback to the strong model mid-experiment');
  assert.ok(!client.calls.some((c) => c.sql.includes("settlement_channel'")), 'nothing gathered');
});

test('policy — no policy + no key stays the historical no_anthropic_api_key refusal', async () => {
  const client = makeMockClient([cannedConfig([FLAG_ROW('shadow')])]);
  const stats = await runDocumentSettlementEntriesForClient({
    client, firmId: 'firm-1', clientId: 'client-1', env: {},
    apiKeyOverride: '',
    accountOptionsFn: async () => [...CHART],
    postJournalFn: async () => ({})
  });
  assert.equal(stats.disabled_reason, 'no_anthropic_api_key');
});

test('policy — a transport-class failure skips the doc: NO null-account card minted off an HTTP error', async () => {
  setCompatibleEnv();
  try {
    const client = policyProducerClient({});
    const stats = await runDocumentSettlementEntriesForClient({
      client, firmId: 'firm-1', clientId: 'client-1', env: {},
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      accountOptionsFn: async () => [...CHART],
      postJournalFn: async () => ({})
    });
    assert.equal(stats.transport_failures, 1);
    assert.equal(stats.cards_minted, 0);
    assert.ok(!client.calls.some((c) => c.sql.includes('insert into proposal_cards')),
      'a null-account card would freeze the proposal on junk (the existing-card short-circuit never re-asks)');
  } finally {
    clearCompatibleEnv();
  }
});

test('policy — mismatch guard: an endpoint attesting a DIFFERENT model aborts the sweep, nothing minted', async () => {
  setCompatibleEnv();
  try {
    const client = policyProducerClient({});
    const stats = await runDocumentSettlementEntriesForClient({
      client, firmId: 'firm-1', clientId: 'client-1', env: {},
      apiKeyOverride: '', decidingPolicy: Q7_POLICY,
      fetchImpl: compatibleFetchOk(GOOD_ACCOUNT, [], 'some-other-loaded-model'),
      accountOptionsFn: async () => [...CHART],
      postJournalFn: async () => ({})
    });
    assert.equal(stats.aborted_reason, 'policy_model_mismatch');
    assert.equal(stats.cards_minted, 0);
    assert.ok(!client.calls.some((c) => c.sql.includes('insert into proposal_cards')));
  } finally {
    clearCompatibleEnv();
  }
});
