// Slice 4 — the firm-level autonomy settings writer (updateFirmLoopSettingsInDb).
// Drives the real writer through a mock pg client (dbClient injection → no snapshot
// fetch). Pins:
//   - an authority toggles auto_send_client_asks: merges into metadata.loops WITHOUT
//     clobbering siblings (tier), and audits before/after to audit_events
//   - a non-authority actorType is refused (403) — autonomy is an authority act
//   - a non-boolean value is refused (400)
//   - a missing firm 404s (and writes nothing)

import assert from 'node:assert/strict';
import test from 'node:test';

import { updateFirmLoopSettingsInDb } from './firmDb.js';

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          return { rows: typeof h.rows === 'function' ? h.rows() : (h.rows || []) };
        }
      }
      return { rows: [] };
    }
  };
};

await test('an authority turns auto-send ON — merges into loops, preserves siblings, audits before/after', async () => {
  const client = makeMockClient([
    { match: "->>'auto_send_client_asks'", rows: [{ v: 'false' }] }, // prior = false
    { match: 'update firms', rows: [{ metadata: { loops: { tier: 'canary', auto_send_client_asks: true } } }] },
    { match: 'insert into audit_events', rows: [] }
  ]);

  const result = await updateFirmLoopSettingsInDb({
    firmId: 'firm-1', autoSendClientAsks: true, actorId: 'kari@books.example',
    actorType: 'firm_operator', dbClient: client
  });

  assert.equal(result.firm_id, 'firm-1');
  assert.equal(result.loops.auto_send_client_asks, true);
  assert.equal(result.loops.tier, 'canary', 'the sibling tier survives the merge');

  // The update merges {auto_send_client_asks:true} INTO the loops object.
  const update = client.calls.find((c) => c.sql.toLowerCase().includes('update firms'));
  assert.ok(update.sql.includes("'{loops}'"), 'targets the loops path');
  assert.deepEqual(JSON.parse(update.params[1]), { auto_send_client_asks: true });

  // Audit carries the governance receipt: action + before/after.
  const audit = client.calls.find((c) => c.sql.toLowerCase().includes('insert into audit_events'));
  assert.ok(audit.sql.includes('loops.auto_send.update'), 'audited as loops.auto_send.update');
  assert.equal(audit.params[1], 'firm_operator');
  assert.equal(audit.params[2], 'kari@books.example');
  const auditMeta = JSON.parse(audit.params[3]);
  assert.equal(auditMeta.before, false);
  assert.equal(auditMeta.after, true);
});

await test('a non-authority actor is refused (403) — autonomy is an authority act', async () => {
  const client = makeMockClient([]);
  await assert.rejects(
    updateFirmLoopSettingsInDb({
      firmId: 'firm-1', autoSendClientAsks: true, actorType: 'client', dbClient: client
    }),
    (error) => error.statusCode === 403 && error.code === 'FIRM_LOOP_SETTING_FORBIDDEN'
  );
  assert.ok(!client.calls.some((c) => c.sql.toLowerCase().includes('update firms')), 'nothing written');
});

await test('a non-boolean value is refused (400)', async () => {
  const client = makeMockClient([]);
  await assert.rejects(
    updateFirmLoopSettingsInDb({ firmId: 'firm-1', autoSendClientAsks: 'yes', dbClient: client }),
    (error) => error.statusCode === 400 && error.code === 'FIRM_LOOP_SETTING_INVALID'
  );
  assert.ok(!client.calls.length, 'no DB work for an invalid value');
});

await test('a missing firm 404s and writes nothing', async () => {
  const client = makeMockClient([
    { match: "->>'auto_send_client_asks'", rows: [] } // firm not found
  ]);
  await assert.rejects(
    updateFirmLoopSettingsInDb({ firmId: 'nope', autoSendClientAsks: true, dbClient: client }),
    (error) => error.statusCode === 404
  );
  assert.ok(!client.calls.some((c) => c.sql.toLowerCase().includes('update firms')), 'nothing written');
  assert.ok(client.calls.some((c) => c.sql.toLowerCase() === 'rollback'), 'rolled back');
});
