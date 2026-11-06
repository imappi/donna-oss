import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FAMILY_PATHS,
  assertRunIdentity,
  bindProductionOperations,
  CANONICAL_PROJECTION_RECEIPT,
  compileWorldInput,
  classifyDbCloseProjectionReceipt,
  loadDeclaredWorlds,
  projectTerminalState,
  runHarness,
  RUN_RECEIPT_VERSION,
} from './eval_world_db_close.js';

const world = {
  worldId: 'slice1/test', effectiveDate: '2026-08-05',
  artifacts: [{ id: 'artifact/a', kind: 'bank_line' }],
  events: [{ id: 'event/a', type: 'cash_movement', occurredAt: '2026-08-05', monetaryEffects: { amount: 10, currency: 'GBP' } }]
};

function fakeOps({ configured = true, failAt = null, residue = 0, divergent = false } = {}) {
  let projections = 0;
  const calls = [];
  const op = (name, value) => async (args) => { calls.push([name, args]); if (failAt === name) throw Object.assign(new Error(`${name} failed`), { code: 'INJECTED' }); return typeof value === 'function' ? value(args) : value; };
  return { calls,
    isFirmDatabaseConfigured: () => configured,
    createFirmInDb: op('createFirmInDb', { op: 'firm_created' }), createClientInDb: op('createClientInDb', {}),
    syncDocumentsAndTransactionsInDb: op('syncDocumentsAndTransactionsInDb', {}),
    postLedgerPeriodInDb: op('postLedgerPeriodInDb', () => ({ ledger_period_posting: { results: (projections++ % 2 === 0 || divergent) ? [{ status: 'posted', ledger_journal_id: `journal-${projections}` }] : [{ status: 'skipped', reason: 'already_posted' }] } })),
    getLedgerPeriodPreviewFromDb: op('getLedgerPeriodPreviewFromDb', { close_preview: { lockable: true, period_start: '2026-08-01', period_end: '2026-08-31' } }),
    getCloseExceptionsFromDb: op('getCloseExceptionsFromDb', { exceptions: [] }),
    getClientEvidenceRequestsFromDb: op('getClientEvidenceRequestsFromDb', { counts: { total: 0, open: 0 }, requests: [] }),
    getCloseDiagnosticsFromDb: op('getCloseDiagnosticsFromDb', { source_import: { status: 'passed' } }),
    lockClosePeriodInDb: op('lockClosePeriodInDb', { close_lock: { status: 'locked', idempotent: true } }),
    createCloseArchiveInDb: op('createCloseArchiveInDb', { close_archive: { archive_id: 'archive-1', status: 'generated' } }),
    getCloseArchiveExportFromDb: op('getCloseArchiveExportFromDb', { bundle_checksum_sha256: 'a'.repeat(64) }),
    deleteFirmInDb: op('deleteFirmInDb', { op: 'firm_deleted', residue_verified: true, rows_deleted: [{ table: 'ledger_journals', rows: 1 }] }),
    countFirmResidueInDb: op('countFirmResidueInDb', { residue_rows: residue, residue: residue ? [{ table: 'ledger_lines', rows: residue }] : [], retained: { firm_row_present: true, firm_retired: true, audit_event_rows: 3 } })
  };
}

test('CLI loudly refuses an unconfigured DB and emits no fake evidence', () => {
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'donna-eaw-no-db-'));
  try {
    const result = spawnSync(process.execPath, [path.resolve('scripts/eval_world_db_close.js'), '--run-token', 'ci-refusal'], {
      cwd: isolatedCwd,
      env: {
        ...process.env,
        DATABASE_URL: '',
        FIRM_DATABASE_URL: '',
        POSTGRES_URL: '',
        SUPABASE_DB_URL: ''
      },
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.failure.code, 'EAW_DB_UNCONFIGURED');
    assert.equal(failure.receipt, null);
  } finally {
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }
});

test('source binds the manifest and contains no direct DB escape hatch', () => {
  const source = fs.readFileSync('scripts/eval_world_db_close.js', 'utf8');
  assert.doesNotMatch(source, /withFirmDbClient|client\.query|\b(select|insert|update|delete)\s+(from|into|\w+\s+set)\b/i);
  const bound = bindProductionOperations();
  assert.equal(typeof bound.createFirmInDb, 'function');
  assert.equal(typeof bound.deleteFirmInDb, 'function');
  assert.equal(typeof bound.countFirmResidueInDb, 'function');
});

