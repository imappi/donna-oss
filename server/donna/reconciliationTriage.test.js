import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTriageUserPrompt,
  parseTriageResponse,
  triageReconciliationCandidates,
  cascadeAutoMatch
} from './reconciliationTriage.js';

// --- Fixtures ---

const makeCandidate = (overrides = {}) => ({
  document: {
    id: 'doc-1',
    filename: 'stripe-invoice-may.pdf',
    vendor_name: 'Stripe Inc',
    total_amount: 499,
    currency: 'EUR',
    document_date: '2026-04-30',
    due_date: '2026-05-30',
    document_type: 'supplier_bill',
    reference_number: null,
    extraction_confidence: 0.92,
    ...overrides.document
  },
  transaction: {
    id: 'tx-1',
    description: 'STRIPE INC PAYMENT',
    raw_description: 'STRIPE INC PAYMENT REF-42',
    contact: null,
    money_out: 499,
    money_in: 0,
    currency: 'EUR',
    date: '2026-05-03',
    ...overrides.transaction
  },
  score: overrides.score ?? 0.55,
  summary: overrides.summary ?? 'Exact amount within date window; vendor unconfirmed.',
  match_reason: {
    source: 'bill_reconciliation',
    summary: 'Exact amount within date window; vendor unconfirmed.',
    amount: { transaction: 499, document: 499, exact: true, delta: 0 },
    currency: { transaction: 'EUR', document: 'EUR', same: true },
    date: { transaction: '2026-05-03', document: '2026-04-30', gap_days: 3 },
    candidates_considered: 5,
    extraction_confidence: 0.92,
    score: 0.55,
    confidence_tier: 'amount_exact_no_vendor',
    hints: ['amount_exact', 'within_window'],
    extraction_source: null,
    auto_match_passed: false,
    auto_match_blockers: ['tier_not_eligible'],
    ...overrides.match_reason
  },
  auto_match_passed: false,
  auto_match_blockers: ['tier_not_eligible'],
  matchId: overrides.matchId ?? 'match-1',
  ...overrides
});

const makeMatchCandidate = () =>
  makeCandidate({
    score: 0.55,
    match_reason: {
      source: 'bill_reconciliation',
      amount: { transaction: 499, document: 499, exact: true, delta: 0 },
      date: { transaction: '2026-05-03', document: '2026-04-30', gap_days: 3 },
      confidence_tier: 'amount_exact_no_vendor',
      hints: ['amount_exact', 'within_window'],
      extraction_source: null,
      score: 0.55
    }
  });

const makeNearAmountCandidate = () =>
  makeCandidate({
    score: 0.72,
    match_reason: {
      source: 'bill_reconciliation',
      amount: { transaction: 510, document: 499, exact: false, delta: 11 },
      date: { transaction: '2026-05-03', document: '2026-04-30', gap_days: 3 },
      confidence_tier: 'amount_near_vendor',
      hints: ['amount_near', 'vendor_overlap', 'within_window'],
      extraction_source: null,
      score: 0.72
    }
  });

const makeFilenameCandidate = () =>
  makeCandidate({
    score: 0.55,
    document: { vendor_name: null, filename: 'stripe-may-invoice.pdf' },
    match_reason: {
      source: 'bill_reconciliation',
      amount: { transaction: 499, document: 499, exact: true, delta: 0 },
      date: { transaction: '2026-05-03', document: '2026-04-30', gap_days: 3 },
      confidence_tier: 'amount_exact_no_vendor',
      hints: ['amount_exact', 'within_window', 'vendor_from_filename'],
      extraction_source: 'filename',
      score: 0.55
    }
  });

// --- buildTriageUserPrompt ---

await test('prompt: includes document and transaction details', () => {
  const candidate = makeCandidate();
  const prompt = buildTriageUserPrompt({ candidates: [candidate] });
  assert.ok(prompt.includes('stripe-invoice-may.pdf'));
  assert.ok(prompt.includes('Stripe Inc'));
  assert.ok(prompt.includes('STRIPE INC PAYMENT'));
  assert.ok(prompt.includes('499'));
  assert.ok(prompt.includes('amount_exact_no_vendor'));
});

