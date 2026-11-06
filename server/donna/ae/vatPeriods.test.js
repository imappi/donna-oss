// AE FTA-assigned tax periods — writer discipline and resolver invariants.

import assert from 'node:assert/strict';
import test from 'node:test';
import { AE_VAT_RETURN_DUE_DAYS, recordAeVatPeriod, resolveAeVatPeriod } from './vatPeriods.js';

const REGISTERED = {
  status: 'registered',
  registered_from: '2026-01-01',
  vat_registration_number: '100 1234 5678 9012'
};

const fakeClient = ({ existing = [] } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('select id from ae_vat_periods')) return { rows: existing };
      return { rows: [], rowCount: 1 };
    }
  };
};

const record = (client, overrides = {}) => recordAeVatPeriod({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  registration: REGISTERED,
  periodKey: 'Apr-Jun 2026',
  startDate: '2026-04-01',
  endDate: '2026-06-30',
  dueDate: '2026-07-28',
  recordedBy: 'kari@books.example',
  source: 'EmaraTax dashboard',
  ...overrides
});

test('a record commits the period and its audit event in one transaction, in order', async () => {
  const client = fakeClient();
  const { period, dueDateNote } = await record(client);
  assert.equal(period.status, 'open');
  assert.equal(period.dueOn, '2026-07-28');
  assert.equal(dueDateNote, null, '28 days exactly — no deviation note');
  const sqls = client.calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.equal(sqls[1], 'begin');
  assert.match(client.calls[2].sql, /insert into ae_vat_periods/);
  assert.match(client.calls[3].sql, /insert into audit_events/);
  assert.equal(sqls[4], 'commit');
  assert.equal(client.calls[3].params[2], 'kari@books.example', 'the recording actor is attributed');
  assert.equal(client.calls[3].sql.includes("'ae_vat.period_recorded'"), true);
});

test('the TRN stored comes from the resolved registration, never a caller value', async () => {
  const client = fakeClient();
  await record(client);
  assert.equal(client.calls[2].params[3], '100 1234 5678 9012');
});

test('a due date past end + 28 days records with a deviation note, never a refusal', async () => {
  const client = fakeClient();
  const { dueDateNote } = await record(client, { dueDate: '2026-07-30' });
  assert.match(dueDateNote, new RegExp(`\\+ ${AE_VAT_RETURN_DUE_DAYS} days`));
  const source = JSON.parse(client.calls[2].params[8]);
  assert.equal(source.due_date_note, dueDateNote, 'the note is persisted with the record');
});

test('an audit-insert failure aborts the record — rollback, error propagates', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push(sql);
      if (sql.includes('select id from ae_vat_periods')) return { rows: [] };
      if (sql.includes('insert into audit_events')) throw new Error('audit unavailable');
      return { rows: [], rowCount: 1 };
    }
  };
  await assert.rejects(record(client), /audit unavailable/);
  assert.equal(calls[calls.length - 1].trim(), 'rollback');
});

test('an unrecorded registration refuses — absence is not a "no"', async () => {
  await assert.rejects(
    record(fakeClient(), { registration: null }),
    (error) => error.code === 'AE_VAT_REGISTRATION_NOT_ESTABLISHED'
  );
});

test('a not-registered record refuses — the FTA assigns periods to registrants', async () => {
  await assert.rejects(
    record(fakeClient(), { registration: { status: 'not_registered' } }),
    (error) => error.code === 'AE_VAT_PERIOD_NOT_REGISTERED'
  );
});

test('a registered record without a TRN refuses — the approval window is named', async () => {
  await assert.rejects(
    record(fakeClient(), { registration: { status: 'registered', registered_from: '2026-01-01' } }),
    (error) => error.code === 'AE_VAT_PERIOD_TRN_REQUIRED'
  );
});

test('a duplicate period key refuses with the existing row named', async () => {
  await assert.rejects(
    record(fakeClient({ existing: [{ id: 'p-existing' }] })),
    (error) => error.code === 'AE_VAT_PERIOD_DUPLICATE' && error.details.id === 'p-existing'
  );
});

test('missing actor and disordered dates refuse by name before any query', async () => {
  await assert.rejects(record(fakeClient(), { recordedBy: null }), (error) => error.code === 'AE_VAT_PERIOD_ACTOR_REQUIRED');
  await assert.rejects(record(fakeClient(), { dueDate: '2026-06-01' }), (error) => error.code === 'AE_VAT_PERIOD_INVALID');
  await assert.rejects(record(fakeClient(), { startDate: '2026-07-01' }), (error) => error.code === 'AE_VAT_PERIOD_INVALID');
});

test('the resolver matches exactly one period by key or containing date and refuses otherwise', () => {
  const rows = [
    { id: 'p1', period_key: 'Q1', start_date: '2026-01-01', end_date: '2026-03-31', due_date: '2026-04-28', status: 'open' },
    { id: 'p2', period_key: 'Q2', start_date: '2026-04-01', end_date: '2026-06-30', due_date: '2026-07-28', status: 'open' }
  ];
  assert.equal(resolveAeVatPeriod({ periods: rows, periodKey: 'Q2' }).id, 'p2');
  assert.equal(resolveAeVatPeriod({ periods: rows, asOf: '2026-02-15' }).id, 'p1');
  assert.throws(() => resolveAeVatPeriod({ periods: rows, periodKey: 'Q9' }), (error) => error.code === 'AE_VAT_PERIOD_NOT_ESTABLISHED');
  assert.throws(() => resolveAeVatPeriod({ periods: rows }), (error) => error.code === 'AE_VAT_PERIOD_NOT_ESTABLISHED');
});

test('an incomplete persisted row refuses by the missing field', () => {
  assert.throws(
    () => resolveAeVatPeriod({ periods: [{ id: 'p1', period_key: 'Q1', start_date: '2026-01-01', end_date: '2026-03-31' }], periodKey: 'Q1' }),
    (error) => error.code === 'AE_VAT_PERIOD_INCOMPLETE' && /due_date/.test(error.message)
  );
});
