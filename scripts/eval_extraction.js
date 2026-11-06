#!/usr/bin/env node
// Extraction eval runner — Slice D's runner for Slice B, re-pointed by
// RT-12 (docs/plan-2026-09-01-runtime-refactor-slices.md; decision D1).
//
// Runs the chosen extractor pipeline (unified or the per-type family) over a
// fixture suite and emits the same JSON metrics blob shape as the
// reconciliation runner; optionally diffs against a checked-in baseline and
// saves the new result as the next baseline.
//
// Suites:
//   --suite=extraction   data/evals/fixtures/extraction/*.json (the Slice-D
//                        synthetic set; default)
//   --suite=appliance    the RT-06 appliance fixture world
//                        (server/donna/fixtures/appliance/*.pdf, expected
//                        values from the world) — the set the RT-12 harness
//                        fixtures run on
//
// Modes:
//   --mode=unified        the provider-agnostic unified extractor (default
//                         since RT-12). Provider from --provider=openai|anthropic,
//                         else the key(s) present (anthropic preferred).
//   --mode=type-specific  the per-type OpenAI extractors (the one-release
//                         fall-through; deleted by RT-12's second PR).
//
// Transport:
//   live (default)        real provider calls — costs money; requires the key
//                         for the provider in use. Never safe in CI.
//   --recorded            the appliance suite served from the committed
//                         unified_extraction recordings through the
//                         recorded-providers stub (no network, no key needed)
//                         — the offline half of the RT-12 eval; the live half
//                         (Desert Rose) runs on the mini.
//
// Usage:
//   node scripts/eval_extraction.js --suite=appliance --mode=unified --recorded --provider=openai --print
//   node scripts/eval_extraction.js --suite=appliance --mode=unified --recorded --provider=anthropic --print
//   node scripts/eval_extraction.js --mode=unified --provider=openai --print          # live, Slice-D set
//   node scripts/eval_extraction.js --mode=type-specific --save-baseline
//
// The harness's pure-JS pieces (loadFixtures, scoreFixtureExtraction,
// aggregateMetrics) are covered by server/donna/evalHarness.test.js.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  diffAgainstBaseline,
  formatSummary,
  loadBaseline,
  loadFixtures,
  runEval,
  saveBaseline,
  scoreFixtureExtraction
} from '../server/donna/evalHarness.js';
import { extractReceiptFromBase64 } from '../server/donna/receipt.js';
import { extractSupplierBillFromBase64 } from '../server/donna/supplierBill.js';
import { extractSalesInvoiceFromBase64 } from '../server/donna/salesInvoice.js';
import { extractPayoutStatementFromBase64 } from '../server/donna/payoutStatement.js';
import {
  extractUnified,
  resolveUnifiedProvider,
  UNIFIED_EXTRACTOR_PROMPT_VERSION
} from '../server/donna/unifiedExtractor.js';
import { APPLIANCE_FIXTURES, loadApplianceFixture } from '../server/donna/fixtures/appliance/index.js';
import { installRecordedProviders } from '../server/donna/testSupport/recordedProviders.js';

const parseArgs = (argv) => {
  const out = { mode: 'unified', suite: 'extraction', provider: null, recorded: false, filter: null, saveBaseline: false, print: false, output: null };
  for (const token of argv) {
    if (token === '--save-baseline') out.saveBaseline = true;
    else if (token === '--print') out.print = true;
    else if (token === '--recorded') out.recorded = true;
    else if (token.startsWith('--mode=')) out.mode = token.slice('--mode='.length);
    else if (token.startsWith('--suite=')) out.suite = token.slice('--suite='.length);
    else if (token.startsWith('--provider=')) out.provider = token.slice('--provider='.length);
    else if (token.startsWith('--filter=')) out.filter = token.slice('--filter='.length);
    else if (token.startsWith('--output=')) out.output = token.slice('--output='.length);
  }
  return out;
};

