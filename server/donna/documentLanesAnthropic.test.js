// The document lanes on their Anthropic path (2026-11-10, the owner's decision
// that Donna runs on Claude): router, the per-type extractors, the payout
// extractor, client intake, parser repair and the receipt classifier, each
// served by scripted provider replies through the recorded-providers stub.
// Per lane: provider resolution (Anthropic first, OpenAI only without an
// Anthropic key, none ⇒ a reason naming the missing key), the request shape
// (the lane's own instructions as the system prompt, the file as a document
// block before the text, structured output from the lane's own schema,
// adaptive thinking, the lane's effort, streamed, no forced tool choice, no
// server-side fallback), the response-named model on the result, and the
// named failures (refusal, max_tokens, a provider status).
import assert from 'node:assert/strict';
import test from 'node:test';

import { schemaDeliveryFor, STRUCTURED_REPLY_TOOL, toStructuredOutputSchema } from './anthropicMessages.js';
import { extractClientIntakeDraft, __INTAKE_DRAFT_SCHEMA, __INSTRUCTIONS as INTAKE_INSTRUCTIONS } from './clientIntakeDraft.js';
import { extractContractFromBase64, __CONTRACT_EXTRACTION_SCHEMA } from './contract.js';
import { routeDocument, __ROUTER_SCHEMA } from './documentRouter.js';
import { extractGenericDocumentFromBase64, __GENERIC_DOCUMENT_EXTRACTION_SCHEMA } from './genericDocument.js';
import { repairMissingFields } from './parserRepair.js';
import { extractPayoutStatementFromBase64, __PAYOUT_EXTRACTION_SCHEMA, __PAYOUT_INSTRUCTIONS } from './payoutStatement.js';
import { extractReceiptFromBase64, __RECEIPT_EXTRACTION_SCHEMA } from './receipt.js';
import { classifyReceipt, __RECEIPT_CLASSIFIER_SCHEMA, __INSTRUCTIONS as CLASSIFIER_INSTRUCTIONS } from './receiptClassifier.js';
import { extractSalesInvoiceFromBase64, __INSTRUCTIONS as INVOICE_INSTRUCTIONS, __INVOICE_EXTRACTION_SCHEMA } from './salesInvoice.js';
import { extractSupplierBillFromBase64, __BILL_EXTRACTION_SCHEMA } from './supplierBill.js';
import { categorizeError, ParseError } from './inngest/parseErrors.js';
import { buildExtractorReceipt } from './inngest/parseDocument.js';
import { installRecordedProviders, loadRecording } from './testSupport/recordedProviders.js';

const PDF = 'JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0YK';
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'PARSER_REPAIR_ENABLED',
  'DOCUMENT_ROUTER_MODEL', 'BILL_EXTRACTOR_MODEL', 'INVOICE_EXTRACTOR_MODEL', 'CONTRACT_EXTRACTOR_MODEL',
  'GENERIC_DOC_MODEL', 'PAYOUT_EXTRACTOR_MODEL', 'CLIENT_INTAKE_MODEL', 'RECEIPT_CLASSIFIER_MODEL'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const restore = () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
const keys = ({ anthropic = false, openai = false } = {}) => {
  for (const key of KEYS) delete process.env[key];
  if (anthropic) process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  if (openai) process.env.OPENAI_API_KEY = 'sk-openai-test';
};

// A schema-valid reply built from the lane's own schema: the first enum
// value (never 'failed'), a non-empty string, 1 for numbers, [] for arrays.
const sampleFrom = (schema, key = '') => {
  if (schema.anyOf) return sampleFrom(schema.anyOf.find((option) => option.type !== 'null') || schema.anyOf[0], key);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (schema.enum) return schema.enum.find((value) => value !== 'failed') ?? schema.enum[0];
  if (type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([name, sub]) => [name, sampleFrom(sub, name)]));
  if (type === 'array') return [];
  if (type === 'number' || type === 'integer') return /confidence/.test(key) ? 0.9 : 1;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (/date/.test(key)) return '2025-02-14';
  if (/currency/.test(key)) return 'EUR';
  return `Synteetti ${key || 'value'}`;
};

