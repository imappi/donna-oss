// Lockstep pins for the parse-document step split
// (docs/diagnostic-2026-07-04-parse-cron-504-saturation.md §4).
//
// The contract under test: the worker is ONE `parse-and-write` step
// (everything through the terminal parse write) followed by one
// `step.run` per post-parse leg. The legs used to be untimeboxed
// fire-once try/catch tails inside the single worker step — a 300s
// lambda kill took them silently, which was the §1 convergence-incident
// mechanism. These tests pin:
//
//  1. the leg PLAN (which legs run, in what order, under which gates)
//     for both worker paths;
//  2. that every planned leg is executed through `step.run` (own
//     invocation budget / retry on the Inngest path);
//  3. the split failure semantics — inline drain keeps the historical
//     per-leg soft-degrade (warn + continue, byte-identical to the
//     single-step worker), the Inngest path lets leg throws propagate
//     so retry exhaustion is VISIBLE in the dashboard;
//  4. the source-level lockstep: every post-parse leg writer is called
//     ONLY from the runner registry. A new leg writer call added inside
//     runParseAndWrite (outside a step) is the regression to forbid —
//     it would revive the silent fire-once tail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildPostParseLegPlan,
  runPostParseLegs,
  __test__POST_PARSE_LEG_RUNNERS
} from './parseDocument.js';

const withAutoAiCodingFlag = async (value, fn) => {
  const original = process.env.AUTO_AI_CODING_ENABLED;
  if (value === undefined) delete process.env.AUTO_AI_CODING_ENABLED;
  else process.env.AUTO_AI_CODING_ENABLED = value;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.AUTO_AI_CODING_ENABLED;
    else process.env.AUTO_AI_CODING_ENABLED = original;
  }
};

const headerPostParse = {
  path: 'header',
  client_id: 'client-1',
  document_type: 'receipt'
};

const statementPostParse = (overrides = {}) => ({
  path: 'statement',
  client_id: 'client-1',
  document_type: 'bank_statement',
  transactions_written: 12,
  detector_input: { bankName: 'dbs.pdf', currency: 'SGD', accountNumber: '', text: '' },
  ...overrides
});

const planNames = (postParse) => buildPostParseLegPlan(postParse).map((l) => l.name);

// ── 1. The leg plan ──────────────────────────────────────────────────

test('plan: header path does not re-run the client-wide reconciliation scan', () => {
  assert.deepEqual(planNames(headerPostParse), ['evidence-recode', 'owner-media-summary']);
});

test('plan: statement path with written transactions = all seven legs in order', async () => {
  await withAutoAiCodingFlag(undefined, () => {
    assert.deepEqual(planNames(statementPostParse()), [
      'evidence-recode',
      'jurisdiction-signal',
      'reconciliation-scan',
      'auto-categorize-matched',
      'auto-categorize-unmatched',
      'ai-coding',
      'owner-media-summary'
    ]);
  });
});

test('plan: statement path with zero written transactions = recode + jurisdiction only (unchanged gate)', () => {
  assert.deepEqual(planNames(statementPostParse({ transactions_written: 0 })), [
    'evidence-recode',
    'jurisdiction-signal',
    'owner-media-summary'
  ]);
});

test('plan: non-bank-statement type on the statement path skips the jurisdiction leg', () => {
  assert.deepEqual(
    planNames(statementPostParse({ document_type: 'payment_account_statement', transactions_written: 0 })),
    ['evidence-recode', 'owner-media-summary']
  );
});

test('plan: AUTO_AI_CODING_ENABLED=0 kill switch drops only the ai-coding leg', async () => {
  await withAutoAiCodingFlag('0', () => {
    assert.deepEqual(planNames(statementPostParse()), [
      'evidence-recode',
      'jurisdiction-signal',
      'reconciliation-scan',
      'auto-categorize-matched',
      'auto-categorize-unmatched',
      'owner-media-summary'
    ]);
  });
});

test('plan: no post_parse (skipped / duplicate_pending / failed / stale) = no legs', () => {
  assert.deepEqual(buildPostParseLegPlan(null), []);
  assert.deepEqual(buildPostParseLegPlan(undefined), []);
  assert.deepEqual(buildPostParseLegPlan({}), []);
});

test('plan ↔ runners: every planned leg has a runner, and no runner is orphaned', async () => {
  await withAutoAiCodingFlag(undefined, () => {
    const allPlanned = new Set([
      ...planNames(headerPostParse),
      ...planNames(statementPostParse())
    ]);
    for (const name of allPlanned) {
      assert.equal(
        typeof __test__POST_PARSE_LEG_RUNNERS[name],
        'function',
        `leg "${name}" is planned but has no runner`
      );
    }
    for (const name of Object.keys(__test__POST_PARSE_LEG_RUNNERS)) {
      assert.ok(allPlanned.has(name), `runner "${name}" is registered but never planned`);
    }
  });
});