// ── the appliance suite as eval fixtures ────────────────────────────────
// The world is the oracle: each fixture's `expected` becomes the scorer's
// gold (document_type, the header columns the writer lands, line_count).
// The recording that answers each fixture per provider is named here so the
// recorded transport can script the lane in fixture order.
const APPLIANCE_RECORDINGS = Object.freeze({
  supplier_bill_discount: { anthropic: 'unified_extraction/ochre-discount-line', openai: 'unified_extraction/ochre-discount-line-openai', per_type: 'supplier_bill_extraction/ochre-discount-line' },
  payout_statement: { anthropic: 'unified_extraction/paylink-PO-88121', per_type: 'payout_statement_extraction/paylink-PO-88121' },
  payout_statement_nonfooting: { anthropic: 'unified_extraction/northgate-nonfooting', per_type: 'payout_statement_extraction/northgate-nonfooting' },
  deposit_slip: { anthropic: 'unified_extraction/barclays-deposit-slip-DS-4471', per_type: 'payout_statement_extraction/barclays-deposit-slip-DS-4471' },
  receipt_screwfix: { anthropic: 'unified_extraction/screwfix-receipt', per_type: 'receipt_extraction/screwfix' }
});
const PER_TYPE_LANE = Object.freeze({
  supplier_bill: 'supplier_bill_extraction',
  receipt: 'receipt_extraction',
  sales_invoice: 'sales_invoice_extraction',
  issued_receipt: 'sales_invoice_extraction',
  payout_statement: 'payout_statement_extraction',
  deposit_slip: 'payout_statement_extraction'
});

const APPLIANCE_CLIENT_IDENTITY = Object.freeze({
  display_name: 'Kestrel Print Studio Ltd',
  legal_names: ['Kestrel Print Studio Ltd']
});

export const applianceFixturesAsEvalFixtures = () => Object.entries(APPLIANCE_FIXTURES)
  // Bank statements have their own lane (not this eval's).
  .filter(([, spec]) => spec.documentType !== 'bank_statement')
  .map(([name, spec]) => {
    const fixture = loadApplianceFixture(name);
    const e = spec.expected;
    const expectedType = e.document_type || spec.documentType;
    const header = {};
    if (e.vendor_name) header.vendor_name = e.vendor_name;
    if (e.counterparty_name) header.vendor_name = e.counterparty_name; // the payout family lands the provider on vendor_name
    if (e.reference_number) header.reference_number = e.reference_number;
    if (e.document_date) header.document_date = e.document_date;
    if (e.currency) header.currency = e.currency;
    if (e.total_amount != null) header.total_amount = e.total_amount;
    if (e.net_amount != null) header.total_amount = e.net_amount;
    return {
      id: `appliance-${name}`,
      client: 'kestrel',
      title: `${name} (${spec.file})`,
      tags: ['appliance', expectedType],
      upload_time_document_type: spec.documentType,
      client_identity: APPLIANCE_CLIENT_IDENTITY,
      document_input: {
        filename: spec.file,
        mimeType: spec.mimeType,
        base64_synthetic_text_pdf: fixture.bytes.toString('base64')
      },
      expected: {
        document_type: expectedType,
        header,
        line_count: e.line_count,
        counterparty_name: e.vendor_name || e.counterparty_name || undefined
      },
      recordings: APPLIANCE_RECORDINGS[name] || {}
    };
  });

// ── runners ───────────────────────────────────────────────────────────
const PER_TYPE_DISPATCH = {
  sales_invoice: { type: 'sales_invoice', extract: extractSalesInvoiceFromBase64 },
  issued_receipt: { type: 'issued_receipt', extract: extractSalesInvoiceFromBase64 },
  supplier_bill: { type: 'supplier_bill', extract: extractSupplierBillFromBase64 },
  receipt: { type: 'receipt', extract: extractReceiptFromBase64 },
  payout_statement: { type: 'payout_statement', extract: (args) => extractPayoutStatementFromBase64({ ...args, documentType: 'payout_statement' }) },
  deposit_slip: { type: 'deposit_slip', extract: (args) => extractPayoutStatementFromBase64({ ...args, documentType: 'deposit_slip' }) }
};

