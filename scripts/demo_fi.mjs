#!/usr/bin/env node
// The zero-key demo: Kampaamo Kultalanka Oy's February 2025, read, coded,
// matched and answered on this machine with no provider key, from RECORDED
// model outputs (README.md, "Run Donna locally").
//
//   npm run demo:fi                 replay (no key needed, no network call)
//   npm run demo:fi:record          re-record the outputs from live models
//   npm run demo:fi:record -- --fill
//                                   re-record only what the code now asks
//                                   differently (after a prompt change)
//
// One process does what the README's three commands do, plus the rest:
//   1. its own PostgreSQL in its own data folder (~/.donna-demo; the book
//      `npm run local:runtime` uses is never touched), migrations applied;
//   2. the runtime (createDonnaRuntimeServer, the assembly the desktop shell
//      and `npm run local:runtime` boot) and the web app on 127.0.0.1;
//   3. the demo firm and company and all 26 documents of the month, through
//      the runtime's own routes (scripts/load_finnish_demo.mjs);
//   4. the scheduler's work, run to rest in rounds (desktop/manifestTicker.js:
//      the runtime's own scheduler is stopped and the same manifest is
//      dispatched on a virtual clock, five minutes a round, so the hourly
//      sweeps come due in seconds; production timing is not changed);
//   5. the owner's answers (scripts/fixtures/fi_kultalanka_month_facts.json,
//      `owner_answers`) given through the reply route, then rest again;
//   6. a summary read from the stored rows, and the book left up to look at,
//      still ticking, so a receipt uploaded in the web app is read, coded and
//      matched within seconds. Ctrl-C stops it. A book that does not come to
//      rest is a failed run: the command says so and exits non-zero.
//
// REPLAY IS ENTERED ONLY HERE. Nothing in the runtime switches it on: no
// environment variable, no missing key. This command installs the replay
// seam (server/donna/providerReplay.js) on the process's `fetch` before any
// runtime module loads, and it is the only caller that does.
//
// HERMETIC. What the month asks the models depends on configuration (model
// ids, lane switches, endpoints), so the demo reads none from this machine:
// sealDemoEnvironment() below keeps only the names in DEMO_ENV_NAMES (the
// machine, PostgreSQL's binaries, the demo's ports and sign-in, the build's
// identity) and drops every other variable; the process then works from an
// empty directory, so no module's `<cwd>/.env` fallback finds a file; and the
// runtime is assembled with no provider-key files (no ~/.config/donna/
// providers.env, no .env.local, no .env). The provider keys are then a
// placeholder that is not a key (providerReplay.js REPLAY_PLACEHOLDER_KEY).
// A recording pass keeps exactly two more names, OPENAI_API_KEY and
// ANTHROPIC_API_KEY (and the proxy settings it needs to reach them); the
// passes `npm run demo:fi:record` starts are sealed the same way.
//
// GUARDS. Replay serves the demo book only: before the demo writes anything
// (no schema, no migration) it refuses a database that holds any firm but the
// demo firm or any company but the demo company (PROVIDER_REPLAY_FOREIGN_BOOK,
// exit 3), and the seam re-reads the book before every answer it serves, so a
// company created in the web app during the demo stops replay instead of
// receiving a recorded answer. A PostgreSQL already running on the data
// folder is used and left running, never stopped. Every non-loopback request
// is refused.
//
// Options:
//   --data-dir=DIR        the demo's own data folder (default ~/.donna-demo)
//   --database-url=URL    use an existing, empty PostgreSQL database instead
//                         (tests and Docker; the same guards apply)
//   --port=N --web-port=N runtime and web ports (default 8787 / 5173, or
//                         DONNA_DESKTOP_PORT / DONNA_LOCAL_WEB_PORT); the web
//                         app listens on DONNA_LOCAL_WEB_HOST (default
//                         127.0.0.1), as scripts/local_web.mjs does
//   --hold=FILE           leave one document out, to upload it by hand; only
//                         with recordings made with the same --hold
//   --exit-at-rest        stop once the book is at rest (tests, recording)
//   --no-web              do not serve the web app
//   --quiet               keep the runtime's own log out of the terminal
//   --report=FILE         write the end-state summary as JSON
//   --trace=FILE          replay: write every normalized request (served or
//                         not) as JSON lines, to diff two runs
//   --recordings=FILE     the recordings (default data/demo-replay/…)
//   --verify              replay on an empty book and fail unless every
//                         request was recorded AND every recorded answer was
//                         asked for (the last pass of `demo:fi:record`)
//   --record              re-record. Alone (as `npm run demo:fi:record`) it
//                         runs the live pass, fill passes until one asks
//                         nothing new, and a --verify replay, each on a fresh
//                         book of its own; only then is --recordings replaced.
//                         With --exit-at-rest it is one pass, whose file is
//                         written only if the pass came to rest with every
//                         answer kept and the spend cap not reached
//   --fill                with --record: start from the existing --recordings,
//                         answer what they hold from them, call live only for
//                         what they miss; the file a pass writes holds exactly
//                         the requests that pass made
//   --cap-usd=N           with --record: the spend cap in USD for the whole
//                         command, across every pass (default 20); a live call
//                         is made only if its estimated price still fits
//                         (estimateCallUsd), and its reported cost is added
//   --stand-in=openai     with --record: answer the OpenAI lanes from the
//                         scripted stand-in (scripts/demo_fi_stand_ins.mjs)
//                         instead of the network

import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROVIDER_REPLAY_CODES,
  PROVIDER_REPLAY_FORMAT,
  PROVIDER_REQUEST_IDENTITY_VERSION,
  ProviderReplayError,
  REPLAY_PLACEHOLDER_KEY,
  REPLAY_PROVIDER_KEY_ENV,
  findSecretShapes,
  installProviderRecorder,
  installProviderReplay,
  packRecordings,
  parseRequestBody,
  recordedModels,
  recordedResponseFor,
  recordingsDigest,
  serializeEventStream,
  summarizeProviderResponse,
  unpackRecordings
} from '../server/donna/providerReplay.js';
import { parseDotEnv } from '../server/donna/desktop/providerKeyDotEnv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_RECORDINGS = path.join(ROOT, 'data', 'demo-replay', 'fi-kultalanka-2025-02.json');
export const FACTS_FILE = path.join(ROOT, 'scripts', 'fixtures', 'fi_kultalanka_month_facts.json');
export const DEMO_FIRM_ID = 'firm-demo-tilitoimisto';
// What a miss tells the next person to run: fill passes re-record only the
// requests that changed (live for live lanes, the stand-in for stand-in
// lanes), keep every answer that still matches, and verify the result.
export const RERECORD_COMMAND = 'npm run demo:fi:record -- --fill';
export const SETTLE = Object.freeze({ advance_ms: 300_000, quiet_rounds: 3, max_rounds: 48 });
export const ANSWER_ROUNDS = 4;
export const DEFAULT_CAP_USD = 20;
// A live call whose request does not say how long the answer may be is
// priced as if it were this long.
export const WORST_CASE_OUTPUT_TOKENS = 64_000;
// Daily backup packages are the one sweep a fast clock would multiply on disk;
// a demo book needs none. Everything else in the manifest runs.
const VIRTUAL_CLOCK_SKIP = new Set(['desktop-backup-daily']);

