// Reconciliation PR 8 — sales-invoice candidate matching tests.
//
// Mock-pg harness mirrors receiptReconciliation.test.js. The matcher
// reads three tables in order:
//   1. SELECT … FROM documents WHERE document_type='sales_invoice' …
//   2. SELECT … FROM transactions WHERE money_in > 0 …
//   3. SELECT … FROM reconciliation_matches WHERE … matched_object_type='sales_invoice'
// Tests provide canned rows keyed on distinctive substrings.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runSalesInvoiceReconciliationForDocument,
  scoreSalesInvoiceMatch,
  evaluateSalesInvoiceAutoMatch,
  generateSalesInvoiceCandidates,
  __llmMatcher
} from './salesInvoiceReconciliation.js';

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

// Env kill switch flipped on for every test except the explicit
// flag-off check. setup() and teardown() per test pattern keeps
// global state predictable.
const enableFlag = () => {
  process.env.SALES_INVOICE_MATCHER_ENABLED = 'true';
};
const disableFlag = () => {
  delete process.env.SALES_INVOICE_MATCHER_ENABLED;
};

// ── Mock client ───────────────────────────────────────────────────────
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

// `customer_name` is unique to the AR matcher's documents SELECT — the
// receipt + bill matchers' SELECTs don't read that column — so it's a
// durable anchor when the WHERE predicate widens (PR 2 extended the
// type filter to `IN ('sales_invoice', 'issued_receipt')`).
const cannedDoc = (rows) => ({ match: 'customer_name', rows });
const cannedTxs = (rows) => ({ match: 'money_in > 0', rows });
const cannedExistingMatches = (rows) => ({ match: 'from reconciliation_matches', rows });
const cannedInsertReturn = (rows) => ({ match: 'insert into reconciliation_matches', rows });

const STD_DOC = {
  id: 'si-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  document_type: 'sales_invoice',
  customer_name: 'Globex Industries Oy',
  document_date: '2026-04-30',
  due_date: '2026-05-30',
  total_amount: 2500,
  currency: 'EUR',
  extraction_confidence: 0.95,
  parse_summary: { warnings: [] },
  duplicate_of: null,
  reference_number: 'SI-2026-0042',
  filename: 'globex-may.pdf',
  payment_status: 'unpaid'
};

const STD_TX = {
  id: 'tx-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  money_in: 2500,
  money_out: 0,
  currency: 'EUR',
  date: '2026-05-03',
  description: 'Payment SI-2026-0042 from Globex',
  raw_description: 'TRF PAYMENT SI 2026 0042 GLOBEX INDUSTRIES',
  contact: '',
  source_line: '',
  reconciliation_status: null,
  account_code: null,
  status: 'needs_review'
};

const RUN_ARGS = {
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'si-1'
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

// ── 1: tier 1 (amount_exact + reference_match) → suggested ─────────────
await test('tier 1 (amount_exact + reference_match) → suggested, auto_match_passed=true', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_eligible, 1);

    const insert = findInsert(client);
    assert.ok(insert, 'INSERT issued');
    // Status='suggested' hard-coded in VALUES (Q6 — PR 8 never writes
    // auto_matched directly; the auto-promote flag is advisory only).
    assert.ok(insert.params.includes('suggested'),
      "status param is 'suggested'");
    // matched_object_type='sales_invoice' (Q5 option B — no migration,
    // no match_kind column).
    assert.ok(/'sales_invoice'/.test(insert.sql) ||
              insert.params.some((p) => p === 'sales_invoice'),
      "matched_object_type='sales_invoice'");

    const payload = JSON.parse(insert.params[insert.params.length - 1]);
    assert.equal(payload.source, 'sales_invoice_reconciliation');
    assert.equal(payload.match_reason.confidence_tier, 'amount_exact_reference');
    assert.equal(payload.match_reason.auto_match_passed, true);
    assert.ok(payload.match_reason.hints.includes('amount_exact'));
    assert.ok(payload.match_reason.hints.includes('reference_match'));
    assert.ok(payload.match_reason.hints.includes('customer_overlap'));

    const audits = findAuditCalls(client, 'reconciliation.candidate.suggested');
    assert.equal(audits.length, 1, 'one audit emitted');
    const auditMeta = JSON.parse(audits[0].params[4]);
    assert.equal(auditMeta.match_kind, 'sales_invoice');
    assert.equal(auditMeta.confidence_tier, 'amount_exact_reference');
  } finally {
    disableFlag();
  }
});

