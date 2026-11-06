// Stage 2 of the payment-account-statement work — matcher smoke tests.
// Stage 2.6 — auto-match promotion + cascade.
//
// Same mock-pg harness as billReconciliation.test.js. Three SELECTs
// then optional INSERTs / audit_events. The orchestrator reuses the
// bill matcher's scoring, so only the orchestrator-shape (doc_type
// filter, matched_object_type, payload source) is asserted here;
// granular scoring tiers are already covered in billReconciliation
// tests.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runPaymentAccountStatementReconciliationForDocument,
  __OBJECT_TYPE,
  __SOURCE_LABEL,
  __llmMatcher
} from './paymentAccountStatementReconciliation.js';

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
  process.env.PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED = 'true';
};
const disableFlag = () => {
  delete process.env.PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED;
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
  match: "document_type = 'payment_account_statement'",
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

// Honeybee's recurring shape: an Amex statement for $941.42 with a
// settlement ACH described "AMEX EPAY". The doc's vendor_name is
// 'American Express' (what the generic extractor projects from the
// supplier-role party); the bank tx description is the bank's
// abbreviated form. The VENDOR_ALIASES `/amex|american\s*express/i`
// pattern is what bridges them.
const STD_DOC = {
  id: 'pas-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  document_type: 'payment_account_statement',
  vendor_name: 'American Express',
  document_date: '2025-07-31',
  due_date: '2025-08-18',
  total_amount: 941.42,
  currency: 'USD',
  extraction_confidence: 0.92,
  parse_summary: { warnings: [] },
  duplicate_of: null,
  reference_number: null,
  filename: '25-07-31_Amex_Statement.pdf',
  payment_status: 'unpaid'
};

const STD_TX = {
  id: 'tx-1',
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
  documentId: 'pas-1'
};

// ── 1: kill switch — flag off ────────────────────────────────────────
await test('PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED unset → disabled stats, no DB read', async () => {
  disableFlag();
  const client = makeMockClient([]);
  const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabled_reason, 'PAYMENT_ACCOUNT_STATEMENT_MATCHER_ENABLED not enabled');
  assert.equal(client.calls.length, 0, 'no queries run when flag is off');
});

// ── 2: required args — soft-degrade ──────────────────────────────────
await test('missing documentId → zero stats, no DB read', async () => {
  enableFlag();
  try {
    const client = makeMockClient([]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({
      client,
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    assert.equal(stats.disabled, false);
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(client.calls.length, 0);
  } finally {
    disableFlag();
  }
});

// ── 3: Stage 2.6 — Amex statement AUTO-MATCHES the AMEX EPAY ACH ─────
await test('amex statement auto-matches AMEX EPAY ACH at tier 1', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    // Stage 2.6: tier 1 (amount_exact + vendor_overlap + within window)
    // + extraction_confidence 0.92 → auto_match_passed=true → row
    // lands as 'auto_matched', not 'suggested'.
    assert.equal(stats.auto_match_inserted, 1, 'lands as auto_matched, not suggested');
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.auto_match_eligible, 1);

    const insert = findInsert(client);
    assert.ok(insert, 'INSERT issued against reconciliation_matches');
    assert.ok(
      insert.params.some((p) => p === __OBJECT_TYPE),
      `matched_object_type='${__OBJECT_TYPE}'`
    );
    assert.equal(insert.params[9], 'auto_matched',
      "status param is 'auto_matched' for tier 1 with healthy extraction");

    const payload = JSON.parse(insert.params[insert.params.length - 1]);
    assert.equal(payload.source, __SOURCE_LABEL);
    assert.equal(payload.recommended_action, 'auto_matched');
    assert.equal(payload.match_reason.auto_match_passed, true);
    assert.ok(payload.match_reason.hints.includes('amount_exact'));
    assert.ok(payload.match_reason.hints.includes('vendor_overlap'));
  } finally {
    disableFlag();
  }
});

