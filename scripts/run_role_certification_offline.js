#!/usr/bin/env node
//
// Specialist roles S6 — the OFFLINE GATE PREVIEW: evaluate everything the
// role-certification gate can evaluate WITHOUT a database, in one command
// (docs/design-donna-specialist-roles.md §5 S6).
//
// scripts/run_role_certification.js is the signable path: it gathers the DB
// halves (lane gap tables over model_challenger_runs, observation receipts)
// and writes the verdict artifact a human signs. It was also the ONLY way to
// evaluate the gate at all, so the DB-free requirements — journeys, leash
// tests, wiring, runtime version, supplied EAW reports — could not be
// previewed without Postgres; the offline producers had to be exercised one
// by one. This runner is that preview:
//
//   1. runs the offline producers IN-PROCESS — every journey and every leash
//      test the MANIFEST declares (never a hardcoded list), via the same
//      runJourney/runLeashTests the standalone runners use;
//   2. gathers OFFLINE evidence: the DB-gathered requirements
//      (DB_GATHERED_REQUIREMENTS) stay ungathered and read red with
//      insufficient_data — never fabricated;
//   3. evaluates the SAME gate arithmetic as the full runner;
//   4. writes an OFFLINE PREVIEW artifact
//      (donna.roleCertificationOfflinePreview.v1 — a different kind on
//      purpose: a preview is never signable, and an offline gate can never
//      read green anyway, because observation evidence lives in the DB).
//
// EXIT CODE: 0 = nothing offline-evaluable is REFUTED. A requirement red only
// for ABSENT evidence (the DB halves; EAW reports not supplied) does not fail
// the preview; a genuine red does (a FAILed journey, a red leash file, a
// wiring gap, a runtime mismatch, a supplied EAW report whose gate is not
// PASS). THIS SCRIPT NEVER CERTIFIES ANYTHING (the run_lane_gate.js
// discipline).
//
// USAGE:
//   node scripts/run_role_certification_offline.js
//     [--role invoicing_collections] [--jurisdiction GB] [--version 1]
//     [--eaw <id>=<path>]...          # an EAW run report, when one exists
//     [--out role-certification-offline-preview.json]
//     [--quiet]
//
// --gold / --journey / --tests are REFUSED, not ignored: gold needs the DB
// gap table (run the full gate), and journey/leash evidence is produced
// in-process here — a supplied file would be a claim about a run, not a run.

import { readFileSync, writeFileSync } from 'node:fs';

import {
  DB_GATHERED_REQUIREMENTS,
  buildRoleCertificationOfflinePreview,
  evaluateRoleCertification,
  findCertificationManifest,
  gatherRoleCertificationEvidence,
  validateRoleCertificationManifests
} from '../server/donna/roles/roleCertification.js';
import { runLeashTests } from '../server/donna/roles/leashTestRun.js';
import {
  DEFAULT_JOURNEY_CLOCK,
  runJourney
} from '../server/donna/roles/journeys/collectionsJourneys.js';

const REFUSED_FLAGS = {
  '--gold': 'a lane gate cannot be evaluated offline (its gap table lives in the DB) — run scripts/run_role_certification.js for lane evidence',
  '--journey': 'journey evidence is produced IN-PROCESS here (every journey the manifest declares is run) — a supplied file would be a claim, not this run',
  '--tests': 'leash-test evidence is produced IN-PROCESS here (scripts/run_role_leash_tests.js machinery) — a supplied file would be a claim, not this run'
};

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = {
    role: 'invoicing_collections', jurisdiction: 'GB', version: 1,
    eaw: {},
    out: 'role-certification-offline-preview.json', quiet: false
  };
  const pair = (raw, flag) => {
    const idx = String(raw).indexOf('=');
    if (idx < 1) throw new Error(`${flag} expects <id>=<path>, got "${raw}"`);
    return [raw.slice(0, idx), raw.slice(idx + 1)];
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--role') { out.role = argv[i + 1]; i += 1; }
    else if (argv[i] === '--jurisdiction') { out.jurisdiction = argv[i + 1]; i += 1; }
    else if (argv[i] === '--version') { out.version = Number(argv[i + 1]); i += 1; }
    else if (argv[i] === '--eaw') { const [k, v] = pair(argv[i + 1], '--eaw'); out.eaw[k] = v; i += 1; }
    else if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--quiet') { out.quiet = true; }
    else if (REFUSED_FLAGS[argv[i]]) {
      // Refused LOUDLY, never silently ignored: an input that quietly does not
      // count sends its supplier hunting for why their evidence "went missing".
      console.error(`[role-cert-offline] ${argv[i]} does not apply here: ${REFUSED_FLAGS[argv[i]]}`);
      process.exit(1);
    } else {
      console.error(`[role-cert-offline] unknown argument '${argv[i]}'`);
      process.exit(1);
    }
  }
  return out;
};

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`[role-cert-offline] could not read ${what} ${path}: ${error?.message || error}`);
    process.exit(1);
  }
};

