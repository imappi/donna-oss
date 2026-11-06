// Manual link-to-transaction — writer unit tests.
//
// Drives `createManualReconciliationMatchInDb` with a mock pg client
// (same shape as parseDocumentsDb.test.js / receiptReconciliation.test.js).
// Tests cover the happy path (fresh insert + cascade), upsert from
// suggested/auto_matched, conflict semantics (rejecting prior
// confirmed/rejected), input validation, and the audit shape PR 5's
// learner consumes.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createManualReconciliationMatchInDb, updateReconciliationMatchInDb } from './firmDb.js';

// In-memory mock pg client — substring match on SQL, canned responses
// consumed once each. Same shape as the existing harness.
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

const cannedDoc = (rows) => ({ match: 'from documents', rows });
const cannedTx = (rows) => ({ match: 'from transactions', rows });
// `select id, status, created_by from reconciliation_matches` — prior
// match probe. Substring "from reconciliation_matches" matches both
// the read AND the writes; we order responses so the read consumes
// first.
const cannedPriorMatch = (rows) => ({ match: 'from reconciliation_matches', rows });

const STD_DOC = {
  id: 'doc-r1',
  document_type: 'receipt',
  total_amount: 18.40,
  currency: 'EUR'
};
const STD_TX = {
  id: 'tx-1',
  money_out: 18.40,
  currency: 'EUR'
};

const ARGS = (overrides = {}) => ({
  firmId: 'firm-1',
  clientId: 'client-1',
  documentId: 'doc-r1',
  bankTransactionId: 'tx-1',
  ...overrides
});

const findInsert = (client, table) =>
  client.calls.find((c) =>
    c.sql.toLowerCase().includes('insert into') &&
    c.sql.toLowerCase().includes(table)
  );

const findUpdate = (client, table) =>
  client.calls.find((c) => {
    const lower = c.sql.toLowerCase();
    return lower.startsWith('update ' + table) || lower.includes('\nupdate ' + table) || lower.includes('       update ' + table) || lower.trim().startsWith('update ' + table);
  });

const findAudit = (client) =>
  client.calls.find((c) => c.sql.includes('audit_events') && c.sql.toLowerCase().includes('insert'));

// ─── Happy path ──────────────────────────────────────────────────────────

await test('happy: no prior match → fresh insert + cascade + audit', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  assert.ok(result.matchId, 'returns synthesized match id');
  assert.equal(result.matchedObjectType, 'receipt');

  // INSERT into reconciliation_matches with status='confirmed', created_by='firm'.
  const insert = findInsert(client, 'reconciliation_matches');
  assert.ok(insert, 'reconciliation_matches INSERT issued');
  assert.ok(/'confirmed'/.test(insert.sql), "status='confirmed' in VALUES");
  assert.ok(/'firm'/.test(insert.sql), "created_by='firm' in VALUES");

  // Cascade — transactions UPDATE flips to reconciled.
  const txUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update transactions') &&
    c.sql.includes("'reconciled'")
  );
  assert.ok(txUpdate, 'transactions UPDATE issued');

  // Cascade — documents UPDATE flips payment_status to paid.
  const docUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update documents') &&
    c.sql.includes("'paid'")
  );
  assert.ok(docUpdate, 'documents UPDATE issued');

  // Review queue resolved.
  const reviewUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update transaction_review_queue') &&
    c.sql.includes("'resolved'")
  );
  assert.ok(reviewUpdate, 'transaction_review_queue UPDATE issued');

  // Audit — same action name as the PATCH endpoint so PR 5 picks it up.
  const audit = findAudit(client);
  assert.ok(audit, 'audit emitted');
  assert.ok(audit.sql.includes("'reconciliation_match.update'"),
    "action='reconciliation_match.update' shared with PATCH endpoint");
  const meta = JSON.parse(audit.params[4]);
  assert.equal(meta.status, 'confirmed');
  assert.equal(meta.source, 'firm_manual_link');
  assert.equal(meta.bank_transaction_id, 'tx-1');
  assert.equal(meta.matched_object_type, 'receipt');
  assert.equal(meta.matched_object_id, 'doc-r1');

  // COMMIT, not ROLLBACK.
  assert.ok(client.calls.some((c) => c.sql.trim().toLowerCase() === 'commit'));
});

