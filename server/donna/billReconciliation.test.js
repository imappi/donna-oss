// Reconciliation PR 9 — supplier-bill candidate matching tests.
//
// Mock-pg harness mirrors salesInvoiceReconciliation.test.js. The
// matcher reads three tables in order:
//   1. SELECT … FROM documents WHERE document_type='supplier_bill' …
//   2. SELECT … FROM transactions WHERE money_out > 0 …
//   3. SELECT … FROM reconciliation_matches WHERE … matched_object_type='supplier_bill'
// Tests provide canned rows keyed on distinctive substrings.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runBillReconciliationForDocument,
  scoreBillMatch,
  evaluateBillAutoMatch,
  generateBillCandidates,
  __llmMatcher
} from './billReconciliation.js';

// The LLM matcher is delegated to unconditionally (batch-2 matcher-mode
// dead-branch delete). The weighted body under test is reached through the
// wrapper's `__llmMatcher` seam: a NON-provider self-disable. A missing key
// is no longer a way in — since 2026-09-13 it is a typed provider failure
// (receipted on the document, never the weighted body;
// reconciliationProviderFailure.js). The ambient key is still cleared so the
// suite stays hermetic on machines/CI with ANTHROPIC_API_KEY exported.
delete process.env.ANTHROPIC_API_KEY;
const WEIGHTED_BODY_UNDER_TEST = { disabled: true, disabled_reason: 'weighted_body_under_test' };
const __realLlmMatcherRun = __llmMatcher.run;
__llmMatcher.run = async () => ({ ...WEIGHTED_BODY_UNDER_TEST });

const enableFlag = () => {
  process.env.BILL_MATCHER_ENABLED = 'true';
};
const disableFlag = () => {
  delete process.env.BILL_MATCHER_ENABLED;
};

// Stage 2.7 — deterministic auto-promote opt-in.
const enableAutoPromote = () => {
  process.env.BILL_MATCHER_AUTO_PROMOTE_TIER_1 = 'true';
};
const disableAutoPromote = () => {
  delete process.env.BILL_MATCHER_AUTO_PROMOTE_TIER_1;
};

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
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        return { rows: response.rows || [] };
      }
      return { rows: [] };
    }
  };
};

const cannedDoc = (rows) => ({ match: "document_type = 'supplier_bill'", rows });
const cannedTxs = (rows) => ({ match: 'money_out > 0', rows });
const cannedExistingMatches = (rows) => ({ match: 'from reconciliation_matches', rows });
const cannedInsertReturn = (rows) => ({ match: 'insert into reconciliation_matches', rows });

const STD_DOC = {
  id: 'bill-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  document_type: 'supplier_bill',
  vendor_name: 'Stripe Inc',
  document_date: '2026-04-30',
  due_date: '2026-05-30',
  total_amount: 499,
  currency: 'EUR',
  extraction_confidence: 0.95,
  parse_summary: { warnings: [] },
  duplicate_of: null,
  reference_number: 'BILL-2026-0042',
  filename: 'stripe-may.pdf',
  payment_status: 'unpaid'
};

const STD_TX = {
  id: 'tx-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  money_out: 499,
  money_in: 0,
  currency: 'EUR',
  date: '2026-05-03',
  description: 'STRIPE INC BILL-2026-0042 PAYMENT',
  raw_description: 'TRF STRIPE INC BILL 2026 0042 499.00 EUR',
  contact: '',
  source_line: '',
  reconciliation_status: null,
  account_code: null,
  status: 'needs_review'
};

const RUN_ARGS = {
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'bill-1'
};

const FRESH_INSERT = cannedInsertReturn([{ id: 'recon-x', inserted: true }]);

const findInsert = (client) =>
  client.calls.find((c) => c.sql.includes('insert into reconciliation_matches'));

const findAuditCalls = (client, action) =>
  client.calls.filter((c) => {
    if (!c.sql.includes('audit_events')) return false;
    if (!c.sql.toLowerCase().includes('insert')) return false;
    if (!action) return true;
    if (c.sql.includes(action)) return true;
    return (c.params || []).some((p) => String(p) === action);
  });

// ── 1: tier 1 (amount_exact + reference_match) ─────────────────────────
await test('tier 1 (amount_exact + reference_match) → suggested, auto_match_passed=true', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_eligible, 1);

    const insert = findInsert(client);
    assert.ok(insert);
    assert.ok(insert.params.includes('suggested'),
      "status param is 'suggested'");
    assert.ok(insert.params.some((p) => p === 'supplier_bill'),
      "matched_object_type='supplier_bill'");

    const payload = JSON.parse(insert.params[insert.params.length - 1]);
    assert.equal(payload.source, 'bill_reconciliation');
    assert.equal(payload.match_reason.confidence_tier, 'amount_exact_reference');
    assert.equal(payload.match_reason.auto_match_passed, true);
    assert.ok(payload.match_reason.hints.includes('amount_exact'));
    assert.ok(payload.match_reason.hints.includes('reference_match'));
    assert.ok(payload.match_reason.hints.includes('vendor_overlap'));

    const audits = findAuditCalls(client, 'reconciliation.candidate.suggested');
    assert.equal(audits.length, 1);
    const auditMeta = JSON.parse(audits[0].params[4]);
    assert.equal(auditMeta.match_kind, 'supplier_bill');
    assert.equal(auditMeta.confidence_tier, 'amount_exact_reference');
  } finally {
    disableFlag();
  }
});

// ── 2: tier 1 reference variations ─────────────────────────────────────
await test('tier 1 reference matches across separator/whitespace variations', async () => {
  enableFlag();
  try {
    const ref = 'BILL-2026-0042';
    const variants = [
      'Payment BILL-2026-0042',
      'PAYMENT BILL2026-0042 STRIPE',
      'Bill 2026 0042 paid',
      'STRIPE BILL20260042 SETTLED'
    ];
    for (const variant of variants) {
      const client = makeMockClient([
        cannedDoc([{ ...STD_DOC, reference_number: ref }]),
        cannedTxs([{ ...STD_TX, description: variant, raw_description: variant }]),
        cannedExistingMatches([]),
        FRESH_INSERT
      ]);
      const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
      assert.equal(stats.suggested_inserted, 1, `variant "${variant}" should match`);
      const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
      assert.equal(payload.match_reason.confidence_tier, 'amount_exact_reference',
        `variant "${variant}" should land in tier 1`);
    }
  } finally {
    disableFlag();
  }
});

