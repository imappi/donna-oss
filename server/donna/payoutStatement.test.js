// Unit tests for the payout statement / deposit slip extractor (RT-18,
// docs/plan-2026-09-01-runtime-refactor-slices.md; audit F-04 part 2 / F-23).
// Mirrors supplierBill.test.js: synthetic provider responses served through
// the llmCall envelope's fetch seam, pure mapping tests against
// __mapExtractionToWriterShape, and the settlement equation through
// validateReceiptTotals's receipt shape (RT-04).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPayoutStatementFromBase64,
  PAYOUT_DOCUMENT_TYPES,
  PAYOUT_EXTRACTION_SCHEMA_NAME,
  __PAYOUT_EXTRACTION_SCHEMA,
  __mapExtractionToWriterShape
} from './payoutStatement.js';

const withApiKey = async (fn) => {
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  }
};

const responseFor = (parsed, { status = 200, model = 'gpt-5.4', throwOnJson = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (throwOnJson) throw new Error('not json');
    return {
      model,
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(parsed) }] }]
    };
  }
});

// The appliance fixture world's PayLink settlement (server/donna/fixtures/
// appliance/world.json artifact/payout-statement): gross 1,250, fees 36.25,
// net 1,213.75.
const paylinkLlm = () => ({
  extraction_status: 'validated',
  extraction_confidence: 0.96,
  warnings: [],
  document_kind: 'payout_statement',
  provider_name: 'PayLink',
  provider_tax_id: null,
  merchant_name: 'Kestrel Print Studio Ltd',
  merchant_tax_id: null,
  period_start: '2026-08-11',
  period_end: '2026-08-17',
  payout_date: '2026-08-18',
  currency: 'GBP',
  gross_sales: 1250,
  gross_components: [],
  refunds: 0,
  fees: [{ description: 'Processing fees (2.9%)', amount: 36.25, tax_amount: 0 }],
  adjustments: [],
  net_payout: 1213.75,
  transaction_count: 23,
  payout_reference: 'PO-88121',
  deposit_reference: null,
  bank_last4: '5678'
});

