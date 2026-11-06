import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { FI_PROFILE, fiPdf, fiRoutingFixture, openAiFixture } from './testSupport/fiReliabilitySources.js';
import { handleParseEvent } from './inngest/parseDocument.js';
import { markParseCompletedInDb, retryParseRunsInDb } from './parseDocumentsDb.js';
import { getClientOwnBankAccountsFromDb } from './db/clients.js';
import { __draftClientAskBatchWithClient } from './db/asks.js';
import { rowToDocumentPayload } from './db/documents.js';
import { getClientPortalChatDocsFromDb } from './db/chat.js';
import { buildClientPortalChatContext } from './clientPortalChat.js';

// Synthetic Finnish source, with the printed period deliberately wider than
// its transaction dates. Wire fixtures transcribe it; they contain no verdict.
const statement = {
  transactions: [
    { date: '2025-01-07', description: 'ASIAKASMAKSU', counterparty: 'Asiakas Oy', direction: 'in', amount: 100, currency: 'EUR', balance: 1100 },
    { date: '2025-01-25', description: 'TARVIKKEET', counterparty: 'Tarvike Oy', direction: 'out', amount: 50, currency: 'EUR', balance: 1050 }
  ],
  statement_summary: { opening_balance: 1000, closing_balance: 1050, total_deposits: 100, total_payouts: 50,
    currency: 'EUR', period_start: '2025-01-01', period_end: '2025-01-31', account_identifier: 'FI2112345600000785', bank_name: 'Osuuspankki' }
};
const sourceBytes = () => fiPdf(['TILIOTE 01.01.2025 - 31.01.2025', FI_PROFILE.companyName,
  'Osuuspankki FI2112345600000785 EUR', 'Alkusaldo 1000,00',
  '07.01.2025 ASIAKASMAKSU +100,00 Saldo 1100,00', '25.01.2025 TARVIKKEET -50,00 Saldo 1050,00', 'Loppusaldo 1050,00']);

