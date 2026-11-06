// Tests for the leash-test RUN — the producer of the certification gate's
// `--tests` evidence (S6, `required_leash_tests`).
//
// What is pinned here:
//   - the run list comes from the MANIFEST, never a hardcoded array;
//   - GREEN is earned three ways at once (exit 0 + zero failures + at least one
//     passing test) — the false green a zero-test file would otherwise earn is
//     the whole reason this runner exists;
//   - a missing declared file is a RED FILE, a broken harness is a THROW, and
//     the two are never confused;
//   - the gate refuses a hand-authored report: only a real run report counts.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROLE_LEASH_TEST_RUN_ARTIFACT,
  runLeashTests
} from './leashTestRun.js';
import {
  CURRENT_ROLE_RUNTIME_VERSION,
  findCertificationManifest,
  gatherRoleCertificationEvidence
} from './roleCertification.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');

const MANIFEST = {
  role: 'invoicing_collections',
  jurisdiction: 'GB',
  version: 1,
  required_leash_tests: ['a/one.test.js', 'b/two.test.js']
};

const summary = ({ tests = 3, pass = 3, fail = 0 } = {}) =>
  `# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n`;

const runWith = (byPath, { manifest = MANIFEST, exists = () => true } = {}) => {
  const ran = [];
  const report = runLeashTests({
    manifest,
    deps: {
      now: NOW,
      existsSync: exists,
      runFile: (relPath) => {
        ran.push(relPath);
        return byPath[relPath] ?? { status: 0, stdout: summary(), stderr: '' };
      }
    }
  });
  return { report, ran };
};

test('the files run are the ones the MANIFEST declares, in order — never a hardcoded list', () => {
  const { ran } = runWith({});
  assert.deepEqual(ran, ['a/one.test.js', 'b/two.test.js']);

  const { ran: other } = runWith({}, {
    manifest: { ...MANIFEST, required_leash_tests: ['only/this.test.js'] }
  });
  assert.deepEqual(other, ['only/this.test.js']);
});

test('a clean run is PASS and carries the counts, the artifact kind and the runtime version', () => {
  const { report } = runWith({});
  assert.equal(report.artifact, ROLE_LEASH_TEST_RUN_ARTIFACT);
  assert.equal(report.gate, 'PASS');
  assert.deepEqual(report.failures, []);
  assert.equal(report.runtime_version, CURRENT_ROLE_RUNTIME_VERSION);
  assert.equal(report.role, 'invoicing_collections');
  assert.equal(report.jurisdiction, 'GB');
  assert.equal(report.produced_at, new Date(NOW).toISOString());
  assert.deepEqual(report.files['a/one.test.js'], {
    green: true, exists: true, exit_code: 0, tests: 3, pass: 3, fail: 0
  });
});

test('a file that ran ZERO tests is RED — exiting 0 having proved nothing is the false green this runner refuses', () => {
  const { report } = runWith({
    'b/two.test.js': { status: 0, stdout: summary({ tests: 0, pass: 0, fail: 0 }), stderr: '' }
  });
  assert.equal(report.gate, 'FAIL');
  assert.equal(report.files['b/two.test.js'].green, false);
  assert.equal(report.files['b/two.test.js'].reason, 'no_tests_ran');
  assert.equal(report.files['a/one.test.js'].green, true);
});

test('failing tests and a nonzero exit are RED, each named by its own reason', () => {
  const failing = runWith({
    'a/one.test.js': { status: 1, stdout: summary({ tests: 3, pass: 2, fail: 1 }), stderr: 'boom' }
  }).report;
  assert.equal(failing.gate, 'FAIL');
  assert.equal(failing.files['a/one.test.js'].reason, 'nonzero_exit');
  assert.equal(failing.files['a/one.test.js'].stderr_tail, 'boom');

  // Exit 0 with a failure counted in the summary still reads red: the exit code
  // alone is not the evidence.
  const counted = runWith({
    'a/one.test.js': { status: 0, stdout: summary({ tests: 3, pass: 2, fail: 1 }), stderr: '' }
  }).report;
  assert.equal(counted.files['a/one.test.js'].reason, 'failing_tests');
});

test('an unparsable summary is RED as unparsable — never laundered into a green or mislabelled as failing tests', () => {
  const { report } = runWith({
    'a/one.test.js': { status: 0, stdout: 'no TAP summary here', stderr: '' }
  });
  assert.equal(report.files['a/one.test.js'].green, false);
  assert.equal(report.files['a/one.test.js'].reason, 'unparsable_summary');
});

