// Smoke tests for the inline parse runner. The drain task in
// /documents/parse-cron uses `runParseInline` to execute the worker
// without going through Inngest's runtime — these tests pin the
// public shape so an accidental signature change is caught.
//
// PR 1 of docs/invoice-receipt-parsing-plan.md adds extractDocument
// receipt-path coverage at the unit level (DB writes are covered in
// parseDocumentsDb.test.js, error categorisation in parseErrors.test.js,
// extractor shape in receipt.test.js). The tests below pin the glue
// between those pieces: pickExtractor's feature-flag gating, and
// extractDocument's discriminated-union output for the receipt branch.

import assert from 'node:assert/strict';

import { Buffer } from 'node:buffer';

import {
  pickExtractor,
  runParseInline,
  __test__extractDocument,
  __applyUnifiedTypeDecision,
  buildExtractorReceipt,
  buildJurisdictionSignalFromStatement,
  buildStatementPayloadPatch,
  __buildClassification,
  withTimeout,
  loadRequiredConfigSnapshot,
  ContextLoadTimeoutError,
  directionForDocumentType
} from './parseDocument.js';
import { ParseError, categorizeError } from './parseErrors.js';
import { extractBankStatementFromBase64 } from '../bankStatement.js';
import { extractReceiptFromBase64 } from '../receipt.js';
import { extractSupplierBillFromBase64 } from '../supplierBill.js';
import { extractPayoutStatementFromBase64 } from '../payoutStatement.js';
import { extractSalesInvoiceFromBase64 } from '../salesInvoice.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  return Promise.resolve()
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
};

const withDocumentExtractorsFlag = async (value, fn) => {
  const original = process.env.DOCUMENT_EXTRACTORS_ENABLED;
  if (value === undefined) delete process.env.DOCUMENT_EXTRACTORS_ENABLED;
  else process.env.DOCUMENT_EXTRACTORS_ENABLED = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.DOCUMENT_EXTRACTORS_ENABLED;
    else process.env.DOCUMENT_EXTRACTORS_ENABLED = original;
  }
};

const withDocumentLinesFlag = async (value, fn) => {
  const original = process.env.DOCUMENT_LINES_ENABLED;
  if (value === undefined) delete process.env.DOCUMENT_LINES_ENABLED;
  else process.env.DOCUMENT_LINES_ENABLED = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.DOCUMENT_LINES_ENABLED;
    else process.env.DOCUMENT_LINES_ENABLED = original;
  }
};

// Build a pickExtractor stub that hands back the supplied descriptor
// regardless of the document type. Lets extractDocument tests assert
// on the glue without depending on the env flag or the real
// extractors' implementations.
const stubPickExtractor = (descriptor) => () => descriptor;

const fakeReceiptDocument = {
  id: 'doc-receipt',
  document_type: 'receipt',
  filename: 'starbucks.pdf',
  client_id: 'client-1',
  payload: { mime_type: 'application/pdf' }
};

const validHeader = {
  vendor_name: 'Acme Coffee Roasters',
  customer_name: null,
  document_date: '2026-04-30',
  total_amount: 13.63,
  currency: 'SGD',
  tax_amount: 1.13,
  reference_number: 'R-42',
  payment_status: 'paid',
  extraction_confidence: 0.92
};

const validSummary = {
  source: 'async_parse',
  document_type: 'receipt',
  counterparty_name: 'Acme Coffee Roasters',
  counterparty_role: 'vendor',
  document_date: '2026-04-30',
  currency: 'SGD',
  total_amount: 13.63,
  tax_amount: 1.13,
  line_count: 0,
  coded_line_count: 0,
  review_line_count: 0,
  extraction_status: 'validated',
  extraction_confidence: 0.92,
  warnings: []
};

