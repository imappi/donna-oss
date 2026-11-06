import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadOutboundPack, validateOutboundPackManifest } from '../outbound/packs.js';
import { selectNativeChartForPack, nativeChartForPack } from '../outbound/nativeChart.js';
import { selectSgProvisionalChart, SFRS_CHART, resolveSgAccount } from './sfrsChart.js';
import { resolveProvisioningPolicy, resolveProvisioningCertificateChart } from '../provisioningPolicyRegistry.js';
import { marketHasNativeDefaultChart } from '../defaultCharts.js';
import { deriveRequiredRolesForClient } from '../canonicalRoleResolutionDb.js';
import { NATIVE_GST_REGISTRATION_POLICY } from './gstRegistration.js';

const pack = loadOutboundPack('sg');
const identity = { jurisdiction: 'sg', legalForm: 'sg-pte' };
const input = { ...identity, selectionId: 'sg_pte_provisional' };
const pins = JSON.parse(readFileSync(new URL('./fixtures/provisionalChartBaseline.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('real pack → shared validator → SG and provisioning projection agree on exact provisional 58 rows', () => {
  assert.equal(validateOutboundPackManifest(pack).ok, true);
  const selection = selectNativeChartForPack(pack, input);
  assert.deepEqual(selectSgProvisionalChart(identity), selection);
  assert.deepEqual(resolveProvisioningPolicy('sg').provisionalChart(identity), selection);
  assert.equal(selection.native_chart_version, 2);
  assert.equal(selection.usage, 'reference_only');
  assert.equal(selection.selection_id, 'sg_pte_provisional');
  assert.equal(selection.selection_version, 1);
  assert.equal(selection.status, 'provisional');
  assert.deepEqual(selection.provenance, {kind:'authored_product_data', source_revision:pins.source_proposal_revision, review_status:'unreviewed'});
  assert.equal(selection.accounts.length, 58);
  assert.equal(digest(selection.accounts), pins.accounts_digest, 'independent proposal metadata and reserved-use pin');
  const native = nativeChartForPack(pack);
  assert.equal(native.usage, 'reference_only');
  assert.equal(native.account_sets.pte_launch_extensions.length, 17);
  assert.equal(digest(native.account_sets.pte_launch_extensions), pins.extensions_digest);
  assert.equal(Object.keys(native.selections.sg_pte_provisional.role_annotations).length, 11);
  assert.equal(digest(native.selections.sg_pte_provisional.role_annotations), pins.annotations_digest);
  const all = Object.values(native.account_sets).flat();
  assert.equal(all.length, 63);
  assert.equal(new Set(all.map(r => r.code)).size, 63);
  assert.equal(new Set(all.map(r => r.name_en.toLowerCase())).size, 63);
  assert.equal(Object.keys(selection.reporting_groups).length, 30);
  for (const row of [...native.account_sets.base, ...native.account_sets.sole_proprietor_equity, ...native.account_sets.llp_equity]) assert.equal(row.canonical_role, null);
  for (const code of ['1180','1400','1900','1910','2620','2951','3000','3200','3400','5300','5400']) assert.equal(selection.accounts.find(r => r.code === code).canonical_role, null, code);
  assert.equal(resolveSgAccount('3100'), null, 'reference lookup is not widened to the candidate');
});

test('reserved operations and nonposting uncertainty are declared without changing registration or account inventory', () => {
  const candidate = selectSgProvisionalChart(identity);
  assert.deepEqual(candidate.reserved_uses, {gst_control:['2950','2951'],period_close:['2371'],tax_classified_revenue:['3000','3200','3400']});
  assert.equal(candidate.ordinary_account_codes.length, 52);
  for (const code of Object.values(candidate.reserved_uses).flat()) assert.ok(!candidate.ordinary_account_codes.includes(code));
  assert.ok(candidate.ordinary_account_codes.includes('3100'));
  assert.deepEqual(candidate.unresolved_choice, {id:'unresolved',label:'Suspense — unresolved',posting:false});
  assert.ok(!candidate.accounts.some(r => /suspense|share premium|owner.*drawings/i.test(r.name_en)));
  for (const registration of [undefined, null, {status:'not_registered'}, {status:'registered',registered_from:'2026-09-01'}, {status:'invalid'}]) {
    for (const onDate of [undefined,'2026-08-31','2026-09-01','2027-01-01']) {
      assert.deepEqual(selectSgProvisionalChart({...identity, registration, onDate}), candidate, 'this operation cannot derive tax eligibility');
    }
  }
});

test('explicit identity and selection are required: no Pte default, aliases or foreign form', () => {
  for (const legalForm of [undefined,null,'','sg-llc','sg-sole-prop','sg-llp','gb-ltd','private limited company','SG-PTE']) {
    assert.throws(() => selectSgProvisionalChart({...identity,legalForm}), /identity unsupported/);
  }
  for (const jurisdiction of [undefined,null,'','SG','gb']) assert.throws(() => selectSgProvisionalChart({...identity,jurisdiction}), /identity unsupported/);
  assert.throws(() => selectSgProvisionalChart(), /identity unsupported/);
  for (const selectionId of [undefined,null,'','missing',['sg_pte_provisional']]) assert.throws(() => selectNativeChartForPack(pack,{...input,selectionId}), /selection unavailable/);
  const missing = structuredClone(pack); delete missing.chart_of_accounts.native_chart.selections;
  assert.equal(validateOutboundPackManifest(missing).ok, true, 'optional shared schema keeps reference v1 readable');
  assert.throws(() => selectNativeChartForPack(missing,input), /selection unavailable/);
  delete missing.chart_of_accounts.native_chart;
  assert.throws(() => selectNativeChartForPack(missing,input), /selection unavailable/);
});

test('malformed selection data refuses at the actual pack validation/read boundary', () => {
  const cases = [
    c => { c.selections = null; }, c => { c.selections = {}; },
    c => { c.selections.sg_pte_provisional.version = 0; },
    c => { c.selections.sg_pte_provisional.status = 'approved'; },
    c => { c.selections.sg_pte_provisional.activate = true; },
    c => { c.selections.sg_pte_provisional.jurisdiction = ''; },
    c => { c.selections.sg_pte_provisional.legal_form = 'gb-ltd'; },
    c => { delete c.selections.sg_pte_provisional.legal_form; },
    c => { delete c.account_sets.pte_launch_extensions; },
    c => { c.selections.sg_pte_provisional.account_sets = []; },
    c => { c.selections.sg_pte_provisional.account_sets.push('base'); },
    c => { c.selections.sg_pte_provisional.account_sets.push('missing'); },
    c => { c.selections.sg_pte_provisional.role_annotations = null; },
    c => { c.selections.sg_pte_provisional.role_annotations['2051'] = 'equity.owner_drawings'; },
    c => { c.selections.sg_pte_provisional.role_annotations['2000'] = 'invented.role'; },
    c => { c.selections.sg_pte_provisional.reserved_uses = null; },
    c => { c.selections.sg_pte_provisional.reserved_uses.gst_control.push('2051'); },
    c => { c.selections.sg_pte_provisional.reserved_uses.period_close.push('2950'); },
    c => { c.selections.sg_pte_provisional.reserved_uses.gst_control = []; },
    c => { c.selections.sg_pte_provisional.reserved_uses['invalid use'] = ['3100']; },
    c => { delete c.selections.sg_pte_provisional.unresolved_choice; },
    c => { c.selections.sg_pte_provisional.unresolved_choice.posting = true; },
    c => { c.selections.sg_pte_provisional.unresolved_choice.id = '9999'; },
    c => { c.selections.sg_pte_provisional.unresolved_choice.code = '9999'; },
    c => { c.account_sets.pte_launch_extensions[0].code = '2000'; },
    c => { c.account_sets.pte_launch_extensions[0].name_en = 'share capital'; }
  ];
  for (const mutate of cases) {
    const modified = structuredClone(pack); mutate(modified.chart_of_accounts.native_chart);
    assert.equal(validateOutboundPackManifest(modified).ok, false, String(mutate));
    assert.throws(() => selectNativeChartForPack(modified,input), /Invalid native chart/, String(mutate));
  }
});

test('candidate returns cannot mutate the pack cache, reference helpers or the next selection', () => {
  const before = selectSgProvisionalChart(identity);
  const changed = resolveProvisioningPolicy('sg').provisionalChart(identity);
  changed.accounts[0].name_en = 'mutated'; changed.accounts[0].canonical_role = 'asset.cash';
  changed.reporting_groups.cash_and_bank.name_en = 'mutated';
  changed.provenance.review_status = 'approved';
  changed.reserved_uses.gst_control.pop(); changed.ordinary_account_codes.pop();
  changed.unresolved_choice.posting = true;
  assert.deepEqual(selectSgProvisionalChart(identity), before);
  assert.deepEqual(selectNativeChartForPack(pack,input), before);
  assert.equal(SFRS_CHART[0].name_en, before.accounts[0].name_en);
});

test('optional SG registry operation does not supply live default, certificate or role requirements', () => {
  assert.deepEqual(Object.keys(resolveProvisioningPolicy('sg')), ['provisionalChart', 'nativeRegistration', 'birthContracts']);
  assert.equal(resolveProvisioningPolicy('sg').nativeRegistration, NATIVE_GST_REGISTRATION_POLICY);
  assert.equal(marketHasNativeDefaultChart('sg'), false);
  assert.equal(marketHasNativeDefaultChart('SG'), false);
  assert.equal(resolveProvisioningCertificateChart('sg_pte_provisional'), null);
  assert.equal(resolveProvisioningCertificateChart('sg_pte_native.v1'), null);
  assert.equal(resolveProvisioningCertificateChart('sg_legacy_palette.v1'), null, 'SG legacy certificate remains with its existing owner');
  for (const profile of [{accounting_method:'cash'},{accounting_method:'accrual',gst_registration:{status:'registered',registered_from:'2026-01-01'}}]) {
    assert.deepEqual(deriveRequiredRolesForClient({jurisdiction:'sg',profile,env:{}}), deriveRequiredRolesForClient({jurisdiction:'zz',profile,env:{}}));
  }
});
