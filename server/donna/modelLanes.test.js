import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve as resolvePath } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LANE_KINDS, MODEL_LANES, getLane, laneForModule, laneModelFlagKey } from './modelLanes.js';
import { ENDPOINT_CLASSES, providerUrlLintPattern } from './providerEndpoints.js';
import {
  UNIFIED_EXTRACTOR_DEFAULT_MODELS,
  UNIFIED_EXTRACTOR_PROMPT_VERSION,
  UNIFIED_EXTRACTOR_PROVIDERS
} from './unifiedExtractor.js';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── the census: every provider-calling module, direct or envelope ───────
// Same walk as llmCall.test.js's ratchet, but WIDER on purpose: the ratchet
// hunts direct callers (URL without envelope); the lane inventory must also
// claim envelope adopters — a lane is a lane however its transport is wired.
const walkJsFiles = (dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, acc);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
};

// The seam's own modules name hosts (that is their job) and the envelope
// names the call helper; neither IS a lane.
const CENSUS_EXEMPT = new Set([
  'server/donna/llmCall.js',
  'server/donna/providerEndpoints.js',
  'server/donna/modelLanes.js'
]);

const providerCallingModules = () => {
  const pattern = providerUrlLintPattern();
  return walkJsFiles(resolvePath(repoRoot, 'server'))
    .map((file) => ({ rel: relative(repoRoot, file).split('\\').join('/'), source: readFileSync(file, 'utf8') }))
    .filter(({ rel, source }) =>
      !CENSUS_EXEMPT.has(rel)
      && (pattern.test(source) || source.includes('llmCall(')))
    .map(({ rel }) => rel)
    .sort();
};

await test('every provider-calling module is claimed by exactly one lane, and every lane module calls a provider', () => {
  const census = providerCallingModules();
  const claimed = MODEL_LANES.flatMap((entry) => entry.modules);

  const claimedSet = new Set(claimed);
  assert.equal(claimedSet.size, claimed.length, 'a module is claimed by two lanes — the registry double-counts it');

  const unclaimed = census.filter((rel) => !claimedSet.has(rel));
  assert.deepEqual(
    unclaimed,
    [],
    'these modules call a provider but no lane claims them — add them to a lane in modelLanes.js '
      + '(the inventory is the ladder\'s coordinate system; an unlisted call site is invisible to it)'
  );

  const stale = claimed.filter((rel) => !census.includes(rel));
  assert.deepEqual(
    stale,
    [],
    'these lane modules no longer call a provider — remove them from their lane'
  );
});

// ── lane shape ──────────────────────────────────────────────────────────
await test('lane records are well-formed, unique, and frozen', () => {
  const ids = new Set();
  for (const entry of MODEL_LANES) {
    assert.match(entry.id, /^[a-z][a-z0-9_]*$/, `${entry.id}: lane ids are snake_case`);
    assert.ok(!ids.has(entry.id), `${entry.id}: duplicate lane id`);
    ids.add(entry.id);
    assert.ok(entry.title && typeof entry.title === 'string');
    assert.ok(LANE_KINDS.includes(entry.kind), `${entry.id}: unknown kind ${entry.kind}`);
    assert.ok(ENDPOINT_CLASSES.includes(entry.endpointClass), `${entry.id}: unknown endpoint class ${entry.endpointClass}`);
    assert.ok(Array.isArray(entry.modules) && entry.modules.length > 0, `${entry.id}: a lane without modules is not a lane`);
    for (const modulePath of entry.modules) {
      assert.ok(existsSync(resolvePath(repoRoot, modulePath)), `${entry.id}: ${modulePath} does not exist`);
    }
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.modules) && Object.isFrozen(entry.challenger));
  }
  assert.ok(Object.isFrozen(MODEL_LANES));
});

// ── the eligibility ratchet: lanes flip one at a time, each named here ──
const CHALLENGER_ELIGIBLE_LANES = [
  'jev_reconciliation', // bounded local reverse shadow, never accounting authority
  // (bank_line_classification — the Q4 pilot of 2026-08-12 — was retired in RT-14, 2026-09-02, with its env-dark sweep.)
  'bank_line_disposition', // Q6a re-hook 2026-08-13: the LIVE bare-line decider (cron + loops terminal drain)
  'reconciliation_reasoning' // Q7 2026-08-16: the Honeybee lab seat — Opus reverse-shadows the seated rung (reconciliationReasoningChallenger.js)
];

