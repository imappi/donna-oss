// Kampaamo Kultalanka Oy, February 2025 — the runtime side of the automated
// evaluation (plan §8.7). Two entry points, one scorer (`fi_kultalanka_eval.js`):
//
//   score  — read a book READ-ONLY (a disposable one, or the appliance database
//            for a named client) and score it line by line. Every statement
//            runs inside `begin transaction read only`; nothing is written.
//   month  — the `fi-month` lane of the shared Jev decision-plane runner
//            (`node scripts/jev_decision_plane.js --lane=fi-month …`): upload
//            all 27 sources into a disposable appliance book
//            (`bootApplianceForTest`, the harness the UAE month runner drives),
//            let parse, match, code, post and ask run on the scheduler clock
//            with no operator action, then score the book. Every provider
//            request goes through the runner's `obtain`, so the spend ledger,
//            reservation, budget, resume, checkpoints and records are the
//            runner's own; a replay serves the recorded answers by exact request
//            digest to a fresh disposable book with no network.
//
// No real book is touched by `month`: the harness refuses the appliance
// cluster (INV-24) and every non-loopback, non-provider request is refused.
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from '../server/donna/jevEvidenceContract.js';
import { DESKTOP_RUNTIME_IDENTITY_PATHS, DESKTOP_RUNTIME_DIRTY_SCOPE } from '../server/donna/desktop/buildIdentity.js';
import { fetchProviderJson } from '../server/donna/providerTransport.js';
import { TYPESAFE_TIMEOUT_MS, MAX_TIMEOUT_MS, runDecisionPlane, savePrivate, publicSummary } from './jev_decision_plane.js';
import { ROOT, verifyBudget, estimateTokens, TYPESAFE_OUTPUT_PER_QUESTION, priceFor } from './jev_decision_plane_protocol.js';
import { decisionFromPayload, providerFailureOf } from './jev_decision_plane_fi_run.js';
import { KULTALANKA_PACK, KULTALANKA_DIR, loadKultalankaLabels, labelsDigest, validateLabels, scoreMonth } from './fi_kultalanka_eval.js';

const fail = code => { throw new Error(code); };
export const MONTH_VERSION = 'fi-kultalanka-month-v1';
export const MONTH_LANE = 'fi-month';
export const MONTH_JOB = 'month';
export const decisionOf = payload => { const d = decisionFromPayload(payload); return d ? { ...d, provider_failure: providerFailureOf(payload) } : null; };

