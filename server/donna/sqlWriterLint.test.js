// SQL writer linter — unit tests for the parser/validator + an
// integration sweep over every writer module under `server/donna/`.
//
// The integration sweep is the gating contract: if any writer query
// references a column the migration tree doesn't define, the suite
// fails. This is the unit-test-time guardrail the brief asked for —
// catches the column-name class of bug (PR #77, #78) before a deploy.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSchemaMap,
  stripCommentsAndLiterals,
  normalizeSql,
  extractQueriesFromSource,
  validateQuery,
  lintFile
} from './sqlWriterLint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, '..', '..');
const migrationsDir = resolvePath(repoRoot, 'db', 'migrations');

// ─── Schema map ─────────────────────────────────────────────────────────

await test('schema map picks up CREATE TABLE columns', () => {
  const schema = buildSchemaMap(migrationsDir);
  const transactions = schema.get('transactions');
  assert.ok(transactions, 'transactions table exists');
  for (const col of ['id', 'firm_id', 'client_id', 'money_in', 'money_out', 'transaction_date', 'payload', 'reconciliation_status']) {
    assert.ok(transactions.has(col), `transactions has ${col}`);
  }
  // The intentionally-missing columns that PR #77 / #78 bugs referenced.
  assert.ok(!transactions.has('date'), 'transactions has NO bare `date`');
  assert.ok(!transactions.has('contact'), 'transactions has NO bare `contact`');
});

await test('schema map picks up ALTER TABLE ADD COLUMN', () => {
  const schema = buildSchemaMap(migrationsDir);
  // 011 adds parse_status and parse_run_id to documents.
  const documents = schema.get('documents');
  assert.ok(documents.has('parse_status'), 'documents.parse_status from 011');
  assert.ok(documents.has('parse_run_id'), 'documents.parse_run_id from 011');
  // 012 adds batch_id.
  assert.ok(documents.has('batch_id'), 'documents.batch_id from 012');
  // 013 adds line_no, fingerprint to document_lines.
  const lines = schema.get('document_lines');
  assert.ok(lines.has('fingerprint'), 'document_lines.fingerprint from 013');
  assert.ok(lines.has('review_status'), 'document_lines.review_status from 013');
});

await test('schema map keeps a column whose predecessor carries a trailing -- comment', () => {
  // Regression: a trailing line comment on the line before the LAST column
  // (037 `loop_runs`: `evaluator_version text, -- the model id IS the receipt`
  // then `created_at ...`) used to be glued onto the `created_at` segment by
  // the comma split, making it start with `--` and silently dropping the
  // column. The writer's INSERT then false-flagged `created_at` as unknown.
  const schema = buildSchemaMap(migrationsDir);
  const loopRuns = schema.get('loop_runs');
  assert.ok(loopRuns, 'loop_runs table exists');
  assert.ok(loopRuns.has('created_at'), 'loop_runs.created_at survives the trailing comment');
  // The multi-line CHECK on stop_reason must still resolve to the column.
  assert.ok(loopRuns.has('stop_reason'), 'loop_runs.stop_reason kept past its multi-line CHECK');
  assert.ok(loopRuns.has('evaluator_version'), 'loop_runs.evaluator_version (the commented line itself)');
});

// ─── Pre-processing ─────────────────────────────────────────────────────

await test('stripCommentsAndLiterals removes line + block comments', () => {
  assert.equal(
    stripCommentsAndLiterals('select id -- inline\n from t').trim(),
    'select id \n from t'.trim()
  );
  assert.equal(
    stripCommentsAndLiterals('select /* hi */ id from t'),
    'select  id from t'
  );
});

await test('stripCommentsAndLiterals collapses string literals to \'\'', () => {
  assert.equal(
    stripCommentsAndLiterals("select 'hello' from t"),
    "select '' from t"
  );
  // Handles doubled-quote escape inside literal.
  assert.equal(
    stripCommentsAndLiterals("select 'it''s ok' from t"),
    "select '' from t"
  );
});

await test('stripCommentsAndLiterals neutralizes ${...} JS template interpolations', () => {
  // The point: the JS variable inside ${} is NOT a SQL identifier.
  // Anything the runtime substitutes is the dynamic part; the linter
  // shouldn't validate it as a column.
  const stripped = stripCommentsAndLiterals('select ${columns} from t');
  assert.ok(!stripped.includes('columns'), 'columns identifier removed');
  // Nested braces survive.
  const nested = stripCommentsAndLiterals('select ${a({b: 1})} from t');
  assert.ok(!nested.includes('a'), 'no inner identifier leaks');
});

// ─── Query extractor ────────────────────────────────────────────────────

await test('extractQueriesFromSource finds backtick-quoted queries', () => {
  const source = `
    const result = await client.query(\`
      select id from transactions where firm_id = $1
    \`, [firmId]);
  `;
  const queries = extractQueriesFromSource(source);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /select id from transactions/);
});

