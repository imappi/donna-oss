import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractFieldsFromFilename,
  applyPostExtractionEnrichment,
  isDayMonthSwap,
  isYearMisreadSwap
} from './filenameFallback.js';

// --- extractFieldsFromFilename ---

await test('extracts date despite numeric sequence prefix (Donna conversational intake)', () => {
  // The chat-driven intake numbers attachments sequentially:
  // `05_2026-04-05_Dominos_receipt.pdf`. The leading `05_` is an
  // ordering hint, not data. The parser must strip it before reading
  // the date.
  const result = extractFieldsFromFilename('05_2026-04-05_Dominos_receipt.pdf');
  assert.equal(result.document_date, '2026-04-05');
});

await test('does NOT strip a numeric prefix that isn\'t followed by an ISO date', () => {
  // The 99_ prefix here is not followed by a date pattern; leave it
  // alone (otherwise we'd start eating the start of an unrelated
  // filename).
  const result = extractFieldsFromFilename('99_random_invoice.pdf');
  assert.equal(result.document_date, null);
});

await test('extracts all fields from standard Donna filename', () => {
  const result = extractFieldsFromFilename('25-07-06_Farmers_Market_41.35.pdf');
  assert.equal(result.vendor_name, 'Farmers Market');
  assert.equal(result.document_date, '2025-07-06');
  assert.equal(result.total_amount, 41.35);
});

await test('extracts all fields from another standard filename', () => {
  const result = extractFieldsFromFilename('25-06-04_Dadant_120.77.pdf');
  assert.equal(result.vendor_name, 'Dadant');
  assert.equal(result.document_date, '2025-06-04');
  assert.equal(result.total_amount, 120.77);
});

await test('handles 4-digit year prefix', () => {
  const result = extractFieldsFromFilename('2025-01-15_Company_Name_99.99.pdf');
  assert.equal(result.vendor_name, 'Company Name');
  assert.equal(result.document_date, '2025-01-15');
  assert.equal(result.total_amount, 99.99);
});

await test('returns all nulls for non-standard filename', () => {
  const result = extractFieldsFromFilename('random-invoice.pdf');
  assert.equal(result.vendor_name, null);
  assert.equal(result.document_date, null);
  assert.equal(result.total_amount, null);
});

await test('returns all nulls for null/undefined filename', () => {
  assert.deepEqual(extractFieldsFromFilename(null), { vendor_name: null, document_date: null, total_amount: null });
  assert.deepEqual(extractFieldsFromFilename(undefined), { vendor_name: null, document_date: null, total_amount: null });
  assert.deepEqual(extractFieldsFromFilename(''), { vendor_name: null, document_date: null, total_amount: null });
});

await test('rejects scanner noise as vendor name', () => {
  const result = extractFieldsFromFilename('25-03-01_scan_50.00.pdf');
  assert.equal(result.vendor_name, null);
  assert.equal(result.document_date, '2025-03-01');
  assert.equal(result.total_amount, 50.00);
});

await test('rejects short vendor fragments', () => {
  const result = extractFieldsFromFilename('25-03-01_AB_50.00.pdf');
  assert.equal(result.vendor_name, null);
});

await test('rejects future year in date', () => {
  const result = extractFieldsFromFilename('35-01-01_Vendor_100.00.pdf');
  assert.equal(result.document_date, null);
});

await test('rejects years before 2020', () => {
  const result = extractFieldsFromFilename('19-01-01_Vendor_100.00.pdf');
  assert.equal(result.document_date, null);
});

// Audit 2026-07-30 L9 — the UK-filename garbage-vendor defect. A day-first
// prefix (`05-04-2026`) matches the date regex as `05-04-20`, the parser
// rejects it, and before the fail-closed guard the mangled remnant
// `26_Tesco` shipped as vendor "26 Tesco". A rejected date prefix now
// refuses ALL fields — the fallback withdraws where it misread the shape
// (trust-the-strong-LLM: no third jurisdiction's date grammar here).
await test('UK day-first filename: rejected date prefix refuses every field (no "26 Tesco")', () => {
  assert.deepEqual(
    extractFieldsFromFilename('05-04-2026_Tesco_12.99.pdf'),
    { vendor_name: null, document_date: null, total_amount: null }
  );
});

