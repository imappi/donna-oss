// runtimeWatchdog — the wedged-but-alive backstop (task_44a5069a). The
// rails under test are the ones that make a kill TRUSTWORTHY: N consecutive
// failures (never one blip), sleep is never counted as runtime guilt, kills
// are bounded and receipted, and probing waits for a ready runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeWatchdog, makeSocketProbe, WATCHDOG_DEFAULTS } from './runtimeWatchdog.mjs';

// Deterministic harness: manual clock, manual ticks (the interval timer is
// disabled by injecting a no-op setInterval), probes settle via a queued
// result list. Ticks advance the clock by exactly one interval, like the
// real timer — a larger jump is the SLEEP shape and is a scenario of its
// own, not a shortcut.
const harness = (overrides = {}) => {
  let clock = 1_000_000;
  const kills = [];
  const giveUps = [];
  const logs = [];
  const probes = [];
  const results = [];
  const watchdog = createRuntimeWatchdog({
    probe: () => {
      probes.push(clock);
      const next = results.shift() ?? { ok: true };
      return next.ok ? Promise.resolve({ ok: true }) : Promise.reject(new Error(next.reason || 'probe_failed'));
    },
    onKill: (receipt) => kills.push(receipt),
    onGiveUp: (receipt) => giveUps.push(receipt),
    log: (line) => logs.push(line),
    intervalMs: 1000,
    failureThreshold: 3,
    postReadyGraceMs: 0,
    resumeGraceMs: 2000,
    sleepGapFactor: 3,
    maxKillsWithoutRecovery: 2,
    healthyStreakToForgive: 2,
    now: () => clock,
    setIntervalFn: () => ({ unref: () => {} }),
    clearIntervalFn: () => {},
    ...overrides
  });
  watchdog.start();
  const tick = async (advanceMs = 1000) => {
    clock += advanceMs;
    watchdog.tick();
    // Let the probe promise chain settle.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { watchdog, tick, kills, giveUps, logs, probes, results };
};

test('no probes before the runtime reports ready, and none during the post-ready grace', async () => {
  const h = harness({ postReadyGraceMs: 3000 });
  await h.tick();
  await h.tick();
  assert.equal(h.probes.length, 0, 'not ready → no probes');
  h.watchdog.runtimeReady();
  await h.tick();
  await h.tick();
  assert.equal(h.probes.length, 0, 'grace window → no probes');
  await h.tick(); // t+3000 = grace boundary passed
  assert.equal(h.probes.length, 1, 'probing begins after the grace');
});

test('N consecutive failures kill with a receipt; probing then waits for the next ready', async () => {
  const h = harness();
  h.watchdog.runtimeReady();
  h.results.push({ ok: false, reason: 'probe_timeout' }, { ok: false, reason: 'transport_ECONNREFUSED' }, { ok: false, reason: 'http_503:db_timeout' });
  await h.tick();
  await h.tick();
  assert.equal(h.kills.length, 0, 'below threshold → no kill');
  await h.tick();
  assert.equal(h.kills.length, 1, 'threshold reached → kill');
  assert.equal(h.kills[0].consecutive_failures, 3);
  assert.equal(h.kills[0].kill_number, 1);
  assert.deepEqual(h.kills[0].reasons, ['probe_timeout', 'transport_ECONNREFUSED', 'http_503:db_timeout']);
  const probesAtKill = h.probes.length;
  await h.tick();
  await h.tick();
  assert.equal(h.probes.length, probesAtKill, 'after a kill, probing pauses until runtimeReady');
});

test('a success resets the failure streak', async () => {
  const h = harness();
  h.watchdog.runtimeReady();
  h.results.push({ ok: false }, { ok: false }, { ok: true }, { ok: false }, { ok: false });
  for (let i = 0; i < 5; i += 1) await h.tick();
  assert.equal(h.kills.length, 0, 'streak broken by a success never kills');
  assert.equal(h.watchdog.state().failures, 2);
});

test('a large tick gap (sleep) forgives the streak instead of killing', async () => {
  const h = harness();
  h.watchdog.runtimeReady();
  h.results.push({ ok: false }, { ok: false });
  await h.tick();
  await h.tick();
  assert.equal(h.watchdog.state().failures, 2);
  await h.tick(60_000); // the Mac slept — the timer arrives a minute late
  assert.equal(h.watchdog.state().failures, 0, 'gap resets the streak');
  assert.equal(h.kills.length, 0);
  const probed = h.probes.length;
  await h.tick(); // inside the post-gap grace → no probe
  assert.equal(h.probes.length, probed);
  await h.tick();
  await h.tick(); // beyond the 2s grace
  assert.ok(h.probes.length > probed, 'probing resumes after the grace');
});

test('suspend/resume pause probing and open a grace window', async () => {
  const h = harness();
  h.watchdog.runtimeReady();
  h.watchdog.suspended();
  await h.tick();
  await h.tick();
  assert.equal(h.probes.length, 0, 'suspended → no probes');
  h.watchdog.resumed();
  await h.tick(); // inside the resume grace
  assert.equal(h.probes.length, 0);
  await h.tick(); // the 2s grace boundary passes
  assert.equal(h.probes.length, 1, 'probes again after the resume grace');
});

test('kills are bounded: at the cap the watchdog gives up loudly and disarms', async () => {
  const h = harness();
  const failNext = (n) => { for (let i = 0; i < n; i += 1) h.results.push({ ok: false, reason: 'wedged' }); };
  // Kill 1
  h.watchdog.runtimeReady();
  failNext(3);
  for (let i = 0; i < 3; i += 1) await h.tick();
  assert.equal(h.kills.length, 1);
  // Kill 2 — the restarted runtime wedges again immediately
  h.watchdog.runtimeReady();
  failNext(3);
  for (let i = 0; i < 3; i += 1) await h.tick();
  assert.equal(h.kills.length, 2);
  // Third wedge: the cap (2) is exhausted → give up, no third kill
  h.watchdog.runtimeReady();
  failNext(3);
  for (let i = 0; i < 3; i += 1) await h.tick();
  assert.equal(h.kills.length, 2, 'no kill past the cap');
  assert.equal(h.giveUps.length, 1, 'gave up loudly');
  assert.equal(h.watchdog.state().armed, false, 'disarmed for good');
  for (let i = 0; i < 3; i += 1) await h.tick();
  assert.equal(h.giveUps.length, 1, 'give-up fires once');
});

test('a healthy streak between wedges forgives the kill counter', async () => {
  const h = harness();
  h.watchdog.runtimeReady();
  for (let i = 0; i < 3; i += 1) h.results.push({ ok: false });
  for (let i = 0; i < 3; i += 1) await h.tick();
  assert.equal(h.kills.length, 1);
  h.watchdog.runtimeReady();
  h.results.push({ ok: true }, { ok: true }); // healthyStreakToForgive = 2
  await h.tick();
  await h.tick();
  assert.equal(h.watchdog.state().kills, 0, 'healthy streak resets the kill counter');
});

test('a probe that never settles is capped and counted as a failure, and never stacks', async () => {
  let clock = 1_000_000;
  const kills = [];
  let hung = 0;
  const capTimeouts = [];
  const watchdog = createRuntimeWatchdog({
    probe: () => { hung += 1; return new Promise(() => {}); },
    onKill: (receipt) => kills.push(receipt),
    log: () => {},
    intervalMs: 1000,
    failureThreshold: 2,
    postReadyGraceMs: 0,
    probeHardCapMs: 500,
    now: () => clock,
    setIntervalFn: () => ({ unref: () => {} }),
    clearIntervalFn: () => {},
    setTimeoutFn: (fn) => { capTimeouts.push(fn); return { unref: () => {} }; },
    clearTimeoutFn: () => {}
  });
  watchdog.start();
  watchdog.runtimeReady();
  clock += 1000;
  watchdog.tick();
  await new Promise((resolve) => setImmediate(resolve)); // probe() runs in a microtask
  assert.equal(hung, 1);
  clock += 1000;
  watchdog.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hung, 1, 'an in-flight probe blocks a second one');
  capTimeouts.shift()(); // the hard cap fires → failure 1
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watchdog.state().failures, 1);
  clock += 1000;
  watchdog.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hung, 2, 'probing resumes after the cap released the slot');
  capTimeouts.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills.length, 1, 'capped probes count toward the threshold');
});

