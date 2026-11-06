import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { enrollJevExperiment, readJevExperiment } from './jevExperimentPolicy.js';
import { dispatchJevReverseShadow } from './jevShadow.js';
import { makeJevTrialProvider } from './jevTrialProvider.js';

const PG_URL = process.env.DONNA_PG_TEST_URL;
test('real PG: scoped trial authority, exact reverse-shadow observation, dedup/cap and non-writing disagreement',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL required' }, async () => {
    const admin = new pg.Client({ connectionString: PG_URL }); await admin.connect();
    const name = `donna_jev_shadow_${process.pid}`;
    await admin.query(`create database "${name}"`);
    const url = new URL(PG_URL); url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    const disconnected = [];
    pool.on('connect', client => disconnected.push(new Promise(resolve => client.once('end', resolve))));
    const withClient = async fn => { const client = await pool.connect(); try { return await fn(client); } finally { client.release(); } };
    const env = { TYPESAFE_MODEL: 'fixture-model', ANTHROPIC_API_KEY: 'fixture-not-a-key' };
    try {
      for (const migration of ['001_firm_core.sql', '116_model_challenger_runs.sql', '121_model_lane_policy.sql']) {
        await pool.query(await readFile(new URL(`../../db/migrations/${migration}`, import.meta.url), 'utf8'));
      }
      await pool.query("insert into firms(id,name,slug) values('f','Fixture','fixture')");
      await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('member','f','member@example.invalid','Member','admin','active')");
      await pool.query("insert into clients(id,firm_id,company_name) values('c','f','Fixture Co')");
      const shadow = { model: 'fixture-review-model', max_calls: 2, max_input_tokens: 1000, max_output_tokens: 100,
        approved_usd: 0.1, input_usd_per_million: 5, output_usd_per_million: 25,
        approval_basis: 'fixture explicit approval', price_source: 'fixture-price-record',
        coverage: ['matching'], versions: { packet: 'fixture-packet-v1', action: 'fixture-action-v1' } };
      const enrolled = await withClient(client => enrollJevExperiment({ client, firmId: 'f', clientId: 'c', actorId: 'member',
        authorityBasis: 'fixture operator instruction', trialId: 'fixture-trial', expiresAt: '2100-01-01', model: env.TYPESAFE_MODEL, env, shadow }));
      const policy = await withClient(client => readJevExperiment({ client, firmId: 'f', clientId: 'c', model: env.TYPESAFE_MODEL }));
      assert.equal(policy.id, enrolled.id);
      assert.equal(policy.experiment.probability_floor, null);
      assert.equal(policy.experiment.outbound_sends, false);
      const providerResult = { model: env.TYPESAFE_MODEL, answers: { plan: { type: 'choice', choice: 'settle', probability: 0.2 } } };
      const wrapped = await withClient(client => makeJevTrialProvider({ client, firmId: 'f', clientId: 'c',
        resourceType: 'document', resourceId: 'fixture-document', decisionKind: 'matching', snapshot: {}, withClient,
        env: { TYPESAFE_MODEL: env.TYPESAFE_MODEL }, provider: async () => providerResult }));
      const trialRequest = { model: env.TYPESAFE_MODEL, state: {}, questions: {} };
      const trialResult = await wrapped(trialRequest);
      assert.deepEqual(trialResult, { ...providerResult, jev_basis: 'experiment',
        request_sha256: createHash('sha256').update(JSON.stringify(trialRequest)).digest('hex') },
        'the trial wrapper returns the same answer, including a low selected probability, plus its request receipt');
      assert.equal(trialResult.answers, providerResult.answers);
      await assert.rejects(() => withClient(client => makeJevTrialProvider({ client, firmId: 'f', clientId: 'outside',
        env, snapshot: {}, withClient })), { code: 'jev_experiment_not_authorized' });
      const calls = [];
      let refuseCount = false;
      const fetchImpl = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: refuseCount ? 901 : 200 });
        return Response.json({ model: shadow.model, content: [{ type: 'text', text: JSON.stringify({ plan: 'leave_open' }) }], usage: { input_tokens: 200, output_tokens: 20 } });
      };
      const observation = { resolved: true, evidencePacketSha256: 'packet-frozen', decisionKind: 'matching',
        execution: { root: { type: 'jev_reconciliation', id: 'doc-1' } }, model: 'fixture-model',
        request: { state: { amount_minor: 12300, evidence: ['source-one'] }, questions: { plan: { type: 'choice', criteria: { settle: 'Settle the supplied payment', leave_open: 'No payment settles this obligation' } } } },
        answers: { plan: { type: 'choice', choice: 'settle', probability: 0.2 } } };
      const options = { firmId: 'f', clientId: 'c', snapshot: { MODEL_CHALLENGER: { stage: 'shadow' } }, policy, withClient, observation, env, fetchImpl };
      const outcomes = await Promise.all([dispatchJevReverseShadow(options), dispatchJevReverseShadow(options)]);
      assert.equal(outcomes.filter(Boolean).length, 1, 'duplicate concurrent hook reserves only one call');
      assert.equal(calls.length, 2, 'one token count and one solve; no retry');
      const sent = JSON.parse(calls[1].body.messages[0].content);
      assert.deepEqual(sent.state, observation.request.state);
      assert.deepEqual(sent.questions, observation.request.questions);
      assert.equal(sent.answers, undefined, 'reviewer does not see the deciding answer');
      assert.equal(calls[1].body.max_tokens, 100);
      const runs = (await pool.query('select * from model_challenger_runs')).rows;
      assert.equal(runs.length, 1); assert.equal(runs[0].outcome, 'divergence');
      assert.equal(runs[0].divergence_summary.adjudicated, false);
      assert.deepEqual(runs[0].divergence_summary.choices, [{ question: 'plan', deciding: 'settle', shadow: 'leave_open' }]);
      assert.equal(runs[0].usage.total_tokens, 220);
      assert.equal((await pool.query('select count(*)::int n from transactions')).rows[0].n, 0);
      assert.equal((await pool.query('select count(*)::int n from documents')).rows[0].n, 0);
      refuseCount = true;
      await dispatchJevReverseShadow({ ...options, observation: { ...observation, execution: { root: { type: 'jev_reconciliation', id: 'doc-2' } } } });
      assert.equal(calls.length, 3, 'over-budget input has no solve');
      const failed = (await pool.query("select * from model_challenger_runs where outcome='challenger_error'")).rows;
      assert.equal(failed.length, 1); assert.equal(failed[0].divergence_summary.error_code, 'jev_shadow_input_budget_refused');
      await dispatchJevReverseShadow({ ...options, observation: { ...observation, execution: { root: { type: 'jev_reconciliation', id: 'doc-3' } } } });
      assert.equal(calls.length, 3, 'exhausted cap makes no provider request');
      // Shipping default: drive the real factory -> asynchronous hook -> PG
      // receipt, without any experimental enrollment or shadow budget.
      const desktopEnv = { ...env, DONNA_DESKTOP_BLOB_DIR: '/tmp/fixture', JEV_SHADOW_SAMPLE_FRACTION: '1' };
      const desktopSnapshot = { JEV_RECONCILIATION: { stage: 'auto', source: 'default' }, MODEL_CHALLENGER: { stage: 'shadow' } };
      const savedFetch = globalThis.fetch;
      let finish, timeout;
      const finished = new Promise((resolve, reject) => {
        finish = resolve;
        timeout = setTimeout(() => reject(new Error('desktop shadow did not persist')), 5000);
      });
      try {
        refuseCount = false;
        globalThis.fetch = fetchImpl;
        const desktopProvider = await makeJevTrialProvider({ firmId: 'f', clientId: 'c',
          resourceType: 'document', resourceId: 'desktop-doc', decisionKind: 'coding',
          snapshot: desktopSnapshot, env: desktopEnv, provider: async () => providerResult,
          withClient: async fn => { const result = await withClient(fn); if (result?.run_id) finish(result); return result; } });
        const desktopResult = await desktopProvider({ ...observation.request, model: env.TYPESAFE_MODEL });
        assert.equal(desktopResult.answers, providerResult.answers);
        assert.equal(desktopResult.jev_basis, 'desktop_default');
        await finished;
      } finally { clearTimeout(timeout); globalThis.fetch = savedFetch; }
      const desktopRun = (await pool.query("select * from model_challenger_runs where root_execution_id='desktop-doc'")).rows[0];
      assert.equal(desktopRun.outcome, 'divergence');
      assert.equal(desktopRun.divergence_summary.authority_basis, 'desktop_host_default');
      assert.equal(desktopRun.divergence_summary.sampling_fraction, 1);
      assert.equal(desktopRun.divergence_summary.reservation_id, null);
      assert.equal(desktopRun.usage.total_tokens, 220);
      const desktopOptions = { ...options, policy: { basis: 'desktop_default', deciding_model: env.TYPESAFE_MODEL }, env: desktopEnv };
      const beforeSkipped = calls.length;
      for (const override of [
        { env: { ...desktopEnv, JEV_SHADOW_SAMPLE_FRACTION: '0' } },
        { env: { ...desktopEnv, JEV_SHADOW_SAMPLE_FRACTION: 'invalid' } },
        { env: { ...desktopEnv, MODEL_CHALLENGER_CAP_TOKENS: '0' } },
        { snapshot: { MODEL_CHALLENGER: { stage: 'off' } } }
      ]) assert.equal(await dispatchJevReverseShadow({ ...desktopOptions, ...override }), null);
      assert.equal(calls.length, beforeSkipped, 'sampling, flag and cap gates precede all provider calls');
      assert.equal((await pool.query('select count(*)::int n from transactions')).rows[0].n, 0);
      assert.equal((await pool.query('select count(*)::int n from documents')).rows[0].n, 0);
      await pool.query("update firm_members set status='inactive' where id='member'");
      assert.equal(await withClient(client => readJevExperiment({ client, firmId: 'f', clientId: 'c', model: env.TYPESAFE_MODEL })), null);
    } finally {
      // pool.end() releases the clients before each socket's end event. Wait
      // for actual disconnects so teardown never kills an idle test client.
      await pool.end();
      await Promise.all(disconnected);
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  });
