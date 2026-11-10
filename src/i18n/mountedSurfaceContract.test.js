import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

import en from './catalogs/en.js';
import mountedSurfacesEn, { MOUNTED_SURFACE_NAMESPACE } from './catalogs/mountedSurfaces.en.js';
import { INTERFACE_CATALOGS, INTERFACE_CATALOG_VERSION, validateInterfaceCatalog } from './localeCatalog.js';
import {
  CANONICAL_VISIBLE_LITERAL_ALLOWLIST,
  NATIVE_PRODUCT_COPY_SOURCES,
  OFFLINE_ARABIC_UI_FONT,
  PHYSICAL_LAYOUT_ALLOWLIST,
  SUPPORTED_SURFACE_GROUPS,
  SUPPORTED_SURFACE_LABS,
  SUPPORTED_SURFACE_MANIFEST_VERSION,
  SUPPORTED_SURFACE_PATHS,
  UNMOUNTED_SOURCE_DECLARATIONS
} from './supportedSurfaceManifest.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const traverse = traverseModule.default || traverseModule;

const parseJsx = (path) => parse(read(path), {
  sourceType: 'module',
  plugins: ['jsx']
});

const enclosingDeclaration = (path) => {
  let cursor = path;
  while (cursor) {
    if (cursor.isFunctionDeclaration?.() && cursor.node.id?.name) return cursor.node.id.name;
    if ((cursor.isFunctionExpression?.() || cursor.isArrowFunctionExpression?.())
      && cursor.parentPath?.isVariableDeclarator?.()
      && cursor.parentPath.node.id?.type === 'Identifier') {
      return cursor.parentPath.node.id.name;
    }
    cursor = cursor.parentPath;
  }
  return null;
};

const isInsideExcludedDeclaration = (path, excludedSymbols) => {
  let cursor = path;
  while (cursor) {
    if (cursor.isFunctionDeclaration?.() && excludedSymbols.has(cursor.node.id?.name)) return true;
    if ((cursor.isFunctionExpression?.() || cursor.isArrowFunctionExpression?.())
      && cursor.parentPath?.isVariableDeclarator?.()
      && cursor.parentPath.node.id?.type === 'Identifier'
      && excludedSymbols.has(cursor.parentPath.node.id.name)) {
      return true;
    }
    cursor = cursor.parentPath;
  }
  return false;
};

const isStyleExpression = (path) => {
  const element = path.parentPath;
  if (!element?.isJSXElement?.()) return false;
  const name = element.node.openingElement?.name;
  return name?.type === 'JSXIdentifier' && name.name === 'style';
};

const normalizeVisibleLiteral = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const collectRenderedLiterals = (node, literals = []) => {
  if (!node) return literals;
  if (node.type === 'StringLiteral') literals.push(node.value);
  else if (node.type === 'TemplateLiteral') {
    node.quasis.forEach((part) => literals.push(part.value.cooked || part.value.raw || ''));
  } else if (node.type === 'ConditionalExpression') {
    collectRenderedLiterals(node.consequent, literals);
    collectRenderedLiterals(node.alternate, literals);
  } else if (node.type === 'LogicalExpression') {
    // The left side decides admission; the right side is the rendered value or
    // fallback (`condition && copy`, `value || fallback`).
    collectRenderedLiterals(node.right, literals);
  } else if (node.type === 'ParenthesizedExpression') {
    collectRenderedLiterals(node.expression, literals);
  }
  return literals;
};

const resolveLocalImport = (fromPath, specifier) => {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(ROOT, dirname(fromPath), specifier);
  const candidates = extname(base)
    ? [base]
    : [`${base}.js`, `${base}.jsx`, `${base}.mjs`, resolve(base, 'index.js'), resolve(base, 'index.jsx')];
  const match = candidates.find((candidate) => existsSync(candidate));
  return match ? match.slice(ROOT.length + 1) : null;
};

const reachableFrom = (entryPath) => {
  const seen = new Set();
  const visit = (path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    const source = read(path);
    const imports = [
      ...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)
    ];
    imports.forEach((match) => visit(resolveLocalImport(path, match[1])));
  };
  visit(entryPath);
  return seen;
};