// A reply in the shape the request asked for: the structured-result tool
// call when the request carries the tool (a schema past the structured-output
// limits), JSON text otherwise. `prose` forces a text reply.
const message = (object, { model = 'claude-opus-5-5', stopReason = 'end_turn', sent = null, prose = false } = {}) => {
  const viaTool = !prose && Array.isArray(sent?.tools) && sent.tools.some((tool) => tool.name === STRUCTURED_REPLY_TOOL);
  const block = viaTool
    ? { type: 'tool_use', id: 'toolu_synthetic', name: STRUCTURED_REPLY_TOOL, input: object }
    : { type: 'text', text: typeof object === 'string' ? object : JSON.stringify(object) };
  return {
    status: 200,
    body: {
      id: 'msg_synthetic', type: 'message', role: 'assistant', model,
      content: stopReason === 'refusal' ? [] : [block],
      stop_reason: stopReason === 'end_turn' && viaTool ? 'tool_use' : stopReason,
      stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null } : null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }
  };
};
const replyTo = (object, options = {}) => ({ respond: (sent) => message(object, { ...options, sent }) });

const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'];
const assertStructuredSchema = (sent, original, label) => {
  assert.deepEqual(sent, toStructuredOutputSchema(original), `${label}: the lane's own schema is what is sent`);
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${path}[${i}]`)); return; }
    for (const keyword of UNSUPPORTED) assert.ok(!(keyword in node), `${label}: ${path} carries ${keyword}`);
    if (node.type === 'object') assert.equal(node.additionalProperties, false, `${label}: ${path} is closed`);
    assert.ok(!Array.isArray(node.type), `${label}: ${path} uses anyOf, not a type array`);
    for (const value of Object.values(node)) walk(value, path);
  };
  walk(sent, '$');
};

const assertAnthropicRequest = (body, { effort, system, schema, label, fileFirst = true }) => {
  assert.equal(body.model, 'claude-opus-5-5', `${label}: model`);
  assert.equal(body.stream, true, `${label}: streamed`);
  assert.deepEqual(body.thinking, { type: 'adaptive' }, `${label}: adaptive thinking`);
  assert.equal(body.output_config.effort, effort, `${label}: effort`);
  if (schemaDeliveryFor(schema) === 'output_format') {
    assert.equal(body.output_config.format.type, 'json_schema', `${label}: structured output`);
    assertStructuredSchema(body.output_config.format.schema, schema, label);
    assert.equal(body.tools, undefined, `${label}: no tools`);
    assert.equal(body.tool_choice, undefined, `${label}: no tool choice`);
  } else {
    // Past the structured-output limits: the lane's own schema, whole, as one
    // non-strict tool; auto choice (forced choice is rejected on this model).
    assert.equal(body.output_config.format, undefined, `${label}: no grammar-compiled format`);
    assert.equal(body.tools.length, 1, `${label}: one tool`);
    assert.equal(body.tools[0].name, STRUCTURED_REPLY_TOOL);
    assert.deepEqual(body.tools[0].input_schema, schema, `${label}: the lane's own schema, unchanged`);
    assert.equal(body.tools[0].strict, undefined, `${label}: non-strict`);
    assert.deepEqual(body.tool_choice, { type: 'auto' }, `${label}: auto tool choice`);
  }
  if (system) assert.ok(body.system.startsWith(system.slice(0, 80)), `${label}: the lane's instructions are the system prompt`);
  if (fileFirst) {
    assert.equal(body.messages[0].content[0].type, 'document', `${label}: the file first`);
    assert.equal(body.messages[0].content[0].source.media_type, 'application/pdf');
    assert.equal(body.messages[0].content.at(-1).type, 'text');
  }
  for (const field of ['fallbacks', 'temperature', 'top_p', 'top_k']) {
    assert.equal(body[field], undefined, `${label}: no ${field}`);
  }
  assert.ok(body.max_tokens >= 16000, `${label}: max_tokens leaves room for thinking`);
};

// The extractors that share one failure contract.
const EXTRACTORS = [
  { label: 'receipt', lane: 'receipt_extraction', run: extractReceiptFromBase64, schema: __RECEIPT_EXTRACTION_SCHEMA, recording: 'receipt_extraction/screwfix', completed: 'completed' },
  { label: 'supplier bill', lane: 'supplier_bill_extraction', run: extractSupplierBillFromBase64, schema: __BILL_EXTRACTION_SCHEMA, recording: 'supplier_bill_extraction/ochre-discount-line', completed: 'completed' },
  { label: 'sales invoice', lane: 'sales_invoice_extraction', run: extractSalesInvoiceFromBase64, schema: __INVOICE_EXTRACTION_SCHEMA, system: INVOICE_INSTRUCTIONS, completed: 'completed' },
  { label: 'contract', lane: 'contract_extraction', run: extractContractFromBase64, schema: __CONTRACT_EXTRACTION_SCHEMA, completed: 'completed' },
  { label: 'generic document', lane: 'generic_document_extraction', run: extractGenericDocumentFromBase64, schema: __GENERIC_DOCUMENT_EXTRACTION_SCHEMA, completed: 'completed' },
  { label: 'payout statement', lane: 'payout_statement_extraction', run: extractPayoutStatementFromBase64, schema: __PAYOUT_EXTRACTION_SCHEMA, system: __PAYOUT_INSTRUCTIONS, recording: 'payout_statement_extraction/paylink-PO-88121', completed: 'completed' }
];

