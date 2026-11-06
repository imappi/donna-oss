import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLocalQuantities } from './record_donna_quantity.js';
import { evaluateRecordedQuantities, loadQuantityCorpus } from './eval_donna_quantity.js';
import { makeLocalCorpus, recordingOptions, providerResponse } from './testSupport/donnaQuantityCorpus.js';

const CLI = fileURLToPath(new URL('./record_donna_quantity.js', import.meta.url));
const EVAL_CLI = fileURLToPath(new URL('./eval_donna_quantity.js', import.meta.url));

test('recorder defaults to a zero-network plan and never reads labels, keys or creates an output', async () => {
  const f = makeLocalCorpus(); let calls = 0;
  try {
    writeFileSync(f.developmentLabels, 'SECRET_LABEL'); writeFileSync(f.holdoutLabels, 'SECRET_LABEL');
    const options = { ...recordingOptions(f), executeProvider: false, apiKey: null, fetchImpl: () => { calls++; throw new Error('paid call'); } };
    for (const executeProvider of [undefined, false, 'false', 'true', 1, {}]) {
      const plan = await recordLocalQuantities({ ...options, executeProvider });
      assert.equal(plan.status, 'dry_run'); assert.equal(plan.providerCalls, 0); assert.equal(calls, 0);
      assert.equal(existsSync(options.output), false);
    }
    const output = execFileSync(process.execPath, [CLI, `--manifest=${f.manifestPath}`, '--cases=case-001'], {
      cwd: '/tmp', env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(JSON.parse(output).providerCalls, 0);
    assert.throws(() => execFileSync(process.execPath, [CLI, `--manifest=${f.manifestPath}`, '--cases=case-001', '--live'], { stdio: 'pipe' }));
  } finally { f.cleanup(); }
});

test('bounded execution requires exact model, selection, calls, deadline, local run and private exclusive output before calling', async () => {
  for (const patch of [{ model: null }, { maxCalls: 0 }, { maxCalls: 11 }, { deadlineMs: 0 }, { deadlineMs: 120001 },
    { maxAttempts: 2 }, { output: null }, { output: 'relative.json' }, { runId: null }, { caseIds: [] },
    { caseIds: ['case-001', 'case-001'] }, { caseIds: ['missing'] }, { apiKey: '' }]) {
    const f = makeLocalCorpus(); let calls = 0;
    try {
      await assert.rejects(recordLocalQuantities({ ...recordingOptions(f), ...patch, fetchImpl: () => { calls++; } }));
      assert.equal(calls, 0); assert.equal(existsSync(join(f.root, 'recordings.json')), false);
    } finally { f.cleanup(); }
  }
  const f = makeLocalCorpus(); let calls = 0;
  try {
    const options = { ...recordingOptions(f), fetchImpl: () => { calls++; } };
    writeFileSync(options.output, 'EXISTING_PRIVATE_CONTENT');
    await assert.rejects(recordLocalQuantities(options), /EEXIST/);
    assert.equal(readFileSync(options.output, 'utf8'), 'EXISTING_PRIVATE_CONTENT'); assert.equal(calls, 0);
    symlinkSync(options.output, join(f.root, 'alias.json'));
    await assert.rejects(recordLocalQuantities({ ...options, output: join(f.root, 'alias.json') }), /EEXIST/);
    assert.equal(calls, 0);
  } finally { f.cleanup(); }
});

test('real llmCall/default-fetch wiring sends only bytes and call-local context, preserves served model/usage and canonical replay', async () => {
  const f = makeLocalCorpus(); const originalFetch = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'requested-model-fixture'); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 1500);
      assert.equal(body.text.format.strict, true);
      const context = JSON.stringify(body);
      for (const secret of ['PRIVATE_SOURCE_REF', 'PRIVATE_AUTHORIZATION_REF', 'private-name', 'private-group', 'opaque-item', 'opaque-evidence', 'offline-local', 'SYNTHETIC_LABEL', 'expectedQuantity', 'valuation', 'heldout']) assert.ok(!context.includes(secret), secret);
      assert.ok(context.includes('candidate_1')); assert.ok(context.includes('source_group_1'));
      const images = body.input[0].content.filter(p => p.type === 'input_image');
      assert.equal(images.length, 1);
      assert.deepEqual(Buffer.from(images[0].image_url.split(',')[1], 'base64'), readFileSync(join(f.root, 'private-name-0.png')));
      return providerResponse();
    };
    const records = await recordLocalQuantities(recordingOptions(f));
    assert.equal(calls, 1); assert.equal(records.cases.length, 1); assert.equal(records.failures.length, 0);
    const receipt = records.cases[0];
    assert.equal(receipt.envelope.telemetry.model, 'response-model-fixture'); assert.equal(receipt.envelope.telemetry.model_source, 'response');
    assert.equal(receipt.envelope.telemetry.provider_attempt_id, 'resp_mock'); assert.equal(receipt.envelope.telemetry.attempt_count, 1);
    assert.deepEqual(receipt.envelope.telemetry.usage, { provider: 'openai', input_tokens: 23, output_tokens: 12, total_tokens: 35 });
    assert.ok(!JSON.stringify(records).includes('PRIVATE_PROVIDER_BLOB')); assert.equal(receipt.costReceipt, null);
    assert.equal(statSync(recordingOptions(f).output).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(recordingOptions(f).output)), records);
    const corpus = loadQuantityCorpus(f.manifestPath, f);
    const report = await evaluateRecordedQuantities({ corpus, recordings: records });
    assert.equal(report.totals.n, 3); assert.equal(report.totals.missing, 2); assert.equal(report.totals.allCasePassRate, 1 / 3);
    assert.equal(report.totals.evaluationCoverage, 1 / 3); assert.equal(report.cases[0].actual.humanConfirmed, false);
    assert.equal(report.cases[0].actual.provenance.model, 'response-model-fixture'); assert.equal(report.cost.recordedProviderSpendUsd, null);
    assert.deepEqual(await evaluateRecordedQuantities({ corpus, recordings: records }), report); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; f.cleanup(); }
});

