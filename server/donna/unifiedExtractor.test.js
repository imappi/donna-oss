// Unified extractor tests — RT-12 (decision D1; audit F-12 / F-15).
//
// Covers: the strict schema + the lite validator the Anthropic path runs;
// provider resolution (key presence, env pin, model-id inference, the
// explicit argument); the appliance-default gate + kill switch; the mapper
// per document type (direction, tax ids, payment-status defaults, the
// settlement block as signed lines, the contract block, references,
// namespaced warnings, the totals receipt); the partial header on an
// unusable read; and the HTTP contract on both providers through a
// stubbed fetch (request shape, response-named model id, typed failures).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  extractUnified,
  normalizeUnifiedExtraction,
  normalizePaymentTerms,
  settlementRowsFoot,
  referencePriorityFor,
  resolveUnifiedProvider,
  unifiedExtractorServes,
  UNIFIED_EXTRACTOR_DEFAULT_MODELS,
  UNIFIED_EXTRACTOR_PROMPT_VERSION,
  UNIFIED_EXTRACTOR_PROVIDERS,
  UNIFIED_EXTRACTOR_TYPES,
  __buildContentBlock,
  __buildSystemPrompt,
  __buildUserPrompt
} from './unifiedExtractor.js';
import {
  UNIFIED_EXTRACTION_SCHEMA,
  UNIFIED_EXTRACTION_SCHEMA_NAME,
  UNIFIED_DOCUMENT_TYPES,
  validateStrictSchema
} from './unifiedExtractorSchema.js';
import { ANTHROPIC_SYSTEM_LANES, OPENAI_SCHEMA_LANES } from './testSupport/recordedProviders.js';

// ── fixtures ────────────────────────────────────────────────────────────
const emptySettlement = () => ({
  period_start: null, period_end: null, payout_date: null, gross_sales: null, gross_components: [],
  refunds: null, fees: [], adjustments: [], net_payout: null, transaction_count: null,
  payout_reference: null, deposit_reference: null, bank_last4: null, rows: []
});
const emptyContract = () => ({
  contract_type: 'not_a_contract', effective_start_date: null, effective_end_date: null, auto_renew: null,
  notice_period_days: null, recurring_amount: null, recurring_frequency: 'none', obligations: []
});
const header = (overrides = {}) => ({
  counterparty_name: 'Ochre Lighting',
  counterparty_role: 'vendor',
  counterparty_tax_id: 'GB 123 4567 89',
  own_name: 'Kestrel Print Studio Ltd',
  own_tax_id: 'GB 987 6543 21',
  document_date: '2026-08-12',
  due_date: '2026-09-11',
  currency: 'GBP',
  subtotal_amount: 550,
  tax_amount: 27.5,
  shipping_amount: 0,
  discount_amount: 27.5,
  rounding_amount: 0,
  total_amount: 550,
  line_amounts_include_tax: false,
  payment_status: 'unpaid',
  payment_terms: 'Net 30',
  references: [{ type: 'invoice_number', value: 'OL-2026-0812' }],
  ...overrides
});
const bill = (overrides = {}) => ({
  document_type: 'supplier_bill',
  extraction_status: 'validated',
  extraction_confidence: 0.96,
  warnings: [],
  source_business_use: { classification: 'not_stated', source_quote: null, business_use_percent: null },
  header: header(),
  lines: [
    { description: 'LED panel light 600x600', quantity: 10, unit_price: 50, amount: 500, tax_rate: 0.05 },
    { description: 'Installation and commissioning', quantity: 1, unit_price: 50, amount: 50, tax_rate: 0.05 }
  ],
  settlement: emptySettlement(),
  contract: emptyContract(),
  ...overrides
});
const payout = (overrides = {}) => bill({
  document_type: 'payout_statement',
  header: header({
    counterparty_name: 'PayLink', counterparty_role: 'processor', counterparty_tax_id: null, own_tax_id: null,
    document_date: '2026-08-18', due_date: null, subtotal_amount: null, tax_amount: null, discount_amount: 0,
    total_amount: 1213.75, payment_status: 'paid', payment_terms: null,
    references: [{ type: 'payout_reference', value: 'PO-88121' }]
  }),
  lines: [],
  settlement: {
    ...emptySettlement(),
    period_start: '2026-08-11', period_end: '2026-08-17', payout_date: '2026-08-18',
    gross_sales: 1250, refunds: 0, fees: [{ description: 'Processing fees (2.9%)', amount: 36.25, tax_amount: 0 }],
    net_payout: 1213.75, transaction_count: 23, payout_reference: 'PO-88121', bank_last4: '5678'
  },
  ...overrides
});

const PDF_B64 = 'JVBERi0xLjQKJcfs';

// A fetch stub that records the request and answers with the provider's
// wire shape around `text`.
const stubFetch = ({ provider, text, model = null, status = 200, error = null, stopReason = 'end_turn', sse = false }) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (error) throw error;
    if (status !== 200) return new Response(JSON.stringify({ error: { message: `scripted ${status}` } }), { status, headers: { 'content-type': 'application/json' } });
    const body = provider === 'openai'
      ? { id: 'resp_1', model, output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } }
      : (() => {
        // The unified schema is past the structured-output limits, so the
        // request carries the structured-result tool and the reply is its
        // call (structuredRequest.js schemaDeliveryFor); a reply that is not
        // JSON arrives as prose, which the lane must refuse.
        const sent = JSON.parse(init.body);
        const viaTool = Array.isArray(sent.tools) && sent.tools.some((tool) => tool.name === 'structured_answer');
        let input = null;
        try { input = JSON.parse(String(text || '').replace(/^```json\s*|\s*```$/g, '')); } catch { input = null; }
        const block = viaTool && input && typeof input === 'object'
          ? { type: 'tool_use', id: 'toolu_1', name: 'structured_answer', input }
          : { type: 'text', text };
        return { id: 'msg_1', model, content: stopReason === 'refusal' ? [] : [block], stop_reason: stopReason === 'end_turn' && block.type === 'tool_use' ? 'tool_use' : stopReason, usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    if (sse && provider === 'anthropic') {
      // The wire shape of a streamed Messages reply (event stream), which the
      // envelope reassembles into the same Message.
      // A streamed tool call: the input arrives as input_json_delta pieces.
      const frames = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
        { type: 'content_block_stop', index: 0 },
        ...(stopReason === 'refusal' ? [] : [
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'structured_answer', input: {} } },
          ...[text.slice(0, 7), text.slice(7)].map((piece) => ({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: piece } })),
          { type: 'content_block_stop', index: 1 }
        ]),
        { type: 'message_delta', delta: { stop_reason: stopReason === 'end_turn' ? 'tool_use' : stopReason, stop_sequence: null }, usage: { output_tokens: 9 } },
        { type: 'message_stop' }
      ];
      return new Response(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
};

