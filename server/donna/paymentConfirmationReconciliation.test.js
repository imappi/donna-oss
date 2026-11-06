// Stage 2.5 — payment_confirmation matcher tests.
// Stage 2.6 — auto-match promotion + cascade.
//
// Same mock-pg harness as paymentAccountStatementReconciliation.test.js
// and billReconciliation.test.js. The orchestrator reuses the bill
// matcher's scoring, so the granular scoring tiers are already covered
// in billReconciliation tests; this file pins the orchestrator-shape
// (doc_type filter, matched_object_type, payload source) for the new
// type and confirms the Honeybee Amex / IRS shapes auto-match
// end-to-end.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runPaymentConfirmationReconciliationForDocument,
  __OBJECT_TYPE,
  __SOURCE_LABEL,
  __llmMatcher
} from './paymentConfirmationReconciliation.js';

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
  process.env.PAYMENT_CONFIRMATION_MATCHER_ENABLED = 'true';
};
const disableFlag = () => {
  delete process.env.PAYMENT_CONFIRMATION_MATCHER_ENABLED;
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

const cannedDoc = (rows) => ({
  match: "document_type = 'payment_confirmation'",
  rows
});
const cannedTxs = (rows) => ({ match: 'money_out > 0', rows });
const cannedExistingMatches = (rows) => ({ match: 'from reconciliation_matches', rows });
const cannedInsertReturn = (rows) => ({ match: 'insert into reconciliation_matches', rows });

const FRESH_INSERT = cannedInsertReturn([{ id: 'recon-x', inserted: true }]);

const findInsert = (client) =>
  client.calls.find((c) => c.sql.includes('insert into reconciliation_matches'));

const findAuditCalls = (client, action) =>
  client.calls.filter((c) => {
    if (!c.sql.includes('audit_events')) return false;
    if (!c.sql.toLowerCase().includes('insert')) return false;
    if (!action) return true;
    return (c.params || []).some((p) => String(p) === action);
  });

const findTransactionUpdates = (client) =>
  client.calls.filter((c) => /update\s+transactions/i.test(c.sql));

// The payment_status flip specifically — the cascade funnel also issues the
// late-bank-line guard's marker attempt (a separate, payload-only update
// pinned in documentSettlementReversal.test.js), which is not this pin's
// subject.
const findDocumentUpdates = (client) =>
  client.calls.filter((c) => /update\s+documents/i.test(c.sql) && c.sql.includes('payment_status'));

// Honeybee Amex confirmation as inspected in chat: $941.42 on
// 2025-08-18, ACH from First Horizon ****6198 to American Express.
// Extraction confidence 0.93 (well above the 0.85 auto-match floor) —
// Stage 2.6 promotes this to auto_matched.
const HONEYBEE_AMEX_DOC = {
  id: 'pc-amex-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  document_type: 'payment_confirmation',
  vendor_name: 'American Express',
  document_date: '2025-08-18',
  due_date: null,
  total_amount: 941.42,
  currency: 'USD',
  extraction_confidence: 0.93,
  parse_summary: { warnings: [] },
  duplicate_of: null,
  reference_number: 'AMEX-0818-957213',
  filename: '25-08-18_Amex_Payment_941.42.pdf',
  payment_status: 'paid'
};

const HONEYBEE_AMEX_TX = {
  id: 'tx-amex-epay',
  firm_id: 'firm-1',
  client_id: 'client-1',
  money_out: 941.42,
  money_in: 0,
  currency: 'USD',
  date: '2025-08-18',
  description: 'AMEX EPAY ACH 250818',
  raw_description: 'AMEX EPAY ACH PYMT 250818 $941.42',
  contact: '',
  source_line: '',
  reconciliation_status: null,
  account_code: null,
  status: 'needs_review'
};

const RUN_ARGS = {
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'pc-amex-1'
};

// ── 1: kill switch — flag off ────────────────────────────────────────
await test('PAYMENT_CONFIRMATION_MATCHER_ENABLED unset → disabled stats, no DB read', async () => {
  disableFlag();
  const client = makeMockClient([]);
  const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'PAYMENT_CONFIRMATION_MATCHER_ENABLED not enabled');
  assert.equal(client.calls.length, 0);
});

