// The self-hosted, unqualified seat against a LOCAL STUB SERVER that speaks
// the OpenAI-compatible chat/completions protocol (2026-11-10, modelLanes.js
// SELF_HOSTED_DECISION). No real local server (llama.cpp, Ollama, vLLM) and no
// real model runs here: this proves the plumbing — routing, the typed
// failures, the receipts, and that nothing else leaves the machine — not the
// quality of any local model, which stays unmeasured.
//
// Every request any lane makes goes through a guarded global fetch: a request
// to any host other than the stub is REFUSED and recorded, so "no other model
// is called" is checked on the wire, not asserted from the code.
//
// The stub answers on purpose with the awkward cases: a cut-off reply
// (finish_reason length), prose instead of JSON, JSON that breaks the lane's
// schema, a served model id other than the seat's, HTTP 500, and a hang past
// the deadline. Synthetic data only.

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

process.env.PROVIDER_REQUEST_TIMEOUT_MS = '400';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const SEAT_MODEL = 'local-test-model-q4';

// ── the stub ───────────────────────────────────────────────────────────────
const stub = { mode: 'ok', content: '{}', requests: [] };
const hung = new Set();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    stub.requests.push({ url: req.url, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: SEAT_MODEL, object: 'model' }] }));
      return;
    }
    if (stub.mode === 'http500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub: internal error' } }));
      return;
    }
    if (stub.mode === 'hang') { hung.add(res); return; }
    const choice = { index: 0, message: { role: 'assistant', content: stub.content }, finish_reason: 'stop' };
    if (stub.mode === 'length') { choice.message.content = stub.content.slice(0, Math.max(1, Math.floor(stub.content.length / 2))); choice.finish_reason = 'length'; }
    if (stub.mode === 'prose') choice.message.content = 'I think this is probably office rent, but I am not sure.';
    if (stub.mode === 'schema') choice.message.content = JSON.stringify({ unexpected: true });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-stub', object: 'chat.completion',
      model: stub.mode === 'mismatch' ? 'some-other-model' : SEAT_MODEL,
      choices: [choice],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const STUB_HOST = `127.0.0.1:${server.address().port}`;
process.env.OPENAI_COMPATIBLE_BASE_URL = `http://${STUB_HOST}/v1`;

// ── the network guard ─────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const wire = { allowed: [], refused: [] };
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host !== STUB_HOST) {
    wire.refused.push(url.href);
    throw new Error(`network refused in test: ${url.href}`);
  }
  wire.allowed.push(url.href);
  return realFetch(input, init);
};

const { resolveSeatTransport } = await import('./providerEndpoints.js');
const { SELF_HOSTED_BASIS } = await import('./modelLanes.js');
const { suggestTransactionCoding, suggestTransactionCodingBatch } = await import('./transactionLlm.js');
const { proposeBankLineDisposition } = await import('./bankLineDispositionLlm.js');
const { proposeMatchesViaAnthropic } = await import('./reconciliationLlmCore.js');
const { draftClientAskMessage } = await import('./askPipeline.js');
const { nativeBirthDefinition } = await import('./nativeChartLineage.js');
const { nativeAccountChoices } = await import('./codingAccountChoices.js');
const { resolveCodingPolicy } = await import('./codingPolicy.js');

const SEAT = { deciding_model: SEAT_MODEL, basis: SELF_HOSTED_BASIS };
const transport = resolveSeatTransport({ policy: SEAT });

test.after(() => {
  for (const res of hung) { try { res.destroy(); } catch { /* closing */ } }
  globalThis.fetch = realFetch;
  server.close();
});

const BAD_ANSWERS = ['length', 'prose', 'schema', 'mismatch', 'http500', 'hang'];

test('the seat resolves to the stub over loopback with no key and no Authorization header', () => {
  assert.equal(transport.provider, 'openai_compatible');
  assert.equal(transport.model, SEAT_MODEL);
  assert.equal(transport.policy_basis, SELF_HOSTED_BASIS);
  assert.equal(transport.endpoint.url, `http://${STUB_HOST}/v1/chat/completions`);
  assert.equal(transport.endpoint.headers.authorization, undefined);
});

