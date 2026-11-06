// audit_events append-only — the source lint + the migration-shape pins
// (godmode build-spec G2 PR-16, §0(8)).
//
// Two halves, same contract as the chatApplySpine ratchets:
//
//   1. SOURCE LINT (the sqlWriterLint-style sweep): no UPDATE or DELETE on
//      audit_events anywhere under `server/**` outside the ONE named scrub
//      site (firmFacts.js eraseFirmFact). The database trigger (migration
//      119) enforces this at runtime; this lint keeps the tree honest at
//      unit-test time, so a new mutation site fails CI before it ever meets
//      the trigger.
//
//   2. MIGRATION PINS: 119's trigger must keep its exact shape — DELETE
//      refused unconditionally; UPDATE admitted only as (a) the erasure
//      scrub (content_scrubbed receipt, only resource_id/metadata move) and
//      (b) the client-delete set-null cascade (only client_id, to null,
//      clients row gone — the carve-out exists because 001 declares
//      client_id ON DELETE SET NULL and that cascade is an UPDATE the
//      trigger sees; refusing it would break client deletion).
//
// The runtime proof lives in firmFactsPgLifecycle.test.js (real-PG): erase
// succeeds UNDER the trigger, tamper/DELETE are refused, the cascade shape
// passes only once the client row is gone.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, '..', '..');
const serverRoot = resolvePath(repoRoot, 'server');

// Test files are EXCLUDED from the sweep on purpose: the PG lifecycle test
// attempts refused mutations as negative-path probes (that is its job), and
// this file itself spells the forbidden patterns. Non-test server source is
// exactly the surface the trigger defends.
const walkServerSources = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walkServerSources(full));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
};

await test('source lint: exactly one UPDATE site on audit_events in server/** (the erasure scrub), zero DELETE sites', () => {
  const updateSites = [];
  const deleteSites = [];
  for (const file of walkServerSources(serverRoot)) {
    const source = readFileSync(file, 'utf8');
    const updates = source.match(/update\s+audit_events/gi) || [];
    const deletes = source.match(/delete\s+from\s+audit_events/gi) || [];
    if (updates.length) updateSites.push({ file: file.slice(repoRoot.length + 1), count: updates.length });
    if (deletes.length) deleteSites.push({ file: file.slice(repoRoot.length + 1), count: deletes.length });
  }
  assert.deepEqual(
    updateSites,
    [{ file: 'server/donna/firmFacts.js', count: 1 }],
    'the ONE sanctioned audit_events UPDATE is the eraseFirmFact scrub — a new site must go through the append-only decision, not around it'
  );
  assert.deepEqual(
    deleteSites,
    [],
    'audit_events has ZERO delete sites — the trail is append-only'
  );
});

await test('the sanctioned scrub site still carries the carve-out shape the trigger admits', () => {
  const source = readFileSync(resolvePath(serverRoot, 'donna', 'firmFacts.js'), 'utf8');
  assert.match(
    source,
    /'content_scrubbed',\s*true/,
    'the scrub UPDATE writes the content_scrubbed receipt — the exact key migration 119 keys its carve-out on'
  );
});

await test('migration 119 pins: DELETE refused unconditionally, UPDATE admitted only in the two exact shapes', () => {
  const sql = readFileSync(resolvePath(repoRoot, 'db', 'migrations', '119_audit_events_append_only.sql'), 'utf8');
  assert.match(sql, /create trigger audit_events_append_only\s+before update or delete on audit_events\s+for each row/i, 'row trigger on UPDATE and DELETE');
  assert.match(sql, /if tg_op = 'DELETE' then\s+raise exception/i, 'DELETE is refused before any carve-out is considered');
  assert.doesNotMatch(sql, /allow_append_only_purge/, 'NO purge escape hatch — audit_events does not die with its client (unlike 037 loop tables)');
  assert.match(sql, /@> '\{"content_scrubbed": true\}'::jsonb/, 'scrub carve-out keys on the content_scrubbed receipt');
  assert.match(
    sql,
    /to_jsonb\(old\) - array\['resource_id', 'metadata'\]/,
    'scrub carve-out freezes every column except resource_id/metadata (045-style fail-closed: future columns frozen automatically)'
  );
  assert.match(sql, /to_jsonb\(old\) - 'client_id'/, 'cascade carve-out freezes every column except client_id');
  assert.match(sql, /new\.client_id is null/, 'cascade carve-out only admits movement TO null');
  assert.match(
    sql,
    /not exists \(select 1 from clients where id = old\.client_id\)/,
    'cascade carve-out requires the clients row to be gone — nulling attribution for a LIVE client is laundering, not a cascade'
  );
  assert.match(sql, /errcode = 'restrict_violation'/, 'refusals carry the 037-style errcode');
  assert.match(sql, /audit_events_append_only:/, 'refusal messages carry the stable token the PG lifecycle probes assert on');
});

await test('the cascade carve-out exists because 001 declares it: client_id ON DELETE SET NULL', () => {
  const sql = readFileSync(resolvePath(repoRoot, 'db', 'migrations', '001_firm_core.sql'), 'utf8');
  assert.match(
    sql,
    /client_id text references clients\(id\) on delete set null/,
    '001 audit_events.client_id is ON DELETE SET NULL — if this ever changes, revisit 119 shape 2 in the same commit'
  );
});
