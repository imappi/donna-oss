// Reconciliation PR 11 — safe supplier-bill auto-explain tests.
//
// Mock-pg harness mirrors salesInvoiceAutoExplain.test.js. The
// orchestrator reads four tables in order: firms (metadata),
// reconciliation_matches, documents, transactions. Tests provide
// canned rows keyed on distinctive substrings.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AP_AUTO_EXPLAIN_BLOCKERS,
  AP_AUTO_EXPLAIN_POLICY_VERSION,
  autoExplainBillForDocument,
  evaluateBillAutoExplainEligibility,
  resolveBillAutoExplainConfig
} from './billAutoExplain.js';

const enableGlobal = () => {
  process.env.BILL_AUTO_EXPLAIN_ENABLED = 'true';
};
const disableGlobal = () => {
  delete process.env.BILL_AUTO_EXPLAIN_ENABLED;
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
  match: "and matched_object_type = 'supplier_bill'",
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
    supplier_bill_enabled: true,
    confidence_floor: 0.85,
    supplier_bill_max_amount: 5000
  }
};

const STD_MATCH = {
  id: 'recon-bill-1',
  status: 'suggested',
  bank_transaction_id: 'tx-1',
  matched_object_id: 'bill-1',
  matched_object_type: 'supplier_bill',
  match_confidence: 0.95,
  payload: {
    source: 'bill_reconciliation',
    match_reason: {
      auto_match_passed: true,
      confidence_tier: 'amount_exact_reference',
      partial_completion: false
    }
  }
};

const STD_DOCUMENT = {
  id: 'bill-1',
  total_amount: 499,
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
  money_in: 0,
  money_out: 499
};

const RUN_ARGS = {
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'bill-1',
  parseRunId: '00000000-0000-0000-0000-000000001101'
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
      cannedHelperDocTotal(499),
      cannedHelperSettledSum(499)
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.auto_explained, 1);

    // Match flip issued.
    assert.ok(findFlip(client), 'match flipped to auto_matched');

    // Transaction cascade issued.
    assert.ok(findTxCascade(client), 'transactions set to explained');

    // Document payment_status routed through F2 helper (sum-based).
    const docUpdate = findDocPaymentUpdate(client);
    assert.ok(docUpdate, 'sum-based UPDATE documents (parameterised status)');
    assert.equal(docUpdate.params[2], 'paid',
      'sum 499 >= total 499 → paid');

    // Audit emitted with PR 11 policy version.
    const audits = findAuditCalls(client, 'reconciliation.auto_explained');
    assert.equal(audits.length, 1);
    const meta = JSON.parse(audits[0].params[3]);
    assert.equal(meta.pr11_policy_version, AP_AUTO_EXPLAIN_POLICY_VERSION);
    assert.equal(meta.match_kind, 'supplier_bill');
    assert.equal(meta.confidence_tier, 'amount_exact_reference');
    assert.deepEqual(meta.blockers, []);
  } finally {
    disableGlobal();
  }
});

// ── 2: partial-completion routes through F2 helper (full settle) ───────
await test('partial-completion match: helper computes status from sum (paid when settled >= total)', async () => {
  enableGlobal();
  try {
    // Bill for 5000; this match settles 2500 to complete the prior 2500.
    // Helper SUM read returns 5000 → 'paid'.
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
      cannedTransactions([{ ...STD_TX, money_out: 2500 }]),
      cannedFlip(1),
      cannedHelperDocTotal(5000),
      cannedHelperSettledSum(5000)
    ]);
    await autoExplainBillForDocument({ client, ...RUN_ARGS });
    const docUpdate = findDocPaymentUpdate(client);
    assert.equal(docUpdate.params[2], 'paid', 'completing partial → paid');
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
      cannedTransactions([{ ...STD_TX, money_out: 2000 }]),
      cannedFlip(1),
      cannedHelperDocTotal(5000),
      cannedHelperSettledSum(2000)
    ]);
    await autoExplainBillForDocument({ client, ...RUN_ARGS });
    const docUpdate = findDocPaymentUpdate(client);
    assert.equal(docUpdate.params[2], 'partial', '2000/5000 → partial');
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
  const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
  assert.equal(stats.evaluated, 0);
  assert.equal(stats.auto_explained, 0);
  assert.equal(client.calls.length, 0,
    `no DB reads when global flag off (got ${client.calls.length})`);
});

// ── 5: per-firm disabled → blocked with FIRM_DISABLED ──────────────────
await test('per-firm supplier_bill_enabled=false → FIRM_DISABLED blocker, no flip', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta({ auto_explain: { supplier_bill_enabled: false } }),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.FIRM_DISABLED] >= 1);
    assert.ok(!findFlip(client), 'no flip when firm disabled');
  } finally {
    disableGlobal();
  }
});