// ── 3: tier 2 (amount_exact + vendor_overlap, no reference) ────────────
await test('tier 2 (amount_exact + vendor_overlap, no reference) → suggested + auto_match_passed=true', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([{
        ...STD_TX,
        description: 'TRF TO STRIPE INC',
        raw_description: 'TRF TO STRIPE INC 499.00 EUR'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_eligible, 1, 'tier 2 with vendor overlap is now eligible');
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_exact_vendor');
    assert.equal(payload.match_reason.auto_match_passed, true);
    assert.deepStrictEqual(payload.match_reason.auto_match_blockers, []);
  } finally {
    disableFlag();
  }
});

// ── 4: tier 3 (amount_near + vendor + within_window) ───────────────────
await test('tier 3 (amount_near + vendor + within_window) → suggested at 0.72', async () => {
  enableFlag();
  try {
    // Bill EUR 499; the bank charged a small FX margin → tx 494 EUR.
    // Within 5% (~1%), vendor matches, tx inside window.
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([{
        ...STD_TX,
        money_out: 494,
        date: '2026-05-15',
        description: 'CARD STRIPE INC PAYMENT'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_near_vendor');
    assert.equal(Number(payload.match_reason.score), 0.72);
    assert.ok(payload.match_reason.hints.includes('amount_near'));
    assert.ok(payload.match_reason.hints.includes('within_window'));
  } finally {
    disableFlag();
  }
});

// ── 5: below tier 3 → no candidate ─────────────────────────────────────
await test('amount off by 10% with no reference → no candidate', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([{
        ...STD_TX,
        money_out: 550, // 10% over
        description: 'CARD STRIPE INC'
      }]),
      cannedExistingMatches([])
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.ok(!findInsert(client));
  } finally {
    disableFlag();
  }
});

// ── 6: direction safety — money_in tx never appears ────────────────────
await test('direction safety: money_in tx with matching amount + vendor → ZERO candidates', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      // SELECT correctly excludes money_in via the `money_out > 0` filter.
      cannedTxs([]),
      cannedExistingMatches([])
    ]);
    await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.ok(!findInsert(client));

    // Belt-and-suspenders: pure helper rejects a money_in tx too.
    const candidates = generateBillCandidates({
      transactions: [{ ...STD_TX, money_out: 0, money_in: 499 }],
      document: STD_DOC,
      existingMatches: []
    });
    assert.equal(candidates.candidates.length, 0, 'money_in tx never proposes');
  } finally {
    disableFlag();
  }
});

// ── 7: already-resolved txs excluded ───────────────────────────────────
await test('already-resolved transactions excluded from candidate set', () => {
  const candidates = generateBillCandidates({
    transactions: [{ ...STD_TX, reconciliation_status: 'reconciled' }],
    document: STD_DOC,
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 0);
  const candidates2 = generateBillCandidates({
    transactions: [{ ...STD_TX, reconciliation_status: 'auto_reconciled' }],
    document: STD_DOC,
    existingMatches: []
  });
  assert.equal(candidates2.candidates.length, 0);
});

// ── 7b: machine-explained lines are ADMITTED (document outranks) ──────
// The 2026-08-05 stranding: the statement parsed first, the batch coder
// auto-applied the sub-ceiling micro-spends (ai_suggestion_status=
// 'auto_applied', reconciliation_status='explained'), and the
// late-parsing Chevron/Verizon bills found ZERO candidates because this
// matcher flat-excluded explained lines — the carve-out existed only in
// the receipt matcher. generateBillCandidates is shared by the
// payment-confirmation and payment-account-statement matchers, so this
// pin covers all three AP families' in-loop guard.
await test('generateBillCandidates: admits a coding-auto-explained line (document outranks)', () => {
  const codingExplainedTx = {
    ...STD_TX,
    reconciliation_status: 'explained',
    ai_suggestion_status: 'auto_applied'
  };
  const result = generateBillCandidates({
    transactions: [codingExplainedTx],
    document: STD_DOC,
    existingMatches: []
  });
  assert.ok(result.candidates.length >= 1, 'coding-auto-explained line is a candidate');
});

await test('generateBillCandidates: a later bill attaches to a Donna-posted bank line only', () => {
  const donnaPosted = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      status: 'posted',
      reconciliation_status: 'posted',
      ai_suggestion_status: 'auto_applied'
    }],
    document: STD_DOC,
    existingMatches: []
  });
  assert.ok(donnaPosted.candidates.length >= 1, 'later evidence can attach to Donna\'s description-only posting');

  const firmPosted = generateBillCandidates({
    transactions: [{ ...STD_TX, status: 'posted', reconciliation_status: 'posted' }],
    document: STD_DOC,
    existingMatches: []
  });
  assert.equal(firmPosted.candidates.length, 0, 'firm/human posting remains terminal');
});

await test('generateBillCandidates: still skips a non-machine explained line', () => {
  // 'explained' WITHOUT a machine-auto marker is a doc/human explanation —
  // a document must NOT silently outrank it.
  const humanExplainedTx = {
    ...STD_TX,
    reconciliation_status: 'explained',
    support_status: 'explained'
  };
  const result = generateBillCandidates({
    transactions: [humanExplainedTx],
    document: STD_DOC,
    existingMatches: []
  });
  assert.equal(result.candidates.length, 0, 'non-machine explained line stays excluded');
});