await test('rejected-year prefixes refuse the vendor remnant too, not just the date', () => {
  assert.equal(extractFieldsFromFilename('35-01-01_Vendor_100.00.pdf').vendor_name, null);
  assert.equal(extractFieldsFromFilename('19-01-01_Vendor_100.00.pdf').vendor_name, null);
});

await test('handles filename with date but no amount', () => {
  const result = extractFieldsFromFilename('25-07-06_Farmers_Market.pdf');
  assert.equal(result.vendor_name, 'Farmers Market');
  assert.equal(result.document_date, '2025-07-06');
  assert.equal(result.total_amount, null);
});

await test('handles filename with date and amount but single-word vendor', () => {
  const result = extractFieldsFromFilename('25-08-11_Stripe_250.00.pdf');
  assert.equal(result.vendor_name, 'Stripe');
  assert.equal(result.document_date, '2025-08-11');
  assert.equal(result.total_amount, 250.00);
});

await test('handles multi-word vendor with underscores', () => {
  const result = extractFieldsFromFilename('25-06-02_Land_Lease_831.35.pdf');
  assert.equal(result.vendor_name, 'Land Lease');
  assert.equal(result.document_date, '2025-06-02');
  assert.equal(result.total_amount, 831.35);
});

await test('handles SW_Gas pattern', () => {
  const result = extractFieldsFromFilename('25-06-06_SW_Gas_34.18.pdf');
  assert.equal(result.vendor_name, 'Sw Gas');
  assert.equal(result.document_date, '2025-06-06');
  assert.equal(result.total_amount, 34.18);
});

await test('handles APS_Electric pattern', () => {
  const result = extractFieldsFromFilename('25-06-13_APS_Electric_90.53.pdf');
  assert.equal(result.vendor_name, 'Aps Electric');
  assert.equal(result.document_date, '2025-06-13');
  assert.equal(result.total_amount, 90.53);
});

await test('rejects unreasonable amounts', () => {
  const result = extractFieldsFromFilename('25-01-01_Vendor_99999999.99.pdf');
  assert.equal(result.total_amount, null);
});

await test('does not parse comma-decimal as amount', () => {
  const result = extractFieldsFromFilename('25-01-01_Vendor_41,35.pdf');
  assert.equal(result.total_amount, null);
});

// --- applyPostExtractionEnrichment ---

await test('enrichment: fills null vendor from filename', () => {
  const header = { vendor_name: null, document_date: '2025-07-06', total_amount: 41.35, extraction_confidence: 0.9 };
  const summary = { warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary, filename: '25-07-06_Farmers_Market_41.35.pdf'
  });
  assert.equal(header.vendor_name, 'Farmers Market');
  assert.ok(filled.includes('vendor_name'));
  assert.ok(summary.warnings.includes('vendor_from_filename'));
});

await test('enrichment: fills null date from filename', () => {
  const header = { vendor_name: 'Test', document_date: null, total_amount: 100, extraction_confidence: 0.9 };
  const summary = { warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary, filename: '25-03-15_Test_100.00.pdf'
  });
  assert.equal(header.document_date, '2025-03-15');
  assert.ok(filled.includes('document_date'));
  assert.ok(summary.warnings.includes('date_from_filename'));
});

await test('enrichment: fills null amount from filename', () => {
  const header = { vendor_name: 'Test', document_date: '2025-03-15', total_amount: null, extraction_confidence: 0.9 };
  const summary = { warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary, filename: '25-03-15_Test_55.00.pdf'
  });
  assert.equal(header.total_amount, 55.00);
  assert.ok(filled.includes('total_amount'));
  assert.ok(summary.warnings.includes('amount_from_filename'));
});

