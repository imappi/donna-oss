import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const consoleSource = readFileSync(
  new URL('../components/FirmOpsConsole.jsx', import.meta.url),
  'utf8'
);

test('Actions resolves a bank line before its matched document artifact', () => {
  const activateStart = consoleSource.indexOf('const handleHomeFeedActivate');
  const activateEnd = consoleSource.indexOf('// The confirm dialog', activateStart);
  const activateSource = consoleSource.slice(activateStart, activateEnd);

  const transactionLookup = activateSource.indexOf('const txId = item.transaction_id');
  const documentLookup = activateSource.indexOf('const docId = item.matched_object_id || item.document_id');

  assert.ok(transactionLookup >= 0, 'the shared Actions/Inbox opener resolves transaction-backed rows');
  assert.ok(documentLookup >= 0, 'document-only Actions retain their document fallback');
  assert.ok(
    transactionLookup < documentLookup,
    'a row carrying both ids must use the Bank feed transaction artifact'
  );
});

test('Actions and Inbox continue to use the shared artifact opener', () => {
  assert.match(consoleSource, /<AskBatchPanel[\s\S]*onActivateItem=\{handleHomeFeedActivate\}/);
  assert.match(consoleSource, /onActivatePeriodOwnerDecision=\{handleHomeFeedActivate\}/);
  assert.match(consoleSource, /<DonnaFirmFeedPanel[\s\S]*onActivateItem=\{handleHomeFeedActivate\}/);
});