// ── transaction_coding ────────────────────────────────────────────────────
const definition = nativeBirthDefinition('sg_pte_native.v1');
const chartContext = { contract_id: definition.contract_id, client_life: { firm_id: 'test-firm', client_id: 'test-client', created_at: '2026-09-01', after_delete_id: '0' },
  receipt_id: '1', receipt_digest: 'birth-receipt', selection_digest: definition.selection_digest,
  menu_contract_version: definition.menu_contract_version, birth_registration_digest: 'birth-registration',
  registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } };
const codingProfile = { jurisdiction: 'sg', entityType: 'sg-pte', accountingSystem: 'none',
  codingPolicy: resolveCodingPolicy({ jurisdiction: 'sg', entityType: 'sg-pte', accountingSystem: 'none', nativeChart: chartContext }) };
const menu = nativeAccountChoices(chartContext);
const handleFor = (code) => menu.choices.find((row) => row.code === code).handle;
const codingAnswer = (code) => ({ proposed_account: handleFor(code), posting_requirement: 'single_account', document_allocations: [],
  tax_treatment: 'No GST', confidence: 'high', evidence_required: false, reasoning: 'Rent for the month, per the line.', alternatives: [],
  contact: 'Example Landlord Pte', processor_fee_tax_treatment: '', source_business_use_resolution: '', source_identity_resolution: '',
  historical_rate_basis: '', support_note: '', ask_client_question: '', remember_candidate: false, merchant_pattern: '',
  missing_account_name: '', missing_account_type: '', missing_account_reason: '', auto_explain_limit: 0, materiality: 'normal', warnings: [] });
// No merchant domain in the line, so the coder's merchant-website fetch does not fire.
const codingLine = { id: 'txn-synthetic-1', date: '2026-09-01', description: 'Office rent September', money_out: 500, currency: 'SGD' };

test('coding: a seated company is decided by the stub; the receipt names the served model and the unqualified basis', async () => {
  stub.mode = 'ok'; stub.content = JSON.stringify(codingAnswer('7000'));
  const before = stub.requests.length;
  const result = await suggestTransactionCoding({ clientProfile: codingProfile, transaction: codingLine, transport });
  assert.equal(result.provider_failure, undefined);
  assert.equal(result.account_code, '7000');
  assert.equal(result.model, SEAT_MODEL, 'the model id on the receipt is the one the response named');
  assert.equal(result.model_source, 'response');
  assert.equal(result.policy_basis, SELF_HOSTED_BASIS);
  assert.equal(stub.requests.length, before + 1, 'exactly one call: no second model, no shadow');
  const sent = stub.requests.at(-1).body;
  assert.equal(sent.model, SEAT_MODEL);
  assert.match(sent.messages[0].content, /valid against this JSON Schema/, 'the lane schema travels in the instructions');
});

test('coding batch: the same seam decides a batch', async () => {
  stub.mode = 'ok';
  stub.content = JSON.stringify({ suggestions: [{ transaction_id: codingLine.id, ...codingAnswer('3100') }], group_summary: [] });
  const result = await suggestTransactionCodingBatch({ clientProfile: codingProfile, transactions: [codingLine], transport });
  assert.equal(result.provider_failure, undefined);
  assert.equal(result.suggestions[0].account_code, '3100');
});

const EXPECTED_CODING_FAILURE = {
  length: 'PROVIDER_OUTPUT_LIMIT',
  prose: 'PROVIDER_INVALID_OUTPUT',
  schema: 'PROVIDER_INVALID_OUTPUT'
};

