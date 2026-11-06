import { createHash } from 'node:crypto';

import { canonicalJson } from './unitExecutionReceipt.js';
import { validateGate2aWorld } from './gate2aRawByteProof.js';
import { buildObservationSchedule } from './observationSchedule.js';
import {
  MODEL_PROVENANCE_CLASSIFICATIONS,
  validateDecisionReceipt,
} from './traceReceipts.js';
import { validateCausalWorld } from './worldValidity.js';
import { validateWorldSpec } from './worldSchema.js';

export const GATE2B_C1_RECEIPT_VERSION = 'eaw.gate2b.c1-run.v1';
export const GATE2B_STABILITY_VERSION = 'eaw.gate2b.stability.v1';
export const GATE2B_BUDGET_VERSION = 'eaw.gate2b.live-budget.v1';
export const GATE2B_PREDECLARED_K = 3;
export const GATE2B_WORLD_PATH = 'data/worlds/gate2b-birth-to-quiescence-month.json';

const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set(['auto_reconciled', 'on_owner']);
const OPEN_ASK_STATUSES = new Set(['draft', 'open']);
const ACCEPTED_TRANSACTION_STATES = new Set(['accepted', 'applied', 'auto_applied', 'reviewer_applied', 'alternative_applied', 'posted']);
const PROVIDER_CALL_FIELDS = Object.freeze([
  'provider', 'response_id', 'model_id', 'input_tokens', 'output_tokens',
  'wall_time_ms', 'request_digest', 'http_status', 'retry_index',
  'retry_disposition', 'cache_disposition', 'outcome',
]);

export function validateGate2bWorld(world) {
  const errors = [];
  const shape = validateWorldSpec(world);
  if (!shape.ok) errors.push(...shape.errors);
  const causal = validateCausalWorld(world);
  if (!causal.ok) errors.push(...causal.errors.map((error) => `validity.${error}`));
  const gate2a = validateGate2aWorld(world);
  if (!gate2a.ok) errors.push(...gate2a.errors.map((error) => `gate2a_boundary.${error}`));
  const gate = world?.gate2b;
  if (!plain(gate)) errors.push('gate2b must be an object');
  else {
    if (gate.k !== GATE2B_PREDECLARED_K) errors.push(`gate2b.k must equal ${GATE2B_PREDECLARED_K}`);
    for (const field of ['periodStart', 'periodEnd', 'ownerPersonaId', 'ownerHiddenFactId']) if (!nonEmpty(gate[field])) errors.push(`gate2b.${field} is required`);
    if (!Array.isArray(gate.documents) || gate.documents.length < 2) errors.push('gate2b.documents must contain the first document and supporting raw evidence');
    const artifacts = new Map((world?.artifacts || []).map((artifact) => [artifact.id, artifact]));
    const ids = new Set();
    for (const [index, document] of (gate.documents || []).entries()) {
      for (const field of ['artifactId', 'filename', 'mimeType', 'documentType', 'observedAt']) if (!nonEmpty(document?.[field])) errors.push(`gate2b.documents[${index}].${field} is required`);
      if (document?.mimeType !== 'application/pdf') errors.push(`gate2b.documents[${index}] must be raw PDF evidence`);
      if (ids.has(document?.artifactId)) errors.push(`gate2b.documents[${index}].artifactId is duplicated`);
      ids.add(document?.artifactId);
      if (artifacts.get(document?.artifactId)?.format !== 'pdf') errors.push(`gate2b.documents[${index}].artifactId must identify a PDF artifact`);
    }
    const first = gate.documents?.[0];
    if (first?.artifactId !== world?.gate2a?.firstDocumentArtifactId
      || first?.filename !== world?.gate2a?.filename
      || first?.mimeType !== world?.gate2a?.mimeType
      || first?.documentType !== world?.gate2a?.documentType) {
      errors.push('gate2b first document must preserve the Gate 2A product boundary');
    }
    const hiddenFact = (world?.hiddenFacts || []).find((fact) => fact.id === gate.ownerHiddenFactId);
    if (!hiddenFact || hiddenFact.ownerOnly !== true || hiddenFact.kind !== 'business_purpose') errors.push('gate2b owner fact must be a declared owner-only business_purpose');
    const schedule = buildObservationSchedule(world);
    if (!schedule.ok) errors.push(...schedule.errors.map((error) => `schedule.${error}`));
    else if (!schedule.ownerFactContracts.some((contract) => contract.hiddenFactId === gate.ownerHiddenFactId)) errors.push('gate2b owner fact is absent from the observation schedule');
  }
  return freeze({ ok: errors.length === 0, errors });
}