test('AR-3B publishes one closed mounted-surface namespace across every installed catalog', () => {
  assert.equal(SUPPORTED_SURFACE_MANIFEST_VERSION, INTERFACE_CATALOG_VERSION);
  assert.equal(INTERFACE_CATALOG_VERSION, '2026-09-28.sg-native-intake.1');
  assert.equal(Object.keys(mountedSurfacesEn).length, 1061);
  assert.ok(Object.keys(mountedSurfacesEn).every((key) => key.startsWith(MOUNTED_SURFACE_NAMESPACE)));
  assert.deepEqual(validateInterfaceCatalog(mountedSurfacesEn, { locale: 'en-mounted' }), []);
  Object.keys(mountedSurfacesEn).forEach((key) => {
    assert.equal(en[key], mountedSurfacesEn[key], `English catalog omitted ${key}`);
    assert.equal(typeof INTERFACE_CATALOGS['ar-AE'][key], 'string', `Arabic catalog omitted ${key}`);
    assert.equal(typeof INTERFACE_CATALOGS['ar-XB'][key], 'string', `pseudo catalog omitted ${key}`);
  });
});

test('every declared production surface exists and is reachable from the mounted entry', () => {
  const reachable = reachableFrom('src/main.jsx');
  assert.equal(new Set(SUPPORTED_SURFACE_PATHS).size, SUPPORTED_SURFACE_PATHS.length);
  SUPPORTED_SURFACE_PATHS.forEach((path) => {
    assert.ok(existsSync(resolve(ROOT, path)), `missing declared surface: ${path}`);
    assert.ok(reachable.has(path), `declared surface is not mounted from src/main.jsx: ${path}`);
  });
  Object.keys(SUPPORTED_SURFACE_LABS).forEach((group) => {
    assert.ok(SUPPORTED_SURFACE_GROUPS[group], `lab matrix names unknown group: ${group}`);
    assert.ok(SUPPORTED_SURFACE_LABS[group].length > 0, `no locale lab covers ${group}`);
  });
});

