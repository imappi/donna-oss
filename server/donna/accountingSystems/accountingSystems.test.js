// Tests for the accountingSystems/ adapter registry + scaffolds.
//
// PR 1 (Phase 2.1): the layer that lets routes dispatch the firm's
// downstream connector by the client's accounting_system. The Xero adapter
// is a 1:1 delegation to the existing xero* writers — its live behaviour is
// covered by the xero*.test.js suites — so here we cover the registry
// dispatch and the QBO/none scaffolds' "not available" contract.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import {
  getAccountingSystemAdapter,
  DEFAULT_ACCOUNTING_SYSTEM,
  ACCOUNTING_ADAPTER_VERBS,
  ACCOUNTING_AUDIT_ACTIONS,
  AccountingSystemNotAvailableError,
  xeroAdapter,
  qboAdapter,
  procountorAdapter,
  noneAdapter
} from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

await test('registry: resolves each known accounting_system to its adapter', () => {
  assert.equal(getAccountingSystemAdapter('xero'), xeroAdapter);
  assert.equal(getAccountingSystemAdapter('qbo'), qboAdapter);
  assert.equal(getAccountingSystemAdapter('procountor'), procountorAdapter);
  assert.equal(getAccountingSystemAdapter('none'), noneAdapter);
});

await test('registry: case-insensitive + trims surrounding whitespace', () => {
  assert.equal(getAccountingSystemAdapter('  XERO '), xeroAdapter);
  assert.equal(getAccountingSystemAdapter('QBO'), qboAdapter);
  assert.equal(getAccountingSystemAdapter(' Procountor '), procountorAdapter);
  assert.equal(getAccountingSystemAdapter('None'), noneAdapter);
});

await test('registry: unset / unknown resolves to none — the legacy xero fallback is retired', () => {
  // Migration 120 stamped every existing client from its connection
  // evidence and createClientInDb stamps new clients at birth, so unset no
  // longer occurs in real data. When it does anyway, 'none' is fail-closed:
  // the adapter refuses connector verbs cleanly instead of attempting a
  // Xero write against a client that may have no Xero at all (the
  // appliance "No Xero bank account is synced" trap, 2026-08-16).
  assert.equal(DEFAULT_ACCOUNTING_SYSTEM, 'none');
  for (const bad of [null, undefined, '', '   ', 'sage', 42, {}]) {
    assert.equal(
      getAccountingSystemAdapter(bad),
      noneAdapter,
      `expected default (none) adapter for ${JSON.stringify(bad)}`
    );
  }
});

await test('every adapter implements the full verb surface', () => {
  for (const adapter of [xeroAdapter, qboAdapter, procountorAdapter, noneAdapter]) {
    for (const verb of ACCOUNTING_ADAPTER_VERBS) {
      assert.equal(typeof adapter[verb], 'function', `${adapter.id} is missing verb ${verb}`);
    }
  }
});

await test('qbo: six verbs are live (delegate); only provisionChartOfAccounts reports not-available', async () => {
  // startConnection left the scaffold in 2.1a, syncReferenceData in 2.1b, and
  // the writeback surface (writebackTransaction/writebackBatch/retryMirror/
  // verifyMirror) in 2.1c. All delegate to their *QboInDb writers, which call
  // requireQboConfigured() first — with no QBO creds in unit-land that rejects
  // with a 500 "not configured", which is precisely the point: it is no longer
  // the 409 AccountingSystemNotAvailableError the scaffold raised.
  const liveVerbs = [
    'startConnection',
    'syncReferenceData',
    'writebackTransaction',
    'writebackBatch',
    'retryMirror',
    'verifyMirror'
  ];
  for (const verb of liveVerbs) {
    await assert.rejects(
      () => qboAdapter[verb]({ firmId: 'f', clientId: 'c', transactionId: 't' }),
      (err) => {
        assert.ok(
          !(err instanceof AccountingSystemNotAvailableError),
          `qbo.${verb} must delegate, not report not-available`
        );
        return true;
      }
    );
  }

  // provisionChartOfAccounts is the lone remaining scaffold (resolve-at-writeback
  // means no CoA push into QBO).
  for (const verb of ACCOUNTING_ADAPTER_VERBS.filter((v) => !liveVerbs.includes(v))) {
    assert.equal(verb, 'provisionChartOfAccounts');
    assert.throws(
      () => qboAdapter[verb]({ firmId: 'f', clientId: 'c' }),
      (err) => {
        assert.ok(err instanceof AccountingSystemNotAvailableError, `${verb} threw wrong type`);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'ACCOUNTING_SYSTEM_NOT_AVAILABLE');
        assert.equal(err.details.accounting_system, 'qbo');
        assert.equal(err.details.operation, verb);
        return true;
      }
    );
    assert.throws(
      () => procountorAdapter[verb]({ firmId: 'f', clientId: 'c' }),
      (err) => {
        assert.ok(err instanceof AccountingSystemNotAvailableError, `${verb} threw wrong type`);
        assert.equal(err.details.accounting_system, 'procountor');
        assert.equal(err.details.operation, verb);
        return true;
      }
    );
  }
});

await test('none scaffold: every verb throws AccountingSystemNotAvailableError (409, none)', () => {
  for (const verb of ACCOUNTING_ADAPTER_VERBS) {
    assert.throws(
      () => noneAdapter[verb]({ firmId: 'f', clientId: 'c' }),
      (err) => {
        assert.ok(err instanceof AccountingSystemNotAvailableError, `${verb} threw wrong type`);
        assert.equal(err.statusCode, 409);
        assert.equal(err.details.accounting_system, 'none');
        assert.equal(err.details.operation, verb);
        return true;
      }
    );
  }
});

