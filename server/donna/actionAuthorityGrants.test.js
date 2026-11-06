// action_authority_grants (D6, migration 095) — the generalized grant engine.
// Pins the fail-closed guards generalized from 040:
//   - only an ACTIVE, uncorrected, in-window, under-ceiling, currency-matched
//     grant in the SAME domain + action type carries an execution;
//   - runtime mint requires the OWNER (self-service doctrine) — system only on
//     the audited migration path with an originating authority;
//   - learned_from_pattern may only PROPOSE, never activate;
//   - pre-migration deploys soft-fail to "no grant" (never a dead executor).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_GRANT_DOMAINS,
  buildActionAuthorityGrantId,
  grantRowAllowsAutoExecute,
  findActiveActionAuthorityGrant,
  mintActionAuthorityGrant,
  suspendActionGrantAfterCorrection,
  recordActionGrantUse,
  revokeActionAuthorityGrant
} from './actionAuthorityGrants.js';

const NOW = new Date('2026-07-24T12:00:00Z');

const grantRow = (over = {}) => ({
  id: 'g-1', domain: 'outbound', action_type: 'send_receivable_reminder',
  status: 'active', correction_count: 0,
  amount_ceiling: 2000, currency: 'USD',
  valid_from: '2026-07-01T00:00:00Z', expires_at: null, review_after: '2026-10-01T00:00:00Z',
  ...over
});

const query = { domain: 'outbound', actionType: 'send_receivable_reminder', amount: 500, currency: 'USD', asOf: NOW };

test('a covering active grant allows execution; every doubt fails closed', () => {
  assert.equal(grantRowAllowsAutoExecute(grantRow(), query), true);
  assert.equal(grantRowAllowsAutoExecute(null, query), false);
  assert.equal(grantRowAllowsAutoExecute(grantRow({ status: 'proposed' }), query), false);
  assert.equal(grantRowAllowsAutoExecute(grantRow({ status: 'suspended' }), query), false);
  assert.equal(grantRowAllowsAutoExecute(grantRow({ status: 'revoked' }), query), false);
  assert.equal(grantRowAllowsAutoExecute(grantRow({ correction_count: 1 }), query), false, 'corrected grant is unusable');
  assert.equal(grantRowAllowsAutoExecute(grantRow({ amount_ceiling: null }), query), false, 'ceiling required');
  assert.equal(grantRowAllowsAutoExecute(grantRow(), { ...query, amount: 2001 }), false, 'over ceiling');
  assert.equal(grantRowAllowsAutoExecute(grantRow(), { ...query, amount: 0 }), false);
  assert.equal(grantRowAllowsAutoExecute(grantRow({ currency: 'EUR' }), query), false, 'currency mismatch');
  assert.equal(grantRowAllowsAutoExecute(grantRow({ domain: 'reconciliation' }), query), false, 'domain mismatch');
  assert.equal(grantRowAllowsAutoExecute(grantRow({ action_type: 'issue_invoice' }), query), false, 'action mismatch');
  assert.equal(grantRowAllowsAutoExecute(grantRow({ valid_from: '2026-08-01T00:00:00Z' }), query), false, 'not yet valid');
  assert.equal(grantRowAllowsAutoExecute(grantRow({ expires_at: '2026-07-01T00:00:00Z' }), query), false, 'expired');
  assert.equal(grantRowAllowsAutoExecute(grantRow({ review_after: '2026-07-01T00:00:00Z' }), query), false, 'past mandatory review');
});

const makeClient = ({ rows = [], failWith = null } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (failWith) throw failWith;
      const text = String(sql).toLowerCase();
      if (text.includes('select * from action_authority_grants')) return { rows };
      if (text.includes('insert into action_authority_grants')) {
        return { rows: [{ id: params[0], inserted: true, status: params[13] }] };
      }
      if (text.includes('update action_authority_grants')) {
        return { rows: [{ id: params[1], client_id: 'c-1', status: 'suspended', correction_count: 1, use_count: 1 }] };
      }
      return { rows: [] };
    }
  };
};

test('findActiveActionAuthorityGrant returns the covering row; soft-fails pre-migration', async () => {
  const covering = grantRow();
  const client = makeClient({ rows: [grantRow({ id: 'g-0', status: 'suspended' }), covering] });
  const found = await findActiveActionAuthorityGrant(client, {
    firmId: 'f', clientId: 'c', domain: 'outbound',
    actionType: 'send_receivable_reminder', scopeKey: 'p-1',
    amount: 500, currency: 'USD', asOf: NOW
  });
  assert.equal(found?.id, 'g-1');

  const missing = { code: '42P01' };
  const preMigration = makeClient({ failWith: missing });
  const none = await findActiveActionAuthorityGrant(preMigration, {
    firmId: 'f', clientId: 'c', domain: 'outbound',
    actionType: 'send_receivable_reminder', scopeKey: 'p-1',
    amount: 500, currency: 'USD'
  });
  assert.equal(none, null);

  assert.equal(await findActiveActionAuthorityGrant(makeClient(), {
    firmId: 'f', clientId: 'c', domain: 'not_a_domain',
    actionType: 'send_receivable_reminder', scopeKey: 'p-1', amount: 5, currency: 'USD'
  }), null, 'unknown domain fails closed');
});

