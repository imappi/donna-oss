// Tests for updateClientProfileInDb (clients.profile partial-merge writer).
//
// Verifies the shape promised to the client portal:
//   1. Valid patch → jsonb-merge UPDATE + audit_events INSERT + commit.
//   2. Missing client → 404, rollback.
//   3. Non-object profile_patch → 400 with no DB writes.
//   4. Missing client_id → 400.

import assert from 'node:assert/strict';
import test from 'node:test';

const FIRM_ID = 'firm-1';
const CLIENT_ID = 'client-1';

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

await test('updateClientProfileInDb: merges patch + writes audit + commits', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'update clients', rows: [{ id: CLIENT_ID }] }
  ]);
  const result = await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    profilePatch: { dismissed_tiles: { '2026-06': ['payroll'] } },
    actorId: 'kari@books.example',
    dbClient: client
  });
  assert.equal(result.client_id, CLIENT_ID);
  assert.deepEqual(result.keys, ['dismissed_tiles']);

  const begins = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'begin');
  const commits = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'commit');
  const rollbacks = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'rollback');
  assert.equal(begins.length, 1);
  assert.equal(commits.length, 1);
  assert.equal(rollbacks.length, 0);

  const updates = client.calls.filter((c) => c.sql.toLowerCase().includes('update clients'));
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /coalesce\(profile, '\{\}'::jsonb\) \|\| \$3::jsonb/);
  // Patch is JSON-stringified into the SQL params (the third bound parameter).
  assert.equal(updates[0].params[0], FIRM_ID);
  assert.equal(updates[0].params[1], CLIENT_ID);
  const parsedPatch = JSON.parse(updates[0].params[2]);
  assert.deepEqual(parsedPatch, { dismissed_tiles: { '2026-06': ['payroll'] } });

  const audits = client.calls.filter((c) => c.sql.toLowerCase().includes(`'client.profile.update'`));
  assert.equal(audits.length, 1);
  // actor_id is recorded ($3); metadata follows ($4).
  assert.match(audits[0].sql, /actor_type, actor_id/);
  assert.equal(audits[0].params[2], 'kari@books.example');
  const auditMeta = JSON.parse(audits[0].params[3]);
  // previous_values: what each written key held before (none here: the
  // mock client has no stored profile).
  assert.deepEqual(auditMeta, { keys: ['dismissed_tiles'], previous_values: {} });
});

await test('updateClientProfileInDb: server-stamps accounting_system provenance from actorId', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'select jurisdiction, profile from clients', rows: [{ jurisdiction: 'GB', profile: {} }] },
    { match: 'update clients', rows: [{ id: CLIENT_ID }] }
  ]);
  const result = await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    // FE sends only the choice; the server owns set_by/_at.
    profilePatch: { accounting_system: 'xero' },
    actorId: 'kari@books.example',
    dbClient: client
  });

  const updates = client.calls.filter((c) => c.sql.toLowerCase().includes('update clients'));
  const writtenPatch = JSON.parse(updates[0].params[2]);
  assert.equal(writtenPatch.accounting_system, 'xero');
  assert.equal(writtenPatch.accounting_system_set_by, 'kari@books.example');
  assert.match(writtenPatch.accounting_system_set_at, /^\d{4}-\d{2}-\d{2}T/);
  // Provenance keys ride along in the audit metadata + return value.
  assert.ok(result.keys.includes('accounting_system_set_by'));
  assert.ok(result.keys.includes('accounting_system_set_at'));
});

await test('updateClientProfileInDb: writing services_engaged stamps set_by + set_at (Phase 2.4b)', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'update clients', rows: [{ id: CLIENT_ID }] }
  ]);
  const result = await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    // FE sends only the choice; the server owns set_by/_at.
    profilePatch: { services_engaged: ['payroll'] },
    actorId: 'kari@books.example',
    dbClient: client
  });

  const updates = client.calls.filter((c) => c.sql.toLowerCase().includes('update clients'));
  const writtenPatch = JSON.parse(updates[0].params[2]);
  assert.deepEqual(writtenPatch.services_engaged, ['payroll']);
  assert.equal(writtenPatch.services_engaged_set_by, 'kari@books.example');
  assert.match(writtenPatch.services_engaged_set_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(result.keys.includes('services_engaged_set_by'));
  assert.ok(result.keys.includes('services_engaged_set_at'));
});

