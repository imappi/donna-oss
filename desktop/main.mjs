// Donna Desktop — the thin Electron main process (technical plan §1).
// Main supervises; it does not execute Donna: single-instance lock → start
// PG → migrate → launch the runtime in a utilityProcess (restart with
// backoff) → serve the SPA from donna://app and proxy /api/* to the
// runtime's private Unix socket with the access token attached HERE — no
// runtime bearer token ever reaches the renderer.
//
// v0 dev-shell scope (deliberate, per the M0/M1 ladder): no packaging,
// signing, auto-update, backups surface, or menu-bar residency yet — those
// are M0b/M1/M2 slices. The §1 renderer hardening flags are all present
// from day one because retrofitting them is how they get skipped.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain, powerMonitor, protocol, safeStorage, screen, session, shell, utilityProcess } from 'electron';

import { resolveStaticFile } from './lib/staticFiles.mjs';
import { createRuntimeWatchdog, makeSocketProbe } from './lib/runtimeWatchdog.mjs';
import { proxyToRuntime } from './lib/apiProxy.mjs';
import { createPortalPreviewServer } from './lib/portalPreview.mjs';
import { LOG_FILE_NAME, createFileLog } from './lib/fileLog.mjs';
import { writeMcpEndpointFile, removeMcpEndpointFile } from './lib/mcpEndpointFile.mjs';
import { ensureLocalPostgres } from '../server/donna/desktop/pgSupervisor.js';
import {
  applyProviderKeysToEnv,
  decryptStoredProviderKeys,
  describeProviderKeyStatus,
  emptyProviderKeyFile,
  normalizeProviderKeyInput,
  providerKeySpec,
  putProviderKey,
  readProviderKeyFile,
  removeProviderKey,
  writeProviderKeyFile
} from '../server/donna/desktop/providerKeyStore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// How many times a runtime that has never reported ready may be restarted
// before main calls it a startup fault rather than a crash to ride out.
const MAX_COLD_RESTARTS = 3;
const REPO_ROOT = path.resolve(HERE, '..');
const DIST_ROOT = path.join(REPO_ROOT, 'dist');
const APP_ORIGIN_PATH = '/firms';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline style attributes are the app's styling idiom; Google Fonts stays
  // allowed in the v0 dev shell (self-hosting the four families is M1
  // offline polish — tracked, not forgotten).
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

app.setName('Donna');

