// Authored tax-vocabulary unit tests — pin the gb/au/us treatment sets and the
// descriptor invariants every consumer routes on. Load-bearing properties:
//   - pure data: no DB, no LLM, no imports beyond the module itself
//   - the option lists cannot silently drift (byte-level pins — same posture
//     as the FI rate-table and SG-inline pins)
//   - each descriptor's unsureMarker / outOfScope are members of its options
//     (the sanitizer maps fallbacks onto them; a non-member would produce a
//     schema-invalid treatment)
//   - options identity: descriptor.options IS the exported array (transactionLlm
//     matches vocabularies by reference, the same way it recognises FI)

import test from 'node:test';
import assert from 'node:assert/strict';

import { TAX_VOCABULARY_REGISTRY, isUnsureTaxTreatment, unsureTaxTreatmentFor } from './taxVocabularyRegistry.js';
import { SG_CODING_POLICY } from './singapore/codingPolicy.js';
const TAX_TREATMENT_OPTIONS = SG_CODING_POLICY.taxTreatmentOptions;
const { marker: GB_VAT_TAX_VOCABULARY, options: GB_VAT_TAX_TREATMENT_OPTIONS } = TAX_VOCABULARY_REGISTRY.gb;
const { marker: AU_GST_TAX_VOCABULARY, options: AU_GST_TAX_TREATMENT_OPTIONS } = TAX_VOCABULARY_REGISTRY.au;
const { marker: US_SALES_TAX_VOCABULARY, options: US_SALES_TAX_TREATMENT_OPTIONS } = TAX_VOCABULARY_REGISTRY.us;
const { marker: AE_VAT_TAX_VOCABULARY, options: AE_VAT_TAX_TREATMENT_OPTIONS } = TAX_VOCABULARY_REGISTRY.ae;

// ─── byte-level pins (trip CI on any silent edit) ────────────────────────────

test('GB VAT treatment set is pinned', () => {
  // Re-pinned 2026-08-02 (deliberate): IV-2 adds the two purchase-side labels
  // that existed as posting codes with no expressible verdict — 'EU
  // acquisition' and 'VAT blocked (no reclaim)', the latter a pre-staging
  // requirement (design-donna-gb-input-vat-boxes-4-7.md §3).
  assert.deepEqual(GB_VAT_TAX_TREATMENT_OPTIONS, [
    'VAT 20%',
    'VAT 5%',
    'Zero-rated 0%',
    'VAT exempt',
    'Outside the scope of VAT',
    'Reverse charge',
    'EU acquisition',
    'VAT blocked (no reclaim)',
    'VAT check'
  ]);
});

test('AU GST treatment set is pinned', () => {
  assert.deepEqual(AU_GST_TAX_TREATMENT_OPTIONS, [
    'GST 10%',
    'GST Free',
    'Input Taxed',
    'BAS Excluded',
    'GST check'
  ]);
});

test('US sales-tax treatment set is pinned', () => {
  assert.deepEqual(US_SALES_TAX_TREATMENT_OPTIONS, [
    'No sales tax',
    'Sales tax collected',
    'Out of scope',
    'Sales tax check'
  ]);
});

test('AE VAT treatment set is pinned', () => {
  // Added 2026-08-30 (the UAE backend lane). Labels are deliberately worded
  // to stay disjoint from GB's VAT set — see the collision test below.
  assert.deepEqual(AE_VAT_TAX_TREATMENT_OPTIONS, [
    'VAT 5% (standard rated)',
    'Zero-rated supply',
    'Exempt supply',
    'Out of scope of UAE VAT',
    'Reverse charge (RCM)',
    'UAE VAT check'
  ]);
});

test('authored vocabulary identifiers remain stable without an engine routing-marker table', () => {
  assert.equal(GB_VAT_TAX_VOCABULARY, 'gb_vat');
  assert.equal(AU_GST_TAX_VOCABULARY, 'au_gst');
  assert.equal(US_SALES_TAX_VOCABULARY, 'us_sales_tax');
  assert.equal(AE_VAT_TAX_VOCABULARY, 'ae_vat');
});

// ─── descriptor invariants ───────────────────────────────────────────────────

