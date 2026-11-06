#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deriveSiblingWorld } from '../server/donna/world/siblingWorld.js';
import {
  getPinnedSolverModuleIdentity,
  loadPinnedSolverModule,
  loadWorldSpecs,
  pinSolverModule,
  runWorldClose,
} from './eval_world_close.js';

export function parseArgs(argv) {
  const args = { filter: null, solverModule: null, output: null, print: false };
  for (const token of argv) {
    if (token === '--print') args.print = true;
    else if (token.startsWith('--filter=')) args.filter = nonemptyValue(token, '--filter=');
    else if (token.startsWith('--solver-module=')) args.solverModule = nonemptyValue(token, '--solver-module=');
    else if (token.startsWith('--output=')) args.output = nonemptyValue(token, '--output=');
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!args.solverModule) throw new Error('--solver-module is required; it must export solveWorldClose using Donna production modules');
  return args;
}

export async function loadSolveWorldClose(solverModule) {
  const loaded = await loadPinnedSolverModule(pinSolverModule(solverModule));
  return loaded.solveWorldClose;
}

export async function runSiblingWorldClose({ sourceWorld, solveWorldClose, runtime = {} } = {}) {
  if (!sourceWorld || typeof sourceWorld !== 'object' || Array.isArray(sourceWorld)) throw new TypeError('sourceWorld must be an object');
  if (typeof solveWorldClose !== 'function') throw new TypeError('solveWorldClose must be a function');

  const derivation = deriveSiblingWorld(sourceWorld);
  if (derivation.errors.length > 0) {
    return {
      status: 'derivation_refused',
      sourceWorldId: derivation.sourceWorldId ?? sourceWorld.worldId ?? null,
      siblingWorldId: null,
      derivation,
      run: null,
      provenance: {
        solverModule: getPinnedSolverModuleIdentity(solveWorldClose),
        scorerIdentity: null,
      },
    };
  }
  if (!derivation.world) throw new Error('sibling derivation returned no world');

  let run;
  try {
    run = await runWorldClose({ worldSpec: derivation.world, solve: solveWorldClose, runtime });
  } catch (error) {
    return {
      status: 'adapter_error',
      sourceWorldId: derivation.sourceWorldId,
      siblingWorldId: derivation.world.worldId,
      derivation: {
        version: derivation.version,
        mutationId: derivation.mutationId,
        declaredFactId: derivation.declaredFactId,
        errors: derivation.errors,
      },
      run: {
        status: 'adapter_error',
        errors: [error instanceof Error ? error.message : String(error)],
        modelUsage: error?.modelUsage && typeof error.modelUsage === 'object'
          ? structuredClone(error.modelUsage)
          : { version: 'eaw.model-usage.v1', status: 'incomplete', calls: [], incomplete_fields: ['adapter.usage'], cash: { status: 'unknown', reason: 'adapter_usage_missing' } },
      },
      provenance: {
        solverModule: getPinnedSolverModuleIdentity(solveWorldClose),
        scorerIdentity: null,
      },
    };
  }
  return {
    status: run.status,
    sourceWorldId: derivation.sourceWorldId,
    siblingWorldId: derivation.world.worldId,
    derivation: {
      version: derivation.version,
      mutationId: derivation.mutationId,
      declaredFactId: derivation.declaredFactId,
      errors: derivation.errors,
    },
    run,
    provenance: {
      solverModule: run.provenance?.solverModule ?? getPinnedSolverModuleIdentity(solveWorldClose),
      scorerIdentity: run.provenance?.scorerIdentity ?? null,
    },
  };
}

export function writeReceiptExclusive(outputPath, serialized) {
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serialized, { flag: 'wx' });
}

function nonemptyValue(token, prefix) {
  const value = token.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const worlds = loadWorldSpecs({ filter: args.filter });
  if (worlds.length !== 1) throw new Error(`sibling close requires exactly one runnable source world; matched ${worlds.length}`);
  const solveWorldClose = await loadSolveWorldClose(args.solverModule);
  const receipt = await runSiblingWorldClose({
    sourceWorld: worlds[0],
    solveWorldClose,
    runtime: { donnaCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' },
  });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) writeReceiptExclusive(args.output, serialized);
  if (args.print || !args.output) process.stdout.write(serialized);
  if (receipt.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
}