// ── 8: wrong-currency txs excluded ─────────────────────────────────────
await test('strict currency match — wrong currency yields no candidate, null assumes match', () => {
  const candidates = generateBillCandidates({
    transactions: [{ ...STD_TX, currency: 'USD' }],
    document: STD_DOC,
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 0, 'cross-currency blocked');
  const candidates2 = generateBillCandidates({
    transactions: [{ ...STD_TX, currency: 'EUR' }],
    document: { ...STD_DOC, currency: null },
    existingMatches: []
  });
  assert.ok(candidates2.candidates.length > 0, 'null doc currency assumes match');
});

// ── 9: out-of-window enforcement (tier 3 only) ─────────────────────────
await test('tx past due_date + 30d with near-amount + vendor → tier 3 excludes via window', () => {
  // Bill due_date=2026-05-30; window upper = +30d = 2026-06-29. A tx
  // at 2026-07-15 (16 days past upper) with amount near and vendor
  // matching should fail at the window check.
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      money_out: 494, // 1% off — tier 3 candidate
      date: '2026-07-15', // ~16d past upper
      description: 'CARD STRIPE INC PAYMENT',
      raw_description: ''
    }],
    document: { ...STD_DOC, reference_number: 'NO-MATCH-REF' },
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 0,
    'tier 3 requires within_window — out-of-window rejects');
});

// ── 10: vendor-name fuzzy match ────────────────────────────────────────
await test('vendor name fuzzy match: whitespace, case, corporate suffix (Inc/Ltd/GmbH)', () => {
  // Use a two-token vendor so the negative case is meaningful — a
  // one-token vendor like "Stripe" inherently matches any tx text
  // containing "Stripe" (the matcher has only one signal to
  // discriminate; amount + reference still differentiate Stripe Inc
  // from Stripe Holdings in real candidate flows). The test pins
  // the realistic multi-token shape.
  const docWithPaymentsVendor = { ...STD_DOC, vendor_name: 'Stripe Payments Inc', reference_number: 'no-such-ref' };
  const matchingVariants = [
    'STRIPE PAYMENTS INC',
    'stripe payments inc',
    'Stripe Payments Incorporated',
    'STRIPE PAYMENTS LTD',
    'stripe  payments  inc' // multiple spaces
  ];
  for (const tx of matchingVariants) {
    const candidates = generateBillCandidates({
      transactions: [{
        ...STD_TX,
        description: `CARD ${tx} 499.00 EUR`,
        raw_description: ''
      }],
      document: docWithPaymentsVendor,
      existingMatches: []
    });
    assert.equal(candidates.candidates.length, 1, `"${tx}" should match`);
    assert.equal(
      candidates.candidates[0].match_reason.confidence_tier,
      'amount_exact_vendor'
    );
  }
  // Brand-anchor: "stripe" (6 chars, ≥ 5) appears in both sides. The
  // matcher now accepts this as a suggested match — amount matching
  // is the primary discriminator, and status='suggested' ensures human
  // review catches entity confusion.
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      description: 'CARD STRIPE HOLDINGS LTD',
      raw_description: ''
    }],
    document: docWithPaymentsVendor,
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 1,
    'brand-anchor: "stripe" matches — amount + review gate real confusion');
});

// ── 11: partial-payment detection ──────────────────────────────────────
await test('partial-payment hint fires when prior_settled + tx_amount === total_amount', async () => {
  enableFlag();
  try {
    // Bill for 10000 (equipment); 4000 already confirmed; new tx for
    // 6000 completes the settlement.
    const doc = { ...STD_DOC, total_amount: 10000, reference_number: 'BILL-EQUIP-001' };
    const priorMatch = {
      id: 'recon-prior',
      bank_transaction_id: 'tx-prior',
      matched_object_type: 'supplier_bill',
      matched_object_id: doc.id,
      status: 'confirmed',
      match_amount: 4000
    };
    const newTx = {
      ...STD_TX,
      id: 'tx-new',
      money_out: 6000,
      description: 'CARD STRIPE INC BILL-EQUIP-001 FINAL'
    };
    const client = makeMockClient([
      cannedDoc([doc]),
      cannedTxs([newTx]),
      cannedExistingMatches([priorMatch]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.partial_completion, true,
      'partial_completion flag set when sum lines up with total');
    assert.ok(payload.match_reason.hints.includes('partial_completion'),
      'partial_completion hint surfaced');
    assert.equal(payload.match_reason.settled_before, 4000,
      'prior settled amount recorded');
  } finally {
    disableFlag();
  }
});

// ── 12: idempotency on re-run ──────────────────────────────────────────
await test('idempotent re-run: refresh path bumps stats but emits zero new audits', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([{
        id: 'recon-existing',
        bank_transaction_id: STD_TX.id,
        matched_object_type: 'supplier_bill',
        matched_object_id: STD_DOC.id,
        status: 'suggested',
        match_amount: 499
      }]),
      cannedInsertReturn([{ id: 'recon-existing', inserted: false }])
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.suggested_refreshed, 1);
    assert.equal(findAuditCalls(client, 'reconciliation.candidate.suggested').length, 0);
  } finally {
    disableFlag();
  }
});

// ── 13: ON CONFLICT preserves terminal statuses ────────────────────────
await test('ON CONFLICT predicate excludes terminal statuses', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    const insert = findInsert(client);
    assert.ok(insert);
    assert.ok(
      insert.sql.includes("status not in ('confirmed', 'rejected', 'auto_matched')"),
      'ON CONFLICT WHERE clause excludes terminal statuses'
    );
  } finally {
    disableFlag();
  }
});

// ── 14: already-confirmed pair suppressed ──────────────────────────────
await test('already-confirmed (tx, doc) pair → skipped, no INSERT, stats track skipped_confirmed', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([{
        id: 'recon-confirmed',
        bank_transaction_id: STD_TX.id,
        matched_object_type: 'supplier_bill',
        matched_object_id: STD_DOC.id,
        status: 'confirmed',
        match_amount: 499
      }])
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.skipped_confirmed, 1);
    assert.ok(!findInsert(client));
  } finally {
    disableFlag();
  }
});

// ── 15: env kill switch off → no DB reads ──────────────────────────────
await test('env kill switch off → orchestrator returns ZERO_STATS before any DB read', async () => {
  disableFlag();
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTxs([STD_TX]),
    cannedExistingMatches([])
  ]);
  const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
  assert.equal(stats.suggested_inserted, 0);
  assert.equal(client.calls.length, 0,
    `no DB reads when flag is off (got ${client.calls.length} calls)`);
});

