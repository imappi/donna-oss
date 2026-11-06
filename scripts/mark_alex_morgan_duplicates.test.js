// Unit tests for the canonical-row picker in
// scripts/mark_alex_morgan_duplicates.js. The DB-touching paths run
// against the live DB in dry-run mode before any --apply.

import assert from 'node:assert/strict';
import { choosCanonical } from './mark_alex_morgan_duplicates.js';

let passed = 0;
let failed = 0;

const test = (name, fn) =>
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  fail ${name}`);
      console.error(`       ${err?.stack || err?.message || err}`);
    });

const runTests = async () => {
  console.log('mark_alex_morgan_duplicates:');

  await test('choosCanonical: empty / single-row input returns no plan', () => {
    assert.deepEqual(choosCanonical([]), { canonical: null, duplicates: [] });
    assert.deepEqual(
      choosCanonical([{ id: 'a', created_at: '2026-01-01T00:00:00Z' }]),
      { canonical: null, duplicates: [] }
    );
  });

  await test('choosCanonical: earlier created_at wins', () => {
    const rows = [
      { id: 'a', created_at: '2026-01-01T00:00:00Z', parse_status: 'completed' },
      { id: 'b', created_at: '2026-02-01T00:00:00Z', parse_status: 'completed' }
    ];
    const { canonical, duplicates } = choosCanonical(rows);
    assert.equal(canonical.id, 'a');
    assert.deepEqual(duplicates.map((d) => d.id), ['b']);
  });

  await test('choosCanonical: two rows tied on created_at — completed beats failed', () => {
    const ts = '2026-01-01T00:00:00Z';
    const rows = [
      { id: 'a', created_at: ts, parse_status: 'failed' },
      { id: 'b', created_at: ts, parse_status: 'completed' }
    ];
    const { canonical, duplicates } = choosCanonical(rows);
    assert.equal(canonical.id, 'b');
    assert.deepEqual(duplicates.map((d) => d.id), ['a']);
  });

  await test('choosCanonical: same created_at, same parse_status → lex-lower id wins', () => {
    const ts = '2026-01-01T00:00:00Z';
    const rows = [
      { id: 'b', created_at: ts, parse_status: 'completed' },
      { id: 'a', created_at: ts, parse_status: 'completed' }
    ];
    const { canonical, duplicates } = choosCanonical(rows);
    assert.equal(canonical.id, 'a');
    assert.deepEqual(duplicates.map((d) => d.id), ['b']);
  });

  await test('choosCanonical: Date objects compare equally to ISO strings', () => {
    const isoTs = '2026-01-01T00:00:00.000Z';
    const dateTs = new Date(isoTs);
    const rows = [
      { id: 'a', created_at: isoTs, parse_status: 'failed' },
      { id: 'b', created_at: dateTs, parse_status: 'completed' }
    ];
    const { canonical } = choosCanonical(rows);
    // The two timestamps are the same instant — tiebreak on parse_status.
    assert.equal(canonical.id, 'b');
  });

  await test('choosCanonical: three-row cluster picks single canonical + 2 duplicates', () => {
    const rows = [
      { id: 'a', created_at: '2026-01-01T00:00:00Z', parse_status: 'completed' },
      { id: 'b', created_at: '2026-02-01T00:00:00Z', parse_status: 'completed' },
      { id: 'c', created_at: '2026-03-01T00:00:00Z', parse_status: 'completed' }
    ];
    const { canonical, duplicates } = choosCanonical(rows);
    assert.equal(canonical.id, 'a');
    assert.equal(duplicates.length, 2);
    assert.deepEqual(duplicates.map((d) => d.id).sort(), ['b', 'c']);
  });

  await test('choosCanonical: earliest row even if it failed parsing — created_at trumps status when timestamps differ', () => {
    // Deliberate choice: created_at is the stable signal. If the
    // earliest upload happened to fail parsing, that's still the
    // canonical row — the LATER duplicate isn't more authoritative
    // just because it parsed cleanly. Operators can re-parse the
    // canonical row separately.
    const rows = [
      { id: 'a', created_at: '2026-01-01T00:00:00Z', parse_status: 'failed' },
      { id: 'b', created_at: '2026-02-01T00:00:00Z', parse_status: 'completed' }
    ];
    const { canonical } = choosCanonical(rows);
    assert.equal(canonical.id, 'a');
  });

  console.log(`\nmark_alex_morgan_duplicates: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
};

runTests();
