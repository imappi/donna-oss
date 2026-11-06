// RT-14 on the appliance (docs/plan-2026-09-01-runtime-refactor-slices.md §5
// RT-14; audit F-09 / F-10 / F-19; decision D5): boot the REAL desktop
// assembly on the RT-06 harness against real PostgreSQL and assert the three
// things the slice changes, as behaviour rather than as an env map:
//
//   (1) the desktop manifest is a set of FUNCTIONS — no `http-cron` kind, no
//       runtime read of vercel.json, and no cloud-only entry: not the drain
//       (parse is a local job since RT-08; the one-release backstop is gone;
//       the outbox stays scheduled — since RT-14b it requeues the local parse
//       job for a row whose register-time enqueue left none), not the env-dark
//       bank-line-auto-explain / learn-reconciliation-rules crons (deleted),
//       and not the ledger mirror sweeps on a book whose adapter is 'none';
//   (2) a scheduled parse-cron function runs IN-PROCESS: the tick makes no
//       HTTP request to the runtime's own router (node:http and global fetch
//       are both spied), and the job's result is the task runner's own
//       summary, not an HTTP status + body;
//   (3) the host-class fence: cloud-only routes (marketing, the public
//       outbound webhooks, billing, the auth-email hook, self-serve
//       provisioning, the Xero/QBO/Procountor OAuth callbacks) answer
//       404 CLOUD_ONLY_ROUTE on the desktop host, while the appliance's own
//       routes still answer.
//
// Written first and watched FAIL on the pre-RT-14 tree (http-cron entries on
// the manifest, the drain scheduled, billing answering), then made green.

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { applianceHarnessSkipReason, bootApplianceForTest } from './testSupport/applianceHarness.js';

const CLOUD_ONLY_FUNCTION_IDS = [
  'parse-cron:drain',
  'bank-line-auto-explain',
  'learn-reconciliation-rules',
  'marketing-prospects-due',
  'marketing-reply-triage'
];

const NONE_ADAPTER_FUNCTION_IDS = ['ledger-mirror-verify', 'ledger-auto-export'];

const CLOUD_ONLY_ROUTES = [
  { method: 'GET', path: '/api/donna/billing/status' },
  { method: 'POST', path: '/api/donna/billing/webhook' },
  { method: 'GET', path: '/api/donna/marketing/unsubscribe?token=x' },
  { method: 'POST', path: '/api/donna/marketing/inbound-webhook' },
  { method: 'GET', path: '/api/donna/marketing/admin/drafts' },
  { method: 'POST', path: '/api/donna/auth-email-hook' },
  { method: 'POST', path: '/api/donna/waitlist' },
  { method: 'GET', path: '/api/donna/outbound/unsubscribe?token=x' },
  { method: 'POST', path: '/api/donna/outbound/paylink-webhook' },
  { method: 'POST', path: '/api/donna/outbound/reply-webhook' },
  { method: 'POST', path: '/api/donna/firms/self-provision' },
  { method: 'POST', path: '/api/donna/firms/provision-workspace' },
  { method: 'GET', path: '/api/donna/firms/xero/callback?code=x&state=y' },
  { method: 'GET', path: '/api/donna/firms/qbo/callback?code=x&state=y' },
  { method: 'GET', path: '/api/donna/firms/procountor/callback?code=x&state=y' }
];

// Spy on every way this process could dial its own router during a tick.
const spyOnSelfCalls = ({ socketPath, port }) => {
  const selfCalls = [];
  const originalRequest = http.request;
  const originalFetch = globalThis.fetch;
  const isSelf = (target) => {
    if (!target) return false;
    if (typeof target === 'string') {
      return target.includes('local-runtime') || target.includes(`127.0.0.1:${port}`) || target.includes(`localhost:${port}`);
    }
    if (target instanceof URL) return isSelf(target.toString());
    if (typeof target === 'object') {
      if (socketPath && target.socketPath === socketPath) return true;
      if (port && Number(target.port) === Number(port)) return true;
    }
    return false;
  };
  http.request = function spiedRequest(...args) {
    const target = args[0];
    if (isSelf(target) || (typeof target === 'string' && isSelf(args[1]))) selfCalls.push({ via: 'http.request', target });
    return originalRequest.apply(this, args);
  };
  globalThis.fetch = function spiedFetch(input, init) {
    const target = typeof input === 'string' ? input : input?.url || String(input);
    if (isSelf(target)) selfCalls.push({ via: 'fetch', target });
    return originalFetch.call(this, input, init);
  };
  return {
    selfCalls,
    restore: () => {
      http.request = originalRequest;
      globalThis.fetch = originalFetch;
    }
  };
};

