// PR 3 of docs/invoice-receipt-parsing-plan.md — PATCH document line.
// Drives __patchDocumentLineWithClient against an in-memory pg-style
// mock so we can exercise every branch without a live Postgres.
// Mirrors the test harness used in parseDocumentsDb.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import { __patchDocumentLineWithClient } from './documentLinePatch.js';

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
        return { rows: response.rows || [] };
      }
      return { rows: [] };
    }
  };
};

const existingLine = (overrides = {}) => ({
  id: 'doc-r-ln-1',
  firm_id: 'firm-1',
  client_id: 'client-1',
  document_id: 'doc-r',
  line_no: 1,
  description: 'Latte',
  quantity: 1,
  unit_price: 6.25,
  amount: 6.25,
  tax_rate: 0.09,
  fingerprint: 'fp-existing',
  account_code: null,
  category: null,
  coding_confidence: null,
  coding_source: null,
  review_status: 'needs_review',
  payload: { raw_extraction: {}, currency: 'SGD' },
  created_at: new Date('2026-04-01T00:00:00Z'),
  updated_at: new Date('2026-04-01T00:00:00Z'),
  ...overrides
});

// ── PATCH tests 8–12 from the brief ──────────────────────────────────

await test('test 8: PATCH happy path → firm sets account_code + flips to accepted', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    {
      match: 'update document_lines',
      rows: [existingLine({
        account_code: '6000-coffee',
        review_status: 'accepted',
        coding_source: 'firm_override',
        coding_confidence: 1.00
      })]
    },
    { match: 'update transaction_review_queue', rows: [{ id: 'rvq-1' }, { id: 'rvq-2' }] }
  ]);
  const result = await __patchDocumentLineWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-r',
    lineId: 'doc-r-ln-1',
    patch: { account_code: '6000-coffee', review_status: 'accepted' }
  });
  assert.equal(result.line.review_status, 'accepted');
  assert.equal(result.line.coding_source, 'firm_override');
  assert.equal(result.line.coding_confidence, 1.00);
  assert.deepEqual(result.closed_review_item_ids, ['rvq-1', 'rvq-2']);

  // The queue UPDATE fires inside the same transaction (between BEGIN
  // and COMMIT). Confirm via call ordering.
  const begins = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'begin');
  const commits = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'commit');
  assert.equal(begins.length, 1);
  assert.equal(commits.length, 1);
  const beginIdx = client.calls.findIndex((c) => c.sql.trim().toLowerCase() === 'begin');
  const commitIdx = client.calls.findIndex((c) => c.sql.trim().toLowerCase() === 'commit');
  const queueIdx = client.calls.findIndex((c) => c.sql.includes('update transaction_review_queue'));
  assert.ok(beginIdx < queueIdx && queueIdx < commitIdx, 'queue UPDATE inside the transaction');

  // Audit emitted — review.accepted (override since account_code set).
  const auditCall = client.calls.find(
    (c) => c.sql.includes('audit_events') && c.params?.[3] === 'review.overridden'
  );
  assert.ok(auditCall, 'review.overridden audit emitted');
  const meta = JSON.parse(auditCall.params[6]);
  // No PII — only IDs, counts, and coding metadata.
  assert.equal(meta.document_id, 'doc-r');
  assert.equal(meta.item_id, 'doc-r-ln-1');
  assert.ok(!('account_code' in meta), 'account_code value not in audit metadata');
});

await test('test 8b: PATCH happy path → accept without account_code → review.accepted (not overridden)', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    {
      match: 'update document_lines',
      rows: [existingLine({ review_status: 'accepted' })]
    },
    { match: 'update transaction_review_queue', rows: [{ id: 'rvq-1' }] }
  ]);
  await __patchDocumentLineWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-r',
    lineId: 'doc-r-ln-1',
    patch: { review_status: 'accepted' }
  });
  const acceptedAudit = client.calls.find(
    (c) => c.sql.includes('audit_events') && c.params?.[3] === 'review.accepted'
  );
  assert.ok(acceptedAudit, 'review.accepted audit (no override) emitted');
});

