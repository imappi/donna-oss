#!/usr/bin/env node
// Offline-only experiment orchestration. Live use requires an exact frozen plan.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runEval } from '../server/donna/evalHarness.js';
import { digest, ENDPOINT } from './jev_semantic_support_probe.js';
import { VERSION, THRESHOLD, MAX_CALLS, buildPlan, validateAnswer, scoreJob } from './jev_comparison_protocol.js';

export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ratio = (n, d) => d ? n / d : null;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : null; };
const runnerHash = () => digest(readFileSync(fileURLToPath(import.meta.url)));
const save = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.pending`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.pending`, path);
};

export async function callProvider(job, { typesafeKey, anthropicKey, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const typesafe = job.provider === 'typesafe';
  const key = typesafe ? typesafeKey : anthropicKey;
  if (!key?.trim()) throw new Error('missing_provider_credential');
  if (!job.request.model?.trim()) throw new Error('missing_provider_model');
  if (JSON.stringify(job.request).length > 80000) throw new Error('request_size_limit');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(typesafe ? ENDPOINT : ANTHROPIC_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: typesafe
          ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
          : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify(job.request)
      });
    } catch { throw new Error(controller.signal.aborted ? 'provider_timeout' : 'provider_transport_error'); }
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    let raw;
    try { raw = await response.json(); }
    catch { throw new Error(controller.signal.aborted ? 'provider_timeout' : 'provider_invalid_json'); }
    if (controller.signal.aborted) throw new Error('provider_timeout');
    try { return { raw, response: validateAnswer(raw, job) }; }
    catch (error) { error.rejectedResponse = raw; throw error; }
  } finally { clearTimeout(timer); }
}