test('declared surfaces cannot introduce hardcoded or implicit host accounting locales', () => {
  const violations = [];
  SUPPORTED_SURFACE_PATHS.forEach((path) => {
    const source = read(path);
    source.split('\n').forEach((line, index) => {
      if (/\b(?:toLocaleString|toLocaleDateString|toLocaleTimeString)\(\s*(?:\)|['"]en[-_])/.test(line)
        || /\bIntl\.(?:NumberFormat|DateTimeFormat)\(\s*(?:\)|['"]en[-_])/.test(line)) {
        violations.push(`${path}:${index + 1}:${line.trim()}`);
      }
    });
  });
  assert.deepEqual(violations, []);
});

test('declared JSX has no uncatalogued visible literal or accessible-name escape hatch', () => {
  const unmounted = new Map(UNMOUNTED_SOURCE_DECLARATIONS.map((entry) => [entry.path, new Set(entry.symbols)]));
  const allowed = new Map();
  CANONICAL_VISIBLE_LITERAL_ALLOWLIST.forEach((entry) => {
    const values = allowed.get(entry.path) || new Set();
    values.add(normalizeVisibleLiteral(entry.value));
    allowed.set(entry.path, values);
  });
  const violations = [];
  SUPPORTED_SURFACE_PATHS.forEach((path) => {
    const excludedSymbols = unmounted.get(path) || new Set();
    const allowedValues = allowed.get(path) || new Set();
    const record = (nodePath, value, kind) => {
      const normalized = normalizeVisibleLiteral(value);
      if (!/\p{L}/u.test(normalized)) return;
      if (isInsideExcludedDeclaration(nodePath, excludedSymbols)) return;
      if (allowedValues.has(normalized)) return;
      violations.push(`${path}:${nodePath.node.loc.start.line}:${kind}:${normalized}`);
    };
    traverse(parseJsx(path), {
      JSXText(nodePath) {
        record(nodePath, nodePath.node.value, 'text');
      },
      JSXExpressionContainer(nodePath) {
        if (isStyleExpression(nodePath)) return;
        if (nodePath.parentPath.isJSXAttribute()) {
          const attribute = nodePath.parentPath.node.name?.name;
          if (!['aria-label', 'title', 'placeholder', 'alt'].includes(attribute)) return;
        } else if (!nodePath.parentPath.isJSXElement() && !nodePath.parentPath.isJSXFragment()) {
          return;
        }
        collectRenderedLiterals(nodePath.node.expression).forEach((value) => record(nodePath, value, 'expression'));
      },
      JSXAttribute(nodePath) {
        const attribute = nodePath.node.name?.name;
        if (!['aria-label', 'title', 'placeholder', 'alt'].includes(attribute)) return;
        if (nodePath.node.value?.type === 'StringLiteral') record(nodePath, nodePath.node.value.value, attribute);
      }
    });
  });
  assert.deepEqual(violations, []);
});

test('source-local unmounted declarations stay exact and cannot enter the production render graph', () => {
  const known = new Set();
  UNMOUNTED_SOURCE_DECLARATIONS.forEach((entry) => {
    assert.ok(SUPPORTED_SURFACE_PATHS.includes(entry.path));
    const source = read(entry.path);
    entry.symbols.forEach((symbol) => {
      assert.match(source, new RegExp(`(?:function\\s+${symbol}\\b|(?:const|let)\\s+${symbol}\\s*=)`));
      known.add(`${entry.path}:${symbol}`);
    });
  });
  const mountedReferences = [];
  SUPPORTED_SURFACE_PATHS.forEach((path) => {
    const excludedOwners = new Set(
      UNMOUNTED_SOURCE_DECLARATIONS.find((entry) => entry.path === path)?.symbols || []
    );
    traverse(parseJsx(path), {
      JSXOpeningElement(nodePath) {
        const name = nodePath.node.name;
        if (name.type !== 'JSXIdentifier') return;
        if (!known.has(`${path}:${name.name}`)) return;
        if (excludedOwners.has(enclosingDeclaration(nodePath))) return;
        mountedReferences.push(`${path}:${nodePath.node.loc.start.line}:${name.name}`);
      }
    });
  });
  assert.deepEqual(mountedReferences, []);
});

test('every mounted message reference resolves and directional box styles stay logical', () => {
  const inspectedPaths = [
    ...SUPPORTED_SURFACE_PATHS,
    'src/lib/clientAxes.js',
    'src/lib/intakeDraft.js',
    'src/lib/teamRosterView.js'
  ];
  const missingMessages = [];
  const physicalStyles = [];
  inspectedPaths.forEach((path) => {
    read(path).split('\n').forEach((line, index) => {
      [...line.matchAll(/['"](mounted\.[A-Za-z0-9_.-]+)['"]/g)].forEach((match) => {
        if (!en[match[1]]) missingMessages.push(`${path}:${index + 1}:${match[1]}`);
      });
      if (/\b(?:marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight)\s*:|textAlign:\s*['"](?:left|right)['"]/.test(line)) {
        physicalStyles.push(`${path}:${index + 1}:${line.trim()}`);
      }
    });
  });
  assert.deepEqual(missingMessages, []);
  assert.deepEqual(physicalStyles, []);
});

test('physical-layout exceptions are narrow, exact, and documented', () => {
  assert.equal(PHYSICAL_LAYOUT_ALLOWLIST.length, 3);
  PHYSICAL_LAYOUT_ALLOWLIST.forEach((entry) => {
    assert.ok(SUPPORTED_SURFACE_PATHS.includes(entry.path));
    assert.ok(entry.symbol && entry.reason && entry.properties.length > 0);
  });
});

test('offline Arabic UI font is licensed, immutable, and included by the desktop bundle', () => {
  const font = readFileSync(resolve(ROOT, OFFLINE_ARABIC_UI_FONT.source));
  assert.equal(createHash('sha256').update(font).digest('hex'), OFFLINE_ARABIC_UI_FONT.sha256);
  assert.match(read(OFFLINE_ARABIC_UI_FONT.license), /SIL OPEN FONT LICENSE/i);
  assert.match(read('src/styles.css'), /font-family:\s*['"]Donna Arabic UI['"]/);
  assert.match(read('src/styles.css'), /NotoSansArabic-wdth-wght\.ttf/);
  assert.match(read('desktop/electron-builder.yml'), /- server\/\*\*\/\*/);
});

test('native desktop sources contain no uncatalogued menu or notification copy', () => {
  NATIVE_PRODUCT_COPY_SOURCES.forEach((path) => {
    const source = read(path);
    assert.doesNotMatch(source, /\b(?:new\s+Notification|setApplicationMenu|Menu\.buildFromTemplate)\b/);
  });
});
