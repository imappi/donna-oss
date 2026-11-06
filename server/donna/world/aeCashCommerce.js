import { createHash } from 'node:crypto';

import { validateAeEntityTaxContextWorld } from './aeEntityTaxContext.js';
import { canonicalJson } from './unitExecutionReceipt.js';
import { validateCausalWorld } from './worldValidity.js';
import { validateWorldSpec } from './worldSchema.js';

export const AE_CASH_COMMERCE_VERSION = 'ae.cash-commerce.v1';
export const AE_CASH_COMMERCE_WORLD_PATH = 'data/worlds/ae/ae-cash-commerce-lifecycle.json';

const COMPONENT_FIELDS = Object.freeze({
  commerce_sale: 'grossReceipts',
  commerce_discount: 'discounts',
  processor_fee: 'fees',
  processor_fee_vat: 'feeVat',
  customer_refund: 'refunds',
  chargeback: 'chargebacks',
  rolling_reserve_hold: 'reserves',
  rolling_reserve_release: 'reserveReleases',
  chargeback_reversal: 'chargebackReversals',
  fx_gain_loss: 'fxGainLoss',
});

const POSTING_ROLES = Object.freeze({
  commerce_sale: ['processor_clearing', 'sales_revenue'],
  commerce_discount: ['sales_discounts', 'processor_clearing'],
  processor_fee: ['processor_fees_expense', 'processor_clearing'],
  processor_fee_vat: ['recoverable_input_vat', 'processor_clearing'],
  customer_refund: ['sales_refunds', 'processor_clearing'],
  chargeback: ['chargeback_receivable', 'processor_clearing'],
  rolling_reserve_hold: ['processor_reserve_asset', 'processor_clearing'],
  rolling_reserve_release: ['processor_clearing', 'processor_reserve_asset'],
  chargeback_reversal: ['processor_clearing', 'chargeback_receivable'],
  fx_gain_loss: ['processor_clearing', 'fx_gain_loss'],
});

const TERMINAL_STATES = new Set(['auto_reconciled', 'on_owner']);
const CHANNELS = new Set(['processor', 'marketplace', 'bnpl']);
const TOPOLOGIES = new Set(['one_to_one', 'one_document_to_many_banks', 'many_documents_to_one_bank']);
const COLLISION_TYPES = new Set(['same_reference', 'same_amount', 'truncated_reference']);
const ARRIVAL_ORDER_NAMES = new Set(['document_first', 'bank_first', 'posting_first', 'late_document']);
const ARRIVAL_STAGES = ['documents_observed', 'banks_observed', 'postings_observed'];
const EXACT_MONEY = /^-?(0|[1-9]\d*)\.\d{2}$/;
const EXACT_RATE = /^(0|[1-9]\d*)\.\d{6}$/;
const IBAN = /^AE\d{21}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function validateAeCashCommerceWorld(world) {
  const errors = [];
  const shape = validateWorldSpec(world);
  if (!shape.ok) for (const message of shape.errors) add(errors, 'AE_CASH_WORLD_SCHEMA_INVALID', 'worldSpec', message);
  if (!shape.ok) return result(errors);

  const causal = validateCausalWorld(world);
  if (!causal.ok) for (const message of causal.errors) add(errors, 'AE_CASH_CAUSAL_WORLD_INVALID', 'worldSpec', message);
  const aeContext = validateAeEntityTaxContextWorld(world);
  if (!aeContext.ok) for (const error of aeContext.errors) add(errors, error.code, error.path, error.message);

  if (world.manifest.capabilityId !== 'reconcile_ae_operating_cash') {
    add(errors, 'AE_CASH_CAPABILITY_REQUIRED', 'manifest.capabilityId', 'AE-5 requires reconcile_ae_operating_cash.');
  }
  const cash = world.cashCommerce;
  if (!plain(cash)) {
    add(errors, 'AE_CASH_CONTRACT_REQUIRED', 'cashCommerce', 'The AE cash/commerce contract is required.');
    return result(errors);
  }
  if (cash.version !== AE_CASH_COMMERCE_VERSION) add(errors, 'AE_CASH_VERSION_INVALID', 'cashCommerce.version', `Expected ${AE_CASH_COMMERCE_VERSION}.`);
  if (cash.baseCurrency !== 'AED') add(errors, 'AE_CASH_BASE_CURRENCY_REQUIRED', 'cashCommerce.baseCurrency', 'The AE base currency must be AED.');

  const entities = index(world.entities);
  const events = index(world.events);
  const artifacts = index(world.artifacts);
  const accounts = validateAccounts(cash.accounts, entities, artifacts, errors);
  const rates = validateFxRates(cash.fxRates, artifacts, errors);
  validateCurrencyConsequences(cash.currencyConsequences, events, rates, accounts, errors);
  const groups = validateSettlementGroups(cash.settlementGroups, events, artifacts, accounts, errors);
  const asks = validateOwnerAsks(cash.ownerAsks, entities, artifacts, errors);
  validateCollisionGroups(cash.collisionGroups, groups, events, artifacts, asks, errors);
  validateArrivalOrders(cash.arrivalOrderCases, groups, errors);
  validateOwnTransfers(cash.ownAccountTransfers, events, accounts, errors);
  validateBouncedCheques(cash.bouncedCheques, events, accounts, errors);
  validateFeeVatPolicy(cash.feeVatPolicy, world.policySources, events, errors);
  validateSyntheticLayouts(cash.commercialLayouts, artifacts, errors);

  return result(errors, {
    counts: {
      accounts: accounts.size,
      fxRates: rates.size,
      settlementGroups: groups.size,
      collisionGroups: array(cash.collisionGroups).length,
      arrivalOrders: array(cash.arrivalOrderCases).reduce((sum, entry) => sum + array(entry.orders).length, 0),
      ownerAsks: asks.size,
    },
  });
}

