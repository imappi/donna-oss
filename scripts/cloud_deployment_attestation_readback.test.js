import test from 'node:test';
import assert from 'node:assert/strict';
import { readBackDelays, READ_BACK_DELAYS_MS } from './cloud_deployment_attestation_ci.js';

test('an unset read-back knob keeps the bounded ladder; a set knob tunes it', () => {
  assert.deepEqual(readBackDelays({}), READ_BACK_DELAYS_MS);
  assert.deepEqual(readBackDelays({ DONNA_ATTESTATION_READBACK_DELAYS_MS: '' }), READ_BACK_DELAYS_MS);
  assert.deepEqual(readBackDelays({ DONNA_ATTESTATION_READBACK_DELAYS_MS: ' , ' }), READ_BACK_DELAYS_MS);
  assert.deepEqual(readBackDelays({ DONNA_ATTESTATION_READBACK_DELAYS_MS: '10, 0,20' }), [10, 0, 20]);
});
