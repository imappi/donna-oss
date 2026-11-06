import { normalizeEvidenceRequestRead, validateAskRecord } from './askContract.js';
import { validateDecisionReceipt } from './traceReceipts.js';

export const INTERACTION_RUN_EVALUATOR_VERSION = 'eaw.interaction-run-evaluator.v1';
export const INTERACTION_RUN_PROPERTIES = Object.freeze([
  'resumption', 'no_repeated_ask', 'no_hidden_fact_leakage', 'two_terminal_states',
]);

/** Deterministically score a complete interaction run without returning fact values. */
export function evaluateInteractionRun({ world, schedule, run } = {}) {
  const normalized = normalizeInteractionRun(run);
  const errors = validateInputs(world, schedule, normalized);
  if (errors.length) return report(false, errors, []);

  const failures = [];
  checkResumption(normalized, failures);
  checkRepeatedAsks(normalized, failures);
  checkLeakage(world, schedule, normalized, failures);
  checkTerminals(normalized, failures);
  return report(failures.length === 0, [], failures);
}

/**
 * Accept both a single run and Unit 39's `{ version, receipts }` harness result.
 * Evidence requests retain their production `{ counts, requests }` read shape.
 */
export function normalizeInteractionRun(run) {
  if (!plain(run)) return { ok: false, errors: ['run must be an object'] };
  const candidates = Array.isArray(run.receipts) ? run.receipts : [run];
  const errors = [];
  const cases = candidates.map((candidate, index) => {
    if (!plain(candidate)) { errors.push(`receipts[${index}] must be an object`); return emptyCase(index); }
    const read = candidate.evidence_requests ?? candidate.evidenceRequests ?? run.evidence_requests ?? run.evidenceRequests ?? { counts: {}, requests: [] };
    const asks = normalizeEvidenceRequestRead(read);
    if (!asks.ok) errors.push(...asks.errors.map((error) => `receipts[${index}].${error}`));
    return {
      case_id: candidate.case_id ?? candidate.client_id ?? `run-case/${index}`,
      asks: asks.asks.map((ask, requestIndex) => ({ ...ask, request_id: read.requests[requestIndex]?.id ?? ask.record?.ask_id })),
      answers: cloneArray(candidate.owner_answers ?? candidate.ownerAnswers ?? candidate.answerRecords ?? []),
      traces: cloneArray(candidate.trace_receipts ?? candidate.traceReceipts ?? []),
      outputs: cloneArray(candidate.solver_outputs ?? candidate.solverOutputs ?? []),
      terminal: candidate.terminal ?? candidate.passes?.at(-1)?.terminal ?? null,
    };
  });
  return { ok: errors.length === 0, errors, cases };
}

function validateInputs(world, schedule, normalized) {
  const errors = [];
  if (!plain(world) || !Array.isArray(world.hiddenFacts) || !Array.isArray(world.observations)) errors.push('world with hiddenFacts and observations is required');
  if (!plain(schedule) || !Array.isArray(schedule.observations)) errors.push('observation schedule is required');
  if (!normalized.ok) errors.push(...normalized.errors);
  for (const [caseIndex, item] of (normalized.cases ?? []).entries()) {
    for (const [askIndex, ask] of item.asks.entries()) {
      const valid = validateAskRecord(ask.record);
      if (!valid.ok) errors.push(...valid.errors.map((error) => `cases[${caseIndex}].asks[${askIndex}].${error}`));
    }
    for (const [traceIndex, trace] of item.traces.entries()) {
      const valid = validateDecisionReceipt(trace);
      if (!valid.ok) errors.push(...valid.errors.map((error) => `cases[${caseIndex}].traces[${traceIndex}].${error}`));
    }
  }
  return errors;
}

function checkResumption(normalized, failures) {
  for (const item of normalized.cases) for (const answer of item.answers) {
    if (!nonEmpty(answer.askId ?? answer.ask_id) || !nonEmpty(answer.answeredAt ?? answer.answered_at)) continue;
    const askId = answer.askId ?? answer.ask_id;
    const answeredAt = answer.answeredAt ?? answer.answered_at;
    const ask = item.asks.find(({ record }) => record.ask_id === askId)?.record;
    const progressed = item.traces.some((trace) => traceAfter(trace, answeredAt)
      && trace.stage !== 'owner_ask_and_response'
      && (!ask || trace.runtimeSnapshot?.case_id === ask.case_id || overlaps(trace.obligationIds, ask.affected_obligations)));
    const newlyBlocked = terminalBlocksNewFact(item.terminal, item.asks, ask?.fact_class);
    if (!progressed && !newlyBlocked) failures.push(failure('resumption', item.case_id, askId, 'stalled_after_answer'));
  }
}

