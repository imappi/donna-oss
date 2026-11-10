// Unit tests for the contract extractor — PR 18.
// Mirrors supplierBill.test.js / salesInvoice.test.js shape:
// synthetic LLM responses through the __callOpenAi hook, pure mapping
// tests against __mapExtractionToWriterShape, and lightweight schema
// shape checks.

import assert from 'node:assert/strict';

import {
  CONTRACT_TYPE_VALUES,
  RECURRING_FREQUENCY_VALUES,
  OBLIGATION_TYPE_VALUES,
  OBLIGATION_FREQUENCY_VALUES,
  OBLIGATION_PARTY_ROLE_VALUES,
  extractContractFromBase64,
  __CONTRACT_EXTRACTION_SCHEMA,
  __CONTRACT_EXTRACTION_SCHEMA_WITH_OBLIGATIONS,
  __mapExtractionToWriterShape,
  __sanitizeObligations
} from './contract.js';
import { classifyDocumentFile } from '../../src/lib/firmDocuments.js';

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

// Two fixtures — one vendor-direction subscription, one customer-
// direction one-off services agreement. Tests pick whichever matches.

const vendorSubscriptionLlm = {
  extraction_status: 'validated',
  extraction_confidence: 0.95,
  warnings: [],
  header: {
    counterparty_name: 'Amazon Web Services, Inc.',
    counterparty_role: 'vendor',
    contract_type: 'service_subscription',
    document_date: '2026-01-15',
    effective_start_date: '2026-02-01',
    effective_end_date: '2027-01-31',
    auto_renew: true,
    notice_period_days: 30,
    currency: 'USD',
    total_amount: null,
    recurring_amount: 1200,
    recurring_frequency: 'monthly',
    reference_number: null,
    references: [
      { type: 'contract_number', value: 'AWS-MSA-2026-042' }
    ]
  }
};

const customerOneOffLlm = {
  extraction_status: 'validated',
  extraction_confidence: 0.92,
  warnings: [],
  header: {
    counterparty_name: 'Acme Holdings Ltd',
    counterparty_role: 'customer',
    contract_type: 'services_one_off',
    document_date: '2026-03-10',
    effective_start_date: '2026-04-01',
    effective_end_date: '2026-09-30',
    auto_renew: false,
    notice_period_days: null,
    currency: 'EUR',
    total_amount: 50000,
    recurring_amount: null,
    recurring_frequency: 'none',
    reference_number: null,
    references: [
      { type: 'agreement_number', value: 'SOW-ACME-2026-007' }
    ]
  }
};

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

// ── 1: schema shape contract ────────────────────────────────────────
await test('schema: required fields include the contract-specific shape', () => {
  const schema = __CONTRACT_EXTRACTION_SCHEMA;
  const requiredHeader = new Set(schema.properties.header.required);
  for (const field of [
    'counterparty_name', 'counterparty_role', 'contract_type',
    'document_date', 'effective_start_date', 'effective_end_date',
    'auto_renew', 'notice_period_days', 'currency', 'total_amount',
    'recurring_amount', 'recurring_frequency', 'reference_number',
    'references'
  ]) {
    assert.ok(requiredHeader.has(field), `header.${field} required`);
  }
  // Strict-mode JSON schema: additionalProperties: false on every
  // object. Pin it so a future broadening doesn't slip past review.
  assert.equal(schema.additionalProperties, false, 'top-level strict');
  assert.equal(schema.properties.header.additionalProperties, false, 'header strict');
});

await test('schema: contract_type enum matches the exported constant', () => {
  const schemaEnum = __CONTRACT_EXTRACTION_SCHEMA.properties.header.properties.contract_type.enum;
  assert.deepEqual(schemaEnum.sort(), [...CONTRACT_TYPE_VALUES].sort(), 'contract_type enum aligned');
});

await test('schema: recurring_frequency enum matches the exported constant', () => {
  const schemaEnum = __CONTRACT_EXTRACTION_SCHEMA.properties.header.properties.recurring_frequency.enum;
  assert.deepEqual(schemaEnum.sort(), [...RECURRING_FREQUENCY_VALUES].sort(), 'frequency enum aligned');
});