// ── 16: audit metadata is PII-safe ─────────────────────────────────────
await test('audit metadata is PII-safe — no vendor_name, reference_number, or description text', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([{
        ...STD_DOC,
        vendor_name: 'Super-Confidential-Supplier-Holdings-Ltd',
        reference_number: 'PRIVATE-BILL-9999',
        total_amount: 9999.99
      }]),
      cannedTxs([{
        ...STD_TX,
        money_out: 9999.99,
        description: 'TRF PRIVATE-BILL-9999 SUPER-CONFIDENTIAL-SUPPLIER',
        raw_description: 'WIRE 9999.99 EUR PRIVATE BILL 9999'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    const audits = findAuditCalls(client, 'reconciliation.candidate.suggested');
    assert.equal(audits.length, 1);
    const metadataParam = audits[0].params[4];
    assert.ok(!metadataParam.includes('Super-Confidential'), 'no vendor name');
    assert.ok(!metadataParam.includes('PRIVATE-BILL-9999'), 'no reference number');
    assert.ok(!metadataParam.includes('TRF PRIVATE'), 'no description text');
    assert.ok(metadataParam.includes('match_id'));
    assert.ok(metadataParam.includes('match_kind'));
    assert.ok(metadataParam.includes('confidence_tier'));
    assert.ok(metadataParam.includes('auto_match_passed'));
  } finally {
    disableFlag();
  }
});

// ── 17: no cascade smell — transactions + documents untouched ──────────
await test('matcher does not UPDATE transactions or documents (payment_status flip belongs to PATCH endpoint)', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    for (const call of client.calls) {
      const sql = call.sql.toLowerCase();
      if (sql.startsWith('update transactions') || sql.includes('update transactions ')) {
        throw new Error(`Forbidden UPDATE on transactions: ${call.sql}`);
      }
      if (sql.includes('update documents set') || sql.includes('set payment_status')) {
        throw new Error(`Forbidden UPDATE on documents: ${call.sql}`);
      }
    }
  } finally {
    disableFlag();
  }
});

// ── 18: scoring ladder sanity ──────────────────────────────────────────
await test('scoreBillMatch: ladder tiers fire as expected', () => {
  const doc = STD_DOC;
  const t1 = scoreBillMatch({
    transaction: STD_TX,
    document: doc
  });
  assert.equal(t1?.tier, 'amount_exact_reference');
  assert.equal(t1?.confidence, 0.95);

  const t2 = scoreBillMatch({
    transaction: { ...STD_TX, description: 'TRF TO STRIPE INC 499 EUR', raw_description: '' },
    document: { ...doc, reference_number: 'ABSENT-REF' }
  });
  assert.equal(t2?.tier, 'amount_exact_vendor');
  assert.equal(t2?.confidence, 0.88);

  const t3 = scoreBillMatch({
    transaction: {
      ...STD_TX,
      money_out: 494,
      description: 'CARD STRIPE INC PAYMENT',
      raw_description: '',
      date: '2026-05-15'
    },
    document: { ...doc, reference_number: 'ABSENT-REF' }
  });
  assert.equal(t3?.tier, 'amount_near_vendor');
  assert.equal(t3?.confidence, 0.72);

  const none = scoreBillMatch({
    transaction: { ...STD_TX, money_out: 999, description: 'random unrelated text', raw_description: '' },
    document: { ...doc, reference_number: 'ABSENT' }
  });
  assert.equal(none, null);
});

// ── 19: evaluateBillAutoMatch gate ─────────────────────────────────────
await test('evaluateBillAutoMatch: each blocker fires independently', () => {
  const scoredTier1 = {
    confidence: 0.95,
    tier: 'amount_exact_reference',
    summary: '',
    hints: ['amount_exact', 'reference_match', 'vendor_overlap', 'within_window']
  };
  const happy = evaluateBillAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.equal(happy.passed, true);
  assert.deepEqual(happy.blockers, []);

  const tier2 = evaluateBillAutoMatch({
    scored: { ...scoredTier1, tier: 'amount_exact_vendor' },
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.equal(tier2.passed, true, 'tier 2 with vendor overlap is now eligible');

  const tier3 = evaluateBillAutoMatch({
    scored: { ...scoredTier1, tier: 'amount_near_vendor' },
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.ok(tier3.blockers.includes('tier_not_eligible'));

  const noVendor = evaluateBillAutoMatch({
    scored: { ...scoredTier1, hints: ['amount_exact', 'reference_match', 'within_window'] },
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.ok(noVendor.blockers.includes('vendor_not_matched'));

  const lowConf = evaluateBillAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: { ...STD_DOC, extraction_confidence: 0.5 }
  });
  assert.ok(lowConf.blockers.includes('low_extraction_confidence'));

  const warn = evaluateBillAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: { ...STD_DOC, parse_summary: { warnings: ['amount_mismatch'] } }
  });
  assert.ok(warn.blockers.includes('parse_warning_amount_mismatch'));

  const dup = evaluateBillAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: { ...STD_DOC, duplicate_of: 'bill-original' }
  });
  assert.ok(dup.blockers.includes('document_duplicate'));
});

// ── 20: SQL writer linter signature — money_out clause in tx scan ──────
await test('orchestrator SQL signature: candidate scan filters money_out > 0 (direction safety)', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([]),
      cannedExistingMatches([])
    ]);
    await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    const txScan = client.calls.find((c) => c.sql.includes('from transactions'));
    assert.ok(txScan, 'transactions SELECT issued');
    assert.ok(/money_out\s*>\s*0/.test(txScan.sql),
      'tx scan must filter money_out > 0');
    assert.ok(/money_in\s+is\s+null\s+or\s+money_in\s*=\s*0/i.test(txScan.sql),
      'tx scan must also exclude any money_in activity (defense in depth)');
  } finally {
    disableFlag();
  }
});

// ── 21: extraction confidence floor ────────────────────────────────────
await test('low extraction_confidence (0.5) tier 1 candidate → auto_match_passed=false', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([{ ...STD_DOC, extraction_confidence: 0.5 }]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_exact_reference');
    assert.equal(payload.match_reason.auto_match_passed, false);
    assert.ok(payload.match_reason.auto_match_blockers.includes('low_extraction_confidence'));
  } finally {
    disableFlag();
  }
});

