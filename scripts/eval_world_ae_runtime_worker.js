// U25-S1 production-operation seam. Inputs are fictional raw source bytes only.
// Runs in a fresh process with an isolated environment supplied by the diagnostic.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { bindProductionOperations } from './eval_world_db_close.js';
import { requestApi, uploadAndRegisterRawDocument } from './eval_world_birth_to_parse.js';
import { closeFirmDbPool, queryFirmDb, withFirmDbClient } from '../server/donna/firmDb.js';
import { buildDesktopHandlerManifest } from '../server/donna/desktop/handlerManifest.js';
import { createLocalScheduler } from '../server/donna/desktop/localScheduler.js';
import { dispatchQueuedParseJobsOnce } from '../server/donna/desktop/parseDocumentJob.js';
import { applyDesktopBuildIdentityDefaults } from '../server/donna/desktop/buildIdentity.js';
import { observeHostCertificateA } from '../server/donna/hostCertificateA.js';
import { persistHostReadinessAttempt } from '../server/donna/runtimeReadiness.js';
import { deleteEvidenceObjects } from '../server/donna/evidenceStorage.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ops = bindProductionOperations();
const coded = (code, message) => Object.assign(new Error(message), { code });
const errorReceipt = (error) => ({ code: error.code || 'AE7_OPERATION_FAILED', message: error.message, details: error.details || null, routeReceipts: error.rawDocumentReceipts || null });
const logger = { log() {}, info() {}, warn() {}, error() {} };

// No verdict, account, matching instruction, hidden fact or expected journal is
// supplied to the worker. The PDF and bank export are the entire evidence input.
async function sourceBytes(kind) {
  if (kind === 'bank') return Buffer.from('Date,Description,Money In,Money Out,Balance,Currency\n12/08/2026,GULF SUPPLIES INV 42,0,1050,8950,AED\n');
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2026-08-12T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-08-12T00:00:00Z'));
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  ['TAX INVOICE 42', 'Gulf Supplies LLC - Dubai', 'Seller TRN 100000000000003',
    'Bill to: AE Diagnostic Services LLC', 'Date: 12 August 2026',
    'Office supplies AED 1000.00', 'VAT 5% AED 50.00', 'Total AED 1050.00']
    .forEach((text, index) => page.drawText(text, { x: 50, y: 780 - index * 28, size: 14, font }));
  return Buffer.from(await pdf.save());
}

export async function observeAeRuntime({ firmId, clientId }) {
  // The named observer is reused verbatim. Supplement it with source columns,
  // not a second derivation: an empty period observer is not completed books.
  const terminal = await ops.readTerminalInventoryInDb({ firmId, clientId });
  const journalCount = await ops.countPersistedJournalsInDb({ firmId, clientId });
  const documents = await queryFirmDb(`select id, parse_status, parse_run_id::text, parse_error,
    convergence_state, convergence_reason from documents where firm_id=$1 and client_id=$2 order by id`, [firmId, clientId]);
  const transactions = await queryFirmDb(`select id, document_id, transaction_date::text, money_in, money_out, currency,
    coding_state, convergence_state, convergence_reason from transactions where firm_id=$1 and client_id=$2 order by id`, [firmId, clientId]);
  const jobs = await queryFirmDb(`select id::text, function_id, status, attempt_count, last_error, payload
    from local_jobs where payload->>'firmId'=$1 or payload->>'firm_id'=$1 order by id`, [firmId]);
  const asks = await queryFirmDb(`select id, status, audience, question from client_evidence_requests
    where firm_id=$1 and client_id=$2 order by id`, [firmId, clientId]);
  const audit = await queryFirmDb('select id, action, actor_id, metadata from audit_events where firm_id=$1 order by id', [firmId]);
  return { terminal, journalCount, documents: documents.rows, transactions: transactions.rows,
    jobs: jobs.rows, asks: asks.rows, audit: audit.rows };
}

async function dispatch() {
  return dispatchQueuedParseJobsOnce({ client: { query: queryFirmDb }, logger });
}

