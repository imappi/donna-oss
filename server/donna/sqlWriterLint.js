// Lightweight SQL writer linter — catches the column-name class of bug at
// unit-test time, without standing up a Postgres container. PR #77 and
// #78 each shipped a `column "X" does not exist` regression that the
// mock-client harness couldn't see; this module is the in-process
// guardrail.
//
// Scope:
//   - Build a {table: Set<column>} schema map from `db/migrations/*.sql`
//   - Scan each writer module for `client.query(`SQL`)` callsites
//   - For every query, validate:
//       - INSERT INTO X (a, b, c) — a/b/c must be columns of X
//       - UPDATE X SET a = ... , b = ... — a/b must be columns of X
//       - alias.col (qualified column refs) — col must be in alias's
//         resolved table
//       - Bare refs in single-table queries (FROM/UPDATE/DELETE on one
//         table, no JOINs) — col must be in that table
//
// Out of scope (silently skipped to keep false-positive surface low):
//   - Multi-table bare column refs (ambiguous without a typesystem)
//   - CTEs (`with x as (...)` — inner statement validated, outer cols
//     against the CTE alias skipped)
//   - Subqueries inside expressions
//   - Function-return-typed rows
//   - Recursive CTEs
//
// Per-query opt-out: prefix a SQL string with `/* lint:ignore */` to skip.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath, basename } from 'node:path';

// ─── Schema map ─────────────────────────────────────────────────────────

const COLUMN_LINE_RE = /^\s*([a-z_][a-z0-9_]*)\s+/i;

// Tokens that may appear as the first word of a column-definition line
// in a CREATE TABLE block, but that aren't column names themselves —
// table-level constraints / hints. Skipping these keeps the column-set
// honest.
const CREATE_TABLE_NON_COLUMN_PREFIXES = new Set([
  'primary',
  'foreign',
  'unique',
  'check',
  'constraint',
  'exclude',
  'like'
]);

const parseCreateTableBlock = (body) => {
  // Strip SQL comments (and literals) first. A trailing line comment on a
  // column line — e.g. `evaluator_version text, -- the model id IS …` — would
  // otherwise be carried by the comma split into the NEXT column's segment;
  // that segment then starts with `--`, fails COLUMN_LINE_RE, and the column
  // is silently dropped. That's exactly how 037's `loop_runs.created_at` went
  // missing from the schema map and produced a false-positive on its writer.
  // (Block comments and `--` inside literals are handled correctly too.)
  const cleaned = stripCommentsAndLiterals(body);

  // Split on commas that are at top-level (not inside parens). Postgres
  // type defs can contain parenthesised args (e.g. `numeric(12,2)`), so
  // a naive split breaks. State-machine split keeps things simple.
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of cleaned) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  const columns = new Set();
  for (const raw of parts) {
    const line = raw.trim().replace(/\s+/g, ' ');
    const match = line.match(COLUMN_LINE_RE);
    if (!match) continue;
    const first = match[1].toLowerCase();
    if (CREATE_TABLE_NON_COLUMN_PREFIXES.has(first)) continue;
    columns.add(first);
  }
  return columns;
};

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
const ALTER_ADD_COLUMN_RE = /alter\s+table\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)([\s\S]*?);/gi;
const ADD_COLUMN_CLAUSE_RE = /add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
const DROP_COLUMN_CLAUSE_RE = /drop\s+column\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;

