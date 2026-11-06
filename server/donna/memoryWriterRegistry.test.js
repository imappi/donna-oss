import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanMemoryWriters, scanMemoryWriterSource, checkMemoryWriterRegistry, checkRepositoryMemoryWriters, mutationTargets,
} from '../../scripts/check-memory-writers.mjs';
import { MEMORY_WRITE_TABLES, MEMORY_WRITER_REGISTRY } from './memoryWriterRegistry.js';

const file = 'server/donna/memoriesDb.js';
const scan = (source) => ({ entries: scanMemoryWriterSource(source, file) });
const register = (result) => result.entries.map((entry) => ({ ...entry, count: 1,
  disposition: entry.kind === 'mutation' ? 'gateway' : 'dynamic_debt',
  rationale: 'Test fixture reviewed statement.', exitCriterion: 'Remove with fixture.' }));
const errors = (source, registry = []) => checkMemoryWriterRegistry(scan(source), registry);

test('W3a scans the current runtime and maintenance tree against closed reviewed debt', () => {
  const result = checkRepositoryMemoryWriters();
  assert.ok(result.files.length > 800, 'the actual source tree must be scanned');
  assert.deepEqual(result.errors, []);
  assert.equal(MEMORY_WRITE_TABLES.length, 9);
  assert.ok(MEMORY_WRITER_REGISTRY.some((entry) => entry.disposition === 'legacy_debt'));
  assert.ok(MEMORY_WRITER_REGISTRY.some((entry) => entry.disposition === 'dynamic_debt'));
});

test('valid SQL in a new owner or an existing registered writer is refused', () => {
  const source = "function saveMemory(db) { return db.query(\"insert into memories (memory_id) values ($1)\"); }";
  const registry = register(scan(source));
  assert.deepEqual(errors(source, registry), []);
  assert.match(errors(source + "\nfunction bypass(db) { db.query('delete from memories'); }", registry).join('\n'), /Unregistered/);
  const planted = source.replace('return db.query', 'db.query("delete from memory_projections"); return db.query');
  assert.match(errors(planted, registry).join('\n'), /Unregistered/);
});

test('changing a registered mutation status, scope or target changes statement identity', () => {
  const original = `function save(db) { db.query("update client_rules set status = 'proposed' where firm_id = $1"); }`;
  const registry = register(scan(original));
  for (const changed of [original.replace("'proposed'", "'active'"), original.replace(' where firm_id = $1', ''), original.replace('client_rules', 'firm_facts')]) {
    assert.match(errors(changed, registry).join('\n'), /Unregistered/);
  }
  assert.deepEqual(errors('\n\n' + original.replace('set status', 'set   status'), registry), []);
  const literal = original.replace("'proposed'", "'two  spaces'");
  assert.match(errors(literal.replace('two  spaces', 'two spaces'), register(scan(literal))).join('\n'), /Unregistered/);
});

test('CTE writes cannot hide behind a read, comments, quoted or schema-qualified targets', () => {
  const sql = `/* SELECT only */ WITH seen AS (SELECT 1), hidden AS (
    DELETE FROM "public"."memory_evidence_links" WHERE memory_id = $1 RETURNING *
  ), changed AS (UPDATE ONLY public.memories SET record_state = 'active' RETURNING *)
  INSERT INTO public.memory_candidates (id) SELECT 'x'`;
  const result = scan(`const read = ${JSON.stringify(sql)}; function run(db) { db.query(read); }`);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].targets, [
    { operation: 'delete', table: 'memory_evidence_links' },
    { operation: 'update', table: 'memories' },
    { operation: 'insert', table: 'memory_candidates' },
  ]);
  assert.match(checkMemoryWriterRegistry(result, []).join('\n'), /Unregistered/);
});

test('constant SQL, concatenation, templates, and computed constant targets are inspected', () => {
  for (const source of [
    `const target = 'memories'; const sql = 'delete from ' + target; db.query(sql);`,
    'const target = "memory_dependencies"; db.query(`delete from ${target}`);',
    `const sql = 'delete from memory_relations'; db['query']({ text: sql });`,
  ]) assert.ok(scan(source).entries.some((entry) => entry.targets.length));
});

test('every computed SQL fragment and wholly unknown query requires explicit debt', () => {
  for (const source of [
    'function remove(db, target) { db.query(`delete from public.${target} where id = $1`); }',
    'function run(db, fragment) { db.query(`WITH hidden AS (${fragment}) SELECT 1`); }',
    'function read(db, suffix) { db.query(`SELECT 1 ${suffix}`); }',
    'function run(db, sql) { db.query(sql); }',
    'import { SQL } from "./unknown.js"; queryFirmDb(SQL);',
    'function run(db, sql) { db?.query(sql); }',
    'function run(db, sql) { const execute = db.query.bind(db); execute(sql); }',
    'import { queryFirmDb as execute } from "./pool.js"; execute(unknownSql);',
    'function run(db, table) { db.query(["delete from ", table].join("")); }',
  ]) {
    const result = scan(source);
    assert.ok(result.entries.length > 0, source);
    assert.ok(result.entries.every((entry) => entry.kind.startsWith('dynamic')));
    assert.match(checkMemoryWriterRegistry(result, []).join('\n'), /Unregistered/);
    assert.deepEqual(checkMemoryWriterRegistry(result, register(result)), []);
  }
});

test('changing the body of a registered unknown-target builder requires review again', () => {
  const original = 'function remove(db, target) { const quoted = quote(target); return db.query(`delete from ${quoted}`); }';
  const registry = register(scan(original));
  assert.match(errors(original.replace('quote(target)', 'unsafe(target)'), registry).join('\n'), /Unregistered/);
});

