#!/usr/bin/env node
//
// Specialist roles S6 — run a role's LEASH TESTS and write their run report
// (docs/design-donna-specialist-roles.md §5 S6, `required_leash_tests`).
//
// The leash tests are the manifest's authority/refusal correctness evidence
// (INV-S2/S10). The gate checks they EXIST; this runner is what says whether
// they are GREEN, by running them. Its report is the offline half
// `run_role_certification.js --tests` consumes:
//
//   node scripts/run_role_leash_tests.js --out ./leash-run.json
//   node scripts/run_role_certification.js --tests ./leash-run.json
//
// Until this existed the `--tests` report was hand-authored — a human's word
// that the tests pass, with no receipt of a run. That was the last requirement
// in the R1 gate whose evidence was a claim rather than a producer's output
// (the EAW curricula excepted: those worlds are unbuilt and belong to the EAW
// plan's own arc, not this lane).
//
// THIS SCRIPT NEVER CERTIFIES ANYTHING (the run_lane_gate.js discipline). Five
// green leash tests turn ONE of the R1 manifest's eight requirements green; the
// gate is a conjunction and the Autonomous claim is still a separate, dated,
// human-signed commit. Exit code 0 = every declared file green, 1 = any red.
//
// USAGE:
//   node scripts/run_role_leash_tests.js
//     [--role invoicing_collections] [--jurisdiction GB] [--version 1]
//     [--out leash-test-run.json]
//     [--quiet]

import { writeFileSync } from 'node:fs';

import { findCertificationManifest } from '../server/donna/roles/roleCertification.js';
import { runLeashTests } from '../server/donna/roles/leashTestRun.js';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = {
    role: 'invoicing_collections', jurisdiction: 'GB', version: 1,
    out: 'leash-test-run.json', quiet: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--role') { out.role = argv[i + 1]; i += 1; }
    else if (argv[i] === '--jurisdiction') { out.jurisdiction = argv[i + 1]; i += 1; }
    else if (argv[i] === '--version') { out.version = Number(argv[i + 1]); i += 1; }
    else if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--quiet') { out.quiet = true; }
  }
  return out;
};

const main = async () => {
  const opts = parseArgv();
  const log = (...args) => { if (!opts.quiet) console.log('[role-leash]', ...args); };

  const manifest = findCertificationManifest(opts.role, opts.jurisdiction, opts.version);
  if (!manifest) {
    console.error(`[role-leash] no manifest declared for ${opts.role}/${opts.jurisdiction}/v${opts.version} — see ROLE_CERTIFICATION_MANIFESTS`);
    process.exit(1);
  }

  let report;
  try {
    report = runLeashTests({ manifest });
  } catch (error) {
    // A harness error is NOT a red gate for the code under test — say which it
    // is, loudly, instead of writing a FAIL report that would read as a finding
    // about Donna's leash.
    console.error(`[role-leash] the leash tests could not be run: ${error?.message || error}`);
    process.exit(1);
  }

  writeFileSync(opts.out, JSON.stringify(report, null, 2));

  log(`manifest=${manifest.role}/${manifest.jurisdiction}/v${manifest.version} runtime=v${report.runtime_version}`);
  for (const [relPath, row] of Object.entries(report.files)) {
    log(`${row.green ? 'green' : 'RED  '} ${relPath}`
      + (row.exists ? ` (${row.pass ?? '?'}/${row.tests ?? '?'} passed, exit ${row.exit_code})` : ' (absent from the tree)')
      + (row.reason ? ` [${row.reason}]` : ''));
  }
  for (const failure of report.failures) log(`      ! ${failure}`);
  log(`gate: ${report.gate} (report → ${opts.out})`);
  if (report.gate === 'PASS') {
    log('green leash tests satisfy ONE of the R1 manifest\'s eight requirements — the gate is a conjunction, and nothing here certifies a role.');
  }
  process.exit(report.gate === 'PASS' ? 0 : 1);
};

main().catch((err) => {
  console.error('[role-leash] FAILED', err);
  process.exit(1);
});