await test('enrichment: does NOT overwrite existing values', () => {
  const header = { vendor_name: 'Existing Vendor', document_date: '2025-01-01', total_amount: 200, extraction_confidence: 0.95 };
  const summary = { warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary, filename: '25-07-06_Different_Vendor_100.00.pdf'
  });
  assert.equal(header.vendor_name, 'Existing Vendor');
  assert.equal(header.document_date, '2025-01-01');
  assert.equal(header.total_amount, 200);
  assert.equal(filled.length, 0);
});

await test('enrichment: builds vendor_candidates with LLM + filename', () => {
  const header = { vendor_name: 'Stripe Inc', document_date: '2025-01-01', total_amount: 100, extraction_confidence: 0.92 };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary, filename: '25-01-01_Stripe_100.00.pdf'
  });
  assert.ok(Array.isArray(summary.vendor_candidates));
  assert.equal(summary.vendor_candidates.length, 2);
  assert.equal(summary.vendor_candidates[0].value, 'Stripe Inc');
  assert.equal(summary.vendor_candidates[0].source, 'llm_extraction');
  assert.equal(summary.vendor_candidates[0].confidence, 0.9);
  assert.equal(summary.vendor_candidates[1].value, 'Stripe');
  assert.equal(summary.vendor_candidates[1].source, 'filename');
  assert.equal(summary.vendor_candidates[1].confidence, 0.6);
});

await test('enrichment: deduplicates identical vendor values', () => {
  const header = { vendor_name: 'Farmers Market', document_date: null, total_amount: null, extraction_confidence: 0.9 };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary, filename: '25-07-06_Farmers_Market_41.35.pdf'
  });
  assert.equal(summary.vendor_candidates.length, 1);
  assert.equal(summary.vendor_candidates[0].source, 'llm_extraction');
});

await test('enrichment: no candidates array when both LLM and filename are null', () => {
  const header = { vendor_name: null, document_date: null, total_amount: null, extraction_confidence: 0.5 };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({ header, summary, filename: 'random.pdf' });
  assert.equal(summary.vendor_candidates, undefined);
  assert.equal(summary.date_candidates, undefined);
  assert.equal(summary.amount_candidates, undefined);
});

await test('enrichment: filename-only candidate when LLM returned null', () => {
  const header = { vendor_name: null, document_date: null, total_amount: null, extraction_confidence: 0.3 };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary, filename: '25-07-06_Farmers_Market_41.35.pdf'
  });
  assert.ok(Array.isArray(summary.vendor_candidates));
  assert.equal(summary.vendor_candidates.length, 1);
  assert.equal(summary.vendor_candidates[0].source, 'filename');
  assert.equal(summary.vendor_candidates[0].value, 'Farmers Market');
});

await test('enrichment: confidence band reflects extraction_confidence', () => {
  const header = { vendor_name: 'Test', document_date: null, total_amount: null, extraction_confidence: 0.6 };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({ header, summary, filename: '25-01-01_Other_50.00.pdf' });
  assert.equal(summary.vendor_candidates[0].confidence, 0.7);
});

await test('enrichment: handles null header/summary gracefully', () => {
  const result1 = applyPostExtractionEnrichment({ header: null, summary: {}, filename: 'test.pdf' });
  assert.deepEqual(result1, { filled: [] });
  const result2 = applyPostExtractionEnrichment({ header: {}, summary: null, filename: 'test.pdf' });
  assert.deepEqual(result2, { filled: [] });
});

await test('enrichment: all three fields filled from filename at once', () => {
  const header = { vendor_name: null, document_date: null, total_amount: null, extraction_confidence: 0.3 };
  const summary = { warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary, filename: '25-06-04_Dadant_120.77.pdf'
  });
  assert.equal(header.vendor_name, 'Dadant');
  assert.equal(header.document_date, '2025-06-04');
  assert.equal(header.total_amount, 120.77);
  assert.equal(filled.length, 3);
  assert.ok(summary.vendor_candidates.length >= 1);
  assert.ok(summary.date_candidates.length >= 1);
  assert.ok(summary.amount_candidates.length >= 1);
});

