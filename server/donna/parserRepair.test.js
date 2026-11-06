// Unit tests for the parser repair loop (parserRepair.js).
//
// Uses the __callOpenAi injection hook to supply canned LLM responses
// without network calls — same pattern as receipt.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  repairMissingFields,
  __buildRepairPrompt,
  __buildRepairSchema,
  __DEFAULT_MODEL,
  __REQUEST_TIMEOUT_MS
} from './parserRepair.js';

test('default repair model is the strong tier, not nano (Failure A anti-pattern)', () => {
  assert.equal(__DEFAULT_MODEL, 'gpt-5.4');
  assert.ok(!__DEFAULT_MODEL.includes('nano'));
});

// ── Helpers ──

const mockOpenAiResponse = (parsed, { status = 200, throwOnJson = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (throwOnJson) throw new Error('not json');
    return {
      output: [
        {
          content: [{ text: JSON.stringify(parsed) }]
        }
      ]
    };
  }
});

const makeHeader = (overrides = {}) => ({
  vendor_name: null,
  document_date: null,
  total_amount: null,
  currency: 'SGD',
  tax_amount: null,
  reference_number: null,
  payment_status: 'paid',
  extraction_confidence: 0.85,
  ...overrides
});

const makeSummary = (overrides = {}) => ({
  source: 'async_parse',
  document_type: 'receipt',
  warnings: [],
  ...overrides
});

const ORIGINAL_REPAIR_FLAG = process.env.PARSER_REPAIR_ENABLED;
const ORIGINAL_API_KEY = process.env.OPENAI_API_KEY;

// Enable the feature flag for most tests; individual tests that check
// the gate will override.
const enableRepair = () => {
  process.env.PARSER_REPAIR_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'test-key';
};

const restoreEnv = () => {
  if (ORIGINAL_REPAIR_FLAG === undefined) delete process.env.PARSER_REPAIR_ENABLED;
  else process.env.PARSER_REPAIR_ENABLED = ORIGINAL_REPAIR_FLAG;
  if (ORIGINAL_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_API_KEY;
};

// ── Gate tests ──

await test('returns early (no LLM call) when PARSER_REPAIR_ENABLED is not set', async () => {
  delete process.env.PARSER_REPAIR_ENABLED;
  process.env.OPENAI_API_KEY = 'test-key';
  let called = false;
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'receipt',
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(result.repaired, false);
  assert.deepEqual(result.repairedFields, []);
  assert.equal(called, false);
  restoreEnv();
});

// Batch-2 Slice B (docs/donna-batch2-extractor-cluster-plane-wiring-plan.md):
// the gate is DB-first — a PARSER_REPAIR_ENABLED config row decides when
// present; the strict-'true' env check is the byte-identical no-row fallback
// (pinned by the gate tests above/below, untouched).

await test('a DB canary row enables repair with NO env (prod-shaped case)', async () => {
  delete process.env.PARSER_REPAIR_ENABLED;
  process.env.OPENAI_API_KEY = 'test-key';
  let called = false;
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'receipt',
    configSnapshot: { PARSER_REPAIR_ENABLED: { stage: 'canary' } },
    __callOpenAi: async () => {
      called = true;
      return mockOpenAiResponse({ vendor_name: 'Acme Corp', document_date: '2026-01-15', total_amount: 42.5 });
    }
  });
  assert.equal(called, true, 'DB row opens the gate without any env');
  assert.equal(result.repaired, true);
  restoreEnv();
});

await test('a DB off row wins over PARSER_REPAIR_ENABLED=true (no LLM call)', async () => {
  enableRepair();
  let called = false;
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'receipt',
    configSnapshot: { PARSER_REPAIR_ENABLED: { stage: 'off' } },
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(called, false, 'an explicit off row outranks the env flag');
  assert.equal(result.repaired, false);
  restoreEnv();
});

await test('returns early when all critical fields are present', async () => {
  enableRepair();
  let called = false;
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader({
      vendor_name: 'Acme Corp',
      document_date: '2026-01-15',
      total_amount: 100.00
    }),
    summary: makeSummary(),
    documentType: 'receipt',
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(result.repaired, false);
  assert.equal(called, false);
  restoreEnv();
});

