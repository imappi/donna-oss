import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOSE_DISPOSITIONS } from './closeDisposition.js';
import { buildFirmFeed, FEED_BUCKET_ORDER } from './firmFeed.js';

// ─────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────

const FIRM = {
  id: 'donna-demo-firm',
  name: 'Donna Demo',
  jurisdiction: 'SG'
};

const HONEYBEE = {
  id: 'honeybee-hills-apiary',
  company_name: 'Honeybee Hills Apiary',
  jurisdiction: null, // falls back to firm
  profile: { accountingBasis: 'cash' }
};

const ALEX = {
  id: 'alex-morgan-personal',
  company_name: 'Alex Morgan',
  jurisdiction: 'UK',
  profile: {}
};

const tx = (overrides = {}) => ({
  id: 'tx_default',
  firm_id: FIRM.id,
  client_id: HONEYBEE.id,
  transaction_date: '2026-06-01',
  description: 'STAPLES OFFICE SUPPLIES',
  money_in: 0,
  money_out: 50,
  currency: 'USD',
  ...overrides
});

const match = (overrides = {}) => ({
  id: 'rm_default',
  firm_id: FIRM.id,
  client_id: HONEYBEE.id,
  bank_transaction_id: 'tx_default',
  matched_object_type: 'supplier_bill',
  matched_object_id: 'doc_default',
  match_amount: 50,
  match_confidence: 0.95,
  status: 'suggested',
  payload: {
    match_reason: { auto_match_passed: true, auto_match_blockers: [] },
    recommended_action: 'auto_match_candidate'
  },
  ...overrides
});

const reviewItem = (overrides = {}) => ({
  id: 'rq_default',
  firm_id: FIRM.id,
  client_id: HONEYBEE.id,
  item_type: 'transaction',
  item_id: 'tx_default',
  reason: 'category_needs_review',
  review_state: 'suggested',
  status: 'open',
  payload: {},
  ...overrides
});

// ─────────────────────────────────────────────────────────────────
// Empty snapshot + envelope shape
// ─────────────────────────────────────────────────────────────────

await test('empty snapshot returns four empty buckets + zero totals + bucket_order', () => {
  const feed = buildFirmFeed({ firm: FIRM, clients: [HONEYBEE] });
  assert.equal(feed.totals.auto_cleared, 0);
  assert.equal(feed.totals.confirmable, 0);
  assert.equal(feed.totals.operator_blocker, 0);
  assert.equal(feed.totals.client_info_needed, 0);
  assert.equal(feed.totals.blocks_close, 0);
  assert.deepStrictEqual(feed.buckets.auto_cleared, []);
  assert.deepStrictEqual(feed.bucket_order, FEED_BUCKET_ORDER);
  assert.ok(feed.generated_at);
});

await test('feed envelope has the expected top-level keys', () => {
  const feed = buildFirmFeed({ firm: FIRM, clients: [HONEYBEE] });
  assert.deepStrictEqual(
    new Set(Object.keys(feed)),
    new Set(['buckets', 'bucket_order', 'totals', 'generated_at'])
  );
});

// ─────────────────────────────────────────────────────────────────
// Bucketing — reconciliation matches across dispositions
// ─────────────────────────────────────────────────────────────────

await test('confirmed match lands in auto_cleared', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    reconciliationMatches: [match({ status: 'confirmed' })]
  });
  assert.equal(feed.buckets.auto_cleared.length, 1);
  assert.equal(feed.buckets.auto_cleared[0].verdict.disposition, CLOSE_DISPOSITIONS.AUTO_CLEARED);
  assert.equal(feed.totals.auto_cleared, 1);
});

await test('suggested high-confidence match lands in confirmable', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    reconciliationMatches: [match()]
  });
  assert.equal(feed.buckets.confirmable.length, 1);
  assert.equal(feed.totals.confirmable, 1);
});

