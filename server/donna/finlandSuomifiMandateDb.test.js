// G-3 (FI-15) — the suomifi_mandates store writers (migration 067) against a
// pattern-matching fake pg client (the finlandAlvReturnFilingDb.test.js style):
// audit-as-precondition, the one-active-grant 409, guarded revocation, and the
// status envelope (mandate + dated evaluation).
// node --test server/donna/finlandSuomifiMandateDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __recordSuomifiMandateWithClient,
  __revokeSuomifiMandateWithClient
} from './statutoryRegistry.js';
import { SUOMIFI_MANDATE_SCOPE_TAX } from './finland/suomifiMandate.js';

const fakeClient = ({ duplicate = false, transitionMatches = true } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('insert into suomifi_mandates')) {
        if (duplicate) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        return {
          rows: [{
            id: params[0], firm_id: params[1], client_id: params[2], scope: params[3],
            status: 'active', granted_on: params[4], expires_on: params[5],
            reference: params[6], provenance: JSON.parse(params[7]), recorded_by: params[8]
          }]
        };
      }
      if (sql.includes('update suomifi_mandates')) {
        if (!transitionMatches) return { rows: [] };
        return {
          rows: [{
            id: params[2], firm_id: params[0], client_id: params[1],
            scope: SUOMIFI_MANDATE_SCOPE_TAX, status: 'revoked',
            granted_on: '2026-01-15', revoked_on: '2026-07-10', revoke_reason: params[4]
          }]
        };
      }
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const wroteAudit = (client, action) =>
  client.queries.some((q) => q.sql.includes('insert into audit_events') && q.sql.includes(action));

test('record: mints an active grant with defaulted tax scope + audits in-txn, operator-attributed', async () => {
  const client = fakeClient();
  const row = await __recordSuomifiMandateWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    grantedOn: '2026-01-15',
    reference: 'suomi.fi valtuudet listing 2026-07-10',
    provenance: { checked_by: 'kari@books.example', checked_at: '2026-07-10' },
    actorId: 'kari@books.example'
  });
  assert.equal(row.status, 'active');
  assert.equal(row.scope, SUOMIFI_MANDATE_SCOPE_TAX, 'scope defaults to veroasioiden_hoito');
  assert.equal(row.granted_on, '2026-01-15');
  assert.equal(row.recorded_by, 'kari@books.example');
  assert.ok(wroteAudit(client, 'suomifi_mandate.recorded'), 'audit event rides the same txn');
  const audit = client.queries.find((q) => q.sql.includes('suomifi_mandate.recorded'));
  assert.equal(audit.params[2], 'kari@books.example', 'the acting member is attributed, never system-by-default');
});

test('record: refuses a missing client/granted_on (typed 400) and a second active grant (typed 409)', async () => {
  await assert.rejects(
    __recordSuomifiMandateWithClient({ client: fakeClient(), firmId: 'f', clientId: 'c', grantedOn: 'not-a-date' }),
    (e) => e.statusCode === 400
  );
  await assert.rejects(
    __recordSuomifiMandateWithClient({ client: fakeClient(), firmId: 'f', clientId: '', grantedOn: '2026-01-15' }),
    (e) => e.statusCode === 400
  );
  await assert.rejects(
    __recordSuomifiMandateWithClient({
      client: fakeClient({ duplicate: true }), firmId: 'f', clientId: 'c', grantedOn: '2026-01-15'
    }),
    (e) => e.code === 'SUOMIFI_MANDATE_ALREADY_ACTIVE' && e.statusCode === 409
  );
});

test('revoke: flips only an ACTIVE row (guarded transition) and audits with the reason', async () => {
  const client = fakeClient();
  const row = await __revokeSuomifiMandateWithClient({
    client, firmId: 'firm-1', clientId: 'client-1', mandateId: 'suomifi-mandate-1',
    reason: 'owner_withdrew_in_suomifi', actorId: 'kari@books.example'
  });
  assert.equal(row.status, 'revoked');
  assert.equal(row.revoke_reason, 'owner_withdrew_in_suomifi');
  assert.ok(wroteAudit(client, 'suomifi_mandate.revoked'));

  await assert.rejects(
    __revokeSuomifiMandateWithClient({
      client: fakeClient({ transitionMatches: false }), firmId: 'f', clientId: 'c', mandateId: 'm-1'
    }),
    (e) => e.code === 'SUOMIFI_MANDATE_NOT_ACTIVE' && e.statusCode === 409
  );
});
