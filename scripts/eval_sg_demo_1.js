#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';

import { canonicalJson } from '../server/donna/testSupport/sgDemo1Definition.js';
import {
  SG_DEMO_1_DEFAULT_PATHS,
  evaluateSgDemo1,
  loadSgDemo1Inputs,
} from '../server/donna/testSupport/sgDemo1Goldset.js';

const args = parseArgs(process.argv.slice(2));
try {
  const inputs = loadSgDemo1Inputs({
    book: args.book ?? SG_DEMO_1_DEFAULT_PATHS.book,
    sourceManifest: args.source_manifest ?? SG_DEMO_1_DEFAULT_PATHS.sourceManifest,
    evidenceReceipts: args.evidence_receipts ?? SG_DEMO_1_DEFAULT_PATHS.evidenceReceipts,
    evidenceDir: args.evidence_dir ?? SG_DEMO_1_DEFAULT_PATHS.evidenceDir,
  });
  const result = evaluateSgDemo1(inputs);
  process.stdout.write(`${canonicalJson(result.receipt)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${canonicalJson({
    schema_version: 'sg-demo-1.cli-error.v1',
    status: 'fail',
    error_code: 'SG_INPUT_UNREADABLE',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--book', '--source-manifest', '--evidence-receipts', '--evidence-dir'].includes(token)) {
      throw new Error(`unsupported argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    parsed[token.slice(2).replaceAll('-', '_')] = path.resolve(value);
    index += 1;
  }
  return parsed;
}
