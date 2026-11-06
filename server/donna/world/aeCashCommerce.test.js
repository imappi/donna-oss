import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AE_CASH_COMMERCE_VERSION,
  buildAeCashCommerceExpected,
  evaluateAeCashCommerceCandidate,
  projectAeCashCommerceArrivalOrders,
  validateAeCashCommerceWorld,
} from './aeCashCommerce.js';
import { validateAeEntityTaxContextWorld } from './aeEntityTaxContext.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

test('AE-5 fixture composes through world schema, AE-1 facts, exact causal validity, and rendering', async () => {
  const world = await loadWorld();
  assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] });
  assert.deepEqual(validateCausalWorld(world), { ok: true, version: 'proof0.validity.v1', errors: [] });
  assert.equal(validateAeEntityTaxContextWorld(world).ok, true);
  assert.deepEqual(validateAeCashCommerceWorld(world), {
    ok: true,
    version: AE_CASH_COMMERCE_VERSION,
    errors: [],
    counts: { accounts: 3, fxRates: 1, settlementGroups: 4, collisionGroups: 3, arrivalOrders: 4, ownerAsks: 1 },
  });
  const rendered = await renderWorldArtifacts(world);
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  assert.equal(rendered.artifacts.length, 14);
  assert.ok(rendered.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
});

test('account identity, IBAN, statement currency, FX source/date, and AED consequence stay separate', async () => {
  const world = await loadWorld();
  const { accounts, fxRates, currencyConsequences } = world.cashCommerce;
  assert.deepEqual(new Set(accounts.map(({ statementCurrency }) => statementCurrency)), new Set(['AED', 'USD']));
  assert.equal(new Set(accounts.map(({ institutionIdentity, accountReference }) => `${institutionIdentity}/${accountReference}`)).size, 3);
  assert.ok(accounts.every(({ iban }) => /^AE\d{21}$/.test(iban)));
  assert.deepEqual(fxRates[0], {
    id: 'fx/usd-aed-2026-08-01',
    fromCurrency: 'USD',
    toCurrency: 'AED',
    rate: '3.672500',
    rateDate: '2026-08-01',
    source: 'settlement_receipt',
    sourceArtifactId: 'artifact/fx-usd-aed-2026-08-01',
  });
  assert.deepEqual(currencyConsequences[0], {
    id: 'currency-consequence/processor-sale-usd',
    eventId: 'event/processor-sale-usd',
    transactionAccountId: 'account/processor-usd',
    settlementAccountId: 'account/main-aed',
    transactionAmount: '100.00',
    transactionCurrency: 'USD',
    settlementAmount: '367.25',
    settlementCurrency: 'AED',
    fxRateId: 'fx/usd-aed-2026-08-01',
    fxRateDate: '2026-08-01',
    baseAmount: '367.25',
    baseCurrency: 'AED',
  });
});

test('gross cash, discounts, fees, fee VAT, refunds, reserves, and chargebacks reconcile to zero clearing exactly', async () => {
  const world = await loadWorld();
  const expected = buildAeCashCommerceExpected(world);
  assert.equal(expected.settlementGroups.length, 4);
  assert.equal(expected.postings.length, 27);
  for (const group of expected.settlementGroups) {
    const postings = expected.postings.filter(({ groupId }) => groupId === group.groupId);
    const clearing = postings.reduce((balance, posting) => (
      balance
      + (posting.debitRole === 'processor_clearing' ? posting.amountFils : 0)
      - (posting.creditRole === 'processor_clearing' ? posting.amountFils : 0)
    ), 0);
    assert.equal(clearing, 0, group.groupId);
    assert.equal(group.reserveRevenueFils, 0);
    assert.equal(group.netSalesFils, group.grossSalesFils);
  }
  assert.ok(expected.postings.some(({ debitRole }) => debitRole === 'recoverable_input_vat'));
  assert.ok(expected.postings.some(({ debitRole }) => debitRole === 'sales_refunds'));
  assert.ok(expected.postings.some(({ debitRole }) => debitRole === 'chargeback_receivable'));
  assert.ok(expected.postings.some(({ creditRole }) => creditRole === 'chargeback_receivable'));
  assert.ok(expected.postings.some(({ debitRole }) => debitRole === 'processor_reserve_asset'));
  assert.ok(expected.postings.some(({ creditRole }) => creditRole === 'processor_reserve_asset'));
});