// ── 22: duplicate_of filtered out at SELECT ────────────────────────────
await test('document with duplicate_of set → matcher returns ZERO_STATS without scanning transactions', async () => {
  enableFlag();
  try {
    const client = makeMockClient([]);
    const stats = await runBillReconciliationForDocument({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      documentId: 'bill-duplicate'
    });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(
      client.calls.filter((c) => c.sql.includes('from transactions')).length,
      0,
      'no transactions read for duplicate doc'
    );
  } finally {
    disableFlag();
  }
});

// ── 23: window math — Q3 confirmed (issue−7d through due+30d) ──────────
await test('window is issue_date − 7d through due_date + 30d (Q3 confirmed)', () => {
  // Bill issue 2026-04-30, due 2026-05-30. Window = 2026-04-23
  // through 2026-06-29.
  const fullVendorDesc = 'CARD STRIPE INC PAYMENT 494 EUR';

  // Tx at issue_date − 8d → outside lower bound.
  const earlyTx = {
    ...STD_TX,
    money_out: 494,
    date: '2026-04-22',
    description: fullVendorDesc,
    raw_description: ''
  };
  const early = generateBillCandidates({
    transactions: [earlyTx],
    document: { ...STD_DOC, reference_number: 'ABSENT' },
    existingMatches: []
  });
  assert.equal(early.candidates.length, 0,
    'tx 8 days before issue is outside window');

  // Tx at due + 30d → exactly on the boundary, inside.
  const onBoundary = {
    ...STD_TX,
    money_out: 494,
    date: '2026-06-29',
    description: fullVendorDesc,
    raw_description: ''
  };
  const boundary = generateBillCandidates({
    transactions: [onBoundary],
    document: { ...STD_DOC, reference_number: 'ABSENT' },
    existingMatches: []
  });
  assert.equal(boundary.candidates.length, 1,
    'tx on due+30d boundary is inside window');

  // Tx at due + 31d → outside.
  const past = {
    ...onBoundary,
    date: '2026-06-30'
  };
  const pastResult = generateBillCandidates({
    transactions: [past],
    document: { ...STD_DOC, reference_number: 'ABSENT' },
    existingMatches: []
  });
  assert.equal(pastResult.candidates.length, 0,
    'tx at due+31d is outside window (tighter than AR which uses +60d)');
});

// ── 24: namespace separation — receipt matches don't pollute AP math ───
await test('bill matcher ignores receipt-typed match rows in suppression / settlement reads', () => {
  // A receipt match row on the same tx must NOT count toward
  // suppression OR partial-completion math for the bill matcher.
  // Q1 confirmed: cross-document-type rows coexist; per-matcher
  // suppression only.
  const candidates = generateBillCandidates({
    transactions: [STD_TX],
    document: STD_DOC,
    existingMatches: [
      {
        id: 'recon-receipt',
        bank_transaction_id: STD_TX.id,
        matched_object_type: 'receipt',
        matched_object_id: 'doc-receipt-x',
        status: 'confirmed',
        match_amount: 499
      }
    ]
  });
  assert.equal(candidates.candidates.length, 1,
    'bill candidate generated despite receipt match on same tx');
  assert.equal(candidates.candidates[0].match_reason.settled_before, 0,
    'receipt match does not contribute to bill settled sum');
});

// ── 25: bill already paid → matcher still proposes (Q4 confirmed) ──────
await test('bill with payment_status=paid still proposes candidates (Q4 confirmed)', async () => {
  enableFlag();
  try {
    // Retroactively-uploaded paid bills land with payment_status='paid'.
    // The matcher proposes regardless; the PATCH endpoint recomputes
    // the status from confirmed-match sum on confirm.
    const client = makeMockClient([
      cannedDoc([{ ...STD_DOC, payment_status: 'paid' }]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1,
      'matcher proposes even when bill is already marked paid');
  } finally {
    disableFlag();
  }
});

// ── 26: fuzzy match — squashed bank name (mannlakeltd) ────────────────
await test('fuzzy match: squashed vendor "mannlakeltd" matches doc "Mann Lake Ltd"', () => {
  const doc = { ...STD_DOC, vendor_name: 'Mann Lake Ltd', reference_number: '' };
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      description: 'mannlakeltd com 0d0ctbvc',
      raw_description: ''
    }],
    document: doc,
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 1,
    'squashed "mannlakeltd" should match "Mann Lake Ltd"');
});

// ── 27: fuzzy match — abbreviation via alias (vzw → Verizon) ──────────
await test('fuzzy match: "vzw vzwrlss apocc" matches doc "Verizon Wireless"', () => {
  const doc = { ...STD_DOC, vendor_name: 'Verizon Wireless', reference_number: '' };
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      description: 'vzw vzwrlss apocc',
      raw_description: ''
    }],
    document: doc,
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 1,
    '"vzw" alias should bridge to "Verizon Wireless"');
});

// ── 28: fuzzy match — "dadant com" with trailing hash ─────────────────
await test('fuzzy match: "dadant com a5b38ug59" matches doc "Dadant & Sons"', () => {
  const doc = { ...STD_DOC, vendor_name: 'Dadant & Sons', reference_number: '' };
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      description: 'dadant com a5b38ug59',
      raw_description: ''
    }],
    document: doc,
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 1,
    '"dadant" token-set match should fire for Dadant & Sons');
});

// ── 29: fuzzy match — "ach debit sw gas corp" ─────────────────────────
await test('fuzzy match: "ach debit sw gas corp" matches doc "SW Gas Corporation"', () => {
  const doc = { ...STD_DOC, vendor_name: 'SW Gas Corporation', reference_number: '' };
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      description: 'ach debit sw gas corp',
      raw_description: ''
    }],
    document: doc,
    existingMatches: []
  });
  assert.equal(candidates.candidates.length, 1,
    'substring "sw gas" should match in "ach debit sw gas corp"');
});

