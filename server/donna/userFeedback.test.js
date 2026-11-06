import assert from 'node:assert/strict';
import test from 'node:test';

import { recordUserFeedbackInDb } from './userFeedback.js';

const capture = () => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    }
  };
};

test('inserts a trimmed row with allowlisted context and minted id', async () => {
  const db = capture();
  const result = await recordUserFeedbackInDb({
    firmId: 'donna-demo-firm',
    kind: 'bug',
    message: '  The reconcile tab froze.  ',
    context: {
      view: 'queue',
      client_id: 'honeybee-hills-apiary-llc',
      shell: 'desktop',
      viewport: '1512x982',
      user_agent: 'Mozilla/5.0',
      // Not on the allowlist — must be dropped, not stored.
      cookies: 'secret',
      nested: { deep: true }
    },
    submittedBy: 'kari@books.example',
    deps: { query: db.query, randomUUID: () => 'fixed-uuid' }
  });

  assert.deepEqual(result, { ok: true, id: 'fb_fixed-uuid' });
  assert.equal(db.calls.length, 1);
  const [, firmId, kind, message, contextJson, submittedBy] = db.calls[0].params;
  assert.equal(db.calls[0].params[0], 'fb_fixed-uuid');
  assert.equal(firmId, 'donna-demo-firm');
  assert.equal(kind, 'bug');
  assert.equal(message, 'The reconcile tab froze.');
  assert.deepEqual(JSON.parse(contextJson), {
    view: 'queue',
    client_id: 'honeybee-hills-apiary-llc',
    shell: 'desktop',
    viewport: '1512x982',
    user_agent: 'Mozilla/5.0'
  });
  assert.equal(submittedBy, 'kari@books.example');
});

test('unknown kind falls back to note; missing context stores empty object', async () => {
  const db = capture();
  await recordUserFeedbackInDb({
    firmId: 'donna-demo-firm',
    kind: 'complaint',
    message: 'Love the sunset ground.',
    deps: { query: db.query, randomUUID: () => 'u2' }
  });
  const [, , kind, , contextJson, submittedBy] = db.calls[0].params;
  assert.equal(kind, 'note');
  assert.deepEqual(JSON.parse(contextJson), {});
  assert.equal(submittedBy, null);
});

test('empty message refuses with a 400', async () => {
  const db = capture();
  await assert.rejects(
    recordUserFeedbackInDb({
      firmId: 'donna-demo-firm',
      kind: 'note',
      message: '   ',
      deps: { query: db.query }
    }),
    (error) => error.statusCode === 400 && error.code === 'FEEDBACK_MESSAGE_REQUIRED'
  );
  assert.equal(db.calls.length, 0);
});

test('overlong message and context values are capped, not refused', async () => {
  const db = capture();
  await recordUserFeedbackInDb({
    firmId: 'donna-demo-firm',
    kind: 'idea',
    message: 'x'.repeat(9000),
    context: { view: 'y'.repeat(500) },
    deps: { query: db.query, randomUUID: () => 'u3' }
  });
  const [, , , message, contextJson] = db.calls[0].params;
  assert.equal(message.length, 8000);
  assert.equal(JSON.parse(contextJson).view.length, 300);
});