test('processor, marketplace, and BNPL groups preserve both one-to-many and many-to-one settlement shape', async () => {
  const world = await loadWorld();
  const groups = new Map(world.cashCommerce.settlementGroups.map((group) => [group.id, group]));
  assert.equal(groups.get('settlement-group/processor-4471').channel, 'processor');
  assert.equal(groups.get('settlement-group/marketplace-8120').topology, 'many_documents_to_one_bank');
  assert.equal(groups.get('settlement-group/marketplace-8120').documentArtifactIds.length, 2);
  assert.equal(groups.get('settlement-group/bnpl-6300').topology, 'one_document_to_many_banks');
  assert.equal(groups.get('settlement-group/bnpl-6300').bankEventIds.length, 2);
  const events = new Map(world.events.map((event) => [event.id, event]));
  assert.equal(events.get('event/processor-refund-before-4471').timing, 'before_payout');
  assert.equal(events.get('event/refund-after-4471').timing, 'after_payout');
  assert.equal(events.get('event/chargeback-reversal-4471').reversesEventId, 'event/chargeback-4471');
  assert.equal(events.get('event/reserve-release-4471').releasesEventId, 'event/processor-reserve-hold-4471');
});

test('document-first, bank-first, posting-first, and late-document orders converge on one terminal digest', async () => {
  const projections = projectAeCashCommerceArrivalOrders(await loadWorld());
  assert.deepEqual(projections.map(({ orderName }) => orderName).sort(), [
    'bank_first', 'document_first', 'late_document', 'posting_first',
  ]);
  assert.equal(new Set(projections.map(({ terminalDigest }) => terminalDigest)).size, 1);
  assert.ok(projections.every(({ terminalProjection }) => terminalProjection.projector === 'reconcileConvergenceState'));
  assert.ok(projections.every(({ terminalProjection }) => terminalProjection.items.every(({ state }) => ['auto_reconciled', 'on_owner'].includes(state))));
});

test('collision groups hydrate complete evidence, expose only call-local handles, and keep ambiguity on one owner', async () => {
  const expected = buildAeCashCommerceExpected(await loadWorld());
  assert.equal(expected.collisionResolutions.length, 3);
  assert.equal(expected.collisionResolutions.find(({ groupId }) => groupId === 'collision/same-amount-bnpl').links.length, 2);
  assert.equal(expected.ownerAsks.length, 1);
  assert.deepEqual(expected.ownerAsks[0].evidenceAlreadyHeld, [
    'artifact/account-main-aed',
    'artifact/marketplace-orders-8120',
    'artifact/marketplace-report-8120',
    'artifact/processor-report-late-4471',
  ]);
  assert.ok(expected.modelBoundary.calls.every(({ exposedHandles }) => exposedHandles.every((handle) => /^(candidate|document)_\d+$/.test(handle))));
  assert.deepEqual(expected.modelBoundary.opaqueIds, []);
  assert.equal(expected.terminalProjection.items.filter(({ state }) => state === 'on_owner').length, 1);
  assert.equal(expected.terminalProjection.items.find(({ state }) => state === 'on_owner').askId, 'ask/truncated-reference-owner-fact');
});

test('own-account transfer has zero P&L and bounced cheque restores the receivable with zero cash', async () => {
  const expected = buildAeCashCommerceExpected(await loadWorld());
  assert.deepEqual(expected.ownAccountTransfers, [{
    transferId: 'own-transfer/9001',
    legalEntityId: 'entity/ae-cash-commerce-llc',
    fromAccountId: 'account/main-aed',
    toAccountId: 'account/reserve-aed',
    amountFils: 250000,
    pnlFils: 0,
  }]);
  assert.deepEqual(expected.bouncedCheques, [{
    chequeId: 'bounced-cheque/5500',
    legalEntityId: 'entity/ae-cash-commerce-llc',
    status: 'bounced_receivable_restored',
    cashNetFils: 0,
    receivableRestoredFils: 100000,
  }]);
});