test('real PG: generic Finnish PDF completion persists statement identity before coverage and bank-account readers',
  { skip: applianceHarnessSkipReason() }, async () => {
    const app = await bootApplianceForTest({ firm: { jurisdiction: 'FI', currency: 'EUR' } });
    try {
      const host = await app.read.host();
      assert.equal(host.status, 'PASS', JSON.stringify(host.certificate?.checks));
      const { clientId } = await app.createClient({ profile: FI_PROFILE });
      const bytes = await sourceBytes();
      app.providers.script('document_routing', [fiRoutingFixture('bank')]);
      app.providers.script('bank_statement_extraction', [openAiFixture(statement)]);
      const upload = await app.uploadDocument({ clientId, bytes, filename: 'Tiliote-tammikuu.pdf', documentType: 'unknown' });
      const context = { firmId: app.firmId, documentId: upload.documentId, parseRunId: upload.registered.parse_run_id };
      const before = await app.read.document(upload.documentId);
      assert.equal(before.document_type, 'unknown');
      assert.equal(before.payload.file_size, undefined);
      assert.equal(before.payload.file_storage.size, bytes.length);
      // Execute the actual durable parse-and-write step. This proof stops at
      // that boundary: later accounting/model legs are independently qualified.
      const result = await handleParseEvent({ event: { data: { firm_id: app.firmId,
        document_id: upload.documentId, parse_run_id: context.parseRunId } },
        step: { run: async (name, fn) => name === 'parse-and-write' ? fn() : {} }, logger: { info() {}, warn() {}, error() {} } });
      assert.equal(result.outcome, 'completed', JSON.stringify(result));
      const doc = await app.read.document(upload.documentId);
      assert.equal(doc.document_type, 'bank_statement');
      assert.equal(doc.parse_status, 'completed');
      assert.equal(doc.status, before.status, 'unrelated workflow status is unchanged');
      assert.equal(doc.parse_summary.classification.original_type, 'unknown');
      assert.equal(doc.parse_summary.classification.final_type, 'bank_statement');
      assert.equal(doc.parse_summary.classification.source, 'router_v1');
      assert.equal(doc.parse_summary.classification.model, app.providers.callsFor('document_routing')[0].model_served);
      assert.equal(doc.parse_summary.transaction_count, 2);
      assert.equal((await app.read.transactions(clientId)).length, 2);
      assert.equal(doc.payload.statement_summary.period_start, '2025-01-01');
      assert.equal(doc.payload.statement_summary.period_end, '2025-01-31');
      const accounts = await getClientOwnBankAccountsFromDb({ firmId: app.firmId, clientId });
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].account_number, statement.statement_summary.account_identifier);
      // Seed a source-line coding proposal so the real ask gather has work.
      // Stop at the drafter boundary after capturing its actual SQL inventory.
      await app.query(`update transactions set payload=payload || '{"ai_suggestion":{"confidence":"low","proposed_account":"Operating supplies","reasoning":"Business purpose requires an owner fact"}}'::jsonb where document_id=$1`, [upload.documentId]);
      let gathered;
      const stop = new Error('captured real ask inputs');
      await assert.rejects(__draftClientAskBatchWithClient({ client: { query: app.query }, firmId: app.firmId, clientId,
        draftFn: async (inputs) => { gathered = inputs; throw stop; } }), error => error === stop);
      assert.equal(gathered.statementCoverage.length, 1);
      assert.equal(gathered.statementCoverage[0].document_type, 'bank_statement');
      assert.equal(gathered.statementCoverage[0].statement_summary.period_start, '2025-01-01');
      assert.equal(gathered.statementCoverage[0].statement_summary.period_end, '2025-01-31');
      const dto = JSON.parse(JSON.stringify(rowToDocumentPayload(doc)));
      assert.equal(dto.file_size, bytes.length);
      // Exercise the actual portal formatter without importing its browser app.
      const portal = await readFile(new URL('../../src/components/donna-client-portal.jsx', import.meta.url), 'utf8');
      const formatSource = portal.slice(portal.indexOf('const formatFileSize ='), portal.indexOf('\nconst fileToDataUrl'));
      const rendered = vm.runInNewContext(`${formatSource}; formatFileSize(size)`, { size: dto.file_size });
      assert.equal(rendered, `${Math.max(1, Math.round(bytes.length / 1024))} KB`);
      assert.match(portal, /formatFileSize\(doc\.file_size, intl\.formatMessage\)/, 'mounted upload row consumes normalized size');
      assert.equal(doc.payload.file_size, undefined, 'read projection never rewrites payload shape');
      const completionAudit = await app.read.audit({ clientId, action: 'document.parse.completed' });
      assert.equal(completionAudit.length, 1);
      assert.equal(completionAudit[0].metadata.document_type, 'bank_statement');
      // Completed historical rows are not silently reparsed by manual retry.
      const retry = await retryParseRunsInDb({ firmId: app.firmId, documentIds: [upload.documentId] });
      assert.equal(retry.retried.length, 0);
      assert.equal(retry.skipped[0].reason, 'parse_status_not_retryable');
      const completeBefore = await app.read.document(upload.documentId);
      assert.equal(await markParseCompletedInDb({ ...context, documentType: 'receipt', summary: {} }), null);
      assert.deepEqual(await app.read.document(upload.documentId), completeBefore, 'same-run late completion cannot replace terminal classification');
      // A newer run invalidates the old token; simultaneous completion attempts
      // both lose against the current processing generation.
      const newRun = randomUUID();
      await app.query("update documents set parse_status='processing',parse_run_id=$2 where id=$1", [upload.documentId, newRun]);
      const generationBefore = await app.read.document(upload.documentId);
      assert.deepEqual(await Promise.all([1, 2].map(() => markParseCompletedInDb({ ...context, documentType: 'receipt', summary: {} }))), [null, null]);
      assert.deepEqual(await app.read.document(upload.documentId), generationBefore);
      assert.equal((await app.read.audit({ clientId, action: 'document.parse.completed' })).length, 1);
      app.providers.assertNoUnscripted();
    } finally { await app.stop(); }
  });

test('shared snapshot size preserves existing top-level metadata and normalizes stored upload metadata', () => {
  assert.equal(rowToDocumentPayload({ payload: { file_size: 100, file_storage: { size: 200 } } }).file_size, 100);
  assert.equal(rowToDocumentPayload({ payload: { file_size: 0, file_storage: { size: 200 } } }).file_size, 0);
  assert.equal(rowToDocumentPayload({ payload: { file_storage: { size: 2048 } } }).file_size, 2048);
  assert.equal(rowToDocumentPayload({ payload: {} }).file_size, undefined);
});