await test('IRS regression: tax-sensitive descriptor lands in operator_blocker even at 0.99 confidence', () => {
  // Mirror of the closeDisposition IRS test but exercised end-to-end
  // through the feed builder — proves the transaction descriptor flows
  // from snapshot.transactions to the classifier's risk-class
  // detection across the buildFirmFeed seam.
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx({
      id: 'tx_irs',
      description: 'IRS USATAXPYMT 04212026',
      money_out: 1500
    })],
    reconciliationMatches: [match({
      id: 'rm_irs',
      bank_transaction_id: 'tx_irs',
      match_confidence: 0.99,
      match_amount: 1500
    })]
  });
  assert.equal(feed.buckets.operator_blocker.length, 1);
  const item = feed.buckets.operator_blocker[0];
  assert.equal(item.verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(item.verdict.risk_class, 'tax_sensitive');
  assert.equal(item.verdict.reason_code, 'risk_class_tax_sensitive_routes_to_operator');
});

await test('high-materiality suggested match lands in operator_blocker (blocks close)', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx({ id: 'tx_big', money_out: 5000 })],
    reconciliationMatches: [match({
      id: 'rm_big',
      bank_transaction_id: 'tx_big',
      match_amount: 5000
    })]
  });
  assert.equal(feed.buckets.operator_blocker.length, 1);
  assert.equal(feed.buckets.operator_blocker[0].verdict.blocks_close, true);
});

// ─────────────────────────────────────────────────────────────────
// Bucketing — review queue
// ─────────────────────────────────────────────────────────────────

await test('asked_client review item at low materiality lands in client_info_needed (no close block)', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx({ money_out: 30 })],
    transactionReviewQueue: [reviewItem({
      review_state: 'asked_client',
      payload: { evidence_request: { status: 'open', evidence_type: 'receipt' } }
    })]
  });
  assert.equal(feed.buckets.client_info_needed.length, 1);
  const item = feed.buckets.client_info_needed[0];
  assert.equal(item.verdict.blocks_close, false);
  assert.ok(item.verdict.disclosure_reason);
});

await test('review_state=accepted lands in auto_cleared', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    transactionReviewQueue: [reviewItem({ review_state: 'accepted' })]
  });
  assert.equal(feed.buckets.auto_cleared.length, 1);
});

// ─────────────────────────────────────────────────────────────────
// Sort: blocks_close first, then date desc
// ─────────────────────────────────────────────────────────────────

await test('within operator_blocker bucket: blocks_close=true comes before blocks_close=false', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [
      tx({ id: 'tx_low',  transaction_date: '2026-06-05', money_out: 80 }),
      tx({ id: 'tx_high', transaction_date: '2026-06-01', money_out: 5000 })
    ],
    reconciliationMatches: [
      // Low-amount suggested with blockers → operator_blocker, blocks_close=false
      match({
        id: 'rm_low',
        bank_transaction_id: 'tx_low',
        match_amount: 80,
        match_confidence: 0.5,
        payload: {
          match_reason: { auto_match_passed: false, auto_match_blockers: ['low_extraction_confidence'] }
        }
      }),
      // High-amount suggested → operator_blocker, blocks_close=true
      match({
        id: 'rm_high',
        bank_transaction_id: 'tx_high',
        match_amount: 5000
      })
    ]
  });
  const items = feed.buckets.operator_blocker;
  assert.equal(items.length, 2);
  assert.equal(items[0].source_id, 'rm_high', 'blocks_close=true should rise to top');
  assert.equal(items[1].source_id, 'rm_low');
});

await test('within a bucket: equal blocks_close tier sorts by transaction_date descending', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [
      tx({ id: 'tx_older', transaction_date: '2026-01-01', money_out: 50 }),
      tx({ id: 'tx_newer', transaction_date: '2026-06-01', money_out: 50 })
    ],
    reconciliationMatches: [
      match({ id: 'rm_older', bank_transaction_id: 'tx_older' }),
      match({ id: 'rm_newer', bank_transaction_id: 'tx_newer' })
    ]
  });
  const items = feed.buckets.confirmable;
  assert.equal(items.length, 2);
  assert.equal(items[0].source_id, 'rm_newer', 'newest first');
  assert.equal(items[1].source_id, 'rm_older');
});

