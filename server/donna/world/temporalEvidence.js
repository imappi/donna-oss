import { deriveCorrectionExpectations } from './correctionEvents.js';
import { buildObservationSchedule, validateObservationSchedule } from './observationSchedule.js';

export const TEMPORAL_EVIDENCE_VERSION = 'slice2.temporalEvidence.v1';

export function buildTemporalEvidenceContracts(worldSpec) {
  const schedule = buildObservationSchedule(worldSpec);
  if (!schedule.ok) return result(schedule.errors);
  const validation = validateObservationSchedule(schedule, worldSpec);
  if (!validation.ok) return result(validation.errors);

  const reopenById = new Map(deriveCorrectionExpectations(worldSpec)
    .filter(({ kind }) => kind === 'case_reopen').map((expectation) => [expectation.eventId, expectation]));
  const contradictions = schedule.contradictionRecords.map((record) => {
    const reopen = reopenById.get(record.reopenEventId);
    return {
      ...record,
      requiredAction: 'reopen_case',
      expectedTerminalState: reopen?.terminalState,
      triggerEvidenceRef: reopen?.triggerEvidenceRef,
      reopenReceiptRequired: true,
    };
  });
  const retries = schedule.retryRecords.map((record) => ({
    ...record,
    unansweredOnly: true,
    identicalAskPermitted: false,
  }));
  const errors = [];
  for (const contradiction of contradictions) {
    if (!reopenById.has(contradiction.reopenEventId)) errors.push(`contradiction.${contradiction.observationId}.missing_case_reopen`);
    if (!contradiction.receiptId) errors.push(`contradiction.${contradiction.observationId}.missing_receipt`);
  }
  return errors.length ? result(errors) : { ok: true, version: TEMPORAL_EVIDENCE_VERSION, errors: [], schedule, contradictions, retries };
}

export function evaluateTemporalEvidence(contracts, candidate) {
  const failures = [];
  if (!contracts?.ok) return { ok: false, version: TEMPORAL_EVIDENCE_VERSION, failures: ['temporal.contracts_invalid'], receipts: [] };
  const reopenOutcomes = Array.isArray(candidate?.reopenOutcomes) ? candidate.reopenOutcomes : [];
  const askActivity = Array.isArray(candidate?.askActivity) ? candidate.askActivity : [];
  const receipts = [];

  for (const expected of contracts.contradictions) {
    const matches = reopenOutcomes.filter(({ reopenEventId }) => reopenEventId === expected.reopenEventId);
    if (matches.length !== 1) { failures.push(`contradiction.${expected.observationId}.expected_one_reopen_got_${matches.length}`); continue; }
    const outcome = matches[0];
    if (outcome.action !== 'reopen_case') failures.push(`contradiction.${expected.observationId}.case_not_reopened`);
    if (outcome.receiptId !== expected.receiptId) failures.push(`contradiction.${expected.observationId}.reopen_receipt_missing_or_wrong`);
    if (outcome.mutatedObservationIds?.length) failures.push(`contradiction.${expected.observationId}.history_mutated`);
    receipts.push({ contradictionReceiptId: expected.receiptId, reopenEventId: expected.reopenEventId, observedAt: expected.observedAt });
  }

  for (const contract of contracts.retries) {
    const activity = askActivity.filter(({ askId }) => askId === contract.askId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const answered = activity.find(({ kind }) => kind === 'answered');
    const nudges = activity.filter(({ kind }) => kind === 'nudge');
    if (nudges.length > contract.maxNudges) failures.push(`retry.${contract.askId}.nudge_limit_exceeded`);
    for (const nudge of nudges) {
      if (nudge.at <= contract.deferrableUntil) failures.push(`retry.${contract.askId}.before_deferral_window`);
      if (answered && nudge.at >= answered.at) failures.push(`retry.${contract.askId}.answered_fact_reasked`);
      if (nudge.contentDigest === candidate?.originalAskDigests?.[contract.askId]) failures.push(`retry.${contract.askId}.identical_ask_repeated`);
    }
    if (new Set(nudges.map(({ contentDigest }) => contentDigest)).size !== nudges.length) failures.push(`retry.${contract.askId}.identical_nudge_repeated`);
  }
  return { ok: failures.length === 0, version: TEMPORAL_EVIDENCE_VERSION, failures: [...new Set(failures)].sort(), receipts };
}

function result(errors) {
  return { ok: false, version: TEMPORAL_EVIDENCE_VERSION, errors, schedule: null, contradictions: [], retries: [] };
}
