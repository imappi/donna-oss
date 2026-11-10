// The statement reader on its Anthropic path (2026-11-10, the owner's
// decision that Donna runs on Claude): the same cases bankStatementVision.test.js
// and bankStatementLlmFirst.test.js prove on OpenAI, served by scripted
// provider replies through the recorded-providers stub (the HTTP boundary).
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import {
  __fitChunksToRequestLimit,
  extractStructuredFromOpenAiVisionPaginated,
  extractStructuredFromStatementText,
  isOpenAiVisionConfigured,
  ocrPdfWithOpenAiVision
} from './bankStatementVision.js';
import { installRecordedProviders } from './testSupport/recordedProviders.js';

const KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_VISION_MODEL', 'OPENAI_VISION_CACHE_DISABLED', 'OPENAI_VISION_PAGES_PER_CHUNK'];
const saved = Object.fromEntries(KEY_VARS.map((key) => [key, process.env[key]]));
const restoreEnv = () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
};
const onlyAnthropic = () => {
  for (const key of KEY_VARS) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENAI_VISION_CACHE_DISABLED = 'true';
};

const buildPdfBase64 = async (pageCount) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage([400, 200]).drawText(`page ${index + 1}`, { x: 50, y: 100, size: 14, font });
  }
  return Buffer.from(await pdf.save()).toString('base64');
};

const message = (object, { model = 'claude-opus-5-5', stopReason = 'end_turn', text = null } = {}) => ({
  status: 200,
  body: {
    id: 'msg_synthetic', type: 'message', role: 'assistant', model,
    content: stopReason === 'refusal' ? [] : [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: text ?? JSON.stringify(object) }],
    stop_reason: stopReason, stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null } : null,
    usage: { input_tokens: 10, output_tokens: 20 }
  }
});

const row = (date, description, direction, amount, balance) => ({
  date, counterparty: description, payment_method: 'TILISIIRTO', message: null, reference: null,
  description, direction, amount, currency: 'EUR', balance
});

const userBlocks = (body) => body.messages[0].content;
const promptOf = (body) => userBlocks(body).find((block) => block.type === 'text').text;

test('Anthropic is chosen when its key is the only one; isOpenAiVisionConfigured reads the lane, not one provider', () => {
  onlyAnthropic();
  try {
    assert.equal(isOpenAiVisionConfigured(), true);
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isOpenAiVisionConfigured(), false);
  } finally { restoreEnv(); }
});

test('no key at all: the reader refuses with a reason naming the missing provider key, not OpenAI', async () => {
  for (const key of KEY_VARS) delete process.env[key];
  try {
    await assert.rejects(() => extractStructuredFromOpenAiVisionPaginated({ base64: 'JVBERi0x', filename: 's.pdf' }),
      (error) => error.code === 'STATEMENT_READER_NOT_CONFIGURED' && error.reason === 'no_provider_key' && !/openai/i.test(error.message));
  } finally { restoreEnv(); }
});

test('paginated vision on Anthropic: one request per chunk, document block before the text, structured output, merged rows kept, the response model on the result', async () => {
  onlyAnthropic();
  const providers = installRecordedProviders();
  try {
    const base64 = await buildPdfBase64(8);
    const bodies = [];
    providers.script('bank_statement_extraction', {
      times: 2,
      respond: (body) => {
        bodies.push(body);
        const first = promptOf(body).includes('pages 1–4');
        return message({
          transactions: first
            ? [row('2025-02-03', 'Kahvila Synteetti', 'out', 5.5, 994.5), row('2025-02-05', 'Asiakas Oy', 'in', 400, 1394.5)]
            // Equal values on a disjoint page are a separate payment.
            : [row('2025-02-05', 'Asiakas Oy', 'in', 400, 1794.5)],
          statement_summary: first
            ? { opening_balance: 1000, closing_balance: null, total_deposits: null, total_payouts: null, currency: 'EUR', period_start: '2025-02-01', period_end: null, account_identifier: 'FI00 0000 0000 0000 00' }
            : { opening_balance: null, closing_balance: 1794.5, total_deposits: null, total_payouts: null, currency: 'EUR', period_start: null, period_end: '2025-02-28', account_identifier: null }
        });
      }
    });
    const result = await extractStructuredFromOpenAiVisionPaginated({ base64, filename: 'tiliote.pdf', pagesPerChunk: 4, concurrency: 1 });
    providers.assertNoUnscripted();
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.model, 'claude-opus-5-5');
      assert.equal(body.stream, true);
      assert.deepEqual(body.thinking, { type: 'adaptive' });
      assert.equal(body.output_config.effort, 'high');
      assert.equal(body.output_config.format.type, 'json_schema');
      assert.deepEqual(body.output_config.format.schema.required, ['transactions', 'statement_summary']);
      assert.equal(userBlocks(body)[0].type, 'document');
      assert.equal(userBlocks(body)[0].source.media_type, 'application/pdf');
      assert.equal(userBlocks(body)[1].type, 'text');
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.fallbacks, undefined);
      assert.ok(body.max_tokens >= 64000);
    }
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-opus-5-5', 'the model id is the one the response named');
    assert.equal(result.transactions.length, 3, 'equal rows on disjoint pages are both kept');
    assert.equal(result.statement_summary.opening_balance, 1000);
    assert.equal(result.statement_summary.closing_balance, 1794.5);
    assert.equal(result.transactions[0].description, 'Kahvila Synteetti');
    const calls = providers.callsFor('bank_statement_extraction');
    assert.deepEqual(calls.map((call) => [call.endpoint_class, call.model_requested, call.model_served]),
      [['anthropic', 'claude-opus-5-5', 'claude-opus-5-5'], ['anthropic', 'claude-opus-5-5', 'claude-opus-5-5']]);
  } finally { providers.restore(); restoreEnv(); }
});

