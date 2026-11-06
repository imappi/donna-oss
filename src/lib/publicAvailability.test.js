import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIC_AVAILABILITY_JURISDICTIONS, PUBLIC_AVAILABILITY_LABEL } from './publicAvailability.js';
import { SUPPORTED_SELF_SERVE_JURISDICTIONS } from './qualificationGate.js';

test('public copy names UK only while remaining deliberately narrower than the FI/GB signup gate', () => {
  assert.deepEqual(PUBLIC_AVAILABILITY_JURISDICTIONS, ['GB']);
  assert.equal(PUBLIC_AVAILABILITY_LABEL, 'the UK');
  for (const jurisdiction of PUBLIC_AVAILABILITY_JURISDICTIONS) assert.ok(SUPPORTED_SELF_SERVE_JURISDICTIONS.has(jurisdiction));
  assert.deepEqual([...SUPPORTED_SELF_SERVE_JURISDICTIONS].sort(), ['FI', 'GB']);
});