await test('extractQueriesFromSource finds single-quoted queries', () => {
  const source = `await client.query('select id from t where firm_id=$1', [f]);`;
  const queries = extractQueriesFromSource(source);
  assert.equal(queries.length, 1);
});

// ─── Validator ──────────────────────────────────────────────────────────

const SCHEMA = buildSchemaMap(migrationsDir);

await test('validator: INSERT INTO X (a, b, c) — flags unknown column', () => {
  const v = validateQuery(
    `insert into transactions (id, firm_id, fake_column) values ($1, $2, $3)`,
    SCHEMA
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'unknown_column');
  assert.equal(v[0].table, 'transactions');
  assert.equal(v[0].column, 'fake_column');
});

await test('validator: INSERT INTO X (a, b, c) — passes when all real', () => {
  const v = validateQuery(
    `insert into transactions (id, firm_id, money_out, currency) values ($1, $2, $3, $4)`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: UPDATE X SET a = ... — flags unknown column', () => {
  const v = validateQuery(
    `update transactions set fake_column = $1, money_out = $2 where id = $3`,
    SCHEMA
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].column, 'fake_column');
});

await test('validator: qualified ref alias.col — flags PR #78-style bug', () => {
  // The actual bug from PR #78: `t.contact` against transactions when
  // contact lives in payload JSONB.
  const v = validateQuery(
    `select t.id, t.contact from transactions t where t.firm_id = $1`,
    SCHEMA
  );
  const contactViolations = v.filter((vi) => vi.column === 'contact');
  assert.ok(contactViolations.length >= 1);
  assert.equal(contactViolations[0].table, 'transactions');
});

await test('validator: qualified ref alias.col — flags PR #77-style bug', () => {
  // The actual bug from PR #77: `t.date` against transactions when
  // the column is `transaction_date`.
  const v = validateQuery(
    `select t.id, t.date from transactions t where t.firm_id = $1`,
    SCHEMA
  );
  const dateViolations = v.filter((vi) => vi.column === 'date');
  assert.ok(dateViolations.length >= 1);
});