test('real PG: rejected statement writes no lines, then saved-source retry preserves separate equal payments',
  { skip: applianceHarnessSkipReason() }, async () => {
    const app = await bootApplianceForTest({ firm: { jurisdiction: 'FI', currency: 'EUR' } });
    try {
      const { clientId } = await app.createClient({ profile: FI_PROFILE });
      const tx = (amount, description) => ({ date: '2026-05-04', description, counterparty: description,
        direction: 'out', amount, currency: 'EUR', balance: null });
      const statement_summary = { opening_balance: 1000, closing_balance: 372.6, total_deposits: 0,
        total_payouts: 627.4, currency: 'EUR', period_start: '2026-05-04', period_end: '2026-05-04',
        account_identifier: 'FI2112345600000785' };
      const bad = { transactions: [tx(127.4, 'Synthetic cafe'), tx(300, 'Synthetic service')], statement_summary };
      const good = { transactions: [tx(27.4, 'Synthetic cafe'), tx(300, 'Synthetic service'), tx(300, 'Synthetic service')], statement_summary };
      const bytes = await fiPdf(['TILIOTE EUR', 'Alkusaldo 1000,00',
        '04.05.2026 Synthetic cafe 1 27,40-', '04.05.2026 Synthetic service 2 300,00-',
        '04.05.2026 Synthetic service 3 300,00-', 'Loppusaldo 372,60']);
      app.providers.script('document_routing', [fiRoutingFixture('bank'), fiRoutingFixture('bank')]);
      app.providers.script('bank_statement_extraction', [openAiFixture(bad), openAiFixture(bad), openAiFixture(good)]);
      const upload = await app.uploadDocument({ clientId, bytes, filename: 'daily-statements.pdf', documentType: 'unknown' });
      const run = (parseRunId, attempt) => handleParseEvent({ event: { data: { firm_id: app.firmId,
        document_id: upload.documentId, parse_run_id: parseRunId } }, attempt,
        step: { run: async (name, fn) => name === 'parse-and-write' ? fn() : {} }, logger: { info() {}, warn() {}, error() {} } });
      await assert.rejects(run(upload.registered.parse_run_id, { count: 4, max: 4 }),
        error => error.parseErrorCode === 'STATEMENT_VALIDATION_FAILED');
      const failed = await app.read.document(upload.documentId);
      assert.equal(failed.parse_status, 'failed');
      assert.equal(failed.parse_error.code, 'STATEMENT_VALIDATION_FAILED');
      assert.equal(failed.parse_error.retry_owner, 'manual');
      const chatDocs = await getClientPortalChatDocsFromDb({ firmId: app.firmId, clientId });
      const chat = buildClientPortalChatContext({ documents: chatDocs.rows });
      assert.equal(chat.documents[0].parse_issue.code, 'STATEMENT_VALIDATION_FAILED');
      assert.equal(chat.documents[0].parse_issue.retry_owner, 'manual');
      assert.equal((await app.read.transactions(clientId)).length, 0);
      const retry = await retryParseRunsInDb({ firmId: app.firmId, documentIds: [upload.documentId] });
      assert.equal(retry.retried.length, 1);
      const result = await run(retry.retried[0].parse_run_id);
      assert.equal(result.outcome, 'completed');
      const doc = await app.read.document(upload.documentId);
      assert.equal(doc.parse_status, 'completed');
      assert.equal(doc.document_type, 'bank_statement');
      assert.equal(doc.storage_object_key, failed.storage_object_key, 'reuses the saved source');
      const transactions = await app.read.transactions(clientId);
      assert.equal(transactions.length, 3);
      assert.equal(transactions.filter(row => Number(row.money_out) === 300).length, 2);
      assert.equal(new Set(transactions.map(row => row.id)).size, 3);
      assert.equal((await app.read.audit({ clientId, action: 'document.parse.completed' })).length, 1);
      // Recover the historical skipped shape without allowing unrelated skips,
      // duplicate uploads, or documents that already imported transactions.
      const legacy = await app.uploadDocument({ clientId, bytes: await fiPdf(['TILIOTE historical synthetic source']),
        filename: 'historical.pdf', documentType: 'unknown' });
      const legacySummary = JSON.stringify({ reason: 'no_transactions_detected', extraction_status: 'needs_review' });
      await app.query("update documents set parse_status='skipped',parse_summary=$2::jsonb where id=$1", [legacy.documentId, legacySummary]);
      const recovered = await retryParseRunsInDb({ firmId: app.firmId, documentIds: [legacy.documentId] });
      assert.equal(recovered.retried.length, 1);
      await app.query("update documents set parse_status='skipped',parse_summary=$2::jsonb,duplicate_of=$3 where id=$1",
        [legacy.documentId, legacySummary, upload.documentId]);
      assert.equal((await retryParseRunsInDb({ firmId: app.firmId, documentIds: [legacy.documentId] })).retried.length, 0);
      await app.query("update documents set parse_status='skipped',parse_summary=$2::jsonb where id=$1", [upload.documentId, legacySummary]);
      assert.equal((await retryParseRunsInDb({ firmId: app.firmId, documentIds: [upload.documentId] })).retried.length, 0,
        'existing imported rows refuse historical recovery');
      app.providers.assertNoUnscripted();
    } finally { await app.stop(); }
  });
