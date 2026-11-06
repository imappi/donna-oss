// GB fiscal-year resolution through resolveClientFiscalYearTx — the seam test
// for the audit §2 gap "the UK tax year does not exist in the tree": before
// 2026-07-31 the resolver gated the fiscal_years registry on the literal
// 'fi-oy', so every GB client fell through to a hardcoded calendar year.
// Now a canonical `gb-*` entity_type resolves registry-first, then GB statute
// (ARD-derived periods for companies, the 6-April tax year for unincorporated),
// and REFUSES where it would otherwise have to guess. The GB twin of
// finlandFiscalYearResolverDb.test.js — same mock, same discipline.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveClientFiscalYearTx } from './firmDb.js';

// A programmable mock client: `clientRow` answers the `from clients` read,
// `fiscalRows` answers the fiscal_years covering-row query, and every call is
// recorded so we can assert what was (and wasn't) queried.
const makeClient = ({ clientRow = { jurisdiction: 'GB' }, fiscalRows = [] } = {}) => {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('from clients')) {
        return { rows: clientRow === undefined ? [] : [{ jurisdiction: 'GB', ...clientRow }] };
      }
      if (sql.includes('from fiscal_years')) {
        return { rows: fiscalRows };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

test('a gb-ltd consults the fiscal_years registry and resolves a persisted period', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'GB', incorporation_date: null, entity_type: 'gb-ltd' }, fiscalRows: [{ label: 'FY2026', starts_on: '2025-07-01', ends_on: '2026-06-30' }] });
  const fy = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2026-01-15',
    incorporationDate: null, entityType: 'gb-ltd'
  });
  assert.deepEqual(fy, { label: 'FY2026', starts_on: '2025-07-01', ends_on: '2026-06-30' });
  assert.ok(client.calls.some(c => c.sql.includes('from fiscal_years')));
});

test('a gb-ltd with NO registry row derives ARD periods from its incorporation date', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'GB', incorporation_date: '2025-05-10', entity_type: 'gb-ltd' }, fiscalRows: [] });
  const first = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2025-08-15',
    incorporationDate: '2025-05-10', entityType: 'gb-ltd'
  });
  assert.deepEqual(first, { label: '2026', starts_on: '2025-05-10', ends_on: '2026-05-31' });
  const second = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2026-07-15',
    incorporationDate: '2025-05-10', entityType: 'gb-ltd'
  });
  assert.deepEqual(second, { label: '2027', starts_on: '2026-06-01', ends_on: '2027-05-31' });
});

test('a gb-ltd with neither registry row nor incorporation date REFUSES — never a silent calendar year', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'GB', incorporation_date: null, entity_type: 'gb-ltd' }, fiscalRows: [] });
  await assert.rejects(
    () => resolveClientFiscalYearTx({ client, firmId: 'f', clientId: 'c', date: '2026-05-14', incorporationDate: null, entityType: 'gb-ltd' }),
    (e) => e.code === 'GB_ACCOUNTING_PERIOD_REQUIRES_PERSISTED' && e.statusCode === 409
  );
});

test('a gb-sole-trader resolves the statutory 6-April tax year', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'GB', incorporation_date: null, entity_type: 'gb-sole-trader' }, fiscalRows: [] });
  const fy = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2026-06-15',
    incorporationDate: null, entityType: 'gb-sole-trader'
  });
  assert.deepEqual(fy, { label: '2026/27', starts_on: '2026-04-06', ends_on: '2027-04-05' });
});

test('a gb-sole-trader registry row (e.g. a 31 March election) outranks the derived tax year', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'GB', incorporation_date: null, entity_type: 'gb-sole-trader' }, fiscalRows: [{ label: '2026/27', starts_on: '2026-04-01', ends_on: '2027-03-31' }] });
  const fy = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2026-06-15',
    incorporationDate: null, entityType: 'gb-sole-trader'
  });
  assert.deepEqual(fy, { label: '2026/27', starts_on: '2026-04-01', ends_on: '2027-03-31' });
});

test('an AMBIGUOUS GB registry (overlapping covering rows) is refused, not silently picked', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'GB', incorporation_date: null, entity_type: 'gb-ltd' }, fiscalRows: [
    { label: 'A', starts_on: '2026-01-01', ends_on: '2026-12-31' },
    { label: 'B', starts_on: '2026-06-01', ends_on: '2027-05-31' }
  ] });
  await assert.rejects(
    () => resolveClientFiscalYearTx({ client, firmId: 'f', clientId: 'c', date: '2026-08-01', incorporationDate: null, entityType: 'gb-ltd' }),
    (e) => e.code === 'FISCAL_YEAR_REGISTRY_AMBIGUOUS' && e.statusCode === 409
  );
});

test('a NON-canonical GB entity_type keeps the legacy calendar fallback (no registry query) — nothing regresses before X4 lands', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'GB', incorporation_date: null, entity_type: 'Limited company' } });
  const fy = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2026-05-14',
    incorporationDate: null, entityType: 'Limited company'
  });
  assert.deepEqual(fy, { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' });
  assert.equal(client.calls.filter(c => c.sql.includes('from fiscal_years')).length, 0, 'free-form entity type never touches the registry');
});

test('entity_type is READ from the client row when not supplied and dispatches GB', async () => {
  const client = makeClient({
    clientRow: { incorporation_date: '2025-05-10', entity_type: 'gb-ltd' },
    fiscalRows: []
  });
  const fy = await resolveClientFiscalYearTx({ client, firmId: 'f', clientId: 'c', date: '2025-08-15' });
  assert.deepEqual(fy, { label: '2026', starts_on: '2025-05-10', ends_on: '2026-05-31' });
  assert.match(client.calls[0].sql, /incorporation_date, profile from clients/);
});