await test('happy: matched_object_type defaults to document_type', async () => {
  const client = makeMockClient([
    cannedDoc([{ ...STD_DOC, document_type: 'supplier_bill' }]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  assert.equal(result.matchedObjectType, 'supplier_bill');
});

await test('happy: document_type null → matched_object_type=document', async () => {
  const client = makeMockClient([
    cannedDoc([{ ...STD_DOC, document_type: null }]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  assert.equal(result.matchedObjectType, 'document');
});

// ─── Pod-safety #2: opt-in before/after capture ─────────────────────────

await test('captureBeforeState: fresh link records match null→confirmed + the tx pre-read', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([{ ...STD_TX, reconciliation_status: 'needs_review' }]),
    cannedPriorMatch([])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    captureBeforeState: true,
    dbClient: client
  });
  assert.deepEqual(result.before_state, {
    match_id: result.matchId,
    match_status: null,
    transaction: { reconciliation_status: 'needs_review' }
  });
  assert.deepEqual(result.after_state, {
    match_id: result.matchId,
    match_status: 'confirmed',
    transaction: { reconciliation_status: 'reconciled' }
  });
});

await test('captureBeforeState: upsert from suggested records the prior match status', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([{ ...STD_TX, reconciliation_status: null }]),
    cannedPriorMatch([{ id: 'recon-existing', status: 'suggested', created_by: 'system' }])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    captureBeforeState: true,
    dbClient: client
  });
  assert.equal(result.before_state.match_status, 'suggested');
  assert.equal(result.after_state.match_status, 'confirmed');
  assert.equal(result.before_state.transaction.reconciliation_status, null);
});

await test('captureBeforeState omitted: legacy return shape untouched', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  assert.equal('before_state' in result, false);
  assert.equal('after_state' in result, false);
});

// ─── Upsert from suggested / auto_matched ───────────────────────────────

await test('upsert: existing suggested → promoted to confirmed via UPDATE (not INSERT)', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([{
      id: 'recon-existing',
      status: 'suggested',
      created_by: 'system'
    }])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  assert.equal(result.matchId, 'recon-existing', 'reuses existing match id');

  // The promotion is via UPDATE, not INSERT.
  const insert = findInsert(client, 'reconciliation_matches');
  assert.ok(!insert, 'no INSERT — upsert path uses UPDATE');
  const upsertUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update reconciliation_matches') &&
    c.sql.includes("'confirmed'") &&
    c.sql.includes("'firm'")
  );
  assert.ok(upsertUpdate, 'reconciliation_matches UPDATE flipped status + created_by');
});

await test('upsert: existing auto_matched → promoted to confirmed', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([{
      id: 'recon-auto',
      status: 'auto_matched',
      created_by: 'system'
    }])
  ]);
  const result = await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  assert.equal(result.matchId, 'recon-auto');
  const upsertUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update reconciliation_matches') &&
    c.sql.includes("'confirmed'")
  );
  assert.ok(upsertUpdate);
});

// ─── Conflict / 409 paths ───────────────────────────────────────────────

await test('conflict: existing confirmed → 409, no writes', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([{
      id: 'recon-confirmed',
      status: 'confirmed',
      created_by: 'firm'
    }])
  ]);
  try {
    await createManualReconciliationMatchInDb({
      ...ARGS(),
      dbClient: client
    });
    assert.fail('should have thrown 409');
  } catch (err) {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /already exists/);
  }
  // No INSERT, no cascade UPDATE.
  assert.ok(!findInsert(client, 'reconciliation_matches'));
  assert.ok(!client.calls.some((c) =>
    c.sql.toLowerCase().includes('update transactions') &&
    c.sql.includes("'reconciled'")
  ));
  // ROLLBACK, not COMMIT.
  assert.ok(client.calls.some((c) => c.sql.trim().toLowerCase() === 'rollback'));
});

await test('conflict: existing rejected → 409, no writes', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([{
      id: 'recon-rejected',
      status: 'rejected',
      created_by: 'firm'
    }])
  ]);
  try {
    await createManualReconciliationMatchInDb({
      ...ARGS(),
      dbClient: client
    });
    assert.fail('should have thrown 409');
  } catch (err) {
    assert.equal(err.statusCode, 409);
  }
});