// ─────────────────────────────────────────────────────────────────
// Context enrichment: client_name, jurisdiction, accounting_basis
// ─────────────────────────────────────────────────────────────────

await test('feed item context carries client_name + jurisdiction + accounting_basis', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    reconciliationMatches: [match()]
  });
  const item = feed.buckets.confirmable[0];
  assert.equal(item.verdict.context.firm_id, FIRM.id);
  assert.equal(item.verdict.context.client_id, HONEYBEE.id);
  assert.equal(item.verdict.context.client_name, 'Honeybee Hills Apiary');
  assert.equal(item.verdict.context.accounting_basis, 'cash');
});

await test('jurisdiction falls back from client to firm when client.jurisdiction is null', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    reconciliationMatches: [match()]
  });
  const item = feed.buckets.confirmable[0];
  assert.equal(item.verdict.context.jurisdiction, 'SG'); // from firm
});

await test('jurisdiction uses client override when set (Alex Morgan = UK on SG firm)', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [ALEX],
    transactions: [tx({ id: 'tx_alex', client_id: ALEX.id })],
    reconciliationMatches: [match({
      id: 'rm_alex',
      client_id: ALEX.id,
      bank_transaction_id: 'tx_alex'
    })]
  });
  const item = feed.buckets.confirmable[0];
  assert.equal(item.verdict.context.jurisdiction, 'UK');
});

// ─────────────────────────────────────────────────────────────────
// Filters — clientId + bucket
// ─────────────────────────────────────────────────────────────────

await test('clientId filter limits feed to a single client', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE, ALEX],
    transactions: [
      tx({ id: 'tx_hb',   client_id: HONEYBEE.id }),
      tx({ id: 'tx_alex', client_id: ALEX.id })
    ],
    reconciliationMatches: [
      match({ id: 'rm_hb',   client_id: HONEYBEE.id, bank_transaction_id: 'tx_hb' }),
      match({ id: 'rm_alex', client_id: ALEX.id,    bank_transaction_id: 'tx_alex' })
    ],
    clientId: HONEYBEE.id
  });
  assert.equal(feed.buckets.confirmable.length, 1);
  assert.equal(feed.buckets.confirmable[0].client_id, HONEYBEE.id);
});

await test('bucket filter returns just the requested bucket', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [
      tx({ id: 'tx_a' }),
      tx({ id: 'tx_b', money_out: 5000 })
    ],
    reconciliationMatches: [
      match({ id: 'rm_a', bank_transaction_id: 'tx_a' }),                          // confirmable
      match({ id: 'rm_b', bank_transaction_id: 'tx_b', match_amount: 5000 })       // operator_blocker
    ],
    bucket: CLOSE_DISPOSITIONS.OPERATOR_BLOCKER
  });
  assert.deepStrictEqual(
    Object.keys(feed.buckets),
    [CLOSE_DISPOSITIONS.OPERATOR_BLOCKER]
  );
  assert.equal(feed.buckets.operator_blocker.length, 1);
  assert.equal(feed.buckets.operator_blocker[0].source_id, 'rm_b');
  // totals still reflect the full picture so the UI can show counts
  assert.equal(feed.totals.confirmable, 1);
  assert.equal(feed.totals.operator_blocker, 1);
});

await test('unknown bucket throws', () => {
  assert.throws(
    () => buildFirmFeed({ firm: FIRM, bucket: 'made_up' }),
    /unknown bucket/
  );
});

// ─────────────────────────────────────────────────────────────────
// Per-client materiality overrides
// ─────────────────────────────────────────────────────────────────

await test('per-client materiality bands flow through: $500 stays LOW for a larger client', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx({ money_out: 500 })],
    reconciliationMatches: [match({ match_amount: 500 })],
    materialityBandsByClient: {
      [HONEYBEE.id]: { low_max: 1000, medium_max: 10000 }
    }
  });
  // With default bands $500 would be MEDIUM. With wider bands it
  // stays LOW, so the suggested high-confidence match → confirmable
  // instead of being escalated.
  assert.equal(feed.buckets.confirmable.length, 1);
  assert.equal(feed.buckets.confirmable[0].verdict.materiality, 'low');
});

