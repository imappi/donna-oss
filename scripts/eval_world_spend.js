#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_RECEIPTS = 'data/worlds/receipts/';
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN_KEYS = new Set([
  'input_tokens', 'output_tokens', 'total_tokens',
  'inputTokens', 'outputTokens', 'totalTokens',
  'prompt_tokens', 'completion_tokens', 'promptTokens', 'completionTokens',
]);
const PROVIDER_CALL_FIELDS = Object.freeze([
  'provider', 'response_id', 'model_id', 'input_tokens', 'output_tokens',
  'wall_time_ms', 'request_digest', 'http_status', 'retry_index',
  'retry_disposition', 'cache_disposition', 'outcome',
]);

export function parseArgs(argv) {
  const args = { receipts: [], output: null, print: false };
  for (const token of argv) {
    if (token === '--print') args.print = true;
    else if (token.startsWith('--receipts=')) args.receipts.push(nonemptyValue(token, '--receipts='));
    else if (token.startsWith('--output=')) args.output = nonemptyValue(token, '--output=');
    else throw new Error(`unknown argument: ${token}`);
  }
  if (args.receipts.length === 0) args.receipts.push(DEFAULT_RECEIPTS);
  return args;
}

export function discoverReceiptFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const path = resolve(input);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) files.push(resolve(path, entry.name));
      }
    } else files.push(path);
  }
  return [...new Set(files)].sort();
}

export function summarizeReceipt(receipt, file) {
  const family = receiptFamily(receipt);
  const models = new Set();
  walk(receipt, (key, value) => {
    if (['modelId', 'resolvedModelId', 'model_id'].includes(key) && typeof value === 'string' && value) models.add(value);
  });

  const spendSources = usageSources(receipt, family);
  const explicitZero = findExplicitZeroSpend(receipt, family);
  const calls = explicitZero ? [] : spendSources.flatMap(normalizeUsageCalls);
  calls.forEach(({ model_id }) => { if (typeof model_id === 'string' && model_id) models.add(model_id); });

  const tokens = {};
  for (const call of calls) collectTokens(call, tokens);
  if (calls.length === 0 && !explicitZero) {
    for (const source of spendSources) collectTokens(source, tokens);
  }
  const tokenCount = canonicalTokenTotal(tokens);
  const solveCalls = findSolveCalls(receipt, family, spendSources);
  const cash = summarizeCash(spendSources, explicitZero);
  const wall = summarizeWall(spendSources, calls, explicitZero);
  const digests = summarizeDigests(spendSources);
  const missingFields = [];

  if (family === 'unknown') missingFields.push('receipt.shape');
  if (solveCalls === null) missingFields.push('solve_calls');
  if (!explicitZero) {
    if (calls.length === 0) missingFields.push('provider_calls');
    calls.forEach((call, index) => {
      for (const fieldName of PROVIDER_CALL_FIELDS) {
        if (!validCallField(fieldName, call[fieldName])) missingFields.push(`calls[${index}].${fieldName}`);
      }
    });
  }
  if (cash.status !== 'counted') missingFields.push('cash_usd', 'price_source');
  if (wall.status !== 'measured') missingFields.push('wall_time_ms');
  if (!digests.configurationComplete) missingFields.push('configuration_digest');
  if (!digests.artifactsComplete) missingFields.push('artifact_digests');
  for (const [index, source] of spendSources.entries()) {
    if (Array.isArray(source?.incomplete_fields)) {
      missingFields.push(...source.incomplete_fields.map((fieldName) => `usage[${index}].${fieldName}`));
    }
  }

  const uniqueMissing = [...new Set(missingFields)].sort();
  const completenessStatus = uniqueMissing.length === 0 ? 'COMPLETE' : 'INCOMPLETE';
  return {
    file,
    family,
    models: [...models].sort(),
    solveCalls,
    providerCallCount: calls.length,
    retryCount: calls.filter(({ retry_index }) => Number.isSafeInteger(retry_index) && retry_index > 0).length,
    evaluationErrorCount: family === 'shrink' && Array.isArray(receipt.evaluationErrors) ? receipt.evaluationErrors.length : 0,
    usageStatus: explicitZero ? 'known-zero' : calls.length > 0 ? 'counted' : 'UNKNOWN-NOT-ZERO',
    tokens,
    tokenCount,
    cashStatus: cash.status,
    cashUsd: cash.usd,
    wallTimeStatus: wall.status,
    wallTimeMs: wall.ms,
    configurationDigests: digests.configuration,
    artifactDigests: digests.artifacts,
    completenessStatus,
    missingFields: uniqueMissing,
  };
}

