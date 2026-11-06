// The country-pack chart-of-accounts leg (contract gap 7).
//
// THE WRONGNESS IT ENDS: a client with no synced chart of accounts was coded
// against XERO_ACCOUNT_OPTIONS — a Singapore-flavoured list carrying 'CPF
// payable', no VAT/ALV/PAYE account, no utilities and no motor expenses — in
// EVERY market, Finland and the UK included. This file pins that each pack now
// declares its own fallback vocabulary as data, that core routes to it by the
// resolved country policy, with no missing-jurisdiction fallback.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadOutboundPack, listAvailablePackIds, fallbackAccountsForPack,
  fallbackAccountNamesForPack, suspenseAccountNameForPack, SUSPENSE_ACCOUNT_ROLE,
  JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY, validateOutboundPackManifest
} from './outbound/packs.js';
import {
  accountOptionsForClient, fallbackAccountOptionsForClient,
  suspenseAccountNameForClient
} from './transactionLlm.js';
import { SG_CODING_POLICY } from './singapore/codingPolicy.js';
const XERO_ACCOUNT_OPTIONS = SG_CODING_POLICY.accountOptions;
const LEGACY_SUSPENSE_ACCOUNT_NAME = SG_CODING_POLICY.suspenseAccountName;
import { isAccountRole, roleMeta } from './accountRoles.js';

// ── Every pack declares a usable palette ────────────────────────────────────

test('every authored pack declares a fallback chart with canonical roles', () => {
  for (const packId of listAvailablePackIds()) {
    const pack = loadOutboundPack(packId, { bypassCache: true });
    const accounts = fallbackAccountsForPack(pack);
    assert.ok(accounts.length >= 20, `pack '${packId}' palette is too thin (${accounts.length})`);
    for (const account of accounts) {
      assert.ok(account.name && account.name.trim(), `pack '${packId}' has an unnamed account`);
      assert.ok(isAccountRole(account.role), `pack '${packId}' account '${account.name}' has role '${account.role}'`);
    }
    // The unknown-line terminal exists exactly once and is reachable by name.
    assert.equal(accounts.filter((a) => a.role === SUSPENSE_ACCOUNT_ROLE).length, 1);
    assert.ok(suspenseAccountNameForPack(pack));
  }
});

test('no pack fallback carries another market\'s statutory account (the CPF-payable bug)', () => {
  // The specific live wrongness: a Singapore statutory payroll account offered
  // to Finnish and British businesses. Assert it market by market rather than
  // globally, so re-adding it to an actual SG pack later stays possible.
  for (const packId of ['fi', 'gb', 'us', 'ae']) {
    const names = fallbackAccountNamesForPack(loadOutboundPack(packId, { bypassCache: true }))
      .map((n) => n.toLowerCase());
    assert.ok(!names.includes('cpf payable'), `pack '${packId}' offers Singapore's CPF payable`);
  }
});

test('each market\'s palette carries its OWN tax and payroll statutory accounts', () => {
  const named = (packId) => fallbackAccountNamesForPack(loadOutboundPack(packId, { bypassCache: true }));
  // FI: the ALV settlement account under the exact name the FI posting path
  // already resolves (finland/alvCodes FINLAND_ALV_SETTLEMENT_ACCOUNT.name) —
  // renaming it here would break that resolution.
  assert.ok(named('fi').includes('Suoritettava arvonlisävero'));
  // GB: VAT, corporation tax and PAYE/NIC are separately assessed, separately
  // paid and separately reconciled, so each gets its own account.
  for (const account of ['VAT payable', 'Corporation tax payable', 'PAYE and National Insurance payable']) {
    assert.ok(named('gb').includes(account), `GB palette missing '${account}'`);
  }
  assert.ok(named('us').includes('Sales tax payable'));
  // AE: VAT and corporate tax are separately assessed and paid (the GB
  // lesson); the statutory payroll liability is end-of-service gratuity —
  // there is no PAYE/CPF-shaped withholding to name.
  for (const account of ['VAT payable', 'Corporate tax payable', 'End of service benefits payable']) {
    assert.ok(named('ae').includes(account), `AE palette missing '${account}'`);
  }
});

test('a pack declaring an unknown role or no suspense terminal refuses at LOAD', () => {
  const base = loadOutboundPack('gb', { bypassCache: true });
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const badRole = clone(base);
  badRole.chart_of_accounts.fallback_accounts[0].role = 'expense.artisanal_vibes';
  assert.equal(validateOutboundPackManifest(badRole).ok, false);

  const noSuspense = clone(base);
  noSuspense.chart_of_accounts.fallback_accounts =
    noSuspense.chart_of_accounts.fallback_accounts.filter((a) => a.role !== SUSPENSE_ACCOUNT_ROLE);
  assert.equal(validateOutboundPackManifest(noSuspense).ok, false);

  const twoSuspense = clone(base);
  twoSuspense.chart_of_accounts.fallback_accounts.push({ name: 'Holding pen', role: SUSPENSE_ACCOUNT_ROLE });
  assert.equal(validateOutboundPackManifest(twoSuspense).ok, false);

  const dupeName = clone(base);
  dupeName.chart_of_accounts.fallback_accounts.push({ name: 'travel', role: 'expense.travel' });
  assert.equal(validateOutboundPackManifest(dupeName).ok, false);

  const missing = clone(base);
  delete missing.chart_of_accounts;
  assert.equal(validateOutboundPackManifest(missing).ok, false);
});