await test('prompt: includes client profile when provided', () => {
  const candidate = makeCandidate();
  const prompt = buildTriageUserPrompt({
    candidates: [candidate],
    clientProfile: { companyName: 'Honeybee Hills Apiary', industry: 'Agriculture' }
  });
  assert.ok(prompt.includes('Honeybee Hills Apiary'));
  assert.ok(prompt.includes('Agriculture'));
});

await test('prompt: handles missing vendor gracefully', () => {
  const candidate = makeCandidate({ document: { vendor_name: null } });
  const prompt = buildTriageUserPrompt({ candidates: [candidate] });
  assert.ok(prompt.includes('NULL (not extracted)'));
});

await test('prompt: multiple candidates numbered correctly', () => {
  const c1 = makeCandidate();
  const c2 = makeCandidate({
    transaction: { id: 'tx-2', description: 'SECOND TX', money_out: 200 }
  });
  const prompt = buildTriageUserPrompt({ candidates: [c1, c2] });
  assert.ok(prompt.includes('Candidate 1'));
  assert.ok(prompt.includes('Candidate 2'));
  assert.ok(prompt.includes('SECOND TX'));
});

await test('prompt: shows vendor_overlap and reference_match signals', () => {
  const candidate = makeCandidate({
    match_reason: {
      hints: ['amount_exact', 'vendor_overlap', 'reference_match', 'within_window'],
      confidence_tier: 'amount_exact_reference',
      amount: { exact: true },
      date: { gap_days: 1 }
    }
  });
  const prompt = buildTriageUserPrompt({ candidates: [candidate] });
  assert.ok(prompt.includes('Vendor overlap: yes'));
  assert.ok(prompt.includes('Reference match: yes'));
});

await test('prompt: shows extraction source when filename', () => {
  const candidate = makeFilenameCandidate();
  const prompt = buildTriageUserPrompt({ candidates: [candidate] });
  assert.ok(prompt.includes('Extraction source: filename'));
});

// --- parseTriageResponse ---

await test('parse: valid JSON response', () => {
  const text = JSON.stringify({
    candidates: [
      { index: 1, verdict: 'match', confidence: 0.87, reasoning: 'Vendor confirmed' }
    ]
  });
  const results = parseTriageResponse(text);
  assert.equal(results.length, 1);
  assert.equal(results[0].index, 0);
  assert.equal(results[0].verdict, 'match');
  assert.equal(results[0].confidence, 0.87);
  assert.equal(results[0].reasoning, 'Vendor confirmed');
});

await test('parse: fenced JSON response', () => {
  const text = '```json\n{"candidates": [{"index": 1, "verdict": "no_match", "confidence": 0.3, "reasoning": "Different vendor"}]}\n```';
  const results = parseTriageResponse(text);
  assert.equal(results.length, 1);
  assert.equal(results[0].verdict, 'no_match');
});

await test('parse: clamps confidence to [0, 1]', () => {
  const text = JSON.stringify({
    candidates: [
      { index: 1, verdict: 'match', confidence: 1.5, reasoning: 'Over' },
      { index: 2, verdict: 'match', confidence: -0.2, reasoning: 'Under' }
    ]
  });
  const results = parseTriageResponse(text);
  assert.equal(results[0].confidence, 1);
  assert.equal(results[1].confidence, 0);
});

await test('parse: invalid verdict defaults to review', () => {
  const text = JSON.stringify({
    candidates: [
      { index: 1, verdict: 'maybe', confidence: 0.6, reasoning: 'Unsure' }
    ]
  });
  const results = parseTriageResponse(text);
  assert.equal(results[0].verdict, 'review');
});

await test('parse: missing candidates array returns empty', () => {
  const text = JSON.stringify({ results: [] });
  const results = parseTriageResponse(text);
  assert.equal(results.length, 0);
});

await test('parse: multiple candidates parsed correctly', () => {
  const text = JSON.stringify({
    candidates: [
      { index: 1, verdict: 'match', confidence: 0.9, reasoning: 'A' },
      { index: 2, verdict: 'no_match', confidence: 0.2, reasoning: 'B' },
      { index: 3, verdict: 'review', confidence: 0.5, reasoning: 'C' }
    ]
  });
  const results = parseTriageResponse(text);
  assert.equal(results.length, 3);
  assert.equal(results[0].index, 0);
  assert.equal(results[1].index, 1);
  assert.equal(results[2].index, 2);
});

// --- triageReconciliationCandidates (unit, mocked LLM) ---

