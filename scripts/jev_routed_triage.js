#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runEval } from '../server/donna/evalHarness.js';
import { fetchProviderJson } from '../server/donna/providerTransport.js';
import { digest, ENDPOINT } from './jev_semantic_support_probe.js';
import { ANTHROPIC_ENDPOINT } from './jev_bounded_comparison.js';
import { VERSION, MAX_CALLS, buildRoutedPlan, codeHashes, loadCorpus, validateRoutedAnswer, decide, assess } from './jev_routed_protocol.js';

export function savePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.pending`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.pending`, path);
}
export function verifyPlan(plan) {
  const { plan_sha256, ...body } = plan;
  if (plan.version !== VERSION || digest(body) !== plan_sha256 || digest(plan.code_hashes) !== digest(codeHashes()) || plan.corpus_sha256 !== digest(loadCorpus()) || plan.jobs.length > MAX_CALLS || new Set(plan.jobs.map(j => j.id)).size !== plan.jobs.length || plan.jobs.some(j => digest(j.request) !== j.request_sha256)) throw new Error('frozen_plan_mismatch');
}

export async function solve(job, { typesafeKey, anthropicKey, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const typesafe = job.provider === 'typesafe';
  const key = typesafe ? typesafeKey : anthropicKey;
  if (!key?.trim() || !job.request.model?.trim()) throw new Error('missing_provider_credentials_or_model');
  if (JSON.stringify(job.request).length > 80000 || (!typesafe && job.request.max_tokens !== 2048)) throw new Error('request_bound_exceeded');
  let result;
  try {
    result = await fetchProviderJson({ provider: job.provider, url: typesafe ? ENDPOINT : ANTHROPIC_ENDPOINT, fetchImpl, timeoutMs,
      init: { method: 'POST', redirect: 'error', headers: typesafe ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify(job.request) }
    });
  } catch { throw new Error('provider_transport_failure'); }
  if (!result.ok) throw new Error(`provider_http_${result.status}`);
  try { validateRoutedAnswer(result.payload, job); }
  catch (e) { e.rejectedResponse = result.payload; throw e; }
  return result.payload;
}

export function summarizeRouted(plan, cases) {
  const metrics = {};
  const outcomes = [];
  const providerUsage = {};
  for (const c of cases) if (c.actual?.response) {
    const j = plan.jobs.find(j => j.id === c.id);
    const u = providerUsage[j.provider] ||= { calls: 0, input_tokens: 0, output_tokens: 0 };
    u.calls++; u.input_tokens += c.actual.response.usage.input_tokens; u.output_tokens += c.actual.response.usage.output_tokens;
  }
  for (const p of plan.cases) for (const provider of ['typesafe', 'anthropic']) for (const formulation of ['broad', 'atomic']) {
    const id = `${p.id}/${provider}/${formulation}`;
    const c = cases.find(c => c.id === id);
    const common = Boolean(p.route);
    const raw = common ? decide(p) : c?.actual?.decision;
    const fallbackCase = cases.find(c => c.id === `${p.id}/anthropic/broad`);
    const fallbackNeeded = provider === 'typesafe' && raw?.fallback;
    const complete = Boolean(raw && (!fallbackNeeded || fallbackCase?.actual?.decision));
    const final = !complete ? null : fallbackNeeded ? fallbackCase.actual.decision : raw;
    // An uncertain strong result stays visibly unresolved; it is not an owner ask.
    const score = final ? assess(p, final) : null;
    const latency = complete ? common ? 0 : c.actual.latency_ms + (fallbackNeeded ? fallbackCase.actual.latency_ms : 0) : null;
    outcomes.push({ id, split: p.split, common_route: p.route, completion: complete ? 'complete' : 'incomplete',
      initial: raw || null, final, score, fallback: Boolean(fallbackNeeded), raw_latency_ms: common ? 0 : c?.actual?.latency_ms ?? null, cascade_latency_ms: latency,
      answers: c?.actual?.response?.answers || null });
  }
  for (const split of ['development', 'evaluation']) for (const provider of ['typesafe', 'anthropic']) for (const formulation of ['broad', 'atomic']) {
    const key = `${split}/${provider}/${formulation}`;
    const rows = outcomes.filter(o => o.split === split && o.id.endsWith(`/${provider}/${formulation}`));
    const modelRows = rows.filter(o => !o.common_route);
    const complete = rows.every(o => o.completion === 'complete');
    const sum = fn => rows.reduce((n, o) => n + fn(o), 0);
    metrics[key] = { cases: rows.length, completed: rows.filter(o => o.completion === 'complete').length,
      common_routes: rows.filter(o => o.common_route).length, model_cases: modelRows.length,
      correct: sum(o => Number(Boolean(o.score?.correct))), wrong_matches: sum(o => o.score?.wrong_matches || 0),
      missed_matches: sum(o => o.score?.missed_matches || 0), false_evidence_requests: sum(o => Number(Boolean(o.score?.false_evidence_request))), false_settled: sum(o => Number(Boolean(o.score?.false_settled))),
      fallbacks: sum(o => Number(o.fallback)), blanket_review_cases: sum(o => Number(Boolean(o.initial?.blanket_fallback))),
      autonomous_correct_matches: sum(o => Number(!o.common_route && !o.fallback && o.final?.route === 'match' && o.score?.correct)),
      needs_evidence: sum(o => Number(o.final?.route === 'needs_evidence')), unresolved_model: sum(o => Number(o.final?.route === 'model_uncertain')),
      total_raw_ms: complete ? sum(o => o.raw_latency_ms) : null,
      total_cascade_ms: complete ? sum(o => o.cascade_latency_ms) : null,
      initial_wrong_matches: sum(o => {
        const gold = plan.cases.find(p => o.id.startsWith(p.id + '/')).expected.matches;
        return (o.initial?.fields || []).filter(f => f.verdict === 'match' && !gold.includes(f.handle)).length;
      })
    };
  }
  const atomic = metrics['evaluation/typesafe/atomic'];
  const broad = metrics['evaluation/typesafe/broad'];
  const strong = metrics['evaluation/anthropic/broad'];
  const complete = [atomic, broad, strong].every(m => m.completed === m.cases);
  const speedup = complete && atomic.total_cascade_ms > 0 ? strong.total_raw_ms / atomic.total_cascade_ms : null;
  const checks = {
    no_wrong_matches_or_settled: atomic.wrong_matches === 0 && atomic.initial_wrong_matches === 0 && atomic.false_settled === 0,
    no_more_false_asks_or_missed_matches: atomic.false_evidence_requests <= strong.false_evidence_requests && atomic.missed_matches <= strong.missed_matches,
    halves_fallbacks_with_actual_reduction: atomic.fallbacks < broad.fallbacks && atomic.fallbacks <= broad.fallbacks / 2,
    cascade_twice_as_fast: speedup !== null && speedup >= 2
  };
  return { metrics, outcomes, provider_usage: providerUsage,
    continuation: { status: !complete ? 'incomplete' : Object.values(checks).every(Boolean) ? 'continue_experiment' : 'criteria_not_met', checks, cascade_speedup_vs_equally_preprocessed_strong: speedup },
    measurement: 'Sequential paired provider inference; cascades are counterfactual. Common preparation/owner waiting/extraction excluded. Authored synthetic corpus, not production qualification.' };
}

export async function runRouted(plan, { mode, replay, typesafeKey, anthropicKey, fetchImpl, onCheckpoint = () => {}, ranAt } = {}) {
  verifyPlan(plan);
  if (!['live', 'replay'].includes(mode)) throw new Error('invalid_mode');
  if (mode === 'live' && (!typesafeKey?.trim() || !anthropicKey?.trim() || plan.jobs.some(j => !j.request.model?.trim()))) throw new Error('missing_credentials_or_model');
  const records = replay?.records || [];
  if (mode === 'replay' && (replay?.version !== VERSION || replay.plan_sha256 !== plan.plan_sha256 || !Array.isArray(records) || new Set(records.map(r => r.id)).size !== records.length || records.some(r => !plan.jobs.some(j => j.id === r.id)))) throw new Error('invalid_replay');
  const receipts = [], rejected = [];
  let stopped = false, calls = 0;
  const checkpoint = async () => {
    try { await onCheckpoint({ version: VERSION, plan_sha256: plan.plan_sha256, completion: 'incomplete', records: receipts, rejected_responses: rejected }); }
    catch { stopped = true; throw new Error('checkpoint_failed'); }
  };
  const result = await runEval({ suite: VERSION, mode, ranAt, fixtures: plan.jobs,
    scorer: (j, a) => {
      const score = assess(plan.cases.find(p => p.id === j.case_id), a.decision);
      return { ...score, status: score.correct ? 'pass' : 'fail', truePositive: a.decision.matches.length - score.wrong_matches, falsePositive: score.wrong_matches, falseNegative: score.missed_matches, expectedSize: plan.cases.find(p => p.id === j.case_id).expected.matches.length, actualSize: a.decision.matches.length };
    },
    runner: async job => {
      if (stopped) throw new Error('not_attempted_after_failure');
      let receipt;
      if (mode === 'replay') {
        receipt = records.find(r => r.id === job.id);
        if (!receipt || receipt.request_sha256 !== job.request_sha256 || !Number.isFinite(receipt.latency_ms) || receipt.latency_ms < 0) throw new Error('replay_record_mismatch');
      } else {
        const start = performance.now();
        try {
          calls++;
          const raw = await solve(job, { typesafeKey, anthropicKey, fetchImpl });
          receipt = { id: job.id, request_sha256: job.request_sha256, raw, latency_ms: Math.round(performance.now() - start) };
        } catch (error) {
          stopped = true;
          if (error.rejectedResponse) rejected.push({ id: job.id, request_sha256: job.request_sha256, raw: error.rejectedResponse, error: error.message, latency_ms: Math.round(performance.now() - start) });
          await checkpoint();
          throw error;
        }
      }
      const response = validateRoutedAnswer(receipt.raw, job);
      receipts.push(receipt);
      await checkpoint();
      return { response, decision: decide(plan.cases.find(p => p.id === job.case_id), job, response), latency_ms: receipt.latency_ms };
    }
  });
  return { version: VERSION, ...result, plan_sha256: plan.plan_sha256, completion: result.totals.errored ? 'incomplete' : 'complete', provider_calls: calls, records: receipts, rejected_responses: rejected, ...summarizeRouted(plan, result.cases) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = { mode: 'dry-run' }, seen = new Set();
  for (const v of argv) {
    const m = /^--(mode|plan|output|replay)=(.+)$/.exec(v);
    if (!m || seen.has(m[1])) throw new Error('invalid_argument');
    seen.add(m[1]); args[m[1]] = m[2];
  }
  if (!['dry-run', 'live', 'replay'].includes(args.mode) || !args.plan || ((args.mode === 'replay') !== Boolean(args.replay))) throw new Error('invalid_selection');
  if (args.mode !== 'dry-run' && (!args.output || existsSync(args.output))) throw new Error('fresh_output_required');
  const paths = [args.plan, args.output, args.replay].filter(Boolean).map(p => resolve(p));
  if (new Set(paths).size !== paths.length) throw new Error('path_collision');
  let result;
  if (args.mode === 'dry-run') {
    if (existsSync(args.plan)) throw new Error('plan_exists');
    const plan = await buildRoutedPlan({ databaseUrl: process.env.DONNA_PG_TEST_URL, jevModel: process.env.TYPESAFE_MODEL || process.env.TYPESAFE_DEFAULT_MODEL });
    savePrivate(resolve(args.plan), plan);
    result = { completion: 'not_run', provider_calls: 0, selected_calls: plan.jobs.length, plan_sha256: plan.plan_sha256 };
  } else {
    const plan = JSON.parse(readFileSync(args.plan, 'utf8'));
    result = await runRouted(plan, { mode: args.mode, replay: args.replay ? JSON.parse(readFileSync(args.replay, 'utf8')) : null,
      typesafeKey: process.env.TYPESAFE_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY,
      onCheckpoint: r => savePrivate(resolve(args.output), r) });
    savePrivate(resolve(args.output), result);
  }
  console.log(JSON.stringify({ completion: result.completion, provider_calls: result.provider_calls, selected_calls: result.selected_calls, continuation: result.continuation }));
  return result.completion === 'incomplete' ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Routed comparison refused or incomplete; check frozen plan, disposable PostgreSQL, credentials and fresh receipt paths.'); process.exitCode = 2; });
