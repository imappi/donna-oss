// DB-free tests for POST /me/deletion-request: the identity key, the
// server-written message in both languages (what is said and, as important,
// what is never said), the contract shape, and the writer's transaction
// discipline against a scripted client: one request row + one audit row per
// firm in one transaction, nothing else written, a repeat returning the
// original, a lost race returning the winner's row. All names are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { responseSchemaFor, validateAgainst } from './contractSchema.js';
import { mobileRouteState, NOT_IMPLEMENTED } from './mobileApi.js';
import {
  buildDeletionRequestMessage, deletionIdentityKey, DELETION_REQUEST_STATUSES, requestOwnerDeletion
} from './mobileDeletionRequest.js';

const AT = new Date('2026-11-10T14:03:27.000Z');
const schema = responseSchemaFor('/me/deletion-request', 'POST', 200);

test('the endpoint is routed, not a 501', () => {
  assert.equal(mobileRouteState('POST', '/me/deletion-request'), 'implemented');
  assert.ok(!NOT_IMPLEMENTED.some(([verb, pattern]) => verb === 'POST' && pattern.test('/me/deletion-request')));
});

test('one request per owner identity: the provider user id, else the email', () => {
  assert.equal(deletionIdentityKey({ userId: 'user-1', email: 'A@x.example' }), 'user-1');
  assert.equal(deletionIdentityKey({ userId: '', email: ' A@X.example ' }), 'email:a@x.example');
  assert.equal(deletionIdentityKey({}), '');
  assert.deepEqual(DELETION_REQUEST_STATUSES, ['recorded', 'acknowledged', 'completed', 'withdrawn']);
});

test('English message: what was recorded and when, who handles it, the retention rule — and that the firm was NOT told', () => {
  const message = buildDeletionRequestMessage({ language: 'en', requestedAt: AT, firms: ['Fixture Ledger Oy'], businesses: ['Kestrel Print Studio Oy'], finnish: true });
  assert.match(message, /recorded on 10 November 2026 at 14:03 UTC/);
  assert.match(message, /books of Kestrel Print Studio Oy/);
  assert.match(message, /Nothing has been deleted/);
  assert.match(message, /Your accounting firm, Fixture Ledger Oy, handles the request\./);
  assert.match(message, /Donna has not passed your request on to the firm automatically/);
  assert.match(message, /cannot be deleted before that period ends/);
  assert.match(message, /10 years after the financial year ends.*6 years after the end of the year/);
  for (const claim of [/we (have )?(told|notified|informed)/i, /has been (sent|forwarded|passed)/i, /will be (deleted|erased)/i, /confirmation/i]) {
    assert.doesNotMatch(message, claim);
  }
  assert.deepEqual(validateAgainst({ requested_at: AT.toISOString(), message }, schema), []);
});

test('Finnish message uses sinä and says the same things', () => {
  const message = buildDeletionRequestMessage({ language: 'fi', requestedAt: AT, firms: ['Fixture Ledger Oy'], businesses: ['Kestrel Print Studio Oy'], finnish: true });
  assert.match(message, /^Pyyntösi poistaa Donna-tilisi kirjattiin 10\.11\.2026 klo 14\.03 \(UTC\)\./);
  assert.match(message, /yrityksen Kestrel Print Studio Oy kirjanpitoa/);
  assert.match(message, /Mitään ei ole poistettu/);
  assert.match(message, /Pyynnön käsittelee tilitoimistosi Fixture Ledger Oy\./);
  assert.match(message, /Donna ei ole välittänyt pyyntöä tilitoimistolle automaattisesti, joten ota siihen yhteyttä myös itse\./);
  assert.match(message, /ei voi poistaa ennen kuin säilytysaika on päättynyt/);
  assert.match(message, /10 vuotta tilikauden päättymisestä ja tositteet 6 vuotta/);
  assert.doesNotMatch(message, /\b(te|teidän|teille|Teidän)\b/, 'no formal you');
});

test('the KPL periods are stated only for Finnish books; several firms read in the plural', () => {
  const uk = buildDeletionRequestMessage({ language: 'en', requestedAt: AT, firms: ['North Ledger Ltd', 'South Ledger Ltd'], businesses: ['A Ltd', 'B Ltd'], finnish: false });
  assert.doesNotMatch(uk, /In Finland/);
  assert.match(uk, /Your accounting firms, North Ledger Ltd and South Ledger Ltd, handle the request\./);
  assert.match(uk, /books of A Ltd and B Ltd/);
  assert.match(uk, /cannot be deleted before that period ends/);
  const fi = buildDeletionRequestMessage({ language: 'fi', requestedAt: AT, firms: ['A Oy', 'B Oy'], businesses: ['C Oy', 'D Oy'] });
  assert.match(fi, /Pyynnön käsittelevät tilitoimistosi A Oy ja B Oy\./);
  assert.match(fi, /yritysten C Oy ja D Oy/);
  assert.doesNotMatch(fi, /Suomessa/);
});