// ── 2b: client-scoped auto-match canary on the LEGACY path ───────────
await test('non-allowlisted client is held to suggested (RECONCILIATION_AUTO_MATCH_CLIENTS gate)', async () => {
  enableFlag();
  const prevClients = process.env.RECONCILIATION_AUTO_MATCH_CLIENTS;
  // Allowlist EXCLUDES RUN_ARGS.clientId ('client-1'): the otherwise tier-1
  // auto-match must fail closed to 'suggested' (surfaced, never hidden) — the
  // same canary authorizeMatch enforces, now honored on this legacy matcher.
  process.env.RECONCILIATION_AUTO_MATCH_CLIENTS = 'some-other-client';
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_match_inserted, 0, 'NOT auto-matched: client not on the allowlist');
    assert.equal(stats.suggested_inserted, 1, 'held to suggested instead');

    const insert = findInsert(client);
    assert.ok(insert, 'INSERT still issued — the match is surfaced, not hidden');
    assert.equal(insert.params[9], 'suggested',
      "status param demoted to 'suggested' for a non-allowlisted client");
    const payload = JSON.parse(insert.params[insert.params.length - 1]);
    assert.equal(payload.recommended_action, 'review');
    // The matcher still records it WANTED to auto — the gate demoted status,
    // it did not rewrite the verdict (reconstructable from the persisted payload).
    assert.equal(payload.match_reason.auto_match_passed, true,
      'auto_match_passed stays true; only the band was held down');
  } finally {
    if (prevClients === undefined) delete process.env.RECONCILIATION_AUTO_MATCH_CLIENTS;
    else process.env.RECONCILIATION_AUTO_MATCH_CLIENTS = prevClients;
    disableFlag();
  }
});

// 0A.10 — the config control plane drives the legacy path end-to-end: a DB
// canary row for RECONCILIATION_AUTO_MATCH admits a client the env allowlist
// EXCLUDES (DB-first beats env). Proves configSnapshot threads from the matcher
// through clientAllowedToAutoMatch to the persisted band.
await test('DB canary admits a client the env allowlist excludes (config control plane on the legacy path)', async () => {
  enableFlag();
  const prevClients = process.env.RECONCILIATION_AUTO_MATCH_CLIENTS;
  process.env.RECONCILIATION_AUTO_MATCH_CLIENTS = 'some-other-client'; // env EXCLUDES client-1
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      { match: 'from client_capability_config', rows: [
        { flag_key: 'RECONCILIATION_AUTO_MATCH', stage: 'canary', source: 'manual', client_id: 'client-1' }
      ] },
      FRESH_INSERT
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_match_inserted, 1, 'DB canary row enables auto-match despite the env exclusion');
    assert.equal(stats.suggested_inserted, 0);
    const insert = findInsert(client);
    assert.equal(insert.params[9], 'auto_matched',
      "status param promoted to 'auto_matched' by the DB canary row");
  } finally {
    if (prevClients === undefined) delete process.env.RECONCILIATION_AUTO_MATCH_CLIENTS;
    else process.env.RECONCILIATION_AUTO_MATCH_CLIENTS = prevClients;
    disableFlag();
  }
});

// ── 3a: Stage 2.6 — auto-match cascade runs (transaction + document) ─
await test('auto-match triggers cascade — transaction → explained + document → paid', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    const txUpdates = findTransactionUpdates(client);
    assert.equal(txUpdates.length, 1, 'cascadeAutoMatch fires the transaction update');
    assert.ok(txUpdates[0].params.includes(STD_TX.id),
      'cascade scoped to this bank tx');
    // payment_account_statement isn't in SUM_BASED_PAYMENT_STATUS_TYPES
    // so applyDocumentPaymentStatusAfterMatch takes the 1:1 'paid'
    // branch — a single `update documents ... payment_status='paid' ...`.
    const docUpdates = findDocumentUpdates(client);
    assert.equal(docUpdates.length, 1, 'document payment_status flip fires');
    assert.ok(docUpdates[0].params.includes(STD_DOC.id),
      'document update scoped to this doc');
  } finally {
    disableFlag();
  }
});

