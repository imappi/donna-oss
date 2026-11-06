// Reconciliation PR 10 — safe sales-invoice auto-explain tests.
//
// Mock-pg harness mirrors receiptAutoExplain.test.js. The orchestrator
// reads four tables in order: firms (metadata), reconciliation_matches,
// documents, transactions. Tests provide canned rows keyed on
// distinctive substrings.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AR_AUTO_EXPLAIN_BLOCKERS,
  AR_AUTO_EXPLAIN_POLICY_VERSION,
  autoExplainSalesInvoiceForDocument,
  evaluateArAutoExplainEligibility,
  resolveArAutoExplainConfig
} from './salesInvoiceAutoExplain.js';

const enableGlobal = () => {
  process.env.SALES_INVOICE_AUTO_EXPLAIN_ENABLED = 'true';
};
const disableGlobal = () => {
  delete process.env.SALES_INVOICE_AUTO_EXPLAIN_ENABLED;
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
        return {
          rows: response.rows || [],
          rowCount: response.rowCount == null ? (response.rows || []).length : response.rowCount
        };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

// Canned responses keyed on distinctive SQL fragments.
const cannedFirmMeta = (metadata) => ({
  match: 'select metadata from firms',
  rows: [{ metadata }]
});
const cannedMatches = (rows) => ({
  match: "and matched_object_type = 'sales_invoice'",
  rows
});
const cannedDocument = (rows) => ({
  match: 'from documents',
  rows
});
const cannedTransactions = (rows) => ({
  match: 'from transactions',
  rows
});
// Promotion flip — predicate is `where id = $1 and firm_id = $2 and status = 'suggested'`.
const cannedFlip = (rowCount = 1) => ({
  match: "set status = 'auto_matched'",
  rows: rowCount ? [{ id: 'flipped' }] : [],
  rowCount
});
// F2 helper's reads. Used by applyDocumentPaymentStatusAfterMatch.
const cannedHelperDocTotal = (total) => ({
  match: 'select total_amount from documents',
  rows: [{ total_amount: total }]
});
const cannedHelperSettledSum = (settled) => ({
  match: 'coalesce(sum(case when matched_object_id=$3 then match_amount',
  rows: [{ settled }]
});

// Standard fixtures.
const STD_FIRM_METADATA = {
  auto_explain: {
    sales_invoice_enabled: true,
    confidence_floor: 0.85,
    sales_invoice_max_amount: 10000
  }
};

const STD_MATCH = {
  id: 'recon-si-1',
  status: 'suggested',
  bank_transaction_id: 'tx-1',
  matched_object_id: 'si-1',
  matched_object_type: 'sales_invoice',
  match_confidence: 0.95,
  payload: {
    source: 'sales_invoice_reconciliation',
    match_reason: {
      auto_match_passed: true,
      confidence_tier: 'amount_exact_reference',
      partial_completion: false
    }
  }
};

const STD_DOCUMENT = {
  id: 'si-1',
  total_amount: 2500,
  currency: 'EUR',
  payment_status: 'unpaid',
  parse_status: 'completed',
  extraction_confidence: 0.95,
  parse_summary: { warnings: [] },
  duplicate_of: null
};

const STD_TX = {
  id: 'tx-1',
  reconciliation_status: null,
  currency: 'EUR',
  money_in: 2500,
  money_out: 0
};

const RUN_ARGS = {
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'si-1',
  parseRunId: '00000000-0000-0000-0000-000000001001'
};

const findFlip = (client) =>
  client.calls.find((c) =>
    c.sql.includes("set status = 'auto_matched'")
  );
const findTxCascade = (client) =>
  client.calls.find((c) =>
    /update\s+transactions[\s\S]*reconciliation_status\s*=\s*'explained'/i.test(c.sql)
  );
const findDocPaymentUpdate = (client) =>
  client.calls.find((c) =>
    /update\s+documents[\s\S]*set\s+payment_status\s*=\s*\$3/i.test(c.sql)
  );
const findAuditCalls = (client, action) =>
  client.calls.filter((c) => {
    if (!c.sql.includes('audit_events')) return false;
    if (!c.sql.toLowerCase().includes('insert')) return false;
    if (!action) return true;
    // PR 10's orchestrator encodes the action as a SQL literal (mirrors
    // receiptAutoExplain.js); the AR + bill matchers parameterise it.
    // Check both spots so the helper works for both audit styles.
    if (c.sql.includes(action)) return true;
    return (c.params || []).some((p) => String(p) === action);
  });

// ── 1: happy path ──────────────────────────────────────────────────────
await test('happy path: tier-1 auto_match_passed → flip + cascade + audit', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([STD_TX]),
      cannedFlip(1),
      cannedHelperDocTotal(2500),
      cannedHelperSettledSum(2500)
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.auto_explained, 1);

    // Match flip issued.
    assert.ok(findFlip(client), 'match flipped to auto_matched');

    // Transaction cascade issued.
    const txCascade = findTxCascade(client);
    assert.ok(txCascade, 'transactions set to explained');

    // Document payment_status routed through F2 helper (sum-based).
    const docUpdate = findDocPaymentUpdate(client);
    assert.ok(docUpdate, 'sum-based UPDATE documents (parameterised status)');
    assert.equal(docUpdate.params[2], 'paid',
      'sum 2500 >= total 2500 → paid');

    // Audit emitted with PR 10 policy version.
    const audits = findAuditCalls(client, 'reconciliation.auto_explained');
    assert.equal(audits.length, 1);
    const meta = JSON.parse(audits[0].params[3]);
    assert.equal(meta.pr10_policy_version, AR_AUTO_EXPLAIN_POLICY_VERSION);
    assert.equal(meta.match_kind, 'sales_invoice');
    assert.equal(meta.confidence_tier, 'amount_exact_reference');
    assert.deepEqual(meta.blockers, []);
  } finally {
    disableGlobal();
  }
});

