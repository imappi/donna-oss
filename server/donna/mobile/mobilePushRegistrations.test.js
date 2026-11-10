// DB-free tests for phone-app device registrations (migration 170): request
// validation, the transaction shape of both writers (receipt inside the same
// transaction, token never in a receipt or an error), the not-yours rule, the
// access writers' sweep, the router wiring, and the migration's RLS block.
// The PostgreSQL lifecycle lives in mobilePushRegistrationsPgLifecycle.test.js.
// All tokens are synthetic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';

import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { handleMobileApiRequest, MOBILE_API_PATH_PREFIX, mobileRouteState, NOT_IMPLEMENTED } from './mobileApi.js';
import {
  endPushRegistrationsWithoutCurrentAccess, EXPO_PUSH_TOKEN_SHAPE, parseRegistrationBody, pushTokenSha256,
  registerPushDevice, unregisterPushDevice
} from './mobilePushRegistrations.js';

const TOKEN = 'ExponentPushToken[fixtureAAAAAAAAAAAAAAAA]';
const OTHER_TOKEN = 'ExpoPushToken[fixtureBBBBBBBBBBBBBBBB]';
const owner = {
  identity: { userId: 'user-1', email: 'owner@push-fixture.example' },
  owners: [
    { firmId: 'firm-a', principal: { principalType: 'firm_collaborator', principalId: 'collab-a', role: 'owner' }, clientIds: ['client-a'] },
    { firmId: 'firm-b', principal: { principalType: 'firm_collaborator', principalId: 'collab-b', role: 'owner' }, clientIds: ['client-b'] }
  ]
};

// A scripted connection: answers by statement, records every statement.
const fakeDb = ({ assignments = { 'collab-a': true, 'collab-b': true }, existing = [], byRegistration = [] } = {}) => {
  const log = [];
  const db = {
    query: async (raw, params = []) => {
      const sql = raw.replace(/\s+/g, ' ').trim();
      log.push({ sql, params });
      if (/from client_assignments ca where ca\.firm_id/.test(sql)) return { rows: assignments[params[1]] ? [{ id: 'assign' }] : [] };
      if (/from mobile_push_registrations where token_sha256/.test(sql)) return { rows: existing };
      if (/from mobile_push_registrations where registration_id/.test(sql)) return { rows: byRegistration };
      return { rows: [] };
    }
  };
  return { log, deps: { withFirmDbClient: (fn) => fn(db) } };
};
const audits = (log) => log.filter((entry) => entry.sql.startsWith('insert into audit_events'));
const statementsOf = (log) => log.map((entry) => entry.sql.split(' ').slice(0, 3).join(' '));

test('request shape: platform, an Expo token and an optional locale — messages never carry the value', () => {
  assert.deepEqual(parseRegistrationBody({ platform: 'ios', expo_push_token: TOKEN, locale: 'fi' }),
    { platform: 'ios', token: TOKEN, tokenSha256: pushTokenSha256(TOKEN), locale: 'fi' });
  assert.equal(parseRegistrationBody({ platform: 'android', expo_push_token: OTHER_TOKEN }).locale, null);
  assert.equal(parseRegistrationBody({ platform: 'android', expo_push_token: OTHER_TOKEN, locale: null }).locale, null);
  for (const body of [
    {}, null, { platform: 'ios' }, { platform: 'web', expo_push_token: TOKEN }, { platform: 'ios', expo_push_token: 42 },
    { platform: 'ios', expo_push_token: 'ExponentPushToken[]' }, { platform: 'ios', expo_push_token: `${TOKEN}\n` },
    { platform: 'ios', expo_push_token: 'ExponentPushToken[fixture AAAAAAAAAAAAAAA]' },
    { platform: 'ios', expo_push_token: `ExponentPushToken[${'A'.repeat(129)}]` },
    { platform: 'ios', expo_push_token: TOKEN, locale: 'sv' }
  ]) {
    assert.throws(() => parseRegistrationBody(body), (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'REGISTRATION_INVALID');
      assert.ok(!String(error.message).includes('ExponentPushToken['), 'no token in the message');
      return true;
    }, JSON.stringify(body));
  }
  assert.ok(EXPO_PUSH_TOKEN_SHAPE.test(OTHER_TOKEN), 'the newer ExpoPushToken prefix is accepted');
});