for (const lane of EXTRACTORS) {
  test(`${lane.label} on Anthropic: the request shape, the served model on the receipt, the provider named`, async () => {
    keys({ anthropic: true });
    const providers = installRecordedProviders();
    try {
      let body = null;
      providers.script(lane.lane, {
        respond: (sent) => {
          body = sent;
          return lane.recording ? { recording: `${lane.recording}-anthropic` } : message(sampleFrom(lane.schema), { sent });
        }
      });
      const result = await lane.run({ base64: PDF, filename: 'synteetti.pdf', mimeType: 'application/pdf' });
      providers.assertNoUnscripted();
      assertAnthropicRequest(body, { effort: 'high', system: lane.system, schema: lane.schema, label: lane.label });
      assert.equal(result.kind, lane.completed, `${lane.label}: ${JSON.stringify([result.code, result.reason])}`);
      assert.equal(result.model, 'claude-opus-5-5', `${lane.label}: the model the response named`);
      assert.equal(result.provider, 'anthropic');
    } finally { providers.restore(); restore(); }
  });

  test(`${lane.label}: refusal and max_tokens are terminal named failures; a 529 stays retryable and names Anthropic`, async () => {
    keys({ anthropic: true });
    const providers = installRecordedProviders();
    try {
      providers.script(lane.lane, [
        message(null, { stopReason: 'refusal', model: 'claude-opus-5-5' }),
        message({ partial: true }, { stopReason: 'max_tokens' }),
        { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }
      ]);
      const refused = await lane.run({ base64: PDF, filename: 'a.pdf', mimeType: 'application/pdf' });
      assert.deepEqual([refused.kind, refused.code, refused.reason, refused.model, refused.provider],
        ['failed', 'DOCUMENT_EXTRACTION_REJECTED', 'provider_refusal', 'claude-opus-5-5', 'anthropic'], lane.label);
      const cut = await lane.run({ base64: PDF, filename: 'a.pdf', mimeType: 'application/pdf' });
      assert.deepEqual([cut.code, cut.reason], ['DOCUMENT_EXTRACTION_REJECTED', 'provider_max_tokens'], lane.label);
      const overloaded = await lane.run({ base64: PDF, filename: 'a.pdf', mimeType: 'application/pdf' });
      assert.deepEqual([overloaded.code, overloaded.reason, overloaded.provider], ['DOCUMENT_EXTRACTION_FAILED', 'anthropic_529', 'anthropic'], lane.label);
    } finally { providers.restore(); restore(); }
  });

  test(`${lane.label}: no key at all names the missing key; OpenAI only without an Anthropic key`, async () => {
    keys({});
    try {
      const none = await lane.run({ base64: PDF, filename: 'a.pdf', mimeType: 'application/pdf' });
      assert.deepEqual([none.kind, none.code, none.reason, none.provider], ['failed', 'DOCUMENT_EXTRACTION_FAILED', 'no_provider_key', null]);
    } finally { restore(); }
    if (!lane.recording) return;
    keys({ openai: true });
    const providers = installRecordedProviders();
    try {
      providers.script(lane.lane, lane.recording);
      const result = await lane.run({ base64: PDF, filename: 'a.pdf', mimeType: 'application/pdf' });
      assert.equal(result.provider, 'openai');
      assert.equal(providers.callsFor(lane.lane)[0].endpoint_class, 'openai');
      assert.equal(result.model, loadRecording(lane.recording).body.model);
    } finally { providers.restore(); restore(); }
  });
}

