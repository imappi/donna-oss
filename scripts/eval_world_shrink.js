#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { shrinkFailingWorld } from '../server/donna/world/shrinker.js';
import {
  carryPinnedSolverModuleIdentity,
  getPinnedSolverModuleIdentity,
  loadPinnedSolverModule,
  loadWorldSpecs,
  pinSolverModule,
  runWorldClose,
} from './eval_world_close.js';

export const NO_FAILURE_RECEIPT = Object.freeze({ outcome: 'no_failure' });

export function parseArgs(argv) {
  const args = { filter: null, solverModule: null, maxEvaluations: null, output: null, print: false };
  for (const token of argv) {
    if (token === '--print') args.print = true;
    else if (token.startsWith('--filter=')) args.filter = nonemptyValue(token, '--filter=');
    else if (token.startsWith('--solver-module=')) args.solverModule = nonemptyValue(token, '--solver-module=');
    else if (token.startsWith('--max-evaluations=')) {
      const raw = nonemptyValue(token, '--max-evaluations=');
      if (!/^\d+$/.test(raw)) throw new Error('--max-evaluations must be a safe integer of at least 2');
      args.maxEvaluations = Number(raw);
    } else if (token.startsWith('--output=')) args.output = nonemptyValue(token, '--output=');
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!args.solverModule) throw new Error('--solver-module is required; it must export solveWorldClose using Donna production modules');
  if (!Number.isSafeInteger(args.maxEvaluations) || args.maxEvaluations < 2) {
    throw new Error('--max-evaluations is required and must be a safe integer of at least 2');
  }
  return args;
}

export async function loadSolveWorldClose(solverModule) {
  const loaded = await loadPinnedSolverModule(pinSolverModule(solverModule));
  return loaded.solveWorldClose;
}

export async function runWorldShrink({ worldSpec, solveWorldClose, maxEvaluations, runtime = {} } = {}) {
  if (!worldSpec || typeof worldSpec !== 'object' || Array.isArray(worldSpec)) throw new TypeError('worldSpec must be an object');
  if (typeof solveWorldClose !== 'function') throw new TypeError('solveWorldClose must be a function');
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 2) throw new TypeError('maxEvaluations must be a safe integer of at least 2');

  const solverModule = getPinnedSolverModuleIdentity(solveWorldClose);
  const spend = { solveCalls: 0, providerUsage: [] };
  const evaluationErrors = [];
  let expectedScorerIdentity = null;
  // Instrument the loaded production adapter here, without modifying it or
  // replacing the runner predicate. Every candidate still traverses the same
  // runWorldClose seam as the live whole-close command.
  const countedSolve = async (input) => {
    spend.solveCalls += 1;
    return solveWorldClose(input);
  };
  const captureRunUsage = (run) => {
    if (run?.modelUsage && typeof run.modelUsage === 'object') spend.providerUsage.push(structuredClone(run.modelUsage));
  };
  carryPinnedSolverModuleIdentity(countedSolve, solveWorldClose);
  const evaluateFailure = async (candidate) => {
    let run;
    try {
      run = await runWorldClose({ worldSpec: candidate, solve: countedSolve, runtime });
    } catch (error) {
      if (error?.modelUsage && typeof error.modelUsage === 'object') spend.providerUsage.push(structuredClone(error.modelUsage));
      throw error;
    }
    captureRunUsage(run);
    const provenanceErrors = run.provenanceErrors ?? [];
    const scorerChanged = expectedScorerIdentity !== null
      && canonicalIdentity(run.provenance?.scorerIdentity) !== expectedScorerIdentity;
    if (provenanceErrors.length > 0 || scorerChanged) {
      const error = {
        outcome: 'evaluation_error',
        status: scorerChanged ? 'model_identity_changed' : 'model_provenance_refused',
        errors: scorerChanged ? ['scorer identity changed across shrink evaluations'] : [...provenanceErrors],
      };
      evaluationErrors.push(structuredClone(error));
      return error;
    }
    if (run.status === 'pass') return NO_FAILURE_RECEIPT;
    if (run.failureReceipt) return run.failureReceipt;
    const error = {
      outcome: 'evaluation_error',
      status: run.status,
      errors: run.errors ?? run.traceReceiptErrors ?? [],
    };
    evaluationErrors.push(structuredClone(error));
    return error;
  };

  let initial;
  try {
    initial = await runWorldClose({ worldSpec, solve: countedSolve, runtime });
    captureRunUsage(initial);
  } catch (error) {
    if (error?.modelUsage && typeof error.modelUsage === 'object') spend.providerUsage.push(structuredClone(error.modelUsage));
    initial = {
      status: 'adapter_error',
      errors: [error instanceof Error ? error.message : String(error)],
      worldId: worldSpec.worldId ?? null,
    };
    return { ok: false, status: 'runner_refused', worldId: worldSpec.worldId ?? null, initialRun: initial, shrink: null, evaluationErrors, spend, provenance: { solverModule, scorerIdentity: null } };
  }
  const provenance = {
    solverModule: initial.provenance?.solverModule ?? solverModule,
    scorerIdentity: initial.provenance?.scorerIdentity ?? null,
  };
  expectedScorerIdentity = canonicalIdentity(provenance.scorerIdentity);
  if ((initial.provenanceErrors ?? []).length > 0) {
    return { ok: false, status: 'runner_refused', worldId: worldSpec.worldId ?? null, initialRun: initial, shrink: null, evaluationErrors, spend, provenance };
  }
  if (initial.status === 'pass') return { ok: true, status: 'no_failure', worldId: worldSpec.worldId ?? null, initialRun: initial, shrink: null, evaluationErrors, spend, provenance };
  if (!initial.failureReceipt) return { ok: false, status: 'runner_refused', worldId: worldSpec.worldId ?? null, initialRun: initial, shrink: null, evaluationErrors, spend, provenance };

  const shrink = await shrinkFailingWorld({
    worldSpec,
    failureReceipt: initial.failureReceipt,
    evaluateFailure,
    maxEvaluations: maxEvaluations - spend.solveCalls,
  });
  const scorerChanged = evaluationErrors.some(({ status }) => status === 'model_identity_changed');
  return {
    ok: scorerChanged ? false : shrink.ok,
    status: scorerChanged ? 'runner_refused' : shrink.ok ? (shrink.quarantine.length ? 'quarantined' : 'shrunk') : 'shrink_refused',
    worldId: worldSpec.worldId ?? null,
    initialRun: initial,
    shrink,
    evaluationErrors,
    spend,
    provenance,
  };
}

function nonemptyValue(token, prefix) {
  const value = token.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const worlds = loadWorldSpecs({ filter: args.filter });
  if (worlds.length !== 1) throw new Error(`shrink requires exactly one runnable world; matched ${worlds.length}`);
  const solveWorldClose = await loadSolveWorldClose(args.solverModule);
  const result = await runWorldShrink({
    worldSpec: worlds[0], solveWorldClose, maxEvaluations: args.maxEvaluations,
    runtime: { donnaCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' },
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) { mkdirSync(dirname(resolve(args.output)), { recursive: true }); writeFileSync(resolve(args.output), serialized); }
  if (args.print || !args.output) process.stdout.write(serialized);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });

function canonicalIdentity(identity) {
  return JSON.stringify(identity ?? null);
}