await test('updateClientProfileInDb: confirming jurisdiction stamps confirmed_by; clearing nulls it', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');

  const confirm = makeMockClient([
    { match: 'select jurisdiction, profile', rows: [{ jurisdiction: 'SG', profile: { jurisdiction: 'sg' } }] },
    { match: 'update clients', rows: [{ id: CLIENT_ID }] }
  ]);
  await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    profilePatch: { jurisdiction: 'sg' },
    actorId: 'kari@books.example',
    dbClient: confirm
  });
  const confirmPatch = JSON.parse(
    confirm.calls.find((c) => c.sql.toLowerCase().includes('update clients')).params[2]
  );
  assert.equal(confirmPatch.jurisdiction, 'sg');
  assert.equal(confirmPatch.jurisdiction_confirmed_by, 'kari@books.example');
  assert.match(confirmPatch.jurisdiction_confirmed_at, /^\d{4}-\d{2}-\d{2}T/);

  const clear = makeMockClient([
    { match: 'select jurisdiction, profile', rows: [{ jurisdiction: 'SG', profile: { jurisdiction: 'sg' } }] },
    { match: 'update clients', rows: [{ id: CLIENT_ID }] }
  ]);
  await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    profilePatch: { jurisdiction: null },
    actorId: 'kari@books.example',
    dbClient: clear
  });
  const clearPatch = JSON.parse(
    clear.calls.find((c) => c.sql.toLowerCase().includes('update clients')).params[2]
  );
  assert.equal(clearPatch.jurisdiction, null);
  assert.equal(clearPatch.jurisdiction_confirmed_by, null);
  assert.equal(clearPatch.jurisdiction_confirmed_at, null);
});

await test('updateClientProfileInDb: missing client row → 404 + rollback', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'update clients', rows: [] }
  ]);
  await assert.rejects(
    () => updateClientProfileInDb({
      firmId: FIRM_ID,
      clientId: 'ghost-client',
      profilePatch: { dismissed_tiles: {} },
      dbClient: client
    }),
    (err) => err.statusCode === 404
  );

  const rollbacks = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'rollback');
  const commits = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'commit');
  assert.equal(rollbacks.length, 1);
  assert.equal(commits.length, 0);
});

await test('updateClientProfileInDb: invalid profile_patch → 400 with no DB writes', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');

  for (const bad of [null, undefined, 'string', 42, [], true]) {
    const client = makeMockClient([]);
    await assert.rejects(
      () => updateClientProfileInDb({
        firmId: FIRM_ID,
        clientId: CLIENT_ID,
        profilePatch: bad,
        dbClient: client
      }),
      (err) => err.statusCode === 400
    );
    assert.equal(client.calls.length, 0);
  }
});

await test('updateClientProfileInDb: missing clientId → 400', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  await assert.rejects(
    () => updateClientProfileInDb({
      firmId: FIRM_ID,
      profilePatch: { dismissed_tiles: {} },
      dbClient: makeMockClient([])
    }),
    (err) => err.statusCode === 400
  );
});

// ── platforms[] is bound (country-pack contract gap 4) ──────────────────────
//
// Until this slice `manifest.platforms` was read by nothing: the only
// reference to it anywhere in server/ was its own validator, and adapter
// selection never consulted the pack. Now the pack is the source of truth for
// which accounting systems a market offers, and choosing one it does not
// refuses here instead of resolving silently to the default (Xero) adapter.

await test('setting an accounting system the market\'s pack does not offer refuses', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'select jurisdiction, profile from clients', rows: [{ jurisdiction: 'gb', profile: {} }] },
    { match: 'update clients', rows: [{ id: CLIENT_ID }] }
  ]);
  // Procountor is a Finnish system; the GB pack declares xero + qbo.
  await assert.rejects(
    () => updateClientProfileInDb({
      firmId: FIRM_ID, clientId: CLIENT_ID,
      profilePatch: { accounting_system: 'procountor' },
      actorId: 'kari@books.example', dbClient: client
    }),
    (error) => error.statusCode === 400 && /not offered for jurisdiction 'gb'/.test(error.message)
  );
  assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes('update clients')).length, 0,
    'the refusal happens before any write');
});

await test('the platform refusal is narrow: declared platforms pass, undecidable markets pass', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const cases = [
    // Declared by the pack.
    { jurisdiction: 'gb', system: 'xero' },
    { jurisdiction: 'fi', system: 'procountor' },
    // The stored 'uk' alias must resolve to the gb pack, not to "no pack".
    { jurisdiction: 'uk', system: 'qbo' },
    // No authored pack ⇒ undecidable ⇒ allow. Never judge a market against
    // another market's list (the taxCodeJurisdiction posture).
    { jurisdiction: 'de', system: 'xero' },
    { jurisdiction: '', system: 'procountor' }
  ];
  for (const { jurisdiction, system } of cases) {
    const client = makeMockClient([
      { match: 'select jurisdiction, profile from clients', rows: [{ jurisdiction, profile: {} }] },
      { match: 'update clients', rows: [{ id: CLIENT_ID }] }
    ]);
    await updateClientProfileInDb({
      firmId: FIRM_ID, clientId: CLIENT_ID,
      profilePatch: { accounting_system: system },
      actorId: 'kari@books.example', dbClient: client
    });
    assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes('update clients')).length, 1,
      `${jurisdiction || '(none)'} + ${system} must be allowed`);
  }
});