await test('returns early for unsupported document types: sales_invoice', async () => {
  enableRepair();
  let called = false;
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'sales_invoice',
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(result.repaired, false);
  assert.equal(called, false);
  restoreEnv();
});

await test('returns early for unsupported document types: bank_statement', async () => {
  enableRepair();
  let called = false;
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'bank_statement',
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(result.repaired, false);
  assert.equal(called, false);
  restoreEnv();
});

await test('returns early for unsupported document types: contract', async () => {
  enableRepair();
  let called = false;
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'contract',
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(result.repaired, false);
  assert.equal(called, false);
  restoreEnv();
});

await test('returns early when base64 is empty', async () => {
  enableRepair();
  let called = false;
  const result = await repairMissingFields({
    base64: '',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'receipt',
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(result.repaired, false);
  assert.equal(called, false);
  restoreEnv();
});

await test('returns early when base64 is null/undefined', async () => {
  enableRepair();
  let called = false;
  const result = await repairMissingFields({
    base64: null,
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header: makeHeader(),
    summary: makeSummary(),
    documentType: 'receipt',
    __callOpenAi: async () => { called = true; return mockOpenAiResponse({}); }
  });
  assert.equal(result.repaired, false);
  assert.equal(called, false);
  restoreEnv();
});

// ── LLM call and prompt tests ──

await test('calls LLM with only the missing fields in the prompt', async () => {
  enableRepair();
  let capturedArgs = null;
  const header = makeHeader({ vendor_name: 'Existing Vendor' }); // date + amount missing
  await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary: makeSummary(),
    documentType: 'receipt',
    __callOpenAi: async (args) => {
      capturedArgs = args;
      return mockOpenAiResponse({ document_date: '2026-03-01', total_amount: 55.00 });
    }
  });
  assert.ok(capturedArgs !== null, 'LLM should have been called');
  assert.deepEqual(capturedArgs.missingFields, ['document_date', 'total_amount']);
  assert.ok(capturedArgs.signal instanceof AbortSignal);
  restoreEnv();
});

// ── Field repair tests ──

await test('fills vendor_name when repaired (does not touch existing date/amount)', async () => {
  enableRepair();
  const header = makeHeader({
    document_date: '2026-01-15',
    total_amount: 100.00
  });
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ vendor_name: 'Repaired Corp' })
  });
  assert.equal(result.repaired, true);
  assert.deepEqual(result.repairedFields, ['vendor_name']);
  assert.equal(header.vendor_name, 'Repaired Corp');
  // Existing fields untouched
  assert.equal(header.document_date, '2026-01-15');
  assert.equal(header.total_amount, 100.00);
  restoreEnv();
});

await test('fills document_date when repaired', async () => {
  enableRepair();
  const header = makeHeader({
    vendor_name: 'Existing',
    total_amount: 50.00
  });
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ document_date: '2026-05-20' })
  });
  assert.equal(result.repaired, true);
  assert.deepEqual(result.repairedFields, ['document_date']);
  assert.equal(header.document_date, '2026-05-20');
  restoreEnv();
});

await test('fills total_amount when repaired', async () => {
  enableRepair();
  const header = makeHeader({
    vendor_name: 'Existing',
    document_date: '2026-01-01'
  });
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ total_amount: 123.45 })
  });
  assert.equal(result.repaired, true);
  assert.deepEqual(result.repairedFields, ['total_amount']);
  assert.equal(header.total_amount, 123.45);
  restoreEnv();
});

