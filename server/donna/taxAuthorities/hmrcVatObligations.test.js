import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  createHmrcVatReadAdapter,
  mtdVatReadTransportPendingConfirmation,
  syncHmrcVatReadFromDb,
  syncHmrcVatReadWithClient
} from './hmrcVatObligations.js';

// Renumbered 109 → 111 on the 2026-07-29 rebase: 109 and 110 were taken by the
// K1 knowledge base and its RLS fix while this branch sat on an older base.
// `ls db/migrations/` at rebase time is the only source for this number.
const migration = readFileSync(new URL('../../../db/migrations/111_vat_profiles_and_periods.sql', import.meta.url), 'utf8');

test('MTD-2 migration is additive, RLS-native, closed-state, and has no forever period uniqueness', () => {
  assert.match(migration, /create table if not exists vat_customer_profiles/);
  assert.match(migration, /create table if not exists vat_periods/);
  assert.match(migration, /status in \('open', 'fulfilled', 'unknown'\)/);
  assert.match(migration, /alter table vat_customer_profiles enable row level security/);
  assert.match(migration, /alter table vat_periods enable row level security/);
  assert.doesNotMatch(migration, /unique \(firm_id, client_id, vrn, period_key\)/);
  assert.doesNotMatch(migration, /drop table|drop column|alter column/i);
});

const authorityRead = ({ periodKey = '#001', status = 'open' } = {}) => ({
  profile: {
    id: 'profile-1',
    vrn: '123456789',
    effectiveRegistrationDate: '2024-01-01',
    flatRateScheme: false,
    deregistrationDate: null,
    payload: { acknowledgement: '  authority text must remain untrimmed  ' }
  },
  periods: [{
    id: 'period-1',
    periodKey,
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    dueDate: '2026-05-07',
    receivedDate: null,
    status,
    payload: { acknowledgement: '\nfull evidence\n' }
  }]
});

const statefulClient = () => {
  const state = { profile: null, periods: new Map(), transactions: [] };
  return {
    state,
    async query(sql, params = []) {
      if (['begin', 'commit', 'rollback'].includes(sql)) {
        state.transactions.push(sql);
      } else if (sql.includes('insert into vat_customer_profiles')) {
        state.profile = {
          id: params[0], firmId: params[1], clientId: params[2], vrn: params[3],
          payload: JSON.parse(params[7]), syncedAt: params[8]
        };
      } else if (sql.includes('insert into vat_periods')) {
        state.periods.set(params[4], {
          id: params[0], firmId: params[1], clientId: params[2], vrn: params[3],
          periodKey: params[4], status: params[9], payload: JSON.parse(params[10]),
          syncedAt: params[11]
        });
      } else {
        throw new Error(`Unexpected query: ${sql}`);
      }
      return sql.includes('insert into vat_periods') ? { rows: [{ id: params[0] }], rowCount: 1 } : { rows: [] };
    }
  };
};

test('the pending MTD read transport refuses with the closed channel code', async () => {
  await assert.rejects(
    mtdVatReadTransportPendingConfirmation(),
    (error) => error.code === 'GB_VAT_FILING_CHANNEL_UNAVAILABLE' && error.statusCode === 503
  );
});

test('the production DB binding reaches the refusing default without persistence', async () => {
  const client = statefulClient();
  await assert.rejects(
    syncHmrcVatReadFromDb({
      firmId: 'firm-1',
      clientId: 'client-1',
      syncedAt: '2026-07-29T12:00:00.000Z',
      withFirmDbClientFn: async (fn) => fn(client)
    }),
    (error) => error.code === 'GB_VAT_FILING_CHANNEL_UNAVAILABLE'
  );
  assert.equal(client.state.profile, null);
  assert.deepEqual(client.state.transactions, []);
});

test('an injected read persists the profile, opaque period key, and full evidence', async () => {
  const client = statefulClient();
  const transport = async () => authorityRead();
  await syncHmrcVatReadWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    syncedAt: '2026-07-29T12:00:00.000Z',
    adapter: createHmrcVatReadAdapter({ transport })
  });

  assert.deepEqual(client.state.transactions, ['begin', 'commit']);
  assert.equal(client.state.profile.payload.acknowledgement, '  authority text must remain untrimmed  ');
  assert.equal(client.state.periods.has('#001'), true);
  assert.equal(client.state.periods.get('#001').periodKey, '#001');
  assert.equal(client.state.periods.get('#001').payload.acknowledgement, '\nfull evidence\n');
});

test('period keys remain byte-for-byte opaque rather than being trimmed or encoded', async () => {
  const client = statefulClient();
  const opaque = ' #001 ';
  await syncHmrcVatReadWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    syncedAt: '2026-07-29T12:00:00.000Z',
    adapter: createHmrcVatReadAdapter({ transport: async () => authorityRead({ periodKey: opaque }) })
  });
  assert.equal(client.state.periods.has(opaque), true);
  assert.equal(client.state.periods.has('%23001'), false);
  assert.equal(client.state.periods.has('#001'), false);
});

test('the closed obligation status guard rejects both invented and missing states before writes', async () => {
  for (const status of ['closed', '']) {
    const client = statefulClient();
    await assert.rejects(
      syncHmrcVatReadWithClient({
        client,
        firmId: 'firm-1',
        clientId: 'client-1',
        syncedAt: '2026-07-29T12:00:00.000Z',
        adapter: createHmrcVatReadAdapter({ transport: async () => authorityRead({ status }) })
      }),
      (error) => error.code === 'GB_VAT_OBLIGATION_INVALID' && error.statusCode === 400
    );
    assert.equal(client.state.profile, null);
    assert.deepEqual(client.state.transactions, []);
  }
});

test('a period id collision owned by another tenant raises and rolls back', async () => {
  const client = statefulClient();
  const originalQuery = client.query.bind(client);
  client.query = async (sql, params = []) => {
    if (sql.includes('insert into vat_periods')) return { rows: [], rowCount: 0 };
    return originalQuery(sql, params);
  };
  await assert.rejects(
    syncHmrcVatReadWithClient({
      client,
      firmId: 'firm-2',
      clientId: 'client-2',
      syncedAt: '2026-07-29T12:00:00.000Z',
      adapter: createHmrcVatReadAdapter({ transport: async () => authorityRead() })
    }),
    (error) => error.code === 'GB_VAT_PERIOD_TENANT_COLLISION' && error.statusCode === 409
  );
  assert.deepEqual(client.state.transactions, ['begin', 'rollback']);
});
