// Unit tests for the generic document extractor.
//
// Follows the same synthetic-LLM-response pattern as receipt.test.js:
// canned responses fed through the extractor via the __callOpenAi hook.
// Validates pipeline correctness — schema mapping, caps, floor checks,
// error handling, code-name discipline.

import assert from 'node:assert/strict';

import {
  extractGenericDocumentFromBase64,
  __DEFAULT_MODEL,
  __GENERIC_DOCUMENT_EXTRACTION_SCHEMA,
  __mapExtractionToWriterShape
} from './genericDocument.js';

const ORIGINAL_API_KEY = process.env.OPENAI_API_KEY;

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

// Build a fake `Response`-like object that the extractor's
// __callOpenAi hook can return.
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

const validLlmExtraction = {
  extraction_status: 'validated',
  extraction_confidence: 0.85,
  document_type_guess: 'payment_confirmation',
  parties: [
    { name: 'Student Loans Company', role: 'supplier' },
    { name: 'Jane Smith', role: 'customer' }
  ],
  amounts: [
    { value: 350.0, currency: 'GBP', label: 'Monthly repayment amount', role: 'amount_paid' },
    { value: 24500.0, currency: 'GBP', label: 'Outstanding balance', role: 'opening_balance' }
  ],
  dates: [
    { value: '2026-04-02', label: 'Payment date', role: 'payment_date' },
    { value: '2026-05-02', label: 'Next payment due', role: 'due_date' }
  ],
  references: [
    { value: 'SLC-2026-TERM1', type: 'account_number' },
    { value: '9912345678', type: 'account_number' }
  ],
  summary_text: 'Student loan payment confirmation of GBP 350.00 paid to Student Loans Company on 2 April 2026.',
  warnings: []
};

// Most tests just need an OpenAI key set so the unconfigured early-
// return doesn't fire.
const withApiKey = async (fn) => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
};

