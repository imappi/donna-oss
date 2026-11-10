// Donna — the JOURNEY SUBSTRATE: a stateful in-memory Postgres double for the
// role-certification journey tests (docs/design-donna-specialist-roles.md §5 S6,
// `required_journey_tests`).
//
// WHY THIS EXISTS AND WHY IT IS NOT "ANOTHER MOCK". The tree's module tests use
// the mock-pg harness pattern: a handler list keyed by SQL fragment returning
// FIXED rows. That is right for one module — you hand it the state its unit
// needs. It is the wrong shape for a JOURNEY, because a journey's whole subject
// is the HANDOFF: the executor must claim the row the detector actually minted,
// the webhook must cancel the reminders the cadence actually scheduled, the case
// must reach its terminal from the writers' actual calls. Hand-fed rows between
// stages would test the fixtures, not the seam.
//
// So this is a small STATEFUL substrate: writes land in tables, reads project
// from those tables, and the REAL modules run unmodified against it. Three
// deliberate properties:
//
//   1. FAIL LOUD ON UNROUTED SQL. An unknown statement throws — it never
//      returns an empty result set. A journey that silently reads {} from a
//      query it does not model is a journey that passes for the wrong reason,
//      which is worse than no journey at all (the honesty rule from
//      modelLaneGate/roleCertification, applied to the harness itself).
//   2. NO INTELLIGENCE. The substrate stores and projects rows. Every verdict,
//      gate, leash decision and cadence step in a journey comes from the real
//      module under test — the substrate never decides anything.
//   3. A FROZEN CLOCK. `now()` resolves to the injected instant, so a journey's
//      scheduling arithmetic is exact rather than flaky. Frozen is not
//      immovable: a journey that spans real time (issue day → overdue day)
//      advances the clock EXPLICITLY between stages via `advanceTo`, so the
//      DB-side now() stamps stay consistent with the instant the module under
//      test was handed. It never reads the wall clock.
//
// SQL coverage is deliberately narrow: generic INSERT / UPDATE / simple SELECT
// over the shapes the outbound + roles writers actually emit, plus named routes
// for the handful of reads with joins, aggregates or interval arithmetic. When
// a module's SQL changes shape, the journey FAILS with the offending statement
// — that is the intended maintenance signal, not a defect.

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const squash = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ── Tiny expression helpers ────────────────────────────────────────────────

// Split on top-level commas only (so `coalesce(payload, '{}') || $4` stays one).
const splitTopLevel = (text, separator = ',') => {
  const out = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === separator && depth === 0) { out.push(current); current = ''; continue; }
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
};

// Split on a top-level keyword (and/or), keeping parenthesised groups and
// quoted literals intact — a "' or '" inside a string literal must not split.
const splitKeyword = (text, keyword) => {
  const out = [];
  const tail = new RegExp(`\\s${keyword}$`, 'i');
  const drop = keyword.length + 1;
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth === 0 && /\s/.test(ch) && tail.test(current)) {
        out.push(current.slice(0, -drop));
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
};

// Split a WHERE clause on top-level AND, keeping parenthesised groups intact.
const splitConjunction = (text) => splitKeyword(text, 'and');

const PARAM = /^\$(\d+)(::[a-z_[\]]+)?$/i;

export class UnroutedSqlError extends Error {
  constructor(sql) {
    super(`journey substrate: unrouted SQL (add a route or extend the generic handler)\n  ${squash(sql)}`);
    this.name = 'UnroutedSqlError';
    this.sql = squash(sql);
  }
}

// Column DEFAULTS the real schema applies. An INSERT that omits `status`
// relies on the DDL default; without these the substrate would hand back a row
// with `status: undefined` and every downstream status check would read as a
// mismatch rather than as the value production actually has. Only defaults the
// journeys depend on are declared — an omitted column with no entry stays
// absent, which is the honest representation of "this harness does not model
// that column".
const COLUMN_DEFAULTS = Object.freeze({
  receivable_cases: { status: 'open', current_step: 0 },
  outbound_payment_links: { status: 'active' },
  loop_event_inbox: { status: 'pending', attempts: 0 }
});