await test('challenger eligibility is exactly the named set — a lane flips only in its own wiring commit', () => {
  const eligible = MODEL_LANES.filter((entry) => entry.challenger.eligible).map((entry) => entry.id).sort();
  assert.deepEqual(eligible, [...CHALLENGER_ELIGIBLE_LANES].sort(),
    'an eligibility flip must extend CHALLENGER_ELIGIBLE_LANES in the same commit as the lane\'s wiring');
  for (const entry of MODEL_LANES) {
    if (entry.challenger.eligible) {
      const fraction = entry.challenger.sampling?.fraction;
      assert.ok(Number.isFinite(fraction) && fraction > 0 && fraction <= 1,
        `${entry.id}: an eligible lane carries a sampling fraction in (0, 1]`);
    } else {
      assert.equal(entry.challenger.sampling, undefined,
        `${entry.id}: an ineligible lane carries no sampling config`);
    }
  }
});

// ── the model-policy feed ratchet (Q6): lanes become governed one at a
// time, each named here in the same commit as its governance ──────────
const FEED_GOVERNED_LANES = {
  jev_reconciliation: ['jev-1.13.0'], // Kari's all-desktop approval, 2026-09-20.
  // Q7 (Kari's dated model-lab call, 2026-08-16): the load-bearing
  // reconciliation lane joins the feed for the Honeybee lab experiment —
  // the cloud dense 27B is experiment-seatable; Opus reverse-shadows.
  // Product-wide promotion still requires the signed verdict.
  reconciliation_reasoning: ['claude-opus-4-8', 'qwen/qwen3.8-27b'],
  // Q9 (Kari's dated sole-model lab call, 2026-08-16): the coding lane
  // joins the feed — the cloud dense 27B is experiment-seatable as the
  // coding decider; the strong default holds absent a policy row.
  // Product-wide promotion still requires the signed verdict.
  transaction_coding: ['gpt-5.4', 'qwen/qwen3.8-27b'],
  // RT-12 (decision D1, 2026-09-02): THE load-bearing extraction call is
  // provider-agnostic — the qualified set is the two providers' strong
  // defaults (value-synced with UNIFIED_EXTRACTOR_DEFAULT_MODELS below).
  unified_extraction: ['claude-opus-4-8', 'gpt-5.4'],
  // Q6a — the core's deciding default (value-synced below). Q6c (Kari's
  // dated model-lab call, 2026-08-16): the §9.5 staged candidate joins for
  // the EXPERIMENT basis — policy-selectable on a lab book, receipted;
  // product-wide promotion still requires the signed gate verdict.
  // 2026-08-16 follow-up, corrected same day: 35B-A3B is the HOSTED
  // small-MoE comparison rung, NOT a 27B-class substitute; the 27B-class
  // rung is the dense local artifact Qwen3.8-27B-UD-Q4_K_XL (llama-server
  // --alias over the compatible endpoint), experiment-admitted only.
  // 2026-08-16 all-entities lab call: + the cloud dense 27B id (never
  // aliased with the local Q4_K_XL artifact id).
  bank_line_disposition: ['claude-opus-4-8', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.8-27B-UD-Q4_K_XL', 'qwen/qwen3.8-27b']
};

await test('the model-policy feed governs exactly the named lanes; every other lane stays null (ungoverned ≠ empty)', () => {
  for (const entry of MODEL_LANES) {
    assert.equal(entry.decidingModel, null,
      `${entry.id}: the module's own default governs until the lane resolves through the seam; `
      + 'a non-null value here is a second config source that can drift');
    const governed = FEED_GOVERNED_LANES[entry.id];
    if (governed) {
      assert.ok(Array.isArray(entry.qualified) && Object.isFrozen(entry.qualified),
        `${entry.id}: a governed lane carries a frozen qualified list`);
      assert.deepEqual([...entry.qualified].sort(), [...governed].sort(),
        `${entry.id}: extending a qualified set is a dated change riding a promotion verdict — extend FEED_GOVERNED_LANES in the same commit`);
      assert.ok(entry.qualified.every((model) => typeof model === 'string' && model.trim()),
        `${entry.id}: qualified entries are non-empty model ids`);
    } else {
      assert.equal(entry.qualified, null,
        `${entry.id}: null = not yet governed by the model-policy feed; [] would claim a feed exists and nothing qualified`);
    }
  }
});

await test('governed lanes\' qualified sets stay value-synced with their deciding modules\' defaults', () => {
  // The feed names the ALLOWED set; the module still picks the runtime
  // model until seam adoption. If a deciding default moves off the
  // qualified list, that is a governance decision to record here —
  // not a silent drift for the gap gate to flag months later.
  // Source-level sync for the disposition lane (importing the core module
  // in a test is heavyweight; the value is what matters).
  const coreSource = readFileSync(resolvePath(repoRoot, 'server/donna/reconciliationLlmCore.js'), 'utf8');
  const coreDefault = coreSource.match(/export const DEFAULT_MODEL = '([^']+)'/)?.[1];
  assert.ok(coreDefault, 'reconciliationLlmCore.js no longer declares DEFAULT_MODEL where this test reads it');
  assert.ok(getLane('bank_line_disposition').qualified.includes(coreDefault),
    `reconciliationLlmCore's DEFAULT_MODEL (${coreDefault}) must be in the disposition lane's qualified set`);
  // Q9 — the coding lane's strong default stays inside its qualified set
  // (the firmDb policy owners compare policy rows against this constant:
  // default ⇒ openai path, any other qualified rung ⇒ compatible path).
  const codingSource = readFileSync(resolvePath(repoRoot, 'server/donna/transactionLlm.js'), 'utf8');
  const codingDefault = codingSource.match(/const DEFAULT_MODEL = '([^']+)'/)?.[1];
  assert.ok(codingDefault, 'transactionLlm.js no longer declares DEFAULT_MODEL where this test reads it');
  assert.ok(getLane('transaction_coding').qualified.includes(codingDefault),
    `transactionLlm's DEFAULT_MODEL (${codingDefault}) must be in the coding lane's qualified set`);
});

