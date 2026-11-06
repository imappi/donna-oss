#!/usr/bin/env node
// Offline research runner: dry-run freezes a plan; live runs it sequentially
// under an approved budget with private checkpoints; replay reproduces the
// full report from records with no network and no database. Never production.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { runEval } from '../server/donna/evalHarness.js';
import { fetchProviderJson } from '../server/donna/providerTransport.js';
import { ENDPOINT } from './jev_semantic_support_probe.js';
import { ANTHROPIC_ENDPOINT } from './jev_bounded_comparison.js';
import { currentTriageContract } from './jev_comparison_protocol.js';
import { hash } from './jev_evidence_action_contract.js';
import { VERSION, ARMS, SPLITS, MAX_REQUEST_CHARS, MAX_STRONG_OUTPUT_TOKENS, buildDecisionPlan, verifyPlan, verifyBudget, costTable, estimateRequest, usdFor, priceFor,
  decideFromRecord, decideEscalation, needsEscalation, armEscalates, escalationRequest, buildReport, malformedDecision, DECISION_FACT_KEYS } from './jev_decision_plane_protocol.js';

export function savePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.pending`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.pending`, path);
}

// Request deadline. TypeSafe answers arrive in seconds; a strong request's
// wall time scales with its output allowance (a 94-question atomic answer
// is ~5k output tokens and development's largest took ~18 s under a fixed
// 30 s deadline, which is what stopped the holdout on holdout-046).
export const TYPESAFE_TIMEOUT_MS = 30_000, STRONG_BASE_TIMEOUT_MS = 30_000, STRONG_MS_PER_OUTPUT_TOKEN = 40, MAX_TIMEOUT_MS = 300_000;
export function requestTimeoutMs({ provider, request } = {}) {
  if (provider === 'typesafe') return TYPESAFE_TIMEOUT_MS;
  const allowance = Number.isSafeInteger(request?.max_tokens) && request.max_tokens > 0 ? request.max_tokens : 0;
  return Math.min(MAX_TIMEOUT_MS, STRONG_BASE_TIMEOUT_MS + STRONG_MS_PER_OUTPUT_TOKEN * allowance);
}

export async function solve({ provider, request }, { typesafeKey, anthropicKey, fetchImpl = globalThis.fetch, timeoutMs = requestTimeoutMs({ provider, request }) } = {}) {
  const typesafe = provider === 'typesafe';
  const key = typesafe ? typesafeKey : anthropicKey;
  if (!key?.trim() || !request.model?.trim()) throw new Error('missing_provider_credentials_or_model');
  if (JSON.stringify(request).length > MAX_REQUEST_CHARS || (!typesafe && !(Number.isSafeInteger(request.max_tokens) && request.max_tokens > 0 && request.max_tokens <= MAX_STRONG_OUTPUT_TOKENS))) throw new Error('request_bound_exceeded');
  let result;
  try {
    result = await fetchProviderJson({ provider, url: typesafe ? ENDPOINT : ANTHROPIC_ENDPOINT, fetchImpl, timeoutMs,
      init: { method: 'POST', redirect: 'error', headers: typesafe ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
        : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify(request) } });
  } catch (error) { throw new Error('provider_transport_failure', { cause: error }); }
  if (!result.ok) {
    // The provider's error body is the diagnosis; keep its type and message on
    // the cause (the runner records the type publicly, the message privately).
    const body = result.payload && typeof result.payload === 'object' ? result.payload : null;
    throw new Error(`provider_http_${result.status}`, { cause: { code: 'PROVIDER_HTTP', status: result.status,
      reason: typeof body?.error?.type === 'string' ? body.error.type : null, detail: typeof body?.error?.message === 'string' ? body.error.message : null } });
  }
  return result.payload;
}

// A schema-constrained strong request the provider refuses outright (HTTP 400)
// is retried ONCE without `output_config`: the frozen questions and prompt are
// unchanged, the answer goes through the same validator, and the receipt names
// the fallback. The first holdout run stopped here on a 90-question atomic
// schema (the provider's compiled-grammar size limit is not published).
export const canDropSchema = (provider, request, error) => provider === 'anthropic' && error?.message === 'provider_http_400' && Boolean(request?.output_config?.format);
export const withoutSchema = request => { const { output_config, ...rest } = request; return rest; };