export function readSpend(inputs) {
  const receipts = [];
  const errors = [];
  for (const file of discoverReceiptFiles(inputs)) {
    try {
      const summary = summarizeReceipt(JSON.parse(readFileSync(file, 'utf8')), file);
      receipts.push(summary);
      if (summary.family === 'unknown') errors.push({ file, code: 'unknown_shape', error: 'unknown_shape' });
    } catch (error) {
      errors.push({ file, code: 'malformed_json', error: error?.message ?? String(error) });
    }
  }
  const modelIds = [...new Set(receipts.flatMap((receipt) => receipt.models))].sort();
  const knownSolveCalls = receipts.reduce((sum, receipt) => sum + (receipt.solveCalls ?? 0), 0);
  const unknownSolveCallReceipts = receipts.filter((receipt) => receipt.solveCalls === null).length;
  const tokens = {};
  for (const receipt of receipts) mergeCounts(tokens, receipt.tokens);
  const families = {};
  for (const receipt of receipts) {
    const family = families[receipt.family] ??= emptyFamilyTotals();
    family.receiptCount += 1;
    family.solveCalls += receipt.solveCalls ?? 0;
    family.providerCallCount += receipt.providerCallCount;
    family.retryCount += receipt.retryCount;
    family.unknownSolveCallReceipts += receipt.solveCalls === null ? 1 : 0;
    mergeCounts(family.tokens, receipt.tokens);
    family.tokenCount += receipt.tokenCount;
    family.cashUsd += receipt.cashUsd ?? 0;
    family.wallTimeMs += receipt.wallTimeMs ?? 0;
    family.unknownUsageReceipts += receipt.usageStatus === 'UNKNOWN-NOT-ZERO' ? 1 : 0;
    family.incompleteReceiptCount += receipt.completenessStatus === 'INCOMPLETE' ? 1 : 0;
    family.evaluationErrorCount += receipt.evaluationErrorCount;
    for (const model of receipt.models) family.modelIds.add(model);
  }
  for (const family of Object.values(families)) family.modelIds = [...family.modelIds].sort();
  return {
    version: 'world-spend.v3',
    receipts,
    errors,
    totals: {
      receiptCount: receipts.length,
      completeReceiptCount: receipts.filter(({ completenessStatus }) => completenessStatus === 'COMPLETE').length,
      incompleteReceiptCount: receipts.filter(({ completenessStatus }) => completenessStatus === 'INCOMPLETE').length,
      malformedCount: errors.filter((error) => error.code === 'malformed_json').length,
      unknownShapeCount: errors.filter((error) => error.code === 'unknown_shape').length,
      modelIds,
      solveCalls: knownSolveCalls,
      providerCallCount: receipts.reduce((sum, receipt) => sum + receipt.providerCallCount, 0),
      retryCount: receipts.reduce((sum, receipt) => sum + receipt.retryCount, 0),
      unknownSolveCallReceipts,
      tokens,
      tokenCount: receipts.reduce((sum, receipt) => sum + receipt.tokenCount, 0),
      cashUsd: receipts.reduce((sum, receipt) => sum + (receipt.cashUsd ?? 0), 0),
      unknownCashReceipts: receipts.filter(({ cashStatus }) => cashStatus !== 'counted').length,
      wallTimeMs: receipts.reduce((sum, receipt) => sum + (receipt.wallTimeMs ?? 0), 0),
      unknownWallTimeReceipts: receipts.filter(({ wallTimeStatus }) => wallTimeStatus !== 'measured').length,
      unknownUsageReceipts: receipts.filter((receipt) => receipt.usageStatus === 'UNKNOWN-NOT-ZERO').length,
      families,
    },
  };
}

export function formatHuman(report) {
  const lines = ['FILE\tFAMILY\tMODELS\tSOLVE CALLS\tPROVIDER CALLS\tTOKENS\tCASH USD\tWALL MS\tCOMPLETENESS'];
  for (const receipt of report.receipts) {
    lines.push(`${receipt.file}\t${receipt.family}\t${receipt.models.join(', ') || 'none seen'}\t${receipt.solveCalls ?? 'unknown'}\t${receipt.providerCallCount}\t${receipt.usageStatus === 'counted' || receipt.usageStatus === 'known-zero' ? receipt.tokenCount : 'UNKNOWN-NOT-ZERO'}\t${receipt.cashStatus === 'counted' ? receipt.cashUsd : 'UNKNOWN'}\t${receipt.wallTimeStatus === 'measured' ? receipt.wallTimeMs : 'UNKNOWN'}\t${receipt.completenessStatus}${receipt.missingFields.length ? ` (${receipt.missingFields.join(', ')})` : ''}`);
  }
  for (const error of report.errors) {
    lines.push(error.code === 'unknown_shape'
      ? `${error.file}\tunknown\tUNKNOWN SHAPE: unknown_shape`
      : `${error.file}\tMALFORMED JSON: ${error.error}`);
  }
  const total = report.totals;
  lines.push(`TOTAL\t${total.modelIds.join(', ') || 'none seen'}\t${total.solveCalls} counted + ${total.unknownSolveCallReceipts} receipts unknown\t${total.providerCallCount} provider calls (${total.retryCount} retries)\t${total.tokenCount} tokens counted + ${total.unknownUsageReceipts} receipts unknown\t$${total.cashUsd.toFixed(6)} + ${total.unknownCashReceipts} receipts unknown\t${total.wallTimeMs} ms + ${total.unknownWallTimeReceipts} receipts unknown\t${total.completeReceiptCount} COMPLETE + ${total.incompleteReceiptCount} INCOMPLETE`);
  return `${lines.join('\n')}\n`;
}