test('stable mutation certificates refuse every protected AE-5 accounting and identity failure', async () => {
  const world = await loadWorld();
  const pristine = buildAeCashCommerceExpected(world);
  const cases = [
    ['AE_NET_PAYOUT_AS_NET_SALES', (value) => { value.settlementGroups[0].netSalesFils = value.settlementGroups[0].settledFils; }],
    ['AE_PROCESSOR_FEE_VAT_DROPPED', (value) => { value.settlementGroups[0].feeVatFils = 0; }],
    ['AE_PROCESSOR_FEE_VAT_DUPLICATED', (value) => { value.settlementGroups[0].feeVatFils *= 2; }],
    ['AE_RESERVE_MOVEMENT_AS_REVENUE', (value) => {
      const group = value.settlementGroups.find(({ reserveHoldFils }) => reserveHoldFils > 0);
      group.reserveRevenueFils = group.reserveHoldFils;
    }],
    ['AE_REFUND_CHARGEBACK_COLLAPSED', (value) => { value.settlementGroups[0].refundChargebackSeparate = false; }],
    ['AE_BOUNCED_CHEQUE_FALSE_SETTLEMENT', (value) => { value.bouncedCheques[0].status = 'settled'; }],
    ['AE_OWN_TRANSFER_PNL', (value) => { value.ownAccountTransfers[0].pnlFils = 250000; }],
    ['AE_FX_DATE_CURRENCY_MISMATCH', (value) => { value.fxConsequences[0].fxRateDate = '2026-08-02'; }],
    ['AE_COLLISION_LINK_CROSSED', (value) => {
      const links = value.collisionResolutions.find(({ groupId }) => groupId === 'collision/same-reference-4471').links;
      [links[0].candidateHandle, links[1].candidateHandle] = [links[1].candidateHandle, links[0].candidateHandle];
    }],
    ['AE_MODEL_OPAQUE_ID_EXPOSED', (value) => { value.modelBoundary.opaqueIds.push('event/bank-processor-4471'); }],
    ['AE_DUPLICATE_POSTING', (value) => { value.postingReceipts[0].appliedCount = 2; }],
    ['AE_EVIDENCE_ALREADY_HELD_UPLOAD_REQUEST', (value) => { value.evidenceRequests.push({ action: 'upload', artifactId: 'artifact/marketplace-report-8120' }); }],
    ['AE_CROSS_ENTITY_LINK', (value) => { value.collisionResolutions[0].resolvedLegalEntityId = 'entity/same-name-other-firm'; }],
  ];

  assert.equal(evaluateAeCashCommerceCandidate(world, pristine).status, 'PASS');
  for (const [expectedCode, mutate] of cases) {
    const candidate = clone(pristine);
    mutate(candidate);
    const receipt = evaluateAeCashCommerceCandidate(world, candidate);
    assert.equal(receipt.status, 'FAIL', expectedCode);
    assert.ok(receipt.failures.some(({ code }) => code === expectedCode), `${expectedCode}: ${JSON.stringify(receipt.failures)}`);
    assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
  }
});

test('contract refusals pin exact money, fee-VAT policy, complete collision hydration, and synthetic layouts', async () => {
  const source = await loadWorld();
  const cases = [
    ['AE_EXACT_MONEY_REQUIRED', (world) => { world.events.find(({ id }) => id === 'event/processor-fee-4471').settlementAmount = 10; }],
    ['AE_FEE_VAT_POLICY_LINK_INVALID', (world) => { world.events.find(({ id }) => id === 'event/processor-fee-vat-4471').policyEffectiveDate = '2026-01-01'; }],
    ['AE_COLLISION_GROUP_NOT_HYDRATED', (world) => { world.cashCommerce.collisionGroups[0].hydratedHandles.pop(); }],
    ['AE_COMMERCIAL_LAYOUT_MUST_BE_SYNTHETIC', (world) => { world.cashCommerce.commercialLayouts[0].synthetic = false; }],
  ];
  for (const [expectedCode, mutate] of cases) {
    const world = clone(source);
    mutate(world);
    assert.ok(validateAeCashCommerceWorld(world).errors.some(({ code }) => code === expectedCode), expectedCode);
  }
});

test('expected consequence and receipts are byte-deterministic without provider calls', async () => {
  const world = await loadWorld();
  const first = buildAeCashCommerceExpected(world);
  const second = buildAeCashCommerceExpected(clone(world));
  assert.deepEqual(second, first);
  assert.deepEqual(evaluateAeCashCommerceCandidate(world, first), evaluateAeCashCommerceCandidate(clone(world), second));
});

async function loadWorld() {
  const url = new URL('../../../data/worlds/ae/ae-cash-commerce-lifecycle.json', import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
