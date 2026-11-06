export const ASK_CONTRACT_VERSION = 'eaw.ask.v1';
export const ASK_CHECKS = Object.freeze([
  'necessity', 'relevance', 'sufficiency', 'minimality', 'non_redundancy',
  'bundling', 'timing', 'resumption', 'contradiction_handling',
]);

const RECORD_FIELDS = Object.freeze([
  'version', 'ask_id', 'case_id', 'fact_class', 'affected_obligations',
  'remaining_hypotheses', 'evidence_already_checked', 'expected_answer_type',
  'reliability_required', 'next_state_if_answered', 'deferrable_until', 'bundle_id',
]);

export function validateAskRecord(record) {
  const errors = [];
  if (!isObject(record)) return result(['record must be an object']);
  for (const key of Object.keys(record)) if (!RECORD_FIELDS.includes(key)) errors.push(`unsupported field: ${key}`);
  if (record.version !== ASK_CONTRACT_VERSION) errors.push(`version must be ${ASK_CONTRACT_VERSION}`);
  for (const field of ['ask_id', 'case_id', 'fact_class', 'expected_answer_type', 'reliability_required', 'next_state_if_answered']) {
    if (!nonEmpty(record[field])) errors.push(`${field} must be a non-empty string`);
  }
  for (const field of ['affected_obligations', 'remaining_hypotheses', 'evidence_already_checked']) validateStringArray(record[field], field, errors);
  if (Array.isArray(record.affected_obligations) && record.affected_obligations.length === 0) errors.push('affected_obligations must not be empty');
  if (Array.isArray(record.remaining_hypotheses) && record.remaining_hypotheses.length < 2) errors.push('remaining_hypotheses must contain at least two alternatives');
  if (record.deferrable_until !== null && !isIsoDay(record.deferrable_until)) errors.push('deferrable_until must be null or an ISO day');
  if (record.bundle_id !== null && !nonEmpty(record.bundle_id)) errors.push('bundle_id must be null or a non-empty string');
  return result(errors);
}

/** Normalize the Unit 39 `{ counts, requests }` read without importing its producer. */
export function normalizeEvidenceRequestRead(read) {
  if (!isObject(read) || !isObject(read.counts) || !Array.isArray(read.requests)) return { ok: false, errors: ['read must contain counts and requests arrays'], asks: [] };
  const errors = [];
  const asks = read.requests.map((request, index) => {
    const record = request?.ask_contract ?? request?.askContract ?? request?.payload?.ask_contract;
    const validation = validateAskRecord(record);
    if (!validation.ok) errors.push(...validation.errors.map((error) => `requests[${index}].${error}`));
    return {
      record,
      asked_at: request?.created_at ?? request?.asked_at ?? null,
      status: request?.status ?? null,
      answered_at: request?.answered_at ?? request?.replied_at ?? null,
    };
  });
  return { ok: errors.length === 0, errors, asks: errors.length === 0 ? asks : [] };
}