await test('per-client materiality bands are scoped: only the named client gets the override', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE, ALEX],
    transactions: [
      tx({ id: 'tx_hb',   client_id: HONEYBEE.id, money_out: 500 }),
      tx({ id: 'tx_alex', client_id: ALEX.id,    money_out: 500 })
    ],
    reconciliationMatches: [
      match({ id: 'rm_hb',   client_id: HONEYBEE.id, bank_transaction_id: 'tx_hb',   match_amount: 500 }),
      match({ id: 'rm_alex', client_id: ALEX.id,    bank_transaction_id: 'tx_alex', match_amount: 500 })
    ],
    materialityBandsByClient: {
      [HONEYBEE.id]: { low_max: 1000, medium_max: 10000 }
    }
  });
  const hb = feed.buckets.confirmable.find((i) => i.client_id === HONEYBEE.id);
  const alex = [...feed.buckets.confirmable, ...feed.buckets.operator_blocker]
    .find((i) => i.client_id === ALEX.id);
  assert.equal(hb.verdict.materiality, 'low', 'Honeybee with override → LOW');
  assert.equal(alex.verdict.materiality, 'medium', 'Alex with defaults → MEDIUM');
});

// ─────────────────────────────────────────────────────────────────
// Robustness — missing rows shouldn't crash
// ─────────────────────────────────────────────────────────────────

await test('match whose transaction is absent from snapshot still classifies (no crash)', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [], // tx missing
    reconciliationMatches: [match()]
  });
  // No transaction → no descriptor → risk_class stays 'general' →
  // suggested high-confidence flows through to confirmable still.
  assert.equal(feed.buckets.confirmable.length, 1);
  assert.equal(feed.buckets.confirmable[0].descriptor, null);
});

await test('match whose client is absent from snapshot still classifies (context.client_name null)', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [], // client missing
    transactions: [tx()],
    reconciliationMatches: [match()]
  });
  const item = feed.buckets.confirmable[0];
  assert.equal(item.verdict.context.client_name, null);
  assert.equal(item.verdict.context.client_id, null);
});

await test('totals.blocks_close counts items across all buckets', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [
      tx({ id: 'tx_hi',     money_out: 5000 }),     // operator_blocker, blocks
      tx({ id: 'tx_ask',    money_out: 5000 }),     // client_info_needed, blocks
      tx({ id: 'tx_lo' })                            // confirmable, no block
    ],
    reconciliationMatches: [
      match({ id: 'rm_hi', bank_transaction_id: 'tx_hi', match_amount: 5000 }),
      match({ id: 'rm_lo', bank_transaction_id: 'tx_lo' })
    ],
    transactionReviewQueue: [
      reviewItem({
        id: 'rq_ask',
        item_id: 'tx_ask',
        review_state: 'asked_client',
        payload: { evidence_request: { status: 'open', evidence_type: 'invoice' } }
      })
    ]
  });
  assert.equal(feed.totals.operator_blocker, 1);
  assert.equal(feed.totals.confirmable, 1);
  assert.equal(feed.totals.client_info_needed, 1);
  assert.equal(feed.totals.blocks_close, 2, 'operator_blocker + high-materiality client_info_needed');
});

// ─────────────────────────────────────────────────────────────────
// Feed item shape — every row carries the spec's required fields
// ─────────────────────────────────────────────────────────────────

