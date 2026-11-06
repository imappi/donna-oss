// Unit suite for the Phase 0A config control plane (clientConfig.js). No network, no DB —
// a fake pg client captures queries and returns canned rows. Pins: the stage→acts mapping;
// the force-disable break-glass; the byte-identical env fallback for BOTH semantic variants
// (GATE-whole fail-closed AND NARROW-only no-allowlist⇒true); the snapshot soft-fail +
// client-override-default precedence; and that the writer audits every mutation and refuses
// to enable under emergency_override.
//
// See docs/donna-config-control-plane-phase-0A-impl.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_STAGES,
  stageActs,
  stageObserves,
  forceDisabled,
  clientFlagActs,
  clientFlagObserves,
  readClientConfigSnapshot,
  readFirmFlagResolution,
  setClientFlagStage,
  setCohortFlagStage,
  setClientCohortMembership,
  configSnapshotId,
  persistConfigSnapshot,
  assertStageAllowedForFlag,
  AUTO_FORBIDDEN_FLAGS,
  SHADOW_CEILING_FLAGS
} from './clientConfig.js';

// A fake pg client: records every query, returns `rows` for SELECTs and [] otherwise.
const makeClient = (rows = []) => {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params });
      return { rows: /^\s*select/i.test(text) ? rows : [] };
    }
  };
};

test('the stage guards: AUTO_FORBIDDEN refuses auto; a SHADOW_CEILING flag refuses canary AND auto (INV-S2(b))', () => {
  const [autoForbidden] = [...AUTO_FORBIDDEN_FLAGS];
  assert.throws(() => assertStageAllowedForFlag(autoForbidden, 'auto'));
  assert.doesNotThrow(() => assertStageAllowedForFlag(autoForbidden, 'canary'));

  assert.ok(SHADOW_CEILING_FLAGS.has('SPECIALIST_ROLE_ENFORCE'));
  for (const stage of ['canary', 'auto']) {
    assert.throws(
      () => assertStageAllowedForFlag('SPECIALIST_ROLE_ENFORCE', stage),
      /shadow/, `ceilinged flag must refuse '${stage}'`
    );
  }
  for (const stage of ['off', 'dry_run', 'shadow']) {
    assert.doesNotThrow(() => assertStageAllowedForFlag('SPECIALIST_ROLE_ENFORCE', stage));
  }
  // The writer path enforces it too (no route can stage past the ceiling).
  const client = makeClient();
  assert.rejects(() => setClientFlagStage(client, {
    firmId: 'f', clientId: 'c', flagKey: 'SPECIALIST_ROLE_ENFORCE', stage: 'canary'
  }));
});

test('CONFIG_STAGES is the pinned vocabulary in ramp order', () => {
  assert.deepEqual([...CONFIG_STAGES], ['off', 'dry_run', 'shadow', 'canary', 'auto']);
});

test('stageActs: only canary/auto take the live action; off/dry_run/shadow and unknown do not', () => {
  assert.equal(stageActs('canary'), true);
  assert.equal(stageActs('auto'), true);
  for (const s of ['off', 'dry_run', 'shadow', 'bogus', undefined, null]) {
    assert.equal(stageActs(s), false, `${s} must not act`);
  }
});

test('stageObserves: shadow/canary/auto observe; off/dry_run and unknown do not', () => {
  for (const s of ['shadow', 'canary', 'auto']) {
    assert.equal(stageObserves(s), true, `${s} must observe`);
  }
  for (const s of ['off', 'dry_run', 'bogus', undefined, null]) {
    assert.equal(stageObserves(s), false, `${s} must not observe`);
  }
});

