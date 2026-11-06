// Unit 39 production prerequisite — the EAW isolated-firm lifecycle
// (createFirmInDb / deleteFirmInDb / countFirmResidueInDb) and the named
// close-composition boundary manifest. deleteFirmInDb is a RETIRE, not a
// cascade: migration 119 makes audit_events append-only with no escape, so
// the trail and the retired firms row survive by design. CI-safe: every DB
// interaction runs against a scripted fake client; no live database.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://localhost:5432/donna-eaw-lifecycle-test';

const firmDb = await import('./firmDb.js');
const {
  EAW_CLOSE_COMPOSITION_BOUNDARY,
  EAW_FIRM_LIFECYCLE_VERSION,
  EawFirmLifecycleError,
  assertEawFirmLifecycleAllowed,
  countFirmResidueInDb,
  createFirmInDb,
  deleteFirmInDb
} = firmDb;

const ACTOR = { type: 'eaw_operator', id: 'kari@books.example' };

// Minimal scripted client: first matching responder answers; everything else
// returns empty rows. Records every statement for assertions.
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

const FIRM_PAIRS_SQL = /c\.column_name = 'firm_id'/;
const CLIENT_ONLY_SQL = /ccu\.table_name = 'clients'/;

test('the guard refuses every non-eaw firm id, the demo firm included', () => {
  for (const firmId of ['donna-demo-firm', 'firm-honeybee', 'eaw-', '', null, undefined, 'EAW-caps']) {
    assert.throws(
      () => assertEawFirmLifecycleAllowed({ firmId, databaseUrl: 'postgres://localhost/x' }),
      (error) => error instanceof EawFirmLifecycleError && error.code === 'EAW_FIRM_ID_REQUIRED'
    );
  }
  assert.equal(
    assertEawFirmLifecycleAllowed({ firmId: 'eaw-run-1', databaseUrl: 'postgres://localhost/x' }),
    'eaw-run-1'
  );
});

test('the guard refuses a non-local database without the explicit opt-in, and honors it', () => {
  const hosted = 'postgres://user:pw@db.example-hosted.com:5432/prod';
  assert.throws(
    () => assertEawFirmLifecycleAllowed({ firmId: 'eaw-run-1', databaseUrl: hosted, env: {} }),
    (error) => error.code === 'EAW_FIRM_LIFECYCLE_BLOCKED' && error.statusCode === 403
  );
  assert.equal(
    assertEawFirmLifecycleAllowed({
      firmId: 'eaw-run-1', databaseUrl: hosted, env: { DONNA_ALLOW_EAW_FIRM_LIFECYCLE: 'true' }
    }),
    'eaw-run-1'
  );
  assert.throws(
    () => assertEawFirmLifecycleAllowed({ firmId: 'eaw-run-1', databaseUrl: '' }),
    (error) => error.code === 'EAW_DB_UNCONFIGURED'
  );
});

test('a missing or system actor refuses before any statement runs', async () => {
  for (const actor of [undefined, {}, { type: 'eaw_operator' }, { type: 'eaw_operator', id: '  ' },
    { type: 'eaw_operator', id: 'system' }, { type: 'eaw_operator', id: ' SYSTEM ' }]) {
    const db = createFakeDb();
    await assert.rejects(
      createFirmInDb({ firmId: 'eaw-run-1', name: 'EAW Run', actor, withFirmDbClientFn: db.withFirmDbClientFn }),
      (error) => error.code === 'EAW_ACTOR_REQUIRED'
    );
    assert.equal(db.queries.length, 0);
  }
});

test('createFirmInDb inserts the firm with eaw provenance and a real-actor audit event', async () => {
  const db = createFakeDb();
  const receipt = await createFirmInDb({
    firmId: 'eaw-run-1', name: 'EAW Close Run', jurisdiction: 'GB', currency: 'GBP',
    actor: ACTOR, withFirmDbClientFn: db.withFirmDbClientFn
  });

  const insert = db.matching(/insert into firms/)[0];
  assert.ok(insert, 'the firms insert ran');
  assert.equal(insert.params[0], 'eaw-run-1');
  assert.equal(JSON.parse(insert.params[4]).created_via, 'eaw_lifecycle');
  assert.ok(!/on conflict/.test(insert.sql), 'a lifecycle create never upserts');

  const audit = db.matching(/insert into audit_events/)[0];
  assert.ok(audit, 'the creation audit event ran');
  assert.equal(audit.params[1], 'eaw_operator');
  assert.equal(audit.params[2], 'kari@books.example');
  assert.match(audit.sql, /firm\.eaw_created/);

  assert.equal(db.matching(/^commit$/).length, 1);
  assert.equal(receipt.op, 'firm_created');
  assert.equal(receipt.version, EAW_FIRM_LIFECYCLE_VERSION);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.actor), true);
});

