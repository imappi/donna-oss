// SG-1 — the SG chart: statutory-group integrity, entity-profile derivations,
// GST-account dormancy, lookup.
// node --test server/donna/singapore/sfrsChart.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SG_STATUTORY_GROUPS,
  SG_STATUTORY_GROUP_KEYS,
  SFRS_CHART,
  SOLE_PROP_EQUITY_ACCOUNTS,
  LLP_EQUITY_ACCOUNTS,
  GST_ACCOUNT_CODES,
  buildSoleProprietorChart,
  buildLlpChart,
  buildPteLtdChart,
  resolveSgAccount,
  resolveSgStatutoryGroup
} from './sfrsChart.js';

test('every chart account rolls up to a defined statutory group with a legal normal_balance', () => {
  for (const entry of [...SFRS_CHART, ...SOLE_PROP_EQUITY_ACCOUNTS, ...LLP_EQUITY_ACCOUNTS]) {
    assert.ok(SG_STATUTORY_GROUP_KEYS.has(entry.statutory_group), `${entry.code} group ${entry.statutory_group} exists`);
    assert.ok(['debit', 'credit'].includes(entry.normal_balance), `${entry.code} normal_balance legal`);
    assert.ok(entry.code && entry.name_en && entry.account_type, `${entry.code} carries the full shape`);
  }
  // Codes are unique across the whole vocabulary.
  const all = [...SFRS_CHART, ...SOLE_PROP_EQUITY_ACCOUNTS, ...LLP_EQUITY_ACCOUNTS].map((e) => e.code);
  assert.equal(new Set(all).size, all.length, 'no duplicate account codes');
});

test('statutory groups carry statement + side metadata the renderers need', () => {
  for (const [key, group] of Object.entries(SG_STATUTORY_GROUPS)) {
    assert.ok(['balance_sheet', 'income_statement'].includes(group.statement), `${key} statement legal`);
    if (group.statement === 'balance_sheet') {
      assert.ok(['assets', 'equity', 'liabilities'].includes(group.side), `${key} side legal`);
    }
    assert.ok(group.name_en, `${key} carries a label`);
  }
  assert.equal(resolveSgStatutoryGroup('gst_liability').statement, 'balance_sheet');
  assert.equal(resolveSgStatutoryGroup('nope'), null);
});

test('the GST control accounts exist in the base chart and are the dormancy set', () => {
  assert.deepEqual([...GST_ACCOUNT_CODES].sort(), ['2950', '2951']);
  assert.equal(resolveSgAccount('2950').statutory_group, 'gst_liability');
  assert.equal(resolveSgAccount('2950').normal_balance, 'credit');
  assert.equal(resolveSgAccount('2951').normal_balance, 'debit');
});

test('the sole-prop chart drops company equity + director balances + income tax, adds the capital account', () => {
  const chart = buildSoleProprietorChart({ gstRegistered: false });
  const codes = new Set(chart.map((e) => e.code));
  assert.ok(!codes.has('2000'), 'no share capital');
  assert.ok(!codes.has('2251'), 'no retained earnings');
  assert.ok(!codes.has('1760') && !codes.has('2762'), 'no director balances');
  assert.ok(!codes.has('2955') && !codes.has('9800'), 'no entity income tax (taxed on the owner)');
  assert.ok(!codes.has('2950') && !codes.has('2951'), 'GST accounts dormant when not registered');
  assert.ok(codes.has('2050') && codes.has('2051') && codes.has('2052'), 'capital account family present');
  const registered = buildSoleProprietorChart({ gstRegistered: true });
  const registeredCodes = new Set(registered.map((e) => e.code));
  assert.ok(registeredCodes.has('2950') && registeredCodes.has('2951'), 'GST accounts live when registered');
});

test('the LLP chart keeps related-party lines, adds partner equity, drops entity income tax', () => {
  const chart = buildLlpChart({ gstRegistered: true });
  const codes = new Set(chart.map((e) => e.code));
  assert.ok(!codes.has('2000'), 'no share capital');
  assert.ok(codes.has('2060') && codes.has('2061'), 'partner capital + current accounts');
  assert.ok(codes.has('1760') && codes.has('2762'), 'related-party balance lines kept');
  assert.ok(!codes.has('2955') && !codes.has('9800'), 'no entity income tax (taxed on the partners)');
});

test('the Pte Ltd chart is the base as-is; GST dormancy is the only knob', () => {
  const chart = buildPteLtdChart({ gstRegistered: true });
  assert.equal(chart.length, SFRS_CHART.length);
  const unregistered = buildPteLtdChart({ gstRegistered: false });
  assert.equal(unregistered.length, SFRS_CHART.length - GST_ACCOUNT_CODES.size);
  // Derivation never mutates the base.
  assert.ok(SFRS_CHART.some((e) => e.code === '2950'));
});

test('resolveSgAccount is a pure lookup that never throws on a miss', () => {
  assert.equal(resolveSgAccount('3000').account_type, 'revenue');
  assert.equal(resolveSgAccount(' 3000 ').code, '3000', 'trim tolerant');
  assert.equal(resolveSgAccount('0000'), null);
  assert.equal(resolveSgAccount(null), null);
});
