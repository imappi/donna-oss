// AE VAT preparation route — tenant scoping, boundary refusals, the owner
// rendering, and the accreditation-dark transmit seam.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aeVatSubmissionTransportPendingAccreditation,
  prepareAeVatReturnWithClient,
  renderAeVatReturnForOwner,
  submitPreparedAeVatReturn
} from './vatReturnRoute.js';

const REGISTERED = {
  status: 'registered',
  registered_from: '2020-01-01',
  vat_registration_number: '100 1234 5678 9012'
};
const PERIOD_ROW = { id: 'p1', period_key: 'Apr-Jun 2026', start_date: '2026-04-01', end_date: '2026-06-30', due_date: '2026-07-28', status: 'open' };

const clientWith = ({ periods = [PERIOD_ROW], lines = [] } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('from ae_vat_periods')) return { rows: periods };
      if (sql.includes('from ledger_lines')) return { rows: lines };
      throw new Error('unexpected query');
    }
  };
};

test('real DB wiring scopes the recorded period and posted ledger read to the tenant', async () => {
  const client = clientWith({ lines: [
    { journal_id: 'j1', line_no: 1, debit: 0, credit: 1000, tax_type: 'AE_VAT_SR_5_OUTPUT', journal_date: '2026-04-01', currency: 'AED', tax_point: {date_of_supply:'2026-04-01', reporting_date:'2026-04-01', document_id:'doc', evidence_digest:'digest', actor_id:'member', authority_basis:'transaction_review_correction'}, account_type: 'revenue' },
    { journal_id: 'j1', line_no: 2, debit: 0, credit: 50, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
  ] });
  const prepared = await prepareAeVatReturnWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    periodKey: 'Apr-Jun 2026',
    vatRegistration: REGISTERED,
    aeEstablishment: { emirate: 'DXB' }
  });
  assert.deepEqual(prepared.vatReturn.fields.standard_rated_supplies.by_emirate.DXB, { amount: 1000, vat: 50 });
  assert.deepEqual(client.calls[0].params, ['firm-1', 'client-1']);
  assert.deepEqual(client.calls[1].params, ['firm-1', 'client-1', '2026-04-01', '2026-06-30']);
  assert.match(client.calls[1].sql, /lj\.status in \('posted', 'closed'\)/);
});

test('an unrecorded registration refuses before the ledger is read', async () => {
  const client = clientWith();
  await assert.rejects(
    prepareAeVatReturnWithClient({ client, firmId: 'f', clientId: 'c', periodKey: 'Apr-Jun 2026' }),
    (error) => error.code === 'AE_VAT_REGISTRATION_NOT_ESTABLISHED'
  );
  assert.equal(client.calls.length, 1, 'only the period read ran');
});

test('a not-registered client and a partial-period registration refuse by name', async () => {
  await assert.rejects(
    prepareAeVatReturnWithClient({
      client: clientWith(), firmId: 'f', clientId: 'c', periodKey: 'Apr-Jun 2026',
      vatRegistration: { status: 'not_registered' }
    }),
    (error) => error.code === 'AE_VAT_RETURN_NOT_REGISTERED_FOR_PERIOD'
  );
  await assert.rejects(
    prepareAeVatReturnWithClient({
      client: clientWith(), firmId: 'f', clientId: 'c', periodKey: 'Apr-Jun 2026',
      vatRegistration: { ...REGISTERED, registered_from: '2026-05-15' }
    }),
    (error) => error.code === 'AE_VAT_REGISTRATION_PARTIAL_PERIOD'
  );
});