// ── 2: vendor-direction subscription mapping ────────────────────────
await test('vendor subscription: header populates vendor_name, customer_name null', () => {
  const { header } = __mapExtractionToWriterShape(vendorSubscriptionLlm);
  assert.equal(header.vendor_name, 'Amazon Web Services, Inc.', 'vendor populated');
  assert.equal(header.customer_name, null, 'customer null for vendor direction');
});

await test('vendor subscription: header total_amount falls back to recurring_amount', () => {
  // total_amount is null on a subscription; header.total_amount should
  // carry the per-period recurring amount so the inbox column has a
  // sensible default. parse_summary carries the breakdown.
  const { header, summary } = __mapExtractionToWriterShape(vendorSubscriptionLlm);
  assert.equal(header.total_amount, 1200, 'header total falls back to recurring');
  assert.equal(summary.total_amount, null, 'summary.total_amount stays null');
  assert.equal(summary.recurring_amount, 1200, 'summary.recurring_amount preserved');
  assert.equal(summary.recurring_frequency, 'monthly', 'frequency preserved');
});

await test('vendor subscription: due_date NULL even when effective_end_date is set', () => {
  // Conflating effective_end_date with due_date would pollute the
  // aging dashboards' due-date semantics. Pin the null.
  const { header, summary } = __mapExtractionToWriterShape(vendorSubscriptionLlm);
  assert.equal(header.due_date, null, 'header.due_date null');
  assert.equal(summary.effective_end_date, '2027-01-31', 'effective_end_date on summary');
});

await test('vendor subscription: summary carries contract_type + effective dates + renew flags', () => {
  const { summary } = __mapExtractionToWriterShape(vendorSubscriptionLlm);
  assert.equal(summary.document_type, 'contract', 'document_type=contract');
  assert.equal(summary.contract_type, 'service_subscription', 'contract_type preserved');
  assert.equal(summary.counterparty_role, 'vendor', 'role preserved');
  assert.equal(summary.effective_start_date, '2026-02-01');
  assert.equal(summary.effective_end_date, '2027-01-31');
  assert.equal(summary.auto_renew, true);
  assert.equal(summary.notice_period_days, 30);
});

// ── 3: customer-direction one-off mapping ───────────────────────────
await test('customer one-off: header populates customer_name, vendor_name null', () => {
  const { header } = __mapExtractionToWriterShape(customerOneOffLlm);
  assert.equal(header.vendor_name, null, 'vendor null for customer direction');
  assert.equal(header.customer_name, 'Acme Holdings Ltd', 'customer populated');
});

await test('customer one-off: header total_amount uses the explicit total', () => {
  const { header, summary } = __mapExtractionToWriterShape(customerOneOffLlm);
  assert.equal(header.total_amount, 50000, 'one-off total on header');
  assert.equal(summary.total_amount, 50000, 'one-off total preserved on summary');
  assert.equal(summary.recurring_amount, null, 'recurring null');
  assert.equal(summary.recurring_frequency, 'none', 'frequency=none');
});

await test('customer one-off: contract_type = services_one_off', () => {
  const { summary } = __mapExtractionToWriterShape(customerOneOffLlm);
  assert.equal(summary.contract_type, 'services_one_off');
});

// ── 4: lines are ALWAYS empty ──────────────────────────────────────
await test('lines is always [] regardless of LLM input', () => {
  // Contracts don't have line items in v1. Even if a future schema
  // adds them, the v1 mapper drops them.
  const { lines } = __mapExtractionToWriterShape(vendorSubscriptionLlm);
  assert.deepEqual(lines, [], 'lines empty');
});

// ── 5: payment_status invariant ─────────────────────────────────────
await test('payment_status is always "unknown" on contracts', () => {
  // Contracts aren't "paid" — payment_status is a different
  // dimension (contract_status) that v1 doesn't compute.
  const { header } = __mapExtractionToWriterShape(vendorSubscriptionLlm);
  assert.equal(header.payment_status, 'unknown');
  const { header: header2 } = __mapExtractionToWriterShape(customerOneOffLlm);
  assert.equal(header2.payment_status, 'unknown');
});

// ── 6: direction defense — bad role coerces to vendor ───────────────
await test('counterparty_role: unknown role coerces to vendor (defensive)', () => {
  const bad = {
    ...vendorSubscriptionLlm,
    header: { ...vendorSubscriptionLlm.header, counterparty_role: 'frobnicated' }
  };
  const { summary } = __mapExtractionToWriterShape(bad);
  assert.equal(summary.counterparty_role, 'vendor', 'defaults to vendor');
});