test('headers and body timeouts use the existing deadline owner once and leave separate receipts without false abstention', async () => {
  for (const body of [false, true]) {
    const f = makeLocalCorpus(); let calls = 0;
    try {
      const records = await recordLocalQuantities({ ...recordingOptions(f), fetchImpl: () => {
        calls++; return body ? { ok: true, status: 200, json: () => new Promise(() => {}) } : new Promise(() => {});
      } });
      assert.equal(calls, 1); assert.equal(records.cases.length, 0); assert.equal(records.failures.length, 1);
      assert.equal(records.failures[0].failure.code, 'PROVIDER_TIMEOUT'); assert.equal(records.failures[0].telemetry.attempt_count, 1);
      const report = await evaluateRecordedQuantities({ corpus: loadQuantityCorpus(f.manifestPath, f), recordings: records });
      assert.equal(report.totals.providerFailed, 1); assert.equal(report.totals.missing, 2); assert.equal(report.totals.abstentionRate, null);
      assert.equal(report.totals.allCasePassRate, 0); assert.equal(report.splits.development.n, 1);
      assert.equal(report.cases[0].actual, undefined); assert.equal(report.cost.recordedProviderSpendUsd, null);
    } finally { f.cleanup(); }
  }
});

test('provider refusal, errors, malformed output, missing served provenance and redirects cannot produce proposals or leak errors', async () => {
  const scenarios = [
    [() => ({ ok: false, status: 401, json: async () => ({ error: { message: 'SECRET_PROVIDER_ERROR', code: 'SECRET_ERROR_CODE' } }) }), 'PROVIDER_UNAUTHORIZED'],
    [() => ({ ok: false, status: 429, json: async () => ({ error: { message: 'SECRET_PROVIDER_ERROR' } }) }), 'PROVIDER_RATE_LIMITED'],
    [() => { throw new TypeError('fetch failed SECRET_PROVIDER_ERROR'); }, 'PROVIDER_NETWORK'],
    [() => providerResponse(null, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'SECRET_NON_JSON' }] }] }), 'PROVIDER_INVALID_OUTPUT'],
    [() => providerResponse({ unexpected: 'SECRET_OUTPUT_FIELD' }), 'PROVIDER_INVALID_OUTPUT'],
    [() => providerResponse(null, { output: {} }), 'PROVIDER_INVALID_OUTPUT'],
    [() => providerResponse(null, { output: [null] }), 'PROVIDER_INVALID_OUTPUT'],
    [() => providerResponse(null, { output: [{ type: 'message', content: {} }] }), 'PROVIDER_INVALID_OUTPUT'],
    [() => providerResponse(null, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'SECRET_REFUSAL' }] }] }), 'PROVIDER_INVALID_OUTPUT'],
    [() => providerResponse(null, { model: null }), 'PROVIDER_INVALID_OUTPUT'],
    [() => ({ ...providerResponse(null, { id: null }), headers: new Headers() }), 'PROVIDER_INVALID_OUTPUT'],
    [() => providerResponse(null, { status: 'incomplete' }), 'PROVIDER_INVALID_OUTPUT'],
    [() => ({ ...providerResponse(), url: 'https://evil.invalid' }), 'PROVIDER_INVALID_OUTPUT'],
    [() => ({ ok: true, status: 200, json: async () => { throw new Error('SECRET_BODY_ERROR'); } }), 'PROVIDER_INVALID_OUTPUT']
  ];
  for (const [fetchImpl, code] of scenarios) {
    const f = makeLocalCorpus(); let calls = 0;
    try {
      const records = await recordLocalQuantities({ ...recordingOptions(f), fetchImpl: (...args) => { calls++; return fetchImpl(...args); } });
      assert.equal(calls, 1); assert.equal(records.cases.length, 0); assert.equal(records.failures[0].failure.code, code);
      assert.ok(!JSON.stringify(records).includes('SECRET_')); assert.equal(records.failures[0].costReceipt, null);
    } finally { f.cleanup(); }
  }
});

