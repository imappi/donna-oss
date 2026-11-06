// SG-2 — the GST vocabulary: rate eras, box-mapped codes, the resolver's
// render-not-decide precedence, the split convention.
// node --test server/donna/singapore/gstCodes.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SG_STANDARD_RATE,
  SG_GST_RATES_BY_ERA,
  sgGstRateForDate,
  SINGAPORE_GST_CODING_FLAG_KEY,
  SG_GST_TAX_VOCABULARY,
  SG_GST_TAX_TREATMENT_OPTIONS,
  SG_GST_CODES,
  GST_F5_BOXES,
  GST_F5_BOX_PROVENANCE,
  GST_SUPPLY_BOXES_IN_4,
  KNOWN_SG_GST_CODES,
  resolveGstEntry,
  gstOutputCodeForRate,
  resolveGstCode,
  gstDirectionForTransaction,
  applyGstCodingToCoding,
  GST_SPLIT_CONTROL,
  SINGAPORE_GST_SETTLEMENT_ACCOUNT,
  withSingaporeGstSettlementAccount,
  splitGstGross,
  resolveGstSplitForPosting
} from './gstCodes.js';

test('the rate-era pin: 8% in 2023, 9% from 2024 — a silent edit trips here', () => {
  assert.equal(SG_STANDARD_RATE, 9);
  assert.deepEqual(Object.keys(SG_GST_RATES_BY_ERA).sort(), ['2023-01-01', '2024-01-01']);
  assert.equal(SG_GST_RATES_BY_ERA['2023-01-01'].standard, 8);
  assert.equal(SG_GST_RATES_BY_ERA['2024-01-01'].standard, 9);
  assert.equal(sgGstRateForDate('2023-06-15').standard, 8);
  assert.equal(sgGstRateForDate('2024-01-01').standard, 9);
  assert.equal(sgGstRateForDate('2026-07-23').standard, 9);
  assert.equal(sgGstRateForDate('2022-12-31').exact, false, 'the pre-2023 7% era is out of vocabulary');
  assert.equal(sgGstRateForDate(null).standard, 9, 'no date resolves to current law, inexact');
  assert.equal(sgGstRateForDate(null).exact, false);
  // SG-2: read section 16 and IRAS live on 2026-09-24.
  for (const era of Object.values(SG_GST_RATES_BY_ERA)) {
    assert.equal(era.confirmedAgainstPrimary, true);
    assert.ok(era.source.length > 20);
    assert.equal(era.as_of, '2026-09-24');
    assert.equal(era.url, 'https://sso.agc.gov.sg/Act/GSTA1993#pr16-');
    assert.ok(era.quote && era.title);
  }
});

test('the flag + vocabulary constants are the config-plane names', () => {
  assert.equal(SINGAPORE_GST_CODING_FLAG_KEY, 'SINGAPORE_GST_CODING');
  assert.equal(SG_GST_TAX_VOCABULARY, 'sg_gst');
  // The legacy simple labels stay in the rich vocabulary for continuity.
  for (const legacy of ['GST 9%', 'No GST (supplier not registered)', 'Out of scope', 'GST check']) {
    assert.ok(SG_GST_TAX_TREATMENT_OPTIONS.includes(legacy), `${legacy} present`);
  }
});

test('every code with return boxes points at known F5 boxes; box roles are coherent', () => {
  for (const entry of SG_GST_CODES) {
    assert.ok(['out', 'in', 'both'].includes(entry.direction), `${entry.code} direction`);
    if (!entry.return_boxes) continue;
    for (const [role, box] of Object.entries(entry.return_boxes)) {
      for (const number of Array.isArray(box) ? box : [box]) {
        assert.ok(GST_F5_BOXES[number], `${entry.code} ${role} box ${number} exists`);
      }
    }
  }
  assert.deepEqual([...GST_SUPPLY_BOXES_IN_4], ['1', '2', '3']);
  assert.equal(GST_F5_BOXES['8'].role, 'net');
  assert.equal(GST_F5_BOXES['13'].role, 'revenue');
  assert.equal(GST_F5_BOX_PROVENANCE.confirmedAgainstPrimary, true, 'represented numeric map confirmed in SG-2');
});

