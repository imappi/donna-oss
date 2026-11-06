// INT-6 — ledgerSyncAuthorityGrants unit tests. Load-bearing properties:
//   - every guard fails CLOSED: wrong system, non-active status, a corrected
//     grant (correction_count > 0), an UNBOUNDED row (neither expires_at nor
//     review_after), expired/past-review windows — none may auto-export;
//   - the ceiling is optional but strict: set ⇒ unknown amount / over-ceiling /
//     currency mismatch all fail closed for that journal;
//   - mint enforces the authority boundary (firm_operator/accountant/admin at
//     runtime; system only on the audited migration path), the MANDATORY time
//     bound, and the ceiling↔currency pairing; audits only genuine inserts;
//   - auto-suspend bumps correction_count and suspends every non-revoked grant
//     for the client (revoked stays revoked), with an audit row each;
//   - receipts carry actor_type='authority_grant' + actor_id=grant id, and the
//     use_count bumps only for synced items;
//   - pre-migration soft-fail: 42P01 → null/[] everywhere, never a throw.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEDGER_SYNC_GRANT_SYSTEMS,
  LEDGER_SYNC_GRANT_STATUSES,
  LEDGER_AUTO_EXPORT_FLAG_KEY,
  buildLedgerSyncGrantId,
  ledgerSyncGrantIsLive,
  ledgerSyncGrantCoversAmount,
  findActiveLedgerSyncGrant,
  mintLedgerSyncGrant,
  suspendLedgerSyncGrantsAfterExportCorrection,
  writeLedgerAutoExportReceipts
} from './ledgerSyncAuthorityGrants.js';

const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const liveGrant = (overrides = {}) => ({
  id: 'sync-grant-honeybee-qbo-abc',
  firm_id: 'firm-1',
  client_id: 'honeybee',
  accounting_system: 'qbo',
  action: 'export_posted_journal',
  amount_ceiling: null,
  currency: null,
  status: 'active',
  correction_count: 0,
  valid_from: PAST,
  expires_at: null,
  review_after: FUTURE,
  ...overrides
});

// Simple scripted fake pg client: responders matched in order by SQL substring.
const makeClient = (responders = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql).toLowerCase().replace(/\s+/g, ' '), params });
      for (const r of responders) {
        if (String(sql).toLowerCase().includes(r.match)) {
          if (r.error) { const e = new Error(r.error.message || 'db error'); e.code = r.error.code; throw e; }
          return { rows: typeof r.rows === 'function' ? r.rows(params) : (r.rows || []) };
        }
      }
      return { rows: [] };
    }
  };
};

test('flag key is on the plane vocabulary (no env pair)', () => {
  assert.equal(LEDGER_AUTO_EXPORT_FLAG_KEY, 'LEDGER_AUTO_EXPORT');
});

test('buildLedgerSyncGrantId is deterministic and system-scoped', () => {
  const a = buildLedgerSyncGrantId({ firmId: 'f', clientId: 'c', accountingSystem: 'qbo', action: 'export_posted_journal' });
  const b = buildLedgerSyncGrantId({ firmId: 'f', clientId: 'c', accountingSystem: 'QBO', action: 'export_posted_journal' });
  const c = buildLedgerSyncGrantId({ firmId: 'f', clientId: 'c', accountingSystem: 'xero', action: 'export_posted_journal' });
  assert.equal(a, b, 'system is case-normalized');
  assert.notEqual(a, c, 'different system → different grant row');
  assert.match(a, /^sync-grant-c-qbo-[0-9a-f]{16}$/);
});

test('ledgerSyncGrantIsLive: a live, bounded, matching grant passes', () => {
  assert.equal(ledgerSyncGrantIsLive(liveGrant(), { accountingSystem: 'qbo' }), true);
});