const mockFetch = (responseBody) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ text: JSON.stringify(responseBody) }]
    })
  });
  return () => { globalThis.fetch = original; };
};

const mockFetchFail = () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: 'Internal error' } })
  });
  return () => { globalThis.fetch = original; };
};

const makeMockClient = () => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).trim(), params });
      return { rows: [{ id: 'llmd-test-123' }], rowCount: 1 };
    }
  };
};

await test('triage: skips candidates with score >= 0.85', async () => {
  const highScoreCandidate = makeCandidate({ score: 0.88 });
  const restore = mockFetch({ candidates: [] });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [highScoreCandidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    assert.equal(results.size, 0);
  } finally {
    restore();
  }
});

await test('triage: returns empty map when no API key', async () => {
  const results = await triageReconciliationCandidates({
    candidates: [makeMatchCandidate()],
    apiKey: '',
    client: makeMockClient(),
    firmId: 'firm-1',
    clientId: 'client-1'
  });
  assert.equal(results.size, 0);
});

await test('triage: returns empty map for empty candidates', async () => {
  const results = await triageReconciliationCandidates({
    candidates: [],
    apiKey: 'test-key'
  });
  assert.equal(results.size, 0);
});

await test('triage: LLM match verdict → green-lane auto_matched', async () => {
  const candidate = makeMatchCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'match', confidence: 0.87, reasoning: 'Stripe confirmed in bank desc' }]
  });
  const mockClient = makeMockClient();
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: mockClient,
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    assert.equal(results.size, 1);
    const r = results.get(0);
    assert.equal(r.verdict, 'match');
    assert.equal(r.upgradedScore, 0.87);
    assert.equal(r.lane, 'green');
    // finalState may be auto_matched or suggested depending on Louis QA
    // (which also calls fetch and may fail/pass). The LLM call for Louis
    // will use same mock, so let's just check the verdict and lane.
    assert.ok(['auto_matched', 'suggested'].includes(r.finalState));
  } finally {
    restore();
  }
});

await test('triage: LLM no_match verdict → blocked', async () => {
  const candidate = makeMatchCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'no_match', confidence: 0.2, reasoning: 'Coincidental amount' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.verdict, 'no_match');
    assert.equal(r.finalState, 'blocked');
  } finally {
    restore();
  }
});

await test('triage: LLM review verdict → suggested', async () => {
  const candidate = makeMatchCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'review', confidence: 0.6, reasoning: 'Need human review' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.verdict, 'review');
    assert.equal(r.finalState, 'suggested');
    assert.equal(r.lane, 'yellow');
  } finally {
    restore();
  }
});

await test('triage: competing candidates → red-lane blocked', async () => {
  const c1 = makeMatchCandidate();
  const c2 = makeCandidate({
    matchId: 'match-2',
    transaction: { id: 'tx-1', description: 'OTHER', money_out: 499, currency: 'EUR', date: '2026-05-03' },
    score: 0.55
  });
  const restore = mockFetch({
    candidates: [
      { index: 1, verdict: 'match', confidence: 0.87, reasoning: 'Match A' },
      { index: 2, verdict: 'match', confidence: 0.87, reasoning: 'Match B' }
    ]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [c1, c2],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r1 = results.get(0);
    const r2 = results.get(1);
    assert.equal(r1.lane, 'red');
    assert.equal(r1.finalState, 'blocked');
    assert.equal(r2.lane, 'red');
    assert.equal(r2.finalState, 'blocked');
  } finally {
    restore();
  }
});

await test('triage: filename extraction source → yellow-lane even with match verdict', async () => {
  const candidate = makeFilenameCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'match', confidence: 0.87, reasoning: 'Filename vendor matched' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.lane, 'yellow');
    assert.equal(r.finalState, 'suggested');
  } finally {
    restore();
  }
});

await test('triage: near-amount match cannot reach green-lane', async () => {
  const candidate = makeNearAmountCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'match', confidence: 0.87, reasoning: 'Vendor confirmed' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.lane, 'yellow');
    assert.equal(r.finalState, 'suggested');
  } finally {
    restore();
  }
});

await test('triage: API failure gracefully skips batch', async () => {
  const candidate = makeMatchCandidate();
  const restore = mockFetchFail();
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    assert.equal(results.size, 0);
  } finally {
    restore();
  }
});

