// A Finnish company-month, run live from an empty book to rest in two stages:
//
//   stage 1 — every source uploaded, the scheduler clock advanced until the
//             book stops changing, before any owner answer;
//   stage 2 — each open owner question answered through the repository's own
//             reply route (POST /api/donna/firms/evidence/requests/:id/resolve),
//             then run to rest again.
//
// Built from the existing pieces: the appliance harness (bootApplianceForTest),
// the Kultalanka month worker's upload/settle loop, the book reader and scorer
// (fi_kultalanka_eval_run.js / fi_kultalanka_eval.js), and the existing profile
// and capability writers. What it adds over the frozen-plan `fi-month` lane:
// the company's ALV registration record, the owner-answer stage, a live spend
// ledger with a hard cap, and a book that stays up between the stages so the
// operator can read the questions and write truthful answers.
//
// Posture. The runtime is the desktop appliance (the hosted runtime needs
// Vercel/Supabase/Inngest identity). Certificate B admits only the
// desktop-runtime.v2 capability manifest there, so the book keeps its
// desktop-born baseline; only admitted extensions are moved toward the hosted
// FI pilot (see PILOT_ALIGNED_EXTENSIONS). The Jev first-line coder stays
// force-disabled (the harness default) unless --jev=on, because it needs the
// TypeSafe provider.
//
// Transport. OpenAI Responses requests are relayed streamed and returned as
// the non-streamed body (an egress proxy that drops silent upstreams after
// 30 s otherwise answers 502); --no-stream-relay turns that off.
//
// Usage (TZ=UTC, DONNA_PG_TEST_URL, NODE_USE_ENV_PROXY=1 behind a proxy, provider keys in the environment):
//   node scripts/fi_month_two_stage_run.js --work=DIR --facts=scripts/fixtures/fi_kultalanka_month_facts.json [--sources=a.pdf,b.pdf] [--cap-usd=40] [--stop-after=stage1] [--jev=on] [--seat-local-model=ID]
//
// --seat-local-model=ID (2026-11-10, modelLanes.js SELF_HOSTED_DECISION): seat
// the model your OpenAI-compatible server serves (OPENAI_COMPATIBLE_BASE_URL,
// and OPENAI_COMPATIBLE_API_KEY for a non-loopback host) on every lane that
// can take one, for the run's company, before any source is uploaded —
// through the policy writer, basis self_hosted_unqualified, the harness
// operator as the member. This run's network guard passes loopback and the
// known cloud providers only, so the server must listen on loopback. The
// other lanes use the provider keys as usual. The
// score is your own measurement of an unqualified model; it qualifies nothing.
// FACTS.json: { profile: {...}, alv_registration: {...}, prices: { <model>: { input_per_million, output_per_million } } }
// The runner writes DIR/stage1.json, DIR/asks-<n>.json, waits for DIR/answers-<n>.json
// ({ answers: [{ id, reply }] } or { done: true }), then DIR/stage2.json; it
// keeps the book up until DIR/stop exists. DIR/spend.jsonl has one row per call.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bootApplianceForTest } from '../server/donna/testSupport/applianceHarness.js';
import { classifyProviderRequest } from '../server/donna/testSupport/recordedProviders.js';
import { readMonthSnapshot, decisionOf, MONTH_PROFILE } from './fi_kultalanka_eval_run.js';
import { loadKultalankaLabels, scoreMonth, KULTALANKA_DIR } from './fi_kultalanka_eval.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (!m) throw new Error(`bad argument ${a}`); return [m[1], m[2]]; }));
const work = resolve(args.work || 'fi-month-run');
mkdirSync(work, { recursive: true });
const facts = JSON.parse(readFileSync(args.facts, 'utf8'));
const capUsd = Number(args['cap-usd'] || 40);
const sourcesDir = args['sources-dir'] || join(KULTALANKA_DIR, 'sources');
const labels = args.labels === 'none' ? null : loadKultalankaLabels();
const SETTLE = { advance_ms: 300_000, quiet_rounds: 3, max_rounds: Number(args['max-rounds'] || 48) };
const log = (...m) => { const line = `[${new Date().toISOString()}] ${m.join(' ')}`; console.log(line); appendFileSync(join(work, 'run.log'), line + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (name, value) => writeFileSync(join(work, name), JSON.stringify(value, null, 2));

// ── Live providers with a spend ledger and a hard cap ───────────────────────
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', 'local-runtime'];
const originalFetch = globalThis.fetch;
let spent = 0, calls = 0, refused = 0, capHit = false;
const priceOf = model => facts.prices?.[model] || Object.entries(facts.prices || {}).find(([k]) => model && model.startsWith(k))?.[1] || null;
const usageOf = (provider, body) => {
  const u = body?.usage || {};
  if (provider === 'anthropic') return { input: (u.input_tokens || 0), cache_write: u.cache_creation_input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const input = (u.input_tokens ?? u.prompt_tokens ?? 0) - cached;
  return { input, cache_write: 0, cache_read: cached, output: u.output_tokens ?? u.completion_tokens ?? 0 };
};
const usdOf = (model, t) => {
  const p = priceOf(model);
  if (!p) return null;
  return (t.input * p.input_per_million + t.cache_write * p.input_per_million * (p.cache_write_multiplier ?? 1.25)
    + t.cache_read * p.input_per_million * (p.cache_read_multiplier ?? 0.1) + t.output * p.output_per_million) / 1e6;
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input?.url || String(input));
  if (LOOPBACK.includes(url.hostname)) return originalFetch(input, init);
  const classified = classifyProviderRequest({ url: url.toString(), init });
  if (!classified) { refused++; appendFileSync(join(work, 'refused.jsonl'), JSON.stringify({ host: url.hostname, path: url.pathname }) + '\n'); throw new TypeError('fi_month_unplanned_external_request_refused'); }
  if (capHit || spent >= capUsd) { capHit = true; throw new TypeError('fi_month_spend_cap_reached'); }
  let requestModel = null;
  try { requestModel = JSON.parse(typeof init.body === 'string' ? init.body : '{}').model ?? null; } catch {}
  const started = Date.now();
  let response;
  const parsedBody = (() => { try { return JSON.parse(typeof init.body === 'string' ? init.body : ''); } catch { return null; } })();
  if (classified.endpoint_class === 'openai' && url.pathname === '/v1/responses' && parsedBody && !parsedBody.stream && !args['no-stream-relay']) {
    // Transport only: this environment's egress proxy answers 502 to any
    // upstream request silent for 30 s. The same request is sent streamed and
    // the terminal response object is handed back as the non-streamed body.
    const streamed = await originalFetch(input, { ...init, body: JSON.stringify({ ...parsedBody, stream: true }) });
    if (!streamed.ok) response = streamed;
    else {
      const sse = await streamed.text();
      let final = null, failure = null;
      for (const line of sse.split('\n')) if (line.startsWith('data:')) { try { const e = JSON.parse(line.slice(5));
        if (['response.completed', 'response.incomplete'].includes(e.type)) final = e.response;
        else if (e.type === 'error' || e.type === 'response.failed') failure ||= e.error || e.response?.error || { type: 'server_error', message: 'response.failed' }; } catch {} }
      // A failed stream answers as the non-streamed call would: an error status, never a 200.
      const FAILURE_STATUS = { insufficient_quota: 429, rate_limit_exceeded: 429, invalid_request_error: 400, server_error: 500 };
      response = final && !failure ? new Response(JSON.stringify(final), { status: 200, headers: { 'content-type': 'application/json' } })
        : failure ? new Response(JSON.stringify({ error: failure }), { status: FAILURE_STATUS[failure.type] || FAILURE_STATUS[failure.code] || 500, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: { type: 'stream_relay_incomplete', message: 'stream ended without a terminal response' } }), { status: 502, headers: { 'content-type': 'application/json' } });
    }
  } else response = await originalFetch(input, init);
  const text = await response.clone().text();
  let body = null;
  if (/event-stream/.test(response.headers.get('content-type') || '')) {
    // Streamed: the usage rides on the terminal events.
    const usage = {}; let model = null;
    for (const line of text.split('\n')) if (line.startsWith('data:')) { try { const e = JSON.parse(line.slice(5)); model ||= e.message?.model || e.response?.model || e.model || null;
      Object.assign(usage, e.message?.usage || {}, e.usage || {}, e.response?.usage || {}); } catch {} }
    body = { model, usage };
  } else { try { body = JSON.parse(text); } catch {} }
  const tokens = usageOf(classified.endpoint_class, body);
  const servedModel = body?.model || requestModel;
  const usd = usdOf(servedModel, tokens);
  spent += usd ?? 0; calls++;
  appendFileSync(join(work, 'spend.jsonl'), JSON.stringify({ n: calls, at: new Date().toISOString(), provider: classified.endpoint_class, lane: classified.lane, path: url.pathname,
    status: response.status, request_model: requestModel, served_model: servedModel, tokens, usd, unpriced: usd === null, ms: Date.now() - started, spent_usd: Math.round(spent * 1e4) / 1e4 }) + '\n');
  return response;
};

// ── Book ────────────────────────────────────────────────────────────────────
const runToken = `fim-${Date.now().toString(36)}`;
const app = await bootApplianceForTest({ runToken, now: new Date(), providers: { calls: [], unscripted: [], restore() {} }, firm: { jurisdiction: 'FI', currency: 'EUR' },
  // The month worker's boot env (fi_kultalanka_month_worker.js), except that
  // the harness's own CLIENT_CONFIG_FORCE_DISABLE=JEV_RECONCILIATION default is
  // kept unless --jev=on: the Jev first-line coder needs the TypeSafe provider
  // (TYPESAFE_API_KEY / TYPESAFE_MODEL), and without it every bank line hangs on
  // jev_model_not_configured (jevTrialProvider.js readJevDecisionPolicy).
  env: { DATABASE_POOL_MAX: '4', INNGEST_PARSE_CONCURRENCY: '1', ...(args.jev === 'on' ? { CLIENT_CONFIG_FORCE_DISABLE: '' } : {}),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ...(args['seat-local-model'] ? { OPENAI_COMPATIBLE_BASE_URL: process.env.OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY: process.env.OPENAI_COMPATIBLE_API_KEY } : {}) } });
log('booted', runToken, app.databaseUrl.replace(/\/\/[^@]*@/, '//***@'));
save('book.json', { run_token: runToken, firm_id: app.firmId, database: app.databaseUrl.split('/').pop() });
const ids = () => [app.firmId, clientId];
let clientId = null;
try {
  // The company, created through the authenticated firm create route with the pack's facts.
  const profile = { ...MONTH_PROFILE, ...(facts.profile || {}) };
  ({ clientId } = await app.createClient({ profile }));
  // The registration record through the existing profile writer (the operator's route).
  const { updateClientProfileInDb, withFirmDbClient } = await import('../server/donna/firmDb.js');
  await updateClientProfileInDb({ firmId: app.firmId, clientId, actorId: app.memberId, principal: { principalType: 'firm_member', principalId: app.memberId },
    profilePatch: { alv_registration: facts.alv_registration, ...(facts.verokausi ? { verokausi: facts.verokausi } : {}) } });
  // Capability stages. The hosted FI pilot posture (fi-cloud-pilot.v1) is not
  // admissible on the desktop runtime: Certificate B admits only the
  // desktop-runtime.v2 manifest (data/worlds/admitted-entity-profiles.json),
  // and prepareFinnishHostedPilotInDb refuses a desktop-born book
  // (PILOT_CHART_REQUIRED: coded_chart_present). So the book keeps its
  // desktop-born baseline and only the admitted extensions are moved to the
  // pilot's stage: DOCUMENT_SETTLEMENT_LEDGER_ENTRY off (FISCAL_PERIOD_INTAKE canary is refused here: unexpected_live_capability).
  const { setClientFlagStage } = await import('../server/donna/clientConfig.js');
  const { FI_HOSTED_PILOT_STAGES, CLOUD_PILOT_PROCESSING_FLAGS } = await import('../server/donna/cloudPilotConfig.js');
  const PILOT_ALIGNED_EXTENSIONS = { DOCUMENT_SETTLEMENT_LEDGER_ENTRY: 'off' };
  const pilotReceipt = { posture: 'desktop-runtime.v2 baseline + pilot-aligned admitted extensions', extensions: PILOT_ALIGNED_EXTENSIONS,
    hosted_pilot_target: { ...FI_HOSTED_PILOT_STAGES, ...Object.fromEntries(CLOUD_PILOT_PROCESSING_FLAGS.map(k => [k, 'canary'])) } };
  await withFirmDbClient(async client => {
    for (const [k, stage] of Object.entries(PILOT_ALIGNED_EXTENSIONS))
      await setClientFlagStage(client, { firmId: app.firmId, clientId, flagKey: k, stage, source: 'manual', reason: 'fi_hosted_pilot_aligned_extension', actorType: 'firm_member', actorId: app.memberId });
  });
  if (args['seat-local-model']) {
    const { setLaneDecidingPolicy } = await import('../server/donna/modelLanePolicy.js');
    const { SELF_HOSTED_BASIS, selfHostedLanes } = await import('../server/donna/modelLanes.js');
    await withFirmDbClient(async client => {
      for (const lane of selfHostedLanes())
        await setLaneDecidingPolicy({ client, firmId: app.firmId, clientId, laneId: lane.id, decidingModel: args['seat-local-model'], basis: SELF_HOSTED_BASIS,
          reason: 'fixture-month measurement of a self-hosted model', actorType: 'firm_member', actorId: app.memberId });
    });
    log('seated (UNQUALIFIED)', args['seat-local-model'], 'on', selfHostedLanes().map(lane => lane.id).join(','));
  }
  const flags = (await app.query('select flag_key, stage, source, reason from client_capability_config where firm_id=$1 and client_id=$2 and valid_to is null order by flag_key', ids())).rows;
  const clientRow = (await app.query('select company_name, jurisdiction, entity_type, profile from clients where firm_id=$1 and id=$2', ids())).rows[0];
  save('setup.json', { client_id: clientId, client: clientRow, flags, pilot_receipt: pilotReceipt, env_force_disable: process.env.CLIENT_CONFIG_FORCE_DISABLE ?? null });
  log('client', clientId, 'flags', flags.map(f => `${f.flag_key}=${f.stage}`).join(','));

  // The setup writes invalidate the entity readiness certificate; let the
  // runtime's own heal re-derive it on the scheduler clock before uploading.
  for (let i = 0; i < 20; i++) {
    const r = await app.read.readiness(clientId);
    if (r?.state === 'ready') break;
    log('readiness', r?.state, r?.reason_code ?? r?.failure_reason ?? '');
    await app.tick({ advanceMs: 60_000 });
  }
  const readiness = await app.read.readiness(clientId);
  log('readiness', readiness?.state);
  if (readiness?.state !== 'ready') throw new Error(`entity_readiness_not_ready:${readiness?.state}`);

  // Sources: one batch, as the month worker uploads them.
  const all = labels ? labels.sources.filter(s => s.file !== labels.answer_key.file).map(s => s.file) : [];
  const files = args.sources ? args.sources.split(',') : all;
  for (const file of files) await app.uploadDocument({ clientId, bytes: readFileSync(join(sourcesDir, file)), filename: file, mimeType: 'application/pdf', documentType: 'unknown', batchId: `${runToken}-sources` });
  log('uploaded', files.length);
  await app.tick({ advanceMs: 0, functions: ['parse-document'], maxRounds: files.length * 4, settleTimeoutMs: 3_600_000 });

  const fingerprint = async () => JSON.stringify([
    (await app.query('select id, coding_state, convergence_state, convergence_reason from transactions where firm_id = $1 and client_id = $2 order by id', ids())).rows,
    (await app.query('select id, parse_status, document_type, convergence_state from documents where firm_id = $1 and client_id = $2 order by id', ids())).rows,
    (await app.query('select id, status, reversed_at from ledger_journals where firm_id = $1 and client_id = $2 order by id', ids())).rows,
    (await app.query('select id, status from reconciliation_matches where firm_id = $1 and client_id = $2 order by id', ids())).rows,
    (await app.query('select id, status, evidence_type from client_evidence_requests where firm_id = $1 and client_id = $2 order by id', ids())).rows,
    (await app.query("select function_id, status, count(*)::int as n from local_jobs where status in ('pending', 'running') group by 1, 2 order by 1, 2")).rows
  ]);
  const settle = async label => {
    let quiet = 0, rounds = 0, last = null, errors = 0;
    while (rounds < SETTLE.max_rounds && quiet < SETTLE.quiet_rounds && !capHit) {
      rounds++;
      const t = await app.tick({ advanceMs: SETTLE.advance_ms, settleTimeoutMs: 3_600_000 }).catch(error => { errors++; log(label, 'tick error', error.message); return null; });
      const now = await fingerprint();
      quiet = now === last ? quiet + 1 : 0; last = now;
      log(label, 'round', rounds, 'quiet', quiet, 'jobs', t ? t.jobs.length : '-', 'spent', spent.toFixed(4), 'calls', calls);
    }
    return { rounds, settled: quiet >= SETTLE.quiet_rounds, cap_hit: capHit, tick_errors: errors };
  };
  const snapshotAndScore = async (stage, run) => {
    const snapshot = await readMonthSnapshot(app, { firmId: app.firmId, clientId });
    const jobs = (await app.query('select function_id, status, count(*)::int as n from local_jobs group by 1, 2 order by 1, 2')).rows;
    const failedJobs = (await app.query("select id, function_id, attempt_count, last_error from local_jobs where status not in ('completed','pending','running') order by id")).rows;
    const report = labels ? scoreMonth(labels, snapshot, { decisionOf, source: `fi_month_two_stage:${stage}` }) : null;
    save(`${stage}.json`, { stage, run, spent_usd: spent, calls, refused, jobs, failed_jobs: failedJobs, snapshot, report });
    log(stage, 'saved', report ? `correct_complete ${report.summary.correct_complete}/${report.summary.cases}` : '');
  };
  const run1 = await settle('stage1');
  await snapshotAndScore('stage1', run1);
  if (args['stop-after'] === 'stage1') throw Object.assign(new Error('stopped_after_stage1'), { benign: true });

  // Stage 2: answer, settle, repeat while new questions appear.
  const answered = [];
  for (let round = 1; round <= Number(args['answer-rounds'] || 4) && !capHit; round++) {
    const open = (await app.query(`select id, transaction_id, request_payload->>'document_id' as document_id, evidence_type, status, audience, question, request_payload
      from client_evidence_requests where firm_id=$1 and client_id=$2 and status in ('draft','open') order by created_at, id`, ids())).rows
      .filter(a => !answered.some(x => x.id === a.id && x.round < round && x.route_status !== 'topic_open'));
    if (!open.length) { log('no open questions; stage 2 ends'); break; }
    save(`asks-${round}.json`, open);
    log('waiting for', `answers-${round}.json`, open.length, 'questions');
    const answersFile = join(work, `answers-${round}.json`);
    while (!existsSync(answersFile)) await sleep(5000);
    const given = JSON.parse(readFileSync(answersFile, 'utf8'));
    if (given.done) break;
    for (const a of given.answers) {
      const response = await app.api.request({ method: 'POST', path: `/api/donna/firms/evidence/requests/${encodeURIComponent(a.id)}/resolve`, auth: true, body: { firm_id: app.firmId, reply: a.reply } });
      const after = (await app.query('select status from client_evidence_requests where id=$1', [a.id])).rows[0]?.status;
      answered.push({ round, id: a.id, reply: a.reply, http: response.status, route_status: response.json?.status ?? null, status_after: after, error: response.ok ? null : response.text.slice(0, 400) });
      log('answered', a.id, response.status, after);
    }
    save('answered.json', answered);
    await settle(`stage2.${round}`);
  }
  await snapshotAndScore('stage2', { answered });
} catch (error) {
  if (!error.benign) { log('FAILED', error.stack || error.message); save('failure.json', { error: error.message, stack: error.stack }); }
} finally {
  log('spent_usd', spent.toFixed(4), 'calls', calls, 'refused', refused, 'cap_hit', capHit);
  save('spend-total.json', { spent_usd: spent, calls, refused, cap_hit: capHit, cap_usd: capUsd });
  log('book stays up until', join(work, 'stop'));
  while (!existsSync(join(work, 'stop'))) await sleep(5000);
  await app.stop();
  globalThis.fetch = originalFetch;
}
