#!/usr/bin/env node
// Reconciliation matcher eval runner — Slice D scoping pass.
//
// Runs the chosen matcher (weighted or LLM) against every fixture in
// data/evals/fixtures/reconciliation/ and emits a JSON metrics blob.
// Optionally diffs against a checked-in baseline and saves the new
// result as the next baseline.
//
// Usage:
//   node scripts/eval_reconciliation_matcher.js --mode=weighted --print
//   node scripts/eval_reconciliation_matcher.js --mode=llm --print
//   node scripts/eval_reconciliation_matcher.js --mode=weighted --save-baseline
//   node scripts/eval_reconciliation_matcher.js --mode=llm --filter=honeybee --print
//
// LLM mode requires ANTHROPIC_API_KEY. Weighted mode is offline and
// safe to run in CI on every push.
//
// See server/donna/evalHarness.js and docs/donna-llm-trust-strategy.md
// §3 Slice D for the harness contract.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  diffAgainstBaseline,
  formatSummary,
  loadBaseline,
  loadFixtures,
  runEval,
  saveBaseline
} from '../server/donna/evalHarness.js';
import {
  generateSalesInvoiceCandidates
} from '../server/donna/salesInvoiceReconciliation.js';
import {
  generateBillCandidates
} from '../server/donna/billReconciliation.js';
import {
  proposeMatches as proposeSalesInvoiceMatches
} from '../server/donna/salesInvoiceReconciliationLlm.js';
import {
  proposeMatches as proposeSupplierBillMatches
} from '../server/donna/supplierBillReconciliationLlm.js';

const SUITE = 'reconciliation';
const DEFAULT_AUTO_THRESHOLD = 0.85;

const parseArgs = (argv) => {
  const out = { mode: 'weighted', filter: null, saveBaseline: false, print: false, output: null };
  for (const token of argv) {
    if (token === '--save-baseline') out.saveBaseline = true;
    else if (token === '--print') out.print = true;
    else if (token.startsWith('--mode=')) out.mode = token.slice('--mode='.length);
    else if (token.startsWith('--filter=')) out.filter = token.slice('--filter='.length);
    else if (token.startsWith('--output=')) out.output = token.slice('--output='.length);
  }
  return out;
};

// AP fixtures carry document_type='supplier_bill' and money_out bank
// lines; AR fixtures carry sales_invoice/issued_receipt + money_in.
// The runner dispatches per fixture so a single reconciliation suite
// can hold both directions (option i from the Slice E handoff).
const isBillFixture = (fixture) =>
  fixture?.document?.document_type === 'supplier_bill';

// Map a fixture's candidate bank lines into the transaction shape the
// matchers expect, placing the amount on the correct side for the
// fixture's direction. Bill (AP) fixtures debit (money_out); invoice
// (AR) fixtures credit (money_in).
const mapBankLines = (fixture, { forBill }) =>
  (fixture.candidate_bank_lines || []).map((line) => ({
    id: line.id,
    money_in: forBill ? 0 : line.money_in,
    money_out: forBill ? line.money_out : 0,
    currency: line.currency,
    date: line.date,
    description: line.description,
    raw_description: line.raw_description,
    contact: line.contact || '',
    source_line: line.source_line || '',
    reconciliation_status: line.reconciliation_status || null,
    status: 'needs_review'
  }));

// ── Weighted runner — pure JS, no network. Reuses the production
// candidate generators (`generateSalesInvoiceCandidates` /
// `generateBillCandidates`). Maps `auto_match_passed` to status so the
// harness compares like for like with the LLM mode.
const weightedRunner = async (fixture) => {
  const forBill = isBillFixture(fixture);
  const transactions = mapBankLines(fixture, { forBill });
  const document = fixture.document;
  const generate = forBill ? generateBillCandidates : generateSalesInvoiceCandidates;
  const { candidates } = generate({
    transactions,
    document,
    existingMatches: []
  });
  if (!candidates.length) {
    return { proposals: [], unmatchable_reason: 'no_candidates' };
  }
  return {
    proposals: candidates.map((c) => ({
      bank_transaction_id: c.transaction.id,
      status: c.auto_match_passed ? 'auto_matched' : 'suggested',
      confidence: c.score,
      hops: c.match_reason?.hints || []
    })),
    unmatchable_reason: null
  };
};