export function evaluateAskSequence({ world, schedule, asks, answers = [], transitions = [] } = {}) {
  const errors = [];
  if (!isObject(world) || !Array.isArray(world.hiddenFacts) || !Array.isArray(world.observations)) errors.push('world with hiddenFacts and observations is required');
  if (!isObject(schedule) || !Array.isArray(schedule.observations) || !Array.isArray(schedule.ownerFactContracts)) errors.push('observation schedule is required');
  if (!Array.isArray(asks)) errors.push('asks must be an array');
  if (!Array.isArray(answers)) errors.push('answers must be an array');
  if (!Array.isArray(transitions)) errors.push('transitions must be an array');
  if (errors.length) return { ok: false, version: ASK_CONTRACT_VERSION, errors, verdicts: [], summary: emptySummary() };

  const facts = new Map(world.hiddenFacts.filter(isObject).map((fact) => [fact.kind, fact]));
  const observedByFact = observedFactDates(world, schedule);
  const answerByFact = groupBy(answers, 'fact_class');
  const transitionByCase = groupBy(transitions, 'case_id');
  const seen = new Map();
  const verdicts = [];

  asks.forEach((item, index) => {
    const record = item?.record ?? item;
    const validation = validateAskRecord(record);
    if (!validation.ok) {
      verdicts.push({ ask_id: nonEmpty(record?.ask_id) ? record.ask_id : `invalid/${index}`, case_id: nonEmpty(record?.case_id) ? record.case_id : null, valid: false, checks: failedChecks('invalid_ask_record') });
      return;
    }
    const askedAt = item?.asked_at ?? null;
    const fact = facts.get(record.fact_class);
    const truth = isObject(fact?.askEvaluation) ? fact.askEvaluation : {};
    const priorAnswers = (answerByFact.get(record.fact_class) ?? []).filter((a) => !askedAt || !a.answered_at || a.answered_at <= askedAt);
    const previouslyAsked = seen.has(record.fact_class);
    const alreadyObserved = (observedByFact.get(record.fact_class) ?? []).some((date) => !askedAt || date <= askedAt);
    const answer = (answerByFact.get(record.fact_class) ?? []).find((a) => a.ask_id === record.ask_id);
    const caseTransitions = transitionByCase.get(record.case_id) ?? [];
    const afterAnswer = answer && caseTransitions.some((t) => t.at > answer.answered_at && ['resumed', record.next_state_if_answered].includes(t.state));
    const contradiction = contradictionFor(world, record.fact_class, askedAt);
    const reopened = !contradiction || caseTransitions.some((t) => t.at >= contradiction.observedAt && t.state === 'reopened');
    const expectedObligations = array(truth.affectedObligations);
    const requiredEvidence = array(truth.requiredEvidence);
    const bundlePeers = asks.filter((other) => (other?.record ?? other)?.case_id === record.case_id && facts.get((other?.record ?? other)?.fact_class)?.askEvaluation?.bundleGroup === truth.bundleGroup);

    const checks = {
      necessity: check((truth.outcomesRemainDistinct ?? record.remaining_hypotheses.length > 1) === true, 'no_distinct_outcomes_remain'),
      relevance: check(fact !== undefined && (truth.distinguishing !== false), 'fact_does_not_distinguish_hypotheses'),
      sufficiency: check(truth.answerSufficient !== false && (!truth.expectedAnswerType || truth.expectedAnswerType === record.expected_answer_type) && (!truth.reliabilityRequired || truth.reliabilityRequired === record.reliability_required), 'answer_cannot_permit_next_action'),
      minimality: check((array(truth.requiredFactClasses).length === 0 || sameSet(array(truth.requiredFactClasses), [record.fact_class])) && requiredEvidence.every((id) => record.evidence_already_checked.includes(id)), 'ask_requests_or_omits_unnecessary_information'),
      non_redundancy: check(!previouslyAsked && priorAnswers.length === 0 && !alreadyObserved, 'fact_already_asked_answered_or_observed'),
      bundling: check(!truth.bundleGroup || (record.bundle_id !== null && bundlePeers.every((peer) => (peer?.record ?? peer).bundle_id === record.bundle_id)), 'related_asks_not_bundled'),
      timing: check(isIsoDay(askedAt) && (!record.deferrable_until || askedAt >= record.deferrable_until) && (!truth.neededAt || askedAt >= truth.neededAt), 'ask_not_needed_now'),
      resumption: check(!answer || afterAnswer, 'case_did_not_resume_after_answer'),
      contradiction_handling: check(reopened, 'later_contradiction_did_not_reopen_case'),
    };
    if (expectedObligations.length && !sameSet(expectedObligations, record.affected_obligations)) checks.relevance = check(false, 'affected_obligations_do_not_match_truth');
    seen.set(record.fact_class, record.ask_id);
    verdicts.push({ ask_id: record.ask_id, case_id: record.case_id, valid: true, checks });
  });

  const summary = Object.fromEntries(ASK_CHECKS.map((name) => [name, { passed: verdicts.filter((v) => v.checks[name]?.pass).length, failed: verdicts.filter((v) => v.checks[name] && !v.checks[name].pass).length }]));
  return { ok: verdicts.every((v) => v.valid && ASK_CHECKS.every((name) => v.checks[name].pass)), version: ASK_CONTRACT_VERSION, errors: [], verdicts, summary };
}

function observedFactDates(world, schedule) {
  const observationById = new Map(world.observations.filter(isObject).map((o) => [o.id, o]));
  const out = new Map();
  for (const receipt of schedule.observations) {
    const source = observationById.get(receipt.observationId);
    for (const ref of array(source?.hiddenFactRefs)) {
      const fact = world.hiddenFacts.find((candidate) => candidate.id === ref);
      if (fact) push(out, fact.kind, receipt.observedAt);
    }
  }
  return out;
}
function contradictionFor(world, factClass, askedAt) { return world.observations.filter(isObject).filter((o) => o.contradictsFactClass === factClass && (!askedAt || o.observedAt > askedAt)).sort((a,b) => a.observedAt.localeCompare(b.observedAt))[0] ?? null; }
function groupBy(items, key) { const map = new Map(); for (const item of items.filter(isObject)) push(map, item[key], item); return map; }
function push(map, key, value) { if (!map.has(key)) map.set(key, []); map.get(key).push(value); }
function check(pass, reason) { return pass ? { pass: true, reason: null } : { pass: false, reason }; }
function failedChecks(reason) { return Object.fromEntries(ASK_CHECKS.map((name) => [name, check(false, reason)])); }
function emptySummary() { return Object.fromEntries(ASK_CHECKS.map((name) => [name, { passed: 0, failed: 0 }])); }
function validateStringArray(value, field, errors) { if (!Array.isArray(value) || value.some((v) => !nonEmpty(v)) || new Set(value).size !== value.length) errors.push(`${field} must be an array of unique non-empty strings`); }
function sameSet(a, b) { return a.length === b.length && a.every((value) => b.includes(value)); }
function array(value) { return Array.isArray(value) ? value : []; }
function result(errors) { return { ok: errors.length === 0, version: ASK_CONTRACT_VERSION, errors }; }
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function isIsoDay(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