// The transport's typed classification (code + reason, e.g. timeout /
// request_timeout, network / ECONNRESET) or the provider's HTTP error type:
// machine-readable, never the message. The message, when the provider sent
// one, rides the failure record as `detail` and stays out of the public summary.
const failureCause = cause => cause && (typeof cause.code === 'string' || typeof cause.reason === 'string')
  ? { code: typeof cause.code === 'string' ? cause.code : null, reason: typeof cause.reason === 'string' ? cause.reason : null, ...(Number.isInteger(cause.status) ? { status: cause.status } : {}) } : null;
const failureDetail = cause => typeof cause?.detail === 'string' ? cause.detail : null;
const usageOf = raw => ({ input_tokens: Number.isSafeInteger(raw?.usage?.input_tokens) ? raw.usage.input_tokens : 0, output_tokens: Number.isSafeInteger(raw?.usage?.output_tokens) ? raw.usage.output_tokens : 0 });

// Resume: a live run reuses the completed and rejected calls of an earlier
// checkpoint (an interrupted run), pays only for the rest, and counts the
// reused calls' actual usage against the budget so the cap bounds the whole
// experiment, not one attempt. A reused call binds to its EXACT request digest
// (checked per record in `obtain`), not to the plan digest: a plan re-frozen
// after a runner-only code change carries identical requests, and a record of
// an identical request is the same paid answer. Reused answers are re-validated.
// A lane (FIK-3, `jev_decision_plane_fi_run.js`) supplies its own plan
// verification, record naming, request estimate, dispatch, evaluation and
// report. The spend ledger, reservation, resume, replay and checkpoint
// machinery below is shared unchanged; with no lane the runner is exactly the
// reconciliation decision plane.
const jobOfRecord = (plan, id) => plan.jobs.find(j => j.id === id || `${j.id}/escalation` === id);
const RECONCILIATION_LANE = Object.freeze({ version: VERSION, verifyPlan, jobOfRecord, estimateRequest, dispatch: solve });
function verifyResume(plan, resume, lane = RECONCILIATION_LANE) {
  if (!resume || resume.version !== lane.version || resume.corpus_sha256 && resume.corpus_sha256 !== plan.corpus_sha256) throw new Error('invalid_resume');
  const ids = new Set();
  for (const r of [...(resume.records || []), ...(resume.rejected_responses || [])]) {
    const job = lane.jobOfRecord(plan, r?.id);
    if (!r?.id || ids.has(r.id) || !job || typeof r.request_sha256 !== 'string' || !r.provider) throw new Error('invalid_resume');
    if (job.id === r.id && r.request_sha256 !== job.request_sha256) throw new Error('resume_record_mismatch');
    ids.add(r.id);
  }
  return { records: resume.records || [], rejected: resume.rejected_responses || [], plan_sha256: resume.plan_sha256 ?? null };
}