test('ledgerSyncGrantIsLive fails closed on every doubt', () => {
  const cases = [
    [null, { accountingSystem: 'qbo' }, 'null grant'],
    [liveGrant(), { accountingSystem: 'xero' }, 'wrong system'],
    [liveGrant({ status: 'proposed' }), { accountingSystem: 'qbo' }, 'proposed'],
    [liveGrant({ status: 'suspended' }), { accountingSystem: 'qbo' }, 'suspended'],
    [liveGrant({ status: 'revoked' }), { accountingSystem: 'qbo' }, 'revoked'],
    [liveGrant({ correction_count: 1 }), { accountingSystem: 'qbo' }, 'corrected grant'],
    [liveGrant({ expires_at: null, review_after: null }), { accountingSystem: 'qbo' }, 'UNBOUNDED grant'],
    [liveGrant({ review_after: PAST }), { accountingSystem: 'qbo' }, 'past review_after'],
    [liveGrant({ review_after: null, expires_at: PAST }), { accountingSystem: 'qbo' }, 'expired'],
    [liveGrant({ valid_from: FUTURE }), { accountingSystem: 'qbo' }, 'not yet valid'],
    [liveGrant({ action: 'accept_match' }), { accountingSystem: 'qbo' }, 'foreign action'],
    [liveGrant(), { accountingSystem: 'qbo', action: 'accounting_state_mutation' }, 'requested action ≠ export']
  ];
  for (const [grant, opts, label] of cases) {
    assert.equal(ledgerSyncGrantIsLive(grant, opts), false, `fails closed: ${label}`);
  }
});

test('ledgerSyncGrantCoversAmount: no ceiling covers everything; a ceiling is strict', () => {
  assert.equal(ledgerSyncGrantCoversAmount(liveGrant(), { amount: 999999, currency: 'USD' }), true, 'no ceiling → covered');
  const capped = liveGrant({ amount_ceiling: 500, currency: 'USD' });
  assert.equal(ledgerSyncGrantCoversAmount(capped, { amount: 499.99, currency: 'USD' }), true);
  assert.equal(ledgerSyncGrantCoversAmount(capped, { amount: 500, currency: 'usd' }), true, 'ceiling inclusive, currency case-normalized');
  assert.equal(ledgerSyncGrantCoversAmount(capped, { amount: 500.01, currency: 'USD' }), false, 'over ceiling');
  assert.equal(ledgerSyncGrantCoversAmount(capped, { amount: null, currency: 'USD' }), false, 'unknown amount fails closed');
  assert.equal(ledgerSyncGrantCoversAmount(capped, { amount: 100, currency: 'EUR' }), false, 'currency mismatch fails closed');
  assert.equal(ledgerSyncGrantCoversAmount(capped, { amount: 0, currency: 'USD' }), false, 'non-positive amount fails closed');
});

test('findActiveLedgerSyncGrant returns the live row, skipping dead ones', async () => {
  const rows = [liveGrant({ id: 'dead', status: 'suspended' }), liveGrant({ id: 'live' })];
  const client = makeClient([{ match: 'from ledger_sync_authority_grants', rows }]);
  const grant = await findActiveLedgerSyncGrant({ client, firmId: 'firm-1', clientId: 'honeybee', accountingSystem: 'qbo' });
  assert.equal(grant?.id, 'live');
});

test('findActiveLedgerSyncGrant soft-fails pre-migration (42P01 → null)', async () => {
  const client = makeClient([{ match: 'from ledger_sync_authority_grants', error: { code: '42P01' } }]);
  const grant = await findActiveLedgerSyncGrant({ client, firmId: 'f', clientId: 'c', accountingSystem: 'xero' });
  assert.equal(grant, null);
});

test('findActiveLedgerSyncGrant rejects unknown systems without touching the db', async () => {
  const client = makeClient([]);
  const grant = await findActiveLedgerSyncGrant({ client, firmId: 'f', clientId: 'c', accountingSystem: 'sage' });
  assert.equal(grant, null);
  assert.equal(client.calls.length, 0);
});