// ── The routing ─────────────────────────────────────────────────────────────

test('only an explicit SG client receives the legacy Singapore palette', () => {
  assert.deepEqual(fallbackAccountOptionsForClient({ jurisdiction: 'sg' }), XERO_ACCOUNT_OPTIONS);
  assert.deepEqual(accountOptionsForClient([], { jurisdiction: 'sg' }), XERO_ACCOUNT_OPTIONS);
  assert.equal(suspenseAccountNameForClient({ jurisdiction: 'sg' }), LEGACY_SUSPENSE_ACCOUNT_NAME);
  for (const profile of [{}, { taxVocabulary: 'gb_vat' }, { accountPalette: 'sg' }]) {
    assert.throws(() => accountOptionsForClient([], profile), { code: 'jurisdiction_unresolved' });
  }
});

test('a routed client codes against its own market\'s palette', () => {
  const gb = accountOptionsForClient([], { jurisdiction: 'gb' });
  assert.ok(gb.includes('VAT payable'));
  assert.ok(!gb.includes('CPF payable'), 'the Singapore list must not reach a GB client');

  const fi = accountOptionsForClient([], { jurisdiction: 'fi' });
  assert.ok(fi.includes('Suoritettava arvonlisävero'));
  assert.ok(!fi.includes('CPF payable'));

  const us = accountOptionsForClient([], { jurisdiction: 'us' });
  assert.ok(us.includes('Operating supplies'),
    'an apiary-supplies receipt must have a truthful operating-cost answer available');
  assert.ok(us.includes('Motor expenses'),
    'fuel and vehicle costs must not be forced into the generic travel bucket');
  assert.ok(!us.includes('CPF payable'), 'the Singapore list must not reach a US client');

  // Both markets, one engine — the parallel-build test. Neither is served by a
  // branch the other lacks.
  for (const packId of ['fi', 'gb', 'us', 'ae']) {
    const menu = accountOptionsForClient([], { jurisdiction: packId });
    assert.deepEqual(menu, fallbackAccountNamesForPack(loadOutboundPack(packId, { bypassCache: true })));
    assert.ok(menu.includes('Suspense'));
    assert.ok(menu.includes('Operating supplies'),
      'trade consumables must not be forced into office expense or inventory COGS');
    assert.ok(menu.includes('Utilities') && menu.includes('Motor expenses'),
      'both markets need premises and vehicle running costs the SG list never had');
  }
});

test('unknown jurisdiction refuses, and legacy palette markers cannot override identity', () => {
  assert.throws(() => fallbackAccountOptionsForClient({ jurisdiction: 'zz' }), { code: 'jurisdiction_unsupported' });
  for (const marker of ['sg', 'zz', 'nonsense', '', null]) {
    const options = fallbackAccountOptionsForClient({ jurisdiction: 'gb', accountPalette: marker });
    assert.ok(options.includes('VAT payable'));
    assert.ok(!options.includes('CPF payable'));
  }
});

test('a synced chart still wins, and gains the pack\'s suspense terminal', () => {
  const synced = accountOptionsForClient(
    [{ name: 'Turnover' }, { name: 'Wages' }], { jurisdiction: 'gb' });
  assert.deepEqual(synced, ['Turnover', 'Wages', 'Suspense']);
  assert.ok(!synced.includes('VAT payable'), 'the fallback must not leak into a synced chart');
});

// ── Couplings a future change must not break silently ───────────────────────

test('every pack suspense account is still literally named Suspense', () => {
  // parseDocumentsDb.js keys on the lowercase literal 'suspense'
  // (STRONG_VERDICT_SKIP_ACCOUNTS) and that file is isolation-listed. The
  // SCHEMA permits any name for the control.suspense role; the DATA must not
  // use that freedom until those literals are pack-routed too. Changing a
  // pack's suspense name without clearing that coupling is a silent
  // auto-apply regression, so it trips here instead.
  for (const packId of listAvailablePackIds()) {
    assert.equal(
      suspenseAccountNameForPack(loadOutboundPack(packId, { bypassCache: true })),
      LEGACY_SUSPENSE_ACCOUNT_NAME,
      `pack '${packId}' renamed its suspense account — see parseDocumentsDb STRONG_VERDICT_SKIP_ACCOUNTS`
    );
  }
});

// Real country-menu verdict minting, including GB-only accounts, is exercised
// through the locked parser writer in verdictMintPolicyPgLifecycle.test.js.

test('the palette flag is a config-plane key, not an env pair', () => {
  // The rollout-flags rail: a client name in an env var is the anti-pattern.
  assert.equal(JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY, 'JURISDICTION_ACCOUNT_PALETTE');
  assert.equal(process.env[`${JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY}_CLIENTS`], undefined);
});

test('the roles added for the packs are well-formed expenses', () => {
  for (const role of ['expense.utilities', 'expense.motor', 'expense.repairs_maintenance', 'expense.fines_penalties']) {
    assert.deepEqual(
      { class: roleMeta(role).class, normal_balance: roleMeta(role).normal_balance },
      { class: 'expense', normal_balance: 'debit' }
    );
  }
});