test('runtime mint requires the OWNER; system only via the audited migration path', async () => {
  const base = {
    firmId: 'f', clientId: 'c', domain: 'outbound',
    actionType: 'send_receivable_reminder', scopeKey: 'p-1',
    amountCeiling: 1000, currency: 'USD', source: 'owner_approval'
  };
  assert.equal(await mintActionAuthorityGrant(makeClient(), {
    ...base, authorizedByActorType: 'system'
  }), null, 'bare system mint refused');
  assert.equal(await mintActionAuthorityGrant(makeClient(), {
    ...base, authorizedByActorType: 'firm_operator'
  }), null, 'no firm-side minting authority in the self-service model');

  const owner = await mintActionAuthorityGrant(makeClient(), {
    ...base, authorizedByActorType: 'owner', authorizedByActorId: 'kari'
  });
  assert.equal(owner?.inserted, true);
  assert.equal(owner?.status, 'active');

  const migrated = await mintActionAuthorityGrant(makeClient(), {
    ...base, source: 'migration', authorizedByActorType: 'system', isMigration: true,
    provenance: { originating_authority: 'owner:kari 2026-07-24' }
  });
  assert.ok(migrated, 'audited migration path allowed');

  assert.equal(await mintActionAuthorityGrant(makeClient(), {
    ...base, source: 'migration', authorizedByActorType: 'system', isMigration: true, provenance: {}
  }), null, 'migration without originating authority refused');
});

test('guards: ceiling required; learned_from_pattern coerces to proposed', async () => {
  const base = {
    firmId: 'f', clientId: 'c', domain: 'outbound',
    actionType: 'send_receivable_reminder', scopeKey: 'p-1',
    currency: 'USD', authorizedByActorType: 'owner', source: 'owner_approval'
  };
  assert.equal(await mintActionAuthorityGrant(makeClient(), { ...base, amountCeiling: 0 }), null);
  assert.equal(await mintActionAuthorityGrant(makeClient(), { ...base, amountCeiling: 100, currency: null }), null);

  const learned = await mintActionAuthorityGrant(makeClient(), {
    ...base, amountCeiling: 100, source: 'learned_from_pattern', status: 'active'
  });
  assert.equal(learned?.status, 'proposed', 'learned pattern may only propose');
});

test('suspend-after-correction bumps the counter and audits; use recording stamps the row', async () => {
  const client = makeClient();
  const suspended = await suspendActionGrantAfterCorrection(client, {
    firmId: 'f', grantId: 'g-1', reason: 'owner_disputed', resourceId: 'action-9'
  });
  assert.equal(suspended?.status, 'suspended');
  assert.equal(suspended?.correction_count, 1);
  assert.ok(client.calls.some((c) => c.sql.includes('action_authority_grant.auto_suspended')));

  const use = await recordActionGrantUse(makeClient(), { firmId: 'f', grantId: 'g-1' });
  assert.ok(use, 'use stamped');

  assert.equal(await suspendActionGrantAfterCorrection(makeClient({ failWith: { code: '42P01' } }), {
    firmId: 'f', grantId: 'g-1'
  }), null, 'pre-migration soft-fail');
});

test('deterministic id: same scope upserts the same row; domains are the closed 095 set', () => {
  const a = buildActionAuthorityGrantId({ firmId: 'f', clientId: 'c', domain: 'outbound', actionType: 'x', scopeKind: 'counterparty', scopeKey: 'p-1' });
  const b = buildActionAuthorityGrantId({ firmId: 'f', clientId: 'c', domain: 'outbound', actionType: 'x', scopeKind: 'counterparty', scopeKey: 'p-1' });
  const c = buildActionAuthorityGrantId({ firmId: 'f', clientId: 'c2', domain: 'outbound', actionType: 'x', scopeKind: 'counterparty', scopeKey: 'p-1' });
  assert.equal(a, b);
  assert.notEqual(a, c, 'client id is part of the key');
  assert.deepEqual([...ACTION_GRANT_DOMAINS], ['outbound', 'reconciliation', 'ledger_sync', 'inventory']);
});

test('revoke: owner-only, favors the first revocation, audits, soft-fails pre-migration', async () => {
  const revokedRow = {
    id: 'g-1', client_id: 'c-1', domain: 'outbound', action_type: 'send_receivable_reminder',
    scope_kind: 'counterparty', scope_key: 'p-1', status: 'revoked',
    provenance: { role_id: 'invoicing_collections' }
  };
  const client = makeClient();
  client.query = async (sql, params) => {
    client.calls.push({ sql: String(sql), params });
    if (String(sql).includes('update action_authority_grants')) return { rows: [revokedRow] };
    return { rows: [] };
  };
  const out = await revokeActionAuthorityGrant(client, {
    firmId: 'f', grantId: 'g-1', revokedByActorType: 'owner', revokedByActorId: 'own-1', reason: 'no longer wanted'
  });
  assert.equal(out?.status, 'revoked');
  assert.equal(out?.provenance?.role_id, 'invoicing_collections');
  assert.ok(client.calls.some((c) => c.sql.includes("status <> 'revoked'")), 'first revocation wins — an already-revoked row is untouched');
  assert.ok(client.calls.some((c) => c.sql.includes('action_authority_grant.revoked')), 'revocation audited');

  assert.equal(await revokeActionAuthorityGrant(makeClient(), {
    firmId: 'f', grantId: 'g-1', revokedByActorType: 'system'
  }), null, 'only the owner revokes at runtime');
  assert.equal(await revokeActionAuthorityGrant(makeClient({ failWith: { code: '42P01' } }), {
    firmId: 'f', grantId: 'g-1'
  }), null, 'pre-migration soft-fail');
});