// ── 2: partial-completion routes through F2 helper correctly ───────────
await test('partial-completion match: helper computes status from sum (paid when settled >= total)', async () => {
  enableGlobal();
  try {
    // Invoice for 5000; this match settles 2500 (the remaining due
    // after a prior 2500 confirmed). Helper SUM read returns 5000.
    const partialMatch = {
      ...STD_MATCH,
      match_confidence: 0.95,
      payload: {
        ...STD_MATCH.payload,
        match_reason: {
          ...STD_MATCH.payload.match_reason,
          partial_completion: true
        }
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([partialMatch]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 5000 }]),
      cannedTransactions([{ ...STD_TX, money_in: 2500 }]),
      cannedFlip(1),
      cannedHelperDocTotal(5000),
      cannedHelperSettledSum(5000)
    ]);
    await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    const docUpdate = findDocPaymentUpdate(client);
    assert.equal(docUpdate.params[2], 'paid',
      'completing partial → paid');
    const audits = findAuditCalls(client, 'reconciliation.auto_explained');
    const meta = JSON.parse(audits[0].params[3]);
    assert.equal(meta.partial_completion, true, 'audit records partial_completion');
  } finally {
    disableGlobal();
  }
});

// ── 3: partial-completion that doesn't fully settle → partial ──────────
await test('partial match where sum < total → status flips to partial via helper', async () => {
  enableGlobal();
  try {
    const partialMatch = {
      ...STD_MATCH,
      payload: {
        ...STD_MATCH.payload,
        match_reason: {
          ...STD_MATCH.payload.match_reason,
          partial_completion: true
        }
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([partialMatch]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 5000 }]),
      cannedTransactions([{ ...STD_TX, money_in: 2000 }]),
      cannedFlip(1),
      cannedHelperDocTotal(5000),
      cannedHelperSettledSum(2000)
    ]);
    await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    const docUpdate = findDocPaymentUpdate(client);
    assert.equal(docUpdate.params[2], 'partial',
      '2000/5000 → partial');
  } finally {
    disableGlobal();
  }
});

