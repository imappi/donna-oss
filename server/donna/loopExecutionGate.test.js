// Tests for the Loops execution-gate bridge (goal-first uplift, design §10 Step 6).
// Pure / node --test only — no DB, no Inngest, no LLM. Covers the env+metadata ->
// tier resolution, the master switch, firm suspension, and the integrated decision.
// Every case passes an explicit `env` object so the suite never touches process.env.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  globalLoopTier,
  isLoopSystemEnabled,
  resolveFirmTier,
  resolveFirmSuspension,
  resolveFirmAuthorizations,
  decideLoopExecution,
  readFirmExecutionContext,
  legacyFlagEnabled
} from './loopExecutionGate.js';

const LOOP = 'reconciliation_gap_resolution';

// ---- globalLoopTier: the ceiling/default from env -------------------------

test('globalLoopTier: absent env is off (inert by default — prod today)', () => {
  assert.equal(globalLoopTier({}), 'off');
});

test('globalLoopTier: LOOPS_SHADOW truthiness maps to shadow (back-compat)', () => {
  for (const v of ['true', '1', 'on', 'yes', 'ON', ' Yes ']) {
    assert.equal(globalLoopTier({ LOOPS_SHADOW: v }), 'shadow', `LOOPS_SHADOW=${v}`);
  }
  for (const v of ['false', '0', 'off', '', 'nope']) {
    assert.equal(globalLoopTier({ LOOPS_SHADOW: v }), 'off', `LOOPS_SHADOW=${v}`);
  }
});

test('globalLoopTier: an explicit valid LOOPS_TIER is authoritative; invalid is ignored', () => {
  assert.equal(globalLoopTier({ LOOPS_TIER: 'canary' }), 'canary');
  assert.equal(globalLoopTier({ LOOPS_TIER: 'ACTIVE' }), 'active');
  // explicit wins over the legacy master, even to turn it off
  assert.equal(globalLoopTier({ LOOPS_TIER: 'off', LOOPS_SHADOW: 'on' }), 'off');
  assert.equal(globalLoopTier({ LOOPS_TIER: 'active', LOOPS_SHADOW: 'off' }), 'active');
  // invalid LOOPS_TIER falls back to the master, never a silent pass
  assert.equal(globalLoopTier({ LOOPS_TIER: 'bogus', LOOPS_SHADOW: 'on' }), 'shadow');
  assert.equal(globalLoopTier({ LOOPS_TIER: 'bogus' }), 'off');
});

test('isLoopSystemEnabled: true iff the global tier is at least shadow', () => {
  assert.equal(isLoopSystemEnabled({}), false);
  assert.equal(isLoopSystemEnabled({ LOOPS_SHADOW: 'on' }), true);
  assert.equal(isLoopSystemEnabled({ LOOPS_TIER: 'active' }), true);
  assert.equal(isLoopSystemEnabled({ LOOPS_TIER: 'off', LOOPS_SHADOW: 'on' }), false);
});

// ---- resolveFirmTier: per-firm assignment, clamped to the ceiling ---------

test('resolveFirmTier: master off pins every firm off regardless of metadata', () => {
  const env = {}; // ceiling off
  assert.equal(resolveFirmTier({ loopKey: LOOP, firmMetadata: { loops: { tier: 'active' } }, env }), 'off');
});

test('resolveFirmTier: system on defaults a firm with no metadata to shadow (back-compat)', () => {
  const env = { LOOPS_SHADOW: 'on' };
  assert.equal(resolveFirmTier({ loopKey: LOOP, firmMetadata: {}, env }), 'shadow');
  assert.equal(resolveFirmTier({ loopKey: LOOP, firmMetadata: null, env }), 'shadow');
});

test('resolveFirmTier: a firm tier is clamped to the global ceiling', () => {
  // ceiling shadow, firm wants active -> clamped to shadow
  assert.equal(
    resolveFirmTier({ loopKey: LOOP, firmMetadata: { loops: { tier: 'active' } }, env: { LOOPS_SHADOW: 'on' } }),
    'shadow'
  );
  // ceiling active, firm assigned canary -> canary (graduated, both keys present)
  assert.equal(
    resolveFirmTier({ loopKey: LOOP, firmMetadata: { loops: { tier: 'canary' } }, env: { LOOPS_TIER: 'active' } }),
    'canary'
  );
});

test('resolveFirmTier: a per-loop tier overrides the firm-wide tier', () => {
  const env = { LOOPS_TIER: 'active' };
  const firmMetadata = { loops: { tier: 'shadow', [LOOP]: { tier: 'active' } } };
  assert.equal(resolveFirmTier({ loopKey: LOOP, firmMetadata, env }), 'active');
  // a different loop falls back to the firm-wide tier
  assert.equal(resolveFirmTier({ loopKey: 'other_loop', firmMetadata, env }), 'shadow');
});

test('resolveFirmTier: a firm may explicitly opt OUT to off while the system runs', () => {
  const env = { LOOPS_TIER: 'active' };
  assert.equal(resolveFirmTier({ loopKey: LOOP, firmMetadata: { loops: { tier: 'off' } }, env }), 'off');
});