export async function runDecisionPlane(plan, { mode, replay = null, resume = null, typesafeKey, anthropicKey, fetchImpl, budget = null, onCheckpoint = () => {}, ranAt, lane: custom = null } = {}) {
  const lane = custom ? { ...RECONCILIATION_LANE, ...custom } : RECONCILIATION_LANE;
  lane.verifyPlan(plan);
  if (!['live', 'replay'].includes(mode)) throw new Error('invalid_mode');
  if (resume && mode !== 'live') throw new Error('invalid_resume');
  const resumed = resume ? verifyResume(plan, resume, lane) : { records: [], rejected: [] };
  let reused = 0;
  const bounds = mode === 'live' ? verifyBudget(budget) : null;
  if (mode === 'live' && lane.verifyBudget) lane.verifyBudget(bounds, plan);
  if (mode === 'live' && lane.checkCredentials) lane.checkCredentials(plan);
  else if (mode === 'live') {
    const needs = new Set(plan.jobs.map(j => j.provider));
    if (plan.cases.some(c => c.escalation)) needs.add('anthropic');
    if ((needs.has('typesafe') && !typesafeKey?.trim()) || (needs.has('anthropic') && !anthropicKey?.trim())
        || plan.jobs.some(j => !j.request.model?.trim()) || plan.cases.some(c => c.escalation && !c.escalation.model?.trim())) throw new Error('missing_credentials_or_model');
  }
  const replayRecords = replay?.records || [];
  if (mode === 'replay' && (replay?.version !== lane.version || replay.plan_sha256 !== plan.plan_sha256 || !Array.isArray(replayRecords)
      || new Set(replayRecords.map(r => r.id)).size !== replayRecords.length
      || replayRecords.some(r => !lane.jobOfRecord(plan, r.id))
      || (replay.rejected_responses || []).some(r => !lane.jobOfRecord(plan, r.id) || replayRecords.some(x => x.id === r.id)))) throw new Error('invalid_replay');
  const records = [], rejected = [];
  // Every call that produced no answer (a budget refusal before dispatch, a
  // transport failure or non-2xx status) is recorded here with its cause:
  // the receipt names why a run stopped instead of leaving it to be guessed.
  const failures = [];
  // The ledger holds three kinds of charge: `charged` (reconciled from provider
  // usage), `uncertain` (an attempted call whose response never arrived: the
  // estimate is retained, never zeroed) and `reserved` (the estimate of the call
  // in flight). Every bound is checked against their sum before dispatch, and
  // again against actual usage after: an overrun invalidates the run.
  const zero = () => ({ input_tokens: 0, output_tokens: 0, usd: 0 });
  const ledger = { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, charged: zero(), uncertain: zero(), reserved: zero() };
  const total = () => ({ calls: ledger.calls, input_tokens: ledger.charged.input_tokens + ledger.uncertain.input_tokens + ledger.reserved.input_tokens,
    output_tokens: ledger.charged.output_tokens + ledger.uncertain.output_tokens + ledger.reserved.output_tokens, usd: ledger.charged.usd + ledger.uncertain.usd + ledger.reserved.usd });
  const sync = () => Object.assign(ledger, total());
  // The CUMULATIVE ledger spans the whole resume chain (review finding 6): it
  // starts from the checkpoint's own cumulative total — every call that run
  // paid or attempted, reused here or not, uncertain charges included — and
  // grows only by this run's NEW dispatches. Every bound is checked against
  // both the run ledger and the cumulative one, so the cap bounds the
  // experiment, not one attempt.
  const carried = resume ? { calls: resume.budget?.cumulative?.calls ?? resume.budget?.ledger?.calls ?? 0, input_tokens: resume.budget?.cumulative?.input_tokens ?? resume.budget?.ledger?.input_tokens ?? 0,
    output_tokens: resume.budget?.cumulative?.output_tokens ?? resume.budget?.ledger?.output_tokens ?? 0, usd: resume.budget?.cumulative?.usd ?? resume.budget?.ledger?.usd ?? 0, runs: (resume.budget?.cumulative?.runs ?? 1) } : { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, runs: 0 };
  const fresh = { calls: 0, ...zero() };
  const cumulative = () => ({ calls: carried.calls + fresh.calls, input_tokens: carried.input_tokens + fresh.input_tokens, output_tokens: carried.output_tokens + fresh.output_tokens, usd: carried.usd + fresh.usd, runs: carried.runs + 1, carried_from_resume: resume ? { ...carried } : null });
  const over = t => ['calls', 'input_tokens', 'output_tokens', 'usd'].find(k => t[k] > bounds[k === 'calls' ? 'max_calls' : k === 'usd' ? 'max_usd' : `max_${k}`]);
  const exceeded = t => over(t) || over({ ...cumulative(), calls: cumulative().calls + (t.calls - ledger.calls), input_tokens: cumulative().input_tokens + (t.input_tokens - total().input_tokens),
    output_tokens: cumulative().output_tokens + (t.output_tokens - total().output_tokens), usd: cumulative().usd + (t.usd - total().usd) });
  const add = (bucket, x) => { bucket.input_tokens += x.input_tokens; bucket.output_tokens += x.output_tokens; bucket.usd += x.usd; };
  const addFresh = x => { fresh.input_tokens += x.input_tokens; fresh.output_tokens += x.output_tokens; fresh.usd += x.usd; };
  let stopped = false, calls = 0, refusal = null, overrun = null, malformedStop = null;
  // Protocol §5: a malformed-answer rate above 10% once an arm has 20 attempts
  // stops the run; below that, each malformed answer is that arm's failure.
  const attempts = {};
  const MALFORMED_MIN_ATTEMPTS = 20, MALFORMED_MAX_RATE = 0.10;
  const caseOf = id => plan.cases.find(c => c.id === id);
  const checkpoint = async () => {
    try { await onCheckpoint({ version: lane.version, plan_sha256: plan.plan_sha256, completion: 'incomplete', records, rejected_responses: rejected, failures, budget: { bounds, ledger, cumulative: cumulative(), refusal, overrun }, malformed_stop: malformedStop, ...(lane.checkpointExtras?.() ?? {}) }); }
    catch { stopped = true; throw new Error('checkpoint_failed'); }
  };
  // Token-shaped spend cap (AGENTS.md lesson AD): estimate before, refuse before
  // the request when any bound would be crossed, reconcile actual usage after.
  const admit = (id, provider, request) => {
    const estimate = { ...lane.estimateRequest(request, provider) };
    estimate.usd = usdFor(estimate, priceFor(bounds.prices, provider, request.model));
    const t = total();
    const projected = { calls: t.calls + 1, input_tokens: t.input_tokens + estimate.input_tokens, output_tokens: t.output_tokens + estimate.output_tokens, usd: t.usd + estimate.usd };
    const bound = exceeded(projected);
    if (bound) { refusal = { id, bound: `max_${bound}`, estimate, ledger_before: structuredClone(ledger), cumulative_before: cumulative() }; throw new Error(`budget_refused:max_${bound}`); }
    // Reserve before dispatch: the estimate is held until the response reconciles it.
    ledger.calls++; fresh.calls++; add(ledger.reserved, estimate); sync();
    return estimate;
  };
  const obtain = async (id, provider, request, requestSha, meta, validate) => {
    let receipt;
    if (mode === 'replay') {
      const rej = (replay?.rejected_responses || []).find(r => r.id === id);
      if (rej) {
        if (rej.request_sha256 !== requestSha || rej.provider !== provider) throw new Error('replay_record_mismatch');
        return { receipt: rej, decided: { decision: malformedDecision(rej.error), usage: usageOf(rej.raw), model: rej.raw?.model ?? null }, malformed: rej.error };
      }
      receipt = replayRecords.find(r => r.id === id);
      if (!receipt || receipt.request_sha256 !== requestSha || receipt.provider !== provider || !Number.isFinite(receipt.latency_ms) || receipt.latency_ms < 0) throw new Error('replay_record_mismatch');
    } else {
      if (stopped) throw new Error('not_attempted_after_failure');
      const priorRecord = resumed.records.find(r => r.id === id), priorRejected = resumed.rejected.find(r => r.id === id);
      let prior = priorRecord || priorRejected;
      // An escalation request carries the initial decision's dependencies, so a
      // plan re-frozen under another composition policy can change it: a prior
      // escalation record with a different digest is simply not reusable and
      // is re-requested. An initial record never differs (verifyResume).
      if (prior && meta.kind === 'escalation' && prior.provider === provider && prior.request_sha256 !== requestSha) prior = null;
      if (prior) {
        if (prior.request_sha256 !== requestSha || prior.provider !== provider) throw new Error('resume_record_mismatch');
        // Already paid in the interrupted attempt: count it, never re-request it.
        reused++; ledger.calls++; if (prior.budget?.actual) add(ledger.charged, prior.budget.actual); sync();
        if (priorRejected) {
          rejected.push(priorRejected);
          const a = attempts[meta.arm] ||= { attempts: 0, malformed: 0 }; a.malformed++;
          await checkpoint();
          return { receipt: priorRejected, decided: { decision: malformedDecision(priorRejected.error), usage: usageOf(priorRejected.raw), model: priorRejected.raw?.model ?? null }, malformed: priorRejected.error };
        }
        const decidedPrior = validate(priorRecord.raw);
        records.push(priorRecord); await checkpoint();
        return { receipt: priorRecord, decided: decidedPrior };
      }
      const timeoutMs = requestTimeoutMs({ provider, request });
      const fail = (error, latencyMs, extra = {}) => failures.push({ id, ...meta, provider, request_sha256: requestSha, error: error.message, cause: failureCause(error.cause), detail: failureDetail(error.cause), timeout_ms: timeoutMs, latency_ms: latencyMs, ...extra });
      // One attempt: reserve, dispatch, reconcile. A failure is recorded with
      // its cause and thrown; `stop` says whether it ends the run.
      const attempt = async (sent, { stop, extra }) => {
        let estimate;
        try { estimate = admit(id, provider, sent); }
        catch (error) { fail(error, null); stopped = true; await checkpoint(); throw error; }
        const start = performance.now();
        try { calls++; const raw = await lane.dispatch({ provider, request: sent }, { typesafeKey, anthropicKey, fetchImpl, timeoutMs }); return { raw, estimate, latency_ms: Math.round(performance.now() - start) }; }
        catch (error) {
          // No response, so no usage to reconcile: the reservation becomes an
          // uncertain charge that stays on the ledger. It is never zeroed.
          fail(error, Math.round(performance.now() - start), stop(error) ? {} : extra);
          ledger.reserved = zero(); add(ledger.uncertain, estimate); addFresh(estimate); sync();
          if (stop(error)) stopped = true;
          await checkpoint(); throw error;
        }
      };
      let got, fallback = null, sent = request;
      try { got = await attempt(request, { stop: error => !canDropSchema(provider, request, error), extra: { retried: 'schema_dropped' } }); }
      catch (error) {
        if (stopped) throw error;
        sent = withoutSchema(request);
        fallback = { kind: 'schema_dropped', error: error.message, cause: failureCause(error.cause) };
        got = await attempt(sent, { stop: () => true, extra: {} });
      }
      const { raw, estimate, latency_ms } = got;
      const actual = { ...usageOf(raw), usd: null };
      actual.usd = usdFor(actual, priceFor(bounds.prices, provider, sent.model));
      ledger.reserved = zero(); add(ledger.charged, actual); addFresh(actual); sync();
      // `request_sha256` is always the FROZEN request's digest (resume and replay
      // bind to it); when a fallback was sent, `sent_request_sha256` names it.
      receipt = { id, ...meta, provider, request_sha256: requestSha, ...(fallback ? { sent_request_sha256: hash(sent), fallback } : {}), raw, latency_ms, budget: { estimate, actual } };
      const bound = exceeded(total());
      if (bound) {
        // Actual usage crossed a bound the estimate did not predict. The paid
        // response is retained as a record, the run stops, and the result is
        // invalid for any continuation decision.
        overrun = { id, bound: `max_${bound}`, estimate, actual, ledger: structuredClone(ledger) };
        records.push(receipt); stopped = true; await checkpoint(); throw new Error(`budget_overrun:max_${bound}`);
      }
    }
    let decided;
    try { decided = validate(receipt.raw); }
    catch (error) {
      if (mode === 'replay') throw error;
      // The paid answer is unusable: retain it, score the case as this arm's
      // failure, and continue unless the arm's malformed rate crosses the rule.
      const rej = { id, ...meta, provider, request_sha256: requestSha, raw: receipt.raw, error: error.message, latency_ms: receipt.latency_ms, budget: receipt.budget };
      rejected.push(rej);
      const a = attempts[meta.arm] ||= { attempts: 0, malformed: 0 }; a.malformed++;
      if (a.attempts >= MALFORMED_MIN_ATTEMPTS && a.malformed / a.attempts > MALFORMED_MAX_RATE) { malformedStop = { arm: meta.arm, ...a, at: id }; stopped = true; }
      await checkpoint();
      return { receipt: rej, decided: { decision: malformedDecision(error.message), usage: usageOf(receipt.raw), model: receipt.raw?.model ?? null }, malformed: error.message };
    }
    records.push(receipt);
    if (mode === 'live') await checkpoint();
    return { receipt, decided };
  };
  const attempted = arm => { const a = attempts[arm] ||= { attempts: 0, malformed: 0 }; a.attempts++; };
  const evaluation = lane.evaluate ? await lane.evaluate({ plan, mode, ranAt, replay, resuming: Boolean(resume), obtain, attempted, fetchImpl, isStopped: () => stopped }) : await runEval({ suite: VERSION, mode, ranAt, fixtures: plan.jobs,
    scorer: (job, actual) => {
      const c = caseOf(job.case_id), final = actual.escalated || actual.initial;
      const pass = final.route === c.expected.route && hash(final.proposals) === hash(c.expected.proposals) && !final.guard;
      return { status: pass ? 'pass' : 'fail', truePositive: Number(pass), falsePositive: Number(!pass), falseNegative: Number(!pass), expectedSize: 1, actualSize: 1 };
    },
    runner: async job => {
      if (stopped) throw new Error('not_attempted_after_failure');
      const planCase = caseOf(job.case_id);
      if (mode === 'live') attempted(job.arm);
      const { decided } = await obtain(job.id, job.provider, job.request, job.request_sha256, { kind: 'initial', case_id: job.case_id, arm: job.arm }, raw => decideFromRecord(planCase, job.arm, raw));
      const actual = { initial: decided.decision, escalated: null };
      if (needsEscalation(job.arm, decided.decision, { escape: armEscalates(job.arm, plan) }) && !stopped) {
        // ONE bounded strong call carrying the complete collision group state
        // plus the receipt's named dependencies; charged to this arm's cascade.
        const request = escalationRequest(planCase.prepared, planCase.escalation.model, decided.decision);
        if (mode === 'live') attempted(job.arm);
        const esc = await obtain(`${job.id}/escalation`, 'anthropic', request, hash(request), { kind: 'escalation', case_id: job.case_id, arm: job.arm }, raw => decideEscalation(planCase, raw));
        actual.escalated = esc.decided.decision;
      }
      return actual;
    }
  });
  const replayRejected = mode === 'replay' ? (replay?.rejected_responses || []) : rejected;
  const report = (lane.buildReport ?? buildReport)(plan, records, replayRejected, { prices: bounds?.prices ?? replay?.budget?.bounds?.prices ?? null });
  const reconciliation = [...records, ...replayRejected].filter(r => r.budget).reduce((t, r) => ({ estimated: { input_tokens: t.estimated.input_tokens + r.budget.estimate.input_tokens, output_tokens: t.estimated.output_tokens + r.budget.estimate.output_tokens, usd: t.estimated.usd + r.budget.estimate.usd },
    actual: { input_tokens: t.actual.input_tokens + r.budget.actual.input_tokens, output_tokens: t.actual.output_tokens + r.budget.actual.output_tokens, usd: t.actual.usd + r.budget.actual.usd } }),
    { estimated: { input_tokens: 0, output_tokens: 0, usd: 0 }, actual: { input_tokens: 0, output_tokens: 0, usd: 0 } });
  return { version: lane.version, plan_sha256: plan.plan_sha256, corpus: plan.corpus, corpus_sha256: plan.corpus_sha256, mode, ranAt: evaluation.ranAt,
    completion: overrun || malformedStop || evaluation.totals.errored || report.completion === 'incomplete' ? 'incomplete' : 'complete', provider_calls: calls,
    budget: { bounds, ledger, cumulative: mode === 'live' ? cumulative() : null, refusal, overrun, reconciliation }, malformed_stop: malformedStop, malformed_attempts: attempts, resumed_calls: reused, resumed_from_plan_sha256: resumed.plan_sha256, ...report,
    continuation: overrun ? { ...report.continuation, status: 'invalid_budget_overrun', checks: null, cascade_speedup_vs_strong_full_case: null }
      : malformedStop ? { ...report.continuation, status: 'stopped_malformed_rate', checks: null, cascade_speedup_vs_strong_full_case: null } : report.continuation,
    // Private material: raw bodies and served model identities never enter the public summary.
    served_models: [...new Set(records.map(r => r.raw?.model).filter(Boolean))].sort(), records, rejected_responses: rejected, failures, ...(lane.resultExtras?.() ?? {}) };
}

