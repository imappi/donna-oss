import assert from 'node:assert/strict';
import test from 'node:test';

import { qualificationDecision } from './qualificationGate.js';

const base = { businessEligible: true, bandId: 'starter', jurisdiction: 'FI', switching: 'no' };

test('qualification gate accepts Finland', () => {
  assert.equal(qualificationDecision(base).eligible, true);
});

test('qualification gate accepts Great Britain', () => {
  assert.equal(qualificationDecision({ ...base, jurisdiction: 'GB' }).eligible, true);
});

test('qualification gate sends every unsupported country to the jurisdiction waitlist', () => {
  for (const jurisdiction of ['US', 'SG', 'DE', 'other']) {
    assert.deepEqual(qualificationDecision({ ...base, jurisdiction }), {
      eligible: false,
      unfit: true,
      disqualifyReason: 'jurisdiction'
    });
  }
});

test('qualification gate waits for every answer before enabling the eligible path', () => {
  assert.deepEqual(qualificationDecision({ ...base, jurisdiction: null }), {
    eligible: false,
    unfit: false,
    disqualifyReason: 'other'
  });
});

test('qualification gate sends a mid-year switcher to the switcher waitlist', () => {
  assert.deepEqual(qualificationDecision({ ...base, switching: 'yes' }), {
    eligible: false,
    unfit: true,
    disqualifyReason: 'switcher'
  });
});
