import { evaluateAskSequence } from './askContract.js';

export const ASK_POLICY_VERSION = 'eaw.askPolicy.v1';
export const ASK_CLASSES = Object.freeze(['ASK_REQUIRED', 'ASK_OPTIONAL', 'DEFER', 'DO_NOT_ASK']);

/** Classify world facts from privileged truth and policy inputs, never solver output. */
export function classifyAskPolicy({ world, projection, authorityState, obligationDeadlines = {}, safeFallbacks = {}, asOf } = {}) {
  const errors = validateInputs(world, projection, authorityState, asOf);
  if (errors.length) return { ok: false, version: ASK_POLICY_VERSION, errors, classifications: [] };

  const known = new Set(authorityState.knownFactClasses);
  const classifications = world.hiddenFacts.map((fact) => {
    const affected = projection.obligations.filter((item) => item.requiredFactKind === fact.kind);
    const policy = fact.askPolicy ?? {};
    const changesOutcome = affected.length > 0 || policy.changesTreatment === true;
    const changesAuthority = policy.changesAuthority === true || authorityState.requiredFactClasses.includes(fact.kind);
    const relevant = changesOutcome || changesAuthority;
    const fallback = safeFallbacks[fact.kind] ?? null;
    const deadlines = affected.map((item) => obligationDeadlines[item.id]).filter(Boolean).sort();
    const deadline = deadlines[0] ?? policy.obligationDeadline ?? null;
    let askClass;
    let reason;

    if (known.has(fact.kind) || !relevant) {
      askClass = 'DO_NOT_ASK'; reason = known.has(fact.kind) ? 'fact_already_known' : 'fact_does_not_change_outcome';
    } else if (deadline && asOf < deadline) {
      askClass = 'DEFER'; reason = 'fact_matters_after_current_obligation';
    } else if (fallback?.safe === true && fallback.reversible === true) {
      askClass = 'ASK_OPTIONAL'; reason = 'safe_reversible_fallback_exists';
    } else {
      askClass = 'ASK_REQUIRED'; reason = 'outcome_or_authority_changes_without_safe_fallback';
    }

    const askBy = askClass === 'DEFER' ? (policy.askBy ?? deadline) : null;
    if (askClass === 'DEFER' && !askBy) errors.push(`${fact.kind}: DEFER requires an askBy oracle expectation`);
    return { fact_class: fact.kind, class: askClass, reason, affected_obligations: affected.map(({ id }) => id).sort(), ask_by: askBy };
  }).sort((a, b) => a.fact_class.localeCompare(b.fact_class));

  return { ok: errors.length === 0, version: ASK_POLICY_VERSION, errors, classifications: errors.length ? [] : classifications };
}

/** Compose the ordinal oracle with Unit 55's structural ask evaluator. */
export function evaluateAskPolicy({ policy, world, schedule, asks = [], answers = [], transitions = [], actions = [] } = {}) {
  if (!policy?.ok || !Array.isArray(policy.classifications)) return { ok: false, version: ASK_POLICY_VERSION, errors: ['valid policy classification is required'], overAsk: [], underAsk: [], askEvaluation: null };
  const byFact = new Map(policy.classifications.map((item) => [item.fact_class, item]));
  const answered = new Set(answers.filter((item) => item?.answered_at).map((item) => item.fact_class));
  const overAsk = asks.flatMap((item) => {
    const record = item?.record ?? item;
    const classification = byFact.get(record?.fact_class);
    return classification?.class === 'DO_NOT_ASK'
      ? [{ ask_id: record.ask_id, fact_class: record.fact_class, reason: classification.reason === 'fact_already_known' ? 'asked_already_known_fact' : 'asked_do_not_ask_fact' }]
      : [];
  });
  const underAsk = actions.flatMap((action, index) => policy.classifications
    .filter((item) => item.class === 'ASK_REQUIRED' && !answered.has(item.fact_class) && intersects(item.affected_obligations, action?.affected_obligations))
    .map((item) => ({ action_id: action?.action_id ?? `action/${index}`, fact_class: item.fact_class, reason: 'acted_while_required_fact_unanswered' })));
  const askEvaluation = world && schedule ? evaluateAskSequence({ world, schedule, asks, answers, transitions }) : null;
  return { ok: overAsk.length === 0 && underAsk.length === 0 && (askEvaluation === null || askEvaluation.ok), version: ASK_POLICY_VERSION, errors: [], overAsk, underAsk, askEvaluation };
}

function validateInputs(world, projection, authorityState, asOf) {
  const errors = [];
  if (!world || !Array.isArray(world.hiddenFacts)) errors.push('world.hiddenFacts must be an array');
  if (!projection?.ok || !Array.isArray(projection.obligations)) errors.push('successful policy projection is required');
  if (!authorityState || !Array.isArray(authorityState.knownFactClasses) || !Array.isArray(authorityState.requiredFactClasses)) errors.push('authorityState fact-class arrays are required');
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) errors.push('asOf must be an ISO day');
  return errors;
}
function intersects(left, right) { return Array.isArray(right) && left.some((value) => right.includes(value)); }