test(
  'real PG (appliance, RT-14): the manifest is functions with no cloud-only entry, a scheduled function runs without an HTTP hop, and cloud-only routes are not mounted on the desktop host',
  { skip: applianceHarnessSkipReason() },
  async () => {
    const appliance = await bootApplianceForTest({ now: new Date('2026-09-02T09:00:00.000Z') });
    try {
      // ── (1) the manifest ──
      const ids = appliance.manifest.map((entry) => entry.functionId);
      const kinds = new Set(appliance.manifest.map((entry) => entry.kind));
      assert.ok(!kinds.has('http-cron'), `no manifest entry self-calls the router over HTTP (kinds: ${[...kinds].join(', ')})`);
      for (const id of CLOUD_ONLY_FUNCTION_IDS) {
        assert.ok(!ids.includes(id), `${id} is cloud-only and must not be scheduled on the appliance`);
      }
      for (const id of NONE_ADAPTER_FUNCTION_IDS) {
        assert.ok(!ids.includes(id), `${id} is not scheduled while the firm's accounting adapter is 'none'`);
      }
      for (const id of ['parse-document', 'parse-cron:outbox', 'parse-cron:stuck', 'parse-cron:loops_inbox', 'parse-cron:coding_convergence', 'bank-line-disposition', 'document-terminal-drain']) {
        assert.ok(ids.includes(id), `${id} stays scheduled: ${JSON.stringify(ids)}`);
      }
      for (const entry of appliance.manifest) {
        assert.equal(typeof entry.run, 'function', `${entry.functionId}: a callable handler closure`);
      }
      assert.equal(appliance.runtime.schedulerRunning(), true, 'Host A admitted the scheduler over the function manifest');
      const host = await appliance.read.host();
      assert.equal(host?.status, 'PASS', JSON.stringify(host?.certificate?.checks?.map(({ id, status }) => [id, status])));

      // ── (2) a scheduled function runs in-process ──
      const spy = spyOnSelfCalls({ socketPath: appliance.socketPath, port: appliance.port });
      let receipt;
      try {
        receipt = await appliance.tick({ functions: ['parse-cron:stuck'] });
      } finally {
        spy.restore();
      }
      const stuck = receipt.jobs.find((job) => job.function_id === 'parse-cron:stuck');
      assert.ok(stuck, `the stuck sweep ticked: ${JSON.stringify(receipt.jobs.map((job) => [job.function_id, job.status]))}`);
      assert.equal(stuck.status, 'succeeded', stuck.last_error);
      assert.deepEqual(spy.selfCalls, [], 'the tick dialled the runtime\'s own router — the manifest still self-calls over HTTP');
      assert.ok(stuck.result && typeof stuck.result === 'object', 'the job result is the task runner\'s summary');
      assert.ok('stuck' in stuck.result, `the summary carries the task's own key: ${JSON.stringify(stuck.result)}`);
      assert.ok(!('body' in stuck.result) && !('status' in stuck.result), 'no HTTP status/body in the job result — the runner was called directly');

      // ── (3) the host-class fence ──
      for (const { method, path } of CLOUD_ONLY_ROUTES) {
        const response = await appliance.api.request({ method, path, auth: true, body: method === 'POST' ? {} : undefined });
        assert.equal(response.status, 404, `${method} ${path} → ${response.status} ${response.text?.slice(0, 200)}`);
        assert.equal(response.json?.code, 'CLOUD_ONLY_ROUTE', `${method} ${path}: the fence names itself: ${response.text?.slice(0, 200)}`);
      }
      const health = await appliance.api.health();
      assert.equal(health.status, 200, 'the appliance\'s own routes still answer');
      assert.equal(health.json.database_configured, true);
      const snapshot = await appliance.api.request({ path: '/api/donna/firms/snapshot', auth: true });
      assert.equal(snapshot.status, 200, `the firm snapshot answers on the desktop host: ${snapshot.text?.slice(0, 200)}`);
    } finally {
      await appliance.stop();
    }
  }
);
