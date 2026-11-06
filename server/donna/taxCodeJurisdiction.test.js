// Donna Keep-layer — tax-code ↔ jurisdiction validity registry unit tests.
// Load-bearing properties:
//   - pure: no DB, no LLM, no external calls
//   - membership only (validity), never treatment
//   - undecidable (omit) when there is no code or no registered jurisdiction —
//     an unregistered jurisdiction is NOT validated against another's codes
//   - the inlined SG set + jurisdiction alias cannot drift from their sources

import test from 'node:test';
import { classifyTaxCodeForPolicy } from './taxCodeJurisdiction.js';
import assert from 'node:assert/strict';

test('policy-owned labels extend apply validation without a country branch', () => {
  const fixture = { status: 'resolved', jurisdiction: 'zz', taxTreatmentOptions: ['Fixture exempt'] };
  assert.equal(classifyTaxCodeForPolicy(fixture, 'Fixture exempt'), 'valid');
  assert.equal(classifyTaxCodeForPolicy(fixture, 'GST 9%'), 'foreign');
  assert.equal(classifyTaxCodeForPolicy(null, 'GST 9%'), 'undecidable');
  assert.equal(classifyTaxCodeForPolicy({ ...fixture, jurisdiction: 'fi' }, 'ALV_25_5_OUTPUT'), 'valid');
  assert.equal(classifyTaxCodeForPolicy({ ...fixture, jurisdiction: 'fi' }, 'ALV 25,5 %'), 'foreign', 'old labels outside the current policy are not a second allowed menu');
});

import {
  normalizeJurisdictionKey,
  jurisdictionVocabulary,
  classifyTaxCodeForJurisdiction,
  JURISDICTION_TAX_VOCABULARY,
  KNOWN_TAX_CODE_JURISDICTIONS
} from './taxCodeJurisdiction.js';
import { SG_CODING_POLICY } from './singapore/codingPolicy.js';
const TAX_TREATMENT_OPTIONS = SG_CODING_POLICY.taxTreatmentOptions;
import { KNOWN_ALV_CODES, FI_ALV_TAX_TREATMENT_OPTIONS } from './finland/alvCodes.js';
import { GB_VAT_TAX_TREATMENT_OPTIONS } from './gb/taxVocabulary.js';
import { AU_GST_TAX_TREATMENT_OPTIONS } from './au/taxVocabulary.js';
import { US_SALES_TAX_TREATMENT_OPTIONS } from './us/taxVocabulary.js';
import { __SCHEMA__ } from './clientProfileSchema.js';

// ─── normalizeJurisdictionKey — mirrors the stored canonical form ────────────

test('normalizeJurisdictionKey: lowercases, aliases uk→gb, nulls the undecidable', () => {
  assert.equal(normalizeJurisdictionKey('SG'), 'sg');
  assert.equal(normalizeJurisdictionKey(' fi '), 'fi');
  assert.equal(normalizeJurisdictionKey('UK'), 'gb', 'uk is stored as gb');
  assert.equal(normalizeJurisdictionKey('gb'), 'gb');
  assert.equal(normalizeJurisdictionKey('unknown'), null);
  assert.equal(normalizeJurisdictionKey(''), null);
  assert.equal(normalizeJurisdictionKey(null), null);
  assert.equal(normalizeJurisdictionKey('singapore'), null, 'not a 2-letter code → undecidable');
  assert.equal(normalizeJurisdictionKey(42), null);
});

test('the jurisdiction alias mirrors clientProfileSchema (no drift)', () => {
  // The registry inlines { uk: gb }; assert it matches the storage source of truth.
  assert.deepEqual(__SCHEMA__.JURISDICTION_ALIAS, { uk: 'gb' });
});

// ─── registry contents + drift pins ─────────────────────────────────────────

test('registry covers every ICP jurisdiction (fi, sg, gb, au, us) and nothing else', () => {
  assert.deepEqual([...KNOWN_TAX_CODE_JURISDICTIONS].sort(), ['ae', 'au', 'fi', 'gb', 'sg', 'us']);
  // Non-ICP jurisdictions stay deliberately absent (undecidable → omit).
  for (const gap of ['de', 'nz', 'fr']) {
    assert.ok(!(gap in JURISDICTION_TAX_VOCABULARY), `${gap} has no registered vocabulary`);
  }
});

test('gb/au/us vocabulary registry entries match their country definitions', () => {
  assert.deepEqual(JURISDICTION_TAX_VOCABULARY.gb.codes, GB_VAT_TAX_TREATMENT_OPTIONS);
  assert.deepEqual(JURISDICTION_TAX_VOCABULARY.au.codes, AU_GST_TAX_TREATMENT_OPTIONS);
  assert.deepEqual(JURISDICTION_TAX_VOCABULARY.us.codes, US_SALES_TAX_TREATMENT_OPTIONS);
});

test('SG vocabulary: the legacy prefix is byte-identical to transactionLlm TAX_TREATMENT_OPTIONS (no drift), widened by the vertical', () => {
  // The SG vertical widened the vocabulary (machine codes + rich treatments),
  // but the LEGACY simple set — what every pre-vertical SG book carries — must
  // stay byte-identical as the leading prefix, pinned against transactionLlm.
  assert.deepEqual(JURISDICTION_TAX_VOCABULARY.sg.codes.slice(0, TAX_TREATMENT_OPTIONS.length), TAX_TREATMENT_OPTIONS);
});