await test('reconciliation_match feed item carries all spec-required action fields', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    reconciliationMatches: [match()]
  });
  const item = feed.buckets.confirmable[0];
  // Spec checklist: client, jurisdiction, accounting basis, disposition,
  // allowed actor, proposed action, reason, confidence, materiality,
  // amount, date, counterparty/vendor.
  assert.equal(item.kind, 'reconciliation_match');
  assert.equal(item.client_id, HONEYBEE.id);
  assert.equal(item.verdict.context.jurisdiction, 'SG');
  assert.equal(item.verdict.context.accounting_basis, 'cash');
  assert.equal(item.verdict.disposition, CLOSE_DISPOSITIONS.CONFIRMABLE);
  assert.equal(item.verdict.allowed_actor, 'backup_bookkeeper');
  assert.equal(item.verdict.proposed_action.type, 'confirm_reconciliation_match');
  assert.ok(item.verdict.reason_code);
  assert.equal(item.verdict.confidence, 0.95);
  assert.equal(item.verdict.materiality, 'low');
  assert.equal(item.amount, -50);
  assert.equal(item.transaction_date, '2026-06-01');
  assert.equal(item.descriptor, 'STAPLES OFFICE SUPPLIES');
});

await test('review_item feed item carries item_id + reason for downstream linking', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    transactionReviewQueue: [reviewItem({
      review_state: 'asked_client',
      payload: { evidence_request: { status: 'open', evidence_type: 'receipt' } }
    })]
  });
  const item = feed.buckets.client_info_needed[0];
  assert.equal(item.kind, 'review_item');
  assert.equal(item.item_id, 'tx_default');
  assert.equal(item.item_type, 'transaction');
  assert.equal(item.reason, 'category_needs_review');
});

// ─────────────────────────────────────────────────────────────────
// money_in / money_out — signed amount
// ─────────────────────────────────────────────────────────────────

await test('money_in transactions get a positive amount (e.g. customer payment)', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx({ id: 'tx_in', money_in: 500, money_out: 0 })],
    reconciliationMatches: [match({
      id: 'rm_in',
      bank_transaction_id: 'tx_in',
      matched_object_type: 'sales_invoice',
      match_amount: 500
    })]
  });
  const item = [
    ...feed.buckets.confirmable,
    ...feed.buckets.operator_blocker
  ].find((i) => i.source_id === 'rm_in');
  assert.equal(item.amount, 500);
});

await test('snapshot rows with a single `amount` field (mock shape) still work', () => {
  // The seed snapshot path doesn't always populate money_in/money_out.
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [{ id: 'tx_amt', client_id: HONEYBEE.id, transaction_date: '2026-06-01', description: 'STAPLES', amount: -50 }],
    reconciliationMatches: [match({ bank_transaction_id: 'tx_amt' })]
  });
  const item = feed.buckets.confirmable[0];
  assert.equal(item.amount, -50);
});

// ─────────────────────────────────────────────────────────────────
// Failed-parse documents
// ─────────────────────────────────────────────────────────────────

await test('failed-parse documents land in operator_blocker with blocks_close=true', () => {
  const feed = buildFirmFeed({
    firm: FIRM,
    clients: [HONEYBEE],
    documents: [
      {
        id: 'doc_failed_1',
        client_id: HONEYBEE.id,
        filename: '25-09-01_Mystery.pdf',
        parse_status: 'failed',
        parse_error: 'OCR returned empty body',
        created_at: '2026-06-04T12:00:00Z'
      }
    ]
  });
  const items = feed.buckets[CLOSE_DISPOSITIONS.OPERATOR_BLOCKER];
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.kind, 'failed_parse');
  assert.equal(item.source_id, 'doc_failed_1');
  assert.equal(item.client_id, HONEYBEE.id);
  assert.equal(item.document_id, 'doc_failed_1');
  assert.equal(item.descriptor, "Couldn't read 25-09-01_Mystery.pdf");
  assert.equal(item.reason, 'OCR returned empty body');
  assert.equal(item.amount, null);
  assert.equal(item.verdict.disposition, CLOSE_DISPOSITIONS.OPERATOR_BLOCKER);
  assert.equal(item.verdict.reason_code, 'failed_parse');
  assert.equal(item.verdict.blocks_close, true);
  assert.equal(feed.totals.blocks_close, 1);
});

