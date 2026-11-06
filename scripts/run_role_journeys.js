#!/usr/bin/env node
//
// Specialist roles S6 — run a role's JOURNEY TESTS and write their run reports
// (docs/design-donna-specialist-roles.md §5 S6, `required_journey_tests`).
//
// The journeys drive Donna's real collections modules end to end against one
// stateful substrate (server/donna/roles/journeys/) and report a PASS/FAIL gate
// with every check, every consequence, and every gap the run walked past. Their
// reports are the offline half `run_role_certification.js` consumes:
//
//   node scripts/run_role_journeys.js --out-dir ./journey-runs
//   node scripts/run_role_certification.js \
//     --journey journey.collections.invoice-to-settlement.v1=./journey-runs/journey.collections.invoice-to-settlement.v1.json \
//     --journey journey.collections.cadence-to-owner-escalation.v1=./journey-runs/journey.collections.cadence-to-owner-escalation.v1.json
//
// THIS SCRIPT NEVER CERTIFIES ANYTHING (the run_lane_gate.js discipline). Two
// green journeys turn ONE of the R1 manifest's eight requirements green; the
// gate is a conjunction and the Autonomous claim is still a separate, dated,
// human-signed commit. Exit code 0 = every journey PASSed, 1 = any FAILed.
//
// USAGE:
//   node scripts/run_role_journeys.js
//     [--journey <id>]...        # default: every declared journey
//     [--out-dir <dir>]          # default: cwd; one <id>.json per journey
//     [--now <ISO timestamp>]    # default: the journeys' fixed clock
//     [--quiet]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_JOURNEY_CLOCK,
  JOURNEY_DEFINITIONS,
  runJourney
} from '../server/donna/roles/journeys/collectionsJourneys.js';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { journeys: [], outDir: '.', now: DEFAULT_JOURNEY_CLOCK, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--journey') { out.journeys.push(argv[i + 1]); i += 1; }
    else if (argv[i] === '--out-dir') { out.outDir = argv[i + 1]; i += 1; }
    else if (argv[i] === '--quiet') { out.quiet = true; }
    else if (argv[i] === '--now') {
      const parsed = Date.parse(argv[i + 1]);
      if (!Number.isFinite(parsed)) {
        console.error(`[role-journeys] --now expects an ISO timestamp, got "${argv[i + 1]}"`);
        process.exit(1);
      }
      out.now = parsed;
      i += 1;
    }
  }
  if (!out.journeys.length) out.journeys = JOURNEY_DEFINITIONS.map((definition) => definition.id);
  return out;
};

const main = async () => {
  const opts = parseArgv();
  const log = (...args) => { if (!opts.quiet) console.log('[role-journeys]', ...args); };

  mkdirSync(opts.outDir, { recursive: true });
  let failed = 0;

  for (const journeyId of opts.journeys) {
    let report;
    try {
      report = await runJourney(journeyId, { now: opts.now });
    } catch (error) {
      // A harness error is NOT a red gate for the code under test — say which
      // it is, loudly, instead of writing a FAIL report that would read as a
      // finding about Donna.
      console.error(`[role-journeys] ${journeyId} could not run: ${error?.message || error}`);
      process.exit(1);
    }
    const path = join(opts.outDir, `${journeyId}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2));

    log(`${report.gate === 'PASS' ? 'PASS' : 'FAIL'} ${journeyId} → ${path}`);
    for (const step of report.steps) {
      const red = step.checks.filter((check) => check.status !== 'pass').length;
      log(`      ${red ? 'RED  ' : 'green'} ${step.step} (${step.checks.length} checks)`);
    }
    for (const failure of report.failures) log(`      ! ${failure}`);
    for (const note of report.observations) log(`      note: ${note}`);
    if (report.gate !== 'PASS') failed += 1;
  }

  log(`${opts.journeys.length - failed}/${opts.journeys.length} journeys PASS`);
  if (!failed) {
    log('green journeys satisfy ONE of the R1 manifest\'s eight requirements — the gate is a conjunction, and nothing here certifies a role.');
  }
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error('[role-journeys] FAILED', err);
  process.exit(1);
});