export function buildAeCashCommerceExpected(world) {
  const validation = validateAeCashCommerceWorld(world);
  if (!validation.ok) throw new TypeError(validation.errors.map(({ code, path }) => `${code}:${path}`).join('; '));
  const cash = world.cashCommerce;
  const events = index(world.events);
  const postings = [];
  const settlementGroups = [];

  for (const group of sorted(cash.settlementGroups)) {
    const settlement = events.get(group.settlementEventId);
    for (const eventId of group.componentEventIds) {
      const event = events.get(eventId);
      const roles = POSTING_ROLES[event.type];
      const amountFils = toFils(event.settlementAmount);
      postings.push({
        postingKey: `${world.worldId}/${group.id}/${event.id}`,
        groupId: group.id,
        sourceEventId: event.id,
        debitRole: roles[0],
        creditRole: roles[1],
        amountFils,
      });
    }
    for (const bankEventId of group.bankEventIds) {
      const event = events.get(bankEventId);
      const signedFils = toFils(event.amount);
      postings.push({
        postingKey: `${world.worldId}/${group.id}/${event.id}`,
        groupId: group.id,
        sourceEventId: event.id,
        debitRole: signedFils >= 0 ? 'bank_cash' : 'processor_clearing',
        creditRole: signedFils >= 0 ? 'processor_clearing' : 'bank_cash',
        amountFils: Math.abs(signedFils),
      });
    }
    const effects = settlement.monetaryEffects;
    settlementGroups.push({
      groupId: group.id,
      legalEntityId: group.legalEntityId,
      channel: group.channel,
      topology: group.topology,
      grossSalesFils: toFils(effects.grossReceipts),
      netSalesFils: toFils(effects.grossReceipts),
      discountFils: toFils(effects.discounts ?? '0.00'),
      feeFils: toFils(effects.fees),
      feeVatFils: toFils(effects.feeVat ?? '0.00'),
      refundFils: toFils(effects.refunds ?? '0.00'),
      chargebackFils: toFils(effects.chargebacks ?? '0.00'),
      reserveHoldFils: toFils(effects.reserves ?? '0.00'),
      reserveReleaseFils: toFils(effects.reserveReleases ?? '0.00'),
      chargebackReversalFils: toFils(effects.chargebackReversals ?? '0.00'),
      settledFils: toFils(effects.settled),
      reserveRevenueFils: 0,
      refundChargebackSeparate: true,
    });
  }

  const collisionResolutions = sorted(cash.collisionGroups).map((group) => ({
    groupId: group.id,
    legalEntityId: group.legalEntityId,
    resolvedLegalEntityId: group.legalEntityId,
    hydratedHandles: [...group.hydratedHandles].sort(),
    links: array(group.expectedLinks).map((link) => ({ ...link })).sort(compareLink),
    ownerAskId: group.ownerAskId ?? null,
  }));
  const ownerAsks = sorted(cash.ownerAsks).map((ask) => ({
    askId: ask.id,
    legalEntityId: ask.legalEntityId,
    collisionGroupId: ask.collisionGroupId,
    responsibleActor: ask.responsibleActor,
    evidenceAlreadyHeld: [...ask.evidenceAlreadyHeld].sort(),
    status: 'open',
  }));
  const terminalItems = [
    ...sorted(cash.settlementGroups).map((group) => terminal(`${group.id}/settlement`, 'auto_reconciled')),
    ...sorted(cash.collisionGroups).map((group) => terminal(`${group.id}/collision`, group.ownerAskId ? 'on_owner' : 'auto_reconciled', group.ownerAskId)),
    ...sorted(cash.ownAccountTransfers).map((entry) => terminal(`${entry.id}/transfer`, 'auto_reconciled')),
    ...sorted(cash.bouncedCheques).map((entry) => terminal(`${entry.id}/cheque`, 'auto_reconciled')),
  ].sort((left, right) => left.itemId.localeCompare(right.itemId));
  const modelCalls = sorted(cash.collisionGroups).map((group, index) => ({
    callHandle: `collision_call_${index + 1}`,
    collisionGroupHandle: `collision_group_${index + 1}`,
    exposedHandles: [...array(group.candidateHandles), ...array(group.documentHandles)].sort(),
  }));
  const candidate = {
    version: AE_CASH_COMMERCE_VERSION,
    settlementGroups,
    postings: postings.sort((left, right) => left.postingKey.localeCompare(right.postingKey)),
    postingReceipts: postings.map(({ postingKey }) => ({ postingKey, appliedCount: 1 })).sort((left, right) => left.postingKey.localeCompare(right.postingKey)),
    fxConsequences: sorted(cash.currencyConsequences).map((entry) => ({
      eventId: entry.eventId,
      transactionCurrency: entry.transactionCurrency,
      settlementCurrency: entry.settlementCurrency,
      baseCurrency: entry.baseCurrency,
      transactionAccountId: entry.transactionAccountId,
      settlementAccountId: entry.settlementAccountId,
      fxRateId: entry.fxRateId,
      fxRateDate: entry.fxRateDate,
      transactionFils: toFils(entry.transactionAmount),
      settlementFils: toFils(entry.settlementAmount),
      baseFils: toFils(entry.baseAmount),
    })),
    collisionResolutions,
    ownAccountTransfers: sorted(cash.ownAccountTransfers).map((entry) => ({
      transferId: entry.id,
      legalEntityId: entry.legalEntityId,
      fromAccountId: entry.fromAccountId,
      toAccountId: entry.toAccountId,
      amountFils: toFils(entry.amount),
      pnlFils: 0,
    })),
    bouncedCheques: sorted(cash.bouncedCheques).map((entry) => ({
      chequeId: entry.id,
      legalEntityId: entry.legalEntityId,
      status: 'bounced_receivable_restored',
      cashNetFils: 0,
      receivableRestoredFils: toFils(entry.amount),
    })),
    ownerAsks,
    evidenceRequests: [],
    modelBoundary: {
      contract: 'strong_model_call_local_handles.v1',
      calls: modelCalls,
      opaqueIds: [],
    },
    terminalProjection: {
      projector: 'reconcileConvergenceState',
      items: terminalItems,
    },
  };
  return freeze(candidate);
}