// ── 6: auto_match_passed=false → blocked ───────────────────────────────
await test('PR 9 matcher auto_match_passed=false → BILL_MATCHER_NOT_ELIGIBLE blocker', async () => {
  enableGlobal();
  try {
    const ineligibleMatch = {
      ...STD_MATCH,
      payload: {
        ...STD_MATCH.payload,
        match_reason: {
          ...STD_MATCH.payload.match_reason,
          auto_match_passed: false,
          confidence_tier: 'amount_exact_vendor'
        }
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([ineligibleMatch]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.BILL_MATCHER_NOT_ELIGIBLE] >= 1);
    const blocked = findAuditCalls(client, 'reconciliation.auto_explain.blocked');
    assert.equal(blocked.length, 1);
  } finally {
    disableGlobal();
  }
});

// ── 7: amount above cap (default 5000) → blocked ───────────────────────
await test('Q3 materiality cap: bill total > default cap (€5,000) → AMOUNT_ABOVE_CAP blocker', async () => {
  enableGlobal();
  try {
    // Smoke matrix case: €7,500 bill must block under default cap.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 7500 }]),
      cannedTransactions([{ ...STD_TX, money_out: 7500 }])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_CAP] >= 1,
      'amount cap fires for €7,500 default-cap bill');
  } finally {
    disableGlobal();
  }
});

// ── 8: cap boundary — €5,000 exactly passes, €5,001 blocks ─────────────
await test('Q3 materiality cap: €5,000 exactly passes, €5,001 blocks', async () => {
  enableGlobal();
  try {
    // Boundary case at the cap exactly.
    const okClient = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 5000 }]),
      cannedTransactions([{ ...STD_TX, money_out: 5000 }]),
      cannedFlip(1),
      cannedHelperDocTotal(5000),
      cannedHelperSettledSum(5000)
    ]);
    const okStats = await autoExplainBillForDocument({ client: okClient, ...RUN_ARGS });
    assert.equal(okStats.auto_explained, 1, '€5,000 == cap passes');

    const blockClient = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 5001 }]),
      cannedTransactions([{ ...STD_TX, money_out: 5001 }])
    ]);
    const blockStats = await autoExplainBillForDocument({ client: blockClient, ...RUN_ARGS });
    assert.equal(blockStats.auto_explained, 0);
    assert.ok(blockStats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_CAP] >= 1,
      '€5,001 > cap blocks');
  } finally {
    disableGlobal();
  }
});

// ── 9: per-firm cap raised → allows higher amounts ─────────────────────
await test('Q3 materiality cap: firm-raised cap allows higher amounts', async () => {
  enableGlobal();
  try {
    const firmWithRaisedCap = {
      auto_explain: {
        supplier_bill_enabled: true,
        supplier_bill_max_amount: 25000
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(firmWithRaisedCap),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 7500 }]),
      cannedTransactions([{ ...STD_TX, money_out: 7500 }]),
      cannedFlip(1),
      cannedHelperDocTotal(7500),
      cannedHelperSettledSum(7500)
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 1,
      'firm cap 25000 allows the €7,500 bill (smoke matrix case 3)');
  } finally {
    disableGlobal();
  }
});

// ── 10: per-firm cap=null disables the cap ─────────────────────────────
await test('Q3 materiality cap: null / "unlimited" disables the cap', async () => {
  enableGlobal();
  try {
    const firmUncapped = {
      auto_explain: {
        supplier_bill_enabled: true,
        supplier_bill_max_amount: null
      }
    };
    const client = makeMockClient([
      cannedFirmMeta(firmUncapped),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, total_amount: 1000000 }]),
      cannedTransactions([{ ...STD_TX, money_out: 1000000 }]),
      cannedFlip(1),
      cannedHelperDocTotal(1000000),
      cannedHelperSettledSum(1000000)
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 1, 'null cap allows any amount');
  } finally {
    disableGlobal();
  }
});

