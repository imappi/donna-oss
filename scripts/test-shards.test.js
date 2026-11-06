import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planShards, parseShard, inventoryDigest, verifyShardReceipts } from './test-shards.mjs';

const context = { revision: 'test-revision', timezone: 'UTC' };
const files = ['slow.test.js', 'medium.test.js', 'a.test.js', 'b.test.js', 'new.test.js'];
const plan = planShards(files, { 'slow.test.js': 8000, 'medium.test.js': 5000 }, 2);
const receipts = () => plan.map((shard, i) => ({
  ...context, status: 'passed', shard: { index: i + 1, count: 2 }, inventoryDigest: inventoryDigest(files),
  files: shard.files.map(file => ({ file, outcome: 'passed', durationMs: 10 })),
}));

test('balanced scheduling includes new files once and is independent of discovery order', () => {
  assert.deepEqual(planShards([...files].reverse(), { 'slow.test.js': 8000, 'medium.test.js': 5000 }, 2), plan);
  assert.deepEqual(plan.flatMap(shard => shard.files).sort(), [...files].sort());
  assert.equal(Math.max(...plan.map(s => s.estimatedMs)), 8000);
  assert.deepEqual(parseShard('4/4'), { index: 4, count: 4 });
  for (const value of ['0/4', '5/4', '1/0', '1/33', '1.5/4', 'foo']) assert.throws(() => parseShard(value));
  assert.throws(() => planShards(['same', 'same']));
});

test('coverage gate refuses missing, duplicate, failed, foreign and partial results', () => {
  assert.equal(verifyShardReceipts(plan, receipts(), context), files.length);
  const mutations = [
    r => r.pop(), r => r.push(r[0]), r => { r[1] = r[0]; },
    r => { r[0].status = 'failed'; }, r => { r[0].revision = 'old'; },
    r => { r[0].timezone = 'Asia/Dubai'; }, r => { r[0].inventoryDigest = 'old'; },
    r => { r[0].files.pop(); }, r => { r[0].files.push(r[0].files[0]); },
    r => { r[0].files[0].outcome = 'skipped'; }, r => { r[0].files[0].file = 'unknown.test.js'; },
  ];
  for (const mutate of mutations) { const copy = receipts(); mutate(copy); assert.throws(() => verifyShardReceipts(plan, copy, context)); }
  const expected = receipts(); expected[0].files[0].outcome = 'expected_failure_matched';
  assert.equal(verifyShardReceipts(plan, expected, context), files.length);
});

test('actual runner discovers the repository and rejects incomplete aggregate evidence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'donna-shard-test-'));
  try {
    await writeFile(path.join(dir, 'one.json'), JSON.stringify(receipts()[0]));
    const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--shard=1/4', `--verify-receipts=${dir}`], {
      encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'test-revision', TZ: 'UTC' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Discovered \d+ test files/);
    assert.match(result.stderr, /Missing or extra shard receipts/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CI retains required gates and certificates behind all isolated shards', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /shard: \[1, 2, 3, 4\]/);
  // The zones come from the Scope job (scripts/ci-scope.mjs): UTC on a pull
  // request, UTC + Europe/Helsinki on a push to main (Kari, 2026-11-05).
  assert.match(workflow, /tz: \$\{\{ fromJSON\(needs\.scope\.outputs\.zones\) \}\}/);
  assert.match(workflow, /if: needs\.scope\.outputs\.run_tests == 'true'/);
  assert.match(workflow, /matrix\.tz == 'UTC' && 'Build & test' \|\| format\('Build & test \(TZ=\{0\}\)', matrix\.tz\)/);
  assert.match(workflow, /needs: \[scope, test-shards\]\n    if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(workflow, /test "\$SCOPE_RESULT" = success/);
  assert.match(workflow, /test "\$SHARD_RESULT" = success/);
  // A documentation-only pass is green only because Scope skipped the shards.
  assert.match(workflow, /test "\$SHARD_RESULT" = skipped/);
  const { PULL_REQUEST_ZONES, MAIN_ZONES } = await import('./ci-scope.mjs');
  assert.deepEqual(PULL_REQUEST_ZONES, ['UTC']);
  assert.deepEqual(MAIN_ZONES, ['UTC', 'Europe/Helsinki']);
  assert.match(workflow, /--verify-receipts=artifacts\/test-receipts/);
  assert.match(workflow, /npm run certify:host/);
  assert.match(workflow, /npm run certify:entity/);
});
