import test from 'node:test';
import assert from 'node:assert/strict';
// The coding-policy registry first: finland/codingPolicy.js has a standing
// import cycle through it when it is the first module loaded.
import '../codingPolicyRegistry.js';
import { FI_OY_BIRTH_CHART, FI_OY_PALETTE_CODES, FI_PROVISIONING_POLICY } from './provisioningPolicy.js';
import { FI_CODING_POLICY } from './codingPolicy.js';
import { fallbackAccountsForPack, loadOutboundPack } from '../outbound/packs.js';
import { resolveAccount } from './tilikartta.js';
import { isAccountRole } from '../accountRoles.js';
import { marketBirthChart, marketHasNativeDefaultChart } from '../defaultCharts.js';

const ordinaryPalette = () => {
  const { excludedAccountNames } = FI_CODING_POLICY.loadAccountPalette({ entityType: 'fi-oy' });
  return fallbackAccountsForPack(loadOutboundPack('fi')).filter(({ name }) => !excludedAccountNames.includes(name));
};

test('every palette name an Oy codes against has exactly one born, coded home', () => {
  const palette = ordinaryPalette();
  assert.deepEqual(Object.keys(FI_OY_PALETTE_CODES).sort(), palette.map(({ name }) => name).sort());
  for (const { name } of palette) {
    const homes = FI_OY_BIRTH_CHART.accounts.filter((row) => row.palette_name === name);
    assert.equal(homes.length, 1, name);
    assert.equal(homes[0].code, FI_OY_PALETTE_CODES[name]);
  }
});

test('the birth chart is coded, unique, statutory where it claims to be, and roles are real', () => {
  const codes = FI_OY_BIRTH_CHART.accounts.map((row) => row.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const row of FI_OY_BIRTH_CHART.accounts) {
    assert.match(row.code, /^\d{4}$/);
    assert.ok(row.name && row.name === row.name.trim());
    assert.ok(['debit', 'credit'].includes(row.normal_balance));
    if (row.canonical_role !== null) assert.ok(isAccountRole(row.canonical_role), row.code);
    // Statutory rows come from tilikartta.js unchanged; only the clearing
    // accounts sit outside the KPA lines (and are placed by role).
    if (row.statutory_group) {
      const reference = resolveAccount(row.code) || null;
      if (reference) assert.equal(reference.name_fi, row.name, row.code);
    } else assert.equal(row.account_type, 'unknown', row.code);
  }
  for (const excluded of ['1900', '1910', '2880', '4090']) assert.ok(!codes.includes(excluded), excluded);
});

test('only a new Finnish Oy has a birth chart; no market gains a default chart', () => {
  assert.equal(FI_PROVISIONING_POLICY.birthChart({ entityType: 'fi-oy' }), FI_OY_BIRTH_CHART);
  assert.equal(marketBirthChart('fi', 'fi-oy'), FI_OY_BIRTH_CHART);
  for (const [jurisdiction, entityType] of [['fi', 'fi-toiminimi'], ['gb', 'gb-ltd'], ['sg', 'sg-pte'], ['us', 'us-llc'], ['ae', 'ae-llc']]) {
    assert.equal(marketBirthChart(jurisdiction, entityType), null, `${jurisdiction}/${entityType}`);
  }
  assert.equal(marketHasNativeDefaultChart('fi'), false, 'existing FI books keep the palette path');
});
