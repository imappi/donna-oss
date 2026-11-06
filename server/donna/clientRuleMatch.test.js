import assert from 'node:assert/strict';
import test from 'node:test';

import { clientRuleMatchFor } from './transactionIntel.js';

const makeRule = (patternText, accountCode, overrides = {}) => ({
  id: `rule-${patternText}-${accountCode}`,
  firm_id: 'test-firm',
  client_id: 'test-client',
  rule_type: 'merchant_category',
  pattern_text: patternText,
  category_override: null,
  account_code: accountCode,
  status: 'active',
  payload: {
    merchant_pattern: patternText,
    confidence: 0.92,
    label: `${patternText} -> ${accountCode}`,
    ...overrides
  }
});

const makeTx = (description, raw_description = '') => ({
  description,
  raw_description,
  contact: '',
  source_line: ''
});

test('clientRuleMatchFor: exact canonical match', () => {
  const rules = [makeRule('dadant', '5200')];
  const tx = makeTx('DADANT COM A5B38UG59');
  const match = clientRuleMatchFor(tx, rules);
  assert.ok(match, 'should match Dadant');
  assert.equal(match.account_code, '5200');
  assert.equal(match.id, 'rule-dadant-5200');
});

test('clientRuleMatchFor: canonical pattern from bank description', () => {
  const rules = [makeRule('mannlakeltd', '5200')];
  const tx = makeTx('MANNLAKELTD COM 0D0CTBVC');
  const match = clientRuleMatchFor(tx, rules);
  assert.ok(match, 'should match mannlakeltd canonical pattern');
  assert.equal(match.account_code, '5200');
});

test('clientRuleMatchFor: no match returns null', () => {
  const rules = [makeRule('dadant', '5200')];
  const tx = makeTx('CHEVRON GAS STATION #1234');
  const match = clientRuleMatchFor(tx, rules);
  assert.equal(match, null, 'should not match unrelated vendor');
});

test('clientRuleMatchFor: longest pattern wins', () => {
  const rules = [
    makeRule('shell', '5100'),
    makeRule('shell gas', '5200')
  ];
  const tx = makeTx('SHELL GAS STATION CEDAR PARK');
  const match = clientRuleMatchFor(tx, rules);
  assert.ok(match);
  assert.equal(match.account_code, '5200', 'longer pattern should win');
});

test('clientRuleMatchFor: inactive rules skipped', () => {
  const rules = [{ ...makeRule('dadant', '5200'), status: 'inactive' }];
  const tx = makeTx('DADANT COM A5B38UG59');
  const match = clientRuleMatchFor(tx, rules);
  assert.equal(match, null, 'inactive rule should not match');
});

test('clientRuleMatchFor: a proposed or retired rule is never authority (DMEM-R1 W1, INV-02); a status-less rule still matches', () => {
  const tx = makeTx('DADANT COM A5B38UG59');
  assert.equal(clientRuleMatchFor(tx, [{ ...makeRule('dadant', '5200'), status: 'proposed' }]), null, 'a model-proposed rule is not applied until governed');
  assert.equal(clientRuleMatchFor(tx, [{ ...makeRule('dadant', '5200'), status: 'retired' }]), null, 'a retired rule is not applied');
  assert.ok(clientRuleMatchFor(tx, [{ ...makeRule('dadant', '5200'), status: 'active' }]), 'an active rule matches');
  const statusless = { ...makeRule('dadant', '5200') };
  delete statusless.status;
  assert.ok(clientRuleMatchFor(tx, [statusless]), 'a rule with no status (the FE local list) keeps matching');
});

test('clientRuleMatchFor: pattern too short (<3 chars) skipped', () => {
  const rules = [makeRule('bp', '5100')];
  const tx = makeTx('BP GAS STATION');
  const match = clientRuleMatchFor(tx, rules);
  assert.equal(match, null, 'pattern shorter than 3 chars should not match');
});

test('clientRuleMatchFor: uses raw_description fallback', () => {
  const rules = [makeRule('verizon', '6100')];
  const tx = makeTx('', 'VZW VZWRLSS APOCC VERIZON');
  const match = clientRuleMatchFor(tx, rules);
  assert.ok(match, 'should match via raw_description');
  assert.equal(match.account_code, '6100');
});

test('clientRuleMatchFor: uses contact field', () => {
  const rules = [makeRule('dadant', '5200')];
  const tx = { description: 'WIRE TRANSFER', raw_description: '', contact: 'Dadant & Sons', source_line: '' };
  const match = clientRuleMatchFor(tx, rules);
  assert.ok(match, 'should match via contact');
});

test('clientRuleMatchFor: returns rule metadata', () => {
  const rules = [makeRule('chevron', '5100', { support_note: 'Fuel for fleet', confidence: 0.95 })];
  const tx = makeTx('CHEVRON STATION 4521');
  const match = clientRuleMatchFor(tx, rules);
  assert.ok(match);
  assert.equal(match.confidence, 0.95);
  assert.equal(match.support_note, 'Fuel for fleet');
  assert.ok(match.label);
});

test('clientRuleMatchFor: empty rules array returns null', () => {
  const tx = makeTx('DADANT COM');
  const match = clientRuleMatchFor(tx, []);
  assert.equal(match, null);
});

test('clientRuleMatchFor: real bank descriptions from test suite', () => {
  const rules = [
    makeRule('dadant', '5200'),
    makeRule('mannlakeltd', '5200'),
    makeRule('verizon', '6100'),
    makeRule('progressive', '6200'),
    makeRule('chevron', '5100')
  ];

  const cases = [
    ['dadant com a5b38ug59', '5200', 'Dadant web order'],
    ['mannlakeltd com 0d0ctbvc', '5200', 'Mann Lake canonical'],
    ['progressive ins payment', '6200', 'Progressive insurance'],
    ['chevron gas sta #4521', '5100', 'Chevron fuel'],
  ];

  for (const [desc, expectedCode, label] of cases) {
    const match = clientRuleMatchFor(makeTx(desc), rules);
    assert.ok(match, `${label}: should match`);
    assert.equal(match.account_code, expectedCode, `${label}: correct account`);
  }
});
