#!/usr/bin/env node
// Disposable real-PG execution for AE-7. Never reads app database settings or
// dotenv. The worker has a clean environment and sees only raw synthetic inputs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { prepareCiHostPostgres } from './prepare_ci_host_postgres.js';
import { assertNotApplianceCluster } from '../server/donna/testSupport/applianceHarness.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERSION = 'ae7.runtime-diagnostic.v1';
const errorReceipt = (error) => ({ code: error.code || 'AE7_RUNTIME_DEPENDENCY_FAILED', message: error.message });
const incomplete = (code, operation, reason) => ({ status: 'INCOMPLETE', code, operation, reason });

export function assertAeDiagnosticDatabase(url) {
  if (!url) throw Object.assign(new Error('Supply the disposable PostgreSQL admin URL via DONNA_PG_TEST_URL; app database configuration is never used.'), { code: 'AE7_DISPOSABLE_POSTGRES_REQUIRED' });
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw Object.assign(new Error('AE-7 only accepts an explicitly supplied local disposable PostgreSQL host.'), { code: 'AE7_DISPOSABLE_POSTGRES_REQUIRED' });
  }
  return parsed;
}

export async function migrateAeDiagnosticDatabase(databaseUrl) {
  await prepareCiHostPostgres({ databaseUrl });
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const files = (await readdir(join(ROOT, 'db/migrations'))).filter((file) => file.endsWith('.sql')).sort();
  const hashes = [];
  try {
    for (const file of files) {
      const sql = await readFile(join(ROOT, 'db/migrations', file), 'utf8');
      try {
        await db.query('begin');
        await db.query(sql);
        await db.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.replace(/\.sql$/, '')]);
        await db.query('commit');
      } catch (error) { await db.query('rollback'); throw Object.assign(error, { message: `${file}: ${error.message}` }); }
      hashes.push([file, createHash('sha256').update(sql).digest('hex')]);
    }
    return { status: 'PASS', count: files.length, latest: files.at(-1),
      digest: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
  } finally { await db.end(); }
}

function childPhase({ contextPath, phase, output, directory, databaseUrl }) {
  // No provider, app token, remote endpoint or customer configuration is inherited.
  const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
    DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: '4', DONNA_DEFAULT_FIRM_ID: 'unused-ae7-default',
    DONNA_DESKTOP_BLOB_DIR: join(directory, 'blobs'), DONNA_DESKTOP_SCHEDULER: 'on',
    DONNA_ACCESS_TOKEN: 'ae7-isolated-local-access', AUTO_AI_CODING_ENABLED: '0',
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', INNGEST_EVENT_KEY: '', INNGEST_SIGNING_KEY: '',
  };
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts/eval_world_ae_runtime_worker.js'), contextPath, phase, output],
      { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    const capture = (chunk) => { logs = (logs + chunk.toString()).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      clearTimeout(timeout);
      try {
        const receipt = JSON.parse(await readFile(output, 'utf8'));
        const expectedExit = code === 0 || (phase === 'intake' && code === 86 && receipt.observation);
        resolveChild({ ...receipt, exitCode: code, signal, ...(!expectedExit ? {
          blocker: { code: 'AE7_WORKER_EXIT_UNEXPECTED', message: `Worker ${phase} exited ${code} (${signal || 'no signal'}).` },
        } : {}) });
      } catch { reject(Object.assign(new Error(`Worker ${phase} produced no receipt (exit ${code}, signal ${signal}): ${logs}`), { code: 'AE7_WORKER_RECEIPT_MISSING' })); }
    });
  });
}

export function summarizeAeRuntimeOrders(orders) {
  const scoped = (name, predicate) => ({ name, status: orders.length === 2 && orders.every(predicate) ? 'PASS' : 'INCOMPLETE',
    scope: 'two-source diagnostic only; not the six-world AE-7 certificate' });
  const prerequisites = [
    scoped('source_intake', (r) => r.intake?.observation?.documents.length === 2),
    scoped('persisted_observer', (r) => Boolean(r.resume?.observation?.terminal && r.replay?.observation?.terminal)),
    scoped('restart_queued_work', (r) => r.intake?.exitCode === 86 && r.intake.pid !== r.resume?.pid
      && r.intake.observation.jobs.some((job) => job.function_id === 'parse-document' && job.status === 'pending'
        && job.attempt_count === 0 && r.resume?.observation?.jobs.some((after) => after.id === job.id
          && after.payload.parse_run_id === job.payload.parse_run_id && after.attempt_count > job.attempt_count))),
    scoped('retirement_zero_residue', (r) => r.retire?.deletion?.residue_verified === true
      && r.retire?.residue?.residue_rows === 0 && r.retire?.blobResidue === 0 && r.retire?.blockers?.length === 0),
  ];
  const blockers = [];
  for (const order of orders) {
    for (const phase of ['intake', 'resume', 'replay', 'retire']) {
      const result = order[phase];
      if (result?.blocker) blockers.push({ order: order.order, phase, ...result.blocker, status: 'INCOMPLETE' });
      for (const blocker of result?.blockers || []) blockers.push({ order: order.order, phase, ...blocker });
    }
    const observed = order.replay?.observation;
    for (const doc of observed?.documents || []) if (doc.parse_status !== 'completed') {
      blockers.push({ order: order.order, entity: doc.id, operation: 'dispatchQueuedParseJobsOnce',
        status: 'INCOMPLETE', code: 'AE7_DOCUMENT_PARSE_INCOMPLETE', persisted: doc,
        durableJob: observed.jobs.find((job) => job.payload.document_id === doc.id) || null });
    }
    for (const row of observed?.transactions || []) if (row.convergence_state !== 'auto_reconciled') {
      blockers.push({ order: order.order, entity: row.id, operation: 'postLedgerPeriodInDb',
        status: 'INCOMPLETE', code: row.convergence_state === 'on_owner' ? 'AE7_OWNER_FACT_PENDING' : 'AE7_TRANSACTION_NON_TERMINAL', persisted: row });
    }
  }
  return { prerequisites, blockers };
}