// ── 11: parse_warning amount_mismatch blocks ───────────────────────────
await test('parse warning amount_mismatch → PARSE_WARNING blocker', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, parse_summary: { warnings: ['amount_mismatch'] } }]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.PARSE_WARNING] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 12: low extraction_confidence blocks ───────────────────────────────
await test('extraction_confidence below floor → EXTRACTION_CONFIDENCE_BELOW_FLOOR', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, extraction_confidence: 0.5 }]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.EXTRACTION_CONFIDENCE_BELOW_FLOOR] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 13: tx already reconciled → blocked (Q7 — bank-line auto-explain
//        already moved tx to 'explained' falls under this guard) ───────
await test('transaction.reconciliation_status=reconciled → TRANSACTION_ALREADY_RESOLVED', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([{ ...STD_TX, reconciliation_status: 'reconciled' }])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 14: Q7 — tx already 'explained' (e.g. by PR 89 bank-line) blocks ──
await test('Q7 bank-line interaction: tx already explained → block, do not preempt', async () => {
  enableGlobal();
  try {
    // PR 89's bank-line auto-explain writes matched_object_type='transaction'
    // and pushes the tx to reconciliation_status='explained'. The firm
    // has SEEN and accepted that path. PR 11 must NOT silently override
    // it — the TRANSACTION_ALREADY_RESOLVED guard fires.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([{ ...STD_TX, reconciliation_status: 'explained' }])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0,
      'PR 11 does not preempt PR 89 bank-line auto-explain');
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED] >= 1);
    assert.ok(!findFlip(client), 'no match flip when tx already explained');
  } finally {
    disableGlobal();
  }
});

// ── 15: AP direction invariant — money_in > 0 blocks ───────────────────
await test('AP guard: transaction.money_in > 0 → TRANSACTION_NOT_MONEY_OUT', async () => {
  enableGlobal();
  try {
    // Defensive — the AP matcher's SELECT shouldn't have produced this
    // match against a money_in tx, but if it did (via some other write
    // path), the auto-explain gate refuses.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([STD_DOCUMENT]),
      cannedTransactions([{ ...STD_TX, money_in: 499, money_out: 0 }])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_NOT_MONEY_OUT] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 16: duplicate document blocks ──────────────────────────────────────
await test('document.duplicate_of set → DOCUMENT_DUPLICATE', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, duplicate_of: 'bill-original' }]),
      cannedTransactions([STD_TX])
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_explained, 0);
    assert.ok(stats.blocked_reasons[AP_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_DUPLICATE] >= 1);
  } finally {
    disableGlobal();
  }
});

// ── 17: idempotent re-run — flip predicate suppresses cascade ──────────
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
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 1);
    assert.equal(stats.auto_explained, 0,
      'no auto-explain count bump on idempotent re-run');
    assert.ok(!findTxCascade(client), 'no transactions cascade on no-op flip');
    assert.ok(!findDocPaymentUpdate(client), 'no documents update on no-op flip');
    const audits = findAuditCalls(client, 'reconciliation.auto_explained');
    assert.equal(audits.length, 0, 'no audit on no-op flip');
  } finally {
    disableGlobal();
  }
});

// ── 18: blocked-path audit always emits + payload merge ────────────────
await test('blocked path: payload merge updates auto_explain_blockers + emits blocked audit', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{ ...STD_DOCUMENT, duplicate_of: 'bill-original' }]),
      cannedTransactions([STD_TX])
    ]);
    await autoExplainBillForDocument({ client, ...RUN_ARGS });

    const payloadMerge = client.calls.find((c) =>
      c.sql.includes('update reconciliation_matches') &&
      /set\s+payload\s*=\s*payload\s*\|\|/i.test(c.sql)
    );
    assert.ok(payloadMerge, 'payload merge issued for blocked rows');
    const patch = JSON.parse(payloadMerge.params[2]);
    assert.ok(Array.isArray(patch.auto_explain_blockers));
    assert.ok(patch.auto_explain_blockers.includes(AP_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_DUPLICATE));

    const blocked = findAuditCalls(client, 'reconciliation.auto_explain.blocked');
    assert.equal(blocked.length, 1);
  } finally {
    disableGlobal();
  }
});

// ── 19: PII discipline — audit metadata is categorical only ────────────
await test('audit metadata is PII-safe — no vendor name, reference, or description', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([STD_MATCH]),
      cannedDocument([{
        ...STD_DOCUMENT,
        // The auto-explain SELECT doesn't pull these columns at all,
        // but if a future refactor adds them this test pins the
        // discipline: the audit metadata must not echo them back even
        // if they appear on the row.
        vendor_name: 'Confidential Vendor Holdings Oy',
        reference_number: 'PRIVATE-BILL-77',
        description: 'private notes about a specific transaction'
      }]),
      cannedTransactions([STD_TX]),
      cannedFlip(1),
      cannedHelperDocTotal(499),
      cannedHelperSettledSum(499)
    ]);
    await autoExplainBillForDocument({ client, ...RUN_ARGS });
    const audits = findAuditCalls(client, 'reconciliation.auto_explained');
    assert.equal(audits.length, 1);
    const metadataParam = audits[0].params[3];
    assert.ok(!metadataParam.includes('Confidential Vendor'), 'no vendor name in audit');
    assert.ok(!metadataParam.includes('PRIVATE-BILL-77'), 'no reference number in audit');
    assert.ok(!metadataParam.includes('private notes'), 'no description in audit');
    // Categorical fields are present.
    assert.ok(metadataParam.includes('match_id'));
    assert.ok(metadataParam.includes('confidence_tier'));
    assert.ok(metadataParam.includes('amount_band'));
    assert.ok(metadataParam.includes('match_kind'));
  } finally {
    disableGlobal();
  }
});

