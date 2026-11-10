import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAeDiagnosticDatabase, runAeRuntimeDiagnostic, summarizeAeRuntimeOrders } from './eval_world_ae_runtime.js';

test('AE-7 missing database is an explicit incomplete diagnostic, never app DB fallback', async () => {
  const receipt = await runAeRuntimeDiagnostic({ postgresUrl: '', runToken: 'missing', actorId: 'test-operator' });
  assert.equal(receipt.status, 'INCOMPLETE');
  assert.equal(receipt.blockers[0].code, 'AE7_DISPOSABLE_POSTGRES_REQUIRED');
  assert.equal(receipt.orders.length, 0);
  assert.equal(receipt.completeBooks, false);
});

test('AE-7 refuses a remote target before any operation', () => {
  assert.throws(() => assertAeDiagnosticDatabase('postgresql://example.com/books'), { code: 'AE7_DISPOSABLE_POSTGRES_REQUIRED' });
});

test('AE-7 empty observations cannot advance runtime prerequisites', () => {
  assert.ok(summarizeAeRuntimeOrders([]).prerequisites.every((row) => row.status === 'INCOMPLETE'));
});

test('real PG: raw AE arrival orders, persisted process restart, honest missing intelligence and retirement', { timeout: 240000 }, async () => {
  assert.ok(process.env.DONNA_PG_TEST_URL,
    'INCOMPLETE: DONNA_PG_TEST_URL is required for the AE-7 real PostgreSQL lifecycle; this test never skips');
  const { runAeWholePeriodConvergence } = await import('./eval_world_ae_whole_period.js');
  const programme = await runAeWholePeriodConvergence({ runtimeOptions: {
    runToken: `ae7-test-${process.pid}`, actorId: 'ae7-isolated-test-operator',
  } });
  assert.equal(programme.certificate.offlineStatus, 'PASS');
  assert.equal(programme.certificate.status, 'INCOMPLETE');
  const receipt = programme.candidate.production.runtimeDiagnostic;
  assert.equal(receipt.status, 'INCOMPLETE');
  assert.equal(receipt.fullAe7Acceptance, false);
  assert.equal(receipt.completeBooks, false);
  assert.equal(receipt.schema?.status, 'PASS', JSON.stringify(receipt.blockers));
  assert.equal(receipt.orders.length, 2, JSON.stringify(receipt.blockers));
  for (const order of receipt.orders) {
    for (const phase of ['intake', 'resume', 'replay', 'retire']) {
      assert.ok(order[phase],JSON.stringify(receipt.blockers));
      assert.deepEqual(order[phase].transport, { httpDisabled: true, preventedHttpCalls: 0 });
    }
    assert.equal(order.intake?.exitCode, 86, JSON.stringify(order.intake));
    assert.notEqual(order.intake.pid, order.resume?.pid);
    assert.equal(order.intake.observation.documents.length, 2);
    assert.equal(order.replay.observation.transactions.length, 1, JSON.stringify(order.replay));
    assert.equal(order.replay.observation.transactions[0].currency, 'AED');
    assert.equal(Number(order.replay.observation.transactions[0].money_out), 1050);
    assert.equal(order.replay.observation.journalCount.count, 0, 'no fabricated final postings');
    assert.equal(order.replay.observation.asks.length, 0, 'no invented owner question');
    assert.deepEqual(order.resume.observation.terminal, order.replay.observation.terminal);
    assert.equal(order.retire.deletion.residue_verified, true, JSON.stringify(order.retire));
    assert.equal(order.retire.residue.residue_rows, 0);
    assert.equal(order.retire.blobResidue, 0);
  }
  assert.ok(receipt.prerequisites.every((row) => row.status === 'PASS'), JSON.stringify(receipt.prerequisites));
  assert.ok(receipt.blockers.some((row) => row.code === 'AE7_DOCUMENT_PARSE_INCOMPLETE'
    && row.durableJob?.last_error === 'Supplier bill extraction failed: no_provider_key'));
  assert.deepEqual(receipt.orders[0].replay.observation.transactions.map(({ id, document_id, ...fields }) => fields),
    receipt.orders[1].replay.observation.transactions.map(({ id, document_id, ...fields }) => fields));
  assert.ok(receipt.blockers.some((row) => row.code === 'AE7_TRANSACTION_NON_TERMINAL'));
  assert.equal(receipt.scratchDatabaseRemoved, true);
  assert.equal(receipt.spend.modelProviderCalls, 0);
});

test('real PG: current-schema observer fails loudly on a missing audience column', async () => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable PostgreSQL required');
  const { default: pg } = await import('pg');
  const { migrateAeDiagnosticDatabase } = await import('./eval_world_ae_runtime.js');
  const { observeAeRuntime } = await import('./eval_world_ae_runtime_worker.js');
  const { closeFirmDbPool } = await import('../server/donna/firmDb.js');
  const url = assertAeDiagnosticDatabase(process.env.DONNA_PG_TEST_URL);
  const name = `ae7_runtime_schema_${process.pid}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const oldUrl = process.env.DATABASE_URL;
  let db;
  try {
    await admin.query(`create database "${name}"`);
    url.pathname = `/${name}`;
    await migrateAeDiagnosticDatabase(url.toString());
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    process.env.DATABASE_URL = url.toString();
    await closeFirmDbPool();
    await db.query('alter table client_evidence_requests rename column audience to missing_audience');
    await assert.rejects(() => observeAeRuntime({ firmId: 'eaw-schema', clientId: 'eaw-schema-client-1' }),
      { code: '42703' }, 'the real observer must not swallow a schema error into an empty terminal inventory');
  } finally {
    await closeFirmDbPool();
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
    if (db) await db.end();
    await admin.query(`drop database if exists "${name}"`);
    await admin.end();
  }
});
