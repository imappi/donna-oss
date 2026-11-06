import assert from 'node:assert/strict';
import test from 'node:test';

import { submitWaitlist } from './waitlist.js';

for (const reason of ['jurisdiction', 'switcher']) {
  test(`submitWaitlist sends the ${reason} reason unchanged`, async (t) => {
    let payload;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true }) };
    });
    await submitWaitlist({ email: 'owner@example.com', reason });
    assert.equal(payload.reason, reason);
  });
}