// --- isDayMonthSwap ---

await test('isDayMonthSwap: classic MM↔DD transposition', () => {
  // The production Domino's bug: filename '2026-04-05', LLM '2026-05-04'.
  assert.equal(isDayMonthSwap('2026-05-04', '2026-04-05'), true);
  assert.equal(isDayMonthSwap('2026-04-05', '2026-05-04'), true);
});

await test('isDayMonthSwap: identical dates are not a swap', () => {
  assert.equal(isDayMonthSwap('2026-05-05', '2026-05-05'), false,
    'same month and same day is not a transposition');
  assert.equal(isDayMonthSwap('2026-04-04', '2026-04-04'), false);
});

await test('isDayMonthSwap: different years never count as a swap', () => {
  assert.equal(isDayMonthSwap('2025-05-04', '2026-04-05'), false);
});

await test('isDayMonthSwap: different days (not a transposition) are not a swap', () => {
  // 2026-05-04 swapped would be 2026-04-05 — but here we test 2026-05-15
  // which has no valid swap to 2026-04-05.
  assert.equal(isDayMonthSwap('2026-05-15', '2026-04-05'), false);
});

await test('isDayMonthSwap: swap that would produce an invalid date returns false', () => {
  // 2026-02-30 → swap to 2026-30-02. Both must be calendar-valid;
  // 2026-30-02 isn't. So the swap is rejected.
  assert.equal(isDayMonthSwap('2026-02-30', '2026-30-02'), false);
  // Also, the parser must reject the malformed input — 2026-02-30 is
  // itself not a real date.
  assert.equal(isDayMonthSwap('2026-30-02', '2026-02-30'), false);
});

await test('isDayMonthSwap: null/empty inputs return false', () => {
  assert.equal(isDayMonthSwap(null, '2026-04-05'), false);
  assert.equal(isDayMonthSwap('2026-04-05', null), false);
  assert.equal(isDayMonthSwap('', ''), false);
});

await test('isDayMonthSwap: only ISO YYYY-MM-DD format is recognised', () => {
  assert.equal(isDayMonthSwap('2026/05/04', '2026/04/05'), false,
    'slash-separated dates are not the canonical input form');
  assert.equal(isDayMonthSwap('05-04-2026', '04-05-2026'), false);
});

// --- isYearMisreadSwap ---

await test('isYearMisreadSwap: classic Chevron case — YY-prefix misread', () => {
  // The production case: filename `25-08-19_Chevron_26.83.pdf` →
  // 2025-08-19; LLM read the receipt's "08/19/13" as 2013-08-19.
  // Twelve-year gap, exact MM/DD agreement.
  assert.equal(isYearMisreadSwap('2025-08-19', '2013-08-19'), true);
  assert.equal(isYearMisreadSwap('2013-08-19', '2025-08-19'), true,
    'symmetric — arg order does not matter');
});

await test('isYearMisreadSwap: identical dates are not a misread', () => {
  assert.equal(isYearMisreadSwap('2025-08-19', '2025-08-19'), false);
});

await test('isYearMisreadSwap: same year (different MM/DD) is not a misread', () => {
  assert.equal(isYearMisreadSwap('2025-08-19', '2025-09-20'), false);
});

await test('isYearMisreadSwap: year gap below threshold returns false', () => {
  // 1-year gap — the LLM might be reading an issue date vs the
  // filename's due date. Not the bug shape we're catching.
  assert.equal(isYearMisreadSwap('2025-08-19', '2024-08-19'), false);
  // 9-year gap — just under the 10-year threshold.
  assert.equal(isYearMisreadSwap('2025-08-19', '2016-08-19'), false);
});

await test('isYearMisreadSwap: 10-year gap exactly meets threshold', () => {
  assert.equal(isYearMisreadSwap('2025-08-19', '2015-08-19'), true);
  assert.equal(isYearMisreadSwap('2025-08-19', '2035-08-19'), true,
    'gap is absolute — future-misread also qualifies');
});