await test('test 9: PATCH structural edit → coding_source=firm_override, fingerprint recomputed', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    {
      match: 'update document_lines',
      rows: [existingLine({ amount: 6.85, coding_source: 'firm_override', coding_confidence: 1.00 })]
    }
  ]);
  await __patchDocumentLineWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-r',
    lineId: 'doc-r-ln-1',
    patch: { amount: 6.85 }
  });
  const updateCall = client.calls.find((c) => c.sql.includes('update document_lines'));
  assert.ok(updateCall, 'update issued');
  // coding_source param ($12) = 'firm_override'.
  assert.equal(updateCall.params[11], 'firm_override');
  // coding_confidence ($13) = 1.00.
  assert.equal(updateCall.params[12], 1.00);
  // fingerprint ($14) — non-null hex.
  assert.match(String(updateCall.params[13]), /^[0-9a-f]{64}$/);
  // No queue UPDATE — review_status didn't flip.
  const queueUpdates = client.calls.filter(
    (c) => c.sql.includes('update transaction_review_queue')
  );
  assert.equal(queueUpdates.length, 0);
  // Audit: document.line.edited (no review.*). Action is hardcoded
  // into the SQL string, not parameterised — search the SQL text.
  const editedAudit = client.calls.find(
    (c) => c.sql.includes('audit_events') && c.sql.includes('document.line.edited')
  );
  assert.ok(editedAudit, 'document.line.edited audit emitted');
  const reviewAudit = client.calls.find(
    (c) => c.sql.includes('audit_events') && String(c.params?.[3] || '').startsWith('review.')
  );
  assert.equal(reviewAudit, undefined, 'no review.* audit on structural-only edit');
});

await test('test 10: PATCH defer with notes → queue payload patched, queue still open', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    {
      match: 'update document_lines',
      rows: [existingLine({ review_status: 'deferred' })]
    }
  ]);
  await __patchDocumentLineWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-r',
    lineId: 'doc-r-ln-1',
    patch: {
      review_status: 'deferred',
      notes: 'waiting on classification from client'
    }
  });
  // Queue payload patched with notes, but status NOT set to 'resolved'.
  const queueUpdate = client.calls.find(
    (c) => c.sql.includes('update transaction_review_queue')
  );
  assert.ok(queueUpdate, 'queue payload patched');
  assert.ok(!queueUpdate.sql.includes("status='resolved'"), 'queue stays open on defer');
  const payloadParam = JSON.parse(queueUpdate.params[2]);
  assert.equal(payloadParam.notes, 'waiting on classification from client');
  // Audit: review.deferred.
  const deferAudit = client.calls.find(
    (c) => c.sql.includes('audit_events') && c.params?.[3] === 'review.deferred'
  );
  assert.ok(deferAudit, 'review.deferred audit emitted');
});

await test('test 11: PATCH 404 on missing line', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [] }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-1',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-missing',
      patch: { review_status: 'accepted' }
    }),
    (err) => err.statusCode === 404 && err.code === 'DOCUMENT_LINE_NOT_FOUND'
  );
  // No UPDATE issued, transaction rolled back.
  const updateCalls = client.calls.filter((c) => c.sql.includes('update document_lines'));
  assert.equal(updateCalls.length, 0);
  const lastControl = client.calls.map((c) => c.sql.trim().toLowerCase())
    .filter((s) => s === 'commit' || s === 'rollback').pop();
  assert.equal(lastControl, 'rollback');
});

await test('test 11b: PATCH 404 on cross-firm scope (the firm_id predicate finds nothing)', async () => {
  // Same shape as test 11 — the SELECT predicates on
  // (firm_id, document_id, id), so a mis-scoped request returns 0 rows.
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [] }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-OTHER',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-1',
      patch: { review_status: 'accepted' }
    }),
    (err) => err.statusCode === 404
  );
});

await test('test 12: PATCH transaction atomicity — queue UPDATE throws → row UPDATE rolled back', async () => {
  const queueError = new Error('synthetic queue error');
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    { match: 'update document_lines', rows: [existingLine({ review_status: 'accepted' })] },
    { match: 'update transaction_review_queue', throw: queueError }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-1',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-1',
      patch: { review_status: 'accepted' }
    }),
    (err) => err === queueError
  );
  // BEGIN was issued, then ROLLBACK (not COMMIT). The UPDATE on
  // document_lines that fired before the queue error is rolled back
  // with the rest of the transaction.
  const lastControl = client.calls.map((c) => c.sql.trim().toLowerCase())
    .filter((s) => s === 'commit' || s === 'rollback').pop();
  assert.equal(lastControl, 'rollback');
});

await test('PATCH invalid review_status → 400', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-1',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-1',
      patch: { review_status: 'bogus' }
    }),
    (err) => err.statusCode === 400 && err.code === 'INVALID_LINE_REVIEW_STATUS'
  );
});

// ── PR 4: Make-a-rule UX tests 11–15 ─────────────────────────────────