test('createFirmInDb may mint one inert owner member for an authenticated product-path proof', async () => {
  const db = createFakeDb();
  const receipt = await createFirmInDb({
    firmId: 'eaw-run-member',
    name: 'EAW Member Run',
    actor: ACTOR,
    member: {
      id: 'eaw-run-member-owner',
      name: 'Isolated Owner',
      email: 'gate2a-owner@example.invalid'
    },
    withFirmDbClientFn: db.withFirmDbClientFn
  });
  const insert = db.matching(/insert into firm_members/)[0];
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(0, 4), [
    'eaw-run-member-owner', 'eaw-run-member', 'gate2a-owner@example.invalid', 'Isolated Owner'
  ]);
  assert.equal(JSON.parse(insert.params[4]).external_delivery_allowed, false);
  assert.deepEqual(receipt.member, {
    id: 'eaw-run-member-owner',
    email: 'gate2a-owner@example.invalid',
    external_delivery_allowed: false
  });
});

test('createFirmInDb refuses an EAW member address that could be a production recipient', async () => {
  const db = createFakeDb();
  await assert.rejects(
    createFirmInDb({
      firmId: 'eaw-run-member',
      name: 'EAW Member Run',
      actor: ACTOR,
      member: { id: 'member-1', name: 'Owner', email: 'owner@real-company.test' },
      withFirmDbClientFn: db.withFirmDbClientFn
    }),
    (error) => error.code === 'EAW_MEMBER_ISOLATION_REQUIRED'
  );
  assert.equal(db.matching(/^rollback$/).length, 1);
  assert.equal(db.matching(/^commit$/).length, 0);
});

test('createFirmInDb refuses an existing firm and rolls back', async () => {
  const db = createFakeDb([[/select id from firms where id/, { rows: [{ id: 'eaw-run-1' }] }]]);
  await assert.rejects(
    createFirmInDb({ firmId: 'eaw-run-1', name: 'X', actor: ACTOR, withFirmDbClientFn: db.withFirmDbClientFn }),
    (error) => error.code === 'EAW_FIRM_EXISTS' && error.statusCode === 409
  );
  assert.equal(db.matching(/insert into firms/).length, 0);
  assert.equal(db.matching(/^rollback$/).length, 1);
});

test('deleteFirmInDb refuses a firm the lifecycle did not create, and a missing firm', async () => {
  const foreign = createFakeDb([
    [/select id, metadata from firms/, { rows: [{ id: 'eaw-imposter', metadata: { created_via: 'desktop_first_run' } }] }]
  ]);
  await assert.rejects(
    deleteFirmInDb({ firmId: 'eaw-imposter', actor: ACTOR, withFirmDbClientFn: foreign.withFirmDbClientFn }),
    (error) => error.code === 'EAW_FIRM_NOT_EAW_CREATED' && error.statusCode === 403
  );
  assert.equal(foreign.matching(/delete from/).length, 0);
  assert.equal(foreign.matching(/^rollback$/).length, 1);

  const missing = createFakeDb();
  await assert.rejects(
    deleteFirmInDb({ firmId: 'eaw-gone', actor: ACTOR, withFirmDbClientFn: missing.withFirmDbClientFn }),
    (error) => error.code === 'EAW_FIRM_NOT_FOUND' && error.statusCode === 404
  );
});

