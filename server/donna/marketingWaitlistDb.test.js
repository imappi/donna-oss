import assert from 'node:assert/strict';
import test from 'node:test';

import { addToWaitlist } from './marketingWaitlistDb.js';

for (const reason of ['jurisdiction', 'switcher']) {
  test(`addToWaitlist round-trips the ${reason} reason`, async () => {
    let values;
    await addToWaitlist({
      email: 'Owner@Example.com', reason,
      deps: { randomUUID: () => 'waitlist-id', query: async (_sql, params) => { values = params; } }
    });
    assert.deepEqual(values, ['waitlist-id', 'owner@example.com', reason]);
  });
}
