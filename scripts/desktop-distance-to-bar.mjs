#!/usr/bin/env node
// Distance-to-bar CLI — the eval parallel lane's reporting tool (technical
// plan §13; bar semantics in §7 v2.1). Compares two evalHarness metric
// blobs — a qualified cloud BASELINE run and a CANDIDATE (open-weights /
// local) run over the SAME fixture suite — and renders the per-capability
// graduation verdict. Producing the metric blobs is the existing harness's
// job (the suite runners); this tool never calls
// a model, so it runs anywhere, keys or not.
//
//   node scripts/desktop-distance-to-bar.mjs compare \
//     --capability reconciliation_matching \
//     --baseline data/evals/baselines/reconciliation_llm.json \
//     --candidate /path/to/candidate-metrics.json [--json] [--out file]
//   node scripts/desktop-distance-to-bar.mjs bar      # print the current bar
//   node scripts/desktop-distance-to-bar.mjs policy   # print the routing table

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  DEFAULT_GRADUATION_BAR, GRADUATION_CAPABILITIES, assessGraduation
} from '../server/donna/desktop/graduationBar.js';
import { CURRENT_MODEL_POLICY, validateModelPolicy } from '../server/donna/desktop/modelPolicy.js';

const args = process.argv.slice(2);
const command = args[0];
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
};

const fail = (message) => {
  console.error(`[distance-to-bar] ${message}`);
  process.exit(1);
};

if (command === 'bar') {
  console.log(JSON.stringify({ bar: DEFAULT_GRADUATION_BAR, capabilities: GRADUATION_CAPABILITIES }, null, 2));
  process.exit(0);
}

if (command === 'policy') {
  validateModelPolicy(CURRENT_MODEL_POLICY);
  console.log(JSON.stringify(CURRENT_MODEL_POLICY, null, 2));
  process.exit(0);
}

if (command === 'compare') {
  const capability = flagValue('--capability');
  const baselinePath = flagValue('--baseline');
  const candidatePath = flagValue('--candidate');
  if (!capability || !baselinePath || !candidatePath) {
    fail('compare needs --capability, --baseline, and --candidate');
  }
  const read = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (error) {
      return fail(`cannot read metrics blob ${p}: ${error.message}`);
    }
  };
  const verdict = assessGraduation({
    capability,
    baseline: read(baselinePath),
    candidate: read(candidatePath)
  });

  const out = flagValue('--out');
  if (out) writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);
  if (args.includes('--json') || out) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    const g1 = verdict.gate1;
    const g2 = verdict.gate2;
    console.log(`capability   ${verdict.capability} (suite ${verdict.suite || '?'}, ${verdict.fixtures ?? '?'} fixtures)`);
    console.log(`candidate    ${verdict.candidate_model || '?'}   baseline ${verdict.baseline_model || '?'}`);
    if (g1) console.log(`gate 1 wrong-commit   ${g1.pass ? 'PASS' : 'FAIL'}  candidate ${g1.candidate_rate} vs allowed ${g1.allowed} (baseline ${g1.baseline_rate}, distance ${g1.distance})`);
    if (g2) console.log(`gate 2 owner-questions ${g2.pass ? 'PASS' : 'FAIL'}  candidate ${g2.candidate_rate} vs allowed ${g2.allowed} (baseline ${g2.baseline_rate}, distance ${g2.distance})`);
    console.log(`verdict      ${verdict.verdict.toUpperCase()}${verdict.reason ? ` (${verdict.reason})` : ''}`);
  }
  process.exit(0);
}

fail(`unknown command "${command || ''}" — use compare | bar | policy`);