test('mintLedgerSyncGrant enforces the authority boundary and the mandatory time bound', async () => {
  const base = {
    firmId: 'f', clientId: 'c', accountingSystem: 'qbo',
    source: 'operator_one_click', reviewAfter: FUTURE
  };
  const client = makeClient([]);
  assert.equal(await mintLedgerSyncGrant({ client, ...base, authorizedByActorType: 'client' }), null, 'owner may not mint');
  assert.equal(await mintLedgerSyncGrant({ client, ...base, authorizedByActorType: 'system' }), null, 'system may not self-authorize at runtime');
  assert.equal(
    await mintLedgerSyncGrant({ client, ...base, authorizedByActorType: 'firm_operator', reviewAfter: null }),
    null,
    'UNBOUNDED mint refused (no expires_at, no review_after)'
  );
  assert.equal(
    await mintLedgerSyncGrant({ client, ...base, authorizedByActorType: 'firm_operator', amountCeiling: 500 }),
    null,
    'ceiling without currency refused'
  );
  assert.equal(
    await mintLedgerSyncGrant({ client, ...base, authorizedByActorType: 'firm_operator', accountingSystem: 'sage' }),
    null,
    'unknown system refused'
  );
  assert.equal(client.calls.length, 0, 'every refusal happens before any write');
});

test('mintLedgerSyncGrant writes + audits a genuine insert; upsert re-mint does not re-audit', async () => {
  const mkClient = (inserted) => makeClient([
    { match: 'insert into ledger_sync_authority_grants', rows: (params) => [{ id: params[0], inserted, status: params[11] }] },
    { match: 'insert into audit_events', rows: [] }
  ]);
  const insertClient = mkClient(true);
  const minted = await mintLedgerSyncGrant({
    client: insertClient, firmId: 'f', clientId: 'c', accountingSystem: 'qbo',
    amountCeiling: 500, currency: 'usd',
    authorizedByActorType: 'firm_operator', authorizedByActorId: 'kari@books.example',
    source: 'operator_one_click', reviewAfter: FUTURE
  });
  assert.equal(minted.inserted, true);
  assert.equal(minted.status, 'active');
  const audit = insertClient.calls.find((c) => c.sql.includes('insert into audit_events'));
  assert.ok(audit, 'genuine insert is audited');
  assert.equal(audit.params[2], 'firm_operator', 'the minting authority is the actor');
  assert.match(audit.sql, /ledger_sync_authority_grant\.minted/);

  const upsertClient = mkClient(false);
  await mintLedgerSyncGrant({
    client: upsertClient, firmId: 'f', clientId: 'c', accountingSystem: 'qbo',
    authorizedByActorType: 'firm_operator', source: 'operator_one_click', reviewAfter: FUTURE
  });
  assert.equal(upsertClient.calls.some((c) => c.sql.includes('insert into audit_events')), false, 'idempotent re-mint does not spam the trail');
});

test('mintLedgerSyncGrant allows system ONLY on the audited migration path', async () => {
  const client = makeClient([
    { match: 'insert into ledger_sync_authority_grants', rows: (params) => [{ id: params[0], inserted: true, status: params[11] }] },
    { match: 'insert into audit_events', rows: [] }
  ]);
  const minted = await mintLedgerSyncGrant({
    client, firmId: 'f', clientId: 'c', accountingSystem: 'xero',
    authorizedByActorType: 'system', source: 'accountant_approval',
    reviewAfter: FUTURE, isMigration: true,
    provenance: { originating_authority: 'kari@books.example' }
  });
  assert.ok(minted, 'migration path with originating authority mints');
  const withoutProvenance = await mintLedgerSyncGrant({
    client, firmId: 'f', clientId: 'c', accountingSystem: 'xero',
    authorizedByActorType: 'system', source: 'accountant_approval',
    reviewAfter: FUTURE, isMigration: true, provenance: {}
  });
  assert.equal(withoutProvenance, null, 'migration path without originating authority refused');
});