test('the served model is the receipt even when the configured id differs', async () => {
  onlyAnthropic();
  process.env.OPENAI_VISION_MODEL = 'claude-opus-5-5';
  const providers = installRecordedProviders();
  try {
    providers.script('bank_statement_extraction', message({ transactions: [row('2025-02-03', 'A', 'out', 1, 9)], statement_summary: null }, { model: 'claude-opus-5-5-served' }));
    const result = await extractStructuredFromOpenAiVisionPaginated({ base64: await buildPdfBase64(1), filename: 's.pdf' });
    assert.equal(result.model, 'claude-opus-5-5-served');
  } finally { providers.restore(); restoreEnv(); }
});

test('the lane model knob pins the provider by id: a gpt id with both keys goes to OpenAI', async () => {
  onlyAnthropic();
  process.env.OPENAI_API_KEY = 'sk-openai-test';
  process.env.OPENAI_VISION_MODEL = 'gpt-5.4';
  const providers = installRecordedProviders();
  try {
    providers.script('bank_statement_extraction', { status: 200, body: { id: 'resp', model: 'gpt-5.4', output: [{ content: [{ text: JSON.stringify({ transactions: [], statement_summary: null }) }] }] } });
    const result = await extractStructuredFromOpenAiVisionPaginated({ base64: await buildPdfBase64(1), filename: 's.pdf' });
    assert.equal(result.provider, 'openai');
    assert.equal(providers.callsFor('bank_statement_extraction')[0].endpoint_class, 'openai');
  } finally { providers.restore(); restoreEnv(); }
});

test('a chunk over the request limit is split down to single pages on Anthropic; never dropped; an unsplittable page fails as too large', async () => {
  const base64 = await buildPdfBase64(4);
  const chunks = [{ base64, pageStart: 5, pageEnd: 8, totalPages: 8 }];
  const fitted = await __fitChunksToRequestLimit({ provider: 'anthropic' }, chunks, base64.length - 1);
  assert.deepEqual(fitted.map((chunk) => [chunk.pageStart, chunk.pageEnd, chunk.totalPages]), [[5, 5, 8], [6, 6, 8], [7, 7, 8], [8, 8, 8]]);
  assert.deepEqual(await __fitChunksToRequestLimit({ provider: 'openai' }, chunks, 1), chunks, 'the OpenAI path splits as before');
  await assert.rejects(() => __fitChunksToRequestLimit({ provider: 'anthropic' }, chunks, 10),
    (error) => error.code === 'OPENAI_VISION_PDF_TOO_LARGE');
});