// Retire-path responders. state.wiped flips when the clients delete runs;
// counts read 0 afterwards (except a stubborn table when configured).
const retireResponders = (state) => [
  [/select id, metadata from firms/, () => ({
    rows: [{ id: 'eaw-run-1', metadata: state.retired
      ? { created_via: 'eaw_lifecycle', eaw_retired_at: '2026-08-19T18:30:00Z' }
      : { created_via: 'eaw_lifecycle' } }]
  })],
  [/select id from clients where firm_id/, { rows: [{ id: 'eaw-client-1' }] }],
  [/from audit_events where firm_id = \$1 order by id/, {
    rows: [
      { id: 1, firm_id: 'eaw-run-1', action: 'firm.eaw_created', actor_id: 'kari@books.example' },
      { id: 2, firm_id: 'eaw-run-1', action: 'client.create', actor_id: 'kari@books.example' }
    ]
  }],
  [/select count\(\*\)::int as n from audit_events/, () => ({ rows: [{ n: state.retired ? 3 : 2 }] })],
  [FIRM_PAIRS_SQL, { rows: [
    { table_name: 'clients', column_name: 'firm_id' },
    { table_name: 'audit_events', column_name: 'firm_id' },
    { table_name: 'memories', column_name: 'tenant_id' },
    { table_name: 'reconciliation_evaluations', column_name: 'firm_id' }
  ] }],
  [CLIENT_ONLY_SQL, { rows: [{ table_name: 'message_delivery_ledger', column_name: 'client_id' }] }],
  [/select set_config\('donna\.allow_append_only_purge'/, () => { state.gucSet = true; return { rows: [] }; }],
  [/^delete from clients where firm_id/, () => { state.wiped = true; return { rowCount: 1 }; }],
  [/delete from "reconciliation_evaluations"/, () => { state.evalSwept = true; return { rowCount: state.stubborn ? 0 : 2 }; }],
  [/update firms/, () => { state.retired = true; return { rowCount: 1 }; }],
  [/select count\(\*\)::int as n from "clients"/, () => ({ rows: [{ n: state.wiped ? 0 : 1 }] })],
  [/select count\(\*\)::int as n from "memories"/, () => ({ rows: [{ n: 0 }] })],
  [/select count\(\*\)::int as n from "reconciliation_evaluations"/, () => ({
    rows: [{ n: state.wiped && state.evalSwept && !state.stubborn ? 0 : 2 }]
  })],
  [/select count\(\*\)::int as n from "message_delivery_ledger"/, () => ({ rows: [{ n: state.wiped ? 0 : 4 }] })]
];

test('deleteFirmInDb retires: exports the trail, sweeps state, never deletes firms or audit_events', async () => {
  const state = { wiped: false, evalSwept: false, retired: false, gucSet: false, stubborn: false };
  const db = createFakeDb(retireResponders(state));
  const receipt = await deleteFirmInDb({ firmId: 'eaw-run-1', actor: ACTOR, withFirmDbClientFn: db.withFirmDbClientFn });

  assert.equal(state.gucSet, true, 'the 037/038 purge GUC was set transaction-locally');
  assert.equal(state.wiped, true, 'the clients delete ran');
  assert.equal(state.evalSwept, true, 'the plain-firm_id straggler sweep ran');
  assert.equal(state.retired, true, 'the firms row was retired');
  assert.equal(db.matching(/^delete from firms/).length, 0, 'the firms row is never deleted');
  assert.equal(db.matching(/delete from "audit_events"/).length, 0, 'the audit trail is never swept');
  assert.equal(db.matching(/delete from audit_events/).length, 0, 'the audit trail is never deleted');
  assert.ok(db.matching(/firm\.eaw_retired/).length, 'the retirement audit event was appended');
  assert.equal(db.matching(/^commit$/).length, 1);

  assert.equal(receipt.op, 'firm_retired');
  assert.deepEqual(receipt.client_ids, ['eaw-client-1']);
  assert.equal(receipt.authority_plane.length, 1);
  assert.equal(receipt.audit_trail.length, 2, 'the trail export rides the receipt');
  assert.equal(receipt.residue_verified, true);
  assert.equal(receipt.tables_checked, 4, 'audit_events and firms are excluded from residue accounting');
  assert.deepEqual(
    receipt.rows_deleted.map(({ table, rows }) => [table, rows]),
    [['clients', 1], ['reconciliation_evaluations', 2], ['message_delivery_ledger', 4]]
  );
  assert.deepEqual(receipt.retained, { firm_row_present: true, firm_retired: true, audit_event_rows: 3 });
  assert.match(receipt.note, /countFirmResidueInDb/);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.audit_trail), true);
});

test('deleteFirmInDb fails CLOSED when residue survives the sweep — rollback, no retirement', async () => {
  const state = { wiped: false, evalSwept: false, retired: false, gucSet: false, stubborn: true };
  const db = createFakeDb(retireResponders(state));
  await assert.rejects(
    deleteFirmInDb({ firmId: 'eaw-run-1', actor: ACTOR, withFirmDbClientFn: db.withFirmDbClientFn }),
    (error) => error.code === 'EAW_FIRM_RESIDUE' && /reconciliation_evaluations \(2\)/.test(error.message)
  );
  assert.equal(db.matching(/^commit$/).length, 0);
  assert.equal(db.matching(/^rollback$/).length, 1);
  assert.equal(state.retired, false, 'a failed sweep never marks the firm retired');
});

test('countFirmResidueInDb is the read-only independent probe with the retained set split out', async () => {
  const state = { wiped: true, evalSwept: true, retired: true, gucSet: false, stubborn: false };
  const db = createFakeDb(retireResponders(state));
  const probe = await countFirmResidueInDb({
    firmId: 'eaw-run-1', clientIds: ['eaw-client-1'], withFirmDbClientFn: db.withFirmDbClientFn
  });
  assert.equal(probe.residue_rows, 0);
  assert.deepEqual(probe.residue, []);
  assert.equal(probe.tables_checked, 4);
  assert.deepEqual(probe.retained, { firm_row_present: true, firm_retired: true, audit_event_rows: 3 });
  assert.equal(db.matching(/^delete/).length, 0, 'the probe never mutates');
  assert.equal(db.matching(/^begin$/).length, 0, 'the probe opens no transaction');

  await assert.rejects(
    countFirmResidueInDb({ firmId: '', withFirmDbClientFn: db.withFirmDbClientFn }),
    (error) => error.code === 'EAW_FIRM_ID_REQUIRED'
  );
});

test('the composition boundary manifest is complete: every name is a real firmDb export', () => {
  const names = Object.entries(EAW_CLOSE_COMPOSITION_BOUNDARY)
    .filter(([key]) => key !== 'version')
    .flatMap(([, list]) => list);
  assert.ok(names.length >= 19, 'the manifest names the full close journey plus the observer probes');
  for (const name of names) {
    assert.equal(typeof firmDb[name], 'function', `${name} must be an exported function`);
  }
  assert.ok(names.includes('createFirmInDb') && names.includes('deleteFirmInDb')
    && names.includes('countFirmResidueInDb'), 'the firm lifecycle is part of the named boundary');
  assert.equal(Object.isFrozen(EAW_CLOSE_COMPOSITION_BOUNDARY), true);
});