// The per-type extractors compute counterparty direction on `summary`, not
// the `header` the scorer reads; surface it so the eval scores what the
// extractor produced — including its FORCED direction on a misclassified
// document (the Failure-A signal this mode keeps red).
export const COUNTERPARTY_ROLE_BY_TYPE = Object.freeze({
  sales_invoice: 'customer',
  issued_receipt: 'customer',
  supplier_bill: 'vendor',
  receipt: 'vendor',
  payout_statement: 'processor',
  deposit_slip: 'bank'
});

export const buildTypeSpecificHeader = (dispatchType, result) => {
  const header = { ...(result?.header || {}) };
  if (header.counterparty_role == null) {
    header.counterparty_role =
      result?.summary?.counterparty_role ?? COUNTERPARTY_ROLE_BY_TYPE[dispatchType] ?? null;
  }
  return header;
};

// The per-type path does NOT re-classify: document_type is the extractor's
// nominal type (the upload-time type, or the router's on the product). A
// misclassified upload stays red under this mode — that is the bug the
// unified extractor closes.
const typeSpecificRunner = async (fixture) => {
  const dispatch = PER_TYPE_DISPATCH[fixture.upload_time_document_type];
  if (!dispatch) {
    return {
      document_type: fixture.upload_time_document_type || null,
      header: {},
      line_count: 0,
      failure: { code: 'unsupported_upload_type', reason: fixture.upload_time_document_type }
    };
  }
  const input = fixture.document_input || {};
  const result = await dispatch.extract({
    base64: input.base64_synthetic_text_pdf,
    filename: input.filename || `${fixture.id}.pdf`,
    mimeType: input.mimeType || 'application/pdf',
    dateFormatHint: '',
    clientIdentity: fixture.client_identity || null
  });
  if (result?.kind === 'failed') {
    return {
      document_type: dispatch.type,
      header: {},
      line_count: 0,
      failure: { code: result.code || 'extraction_failed', reason: result.reason || null }
    };
  }
  return {
    document_type: dispatch.type,
    header: buildTypeSpecificHeader(dispatch.type, result),
    line_count: Array.isArray(result?.lines) ? result.lines.length : 0,
    summary: result?.summary || null,
    model: result?.model || null
  };
};

// One unified call per fixture: classifies AND extracts; document_type is
// the MODEL's, so a misclassified upload self-corrects. The routed type
// rides as the prompt hint exactly as the worker sends it.
const unifiedRunner = ({ provider }) => async (fixture) => {
  const input = fixture.document_input || {};
  const result = await extractUnified({
    base64: input.base64_synthetic_text_pdf,
    filename: input.filename || `${fixture.id}.pdf`,
    mimeType: input.mimeType || 'application/pdf',
    documentType: fixture.upload_time_document_type || null,
    documentId: fixture.id,
    dateFormatHint: '',
    clientIdentity: fixture.client_identity || null,
    provider
  });
  if (result?.kind !== 'completed_header') {
    return {
      document_type: result?.partial_header?.document_type || null,
      header: result?.partial_header?.header || {},
      line_count: 0,
      failure: { code: result?.code || 'extraction_failed', reason: result?.reason || null },
      provider: result?.provider || null,
      model: result?.model || null
    };
  }
  return {
    document_type: result.document_type,
    header: { ...(result.header || {}), counterparty_role: result.summary?.counterparty_role ?? null },
    line_count: Array.isArray(result.lines) ? result.lines.length : 0,
    summary: result.summary || null,
    provider: result.provider,
    model: result.model,
    model_source: result.model_source
  };
};