test('CLI recording and evaluation run from another directory with mocked provider boundary and private files', () => {
  const f = makeLocalCorpus();
  try {
    const preload = join(f.root, 'mock-provider.mjs');
    // Ordinary CLI wiring and global fetch boundary, never an alternate provider runtime.
    const payload = { status: 'completed', model: 'response-model-fixture', id: 'resp_mock',
      usage: { input_tokens: 23, output_tokens: 12 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        candidateItemId: 'candidate_1', alternativeItemIds: [], baseUom: 'EA', quantity: { kind: 'exact', value: 3, lower: null, upper: null },
        evidenceRefs: ['evidence_1'], limitations: [], ambiguity: '', confidence: null }) }] }] };
    writeFileSync(preload, `globalThis.fetch = async (url, init) => { if (url !== 'https://api.openai.com/v1/responses' || init.redirect !== 'error') throw new Error('wire'); return {ok:true,status:200,url,json:async()=>(${JSON.stringify(payload)})}; };`);
    const output = join(f.root, 'cli-recordings.json');
    const summary = JSON.parse(execFileSync(process.execPath, ['--import', preload, CLI, `--manifest=${f.manifestPath}`, '--cases=case-001',
      '--execute-provider', '--model=requested-model-fixture', '--max-calls=1', '--deadline-ms=1000', '--max-attempts=1', '--run-id=fixture-cli', `--output=${output}`],
    { cwd: '/tmp', env: { PATH: process.env.PATH, OPENAI_API_KEY: 'fixture-no-network' }, encoding: 'utf8' }));
    assert.equal(summary.completed, 1); assert.equal(summary.providerCalls, 1); assert.equal(summary.spendUsd, null);
    const reportPath = join(f.root, 'private-report.json');
    execFileSync(process.execPath, [EVAL_CLI, `--manifest=${f.manifestPath}`, `--labels=${f.developmentLabels}`, `--holdout-labels=${f.holdoutLabels}`,
      `--recordings=${output}`, `--output=${reportPath}`], { cwd: '/tmp', env: { PATH: process.env.PATH }, encoding: 'utf8' });
    const report = JSON.parse(readFileSync(reportPath));
    assert.equal(report.totals.n, 3); assert.equal(report.totals.missing, 2); assert.equal(report.version, 'donna-quantity-real-local-report.v1');
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test('all-case replay keeps missing, failed and stale cases visible by split, condition and cost', async () => {
  const f = makeLocalCorpus(4); let calls = 0;
  try {
    const records = await recordLocalQuantities({ ...recordingOptions(f), caseIds: ['case-001', 'case-002', 'case-003'], maxCalls: 3,
      fetchImpl: () => ++calls === 2 ? { ok: false, status: 503, json: async () => ({}) } : providerResponse() });
    const corpus = loadQuantityCorpus(f.manifestPath, f);
    const report = await evaluateRecordedQuantities({ corpus, recordings: records });
    assert.equal(report.totals.n, 4); assert.equal(report.totals.evaluated, 2); assert.equal(report.totals.providerFailed, 1);
    assert.equal(report.totals.missing, 1); assert.equal(report.totals.allCasePassRate, .5);
    assert.equal(report.splits.holdout.n, 3); assert.equal(report.conditions.clear_count.n, 4);
    records.cases[1].proposalDigest = 'stale';
    const stale = await evaluateRecordedQuantities({ corpus, recordings: records });
    assert.equal(stale.totals.invalid, 1); assert.equal(stale.totals.n, 4);
    records.failures[0].costReceipt = { amount: .01, currency: 'USD', source: 'fixture-only' };
    for (const c of records.cases) c.costReceipt = { amount: .02, currency: 'USD', source: 'fixture-only' };
    assert.equal((await evaluateRecordedQuantities({ corpus, recordings: records })).cost.recordedProviderSpendUsd, .05);
    records.failures[0].inputDigest = 'stale';
    assert.equal((await evaluateRecordedQuantities({ corpus, recordings: records })).totals.invalid, 2);
    records.failures.push(records.failures[0]);
    await assert.rejects(evaluateRecordedQuantities({ corpus, recordings: records }), /recording identity/);
  } finally { f.cleanup(); }
});


