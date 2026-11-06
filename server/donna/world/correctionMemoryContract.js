import { evaluateAskSequence } from './askContract.js';

export const CORRECTION_MEMORY_CONTRACT_VERSION = 'eaw.correction-memory.v1';

const MEMORY_STORES = new Set(['firm_facts', 'document_corrections']);

export function evaluateCorrectionMemoryContract(input) {
  const errors = validateInput(input);
  if (errors.length) return refusal(errors);

  const equivalent = input.case1.equivalenceKey === input.case2.equivalenceKey;
  const memory = input.runnerReceipt.memory;
  const persistedByProduction = memory.persisted === true
    && memory.operation === 'read_after_correction'
    && memory.writer === 'production_correction_path'
    && MEMORY_STORES.has(memory.store)
    && memory.sourceCorrectionEventId === input.correction.eventId;

  if (!persistedByProduction) errors.push('memory_not_persisted_by_production_correction_path');
  if (input.runnerReceipt.evalMintedMemory === true) errors.push('eval_minted_memory_refused');

  const ownerRecords = input.case1.ownerAnswerRecords;
  if (!Array.isArray(ownerRecords) || ownerRecords.length !== 2
    || ownerRecords[0]?.kind !== 'owner_answer' || ownerRecords[0]?.reliability !== 'mistaken'
    || ownerRecords[1]?.kind !== 'owner_corrected_answer' || ownerRecords[1]?.reliability !== 'corrected'
    || ownerRecords[1]?.correctsRecordIndex !== input.correction.targetAnswerRecordIndex
    || ownerRecords[0]?.askId !== ownerRecords[1]?.askId) {
    errors.push('case1_missing_mistaken_then_corrected_owner_shape');
  }

  const beforeAskScore = scoreAsks(input, input.case1);
  const afterAskScore = scoreAsks(input, input.case2);
  if (!beforeAskScore.ok) errors.push('case1_ask_evaluation_failed');
  if (!afterAskScore.ok) errors.push('case2_ask_evaluation_failed');

  const repeatedFactClasses = repeatedAskedFacts(input.case1.asks, input.case2.asks);
  if (equivalent && repeatedFactClasses.length) errors.push('equivalent_case_repeated_fact_class');

  const treatmentChanged = input.case1.initialTreatment !== input.case1.correctedTreatment;
  const inheritedCorrectedTreatment = input.case2.treatment === input.case1.correctedTreatment;
  if (!treatmentChanged) errors.push('case1_treatment_did_not_change');
  if (equivalent && !inheritedCorrectedTreatment) errors.push('equivalent_case_did_not_inherit_corrected_treatment');
  if (!equivalent && inheritedCorrectedTreatment && input.case2.memoryApplied === true) errors.push('non_equivalent_case_inherited_correction');
  if (equivalent && input.case2.memoryApplied !== true) errors.push('equivalent_case_missing_memory_application_receipt');

  const askDelta = {
    kind: 'ask_count_delta',
    case1Count: input.case1.asks.length,
    case2Count: input.case2.asks.length,
    delta: input.case2.asks.length - input.case1.asks.length,
    repeatedFactClasses,
    evaluatorVersion: beforeAskScore.version,
    beforePassed: beforeAskScore.ok,
    afterPassed: afterAskScore.ok,
  };
  const treatmentDelta = {
    kind: 'treatment_delta',
    initial: input.case1.initialTreatment,
    corrected: input.case1.correctedTreatment,
    case2: input.case2.treatment,
    equivalent,
    changed: treatmentChanged,
    inherited: equivalent && inheritedCorrectedTreatment,
  };

  return {
    ok: errors.length === 0,
    version: CORRECTION_MEMORY_CONTRACT_VERSION,
    errors: [...new Set(errors)].sort(),
    receipts: { askDelta, treatmentDelta, memory: structuredClone(memory) },
  };
}

function scoreAsks(input, subject) {
  return evaluateAskSequence({
    world: input.askEvaluation.world,
    schedule: input.askEvaluation.schedule,
    asks: subject.asks,
    answers: subject.answers ?? [],
    transitions: subject.transitions ?? [],
  });
}

function repeatedAskedFacts(before, after) {
  const seen = new Set(before.map(askFactClass));
  return [...new Set(after.map(askFactClass).filter((factClass) => seen.has(factClass)))].sort();
}

function askFactClass(ask) { return ask?.record?.fact_class ?? ask?.fact_class; }

function validateInput(input) {
  const errors = [];
  if (!plain(input)) return ['input must be an object'];
  for (const name of ['case1', 'case2', 'correction', 'runnerReceipt', 'askEvaluation']) {
    if (!plain(input[name])) errors.push(`${name} must be an object`);
  }
  if (errors.length) return errors;
  for (const [name, subject] of [['case1', input.case1], ['case2', input.case2]]) {
    if (!text(subject.caseId)) errors.push(`${name}.caseId must be a non-empty string`);
    if (!text(subject.equivalenceKey)) errors.push(`${name}.equivalenceKey must be a non-empty string`);
    if (!Array.isArray(subject.asks)) errors.push(`${name}.asks must be an array`);
    if (!text(subject.treatment ?? subject.initialTreatment)) errors.push(`${name} treatment must be declared`);
  }
  if (!text(input.case1.correctedTreatment)) errors.push('case1.correctedTreatment must be declared');
  if (!text(input.correction.eventId) || input.correction.kind !== 'owner_correction') errors.push('correction must identify an owner_correction event');
  if (!Number.isSafeInteger(input.correction.targetAnswerRecordIndex) || input.correction.targetAnswerRecordIndex < 0) errors.push('correction target answer record must be declared');
  if (!plain(input.runnerReceipt.memory)) errors.push('runnerReceipt.memory must be an object');
  if (typeof input.runnerReceipt.evalMintedMemory !== 'boolean') errors.push('runnerReceipt must declare evalMintedMemory');
  return errors;
}

function refusal(errors) {
  return { ok: false, version: CORRECTION_MEMORY_CONTRACT_VERSION, errors, receipts: null };
}
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.trim() !== ''; }