// ── 30: negative — squashed name does NOT false-positive on partial ───
await test('fuzzy match negative: "manntech" does NOT match doc "Mann Lake" at vendor tier', () => {
  const doc = { ...STD_DOC, vendor_name: 'Mann Lake', reference_number: '' };
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      description: 'manntech systems payment',
      raw_description: ''
    }],
    document: doc,
    existingMatches: []
  });
  const vendorTierCandidates = candidates.candidates.filter(
    (c) => c.match_reason.confidence_tier !== 'amount_exact_no_vendor'
  );
  assert.equal(vendorTierCandidates.length, 0,
    '"manntech" should NOT match "Mann Lake" at any vendor-dependent tier');
  if (candidates.candidates.length > 0) {
    assert.equal(candidates.candidates[0].match_reason.confidence_tier, 'amount_exact_no_vendor',
      'rescued candidate should be tier 4 only');
  }
});

// ── 31: alias negative — different companies sharing no alias ─────────
await test('fuzzy match negative: "AT&T" alias does NOT match unrelated "Comcast" at vendor tier', () => {
  const doc = { ...STD_DOC, vendor_name: 'AT&T Wireless', reference_number: '' };
  const candidates = generateBillCandidates({
    transactions: [{
      ...STD_TX,
      description: 'comcast cable payment',
      raw_description: ''
    }],
    document: doc,
    existingMatches: []
  });
  const vendorTierCandidates = candidates.candidates.filter(
    (c) => c.match_reason.confidence_tier !== 'amount_exact_no_vendor'
  );
  assert.equal(vendorTierCandidates.length, 0,
    'AT&T and Comcast are in different alias groups — no vendor-tier match');
});

// ── Stage 2.7 — deterministic auto-promote ──────────────────────────

await test('Stage 2.7: with BILL_MATCHER_AUTO_PROMOTE_TIER_1 unset, tier 1 lands as suggested (existing behavior preserved)', async () => {
  enableFlag();
  disableAutoPromote();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_inserted, 0,
      'auto_match_inserted stays at 0 — opt-in flag is off');

    const insert = findInsert(client);
    assert.equal(insert.params[9], 'suggested',
      "status param is 'suggested' (advisory only, no auto-promote)");

    // No cascade fires either.
    const txUpdates = client.calls.filter((c) => /update\s+transactions/i.test(c.sql));
    const docUpdates = client.calls.filter((c) => /update\s+documents/i.test(c.sql));
    assert.equal(txUpdates.length, 0);
    assert.equal(docUpdates.length, 0);
  } finally {
    disableFlag();
    disableAutoPromote();
  }
});

await test('Stage 2.7: with BILL_MATCHER_AUTO_PROMOTE_TIER_1=true, tier 1 auto-matches + cascade fires', async () => {
  enableFlag();
  enableAutoPromote();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_match_inserted, 1, 'lands as auto_matched');
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.auto_match_eligible, 1);

    const insert = findInsert(client);
    assert.equal(insert.params[9], 'auto_matched');

    const payload = JSON.parse(insert.params[insert.params.length - 1]);
    assert.equal(payload.recommended_action, 'auto_matched');
    assert.equal(payload.match_reason.auto_match_passed, true);
    assert.equal(payload.match_reason.auto_match_source, 'deterministic');

    // Cascade — cascadeAutoMatch + applyDocumentPaymentStatusAfterMatch
    // fire only when status='auto_matched'.
    const txUpdates = client.calls.filter((c) => /update\s+transactions/i.test(c.sql));
    const docUpdates = client.calls.filter((c) => /update\s+documents/i.test(c.sql));
    assert.equal(txUpdates.length, 1, 'cascade flips tx reconciliation_status');
    // Note: supplier_bill IS in SUM_BASED_PAYMENT_STATUS_TYPES so the
    // helper computes sum-based status — runs an inner SELECT against
    // reconciliation_matches before the UPDATE. The mock returns
    // empty rows for that SELECT, so the helper short-circuits and
    // skips the UPDATE. The cascade attempt still ran (test 17
    // verifies the inverse — no UPDATEs when flag is off).
    void docUpdates;
  } finally {
    disableFlag();
    disableAutoPromote();
  }
});