// ── 4: global kill switch off → zero DB reads ──────────────────────────
await test('global kill switch off → orchestrator returns ZERO_STATS before any DB read', async () => {
  disableGlobal();
  const client = makeMockClient([
    cannedFirmMeta(STD_FIRM_METADATA),
    cannedMatches([STD_MATCH]),
    cannedDocument([STD_DOCUMENT]),
    cannedTransactions([STD_TX])
  ]);
  const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
  assert.equal(stats.evaluated, 0);
  assert.equal(stats.auto_explained, 0);
  assert.equal(client.calls.length, 0,
    `no DB reads when global flag off (got ${client.calls.length})`);
});

// ── 5: per-firm disabled → blocked with FIRM_DISABLED ──────────────────
await test('per-firm sales_invoice_enabled=false → FIRM_DISABLED blocker, no flip', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta({ auto_explain: { sales_invoice_enabled: false } }),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.FIRM_DISABLED] >= 1);
    assert.ok(!findFlip(client), 'no flip when firm disabled');
  } finally {
    disableGlobal();
  }
});

// ── 6: auto_match_passed=false → blocked ───────────────────────────────
await test('PR 8 matcher auto_match_passed=false → AR_MATCHER_NOT_ELIGIBLE blocker', async () => {
  enableGlobal();
  try {
    const ineligibleMatch = {
      ...STD_MATCH,
      payload: {
        ...STD_MATCH.payload,
        match_reason: {
          ...STD_MATCH.payload.match_reason,
          auto_match_passed: false,
          confidence_tier: 'amount_exact_customer'
        }
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([ineligibleMatch]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.AR_MATCHER_NOT_ELIGIBLE] >= 1);
    const blocked = findAuditCalls(client, 'reconciliation.auto_explain.blocked');
    assert.equal(blocked.length, 1);
  } finally {
    disableGlobal();
  }
});

// ── 7: amount above cap → blocked ──────────────────────────────────────
await test('Q3 materiality cap: invoice total > cap → AMOUNT_ABOVE_CAP blocker', async () => {
  enableGlobal();
  try {
    // Default cap is 10,000; this invoice is 15,000.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 15000 }]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_CAP] >= 1,
      'amount cap fires');
  } finally {
    disableGlobal();
  }
});

// ── 8: per-firm cap raised → allows higher amounts ─────────────────────
await test('Q3 materiality cap: firm-raised cap allows higher amounts', async () => {
  enableGlobal();
  try {
    const firmWithRaisedCap = {
      auto_explain: {
        sales_invoice_enabled: true,
        sales_invoice_max_amount: 50000
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(firmWithRaisedCap),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 25000 }]),
      cannedTransactions([STD_TX]),
      cannedFlip(1),
      cannedHelperDocTotal(25000),
      cannedHelperSettledSum(25000)
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 1,
      'firm cap 50000 allows the 25000 invoice');
  } finally {
    disableGlobal();
  }
});

// ── 9: per-firm cap=null disables the cap ──────────────────────────────
await test('Q3 materiality cap: null / "unlimited" disables the cap', async () => {
  enableGlobal();
  try {
    const firmUncapped = {
      auto_explain: {
        sales_invoice_enabled: true,
        sales_invoice_max_amount: null
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(firmUncapped),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 1000000 }]),
      cannedTransactions([STD_TX]),
      cannedFlip(1),
      cannedHelperDocTotal(1000000),
      cannedHelperSettledSum(1000000)
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 1, 'null cap allows any amount');
  } finally {
    disableGlobal();
  }
});

