export const CORRECTION_EVENTS_VERSION = 'slice2.correctionEvents.v1';

const EVENT_TYPES = new Set(['owner_correction', 'entry_reversal', 'case_reopen']);

export function deriveCorrectionExpectations(worldSpec) {
  const events = Array.isArray(worldSpec?.events) ? worldSpec.events : [];
  const eventById = new Map(events.map((event) => [event?.id, event]));
  const expectations = events.filter((event) => EVENT_TYPES.has(event?.type)).map((event) => {
    const target = eventById.get(event.targetEventId);
    const common = {
      id: `causal-expectation/${event.id}`,
      eventId: event.id,
      targetEventId: event.targetEventId,
      preservedEventIds: [event.targetEventId, event.id],
      preservedReceiptIds: [...new Set([...(target?.receiptIds ?? []), ...(event.receiptIds ?? [])])].sort(),
    };
    if (event.type === 'owner_correction') {
      const locked = event.targetPeriodState === 'locked';
      return {
        ...common,
        kind: event.type,
        terminalState: 'resolved',
        requiredAction: locked ? 'dated_adjustment_journal' : 'correction_journal',
        adjustmentDate: locked ? event.adjustmentDate : event.occurredAt,
        inPlaceEditPermitted: false,
      };
    }
    if (event.type === 'entry_reversal') {
      return {
        ...common,
        kind: event.type,
        terminalState: 'resolved',
        requiredAction: 'reversal_entry',
        targetEntryId: event.targetEntryId,
        inPlaceEditPermitted: false,
      };
    }
    return {
      ...common,
      kind: event.type,
      terminalState: event.expectedTerminalState ?? 'blocked',
      requiredAction: 'reopen_case',
      triggerEvidenceRef: event.triggerEvidenceRef,
      inPlaceEditPermitted: false,
    };
  });
  return expectations.sort((left, right) => left.id.localeCompare(right.id));
}

export function evaluateCorrectionOutcomes(expectations, candidateOutcomes) {
  const outcomes = Array.isArray(candidateOutcomes) ? candidateOutcomes : [];
  const failures = [];
  for (const expected of expectations) {
    const candidates = outcomes.filter((outcome) => outcome?.eventId === expected.eventId);
    if (candidates.length !== 1) {
      failures.push(`causal.${expected.eventId}.expected_one_outcome_got_${candidates.length}`);
      continue;
    }
    const candidate = candidates[0];
    if (candidate.action !== expected.requiredAction) failures.push(`causal.${expected.eventId}.action expected ${expected.requiredAction} got ${candidate.action ?? '<missing>'}`);
    if (candidate.terminalState !== expected.terminalState) failures.push(`causal.${expected.eventId}.terminal expected ${expected.terminalState} got ${candidate.terminalState ?? '<missing>'}`);
    if (candidate.inPlaceEdit === true) failures.push(`causal.${expected.eventId}.in_place_edit_forbidden`);
    const preserved = new Set(Array.isArray(candidate.preservedEventIds) ? candidate.preservedEventIds : []);
    for (const eventId of expected.preservedEventIds) if (!preserved.has(eventId)) failures.push(`causal.${expected.eventId}.trail_missing.${eventId}`);
    const preservedReceipts = new Set(Array.isArray(candidate.preservedReceiptIds) ? candidate.preservedReceiptIds : []);
    for (const receiptId of expected.preservedReceiptIds) if (!preservedReceipts.has(receiptId)) failures.push(`causal.${expected.eventId}.receipt_trail_missing.${receiptId}`);
    if (expected.adjustmentDate && candidate.adjustmentDate !== expected.adjustmentDate) failures.push(`causal.${expected.eventId}.adjustment_date expected ${expected.adjustmentDate} got ${candidate.adjustmentDate ?? '<missing>'}`);
  }
  return [...new Set(failures)].sort();
}