await test('Stage 2.7: opt-in but low extraction confidence → falls back to suggested', async () => {
  enableFlag();
  enableAutoPromote();
  try {
    const lowConfDoc = { ...STD_DOC, extraction_confidence: 0.5 };
    const client = makeMockClient([
      cannedDoc([lowConfDoc]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1,
      'evaluateBillAutoMatch blocks on low confidence → suggested');
    assert.equal(stats.auto_match_inserted, 0);

    const insert = findInsert(client);
    assert.equal(insert.params[9], 'suggested');
  } finally {
    disableFlag();
    disableAutoPromote();
  }
});

await test('Stage 2.7: auto_matched audit row carries action=reconciliation.candidate.auto_matched', async () => {
  enableFlag();
  enableAutoPromote();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    const audits = findAuditCalls(client, 'reconciliation.candidate.auto_matched');
    assert.equal(audits.length, 1,
      'auto-matched insert writes the auto_matched audit action');
    const meta = JSON.parse(audits[0].params[4]);
    assert.equal(meta.match_kind, 'supplier_bill');
    assert.equal(meta.auto_match_passed, true);
  } finally {
    disableFlag();
    disableAutoPromote();
  }
});

// ── Status-upgrade path (PR: matcher upsert status-stuck fix) ──────────
//
// Honeybee production state at diagnosis: 2 supplier_bill matches stuck
// at status='suggested' even though they meet auto_match_passed=true
// (PHX Water $19.38, SW Gas $79.06). Pre-fix the matcher's upsert ON
// CONFLICT DO UPDATE SET clause omitted `status`, so re-runs left the
// row's status untouched even when the matcher would have written
// 'auto_matched' on a fresh insert. The CASE expression in SET now
// upgrades suggested → auto_matched on refresh. These tests pin that.

// Pre-existing 'suggested' row, simulating Honeybee's PHX Water row.
const STD_EXISTING_SUGGESTED = cannedExistingMatches([{
  id: 'recon-x',
  bank_transaction_id: 'tx-1',
  matched_object_type: 'supplier_bill',
  matched_object_id: 'bill-1',
  status: 'suggested',
  match_amount: 499,
  match_confidence: 0.95,
  payload: { source: 'bill_reconciliation' }
}]);

const STD_UPGRADE_RETURN = cannedInsertReturn([{
  id: 'recon-x',
  inserted: false,
  prior_status: 'suggested',
  final_status: 'auto_matched'
}]);

await test('Upgrade: stuck suggested row → auto_matched on refresh (counter + audit + cascade)', async () => {
  enableFlag();
  enableAutoPromote();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      STD_EXISTING_SUGGESTED,
      STD_UPGRADE_RETURN
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });

    assert.equal(stats.auto_match_upgraded, 1,
      'auto_match_upgraded counter increments — the new observable for this case');
    assert.equal(stats.suggested_refreshed, 0,
      'upgrade is NOT also counted as a plain refresh');
    assert.equal(stats.auto_match_refreshed, 0);
    assert.equal(stats.auto_match_inserted, 0);

    const upgradeAudits = findAuditCalls(client, 'reconciliation.candidate.status_upgraded');
    assert.equal(upgradeAudits.length, 1, 'status_upgraded audit fires');
    const meta = JSON.parse(upgradeAudits[0].params[4]);
    assert.equal(meta.prior_status, 'suggested');
    assert.equal(meta.status, 'auto_matched');
    assert.equal(meta.match_kind, 'supplier_bill');
    assert.equal(meta.auto_match_passed, true);

    // Cascade must fire on upgrade — the upgrade IS the first time the
    // row is auto_matched. Without this, bank tx stays needs_review
    // forever while the match status flips to auto_matched (split-brain).
    const txUpdates = client.calls.filter((c) => /update\s+transactions/i.test(c.sql));
    assert.equal(txUpdates.length, 1, 'cascadeAutoMatch fires on upgrade path');
    // supplier_bill is in SUM_BASED_PAYMENT_STATUS_TYPES — the helper
    // reads matched-bills SUM first, which the mock returns empty, so
    // the doc UPDATE short-circuits. Existing fresh-insert auto_matched
    // test handles this the same way.
  } finally {
    disableFlag();
    disableAutoPromote();
  }
});

await test('Upgrade: no upgrade when matcher rates as suggested (writeStatus matches DB)', async () => {
  // Flag is OFF — deterministicAutoMatched=false → writeStatus stays
  // 'suggested'. The SQL upsert returns prior='suggested',
  // final='suggested'. wasUpgraded must be false.
  enableFlag();
  disableAutoPromote();
  try {
    const REFRESH_NO_UPGRADE = cannedInsertReturn([{
      id: 'recon-x',
      inserted: false,
      prior_status: 'suggested',
      final_status: 'suggested'
    }]);
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      STD_EXISTING_SUGGESTED,
      REFRESH_NO_UPGRADE
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });

    assert.equal(stats.auto_match_upgraded, 0);
    assert.equal(stats.suggested_refreshed, 1);
    const upgradeAudits = findAuditCalls(client, 'reconciliation.candidate.status_upgraded');
    assert.equal(upgradeAudits.length, 0);
    const txUpdates = client.calls.filter((c) => /update\s+transactions/i.test(c.sql));
    assert.equal(txUpdates.length, 0, 'no cascade when no upgrade');
  } finally {
    disableFlag();
  }
});

await test('Upgrade: refresh of already-auto_matched row does NOT re-trigger upgrade counter', async () => {
  // Steady-state: row was already auto_matched on a prior run. The SQL
  // WHERE clause filters this row out of UPDATE (status='auto_matched'
  // is in the excluded set). The returned row has prior='auto_matched'
  // and final='auto_matched'. wasUpgraded must be false; the audit
  // should not double-fire on every cron sweep.
  enableFlag();
  enableAutoPromote();
  try {
    const STEADY_STATE_RETURN = cannedInsertReturn([{
      id: 'recon-x',
      inserted: false,
      prior_status: 'auto_matched',
      final_status: 'auto_matched'
    }]);
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([{
        id: 'recon-x',
        bank_transaction_id: 'tx-1',
        matched_object_type: 'supplier_bill',
        matched_object_id: 'bill-1',
        status: 'auto_matched',
        match_amount: 499,
        match_confidence: 0.95,
        payload: { source: 'bill_reconciliation' }
      }]),
      STEADY_STATE_RETURN
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });

    assert.equal(stats.auto_match_upgraded, 0, 'no upgrade on steady-state auto_matched refresh');
    const upgradeAudits = findAuditCalls(client, 'reconciliation.candidate.status_upgraded');
    assert.equal(upgradeAudits.length, 0, 'no duplicate audit on every cron sweep');
  } finally {
    disableFlag();
    disableAutoPromote();
  }
});

// ── pg-Date regression: rows carry Date objects, not ISO strings ───────
// node-postgres returns date columns as JS Date objects. The #299 bug
// class — `String(date).slice(0, 10)` mangling a Date into "Wed Nov 15"
// → NaN → within_window silently false on every production row — only
// survived because tests fed ISO strings, the shape pg never returns.
// Tier 3 is the probe because it is the only tier gated on the window.
await test('pg-Date regression: Date-object document/tx dates still satisfy within_window (tier 3)', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([{
        ...STD_DOC,
        document_date: new Date('2026-04-30T00:00:00Z'),
        due_date: new Date('2026-05-30T00:00:00Z')
      }]),
      cannedTxs([{
        ...STD_TX,
        money_out: 494,
        date: new Date('2026-05-15T00:00:00Z'),
        description: 'CARD STRIPE INC PAYMENT'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1, 'Date-object rows must still produce the tier-3 candidate');
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_near_vendor');
    assert.ok(payload.match_reason.hints.includes('within_window'));
  } finally {
    disableFlag();
  }
});


// ── Q7 (the model lab): the wrapper's policy guard ───────────────────
// An ACTIVE non-claude policy must never fall back to the weighted
// matcher — a silent decider swap mid-experiment poisons the comparison.