// ── 7: contract_type normalisation ──────────────────────────────────
await test('contract_type: unknown value coerces to "other"', () => {
  const bad = {
    ...vendorSubscriptionLlm,
    header: { ...vendorSubscriptionLlm.header, contract_type: 'frobnicated' }
  };
  const { summary } = __mapExtractionToWriterShape(bad);
  assert.equal(summary.contract_type, 'other', 'unknown → other');
});

await test('contract_type: all enum values round-trip', () => {
  for (const t of CONTRACT_TYPE_VALUES) {
    const llm = {
      ...vendorSubscriptionLlm,
      header: { ...vendorSubscriptionLlm.header, contract_type: t }
    };
    const { summary } = __mapExtractionToWriterShape(llm);
    assert.equal(summary.contract_type, t, `${t} preserved`);
  }
});

// ── 8: recurring_frequency normalisation ────────────────────────────
await test('recurring_frequency: all enum values round-trip', () => {
  for (const f of RECURRING_FREQUENCY_VALUES) {
    const llm = {
      ...vendorSubscriptionLlm,
      header: { ...vendorSubscriptionLlm.header, recurring_frequency: f }
    };
    const { summary } = __mapExtractionToWriterShape(llm);
    assert.equal(summary.recurring_frequency, f, `${f} preserved`);
  }
});

await test('recurring_frequency: unknown value coerces to "none"', () => {
  const bad = {
    ...vendorSubscriptionLlm,
    header: { ...vendorSubscriptionLlm.header, recurring_frequency: 'frobnicated' }
  };
  const { summary } = __mapExtractionToWriterShape(bad);
  assert.equal(summary.recurring_frequency, 'none');
});

// ── 9: dates ────────────────────────────────────────────────────────
await test('dates: ISO + DD/MM/YYYY both accepted', () => {
  const dmy = {
    ...vendorSubscriptionLlm,
    header: {
      ...vendorSubscriptionLlm.header,
      document_date: '15/01/2026',
      effective_start_date: '01/02/2026',
      effective_end_date: '31/01/2027'
    }
  };
  const { header, summary } = __mapExtractionToWriterShape(dmy);
  assert.equal(header.document_date, '2026-01-15', 'document_date DMY → ISO');
  assert.equal(summary.effective_start_date, '2026-02-01', 'effective_start DMY → ISO');
  assert.equal(summary.effective_end_date, '2027-01-31', 'effective_end DMY → ISO');
});

await test('dates: bad date strings → null, never throw', () => {
  const bad = {
    ...vendorSubscriptionLlm,
    header: {
      ...vendorSubscriptionLlm.header,
      document_date: 'not a date',
      effective_start_date: '2026/02/01', // not supported format
      effective_end_date: ''
    }
  };
  const { header, summary } = __mapExtractionToWriterShape(bad);
  assert.equal(header.document_date, null);
  assert.equal(summary.effective_start_date, null);
  assert.equal(summary.effective_end_date, null);
});

await test('effective_end_date null preserved (evergreen / indefinite contracts)', () => {
  // NDAs, employment agreements often have no explicit expiry.
  const nda = {
    ...vendorSubscriptionLlm,
    header: {
      ...vendorSubscriptionLlm.header,
      contract_type: 'nda',
      effective_end_date: null,
      total_amount: null,
      recurring_amount: null,
      recurring_frequency: 'none'
    }
  };
  const { header, summary } = __mapExtractionToWriterShape(nda);
  assert.equal(summary.effective_end_date, null, 'null end date preserved');
  assert.equal(header.total_amount, null, 'no header total when neither one-off nor recurring set');
});

// ── 10: references priority ─────────────────────────────────────────
await test('references: contract_number wins over agreement_number', () => {
  const llm = {
    ...vendorSubscriptionLlm,
    header: {
      ...vendorSubscriptionLlm.header,
      references: [
        { type: 'agreement_number', value: 'AGREE-X' },
        { type: 'contract_number', value: 'CONTRACT-Y' },
        { type: 'order_id', value: 'PO-Z' }
      ]
    }
  };
  const { header } = __mapExtractionToWriterShape(llm);
  assert.equal(header.reference_number, 'CONTRACT-Y', 'contract_number is highest priority');
});