/**
 * Calculate a fail-closed upper bound before any Gate 2B provider call.
 * Prices are injected from a dated source; this helper never guesses current
 * provider prices or treats a missing source as zero.
 */
export function buildGate2bLiveBudget({ worldId, k = GATE2B_PREDECLARED_K, lanes = [], approved = null } = {}) {
  const errors = [];
  if (!nonEmpty(worldId)) errors.push('worldId is required');
  if (k !== GATE2B_PREDECLARED_K) errors.push(`k must equal the predeclared Gate 2B schedule (${GATE2B_PREDECLARED_K})`);
  if (!Array.isArray(lanes) || lanes.length === 0) errors.push('at least one live model lane is required');

  const normalized = [];
  for (const [index, lane] of (Array.isArray(lanes) ? lanes : []).entries()) {
    const prefix = `lanes[${index}]`;
    const laneErrors = [];
    for (const field of ['lane', 'provider', 'model_id']) if (!nonEmpty(lane?.[field])) laneErrors.push(`${prefix}.${field} is required`);
    for (const field of ['max_calls_per_run', 'max_input_tokens_per_call', 'max_output_tokens_per_call']) {
      if (!positiveInteger(lane?.[field])) laneErrors.push(`${prefix}.${field} must be a positive safe integer`);
    }
    const price = lane?.price_source;
    if (!plain(price)) laneErrors.push(`${prefix}.price_source is required`);
    else {
      if (!nonEmpty(price.id)) laneErrors.push(`${prefix}.price_source.id is required`);
      if (!isoTimestamp(price.observed_at)) laneErrors.push(`${prefix}.price_source.observed_at must be an ISO timestamp`);
      for (const field of ['input_usd_per_million', 'output_usd_per_million']) {
        if (!nonNegativeFinite(price[field])) laneErrors.push(`${prefix}.price_source.${field} must be a non-negative finite number`);
      }
    }
    errors.push(...laneErrors);
    if (laneErrors.length) continue;
    const calls = lane.max_calls_per_run * k;
    const inputTokens = calls * lane.max_input_tokens_per_call;
    const outputTokens = calls * lane.max_output_tokens_per_call;
    const cashUsd = roundUsd(
      (inputTokens * price.input_usd_per_million + outputTokens * price.output_usd_per_million) / 1_000_000,
    );
    normalized.push({
      lane: lane.lane,
      provider: lane.provider,
      model_id: lane.model_id,
      max_calls_per_run: lane.max_calls_per_run,
      max_input_tokens_per_call: lane.max_input_tokens_per_call,
      max_output_tokens_per_call: lane.max_output_tokens_per_call,
      calls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cash_usd: cashUsd,
      price_source: clone(price),
    });
  }

  const totals = {
    calls: normalized.reduce((sum, lane) => sum + lane.calls, 0),
    input_tokens: normalized.reduce((sum, lane) => sum + lane.input_tokens, 0),
    output_tokens: normalized.reduce((sum, lane) => sum + lane.output_tokens, 0),
    cash_usd: roundUsd(normalized.reduce((sum, lane) => sum + lane.cash_usd, 0)),
  };
  const approvalErrors = validateBudgetApproval(approved, { worldId, k, totals });
  const status = errors.length ? 'INCOMPLETE' : approvalErrors.length ? 'AWAITING_APPROVAL' : 'APPROVED';
  const body = {
    version: GATE2B_BUDGET_VERSION,
    status,
    world_id: worldId || null,
    k,
    lanes: normalized,
    totals,
    approval: approved ? clone(approved) : null,
    errors: [...errors, ...approvalErrors],
    first_live_call_allowed: status === 'APPROVED',
  };
  return freeze({ ...body, receipt_digest: sha256(body) });
}