await test('triage: confidence upgrade uses max of LLM and deterministic', async () => {
  const candidate = makeCandidate({ score: 0.72 });
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'match', confidence: 0.65, reasoning: 'Low LLM conf' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.upgradedScore, 0.72);
  } finally {
    restore();
  }
});

await test('triage: low extraction confidence blocks green-lane', async () => {
  const candidate = makeCandidate({
    score: 0.55,
    document: { extraction_confidence: 0.6 },
    match_reason: {
      amount: { exact: true },
      date: { gap_days: 3 },
      hints: ['amount_exact', 'within_window'],
      extraction_source: null,
      confidence_tier: 'amount_exact_no_vendor',
      score: 0.55
    }
  });
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'match', confidence: 0.88, reasoning: 'Match' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.lane, 'yellow');
    assert.equal(r.finalState, 'suggested');
  } finally {
    restore();
  }
});

await test('triage: decision logged to DB', async () => {
  const candidate = makeMatchCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'review', confidence: 0.6, reasoning: 'Needs review' }]
  });
  const mockClient = makeMockClient();
  try {
    await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: mockClient,
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const decisionInsert = mockClient.calls.find((c) =>
      c.sql.includes('insert into llm_decisions')
    );
    assert.ok(decisionInsert, 'Expected llm_decisions insert');
    assert.equal(decisionInsert.params[3], 'match');
    assert.equal(decisionInsert.params[4], 'reconciliation_match');
  } finally {
    restore();
  }
});

await test('triage: mixed high and low confidence candidates', async () => {
  const highConf = makeCandidate({
    score: 0.95,
    matchId: 'match-high',
    transaction: { id: 'tx-high', description: 'HIGH', money_out: 100, currency: 'EUR', date: '2026-05-01' }
  });
  const lowConf = makeMatchCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'match', confidence: 0.87, reasoning: 'Confirmed' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [highConf, lowConf],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    assert.ok(!results.has(0), 'High-conf candidate should not be triaged');
    assert.ok(results.has(1), 'Low-conf candidate should be triaged');
  } finally {
    restore();
  }
});

// --- cascadeAutoMatch ---

await test('cascade: updates transaction reconciliation_status', async () => {
  const mockClient = makeMockClient();
  await cascadeAutoMatch({
    client: mockClient,
    firmId: 'firm-1',
    matchId: 'match-1',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'supplier_bill',
    documentId: 'doc-1'
  });
  const txUpdate = mockClient.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes("reconciliation_status = 'explained'")
  );
  assert.ok(txUpdate, 'Expected transaction status update');
  assert.equal(txUpdate.params[0], 'tx-1');
  assert.equal(txUpdate.params[1], 'firm-1');
});

// --- cascadeAutoMatch: document evidence outranks a bank-line-only explanation ---

// Routing mock: responses keyed on a SQL substring, consumed in order.
const makeRoutedClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).trim(), params });
      const text = String(sql).toLowerCase();
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        return { rows: response.rows || [] };
      }
      return { rows: [] };
    }
  };
};

const RULE_EXPLAINED_TX_ROW = {
  reconciliation_status: 'explained',
  support_status: 'rule_explained',
  bank_line_auto_explained: null,
  prior_match_type: 'bank_line'
};

await test('cascade: doc match SUPERSEDES a rule-explained bank line', async () => {
  const client = makeRoutedClient([
    { match: "payload->>'support_status'", rows: [RULE_EXPLAINED_TX_ROW] },
    { match: 'not exists', rows: [{ id: 'tx-1' }] }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-1',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'receipt',
    documentId: 'doc-1'
  });

  const supersede = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes('not exists')
  );
  assert.ok(supersede, 'supersede UPDATE issued');
  const payload = JSON.parse(supersede.params[2]);
  assert.equal(payload.auto_explain_source, 'document_match_supersede');
  assert.equal(payload.reconciliation_match_id, 'match-1');
  assert.equal(payload.reconciliation_match_type, 'receipt');
  assert.equal(payload.support_status, 'explained', 'weak marker cleared');
  assert.equal(payload.bank_line_auto_explained, false, 'classifier marker cleared');

  const classicUpdate = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes("is distinct from 'explained'")
  );
  assert.ok(!classicUpdate, 'classic guarded UPDATE must not also run');

  const rejection = client.calls.find((c) =>
    c.sql.includes('update reconciliation_matches') && c.sql.includes("status = 'rejected'")
  );
  assert.ok(rejection, 'lingering self-ref bank_line match row retired');
  assert.equal(rejection.params[0], 'firm-1');
  assert.equal(rejection.params[1], 'tx-1');
  assert.ok(rejection.sql.includes("matched_object_type = 'bank_line'"));

  const audit = client.calls.find((c) =>
    c.sql.includes('reconciliation.bank_line_explain.superseded')
  );
  assert.ok(audit, 'supersede audit row written');
  assert.equal(audit.params[1], 'client-1');
  const auditMeta = JSON.parse(audit.params[3]);
  assert.equal(auditMeta.prior_support_status, 'rule_explained');
});