// ── recorded transport ────────────────────────────────────────────────
// Scripts each appliance fixture's recording on its lane, in fixture order
// (the runner is sequential, so order is the join). The stub refuses any
// unscripted call with a 418 — a fixture without a recording for the chosen
// provider scores as a failure, never as a network call.
const scriptRecordings = ({ providers, fixtures, mode, provider }) => {
  const scripted = [];
  const skipped = [];
  for (const fixture of fixtures) {
    const key = mode === 'unified' ? provider : 'per_type';
    const recording = fixture.recordings?.[key];
    // The per-type family cannot classify: an upload typed `unknown` has no
    // lane to script (on the product the router types it first).
    const lane = mode === 'unified' ? 'unified_extraction' : PER_TYPE_LANE[fixture.upload_time_document_type];
    if (!recording || !lane) { skipped.push({ id: fixture.id, reason: !recording ? `no ${key} recording` : 'per-type cannot read an unknown upload' }); continue; }
    providers.script(lane, [recording]);
    scripted.push(fixture);
  }
  return { scripted, skipped };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode !== 'type-specific' && args.mode !== 'unified') {
    console.error(`Unknown mode: ${args.mode}. Use --mode=unified or --mode=type-specific.`);
    process.exit(2);
  }
  if (args.suite !== 'extraction' && args.suite !== 'appliance') {
    console.error(`Unknown suite: ${args.suite}. Use --suite=extraction or --suite=appliance.`);
    process.exit(2);
  }
  if (args.recorded && args.suite !== 'appliance') {
    console.error('--recorded serves the appliance suite only (the committed recordings answer those fixtures).');
    process.exit(2);
  }

  const fixtures = (args.suite === 'appliance' ? applianceFixturesAsEvalFixtures() : loadFixtures('extraction'))
    .filter((f) => (args.filter ? f.id.includes(args.filter) : true));
  if (!fixtures.length) {
    console.error(`No fixtures matched filter "${args.filter || ''}"`);
    process.exit(2);
  }

  let providers = null;
  let fixturesToRun = fixtures;
  if (args.recorded) {
    // Presence-only keys so the provider resolves; the stub answers every call.
    if (args.mode === 'unified') {
      const provider = args.provider || 'anthropic';
      process.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'] ||= 'recorded-replay-key';
      args.provider = provider;
    } else {
      process.env.OPENAI_API_KEY ||= 'recorded-replay-key';
    }
    providers = installRecordedProviders();
    const { scripted, skipped } = scriptRecordings({ providers, fixtures, mode: args.mode, provider: args.provider });
    for (const entry of skipped) console.error(`skipped ${entry.id}: ${entry.reason} (a coverage gap, not a score)`);
    fixturesToRun = scripted;
    if (!fixturesToRun.length) {
      console.error('nothing to run: no fixture has a recording for this mode/provider');
      process.exit(2);
    }
  }

  let model;
  let runner;
  if (args.mode === 'unified') {
    const resolved = resolveUnifiedProvider({ provider: args.provider });
    if (!resolved.ok) {
      console.error(`unified mode cannot run: ${resolved.reason} (set OPENAI_API_KEY or ANTHROPIC_API_KEY, or --provider with its key)`);
      process.exit(2);
    }
    // The run-level REQUESTED id, for the metrics blob; the authoritative id
    // per case is the RESPONSE-named one the runner records on each result.
    model = resolved.model;
    runner = unifiedRunner({ provider: resolved.provider });
    console.error(`unified extractor on ${resolved.provider} (${resolved.source.provider}) · model ${resolved.model} (${resolved.source.model}) · prompt ${UNIFIED_EXTRACTOR_PROMPT_VERSION} · ${args.recorded ? 'recorded' : 'LIVE'}`);
  } else {
    model = process.env.OPENAI_MODEL || 'gpt-5.4';
    runner = typeSpecificRunner;
  }

  const result = await runEval({
    suite: args.suite === 'appliance' ? 'extraction-appliance' : 'extraction',
    mode: args.mode === 'unified' ? `unified-${args.provider || resolveUnifiedProvider({}).provider}${args.recorded ? '-recorded' : ''}` : args.mode,
    model,
    runner,
    scorer: scoreFixtureExtraction,
    fixtures: fixturesToRun
  });
  if (providers) {
    result.recorded = {
      calls: providers.calls.map(({ lane, status, model_requested, model_served, recording }) => ({ lane, status, model_requested, model_served, recording })),
      unscripted: providers.unscripted.map(({ lane }) => lane)
    };
    providers.restore();
  }
  const baseline = loadBaseline(result.suite, result.mode);
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
  if (diff.hasBaseline && diff.regressions.length) {
    console.error(`Eval regressed against baseline: ${diff.regressions.join(', ')}`);
    process.exit(1);
  }
};

// Only run the eval when executed directly — importing this module (to
// unit-test the pure helpers) must NOT kick off a live, key-dependent run.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
