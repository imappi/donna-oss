// Unit 50 production prerequisite — the EAW read-only observer ops
// (countPersistedJournalsInDb / readTerminalInventoryInDb). The merged
// Unit 52 crash-resume harness refuses without them
// (EAW_RESUME_PROBE_INCOMPLETE); these tests pin the persisted-read
// semantics and the byte-shape of the terminal projection the resume probe
// compares with JSON.stringify. CI-safe: every DB interaction runs against
// a scripted fake client; no live database.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://localhost:5432/donna-eaw-observer-test';

const firmDb = await import('./firmDb.js');
const {
  EAW_CLOSE_COMPOSITION_BOUNDARY,
  EAW_OBSERVER_OPS_VERSION,
  EawFirmLifecycleError,
  countPersistedJournalsInDb,
  readTerminalInventoryInDb
} = firmDb;
const { projectTerminalState } = await import('../../scripts/eval_world_db_close.js');

// Minimal scripted client (the eawFirmLifecycle.test.js pattern): first
// matching responder answers; everything else returns empty rows.
const createFakeDb = (responders = []) => {
  const queries = [];
  const query = async (sql, params = []) => {
    queries.push({ sql, params });
    for (const [pattern, response] of responders) {
      if (pattern.test(sql)) {
        return typeof response === 'function' ? response({ sql, params }) : response;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  const withFirmDbClientFn = async (callback) => callback({ query });
  const matching = (pattern) => queries.filter(({ sql }) => pattern.test(sql));
  return { queries, query, withFirmDbClientFn, matching };
};

const JOURNALS_SQL = /from ledger_journals/;
const PERIODS_SQL = /from close_periods/;
const ASKS_SQL = /from client_evidence_requests/;

test('both observers refuse a missing firm id before any statement runs', async () => {
  for (const firmId of ['', '   ', null, undefined, 42]) {
    for (const fn of [countPersistedJournalsInDb, readTerminalInventoryInDb]) {
      const db = createFakeDb();
      await assert.rejects(
        fn({ firmId, withFirmDbClientFn: db.withFirmDbClientFn }),
        (error) => error instanceof EawFirmLifecycleError && error.code === 'EAW_FIRM_ID_REQUIRED'
      );
      assert.equal(db.queries.length, 0);
    }
  }
});

test('countPersistedJournalsInDb counts non-voided journals firm-wide and returns the { count } probe shape', async () => {
  const db = createFakeDb([[JOURNALS_SQL, { rows: [{ count: 3 }] }]]);
  const result = await countPersistedJournalsInDb({ firmId: 'eaw-run-1', withFirmDbClientFn: db.withFirmDbClientFn });
  assert.equal(result.count, 3);
  assert.equal(result.version, EAW_OBSERVER_OPS_VERSION);
  assert.equal(result.client_id, null);
  assert.equal(Object.isFrozen(result), true);
  const [{ sql, params }] = db.matching(JOURNALS_SQL);
  assert.match(sql, /status <> 'voided'/, 'voided journals are not persisted inventory');
  assert.deepEqual(params, ['eaw-run-1']);
  assert.doesNotMatch(sql, /client_id/, 'no client clause when unscoped');
});

test('countPersistedJournalsInDb scopes to the client when one is given', async () => {
  const db = createFakeDb([[JOURNALS_SQL, { rows: [{ count: 1 }] }]]);
  const result = await countPersistedJournalsInDb({
    firmId: 'eaw-run-1', clientId: 'eaw-run-1-client-1', withFirmDbClientFn: db.withFirmDbClientFn
  });
  assert.equal(result.count, 1);
  assert.equal(result.client_id, 'eaw-run-1-client-1');
  const [{ sql, params }] = db.matching(JOURNALS_SQL);
  assert.match(sql, /client_id = \$2/);
  assert.deepEqual(params, ['eaw-run-1', 'eaw-run-1-client-1']);
});

test('a locked clean close reads as the exact harness terminal byte-shape', async () => {
  const db = createFakeDb([
    [JOURNALS_SQL, { rows: [{ id: 'journal-a' }, { id: 'journal-b' }] }],
    [PERIODS_SQL, { rows: [{ id: 'cp-1', client_id: 'c1', period_start: '2026-08-01', period_end: '2026-08-31', status: 'locked' }] }],
    [ASKS_SQL, { rows: [] }]
  ]);
  const result = await readTerminalInventoryInDb({ firmId: 'eaw-run-1', withFirmDbClientFn: db.withFirmDbClientFn });
  // The resume probe compares JSON.stringify(terminal) with the harness's
  // projectTerminalState output — key order included. This literal IS that
  // projection's locked shape; do not reorder keys on either side.
  assert.equal(
    JSON.stringify(result.terminal),
    JSON.stringify({ t1: [{ source: 'close_period_status', status: 'locked' }], locked: true, t2: [], limbo: [] })
  );
  assert.deepEqual(result.journal_ids, ['journal-a', 'journal-b']);
  assert.deepEqual(result.counts, { journals: 2, t1: 1, t2: 0, limbo: 0 });
  assert.deepEqual(result.limbo, []);
  assert.equal(Object.isFrozen(result.terminal), true);
  const [{ sql }] = db.matching(JOURNALS_SQL);
  assert.match(sql, /order by journal_date, created_at, id/, 'journal inventory order is deterministic');
});

test('production observer and EAW harness share canonical customer-human, replied, and agent ask projection', async () => {
  const requests = [
    { id: 'ask-2', client_id: 'c1', status: 'replied' },
    { id: 'ask-1', client_id: 'c1', status: 'open' },
    { id: 'ask-3', client_id: 'c1', status: 'open', audience: 'agent' },
  ];
  const db = createFakeDb([
    [ASKS_SQL, { rows: requests }]
  ]);
  const result = await readTerminalInventoryInDb({ firmId: 'eaw-run-1', withFirmDbClientFn: db.withFirmDbClientFn });
  assert.deepEqual(result.terminal.t2, [
    { source: 'getClientEvidenceRequestsFromDb', id: 'ask-1', responsible_actor: 'owner' }
  ]);
  assert.equal(result.terminal.locked, false);
  assert.deepEqual(result.terminal.limbo, [
    { source: 'getClientEvidenceRequestsFromDb', id: 'ask-2', reason: 'answered_customer_ask_awaiting_processing' },
    { source: 'getClientEvidenceRequestsFromDb', id: 'ask-3', reason: 'agent_ask_unanswered' },
  ]);
  assert.equal(JSON.stringify(result.terminal), JSON.stringify(projectTerminalState({
    preview: { close_preview: { lockable: false } },
    exceptions: { exceptions: [] },
    evidenceRequests: { requests },
  })), 'the production persisted observer and harness projector must remain byte-identical');
  const [{ sql, params }] = db.matching(ASKS_SQL);
  assert.match(sql, /order by updated_at desc/, 'ask order matches getClientEvidenceRequestsFromDb');
  assert.deepEqual(params.at(-1), ['draft', 'open', 'replied']);
});

test('a locked period coexisting with open asks refuses — the contradiction is never rendered', async () => {
  const db = createFakeDb([
    [PERIODS_SQL, { rows: [{ id: 'cp-1', client_id: 'c1', status: 'locked' }] }],
    [ASKS_SQL, { rows: [{ id: 'ask-1', client_id: 'c1', status: 'open' }] }]
  ]);
  await assert.rejects(
    readTerminalInventoryInDb({ firmId: 'eaw-run-1', withFirmDbClientFn: db.withFirmDbClientFn }),
    (error) => error instanceof EawFirmLifecycleError
      && error.code === 'EAW_TERMINAL_CONTRADICTION' && error.statusCode === 409
  );
});

test('a firm with nothing terminal persisted reads as limbo, never as a clean terminal', async () => {
  const db = createFakeDb();
  const result = await readTerminalInventoryInDb({ firmId: 'eaw-run-1', withFirmDbClientFn: db.withFirmDbClientFn });
  assert.deepEqual(result.terminal, {
    t1: [], locked: false, t2: [],
    limbo: [{ reason: 'no exclusive production terminal projection' }]
  });
  assert.equal(result.limbo.length, 1);
  assert.deepEqual(result.counts, { journals: 0, t1: 0, t2: 0, limbo: 1 });
});

test('an unlocked close period alone is not terminal', async () => {
  const db = createFakeDb([
    [PERIODS_SQL, { rows: [{ id: 'cp-1', client_id: 'c1', status: 'reviewing' }] }]
  ]);
  const result = await readTerminalInventoryInDb({ firmId: 'eaw-run-1', withFirmDbClientFn: db.withFirmDbClientFn });
  assert.deepEqual(result.terminal.t1, []);
  assert.equal(result.terminal.locked, false);
  assert.equal(result.terminal.limbo.length, 1);
});

test('the composition boundary names both observers and carries the v2 manifest version', () => {
  assert.deepEqual(
    [...EAW_CLOSE_COMPOSITION_BOUNDARY.observers],
    ['countPersistedJournalsInDb', 'readTerminalInventoryInDb']
  );
  assert.equal(EAW_CLOSE_COMPOSITION_BOUNDARY.version, 'eaw.close-composition-boundary.v2');
  for (const name of EAW_CLOSE_COMPOSITION_BOUNDARY.observers) {
    assert.equal(typeof firmDb[name], 'function');
  }
});