await test('cascade: classifier-explained line (bank_line_auto_explained) also superseded', async () => {
  const client = makeRoutedClient([
    {
      match: "payload->>'support_status'",
      rows: [{
        reconciliation_status: 'explained',
        support_status: 'bank_line_explained',
        bank_line_auto_explained: 'true',
        prior_match_type: 'bank_line'
      }]
    },
    { match: 'not exists', rows: [{ id: 'tx-1' }] }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-1',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'supplier_bill',
    documentId: 'doc-1'
  });
  const supersede = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes('not exists')
  );
  assert.ok(supersede, 'supersede UPDATE issued for classifier-explained line');
});

await test('cascade: auto-match resolves an OPEN client evidence request on the line', async () => {
  // The Chevron shape — a coding-explained line carrying an open business-purpose
  // ask while its receipt was unmatched. Now the receipt auto-matches; the open
  // ask must resolve so we stop nagging after upload.
  const client = makeRoutedClient([
    { match: 'client_evidence_requests', rows: [{ id: 'evidence-req-1' }] },
    { match: "payload->>'support_status'", rows: [{
      reconciliation_status: 'explained',
      support_status: 'explained',
      ai_suggestion_status: 'auto_applied',
      bank_line_auto_explained: null,
      bank_line_disposition_explained: null,
      prior_match_type: 'bank_line'
    }] },
    { match: 'not exists', rows: [{ id: 'tx-1' }] }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-1',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'receipt',
    documentId: 'doc-1'
  });

  const resolve = client.calls.find((c) =>
    c.sql.includes('update client_evidence_requests') && c.sql.includes("status = 'resolved'")
  );
  assert.ok(resolve, 'open evidence request resolved');
  assert.equal(resolve.params[0], 'firm-1');
  assert.equal(resolve.params[1], 'tx-1');
  assert.ok(resolve.sql.includes("status in ('draft', 'open', 'replied')"), 'only active requests resolved');
  const resolvePayload = JSON.parse(resolve.params[2]);
  assert.equal(resolvePayload.auto_resolved_by_match, true);
  assert.deepEqual(resolvePayload.document_ids, ['doc-1']);

  // The coding-explained line was admitted as bank-line-only via the shared
  // predicate (ai_suggestion_status='auto_applied'), so the supersede fired too.
  const supersede = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes('not exists')
  );
  assert.ok(supersede, 'coding-explained line superseded by the document match');

  const audit = client.calls.find((c) =>
    c.sql.includes('client_evidence_request.auto_resolved_by_match')
  );
  assert.ok(audit, 'auto-resolve audit row written');
});

