// The offline gate preview, end to end — the real script on the real tree.
//
// One deliberate expense: this spawns scripts/run_role_certification_offline.js,
// which runs BOTH declared journeys in-process and ALL five declared leash-test
// files (the leashTestRun machinery, spawned per file). That is the point — the
// preview's whole claim is "one command exercises the offline half", and only a
// real run proves the wiring: argv → manifest → in-process producers → offline
// gather → gate arithmetic → preview artifact → exit code. It also runs NESTED
// under node --test on purpose: the NODE_TEST_CONTEXT strip inside leashTestRun
// is load-bearing here exactly as it is in leashTestRun.test.js's own e2e.
//
// Pins:
//   - exit 0: nothing offline-evaluable is refuted on the running tree;
//   - the artifact is the OFFLINE PREVIEW kind (never the signable verdict),
//     unsignable, naming the DB-gathered requirements it did not evaluate;
//   - the gate is RED with insufficient_data (an offline preview can never be
//     green — observation evidence lives in the DB);
//   - journeys/leash/wiring/runtime read green, the DB and EAW requirements
//     read red on absence only;
//   - refused flags refuse loudly (a supplied --tests file must not quietly
//     not-count).

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DB_GATHERED_REQUIREMENTS,
  ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT
} from '../server/donna/roles/roleCertification.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'run_role_certification_offline.js');

test('the offline preview runs the offline half in one command and reports honestly', () => {
  const outPath = join(mkdtempSync(join(tmpdir(), 'role-cert-offline-')), 'preview.json');
  const result = spawnSync(process.execPath, [SCRIPT, '--out', outPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`);
  assert.equal(result.status, 0,
    `expected exit 0 (nothing offline-evaluable refuted); stdout tail:\n${String(result.stdout).split('\n').slice(-25).join('\n')}\nstderr tail:\n${String(result.stderr).split('\n').slice(-10).join('\n')}`);

  const preview = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(preview.artifact, ROLE_CERTIFICATION_OFFLINE_PREVIEW_ARTIFACT);
  assert.equal(preview.preview.signable, false);
  assert.deepEqual(preview.preview.not_gathered, [...DB_GATHERED_REQUIREMENTS]);
  assert.equal('signature' in preview, false);

  // The gate itself: red on absence, never green offline — and every red is
  // insufficient (nothing on the running tree is refuted).
  assert.equal(preview.gate.verdict, 'red');
  assert.equal(preview.gate.insufficient_data, true);
  assert.ok(preview.gate.reasons.every((reason) => reason.insufficient === true),
    `refuted reasons on the running tree: ${JSON.stringify(preview.gate.reasons.filter((r) => r.insufficient !== true))}`);
  for (const name of ['journey_tests', 'leash_tests', 'wiring_coverage', 'runtime_version']) {
    assert.equal(preview.gate.requirements[name].verdict, 'green', `${name} must be green on the running tree`);
  }
  for (const name of DB_GATHERED_REQUIREMENTS) {
    assert.equal(preview.gate.requirements[name].verdict, 'red');
  }

  // Self-contained receipts: the embedded leash run really ran (counted tests,
  // a produced-not-hand-authored artifact kind), and both journey runs PASS.
  assert.equal(preview.numbers.leash_test_run.artifact, 'donna.roleLeashTestRun.v1');
  assert.ok(Object.values(preview.numbers.leash_test_run.files).every((row) => row.green === true && row.pass > 0));
  assert.ok(Object.values(preview.numbers.journey_runs).every((run) => run.gate === 'PASS'));

  // The closing line never claims more than a preview may.
  assert.ok(String(result.stdout).includes('nothing here certifies a role'));
});

test('a refutation flips the exit code: a supplied EAW report that FAILed is red on evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'role-cert-offline-refuted-'));
  const eawPath = join(dir, 'proof0.json');
  writeFileSync(eawPath, JSON.stringify({ gate: 'FAIL' }));
  const outPath = join(dir, 'preview.json');
  const result = spawnSync(process.execPath, [SCRIPT, '--eaw', `proof0=${eawPath}`, '--out', outPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.status, 1, 'a refuted requirement must exit 1, unlike red-on-absence');
  assert.ok(String(result.stdout).includes('offline preview: REFUTED'));
  const preview = JSON.parse(readFileSync(outPath, 'utf8'));
  const reason = preview.gate.reasons.find((r) => r.code === 'eaw_core_gate_red');
  assert.equal(reason.insufficient, false, 'a FAILed report is a refutation, not thin data');
});

test('supplied journey/tests/gold files are refused loudly, never silently dropped', () => {
  for (const flag of ['--gold', '--journey', '--tests']) {
    const result = spawnSync(process.execPath, [SCRIPT, flag, 'x=y'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
    assert.equal(result.status, 1, `${flag} must refuse`);
    assert.ok(String(result.stderr).includes(`${flag} does not apply here`), `${flag} must say why`);
  }
});