export async function runAeRuntimeDiagnostic({ postgresUrl = process.env.DONNA_PG_TEST_URL, runToken, actorId } = {}) {
  const report = { version: VERSION, status: 'INCOMPLETE', scope: 'ordinary AE LLC, one AED bank movement and one invoice; zero-provider diagnostic',
    completeBooks: false, fullAe7Acceptance: false, transport: 'raw synthetic PDF/CSV; model transport unavailable; no recorded verdicts',
    spend: { modelProviderCalls: 0, externalCalls: 0, amountUsd: '0.00' }, orders: [], prerequisites: [], blockers: [] };
  let directory, admin, databaseName;
  let databaseCreated = false;
  try {
    const url = assertAeDiagnosticDatabase(postgresUrl);
    if (!/^[a-z0-9-]{1,48}$/.test(runToken || '') || !actorId || actorId === 'system') {
      throw Object.assign(new Error('A lowercase runToken and attributed actorId are required.'), { code: 'AE7_RUN_IDENTITY_REQUIRED' });
    }
    directory = await mkdtemp(join(tmpdir(), 'ae7-runtime-'));
    // CREATE, never adopt an existing database. Names carry unique scratch identity.
    databaseName = `ae7_runtime_${directory.split('-').at(-1).toLowerCase()}_${process.pid}`;
    await assertNotApplianceCluster({ adminUrl: postgresUrl, scratchDbName: databaseName, objectRoot: directory });
    admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    databaseCreated = true;
    url.pathname = `/${databaseName}`;
    const databaseUrl = url.toString();
    report.schema = await migrateAeDiagnosticDatabase(databaseUrl);
    for (const order of ['document_first', 'bank_first']) {
      const firmId = `eaw-${runToken}-${order.replace('_', '-')}`;
      const contextPath = join(directory, `${order}.json`);
      await writeFile(contextPath, JSON.stringify({ firmId, clientId: `${firmId}-client-1`, actor: { type: 'operator', id: actorId }, order }));
      const result = { order, firmId };
      report.orders.push(result);
      try {
        for (const phase of ['intake', 'resume', 'replay']) {
          result[phase] = await childPhase({ contextPath, phase, output: join(directory, `${order}-${phase}.json`), directory, databaseUrl });
          if (result[phase].blocker) break;
        }
      } finally {
        result.retire = await childPhase({ contextPath, phase: 'retire', output: join(directory, `${order}-retire.json`), directory, databaseUrl });
      }
    }
    Object.assign(report, summarizeAeRuntimeOrders(report.orders));
  } catch (error) { report.blockers.push({ status: 'INCOMPLETE', operation: 'diagnostic_setup_or_worker', ...errorReceipt(error) }); }
  finally {
    if (admin) {
      try {
        if (databaseCreated) { await admin.query(`drop database if exists "${databaseName}"`); report.scratchDatabaseRemoved = true; }
      } catch (error) { report.blockers.push({ status: 'INCOMPLETE', operation: 'scratch_database_cleanup', ...errorReceipt(error) }); }
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  report.remaining = [
    incomplete('AE7_FULL_PERIOD_NOT_EXECUTED', 'six lifecycle worlds', 'This bounded diagnostic never certifies the 68 offline obligations.'),
    incomplete('AE7_CONVERGENCE_EPOCH_NOT_RUN', 'reconciliation/coder/ask workers', 'Only the parse queue and ordinary bulk-post operation run; automatic coding is disabled in this zero-provider diagnostic.'),
    incomplete('AE7_MODEL_TRANSPORT_REQUIRED', 'parse/reconcile/code/owner answer', 'Paid runs are not authorized; recorded transport is allowed but not implemented in this slice.'),
    incomplete('AE7_WRITER_CRASH_MATRIX_NOT_RUN', 'post/lock/archive/export/retire', 'Queue restart evidence does not satisfy the ten existing writer crash boundaries.'),
    incomplete('AE7_FINAL_BOOKS_NOT_PROVEN', 'period close', 'Owner-pending facts and unchanged limbo are not final books; statutory/AE VAT dependencies remain separate slices.'),
  ];
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const receipt = await runAeRuntimeDiagnostic({ runToken: args.includes('--run-token') ? value('--run-token') : null,
    actorId: args.includes('--actor-id') ? value('--actor-id') : null });
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.includes('--output')) await writeFile(resolve(value('--output')), json, { flag: 'wx' });
  else process.stdout.write(json);
  process.exitCode = 2; // Diagnostic remains INCOMPLETE even when its bounded probes pass.
}