// Public projection: no records, no rejected bodies, no model ids, no raw prose.
export const publicSummary = result => ({ version: result.version, plan_sha256: result.plan_sha256, corpus: result.corpus, corpus_sha256: result.corpus_sha256, mode: result.mode, ranAt: result.ranAt,
  completion: result.completion, provider_calls: result.provider_calls, budget: result.budget, malformed_stop: result.malformed_stop, malformed_attempts: result.malformed_attempts,
  rejected: (result.rejected_responses || []).map(r => ({ id: r.id, error: r.error })), failures: (result.failures || []).map(({ detail, ...f }) => f), summary: result.summary, continuation: result.continuation, measurement: result.measurement,
  outcomes: result.outcomes.map(({ initial, escalated, final, ...o }) => ({ ...o, initial: strip(initial), escalated: strip(escalated), final: strip(final) })) });
// Decision facts (deciding answers with raw probabilities, exclusions, reversals,
// forced blocks) are structured and prose-free, so they ride the public summary.
const strip = d => d && { route: d.route, reason: d.reason, proposals: d.proposals, guard: d.guard ? { refusals: d.guard.refusals, initial: d.guard.initial } : null, fallback: d.fallback ?? undefined,
  ...Object.fromEntries(DECISION_FACT_KEYS.filter(k => d[k] !== undefined).map(k => [k, d[k]])) };