test('resolveGstCode: explicit code wins; prose renders; unsure/unknown map to nothing', () => {
  assert.equal(resolveGstCode({ taxType: 'GST_ZR_OUTPUT' }), 'GST_ZR_OUTPUT', 'explicit real code honoured');
  assert.equal(resolveGstCode({ taxType: 'gst_zr_output' }), 'GST_ZR_OUTPUT', 'case tolerant');
  // The legacy default treatment resolves with direction.
  assert.equal(resolveGstCode({ taxTreatment: 'GST 9%', direction: 'out' }), 'GST_SR_9_OUTPUT');
  assert.equal(resolveGstCode({ taxTreatment: 'GST 9%', direction: 'in' }), 'GST_SR_9_INPUT');
  assert.equal(resolveGstCode({ taxTreatment: 'GST 9%' }), '', 'unknown direction never guesses a side');
  assert.equal(resolveGstCode({ taxTreatment: 'GST 8%', direction: 'out' }), 'GST_SR_8_OUTPUT');
  // Kind-carrying prose.
  assert.equal(resolveGstCode({ taxTreatment: 'Zero-rated (export / international services)', direction: 'out' }), 'GST_ZR_OUTPUT');
  assert.equal(resolveGstCode({ taxTreatment: 'Exempt supply', direction: 'out' }), 'GST_EXEMPT_OUTPUT');
  assert.equal(resolveGstCode({ taxTreatment: 'Imported services (reverse charge)', direction: 'in' }), 'GST_RC_IMPORTED_SERVICES');
  assert.equal(resolveGstCode({ taxTreatment: 'Import under MES / approved scheme', direction: 'in' }), 'GST_IMPORT_MES');
  assert.equal(resolveGstCode({ taxTreatment: 'Import of goods (GST paid at import)', direction: 'in' }), 'GST_IMPORT_TAXABLE');
  assert.equal(resolveGstCode({ taxTreatment: 'No GST (supplier not registered)', direction: 'in' }), 'GST_NO_GST_INPUT');
  assert.equal(resolveGstCode({ taxTreatment: 'Out of scope' }), 'GST_OUT_OF_SCOPE');
  // The unsure marker and unknown prose resolve to NOTHING (uncoded → blocker).
  assert.equal(resolveGstCode({ taxTreatment: 'GST check', direction: 'out' }), '');
  assert.equal(resolveGstCode({ taxTreatment: 'standard' }), '');
  assert.equal(resolveGstCode({}), '');
  assert.ok(KNOWN_SG_GST_CODES.has('GST_SR_9_OUTPUT'));
});

test('gstOutputCodeForRate + direction reader', () => {
  assert.equal(gstOutputCodeForRate(9), 'GST_SR_9_OUTPUT');
  assert.equal(gstOutputCodeForRate(8), 'GST_SR_8_OUTPUT');
  assert.equal(gstOutputCodeForRate(0), 'GST_ZR_OUTPUT', 'a zero-rated supply is reported, never uncoded');
  assert.equal(gstOutputCodeForRate(7), null, 'the 2022 rate is out of vocabulary');
  assert.equal(gstDirectionForTransaction({ money_in: 100 }), 'out');
  assert.equal(gstDirectionForTransaction({ money_out: 50 }), 'in');
  assert.equal(gstDirectionForTransaction({}), '');
});

test('applyGstCodingToCoding stamps the resolved code; control-account targets get NONE; unresolvable is untouched', () => {
  const enriched = applyGstCodingToCoding({
    coding: { tax_treatment: 'GST 9%', account_code: '7000' },
    transaction: { money_out: 109 }
  });
  assert.equal(enriched.tax_type, 'GST_SR_9_INPUT');
  assert.equal(enriched.xero_tax_type, 'GST_SR_9_INPUT');
  assert.equal(enriched.tax_treatment, 'Standard-rated purchase 9%', 'label reflects what is actually posted');

  const control = applyGstCodingToCoding({
    coding: { tax_treatment: 'GST 9%', account_code: '2950' },
    transaction: { money_out: 109 }
  });
  assert.equal(control.tax_type, 'NONE', 'a GST code never rests on a control account');

  const unsure = applyGstCodingToCoding({
    coding: { tax_treatment: 'GST check', account_code: '7000' },
    transaction: { money_out: 109 }
  });
  assert.equal(unsure.tax_type, undefined, 'unresolvable verdict leaves the coding untouched');
});