await test('non-failed parse_status documents are not emitted as feed items', () => {
  const feed = buildFirmFeed({
    firm: FIRM,
    clients: [HONEYBEE],
    documents: [
      { id: 'd1', client_id: HONEYBEE.id, filename: 'a.pdf', parse_status: 'completed' },
      { id: 'd2', client_id: HONEYBEE.id, filename: 'b.pdf', parse_status: 'processing' },
      { id: 'd3', client_id: HONEYBEE.id, filename: 'c.pdf', parse_status: 'pending' },
      { id: 'd4', client_id: HONEYBEE.id, filename: 'd.pdf', parse_status: 'duplicate_pending' },
      { id: 'd5', client_id: HONEYBEE.id, filename: 'e.pdf', parse_status: 'skipped' }
    ]
  });
  for (const bucket of Object.values(feed.buckets)) {
    assert.equal(bucket.length, 0, 'no buckets should have rows');
  }
});

await test('clientId filter applies to failed-parse documents', () => {
  const feed = buildFirmFeed({
    firm: FIRM,
    clients: [HONEYBEE, ALEX],
    clientId: HONEYBEE.id,
    documents: [
      { id: 'd1', client_id: HONEYBEE.id, filename: 'h.pdf', parse_status: 'failed' },
      { id: 'd2', client_id: ALEX.id, filename: 'a.pdf', parse_status: 'failed' }
    ]
  });
  const items = feed.buckets[CLOSE_DISPOSITIONS.OPERATOR_BLOCKER];
  assert.equal(items.length, 1);
  assert.equal(items[0].source_id, 'd1');
});

// ─────────────────────────────────────────────────────────────────
// Ask lane — open evidence requests + drafted ask batches
// ─────────────────────────────────────────────────────────────────

const evidenceRequest = (overrides = {}) => ({
  id: 'cer_default',
  firm_id: FIRM.id,
  client_id: HONEYBEE.id,
  transaction_id: 'tx_default',
  status: 'open',
  evidence_type: 'receipt',
  question: 'What was this Staples charge for?',
  request_payload: {},
  first_sent_at: '2026-06-10T10:00:00Z',
  created_at: '2026-06-10T10:00:00Z',
  ...overrides
});

const askBatch = (overrides = {}) => ({
  id: 'cab_default',
  firm_id: FIRM.id,
  client_id: HONEYBEE.id,
  status: 'draft',
  subject: 'June questions',
  draft: { counts: { ask: 3, notify: 1, statement_requests: 0 } },
  created_at: '2026-06-12T09:00:00Z',
  ...overrides
});

await test('open evidence request lands in client_info_needed with the question + linked line context', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    clientEvidenceRequests: [evidenceRequest()]
  });
  assert.equal(feed.buckets.client_info_needed.length, 1);
  const item = feed.buckets.client_info_needed[0];
  assert.equal(item.kind, 'client_evidence_request');
  assert.equal(item.source_id, 'cer_default');
  assert.equal(item.transaction_id, 'tx_default');
  assert.equal(item.transaction_date, '2026-06-01');
  assert.equal(item.amount, -50);
  assert.equal(item.descriptor, 'STAPLES OFFICE SUPPLIES');
  assert.equal(item.reason, 'What was this Staples charge for?');
  assert.equal(item.verdict.reason_code, 'open_client_ask');
  assert.equal(item.verdict.blocks_close, false);
  assert.ok(item.verdict.disclosure_reason);
});

await test('material open ask blocks close', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx({ id: 'tx_big', money_out: 5000 })],
    clientEvidenceRequests: [evidenceRequest({ id: 'cer_big', transaction_id: 'tx_big' })]
  });
  const item = feed.buckets.client_info_needed[0];
  assert.equal(item.verdict.blocks_close, true);
  assert.equal(feed.totals.blocks_close, 1);
});

await test('doc-anchored ask (no bank line) uses the document filename as descriptor', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    documents: [{ id: 'doc_r', client_id: HONEYBEE.id, filename: 'receipt-may.pdf', parse_status: 'completed' }],
    clientEvidenceRequests: [evidenceRequest({
      id: 'cer_doc',
      transaction_id: null,
      request_payload: { document_id: 'doc_r' }
    })]
  });
  const item = feed.buckets.client_info_needed[0];
  assert.equal(item.descriptor, 'receipt-may.pdf');
  assert.equal(item.document_id, 'doc_r');
  assert.equal(item.transaction_date, '2026-06-10T10:00:00Z', 'falls back to first_sent_at');
});

