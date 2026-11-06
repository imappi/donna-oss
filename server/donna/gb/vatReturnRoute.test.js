import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mtdVatSubmissionTransportPendingConfirmation,
  prepareGbVatReturnWithClient,
  renderGbVatReturnForOwner,
  submitPreparedGbVatReturn
} from './vatReturnRoute.js';

test('real DB wiring scopes the persisted period and posted ledger read to the tenant', async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('from vat_periods')) return { rows: [{ id: 'p1', period_key: '#001', start_date: '2026-01-01', end_date: '2026-03-31', due_date: '2026-05-07', status: 'open' }] };
    if (sql.includes('from ledger_lines')) return { rows: [
      { journal_id: 'j1', line_no: 1, debit: 0, credit: 100, tax_type: 'VAT_SR_20_OUTPUT', account_type: 'revenue' },
      { journal_id: 'j1', line_no: 2, debit: 0, credit: 20, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
    ] };
    throw new Error('unexpected query');
  } };
  const prepared = await prepareGbVatReturnWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    periodKey: '#001',
    vatRegistration: { status: 'registered', registered_from: '2020-01-01' }
  });
  assert.equal(prepared.vatReturn.boxes['1'], 20);
  assert.deepEqual(calls[0].params, ['firm-1', 'client-1']);
  assert.deepEqual(calls[1].params, ['firm-1', 'client-1', '2026-01-01', '2026-03-31']);
  assert.match(calls[1].sql, /lj\.status in \('posted', 'closed'\)/); // a close lock seals posted journals to closed
  assert.match(renderGbVatReturnForOwner(prepared), /Box 9: £0\.00/);
});

test('submission stops at the named unconfirmed transport boundary', async () => {
  const prepared = { vatReturn: { boxes: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), 0])) } };
  await assert.rejects(mtdVatSubmissionTransportPendingConfirmation(), (error) => error.code === 'GB_VAT_FILING_CHANNEL_UNAVAILABLE');
  await assert.rejects(submitPreparedGbVatReturn({ prepared }), (error) => error.code === 'GB_VAT_FILING_CHANNEL_UNAVAILABLE');
  let received = null;
  await submitPreparedGbVatReturn({ prepared, transport: async (request) => { received = request; return { accepted: false }; } });
  assert.equal(received.prepared, prepared);
});