// ─── 404 paths ──────────────────────────────────────────────────────────

await test('404: document not found (wrong firm/client) → no writes', async () => {
  const client = makeMockClient([
    cannedDoc([]),
    cannedTx([STD_TX])
  ]);
  try {
    await createManualReconciliationMatchInDb({
      ...ARGS(),
      dbClient: client
    });
    assert.fail('should have thrown 404');
  } catch (err) {
    assert.equal(err.statusCode, 404);
    assert.match(err.message, /Document not found/);
  }
});

await test('404: transaction not found → no writes', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([])
  ]);
  try {
    await createManualReconciliationMatchInDb({
      ...ARGS(),
      dbClient: client
    });
    assert.fail('should have thrown 404');
  } catch (err) {
    assert.equal(err.statusCode, 404);
    assert.match(err.message, /Transaction not found/);
  }
});

// ─── 400 paths ──────────────────────────────────────────────────────────

await test('400: missing client_id', async () => {
  try {
    await createManualReconciliationMatchInDb({
      firmId: 'firm-1',
      documentId: 'doc-1',
      bankTransactionId: 'tx-1',
      dbClient: makeMockClient([])
    });
    assert.fail();
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /client_id/);
  }
});

await test('400: missing document_id', async () => {
  try {
    await createManualReconciliationMatchInDb({
      firmId: 'firm-1',
      clientId: 'client-1',
      bankTransactionId: 'tx-1',
      dbClient: makeMockClient([])
    });
    assert.fail();
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /document_id/);
  }
});

await test('400: missing bank_transaction_id', async () => {
  try {
    await createManualReconciliationMatchInDb({
      firmId: 'firm-1',
      clientId: 'client-1',
      documentId: 'doc-1',
      dbClient: makeMockClient([])
    });
    assert.fail();
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /bank_transaction_id/);
  }
});

// ─── Audit shape ────────────────────────────────────────────────────────

await test('audit: action shared with PATCH endpoint so PR 5 picks it up', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  const audit = findAudit(client);
  assert.ok(audit.sql.includes("'reconciliation_match.update'"),
    'action name unchanged');
  const meta = JSON.parse(audit.params[4]);
  // PR 5's reader keys on metadata.status === 'confirmed' AND
  // action === 'reconciliation_match.update'. We surface
  // source='firm_manual_link' for analytics but don't change the
  // contract.
  assert.equal(meta.status, 'confirmed');
  assert.equal(meta.source, 'firm_manual_link');
});

// Pod-safety #1: the audit row records WHICH operator linked it. The apply
// routes thread the authenticated principal; an unattributed call still
// audits as 'system' (never null) so the column stays queryable.
await test('audit stamps the acting operator; defaults to system when unattributed', async () => {
  const withActor = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  await createManualReconciliationMatchInDb({
    ...ARGS(),
    actorId: 'kari@books.example',
    dbClient: withActor
  });
  const audit = findAudit(withActor);
  assert.ok(audit.sql.includes('actor_id'), 'audit insert includes actor_id');
  // params: [firmId, clientId, actor_id, matchId, metadata]
  assert.equal(audit.params[2], 'kari@books.example');

  const withoutActor = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  await createManualReconciliationMatchInDb({ ...ARGS(), dbClient: withoutActor });
  assert.equal(findAudit(withoutActor).params[2], 'system');
});

