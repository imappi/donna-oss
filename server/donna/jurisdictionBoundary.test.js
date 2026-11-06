import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COUNTRY_DIRECTORIES, checkJurisdictionBaseline, checkRepositoryBoundary,
  importSpecifiers, scanJurisdictionBoundary
} from '../../scripts/check-jurisdiction-boundary.mjs';

const baseline = (edges) => ({ version: 1, countryDirectories: COUNTRY_DIRECTORIES, edges });
const exception = (importer, target, disposition = 'debt') => ({
  importer, target, disposition, owner: 'fixture-adapter', exitCriterion: 'Replace this caller through the registered adapter and pass the entry-point fixture.', rationale: 'Fixture: preserve this exact existing dependency until its adapter is extracted.'
});

function fixture(t, files) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'donna-jurisdiction-boundary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), source);
  }
  return scanJurisdictionBoundary(directory);
}

test('current production tree matches each exact jurisdiction exception', () => {
  const result = checkRepositoryBoundary();
  assert.ok(result.modules.length > 500, 'production scan unexpectedly shrank');
  assert.ok(result.modules.some((file) => file.startsWith('ae/')));
  assert.ok(result.modules.some((file) => file.startsWith('finland/')));
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
});

test('known debt and an exact composition edge pass, but new targets fail', (t) => {
  const scan = fixture(t, {
    'engine.js': "import './gb/tax.js'; import './gb/newPolicy.js';",
    'registry.js': "export { scheme } from './finland/reference.js';"
  });
  const accepted = [exception('engine.js', 'gb/tax.js'), exception('registry.js', 'finland/reference.js', 'composition')];
  assert.deepEqual(checkJurisdictionBaseline(scan, baseline(accepted)), [
    'New jurisdiction dependency: engine.js -> gb/newPolicy.js'
  ]);
  assert.deepEqual(checkJurisdictionBaseline(scan, baseline([...accepted, exception('engine.js', 'gb/newPolicy.js')])), []);
});

test('removing an edge requires removing its baseline entry in the same change', (t) => {
  const scan = fixture(t, { 'engine.js': 'export const neutral = true;' });
  assert.deepEqual(checkJurisdictionBaseline(scan, baseline([exception('engine.js', 'gb/tax.js')])), [
    'Removed dependency; shrink the baseline: engine.js -> gb/tax.js'
  ]);
});

test('AST scan catches multiline imports, re-exports, literal dynamic imports and require', (t) => {
  const scan = fixture(t, { 'nested/engine.mjs': `
    import {
      tax
    } from '../gb/tax.js';
    export * from '../ae/vat.js';
    export { x } from '../singapore/gst.js';
    async function load() { return import('../finland/alv.js'); }
    const reference = import(\`../finland/reference.js\`);
    const legacy = require('../gb/legacy.cjs');
    // import '../ae/comment.js';
    const prose = "import '../ae/prose.js'";
  ` });
  assert.deepEqual(scan.edges.map((edge) => edge.target).sort(), [
    'ae/vat.js', 'finland/alv.js', 'finland/reference.js', 'gb/legacy.cjs', 'gb/tax.js', 'singapore/gst.js'
  ]);
});

test('country-owned internal imports are legitimate; cross-country reuse is visible', (t) => {
  const scan = fixture(t, {
    'ae/invoice.js': "import './vat.js'; import '../shared.js'; import '../finland/xml.js';",
    'ae/invoice.test.js': "import '../gb/fixture.js';",
    'fixtures/engine.js': "import '../gb/fixture.js';",
    'engine.js': "import './shared.js';"
  });
  assert.deepEqual(scan.edges.map(({ importer, target, boundary }) => ({ importer, target, boundary })), [
    { importer: 'ae/invoice.js', target: 'finland/xml.js', boundary: 'cross-country' }
  ]);
  assert.deepEqual(checkJurisdictionBaseline(scan, baseline([])), [
    'New jurisdiction dependency: ae/invoice.js -> finland/xml.js'
  ]);
});

test('computed imports are explicitly reported as outside static coverage', () => {
  const result = importSpecifiers("const x = import('./' + country + '/tax.js'); const y = import(packageName);", 'engine.js');
  assert.equal(result.imports.length, 0);
  assert.equal(result.computed.length, 2);
});

test('normalized paths and duplicate syntax forms identify one exact dependency', (t) => {
  const scan = fixture(t, {
    'nested/engine.ts': "import type { Tax } from '../gb/../gb/tax.js'; export { tax } from '../gb/tax.js';",
    'view.tsx': "import { tax } from './ae/tax.js'; export const view = <div>{tax}</div>;"
  });
  const edge = scan.edges.find((item) => item.importer === 'nested/engine.ts');
  assert.equal(edge.target, 'gb/tax.js');
  assert.equal(edge.occurrences.length, 2);
  assert.equal(scan.edges.length, 2);
});

test('invalid syntax cannot silently disappear from the scan', () => {
  assert.throws(() => importSpecifiers('import {', 'broken.js'), /Unexpected token/);
});

test('wildcard, duplicate, and unreasoned exemptions are refused', () => {
  const entries = [exception('engine.js', 'gb/*'), exception('engine.js', 'gb/*'), {
    importer: 'registry.js', target: 'ae/vat.js', disposition: 'composition', rationale: ''
  }];
  const errors = checkJurisdictionBaseline({ edges: [] }, baseline(entries));
  assert.ok(errors.some((error) => error.startsWith('Duplicate baseline edge:')));
  assert.ok(errors.some((error) => error.startsWith('Baseline must name an exact boundary edge:')));
  assert.ok(errors.some((error) => error.startsWith('Baseline edge needs disposition and rationale:')));
});


test('retained debt cannot lose its accountable owner or removal gate', () => {
  const edge = exception('engine.js', 'gb/tax.js');
  for (const field of ['owner', 'exitCriterion']) {
    const errors = checkJurisdictionBaseline({ edges: [edge] }, baseline([{ ...edge, [field]: '' }]));
    assert.deepEqual(errors, ['Retained jurisdiction debt needs an owner and exit criterion: engine.js -> gb/tax.js']);
  }
});
