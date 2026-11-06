#!/usr/bin/env node
// Offline recorded-proposal scoring over the existing eval harness. Never calls a provider.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFixtures, runEval } from '../server/donna/evalHarness.js';
import { physicalHash } from '../server/donna/inventory/physicalReconciliation.js';
import { quantityProposalFromEnvelope, validateBlindQuantityInput,
  QUANTITY_LIMITATIONS } from '../server/donna/inventory/quantityProposal.js';
import { LOCAL_CORPUS_VERSION, loadLocalQuantityCorpus, loadLocalQuantityLabels, readExternalJson, requireExternalPath } from './donna_quantity_corpus.js';
import { LOCAL_RECORDINGS_VERSION, recordingTelemetry } from './record_donna_quantity.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MANIFEST = resolve(ROOT, 'data/evals/donna-quantity/manifest.json');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const ratio = (n, d) => d ? n / d : null;
const invalid = (detail) => { throw new Error(`Invalid quantity corpus: ${detail}`); };
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(k => names.includes(k)) && names.every(k => Object.hasOwn(value, k));

export const loadQuantityCorpus = (manifestPath = DEFAULT_MANIFEST, labels = {}) => {
  const manifest = resolve(manifestPath) === DEFAULT_MANIFEST ? json(manifestPath) : readExternalJson(manifestPath);
  if (manifest.version === LOCAL_CORPUS_VERSION) {
    return loadLocalQuantityLabels(loadLocalQuantityCorpus(manifestPath), labels);
  }
  if (!fields(manifest, ['version', 'fixtureBasis', 'imageryStatus', 'fixturesDirectory', 'groundTruthFile', 'cases'])
    || manifest.version !== 'donna-quantity-corpus.v1' || manifest.fixtureBasis !== 'deterministic_contract'
    || manifest.imageryStatus !== 'not_collected' || !Array.isArray(manifest.cases)
    || !manifest.cases.length || manifest.cases.length > 100) invalid('manifest version, basis or bounds');
  const root = dirname(manifestPath);
  const inputs = loadFixtures('donna-quantity-blind', { root: resolve(root, manifest.fixturesDirectory) });
  const gold = json(resolve(root, manifest.groundTruthFile));
  const ids = manifest.cases.map(c => c.id);
  if (new Set(ids).size !== ids.length || inputs.length !== ids.length
    || Object.keys(gold).length !== ids.length) invalid('duplicate, missing or extra cases/labels');
  const fixtures = manifest.cases.map(c => {
    if (!fields(c, ['id', 'split', 'condition']) || !['development', 'holdout'].includes(c.split)
      || !['clear_count', ...QUANTITY_LIMITATIONS].includes(c.condition)) invalid('case metadata');
    const f = inputs.find(f => f.id === c.id);
    if (!f || Object.keys(f).some(k => !['id', 'input', '__file'].includes(k))) invalid(`blind input ${c.id}`);
    validateBlindQuantityInput(f.input);
    const expected = gold[c.id];
    if (!fields(expected, ['candidateItemId', 'baseUom', 'quantity', 'mustAbstain', 'labelBasis'])
      || expected.labelBasis !== 'independent_deterministic_scene_spec'
      || typeof expected.mustAbstain !== 'boolean'
      || (expected.mustAbstain ? expected.quantity !== null : typeof expected.quantity !== 'number'
        || !Number.isFinite(expected.quantity) || expected.quantity < 0 || expected.quantity > 1e12)
      || !f.input.candidates.some(x => x.itemId === expected.candidateItemId && x.baseUom === expected.baseUom)) invalid(`ground truth ${c.id}`);
    return { ...c, input: f.input, expected };
  });
  if (!fixtures.some(f => f.split === 'holdout')) invalid('holdout required');
  return { manifest, manifestDigest: physicalHash({ manifest, inputs, gold }), fixtures };
};

