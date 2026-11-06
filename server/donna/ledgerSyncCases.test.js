// INT-4 — ledgerSyncCases unit tests. Load-bearing properties:
//   - flag off (no DB row, envFallback false) → NOTHING minted, nothing logged as
//     minted (born-on-the-plane: env can never enable it)
//   - shadow stage → observe-only: a log line, ZERO case-spine writes
//   - canary/auto → mints a 'sync' case + external_sync_failed blocker (owner
//     external_connector → case parks at 'blocked'), idempotently
//   - resolution is NOT flag-gated, resolves blockers and terminalizes the case
//   - a terminal case gets REOPENED before a new blocker lands (a new failure
//     must never hide behind an old resolved verdict)
//   - mirror-verify entries: missing/drift → external_sync_pending; ok → resolve
//     pending only; mirror_error → untouched
//   - best-effort BY CONTRACT: a poisoned client never throws out of the module
//
// Uses a small stateful fake pg client so the mint → resolve cycle runs against
// the same state the way it does in prod (mirrors caseManager.test.js's
// mock-client approach, with state instead of a responder queue).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEDGER_SYNC_CASES_FLAG_KEY,
  syncCaseAnchor,
  recordExternalSyncFailure,
  recordExternalSyncDrift,
  resolveExternalSyncCase,
  applyMirrorVerificationToSyncCases
} from './ledgerSyncCases.js';
import { LOOP_CASE_TYPES } from './caseManager.js';