const log = (line) => console.log(`[demo] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoError extends Error {
  constructor({ code, message, exitCode = 1 }) {
    super(message);
    this.name = 'DemoError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const parseDemoArgs = (argv) => {
  const out = { record: false, exitAtRest: false };
  for (const arg of argv) {
    if (arg === '--record') out.record = true;
    else if (arg === '--fill') out.fill = true;
    else if (arg === '--verify') out.verify = true;
    else if (arg === '--no-web') out.noWeb = true;
    else if (arg === '--quiet') out.quietRuntime = true;
    else if (arg === '--exit-at-rest') out.exitAtRest = true;
    else {
      const m = /^--(data-dir|database-url|port|web-port|hold|report|recordings|stand-in|cap-usd|trace)=(.+)$/.exec(arg);
      if (!m) throw new Error(`unknown argument ${arg}`);
      out[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2];
    }
  }
  if (out.standIn && (!out.record || out.standIn !== 'openai')) throw new Error('--stand-in=openai is only for --record');
  if (out.fill && !out.record) throw new Error('--fill is only for --record');
  if (out.verify && out.record) throw new Error('--verify is a replay; it is not for --record');
  if (out.capUsd !== undefined) {
    if (!out.record) throw new Error('--cap-usd is only for --record');
    // A number of US dollars above zero, written plainly: anything else
    // (abc, 0, -1, 1e3, Infinity) is refused, never read as "no cap".
    if (!/^\d+(\.\d+)?$/.test(out.capUsd) || !(Number(out.capUsd) > 0)) throw new Error(`--cap-usd must be a positive number of US dollars, not "${out.capUsd}"`);
    out.capUsd = Number(out.capUsd);
  }
  if (out.verify) Object.assign(out, { exitAtRest: true, noWeb: true });
  return out;
};

// ── The sealed environment ─────────────────────────────────────────────────
// The only variables the demo keeps. Nothing here changes what the month asks
// a model: these name the machine, where PostgreSQL's binaries are, the
// demo's own ports and sign-in, and which build this is (Host A's
// source_build check reads it).
export const DEMO_ENV_NAMES = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TEMP', 'TMP',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMDATA',
  'PG_BIN', 'DONNA_BUNDLED_PG_BIN', 'DONNA_DESKTOP_PG_PORT',
  'DONNA_DESKTOP_PORT', 'DONNA_LOCAL_WEB_PORT', 'DONNA_LOCAL_WEB_HOST', 'DONNA_ACCESS_TOKEN',
  'DONNA_BUILD_COMMIT_SHA', 'DONNA_BUILD_DIRTY', 'DONNA_RUNTIME_BUILD_DIRTY', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA'
]);
const DEMO_ENV_PATTERNS = Object.freeze([]);
// The time zone and locale are fixed, not kept: a prompt that prints a local
// time or a locale-formatted number would otherwise ask a different question
// in Helsinki than where it was recorded (UTC, C).
export const DEMO_FIXED_ENV = Object.freeze({ TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
// A recording pass also keeps the two keys of the live lanes and what it
// needs to reach them through a proxy.
export const RECORD_ENV_NAMES = Object.freeze([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS'
]);

// Drop every variable but the kept names, in place, and move the process to
// a new empty directory. Returns what was dropped (names only) and undo().
export const sealDemoEnvironment = ({ env = process.env, record = false } = {}) => {
  const keep = new Set([...DEMO_ENV_NAMES, ...(record ? RECORD_ENV_NAMES : [])]);
  const dropped = [];
  for (const name of Object.keys(env)) {
    if (keep.has(name) || DEMO_ENV_PATTERNS.some((pattern) => pattern.test(name))) continue;
    dropped.push(name);
    delete env[name];
  }
  Object.assign(env, DEMO_FIXED_ENV);
  const priorCwd = process.cwd();
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'donna-demo-cwd-'));
  process.chdir(cwd);
  return {
    cwd,
    dropped: dropped.sort(),
    undo() {
      try { process.chdir(priorCwd); } catch { /* the old directory is gone */ }
      rmSync(cwd, { recursive: true, force: true });
    }
  };
};

// ── The book the replay may serve ──────────────────────────────────────────
// No firm but the demo firm, no company but the demo company. A database
// whose tables do not exist yet holds no book at all: it passes, and the
// check reads nothing it would have to create. `query` reads the database.
const bookTables = async (query) => (await query(
  "select to_regclass('public.firms') is not null as firms, to_regclass('public.clients') is not null as clients"
)).rows[0];
export const assertDemoBookOnly = async ({ query, clientId, firmId = DEMO_FIRM_ID }) => {
  const tables = await bookTables(query);
  const foreignFirms = tables.firms ? (await query('select id from firms where id <> $1 order by id limit 5', [firmId])).rows : [];
  const foreignClients = tables.clients ? (await query('select id, firm_id from clients where id <> $1 or firm_id <> $2 order by id limit 5', [clientId, firmId])).rows : [];
  if (foreignFirms.length || foreignClients.length) {
    throw new ProviderReplayError({
      code: PROVIDER_REPLAY_CODES.FOREIGN_BOOK,
      message: `provider replay: refused — this book holds ${[
        ...foreignFirms.map((row) => `firm ${row.id}`),
        ...foreignClients.map((row) => `company ${row.id} (firm ${row.firm_id})`)
      ].join(', ')}; recorded answers are served only to the demo company ${clientId} of firm ${firmId}. `
        + 'Nothing was written. Use the demo\'s own data folder (--data-dir) or an empty database.',
      detail: { foreign_firms: foreignFirms.map((row) => row.id), foreign_clients: foreignClients.map((row) => row.id) }
    });
  }
};
const bookIsEmpty = async (query) => {
  const tables = await bookTables(query);
  return !tables.firms || !(await query('select 1 from firms limit 1')).rows.length;
};

// The recordings were made on a database with C (byte-order) collation. Some
// queries that build a prompt sort text ids (`order by id`), and the order of
// those ids — so the prompt, so the request — follows the database's
// collation: on an en_US database the same book asks different questions. The
// demo therefore runs only on a C-collated database and says so by name.
export const DEMO_COLLATIONS = Object.freeze(['C', 'POSIX', 'C.UTF-8', 'C.utf8']);
export const assertDemoCollation = async ({ query }) => {
  const collation = (await query('select datcollate from pg_database where datname = current_database()')).rows[0]?.datcollate;
  if (!DEMO_COLLATIONS.includes(collation)) {
    throw new ProviderReplayError({
      code: 'PROVIDER_REPLAY_COLLATION',
      message: `provider replay: this database sorts text as ${collation}; the recordings were made on C collation and the prompts would differ. Nothing was written. `
        + "Use the demo's own data folder, or create the database with: create database <name> template template0 locale 'C'"
    });
  }
};

// Host A holds the scheduler on a working tree with uncommitted changes under
// the runtime's paths (source_build: dirty_runtime_build), so the month would
// never run: the first upload is refused with HTTP 503. Say so first, in
// words, with the same predicate Host A uses (hostCertificateA.js
// buildIdentityCheck). No check is skipped: the remedy is to commit.
export const assertDemoBuildRuns = async ({ env = process.env, mode }) => {
  const { applyDesktopBuildIdentityDefaults, DESKTOP_REPO_ROOT, DESKTOP_RUNTIME_IDENTITY_PATHS } = await import('../server/donna/desktop/buildIdentity.js');
  const { buildIdentityCheck } = await import('../server/donna/hostCertificateA.js');
  applyDesktopBuildIdentityDefaults(env, { rootDir: DESKTOP_REPO_ROOT });
  const check = buildIdentityCheck(env);
  if (check.status === 'PASS') return check;
  let changed = [];
  try {
    changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', ...DESKTOP_RUNTIME_IDENTITY_PATHS], { cwd: DESKTOP_REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).map((line) => line.slice(3));
  } catch { /* not a checkout */ }
  const again = mode === 'record' ? RERECORD_COMMAND : 'npm run demo:fi';
  throw new DemoError({
    code: 'DEMO_UNCOMMITTED_RUNTIME',
    message: check.detail?.reason === 'dirty_runtime_build'
      ? `demo: this checkout has uncommitted changes to the runtime (${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', …' : ''}). `
        + 'Host A does not start the scheduler on an uncommitted runtime build (source_build: dirty_runtime_build), so the month would not run. '
        + `Commit the change (a work-in-progress commit on your branch is fine), then run \`${again}\` again.`
      : `demo: Host A cannot tell which build this is (source_build: ${check.detail?.reason || check.status}), so the month would not run. Run the demo from a git checkout of Donna.`
  });
};

const STORAGE_STUB_SQL = `
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table if not exists storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`;