// ── 2: tier 1 reference variations (separator-insensitive) ─────────────
await test('tier 1 reference matches across separator/whitespace variations', async () => {
  enableFlag();
  try {
    // Reference variations: "INV2024-0042" vs "INV-2024-0042" vs "INV 2024 0042"
    const ref = 'INV-2024-0042';
    const variants = [
      'Payment INV-2024-0042',
      'Payment INV2024-0042 from Globex',
      'Inv 2024 0042 payment',
      'WIRE INV20240042 RECEIVED'
    ];
    for (const variant of variants) {
      const client = makeMockClient([
        cannedDoc([{ ...STD_DOC, reference_number: ref }]),
        cannedTxs([{ ...STD_TX, description: variant, raw_description: variant }]),
        cannedExistingMatches([]),
        FRESH_INSERT
      ]);
      const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
      assert.equal(stats.suggested_inserted, 1, `variant "${variant}" should match`);
      const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
      assert.equal(payload.match_reason.confidence_tier, 'amount_exact_reference',
        `variant "${variant}" should land in tier 1`);
    }
  } finally {
    disableFlag();
  }
});

// ── 3: tier 2 (amount_exact + customer_overlap, no reference) ──────────
await test('tier 2 (amount_exact + customer_overlap, no reference) → suggested + auto_match_passed=true', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([{
        ...STD_TX,
        description: 'TRF FROM GLOBEX INDUSTRIES',
        raw_description: 'TRF FROM GLOBEX INDUSTRIES OY 2500.00 EUR'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_eligible, 1, 'tier 2 with customer overlap is now eligible');
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_exact_customer');
    assert.equal(payload.match_reason.auto_match_passed, true);
    assert.deepStrictEqual(payload.match_reason.auto_match_blockers, []);
  } finally {
    disableFlag();
  }
});

// ── 4: tier 3 (amount_near + customer_overlap + within_window) ─────────
await test('tier 3 (amount_near + customer + within_window) → suggested at 0.72', async () => {
  enableFlag();
  try {
    // Customer's bank deducted a small fee — pays 2,475 instead of 2,500.
    // Within 5% (2475 / 2500 = 99% — diff is 1%), customer matches,
    // and the tx falls inside the issue-to-due+60d window.
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([{
        ...STD_TX,
        money_in: 2475,
        date: '2026-05-15',
        description: 'WIRE FROM GLOBEX INDUSTRIES'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_near_customer');
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
        money_in: 2250, // 10% off
        description: 'TRF FROM GLOBEX'
      }]),
      cannedExistingMatches([])
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.ok(!findInsert(client), 'no INSERT issued');
  } finally {
    disableFlag();
  }
});

// ── 6: direction safety — money_out tx never appears as candidate ──────
await test('direction safety: money_out tx with matching amount + customer → ZERO candidates', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      // The matcher's transactions SELECT filters `money_in > 0`
      // already — but if someone bypassed the filter, the in-memory
      // candidate generator's direction gate would still exclude.
      // Test both layers: the SELECT returns nothing because the
      // filter is `money_in > 0`, AND the in-memory check would also
      // reject if it slipped through.
      cannedTxs([]), // mock SELECT correctly excludes money_out
      cannedExistingMatches([])
    ]);
    await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.ok(!findInsert(client));

    // Belt-and-suspenders: feed the pure helper a money_out tx and
    // verify it produces no candidate.
    const candidates = generateSalesInvoiceCandidates({
      transactions: [{ ...STD_TX, money_in: 0, money_out: 2500 }],
      document: STD_DOC,
      existingMatches: []
    });
    assert.equal(candidates.candidates.length, 0, 'money_out tx never proposes');
  } finally {
    disableFlag();
  }
});