test('register: one id, one row and one receipt per owner principal, all inside one transaction', async () => {
  const { log, deps } = fakeDb();
  const result = await registerPushDevice({ owner, body: { platform: 'ios', expo_push_token: TOKEN, locale: 'en' }, deps });
  assert.equal(result.status, 201);
  assert.match(result.body.id, /^mpr_[0-9a-f-]{36}$/);
  assert.deepEqual(validateAgainst(result.body, responseSchemaFor('/notifications/registrations', 'POST', 201)), []);
  const statements = statementsOf(log);
  assert.equal(statements[0], 'begin');
  assert.equal(statements.at(-1), 'commit');
  assert.match(log[1].sql, /pg_advisory_xact_lock/);
  const inserts = log.filter((entry) => entry.sql.startsWith('insert into mobile_push_registrations'));
  assert.deepEqual(inserts.map((entry) => [entry.params[1], entry.params[2], entry.params[3]]),
    [[result.body.id, 'firm-a', 'collab-a'], [result.body.id, 'firm-b', 'collab-b']]);
  const receipts = audits(log);
  assert.deepEqual(receipts.map((entry) => [entry.params[0], entry.params[1], entry.params[2], entry.params[3], entry.params[4]]), [
    ['firm-a', 'firm_collaborator', 'collab-a', 'mobile_push_registration.registered', result.body.id],
    ['firm-b', 'firm_collaborator', 'collab-b', 'mobile_push_registration.registered', result.body.id]
  ]);
  for (const receipt of receipts) {
    const metadata = JSON.parse(receipt.params[5]);
    assert.equal(metadata.token_ref, pushTokenSha256(TOKEN).slice(0, 12));
    assert.ok(!receipt.params.join(' ').includes(TOKEN), 'the receipt never carries the token');
  }
});

test('register again unchanged: the same id and no write; a principal without current access is left out', async () => {
  const existing = [
    { id: 'row-a', registration_id: 'mpr_11111111-1111-4111-8111-111111111111', firm_id: 'firm-a', collaborator_id: 'collab-a', platform: 'ios', locale: 'en' },
    { id: 'row-b', registration_id: 'mpr_11111111-1111-4111-8111-111111111111', firm_id: 'firm-b', collaborator_id: 'collab-b', platform: 'ios', locale: 'en' }
  ];
  const unchanged = fakeDb({ existing });
  const result = await registerPushDevice({ owner, body: { platform: 'ios', expo_push_token: TOKEN, locale: 'en' }, deps: unchanged.deps });
  assert.equal(result.body.id, existing[0].registration_id);
  assert.ok(!unchanged.log.some((entry) => /^(insert|delete|update) /.test(entry.sql)), 'nothing written, nothing receipted');

  // firm-b's assignment is no longer current: its row ends, receipted.
  const lapsed = fakeDb({ existing, assignments: { 'collab-a': true } });
  const again = await registerPushDevice({ owner, body: { platform: 'ios', expo_push_token: TOKEN, locale: 'en' }, deps: lapsed.deps });
  assert.equal(again.body.id, existing[0].registration_id);
  assert.deepEqual(lapsed.log.filter((entry) => entry.sql.startsWith('delete from mobile_push_registrations')).map((entry) => entry.params[0]), ['row-b']);
  const [ended] = audits(lapsed.log);
  assert.equal(ended.params[3], 'mobile_push_registration.ended');
  assert.equal(JSON.parse(ended.params[5]).reason, 'access_not_current');

  const none = fakeDb({ assignments: {} });
  await assert.rejects(registerPushDevice({ owner, body: { platform: 'ios', expo_push_token: TOKEN }, deps: none.deps }),
    { statusCode: 403, code: 'NO_BOOKS' });
  assert.equal(statementsOf(none.log).at(-1), 'rollback');
});

test('a token registered by another owner moves: the old registration ends in its own firm, attributed honestly', async () => {
  const existing = [
    { id: 'row-x', registration_id: 'mpr_22222222-2222-4222-8222-222222222222', firm_id: 'firm-a', collaborator_id: 'collab-someone', platform: 'android', locale: null },
    { id: 'row-y', registration_id: 'mpr_22222222-2222-4222-8222-222222222222', firm_id: 'firm-z', collaborator_id: 'collab-elsewhere', platform: 'android', locale: null }
  ];
  const { log, deps } = fakeDb({ existing });
  const result = await registerPushDevice({ owner, body: { platform: 'ios', expo_push_token: TOKEN }, deps });
  assert.notEqual(result.body.id, existing[0].registration_id);
  const ended = audits(log).filter((entry) => entry.params[3] === 'mobile_push_registration.ended');
  assert.deepEqual(ended.map((entry) => [entry.params[0], entry.params[1], entry.params[2], entry.params[4]]), [
    ['firm-a', 'firm_collaborator', 'collab-a', existing[0].registration_id],
    ['firm-z', 'system', 'mobile_push_registration', existing[0].registration_id]
  ]);
  assert.ok(ended.every((entry) => JSON.parse(entry.params[5]).reason === 'token_moved_to_another_registration'));
});

