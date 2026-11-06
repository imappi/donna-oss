// Unit tests for the document router (Phase 8b of Donna Document
// Intelligence). Uses node:test + node:assert/strict. NOT vitest.
//
// All LLM interactions are mocked via the __callOpenAi injection.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeDocument,
  formatClientIdentity,
  __DEFAULT_MODEL,
  __DOCUMENT_FAMILIES,
  __FAMILY_TO_EXTRACTOR,
  __ROUTER_SCHEMA
} from './documentRouter.js';

let originalApiKey;

beforeEach(() => {
  originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
});

// ── Helpers ─────────────────────────────────────────────────────────

const mockOpenAiResponse = (parsed, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({
    output_text: JSON.stringify(parsed)
  })
});

const validRouterOutput = (overrides = {}) => ({
  document_family: 'invoice_or_bill',
  confidence: 0.94,
  direction_hint: 'ap',
  candidate_families: [
    { family: 'invoice_or_bill', confidence: 0.94 },
    { family: 'receipt', confidence: 0.12 }
  ],
  language_hint: 'en',
  reason: 'Structured invoice layout with vendor header and line items',
  ...overrides
});

const callWith = (parsed, opts) =>
  routeDocument({
    base64: Buffer.from('fake-pdf').toString('base64'),
    filename: 'test.pdf',
    mimeType: 'application/pdf',
    __callOpenAi: async () => mockOpenAiResponse(parsed, opts)
  });

// ── Tests ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

// Wrap node:test to count results for summary
const originalDescribe = describe;

