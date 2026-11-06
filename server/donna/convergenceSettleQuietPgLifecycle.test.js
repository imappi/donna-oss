// F-28 — the settle hook is quiet on the paths that used to raise server-side
// errors: an autocommit settle no longer issues a SAVEPOINT the server must
// refuse (25P01, one ERROR line in the PostgreSQL log per settle), and a commit
// through the hook on a pre-137 database (no convergence_marks table — every
// migration 001..136) no longer aborts its own settle subtransaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hookPooledClient, settleCommittedConvergenceMarks, settleConvergenceMarks } from './reconcileConvergenceState.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = async (name) => {
  const db = `donna_${name}_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_URL }); await admin.connect();
  await admin.query(`create database "${db}"`);
  const url = new URL(PG_URL); url.pathname = `/${db}`;
  return { url: url.toString(), drop: async () => { await admin.query(`drop database if exists "${db}" with (force)`).catch(() => {}); await admin.end().catch(() => {}); } };
};
const recording = (client) => {
  const statements = [];
  const original = client.query.bind(client);
  client.query = (...args) => { statements.push(String(args[0]?.text ?? args[0]).trim().toLowerCase()); return original(...args); };
  return statements;
};

test('F-28 real PG: an autocommit settle issues no failing SAVEPOINT; a nested settle still savepoints', { skip: !PG_URL }, async () => {
  const db = await scratch('f28a');
  const seed = new pg.Client({ connectionString: db.url }); await seed.connect();
  try {
    const supabaseOnly = new Set(['010_evidence_object_storage.sql', '032_lock_down_public_rls.sql', '060_procountor_api_key.sql']);
    for (const file of (await readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql') && !supabaseOnly.has(f)).sort()) {
      await seed.query(await readFile(path.join(ROOT, 'db', 'migrations', file), 'utf8'));
    }
    await seed.query(`insert into firms (id, name, slug) values ('f28', 'F', 'f28')`);
    await seed.query(`insert into clients (id, firm_id, company_name) values ('c28', 'f28', 'C')`);
    const client = new pg.Client({ connectionString: db.url }); await client.connect();
    const statements = recording(client);
    try {
      for (let i = 0; i < 5; i++) {
        await seed.query(`insert into transactions (id, firm_id, client_id, transaction_date, description, money_out, currency)
          values ('t28-${i}', 'f28', 'c28', '2026-08-20', 'x', 1, 'GBP')`);
        const result = await settleCommittedConvergenceMarks(client, { logger: null });
        assert.ok(result.claimed >= 1, JSON.stringify(result));
      }
      // A savepoint is only legal inside a transaction block; outside one the server refuses it.
      let open = false; const outside = [];
      for (const s of statements) {
        if (s === 'begin') open = true;
        else if (s === 'commit' || (s.startsWith('rollback') && !s.includes(' to '))) open = false;
        else if (s.startsWith('savepoint') && !open) outside.push(s);
      }
      assert.deepEqual(outside, [], 'autocommit settle: no SAVEPOINT outside a transaction (the server refuses it and logs an ERROR)');
      assert.ok(statements.includes('begin'), 'the settle owns its own transaction');
      // Neighbour: inside the caller's transaction the settle still nests.
      await client.query('begin');
      statements.length = 0;
      await settleConvergenceMarks(client, { scope: 'transaction' });
      assert.ok(statements.some((s) => s.startsWith('savepoint')), 'a nested settle keeps its savepoint');
      await client.query('rollback');
    } finally { await client.end(); }
  } finally { await seed.end(); await db.drop(); }
});

test('F-28 real PG: a hooked commit on a database without convergence_marks logs nothing and commits', { skip: !PG_URL }, async () => {
  const db = await scratch('f28b');
  const client = new pg.Client({ connectionString: db.url }); await client.connect();
  const logged = [];
  const logger = { warn: (...a) => logged.push(['warn', ...a]), error: (...a) => logged.push(['error', ...a]) };
  try {
    hookPooledClient(client, { logger });
    for (let i = 0; i < 3; i++) {
      await client.query('begin');
      await client.query(`create table if not exists pre137_${i} (id int)`);
      await client.query('commit');
    }
    assert.deepEqual(logged, [], 'no "settle at commit failed" line per migration commit');
    assert.equal((await client.query("select count(*)::int n from pg_tables where tablename like 'pre137_%'")).rows[0].n, 3);
  } finally { await client.end(); await db.drop(); }
});