test('a lane on tool delivery: a prose reply (no tool call) and a reply that breaks the lane schema are named, terminal failures', async () => {
  keys({ anthropic: true });
  const providers = installRecordedProviders();
  try {
    assert.equal(schemaDeliveryFor(__BILL_EXTRACTION_SCHEMA), 'tool', 'the bill schema carries 17 nullable fields');
    assert.equal(schemaDeliveryFor(__RECEIPT_EXTRACTION_SCHEMA), 'output_format', 'the receipt schema carries 16');
    providers.script('supplier_bill_extraction', [
      replyTo('The bill is from Synteetti Oy and totals 12,40 EUR.', { prose: true }),
      replyTo({ ...sampleFrom(__BILL_EXTRACTION_SCHEMA), extra_field: 1 })
    ]);
    const prose = await extractSupplierBillFromBase64({ base64: PDF, filename: 'a.pdf', mimeType: 'application/pdf' });
    assert.deepEqual([prose.code, prose.reason, prose.model], ['DOCUMENT_EXTRACTION_REJECTED', 'provider_no_structured_reply', 'claude-opus-5-5']);
    const broken = await extractSupplierBillFromBase64({ base64: PDF, filename: 'a.pdf', mimeType: 'application/pdf' });
    assert.deepEqual([broken.code, broken.reason], ['DOCUMENT_EXTRACTION_REJECTED', 'provider_schema_violation']);
  } finally { providers.restore(); restore(); }
});

test('router on Anthropic: the twin recording, low effort, the file then the identity text, the served model on the routing receipt', async () => {
  keys({ anthropic: true, openai: true });
  const providers = installRecordedProviders();
  try {
    let body = null;
    providers.script('document_routing', { respond: (sent) => { body = sent; return { recording: 'document_routing/ochre-supplier-bill-anthropic' }; } });
    const result = await routeDocument({
      base64: PDF, filename: 'lasku.pdf', mimeType: 'application/pdf',
      clientIdentity: { display_name: 'Synteetti Oy', legal_names: ['Synteetti Oy'] }
    });
    assertAnthropicRequest(body, { effort: 'low', schema: __ROUTER_SCHEMA, label: 'router', system: 'You are classifying a document for a bookkeeping system' });
    assert.equal(body.messages[0].content[1].text, 'Classify this document per the schema.');
    assert.ok(body.messages[0].content[2].text.includes('Synteetti Oy'), 'the client identity rides as it does on OpenAI');
    assert.deepEqual([result.routed, result.provider, result.model, result.model_source, result.family, result.recommended_extractor],
      [true, 'anthropic', 'claude-opus-5-5', 'response_proven', 'invoice_or_bill', 'supplier_bill']);
  } finally { providers.restore(); restore(); }
});

test('router: no key ⇒ api_key_missing naming the missing key; a refusal ⇒ llm_error, never a family', async () => {
  keys({});
  try {
    assert.deepEqual(await routeDocument({ base64: PDF, filename: 'x.pdf' }), { routed: false, reason: 'api_key_missing', provider_reason: 'no_provider_key' });
  } finally { restore(); }
  keys({ anthropic: true });
  const providers = installRecordedProviders();
  try {
    providers.script('document_routing', message(null, { stopReason: 'refusal' }));
    const refused = await routeDocument({ base64: PDF, filename: 'x.pdf' });
    assert.deepEqual([refused.routed, refused.reason, refused.failure, refused.model], [false, 'llm_error', 'provider_refusal', 'claude-opus-5-5']);
  } finally { providers.restore(); restore(); }
});

test('router: DOCUMENT_ROUTER_MODEL pins the provider by id — a gpt id goes to OpenAI with both keys', async () => {
  keys({ anthropic: true, openai: true });
  process.env.DOCUMENT_ROUTER_MODEL = 'gpt-5.4';
  const providers = installRecordedProviders();
  try {
    providers.script('document_routing', 'document_routing/ochre-supplier-bill');
    const result = await routeDocument({ base64: PDF, filename: 'x.pdf' });
    assert.equal(result.provider, 'openai');
    assert.equal(providers.callsFor('document_routing')[0].endpoint_class, 'openai');
  } finally { providers.restore(); restore(); }
});

test('client intake on Anthropic: medium effort, the file first, the model on the draft receipt', async () => {
  keys({ anthropic: true });
  const providers = installRecordedProviders();
  try {
    let body = null;
    providers.script('client_intake_draft', { respond: (sent) => { body = sent; return message({ ...sampleFrom(__INTAKE_DRAFT_SCHEMA), company_name: 'Synteetti Oy', extraction_status: 'confident' }, { sent }); } });
    const result = await extractClientIntakeDraft({ base64: PDF, filename: 'kaupparekisteriote.pdf', mimeType: 'application/pdf' });
    assertAnthropicRequest(body, { effort: 'medium', schema: __INTAKE_DRAFT_SCHEMA, label: 'intake', system: INTAKE_INSTRUCTIONS });
    assert.deepEqual([result.kind, result.provider, result.model, result.draft.company_name], ['ok', 'anthropic', 'claude-opus-5-5', 'Synteetti Oy']);
    // Pasted text: no file block, the text in the user turn.
    providers.script('client_intake_draft', { respond: (sent) => { body = sent; return message({ ...sampleFrom(__INTAKE_DRAFT_SCHEMA), company_name: 'Synteetti Oy' }, { sent }); } });
    await extractClientIntakeDraft({ text: 'Synteetti Oy, Y-tunnus 0000000-0' });
    assert.deepEqual(body.messages[0].content.map((block) => block.type), ['text']);
    keys({});
    assert.deepEqual(await extractClientIntakeDraft({ text: 'x' }), { kind: 'failed', code: 'DOCUMENT_EXTRACTION_FAILED', reason: 'no_provider_key' });
  } finally { providers.restore(); restore(); }
});