test('plan: every leg carries the exact historical soft-degrade warn message', () => {
  const messages = Object.fromEntries(
    buildPostParseLegPlan(headerPostParse)
      .concat(buildPostParseLegPlan(statementPostParse()))
      .map((l) => [l.failMessage, l.name])
  );
  // The message strings are the drain path's observable behavior — the
  // stage-transition log lines the READING·1-OF-1 playbook greps for.
  assert.ok(messages['parse-document: evidence reply recode after header parse failed (soft-degrade)']);
  assert.ok(messages['parse-document: evidence reply recode after parse failed (soft-degrade)']);
  assert.ok(messages['parse-document: jurisdiction detection failed (soft-degrade)']);
  assert.ok(messages['parse-document: bank-statement reconciliation failed (soft-degrade)']);
  assert.ok(messages['parse-document: auto-categorize failed (soft-degrade)']);
  assert.ok(messages['parse-document: auto-categorize-unmatched failed (soft-degrade)']);
  assert.ok(messages['parse-document: auto AI coding failed (soft-degrade)']);
  assert.ok(messages['parse-document: owner media summary failed (soft-degrade)']);
});

// ── 2. Every leg runs inside its own step.run ────────────────────────

const recordingStep = (labels) => ({
  run: async (label, fn) => {
    labels.push(label);
    return fn();
  }
});

const stubRunners = (names, calls, { throwOn } = {}) =>
  Object.fromEntries(
    names.map((name) => [
      name,
      async (ctx) => {
        calls.push({ name, ctx });
        if (throwOn === name) throw new Error(`${name} exploded`);
        return { ran: true };
      }
    ])
  );

test('runPostParseLegs: each planned leg executes through step.run, in plan order, with the shared ctx', async () => {
  await withAutoAiCodingFlag(undefined, async () => {
    const postParse = statementPostParse();
    const expected = planNames(postParse);
    const labels = [];
    const calls = [];
    await runPostParseLegs({
      step: recordingStep(labels),
      inline: false,
      log: console,
      firmId: 'firm-1',
      documentId: 'doc-1',
      parseRunId: 'run-1',
      postParse,
      runners: stubRunners(expected, calls)
    });
    assert.deepEqual(labels, expected, 'every leg wrapped in a step.run, in plan order');
    assert.deepEqual(calls.map((c) => c.name), expected, 'every runner invoked exactly once');
    for (const { ctx } of calls) {
      assert.equal(ctx.firmId, 'firm-1');
      assert.equal(ctx.clientId, 'client-1');
      assert.equal(ctx.documentId, 'doc-1');
      assert.equal(ctx.parseRunId, 'run-1');
      assert.equal(ctx.postParse, postParse);
    }
  });
});

test('runPostParseLegs: a planned leg with no runner throws (a leg can never silently skip the step machinery)', async () => {
  await assert.rejects(
    () =>
      runPostParseLegs({
        step: recordingStep([]),
        inline: false,
        log: console,
        firmId: 'firm-1',
        documentId: 'doc-1',
        parseRunId: 'run-1',
        postParse: headerPostParse,
        runners: {}
      }),
    /no runner for post-parse leg "evidence-recode"/
  );
});

// ── 3. Split failure semantics ───────────────────────────────────────

test('inline path: a throwing leg soft-degrades with the exact historical warn message and later legs still run', async () => {
  const postParse = headerPostParse;
  const expected = planNames(postParse);
  const labels = [];
  const calls = [];
  const warns = [];
  await runPostParseLegs({
    step: recordingStep(labels),
    inline: true,
    log: { warn: (msg, meta) => warns.push({ msg, meta }) },
    firmId: 'firm-1',
    documentId: 'doc-1',
    parseRunId: 'run-1',
    postParse,
    runners: stubRunners(expected, calls, { throwOn: 'evidence-recode' })
  });
  assert.deepEqual(labels, expected, 'the failed leg does not stop the inline sequence');
  assert.equal(warns.length, 1);
  assert.equal(
    warns[0].msg,
    'parse-document: evidence reply recode after header parse failed (soft-degrade)'
  );
  assert.equal(warns[0].meta.documentId, 'doc-1');
  assert.match(warns[0].meta.error, /evidence-recode exploded/);
});