export const loadReplayRecordings = (file = DEFAULT_RECORDINGS) => {
  if (!existsSync(file)) {
    throw new ProviderReplayError({
      code: PROVIDER_REPLAY_CODES.BAD_RECORDINGS,
      message: `provider replay: no recordings at ${path.relative(ROOT, file)}; the repository ships them there (git checkout -- ${path.relative(ROOT, DEFAULT_RECORDINGS)}), or make new ones with \`npm run demo:fi:record\` (live keys needed)`
    });
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const unpacked = unpackRecordings(raw);
  return { ...unpacked, digest: recordingsDigest(raw) };
};

// ── Spend ──────────────────────────────────────────────────────────────────
// List prices from the facts file (the spend meter of
// scripts/fi_month_two_stage_run.js), by exact model id or id prefix.
export const priceFor = (prices = {}, model) => prices[model] || Object.entries(prices).find(([prefix]) => model && model.startsWith(prefix))?.[1] || null;

// The price table a record command spends by. Every row must carry finite,
// positive input and output prices (and finite, non-negative multipliers
// where it has them), and every model the month may call must resolve to a
// row: otherwise the meter would read NaN and the cap would stop nothing. A
// row marked `assumed` is not a published price: the cap is approximate for
// that model, and the command says so.
export const PRICE_FIELDS = Object.freeze(['input_per_million', 'output_per_million']);
export const PRICE_MULTIPLIERS = Object.freeze(['cache_write_multiplier', 'cache_read_multiplier']);
export const validatePriceTable = ({ prices, models = [] }) => {
  const problems = [];
  if (!prices || typeof prices !== 'object' || !Object.keys(prices).length) problems.push('there is no price table');
  for (const [row, price] of Object.entries(prices || {})) {
    for (const field of PRICE_FIELDS) {
      const value = price?.[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) problems.push(`row "${row}": ${field} is ${JSON.stringify(value)}, not a positive number`);
    }
    for (const field of PRICE_MULTIPLIERS) {
      if (field in (price || {}) && (typeof price[field] !== 'number' || !Number.isFinite(price[field]) || price[field] < 0)) problems.push(`row "${row}": ${field} is ${JSON.stringify(price[field])}, not a non-negative number`);
    }
  }
  for (const model of models) if (model && !priceFor(prices, model)) problems.push(`model "${model}" has no row`);
  if (problems.length) {
    throw new DemoError({ code: 'DEMO_PRICE_TABLE', message: `demo record: the price table in ${path.relative(ROOT, FACTS_FILE)} cannot meter the spend: ${problems.join('; ')}. Nothing was called.` });
  }
  return Object.entries(prices).map(([row, price]) => `${row} ${price.input_per_million} in / ${price.output_per_million} out USD per million tokens${price.assumed ? ' (an assumed rate, not a published price: the cap is approximate for this model)' : ''}`);
};
// A meter that cannot read refuses the call: a NaN estimate or a NaN total
// would otherwise compare false against the cap and stop nothing.
export const meterRefuses = ({ estimateUsd, spentUsd }) => !Number.isFinite(estimateUsd) || !Number.isFinite(spentUsd) || estimateUsd < 0;

// The models a record command may call: every model the reference
// recordings asked for.
export const modelsOf = (entries = []) => [...new Set((entries || []).map((entry) => entry.model_requested).filter(Boolean))].sort();

// What one live answer cost, from its reported usage. Null when the model is
// unpriced or the answer reports no usage.
export const priceUsage = ({ prices = {}, model, usage, provider }) => {
  const price = priceFor(prices, model);
  if (!price || !usage) return null;
  const cacheRead = provider === 'anthropic' ? usage.cache_read_input_tokens || 0 : usage.input_tokens_details?.cached_tokens || 0;
  const cacheWrite = provider === 'anthropic' ? usage.cache_creation_input_tokens || 0 : 0;
  const input = (usage.input_tokens ?? usage.prompt_tokens ?? 0) - (provider === 'anthropic' ? 0 : cacheRead);
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return (input * price.input_per_million + cacheWrite * price.input_per_million * (price.cache_write_multiplier ?? 1.25)
    + cacheRead * price.input_per_million * (price.cache_read_multiplier ?? 0.1) + output * price.output_per_million) / 1e6;
};

// What one live call may cost, before it is made.
// Input tokens, best source first:
//   1. Anthropic: the free count_tokens endpoint's exact count;
//   2. the lane's own earlier live calls in this pass: the most input tokens
//      per bound unit (below) any of them used, times LEARNED_MARGIN;
//   3. the most input tokens the lane used in the reference recordings (their
//      stored usage), times LEARNED_MARGIN, so a pass's first call of a lane
//      is not priced at the bound;
//   4. the hard bound: every byte of the request's text as a token (a text
//      token is never shorter than a byte), and each attached file by what it
//      can cost rather than by its size: a PDF page PDF_PAGE_TOKENS, an image
//      IMAGE_TOKENS.
// Output tokens: the request's own limit; else the longest answer the lane
// gave (earlier in this pass, or in the reference recordings) times
// LEARNED_MARGIN; else WORST_CASE_OUTPUT_TOKENS.
// Input is priced at the cache-write rate where the provider has one. The
// cap is still a hard stop on actual spend: after each call its reported
// usage is added, and the next call is made only if its estimate fits in
// what is left.
export const PDF_PAGE_TOKENS = 3_000;
export const IMAGE_TOKENS = 6_000;
export const LEARNED_MARGIN = 1.5;
// A file is only what the request says is one: a base64 data URL (OpenAI
// input_file / input_image), or an Anthropic source block of type base64.
const fileOf = (value) => {
  if (typeof value !== 'string' || value.length < 64) return null;
  const dataUrl = /^data:([^;,]+)(?:;[^,]*)?;base64,/.exec(value);
  return dataUrl ? { mime: dataUrl[1], data: value.slice(dataUrl[0].length) } : null;
};
export const fileTokens = ({ mime, data }) => {
  const bytes = Buffer.from(data, 'base64');
  const isPdf = mime === 'application/pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) return Math.max(1, (bytes.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length) * PDF_PAGE_TOKENS;
  if ((mime && mime.startsWith('image/')) || /^(\x89PNG|\xff\xd8\xff|GIF8|RIFF)/.test(bytes.subarray(0, 4).toString('latin1'))) return IMAGE_TOKENS;
  return bytes.length;
};
export const requestShape = (init) => {
  const body = parseRequestBody(init) || {};
  let files = 0;
  const strip = (value) => {
    if (typeof value === 'string') {
      const file = fileOf(value);
      if (file) { files += fileTokens(file); return ''; }
      return value;
    }
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      if (value.type === 'base64' && typeof value.data === 'string') {
        files += fileTokens({ mime: value.media_type || null, data: value.data });
        return { ...value, data: '' };
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)]));
    }
    return value;
  };
  const text = strip(body);
  return {
    body,
    textTokensBound: Buffer.byteLength(JSON.stringify(text)),
    fileTokens: files,
    outputLimit: Number(body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens) || null
  };
};
export const estimateCallUsd = ({ price, init, provider, countedInputTokens = null, laneOutputTokens = null, laneTokensPerUnit = null, laneInputTokens = null }) => {
  const shape = requestShape(init);
  const bound = shape.textTokensBound + shape.fileTokens;
  const inputTokens = countedInputTokens
    ?? (laneTokensPerUnit ? Math.ceil(bound * Math.min(1, laneTokensPerUnit * LEARNED_MARGIN))
      : laneInputTokens ? Math.min(bound, Math.ceil(laneInputTokens * LEARNED_MARGIN)) : bound);
  const outputTokens = shape.outputLimit ?? (laneOutputTokens ? Math.ceil(laneOutputTokens * LEARNED_MARGIN) : WORST_CASE_OUTPUT_TOKENS);
  const inputRate = price.input_per_million * (provider === 'anthropic' ? (price.cache_write_multiplier ?? 1.25) : 1);
  const outputUsd = outputTokens * price.output_per_million / 1e6;
  return {
    usd: inputTokens * inputRate / 1e6 + outputUsd, output_usd: outputUsd, input_tokens: inputTokens, output_tokens: outputTokens, bound_units: bound,
    input_source: countedInputTokens != null ? 'counted' : laneTokensPerUnit ? 'learned' : laneInputTokens && Math.ceil(laneInputTokens * LEARNED_MARGIN) < bound ? 'recorded' : 'bound'
  };
};

// The most input and output tokens each lane used, from the live answers
// in a recordings file (their stored usage).
export const laneUsageOf = (entries = []) => {
  const most = {};
  for (const entry of entries || []) {
    if (entry.provenance !== 'live') continue;
    for (const response of entry.responses || []) {
      const usage = response.events ? summarizeProviderResponse({ contentType: 'text/event-stream', text: serializeEventStream(response.events) }).usage : response.body?.usage;
      const input = (Number(usage?.input_tokens ?? usage?.prompt_tokens) || 0)
        + (Number(usage?.cache_creation_input_tokens) || 0) + (Number(usage?.cache_read_input_tokens) || 0);
      const output = Number(usage?.output_tokens ?? usage?.completion_tokens) || 0;
      const id = `${entry.provider}:${entry.lane}`;
      const lane = most[id] ||= { input: 0, output: 0 };
      lane.input = Math.max(lane.input, input);
      lane.output = Math.max(lane.output, output);
    }
  }
  return most;
};
export const laneOutputTokensOf = (entries = []) => Object.fromEntries(Object.entries(laneUsageOf(entries)).filter(([, u]) => u.output).map(([id, u]) => [id, u.output]));

// Anthropic's count_tokens endpoint (free): the exact input size of a
// Messages request. Null when it cannot be had.
export const countAnthropicInputTokens = async ({ fetchFn, input, init }) => {
  try {
    const body = parseRequestBody(init);
    if (!body) return null;
    const pick = Object.fromEntries(['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking'].filter((k) => k in body).map((k) => [k, body[k]]));
    const headers = Object.fromEntries(Object.entries(Object.fromEntries(new Headers(init.headers || {}))).filter(([k]) => ['x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type'].includes(k)));
    const url = new URL('/v1/messages/count_tokens', typeof input === 'string' ? input : input.url);
    const response = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(pick) });
    if (response.status !== 200) return null;
    const counted = Number((await response.json())?.input_tokens);
    return Number.isFinite(counted) && counted > 0 ? counted : null;
  } catch {
    return null;
  }
};

// Where a book's PostgreSQL socket goes (pgSupervisor.js), and the longest
// path a Unix socket may have here (sun_path: 104 bytes on macOS, 108 on
// Linux, each with its closing NUL).
export const socketPathFor = (dataDir, pgPort) => path.join(dataDir, 'runtime', 'sockets', `.s.PGSQL.${pgPort}`);
export const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;
export const assertSocketPathFits = (dataDir, pgPort) => {
  const socket = socketPathFor(dataDir, pgPort);
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) {
    throw new DemoError({
      code: 'DEMO_SOCKET_PATH_TOO_LONG',
      message: `demo: PostgreSQL's socket would be ${socket} (${Buffer.byteLength(socket)} bytes); this system allows ${SOCKET_PATH_MAX}. Use a shorter --data-dir (or a shorter TMPDIR).`
    });
  }
};

// The two keys a recording pass takes, from the environment or, where it
// does not set them, from the repository's .env if there is one. Nothing
// else is read from the file; a missing file is fine (a fill whose live
// lanes all match needs no key).
export const loadRecordKeys = (env = process.env, file = path.join(ROOT, '.env')) => {
  if (!existsSync(file)) return [];
  const vars = parseDotEnv(readFileSync(file, 'utf8'));
  const loaded = [];
  for (const name of REPLAY_PROVIDER_KEY_ENV) {
    if (!env[name] && vars[name]) { env[name] = vars[name]; loaded.push(name); }
  }
  return loaded;
};