export function summarize(plan, cases) {
  const groups = {};
  for (const job of plan.jobs) {
    // Keep synthetic mutations/controls distinct from saved extraction outcomes.
    const cohort = job.track === 'triage' ? 'structured_facts' : job.origin === 'controlled_mutation' ? 'mutations' : job.origin === 'synthetic_text_control' ? 'null_controls' : 'saved_extractions';
    const key = `${job.track}/${job.split}/${cohort}/${job.arm}`;
    (groups[key] ||= []).push({ job, result: cases.find(c => c.id === job.id) });
  }
  const metrics = {};
  for (const [key, rows] of Object.entries(groups)) {
    const fields = rows.flatMap(r => r.result?.score?.fields || []);
    const labeled = rows.reduce((n, r) => n + Object.keys(r.job.expected).length, 0);
    const completed = rows.filter(r => r.result?.actual?.response);
    const base = {
      cases: rows.length, completed: completed.length, labeled, evaluated: fields.length, missing: labeled - fields.length,
      correct: fields.filter(f => f.correct).length, accuracy_including_missing: ratio(fields.filter(f => f.correct).length, labeled),
      latency_median_ms: median(completed.map(r => r.result.actual.latency_ms)),
      input_tokens: completed.reduce((n, r) => n + r.result.actual.response.usage.input_tokens, 0),
      output_tokens: completed.reduce((n, r) => n + r.result.actual.response.usage.output_tokens, 0)
    };
    if (rows[0].job.track === 'verifier') {
      const clean = rows.filter(r => Object.values(r.job.expected).every(Boolean));
      const bad = rows.filter(r => Object.values(r.job.expected).some(v => !v));
      metrics[key] = { ...base,
        uncertain: fields.filter(f => f.verdict === 'uncertain').length,
        false_support: fields.filter(f => !f.expected_supported && f.verdict === 'supported').length,
        false_rejection: fields.filter(f => f.expected_supported && f.verdict === 'unsupported').length,
        bad_fields: rows.reduce((n, r) => n + Object.values(r.job.expected).filter(v => !v).length, 0),
        strict_bad_fields_detected: fields.filter(f => !f.expected_supported && f.verdict === 'unsupported').length,
        clean_labeled_cases: clean.length,
        clean_cases_evaluated: clean.filter(r => r.result?.score).length,
        clean_cases_challenged: clean.filter(r => r.result?.score?.fields.some(f => f.challenged)).length,
        bad_cases: bad.length,
        bad_cases_challenged: bad.filter(r => r.result?.score?.fields.some(f => !f.expected_supported && f.challenged)).length
      };
    } else metrics[key] = { ...base,
      dangerous_matches: fields.filter(f => f.dangerous_match).length,
      raw_wrong_matches: fields.filter(f => f.raw_verdict === 'match' && !f.allowed.includes('match')).length,
      review: fields.filter(f => f.verdict === 'review').length,
      unnecessary_review: fields.filter(f => f.verdict === 'review' && !f.allowed.includes('review')).length,
      unpinned_positive_bands: fields.filter(f => f.confidence_band_unpinned).length,
      correct_decisive_candidates: fields.filter(f => f.correct && f.verdict !== 'review').length,
      correct_cases_without_fallback: completed.filter(r => r.result.score.fields.every(f => f.correct && f.verdict !== 'review')).length,
      cases_requiring_fallback: completed.filter(r => r.result.score.fields.some(f => f.verdict === 'review')).length
    };
  }
  // Counterfactual cascades use the actual measured paired calls, never zero-cost
  // missing responses. This estimates serialized inference latency, not UI speed.
  const cascades = {};
  for (const split of ['development', 'evaluation']) {
    const jevJobs = plan.jobs.filter(j => j.track === 'triage' && j.arm === 'jev_choice' && j.split === split);
    if (!jevJobs.length) continue;
    const pairs = jevJobs.map(job => ({
      job, jev: cases.find(c => c.id === job.id),
      strong: cases.find(c => c.id === `triage/${job.group}/strong_equal_evidence`),
      current: cases.find(c => c.id === `triage/${job.group}/strong_current_prompt`)
    }));
    const valid = pairs.filter(p => p.jev?.actual?.response && p.strong?.actual?.response && p.current?.actual?.response);
    const allComplete = valid.length === pairs.length;
    const observations = valid.map(p => {
      const fallback = p.jev.score.fields.some(f => f.verdict === 'review');
      const final = fallback ? p.strong.score.fields : p.jev.score.fields;
      return { group: p.job.group, fallback, jev_ms: p.jev.actual.latency_ms, strong_ms: p.strong.actual.latency_ms,
        current_ms: p.current.actual.latency_ms, cascade_ms: p.jev.actual.latency_ms + (fallback ? p.strong.actual.latency_ms : 0),
        final_correct: final.every(f => f.correct), final_dangerous_matches: final.filter(f => f.dangerous_match).length,
        final_review: final.filter(f => f.verdict === 'review').length,
        new_errors_vs_strong: final.filter((f, i) => !f.correct && p.strong.score.fields[i].correct).length,
        errors_corrected_vs_strong: final.filter((f, i) => f.correct && !p.strong.score.fields[i].correct).length };
    });
    const sum = key => observations.reduce((n, o) => n + o[key], 0);
    cascades[split] = {
      measurement: 'counterfactual_serial_inference_from_paired_calls_not_deployed_latency',
      cases: pairs.length, paired_complete: observations.length, completion: allComplete ? 'complete' : 'incomplete',
      fallback_cases: observations.filter(o => o.fallback).length,
      final_correct_cases: observations.filter(o => o.final_correct).length,
      final_dangerous_matches: sum('final_dangerous_matches'), final_review: sum('final_review'),
      new_errors_vs_strong: sum('new_errors_vs_strong'), errors_corrected_vs_strong: sum('errors_corrected_vs_strong'),
      raw_speedup_equal_evidence: allComplete ? ratio(sum('strong_ms'), sum('jev_ms')) : null,
      cascade_speedup_equal_evidence: allComplete ? ratio(sum('strong_ms'), sum('cascade_ms')) : null,
      current_prompt_total_ms: allComplete ? sum('current_ms') : null,
      strong_equal_evidence_total_ms: allComplete ? sum('strong_ms') : null,
      cascade_total_ms: allComplete ? sum('cascade_ms') : null,
      observations
    };
  }
  return { metrics, cascades };
}