// ── 10: parse_warning amount_mismatch blocks ───────────────────────────
await test('parse warning amount_mismatch → PARSE_WARNING blocker', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, parse_summary: { warnings: ['amount_mismatch'] } }]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.PARSE_WARNING] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 11: low extraction_confidence blocks ───────────────────────────────
await test('extraction_confidence below floor → EXTRACTION_CONFIDENCE_BELOW_FLOOR', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, extraction_confidence: 0.5 }]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.EXTRACTION_CONFIDENCE_BELOW_FLOOR] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 12: transaction already reconciled blocks ──────────────────────────
await test('transaction.reconciliation_status=reconciled → TRANSACTION_ALREADY_RESOLVED', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([{ ...STD_TX, reconciliation_status: 'reconciled' }])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 13: Q2 extra guard — tx not money_in blocks ────────────────────────
await test('Q2 guard: transaction.money_in=0 → TRANSACTION_NOT_MONEY_IN', async () => {
  enableGlobal();
  try {
    // Defensive — the AR matcher's SELECT shouldn't have produced
    // this match against a money_out tx, but if it did (via some
    // other write path), the auto-explain gate refuses.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([{ ...STD_TX, money_in: 0, money_out: 2500 }])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_NOT_MONEY_IN] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 14: Q2 extra guard — duplicate document blocks ─────────────────────
await test('Q2 guard: document.duplicate_of set → DOCUMENT_DUPLICATE', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, duplicate_of: 'si-original' }]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AR_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_DUPLICATE] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 15: idempotent re-run — flip predicate suppresses cascade ──────────
await test('idempotency: re-run when row already auto_matched → flip no-ops, no cascade, no audit', async () => {
  enableGlobal();
  try {
    // The match was flipped on a prior pass; the flip UPDATE's
    // predicate (`status='suggested'`) matches zero rows → flipped=false
    // → cascade + audit suppressed.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([STD_TX]),
      cannedFlip(0) // zero rows updated
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.auto_explained, 0,
      'no auto-explain count bump on idempotent re-run');
    // Neither the tx cascade nor the document payment update should fire.
    assert.ok(!findTxCascade(client), 'no transactions cascade on no-op flip');
    assert.ok(!findDocPaymentUpdate(client), 'no documents update on no-op flip');
    // No audit either.
    const audits = findAuditCalls(client, 'reconciliation.auto_explained');
    assert.equal(audits.length, 0, 'no audit on no-op flip');
  } finally {
    disableGlobal();
  }
});

// ── 16: blocked-path audit always emits + payload merge ────────────────
await test('blocked path: payload merge updates auto_explain_blockers + emits blocked audit', async () => {
  enableGlobal();
  try {
    // Use the duplicate-document blocker for a clean negative case.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, duplicate_of: 'si-original' }]),
      cannedTransactions([STD_TX])
    ]);
    await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });

    // The match payload merge MUST fire to surface the blocker list
    // to the FE review surface.
    const payloadMerge = client.calls.find((c) =>
      c.sql.includes('update reconciliation_matches') &&
      /set\s+payload\s*=\s*payload\s*\|\|/i.test(c.sql)
    );
    assert.ok(payloadMerge, 'payload merge issued for blocked rows');
    const patch = JSON.parse(payloadMerge.params[2]);
    assert.ok(Array.isArray(patch.auto_explain_blockers));
    assert.ok(patch.auto_explain_blockers.includes(AR_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_DUPLICATE));

    // Blocked-path audit fires.
    const blocked = findAuditCalls(client, 'reconciliation.auto_explain.blocked');
    assert.equal(blocked.length, 1);
  } finally {
    disableGlobal();
  }
});

// ── 17: PII discipline — audit metadata is categorical only ────────────
await test('audit metadata is PII-safe — no customer name, reference, or description', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{
        ...STD_DOCUMENT,
        // The auto-explain SELECT doesn't pull these columns at all,
        // but if a future refactor adds them this test pins the
        // discipline: the audit metadata must not echo any of them
        // back even if they appear on the row.
        customer_name: 'Confidential Customer Holdings Oy',
        reference_number: 'PRIVATE-INV-77'
      }]),
      cannedTransactions([STD_TX]),
      cannedFlip(1),
      cannedHelperDocTotal(2500),
      cannedHelperSettledSum(2500)
    ]);
    await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    const audits = findAuditCalls(client, 'reconciliation.auto_explained');
    assert.equal(audits.length, 1);
    const metadataParam = audits[0].params[3];
    assert.ok(!metadataParam.includes('Confidential Customer'), 'no customer name in audit');
    assert.ok(!metadataParam.includes('PRIVATE-INV-77'), 'no reference number in audit');
    // Categorical fields are present.
    assert.ok(metadataParam.includes('match_id'));
    assert.ok(metadataParam.includes('confidence_tier'));
    assert.ok(metadataParam.includes('amount_band'));
    assert.ok(metadataParam.includes('match_kind'));
  } finally {
    disableGlobal();
  }
});