await test('audit metadata is PII-safe — no vendor name / description / reviewer note text', async () => {
  const client = makeMockClient([
    cannedDoc([{ ...STD_DOC }]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  await createManualReconciliationMatchInDb({
    ...ARGS(),
    reviewerNote: 'CONFIDENTIAL-NOTE-XYZ should not leak into audit',
    dbClient: client
  });
  const audit = findAudit(client);
  const metaStr = audit.params[4];
  assert.ok(!metaStr.includes('CONFIDENTIAL-NOTE'),
    'reviewer note text must not appear in audit metadata');
  const meta = JSON.parse(metaStr);
  for (const key of ['reviewer_note', 'note', 'vendor_name', 'description']) {
    assert.equal(meta[key], undefined, `audit metadata must not include ${key}`);
  }
});

await test('RT-21c: linking a bank line to a koontilasku resolves the single open row at the bank amount — matched_line_id + the row on the payload; two rows at that amount ⇒ document-level, never a guess', async () => {
  const rows = [
    { id: 'doc-nets-ln-1', line_no: 1, amount: 2452.72, settled_by: null },
    { id: 'doc-nets-ln-2', line_no: 2, amount: 2581.29, settled_by: null }
  ];
  const cannedRows = (r) => ({ match: "settlement_row' is not null", rows: r });
  const client = makeMockClient([
    cannedDoc([{ ...STD_DOC, id: 'doc-nets', document_type: 'payout_statement', total_amount: 10206.48 }]),
    cannedTx([{ id: 'tx-nets-6', money_in: 2581.29, money_out: 0, currency: 'EUR' }]),
    cannedPriorMatch([]),
    cannedRows(rows)
  ]);
  await createManualReconciliationMatchInDb({ ...ARGS({ documentId: 'doc-nets', bankTransactionId: 'tx-nets-6' }), dbClient: client });
  const insert = findInsert(client, 'reconciliation_matches');
  assert.ok(insert.sql.includes('matched_line_id'));
  assert.equal(insert.params[8], 'doc-nets-ln-2', 'the one open row whose net equals the credit');
  assert.equal(Number(insert.params[6]), 2581.29, 'the match amount is the row net, not the statement total');
  const payload = JSON.parse(insert.params[7]);
  assert.deepEqual(payload.settlement_row, { line_id: 'doc-nets-ln-2', line_no: 2, net: 2581.29 });

  // A row already settled by ANOTHER bank line is not open; two open rows at
  // the same net are ambiguous ⇒ document-level confirm (matched_line_id null).
  const ambiguous = makeMockClient([
    cannedDoc([{ ...STD_DOC, id: 'doc-nets', document_type: 'payout_statement', total_amount: 10206.48 }]),
    cannedTx([{ id: 'tx-nets-x', money_in: 2452.72, money_out: 0, currency: 'EUR' }]),
    cannedPriorMatch([]),
    cannedRows([
      { id: 'ln-a', line_no: 1, amount: 2452.72, settled_by: null },
      { id: 'ln-b', line_no: 3, amount: 2452.72, settled_by: null },
      { id: 'ln-c', line_no: 2, amount: 2581.29, settled_by: 'tx-nets-6' }
    ])
  ]);
  await createManualReconciliationMatchInDb({ ...ARGS({ documentId: 'doc-nets', bankTransactionId: 'tx-nets-x' }), dbClient: ambiguous });
  const insert2 = findInsert(ambiguous, 'reconciliation_matches');
  assert.equal(insert2.params[8], null);
  assert.equal(Number(insert2.params[6]), 10206.48);
  assert.equal('settlement_row' in JSON.parse(insert2.params[7]), false);
});

await test('reviewer note is captured on payload.reviewer_note (NOT in audit metadata)', async () => {
  const client = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  await createManualReconciliationMatchInDb({
    ...ARGS(),
    reviewerNote: 'Linked because Stripe charge with no inv',
    dbClient: client
  });
  const insert = findInsert(client, 'reconciliation_matches');
  const payloadParam = insert.params[7];
  const payload = JSON.parse(payloadParam);
  assert.equal(payload.source, 'firm_manual_link');
  assert.equal(payload.reviewer_note, 'Linked because Stripe charge with no inv');
});

// ─── Idempotency (re-run leaves state stable) ───────────────────────────

await test('idempotency: re-running on a fresh-insert scenario produces another upsert', async () => {
  // First run: fresh insert.
  const client1 = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  const r1 = await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client1
  });

  // Second run: the prior probe now sees the row from run 1. The
  // writer returns 409 because it's already 'confirmed'.
  const client2 = makeMockClient([
    cannedDoc([STD_DOC]),
    cannedTx([STD_TX]),
    cannedPriorMatch([{
      id: r1.matchId,
      status: 'confirmed',
      created_by: 'firm'
    }])
  ]);
  try {
    await createManualReconciliationMatchInDb({
      ...ARGS(),
      dbClient: client2
    });
    assert.fail('expected 409');
  } catch (err) {
    assert.equal(err.statusCode, 409,
      'second manual-link on the same pair surfaces the conflict cleanly');
  }
});

// ─── PR 8 F2: AR-aware payment_status arithmetic ────────────────────────
//
// Sales invoice documents compute payment_status from sum(confirmed/
// auto_matched match_amount) vs documents.total_amount. Receipts and
// bills keep the existing 'paid'-on-confirm shortcut. The manual-link
// path runs the cascade inside the same transaction, so the UPDATE
// documents call uses whichever value applyDocumentPaymentStatusAfterMatch
// resolved.

const SI_DOC = {
  id: 'si-1',
  document_type: 'sales_invoice',
  total_amount: 5000,
  currency: 'EUR'
};
const SI_TX = {
  id: 'tx-si-1',
  money_in: 5000,
  money_out: 0,
  currency: 'EUR'
};

// Canned response for the AR payment-status helper's documents read.
// Distinct from the manual-link's main documents probe (matches
// 'from documents where firm_id = $1 and client_id = $2 and id = $3').
// The helper's read is `select total_amount from documents where
// firm_id = $1 and id = $2` — no client_id, just total_amount —
// distinguishable via the 'select total_amount from documents' prefix.
const cannedHelperDocTotal = (total) => ({
  match: 'select total_amount from documents',
  rows: [{ total_amount: total }]
});

// Helper's sum read on reconciliation_matches:
// `select coalesce(sum(match_amount), 0) as settled from
//  reconciliation_matches where firm_id=$1 and matched_object_type=
//  'sales_invoice' and matched_object_id=$2 and status in (...)`.
const cannedHelperSettledSum = (settled) => ({
  match: 'coalesce(sum(case when matched_object_id=$3 then match_amount',
  rows: [{ settled }]
});

await test('PR 8 F2: manual-link on sales_invoice with amount=total → payment_status=paid', async () => {
  const client = makeMockClient([
    cannedDoc([SI_DOC]),
    cannedTx([SI_TX]),
    cannedPriorMatch([]),
    // Helper reads — order matters: the cascade calls the helper AFTER
    // the INSERT, so the SUM read sees the just-confirmed 5000.
    cannedHelperDocTotal(5000),
    cannedHelperSettledSum(5000)
  ]);
  await createManualReconciliationMatchInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: SI_DOC.id,
    bankTransactionId: SI_TX.id,
    dbClient: client
  });
  // The documents UPDATE issued by the cascade must carry 'paid'.
  const docUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update documents') &&
    /set\s+payment_status\s*=/i.test(c.sql)
  );
  assert.ok(docUpdate, 'documents UPDATE issued');
  // Param order in the helper's UPDATE: [firmId, documentId, status, payloadJson]
  assert.equal(docUpdate.params[2], 'paid', 'full-amount manual link flips status to paid');
});