export function projectAeCashCommerceArrivalOrders(world) {
  const expected = buildAeCashCommerceExpected(world);
  const terminalDigest = digest({
    postings: expected.postings,
    postingReceipts: expected.postingReceipts,
    settlementGroups: expected.settlementGroups,
    collisionResolutions: expected.collisionResolutions,
    ownerAsks: expected.ownerAsks,
    terminalProjection: expected.terminalProjection,
  });
  return freeze(sorted(world.cashCommerce.arrivalOrderCases).flatMap((arrivalCase) => (
    [...arrivalCase.orders].sort((left, right) => left.name.localeCompare(right.name)).map((order) => ({
      caseId: arrivalCase.id,
      orderName: order.name,
      stages: [...order.stages],
      terminalDigest,
      terminalProjection: expected.terminalProjection,
    }))
  )));
}

export function evaluateAeCashCommerceCandidate(world, candidate) {
  const worldValidation = validateAeCashCommerceWorld(world);
  if (!worldValidation.ok) return evaluation('INCOMPLETE', worldValidation.errors, []);
  if (!plain(candidate)) return evaluation('INCOMPLETE', [{ code: 'AE_CANDIDATE_REQUIRED', path: 'candidate', message: 'Candidate must be an object.' }], []);
  const expected = buildAeCashCommerceExpected(world);
  const failures = [];

  const actualGroups = index(candidate.settlementGroups);
  for (const expectedGroup of expected.settlementGroups) {
    const actual = actualGroups.get(expectedGroup.groupId);
    if (!actual) {
      fail(failures, 'AE_SETTLEMENT_GROUP_MISSING', expectedGroup.groupId);
      continue;
    }
    if (actual.netSalesFils === expectedGroup.settledFils && expectedGroup.grossSalesFils !== expectedGroup.settledFils) {
      fail(failures, 'AE_NET_PAYOUT_AS_NET_SALES', expectedGroup.groupId);
    } else if (actual.netSalesFils !== expectedGroup.grossSalesFils) {
      fail(failures, 'AE_GROSS_SALES_MISMATCH', expectedGroup.groupId);
    }
    if (actual.feeVatFils < expectedGroup.feeVatFils) fail(failures, 'AE_PROCESSOR_FEE_VAT_DROPPED', expectedGroup.groupId);
    if (actual.feeVatFils > expectedGroup.feeVatFils) fail(failures, 'AE_PROCESSOR_FEE_VAT_DUPLICATED', expectedGroup.groupId);
    if (actual.reserveRevenueFils !== 0) fail(failures, 'AE_RESERVE_MOVEMENT_AS_REVENUE', expectedGroup.groupId);
    if (actual.refundChargebackSeparate !== true) fail(failures, 'AE_REFUND_CHARGEBACK_COLLAPSED', expectedGroup.groupId);
    if (!same(actual, expectedGroup)) fail(failures, 'AE_SETTLEMENT_RECONCILIATION_MISMATCH', expectedGroup.groupId);
  }

  const actualFx = index(candidate.fxConsequences);
  for (const expectedEntry of expected.fxConsequences) {
    const actual = actualFx.get(expectedEntry.eventId);
    if (!same(actual, expectedEntry)) fail(failures, 'AE_FX_DATE_CURRENCY_MISMATCH', expectedEntry.eventId);
  }
  const actualTransfers = new Map(array(candidate.ownAccountTransfers).map((entry) => [entry.transferId, entry]));
  for (const expectedEntry of expected.ownAccountTransfers) {
    const actual = actualTransfers.get(expectedEntry.transferId);
    if (!actual || actual.pnlFils !== 0 || !same(actual, expectedEntry)) fail(failures, 'AE_OWN_TRANSFER_PNL', expectedEntry.transferId);
  }
  const actualCheques = new Map(array(candidate.bouncedCheques).map((entry) => [entry.chequeId, entry]));
  for (const expectedEntry of expected.bouncedCheques) {
    const actual = actualCheques.get(expectedEntry.chequeId);
    if (!same(actual, expectedEntry)) fail(failures, 'AE_BOUNCED_CHEQUE_FALSE_SETTLEMENT', expectedEntry.chequeId);
  }

  const actualCollisions = index(candidate.collisionResolutions);
  for (const expectedEntry of expected.collisionResolutions) {
    const actual = actualCollisions.get(expectedEntry.groupId);
    if (actual?.resolvedLegalEntityId !== expectedEntry.legalEntityId) fail(failures, 'AE_CROSS_ENTITY_LINK', expectedEntry.groupId);
    if (!same([...array(actual?.links)].sort(compareLink), expectedEntry.links)
      || !same([...array(actual?.hydratedHandles)].sort(), expectedEntry.hydratedHandles)) {
      fail(failures, 'AE_COLLISION_LINK_CROSSED', expectedEntry.groupId);
    }
  }

  if (array(candidate.modelBoundary?.opaqueIds).length > 0
    || array(candidate.modelBoundary?.calls).flatMap((call) => array(call?.exposedHandles))
      .some((handle) => /^(event|artifact|entity|account)\//.test(handle))) {
    fail(failures, 'AE_MODEL_OPAQUE_ID_EXPOSED', 'modelBoundary');
  }
  if (!same(candidate.modelBoundary, expected.modelBoundary)) fail(failures, 'AE_MODEL_BOUNDARY_MISMATCH', 'modelBoundary');

  const held = new Set(world.cashCommerce.ownerAsks.flatMap((ask) => ask.evidenceAlreadyHeld));
  if (array(candidate.evidenceRequests).some((request) => request?.action === 'upload' && held.has(request.artifactId))) {
    fail(failures, 'AE_EVIDENCE_ALREADY_HELD_UPLOAD_REQUEST', 'evidenceRequests');
  }
  if (!same(candidate.evidenceRequests, expected.evidenceRequests)) fail(failures, 'AE_EVIDENCE_REQUEST_MISMATCH', 'evidenceRequests');

  if (array(candidate.postingReceipts).some((receipt) => receipt?.appliedCount !== 1)
    || new Set(array(candidate.postingReceipts).map((receipt) => receipt?.postingKey)).size !== array(candidate.postingReceipts).length) {
    fail(failures, 'AE_DUPLICATE_POSTING', 'postingReceipts');
  }
  if (!same(candidate.postingReceipts, expected.postingReceipts) || !same(candidate.postings, expected.postings)) {
    fail(failures, 'AE_POSTING_SET_MISMATCH', 'postings');
  }
  if (!validTerminalProjection(candidate.terminalProjection, expected.terminalProjection)) {
    fail(failures, 'AE_FIRM_LIMBO', 'terminalProjection');
  }
  if (!same(candidate.ownerAsks, expected.ownerAsks)) fail(failures, 'AE_OWNER_ASK_MISMATCH', 'ownerAsks');

  return evaluation(failures.length ? 'FAIL' : 'PASS', [], failures);
}

function validateAccounts(value, entities, artifacts, errors) {
  const accounts = new Map();
  const identities = new Set();
  for (const [position, account] of array(value).entries()) {
    const path = `cashCommerce.accounts[${position}]`;
    if (!nonEmpty(account?.id) || accounts.has(account.id)) add(errors, 'AE_ACCOUNT_ID_INVALID', `${path}.id`, 'Account ids must be unique non-empty strings.');
    else accounts.set(account.id, account);
    if (!entities.has(account?.legalEntityId)) add(errors, 'AE_ACCOUNT_ENTITY_INVALID', `${path}.legalEntityId`, 'Account must belong to a world legal entity.');
    if (!['bank', 'payment'].includes(account?.kind)) add(errors, 'AE_ACCOUNT_KIND_INVALID', `${path}.kind`, 'Account kind must be bank or payment.');
    if (!nonEmpty(account?.institutionIdentity) || !nonEmpty(account?.accountReference)) add(errors, 'AE_ACCOUNT_IDENTITY_REQUIRED', path, 'Institution and account reference are separate required identity axes.');
    const identity = `${account?.legalEntityId}/${account?.institutionIdentity}/${account?.accountReference}`;
    if (identities.has(identity)) add(errors, 'AE_ACCOUNT_IDENTITY_DUPLICATED', path, 'Account identity is duplicated.');
    identities.add(identity);
    if (!IBAN.test(account?.iban ?? '')) add(errors, 'AE_ACCOUNT_IBAN_INVALID', `${path}.iban`, 'A canonical UAE IBAN is required.');
    if (!currency(account?.statementCurrency)) add(errors, 'AE_ACCOUNT_STATEMENT_CURRENCY_REQUIRED', `${path}.statementCurrency`, 'Statement currency must be an ISO-like currency code.');
    if (!artifacts.has(account?.sourceArtifactId)) add(errors, 'AE_ACCOUNT_SOURCE_REQUIRED', `${path}.sourceArtifactId`, 'Account identity requires a held source artifact.');
  }
  if (accounts.size < 3 || ![...accounts.values()].some(({ statementCurrency }) => statementCurrency !== 'AED')) {
    add(errors, 'AE_AED_AND_FOREIGN_ACCOUNTS_REQUIRED', 'cashCommerce.accounts', 'AED and foreign-currency bank/payment accounts are required.');
  }
  return accounts;
}

function validateFxRates(value, artifacts, errors) {
  const rates = new Map();
  for (const [position, rate] of array(value).entries()) {
    const path = `cashCommerce.fxRates[${position}]`;
    if (!nonEmpty(rate?.id) || rates.has(rate.id)) add(errors, 'AE_FX_RATE_ID_INVALID', `${path}.id`, 'FX rate ids must be unique.');
    else rates.set(rate.id, rate);
    if (!currency(rate?.fromCurrency) || !currency(rate?.toCurrency) || rate?.fromCurrency === rate?.toCurrency) add(errors, 'AE_FX_CURRENCY_PAIR_INVALID', path, 'FX rates require distinct source and destination currencies.');
    if (!EXACT_RATE.test(rate?.rate ?? '')) add(errors, 'AE_FX_RATE_INVALID', `${path}.rate`, 'FX rate must be an exact six-decimal string.');
    if (!ISO_DAY.test(rate?.rateDate ?? '')) add(errors, 'AE_FX_DATE_INVALID', `${path}.rateDate`, 'FX rate date must be an ISO day.');
    if (!artifacts.has(rate?.sourceArtifactId)) add(errors, 'AE_FX_SOURCE_REQUIRED', `${path}.sourceArtifactId`, 'FX rate requires a held source artifact.');
  }
  return rates;
}

function validateCurrencyConsequences(value, events, rates, accounts, errors) {
  for (const [position, entry] of array(value).entries()) {
    const path = `cashCommerce.currencyConsequences[${position}]`;
    const event = events.get(entry?.eventId);
    const rate = rates.get(entry?.fxRateId);
    if (!event) add(errors, 'AE_FX_EVENT_REQUIRED', `${path}.eventId`, 'Currency consequence requires an event.');
    if (!rate) add(errors, 'AE_FX_RATE_REQUIRED', `${path}.fxRateId`, 'Currency consequence requires a sourced FX rate.');
    for (const field of ['transactionAmount', 'settlementAmount', 'baseAmount']) if (toFils(entry?.[field]) === null) add(errors, 'AE_EXACT_MONEY_REQUIRED', `${path}.${field}`, 'Money must be an exact two-decimal string.');
    if (entry?.baseCurrency !== 'AED' || entry?.settlementCurrency !== 'AED') add(errors, 'AE_FX_BASE_SETTLEMENT_CURRENCY_INVALID', path, 'This consequence must keep AED settlement and base currency explicit.');
    const transactionAccount = accounts.get(entry?.transactionAccountId);
    const settlementAccount = accounts.get(entry?.settlementAccountId);
    if (!transactionAccount || transactionAccount.statementCurrency !== entry?.transactionCurrency
      || !settlementAccount || settlementAccount.statementCurrency !== entry?.settlementCurrency
      || transactionAccount.legalEntityId !== event?.legalEntityId
      || settlementAccount.legalEntityId !== event?.legalEntityId) {
      add(errors, 'AE_FX_ACCOUNT_CURRENCY_MISMATCH', path, 'Transaction and settlement accounts must preserve their own identity, entity, and statement currency.');
    }
    if (rate && (entry?.transactionCurrency !== rate.fromCurrency || entry?.settlementCurrency !== rate.toCurrency || entry?.fxRateDate !== rate.rateDate)) {
      add(errors, 'AE_FX_DATE_CURRENCY_MISMATCH', path, 'Transaction/settlement currencies and rate date must match the sourced rate.');
    }
    if (rate && toFils(entry?.transactionAmount) !== null && toFils(entry?.settlementAmount) !== null) {
      const numerator = BigInt(toFils(entry.transactionAmount)) * BigInt(rate.rate.replace('.', ''));
      if (numerator % 1_000_000n !== 0n || Number(numerator / 1_000_000n) !== toFils(entry.settlementAmount)) add(errors, 'AE_FX_CONVERSION_INEXACT', path, 'Settlement amount must be the exact sourced-rate consequence.');
    }
    if (entry?.baseAmount !== entry?.settlementAmount) add(errors, 'AE_FX_BASE_CONSEQUENCE_INVALID', `${path}.baseAmount`, 'AED settlement must remain a separate explicit AED base consequence.');
    if (event && (event.transactionCurrency !== entry.transactionCurrency
      || event.settlementCurrency !== entry.settlementCurrency
      || event.transactionAmount !== entry.transactionAmount
      || event.settlementAmount !== entry.settlementAmount
      || event.fxRateId !== entry.fxRateId)) {
      add(errors, 'AE_FX_EVENT_CURRENCY_MISMATCH', path, 'Event and sourced currency consequence disagree.');
    }
  }
}

function validateSettlementGroups(value, events, artifacts, accounts, errors) {
  const groups = new Map();
  const usedSettlements = new Set();
  const usedComponents = new Set();
  const usedBanks = new Set();
  for (const [position, group] of array(value).entries()) {
    const path = `cashCommerce.settlementGroups[${position}]`;
    if (!nonEmpty(group?.id) || groups.has(group.id)) add(errors, 'AE_SETTLEMENT_GROUP_ID_INVALID', `${path}.id`, 'Settlement group ids must be unique.');
    else groups.set(group.id, group);
    if (!CHANNELS.has(group?.channel)) add(errors, 'AE_SETTLEMENT_CHANNEL_INVALID', `${path}.channel`, 'Channel must be processor, marketplace, or bnpl.');
    if (!TOPOLOGIES.has(group?.topology)) add(errors, 'AE_SETTLEMENT_TOPOLOGY_INVALID', `${path}.topology`, 'Settlement topology is invalid.');
    const settlement = events.get(group?.settlementEventId);
    if (settlement?.type !== 'processor_settlement') add(errors, 'AE_PROCESSOR_SETTLEMENT_REQUIRED', `${path}.settlementEventId`, 'Group must use the shared processor_settlement event.');
    if (usedSettlements.has(group?.settlementEventId)) add(errors, 'AE_SETTLEMENT_EVENT_REUSED', `${path}.settlementEventId`, 'A settlement event may belong to only one group.');
    usedSettlements.add(group?.settlementEventId);
    if (!accounts.has(group?.cashAccountId)) add(errors, 'AE_SETTLEMENT_CASH_ACCOUNT_REQUIRED', `${path}.cashAccountId`, 'Group requires a cash account.');
    if (accounts.get(group?.cashAccountId)?.legalEntityId !== group?.legalEntityId) add(errors, 'AE_CROSS_ENTITY_LINK', `${path}.cashAccountId`, 'Settlement and cash account must share one legal entity.');
    for (const artifactId of array(group?.documentArtifactIds)) if (!artifacts.has(artifactId)) add(errors, 'AE_SETTLEMENT_DOCUMENT_REQUIRED', path, `Missing document ${artifactId}.`);
    const components = array(group?.componentEventIds).map((id) => events.get(id));
    for (const id of array(group?.componentEventIds)) {
      if (usedComponents.has(id)) add(errors, 'AE_SETTLEMENT_EVENT_REUSED', `${path}.componentEventIds`, `Component ${id} is already in another group.`);
      usedComponents.add(id);
    }
    if (components.some((event) => !event || !Object.hasOwn(COMPONENT_FIELDS, event.type))) add(errors, 'AE_SETTLEMENT_COMPONENT_INVALID', `${path}.componentEventIds`, 'Every component must use a supported gross-to-net event type.');
    const banks = array(group?.bankEventIds).map((id) => events.get(id));
    for (const id of array(group?.bankEventIds)) {
      if (usedBanks.has(id)) add(errors, 'AE_SETTLEMENT_EVENT_REUSED', `${path}.bankEventIds`, `Bank event ${id} is already in another group.`);
      usedBanks.add(id);
    }
    if (banks.some((event) => event?.type !== 'cash_movement')) add(errors, 'AE_SETTLEMENT_BANK_EVENT_INVALID', `${path}.bankEventIds`, 'Every bank event must be a cash movement.');
    if (group?.topology === 'one_document_to_many_banks' && !(array(group.documentArtifactIds).length === 1 && banks.length > 1)) add(errors, 'AE_SETTLEMENT_TOPOLOGY_MISMATCH', path, 'one_document_to_many_banks requires one document and multiple banks.');
    if (group?.topology === 'many_documents_to_one_bank' && !(array(group.documentArtifactIds).length > 1 && banks.length === 1)) add(errors, 'AE_SETTLEMENT_TOPOLOGY_MISMATCH', path, 'many_documents_to_one_bank requires multiple documents and one bank.');
    if (group?.topology === 'one_to_one' && !(array(group.documentArtifactIds).length === 1 && banks.length === 1)) add(errors, 'AE_SETTLEMENT_TOPOLOGY_MISMATCH', path, 'one_to_one requires one document and one bank.');
    if (!settlement) continue;
    const componentTotals = Object.fromEntries(Object.values(COMPONENT_FIELDS).map((field) => [field, 0]));
    for (const component of components.filter(Boolean)) {
      const amount = toFils(component.settlementAmount);
      if (amount === null) add(errors, 'AE_EXACT_MONEY_REQUIRED', `events.${component.id}.settlementAmount`, 'Settlement component must be an exact two-decimal string.');
      else componentTotals[COMPONENT_FIELDS[component.type]] += amount;
      if (component.legalEntityId !== group.legalEntityId || component.settlementCurrency !== settlement.settlementCurrency) add(errors, 'AE_SETTLEMENT_COMPONENT_IDENTITY_MISMATCH', path, `Component ${component.id} crosses entity or currency.`);
      if (component.type === 'customer_refund' && !['before_payout', 'after_payout'].includes(component.timing)) add(errors, 'AE_REFUND_TIMING_REQUIRED', `events.${component.id}.timing`, 'Refund timing must be explicit.');
      if (component.type === 'customer_refund' && component.timing === 'after_payout' && events.get(component.originalSettlementEventId)?.type !== 'processor_settlement') add(errors, 'AE_REFUND_ORIGINAL_PAYOUT_REQUIRED', `events.${component.id}.originalSettlementEventId`, 'After-payout refund must identify its original settlement.');
      if (component.type === 'chargeback_reversal' && events.get(component.reversesEventId)?.type !== 'chargeback') add(errors, 'AE_CHARGEBACK_REVERSAL_SOURCE_REQUIRED', `events.${component.id}.reversesEventId`, 'Chargeback reversal must reference a chargeback.');
      if (component.type === 'rolling_reserve_release' && events.get(component.releasesEventId)?.type !== 'rolling_reserve_hold') add(errors, 'AE_RESERVE_RELEASE_SOURCE_REQUIRED', `events.${component.id}.releasesEventId`, 'Reserve release must reference a reserve hold.');
    }
    for (const [field, total] of Object.entries(componentTotals)) {
      const effect = toFils(settlement.monetaryEffects?.[field] ?? '0.00');
      if (effect === null || effect !== total) add(errors, 'AE_SETTLEMENT_COMPONENT_TOTAL_MISMATCH', `${path}.${field}`, `Component total does not equal ${field}.`);
    }
    const bankTotal = banks.reduce((sum, event) => sum + (toFils(event?.amount) ?? 0), 0);
    if (bankTotal !== toFils(settlement.monetaryEffects?.settled)) add(errors, 'AE_SETTLEMENT_BANK_TOTAL_MISMATCH', path, 'Bank movements must equal exact net settlement.');
  }
  const channels = new Set([...groups.values()].map(({ channel }) => channel));
  for (const channel of CHANNELS) if (!channels.has(channel)) add(errors, 'AE_SETTLEMENT_CHANNEL_COVERAGE_INCOMPLETE', 'cashCommerce.settlementGroups', `Missing ${channel} settlement group.`);
  const topologies = new Set([...groups.values()].map(({ topology }) => topology));
  for (const topology of ['one_document_to_many_banks', 'many_documents_to_one_bank']) {
    if (!topologies.has(topology)) add(errors, 'AE_SETTLEMENT_TOPOLOGY_COVERAGE_INCOMPLETE', 'cashCommerce.settlementGroups', `Missing ${topology} settlement group.`);
  }
  return groups;
}

function validateOwnerAsks(value, entities, artifacts, errors) {
  const asks = new Map();
  for (const [position, ask] of array(value).entries()) {
    const path = `cashCommerce.ownerAsks[${position}]`;
    if (!nonEmpty(ask?.id) || asks.has(ask.id)) add(errors, 'AE_OWNER_ASK_ID_INVALID', `${path}.id`, 'Owner ask ids must be unique.');
    else asks.set(ask.id, ask);
    if (!entities.has(ask?.legalEntityId) || ask?.responsibleActor !== 'owner') add(errors, 'AE_OWNER_ASK_ACTOR_INVALID', path, 'Ask must rest on the named entity owner.');
    if (!nonEmpty(ask?.question) || !nonEmpty(ask?.factClass)) add(errors, 'AE_OWNER_ASK_CONTENT_REQUIRED', path, 'Ask requires a precise question and fact class.');
    if (array(ask?.evidenceAlreadyHeld).length === 0 || array(ask?.evidenceAlreadyHeld).some((id) => !artifacts.has(id))) add(errors, 'AE_OWNER_ASK_EVIDENCE_INVALID', path, 'Ask must name held evidence and must not request it again.');
    if (/\bupload\b/i.test(ask?.question ?? '')) add(errors, 'AE_EVIDENCE_ALREADY_HELD_UPLOAD_REQUEST', `${path}.question`, 'Held evidence must not be requested again.');
  }
  return asks;
}

function validateCollisionGroups(value, settlementGroups, events, artifacts, asks, errors) {
  const seen = new Set();
  for (const [position, group] of array(value).entries()) {
    const path = `cashCommerce.collisionGroups[${position}]`;
    if (!nonEmpty(group?.id) || seen.has(group.id)) add(errors, 'AE_COLLISION_GROUP_ID_INVALID', `${path}.id`, 'Collision group ids must be unique.');
    seen.add(group?.id);
    if (!COLLISION_TYPES.has(group?.collisionType)) add(errors, 'AE_COLLISION_TYPE_INVALID', `${path}.collisionType`, 'Collision type is invalid.');
    const candidates = array(group?.candidates);
    const documents = array(group?.documents);
    const candidateHandles = candidates.map(({ handle }) => handle);
    const documentHandles = documents.map(({ handle }) => handle);
    if (candidates.length < 2 || new Set(candidateHandles).size !== candidates.length || candidateHandles.some((handle) => !/^candidate_[1-9]\d*$/.test(handle))) add(errors, 'AE_COLLISION_CANDIDATE_HANDLES_INVALID', `${path}.candidates`, 'Collision candidates require unique call-local handles.');
    if (documents.length < 1 || new Set(documentHandles).size !== documents.length || documentHandles.some((handle) => !/^document_[1-9]\d*$/.test(handle))) add(errors, 'AE_COLLISION_DOCUMENT_HANDLES_INVALID', `${path}.documents`, 'Collision documents require unique call-local handles.');
    if (candidates.some(({ eventId }) => !events.has(eventId)) || documents.some(({ artifactId }) => !artifacts.has(artifactId))) add(errors, 'AE_COLLISION_SOURCE_MISSING', path, 'Collision group must hydrate persisted candidate and document sources.');
    if (candidates.some(({ legalEntityId }) => legalEntityId !== group?.legalEntityId)) add(errors, 'AE_CROSS_ENTITY_LINK', `${path}.candidates`, 'Collision candidate crossed a legal entity.');
    if (documents.some(({ legalEntityId }) => legalEntityId !== group?.legalEntityId)) add(errors, 'AE_CROSS_ENTITY_LINK', `${path}.documents`, 'Collision document crossed a legal entity.');
    const expectedHydration = [...candidateHandles, ...documentHandles].sort();
    if (!same([...array(group?.hydratedHandles)].sort(), expectedHydration)) add(errors, 'AE_COLLISION_GROUP_NOT_HYDRATED', `${path}.hydratedHandles`, 'The complete collision group must be hydrated.');
    const handleSet = new Set(expectedHydration);
    if (array(group?.expectedLinks).some((link) => !handleSet.has(link?.candidateHandle) || !handleSet.has(link?.documentHandle))) add(errors, 'AE_COLLISION_LINK_HANDLE_INVALID', `${path}.expectedLinks`, 'Links may use only group-local handles.');
    if (group?.ownerAskId) {
      const ask = asks.get(group.ownerAskId);
      if (!ask || ask.collisionGroupId !== group.id) add(errors, 'AE_COLLISION_OWNER_ASK_INVALID', `${path}.ownerAskId`, 'Ambiguous group requires one group-scoped owner ask.');
      if (array(group.expectedLinks).length > 0) add(errors, 'AE_COLLISION_AMBIGUOUS_LINK_FORBIDDEN', `${path}.expectedLinks`, 'An owner-owned collision group must not also link deterministically.');
    } else {
      const linkedDocuments = new Set(array(group?.expectedLinks).map(({ documentHandle }) => documentHandle));
      const linkedCandidates = new Set(array(group?.expectedLinks).map(({ candidateHandle }) => candidateHandle));
      if (documentHandles.some((handle) => !linkedDocuments.has(handle)) || candidateHandles.some((handle) => !linkedCandidates.has(handle))) {
        add(errors, 'AE_COLLISION_GROUP_RESOLUTION_INCOMPLETE', `${path}.expectedLinks`, 'Resolved collision groups must resolve every hydrated document and candidate as a whole.');
      }
    }
    if (array(group?.settlementGroupIds).some((id) => !settlementGroups.has(id))) add(errors, 'AE_COLLISION_SETTLEMENT_GROUP_INVALID', `${path}.settlementGroupIds`, 'Collision group references an unknown settlement group.');
  }
}

function validateArrivalOrders(value, groups, errors) {
  for (const [position, entry] of array(value).entries()) {
    const path = `cashCommerce.arrivalOrderCases[${position}]`;
    if (array(entry?.targetGroupIds).length === 0 || array(entry?.targetGroupIds).some((id) => !groups.has(id))) add(errors, 'AE_ARRIVAL_TARGET_INVALID', `${path}.targetGroupIds`, 'Arrival case requires known targets.');
    const names = array(entry?.orders).map(({ name }) => name);
    if (!same([...names].sort(), [...ARRIVAL_ORDER_NAMES].sort())) add(errors, 'AE_ARRIVAL_ORDERS_INCOMPLETE', `${path}.orders`, 'Document-first, bank-first, posting-first, and late-document orders are required.');
    for (const order of array(entry?.orders)) {
      if (!ARRIVAL_ORDER_NAMES.has(order?.name) || !same([...array(order?.stages)].sort(), [...ARRIVAL_STAGES].sort())) add(errors, 'AE_ARRIVAL_STAGE_SET_INVALID', `${path}.orders`, 'Every arrival order must expose the same complete stage set.');
    }
  }
}

function validateOwnTransfers(value, events, accounts, errors) {
  for (const [position, entry] of array(value).entries()) {
    const path = `cashCommerce.ownAccountTransfers[${position}]`;
    if (entry?.fromAccountId === entry?.toAccountId || !accounts.has(entry?.fromAccountId) || !accounts.has(entry?.toAccountId)) add(errors, 'AE_OWN_TRANSFER_ACCOUNTS_INVALID', path, 'Own transfer requires distinct known accounts.');
    if (accounts.get(entry?.fromAccountId)?.legalEntityId !== entry?.legalEntityId || accounts.get(entry?.toAccountId)?.legalEntityId !== entry?.legalEntityId) add(errors, 'AE_CROSS_ENTITY_LINK', path, 'Both transfer accounts must belong to the same entity.');
    const event = events.get(entry?.eventId);
    if (event?.type !== 'own_account_transfer' || toFils(entry?.amount) === null || event?.amount !== entry?.amount || event?.currency !== entry?.currency) add(errors, 'AE_OWN_TRANSFER_EVENT_INVALID', path, 'Own transfer requires a matching exact-money source event.');
  }
}

function validateBouncedCheques(value, events, accounts, errors) {
  for (const [position, entry] of array(value).entries()) {
    const path = `cashCommerce.bouncedCheques[${position}]`;
    const receipt = events.get(entry?.receiptEventId);
    const bounce = events.get(entry?.bounceEventId);
    if (receipt?.type !== 'cheque_received' || bounce?.type !== 'cheque_bounced' || !array(bounce?.causalParents).includes(receipt?.id)) add(errors, 'AE_BOUNCED_CHEQUE_CAUSALITY_INVALID', path, 'Bounce must reverse a received cheque causally.');
    if (!accounts.has(entry?.accountId) || accounts.get(entry?.accountId)?.legalEntityId !== entry?.legalEntityId) add(errors, 'AE_BOUNCED_CHEQUE_ACCOUNT_INVALID', path, 'Cheque account must belong to the same entity.');
    if (toFils(entry?.amount) === null || receipt?.amount !== entry?.amount || bounce?.amount !== `-${entry?.amount}` || receipt?.currency !== entry?.currency || bounce?.currency !== entry?.currency) add(errors, 'AE_BOUNCED_CHEQUE_AMOUNT_INVALID', path, 'Bounce must exactly reverse the cheque amount and currency.');
  }
}

function validateFeeVatPolicy(policy, policySources, events, errors) {
  const source = array(policySources).find(({ id }) => id === policy?.policySourceId);
  if (!source || source.authority !== 'Federal Tax Authority' || !ISO_DAY.test(source.effectiveFrom ?? '') || !ISO_DAY.test(source.asOf ?? '')) add(errors, 'AE_FEE_VAT_POLICY_SOURCE_REQUIRED', 'cashCommerce.feeVatPolicy.policySourceId', 'Fee VAT policy requires an effective-dated FTA primary source.');
  if (policy?.rate !== '0.050000' || !ISO_DAY.test(policy?.effectiveFrom ?? '') || policy?.effectiveFrom !== source?.effectiveFrom) add(errors, 'AE_FEE_VAT_POLICY_INVALID', 'cashCommerce.feeVatPolicy', 'Fee VAT policy must state an effective-dated exact 5% rate aligned to its source.');
  for (const event of worldEvents(events)) {
    if (event.type !== 'processor_fee_vat') continue;
    const fee = events.get(event.feeEventId);
    if (fee?.type !== 'processor_fee') add(errors, 'AE_FEE_VAT_FEE_SOURCE_REQUIRED', `events.${event.id}.feeEventId`, 'Fee VAT must identify its fee.');
    const feeFils = toFils(fee?.settlementAmount);
    const vatFils = toFils(event.settlementAmount);
    const vatNumerator = feeFils === null ? null : BigInt(feeFils) * 50_000n;
    if (feeFils === null || vatFils === null || vatNumerator % 1_000_000n !== 0n || vatNumerator / 1_000_000n !== BigInt(vatFils)) add(errors, 'AE_FEE_VAT_AMOUNT_INVALID', `events.${event.id}.settlementAmount`, 'Fee VAT must be exact at the sourced rate.');
    if (event.policySourceId !== policy?.policySourceId || event.policyEffectiveDate !== policy?.effectiveFrom) add(errors, 'AE_FEE_VAT_POLICY_LINK_INVALID', `events.${event.id}`, 'Fee VAT must carry source and effective date.');
  }
}

function validateSyntheticLayouts(value, artifacts, errors) {
  for (const [position, layout] of array(value).entries()) {
    const path = `cashCommerce.commercialLayouts[${position}]`;
    const artifact = artifacts.get(layout?.artifactId);
    if (!artifact || layout?.synthetic !== true || layout?.calibrationUse !== 'forbidden' || artifact.synthetic !== true) add(errors, 'AE_COMMERCIAL_LAYOUT_MUST_BE_SYNTHETIC', path, 'Commercial layouts remain synthetic and forbidden for calibration until AE-8.');
  }
}

function validTerminalProjection(actual, expected) {
  if (actual?.projector !== 'reconcileConvergenceState' || !same(actual, expected)) return false;
  return array(actual.items).every((item) => TERMINAL_STATES.has(item.state)
    && (item.state !== 'on_owner' || (item.responsibleActor === 'owner' && nonEmpty(item.askId))));
}

function terminal(itemId, state, askId = null) {
  return state === 'on_owner'
    ? { itemId, state, responsibleActor: 'owner', askId }
    : { itemId, state };
}

function evaluation(status, errors, failures) {
  const body = { version: AE_CASH_COMMERCE_VERSION, status, errors, failures };
  return freeze({ ...body, receiptDigest: digest(body) });
}

function result(errors, extra = {}) {
  return freeze({ ok: errors.length === 0, version: AE_CASH_COMMERCE_VERSION, errors, ...extra });
}

function fail(failures, code, subjectId) {
  if (!failures.some((entry) => entry.code === code && entry.subjectId === subjectId)) failures.push({ code, subjectId });
}

function add(errors, code, path, message) { errors.push({ code, path, message }); }
function toFils(value) {
  if (typeof value !== 'string' || !EXACT_MONEY.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split('.');
  const unsignedFils = (BigInt(whole) * 100n) + BigInt(fraction);
  const signedFils = negative ? -unsignedFils : unsignedFils;
  if (signedFils > BigInt(Number.MAX_SAFE_INTEGER) || signedFils < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(signedFils);
}
function digest(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function index(value) { return new Map(array(value).filter(plain).map((entry) => [entry.id ?? entry.groupId ?? entry.eventId, entry])); }
function worldEvents(events) { return [...events.values()]; }
function sorted(value) { return [...array(value)].sort((left, right) => String(left.id ?? left.groupId ?? left.eventId).localeCompare(String(right.id ?? right.groupId ?? right.eventId))); }
function compareLink(left, right) { return `${left.documentHandle}/${left.candidateHandle}`.localeCompare(`${right.documentHandle}/${right.candidateHandle}`); }
function array(value) { return Array.isArray(value) ? value : []; }
function currency(value) { return typeof value === 'string' && /^[A-Z]{3}$/.test(value); }
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function same(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