test('comments and SQL string contents do not invent mutations', () => {
  assert.deepEqual(mutationTargets(`SELECT 'delete from memories', $$update client_rules$$, $tag$insert into firm_facts$tag$ /* delete from memory_candidates */ -- update memories
  `), []);
  assert.deepEqual(mutationTargets(`SELECT '"delete from memories"'`), []);
  assert.deepEqual(mutationTargets('TRUNCATE TABLE other_table, public.memories, "memory_candidates"'), [
    { operation: 'truncate', table: 'memories' }, { operation: 'truncate', table: 'memory_candidates' },
  ]);
});

test('duplicating or deleting an identical statement fails the exact count contract', () => {
  const source = 'function save(db) { db.query("delete from memories"); }';
  const registry = register(scan(source));
  assert.match(errors(source.replace('db.query', 'db.query("delete from memories"); db.query'), registry).join('\n'), /count changed/);
  assert.match(errors('', registry).join('\n'), /count changed/);
});

test('wildcards, duplicate entries, unreasoned and malformed debt cannot broaden the registry', () => {
  const result = scan('function save(db) { db.query("delete from memories"); }');
  const entry = register(result)[0];
  for (const changed of [{ file: 'server/**' }, { rationale: '' }, { exitCriterion: '' }, { count: 0 }, { kind: 'anything' }, { targets: null }]) {
    assert.match(checkMemoryWriterRegistry(result, [{ ...entry, ...changed }]).join('\n'), /Invalid/);
  }
  assert.match(checkMemoryWriterRegistry(result, [entry, entry]).join('\n'), /Duplicate/);
});

test('actual registered legacy writer rejects planted activation mutation and disguised CTE', () => {
  const relative = 'server/donna/db/memory.js';
  const source = readFileSync(fileURLToPath(new URL('./db/memory.js', import.meta.url)), 'utf8');
  const baseline = { entries: scanMemoryWriterSource(source, relative) };
  const registry = MEMORY_WRITER_REGISTRY.filter((entry) => entry.file === relative);
  assert.deepEqual(checkMemoryWriterRegistry(baseline, registry), []);
  const changed = source.replace("'ai', 'proposed'", "'ai', 'active'");
  assert.notEqual(changed, source, 'plant must change the real statement');
  assert.match(checkMemoryWriterRegistry({ entries: scanMemoryWriterSource(changed, relative) }, registry).join('\n'), /Unregistered/);
  const cte = source + '\nconst claimedReadOnly = `/* read */ WITH write AS (DELETE FROM public.client_rules RETURNING *) SELECT count(*) FROM write`;';
  assert.match(checkMemoryWriterRegistry({ entries: scanMemoryWriterSource(cte, relative) }, registry).join('\n'), /Unregistered/);
});

test('transaction prefixes, unusual query wrappers and procedural SQL cannot hide mutation', () => {
  for (const sql of [
    'BEGIN; UPDATE memories SET record_state = $1; COMMIT',
    'SET LOCAL lock_timeout = 1000; DELETE FROM public.client_rules',
    'ALTER TABLE unrelated ADD COLUMN x text; INSERT INTO memory_projections (id) VALUES ($1)',
  ]) {
    const result = scan(`const statement = ${JSON.stringify(sql)}; strangeWrapper(statement);`);
    assert.ok(result.entries.some((entry) => entry.targets.length), sql);
    assert.match(checkMemoryWriterRegistry(result, []).join('\n'), /Unregistered/);
  }
  const result = scan('db.query(`DO $$ BEGIN DELETE FROM memories; END $$`);');
  assert.equal(result.entries[0].kind, 'dynamic_sql');
  assert.match(checkMemoryWriterRegistry(result, []).join('\n'), /Unregistered/);
});

test('fixture directories and raw SQL files cannot exempt a planted production writer', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'memory-writer-boundary-'));
  try {
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    for (const folder of ['fixtures', '__fixtures__', '__tests__', 'testSupport']) {
      const dir = path.join(root, 'server', 'newFeature', folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'production.js'), 'db.query("delete from memories");');
    }
    writeFileSync(path.join(root, 'scripts', 'repair.sql'), "UPDATE public.client_rules SET status = \'active\';");
    const result = scanMemoryWriters(root);
    assert.equal(result.entries.length, 5);
    assert.equal(checkMemoryWriterRegistry(result, []).length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const source of ['import run from "./bypass.test.js";', 'require("./bypass.test.js");', 'import("./bypass.test.js");']) {
    assert.throws(() => scan(source), /test-module import/);
  }
});

test('PG16 merge/copy and destructive DDL are mutations, with query aliases and re-exports closed', () => {
  for (const sql of [
    "MERGE INTO memories m USING (SELECT 1) s ON true WHEN MATCHED THEN UPDATE SET record_state='active'",
    "COPY memories FROM '/tmp/import.csv' CSV HEADER",
    'DROP TABLE IF EXISTS public.memories CASCADE',
    'DROP TABLE other, public.memories CASCADE',
    'ALTER TABLE memories DISABLE TRIGGER ALL',
    'UPDATE ONLY (public.memories) SET record_state = $1',
  ]) assert.ok(scan(`db.query(${JSON.stringify(sql)});`).entries.some((entry) => entry.targets.length), sql);
  for (const source of [
    'const { query: execute } = db; execute(sql);',
    'db[`qu${"ery"}`](sql);',
  ]) assert.ok(scan(source).entries.some((entry) => entry.kind === 'dynamic_query'), source);
  for (const source of ['export { default } from "./hidden.test.js";', 'export * from "./hidden.test.js";']) {
    assert.throws(() => scan(source), /test-module import/);
  }
});