if (!app.requestSingleInstanceLock()) {
  // A second launch focuses the first instance instead of racing it for the
  // data dir (plan §3's single-instance rule). Say so: a silent exit reads
  // as "the app started", and env vars on THIS command line (tokens, keys,
  // diagnostic flags) never reach the instance that keeps running — that
  // cost two debugging loops on the 2026-08-03 launch.
  console.log(
    '[desktop-main] another Donna instance is already running — focusing it and exiting this launch. ' +
    'Env vars on this command line do NOT apply to the running instance; quit it first (Cmd+Q) to relaunch with new settings.'
  );
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'donna',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ]);

  const state = {
    pg: null,
    runtime: null,
    runtimeRestarts: 0,
    runtimeEverReady: false,
    quitting: false,
    // Set while the runtime is being restarted on purpose (a provider-key
    // change), so the exit handler restarts it immediately instead of
    // treating the exit as a crash to back off from.
    reloadingRuntime: false,
    window: null,
    accessToken: process.env.DONNA_ACCESS_TOKEN || randomBytes(24).toString('hex'),
    socketPath: null,
    dataDir: null,
    portalPreview: null,
    watchdog: null,
    // <dataDir>/logs/desktop.log — the console, mirrored to disk (lib/fileLog.mjs).
    // A Finder-launched packaged app has no terminal; without this a tester's
    // failure report carried nothing but pg.log.
    fileLog: null
  };

  const log = (line) => console.log(`[desktop-main] ${line}`);

  // Child processes are PIPED (not inherited) so their lines pass through the
  // tee'd console and land in the log file under their own source label.
  const forwardChildOutput = (child, source) => {
    if (state.fileLog) {
      state.fileLog.forwardChild(child, { source });
      return;
    }
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  };

  const runNodeScript = (script, env) =>
    new Promise((resolve, reject) => {
      // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes
      // it a plain node for child scripts (works packaged too).
      const child = spawn(process.execPath, [script], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      forwardChildOutput(child, path.basename(script, path.extname(script)));
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${path.basename(script)} exited ${code}`))
      );
      child.on('error', reject);
    });

  const runtimeEnv = () => ({
    DATABASE_URL: state.pg.databaseUrl,
    // The appliance runtime is the ONLY client of its private local PG
    // (default max_connections 100), so the shared pool's serverless-shaped
    // default of 2 is needlessly tight here: a multi-file drop plus the
    // parse worker plus status polls all queue on two connections. Ten is
    // still tiny for local PG; a shell env override wins.
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX || '10',
    DONNA_ACCESS_TOKEN: state.accessToken,
    DONNA_RUNTIME_SOCKET: state.socketPath,
    DONNA_DESKTOP_BLOB_DIR: path.join(state.dataDir, 'documents'),
    DONNA_DESKTOP_BACKUP_DIR: path.join(state.dataDir, 'backups')
    // No signed-URL base on purpose: a local signed evidence URL is
    // origin-relative by contract (server/donna/evidenceStorage.js), so the
    // renderer (donna://app) AND the system-browser portal preview each proxy
    // it to the runtime socket. The absolute 'donna://app' base that used to
    // sit here made every file reply and evidence view in the preview fail in
    // Safari ("Load failed": an http origin cannot fetch a donna:// URL).
  });

  // ── BYO provider keys (plan §7) ───────────────────────────────────────────
  // The user's key lives in the OS keychain via safeStorage, decrypted HERE
  // and handed to the runtime child as env. It never touches PG, never the
  // renderer, never a log line — only key NAMES are logged. Storage logic
  // (validation, file shape, precedence, the status projection) lives in
  // server/donna/desktop/providerKeyStore.js so it is testable without
  // Electron; main owns only the crypto and the process lifecycle.

  const providerKeyFilePath = () => path.join(state.dataDir, 'runtime', 'provider-keys.json');

  const encryptionAvailable = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  const keyCodec = {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  };

  const loadStoredProviderKeys = () => {
    const file = readProviderKeyFile({ filePath: providerKeyFilePath() });
    if (!encryptionAvailable()) return { file, values: {}, unreadable: Object.keys(file.providers) };
    return { file, ...decryptStoredProviderKeys(file, { decrypt: keyCodec.decrypt }) };
  };

  const providerKeyStatus = () => {
    const { file, values, unreadable } = loadStoredProviderKeys();
    return describeProviderKeyStatus({
      file,
      values,
      unreadable,
      env: process.env,
      encryptionAvailable: encryptionAvailable(),
      unavailableReason: 'This machine has no OS keychain available, so Donna will not store a key.'
    });
  };

  // Shell env wins, then the keychain; the repo .env files fill what is still
  // unset inside the runtime itself (providerKeyDotEnv.js). Recomputed on
  // every fork so a restart picks up a key saved a moment ago.
  const buildRuntimeChildEnv = () => {
    const env = { ...process.env, ...runtimeEnv() };
    const { values, unreadable } = loadStoredProviderKeys();
    const { applied, overrodeBlank } = applyProviderKeysToEnv(env, values);
    if (applied.length) log(`provider keys from the keychain: ${applied.join(', ')}`);
    if (overrodeBlank.length) {
      log(`set but empty in the shell env, keychain key used instead: ${overrodeBlank.join(', ')}`);
    }
    if (unreadable.length) {
      log(
        `stored provider keys could not be decrypted on this machine (${unreadable.join(', ')}) — ` +
        're-enter them in Settings → AI runtime'
      );
    }
    return env;
  };

  const startRuntime = () =>
    new Promise((resolve, reject) => {
      const child = utilityProcess.fork(path.join(HERE, 'runtime.mjs'), [], {
        env: buildRuntimeChildEnv(),
        stdio: 'pipe',
        serviceName: 'donna-runtime'
      });
      forwardChildOutput(child, 'runtime');
      const readyTimeout = setTimeout(
        () => reject(new Error('runtime did not report ready within 60s')), 60_000
      );
      child.on('message', (message) => {
        if (message?.type === 'ready') {
          clearTimeout(readyTimeout);
          state.runtimeRestarts = 0;
          state.runtimeEverReady = true;
          state.watchdog?.runtimeReady();
          resolve();
        }
      });
      child.on('exit', (code) => {
        state.watchdog?.runtimeGone();
        if (state.quitting) return;
        if (state.reloadingRuntime) {
          // A deliberate restart (provider keys changed): straight back up,
          // no backoff, and it must not count against the cold-start budget.
          state.reloadingRuntime = false;
          log('runtime restarting to pick up the new provider keys');
          startRuntime().catch((error) => log(`runtime restart failed: ${error.message}`));
          return;
        }
        // Supervision, not diagnosis: restart with backoff and surface the
        // state. ("Donna is restarting…" as a real UI is an M1 slice; the
        // SPA meanwhile sees 503 RUNTIME_UNAVAILABLE from the proxy.)
        state.runtimeRestarts += 1;
        // A runtime that has NEVER reported ready is a startup fault, not a
        // crash to ride out — retrying a bad config forever just buries the
        // stack trace under a restart loop behind an empty window (the first
        // real-Mac launch did exactly this). Give up loudly instead.
        if (!state.runtimeEverReady && state.runtimeRestarts >= MAX_COLD_RESTARTS) {
          clearTimeout(readyTimeout);
          log(
            `runtime exited (${code}) ${state.runtimeRestarts}× without ever starting — ` +
            'giving up. The error above this line is the real one.'
          );
          reject(new Error(`runtime failed to start (exit ${code})`));
          return;
        }
        const delay = Math.min(15_000, 1000 * 2 ** state.runtimeRestarts);
        log(`runtime exited (${code}); restarting in ${delay}ms`);
        setTimeout(() => {
          startRuntime().catch((error) => log(`runtime restart failed: ${error.message}`));
        }, delay);
      });
      state.runtime = child;
    });

  const reloadRuntimeForKeys = () => {
    if (!state.runtime) {
      startRuntime().catch((error) => log(`runtime start failed: ${error.message}`));
      return;
    }
    state.reloadingRuntime = true;
    state.runtime.kill();
  };

  // ── Runtime liveness watchdog (task_44a5069a) ─────────────────────────────
  // The exit handler above rides out CRASHES; this rides out the WEDGE —
  // the pool-starved EPIPE-class deadlock (PR #1921) where the process stays
  // alive behind a working window while every request and periodic worker
  // starves. Main probes the runtime's own /runtime-liveness route over the
  // private socket; N consecutive failures kill the child INTO the existing
  // exit-handler restart path. Sleep-aware (powerMonitor + tick-gap guard),
  // bounded (gives up loudly rather than restart-looping a persistent
  // wedge), and every kill is receipted to a file that outlives the console.
  // DONNA_DESKTOP_WATCHDOG=off is the diagnostic kill switch, same idiom as
  // DONNA_DESKTOP_SCHEDULER (env may KILL a behavior, never enable one).
  const watchdogKillReceiptPath = () => path.join(state.dataDir, 'runtime', 'watchdog-kill-receipts.json');

  const persistWatchdogKillReceipt = (receipt) => {
    try {
      let receipts = [];
      try {
        const parsed = JSON.parse(readFileSync(watchdogKillReceiptPath(), 'utf8'));
        if (Array.isArray(parsed)) receipts = parsed;
      } catch { /* first receipt, or an unreadable file we replace */ }
      receipts.push(receipt);
      writeFileSync(watchdogKillReceiptPath(), JSON.stringify(receipts.slice(-20), null, 2));
    } catch (error) {
      log(`watchdog: kill receipt could not be persisted (${error.message}) — the log line above is the record`);
    }
  };

  const startRuntimeWatchdog = () => {
    if (/^(off|0|false)$/i.test(process.env.DONNA_DESKTOP_WATCHDOG || '')) {
      log('watchdog DISABLED (DONNA_DESKTOP_WATCHDOG=off) — a wedged runtime will NOT be auto-restarted');
      return;
    }
    const intervalMs = Number(process.env.DONNA_DESKTOP_WATCHDOG_INTERVAL_MS) || undefined;
    const failureThreshold = Number(process.env.DONNA_DESKTOP_WATCHDOG_FAILURES) || undefined;
    state.watchdog = createRuntimeWatchdog({
      probe: makeSocketProbe({
        socketPath: state.socketPath,
        accessToken: state.accessToken,
        timeoutMs: Number(process.env.DONNA_DESKTOP_WATCHDOG_TIMEOUT_MS) || undefined
      }),
      ...(intervalMs ? { intervalMs } : {}),
      ...(failureThreshold ? { failureThreshold } : {}),
      log,
      onKill: (receipt) => {
        persistWatchdogKillReceipt(receipt);
        // kill() lands in the exit handler above: restart with backoff, the
        // same path a crash takes — one restart lane, not two.
        state.runtime?.kill();
      },
      onGiveUp: (receipt) => {
        persistWatchdogKillReceipt({ ...receipt, gave_up: true });
        log('watchdog: repeated restarts did not produce a healthy runtime — see '
          + `${watchdogKillReceiptPath()} and the runtime log above for the underlying fault`);
      }
    });
    // A Mac waking from sleep must never eat a kill: pause on suspend, and
    // grace the first probes after resume (the in-module tick-gap guard
    // covers sleeps that never fire these events).
    powerMonitor.on('suspend', () => state.watchdog?.suspended());
    powerMonitor.on('resume', () => state.watchdog?.resumed());
    state.watchdog.start();
    if (state.runtimeEverReady) state.watchdog.runtimeReady();
    log('runtime liveness watchdog armed');
  };

  // Validated sender (preload.cjs's rail): only this app's own window, only
  // from the app origin. The renderer can save, clear, and read STATUS — it
  // can never read a key back out, so an XSS in the SPA cannot exfiltrate
  // one.
  const senderIsAppWindow = (event) => {
    if (!state.window || event.sender !== state.window.webContents) return false;
    let frameUrl = '';
    try {
      // Accessing senderFrame on a frame that has already gone away throws.
      frameUrl = event.senderFrame?.url || '';
    } catch {
      return false;
    }
    return !frameUrl || frameUrl.startsWith('donna://app');
  };

  const registerProviderKeyIpc = () => {
    ipcMain.handle('donna:provider-keys:status', (event) => {
      if (!senderIsAppWindow(event)) throw new Error('forbidden');
      return providerKeyStatus();
    });

    ipcMain.handle('donna:provider-keys:save', (event, payload) => {
      if (!senderIsAppWindow(event)) throw new Error('forbidden');
      if (!encryptionAvailable()) {
        // Never a plaintext fallback: refusing is the honest outcome.
        return { ok: false, error: 'This machine has no OS keychain available, so Donna will not store a key.', status: providerKeyStatus() };
      }
      const entries = [];
      for (const [providerId, raw] of Object.entries(payload || {})) {
        const spec = providerKeySpec(providerId);
        if (!spec) continue;
        if (typeof raw !== 'string' || !raw.trim()) continue; // untouched field
        const normalized = normalizeProviderKeyInput(raw);
        if (!normalized.ok) {
          return { ok: false, error: `${spec.label} key: ${normalized.reason}`, status: providerKeyStatus() };
        }
        entries.push({ spec, value: normalized.value });
      }
      if (!entries.length) {
        return { ok: false, error: 'Enter a key first.', status: providerKeyStatus() };
      }
      let file = readProviderKeyFile({ filePath: providerKeyFilePath() });
      const savedAt = new Date().toISOString();
      for (const entry of entries) {
        file = putProviderKey(file, {
          providerId: entry.spec.id,
          cipher: keyCodec.encrypt(entry.value),
          savedAt
        });
      }
      writeProviderKeyFile({ filePath: providerKeyFilePath(), file });
      log(`provider keys saved to the keychain: ${entries.map((e) => e.spec.env).join(', ')}`);
      reloadRuntimeForKeys();
      return { ok: true, restarting: true, status: providerKeyStatus() };
    });

    ipcMain.handle('donna:provider-keys:clear', (event, payload) => {
      if (!senderIsAppWindow(event)) throw new Error('forbidden');
      const providerId = payload?.provider === 'all' ? 'all' : providerKeySpec(payload?.provider)?.id;
      if (!providerId) return { ok: false, error: 'Unknown provider.', status: providerKeyStatus() };
      const file = readProviderKeyFile({ filePath: providerKeyFilePath() });
      writeProviderKeyFile({
        filePath: providerKeyFilePath(),
        file: removeProviderKey(file, providerId) || emptyProviderKeyFile()
      });
      log(`provider keys removed from the keychain: ${providerId}`);
      reloadRuntimeForKeys();
      return { ok: true, restarting: true, status: providerKeyStatus() };
    });
  };

  const registerClientPortalIpc = () => {
    ipcMain.handle('donna:client-portal:open', async (event, payload) => {
      if (!senderIsAppWindow(event)) throw new Error('forbidden');
      const clientId = String(payload?.clientId || '').trim();
      if (!clientId || clientId.length > 256) {
        return { ok: false, error: 'A valid client is required.' };
      }
      const url = state.portalPreview?.urlForClient(clientId);
      if (!url) return { ok: false, error: 'The client portal preview is unavailable.' };
      await shell.openExternal(url);
      return { ok: true };
    });
  };

  const registerProtocol = () => {
    protocol.handle('donna', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'app') {
        return new Response('Not found', { status: 404 });
      }
      if (url.pathname.startsWith('/api/')) {
        return proxyToRuntime({
          request,
          socketPath: state.socketPath,
          accessToken: state.accessToken
        });
      }
      const resolved = resolveStaticFile(DIST_ROOT, url.pathname);
      if (!resolved) return new Response('Not found', { status: 404 });
      // no-store: dist/ is rebuilt in place on this machine (npm run build),
      // and Chromium's disk cache otherwise outlives a full relaunch — a
      // cached index.html plus cached old hashed assets renders the PREVIOUS
      // build after a rebuild, which reads as "my merged UI change doesn't
      // show". Reads are local disk; caching buys nothing here.
      const headers = { 'Content-Type': resolved.contentType, 'Cache-Control': 'no-store' };
      if (resolved.contentType.startsWith('text/html')) {
        headers['Content-Security-Policy'] = CSP;
      }
      return new Response(Readable.toWeb(createReadStream(resolved.filePath)), { headers });
    });
  };

  // The window opens at the display's full work area — a fixed 1440×920
  // meant every launch started with a manual drag-to-bigger (Kari,
  // 2026-08-05; Buzz/Claude open screenwide). A manual resize then STICKS:
  // bounds save on close and restore on the next launch, clamped to the
  // current display so a changed monitor layout can't strand the window
  // off-screen.
  const windowBoundsPath = () => path.join(state.dataDir, 'runtime', 'window-bounds.json');

  const loadWindowBounds = () => {
    try {
      const saved = JSON.parse(readFileSync(windowBoundsPath(), 'utf8'));
      if (![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return null;
      const area = screen.getDisplayMatching(saved).workArea;
      const width = Math.min(saved.width, area.width);
      const height = Math.min(saved.height, area.height);
      return {
        width,
        height,
        x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
        y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height)
      };
    } catch {
      return null;
    }
  };

  const createWindow = () => {
    const bounds = loadWindowBounds() || screen.getPrimaryDisplay().workArea;
    const window = new BrowserWindow({
      ...bounds,
      title: 'Donna',
      // The native title bar is replaced by the app's own band so the window
      // reads as one surface (plan §9 look). macOS centres the traffic lights
      // in a ~28px native bar; our band is DESKTOP_TITLEBAR_HEIGHT, so the
      // lights are repositioned to sit centred in it instead of hugging the
      // top edge. Keep this number and the CSS var in styles.css in step.
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 20, y: 18 },
      // Paints before the renderer has a frame up, so a cold start no longer
      // flashes white — this is PAPER from the design tokens.
      backgroundColor: '#FBFBF8',
      webPreferences: {
        // §1 hardening — non-negotiable, present from the first dev shell.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: path.join(HERE, 'preload.cjs')
      }
    });
    window.webContents.on('will-navigate', (event, target) => {
      if (!target.startsWith('donna://app')) {
        event.preventDefault();
        if (/^https:\/\//.test(target)) shell.openExternal(target);
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    window.on('close', () => {
      try {
        writeFileSync(windowBoundsPath(), JSON.stringify(window.getBounds()));
      } catch { /* best-effort — next launch falls back to the work area */ }
    });
    window.loadURL(`donna://app${APP_ORIGIN_PATH}`);
    state.window = window;
    return window;
  };

  app.whenReady().then(async () => {
    try {
      state.dataDir = process.env.DONNA_DESKTOP_DATA_DIR || app.getPath('userData');
      mkdirSync(state.dataDir, { recursive: true });
      // First thing after the data dir exists: mirror the console to disk, so
      // every line below (bundled-PG initdb, migrations, the model-lane
      // receipt, runtime restarts) survives a Finder launch. Best-effort by
      // construction — a log that cannot open never blocks the boot.
      state.fileLog = createFileLog({ file: path.join(state.dataDir, 'logs', LOG_FILE_NAME) });
      state.fileLog.captureProcessOutput();
      log(`data dir: ${state.dataDir}`);
      log(state.fileLog.active
        ? `log file: ${state.fileLog.path}`
        : `log file NOT writable (${state.fileLog.failure}) — console only this boot`);
      log(`build: ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'dev shell'}, ${process.arch}, electron ${process.versions.electron})`);

      // Packaged app: the PG 16 payload ships in Resources/pg16 (M0b —
      // bundled from the get-go, no host-Postgres debt; staged by
      // scripts/desktop-stage-pg.mjs, carried as extraResources by
      // desktop/electron-builder.yml). The supervisor treats a set-but-
      // broken bundle as a loud packaging defect; PG_BIN stays the manual
      // override. The dev shell (unpackaged) keeps host autodetection.
      if (app.isPackaged && !process.env.DONNA_BUNDLED_PG_BIN) {
        process.env.DONNA_BUNDLED_PG_BIN = path.join(process.resourcesPath, 'pg16', 'bin');
      }

      state.pg = ensureLocalPostgres({ dataDir: state.dataDir, logger: console });
      state.socketPath = path.join(state.dataDir, 'runtime', 'sockets', 'api.sock');
      mkdirSync(path.join(state.dataDir, 'documents'), { recursive: true });

      // MCP endpoint handshake (docs/design-donna-mcp-surface.md §4): the
      // Claude Desktop MCPB shim finds the socket + per-boot token here.
      // Writing it exposes NO book data — every MCP call is still gated by
      // the per-entity MCP_ENTITY_EXPOSE consent flag and receipted.
      // Best-effort loud: a failed write disables the MCP surface for this
      // boot, never the boot itself.
      try {
        const endpointFile = writeMcpEndpointFile({
          dataDir: state.dataDir,
          socketPath: state.socketPath,
          token: state.accessToken
        });
        log(`mcp endpoint handshake at ${endpointFile}`);
      } catch (error) {
        log(`mcp endpoint handshake NOT written (MCP surface unavailable this boot): ${error.message}`);
      }

      // Pre-migration backup (plan §8 trigger): an existing book gets a
      // verified package before any schema change touches it.
      const { hasPendingMigrations, createBackupPackage } = await import(
        '../server/donna/desktop/backupPackage.js'
      );
      if (await hasPendingMigrations({
        pgBin: state.pg.pgBin,
        databaseUrl: state.pg.databaseUrl,
        migrationsDir: path.join(REPO_ROOT, 'db', 'migrations')
      })) {
        log('pending migrations — creating a pre-migration backup package…');
        await createBackupPackage({
          backupsDir: path.join(state.dataDir, 'backups'),
          blobDir: path.join(state.dataDir, 'documents'),
          pgBin: state.pg.pgBin,
          databaseUrl: state.pg.databaseUrl,
          reason: 'pre-migration',
          logger: console
        });
      }

      log('applying migrations…');
      await runNodeScript(path.join(REPO_ROOT, 'scripts', 'migrate_firm_db.js'), {
        DATABASE_URL: state.pg.databaseUrl
      });

      await startRuntime();
      startRuntimeWatchdog();
      registerProtocol();
      registerProviderKeyIpc();
      state.portalPreview = await createPortalPreviewServer({
        distRoot: DIST_ROOT,
        socketPath: state.socketPath,
        accessToken: state.accessToken,
        contentSecurityPolicy: CSP
      });
      registerClientPortalIpc();
      log(`client portal previews open in the system browser via ${state.portalPreview.origin}`);
      // Defense in depth: deny every permission request (camera, geolocation,
      // notifications…) — nothing in the books UI needs one.
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      // Dock icon — the mascot on the sunset tile (desktop/build, generated
      // by make-icon.py there). An unpackaged shell shows Electron's default
      // otherwise; the packaged app will carry build/icon.icns via the
      // packager config when the packaging slice lands. Runtime-set, so it
      // covers the Dock only — Finder/Cmd-Tab wait for packaging.
      if (process.platform === 'darwin' && app.dock) {
        try { app.dock.setIcon(path.join(HERE, 'build', 'icon.png')); } catch { /* cosmetic */ }
      }
      createWindow();
      log('Donna Desktop is up.');
    } catch (error) {
      console.error(`[desktop-main] boot failed: ${error.message}`);
      state.pg?.stop?.();
      app.quit();
    }
  });

  app.on('second-instance', () => {
    if (state.window) {
      if (state.window.isMinimized()) state.window.restore();
      state.window.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && state.pg) createWindow();
  });

  app.on('window-all-closed', () => {
    // Menu-bar residency ("Close window ≠ Quit Donna", plan §9) is an M1
    // slice; the v0 dev shell follows platform defaults.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (state.quitting) return;
    state.quitting = true;
    state.watchdog?.stop();
    event.preventDefault();
    const finish = () => {
      // The per-boot token dies with this process; take the handshake file
      // with it so the MCPB shim reports "Donna isn't running" instead of
      // dialing a dead socket with a stale token.
      if (state.dataDir) removeMcpEndpointFile({ dataDir: state.dataDir });
      state.portalPreview?.stop?.();
      state.pg?.stop?.();
      state.fileLog?.close();
      app.exit(0);
    };
    if (state.runtime) {
      const killTimeout = setTimeout(() => {
        state.runtime.kill();
        finish();
      }, 10_000);
      state.runtime.on('exit', () => {
        clearTimeout(killTimeout);
        finish();
      });
      state.runtime.postMessage({ type: 'shutdown' });
    } else {
      finish();
    }
  });
}