export const buildSchemaMap = (migrationsDir) => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const schema = new Map();

  for (const file of files) {
    const raw = readFileSync(resolvePath(migrationsDir, file), 'utf8');
    // Strip comments + literals BEFORE matching CREATE TABLE / ALTER. The non-greedy
    // table-body capture (`\(([\s\S]*?)\)\s*;`) runs on this text, so a `);` inside a
    // COMMENT — e.g. migration 042's `(the cohort/default source);` — would otherwise
    // terminate the capture early and silently drop every column after the comment
    // (id+firm_id kept, client_id… onward lost → false-positive unknown_column on the
    // writers). parseCreateTableBlock already strips its body for the sibling
    // column-level case; this lifts the same discipline up to the table-capture level.
    // Idempotent: re-stripping a clean body inside parseCreateTableBlock is a no-op.
    const sql = stripCommentsAndLiterals(raw);

    for (const match of sql.matchAll(CREATE_TABLE_RE)) {
      const table = match[1].toLowerCase();
      const columns = parseCreateTableBlock(match[2]);
      if (!schema.has(table)) schema.set(table, new Set());
      const set = schema.get(table);
      for (const col of columns) set.add(col);
    }

    for (const match of sql.matchAll(ALTER_ADD_COLUMN_RE)) {
      const table = match[1].toLowerCase();
      const body = match[2];
      if (!schema.has(table)) schema.set(table, new Set());
      const set = schema.get(table);
      for (const addMatch of body.matchAll(ADD_COLUMN_CLAUSE_RE)) {
        set.add(addMatch[1].toLowerCase());
      }
      for (const dropMatch of body.matchAll(DROP_COLUMN_CLAUSE_RE)) {
        set.delete(dropMatch[1].toLowerCase());
      }
    }
  }

  return schema;
};

// ─── SQL tokenizer / pre-processing ─────────────────────────────────────

// Strip line comments, block comments, JS template interpolations
// (${...}), and replace string literals with empty `''` so identifiers
// inside literals don't confuse the parser. Dollar-quoted strings
// ($$...$$) are also handled — none in this repo but cheap insurance.
export const stripCommentsAndLiterals = (sql) => {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    // Line comment
    if (sql.startsWith('--', i)) {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    // Block comment
    if (sql.startsWith('/*', i)) {
      i += 2;
      while (i < n && !sql.startsWith('*/', i)) i += 1;
      i += 2;
      continue;
    }
    // JS template interpolation — `${expr}`. The value is computed at
    // runtime and may be anything (a column list, a WHERE fragment, a
    // literal). For the linter, replace it with a neutral placeholder so
    // the identifier inside doesn't get treated as a column reference.
    // Note: any column references INSIDE the interpolation aren't
    // linted — they're JS variables, not SQL. Real bugs there would
    // surface in their own dynamic-SQL test.
    if (sql.startsWith('${', i)) {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === '{') depth += 1;
        else if (sql[i] === '}') depth -= 1;
        i += 1;
      }
      out += ' '; // preserve token boundary
      continue;
    }
    // String literal — find matching ' (handles '' escape)
    if (sql[i] === "'") {
      out += "''"; // placeholder so token boundaries stay intact
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Dollar-quoted string
    if (sql[i] === '$') {
      const tagMatch = sql.slice(i).match(/^\$([a-zA-Z_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        out += `''`;
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          i = n;
        } else {
          i = end + tag.length;
        }
        continue;
      }
    }
    out += sql[i];
    i += 1;
  }
  return out;
};

// Normalize whitespace, lowercase keywords. Identifiers stay verbatim
// (they're case-insensitive in Postgres by default, but we work in
// lowercase consistently — all migrations are lowercase).
export const normalizeSql = (sql) =>
  stripCommentsAndLiterals(sql).toLowerCase().replace(/\s+/g, ' ').trim();

// ─── Query extraction from JS source ────────────────────────────────────

// Match `client.query(\`...\`)` or `client.query('...')` or
// `.query(\`...\`)` calls. Backtick templates dominate the codebase.
// We capture the first string-literal argument; multi-line backtick
// templates work cleanly because JS doesn't introduce extra chars.
const QUERY_CALL_RE = /\.\s*query\s*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g;

export const extractQueriesFromSource = (jsSource) => {
  const queries = [];
  for (const match of jsSource.matchAll(QUERY_CALL_RE)) {
    const raw = match[1];
    // Unwrap the quote/backtick.
    const sql = raw.slice(1, -1);
    // Get the line number of the open quote.
    const before = jsSource.slice(0, match.index);
    const line = before.split('\n').length;
    queries.push({ sql, line });
  }
  return queries;
};