test('the establishment fact flows from the profile record into the emirate split', async () => {
  const prepared = await prepareAeVatReturnWithClient({
    client: clientWith({ lines: [
      { journal_id: 'j1', line_no: 1, debit: 0, credit: 200, tax_type: 'AE_VAT_SR_5_OUTPUT', journal_date: '2026-04-01', currency: 'AED', tax_point: {date_of_supply:'2026-04-01', reporting_date:'2026-04-01', document_id:'doc', evidence_digest:'digest', actor_id:'member', authority_basis:'transaction_review_correction'}, account_type: 'revenue' },
      { journal_id: 'j1', line_no: 2, debit: 0, credit: 10, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
    ] }),
    firmId: 'f', clientId: 'c', periodKey: 'Apr-Jun 2026',
    vatRegistration: REGISTERED,
    aeEstablishment: { emirate: 'SHJ', qualifying_ecommerce_registrant: false }
  });
  assert.equal(prepared.vatReturn.fields.standard_rated_supplies.by_emirate.SHJ.amount, 200);
});

test('a recorded qualifying e-commerce registrant refuses through the route too', async () => {
  await assert.rejects(
    prepareAeVatReturnWithClient({
      client: clientWith(), firmId: 'f', clientId: 'c', periodKey: 'Apr-Jun 2026',
      vatRegistration: REGISTERED,
      aeEstablishment: { emirate: 'DXB', qualifying_ecommerce_registrant: true }
    }),
    (error) => error.code === 'AE_VAT_QUALIFYING_REGISTRANT_UNSUPPORTED'
  );
});

test('the owner rendering names the emirate, both honesty lines, and who files', async () => {
  const prepared = await prepareAeVatReturnWithClient({
    client: clientWith({ lines: [
      { journal_id: 'j1', line_no: 1, debit: 0, credit: 1000, tax_type: 'AE_VAT_SR_5_OUTPUT', journal_date: '2026-04-01', currency: 'AED', tax_point: {date_of_supply:'2026-04-01', reporting_date:'2026-04-01', document_id:'doc', evidence_digest:'digest', actor_id:'member', authority_basis:'transaction_review_correction'}, account_type: 'revenue' },
      { journal_id: 'j1', line_no: 2, debit: 0, credit: 50, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
    ] }),
    firmId: 'f', clientId: 'c', periodKey: 'Apr-Jun 2026',
    vatRegistration: REGISTERED,
    aeEstablishment: { emirate: 'DXB' }
  });
  const rendered = renderAeVatReturnForOwner(prepared);
  assert.match(rendered, /Standard-rated supplies — Dubai: AED 1000\.00 \(VAT AED 50\.00\)/);
  assert.match(rendered, /confirm the customs-populated figure in EmaraTax/);
  assert.match(rendered, /VAT due: AED 50\.00/);
  assert.match(rendered, /Due 2026-07-28 — you file this in EmaraTax/);
  assert.doesNotMatch(rendered, /Fujairah/, 'zero emirate rows are not rendered');
});

test('submission stops at the named accreditation boundary until a transport is injected', async () => {
  await assert.rejects(aeVatSubmissionTransportPendingAccreditation(), (error) => error.code === 'AE_VAT_FILING_CHANNEL_UNAVAILABLE');
  const prepared = await prepareAeVatReturnWithClient({
    client: clientWith(), firmId: 'f', clientId: 'c', periodKey: 'Apr-Jun 2026',
    vatRegistration: REGISTERED, aeEstablishment: { emirate: 'DXB' }
  });
  await assert.rejects(submitPreparedAeVatReturn({ prepared }), (error) => error.code === 'AE_VAT_FILING_CHANNEL_UNAVAILABLE');
  let received = null;
  await submitPreparedAeVatReturn({ prepared, transport: async (request) => { received = request; return { accepted: false }; } });
  assert.equal(received.prepared, prepared);
});

test('an unprepared envelope never reaches a transport', async () => {
  await assert.rejects(
    submitPreparedAeVatReturn({ prepared: { vatReturn: { fields: {} } }, transport: async () => ({}) }),
    (error) => error.code === 'AE_VAT_RETURN_NOT_PREPARED'
  );
});


test('standard journals without a proven statutory date or with a different allocation refuse',async()=>{
  for(const tax_point of [null,{document_id:'d',actor_id:'m',evidence_digest:'h',authority_basis:'transaction_review_correction',date_of_supply:'2026-03-31',reporting_date:'2026-04-01'}]){
    await assert.rejects(prepareAeVatReturnWithClient({client:clientWith({lines:[{journal_id:'j',line_no:1,credit:100,debit:0,tax_type:'AE_VAT_SR_5_OUTPUT',account_type:'revenue',currency:'AED',journal_date:'2026-04-01',tax_point}]}),
      firmId:'f',clientId:'c',periodKey:'Apr-Jun 2026',vatRegistration:REGISTERED,aeEstablishment:{emirate:'DXB'}}),{code:'AE_VAT_POSTED_TAX_POINT_UNSUPPORTED'});
  }
});