// ── The book, read-only ─────────────────────────────────────────────────────
// Plain SELECTs; the caller supplies `query` (a read-only transaction, or the
// harness's scratch reader). Model ids come from what the book persisted.
export async function readMonthSnapshot(db, { firmId, clientId }) {
  const ids = [firmId, clientId];
  const transactions = ((await db.query(`select id, transaction_date::text as date, money_in, money_out, description, coding_state, convergence_state, convergence_reason, payload
    from transactions where firm_id = $1 and client_id = $2 order by transaction_date, id`, ids)).rows).map(t => ({ ...t, money_in: Number(t.money_in || 0), money_out: Number(t.money_out || 0) }));
  const documents = (await db.query(`select id, filename, checksum_sha256, document_type, parse_status, convergence_state, convergence_reason
    from documents where firm_id = $1 and client_id = $2 order by id`, ids)).rows;
  const matches = (await db.query(`select id, bank_transaction_id, matched_object_type, matched_object_id, status, match_amount::float8 as match_amount
    from reconciliation_matches where firm_id = $1 and client_id = $2 order by id`, ids)).rows;
  const lineRows = (await db.query(`select j.id as journal_id, j.source_type, j.source_id, j.status, j.reversed_at, j.journal_date::text as journal_date,
      l.line_no, l.account_code, l.account_name, l.direction, l.amount::float8 as amount, l.tax_type, l.payload->>'role' as role, a.canonical_role, a.account_type
    from ledger_journals j left join ledger_lines l on l.journal_id = j.id left join ledger_accounts a on a.id = l.account_id
    where j.firm_id = $1 and j.client_id = $2 order by j.id, l.line_no`, ids)).rows;
  const journals = new Map();
  for (const r of lineRows) {
    const j = journals.get(r.journal_id) || journals.set(r.journal_id, { id: r.journal_id, source_type: r.source_type, source_id: r.source_id, status: r.status, reversed_at: r.reversed_at, journal_date: r.journal_date, lines: [] }).get(r.journal_id);
    if (r.line_no != null) j.lines.push({ account_code: r.account_code, account_name: r.account_name, direction: r.direction, amount: r.amount, tax_type: r.tax_type || 'NONE', role: r.role, canonical_role: r.canonical_role, account_type: r.account_type });
  }
  const asks = (await db.query(`select id, transaction_id, request_payload->>'document_id' as document_id, evidence_type, status, question
    from client_evidence_requests where firm_id = $1 and client_id = $2 order by id`, ids)).rows;
  const distinct = result => result.rows.map(r => r.model).filter(Boolean).sort();
  const models = {
    coding_payload: distinct(await db.query(`select distinct m #>> '{}' as model from transactions t, jsonb_path_query(t.payload, 'strict $.**.model') m
      where t.firm_id = $1 and t.client_id = $2 and jsonb_typeof(m) = 'string'`, ids)),
    document_parse: distinct(await db.query(`select distinct m #>> '{}' as model from documents d, jsonb_path_query(d.parse_summary, 'strict $.**.model') m
      where d.firm_id = $1 and d.client_id = $2 and jsonb_typeof(m) = 'string'`, ids)),
    reconciliation_evaluations: distinct(await db.query('select distinct model from reconciliation_evaluations where firm_id = $1 and client_id = $2', ids)),
    ask_batches: distinct(await db.query('select distinct model from client_ask_batches where firm_id = $1 and client_id = $2', ids))
  };
  return { firm_id: firmId, client_id: clientId, transactions, documents, matches, journals: [...journals.values()], asks, models, read_at: new Date().toISOString() };
}