await test('PR4 test 11: PATCH with make_rule:true → upserts rule + closes queue atomically', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    { match: 'select vendor_name from documents', rows: [{ vendor_name: 'Acme Coffee' }] },
    {
      match: 'update document_lines',
      rows: [existingLine({
        account_code: '6100-meals',
        category: 'Meals',
        review_status: 'accepted',
        coding_source: 'firm_override',
        coding_confidence: 1.00
      })]
    },
    { match: 'update transaction_review_queue', rows: [{ id: 'rvq-1' }] },
    { match: 'select id, status from client_rules', rows: [] }
  ]);
  const result = await __patchDocumentLineWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-r',
    lineId: 'doc-r-ln-1',
    patch: {
      account_code: '6100-meals',
      category: 'Meals',
      review_status: 'accepted',
      make_rule: true
    }
  });
  assert.ok(result.created_rule_id, 'created_rule_id surfaced in response');
  assert.match(result.created_rule_id, /^client-rule-/);
  assert.equal(result.rule_existed_before, false);

  // Rule INSERT issued — same transaction as the line UPDATE.
  const ruleInsert = client.calls.find(
    (c) => c.sql.includes('insert into client_rules')
  );
  assert.ok(ruleInsert, 'client_rules INSERT issued');
  assert.equal(ruleInsert.params[1], 'firm-1');
  assert.equal(ruleInsert.params[2], 'client-1');
  // pattern_text param = canonicalised vendor name.
  assert.equal(ruleInsert.params[3], 'acme coffee');
  assert.equal(ruleInsert.params[4], '6100-meals');

  // Idempotency: ON CONFLICT clause present.
  assert.ok(ruleInsert.sql.includes('on conflict (id) do update'));
  assert.ok(ruleInsert.sql.includes("'merchant_category'"));
  assert.ok(ruleInsert.sql.includes("'active'"));

  // Dedicated audit emitted.
  const ruleAudit = client.calls.find(
    (c) => c.sql.includes('audit_events') && c.sql.includes("'client_rule.created'")
  );
  assert.ok(ruleAudit, 'client_rule.created audit emitted');
  const auditMeta = JSON.parse(ruleAudit.params[3]);
  assert.equal(auditMeta.source, 'document_line_override');
  assert.equal(auditMeta.source_document_id, 'doc-r');
  assert.equal(auditMeta.source_line_id, 'doc-r-ln-1');
  // Canonical pattern, NOT the raw vendor name — invariant 4.
  assert.equal(auditMeta.vendor_normalized_pattern, 'acme coffee');
  assert.equal(auditMeta.account_code, '6100-meals');
  assert.equal(auditMeta.existed_before, false);

  // Whole thing committed.
  const lastControl = client.calls.map((c) => c.sql.trim().toLowerCase())
    .filter((s) => s === 'commit' || s === 'rollback').pop();
  assert.equal(lastControl, 'commit');
});

await test('PR4 test 12: make_rule on a doc with no vendor_name → 400, no writes', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    { match: 'select vendor_name from documents', rows: [{ vendor_name: null }] }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-1',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-1',
      patch: {
        account_code: '6100-meals',
        category: 'Meals',
        review_status: 'accepted',
        make_rule: true
      }
    }),
    (err) => err.statusCode === 400 && err.code === 'MAKE_RULE_REQUIRES_VENDOR'
  );
  const updateCalls = client.calls.filter((c) => c.sql.includes('update document_lines'));
  assert.equal(updateCalls.length, 0, 'no line UPDATE on 400');
  const ruleInserts = client.calls.filter((c) => c.sql.includes('insert into client_rules'));
  assert.equal(ruleInserts.length, 0, 'no rule INSERT on 400');
  const lastControl = client.calls.map((c) => c.sql.trim().toLowerCase())
    .filter((s) => s === 'commit' || s === 'rollback').pop();
  assert.equal(lastControl, 'rollback');
});