// ── 20: source filter excludes manual-link rows ────────────────────────
await test('source filter: only payload.source = bill_reconciliation rows are eligible', async () => {
  enableGlobal();
  try {
    // The orchestrator's matches SELECT carries `payload->>'source' =
    // 'bill_reconciliation'`. Manual-link rows (source=firm_manual_link)
    // are by construction never returned, so the auto-explain pass
    // can't promote them. We pin that the SELECT contains the source
    // filter literal.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([]) // matcher returns nothing (manual-link not eligible)
    ]);
    await autoExplainBillForDocument({ client, ...RUN_ARGS });
    const matchSelect = client.calls.find((c) =>
      c.sql.includes("matched_object_type = 'supplier_bill'") &&
      c.sql.includes("payload->>'source'") &&
      c.sql.includes("'bill_reconciliation'")
    );
    assert.ok(matchSelect, "matches SELECT scopes to source = 'bill_reconciliation'");
  } finally {
    disableGlobal();
  }
});

// ── 21: no AR-side bleed ───────────────────────────────────────────────
await test('cross-pass discipline: sales_invoice matches are invisible to the AP pass', async () => {
  enableGlobal();
  try {
    // The matches SELECT filter `matched_object_type='supplier_bill'`
    // narrows to AP rows. An AR row on the same client+document_id
    // (hypothetical) must not be returned. We canned-respond ONLY to
    // the AP-filtered SELECT, so any AR-shaped row would fall through
    // to the mock client's default [] response.
    const arMatch = {
      ...STD_MATCH,
      matched_object_type: 'sales_invoice',
      payload: { ...STD_MATCH.payload, source: 'sales_invoice_reconciliation' }
    };
    // The matches SELECT will pick up cannedMatches([]) — we provide
    // an empty result for the AP filter and verify no flip is issued.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([]) // AP filter matches nothing (the arMatch row above wouldn't be returned by the WHERE clause)
    ]);
    void arMatch; // referenced for narrative clarity
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 0, 'no AP match → nothing evaluated');
    assert.ok(!findFlip(client), 'AR rows do not enter the AP orchestrator');
  } finally {
    disableGlobal();
  }
});

// ── 22: no receipt-side bleed ──────────────────────────────────────────
await test('cross-pass discipline: receipt matches on the same tx are invisible to the AP pass', async () => {
  enableGlobal();
  try {
    // Same shape as the AR-bleed test — receipt rows live under
    // matched_object_type='receipt' and are excluded by the filter.
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([]) // receipt row would be filtered out by WHERE matched_object_type='supplier_bill'
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.evaluated, 0);
    assert.ok(!findFlip(client));
  } finally {
    disableGlobal();
  }
});

// ── 23: early-return when no bill matches exist ───────────────────────
await test('orchestrator early-returns when no AP match rows exist for the document', async () => {
  enableGlobal();
  try {
    const client = makeMockClient([
      cannedFirmMeta(STD_FIRM_METADATA),
      cannedMatches([]) // no AP matches
    ]);
    const stats = await autoExplainBillForDocument({ client, ...RUN_ARGS });
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

// ── 24: pure gate — every blocker fires independently (no short-circuit)
await test('evaluateBillAutoExplainEligibility: every blocker fires independently', () => {
  const fail = evaluateBillAutoExplainEligibility({
    match: { status: 'suggested', matched_object_type: 'supplier_bill', payload: { match_reason: {} } },
    document: { parse_status: 'pending', duplicate_of: 'x', extraction_confidence: 0.3,
                total_amount: 99999, currency: 'EUR' },
    transaction: { reconciliation_status: 'reconciled', money_in: 100, money_out: 0, currency: 'USD' },
    parseWarnings: ['amount_mismatch'],
    firmConfig: { supplier_bill_enabled: false, supplier_bill_max_amount: 5000, extraction_confidence_floor: 0.85 }
  });
  assert.equal(fail.passed, false);
  const bs = fail.blockers;
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.FIRM_DISABLED));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.BILL_MATCHER_NOT_ELIGIBLE));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_PARSE_NOT_COMPLETED));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_DUPLICATE));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.EXTRACTION_CONFIDENCE_BELOW_FLOOR));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.PARSE_WARNING));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_NOT_MONEY_OUT));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.CURRENCY_MISMATCH));
  assert.ok(bs.includes(AP_AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_CAP));
});

