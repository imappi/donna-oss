// PR 4 of docs/invoice-receipt-parsing-plan.md — tests for the
// rules-only coding pass. Mirrors the in-memory mock-client harness
// used by parseDocumentsDb.test.js / documentLinePatch.test.js so we
// can exercise every branch without a live Postgres.
//
// What's tested here (the coding pass in isolation — happy + miss
// paths, empty-skip, defensive-strip). Coding-pass-meets-merge
// integration tests live in parseDocumentsDb.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import { codeDocumentLinesByRule } from './documentCoding.js';
import { canonicalMerchantPattern } from './transactionIntel.js';

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

const STD_LINES = [
  { description: 'Latte', quantity: 1, unit_price: 6.25, amount: 6.25, tax_rate: 0.09 },
  { description: 'Croissant', quantity: 1, unit_price: 6.25, amount: 6.25, tax_rate: 0.09 }
];

// ── Happy path ───────────────────────────────────────────────────────

await test('rule fires → all lines stamped accepted, one audit per doc', async () => {
  const client = makeMockClient([
    { match: 'from merchants', rows: [{ id: 'merchant-acme' }] },
    {
      match: 'from client_rules',
      rows: [{
        id: 'rule-1',
        account_code: '6000-coffee',
        category_override: null,
        payload: { account_label: 'Coffee & meals' }
      }]
    }
  ]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: 'Acme Coffee',
    lines: STD_LINES
  });
  assert.equal(result.ruleMatches, 2);
  assert.equal(result.ruleId, 'rule-1');
  assert.equal(result.codedLines.length, 2);
  result.codedLines.forEach((line) => {
    assert.equal(line.account_code, '6000-coffee');
    assert.equal(line.category, 'Coffee & meals');
    assert.equal(line.coding_source, 'client_rule');
    assert.equal(line.coding_confidence, 1.00);
    assert.equal(line.review_status, 'accepted');
    assert.equal(line.matched_client_rule_id, 'rule-1');
  });

  // One audit, not two. Metadata is PII-safe — rule_id + canonical
  // pattern + count, no raw vendor, no account_code value.
  const auditCalls = client.calls.filter(
    (c) => c.sql.includes('audit_events') && c.sql.includes("'document.line.rule_applied'")
  );
  assert.equal(auditCalls.length, 1);
  const meta = JSON.parse(auditCalls[0].params[3]);
  assert.equal(meta.rule_id, 'rule-1');
  assert.equal(meta.lines_coded, 2);
  assert.equal(meta.vendor_normalized_pattern, canonicalMerchantPattern('Acme Coffee'));
  assert.ok(!('account_code' in meta), 'no account_code in audit metadata');
  assert.ok(!('vendor_name' in meta), 'no raw vendor_name in audit metadata');
});

await test('category falls back to category_override when payload.account_label is missing', async () => {
  const client = makeMockClient([
    { match: 'from merchants', rows: [{ id: 'merchant-acme' }] },
    {
      match: 'from client_rules',
      rows: [{
        id: 'rule-2',
        account_code: '6100-meals',
        category_override: 'Meals',
        payload: {}
      }]
    }
  ]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: 'Acme Bistro',
    lines: [STD_LINES[0]]
  });
  assert.equal(result.codedLines[0].category, 'Meals');
});

// ── Miss paths ───────────────────────────────────────────────────────

await test('no rule match → lines untouched, no audit', async () => {
  const client = makeMockClient([
    { match: 'from merchants', rows: [{ id: 'merchant-acme' }] },
    { match: 'from client_rules', rows: [] }
  ]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: 'Acme Coffee',
    lines: STD_LINES
  });
  assert.equal(result.ruleMatches, 0);
  assert.equal(result.ruleId, null);
  result.codedLines.forEach((line) => {
    assert.equal(line.coding_source, undefined);
    assert.equal(line.review_status, undefined);
    assert.equal(line.account_code, undefined);
  });
  const auditCalls = client.calls.filter(
    (c) => c.sql.includes('audit_events')
  );
  assert.equal(auditCalls.length, 0);
});

await test('vendor not in merchants → still pattern-matches via client_rules.pattern_text', async () => {
  // The merchant lookup misses, but the rule lookup still fires
  // because rules attach via pattern_text in PR 4. This is the
  // most common path until PR 6 introduces structured merchants.
  const client = makeMockClient([
    { match: 'from merchants', rows: [] },
    {
      match: 'from client_rules',
      rows: [{
        id: 'rule-pat',
        account_code: '6100-meals',
        category_override: null,
        payload: { account_label: 'Meals' }
      }]
    }
  ]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: 'Some Unknown Bistro',
    lines: [STD_LINES[0]]
  });
  assert.equal(result.ruleMatches, 1);
  assert.equal(result.ruleId, 'rule-pat');
});