test('forceDisabled: "all" kills everything; a list kills listed flags; empty kills nothing', () => {
  assert.equal(forceDisabled('flag_a', { CLIENT_CONFIG_FORCE_DISABLE: 'all' }), true);
  assert.equal(forceDisabled('flag_a', { CLIENT_CONFIG_FORCE_DISABLE: 'ALL' }), true);
  assert.equal(forceDisabled('flag_a', { CLIENT_CONFIG_FORCE_DISABLE: 'flag_a, flag_b' }), true);
  assert.equal(forceDisabled('flag_c', { CLIENT_CONFIG_FORCE_DISABLE: 'flag_a, flag_b' }), false);
  assert.equal(forceDisabled('flag_a', {}), false);
  assert.equal(forceDisabled('flag_a', { CLIENT_CONFIG_FORCE_DISABLE: '' }), false);
});

test('clientFlagActs: no snapshot row → byte-identical env fallback (BOTH semantic variants)', () => {
  // GATE-whole flag fallback (fail-closed when off)
  assert.equal(
    clientFlagActs({ flagKey: 'twin', envFallback: () => false, env: {} }),
    false
  );
  // GATE-whole flag fallback (on for an allowlisted client)
  assert.equal(
    clientFlagActs({ flagKey: 'twin', envFallback: () => true, env: {} }),
    true
  );
  // NARROW-only flag fallback (no allowlist ⇒ true) — must be preserved, not flipped to ∅
  assert.equal(
    clientFlagActs({ flagKey: 'auto_match', envFallback: () => true, env: {} }),
    true
  );
});

test('clientFlagActs: a DB snapshot row OVERRIDES env and is fail-closed (empty = ∅)', () => {
  // stage acts → true even though env fallback would be false
  assert.equal(
    clientFlagActs({ flagKey: 'twin', snapshot: { twin: { stage: 'canary' } }, envFallback: () => false }),
    true
  );
  // stage off → false even though env fallback (NARROW-only) would be true: DB wins, ∅
  assert.equal(
    clientFlagActs({ flagKey: 'auto_match', snapshot: { auto_match: { stage: 'off' } }, envFallback: () => true }),
    false
  );
  // shadow does not act
  assert.equal(
    clientFlagActs({ flagKey: 'twin', snapshot: { twin: { stage: 'shadow' } }, envFallback: () => true }),
    false
  );
});

test('clientFlagActs: force-disable wins over everything; missing flagKey is false', () => {
  assert.equal(
    clientFlagActs({
      flagKey: 'twin',
      snapshot: { twin: { stage: 'auto' } },
      envFallback: () => true,
      env: { CLIENT_CONFIG_FORCE_DISABLE: 'twin' }
    }),
    false
  );
  assert.equal(clientFlagActs({ envFallback: () => true }), false);
});

test('clientFlagObserves: no snapshot row → byte-identical env fallback', () => {
  // observe-only flag with the "always observe when globally enabled" fallback
  assert.equal(
    clientFlagObserves({ flagKey: 'shadow_rc', envFallback: () => true, env: {} }),
    true
  );
  assert.equal(
    clientFlagObserves({ flagKey: 'shadow_rc', envFallback: () => false, env: {} }),
    false
  );
});

test('clientFlagObserves: a DB row OVERRIDES env — shadow OBSERVES (unlike clientFlagActs)', () => {
  // The whole point of the observe dual: stage `shadow` observes here, but does NOT act.
  assert.equal(
    clientFlagObserves({ flagKey: 'shadow_rc', snapshot: { shadow_rc: { stage: 'shadow' } }, envFallback: () => false }),
    true
  );
  assert.equal(
    clientFlagActs({ flagKey: 'shadow_rc', snapshot: { shadow_rc: { stage: 'shadow' } }, envFallback: () => true }),
    false
  );
  // canary/auto observe too; off/dry_run do not (DB wins, ∅), even when env fallback is true.
  assert.equal(
    clientFlagObserves({ flagKey: 'shadow_rc', snapshot: { shadow_rc: { stage: 'auto' } }, envFallback: () => false }),
    true
  );
  for (const stage of ['off', 'dry_run']) {
    assert.equal(
      clientFlagObserves({ flagKey: 'shadow_rc', snapshot: { shadow_rc: { stage } }, envFallback: () => true }),
      false,
      `${stage} must not observe`
    );
  }
});

