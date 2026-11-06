import assert from 'node:assert/strict'; import test from 'node:test';
import { ACCOUNT_ROLES, roleForSeedName } from '../accountRoles.js';
import { isSingletonRole } from '../canonicalRoleResolution.js';
import { GB_DEFAULT_CHART, GB_DEFAULT_CHART_PROVENANCE, GB_SOLE_TRADER_DEFAULT_CHART, gbDefaultChartForEntityType, resolveGbDefaultAccount } from './defaultChart.js';
test('GB chart is an optional Donna default, not statutory', () => { assert.equal(GB_DEFAULT_CHART_PROVENANCE.kind, 'donna_native_default'); assert.equal(GB_DEFAULT_CHART_PROVENANCE.statutory, false); });
test('GB default has unique codes and exactly one canonical VAT control', () => { assert.equal(new Set(GB_DEFAULT_CHART.map(({ code }) => code)).size, GB_DEFAULT_CHART.length); const controls = GB_DEFAULT_CHART.filter(({ canonical_role }) => canonical_role === 'liability.sales_tax_payable'); assert.equal(controls.length, 1); assert.equal(controls[0].normal_balance, 'credit'); assert.equal(resolveGbDefaultAccount(controls[0].code), controls[0]); });
test('sole-trader chart carries drawings/capital equity and omits Ltd-only tax/share accounts', () => { assert.equal(gbDefaultChartForEntityType('gb-ltd'), GB_DEFAULT_CHART); assert.equal(gbDefaultChartForEntityType('gb-sole-trader'), GB_SOLE_TRADER_DEFAULT_CHART); assert.ok(GB_SOLE_TRADER_DEFAULT_CHART.some((account) => account.canonical_role === 'equity.owner_drawings')); assert.ok(!GB_SOLE_TRADER_DEFAULT_CHART.some((account) => ['Share capital', 'Corporation tax payable'].includes(account.name_en))); });

test('owner capital introduced carries its own role, not a second retained earnings', () => {
  const ownerCapital = GB_SOLE_TRADER_DEFAULT_CHART.find((account) => account.name_en === 'Owner capital introduced');
  assert.equal(ownerCapital.canonical_role, 'equity.owner_capital');
  assert.equal(roleForSeedName(ownerCapital.name_en), 'equity.owner_capital');
  const retained = GB_SOLE_TRADER_DEFAULT_CHART.filter((account) => account.canonical_role === 'equity.retained_earnings');
  assert.equal(retained.length, 1);
});

// The seam that would have caught the original bug: the sole-trader chart put
// TWO accounts on equity.retained_earnings — a cutover singleton, so an opening
// balance could never land on it. No seeded chart variant may place two
// accounts on any role a posting or cutover path resolves uniquely.
test('no chart variant places two accounts on one posting/cutover-singleton role', () => {
  for (const variant of [GB_DEFAULT_CHART, GB_SOLE_TRADER_DEFAULT_CHART]) {
    const counts = new Map();
    for (const { canonical_role: role } of variant) {
      if (role && isSingletonRole(role)) counts.set(role, (counts.get(role) || 0) + 1);
    }
    for (const [role, count] of counts) assert.equal(count, 1, `singleton role ${role} held by ${count} accounts`);
  }
});
test('every GB default account matches ledger account shape', () => { for (const account of GB_DEFAULT_CHART) { assert.match(account.code, /^\d{4}$/); assert.ok(account.name_en); assert.ok(account.account_type); assert.ok(['debit', 'credit'].includes(account.normal_balance)); } });

test('every declared canonical role exists in the shared engine vocabulary', () => { for (const { canonical_role: role } of [...GB_DEFAULT_CHART, ...GB_SOLE_TRADER_DEFAULT_CHART]) if (role) assert.ok(ACCOUNT_ROLES[role], `unknown canonical role: ${role}`); });
