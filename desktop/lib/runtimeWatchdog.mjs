// Runtime liveness watchdog (task_44a5069a, queued by the 2026-08-31 EPIPE
// incident): main supervises runtime EXITS only, so a wedged-but-alive
// runtime — the pool-starved deadlock class, a permanently hung scheduler
// tick, a frozen readiness-renewal loop — used to sit behind a working
// window forever, with every periodic worker silently dead. This module is
// the main-process-side backstop: probe the runtime's own liveness route
// over its private socket, and after N CONSECUTIVE failures kill the child
// into the EXISTING exit-handler restart path (backoff and all).
//
// Design rails, each earned:
// - Sleep is not a wedge. A Mac waking from sleep must not eat a kill:
//   powerMonitor suspend/resume hooks pause probing, and a belt-and-braces
//   monotonic gap check (the tick timer arriving far later than its
//   interval means the machine slept or the shell was frozen — either way,
//   not the runtime's fault) resets the failure streak and opens a grace
//   window instead of counting stale failures.
// - Busy is not a wedge either. The threshold is minutes of CONTINUOUS
//   unresponsiveness (interval × failures), not one slow reply; a probe
//   in flight blocks the next tick from stacking a second one.
// - Bounded, never a kill loop. Kills without an intervening healthy
//   streak are counted; at the cap the watchdog GIVES UP LOUDLY and leaves
//   the runtime for diagnosis — restart-looping a persistent wedge just
//   buries the evidence (the cold-start giveup in main.mjs, same lesson).
// - Receipted. Every kill hands the caller a receipt (when, streak, the
//   failure reasons that built it) — main logs it and persists it; a kill
//   whose "why" evaporates with the console is not supervision.
//
// Pure logic + node:http; no Electron imports (testable like apiProxy).

import http from 'node:http';

export const WATCHDOG_DEFAULTS = Object.freeze({
  intervalMs: 20_000,
  failureThreshold: 9, // × intervalMs = ~3 minutes of continuous failure
  probeHardCapMs: 30_000,
  postReadyGraceMs: 90_000,
  resumeGraceMs: 45_000,
  sleepGapFactor: 3,
  maxKillsWithoutRecovery: 3,
  healthyStreakToForgive: 3
});

// Probe the runtime's token-gated liveness route over its unix socket.
// Resolves on a 200 whose body reports ok; rejects with a coded reason
// otherwise — the codes end up verbatim in the kill receipt.
export const makeSocketProbe = ({
  socketPath,
  accessToken,
  timeoutMs = 10_000,
  probePath = '/api/donna/firms/runtime-liveness',
  httpImpl = http
} = {}) => () =>
  new Promise((resolve, reject) => {
    const request = httpImpl.request(
      {
        socketPath,
        method: 'GET',
        path: probePath,
        headers: accessToken ? { 'X-Donna-Access-Token': accessToken } : {}
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            let reason = `http_${response.statusCode}`;
            try {
              const parsed = JSON.parse(body);
              if (parsed?.reason) reason = `${reason}:${parsed.reason}`;
            } catch { /* body is part of the receipt only when parseable */ }
            reject(new Error(reason));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (parsed?.ok === true) resolve(parsed);
            else reject(new Error('liveness_body_not_ok'));
          } catch {
            reject(new Error('liveness_body_unparseable'));
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('probe_timeout')));
    request.on('error', (error) =>
      reject(error?.message === 'probe_timeout' ? error : new Error(`transport_${error?.code || error?.message || 'error'}`))
    );
    request.end();
  });

