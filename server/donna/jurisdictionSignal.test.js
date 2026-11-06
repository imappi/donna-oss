// Tests for recordJurisdictionSignalInDb — the never-bump-down +
// ring-buffer + conflict logic that turns a detector inference into a
// clients.profile write.

import assert from 'node:assert/strict';
import test from 'node:test';

const FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';

// Mock dbClient — same shape as clientProfile.test.js. Each call gets
// recorded so we can assert on the exact SQL fragments.
const makeMockClient = (responses = []) => {
  const calls = [];
  const reserved = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return { rows: [], rowCount: 0 };
      }
      const idx = reserved.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [response] = reserved.splice(idx, 1);
        if (response.throw) throw response.throw;
        const rows = response.rows || [];
        const rowCount = response.rowCount != null ? response.rowCount : rows.length;
        return { rows, rowCount };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const findUpdate = (calls) =>
  calls.find((c) => c.sql.toLowerCase().includes('update clients'));

const parsePatch = (calls) => JSON.parse(findUpdate(calls).params[2]);

await test('records first-ever signal: writes detected + confidence + audit', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'select profile from clients', rows: [{ profile: {} }] },
    { match: 'update clients', rowCount: 1 }
  ]);

  const result = await recordJurisdictionSignalInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    signal: {
      source: 'bank_statement',
      jurisdiction: 'sg',
      confidence: 'high',
      evidence: 'DBS Bank Singapore · SGD'
    },
    dbClient: client
  });

  assert.equal(result.jurisdiction_detected, 'sg');
  assert.equal(result.jurisdiction_detected_confidence, 'high');
  assert.equal(result.signals_kept, 1);

  const patch = parsePatch(client.calls);
  assert.equal(patch.jurisdiction_detected, 'sg');
  assert.equal(patch.jurisdiction_detected_confidence, 'high');
  assert.equal(patch.jurisdiction_signals.length, 1);
  assert.equal(patch.jurisdiction_signals[0].jurisdiction, 'sg');
  assert.equal(patch.jurisdiction_signals[0].source, 'bank_statement');

  const audit = client.calls.find((c) => c.sql.toLowerCase().includes(`'jurisdiction.detected'`));
  assert.ok(audit, 'expected an audit row for jurisdiction.detected');
  const meta = JSON.parse(audit.params[2]);
  assert.equal(meta.promoted, true);
});

await test('never bumps down: existing high stays, low signal goes to ring only', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    {
      match: 'select profile from clients',
      rows: [{
        profile: {
          jurisdiction_detected: 'sg',
          jurisdiction_detected_confidence: 'high',
          jurisdiction_signals: [
            { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS', at: '2026-06-01T00:00:00Z' }
          ]
        }
      }]
    },
    { match: 'update clients', rowCount: 1 }
  ]);

  await recordJurisdictionSignalInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    signal: { source: 'bank_statement', jurisdiction: 'us', confidence: 'low', evidence: 'MM/DD' },
    dbClient: client
  });

  const patch = parsePatch(client.calls);
  // Existing 'sg / high' must survive a 'us / low' signal.
  assert.equal(patch.jurisdiction_detected, 'sg');
  assert.equal(patch.jurisdiction_detected_confidence, 'high');
  // The signal still goes into the audit log.
  assert.equal(patch.jurisdiction_signals.length, 2);
  assert.equal(patch.jurisdiction_signals[1].jurisdiction, 'us');
  assert.equal(patch.jurisdiction_signals[1].confidence, 'low');
});

await test('equal confidence updates detected (latest wins at same rank)', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  // A new high signal on a different jurisdiction at the same rank
  // overwrites — the operator confirmation pill is the safety net.
  // (Conflicted state is for when both signals arrive in the SAME
  // parse, not across separate parses.)
  const client = makeMockClient([
    {
      match: 'select profile from clients',
      rows: [{ profile: { jurisdiction_detected: 'sg', jurisdiction_detected_confidence: 'high' } }]
    },
    { match: 'update clients', rowCount: 1 }
  ]);

  await recordJurisdictionSignalInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    signal: { source: 'bank_statement', jurisdiction: 'gb', confidence: 'high', evidence: 'GB IBAN' },
    dbClient: client
  });

  const patch = parsePatch(client.calls);
  assert.equal(patch.jurisdiction_detected, 'gb');
  assert.equal(patch.jurisdiction_detected_confidence, 'high');
});

await test('conflicted: preserves existing detected, flips confidence marker', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    {
      match: 'select profile from clients',
      rows: [{ profile: { jurisdiction_detected: 'sg', jurisdiction_detected_confidence: 'high' } }]
    },
    { match: 'update clients', rowCount: 1 }
  ]);

  await recordJurisdictionSignalInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    signal: { source: 'bank_statement', jurisdiction: null, confidence: 'conflicted', evidence: 'ABN vs EIN' },
    dbClient: client
  });

  const patch = parsePatch(client.calls);
  assert.equal(patch.jurisdiction_detected, 'sg'); // preserved
  assert.equal(patch.jurisdiction_detected_confidence, 'conflicted'); // flipped
});

