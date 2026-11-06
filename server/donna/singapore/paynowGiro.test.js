// SG — PayNow/GIRO/FAST rail recognition over realistic SG statement descriptors.
// node --test server/donna/singapore/paynowGiro.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SG_PAYMENT_RAILS,
  classifySgStatementRail,
  giroCounterpartyHint,
  buildSgRailContext
} from './paynowGiro.js';

test('the closed rail vocabulary', () => {
  assert.deepEqual([...SG_PAYMENT_RAILS], ['paynow', 'giro', 'fast', 'mepsplus', 'nets', 'card']);
});

test('PayNow lines classify with proxy extraction (UEN and mobile shapes)', () => {
  const uen = classifySgStatementRail('PAYNOW TRANSFER TO 201812345K ACME PTE LTD REF INV-102');
  assert.equal(uen.rail, 'paynow');
  assert.equal(uen.proxy, '201812345K');
  assert.equal(uen.proxyKind, 'uen');

  const mobile = classifySgStatementRail('PayNow to +65 9123 4567');
  assert.equal(mobile.rail, 'paynow');
  assert.equal(mobile.proxy, '6591234567');
  assert.equal(mobile.proxyKind, 'mobile');

  // PayNow wins over the FAST clearing marker on the same line.
  const both = classifySgStatementRail('FAST/PAYNOW CREDIT 53012345A');
  assert.equal(both.rail, 'paynow');
});

test('GIRO / FAST / NETS / card / MEPS markers classify; non-SG lines return null', () => {
  assert.equal(classifySgStatementRail('GIRO PAYMENT - SP SERVICES').rail, 'giro');
  assert.equal(classifySgStatementRail('FAST TRANSFER FR ACME PTE LTD').rail, 'fast');
  assert.equal(classifySgStatementRail('NETS PURCHASE NTUC FAIRPRICE').rail, 'nets');
  assert.equal(classifySgStatementRail('VISA PURCHASE GRAB* TRIP').rail, 'card');
  assert.equal(classifySgStatementRail('MEPS+ RTGS INWARD').rail, 'mepsplus');
  assert.equal(classifySgStatementRail('SEPA CREDIT TRANSFER'), null);
  assert.equal(classifySgStatementRail(''), null);
});

test('GIRO counterparty hints extract the billing organisation', () => {
  assert.equal(giroCounterpartyHint('GIRO PAYMENT - SP SERVICES LTD'), 'SP SERVICES LTD');
  assert.equal(giroCounterpartyHint('GIRO-IRAS GST'), 'IRAS GST');
  assert.equal(giroCounterpartyHint('GIRO DEDUCTION : CPF BOARD'), 'CPF BOARD');
  assert.equal(giroCounterpartyHint('regular transfer'), null);
});

test('buildSgRailContext assembles the enrichment envelope from any text-bearing field; {} when nothing recognised', () => {
  const context = buildSgRailContext({ description: 'PAYNOW CREDIT', reference: 'from 91234567' });
  assert.equal(context.sg_rail, 'paynow');
  assert.equal(context.sg_rail_proxy, '91234567');
  assert.equal(context.sg_rail_proxy_kind, 'mobile');

  const giro = buildSgRailContext({ narrative: 'GIRO PAYMENT - SINGTEL' });
  assert.equal(giro.sg_rail, 'giro');
  assert.equal(giro.sg_rail_counterparty_hint, 'SINGTEL');

  assert.deepEqual(buildSgRailContext({ description: 'ACH DEBIT VENDOR' }), {});
  assert.deepEqual(buildSgRailContext({}), {});
});

test('persisted reference and raw fields are optional text evidence, never object coercions', () => {
  for (const field of ['reference', 'structured_reference', 'raw_description', 'source_line', 'narrative', 'details']) {
    assert.deepEqual(buildSgRailContext({ [field]: 'PAYNOW 201812345K' }), {
      sg_rail: 'paynow', sg_rail_proxy: '201812345K', sg_rail_proxy_kind: 'uen'
    });
    assert.deepEqual(buildSgRailContext({ [field]: { description: 'PAYNOW 201812345K' } }), {});
  }
  assert.equal(buildSgRailContext({ description: 'GIRO-IRAS', raw_description: 'GIRO-IRAS',
    reference: 'separate reference' }).sg_rail_counterparty_hint, 'IRAS');
});