// ── 3b: Stage 2.6 — low extraction confidence falls back to suggested ─
await test('tier 1 with low extraction_confidence falls back to suggested (no cascade)', async () => {
  enableFlag();
  try {
    const lowConfDoc = { ...STD_DOC, extraction_confidence: 0.5 };
    const client = makeMockClient([
      cannedDoc([lowConfDoc]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 1);
    assert.equal(stats.auto_match_inserted, 0);

    const insert = findInsert(client);
    assert.equal(insert.params[9], 'suggested');

    const payload = JSON.parse(insert.params.slice(-1)[0]);
    assert.equal(payload.match_reason.auto_match_passed, false);
    assert.ok(payload.match_reason.auto_match_blockers.includes('low_extraction_confidence'));

    assert.equal(findTransactionUpdates(client).length, 0,
      'no cascade on suggested rows');
    assert.equal(findDocumentUpdates(client).length, 0);
  } finally {
    disableFlag();
  }
});

// ── 4: amount mismatch → no candidate, no INSERT ────────────────────
await test('amount mismatch → no candidate written', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([{ ...STD_TX, money_out: 250.00 }]),
      cannedExistingMatches([])
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(findInsert(client), undefined, 'no INSERT issued');
  } finally {
    disableFlag();
  }
});

// ── 5: doc-type gate — non-statement returns zero ───────────────────
await test('document not found (wrong type) → zero stats, no candidate scan', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([])
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(findInsert(client), undefined);
    // The doc-not-found short-circuit should skip the tx + existing-
    // matches reads. Only the documents SELECT should have run.
    // Q8: +1 — the wrapper's lane-policy read (to_regclass guard) precedes
    // the doc load; absent table => no policy, byte-identical behaviour.
    assert.equal(client.calls.length, 2);
  } finally {
    disableFlag();
  }
});

// ── 6: existing confirmed match → suppressed, no fresh INSERT ───────
await test('existing confirmed match for same (tx, doc) → suppressed', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([
        {
          bank_transaction_id: STD_TX.id,
          matched_object_type: __OBJECT_TYPE,
          matched_object_id: STD_DOC.id,
          status: 'confirmed',
          match_amount: STD_DOC.total_amount
        }
      ])
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.suggested_inserted, 0);
    assert.equal(stats.skipped_confirmed, 1);
    assert.equal(findInsert(client), undefined);
  } finally {
    disableFlag();
  }
});

// ── 7: audit row carries match_kind + auto_matched action ────────────
await test('auto_matched audit row carries action=reconciliation.candidate.auto_matched', async () => {
  enableFlag();
  try {
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([]),
      FRESH_INSERT
    ]);
    await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    const audits = findAuditCalls(client, 'reconciliation.candidate.auto_matched');
    assert.equal(audits.length, 1,
      'auto-matched insert writes the auto_matched audit action');
    const meta = JSON.parse(audits[0].params[4]);
    assert.equal(meta.match_kind, __OBJECT_TYPE);
    assert.equal(meta.status, 'auto_matched');
    assert.equal(meta.matched_object_id, STD_DOC.id);
    assert.equal(meta.bank_transaction_id, STD_TX.id);
    assert.equal(meta.auto_match_passed, true);
  } finally {
    disableFlag();
  }
});

// ── Upgrade path (PR: matcher upsert status-stuck fix) ────────────────
// See paymentConfirmationReconciliation.test.js / billReconciliation.test.js
// for the full rationale. Mirrors the same upgrade scenario here.
await test('Upgrade: stuck suggested row → auto_matched on refresh', async () => {
  enableFlag();
  try {
    const UPGRADE_RETURN = cannedInsertReturn([{
      id: 'recon-x',
      inserted: false,
      prior_status: 'suggested',
      final_status: 'auto_matched'
    }]);
    const client = makeMockClient([
      cannedDoc([STD_DOC]),
      cannedTxs([STD_TX]),
      cannedExistingMatches([{
        id: 'recon-x',
        bank_transaction_id: STD_TX.id,
        matched_object_type: __OBJECT_TYPE,
        matched_object_id: STD_DOC.id,
        status: 'suggested',
        match_amount: STD_DOC.total_amount,
        match_confidence: 0.95,
        payload: {}
      }]),
      UPGRADE_RETURN
    ]);
    const stats = await runPaymentAccountStatementReconciliationForDocument({ client, ...RUN_ARGS });
    assert.equal(stats.auto_match_upgraded, 1);
    assert.equal(stats.suggested_refreshed, 0, 'upgrade is not double-counted');
    const upgradeAudits = findAuditCalls(client, 'reconciliation.candidate.status_upgraded');
    assert.equal(upgradeAudits.length, 1);
    const meta = JSON.parse(upgradeAudits[0].params[4]);
    assert.equal(meta.prior_status, 'suggested');
    assert.equal(meta.status, 'auto_matched');
  } finally {
    disableFlag();
  }
});