// A range is an abstention from a precise count. Interval coverage/width is
// reported separately; a very broad range never earns exact-count accuracy.
export const scoreQuantityFixture = (fixture, proposal) => {
  const expected = fixture.expected;
  const q = proposal.quantity;
  const exact = q.kind === 'exact';
  const identityCorrect = proposal.candidateItemId === expected.candidateItemId && proposal.baseUom === expected.baseUom;
  const correct = exact && identityCorrect && !expected.mustAbstain && q.value === expected.quantity;
  const falseSupport = exact && !correct;
  const abstained = !exact;
  const requiredLimitation = fixture.condition === 'clear_count' || proposal.limitations.includes(fixture.condition);
  const pass = (expected.mustAbstain ? abstained : correct) && requiredLimitation;
  return { status: pass ? 'pass' : 'fail', truePositive: pass ? 1 : 0, falsePositive: falseSupport ? 1 : 0,
    falseNegative: pass ? 0 : 1, expectedSize: 1, actualSize: exact ? 1 : 0,
    identityCorrect, exactCorrect: correct, falseSupport, abstained, requiredLimitation,
    failureCategories: [falseSupport ? (expected.mustAbstain ? 'unsupported_exact_count'
      : identityCorrect ? 'wrong_quantity' : 'wrong_identity_or_uom') : null,
    !requiredLimitation ? 'limitation_omitted' : null,
    !expected.mustAbstain && abstained ? 'unnecessary_abstention' : null].filter(Boolean),
    absoluteError: exact && identityCorrect && !expected.mustAbstain ? Math.abs(q.value - expected.quantity) : null,
    rangeCoverage: q.kind === 'range' && identityCorrect && !expected.mustAbstain
      ? q.lower <= expected.quantity && expected.quantity <= q.upper : null,
    rangeWidth: q.kind === 'range' ? q.upper - q.lower : null,
    confidence: exact ? proposal.confidence : null };
};

const summarize = (cases, local = false) => {
  const evaluated = cases.filter(c => ['pass', 'fail'].includes(c.status));
  const exact = evaluated.filter(c => !c.score.abstained);
  const confidence = exact.filter(c => c.score.confidence !== null);
  const failureCategories = {};
  for (const c of cases) for (const reason of c.score?.failureCategories || (c.status === 'error' ? ['contract_or_provenance_invalid'] : ['provider_failed', 'outcome_unknown'].includes(c.status) ? [c.failure.code] : [])) {
    failureCategories[reason] = (failureCategories[reason] || 0) + 1;
  }
  const bins = [[0, .5], [.5, .8], [.8, 1]].map(([lower, upper], i) => {
    const values = confidence.filter(c => c.score.confidence >= lower && (i === 2 ? c.score.confidence <= upper : c.score.confidence < upper));
    return { lower, upper, n: values.length, meanConfidence: ratio(values.reduce((n, c) => n + c.score.confidence, 0), values.length),
      exactAccuracy: ratio(values.filter(c => c.score.exactCorrect).length, values.length) };
  });
  return { ...(local ? { providerFailed: cases.filter(c => c.status === 'provider_failed').length,
    outcomeUnknown: cases.filter(c => c.status === 'outcome_unknown').length,
    evaluationCoverage: ratio(evaluated.length, cases.length),
    allCasePassRate: ratio(evaluated.filter(c => c.status === 'pass').length, cases.length),
    allCaseExactCorrectRate: ratio(exact.filter(c => c.score.exactCorrect).length, cases.length) } : {}), n: cases.length, evaluated: evaluated.length, missing: cases.filter(c => c.status === 'not_run').length,
    invalid: cases.filter(c => c.status === 'error').length,
    exactProposals: exact.length, exactCorrect: exact.filter(c => c.score.exactCorrect).length,
    falseSupported: exact.filter(c => c.score.falseSupport).length,
    falseSupportRate: ratio(exact.filter(c => c.score.falseSupport).length, exact.length),
    abstentionRate: ratio(evaluated.filter(c => c.score.abstained).length, evaluated.length),
    exactAccuracy: ratio(exact.filter(c => c.score.exactCorrect).length, exact.length),
    failureCategories, confidenceDiagnostics: { n: confidence.length, bins,
      brier: ratio(confidence.reduce((n, c) => n + (c.score.confidence - Number(c.score.exactCorrect)) ** 2, 0), confidence.length) } };
};