await test('PR 8 F2: manual-link on sales_invoice with amount=half(total) → payment_status=partial', async () => {
  const client = makeMockClient([
    cannedDoc([SI_DOC]),
    cannedTx([{ ...SI_TX, money_in: 2500 }]),
    cannedPriorMatch([]),
    cannedHelperDocTotal(5000),
    cannedHelperSettledSum(2500)
  ]);
  await createManualReconciliationMatchInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: SI_DOC.id,
    bankTransactionId: SI_TX.id,
    dbClient: client
  });
  const docUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update documents') &&
    /set\s+payment_status\s*=/i.test(c.sql)
  );
  assert.ok(docUpdate);
  assert.equal(docUpdate.params[2], 'partial',
    'half-amount manual link flips status to partial');
});

// ─── PR 9 F2 extension: supplier_bill payment_status arithmetic ─────────
//
// Bills now compute payment_status from sum(confirmed) like
// sales_invoice. Q2 confirmed: extend the helper rather than retain
// the 1:1 'paid' shortcut for bills, because real-world bills can be
// paid in installments (equipment, retainer fees).

const BILL_DOC = {
  id: 'bill-1',
  document_type: 'supplier_bill',
  total_amount: 10000,
  currency: 'EUR'
};
const BILL_TX = {
  id: 'tx-bill-1',
  money_out: 10000,
  money_in: 0,
  currency: 'EUR'
};

