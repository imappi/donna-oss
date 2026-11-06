#!/usr/bin/env node
//
// Specialist roles S6 — run a role's CERTIFICATION GATE and write the verdict
// artifact (docs/design-donna-specialist-roles.md §5 S6).
//
// The gate above the lanes: evaluates a RoleCertification manifest
// (server/donna/roles/roleCertification.js) against gathered evidence —
//   1. constituent model-lane gates over model_challenger_runs (fleet-wide;
//      pass each lane's gold-set report with --gold);
//   2. EAW core/role curriculum run reports (--eaw);
//   3. journey-test run reports (--journey, produced by
//      scripts/run_role_journeys.js — a hand-authored blob is refused: each
//      report must declare the roleJourneyRun artifact kind, record the
//      journey id it is supplied under — one journey's run is not another's
//      evidence — and be stamped at the current role-runtime vintage);
//   4. leash-test presence (checked here) + green status (--tests report,
//      produced by scripts/run_role_leash_tests.js — a hand-authored blob is
//      refused: the report must declare the roleLeashTestRun artifact kind
//      and be stamped at the current role-runtime vintage);
//   5. wiring coverage (the audited role surface, read from the tree);
//   6. observation evidence (role-leash-passed send receipts + would-block
//      count, read from the DB);
//   7. the runtime version.
//
// The output is the WRITTEN verdict a human signs — the run_lane_gate.js
// discipline: signature block EMPTY (who signs is an open decision on Kari),
// and THIS SCRIPT NEVER CERTIFIES A ROLE. A green verdict is signable; the
// Autonomous claim is its own dated commit setting the role's `certification`
// record in roleRegistry.js with the signed verdict attached. Exit code
// 0 = green, 1 = red — and absent evidence exits red with insufficient_data,
// never green.
//
// USAGE:
//   node scripts/run_role_certification.js
//     [--role invoicing_collections] [--jurisdiction GB] [--version 1]
//     [--gold <laneId>=<path>]...     # a lane's gold-set report
//     [--eaw <id>=<path>]...          # an EAW world/curriculum run report
//     [--journey <id>=<path>]...      # a journey run report
//     [--tests <path>]                # leash-test run report (run_role_leash_tests.js)
//     [--out role-certification-verdict.json]
//
// For a DB-free preview of the offline half (journeys + leash tests run
// in-process, DB-gathered requirements honestly ungathered, artifact a
// distinct never-signable kind): scripts/run_role_certification_offline.js.

import { readFileSync, writeFileSync } from 'node:fs';

import { withFirmDbClient } from '../server/donna/firmDb.js';
import {
  buildRoleCertificationVerdict,
  evaluateRoleCertification,
  findCertificationManifest,
  gatherRoleCertificationEvidence,
  validateRoleCertificationManifests
} from '../server/donna/roles/roleCertification.js';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = {
    role: 'invoicing_collections', jurisdiction: 'GB', version: 1,
    gold: {}, eaw: {}, journey: {}, tests: null,
    out: 'role-certification-verdict.json'
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
    else if (argv[i] === '--gold') { const [k, v] = pair(argv[i + 1], '--gold'); out.gold[k] = v; i += 1; }
    else if (argv[i] === '--eaw') { const [k, v] = pair(argv[i + 1], '--eaw'); out.eaw[k] = v; i += 1; }
    else if (argv[i] === '--journey') { const [k, v] = pair(argv[i + 1], '--journey'); out.journey[k] = v; i += 1; }
    else if (argv[i] === '--tests') { out.tests = argv[i + 1]; i += 1; }
    else if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[role-cert]', ...args);

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`[role-cert] could not read ${what} ${path}: ${error?.message || error}`);
    process.exit(1);
  }
};

const readJsonMap = (pathsById, what) => {
  const out = {};
  for (const [id, path] of Object.entries(pathsById)) out[id] = readJson(path, `${what} '${id}'`);
  return out;
};

const main = async () => {
  const opts = parseArgv();

  const lintProblems = validateRoleCertificationManifests();
  if (lintProblems.length) {
    console.error('[role-cert] the manifest declarations are invalid — fix roleCertification.js first:');
    for (const problem of lintProblems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const manifest = findCertificationManifest(opts.role, opts.jurisdiction, opts.version);
  if (!manifest) {
    console.error(`[role-cert] no manifest declared for ${opts.role}/${opts.jurisdiction}/v${opts.version} — see ROLE_CERTIFICATION_MANIFESTS`);
    process.exit(1);
  }

  const goldReports = readJsonMap(opts.gold, 'gold report');
  const eawReports = readJsonMap(opts.eaw, 'EAW report');
  const journeyRuns = readJsonMap(opts.journey, 'journey run');
  const testRunReport = opts.tests ? readJson(opts.tests, 'test-run report') : null;

  const evidence = await withFirmDbClient((client) =>
    gatherRoleCertificationEvidence(client, {
      manifest, goldReports, eawReports, journeyRuns, testRunReport
    }));

  const gate = evaluateRoleCertification({ manifest, evidence });
  const verdict = buildRoleCertificationVerdict({ manifest, evidence, gate });
  writeFileSync(opts.out, JSON.stringify(verdict, null, 2));

  log(`manifest=${manifest.role}/${manifest.jurisdiction}/v${manifest.version} runtime=v${manifest.runtime_version}`);
  log(`observation: receipts=${evidence.observation.role_receipts} would_blocks=${evidence.observation.would_blocks} `
    + `window_days=${Math.round((evidence.observation.window_days || 0) * 10) / 10} models=[${evidence.observation.models.join(', ')}]`);
  for (const [name, requirement] of Object.entries(gate.requirements)) {
    log(`${requirement.verdict === 'green' ? 'GREEN' : 'RED  '} ${name}`);
    for (const reason of requirement.reasons) log(`      ${reason.code}: ${reason.detail}`);
  }
  log(`gate: ${gate.verdict.toUpperCase()}${gate.insufficient_data ? ' (insufficient data)' : ''} (verdict → ${opts.out})`);
  if (gate.verdict === 'green') {
    log('green = SIGNABLE, not certified: the Autonomous claim is its own dated commit setting the role\'s certification record with this signed verdict attached. Nothing auto-certifies.');
  }
  process.exit(gate.verdict === 'green' ? 0 : 1);
};

main().catch((err) => {
  console.error('[role-cert] FAILED', err);
  process.exit(1);
});