function receiptFamily(receipt) {
  if (!isObject(receipt)) return 'unknown';
  if (receipt.suite === 'world-close' && Array.isArray(receipt.cases)) return 'whole_close';
  if (isObject(receipt.spend) && Array.isArray(receipt.spend.providerUsage)
    && Array.isArray(receipt.evaluationErrors) && Object.hasOwn(receipt, 'initialRun')) return 'shrink';
  if (Object.hasOwn(receipt, 'sourceWorldId') && Object.hasOwn(receipt, 'siblingWorldId')
    && isObject(receipt.derivation) && Object.hasOwn(receipt, 'run')) return 'sibling';
  if (receipt.version === 'eaw.db-close-run.v1' || receipt.version === 'eaw.db-close-run.v2') return 'db_close_run';
  if (receipt.version === 'eaw.gate2b.c1-run.v1') return 'c1_run';
  if (isObject(receipt.receipt) && (receipt.receipt.version === 'eaw.db-close-receipt.v1' || receipt.receipt.version === 'eaw.db-close-receipt.v2')) return 'db_close_receipt';
  if (receipt.version === 'eaw.db-close-receipt.v1' || receipt.version === 'eaw.db-close-receipt.v2') return 'db_close_receipt';
  if (receipt.version === 'eaw.fresh-entity-diagnostic.v1') return 'fresh_entity_diagnostic';
  return 'unknown';
}

function usageSources(receipt, family) {
  if (family === 'whole_close') {
    const current = receipt.cases.flatMap((item) => {
      if (isObject(item?.actual?.modelUsage)) return [item.actual.modelUsage];
      return isObject(item?.modelUsage) ? [item.modelUsage] : [];
    });
    if (current.length) return current;
    if (isObject(receipt.modelUsage)) return [receipt.modelUsage];
    return Array.isArray(receipt.spend?.providerUsage) ? receipt.spend.providerUsage.filter(isObject) : [];
  }
  if (family === 'shrink') return receipt.spend.providerUsage.filter(isObject);
  if (family === 'sibling') return isObject(receipt.run?.modelUsage) ? [receipt.run.modelUsage] : [];
  if (family === 'db_close_run' || family === 'fresh_entity_diagnostic' || family === 'c1_run') return isObject(receipt.spend) ? [receipt.spend] : [];
  if (family === 'db_close_receipt') {
    const candidate = receipt.receipt ?? receipt;
    return isObject(candidate.spend) ? [candidate.spend] : [];
  }
  return [];
}

function findExplicitZeroSpend(receipt, family) {
  const source = family === 'db_close_receipt' ? (receipt.receipt?.spend ?? receipt.spend) : receipt.spend;
  if (!isObject(source)) return null;
  const zeroModelStatus = source.status === 'known_zero_model'
    || (family === 'fresh_entity_diagnostic' && source.status === 'known' && source.basis === 'deterministic_zero_model_diagnostic');
  const declared = zeroModelStatus
    && source.solveCalls === 0
    && (source.inputTokens ?? source.input_tokens) === 0
    && (source.outputTokens ?? source.output_tokens) === 0
    && source.modelSpendUsd === 0;
  return declared ? source : null;
}

function findSolveCalls(receipt, family, sources) {
  const values = [];
  walk(receipt, (key, value) => {
    if (key === 'solveCalls' && Number.isSafeInteger(value) && value >= 0) values.push(value);
  });
  if (values.length) return Math.max(...values);
  if (family === 'whole_close' && sources.length > 0) return receipt.cases.length;
  if (family === 'sibling' && sources.length > 0) return 1;
  return null;
}