test('loads exactly the three declared families and deriveSiblingWorld(source).world', async () => {
  const worlds = await loadDeclaredWorlds();
  assert.equal(worlds.length, 4);
  assert.deepEqual(FAMILY_PATHS.length, 3);
  assert.match(worlds[3].worldId, /::sibling::/);
});

test('identity, malformed event, and duplicate artifact matrix refuses', () => {
  for (const firmId of ['', 'demo', 'eaw-']) assert.throws(() => assertRunIdentity({ firmId, clientId: 'x' }), /firmId/);
  assert.throws(() => assertRunIdentity({ firmId: 'eaw-good', clientId: 'other' }), /clientId/);
  const bad = structuredClone(world); bad.events[0].occurredAt = 'today';
  assert.throws(() => compileWorldInput(bad, { firmId: 'eaw-good', clientId: 'eaw-good-client-1' }), /invalid date or amount/);
  const duplicate = structuredClone(world); duplicate.artifacts.push(duplicate.artifacts[0]);
  assert.throws(() => compileWorldInput(duplicate, { firmId: 'eaw-good', clientId: 'eaw-good-client-1' }), /unique/);
});

test('canonical ask projection leaves replied and agent asks in limbo and marks historical receipts legacy-unproven', () => {
  const t1 = projectTerminalState({ preview: { close_preview: { lockable: true } }, exceptions: { exceptions: [] }, evidenceRequests: { counts: { total: 0, open: 0 }, requests: [] } });
  assert.equal(t1.t1.length, 1); assert.equal(t1.t2.length, 0); assert.equal(t1.limbo.length, 0);
  const t2 = projectTerminalState({ preview: { close_preview: { lockable: false } }, exceptions: { exceptions: [] }, evidenceRequests: { counts: { total: 1, open: 1 }, requests: [{ id: 'ask-1', status: 'open' }] } });
  assert.equal(t2.t1.length, 0); assert.equal(t2.t2[0].responsible_actor, 'owner');
  assert.equal(CANONICAL_PROJECTION_RECEIPT.projector, 'reconcileConvergenceState');

  const replied = projectTerminalState({ preview: { close_preview: { lockable: false } }, exceptions: { exceptions: [] }, evidenceRequests: { requests: [{ id: 'ask-replied', status: 'replied' }] } });
  assert.equal(replied.t2.length, 0);
  assert.deepEqual(replied.limbo, [{ source: 'getClientEvidenceRequestsFromDb', id: 'ask-replied', reason: 'answered_customer_ask_awaiting_processing' }]);
  const agent = projectTerminalState({ preview: { close_preview: { lockable: false } }, exceptions: { exceptions: [] }, evidenceRequests: { requests: [{ id: 'ask-agent', status: 'open', audience: 'agent' }] } });
  assert.equal(agent.t2.length, 0);
  assert.deepEqual(agent.limbo, [{ source: 'getClientEvidenceRequestsFromDb', id: 'ask-agent', reason: 'agent_ask_unanswered' }]);
  const blocker = projectTerminalState({ preview: { close_preview: { lockable: false } }, exceptions: { exceptions: [{ id: 'exception-1', severity: 'blocker', responsible_actor: 'owner' }] }, evidenceRequests: { requests: [] } });
  assert.equal(blocker.t2.length, 0, 'a blocker is not a customer-human ask');
  assert.deepEqual(blocker.limbo, [{ source: 'getCloseExceptionsFromDb', id: 'exception-1', reason: 'blocker_without_customer_human_ask' }]);
  assert.throws(() => projectTerminalState({ preview: { close_preview: { lockable: true } }, exceptions: { exceptions: [] }, evidenceRequests: { counts: { total: 1, open: 1 }, requests: [{ id: 'ask', status: 'open' }] } }), /disagree/);

  const historicalRun = JSON.parse(fs.readFileSync('data/worlds/receipts/slice1-db-close-run-20260819-1840.json', 'utf8'));
  assert.deepEqual(classifyDbCloseProjectionReceipt(historicalRun), {
    classification: 'legacy_unproven',
    reason: 'eaw.db-close-run.v1 used the broader replied-ask terminal projection',
  });
  const historicalCase = JSON.parse(fs.readFileSync('data/worlds/receipts/slice1-db-close-f1.json', 'utf8'));
  assert.equal(classifyDbCloseProjectionReceipt(historicalCase).classification, 'legacy_unproven');
});