// ── The writer against a scripted client ──────────────────────────────────
const owner = {
  identity: { userId: 'user-fixture-owner', email: 'owner@fixture.example' },
  owners: [
    { firmId: 'firm-a', principal: { principalId: 'collab-a', principalType: 'firm_collaborator', role: 'owner' }, clientIds: ['c-a1'] },
    { firmId: 'firm-b', principal: { principalId: 'collab-b', principalType: 'firm_collaborator', role: 'owner' }, clientIds: ['c-b1', 'c-b2'] }
  ]
};
const entities = { 'firm-a': [{ id: 'c-a1', company_name: 'Alder Oy', jurisdiction: 'FI' }],
  'firm-b': [{ id: 'c-b1', company_name: 'Birch Ltd', jurisdiction: 'GB' }, { id: 'c-b2', company_name: 'Cedar Ltd', jurisdiction: null, firm_jurisdiction: 'GB' }] };

const scriptedDb = ({ existing = null, raceWinner = null } = {}) => {
  const calls = [];
  let stored = existing;
  const db = {
    query: async (sql, params = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^select id, status, requested_at, message from owner_deletion_requests/.test(sql)) return { rows: stored ? [stored] : [] };
      if (/from firms/.test(sql)) return { rows: [{ id: 'firm-a', name: 'Alder Books Oy' }, { id: 'firm-b', name: 'Birch Accounts Ltd' }] };
      if (/insert into owner_deletion_requests/.test(sql)) {
        if (raceWinner) { stored = raceWinner; return { rows: [] }; }
        stored = { id: params[0], status: 'recorded', requested_at: params[9], message: params[8] };
        return { rows: [stored] };
      }
      return { rows: [] };
    }
  };
  return { calls, withFirmDbClientFn: (fn) => fn(db) };
};
const deps = (db, language = 'fi') => ({
  withFirmDbClientFn: db.withFirmDbClientFn, now: () => AT,
  readLanguage: async () => language, readEntitiesFn: async ({ firmId }) => entities[firmId]
});
const writes = (calls) => calls.filter((call) => /^(insert|update|delete)\b/i.test(call.sql));

test('first request: one row and one audit row per firm, in one transaction, nothing else written', async () => {
  const db = scriptedDb();
  const body = await requestOwnerDeletion({ owner, ...deps(db) });
  assert.deepEqual(validateAgainst(body, schema), []);
  assert.equal(body.requested_at, AT.toISOString());
  assert.match(body.message, /tilitoimistosi Alder Books Oy ja Birch Accounts Ltd/);
  assert.match(body.message, /Suomessa/, 'one covered book is Finnish');
  const sqls = db.calls.map((call) => call.sql.split(' ')[0].toLowerCase());
  assert.equal(sqls.filter((verb) => verb === 'begin').length, 1);
  assert.equal(sqls.at(-1), 'commit');
  const written = writes(db.calls);
  assert.deepEqual(written.map((call) => call.sql.match(/^insert into (\w+)/i)?.[1]), ['owner_deletion_requests', 'audit_events', 'audit_events']);
  const [row, ...audits] = written;
  assert.deepEqual(row.params[1], 'user-fixture-owner');
  assert.deepEqual(row.params[4], ['firm-a', 'firm-b']);
  assert.deepEqual(row.params[5], ['c-a1', 'c-b1', 'c-b2']);
  assert.equal(row.params[6].includes('"firm_name":"Alder Books Oy"'), true);
  assert.equal(row.params[7], 'fi');
  assert.deepEqual(audits.map((call) => [call.params[0], call.params[1]]), [['firm-a', 'collab-a'], ['firm-b', 'collab-b']], 'attributed to the owner principal in each firm');
  assert.equal(JSON.parse(audits[1].params[3]).firm_notified, false);
  assert.deepEqual(JSON.parse(audits[1].params[3]).client_ids, ['c-b1', 'c-b2']);
});

test('a repeat returns the original request and writes nothing', async () => {
  const original = { id: 'odr_x', status: 'recorded', requested_at: new Date('2026-11-01T08:00:00Z'), message: 'The original statement.' };
  const db = scriptedDb({ existing: original });
  const body = await requestOwnerDeletion({ owner, ...deps(db, 'en') });
  assert.deepEqual(body, { requested_at: '2026-11-01T08:00:00.000Z', message: 'The original statement.' });
  assert.deepEqual(writes(db.calls), []);
  assert.ok(!db.calls.some((call) => call.sql === 'begin'));
});

test('a lost race rolls back without an audit row and returns the winner', async () => {
  const winner = { id: 'odr_w', status: 'recorded', requested_at: new Date('2026-11-10T14:03:26Z'), message: 'Winner.' };
  const db = scriptedDb({ raceWinner: winner });
  const body = await requestOwnerDeletion({ owner, ...deps(db) });
  assert.deepEqual(body, { requested_at: '2026-11-10T14:03:26.000Z', message: 'Winner.' });
  assert.ok(!writes(db.calls).some((call) => /audit_events/.test(call.sql)));
  assert.ok(db.calls.some((call) => call.sql === 'rollback'));
});

test('an owner with no identity is refused', async () => {
  await assert.rejects(requestOwnerDeletion({ owner: { identity: {}, owners: owner.owners } }), { statusCode: 401, code: 'AUTH_REQUIRED' });
});