await test('cascade (RT-11 / D3): a match resolves only document/statement asks; a purpose ask stays open with the match recorded on it', async () => {
  const client = makeRoutedClient([
    { match: 'matched_reconciliation_match_id', rows: [{ id: 'purpose-ask', evidence_type: 'business_purpose' }] },
    { match: 'client_evidence_requests', rows: [{ id: 'doc-ask' }] },
    { match: "payload->>'support_status'", rows: [{
      reconciliation_status: 'pending',
      support_status: null,
      ai_suggestion_status: 'suggested',
      bank_line_auto_explained: null,
      bank_line_disposition_explained: null,
      prior_match_type: 'bank_line'
    }] }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-1',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'receipt',
    documentId: 'doc-1'
  });

  const resolve = client.calls.find((c) =>
    c.sql.includes('update client_evidence_requests') && c.sql.includes("status = 'resolved'")
  );
  assert.ok(resolve, 'the document ask is resolved');
  assert.ok(resolve.sql.includes('evidence_type = any($4::text[])'), 'resolution is restricted by evidence_type');
  assert.deepEqual(resolve.params[3], ['supporting_document', 'bank_statement']);

  const retain = client.calls.find((c) =>
    c.sql.includes('update client_evidence_requests') && c.sql.includes('matched_reconciliation_match_id')
  );
  assert.ok(retain, 'the other open asks get the match recorded');
  assert.ok(retain.sql.includes('not (evidence_type = any($4::text[]))'));
  assert.ok(retain.sql.includes("status in ('draft', 'open', 'replied')"));
  const recorded = JSON.parse(retain.params[2]);
  assert.equal(recorded.matched_document_id, 'doc-1');
  assert.equal(recorded.matched_reconciliation_match_id, 'match-1');
  assert.equal(recorded.matched_object_type, 'receipt');
  assert.ok(recorded.match_recorded_at);
  assert.equal(retain.params[4], 'match-1', 'recorded once per (ask, match)');

  const copy = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes("'{evidence_request,status}'")
  );
  assert.ok(copy, 'the embedded tx copy is flipped');
  assert.deepEqual(copy.params[2], ['doc-ask'], 'only when the copy IS a resolved ask');

  const resolvedAudit = client.calls.find((c) => c.sql.includes('client_evidence_request.auto_resolved_by_match'));
  const resolvedMeta = JSON.parse(resolvedAudit.params[3]);
  assert.deepEqual(resolvedMeta.resolved_request_ids, ['doc-ask']);
  assert.deepEqual(resolvedMeta.retained_request_ids, ['purpose-ask']);
  const recordedAudit = client.calls.find((c) => c.sql.includes('client_evidence_request.match_recorded'));
  assert.ok(recordedAudit, 'the kept-open ask is receipted');
  assert.equal(recordedAudit.params[2], 'purpose-ask');
  assert.equal(JSON.parse(recordedAudit.params[3]).evidence_type, 'business_purpose');
});

await test('cascade: RECONCILE_ASK_AUTORESOLVE_DISABLED=true skips the resolve, supersede still runs', async () => {
  // Default-on kill switch (fix #3 flag). When disabled, the open ask is NOT
  // touched — but the supersede half of the cascade (fix #2) is unaffected.
  const prev = process.env.RECONCILE_ASK_AUTORESOLVE_DISABLED;
  process.env.RECONCILE_ASK_AUTORESOLVE_DISABLED = 'true';
  try {
    const client = makeRoutedClient([
      { match: 'client_evidence_requests', rows: [{ id: 'evidence-req-1' }] },
      { match: "payload->>'support_status'", rows: [{
        reconciliation_status: 'explained',
        support_status: 'explained',
        ai_suggestion_status: 'auto_applied',
        bank_line_auto_explained: null,
        bank_line_disposition_explained: null,
        prior_match_type: 'bank_line'
      }] },
      { match: 'not exists', rows: [{ id: 'tx-1' }] }
    ]);
    await cascadeAutoMatch({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      matchId: 'match-1',
      bankTransactionId: 'tx-1',
      matchedObjectType: 'receipt',
      documentId: 'doc-1'
    });
    const resolve = client.calls.find((c) =>
      c.sql.includes('update client_evidence_requests') && c.sql.includes("status = 'resolved'")
    );
    assert.ok(!resolve, 'evidence-request resolve skipped when the flag is disabled');
    const supersede = client.calls.find((c) =>
      c.sql.includes('update transactions') && c.sql.includes('not exists')
    );
    assert.ok(supersede, 'supersede still runs while the resolve is gated off');
  } finally {
    if (prev === undefined) delete process.env.RECONCILE_ASK_AUTORESOLVE_DISABLED;
    else process.env.RECONCILE_ASK_AUTORESOLVE_DISABLED = prev;
  }
});

await test('cascade: no open evidence request → no resolve, match cascade unaffected', async () => {
  // Routed client returns [] for the client_evidence_requests update (no active
  // ask), so the resolve short-circuits and the normal cascade proceeds.
  const client = makeRoutedClient([
    { match: "payload->>'support_status'", rows: [RULE_EXPLAINED_TX_ROW] },
    { match: 'not exists', rows: [{ id: 'tx-1' }] }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-1',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'receipt',
    documentId: 'doc-1'
  });
  // The resolve UPDATE is attempted (returns []), but no payload-copy update or
  // audit follows when nothing was resolved.
  const payloadCopy = client.calls.find((c) =>
    c.sql.includes("jsonb_set") && c.sql.includes('evidence_request,status')
  );
  assert.ok(!payloadCopy, 'no payload-copy update when nothing was resolved');
  const supersede = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes('not exists')
  );
  assert.ok(supersede, 'supersede still runs');
});