async function execute(context, phase) {
  const database = new URL(process.env.DATABASE_URL || 'invalid:');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
      || !/^\/ae7_runtime_[a-z0-9_]+$/.test(database.pathname)
      || !/^eaw-[a-z0-9-]+$/.test(context.firmId || '')
      || context.clientId !== `${context.firmId}-client-1`) {
    throw coded('AE7_WORKER_ISOLATION_REQUIRED', 'Worker requires its diagnostic-created local database and exact EAW identities.');
  }
  const { firmId, clientId, actor, order } = context;
  const common = { firmId, clientId };
  const receipt = { phase, pid: process.pid, operations: [], blockers: [], observation: null };
  const call = async (operation, fn) => {
    try { const result = await fn(); receipt.operations.push({ operation, status: 'PASS', result }); return result; }
    catch (error) { const blocker = { operation, entity: clientId, status: 'INCOMPLETE', ...errorReceipt(error) };
      receipt.operations.push(blocker); receipt.blockers.push(blocker); return null; }
  };
  if (phase === 'intake') {
    applyDesktopBuildIdentityDefaults(process.env, { rootDir: ROOT });
    const manifest = buildDesktopHandlerManifest({ rootDir: ROOT });
    const scheduler = createLocalScheduler({ manifest, client: { query: queryFirmDb }, logger });
    await scheduler.initialize();
    const host = await observeHostCertificateA({ env: process.env, rootDir: ROOT, manifest, schedulerEnabled: true });
    receipt.host = { status: host.status, checks: host.checks.filter((check) => check.status !== 'PASS') };
    if (host.status !== 'PASS') throw coded('AE7_HOST_NOT_READY', JSON.stringify(receipt.host));
    await persistHostReadinessAttempt({ withFirmDbClientFn: withFirmDbClient, certificate: host, eventType: 'boot' });
    await ops.createFirmInDb({ firmId, name: 'AE runtime diagnostic', jurisdiction: 'AE', currency: 'AED', actor,
      member: { id: actor.id, name: 'Isolated diagnostic operator', email: 'ae7@example.invalid' } });
    receipt.operations.push({ operation: 'createFirmInDb', status: 'PASS' });
    const create = await requestApi({ method: 'POST', url: '/api/donna/firms/clients',
      headers: { authorization: `Bearer ${process.env.DONNA_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ firm_id: firmId, profile: { id: clientId, companyName: 'AE Diagnostic Services LLC',
        jurisdiction: 'AE', entityType: 'ae-llc', accounting_system: 'none', currency: 'AED' }, queue: [] }) });
    receipt.operations.push({ operation: 'POST /firms/clients', status: create.statusCode === 200 ? 'PASS' : 'INCOMPLETE',
      result: { statusCode: create.statusCode, code: create.json?.code, error: create.json?.error } });
    if (create.statusCode !== 200) throw coded(create.json?.code || 'AE7_CREATE_REFUSED', create.json?.error || create.body);
    const kinds = order === 'document_first' ? ['invoice', 'bank'] : ['bank', 'invoice'];
    for (const [index, kind] of kinds.entries()) {
      const bytes = await sourceBytes(kind);
      await call(`uploadAndRegisterRawDocument:${kind}`, () => uploadAndRegisterRawDocument({
        ops: { requestApi }, ...common, documentId: `${clientId}-${kind}`,
        filename: `${kind}.${kind === 'bank' ? 'csv' : 'pdf'}`, mimeType: kind === 'bank' ? 'text/csv' : 'application/pdf',
        documentType: kind === 'bank' ? 'bank_statement' : 'supplier_bill', bytes,
        uploadedAt: Date.parse('2026-08-12T00:00:00Z'), batchId: `${firmId}-${kind}`,
      }));
      if (index === 0) await call('dispatchQueuedParseJobsOnce:first_arrival', dispatch);
    }
  } else if (phase === 'resume' || phase === 'replay') {
    await call('dispatchQueuedParseJobsOnce', dispatch);
    await call('postLedgerPeriodInDb', () => ops.postLedgerPeriodInDb({ ...common, periodStart: '2026-08-01',
      periodEnd: '2026-08-31', dryRun: false, actorId: actor.id }));
  } else if (phase === 'retire') {
    const stored = await queryFirmDb('select storage_bucket, storage_object_key from documents where firm_id=$1', [firmId]);
    for (const row of stored.rows) if (row.storage_bucket && row.storage_object_key) {
      await call('deleteEvidenceObjects', () => deleteEvidenceObjects({ bucket: row.storage_bucket, keys: [row.storage_object_key] }));
    }
    receipt.deletion = await call('deleteFirmInDb', () => ops.deleteFirmInDb({ firmId, actor }));
    receipt.residue = await call('countFirmResidueInDb', () => ops.countFirmResidueInDb({ firmId, clientIds: [clientId] }));
    const blobs = await queryFirmDb('select count(*)::int as count from local_evidence_objects');
    receipt.blobResidue = blobs.rows[0].count;
    return receipt;
  } else throw coded('AE7_PHASE_UNKNOWN', phase);
  receipt.observation = await observeAeRuntime(common);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, phase, output] = process.argv;
  let preventedHttpCalls = 0;
  const refuseHttp = () => {
    preventedHttpCalls += 1;
    throw coded('AE7_EXTERNAL_TRANSPORT_REFUSED', 'The isolated diagnostic has no HTTP transport authority.');
  };
  globalThis.fetch = refuseHttp;
  http.request = http.get = https.request = https.get = refuseHttp;
  syncBuiltinESMExports();
  let receipt;
  try { receipt = await execute(JSON.parse(await readFile(input, 'utf8')), phase); }
  catch (error) { receipt = { phase, pid: process.pid, status: 'INCOMPLETE', blocker: errorReceipt(error) }; }
  receipt.transport = { httpDisabled: true, preventedHttpCalls };
  await writeFile(output, JSON.stringify(receipt, null, 2));
  // Persisted queue work survives process loss between admission and dispatch.
  // No finally/cleanup runs on this deliberate crash; the next child resumes.
  if (phase === 'intake' && receipt.observation) process.exit(86);
  await closeFirmDbPool();
}