await test('isYearMisreadSwap: same year-gap but different MM returns false', () => {
  // 12-year gap, but the months disagree — not a year-misread; some
  // other extraction error.
  assert.equal(isYearMisreadSwap('2025-08-19', '2013-07-19'), false);
});

await test('isYearMisreadSwap: same year-gap but different DD returns false', () => {
  assert.equal(isYearMisreadSwap('2025-08-19', '2013-08-20'), false);
});

await test('isYearMisreadSwap: invalid calendar dates are rejected', () => {
  // Feb 29 only valid in leap years. 2024 is leap; 2013 is not.
  assert.equal(isYearMisreadSwap('2024-02-29', '2013-02-29'), false,
    '2013-02-29 is not a real date even though the regex shape matches');
  // Both sides leap years, 12-year gap → real misread.
  assert.equal(isYearMisreadSwap('2024-02-29', '2012-02-29'), true);
});

await test('isYearMisreadSwap: null/empty inputs return false', () => {
  assert.equal(isYearMisreadSwap(null, '2013-08-19'), false);
  assert.equal(isYearMisreadSwap('2025-08-19', null), false);
  assert.equal(isYearMisreadSwap('', ''), false);
});

await test('isYearMisreadSwap: only ISO YYYY-MM-DD format is recognised', () => {
  assert.equal(isYearMisreadSwap('2025/08/19', '2013/08/19'), false);
  assert.equal(isYearMisreadSwap('08-19-2025', '08-19-2013'), false);
});

// --- date_corrected_from_filename_swap path ---

await test('enrichment: Domino\'s bug — LLM MM/DD reading corrected by filename swap', () => {
  // Filename hint: 2026-04-05. LLM extracted: 2026-05-04. The
  // mismatch is exactly an MM↔DD swap, so the enrichment overrides
  // and warns.
  const header = {
    vendor_name: 'Dominos',
    document_date: '2026-05-04',
    total_amount: 18.99,
    extraction_confidence: 0.85
  };
  const summary = { warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary,
    filename: '05_2026-04-05_Dominos_receipt.pdf'
  });
  assert.equal(header.document_date, '2026-04-05',
    'filename date wins on day-month transposition');
  assert.ok(filled.includes('document_date'));
  assert.ok(summary.warnings.includes('date_corrected_from_filename_swap'));
  // Audit trail preserves the original LLM reading + the override
  // reason so the firm can investigate.
  const llmCandidate = summary.date_candidates.find((c) => c.source === 'llm_extraction');
  assert.ok(llmCandidate, 'LLM candidate still present in audit trail');
  assert.equal(llmCandidate.value, '2026-05-04', 'original LLM reading preserved');
  assert.equal(llmCandidate.overridden, true);
  assert.equal(llmCandidate.override_reason, 'filename_dd_mm_swap');
});

await test('enrichment: non-swap mismatch keeps LLM date and warns for review', () => {
  // LLM says May 4, filename says April 3 — not a transposition; the
  // LLM might be reading a different date field than the filename
  // was named after. Don't override; flag for review.
  const header = {
    vendor_name: 'Acme',
    document_date: '2026-05-04',
    total_amount: 25.00,
    extraction_confidence: 0.85
  };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '2026-04-03_Acme_25.00.pdf'
  });
  assert.equal(header.document_date, '2026-05-04', 'LLM date preserved on non-swap mismatch');
  assert.ok(summary.warnings.includes('date_filename_mismatch'));
  assert.equal(summary.warnings.includes('date_corrected_from_filename_swap'), false);
});

await test('enrichment: matching dates produce no warning', () => {
  const header = {
    vendor_name: 'Acme',
    document_date: '2026-04-05',
    total_amount: 18.99,
    extraction_confidence: 0.85
  };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '2026-04-05_Acme_18.99.pdf'
  });
  assert.equal(header.document_date, '2026-04-05');
  assert.equal(summary.warnings.includes('date_filename_mismatch'), false);
  assert.equal(summary.warnings.includes('date_corrected_from_filename_swap'), false);
});

// --- date_corrected_from_filename_year_swap path ---