test('failed checkpoint replacement preserves prior completed receipt and unknown in-flight outcome', async () => {
  const f = makeLocalCorpus(), originalWrite = fs.writeSync;
  let calls = 0, failingWrites = 0;
  try {
    fs.writeSync = (fd, buffer, offset, length, position) => {
      if (calls === 2) {
        if (++failingWrites === 1) return originalWrite(fd, buffer, offset, length - 100, position);
        throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
      }
      return originalWrite(fd, buffer, offset, length, position);
    };
    syncBuiltinESMExports();
    await assert.rejects(recordLocalQuantities({ ...recordingOptions(f), caseIds: ['case-001', 'case-002'], maxCalls: 2,
      fetchImpl: async () => { calls++; return providerResponse(); } }), { code: 'ENOSPC' });
    fs.writeSync = originalWrite; syncBuiltinESMExports();
    const retained = JSON.parse(readFileSync(recordingOptions(f).output, 'utf8'));
    assert.equal(calls, 2); assert.equal(retained.cases.length, 1); assert.equal(retained.cases[0].id, 'case-001');
    assert.equal(retained.failures.length, 1); assert.equal(retained.failures[0].id, 'case-002');
    assert.equal(retained.failures[0].failure.code, 'RECORDING_OUTCOME_UNKNOWN');
    assert.equal(statSync(recordingOptions(f).output).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(f.root).some(name => name.includes('.checkpoint-')), false);
    const report = await evaluateRecordedQuantities({ corpus: loadQuantityCorpus(f.manifestPath, f), recordings: retained });
    assert.equal(report.totals.evaluated, 1); assert.equal(report.totals.outcomeUnknown, 1);
    assert.equal(report.totals.providerFailed, 0); assert.equal(report.totals.missing, 1);
    assert.equal(report.totals.n, 3); assert.equal(report.cost.recordedProviderSpendUsd, null);
  } finally { fs.writeSync = originalWrite; syncBuiltinESMExports(); f.cleanup(); }
});

test('output replacement during inference is refused without overwriting another process file', async () => {
  const f = makeLocalCorpus(), output = recordingOptions(f).output, backup = join(f.root, 'retained-pending.json');
  try {
    await assert.rejects(recordLocalQuantities({ ...recordingOptions(f), fetchImpl: async () => {
      const pending = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(pending.failures[0].failure.code, 'RECORDING_OUTCOME_UNKNOWN');
      fs.renameSync(output, backup); writeFileSync(output, 'FOREIGN_REPLACEMENT', { mode: 0o600 });
      return providerResponse();
    } }), { code: 'RECORDING_OUTPUT_REPLACED' });
    assert.equal(readFileSync(output, 'utf8'), 'FOREIGN_REPLACEMENT');
    assert.equal(JSON.parse(readFileSync(backup, 'utf8')).failures.length, 1);
  } finally { f.cleanup(); }
});

test('process termination at the provider boundary leaves a replayable unknown outcome, never not-run or abstention', async () => {
  const f = makeLocalCorpus();
  try {
    const preload = join(f.root, 'terminate-provider.mjs'), output = recordingOptions(f).output;
    writeFileSync(preload, 'globalThis.fetch = async () => { process.exit(91); };');
    const child = spawnSync(process.execPath, ['--import', preload, CLI, `--manifest=${f.manifestPath}`, '--cases=case-001',
      '--execute-provider', '--model=requested-model-fixture', '--max-calls=1', '--deadline-ms=1000',
      '--max-attempts=1', '--run-id=interrupted-fixture', `--output=${output}`],
    { cwd: '/tmp', env: { PATH: process.env.PATH, OPENAI_API_KEY: 'fixture-no-network' }, encoding: 'utf8' });
    assert.equal(child.status, 91, child.stderr);
    const retained = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(retained.cases.length, 0); assert.equal(retained.failures.length, 1);
    assert.equal(retained.failures[0].failure.retryable, false); assert.equal(retained.failures[0].telemetry, null);
    const report = await evaluateRecordedQuantities({ corpus: loadQuantityCorpus(f.manifestPath, f), recordings: retained });
    assert.equal(report.totals.outcomeUnknown, 1); assert.equal(report.totals.providerFailed, 0);
    assert.equal(report.totals.missing, 2); assert.equal(report.totals.abstentionRate, null);
    assert.equal(report.totals.allCasePassRate, 0); assert.equal(report.cost.recordedProviderSpendUsd, null);
  } finally { f.cleanup(); }
});