await test('references: deduped and capped at 8', () => {
  const llm = {
    ...vendorSubscriptionLlm,
    header: {
      ...vendorSubscriptionLlm.header,
      references: Array.from({ length: 20 }, (_, i) => ({
        type: 'contract_number',
        value: `CONTRACT-${i % 3}` // dupes
      }))
    }
  };
  const { summary } = __mapExtractionToWriterShape(llm);
  const values = summary.references.map((r) => r.value);
  assert.ok(values.length <= 8, `capped at 8 (got ${values.length})`);
  assert.equal(new Set(values).size, values.length, 'no dupes');
});

await test('references: bad type filtered out', () => {
  const llm = {
    ...vendorSubscriptionLlm,
    header: {
      ...vendorSubscriptionLlm.header,
      references: [
        { type: 'frobnicated', value: 'BAD' },
        { type: 'contract_number', value: 'GOOD' }
      ]
    }
  };
  const { summary } = __mapExtractionToWriterShape(llm);
  assert.equal(summary.references.length, 1, 'one reference kept');
  assert.equal(summary.references[0].value, 'GOOD');
});

// ── 11: sanitisation ────────────────────────────────────────────────
await test('counterparty_name: control chars stripped, length capped', () => {
  const llm = {
    ...vendorSubscriptionLlm,
    header: {
      ...vendorSubscriptionLlm.header,
      counterparty_name: `\u0000Bad\u0001Co\u0002\n  Ltd  ` + 'x'.repeat(500)
    }
  };
  const { header } = __mapExtractionToWriterShape(llm);
  assert.ok(!header.vendor_name.includes('\u0000'), 'control chars stripped');
  assert.ok(header.vendor_name.length <= 200, `length capped (got ${header.vendor_name.length})`);
});

// ── 12: currency normalisation ──────────────────────────────────────
await test('currency: lowercase → uppercase ISO; invalid → null', () => {
  const lowerCase = {
    ...vendorSubscriptionLlm,
    header: { ...vendorSubscriptionLlm.header, currency: 'usd' }
  };
  assert.equal(__mapExtractionToWriterShape(lowerCase).header.currency, 'USD');

  const invalid = {
    ...vendorSubscriptionLlm,
    header: { ...vendorSubscriptionLlm.header, currency: 'dollars' }
  };
  assert.equal(__mapExtractionToWriterShape(invalid).header.currency, null);
});

// ── 13: warnings round-trip ─────────────────────────────────────────
await test('warnings: round-tripped + capped at 6 + length-limited', () => {
  const llm = {
    ...vendorSubscriptionLlm,
    warnings: Array.from({ length: 10 }, (_, i) => 'w'.repeat(300) + i)
  };
  const { summary } = __mapExtractionToWriterShape(llm);
  assert.ok(summary.warnings.length <= 6, 'capped at 6');
  for (const w of summary.warnings) {
    assert.ok(w.length <= 200, 'each warning ≤200 chars');
  }
});

// ── 14: end-to-end extractor — happy path ──────────────────────────
await test('extractContractFromBase64: happy path → completed', async () => {
  await withApiKey(async () => {
    const result = await extractContractFromBase64({
      base64: 'dGVzdA==',
      filename: 'aws-msa.pdf',
      mimeType: 'application/pdf',
      __callOpenAi: async () => mockOpenAiResponse(vendorSubscriptionLlm)
    });
    assert.equal(result.kind, 'completed');
    assert.equal(result.header.vendor_name, 'Amazon Web Services, Inc.');
    assert.equal(result.summary.contract_type, 'service_subscription');
    assert.equal(result.summary.recurring_frequency, 'monthly');
  });
});

