// Offline completion probes. Creates and drops its OWN full-schema database;
// never connects application writers to the supplied administrative database.
// Exit 0: all probes/assessments pass; 2: completion gaps or open proof;
// 1: audit execution failed (not evidence that an invariant passed).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkRepositoryBoundary } from './check-jurisdiction-boundary.mjs';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../server/donna/db/pool.js';
import { seedPackPaletteChartWithClient, postLedgerAdjustmentInDb, postDocumentSettlementJournalWithClient } from '../server/donna/db/ledger.js';
import { createCloseArchiveInDb } from '../server/donna/db/close.js';
import { deduplicateMerchants } from '../server/donna/merchantLookup.js';
import { recordCodingPolicyFailure } from '../server/donna/codingPolicyRecovery.js';
import { buildCaseHealth } from '../server/donna/caseHealth.js';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.DONNA_PG_TEST_URL) throw new Error('Set DONNA_PG_TEST_URL to the administrative database on a task-owned loopback PostgreSQL host.');
const url = new URL(process.env.DONNA_PG_TEST_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  throw new Error('This audit requires a task-owned, loopback PostgreSQL host.');
}
const database = `donna_jn_audit_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: url.toString() });
const checks = [];
const record = (id, invariant, passed, observed) => checks.push({ id, invariant, status: passed ? 'PASS' : 'GAP', observed });
let pool;
let created = false;
const closed = [];
let providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { providerCalls += 1; throw new Error('External requests are forbidden in the completion audit.'); };
try {
  await admin.connect();
  await admin.query(`create database "${database}"`);
  created = true;
  url.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  pool.on('connect', connection => closed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../db/migrations/', import.meta.url);
  const files = (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort();
  for (const file of files) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'jurisdiction-completion-audit';
  await pool.query("insert into firms (id,name,slug) values ($1,'Audit fixture','jurisdiction-audit')", [firmId]);
  const seed = async (id, jurisdiction, profile = {}) => {
    await pool.query('insert into clients (id,firm_id,company_name,jurisdiction,profile) values ($1,$2,$1,$3,$4)', [id, firmId, jurisdiction, profile]);
  };

  const boundary = checkRepositoryBoundary(root);
  record('JN-A0', 'No unapproved direct country imports', boundary.errors.length === 0, {
    modules: boundary.modules.length, edges: boundary.edges.length,
    debt: boundary.baseline.edges.filter(edge => edge.disposition === 'debt').length,
    computed: boundary.computedImports, errors: boundary.errors
  });

  for (const [id, country, profile] of [
    ['palette-cleared', null, { jurisdiction: 'ae' }],
    ['palette-conflict', 'US', { jurisdiction: 'ae' }]
  ]) {
    await seed(id, country, profile);
    await pool.query("insert into client_capability_config (id,firm_id,client_id,flag_key,stage) values ($1,$2,$1,'JURISDICTION_ACCOUNT_PALETTE','canary')", [id, firmId]);
    const client = await pool.connect();
    let result;
    try {
      await client.query('begin');
      result = await seedPackPaletteChartWithClient(client, { firmId, clientId: id });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
    const { n } = (await pool.query('select count(*)::int n from ledger_accounts where client_id=$1', [id])).rows[0];
    record(`JN-A1/${id}`, 'Cleared/conflicting canonical country cannot seed another country chart', n === 0, {
      canonical: country, profile, selectedPack: result.pack_id, insertedAccounts: n
    });
  }

  await seed('archive-gb', 'GB', { accounting_system: 'none' });
  const archive = await createCloseArchiveInDb({ firmId, clientId: 'archive-gb', periodStart: '2026-09-01', periodEnd: '2026-09-30', actorId: 'audit-owner' });
  const storedArchive = (await pool.query('select payload from close_archives where id=$1', [archive.close_archive.archive_id])).rows[0];
  const archivedCountry = storedArchive.payload.sections.entity.jurisdiction;
  record('JN-A2', 'A new archive preserves canonical GB identity without a duplicate profile field', archivedCountry === 'GB', {
    canonical: 'GB', profileJurisdiction: null, persistedArchiveJurisdiction: archivedCountry
  });

  await seed('adjustment-gb', 'GB', { jurisdiction: 'GB', defaultCurrency: 'GBP', accounting_system: 'none' });
  let adjustmentRefusal = null;
  try {
    await postLedgerAdjustmentInDb({ firmId, clientId: 'adjustment-gb', journalDate: '2026-09-05', reason: 'Offline audit fixture', actorId: 'audit-owner', reverseOriginal: false,
      lines: [{ account_code: 'AUD-EXP', account_name: 'Audit expense', account_type: 'expense', debit: 10 },
        { account_code: 'AUD-EQUITY', account_name: 'Audit equity', account_type: 'equity', credit: 10 }] });
  } catch (error) {
    if (error.code !== 'LEDGER_CURRENCY_UNRESOLVED') throw error;
    adjustmentRefusal = { code: error.code, details: error.details };
  }
  const adjustment = (await pool.query("select currency,status from ledger_journals where client_id='adjustment-gb'")).rows;
  record('JN-A3/adjustment', 'Missing line currency refuses before any journal is written', adjustmentRefusal !== null && adjustment.length === 0,
    { bookCurrency: 'GBP', suppliedLineCurrency: null, refusal: adjustmentRefusal, journals: adjustment });

  await seed('settlement-gb', 'GB', { jurisdiction: 'GB', defaultCurrency: 'GBP', accounting_system: 'none' });
  await pool.query("insert into documents (id,firm_id,client_id,filename,document_type,document_date,total_amount,currency) values ('audit-document',$1,'settlement-gb','audit.pdf','receipt','2026-09-05',10,null)", [firmId]);
  const client = await pool.connect();
  let settlementRefusal = null;
  try {
    await client.query('begin');
    const document = (await client.query("select * from documents where id='audit-document'")).rows[0];
    await postDocumentSettlementJournalWithClient({ client, firmId, clientId: 'settlement-gb', document,
      expenseAccount: { code: 'AUD-EXP', name: 'Audit expense', type: 'expense' },
      settlement: { settlement_channel: 'personal_card', verdict_source: 'audit_fixture' }, actorId: 'audit-owner', authorityBasis: 'audit_fixture' });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    if (error.code !== 'LEDGER_CURRENCY_UNRESOLVED') throw error;
    settlementRefusal = { code: error.code, details: error.details };
  } finally { client.release(); }
  const settlement = (await pool.query("select currency,status from ledger_journals where client_id='settlement-gb'")).rows;
  record('JN-A3/document', 'An explicitly unknown document currency refuses before settlement posting', settlementRefusal !== null && settlement.length === 0,
    { documentCurrency: null, bookCurrency: 'GBP', refusal: settlementRefusal, journals: settlement });

  const merchant = deduplicateMerchants([{ description: 'Audit merchant', currency: null, money_out: 10 }])[0];
  assert.ok(merchant, 'The merchant fixture must exercise deduplication.');
  record('JN-A4', 'Merchant prompt preparation preserves unknown currency', !merchant.currency, { inputCurrency: null, promptCurrency: merchant.currency });

  await seed('policy-incident', 'GB', { jurisdiction: 'GB' });
  await pool.query("insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status) values ('audit-policy',$1,'policy-incident','2026-09-05','Audit policy',10,'GBP','needs_review')", [firmId]);
  const policyError = Object.assign(new Error('Audit fixture: configuration unavailable'), { code: 'coding_policy_unavailable' });
  const incidentClient = await pool.connect();
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await recordCodingPolicyFailure({ client: incidentClient, firmId, clientId: 'policy-incident', transactionIds: ['audit-policy'], error: policyError });
    }
  } finally { incidentClient.release(); }
  const auditEvents = (await pool.query("select * from audit_events where resource_id='audit-policy' order by id")).rows;
  const transaction = (await pool.query("select * from transactions where id='audit-policy'")).rows[0];
  const health = buildCaseHealth({ transaction, auditEvents });
  // A projection cannot graduate this finding. Execute the real authenticated
  // consumer lifecycle in its own process/database, with only external auth and
  // model transport replaced by the fixture. A skipped lifecycle cannot pass.
  const consumerProof = execFileSync(process.execPath,
    ['--test', 'server/donna/runtimePolicyIncidentDbPgLifecycle.test.js'],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.match(consumerProof, /# fail 0\b/);
  assert.match(consumerProof, /# skipped 0\b/);
  assert.match(consumerProof, /# pass [1-9]\d*\b/);
  checks.push({ id: 'JN-A5', invariant: 'Exhausted policy failure reaches a named incident consumer', status: 'PASS', observed: {
    attempts: auditEvents.at(-1).metadata.attempts, escalationRequired: auditEvents.at(-1).metadata.escalation_required,
    recoveryRoute: auditEvents.at(-1).metadata.recovery_route, phase: health.phase, recovery: health.recovery,
    consumer: 'Authenticated workspace maintainer claim and retry through existing coding/posting writers',
    lifecycle: 'server/donna/runtimePolicyIncidentDbPgLifecycle.test.js',
    lifecyclePassed: true,
    limitation: 'Local source and disposable-database proof; no production deployment or live incident assignment.'
  } });
  assert.equal(providerCalls, 0);
  console.log(JSON.stringify({ sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runtimeTree: execFileSync('git', ['rev-parse', 'HEAD:server'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'server', 'src', 'scripts/audit-jurisdiction-completion.mjs'], { cwd: root, encoding: 'utf8' }).trim()),
    probeSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    migrationCount: files.length, providerCalls, status: checks.some(check => check.status !== 'PASS') ? 'COMPLETION_BLOCKED' : 'PROBES_PASS', checks }, null, 2));
  if (checks.some(check => check.status !== 'PASS')) process.exitCode = 2;
} finally {
  __resetFirmDbPoolForTests();
  if (pool) { await pool.end(); await Promise.all(closed); }
  if (created) await admin.query(`drop database "${database}"`);
  await admin.end();
  globalThis.fetch = originalFetch;
}
