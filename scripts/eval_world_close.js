#!/usr/bin/env node
// Offline whole-close runner for the executable accounting world. This file is
// the only seam at which privileged world state and Donna's solve path meet.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { diffAgainstBaseline, formatSummary, loadBaseline, runEval, saveBaseline } from '../server/donna/evalHarness.js';
import { buildObservationSchedule } from '../server/donna/world/observationSchedule.js';
import { evaluateCandidateClose, readProof0PolicyPack } from '../server/donna/world/oracleSuite.js';
import { projectPolicy } from '../server/donna/world/policyProjection.js';
import {
  MODEL_PROVENANCE_CLASSIFICATIONS,
  OBSERVABLE_TRACE_STAGES,
  buildFailureReceipt,
  validateDecisionReceipt,
} from '../server/donna/world/traceReceipts.js';
import { renderWorldArtifacts } from '../server/donna/world/worldRenderer.js';
import { validateWorldSpec } from '../server/donna/world/worldSchema.js';
import { validateCausalWorld } from '../server/donna/world/worldValidity.js';

export const WORLD_CLOSE_SUITE = 'world-close';

const SHA256 = /^[0-9a-f]{64}$/;
const ZERO_SHA256 = /^0{64}$/;
const PINNED_SOLVERS = new WeakMap();

export function pinSolverModule(solverModule) {
  if (typeof solverModule !== 'string' || solverModule.trim() === '') {
    throw new TypeError('solverModule must be a non-empty path');
  }
  const requestedPath = resolve(solverModule);
  const canonicalPath = canonicalPathFor(requestedPath);
  const sha256 = digestSolverBytes(readFileSync(canonicalPath));
  return Object.freeze({ algorithm: 'sha256', requestedPath, canonicalPath, sha256 });
}