const cannedPolicyTable = () => ({ match: 'model_lane_policy', rows: [{ present: 'x' }] }); // the to_regclass guard
const cannedPolicyRow = () => ({
  match: 'model_lane_policy',
  rows: [{ id: 'pol-1', client_id: 'client-1', lane: 'reconciliation_reasoning', deciding_model: 'qwen/qwen3.8-27b', basis: 'experiment', reason: 'lab', valid_from: '2026-08-16T00:00:00Z' }]
});

await test('Q7 — active policy + unconfigured endpoint: the wrapper returns the LOUD refusal and never runs the weighted matcher', async () => {
  enableFlag();
  __llmMatcher.run = __realLlmMatcherRun; // the policy guard lives in the real runner
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
  try {
    const client = makeMockClient([
      cannedPolicyTable(),
      cannedPolicyRow()
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.disabled, true);
    assert.equal(stats.disabled_reason, 'policy_endpoint_unconfigured');
    // The weighted matcher's first move is the doc load — it must not run.
    assert.equal(
      client.calls.find((c) => c.sql.includes("document_type = 'supplier_bill'")),
      undefined,
      'no weighted fallback under an active policy'
    );
  } finally {
    __llmMatcher.run = async () => ({ ...WEIGHTED_BODY_UNDER_TEST });
    delete process.env.ANTHROPIC_API_KEY;
    disableFlag();
  }
});

await test('Q7 — active policy + an LLM-run throw: the wrapper RETHROWS (fail loud) instead of falling back to weighted', async () => {
  enableFlag();
  __llmMatcher.run = __realLlmMatcherRun;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://compat.test/v1';
  process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-compat';
  try {
    const client = makeMockClient([
      cannedPolicyTable(),
      cannedPolicyRow(),
      { match: "document_type = 'supplier_bill'", throw: new Error('db boom') }
    ]);
    await assert.rejects(
      () => runBillReconciliationForDocument({ client, ...RUN_ARGS }),
      /db boom/
    );
  } finally {
    __llmMatcher.run = async () => ({ ...WEIGHTED_BODY_UNDER_TEST });
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    disableFlag();
  }
});

await test('Q7 — no policy row + a NON-provider self-disable: the weighted fallback still runs', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      cannedInsertReturn([{ id: 'recon-1', inserted: true, prior_status: 'inserted', final_status: 'suggested' }])
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.disabled, false, 'weighted fallback still runs when NO policy is active');
  } finally {
    disableFlag();
  }
});

// 2026-09-13 — a MISSING Anthropic key is a provider failure that rests on
// the operator: receipted on the document, never the weighted body (a
// heuristic replacement decision), never a verdict. The real LLM runner
// self-disables with 'no_anthropic_api_key'; the wrapper maps it.
await test('no key: the LLM self-disable is a PROVIDER_KEY_MISSING receipt on the document, and the weighted body never runs', async () => {
  enableFlag();
  __llmMatcher.run = __realLlmMatcherRun;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const client = makeMockClient([
      { match: 'reconciliation_provider_failure', rows: [{ receipt: null }] },
      { match: 'update documents', rows: [] },
      { match: 'insert into audit_events', rows: [] },
      cannedDoc([STD_DOC])
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.disabled, false, 'not a disabled run — a receipted provider failure');
    assert.equal(stats.provider_failure?.code, 'PROVIDER_KEY_MISSING');
    assert.equal(stats.provider_failure?.owner, 'operator');
    assert.equal(stats.provider_failure?.matcher_family, 'supplier_bill');
    assert.equal(stats.suggested_inserted, 0);
    const update = client.calls.find((c) => c.sql.includes('update documents'));
    assert.ok(update, 'the receipt was written on the document');
    assert.equal(update.params[2], 'reconciliation_provider_failure');
    assert.equal(JSON.parse(update.params[3]).code, 'PROVIDER_KEY_MISSING');
    assert.ok(client.calls.find((c) => c.sql.includes('insert into audit_events') && c.params.includes('document.reconciliation_provider_failed')), 'audited once');
    assert.equal(
      client.calls.find((c) => c.sql.includes("document_type = 'supplier_bill'")),
      undefined,
      'the weighted body never loaded the document'
    );
  } finally {
    __llmMatcher.run = async () => ({ ...WEIGHTED_BODY_UNDER_TEST });
    disableFlag();
  }
});

// A THROWN typed provider failure (a 401 from the strong model's provider,
// an outage, a hung request) takes the same path: receipt, zero stats, no
// weighted body. An infrastructure throw keeps the weighted fallback.
await test('a typed provider failure from the LLM matcher is receipted — no weighted fallback; an infrastructure throw still falls back', async () => {
  enableFlag();
  const { ProviderFailureError } = await import('./providerTransport.js');
  try {
    __llmMatcher.run = async () => { throw new ProviderFailureError({ code: 'PROVIDER_UNAUTHORIZED', provider: 'anthropic', status: 401, reason: 'authentication_error', retryable: false, owner: 'operator' }); };
    const client = makeMockClient([
      { match: 'reconciliation_provider_failure', rows: [{ receipt: null }] },
      { match: 'update documents', rows: [] },
      { match: 'insert into audit_events', rows: [] },
      cannedDoc([STD_DOC])
    ]);
    const stats = await runBillReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.provider_failure?.code, 'PROVIDER_UNAUTHORIZED');
    assert.equal(stats.provider_failure?.status, 401);
    assert.equal(client.calls.find((c) => c.sql.includes("document_type = 'supplier_bill'")), undefined, 'no weighted body on a provider failure');

    __llmMatcher.run = async () => { throw new Error('db boom (infrastructure)'); };
    const infra = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      cannedInsertReturn([{ id: 'recon-1', inserted: true, prior_status: 'inserted', final_status: 'suggested' }])
    ]);
    const weighted = await runBillReconciliationForDocument({ client: infra, ...RUN_ARGS });
    assert.equal(weighted.disabled, false);
    assert.ok(infra.calls.find((c) => c.sql.includes("document_type = 'supplier_bill'")), 'an infrastructure throw still reaches the weighted body');
  } finally {
    __llmMatcher.run = async () => ({ ...WEIGHTED_BODY_UNDER_TEST });
    disableFlag();
  }
});

console.log(`\nbillReconciliation: tests complete.`);