// ---- resolveFirmSuspension: the kill switch from metadata ------------------

test('resolveFirmSuspension: absent -> null; bare true -> minimal record; object -> carried', () => {
  assert.equal(resolveFirmSuspension({ firmMetadata: {} }), null);
  assert.equal(resolveFirmSuspension({ firmMetadata: { loops: {} } }), null);

  const bare = resolveFirmSuspension({ firmMetadata: { loops: { suspended: true } } });
  assert.deepEqual(bare, { scope: 'firm', reason: 'firm_suspended' });

  const rich = resolveFirmSuspension({
    firmMetadata: { loops: { suspended: { reason: 'billing lapsed', authorizedByActorType: 'admin' } } }
  });
  assert.equal(rich.scope, 'firm');
  assert.equal(rich.reason, 'billing lapsed');
  assert.equal(rich.authorizedByActorType, 'admin');
});

// ---- decideLoopExecution: the integrated decision -------------------------

test('decideLoopExecution: system off -> blocked tier_off', () => {
  const d = decideLoopExecution({ loopKey: LOOP, firmMetadata: {}, env: {} });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedReason, 'tier_off');
});

test('decideLoopExecution: shadow allows goal_report_only (today\'s behaviour, named)', () => {
  const d = decideLoopExecution({
    loopKey: LOOP, firmMetadata: {}, requestedAction: 'goal_report_only', env: { LOOPS_SHADOW: 'on' }
  });
  assert.equal(d.allowed, true);
  assert.equal(d.tier, 'shadow');
  assert.equal(d.autonomyLevel, 'shadow');
  assert.equal(d.actionAllowed, true);
});

test('decideLoopExecution: shadow blocks a state-changing action (tier_too_low)', () => {
  const d = decideLoopExecution({
    loopKey: LOOP, firmMetadata: {}, requestedAction: 'workflow_mutation', env: { LOOPS_SHADOW: 'on' }
  });
  assert.equal(d.allowed, true);          // the run itself may execute
  assert.equal(d.actionAllowed, false);   // but not this action at shadow
  assert.equal(d.actionBlockedReason, 'tier_too_low');
});

test('decideLoopExecution: a graduated firm at active runs autonomous', () => {
  const d = decideLoopExecution({
    loopKey: LOOP, firmMetadata: { loops: { [LOOP]: { tier: 'active' } } },
    requestedAction: 'workflow_mutation', env: { LOOPS_TIER: 'active' }
  });
  assert.equal(d.tier, 'active');
  assert.equal(d.autonomyLevel, 'autonomous');
  assert.equal(d.actionAllowed, true);
});

test('decideLoopExecution: a firm suspension is the kill switch — overrides an active tier', () => {
  const d = decideLoopExecution({
    loopKey: LOOP,
    firmMetadata: { loops: { [LOOP]: { tier: 'active' }, suspended: { reason: 'paused', authorizedByActorType: 'firm_operator' } } },
    requestedAction: 'goal_report_only', env: { LOOPS_TIER: 'active' }
  });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedReason, 'firm_suspended');
  assert.equal(d.actionAllowed, false);
  assert.equal(d.actionBlockedReason, 'firm_suspended');
});

test('decideLoopExecution: a case suspension blocks even with no firm suspension', () => {
  const d = decideLoopExecution({
    loopKey: LOOP, firmMetadata: {}, caseSuspension: { reason: 'under review' },
    requestedAction: 'goal_report_only', env: { LOOPS_SHADOW: 'on' }
  });
  assert.equal(d.allowed, false);
  assert.equal(d.blockedReason, 'case_suspended');
});

// ---- resolveFirmAuthorizations + auto-send (the `human_authorized` criterion) ----

test('resolveFirmAuthorizations: absent -> []; friendly flag and explicit array both map', () => {
  assert.deepEqual(resolveFirmAuthorizations({ firmMetadata: {} }), []);
  assert.deepEqual(resolveFirmAuthorizations({ firmMetadata: { loops: {} } }), []);
  // friendly settings toggle
  assert.deepEqual(
    resolveFirmAuthorizations({ firmMetadata: { loops: { auto_send_client_asks: true } } }),
    ['client_visible_message']
  );
  // a flag that's false (or absent) authorizes nothing
  assert.deepEqual(resolveFirmAuthorizations({ firmMetadata: { loops: { auto_send_client_asks: false } } }), []);
  // explicit array passes through
  assert.deepEqual(
    resolveFirmAuthorizations({ firmMetadata: { loops: { authorizations: ['client_visible_message'] } } }),
    ['client_visible_message']
  );
  // union without duplicates when both sources name the same action
  assert.deepEqual(
    resolveFirmAuthorizations({
      firmMetadata: { loops: { auto_send_client_asks: true, authorizations: ['client_visible_message'] } }
    }),
    ['client_visible_message']
  );
});