export function continuationVerdicts({ metrics, cascades }) {
  const schema = metrics['verifier/evaluation/saved_extractions/schema_v2'];
  const prop = metrics['verifier/evaluation/saved_extractions/proposition'];
  let verifier = { status: 'not_selected' };
  if (schema || prop) {
    if (!schema || !prop || schema.cases !== 14 || prop.cases !== 14 || schema.missing || prop.missing) verifier = { status: 'incomplete' };
    else {
      const schemaRate = ratio(schema.clean_cases_challenged, schema.clean_labeled_cases);
      const propRate = ratio(prop.clean_cases_challenged, prop.clean_labeled_cases);
      const checks = {
        no_decisive_false_support: prop.false_support === 0,
        bad_case_detection_retained: prop.bad_cases_challenged >= schema.bad_cases_challenged,
        clean_challenge_rate_at_least_halved: schemaRate > 0 && propRate <= schemaRate / 2
      };
      verifier = { status: Object.values(checks).every(Boolean) ? 'continue_experiment' : 'criteria_not_met', checks, schema_clean_challenge_rate: schemaRate, proposition_clean_challenge_rate: propRate };
    }
  }
  const jev = metrics['triage/evaluation/structured_facts/jev_choice'];
  const cascade = cascades.evaluation;
  let triage = { status: 'not_selected' };
  if (jev || cascade) {
    if (!jev || !cascade || jev.cases !== 10 || jev.missing || cascade.completion !== 'complete' || cascade.cases !== 10 || cascade.cascade_speedup_equal_evidence === null) triage = { status: 'incomplete' };
    else {
      const checks = {
        no_incorrect_confident_matches: jev.dangerous_matches === 0,
        half_cases_correct_without_fallback: jev.correct_cases_without_fallback >= jev.cases / 2,
        no_new_cascade_errors: cascade.new_errors_vs_strong === 0,
        cascade_at_least_twice_as_fast: cascade.cascade_speedup_equal_evidence >= 2
      };
      triage = { status: Object.values(checks).every(Boolean) ? 'continue_experiment' : 'criteria_not_met', checks };
    }
  }
  return { verifier, triage, meaning: 'Frozen small-corpus continuation criteria only; never production qualification or authority.' };
}

export async function runComparison(plan, { mode, frozenPlan, replay, typesafeKey, anthropicKey, fetchImpl, onCheckpoint = () => {}, ranAt } = {}) {
  if (!['live', 'replay'].includes(mode) || plan.version !== VERSION || plan.jobs.length > MAX_CALLS || !plan.jobs.length) throw new Error('invalid_run');
  if (mode === 'live') {
    if (!frozenPlan || digest(frozenPlan) !== digest(plan)) throw new Error('frozen_plan_mismatch');
    if (plan.jobs.some(j => !j.request.model?.trim())) throw new Error('missing_provider_model');
    if (plan.jobs.some(j => j.provider === 'typesafe') && !typesafeKey?.trim()) throw new Error('missing_typesafe_credential');
    if (plan.jobs.some(j => j.provider === 'anthropic') && !anthropicKey?.trim()) throw new Error('missing_anthropic_credential');
  }
  const records = mode === 'replay' ? replay?.records : [];
  if (mode === 'replay' && (replay?.version !== VERSION || replay.plan_sha256 !== plan.plan_sha256 || replay.runner_sha256 !== runnerHash() || !Array.isArray(records) || new Set(records.map(r => r.id)).size !== records.length || records.some(r => !plan.jobs.some(j => j.id === r.id)))) throw new Error('invalid_replay');
  let stopped = false;
  let calls = 0;
  const receipts = [];
  const rejected = [];
  const checkpoint = async () => {
    try { await onCheckpoint({ version: VERSION, mode, completion: 'incomplete', plan_sha256: plan.plan_sha256, runner_sha256: runnerHash(), records: receipts, rejected_responses: rejected }); }
    catch { stopped = true; throw new Error('receipt_checkpoint_failed'); }
  };
  const result = await runEval({ suite: VERSION, mode, fixtures: plan.jobs, ranAt,
    scorer: (job, actual) => scoreJob(job, actual.response),
    runner: async job => {
      if (stopped) throw new Error('not_attempted_after_provider_error');
      let receipt;
      if (mode === 'replay') {
        receipt = records.find(r => r.id === job.id);
        if (!receipt || receipt.request_sha256 !== job.request_sha256 || !Number.isFinite(receipt.latency_ms) || receipt.latency_ms < 0) throw new Error('replay_record_mismatch');
        validateAnswer(receipt.raw, job);
      } else {
        const started = performance.now();
        try {
          calls++;
          const { raw } = await callProvider(job, { typesafeKey, anthropicKey, fetchImpl });
          receipt = { id: job.id, request_sha256: job.request_sha256, raw, latency_ms: Math.round(performance.now() - started) };
        } catch (error) {
          stopped = true;
          if (error.rejectedResponse) {
            rejected.push({ id: job.id, request_sha256: job.request_sha256, raw: error.rejectedResponse, latency_ms: Math.round(performance.now() - started), error: error.message });
            await checkpoint();
          }
          throw error;
        }
      }
      receipts.push(receipt);
      await checkpoint();
      return { response: validateAnswer(receipt.raw, job), latency_ms: receipt.latency_ms };
    }
  });
  const summary = summarize(plan, result.cases);
  return {
    version: VERSION, ...result, completion: result.totals.errored ? 'incomplete' : 'complete',
    plan_sha256: plan.plan_sha256, runner_sha256: runnerHash(), provider_calls: calls,
    threshold: THRESHOLD, records: receipts, rejected_responses: rejected, ...summary, continuation: continuationVerdicts(summary),
    limits: ['Synthetic, correlated corpus; evaluation split is reserved for this wording version, not a pristine unseen benchmark.',
      'Triage assumes structured facts are correct; no original-document verification, candidate-discovery test or posting authority.',
      'Current-prompt arm preserves the production prompt/builder, with fixture inputs and no runtime side effects; it is not full production replay.',
      'Confidence is not calibrated. Latency is observed locally; cascade latency is counterfactual. No dollar-cost or 20x claim is assumed.']
  };
}

