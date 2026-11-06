// Tests for the NextCaseSelector (goal-first uplift, design §6.3 / §13.9).
// Pure / node --test only — no DB, no Inngest, no LLM. The selector's two hard
// contracts (NON-MUTATING + REPLAYABLE) and its eligibility/scoring rules are
// each asserted here; a drift guard pins its status/owner vocabulary to
// caseManager.js's exports (the migrations.test.js anti-drift discipline).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectNextCases,
  scoreCaseComponents,
  NEXT_CASE_SELECTOR_VERSION,
  SELECTOR_TERMINAL_STATUSES,
  SELECTOR_GOAL_SATISFIED_STATUSES,
  WAITING_ON_OTHERS_OWNERS,
  DEFAULT_SELECTOR_WEIGHTS,
  DEFAULT_SELECTOR_HORIZONS
} from './nextCaseSelector.js';
import { LOOP_TERMINAL_STATUSES, LOOP_OWNER_TYPES } from './caseManager.js';

const ASOF = '2026-06-20T00:00:00.000Z';
const ASOF_MS = Date.parse(ASOF);

// A minimal eligible candidate; spread to override single fields per test.
const candidate = (over = {}) => ({
  id: 'case-x', status: 'open', ownerType: 'system', goalStatus: 'unmet', ...over
});

// ---- contract: anti-drift against caseManager vocabulary ------------------

test('drift guard: terminal statuses mirror caseManager.LOOP_TERMINAL_STATUSES', () => {
  assert.deepEqual(
    [...SELECTOR_TERMINAL_STATUSES].sort(),
    [...LOOP_TERMINAL_STATUSES].sort()
  );
});

test('drift guard: external-wait owners are a subset of caseManager.LOOP_OWNER_TYPES', () => {
  for (const owner of WAITING_ON_OTHERS_OWNERS) {
    assert.ok(LOOP_OWNER_TYPES.includes(owner), `${owner} must be a real owner type`);
  }
});