// Score a named client in any database, read-only. The client is named by id
// or by its exact company name (one match required).
export async function scoreBookReadOnly({ databaseUrl, firmId = null, clientId = null, companyName = null, labels = loadKultalankaLabels() }) {
  if (!databaseUrl) fail('database_url_required');
  validateLabels(labels);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // One coherent observation: every read sees the same snapshot while workers run.
    await client.query('begin transaction isolation level repeatable read read only');
    const target = (await client.query(`select id, firm_id, company_name, created_at::text as created_at from clients where ($1::text is null or id = $1) and ($2::text is null or company_name = $2) and ($3::text is null or firm_id = $3)`,
      [clientId, companyName, firmId])).rows;
    if (!target.length) fail('client_not_found');
    // Several books can share a name: list them and require --client-id.
    if (target.length > 1) fail(`client_ambiguous:${target.map(t => `${t.id}(firm ${t.firm_id}, created ${t.created_at})`).join(',')}`);
    const snapshot = await readMonthSnapshot(client, { firmId: target[0].firm_id, clientId: target[0].id });
    return { snapshot, report: scoreMonth(labels, snapshot, { decisionOf, source: 'read_only_book' }) };
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

// ── The disposable month ────────────────────────────────────────────────────
export const MONTH_PROFILE = Object.freeze({ companyName: 'Kampaamo Kultalanka Oy', jurisdiction: 'FI', entityType: 'fi-oy', currency: 'EUR', incorporationDate: '2021-01-04',
  accounting_system: 'none', accounting_basis: 'accrual', accounting_view: 'management_books', businessId: '3224455-8' });
// The model env the book runs with is frozen into the plan (the appliance's own
// per-module defaults apply where unset); the data then names what actually ran.
export const MODEL_ENV_KEYS = Object.freeze(['OPENAI_MODEL', 'ANTHROPIC_MODEL', 'TYPESAFE_MODEL']);
const PROVIDER_KEYS = Object.freeze({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', typesafe: 'TYPESAFE_API_KEY' });
export const MONTH_CODE_FILES = Object.freeze(['scripts/fi_kultalanka_eval.js', 'scripts/fi_kultalanka_eval_run.js', 'scripts/jev_decision_plane.js', 'scripts/jev_decision_plane_protocol.js',
  'scripts/jev_decision_plane_fi.js', 'scripts/jev_decision_plane_fi_run.js', 'scripts/fi_kultalanka_month_worker.js', 'server/donna/testSupport/applianceHarness.js', 'server/donna/testSupport/recordedProviders.js']);
export const monthCodeHashes = () => Object.fromEntries(MONTH_CODE_FILES.map(f => [f, hash(readFileSync(resolve(ROOT, f), 'utf8'))]));
export const sourceFiles = labels => labels.sources.filter(s => s.file !== labels.answer_key.file);
export const corpusDigest = labels => hash({ labels_sha256: labelsDigest(labels), sources: labels.sources });

// The month runs in its own process (one disposable book per process, as the
// UAE month runner does): the runtime's process-wide state never leaks between
// a live run and its replay. Provider requests cross IPC to `onProvider`.
export const SETTLE = Object.freeze({ advance_ms: 300_000, quiet_rounds: 3, max_rounds: 48 });
export const CHILD_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'TZ', 'DONNA_PG_TEST_URL', 'DONNA_APPLIANCE_FINGERPRINT_FILE']);
export async function runMonthBook({ plan, sourcesDir = MONTH_SOURCES_DIR, env = {}, onProvider, isStopped = () => false, timeoutMs = 3_600_000 }) {
  const { fork } = await import('node:child_process');
  const childEnv = { ...Object.fromEntries(CHILD_ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), ...env };
  const child = fork(new URL('./fi_kultalanka_month_worker.js', import.meta.url), ['--fi-month-worker'], { env: childEnv, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let logs = '', harnessError = null;
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  try {
    return await new Promise((resolveRun, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('month_worker_timeout')); }, timeoutMs);
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); reject(harnessError || new Error(`month_worker_exit_${code}`)); });
      child.on('message', async message => {
        if (message.type === 'done') { clearTimeout(timer); if (harnessError) reject(harnessError); else resolveRun(message.result); }
        else if (message.type === 'failed') { clearTimeout(timer); reject(harnessError || new Error(message.error)); }
        else if (message.type === 'provider') {
          let reply;
          try {
            if (harnessError || isStopped()) throw harnessError || new Error('not_attempted_after_failure');
            let request;
            try { request = JSON.parse(message.init.body); } catch { throw harness('non_json_provider_request'); }
            reply = { ok: true, raw: await onProvider(message.provider, request, message.url, message.init, message.lane) };
          } catch (error) {
            if (error?.fiMonthHarness) harnessError ||= error;
            reply = { ok: false, error: error.message, stop: Boolean(harnessError) || isStopped() };
          }
          if (child.connected) child.send({ type: 'provider_result', n: message.n, ...reply });
        }
      });
      child.send({ type: 'start', input: { plan, sourcesDir, profile: MONTH_PROFILE, env } });
    });
  } catch (error) {
    throw Object.assign(error, { worker_log_tail: logs.slice(-2000) });
  } finally { if (child.exitCode === null) child.kill(); }
}
const harness = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { fiMonthHarness: true });

