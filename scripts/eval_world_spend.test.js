import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { formatHuman, parseArgs, readSpend, writeReportExclusive } from './eval_world_spend.js';

test('parses repeatable receipt paths and defaults to the evidence directory', () => {
  assert.deepEqual(parseArgs([]), { receipts: ['data/worlds/receipts/'], output: null, print: false });
  assert.deepEqual(parseArgs(['--receipts=a', '--receipts=b', '--output=out.json', '--print']), {
    receipts: ['a', 'b'], output: 'out.json', print: true,
  });
  assert.throws(() => parseArgs(['--receipts=']), /requires a value/);
  assert.throws(() => parseArgs(['--wat']), /unknown argument/);
});

test('counts captured whole-close usage and labels legacy receipts unknown rather than zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-spend-'));
  try {
    writeFileSync(join(dir, 'captured.json'), JSON.stringify({
      suite: 'world-close', cases: [],
      spend: { solveCalls: 2, providerUsage: [{ input_tokens: 10, output_tokens: 4 }, { input_tokens: 6, output_tokens: 2 }] },
      provenance: { resolvedModelId: 'provider/model-b' }, traceReceipts: [{ modelId: 'provider/model-a' }],
    }));
    writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ suite: 'world-close', cases: [], provenance: { resolvedModelId: 'provider/model-a' } }));
    writeFileSync(join(dir, 'broken.json'), '{ no');
    writeFileSync(join(dir, 'ignored.txt'), 'not json');

    const report = readSpend([dir]);
    assert.equal(report.receipts.length, 2);
    assert.equal(report.errors.length, 1);
    assert.deepEqual(report.totals.modelIds, ['provider/model-a', 'provider/model-b']);
    assert.equal(report.totals.solveCalls, 2);
    assert.equal(report.totals.unknownSolveCallReceipts, 1);
    assert.deepEqual(report.totals.tokens, { input_tokens: 16, output_tokens: 6 });
    assert.equal(report.totals.tokenCount, 22);
    assert.equal(report.totals.unknownUsageReceipts, 1);
    assert.equal(report.totals.families.whole_close.receiptCount, 2);
    assert.equal(report.totals.families.whole_close.unknownUsageReceipts, 1);
    assert.match(formatHuman(report), /22 tokens counted \+ 1 receipts unknown/);
    assert.match(formatHuman(report), /UNKNOWN-NOT-ZERO/);
    assert.match(formatHuman(report), /MALFORMED JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accepts individual files without mutating them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-spend-file-'));
  const file = join(dir, 'receipt.json');
  try {
    const source = JSON.stringify({ spend: { solveCalls: 1, providerUsage: [{ total_tokens: 9 }] }, evaluationErrors: [], initialRun: {} });
    writeFileSync(file, source);
    assert.equal(readSpend([file]).totals.tokenCount, 9);
    assert.equal(readFileSync(file, 'utf8'), source);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sums all receipt families and reports unknown usage per family', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-spend-families-'));
  try {
    writeFileSync(join(dir, 'close.json'), JSON.stringify({
      suite: 'world-close', cases: [], spend: { solveCalls: 1, providerUsage: [{ input_tokens: 4, output_tokens: 2 }] },
      provenance: { resolvedModelId: 'model/close' },
    }));
    writeFileSync(join(dir, 'shrink.json'), JSON.stringify({
      ok: true, initialRun: { traceReceipts: [{ modelId: 'model/shrink' }] }, shrink: null,
      evaluationErrors: [{ outcome: 'evaluation_error' }],
      spend: { solveCalls: 3, providerUsage: [{ total_tokens: 10 }] },
    }));
    writeFileSync(join(dir, 'sibling.json'), JSON.stringify({
      status: 'pass', sourceWorldId: 'world/source', siblingWorldId: 'world/sibling',
      derivation: { version: 'v1', errors: [] },
      run: { traceReceipts: [{ modelId: 'model/sibling' }], spend: { solveCalls: 2, providerUsage: [] } },
    }));

    const report = readSpend([dir]);
    assert.equal(report.totals.receiptCount, 3);
    assert.equal(report.totals.solveCalls, 6);
    assert.equal(report.totals.tokenCount, 16);
    assert.deepEqual(report.totals.modelIds, ['model/close', 'model/shrink', 'model/sibling']);
    assert.equal(report.totals.unknownUsageReceipts, 1);
    assert.equal(report.totals.families.whole_close.unknownUsageReceipts, 0);
    assert.equal(report.totals.families.shrink.unknownUsageReceipts, 0);
    assert.equal(report.totals.families.shrink.evaluationErrorCount, 1);
    assert.equal(report.totals.families.sibling.unknownUsageReceipts, 1);
    assert.match(formatHuman(report), /sibling\.json\tsibling\tmodel\/sibling/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('counts and reports an unrecognized receipt as unknown_shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-spend-unknown-'));
  try {
    writeFileSync(join(dir, 'unknown.json'), JSON.stringify({ modelId: 'model/unknown' }));
    const report = readSpend([dir]);
    assert.equal(report.receipts.length, 1);
    assert.equal(report.receipts[0].family, 'unknown');
    assert.equal(report.totals.families.unknown.receiptCount, 1);
    assert.equal(report.totals.families.unknown.unknownUsageReceipts, 1);
    assert.deepEqual(report.errors[0].code, 'unknown_shape');
    assert.match(formatHuman(report), /unknown_shape/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accounts for current EAW receipt families and reports every missing spend field as incomplete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-spend-current-'));
  const digest = 'a'.repeat(64);
  const usage = {
    version: 'eaw.model-usage.v1',
    status: 'measured',
    calls: [{
      provider: 'anthropic', response_id: 'msg-1', model_id: 'provider/model-current',
      input_tokens: 12, output_tokens: 3, wall_time_ms: 17,
      request_digest: digest, http_status: 200, retry_index: 0,
      retry_disposition: 'initial_attempt', cache_disposition: 'provider_live', outcome: 'provider_response',
    }],
    incomplete_fields: [],
    cash: { status: 'unknown', reason: 'versioned_provider_price_source_not_recorded' },
    configuration_digest: digest,
    artifact_digests: [digest],
  };
  const completeUsage = {
    ...usage,
    calls: [
      usage.calls[0],
      {
        ...usage.calls[0], response_id: 'msg-2', retry_index: 1,
        retry_disposition: 'retry', wall_time_ms: 19,
      },
    ],
    cash: {
      status: 'calculated', usd: 0.0003,
      price_source: { version: 'test-prices-v1', currency: 'USD', unit: 'per_million_tokens', sha256: digest },
    },
  };
  try {
    writeFileSync(join(dir, 'whole.json'), JSON.stringify({
      suite: 'world-close', cases: [{ actual: { modelUsage: usage } }],
    }));
    writeFileSync(join(dir, 'shrink.json'), JSON.stringify({
      initialRun: {}, evaluationErrors: [], spend: { solveCalls: 1, providerUsage: [usage] },
    }));
    writeFileSync(join(dir, 'sibling.json'), JSON.stringify({
      sourceWorldId: 'source', siblingWorldId: 'sibling', derivation: {}, run: { modelUsage: completeUsage },
    }));
    writeFileSync(join(dir, 'db-current.json'), JSON.stringify({
      version: 'eaw.db-close-run.v2', receipts: [],
      spend: {
        status: 'known_zero_model', solveCalls: 0, inputTokens: 0, outputTokens: 0,
        modelSpendUsd: 0, wallTimeMs: 25, providerResponses: [], modelIds: [],
        pricingSource: { status: 'not_applicable' }, configurationDigest: digest, artifactDigests: [digest],
      },
    }));
    writeFileSync(join(dir, 'db-legacy.json'), JSON.stringify({ version: 'eaw.db-close-run.v1', receipts: [] }));
    writeFileSync(join(dir, 'db-case.json'), JSON.stringify({
      provenance: {}, receipt: { version: 'eaw.db-close-receipt.v2', status: 'passed' },
    }));

    const report = readSpend([dir]);
    assert.equal(report.version, 'world-spend.v3');
    assert.equal(report.errors.length, 0, 'all current and historical EAW shapes must be recognized');
    assert.deepEqual(Object.keys(report.totals.families).sort(), ['db_close_receipt', 'db_close_run', 'shrink', 'sibling', 'whole_close']);
    assert.equal(report.totals.providerCallCount, 4);
    assert.equal(report.totals.retryCount, 1);
    assert.equal(report.totals.tokenCount, 60);
    assert.equal(report.totals.cashUsd, 0.0003);
    assert.equal(report.totals.completeReceiptCount, 2);
    assert.equal(report.totals.families.db_close_run.incompleteReceiptCount, 1, 'historical DB close is never inferred to have zero spend');
    const current = report.receipts.find(({ file }) => file.endsWith('db-current.json'));
    assert.equal(current.completenessStatus, 'COMPLETE');
    assert.equal(current.cashUsd, 0);
    assert.equal(current.wallTimeMs, 25);
    const whole = report.receipts.find(({ file }) => file.endsWith('whole.json'));
    assert.equal(whole.completenessStatus, 'INCOMPLETE');
    assert.deepEqual(whole.missingFields, ['cash_usd', 'price_source']);
    const legacy = report.receipts.find(({ file }) => file.endsWith('db-legacy.json'));
    assert.equal(legacy.usageStatus, 'UNKNOWN-NOT-ZERO');
    assert.ok(legacy.missingFields.includes('provider_calls'));
    assert.match(formatHuman(report), /2 COMPLETE \+ 4 INCOMPLETE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recognizes a complete Gate 2B C1 provider receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-spend-c1-'));
  const digest = 'b'.repeat(64);
  try {
    const file = join(dir, 'c1.json');
    writeFileSync(file, JSON.stringify({
      version: 'eaw.gate2b.c1-run.v1',
      status: 'PASS',
      spend: {
        status: 'counted',
        solveCalls: 1,
        calls: [{
          provider: 'anthropic', response_id: 'msg-c1', model_id: 'provider/model-current',
          input_tokens: 120, output_tokens: 30, wall_time_ms: 21,
          request_digest: digest, http_status: 200, retry_index: 0,
          retry_disposition: 'initial_attempt', cache_disposition: 'provider_live', outcome: 'provider_response',
        }],
        cash: { usd: 0.0006, price_source: { id: 'provider-prices-2026-08-30' } },
        configurationDigest: digest,
        artifactDigests: [digest],
      },
    }));
    const report = readSpend([file]);
    assert.equal(report.errors.length, 0);
    assert.equal(report.receipts[0].family, 'c1_run');
    assert.equal(report.receipts[0].completenessStatus, 'COMPLETE');
    assert.equal(report.receipts[0].usageStatus, 'counted');
    assert.equal(report.receipts[0].cashUsd, 0.0006);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('JSON output is exclusive and refuses to clobber evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaw-spend-output-'));
  const output = join(dir, 'report.json');
  try {
    writeReportExclusive(output, { totals: { tokenCount: 3 } });
    assert.throws(() => writeReportExclusive(output, { totals: { tokenCount: 4 } }), { code: 'EEXIST' });
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).totals.tokenCount, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