export const createJourneySubstrate = ({
  now = Date.parse('2026-07-24T00:00:00Z'),
  tables = {},
  routes = [],
  defaults = COLUMN_DEFAULTS
} = {}) => {
  const state = {};
  for (const [name, rows] of Object.entries(tables)) state[name] = clone(rows) || [];
  const calls = [];
  // Every statement the substrate could not model, recorded BEFORE the throw.
  // Several modules under test wrap their reads in `.catch(() => ({ rows: [] }))`
  // (a deliberate soft-fail for a pre-migration DB), which would otherwise
  // swallow a substrate gap and let a journey pass on empty reads. A journey
  // asserts this list is empty; the throw alone is not enough.
  const unrouted = [];
  // The frozen clock (property 3). `advanceTo` moves it deliberately between
  // journey stages; it refuses to move backwards, which would re-order stamps.
  let clock = now;
  const nowIso = () => new Date(clock).toISOString();

  const table = (name) => {
    if (!state[name]) state[name] = [];
    return state[name];
  };

  // Resolve one SQL value token against the bound parameters.
  const value = (token, params) => {
    const raw = String(token).trim();
    const param = raw.match(PARAM);
    if (param) {
      const bound = params[Number(param[1]) - 1];
      const cast = (param[2] || '').toLowerCase();
      if (cast.includes('jsonb') || cast.includes('json')) {
        if (typeof bound === 'string') {
          try { return JSON.parse(bound); } catch { return bound; }
        }
      }
      return bound === undefined ? null : bound;
    }
    if (/^now\(\)$/i.test(raw)) return nowIso();
    if (/^null$/i.test(raw)) return null;
    if (/^default$/i.test(raw)) return null;
    if (/^true$/i.test(raw)) return true;
    if (/^false$/i.test(raw)) return false;
    if (/^'(.*)'(::[a-z_]+)?$/is.test(raw)) {
      const literal = raw.match(/^'(.*?)'(::[a-z_]+)?$/is)[1];
      const cast = raw.match(/^'(.*?)'(::[a-z_]+)?$/is)[2] || '';
      if (cast.toLowerCase().includes('json')) {
        try { return JSON.parse(literal); } catch { return literal; }
      }
      return literal;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return undefined; // an expression the generic layer does not model
  };

  const stamp = (a, b) => {
    const left = a === null || a === undefined ? null : Date.parse(a);
    const right = b === null || b === undefined ? null : Date.parse(b);
    return { left, right };
  };

  // ── WHERE evaluation ─────────────────────────────────────────────────────
  // Conjunctions only (every writer in scope uses AND). Each predicate must be
  // recognised or the whole statement is unrouted — a silently-ignored
  // predicate would widen an UPDATE, which is exactly the class of harness bug
  // that makes a journey lie.
  const matchesWhere = (row, whereText, params) => {
    if (!whereText || !whereText.trim()) return true;
    for (const raw of splitConjunction(whereText)) {
      const predicate = raw.trim();
      if (!predicate) continue;

      // A parenthesised group is a disjunction in every statement in scope
      // (`(client_id = $2 or client_id is null)`); recurse per branch.
      if (predicate.startsWith('(') && predicate.endsWith(')')) {
        const inner = predicate.slice(1, -1);
        const branches = inner.split(/\s+or\s+/i);
        if (!branches.some((branch) => matchesWhere(row, branch, params))) return false;
        continue;
      }

      // A comparison whose LEFT side is a bound parameter or literal rather
      // than a column (`$4::boolean = false`) — resolve both sides as values.
      let m = predicate.match(/^(\$\d+(?:::[a-z_]+)?|'[^']*')\s*=\s*(.+)$/i);
      if (m) {
        const left = value(m[1], params);
        const right = value(m[2], params);
        if (left === undefined || right === undefined) throw new UnroutedSqlError(predicate);
        if (String(left) !== String(right)) return false;
        continue;
      }

      m = predicate.match(/^(\w+)\s*=\s*(.+)$/i);
      if (m && !/\s+any\s*\(/i.test(predicate) && !/^coalesce/i.test(predicate)) {
        const expected = value(m[2], params);
        if (expected === undefined) throw new UnroutedSqlError(predicate);
        if (String(row[m[1]] ?? '') !== String(expected ?? '')) return false;
        continue;
      }
      m = predicate.match(/^(\w+)\s*=\s*any\(\$(\d+)\)$/i);
      if (m) {
        const list = params[Number(m[2]) - 1] || [];
        if (!list.map(String).includes(String(row[m[1]] ?? ''))) return false;
        continue;
      }
      m = predicate.match(/^(\w+)\s+(not\s+)?in\s*\((.+)\)$/i);
      if (m) {
        const list = splitTopLevel(m[3]).map((token) => value(token, params));
        const present = list.map(String).includes(String(row[m[1]] ?? ''));
        if (m[2] ? present : !present) return false;
        continue;
      }
      m = predicate.match(/^(\w+)\s+is\s+(not\s+)?null$/i);
      if (m) {
        const isNull = row[m[1]] === null || row[m[1]] === undefined;
        if (m[2] ? isNull : !isNull) return false;
        continue;
      }
      m = predicate.match(/^coalesce\((\w+),\s*(\w+)\)\s*<=\s*(.+)$/i);
      if (m) {
        const effective = row[m[1]] ?? row[m[2]];
        const { left, right } = stamp(effective, value(m[3], params));
        if (!(left !== null && right !== null && left <= right)) return false;
        continue;
      }
      m = predicate.match(/^(\w+)\s*(<=|>=|<|>)\s*(.+)$/i);
      if (m) {
        const { left, right } = stamp(row[m[1]], value(m[3], params));
        if (left === null || right === null) return false;
        if (m[2] === '<=' && !(left <= right)) return false;
        if (m[2] === '>=' && !(left >= right)) return false;
        if (m[2] === '<' && !(left < right)) return false;
        if (m[2] === '>' && !(left > right)) return false;
        continue;
      }
      throw new UnroutedSqlError(predicate);
    }
    return true;
  };

  // ── Statement handlers ───────────────────────────────────────────────────

  // Read a parenthesised group starting at `open`, respecting nesting and
  // quotes, and return [inner, indexAfterClose]. `values (…, now(), …)` nests,
  // so a non-greedy regex would stop inside `now()`.
  const readGroup = (text, open) => {
    let depth = 0;
    let quoted = false;
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "'") quoted = !quoted;
      if (quoted) continue;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return [text.slice(open + 1, i), i + 1];
      }
    }
    return [null, open];
  };

  const runInsert = (sql, params) => {
    const text = squash(sql);
    const head = text.match(/^insert into (\w+)\s*\(/i);
    if (!head) return null;
    const [columnText, afterColumns] = readGroup(text, head[0].length - 1);
    if (columnText === null) return null;
    const valuesAt = text.slice(afterColumns).match(/^\s*values\s*\(/i);
    if (!valuesAt) return null;
    const [valueText, afterValues] = readGroup(text, afterColumns + valuesAt[0].length - 1);
    if (valueText === null) return null;

    let rest = text.slice(afterValues).trim();
    let conflictCols = null;
    let conflictAction = null;
    let conflictWhere = null;
    const conflict = rest.match(/^on conflict\s*(\(|on constraint \w+\s*)?/i);
    if (conflict) {
      let cursor = conflict[0].length;
      if (conflict[1] === '(') {
        const [cols, after] = readGroup(rest, conflict[0].length - 1);
        conflictCols = cols;
        cursor = after;
      }
      // A partial unique index (`on conflict (…) where <pred> do …`): the
      // conflict target only covers rows matching the predicate, so an
      // existing row outside it is NOT a conflict.
      const action = rest.slice(cursor).trim()
        .match(/^(?:where\s+(.+?)\s+)?do (nothing|update set (.+?))(?:\s+returning\s+(.+))?$/i);
      if (!action) throw new UnroutedSqlError(sql);
      conflictWhere = action[1] || null;
      conflictAction = action[2];
      rest = action[4] ? `returning ${action[4]}` : '';
    }
    const returning = rest.match(/^returning\s+(.+)$/i);
    const returningText = returning ? returning[1] : null;
    const name = head[1];
    const columns = splitTopLevel(columnText).map((c) => c.trim());
    const values = splitTopLevel(valueText);
    if (columns.length !== values.length) throw new UnroutedSqlError(sql);

    const row = {
      created_at: nowIso(), updated_at: nowIso(), first_seen_at: nowIso(),
      ...(defaults[name] || {})
    };
    columns.forEach((column, index) => {
      const resolved = value(values[index], params);
      if (resolved === undefined) throw new UnroutedSqlError(sql);
      row[column] = resolved;
    });

    const rows = table(name);
    if (conflictCols) {
      const keys = splitTopLevel(conflictCols).map((c) => c.trim());
      const existing = rows.find((candidate) =>
        keys.every((key) => String(candidate[key] ?? '') === String(row[key] ?? ''))
        && matchesWhere(candidate, conflictWhere, params));
      if (existing) {
        if (String(conflictAction || '').toLowerCase() === 'nothing') {
          return { rows: [], rowCount: 0 }; // `returning` yields no row on a skip
        }
        // do-update (the upsert branch): the SET clause reads `excluded.<col>`
        // for the proposed row and `<table>.<col>` for the stored one.
        const setText = conflictAction.replace(/^update set\s+/i, '');
        applySet(existing, setText, params, sql, { excluded: row, tableName: name });
        return { rows: returningText ? [project(existing, returningText, { inserted: false })] : [], rowCount: 1 };
      }
    }
    rows.push(row);
    return { rows: returningText ? [project(row, returningText, { inserted: true })] : [], rowCount: 1 };
  };

  const project = (row, returningText, { inserted = true } = {}) => {
    const text = returningText.trim();
    if (text === '*') return clone(row);
    const out = {};
    for (const piece of splitTopLevel(text)) {
      const aliased = piece.match(/^(.+?)\s+as\s+(\w+)$/i);
      const expression = (aliased ? aliased[1] : piece).trim();
      const alias = aliased ? aliased[2] : expression;
      if (expression === '*') { Object.assign(out, clone(row)); continue; }
      // The Postgres inserted-vs-updated probe (`returning (xmax = 0) as
      // inserted`): xmax is 0 on a freshly inserted row and non-zero when the
      // upsert took the do-update branch — modeled from which branch called
      // us, so writers that audit only genuine mints (e.g.
      // upsertLedgerAccountForJournal) behave in journeys as in production.
      if (/^\(?\s*xmax\s*=\s*0\s*\)?$/i.test(expression)) {
        out[alias] = inserted;
        continue;
      }
      // A bare column reads the row; a literal is itself. Anything else
      // (function calls, jsonb paths, subselects) is UNROUTED, never a silent
      // null — a projection that quietly nulls a column the module branches on
      // (e.g. a coalesced jurisdiction) would skip the code under test while
      // the journey reads green.
      if (/^\w+$/.test(expression) && !/^\d/.test(expression)) {
        out[alias] = clone(row[expression] ?? null);
        continue;
      }
      const literal = value(expression, []);
      if (literal === undefined) throw new UnroutedSqlError(`select-list expression: ${expression}`);
      out[alias] = literal;
    }
    return out;
  };

  // Resolve one SET-clause expression against the row being written. Handles
  // the four shapes the writers in scope use, composed freely:
  //   a bound param / literal / now() / a bare column name
  //   `coalesce(<a>, <b>)`
  //   `<a> || <b>`                     (jsonb merge)
  //   `case when <a> = <b> then <x> else <y> end`
  // plus, inside an upsert's do-update branch, `excluded.<col>` (the proposed
  // row) and `<table>.<col>` (the stored row). Anything else is unrouted rather
  // than guessed — a mis-resolved assignment writes a wrong value silently.
  const resolveExpression = (raw, { row, params, upsert, sql }) => {
    const expression = String(raw).trim();

    const conditional = expression.match(
      /^case when\s+(.+?)\s+then\s+(.+?)\s+else\s+(.+?)\s+end$/i
    );
    if (conditional) {
      // A disjunction of `a = b`, `a is null` and `a in ('…', …)` — the shapes
      // the writers in scope branch on (the journal account mint's
      // fill-don't-overwrite type, 2026-11-10). Anything else is unrouted.
      const holds = (predicate) => {
        const isNull = predicate.match(/^(.+?)\s+is null$/i);
        if (isNull) {
          const resolved = resolveExpression(isNull[1], { row, params, upsert, sql });
          return resolved === null || resolved === undefined;
        }
        const inList = predicate.match(/^(.+?)\s+in\s*\((.+)\)$/i);
        if (inList) {
          const resolved = resolveExpression(inList[1], { row, params, upsert, sql });
          return splitTopLevel(inList[2]).some((item) => String(value(item, params)) === String(resolved));
        }
        const equal = predicate.match(/^(.+?)\s*=\s*(.+)$/);
        if (equal) {
          return String(resolveExpression(equal[1], { row, params, upsert, sql }))
            === String(resolveExpression(equal[2], { row, params, upsert, sql }));
        }
        throw new UnroutedSqlError(`case predicate: ${predicate}`);
      };
      const branch = splitKeyword(conditional[1], 'or').some((part) => holds(part.trim())) ? conditional[2] : conditional[3];
      return resolveExpression(branch, { row, params, upsert, sql });
    }

    const merge = expression.match(/^(.+?)\s*\|\|\s*(.+)$/);
    if (merge && !/^'/.test(expression)) {
      const left = resolveExpression(merge[1], { row, params, upsert, sql }) || {};
      const right = resolveExpression(merge[2], { row, params, upsert, sql }) || {};
      return { ...left, ...right };
    }

    // Boolean OR (`is_customer = is_customer or $4` — the party-enrich shape).
    // Split top-level only: an ' or ' inside a quoted literal must not split.
    if (!/^'/.test(expression)) {
      const disjuncts = splitKeyword(expression, 'or');
      if (disjuncts.length > 1) {
        return disjuncts
          .map((part) => resolveExpression(part, { row, params, upsert, sql }))
          .some(Boolean);
      }
    }

    const coalesce = expression.match(/^coalesce\((.+)\)$/i);
    if (coalesce) {
      for (const argument of splitTopLevel(coalesce[1])) {
        const resolved = resolveExpression(argument, { row, params, upsert, sql });
        if (resolved !== null && resolved !== undefined) return resolved;
      }
      return null;
    }

    if (upsert) {
      const excluded = expression.match(/^excluded\.(\w+)$/i);
      if (excluded) return upsert.excluded[excluded[1]] ?? null;
      const stored = expression.match(new RegExp(`^${upsert.tableName}\\.(\\w+)$`, 'i'));
      if (stored) return row[stored[1]] ?? null;
    }

    const literal = value(expression, params);
    if (literal !== undefined) return literal;

    // A bare column name reads the row being written.
    if (/^\w+$/.test(expression)) return row[expression] ?? null;
    throw new UnroutedSqlError(sql);
  };

  const applySet = (row, setText, params, sql, upsert = null) => {
    for (const assignment of splitTopLevel(setText)) {
      const m = assignment.match(/^(\w+)\s*=\s*(.+)$/is);
      if (!m) throw new UnroutedSqlError(sql);
      row[m[1]] = resolveExpression(m[2], { row, params, upsert, sql });
    }
  };

  const runUpdate = (sql, params) => {
    const m = squash(sql).match(/^update (\w+)\s+set\s+(.+?)\s+where\s+(.+?)(?:\s+returning\s+(.+))?$/i);
    if (!m) return null;
    const [, name, setText, whereText, returningText] = m;
    const updated = [];
    for (const row of table(name)) {
      if (!matchesWhere(row, whereText, params)) continue;
      applySet(row, setText, params, sql);
      updated.push(row);
    }
    return {
      rows: returningText ? updated.map((row) => project(row, returningText)) : [],
      rowCount: updated.length
    };
  };

  const runDelete = (sql, params) => {
    const m = squash(sql).match(/^delete from (\w+)(?:\s+where\s+(.+?))?(?:\s+returning\s+(.+))?$/i);
    if (!m) return null;
    const [, name, whereText, returningText] = m;
    const rows = table(name);
    const kept = [];
    const removed = [];
    for (const row of rows) {
      if (matchesWhere(row, whereText, params)) removed.push(row);
      else kept.push(row);
    }
    state[name] = kept;
    return {
      rows: returningText ? removed.map((row) => project(row, returningText)) : [],
      rowCount: removed.length
    };
  };

  const runSelect = (sql, params) => {
    const text = squash(sql).replace(/\s+for update skip locked$/i, '');
    const m = text.match(
      /^select\s+(.+?)\s+from\s+(\w+)(?:\s+where\s+(.+?))?(?:\s+order by\s+(.+?))?(?:\s+limit\s+(.+?))?$/i
    );
    if (!m) return null;
    const [, columnText, name, whereText, orderText, limitText] = m;
    if (/\bjoin\b|\bgroup by\b|count\(|min\(|max\(|distinct/i.test(columnText + (whereText || ''))) return null;

    let rows = table(name).filter((row) => matchesWhere(row, whereText, params));
    if (orderText) {
      const keys = splitTopLevel(orderText.replace(/\s+for update.*$/i, '').trim()).map((piece) => {
        const cleaned = piece.replace(/\s+nulls\s+(first|last)$/i, '').trim();
        const direction = /\bdesc$/i.test(cleaned) ? -1 : 1;
        const expression = cleaned.replace(/\s+(asc|desc)$/i, '').trim();
        const coalesced = expression.match(/^coalesce\((\w+),\s*(\w+)\)$/i);
        return {
          direction,
          read: (row) => (coalesced ? (row[coalesced[1]] ?? row[coalesced[2]]) : row[expression])
        };
      });
      const rank = (left, right) => {
        const a = Date.parse(left);
        const b = Date.parse(right);
        if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
        if (typeof left === 'boolean' || typeof right === 'boolean') {
          return (left === true ? 1 : 0) - (right === true ? 1 : 0);
        }
        if (Number.isFinite(Number(left)) && Number.isFinite(Number(right))) return Number(left) - Number(right);
        return String(left ?? '').localeCompare(String(right ?? ''));
      };
      rows = [...rows].sort((a, b) => {
        for (const key of keys) {
          const delta = rank(key.read(a), key.read(b)) * key.direction;
          if (delta !== 0) return delta;
        }
        return 0;
      });
    }
    if (limitText) {
      const bound = value(limitText, params);
      if (Number.isFinite(Number(bound))) rows = rows.slice(0, Number(bound));
    }
    const projected = columnText.trim() === '*'
      ? rows.map((row) => clone(row))
      : rows.map((row) => project(row, columnText));
    return { rows: projected, rowCount: projected.length };
  };

  const query = async (sql, params = []) => {
    const text = squash(sql);
    calls.push({ sql: text, params });
    const lowered = text.toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(lowered)) return { rows: [], rowCount: 0 };
    if (/^(savepoint|release savepoint|rollback to savepoint)\b/i.test(lowered)) return { rows: [], rowCount: 0 };

    for (const route of routes) {
      if (!lowered.includes(route.match.toLowerCase())) continue;
      if (route.throw) throw route.throw;
      const rows = typeof route.rows === 'function'
        ? route.rows({ sql: text, params, state, table, nowIso })
        : (route.rows || []);
      return { rows: clone(rows) || [], rowCount: (rows || []).length };
    }

    try {
      if (/^insert into/i.test(text)) {
        const result = runInsert(text, params);
        if (result) return result;
      }
      if (/^update /i.test(text)) {
        const result = runUpdate(text, params);
        if (result) return result;
      }
      if (/^delete from/i.test(text)) {
        const result = runDelete(text, params);
        if (result) return result;
      }
      if (/^select /i.test(text)) {
        const result = runSelect(text, params);
        if (result) return result;
      }
    } catch (error) {
      if (error instanceof UnroutedSqlError) unrouted.push(text);
      throw error;
    }
    unrouted.push(text);
    throw new UnroutedSqlError(text);
  };

  return {
    state,
    calls,
    unrouted,
    query,
    now, // the SEED instant; nowIso() tracks advanceTo
    nowIso,
    // Deliberate time travel between journey stages ("31 days later, the
    // sweep runs"). Deterministic — an instant the journey states, never the
    // wall clock — and forward-only, so stamps cannot re-order.
    advanceTo: (instant) => {
      const next = typeof instant === 'number' ? instant : Date.parse(instant);
      if (!Number.isFinite(next)) throw new Error(`advanceTo: not an instant: ${instant}`);
      if (next < clock) throw new Error('advanceTo: the journey clock only moves forward');
      clock = next;
    },
    table,
    // Read helpers the journey steps assert against (never used by the modules
    // under test — they only ever see `query`).
    rows: (name) => clone(table(name)),
    auditActions: () => table('audit_events').map((row) => row.action),
    countAudit: (action) => table('audit_events').filter((row) => row.action === action).length,
    auditFor: (action) => clone(table('audit_events').filter((row) => row.action === action))
  };
};
