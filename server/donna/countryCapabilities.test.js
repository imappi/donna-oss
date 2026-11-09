import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { COUNTRY_PACKS_ROOT, CountryCapabilityError, discoverCountryCapabilities, resolveCountryCapability } from './countryCapabilities.js';
import { CODING_POLICY_REGISTRY, resolveCodingPolicy } from './codingPolicy.js';
import { SG_CODING_POLICY } from './singapore/codingPolicy.js';
import { discoverOutboundPacks, listAvailablePackIds, loadOutboundPack, resolvePackIdForJurisdiction,
  homeCurrencyForJurisdiction, materialityCeilingForJurisdiction, accountingSystemAvailability } from './outbound/packs.js';
import { runStatutoryObligationSweep } from './outbound/statutoryObligations.js';
import { dateFormatConventionForJurisdiction } from './jurisdictionDate.js';
import { resolveOwnerInvoiceSellerContext } from './ownerInvoiceSellerContext.js';

const withPacks = async (run) => {
  const packsRoot = mkdtempSync(path.join(tmpdir(), 'donna-country-capabilities-'));
  try { await run(packsRoot); } finally { rmSync(packsRoot, { recursive: true, force: true }); }
};
const write = (packsRoot, country, name, value) => {
  mkdirSync(path.join(packsRoot, country), { recursive: true });
  writeFileSync(path.join(packsRoot, country, name), typeof value === 'string' ? value : JSON.stringify(value));
};
const register = (packsRoot, country) => write(packsRoot, country, 'capabilities.json', { outbound: { manifest: 'manifest.json' } });
const stage = (packsRoot, country, base = 'us') => {
  const manifest = structuredClone(loadOutboundPack(base));
  manifest.pack.id = country;
  manifest.pack.country = country.toUpperCase();
  register(packsRoot, country);
  write(packsRoot, country, 'manifest.json', manifest);
  return manifest;
};

test('country capabilities keep six coding registrations distinct from five outbound packs', () => {
  const coding = discoverCountryCapabilities('coding');
  assert.deepEqual(coding.unavailable, []);
  assert.deepEqual(coding.registrations.map((entry) => entry.jurisdiction), ['ae', 'au', 'fi', 'gb', 'sg', 'us']);
  assert.deepEqual(listAvailablePackIds(), ['ae', 'fi', 'gb', 'sg', 'us']);
  for (const entry of coding.registrations) {
    assert.equal(entry.implementation, CODING_POLICY_REGISTRY[entry.jurisdiction]);
    assert.equal(resolveCodingPolicy({ jurisdiction: entry.jurisdiction, businessDate: '2026-09-05' }).jurisdiction, entry.jurisdiction);
  }
  for (const jurisdiction of ['au']) {
    assert.equal(resolveCountryCapability({ jurisdiction, operation: 'outbound' }), null);
    assert.equal(resolvePackIdForJurisdiction(jurisdiction), null);
    assert.throws(() => loadOutboundPack(jurisdiction), { code: 'country_capability_unsupported' });
  }
  for (const jurisdiction of [null, '', 'zz', 'nonsense']) {
    for (const operation of ['coding', 'outbound']) {
      assert.equal(resolveCountryCapability({ jurisdiction, operation }), null);
    }
    assert.equal(resolvePackIdForJurisdiction(jurisdiction), null);
  }
  assert.throws(() => resolveCountryCapability({ jurisdiction: 'sg' }), { code: 'country_operation_invalid' });
});

test('a new coding-only country directory never advertises outbound; explicit registration enables the real loader', async () => {
  await withPacks(async (packsRoot) => {
    const codingRegistry = { ...CODING_POLICY_REGISTRY,
      zz: { ...SG_CODING_POLICY, jurisdiction: 'zz', id: 'fixture_coding' } };
    // Even a complete manifest in a directory is not capability registration.
    const manifest = structuredClone(loadOutboundPack('us'));
    manifest.pack.id = 'zz';
    manifest.pack.country = 'ZZ';
    write(packsRoot, 'zz', 'manifest.json', manifest);
    assert.equal(resolveCodingPolicy({ jurisdiction: 'zz' }, { registry: codingRegistry }).policyId, 'fixture_coding');
    assert.equal(resolveCountryCapability({ jurisdiction: 'zz', operation: 'coding' }, { packsRoot, codingRegistry }).implementation, codingRegistry.zz);
    assert.deepEqual(listAvailablePackIds({ packsRoot }), []);
    assert.equal(resolvePackIdForJurisdiction('zz', { packsRoot }), null);
    assert.throws(() => loadOutboundPack('zz', { packsRoot }), { code: 'country_capability_unsupported' });
    register(packsRoot, 'zz');
    assert.deepEqual(listAvailablePackIds({ packsRoot }), ['zz']);
    assert.equal(resolvePackIdForJurisdiction('zz', { packsRoot }), 'zz');
    assert.equal(loadOutboundPack('zz', { packsRoot }).currency.home, manifest.currency.home);
    assert.equal(dateFormatConventionForJurisdiction('zz', { packsRoot }), manifest.locale.date_format);
    assert.equal(resolveOwnerInvoiceSellerContext({ jurisdiction: 'zz', profile: {} }, { packsRoot }).packId, 'zz');
    // Removing registration also disarms a cached implementation.
    unlinkSync(path.join(packsRoot, 'zz', 'capabilities.json'));
    assert.throws(() => loadOutboundPack('zz', { packsRoot }), { code: 'country_capability_unsupported' });
  });
});