// ── 7: already-reconciled txs excluded ─────────────────────────────────
await test('already-resolved transactions excluded from candidate set', async () => {
  enableFlag();
  try {
    const candidates = generateSalesInvoiceCandidates({
      transactions: [{ ...STD_TX, reconciliation_status: 'reconciled' }],
      document: STD_DOC,
      existingMatches: []
    });
    assert.equal(candidates.candidates.length, 0);

    const candidates2 = generateSalesInvoiceCandidates({
      transactions: [{ ...STD_TX, reconciliation_status: 'auto_reconciled' }],
      document: STD_DOC,
      existingMatches: []
    });
    assert.equal(candidates2.candidates.length, 0);
  } finally {
    disableFlag();
  }
});

// ── 7b: machine-explained lines are ADMITTED (document outranks) ──────
// Same shared carve-out as the AP matchers (see billReconciliation 7b —
// the 2026-08-05 Chevron/Verizon stranding): a batch-coder auto-applied
// line must stay visible to a late-parsing invoice.
await test('generateSalesInvoiceCandidates: admits a coding-auto-explained line (document outranks)', async () => {
  enableFlag();
  try {
    const result = generateSalesInvoiceCandidates({
      transactions: [{
        ...STD_TX,
        reconciliation_status: 'explained',
        ai_suggestion_status: 'auto_applied'
      }],
      document: STD_DOC,
      existingMatches: []
    });
    assert.ok(result.candidates.length >= 1, 'coding-auto-explained line is a candidate');

    const humanExplained = generateSalesInvoiceCandidates({
      transactions: [{
        ...STD_TX,
        reconciliation_status: 'explained',
        support_status: 'explained'
      }],
      document: STD_DOC,
      existingMatches: []
    });
    assert.equal(humanExplained.candidates.length, 0, 'non-machine explained line stays excluded');
  } finally {
    disableFlag();
  }
});

// ── 8: wrong-currency txs excluded ─────────────────────────────────────
await test('strict currency match — wrong currency yields no candidate', async () => {
  enableFlag();
  try {
    const candidates = generateSalesInvoiceCandidates({
      transactions: [{ ...STD_TX, currency: 'USD' }],
      document: STD_DOC,
      existingMatches: []
    });
    assert.equal(candidates.candidates.length, 0, 'cross-currency blocked');

    const candidates2 = generateSalesInvoiceCandidates({
      transactions: [{ ...STD_TX, currency: 'EUR' }],
      document: { ...STD_DOC, currency: null },
      existingMatches: []
    });
    assert.ok(candidates2.candidates.length > 0, 'null doc currency assumes match');
  } finally {
    disableFlag();
  }
});

// ── 9: out-of-window enforcement ───────────────────────────────────────
await test('tx 100 days past due_date with near-amount + customer → tier 3 excludes via window', async () => {
  enableFlag();
  try {
    // 100 days past due (window is due_date + 60d = 2026-07-29). Amount
    // is near (1% off), customer overlaps fully, but the tx is outside
    // the window. Tier 1 / 2 don't require within_window (reference or
    // amount_exact + customer is enough on its own), so this isolates
    // tier 3 — which DOES require within_window.
    const candidates = generateSalesInvoiceCandidates({
      transactions: [{
        ...STD_TX,
        money_in: 2475, // 1% off — would otherwise hit tier 3
        date: '2026-09-15', // ~100d past due → outside the window
        description: 'TRF FROM GLOBEX INDUSTRIES OY 2475 EUR',
        raw_description: ''
      }],
      // No reference token in the tx description above (the reference
      // 'SI-2026-0042' is NOT included), so tier 1 cannot fire and
      // we're cleanly testing tier 3.
      document: { ...STD_DOC, reference_number: 'NO-MATCH-REF' },
      existingMatches: []
    });
    assert.equal(candidates.candidates.length, 0,
      'tier 3 requires within_window — out-of-window rejects');
  } finally {
    disableFlag();
  }
});