test('refusal and max_tokens are named failures, never a partial statement', async () => {
  onlyAnthropic();
  const providers = installRecordedProviders();
  try {
    const base64 = await buildPdfBase64(1);
    providers.script('bank_statement_extraction', message(null, { stopReason: 'refusal' }));
    await assert.rejects(() => extractStructuredFromOpenAiVisionPaginated({ base64, filename: 's.pdf' }),
      (error) => error.code === 'PROVIDER_REFUSED' && error.servedModel === 'claude-opus-5-5');
    providers.script('bank_statement_extraction', message(null, { stopReason: 'max_tokens', text: '{"transactions":[' }));
    await assert.rejects(() => extractStructuredFromOpenAiVisionPaginated({ base64, filename: 's.pdf' }),
      (error) => error.code === 'PROVIDER_OUTPUT_LIMIT');
    providers.script('bank_statement_extraction', { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    await assert.rejects(() => extractStructuredFromOpenAiVisionPaginated({ base64, filename: 's.pdf' }),
      (error) => error.code === 'LLM_CALL_PROVIDER_ERROR' && error.statusCode === 529);
  } finally { providers.restore(); restoreEnv(); }
});

test('the text transport on Anthropic: the statement text in the user turn, no file block, the same schema', async () => {
  onlyAnthropic();
  const providers = installRecordedProviders();
  try {
    let seen = null;
    providers.script('bank_statement_extraction', { respond: (body) => { seen = body; return message({ transactions: [row('2025-02-03', 'Vuokranantaja Oy', 'out', 800, 200)], statement_summary: null }); } });
    const result = await extractStructuredFromStatementText({ text: '03.02. Vuokranantaja Oy -800,00 200,00', filename: 'tiliote.txt' });
    assert.equal(seen.messages[0].content.length, 1);
    assert.equal(seen.messages[0].content[0].type, 'text');
    assert.ok(promptOf(seen).includes('--- STATEMENT TEXT (tiliote.txt) ---'));
    assert.equal(seen.output_config.format.type, 'json_schema');
    assert.deepEqual([result.provider, result.model, result.transactions.length, result.transactions[0].parser_flags[0]],
      ['anthropic', 'claude-opus-5-5', 1, 'openai_text']);
  } finally { providers.restore(); restoreEnv(); }
});

test('the plain transcription entry on Anthropic asks for text: effort, no format', async () => {
  onlyAnthropic();
  const providers = installRecordedProviders();
  try {
    let seen = null;
    providers.script('bank_statement_ocr', { respond: (body) => { seen = body; return message(null, { text: '01.02.2025 Alkusaldo 1 000,00' }); } });
    const text = await ocrPdfWithOpenAiVision({ base64: await buildPdfBase64(1), filename: 's.pdf' });
    assert.equal(text, '01.02.2025 Alkusaldo 1 000,00');
    assert.deepEqual(seen.output_config, { effort: 'medium' });
    assert.equal(seen.messages[0].content[0].type, 'document');
  } finally { providers.restore(); restoreEnv(); }
});

// A refusal or a cut-off from the strong reader is the named failure on the
// document — never the plain transcription + regex fallback, never the
// text-layer regex tiers — and the parse worker throws it with the model that
// answered (refusal / output limit final, an answer outside the schema
// retryable).
test('the statement pipeline: a strong-reader stop is a named failure on the document, never a weaker reader\'s guess', async () => {
  const { extractBankStatementFromBase64 } = await import('./bankStatement.js');
  const { readFileSync } = await import('node:fs');
  const scanned = readFileSync(new URL('../../data/evals/fixtures/fi-kultalanka-2025-02/sources/01 OP Tiliote 02-2025.pdf', import.meta.url)).toString('base64');
  onlyAnthropic();
  const providers = installRecordedProviders();
  try {
    providers.script('bank_statement_extraction', [message(null, { stopReason: 'refusal' })]);
    const refused = await extractBankStatementFromBase64({ base64: scanned, filename: 'tiliote.pdf', mimeType: 'application/pdf' });
    assert.equal(refused.extraction_diagnostics.vision_skipped, 'provider_stop', JSON.stringify(refused.extraction_diagnostics));
    assert.deepEqual(refused.extraction_diagnostics.vision_skipped_details,
      { fault: 'provider_refused', code: 'DOCUMENT_EXTRACTION_REJECTED', provider: 'anthropic', model: 'claude-opus-5-5' });
    assert.deepEqual(refused.transactions, []);
    assert.equal(providers.callsFor('bank_statement_ocr').length, 0, 'no plain transcription after a refusal');

    // Forced vision (the validation re-read) stops the same way.
    providers.script('bank_statement_extraction', [message({ transactions: [] }, { stopReason: 'max_tokens' })]);
    const cut = await extractBankStatementFromBase64({ base64: scanned, filename: 'tiliote.pdf', mimeType: 'application/pdf', preferVision: true, bypassCache: true });
    assert.deepEqual([cut.extraction_diagnostics.vision_skipped, cut.extraction_diagnostics.vision_skipped_details.code, cut.extraction_diagnostics.vision_skipped_details.fault],
      ['provider_stop', 'DOCUMENT_EXTRACTION_REJECTED', 'provider_output_limit']);

    // The text-layer LLM-first path: no regex tiers after a stop.
    providers.script('bank_statement_extraction', [message(null, { text: 'I read the statement but here is prose.' })]);
    const text = Buffer.from('03.02.2025 KAHVILA AROMA OY -12,40\n04.02.2025 NETS FINLAND OY +2 452,72\n').toString('base64');
    const prose = await extractBankStatementFromBase64({ base64: text, filename: 'tiliote.txt', mimeType: 'text/plain', llmFirst: true });
    assert.deepEqual([prose.extraction_diagnostics.vision_skipped, prose.extraction_diagnostics.vision_skipped_details.code, prose.transactions.length],
      ['provider_stop', 'DOCUMENT_EXTRACTION_FAILED', 0], 'an answer outside the schema is retryable, and no regex guess is kept');
    providers.assertNoUnscripted();
  } finally { providers.restore(); restoreEnv(); }
});

// The model on the statement's receipt: the id each response named, per call,
// with its source; a read whose chunks were answered by different ids stores
// the id that answered most chunks and every chunk's id — never a joined
// string; a response that names no model is a configured fallback.
test('statement receipt: the served model per call with its source; a mixed read stores every chunk\'s model', async () => {
  onlyAnthropic();
  const providers = installRecordedProviders();
  try {
    const base64 = await buildPdfBase64(9);
    const served = ['claude-opus-5-5', 'claude-opus-5-5-variant', 'claude-opus-5-5'];
    let index = 0;
    providers.script('bank_statement_extraction', { times: 3, respond: () => message({ transactions: [], statement_summary: null }, { model: served[index++] }) });
    const mixed = await extractStructuredFromOpenAiVisionPaginated({ base64, filename: 'tiliote.pdf', pagesPerChunk: 4, concurrency: 1 });
    assert.deepEqual([mixed.model, mixed.model_source], ['claude-opus-5-5', 'response_proven']);
    assert.ok(!String(mixed.model).includes('+'), 'never a joined id');
    assert.deepEqual(mixed.chunk_models.map(({ model, model_source, page_start, page_end }) => [model, model_source, page_start, page_end]),
      [['claude-opus-5-5', 'response_proven', 1, 4], ['claude-opus-5-5-variant', 'response_proven', 5, 8], ['claude-opus-5-5', 'response_proven', 9, 9]]);

    providers.script('bank_statement_extraction', { respond: () => {
      const reply = message({ transactions: [], statement_summary: null });
      delete reply.body.model;
      return reply;
    } });
    const unnamed = await extractStructuredFromOpenAiVisionPaginated({ base64: await buildPdfBase64(2), filename: 'b.pdf', pagesPerChunk: 4, concurrency: 1 });
    assert.deepEqual([unnamed.model, unnamed.model_source, unnamed.chunk_models], ['claude-opus-5-5', 'configured_fallback', undefined],
      'a response that names no model: the requested id, receipted as a fallback');
  } finally { providers.restore(); restoreEnv(); }
});

// The source on the statement's receipt names the reader AND the provider
// that answered: `anthropic_vision_structured` when Claude read it (an OpenAI
// read keeps `openai_vision_structured`, bankStatementLlmFirst.test.js).
test('the statement\'s extraction_source names the provider that answered', async () => {
  const { extractBankStatementFromBase64, statementSourceKind } = await import('./bankStatement.js');
  const { readFileSync } = await import('node:fs');
  const scanned = readFileSync(new URL('../../data/evals/fixtures/fi-kultalanka-2025-02/sources/01 OP Tiliote 02-2025.pdf', import.meta.url)).toString('base64');
  onlyAnthropic();
  const providers = installRecordedProviders();
  try {
    providers.script('bank_statement_extraction', [message({ transactions: [row('2025-02-03', 'Kahvila Synteetti', 'out', 12.4, 8124.59)], statement_summary: null })]);
    const read = await extractBankStatementFromBase64({ base64: scanned, filename: 'tiliote.pdf', mimeType: 'application/pdf', bypassCache: true });
    assert.deepEqual([read.extraction_source, read.extraction_provider, read.extraction_model, read.extraction_model_source],
      ['anthropic_vision_structured', 'anthropic', 'claude-opus-5-5', 'response_proven']);
    assert.equal(statementSourceKind(read.extraction_source), 'vision_structured');
    assert.equal(statementSourceKind('openai_vision_structured'), 'vision_structured', 'the stored OpenAI spelling reads as the same reader');
  } finally { providers.restore(); restoreEnv(); }
});
