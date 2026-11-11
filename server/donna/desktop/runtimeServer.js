// The desktop runtime assembly (plan §1's "Donna runtime" box): the EXISTING
// router mounted on a local HTTP server plus the local durable scheduler over
// the desktop handler manifest. Shared by scripts/desktop-boot.mjs (headless,
// loopback TCP) and desktop/runtime.mjs (the Electron utility process,
// private Unix socket — no TCP anywhere once inside the shell).
//
// The manifest is FUNCTIONS (RT-14): every scheduled entry calls its handler
// in-process, so the scheduler never dials the router it shares a process
// with — no socket-capable fetch shim, no access token in a job, no
// vercel.json read. The router serves the SPA and the operator; the
// scheduler runs the handlers directly.

import http from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';

import { applyDesktopHostRuntimeDefaults } from './hostRuntimeDefaults.js';
import { buildModelLaneReceipt } from './capabilityReceipt.js';
import { applyProviderKeyDotEnvDefaults } from './providerKeyDotEnv.js';
import {
  applyDesktopBuildIdentityDefaults,
  DESKTOP_REPO_ROOT
} from './buildIdentity.js';

// `providerKeyFiles`: the files the provider-key bridge reads (default
// providerKeyDotEnv.js defaultDotEnvFiles). The zero-key demo passes [] so
// nothing on the machine fills a key or a model id (scripts/demo_fi.mjs).
export const applyDesktopRuntimeEnvDefaults = ({ dataDir, providerKeyFiles } = {}) => {
  if (!process.env.DONNA_DESKTOP_BLOB_DIR && dataDir) {
    process.env.DONNA_DESKTOP_BLOB_DIR = `${dataDir}/documents`;
  }
  // Provider keys from the repo's .env.local/.env, only where unset (a
  // set-but-blank var counts as unset) — the desktop chain never went
  // through server/index.js's loadEnv, so a key added to .env (the
  // documented cloud mechanism) silently never reached the runtime
  // (providerKeyDotEnv.js). Must land before the host defaults and the
  // model-lane receipt so both see the final key state. Key NAMES are
  // logged, never values.
  const dotEnv = applyProviderKeyDotEnvDefaults(process.env, providerKeyFiles ? { files: providerKeyFiles } : {});
  if (dotEnv.applied.length) {
    console.log(`[runtime-server] provider keys loaded from repo .env: ${dotEnv.applied.join(', ')}`);
  }
  if (dotEnv.overrodeBlank.length) {
    console.log(`[runtime-server] set but empty in the environment, filled from repo .env: ${dotEnv.overrodeBlank.join(', ')}`);
  }
  // The appliance runtime posture (design-donna-desktop-runtime-on.md S1):
  // runtime-ON env defaults, only where unset — launch-line values,
  // including explicit 'false', always win.
  const { applied } = applyDesktopHostRuntimeDefaults(process.env);
  if (applied.length) {
    console.log(`[runtime-server] desktop runtime defaults applied: ${applied.join(', ')}`);
  }
  // The model-lane receipt: which LLM lanes are lit/dark on THIS boot, and
  // why. Every consumer fails soft on a missing key, so this line is the only
  // place a provisioning gap announces itself (capabilityReceipt.js).
  console.log(`[runtime-server] ${buildModelLaneReceipt(process.env).line}`);
};