test('parser repair on Anthropic: medium effort, the repair schema (nullable fields as anyOf), the repaired header', async () => {
  keys({ anthropic: true });
  process.env.PARSER_REPAIR_ENABLED = 'true';
  const providers = installRecordedProviders();
  try {
    let body = null;
    providers.script('parser_repair', { respond: (sent) => { body = sent; return message({ vendor_name: 'Synteetti Oy', total_amount: 12.5 }, { sent }); } });
    const header = { vendor_name: null, document_date: '2025-02-14', total_amount: null };
    const summary = { warnings: [] };
    const result = await repairMissingFields({ base64: PDF, filename: 'k.pdf', mimeType: 'application/pdf', header, summary, documentType: 'receipt' });
    assert.equal(body.output_config.effort, 'medium');
    assert.deepEqual(body.output_config.format.schema.properties.vendor_name, { anyOf: [{ type: 'string' }, { type: 'null' }] });
    assert.ok(body.system.startsWith('The following fields could not be extracted on the first pass'));
    assert.deepEqual([result.repaired, header.vendor_name, header.total_amount], [true, 'Synteetti Oy', 12.5]);
    providers.script('parser_repair', message(null, { stopReason: 'refusal' }));
    const refused = await repairMissingFields({ base64: PDF, filename: 'k.pdf', header: { vendor_name: null, document_date: 'x', total_amount: 1 }, summary: { warnings: [] }, documentType: 'receipt' });
    assert.equal(refused.repaired, false, 'a refusal leaves the header as extracted');
  } finally { providers.restore(); restore(); }
});

test('receipt classifier on Anthropic: low effort, text only, the provider and served model on the semantic output', async () => {
  keys({ anthropic: true });
  const providers = installRecordedProviders();
  try {
    let body = null;
    providers.script('receipt_classification', { respond: (sent) => { body = sent; return message(sampleFrom(__RECEIPT_CLASSIFIER_SCHEMA), { sent }); } });
    const result = await classifyReceipt({ header: { vendor_name: 'Synteetti Kahvila', total_amount: 4.2, currency: 'EUR' }, summary: {}, lines: [], filename: 'kuitti.pdf' });
    assertAnthropicRequest(body, { effort: 'low', schema: __RECEIPT_CLASSIFIER_SCHEMA, label: 'classifier', system: CLASSIFIER_INSTRUCTIONS, fileFirst: false });
    assert.ok(body.messages[0].content.every((block) => block.type === 'text'), 'text only, never vision');
    assert.deepEqual([result.used_fallback, result.provider, result.model], [false, 'anthropic', 'claude-opus-5-5']);
    keys({});
    const none = await classifyReceipt({ header: { vendor_name: 'x' } });
    assert.deepEqual([none.used_fallback, none.fallback_reason], [true, 'no_provider_key']);
  } finally { providers.restore(); restore(); }
});

test('the parse pipeline: a missing key is stored as the missing key, never as OpenAI', () => {
  const envelope = categorizeError(new ParseError('DOCUMENT_EXTRACTION_FAILED', {
    message: 'Supplier bill extraction failed: no_provider_key', provider: null, reason: 'no_provider_key'
  }));
  assert.deepEqual([envelope.code, envelope.provider, envelope.reason], ['DOCUMENT_EXTRACTION_FAILED', 'model_provider', 'no_provider_key']);
  const receipt = buildExtractorReceipt({ documentType: 'supplier_bill', result: { extractor_model: 'claude-opus-5-5', extractor_provider: 'anthropic' } });
  assert.deepEqual([receipt.provider, receipt.model], ['anthropic', 'claude-opus-5-5']);
  assert.equal(buildExtractorReceipt({ documentType: 'supplier_bill', result: {} }).provider, null, 'no provider is guessed');
});
