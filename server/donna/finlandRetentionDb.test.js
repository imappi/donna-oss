// FI-15 G-9 — the KPL 2:10 retention guards on the two hard-delete writers,
// against pattern-matching fake pg clients (the finlandCreditNoteDb.test.js
// style). Invariants guarded here:
//   • a held statutory book refuses with the typed 409 BEFORE any destructive
//     query (client: before the txn even starts; document: before any delete);
//   • the guard is a strict no-op when FINLAND_TILIKAUSI does not act (no
//     fiscal_years read at all) and on pre-063 deploys (42P01 tolerated);
//   • an elapsed retention window releases the hold;
//   • retentionOverride proceeds but the client.delete audit event carries the
//     override receipt — never silent (D-G9-3).
// Happy paths abort on a SENTINEL at the first destructive query — the guard
// verdict is the unit under test, not the cascade.
//   node --test server/donna/finlandRetentionDb.test.js
// Design: docs/design-donna-finland-fi15-g9-retention-optout.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteClientInDb, deleteDocumentInDb } from './firmDb.js';

const SENTINEL = 'TEST_SENTINEL_STOP';

// Fiscal year rows as the guard's select returns them (::text casts applied).
const closedFy2026 = { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'closed' };
const closedFy2015 = { label: '2015', starts_on: '2015-01-01', ends_on: '2015-12-31', status: 'closed' };

