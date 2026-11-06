#!/usr/bin/env node
//
// The UAE coding gold set — stability run (Desert Rose round-4 review §D,
// 2026-09-01; fixtures + scorer in server/donna/codingGoldSetAe.js).
//
// Never CI — K real coder calls per fixture through the SAME
// suggestTransactionCoding call path production uses, under the routed AE
// client profile (AE palette + AE VAT vocabulary). The report is the
// stability receipt for a model/prompt change on the coding lane: a fixture
// passes only when every run passes; a single flip fails the gate. The
// model id in the report comes from the coder's own persisted `model` field
// (the model-id-is-part-of-the-receipt rail), never from the env.
//
// USAGE:
//   OPENAI_API_KEY=… OPENAI_MODEL=gpt-5.4 \
//     node scripts/run_coding_goldset.js [--k=3] [--only nol_topup_exempt,ac_maintenance_repairs] \
//       [--out coding-goldset-ae-report.json] [--print]
//
// Exit code: 0 when the gate is met, 1 otherwise or on a runner error.

import { writeFileSync } from 'node:fs';

import { suggestTransactionCoding } from '../server/donna/transactionLlm.js';
import { loadOutboundPack, fallbackAccountNamesForPack } from '../server/donna/outbound/packs.js';
import {
  AE_GOLD_CLIENT_PROFILE,
  CODING_GOLD_FIXTURES_AE,
  CODING_GOLD_SET_AE_VERSION,
  codingGoldSetAeLintErrors,
  meetsCodingGoldThresholds,
  scoreCodingGoldFixture,
  summarizeCodingGoldRuns
} from '../server/donna/codingGoldSetAe.js';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { k: 3, only: null, out: 'coding-goldset-ae-report.json', print: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--k=')) out.k = Math.max(1, Number(arg.slice(4)) || 3);
    else if (arg === '--only') { out.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (arg === '--out') { out.out = argv[i + 1]; i += 1; }
    else if (arg === '--print') out.print = true;
  }
  return out;
};

const log = (...args) => console.log('[coding-goldset-ae]', ...args);

const main = async () => {
  const opts = parseArgv();
  const paletteNames = fallbackAccountNamesForPack(loadOutboundPack('ae'));
  const lint = codingGoldSetAeLintErrors({ paletteNames });
  if (lint.length) {
    console.error('[coding-goldset-ae] fixture lint failed:', lint);
    process.exit(1);
  }
  const fixtures = opts.only
    ? CODING_GOLD_FIXTURES_AE.filter((f) => opts.only.includes(f.id))
    : CODING_GOLD_FIXTURES_AE;
  if (!fixtures.length) {
    console.error('[coding-goldset-ae] no fixtures selected');
    process.exit(1);
  }
  if (!String(process.env.OPENAI_API_KEY || '').trim()) {
    console.error('[coding-goldset-ae] OPENAI_API_KEY is not set — the coder would answer from the rules fallback, which is not evidence');
    process.exit(1);
  }
  log(`gold_set=${CODING_GOLD_SET_AE_VERSION} fixtures=${fixtures.length} k=${opts.k}`);

  const scored = [];
  const details = [];
  for (const fixture of fixtures) {
    for (let run = 1; run <= opts.k; run += 1) {
      let suggestion = null;
      let callError = null;
      try {
        suggestion = await suggestTransactionCoding({
          clientProfile: AE_GOLD_CLIENT_PROFILE,
          transaction: { ...fixture.input },
          clientRules: [],
          xeroAccounts: []
        });
        if (suggestion?.source === 'rules_fallback') {
          callError = `rules_fallback: ${suggestion.reasoning || 'the coder did not call a model'}`;
          suggestion = null;
        }
      } catch (error) {
        callError = String(error?.message || error).slice(0, 300);
      }
      const score = scoreCodingGoldFixture({ suggestion, fixture });
      scored.push(score);
      details.push({ fixture_id: fixture.id, run, score, suggestion, call_error: callError });
      const failed = Object.entries(score.checks).filter(([, c]) => !c.pass).map(([name, c]) => `${name}=${JSON.stringify(c.actual)}`);
      log(`${score.pass ? 'PASS' : 'FAIL'} ${fixture.id} run ${run}/${opts.k}`
        + (failed.length ? ` failed=[${failed.join(', ')}]` : '')
        + (callError ? ` call_error=${callError}` : ''));
    }
  }

  const summary = summarizeCodingGoldRuns(scored);
  const gate = meetsCodingGoldThresholds(summary);
  const report = {
    ran_at: new Date().toISOString(),
    gold_set_version: CODING_GOLD_SET_AE_VERSION,
    k: opts.k,
    models: summary.models,
    gate,
    summary,
    details
  };
  writeFileSync(opts.out, JSON.stringify(report, null, 2));
  if (opts.print) console.log(JSON.stringify(summary, null, 2));
  log(`gate=${gate ? 'MET' : 'NOT MET'} passing=${summary.passing_fixtures}/${summary.fixture_count}`
    + (summary.unstable_fixtures.length ? ` unstable=[${summary.unstable_fixtures.join(',')}]` : '')
    + (summary.failing_fixtures.length ? ` failing=[${summary.failing_fixtures.join(',')}]` : '')
    + ` models=[${summary.models.join(',')}] report=${opts.out}`);
  process.exit(gate ? 0 : 1);
};

main().catch((error) => {
  console.error('[coding-goldset-ae] runner error:', error?.stack || error);
  process.exit(1);
});