export function parseComparisonArgs(argv, env = process.env) {
  const args = { mode: 'dry-run', track: 'all', split: 'all', freeze: null, replay: null, output: null,
    jevModel: env.TYPESAFE_MODEL || env.TYPESAFE_DEFAULT_MODEL || null };
  const seen = new Set();
  for (const token of argv) {
    const m = /^--(mode|track|split|freeze|replay|output|jev-model)=(.+)$/.exec(token);
    if (!m || seen.has(m[1])) throw new Error('invalid_argument');
    seen.add(m[1]); args[m[1] === 'jev-model' ? 'jevModel' : m[1]] = m[2];
  }
  if (!['dry-run', 'live', 'replay'].includes(args.mode) || !['all', 'verifier', 'triage'].includes(args.track) || !['all', 'development', 'evaluation'].includes(args.split)) throw new Error('invalid_selection');
  if (args.mode === 'live' && (!args.freeze || !args.output)) throw new Error('live_requires_freeze_and_output');
  if ((args.mode === 'replay') !== Boolean(args.replay)) throw new Error('replay_mode_mismatch');
  if (args.mode === 'replay' && args.freeze) throw new Error('replay_freeze_not_allowed');
  if (args.output && [args.freeze, args.replay].filter(Boolean).some(p => resolve(p) === resolve(args.output))) throw new Error('input_output_collision');
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseComparisonArgs(argv);
  const plan = await buildPlan({ jevModel: args.jevModel, track: args.track, split: args.split });
  let report;
  if (args.mode === 'dry-run') {
    if (args.freeze) save(resolve(args.freeze), plan);
    report = { ...plan, mode: 'dry-run', completion: 'not_run', provider_calls: 0 };
  } else report = await runComparison(plan, {
    mode: args.mode,
    frozenPlan: args.freeze ? JSON.parse(readFileSync(resolve(args.freeze), 'utf8')) : null,
    replay: args.replay ? JSON.parse(readFileSync(resolve(args.replay), 'utf8')) : null,
    typesafeKey: process.env.TYPESAFE_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY,
    onCheckpoint: value => { if (args.output) save(resolve(args.output), value); }
  });
  if (args.output) save(resolve(args.output), report);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify({ mode: args.mode, completion: report.completion, selected_calls: plan.jobs.length, provider_calls: report.provider_calls }));
  return report.completion === 'incomplete' ? 2 : report.totals?.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('Comparison refused or incomplete: check selection, frozen plan, replay, model and local provider credentials. No raw provider error is printed.');
    process.exitCode = 2;
  });
}
