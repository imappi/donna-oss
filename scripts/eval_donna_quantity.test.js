import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { physicalHash } from '../server/donna/inventory/physicalReconciliation.js';
import { telemetryFromParts } from '../server/donna/llmCall.js';
import { evaluateRecordedQuantities, loadQuantityCorpus } from './eval_donna_quantity.js';

const record = (fixture, { kind = 'exact', value = 3, limitations = [], confidence = .99 } = {}) => ({
  id: fixture.id, inputDigest: physicalHash(fixture.input), recordedAt: '2026-10-07T00:00:00Z', costReceipt: null,
  envelope: { result: { candidateItemId: 'candidate_1', alternativeItemIds: [], baseUom: 'EA',
    quantity: { kind, value: kind === 'exact' ? value : null, lower: kind === 'range' ? 1 : null, upper: kind === 'range' ? 10 : null },
    evidenceRefs: fixture.input.evidence.map((e, i) => `evidence_${i + 1}`), limitations, ambiguity: limitations.length ? 'Deterministic contract condition' : '', confidence },
  telemetry: telemetryFromParts({ provider: 'synthetic_contract', payload: { model: 'synthetic-contract-stub', id: fixture.id,
    usage: { input_tokens: 0, output_tokens: 0 } }, execution: { root: { type: 'offline_quantity_contract', id: fixture.id } },
    promptVersion: fixture.input.protocolVersion, latencyMs: 0, status: 200 }) } });
const batch = cases => ({ version: 'donna-quantity-recordings.v1', recordingKind: 'synthetic_contract', cases });

test('offline corpus holds labels separately and default report has eight not-run cases, zero inference', async () => {
  const corpus = loadQuantityCorpus();
  assert.equal(corpus.fixtures.length, 8);
  assert.equal(corpus.fixtures.filter(f => f.split === 'holdout').length, 7);
  assert.deepEqual(new Set(corpus.fixtures.map(f => f.condition)), new Set(['clear_count', 'occlusion', 'variant_ambiguity',
    'bundle_ambiguity', 'duplicate_views', 'unreadable_label', 'insufficient_evidence', 'incomplete_coverage']));
  const report = await evaluateRecordedQuantities({ corpus });
  assert.equal(report.totals.missing, 8); assert.equal(report.totals.exactAccuracy, null);
  assert.equal(report.modelBenchmark.status, 'not_run'); assert.equal(report.calibration.status, 'not_run');
  assert.equal(report.cost.evaluationProviderCalls, 0); assert.equal(report.cost.recordedProviderSpendUsd, null);
  assert.deepEqual(await evaluateRecordedQuantities({ corpus }), report);
  await assert.rejects(evaluateRecordedQuantities({ corpus, recordings: batch(null) }), /recordings envelope/);
  const emptyProvider = await evaluateRecordedQuantities({ corpus, recordings: { ...batch([]), recordingKind: 'recorded_provider' } });
  assert.ok(emptyProvider.modelBenchmark.reasons.includes('actual_model_recordings_absent'));
});

test('recorded scoring exposes confident wrong counts, safe abstention and duplicate-frame overcount', async () => {
  const corpus = loadQuantityCorpus(); const [clear, occluded, , , duplicate] = corpus.fixtures;
  const report = await evaluateRecordedQuantities({ corpus, recordings: batch([
    record(clear), record(occluded, { value: 12, limitations: ['occlusion'] }),
    record(duplicate, { value: 8, limitations: ['duplicate_views'] }),
    record(corpus.fixtures[5], { kind: 'unknown', limitations: ['unreadable_label'], confidence: null })
  ]) });
  assert.equal(report.totals.falseSupported, 2); assert.equal(report.totals.abstentionRate, .25);
  assert.equal(report.totals.failureCategories.unsupported_exact_count, 1);
  assert.equal(report.totals.failureCategories.wrong_quantity, 1);
  assert.equal(report.splits.holdout.n, 7); assert.equal(report.splits.holdout.missing, 4);
  assert.equal(report.totals.confidenceDiagnostics.n, 3);
  assert.ok(report.totals.confidenceDiagnostics.brier > .6);
  assert.equal(report.modelBenchmark.status, 'not_run'); assert.equal(report.cost.recordedProviderSpendUsd, null);
});