await test('enrichment: Chevron bug — LLM YY-misread corrected by filename year', () => {
  // Production case: filename `25-08-19_Chevron_26.83.pdf` (→ 2025-08-19);
  // LLM read the receipt's "08/19/13" as 2013-08-19. Twelve-year gap
  // with exact MM/DD agreement — the YY-misread signature.
  const header = {
    vendor_name: 'Chevron',
    document_date: '2013-08-19',
    total_amount: 26.83,
    extraction_confidence: 0.78
  };
  const summary = { warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary,
    filename: '25-08-19_Chevron_26.83.pdf'
  });
  assert.equal(header.document_date, '2025-08-19',
    'filename year wins on YY-misread');
  assert.ok(filled.includes('document_date'));
  assert.ok(summary.warnings.includes('date_corrected_from_filename_year_swap'));
  assert.equal(summary.warnings.includes('date_filename_mismatch'), false,
    'specific override warning replaces the generic mismatch warning');
  // Audit trail preserves the original LLM reading + the override
  // reason so the firm can investigate.
  const llmCandidate = summary.date_candidates.find((c) => c.source === 'llm_extraction');
  assert.ok(llmCandidate, 'LLM candidate still present in audit trail');
  assert.equal(llmCandidate.value, '2013-08-19', 'original LLM reading preserved');
  assert.equal(llmCandidate.overridden, true);
  assert.equal(llmCandidate.override_reason, 'filename_year_swap');
});

await test('enrichment: small year disagreement (1y) still warns mismatch, no override', () => {
  // Regression guard: a 1-year disagreement could legitimately be an
  // issue-date vs due-date situation. Don't override; flag for review.
  const header = {
    vendor_name: 'Acme',
    document_date: '2024-08-19',
    total_amount: 100.00,
    extraction_confidence: 0.85
  };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '25-08-19_Acme_100.00.pdf'
  });
  assert.equal(header.document_date, '2024-08-19',
    'LLM date preserved when year gap is below threshold');
  assert.ok(summary.warnings.includes('date_filename_mismatch'));
  assert.equal(summary.warnings.includes('date_corrected_from_filename_year_swap'), false);
});

await test('enrichment: year-misread and day-month swap warnings are mutually exclusive', () => {
  // Sanity check: the Chevron path emits only the year-swap warning,
  // never the dd-mm-swap one (the two predicates can't both be true on
  // the same input because matching MM/DD precludes any swap, but the
  // call-site control flow is the contract worth pinning).
  const header = {
    vendor_name: 'Chevron',
    document_date: '2013-08-19',
    total_amount: 26.83,
    extraction_confidence: 0.78
  };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '25-08-19_Chevron_26.83.pdf'
  });
  assert.equal(summary.warnings.includes('date_corrected_from_filename_swap'), false);
});

// --- direction-aware enrichment for AR documents ---
//
// Rent receipts and sales invoices are AR documents: the firm IS the
// vendor (vendor_name=null is structurally correct), and the filename
// party is only a provenance candidate. Earlier enrichment first wrote it
// into vendor_name, then into customer_name; neither may override an
// extractor that could not identify the buyer.

await test('enrichment AR: retains filename party as candidate without filling customer_name', () => {
  const header = {
    vendor_name: null,
    customer_name: null,
    document_date: '2026-03-15',
    total_amount: 1450,
    extraction_confidence: 0.9
  };
  const summary = { document_type: 'issued_receipt', warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary,
    filename: '01_2026-03-15_Foxbury_rent_receipt.pdf'
  });
  assert.equal(header.vendor_name, null);
  assert.equal(header.customer_name, null);
  assert.equal(filled.includes('customer_name'), false);
  assert.deepEqual(summary.customer_candidates, [{ value: 'Foxbury Rent', source: 'filename', confidence: 0.6 }]);
  assert.equal(filled.includes('vendor_name'), false);
  assert.equal(summary.warnings.includes('customer_from_filename'), false);
  assert.equal(summary.warnings.includes('vendor_from_filename'), false);
});