test('suspendLedgerSyncGrantsAfterExportCorrection suspends every non-revoked grant + audits', async () => {
  const client = makeClient([
    {
      match: 'update ledger_sync_authority_grants',
      rows: [
        { id: 'g1', status: 'suspended', correction_count: 1 },
        { id: 'g2', status: 'revoked', correction_count: 2 }
      ]
    },
    { match: 'insert into audit_events', rows: [] }
  ]);
  const out = await suspendLedgerSyncGrantsAfterExportCorrection({
    client, firmId: 'f', clientId: 'c', journalId: 'j1', reason: 'export_correction'
  });
  assert.deepEqual(out, [
    { id: 'g1', status: 'suspended', correction_count: 1 },
    { id: 'g2', status: 'revoked', correction_count: 2 }
  ]);
  const audits = client.calls.filter((c) => c.sql.includes('insert into audit_events'));
  assert.equal(audits.length, 2, 'one audit row per suspended grant');
  assert.match(audits[0].sql, /ledger_sync_authority_grant\.auto_suspended/);
});

test('suspendLedgerSyncGrantsAfterExportCorrection soft-fails pre-migration (42P01 → [])', async () => {
  const client = makeClient([{ match: 'update ledger_sync_authority_grants', error: { code: '42P01' } }]);
  const out = await suspendLedgerSyncGrantsAfterExportCorrection({ client, firmId: 'f', clientId: 'c' });
  assert.deepEqual(out, []);
});

test('writeLedgerAutoExportReceipts: actor is the GRANT; use_count bumps for synced only', async () => {
  const client = makeClient([
    { match: 'insert into audit_events', rows: [] },
    { match: 'update ledger_sync_authority_grants', rows: [] }
  ]);
  const grant = liveGrant({ id: 'grant-1', amount_ceiling: 500 });
  const { receipts } = await writeLedgerAutoExportReceipts({
    client, firmId: 'f', clientId: 'c', grant, accountingSystem: 'qbo', flagStage: 'canary',
    items: [
      { transactionId: 't1', journalId: 'j1', status: 'synced', amount: 120, currency: 'USD' },
      { transactionId: 't2', journalId: 'j2', status: 'error', error: 'boom', errorCode: 'E1', amount: 80, currency: 'USD' }
    ],
    mirrorVerifyCounts: { ok: 1, drift: 0 }
  });
  assert.equal(receipts, 2);
  const audits = client.calls.filter((c) => c.sql.includes('insert into audit_events'));
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    assert.match(audit.sql, /'authority_grant'/, "actor_type is 'authority_grant'");
    assert.equal(audit.params[2], 'grant-1', 'actor_id is the grant id');
  }
  const [ok, failed] = audits.map((a) => JSON.parse(a.params[6]));
  assert.equal(audits[0].params[3], 'ledger_sync.auto_exported');
  assert.equal(audits[1].params[3], 'ledger_sync.auto_export_failed');
  assert.equal(ok.model, null, 'the export decision is deterministic — model null by design');
  assert.deepEqual(ok.mirror_verify_counts, { ok: 1, drift: 0 }, 'the chained mirror verdict rides the receipt');
  assert.equal(failed.error, 'boom');
  const bump = client.calls.find((c) => c.sql.includes('update ledger_sync_authority_grants'));
  assert.ok(bump, 'use_count bumped');
  assert.equal(bump.params[2], 1, 'only the SYNCED item counts as a use');
});

test('vocabularies stay pinned', () => {
  assert.deepEqual(LEDGER_SYNC_GRANT_SYSTEMS, ['xero', 'qbo']);
  assert.deepEqual(LEDGER_SYNC_GRANT_STATUSES, ['proposed', 'active', 'suspended', 'revoked']);
});