// ── 2: Stage 2.6 — Amex confirmation AUTO-MATCHES the AMEX EPAY ACH ──
await test('Honeybee Amex confirmation auto-matches AMEX EPAY ACH at tier 1', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([HONEYBEE_AMEX_DOC]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
    // Stage 2.6: tier 1 + vendor alias overlap + extraction_confidence 0.93
    // + same-day = auto_match_passed=true → status='auto_matched' on
    // insert (not 'suggested').
    assert.equal(stats.auto_match_inserted, 1, 'lands as auto_matched, not suggested');
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.auto_match_eligible, 1);

    const insert = findInsert(client);
    assert.ok(insert);
    // params[9] is the status (10th positional, 0-indexed). Confirm
    // the row is written with 'auto_matched', not 'suggested'.
    const writeStatus = insert.params[9];
    assert.equal(writeStatus, 'auto_matched',
      "status param is 'auto_matched' for tier 1 with healthy extraction");

    const payload = JSON.parse(insert.params[insert.params.length - 1]);
    assert.equal(payload.source, __SOURCE_LABEL);
    assert.equal(payload.recommended_action, 'auto_matched');
    assert.equal(payload.match_reason.auto_match_passed, true);
    assert.deepStrictEqual(payload.match_reason.auto_match_blockers, []);
    assert.ok(payload.match_reason.hints.includes('vendor_overlap'),
      'amex alias bridges "American Express" ↔ "AMEX EPAY"');
  } finally {
    disableFlag();
  }
});

// ── 3: Stage 2.6 — auto-match cascade runs ──────────────────────────
await test('auto-match triggers cascade — transaction → explained + document → paid', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([HONEYBEE_AMEX_DOC]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
    // cascadeAutoMatch issues an `update transactions ... set reconciliation_status='explained' ...`
    const txUpdates = findTransactionUpdates(client);
    assert.equal(txUpdates.length, 1, 'cascadeAutoMatch fires the transaction update');
    assert.ok(txUpdates[0].params.includes(HONEYBEE_AMEX_TX.id),
      'cascade scoped to this bank tx');

    // applyDocumentPaymentStatusAfterMatch issues an `update documents ... set payment_status='paid' ...`
    // (payment_confirmation isn't in SUM_BASED_PAYMENT_STATUS_TYPES so
    // it takes the 1:1 'paid' branch).
    const docUpdates = findDocumentUpdates(client);
    assert.equal(docUpdates.length, 1, 'document payment_status flip fires');
    assert.ok(docUpdates[0].params.includes(HONEYBEE_AMEX_DOC.id),
      'document update scoped to this doc');
  } finally {
    disableFlag();
  }
});