/**
 * Check the full source-to-terminal inventory before and after one complete
 * production scheduler epoch. Inputs are persisted reads; terminal labels must
 * explicitly identify the canonical production projector.
 */
export function evaluateGate2bQuiescence({ before_epoch: beforeEpoch, after_epoch: afterEpoch } = {}) {
  const before = normalizeCompletenessInventory(beforeEpoch, 'before_epoch');
  const after = normalizeCompletenessInventory(afterEpoch, 'after_epoch');
  const errors = [...before.errors, ...after.errors];
  const blockers = after.errors.length ? [] : inventoryBlockers(after.inventory);
  const unchanged = before.errors.length === 0 && after.errors.length === 0
    && before.digest === after.digest;
  if (!unchanged && errors.length === 0) blockers.push({ class: 'scheduler_epoch_changed_inventory', ids: [] });
  const body = {
    version: 'eaw.gate2b.quiescence.v1',
    status: errors.length ? 'INCOMPLETE' : blockers.length ? 'FAIL' : 'PASS',
    projector: 'reconcileConvergenceState',
    before_digest: before.digest,
    after_digest: after.digest,
    unchanged_after_complete_epoch: unchanged,
    source_count: after.inventory?.source_items.length ?? 0,
    terminal_count: after.inventory?.obligations.length ?? 0,
    blockers,
    errors,
  };
  return freeze({ ...body, receipt_digest: sha256(body) });
}

/** Capture the mandatory T2 -> replied/hanging -> processed terminal sequence. */
export function evaluateGate2bOwnerCheckpoints({ declared_hidden_facts: hiddenFacts = [], pre_answer: pre, replied: replied, post_resume: post, answer } = {}) {
  const errors = [];
  for (const [name, value] of Object.entries({ pre_answer: pre, replied, post_resume: post, answer })) {
    if (!plain(value)) errors.push(`${name} is required`);
  }
  if (!Array.isArray(hiddenFacts)) errors.push('declared_hidden_facts must be an array');
  if (errors.length) return ownerResult('INCOMPLETE', errors, []);

  const askId = answer.ask_id;
  const factId = answer.hidden_fact_id;
  const factClass = answer.fact_class;
  const obligationId = answer.obligation_id;
  const declared = hiddenFacts.some((fact) => fact?.id === factId && fact?.kind === factClass);
  const failures = [];
  if (![askId, factId, factClass, obligationId].every(nonEmpty)) failures.push('answer identity is incomplete');
  if (!declared) failures.push('answer is not a fact declared in the world observation schedule');

  const preAsk = findAsk(pre, askId);
  const preObligation = findObligation(pre, obligationId);
  if (!preAsk || !OPEN_ASK_STATUSES.has(preAsk.status) || preAsk.fact_class !== factClass) failures.push('pre-answer ask is not the declared open owner ask');
  if (preObligation?.state !== 'on_owner' || preObligation?.ask_id !== askId || preObligation?.responsible_actor !== 'owner') failures.push('pre-answer obligation is not lawful T2');

  const repliedAsk = findAsk(replied, askId);
  const repliedObligation = findObligation(replied, obligationId);
  if (repliedAsk?.status !== 'replied') failures.push('the actual reply path did not persist status=replied');
  if (repliedObligation?.state !== 'hanging' || repliedObligation?.reason !== 'owner_answered_processing') failures.push('replied work was not exposed as hanging before processing');

  const postAsk = findAsk(post, askId);
  const postObligation = findObligation(post, obligationId);
  if (!postAsk || postAsk.status !== 'resolved') failures.push('the answered ask was not resolved by resumption');
  const differentSufficientT2 = postObligation?.state === 'on_owner'
    && postObligation.ask_id !== askId
    && nonEmpty(postObligation.fact_class)
    && postObligation.fact_class !== factClass
    && postObligation.responsible_actor === 'owner';
  if (postObligation?.state !== 'auto_reconciled' && !differentSufficientT2) failures.push('resumption reached neither T1 nor a different sufficient T2');

  const body = {
    version: 'eaw.gate2b.owner-checkpoints.v1',
    status: failures.length ? 'FAIL' : 'PASS',
    ask_id: askId || null,
    obligation_id: obligationId || null,
    hidden_fact_id: factId || null,
    checkpoints: ['on_owner', 'owner_answered_processing', postObligation?.state || null],
    failures,
    errors: [],
  };
  return freeze({ ...body, receipt_digest: sha256(body) });
}