// ── Plan (frozen by dry-run) ────────────────────────────────────────────────
// The executable runtime is bound through the paths Host A already treats as
// the accounting runtime (desktop/buildIdentity.js): the committed tree of
// those paths plus any uncommitted change to them. A plan frozen on one
// runtime refuses to run on another before any provider request.
export const MONTH_SOURCES_DIR = join(KULTALANKA_DIR, 'sources');
export function runtimeIdentity({ root = ROOT } = {}) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  let tree, diff, untracked;
  try {
    tree = git(['ls-tree', '-r', 'HEAD', '--', ...DESKTOP_RUNTIME_IDENTITY_PATHS]);
    diff = git(['diff', 'HEAD', '--', ...DESKTOP_RUNTIME_IDENTITY_PATHS]);
    untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...DESKTOP_RUNTIME_IDENTITY_PATHS]).split('\n').filter(Boolean).sort();
  } catch { fail('runtime_identity_unavailable'); }
  const extra = untracked.map(f => [f, createHash('sha256').update(readFileSync(resolve(root, f))).digest('hex')]);
  return { scope: DESKTOP_RUNTIME_DIRTY_SCOPE, tree_sha256: hash(tree), uncommitted_sha256: diff || extra.length ? hash({ diff, untracked: extra }) : null };
}
const sourceBytesDigest = (sources, dir) => sources.map(s => ({ file: s.file, sha256: existsSync(join(dir, s.file)) ? createHash('sha256').update(readFileSync(join(dir, s.file))).digest('hex') : null }));
// Every OpenAI request gets an enforced output ceiling when the runtime sets
// none, so the reservation, the digest and the dispatched body are one request.
export const MONTH_MAX_OUTPUT_TOKENS = 32768;
export function withOutputCeiling(provider, request, ceiling) {
  if (provider === 'openai' && !Number.isSafeInteger(request.max_output_tokens)) return { ...request, max_output_tokens: ceiling };
  if (provider === 'anthropic' && !Number.isSafeInteger(request.max_tokens)) return { ...request, max_tokens: ceiling };
  return request;
}
export function buildMonthPlan({ runToken, clockStart = new Date().toISOString(), modelEnv = {}, settle = SETTLE, maxOutputTokens = MONTH_MAX_OUTPUT_TOKENS, labels = loadKultalankaLabels(), identity = runtimeIdentity } = {}) {
  validateLabels(labels, { sourceDir: MONTH_SOURCES_DIR });
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1024) fail('invalid_output_ceiling');
  if (!/^[a-z0-9-]{4,38}$/.test(runToken || '')) fail('run_token_required');
  if (!Number.isFinite(Date.parse(clockStart))) fail('invalid_clock');
  const model_env = Object.fromEntries(MODEL_ENV_KEYS.filter(k => typeof modelEnv[k] === 'string' && modelEnv[k].trim()).map(k => [k, modelEnv[k].trim()]));
  const manifest = { profile: MONTH_PROFILE, sources: sourceFiles(labels), document_type: 'unknown', one_batch: true };
  const plan = { version: MONTH_VERSION, lane: MONTH_LANE, corpus: KULTALANKA_PACK, corpus_sha256: corpusDigest(labels), labels_sha256: labelsDigest(labels), run_token: runToken, clock_start: new Date(clockStart).toISOString(),
    model_env, settle, max_output_tokens: maxOutputTokens, runtime: identity(), code_hashes: monthCodeHashes(), cases: [{ id: MONTH_JOB, split: 'development' }], arms: [MONTH_JOB],
    jobs: [{ id: MONTH_JOB, case_id: MONTH_JOB, split: 'development', arm: MONTH_JOB, provider: 'none', request: manifest, request_sha256: hash(manifest) }] };
  return { ...plan, plan_sha256: hash(plan) };
}
export function verifyMonthPlan(plan, { sourcesDir = MONTH_SOURCES_DIR, identity = runtimeIdentity } = {}) {
  const { plan_sha256, ...body } = plan;
  const labels = loadKultalankaLabels();
  if (plan.version !== MONTH_VERSION || plan.lane !== MONTH_LANE || hash(body) !== plan_sha256 || plan.corpus_sha256 !== corpusDigest(labels) || plan.labels_sha256 !== labelsDigest(labels)
      || hash(plan.code_hashes) !== hash(monthCodeHashes()) || plan.jobs.length !== 1 || hash(plan.jobs[0].request) !== plan.jobs[0].request_sha256
      || !Number.isSafeInteger(plan.max_output_tokens)) fail('frozen_plan_mismatch');
  // The bytes the worker will upload, re-read now, and the runtime that will run them.
  if (hash(sourceBytesDigest(plan.jobs[0].request.sources, sourcesDir)) !== hash(plan.jobs[0].request.sources.map(({ file, sha256 }) => ({ file, sha256 })))) fail('frozen_plan_mismatch:source_bytes');
  if (hash(identity()) !== hash(plan.runtime)) fail('frozen_plan_mismatch:runtime');
  return true;
}