// ── stateful fake pg client ──────────────────────────────────────────────────
const makeFakeDb = ({ stage = null, tablesPresent = true } = {}) => {
  const state = {
    cases: new Map(),      // id → row
    blockers: new Map(),   // id → row
    events: [],            // { id, case_id, event_type }
    links: [],
    calls: []
  };
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      const t = text.toLowerCase().replace(/\s+/g, ' ');
      state.calls.push({ sql: t, params });
      if (t === 'begin' || t === 'commit' || t === 'rollback') return { rows: [] };
      if (t.includes('to_regclass')) {
        return { rows: [{ present: tablesPresent ? 'bookkeeping_cases' : null }] };
      }
      if (t.includes('from client_capability_config')) {
        return stage
          ? { rows: [{ flag_key: LEDGER_SYNC_CASES_FLAG_KEY, stage, source: 'manual', client_id: null }] }
          : { rows: [] };
      }
      if (t.includes('cohort_capability_config')) return { rows: [] };
      if (t.includes('insert into bookkeeping_cases')) {
        const [id, firmId, clientId, caseType, title, summary, poType, poId] = params;
        if (state.cases.has(id)) return { rows: [] };
        const row = {
          id, firm_id: firmId, client_id: clientId, case_type: caseType,
          status: 'open', title, summary,
          primary_object_type: poType, primary_object_id: poId,
          terminal_state: null, case_version: 1
        };
        state.cases.set(id, row);
        return { rows: [row] };
      }
      if (t.includes('select * from bookkeeping_cases where id')) {
        const row = state.cases.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (t.includes('select id, status from bookkeeping_cases where id')) {
        const row = state.cases.get(params[0]);
        return { rows: row ? [{ id: row.id, status: row.status }] : [] };
      }
      if (t.includes('insert into bookkeeping_case_events')) {
        const [id, , , caseId, eventType] = params;
        state.events.push({ id, case_id: caseId, event_type: eventType });
        return { rows: [{ id }] };
      }
      if (t.includes('update bookkeeping_cases set last_activity_at')) return { rows: [] };
      if (t.includes('set case_version = case_version + 1')) {
        const row = state.cases.get(params[0]);
        if (row) row.case_version += 1;
        return { rows: row ? [{ case_version: row.case_version }] : [] };
      }
      if (t.includes('insert into bookkeeping_case_links')) {
        const [id, , , caseId, objectType, objectId, role] = params;
        const dup = state.links.find((l) =>
          l.case_id === caseId && l.object_type === objectType && l.object_id === objectId && l.role === role);
        if (dup) return { rows: [] };
        state.links.push({ id, case_id: caseId, object_type: objectType, object_id: objectId, role });
        return { rows: [{ id }] };
      }
      if (t.includes('select id from bookkeeping_case_blockers') && t.includes('blocker_type = $2')) {
        // openBlocker equivalent-open dedupe
        const [caseId, blockerType, ownerType, objectType, objectId] = params;
        const hit = [...state.blockers.values()].find((b) =>
          b.case_id === caseId && b.blocker_type === blockerType && b.owner_type === ownerType &&
          b.status === 'open' && (b.object_type || '') === (objectType || '') && (b.object_id || '') === (objectId || ''));
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (t.includes('select id from bookkeeping_case_blockers') && t.includes('any($2::text[])')) {
        const [caseId, types] = params;
        const rows = [...state.blockers.values()]
          .filter((b) => b.case_id === caseId && b.status === 'open' && types.includes(b.blocker_type))
          .map((b) => ({ id: b.id }));
        return { rows };
      }
      if (t.includes('insert into bookkeeping_case_blockers')) {
        const [id, firmId, clientId, caseId, blockerType, ownerType, objectType, objectId, reason] = params;
        state.blockers.set(id, {
          id, firm_id: firmId, client_id: clientId, case_id: caseId,
          blocker_type: blockerType, owner_type: ownerType, status: 'open',
          object_type: objectType, object_id: objectId, reason
        });
        return { rows: [] };
      }
      if (t.includes("update bookkeeping_case_blockers set status = 'resolved'")) {
        const b = state.blockers.get(params[0]);
        if (!b || b.status !== 'open') return { rows: [] };
        b.status = 'resolved';
        return {
          rows: [{
            case_id: b.case_id, firm_id: b.firm_id, client_id: b.client_id,
            blocker_type: b.blocker_type, owner_type: b.owner_type
          }]
        };
      }
      if (t.includes('select 1 from bookkeeping_case_blockers')) {
        const open = [...state.blockers.values()].find((b) => b.case_id === params[0] && b.status === 'open');
        return { rows: open ? [{ '?column?': 1 }] : [] };
      }
      if (t.includes('select event_type from bookkeeping_case_events')) {
        const terminalish = ['case.resolved', 'case.superseded', 'case.unsupported', 'case.abandoned', 'case.reopened'];
        const hits = state.events.filter((e) => e.case_id === params[0] && terminalish.includes(e.event_type));
        const latest = hits[hits.length - 1];
        return { rows: latest ? [{ event_type: latest.event_type }] : [] };
      }
      if (t.includes('select blocker_type, owner_type from bookkeeping_case_blockers')) {
        const rows = [...state.blockers.values()]
          .filter((b) => b.case_id === params[0] && b.status === 'open')
          .map((b) => ({ blocker_type: b.blocker_type, owner_type: b.owner_type }));
        return { rows };
      }
      if (t.includes('update bookkeeping_cases set status =') || (t.includes('update bookkeeping_cases') && t.includes('set status = $2'))) {
        const row = state.cases.get(params[0]);
        if (row) {
          row.status = params[1];
          if (['resolved', 'superseded', 'unsupported', 'abandoned'].includes(params[1])) {
            row.terminal_state = params[1];
          }
        }
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  return { client, state };
};

const ARGS = {
  firmId: 'firm-1', clientId: 'cl-1', accountingSystem: 'xero',
  transactionId: 'tx-1', errorMessage: 'boom', errorCode: 'XERO_FAIL', source: 'xero_writeback'
};

test('vocabulary: sync is a real case type', () => {
  assert.ok(LOOP_CASE_TYPES.includes('sync'));
});

test('syncCaseAnchor: transaction preferred, journal fallback, null without either', () => {
  assert.deepEqual(syncCaseAnchor({ transactionId: 't1', journalId: 'j1' }), { type: 'transaction', id: 't1' });
  assert.deepEqual(syncCaseAnchor({ journalId: 'j1' }), { type: 'ledger_journal', id: 'j1' });
  assert.equal(syncCaseAnchor({}), null);
});

test('flag off (no DB row, env fallback false) → mode off, zero case writes', async () => {
  const { client, state } = makeFakeDb({ stage: null });
  const out = await recordExternalSyncFailure({ client, ...ARGS });
  assert.deepEqual(out, { mode: 'off' });
  assert.equal(state.cases.size, 0);
  assert.equal(state.blockers.size, 0);
});

test('shadow stage → observe-only: no case-spine writes', async () => {
  const { client, state } = makeFakeDb({ stage: 'shadow' });
  const out = await recordExternalSyncFailure({ client, ...ARGS });
  assert.deepEqual(out, { mode: 'shadow' });
  assert.equal(state.cases.size, 0);
  assert.equal(state.blockers.size, 0);
});

test('canary stage → mints a sync case + external_sync_failed blocker at blocked', async () => {
  const { client, state } = makeFakeDb({ stage: 'canary' });
  const out = await recordExternalSyncFailure({ client, ...ARGS });
  assert.equal(out.mode, 'minted');
  assert.equal(state.cases.size, 1);
  const kase = [...state.cases.values()][0];
  assert.equal(kase.case_type, 'sync');
  assert.equal(kase.primary_object_type, 'transaction');
  assert.equal(kase.primary_object_id, 'tx-1');
  // external_connector + hard-fail blocker → the projection parks it at blocked
  assert.equal(kase.status, 'blocked');
  const blocker = [...state.blockers.values()][0];
  assert.equal(blocker.blocker_type, 'external_sync_failed');
  assert.equal(blocker.owner_type, 'external_connector');
  assert.match(blocker.reason, /Xero export failed/);
  assert.match(blocker.reason, /XERO_FAIL/);
});

test('repeat failure is idempotent: one case, one open blocker', async () => {
  const { client, state } = makeFakeDb({ stage: 'auto' });
  await recordExternalSyncFailure({ client, ...ARGS });
  await recordExternalSyncFailure({ client, ...ARGS });
  assert.equal(state.cases.size, 1);
  assert.equal([...state.blockers.values()].filter((b) => b.status === 'open').length, 1);
});

test('resolution is NOT flag-gated: resolves the blocker and terminalizes the case', async () => {
  const { client, state } = makeFakeDb({ stage: 'canary' });
  await recordExternalSyncFailure({ client, ...ARGS });
  // resolveExternalSyncCase never reads the flag — a flag flipped off after a
  // mint must not strand the open case
  const out = await resolveExternalSyncCase({
    client, firmId: 'firm-1', clientId: 'cl-1', transactionId: 'tx-1',
    reason: 'Xero writeback succeeded.'
  });
  assert.equal(out.resolvedBlockers, 1);
  assert.equal(out.resolvedCases, 1);
  const kase = [...state.cases.values()][0];
  assert.equal(kase.status, 'resolved');
  assert.ok(state.events.some((e) => e.event_type === 'case.resolved'));
});

test('a NEW failure after resolution reopens the terminal case (never hides behind it)', async () => {
  const { client, state } = makeFakeDb({ stage: 'canary' });
  await recordExternalSyncFailure({ client, ...ARGS });
  await resolveExternalSyncCase({ client, firmId: 'firm-1', clientId: 'cl-1', transactionId: 'tx-1' });
  assert.equal([...state.cases.values()][0].status, 'resolved');
  const out = await recordExternalSyncFailure({ client, ...ARGS });
  assert.equal(out.mode, 'minted');
  const kase = [...state.cases.values()][0];
  assert.equal(kase.status, 'blocked', 'reopened + re-blocked, not resting resolved with a hidden blocker');
  assert.ok(state.events.some((e) => e.event_type === 'case.reopened'));
});

test('resolve with no case is a quiet no-op', async () => {
  const { client } = makeFakeDb({ stage: 'canary' });
  const out = await resolveExternalSyncCase({
    client, firmId: 'firm-1', clientId: 'cl-1', transactionId: 'tx-none'
  });
  assert.deepEqual(out, { resolvedBlockers: 0, resolvedCases: 0 });
});

test('mirror-verify entries: drift mints external_sync_pending (waiting_system); ok resolves it; error untouched', async () => {
  const { client, state } = makeFakeDb({ stage: 'auto' });
  const drift = await applyMirrorVerificationToSyncCases({
    client, firmId: 'firm-1', clientId: 'cl-1', accountingSystem: 'qbo',
    entries: [
      { transactionId: 'tx-2', journalId: 'j-2', status: 'mirror_drift', detail: 'failed checks: amount' },
      { journalId: 'j-err', status: 'mirror_error', detail: 'fetch failed' }
    ]
  });
  assert.equal(drift.minted, 1);
  const kase = [...state.cases.values()][0];
  assert.equal(kase.case_type, 'sync');
  assert.equal(kase.status, 'waiting_system', 'pending is a soft system wait, not a hard fail');
  const blocker = [...state.blockers.values()][0];
  assert.equal(blocker.blocker_type, 'external_sync_pending');
  assert.equal(state.cases.size, 1, 'mirror_error minted nothing');

  const ok = await applyMirrorVerificationToSyncCases({
    client, firmId: 'firm-1', clientId: 'cl-1', accountingSystem: 'qbo',
    entries: [{ transactionId: 'tx-2', journalId: 'j-2', status: 'mirror_ok' }]
  });
  assert.equal(ok.resolved, 1);
  assert.equal([...state.cases.values()][0].status, 'resolved');
});

test('mirror_ok does NOT resolve a failed-push blocker (only pending)', async () => {
  const { client, state } = makeFakeDb({ stage: 'auto' });
  await recordExternalSyncFailure({ client, ...ARGS });
  await applyMirrorVerificationToSyncCases({
    client, firmId: 'firm-1', clientId: 'cl-1', accountingSystem: 'xero',
    entries: [{ transactionId: 'tx-1', status: 'mirror_ok' }]
  });
  const blocker = [...state.blockers.values()][0];
  assert.equal(blocker.blocker_type, 'external_sync_failed');
  assert.equal(blocker.status, 'open', 'a failed push clears only on a successful export');
});

test('loops tables absent → no-op, no writes', async () => {
  const { client, state } = makeFakeDb({ stage: 'auto', tablesPresent: false });
  const out = await recordExternalSyncFailure({ client, ...ARGS });
  assert.equal(out, null);
  assert.equal(state.cases.size, 0);
});

test('best-effort by contract: a poisoned client never throws', async () => {
  const poisoned = {
    query: async () => { throw new Error('db exploded'); }
  };
  const out = await recordExternalSyncFailure({ client: poisoned, ...ARGS });
  assert.equal(out, null);
  const out2 = await resolveExternalSyncCase({
    client: poisoned, firmId: 'f', clientId: 'c', transactionId: 't'
  });
  assert.equal(out2, null);
});

test('missing anchor / ids → null, zero queries', async () => {
  const { client, state } = makeFakeDb({ stage: 'auto' });
  assert.equal(await recordExternalSyncFailure({ client, firmId: 'f', clientId: 'c' }), null);
  assert.equal(await recordExternalSyncDrift({ client, firmId: 'f', clientId: 'c' }), null);
  assert.equal(state.calls.length, 0);
});
