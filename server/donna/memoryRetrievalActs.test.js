// Donna — BizOS Slice 2c-iii (sub-PR 3): the ACTING dual + the §M `auto` guard.
// Proves the acting flag is born dark, that only `canary` acts for
// MEMORY_RETRIEVAL_V2 (never `auto` yet), and that no guarded config writer can
// persist an `auto` row for the flag (invariant test 15).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  memoryRetrievalV2Acts,
  memoryRetrievalV2Observes,
  MEMORY_RETRIEVAL_V2_FLAG_KEY
} from './memoryRetrieval.js';
import {
  AUTO_FORBIDDEN_FLAGS,
  assertStageAllowedForFlag,
  setClientFlagStage,
  setCohortFlagStage
} from './clientConfig.js';

const rowAt = (stage) => ({ [MEMORY_RETRIEVAL_V2_FLAG_KEY]: { stage, source: 'manual' } });
const cleanEnv = {};

const makeClient = () => {
  const queries = [];
  return { queries, query: async (text, params) => { queries.push({ text, params }); return { rows: [] }; } };
};

// ── acting dual: born dark ────────────────────────────────────────────────────

test('memoryRetrievalV2Acts: off by default (no snapshot, envFallback () => false)', () => {
  assert.equal(memoryRetrievalV2Acts({ env: cleanEnv }), false);
  assert.equal(memoryRetrievalV2Acts({ snapshot: {}, env: cleanEnv }), false);
});

test('memoryRetrievalV2Acts: off/dry_run/shadow do NOT act (only canary acts)', () => {
  for (const stage of ['off', 'dry_run', 'shadow']) {
    assert.equal(memoryRetrievalV2Acts({ snapshot: rowAt(stage), env: cleanEnv }), false, `${stage} must not act`);
  }
  assert.equal(memoryRetrievalV2Acts({ snapshot: rowAt('canary'), env: cleanEnv }), true);
});

test('memoryRetrievalV2Acts: `auto` row does NOT act (§M read guard, fail closed)', () => {
  // Even a row that somehow reads `auto` (a direct SQL edit bypassing the writer)
  // must not act until the terminal slice is approved.
  assert.equal(memoryRetrievalV2Acts({ snapshot: rowAt('auto'), env: cleanEnv }), false);
});

test('memoryRetrievalV2Acts: force-disable kills the acting dual', () => {
  assert.equal(
    memoryRetrievalV2Acts({ snapshot: rowAt('canary'), env: { CLIENT_CONFIG_FORCE_DISABLE: 'MEMORY_RETRIEVAL_V2' } }),
    false
  );
});

test('acting dual is SEPARATE from the observe dual (10c): shadow observes but does not act', () => {
  const snap = rowAt('shadow');
  assert.equal(memoryRetrievalV2Observes({ snapshot: snap, env: cleanEnv }), true);
  assert.equal(memoryRetrievalV2Acts({ snapshot: snap, env: cleanEnv }), false);
  // canary both observes and acts
  const canary = rowAt('canary');
  assert.equal(memoryRetrievalV2Observes({ snapshot: canary, env: cleanEnv }), true);
  assert.equal(memoryRetrievalV2Acts({ snapshot: canary, env: cleanEnv }), true);
});

// ── §M write guard ────────────────────────────────────────────────────────────

test('AUTO_FORBIDDEN_FLAGS includes MEMORY_RETRIEVAL_V2 (key match, no drift)', () => {
  assert.ok(AUTO_FORBIDDEN_FLAGS.has(MEMORY_RETRIEVAL_V2_FLAG_KEY));
});

test('assertStageAllowedForFlag: rejects auto for a forbidden flag, allows other stages', () => {
  assert.throws(() => assertStageAllowedForFlag(MEMORY_RETRIEVAL_V2_FLAG_KEY, 'auto'), /may not be staged 'auto'/);
  for (const stage of ['off', 'dry_run', 'shadow', 'canary']) {
    assert.doesNotThrow(() => assertStageAllowedForFlag(MEMORY_RETRIEVAL_V2_FLAG_KEY, stage));
  }
  // a non-forbidden flag may be set auto
  assert.doesNotThrow(() => assertStageAllowedForFlag('SOME_OTHER_FLAG', 'auto'));
});

test('setClientFlagStage: refuses to persist auto for MEMORY_RETRIEVAL_V2 (test 15)', async () => {
  await assert.rejects(
    () => setClientFlagStage(makeClient(), { firmId: 'f1', clientId: 'c1', flagKey: MEMORY_RETRIEVAL_V2_FLAG_KEY, stage: 'auto' }),
    /may not be staged 'auto'/
  );
});

test('setCohortFlagStage: refuses to persist auto for MEMORY_RETRIEVAL_V2', async () => {
  await assert.rejects(
    () => setCohortFlagStage(makeClient(), { firmId: 'f1', cohortKey: 'k', flagKey: MEMORY_RETRIEVAL_V2_FLAG_KEY, stage: 'auto' }),
    /may not be staged 'auto'/
  );
});

test('setClientFlagStage: still allows canary for MEMORY_RETRIEVAL_V2 (the approved terminal for 2c-iii)', async () => {
  const client = makeClient();
  const res = await setClientFlagStage(client, { firmId: 'f1', clientId: 'c1', flagKey: MEMORY_RETRIEVAL_V2_FLAG_KEY, stage: 'canary' });
  assert.equal(res.stage, 'canary');
  // an audit row was written
  assert.ok(client.queries.some((q) => /insert into audit_events/i.test(q.text)));
});