// ── The lane the shared runner drives ───────────────────────────────────────
export const MONTH_OUTPUT_ESTIMATE = 8192;
export function estimateMonthRequest(request, provider) {
  const input = estimateTokens(JSON.stringify(request));
  if (provider === 'typesafe') return { input_tokens: input, output_tokens: TYPESAFE_OUTPUT_PER_QUESTION * Object.keys(request.questions || {}).length };
  if (provider === 'openai') return { input_tokens: input, output_tokens: Number.isSafeInteger(request.max_output_tokens) ? request.max_output_tokens : MONTH_OUTPUT_ESTIMATE };
  if (provider === 'anthropic') return { input_tokens: input, output_tokens: Number.isSafeInteger(request.max_tokens) ? request.max_tokens : MONTH_OUTPUT_ESTIMATE };
  fail('unknown_provider');
}
const recordOrdinal = id => (typeof id === 'string' && /^month\/\d+$/.test(id) ? Number(id.slice(6)) : null);
export function makeMonthLane({ offline = false, resume = null, sourcesDir = MONTH_SOURCES_DIR, identity = runtimeIdentity } = {}) {
  const outcomes = new Map(), pending = new Map();
  let failure = null;
  let bounds = null;
  const originalFetch = globalThis.fetch;
  const labels = loadKultalankaLabels();
  return {
    version: MONTH_VERSION, verifyPlan: plan => verifyMonthPlan(plan, { sourcesDir, identity }), estimateRequest: estimateMonthRequest,
    jobOfRecord: (plan, id) => (recordOrdinal(id) ? plan.jobs[0] : null),
    // Every model a live month may pay for must be priced; the check runs per
    // request below because the month's models are the appliance's own.
    verifyBudget: b => { bounds = b; },
    checkCredentials: () => { if (!offline && Object.values(PROVIDER_KEYS).some(k => !process.env[k]?.trim())) fail('missing_credentials_or_model'); },
    async dispatch({ provider, request }, { fetchImpl } = {}) {
      const sent = pending.get(hash(request))?.[0] || fail('dispatch_without_pending_request');
      let result;
      try { result = await fetchProviderJson({ provider, url: sent.url, fetchImpl: fetchImpl || originalFetch, timeoutMs: provider === 'typesafe' ? TYPESAFE_TIMEOUT_MS : MAX_TIMEOUT_MS, init: { ...sent.init, redirect: 'error' } }); }
      catch (error) { throw new Error('provider_transport_failure', { cause: error }); }
      if (!result.ok) {
        const body = result.payload && typeof result.payload === 'object' ? result.payload : null;
        throw new Error(`provider_http_${result.status}`, { cause: { code: 'PROVIDER_HTTP', status: result.status, reason: typeof body?.error?.type === 'string' ? body.error.type : null, detail: typeof body?.error?.message === 'string' ? body.error.message : null } });
      }
      return result.payload;
    },
    async evaluate({ plan, mode, ranAt, replay, obtain, isStopped }) {
      const job = plan.jobs[0];
      // Replay serves, and a resumed live run reuses, the prior record with the
      // exact request digest: arrival order may differ between two runs of the
      // same month, the request bytes may not.
      const prior = mode === 'replay' ? replay?.records || [] : [...(resume?.records || []), ...(resume?.rejected_responses || [])];
      const unconsumed = [...prior].sort((a, b) => recordOrdinal(a.id) - recordOrdinal(b.id));
      let seq = Math.max(0, ...prior.map(r => recordOrdinal(r.id) || 0));
      const onProvider = async (provider, built, url, builtInit, lane) => {
        const request = withOutputCeiling(provider, built, plan.max_output_tokens);
        const init = request === built ? builtInit : { ...builtInit, body: JSON.stringify(request) };
        const requestSha = hash(request);
        let id;
        if (mode === 'replay') {
          // A replay serves each request the record with its exact digest.
          const i = unconsumed.findIndex(r => r.request_sha256 === requestSha && r.provider === provider);
          if (i < 0) throw harness('replay_unrecorded_request');
          id = unconsumed.splice(i, 1)[0].id;
        } else {
          const i = unconsumed.findIndex(r => r.request_sha256 === requestSha && r.provider === provider);
          id = i >= 0 ? unconsumed.splice(i, 1)[0].id : `${job.id}/${++seq}`;
          if (!priceFor(bounds?.prices, provider, request.model)) throw harness(`unpriced_model:${provider}:${request.model ?? 'none'}`);
        }
        const entry = { url, init };
        (pending.get(requestSha) || pending.set(requestSha, []).get(requestSha)).push(entry);
        try {
          const got = await obtain(id, provider, request, requestSha, { kind: 'month', case_id: job.case_id, arm: job.arm, lane, request_model: request.model ?? null, output_ceiling_injected: request !== built }, raw => raw);
          return got.receipt.raw;
        } catch (error) { throw error.fiMonthHarness ? error : harness(error.message, error); }
        finally { const list = pending.get(requestSha); list.splice(list.indexOf(entry), 1); if (!list.length) pending.delete(requestSha); }
      };
      const { runEval } = await import('../server/donna/evalHarness.js');
      return runEval({ suite: MONTH_VERSION, mode, ranAt, fixtures: plan.jobs,
        scorer: (j, outcome) => ({ status: outcome.report.summary.correct_complete === labels.lines.length ? 'pass' : 'fail', truePositive: outcome.report.summary.correct_complete, falsePositive: 0, falseNegative: labels.lines.length - outcome.report.summary.correct_complete, expectedSize: labels.lines.length, actualSize: labels.lines.length }),
        runner: async j => {
          if (isStopped()) throw new Error('not_attempted_after_failure');
          let month;
          try { month = await runMonthBook({ plan, sourcesDir, onProvider, isStopped, env: offline ? {} : Object.fromEntries(Object.values(PROVIDER_KEYS).map(k => [k, process.env[k]])) }); }
          catch (error) { failure = { error: error.message, harness: Boolean(error.fiMonthHarness), worker_log_tail: error.worker_log_tail ?? null }; throw error; }
          const { snapshot, run } = month;
          const report = scoreMonth(labels, snapshot, { decisionOf, source: `disposable_month:${mode}` });
          if (mode === 'replay') {
            report.replay = { unconsumed_records: unconsumed.length, reproduced_score_sha256: hash(report.lines), recorded_score_sha256: replay?.lane_outcomes?.[j.id]?.score_sha256 ?? null };
            report.replay.reproduced = report.replay.recorded_score_sha256 === report.replay.reproduced_score_sha256 && unconsumed.length === 0;
          }
          const outcome = { report, run, score_sha256: hash(report.lines) };
          outcomes.set(j.id, outcome);
          return outcome;
        } });
    },
    buildReport: (plan, records) => {
      const outcome = outcomes.get(MONTH_JOB) ?? null;
      const byLane = records.reduce((t, r) => { const k = r.lane || 'unknown'; const x = t[k] ||= { calls: 0, requested: [], served: [] };
        x.calls++; for (const [list, v] of [[x.requested, r.request_model], [x.served, r.raw?.model]]) if (v && !list.includes(v)) list.push(v); return t; }, {});
      return { completion: outcome && outcome.run.settled && !outcome.run.stopped && outcome.report.replay?.reproduced !== false ? 'complete' : 'incomplete', summary: outcome?.report.summary ?? null,
        outcomes: outcome ? outcome.report.lines.map(l => ({ id: l.id, case_id: l.id, arm: MONTH_JOB, split: 'development', status: l.status, terminal: l.terminal ?? null, correct_complete: l.correct_complete ?? false, material: l.material ?? [], missing: l.missing ?? null })) : [],
        ...(failure ? { month_failure: failure } : {}),
        month: outcome ? { run: outcome.run, economics: outcome.report.economics, identification: outcome.report.identification, by_status: outcome.report.by_status, models_from_data: outcome.report.models, provider_lanes: byLane, replay: outcome.report.replay ?? null } : null,
        continuation: { status: 'informational', note: 'One entity, one month: a development measurement, never a holdout or a gate.' },
        measurement: 'All 27 sources uploaded in one batch to a disposable appliance book; the scheduler clock advanced until the book stopped changing; then scored read-only against the adjudicated labels.' };
    },
    checkpointExtras: () => ({ lane: MONTH_LANE, lane_outcomes: Object.fromEntries([...outcomes].map(([k, v]) => [k, { score_sha256: v.score_sha256, run: v.run }])) }),
    resultExtras: () => ({ lane: MONTH_LANE, lane_outcomes: Object.fromEntries([...outcomes].map(([k, v]) => [k, { score_sha256: v.score_sha256, run: v.run, report: v.report }])) })
  };
}

