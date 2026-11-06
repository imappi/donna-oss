// The D1 earned-auto ladder. Mock-pg harness. Pins:
//   - the default clean-send target sits in D1's recorded 5–10 band;
//   - a clean owner-approved send increments the streak; below target nothing
//     graduates and nothing touches the config plane;
//   - at target the ladder flips to EARNED — and with the REAL
//     AUTO_FORBIDDEN_FLAGS set every OUTBOUND terminal is vetoed, so the
//     result is 'terminal_not_approved': recorded, audited, resting on Kari,
//     ZERO config-plane writes (the load-bearing D1 interlock);
//   - once the veto lifts (injected forbidden set), graduation goes THROUGH
//     the audited stage writer to 'auto' with source 'earned_auto' — and only
//     from an acting stage (a non-acting snapshot never gets broadened);
//   - a stage already at 'auto' (Kari's manual terminal) marks the ladder
//     graduated WITHOUT a duplicate config write;
//   - a correction resets the streak and, after a LADDER-MINTED graduation,
//     suspends the 'auto' row back to 'canary'; a manually-staged 'auto' row
//     is never demoted (Kari's terminal call outranks machinery);
//   - the recorders are savepoint-guarded: a pre-100 DB (42P01) skips without
//     poisoning the caller's transaction;
//   - the tuning writer validates and audits (the config-plane home for N —
//     never an env pair).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CLEAN_SEND_TARGET, EARNED_AUTO_STATES, OUTBOUND_CORRECTION_KINDS,
  cleanSendTargetFor, recordCleanApprovedSend, recordOutboundCorrection,
  setEarnedAutoCleanTarget, sweepEarnedAutoGraduations, gatherEarnedAutoStates
} from './earnedAutoLadder.js';
import { AUTO_FORBIDDEN_FLAGS } from '../clientConfig.js';
import { OUTBOUND_ACTION_FLAG_KEYS } from './actionGate.js';

const FIRM = 'firm-1';
const CLIENT = 'client-1';
const BASE = { firmId: FIRM, clientId: CLIENT };

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(text)
        || text.startsWith('savepoint') || text.startsWith('release savepoint')
        || text.startsWith('rollback to savepoint')) {
        return { rows: [], rowCount: 0 };
      }
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows({ sql: text, params }) : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const audited = (client, action) => client.calls.filter(
  (c) => c.sql.includes('insert into audit_events') && (c.params || []).includes(action)
);

const configWrites = (client) => client.calls.filter(
  (c) => c.sql.includes('insert into client_capability_config')
);

const ladderRow = (over = {}) => ({
  id: 'ladder-1', firm_id: FIRM, client_id: CLIENT,
  action_type: 'send_receivable_reminder',
  clean_streak: 1, total_clean: 1, corrections_count: 0,
  clean_target: null, state: 'counting', ...over
});

test('vocabularies are closed and the default target sits in the 5-10 band (D1)', () => {
  assert.deepEqual([...EARNED_AUTO_STATES], ['counting', 'earned', 'graduated']);
  assert.ok(DEFAULT_CLEAN_SEND_TARGET >= 5 && DEFAULT_CLEAN_SEND_TARGET <= 10,
    'N defaults inside the recorded 5-10 band');
  assert.deepEqual([...OUTBOUND_CORRECTION_KINDS], [
    'declined_held_draft', 'cancelled_pre_send', 'edited_held_draft',
    'reply_if_wrong', 'post_send_reversal'
  ]);
  assert.equal(cleanSendTargetFor({ clean_target: 5 }), 5);
  assert.equal(cleanSendTargetFor({ clean_target: null }), DEFAULT_CLEAN_SEND_TARGET);
  assert.equal(cleanSendTargetFor(null), DEFAULT_CLEAN_SEND_TARGET);
});

test('a clean send below target counts and touches nothing else', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ clean_streak: 3, total_clean: 3 })] }
  ]);
  const result = await recordCleanApprovedSend(client, {
    ...BASE, actionType: 'send_receivable_reminder', actionId: 'a-1', receiptId: 'r-1'
  });
  assert.equal(result.skipped, false);
  assert.equal(result.earnedNow, false);
  assert.equal(result.graduated, false);
  assert.equal(audited(client, 'outbound_earned_auto.earned').length, 0);
  assert.equal(configWrites(client).length, 0);
});

test('at target the ladder EARNS — and the real AUTO_FORBIDDEN set rests it on Kari, zero config writes', async () => {
  // Every OUTBOUND_* flag key must still sit in the real forbidden set: this
  // is the pin that keeps the ladder from graduating anything before Kari's
  // per-terminal veto-lift PRs.
  for (const flagKey of Object.values(OUTBOUND_ACTION_FLAG_KEYS)) {
    assert.ok(AUTO_FORBIDDEN_FLAGS.has(flagKey), `${flagKey} still vetoed`);
  }
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET, total_clean: DEFAULT_CLEAN_SEND_TARGET })] },
    { match: "state = 'earned'", rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET, state: 'earned' })] }
  ]);
  const result = await recordCleanApprovedSend(client, {
    ...BASE, actionType: 'send_receivable_reminder', actionId: 'a-7', receiptId: 'r-7',
    snapshot: { OUTBOUND_DUNNING: { stage: 'canary', source: 'manual' } }
  });
  assert.equal(result.earnedNow, true);
  assert.equal(result.graduated, false);
  assert.equal(result.graduationReason, 'terminal_not_approved');
  const earnedAudit = audited(client, 'outbound_earned_auto.earned');
  assert.equal(earnedAudit.length, 1, 'the EARNED state is recorded');
  assert.ok(earnedAudit[0].params.some((p) => String(p).includes('"terminal_approved":false')),
    'the audit names the veto');
  assert.equal(configWrites(client).length, 0, 'the config plane is untouched while vetoed');
});