test('clientFlagObserves: force-disable wins over everything; missing flagKey is false', () => {
  assert.equal(
    clientFlagObserves({
      flagKey: 'shadow_rc',
      snapshot: { shadow_rc: { stage: 'auto' } },
      envFallback: () => true,
      env: { CLIENT_CONFIG_FORCE_DISABLE: 'shadow_rc' }
    }),
    false
  );
  assert.equal(clientFlagObserves({ envFallback: () => true }), false);
});

test('readClientConfigSnapshot: no client/firmId → {}', async () => {
  assert.deepEqual(await readClientConfigSnapshot(null, { firmId: 'f1', clientId: 'c1' }), {});
  assert.deepEqual(await readClientConfigSnapshot(makeClient(), { clientId: 'c1' }), {});
});

test('readClientConfigSnapshot: soft-fails to {} when the query throws', async () => {
  const throwing = { query: async () => { throw new Error('db down'); } };
  assert.deepEqual(await readClientConfigSnapshot(throwing, { firmId: 'f1', clientId: 'c1' }), {});
});

test('readClientConfigSnapshot: client-specific row overrides the firm-wide default', async () => {
  const client = makeClient([
    { flag_key: 'twin', stage: 'shadow', source: 'default', client_id: null },
    { flag_key: 'twin', stage: 'canary', source: 'manual', client_id: 'c1' },
    { flag_key: 'mint', stage: 'auto', source: 'cohort', client_id: null }
  ]);
  const snap = await readClientConfigSnapshot(client, { firmId: 'f1', clientId: 'c1' });
  assert.deepEqual(snap, {
    twin: { stage: 'canary', source: 'manual' }, // client row beat the firm default
    mint: { stage: 'auto', source: 'cohort' }     // firm default applies (no client row)
  });
  // the SELECT scoped to active rows for the firm + (client OR firm-wide)
  assert.match(client.queries[0].text, /from client_capability_config/i);
  assert.match(client.queries[0].text, /valid_to is null/i);
  assert.deepEqual(client.queries[0].params, ['f1', 'c1']);
});

// ── 0A.3 cohort layer ────────────────────────────────────────────────────────────────
// A read fake that routes the TWO selects readClientConfigSnapshot now issues: the 042
// base query (client_capability_config) and the 043 cohort query (cohort_capability_config
// join). cohortThrows simulates a DB that has 042 but not yet 043.
const makeReadClient = ({ base = [], cohort = [], cohortThrows = false } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params });
      if (/from\s+cohort_capability_config/i.test(text)) {
        if (cohortThrows) throw new Error('relation "cohort_capability_config" does not exist');
        return { rows: cohort };
      }
      if (/from\s+client_capability_config/i.test(text)) return { rows: base };
      return { rows: [] };
    }
  };
};

test('readClientConfigSnapshot: a cohort the client belongs to supplies the stage (inherit via membership)', async () => {
  const client = makeReadClient({ cohort: [{ flag_key: 'twin', stage: 'canary', source: 'cohort' }] });
  const snap = await readClientConfigSnapshot(client, { firmId: 'f1', clientId: 'c1' });
  assert.deepEqual(snap, { twin: { stage: 'canary', source: 'cohort' } });
  // the cohort select scoped to the active membership + active cohort row for this client
  const cohortQ = client.queries.find((q) => /from\s+cohort_capability_config/i.test(q.text));
  assert.ok(cohortQ, 'issued a cohort query');
  assert.match(cohortQ.text, /join\s+client_cohort_members/i);
  assert.deepEqual(cohortQ.params, ['f1', 'c1']);
});

test('readClientConfigSnapshot: precedence client-specific > cohort > firm-default', async () => {
  const client = makeReadClient({
    base: [
      { flag_key: 'twin', stage: 'off', source: 'default', client_id: null },   // firm default
      { flag_key: 'twin', stage: 'auto', source: 'manual', client_id: 'c1' },    // client-specific
      { flag_key: 'mint', stage: 'shadow', source: 'default', client_id: null }  // firm default
    ],
    cohort: [
      { flag_key: 'twin', stage: 'canary', source: 'cohort' }, // beaten by the client-specific row
      { flag_key: 'mint', stage: 'canary', source: 'cohort' }  // beats the firm default
    ]
  });
  const snap = await readClientConfigSnapshot(client, { firmId: 'f1', clientId: 'c1' });
  assert.deepEqual(snap, {
    twin: { stage: 'auto', source: 'manual' },   // most specific wins
    mint: { stage: 'canary', source: 'cohort' }  // cohort over firm default
  });
});