const runTests = async () => {
  console.log('genericDocument:');

  // ── 1. Returns failed when API key not configured ──────────────────

  await test('1. returns DOCUMENT_EXTRACTION_FAILED when API key not configured', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => {
          throw new Error('should not be called');
        }
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
      // 2026-11-10: the reason names the provider whose key is missing
      // (Anthropic, the lane's first), in the parse wait vocabulary.
      assert.equal(result.reason, 'anthropic_not_configured');
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      if (originalAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  });

  // ── 2. Returns failed on empty base64 ──────────────────────────────

  await test('2. returns DOCUMENT_EXTRACTION_UNREADABLE on empty base64', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: '',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => {
          throw new Error('should not be called for empty input');
        }
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_UNREADABLE');
      assert.equal(result.reason, 'empty_input');
    });
  });

  // ── 3. Extracts parties correctly (payer/payee -> customer/vendor) ──

  await test('3. extracts parties correctly (supplier/customer -> vendor_name/customer_name)', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'loan-confirmation.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      // supplier -> vendor_name
      assert.equal(result.header.vendor_name, 'Student Loans Company');
      // customer -> customer_name (only set when vendor_name is also set)
      assert.equal(result.header.customer_name, 'Jane Smith');
    });
  });

  // ── 4. Maps largest amount to total_amount ─────────────────────────

  await test('4. maps amount_paid role to total_amount (role-gated, not largest)', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      // amount_paid (350.0) wins, NOT largest (24500.0 opening_balance)
      assert.equal(result.header.total_amount, 350.0);
      assert.equal(result.header.currency, 'GBP');
    });
  });

  // ── 5. Maps first date to document_date (validates ISO format) ─────

  await test('5. maps payment_date role to document_date (role-gated with priority)', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      // payment_date (2026-04-02) is used since no document_date or issue_date role
      assert.equal(result.header.document_date, '2026-04-02');
      assert.match(result.header.document_date, /^\d{4}-\d{2}-\d{2}$/);
      // due_date role populates due_date column
      assert.equal(result.header.due_date, '2026-05-02');
    });
  });

  // ── 6. Maps first reference to reference_number ────────────────────

  await test('6. maps first reference to reference_number', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      assert.equal(result.header.reference_number, 'SLC-2026-TERM1');
    });
  });

  // ── 7. Sets document_type to 'generic_document' in summary ────────

  await test('7. sets document_type to generic_document in summary', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      assert.equal(result.summary.document_type, 'generic_document');
    });
  });

  // ── 8. Preserves document_type_guess in summary ────────────────────

  await test('8. preserves document_type_guess in summary', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      assert.equal(result.summary.document_type_guess, 'payment_confirmation');
    });
  });

  // ── 9. Caps parties at 10 ──────────────────────────────────────────

  await test('9. caps parties at 10', async () => {
    await withApiKey(async () => {
      const manyParties = Array.from({ length: 15 }, (_, i) => ({
        name: `Party ${i}`,
        role: 'unknown'
      }));
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          parties: manyParties
        })
      });
      assert.equal(result.kind, 'completed');
      assert.equal(result.summary.parties.length, 10);
    });
  });

  // ── 10. Caps amounts at 20 ────────────────────────────────────────

  await test('10. caps amounts at 20', async () => {
    await withApiKey(async () => {
      const manyAmounts = Array.from({ length: 25 }, (_, i) => ({
        value: (i + 1) * 10,
        currency: 'GBP',
        label: `Amount ${i}`,
        role: 'unknown'
      }));
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          amounts: manyAmounts
        })
      });
      assert.equal(result.kind, 'completed');
      assert.equal(result.summary.amounts.length, 20);
    });
  });

  // ── 11. Caps string lengths (vendor_name at 200, reference at 80) ──

  await test('11. caps string lengths (vendor_name at 200, reference at 80)', async () => {
    await withApiKey(async () => {
      const longName = 'A'.repeat(300);
      const longRef = 'R'.repeat(120);
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          parties: [
            { name: longName, role: 'supplier' }
          ],
          references: [
            { value: longRef, type: 'account_number' }
          ]
        })
      });
      assert.equal(result.kind, 'completed');
      assert.equal(result.header.vendor_name.length, 200);
      assert.equal(result.header.reference_number.length, 80);
    });
  });

  // ── 12. Returns unreadable when confidence below 0.25 ──────────────

  await test('12. returns unreadable when confidence below 0.25', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'blurry.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          extraction_status: 'validated',
          extraction_confidence: 0.15
        })
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_UNREADABLE');
      assert.equal(result.reason, 'low_confidence');
    });
  });

  // ── 13. Returns unreadable when extraction_status is 'failed' ──────

  await test('13. returns unreadable when extraction_status is failed', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'blank.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          extraction_status: 'failed',
          extraction_confidence: 0.05
        })
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_UNREADABLE');
      assert.equal(result.reason, 'extractor_status_failed');
    });
  });

  // ── 14. Handles missing/null parties gracefully ────────────────────

  await test('14. handles missing/null parties gracefully', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          parties: null
        })
      });
      assert.equal(result.kind, 'completed');
      assert.deepEqual(result.summary.parties, []);
      assert.equal(result.header.vendor_name, null);
      assert.equal(result.header.customer_name, null);
    });
  });

  // ── 15. Handles missing/null amounts gracefully ────────────────────

  await test('15. handles missing/null amounts gracefully', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          amounts: null
        })
      });
      assert.equal(result.kind, 'completed');
      assert.deepEqual(result.summary.amounts, []);
      assert.equal(result.header.total_amount, null);
      assert.equal(result.header.currency, null);
    });
  });

  // ── 16. Always returns lines: [] ───────────────────────────────────

  await test('16. always returns lines: []', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      assert.ok(Array.isArray(result.lines), 'lines must be an array');
      assert.equal(result.lines.length, 0);
    });
  });

  // ── 17. Sets payment_status to 'unknown' ──────────────────────────

  await test('17. sets payment_status to unknown', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');
      assert.equal(result.header.payment_status, 'unknown');
    });
  });

  // ── 18. Validates currency as ISO 4217 (3 uppercase letters) ──────

  await test('18. validates currency as ISO 4217 (3 uppercase letters)', async () => {
    await withApiKey(async () => {
      // Valid currency passes through
      const validResult = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(validResult.kind, 'completed');
      assert.equal(validResult.header.currency, 'GBP');

      // Invalid currency → null
      const invalidResult = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          amounts: [
            { value: 100, currency: 'british pounds', label: 'total', role: 'amount_paid' }
          ]
        })
      });
      assert.equal(invalidResult.kind, 'completed');
      assert.equal(invalidResult.header.currency, null, 'unknown currency is persisted honestly, never guessed as GBP');
      assert.equal(invalidResult.summary.amounts[0].currency, null);
      const noAmountResult = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({
          ...validLlmExtraction,
          amounts: []
        })
      });
      assert.equal(noAmountResult.kind, 'completed');
      assert.equal(noAmountResult.header.currency, null);
    });
  });

  // ── 19. Returns failed on API error (non-200 response) ────────────

  await test('19. returns DOCUMENT_EXTRACTION_FAILED on API error (non-200 response)', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => ({ ok: false, status: 500, json: async () => ({}) })
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
      assert.ok(String(result.reason).includes('500'));
    });
  });

  await test('provider 400 -> DOCUMENT_EXTRACTION_REJECTED (terminal, no retry carousel)', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => ({ ok: false, status: 400, json: async () => ({}) })
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_REJECTED');
      assert.ok(String(result.reason).includes('400'));
    });
  });

  // ── 20. Returns failed on invalid JSON response ───────────────────

  await test('20. returns DOCUMENT_EXTRACTION_FAILED on invalid JSON response', async () => {
    await withApiKey(async () => {
      // Case a: response.json() throws
      const resultA = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse({}, { throwOnJson: true })
      });
      assert.equal(resultA.kind, 'failed');
      assert.equal(resultA.code, 'DOCUMENT_EXTRACTION_FAILED');
      assert.equal(resultA.reason, 'response_not_json');

      // Case b: structured output text is not parseable JSON
      const resultB = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ output: [{ content: [{ text: 'not json {{{' }] }] })
        })
      });
      assert.equal(resultB.kind, 'failed');
      assert.equal(resultB.code, 'DOCUMENT_EXTRACTION_FAILED');
      assert.equal(resultB.reason, 'structured_bad_json');
    });
  });

  // ── 21. Summary includes all structured data ──────────────────────

  await test('21. summary includes all structured data (parties, amounts, dates, references)', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => mockOpenAiResponse(validLlmExtraction)
      });
      assert.equal(result.kind, 'completed');

      // Parties preserved
      assert.ok(Array.isArray(result.summary.parties));
      assert.equal(result.summary.parties.length, 2);
      assert.equal(result.summary.parties[0].name, 'Student Loans Company');
      assert.equal(result.summary.parties[0].role, 'supplier');
      assert.equal(result.summary.parties[1].name, 'Jane Smith');
      assert.equal(result.summary.parties[1].role, 'customer');

      // Amounts preserved
      assert.ok(Array.isArray(result.summary.amounts));
      assert.equal(result.summary.amounts.length, 2);
      assert.equal(result.summary.amounts[0].value, 350.0);
      assert.equal(result.summary.amounts[1].value, 24500.0);

      // Dates preserved
      assert.ok(Array.isArray(result.summary.dates));
      assert.equal(result.summary.dates.length, 2);
      assert.equal(result.summary.dates[0].value, '2026-04-02');
      assert.equal(result.summary.dates[1].value, '2026-05-02');

      // References preserved
      assert.ok(Array.isArray(result.summary.references));
      assert.equal(result.summary.references.length, 2);
      assert.equal(result.summary.references[0].value, 'SLC-2026-TERM1');
      assert.equal(result.summary.references[0].type, 'account_number');

      // Summary text preserved
      assert.ok(result.summary.summary_text.includes('Student loan'));

      // Source and document_type
      assert.equal(result.summary.source, 'async_parse');
      assert.equal(result.summary.document_type, 'generic_document');

      // Line counts
      assert.equal(result.summary.line_count, 0);
      assert.equal(result.summary.coded_line_count, 0);
      assert.equal(result.summary.review_line_count, 0);

      // Extraction metadata
      assert.equal(result.summary.extraction_status, 'validated');
      assert.equal(result.summary.extraction_confidence, 0.85);
    });
  });

  // ── Additional edge-case tests ────────────────────────────────────

  await test('non-vendor roles (issuer) do NOT map to vendor_name', async () => {
    // issuer is no longer in VENDOR_ALLOWED_ROLES (only supplier/merchant)
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      parties: [
        { name: 'Council of London', role: 'government_agency' },
        { name: 'John Doe', role: 'customer' }
      ]
    });
    assert.equal(header.vendor_name, null);
    assert.equal(header.customer_name, null); // null because vendor_name is null
  });

  await test('customer_name is null when no vendor_name is set', async () => {
    // Only customer party, no supplier/merchant — vendor_name is null, so
    // customer_name must also be null.
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      parties: [
        { name: 'John Doe', role: 'customer' }
      ]
    });
    assert.equal(header.vendor_name, null);
    assert.equal(header.customer_name, null);
  });

  await test('due_date populated from due_date role; tax_amount always null', async () => {
    const { header } = __mapExtractionToWriterShape(validLlmExtraction);
    // validLlmExtraction has a date with role: 'due_date' (2026-05-02)
    assert.equal(header.due_date, '2026-05-02');
    assert.equal(header.tax_amount, null);
  });

  // ── Payment confirmation: total_amount sign coercion ───────────────
  //
  // Amex 8/18 row regression: the LLM extracted a payment_confirmation
  // with amount_paid = -941.42 (signed to represent the payment outflow
  // direction). total_amount inherited the sign, the matcher tried to
  // compare -941.42 against the bank txn's +941.42, didn't match, and
  // the row stayed unmatched + un-chipped. Fixed by coercing
  // total_amount to its magnitude at the writer boundary for
  // payment_confirmation extractions specifically.

  await test('payment_confirmation: negative amount_paid coerces to positive total_amount', async () => {
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      document_type_guess: 'payment_confirmation',
      amounts: [
        { value: -941.42, currency: 'USD', label: 'Payment Applied', role: 'amount_paid' }
      ]
    });
    assert.equal(header.total_amount, 941.42);
    assert.equal(header.currency, 'USD');
  });

  await test('payment_confirmation: positive amount_paid is unchanged', async () => {
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      document_type_guess: 'payment_confirmation',
      amounts: [
        { value: 941.42, currency: 'USD', label: 'Payment Applied', role: 'amount_paid' }
      ]
    });
    assert.equal(header.total_amount, 941.42);
  });

  await test('payment_confirmation: null total_amount stays null (no extraction)', async () => {
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      document_type_guess: 'payment_confirmation',
      amounts: []
    });
    assert.equal(header.total_amount, null);
  });

  await test('payment_confirmation: zero total_amount stays zero (Math.abs(0) === 0)', async () => {
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      document_type_guess: 'payment_confirmation',
      amounts: [
        { value: 0, currency: 'USD', label: 'No payment', role: 'amount_paid' }
      ]
    });
    assert.equal(header.total_amount, 0);
  });

  await test('payment_confirmation: case-insensitive document_type_guess match', async () => {
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      document_type_guess: 'Payment_Confirmation',
      amounts: [
        { value: -250.0, currency: 'USD', label: 'Payment', role: 'amount_paid' }
      ]
    });
    assert.equal(header.total_amount, 250.0);
  });

  await test('non-payment_confirmation: negative amounts pass through (sign preserved)', async () => {
    // Out of scope for this fix — receipts, bills, etc. can legitimately
    // carry signed amounts (refunds, credits) and must not be silently
    // coerced. Only payment_confirmation triggers the abs.
    const { header } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      document_type_guess: 'receipt',
      amounts: [
        { value: -50.0, currency: 'USD', label: 'Refund', role: 'amount_paid' }
      ]
    });
    assert.equal(header.total_amount, -50.0);
  });

  await test('invalid dates are filtered out', async () => {
    const { header, summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      dates: [
        { value: '30/04/2026', label: 'bad format', role: 'document_date' },
        { value: '2026-05-01', label: 'good format', role: 'document_date' }
      ]
    });
    // Bad date is filtered, so only valid date is 2026-05-01
    assert.equal(summary.dates.length, 1);
    assert.equal(header.document_date, '2026-05-01');
  });

  await test('network error returns DOCUMENT_EXTRACTION_FAILED', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => { throw new Error('ECONNREFUSED'); }
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
      assert.equal(result.reason, 'network_error');
    });
  });

  await test('timeout returns DOCUMENT_EXTRACTION_FAILED with reason=timeout', async () => {
    await withApiKey(async () => {
      const result = await extractGenericDocumentFromBase64({
        base64: 'aGVsbG8=',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      });
      assert.equal(result.kind, 'failed');
      assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
      assert.equal(result.reason, 'timeout');
    });
  });

  await test('JSON schema is strict-mode-compatible (additionalProperties: false everywhere)', () => {
    const visit = (node, path = '$') => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        assert.equal(
          node.additionalProperties,
          false,
          `${path}: additionalProperties must be false for OpenAI strict mode`
        );
        assert.ok(Array.isArray(node.required), `${path}: required must be present`);
        for (const key of Object.keys(node.properties || {})) {
          assert.ok(
            node.required.includes(key),
            `${path}.${key}: strict mode requires every property in required[]`
          );
          visit(node.properties[key], `${path}.${key}`);
        }
      }
      if (node.type === 'array' && node.items) visit(node.items, `${path}[]`);
    };
    visit(__GENERIC_DOCUMENT_EXTRACTION_SCHEMA);
  });

  await test('caps dates at 20', async () => {
    const manyDates = Array.from({ length: 25 }, (_, i) => ({
      value: `2026-01-${String(i + 1).padStart(2, '0')}`,
      label: `Date ${i}`,
      role: 'unknown'
    }));
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      dates: manyDates
    });
    assert.equal(summary.dates.length, 20);
  });

  await test('caps references at 10', async () => {
    const manyRefs = Array.from({ length: 15 }, (_, i) => ({
      value: `REF-${i}`,
      type: 'account_number'
    }));
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      references: manyRefs
    });
    assert.equal(summary.references.length, 10);
  });

  await test('summary_text is capped at 500 chars', () => {
    const longSummary = 'X'.repeat(800);
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      summary_text: longSummary
    });
    assert.ok(summary.summary_text.length <= 500);
  });

  await test('warnings are capped at 6 and string-coerced', () => {
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      warnings: Array.from({ length: 12 }, (_, i) => `w${i}`)
    });
    assert.equal(summary.warnings.length, 6);
    assert.deepEqual(summary.warnings, ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
  });

  await test('invalid party roles are coerced to unknown', () => {
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      parties: [
        { name: 'Test Corp', role: 'INVALID_ROLE' }
      ]
    });
    assert.equal(summary.parties.length, 1);
    assert.equal(summary.parties[0].role, 'unknown');
  });

  await test('amounts with non-numeric values are filtered out', () => {
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      amounts: [
        { value: 'not a number', currency: 'GBP', label: 'bad', role: 'amount_paid' },
        { value: 42, currency: 'GBP', label: 'good', role: 'amount_paid' }
      ]
    });
    assert.equal(summary.amounts.length, 1);
    assert.equal(summary.amounts[0].value, 42);
  });

  // ── Phase 8d wiring: confidence_envelope + decision_lineage ─────────
  // main (PR #170) builds the calibrated confidence envelope and the
  // decision-lineage audit spine inside the generic mapper. These pin
  // that wiring so a refactor can't silently drop either — there was no
  // coverage for them before.

  await test('8d: mapper attaches a calibrated confidence_envelope (green band at 0.85)', () => {
    const { summary } = __mapExtractionToWriterShape(validLlmExtraction);
    assert.ok(summary.confidence_envelope, 'confidence_envelope present');
    assert.equal(summary.confidence_envelope.normalized_confidence, 0.85);
    assert.equal(summary.confidence_envelope.decision_band, 'green');
    assert.equal(summary.confidence_envelope.source, 'extraction');
  });

  await test('8d: low extraction confidence → red band envelope', () => {
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      extraction_confidence: 0.3
    });
    assert.equal(summary.confidence_envelope.decision_band, 'red');
  });

  await test('8d: decision_lineage traces vendor_name to the supplier party (auto_write)', () => {
    const { summary } = __mapExtractionToWriterShape(validLlmExtraction, { modelId: 'test-model-id' });
    assert.ok(Array.isArray(summary.decision_lineage), 'decision_lineage present');
    const vendorEntry = summary.decision_lineage.find((e) => e.target === 'documents.vendor_name');
    assert.ok(vendorEntry, 'vendor lineage entry present');
    assert.equal(vendorEntry.value, 'Student Loans Company');
    assert.equal(vendorEntry.decision_lane, 'auto_write');
    assert.equal(vendorEntry.source_claim.role, 'supplier');
    // the calibrated envelope is carried into the lineage record
    assert.equal(vendorEntry.confidence.band, 'green');
    // the lineage model id is the receipt of the call that ran —
    // threaded in, never hardcoded
    assert.equal(vendorEntry.model_id, 'test-model-id');
  });

  await test('8d: lineage model id falls back to "unknown" when not threaded, never a hardcoded model', () => {
    const { summary } = __mapExtractionToWriterShape(validLlmExtraction);
    const vendorEntry = summary.decision_lineage.find((e) => e.target === 'documents.vendor_name');
    assert.equal(vendorEntry.model_id, 'unknown');
  });

  await test('default model is the strong tier, not nano (Failure A anti-pattern)', () => {
    assert.equal(__DEFAULT_MODEL, 'gpt-5.4');
    assert.ok(!__DEFAULT_MODEL.includes('nano'));
  });

  await test('8d: decision_lineage traces total_amount to amount_paid (priority over balance)', () => {
    const { summary } = __mapExtractionToWriterShape(validLlmExtraction);
    const amountEntry = summary.decision_lineage.find((e) => e.target === 'documents.total_amount');
    assert.ok(amountEntry, 'total_amount lineage entry present');
    assert.equal(amountEntry.value, 350.0, 'amount_paid wins, not the larger opening_balance');
    assert.equal(amountEntry.source_claim.role, 'amount_paid');
  });

  await test('8d: disallowed-only party → vendor lineage is a skip with policy blocker', () => {
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      parties: [{ name: 'HMRC', role: 'government_agency' }]
    });
    const vendorEntry = summary.decision_lineage.find((e) => e.target === 'documents.vendor_name');
    assert.ok(vendorEntry, 'vendor lineage entry present even when skipped');
    assert.equal(vendorEntry.decision_lane, 'skipped');
    assert.equal(vendorEntry.skip_reason, 'no_party_with_allowed_role');
    assert.ok(vendorEntry.policy_blockers_triggered.includes('disallowed_party_role'));
  });

  await test('8d: disallowed-only amount → total_amount lineage is a skip', () => {
    const { summary } = __mapExtractionToWriterShape({
      ...validLlmExtraction,
      amounts: [{ value: 24500, currency: 'GBP', label: 'Outstanding balance', role: 'opening_balance' }]
    });
    const amountEntry = summary.decision_lineage.find((e) => e.target === 'documents.total_amount');
    assert.ok(amountEntry, 'total_amount lineage entry present even when skipped');
    assert.equal(amountEntry.decision_lane, 'skipped');
  });

  console.log(`\ngenericDocument: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
};

runTests();

// Keep linter happy.
void ORIGINAL_API_KEY;
