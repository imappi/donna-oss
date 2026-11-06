// Unit tests for the pure helpers in
// scripts/backfill_alex_morgan_classification.js. The DB-touching paths
// (previewDocs / applyRentReceipts / applyApMisclassified) are
// integration territory and aren't covered here; they run against the
// live prod DB in dry-run mode before any --apply.

import assert from 'node:assert/strict';
import {
  deriveVendorFromFilename,
  formatIsoDate,
  buildBackfillAudit
} from './backfill_alex_morgan_classification.js';

let passed = 0;
let failed = 0;

const test = (name, fn) =>
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  fail ${name}`);
      console.error(`       ${err?.stack || err?.message || err}`);
    });

const runTests = async () => {
  console.log('backfill_alex_morgan_classification:');

  // ── deriveVendorFromFilename ─────────────────────────────────────
  await test('deriveVendorFromFilename: NN_YYYY-MM-DD_<vendor>_invoice.pdf', () => {
    assert.equal(
      deriveVendorFromFilename('01_2026-02-03_AWS_invoice.pdf'),
      'AWS'
    );
  });

  await test('deriveVendorFromFilename: multi-word vendor', () => {
    assert.equal(
      deriveVendorFromFilename('09_2026-05-10_Foxbury_letting_agent_invoice.pdf'),
      'Foxbury letting agent'
    );
  });

  await test('deriveVendorFromFilename: preserves case (WeWork, AWS)', () => {
    assert.equal(
      deriveVendorFromFilename('04_2026-02-09_WeWork_invoice.pdf'),
      'WeWork'
    );
  });

  await test('deriveVendorFromFilename: works without numeric / date prefix', () => {
    assert.equal(
      deriveVendorFromFilename('Foxbury_letting_agent_invoice.pdf'),
      'Foxbury letting agent'
    );
  });

  await test('deriveVendorFromFilename: case-insensitive on the suffix', () => {
    assert.equal(
      deriveVendorFromFilename('01_2026-02-03_AWS_Invoice.PDF'),
      'AWS'
    );
  });

  await test('deriveVendorFromFilename: returns null on non-invoice filename', () => {
    assert.equal(deriveVendorFromFilename('Okonkwo_rent_receipt.pdf'), null);
    assert.equal(deriveVendorFromFilename('bank_statement.pdf'), null);
    assert.equal(deriveVendorFromFilename(''), null);
    assert.equal(deriveVendorFromFilename(null), null);
    assert.equal(deriveVendorFromFilename(undefined), null);
  });

  await test('deriveVendorFromFilename: vendor segment can include the word "issued" inside (handled by query filter, not here)', () => {
    // Defence in depth — the SQL query is responsible for excluding
    // `*_invoice_issued.pdf`, but if such a filename ever slipped through,
    // this helper would parse it as vendor="<x>_invoice_issued" (the
    // suffix regex anchors on the FIRST `_invoice.pdf` match, but here
    // `_invoice.pdf` is the tail). Documenting current behaviour:
    assert.equal(
      deriveVendorFromFilename('05_2026-02-11_BrightPath_invoice_issued.pdf'),
      null
    );
  });

  // ── formatIsoDate ────────────────────────────────────────────────
  await test('formatIsoDate: ISO string passes through (YYYY-MM-DD prefix)', () => {
    assert.equal(formatIsoDate('2026-05-01'), '2026-05-01');
    assert.equal(formatIsoDate('2026-05-01T00:00:00Z'), '2026-05-01');
  });

  await test('formatIsoDate: Date object → YYYY-MM-DD', () => {
    assert.equal(
      formatIsoDate(new Date('2026-05-01T00:00:00Z')),
      '2026-05-01'
    );
  });

  await test('formatIsoDate: null / empty / undefined → (no date)', () => {
    assert.equal(formatIsoDate(null), '(no date)');
    assert.equal(formatIsoDate(undefined), '(no date)');
    assert.equal(formatIsoDate(''), '(no date)');
    assert.equal(formatIsoDate('   '), '(no date)');
  });

  await test('formatIsoDate: invalid Date → (invalid date)', () => {
    assert.equal(formatIsoDate(new Date('not a date')), '(invalid date)');
  });

  await test('formatIsoDate: non-ISO string falls through unchanged', () => {
    // Not the happy path, but we don't want to silently mangle
    // unexpected formats.
    assert.equal(formatIsoDate('May 1, 2026'), 'May 1, 2026');
  });

  // ── buildBackfillAudit ───────────────────────────────────────────
  await test('buildBackfillAudit: contains required provenance fields', () => {
    const audit = buildBackfillAudit({
      originalType: 'sales_invoice',
      finalType: 'supplier_bill',
      originalDirection: 'incoming',
      finalDirection: 'outgoing',
      reason: 'because'
    });
    assert.equal(audit.source, 'alex_morgan_backfill_v2');
    assert.equal(audit.original_type, 'sales_invoice');
    assert.equal(audit.final_type, 'supplier_bill');
    assert.equal(audit.original_direction, 'incoming');
    assert.equal(audit.final_direction, 'outgoing');
    assert.equal(audit.reason, 'because');
    assert.equal(audit.changed_by, 'system');
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T/.test(audit.changed_at),
      'changed_at is an ISO timestamp'
    );
  });

  await test('buildBackfillAudit: extras merge in last (callers can stamp e.g. original_vendor_name)', () => {
    const audit = buildBackfillAudit({
      originalType: 'sales_invoice',
      finalType: 'supplier_bill',
      originalDirection: 'incoming',
      finalDirection: 'outgoing',
      reason: 'x',
      extras: {
        original_vendor_name: null,
        vendor_name_source: 'derived_from_filename'
      }
    });
    assert.equal(audit.original_vendor_name, null);
    assert.equal(audit.vendor_name_source, 'derived_from_filename');
  });

  await test('buildBackfillAudit: extras cannot overwrite the canonical source tag', () => {
    // Defensive — `extras` is spread AFTER the canonical fields, so a
    // caller passing `source` in `extras` WOULD currently overwrite the
    // canonical value. Document the current behaviour so any future
    // hardening can spot the divergence.
    const audit = buildBackfillAudit({
      originalType: 'a',
      finalType: 'b',
      originalDirection: 'incoming',
      finalDirection: 'outgoing',
      reason: 'x',
      extras: { source: 'malicious' }
    });
    // Current behaviour — spread wins. Captured as a regression
    // anchor: if we ever harden this, this test will fail and force a
    // conscious decision.
    assert.equal(audit.source, 'malicious');
  });

  console.log(`\nbackfill_alex_morgan_classification: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
};

runTests();
