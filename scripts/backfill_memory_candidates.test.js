import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseArgv,
  classifyDbConnectionTarget,
  connectionDiagnosis,
  isDefinitivelyWrongTarget,
  isConnectionError
} from './backfill_memory_candidates.js';

await test('parseArgv: defaults to donna-demo-firm + dry-run + listing (no client)', () => {
  assert.deepEqual(parseArgv([]), { apply: false, firmId: 'donna-demo-firm', clientId: null });
});

await test('parseArgv: flags combine (--apply --firm --client)', () => {
  assert.deepEqual(parseArgv(['--apply', '--firm', 'f1', '--client', 'c1']), {
    apply: true, firmId: 'f1', clientId: 'c1'
  });
});

await test('classifyDbConnectionTarget: pooler host is the correct target', () => {
  const t = classifyDbConnectionTarget(
    'postgresql://postgres.abcdefghijklmnop:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
  );
  assert.equal(t.kind, 'supabase-pooler');
  assert.equal(t.host, 'aws-0-eu-central-1.pooler.supabase.com');
  assert.equal(t.poolerUsernameMissingRef, false);
  assert.equal(isDefinitivelyWrongTarget(t), false);
});

await test('classifyDbConnectionTarget: pooler with plain "postgres" username is flagged', () => {
  const t = classifyDbConnectionTarget(
    'postgresql://postgres:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'
  );
  assert.equal(t.kind, 'supabase-pooler');
  assert.equal(t.poolerUsernameMissingRef, true);
  assert.equal(isDefinitivelyWrongTarget(t), true);
  assert.match(connectionDiagnosis(t), /missing the project ref/);
});

await test('classifyDbConnectionTarget: API host (<ref>.supabase.co) is the Cloudflare ETIMEDOUT trap', () => {
  const t = classifyDbConnectionTarget('postgresql://postgres:pw@abcdefghijklmnop.supabase.co:5432/postgres');
  assert.equal(t.kind, 'supabase-api');
  assert.equal(isDefinitivelyWrongTarget(t), true);
  assert.match(connectionDiagnosis(t), /REST\/API endpoint/);
  assert.match(connectionDiagnosis(t), /pooler/i);
});

await test('classifyDbConnectionTarget: direct host (db.<ref>.supabase.co) is IPv6-only', () => {
  const t = classifyDbConnectionTarget('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres');
  assert.equal(t.kind, 'supabase-direct');
  assert.equal(isDefinitivelyWrongTarget(t), true);
  assert.match(connectionDiagnosis(t), /IPv6-only/);
});

await test('classifyDbConnectionTarget: localhost is local, not refused', () => {
  const t = classifyDbConnectionTarget('postgresql://postgres:pw@localhost:5432/postgres');
  assert.equal(t.kind, 'local');
  assert.equal(isDefinitivelyWrongTarget(t), false);
});

await test('classifyDbConnectionTarget: empty url → empty kind, refused with the recipe', () => {
  const t = classifyDbConnectionTarget('');
  assert.equal(t.kind, 'empty');
  assert.equal(isDefinitivelyWrongTarget(t), true);
  assert.match(connectionDiagnosis(t), /DATABASE_URL is not set/);
});

await test('classifyDbConnectionTarget: tolerates an unparseable url via @host fallback', () => {
  const t = classifyDbConnectionTarget('not a url @aws-0-eu-central-1.pooler.supabase.com:5432/db');
  assert.equal(t.kind, 'supabase-pooler');
});

await test('isConnectionError: network failures yes, logic errors no', () => {
  assert.equal(isConnectionError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isConnectionError({ code: 'ENETUNREACH' }), true);
  assert.equal(isConnectionError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isConnectionError(new Error('connect ETIMEDOUT 104.18.0.1:5432')), true);
  assert.equal(isConnectionError({ code: '42P01' }), false); // undefined_table is not a connection error
  assert.equal(isConnectionError(null), false);
});
