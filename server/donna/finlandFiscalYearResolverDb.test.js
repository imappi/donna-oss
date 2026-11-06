import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveClientFiscalYearTx } from './firmDb.js';

const err = (code) => Object.assign(new Error(code), { code });

// A programmable mock client: `clientRow` answers the `from clients` read,
// `fiscalRows` answers the fiscal_years covering-row query, and every call is
// recorded so we can assert what was (and wasn't) queried.
const makeClient = ({ clientRow = { jurisdiction: 'FI' }, fiscalRows = [], fiscalThrow = null } = {}) => {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('from clients')) {
        return { rows: clientRow === undefined ? [] : [{ jurisdiction: 'FI', ...clientRow }] };
      }
      if (sql.includes('from fiscal_years')) {
        if (fiscalThrow) throw fiscalThrow;
        return { rows: fiscalRows };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

test('a toiminimi resolves the calendar year and NEVER touches the fiscal_years registry', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'FI', incorporation_date: null, entity_type: 'fi-toiminimi' } });
  const fy = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2026-05-14',
    incorporationDate: null, entityType: 'fi-toiminimi'
  });
  assert.deepEqual(fy, { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' });
  // Both entityType and incorporationDate were supplied, so no client read; and a
  // non-Oy never queries fiscal_years.
  assert.equal(client.calls.filter(c => c.sql.includes('from fiscal_years')).length, 0);
});

test('a toiminimi short first year still truncates to the incorporation date', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'FI', incorporation_date: '2026-06-15', entity_type: 'fi-toiminimi' } });
  const fy = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2026-08-01',
    incorporationDate: '2026-06-15', entityType: 'fi-toiminimi'
  });
  assert.equal(fy.starts_on, '2026-06-15');
});

test('entity_type and incorporation_date are READ from the client row when not supplied', async () => {
  const client = makeClient({ clientRow: { incorporation_date: '2026-03-01', entity_type: 'fi-toiminimi' } });
  const fy = await resolveClientFiscalYearTx({ client, firmId: 'f', clientId: 'c', date: '2026-08-01' });
  assert.equal(fy.starts_on, '2026-03-01', 'short first year from the read incorporation date');
  assert.match(client.calls[0].sql, /incorporation_date, profile from clients/);
});

test('an fi-oy resolves from its persisted off-calendar tilikausi', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'FI', incorporation_date: null, entity_type: 'fi-oy' }, fiscalRows: [{ label: 'FY2026', starts_on: '2026-07-01', ends_on: '2027-06-30' }] });
  const fy = await resolveClientFiscalYearTx({
    client, firmId: 'f', clientId: 'c', date: '2027-01-15',
    incorporationDate: null, entityType: 'fi-oy'
  });
  assert.deepEqual(fy, { label: 'FY2026', starts_on: '2026-07-01', ends_on: '2027-06-30' });
  assert.ok(client.calls.some(c => c.sql.includes('from fiscal_years')));
});

test('an fi-oy with NO persisted period throws the C6 assertion (calendar resolution refused)', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'FI', incorporation_date: null, entity_type: 'fi-oy' }, fiscalRows: [] });
  await assert.rejects(
    () => resolveClientFiscalYearTx({ client, firmId: 'f', clientId: 'c', date: '2026-05-14', incorporationDate: null, entityType: 'fi-oy' }),
    (e) => e.code === 'FISCAL_YEAR_OY_REQUIRES_PERSISTED_PERIOD' && e.statusCode === 409
  );
});

test('an AMBIGUOUS registry (overlapping rows covering the date) is refused, not silently picked', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'FI', incorporation_date: null, entity_type: 'fi-oy' }, fiscalRows: [
    { label: 'A', starts_on: '2026-01-01', ends_on: '2026-12-31' },
    { label: 'B', starts_on: '2026-06-01', ends_on: '2027-05-31' }
  ] });
  await assert.rejects(
    () => resolveClientFiscalYearTx({ client, firmId: 'f', clientId: 'c', date: '2026-08-01', incorporationDate: null, entityType: 'fi-oy' }),
    (e) => e.code === 'FISCAL_YEAR_REGISTRY_AMBIGUOUS' && e.statusCode === 409
  );
});

test('a persisted row that does not actually cover the date is a registry mismatch', async () => {
  // The covering-query SQL would normally exclude this, but the pure resolver
  // re-checks: a caller passing a non-covering row must never have it used.
  const client = makeClient({ clientRow: { jurisdiction: 'FI', incorporation_date: null, entity_type: 'fi-oy' }, fiscalRows: [{ label: 'FY2026', starts_on: '2026-07-01', ends_on: '2027-06-30' }] });
  await assert.rejects(
    () => resolveClientFiscalYearTx({ client, firmId: 'f', clientId: 'c', date: '2026-06-15', incorporationDate: null, entityType: 'fi-oy' }),
    (e) => e.code === 'FISCAL_YEAR_REGISTRY_MISMATCH'
  );
});