await test('PR4 test 13: make_rule when rule already exists → idempotent, existed_before=true', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    { match: 'select vendor_name from documents', rows: [{ vendor_name: 'Acme Coffee' }] },
    {
      match: 'update document_lines',
      rows: [existingLine({
        account_code: '6100-meals',
        category: 'Meals',
        review_status: 'accepted',
        coding_source: 'firm_override',
        coding_confidence: 1.00
      })]
    },
    { match: 'update transaction_review_queue', rows: [] },
    // Existing rule found — same id, status 'active'.
    {
      match: 'select id, status from client_rules',
      rows: [{ id: 'whatever', status: 'active' }]
    }
  ]);
  const result = await __patchDocumentLineWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-r',
    lineId: 'doc-r-ln-1',
    patch: {
      account_code: '6100-meals',
      category: 'Meals',
      review_status: 'accepted',
      make_rule: true
    }
  });
  assert.equal(result.rule_existed_before, true);
  const ruleAudit = client.calls.find(
    (c) => c.sql.includes('audit_events') && c.sql.includes("'client_rule.created'")
  );
  assert.ok(ruleAudit);
  assert.equal(JSON.parse(ruleAudit.params[3]).existed_before, true);
  // One INSERT (ON CONFLICT DO UPDATE makes it idempotent).
  const ruleInserts = client.calls.filter((c) => c.sql.includes('insert into client_rules'));
  assert.equal(ruleInserts.length, 1);
});

await test('PR4 test 14: rule INSERT throws → line UPDATE rolled back', async () => {
  const ruleError = new Error('synthetic rule INSERT failure');
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    { match: 'select vendor_name from documents', rows: [{ vendor_name: 'Acme Coffee' }] },
    {
      match: 'update document_lines',
      rows: [existingLine({
        account_code: '6100-meals',
        category: 'Meals',
        review_status: 'accepted',
        coding_source: 'firm_override'
      })]
    },
    { match: 'update transaction_review_queue', rows: [] },
    { match: 'select id, status from client_rules', rows: [] },
    { match: 'insert into client_rules', throw: ruleError }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-1',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-1',
      patch: {
        account_code: '6100-meals',
        category: 'Meals',
        review_status: 'accepted',
        make_rule: true
      }
    }),
    (err) => err === ruleError
  );
  // BEGIN, then ROLLBACK (not COMMIT). The line UPDATE that fired
  // earlier is rolled back with everything else.
  const lastControl = client.calls.map((c) => c.sql.trim().toLowerCase())
    .filter((s) => s === 'commit' || s === 'rollback').pop();
  assert.equal(lastControl, 'rollback');
  // No client_rule.created audit because the audit fires AFTER the INSERT.
  const ruleAudit = client.calls.find(
    (c) => c.sql.includes('audit_events') && c.sql.includes("'client_rule.created'")
  );
  assert.equal(ruleAudit, undefined);
});

await test('PR4 test 15a: make_rule without account_code → 400, no writes', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-1',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-1',
      patch: {
        category: 'Meals',
        review_status: 'accepted',
        make_rule: true
      }
    }),
    (err) => err.statusCode === 400 && err.code === 'MAKE_RULE_REQUIRES_CODING'
  );
  const updateCalls = client.calls.filter((c) => c.sql.includes('update document_lines'));
  assert.equal(updateCalls.length, 0);
});

await test('PR4 test 15b: make_rule without category → 400, no writes', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] }
  ]);
  await assert.rejects(
    __patchDocumentLineWithClient({
      client,
      firmId: 'firm-1',
      documentId: 'doc-r',
      lineId: 'doc-r-ln-1',
      patch: {
        account_code: '6100-meals',
        review_status: 'accepted',
        make_rule: true
      }
    }),
    (err) => err.statusCode === 400 && err.code === 'MAKE_RULE_REQUIRES_CODING'
  );
});

await test('PR4 baseline: PATCH without make_rule → no client_rules INSERT (no regression)', async () => {
  const client = makeMockClient([
    { match: 'select id, firm_id, client_id, document_id, line_no', rows: [existingLine()] },
    {
      match: 'update document_lines',
      rows: [existingLine({
        account_code: '6100-meals',
        review_status: 'accepted',
        coding_source: 'firm_override'
      })]
    },
    { match: 'update transaction_review_queue', rows: [] }
  ]);
  const result = await __patchDocumentLineWithClient({
    client,
    firmId: 'firm-1',
    documentId: 'doc-r',
    lineId: 'doc-r-ln-1',
    patch: { account_code: '6100-meals', category: 'Meals', review_status: 'accepted' }
  });
  assert.equal(result.created_rule_id, null);
  assert.equal(result.rule_existed_before, null);
  const ruleInserts = client.calls.filter((c) => c.sql.includes('insert into client_rules'));
  assert.equal(ruleInserts.length, 0);
  const docFetch = client.calls.filter((c) => c.sql.includes('select vendor_name from documents'));
  assert.equal(docFetch.length, 0, 'no vendor lookup when make_rule absent');
});

console.log('documentLinePatch tests passed');