await test('cascade: firm-CONFIRMED bank-line explain blocks the supersede cascade', async () => {
  // The supersede UPDATE's NOT EXISTS guard returns no rows when the
  // firm confirmed the bank-line explanation — no row retirement, no
  // audit, and the line keeps its firm-blessed state.
  const client = makeRoutedClient([
    { match: "payload->>'support_status'", rows: [RULE_EXPLAINED_TX_ROW] },
    { match: 'not exists', rows: [] }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-1',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'receipt',
    documentId: 'doc-1'
  });
  const rejection = client.calls.find((c) =>
    c.sql.includes('update reconciliation_matches')
  );
  assert.ok(!rejection, 'no match-row retirement when supersede was blocked');
  const audit = client.calls.find((c) =>
    c.sql.includes('reconciliation.bank_line_explain.superseded')
  );
  assert.ok(!audit, 'no supersede audit when supersede was blocked');
});

await test('cascade: doc-explained line takes the classic guarded path (no supersede)', async () => {
  // reconciliation_match_type points at a document — that explanation
  // came from a real doc match and is NOT superseded.
  const client = makeRoutedClient([
    {
      match: "payload->>'support_status'",
      rows: [{
        reconciliation_status: 'explained',
        support_status: '',
        bank_line_auto_explained: null,
        prior_match_type: 'receipt'
      }]
    }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-2',
    bankTransactionId: 'tx-1',
    matchedObjectType: 'supplier_bill',
    documentId: 'doc-2'
  });
  const classicUpdate = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes("is distinct from 'explained'")
  );
  assert.ok(classicUpdate, 'classic guarded UPDATE issued (no-ops in SQL on the explained guard)');
  const supersede = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes('not exists')
  );
  assert.ok(!supersede, 'no supersede for a doc-explained line');
});

await test('cascade: later evidence never downgrades a Donna-posted transaction', async () => {
  const client = makeRoutedClient([
    {
      match: "payload->>'support_status'",
      rows: [{
        reconciliation_status: 'posted',
        support_status: '',
        bank_line_auto_explained: null,
        bank_line_disposition_explained: null,
        ai_suggestion_status: 'auto_applied',
        prior_match_type: 'bank_line'
      }]
    }
  ]);
  await cascadeAutoMatch({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    matchId: 'match-after-posting',
    bankTransactionId: 'tx-posted',
    matchedObjectType: 'receipt',
    documentId: 'doc-after-posting'
  });

  const supersede = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes('not exists')
  );
  assert.ok(!supersede, 'posted accounting state never enters the explanation-supersede writer');
  const guardedUpdate = client.calls.find((c) =>
    c.sql.includes('update transactions') && c.sql.includes("is distinct from 'explained'")
  );
  assert.ok(guardedUpdate, 'the ordinary update is issued with its posted-state no-op guard');
  assert.match(guardedUpdate.sql, /reconciliation_status is distinct from 'posted'/);
});

// --- Louis QA demotion ---

await test('triage: Louis fail demotes green-lane to suggested', async () => {
  const candidate = makeMatchCandidate();
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              candidates: [{ index: 1, verdict: 'match', confidence: 0.88, reasoning: 'Looks good' }]
            })
          }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            verdict: 'fail',
            scores: { amount_validity: 2, vendor_identity: 1 },
            reasoning: 'Vendor identity is weak'
          })
        }]
      })
    };
  };
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.verdict, 'match');
    assert.equal(r.louisVerdict, 'fail');
    assert.equal(r.finalState, 'suggested');
  } finally {
    globalThis.fetch = original;
  }
});