test('veto lifted: graduation goes through the audited stage writer, auto + source earned_auto', async () => {
  const stageCalls = [];
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET })] },
    { match: "state = 'earned'", rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET, state: 'earned' })] },
    { match: "state = 'graduated'", rows: [ladderRow({ state: 'graduated' })] }
  ]);
  const result = await recordCleanApprovedSend(client, {
    ...BASE, actionType: 'send_receivable_reminder', actionId: 'a-7', receiptId: 'r-7',
    snapshot: { OUTBOUND_DUNNING: { stage: 'canary', source: 'manual' } },
    forbiddenFlags: new Set(),
    setStageFn: async (_c, args) => { stageCalls.push(args); return args; }
  });
  assert.equal(result.graduated, true);
  assert.equal(stageCalls.length, 1, 'exactly one stage write');
  assert.equal(stageCalls[0].flagKey, 'OUTBOUND_DUNNING');
  assert.equal(stageCalls[0].stage, 'auto');
  assert.equal(stageCalls[0].source, 'earned_auto');
  assert.match(stageCalls[0].reason, /clean owner-approved/);
  assert.equal(audited(client, 'outbound_earned_auto.graduated').length, 1);
});

test('graduation refuses from a non-acting stage — the ladder never broadens scope', async () => {
  const stageCalls = [];
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET })] },
    { match: "state = 'earned'", rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET, state: 'earned' })] }
  ]);
  const result = await recordCleanApprovedSend(client, {
    ...BASE, actionType: 'send_receivable_reminder',
    snapshot: { OUTBOUND_DUNNING: { stage: 'shadow', source: 'manual' } },
    forbiddenFlags: new Set(),
    setStageFn: async (_c, args) => { stageCalls.push(args); return args; }
  });
  assert.equal(result.graduated, false);
  assert.equal(result.graduationReason, 'stage_not_acting');
  assert.equal(stageCalls.length, 0);
});

test('a stage already at auto (Kari\'s manual terminal) graduates the ladder without a duplicate write', async () => {
  const stageCalls = [];
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET })] },
    { match: "state = 'earned'", rows: [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET, state: 'earned' })] },
    { match: "state = 'graduated'", rows: [ladderRow({ state: 'graduated' })] }
  ]);
  const result = await recordCleanApprovedSend(client, {
    ...BASE, actionType: 'send_receivable_reminder',
    snapshot: { OUTBOUND_DUNNING: { stage: 'auto', source: 'manual' } },
    forbiddenFlags: new Set(),
    setStageFn: async (_c, args) => { stageCalls.push(args); return args; }
  });
  assert.equal(result.graduated, true);
  assert.equal(result.graduationReason, 'stage_already_auto');
  assert.equal(stageCalls.length, 0, 'no duplicate config write');
});

test('a correction resets the streak and is audited with its kind', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ clean_streak: 0, corrections_count: 1 })] }
  ]);
  const result = await recordOutboundCorrection(client, {
    ...BASE, actionType: 'send_receivable_reminder',
    kind: 'declined_held_draft', refType: 'outbound_action', refId: 'a-9',
    actorType: 'owner', actorId: 'email_approval_link'
  });
  assert.equal(result.skipped, false);
  const upsert = client.calls.find((c) => c.sql.includes('insert into outbound_earned_auto'));
  assert.match(upsert.sql, /clean_streak = 0/, 'the upsert resets the streak');
  const auditRows = audited(client, 'outbound_earned_auto.correction_recorded');
  assert.equal(auditRows.length, 1);
  assert.ok(auditRows[0].params.some((p) => String(p).includes('declined_held_draft')));
  assert.equal(configWrites(client).length, 0);
});

test('a correction after a LADDER-MINTED graduation suspends auto back to canary', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ clean_streak: 0, corrections_count: 1, state: 'graduated' })] },
    { match: 'select stage, source from client_capability_config',
      rows: [{ stage: 'auto', source: 'earned_auto' }] }
  ]);
  const result = await recordOutboundCorrection(client, {
    ...BASE, actionType: 'send_receivable_reminder',
    kind: 'reply_if_wrong', actorType: 'owner'
  });
  assert.equal(result.suspended, true);
  const write = configWrites(client);
  assert.equal(write.length, 1, 'one demotion write through the audited writer');
  assert.ok(write[0].params.includes('canary'), 'demoted to canary');
  assert.ok(write[0].params.includes('earned_auto'), 'with earned_auto provenance');
  assert.equal(audited(client, 'outbound_earned_auto.auto_suspended').length, 1);
});