test('readClientConfigSnapshot: among multiple cohorts the MOST CONSERVATIVE stage wins (fail-closed)', async () => {
  const client = makeReadClient({
    cohort: [
      { flag_key: 'twin', stage: 'auto', source: 'cohort' },   // cohort A
      { flag_key: 'twin', stage: 'canary', source: 'cohort' }  // cohort B — canary is lower than auto
    ]
  });
  const snap = await readClientConfigSnapshot(client, { firmId: 'f1', clientId: 'c1' });
  assert.deepEqual(snap, { twin: { stage: 'canary', source: 'cohort' } }, 'a conflict never broadens scope');
});

test('readClientConfigSnapshot: a pre-043 DB (cohort query throws) keeps the 042 rows working', async () => {
  const client = makeReadClient({
    base: [{ flag_key: 'twin', stage: 'canary', source: 'manual', client_id: 'c1' }],
    cohortThrows: true
  });
  const snap = await readClientConfigSnapshot(client, { firmId: 'f1', clientId: 'c1' });
  assert.deepEqual(snap, { twin: { stage: 'canary', source: 'manual' } }, 'cohort layer soft-fails independently');
});

// ── Firm-wide single-flag resolution (the /snapshot bootstrap read) ──────────────────
test('readFirmFlagResolution: no client/firmId/flagKey → empty resolution', async () => {
  assert.deepEqual(
    await readFirmFlagResolution(null, { firmId: 'f1', flagKey: 'FOLD' }),
    { byClient: {}, firmDefault: null }
  );
  assert.deepEqual(
    await readFirmFlagResolution(makeReadClient(), { firmId: 'f1' }),
    { byClient: {}, firmDefault: null }
  );
});

test('readFirmFlagResolution: precedence client-specific > cohort (most conservative) > firm default', async () => {
  const client = makeReadClient({
    base: [
      { stage: 'canary', source: 'default', client_id: null },  // firm default
      { stage: 'off', source: 'manual', client_id: 'c1' }       // explicit per-client off
    ],
    cohort: [
      { stage: 'auto', source: 'cohort', client_id: 'c1' },     // beaten by the client-specific row
      { stage: 'auto', source: 'cohort', client_id: 'c2' },     // cohort A
      { stage: 'shadow', source: 'cohort', client_id: 'c2' }    // cohort B — conservative wins
    ]
  });
  const res = await readFirmFlagResolution(client, { firmId: 'f1', flagKey: 'FOLD' });
  assert.deepEqual(res, {
    byClient: {
      c1: { stage: 'off', source: 'manual' },
      c2: { stage: 'shadow', source: 'cohort' }
    },
    firmDefault: { stage: 'canary', source: 'default' }
  });
  const baseQ = client.queries.find((q) => /from\s+client_capability_config/i.test(q.text));
  assert.deepEqual(baseQ.params, ['f1', 'FOLD'], 'base query is scoped to (firm, flag)');
});

test('readFirmFlagResolution: soft-fails to empty when the queries throw (pre-042 DB)', async () => {
  const throwing = { query: async () => { throw new Error('relation does not exist'); } };
  assert.deepEqual(
    await readFirmFlagResolution(throwing, { firmId: 'f1', flagKey: 'FOLD' }),
    { byClient: {}, firmDefault: null }
  );
});