// One owner answer through the reply route. An answer the route refuses is
// not an answered book.
export const giveOwnerAnswer = async ({ client, firmId, answer }) => {
  const response = await client.postJson(`/api/donna/firms/evidence/requests/${encodeURIComponent(answer.ask_id)}/resolve`, { firm_id: firmId, reply: answer.reply });
  log(`owner answered ${answer.line} (ask ${answer.ask_id}): HTTP ${response.status}`);
  if (response.status !== 200) {
    throw new DemoError({ code: 'DEMO_OWNER_ANSWER_REFUSED', message: `demo: the owner's answer to ${answer.line} (ask ${answer.ask_id}) was refused: HTTP ${response.status} ${String(response.text || '').slice(0, 300)}` });
  }
  return { ...answer, http: response.status };
};

// The commit and runtime state a recording was made on. A recording that
// cannot say is not written.
export const recordedOn = () => {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    return { commit: git(['rev-parse', 'HEAD']), runtime_dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no', '--', 'server', 'packs', 'db/migrations', 'data/worlds'])) };
  } catch (error) {
    throw new DemoError({ code: 'DEMO_RECORDED_ON_UNKNOWN', message: `demo record: cannot tell which commit this is (git rev-parse HEAD in ${ROOT} failed: ${String(error.stderr || error.message).trim().split('\n')[0]}); recordings must say what they were recorded on` });
  }
};

// The stored rows that say where the book is. Plain reads.
export const readDemoEndState = async ({ query, firmId, clientId }) => {
  const ids = [firmId, clientId];
  const one = async (sql) => (await query(sql, ids)).rows;
  return {
    journals: await one(`select status, count(*)::int as n from ledger_journals where firm_id = $1 and client_id = $2 group by 1 order by 1`),
    transactions_by_state: await one(`select coding_state, convergence_state, count(*)::int as n from transactions where firm_id = $1 and client_id = $2 group by 1, 2 order by 1, 2`),
    documents_by_state: await one(`select parse_status, convergence_state, count(*)::int as n from documents where firm_id = $1 and client_id = $2 group by 1, 2 order by 1, 2`),
    matches_by_status: await one(`select status, count(*)::int as n from reconciliation_matches where firm_id = $1 and client_id = $2 group by 1 order by 1`),
    asks_by_status: await one(`select status, count(*)::int as n from client_evidence_requests where firm_id = $1 and client_id = $2 group by 1 order by 1`),
    vat_lines: await one(`select l.tax_type, count(*)::int as n from ledger_lines l join ledger_journals j on j.id = l.journal_id where j.firm_id = $1 and j.client_id = $2 and j.status = 'posted' group by 1 order by 1`),
    models: await one(`select distinct m #>> '{}' as model from transactions t, jsonb_path_query(t.payload, 'strict $.**.model') m where t.firm_id = $1 and t.client_id = $2 and jsonb_typeof(m) = 'string' order by 1`)
  };
};

