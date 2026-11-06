// Run the intent-compiler GOLD SET against the real model (BizOS Slice 1c, addendum §8).
//
// THE evaluation gate: enabling INTENT_COMPILER_SHADOW beyond the first canary client
// requires a run of this script at or above GOLD_SET_THRESHOLDS. Never run in CI — it
// makes one real Anthropic call per fixture (~15 calls). Every result stamps model_id +
// prompt_version + registry_fingerprint so runs are comparable across model bumps
// (the-model-id-is-part-of-the-receipt).
//
// USAGE:
//   ANTHROPIC_API_KEY=… node scripts/run_intent_compiler_goldset.js
//   … --only birthday_reminder,hostile_quoted_instruction     # subset
//   … --out /tmp/goldset-report.json                          # report path (default below)
//
// Exit code: 0 when every threshold is met, 1 otherwise (or on a runner error).

import { writeFileSync } from 'node:fs';

import { compileOwnerInstruction, assembleIntentCompileResult, INTENT_COMPILER_PROMPT_VERSION, intentCompilerModelId } from '../server/donna/intentCompiler.js';
import { capabilityRegistryFingerprint } from '../server/donna/capabilityRegistry.js';
import { validateIntentCompileResult } from '../server/donna/intentObjects.js';
import {
  GOLD_FIXTURES,
  GOLD_SET_VERSION,
  GOLD_SET_THRESHOLDS,
  goldSetLintErrors,
  scoreCompileResultAgainstFixture,
  summarizeGoldSetRun,
  meetsGoldSetThresholds
} from '../server/donna/intentCompilerGoldSet.js';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { only: null, out: 'goldset-report.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') { out.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[goldset]', ...args);

const main = async () => {
  const opts = parseArgv();
  const lint = goldSetLintErrors();
  if (lint.length) {
    console.error('[goldset] fixture lint failed:', lint);
    process.exit(1);
  }
  const fixtures = opts.only ? GOLD_FIXTURES.filter((f) => opts.only.includes(f.id)) : GOLD_FIXTURES;
  if (!fixtures.length) {
    console.error('[goldset] no fixtures selected');
    process.exit(1);
  }
  const modelId = intentCompilerModelId();
  const registryFingerprint = capabilityRegistryFingerprint();
  log(`gold_set=${GOLD_SET_VERSION} fixtures=${fixtures.length} model=${modelId} prompt=${INTENT_COMPILER_PROMPT_VERSION}`);

  const scored = [];
  const details = [];
  for (const fixture of fixtures) {
    const sourceMessageId = `gold-${fixture.id}`;
    const compiled = await compileOwnerInstruction({
      ownerMessage: fixture.owner_message,
      sourceMessageId,
      history: fixture.history
    });
    const result = assembleIntentCompileResult({ compiled, sourceMessageId, registryFingerprint });
    const schemaValid = validateIntentCompileResult(result).length === 0 && result.failure_category === null;
    const score = scoreCompileResultAgainstFixture(result, fixture, { schemaValid });
    scored.push(score);
    details.push({ fixture_id: fixture.id, score, result });
    const failedChecks = Object.entries(score.checks).filter(([, ok]) => !ok).map(([name]) => name);
    log(`${score.pass ? 'PASS' : 'FAIL'} ${fixture.id}`
      + ` objects=${result.objects.length} warnings=${result.validation_warnings.length}`
      + (failedChecks.length ? ` failed=[${failedChecks.join(',')}]` : ''));
  }

  const summary = summarizeGoldSetRun(scored);
  const gate = meetsGoldSetThresholds(summary);
  const report = {
    ran_at: new Date().toISOString(),
    model_id: modelId,
    prompt_version: INTENT_COMPILER_PROMPT_VERSION,
    registry_fingerprint: registryFingerprint,
    thresholds: GOLD_SET_THRESHOLDS,
    summary,
    gate: gate ? 'PASS' : 'FAIL',
    details
  };
  writeFileSync(opts.out, JSON.stringify(report, null, 2));
  log('summary:', JSON.stringify(summary, null, 2));
  log(`gate: ${report.gate} (report → ${opts.out})`);
  process.exit(gate ? 0 : 1);
};

main().catch((err) => {
  console.error('[goldset] FAILED', err);
  process.exit(1);
});
