#!/usr/bin/env node
//
// Descent ladder Q6b — run the bank-line DISPOSITION gold set against a
// candidate model on the openai_compatible rung
// (docs/design-donna-qwen-descent-ladder.md §5.1/§5.2). One half of the
// Q6a pilot lane's promotion gate; the other half is the live gap table
// (scripts/run_lane_gate.js --lane bank_line_disposition reads both).
//
// Never CI — one real call per fixture against the configured compatible
// endpoint. The replay is the EXACT deciding observation: the lane's own
// per-direction system-prompt builders + user-prompt builder, verbatim,
// NO schema suffix (the deciding prompt already demands bare JSON) — the
// same transport shape bankLineDispositionChallenger.js uses in
// production, so a gold run and a shadow run score the same candidate the
// same way. The one deliberate divergence: NO materiality ceiling in the
// scoring replay (the deterministic Keep layer runs identically on any
// candidate and must not do the fixtures' work — see the gold set's
// header). A non-JSON reply scores as a failed schema MUST — that IS rung
// evidence, never a retry-until-parse.
//
// The model id in the report comes from the provider RESPONSE (llmCall
// rail 5 — the model-id-is-part-of-the-receipt); a run whose responses
// don't prove the model id says so in `model_source`.
//
// USAGE:
//   OPENAI_COMPATIBLE_BASE_URL=… OPENAI_COMPATIBLE_API_KEY=… \
//   OPENAI_COMPATIBLE_MODEL=… node scripts/run_bank_line_disposition_goldset.js
//     [--only mo_recurring_saas_github,mi_stripe_payout_material]  # subset
//     [--out bank-line-disposition-goldset-report.json]            # report path
//
// Exit code: 0 when every threshold is met (zero MUST regressions
// included), 1 otherwise or on a runner error.

import { writeFileSync } from 'node:fs';

import { llmCall } from '../server/donna/llmCall.js';
import { resolveOpenAiCompatibleEndpoint, shapeOpenAiCompatibleRequest } from '../server/donna/providerEndpoints.js';
import {
  buildBankLineDispositionUserPrompt,
  normalizeDirection,
  __buildMoneyOutSystemPrompt,
  __buildMoneyInSystemPrompt
} from '../server/donna/bankLineDispositionLlm.js';
import {
  BANK_LINE_DISPOSITION_GOLD_FIXTURES,
  BANK_LINE_DISPOSITION_GOLD_SET_VERSION,
  BANK_LINE_DISPOSITION_GOLD_THRESHOLDS,
  GOLD_FIXTURE_DATE,
  bankLineDispositionGoldSetLintErrors,
  meetsBankLineDispositionGoldThresholds,
  scoreBankLineDispositionGoldFixture,
  summarizeBankLineDispositionGoldRun
} from '../server/donna/bankLineDispositionGoldSet.js';

const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { only: null, out: 'bank-line-disposition-goldset-report.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') { out.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1; }
  }
  return out;
};

const log = (...args) => console.log('[bank-line-disposition-goldset]', ...args);

// The fixture → the exact deciding observation. Mirrors what the sweep
// hands the prompt builders: a transaction row (per-direction amount
// column, fixed replay date) + the firm context (recurrence count;
// jurisdiction rides clientIdentity — no names, so no firm-anchor block,
// exactly like a fresh client with no identity fact on file).
const observationFor = (fixture) => {
  const direction = normalizeDirection(fixture.input.direction);
  const transaction = {
    id: fixture.id,
    money_in: direction === 'money_in' ? fixture.input.amount : 0,
    money_out: direction === 'money_out' ? fixture.input.amount : 0,
    currency: fixture.input.currency,
    transaction_date: GOLD_FIXTURE_DATE,
    description: fixture.input.description,
    raw_description: fixture.input.raw_description || ''
  };
  const firmContext = {
    clientIdentity: fixture.input.jurisdiction ? { jurisdiction: fixture.input.jurisdiction } : null,
    knownCounterparties: null,
    recurrenceCount: fixture.input.recurrence_count
  };
  const system = (direction === 'money_in' ? __buildMoneyInSystemPrompt : __buildMoneyOutSystemPrompt)(
    firmContext.clientIdentity?.jurisdiction ?? null
  );
  const user = buildBankLineDispositionUserPrompt({ transaction, firmContext, clientAnswer: null, direction });
  return { direction, system, user };
};