await test('validator: alias.col with `as` alias resolves correctly', () => {
  const v = validateQuery(
    `select t.transaction_date as date, t.money_out from transactions as t where t.firm_id = $1`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: JSONB extraction payload->>\'x\' — column `payload` validated, key not', () => {
  // `payload` is a column on transactions; the JSONB key 'contact' is a literal, not a column.
  const v = validateQuery(
    `select payload->>'contact' as contact from transactions where firm_id = $1`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: JOIN with alias.col — validates both tables', () => {
  const v = validateQuery(
    `select ma.normalized_alias, m.normalized_name
       from merchant_aliases ma
       join merchants m on m.id = ma.merchant_id
      where ma.firm_id = $1`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: JOIN with alias.col — catches bad column on joined table', () => {
  const v = validateQuery(
    `select m.fake_column from merchant_aliases ma join merchants m on m.id = ma.merchant_id`,
    SCHEMA
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].column, 'fake_column');
  assert.equal(v[0].table, 'merchants');
});

await test('validator: ON CONFLICT DO UPDATE SET — validates target columns', () => {
  const v = validateQuery(
    `insert into reconciliation_matches (id, firm_id, client_id, bank_transaction_id, matched_object_type, matched_object_id, status, created_by, payload)
       values ($1, $2, $3, $4, $5, $6, 'suggested', 'system', $7::jsonb)
       on conflict (bank_transaction_id, matched_object_type, matched_object_id) do update
         set payload = reconciliation_matches.payload || excluded.payload, updated_at = now()`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: ON CONFLICT DO UPDATE SET — flags unknown column', () => {
  const v = validateQuery(
    `insert into reconciliation_matches (id, firm_id, client_id)
       values ($1, $2, $3)
       on conflict (id) do update
         set fake_column = excluded.payload`,
    SCHEMA
  );
  assert.ok(v.some((vi) => vi.column === 'fake_column'));
});

await test('validator: excluded.col — validates against insert target', () => {
  const v = validateQuery(
    `insert into transactions (id, money_out)
       values ($1, $2)
       on conflict (id) do update
         set money_out = excluded.fake_column`,
    SCHEMA
  );
  assert.ok(v.some((vi) => vi.column === 'fake_column' && vi.context === 'excluded.fake_column'));
});

await test('validator: bare ref in single-table query — flags unknown', () => {
  const v = validateQuery(
    `select id, fake_column from transactions where firm_id = $1`,
    SCHEMA
  );
  assert.ok(v.some((vi) => vi.column === 'fake_column'));
});

await test('validator: bare ref in single-table query — passes when real', () => {
  const v = validateQuery(
    `select id, money_out, currency from transactions where firm_id = $1`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: CTE — does not column-validate inside or against CTE alias', () => {
  const v = validateQuery(
    `with recent as (
       select id, fake_inside_cte from transactions where firm_id = $1
     )
     select r.whatever_unknown from recent r`,
    SCHEMA
  );
  // CTE internals + CTE-aliased columns are intentionally skipped — they
  // would require type inference we don't do.
  assert.deepEqual(v, []);
});

await test('validator: type cast $1::jsonb — does not flag jsonb as column', () => {
  const v = validateQuery(
    `update transactions set payload = $1::jsonb where id = $2`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: `for update` row-lock clause — does not flag `for` or `update`', () => {
  const v = validateQuery(
    `select id from transactions where firm_id = $1 for update`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

await test('validator: `/* lint:ignore */` skips the query', () => {
  const v = validateQuery(
    `/* lint:ignore */ select fake_column from transactions`,
    SCHEMA
  );
  assert.deepEqual(v, []);
});

// ─── Integration sweep — the actual gating contract ─────────────────────

await test('integration: every writer in server/donna issues only valid SQL', () => {
  const files = [];
  for (const f of readdirSync(resolvePath(repoRoot, 'server', 'donna'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      files.push(resolvePath(repoRoot, 'server', 'donna', f));
    }
  }
  for (const f of readdirSync(resolvePath(repoRoot, 'server', 'donna', 'inngest'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      files.push(resolvePath(repoRoot, 'server', 'donna', 'inngest', f));
    }
  }
  // RT-17: firmDb.js is decomposed into server/donna/db/<plane>.js — every
  // plane file is a writer and joins the sweep from the first move.
  for (const f of readdirSync(resolvePath(repoRoot, 'server', 'donna', 'db'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      files.push(resolvePath(repoRoot, 'server', 'donna', 'db', f));
    }
  }
  // Outbound-actions pipeline (M1): its writers issue SQL against clients /
  // documents / reconciliation tables too — a directory outside the sweep is
  // exactly how a wrong column name ships (clients.name vs company_name did).
  for (const f of readdirSync(resolvePath(repoRoot, 'server', 'donna', 'outbound'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      files.push(resolvePath(repoRoot, 'server', 'donna', 'outbound', f));
    }
  }
  for (const f of readdirSync(resolvePath(repoRoot, 'server', 'donna', 'taxAuthorities'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      files.push(resolvePath(repoRoot, 'server', 'donna', 'taxAuthorities', f));
    }
  }
  // Mobile API: the phone app's owner-scoped modules read and write client,
  // settings and registration tables directly.
  for (const f of readdirSync(resolvePath(repoRoot, 'server', 'donna', 'mobile'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      files.push(resolvePath(repoRoot, 'server', 'donna', 'mobile', f));
    }
  }

  const allViolations = [];
  for (const file of files) {
    const violations = lintFile(file, SCHEMA);
    for (const v of violations) allViolations.push(v);
  }

  if (allViolations.length) {
    const lines = allViolations
      .map((v) => `  ${v.file}:${v.line} ${v.kind} table=${v.table} column=${v.column ?? '?'} ctx=${v.context}`)
      .join('\n');
    throw new Error(`SQL writer violations:\n${lines}`);
  }
  assert.equal(allViolations.length, 0);
});

await test('integration proof: taxAuthorities sweep detects a planted unknown column', () => {
  const file = resolvePath(repoRoot, 'server', 'donna', 'taxAuthorities', 'hmrcVatObligations.js');
  const source = readFileSync(file, 'utf8').replace(
    'start_date = excluded.start_date',
    'bogus_column_xyz = excluded.start_date'
  );
  assert.match(source, /bogus_column_xyz/, 'the defect was planted');
  const violations = extractQueriesFromSource(source)
    .flatMap(({ sql }) => validateQuery(sql, SCHEMA));
  assert.ok(
    violations.some((violation) => violation.table === 'vat_periods'
      && violation.column === 'bogus_column_xyz'),
    'the tax-authority writer checker reads and rejects the planted defect'
  );
});

// ─── Self-test: the linter catches the historical bug patterns ──────────

await test('self-test: linter would have caught PR #77 (column "date") bug', () => {
  // Reconstruct the bug shape: SELECT t.date FROM transactions t.
  const v = validateQuery(
    `select t.id, t.date, t.money_out from transactions t where t.firm_id = $1`,
    SCHEMA
  );
  assert.ok(v.some((vi) => vi.column === 'date' && vi.table === 'transactions'),
    'PR #77 column "date" bug surfaces as a violation');
});

await test('self-test: linter would have caught PR #78 (column "contact") bug', () => {
  const v = validateQuery(
    `select t.id, t.contact from transactions t where t.firm_id = $1`,
    SCHEMA
  );
  assert.ok(v.some((vi) => vi.column === 'contact' && vi.table === 'transactions'),
    'PR #78 column "contact" bug surfaces as a violation');
});