test('range reports width/coverage without earning exact accuracy; required limitations remain visible', async () => {
  const corpus = loadQuantityCorpus();
  const report = await evaluateRecordedQuantities({ corpus, recordings: batch([
    record(corpus.fixtures[0], { kind: 'range', limitations: ['occlusion'] }),
    record(corpus.fixtures[1], { kind: 'unknown', limitations: ['insufficient_evidence'] })
  ]) });
  assert.equal(report.cases[0].score.rangeCoverage, true); assert.equal(report.cases[0].score.rangeWidth, 9);
  assert.equal(report.totals.exactAccuracy, null); assert.equal(report.totals.failureCategories.limitation_omitted, 1);
});

test('stale recordings, out-of-scope evidence and absent response provenance are errors in the denominator', async () => {
  const corpus = loadQuantityCorpus(); const records = corpus.fixtures.slice(0, 3).map(f => record(f));
  records[0].inputDigest = 'old'; records[1].envelope.result.evidenceRefs = ['another-scene'];
  records[2].envelope.telemetry.model_source = 'request';
  const report = await evaluateRecordedQuantities({ corpus, recordings: batch(records) });
  assert.equal(report.totals.n, 8); assert.equal(report.totals.invalid, 3); assert.equal(report.totals.missing, 5);
  assert.equal(report.totals.failureCategories.contract_or_provenance_invalid, 3);
  await assert.rejects(evaluateRecordedQuantities({ corpus, recordings: batch([records[0], records[0]]) }), /recording identity/);
});

test('real offline CLI works from another directory without keys, media fetch or database', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./eval_donna_quantity.js', import.meta.url))], {
    cwd: '/tmp', env: { PATH: process.env.PATH }, encoding: 'utf8' });
  const report = JSON.parse(output); assert.equal(report.scoringStatus, 'not_run'); assert.equal(report.totals.n, 8);
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./eval_donna_quantity.js', import.meta.url)), '--live'],
    { env: { PATH: process.env.PATH }, stdio: 'pipe' }), /Command failed/);
});


test('interrupted recordings remain unknown in all-case denominators without claiming provider failure or zero spend', async () => {
  const { makeLocalCorpus } = await import('./testSupport/donnaQuantityCorpus.js');
  const { LOCAL_RECORDINGS_VERSION } = await import('./record_donna_quantity.js');
  const fixture = makeLocalCorpus();
  try {
    const corpus = loadQuantityCorpus(fixture.manifestPath, fixture);
    const input = corpus.fixtures[0];
    const recordings = { version: LOCAL_RECORDINGS_VERSION, recordingKind: 'recorded_provider', manifestDigest: corpus.manifestDigest,
      run: { id: 'interrupted-fixture', requestedModel: 'fixture-only', maxCalls: 1, deadlineMs: 1000, maxAttempts: 1 }, cases: [],
      failures: [{ id: input.id, inputDigest: physicalHash(input.input), recordedAt: '2026-10-08T00:00:00Z', costReceipt: null,
        failure: { category: 'transport', code: 'RECORDING_OUTCOME_UNKNOWN', status: null, retryable: false, owner: 'operator' }, telemetry: null }] };
    const report = await evaluateRecordedQuantities({ corpus, recordings });
    assert.equal(report.totals.n, 3); assert.equal(report.totals.missing, 2);
    assert.equal(report.totals.outcomeUnknown, 1); assert.equal(report.totals.providerFailed, 0);
    assert.equal(report.totals.evaluated, 0); assert.equal(report.totals.evaluationCoverage, 0);
    assert.equal(report.totals.allCasePassRate, 0); assert.equal(report.totals.abstentionRate, null);
    assert.equal(report.cases[0].status, 'outcome_unknown'); assert.equal(report.cases[0].actual, undefined);
    assert.equal(report.scoringStatus, 'recording_outcomes_unavailable');
    assert.equal(report.cost.recordedProviderSpendUsd, null); assert.equal(report.cost.evaluationProviderCalls, 0);
    assert.equal(report.splits.development.outcomeUnknown, 1); assert.equal(report.splits.holdout.missing, 2);
    recordings.failures[0].costReceipt = { amount: 0, currency: 'USD', source: 'invented' };
    await assert.rejects(evaluateRecordedQuantities({ corpus, recordings }), /recording identity/);
  } finally { fixture.cleanup(); }
});