const main = async () => {
  const opts = parseArgv();
  const lint = bankLineDispositionGoldSetLintErrors();
  if (lint.length) {
    console.error('[bank-line-disposition-goldset] fixture lint failed:', lint);
    process.exit(1);
  }
  const fixtures = opts.only
    ? BANK_LINE_DISPOSITION_GOLD_FIXTURES.filter((f) => opts.only.includes(f.id))
    : BANK_LINE_DISPOSITION_GOLD_FIXTURES;
  if (!fixtures.length) {
    console.error('[bank-line-disposition-goldset] no fixtures selected');
    process.exit(1);
  }

  // Same fail-closed posture as the challenger wiring: no endpoint or no
  // candidate model id ⇒ refuse before the first call.
  const endpoint = resolveOpenAiCompatibleEndpoint({});
  const requestedModel = String(process.env.OPENAI_COMPATIBLE_MODEL || '').trim();
  if (!requestedModel) {
    console.error('[bank-line-disposition-goldset] OPENAI_COMPATIBLE_MODEL is not set — the candidate model id is required');
    process.exit(1);
  }
  log(`gold_set=${BANK_LINE_DISPOSITION_GOLD_SET_VERSION} fixtures=${fixtures.length} candidate=${requestedModel}`);

  const scored = [];
  const details = [];
  const responseModels = new Set();
  const responseSources = new Set();

  for (const fixture of fixtures) {
    const { system, user } = observationFor(fixture);
    let text = null;
    let callError = null;
    try {
      const { result, telemetry } = await llmCall({
        provider: 'openai_compatible',
        url: endpoint.url,
        headers: endpoint.headers,
        body: shapeOpenAiCompatibleRequest({
          model: requestedModel,
          system,
          messages: [{ role: 'user', content: user }]
        }),
        sections: { system, context: user },
        execution: { root: { type: 'bank_line_disposition_goldset', id: fixture.id } },
        promptVersion: null,
        parseResponse: (payload) => payload?.choices?.[0]?.message?.content ?? ''
      });
      if (telemetry?.model) responseModels.add(telemetry.model);
      if (telemetry?.model_source) responseSources.add(telemetry.model_source);
      text = typeof result === 'string' ? result : '';
    } catch (error) {
      callError = String(error?.message || error).slice(0, 300);
      text = '';
    }
    const score = scoreBankLineDispositionGoldFixture({ text, fixture });
    scored.push(score);
    details.push({ fixture_id: fixture.id, score, text, call_error: callError });
    const failed = Object.entries(score.checks).filter(([, c]) => !c.pass).map(([name]) => name);
    log(`${score.pass ? 'PASS' : score.must_pass ? 'soft' : 'FAIL'} ${fixture.id}`
      + (failed.length ? ` failed=[${failed.join(',')}]` : '')
      + (callError ? ` call_error=${callError}` : ''));
  }

  const summary = summarizeBankLineDispositionGoldRun(scored);
  const gate = meetsBankLineDispositionGoldThresholds(summary);
  const report = {
    ran_at: new Date().toISOString(),
    lane: 'bank_line_disposition',
    gold_set_version: BANK_LINE_DISPOSITION_GOLD_SET_VERSION,
    requested_model: requestedModel,
    // The receipt-grade identity: what the provider RESPONSES said.
    response_models: [...responseModels].sort(),
    model_source: [...responseSources].sort(),
    thresholds: BANK_LINE_DISPOSITION_GOLD_THRESHOLDS,
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
  console.error('[bank-line-disposition-goldset] FAILED', err);
  process.exit(1);
});