// ─── Query parsing ──────────────────────────────────────────────────────

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'as',
  'join', 'left', 'right', 'inner', 'outer', 'on', 'cross', 'lateral',
  'update', 'set', 'insert', 'into', 'values', 'delete', 'returning',
  'with', 'recursive', 'union', 'all', 'except', 'intersect',
  'order', 'by', 'group', 'having', 'limit', 'offset', 'asc', 'desc', 'nulls', 'first', 'last',
  'on', 'conflict', 'do', 'nothing',
  // Row-locking clause: `for update`, `for share`, `for no key update`, …
  'for', 'share', 'key', 'no', 'nowait', 'skip', 'locked',
  'begin', 'commit', 'rollback', 'savepoint', 'release',
  'true', 'false', 'distinct', 'case', 'when', 'then', 'else', 'end',
  'between', 'like', 'ilike', 'similar', 'to', 'any', 'some',
  'cast', 'using', 'array', 'row',
  'exists', 'returning', 'natural',
  'jsonb_build_object', 'jsonb_set', 'jsonb_agg', 'json_build_object',
  'array_agg', 'string_agg', 'count', 'sum', 'avg', 'min', 'max',
  'now', 'current_timestamp', 'current_date', 'current_time',
  'coalesce', 'nullif', 'greatest', 'least',
  'abs', 'round', 'floor', 'ceil', 'mod', 'power', 'sqrt',
  'lower', 'upper', 'length', 'trim', 'btrim', 'ltrim', 'rtrim',
  'substring', 'substr', 'position', 'replace', 'concat', 'split_part',
  'to_char', 'to_date', 'to_timestamp', 'to_number',
  'extract', 'date_part', 'date_trunc', 'age', 'interval',
  'array_length', 'cardinality', 'unnest',
  'generate_series',
  'pg_typeof', 'gen_random_uuid', 'gen_random_bytes', 'md5', 'sha256',
  'xmax', 'xmin', 'ctid', 'tableoid' // postgres system columns
]);

const SYSTEM_TABLES = new Set([
  'excluded', // ON CONFLICT pseudo-table
  'pg_catalog', 'pg_indexes', 'pg_tables', 'pg_namespace', 'pg_class',
  'information_schema', 'pg_stat_user_tables'
]);

// Cast operator targets we should ignore (e.g. `$1::jsonb` — `jsonb` is
// a type, not a column).
const POSTGRES_TYPES = new Set([
  'text', 'integer', 'int', 'int2', 'int4', 'int8', 'bigint', 'smallint',
  'numeric', 'decimal', 'real', 'double', 'precision', 'float',
  'boolean', 'bool', 'uuid', 'date', 'time', 'timestamp', 'timestamptz',
  'interval',
  'json', 'jsonb',
  'bytea',
  'serial', 'bigserial',
  'varchar', 'char', 'character', 'varying'
]);

// Words that look like identifiers in our queries but are actually
// keywords we missed above. Note: POSTGRES_TYPES is intentionally NOT
// included here — `date`, `time`, etc. are also valid column names
// (and PR #77 was literally a `t.date` bug). Type names get
// disambiguated via the `::` predecessor check (which marks them as
// the RHS of a cast) and the `as` predecessor check (CAST(expr AS
// type)) in the bare-ref scanner.
const IGNORE_AS_IDENTIFIER = new Set([
  ...SQL_KEYWORDS,
  // Pseudo-identifiers
  'excluded',
  'default'
]);

// Tokens we treat as table-introducing clauses.
const TABLE_INTRO_CLAUSES = ['from', 'join', 'update', 'into', 'using'];

const tokenizeIdentifiers = (sql) => {
  // Yield {type, value, index} for each identifier or punctuation token
  // we care about. We keep punctuation so column-list parsers can find
  // their boundaries.
  const tokens = [];
  const re = /([a-z_][a-z0-9_]*)|([(),;=*])|->>?|::|\$\d+|[<>!]=?|\+|-|\/|%|\|\||@>|<@|\?/g;
  let match;
  while ((match = re.exec(sql)) !== null) {
    if (match[1]) {
      tokens.push({ type: 'ident', value: match[1], index: match.index });
    } else if (match[2]) {
      tokens.push({ type: 'punct', value: match[2], index: match.index });
    } else {
      // operator — surfaced as punct so callers can decide what to do
      tokens.push({ type: 'op', value: match[0], index: match.index });
    }
  }
  return tokens;
};