test('SG vocabulary carries both the vertical machine codes and the rich treatment labels', async () => {
  const { KNOWN_SG_GST_CODES, SG_GST_TAX_TREATMENT_OPTIONS } = await import('./singapore/gstCodes.js');
  const sg = JURISDICTION_TAX_VOCABULARY.sg.codes;
  for (const code of KNOWN_SG_GST_CODES) assert.ok(sg.includes(code), `machine code ${code}`);
  for (const label of SG_GST_TAX_TREATMENT_OPTIONS) assert.ok(sg.includes(label), `treatment ${label}`);
  assert.equal(classifyTaxCodeForJurisdiction('GST_SR_9_OUTPUT', 'sg'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('GST_SR_9_OUTPUT', 'fi'), 'foreign', 'an SG machine code is still a leak on a Finnish line');
});

test('FI vocabulary carries both the machine codes and the treatment labels', () => {
  const fi = JURISDICTION_TAX_VOCABULARY.fi.codes;
  for (const code of KNOWN_ALV_CODES) assert.ok(fi.includes(code), `machine code ${code}`);
  for (const label of FI_ALV_TAX_TREATMENT_OPTIONS) assert.ok(fi.includes(label), `treatment ${label}`);
});

// ─── classifyTaxCodeForJurisdiction — the structural verdict ─────────────────

test('valid: a code from the jurisdiction vocabulary', () => {
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', 'sg'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('GST check', 'sg'), 'valid', 'the unsure sentinel is a valid SG code');
  assert.equal(classifyTaxCodeForJurisdiction('ALV 25,5 %', 'fi'), 'valid', 'FI treatment label');
  assert.equal(classifyTaxCodeForJurisdiction('ALV_25_5_OUTPUT', 'fi'), 'valid', 'FI machine code');
  assert.equal(classifyTaxCodeForJurisdiction('ALV-tarkistus', 'fi'), 'valid', 'FI unsure marker');
});

test('valid: membership is case- and whitespace-insensitive', () => {
  assert.equal(classifyTaxCodeForJurisdiction('gst 9%', 'SG'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('  GST   9%  ', 'sg'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('alv_25_5_output', 'fi'), 'valid');
});

test('foreign: a code from the WRONG country (the leak the gate catches)', () => {
  // Failure-A class: an SG GST code leaking onto a Finnish client's line.
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', 'fi'), 'foreign');
  // And the reverse: a Finnish ALV code on a Singapore client.
  assert.equal(classifyTaxCodeForJurisdiction('ALV 25,5 %', 'sg'), 'foreign');
  assert.equal(classifyTaxCodeForJurisdiction('ALV_25_5_OUTPUT', 'sg'), 'foreign');
  // A UK VAT code is foreign to SG too.
  assert.equal(classifyTaxCodeForJurisdiction('VAT 20%', 'sg'), 'foreign');
  // 2026-07-23, the closed coverage gap: SG's vocabulary leaking onto a
  // gb/au/us client — the bleed the gap used to launder as undecidable — is
  // now affirmatively foreign. (See the sequencing rule in the module header:
  // in shadow these are TRUE positives that burn down via the
  // JURISDICTION_TAX_CODING rollout.)
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', 'gb'), 'foreign');
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', 'us'), 'foreign');
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', 'au'), 'foreign');
  // And cross-anglosphere bleeds are caught too (au's 'GST 10%' shares no
  // label with gb/us).
  assert.equal(classifyTaxCodeForJurisdiction('GST 10%', 'gb'), 'foreign');
  assert.equal(classifyTaxCodeForJurisdiction('VAT 20%', 'au'), 'foreign');
});

test('valid: the gb/au/us vocabularies validate their own treatments', () => {
  assert.equal(classifyTaxCodeForJurisdiction('VAT 20%', 'gb'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('VAT 20%', 'UK'), 'valid', 'uk aliases to gb');
  assert.equal(classifyTaxCodeForJurisdiction('VAT check', 'gb'), 'valid', 'the gb unsure marker');
  assert.equal(classifyTaxCodeForJurisdiction('GST 10%', 'au'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('BAS Excluded', 'au'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('No sales tax', 'us'), 'valid');
  assert.equal(classifyTaxCodeForJurisdiction('sales   tax check', 'us'), 'valid', 'whitespace/case-insensitive');
});

test('undecidable: no code, or an unregistered jurisdiction, → omit (never cross-validate)', () => {
  // No code to check.
  assert.equal(classifyTaxCodeForJurisdiction(null, 'sg'), 'undecidable');
  assert.equal(classifyTaxCodeForJurisdiction('', 'sg'), 'undecidable');
  assert.equal(classifyTaxCodeForJurisdiction('   ', 'sg'), 'undecidable');
  // Registered code, but an unregistered (non-ICP) jurisdiction: a German
  // line is NOT validated against another country's codes — it is undecidable.
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', 'de'), 'undecidable');
  assert.equal(classifyTaxCodeForJurisdiction('VAT 20%', 'nz'), 'undecidable');
  // No jurisdiction at all.
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', null), 'undecidable');
  assert.equal(classifyTaxCodeForJurisdiction('GST 9%', 'unknown'), 'undecidable');
});

test('jurisdictionVocabulary: entry for a registered jurisdiction, null otherwise', () => {
  assert.equal(jurisdictionVocabulary('sg').label, 'Singapore GST');
  assert.equal(jurisdictionVocabulary('FI').label, 'Finland ALV (VAT)');
  assert.equal(jurisdictionVocabulary('gb').label, 'United Kingdom VAT');
  assert.equal(jurisdictionVocabulary('au').label, 'Australia GST');
  assert.equal(jurisdictionVocabulary('us').label, 'United States sales tax');
  assert.equal(jurisdictionVocabulary('de'), null);
  assert.equal(jurisdictionVocabulary(null), null);
});
