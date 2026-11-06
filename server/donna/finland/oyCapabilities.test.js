import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINLAND_OY_FLAG_KEY,
  OY_CAPABILITY_STATES,
  OY_CAPABILITY_STATE_LABELS,
  FINLAND_OY_CAPABILITY_LANES,
  FINLAND_OY_LANE_FLAG_KEYS,
  buildFinlandOyContract,
  readFinlandOyCapabilities,
  oyLaneById,
  oyLaneByFlagKey
} from './oyCapabilities.js';

// A config snapshot as readClientConfigSnapshot returns it: { flagKey: { stage } }.
// stageActs → true only for 'canary' | 'auto'.
const acting = (...flagKeys) => Object.fromEntries(flagKeys.map((k) => [k, { stage: 'auto' }]));
const laneIds = FINLAND_OY_CAPABILITY_LANES.map((l) => l.id);
const laneOf = (contract, id) => contract.lanes.find((l) => l.id === id);

test('the flag registry is the closed per-lane set (born on the config plane, one key per lane)', () => {
  assert.equal(FINLAND_OY_FLAG_KEY, 'FINLAND_OY');
  assert.deepEqual(FINLAND_OY_LANE_FLAG_KEYS, [
    'FINLAND_OY_BOOKKEEPING',
    'FINLAND_OY_OPENING_BALANCES',
    'FINLAND_OY_PAYROLL_IMPORT',
    'FINLAND_OY_FS_DRAFT',
    'FINLAND_OY_FS_PUBLICATION',
    'FINLAND_OY_6B_PACK',
    'FINLAND_OY_6B_SUBMISSION',
    'FINLAND_OY_DIVIDEND',
    'FINLAND_OY_SHAREHOLDER_LOAN'
  ]);
  // The master key is NOT one of the lane keys.
  assert.ok(!FINLAND_OY_LANE_FLAG_KEYS.includes(FINLAND_OY_FLAG_KEY));
  assert.deepEqual(OY_CAPABILITY_STATES, ['supported', 'pilot', 'review_required', 'not_enabled']);
});

test('master OFF ⇒ every lane not_enabled even if lane flags act (kill switch dominates)', () => {
  const contract = buildFinlandOyContract({
    masterActs: false,
    laneActs: Object.fromEntries(laneIds.map((id) => [id, true]))
  });
  assert.equal(contract.master_enabled, false);
  assert.equal(contract.any_lane_enabled, false);
  assert.ok(contract.lanes.every((l) => l.enabled === false && l.state === 'not_enabled'),
    'the master kill switch forces every lane off');
});

test('a lane is live only when master AND its own flag act; others stay not_enabled', () => {
  const contract = buildFinlandOyContract({
    masterActs: true,
    laneActs: { bookkeeping: true, dividend: true }
  });
  assert.equal(contract.master_enabled, true);
  assert.equal(contract.any_lane_enabled, true);
  assert.equal(laneOf(contract, 'bookkeeping').enabled, true);
  assert.equal(laneOf(contract, 'dividend').enabled, true);
  // A lane whose flag did not act stays off — "Oy enabled" never implies it.
  assert.equal(laneOf(contract, 'fs_draft').enabled, false);
  assert.equal(laneOf(contract, 'fs_draft').state, 'not_enabled');
});

test('a live lane renders its POSTURE, not a bare boolean (the visible contract)', () => {
  const contract = buildFinlandOyContract({
    masterActs: true,
    laneActs: Object.fromEntries(laneIds.map((id) => [id, true]))
  });
  // The D-FI13-12 example: bookkeeping supported, 6B pack pilot, dividend review.
  assert.equal(laneOf(contract, 'bookkeeping').state, 'supported');
  assert.equal(laneOf(contract, 'tax_return_6b_pack').state, 'pilot');
  assert.equal(laneOf(contract, 'dividend').state, 'review_required');
  assert.equal(laneOf(contract, 'tax_return_6b_submission').state, 'review_required');
  assert.equal(laneOf(contract, 'shareholder_loan').state, 'review_required');
  // State carries bilingual labels for the FE.
  assert.equal(laneOf(contract, 'dividend').state_label_en, 'review required');
  assert.equal(laneOf(contract, 'dividend').state_label_fi, 'tarkistus vaaditaan');
});

test('a missing laneActs entry reads as off (never a silent implied-on)', () => {
  const contract = buildFinlandOyContract({ masterActs: true, laneActs: {} });
  assert.ok(contract.lanes.every((l) => l.enabled === false));
  assert.equal(contract.any_lane_enabled, false);
});