// ── 18: pure gate — every blocker fires independently (no short-circuit)
await test('evaluateArAutoExplainEligibility: every blocker fires independently', () => {
  const baseConfig = { sales_invoice_enabled: false }; // first blocker
  // No match → multiple blockers come from undefined fields.
  const fail = evaluateArAutoExplainEligibility({
    match: { status: 'suggested', matched_object_type: 'sales_invoice', payload: { match_reason: {} } },
    document: { parse_status: 'pending', duplicate_of: 'x', extraction_confidence: 0.3,
                total_amount: 99999, currency: 'EUR' },
    transaction: { reconciliation_status: 'reconciled', money_in: 0, money_out: 100, currency: 'USD' },
    parseWarnings: ['amount_mismatch'],
    firmConfig: { sales_invoice_enabled: false, sales_invoice_max_amount: 10000, extraction_confidence_floor: 0.85 }
  });
  // Multiple blockers should accumulate in a single pass.
  assert.equal(fail.passed, false);
  const bs = fail.blockers;
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.FIRM_DISABLED));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.AR_MATCHER_NOT_ELIGIBLE));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_PARSE_NOT_COMPLETED));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_DUPLICATE));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.EXTRACTION_CONFIDENCE_BELOW_FLOOR));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.PARSE_WARNING));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_NOT_MONEY_IN));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.CURRENCY_MISMATCH));
  assert.ok(bs.includes(AR_AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_CAP));
});

// ── 19: firm config resolver defaults ──────────────────────────────────
await test('resolveArAutoExplainConfig: defaults when firm metadata missing', () => {
  const config = resolveArAutoExplainConfig({});
  assert.equal(config.sales_invoice_enabled, false, 'firms start dark');
  assert.equal(config.extraction_confidence_floor, 0.85, 'default floor');
  assert.equal(config.sales_invoice_max_amount, 10000, 'default cap');
});

await test('resolveArAutoExplainConfig: per-firm overrides', () => {
  const config = resolveArAutoExplainConfig({
    metadata: {
      auto_explain: {
        sales_invoice_enabled: true,
        confidence_floor: 0.9,
        sales_invoice_max_amount: 25000
      }
    }
  });
  assert.equal(config.sales_invoice_enabled, true);
  assert.equal(config.extraction_confidence_floor, 0.9);
  assert.equal(config.sales_invoice_max_amount, 25000);
});

await test('resolveArAutoExplainConfig: cap=null or "unlimited" disables cap', () => {
  const cfgNull = resolveArAutoExplainConfig({
    metadata: { auto_explain: { sales_invoice_max_amount: null } }
  });
  assert.equal(cfgNull.sales_invoice_max_amount, null);
  const cfgUnlimited = resolveArAutoExplainConfig({
    metadata: { auto_explain: { sales_invoice_max_amount: 'unlimited' } }
  });
  assert.equal(cfgUnlimited.sales_invoice_max_amount, null);
});

// ── 20: orchestrator does not call when no matches present ─────────────
await test('orchestrator early-returns when no AR match rows exist for the document', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([]) // no AR matches
    ]);
    const stats = await autoExplainSalesInvoiceForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 0);
    assert.equal(stats.auto_explained, 0);
    // Document SELECT should NOT have been issued.
    const docReads = client.calls.filter((c) =>
      /from\s+documents\b[\s\S]*where\s+firm_id\s*=\s*\$1\s+and\s+id\s*=\s*\$2/i.test(c.sql)
    );
    assert.equal(docReads.length, 0,
      'no document read when no matches present (saves a SELECT)');
  } finally {
    disableGlobal();
  }
});

console.log(`\nsalesInvoiceAutoExplain: tests complete.`);