await test('draft asks remain unsent operator work while replied/resolved asks leave the waiting lane', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    clientEvidenceRequests: [
      evidenceRequest({ id: 'cer_d', status: 'draft' }),
      evidenceRequest({ id: 'cer_r', status: 'replied' }),
      evidenceRequest({ id: 'cer_x', status: 'resolved' })
    ],
    transactionReviewQueue:[reviewItem({review_state:'asked_client',payload:{evidence_request:{status:'open',evidence_type:'receipt'}}})]
  });
  assert.equal(feed.buckets.client_info_needed.length, 0);
  const drafts=feed.buckets.operator_blocker.filter(item=>item.kind==='client_evidence_request');
  assert.equal(drafts.length,1);
  assert.equal(drafts[0].source_id,'cer_d');
  assert.equal(drafts[0].verdict.reason_code,'client_ask_draft_unsent');
  assert.match(drafts[0].reason,/Draft, not sent/);
});

await test('asked_client review row is suppressed when an open request covers the same transaction', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx()],
    transactionReviewQueue: [reviewItem({
      review_state: 'asked_client',
      payload: { evidence_request: { status: 'open', evidence_type: 'receipt' } }
    })],
    clientEvidenceRequests: [evidenceRequest()]
  });
  assert.equal(feed.buckets.client_info_needed.length, 1, 'one line, one inbox row');
  assert.equal(feed.buckets.client_info_needed[0].kind, 'client_evidence_request');
});

await test('statement-request anchors suppress sibling asked_client review rows too', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    transactions: [tx(), tx({ id: 'tx_sib' })],
    transactionReviewQueue: [reviewItem({
      id: 'rq_sib',
      item_id: 'tx_sib',
      review_state: 'asked_client',
      payload: { evidence_request: { status: 'open', evidence_type: 'bank_statement' } }
    })],
    clientEvidenceRequests: [evidenceRequest({
      request_payload: { anchor_transaction_ids: ['tx_default', 'tx_sib'] }
    })]
  });
  assert.equal(feed.buckets.client_info_needed.length, 1);
  assert.equal(feed.buckets.client_info_needed[0].kind, 'client_evidence_request');
});

await test('drafted ask batch lands in operator_blocker as the firm\'s move; sent batch does not', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE],
    askBatches: [
      askBatch({
        draft: {
          counts: { ask: 3, notify: 1, statement_requests: 0 },
          items: [{ transaction_id: 'tx_default', disposition: 'ask' }]
        }
      }),
      askBatch({ id: 'cab_sent', status: 'sent' })
    ]
  });
  assert.equal(feed.buckets.operator_blocker.length, 1);
  const item = feed.buckets.operator_blocker[0];
  assert.equal(item.kind, 'ask_batch_draft');
  assert.equal(item.source_id, 'cab_default');
  assert.equal(item.descriptor, 'June questions');
  assert.equal(item.reason, 'drafted, not sent — 3 questions · 1 FYI');
  assert.deepEqual(item.covered_transaction_ids, ['tx_default']);
  assert.equal(item.verdict.reason_code, 'ask_batch_draft_unsent');
  assert.equal(item.verdict.blocks_close, false);
});

await test('clientId filter applies to ask-lane items', () => {
  const feed = buildFirmFeed({
    firm: FIRM, clients: [HONEYBEE, ALEX],
    transactions: [tx(), tx({ id: 'tx_alex', client_id: ALEX.id })],
    clientEvidenceRequests: [
      evidenceRequest(),
      evidenceRequest({ id: 'cer_alex', client_id: ALEX.id, transaction_id: 'tx_alex' })
    ],
    askBatches: [askBatch(), askBatch({ id: 'cab_alex', client_id: ALEX.id })],
    clientId: ALEX.id
  });
  assert.equal(feed.buckets.client_info_needed.length, 1);
  assert.equal(feed.buckets.client_info_needed[0].source_id, 'cer_alex');
  assert.equal(feed.buckets.operator_blocker.length, 1);
  assert.equal(feed.buckets.operator_blocker[0].source_id, 'cab_alex');
});