test('malformed declared capability fails visibly and cannot affect a healthy country or choose a default', async () => {
  await withPacks(async (packsRoot) => {
    stage(packsRoot, 'us');
    for (const malformed of ['{', null, [], { outbound: true }, { outbound: null },
      { outbound: { manifest: '../us/manifest.json' } }, { outbound: { manifest: 'manifest.json', extra: true } },
      { outbond: { manifest: 'manifest.json' } }]) {
      write(packsRoot, 'gb', 'capabilities.json', malformed);
      assert.throws(() => resolvePackIdForJurisdiction('gb', { packsRoot }), { code: 'country_capability_invalid' });
      assert.throws(() => loadOutboundPack('gb', { packsRoot }), CountryCapabilityError);
      assert.throws(() => listAvailablePackIds({ packsRoot }), CountryCapabilityError);
      assert.equal(loadOutboundPack('us', { packsRoot }).pack.id, 'us');
      assert.equal(resolvePackIdForJurisdiction('us', { packsRoot }), 'us');
      const discovered = discoverOutboundPacks({ packsRoot });
      assert.deepEqual(discovered.packIds, ['us']);
      assert.equal(discovered.unloadable[0].packId, 'gb');
      assert.equal(discovered.unloadable[0].code, 'country_capability_invalid');
      assert.equal(homeCurrencyForJurisdiction('gb', { packsRoot }), null);
      assert.equal(materialityCeilingForJurisdiction('gb', { packsRoot }), null);
      assert.equal(dateFormatConventionForJurisdiction('gb', { packsRoot }), null);
      assert.deepEqual(accountingSystemAvailability({ jurisdiction: 'gb', accountingSystem: 'xero', packsRoot }),
        { verdict: 'undecidable', reason: 'pack_unloadable' });
      assert.equal(resolveOwnerInvoiceSellerContext({ jurisdiction: 'gb', profile: {} }, { packsRoot }).packId, null);
    }
  });
});

test('declared but missing/invalid outbound implementations refuse the full contract', async () => {
  await withPacks(async (packsRoot) => {
    register(packsRoot, 'zz');
    assert.throws(() => loadOutboundPack('zz', { packsRoot }), /unreadable/);
    write(packsRoot, 'zz', 'manifest.json', { pack: { id: 'zz', country: 'ZZ', version: 1 } });
    assert.throws(() => loadOutboundPack('zz', { packsRoot }), /invalid/);
  });
});

test('real sweep discovery reports broken declarations and implementations while dispatching healthy peers', async () => {
  await withPacks(async (packsRoot) => {
    stage(packsRoot, 'fi', 'fi');
    write(packsRoot, 'zz', 'capabilities.json', { outbound: false });
    register(packsRoot, 'xy'); // declared implementation is missing
    mkdirSync(path.join(packsRoot, 'sg')); // coding-only country is not unsurveyed outbound
    const called = [];
    const result = await runStatutoryObligationSweep({ packsRoot, bindings: {
      fi_alv_threshold_escalation: { run: async () => { called.push('alv'); return { done: true }; } },
      fi_scope_drift_ask_delivery: { run: async () => { called.push('scope'); return { done: true }; } }
    } });
    assert.deepEqual(called.sort(), ['alv', 'scope']);
    assert.equal(result.ran, 2);
    assert.deepEqual(result.unloadable.map((row) => row.packId).sort(), ['xy', 'zz']);
    assert.ok(!result.unsurveyed.some((row) => row.packId === 'sg'));
  });
});

test('capability inventory filesystem failure is a visible operational failure', () => {
  const packsRoot = path.join(COUNTRY_PACKS_ROOT, 'missing-capability-test-root');
  assert.throws(() => listAvailablePackIds({ packsRoot }), { code: 'country_capability_unavailable' });
  const discovery = discoverOutboundPacks({ packsRoot });
  assert.deepEqual(discovery.packIds, []);
  assert.equal(discovery.unloadable[0].code, 'country_capability_unavailable');
});

test('every module on the coding/pack composition import cycle can be imported first', () => {
  // Market coding policies come from the registry's own imports, so a new
  // market joins this proof without editing it.
  const registrySource = readFileSync(new URL('codingPolicyRegistry.js', import.meta.url), 'utf8');
  const policies = [...registrySource.matchAll(/^import .* from '\.\/(.+\/codingPolicy\.js)';$/gm)].map((match) => match[1]);
  assert.deepEqual(policies.length, 6);
  for (const entry of ['codingPolicyRegistry.js', 'countryCapabilities.js', 'outbound/packs.js', ...policies]) {
    const source = `await import(${JSON.stringify(new URL(entry, import.meta.url).href)});
      const { resolveCodingPolicy, CODING_POLICY_REGISTRY } = await import(${JSON.stringify(new URL('codingPolicy.js', import.meta.url).href)});
      const keys = Object.keys({ ...CODING_POLICY_REGISTRY });
      if (keys.join() !== 'sg,fi,gb,ae,us,au' || !Object.isFrozen(CODING_POLICY_REGISTRY)
        || Object.values(CODING_POLICY_REGISTRY).some((value) => !value)) throw new Error('registry shape changed: ' + keys);
      for (const jurisdiction of keys) resolveCodingPolicy({ jurisdiction });`;
    execFileSync(process.execPath, ['--input-type=module', '-e', source], { stdio: 'pipe' });
  }
});