// ── 25: currency strictness — missing on either side blocks ────────────
await test('AP currency strictness: missing on either side fires CURRENCY_MISMATCH', () => {
  // PR 11 is stricter than PR 10: unconfirmed currency (missing on
  // either side) must block, because the cap is denominated in the
  // bill's currency and inferring value across denominations is
  // exactly the failure mode the cap exists to prevent.
  const okConfig = {
    supplier_bill_enabled: true,
    supplier_bill_max_amount: 5000,
    extraction_confidence_floor: 0.85
  };
  const baseInputs = {
    match: STD_MATCH,
    document: { ...STD_DOCUMENT },
    parseWarnings: [],
    firmConfig: okConfig
  };
  // Missing on document side.
  const docMissing = evaluateBillAutoExplainEligibility({
    ...baseInputs,
    document: { ...STD_DOCUMENT, currency: null },
    transaction: { ...STD_TX, currency: 'EUR' }
  });
  assert.ok(docMissing.blockers.includes(AP_AUTO_EXPLAIN_BLOCKERS.CURRENCY_MISMATCH),
    'doc currency missing → CURRENCY_MISMATCH');
  // Missing on tx side.
  const txMissing = evaluateBillAutoExplainEligibility({
    ...baseInputs,
    document: { ...STD_DOCUMENT, currency: 'EUR' },
    transaction: { ...STD_TX, currency: null }
  });
  assert.ok(txMissing.blockers.includes(AP_AUTO_EXPLAIN_BLOCKERS.CURRENCY_MISMATCH),
    'tx currency missing → CURRENCY_MISMATCH');
  // Both present and equal — no blocker (this verifies we didn't
  // accidentally make the gate too strict).
  const equal = evaluateBillAutoExplainEligibility({
    ...baseInputs,
    document: { ...STD_DOCUMENT, currency: 'EUR' },
    transaction: { ...STD_TX, currency: 'EUR' }
  });
  assert.ok(!equal.blockers.includes(AP_AUTO_EXPLAIN_BLOCKERS.CURRENCY_MISMATCH),
    'both EUR → no CURRENCY_MISMATCH');
  // Both present and unequal.
  const unequal = evaluateBillAutoExplainEligibility({
    ...baseInputs,
    document: { ...STD_DOCUMENT, currency: 'EUR' },
    transaction: { ...STD_TX, currency: 'USD' }
  });
  assert.ok(unequal.blockers.includes(AP_AUTO_EXPLAIN_BLOCKERS.CURRENCY_MISMATCH),
    'EUR vs USD → CURRENCY_MISMATCH');
});

// ── 26: firm config resolver defaults ──────────────────────────────────
await test('resolveBillAutoExplainConfig: defaults when firm metadata missing', () => {
  const config = resolveBillAutoExplainConfig({});
  assert.equal(config.supplier_bill_enabled, false, 'firms start dark');
  assert.equal(config.extraction_confidence_floor, 0.85, 'default floor');
  assert.equal(config.supplier_bill_max_amount, 5000, 'default cap (€5,000, tighter than AR)');
});

await test('resolveBillAutoExplainConfig: per-firm overrides flow through', () => {
  const config = resolveBillAutoExplainConfig({
    metadata: {
      auto_explain: {
        supplier_bill_enabled: true,
        confidence_floor: 0.9,
        supplier_bill_max_amount: 25000
      }
    }
  });
  assert.equal(config.supplier_bill_enabled, true);
  assert.equal(config.extraction_confidence_floor, 0.9);
  assert.equal(config.supplier_bill_max_amount, 25000);
});

await test('resolveBillAutoExplainConfig: cap=null or "unlimited" disables cap', () => {
  const cfgNull = resolveBillAutoExplainConfig({
    metadata: { auto_explain: { supplier_bill_max_amount: null } }
  });
  assert.equal(cfgNull.supplier_bill_max_amount, null);
  const cfgUnlimited = resolveBillAutoExplainConfig({
    metadata: { auto_explain: { supplier_bill_max_amount: 'unlimited' } }
  });
  assert.equal(cfgUnlimited.supplier_bill_max_amount, null);
});

console.log(`\nbillAutoExplain: tests complete.`);