function checkRepeatedAsks(normalized, failures) {
  for (const item of normalized.cases) {
    const answered = new Map();
    for (const answer of item.answers) {
      const factClass = answer.factKind ?? answer.fact_class;
      const at = answer.answeredAt ?? answer.answered_at;
      if (nonEmpty(factClass) && nonEmpty(at) && (!answered.has(factClass) || at < answered.get(factClass))) answered.set(factClass, at);
    }
    for (const ask of item.asks) {
      const at = ask.asked_at;
      const answeredAt = answered.get(ask.record.fact_class);
      if (answeredAt && at && at > answeredAt) failures.push(failure('no_repeated_ask', item.case_id, ask.record.ask_id, 'answered_fact_class_reasked'));
    }
  }
}

function checkLeakage(world, schedule, normalized, failures) {
  const observations = new Map(schedule.observations.map((entry) => [entry.observationId, entry.observedAt]));
  for (const item of normalized.cases) for (const output of item.outputs) {
    const at = output.at ?? output.created_at;
    for (const fact of world.hiddenFacts) {
      const answered = item.answers.some((answer) => (answer.hiddenFactId ?? answer.hidden_fact_id) === fact.id && (!at || (answer.answeredAt ?? answer.answered_at) <= at));
      const observed = world.observations.some((observation) => array(observation.hiddenFactRefs).includes(fact.id) && observations.has(observation.id) && (!at || observations.get(observation.id) <= at));
      if (!answered && !observed && containsValue(output.value ?? output.output ?? output, fact.value)) {
        failures.push(failure('no_hidden_fact_leakage', item.case_id, output.output_id ?? output.id ?? null, 'unrevealed_hidden_fact_in_solver_output', fact.id));
      }
    }
  }
}

function checkTerminals(normalized, failures) {
  for (const item of normalized.cases) {
    const terminal = item.terminal;
    const t1 = array(terminal?.t1); const t2 = array(terminal?.t2); const limbo = array(terminal?.limbo);
    if (!plain(terminal) || limbo.length || (t1.length > 0) === (t2.length > 0)) {
      failures.push(failure('two_terminal_states', item.case_id, null, 'terminal_projection_not_exclusive'));
      continue;
    }
    const openAskIds = new Set(item.asks.filter((ask) => ['draft', 'open', 'replied'].includes(ask.status)).flatMap((ask) => [ask.record.ask_id, ask.request_id]));
    for (const blocked of t2) if (blocked?.responsible_actor !== 'owner' || !nonEmpty(blocked.id) || !openAskIds.has(blocked.id)) {
      failures.push(failure('two_terminal_states', item.case_id, blocked?.id ?? null, 'blocked_item_not_on_owner_with_open_ask'));
    }
  }
}

function terminalBlocksNewFact(terminal, asks, answeredFact) {
  const records = new Map(asks.map((ask) => [ask.record.ask_id, ask.record]));
  return array(terminal?.t2).some((blocked) => blocked?.responsible_actor === 'owner' && records.has(blocked.id) && records.get(blocked.id).fact_class !== answeredFact);
}
function traceAfter(trace, answeredAt) { const at = trace.runtimeSnapshot?.at ?? trace.runtimeSnapshot?.created_at; return nonEmpty(at) ? at > answeredAt : Number.isFinite(trace.sequence); }
function overlaps(left, right) { return array(left).some((value) => array(right).includes(value)); }
function containsValue(container, value) {
  if (value === null || value === undefined || typeof value === 'object') return JSON.stringify(container).includes(JSON.stringify(value));
  return JSON.stringify(container).includes(JSON.stringify(value).slice(1, -1));
}
function failure(property, caseId, recordId, reason, factId) { return { property, case_id: caseId, record_id: recordId, reason, ...(factId ? { hidden_fact_id: factId } : {}) }; }
function report(ok, errors, failures) { return { ok, version: INTERACTION_RUN_EVALUATOR_VERSION, errors, properties: Object.fromEntries(INTERACTION_RUN_PROPERTIES.map((property) => [property, !failures.some((entry) => entry.property === property)])), failures }; }
function emptyCase(index) { return { case_id: `run-case/${index}`, asks: [], answers: [], traces: [], outputs: [], terminal: null }; }
function cloneArray(value) { return Array.isArray(value) ? structuredClone(value) : []; }
function array(value) { return Array.isArray(value) ? value : []; }
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