// ── the schema and its validator ───────────────────────────────────────
test('the schema is strict at every level and names the lane the recorded providers key on', () => {
  const walk = (schema, path = '$') => {
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
      assert.equal(schema.additionalProperties, false, `${path}: additionalProperties false`);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: every property required`);
      for (const [key, child] of Object.entries(schema.properties)) walk(child, `${path}.${key}`);
    }
    if (schema.items) walk(schema.items, `${path}[]`);
  };
  walk(UNIFIED_EXTRACTION_SCHEMA);
  assert.deepEqual(UNIFIED_EXTRACTION_SCHEMA.properties.document_type.enum, [...UNIFIED_DOCUMENT_TYPES]);
  assert.equal(OPENAI_SCHEMA_LANES[UNIFIED_EXTRACTION_SCHEMA_NAME], 'unified_extraction');
  assert.ok(ANTHROPIC_SYSTEM_LANES.some(({ lane, prefix }) => lane === 'unified_extraction' && __buildSystemPrompt().startsWith(prefix)),
    'the system prompt opens with the lane signature the stub keys on');
});

test('validateStrictSchema: a conforming reply is clean; wrong types, unknown keys, bad enums and missing keys are named', () => {
  assert.deepEqual(validateStrictSchema(UNIFIED_EXTRACTION_SCHEMA, bill()), []);
  assert.deepEqual(validateStrictSchema(UNIFIED_EXTRACTION_SCHEMA, payout()), []);
  const bad = bill({ document_type: 'memo', extra: 1 });
  bad.header.total_amount = '550';
  delete bad.header.currency;
  bad.settlement.transaction_count = 2.5;
  const violations = validateStrictSchema(UNIFIED_EXTRACTION_SCHEMA, bad);
  assert.ok(violations.some((v) => v.startsWith('$.document_type:')), JSON.stringify(violations));
  assert.ok(violations.includes('$.extra: not in schema'));
  assert.ok(violations.some((v) => v.startsWith('$.header.total_amount: expected number|null')));
  assert.ok(violations.includes('$.header.currency: required'));
  assert.ok(violations.some((v) => v.startsWith('$.settlement.transaction_count: expected integer|null')));
  assert.deepEqual(validateStrictSchema(UNIFIED_EXTRACTION_SCHEMA, 'nope'), ['$: expected object, got string']);
});

// ── provider resolution ────────────────────────────────────────────────
test('resolveUnifiedProvider: key presence in preference order; the model is the provider\'s strong default', () => {
  assert.deepEqual(UNIFIED_EXTRACTOR_PROVIDERS, ['anthropic', 'openai']);
  const openaiOnly = resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o' } });
  assert.deepEqual([openaiOnly.ok, openaiOnly.provider, openaiOnly.model, openaiOnly.apiKey, openaiOnly.source.provider, openaiOnly.source.model],
    [true, 'openai', UNIFIED_EXTRACTOR_DEFAULT_MODELS.openai, 'sk-o', 'key_presence', 'default']);
  const both = resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' } });
  assert.equal(both.provider, 'anthropic', 'anthropic preferred when both keys are present');
  assert.equal(both.model, UNIFIED_EXTRACTOR_DEFAULT_MODELS.anthropic);
  const none = resolveUnifiedProvider({ env: {} });
  assert.deepEqual([none.ok, none.reason], [false, 'no_provider_key']);
});

test('resolveUnifiedProvider: the env pin, a model id\'s provider, and the explicit argument outrank key presence — a pinned provider without a key refuses', () => {
  const pinned = resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a', UNIFIED_EXTRACTOR_PROVIDER: 'openai' } });
  assert.deepEqual([pinned.provider, pinned.source.provider], ['openai', 'env']);
  const byModel = resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a', UNIFIED_EXTRACTOR_MODEL: 'gpt-5.5' } });
  assert.deepEqual([byModel.provider, byModel.model, byModel.source.provider, byModel.source.model], ['openai', 'gpt-5.5', 'model_id', 'env']);
  const claudeNoKey = resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o', UNIFIED_EXTRACTOR_MODEL: 'claude-opus-4-8' } });
  assert.deepEqual([claudeNoKey.ok, claudeNoKey.reason], [false, 'no_provider_key:anthropic'], 'a claude id never goes to OpenAI');
  const param = resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' }, provider: 'openai', model: 'gpt-5.4-mini' });
  assert.deepEqual([param.provider, param.model, param.source.provider, param.source.model], ['openai', 'gpt-5.4-mini', 'param', 'param']);
  const foreignEnvModel = resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o', UNIFIED_EXTRACTOR_MODEL: 'claude-opus-4-8' }, provider: 'openai' });
  assert.deepEqual([foreignEnvModel.model, foreignEnvModel.source.model], ['gpt-5.4', 'default_env_model_other_provider'], 'an env model of another provider is ignored, receipted');
  assert.equal(resolveUnifiedProvider({ env: { OPENAI_API_KEY: 'sk-o' }, provider: 'carrier_pigeon' }).reason, 'unknown_provider:carrier_pigeon');
  assert.equal(resolveUnifiedProvider({ env: {}, keys: { openai: 'k' } }).provider, 'openai', 'explicit keys outrank the env');
});

// ── the gate ───────────────────────────────────────────────────────────
test('unifiedExtractorServes: every reconcilable type on the desktop host; bank statements, statutory records and unknown keep their lanes; the kill switch closes it; the cloud waits one release', () => {
  const desktop = { DONNA_DESKTOP_BLOB_DIR: '/tmp/x' };
  assert.deepEqual([...UNIFIED_EXTRACTOR_TYPES], [
    'receipt', 'supplier_bill', 'sales_invoice', 'issued_receipt', 'payment_confirmation',
    'payment_account_statement', 'contract', 'payout_statement', 'deposit_slip'
  ]);
  for (const type of UNIFIED_EXTRACTOR_TYPES) assert.equal(unifiedExtractorServes({ documentType: type, env: desktop }).unified, true, type);
  for (const type of ['bank_statement', 'company_or_statutory_record', 'unknown', null]) {
    assert.equal(unifiedExtractorServes({ documentType: type, env: desktop }).unified, false, String(type));
  }
  assert.deepEqual(unifiedExtractorServes({ documentType: 'receipt', env: { ...desktop, UNIFIED_EXTRACTOR_DISABLED: 'true' } }), { unified: false, reason: 'kill_switch' });
  assert.deepEqual(unifiedExtractorServes({ documentType: 'receipt', env: {} }), { unified: false, reason: 'cloud_per_type_release' });
  assert.deepEqual(unifiedExtractorServes({ documentType: 'receipt', env: {}, hostClass: 'desktop' }), { unified: true, reason: 'appliance_default' });
});

// ── the mapper ─────────────────────────────────────────────────────────
test('normalizeUnifiedExtraction: a supplier bill — vendor side, payment terms, tax ids seller/buyer, the totals receipt, prompt version', () => {
  const result = normalizeUnifiedExtraction(bill(), { documentType: 'supplier_bill' });
  assert.equal(result.kind, 'completed_header');
  assert.equal(result.document_type, 'supplier_bill');
  assert.deepEqual(result.header, {
    vendor_name: 'Ochre Lighting',
    customer_name: null,
    document_date: '2026-08-12',
    due_date: '2026-09-11',
    total_amount: 550,
    currency: 'GBP',
    tax_amount: 27.5,
    reference_number: 'OL-2026-0812',
    payment_status: 'unpaid',
    extraction_confidence: 0.96,
    counterparty_role: 'vendor',
    references: [{ type: 'invoice_number', value: 'OL-2026-0812' }],
    payment_terms: 'Net 30',
    subtotal_amount: 550,
    shipping_amount: 0,
    discount_amount: 27.5,
    rounding_amount: 0,
    line_amounts_include_tax: false
  });
  assert.equal(result.summary.source, 'unified_extractor');
  assert.equal(result.summary.prompt_version, UNIFIED_EXTRACTOR_PROMPT_VERSION);
  assert.equal(result.summary.counterparty_role, 'vendor');
  assert.equal(result.summary.payment_terms_phrase, 'Net 30');
  assert.equal(result.summary.payment_terms_days, 30);
  assert.deepEqual(result.summary.tax_registration_ids, { seller: 'GB 123 4567 89', buyer: 'GB 987 6543 21' });
  assert.deepEqual(result.summary.parties, [{ role: 'company', name: 'Kestrel Print Studio Ltd' }, { role: 'vendor', name: 'Ochre Lighting' }]);
  assert.equal(result.lines.length, 2);
  assert.equal(result.summary.line_count, 2);
  assert.equal(result.summary.totals_validation.matches, true);
  assert.equal(result.summary.totals_validation.strategy, 'declared_tax_exclusive');
  assert.deepEqual(result.summary.warnings, []);
});

test('normalizeUnifiedExtraction: a non-footing bill carries OUR amount_mismatch and the receipt; a bill without lines warns no_lines_detected', () => {
  const off = normalizeUnifiedExtraction(bill({ header: header({ total_amount: 600 }) }), {});
  assert.ok(off.summary.warnings.includes('amount_mismatch'));
  assert.equal(off.summary.totals_validation.drift, 50);
  const bare = normalizeUnifiedExtraction(bill({ lines: [] }), {});
  assert.ok(bare.summary.warnings.includes('no_lines_detected'));
  assert.equal(bare.summary.totals_validation, undefined, 'nothing to sum');
});

test('normalizeUnifiedExtraction: a sales invoice — customer side, the firm is the seller, the model\'s role is trusted', () => {
  const result = normalizeUnifiedExtraction(bill({
    document_type: 'sales_invoice',
    header: header({ counterparty_name: 'Northgate Ltd', counterparty_role: 'customer', counterparty_tax_id: 'GB 111', own_tax_id: 'GB 222' })
  }), { documentType: 'supplier_bill' });
  assert.equal(result.document_type, 'sales_invoice', 'the model\'s classification wins over the routed hint');
  assert.equal(result.header.vendor_name, null);
  assert.equal(result.header.customer_name, 'Northgate Ltd');
  assert.deepEqual(result.summary.tax_registration_ids, { seller: 'GB 222', buyer: 'GB 111' });
  assert.equal(result.summary.parties[0].role, 'merchant');
  assert.equal(result.summary.parties[1].role, 'customer');
});

test('normalizeUnifiedExtraction: payment-status defaults per type; issued receipts and settlements are paid by construction; a payment confirmation total is a magnitude', () => {
  const status = (type, value) => normalizeUnifiedExtraction(bill({ document_type: type, header: header({ payment_status: value, counterparty_role: type === 'issued_receipt' ? 'customer' : 'vendor' }), lines: [] }), {}).header.payment_status;
  assert.equal(status('supplier_bill', 'nonsense'), 'unpaid');
  assert.equal(status('sales_invoice', 'nonsense'), 'unpaid');
  assert.equal(status('receipt', 'nonsense'), 'unknown');
  assert.equal(status('receipt', 'paid'), 'paid');
  assert.equal(status('issued_receipt', 'unpaid'), 'paid');
  assert.equal(status('issued_receipt', 'partial'), 'partial');
  assert.equal(status('supplier_bill', 'credit_note'), 'credit_note');
  const confirmation = normalizeUnifiedExtraction(bill({ document_type: 'payment_confirmation', header: header({ total_amount: -941.42, counterparty_name: 'Amex' }), lines: [] }), {});
  assert.equal(confirmation.header.total_amount, 941.42);
  assert.equal(confirmation.header.payment_status, 'paid');
  assert.equal(confirmation.header.vendor_name, 'Amex');
  assert.deepEqual(confirmation.lines, []);
  assert.equal(confirmation.summary.parties[1].role, 'payee');
});

test('normalizeUnifiedExtraction: a payout statement — the settlement block becomes signed lines, the NET is the header total, the equation foots', () => {
  const result = normalizeUnifiedExtraction(payout(), { documentType: 'unknown' });
  assert.equal(result.kind, 'completed_header');
  assert.equal(result.document_type, 'payout_statement');
  assert.equal(result.header.vendor_name, 'PayLink');
  assert.equal(result.header.customer_name, null);
  assert.equal(result.header.total_amount, 1213.75);
  assert.equal(result.header.tax_amount, null);
  assert.equal(result.header.due_date, null);
  assert.equal(result.header.payment_status, 'paid');
  assert.equal(result.header.reference_number, 'PO-88121');
  assert.equal(result.header.document_date, '2026-08-18');
  assert.deepEqual(result.lines.map((l) => [l.description, l.amount]), [['Gross sales (23 transactions)', 1250], ['Processing fees (2.9%)', -36.25]]);
  const s = result.summary;
  assert.equal(s.counterparty_role, 'processor');
  assert.equal(s.line_amounts_include_tax, true);
  assert.equal(s.subtotal_amount, null);
  assert.equal(s.period_start_date, '2026-08-11');
  assert.equal(s.period_end_date, '2026-08-17');
  assert.deepEqual(s.references, [{ type: 'transaction_id', value: 'PO-88121' }]);
  assert.equal(s.settlement.kind, 'payout_statement');
  assert.equal(s.settlement.gross_sales, 1250);
  assert.equal(s.settlement.fee_total, 36.25);
  assert.equal(s.settlement.fee_tax_total, 0);
  assert.equal(s.settlement.net_payout, 1213.75);
  assert.equal(s.settlement.transaction_count, 23);
  assert.equal(s.settlement.bank_last4, '5678');
  assert.equal(s.settlement.payout_reference, 'PO-88121');
  assert.equal(s.settlement.provider_name, 'PayLink');
  assert.equal(s.settlement.merchant_name, 'Kestrel Print Studio Ltd');
  assert.deepEqual(s.tax_registration_ids, { seller: null, buyer: null });
  assert.deepEqual(s.parties, [{ role: 'merchant', name: 'Kestrel Print Studio Ltd' }, { role: 'processor', name: 'PayLink' }]);
  assert.equal(s.totals_validation.matches, true);
  assert.equal(s.totals_validation.basis, 'lines');
  assert.equal(s.totals_validation.expected, 1213.75);
});

test('normalizeUnifiedExtraction: a non-footing payout keeps the printed net with the signed drift; a deposit slip itemises cash + cheque under the bank', () => {
  const nonfooting = normalizeUnifiedExtraction(payout({
    header: header({ counterparty_name: 'Northgate Marketplace', counterparty_role: 'processor', counterparty_tax_id: 'GB 456 7890 12', own_tax_id: 'GB 987 6543 21', total_amount: 1590, payment_status: 'paid', references: [] }),
    settlement: { ...emptySettlement(), gross_sales: 2150, refunds: 0, fees: [{ description: 'Commission (20%)', amount: 430, tax_amount: 86 }], net_payout: 1590, payout_reference: 'NM-2026-0825-771' }
  }), {});
  assert.equal(nonfooting.header.total_amount, 1590, 'never adjusted to foot');
  assert.equal(nonfooting.summary.totals_validation.expected, 1634);
  assert.equal(nonfooting.summary.totals_validation.drift, -44);
  assert.ok(nonfooting.summary.warnings.includes('amount_mismatch'));
  assert.deepEqual(nonfooting.summary.tax_registration_ids, { seller: 'GB 456 7890 12', buyer: 'GB 987 6543 21' });
  assert.deepEqual(nonfooting.lines.map((l) => l.amount), [2150, -516]);
  const slip = normalizeUnifiedExtraction(payout({
    document_type: 'deposit_slip',
    header: header({ counterparty_name: 'Barclays', counterparty_role: 'bank', total_amount: 3000, document_date: '2026-09-03', references: [{ type: 'deposit_reference', value: 'DS-4471' }] }),
    settlement: { ...emptySettlement(), gross_sales: 3000, gross_components: [{ description: 'Cash', amount: 1200 }, { description: 'Cheque 005521 Northgate Ltd', amount: 1800 }], net_payout: 3000, deposit_reference: 'DS-4471' }
  }), {});
  assert.equal(slip.document_type, 'deposit_slip');
  assert.equal(slip.summary.counterparty_role, 'bank');
  assert.equal(slip.summary.settlement.kind, 'deposit_slip');
  assert.equal(slip.header.reference_number, 'DS-4471');
  assert.deepEqual(slip.lines.map((l) => l.amount), [1200, 1800]);
  assert.deepEqual(slip.summary.references, [{ type: 'receipt_number', value: 'DS-4471' }]);
  assert.equal(slip.summary.totals_validation.matches, true);
});

// ── RT-21b: settlement rows (the koontilasku contract) ──────────────────
// The fixture is the Kultalanka Nets February 2025 koontilasku
// (data/evals/fixtures/reconciliation/018-kultalanka-nets-koontilasku-rows.json):
// four weekly card settlements VKO5–VKO8, each with its own gross, 1.10 %
// fee and net, one total. The unified extractor used to persist the four
// weeks as GROSS components and one fee line — per-row fee, net and paid
// date were printed and not persisted, so the matcher could only say
// `partial_payment` four times (prompt §1).
const koontilasku = () => JSON.parse(readFileSync(new URL('../../data/evals/fixtures/reconciliation/018-kultalanka-nets-koontilasku-rows.json', import.meta.url), 'utf8'));

test('normalizeUnifiedExtraction: a koontilasku with rows that foot — one document line per row at the row NET, the printed breakdown on the line, totals foot on the same formula', () => {
  const fixture = koontilasku();
  const raw = fixture.raw_extraction;
  assert.deepEqual(validateStrictSchema(UNIFIED_EXTRACTION_SCHEMA, raw), [], 'the fixture reply conforms to the schema');
  const result = normalizeUnifiedExtraction(raw, { documentType: 'payout_statement' });
  assert.equal(result.kind, 'completed_header');
  assert.equal(result.document_type, 'payout_statement');
  assert.equal(result.header.total_amount, 10206.48, 'the header total is the statement NET');
  assert.equal(result.summary.extraction_status, 'validated');
  // Four lines, one per row, at the row's net — what ONE bank credit settles.
  assert.deepEqual(result.lines.map((l) => [l.description, l.amount]), [
    ['VKO5 2025 (27.1.–2.2.)', 2452.72],
    ['VKO6 2025 (3.2.–9.2.)', 2581.29],
    ['VKO7 2025 (10.2.–16.2.)', 2462.61],
    ['VKO8 2025 (17.2.–23.2.)', 2709.86]
  ]);
  const row1 = result.lines[0].settlement_row;
  assert.deepEqual(row1, {
    row_no: 1, period_label: 'VKO5 2025 (27.1.–2.2.)', period_start: '2025-01-27', period_end: '2025-02-02', paid_on: '2025-02-03',
    gross: 2480, fee: 27.28, fee_tax: 0, net: 2452.72, net_derived: false, transaction_count: 31, reference: null
  });
  // The rows and their footing receipt ride the summary (parse_summary.settlement).
  const s = result.summary.settlement;
  assert.equal(s.rows.length, 4);
  assert.equal(s.gross_sales, 10320, 'statement totals stay the statement totals');
  assert.equal(s.fee_total, 113.52);
  assert.equal(s.net_payout, 10206.48);
  assert.deepEqual(s.rows_validation, { matches: true, row_count: 4, rows_missing_net: 0, expected: 10206.48, total: 10206.48, drift: 0, tolerance: 0.04, reason: null });
  // Σ lines = Σ nets = the net: the RT-04 totals formula foots unchanged.
  assert.equal(result.summary.totals_validation.matches, true);
  assert.equal(result.summary.totals_validation.expected, 10206.48);
  assert.ok(!result.summary.warnings.includes('settlement_rows_mismatch'));
  assert.ok(!result.summary.warnings.includes('amount_mismatch'));
});

test('normalizeUnifiedExtraction: rows that do NOT foot stay evidence — breakdown lines stand, the statement is partial, the mismatch is receipted; a row with no printed net derives it from gross − fee and says so', () => {
  const fixture = koontilasku();
  const raw = fixture.raw_extraction;
  // One row mis-read by 10 € — the rows no longer sum to the net.
  const broken = { ...raw, settlement: { ...raw.settlement, rows: raw.settlement.rows.map((r, i) => (i === 2 ? { ...r, net: r.net - 10 } : r)) } };
  const result = normalizeUnifiedExtraction(broken, { documentType: 'payout_statement' });
  assert.equal(result.kind, 'completed_header');
  assert.equal(result.summary.extraction_status, 'partial', 'a statement whose rows do not foot is a partial read');
  assert.ok(result.summary.warnings.includes('settlement_rows_mismatch'));
  assert.equal(result.summary.settlement.rows.length, 4, 'the rows stay on the summary as evidence');
  assert.equal(result.summary.settlement.rows_validation.matches, false);
  assert.equal(result.summary.settlement.rows_validation.drift, -10);
  assert.equal(result.summary.settlement.rows_validation.reason, 'rows_do_not_foot');
  // The breakdown lines (four gross components + the fee) stand as before RT-21b.
  assert.deepEqual(result.lines.map((l) => l.amount), [2480, 2610, 2490, 2740, -113.52]);
  assert.ok(result.lines.every((l) => !l.settlement_row), 'no row is promoted to a settleable line');
  assert.equal(result.header.total_amount, 10206.48, 'the printed net is never adjusted');
  assert.equal(result.summary.totals_validation.matches, true, 'the statement-level equation still foots');

  // A row that printed gross and fee but no net: the Keep layer derives it
  // (arithmetic, not intelligence) and receipts the derivation on the row.
  const noNet = { ...raw, settlement: { ...raw.settlement, rows: raw.settlement.rows.map((r, i) => (i === 0 ? { ...r, net: null } : r)) } };
  const derived = normalizeUnifiedExtraction(noNet, { documentType: 'payout_statement' });
  assert.equal(derived.summary.extraction_status, 'validated');
  assert.equal(derived.lines[0].amount, 2452.72);
  assert.equal(derived.lines[0].settlement_row.net_derived, true);
  assert.equal(derived.summary.settlement.rows_validation.matches, true);

  // A single-settlement statement (rows: []) is byte-identical to before.
  const single = normalizeUnifiedExtraction(payout(), {});
  assert.deepEqual(single.summary.settlement.rows, []);
  assert.equal(single.summary.settlement.rows_validation, null);
  assert.deepEqual(single.lines.map((l) => l.amount), [1250, -36.25]);
});

test('settlementRowsFoot: one cent per row of tolerance; a missing row net or statement net is an honest no', () => {
  assert.equal(settlementRowsFoot([], 10), null);
  assert.equal(settlementRowsFoot([{ net: 5 }, { net: 5.01 }], 10).matches, true, 'two rows, 2 cents of tolerance');
  assert.equal(settlementRowsFoot([{ net: 5 }, { net: 5.03 }], 10).matches, false);
  assert.equal(settlementRowsFoot([{ net: 5 }, { net: null }], 10).reason, 'row_net_missing');
  assert.equal(settlementRowsFoot([{ net: 5 }, { net: 5 }], null).reason, 'statement_net_missing');
});

test('normalizeUnifiedExtraction: a contract — the contract block lands on the summary, the header total falls back to the recurring amount, obligations ride the env gate', () => {
  const raw = bill({
    document_type: 'contract',
    header: header({ counterparty_name: 'Space Ltd', counterparty_role: 'vendor', total_amount: null, tax_amount: null, due_date: '2026-12-31', references: [{ type: 'contract_number', value: 'LEASE-7' }, { type: 'invoice_number', value: 'INV-1' }] }),
    lines: [],
    contract: {
      contract_type: 'lease', effective_start_date: '2026-09-01', effective_end_date: '2027-08-31', auto_renew: true, notice_period_days: 60,
      recurring_amount: 1500, recurring_frequency: 'monthly',
      obligations: [{ obligation_type: 'rent', payer: 'Kestrel', payee: 'Space Ltd', payer_role: 'tenant', payee_role: 'landlord', amount: 1500, currency: 'GBP', frequency: 'monthly', start_date: '2026-09-01', end_date: '2027-08-31', due_day: 1, escalation_clause: null, tax_clause: null, confidence: 0.9, source_evidence: 'Clause 3' }]
    }
  });
  const gated = normalizeUnifiedExtraction(raw, { env: {} });
  assert.equal(gated.document_type, 'contract');
  assert.equal(gated.header.total_amount, 1500, 'recurring amount backs the header total');
  assert.equal(gated.header.due_date, null);
  assert.equal(gated.header.payment_status, 'unknown');
  assert.equal(gated.header.reference_number, 'LEASE-7', 'contract references outrank invoice numbers');
  assert.equal(gated.summary.contract_type, 'lease');
  assert.equal(gated.summary.effective_end_date, '2027-08-31');
  assert.equal(gated.summary.recurring_frequency, 'monthly');
  assert.deepEqual(gated.summary.obligations, [], 'obligations stay behind CONTRACT_OBLIGATIONS_ENABLED this release');
  const open = normalizeUnifiedExtraction(raw, { env: { CONTRACT_OBLIGATIONS_ENABLED: 'true' } });
  assert.equal(open.summary.obligation_count, 1);
  assert.equal(open.summary.obligations[0].payee_role, 'landlord');
  assert.deepEqual(referencePriorityFor('contract').slice(0, 2), ['contract_number', 'agreement_number']);
  assert.equal(referencePriorityFor('receipt')[0], 'ticket_number');
});

test('normalizeUnifiedExtraction: an unusable read is UNREADABLE with the partial header the model DID return', () => {
  const low = normalizeUnifiedExtraction(bill({ extraction_status: 'partial', extraction_confidence: 0.2, header: header({ document_date: null }) }), {});
  assert.deepEqual([low.kind, low.code, low.reason, low.retryable], ['failed', 'DOCUMENT_EXTRACTION_UNREADABLE', 'low_confidence', false]);
  assert.equal(low.partial_header.document_type, 'supplier_bill');
  assert.equal(low.partial_header.extraction_status, 'partial');
  assert.equal(low.partial_header.extraction_confidence, 0.2);
  assert.equal(low.partial_header.header.counterparty_name, 'Ochre Lighting');
  assert.equal(low.partial_header.header.total_amount, 550);
  assert.equal(low.partial_header.header.document_date, null);
  assert.equal(low.partial_header.line_count, 2);
  const failed = normalizeUnifiedExtraction(bill({ extraction_status: 'failed' }), {});
  assert.equal(failed.reason, 'model_self_reported_failure');
  assert.ok(failed.partial_header);
  const unknown = normalizeUnifiedExtraction(bill({ document_type: 'unknown' }), {});
  assert.equal(unknown.reason, 'model_returned_unknown_type');
  assert.equal(normalizeUnifiedExtraction(bill({ document_type: 'memo' }), {}).reason, 'unknown_document_type:memo');
  assert.equal(normalizeUnifiedExtraction(null, {}).reason, 'model_response_not_object');
  const partialButUsable = normalizeUnifiedExtraction(bill({ extraction_status: 'partial', extraction_confidence: 0.6 }), {});
  assert.equal(partialButUsable.kind, 'completed_header', 'partial above the floor completes, as the per-type extractors did');
  assert.equal(partialButUsable.summary.extraction_status, 'partial');
});

test('normalizeUnifiedExtraction: warnings are namespaced, references deduped and capped, dates honour the day-first hint, currency normalised', () => {
  const result = normalizeUnifiedExtraction(bill({
    warnings: ['amount_mismatch', 'model:already', 'x\u0000y'],
    header: header({
      document_date: '12/08/2026', due_date: '2026-13-40', currency: 'gbp',
      references: [
        { type: 'invoice_number', value: ' OL-1 ' }, { type: 'invoice_number', value: 'ol-1' }, { type: 'bogus', value: 'z' },
        ...Array.from({ length: 10 }, (_, i) => ({ type: 'other', value: `R${i}` }))
      ]
    })
  }), { dateFormatHint: 'Dates on this document follow the DD/MM/YYYY-convention.' });
  assert.deepEqual(result.summary.warnings, ['model:amount_mismatch', 'model:already', 'model:xy']);
  assert.equal(result.header.document_date, '2026-08-12');
  assert.equal(result.header.due_date, null);
  assert.equal(result.header.currency, 'GBP');
  assert.equal(result.summary.references.length, 8);
  assert.equal(result.summary.references[0].value, 'OL-1');
  assert.equal(result.summary.references.filter((r) => r.type === 'invoice_number').length, 1);
});

test('normalizePaymentTerms: the supplierBill.js contract, re-homed', () => {
  assert.deepEqual(normalizePaymentTerms('Net 30'), { phrase: 'Net 30', days: 30 });
  assert.deepEqual(normalizePaymentTerms('Due on receipt'), { phrase: 'Due on receipt', days: 0 });
  assert.deepEqual(normalizePaymentTerms('Two weeks'), { phrase: 'Two weeks', days: 14 });
  assert.deepEqual(normalizePaymentTerms('End of month'), { phrase: 'End of month', days: null });
  assert.deepEqual(normalizePaymentTerms(null), { phrase: null, days: null });
});

// ── prompts and parts ──────────────────────────────────────────────────
test('the user prompt carries the routed type, the date hint verbatim (RT-10\'s seam), the extra hint, the firm anchor and prior corrections', () => {
  const text = __buildUserPrompt({
    filename: 'bill.pdf',
    documentType: 'supplier_bill',
    dateFormatHint: 'Dates follow the DD/MM/YYYY-convention.\n\nRe-read request: a previous extraction did not foot.',
    hint: 'Extra: the firm trades as Kestrel.',
    clientIdentity: { display_name: 'Kestrel Print Studio Ltd', legal_names: ['Kestrel Print Studio Ltd'] },
    priorCorrections: []
  });
  assert.match(text, /routed as "supplier_bill"/);
  assert.match(text, /Date format hint: Dates follow the DD\/MM\/YYYY-convention\.\n\nRe-read request/);
  assert.match(text, /Extra: the firm trades as Kestrel/);
  assert.match(text, /Kestrel Print Studio Ltd/);
  assert.match(__buildUserPrompt({ filename: 'x.pdf', documentType: 'unknown' }), /not routed to a type/);
});

test('__buildContentBlock — PDF detection survives missing or wrong mime metadata', () => {
  assert.equal(__buildContentBlock({ base64: PDF_B64, mimeType: '', filename: 'scan' }).source.media_type, 'application/pdf');
  assert.equal(__buildContentBlock({ base64: PDF_B64, mimeType: 'application/octet-stream', filename: '' }).type, 'document');
  assert.equal(__buildContentBlock({ base64: 'bm90LXBkZg==', mimeType: '', filename: 'Invoice 2.pdf' }).type, 'document');
  const jpeg = __buildContentBlock({ base64: '/9j/4AAQ', mimeType: 'image/jpeg', filename: 'photo.jpg' });
  assert.deepEqual([jpeg.type, jpeg.source.media_type], ['image', 'image/jpeg']);
  assert.equal(__buildContentBlock({ base64: 'bm90LXBkZg==', mimeType: '', filename: 'mystery.bin' }).source.media_type, 'image/png');
});

// ── the HTTP contract, both providers ──────────────────────────────────
test('extractUnified on OpenAI: Responses API, json_schema strict named for the lane, the document as an input_file, the response-named model on the receipt', async () => {
  const { calls, fetchImpl } = stubFetch({ provider: 'openai', text: JSON.stringify(bill()), model: 'gpt-5.4-2026-08-served' });
  const result = await extractUnified({
    base64: PDF_B64, filename: 'ochre.pdf', mimeType: 'application/pdf', documentType: 'supplier_bill', documentId: 'doc-1',
    env: { OPENAI_API_KEY: 'sk-o' }, fetchImpl
  });
  assert.equal(result.kind, 'completed_header');
  assert.deepEqual([result.provider, result.model, result.model_source, result.prompt_version],
    ['openai', 'gpt-5.4-2026-08-served', 'response_proven', UNIFIED_EXTRACTOR_PROMPT_VERSION]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-o');
  const body = calls[0].body;
  assert.equal(body.model, 'gpt-5.4');
  assert.equal(body.store, false);
  assert.ok(body.instructions.startsWith('You are extracting fields from one financial document'));
  assert.deepEqual(body.text.format, { type: 'json_schema', name: UNIFIED_EXTRACTION_SCHEMA_NAME, strict: true, schema: UNIFIED_EXTRACTION_SCHEMA });
  assert.equal(body.input[0].content[0].type, 'input_file');
  assert.equal(body.input[0].content[0].filename, 'ochre.pdf');
  assert.equal(body.input[0].content[1].type, 'input_text');
  assert.match(body.input[0].content[1].text, /routed as "supplier_bill"/);
});

test('extractUnified on Anthropic: Messages API, the document block, the reply as the structured-result tool call, the same schema validated after parse', async () => {
  const { calls, fetchImpl } = stubFetch({ provider: 'anthropic', text: '```json\n' + JSON.stringify(payout()) + '\n```', model: 'claude-opus-4-8-served' });
  const result = await extractUnified({
    base64: PDF_B64, filename: 'paylink.pdf', mimeType: '', documentType: 'unknown', documentId: 'doc-2',
    env: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' }, fetchImpl
  });
  assert.equal(result.kind, 'completed_header');
  assert.equal(result.document_type, 'payout_statement');
  assert.deepEqual([result.provider, result.model, result.model_source], ['anthropic', 'claude-opus-4-8-served', 'response_proven']);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-a');
  const body = calls[0].body;
  // 2026-11-10: the lane's Anthropic default stays claude-opus-4-8.
  assert.equal(body.model, 'claude-opus-4-8');
  // The shared Messages request (structuredRequest.js): structured
  // output through output_config.format, adaptive thinking, explicit effort,
  // streamed, and no forced tool choice and no server-side fallback.
  assert.equal(calls[0].init.headers['anthropic-version'], '2026-10-21');
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config.effort, 'high');
  // The unified schema carries 63 nullable fields — past the structured-
  // output limit of 16 union parameters — so it rides, whole, as the input
  // schema of one non-strict tool with tool_choice auto (forced tool choice
  // is rejected on the 5.x models); the reply is held to the same schema.
  assert.equal(body.output_config.format, undefined);
  assert.deepEqual(body.tools.map((tool) => tool.name), ['structured_answer']);
  assert.equal(body.tools[0].input_schema.properties.document_type.enum.length, UNIFIED_DOCUMENT_TYPES.length);
  assert.equal(body.tools[0].strict, undefined, 'non-strict: a strict tool is grammar-compiled under the same limits');
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.equal(body.max_tokens, 64000);
  assert.equal(body.fallbacks, undefined);
  assert.ok(body.system.startsWith('You are extracting fields from one financial document'));
  assert.equal(body.messages[0].content[0].type, 'document');
  assert.equal(body.messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(body.messages[0].content[1].type, 'text');
  assert.equal(body.text, undefined, 'no OpenAI-only fields on the Anthropic body');

  const broken = stubFetch({ provider: 'anthropic', text: JSON.stringify({ ...bill(), header: { ...header(), total_amount: 'five fifty' }, extra: 1 }), model: 'claude-opus-4-8' });
  const invalid = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { ANTHROPIC_API_KEY: 'sk-a' }, fetchImpl: broken.fetchImpl });
  assert.deepEqual([invalid.kind, invalid.code, invalid.reason, invalid.retryable], ['failed', 'DOCUMENT_EXTRACTION_FAILED', 'invalid_schema', false]);
  assert.ok(invalid.schema_violations.some((v) => v.includes('$.header.total_amount')));
  assert.ok(invalid.schema_violations.includes('$.extra: not in schema'));
  assert.equal(invalid.partial_header.header.counterparty_name, 'Ochre Lighting', 'even a schema-breaking reply keeps the header it carried');
});

test('extractUnified on Anthropic: a streamed reply is reassembled; refusal and max_tokens are the shared named failures, receipted with the served model', async () => {
  const streamed = stubFetch({ provider: 'anthropic', text: JSON.stringify(bill()), model: 'claude-opus-4-8', sse: true });
  const ok = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { ANTHROPIC_API_KEY: 'sk-a' }, fetchImpl: streamed.fetchImpl });
  assert.deepEqual([ok.kind, ok.provider, ok.model, ok.model_source], ['completed_header', 'anthropic', 'claude-opus-4-8', 'response_proven']);
  const refused = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { ANTHROPIC_API_KEY: 'sk-a' },
    fetchImpl: stubFetch({ provider: 'anthropic', text: '', model: 'claude-opus-4-8', stopReason: 'refusal', sse: true }).fetchImpl });
  // PROVIDER_REFUSED is not retryable; PROVIDER_OUTPUT_LIMIT is (the shared
  // failures' own posture, providerTransport.js).
  assert.deepEqual([refused.kind, refused.code, refused.reason, refused.retryable, refused.model, refused.model_source, refused.provider_failure],
    ['failed', 'DOCUMENT_EXTRACTION_FAILED', 'provider_refused', false, 'claude-opus-4-8', 'response_proven', 'refusal']);
  const cut = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { ANTHROPIC_API_KEY: 'sk-a' },
    fetchImpl: stubFetch({ provider: 'anthropic', text: '{"document_type":', model: 'claude-opus-4-8', stopReason: 'max_tokens' }).fetchImpl });
  assert.deepEqual([cut.code, cut.reason, cut.retryable, cut.model], ['DOCUMENT_EXTRACTION_FAILED', 'provider_output_limit', true, 'claude-opus-4-8']);
});

test('extractUnified: the model id falls back to the configured string, receipted as configured_fallback, when the response omits it', async () => {
  const { fetchImpl } = stubFetch({ provider: 'openai', text: JSON.stringify(bill()), model: null });
  const result = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { OPENAI_API_KEY: 'sk-o' }, fetchImpl });
  assert.deepEqual([result.model, result.model_source], ['gpt-5.4', 'configured_fallback']);
});

test('extractUnified: typed failures — 429 retryable, 400 rejected, network retryable, no key, empty input, garbage text; the provider pin and the legacy apiKey', async () => {
  const rate = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { OPENAI_API_KEY: 'sk-o' }, fetchImpl: stubFetch({ provider: 'openai', status: 429 }).fetchImpl });
  assert.deepEqual([rate.kind, rate.code, rate.retryable, rate.http_status, rate.provider], ['failed', 'DOCUMENT_EXTRACTION_FAILED', true, 429, 'openai']);
  const rejected = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { OPENAI_API_KEY: 'sk-o' }, fetchImpl: stubFetch({ provider: 'openai', status: 400 }).fetchImpl });
  assert.deepEqual([rejected.code, rejected.retryable], ['DOCUMENT_EXTRACTION_REJECTED', false]);
  const network = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { ANTHROPIC_API_KEY: 'sk-a' }, fetchImpl: stubFetch({ provider: 'anthropic', error: new Error('ECONNRESET') }).fetchImpl });
  assert.deepEqual([network.code, network.reason, network.retryable], ['DOCUMENT_EXTRACTION_FAILED', 'network_error', true]);
  const noKey = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: {} });
  assert.deepEqual([noKey.kind, noKey.code, noKey.reason, noKey.retryable, noKey.prompt_version], ['failed', 'DOCUMENT_EXTRACTION_FAILED', 'no_provider_key', false, UNIFIED_EXTRACTOR_PROMPT_VERSION]);
  const empty = await extractUnified({ base64: '', filename: 'x.pdf', env: { OPENAI_API_KEY: 'sk-o' } });
  assert.deepEqual([empty.code, empty.reason], ['DOCUMENT_EXTRACTION_UNREADABLE', 'empty_input']);
  const garbage = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', env: { OPENAI_API_KEY: 'sk-o' }, fetchImpl: stubFetch({ provider: 'openai', text: 'not json at all', model: 'gpt-5.4' }).fetchImpl });
  assert.deepEqual([garbage.code, garbage.reason, garbage.retryable], ['DOCUMENT_EXTRACTION_FAILED', 'invalid_json', false]);
  // The pin: both keys present, OpenAI asked for explicitly.
  const pinned = stubFetch({ provider: 'openai', text: JSON.stringify(bill()), model: 'gpt-5.4' });
  const viaPin = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' }, fetchImpl: pinned.fetchImpl });
  assert.equal(viaPin.provider, 'openai');
  assert.equal(pinned.calls[0].url, 'https://api.openai.com/v1/responses');
  // The legacy Anthropic key by name still lights the Anthropic path.
  const legacy = stubFetch({ provider: 'anthropic', text: JSON.stringify(bill()), model: 'claude-opus-4-8' });
  const viaApiKey = await extractUnified({ base64: PDF_B64, filename: 'x.pdf', apiKey: 'sk-legacy', env: {}, fetchImpl: legacy.fetchImpl });
  assert.equal(viaApiKey.provider, 'anthropic');
  assert.equal(legacy.calls[0].init.headers['x-api-key'], 'sk-legacy');
});

test('extractUnified: an unusable read on the wire returns UNREADABLE with the partial header and the served model', async () => {
  const { fetchImpl } = stubFetch({ provider: 'openai', text: JSON.stringify(bill({ extraction_status: 'partial', extraction_confidence: 0.15, header: header({ total_amount: null }) })), model: 'gpt-5.4-served' });
  const result = await extractUnified({ base64: PDF_B64, filename: 'blurry.pdf', env: { OPENAI_API_KEY: 'sk-o' }, fetchImpl });
  assert.deepEqual([result.kind, result.code, result.reason, result.retryable, result.model, result.provider], ['failed', 'DOCUMENT_EXTRACTION_UNREADABLE', 'low_confidence', false, 'gpt-5.4-served', 'openai']);
  assert.equal(result.partial_header.header.counterparty_name, 'Ochre Lighting');
  assert.equal(result.partial_header.header.total_amount, null);
});
