#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadPinnedSolverModule, loadWorldSpecs, pinSolverModule, runWorldClose } from './eval_world_close.js';

export const RUN_COUNT = 3;

export function parseArgs(argv) {
  const args = { filter: null, solverModule: null, output: null, print: false };
  for (const token of argv) {
    if (token === '--print') args.print = true;
    else if (token.startsWith('--filter=')) args.filter = requiredValue(token, '--filter=');
    else if (token.startsWith('--solver-module=')) args.solverModule = requiredValue(token, '--solver-module=');
    else if (token.startsWith('--output=')) args.output = requiredValue(token, '--output=');
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!args.filter) throw new Error('--filter is required');
  if (!args.solverModule) throw new Error('--solver-module is required');
  return args;
}

export async function runMatcherVariance({ worldSpec, solveWorldClose, runtime = {} }) {
  if (!worldSpec) throw new TypeError('worldSpec is required');
  if (typeof solveWorldClose !== 'function') throw new TypeError('solveWorldClose must be a function');
  const runs = [];
  for (let index = 0; index < RUN_COUNT; index += 1) {
    const result = await runWorldClose({ worldSpec, solve: solveWorldClose, runtime });
    const matching = result.traceReceipts?.find(({ stage }) => stage === 'candidate_state_alternatives');
    if (!matching?.modelId) throw new Error(`run ${index + 1} has no response-receipted matcher model id`);
    const usage = matching.usage ?? matching.runtimeSnapshot?.usage ?? null;
    runs.push({
      run: index + 1,
      observedState: matching.observedState,
      expectedMatchCount: matching.runtimeSnapshot?.perInvoiceOutcomes?.filter(({ expectedToSettle }) => expectedToSettle).length ?? null,
      proposedMatchCount: matching.runtimeSnapshot?.perInvoiceOutcomes?.filter(({ expectedToSettle, proposedBankArtifactIds }) => expectedToSettle && proposedBankArtifactIds.length > 0).length ?? null,
      modelId: matching.modelId,
      modelSource: matching.model_source ?? 'response_receipt',
      usage: usage ?? { status: 'UNKNOWN-NOT-ZERO' },
      solverDigest: result.provenance?.solverModule?.sha256 ?? null,
    });
  }
  if (runs.some(({ solverDigest }) => !solverDigest)) throw new Error('all variance runs require a pinned solver digest');
  return {
    version: 'eaw.matcher-variance.v1',
    characterizationOnly: true,
    productionPromptStatus: 'unresolved',
    k: RUN_COUNT,
    worldId: worldSpec.worldId,
    observedAgreement: new Set(runs.map(({ observedState }) => observedState)).size === 1,
    correctnessClaim: null,
    runs,
  };
}

export function writeReceiptExclusive(outputPath, serialized) {
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serialized, { flag: 'wx' });
}

function requiredValue(token, prefix) {
  const value = token.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const worlds = loadWorldSpecs({ filter: args.filter });
  if (worlds.length !== 1) throw new Error(`matcher variance requires exactly one world; matched ${worlds.length}`);
  const loaded = await loadPinnedSolverModule(pinSolverModule(args.solverModule));
  const receipt = await runMatcherVariance({
    worldSpec: worlds[0], solveWorldClose: loaded.solveWorldClose,
    runtime: { donnaCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local', solverModule: loaded.solverModule },
  });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) writeReceiptExclusive(args.output, serialized);
  if (args.print || !args.output) process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
}