// ── 4: Stage 2.6 — IRS EFTPS tax payment AUTO-MATCHES ────────────────
await test('IRS tax payment confirmation auto-matches USATAXPYMT EFTPS line via new alias', async () => {
  enableFlag();
  try {
    const irsDoc = {
      ...HONEYBEE_AMEX_DOC,
      id: 'pc-irs-1',
      vendor_name: 'Internal Revenue Service',
      document_date: '2025-06-16',
      total_amount: 3683.67,
      reference_number: null,
      filename: '25-06-16_IRS_Tax_Payment_3683.67.pdf'
    };
    const irsTx = {
      ...HONEYBEE_AMEX_TX,
      id: 'tx-eftps',
      money_out: 3683.67,
      date: '2025-06-16',
      description: 'IRS USATAXPYMT EFTPS',
      raw_description: 'ACH DEBIT IRS USATAXPYMT 220 EFTPS 3683.67'
    };
    const client = makeMockClient([
      cannedDoc([irsDoc]),
      cannedTxs([irsTx]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      documentId: 'pc-irs-1'
    });
    assert.equal(stats.auto_match_inserted, 1, 'IRS confirmation auto-matches');
    const insert = findInsert(client);
    assert.equal(insert.params[9], 'auto_matched');
    const payload = JSON.parse(insert.params.slice(-1)[0]);
    assert.ok(
      payload.match_reason.hints.includes('vendor_overlap'),
      'IRS alias bridges "Internal Revenue Service" ↔ "IRS USATAXPYMT EFTPS"'
    );
  } finally {
    disableFlag();
  }
});

// ── 5: Stage 2.6 — low extraction confidence FALLS BACK to suggested ─
await test('tier 1 with low extraction_confidence falls back to suggested (no auto-match)', async () => {
  enableFlag();
  try {
    const lowConfDoc = { ...HONEYBEE_AMEX_DOC, extraction_confidence: 0.5 };
    const client = makeMockClient([
      cannedDoc([lowConfDoc]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
    // evaluateBillAutoMatch blocks on extraction_confidence < 0.85 →
    // candidate.auto_match_passed=false → writeStatus='suggested'.
    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_inserted, 0);

    const insert = findInsert(client);
    assert.equal(insert.params[9], 'suggested');

    const payload = JSON.parse(insert.params.slice(-1)[0]);
    assert.equal(payload.match_reason.auto_match_passed, false);
    assert.ok(payload.match_reason.auto_match_blockers.includes('low_extraction_confidence'));

    // No cascade for suggested rows.
    assert.equal(findTransactionUpdates(client).length, 0,
      'no transaction update — cascade only on auto_matched');
    assert.equal(findDocumentUpdates(client).length, 0,
      'no document update — cascade only on auto_matched');
  } finally {
    disableFlag();
  }
});

// ── 6: amount mismatch → no candidate ────────────────────────────────
await test('amount mismatch → no candidate written', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([HONEYBEE_AMEX_DOC]),
      cannedTxs([{ ...HONEYBEE_AMEX_TX, money_out: 100.00 }]),
      cannedExistingMatches([])
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.auto_match_inserted, 0);
    assert.equal(findInsert(client), undefined);
  } finally {
    disableFlag();
  }
});

// ── 7: doc-type gate — zero stats for wrong type ────────────────────
await test('document not found (wrong type) → zero stats, no candidate scan', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      cannedExistingMatches([])
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.auto_match_inserted, 0);
    // Q8: +1 — the wrapper's lane-policy read (to_regclass guard) precedes
    // the doc load; absent table => no policy, byte-identical behaviour.
    assert.equal(client.calls.length, 2);
  } finally {
    disableFlag();
  }
});

// ── 8: existing-match suppression scoped to this object_type ─────────
await test('existing confirmed match for same (tx, doc) → suppressed', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([HONEYBEE_AMEX_DOC]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      cannedExistingMatches([
        {
          bank_transaction_id: HONEYBEE_AMEX_TX.id,
          matched_object_type: __OBJECT_TYPE,
          matched_object_id: HONEYBEE_AMEX_DOC.id,
          status: 'confirmed',
          match_amount: HONEYBEE_AMEX_DOC.total_amount
        }
      ])
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.auto_match_inserted, 0);
    assert.equal(stats.skipped_confirmed, 1);
    assert.equal(findInsert(client), undefined);
  } finally {
    disableFlag();
  }
});

// ── 9: audit row carries match_kind + status ─────────────────────────
await test('auto_matched audit row carries action=reconciliation.candidate.auto_matched', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([HONEYBEE_AMEX_DOC]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });
    const audits = findAuditCalls(client, 'reconciliation.candidate.auto_matched');
    assert.equal(audits.length, 1,
      'auto-matched insert writes the auto_matched audit action');
    const meta = JSON.parse(audits[0].params[4]);
    assert.equal(meta.match_kind, __OBJECT_TYPE);
    assert.equal(meta.status, 'auto_matched');
    assert.equal(meta.auto_match_passed, true);
  } finally {
    disableFlag();
  }
});

// ── 10: status upgrade on refresh (the bug this PR fixes) ────────────
//
// Pre-fix: the upsert's ON CONFLICT DO UPDATE SET clause omitted
// `status`, so a row that was first written as 'suggested' (because
// the flag was off, or LLM triage didn't upgrade, or the auto-promote
// path wasn't there yet) would stay 'suggested' forever on re-runs.
// Post-fix: the CASE expression upgrades suggested → auto_matched
// when the matcher's current evaluation calls for it.
//
// This test simulates a stuck 'suggested' row: the existing-matches
// query returns it; the matcher re-runs scoring and lands on
// auto_match_passed=true; the upsert returns prior_status='suggested'
// + final_status='auto_matched' to signal the upgrade; we assert that
// the stats counter, audit action, and cascade all fire on the upgrade
// path even though no row was inserted.
const PRE_EXISTING_SUGGESTED = cannedExistingMatches([{
  id: 'recon-x',
  bank_transaction_id: 'tx-amex-epay',
  matched_object_type: 'payment_confirmation',
  matched_object_id: 'pc-amex-1',
  status: 'suggested',
  match_amount: 941.42,
  match_confidence: 0.95,
  payload: { source: 'payment_confirmation_reconciliation' }
}]);