// Find statements by splitting on the top-level `;`. Inside parens we
// stay in the same statement.
const splitStatements = (sql) => {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of sql) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) {
      if (current.trim()) out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
};

// Find tables referenced + their aliases. Returns `{ tables: Map<alias, table>,
// primary: <table>|null }`. Primary is the first FROM/UPDATE/INSERT/DELETE
// target, used for resolving bare column refs when there's a single
// table in scope.
const extractTablesAndAliases = (sql, tokens) => {
  const aliasMap = new Map(); // alias → resolved table
  const referencedTables = new Set();
  let primary = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== 'ident') continue;
    const value = t.value;
    // Match the patterns:
    //   from <table> [[as] <alias>]
    //   join <table> [[as] <alias>]
    //   update <table> [[as] <alias>]
    //   insert into <table>           (no alias)
    //   delete from <table> [[as] <alias>]
    if (TABLE_INTRO_CLAUSES.includes(value)) {
      // Look ahead for an identifier.
      const next = tokens[i + 1];
      if (!next || next.type !== 'ident') continue;
      const table = next.value;
      // `insert into X` — handled when value is 'into' and a previous token was 'insert'
      // `delete from X` — handled when value is 'from' and the previous token was 'delete'
      // For these we still want the table.
      if (SYSTEM_TABLES.has(table)) continue;
      if (SQL_KEYWORDS.has(table)) continue;
      referencedTables.add(table);
      if (!primary) primary = table;

      // Try to find an alias. The next tokens could be:
      //   <table> <alias>            → next+1 is alias if ident and not a keyword
      //   <table> as <alias>          → next+1 is 'as', next+2 is alias
      //   <table> (no alias)          → next+1 is a keyword or punct
      let aliasIdx = i + 2;
      if (tokens[aliasIdx] && tokens[aliasIdx].type === 'ident' && tokens[aliasIdx].value === 'as') {
        aliasIdx = i + 3;
      }
      const aliasTok = tokens[aliasIdx];
      if (aliasTok && aliasTok.type === 'ident' && !SQL_KEYWORDS.has(aliasTok.value)) {
        aliasMap.set(aliasTok.value, table);
      }
      // Always allow `<table>.col` even without an explicit alias.
      aliasMap.set(table, table);
    }
  }

  return { tables: referencedTables, aliasMap, primary };
};

// Find the INSERT column list: `insert into X (a, b, c) values (...)`.
// Returns { table, columns: string[] } or null.
const extractInsertColumns = (sql, tokens) => {
  // Locate "insert into <table> ("
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (
      tokens[i].type === 'ident' &&
      tokens[i].value === 'insert' &&
      tokens[i + 1].type === 'ident' &&
      tokens[i + 1].value === 'into' &&
      tokens[i + 2].type === 'ident'
    ) {
      const table = tokens[i + 2].value;
      // Next token must be `(`. If it's not, no explicit column list.
      const openIdx = i + 3;
      const openTok = tokens[openIdx];
      if (!openTok || openTok.type !== 'punct' || openTok.value !== '(') return null;
      // Collect identifiers until the matching `)`.
      const cols = [];
      let depth = 1;
      let j = openIdx + 1;
      while (j < tokens.length && depth > 0) {
        const tk = tokens[j];
        if (tk.type === 'punct' && tk.value === '(') depth += 1;
        else if (tk.type === 'punct' && tk.value === ')') depth -= 1;
        else if (depth === 1 && tk.type === 'ident' && !SQL_KEYWORDS.has(tk.value)) {
          cols.push(tk.value);
        }
        j += 1;
      }
      return { table, columns: cols };
    }
  }
  return null;
};