test('the strict schema lists every property as required with no additional properties, at every level', () => {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
      assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`);
      assert.deepEqual([...(node.required || [])].sort(), Object.keys(node.properties || {}).sort(), `${path}: required must list every property`);
      for (const [key, child] of Object.entries(node.properties || {})) walk(child, `${path}.${key}`);
    }
    if (node.items) walk(node.items, `${path}[]`);
  };
  walk(__PAYOUT_EXTRACTION_SCHEMA, 'schema');
  assert.deepEqual(__PAYOUT_EXTRACTION_SCHEMA.properties.document_kind.enum, [...PAYOUT_DOCUMENT_TYPES]);
  assert.equal(PAYOUT_EXTRACTION_SCHEMA_NAME, 'payout_statement_extraction');
});

test('mapping: a footing payout — NET as the header total, the provider as the counterparty, signed breakdown lines, a matching totals receipt', () => {
  const { header, summary, lines } = __mapExtractionToWriterShape(paylinkLlm(), { documentType: 'payout_statement' });
  assert.equal(header.vendor_name, 'PayLink');
  assert.equal(header.customer_name, null, 'the firm\'s own name is never written into its own row');
  assert.equal(header.total_amount, 1213.75, 'the header total is the NET — the amount the bank line shows');
  assert.equal(header.document_date, '2026-08-18');
  assert.equal(header.currency, 'GBP');
  assert.equal(header.reference_number, 'PO-88121');
  assert.equal(header.payment_status, 'paid', 'a payout is settled by construction');
  assert.equal(header.tax_amount, null);

  assert.equal(summary.document_type, 'payout_statement');
  assert.equal(summary.counterparty_role, 'processor');
  assert.equal(summary.period_start_date, '2026-08-11');
  assert.equal(summary.period_end_date, '2026-08-17');
  assert.equal(summary.settlement.gross_sales, 1250);
  assert.equal(summary.settlement.fee_total, 36.25);
  assert.equal(summary.settlement.net_payout, 1213.75);
  assert.equal(summary.settlement.transaction_count, 23);
  assert.equal(summary.settlement.bank_last4, '5678');
  assert.deepEqual(summary.parties, [
    { role: 'merchant', name: 'Kestrel Print Studio Ltd' },
    { role: 'processor', name: 'PayLink' }
  ]);
  assert.deepEqual(summary.references, [{ type: 'transaction_id', value: 'PO-88121' }]);

  assert.deepEqual(lines.map((line) => [line.description, line.amount]), [
    ['Gross sales (23 transactions)', 1250],
    ['Processing fees (2.9%)', -36.25]
  ]);
  assert.equal(summary.line_count, 2);

  // RT-04 receipt shape: {expected, total, drift, strategy, basis}.
  const receipt = summary.totals_validation;
  assert.equal(receipt.matches, true);
  assert.equal(receipt.expected, 1213.75);
  assert.equal(receipt.total, 1213.75);
  assert.equal(receipt.drift, 0);
  assert.equal(receipt.basis, 'lines');
  assert.equal(receipt.strategy, 'declared_tax_inclusive');
  assert.deepEqual(summary.warnings, []);
});

test('mapping: a NON-footing statement — the drift is the deduction the provider never printed, amount_mismatch is raised, nothing is invented', () => {
  // The appliance world's Northgate Marketplace payout: gross 2,150,
  // commission 430 + VAT 86 printed, net 1,590 printed — a 44.00
  // promotional co-funding line the statement omits. Σ printed = 1,634.
  const llm = {
    ...paylinkLlm(),
    provider_name: 'Northgate Marketplace',
    provider_tax_id: 'GB 456 7890 12',
    merchant_tax_id: 'GB 987 6543 21',
    period_start: '2026-08-18',
    period_end: '2026-08-24',
    payout_date: '2026-08-25',
    gross_sales: 2150,
    fees: [{ description: 'Marketplace commission (20%)', amount: 430, tax_amount: 86 }],
    net_payout: 1590,
    transaction_count: 41,
    payout_reference: 'NM-2026-0825-771'
  };
  const { header, summary, lines } = __mapExtractionToWriterShape(llm, { documentType: 'payout_statement' });
  assert.equal(header.total_amount, 1590, 'the printed net stands — never adjusted to make the equation balance');
  assert.deepEqual(lines.map((line) => [line.description, line.amount]), [
    ['Gross sales (41 transactions)', 2150],
    ['Marketplace commission (20%) (incl. tax 86.00)', -516]
  ]);
  const receipt = summary.totals_validation;
  assert.equal(receipt.matches, false);
  assert.equal(receipt.expected, 1634);
  assert.equal(receipt.total, 1590);
  assert.equal(receipt.drift, -44, 'signed: total − expected');
  assert.equal(receipt.basis, 'lines');
  assert.ok(summary.warnings.includes('amount_mismatch'));
  assert.equal(summary.settlement.fee_tax_total, 86);
  assert.deepEqual(summary.tax_registration_ids, { seller: 'GB 456 7890 12', buyer: 'GB 987 6543 21' });
});

test('mapping: refunds and signed adjustments enter the equation with their signs', () => {
  const llm = {
    ...paylinkLlm(),
    gross_sales: 1000,
    refunds: -50, // printed negative → the same magnitude
    fees: [{ description: 'Commission', amount: 200, tax_amount: 10 }, { description: 'Delivery fee retained', amount: 30, tax_amount: null }],
    adjustments: [{ description: 'Reserve released', amount: 25 }, { description: 'Chargeback', amount: -15 }],
    net_payout: 720
  };
  const { summary, lines } = __mapExtractionToWriterShape(llm, { documentType: 'payout_statement' });
  assert.deepEqual(lines.map((line) => line.amount), [1000, -50, -210, -30, 25, -15]);
  assert.equal(summary.totals_validation.matches, true, '1000 − 50 − 210 − 30 + 25 − 15 = 720');
  assert.equal(summary.settlement.refunds, 50);
  assert.equal(summary.settlement.adjustment_total, 10);
});

test('mapping: a deposit slip — the components become the lines when they foot to the deposit total; the bank is the counterparty', () => {
  const llm = {
    ...paylinkLlm(),
    document_kind: 'deposit_slip',
    provider_name: 'Barclays',
    period_start: null,
    period_end: null,
    payout_date: '2026-09-03',
    gross_sales: 3000,
    gross_components: [
      { description: 'Cash', amount: 1200 },
      { description: 'Cheque 005521 Northgate Events Ltd', amount: 1800 }
    ],
    fees: [],
    net_payout: 3000,
    transaction_count: null,
    payout_reference: null,
    deposit_reference: 'DS-4471'
  };
  const { header, summary, lines } = __mapExtractionToWriterShape(llm, { documentType: 'deposit_slip' });
  assert.equal(summary.document_type, 'deposit_slip');
  assert.equal(summary.counterparty_role, 'bank');
  assert.equal(header.vendor_name, 'Barclays');
  assert.equal(header.total_amount, 3000);
  assert.equal(header.reference_number, 'DS-4471');
  assert.deepEqual(lines.map((line) => [line.description, line.amount]), [['Cash', 1200], ['Cheque 005521 Northgate Events Ltd', 1800]]);
  assert.equal(summary.totals_validation.matches, true);
  assert.deepEqual(summary.references, [{ type: 'receipt_number', value: 'DS-4471' }]);
  assert.deepEqual(summary.parties[1], { role: 'bank', name: 'Barclays' });
});

test('mapping: components that do not sum to the gross fall back to one gross line and are flagged; the model\'s kind never overrides the dispatched type silently', () => {
  const llm = {
    ...paylinkLlm(),
    document_kind: 'deposit_slip',
    gross_components: [{ description: 'Card sales', amount: 900 }, { description: 'Cash sales', amount: 300 }]
  };
  const { summary, lines } = __mapExtractionToWriterShape(llm, { documentType: 'payout_statement' });
  assert.equal(summary.document_type, 'payout_statement', 'the row keeps the routed type');
  assert.equal(summary.settlement.kind, 'deposit_slip', 'the model\'s own reading is kept on the settlement block');
  assert.ok(summary.warnings.includes('settlement_kind_disagrees'));
  assert.ok(summary.warnings.includes('gross_components_mismatch'));
  assert.deepEqual(lines.map((line) => line.amount), [1250, -36.25]);
});

test('mapping: a missing net leaves total_amount null (never a matcher candidate) and says so', () => {
  const { header, summary } = __mapExtractionToWriterShape({ ...paylinkLlm(), net_payout: null }, { documentType: 'payout_statement' });
  assert.equal(header.total_amount, null);
  assert.ok(summary.warnings.includes('net_payout_missing'));
  assert.equal(summary.totals_validation, undefined, 'no total, no equation');
});

test('transport: the call rides the llmCall envelope with the strict schema and returns the served model id', async () => {
  await withApiKey(async () => {
    const seen = [];
    const result = await extractPayoutStatementFromBase64({
      base64: Buffer.from('%PDF-1.4 payout').toString('base64'),
      filename: 'paylink-PO-88121-2026-08-18.pdf',
      mimeType: 'application/pdf',
      documentType: 'payout_statement',
      documentId: 'doc-1',
      clientIdentity: { display_name: 'Kestrel Print Studio Ltd', legal_names: [] },
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return responseFor(paylinkLlm(), { model: 'gpt-5.4-served' });
      }
    });
    assert.equal(result.kind, 'completed');
    assert.equal(result.model, 'gpt-5.4-served', 'the model id comes from the response, not the request');
    assert.equal(result.header.total_amount, 1213.75);
    assert.equal(result.lines.length, 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.text.format.name, 'payout_statement_extraction');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.store, false);
    assert.match(body.instructions, /Kestrel Print Studio Ltd/, 'the firm-side anchor is in the prompt');
    assert.ok(seen[0].init.signal, 'the request carries the timeout signal');
    const parts = body.input[0].content;
    assert.equal(parts[0].type, 'input_file');
    assert.match(parts[1].text, /routed as a payout statement/);
  });
});

test('transport: provider failures map to the shared extraction envelope', async () => {
  await withApiKey(async () => {
    const call = (fetchImpl) => extractPayoutStatementFromBase64({
      base64: Buffer.from('x').toString('base64'),
      filename: 'p.pdf',
      documentType: 'deposit_slip',
      fetchImpl
    });
    const retryable = await call(async () => responseFor({}, { status: 503 }));
    assert.deepEqual([retryable.kind, retryable.code], ['failed', 'DOCUMENT_EXTRACTION_FAILED']);
    const rejected = await call(async () => responseFor({}, { status: 400 }));
    assert.deepEqual([rejected.kind, rejected.code], ['failed', 'DOCUMENT_EXTRACTION_REJECTED']);
    const badJson = await call(async () => ({ ok: true, status: 200, json: async () => ({ output_text: '{not json' }) }));
    assert.deepEqual([badJson.kind, badJson.code, badJson.reason], ['failed', 'DOCUMENT_EXTRACTION_FAILED', 'structured_bad_json']);
    const network = await call(async () => { throw Object.assign(new Error('boom'), { name: 'FetchError' }); });
    assert.deepEqual([network.kind, network.code, network.reason], ['failed', 'DOCUMENT_EXTRACTION_FAILED', 'network_error']);
    const unreadable = await call(async () => responseFor({ ...paylinkLlm(), extraction_confidence: 0.1 }));
    assert.deepEqual([unreadable.kind, unreadable.code, unreadable.reason], ['failed', 'DOCUMENT_EXTRACTION_UNREADABLE', 'low_confidence']);
  });
});

test('transport: no API key ⇒ a retryable failure without a call; empty input ⇒ unreadable', async () => {
  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    let calls = 0;
    const result = await extractPayoutStatementFromBase64({ base64: 'aGk=', filename: 'p.pdf', fetchImpl: async () => { calls += 1; } });
    assert.deepEqual([result.kind, result.code, result.reason, calls], ['failed', 'DOCUMENT_EXTRACTION_FAILED', 'openai_not_configured', 0]);
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  }
  await withApiKey(async () => {
    const empty = await extractPayoutStatementFromBase64({ base64: '   ', filename: 'p.pdf', fetchImpl: async () => responseFor({}) });
    assert.deepEqual([empty.kind, empty.code], ['failed', 'DOCUMENT_EXTRACTION_UNREADABLE']);
  });
});