const runTests = async () => {
  console.log('parseDocument (inline runner):');

  await test('runParseInline returns missing_event_fields when firmId is absent', async () => {
    const result = await runParseInline({ documentId: 'd', parseRunId: 'r' });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'missing_event_fields');
  });

  await test('runParseInline returns missing_event_fields when documentId is absent', async () => {
    const result = await runParseInline({ firmId: 'f', parseRunId: 'r' });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'missing_event_fields');
  });

  await test('runParseInline returns missing_event_fields when parseRunId is absent', async () => {
    const result = await runParseInline({ firmId: 'f', documentId: 'd' });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'missing_event_fields');
  });

  await test('runParseInline accepts the documented argument shape', async () => {
    // Sanity-check that the public arg names haven't drifted. We
    // can't drive the full worker here (it would hit the DB), but
    // a successful "missing event fields" early-return proves the
    // argument names line up with the entrypoint.
    const result = await runParseInline({});
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'missing_event_fields');
  });

  // ── pickExtractor (PR 1 dispatch + DOCUMENT_EXTRACTORS_ENABLED) ────

  await test('pickExtractor returns the bank-statement extractor for bank_statement', () => {
    const desc = pickExtractor('bank_statement');
    assert.ok(desc, 'descriptor returned');
    assert.equal(desc.type, 'bank_statement');
    assert.equal(desc.extract, extractBankStatementFromBase64);
  });

  await test('pickExtractor: bank_statement is unaffected by DOCUMENT_EXTRACTORS_ENABLED', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      const desc = pickExtractor('bank_statement');
      assert.ok(desc, 'returned when flag unset');
      assert.equal(desc.type, 'bank_statement');
    });
    await withDocumentExtractorsFlag('false', () => {
      const desc = pickExtractor('bank_statement');
      assert.ok(desc, 'returned when flag explicitly false');
    });
  });

  await test('pickExtractor returns null for receipt when DOCUMENT_EXTRACTORS_ENABLED is unset', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      assert.equal(pickExtractor('receipt'), null);
    });
  });

  await test('pickExtractor returns null for receipt when DOCUMENT_EXTRACTORS_ENABLED=false', async () => {
    await withDocumentExtractorsFlag('false', () => {
      assert.equal(pickExtractor('receipt'), null);
    });
  });

  await test('pickExtractor returns receipt extractor when DOCUMENT_EXTRACTORS_ENABLED=true', async () => {
    await withDocumentExtractorsFlag('true', () => {
      const desc = pickExtractor('receipt');
      assert.ok(desc, 'descriptor returned');
      assert.equal(desc.type, 'receipt');
      assert.equal(desc.extract, extractReceiptFromBase64);
    });
  });

  await test('pickExtractor returns null for unknown document types even with flag on', async () => {
    await withDocumentExtractorsFlag('true', () => {
      assert.equal(pickExtractor('mystery_doc'), null);
    });
  });

  await test('pickExtractor returns the generic extractor for payment_account_statement (no dedicated extractor yet)', async () => {
    // Stage 1 of the payment-account-statement work: the type is
    // first-class so the matcher (Stage 2) can recognise it without
    // re-classifying, but perception runs through the existing
    // generic extractor (LLM-first perception layer). The branch
    // doesn't consult isGenericDocumentExtractorEnabled — the type's
    // own dispatch is the gate, not the generic fallback flag.
    await withDocumentExtractorsFlag('true', () => {
      const desc = pickExtractor('payment_account_statement');
      assert.ok(desc, 'returns a descriptor when extractors are enabled');
      assert.equal(desc.type, 'generic_document');
      assert.equal(typeof desc.extract, 'function');
    });
  });

  await test('pickExtractor returns null for payment_account_statement when DOCUMENT_EXTRACTORS_ENABLED unset', async () => {
    // The new type rides on the doc-type wave kill switch.
    await withDocumentExtractorsFlag(undefined, () => {
      assert.equal(pickExtractor('payment_account_statement'), null);
    });
  });

  await test('pickExtractor returns the generic extractor for payment_confirmation (Stage 2.5)', async () => {
    // Pre-2.5 payment_confirmation had no extractor — the worker
    // marked the doc skipped with extractor_unavailable and only
    // filename-derived header fields landed. Stage 2.5 routes through
    // generic so the PDF body is actually read; the matcher reads the
    // resulting total_amount / vendor_name / document_date.
    await withDocumentExtractorsFlag('true', () => {
      const desc = pickExtractor('payment_confirmation');
      assert.ok(desc);
      assert.equal(desc.type, 'generic_document');
      assert.equal(typeof desc.extract, 'function');
    });
  });

  await test('pickExtractor returns null for payment_confirmation when DOCUMENT_EXTRACTORS_ENABLED unset', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      assert.equal(pickExtractor('payment_confirmation'), null);
    });
  });

  await test('pickExtractor returns the payout extractor for payout_statement AND deposit_slip (RT-18) — one dedicated descriptor type for both', async () => {
    // The family has its own extractor (payoutStatement.js) rather than
    // the generic perception layer, so a routed `unknown` → payout is an
    // upgrade under the perception-downgrade guard, never a downgrade; the
    // dispatched type rides to the extractor in the worker's branch.
    await withDocumentExtractorsFlag('true', () => {
      for (const type of ['payout_statement', 'deposit_slip']) {
        const desc = pickExtractor(type);
        assert.ok(desc, `${type}: descriptor returned`);
        assert.equal(desc.type, 'payout_statement');
        assert.equal(desc.extract, extractPayoutStatementFromBase64);
      }
    });
  });

  await test('pickExtractor returns null for the payout family when DOCUMENT_EXTRACTORS_ENABLED unset', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      assert.equal(pickExtractor('payout_statement'), null);
      assert.equal(pickExtractor('deposit_slip'), null);
    });
  });

  await test('directionForDocumentType: the payout family is incoming (the firm\'s own revenue arriving)', () => {
    assert.equal(directionForDocumentType('payout_statement'), 'incoming');
    assert.equal(directionForDocumentType('deposit_slip'), 'incoming');
  });

  // ── extractDocument: receipt path glue ─────────────────────────────

  await test('extractDocument: receipt returns kind=completed_header on a valid extraction', async () => {
    const result = await __test__extractDocument({
      document: fakeReceiptDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: stubPickExtractor({
        type: 'receipt',
        extract: async () => ({
          kind: 'completed',
          header: validHeader,
          summary: validSummary
        })
      })
    });
    assert.equal(result.kind, 'completed_header');
    assert.deepEqual(result.header, validHeader);
    assert.equal(result.summary.document_type, 'receipt');
    // Extractor returned no `lines` field → worker normalises to 0.
    assert.equal(result.summary.line_count, 0);
    assert.deepEqual(result.lines, [], 'worker always carries a lines[] array on completed_header');
  });

  await test('extractDocument: receipt preserves warnings on partial extractions', async () => {
    const result = await __test__extractDocument({
      document: fakeReceiptDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: stubPickExtractor({
        type: 'receipt',
        extract: async () => ({
          kind: 'completed',
          header: validHeader,
          summary: { ...validSummary, extraction_status: 'partial', warnings: ['tax_amount_illegible'] }
        })
      })
    });
    assert.equal(result.kind, 'completed_header');
    assert.equal(result.summary.extraction_status, 'partial');
    assert.deepEqual(result.summary.warnings, ['tax_amount_illegible']);
  });

  await test('extractDocument: receipt throws ParseError(DOCUMENT_EXTRACTION_FAILED) on retryable extractor failure', async () => {
    let thrown = null;
    try {
      await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'failed',
            code: 'DOCUMENT_EXTRACTION_FAILED',
            reason: 'openai_500',
            // Extractors stamp the provider their lane resolved (2026-11-10).
            provider: 'openai'
          })
        })
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ParseError, 'must throw ParseError');
    assert.equal(thrown.parseErrorCode, 'DOCUMENT_EXTRACTION_FAILED');
    assert.equal(thrown.retryable, true, 'retryable per registry');
    assert.equal(thrown.provider, 'openai');
  });

  await test('extractDocument: receipt throws ParseError(DOCUMENT_EXTRACTION_UNREADABLE) on terminal unreadable', async () => {
    let thrown = null;
    try {
      await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'failed',
            code: 'DOCUMENT_EXTRACTION_UNREADABLE',
            reason: 'low_confidence',
            provider: 'openai'
          })
        })
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ParseError, 'must throw ParseError');
    assert.equal(thrown.parseErrorCode, 'DOCUMENT_EXTRACTION_UNREADABLE');
    assert.equal(thrown.retryable, false, 'terminal per registry');
    assert.equal(thrown.provider, 'openai');
  });

  await test('extractDocument: no extractor → kind=skipped with extractor_unavailable', async () => {
    const result = await __test__extractDocument({
      document: { ...fakeReceiptDocument, document_type: 'mystery_doc' },
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: () => null
    });
    assert.equal(result.kind, 'skipped');
    assert.equal(result.reason, 'extractor_unavailable');
    assert.equal(result.summary.skipped_reason, 'extractor_unavailable');
    assert.equal(result.summary.document_type, 'mystery_doc');
  });

  await test('extractDocument: receipt + flag off behaves identically to "no extractor"', async () => {
    await withDocumentExtractorsFlag('false', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console
        // Use the REAL pickExtractor — confirms the flag actually
        // gates the receipt branch when no test stub is in play.
      });
      assert.equal(result.kind, 'skipped');
      assert.equal(result.reason, 'extractor_unavailable');
    });
  });

  await test('extractDocument: receipt extractor is called with base64 from the buffer', async () => {
    let received = null;
    await __test__extractDocument({
      document: fakeReceiptDocument,
      bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      log: console,
      pickExtractorImpl: stubPickExtractor({
        type: 'receipt',
        extract: async (args) => {
          received = args;
          return { kind: 'completed', header: validHeader, summary: validSummary };
        }
      })
    });
    assert.equal(received.filename, 'starbucks.pdf');
    assert.equal(received.mimeType, 'application/pdf');
    // 0xde 0xad 0xbe 0xef → base64 "3q2+7w==".
    assert.equal(received.base64, Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'));
  });

  // ── PR 2: lines + totals validation + DOCUMENT_LINES_ENABLED ───────

  const validLineSet = [
    { description: 'Latte', quantity: 1, unit_price: 6.25, amount: 6.25, tax_rate: 0.09 },
    { description: 'Croissant', quantity: 1, unit_price: 6.25, amount: 6.25, tax_rate: 0.09 }
  ];

  await test('extractDocument: receipt with lines + DOCUMENT_LINES_ENABLED=true → carries lines, line_count=N', async () => {
    await withDocumentLinesFlag('true', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            // Totals reconcile with these inputs (inclusive: 6.25+6.25=12.5; total 13.63 with 1.13 tax inclusive → wait, lines summed = 12.5, total 13.63 — mismatch of 1.13 means it's tax-EXCLUSIVE).
            summary: {
              ...validSummary,
              subtotal_amount: 12.5,
              line_amounts_include_tax: false,
              line_count: 2
            },
            lines: validLineSet
          })
        })
      });
      assert.equal(result.kind, 'completed_header');
      assert.equal(result.lines.length, 2, 'lines forwarded to writer');
      assert.equal(result.summary.line_count, 2, 'line_count pinned to actual write count');
      assert.equal(result.summary.coded_line_count, 0);
      assert.equal(result.summary.review_line_count, 0, 'reconciling totals → 0 in review');
      assert.ok(
        !(result.summary.warnings || []).includes('amount_mismatch'),
        'no amount_mismatch when totals reconcile'
      );
    });
  });

  await test('extractDocument: DOCUMENT_LINES_ENABLED=false → writer gets lines=[], line_count=0; header still writes', async () => {
    await withDocumentLinesFlag('false', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            summary: { ...validSummary, line_count: 2 },
            lines: validLineSet
          })
        })
      });
      assert.equal(result.kind, 'completed_header', 'header still flows through');
      assert.deepEqual(result.lines, [], 'lines dropped at worker boundary');
      assert.equal(result.summary.line_count, 0, 'summary line_count pinned to 0');
    });
  });

  await test('extractDocument: DOCUMENT_LINES_ENABLED=true while DOCUMENT_EXTRACTORS_ENABLED=false → still skipped (parent flag wins)', async () => {
    await withDocumentExtractorsFlag('false', async () => {
      await withDocumentLinesFlag('true', async () => {
        const result = await __test__extractDocument({
          document: fakeReceiptDocument,
          bytes: Buffer.from('pdf-bytes'),
          log: console
          // Real pickExtractor — confirms the outer flag is the entry point.
        });
        assert.equal(result.kind, 'skipped');
        assert.equal(result.reason, 'extractor_unavailable');
      });
    });
  });

  await test('extractDocument: totals drift > $1 → amount_mismatch warning + review_line_count=N', async () => {
    await withDocumentLinesFlag('true', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            summary: {
              ...validSummary,
              subtotal_amount: 100,
              tax_amount: 9,
              // total claims 200 — drift of 91 against subtotal+tax+lines.
              total_amount: 200,
              line_amounts_include_tax: false,
              line_count: 2
            },
            lines: validLineSet
          })
        })
      });
      assert.ok(
        (result.summary.warnings || []).includes('amount_mismatch'),
        'amount_mismatch warning added'
      );
      assert.equal(result.summary.review_line_count, 2, 'every line forced into review');
      // RT-04 (F-05): the receipt rides with the verdict, not just the token.
      const receipt = result.summary.totals_validation;
      assert.ok(receipt, 'totals_validation persisted on the summary');
      assert.equal(receipt.matches, false);
      assert.equal(receipt.total, 200);
      assert.equal(receipt.expected, 109, 'subtotal 100 + tax 9 (declared exclusive)');
      assert.equal(receipt.drift, 91);
      assert.equal(receipt.strategy, 'declared_tax_exclusive');
      assert.equal(receipt.basis, 'lines');
      assert.equal(receipt.line_sum, 12.5);
    });
  });

  await test('extractDocument: reconciling totals still persist the receipt (strategy recorded on a clean doc)', async () => {
    await withDocumentLinesFlag('true', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            summary: {
              ...validSummary,
              subtotal_amount: 12.5,
              tax_amount: 1.13,
              total_amount: 13.63,
              line_amounts_include_tax: false,
              line_count: 2
            },
            lines: validLineSet
          })
        })
      });
      assert.ok(!(result.summary.warnings || []).includes('amount_mismatch'));
      const receipt = result.summary.totals_validation;
      assert.ok(receipt, 'a clean document carries its receipt too');
      assert.equal(receipt.matches, true);
      assert.equal(receipt.strategy, 'declared_tax_exclusive');
      assert.equal(receipt.drift, 0);
    });
  });

  await test('extractDocument: totals drift ≤ $1 → no warning (tolerance respected)', async () => {
    await withDocumentLinesFlag('true', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            summary: {
              ...validSummary,
              subtotal_amount: 12.5,
              tax_amount: 1.13,
              total_amount: 14.13, // 0.50 drift — within tolerance
              line_amounts_include_tax: false,
              line_count: 2
            },
            lines: validLineSet
          })
        })
      });
      assert.ok(
        !(result.summary.warnings || []).includes('amount_mismatch'),
        'no warning when drift within $1'
      );
      assert.equal(result.summary.review_line_count, 0);
    });
  });

  // ── PR 6: supplier_bill dispatch + worker glue ─────────────────────

  const fakeBillDocument = {
    id: 'doc-bill',
    document_type: 'supplier_bill',
    filename: 'stripe-invoice.pdf',
    client_id: 'client-1',
    payload: { mime_type: 'application/pdf' }
  };

  const validBillHeader = {
    vendor_name: 'Stripe, Inc.',
    customer_name: null,
    document_date: '2026-04-30',
    due_date: '2026-05-30',
    total_amount: 499,
    currency: 'USD',
    tax_amount: 0,
    reference_number: 'INV-2024-001',
    payment_status: 'unpaid',
    extraction_confidence: 0.95
  };

  const validBillSummary = {
    source: 'async_parse',
    document_type: 'supplier_bill',
    counterparty_name: 'Stripe, Inc.',
    counterparty_role: 'vendor',
    document_date: '2026-04-30',
    due_date: '2026-05-30',
    currency: 'USD',
    total_amount: 499,
    tax_amount: 0,
    payment_terms_phrase: 'Net 30',
    payment_terms_days: 30,
    line_count: 0,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: 'validated',
    extraction_confidence: 0.95,
    warnings: []
  };

  await test('pickExtractor returns supplier_bill extractor when DOCUMENT_EXTRACTORS_ENABLED=true', async () => {
    await withDocumentExtractorsFlag('true', () => {
      const desc = pickExtractor('supplier_bill');
      assert.ok(desc, 'descriptor returned');
      assert.equal(desc.type, 'supplier_bill');
      assert.equal(desc.extract, extractSupplierBillFromBase64);
    });
  });

  await test('extractDocument: supplier_bill routes through the bill extractor and returns completed_header', async () => {
    let billCalls = 0;
    let receiptCalls = 0;
    const result = await __test__extractDocument({
      document: fakeBillDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: (docType) => {
        if (docType === 'supplier_bill') {
          return {
            type: 'supplier_bill',
            extract: async () => {
              billCalls += 1;
              return {
                kind: 'completed',
                model: 'served-model',
                header: validBillHeader,
                summary: validBillSummary
              };
            }
          };
        }
        if (docType === 'receipt') {
          return {
            type: 'receipt',
            extract: async () => {
              receiptCalls += 1;
              return { kind: 'completed', header: {}, summary: {} };
            }
          };
        }
        return null;
      }
    });
    assert.equal(billCalls, 1, 'bill extractor invoked');
    assert.equal(receiptCalls, 0, 'receipt extractor NOT invoked');
    assert.equal(result.kind, 'completed_header');
    assert.equal(result.summary.document_type, 'supplier_bill');
    assert.equal(result.summary.payment_terms_days, 30);
    assert.equal(result.header.payment_status, 'unpaid');
    assert.equal(result.extractor_model, 'served-model', 'worker preserves the provider model receipt');
  });

  await test('extractDocument: DOCUMENT_EXTRACTORS_ENABLED=false → supplier_bill skipped (extractor_unavailable)', async () => {
    await withDocumentExtractorsFlag('false', async () => {
      const result = await __test__extractDocument({
        document: fakeBillDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console
        // Real pickExtractor — confirms the kill switch covers bills too.
      });
      assert.equal(result.kind, 'skipped');
      assert.equal(result.reason, 'extractor_unavailable');
      assert.equal(result.summary.document_type, 'supplier_bill');
    });
  });

  await test('extractDocument: bill extractor failure envelope flows through as ParseError unchanged', async () => {
    let thrown = null;
    try {
      await __test__extractDocument({
        document: fakeBillDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'supplier_bill',
          extract: async () => ({
            kind: 'failed',
            code: 'DOCUMENT_EXTRACTION_FAILED',
            reason: 'openai_500',
            // Extractors stamp the provider their lane resolved (2026-11-10).
            provider: 'openai'
          })
        })
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ParseError, 'must throw ParseError');
    assert.equal(thrown.parseErrorCode, 'DOCUMENT_EXTRACTION_FAILED');
    assert.equal(thrown.retryable, true, 'retryable per registry');
    assert.equal(thrown.provider, 'openai');
  });

  await test('extractDocument: supplier_bill + DOCUMENT_LINES_ENABLED=false → lines dropped at worker boundary', async () => {
    await withDocumentLinesFlag('false', async () => {
      const result = await __test__extractDocument({
        document: fakeBillDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'supplier_bill',
          extract: async () => ({
            kind: 'completed',
            header: validBillHeader,
            summary: { ...validBillSummary, line_count: 2 },
            lines: [
              { description: 'A', quantity: 1, unit_price: 5, amount: 5, tax_rate: null },
              { description: 'B', quantity: 1, unit_price: 5, amount: 5, tax_rate: null }
            ]
          })
        })
      });
      assert.equal(result.kind, 'completed_header');
      assert.deepEqual(result.lines, [], 'lines dropped at worker boundary');
      assert.equal(result.summary.line_count, 0, 'line_count pinned to actual write count');
      // The payment_terms_phrase + days stay on the summary even when
      // lines are disabled — they live on the header-ish side of the
      // contract.
      assert.equal(result.summary.payment_terms_days, 30);
    });
  });

  await test('extractDocument: amount_mismatch is appended (does not clobber existing warnings)', async () => {
    await withDocumentLinesFlag('true', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            summary: {
              ...validSummary,
              subtotal_amount: 100,
              tax_amount: 9,
              total_amount: 200,
              line_amounts_include_tax: false,
              warnings: ['tax_amount_illegible']
            },
            lines: validLineSet
          })
        })
      });
      assert.deepEqual(
        result.summary.warnings.sort(),
        ['amount_mismatch', 'tax_amount_illegible']
      );
    });
  });

  // ── PR 7: sales_invoice dispatch + worker glue ─────────────────────

  const fakeInvoiceDocument = {
    id: 'doc-invoice',
    document_type: 'sales_invoice',
    filename: 'globex-may.pdf',
    client_id: 'client-1',
    payload: { mime_type: 'application/pdf' }
  };

  const validInvoiceHeader = {
    vendor_name: null, // firm IS the vendor — invariant 4
    customer_name: 'Globex Industries Oy',
    document_date: '2026-04-30',
    due_date: '2026-05-30',
    total_amount: 2500,
    currency: 'EUR',
    tax_amount: 0,
    reference_number: 'SI-2026-0042',
    payment_status: 'unpaid',
    extraction_confidence: 0.95
  };

  const validInvoiceSummary = {
    source: 'async_parse',
    document_type: 'sales_invoice',
    counterparty_name: 'Globex Industries Oy',
    counterparty_role: 'customer',
    document_date: '2026-04-30',
    due_date: '2026-05-30',
    currency: 'EUR',
    total_amount: 2500,
    tax_amount: 0,
    payment_terms_phrase: 'Net 30',
    payment_terms_days: 30,
    line_count: 0,
    coded_line_count: 0,
    review_line_count: 0,
    extraction_status: 'validated',
    extraction_confidence: 0.95,
    warnings: []
  };

  await test('pickExtractor returns sales_invoice extractor when DOCUMENT_EXTRACTORS_ENABLED=true', async () => {
    await withDocumentExtractorsFlag('true', () => {
      const desc = pickExtractor('sales_invoice');
      assert.ok(desc, 'descriptor returned');
      assert.equal(desc.type, 'sales_invoice');
      assert.equal(desc.extract, extractSalesInvoiceFromBase64);
    });
  });

  await test('pickExtractor returns null for sales_invoice when DOCUMENT_EXTRACTORS_ENABLED unset', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      assert.equal(pickExtractor('sales_invoice'), null);
    });
  });

  await test('extractDocument: sales_invoice routes to invoice extractor (NOT bill or receipt)', async () => {
    let invoiceCalls = 0;
    let billCalls = 0;
    let receiptCalls = 0;
    const result = await __test__extractDocument({
      document: fakeInvoiceDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: (docType) => {
        if (docType === 'sales_invoice') {
          return {
            type: 'sales_invoice',
            extract: async () => {
              invoiceCalls += 1;
              return { kind: 'completed', header: validInvoiceHeader, summary: validInvoiceSummary };
            }
          };
        }
        if (docType === 'supplier_bill') {
          return { type: 'supplier_bill', extract: async () => { billCalls += 1; return { kind: 'completed', header: {}, summary: {} }; } };
        }
        if (docType === 'receipt') {
          return { type: 'receipt', extract: async () => { receiptCalls += 1; return { kind: 'completed', header: {}, summary: {} }; } };
        }
        return null;
      }
    });
    assert.equal(invoiceCalls, 1, 'invoice extractor invoked');
    assert.equal(billCalls, 0, 'bill extractor NOT invoked');
    assert.equal(receiptCalls, 0, 'receipt extractor NOT invoked');
    assert.equal(result.kind, 'completed_header');
    assert.equal(result.summary.document_type, 'sales_invoice');
    assert.equal(result.summary.counterparty_role, 'customer');
    assert.equal(result.summary.payment_terms_days, 30);
    assert.equal(result.header.vendor_name, null, 'vendor_name null on sales invoice');
    assert.equal(result.header.customer_name, 'Globex Industries Oy', 'customer_name landed');
  });

  await test('extractDocument: DOCUMENT_EXTRACTORS_ENABLED=false → sales_invoice skipped', async () => {
    await withDocumentExtractorsFlag('false', async () => {
      const result = await __test__extractDocument({
        document: fakeInvoiceDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console
        // Real pickExtractor — confirms the kill switch covers invoices too.
      });
      assert.equal(result.kind, 'skipped');
      assert.equal(result.reason, 'extractor_unavailable');
      assert.equal(result.summary.document_type, 'sales_invoice');
    });
  });

  await test('extractDocument: sales_invoice extractor failure envelope flows through as ParseError unchanged', async () => {
    let thrown = null;
    try {
      await __test__extractDocument({
        document: fakeInvoiceDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        pickExtractorImpl: stubPickExtractor({
          type: 'sales_invoice',
          extract: async () => ({
            kind: 'failed',
            code: 'DOCUMENT_EXTRACTION_FAILED',
            reason: 'openai_500',
            // Extractors stamp the provider their lane resolved (2026-11-10).
            provider: 'openai'
          })
        })
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ParseError, 'must throw ParseError');
    assert.equal(thrown.parseErrorCode, 'DOCUMENT_EXTRACTION_FAILED');
    assert.equal(thrown.retryable, true, 'retryable per registry');
    assert.equal(thrown.provider, 'openai');
  });

  // ── Phase 2b.1: bank-statement jurisdiction detector wiring ────────
  // The worker's success branch threads a `detectorInput` off the
  // bank-statement extraction and turns it into a recorder signal via
  // buildJurisdictionSignalFromStatement. The full DB-backed success
  // path isn't unit-mockable (its writers are module imports, not
  // injected), so coverage splits two ways: extractDocument produces a
  // correct detectorInput alongside the unchanged transactions, and the
  // pure builder maps that input to the exact signal shape the recorder
  // consumes.

  const fakeBankStatementDocument = {
    id: 'doc-bs',
    document_type: 'bank_statement',
    filename: 'dbs-statement-may.pdf',
    client_id: 'client-1',
    payload: { mime_type: 'application/pdf' }
  };

  const stubBankStatementExtraction = (overrides = {}) => ({
    filename: 'dbs-statement-may.pdf',
    extraction_status: 'validated',
    statement_currency: 'SGD',
    statement_summary: null,
    period_label: '2026-05',
    ledger_currency: 'SGD',
    warnings: [],
    transactions: [
      { date: '2026-05-01', description: 'GIRO PAYMENT', money_in: 0, money_out: 120.5, balance: 4000 },
      { date: '2026-05-03', description: 'SALARY', money_in: 5000, money_out: 0, balance: 9000 }
    ],
    ...overrides
  });

  await test('extractDocument: bank_statement returns detectorInput alongside transactions', async () => {
    const result = await __test__extractDocument({
      document: fakeBankStatementDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: stubPickExtractor({
        type: 'bank_statement',
        extract: async () => stubBankStatementExtraction()
      })
    });
    assert.equal(result.kind, 'completed');
    // The parse success flow still surfaces the parsed transactions —
    // the detector addition is purely additive.
    assert.equal(Array.isArray(result.transactions), true);
    assert.equal(result.transactions.length, 2);
    // detectorInput sources match the account-fingerprint logic: bank
    // name falls back to filename, currency comes off the statement.
    assert.ok(result.detectorInput, 'detectorInput present');
    assert.equal(result.detectorInput.bankName, 'dbs-statement-may.pdf');
    assert.equal(result.detectorInput.currency, 'SGD');
    assert.equal(result.detectorInput.accountNumber, '');
  });

  // ── Statement-header payload persistence ───────────────────────────
  // The coverage gather behind the ask-pipeline's counterpart-statement
  // gap check reads payload.statement_summary off the documents row.
  // The async worker historically never wrote it (only the legacy
  // /documents/sync writer did), so every async-parsed statement had a
  // null coverage identity and the drafter could not tell which
  // accounts the firm already holds statements for. These tests pin
  // the patch the worker now hands to markParseCompletedInDb.

  await test('buildStatementPayloadPatch: text-path header is persisted with canonical keys', () => {
    const patch = buildStatementPayloadPatch(stubBankStatementExtraction({
      statement_summary: {
        deposits: 12000,
        payouts: 9000,
        starting_balance: 1000,
        ending_balance: 4000,
        bank_name: 'DBS Bank Ltd',
        account_number: '072-123456-7',
        iban: null
      }
    }));
    assert.equal(patch.statement_summary.bank_name, 'DBS Bank Ltd');
    assert.equal(patch.statement_summary.account_number, '072-123456-7');
    assert.equal(patch.statement_summary.iban, null);
    // Non-header summary values (balances/totals) ride along untouched —
    // transactionIntel reads ending_balance off the same key.
    assert.equal(patch.statement_summary.ending_balance, 4000);
    assert.equal(patch.period_label, '2026-05');
    assert.equal(patch.statement_currency, 'SGD');
  });

  await test('buildStatementPayloadPatch: vision-shape keys normalize to account_number', () => {
    const patch = buildStatementPayloadPatch(stubBankStatementExtraction({
      statement_summary: {
        opening_balance: 100,
        closing_balance: 200,
        currency: 'USD',
        account_identifier: 'SAVINGS ****5747'
      }
    }));
    assert.equal(patch.statement_summary.account_number, 'SAVINGS ****5747');
    assert.equal(patch.statement_summary.bank_name, null);
  });

  await test('buildStatementPayloadPatch: no header → patch still carries period and currency', () => {
    const patch = buildStatementPayloadPatch(stubBankStatementExtraction({ statement_summary: null }));
    assert.equal(patch.statement_summary, undefined);
    assert.equal(patch.period_label, '2026-05');
    assert.equal(patch.statement_currency, 'SGD');
  });

  await test('buildStatementPayloadPatch: nothing to persist → null (payload left untouched)', () => {
    assert.equal(buildStatementPayloadPatch({}), null);
    assert.equal(buildStatementPayloadPatch(null), null);
    assert.equal(
      buildStatementPayloadPatch({ statement_summary: null, period_label: '', statement_currency: '' }),
      null
    );
  });

  await test('extractDocument: bank_statement result carries the payloadPatch for the completion write', async () => {
    const result = await __test__extractDocument({
      document: fakeBankStatementDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: stubPickExtractor({
        type: 'bank_statement',
        extract: async () => stubBankStatementExtraction({
          statement_summary: { bank_name: 'DBS Bank Ltd', account_number: '072-123456-7', iban: null }
        })
      })
    });
    assert.equal(result.kind, 'completed');
    assert.ok(result.payloadPatch, 'payloadPatch present');
    assert.equal(result.payloadPatch.statement_summary.account_number, '072-123456-7');
    assert.equal(result.payloadPatch.statement_summary.bank_name, 'DBS Bank Ltd');
    assert.equal(result.payloadPatch.period_label, '2026-05');
    assert.equal(result.payloadPatch.statement_currency, 'SGD');
  });

  await test('buildJurisdictionSignalFromStatement: agreeing signals → sg/high signal shape', async () => {
    // Filename "dbs-…" (bank_name, high) + SGD currency (medium) agree
    // on sg → combiner bumps to high. The signal carries exactly what
    // recordJurisdictionSignalInDb expects.
    const signal = buildJurisdictionSignalFromStatement(
      { bankName: 'dbs-statement-may.pdf', currency: 'SGD', accountNumber: '' },
      'doc-bs'
    );
    assert.ok(signal, 'signal produced');
    assert.equal(signal.source, 'bank_statement');
    assert.equal(signal.jurisdiction, 'sg');
    assert.equal(signal.confidence, 'high');
    assert.equal(signal.document_id, 'doc-bs');
    assert.equal(typeof signal.evidence, 'string');
    assert.ok(signal.evidence.length > 0, 'evidence string populated');
  });

  await test('buildJurisdictionSignalFromStatement: no discriminating signal → null', async () => {
    // Generic filename + USD (omitted from the currency map as
    // non-discriminating) → detector returns null → no recorder call.
    const signal = buildJurisdictionSignalFromStatement(
      { bankName: 'statement.pdf', currency: 'USD', accountNumber: '' },
      'doc-bs'
    );
    assert.equal(signal, null);
  });

  await test('buildJurisdictionSignalFromStatement: clashing high signals → conflicted (null jurisdiction)', async () => {
    // "dbs" bank name (sg, high) + a GB-prefixed IBAN (gb, high) →
    // combiner marks conflicted; the recorder preserves the prior
    // detected value but flips the confidence marker.
    const signal = buildJurisdictionSignalFromStatement(
      { bankName: 'dbs-export.pdf', currency: '', accountNumber: 'GB29 NWBK 6016 1331 9268 19' },
      'doc-bs'
    );
    assert.ok(signal, 'signal produced');
    assert.equal(signal.confidence, 'conflicted');
    assert.equal(signal.jurisdiction, null);
  });

  await test('buildJurisdictionSignalFromStatement: missing detectorInput → null', async () => {
    assert.equal(buildJurisdictionSignalFromStatement(null, 'doc-bs'), null);
    assert.equal(buildJurisdictionSignalFromStatement(undefined), null);
  });

  await test('buildJurisdictionSignalFromStatement: text snippet lights up the tax-id signal (Phase 2.3)', async () => {
    // Before Phase 2.3 the worker fed bankName + currency + accountNumber
    // to the detector but never any text — so the tax-id branch of
    // collectJurisdictionSignals could never fire. With statement_summary
    // surfacing the header and parseDocument forwarding text_snippet,
    // a "UEN 201234567A" banner alone is now enough for an sg/high signal.
    const signal = buildJurisdictionSignalFromStatement(
      {
        bankName: 'statement.pdf',
        currency: '',
        accountNumber: '',
        text: 'UEN 201234567A · Quarterly statement'
      },
      'doc-bs'
    );
    assert.ok(signal, 'signal produced');
    assert.equal(signal.jurisdiction, 'sg');
    assert.equal(signal.confidence, 'high');
  });

  // RT-05 (2026-09-01): the router's shadow mode, its per-family promotion
  // (env list + DOCUMENT_ROUTER_PROMOTE_<FAMILY> plane keys) and the
  // promotion provenance fields on the classification receipt are DELETED.
  // The suite that pinned their mechanics lived here; the replacement
  // fixtures (desktop seed posture, no promotion row) and the deletion
  // ratchet live in server/donna/classificationAudit.test.js.

  // ── withTimeout — the parse-stall guard ──────────────────────────────
  // Pins that optional-context loads degrade on a HANG, not just a throw,
  // so a never-resolving await can't stall the worker to the 300s ceiling.

  await test('withTimeout: resolves with the value when the promise settles in time', async () => {
    const out = await withTimeout(Promise.resolve('ok'), 1000, 'fast read');
    assert.equal(out, 'ok');
  });

  await test('withTimeout: rejects with ContextLoadTimeoutError when the promise hangs', async () => {
    const neverResolves = new Promise(() => {}); // simulates a hung DB/LLM await
    await assert.rejects(
      () => withTimeout(neverResolves, 20, 'hung read'),
      (err) => {
        assert.ok(err instanceof ContextLoadTimeoutError, 'is a ContextLoadTimeoutError');
        assert.equal(err.code, 'CONTEXT_LOAD_TIMEOUT');
        assert.match(err.message, /hung read timed out after 20ms/);
        return true;
      }
    );
  });

  await test('withTimeout: a call-site try/catch turns a hang into a null degrade', async () => {
    // Mirrors the worker's pattern: await withTimeout(...) inside a
    // try/catch that falls back to null. A hang must reach the catch.
    let clientIdentity = 'sentinel';
    try {
      clientIdentity = await withTimeout(new Promise(() => {}), 20, 'client identity read');
    } catch {
      clientIdentity = null;
    }
    assert.equal(clientIdentity, null, 'hung optional read degraded to null instead of stalling');
  });

  await test('withTimeout: a late rejection after timeout does not crash the process', async () => {
    // The original promise rejects AFTER the race already lost — withTimeout
    // attaches a no-op catch so this never becomes an unhandledRejection.
    let rejectLate;
    const lateRejecter = new Promise((_, reject) => { rejectLate = reject; });
    await assert.rejects(() => withTimeout(lateRejecter, 10, 'slow read'));
    rejectLate(new Error('boom (late)'));
    // Give the microtask queue a tick to surface any unhandled rejection.
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(true, 'no unhandledRejection surfaced');
  });

  await test('required config snapshot timeout is retryable, never an extractor-disabled fallback', async () => {
    let thrown = null;
    try {
      await loadRequiredConfigSnapshot({
        load: () => new Promise(() => {}),
        timeoutMs: 20
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ParseError, 'timeout is promoted to a parse error');
    assert.equal(thrown.parseErrorCode, 'CONFIG_SNAPSHOT_UNAVAILABLE');
    const categorized = categorizeError(thrown);
    assert.equal(categorized.retryable, true, 'the worker retries after the pool recovers');
    assert.equal(categorized.provider, 'internal');
    assert.equal(categorized.reason, 'client_config_snapshot_read_failed');
  });

  // ── intel-refresh timebox — the post-extraction parse-stall guard ────
  //
  // The post-extraction `refreshTransactionIntelInDb` call already has a
  // try/catch that degrades to `enrichment_warning` on a THROW, but a
  // hang would otherwise stall the parse past Vercel's 300s ceiling.
  // The same `withTimeout` helper that protects the pre-extraction loads
  // now wraps the intel refresh; these tests pin the integration shape:
  // a hung refresh raises ContextLoadTimeoutError, the existing catch
  // lands `enrichment_warning`, and the parse proceeds.

  await test('intel refresh timebox: a hung refresh degrades to enrichment_warning', async () => {
    // Inline the worker's try/catch + withTimeout shape against a
    // never-resolving stub. The timeout fires, the catch lands the
    // warning, parse continues. Same pattern as the live worker.
    const summary = {};
    try {
      await withTimeout(
        new Promise(() => {}), // simulates a hung intel refresh
        20,
        'transaction intel refresh'
      );
    } catch (enrichmentErr) {
      summary.enrichment_warning = enrichmentErr?.message || 'Intel refresh failed.';
    }
    assert.match(summary.enrichment_warning, /transaction intel refresh timed out/);
  });

  await test('intel refresh timebox: a fast refresh resolves cleanly, no warning lands', async () => {
    const summary = {};
    try {
      await withTimeout(
        Promise.resolve({ refreshed: 42 }),
        1000,
        'transaction intel refresh'
      );
    } catch (enrichmentErr) {
      summary.enrichment_warning = enrichmentErr?.message || 'Intel refresh failed.';
    }
    assert.equal(summary.enrichment_warning, undefined, 'no warning on healthy refresh');
  });

  // ── extraction timebox — the LOAD-BEARING parse-stall guard ──────────
  //
  // The 2026-06-30 Honeybee incident: 5 of 6 demo docs stalled in
  // `extracting` on a slow Responses API, hung past the 300s ceiling, and
  // got reaped to failed/STUCK. Unlike the optional loads, extraction has
  // NO null fallback, so its timeout must propagate to the outer catch and
  // categorize as a RETRYABLE OCR_TIMEOUT (clean Inngest backoff/retry),
  // never degrade to null. These pin that contract: the hang surfaces as a
  // ContextLoadTimeoutError, and categorizeError routes it to a retry.

  await test('extraction timebox: a hung extraction raises ContextLoadTimeoutError', async () => {
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 20, 'document extraction'),
      (err) => {
        assert.ok(err instanceof ContextLoadTimeoutError, 'is a ContextLoadTimeoutError');
        assert.match(err.message, /document extraction timed out/);
        return true;
      }
    );
  });

  await test('extraction timebox: the timeout categorizes as a RETRYABLE OCR_TIMEOUT', async () => {
    // The crux of the fix — a hung extraction must reach the outer catch as
    // a retryable error so Inngest retries inside budget, NOT as a terminal
    // failure or a silent stuck-sweep reap.
    let caught = null;
    try {
      await withTimeout(new Promise(() => {}), 20, 'document extraction');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'extraction timeout threw');
    const categorized = categorizeError(caught);
    assert.equal(categorized.code, 'OCR_TIMEOUT', 'maps to OCR_TIMEOUT');
    assert.equal(categorized.retryable, true, 'is retryable → Inngest retries');
  });

  await test('extraction timebox: a fast extraction resolves cleanly with no timeout', async () => {
    const result = await withTimeout(
      Promise.resolve({ kind: 'completed', summary: {} }),
      1000,
      'document extraction'
    );
    assert.equal(result.kind, 'completed', 'healthy extraction passes straight through');
  });

  // ── unified type decision: the strong model outranks the router ────
  // June 2026 Honeybee Mann Lake bill: upload said supplier_bill
  // (correct), the nano router flipped it to sales_invoice, the Opus
  // unified extraction was AP-shaped — and the row kept the router's
  // type, so the AR matcher auto-matched a purchase to a deposit.
  // These pin the decision contract end to end.

  const routerClassification = () => ({
    source: 'router_v1',
    model: 'gpt-5.4-nano',
    confidence: 0.86,
    original_type: 'supplier_bill',
    final_type: 'sales_invoice',
    direction_hint: 'ar',
    candidate_families: [],
    reason: 'router text',
    fallback_used: false,
    fallback_reason: null
  });

  await test('__applyUnifiedTypeDecision: no unified type → router decision passes through untouched', () => {
    const classification = routerClassification();
    const out = __applyUnifiedTypeDecision({
      classification,
      finalType: 'sales_invoice',
      modelDocumentType: null
    });
    assert.equal(out.finalType, 'sales_invoice');
    assert.equal(out.classification, classification, 'object passes through unchanged');
    assert.equal(out.classification.final_type_source, undefined);
  });

  await test('__applyUnifiedTypeDecision: unified disagrees → unified type wins, router choice preserved in audit', () => {
    const out = __applyUnifiedTypeDecision({
      classification: routerClassification(),
      finalType: 'sales_invoice',
      modelDocumentType: 'supplier_bill'
    });
    assert.equal(out.finalType, 'supplier_bill', 'the strong model makes the direction call');
    assert.equal(out.classification.final_type, 'supplier_bill');
    assert.equal(out.classification.router_final_type, 'sales_invoice', 'router choice survives for the audit');
    assert.equal(out.classification.final_type_source, 'unified_extractor');
    assert.equal(out.classification.original_type, 'supplier_bill', 'rest of the audit is untouched');
  });

  await test('__applyUnifiedTypeDecision: unified agrees → type unchanged, agreement recorded', () => {
    const out = __applyUnifiedTypeDecision({
      classification: routerClassification(),
      finalType: 'sales_invoice',
      modelDocumentType: 'sales_invoice'
    });
    assert.equal(out.finalType, 'sales_invoice');
    assert.equal(out.classification.final_type_source, 'unified_extractor_agreed');
    assert.equal(out.classification.router_final_type, undefined, 'no override, no override field');
  });

  // ── buildExtractorReceipt: the Slice-B Step 0 extractor-path receipt ──
  // ── RT-12: the extractor-path receipt (parse_summary.extractor) ──
  // The attempt record extractDocument's wrapper stamps on every outcome is
  // the receipt's only input: what the unified default decided, whether it
  // ran, on which provider, with which RESPONSE-named model, and — when the
  // per-type extractor served instead — the unified failure code as the
  // fallback reason.
  const unifiedAttempt = (overrides = {}) => ({
    unified_default: true,
    unified_default_reason: 'appliance_default',
    attempted: true,
    provider: 'anthropic',
    model: 'claude-opus-4-8-served',
    model_source: 'response_proven',
    prompt_version: 'unified-extraction-v2',
    failure: null,
    partial_header: null,
    ...overrides
  });

  await test('buildExtractorReceipt: unified ran → path=unified, provider, the response-named model id, prompt version', () => {
    const receipt = buildExtractorReceipt({
      documentType: 'supplier_bill',
      result: { model_document_type: 'supplier_bill', extractor_model: 'claude-opus-4-8-served', unified_attempt: unifiedAttempt() }
    });
    assert.equal(receipt.path, 'unified');
    assert.equal(receipt.provider, 'anthropic');
    assert.equal(receipt.model, 'claude-opus-4-8-served');
    assert.equal(receipt.model_source, 'response_proven');
    assert.equal(receipt.prompt_version, 'unified-extraction-v8');
    assert.equal(receipt.unified_default, true);
    assert.equal(receipt.fallback_used, false);
    assert.equal(receipt.fallback_reason, null);
  });

  await test('buildExtractorReceipt: the cloud keeps the per-type path → type_specific by design, not a fallback', () => {
    const receipt = buildExtractorReceipt({
      documentType: 'sales_invoice',
      result: {
        summary: { prompt_version: 'sales-invoice-extraction-v1' },
        extractor_model: 'gpt-5.4',
        unified_attempt: unifiedAttempt({ unified_default: false, unified_default_reason: 'cloud_per_type_release', attempted: false, provider: null, model: null, model_source: null })
      }
    });
    assert.equal(receipt.path, 'type_specific');
    assert.equal(receipt.unified_default, false);
    assert.equal(receipt.unified_default_reason, 'cloud_per_type_release');
    assert.equal(receipt.model, 'gpt-5.4', 'the per-type model id is part of the receipt');
    assert.equal(receipt.prompt_version, 'sales-invoice-extraction-v1', 'the per-type lane stamps its own prompt version');
    assert.equal(receipt.fallback_used, false, 'unified was not the default → not a fallback');
    assert.equal(receipt.fallback_reason, null);
  });

  await test('buildExtractorReceipt: unified default + final failure + per-type served → fallback_used with the unified failure code', () => {
    const receipt = buildExtractorReceipt({
      documentType: 'receipt',
      result: {
        summary: { prompt_version: 'receipt-extraction-v1' },
        extractor_model: 'gpt-5.4',
        // The per-type extractors stamp the provider their lane resolved
        // (2026-11-10: Anthropic first); this result was served by OpenAI.
        extractor_provider: 'openai',
        unified_attempt: unifiedAttempt({ failure: { code: 'DOCUMENT_EXTRACTION_UNREADABLE', reason: 'low_confidence' } })
      }
    });
    assert.equal(receipt.path, 'type_specific');
    assert.equal(receipt.fallback_used, true, 'default + attempted + did not run = fallback');
    assert.equal(receipt.fallback_reason, 'DOCUMENT_EXTRACTION_UNREADABLE');
    assert.equal(receipt.fallback_detail, 'low_confidence');
    assert.equal(receipt.provider, 'openai', 'the receipt names the provider the per-type extractor reported');
  });

  await test('buildExtractorReceipt: a result without an attempt record (bank statement, e-invoice) is type_specific and never a fallback', () => {
    const receipt = buildExtractorReceipt({ documentType: 'contract', result: { summary: {} } });
    assert.equal(receipt.path, 'type_specific');
    assert.equal(receipt.unified_default, false);
    assert.equal(receipt.fallback_used, false);
    assert.equal(receipt.model, null);
  });

  // ── RT-12: the unified default in extractDocument ──
  const withDesktopHost = async (fn, { killSwitch = false } = {}) => {
    const priorBlob = process.env.DONNA_DESKTOP_BLOB_DIR;
    const priorKill = process.env.UNIFIED_EXTRACTOR_DISABLED;
    process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/parse-document-test-blobs';
    if (killSwitch) process.env.UNIFIED_EXTRACTOR_DISABLED = 'true';
    else delete process.env.UNIFIED_EXTRACTOR_DISABLED;
    try {
      await fn();
    } finally {
      if (priorBlob === undefined) delete process.env.DONNA_DESKTOP_BLOB_DIR;
      else process.env.DONNA_DESKTOP_BLOB_DIR = priorBlob;
      if (priorKill === undefined) delete process.env.UNIFIED_EXTRACTOR_DISABLED;
      else process.env.UNIFIED_EXTRACTOR_DISABLED = priorKill;
    }
  };
  const WAVE_ON = { DOCUMENT_EXTRACTORS_ENABLED: { stage: 'canary' } };
  const neverPerType = stubPickExtractor({
    type: 'receipt',
    extract: async () => { throw new Error('the per-type extractor must not run when the unified read completed'); }
  });
  const unifiedCompleted = (overrides = {}) => async () => ({
    kind: 'completed_header',
    document_type: 'supplier_bill',
    header: { vendor_name: 'Mann Lake', total_amount: 224.36, payment_status: 'unpaid' },
    summary: { source: 'unified_extractor', prompt_version: 'unified-extraction-v2', document_type: 'supplier_bill', warnings: [] },
    lines: [],
    provider: 'anthropic',
    model: 'claude-opus-4-8-served',
    model_source: 'response_proven',
    prompt_version: 'unified-extraction-v2',
    ...overrides
  });

  await test('extractDocument: on the appliance the unified extractor is the default — its type wins and the per-type extractor never runs', async () => {
    await withDesktopHost(async () => {
      // Dispatched as sales_invoice (the router's wrong flip); the unified
      // model classifies it back to supplier_bill.
      const result = await __test__extractDocument({
        document: { id: 'doc-1', document_type: 'sales_invoice', filename: 'mann-lake.pdf' },
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        configSnapshot: WAVE_ON,
        extractUnifiedImpl: unifiedCompleted(),
        pickExtractorImpl: neverPerType
      });
      assert.equal(result.kind, 'completed_header');
      assert.equal(result.model_document_type, 'supplier_bill', 'the unified classification must ride the envelope to the header write');
      assert.equal(result.summary.document_type, 'supplier_bill');
      assert.equal(result.extractor_model, 'claude-opus-4-8-served', 'the provider-returned unified model id rides the envelope for the receipt');
      assert.equal(result.extractor_provider, 'anthropic');
      assert.equal(result.unified_attempt.attempted, true);
      assert.equal(result.unified_attempt.unified_default_reason, 'appliance_default');
      const receipt = buildExtractorReceipt({ documentType: 'sales_invoice', result });
      assert.equal(receipt.path, 'unified');
      assert.equal(receipt.fallback_used, false);
    });
  });

  await test('extractDocument: the unified call receives the routed type and the document id (the prompt hint + the execution root)', async () => {
    await withDesktopHost(async () => {
      let seen = null;
      await __test__extractDocument({
        document: { id: 'doc-77', document_type: 'receipt', filename: 'till.pdf', payload: { mime_type: 'image/jpeg' } },
        bytes: Buffer.from('jpeg-bytes'),
        log: console,
        dateFormatHint: 'Dates follow the DD/MM/YYYY-convention.',
        configSnapshot: WAVE_ON,
        extractUnifiedImpl: async (args) => { seen = args; return unifiedCompleted({ document_type: 'receipt' })(); },
        pickExtractorImpl: neverPerType
      });
      assert.equal(seen.documentType, 'receipt');
      assert.equal(seen.documentId, 'doc-77');
      assert.equal(seen.mimeType, 'image/jpeg');
      assert.match(seen.dateFormatHint, /DD\/MM\/YYYY-convention/);
      assert.ok(!('apiKey' in seen), 'the worker never hands a key to the extractor — it resolves its own provider');
    });
  });

  await test('extractDocument: unified branch persists the totals receipt (discounted bill foots, strategy recorded)', async () => {
    await withDesktopHost(async () => {
      await withDocumentLinesFlag('true', async () => {
        // Social DXB shape (RT-04 acceptance fixture a): 550 + 27.50 − 27.50 = 550.
        const result = await __test__extractDocument({
          document: { id: 'doc-sd', document_type: 'supplier_bill', filename: 'social-dxb.pdf' },
          bytes: Buffer.from('pdf-bytes'),
          log: console,
          configSnapshot: WAVE_ON,
          extractUnifiedImpl: unifiedCompleted({
            header: { vendor_name: 'Social DXB', total_amount: 550, tax_amount: 27.5, payment_status: 'unpaid' },
            summary: {
              source: 'unified_extractor',
              document_type: 'supplier_bill',
              warnings: [],
              subtotal_amount: 550,
              tax_amount: 27.5,
              shipping_amount: 0,
              discount_amount: 27.5,
              rounding_amount: 0,
              total_amount: 550,
              line_amounts_include_tax: false
            },
            lines: [{ amount: 200 }, { amount: 200 }, { amount: 150 }]
          }),
          pickExtractorImpl: neverPerType
        });
        assert.equal(result.kind, 'completed_header');
        assert.ok(!(result.summary.warnings || []).includes('amount_mismatch'), 'a discounted bill that foots is not a mismatch');
        assert.equal(result.summary.review_line_count, 0);
        const receipt = result.summary.totals_validation;
        assert.ok(receipt, 'totals_validation persisted on the unified branch');
        assert.equal(receipt.matches, true);
        assert.equal(receipt.strategy, 'declared_tax_exclusive');
        assert.equal(receipt.expected, 550);
        assert.equal(receipt.discount, 27.5);
      });
    });
  });

  await test('extractDocument: a FINAL unified failure falls through to the per-type extractor (one release), receipted, with the partial header persisted first', async () => {
    await withDesktopHost(async () => {
      const persisted = [];
      const partial = {
        document_type: 'receipt',
        extraction_status: 'partial',
        extraction_confidence: 0.2,
        header: { counterparty_name: 'Acme Coffee Roasters', total_amount: 13.63, document_date: null, currency: 'SGD' },
        line_count: 0,
        warnings: ['model:date_unreadable']
      };
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        configSnapshot: WAVE_ON,
        onPartialHeader: async (value) => { persisted.push(value); },
        extractUnifiedImpl: async () => ({
          kind: 'failed',
          code: 'DOCUMENT_EXTRACTION_UNREADABLE',
          reason: 'low_confidence',
          retryable: false,
          provider: 'openai',
          model: 'gpt-5.4-served',
          model_source: 'response_proven',
          prompt_version: 'unified-extraction-v2',
          partial_header: partial
        }),
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({ kind: 'completed', header: validHeader, summary: validSummary, model: 'gpt-5.4' })
        })
      });
      assert.equal(result.kind, 'completed_header');
      assert.equal(result.model_document_type, undefined, 'the per-type extractor served — no unified type decision');
      assert.equal(persisted.length, 1, 'the partial header was persisted before the fall-through');
      assert.equal(persisted[0].header.counterparty_name, 'Acme Coffee Roasters');
      assert.equal(persisted[0].document_type, 'receipt');
      assert.equal(persisted[0].extraction_confidence, 0.2);
      assert.equal(persisted[0].provider, 'openai');
      assert.equal(persisted[0].model, 'gpt-5.4-served');
      assert.equal(persisted[0].code, 'DOCUMENT_EXTRACTION_UNREADABLE');
      assert.equal(result.summary.partial_header.header.total_amount, 13.63, 'the strong model\'s partial read rides the completed summary as evidence');
      assert.equal(result.summary.partial_header.reason, 'low_confidence');
      const receipt = buildExtractorReceipt({ documentType: 'receipt', result });
      assert.equal(receipt.path, 'type_specific');
      assert.equal(receipt.fallback_used, true);
      assert.equal(receipt.fallback_reason, 'DOCUMENT_EXTRACTION_UNREADABLE');
      assert.equal(receipt.fallback_detail, 'low_confidence');
    });
  });

  await test('extractDocument: a RETRYABLE unified failure throws for the queue — never a silent second extractor on an outage', async () => {
    await withDesktopHost(async () => {
      let perTypeCalled = false;
      await assert.rejects(
        () => __test__extractDocument({
          document: fakeReceiptDocument,
          bytes: Buffer.from('pdf-bytes'),
          log: console,
          configSnapshot: WAVE_ON,
          extractUnifiedImpl: async () => ({
            kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'timeout', retryable: true,
            provider: 'anthropic', model: 'claude-opus-4-8', model_source: 'configured_fallback', prompt_version: 'unified-extraction-v2'
          }),
          pickExtractorImpl: stubPickExtractor({ type: 'receipt', extract: async () => { perTypeCalled = true; return { kind: 'completed', header: validHeader, summary: validSummary }; } })
        }),
        (error) => {
          assert.ok(error instanceof ParseError, 'a ParseError the worker categorizes');
          assert.equal(error.parseErrorCode, 'DOCUMENT_EXTRACTION_FAILED');
          assert.equal(error.retryable, true);
          assert.equal(categorizeError(error).retryable, true, 'the worker categorizes it as the queue\'s to retry');
          assert.equal(error.unified_attempt?.failure?.reason, 'timeout', 'the attempt record rides the thrown error');
          return true;
        }
      );
      assert.equal(perTypeCalled, false);
    });
  });

  await test('extractDocument: off the appliance (cloud) the per-type path serves and the receipt says why', async () => {
    let unifiedCalled = false;
    const result = await __test__extractDocument({
      document: fakeReceiptDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      configSnapshot: WAVE_ON,
      extractUnifiedImpl: async () => { unifiedCalled = true; return unifiedCompleted()(); },
      pickExtractorImpl: stubPickExtractor({ type: 'receipt', extract: async () => ({ kind: 'completed', header: validHeader, summary: validSummary }) })
    });
    assert.equal(unifiedCalled, false, 'the cloud keeps the per-type path for one release');
    assert.equal(result.model_document_type, undefined);
    assert.deepEqual(
      [result.unified_attempt.unified_default, result.unified_attempt.unified_default_reason, result.unified_attempt.attempted],
      [false, 'cloud_per_type_release', false]
    );
    assert.equal(buildExtractorReceipt({ documentType: 'receipt', result }).fallback_used, false, 'not the default ⇒ not a fallback');
  });

  await test('extractDocument: the kill switch closes the unified default on the appliance (env may kill, never enable)', async () => {
    await withDesktopHost(async () => {
      let unifiedCalled = false;
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        configSnapshot: WAVE_ON,
        extractUnifiedImpl: async () => { unifiedCalled = true; return unifiedCompleted()(); },
        pickExtractorImpl: stubPickExtractor({ type: 'receipt', extract: async () => ({ kind: 'completed', header: validHeader, summary: validSummary }) })
      });
      assert.equal(unifiedCalled, false);
      assert.equal(result.unified_attempt.unified_default_reason, 'kill_switch');
    }, { killSwitch: true });
  });

  await test('extractDocument: the unified default respects the DOCUMENT_EXTRACTORS_ENABLED wave gate', async () => {
    await withDesktopHost(async () => {
      let unifiedCalled = false;
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        configSnapshot: { DOCUMENT_EXTRACTORS_ENABLED: { stage: 'off' } },
        extractUnifiedImpl: async () => { unifiedCalled = true; return unifiedCompleted()(); },
        pickExtractorImpl: (type, options) => pickExtractor(type, options)
      });
      assert.equal(unifiedCalled, false, 'a closed wave never reaches a model');
      assert.equal(result.kind, 'skipped');
      assert.equal(result.reason, 'extractor_unavailable');
    });
  });


  await test('extractDocument: non-unified path carries no model_document_type', async () => {
    const result = await __test__extractDocument({
      document: fakeReceiptDocument,
      bytes: Buffer.from('pdf-bytes'),
      log: console,
      pickExtractorImpl: stubPickExtractor({
        type: 'receipt',
        extract: async () => ({
          kind: 'completed',
          header: validHeader,
          summary: validSummary
        })
      })
    });
    assert.equal(result.kind, 'completed_header');
    assert.equal(result.model_document_type, undefined,
      'a type-specific extractor echoes the dispatched type — not a decision');
  });

  // ── Batch-2 Slice B: DB-first shims for the wave / lines / receipt gates ──
  // (docs/donna-batch2-extractor-cluster-plane-wiring-plan.md §2-3). For each
  // key: a row enables with NO env (the prod-shaped case — census 2026-07-05
  // read the whole cluster unset), and a row `off` wins over a set env. No-row
  // byte-identity is pinned by the existing suite above, untouched.

  await test('pickExtractor: a DB canary row enables the receipt extractor with NO env', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      const configSnapshot = { DOCUMENT_EXTRACTORS_ENABLED: { stage: 'canary' } };
      const desc = pickExtractor('receipt', { configSnapshot });
      assert.ok(desc, 'row opens the wave without any env');
      assert.equal(desc.type, 'receipt');
      assert.equal(desc.extract, extractReceiptFromBase64);
    });
  });

  await test('pickExtractor: a DB generic-extractor row opens the fallback for unknown types', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      const configSnapshot = {
        DOCUMENT_EXTRACTORS_ENABLED: { stage: 'auto' },
        GENERIC_DOCUMENT_EXTRACTOR_ENABLED: { stage: 'auto' }
      };
      const desc = pickExtractor('mystery_doc', { configSnapshot });
      assert.ok(desc, 'the desktop plane row reaches the generic fallback');
      assert.equal(desc.type, 'generic_document');
    });
  });

  await test('pickExtractor: an explicit DB off row closes generic fallback over env', async () => {
    const original = process.env.GENERIC_DOCUMENT_EXTRACTOR_ENABLED;
    process.env.GENERIC_DOCUMENT_EXTRACTOR_ENABLED = 'true';
    try {
      const configSnapshot = {
        DOCUMENT_EXTRACTORS_ENABLED: { stage: 'auto' },
        GENERIC_DOCUMENT_EXTRACTOR_ENABLED: { stage: 'off' }
      };
      assert.equal(pickExtractor('mystery_doc', { configSnapshot }), null);
    } finally {
      if (original === undefined) delete process.env.GENERIC_DOCUMENT_EXTRACTOR_ENABLED;
      else process.env.GENERIC_DOCUMENT_EXTRACTOR_ENABLED = original;
    }
  });

  await test('pickExtractor: a DB off row wins over DOCUMENT_EXTRACTORS_ENABLED=true', async () => {
    await withDocumentExtractorsFlag('true', () => {
      const configSnapshot = { DOCUMENT_EXTRACTORS_ENABLED: { stage: 'off' } };
      assert.equal(pickExtractor('receipt', { configSnapshot }), null,
        'an explicit off row outranks the env flag');
    });
  });

  await test('pickExtractor: bank_statement is unaffected by the DB row (always extracts)', async () => {
    await withDocumentExtractorsFlag(undefined, () => {
      const configSnapshot = { DOCUMENT_EXTRACTORS_ENABLED: { stage: 'off' } };
      const desc = pickExtractor('bank_statement', { configSnapshot });
      assert.ok(desc);
      assert.equal(desc.type, 'bank_statement');
    });
  });

  await test('extractDocument: a DB lines canary row carries lines with NO env', async () => {
    await withDocumentLinesFlag(undefined, async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        configSnapshot: { DOCUMENT_LINES_ENABLED: { stage: 'canary' } },
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            summary: {
              ...validSummary,
              subtotal_amount: 12.5,
              line_amounts_include_tax: false,
              line_count: 2
            },
            lines: validLineSet
          })
        })
      });
      assert.equal(result.kind, 'completed_header');
      assert.equal(result.lines.length, 2, 'DB row enables line writes without env');
      assert.equal(result.summary.line_count, 2);
    });
  });

  await test('extractDocument: a DB lines off row wins over DOCUMENT_LINES_ENABLED=true', async () => {
    await withDocumentLinesFlag('true', async () => {
      const result = await __test__extractDocument({
        document: fakeReceiptDocument,
        bytes: Buffer.from('pdf-bytes'),
        log: console,
        configSnapshot: { DOCUMENT_LINES_ENABLED: { stage: 'off' } },
        pickExtractorImpl: stubPickExtractor({
          type: 'receipt',
          extract: async () => ({
            kind: 'completed',
            header: validHeader,
            summary: { ...validSummary, line_count: 2 },
            lines: validLineSet
          })
        })
      });
      assert.equal(result.kind, 'completed_header', 'header still flows through');
      assert.deepEqual(result.lines, [], 'off row drops lines despite env=true');
      assert.equal(result.summary.line_count, 0);
    });
  });

  await test('extractDocument: nesting — a lines canary row with the wave off is still skipped', async () => {
    await withDocumentExtractorsFlag(undefined, async () => {
      await withDocumentLinesFlag(undefined, async () => {
        const result = await __test__extractDocument({
          document: fakeReceiptDocument,
          bytes: Buffer.from('pdf-bytes'),
          log: console,
          // Real pickExtractor — a lines row alone can't open the wave.
          configSnapshot: { DOCUMENT_LINES_ENABLED: { stage: 'canary' } }
        });
        assert.equal(result.kind, 'skipped');
        assert.equal(result.reason, 'extractor_unavailable',
          'the lines gate is strictly nested inside the wave gate');
      });
    });
  });

  // ── FI-9 (R): the e-invoice receive lane in extractDocument ─────────
  // Design: docs/design-donna-finland-fi9-receive-and-ap-post.md §R. The
  // branch is flag-gated on the config plane (FINLAND_EINVOICE_RECEIVE,
  // envFallback false) and commits only to RECOGNISED e-invoices; everything
  // else must reach the existing pipeline byte-identically.

  const EINVOICE_FLAG_ON = { FINLAND_EINVOICE_RECEIVE: { stage: 'auto' } };
  const finvoiceBytes = ({ total = '125.50' } = {}) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Finvoice Version="3.0">
  <SellerPartyDetails><SellerOrganisationName>Nordic Cloud Oy</SellerOrganisationName></SellerPartyDetails>
  <InvoiceDetails>
    <InvoiceNumber>INV-9</InvoiceNumber>
    <InvoiceDate Format="CCYYMMDD">20260701</InvoiceDate>
    <InvoiceTotalVatExcludedAmount>100.00</InvoiceTotalVatExcludedAmount>
    <InvoiceTotalVatAmount>25.50</InvoiceTotalVatAmount>
    <InvoiceTotalVatIncludedAmount>${total}</InvoiceTotalVatIncludedAmount>
  </InvoiceDetails>
  <InvoiceRow>
    <ArticleName>Pilvipalvelu</ArticleName>
    <RowVatRatePercent>25.5</RowVatRatePercent>
    <RowVatExcludedAmount>100.00</RowVatExcludedAmount>
    <RowVatAmount>25.50</RowVatAmount>
  </InvoiceRow>