test('readFinlandOyCapabilities: dark by default ⇒ all lanes not_enabled (no snapshot)', () => {
  const contract = readFinlandOyCapabilities({ snapshot: null, env: {} });
  assert.equal(contract.master_enabled, false);
  assert.ok(contract.lanes.every((l) => l.state === 'not_enabled'));
});

test('readFinlandOyCapabilities: reads flags off the config snapshot via clientFlagActs', () => {
  // Master + only the bookkeeping lane staged auto.
  const snapshot = acting(FINLAND_OY_FLAG_KEY, 'FINLAND_OY_BOOKKEEPING');
  const contract = readFinlandOyCapabilities({ snapshot, env: {} });
  assert.equal(contract.master_enabled, true);
  assert.equal(laneOf(contract, 'bookkeeping').enabled, true);
  assert.equal(laneOf(contract, 'bookkeeping').state, 'supported');
  // Every other lane flag is unstaged ⇒ off.
  assert.equal(laneOf(contract, 'fs_draft').enabled, false);
  assert.equal(contract.lanes.filter((l) => l.enabled).length, 1);
});

test('readFinlandOyCapabilities: a lane staged without the master stays off (kill switch)', () => {
  // Lane flag acts, but the master does not.
  const snapshot = acting('FINLAND_OY_DIVIDEND');
  const contract = readFinlandOyCapabilities({ snapshot, env: {} });
  assert.equal(contract.master_enabled, false);
  assert.equal(laneOf(contract, 'dividend').enabled, false);
});

test('a non-acting stage (shadow/off) does not enable a lane', () => {
  const snapshot = {
    [FINLAND_OY_FLAG_KEY]: { stage: 'auto' },
    FINLAND_OY_BOOKKEEPING: { stage: 'shadow' },
    FINLAND_OY_FS_DRAFT: { stage: 'off' }
  };
  const contract = readFinlandOyCapabilities({ snapshot, env: {} });
  assert.equal(contract.master_enabled, true);
  assert.equal(laneOf(contract, 'bookkeeping').enabled, false, 'shadow does not act');
  assert.equal(laneOf(contract, 'fs_draft').enabled, false, 'off does not act');
});

test('CLIENT_CONFIG_FORCE_DISABLE can kill the master (env kills, never enables)', () => {
  const snapshot = acting(FINLAND_OY_FLAG_KEY, 'FINLAND_OY_BOOKKEEPING');
  const contract = readFinlandOyCapabilities({ snapshot, env: { CLIENT_CONFIG_FORCE_DISABLE: 'FINLAND_OY' } });
  assert.equal(contract.master_enabled, false, 'a force-disable on the master zeroes the whole contract');
  assert.ok(contract.lanes.every((l) => l.enabled === false));
});

test('every lane carries a real flag key, a valid posture, and bilingual labels', () => {
  for (const lane of FINLAND_OY_CAPABILITY_LANES) {
    assert.match(lane.flagKey, /^FINLAND_OY_/, `${lane.id} flag key is namespaced`);
    assert.ok(['supported', 'pilot', 'review_required'].includes(lane.posture), `${lane.id} posture is a live state`);
    assert.ok(lane.label_en && lane.label_fi, `${lane.id} has bilingual labels`);
    assert.ok(OY_CAPABILITY_STATE_LABELS[lane.posture], `${lane.id} posture has a state label`);
  }
  // Lane ids and flag keys are unique.
  assert.equal(new Set(FINLAND_OY_CAPABILITY_LANES.map((l) => l.id)).size, FINLAND_OY_CAPABILITY_LANES.length);
  assert.equal(new Set(FINLAND_OY_LANE_FLAG_KEYS).size, FINLAND_OY_LANE_FLAG_KEYS.length);
});

test('provenance is deterministic and cites the policy source; lookups resolve', () => {
  const contract = buildFinlandOyContract({ masterActs: true, laneActs: {} });
  assert.equal(contract.provenance.deterministic, true);
  assert.match(contract.provenance.policy, /D-FI13-12/);
  assert.equal(oyLaneById('dividend').flagKey, 'FINLAND_OY_DIVIDEND');
  assert.equal(oyLaneByFlagKey('FINLAND_OY_6B_PACK').id, 'tax_return_6b_pack');
  assert.equal(oyLaneById('nope'), null);
  assert.equal(oyLaneByFlagKey('nope'), null);
});

test('build never throws on junk input', () => {
  assert.doesNotThrow(() => buildFinlandOyContract());
  assert.doesNotThrow(() => buildFinlandOyContract({ masterActs: 'yes', laneActs: null }));
  // A non-boolean masterActs is not truthily coerced.
  assert.equal(buildFinlandOyContract({ masterActs: 'yes' }).master_enabled, false);
});