await test('adds candidates with source llm_repair and confidence 0.65', async () => {
  enableRepair();
  const header = makeHeader();
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({
      vendor_name: 'New Vendor',
      document_date: '2026-04-10',
      total_amount: 77.77
    })
  });
  assert.equal(result.repaired, true);
  assert.equal(result.repairedFields.length, 3);

  // Check returned candidates
  assert.ok(result.candidates.vendor_candidates);
  assert.equal(result.candidates.vendor_candidates[0].source, 'llm_repair');
  assert.equal(result.candidates.vendor_candidates[0].confidence, 0.65);
  assert.equal(result.candidates.vendor_candidates[0].value, 'New Vendor');

  assert.ok(result.candidates.date_candidates);
  assert.equal(result.candidates.date_candidates[0].source, 'llm_repair');
  assert.equal(result.candidates.date_candidates[0].confidence, 0.65);
  assert.equal(result.candidates.date_candidates[0].value, '2026-04-10');

  assert.ok(result.candidates.amount_candidates);
  assert.equal(result.candidates.amount_candidates[0].source, 'llm_repair');
  assert.equal(result.candidates.amount_candidates[0].confidence, 0.65);
  assert.equal(result.candidates.amount_candidates[0].value, 77.77);

  // Check summary candidates were also set
  assert.ok(Array.isArray(summary.vendor_candidates));
  assert.equal(summary.vendor_candidates[0].source, 'llm_repair');
  assert.ok(Array.isArray(summary.date_candidates));
  assert.equal(summary.date_candidates[0].source, 'llm_repair');
  assert.ok(Array.isArray(summary.amount_candidates));
  assert.equal(summary.amount_candidates[0].source, 'llm_repair');
  restoreEnv();
});

await test('appends to existing candidate arrays rather than replacing', async () => {
  enableRepair();
  const header = makeHeader();
  const existingVendorCandidate = { value: 'Filename Vendor', source: 'filename', confidence: 0.6 };
  const summary = makeSummary({
    vendor_candidates: [existingVendorCandidate]
  });
  await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({
      vendor_name: 'Repaired Vendor',
      document_date: null,
      total_amount: null
    })
  });
  assert.equal(summary.vendor_candidates.length, 2);
  assert.equal(summary.vendor_candidates[0].source, 'filename');
  assert.equal(summary.vendor_candidates[1].source, 'llm_repair');
  restoreEnv();
});

await test('does not overwrite existing non-null fields', async () => {
  enableRepair();
  // Only vendor_name is missing; date and amount are present.
  // LLM returns values for all three — only vendor should be applied.
  const header = makeHeader({
    document_date: '2026-01-01',
    total_amount: 200.00
  });
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ vendor_name: 'Fixed Vendor' })
  });
  assert.equal(header.vendor_name, 'Fixed Vendor');
  assert.equal(header.document_date, '2026-01-01');
  assert.equal(header.total_amount, 200.00);
  assert.deepEqual(result.repairedFields, ['vendor_name']);
  restoreEnv();
});

// ── Graceful failure tests ──

await test('returns gracefully on LLM failure (network error)', async () => {
  enableRepair();
  const header = makeHeader();
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(result.repaired, false);
  assert.deepEqual(result.repairedFields, []);
  // Header should be untouched
  assert.equal(header.vendor_name, null);
  assert.equal(header.document_date, null);
  assert.equal(header.total_amount, null);
  restoreEnv();
});

await test('returns gracefully on LLM returning invalid JSON', async () => {
  enableRepair();
  const header = makeHeader();
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ content: [{ text: 'NOT VALID JSON {{{' }] }]
      })
    })
  });
  assert.equal(result.repaired, false);
  assert.deepEqual(result.repairedFields, []);
  restoreEnv();
});

await test('returns gracefully on LLM returning null for all requested fields', async () => {
  enableRepair();
  const header = makeHeader();
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({
      vendor_name: null,
      document_date: null,
      total_amount: null
    })
  });
  assert.equal(result.repaired, false);
  assert.deepEqual(result.repairedFields, []);
  // Header stays null
  assert.equal(header.vendor_name, null);
  assert.equal(header.document_date, null);
  assert.equal(header.total_amount, null);
  restoreEnv();
});

await test('returns gracefully on response.json() throwing', async () => {
  enableRepair();
  const header = makeHeader();
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({}, { throwOnJson: true })
  });
  assert.equal(result.repaired, false);
  assert.deepEqual(result.repairedFields, []);
  restoreEnv();
});