function normalizeUsageCalls(source) {
  if (Array.isArray(source?.calls)) return source.calls.filter(isObject);
  const tokens = {};
  if (isObject(source)) collectTokens(source, tokens);
  return Object.keys(tokens).length > 0 ? [source] : [];
}

function summarizeCash(sources, explicitZero) {
  if (explicitZero) return { status: 'counted', usd: 0 };
  if (sources.length === 0) return { status: 'unknown', usd: null };
  let total = 0;
  for (const source of sources) {
    const cash = source.cash;
    const usd = cash?.usd ?? cash?.cash_usd ?? source.modelSpendUsd;
    const priceSource = cash?.price_source ?? source.pricingSource;
    if (!Number.isFinite(usd) || usd < 0 || (!isObject(priceSource) && typeof priceSource !== 'string')) {
      return { status: 'unknown', usd: null };
    }
    total += usd;
  }
  return { status: 'counted', usd: total };
}

function summarizeWall(sources, calls, explicitZero) {
  if (explicitZero && Number.isFinite(explicitZero.wallTimeMs) && explicitZero.wallTimeMs >= 0) {
    return { status: 'measured', ms: explicitZero.wallTimeMs };
  }
  if (calls.length > 0 && calls.every(({ wall_time_ms }) => Number.isFinite(wall_time_ms) && wall_time_ms >= 0)) {
    return { status: 'measured', ms: calls.reduce((sum, { wall_time_ms }) => sum + wall_time_ms, 0) };
  }
  const direct = sources.map((source) => source.wallTimeMs ?? source.wall_time_ms);
  if (direct.length > 0 && direct.every((value) => Number.isFinite(value) && value >= 0)) {
    return { status: 'measured', ms: direct.reduce((sum, value) => sum + value, 0) };
  }
  return { status: 'unknown', ms: null };
}

function summarizeDigests(sources) {
  const configuration = [];
  const artifacts = [];
  for (const source of sources) {
    const configurationDigest = source.configuration_digest ?? source.configurationDigest;
    if (typeof configurationDigest === 'string') configuration.push(configurationDigest);
    const sourceArtifacts = source.artifact_digests ?? source.artifactDigests;
    if (Array.isArray(sourceArtifacts)) artifacts.push(...sourceArtifacts);
  }
  return {
    configuration: [...new Set(configuration)].sort(),
    artifacts: [...new Set(artifacts)].sort(),
    configurationComplete: sources.length > 0 && sources.every((source) => SHA256.test(source.configuration_digest ?? source.configurationDigest ?? '')),
    artifactsComplete: sources.length > 0 && sources.every((source) => {
      const values = source.artifact_digests ?? source.artifactDigests;
      return Array.isArray(values) && values.length > 0 && values.every((value) => SHA256.test(value));
    }),
  };
}

function validCallField(fieldName, value) {
  if (['input_tokens', 'output_tokens', 'wall_time_ms', 'retry_index'].includes(fieldName)) return Number.isSafeInteger(value) && value >= 0;
  if (fieldName === 'http_status') return Number.isInteger(value) && value >= 100 && value <= 599;
  if (fieldName === 'request_digest') return typeof value === 'string' && SHA256.test(value);
  return typeof value === 'string' && value.trim() !== '';
}

function emptyFamilyTotals() {
  return { receiptCount: 0, modelIds: new Set(), solveCalls: 0, providerCallCount: 0, retryCount: 0,
    unknownSolveCallReceipts: 0, tokens: {}, tokenCount: 0, cashUsd: 0, wallTimeMs: 0,
    unknownUsageReceipts: 0, incompleteReceiptCount: 0, evaluationErrorCount: 0 };
}

export function writeReportExclusive(output, report) {
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}

function collectTokens(value, counts) {
  for (const [key, child] of Object.entries(value)) {
    if (TOKEN_KEYS.has(key) && Number.isSafeInteger(child) && child >= 0) counts[key] = (counts[key] ?? 0) + child;
    else if (isObject(child)) collectTokens(child, counts);
  }
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function canonicalTokenTotal(tokens) {
  const statedTotal = tokens.total_tokens ?? tokens.totalTokens;
  if (statedTotal !== undefined) return statedTotal;
  return (tokens.input_tokens ?? tokens.inputTokens ?? tokens.prompt_tokens ?? tokens.promptTokens ?? 0)
    + (tokens.output_tokens ?? tokens.outputTokens ?? tokens.completion_tokens ?? tokens.completionTokens ?? 0);
}

function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach((item) => walk(item, visit));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, value);
    walk(child, visit);
  }
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonemptyValue(token, prefix) {
  const value = token.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = readSpend(args.receipts);
  if (args.output) writeReportExclusive(args.output, report);
  if (args.print || !args.output) process.stdout.write(formatHuman(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
}