// Assembles router + scheduler. `listen` is either { host, port } (headless
// harness) or { socketPath } (Electron shell). The returned schedulerRunning
// accessor reports Host-A-gated state; stop() drains it before closing.
export const createDonnaRuntimeServer = async ({ listen, logger = console, providerKeyFiles } = {}) => {
  if (!listen || (!listen.socketPath && !listen.port)) {
    throw new Error('createDonnaRuntimeServer needs listen.socketPath or listen.port');
  }

  // The appliance's runtime-ON posture (S1) applies HERE, in the assembly
  // both launch paths (scripts/desktop-boot.mjs headless, desktop/runtime.mjs
  // in the Electron shell) funnel through — leaving the call to the callers
  // meant neither made it, so every appliance boot ran with the extractor and
  // matcher waves off and supplier bills skipped as extractor_unavailable
  // (the 2026-08-04 Honeybee rebuild). Only-where-unset: launch-line values,
  // including an explicit 'false', still win. dataDir/apiBaseUrl are omitted
  // on purpose — the blob-dir and base-url halves stay with the callers that
  // know them; this call must land before the dynamic imports below so env
  // is final before any config-reading module loads.
  applyDesktopRuntimeEnvDefaults({ providerKeyFiles });
  applyDesktopBuildIdentityDefaults(process.env, { rootDir: DESKTOP_REPO_ROOT });

  // Imported dynamically so callers can finalize env (DATABASE_URL, blob
  // dir, tokens) before any config-reading module loads.
  const { handleDonnaApiRequest } = await import('../api.js');
  const { buildDesktopHandlerManifest } = await import('./handlerManifest.js');
  const { createLocalScheduler } = await import('./localScheduler.js');
  const { queryFirmDb, withFirmDbClient, adoptResolvedDefaultFirmId, seedPackPaletteChartWithClient } = await import('../firmDb.js');
  const {
    buildHostOperationalFailureCertificate,
    healTargetedEntityReadiness,
    hostReadinessAllowsSchedulerRecovery,
    hostReadinessIsMutationReady,
    makePromptDueEntityHeal,
    mintAndPersistHostReadiness,
    persistHostReadinessAttempt,
    startHostReadinessRenewal
  } = await import('../runtimeReadiness.js');

  // Gate 3 — the appliance's firm is the SOLE firms row, not the baked-in
  // demo id (firmDb loads before the book can be read, so it defaults to
  // 'donna-demo-firm'; a Gate 3-minted firm carries a real id and every
  // firm_id-defaulting route would silently miss it). Resolve once per
  // boot; the first-run mint route re-points mid-session for the virgin
  // case. Exactly-one only — a multi-firm box (not a supported v1 state)
  // must never guess. Best-effort but loud, same posture as the plane seed.
  try {
    const soleFirm = await queryFirmDb('select id from firms limit 2');
    if (soleFirm.rows.length === 1) {
      adoptResolvedDefaultFirmId(soleFirm.rows[0].id, { reason: 'desktop_boot_sole_firm', logger });
    } else if (soleFirm.rows.length === 0) {
      logger.log?.('[runtime-server] no firm on this book yet — first-run onboarding will mint it');
    }
  } catch (error) {
    logger.error?.('[runtime-server] sole-firm default resolution FAILED:', error?.message || error);
  }

  // S2 boot backfill (design-donna-desktop-runtime-on.md Phase 2): seed
  // missing plane rows + firm metadata for clients that predate S2 or whose
  // creation-time seed was rolled back. Runs BEFORE the server listens and
  // the scheduler starts so the first tick already sees the rows.
  // Best-effort but LOUD: after S2 the extractor wave has no env fallback,
  // so a silently-failed backfill would be findings §4b-v reborn.
  try {
    const { backfillDesktopRuntimePlane } = await import('./hostPlaneSeed.js');
    await backfillDesktopRuntimePlane({
      withFirmDbClientFn: withFirmDbClient,
      logger,
      seedChartFn: seedPackPaletteChartWithClient
    });
  } catch (error) {
    logger.error?.(
      '[runtime-server] desktop plane seed FAILED — extraction/coding may rest OFF for pre-existing clients until it succeeds:',
      error?.message || error
    );
  }

  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/donna/')) {
      // Duration log per API request — the §4b-iii diagnostic needs to tell
      // "the handler was slow" apart from "the request reached us late"
      // (shell proxy / renderer side). Local single-user server: logging
      // every request is signal, not noise.
      const startedAt = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        logger.log?.(
          `[runtime-server] ${req.method} ${(req.url || '').split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`
        );
      });
      handleDonnaApiRequest(req, res);
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found.' }));
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    if (listen.socketPath) {
      // A stale socket file from a crashed run blocks bind; the single
      // supervising parent makes removing it safe.
      if (existsSync(listen.socketPath)) unlinkSync(listen.socketPath);
      server.listen({ path: listen.socketPath }, resolve);
    } else {
      server.listen(listen.port, listen.host || '127.0.0.1', resolve);
    }
  });

  // The ledger mirror sweeps (ledger-mirror-verify / ledger-auto-export) are
  // scheduled only when a client on this book has chosen an accounting
  // adapter (audit F-19): on a Donna-ledger book their tick was a receipted
  // skip, every night. Read once at boot; connecting Xero/QBO later schedules
  // them on the next boot (the scheduler retires the cursors when the book
  // goes back to 'none'). A failed read schedules them — the sweeps' own
  // per-client skip still governs, and a boot never hides work on a guess.
  let ledgerAdapterConnected = true;
  try {
    const adapters = await queryFirmDb(
      `select exists(
         select 1 from clients
          where status <> 'deleted'
            and lower(coalesce(profile->>'accounting_system', 'none')) <> 'none'
       ) as connected`
    );
    ledgerAdapterConnected = Boolean(adapters.rows?.[0]?.connected);
    if (!ledgerAdapterConnected) {
      logger.log?.('[runtime-server] no client on this book has an accounting adapter — the ledger mirror sweeps are not scheduled');
    }
  } catch (error) {
    logger.error?.('[runtime-server] accounting-adapter read failed; scheduling the ledger mirror sweeps anyway:', error?.message || error);
  }
  const manifest = buildDesktopHandlerManifest({ ledgerAdapterConnected });
  // DONNA_DESKTOP_SCHEDULER=off is a diagnostic kill switch (env may KILL a
  // behavior, never enable one): boot the router alone so interactive-route
  // latency can be measured without scheduled work in the process. Findings
  // §4b-iii is the consumer. Anything else (unset included) means on.
  const schedulerDisabled = /^(off|0|false)$/i.test(process.env.DONNA_DESKTOP_SCHEDULER || '');
  let scheduler = null;
  let schedulerRunning = false;
  let schedulerRecoveryMode = false;
  let hostReadiness = null;
  // Normal-mode counterpart to queue recovery below: a saga the fence just
  // invalidated (e.g. an admitted posting minting a chart account) has an
  // immediately-due retry — run the bounded targeted heal now instead of
  // starving the rest of the pass until the next 5-minute renewal (the
  // Desert Rose flap; see makePromptDueEntityHeal's header).
  const promptDueEntityHeal = makePromptDueEntityHeal({ withFirmDbClientFn: withFirmDbClient, logger });
  const renewReadinessAfterQueueActivity = async (activity) => {
    if (!schedulerRecoveryMode || !hostReadiness?.renewNow) {
      return promptDueEntityHeal(activity);
    }
    logger.log?.(
      `[runtime-server] Host A queue recovery activity (${activity?.kind || 'unknown'}) — re-observing readiness now`
    );
    // renewNow serializes observations and coalesces an event that arrives
    // while a prior retry is still in flight. Do not drop the later event:
    // it may be the successor settlement that finally supersedes the dead job.
    return hostReadiness.renewNow();
  };
  if (schedulerDisabled) {
    logger.log?.(
      `[runtime-server] scheduler DISABLED (DONNA_DESKTOP_SCHEDULER=off) — diagnostic mode, ${manifest.length} handlers will NOT run`
    );
  } else {
    scheduler = createLocalScheduler({
      manifest,
      logger,
      client: { query: (text, params) => queryFirmDb(text, params) },
      onQueueActivity: renewReadinessAfterQueueActivity,
      // This assembly declares the WHOLE manifest, so it also retires what a
      // previous build declared and this one does not (cron cursors and
      // pending jobs for a function that no longer exists — RT-14 deleted
      // several). Host A compares the cursors against the manifest; a stale
      // cursor would fail the certificate on every boot after an upgrade.
      retireUndeclaredFunctions: true
    });
  }

  hostReadiness = await startHostReadinessRenewal({
    logger,
    mint: async ({ eventType }) => {
      if (scheduler && !schedulerRunning) {
        // Host A compares the persisted cron manifest before any work may
        // run. Initialize only recoverable cursors; failure is observed by
        // the certificate and never takes the already-listening router down.
        await scheduler.initialize().catch((error) => {
          logger.error?.('[runtime-server] scheduler manifest initialization failed:', error?.message || error);
        });
      }
      return mintAndPersistHostReadiness({
        withFirmDbClientFn: withFirmDbClient,
        eventType,
        env: process.env,
        rootDir: DESKTOP_REPO_ROOT,
        manifest,
        schedulerEnabled: !schedulerDisabled,
        query: (text, params) => queryFirmDb(text, params)
      });
    },
    onObservation: async (observation) => {
      const ready = hostReadinessIsMutationReady({
        certificate: observation?.certificate,
        asOf: new Date().toISOString()
      });
      const schedulerRecoveryAllowed = hostReadinessAllowsSchedulerRecovery({
        certificate: observation?.certificate,
        asOf: new Date().toISOString()
      });
      schedulerRecoveryMode = !ready && schedulerRecoveryAllowed;
      if (ready) {
        // Gate 1B.3 recovery stays bounded to exact manual legacy canaries and
        // due failed sagas from the source-controlled new-client enrollment.
        // Defaults without a failed saga and unselected legacy entities never
        // enter the pool.
        await healTargetedEntityReadiness({
          withFirmDbClientFn: withFirmDbClient,
          observedAt: observation?.certificate?.observed_at || new Date().toISOString(),
          rootDir: DESKTOP_REPO_ROOT,
          logger
        }).catch((error) => {
          logger.error?.('[runtime-server] targeted entity readiness recovery scan failed:', error?.message || error);
        });
      }
      if ((ready || schedulerRecoveryAllowed) && scheduler && !schedulerRunning) {
        try {
          await scheduler.start();
          schedulerRunning = true;
          logger.log?.(
            ready
              ? `[runtime-server] Host A PASS — scheduler admitted (${manifest.length} handlers)`
              : `[runtime-server] Host A queue recovery — scheduler admitted (${manifest.length} handlers); new mutations remain blocked`
          );
        } catch (error) {
          schedulerRunning = false;
          const failedCertificate = buildHostOperationalFailureCertificate({
            certificate: observation.certificate,
            checkId: 'scheduler_process_start',
            reasonCode: 'scheduler_start_failed'
          });
          await persistHostReadinessAttempt({
            withFirmDbClientFn: withFirmDbClient,
            certificate: failedCertificate,
            eventType: 'retry'
          });
          logger.error?.('[runtime-server] scheduler start failed; Host A marked failed and router remains available:', error?.message || error);
        }
      } else if (!ready && !schedulerRecoveryAllowed && scheduler && schedulerRunning) {
        await scheduler.stop();
        schedulerRunning = false;
        logger.error?.('[runtime-server] Host A is not current/PASS — scheduler paused; router remains available');
      } else if (schedulerRecoveryAllowed && scheduler && schedulerRunning) {
        logger.log?.('[runtime-server] Host A queue recovery remains active; new mutations remain blocked');
      } else if (!ready) {
        logger.error?.('[runtime-server] Host A is not current/PASS — scheduler remains off; router remains available');
      }
    }
  });
  logger.log?.(
    `[runtime-server] router on ${listen.socketPath || `http://${listen.host || '127.0.0.1'}:${listen.port}`}; scheduler ${schedulerRunning ? `running ${manifest.length} handlers` : 'off'}`
  );

  const stop = async () => {
    hostReadiness.stop();
    if (scheduler && schedulerRunning) await scheduler.stop();
    await new Promise((resolve) => server.close(resolve));
  };

  return { server, scheduler, schedulerRunning: () => schedulerRunning, hostReadiness, manifest, stop };
};