test('setCohortFlagStage: invalid stage + emergency_override-non-off are rejected', async () => {
  await assert.rejects(
    () => setCohortFlagStage(makeClient(), { firmId: 'f1', cohortKey: 'internal_test_clients', flagKey: 'twin', stage: 'bogus' }),
    /invalid stage/i
  );
  await assert.rejects(
    () => setCohortFlagStage(makeClient(), {
      firmId: 'f1', cohortKey: 'internal_test_clients', flagKey: 'twin', stage: 'auto', source: 'emergency_override'
    }),
    /force-disable/i
  );
});

test('setCohortFlagStage: closes prior → inserts → audits (client_id null, cohort_config.stage_set)', async () => {
  const client = makeClient();
  const res = await setCohortFlagStage(client, {
    firmId: 'f1', cohortKey: 'internal_test_clients', flagKey: 'twin', stage: 'canary',
    reason: 'enroll test cohort', actorType: 'firm_member', actorId: 'm-9'
  });
  assert.ok(res.id);
  assert.equal(res.source, 'cohort', 'defaults to cohort provenance');
  assert.equal(client.queries.length, 3);
  assert.match(client.queries[0].text, /update cohort_capability_config set valid_to = now\(\)/i);
  assert.match(client.queries[1].text, /insert into cohort_capability_config/i);
  const audit = client.queries[2];
  assert.match(audit.text, /insert into audit_events/i);
  assert.match(audit.text, /'cohort_config\.stage_set'/);
  assert.equal(audit.params[0], 'f1');
  assert.equal(audit.params[1], 'firm_member', 'actor_type threaded'); // values($1, null, $2, ...) → params shift
  const meta = JSON.parse(audit.params[3]);
  assert.equal(meta.cohortKey, 'internal_test_clients');
  assert.equal(meta.flagKey, 'twin');
  assert.equal(meta.stage, 'canary');
  assert.equal(meta.configRowId, res.id);
});

test('setClientCohortMembership: active=true closes prior → inserts → audits (3 queries)', async () => {
  const client = makeClient();
  const res = await setClientCohortMembership(client, {
    firmId: 'f1', cohortKey: 'internal_test_clients', clientId: 'c1',
    reason: 'onboard', actorType: 'firm_member', actorId: 'm-9'
  });
  assert.ok(res.id);
  assert.equal(res.active, true);
  assert.equal(client.queries.length, 3);
  assert.match(client.queries[0].text, /update client_cohort_members set valid_to = now\(\)/i);
  assert.match(client.queries[1].text, /insert into client_cohort_members/i);
  assert.match(client.queries[2].text, /'cohort_membership\.set'/);
});

test('setClientCohortMembership: active=false closes the membership without re-inserting (2 queries)', async () => {
  const client = makeClient();
  const res = await setClientCohortMembership(client, {
    firmId: 'f1', cohortKey: 'internal_test_clients', clientId: 'c1', active: false
  });
  assert.equal(res.id, null, 'no new membership row on removal');
  assert.equal(res.active, false);
  assert.equal(client.queries.length, 2, 'close + audit, no insert');
  assert.match(client.queries[0].text, /update client_cohort_members set valid_to = now\(\)/i);
  assert.match(client.queries[1].text, /'cohort_membership\.set'/);
  const meta = JSON.parse(client.queries[1].params[4]);
  assert.equal(meta.active, false);
  assert.equal(meta.membershipRowId, null);
});

test('setClientFlagStage: rejects an invalid stage', async () => {
  await assert.rejects(
    () => setClientFlagStage(makeClient(), { firmId: 'f1', flagKey: 'twin', stage: 'bogus' }),
    /invalid stage/i
  );
});

test('setClientFlagStage: emergency_override may only force-disable (stage=off)', async () => {
  await assert.rejects(
    () => setClientFlagStage(makeClient(), {
      firmId: 'f1', clientId: 'c1', flagKey: 'twin', stage: 'auto', source: 'emergency_override'
    }),
    /force-disable/i
  );
  // off under emergency_override is allowed
  const ok = makeClient();
  const res = await setClientFlagStage(ok, {
    firmId: 'f1', clientId: 'c1', flagKey: 'twin', stage: 'off', source: 'emergency_override'
  });
  assert.equal(res.stage, 'off');
});