/**
 * Compare consequence identities, not generated database ids or ask wording.
 * A complete but disagreeing K schedule is VARIANCE and can never be rerun into
 * a pass by dropping the disagreeing attempt.
 */
export function evaluateGate2bStability({ runs = [], k = GATE2B_PREDECLARED_K } = {}) {
  const errors = [];
  const failures = [];
  if (k !== GATE2B_PREDECLARED_K) errors.push(`k must equal ${GATE2B_PREDECLARED_K}`);
  if (!Array.isArray(runs) || runs.length !== k) errors.push(`exactly ${k} run receipts are required`);
  const tokens = new Set();
  const signatures = [];
  for (const [index, run] of (Array.isArray(runs) ? runs : []).entries()) {
    if (!plain(run)) { errors.push(`runs[${index}] must be an object`); continue; }
    if (!nonEmpty(run.run_token)) errors.push(`runs[${index}].run_token is required`);
    else if (tokens.has(run.run_token)) errors.push(`runs[${index}].run_token is duplicated`);
    else tokens.add(run.run_token);
    if (run.status === 'INCOMPLETE') errors.push(`runs[${index}] is INCOMPLETE`);
    else if (run.status === 'FAIL') failures.push(`runs[${index}] failed its C1 contract`);
    else if (run.status !== 'PASS') errors.push(`runs[${index}].status must be PASS, FAIL, or INCOMPLETE`);
    try { signatures.push(consequenceSignature(run)); }
    catch (error) { errors.push(`runs[${index}].${error.message}`); }
  }
  const variants = [...new Set(signatures.map(({ digest }) => digest))];
  const status = errors.length ? 'INCOMPLETE'
    : failures.length ? 'FAIL'
      : variants.length === 1 ? 'PASS' : 'VARIANCE';
  const body = {
    version: GATE2B_STABILITY_VERSION,
    status,
    k,
    run_tokens: [...tokens],
    consequence_variants: variants.length,
    signatures,
    failures,
    errors,
  };
  return freeze({ ...body, receipt_digest: sha256(body) });
}

