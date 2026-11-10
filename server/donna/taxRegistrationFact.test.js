// The registration fact the coder is told (transactionLlm.js
// taxRegistrationFactFor): read with the country's own reader on the date
// that governs the line, worded and offered by the country's declaration.
// Synthetic data only.
//   node --test server/donna/taxRegistrationFact.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { taxRegistrationFactFor } from './transactionLlm.js';
import { FI_ALV_TAX_TREATMENT_OPTIONS } from './finland/alvCodes.js';
import { GB_VAT_TAX_TREATMENT_OPTIONS } from './gb/taxVocabulary.js';

const fi = { jurisdiction: 'fi', taxTreatmentOptions: FI_ALV_TAX_TREATMENT_OPTIONS };
const gb = { jurisdiction: 'gb', taxTreatmentOptions: GB_VAT_TAX_TREATMENT_OPTIONS };
const line = (date, extra = {}) => ({ id: 'line', date, money_out: 125.5, ...extra });

test('registered, not registered or unknown on the line date, with the reason the reader gives', () => {
  const profile = { alv_registration: { status: 'registered', registered_from: '2026-03-01' } };
  assert.deepEqual(taxRegistrationFactFor({ policy: fi, clientProfile: profile, transaction: line('2026-03-01') }),
    { status: 'registered', on_date: '2026-03-01', reason: 'registered' });
  assert.deepEqual(taxRegistrationFactFor({ policy: fi, clientProfile: {}, transaction: line('2026-03-01') }),
    { status: 'unknown', on_date: '2026-03-01', reason: 'no_record' });
  const before = taxRegistrationFactFor({ policy: fi, clientProfile: profile, transaction: line('2026-02-28') });
  assert.deepEqual([before.status, before.reason], ['not_registered', 'not_yet_effective']);
  assert.deepEqual(before.treatments, { purchase: 'Vähennyskelvoton ALV (osto)', sale: 'Ei ALV-käsittelyä' });
  assert.match(before.instruction, /not in the Finnish VAT register .* on 2026-02-28.*Use tax_treatment 'Vähennyskelvoton ALV \(osto\)' for a purchase/);
});

test('a line settling a supplier bill is read on the bill date', () => {
  const profile = { alv_registration: { status: 'registered', registered_from: '2026-03-01' } };
  const fact = taxRegistrationFactFor({ policy: fi, clientProfile: profile,
    transaction: line('2026-06-02', { matched_document: { document_type: 'supplier_bill', document_date: '2026-02-10' } }) });
  assert.deepEqual([fact.status, fact.on_date, fact.date_of], ['not_registered', '2026-02-10', 'supplier_bill']);
  const receipt = taxRegistrationFactFor({ policy: fi, clientProfile: profile,
    transaction: line('2026-06-02', { matched_document: { document_type: 'receipt', document_date: '2026-02-10' } }) });
  assert.deepEqual([receipt.status, receipt.on_date], ['registered', '2026-06-02']);
});

test('the treatments are offered only when the vocabulary has them; a country without a record gets no field', () => {
  const notRegistered = { alv_registration: { status: 'not_registered' } };
  const bare = taxRegistrationFactFor({ policy: { jurisdiction: 'fi', taxTreatmentOptions: ['ALV 25,5 %'] }, clientProfile: notRegistered, transaction: line('2026-06-02') });
  assert.equal(bare.status, 'not_registered');
  assert.equal(bare.treatments, undefined);
  assert.doesNotMatch(bare.instruction, /Use tax_treatment/);
  const uk = taxRegistrationFactFor({ policy: gb, clientProfile: { vat_registration: { status: 'not_registered' } }, transaction: line('2026-06-02') });
  assert.deepEqual(uk.treatments, { purchase: 'No VAT (not VAT-registered)', sale: 'No VAT (not VAT-registered)' });
  assert.equal(taxRegistrationFactFor({ policy: { jurisdiction: 'sg', taxTreatmentOptions: [] }, clientProfile: {}, transaction: line('2026-06-02') }), null);
});