</Finvoice>`);

  await test('extractDocument: FI-9 flag OFF — e-invoice bytes fall through byte-identically', async () => {
    const result = await __test__extractDocument({
      document: { ...fakeReceiptDocument, document_type: 'unknown_document' },
      bytes: finvoiceBytes(),
      log: console,
      configSnapshot: {},
      pickExtractorImpl: stubPickExtractor(null)
    });
    assert.equal(result.kind, 'skipped', 'flag off ⇒ the lane is inert; unknown type parks as before');
    assert.equal(result.reason, 'extractor_unavailable');
  });

  await test('extractDocument: FI-9 flag ON — a recognised Finvoice lands as completed_header with the einvoice receipt', async () => {
    const result = await __test__extractDocument({
      document: { ...fakeReceiptDocument, document_type: 'receipt' },
      bytes: finvoiceBytes(),
      log: console,
      configSnapshot: EINVOICE_FLAG_ON,
      // The lane must return BEFORE any extractor is consulted.
      pickExtractorImpl: () => { throw new Error('pickExtractor must not run on the e-invoice lane'); }
    });
    assert.equal(result.kind, 'completed_header');
    assert.equal(result.header.vendor_name, 'Nordic Cloud Oy');
    assert.equal(result.header.total_amount, 125.5);
    assert.equal(result.summary.document_type, 'supplier_bill');
    assert.equal(result.summary.einvoice.terminal, 'proposal');
    assert.equal(result.model_document_type, 'supplier_bill',
      'the XML content overrides a mis-typed upload via the strong-decision path');
  });

  await test('extractDocument: FI-9 flag ON — non-e-invoice bytes reach the existing pipeline untouched', async () => {
    const result = await __test__extractDocument({
      document: fakeReceiptDocument,
      bytes: Buffer.from('%PDF-1.7 pdf-bytes'),
      log: console,
      configSnapshot: EINVOICE_FLAG_ON,
      pickExtractorImpl: stubPickExtractor({
        type: 'receipt',
        extract: async () => ({ kind: 'completed', header: validHeader, summary: validSummary })
      })
    });
    assert.equal(result.kind, 'completed_header');
    assert.equal(result.summary.document_type, 'receipt', 'the vision path served the PDF as before');
    assert.equal(result.summary.einvoice, undefined);
  });

  await test('extractDocument: FI-9 flag ON — a recognised e-invoice that does not foot escalates (not a parse_error)', async () => {
    const result = await __test__extractDocument({
      document: { ...fakeReceiptDocument, document_type: 'supplier_bill' },
      bytes: finvoiceBytes({ total: '999.00' }),
      log: console,
      configSnapshot: EINVOICE_FLAG_ON,
      pickExtractorImpl: () => { throw new Error('pickExtractor must not run on the e-invoice lane'); }
    });
    assert.equal(result.kind, 'einvoice_escalated');
    assert.equal(result.escalation.reason, 'amount_or_structure_mismatch');
    assert.ok(result.escalation.question, 'carries the drafted owner question');
    assert.equal(result.summary.einvoice.terminal, 'escalate',
      'the persisted verdict says WHY it went to the owner');
  });

  // Audit L2 seam — the worker threads the client's BOOK currency into the
  // bank-statement extractor. Without this, a GB client's Barclays statement
  // was stamped ledger_currency='SGD' at intake regardless of jurisdiction.
  await test('extractDocument: bank statement receives the threaded ledgerCurrency', async () => {
    let received = null;
    await __test__extractDocument({
      document: { ...fakeReceiptDocument, id: 'doc-stmt', document_type: 'bank_statement', filename: 'barclays.pdf' },
      bytes: Buffer.from('%PDF-1.7 statement-bytes'),
      log: console,
      ledgerCurrency: 'GBP',
      pickExtractorImpl: stubPickExtractor({
        type: 'bank_statement',
        extract: async (args) => {
          received = args;
          return { extraction_status: 'insufficient', transactions: [], warnings: [] };
        }
      })
    });
    assert.equal(received?.ledgerCurrency, 'GBP', 'the extractor call carries the book currency');
  });

  // BANK_STATEMENT_LLM_EXTRACTION — plane-native (no env fallback): an
  // acting stage row threads llmFirst=true into the statement extractor;
  // no row leaves the legacy regex-first order byte-identical.
  await test('extractDocument: a BANK_STATEMENT_LLM_EXTRACTION canary row threads llmFirst', async () => {
    let received = null;
    await __test__extractDocument({
      document: { ...fakeReceiptDocument, id: 'doc-stmt-llm', document_type: 'bank_statement', filename: 'tiliote.pdf' },
      bytes: Buffer.from('%PDF-1.7 statement-bytes'),
      log: console,
      configSnapshot: { BANK_STATEMENT_LLM_EXTRACTION: { stage: 'canary', source: 'client' } },
      pickExtractorImpl: stubPickExtractor({
        type: 'bank_statement',
        extract: async (args) => {
          received = args;
          return { extraction_status: 'insufficient', transactions: [], warnings: [] };
        }
      })
    });
    assert.equal(received?.llmFirst, true, 'an acting stage row turns the LLM-first tier on');
  });

  await test('extractDocument: no BANK_STATEMENT_LLM_EXTRACTION row keeps llmFirst off', async () => {
    let received = null;
    await __test__extractDocument({
      document: { ...fakeReceiptDocument, id: 'doc-stmt-legacy', document_type: 'bank_statement', filename: 'tiliote.pdf' },
      bytes: Buffer.from('%PDF-1.7 statement-bytes'),
      log: console,
      configSnapshot: {},
      pickExtractorImpl: stubPickExtractor({
        type: 'bank_statement',
        extract: async (args) => {
          received = args;
          return { extraction_status: 'insufficient', transactions: [], warnings: [] };
        }
      })
    });
    assert.equal(received?.llmFirst, false, 'without a row the flag is OFF — no env pair exists to open it');
  });

  await test('source pin: every markParseSkippedInDb call persists the classification receipt', async () => {
    // Two-surface IA precondition P1 / finding #8: the router's
    // classification must survive the SKIP case — it is the triage
    // record of why a skipped doc has the type it has (a router_error
    // fallback that terminal-skipped as `unknown` was unprovable from
    // the DB without it). The completed paths persist it via
    // result.summary.classification; this pin forbids a skip call site
    // that drops it. Source-level lockstep, same pattern as the
    // post-parse leg-registry pin in parseDocumentStepSplit.test.js.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('./parseDocument.js', import.meta.url)),
      'utf8'
    );
    const callSites = source.split('markParseSkippedInDb({').slice(1);
    // Import + at least the two known skip paths (plain skip, e-invoice).
    assert.ok(callSites.length >= 2, `expected >=2 call sites, saw ${callSites.length}`);
    for (const site of callSites) {
      const body = site.slice(0, site.indexOf('});'));
      assert.match(
        body,
        /summary:\s*\{[^\n]*\bclassification\b/,
        'markParseSkippedInDb call must spread classification into summary'
      );
    }
  });

  console.log(`\nparseDocument (inline runner): ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
};

runTests();