export const createRuntimeWatchdog = ({
  probe,
  onKill,
  onGiveUp = () => {},
  log = () => {},
  intervalMs = WATCHDOG_DEFAULTS.intervalMs,
  failureThreshold = WATCHDOG_DEFAULTS.failureThreshold,
  probeHardCapMs = WATCHDOG_DEFAULTS.probeHardCapMs,
  postReadyGraceMs = WATCHDOG_DEFAULTS.postReadyGraceMs,
  resumeGraceMs = WATCHDOG_DEFAULTS.resumeGraceMs,
  sleepGapFactor = WATCHDOG_DEFAULTS.sleepGapFactor,
  maxKillsWithoutRecovery = WATCHDOG_DEFAULTS.maxKillsWithoutRecovery,
  healthyStreakToForgive = WATCHDOG_DEFAULTS.healthyStreakToForgive,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) => {
  if (typeof probe !== 'function') throw new Error('createRuntimeWatchdog needs a probe function');
  if (typeof onKill !== 'function') throw new Error('createRuntimeWatchdog needs an onKill handler');

  const state = {
    armed: false, // start() flips on; giveUp/stop() flip off for good
    ready: false, // probing only between runtimeReady() and runtimeGone()
    suspended: false,
    failures: 0,
    failureReasons: [], // last N coded reasons, oldest first
    healthyProbes: 0,
    kills: 0, // consecutive kills with no healthy streak between them
    graceUntil: 0,
    lastTickAt: 0,
    probeInFlight: false,
    probeToken: 0
  };
  let timer = null;

  const receipt = () => ({
    at: new Date(now()).toISOString(),
    consecutive_failures: state.failures,
    kill_number: state.kills,
    reasons: [...state.failureReasons]
  });

  const recordFailure = (reason) => {
    state.failures += 1;
    state.healthyProbes = 0;
    state.failureReasons.push(String(reason).slice(0, 200));
    if (state.failureReasons.length > 12) state.failureReasons.shift();
    log(`watchdog: probe failure ${state.failures}/${failureThreshold} (${reason})`);
    if (state.failures < failureThreshold) return;
    if (state.kills >= maxKillsWithoutRecovery) {
      state.armed = false;
      const final = receipt();
      log('watchdog: GIVING UP — runtime is unresponsive again after '
        + `${state.kills} watchdog restarts with no healthy period between them; `
        + 'leaving it running for diagnosis (relaunch Donna to reset)');
      onGiveUp(final);
      return;
    }
    state.kills += 1;
    const killReceipt = receipt();
    // Probing pauses until the restarted runtime reports ready again; the
    // failure streak restarts from zero against the new process.
    state.ready = false;
    state.failures = 0;
    state.failureReasons = [];
    log(`watchdog: killing runtime — ${killReceipt.consecutive_failures} consecutive probe failures `
      + `over ~${Math.round((killReceipt.consecutive_failures * intervalMs) / 1000)}s `
      + `(kill ${killReceipt.kill_number}/${maxKillsWithoutRecovery}; reasons: ${killReceipt.reasons.join(', ')})`);
    onKill(killReceipt);
  };

  const runProbe = () => {
    state.probeInFlight = true;
    state.probeToken += 1;
    const token = state.probeToken;
    let capTimer = null;
    const capped = new Promise((_, reject) => {
      capTimer = setTimeoutFn(() => reject(new Error('probe_hard_cap')), probeHardCapMs);
      if (typeof capTimer?.unref === 'function') capTimer.unref();
    });
    Promise.race([Promise.resolve().then(() => probe()), capped])
      .then(() => {
        if (token !== state.probeToken || !state.armed || !state.ready) return;
        state.failures = 0;
        state.failureReasons = [];
        state.healthyProbes += 1;
        if (state.kills > 0 && state.healthyProbes >= healthyStreakToForgive) {
          log(`watchdog: runtime healthy for ${state.healthyProbes} probes — kill counter reset`);
          state.kills = 0;
        }
      })
      .catch((error) => {
        if (token !== state.probeToken || !state.armed || !state.ready) return;
        recordFailure(error?.message || error);
      })
      .finally(() => {
        if (capTimer != null) clearTimeoutFn(capTimer);
        if (token === state.probeToken) state.probeInFlight = false;
      });
  };

  const tick = () => {
    const at = now();
    const previousTickAt = state.lastTickAt;
    state.lastTickAt = at;
    if (!state.armed || !state.ready || state.suspended) return;
    if (previousTickAt && at - previousTickAt > intervalMs * sleepGapFactor) {
      // The interval timer arrived way late: the machine slept without a
      // suspend event, or the shell itself was frozen. Neither is runtime
      // guilt — forgive the streak and give the runtime a grace window.
      log(`watchdog: tick gap ${Math.round((at - previousTickAt) / 1000)}s (slept?) — failure streak reset`);
      state.failures = 0;
      state.failureReasons = [];
      state.probeToken += 1; // orphan any probe stranded across the gap
      state.probeInFlight = false;
      state.graceUntil = at + resumeGraceMs;
      return;
    }
    if (at < state.graceUntil) return;
    if (state.probeInFlight) return;
    runProbe();
  };

  return {
    start: () => {
      if (timer) return;
      state.armed = true;
      state.lastTickAt = now();
      timer = setIntervalFn(tick, intervalMs);
      if (typeof timer?.unref === 'function') timer.unref();
    },
    stop: () => {
      state.armed = false;
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
    runtimeReady: () => {
      state.ready = true;
      state.failures = 0;
      state.failureReasons = [];
      state.healthyProbes = 0;
      state.probeToken += 1;
      state.probeInFlight = false;
      state.graceUntil = now() + postReadyGraceMs;
    },
    runtimeGone: () => {
      state.ready = false;
      state.failures = 0;
      state.failureReasons = [];
      state.probeToken += 1;
      state.probeInFlight = false;
    },
    suspended: () => {
      state.suspended = true;
      state.failures = 0;
      state.failureReasons = [];
      state.probeToken += 1;
      state.probeInFlight = false;
    },
    resumed: () => {
      state.suspended = false;
      state.graceUntil = now() + resumeGraceMs;
      state.lastTickAt = now();
    },
    tick, // exposed for tests; production ticks ride the interval timer
    state: () => ({
      armed: state.armed,
      ready: state.ready,
      suspended: state.suspended,
      failures: state.failures,
      kills: state.kills,
      healthy_probes: state.healthyProbes
    })
  };
};
