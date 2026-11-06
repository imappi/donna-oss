import { buildObservationSchedule, validateObservationSchedule } from './observationSchedule.js';
import { utcIsoDay } from './utcDay.js';

export const OWNER_CONTRACT_VERSION = 'eaw.owner-contract.v1';
export const OWNER_VARIANTS = Object.freeze(['precise', 'mistaken_then_corrected', 'non_responsive']);

export function createOwnerPersona({ worldSpec, schedule = buildObservationSchedule(worldSpec), personaId, variant = 'precise', replyLatencyDays = 0, correctionLatencyDays = 1, mistakenBeliefs = {} }) {
  const errors = inputErrors(worldSpec, schedule);
  if (!nonEmpty(personaId)) errors.push('personaId must be a non-empty string');
  if (!OWNER_VARIANTS.includes(variant)) errors.push('variant is not supported');
  if (!wholeDays(replyLatencyDays)) errors.push('replyLatencyDays must be a non-negative integer');
  if (!wholeDays(correctionLatencyDays) || correctionLatencyDays < 1) errors.push('correctionLatencyDays must be a positive integer');
  if (!plain(mistakenBeliefs)) errors.push('mistakenBeliefs must be an object');
  if (errors.length) return { ok: false, version: OWNER_CONTRACT_VERSION, errors };

  const facts = new Map(worldSpec.hiddenFacts.map((fact) => [fact.id, fact]));
  const knowledge = schedule.ownerFactContracts.map((contract) => ({
    hiddenFactId: contract.hiddenFactId,
    factKind: contract.factKind,
    value: clone(facts.get(contract.hiddenFactId).value),
    availableAt: contract.availableAt,
    askId: contract.askId,
  }));
  const beliefs = {};
  if (variant === 'mistaken_then_corrected') {
    for (const fact of knowledge) {
      const mistaken = mistakenBeliefs[fact.hiddenFactId];
      if (mistaken === undefined || equal(mistaken, fact.value)) errors.push(`mistakenBeliefs.${fact.hiddenFactId} must differ from assigned truth`);
      else beliefs[fact.hiddenFactId] = clone(mistaken);
    }
  } else if (Object.keys(mistakenBeliefs).length) {
    errors.push('mistakenBeliefs are only allowed for mistaken_then_corrected');
  }
  if (errors.length) return { ok: false, version: OWNER_CONTRACT_VERSION, errors };
  return {
    ok: true,
    version: OWNER_CONTRACT_VERSION,
    persona: {
      version: OWNER_CONTRACT_VERSION, personaId, variant, replyLatencyDays,
      correctionLatencyDays, reliability: variant === 'precise' ? 'reliable' : variant === 'mistaken_then_corrected' ? 'corrected' : 'unavailable',
      knowledge, mistakenBeliefs: beliefs,
    },
  };
}

export function answerOwnerAsk(persona, ask) {
  if (!plain(persona) || !plain(ask) || !nonEmpty(ask.askId) || !nonEmpty(ask.hiddenFactId) || !isoDay(ask.askedAt)) return refusal('invalid ask or persona');
  const fact = Array.isArray(persona.knowledge) && persona.knowledge.find(({ hiddenFactId }) => hiddenFactId === ask.hiddenFactId);
  if (!fact || ask.askId !== fact.askId) return refusal('ask is outside assigned knowledge');
  if (ask.askedAt < fact.availableAt) return refusal('assigned fact is not yet available');
  if (persona.variant === 'non_responsive') return { ok: true, version: OWNER_CONTRACT_VERSION, records: [], disposition: 'no_response' };
  const answeredAt = addDays(ask.askedAt, persona.replyLatencyDays);
  const common = { kind: 'owner_answer', askId: ask.askId, hiddenFactId: fact.hiddenFactId, factKind: fact.factKind, answeredAt, reliability: persona.reliability };
  if (persona.variant === 'precise') return { ok: true, version: OWNER_CONTRACT_VERSION, records: [{ ...common, value: clone(fact.value) }], disposition: 'answered' };
  if (persona.variant === 'mistaken_then_corrected') return {
    ok: true, version: OWNER_CONTRACT_VERSION, disposition: 'corrected', records: [
      { ...common, reliability: 'mistaken', value: clone(persona.mistakenBeliefs[fact.hiddenFactId]) },
      { ...common, kind: 'owner_corrected_answer', reliability: 'corrected', correctsRecordIndex: 0, answeredAt: addDays(answeredAt, persona.correctionLatencyDays), value: clone(fact.value) },
    ],
  };
  return refusal('unsupported persona variant');
}

export function runOwnerExchange(persona, ask) {
  const response = answerOwnerAsk(persona, ask);
  if (!response.ok) return response;
  const final = response.records.at(-1);
  return {
    ok: true, version: OWNER_CONTRACT_VERSION, ask: clone(ask), answerRecords: clone(response.records),
    resume: final ? { kind: 'resume', askId: ask.askId, resumedAt: final.answeredAt, evidence: { hiddenFactId: final.hiddenFactId, value: clone(final.value), reliability: final.reliability }, conclusionState: 'ready_to_resume' }
      : { kind: 'blocked', askId: ask.askId, conclusionState: 'waiting_on_owner' },
  };
}