// Find UPDATE SET assignments: `update X set a = ..., b = ...`. Returns
// { table, columns: string[] } or null. Handles ON CONFLICT DO UPDATE
// SET too (where the implicit target table is the prior INSERT INTO).
const extractUpdateSetColumns = (sql, tokens, insertTarget) => {
  const targets = []; // { table, columns: [] }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const tk = tokens[i];
    // `update <table> ... set`
    if (tk.type === 'ident' && tk.value === 'update' && tokens[i + 1]?.type === 'ident') {
      const table = tokens[i + 1].value;
      // Find the next 'set' keyword at the same level.
      let setIdx = -1;
      let depth = 0;
      for (let j = i + 2; j < tokens.length; j += 1) {
        const t2 = tokens[j];
        if (t2.type === 'punct' && t2.value === '(') depth += 1;
        else if (t2.type === 'punct' && t2.value === ')') depth -= 1;
        else if (depth === 0 && t2.type === 'ident' && t2.value === 'set') {
          setIdx = j;
          break;
        } else if (depth === 0 && t2.type === 'ident' && t2.value === 'where') {
          break;
        }
      }
      if (setIdx === -1) continue;
      const cols = collectSetClauseColumns(tokens, setIdx + 1);
      targets.push({ table, columns: cols });
    }
    // `on conflict ... do update set`
    if (tk.type === 'ident' && tk.value === 'do' && tokens[i + 1]?.value === 'update' && tokens[i + 2]?.value === 'set') {
      // The target is the INSERT INTO table.
      if (insertTarget) {
        const cols = collectSetClauseColumns(tokens, i + 3);
        targets.push({ table: insertTarget, columns: cols });
      }
    }
  }
  return targets;
};

// Starting at the token AFTER `set`, collect column names from the
// assignment list. Each assignment is `col = expr` or `col = excluded.col`.
// We stop at the next clause keyword (where/returning/from) at depth 0.
const collectSetClauseColumns = (tokens, startIdx) => {
  const cols = [];
  let depth = 0;
  let expectingColumn = true;
  let inExpression = false;
  for (let i = startIdx; i < tokens.length; i += 1) {
    const tk = tokens[i];
    if (tk.type === 'punct' && tk.value === '(') {
      depth += 1;
      inExpression = true;
      continue;
    }
    if (tk.type === 'punct' && tk.value === ')') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && tk.type === 'ident') {
      if (['where', 'returning', 'from', 'on'].includes(tk.value)) break;
      if (expectingColumn && !SQL_KEYWORDS.has(tk.value)) {
        cols.push(tk.value);
        expectingColumn = false;
        inExpression = true;
      }
    }
    if (depth === 0 && tk.type === 'punct' && tk.value === ',' && !inExpression) {
      expectingColumn = true;
    }
    if (depth === 0 && tk.type === 'op' && tk.value === '=') {
      // After `=`, we're in expression mode until the next top-level comma.
      inExpression = true;
    }
    if (depth === 0 && tk.type === 'punct' && tk.value === ',') {
      // Top-level comma resets to expecting a column.
      expectingColumn = true;
      inExpression = false;
    }
  }
  return cols;
};

// Extract every `alias.column` pair. Returns Array<{alias, column, index}>.
const extractQualifiedRefs = (sql, tokens) => {
  const refs = [];
  for (let i = 0; i < tokens.length - 2; i += 1) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const c = tokens[i + 2];
    if (
      a.type === 'ident' &&
      b.type === 'op' &&
      b.value === '::'
    ) {
      // Type cast — skip
      continue;
    }
    if (
      a.type === 'ident' &&
      b.type === 'op' &&
      (b.value === '->' || b.value === '->>')
    ) {
      // JSONB extraction — `a` is the column, `c` is a key literal.
      continue;
    }
    if (
      a.type === 'ident' &&
      b.type === 'punct' &&
      b.value === ',' // not a qualified ref
    ) {
      continue;
    }
    // We want `<ident> . <ident>` where `.` is a punct.
  }
  // Re-scan with a different approach: walk the raw normalized SQL
  // looking for `\b<alias>\.<column>\b` matches.
  const ALIASED_COL_RE = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g;
  for (const match of sql.matchAll(ALIASED_COL_RE)) {
    refs.push({ alias: match[1], column: match[2], index: match.index });
  }
  return refs;
};

// ─── Validation ─────────────────────────────────────────────────────────