test('a declared file absent from the tree is a RED FILE, not a crash — the declaration really is unmet', () => {
  const { report, ran } = runWith({}, { exists: (relPath) => relPath !== 'b/two.test.js' });
  assert.equal(report.gate, 'FAIL');
  assert.deepEqual(report.files['b/two.test.js'], { green: false, exists: false, reason: 'file_missing' });
  assert.ok(!ran.includes('b/two.test.js'));
  assert.ok(report.failures.some((f) => f.includes('absent from the tree')));
});

test('a TIMEOUT is a red file, not a broken harness — the test ran and never finished', () => {
  const timeout = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const { report } = runWith({ 'a/one.test.js': { error: timeout } });
  assert.equal(report.gate, 'FAIL');
  assert.equal(report.files['a/one.test.js'].green, false);
  assert.equal(report.files['a/one.test.js'].reason, 'timed_out');
  // The run continues: one hanging file does not hide the state of the rest.
  assert.equal(report.files['b/two.test.js'].green, true);
});

test('a broken HARNESS throws — it is never written as a FAIL report about the leash', () => {
  assert.throws(() => runLeashTests({
    manifest: MANIFEST,
    deps: {
      now: NOW,
      existsSync: () => true,
      runFile: () => ({ error: new Error('spawn ENOENT') })
    }
  }), /could not run 'a\/one.test.js'.*spawn ENOENT/);
});

test('a manifest declaring no leash tests is refused rather than reporting a vacuous PASS', () => {
  assert.throws(
    () => runLeashTests({ manifest: { ...MANIFEST, required_leash_tests: [] } }),
    /declares no leash tests/
  );
  assert.throws(() => runLeashTests({}), /requires a manifest/);
});

test('the gate refuses a hand-authored test-run report: only a real run report is evidence', async () => {
  const manifest = findCertificationManifest('invoicing_collections', 'GB', 1);
  const client = { query: async () => ({ rows: [] }) };

  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      // The exact blob that satisfied this requirement before the producer
      // existed — a human's word, no receipt of a run.
      testRunReport: { files: { [manifest.required_leash_tests[0]]: { green: true } } }
    }),
    /not a donna\.roleLeashTestRun\.v1.*no artifact kind/s
  );

  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      testRunReport: { artifact: 'donna.roleJourneyRun.v1', files: {} }
    }),
    /not a donna\.roleLeashTestRun\.v1/
  );

  // The VINTAGE refusal (2026-08-16): a real-shaped report stamped at another
  // role runtime is refused — evidence must not outlive the runtime it
  // certifies. The producer has stamped runtime_version since its first day;
  // until now nothing asked (the kind refusal's story, third field over), so
  // bumping CURRENT_ROLE_RUNTIME_VERSION would have re-redded every manifest
  // while a "re-gather" quietly laundered old reports into the new vintage.
  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      testRunReport: {
        artifact: ROLE_LEASH_TEST_RUN_ARTIFACT,
        runtime_version: CURRENT_ROLE_RUNTIME_VERSION + 1,
        files: {}
      }
    }),
    new RegExp(`produced at role runtime v${CURRENT_ROLE_RUNTIME_VERSION + 1} and this gather runs at v${CURRENT_ROLE_RUNTIME_VERSION}`)
  );
  await assert.rejects(
    () => gatherRoleCertificationEvidence(client, {
      manifest,
      testRunReport: { artifact: ROLE_LEASH_TEST_RUN_ARTIFACT, files: {} }
    }),
    /produced at role runtime no version at all/
  );
});

test('the gate honors a real run report, and still records green only for the files it covers', async () => {
  const manifest = findCertificationManifest('invoicing_collections', 'GB', 1);
  const client = { query: async () => ({ rows: [] }) };
  const [first, second] = manifest.required_leash_tests;

  const evidence = await gatherRoleCertificationEvidence(client, {
    manifest,
    testRunReport: {
      artifact: ROLE_LEASH_TEST_RUN_ARTIFACT,
      runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
      gate: 'FAIL',
      files: { [first]: { green: true }, [second]: { green: false, reason: 'failing_tests' } }
    }
  });

  assert.equal(evidence.leash_tests[first].green, true);
  // Red and unreported both read as "not green" — absent evidence is never green.
  assert.equal(evidence.leash_tests[second].green, null);
});

test('END TO END on the real tree: the R1 manifest\'s declared leash tests actually run green', () => {
  const manifest = findCertificationManifest('invoicing_collections', 'GB', 1);
  const report = runLeashTests({ manifest });

  assert.equal(report.artifact, ROLE_LEASH_TEST_RUN_ARTIFACT);
  assert.equal(report.gate, 'PASS', `leash tests are not green: ${report.failures.join('; ')}`);
  for (const relPath of manifest.required_leash_tests) {
    const row = report.files[relPath];
    assert.equal(row.green, true, `${relPath} is not green`);
    assert.ok(row.pass > 0, `${relPath} reported no passing tests`);
  }
});