await test('enrichment AR: does not overwrite an existing customer_name', () => {
  const header = {
    vendor_name: null,
    customer_name: 'Alex Morgan',
    document_date: '2026-03-15',
    total_amount: 1450,
    extraction_confidence: 0.9
  };
  const summary = { document_type: 'sales_invoice', warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '01_2026-03-15_Foxbury_rent_receipt.pdf'
  });
  assert.equal(header.customer_name, 'Alex Morgan');
  assert.equal(header.vendor_name, null);
});

await test('enrichment AR: emits customer_candidates, not vendor_candidates', () => {
  const header = {
    vendor_name: null,
    customer_name: null,
    document_date: '2026-03-15',
    total_amount: 1450,
    extraction_confidence: 0.9
  };
  const summary = { document_type: 'issued_receipt', warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '01_2026-03-15_Foxbury_rent_receipt.pdf'
  });
  assert.equal(summary.vendor_candidates, undefined);
  assert.ok(Array.isArray(summary.customer_candidates));
  assert.equal(summary.customer_candidates[0].value, 'Foxbury Rent');
  assert.equal(summary.customer_candidates[0].source, 'filename');
});

await test('enrichment AR: customer_candidates includes existing LLM-extracted customer_name', () => {
  const header = {
    vendor_name: null,
    customer_name: 'Alex Morgan',
    document_date: '2026-03-15',
    total_amount: 1450,
    extraction_confidence: 0.92
  };
  const summary = { document_type: 'sales_invoice', warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '01_2026-03-15_Foxbury_rent_receipt.pdf'
  });
  assert.equal(summary.vendor_candidates, undefined);
  assert.ok(Array.isArray(summary.customer_candidates));
  assert.equal(summary.customer_candidates.length, 2);
  assert.equal(summary.customer_candidates[0].source, 'llm_extraction');
  assert.equal(summary.customer_candidates[0].value, 'Alex Morgan');
  assert.equal(summary.customer_candidates[1].source, 'filename');
  assert.equal(summary.customer_candidates[1].value, 'Foxbury Rent');
});

await test('enrichment AR: date and amount enrichment still fires for AR docs', () => {
  const header = {
    vendor_name: null,
    customer_name: null,
    document_date: null,
    total_amount: null,
    extraction_confidence: 0.3
  };
  const summary = { document_type: 'issued_receipt', warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary,
    filename: '25-03-15_Foxbury_1450.00.pdf'
  });
  assert.equal(header.document_date, '2025-03-15');
  assert.equal(header.total_amount, 1450);
  assert.ok(filled.includes('document_date'));
  assert.ok(filled.includes('total_amount'));
});

await test('enrichment AP: unchanged behaviour when document_type is supplier_bill', () => {
  // Regression guard: the direction switch must not affect the AP path.
  const header = { vendor_name: null, document_date: null, total_amount: null, extraction_confidence: 0.3 };
  const summary = { document_type: 'supplier_bill', warnings: [] };
  const { filled } = applyPostExtractionEnrichment({
    header, summary,
    filename: '25-03-15_Acme_Supplies_500.00.pdf'
  });
  assert.equal(header.vendor_name, 'Acme Supplies');
  assert.ok(filled.includes('vendor_name'));
  assert.ok(summary.warnings.includes('vendor_from_filename'));
  assert.ok(Array.isArray(summary.vendor_candidates));
  assert.equal(summary.customer_candidates, undefined);
});

await test('enrichment: missing document_type defaults to AP behaviour (back-compat)', () => {
  // Older callers / older parse_summary payloads that don't set
  // document_type must keep working as before — vendor_name fill.
  const header = { vendor_name: null, document_date: null, total_amount: null, extraction_confidence: 0.3 };
  const summary = { warnings: [] };
  applyPostExtractionEnrichment({
    header, summary,
    filename: '25-03-15_Acme_500.00.pdf'
  });
  assert.equal(header.vendor_name, 'Acme');
  assert.ok(Array.isArray(summary.vendor_candidates));
});