// ── CLIs ────────────────────────────────────────────────────────────────────
// Month (through the shared runner, which owns --budget/--resume/--replay):
//   node scripts/jev_decision_plane.js --lane=fi-month --mode=dry-run --plan=P --run-token=T
//   node scripts/jev_decision_plane.js --lane=fi-month --mode=live --plan=P --budget=B --output=O [--public=S] [--resume=O0]
//   node scripts/jev_decision_plane.js --lane=fi-month --mode=replay --plan=P --replay=O --output=O2
// Read-only scoring of any book:
//   node scripts/fi_kultalanka_eval_run.js score --database-url=URL (--client-id=ID | --company-name=NAME) [--firm-id=F] [--output=R]
export async function mainMonth(args) {
  const read = p => JSON.parse(readFileSync(p, 'utf8'));
  const paths = [args.plan, args.output, args.replay, args.budget, args.public, args.resume].filter(Boolean).map(p => resolve(p));
  if (new Set(paths).size !== paths.length) fail('path_collision');
  if (!['dry-run', 'live', 'replay'].includes(args.mode) || !args.plan || ((args.mode === 'replay') !== Boolean(args.replay))) fail('invalid_selection');
  if (args.public && existsSync(args.public)) fail('fresh_output_required');
  let result;
  if (args.mode === 'dry-run') {
    if (existsSync(args.plan)) fail('plan_exists');
    if (args.output || args.replay || args.budget || args.resume || args.public) fail('invalid_selection');
    const plan = buildMonthPlan({ runToken: args['run-token'], ...(args['max-output-tokens'] ? { maxOutputTokens: Number(args['max-output-tokens']) } : {}), modelEnv: Object.fromEntries(MODEL_ENV_KEYS.map(k => [k, process.env[k]])) });
    savePrivate(resolve(args.plan), plan);
    result = { completion: 'not_run', provider_calls: 0, selected_calls: 1, plan_sha256: plan.plan_sha256 };
  } else {
    if (!args.output || existsSync(args.output) || args['run-token'] || args['max-output-tokens']) fail('fresh_output_required');
    if (args.mode === 'live' && !args.budget) fail('budget_required');
    if (args.resume && (args.mode !== 'live' || !existsSync(args.resume))) fail('invalid_resume');
    const resume = args.resume ? read(args.resume) : null;
    result = await runDecisionPlane(read(args.plan), { mode: args.mode, lane: makeMonthLane({ resume }), replay: args.replay ? read(args.replay) : null, budget: args.budget ? verifyBudget(read(args.budget)) : null,
      resume, onCheckpoint: r => savePrivate(resolve(args.output), r) });
    savePrivate(resolve(args.output), result);
    if (args.public) savePrivate(resolve(args.public), publicSummary(result));
  }
  console.log(JSON.stringify({ completion: result.completion, provider_calls: result.provider_calls, resumed_calls: result.resumed_calls, plan_sha256: result.plan_sha256,
    correct_complete: result.summary?.correct_complete ?? null, material: result.summary?.material_wrong_autonomous_actions ?? null, economics: result.month?.economics?.status ?? null, replay_reproduced: result.month?.replay?.reproduced ?? null }));
  return result.completion === 'incomplete' ? 2 : 0;
}