test('setClientFlagStage: closes the prior row, inserts the new row, and AUDITS the change', async () => {
  const client = makeClient();
  const res = await setClientFlagStage(client, {
    firmId: 'f1', clientId: 'c1', flagKey: 'twin', stage: 'canary',
    source: 'manual', reason: 'honeybee canary', actorType: 'firm_member', actorId: 'm-9'
  });
  assert.ok(res.id, 'returns the new row id');

  // three statements: close active → insert new → insert audit
  assert.equal(client.queries.length, 3);
  assert.match(client.queries[0].text, /update client_capability_config set valid_to = now\(\)/i);
  assert.match(client.queries[1].text, /insert into client_capability_config/i);

  const audit = client.queries[2];
  assert.match(audit.text, /insert into audit_events/i);
  assert.match(audit.text, /'client_config\.stage_set'/);
  // audit carries the firm/client/actor + a metadata blob with flag + stage
  assert.equal(audit.params[0], 'f1');
  assert.equal(audit.params[1], 'c1');
  assert.equal(audit.params[2], 'firm_member');
  assert.equal(audit.params[3], 'twin');
  const meta = JSON.parse(audit.params[4]);
  assert.equal(meta.flagKey, 'twin');
  assert.equal(meta.stage, 'canary');
  assert.equal(meta.source, 'manual');
  assert.equal(meta.configRowId, res.id);
});

// ── Phase 0B.1 — config snapshot → decision-receipt bridge ────────────────────────────

test('configSnapshotId: deterministic + key-order-independent + ignores extra fields', () => {
  const a = configSnapshotId({
    firmId: 'f1', clientId: 'c1',
    snapshot: { TWIN: { stage: 'canary', source: 'manual' }, AUTO: { stage: 'off', source: 'cohort' } }
  });
  // same content, flags in a different insertion order + an extra payload field → same id
  const b = configSnapshotId({
    firmId: 'f1', clientId: 'c1',
    snapshot: { AUTO: { stage: 'off', source: 'cohort', extra: 1 }, TWIN: { stage: 'canary', source: 'manual' } }
  });
  assert.equal(a, b);
  assert.match(a, /^cfg-[0-9a-f]{64}$/);
});

test('configSnapshotId: empty/absent config is stable (and equal across {} / null / undefined)', () => {
  const empty = configSnapshotId({ firmId: 'f1', clientId: 'c1', snapshot: {} });
  assert.equal(empty, configSnapshotId({ firmId: 'f1', clientId: 'c1', snapshot: null }));
  assert.equal(empty, configSnapshotId({ firmId: 'f1', clientId: 'c1' }));
  assert.match(empty, /^cfg-[0-9a-f]{64}$/);
});

test('configSnapshotId: a stage change OR a different tenant yields a different id', () => {
  const base = configSnapshotId({ firmId: 'f1', clientId: 'c1', snapshot: { AUTO: { stage: 'off', source: 'manual' } } });
  const stageChanged = configSnapshotId({ firmId: 'f1', clientId: 'c1', snapshot: { AUTO: { stage: 'canary', source: 'manual' } } });
  const otherClient = configSnapshotId({ firmId: 'f1', clientId: 'c2', snapshot: { AUTO: { stage: 'off', source: 'manual' } } });
  const otherFirm = configSnapshotId({ firmId: 'f2', clientId: 'c1', snapshot: { AUTO: { stage: 'off', source: 'manual' } } });
  assert.notEqual(base, stageChanged);
  assert.notEqual(base, otherClient);
  assert.notEqual(base, otherFirm);
});

test('persistConfigSnapshot: insert-once (on conflict do nothing) returns the content id', async () => {
  const client = makeClient();
  const snapshot = { AUTO: { stage: 'canary', source: 'manual' } };
  const id = await persistConfigSnapshot(client, { firmId: 'f1', clientId: 'c1', snapshot });
  assert.equal(id, configSnapshotId({ firmId: 'f1', clientId: 'c1', snapshot }));
  assert.equal(client.queries.length, 1);
  const q = client.queries[0];
  assert.match(q.text, /insert into config_snapshots/);
  assert.match(q.text, /on conflict \(id\) do nothing/);
  assert.equal(q.params[0], id);
  assert.equal(q.params[1], 'f1');
  assert.equal(q.params[2], 'c1');
});

