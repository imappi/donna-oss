import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLineageBuilder,
  buildLineageForGenericProjection
} from './decisionLineage.js';

let passed = 0;
const track = () => passed++;

test('lineage builder records entries', () => {
  const lineage = createLineageBuilder({ model_id: 'gpt-5.4-nano', prompt_version: 'v2' });
  lineage.record({
    target: 'documents.total_amount',
    value: 433.33,
    source_claim: { role: 'amount_paid', raw_value: '£433.00', page: 2 },
    confidence: { normalized_confidence: 0.82, decision_band: 'green' },
    validator_outcomes: [{ code: 'EVIDENCE_AMOUNT_EXTRACTED', severity: 'info', passed: true }],
    policy_blockers_considered: ['disallowed_amount_role'],
    decision_lane: 'auto_write'
  });
  const entries = lineage.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'documents.total_amount');
  assert.equal(entries[0].value, 433.33);
  assert.equal(entries[0].source_claim.role, 'amount_paid');
  assert.equal(entries[0].source_claim.page, 2);
  assert.equal(entries[0].confidence.normalized, 0.82);
  assert.equal(entries[0].confidence.band, 'green');
  assert.equal(entries[0].model_id, 'gpt-5.4-nano');
  assert.equal(entries[0].prompt_version, 'v2');
  assert.equal(entries[0].decision_lane, 'auto_write');
  assert.ok(entries[0].decided_at);
  track();
});

test('lineage builder records skip entries', () => {
  const lineage = createLineageBuilder({});
  lineage.recordSkip({
    target: 'documents.vendor_name',
    reason: 'no_party_with_allowed_role',
    policy_blockers_triggered: ['disallowed_party_role']
  });
  const entries = lineage.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'documents.vendor_name');
  assert.equal(entries[0].value, null);
  assert.equal(entries[0].decision_lane, 'skipped');
  assert.equal(entries[0].skip_reason, 'no_party_with_allowed_role');
  assert.deepEqual(entries[0].policy_blockers_triggered, ['disallowed_party_role']);
  track();
});

test('lineage builder accumulates multiple entries', () => {
  const lineage = createLineageBuilder({});
  lineage.record({ target: 'a', value: 1 });
  lineage.record({ target: 'b', value: 2 });
  lineage.recordSkip({ target: 'c', reason: 'test' });
  assert.equal(lineage.entries().length, 3);
  track();
});

test('entries() returns a copy', () => {
  const lineage = createLineageBuilder({});
  lineage.record({ target: 'a', value: 1 });
  const e1 = lineage.entries();
  const e2 = lineage.entries();
  assert.notEqual(e1, e2);
  assert.deepEqual(e1, e2);
  track();
});

test('null source_claim is handled', () => {
  const lineage = createLineageBuilder({});
  lineage.record({ target: 'a', value: 1, source_claim: null });
  assert.equal(lineage.entries()[0].source_claim, null);
  track();
});

test('null confidence is handled', () => {
  const lineage = createLineageBuilder({});
  lineage.record({ target: 'a', value: 1, confidence: null });
  assert.equal(lineage.entries()[0].confidence, null);
  track();
});

test('validator outcomes are sanitized', () => {
  const lineage = createLineageBuilder({});
  lineage.record({
    target: 'a',
    value: 1,
    validator_outcomes: [
      { code: 'X', severity: 'info', passed: true },
      null,
      { code: 'Y', severity: 'warn', passed: false }
    ]
  });
  assert.equal(lineage.entries()[0].validator_outcomes.length, 2);
  track();
});

// ── buildLineageForGenericProjection ────────────────────────────────

test('generic projection: vendor_name written → lineage has auto_write entry', () => {
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: 'Acme Corp', total_amount: null, document_date: null, due_date: null },
    parties: [{ name: 'Acme Corp', role: 'supplier' }],
    amounts: [],
    dates: []
  });
  const vendorEntry = entries.find((e) => e.target === 'documents.vendor_name');
  assert.ok(vendorEntry);
  assert.equal(vendorEntry.value, 'Acme Corp');
  assert.equal(vendorEntry.decision_lane, 'auto_write');
  assert.equal(vendorEntry.source_claim.role, 'supplier');
  track();
});

test('generic projection: vendor_name null with parties → lineage has skip entry', () => {
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: null, total_amount: null, document_date: null, due_date: null },
    parties: [{ name: 'Bristol Council', role: 'government_agency' }],
    amounts: [],
    dates: []
  });
  const vendorEntry = entries.find((e) => e.target === 'documents.vendor_name');
  assert.ok(vendorEntry);
  assert.equal(vendorEntry.decision_lane, 'skipped');
  assert.equal(vendorEntry.skip_reason, 'no_party_with_allowed_role');
  track();
});

test('generic projection: total_amount written → lineage traces to amount claim', () => {
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: null, total_amount: 433.33, document_date: null, due_date: null },
    parties: [],
    amounts: [{ value: 433.33, role: 'amount_paid', currency: 'GBP' }],
    dates: []
  });
  const amountEntry = entries.find((e) => e.target === 'documents.total_amount');
  assert.ok(amountEntry);
  assert.equal(amountEntry.value, 433.33);
  assert.equal(amountEntry.source_claim.role, 'amount_paid');
  track();
});

test('generic projection: total_amount null with amounts → lineage has skip', () => {
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: null, total_amount: null, document_date: null, due_date: null },
    parties: [],
    amounts: [{ value: 5200, role: 'annual_total' }],
    dates: []
  });
  const amountEntry = entries.find((e) => e.target === 'documents.total_amount');
  assert.ok(amountEntry);
  assert.equal(amountEntry.decision_lane, 'skipped');
  track();
});

test('generic projection: document_date written → lineage entry', () => {
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: null, total_amount: null, document_date: '2026-04-02', due_date: null },
    parties: [],
    amounts: [],
    dates: [{ value: '2026-04-02', role: 'document_date', label: 'issue date' }]
  });
  const dateEntry = entries.find((e) => e.target === 'documents.document_date');
  assert.ok(dateEntry);
  assert.equal(dateEntry.value, '2026-04-02');
  track();
});

test('generic projection: due_date written → lineage entry', () => {
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: null, total_amount: null, document_date: null, due_date: '2026-05-01' },
    parties: [],
    amounts: [],
    dates: [{ value: '2026-05-01', role: 'due_date', label: 'payment due' }]
  });
  const dueEntry = entries.find((e) => e.target === 'documents.due_date');
  assert.ok(dueEntry);
  assert.equal(dueEntry.value, '2026-05-01');
  track();
});

test('generic projection: empty everything → no entries', () => {
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: null, total_amount: null, document_date: null, due_date: null },
    parties: [],
    amounts: [],
    dates: []
  });
  assert.equal(entries.length, 0);
  track();
});

test('generic projection: confidence envelope passed through', () => {
  const conf = { normalized_confidence: 0.85, decision_band: 'green' };
  const entries = buildLineageForGenericProjection({
    header: { vendor_name: 'Test', total_amount: null, document_date: null, due_date: null },
    parties: [{ name: 'Test', role: 'supplier' }],
    amounts: [],
    dates: [],
    confidence: conf,
    model_id: 'gpt-5.4-nano',
    prompt_version: 'evidence-v2'
  });
  const vendorEntry = entries.find((e) => e.target === 'documents.vendor_name');
  assert.equal(vendorEntry.confidence.normalized, 0.85);
  assert.equal(vendorEntry.confidence.band, 'green');
  track();
});

console.log(`decisionLineage: ${passed} passed, 0 failed.`);