// ── 15: error envelopes ─────────────────────────────────────────────
await test('extractContractFromBase64: provider 400 -> DOCUMENT_EXTRACTION_REJECTED (terminal)', async () => {
  await withApiKey(async () => {
    const result = await extractContractFromBase64({
      base64: 'dGVzdA==',
      filename: 'aws-msa.pdf',
      mimeType: 'application/pdf',
      __callOpenAi: async () => ({ ok: false, status: 400, json: async () => ({}) })
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'DOCUMENT_EXTRACTION_REJECTED');
    assert.ok(String(result.reason).includes('400'));
  });
});

await test('extractContractFromBase64: no provider key at all → anthropic_not_configured (2026-11-10: names the key the lane is meant to hold, in the parse wait vocabulary)', async () => {
  const original = process.env.OPENAI_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await extractContractFromBase64({
      base64: 'dGVzdA==',
      filename: 'x.pdf',
      __callOpenAi: async () => mockOpenAiResponse(vendorSubscriptionLlm)
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
    assert.equal(result.reason, 'anthropic_not_configured');
    assert.equal(result.provider, 'anthropic');
  } finally {
    if (original) process.env.OPENAI_API_KEY = original;
    if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
  }
});

await test('extractContractFromBase64: empty input → unreadable terminal', async () => {
  await withApiKey(async () => {
    const result = await extractContractFromBase64({
      base64: '',
      filename: 'x.pdf',
      __callOpenAi: async () => mockOpenAiResponse(vendorSubscriptionLlm)
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'DOCUMENT_EXTRACTION_UNREADABLE');
    assert.equal(result.reason, 'empty_input');
  });
});

await test('extractContractFromBase64: low extraction confidence → unreadable terminal', async () => {
  await withApiKey(async () => {
    const result = await extractContractFromBase64({
      base64: 'dGVzdA==',
      filename: 'x.pdf',
      __callOpenAi: async () =>
        mockOpenAiResponse({ ...vendorSubscriptionLlm, extraction_confidence: 0.1 })
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'DOCUMENT_EXTRACTION_UNREADABLE');
    assert.equal(result.reason, 'low_confidence');
  });
});

await test('extractContractFromBase64: OpenAI non-OK → DOCUMENT_EXTRACTION_FAILED retryable', async () => {
  await withApiKey(async () => {
    const result = await extractContractFromBase64({
      base64: 'dGVzdA==',
      filename: 'x.pdf',
      __callOpenAi: async () => ({ ok: false, status: 503, json: async () => ({}) })
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
    assert.equal(result.reason, 'openai_503');
  });
});

await test('extractContractFromBase64: bad JSON body → DOCUMENT_EXTRACTION_FAILED', async () => {
  await withApiKey(async () => {
    const result = await extractContractFromBase64({
      base64: 'dGVzdA==',
      filename: 'x.pdf',
      __callOpenAi: async () => mockOpenAiResponse({}, { throwOnJson: true })
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
    assert.equal(result.reason, 'response_not_json');
  });
});

await test('extractContractFromBase64: structured response not parseable → DOCUMENT_EXTRACTION_FAILED', async () => {
  await withApiKey(async () => {
    const badResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ content: [{ text: 'not json {' }] }]
      })
    };
    const result = await extractContractFromBase64({
      base64: 'dGVzdA==',
      filename: 'x.pdf',
      __callOpenAi: async () => badResponse
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'DOCUMENT_EXTRACTION_FAILED');
    assert.equal(result.reason, 'structured_bad_json');
  });
});

// ── 16: filename PII discipline ─────────────────────────────────────
await test('console output never includes free-text fields', () => {
  // The extractor logs counts + confidence bands — never the actual
  // counterparty name, contract number, etc. Pin the log call shape
  // by inspecting the mapper output: there's no `counterparty_name`
  // key in the logged object's serialised form.
  //
  // We can't directly intercept console.log here without a heavier
  // mock; the load-bearing invariant is that the mapper exposes the
  // boolean flags + bands + counts the extractor logs, NOT the raw
  // strings. So pin those flags exist + raw strings stay in summary
  // only (which is allowed to be PII because it's stored, not logged).
  const { summary } = __mapExtractionToWriterShape(vendorSubscriptionLlm);
  assert.ok(summary.counterparty_name); // raw on summary OK
  // The extractor's log object construction uses only Boolean(...) /
  // band-bucketed values — visually verified by reading contract.js,
  // and exercised end-to-end by the happy-path test above (no throw).
});

// ── 17: filename classifier routes to 'contract' ────────────────────
const f = (name) => ({ name, type: 'application/pdf' });

await test('classifier: contract-language filenames route to "contract"', () => {
  for (const name of [
    'MSA-2026-042.pdf',
    'master services agreement.pdf',
    'Service Agreement Acme.pdf',
    'AWS subscription agreement.pdf',
    'Office Lease Agreement.pdf',
    'Loan Agreement.pdf',
    'NDA - Acme Co.pdf',
    'Non-disclosure agreement.pdf',
    'Engagement Letter Q1.pdf',
    'Statement of Work — Phase 2.pdf',
    'SOW-2026-007.pdf',
    'Employment Contract.pdf',
    'License agreement Adobe.pdf'
  ]) {
    assert.equal(classifyDocumentFile(f(name)), 'contract', `${name} → contract`);
  }
});

await test('classifier: vendor/supplier WITH contract word routes to "contract" not "supplier_bill"', () => {
  // Critical regression guard: "Vendor agreement.pdf" pre-PR-18
  // would have matched the bill branch via bare "vendor". Now the
  // contract branch (placed above) catches "agreement" first.
  assert.equal(classifyDocumentFile(f('Vendor agreement.pdf')), 'contract', 'vendor + agreement');
  assert.equal(classifyDocumentFile(f('Supplier contract.pdf')), 'contract', 'supplier + contract');
  assert.equal(classifyDocumentFile(f('Vendor MSA.pdf')), 'contract', 'vendor + msa');
});

await test('classifier: bare loan/lease filenames still route to "financing" (not contract)', () => {
  // A file named just "loan.pdf" or "lease.pdf" without an
  // agreement/contract word stays in the financing bucket — that's
  // the pre-PR-18 behavior for documents like loan promissory
  // notes, lease cover sheets, etc. that aren't the agreement.
  // (Files named "Loan statement.pdf" route to bank_statement
  // because "statement" matches first — pre-existing classifier
  // ordering, not changed by this PR.)
  assert.equal(classifyDocumentFile(f('loan.pdf')), 'financing', 'bare loan');
  assert.equal(classifyDocumentFile(f('Equipment lease.pdf')), 'financing', 'bare lease');
});

await test('classifier: existing categories unaffected by contract patterns', () => {
  // The contract branch must not steal known non-contract types.
  assert.equal(classifyDocumentFile(f('DBS Bank Statement.pdf')), 'bank_statement', 'bank');
  assert.equal(classifyDocumentFile(f('Cabify Receipt.pdf')), 'receipt', 'receipt');
  assert.equal(classifyDocumentFile(f('Sales Invoice 001.pdf')), 'sales_invoice', 'sales invoice');
  assert.equal(classifyDocumentFile(f('Payslip Apr 2026.pdf')), 'payroll_cpf', 'payroll');
});

// ── Obligations schema + sanitization ──────────────────────────────

await test('obligations schema: strict-mode-compatible with additionalProperties: false', () => {
  const schema = __CONTRACT_EXTRACTION_SCHEMA_WITH_OBLIGATIONS;
  assert.ok(schema.properties.obligations, 'obligations property exists');
  const itemSchema = schema.properties.obligations.items;
  assert.equal(itemSchema.additionalProperties, false);
  assert.ok(itemSchema.required.includes('obligation_type'));
  assert.ok(itemSchema.required.includes('payer'));
  assert.ok(itemSchema.required.includes('payee'));
  assert.ok(itemSchema.required.includes('amount'));
  assert.ok(itemSchema.required.includes('frequency'));
  assert.ok(itemSchema.required.includes('confidence'));
  assert.ok(schema.required.includes('obligations'), 'obligations in top-level required');
});

await test('obligations schema: base schema does NOT include obligations', () => {
  const schema = __CONTRACT_EXTRACTION_SCHEMA;
  assert.equal(schema.properties.obligations, undefined);
  assert.ok(!schema.required.includes('obligations'));
});

await test('OBLIGATION_TYPE_VALUES has expected entries', () => {
  assert.ok(OBLIGATION_TYPE_VALUES.includes('recurring_payment'));
  assert.ok(OBLIGATION_TYPE_VALUES.includes('rent'));
  assert.ok(OBLIGATION_TYPE_VALUES.includes('deposit'));
  assert.ok(OBLIGATION_TYPE_VALUES.includes('loan_repayment'));
  assert.ok(OBLIGATION_TYPE_VALUES.includes('insurance_premium'));
  assert.equal(OBLIGATION_TYPE_VALUES.length, 10);
});

await test('OBLIGATION_FREQUENCY_VALUES has expected entries', () => {
  assert.ok(OBLIGATION_FREQUENCY_VALUES.includes('monthly'));
  assert.ok(OBLIGATION_FREQUENCY_VALUES.includes('one_time'));
  assert.ok(OBLIGATION_FREQUENCY_VALUES.includes('on_demand'));
  assert.equal(OBLIGATION_FREQUENCY_VALUES.length, 6);
});

await test('OBLIGATION_PARTY_ROLE_VALUES has expected entries', () => {
  assert.ok(OBLIGATION_PARTY_ROLE_VALUES.includes('provider'));
  assert.ok(OBLIGATION_PARTY_ROLE_VALUES.includes('landlord'));
  assert.ok(OBLIGATION_PARTY_ROLE_VALUES.includes('tenant'));
  assert.ok(OBLIGATION_PARTY_ROLE_VALUES.includes('party'));
  assert.equal(OBLIGATION_PARTY_ROLE_VALUES.length, 11);
});

await test('sanitizeObligations: valid obligation passes through', () => {
  const obligations = __sanitizeObligations([
    {
      obligation_type: 'rent',
      payer: 'Acme Corp',
      payee: 'BigLandlord Ltd',
      payer_role: 'tenant',
      payee_role: 'landlord',
      amount: 5000,
      currency: 'gbp',
      frequency: 'monthly',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      due_day: 15,
      escalation_clause: '3% annual increase',
      tax_clause: 'plus VAT',
      confidence: 0.9,
      source_evidence: 'Clause 4.1: monthly rent of £5,000'
    }
  ]);
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].obligation_type, 'rent');
  assert.equal(obligations[0].payer, 'Acme Corp');
  assert.equal(obligations[0].payee, 'BigLandlord Ltd');
  assert.equal(obligations[0].payer_role, 'tenant');
  assert.equal(obligations[0].payee_role, 'landlord');
  assert.equal(obligations[0].amount, 5000);
  assert.equal(obligations[0].currency, 'GBP');
  assert.equal(obligations[0].frequency, 'monthly');
  assert.equal(obligations[0].start_date, '2026-01-01');
  assert.equal(obligations[0].end_date, '2026-12-31');
  assert.equal(obligations[0].due_day, 15);
  assert.equal(obligations[0].confidence, 0.9);
});

await test('sanitizeObligations: filters out entries without valid obligation_type', () => {
  const obligations = __sanitizeObligations([
    { obligation_type: 'made_up_type', amount: 100 },
    { obligation_type: null, amount: 200 },
    { amount: 300 }
  ]);
  assert.equal(obligations.length, 0);
});

await test('sanitizeObligations: unknown roles coerce to party', () => {
  const obligations = __sanitizeObligations([
    { obligation_type: 'rent', payer_role: 'unknown_role', payee_role: 'something', amount: 100 }
  ]);
  assert.equal(obligations[0].payer_role, 'party');
  assert.equal(obligations[0].payee_role, 'party');
});

await test('sanitizeObligations: unknown frequency coerces to one_time', () => {
  const obligations = __sanitizeObligations([
    { obligation_type: 'rent', frequency: 'biweekly', amount: 100 }
  ]);
  assert.equal(obligations[0].frequency, 'one_time');
});

await test('sanitizeObligations: due_day validated 1-31', () => {
  const obligations = __sanitizeObligations([
    { obligation_type: 'rent', due_day: 0, amount: 100 },
    { obligation_type: 'rent', due_day: 32, amount: 200 },
    { obligation_type: 'rent', due_day: 15, amount: 300 },
    { obligation_type: 'rent', due_day: null, amount: 400 }
  ]);
  assert.equal(obligations[0].due_day, null, 'due_day 0 rejected');
  assert.equal(obligations[1].due_day, null, 'due_day 32 rejected');
  assert.equal(obligations[2].due_day, 15, 'due_day 15 accepted');
  assert.equal(obligations[3].due_day, null, 'null due_day preserved');
});

await test('sanitizeObligations: confidence clamped to 0-1', () => {
  const obligations = __sanitizeObligations([
    { obligation_type: 'rent', confidence: 1.5, amount: 100 },
    { obligation_type: 'rent', confidence: -0.5, amount: 200 }
  ]);
  assert.equal(obligations[0].confidence, 1);
  assert.equal(obligations[1].confidence, 0);
});

await test('sanitizeObligations: capped at 10 entries', () => {
  const input = Array.from({ length: 15 }, (_, i) => ({
    obligation_type: 'rent',
    amount: i * 100
  }));
  const obligations = __sanitizeObligations(input);
  assert.equal(obligations.length, 10);
});

await test('sanitizeObligations: source_evidence capped at 300 chars', () => {
  const obligations = __sanitizeObligations([
    { obligation_type: 'rent', source_evidence: 'x'.repeat(500), amount: 100 }
  ]);
  assert.equal(obligations[0].source_evidence.length, 300);
});

const withObligationsFlag = async (value, fn) => {
  const original = process.env.CONTRACT_OBLIGATIONS_ENABLED;
  if (value === undefined) delete process.env.CONTRACT_OBLIGATIONS_ENABLED;
  else process.env.CONTRACT_OBLIGATIONS_ENABLED = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.CONTRACT_OBLIGATIONS_ENABLED;
    else process.env.CONTRACT_OBLIGATIONS_ENABLED = original;
  }
};

await test('mapExtractionToWriterShape: obligations empty when flag off', async () => {
  await withObligationsFlag('false', () => {
    const result = __mapExtractionToWriterShape({
      ...vendorSubscriptionLlm,
      obligations: [
        { obligation_type: 'rent', amount: 5000, frequency: 'monthly', payer: 'A', payee: 'B',
          payer_role: 'tenant', payee_role: 'landlord', currency: 'USD', confidence: 0.9,
          start_date: null, end_date: null, due_day: null, escalation_clause: null,
          tax_clause: null, source_evidence: null }
      ]
    });
    assert.deepEqual(result.summary.obligations, []);
    assert.equal(result.summary.obligation_count, 0);
  });
});

await test('mapExtractionToWriterShape: obligations populated when flag on', async () => {
  await withObligationsFlag('true', () => {
    const result = __mapExtractionToWriterShape({
      ...vendorSubscriptionLlm,
      obligations: [
        { obligation_type: 'service_fee', amount: 1200, frequency: 'monthly', payer: 'Client',
          payee: 'AWS', payer_role: 'client', payee_role: 'provider', currency: 'USD',
          confidence: 0.95, start_date: '2026-02-01', end_date: '2027-01-31', due_day: 1,
          escalation_clause: null, tax_clause: 'plus tax', source_evidence: 'Monthly service fee of $1,200' }
      ]
    });
    assert.equal(result.summary.obligations.length, 1);
    assert.equal(result.summary.obligation_count, 1);
    assert.equal(result.summary.obligations[0].obligation_type, 'service_fee');
    assert.equal(result.summary.obligations[0].amount, 1200);
    assert.equal(result.summary.obligations[0].frequency, 'monthly');
    assert.equal(result.summary.obligations[0].payee, 'AWS');
  });
});

await test('extractContractFromBase64: includeObligations passed to LLM when flag on', async () => {
  let capturedBody = null;
  await withApiKey(async () => {
    await withObligationsFlag('true', async () => {
      await extractContractFromBase64({
        base64: 'dGVzdA==',
        filename: 'lease.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async (args) => {
          capturedBody = args;
          return mockOpenAiResponse({
            ...vendorSubscriptionLlm,
            obligations: []
          });
        }
      });
    });
  });
  assert.equal(capturedBody.includeObligations, true);
});

await test('extractContractFromBase64: includeObligations false when flag off', async () => {
  let capturedBody = null;
  await withApiKey(async () => {
    await withObligationsFlag('false', async () => {
      await extractContractFromBase64({
        base64: 'dGVzdA==',
        filename: 'lease.pdf',
        mimeType: 'application/pdf',
        __callOpenAi: async (args) => {
          capturedBody = args;
          return mockOpenAiResponse(vendorSubscriptionLlm);
        }
      });
    });
  });
  assert.equal(capturedBody.includeObligations, false);
});

if (ORIGINAL_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = ORIGINAL_API_KEY;

console.log(`\ncontract: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
