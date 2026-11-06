// The UAE coding gold set — CI half (no network): the fixtures lint against
// the real AE palette + vocabulary, the scorer is exact on both MUST checks,
// and the stability summary fails a single flip.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AE_GOLD_CLIENT_PROFILE,
  CODING_GOLD_FIXTURES_AE,
  codingGoldSetAeLintErrors,
  meetsCodingGoldThresholds,
  scoreCodingGoldFixture,
  summarizeCodingGoldRuns
} from './codingGoldSetAe.js';
import { loadOutboundPack, fallbackAccountNamesForPack } from './outbound/packs.js';
import { AE_VAT_TAX_TREATMENT_OPTIONS } from './ae/taxVocabulary.js';
import { accountOptionsForClient, taxTreatmentOptionsForClient } from './transactionLlm.js';

const paletteNames = fallbackAccountNamesForPack(loadOutboundPack('ae'));
const byId = (id) => CODING_GOLD_FIXTURES_AE.find((f) => f.id === id);

test('every fixture names accounts the AE palette offers and treatments the AE vocabulary offers', () => {
  assert.deepEqual(codingGoldSetAeLintErrors({ paletteNames }), []);
  // The two accounts the review found missing from every pack now exist and
  // are what the goldset pins.
  assert.ok(paletteNames.includes('Repairs and maintenance'));
  assert.ok(paletteNames.includes('Fines and penalties'));
  assert.deepEqual(byId('ac_maintenance_repairs').expect.account_one_of, ['Repairs and maintenance']);
  assert.deepEqual(byId('fta_penalty_own_account').expect.account_one_of, ['Fines and penalties']);
});

test('the gold client profile routes the production coder to the AE palette and vocabulary', () => {
  // Same resolvers suggestTransactionCoding calls — so the runner's enum IS the
  // production enum for a routed AE client.
  const accounts = accountOptionsForClient([], AE_GOLD_CLIENT_PROFILE);
  assert.deepEqual(accounts, paletteNames);
  assert.deepEqual(taxTreatmentOptionsForClient(AE_GOLD_CLIENT_PROFILE), AE_VAT_TAX_TREATMENT_OPTIONS);
});

test('lint catches an expectation the coder could never emit', () => {
  const errors = codingGoldSetAeLintErrors({ paletteNames: ['Rent'] });
  assert.ok(errors.some((e) => e.includes('is not in the AE palette')));
});

test('scorer: both checks are MUST and exact', () => {
  const f = byId('nol_topup_exempt');
  const good = scoreCodingGoldFixture({ suggestion: { proposed_account: 'Travel', tax_treatment: 'Exempt supply', model: 'gpt-5.4', confidence: 'high' }, fixture: f });
  assert.equal(good.pass, true);
  const feb = scoreCodingGoldFixture({ suggestion: { proposed_account: 'Travel', tax_treatment: 'VAT 5% (standard rated)' }, fixture: f });
  assert.equal(feb.pass, false);
  assert.equal(feb.checks.account.pass, true);
  assert.equal(feb.checks.tax.pass, false);
  const wrongAccount = scoreCodingGoldFixture({ suggestion: { proposed_account: 'Utilities', tax_treatment: 'Exempt supply' }, fixture: f });
  assert.equal(wrongAccount.pass, false);
  const missing = scoreCodingGoldFixture({ suggestion: null, fixture: f });
  assert.equal(missing.pass, false);
  assert.equal(missing.checks.account.actual, '');
});

test('stability: a single flip across K runs fails the fixture and the gate; a clean K passes', () => {
  const nol = byId('nol_topup_exempt');
  const ac = byId('ac_maintenance_repairs');
  const run = (f, account, tax) => scoreCodingGoldFixture({ suggestion: { proposed_account: account, tax_treatment: tax, model: 'gpt-5.4' }, fixture: f });
  const flippy = summarizeCodingGoldRuns([
    run(nol, 'Travel', 'Exempt supply'),
    run(nol, 'Travel', 'Exempt supply'),
    run(nol, 'Travel', 'VAT 5% (standard rated)'),
    run(ac, 'Repairs and maintenance', 'VAT 5% (standard rated)'),
    run(ac, 'Repairs and maintenance', 'VAT 5% (standard rated)'),
    run(ac, 'Repairs and maintenance', 'VAT 5% (standard rated)')
  ]);
  const nolRow = flippy.fixtures.find((x) => x.fixture_id === 'nol_topup_exempt');
  assert.equal(nolRow.pass, false);
  assert.equal(nolRow.stable, false);
  assert.equal(nolRow.pass_rate, 2 / 3);
  assert.deepEqual(flippy.failing_fixtures, ['nol_topup_exempt']);
  assert.deepEqual(flippy.unstable_fixtures, ['nol_topup_exempt']);
  assert.equal(meetsCodingGoldThresholds(flippy), false);

  const clean = summarizeCodingGoldRuns([
    run(nol, 'Travel', 'Exempt supply'),
    run(nol, 'Motor expenses', 'Exempt supply'),
    run(ac, 'Repairs and maintenance', 'VAT 5% (standard rated)')
  ]);
  // Two different allowed accounts on the same treatment is a flip, not a pass:
  // the gate is zero flips.
  assert.equal(meetsCodingGoldThresholds(clean), false);
  assert.deepEqual(clean.unstable_fixtures, ['nol_topup_exempt']);
  const steady = summarizeCodingGoldRuns([
    run(nol, 'Travel', 'Exempt supply'),
    run(nol, 'Travel', 'Exempt supply'),
    run(ac, 'Repairs and maintenance', 'VAT 5% (standard rated)')
  ]);
  assert.equal(meetsCodingGoldThresholds(steady), true);
  assert.deepEqual(steady.models, ['gpt-5.4']);
});

test('the gate refuses a run that cannot prove one model id', () => {
  const f = byId('rent_standard_rated');
  const noModel = summarizeCodingGoldRuns([scoreCodingGoldFixture({ suggestion: { proposed_account: 'Rent', tax_treatment: 'VAT 5% (standard rated)' }, fixture: f })]);
  assert.equal(noModel.fixtures[0].pass, true);
  assert.equal(meetsCodingGoldThresholds(noModel), false);
  const twoModels = summarizeCodingGoldRuns([
    scoreCodingGoldFixture({ suggestion: { proposed_account: 'Rent', tax_treatment: 'VAT 5% (standard rated)', model: 'a' }, fixture: f }),
    scoreCodingGoldFixture({ suggestion: { proposed_account: 'Rent', tax_treatment: 'VAT 5% (standard rated)', model: 'b' }, fixture: f })
  ]);
  assert.equal(meetsCodingGoldThresholds(twoModels), false);
});
