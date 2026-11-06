import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'host_certificate_a.js');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'donna-host-certificate-a-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const withoutHostDependencies = () => {
  const env = {
    ...process.env,
    DONNA_BUILD_COMMIT_SHA: 'test-commit',
    DONNA_BUILD_DIRTY: 'false',
    DONNA_RUNTIME_BUILD_DIRTY: 'false'
  };
  for (const name of [
    'DATABASE_URL', 'DONNA_DESKTOP_BLOB_DIR', 'SUPABASE_URL', 'VITE_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'
  ]) delete env[name];
  return env;
};

test('required PostgreSQL and storage proof refuses as INCOMPLETE instead of skipping green', () => {
  const output = path.join(TMP, 'missing-dependencies.json');
  const result = spawnSync(process.execPath, [SCRIPT, `--output=${output}`, '--require-pass'], {
    cwd: ROOT,
    env: withoutHostDependencies(),
    encoding: 'utf8'
  });
  assert.equal(result.status, 2, result.stderr);
  const receipt = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(receipt.status, 'INCOMPLETE');
  assert.equal(receipt.enforcement, false);
  assert.equal(receipt.model_inference_calls, 0);
  assert.equal(receipt.model_spend_usd, 0);
  assert.equal(receipt.checks.find(({ id }) => id === 'database_schema').status, 'INCOMPLETE');
  assert.equal(receipt.checks.find(({ id }) => id === 'evidence_storage').status, 'INCOMPLETE');
  assert.ok(!JSON.stringify(receipt).includes('skipped'));
});

test('CI pins PostgreSQL and retains the required Host Certificate A verdict', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /image: postgres:16\.15-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(workflow, /DONNA_PG_TEST_URL:/);
  assert.match(workflow, /npm run db:prepare:ci-host/);
  assert.match(workflow, /npm run db:migrate/);
  assert.match(workflow, /npm run runtime:initialize:ci-host/);
  assert.match(workflow, /npm run certify:host -- --output=artifacts\/host-certificate-a\.json --require-pass/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test('pinned CI PostgreSQL and storage produce a PASS host manifest', {
  skip: !process.env.DONNA_PG_TEST_URL
}, () => {
  const output = path.join(TMP, 'real-host.json');
  const result = spawnSync(process.execPath, [SCRIPT, `--output=${output}`, '--require-pass'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DONNA_BUILD_COMMIT_SHA: 'ci-test-build',
      DONNA_BUILD_DIRTY: 'false',
      DONNA_RUNTIME_BUILD_DIRTY: 'false',
      DONNA_DESKTOP_BLOB_DIR: path.join(TMP, 'real-storage'),
      OPENAI_API_KEY: 'ci-test-no-network',
      ANTHROPIC_API_KEY: 'ci-test-no-network'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.checks.find(({ id }) => id === 'database_schema').detail.server_major, 16);
  assert.deepEqual(receipt.checks.find(({ id }) => id === 'evidence_storage').detail.operations,
    ['adapter_write', 'service_read', 'list', 'delete', 'list_after_delete']);
});