// ── RT-12: provider-agnostic lanes and prompt versions ────────────────
await test('every lane names its providers; the unified lane is the one provider-agnostic lane and its defaults are its qualified set', () => {
  for (const entry of MODEL_LANES) {
    assert.ok(Array.isArray(entry.providers) && Object.isFrozen(entry.providers) && entry.providers.length > 0, `${entry.id}: providers`);
    assert.ok(entry.providers.includes(entry.endpointClass), `${entry.id}: the primary endpoint class is one of its providers`);
    for (const provider of entry.providers) {
      assert.ok(ENDPOINT_CLASSES.includes(provider), `${entry.id}: unknown provider ${provider}`);
    }
    assert.ok(entry.promptVersion === null || (typeof entry.promptVersion === 'string' && entry.promptVersion.trim()),
      `${entry.id}: promptVersion is null or a non-empty string`);
  }
  const agnostic = MODEL_LANES.filter((entry) => entry.providers.length > 1).map((entry) => entry.id);
  assert.deepEqual(agnostic, ['host_provider_probe', 'unified_extraction'], 'a lane goes provider-agnostic in its own dated commit');
  const unified = getLane('unified_extraction');
  assert.deepEqual([...unified.providers], UNIFIED_EXTRACTOR_PROVIDERS);
  assert.deepEqual([...unified.qualified].sort(), Object.values(UNIFIED_EXTRACTOR_DEFAULT_MODELS).sort(),
    'the unified lane qualifies exactly its providers\' strong defaults');
  assert.equal(unified.promptVersion, UNIFIED_EXTRACTOR_PROMPT_VERSION,
    'the registry records the prompt version the module stamps on every receipt');
});

await test('a lane flip has exactly one config-plane spelling', () => {
  assert.equal(laneModelFlagKey('bank_line_disposition'), 'LANE_MODEL_BANK_LINE_DISPOSITION');
});

// ── the permanent exclusion ─────────────────────────────────────────────
await test('ledger_commit has no lane — the ledger post path is permanently unroutable to any model', () => {
  for (const entry of MODEL_LANES) {
    assert.ok(!/ledger/i.test(entry.id), `${entry.id}: no lane may name the ledger`);
    for (const modulePath of entry.modules) {
      assert.ok(!/ledger/i.test(modulePath), `${entry.id}: ${modulePath} — no lane may claim a ledger module`);
    }
  }
  assert.equal(getLane('ledger_commit'), null);
});

// ── lookup helpers ──────────────────────────────────────────────────────
await test('getLane and laneForModule resolve, and miss as null (never throw)', () => {
  assert.equal(getLane('unified_extraction').modules[0], 'server/donna/unifiedExtractor.js');
  assert.equal(getLane('nope'), null);
  assert.equal(laneForModule('server/donna/unifiedExtractor.js').id, 'unified_extraction');
  assert.equal(laneForModule('server/donna/nope.js'), null);
});

// ── RT-14: the retired lane stays retired ─────────────────────────────
await test('bank_line_classification is gone (RT-14): its env-dark sweep, classifier and wiring were deleted; no lane claims them', () => {
  assert.equal(getLane('bank_line_classification'), null);
  for (const modulePath of ['server/donna/bankLineClassifier.js', 'server/donna/bankLineChallenger.js', 'server/donna/entityFacts.js']) {
    assert.equal(laneForModule(modulePath), null, `${modulePath} is deleted and unclaimed`);
    assert.ok(!existsSync(resolvePath(repoRoot, modulePath)), `${modulePath} does not exist`);
  }
});
