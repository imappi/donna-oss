// Static write-boundary ratchet. It does not execute SQL or grant runtime authority.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { stripCommentsAndLiterals } from '../server/donna/sqlWriterLint.js';
import { MEMORY_WRITE_TABLES, MEMORY_WRITER_REGISTRY } from '../server/donna/memoryWriterRegistry.js';
const traverse = traverseModule.default || traverseModule;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = /\.(?:[cm]?js|jsx|tsx?)$/;
const TEST = /\.(?:test|spec)\.(?:[cm]?js|jsx|tsx?)$/;
// Only dependency trees and test-named files are outside runtime source scope.
// Fixture/testSupport directory names never exempt production-named modules.
const EXCLUDED = new Set(['node_modules']);
const TABLES = new Set(MEMORY_WRITE_TABLES);
const digest = (value) => createHash('sha256').update(value).digest('hex');
// Normalize layout without erasing meaningful whitespace inside SQL values.
const normalize = (value) => value.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$|\s+/g,
  (token) => /^\s/.test(token) ? ' ' : token).trim();
const HOLE = '__DYNAMIC_SQL__';
const keyOf = (entry) => `${entry.file}#${entry.owner}:${entry.kind}:${entry.digest}`;

function modules(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in memory writer scan: ${relative}`);
    if (entry.isDirectory()) return EXCLUDED.has(entry.name) ? [] : modules(path.join(directory, entry.name), `${relative}/`);
    return (EXT.test(entry.name) || /\.sql$/i.test(entry.name)) && !TEST.test(entry.name) ? [relative] : [];
  }).sort();
}
function ownerOf(p) {
  const fn = p.findParent((item) => item.isFunction());
  if (!fn) return p.findParent((item) => item.isVariableDeclarator())?.node.id?.name || '<module>';
  if (fn.node.id?.name) return fn.node.id.name;
  if (fn.parentPath.isVariableDeclarator()) return fn.parentPath.node.id?.name || '<anonymous>';
  if (fn.isObjectMethod()) return fn.node.key?.name || '<method>';
  if (fn.parentPath.isObjectProperty()) return fn.parentPath.node.key?.name || '<property>';
  // Name callbacks by their owning declaration, not by a changing line number.
  const declaration = fn.findParent((item) => item.isVariableDeclarator() || item.isFunctionDeclaration());
  return declaration?.node.id?.name ? `${declaration.node.id.name}/callback` : '<callback>';
}
function evaluate(p, seen = new Set()) {
  if (!p?.node) return HOLE;
  if (p.isStringLiteral() || p.isNumericLiteral()) return String(p.node.value);
  if (p.isTemplateLiteral()) return p.node.quasis.map((part, i) => (part.value.cooked ?? part.value.raw) + (i < p.node.expressions.length ? evaluate(p.get(`expressions.${i}`), new Set(seen)) : '')).join('');
  if (p.isBinaryExpression({ operator: '+' })) return evaluate(p.get('left'), new Set(seen)) + evaluate(p.get('right'), new Set(seen));
  if (p.isIdentifier()) {
    const binding = p.scope.getBinding(p.node.name);
    if (!binding || !binding.constant || seen.has(binding)) return HOLE;
    seen.add(binding);
    if (binding.path.isVariableDeclarator()) return evaluate(binding.path.get('init'), seen);
  }
  // Babel's conservative evaluator handles constant array joins and simple
  // immutable expressions; unknown calls never run during static inspection.
  const result = p.evaluate();
  return result.confident && ['string', 'number'].includes(typeof result.value) ? String(result.value) : HOLE;
}
function sqlTokens(sql) {
  // Reuse the schema linter's string/comment handling, then normalize quoted
  // identifiers so public."memories" and public.memories share a target.
  const identifiers = stripCommentsAndLiterals(sql).replace(/"((?:[^"]|"")+)"/g, (_, value) => value.replace(/""/g, '"'));
  return identifiers.toLowerCase();
}
const procedural = (sql) => /(?:^|;)\s*(?:do\s+(?:''|language\b)|call\s+[\w".]+\s*\(|execute\s+[\w".]+(?:\s*\(|\s*;|\s*$)|create\s+(?:or\s+replace\s+)?(?:function|procedure|trigger)\b)/i.test(sqlTokens(sql));
export function mutationTargets(sql) {
  const text = sqlTokens(sql);
  const targets = [];
  for (const match of text.matchAll(/\b(insert\s+into|merge\s+into|copy|update|delete\s+from|(?:drop|alter)\s+table|truncate(?:\s+table)?)\s+(?:if\s+exists\s+)?(?:only\s*\(?\s*)?([a-z_][\w$]*(?:\s*\.\s*[a-z_][\w$]*)?)/g)) {
    const table = match[2].replace(/\s/g, '').split('.').at(-1);
    if (TABLES.has(table)) targets.push({ operation: match[1].split(/\s/)[0], table });
  }
  // TRUNCATE and DROP accept several tables; checking only the first is a bypass.
  for (const match of text.matchAll(/\b(truncate(?:\s+table)?|drop\s+table)\s+(?:if\s+exists\s+)?([^;]+)/g)) {
    for (const part of match[2].split(',').slice(1)) {
      const table = part.trim().match(/^(?:only\s+)?([a-z_][\w$]*(?:\s*\.\s*[a-z_][\w$]*)?)/)?.[1]?.replace(/\s/g, '').split('.').at(-1);
      if (TABLES.has(table)) targets.push({ operation: match[1].split(/\s/)[0], table });
    }
  }
  return targets;
}
function isQueryCall(p) {
  const names = /^(?:query(?:FirmDb|OptionalFirmDb|Fn|Impl)?|executeSql|execSql)$/i;
  const seen = new Set();
  const queryCallee = (callee) => {
    if (!callee?.node || seen.has(callee.node)) return false;
    seen.add(callee.node);
    if (callee.isMemberExpression() || callee.isOptionalMemberExpression()) {
      const property = callee.node.computed ? evaluate(callee.get('property')) : callee.node.property?.name;
      return property === 'query' || (['call', 'apply', 'bind'].includes(property) && queryCallee(callee.get('object')));
    }
    if (callee.isCallExpression()) return queryCallee(callee.get('callee'));
    if (!callee.isIdentifier()) return false;
    if (names.test(callee.node.name)) return true;
    const binding = callee.scope.getBinding(callee.node.name);
    if (!binding?.constant) return false;
    if (binding.path.isImportSpecifier()) return names.test(binding.path.node.imported.name);
    if (!binding.path.isVariableDeclarator()) return false;
    if (binding.path.node.id.type === 'ObjectPattern') {
      return binding.path.node.id.properties.some((property) => property.type === 'ObjectProperty'
        && property.value?.name === callee.node.name && (property.key.name || property.key.value) === 'query');
    }
    return queryCallee(binding.path.get('init'));
  };
  const direct = p.node.callee;
  if (['MemberExpression', 'OptionalMemberExpression'].includes(direct?.type)
      && (direct.computed ? direct.property?.value : direct.property?.name) === 'bind') return false;
  return queryCallee(p.get('callee'));
}
export function scanMemoryWriterSource(source, file) {
  const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file,
    plugins: [...(/\.tsx?$/.test(file) ? ['typescript'] : []), 'jsx'] });
  const entries = [];
  const handled = new Set();
  const sqlPrefix = /^\s*(?:with|select|insert|merge|copy|update|delete|truncate|begin|start|commit|rollback|savepoint|release|set|create|alter|drop|do|call|execute)\b/i;
  const add = (p, sql, kind, targets) => {
    const enclosing = p.findParent((item) => item.isFunction());
    const context = enclosing ? source.slice(enclosing.node.start, enclosing.node.end) : source.slice(p.node.start, p.node.end);
    const normalized = normalize(sql) + (kind === 'dynamic_sql' ? ` | owner_body:${digest(context)}` : '');
    const entry = { file, owner: ownerOf(p), kind, digest: digest(normalized), targets,
      sql: normalized, line: p.node.loc.start.line };
    entries.push(entry); handled.add(p.node);
  };
  traverse(ast, {
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'(p) {
      if (p.node.source && TEST.test(p.node.source.value)) throw new Error(`Runtime memory scan refuses a test-module import: ${file} -> ${p.node.source.value}`);
    },
    // Scan SQL expressions at their defining boundary as well as direct calls.
    // This covers constant-held queries, CTEs and SQL passed to helper wrappers.
    'StringLiteral|TemplateLiteral|BinaryExpression'(p) {
      if (p.isBinaryExpression() && p.node.operator !== '+') return;
      if (p.parentPath.isTemplateLiteral() || p.parentPath.isBinaryExpression({ operator: '+' })) return;
      const sql = evaluate(p);
      if (!sqlPrefix.test(sqlTokens(sql)) || /^\s*select-/i.test(sql)) return;
      const targets = mutationTargets(sql);
      const dynamicTarget = sql.includes(HOLE) || procedural(sql);
      if (targets.length || dynamicTarget) add(p, sql, dynamicTarget ? 'dynamic_sql' : 'mutation', targets);
    },
    'CallExpression|OptionalCallExpression': { exit(p) {
      if (p.node.arguments.length && (p.node.callee.type === 'Import' || p.node.callee.name === 'require')
          && TEST.test(evaluate(p.get('arguments.0')))) throw new Error(`Runtime memory scan refuses a test-module import: ${file}`);
      if (!isQueryCall(p) || !p.node.arguments.length) return;
      let arg = p.get('arguments.0');
      if (arg.isObjectExpression()) {
        const text = arg.get('properties').find((property) => property.isObjectProperty() && (property.node.key.name || property.node.key.value) === 'text');
        arg = text ? text.get('value') : arg;
      }
      // Finite literal/control-statement alternatives are scanned at their
      // definitions; they are not opaque SQL and need no whole-owner debt.
      if (arg.isConditionalExpression() && ['consequent', 'alternate'].every((side) => !evaluate(arg.get(side)).includes(HOLE))) return;
      const sql = evaluate(arg);
      if (handled.has(arg.node)) return;
      if (!sql.includes(HOLE)) {
        const targets = mutationTargets(sql);
        if (targets.length || procedural(sql)) {
          // A constant-held expression is normally inventoried at its definition.
          const binding = arg.isIdentifier() && arg.scope.getBinding(arg.node.name);
          if (!binding?.path?.isVariableDeclarator() || !handled.has(binding.path.node.init))
            add(p, sql, procedural(sql) ? 'dynamic_sql' : 'mutation', targets);
        }
        return;
      }
      // Every unresolved SQL fragment is explicit debt, including apparently
      // read-only SELECT builders: an unknown fragment can add another statement.
      // Helpers/imported constants/migration runners remain separate opaque debt.
      // SQL expressions with any unresolved fragment are registered above. An
      // identifier may point to that defining expression; do not count it twice.
      if (sqlPrefix.test(sqlTokens(sql))) return;
      const enclosing = p.findParent((item) => item.isFunction());
      const expression = source.slice(arg.node.start, arg.node.end);
      const context = enclosing ? source.slice(enclosing.node.start, enclosing.node.end) : expression;
      add(p, `${normalize(expression)} | owner_body:${digest(context)}`, 'dynamic_query', []);
    } }
  });
  return entries;
}

export function scanMemoryWriters(root = ROOT) {
  const files = ['server', 'scripts'].flatMap((directory) => modules(path.join(root, directory), `${directory}/`));
  const entries = files.flatMap((file) => {
    const source = readFileSync(path.join(root, file), 'utf8');
    if (!file.endsWith('.sql')) return scanMemoryWriterSource(source, file);
    const targets = mutationTargets(source);
    return targets.length || procedural(source) ? [{ file, owner: '<sql-file>', kind: procedural(source) ? 'dynamic_sql' : 'mutation', digest: digest(normalize(source)), targets, sql: normalize(source), line: 1 }] : [];
  });
  return { files, entries };
}
export function checkMemoryWriterRegistry(scan, registry = MEMORY_WRITER_REGISTRY) {
  const errors = [], expected = new Map(), actual = new Map();
  for (const entry of registry) {
    const key = keyOf(entry);
    if (expected.has(key)) errors.push(`Duplicate registered memory writer: ${key}`);
    expected.set(key, entry);
    if (!entry.file || /[*?]/.test(entry.file) || !entry.owner
      || !['mutation', 'dynamic_sql', 'dynamic_query'].includes(entry.kind)
      || !Array.isArray(entry.targets) || !/^[a-f0-9]{64}$/.test(entry.digest)
      || !Number.isInteger(entry.count) || entry.count < 1
      || !['gateway', 'legacy_debt', 'maintenance_debt', 'dynamic_debt'].includes(entry.disposition)
      || !entry.rationale?.trim() || !entry.exitCriterion?.trim()) errors.push(`Invalid memory writer registration: ${key}`);
  }
  for (const entry of scan.entries) {
    const key = keyOf(entry), rows = actual.get(key) || [];
    rows.push(entry); actual.set(key, rows);
    if (!expected.has(key)) errors.push(`Unregistered memory write boundary: ${key} at line ${entry.line}`);
  }
  for (const [key, registered] of expected) {
    const rows = actual.get(key) || [];
    if (rows.length !== registered.count) errors.push(`Memory writer count changed (${registered.count} -> ${rows.length}): ${key}`);
    if (rows.length && JSON.stringify(rows[0].targets) !== JSON.stringify(registered.targets)) errors.push(`Memory writer target metadata changed: ${key}`);
  }
  return errors;
}
export function checkRepositoryMemoryWriters(root = ROOT) {
  const scan = scanMemoryWriters(root);
  return { ...scan, errors: checkMemoryWriterRegistry(scan) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkRepositoryMemoryWriters();
  console.log(`Memory write boundary: ${result.files.length} modules, ${result.entries.length} inventoried sites.`);
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
}