const fakeClient = ({
  flags = { FINLAND_TILIKAUSI: 'auto' },
  fiscalYears = [],
  fiscalYearsError = null,
  document = null
} = {}) => {
  const queries = [];
  return {
    queries,
    sqls() { return queries.map((q) => q.sql); },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      // The authority-plane wipe receipt probes table presence before the
      // cascade; answer "absent" so it stays inert here (it has its own tests).
      if (sql.includes('to_regclass')) return { rows: [{ present: null }] };
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('select jurisdiction, entity_type, incorporation_date, profile from clients')) return { rows: [{ jurisdiction: 'FI', entity_type: 'fi-toiminimi', profile: {} }] };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('from fiscal_years')) {
        if (fiscalYearsError) throw fiscalYearsError;
        return { rows: fiscalYears };
      }
      if (sql.includes('from documents')) return { rows: document ? [document] : [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 1 }] };
      // First destructive statement of either cascade — abort here.
      if (sql.startsWith('delete from clients') || sql.includes('delete from reconciliation_matches')) {
        throw Object.assign(new Error('sentinel'), { code: SENTINEL });
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const inject = (client) => (fn) => fn(client);

// ----- deleteClientInDb -------------------------------------------------------------

test('client delete: held statutory book refuses 409 before the transaction starts', async () => {
  const client = fakeClient({ fiscalYears: [closedFy2026] });
  await assert.rejects(
    deleteClientInDb({ firmId: 'firm-1', clientId: 'client-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === 'FINLAND_RETENTION_CLIENT_HELD' && e.statusCode === 409 &&
      e.details.retain_until === '2036-12-31' && e.details.held_fiscal_years.includes('2026')
  );
  assert.equal(client.sqls().includes('begin'), false);
  assert.equal(client.sqls().some((sql) => sql.startsWith('delete from clients')), false);
});

test('client delete: flag off never reads fiscal_years and proceeds to the cascade', async () => {
  const client = fakeClient({ flags: {} });
  await assert.rejects(
    deleteClientInDb({ firmId: 'firm-1', clientId: 'client-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
  assert.equal(client.sqls().some((sql) => sql.includes('from fiscal_years')), false);
});

test('client delete: pre-063 deploy (no fiscal_years table) is tolerated, not a hold', async () => {
  const client = fakeClient({ fiscalYearsError: Object.assign(new Error('relation does not exist'), { code: '42P01' }) });
  await assert.rejects(
    deleteClientInDb({ firmId: 'firm-1', clientId: 'client-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
});

test('client delete: elapsed retention window releases the hold', async () => {
  // FY ended 2015-12-31 → kirjanpitokirja horizon 2025-12-31, past by 2026-07.
  const client = fakeClient({ fiscalYears: [closedFy2015] });
  await assert.rejects(
    deleteClientInDb({ firmId: 'firm-1', clientId: 'client-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
});

test('client delete: retentionOverride proceeds AND receipts the override on the audit event', async () => {
  const client = fakeClient({ fiscalYears: [closedFy2026] });
  await assert.rejects(
    deleteClientInDb({ firmId: 'firm-1', clientId: 'client-1', retentionOverride: true, withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.ok(audit, 'audit event must be recorded before the cascade');
  const metadata = JSON.parse(audit.params[2]);
  assert.equal(metadata.retention_override, true);
  assert.deepEqual(metadata.held_fiscal_years, ['2026']);
  assert.equal(metadata.retain_until, '2036-12-31');
  assert.equal(client.sqls().includes('rollback'), true, 'sentinel abort must roll back');
});

test('client delete: override with nothing held records a plain (non-override) receipt', async () => {
  const client = fakeClient({ flags: {} });
  await assert.rejects(
    deleteClientInDb({ firmId: 'firm-1', clientId: 'client-1', retentionOverride: true, withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.deepEqual(JSON.parse(audit.params[2]), {});
});

// ----- deleteDocumentInDb -----------------------------------------------------------

const heldDoc = { id: 'doc-1', client_id: 'client-1', filename: 'kuitti.pdf', document_type: 'receipt', document_date: '2026-05-10', uploaded_at: '2026-05-11 09:00:00+00' };

test('document delete: tosite in a closed fiscal year refuses 409 with the 6y horizon', async () => {
  const client = fakeClient({ fiscalYears: [closedFy2026], document: heldDoc });
  await assert.rejects(
    deleteDocumentInDb({ firmId: 'firm-1', documentId: 'doc-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === 'FINLAND_RETENTION_DOCUMENT_HELD' && e.statusCode === 409 &&
      // 6y from the END OF THE CALENDAR YEAR the fiscal year ended in — not from the FY end date.
      e.details.retain_until === '2032-12-31' && e.details.fiscal_year === '2026'
  );
  assert.equal(client.sqls().some((sql) => sql.includes('delete from')), false);
  assert.equal(client.sqls().includes('rollback'), true);
});

test('document delete: open fiscal year holds nothing (normal correction flow)', async () => {
  // The guard's select filters status <> open, so an open year returns no rows.
  const client = fakeClient({ fiscalYears: [], document: heldDoc });
  await assert.rejects(
    deleteDocumentInDb({ firmId: 'firm-1', documentId: 'doc-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
});

test('document delete: flag off never reads fiscal_years', async () => {
  const client = fakeClient({ flags: {}, document: heldDoc });
  await assert.rejects(
    deleteDocumentInDb({ firmId: 'firm-1', documentId: 'doc-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
  assert.equal(client.sqls().some((sql) => sql.includes('from fiscal_years')), false);
});

test('document delete: elapsed tosite window releases (closed FY, 6y past)', async () => {
  const oldDoc = { ...heldDoc, document_date: '2015-05-10' };
  // tosite horizon for FY 2015: 2021-12-31 — long past.
  const client = fakeClient({ fiscalYears: [closedFy2015], document: oldDoc });
  await assert.rejects(
    deleteDocumentInDb({ firmId: 'firm-1', documentId: 'doc-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === SENTINEL
  );
});

test('document delete: the fiscal-year lookup is narrowed to the document date', async () => {
  const client = fakeClient({ fiscalYears: [closedFy2026], document: heldDoc });
  await assert.rejects(
    deleteDocumentInDb({ firmId: 'firm-1', documentId: 'doc-1', withFirmDbClientFn: inject(client) }),
    (e) => e.code === 'FINLAND_RETENTION_DOCUMENT_HELD'
  );
  const fyQuery = client.queries.find((q) => q.sql.includes('from fiscal_years'));
  assert.equal(fyQuery.params[2], '2026-05-10');
});