// ── LLM runner — one Anthropic call per fixture. Threads through the
// per-direction `proposeMatches` helper (AR vs AP). Maps
// `confidence >= threshold` to 'auto_matched' so the harness compares
// like for like with the weighted mode.
const llmRunner = async (fixture) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot run LLM mode eval');
  }
  const model = process.env.RECONCILIATION_MATCHER_LLM_MODEL || 'claude-opus-4-8';
  const threshold = Number(process.env.RECONCILIATION_LLM_AUTO_THRESHOLD) || DEFAULT_AUTO_THRESHOLD;
  const forBill = isBillFixture(fixture);
  // The LLM sees the FULL candidate view — BOTH money directions and
  // reconciliation_status — so refund / already-settled / duplicate
  // fixtures are expressible. (The weighted runner above keeps the
  // direction-zeroed mapping its direction-specific scorer expects; this
  // is the trust-the-strong-LLM half: don't hide the SQL optimization
  // from the model.)
  const candidateBankLines = (fixture.candidate_bank_lines || []).map((line) => ({
    id: line.id,
    money_in: Number(line.money_in ?? 0),
    money_out: Number(line.money_out ?? 0),
    currency: line.currency,
    date: line.date,
    description: line.description,
    raw_description: line.raw_description,
    contact: line.contact || '',
    reconciliation_status: line.reconciliation_status ?? null
  }));
  const propose = forBill ? proposeSupplierBillMatches : proposeSalesInvoiceMatches;
  const result = await propose({
    document: fixture.document,
    candidateBankLines,
    firmContext: fixture.firm_context || null,
    apiKey,
    model
  });
  return {
    proposals: result.proposals.map((p) => ({
      bank_transaction_id: p.bank_transaction_id,
      status: p.confidence >= threshold ? 'auto_matched' : 'suggested',
      confidence: p.confidence,
      hops: p.hops
    })),
    unmatchable_reason: result.unmatchable_reason || null
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode !== 'weighted' && args.mode !== 'llm') {
    console.error(`Unknown mode: ${args.mode}. Use --mode=weighted or --mode=llm.`);
    process.exit(2);
  }

  const fixtures = loadFixtures(SUITE).filter((f) =>
    args.filter ? f.id.includes(args.filter) : true
  );

  if (!fixtures.length) {
    console.error(`No fixtures matched filter "${args.filter || ''}"`);
    process.exit(2);
  }

  const runner = args.mode === 'llm' ? llmRunner : weightedRunner;
  const model = args.mode === 'llm'
    ? (process.env.RECONCILIATION_MATCHER_LLM_MODEL || 'claude-opus-4-8')
    : null;

  const result = await runEval({ suite: SUITE, mode: args.mode, model, runner, fixtures });
  const baseline = loadBaseline(SUITE, args.mode);
  const diff = diffAgainstBaseline(result, baseline);

  if (args.output) {
    const dir = dirname(resolvePath(args.output));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  }

  if (args.saveBaseline) {
    const path = saveBaseline(result);
    console.error(`baseline saved → ${path}`);
  }

  if (args.print) {
    console.log(formatSummary(result, diff));
  } else if (!args.output && !args.saveBaseline) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  // Non-zero exit on regressions against the baseline so CI can gate
  // on the eval. New cases and improvements never fail the run.
  if (diff.hasBaseline && diff.regressions.length) {
    console.error(`Eval regressed against baseline: ${diff.regressions.join(', ')}`);
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