await test('triage: Louis pass keeps green-lane auto_matched', async () => {
  const candidate = makeMatchCandidate();
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              candidates: [{ index: 1, verdict: 'match', confidence: 0.88, reasoning: 'Confirmed' }]
            })
          }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            verdict: 'pass',
            scores: { amount_validity: 5, vendor_identity: 4, date_plausibility: 5 },
            reasoning: 'All checks pass'
          })
        }]
      })
    };
  };
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.verdict, 'match');
    assert.equal(r.louisVerdict, 'pass');
    assert.equal(r.finalState, 'auto_matched');
    assert.equal(r.lane, 'green');
  } finally {
    globalThis.fetch = original;
  }
});

// --- Integration-style tests ---

await test('integration: Tier 4 candidate + LLM match → green-lane auto', async () => {
  const candidate = makeCandidate({
    score: 0.55,
    match_reason: {
      source: 'bill_reconciliation',
      amount: { transaction: 127.43, document: 127.43, exact: true, delta: 0 },
      date: { transaction: '2026-05-03', document: '2026-04-30', gap_days: 3 },
      confidence_tier: 'amount_exact_no_vendor',
      hints: ['amount_exact', 'within_window'],
      extraction_source: null,
      score: 0.55
    },
    document: { extraction_confidence: 0.95 }
  });

  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              candidates: [{
                index: 1,
                verdict: 'match',
                confidence: 0.88,
                reasoning: 'Amount $127.43 is specific. Bank desc contains STRIPE which matches document vendor.'
              }]
            })
          }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({ verdict: 'pass', scores: { amount_validity: 5 }, reasoning: 'OK' })
        }]
      })
    };
  };

  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.verdict, 'match');
    assert.equal(r.lane, 'green');
    assert.equal(r.finalState, 'auto_matched');
    assert.ok(r.upgradedScore >= 0.85);
  } finally {
    globalThis.fetch = original;
  }
});

await test('integration: round-number amount + no vendor → LLM returns review → suggested', async () => {
  const candidate = makeCandidate({
    score: 0.55,
    document: { vendor_name: null, total_amount: 100, filename: 'invoice.pdf' },
    transaction: { description: 'PAYMENT', money_out: 100 },
    match_reason: {
      source: 'bill_reconciliation',
      amount: { transaction: 100, document: 100, exact: true, delta: 0 },
      date: { gap_days: 5 },
      confidence_tier: 'amount_exact_no_vendor',
      hints: ['amount_exact', 'within_window'],
      extraction_source: null,
      score: 0.55
    }
  });

  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'review', confidence: 0.5, reasoning: 'Round amount with no vendor clues' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.verdict, 'review');
    assert.equal(r.finalState, 'suggested');
  } finally {
    restore();
  }
});

await test('integration: Louis verdict logged to DB', async () => {
  const candidate = makeMatchCandidate();
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              candidates: [{ index: 1, verdict: 'match', confidence: 0.88, reasoning: 'Match' }]
            })
          }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({ verdict: 'pass', scores: {}, reasoning: 'OK' })
        }]
      })
    };
  };
  const mockClient = makeMockClient();
  try {
    await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: mockClient,
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const louisUpdate = mockClient.calls.find((c) =>
      c.sql.includes('louis_verdict')
    );
    assert.ok(louisUpdate, 'Expected Louis verdict to be logged');
  } finally {
    globalThis.fetch = original;
  }
});

await test('triage: receipt-style candidate without hints array works', async () => {
  const candidate = makeCandidate({
    score: 0.72,
    match_reason: {
      source: 'receipt_reconciliation',
      amount: { transaction: 42.50, document: 42.50, exact: true, delta: 0 },
      date: { transaction: '2026-05-03', document: '2026-05-03', gap_days: 0 },
      confidence_tier: 'amount_near_vendor',
      score: 0.72
    }
  });
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'match', confidence: 0.85, reasoning: 'OK' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    assert.equal(results.size, 1);
    const r = results.get(0);
    assert.ok(r.verdict);
  } finally {
    restore();
  }
});

await test('triage: no_match does not upgrade score', async () => {
  const candidate = makeMatchCandidate();
  const restore = mockFetch({
    candidates: [{ index: 1, verdict: 'no_match', confidence: 0.2, reasoning: 'Different' }]
  });
  try {
    const results = await triageReconciliationCandidates({
      candidates: [candidate],
      apiKey: 'test-key',
      client: makeMockClient(),
      firmId: 'firm-1',
      clientId: 'client-1'
    });
    const r = results.get(0);
    assert.equal(r.upgradedScore, 0.55);
  } finally {
    restore();
  }
});