await test('the Xero adapter is distinct from the scaffolds (delegates, never throws not-available)', () => {
  // Surface check only — invoking would hit the DB. The Xero verbs forward
  // 1:1 to the existing writers, so they are plain functions, not the
  // scaffold thrower the QBO/none adapters use.
  assert.equal(xeroAdapter.id, 'xero');
  assert.notEqual(xeroAdapter.writebackTransaction, qboAdapter.writebackTransaction);
  assert.notEqual(xeroAdapter.writebackTransaction, noneAdapter.writebackTransaction);
  assert.notEqual(xeroAdapter.writebackTransaction, procountorAdapter.writebackTransaction);
});

// Audit-action neutralization (Phase 2.1 PR2): the neutral constants are
// the contract every connector emits against. Lock the strings so a rename
// shows up in code review, and assert the historical `xero.*` literals
// never sneak back into firmDb.js's audit_events inserts.
await test('ACCOUNTING_AUDIT_ACTIONS: neutral action strings are stable', () => {
  assert.deepEqual(ACCOUNTING_AUDIT_ACTIONS, {
    connect: 'accounting_system.connect',
    disconnect: 'accounting_system.disconnect',
    syncReferenceData: 'accounting_system.sync_reference_data',
    provisionChartOfAccounts: 'accounting_system.provision_coa',
    writebackTransaction: 'accounting_system.writeback_transaction',
    writebackBatch: 'accounting_system.writeback_batch',
    retryMirror: 'accounting_system.mirror_retry',
    verifyMirror: 'accounting_system.mirror_verify'
  });
});

await test('procountor: capability trial — connect + reference sync + writeback are live; provisionChartOfAccounts reports not-available', async () => {
  // The trial has graduated verb-by-verb (QBO 2.1a→c): startConnection (M2M
  // connect), syncReferenceData (2.1b), and the writeback surface
  // (writebackTransaction/writebackBatch/retryMirror/verifyMirror, 2.1c) all
  // delegate to their *ProcountorInDb writers, which call
  // requireProcountorConfigured() first — with no creds in unit-land that
  // rejects with the 500 "not configured" (NOT the 409 scaffold error), which
  // proves the delegation. provisionChartOfAccounts is the lone remaining
  // scaffold and must still raise the typed 409.
  const liveVerbs = [
    'startConnection',
    'syncReferenceData',
    'writebackTransaction',
    'writebackBatch',
    'retryMirror',
    'verifyMirror'
  ];
  for (const verb of liveVerbs) {
    await assert.rejects(
      () => procountorAdapter[verb]({ firmId: 'f', clientId: 'c' }),
      (err) => {
        assert.ok(!(err instanceof AccountingSystemNotAvailableError), `procountor.${verb} must delegate`);
        return true;
      }
    );
  }
  for (const verb of ACCOUNTING_ADAPTER_VERBS.filter((v) => !liveVerbs.includes(v))) {
    assert.throws(
      () => procountorAdapter[verb]({ firmId: 'f', clientId: 'c' }),
      (err) => {
        assert.ok(err instanceof AccountingSystemNotAvailableError, `procountor.${verb} threw wrong type`);
        assert.equal(err.statusCode, 409);
        assert.equal(err.details.accounting_system, 'procountor');
        return true;
      }
    );
  }
});

await test('api.js: connector writeback/mirror routes answer to /xero/, /qbo/, and /procountor/', () => {
  // Phase 2.1c wired the live QBO writeback surface into the adapter; the four
  // writeback/mirror routes dispatch by the client's accounting_system, so each
  // must expose the symmetric `/qbo/<verb>` alias alongside the legacy
  // `/xero/<verb>` path (a QBO client posting to `/qbo/writeback-transaction`
  // is no longer writing to QuickBooks through a Xero-named path). Static guard
  // — the handler needs a server + DB to invoke — so a future edit can't quietly
  // drop one prefix and strand the QBO surface.
  const apiSource = readFileSync(resolve(__dirname, '..', 'api.js'), 'utf8');
  for (const verb of ['writeback-transaction', 'writeback-transactions', 'mirror-retry', 'mirror-verify']) {
    assert.ok(apiSource.includes(`'/xero/${verb}'`), `api.js missing /xero/${verb} route`);
    assert.ok(apiSource.includes(`'/qbo/${verb}'`), `api.js missing /qbo/${verb} alias`);
    assert.ok(apiSource.includes(`'/procountor/${verb}'`), `api.js missing /procountor/${verb} alias`);
  }
});

await test('firmDb.js: no historical `xero.<verb>` audit-action literals remain', () => {
  // Static guard against a regression where someone wires a new audit
  // emit using the legacy `'xero.foo'` action shape instead of the neutral
  // ACCOUNTING_AUDIT_ACTIONS constant. Matches single-quoted action-shaped
  // strings only; the xeroClient.js host strings and SQL identifiers like
  // `xero_connections` are not single-quoted action literals.
  // RT-17: firmDb.js is decomposed into server/donna/db/<plane>.js — scan every plane and the hub.
  const dbDir = resolve(__dirname, '..', 'db');
  const firmDbSource = [
    ...readdirSync(dbDir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort().map((f) => readFileSync(resolve(dbDir, f), 'utf8')),
    readFileSync(resolve(__dirname, '..', 'firmDb.js'), 'utf8')
  ].join('\n');
  const stragglers = firmDbSource.match(/'xero\.[a-z_]+'/g) || [];
  assert.deepEqual(stragglers, [], `unexpected legacy xero.* action literals: ${stragglers.join(', ')}`);
});