test('every descriptor is internally consistent', () => {
  const expectedOptions = {
    gb_vat: GB_VAT_TAX_TREATMENT_OPTIONS,
    au_gst: AU_GST_TAX_TREATMENT_OPTIONS,
    us_sales_tax: US_SALES_TAX_TREATMENT_OPTIONS,
    ae_vat: AE_VAT_TAX_TREATMENT_OPTIONS
  };
  for (const country of ['gb', 'au', 'us', 'ae']) {
    const vocabulary = TAX_VOCABULARY_REGISTRY[country];
    const marker = vocabulary.marker;
    assert.equal(vocabulary.marker, marker, `${marker}: marker echoes the key`);
    assert.equal(vocabulary.options, expectedOptions[marker], `${marker}: options IS the exported array (identity)`);
    assert.ok(vocabulary.options.includes(vocabulary.unsureMarker), `${marker}: unsureMarker in options`);
    assert.ok(vocabulary.options.includes(vocabulary.outOfScope), `${marker}: outOfScope in options`);
    assert.equal(vocabulary.options[vocabulary.options.length - 1], vocabulary.unsureMarker,
      `${marker}: the unsure marker is the last option (the FI 'ALV-tarkistus' posture)`);
    assert.ok(vocabulary.instructionsNote.includes(`'${vocabulary.unsureMarker}'`),
      `${marker}: the prompt note teaches the unsure marker`);
    assert.equal(vocabulary.jurisdiction, country);
  }
});

test('no treatment label collides across the gb/au/us/ae/SG vocabularies (foreign stays foreign)', () => {
  // The tax gate classifies by set membership; a label shared between two
  // vocabularies would launder a cross-border bleed as valid. Two DELIBERATE
  // overlaps, both semantically identical concepts where a cross-border leak
  // is harmless: 'Out of scope' (US ∩ SG — the identical out-of-system
  // concept) and 'GST check' (AU ∩ SG — both are GST regimes and the label is
  // the unsure marker in each, which flags the line for review either way; a
  // rate-carrying bleed like 'GST 9%' on an au client is still caught).
  const sets = {
    gb: GB_VAT_TAX_TREATMENT_OPTIONS,
    au: AU_GST_TAX_TREATMENT_OPTIONS,
    us: US_SALES_TAX_TREATMENT_OPTIONS,
    ae: AE_VAT_TAX_TREATMENT_OPTIONS,
    sg: TAX_TREATMENT_OPTIONS
  };
  const allowedOverlap = new Set(['out of scope', 'gst check']);
  const keys = Object.keys(sets);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = new Set(sets[keys[i]].map((s) => s.toLowerCase()));
      const overlap = sets[keys[j]].map((s) => s.toLowerCase()).filter((s) => a.has(s) && !allowedOverlap.has(s));
      assert.deepEqual(overlap, [], `${keys[i]} ∩ ${keys[j]} shares labels: ${overlap.join(', ')}`);
    }
  }
});

test('RT-23: every registered vocabulary names its unsure marker, and the marker matcher folds case and spacing', () => {
  for (const [jurisdiction, entry] of Object.entries(TAX_VOCABULARY_REGISTRY)) {
    assert.ok(typeof entry.unsureMarker === 'string' && entry.unsureMarker.trim(), `${jurisdiction} names an unsure marker`);
    assert.ok(entry.options.includes(entry.unsureMarker), `${jurisdiction}: the marker is one of its own options`);
    assert.equal(unsureTaxTreatmentFor(jurisdiction), entry.unsureMarker);
    assert.equal(isUnsureTaxTreatment(jurisdiction, entry.unsureMarker), true);
    assert.equal(isUnsureTaxTreatment(jurisdiction, `  ${entry.unsureMarker.toUpperCase()}  `), true);
    assert.equal(isUnsureTaxTreatment(jurisdiction, ''), false);
  }
  assert.equal(unsureTaxTreatmentFor('fi'), 'ALV-tarkistus');
  assert.equal(unsureTaxTreatmentFor('zz'), null);
  assert.equal(isUnsureTaxTreatment(null, 'ALV-tarkistus'), false, 'no jurisdiction, no marker');
});