export function digestSolverBytes(bytes) {
  if (!(typeof bytes === 'string' || ArrayBuffer.isView(bytes))) {
    throw new TypeError('solver bytes must be a string or byte buffer');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifySolverModulePin(pin) {
  validateSolverModulePin(pin);
  const currentCanonicalPath = canonicalPathFor(pin.requestedPath);
  if (currentCanonicalPath !== pin.canonicalPath) {
    throw new Error('solver module symlink target changed after pinning');
  }
  const observed = digestSolverBytes(readFileSync(pin.canonicalPath));
  if (observed !== pin.sha256) throw new Error('solver module bytes changed after pinning');
  return true;
}

export async function loadPinnedSolverModule(pin, { beforeImport } = {}) {
  validateSolverModulePin(pin);
  verifySolverModulePin(pin);
  await beforeImport?.(pin);
  verifySolverModulePin(pin);
  const adapter = await import(`${pathToFileURL(pin.canonicalPath).href}?sha256=${pin.sha256}`);
  verifySolverModulePin(pin);
  if (typeof adapter.solveWorldClose !== 'function') throw new Error('solver module must export solveWorldClose');

  const identity = Object.freeze({
    algorithm: 'sha256',
    canonicalPath: pin.canonicalPath,
    sha256: pin.sha256,
  });
  const solveWorldClose = async (...args) => {
    verifySolverModulePin(pin);
    try {
      return await adapter.solveWorldClose(...args);
    } finally {
      verifySolverModulePin(pin);
    }
  };
  PINNED_SOLVERS.set(solveWorldClose, identity);
  return { solveWorldClose, solverModule: { ...identity } };
}

export function getPinnedSolverModuleIdentity(solve) {
  const identity = typeof solve === 'function' ? PINNED_SOLVERS.get(solve) : null;
  return identity ? { ...identity } : null;
}

export function carryPinnedSolverModuleIdentity(target, source) {
  if (typeof target !== 'function' || typeof source !== 'function') throw new TypeError('solver identity can only be carried between functions');
  const identity = PINNED_SOLVERS.get(source);
  if (identity) PINNED_SOLVERS.set(target, identity);
  return target;
}

export function validateRunnerModelIdentity({ resolvedModelId, traceReceipts } = {}) {
  const receipts = Array.isArray(traceReceipts) ? traceReceipts : [];
  const errors = [];
  if (typeof resolvedModelId !== 'string' || resolvedModelId.trim() === '') {
    errors.push('resolved solver model identity is missing');
  }
  if (receipts.length === 0) errors.push('scorer identity receipt is missing');

  const stages = new Map();
  const classifications = new Set();
  const modelSources = new Set();
  receipts.forEach((receipt, index) => {
    const validation = validateDecisionReceipt(receipt);
    errors.push(...validation.errors.map((error) => `traceReceipts[${index}].${error}`));
    const classification = validation.provenance?.classification ?? null;
    const modelSource = Object.hasOwn(receipt ?? {}, 'model_source') ? receipt.model_source : null;
    if (classification) classifications.add(classification);
    if (modelSource) modelSources.add(modelSource);
    if (classification === MODEL_PROVENANCE_CLASSIFICATIONS.CONFIGURED_FALLBACK) {
      errors.push(`traceReceipts[${index}] scorer identity came from configured fallback`);
    }
    for (const field of ['base_model_digest', 'adapter_digest', 'vision_projector_digest']) {
      if (ZERO_SHA256.test(receipt?.model_artifact?.[field] ?? '')) {
        errors.push(`traceReceipts[${index}].model_artifact.${field} cannot be a zero/sentinel digest`);
      }
    }

    const identity = {
      stage: receipt?.stage ?? null,
      modelId: receipt?.modelId ?? null,
      modelSource,
      classification,
    };
    const prior = stages.get(identity.stage);
    if (prior && (prior.modelId !== identity.modelId || prior.modelSource !== identity.modelSource || prior.classification !== identity.classification)) {
      errors.push(`scorer identity changed within stage ${String(identity.stage)}`);
    } else if (prior) {
      prior.receiptCount += 1;
    } else {
      stages.set(identity.stage, { ...identity, receiptCount: 1 });
    }
  });

  if (classifications.size > 1) errors.push('scorer stages contain contradictory model provenance classifications');
  if (modelSources.size > 1) errors.push('scorer stages contain contradictory model sources');

  const finalReceipt = [...receipts].sort(compareReceiptOrder).at(-1);
  if (typeof resolvedModelId === 'string' && resolvedModelId.trim() !== '' && finalReceipt?.modelId !== resolvedModelId) {
    errors.push('resolved solver model identity disagrees with the final executed stage receipt');
  }

  return {
    ok: errors.length === 0,
    errors,
    identity: {
      resolvedModelId: typeof resolvedModelId === 'string' && resolvedModelId.trim() !== '' ? resolvedModelId : null,
      modelSource: modelSources.size === 1 ? [...modelSources][0] : null,
      classification: classifications.size === 1 ? [...classifications][0] : null,
      stages: [...stages.values()].sort((left, right) => stageIndex(left.stage) - stageIndex(right.stage)),
    },
  };
}

export function parseArgs(argv) {
  const args = { filter: null, print: false, saveBaseline: false, output: null, solverModule: null };
  for (const token of argv) {
    if (token === '--print') args.print = true;
    else if (token === '--save-baseline') args.saveBaseline = true;
    else if (token.startsWith('--filter=')) args.filter = token.slice(9);
    else if (token.startsWith('--output=')) args.output = token.slice(9);
    else if (token.startsWith('--solver-module=')) args.solverModule = token.slice(16);
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

export function loadWorldSpecs({ root = 'data/worlds', filter = null } = {}) {
  // Keep fixture discovery explicit: policy, receipts, rendered outputs and
  // known-invalid fixtures are not runnable worlds.
  const names = readdirSync(root);
  return names.filter((name) => name.endsWith('.json') && !name.includes('invalid'))
    .map((name) => JSON.parse(readFileSync(resolve(root, name), 'utf8')))
    .filter((world) => !filter || world.worldId?.includes(filter))
    .sort((a, b) => a.worldId.localeCompare(b.worldId));
}

export async function runWorldClose({ worldSpec, solve, policyPack = null, runtime = {} }) {
  if (typeof solve !== 'function') throw new TypeError('solve must be Donna production-path adapter function');
  const pinnedSolverModule = getPinnedSolverModuleIdentity(solve);
  const solverModuleErrors = validateDeclaredSolverModule(runtime.solverModule, pinnedSolverModule);
  const shape = validateWorldSpec(worldSpec);
  const validity = shape.ok ? validateCausalWorld(worldSpec) : { ok: false, errors: [] };
  if (!shape.ok || !validity.ok) {
    return { status: 'invalid_world', errors: [...shape.errors, ...validity.errors], worldId: worldSpec?.worldId ?? null };
  }

  const pack = policyPack ?? await readProof0PolicyPack();
  const projection = projectPolicy(worldSpec, pack);
  const schedule = buildObservationSchedule(worldSpec);
  const rendering = await renderWorldArtifacts(worldSpec);
  if (!projection.ok || !schedule.ok || !rendering.ok) {
    return { status: 'compile_error', errors: [...projection.errors, ...schedule.errors, ...rendering.errors], worldId: worldSpec.worldId };
  }
  const enrichModelUsage = (usage) => ({
    ...(usage && typeof usage === 'object'
      ? structuredClone(usage)
      : { version: 'eaw.model-usage.v1', status: 'incomplete', calls: [], incomplete_fields: ['adapter.usage'], cash: { status: 'unknown', reason: 'adapter_usage_missing' } }),
    configuration_digest: digestCanonical({
      capability: worldSpec.manifest,
      policyPackVersion: projection.policyPackVersion,
      runtime,
      schedulerVersion: schedule.version,
      rendererVersion: rendering.version,
    }),
    artifact_digests: rendering.artifacts.map((artifact) => digestCanonical(artifact)).sort(),
  });

  // Only observations are handed to Donna. Privileged events, hidden values,
  // policy projection and oracle expectations stay on the judge side.
  let solverResult;
  try {
    solverResult = await solve({
      worldId: worldSpec.worldId,
      capability: { ...worldSpec.manifest },
      observations: schedule.observations.map((item) => ({ ...item })),
      artifacts: rendering.artifacts.map((item) => ({ ...item })),
      runtime: { ...runtime },
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.modelUsage = enrichModelUsage(failure.modelUsage);
    throw failure;
  }
  const candidateClose = solverResult?.candidateClose ?? {};
  const traceReceipts = solverResult?.traceReceipts ?? [];
  const receiptErrors = traceReceipts.flatMap((receipt) => validateDecisionReceipt(receipt).errors);
  const modelValidation = validateRunnerModelIdentity({
    resolvedModelId: solverResult?.resolvedModelId,
    traceReceipts,
  });
  const oracleVerdict = evaluateCandidateClose(worldSpec, pack, candidateClose);
  const failure = oracleVerdict.ok ? null : buildFailureReceipt({
    failureId: `failure/${worldSpec.worldId}`,
    worldSpec,
    failureClass: solverResult?.failureClass ?? 'whole_close_oracle_failure',
    oracleVerdict,
    traceReceipts,
    consequence: solverResult?.consequence ?? {},
    permittedPatchSurfaces: solverResult?.permittedPatchSurfaces ?? [],
    protectedSurfaces: ['causal_world', 'oracle', 'policy_pack', 'accounting_invariants'],
  }).receipt;
  return {
    status: oracleVerdict.ok && receiptErrors.length === 0 && modelValidation.ok && solverModuleErrors.length === 0 ? 'pass' : 'fail',
    worldId: worldSpec.worldId,
    candidateClose,
    oracleVerdict,
    traceReceipts,
    traceReceiptErrors: receiptErrors,
    provenanceErrors: [...modelValidation.errors, ...solverModuleErrors],
    failureReceipt: failure,
    modelUsage: enrichModelUsage(solverResult?.usage),
    provenance: {
      capabilityManifestVersion: worldSpec.manifest.manifestVersion,
      worldSchemaVersion: worldSpec.specVersion,
      worldSeed: worldSpec.seed,
      policyPackVersion: projection.policyPackVersion,
      resolvedModelId: solverResult?.resolvedModelId ?? null,
      scorerIdentity: modelValidation.identity,
      solverModule: pinnedSolverModule,
      donnaCommit: runtime.donnaCommit ?? null,
      runtimeConfig: runtime.config ?? {},
      schedulerVersion: schedule.version,
      rendererVersion: rendering.version,
      oracleVersion: oracleVerdict.version,
    },
  };
}

function digestCanonical(value) {
  const canonicalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (!entry || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonicalize(entry[key])]));
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function scoreWorldClose(_fixture, actual) {
  const pass = actual?.status === 'pass' && typeof actual?.provenance?.resolvedModelId === 'string' && actual.provenance.resolvedModelId.length > 0;
  return { status: pass ? 'pass' : 'fail', truePositive: pass ? 1 : 0, falsePositive: 0, falseNegative: pass ? 0 : 1, expectedSize: 1, actualSize: 1, unmatchableExpected: null, unmatchableActual: null };
}

export async function runWorldCloseEval({ worlds, solve, ranAt = null, runtime = {} }) {
  return runEval({
    suite: WORLD_CLOSE_SUITE,
    mode: 'production-path',
    model: 'provider-resolved-per-case',
    fixtures: worlds.map((world) => ({ id: world.worldId, world })),
    runner: (fixture) => runWorldClose({ worldSpec: fixture.world, solve, runtime }),
    scorer: scoreWorldClose,
    ranAt,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.solverModule) throw new Error('--solver-module is required; it must export solveWorldClose using Donna production modules');
  const worlds = loadWorldSpecs({ filter: args.filter });
  if (worlds.length === 0) throw new Error(`no runnable worlds matched ${JSON.stringify(args.filter ?? '')}`);
  const loaded = await loadPinnedSolverModule(pinSolverModule(args.solverModule));
  const result = await runWorldCloseEval({ worlds, solve: loaded.solveWorldClose, runtime: { donnaCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' } });
  const baseline = loadBaseline(WORLD_CLOSE_SUITE, 'production-path');
  const diff = diffAgainstBaseline(result, baseline);
  if (args.output) { mkdirSync(dirname(resolve(args.output)), { recursive: true }); writeFileSync(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`); }
  if (args.saveBaseline) console.error(`baseline saved → ${saveBaseline(result)}`);
  if (args.print) console.log(formatSummary(result, diff));
  else if (!args.output && !args.saveBaseline) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (diff.hasBaseline && diff.regressions.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });

function canonicalPathFor(path) {
  return typeof realpathSync.native === 'function' ? realpathSync.native(path) : realpathSync(path);
}

function validateSolverModulePin(pin) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new TypeError('valid solver module pin is required');
  if (pin.algorithm !== 'sha256') throw new TypeError('solver module pin algorithm must be sha256');
  if (typeof pin.requestedPath !== 'string' || typeof pin.canonicalPath !== 'string') {
    throw new TypeError('solver module pin paths must be strings');
  }
  if (!SHA256.test(pin.sha256 ?? '') || ZERO_SHA256.test(pin.sha256)) {
    throw new TypeError('solver module pin must contain a nonzero lowercase SHA-256 digest');
  }
}

function validateDeclaredSolverModule(declared, executed) {
  if (declared == null) return [];
  if (!executed) return ['declared solver module provenance is not tied to the executed function'];
  if (declared.algorithm !== executed.algorithm || declared.canonicalPath !== executed.canonicalPath || declared.sha256 !== executed.sha256) {
    return ['declared solver module provenance disagrees with the executed module'];
  }
  return [];
}

function stageIndex(stage) {
  const index = OBSERVABLE_TRACE_STAGES.indexOf(stage);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function compareReceiptOrder(left, right) {
  return stageIndex(left?.stage) - stageIndex(right?.stage)
    || Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0);
}