await test('PR 9 F2: manual-link on supplier_bill with amount=total → payment_status=paid', async () => {
  const client = makeMockClient([
    cannedDoc([BILL_DOC]),
    cannedTx([BILL_TX]),
    cannedPriorMatch([]),
    cannedHelperDocTotal(10000),
    cannedHelperSettledSum(10000)
  ]);
  await createManualReconciliationMatchInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: BILL_DOC.id,
    bankTransactionId: BILL_TX.id,
    dbClient: client
  });
  const docUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update documents') &&
    /set\s+payment_status\s*=\s*\$3/i.test(c.sql)
  );
  assert.ok(docUpdate, 'sum-based UPDATE documents issued (parameterised status)');
  assert.equal(docUpdate.params[2], 'paid', 'full-amount bill manual link flips status to paid');
});

await test('PR 9 F2: manual-link on supplier_bill with amount=quarter(total) → payment_status=partial', async () => {
  const client = makeMockClient([
    cannedDoc([BILL_DOC]),
    cannedTx([{ ...BILL_TX, money_out: 2500 }]),
    cannedPriorMatch([]),
    cannedHelperDocTotal(10000),
    cannedHelperSettledSum(2500)
  ]);
  await createManualReconciliationMatchInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: BILL_DOC.id,
    bankTransactionId: BILL_TX.id,
    dbClient: client
  });
  const docUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update documents') &&
    /set\s+payment_status\s*=\s*\$3/i.test(c.sql)
  );
  assert.ok(docUpdate);
  assert.equal(docUpdate.params[2], 'partial',
    'quarter-amount bill manual link flips status to partial');
});

await test('PR 9 F2: AR helper sum-query carries the matched_object_type so bill sums do not bleed into sales_invoice math', async () => {
  // Pin that the SUM query parameterises matched_object_type. A
  // hardcoded 'sales_invoice' here would over-include bill matches
  // (or vice versa). The helper passes the actual matched_object_type
  // so each kind sums against its own rows only.
  const client = makeMockClient([
    cannedDoc([BILL_DOC]),
    cannedTx([BILL_TX]),
    cannedPriorMatch([]),
    cannedHelperDocTotal(10000),
    cannedHelperSettledSum(10000)
  ]);
  await createManualReconciliationMatchInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: BILL_DOC.id,
    bankTransactionId: BILL_TX.id,
    dbClient: client
  });
  const sumQuery = client.calls.find((c) =>
    /coalesce\(sum\(case when matched_object_id=\$3 then match_amount/i.test(c.sql)
  );
  assert.ok(sumQuery, 'SUM query issued');
  // The matched_object_type predicate must be parameterised ($2), and
  // the params at index 1 carry 'supplier_bill'.
  assert.ok(/matched_object_type\s*=\s*\$2/i.test(sumQuery.sql),
    'matched_object_type is parameterised, not hardcoded');
  assert.equal(sumQuery.params[1], 'supplier_bill',
    'SUM is scoped to supplier_bill rows on a bill manual-link');
});

await test('PR 8 F2: receipt manual-link still uses the paid shortcut (no AR helper read)', async () => {
  // Receipts and bills are 1:1; the helper short-circuits to 'paid'
  // without touching documents.total_amount or summing match rows.
  const client = makeMockClient([
    cannedDoc([{ ...STD_DOC, document_type: 'receipt' }]),
    cannedTx([STD_TX]),
    cannedPriorMatch([])
  ]);
  await createManualReconciliationMatchInDb({
    ...ARGS(),
    dbClient: client
  });
  // The helper's `select total_amount from documents` must NOT fire
  // for non-AR matches. If it did, we'd over-read on every receipt
  // confirm.
  const helperTotalReads = client.calls.filter((c) =>
    /select\s+total_amount\s+from\s+documents/i.test(c.sql)
  );
  assert.equal(helperTotalReads.length, 0,
    'AR helper does not run for receipt-typed matches');
  // The documents UPDATE writes 'paid' directly — receipts go through
  // the legacy shortcut where 'paid' is hardcoded in the SQL literal
  // (no $3 status parameter, unlike the AR helper branch).
  const docUpdate = client.calls.find((c) =>
    c.sql.toLowerCase().includes('update documents') &&
    /set\s+payment_status\s*=\s*'paid'/i.test(c.sql)
  );
  assert.ok(docUpdate, 'receipt manual link writes the literal paid status in SQL');
});