/** Build one C1 run verdict from receipts produced by the actual path. */
export function buildGate2bC1RunReceipt({
  world,
  run_token: runToken,
  model_receipts: modelReceipts = [],
  spend,
  quiescence,
  owner_checkpoints: ownerCheckpoints,
  oracle,
  isolation,
  accounting_entries: accountingEntries = [],
  terminal_inventory: terminalInventory = [],
  ask_inventory: askInventory = [],
  artifact_digests: artifactDigests = [],
  configuration_digest: configurationDigest,
  complete_epoch_receipt: completeEpochReceipt,
} = {}) {
  const failures = [];
  const incomplete = [];
  if (!plain(world) || !nonEmpty(world.worldId)) incomplete.push('world is required');
  if (!nonEmpty(runToken)) incomplete.push('run_token is required');
  if (!Array.isArray(modelReceipts) || modelReceipts.length === 0) incomplete.push('live model receipts are required');
  else for (const [index, receipt] of modelReceipts.entries()) {
    const validation = validateDecisionReceipt(receipt);
    if (!validation.ok) incomplete.push(...validation.errors.map((error) => `model_receipts[${index}].${error}`));
    if (validation.provenance?.classification !== MODEL_PROVENANCE_CLASSIFICATIONS.RESPONSE_PROVEN) {
      incomplete.push(`model_receipts[${index}] is not response-proven`);
    }
  }
  const spendValidation = validateGate2bSpendReceipt(spend);
  if (!spendValidation.ok) incomplete.push(...spendValidation.errors.map((error) => `spend.${error}`));
  if (!SHA256.test(configurationDigest || '')) incomplete.push('configuration_digest is required');
  if (!Array.isArray(artifactDigests) || artifactDigests.length === 0 || artifactDigests.some((value) => !SHA256.test(value))) incomplete.push('artifact_digests are incomplete');
  let normalizedEpochReceipt = null;
  const epochFields = ['reconciliation', 'coding', 'draft', 'send', 'inbox', 'outbox', 'resumed_coding'];
  if (!plain(completeEpochReceipt)) incomplete.push('complete_epoch_receipt is required');
  else {
    for (const field of epochFields) if (!(field in completeEpochReceipt)) incomplete.push(`complete_epoch_receipt.${field} is required`);
    try {
      canonicalJson(completeEpochReceipt);
      normalizedEpochReceipt = clone(completeEpochReceipt);
    } catch {
      incomplete.push('complete_epoch_receipt must contain only canonical JSON values');
    }
  }
  if (spendValidation.ok && spend.configurationDigest !== configurationDigest) incomplete.push('spend.configurationDigest does not match configuration_digest');
  if (spendValidation.ok && !sameStringSet(spend.artifactDigests, artifactDigests)) incomplete.push('spend.artifactDigests do not match artifact_digests');
  if (quiescence?.status === 'INCOMPLETE') incomplete.push('quiescence dependencies are incomplete');
  else if (quiescence?.status !== 'PASS') failures.push('quiescence failed');
  if (ownerCheckpoints?.status === 'INCOMPLETE') incomplete.push('owner checkpoints are incomplete');
  else if (ownerCheckpoints?.status !== 'PASS') failures.push('owner checkpoint contract failed');
  if (oracle?.ok !== true || (oracle.failures || []).length) failures.push('causal accounting oracle failed');
  if (isolation?.status !== 'PASS' || isolation.external_destinations !== 'isolated') failures.push('external destinations are not proved isolated');

  const body = {
    version: GATE2B_C1_RECEIPT_VERSION,
    status: incomplete.length ? 'INCOMPLETE' : failures.length ? 'FAIL' : 'PASS',
    scope: { gate: '2B', claim: 'isolated_raw_bytes_to_canonical_quiescence', certificate: 'C1' },
    world_id: world?.worldId || null,
    run_token: runToken || null,
    accounting_entries: stableArray(accountingEntries),
    terminal_inventory: stableArray(terminalInventory),
    ask_inventory: stableArray(askInventory),
    model_receipts: clone(modelReceipts),
    spend: clone(spend),
    quiescence: clone(quiescence),
    owner_checkpoints: clone(ownerCheckpoints),
    oracle: clone(oracle),
    isolation: clone(isolation),
    configuration_digest: configurationDigest || null,
    artifact_digests: [...new Set(artifactDigests)].sort(),
    complete_epoch_receipt: normalizedEpochReceipt,
    failures,
    incomplete,
  };
  return freeze({ ...body, receipt_digest: sha256(body) });
}