test('the split convention: standard-rated only, net+gst==gross by construction, control roles attached', () => {
  const split = splitGstGross({ gross: 109, code: 'GST_SR_9_INPUT' });
  assert.equal(split.net, 100);
  assert.equal(split.gst, 9);
  assert.equal(split.net + split.gst, split.gross);
  assert.equal(split.role, 'gst_input_claimable');
  assert.equal(split.controlAccount.code, '2951');

  const out = splitGstGross({ gross: 109, code: 'GST_SR_9_OUTPUT' });
  assert.equal(out.role, 'gst_output');
  assert.equal(out.controlAccount.code, '2950');

  // Rounding-cent absorption on an awkward gross.
  const awkward = splitGstGross({ gross: 100.01, code: 'GST_SR_9_OUTPUT' });
  assert.equal(Math.round((awkward.net + awkward.gst) * 100) / 100, 100.01);

  // Non-splitting kinds return null (the amount IS the base).
  assert.equal(splitGstGross({ gross: 100, code: 'GST_ZR_OUTPUT' }), null);
  assert.equal(splitGstGross({ gross: 100, code: 'GST_RC_IMPORTED_SERVICES' }), null, 'RC is billed net — no split in v1');
  assert.equal(splitGstGross({ gross: 100, code: 'GST_IMPORT_MES' }), null);
  assert.equal(splitGstGross({ gross: 0.02, code: 'GST_SR_9_OUTPUT' }), null, 'cent-level gross posts unsplit');
  assert.equal(splitGstGross({ gross: -10, code: 'GST_SR_9_OUTPUT' }), null);
});

test('resolveGstSplitForPosting splits only a resolved code whose direction matches the transaction', () => {
  const split = resolveGstSplitForPosting({
    coding: { xero_tax_type: 'GST_SR_9_INPUT' },
    transaction: { money_out: 109 }
  });
  assert.equal(split.gst, 9);
  assert.equal(resolveGstSplitForPosting({
    coding: { xero_tax_type: 'GST_SR_9_INPUT' },
    transaction: { money_in: 109 }
  }), null, 'mismatched side posts unsplit — never a guessed control leg');
  assert.equal(resolveGstSplitForPosting({
    coding: { tax_treatment: 'GST 9%' },
    transaction: { money_out: 109 }
  }), null, 'an unresolved treatment never splits (only applyGstCodingToCoding mints codes)');
});

test('the settlement-account union: present → untouched; name-only → code backfilled; absent → appended', () => {
  assert.equal(SINGAPORE_GST_SETTLEMENT_ACCOUNT.code, '2950');
  assert.deepEqual(GST_SPLIT_CONTROL.out.account.code, '2950');

  const present = [{ code: '2950', name: 'GST output tax payable' }];
  assert.equal(withSingaporeGstSettlementAccount(present), present, 'already present → same array');

  const nameOnly = withSingaporeGstSettlementAccount([{ name: 'GST output tax payable' }]);
  assert.equal(nameOnly[0].code, '2950', 'code-less historical row gets the canonical code in-memory');

  const appended = withSingaporeGstSettlementAccount([{ code: '1910', name: 'Bank account' }]);
  assert.equal(appended.length, 2);
  assert.equal(appended[1].code, '2950');
  assert.equal(appended[1].source, 'singapore_sfrs_chart');
});

// SG-2: a confirmation is evidence for a named value, not a bare boolean.
test('every confirmed Singapore record has dated primary-source provenance', async () => {
  const paths = ['./gstCodes.js', './gstRegistrationThreshold.js', './corporateTax.js',
    './acraAnnualReturn.js', './pdpa.js', './entity.js', './csKnowledge.js', './iras/submitGstF5.js'];
  const visited = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value.confirmedAgainstPrimary === true || value.confirmed_content === true) {
      assert.match(value.url, /^https:\/\/(?:www\.)?(?:iras|acra|cpf|pdpc)\.gov\.sg\/|^https:\/\/sso\.agc\.gov\.sg\//);
      assert.equal(value.as_of, '2026-09-24');
      assert.ok(typeof value.title === 'string' && value.title.length > 0);
      assert.ok(typeof value.quote === 'string' && value.quote.length > 0);
    }
    for (const child of Object.values(value)) walk(child);
  };
  for (const path of paths) walk(await import(path));
});
