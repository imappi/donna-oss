import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFinlandAlvReturnFromDb
} from './statutoryRegistry.js';

const enabledSnapshot = {
  FINLAND_ALV_RETURN: { stage: 'auto', source: 'test' }
};

const fakeClient = ({ flags = enabledSnapshot, lineRows = [], profile = {} } = {}) => {
  const client = {
    queries: [],
    async query(sql, params) {
      client.queries.push({ sql, params });
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, row]) => ({ flag_key, ...row, client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile }] };
      if (sql.includes('from ledger_lines')) return { rows: lineRows };
      // FI-09: the sales-recognition census (no uploaded sales documents here).
      if (sql.includes('from documents')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  return client;
};

const call = ({ client, ...opts } = {}) => getFinlandAlvReturnFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  period: '2026-06',
  readAt: '2026-07-10T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client || fakeClient()),
  ...opts
});

const lineRow = ({ account = '3000', type = 'revenue', tax = null, debit = '0', credit = '0', no = 1, role = null } = {}) => ({
  id: `ll-${no}`,
  journal_id: 'j-1',
  account_id: `acct-${account}`,
  account_code: account,
  account_type: type, // the joined la.account_type column
  line_no: no,
  direction: Number(credit) > 0 ? 'credit' : 'debit',
  debit,
  credit,
  amount: credit || debit,
  currency: 'EUR',
  tax_type: tax,
  // Slice S: the split leg's role rides the line PAYLOAD (what the writer
  // persists) — rowToLedgerLinePayload spreads it onto the line for the engine.
  payload: role ? { role } : {}
});

test('FI-3 DB caller refuses without the FINLAND_ALV_RETURN config-plane flag', async () => {
  await assert.rejects(
    call({ client: fakeClient({ flags: {} }) }),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_ALV_RETURN_DISABLED'
  );
});

test('FI-3 DB caller refuses a malformed period with a typed 400 before touching the DB', async () => {
  let entered = false;
  await assert.rejects(
    call({ period: 'kesäkuu', withFirmDbClientFn: async (fn) => { entered = true; return fn(fakeClient()); } }),
    (e) => e.statusCode === 400 && e.code === 'FINLAND_ALV_PERIOD_INVALID'
  );
  assert.equal(entered, false);
});

test('FI-3 DB caller period-bounds the posted-lines query to the verokausi', async () => {
  const client = fakeClient();
  await call({ client, period: '2026-Q2' });
  const linesQuery = client.queries.find((q) => q.sql.includes('from ledger_lines'));
  assert.ok(linesQuery.sql.includes(`lj.status in ('posted', 'closed')`));
  assert.deepEqual(linesQuery.params, ['firm-1', 'client-1', '2026-04-01', '2026-06-30']);
});

test('FI-3 DB caller aggregates numeric-string pg columns into the return envelope', async () => {
  const result = await call({
    client: fakeClient({
      lineRows: [
        // Post-split convention (slice S): net bases + role-marked VAT legs.
        lineRow({ tax: 'ALV_25_5_OUTPUT', credit: '1000.00' }),
        lineRow({ account: '2939', type: 'liability', credit: '255.00', no: 2, role: 'alv_output' }),
        lineRow({ account: '6800', type: 'expense', tax: 'ALV_14_INPUT', debit: '200.00', no: 3 }),
        lineRow({ account: '2940', type: 'liability', debit: '28.00', no: 4, role: 'alv_input_deductible' })
      ]
    })
  });
  assert.equal(result.alvReturn.boxes['301'], 255);
  assert.equal(result.alvReturn.boxes['307'], 28);
  assert.equal(result.alvReturn.payable, 227);
  assert.equal(result.review.status, 'ready');
  assert.deepEqual(result.period, { key: '2026-06', type: 'month', starts_on: '2026-06-01', ends_on: '2026-06-30' });
});

test('FI-3 DB caller surfaces uncoded revenue as needs_review off the JOINED account type', async () => {
  const result = await call({
    client: fakeClient({ lineRows: [lineRow({ tax: null, credit: '500.00' })] })
  });
  assert.equal(result.review.status, 'needs_review');
  assert.deepEqual(result.review.blockers, ['uncoded_revenue_lines']);
});

test('FI-3 DB caller returns a READY nil return for an empty period with honest provenance', async () => {
  const result = await call({ client: fakeClient({ lineRows: [] }) });
  assert.equal(result.review.status, 'ready');
  assert.equal(result.alvReturn.nilReturn, true);
  assert.equal(result.alvReturn.boxes['308'], 0);
  assert.equal(result.provenance.source, 'ledger_read_model');
  assert.equal(result.provenance.deterministic, true);
  assert.equal(result.provenance.readAt, '2026-07-10T00:00:00.000Z');
  // The box map's confirmation state travels WITH every rendered verdict.
  assert.equal(result.provenance.boxMap.confirmedAgainstPrimary, false);
  assert.ok(result.provenance.boxMap.source.includes('VSRALVKV'));
});

test('FI-3 DB caller surfaces the client verokausi cadence on the envelope, monthly by default (F-FI3-3)', async () => {
  // No profile.verokausi ⇒ the D3 monthly default.
  const monthly = await call({ client: fakeClient({ lineRows: [] }) });
  assert.equal(monthly.verokausi, 'month');
  // A quarterly filer's stored cadence rides the envelope so the picker can lead with it.
  const quarterly = await call({ client: fakeClient({ lineRows: [], profile: { verokausi: 'quarter' } }) });
  assert.equal(quarterly.verokausi, 'quarter');
});