// ── 10: customer-name fuzzy match — whitespace / case / suffix ─────────
await test('customer name fuzzy match: whitespace, case, corporate suffix (Oy/Ltd/Inc)', async () => {
  enableFlag();
  try {
    const matchingVariants = [
      'GLOBEX INDUSTRIES',
      'globex industries',
      'Globex Industries Oy',
      'GLOBEX INDUSTRIES LTD',
      'globex  industries' // double space
    ];
    for (const tx of matchingVariants) {
      const candidates = generateSalesInvoiceCandidates({
        transactions: [{
          ...STD_TX,
          description: `WIRE ${tx} 2500 EUR`,
          // no reference here so it lands in tier 2
          raw_description: ''
        }],
        document: { ...STD_DOC, reference_number: 'no-such-ref-in-tx' },
        existingMatches: []
      });
      assert.equal(candidates.candidates.length, 1, `"${tx}" should match`);
      assert.equal(
        candidates.candidates[0].match_reason.confidence_tier,
        'amount_exact_customer'
      );
    }
    // Negative: different company name doesn't match.
    const candidates = generateSalesInvoiceCandidates({
      transactions: [{
        ...STD_TX,
        description: 'WIRE FROM GLOBEX HOLDINGS LTD',
        raw_description: ''
      }],
      document: { ...STD_DOC, reference_number: 'no-such-ref-in-tx' },
      existingMatches: []
    });
    assert.equal(candidates.candidates.length, 1,
      'brand-anchor: "globex" (6 chars) matches — amount + review gate real confusion');
  } finally {
    disableFlag();
  }
});

// ── 11: partial-payment detection ──────────────────────────────────────
await test('partial-payment hint fires when prior_settled + tx_amount === total_amount', async () => {
  enableFlag();
  try {
    // Invoice for 5000; 2500 already confirmed; new tx for 2500
    // completes the payment.
    const doc = { ...STD_DOC, total_amount: 5000, reference_number: 'INV-PARTIAL-001' };
    const priorMatch = {
      id: 'recon-prior',
      bank_transaction_id: 'tx-prior',
      matched_object_type: 'sales_invoice',
      matched_object_id: doc.id,
      status: 'confirmed',
      match_amount: 2500
    };
    const newTx = {
      ...STD_TX,
      id: 'tx-new',
      money_in: 2500,
      description: 'PAYMENT INV-PARTIAL-001 FINAL INSTALMENT'
    };
    const client = makeMockClient([
      cannedDoc([doc]),
      cannedTxs([newTx]),
      cannedExistingMatches([priorMatch]),
      FRESH_INSERT
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.partial_completion, true,
      'partial_completion flag set when sum lines up with total');
    assert.ok(payload.match_reason.hints.includes('partial_completion'),
      'partial_completion hint surfaced');
    assert.equal(payload.match_reason.settled_before, 2500,
      'prior settled amount recorded');
  } finally {
    disableFlag();
  }
});

// ── 12: idempotency on re-run ──────────────────────────────────────────
await test('idempotent re-run: refresh path bumps stats but emits zero new audits', async () => {
  enableFlag();
  try {
    // ON CONFLICT … RETURNING reports inserted=false on a refresh.
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([{
        id: 'recon-existing',
        bank_transaction_id: STD_TX.id,
        matched_object_type: 'sales_invoice',
        matched_object_id: STD_DOC.id,
        status: 'suggested',
        match_amount: 2500
      }]),
      cannedInsertReturn([{ id: 'recon-existing', inserted: false }])
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.suggested_refreshed, 1);
    assert.equal(findAuditCalls(client, 'reconciliation.candidate.suggested').length, 0,
      'refresh emits no audit');
  } finally {
    disableFlag();
  }
});