export function validateGate2bSpendReceipt(spend) {
  const errors = [];
  if (!plain(spend)) return { ok: false, errors: ['receipt is required'] };
  if (spend.status !== 'counted') errors.push('status must be counted');
  if (!positiveInteger(spend.solveCalls)) errors.push('solveCalls must be a positive safe integer');
  if (!Array.isArray(spend.calls) || spend.calls.length === 0) errors.push('calls must contain every provider attempt');
  else {
    for (const [index, call] of spend.calls.entries()) {
      if (!plain(call)) { errors.push(`calls[${index}] must be an object`); continue; }
      for (const field of PROVIDER_CALL_FIELDS) {
        const value = call[field];
        if (['input_tokens', 'output_tokens', 'wall_time_ms', 'retry_index'].includes(field)) {
          if (!Number.isSafeInteger(value) || value < 0) errors.push(`calls[${index}].${field} is invalid`);
        } else if (field === 'http_status') {
          if (!Number.isInteger(value) || value < 100 || value > 599) errors.push(`calls[${index}].http_status is invalid`);
        } else if (field === 'request_digest') {
          if (!SHA256.test(value || '')) errors.push(`calls[${index}].request_digest is invalid`);
        } else if (!nonEmpty(value)) errors.push(`calls[${index}].${field} is required`);
      }
      const tokenCount = call.input_token_preflight;
      if (!plain(tokenCount)) errors.push(`calls[${index}].input_token_preflight is required`);
      else {
        if (!Number.isSafeInteger(tokenCount.input_tokens) || tokenCount.input_tokens < 0) errors.push(`calls[${index}].input_token_preflight.input_tokens is invalid`);
        if (!Number.isInteger(tokenCount.http_status) || tokenCount.http_status < 100 || tokenCount.http_status > 599) errors.push(`calls[${index}].input_token_preflight.http_status is invalid`);
        if (!SHA256.test(tokenCount.request_digest || '')) errors.push(`calls[${index}].input_token_preflight.request_digest is invalid`);
        if (!nonEmpty(tokenCount.endpoint_path) || tokenCount.cost !== 'free_provider_token_count') errors.push(`calls[${index}].input_token_preflight provenance is incomplete`);
      }
    }
  }
  if (!plain(spend.cash) || !nonNegativeFinite(spend.cash.usd) || !plain(spend.cash.price_source)) errors.push('cash.usd and cash.price_source are required');
  if (!SHA256.test(spend.configurationDigest || '')) errors.push('configurationDigest is required');
  if (!Array.isArray(spend.artifactDigests) || spend.artifactDigests.length === 0 || spend.artifactDigests.some((value) => !SHA256.test(value))) errors.push('artifactDigests are required');
  if (Array.isArray(spend.calls) && positiveInteger(spend.solveCalls) && spend.solveCalls > spend.calls.length) errors.push('solveCalls cannot exceed provider attempt count');
  return { ok: errors.length === 0, errors };
}

function normalizeCompletenessInventory(value, prefix) {
  const errors = [];
  if (!plain(value)) return { errors: [`${prefix} is required`], inventory: null, digest: null };
  if (value.projector !== 'reconcileConvergenceState') errors.push(`${prefix}.projector must be reconcileConvergenceState`);
  const fields = ['source_items', 'documents', 'jobs', 'reconciliation_candidates', 'coding_candidates', 'draft_send_work', 'asks', 'transactions', 'obligations'];
  for (const field of fields) if (!Array.isArray(value[field])) errors.push(`${prefix}.${field} must be an array`);
  if (errors.length) return { errors, inventory: null, digest: null };
  const inventory = Object.fromEntries(fields.map((field) => [field, stableArray(value[field])]));
  return { errors, inventory, digest: sha256(inventory) };
}

function inventoryBlockers(inventory) {
  const blockers = [];
  addBlocker(blockers, 'documents_not_terminal', inventory.documents.filter((row) => !['completed', 'failed_terminal'].includes(row.status)));
  addBlocker(blockers, 'jobs_not_terminal', inventory.jobs.filter((row) => ['due', 'pending', 'running'].includes(row.status) || (row.status === 'dead' && row.still_eligible === true)));
  addBlocker(blockers, 'reconciliation_candidates_remaining', inventory.reconciliation_candidates);
  addBlocker(blockers, 'coding_candidates_remaining', inventory.coding_candidates);
  addBlocker(blockers, 'draft_or_send_work_remaining', inventory.draft_send_work);
  addBlocker(blockers, 'replied_asks_awaiting_processing', inventory.asks.filter((row) => row.status === 'replied'));
  addBlocker(blockers, 'accepted_transactions_without_journal', inventory.transactions.filter((row) => ACCEPTED_TRANSACTION_STATES.has(row.state) && (!Array.isArray(row.journal_ids) || row.journal_ids.length === 0)));
  addBlocker(blockers, 'canonical_hanging_obligations', inventory.obligations.filter((row) => !TERMINAL_STATES.has(row.state)));

  const obligationIds = new Set(inventory.obligations.map((row) => row.source_item_id).filter(nonEmpty));
  addBlocker(blockers, 'source_items_missing_terminal_obligation', inventory.source_items.filter((row) => !obligationIds.has(row.id)));
  const openAskIds = new Set(inventory.asks.filter((row) => OPEN_ASK_STATUSES.has(row.status)).map((row) => row.id));
  addBlocker(blockers, 'owner_terminals_without_open_ask', inventory.obligations.filter((row) => row.state === 'on_owner' && (row.responsible_actor !== 'owner' || !openAskIds.has(row.ask_id))));
  return blockers;
}