export const evaluateRecordedQuantities = async ({ corpus = loadQuantityCorpus(), recordings = null,
  ranAt = '2026-10-07T00:00:00.000Z' } = {}) => {
  const local = corpus.manifest.version === LOCAL_CORPUS_VERSION;
  const records = recordings ? recordings.cases : [];
  const failures = local && recordings ? recordings.failures : [];
  if (recordings && (!fields(recordings, local
    ? ['version', 'recordingKind', 'manifestDigest', 'run', 'cases', 'failures'] : ['version', 'recordingKind', 'cases'])
    || recordings.version !== (local ? LOCAL_RECORDINGS_VERSION : 'donna-quantity-recordings.v1')
    || !(local ? ['recorded_provider'] : ['recorded_provider', 'synthetic_contract']).includes(recordings.recordingKind)
    || !Array.isArray(records) || records.length > 100 || !Array.isArray(failures) || failures.length > 100
    || (local && recordings.manifestDigest !== corpus.manifestDigest))) invalid('recordings envelope');
  if (new Set([...records, ...failures].map(r => r?.id)).size !== records.length + failures.length
    || records.some(r => !fields(r, local
      ? ['id', 'inputDigest', 'recordedAt', 'envelope', 'costReceipt', 'proposalDigest']
      : ['id', 'inputDigest', 'recordedAt', 'envelope', 'costReceipt'])
      || !corpus.fixtures.some(f => f.id === r.id))
    || failures.some(r => !fields(r, ['id', 'inputDigest', 'recordedAt', 'costReceipt', 'failure', 'telemetry'])
      || !corpus.fixtures.some(f => f.id === r.id)
      || !fields(r.failure, ['category', 'code', 'status', 'retryable', 'owner'])
      || !['transport', 'invalid_output'].includes(r.failure.category)
      || !['PROVIDER_KEY_MISSING', 'PROVIDER_UNAUTHORIZED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE',
        'PROVIDER_REJECTED_REQUEST', 'PROVIDER_TIMEOUT', 'PROVIDER_NETWORK', 'PROVIDER_INVALID_OUTPUT',
        'PROVIDER_SPEND_LIMIT', 'RECORDING_FAILED', 'RECORDING_OUTCOME_UNKNOWN'].includes(r.failure.code)
      || (r.failure.code === 'RECORDING_OUTCOME_UNKNOWN' && (r.telemetry !== null || r.costReceipt !== null
        || r.failure.category !== 'transport' || r.failure.status !== null || r.failure.retryable !== false || r.failure.owner !== 'operator'))
      || typeof r.failure.retryable !== 'boolean' || !['operator', 'queue'].includes(r.failure.owner)
      || (r.failure.status !== null && (!Number.isInteger(r.failure.status) || r.failure.status < 100 || r.failure.status > 599)))) invalid('recording identity');
  if (local && recordings && (!fields(recordings.run, ['id', 'requestedModel', 'maxCalls', 'deadlineMs', 'maxAttempts'])
    || typeof recordings.run.id !== 'string' || typeof recordings.run.requestedModel !== 'string'
    || !Number.isSafeInteger(recordings.run.maxCalls) || recordings.run.maxCalls < records.length + failures.length
    || recordings.run.maxCalls > 10 || recordings.run.maxAttempts !== 1
    || !Number.isSafeInteger(recordings.run.deadlineMs) || recordings.run.deadlineMs < 1000
    || recordings.run.deadlineMs > 120000)) invalid('recording run bounds');
  const selected = corpus.fixtures.filter(f => records.some(r => r.id === f.id));
  const evaluation = await runEval({ suite: 'donna-quantity', mode: recordings?.recordingKind || 'not_run',
    ranAt, fixtures: selected, scorer: scoreQuantityFixture, runner: async fixture => {
      const r = records.find(r => r.id === fixture.id);
      if (r.inputDigest !== physicalHash(fixture.input)) throw new Error('Recording blind input digest mismatch');
      try {
        const proposal = quantityProposalFromEnvelope({ input: fixture.input,
          envelope: local ? { result: r.envelope?.result, telemetry: recordingTelemetry(r.envelope?.telemetry) } : r.envelope,
          recordingKind: recordings.recordingKind, recordedAt: r.recordedAt });
        if (local && proposal.proposalDigest !== r.proposalDigest) throw new Error('Recording proposal digest mismatch');
        return proposal;
      } catch (error) { if (local) throw new Error('Recording contract or provenance invalid'); throw error; }
    } });
  const cases = corpus.fixtures.map(f => {
    const failure = failures.find(r => r.id === f.id);
    const failed = failure ? failure.inputDigest === physicalHash(f.input) && Number.isFinite(Date.parse(failure.recordedAt))
      ? { id: f.id, status: failure.failure.code === 'RECORDING_OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'provider_failed', failure: failure.failure, telemetry: recordingTelemetry(failure.telemetry) }
      : { id: f.id, status: 'error', reason: 'failure_receipt_invalid' } : null;
    return { ...(evaluation.cases.find(c => c.id === f.id) || failed
      || { id: f.id, status: 'not_run', reason: 'recorded_proposal_absent' }), split: f.split, condition: f.condition };
  });
  const provider = recordings?.recordingKind === 'recorded_provider';
  // Existing telemetry is preserved on each valid proposal. Costs are receipts,
  // not inferred from today's prices or from null usage coerced to zero.
  const costReceipts = [...records, ...failures].map(r => ({ id: r.id, receipt: r.costReceipt }));
  for (const { receipt } of costReceipts) if (receipt !== null && (!fields(receipt, ['amount', 'currency', 'source'])
    || typeof receipt.amount !== 'number' || !Number.isFinite(receipt.amount) || receipt.amount < 0
    || receipt.currency !== 'USD' || typeof receipt.source !== 'string' || !receipt.source.trim())) invalid('cost receipt');
  return { version: local ? 'donna-quantity-real-local-report.v1' : 'donna-quantity-report.v1', ranAt, manifestDigest: corpus.manifestDigest,
    ...(local ? { labelsDigest: corpus.labelsDigest, admission: 'local_evaluation_only' } : {}),
    fixtureBasis: corpus.manifest.fixtureBasis, imageryStatus: corpus.manifest.imageryStatus,
    recordingKind: recordings?.recordingKind ?? null,
    modelBenchmark: local ? { status: cases.some(c => ['pass', 'fail'].includes(c.status))
      ? cases.every(c => ['pass', 'fail'].includes(c.status)) ? 'evaluated_local_corpus' : 'partially_evaluated_local_corpus' : 'not_run',
      reasons: ['local_admission_is_not_production_custody', 'label_truth_and_representativeness_not_qualified'] } : { status: 'not_run', reasons: ['representative_consented_imagery_absent',
      ...(provider && cases.some(c => c.actual?.provenance?.recordingKind === 'recorded_provider')
        ? [] : ['actual_model_recordings_absent'])] },
    calibration: { status: 'not_run', reason: 'representative_model_outcomes_absent' },
    scoringStatus: records.length ? 'recorded_proposals_scored' : cases.some(c => c.status === 'outcome_unknown')
      ? 'recording_outcomes_unavailable' : failures.length ? 'provider_failures_only' : 'not_run',
    totals: summarize(cases, local), splits: Object.fromEntries(['development', 'holdout'].map(split => [split, summarize(cases.filter(c => c.split === split), local)])),
    conditions: Object.fromEntries([...new Set(cases.map(c => c.condition))].map(condition => [condition, summarize(cases.filter(c => c.condition === condition), local)])),
    cost: { evaluationProviderCalls: 0, evaluationSpendUsd: 0,
      recordedProviderSpendUsd: provider && costReceipts.length && costReceipts.every(c => c.receipt)
        ? costReceipts.reduce((n, c) => n + c.receipt.amount, 0) : null,
      status: provider && costReceipts.length && costReceipts.every(c => c.receipt) ? 'receipted' : 'not_run_or_unknown', receipts: costReceipts },
    cases };
};

export const main = async (argv) => {
  const args = {};
  for (const token of argv) {
    const match = token.match(/^--(manifest|recordings|output|ran-at|labels|holdout-labels)=(.+)$/);
    if (!match) throw new Error(`Unknown argument: ${token}`);
    if (Object.hasOwn(args, match[1])) throw new Error('Duplicate argument');
    args[match[1]] = match[2];
  }
  const corpus = loadQuantityCorpus(args.manifest ? resolve(args.manifest) : DEFAULT_MANIFEST,
    { developmentLabels: args.labels, holdoutLabels: args['holdout-labels'] });
  const local = corpus.manifest.version === LOCAL_CORPUS_VERSION;
  if (local && (!args.output || !args.output.startsWith('/'))) throw new Error('Real local evaluation requires an absolute private output path');
  const report = await evaluateRecordedQuantities({ corpus,
    recordings: args.recordings ? local ? readExternalJson(args.recordings) : json(resolve(args.recordings)) : null,
    ranAt: args['ran-at'] });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const destination = local ? requireExternalPath(resolve(realpathSync(dirname(args.output)), args.output.slice(dirname(args.output).length + 1))) : resolve(args.output);
    writeFileSync(destination, output, { flag: 'wx', mode: 0o600 });
  }
  else process.stdout.write(output);
  return report;
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Quantity evaluation refused or failed; no raw details logged.'); process.exitCode = 1; });
}
