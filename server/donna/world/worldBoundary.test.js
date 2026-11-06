// EAW's oracle must stay independent from Donna's solver. This is deliberately
// a direct-edge allowlist: the offline runner is the sole legal crossing seam.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SERVER = resolve(REPO, 'server');
const DONNA = resolve(REPO, 'server/donna');
const WORLD = resolve(DONNA, 'world');
const RUNNER_PATTERN = /^scripts\/eval_world_[a-z0-9_-]+\.js$/;
const ALLOWED_PACKAGES = new Set([
  'pdf-lib', 'node:test',
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith('node:') ? name : `node:${name}`)
]);

function javascriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

// Static literal edges are the enforceable module boundary. Cover ordinary,
// side-effect, re-export, dynamic-import, and CommonJS spellings so a refactor
// cannot accidentally step around the check.
function importSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gs,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function resolveLocalImporter(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const unresolved = resolve(dirname(importer), specifier);
  if (extname(unresolved)) return unresolved;
  return `${unresolved}.js`;
}

function isWithin(path, directory) {
  const child = relative(directory, path);
  return child === '' || (!child.startsWith('..') && !child.startsWith('/'));
}

function packageImportViolations(modules) {
  return modules.flatMap(({ importer, source }) => importSpecifiers(source)
    .filter((specifier) => {
      if (ALLOWED_PACKAGES.has(specifier)) return false;
      if (!specifier.startsWith('.')) return true;
      return !isWithin(resolveLocalImporter(importer, specifier), WORLD);
    })
    .map((specifier) => ({
      law: 'world_package_import_not_allowed',
      importer: relative(REPO, importer),
      specifier
    })));
}

function inventoryViolations(checkedModules, directoryEntries) {
  const checked = checkedModules.map((path) => relative(WORLD, path)).sort();
  const actual = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort();
  return checked.length === actual.length && checked.every((name, index) => name === actual[index])
    ? []
    : [{ law: 'world_module_inventory_mismatch', checked, actual }];
}

function findViolations(edges) {
  const violations = [];
  for (const { importer, imported } of edges) {
    const importerInWorld = isWithin(importer, WORLD);
    const importedInWorld = isWithin(imported, WORLD);
    const importerName = relative(REPO, importer);

    if (importerInWorld && !importedInWorld) {
      violations.push({ law: 'world_must_not_import_solver', importer: importerName, imported: relative(REPO, imported) });
    } else if (!importerInWorld && importedInWorld && !RUNNER_PATTERN.test(importerName)) {
      violations.push({ law: 'world_must_only_enter_through_runner', importer: importerName, imported: relative(REPO, imported) });
    }
  }
  return violations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function productionEdges() {
  // Scan every server and script module, not merely today's known callers. A
  // route or innocently named maintenance script is exactly the bypass this
  // boundary exists to catch.
  const files = javascriptFiles(SERVER).filter((path) => !path.endsWith('.test.js'));
  const scripts = javascriptFiles(resolve(REPO, 'scripts')).filter((path) => !path.endsWith('.test.js'));
  return [...files, ...scripts].flatMap((importer) => importSpecifiers(readFileSync(importer, 'utf8'))
    .map((specifier) => resolveLocalImporter(importer, specifier))
    .filter(Boolean)
    .map((imported) => ({ importer, imported })));
}

test('world/oracle modules are isolated from solve code except at the named runner seam', () => {
  assert.ok(javascriptFiles(WORLD).some((path) => !path.endsWith('.test.js')), 'world module inventory must not be empty');
  assert.deepEqual(findViolations(productionEdges()), []);
});

test('every world module imports only node builtins, pdf-lib, or world-internal siblings', () => {
  const modules = javascriptFiles(WORLD);
  assert.deepEqual(packageImportViolations(modules.map((importer) => ({
    importer,
    source: readFileSync(importer, 'utf8')
  }))), []);
});

test('checked world module inventory equals the actual top-level directory listing', () => {
  assert.deepEqual(inventoryViolations(javascriptFiles(WORLD), readdirSync(WORLD, { withFileTypes: true })), []);
});

test('import parser covers every supported static edge spelling and ignores non-literal dynamic imports', () => {
  const source = `
    import './side-effect.js';
    import value from './ordinary.js';
    export { value } from './re-export.js';
    const dynamic = import('./dynamic.js');
    const commonJs = require('./common-js.js');
    import(variable);
  `;
  assert.deepEqual(importSpecifiers(source), [
    './side-effect.js', './ordinary.js', './re-export.js', './dynamic.js', './common-js.js'
  ]);
});

test('NOT vacuous: world imports of direct, parent, and extensionless solver paths are refused', () => {
  const importer = resolve(WORLD, 'oracle.js');
  for (const specifier of ['../ledger.js', '../ledger', '../../outsideDonna.js']) {
    const imported = resolveLocalImporter(importer, specifier);
    assert.deepEqual(findViolations([{ importer, imported }]), [{
      law: 'world_must_not_import_solver', importer: 'server/donna/world/oracle.js', imported: relative(REPO, imported)
    }]);
  }
});

test('NOT vacuous: production readers are refused while only exact eval_world runner names cross', () => {
  const imported = resolve(WORLD, 'oracleSuite.js');
  const production = resolve(DONNA, 'firmDb.js');
  const lookalike = resolve(REPO, 'scripts/eval_world_close.js.bak');
  const runner = resolve(REPO, 'scripts/eval_world_close.js');
  assert.equal(findViolations([{ importer: production, imported }])[0].law, 'world_must_only_enter_through_runner');
  assert.equal(findViolations([{ importer: lookalike, imported }])[0].law, 'world_must_only_enter_through_runner');
  assert.deepEqual(findViolations([{ importer: runner, imported }]), []);
});

test('NOT vacuous: a disallowed package import names its module and specifier', () => {
  const importer = resolve(WORLD, 'disallowed-package-fixture.js');
  const specifier = ['post', 'gres'].join('');
  const source = ["import '", specifier, "';"].join('');
  assert.deepEqual(packageImportViolations([{ importer, source }]), [{
    law: 'world_package_import_not_allowed',
    importer: 'server/donna/world/disallowed-package-fixture.js',
    specifier
  }]);
});
test('NOT vacuous: a missing checked module fails inventory with both sets', () => {
  const entries = readdirSync(WORLD, { withFileTypes: true });
  const checked = javascriptFiles(WORLD).filter((path) => !path.endsWith('worldSchema.js'));
  const [violation] = inventoryViolations(checked, entries);
  assert.equal(violation.law, 'world_module_inventory_mismatch');
  assert.ok(violation.actual.includes('worldSchema.js'));
  assert.ok(!violation.checked.includes('worldSchema.js'));
});