test('unregister: yours → every row of it goes with a receipt; not yours or malformed → 404 and nothing written', async () => {
  const id = 'mpr_33333333-3333-4333-8333-333333333333';
  const byRegistration = [
    { id: 'row-a', firm_id: 'firm-a', collaborator_id: 'collab-a', platform: 'ios', token_sha256: pushTokenSha256(TOKEN) },
    { id: 'row-b', firm_id: 'firm-b', collaborator_id: 'collab-b', platform: 'ios', token_sha256: pushTokenSha256(TOKEN) }
  ];
  const mine = fakeDb({ byRegistration });
  assert.deepEqual(await unregisterPushDevice({ owner, registrationId: id, deps: mine.deps }), { status: 204 });
  assert.deepEqual(audits(mine.log).map((entry) => [entry.params[0], entry.params[2], entry.params[3]]), [
    ['firm-a', 'collab-a', 'mobile_push_registration.removed'], ['firm-b', 'collab-b', 'mobile_push_registration.removed']
  ]);
  assert.equal(statementsOf(mine.log).at(-1), 'commit');

  const theirs = fakeDb({ byRegistration: [{ ...byRegistration[0], collaborator_id: 'collab-someone' }] });
  await assert.rejects(unregisterPushDevice({ owner, registrationId: id, deps: theirs.deps }), { statusCode: 404, code: 'NOT_FOUND' });
  assert.ok(!theirs.log.some((entry) => /^(insert|delete) /.test(entry.sql)));
  assert.equal(statementsOf(theirs.log).at(-1), 'rollback');

  const untouched = fakeDb();
  for (const bad of ['', 'reg-1', `${id}x`, 'mpr_../../x', null]) {
    await assert.rejects(unregisterPushDevice({ owner, registrationId: bad, deps: untouched.deps }), { statusCode: 404 });
  }
  assert.equal(untouched.log.length, 0, 'a malformed id never reaches the database');
});

test('the access writers\' sweep: presence-guarded, firm-scoped, ids only', async () => {
  const absent = [];
  assert.deepEqual(await endPushRegistrationsWithoutCurrentAccess({ query: async (sql) => { absent.push(sql); return { rows: [{ present: false }] }; } },
    { firmId: 'firm-a' }), []);
  assert.equal(absent.length, 1, 'a pre-170 database is never touched further');
  const seen = [];
  const ended = await endPushRegistrationsWithoutCurrentAccess({
    query: async (sql, params) => {
      seen.push({ sql, params });
      return /to_regclass/.test(sql) ? { rows: [{ present: true }] }
        : { rows: [{ registration_id: 'mpr_x', collaborator_id: 'collab-a', expo_push_token: 'must-not-surface' }] };
    }
  }, { firmId: 'firm-a', exceptClientId: 'client-a' });
  assert.deepEqual(ended, [{ registration_id: 'mpr_x', collaborator_id: 'collab-a' }]);
  assert.deepEqual(seen[1].params, ['firm-a', 'client-a']);
  assert.match(seen[1].sql, /returning r\.registration_id, r\.collaborator_id/);
});

test('router: both operations are implemented, no longer 501, and refuse without a token', async () => {
  assert.equal(mobileRouteState('POST', '/notifications/registrations'), 'implemented');
  assert.equal(mobileRouteState('DELETE', '/notifications/registrations/x1'), 'implemented');
  assert.ok(!NOT_IMPLEMENTED.some(([, pattern]) => pattern.test('/notifications/registrations')));
  for (const [method, path] of [['POST', '/notifications/registrations'], ['DELETE', '/notifications/registrations/x1']]) {
    const req = Readable.from([]);
    req.method = method;
    req.headers = {};
    const res = { statusCode: 0, headers: {}, body: '', writableEnded: false,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(chunk) { this.body = chunk ? String(chunk) : ''; this.writableEnded = true; } };
    await handleMobileApiRequest(req, res, new URL(`http://internal${MOBILE_API_PATH_PREFIX}${path}`), {
      resolveAuth: async () => null, identityProvider: () => null, dispatchFirmRoute: async () => { throw new Error('unreached'); }
    });
    assert.equal(res.statusCode, 401, `${method} ${path}`);
    assert.equal(JSON.parse(res.body).code, 'AUTH_REQUIRED');
  }
});

test('migration 170: FK-tied to the collaborator and firm, token stored once, RLS block as 163/166, static SQL', () => {
  const sql = readFileSync(new URL('../../../db/migrations/170_mobile_push_registrations.sql', import.meta.url), 'utf8');
  assert.match(sql, /collaborator_id\s+text\s+not\s+null\s+references\s+firm_collaborators\(id\)\s+on\s+delete\s+cascade/i);
  assert.match(sql, /firm_id\s+text\s+not\s+null\s+references\s+firms\(id\)\s+on\s+delete\s+cascade/i);
  assert.match(sql, /on\s+mobile_push_registrations\(registration_id,\s*firm_id\)/i);
  assert.match(sql, /on\s+mobile_push_registrations\(firm_id,\s*token_sha256\)/i);
  assert.match(sql, /alter\s+table\s+mobile_push_registrations\s+enable\s+row\s+level\s+security/i);
  for (const role of ['anon', 'authenticated']) {
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+mobile_push_registrations\\s+from\\s+${role}`, 'i'));
  }
  assert.match(sql, /grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+mobile_push_registrations\s+to\s+service_role/i);
  assert.doesNotMatch(sql, /force\s+row\s+level\s+security/i);
  assert.doesNotMatch(sql, /format\(|execute\s/i, 'static SQL only');
});