await test('group mode: confirms both selected pairs and retires crossed suggestions in one transaction', async () => {
  const calls = [];
  const docs = {
    'doc-28': { ...STD_DOC, id: 'doc-28' },
    'doc-29': { ...STD_DOC, id: 'doc-29' }
  };
  const txs = {
    'tx-28': { ...STD_TX, id: 'tx-28', reconciliation_status: null },
    'tx-29': { ...STD_TX, id: 'tx-29', reconciliation_status: null }
  };
  const selected = {
    'tx-28|doc-28': { id: 'match-28-28', status: 'suggested', created_by: 'llm' },
    'tx-29|doc-29': { id: 'match-29-29', status: 'suggested', created_by: 'llm' }
  };
  const client = {
    calls,
    query: async (sql, params = []) => {
      const text = String(sql).trim().toLowerCase();
      calls.push({ sql: String(sql), params });
      if (['begin', 'commit', 'rollback'].includes(text)) return { rows: [] };
      if (text.includes("status in ('confirmed', 'auto_matched')") && text.includes('for update')) return { rows: [] };
      if (text.includes('select id, document_type, total_amount, currency') && text.includes('from documents')) {
        return { rows: docs[params[2]] ? [docs[params[2]]] : [] };
      }
      if (text.includes('select id, money_out, currency, reconciliation_status') && text.includes('from transactions')) {
        return { rows: txs[params[2]] ? [txs[params[2]]] : [] };
      }
      if (text.includes('select id, status, created_by') && text.includes('from reconciliation_matches')) {
        const prior = selected[`${params[2]}|${params[4]}`];
        return { rows: prior ? [prior] : [] };
      }
      if (text.startsWith('select id') && text.includes("status = 'suggested'")) {
        return { rows: [{ id: 'match-28-29' }, { id: 'match-29-28' }] };
      }
      if (text.startsWith('update reconciliation_matches') && text.includes("status = 'rejected'")) {
        return {
          rows: [
            { id: 'match-28-29', bank_transaction_id: 'tx-28', matched_object_id: 'doc-29' },
            { id: 'match-29-28', bank_transaction_id: 'tx-29', matched_object_id: 'doc-28' }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const result = await createManualReconciliationMatchInDb({
    firmId: 'firm-1',
    clientId: 'client-1',
    pairings: [
      { transaction_id: 'tx-28', document_id: 'doc-28' },
      { transaction_id: 'tx-29', document_id: 'doc-29' }
    ],
    actorId: 'reviewer@example.com',
    captureBeforeState: true,
    dbClient: client
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.retiredMatches.length, 2);
  assert.equal(result.before_after.length, 2);
  assert.equal(calls.filter((call) => call.sql.trim().toLowerCase() === 'begin').length, 1, 'one BEGIN for the group');
  assert.equal(calls.filter((call) => call.sql.trim().toLowerCase() === 'commit').length, 1, 'one COMMIT for the group');
  assert.equal(calls.filter((call) => call.sql.trim().toLowerCase() === 'rollback').length, 0);
  const selectedAudits = calls
    .filter((call) => call.sql.includes('audit_events'))
    .map((call) => JSON.parse(call.params[4]));
  assert.equal(selectedAudits.filter((meta) => meta.status === 'confirmed').length, 2);
  assert.equal(selectedAudits.filter((meta) => meta.reason === 'crossed_suggestion_retired').length, 2);
  assert.ok(selectedAudits.every((meta) => meta.source === 'firm_group_pairing'));
});

await test('group mode: a terminal match makes the whole proposal stale before any pair writes', async () => {
  const client = makeMockClient([
    {
      match: "status in ('confirmed', 'auto_matched')",
      rows: [{ id: 'already-done', bank_transaction_id: 'tx-28', matched_object_id: 'doc-28', status: 'confirmed' }]
    }
  ]);
  await assert.rejects(
    createManualReconciliationMatchInDb({
      firmId: 'firm-1',
      clientId: 'client-1',
      pairings: [
        { transaction_id: 'tx-28', document_id: 'doc-28' },
        { transaction_id: 'tx-29', document_id: 'doc-29' }
      ],
      dbClient: client
    }),
    (error) => error.statusCode === 409
  );
  assert.ok(client.calls.some((call) => call.sql.trim().toLowerCase() === 'rollback'));
  assert.equal(client.calls.filter((call) => call.sql.toLowerCase().includes('update transactions')).length, 0);
});