function consequenceSignature(run) {
  for (const field of ['accounting_entries', 'terminal_inventory', 'ask_inventory']) {
    if (!Array.isArray(run[field])) throw new TypeError(`${field} must be an array`);
  }
  const projection = {
    accounting: stableArray(run.accounting_entries.map((entry) => pick(entry, ['canonical_identity', 'event_id', 'obligation_id', 'account_role', 'amount', 'currency']))),
    terminals: stableArray(run.terminal_inventory.map((entry) => pick(entry, ['canonical_identity', 'source_item_id', 'state', 'responsible_actor', 'fact_class']))),
    asks: stableArray(run.ask_inventory.map((entry) => pick(entry, ['canonical_identity', 'obligation_id', 'fact_class', 'audience', 'terminal_status']))),
  };
  for (const [section, rows] of Object.entries(projection)) {
    if (rows.some((row) => !nonEmpty(row.canonical_identity))) throw new TypeError(`${section} consequence lacks canonical_identity`);
  }
  return { run_token: run.run_token, digest: sha256(projection), consequence: projection };
}

function validateBudgetApproval(approval, { worldId, k, totals }) {
  if (!plain(approval)) return ['a measured hard-cap approval is required before the first live call'];
  const errors = [];
  if (!nonEmpty(approval.authority_id)) errors.push('approval.authority_id is required');
  if (!nonEmpty(approval.basis)) errors.push('approval.basis is required');
  if (!isoTimestamp(approval.approved_at)) errors.push('approval.approved_at must be an ISO timestamp');
  if (approval.world_id !== worldId || approval.k !== k) errors.push('approval scope does not match this world and K schedule');
  if (!nonNegativeFinite(approval.max_cash_usd) || approval.max_cash_usd < totals.cash_usd) errors.push('approval.max_cash_usd is below the calculated hard cap');
  if (!positiveInteger(approval.max_calls) || approval.max_calls < totals.calls) errors.push('approval.max_calls is below the calculated hard cap');
  return errors;
}

function ownerResult(status, errors, failures) {
  const body = { version: 'eaw.gate2b.owner-checkpoints.v1', status, ask_id: null, obligation_id: null, hidden_fact_id: null, checkpoints: [], failures, errors };
  return freeze({ ...body, receipt_digest: sha256(body) });
}
function findAsk(snapshot, id) { return (snapshot?.asks || []).find((row) => row.id === id); }
function findObligation(snapshot, id) { return (snapshot?.obligations || []).find((row) => row.id === id); }
function addBlocker(target, kind, rows) { if (rows.length) target.push({ class: kind, ids: rows.map((row) => row.id).filter(nonEmpty).sort() }); }
function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return canonicalJson([...new Set(left)].sort()) === canonicalJson([...new Set(right)].sort());
}
function stableArray(values) { return clone(Array.isArray(values) ? values : []).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))); }
function pick(value, fields) { return Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null])); }
function roundUsd(value) { return Math.ceil(value * 1_000_000) / 1_000_000; }
function sha256(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function clone(value) { return value == null ? value : structuredClone(value); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function nonNegativeFinite(value) { return Number.isFinite(value) && value >= 0; }
function isoTimestamp(value) { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
