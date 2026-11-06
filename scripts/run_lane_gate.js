#!/usr/bin/env node
//
// Descent ladder Q6 — run a lane's PROMOTION GATE and write the verdict
// artifact (docs/design-donna-qwen-descent-ladder.md §5.2).
//
// The gate has two evidence halves and this script joins them:
//   1. the live GAP TABLE over model_challenger_runs (fleet-wide by
//      default — promotion is a product decision, not a per-firm one);
//   2. a GOLD-SET report produced by scripts/run_bank_line_goldset.js
//      against the same candidate (pass its path with --gold).
//
// The output is the WRITTEN verdict a human signs — numbers + divergence
// links, signature block EMPTY (who signs is spec §9.1, open). THIS SCRIPT
// NEVER FLIPS A LANE: a green verdict is signable, and the flip is its own
// dated commit (config-plane stage + qualified-set extension) with the
// signed verdict attached. Exit code 0 = green, 1 = red — and an empty
// table exits red with insufficient_data, never green.
//
// USAGE:
//   node scripts/run_lane_gate.js
//     [--lane bank_line_disposition]         # default: the pilot lane (Q6a)
//     [--firm <id>]                         # narrow to one firm's receipts
//     [--gold bank-line-goldset-report.json]# the candidate's gold-set run
//     [--candidate <model-id>]              # default: the gold report's response model
//     [--out lane-gate-verdict.json]

import { readFileSync, writeFileSync } from 'node:fs';

import { withFirmDbClient } from '../server/donna/firmDb.js';
import { getLane } from '../server/donna/modelLanes.js';
import {
  buildPromotionVerdict,
  computeLaneGapTable,
  evaluateLaneGate,
  laneGateThresholds,
  listDivergenceRunIds
} from '../server/donna/modelLaneGate.js';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { lane: 'bank_line_disposition', firm: null, gold: null, candidate: null, out: 'lane-gate-verdict.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--lane') { out.lane = argv[i + 1]; i += 1; }
    else if (argv[i] === '--firm') { out.firm = argv[i + 1]; i += 1; }
    else if (argv[i] === '--gold') { out.gold = argv[i + 1]; i += 1; }
    else if (argv[i] === '--candidate') { out.candidate = argv[i + 1]; i += 1; }
    else if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[lane-gate]', ...args);

const main = async () => {
  const opts = parseArgv();

  const lane = getLane(opts.lane);
  if (!lane) {
    console.error(`[lane-gate] unknown lane "${opts.lane}" — see modelLanes.js`);
    process.exit(1);
  }
  if (!laneGateThresholds(opts.lane)) {
    console.error(`[lane-gate] lane "${opts.lane}" has no registered gate thresholds (LANE_GATE_THRESHOLDS) — registering them is a dated call`);
    process.exit(1);
  }

  // The gold half: absent reads as a red reason downstream, honestly.
  let goldReport = null;
  if (opts.gold) {
    try {
      goldReport = JSON.parse(readFileSync(opts.gold, 'utf8'));
    } catch (error) {
      console.error(`[lane-gate] could not read gold report ${opts.gold}: ${error?.message || error}`);
      process.exit(1);
    }
    if (goldReport.lane && goldReport.lane !== opts.lane) {
      console.error(`[lane-gate] gold report is for lane "${goldReport.lane}", gate is for "${opts.lane}"`);
      process.exit(1);
    }
  }

  // Candidate identity: named, or taken from the gold run's RESPONSE
  // models (the receipt-grade id — never a config default).
  const candidateModel = opts.candidate
    || (goldReport?.response_models?.length === 1 ? goldReport.response_models[0] : null);

  const { gapTable, divergenceLinks } = await withFirmDbClient(async (client) => ({
    gapTable: await computeLaneGapTable({ client, laneId: opts.lane, firmId: opts.firm }),
    divergenceLinks: await listDivergenceRunIds({ client, laneId: opts.lane, firmId: opts.firm })
  }));

  const gate = evaluateLaneGate({
    gapTable,
    goldReport,
    candidateModel,
    qualified: lane.qualified
  });

  const verdict = buildPromotionVerdict({
    laneId: opts.lane,
    candidateModel,
    gapTable,
    goldReport,
    gate,
    divergenceLinks
  });
  writeFileSync(opts.out, JSON.stringify(verdict, null, 2));

  log(`lane=${opts.lane} scope=${opts.firm || 'fleet'} candidate=${candidateModel || '(none)'} `
    + `runs=${gapTable.runs} window_days=${Math.round(gapTable.window_days * 10) / 10}`);
  log(`rates=${JSON.stringify(gapTable.rates)}`);
  for (const reason of gate.reasons) log(`RED ${reason.code}: ${reason.detail}`);
  log(`gate: ${gate.verdict.toUpperCase()}${gate.insufficient_data ? ' (insufficient data)' : ''} (verdict → ${opts.out})`);
  if (gate.verdict === 'green') {
    log('green = SIGNABLE, not flipped: the flip is its own dated commit with this verdict attached (spec §5.2/§6; signer per §9.1).');
  }
  process.exit(gate.verdict === 'green' ? 0 : 1);
};

main().catch((err) => {
  console.error('[lane-gate] FAILED', err);
  process.exit(1);
});
