// Direct dependency ratchet, not proof that all runtime policy is neutral.
// Run from any directory: node scripts/check-jurisdiction-boundary.mjs
// No baseline regeneration command: each exception is an explicit review decision.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

export const COUNTRY_DIRECTORIES = Object.freeze(['ae', 'au', 'finland', 'gb', 'singapore', 'us']);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSION = /\.(?:[cm]?js|jsx|tsx?)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?js|jsx|tsx?)$/;
const TEST_DIRECTORIES = new Set(['__tests__', '__fixtures__', 'fixtures', 'testSupport']);
const edgeKey = ({ importer, target }) => `${importer} -> ${target}`;
const owner = (file) => typeof file === 'string' && COUNTRY_DIRECTORIES.includes(file.split('/')[0]) ? file.split('/')[0] : null;

function listModules(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in jurisdiction scan: ${relative}`);
    if (entry.isDirectory()) return TEST_DIRECTORIES.has(entry.name)
      ? [] : listModules(path.join(directory, entry.name), `${relative}/`);
    return SOURCE_EXTENSION.test(entry.name) && !TEST_FILE.test(entry.name) ? [relative] : [];
  }).sort();
}

function literalSpecifier(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

// AST traversal includes imports inside functions and ignores comments/string examples.
export function importSpecifiers(source, filename) {
  const ast = parse(source, {
    sourceType: 'unambiguous', sourceFilename: filename, createImportExpressions: true,
    plugins: [ ...( /\.tsx?$/.test(filename) ? ['typescript'] : [] ), 'jsx' ]
  });
  const imports = [];
  const computed = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    let argument;
    let kind;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      argument = node.source;
      kind = node.type === 'ImportDeclaration' ? 'import' : 're-export';
    } else if (node.type === 'ImportExpression') {
      argument = node.source; kind = 'dynamic-import';
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Import') {
      argument = node.arguments[0]; kind = 'dynamic-import';
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      argument = node.arguments[0]; kind = 'require';
    }
    if (kind) {
      const specifier = literalSpecifier(argument);
      const entry = { kind, line: node.loc.start.line };
      if (specifier === null) computed.push(entry);
      else imports.push({ ...entry, specifier });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
    }
  };
  visit(ast);
  return { imports, computed };
}

export function scanJurisdictionBoundary(directory) {
  const modules = listModules(directory);
  const edges = new Map();
  const computedImports = [];
  for (const importer of modules) {
    const parsed = importSpecifiers(readFileSync(path.join(directory, importer), 'utf8'), importer);
    computedImports.push(...parsed.computed.map((entry) => ({ importer, ...entry })));
    for (const { specifier, kind, line } of parsed.imports) {
      // This deliberately does not resolve package aliases or trace transitive calls.
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier.split(/[?#]/)[0]));
      const targetOwner = owner(target);
      if (!targetOwner || targetOwner === owner(importer)) continue;
      const entry = { importer, target, boundary: owner(importer) ? 'cross-country' : 'engine-to-country' };
      const key = edgeKey(entry);
      if (!edges.has(key)) edges.set(key, { ...entry, occurrences: [] });
      edges.get(key).occurrences.push({ kind, line });
    }
  }
  return { modules, edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))), computedImports };
}

export function checkJurisdictionBaseline(scan, baseline) {
  const errors = [];
  if (baseline.version !== 1 || !Array.isArray(baseline.edges)) return ['Invalid jurisdiction baseline schema'];
  if (JSON.stringify(baseline.countryDirectories) !== JSON.stringify(COUNTRY_DIRECTORIES)) {
    errors.push('Country ownership differs from the explicit baseline; review the scan scope.');
  }
  const expected = new Set();
  for (const edge of baseline.edges) {
    const key = edgeKey(edge);
    if (expected.has(key)) errors.push(`Duplicate baseline edge: ${key}`);
    expected.add(key);
    if (!['debt', 'composition'].includes(edge.disposition) || typeof edge.rationale !== 'string' || !edge.rationale.trim()) {
      errors.push(`Baseline edge needs disposition and rationale: ${key}`);
    }
    if (edge.disposition === 'debt' && (typeof edge.owner !== 'string' || !edge.owner.trim() || typeof edge.exitCriterion !== 'string' || !edge.exitCriterion.trim())) {
      errors.push(`Retained jurisdiction debt needs an owner and exit criterion: ${key}`);
    }
    if (typeof edge.importer !== 'string' || typeof edge.target !== 'string'
      || /[*?]/.test(key) || !owner(edge.target) || owner(edge.target) === owner(edge.importer)) {
      errors.push(`Baseline must name an exact boundary edge: ${key}`);
    }
  }
  const actual = new Set(scan.edges.map(edgeKey));
  for (const key of actual) if (!expected.has(key)) errors.push(`New jurisdiction dependency: ${key}`);
  for (const key of expected) if (!actual.has(key)) errors.push(`Removed dependency; shrink the baseline: ${key}`);
  return errors;
}

export function checkRepositoryBoundary(root = ROOT) {
  const scan = scanJurisdictionBoundary(path.join(root, 'server/donna'));
  const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/jurisdiction-boundary-baseline.json'), 'utf8'));
  return { ...scan, baseline, errors: checkJurisdictionBaseline(scan, baseline) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkRepositoryBoundary();
  console.log(`Jurisdiction boundary: ${result.modules.length} modules, ${result.edges.length} explicit edges, ${result.computedImports.length} computed imports outside static coverage.`);
  if (result.errors.length) {
    console.error(result.errors.join('\n'));
    process.exitCode = 1;
  }
}