await test('returns gracefully on non-OK HTTP status', async () => {
  enableRepair();
  const header = makeHeader();
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({}, { status: 500 })
  });
  assert.equal(result.repaired, false);
  assert.deepEqual(result.repairedFields, []);
  restoreEnv();
});

// ── Warning tests ──

await test('adds repaired_vendor_name to summary.warnings', async () => {
  enableRepair();
  const header = makeHeader({ document_date: '2026-01-01', total_amount: 50 });
  const summary = makeSummary({ warnings: ['existing_warning'] });
  await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ vendor_name: 'Repaired' })
  });
  assert.ok(summary.warnings.includes('repaired_vendor_name'));
  assert.ok(summary.warnings.includes('existing_warning'));
  restoreEnv();
});

await test('adds repaired_document_date to summary.warnings', async () => {
  enableRepair();
  const header = makeHeader({ vendor_name: 'Existing', total_amount: 50 });
  const summary = makeSummary();
  await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ document_date: '2026-03-15' })
  });
  assert.ok(summary.warnings.includes('repaired_document_date'));
  restoreEnv();
});

await test('adds repaired_total_amount to summary.warnings', async () => {
  enableRepair();
  const header = makeHeader({ vendor_name: 'Existing', document_date: '2026-01-01' });
  const summary = makeSummary();
  await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ total_amount: 99.99 })
  });
  assert.ok(summary.warnings.includes('repaired_total_amount'));
  restoreEnv();
});

// ── Timeout test ──

await test('uses 30s timeout (not 60s)', () => {
  assert.equal(__REQUEST_TIMEOUT_MS, 30_000);
});

// ── Supplier bill support ──

await test('works for supplier_bill document type', async () => {
  enableRepair();
  const header = makeHeader();
  const summary = makeSummary({ document_type: 'supplier_bill' });
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'bill.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'supplier_bill',
    __callOpenAi: async () => mockOpenAiResponse({
      vendor_name: 'Bill Vendor',
      document_date: '2026-02-28',
      total_amount: 500.00
    })
  });
  assert.equal(result.repaired, true);
  assert.equal(result.repairedFields.length, 3);
  assert.equal(header.vendor_name, 'Bill Vendor');
  assert.equal(header.document_date, '2026-02-28');
  assert.equal(header.total_amount, 500.00);
  restoreEnv();
});

// ── Schema and prompt helpers ──

await test('buildRepairSchema includes only the requested fields', () => {
  const schema = __buildRepairSchema(['vendor_name', 'total_amount']);
  assert.deepEqual(schema.required, ['vendor_name', 'total_amount']);
  assert.ok(schema.properties.vendor_name);
  assert.ok(schema.properties.total_amount);
  assert.equal(schema.properties.document_date, undefined);
  assert.equal(schema.additionalProperties, false);
});

await test('buildRepairPrompt mentions missing fields and filename', () => {
  const prompt = __buildRepairPrompt(['vendor_name', 'document_date'], 'myfile.pdf');
  assert.ok(prompt.includes('could not be extracted on the first pass'));
  assert.ok(prompt.includes('vendor_name'));
  assert.ok(prompt.includes('document_date'));
  assert.ok(prompt.includes('myfile.pdf'));
  // Should NOT mention total_amount since it's not in missingFields
  assert.ok(!prompt.includes('total_amount'));
});

// ── Date normalization ──

await test('normalizes repaired date to ISO format and rejects bad dates', async () => {
  enableRepair();
  const header = makeHeader({ vendor_name: 'V', total_amount: 10 });
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ document_date: 'not-a-date' })
  });
  assert.equal(result.repaired, false);
  assert.equal(header.document_date, null);
  restoreEnv();
});

await test('rejects non-finite total_amount from repair', async () => {
  enableRepair();
  const header = makeHeader({ vendor_name: 'V', document_date: '2026-01-01' });
  const summary = makeSummary();
  const result = await repairMissingFields({
    base64: 'AAAA',
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    header,
    summary,
    documentType: 'receipt',
    __callOpenAi: async () => mockOpenAiResponse({ total_amount: 'not-a-number' })
  });
  assert.equal(result.repaired, false);
  assert.equal(header.total_amount, null);
  restoreEnv();
});
