// SQL bind-count ratchet (2026-09-03).
//
// Why: `recordEvidenceTopicTurnInDb` bound FIVE values to a THREE-placeholder
// update from the day it was born (#1932). PostgreSQL refuses the bind
// ("bind message supplies 5 parameters, but prepared statement "" requires
// 3"), so every client-portal / SMS / Telegram / WhatsApp topic turn threw and
// the owner's reply never left the ask row. The mocked writer tests could not
// see it — a fake `client.query` accepts any array. This lint reads every
// `.query(<literal>, [<literal array>])` call under server/donna and refuses a
// placeholder count that disagrees with the array length. It is static, needs
// no database, and fails on exactly the defect class the mocks wave through.
//
// Deliberately narrow: only a literal SQL string/template followed by a
// LITERAL array is checked; a template with `${…}` interpolation, a params
// variable, or a spread is skipped (a dynamic clause can add placeholders the
// scanner cannot see). Widen it only with a fixture that failed first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const listJsFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === 'fixtures') continue;
    if (statSync(full).isDirectory()) listJsFiles(full, out);
    else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(full);
  }
  return out;
};

// Walk a bracketed region ("[" … "]", "(" … ")") honouring strings; returns
// the index of the matching closer or -1.
const matchClose = (s, open) => {
  let depth = 0;
  let quote = null;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '[' || c === '(' || c === '{') depth += 1;
    else if (c === ']' || c === ')' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const countTopLevelItems = (body) => {
  if (!body.trim()) return 0;
  let depth = 0;
  let quote = null;
  let items = 1;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '[' || c === '(' || c === '{') depth += 1;
    else if (c === ']' || c === ')' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) items += 1;
  }
  if (body.trimEnd().endsWith(',')) items -= 1; // trailing comma
  return items;
};

export const scanSqlBindCounts = (source) => {
  const findings = [];
  let cursor = 0;
  for (;;) {
    const at = source.indexOf('.query(', cursor);
    if (at < 0) break;
    const argStart = at + '.query('.length;
    const literal = /^\s*(`|'|")/.exec(source.slice(argStart));
    if (!literal) { cursor = argStart; continue; }
    const quote = literal[1];
    const sqlStart = argStart + literal[0].length;
    let sqlEnd = sqlStart;
    for (;;) {
      sqlEnd = source.indexOf(quote, sqlEnd);
      if (sqlEnd < 0 || source[sqlEnd - 1] !== '\\') break;
      sqlEnd += 1;
    }
    if (sqlEnd < 0) break;
    const sql = source.slice(sqlStart, sqlEnd);
    cursor = sqlEnd + 1;
    const tail = /^\s*,\s*\[/.exec(source.slice(sqlEnd + 1));
    if (!tail) continue;
    if (quote === '`' && sql.includes('${')) continue; // dynamic clause — skipped
    const arrayOpen = sqlEnd + 1 + tail[0].length - 1;
    const arrayClose = matchClose(source, arrayOpen);
    if (arrayClose < 0) continue;
    const body = source.slice(arrayOpen + 1, arrayClose);
    if (body.includes('...')) continue; // spread — skipped
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    if (!placeholders.length) continue;
    const maxPlaceholder = Math.max(...placeholders);
    const bound = countTopLevelItems(body);
    if (maxPlaceholder !== bound) {
      const line = source.slice(0, at).split('\n').length;
      findings.push({ line, placeholders: maxPlaceholder, bound, sql: sql.trim().split('\n')[0].slice(0, 80) });
    }
    cursor = arrayClose + 1;
  }
  return findings;
};

test('the scanner sees a bind-count mismatch and accepts a matching one', () => {
  const bad = "await client.query(`update t set a = $3 where f = $1 and id = $2`, [f, id, a, extra, more]);";
  const good = "await client.query(`update t set a = $3 where f = $1 and id = $2`, [f, id, a]);";
  const dynamic = "await client.query(`select 1 where f = $1 ${clause}`, [f, extra]);";
  assert.deepEqual(scanSqlBindCounts(bad).map((f) => [f.placeholders, f.bound]), [[3, 5]]);
  assert.deepEqual(scanSqlBindCounts(good), []);
  assert.deepEqual(scanSqlBindCounts(dynamic), []);
});

test('every literal query under server/donna binds exactly as many values as it has placeholders', () => {
  const offenders = [];
  for (const file of listJsFiles(HERE)) {
    const source = readFileSync(file, 'utf8');
    for (const finding of scanSqlBindCounts(source)) {
      offenders.push(`${path.relative(HERE, file)}:${finding.line} placeholders=$${finding.placeholders} bound=${finding.bound} | ${finding.sql}`);
    }
  }
  assert.deepEqual(offenders, [], `SQL bind-count mismatches:\n${offenders.join('\n')}`);
});