test('makeSocketProbe: 200 ok resolves; 503 and timeouts reject with coded reasons', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'donna-watchdog-test-'));
  const socketPath = path.join(dir, 'api.sock');
  let mode = 'ok';
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (mode === 'hang') return; // never respond
    if (mode === 'db_down') {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, db_ok: false, reason: 'db_timeout' }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, db_ok: true, db_ms: 1, token: req.headers['x-donna-access-token'] || null }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const probe = makeSocketProbe({ socketPath, accessToken: 'tok', timeoutMs: 300 });
  const healthy = await probe();
  assert.equal(healthy.ok, true);
  assert.equal(healthy.token, 'tok', 'the access token rides the probe');

  mode = 'db_down';
  await assert.rejects(probe, /http_503:db_timeout/);

  mode = 'hang';
  await assert.rejects(probe, /probe_timeout/);

  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(probe, /transport_/, 'a dead socket rejects with a transport code');
});

test('defaults hold the shape the design promises: minutes to a kill, bounded kills', () => {
  const minutesToKill = (WATCHDOG_DEFAULTS.intervalMs * WATCHDOG_DEFAULTS.failureThreshold) / 60_000;
  assert.ok(minutesToKill >= 2, `a kill takes ≥2 minutes of continuous failure (got ${minutesToKill})`);
  assert.ok(WATCHDOG_DEFAULTS.maxKillsWithoutRecovery <= 5, 'kills are bounded');
});