export function qualifyOwnerPersona({ worldSpec, schedule = buildObservationSchedule(worldSpec), persona }) {
  const errors = inputErrors(worldSpec, schedule);
  if (!plain(persona)) return qualification(['persona must be an object']);
  if (persona.version !== OWNER_CONTRACT_VERSION) errors.push('persona version mismatch');
  if (!nonEmpty(persona.personaId)) errors.push('personaId must be a non-empty string');
  if (!OWNER_VARIANTS.includes(persona.variant)) errors.push('variant is not supported');
  if (!wholeDays(persona.replyLatencyDays)) errors.push('reply latency is invalid');
  if (!wholeDays(persona.correctionLatencyDays) || persona.correctionLatencyDays < 1) errors.push('correction latency is invalid');
  const expected = createOwnerPersona({ worldSpec, schedule, personaId: persona.personaId, variant: persona.variant, replyLatencyDays: persona.replyLatencyDays, correctionLatencyDays: persona.correctionLatencyDays, mistakenBeliefs: persona.mistakenBeliefs });
  if (!expected.ok) errors.push(...expected.errors);
  else {
    if (!equal(persona.knowledge, expected.persona.knowledge)) errors.push('assigned knowledge is not exactly the owner fact contracts');
    if (persona.reliability !== expected.persona.reliability) errors.push('reliability does not comply with variant');
    if (!equal(persona.mistakenBeliefs, expected.persona.mistakenBeliefs)) errors.push('mistaken belief script is inconsistent');
    for (const fact of expected.persona.knowledge) {
      const ask = { askId: fact.askId, hiddenFactId: fact.hiddenFactId, askedAt: fact.availableAt };
      const first = answerOwnerAsk(persona, ask);
      const replay = answerOwnerAsk(persona, clone(ask));
      if (!first.ok || !equal(first, replay)) errors.push(`response for ${fact.hiddenFactId} is not reproducible`);
      if (first.ok && !responseComplies(first, expected.persona, fact, ask)) errors.push(`response for ${fact.hiddenFactId} violates fidelity, delay, or reliability`);
    }
    const outside = answerOwnerAsk(persona, { askId: 'ask/unassigned/owner-fact', hiddenFactId: 'hidden/unassigned', askedAt: '2099-01-01' });
    if (outside.ok) errors.push('persona answers outside assigned knowledge');
  }
  return qualification(errors);
}

export function checkPersonaInvariance(pairs) {
  const errors = [];
  if (!Array.isArray(pairs) || pairs.length === 0) return { ok: false, version: OWNER_CONTRACT_VERSION, errors: ['equivalent pairs are required'] };
  for (const [index, pair] of pairs.entries()) {
    if (!plain(pair) || !plain(pair.left) || !plain(pair.right)) { errors.push(`pairs[${index}] must contain left and right`); continue; }
    for (const field of ['evidenceKey', 'reliability', 'answeredAt']) if (!equal(pair.left[field], pair.right[field])) errors.push(`pairs[${index}] is not equivalent on ${field}`);
    if (!equal(pair.left.accountingConclusion, pair.right.accountingConclusion) || !equal(pair.left.authorityDecision, pair.right.authorityDecision)) errors.push(`pairs[${index}] conclusion depends on persona presentation`);
  }
  return { ok: errors.length === 0, version: OWNER_CONTRACT_VERSION, errors };
}

function responseComplies(response, persona, fact, ask) {
  if (persona.variant === 'non_responsive') return response.disposition === 'no_response' && response.records.length === 0;
  const expectedAt = addDays(ask.askedAt, persona.replyLatencyDays);
  if (persona.variant === 'precise') return response.disposition === 'answered' && response.records.length === 1 && response.records[0].answeredAt === expectedAt && response.records[0].reliability === 'reliable' && equal(response.records[0].value, fact.value);
  return response.disposition === 'corrected' && response.records.length === 2 && response.records[0].answeredAt === expectedAt && response.records[0].reliability === 'mistaken' && equal(response.records[0].value, persona.mistakenBeliefs[fact.hiddenFactId]) && response.records[1].kind === 'owner_corrected_answer' && response.records[1].answeredAt === addDays(expectedAt, persona.correctionLatencyDays) && response.records[1].reliability === 'corrected' && equal(response.records[1].value, fact.value);
}

function inputErrors(worldSpec, schedule) {
  const built = buildObservationSchedule(worldSpec);
  if (!built.ok) return built.errors.map((error) => `world.${error}`);
  const valid = validateObservationSchedule(schedule, worldSpec);
  const errors = valid.errors.map((error) => `schedule.${error}`);
  if (valid.ok && !equal(schedule.ownerFactContracts, built.ownerFactContracts)) errors.push('schedule.ownerFactContracts do not match the world');
  return errors;
}
function qualification(errors) { return { ok: errors.length === 0, qualified: errors.length === 0, version: OWNER_CONTRACT_VERSION, errors }; }
function refusal(error) { return { ok: false, version: OWNER_CONTRACT_VERSION, errors: [error], records: [], disposition: 'refused' }; }
function addDays(day, count) { const date = new Date(`${day}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + count); return utcIsoDay(date); }
function clone(value) { return structuredClone(value); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function wholeDays(value) { return Number.isSafeInteger(value) && value >= 0; }
function isoDay(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