// ── 13: ON CONFLICT preserves terminal statuses ────────────────────────
await test('ON CONFLICT predicate excludes terminal statuses (confirmed/rejected/auto_matched)', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
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
        matched_object_type: 'sales_invoice',
        matched_object_id: STD_DOC.id,
        status: 'confirmed',
        match_amount: 2500
      }])
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.skipped_confirmed, 1);
    assert.ok(!findInsert(client), 'no INSERT for already-confirmed pair');
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
  const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
  assert.equal(stats.suggested_inserted, 0);
  // Critical: ZERO calls of any kind. The flag check precedes every
  // SELECT.
  assert.equal(client.calls.length, 0,
    `no DB reads when flag is off (got ${client.calls.length} calls)`);
});

// ── 16: audit metadata is PII-safe ─────────────────────────────────────
await test('audit metadata is PII-safe — no customer_name, reference_number, or description text', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([{
        ...STD_DOC,
        customer_name: 'Super-Confidential-Customer-Holdings-Ltd',
        reference_number: 'PRIVATE-INV-9999',
        total_amount: 9999.99
      }]),
      cannedTxs([{
        ...STD_TX,
        money_in: 9999.99,
        description: 'TRF PRIVATE-INV-9999 SUPER-CONFIDENTIAL-CUSTOMER',
        raw_description: 'WIRE 9999.99 EUR PRIVATE INV 9999 SUPER CONFIDENTIAL'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    const audits = findAuditCalls(client, 'reconciliation.candidate.suggested');
    assert.equal(audits.length, 1);
    const metadataParam = audits[0].params[4];
    assert.ok(!metadataParam.includes('Super-Confidential'), 'no customer name');
    assert.ok(!metadataParam.includes('PRIVATE-INV-9999'), 'no reference number');
    assert.ok(!metadataParam.includes('TRF PRIVATE'), 'no description text');
    // Allowed: IDs, statuses, hint tags, numeric amounts, confidence_tier.
    assert.ok(metadataParam.includes('match_id'), 'match_id present');
    assert.ok(metadataParam.includes('bank_transaction_id'), 'tx id present');
    assert.ok(metadataParam.includes('match_kind'), 'kind present');
    assert.ok(metadataParam.includes('confidence_tier'), 'tier present');
    assert.ok(metadataParam.includes('auto_match_passed'), 'flag present');
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
    await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
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

// ── 18: pure scoring sanity ladder ─────────────────────────────────────
await test('scoreSalesInvoiceMatch: ladder tiers fire as expected', () => {
  const doc = STD_DOC;
  // Tier 1: amount exact + reference matches.
  const t1 = scoreSalesInvoiceMatch({
    transaction: STD_TX,
    document: doc
  });
  assert.equal(t1?.tier, 'amount_exact_reference');
  assert.equal(t1?.confidence, 0.95);

  // Tier 2: amount exact + customer overlap, no reference.
  const t2 = scoreSalesInvoiceMatch({
    transaction: { ...STD_TX, description: 'WIRE FROM GLOBEX INDUSTRIES 2500 EUR', raw_description: '' },
    document: { ...doc, reference_number: 'ABSENT-REF' }
  });
  assert.equal(t2?.tier, 'amount_exact_customer');
  assert.equal(t2?.confidence, 0.88);

  // Tier 3: amount near + customer + window.
  const t3 = scoreSalesInvoiceMatch({
    transaction: {
      ...STD_TX,
      money_in: 2475,
      description: 'WIRE FROM GLOBEX INDUSTRIES OY PAYMENT',
      raw_description: '',
      date: '2026-05-15'
    },
    document: { ...doc, reference_number: 'ABSENT-REF' }
  });
  assert.equal(t3?.tier, 'amount_near_customer');
  assert.equal(t3?.confidence, 0.72);

  // No tier: amount way off, no reference, no customer match.
  const none = scoreSalesInvoiceMatch({
    transaction: { ...STD_TX, money_in: 999, description: 'random unrelated text', raw_description: '' },
    document: { ...doc, reference_number: 'ABSENT' }
  });
  assert.equal(none, null);
});

// ── 19: evaluateSalesInvoiceAutoMatch gate ─────────────────────────────
await test('evaluateSalesInvoiceAutoMatch: each blocker fires independently', () => {
  const scoredTier1 = {
    confidence: 0.95,
    tier: 'amount_exact_reference',
    summary: '',
    hints: ['amount_exact', 'reference_match', 'customer_overlap', 'within_window']
  };
  const happy = evaluateSalesInvoiceAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.equal(happy.passed, true);
  assert.deepEqual(happy.blockers, []);

  // Tier 2 (exact amount + customer) is now eligible.
  const tier2 = evaluateSalesInvoiceAutoMatch({
    scored: { ...scoredTier1, tier: 'amount_exact_customer' },
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.equal(tier2.passed, true, 'tier 2 with customer overlap is eligible');

  // Tier 3 (near amount) still blocked.
  const tier3 = evaluateSalesInvoiceAutoMatch({
    scored: { ...scoredTier1, tier: 'amount_near_customer' },
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.ok(tier3.blockers.includes('tier_not_eligible'));

  // Tier 1 but customer didn't overlap → blocked.
  const noCustomer = evaluateSalesInvoiceAutoMatch({
    scored: { ...scoredTier1, hints: ['amount_exact', 'reference_match', 'within_window'] },
    transaction: STD_TX,
    document: STD_DOC
  });
  assert.ok(noCustomer.blockers.includes('customer_not_matched'));

  // Low extraction confidence.
  const lowConf = evaluateSalesInvoiceAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: { ...STD_DOC, extraction_confidence: 0.5 }
  });
  assert.ok(lowConf.blockers.includes('low_extraction_confidence'));

  // Parse warning amount_mismatch.
  const warn = evaluateSalesInvoiceAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: { ...STD_DOC, parse_summary: { warnings: ['amount_mismatch'] } }
  });
  assert.ok(warn.blockers.includes('parse_warning_amount_mismatch'));

  // Duplicate document.
  const dup = evaluateSalesInvoiceAutoMatch({
    scored: scoredTier1,
    transaction: STD_TX,
    document: { ...STD_DOC, duplicate_of: 'si-original' }
  });
  assert.ok(dup.blockers.includes('document_duplicate'));
});

// ── 20: SQL writer linter signature — money_in clause in tx scan ───────
await test('orchestrator SQL signature: candidate scan filters money_in > 0 (direction safety)', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([]),
      cannedExistingMatches([])
    ]);
    await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    // The tx-scan SELECT must include money_in > 0. Hard pin so a
    // future "let's reuse the receipt matcher's query" refactor
    // can't silently flip direction.
    const txScan = client.calls.find((c) => c.sql.includes('from transactions'));
    assert.ok(txScan, 'transactions SELECT issued');
    assert.ok(/money_in\s*>\s*0/.test(txScan.sql),
      'tx scan must filter money_in > 0');
    assert.ok(/money_out\s+is\s+null\s+or\s+money_out\s*=\s*0/i.test(txScan.sql),
      'tx scan must also exclude any money_out activity (defense in depth)');
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
    await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_exact_reference');
    assert.equal(payload.match_reason.auto_match_passed, false);
    assert.ok(payload.match_reason.auto_match_blockers.includes('low_extraction_confidence'));
  } finally {
    disableFlag();
  }
});

