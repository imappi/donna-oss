// Supervised local Postgres for the desktop lane (technical plan §3):
// per-user instance, private Unix-domain socket only (listen_addresses='',
// socket dir 0700 — no TCP listener, ever), one-time initdb, and the
// storage-schema stub that host-gates migration 010's single Supabase-ism
// (M0a findings §2). Shared by scripts/desktop-boot.mjs (headless harness)
// and desktop/main.mjs (the Electron shell's main process — plan §1: main
// supervises PG, nothing else business-shaped).

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// The product generation is pinned to PG 16 (plan §3): a data dir initdb'd by
// one major cannot be read by another, and backup packages restore with the
// same major they were dumped from.
export const PG_MAJOR = 16;

// Returns the major version of a bin dir, or null if pg_ctl won't run there.
const pgBinMajor = (dir) => {
  try {
    const out = execFileSync(path.join(dir, 'pg_ctl'), ['--version'], { encoding: 'utf8' });
    // Real-world formats: `pg_ctl (PostgreSQL) 16.14` (Postgres.app/EDB),
    // `… 16.14 (Homebrew)`, `… 16.9 (Debian 16.9-1.pgdg120+1)`. The old
    // end-anchored regex missed every suffixed build — the host-candidate
    // path tolerated the null, but the strict bundled gate refused a healthy
    // Homebrew-sourced payload as "corrupt" (first Mac drill, 2026-08-07).
    // Parse the version right after the (PostgreSQL) marker; fall back to
    // the first major.minor anywhere.
    const match = /\(PostgreSQL\)\s+(\d+)/.exec(out) || /\b(\d+)\.\d+/.exec(out);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

// Where PG 16 lands across the installs a desktop user plausibly has. Every
// entry but the last pins the major in its path; the last is unversioned and
// is therefore probed before it wins.
export const pgBinCandidates = () => [
  '/opt/homebrew/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@16/bin',
  // Postgres.app — the standard macOS route when Homebrew isn't installed.
  '/Applications/Postgres.app/Contents/Versions/16/bin',
  path.join(homedir(), 'Applications/Postgres.app/Contents/Versions/16/bin'),
  // EnterpriseDB installer.
  '/Library/PostgreSQL/16/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/local/pgsql/bin'
];

export const findPgBin = () => {
  // Explicit wins, but a wrong major is a hard error rather than a cluster the
  // rest of the generation cannot open.
  if (process.env.PG_BIN) {
    const major = pgBinMajor(process.env.PG_BIN);
    if (major !== null && major !== PG_MAJOR) {
      throw new Error(
        `PG_BIN points at Postgres ${major} (${process.env.PG_BIN}); the desktop lane is pinned to Postgres ${PG_MAJOR}.`
      );
    }
    return process.env.PG_BIN;
  }
  // The packaged app bundles its own PG payload (M0b: no host Postgres debt)
  // and asserts it via DONNA_BUNDLED_PG_BIN (set by Electron main from
  // process.resourcesPath when app.isPackaged). A set-but-broken bundle is a
  // packaging DEFECT and fails loudly — silently falling through to the host
  // candidates would re-create the exact host dependency the bundle exists
  // to remove, on whatever PG the tester happens to have. PG_BIN (above)
  // stays the operator override/kill-switch: env can kill, never silently
  // substitute.
  const bundled = process.env.DONNA_BUNDLED_PG_BIN;
  if (bundled) {
    if (!existsSync(path.join(bundled, 'pg_ctl'))) {
      throw new Error(
        `DONNA_BUNDLED_PG_BIN is set (${bundled}) but contains no pg_ctl — the bundled Postgres payload is missing or corrupt. Reinstall the app, or set PG_BIN to a host Postgres ${PG_MAJOR} as a manual override.`
      );
    }
    const major = pgBinMajor(bundled);
    if (major !== PG_MAJOR) {
      throw new Error(
        `The bundled Postgres payload at ${bundled} reports major ${major ?? 'unknown'}; this build is pinned to Postgres ${PG_MAJOR}. The app bundle is corrupt — reinstall, or set PG_BIN as a manual override.`
      );
    }
    return bundled;
  }
  for (const dir of pgBinCandidates()) {
    if (!existsSync(path.join(dir, 'pg_ctl'))) continue;
    // Unversioned paths (/usr/local/pgsql/bin) can hold any major; skip a
    // mismatch and keep scanning rather than failing on a later candidate.
    const major = pgBinMajor(dir);
    if (major !== null && major !== PG_MAJOR) continue;
    return dir;
  }
  throw new Error(
    `Postgres ${PG_MAJOR} binaries not found. Install them (macOS with Homebrew: \`brew install postgresql@${PG_MAJOR}\`; without Homebrew: Postgres.app from postgresapp.com) or set PG_BIN to the directory containing pg_ctl/initdb.`
  );
};

// Brings local Postgres up (initdb on first run) and returns its coordinates
// plus a stop(). Idempotent per data dir; safe to call on every app launch.
//
// onActive — what to do when a postgres is ALREADY RUNNING on this data dir:
//  - 'reclaim' (default): stop it and start under this supervisor. Correct
//    ONLY for the exclusive owner (the app / headless harness boot paths):
//    a running server on our dir is our own orphan there (§4b-iv).
//  - 'attach': use the running server and leave it up — stop() becomes a
//    no-op. For sibling tools (backup create) that run WHILE the app owns
//    the server. Observed 2026-08-09: the backup CLI's default reclaim
//    fast-stopped the live drill app's postmaster mid-session and then
//    stopped PG on exit, leaving the running app DB-less — an "orphan" and
//    a live sibling are indistinguishable to the reclaim path by design.
//  - 'refuse': throw. For tools that need exclusive ownership of a dir that
//    must not be live (restore targets a fresh install, never a running app).
export const ensureLocalPostgres = ({
  dataDir,
  pgPort = Number(process.env.DONNA_DESKTOP_PG_PORT || 5433),
  dbName = 'donna_local',
  dbUser = 'donna',
  onActive = 'reclaim',
  logger = console
} = {}) => {
  if (!dataDir) throw new Error('ensureLocalPostgres needs dataDir');
  const pgBin = findPgBin();
  const pgData = path.join(dataDir, 'database', 'pg');
  const socketDir = path.join(dataDir, 'runtime', 'sockets');
  const logDir = path.join(dataDir, 'runtime');

  const pgExec = (bin, args, opts = {}) =>
    execFileSync(path.join(pgBin, bin), args, { stdio: 'pipe', encoding: 'utf8', ...opts });
  const psql = (sql, { db = dbName } = {}) =>
    pgExec('psql', ['-h', socketDir, '-p', String(pgPort), '-U', dbUser, '-d', db, '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);

  mkdirSync(socketDir, { recursive: true, mode: 0o700 });

  if (!existsSync(path.join(pgData, 'PG_VERSION'))) {
    logger.log?.(`[pg-supervisor] initdb → ${pgData}`);
    mkdirSync(pgData, { recursive: true, mode: 0o700 });
    pgExec('initdb', ['-D', pgData, '-U', dbUser, '--auth=trust', '-E', 'UTF8']);
    // Private Unix socket only — no TCP (plan §3). Written once at init so
    // every subsequent boot inherits it.
    appendFileSync(path.join(pgData, 'postgresql.conf'), [
      '',
      '# --- Donna desktop overrides (plan §3: private socket, no TCP) ---',
      "listen_addresses = ''",
      `unix_socket_directories = '${socketDir}'`,
      `port = ${pgPort}`,
      ''
    ].join('\n'));
  }

  // A live-server probe for the non-exclusive modes. The reclaim path keeps
  // its original shape (probe only after a start failure) so the app's boot
  // stays byte-identical.
  const serverRunning = () => {
    try {
      pgExec('pg_ctl', ['-D', pgData, 'status']);
      return true;
    } catch {
      return false;
    }
  };

  let attached = false;
  if (onActive !== 'reclaim' && existsSync(path.join(pgData, 'PG_VERSION')) && serverRunning()) {
    if (onActive === 'refuse') {
      throw new Error(
        `a live postgres already owns ${pgData} — quit the Donna app (or stop that server) before running this tool`
      );
    }
    logger.log?.('[pg-supervisor] attaching to the postgres already running on this data dir (it stays up)');
    attached = true;
  }

  const startPg = () =>
    pgExec('pg_ctl', ['-D', pgData, '-w', '-t', '30', '-l', path.join(logDir, 'pg.log'), 'start']);
  if (!attached) try {
    logger.log?.('[pg-supervisor] starting postgres (unix socket only)…');
    startPg();
  } catch (startError) {
    // An unclean previous exit (crash, SIGKILL, a Ctrl-C that outran the quit
    // handler) leaves an orphaned postmaster holding this data dir, and start
    // fails with "another server might be running" (observed on the
    // 2026-08-03 Mac launch). The data dir is exclusively this app's, so a
    // server confirmed RUNNING on it is our own orphan: stop it and start
    // under this supervisor. Any other start failure rethrows untouched —
    // pg_ctl already handles a stale pid file with no live server by itself.
    let orphanRunning = false;
    try {
      pgExec('pg_ctl', ['-D', pgData, 'status']);
      orphanRunning = true;
    } catch {
      // status ≠ 0: nothing running here — the original failure stands.
    }
    if (!orphanRunning) throw startError;
    logger.log?.('[pg-supervisor] an orphaned postgres from a previous run holds this data dir — reclaiming…');
    pgExec('pg_ctl', ['-D', pgData, '-w', '-m', 'fast', 'stop']);
    startPg();
  }

  const stop = () => {
    // An attached server belongs to another supervisor (the running app) —
    // leaving it up IS the contract of onActive: 'attach'.
    if (attached) {
      logger.log?.('[pg-supervisor] leaving the attached postgres running');
      return;
    }
    // Idempotent: a failed boot stops PG on the way down and the quit handler
    // stops it again. An already-stopped instance is the requested state, not
    // an error to shout about.
    if (!existsSync(path.join(pgData, 'postmaster.pid'))) {
      logger.log?.('[pg-supervisor] postgres already stopped');
      return;
    }
    try {
      pgExec('pg_ctl', ['-D', pgData, '-w', '-m', 'fast', 'stop']);
      logger.log?.('[pg-supervisor] postgres stopped');
    } catch (error) {
      logger.error?.(`[pg-supervisor] pg stop failed: ${error.message}`);
    }
  };

  try {
    const exists = psql(`select 1 from pg_database where datname = '${dbName}'`, { db: 'postgres' }).trim();
    if (exists !== '1') {
      logger.log?.(`[pg-supervisor] createdb ${dbName}`);
      pgExec('createdb', ['-h', socketDir, '-p', String(pgPort), '-U', dbUser, dbName]);
    }

    // Host gate for the single Supabase-ism (M0a findings §2): migration 010
    // upserts into storage.buckets and drops policies on storage.objects.
    // Idempotent, so it runs on every boot.
    psql(`
      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key, name text, public boolean,
        file_size_limit bigint, allowed_mime_types text[]);
      create table if not exists storage.objects (
        id uuid default gen_random_uuid() primary key,
        bucket_id text references storage.buckets(id), name text, metadata jsonb);
    `);
  } catch (error) {
    stop();
    throw error;
  }

  return {
    pgBin,
    pgData,
    socketDir,
    port: pgPort,
    attached,
    databaseUrl: `postgresql://${dbUser}@localhost/${dbName}?host=${encodeURIComponent(socketDir)}&port=${pgPort}`,
    stop
  };
};