export function renderReport(report) {
  const s = report.summary;
  const rows = report.lines.map(l => [l.id, l.status, l.gold_terminal ?? '-', l.terminal ?? l.missing, l.correct_complete ? 'ok' : (l.material?.length ? `MATERIAL:${l.material.join('+')}` : l.missing_owner_ask ? 'missing ask' : l.wrong_owner_ask ? 'wrong ask' : l.status === 'disputed' ? 'disputed' : 'incomplete'), l.convergence ?? '-'].join('  '));
  return [`${report.entity} ${report.period.key} — ${report.source}`, `correct complete ${s.correct_complete}/${s.cases} · material wrong autonomous ${s.material_wrong_autonomous_actions} · wrong-VAT journals ${s.wrong_vat_journals} · missing asks ${s.missing_owner_asks} · wrong asks ${s.wrong_owner_asks} · false reconciliations ${s.false_reconciliations} · terminal ${s.terminal_coverage.terminal}/${s.cases}`,
    `labels: ${report.by_status.agreed} agreed · ${report.by_status.adjudicated} adjudicated · ${report.by_status.disputed} disputed (no gold)`, ...rows,
    `economics ${report.economics.status}: ${report.economics.checks.map(c => `${c.name} ${c.actual} (${c.pass ? `ok${c.key_positions_taken?.length ? ` (key position on ${c.key_positions_taken.join(', ')})` : ''}` : `expected at rest ${c.expected_at_rest}, key ${c.expected_with_key_disputes}`})`).join(' · ')}`,
    `models (from the book): ${JSON.stringify(report.models)}`].join('\n');
}
export async function mainScore(argv) {
  const args = {};
  for (const v of argv) { const m = /^--(database-url|client-id|company-name|firm-id|output|format)=(.+)$/.exec(v); if (!m || args[m[1]]) fail('invalid_argument'); args[m[1]] = m[2]; }
  if (!args['client-id'] && !args['company-name']) fail('client_required');
  if (args.output && existsSync(args.output)) fail('fresh_output_required');
  const { report } = await scoreBookReadOnly({ databaseUrl: args['database-url'] || process.env.DATABASE_URL, firmId: args['firm-id'] || null, clientId: args['client-id'] || null, companyName: args['company-name'] || null });
  if (args.output) savePrivate(resolve(args.output), report);
  process.stdout.write((args.format === 'json' ? JSON.stringify(report, null, 2) : renderReport(report)) + '\n');
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  (command === 'score' ? mainScore(rest) : Promise.reject(new Error('usage: fi_kultalanka_eval_run.js score --database-url=URL --company-name=NAME')))
    .then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