test('inline path: a throwing leg writes ONE durable typed failure receipt and the drain continues', async () => {
  const postParse = headerPostParse;
  const expected = planNames(postParse);
  const labels = [];
  const warns = [];
  const receipts = [];
  await runPostParseLegs({
    step: recordingStep(labels),
    inline: true,
    log: { warn: (msg, meta) => warns.push({ msg, meta }) },
    firmId: 'firm-1',
    documentId: 'doc-1',
    parseRunId: 'run-1',
    postParse,
    runners: stubRunners(expected, [], { throwOn: 'evidence-recode' }),
    recordLegFailure: async (receipt) => receipts.push(receipt)
  });
  assert.deepEqual(labels, expected, 'warn + continue drain semantics unchanged');
  assert.equal(warns.length, 1, 'the historical warn still fires');
  assert.equal(receipts.length, 1, 'exactly one receipt per failed leg');
  assert.deepEqual(receipts[0], {
    firmId: 'firm-1',
    clientId: 'client-1',
    documentId: 'doc-1',
    parseRunId: 'run-1',
    leg: 'evidence-recode',
    retrySafe: true,
    error: 'evidence-recode exploded'
  });
});

test('inline path: a receipt-write failure degrades to an error log — the drain still completes', async () => {
  const postParse = headerPostParse;
  const expected = planNames(postParse);
  const labels = [];
  const errors = [];
  await runPostParseLegs({
    step: recordingStep(labels),
    inline: true,
    log: {
      warn: () => {},
      error: (msg, meta) => errors.push({ msg, meta })
    },
    firmId: 'firm-1',
    documentId: 'doc-1',
    parseRunId: 'run-1',
    postParse,
    runners: stubRunners(expected, [], { throwOn: 'evidence-recode' }),
    recordLegFailure: async () => {
      throw new Error('audit insert refused');
    }
  });
  assert.deepEqual(labels, expected, 'a failed receipt write never stops the drain');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].msg, 'parse-document: post-parse leg failure receipt write failed');
  assert.equal(errors[0].meta.leg, 'evidence-recode');
  assert.match(errors[0].meta.error, /audit insert refused/);
});

test('plan: every leg declares its retry contract (retrySafe) — the failure receipt carries it typed', () => {
  const allLegs = buildPostParseLegPlan(headerPostParse).concat(buildPostParseLegPlan(statementPostParse()));
  for (const leg of allLegs) {
    assert.equal(leg.retrySafe, true, `leg "${leg.name}" must declare retrySafe (a new leg declares its own contract)`);
  }
});

test('Inngest path: a throwing leg PROPAGATES (visible failure) and later legs do not run in that invocation', async () => {
  const postParse = headerPostParse;
  const expected = planNames(postParse);
  const labels = [];
  const calls = [];
  await assert.rejects(
    () =>
      runPostParseLegs({
        step: recordingStep(labels),
        inline: false,
        log: { warn: () => assert.fail('Inngest path must not soft-degrade a leg failure') },
        firmId: 'firm-1',
        documentId: 'doc-1',
        parseRunId: 'run-1',
        postParse,
        runners: stubRunners(expected, calls, { throwOn: 'evidence-recode' }),
        recordLegFailure: () =>
          assert.fail('Inngest path must not write the drain failure receipt — its failure is loud already (retry + dashboard)')
      }),
    /evidence-recode exploded/
  );
  assert.deepEqual(labels, ['evidence-recode'], 'sequence stops at the failing leg (Inngest retries it alone)');
});

// ── 4. Source-level lockstep ─────────────────────────────────────────
// Every post-parse leg writer must be called ONLY from the runner
// registry: exactly one import occurrence + exactly one registry call
// site. A third occurrence means someone added a naked post-parse call
// inside runParseAndWrite (or anywhere outside a step) — the silent
// fire-once tail this split exists to forbid. (Keep the identifiers out
// of comments in parseDocument.js; this pin counts raw occurrences.)

const parseDocumentSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'parseDocument.js'),
  'utf8'
);

const LEG_WRITERS = [
  'resumeEvidenceRecodeAfterParseInDb',
  'recordJurisdictionSignalInDb',
  'runReconciliationForBankStatementInDb',
  'autoCategorizeMatchedTransactionsInDb',
  'autoCategorizeUnmatchedTransactionsInDb',
  'batchSuggestTransactionCodingInDb'
];

test('lockstep: each post-parse leg writer appears exactly twice in the worker source (import + registry)', () => {
  for (const writer of LEG_WRITERS) {
    const occurrences = parseDocumentSource.split(writer).length - 1;
    assert.equal(
      occurrences,
      2,
      `${writer} appears ${occurrences}× in parseDocument.js — expected exactly 2 (import + POST_PARSE_LEG_RUNNERS). ` +
        'A third occurrence is a post-parse call outside the step machinery: wire it as a leg in ' +
        'buildPostParseLegPlan + the runner registry instead.'
    );
  }
});

test('lockstep: the inline drain shim is marked __inline so legs keep drain soft-degrade semantics', () => {
  assert.match(parseDocumentSource, /__inline: true/, 'runParseInline must mark its step shim');
  assert.match(
    parseDocumentSource,
    /inline: step\?\.__inline === true/,
    'handleParseEvent must derive leg semantics from the shim marker'
  );
});