await test('ring buffer caps at 20 entries', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  const existing = Array.from({ length: 20 }, (_, i) => ({
    source: 'bank_statement',
    jurisdiction: 'sg',
    confidence: 'high',
    evidence: `entry-${i}`,
    at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`
  }));
  const client = makeMockClient([
    {
      match: 'select profile from clients',
      rows: [{ profile: { jurisdiction_signals: existing } }]
    },
    { match: 'update clients', rowCount: 1 }
  ]);

  await recordJurisdictionSignalInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    signal: { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high', evidence: 'newest' },
    dbClient: client
  });

  const patch = parsePatch(client.calls);
  assert.equal(patch.jurisdiction_signals.length, 20);
  assert.equal(patch.jurisdiction_signals[19].evidence, 'newest');
  // First-ever entry got rotated out.
  assert.equal(patch.jurisdiction_signals[0].evidence, 'entry-1');
});

await test('missing client → 404 + rollback', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'select profile from clients', rows: [] }
  ]);

  await assert.rejects(
    () => recordJurisdictionSignalInDb({
      firmId: FIRM_ID,
      clientId: 'ghost',
      signal: { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high' },
      dbClient: client
    }),
    (err) => err.statusCode === 404
  );
  const rollbacks = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'rollback');
  assert.equal(rollbacks.length, 1);
});

await test('input validation: rejects bad signals', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');

  const calls = [
    { signal: null },
    { signal: 'string' },
    { signal: { source: 'bank_statement', confidence: 'high' /* missing jurisdiction */ } },
    { signal: { source: 'bank_statement', jurisdiction: 'sg', confidence: 'made_up' } },
    { signal: { jurisdiction: 'sg', confidence: 'high' /* missing source */ } }
  ];
  for (const c of calls) {
    await assert.rejects(
      () => recordJurisdictionSignalInDb({
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        signal: c.signal,
        dbClient: makeMockClient([])
      }),
      (err) => err.statusCode === 400
    );
  }
});

await test('missing clientId → 400', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  await assert.rejects(
    () => recordJurisdictionSignalInDb({
      firmId: FIRM_ID,
      signal: { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high' },
      dbClient: makeMockClient([])
    }),
    (err) => err.statusCode === 400
  );
});

await test('idempotency: replayed same-document/same-value signal is a no-op', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  // Inngest retried the parse success handler — the most-recent ring
  // entry already carries this document_id + sg/high. The recorder must
  // skip the write entirely (no `update clients`), roll back, and report
  // the unchanged state.
  const client = makeMockClient([
    {
      match: 'select profile from clients',
      rows: [{
        profile: {
          jurisdiction_detected: 'sg',
          jurisdiction_detected_confidence: 'high',
          jurisdiction_signals: [
            { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS · SGD', document_id: 'doc-9', at: '2026-06-01T00:00:00Z' }
          ]
        }
      }]
    },
    { match: 'update clients', rowCount: 1 }
  ]);

  const result = await recordJurisdictionSignalInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    signal: { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS · SGD', document_id: 'doc-9' },
    dbClient: client
  });

  assert.equal(result.skipped, 'duplicate_signal');
  assert.equal(result.jurisdiction_detected, 'sg');
  assert.equal(result.jurisdiction_detected_confidence, 'high');
  assert.equal(result.signals_kept, 1, 'ring buffer untouched');
  assert.ok(!findUpdate(client.calls), 'no update clients on a replayed signal');
  const rollbacks = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'rollback');
  assert.equal(rollbacks.length, 1, 'transaction rolled back');
});

await test('idempotency: a DIFFERENT document with the same value still appends', async () => {
  const { recordJurisdictionSignalInDb } = await import('./firmDb.js');
  // Guard keys on document_id — a fresh statement that happens to imply
  // the same jurisdiction is a genuine new signal, not a replay.
  const client = makeMockClient([
    {
      match: 'select profile from clients',
      rows: [{
        profile: {
          jurisdiction_detected: 'sg',
          jurisdiction_detected_confidence: 'high',
          jurisdiction_signals: [
            { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS · SGD', document_id: 'doc-9', at: '2026-06-01T00:00:00Z' }
          ]
        }
      }]
    },
    { match: 'update clients', rowCount: 1 }
  ]);

  await recordJurisdictionSignalInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    signal: { source: 'bank_statement', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS · SGD', document_id: 'doc-10' },
    dbClient: client
  });

  const patch = parsePatch(client.calls);
  assert.equal(patch.jurisdiction_signals.length, 2, 'new document appended');
  assert.equal(patch.jurisdiction_signals[1].document_id, 'doc-10');
});