export const validateQuery = (rawSql, schemaMap) => {
  const rawViolations = [];

  if (/\/\*\s*lint:ignore\s*\*\//i.test(rawSql)) return rawViolations;

  // Convenience handle so the rest of the function reads naturally;
  // we dedupe at the end before returning.
  const violations = rawViolations;

  // Pre-process: strip comments + literals, lowercase, normalize whitespace.
  const sql = normalizeSql(rawSql);
  if (!sql) return violations;

  // Trivial control statements — skip.
  if (['begin', 'commit', 'rollback'].includes(sql.split(' ')[0])) return violations;

  // Split into top-level statements (rare in our codebase — usually 1).
  for (const stmt of splitStatements(sql)) {
    const tokens = tokenizeIdentifiers(stmt);
    if (!tokens.length) continue;

    // Locate CTE aliases — anything between `with X as (...)` blocks.
    // We treat CTE names as synthetic tables: refs to them are allowed,
    // but we don't column-validate their internals. Capture each CTE
    // name; treat it as a wildcard table (any column allowed).
    const cteAliases = new Set();
    const withMatches = [...stmt.matchAll(/\bwith\s+([a-z_][a-z0-9_]*)\s+as\s*\(/g)];
    for (const m of withMatches) cteAliases.add(m[1]);
    // Also handle chained CTEs: `, otherCte as (`
    const chainedCteRe = /,\s*([a-z_][a-z0-9_]*)\s+as\s*\(/g;
    for (const m of stmt.matchAll(chainedCteRe)) cteAliases.add(m[1]);

    const { tables, aliasMap, primary } = extractTablesAndAliases(stmt, tokens);
    // Add CTEs as virtual tables (no column constraint).
    for (const cte of cteAliases) {
      aliasMap.set(cte, `__cte:${cte}`);
    }

    // 1. INSERT INTO X (a, b, c) — validate.
    const insert = extractInsertColumns(stmt, tokens);
    if (insert) {
      const tableCols = schemaMap.get(insert.table);
      if (!tableCols) {
        // Insertion against an unknown table is itself a violation, unless it's a CTE.
        if (!cteAliases.has(insert.table)) {
          violations.push({
            kind: 'unknown_table',
            table: insert.table,
            context: 'insert into'
          });
        }
      } else {
        for (const col of insert.columns) {
          if (!tableCols.has(col)) {
            violations.push({
              kind: 'unknown_column',
              table: insert.table,
              column: col,
              context: 'insert column list'
            });
          }
        }
      }
    }

    // 2. UPDATE X SET a = ..., b = ... — validate.
    const updateTargets = extractUpdateSetColumns(stmt, tokens, insert?.table);
    for (const target of updateTargets) {
      const tableCols = schemaMap.get(target.table);
      if (!tableCols) {
        if (!cteAliases.has(target.table)) {
          violations.push({
            kind: 'unknown_table',
            table: target.table,
            context: 'update set'
          });
        }
        continue;
      }
      for (const col of target.columns) {
        if (!tableCols.has(col)) {
          violations.push({
            kind: 'unknown_column',
            table: target.table,
            column: col,
            context: 'update set'
          });
        }
      }
    }

    // 3. Qualified column refs alias.col.
    for (const ref of extractQualifiedRefs(stmt, tokens)) {
      const { alias, column } = ref;
      // Skip JSONB key refs that follow `->>` / `->` — those are
      // string literals and the regex above already excluded them
      // because the JSONB key is a quoted string (stripped to '').
      // Skip `excluded.col` — `excluded` is the synthetic ON CONFLICT
      // alias; the column refers to the would-be-inserted row.
      if (alias === 'excluded') {
        // Validate against the insert target table if known.
        if (insert) {
          const tableCols = schemaMap.get(insert.table);
          if (tableCols && !tableCols.has(column)) {
            violations.push({
              kind: 'unknown_column',
              table: insert.table,
              column,
              context: `excluded.${column}`
            });
          }
        }
        continue;
      }
      // NOTE: we do NOT skip when `column` is a Postgres type name. A
      // ref like `t.date` is unambiguously a column reference (alias.col
      // syntax), regardless of `date` also being a type name. Filtering
      // out type names here was the bug that hid PR #77 from this very
      // linter during early development.
      // Skip schema-qualified system tables.
      if (SYSTEM_TABLES.has(alias)) continue;
      // CTE alias → no column validation (we don't track CTE internal types).
      if (cteAliases.has(alias)) continue;
      // Number-suffixed alias (e.g. `t1`, `t2`) commonly appears in
      // self-joins. If we don't know the alias, that's a parse failure
      // on our side — skip rather than false-positive.
      const resolvedTable = aliasMap.get(alias);
      if (!resolvedTable) continue;
      if (resolvedTable.startsWith('__cte:')) continue;
      const tableCols = schemaMap.get(resolvedTable);
      if (!tableCols) continue; // unknown table — already flagged or out of scope
      if (!tableCols.has(column)) {
        violations.push({
          kind: 'unknown_column',
          table: resolvedTable,
          column,
          context: `${alias}.${column}`
        });
      }
    }

    // 4. Bare refs in single-table queries.
    // Only attempt this when there's exactly ONE table in scope AND
    // no CTE in play AND no UPDATE…FROM subquery (otherwise ambiguity
    // is high). Columns appearing in INSERT VALUES are skipped (handled
    // above); SELECT/WHERE bare idents are validated.
    const hasUpdateFromSubquery = /\bfrom\s*\(/.test(stmt) && /^\s*update\s/.test(stmt);
    if (tables.size === 1 && cteAliases.size === 0 && !insert && !hasUpdateFromSubquery) {
      const onlyTable = [...tables][0];
      const tableCols = schemaMap.get(onlyTable);
      if (tableCols) {
        for (let i = 0; i < tokens.length; i += 1) {
          const tk = tokens[i];
          if (tk.type !== 'ident') continue;
          const v = tk.value;
          if (IGNORE_AS_IDENTIFIER.has(v)) continue;
          if (cteAliases.has(v)) continue;
          if (aliasMap.has(v)) continue; // it's a table or alias name
          // `.` isn't a tokenized punct (it doesn't carry semantic
          // value the other parsers care about), so to detect "this
          // ident is qualified" we peek at the raw SQL chars adjacent
          // to the token. Skip both the head (`alias.col` where `col`
          // is the bare ident) and the tail (`alias.col` where `alias`
          // is the bare ident — `alias` is fine to skip because the
          // qualified-ref pass already validated `col` against the
          // aliased table).
          if (stmt[tk.index - 1] === '.') continue;
          if (stmt[tk.index + v.length] === '.') continue;
          const prev = tokens[i - 1];
          if (prev && prev.type === 'op' && (prev.value === '::' || prev.value === '->' || prev.value === '->>')) continue;
          // Skip if followed by `(` (function call).
          const next = tokens[i + 1];
          if (next && next.type === 'punct' && next.value === '(') continue;
          // Skip if preceded by `as` (column alias).
          if (prev && prev.type === 'ident' && prev.value === 'as') continue;
          // Validate.
          if (!tableCols.has(v)) {
            violations.push({
              kind: 'unknown_column',
              table: onlyTable,
              column: v,
              context: 'bare reference'
            });
          }
        }
      }
    }
  }

  // Dedup: when both the update-set pass and the bare-ref pass flag
  // the same column on the same table, surface one violation. Key on
  // (kind, table, column). Preserve the first occurrence so the
  // primary-context label (`update set` over `bare reference`) wins.
  const seen = new Set();
  const deduped = [];
  for (const v of violations) {
    const key = `${v.kind}|${v.table}|${v.column ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(v);
  }
  return deduped;
};

// ─── File-level linting ─────────────────────────────────────────────────

export const lintFile = (filePath, schemaMap) => {
  const source = readFileSync(filePath, 'utf8');
  const queries = extractQueriesFromSource(source);
  const violations = [];
  for (const q of queries) {
    const queryViolations = validateQuery(q.sql, schemaMap);
    for (const v of queryViolations) {
      violations.push({ file: basename(filePath), line: q.line, ...v });
    }
  }
  return violations;
};