test('decideLoopExecution: auto_send_client_asks lets a canary firm send (autonomous, authorized)', () => {
  const d = decideLoopExecution({
    loopKey: LOOP,
    firmMetadata: { loops: { tier: 'canary', auto_send_client_asks: true } },
    requestedAction: 'client_visible_message', env: { LOOPS_TIER: 'canary' }
  });
  assert.equal(d.tier, 'canary');
  assert.equal(d.autonomyLevel, 'autonomous');
  assert.equal(d.actionAllowed, true);
  assert.equal(d.humanAuthorized, true);
});

test('decideLoopExecution: the same toggle does NOT auto-send at shadow (tier_too_low)', () => {
  const d = decideLoopExecution({
    loopKey: LOOP,
    firmMetadata: { loops: { auto_send_client_asks: true } }, // firm defaults to shadow
    requestedAction: 'client_visible_message', env: { LOOPS_SHADOW: 'on' }
  });
  assert.equal(d.tier, 'shadow');
  assert.equal(d.actionAllowed, false);
  assert.equal(d.actionBlockedReason, 'tier_too_low');
  assert.equal(d.humanAuthorized, true);
});

test('decideLoopExecution: WITHOUT the toggle a canary firm still cannot auto-send', () => {
  const d = decideLoopExecution({
    loopKey: LOOP,
    firmMetadata: { loops: { tier: 'canary' } }, // no auto_send_client_asks
    requestedAction: 'client_visible_message', env: { LOOPS_TIER: 'canary' }
  });
  assert.equal(d.actionAllowed, false);
  assert.equal(d.actionBlockedReason, 'requires_human_authority');
});

// ---- legacyFlagEnabled: centralized GLOBAL gate read (Step 6) --------------
// Back-compat is the whole point — assert byte-identical to the historical inline
// predicates these readers replaced.

// The exact historical predicates, reproduced here as the oracle.
const legacyDefaultOff = (env, name) => String(env[name] || '').toLowerCase() === 'true';

test('legacyFlagEnabled (default-OFF): byte-identical to String(env.X||"").toLowerCase()===true', () => {
  const cases = [
    {}, { F: 'true' }, { F: 'TRUE' }, { F: 'True' }, { F: 'false' }, { F: '1' },
    { F: '' }, { F: 'yes' }, { F: ' true' }, { F: 'true ' }, { F: undefined }
  ];
  for (const env of cases) {
    assert.equal(
      legacyFlagEnabled('F', { env }),
      legacyDefaultOff(env, 'F'),
      `default-off mismatch for ${JSON.stringify(env)}`
    );
  }
  // the live flags read as OFF unless exactly 'true' (case-insensitive), no trim
  assert.equal(legacyFlagEnabled('DOCUMENT_EXTRACTORS_ENABLED', { env: { DOCUMENT_EXTRACTORS_ENABLED: 'true' } }), true);
  assert.equal(legacyFlagEnabled('DOCUMENT_EXTRACTORS_ENABLED', { env: { DOCUMENT_EXTRACTORS_ENABLED: ' true' } }), false, 'no trim — a leading space is OFF, exactly as before');
  assert.equal(legacyFlagEnabled('DOCUMENT_EXTRACTORS_ENABLED', { env: {} }), false, 'absent -> OFF');
});

test('legacyFlagEnabled has no default-ON shape any more (RT-14): a `defaultOn` option is ignored, unset stays OFF', () => {
  // The shadow-mode idiom (`String(env.X ?? 'true') !== 'false'`) lost its
  // last caller in RT-05 and the branch was deleted in RT-14 — a flag that is
  // ON when unset is exactly what the config-plane rail forbids.
  assert.equal(legacyFlagEnabled('SOME_FLAG', { env: {}, defaultOn: true }), false, 'absent -> OFF, whatever the option says');
  assert.equal(legacyFlagEnabled('SOME_FLAG', { env: { SOME_FLAG: 'true' }, defaultOn: true }), true);
  assert.equal(legacyFlagEnabled('SOME_FLAG', { env: { SOME_FLAG: 'false' } }), false);
});

// ---- readFirmExecutionContext: the thin DB reader -------------------------

test('readFirmExecutionContext: reads firms.metadata; soft-fails to {}', async () => {
  const ok = await readFirmExecutionContext(
    { query: async () => ({ rows: [{ metadata: { loops: { tier: 'canary' } } }] }) }, 'firm-1'
  );
  assert.deepEqual(ok.firmMetadata, { loops: { tier: 'canary' } });

  const missing = await readFirmExecutionContext({ query: async () => ({ rows: [] }) }, 'firm-1');
  assert.deepEqual(missing.firmMetadata, {});

  const threw = await readFirmExecutionContext({ query: async () => { throw new Error('db down'); } }, 'firm-1');
  assert.deepEqual(threw.firmMetadata, {});

  assert.deepEqual((await readFirmExecutionContext(null, 'firm-1')).firmMetadata, {});
  assert.deepEqual((await readFirmExecutionContext({ query: async () => ({}) }, null)).firmMetadata, {});
});