const UPGRADE_RETURN = cannedInsertReturn([{
  id: 'recon-x',
  inserted: false,
  prior_status: 'suggested',
  final_status: 'auto_matched'
}]);

await test('refresh upgrades suggested → auto_matched, increments auto_match_upgraded, emits status_upgraded audit', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([HONEYBEE_AMEX_DOC]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      PRE_EXISTING_SUGGESTED,
      UPGRADE_RETURN
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });

    assert.equal(stats.auto_match_upgraded, 1,
      'new counter increments on the upgrade path');
    assert.equal(stats.auto_match_refreshed, 0,
      'should NOT also count as a plain refresh — that conflates two states');
    assert.equal(stats.auto_match_inserted, 0,
      'no fresh insert happened');

    const upgradeAudits = findAuditCalls(client, 'reconciliation.candidate.status_upgraded');
    assert.equal(upgradeAudits.length, 1, 'one status_upgraded audit row fires');
    const meta = JSON.parse(upgradeAudits[0].params[4]);
    assert.equal(meta.prior_status, 'suggested');
    assert.equal(meta.status, 'auto_matched');
    assert.equal(meta.match_kind, __OBJECT_TYPE);

    // Cascade must fire on upgrade — that's the whole point. The
    // upgrade IS the first time the row is auto_matched, so the
    // transaction → 'explained' / doc → 'paid' transitions need to
    // happen now.
    const txUpdates = findTransactionUpdates(client);
    assert.equal(txUpdates.length, 1, 'cascade fires on upgrade');
    const docUpdates = findDocumentUpdates(client);
    assert.equal(docUpdates.length, 1, 'doc payment_status flip fires on upgrade');
  } finally {
    disableFlag();
  }
});

// ── 11: refresh that does NOT upgrade (existing 'suggested' stays 'suggested') ──
//
// The bug fix should NOT promote rows that the matcher itself
// currently rates as 'suggested'. Confirms the CASE expression's
// upgrade gate is bidirectional: only fires when excluded.status =
// 'auto_matched'. Belt-and-braces test for the SQL's intent.
await test('refresh of suggested with auto_match_passed=false stays suggested (no spurious upgrade)', async () => {
  enableFlag();
  try {
    // Mock a doc whose extraction confidence is too low to clear the
    // auto-match gate — so writeStatus resolves to 'suggested', not
    // 'auto_matched'. The upsert returns prior_status='suggested',
    // final_status='suggested' (no transition).
    const lowConfDoc = { ...HONEYBEE_AMEX_DOC, extraction_confidence: 0.5 };
    const REFRESH_NO_UPGRADE = cannedInsertReturn([{
      id: 'recon-x',
      inserted: false,
      prior_status: 'suggested',
      final_status: 'suggested'
    }]);
    const client = makeMockClient([
      cannedDoc([lowConfDoc]),
      cannedTxs([HONEYBEE_AMEX_TX]),
      PRE_EXISTING_SUGGESTED,
      REFRESH_NO_UPGRADE
    ]);
    const stats = await runPaymentConfirmationReconciliationForDocument({ client, ...RUN_ARGS });

    assert.equal(stats.auto_match_upgraded, 0,
      'no upgrade — writeStatus was still suggested');
    assert.equal(stats.suggested_refreshed, 1, 'plain suggested refresh');
    const upgradeAudits = findAuditCalls(client, 'reconciliation.candidate.status_upgraded');
    assert.equal(upgradeAudits.length, 0, 'no upgrade audit on a no-op refresh');
    const txUpdates = findTransactionUpdates(client);
    assert.equal(txUpdates.length, 0, 'no cascade on a non-upgrade refresh');
  } finally {
    disableFlag();
  }
});