await test('failed-parse classifier echoes client context in verdict', () => {
  const feed = buildFirmFeed({
    firm: FIRM,
    clients: [HONEYBEE],
    documents: [{
      id: 'd1', client_id: HONEYBEE.id, filename: 'x.pdf', parse_status: 'failed'
    }]
  });
  const item = feed.buckets[CLOSE_DISPOSITIONS.OPERATOR_BLOCKER][0];
  assert.equal(item.verdict.context.client_id, HONEYBEE.id);
  assert.equal(item.verdict.context.client_name, HONEYBEE.company_name);
  assert.equal(item.verdict.context.jurisdiction, FIRM.jurisdiction);
  assert.equal(item.verdict.context.accounting_basis, 'cash');
});

// ─────────────────────────────────────────────────────────────────
// Document-scoped review items carry document context (2026-08-07:
// the amount_mismatch rows rendered the raw reason as BOTH descriptor
// and reason, with no filename, date, or amount — an enum leak)
// ─────────────────────────────────────────────────────────────────

await test('document review item resolves filename + date from the document, never duplicates reason into descriptor', () => {
  const feed = buildFirmFeed({
    firm: FIRM,
    clients: [HONEYBEE],
    documents: [{
      id: 'doc_mismatch',
      client_id: HONEYBEE.id,
      filename: 'june-invoice.pdf',
      parse_status: 'parsed',
      created_at: '2026-06-20T00:00:00Z'
    }],
    transactionReviewQueue: [reviewItem({
      id: 'rq_doc',
      item_type: 'document',
      item_id: 'doc_mismatch',
      reason: 'amount_mismatch'
    })]
  });
  const item = Object.values(feed.buckets).flat().find((i) => i.source_id === 'rq_doc');
  assert.ok(item, 'review item present in feed');
  assert.equal(item.descriptor, 'june-invoice.pdf');
  assert.equal(item.document_id, 'doc_mismatch');
  assert.equal(item.transaction_date, '2026-06-20T00:00:00Z');
  assert.equal(item.reason, 'amount_mismatch');
});

await test('document review item without a resolvable document leaves descriptor null (renderer humanizes reason)', () => {
  const feed = buildFirmFeed({
    firm: FIRM,
    clients: [HONEYBEE],
    transactionReviewQueue: [reviewItem({
      id: 'rq_orphan',
      item_type: 'document',
      item_id: 'doc_gone',
      reason: 'amount_mismatch'
    })]
  });
  const item = Object.values(feed.buckets).flat().find((i) => i.source_id === 'rq_orphan');
  assert.ok(item, 'review item present in feed');
  assert.equal(item.descriptor, null);
  assert.equal(item.reason, 'amount_mismatch');
});

await test('a material unsent request suppresses its exact review mirror while independent correction work stays visible',()=>{
 const ask=evidenceRequest({id:'actual-draft',status:'draft'});
 const mirror=reviewItem({payload:{evidence_request:{id:'actual-draft',status:'draft'}}});
 const correction=reviewItem({id:'correction',reason:'posted_evidence_changed',payload:{coding_correction_required:{status:'pending'}}});
 const feed=buildFirmFeed({firm:FIRM,clients:[HONEYBEE],transactions:[tx({money_out:4000})],clientEvidenceRequests:[ask],transactionReviewQueue:[mirror,correction]});
 const items=Object.values(feed.buckets).flat();
 assert.equal(items.filter(i=>i.kind==='client_evidence_request').length,1);
 assert.equal(items.filter(i=>i.source_id===mirror.id).length,0);
 assert.equal(items.filter(i=>i.source_id===correction.id).length,1);
});