for (const mode of BAD_ANSWERS) {
  test(`coding: "${mode}" is a typed failure, nothing is suggested under the seat, no other model is called`, async () => {
    stub.mode = mode; stub.content = JSON.stringify(codingAnswer('7000'));
    const before = stub.requests.length;
    if (mode === 'mismatch') {
      await assert.rejects(
        suggestTransactionCoding({ clientProfile: codingProfile, transaction: codingLine, transport }),
        (error) => error.code === 'POLICY_MODEL_MISMATCH' && error.served === 'some-other-model'
      );
    } else {
      const result = await suggestTransactionCoding({ clientProfile: codingProfile, transaction: codingLine, transport });
      assert.ok(result.provider_failure, 'a provider_failure, which the writer persists as no verdict');
      if (EXPECTED_CODING_FAILURE[mode]) assert.equal(result.provider_failure.code, EXPECTED_CODING_FAILURE[mode]);
      if (mode === 'schema') assert.match(result.provider_failure.message, /broke its schema/);
      if (mode === 'http500') assert.equal(result.provider_failure.status, 500);
      if (mode === 'hang') assert.match(String(result.provider_failure.reason || result.provider_failure.code), /timeout|deadline/i);
    }
    assert.equal(stub.requests.length, before + 1, 'one attempt at the seat, nothing else');
  });
}

// ── bank_line_disposition ─────────────────────────────────────────────────
const bankLine = { id: 'bt-synthetic-1', date: '2026-09-02', description: 'PALVELUMAKSU ESIMERKKIPANKKI', money_out: 4.5, currency: 'EUR' };
const firmContext = { clientIdentity: { jurisdiction: 'FI', companyName: 'Esimerkki Oy' } };

test('disposition: a seated company is decided by the stub; the model id is the response\'s', async () => {
  stub.mode = 'ok';
  stub.content = JSON.stringify({ disposition: 'needs_human', materiality: 'immaterial', expense_kind: 'bank_fee', confidence: 0.6, reasoning: 'A bank fee.', line_identified: false });
  const result = await proposeBankLineDisposition({ transaction: bankLine, firmContext, direction: 'out', transport });
  assert.equal(result.transport_failure, undefined);
  assert.equal(result.disposition, 'needs_human');
  assert.equal(result.model, SEAT_MODEL);
  assert.equal(result.model_source, 'response');
});

for (const mode of BAD_ANSWERS) {
  test(`disposition: "${mode}" never becomes an automatic verdict, and no other model is called`, async () => {
    stub.mode = mode;
    stub.content = JSON.stringify({ disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'bank_fee', confidence: 0.9, reasoning: 'A bank fee.', line_identified: true });
    const before = stub.requests.length;
    const result = await proposeBankLineDisposition({ transaction: bankLine, firmContext, direction: 'out', transport });
    assert.equal(result.disposition, 'needs_human', 'it falls toward a person, never an auto_explain');
    if (['length', 'http500', 'hang'].includes(mode)) {
      assert.equal(result.transport_failure, true, 'transport-class: the sweep stamps nothing and retries');
    }
    if (mode === 'length') assert.equal(result.provider_failure_code, 'PROVIDER_OUTPUT_LIMIT');
    if (mode === 'mismatch') assert.deepEqual(result.model_mismatch, { requested: SEAT_MODEL, served: 'some-other-model' }, 'the no-stamp marker the sweep aborts on');
    assert.equal(stub.requests.length, before + 1);
  });
}

// ── reconciliation_reasoning (the core every match family rides) ──────────
const reconTransport = { ...transport, execution: { root: { type: 'reconciliation_reasoning', id: 'doc-synthetic-1' } } };

test('matching: a seated company is decided by the stub; the model id is the response\'s', async () => {
  stub.mode = 'ok'; stub.content = JSON.stringify({ proposals: [], unmatchable_reason: 'no_candidate_fits' });
  const result = await proposeMatchesViaAnthropic({ systemPrompt: 'Match the document.', userPrompt: 'Document and candidates.', candidateBankLines: [], transport: reconTransport });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.model, SEAT_MODEL);
  assert.equal(result.model_source, 'response_proven');
});

