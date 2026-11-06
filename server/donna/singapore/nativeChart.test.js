import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as chart from './sfrsChart.js';
import { nativeChartForPack, validateNativeChart } from '../outbound/nativeChart.js';
import { loadOutboundPack, validateOutboundPackManifest, fallbackAccountsForPack } from '../outbound/packs.js';
import { SG_CODING_POLICY } from './codingPolicy.js';
import { buildSgRailContext } from './paynowGiro.js';
import { marketHasNativeDefaultChart } from '../defaultCharts.js';

const root = path.resolve(import.meta.dirname, '../../..');
const readJson = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
// Captured before moving data at the named baseline SHA. Digests pin every
// ordered field without creating a second authored accounting inventory.
const baseline = readJson('server/donna/singapore/fixtures/nativeChartBaseline.json');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pack = loadOutboundPack('sg');
const native = nativeChartForPack(pack);
const run = (code, cwd = root) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
  cwd, encoding: 'utf8', timeout: 30_000,
  env: { PATH: process.env.PATH, TZ: process.env.TZ || 'UTC', NODE_ENV: 'test' }
});
const pass = result => assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}\n${result.stdout}`);

test('the complete pre-move inventory and all public builder outputs retain their exact bytes and order', () => {
  assert.equal(baseline.source_revision, '6281542cb9bdf7948fa87e150800180c3050d2b1');
  for (const [name, expected] of Object.entries(baseline.reference)) {
    assert.equal(digest(chart[name] instanceof Set ? [...chart[name]] : chart[name]), expected, name);
  }
  for (const [name, expected] of Object.entries(baseline.builders)) {
    assert.equal(digest(chart[name]()), expected.default, `${name} compatibility default`);
    assert.equal(digest(chart[name]({ gstRegistered: true })), expected.registered, name);
    assert.equal(digest(chart[name]({ gstRegistered: false })), expected.unregistered, name);
  }
  for (const row of [...chart.SFRS_CHART, ...chart.SOLE_PROP_EQUITY_ACCOUNTS, ...chart.LLP_EQUITY_ACCOUNTS]) {
    assert.deepEqual(Object.keys(row), ['code', 'name_en', 'account_type', 'normal_balance', 'statutory_group']);
  }
  assert.equal(chart.resolveSgAccount('2051'), null, 'do not widen the existing base-only lookup');
  assert.equal(chart.resolveSgAccount('2060'), null);
});

test('real pack and compatibility reader use one native definition without activating seed or coding policy', () => {
  assert.deepEqual(validateNativeChart(native), { ok: true, errors: [] });
  assert.equal(native.usage, 'reference_only');
  assert.equal(native.provenance.review_status, 'unreviewed');
  assert.equal(native.provenance.kind, 'authored_product_data');
  for (const [set, rows] of [['base', chart.SFRS_CHART], ['sole_proprietor_equity', chart.SOLE_PROP_EQUITY_ACCOUNTS], ['llp_equity', chart.LLP_EQUITY_ACCOUNTS]]) {
    assert.deepEqual(native.account_sets[set], rows.map(row => ({ ...row, canonical_role: null })));
  }
  assert.deepEqual(native.reporting_groups, chart.SG_STATUTORY_GROUPS);
  assert.deepEqual(native.code_sets.gst_control, [...chart.GST_ACCOUNT_CODES]);
  assert.equal(SG_CODING_POLICY.bankLineContextFor, buildSgRailContext);
  assert.deepEqual(SG_CODING_POLICY.accountOptions, fallbackAccountsForPack(pack).map(row => row.name));
  assert.equal(marketHasNativeDefaultChart('SG'), false, 'no native seed/certificate registration');
  nativeChartForPack(pack).account_sets.base[0].name_en = 'mutation';
  assert.notEqual(nativeChartForPack(pack).account_sets.base[0].name_en, 'mutation', 'read result does not alias pack cache');
  for (const [id, expected] of Object.entries(baseline.fallbacks)) {
    assert.equal(digest(fallbackAccountsForPack(loadOutboundPack(id))), expected, id);
  }
});

test('optional native schema rejects malformed metadata, duplicates and references through the actual pack validator', () => {
  const invalid = [
    c => { c.version = 0; }, c => { c.version = '1'; }, c => { c.id = ''; },
    c => { c.usage = 'seed'; }, c => { c.activate = true; },
    c => { c.provenance.kind = 'statutory_certified'; },
    c => { c.provenance.review_status = 'approved'; },
    c => { c.provenance.source_revision = 'unknown'; },
    c => { c.provenance.source_revision = [c.provenance.source_revision]; },
    c => { c.account_sets.base[0].code = ''; },
    c => { c.account_sets.base[0].code = 1000; },
    c => { c.account_sets.base[1].code = c.account_sets.base[0].code; },
    c => { c.account_sets.llp_equity[0].code = c.account_sets.base[0].code; },
    c => { c.account_sets.base[1].name_en = c.account_sets.base[0].name_en; },
    c => { c.account_sets.base[0].name_en = ' '; },
    c => { c.account_sets.base[0].account_type = 'guessed_type'; },
    c => { c.account_sets.base[0].normal_balance = 'either'; },
    c => { c.account_sets.base[0].statutory_group = 'invented_group'; },
    c => { delete c.account_sets.base[0].canonical_role; },
    c => { c.account_sets.base[0].canonical_role = 'invented.role'; },
    c => { c.account_sets.base[0].canonical_role = ['asset.fixed']; },
    c => { c.account_sets.base[0].new_field = true; },
    c => { c.account_sets.base = []; }, c => { c.account_sets.base = null; },
    c => { delete c.account_sets.base; }, c => { c.reporting_groups = null; },
    c => { c.reporting_groups.cash_and_bank.side = 'revenue'; },
    c => { c.reporting_groups.revenue.side = 'assets'; },
    c => { c.reporting_groups.revenue.statement = 'invented'; },
    c => { c.code_sets.gst_control.push('no_such_account'); },
    c => { c.code_sets.gst_control.push('2950'); },
    c => { c.group_sets.pte_ltd_only.push('no_such_group'); }
  ];
  for (const change of invalid) {
    const modified = structuredClone(pack);
    change(modified.chart_of_accounts.native_chart);
    assert.equal(validateOutboundPackManifest(modified).ok, false, String(change));
    assert.throws(() => nativeChartForPack(modified), /Invalid native chart/, String(change));
  }
  for (const value of [null, [], 'invalid', {}]) {
    const modified = structuredClone(pack); modified.chart_of_accounts.native_chart = value;
    assert.equal(validateOutboundPackManifest(modified).ok, false);
  }
  const legacy = structuredClone(pack); delete legacy.chart_of_accounts.native_chart;
  assert.equal(validateOutboundPackManifest(legacy).ok, true, 'native leg remains optional');
  assert.equal(nativeChartForPack(legacy), null);
  const missingSuspense = structuredClone(pack);
  missingSuspense.chart_of_accounts.fallback_accounts = missingSuspense.chart_of_accounts.fallback_accounts.filter(a => a.role !== 'control.suspense');
  assert.equal(validateOutboundPackManifest(missingSuspense).ok, false, 'native data cannot waive fallback singleton');
  const badFallback = structuredClone(pack); badFallback.chart_of_accounts.fallback_accounts[0].role = null;
  assert.equal(validateOutboundPackManifest(badFallback).ok, false, 'native nullable roles never widen fallback');
});

test('cold imports cover actual pack, role/config, policy and hosted GST composition entry points', () => {
  for (const entry of ['outbound/packs.js', 'accountRoles.js', 'countryCapabilities.js', 'codingPolicyRegistry.js',
    'singapore/sfrsChart.js', 'singapore/provisioningPolicy.js', 'provisioningPolicyRegistry.js',
    'singapore/gstCodes.js', 'singapore/gstReturnArtifact.js', 'statutoryRegistry.js', 'api.js']) {
    pass(run(`
      import assert from 'node:assert/strict';
      await import('./server/donna/${entry}');
      const {loadOutboundPack} = await import('./server/donna/outbound/packs.js');
      const {SFRS_CHART} = await import('./server/donna/singapore/sfrsChart.js');
      const {SG_CODING_POLICY} = await import('./server/donna/singapore/codingPolicy.js');
      const {getSingaporeGstDraftArtifactFromDb} = await import('./server/donna/statutoryRegistry.js');
      const {handleDonnaApiRequest} = await import('./server/donna/api.js');
      assert.equal(loadOutboundPack('sg').chart_of_accounts.native_chart.account_sets.base.length, 41);
      assert.equal(SFRS_CHART.length, 41);
      assert.equal(SG_CODING_POLICY.accountOptions.length, 26);
      assert.equal(typeof SG_CODING_POLICY.bankLineContextFor, 'function');
      assert.equal(typeof getSingaporeGstDraftArtifactFromDb, 'function');
      assert.equal(typeof handleDonnaApiRequest, 'function');
      const {resolveProvisioningPolicy} = await import('./server/donna/provisioningPolicyRegistry.js');
      const candidate = resolveProvisioningPolicy('sg').provisionalChart({jurisdiction:'sg',legalForm:'sg-pte'});
      assert.equal(candidate.accounts.length, 58);
      assert.equal(candidate.status, 'provisional');
    `));
  }
});

test('declared pack assets support an isolated relocated reader and reject corrupt/missing native data', async t => {
  const destination = await mkdtemp(path.join(tmpdir(), 'donna-sg-native-assets-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const config = readJson('vercel.json');
  for (const entry of ['api/donna-router.js', 'api/inngest.js']) {
    assert.ok(config.functions[entry].includeFiles.slice(1, -1).split(',').includes('packs/**'), entry);
  }
  // This repeatable asset/read test complements the actual @vercel/node emitted
  // function proof recorded in the PR; it does not pretend copying is a build.
  const files = ['server/donna/singapore/sfrsChart.js', 'server/donna/outbound/nativeChart.js',
    'server/donna/accountRoles.js', 'server/donna/transactionIntel.js', 'server/donna/dates.js',
    'server/donna/clientConfig.js', 'packs/sg/manifest.json'];
  for (const file of files) {
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await cp(path.join(root, file), path.join(destination, file));
  }
  await writeFile(path.join(destination, 'package.json'), '{"type":"module"}');
  const code = `import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    const {SFRS_CHART, selectSgProvisionalChart} = await import('./server/donna/singapore/sfrsChart.js');
    assert.equal(selectSgProvisionalChart({jurisdiction:'sg',legalForm:'sg-pte'}).accounts.length, 58);
    assert.equal(createHash('sha256').update(JSON.stringify(SFRS_CHART)).digest('hex'), '${baseline.reference.SFRS_CHART}');`;
  pass(run(code, destination));
  for (const [field, names] of Object.entries({
    account_sets: ['sole_proprietor_equity', 'llp_equity'],
    code_sets: ['gst_control'], group_sets: ['pte_ltd_only']
  })) {
    for (const name of names) {
      for (const mode of ['renamed', 'missing']) {
        const malformed = structuredClone(pack);
        const sets = malformed.chart_of_accounts.native_chart[field];
        // A neighboring set keeps the generic declaration structurally valid.
        if (mode === 'renamed') sets[`renamed_${name}`] = sets[name];
        else if (field !== 'account_sets') sets.neighbor = sets[name];
        delete sets[name];
        assert.equal(validateNativeChart(malformed.chart_of_accounts.native_chart).ok, true);
        await writeFile(path.join(destination, 'packs/sg/manifest.json'), JSON.stringify(malformed));
        const result = run(code, destination);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`Singapore native chart requires ${field}.${name}`), result.stderr);
      }
    }
  }
  await writeFile(path.join(destination, 'packs/sg/manifest.json'), JSON.stringify(pack));
  pass(run(code, destination));
  const renamedSelection = structuredClone(pack);
  const selections = renamedSelection.chart_of_accounts.native_chart.selections;
  selections.neighbor = selections.sg_pte_provisional;
  delete selections.sg_pte_provisional;
  assert.equal(validateNativeChart(renamedSelection.chart_of_accounts.native_chart).ok, true);
  await writeFile(path.join(destination, 'packs/sg/manifest.json'), JSON.stringify(renamedSelection));
  assert.match(run(code, destination).stderr, /Native chart selection unavailable/, 'SG reader requires its exact named binding');
  const missingBindings = [
    c => { delete c.selections.sg_pte_provisional.reserved_uses.gst_control; },
    c => { c.selections.sg_pte_provisional.reserved_uses.gst_control.pop(); },
    c => { c.selections.sg_pte_provisional.reserved_uses.gst_control[1] = '2955'; },
    c => { delete c.selections.sg_pte_provisional.reserved_uses.period_close; },
    c => { delete c.selections.sg_pte_provisional.reserved_uses.tax_classified_revenue; },
    c => { c.selections.sg_pte_provisional.reserved_uses.tax_classified_revenue.pop(); },
    c => { c.selections.sg_pte_provisional.account_sets.reverse(); },
    c => { c.selections.sg_pte_provisional.account_sets.pop(); },
    c => { c.selections.sg_pte_provisional.account_sets.push('llp_equity'); },
    c => { c.selections.sg_pte_provisional.legal_form = 'sg-llp'; }
  ];
  for (const mutate of missingBindings) {
    const malformed = structuredClone(pack); mutate(malformed.chart_of_accounts.native_chart);
    assert.equal(validateNativeChart(malformed.chart_of_accounts.native_chart).ok, true, 'generic schema stays country-neutral');
    await writeFile(path.join(destination, 'packs/sg/manifest.json'), JSON.stringify(malformed));
    assert.match(run(code, destination).stderr, /Singapore provisional chart requires/, String(mutate));
  }
  await writeFile(path.join(destination, 'packs/sg/manifest.json'), JSON.stringify(pack));
  pass(run(code, destination), 'intact neighboring candidate still reads');
  const broken = structuredClone(pack); broken.chart_of_accounts.native_chart.account_sets.base[0].code = '';
  await writeFile(path.join(destination, 'packs/sg/manifest.json'), JSON.stringify(broken));
  assert.match(run(code, destination).stderr, /Invalid native chart/);
  delete broken.chart_of_accounts.native_chart;
  await writeFile(path.join(destination, 'packs/sg/manifest.json'), JSON.stringify(broken));
  assert.match(run(code, destination).stderr, /Singapore native chart reference unavailable/);
});