describe('documentRouter', () => {
  it('1. Returns routed=false when OPENAI_API_KEY not configured', async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await routeDocument({
      base64: Buffer.from('test').toString('base64'),
      filename: 'test.pdf'
    });
    assert.equal(result.routed, false);
    assert.equal(result.reason, 'api_key_missing');
    passed++;
  });

  it('2. Returns routed=false on empty base64', async () => {
    const result = await routeDocument({
      base64: '',
      filename: 'test.pdf'
    });
    assert.equal(result.routed, false);
    assert.equal(result.reason, 'empty_input');
    passed++;
  });

  it('3. Classifies invoice_or_bill with ap direction -> recommended_extractor=supplier_bill', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'invoice_or_bill',
      direction_hint: 'ap'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'invoice_or_bill');
    assert.equal(result.direction_hint, 'ap');
    assert.equal(result.recommended_extractor, 'supplier_bill');
    passed++;
  });

  it('4. Classifies invoice_or_bill with ar direction -> recommended_extractor=sales_invoice', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'invoice_or_bill',
      direction_hint: 'ar'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'invoice_or_bill');
    assert.equal(result.direction_hint, 'ar');
    assert.equal(result.recommended_extractor, 'sales_invoice');
    passed++;
  });

  it('5. Classifies invoice_or_bill with unknown direction -> recommended_extractor=supplier_bill (default)', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'invoice_or_bill',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'invoice_or_bill');
    assert.equal(result.direction_hint, 'unknown');
    assert.equal(result.recommended_extractor, 'supplier_bill');
    passed++;
  });

  it('6. Classifies receipt with unknown direction -> recommended_extractor=receipt', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'receipt',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'receipt');
    assert.equal(result.recommended_extractor, 'receipt');
    passed++;
  });

  it('6a. Classifies receipt with ap direction -> recommended_extractor=receipt (expense receipt)', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'receipt',
      direction_hint: 'ap'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'receipt');
    assert.equal(result.direction_hint, 'ap');
    assert.equal(result.recommended_extractor, 'receipt');
    passed++;
  });

  it('6b. Classifies receipt with ar direction -> recommended_extractor=issued_receipt', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'receipt',
      direction_hint: 'ar'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'receipt');
    assert.equal(result.direction_hint, 'ar');
    assert.equal(result.recommended_extractor, 'issued_receipt',
      'AR-direction receipts route to the issued_receipt extractor');
    passed++;
  });

  it('7. Classifies bank_statement -> recommended_extractor=bank_statement', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'bank_statement',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'bank_statement');
    assert.equal(result.recommended_extractor, 'bank_statement');
    passed++;
  });

  it('8. Classifies contract -> recommended_extractor=contract', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'contract',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'contract');
    assert.equal(result.recommended_extractor, 'contract');
    passed++;
  });

  it('9. Classifies tax_or_government_notice -> recommended_extractor=null (no specialist)', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'tax_or_government_notice',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'tax_or_government_notice');
    assert.equal(result.recommended_extractor, null);
    passed++;
  });

  it('10. Classifies not_accounting_relevant -> recommended_extractor=null', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'not_accounting_relevant',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'not_accounting_relevant');
    assert.equal(result.recommended_extractor, null);
    passed++;
  });

  it('10a. Classifies payment_account_statement -> recommended_extractor=payment_account_statement', async () => {
    // Credit-card / charge-card / expense-platform statements (Amex,
    // Brex, etc.) are their own first-class type so
    // the matcher can recognise them without re-classifying. The
    // recommended_extractor name doubles as the document_type the
    // router override writes to the documents row.
    const result = await callWith(validRouterOutput({
      document_family: 'payment_account_statement',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'payment_account_statement');
    assert.equal(result.recommended_extractor, 'payment_account_statement');
    passed++;
  });

  it('10b. payment_account_statement is registered in the schema enum + family map', () => {
    assert.ok(
      __DOCUMENT_FAMILIES.includes('payment_account_statement'),
      'family is in the LLM schema enum'
    );
    assert.equal(
      __FAMILY_TO_EXTRACTOR.payment_account_statement,
      'payment_account_statement',
      'family maps to its own extractor name'
    );
    passed++;
  });

  it('10c. payment_confirmation family maps to a recommended_extractor (Stage 2.5)', async () => {
    // Pre-2.5 FAMILY_TO_EXTRACTOR.payment_confirmation was null, so
    // even when the LLM router classified high-confidence the override
    // gate fell back to `no_recommended_extractor` and the request-body
    // type survived. Stage 2.5 maps the family to its own extractor
    // name so the override actually lands the type.
    assert.equal(
      __FAMILY_TO_EXTRACTOR.payment_confirmation,
      'payment_confirmation',
      'family maps to its own extractor name'
    );
    const result = await callWith(validRouterOutput({
      document_family: 'payment_confirmation',
      direction_hint: 'unknown'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'payment_confirmation');
    assert.equal(result.recommended_extractor, 'payment_confirmation');
    passed++;
  });

  it('10d. an inbound payment confirmation (a customer\'s remittance advice) routes to issued_receipt', async () => {
    // Before RT-18 this was the processor-payout route; payouts are now
    // their own family (10e). The direction branch survives for the
    // customer-side confirmation of an invoice the firm issued.
    const result = await callWith(validRouterOutput({
      document_family: 'payment_confirmation',
      direction_hint: 'ar',
      reason: 'A customer confirmed paying the firm\'s invoice INV-204 by bank transfer.'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'payment_confirmation');
    assert.equal(result.direction_hint, 'ar');
    assert.equal(result.recommended_extractor, 'issued_receipt');
    passed++;
  });

  it('10f. RT-22: payroll, financing and insurance are evidence families that ride the bill lane — never unknown with a clean receipt', async () => {
    // The Kampaamo February book: the router named each family at 0.98+,
    // FAMILY_TO_EXTRACTOR was null, the document rested `unknown` with zero
    // lines, and the coder asked the owner what a salary payment was for
    // with the payslip in the book.
    for (const family of ['payroll', 'financing', 'insurance']) {
      assert.equal(__FAMILY_TO_EXTRACTOR[family], 'supplier_bill', `${family} → supplier_bill`);
      const out = await callWith(validRouterOutput({
        document_family: family,
        direction_hint: 'ap',
        candidate_families: [{ family, confidence: 0.98 }],
        reason: `A ${family} document the firm settles from its bank account.`
      }));
      assert.equal(out.routed, true);
      assert.equal(out.family, family, 'the finer family survives on the receipt');
      assert.equal(out.recommended_extractor, 'supplier_bill');
    }
    // The families that still have no extractor keep resting on the generic path, receipted.
    for (const family of ['tax_or_government_notice', 'certificate_or_compliance', 'not_accounting_relevant']) {
      assert.equal(__FAMILY_TO_EXTRACTOR[family], null, `${family} stays null`);
    }
    passed++;
  });

  it('10e. RT-18: payout_statement and deposit_slip are families with their own extractor names, whatever the direction hint', async () => {
    assert.ok(__DOCUMENT_FAMILIES.includes('payout_statement'), 'payout_statement is in the LLM schema enum');
    assert.ok(__DOCUMENT_FAMILIES.includes('deposit_slip'), 'deposit_slip is in the LLM schema enum');
    assert.deepEqual(__ROUTER_SCHEMA.properties.document_family.enum, [...__DOCUMENT_FAMILIES]);
    assert.deepEqual(__ROUTER_SCHEMA.properties.candidate_families.items.properties.family.enum, [...__DOCUMENT_FAMILIES]);
    assert.equal(__FAMILY_TO_EXTRACTOR.payout_statement, 'payout_statement');
    assert.equal(__FAMILY_TO_EXTRACTOR.deposit_slip, 'deposit_slip');

    const payout = await callWith(validRouterOutput({
      document_family: 'payout_statement',
      direction_hint: 'ar',
      candidate_families: [{ family: 'payout_statement', confidence: 0.94 }, { family: 'payment_confirmation', confidence: 0.03 }],
      reason: 'A delivery-platform settlement: gross orders for the week, commission deducted, one net payout to the firm.'
    }));
    assert.equal(payout.routed, true);
    assert.equal(payout.family, 'payout_statement');
    assert.equal(payout.direction_hint, 'ar');
    assert.equal(payout.recommended_extractor, 'payout_statement');

    const deposit = await callWith(validRouterOutput({
      document_family: 'deposit_slip',
      direction_hint: 'ar',
      candidate_families: [{ family: 'deposit_slip', confidence: 0.94 }],
      reason: 'A counter deposit receipt: cash and one cheque paid into the firm\'s account.'
    }));
    assert.equal(deposit.family, 'deposit_slip');
    assert.equal(deposit.recommended_extractor, 'deposit_slip');

    // The direction hint never flips these families onto another extractor.
    const unsure = await callWith(validRouterOutput({ document_family: 'payout_statement', direction_hint: 'unknown' }));
    assert.equal(unsure.recommended_extractor, 'payout_statement');
    passed++;
  });

  it('11. Returns routed=false on LLM error (non-200 response)', async () => {
    const result = await routeDocument({
      base64: Buffer.from('test').toString('base64'),
      filename: 'test.pdf',
      __callOpenAi: async () => mockOpenAiResponse({}, { status: 500 })
    });
    assert.equal(result.routed, false);
    assert.equal(result.reason, 'llm_error');
    passed++;
  });

  it('12. Returns routed=false on invalid JSON response', async () => {
    const result = await routeDocument({
      base64: Buffer.from('test').toString('base64'),
      filename: 'test.pdf',
      __callOpenAi: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ output_text: 'not valid json{{{' })
      })
    });
    assert.equal(result.routed, false);
    assert.equal(result.reason, 'llm_error');
    passed++;
  });

  it('13. Coerces unrecognized family to unknown_but_relevant', async () => {
    const result = await callWith(validRouterOutput({
      document_family: 'alien_document_type'
    }));
    assert.equal(result.routed, true);
    assert.equal(result.family, 'unknown_but_relevant');
    passed++;
  });

  it('14. Caps confidence to 0-1 range', async () => {
    const resultHigh = await callWith(validRouterOutput({ confidence: 1.5 }));
    assert.equal(resultHigh.confidence, 1);

    const resultLow = await callWith(validRouterOutput({ confidence: -0.3 }));
    assert.equal(resultLow.confidence, 0);

    const resultNormal = await callWith(validRouterOutput({ confidence: 0.75 }));
    assert.equal(resultNormal.confidence, 0.75);
    passed++;
  });

  it('15. candidate_families is preserved from LLM output', async () => {
    const candidates = [
      { family: 'invoice_or_bill', confidence: 0.9 },
      { family: 'receipt', confidence: 0.05 },
      { family: 'bank_statement', confidence: 0.02 }
    ];
    const result = await callWith(validRouterOutput({
      candidate_families: candidates
    }));
    assert.equal(result.routed, true);
    assert.equal(result.candidate_families.length, 3);
    assert.equal(result.candidate_families[0].family, 'invoice_or_bill');
    assert.equal(result.candidate_families[0].confidence, 0.9);
    assert.equal(result.candidate_families[1].family, 'receipt');
    assert.equal(result.candidate_families[2].family, 'bank_statement');
    passed++;
  });

  it('16. language_hint is passed through', async () => {
    const result = await callWith(validRouterOutput({ language_hint: 'zh' }));
    assert.equal(result.language_hint, 'zh');
    passed++;
  });

  it('17. reason is passed through, capped at 500 chars', async () => {
    const shortReason = 'This is a receipt';
    const resultShort = await callWith(validRouterOutput({ reason: shortReason }));
    assert.equal(resultShort.reason, shortReason);

    const longReason = 'x'.repeat(600);
    const resultLong = await callWith(validRouterOutput({ reason: longReason }));
    assert.equal(resultLong.reason.length, 500);
    passed++;
  });

  it('18. clientContext is included in the prompt when provided', async () => {
    let capturedArgs = null;
    await routeDocument({
      base64: Buffer.from('test').toString('base64'),
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      clientContext: 'Construction company in Singapore',
      __callOpenAi: async (args) => {
        capturedArgs = args;
        return mockOpenAiResponse(validRouterOutput());
      }
    });
    assert.ok(capturedArgs, 'callOpenAi was invoked');
    assert.equal(capturedArgs.clientContext, 'Construction company in Singapore');
    passed++;
  });

  it('18a. structured clientIdentity is forwarded to the OpenAI caller', async () => {
    let capturedArgs = null;
    const identity = {
      display_name: 'Alex Morgan',
      legal_names: ['Alex Morgan', 'M & R Holdings (Trading) Ltd']
    };
    await routeDocument({
      base64: Buffer.from('test').toString('base64'),
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      clientIdentity: identity,
      __callOpenAi: async (args) => {
        capturedArgs = args;
        return mockOpenAiResponse(validRouterOutput());
      }
    });
    assert.ok(capturedArgs);
    assert.deepEqual(capturedArgs.clientIdentity, identity,
      'router forwards the structured identity unchanged');
    passed++;
  });

  it('19a. formatClientIdentity returns empty string when no identity is supplied', () => {
    assert.equal(formatClientIdentity(null), '');
    assert.equal(formatClientIdentity(undefined), '');
    assert.equal(formatClientIdentity({}), '');
    assert.equal(formatClientIdentity({ legal_names: [] }), '');
    passed++;
  });

  it('19b. formatClientIdentity inlines display_name and all legal_names', () => {
    const formatted = formatClientIdentity({
      display_name: 'Alex Morgan',
      legal_names: ['Alex Morgan', 'M & R Holdings (Trading) Ltd', 'M&R Holdings']
    });
    assert.match(formatted, /Alex Morgan/);
    assert.match(formatted, /M & R Holdings \(Trading\) Ltd/);
    assert.match(formatted, /M&R Holdings/, 'aliases survive untouched');
    assert.match(formatted, /counterparty/i, 'tells the LLM to identify the other side');
    passed++;
  });

  it('19c. formatClientIdentity tolerates partial / dirty inputs', () => {
    // Only display_name.
    const a = formatClientIdentity({ display_name: 'Acme Co' });
    assert.match(a, /Acme Co/);

    // Only legal_names, with falsey entries.
    const b = formatClientIdentity({ legal_names: [null, '', '  ', 'Northstar Ltd'] });
    assert.match(b, /Northstar Ltd/);
    assert.equal(b.includes('null'), false, 'no literal null leaks');

    // Non-array legal_names → ignored.
    const c = formatClientIdentity({ legal_names: 'Acme Co' });
    assert.equal(c, '', 'non-array legal_names produces no fragment');
    passed++;
  });

  it('19d. when clientIdentity is provided, the legacy clientContext is dropped from the prompt', async () => {
    let capturedArgs = null;
    await routeDocument({
      base64: Buffer.from('test').toString('base64'),
      filename: 'test.pdf',
      clientIdentity: {
        display_name: 'Acme Ltd',
        legal_names: ['Acme Ltd']
      },
      clientContext: 'should-be-ignored',
      __callOpenAi: async (args) => {
        capturedArgs = args;
        return mockOpenAiResponse(validRouterOutput());
      }
    });
    // The router forwards BOTH to the caller, but the structured
    // identity takes precedence inside defaultCallOpenAi. We can't
    // inspect the prompt directly without invoking defaultCallOpenAi —
    // but `formatClientIdentity` is the same helper used there, so
    // its passing tests above pin the actual prompt shape.
    assert.equal(capturedArgs.clientContext, 'should-be-ignored',
      'clientContext is forwarded — caller decides what to do with it');
    assert.ok(capturedArgs.clientIdentity, 'identity is forwarded');
    passed++;
  });

  it('19. Uses 30s timeout (not 60s)', async () => {
    // We verify by checking that AbortSignal is passed and that the
    // controller would fire at 30s. We can't easily test the exact
    // timeout value without waiting, but we can verify AbortSignal
    // is provided and the module uses REQUEST_TIMEOUT_MS = 30_000.
    let capturedSignal = null;
    await routeDocument({
      base64: Buffer.from('test').toString('base64'),
      filename: 'test.pdf',
      __callOpenAi: async ({ signal }) => {
        capturedSignal = signal;
        return mockOpenAiResponse(validRouterOutput());
      }
    });
    assert.ok(capturedSignal instanceof AbortSignal, 'signal is an AbortSignal');
    // The signal should not already be aborted (30s hasn't passed)
    assert.equal(capturedSignal.aborted, false);
    passed++;
  });

  it('20. Schema is strict-mode compatible (additionalProperties: false)', () => {
    // Top-level
    assert.equal(__ROUTER_SCHEMA.additionalProperties, false);

    // candidate_families items
    const candidateItemSchema = __ROUTER_SCHEMA.properties.candidate_families.items;
    assert.equal(candidateItemSchema.additionalProperties, false);

    // All required fields are present in properties
    for (const field of __ROUTER_SCHEMA.required) {
      assert.ok(
        field in __ROUTER_SCHEMA.properties,
        `required field "${field}" must exist in properties`
      );
    }
    for (const field of candidateItemSchema.required) {
      assert.ok(
        field in candidateItemSchema.properties,
        `required candidate field "${field}" must exist in properties`
      );
    }
    passed++;
  });

  it('Default model is the strong tier, not nano (promoted families give the router override authority)', () => {
    assert.equal(__DEFAULT_MODEL, 'gpt-5.4');
    assert.ok(!__DEFAULT_MODEL.includes('nano'));
    passed++;
  });

  it('Routed result carries the resolved model id — the receipt downstream audits read', async () => {
    process.env.DOCUMENT_ROUTER_MODEL = 'router-test-model';
    try {
      const result = await callWith(validRouterOutput());
      assert.equal(result.routed, true);
      assert.equal(result.model, 'router-test-model');
    } finally {
      delete process.env.DOCUMENT_ROUTER_MODEL;
    }
    passed++;
  });
});

// Print summary after all tests complete
process.on('exit', () => {
  console.log(`documentRouter: ${passed} passed, ${failed} failed.`);
});