test('weights sum to 1 (a score is itself in [0,1])', () => {
  const sum = Object.values(DEFAULT_SELECTOR_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum ${sum}`);
});

// ---- contract: replayability ----------------------------------------------

test('replayable: identical inputs -> byte-identical output', () => {
  const cases = [
    candidate({ id: 'a', blockingImpact: 2, dueDate: '2026-06-25T00:00:00Z' }),
    candidate({ id: 'b', materialityMinor: 250000, risk: 'high' }),
    candidate({ id: 'c', newlyActionable: true })
  ];
  const r1 = selectNextCases({ cases, asOf: ASOF });
  const r2 = selectNextCases({ cases, asOf: ASOF });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('replayable: asOf is required — no hidden Date.now()', () => {
  assert.throws(() => selectNextCases({ cases: [candidate()] }), /asOf is required/);
  assert.throws(() => selectNextCases({ cases: [candidate()], asOf: 'not-a-date' }), /asOf is required/);
});

test('replayable: accepts epoch-ms asOf identically to ISO', () => {
  const cases = [candidate({ id: 'a', dueDate: '2026-06-22T00:00:00Z' })];
  const iso = selectNextCases({ cases, asOf: ASOF });
  const ms = selectNextCases({ cases, asOf: ASOF_MS });
  assert.equal(JSON.stringify(iso.ranked), JSON.stringify(ms.ranked));
});

test('receipt stamps version, asOf, weights, horizons (reproducible)', () => {
  const r = selectNextCases({ cases: [candidate()], asOf: ASOF });
  assert.equal(r.version, NEXT_CASE_SELECTOR_VERSION);
  assert.equal(r.asOf, ASOF_MS);
  assert.deepEqual(r.weights, DEFAULT_SELECTOR_WEIGHTS);
  assert.deepEqual(r.horizons, DEFAULT_SELECTOR_HORIZONS);
});

// ---- contract: non-mutating ----------------------------------------------

test('non-mutating: input candidates are not mutated', () => {
  const input = candidate({ id: 'a', blockingImpact: 3 });
  const snapshot = JSON.stringify(input);
  selectNextCases({ cases: [input], asOf: ASOF });
  assert.equal(JSON.stringify(input), snapshot);
});

// ---- eligibility ----------------------------------------------------------

test('terminal-status cases are excluded with reason "terminal"', () => {
  for (const status of SELECTOR_TERMINAL_STATUSES) {
    const r = selectNextCases({ cases: [candidate({ id: status, status })], asOf: ASOF });
    assert.equal(r.ranked.length, 0);
    assert.deepEqual(r.excluded, [{ caseId: status, reason: 'terminal' }]);
  }
});

test('goal met/waived cases are excluded with reason "goal_satisfied"', () => {
  for (const goalStatus of SELECTOR_GOAL_SATISFIED_STATUSES) {
    const r = selectNextCases({ cases: [candidate({ id: goalStatus, goalStatus })], asOf: ASOF });
    assert.deepEqual(r.excluded, [{ caseId: goalStatus, reason: 'goal_satisfied' }]);
  }
});

test('waiting-on-client case is excluded under actionableOnly (default)', () => {
  const r = selectNextCases({
    cases: [candidate({ id: 'a', ownerType: 'client' })], asOf: ASOF
  });
  assert.deepEqual(r.excluded, [{ caseId: 'a', reason: 'waiting_external' }]);
});

test('newly-actionable client case is NOT excluded (the reply just landed)', () => {
  const r = selectNextCases({
    cases: [candidate({ id: 'a', ownerType: 'client', newlyActionable: true })], asOf: ASOF
  });
  assert.equal(r.eligibleCount, 1);
  assert.equal(r.excluded.length, 0);
});

test('actionableOnly:false keeps external-wait cases in the ranking', () => {
  const r = selectNextCases({
    cases: [candidate({ id: 'a', ownerType: 'external_connector' })],
    asOf: ASOF, actionableOnly: false
  });
  assert.equal(r.eligibleCount, 1);
  assert.equal(r.excluded.length, 0);
});

// ---- ordering -------------------------------------------------------------

test('close-blocking case outranks an otherwise-identical non-blocking case', () => {
  const r = selectNextCases({
    cases: [
      candidate({ id: 'plain' }),
      candidate({ id: 'blocks-close', blocksClose: true })
    ],
    asOf: ASOF
  });
  assert.equal(r.ranked[0].caseId, 'blocks-close');
  assert.equal(r.ranked[0].rank, 1);
  assert.equal(r.ranked[1].rank, 2);
});

test('overdue due date outranks a far-future one', () => {
  const r = selectNextCases({
    cases: [
      candidate({ id: 'soon', dueDate: '2026-06-10T00:00:00Z' }),   // overdue vs asOf
      candidate({ id: 'later', dueDate: '2026-08-01T00:00:00Z' })   // > horizon away
    ],
    asOf: ASOF
  });
  assert.equal(r.ranked[0].caseId, 'soon');
});

test('higher materiality outranks lower, all else equal', () => {
  const r = selectNextCases({
    cases: [
      candidate({ id: 'small', materialityMinor: 1000 }),
      candidate({ id: 'big', materialityMinor: 400000 })
    ],
    asOf: ASOF
  });
  assert.equal(r.ranked[0].caseId, 'big');
});

test('ties break deterministically on caseId asc (not input order)', () => {
  const forward = selectNextCases({
    cases: [candidate({ id: 'b' }), candidate({ id: 'a' })], asOf: ASOF
  });
  const reversed = selectNextCases({
    cases: [candidate({ id: 'a' }), candidate({ id: 'b' })], asOf: ASOF
  });
  assert.deepEqual(forward.ranked.map((e) => e.caseId), ['a', 'b']);
  assert.deepEqual(reversed.ranked.map((e) => e.caseId), ['a', 'b']);
});

test('rank is 1-based and contiguous', () => {
  const r = selectNextCases({
    cases: [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' })],
    asOf: ASOF
  });
  assert.deepEqual(r.ranked.map((e) => e.rank), [1, 2, 3]);
});

test('every ranked entry carries an explanation receipt', () => {
  const r = selectNextCases({
    cases: [candidate({ id: 'a', blocksClose: true, blockingImpact: 2, newlyActionable: true })],
    asOf: ASOF
  });
  const e = r.ranked[0];
  assert.match(e.explanation, /^score \d\.\d{3}/);
  assert.match(e.explanation, /blocks monthly close/);
  assert.match(e.explanation, /unblocks 2 downstream/);
});

// ---- component scoring (each factor in isolation) -------------------------

const comps = (over) => scoreCaseComponents(candidate(over), {
  asOfMs: ASOF_MS, horizons: DEFAULT_SELECTOR_HORIZONS
});

test('component scores are all within [0,1]', () => {
  const c = comps({
    blockingImpact: 99, blocksClose: true, dueDate: '2026-01-01T00:00:00Z',
    materialityMinor: 99_999_999, risk: 'critical', newlyActionable: true,
    requiredAuthority: 'system', clientSlaDueAt: '2026-01-01T00:00:00Z',
    dependencyDepth: 0, openedAt: '2020-01-01T00:00:00Z', estimatedCostMinor: 0
  });
  for (const [k, v] of Object.entries(c)) {
    assert.ok(v >= 0 && v <= 1, `${k}=${v} out of [0,1]`);
  }
});

test('blocksClose floors closeBlocking at 0.85 even with zero downstream', () => {
  assert.ok(comps({ blocksClose: true }).closeBlocking >= 0.85);
  assert.equal(comps({}).closeBlocking, 0);
});

test('overdue deadline saturates dueUrgency to 1; far future → 0', () => {
  assert.equal(comps({ dueDate: '2026-05-01T00:00:00Z' }).dueUrgency, 1);
  assert.equal(comps({ dueDate: '2026-09-01T00:00:00Z' }).dueUrgency, 0);
});

test('newlyActionable is a clean 1/0 boolean component', () => {
  assert.equal(comps({ newlyActionable: true }).newlyActionable, 1);
  assert.equal(comps({ newlyActionable: false }).newlyActionable, 0);
});

test('requiredAuthority: system outranks accountant outranks admin', () => {
  const sys = comps({ requiredAuthority: 'system' }).requiredAuthority;
  const acct = comps({ requiredAuthority: 'accountant' }).requiredAuthority;
  const admin = comps({ requiredAuthority: 'admin' }).requiredAuthority;
  assert.ok(sys > acct && acct > admin);
});

test('missing requiredAuthority defaults to system-actionable (1)', () => {
  assert.equal(comps({}).requiredAuthority, 1);
});

test('dependencyDepth: root (0) is fully actionable; deeper decays', () => {
  assert.equal(comps({ dependencyDepth: 0 }).dependencyDepth, 1);
  assert.ok(comps({ dependencyDepth: 3 }).dependencyDepth < comps({ dependencyDepth: 1 }).dependencyDepth);
});

test('numeric risk is accepted and clamped', () => {
  assert.equal(comps({ risk: 0.5 }).risk, 0.5);
  assert.equal(comps({ risk: 5 }).risk, 1);
  assert.equal(comps({ risk: null }).risk, 0);
});

test('unknown estimated cost contributes 0 (never penalizes)', () => {
  assert.equal(comps({}).estimatedCost, 0);
  assert.ok(comps({ estimatedCostMinor: 0 }).estimatedCost > comps({ estimatedCostMinor: 90 }).estimatedCost);
});

// ---- input validation -----------------------------------------------------

test('throws on a case with no id', () => {
  assert.throws(() => selectNextCases({ cases: [{ status: 'open' }], asOf: ASOF }), /needs a non-empty id/);
});

test('throws on duplicate case ids (ambiguous identity)', () => {
  assert.throws(
    () => selectNextCases({ cases: [candidate({ id: 'dup' }), candidate({ id: 'dup' })], asOf: ASOF }),
    /duplicate case id/
  );
});

test('throws when cases is not an array', () => {
  assert.throws(() => selectNextCases({ cases: 'nope', asOf: ASOF }), /must be an array/);
});

test('empty case list yields an empty ranking, not an error', () => {
  const r = selectNextCases({ cases: [], asOf: ASOF });
  assert.deepEqual(r.ranked, []);
  assert.equal(r.candidateCount, 0);
  assert.equal(r.eligibleCount, 0);
});