const fingerprintOf = async ({ query, firmId, clientId }) => JSON.stringify([
  (await query('select id, coding_state, convergence_state, convergence_reason from transactions where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, parse_status, document_type, convergence_state from documents where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, status, reversed_at from ledger_journals where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, status from reconciliation_matches where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  (await query('select id, status, evidence_type from client_evidence_requests where firm_id = $1 and client_id = $2 order by id', [firmId, clientId])).rows,
  // Work still queued for the book. Cron housekeeping is left out: a sweep's
  // next tick (or its recovery tick) is always pending, and counting it would
  // make a resting book look busy forever.
  (await query("select function_id, status, count(*)::int as n from local_jobs where status in ('pending', 'running') and function_id not like 'parse-cron:%' and function_id not in (select function_id from local_job_cron_state) group by 1, 2 order by 1, 2")).rows
]);

// Open asks → the statement line they are about → the facts file's answer.
export const answerFor = ({ ask, transaction, answers }) => {
  if (!transaction) return null;
  const amount = Number(transaction.money_out || 0) > 0 ? Number(transaction.money_out) : Number(transaction.money_in || 0);
  const direction = Number(transaction.money_out || 0) > 0 ? 'out' : 'in';
  const day = typeof transaction.transaction_date === 'string' ? transaction.transaction_date.slice(0, 10) : new Date(transaction.transaction_date).toISOString().slice(0, 10);
  const hit = Object.entries(answers.by_statement_line || {}).find(([, a]) => a.date === day && a.direction === direction && Math.abs(Number(a.amount) - amount) < 0.005);
  return hit ? { line: hit[0], reply: hit[1].reply, ask_id: ask.id } : null;
};

// The stand-in answers OpenAI requests only, and only in a recording pass.
// A fill keeps each lane's provenance: an OpenAI lane the file holds only as
// scripted stand-ins is answered by the stand-in again (always, so a changed
// stand-in changes the file); every other lane is reused or goes live. So
// `--fill` needs only the keys of the live lanes it misses.
export const standInLanesOf = (entries = []) => {
  const byLane = new Map();
  for (const entry of entries || []) if (entry.provider === 'openai') byLane.set(entry.lane, [...(byLane.get(entry.lane) || []), entry.provenance]);
  return new Set([...byLane].filter(([, provenances]) => provenances.every((p) => p === 'scripted_stand_in')).map(([lane]) => lane));
};
export const answersFromStandIn = ({ classified, standIn = null, standInLanes = new Set() }) => classified.endpoint_class === 'openai'
  && (standIn === 'openai' || standInLanes.has(classified.lane));

export const runDemo = async (options) => {
  const startedAt = Date.now();
  const mode = options.record ? 'record' : 'replay';
  // A recording pass and a verify pass always end at rest: the file is
  // written (or the verdict given) then.
  if (mode === 'record' || options.verify) options = { ...options, exitAtRest: true };
  // Paths the caller gave are the caller's: resolved here, before the seal
  // moves the process to its own (temporary) directory.
  options = { ...options, ...Object.fromEntries(['report', 'trace', 'recordings', 'dataDir'].filter((k) => options[k]).map((k) => [k, path.resolve(options[k])])) };
  const facts = JSON.parse(readFileSync(FACTS_FILE, 'utf8'));
  const recordingsFile = path.resolve(options.recordings || DEFAULT_RECORDINGS);
  // Read before the seal: the two live keys (a recording pass only), the
  // demo's own ports and sign-in, and where its data folder is.
  const realKeys = mode === 'record' ? Object.fromEntries(REPLAY_PROVIDER_KEY_ENV.map((k) => [k, process.env[k] || ''])) : {};
  // Every key-like value this machine's environment held, whatever the
  // provider: a recording that contained one would be refused. Held in
  // memory for the scan only, never printed.
  const machineSecrets = mode === 'record'
    ? Object.entries(process.env).filter(([name, value]) => /(_API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(name) && value && value.trim().length >= 8).map(([, value]) => value.trim())
    : [];
  const port = Number(options.port || process.env.DONNA_DESKTOP_PORT || 8787);
  const webPort = Number(options.webPort || process.env.DONNA_LOCAL_WEB_PORT || 5173);
  const accessToken = process.env.DONNA_ACCESS_TOKEN || randomBytes(24).toString('hex');
  // A recording or verify pass starts from an empty book every time: its own
  // new folder, removed when the pass ends.
  const ownTempDataDir = !options.databaseUrl && !options.dataDir && (mode === 'record' || options.verify);
  const dataDir = options.databaseUrl && !options.dataDir ? null : path.resolve(options.dataDir || (ownTempDataDir
    // Short, directly under the system's temporary folder: PostgreSQL's
    // socket lives inside it (assertSocketPathFits).
    ? mkdtempSync(path.join(os.tmpdir(), 'ddb-'))
    : path.join(os.homedir(), '.donna-demo')));

  // ── The seal: nothing from this machine's configuration reaches the month ──
  const sealed = sealDemoEnvironment({ record: mode === 'record' });
  process.env.DONNA_ACCESS_TOKEN = accessToken;
  // One parse at a time: the same order on every run, which is what lets a
  // recording and its replay see the same book at every step.
  process.env.INNGEST_PARSE_CONCURRENCY = '1';

  let seam = null;
  let spend = null;
  let recordedOnAtStart = null;
  let bookQuery = null;
  let pgHandle = null;
  let runtime = null;
  let webServer = null;
  let stopping = null;
  let up = false;
  let releaseUp = null;
  const stop = () => {
    stopping ||= (async () => {
      if (webServer) await new Promise((resolve) => webServer.close(resolve));
      if (runtime) await runtime.stop().catch(() => {});
      const { closeFirmDbPool } = await import('../server/donna/firmDb.js');
      await closeFirmDbPool().catch(() => {});
      // stop() leaves a server the demo attached to (one it did not start)
      // running; only the demo's own is stopped.
      pgHandle?.stop();
      if (ownTempDataDir && dataDir) rmSync(dataDir, { recursive: true, force: true });
      seam?.restore();
      sealed.undo();
    })();
    return stopping;
  };
  // Ctrl-C at any point stops what the demo started (its PostgreSQL first of
  // all) before the process ends; once the month is up it is the normal end.
  const onSignal = (signal) => {
    if (up) { releaseUp?.(); return; }
    console.error(`[demo] ${signal}: stopping`);
    stop().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // Started by another demo process (the fixed-locale re-run, or a pass of
  // the record loop): when that process is gone, even killed outright, stop.
  const onParentGone = () => onSignal('parent process gone');
  if (process.channel) {
    process.on('disconnect', onParentGone);
    process.channel.unref();
  }

  try {
    const { DEMO_CLIENT_ID, createRuntimeClient, loadFinnishDemo } = await import('./load_finnish_demo.mjs');

    // ── The seam, before any runtime module loads ──
    if (mode === 'replay') {
      const recordings = loadReplayRecordings(recordingsFile);
      const recordedHold = recordings.scenario?.held_back || null;
      if ((options.hold || null) !== recordedHold) {
        throw new DemoError({
          code: 'DEMO_HOLD_NOT_RECORDED',
          message: `demo: these recordings were made with ${recordedHold ? `"${recordedHold}" held back` : 'every document loaded (nothing held back)'}; `
            + `${options.hold ? `holding back "${options.hold}"` : 'loading every document'} would ask the models different questions. `
            + `${recordedHold ? `Run with --hold="${recordedHold}"` : 'Run without --hold'}, or record a month that holds it back: npm run demo:fi:record -- --hold="${options.hold || '…'}" --recordings=FILE`
        });
      }
      seam = installProviderReplay({
        recordings,
        rerecordHint: RERECORD_COMMAND,
        logger: console,
        onRequest: options.trace ? (entry) => appendFileSync(options.trace, `${JSON.stringify(entry)}\n`) : null,
        assertScope: async () => {
          if (!bookQuery) throw new ProviderReplayError({ code: PROVIDER_REPLAY_CODES.FOREIGN_BOOK, message: 'provider replay: the book is not open yet' });
          await assertDemoBookOnly({ query: bookQuery, clientId: DEMO_CLIENT_ID });
        }
      });
      for (const key of REPLAY_PROVIDER_KEY_ENV) process.env[key] = REPLAY_PLACEHOLDER_KEY;
      log(`replay: ${recordings.entries.length} recorded answers (${recordings.recorded_at || 'date unknown'}; ${Object.entries(recordedModels(recordings)).map(([p, m]) => `${p} ${m.join(', ')}`).join('; ')}); no provider is called`);
    } else {
      // Known before any money is spent: a recording that cannot say which
      // commit it was made on is not made.
      recordedOnAtStart = recordedOn();
      const realFetch = globalThis.fetch;
      const base = options.fill ? loadReplayRecordings(recordingsFile) : null;
      if (base && (base.scenario?.held_back || null) !== (options.hold || null)) {
        throw new DemoError({ code: 'DEMO_HOLD_NOT_RECORDED', message: `demo: --fill starts from recordings made with held_back ${base.scenario?.held_back || 'none'}; this pass holds back ${options.hold || 'nothing'}. Use the same --hold.` });
      }
      const baseByKey = new Map((base?.entries || []).map((entry) => [entry.key, { entry, served: 0 }]));
      const standInLanes = standInLanesOf(base?.entries);
      const answeredByStandIn = (classified) => answersFromStandIn({ classified, standIn: options.standIn, standInLanes });
      const { answerOpenAiStandIn } = options.standIn || standInLanes.size ? await import('./demo_fi_stand_ins.mjs') : {};
      if (standInLanes.size) log(`fill: OpenAI lanes the file holds as scripted stand-ins are answered by the stand-in again: ${[...standInLanes].sort().join(', ')}`);
      if (!options.fill) {
        if (!realKeys.ANTHROPIC_API_KEY) throw new DemoError({ code: 'DEMO_RECORD_KEY', message: '--record needs ANTHROPIC_API_KEY in the environment' });
        if (!options.standIn && !realKeys.OPENAI_API_KEY) throw new DemoError({ code: 'DEMO_RECORD_KEY', message: '--record needs OPENAI_API_KEY in the environment (or --stand-in=openai)' });
      }
      // A lane the stand-in answers still needs a key present to reach the
      // wire; the placeholder is not one and is never sent anywhere.
      for (const key of REPLAY_PROVIDER_KEY_ENV) if (!realKeys[key]) process.env[key] = REPLAY_PLACEHOLDER_KEY;
      if (options.standIn) process.env.OPENAI_API_KEY = REPLAY_PLACEHOLDER_KEY;
      const keyFor = { openai: realKeys.OPENAI_API_KEY, anthropic: realKeys.ANTHROPIC_API_KEY };
      const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
      spend = { usd: 0, cap_usd: capUsd, live_calls: 0, stand_in: 0, unpriced: 0, reused: 0, new_requests: 0, estimated_usd: 0, over_estimate: 0, stopped: null };
      const writeSpend = () => { if (options.report) writeFileSync(`${options.report}.spend.json`, `${JSON.stringify(spend)}\n`); };
      writeSpend();
      // The longest answer each lane gave, for the estimate of a call that
      // sets no output limit: from the file a fill starts from, else from the
      // committed recordings.
      const reference = base || (existsSync(DEFAULT_RECORDINGS) ? (() => { try { return loadReplayRecordings(DEFAULT_RECORDINGS); } catch { return null; } })() : null);
      const recordedUsage = laneUsageOf(reference?.entries);
      const laneOutput = laneOutputTokensOf(reference?.entries);
      const laneRatio = {};
      // The meter: refuse to start on a table that cannot price the month.
      for (const line of validatePriceTable({ prices: facts.prices, models: modelsOf(reference?.entries) })) log(`record: price ${line}`);
      const answerRequest = async (input, init, classified, identity) => {
        const held = identity ? baseByKey.get(identity.key) : null;
        if (!held) spend.new_requests += 1;
        if (answeredByStandIn(classified)) {
          spend.stand_in += 1;
          return { response: await answerOpenAiStandIn({ input, init, classified }), provenance: 'scripted_stand_in' };
        }
        if (held) {
          spend.reused += 1;
          return { response: recordedResponseFor(held.entry, identity, held.served++), provenance: held.entry.provenance };
        }
        if (!keyFor[classified.endpoint_class]) {
          spend.stopped ||= { reason: 'key_missing', lane: classified.lane, provider: classified.endpoint_class };
          throw new TypeError(`demo record: lane ${classified.lane} must be recorded live and needs ${classified.endpoint_class === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} in the environment or .env`);
        }
        // A model the facts file does not price is not called at all.
        const price = priceFor(facts.prices, classified.model_requested);
        if (!price) {
          spend.stopped ||= { reason: 'unpriced_model', lane: classified.lane, model: classified.model_requested };
          throw new TypeError(`demo record: ${classified.model_requested || 'an unnamed model'} has no price in ${path.relative(ROOT, FACTS_FILE)} (prices); not calling ${classified.lane}`);
        }
        // The cap holds before the call: it is made only if its estimate
        // fits in what is left. The output bound is checked first, so a call
        // that cannot fit is refused without even counting its input.
        const remaining = capUsd - spend.usd;
        const laneId = `${classified.endpoint_class}:${classified.lane}`;
        const laneOutputTokens = laneOutput[laneId] || null;
        const laneInputTokens = recordedUsage[laneId]?.input || null;
        const first = estimateCallUsd({ price, init, provider: classified.endpoint_class, laneOutputTokens, laneTokensPerUnit: laneRatio[laneId] || null, laneInputTokens });
        const counted = classified.endpoint_class === 'anthropic' && first.output_usd <= remaining
          ? await countAnthropicInputTokens({ fetchFn: realFetch, input, init })
          : null;
        const estimate = counted ? estimateCallUsd({ price, init, provider: classified.endpoint_class, laneOutputTokens, countedInputTokens: counted }) : first;
        // A meter that cannot read is a refusal, never a zero.
        if (meterRefuses({ estimateUsd: estimate.usd, spentUsd: spend.usd })) {
          spend.stopped ||= { reason: 'meter_not_finite', lane: classified.lane, model: classified.model_requested };
          throw new TypeError(`demo record: the cost of the next ${classified.lane} call cannot be estimated (${classified.model_requested}); not calling`);
        }
        if (spend.stopped?.reason === 'meter_not_finite') throw new TypeError(`demo record: the spend meter stopped reading; not calling ${classified.lane}`);
        if (estimate.usd > remaining) {
          spend.stopped ||= { reason: 'cap', lane: classified.lane, spent_usd: spend.usd, next_estimate_usd: estimate.usd };
          throw new TypeError(`demo record: spend cap ${capUsd.toFixed(2)} USD: ${spend.usd.toFixed(3)} spent, the next ${classified.lane} call is estimated at up to ${estimate.usd.toFixed(3)}; not calling`);
        }
        const response = await realFetch(input, init);
        // JSON or an event stream: the model and usage the answer reports.
        const answered = summarizeProviderResponse({ contentType: response.headers.get('content-type') || '', text: await response.clone().text() });
        const usd = priceUsage({ prices: facts.prices, model: answered.model || classified.model_requested, usage: answered.usage, provider: classified.endpoint_class });
        spend.live_calls += 1;
        spend.estimated_usd += estimate.usd;
        // What this call teaches about its lane, for the next estimate.
        const usedIn = (Number(answered.usage?.input_tokens ?? answered.usage?.prompt_tokens) || 0)
          + (Number(answered.usage?.cache_creation_input_tokens) || 0) + (Number(answered.usage?.cache_read_input_tokens) || 0);
        const usedOut = Number(answered.usage?.output_tokens ?? answered.usage?.completion_tokens) || 0;
        if (usedIn && estimate.bound_units) laneRatio[laneId] = Math.max(laneRatio[laneId] || 0, usedIn / estimate.bound_units);
        if (usedOut > (laneOutput[laneId] || 0)) laneOutput[laneId] = usedOut;
        // An answer that reports no usage is counted at its estimate.
        if (usd != null && !Number.isFinite(usd)) {
          // The answer came, but what it cost cannot be read: count its
          // estimate and make no further call this pass.
          spend.usd += estimate.usd;
          spend.stopped ||= { reason: 'meter_not_finite', lane: classified.lane, model: answered.model || classified.model_requested };
        } else if (usd == null) { spend.unpriced += 1; spend.usd += estimate.usd; } else {
          spend.usd += usd;
          if (usd > estimate.usd) { spend.over_estimate += 1; log(`record: ${classified.lane} cost ${usd.toFixed(4)} USD, more than its estimate ${estimate.usd.toFixed(4)}`); }
        }
        if (spend.usd >= capUsd) spend.stopped ||= { reason: 'cap', lane: classified.lane, spent_usd: spend.usd };
        if (spend.live_calls % 10 === 0) log(`record: ${spend.live_calls} live calls, ${spend.usd.toFixed(3)} USD of ${capUsd.toFixed(2)}`);
        log(`record: live ${classified.lane} (${classified.model_requested || 'model ?'})`);
        return { response, provenance: 'live' };
      };
      seam = installProviderRecorder({
        logger: console,
        secretValues: machineSecrets,
        answer: async (...args) => {
          try { return await answerRequest(...args); } finally { writeSpend(); }
        }
      });
      log(`record: ${options.fill ? 'fill from the existing recordings' : `live ${options.standIn ? 'anthropic; openai from the scripted stand-in' : 'openai and anthropic'}`}; cap ${capUsd.toFixed(2)} USD; writing ${path.relative(ROOT, recordingsFile)} only if the pass completes`);
    }

    // The pool's size and the rest of the appliance defaults, before the
    // first query opens the pool (the runtime applies the same, only where
    // unset, so both see one value).
    const { applyDesktopHostRuntimeDefaults } = await import('../server/donna/desktop/hostRuntimeDefaults.js');
    applyDesktopHostRuntimeDefaults(process.env);
    await assertDemoBuildRuns({ mode });

    // ── The database: read, refuse, and only then write ──
    if (options.databaseUrl) {
      process.env.DATABASE_URL = options.databaseUrl;
    } else {
      const { ensureLocalPostgres } = await import('../server/donna/desktop/pgSupervisor.js');
      // The demo's own cluster is initialised with C collation (see
      // assertDemoCollation); only initdb and its server see this, and only
      // for the demo's own data folder. A server already running on the
      // folder is used and left running ('attach'): the demo stops only a
      // server it started.
      assertSocketPathFits(dataDir, Number(process.env.DONNA_DESKTOP_PG_PORT || 5433));
      const priorLocale = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
      process.env.LC_ALL = 'C';
      process.env.LANG = 'C';
      try {
        pgHandle = ensureLocalPostgres({ dataDir, onActive: 'attach', logger: { log: (l) => console.log(l), error: (l) => console.error(l) } });
      } finally {
        for (const [key, value] of Object.entries(priorLocale)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
      process.env.DATABASE_URL = pgHandle.databaseUrl;
      log(`data folder ${dataDir}${pgHandle.attached ? ' (its PostgreSQL was already running and is left running)' : ''}`);
    }
    process.env.DONNA_DESKTOP_BLOB_DIR = dataDir ? path.join(dataDir, 'documents') : path.join(sealed.cwd, 'documents');
    const { queryFirmDb, withFirmDbClient } = await import('../server/donna/firmDb.js');
    await assertDemoCollation({ query: queryFirmDb });
    // Refuse a book that holds anything but the demo, before the demo writes
    // anything into it: no schema, no migration.
    await assertDemoBookOnly({ query: queryFirmDb, clientId: DEMO_CLIENT_ID });
    if ((mode === 'record' || options.verify) && !(await bookIsEmpty(queryFirmDb))) {
      throw new DemoError({ code: 'DEMO_BOOK_NOT_EMPTY', message: `${mode === 'record' ? '--record' : '--verify'} needs an empty book: every request of the month must be made from the start` });
    }
    bookQuery = queryFirmDb;
    mkdirSync(process.env.DONNA_DESKTOP_BLOB_DIR, { recursive: true });
    if (options.databaseUrl) await queryFirmDb(STORAGE_STUB_SQL);
    log('applying migrations…');
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate_firm_db.js')], {
        cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', options.quietRuntime ? 'pipe' : 'inherit', options.quietRuntime ? 'pipe' : 'inherit']
      });
      if (options.quietRuntime) {
        const lines = String(out || '').split('\n');
        log(`migrations: ${lines.filter((l) => l.startsWith('Applied')).length} applied, ${lines.filter((l) => l.startsWith('Skipping')).length} already applied`);
      }
    } catch (error) {
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
      throw new DemoError({ code: 'DEMO_MIGRATIONS_FAILED', message: `demo: migrations failed (scripts/migrate_firm_db.js exit ${error.status ?? '?'}); its output is above` });
    }
    if (mode === 'replay') {
      const { recordProviderReplaySession } = await import('../server/donna/providerReplaySession.js');
      await recordProviderReplaySession({ withFirmDbClientFn: withFirmDbClient, replay: seam.state, clientId: DEMO_CLIENT_ID, firmId: DEMO_FIRM_ID });
    }

    const { createDonnaRuntimeServer } = await import('../server/donna/desktop/runtimeServer.js');
    runtime = await createDonnaRuntimeServer({
      listen: { host: '127.0.0.1', port },
      logger: options.quietRuntime ? { log: () => {}, error: console.error, warn: () => {} } : console,
      // No provider-key file: the keys are the ones set above, and nothing else.
      providerKeyFiles: []
    });
    // Take over dispatch: the same manifest on a virtual clock (manifestTicker.js).
    // The runtime's own scheduler runs on the wall clock; under the demo it
    // is stopped and may not be started again by a later readiness renewal,
    // so this process has exactly one dispatcher (the ticker below).
    if (runtime.scheduler) {
      await runtime.scheduler.stop();
      runtime.scheduler.start = async () => {};
    }
    const { createManifestTicker, makeManifestClock } = await import('../server/donna/desktop/manifestTicker.js');
    const { makePromptDueEntityHeal } = await import('../server/donna/runtimeReadiness.js');
    const clock = makeManifestClock(new Date());
    await queryFirmDb('update local_job_cron_state set last_enqueued_tick = $1::timestamptz', [clock.now().toISOString()]);
    const heal = makePromptDueEntityHeal({ withFirmDbClientFn: withFirmDbClient, logger: console });
    const ticker = createManifestTicker({
      manifest: runtime.manifest.filter((entry) => !VIRTUAL_CLOCK_SKIP.has(entry.functionId)),
      query: (text, params) => queryFirmDb(text, params),
      clock,
      logger: options.quietRuntime ? { log: () => {}, error: console.error, warn: () => {} } : console,
      workerId: `demo-${process.pid}`,
      maxConcurrent: 1,
      onQueueActivity: (activity) => heal(activity)
    });

    if (!options.noWeb) {
      const distDir = path.join(ROOT, 'dist');
      if (existsSync(path.join(distDir, 'index.html'))) {
        const { createLocalWebServer } = await import('./local_web.mjs');
        webServer = createLocalWebServer({ distDir, runtimePort: port });
        await new Promise((resolve, reject) => { webServer.once('error', reject); webServer.listen(webPort, process.env.DONNA_LOCAL_WEB_HOST || '127.0.0.1', resolve); });
        log(`web app on http://127.0.0.1:${webPort}/firms`);
      } else {
        log('no built web app (dist/); run `npm run build` to look at the book in a browser');
      }
    }

    // ── The month ──
    const client = createRuntimeClient({ baseUrl: `http://127.0.0.1:${port}`, accessToken });
    const exclude = options.hold ? [options.hold] : [];
    const loaded = await loadFinnishDemo({
      client, allDocuments: true, exclude, log: (line) => console.log(line),
      // The company's ALV registration, from the facts file, through the
      // operator's profile route (the pack states it; the loader does not).
      beforeDocuments: async ({ firmId: mintedFirm, clientId: demoClient }) => {
        const saved = await client.postJson(`/api/donna/firms/clients/${encodeURIComponent(demoClient)}/profile`, {
          firm_id: mintedFirm || DEMO_FIRM_ID,
          profile_patch: { alv_registration: facts.alv_registration }
        });
        if (saved.status !== 200) throw new Error(`Recording the ALV registration failed (HTTP ${saved.status}): ${saved.text.slice(0, 300)}`);
        log(`ALV registration recorded: ${facts.alv_registration.status} from ${facts.alv_registration.registered_from}, ${facts.alv_registration.tax_period}ly`);
      }
    });
    const firmId = loaded.firmId || DEMO_FIRM_ID;
    if (firmId !== DEMO_FIRM_ID) throw new Error(`the demo firm was minted as ${firmId}, not ${DEMO_FIRM_ID}`);
    const clientId = DEMO_CLIENT_ID;
    const ids = { query: queryFirmDb, firmId, clientId };

    const docCount = Number((await queryFirmDb('select count(*)::int as n from documents where firm_id = $1 and client_id = $2', [firmId, clientId])).rows[0].n);
    await ticker.tick({ advanceMs: 0, functions: ['parse-document'], maxRounds: docCount * 4, settleTimeoutMs: 3_600_000, untilNoPending: true });
    const settle = async (label) => {
      let quiet = 0; let rounds = 0; let last = null;
      while (rounds < SETTLE.max_rounds && quiet < SETTLE.quiet_rounds) {
        rounds += 1;
        await ticker.tick({ advanceMs: SETTLE.advance_ms, settleTimeoutMs: 3_600_000, untilNoPending: true });
        const now = await fingerprintOf(ids);
        quiet = now === last ? quiet + 1 : 0;
        last = now;
      }
      log(`${label}: ${quiet >= SETTLE.quiet_rounds ? 'at rest' : 'NOT at rest'} after ${rounds} rounds (${Math.round((Date.now() - startedAt) / 1000)} s)`);
      return { atRest: quiet >= SETTLE.quiet_rounds, rounds };
    };
    let rest = await settle('first rest');

    const answered = [];
    for (let round = 1; round <= ANSWER_ROUNDS; round += 1) {
      const open = (await queryFirmDb(
        `select r.id, r.transaction_id, r.status, t.transaction_date::text as transaction_date, t.money_in, t.money_out
           from client_evidence_requests r left join transactions t on t.id = r.transaction_id and t.firm_id = r.firm_id
          where r.firm_id = $1 and r.client_id = $2 and r.status in ('draft', 'open') order by r.created_at, r.id`, [firmId, clientId])).rows
        .filter((ask) => !answered.some((a) => a.ask_id === ask.id));
      const toGive = open.map((ask) => answerFor({ ask, transaction: ask.transaction_id ? ask : null, answers: facts.owner_answers || {} })).filter(Boolean);
      if (!toGive.length) break;
      for (const answer of toGive) answered.push(await giveOwnerAnswer({ client, firmId, answer }));
      rest = await settle(`rest after answers, round ${round}`);
    }

    const endState = await readDemoEndState(ids);
    const summary = {
      mode,
      at_rest: rest.atRest,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      documents_loaded: loaded.uploaded.length,
      held_back: options.hold || null,
      answered,
      end_state: endState,
      provider: mode === 'replay'
        ? { served: seam.served.length, unrecorded: seam.missed.map(({ error, request, long_texts, ...rest }) => rest), unused: seam.unused(), overserved: seam.overserved(), network_refused: seam.refusedNetwork }
        : {
          calls: seam.ledger.length,
          spend,
          by_lane: seam.ledger.reduce((t, r) => ({ ...t, [r.lane]: (t[r.lane] || 0) + 1 }), {}),
          // Attempts that kept nothing (a 529 the lane then retried well is
          // one), and the requests that ended the pass with no answer at all.
          dropped_attempts: seam.ledger.filter((r) => !r.kept).map(({ lane, provider, status, dropped }) => ({ lane, provider, status, dropped })),
          unanswered: seam.unanswered(),
          network_refused: seam.refusedNetwork
        }
    };
    if (mode === 'record') {
      // The file is replaced only by a complete set from a pass at rest: no
      // answer dropped, the cap never reached, nothing refused for want of a
      // key or a price. Written beside the target and moved over it, so the
      // committed file is either the old one or the new one, whole.
      const incomplete = [
        !rest.atRest && 'the book did not come to rest',
        summary.provider.unanswered.length && `${summary.provider.unanswered.length} request(s) ended the pass with no kept answer (${[...new Set(summary.provider.unanswered.map((d) => `${d.lane} ${d.last}`))].join(', ')})`,
        spend.stopped && `live calls stopped: ${spend.stopped.reason}${spend.stopped.lane ? ` at ${spend.stopped.lane}` : ''}`
      ].filter(Boolean);
      if (incomplete.length) {
        summary.recordings = { written: false, why: incomplete };
      } else {
        const entries = seam.entries();
        const file = packRecordings({
          format: PROVIDER_REPLAY_FORMAT,
          identity: PROVIDER_REQUEST_IDENTITY_VERSION,
          pack: 'fi-kultalanka-2025-02',
          recorded_at: new Date().toISOString().slice(0, 10),
          recorded_on: recordedOnAtStart,
          scenario: { held_back: options.hold || null, owner_answers: answered.map((a) => a.line) },
          note: 'Recorded provider answers for the zero-key demo (npm run demo:fi). Synthetic pack data only; provider ids are replaced, no header is kept. Re-record with `npm run demo:fi:record`.',
          entries
        });
        const text = `${JSON.stringify(file, null, 1)}\n`;
        const leaks = findSecretShapes(text, { extraValues: machineSecrets });
        if (leaks.length) throw new Error(`refusing to write recordings: secret-shaped content (${leaks.map((l) => l.name).join(', ')})`);
        mkdirSync(path.dirname(recordingsFile), { recursive: true });
        const temp = `${recordingsFile}.writing-${process.pid}`;
        writeFileSync(temp, text);
        renameSync(temp, recordingsFile);
        summary.recordings = { written: true, file: path.relative(ROOT, recordingsFile), entries: entries.length, bytes: Buffer.byteLength(text), models: recordedModels({ entries }) };
        log(`wrote ${entries.length} recordings (${Math.round(Buffer.byteLength(text) / 1024)} KB) to ${path.relative(ROOT, recordingsFile)}`);
      }
      log(`live spend ${spend.usd.toFixed(3)} USD over ${spend.live_calls} calls (${spend.unpriced} without usage, counted at their estimate); ${spend.stand_in} from the stand-in; ${spend.reused} from the existing recordings; ${spend.new_requests} not in them`);
    }
    if (options.report) writeFileSync(options.report, `${JSON.stringify(summary, null, 2)}\n`);
    if (options.report && mode === 'replay' && seam.missed.length) {
      // What the code asked for that the recordings do not hold, in full, to
      // diff against the recording (data/demo-replay/…, entry by lane).
      writeFileSync(`${options.report}.unrecorded.json`, `${JSON.stringify(seam.missed.map(({ error, ...rest }) => rest), null, 1)}\n`);
      log(`the unrecorded requests are in ${options.report}.unrecorded.json`);
    }
    printSummary(summary);

    if (mode === 'replay' && seam.missed.length) throw seam.missed[0].error;
    if (mode === 'record' && !summary.recordings.written) {
      throw new DemoError({ code: 'DEMO_RECORDING_INCOMPLETE', message: `demo record: no recordings written — ${summary.recordings.why.join('; ')}. ${path.relative(ROOT, recordingsFile)} is unchanged.` });
    }
    if (!rest.atRest) {
      throw new DemoError({
        code: 'DEMO_NOT_AT_REST',
        message: `demo: the book did not come to rest (it was still changing after ${rest.rounds} rounds of five virtual minutes), so the month above is not finished. `
          + 'Run again with --report=FILE --trace=FILE to see what kept changing.'
      });
    }
    if (options.verify && (summary.provider.unused.length || summary.provider.overserved.length)) {
      const byLane = (rows, n) => Object.entries(rows.reduce((t, u) => ({ ...t, [u.lane]: (t[u.lane] || 0) + n(u) }), {})).map(([lane, k]) => `${lane} ${k}`).join(', ');
      throw new DemoError({
        code: 'DEMO_VERIFY_MISMATCH',
        message: `demo verify: the run and the recordings differ — ${[
          summary.provider.unused.length && `recorded answers never asked for: ${byLane(summary.provider.unused, (u) => u.recorded - u.served)}`,
          summary.provider.overserved.length && `requests asked more often than recorded: ${byLane(summary.provider.overserved, (u) => u.served - u.recorded)}`
        ].filter(Boolean).join('; ')}. Re-record with \`${RERECORD_COMMAND}\`.`
      });
    }
    if (options.exitAtRest) return summary;

    log(`sign in at http://127.0.0.1:${webPort}/firms with the access key ${accessToken}`);
    log(`the owner's view: http://127.0.0.1:${webPort}/portal/${clientId}`);
    if (options.hold) log(`upload "${options.hold}" from data/evals/fixtures/fi-kultalanka-2025-02/sources there to watch it read, coded and matched`);
    log('the book keeps ticking (five virtual minutes every two seconds). Ctrl-C to stop.');
    await new Promise((resolve) => {
      up = true;
      releaseUp = resolve;
      (async () => {
        while (up && !stopping) {
          await ticker.tick({ advanceMs: SETTLE.advance_ms, settleTimeoutMs: 600_000 }).catch((error) => { if (!stopping) console.error(`[demo] tick failed: ${error.message}`); });
          await sleep(2000);
        }
      })();
    });
    up = false;
    return summary;
  } finally {
    await stop();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('disconnect', onParentGone);
  }
};

export const printSummary = (summary) => {
  const s = summary.end_state;
  const fmt = (rows, keys) => rows.map((r) => `${keys.map((k) => r[k] ?? '-').join('/')} ${r.n}`).join(', ') || 'none';
  log(`${summary.mode} ${summary.at_rest ? 'at rest' : 'NOT at rest'} in ${summary.seconds} s`);
  log(`journals: ${fmt(s.journals, ['status'])}`);
  log(`bank lines (coding/convergence): ${fmt(s.transactions_by_state, ['coding_state', 'convergence_state'])}`);
  log(`documents (parse/convergence): ${fmt(s.documents_by_state, ['parse_status', 'convergence_state'])}`);
  log(`matches: ${fmt(s.matches_by_status, ['status'])}; asks: ${fmt(s.asks_by_status, ['status'])}`);
  log(`posted lines by tax code: ${fmt(s.vat_lines, ['tax_type'])}`);
  log(`models on the coded lines: ${s.models.map((m) => m.model).join(', ') || 'none'}`);
};

// `npm run demo:fi:record`: the live pass, then fill passes until one asks
// nothing new, then a --verify replay with no key. With --fill it starts from
// the committed recordings and runs only the fill passes and the verify.
// Why passes: a live run takes minutes and the replay seconds, and some of
// the runtime's work is paced by the wall clock (readiness renewal, settle
// gates), so a few questions are asked in a different state at replay
// speed. A fill pass runs a fresh book at replay speed, answers what the
// recordings hold from them and calls live only for what they miss; the file
// it writes holds exactly the requests that pass made. Every pass is its own
// sealed process on its own new book (removed after it). The passes work on
// a copy; the committed file is replaced only after the verify passes. One
// spend cap covers every pass: each is given what is left of it.
const runChild = (args, env = process.env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
  child.on('exit', (code) => resolve(code));
});
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
export const RECORD_MAX_FILL_PASSES = 4;
const recordAll = async (options, argv) => {
  if (options.databaseUrl) {
    throw new DemoError({ code: 'DEMO_RECORD_FRESH_BOOKS', message: '`demo:fi:record` gives every pass a fresh book of its own and cannot with --database-url; run single passes yourself with --record --exit-at-rest [--fill] --database-url=… on new empty databases' });
  }
  // Every pass would stop on an uncommitted runtime, or on a price table that
  // cannot meter the spend, the same way: say it once, before any pass.
  await assertDemoBuildRuns({ env: { ...process.env }, mode: 'record' });
  {
    const facts = JSON.parse(readFileSync(FACTS_FILE, 'utf8'));
    const reference = existsSync(path.resolve(options.recordings || DEFAULT_RECORDINGS)) ? loadReplayRecordings(path.resolve(options.recordings || DEFAULT_RECORDINGS)) : null;
    for (const line of validatePriceTable({ prices: facts.prices, models: modelsOf(reference?.entries) })) log(`record: price ${line}`);
  }
  const committed = path.resolve(options.recordings || DEFAULT_RECORDINGS);
  const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'donna-demo-passes-'));
  const working = path.join(temp, 'recordings.json');
  const passthrough = argv.filter((a) => !/^--(record|fill|verify|exit-at-rest|no-web|report|data-dir|database-url|recordings|cap-usd)(=|$)/.test(a));
  let spent = 0;
  const pass = async (name, args, env) => {
    const report = path.join(temp, `${name}.json`);
    const record = args.includes('--record');
    const remaining = capUsd - spent;
    if (record && remaining <= 0) { log(`${name}: not started, the spend cap of ${capUsd.toFixed(2)} USD is used up`); return { code: 1, report: null, spend: null }; }
    // Each pass's book in its own short folder directly under the system's
    // temporary folder (PostgreSQL's socket lives inside it).
    const book = mkdtempSync(path.join(os.tmpdir(), 'ddp-'));
    const code = await runChild([...args, '--exit-at-rest', '--no-web', `--data-dir=${book}`, `--report=${report}`, `--recordings=${working}`,
      ...(record ? [`--cap-usd=${remaining.toFixed(6)}`] : []), ...passthrough.filter((a) => record || !/^--stand-in/.test(a))], env);
    rmSync(book, { recursive: true, force: true });
    // What the pass spent, from its sidecar (written after every answer, so
    // it holds even when the pass failed); what it asked, from its report.
    const spend = readJson(report)?.provider?.spend || readJson(`${report}.spend.json`);
    if (spend) spent += Number.isFinite(spend.usd) ? spend.usd : Infinity;
    log(`${name}: exit ${code}; ${spent.toFixed(3)} of ${capUsd.toFixed(2)} USD spent so far`);
    return { code, report: readJson(report), spend };
  };
  try {
    let first = 2;
    if (options.fill) {
      if (!existsSync(committed)) throw new DemoError({ code: 'DEMO_NO_RECORDINGS', message: `--fill starts from ${path.relative(ROOT, committed)}, which does not exist` });
      copyFileSync(committed, working);
      first = 1;
    } else {
      log('pass 1: live');
      if ((await pass('live', ['--record'])).code !== 0) return { code: 1, temp };
    }
    let settled = false;
    for (let n = first; n < first + RECORD_MAX_FILL_PASSES; n += 1) {
      log(`pass ${n}: fill at replay speed`);
      const result = await pass(`fill-${n}`, ['--record', '--fill']);
      if (result.code !== 0) return { code: 1, temp };
      if (result.spend && !result.spend.new_requests) { settled = true; break; }
    }
    if (!settled) { log(`the recordings did not settle in ${RECORD_MAX_FILL_PASSES} fill passes; ${path.relative(ROOT, committed)} is unchanged`); return { code: 1, temp }; }
    log('verify: replay on a fresh book with no key');
    const verifyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !REPLAY_PROVIDER_KEY_ENV.includes(k)));
    if ((await pass('verify', ['--verify'], verifyEnv)).code !== 0) { log(`verify failed; ${path.relative(ROOT, committed)} is unchanged`); return { code: 1, temp }; }
    mkdirSync(path.dirname(committed), { recursive: true });
    const staged = `${committed}.writing-${process.pid}`;
    copyFileSync(working, staged);
    renameSync(staged, committed);
    log(`recordings verified and written to ${path.relative(ROOT, committed)} (${spent.toFixed(3)} USD spent)`);
    rmSync(temp, { recursive: true, force: true });
    return { code: 0, temp: null };
  } catch (error) {
    console.error(`[demo] ${error.code ? `${error.code}: ` : ''}${error.message}`);
    return { code: 1, temp };
  }
};