export function renderCostTable(table) {
  const cols = ['arm', 'initial_calls', 'max_escalation_calls', 'max_calls', 'estimated_input_tokens', 'estimated_output_tokens', 'estimated_usd'];
  const rows = [...Object.entries(table.arms), ['total', table.total]].map(([arm, r]) => [arm, ...cols.slice(1).map(c => r[c] === null ? '-' : String(r[c]))]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
  const line = r => r.map((v, i) => v.padEnd(widths[i])).join('  ');
  return [`cases=${table.cases} model_dependent=${table.model_dependent_cases} common_routes=${table.common_route_cases}`, line(cols), ...rows.map(line), `estimator: ${table.estimator}`].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = { mode: 'dry-run' }, seen = new Set();
  for (const v of argv) {
    const m = /^--(mode|corpus|split|arms|cases|plan|output|replay|budget|public|resume|policy|floor|lane|comparator|preregistration|baseline|holdout-ledger|provisional|run-token|max-output-tokens)=(.+)$/.exec(v);
    if (!m || seen.has(m[1])) throw new Error('invalid_argument');
    seen.add(m[1]); args[m[1]] = m[2];
  }
  // FIK-3: the Finnish coding lane shares this runner's ledger and receipts.
  if (args.lane !== undefined) {
    // The Kultalanka whole month (plan §8.7) shares the same ledger and receipts.
    if (args.lane === 'fi-month') {
      if (args.provisional !== undefined) throw new Error('invalid_argument');
      return (await import('./fi_kultalanka_eval_run.js')).mainMonth(args);
    }
    if (args.lane !== 'fi-coding' || args['run-token'] !== undefined || args['max-output-tokens'] !== undefined) throw new Error('invalid_argument');
    return (await import('./jev_decision_plane_fi_run.js')).mainFi(args);
  }
  if (['comparator', 'preregistration', 'baseline', 'holdout-ledger', 'provisional', 'run-token', 'max-output-tokens'].some(k => args[k] !== undefined)) throw new Error('invalid_argument');
  if (!['dry-run', 'live', 'replay'].includes(args.mode) || !args.plan || ((args.mode === 'replay') !== Boolean(args.replay))) throw new Error('invalid_selection');
  if (args.mode !== 'dry-run' && (!args.output || existsSync(args.output) || args.corpus || args.split || args.arms || args.cases || args.policy || args.floor)) throw new Error('fresh_output_required');
  if (args.floor !== undefined && !/^(0|1|0\.\d+)$/.test(args.floor)) throw new Error('invalid_policy');
  // A named capability-boundary policy (safe / max_authority / forced) pins its floor; --floor beside it is refused by the plan.
  if (args.public && existsSync(args.public)) throw new Error('fresh_output_required');
  if (args.mode === 'live' && !args.budget) throw new Error('budget_required');
  if (args.resume && (args.mode !== 'live' || !existsSync(args.resume))) throw new Error('invalid_resume');
  const paths = [args.plan, args.output, args.replay, args.budget, args.public, args.resume].filter(Boolean).map(p => resolve(p));
  if (new Set(paths).size !== paths.length) throw new Error('path_collision');
  const budget = args.budget ? verifyBudget(JSON.parse(readFileSync(args.budget, 'utf8'))) : null;
  let result;
  if (args.mode === 'dry-run') {
    if (existsSync(args.plan)) throw new Error('plan_exists');
    const url = process.env.DONNA_PG_TEST_URL;
    if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('local_disposable_postgres_required');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    let plan;
    try {
      plan = await buildDecisionPlan({ client, corpus: args.corpus || 'jev-contract', split: args.split || 'all', arms: args.arms ? args.arms.split(',') : ARMS,
        jevModel: process.env.TYPESAFE_MODEL || null, strongModel: process.env.JEV_STRONG_MODEL || currentTriageContract().model, cheapModel: process.env.JEV_CHEAP_MODEL || null,
        ...(args.cases ? { cases: args.cases.split(',') } : {}),
        ...(args.policy ? { policy: args.policy } : {}), ...(args.floor !== undefined ? { floor: Number(args.floor) } : {}) });
    } finally { await client.end(); }
    savePrivate(resolve(args.plan), plan);
    const table = costTable(plan, budget);
    process.stdout.write(renderCostTable(table) + '\n');
    result = { completion: 'not_run', provider_calls: 0, selected_calls: plan.jobs.length, plan_sha256: plan.plan_sha256, cost: table };
  } else {
    const plan = JSON.parse(readFileSync(args.plan, 'utf8'));
    result = await runDecisionPlane(plan, { mode: args.mode, replay: args.replay ? JSON.parse(readFileSync(args.replay, 'utf8')) : null, budget,
      resume: args.resume ? JSON.parse(readFileSync(args.resume, 'utf8')) : null,
      typesafeKey: process.env.TYPESAFE_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY, onCheckpoint: r => savePrivate(resolve(args.output), r) });
    savePrivate(resolve(args.output), result);
    if (args.public) savePrivate(resolve(args.public), publicSummary(result));
  }
  console.log(JSON.stringify({ completion: result.completion, provider_calls: result.provider_calls, resumed_calls: result.resumed_calls, selected_calls: result.selected_calls, plan_sha256: result.plan_sha256, continuation: result.continuation }));
  return result.completion === 'incomplete' ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(error => {
  const known = ['invalid_argument', 'invalid_selection', 'unknown_case', 'fresh_output_required', 'budget_required', 'path_collision', 'plan_exists', 'local_disposable_postgres_required', 'invalid_budget', 'frozen_plan_mismatch', 'invalid_replay', 'invalid_resume', 'resume_record_mismatch', 'missing_credentials_or_model', 'invalid_corpus', 'empty_selection', 'blanket_requires_full_case_fallback', 'cheap_model_required', 'invalid_policy',
    'preregistration_required', 'baseline_summary_required', 'run_token_required', 'invalid_output_ceiling', 'runtime_identity_unavailable', 'replay_unrecorded_request', 'non_json_provider_request', 'baseline_summary_mismatch', 'baseline_not_development', 'holdout_ledger_required', 'holdout_read_not_recorded', 'preregistration_is_for_holdout',
    'provisional_arm_not_allowed_on_holdout', 'provisional_guidance_record_mismatch', 'invalid_provisional_guidance_file'];
  const fik3 = /^(frozen_plan_mismatch|client_ambiguous|invalid_preregistration|holdout_already_read|split_leakage|arms_differ_beyond_policy|arm_variant_not_selected|invalid_fi_case):[\w,:.-]*$/;
  console.error(known.includes(error?.message) || fik3.test(error?.message ?? '') ? error.message : 'Decision-plane run refused or incomplete; check frozen plan, disposable PostgreSQL, budget, credentials and fresh receipt paths.');
  process.exitCode = 2;
});