await test('a patch that does not set accounting_system is never platform-checked', async () => {
  // A stored combination is not retroactively blocked by an unrelated later
  // patch — the check fires only on a deliberate new choice.
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'update clients', rows: [{ id: CLIENT_ID }] }
  ]);
  await updateClientProfileInDb({
    firmId: FIRM_ID, clientId: CLIENT_ID,
    profilePatch: { dismissed_tiles: { '2026-07': ['vat'] } },
    actorId: 'kari@books.example', dbClient: client
  });
  assert.equal(client.calls.filter((c) => c.sql.includes('select jurisdiction, profile from clients')).length, 0,
    'no jurisdiction lookup when the patch does not touch accounting_system');
});

await test('updateClientProfileInDb: entity_type canonicalizes and mirrors to the column (row 17)', async () => {
  // resolveClientFiscalYearTx and its call sites read the entity_type /
  // incorporation_date COLUMNS (gb/entity.js raw() checks the column first),
  // so the profile write must keep the load-bearing columns in sync — the
  // same discipline as the jurisdiction and companyName mirrors above.
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'select jurisdiction, profile from clients', rows: [{ jurisdiction: 'GB', profile: {} }] },
    { match: 'select jurisdiction, profile from clients', rows: [{ jurisdiction: 'GB', profile: {} }] },
    { match: 'set profile', rows: [{ id: CLIENT_ID }] }
  ]);
  const result = await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    // FE sends the signup label; the schema canonicalizes to gb-*.
    profilePatch: { entity_type: 'Ltd', incorporation_date: '2024-05-01' },
    actorId: 'kari@books.example',
    dbClient: client
  });
  assert.deepEqual(result.keys.sort(), ['entityType', 'entity_type', 'incorporation_date']);

  const profileUpdates = client.calls.filter((c) => c.sql.includes('set profile'));
  assert.equal(profileUpdates.length, 1);
  const writtenPatch = JSON.parse(profileUpdates[0].params[2]);
  assert.equal(writtenPatch.entity_type, 'gb-ltd');
  assert.equal(writtenPatch.entityType, 'gb-ltd');
  assert.equal(writtenPatch.incorporation_date, '2024-05-01');

  const entityMirrors = client.calls.filter((c) => c.sql.includes('set entity_type'));
  assert.equal(entityMirrors.length, 1);
  assert.deepEqual(entityMirrors[0].params, [FIRM_ID, CLIENT_ID, 'gb-ltd']);

  const dateMirrors = client.calls.filter((c) => c.sql.includes('set incorporation_date'));
  assert.equal(dateMirrors.length, 1);
  assert.deepEqual(dateMirrors[0].params, [FIRM_ID, CLIENT_ID, '2024-05-01']);

  const commits = client.calls.filter((c) => c.sql.trim().toLowerCase() === 'commit');
  assert.equal(commits.length, 1);
});

await test('updateClientProfileInDb: entity_type null clears the column too', async () => {
  // A cleared profile key with a stale column would silently win on every
  // reader (raw() checks the column FIRST) — the mirror must clear both.
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'set profile', rows: [{ id: CLIENT_ID }] }
  ]);
  await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    profilePatch: { entity_type: null, incorporation_date: null },
    actorId: 'kari@books.example',
    dbClient: client
  });
  const profileUpdates = client.calls.filter((c) => c.sql.includes('set profile'));
  assert.equal(JSON.parse(profileUpdates[0].params[2]).entityType, null);
  const entityMirrors = client.calls.filter((c) => c.sql.includes('set entity_type'));
  assert.equal(entityMirrors.length, 1);
  assert.deepEqual(entityMirrors[0].params, [FIRM_ID, CLIENT_ID, null]);
  const dateMirrors = client.calls.filter((c) => c.sql.includes('set incorporation_date'));
  assert.equal(dateMirrors.length, 1);
  assert.deepEqual(dateMirrors[0].params, [FIRM_ID, CLIENT_ID, null]);
});

await test('updateClientProfileInDb: an unknown GB entity_type refuses before any write', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'select jurisdiction, profile from clients', rows: [{ jurisdiction: 'GB', profile: {} }] }
  ]);
  await assert.rejects(
    updateClientProfileInDb({
      firmId: FIRM_ID,
      clientId: CLIENT_ID,
      profilePatch: { entity_type: 'gb-charity' },
      actorId: 'kari@books.example',
      dbClient: client
    }),
    (error) => error.statusCode === 400
  );
  assert.equal(client.calls.filter((c) => c.sql.toLowerCase().includes('update clients')).length, 0);
});

await test('updateClientProfileInDb: a patch without entity keys performs no column mirror', async () => {
  const { updateClientProfileInDb } = await import('./firmDb.js');
  const client = makeMockClient([
    { match: 'set profile', rows: [{ id: CLIENT_ID }] }
  ]);
  await updateClientProfileInDb({
    firmId: FIRM_ID,
    clientId: CLIENT_ID,
    profilePatch: { dismissed_tiles: { '2026-08': ['vat'] } },
    actorId: 'kari@books.example',
    dbClient: client
  });
  assert.equal(client.calls.filter((c) => c.sql.includes('set entity_type')).length, 0);
  assert.equal(client.calls.filter((c) => c.sql.includes('set incorporation_date')).length, 0);
});
