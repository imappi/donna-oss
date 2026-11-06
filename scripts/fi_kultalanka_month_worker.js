// The Kultalanka month's book worker (plan §8.7): one disposable appliance
// book per process, as the UAE month runner runs one per order. It holds no
// labels, answer key or expected figures — only the 27 source files and the
// frozen plan. Every provider request crosses IPC to the parent, whose shared
// Jev decision-plane ledger answers it (live, budgeted) or serves the recorded
// answer (replay); any other non-loopback request is refused and counted.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyProviderRequest } from '../server/donna/testSupport/recordedProviders.js';
import { bootApplianceForTest } from '../server/donna/testSupport/applianceHarness.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', 'local-runtime'];
const hashState = value => JSON.stringify(value);

export async function runMonthWorker({ plan, sourcesDir, profile, env = {} }, ask) {
  const originalFetch = globalThis.fetch;
  let refused = 0, stopped = null, seq = 0;
  const lanes = {};
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input?.url || String(input));
    const classified = classifyProviderRequest({ url: url.toString(), init });
    if (!classified) {
      if (LOOPBACK.includes(url.hostname)) return originalFetch(input, init);
      refused++; throw new TypeError('fi_month_unplanned_external_request_refused');
    }
    lanes[classified.lane] = (lanes[classified.lane] || 0) + 1;
    if (stopped) throw new TypeError(`fi_month_provider_unavailable:${stopped}`);
    const body = typeof init.body === 'string' ? init.body : Buffer.from(init.body || '').toString('utf8');
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const answer = await ask({ n: ++seq, provider: classified.endpoint_class, lane: classified.lane, url: url.toString(), init: { method: init.method || 'POST', headers, body } });
    if (!answer.ok) { if (answer.stop) stopped = answer.error; throw new TypeError(`fi_month_provider_unavailable:${answer.error}`); }
    return new Response(JSON.stringify(answer.raw), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let app = null;
  try {
    app = await bootApplianceForTest({ runToken: plan.run_token, now: new Date(plan.clock_start), providers: { calls: [], unscripted: [], restore() {} }, firm: { jurisdiction: 'FI', currency: 'EUR' },
      env: { DATABASE_POOL_MAX: '4', INNGEST_PARSE_CONCURRENCY: '1', CLIENT_CONFIG_FORCE_DISABLE: '', ...plan.model_env, ...env } });
    const { clientId } = await app.createClient({ profile });
    const batchId = `${plan.run_token}-sources`;
    for (const s of plan.jobs[0].request.sources) {
      await app.uploadDocument({ clientId, bytes: readFileSync(join(sourcesDir, s.file)), filename: s.file, mimeType: 'application/pdf', documentType: plan.jobs[0].request.document_type, batchId });
    }
    // Exact replay needs the same source snapshots, including intermediate
    // failed/partial reads. Use the existing one-parser queue and settle its
    // real post-parse legs before admitting competing cron sweeps.
    await app.tick({ advanceMs: 0, functions: ['parse-document'], maxRounds: plan.jobs[0].request.sources.length * 4 });
    const sourceJobsSettled = Number((await app.query("select count(*) as n from local_jobs where function_id='parse-document' and status in ('pending','running')")).rows[0].n) === 0;
    if (!stopped && !sourceJobsSettled) throw new Error('fi_month_source_jobs_not_settled');
    // The scheduler clock advances until the book stops changing.
    const ids = [app.firmId, clientId];
    const fingerprint = async () => {
      return hashState([
        (await app.query('select id, coding_state, convergence_state, convergence_reason from transactions where firm_id = $1 and client_id = $2 order by id', ids)).rows,
        (await app.query('select id, parse_status, document_type, convergence_state from documents where firm_id = $1 and client_id = $2 order by id', ids)).rows,
        (await app.query('select id, status, reversed_at from ledger_journals where firm_id = $1 and client_id = $2 order by id', ids)).rows,
        (await app.query('select id, status from reconciliation_matches where firm_id = $1 and client_id = $2 order by id', ids)).rows,
        (await app.query('select id, status, evidence_type from client_evidence_requests where firm_id = $1 and client_id = $2 order by id', ids)).rows,
        (await app.query("select function_id, status, count(*)::int as n from local_jobs where status in ('pending', 'running') group by 1, 2 order by 1, 2")).rows
      ]);
    };
    let quiet = 0, rounds = 0, last = null;
    while (rounds < plan.settle.max_rounds && quiet < plan.settle.quiet_rounds && !stopped) {
      rounds++;
      await app.tick({ advanceMs: plan.settle.advance_ms });
      const now = await fingerprint();
      quiet = now === last ? quiet + 1 : 0; last = now;
    }
    const { readMonthSnapshot } = await import('./fi_kultalanka_eval_run.js');
    const snapshot = await readMonthSnapshot(app, { firmId: app.firmId, clientId });
    const jobs = (await app.query('select function_id, status, count(*)::int as n from local_jobs group by 1, 2 order by 1, 2')).rows;
    return { snapshot, run: { source_jobs_settled: sourceJobsSettled, rounds, settled: quiet >= plan.settle.quiet_rounds, stopped, provider_requests: seq, lanes, unplanned_requests_refused: refused, jobs } };
  } finally {
    globalThis.fetch = originalFetch;
    if (app) await app.stop();
  }
}

// Child entry: the parent sends { type: 'start', input } and answers every
// { type: 'provider' } with { type: 'provider_result' }.
if (process.send && process.argv.includes('--fi-month-worker')) {
  const waiting = new Map();
  process.on('message', async message => {
    if (message?.type === 'provider_result') { waiting.get(message.n)?.(message); waiting.delete(message.n); return; }
    if (message?.type !== 'start') return;
    const ask = request => new Promise(resolve => { waiting.set(request.n, resolve); process.send({ type: 'provider', ...request }); });
    try { process.send({ type: 'done', result: await runMonthWorker(message.input, ask) }, () => process.exit(0)); }
    catch (error) { process.send({ type: 'failed', error: error.message }, () => process.exit(1)); }
  });
}