test('a manually-staged auto row is NEVER demoted by a correction', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: [ladderRow({ state: 'graduated' })] },
    { match: 'select stage, source from client_capability_config',
      rows: [{ stage: 'auto', source: 'manual' }] }
  ]);
  const result = await recordOutboundCorrection(client, {
    ...BASE, actionType: 'send_receivable_reminder',
    kind: 'post_send_reversal', actorType: 'owner'
  });
  assert.equal(result.suspended, false);
  assert.equal(configWrites(client).length, 0, 'Kari\'s manual terminal outranks machinery');
  const suspendAudit = audited(client, 'outbound_earned_auto.auto_suspended');
  assert.equal(suspendAudit.length, 1, 'the kept stage is still audited');
  assert.ok(suspendAudit[0].params.some((p) => String(p).includes('"config_demoted":false')));
});

test('recorders are savepoint-guarded: a pre-100 DB skips without poisoning the caller txn', async () => {
  const missing = Object.assign(new Error('relation "outbound_earned_auto" does not exist'), { code: '42P01' });
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', throw: missing }
  ]);
  const clean = await recordCleanApprovedSend(client, { ...BASE, actionType: 'send_receivable_reminder' });
  assert.equal(clean.skipped, true);
  const correction = await recordOutboundCorrection(client, {
    ...BASE, actionType: 'send_receivable_reminder', kind: 'declined_held_draft', actorType: 'owner'
  });
  assert.equal(correction.skipped, true);
  assert.ok(client.calls.some((c) => /rollback to savepoint/i.test(c.sql)),
    'the failed write rolled back to its savepoint, not the whole txn');
});

test('unknown action types are refused by both recorders', async () => {
  const client = makeMockClient();
  assert.equal((await recordCleanApprovedSend(client, { ...BASE, actionType: 'send_marketing_blast' })).skipped, true);
  assert.equal((await recordOutboundCorrection(client, { ...BASE, actionType: 'nope', kind: 'reply_if_wrong' })).skipped, true);
});

test('the tuning writer validates N and audits it (config-plane value, never an env pair)', async () => {
  const client = makeMockClient([
    { match: 'insert into outbound_earned_auto', rows: ({ params }) => [ladderRow({ id: params[0], clean_target: params[4] })] }
  ]);
  await assert.rejects(
    () => setEarnedAutoCleanTarget(client, { ...BASE, actionType: 'send_receivable_reminder', target: 0 }),
    /integer >= 1/
  );
  await assert.rejects(
    () => setEarnedAutoCleanTarget(client, { ...BASE, actionType: 'not_a_type', target: 5 }),
    /unknown action_type/
  );
  const row = await setEarnedAutoCleanTarget(client, {
    ...BASE, actionType: 'send_receivable_reminder', target: 5,
    actorType: 'owner', reason: 'tighter ramp for this client'
  });
  assert.equal(row.clean_target, 5);
  assert.equal(audited(client, 'outbound_earned_auto.target_set').length, 1);
});

test('the sweep graduates earned rows the moment the veto lifts', async () => {
  const stageCalls = [];
  // NB: the graduated UPDATE's WHERE also says state = 'earned', so the
  // handler dispatches on select-vs-update itself.
  const client = makeMockClient([
    { match: "state = 'earned'", rows: ({ sql }) => (sql.startsWith('select')
      ? [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET, state: 'earned' })]
      : [ladderRow({ state: 'graduated' })]) },
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_DUNNING', stage: 'canary', source: 'manual', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] }
  ]);
  const result = await sweepEarnedAutoGraduations(client, {
    ...BASE, forbiddenFlags: new Set(),
    setStageFn: async (_c, args) => { stageCalls.push(args); return args; }
  });
  assert.equal(result.graduated, 1);
  assert.equal(stageCalls.length, 1);
  assert.equal(stageCalls[0].stage, 'auto');
});

test('the sweep with the REAL veto set leaves earned rows resting on Kari', async () => {
  const client = makeMockClient([
    { match: "state = 'earned'", rows: ({ sql }) => (sql.startsWith('select')
      ? [ladderRow({ clean_streak: DEFAULT_CLEAN_SEND_TARGET, state: 'earned' })] : []) },
    { match: 'from client_capability_config', rows: [
      { flag_key: 'OUTBOUND_DUNNING', stage: 'canary', source: 'manual', client_id: CLIENT }
    ] },
    { match: 'from cohort_capability_config', rows: [] }
  ]);
  const result = await sweepEarnedAutoGraduations(client, BASE);
  assert.equal(result.graduated, 0);
  assert.equal(result.earned_pending, 1);
  assert.equal(configWrites(client).length, 0);
});

test('gatherEarnedAutoStates soft-fails to empty pre-100', async () => {
  const missing = Object.assign(new Error('no relation'), { code: '42P01' });
  const client = makeMockClient([{ match: 'from outbound_earned_auto', throw: missing }]);
  assert.deepEqual(await gatherEarnedAutoStates(client, BASE), []);
});