test('persistConfigSnapshot: no client/firmId → null (no query); a throwing query soft-fails to null', async () => {
  assert.equal(await persistConfigSnapshot(null, { firmId: 'f1' }), null);
  assert.equal(await persistConfigSnapshot(makeClient(), {}), null);
  const throwing = { query: async () => { throw new Error('no table'); } };
  assert.equal(await persistConfigSnapshot(throwing, { firmId: 'f1', clientId: 'c1', snapshot: {} }), null);
});

// ── DMEM-R1 W2: the posture projection of the one resolver ──────────────────

test('clientFlagPosture: kill / off / shadow / canary / authoritative from the same row + kill switch the shims read; agrees with acts/observes', async () => {
  const { FLAG_POSTURES, clientFlagPosture, postureActs, postureObserves, stageActs, stageObserves, forceDisabled, clientFlagActs, clientFlagObserves } = await import('./clientConfig.js');
  assert.deepEqual([...FLAG_POSTURES], ['kill', 'off', 'shadow', 'canary', 'authoritative']);
  const env = {};
  const row = (stage) => ({ FLAG_X: { stage, source: 'test' } });
  assert.equal(clientFlagPosture({ flagKey: 'FLAG_X', snapshot: null, env }), 'off', 'no row + envFallback false = off');
  assert.equal(clientFlagPosture({ flagKey: 'FLAG_X', snapshot: null, envFallback: () => true, env }), 'canary', 'a legacy env fallback can only ever act as canary');
  for (const stage of ['off', 'dry_run', 'shadow', 'canary', 'auto', 'bogus']) {
    const posture = clientFlagPosture({ flagKey: 'FLAG_X', snapshot: row(stage), env });
    assert.equal(postureActs(posture), stageActs(stage), `${stage}: acts agrees`);
    assert.equal(postureObserves(posture), stageObserves(stage), `${stage}: observes agrees`);
    assert.equal(postureActs(posture), clientFlagActs({ flagKey: 'FLAG_X', snapshot: row(stage), envFallback: () => false, env }));
    assert.equal(postureObserves(posture), clientFlagObserves({ flagKey: 'FLAG_X', snapshot: row(stage), envFallback: () => false, env }));
  }
  assert.equal(clientFlagPosture({ flagKey: 'FLAG_X', snapshot: row('auto'), env }), 'authoritative');
  assert.equal(clientFlagPosture({ flagKey: 'FLAG_X', snapshot: row('bogus'), env }), 'off', 'an unknown stage never broadens');
  const killEnv = { CLIENT_CONFIG_FORCE_DISABLE: 'FLAG_X' };
  assert.ok(forceDisabled('FLAG_X', killEnv));
  assert.equal(clientFlagPosture({ flagKey: 'FLAG_X', snapshot: row('auto'), env: killEnv }), 'kill');
  assert.equal(clientFlagPosture({ flagKey: '', snapshot: row('auto'), env }), 'off');
});

test('MEMORY_MODEL_V2 is AUTO_FORBIDDEN until W6A: the guarded writers refuse an auto row; canary is admitted', async () => {
  const { AUTO_FORBIDDEN_FLAGS, assertStageAllowedForFlag } = await import('./clientConfig.js');
  assert.ok(AUTO_FORBIDDEN_FLAGS.has('MEMORY_MODEL_V2'));
  assert.throws(() => assertStageAllowedForFlag('MEMORY_MODEL_V2', 'auto'), /may not be staged 'auto'/);
  assert.doesNotThrow(() => assertStageAllowedForFlag('MEMORY_MODEL_V2', 'canary'));
  assert.doesNotThrow(() => assertStageAllowedForFlag('MEMORY_MODEL_V2', 'shadow'));
});