const main = async () => {
  const opts = parseArgv();
  const log = (...args) => { if (!opts.quiet) console.log('[role-cert-offline]', ...args); };

  const lintProblems = validateRoleCertificationManifests();
  if (lintProblems.length) {
    console.error('[role-cert-offline] the manifest declarations are invalid — fix roleCertification.js first:');
    for (const problem of lintProblems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const manifest = findCertificationManifest(opts.role, opts.jurisdiction, opts.version);
  if (!manifest) {
    console.error(`[role-cert-offline] no manifest declared for ${opts.role}/${opts.jurisdiction}/v${opts.version} — see ROLE_CERTIFICATION_MANIFESTS`);
    process.exit(1);
  }

  const eawReports = {};
  for (const [id, path] of Object.entries(opts.eaw)) eawReports[id] = readJson(path, `EAW report '${id}'`);

  // The offline producers, in-process. A harness error is loud and is NOT a
  // red gate (the run_role_journeys.js / run_role_leash_tests.js precedent):
  // a FAIL report here would read as a finding about Donna instead of a
  // broken harness.
  const journeyRuns = {};
  for (const entry of manifest.required_journey_tests) {
    try {
      journeyRuns[entry.id] = await runJourney(entry.id, { now: DEFAULT_JOURNEY_CLOCK });
    } catch (error) {
      console.error(`[role-cert-offline] journey '${entry.id}' could not run: ${error?.message || error}`);
      process.exit(1);
    }
    log(`journey ${entry.id}: ${journeyRuns[entry.id].gate}`);
  }
  let testRunReport;
  try {
    testRunReport = runLeashTests({ manifest });
  } catch (error) {
    console.error(`[role-cert-offline] the leash tests could not be run: ${error?.message || error}`);
    process.exit(1);
  }
  log(`leash tests: ${testRunReport.gate} (${Object.keys(testRunReport.files).length} declared files)`);

  const evidence = await gatherRoleCertificationEvidence(null, {
    manifest, offline: true, eawReports, journeyRuns, testRunReport
  });
  const gate = evaluateRoleCertification({ manifest, evidence });
  const preview = buildRoleCertificationOfflinePreview({
    manifest, evidence, gate, leashTestRunReport: testRunReport
  });
  writeFileSync(opts.out, JSON.stringify(preview, null, 2));

  log(`manifest=${manifest.role}/${manifest.jurisdiction}/v${manifest.version} runtime=v${manifest.runtime_version}`);
  let refuted = 0;
  for (const [name, requirement] of Object.entries(gate.requirements)) {
    const hard = requirement.reasons.some((reason) => reason.insufficient !== true);
    if (hard) refuted += 1;
    const suffix = requirement.verdict === 'green' ? ''
      : hard ? ''
        : DB_GATHERED_REQUIREMENTS.includes(name)
          ? ' (insufficient: not gathered offline — needs the DB)'
          : ' (insufficient: awaiting evidence, nothing refuted)';
    log(`${requirement.verdict === 'green' ? 'GREEN' : 'RED  '} ${name}${suffix}`);
    for (const reason of requirement.reasons) log(`      ${reason.code}: ${reason.detail}`);
  }
  log(`gate: ${gate.verdict.toUpperCase()} (preview → ${opts.out})`);
  if (refuted) {
    log(`offline preview: REFUTED — ${refuted} requirement(s) red on evidence, not on absence. Fix the reds above before gathering the full gate.`);
  } else {
    log('offline preview: HOLDS — nothing offline-evaluable is refuted. The full gate stays RED until the DB-gathered requirements are evaluated green (scripts/run_role_certification.js); nothing here certifies a role.');
  }
  process.exit(refuted ? 1 : 0);
};

main().catch((err) => {
  console.error('[role-cert-offline] FAILED', err);
  process.exit(1);
});