// Node reads its locale (Intl's default, so every toLocaleString) once, at
// start: setting LANG inside the process is too late. A caller whose time
// zone or locale is not the demo's fixed one is run again, once, as a child
// with them fixed, and its exit code is this command's.
export const needsFixedLocaleRun = (env = process.env) => Object.entries(DEMO_FIXED_ENV).some(([k, v]) => env[k] !== v)
  || Object.keys(env).some((k) => /^LC_/.test(k) && !(k in DEMO_FIXED_ENV));
const runWithFixedLocale = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^LC_/.test(k)));
  Object.assign(env, DEMO_FIXED_ENV);
  // An IPC channel, so the child notices when this process is gone, even
  // killed outright (SIGKILL): it then stops what it started and exits.
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
  log(`time zone and locale fixed (${Object.entries(DEMO_FIXED_ENV).map(([k, v]) => `${k}=${v}`).join(' ')}): running as process ${child.pid}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal === 'SIGINT' ? 130 : 143)));
};

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun && needsFixedLocaleRun()) runWithFixedLocale();
else if (isDirectRun) {
  let options;
  const argv = process.argv.slice(2);
  try { options = parseDemoArgs(argv); } catch (error) { console.error(`[demo] ${error.message}`); process.exit(2); }
  if (options.record) {
    const loaded = loadRecordKeys(process.env);
    if (loaded.length) log(`record: ${loaded.join(', ')} from .env`);
  }
  if (options.record && !options.exitAtRest) {
    // The record loop's own parent gone: end, so its passes notice in turn.
    if (process.channel) { process.on('disconnect', () => process.exit(1)); process.channel.unref(); }
    recordAll(options, argv).then(({ code, temp }) => {
      if (temp) log(`the passes' reports are in ${temp}`);
      process.exit(code);
    }, (error) => {
      console.error(`[demo] ${error.code ? `${error.code}: ` : ''}${error.message}`);
      process.exit(error?.exitCode || 1);
    });
  } else runDemo(options).then(
    () => process.exit(0),
    (error) => {
      console.error(`[demo] ${error.code ? `${error.code}: ` : ''}${error.message}`);
      process.exit(error?.code === PROVIDER_REPLAY_CODES.FOREIGN_BOOK ? 3 : (error?.exitCode || 1));
    }
  );
}
