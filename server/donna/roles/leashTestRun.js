// Donna — the LEASH-TEST RUN, producer of the certification gate's `--tests`
// evidence (S6 of docs/design-donna-specialist-roles.md §5,
// `required_leash_tests`).
//
// WHY THIS EXISTS. The R1 manifest names five real test files as its
// authority/refusal correctness evidence (INV-S2/S10). `roleCertification.js`
// checks that each one EXISTS in the tree, and then asks for a supplied
// test-run report to say whether it is GREEN. Every other requirement in the
// gate has a producer for its evidence — lane gates have run_lane_gate.js,
// journeys have run_role_journeys.js, wiring is read from the tree,
// observation is read from the DB. The leash requirement had NONE: its report
// was hand-authored JSON, a human's word that the tests pass, carrying no
// receipt of a run.
//
// That is the same class of hole the journey requirement closed on 2026-08-15
// — "existence is not evidence, a PASS run report is" — one requirement over.
// So this module RUNS the declared files and reports what actually happened.
//
// THE LAWS THIS MODULE HOLDS:
//   - The file list comes from the MANIFEST, never a hardcoded array. A leash
//     test added to or removed from a declaration is automatically what gets
//     run, so the evidence cannot drift from what the gate asks for.
//   - GREEN IS EARNED, three ways at once: the run exits 0, reports zero
//     failures, AND reports at least one passing test. A file that vanished,
//     that crashed on import, or that contains no tests at all exits 0 in some
//     shapes and would otherwise read green while proving nothing.
//   - A HARNESS ERROR IS NOT A RED GATE (the run_role_journeys.js precedent).
//     If the runner itself cannot run — no node binary, a spawn failure — this
//     THROWS rather than writing a FAIL report, because a FAIL report would
//     read as a finding about Donna's leash instead of a broken harness.
//   - NOTHING HERE CERTIFIES ANYTHING. A PASS turns ONE of the R1 manifest's
//     eight requirements green; the gate is a conjunction and the Autonomous
//     claim is still a separate, dated, human-signed commit.
//
// READ module — no writer, no store (the report is a written JSON, the
// run_lane_gate.js pattern; runner: scripts/run_role_leash_tests.js). The
// INV-S5 channel scan (roleEvents.test.js) covers this file like every roles/
// module: nothing here can reach an LLM engine.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CURRENT_ROLE_RUNTIME_VERSION, ROLE_LEASH_TEST_RUN_ARTIFACT } from './roleCertification.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Declared by roleCertification.js (the consumer) and re-exported here (the
// producer) so both halves name the same string with no import cycle.
export { ROLE_LEASH_TEST_RUN_ARTIFACT };

// node --test prints a TAP summary; these are the three numbers that decide
// green. Parsed rather than trusted from the exit code alone: a runner that
// exits 0 having run nothing is exactly the false green this module refuses.
const countFrom = (output, key) => {
  const match = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(String(output || ''));
  return match ? Number(match[1]) : null;
};

const defaultRunFile = (relPath) => {
  // The child's summary format must not depend on ambient state: `--test`
  // inherits NODE_TEST_CONTEXT when this runner is itself invoked under
  // `node --test`, and a child that believes it is reporting to a parent
  // prints NO summary at all — every file would then read `unparsable_summary`
  // and the whole requirement would go red for a harness reason. Strip the
  // context and pin the reporter, so one file produces one parseable report
  // whether this runs from a shell, from CI, or from inside another test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    // A leash test that hangs must not hang the certification run.
    timeout: 10 * 60 * 1000
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error || null
  };
};

// Runs the leash tests a manifest DECLARES and reports what happened.
// deps: { existsSync, runFile, now } — injected so the runner is unit-testable
// without spawning a process tree.
export const runLeashTests = ({ manifest, deps = {} } = {}) => {
  if (!manifest) throw new Error('runLeashTests requires a manifest');
  const declared = manifest.required_leash_tests;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`manifest ${manifest.role}/${manifest.jurisdiction}/v${manifest.version} declares no leash tests`);
  }

  const exists = deps.existsSync || ((relPath) => existsSync(join(REPO_ROOT, relPath)));
  const runFile = deps.runFile || defaultRunFile;
  const now = deps.now ?? Date.now();

  const files = {};
  const failures = [];

  for (const relPath of declared) {
    if (!exists(relPath)) {
      // The manifest lint already refuses this shape, so reaching it means the
      // report is being produced against a tree the lint never saw. Record it
      // as a red FILE, not a harness error — the declaration really is unmet.
      files[relPath] = { green: false, exists: false, reason: 'file_missing' };
      failures.push(`${relPath}: declared by the manifest but absent from the tree`);
      continue;
    }

    const result = runFile(relPath);
    if (result?.error) {
      // A TIMEOUT is a finding about the TEST — it ran and never finished —
      // so it reads red like any other failing file. Everything else here
      // (no node binary, a spawn failure) means the harness could not run at
      // all: loud, and NOT a finding about the leash.
      if (result.error.code === 'ETIMEDOUT') {
        files[relPath] = { green: false, exists: true, exit_code: null, reason: 'timed_out' };
        failures.push(`${relPath}: timed out — it ran and never finished`);
        continue;
      }
      throw new Error(`could not run '${relPath}': ${result.error?.message || result.error}`);
    }

    const stdout = result?.stdout || '';
    const tests = countFrom(stdout, 'tests');
    const passed = countFrom(stdout, 'pass');
    const failed = countFrom(stdout, 'fail');
    const exitCode = result?.status ?? null;
    const green = exitCode === 0 && failed === 0 && passed > 0;

    const row = { green, exists: true, exit_code: exitCode, tests, pass: passed, fail: failed };
    if (!green) {
      // Say WHICH of the three conditions was not met — a bare red on a
      // certification requirement is the thing that costs the next reader an
      // hour.
      row.reason = exitCode !== 0 ? 'nonzero_exit'
        : (tests === null || passed === null || failed === null) ? 'unparsable_summary'
          : failed !== 0 ? 'failing_tests'
            : 'no_tests_ran';
      row.stderr_tail = String(result?.stderr || '').trim().split('\n').slice(-5).join('\n') || null;
      failures.push(`${relPath}: ${row.reason} (exit=${exitCode}, tests=${tests}, pass=${passed}, fail=${failed})`);
    }
    files[relPath] = row;
  }

  return {
    artifact: ROLE_LEASH_TEST_RUN_ARTIFACT,
    role: manifest.role,
    jurisdiction: manifest.jurisdiction,
    manifest_version: manifest.version,
    runtime_version: CURRENT_ROLE_RUNTIME_VERSION,
    produced_at: new Date(now).toISOString(),
    gate: failures.length ? 'FAIL' : 'PASS',
    files,
    failures
  };
};