test('all four worlds run twice and retain independent cleanup receipts', async () => {
  const ops = fakeOps();
  const ticks = [100, 125];
  const result = await runHarness({ ops, worlds: [world, { ...world, worldId: 'f2' }, { ...world, worldId: 'f3' }, { ...world, worldId: 'f3::sibling::purpose' }], runToken: 'unit39', clock: () => ticks.shift() });
  assert.equal(result.version, RUN_RECEIPT_VERSION);
  assert.equal(result.receipts.length, 4);
  assert(result.receipts.every((r) => r.candidate_close.passes.length === 2 && r.candidate_close.idempotent));
  assert(result.receipts.every((r) => r.cleanup.delete_receipt.residue_verified && r.cleanup.post_delete_residue.residue_rows === 0));
  assert(result.receipts.every((r) => classifyDbCloseProjectionReceipt(r).classification === 'canonical'));
  assert.deepEqual({
    status: result.spend.status,
    solveCalls: result.spend.solveCalls,
    inputTokens: result.spend.inputTokens,
    outputTokens: result.spend.outputTokens,
    modelSpendUsd: result.spend.modelSpendUsd,
    wallTimeMs: result.spend.wallTimeMs,
  }, { status: 'known_zero_model', solveCalls: 0, inputTokens: 0, outputTokens: 0, modelSpendUsd: 0, wallTimeMs: 25 });
  assert.match(result.spend.configurationDigest, /^[0-9a-f]{64}$/);
  assert.match(result.spend.artifactDigests[0], /^[0-9a-f]{64}$/);
  assert.equal(ops.calls.filter(([name]) => name === 'postLedgerPeriodInDb').length, 8);
});

test('mid-run failure still cleans and carries truthful residue evidence', async () => {
  const ops = fakeOps({ failAt: 'postLedgerPeriodInDb' });
  await assert.rejects(() => runHarness({ ops, worlds: [world, world, world, { ...world, worldId: 'f3::sibling::x' }], runToken: 'failure' }), (error) => {
    assert.equal(error.receipt.status, 'failed');
    assert.equal(error.receipt.cleanup.delete_receipt.residue_verified, true);
    assert.equal(error.receipt.cleanup.post_delete_residue.residue_rows, 0);
    return true;
  });
});

test('cleanup residue and second-pass divergence fail loudly', async () => {
  await assert.rejects(() => runHarness({ ops: fakeOps({ residue: 2 }), worlds: [world, world, world, { ...world, worldId: 'f3::sibling::x' }], runToken: 'residue' }), (error) => error.code === 'EAW_CLEANUP_RESIDUE' && error.receipt.cleanup.post_delete_residue.residue_rows === 2);
  await assert.rejects(() => runHarness({ ops: fakeOps({ divergent: true }), worlds: [world, world, world, { ...world, worldId: 'f3::sibling::x' }], runToken: 'drift' }), (error) => error.code === 'EAW_SECOND_PASS_DIVERGED' && error.receipt.cleanup.post_delete_residue.residue_rows === 0);
});

test('compiled documents always carry a legal document_type', async () => {
  const { DOC_TYPE_BY_KIND } = await import('./eval_world_db_close.js');
  const legal = new Set(['bank_statement', 'chart_of_accounts', 'contract', 'financing', 'issued_receipt',
    'payment_confirmation', 'payroll_cpf', 'receipt', 'sales_invoice', 'statutory_record', 'supplier_bill',
    'unknown', 'xero_setup', 'payment_account_statement']);
  for (const mapped of Object.values(DOC_TYPE_BY_KIND)) assert.ok(legal.has(mapped), mapped);
  const worlds = await loadDeclaredWorlds();
  for (const w of worlds) {
    const input = compileWorldInput(w, { firmId: 'eaw-doc-check', clientId: 'eaw-doc-check-client-1' });
    for (const doc of input.documents) assert.ok(legal.has(doc.document_type), `${w.worldId}: ${doc.document_type}`);
  }
});