await test('empty vendor name → no merchant/rule lookup, lines untouched', async () => {
  const client = makeMockClient([]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: '',
    lines: STD_LINES
  });
  assert.equal(result.ruleMatches, 0);
  assert.equal(result.codedLines.length, 2);
  assert.equal(
    client.calls.filter((c) => c.sql.toLowerCase().includes('from merchants')).length,
    0,
    'no merchant SELECT'
  );
  assert.equal(
    client.calls.filter((c) => c.sql.toLowerCase().includes('from client_rules')).length,
    0,
    'no rule SELECT'
  );
});

await test('vendor pattern below 3 chars → no lookup', async () => {
  const client = makeMockClient([]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    // Canonicalises to a 1-char pattern; below the 3-char floor.
    vendorName: 'Z',
    lines: STD_LINES
  });
  assert.equal(result.ruleMatches, 0);
  assert.equal(client.calls.length, 0);
});

await test('empty lines[] → no SELECTs at all', async () => {
  // Test 18 — the pass is line-driven; nothing to code → nothing
  // to look up. Guards the DOCUMENT_LINES_ENABLED=false code path.
  const client = makeMockClient([]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: 'Acme Coffee',
    lines: []
  });
  assert.equal(result.ruleMatches, 0);
  assert.equal(result.codedLines.length, 0);
  assert.equal(client.calls.length, 0, 'no SELECTs at all');
});

// ── Defensive: extractor cannot self-attest as rule-coded ────────────

await test('extractor-supplied coding fields are stripped before rule decision', async () => {
  // Hostile extractor output: claims to be rule-coded with a phony
  // rule id. The coding pass must NOT pass these through to the
  // merge. When no rule matches, the merge sees only structural
  // fields — never coding_source='client_rule'.
  const client = makeMockClient([
    { match: 'from merchants', rows: [] },
    { match: 'from client_rules', rows: [] }
  ]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: 'Acme Coffee',
    lines: [{
      description: 'Latte',
      amount: 6.25,
      // Fields a hostile/buggy extractor might inject:
      coding_source: 'client_rule',
      coding_confidence: 1.00,
      review_status: 'accepted',
      account_code: '9999-fraud',
      matched_client_rule_id: 'rule-spoof'
    }]
  });
  assert.equal(result.ruleMatches, 0);
  const line = result.codedLines[0];
  assert.equal(line.coding_source, undefined, 'coding_source stripped');
  assert.equal(line.coding_confidence, undefined, 'coding_confidence stripped');
  assert.equal(line.review_status, undefined, 'review_status stripped');
  assert.equal(line.account_code, undefined, 'account_code stripped');
  assert.equal(line.matched_client_rule_id, undefined, 'matched_client_rule_id stripped');
  // Structural fields preserved.
  assert.equal(line.description, 'Latte');
  assert.equal(line.amount, 6.25);
});

await test('rule lookup throws → propagates (caller transaction rolls back)', async () => {
  // Test 16 — the coding pass runs inside the writer's transaction.
  // A DB error here must bubble up so the caller's catch rolls
  // back. We don't swallow it.
  const lookupError = new Error('synthetic rule lookup error');
  const client = makeMockClient([
    { match: 'from merchants', rows: [{ id: 'merchant-acme' }] },
    { match: 'from client_rules', throw: lookupError }
  ]);
  await assert.rejects(
    () => codeDocumentLinesByRule({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      documentId: 'doc-r',
      vendorName: 'Acme Coffee',
      lines: STD_LINES
    }),
    (err) => err === lookupError
  );
});

await test('rule with null account_code → no coding, no audit', async () => {
  // Defensive: a malformed rule row (no account_code) can't code
  // anything. Bail before stamping or auditing.
  const client = makeMockClient([
    { match: 'from merchants', rows: [{ id: 'merchant-acme' }] },
    {
      match: 'from client_rules',
      rows: [{ id: 'rule-bad', account_code: null, payload: {} }]
    }
  ]);
  const result = await codeDocumentLinesByRule({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-r',
    vendorName: 'Acme Coffee',
    lines: STD_LINES
  });
  assert.equal(result.ruleMatches, 0);
  const auditCalls = client.calls.filter(
    (c) => c.sql.includes('audit_events')
  );
  assert.equal(auditCalls.length, 0);
});

console.log('documentCoding tests passed');