// ── 22: duplicate_of document filtered out at SELECT ───────────────────
await test('document with duplicate_of set → matcher returns ZERO_STATS without scanning transactions', async () => {
  enableFlag();
  try {
    // The matcher's documents SELECT filters `duplicate_of is null` so
    // a duplicate doc returns zero rows → early return.
    const client = makeMockClient([
      // No canned response for documents — default empty rows
      // simulates "filtered out by the SELECT predicate".
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      documentId: 'si-duplicate'
    });
    assert.equal(stats.suggested_inserted, 0);
    // Only one SELECT (documents). No tx scan, no match scan.
    assert.equal(
      client.calls.filter((c) => c.sql.includes('from transactions')).length,
      0,
      'no transactions read for duplicate doc'
    );
  } finally {
    disableFlag();
  }
});

// ── 23: window math — issue date and due date span the window ──────────
await test('window is issue_date − 7d through due_date + 60d', async () => {
  // Customer description that satisfies the new token-set overlap so
  // window is the only deciding factor in each variant below.
  const fullCustomerDesc = 'WIRE GLOBEX INDUSTRIES OY 2475 EUR';

  // Tx at issue_date − 8 days (one day too early) → outside window.
  const earlyTx = {
    ...STD_TX,
    money_in: 2475,
    date: '2026-04-22', // 8 days before issue
    description: fullCustomerDesc,
    raw_description: ''
  };
  const earlyCandidates = generateSalesInvoiceCandidates({
    transactions: [earlyTx],
    document: { ...STD_DOC, reference_number: 'ABSENT' },
    existingMatches: []
  });
  assert.equal(earlyCandidates.candidates.length, 0,
    'tx 8 days before issue is outside window (tier 3 excludes)');

  // Tx at due_date + 60d (right on the boundary) → inside window.
  const lateTx = {
    ...STD_TX,
    money_in: 2475,
    date: '2026-07-29', // exactly 60 days after due_date 2026-05-30
    description: fullCustomerDesc,
    raw_description: ''
  };
  const lateCandidates = generateSalesInvoiceCandidates({
    transactions: [lateTx],
    document: { ...STD_DOC, reference_number: 'ABSENT' },
    existingMatches: []
  });
  assert.equal(lateCandidates.candidates.length, 1,
    'tx on due+60d boundary is inside window');

  // Tx at due_date + 61d → outside window.
  const tooLateTx = {
    ...lateTx,
    date: '2026-07-30'
  };
  const tooLate = generateSalesInvoiceCandidates({
    transactions: [tooLateTx],
    document: { ...STD_DOC, reference_number: 'ABSENT' },
    existingMatches: []
  });
  assert.equal(tooLate.candidates.length, 0,
    'tx at due+61d is outside window');
});