const EXPECTED_MATCH_FAILURE = { length: 'PROVIDER_OUTPUT_LIMIT', prose: 'PROVIDER_INVALID_OUTPUT', mismatch: 'POLICY_MODEL_MISMATCH' };
for (const mode of BAD_ANSWERS) {
  test(`matching: "${mode}" ${mode === 'schema' ? 'proposes nothing (the parser is this lane\'s contract)' : 'throws typed — no verdict persists'}; no other model is called`, async () => {
    stub.mode = mode; stub.content = JSON.stringify({ proposals: [], unmatchable_reason: 'no_candidate_fits' });
    const before = stub.requests.length;
    const call = proposeMatchesViaAnthropic({ systemPrompt: 'Match the document.', userPrompt: 'Document and candidates.', candidateBankLines: [], transport: reconTransport });
    if (mode === 'schema') {
      const result = await call;
      assert.deepEqual(result.proposals, [], 'an off-contract object yields no proposal: nothing can match or settle');
    } else {
      await assert.rejects(call, (error) => {
        if (EXPECTED_MATCH_FAILURE[mode]) return error.code === EXPECTED_MATCH_FAILURE[mode];
        return error.providerFailure === true;
      });
    }
    assert.equal(stub.requests.length, before + 1);
  });
}

// ── ask_drafting ──────────────────────────────────────────────────────────
const askItem = { id: 'txn-synthetic-2', date: '2026-03-20', description: 'KORTTIOSTO ESIMERKKIKAUPPA', money_out: 19.9, ai_suggestion: { ask_client_question: 'What was this purchase for?' } };
const askDraft = { subject: 'Kysymys', message_markdown: 'Hei! Mihin tämä osto liittyi?', summary: 'internal',
  items: [{ transaction_ref: 'transaction_1', disposition: 'ask', question: 'Mihin tämä osto liittyi?', evidence_type: 'business_purpose', skip_reason: '', fyi_note: '', local_document_refs: [] }],
  statement_requests: [], document_asks: [] };

test('ask drafting: a seated company has its question drafted by the stub; the receipt names the model and basis', async () => {
  stub.mode = 'ok'; stub.content = JSON.stringify(askDraft);
  const result = await draftClientAskMessage({ clientProfile: { companyName: 'Esimerkki Oy', jurisdiction: 'FI' }, codingItems: [askItem], transport });
  assert.equal(result.model, SEAT_MODEL);
  assert.equal(result.policy_basis, SELF_HOSTED_BASIS);
  assert.equal(result.draft.items.length, 1);
});

for (const mode of BAD_ANSWERS) {
  test(`ask drafting: "${mode}" is ASK_PIPELINE_LLM_UNAVAILABLE with the typed cause; no draft, no other model`, async () => {
    stub.mode = mode; stub.content = JSON.stringify(askDraft);
    const before = stub.requests.length;
    await assert.rejects(
      draftClientAskMessage({ clientProfile: { companyName: 'Esimerkki Oy', jurisdiction: 'FI' }, codingItems: [askItem], transport }),
      (error) => {
        assert.equal(error.code, 'ASK_PIPELINE_LLM_UNAVAILABLE');
        const expected = { length: 'PROVIDER_OUTPUT_LIMIT', prose: 'PROVIDER_INVALID_OUTPUT', schema: 'PROVIDER_INVALID_OUTPUT', mismatch: 'POLICY_MODEL_MISMATCH' }[mode];
        if (expected) assert.equal(error.provider_failure.code, expected);
        else assert.ok(error.provider_failure?.code);
        return true;
      }
    );
    assert.equal(stub.requests.length, before + 1);
  });
}

// ── the wire ──────────────────────────────────────────────────────────────
test('the wire: every request went to the configured endpoint and nowhere else', () => {
  assert.deepEqual(wire.refused, [], `requests to other hosts: ${wire.refused.join(', ')}`);
  assert.ok(wire.allowed.length > 0);
  for (const href of wire.allowed) assert.equal(new URL(href).host, STUB_HOST);
  for (const request of stub.requests) assert.equal(request.auth, null, 'no key was sent to a loopback server');
});