// ── 24: matcher does not interact with receipts / non-AR matches ───────
await test('AR matcher ignores receipt-typed match rows in suppression / settlement reads', () => {
  // A receipt match row on the same tx must NOT count toward
  // suppression or partial-completion math. The matcher's
  // matched_object_type filter is namespace separation.
  const candidates = generateSalesInvoiceCandidates({
    transactions: [STD_TX],
    document: STD_DOC,
    existingMatches: [
      // Receipt match — same tx, different doc, different type.
      {
        id: 'recon-receipt',
        bank_transaction_id: STD_TX.id,
        matched_object_type: 'receipt',
        matched_object_id: 'doc-receipt-x',
        status: 'confirmed',
        match_amount: 2500
      }
    ]
  });
  // No prior settled (the receipt match doesn't pollute AR math).
  assert.equal(candidates.candidates.length, 1, 'AR candidate generated');
  assert.equal(candidates.candidates[0].match_reason.settled_before, 0,
    'receipt match does not contribute to AR settled sum');
});

// ── pg-Date regression: rows carry Date objects, not ISO strings ───────
// Mirrors billReconciliation.test.js — see the note there. Tier 3 is
// the only tier gated on within_window, so it probes the window math.
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
        money_in: 2475,
        date: new Date('2026-05-15T00:00:00Z'),
        description: 'WIRE FROM GLOBEX INDUSTRIES'
      }]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runSalesInvoiceReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1, 'Date-object rows must still produce the tier-3 candidate');
    const payload = JSON.parse(findInsert(client).params.slice(-1)[0]);
    assert.equal(payload.match_reason.confidence_tier, 'amount_near_customer');
    assert.ok(payload.match_reason.hints.includes('within_window'));
  } finally {
    disableFlag();
  }
});

console.log(`\nsalesInvoiceReconciliation: tests complete.`);
