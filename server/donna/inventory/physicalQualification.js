// Deterministic projection of persisted facts. This report never issues a pilot
// verdict, sign-off, historical bridge, or permission to change inventory.
import { physicalHash, physicalAskAcknowledged } from './physicalReconciliation.js';

const number = v => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)) ? Number(v) : null;
const id = v => String(v);
const rate = (numerator, denominator) => ({ numerator, denominator, fraction: denominator ? numerator / denominator : null });
const unavailable = reason => ({ status: 'unavailable', reason });
const duration = (start, end) => {
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
const summary = (values, denominator) => {
  const known = values.filter(v => v !== null).sort((a,b) => a-b);
  const quantile = q => known.length ? known[Math.max(0, Math.ceil(q * known.length) - 1)] : null;
  return { samples: known.length, denominator, unknown: denominator - known.length, p50Seconds: quantile(.5), p90Seconds: quantile(.9), method: 'nearest_rank' };
};
const observations = line => (line.payload?.versions || []).filter(v => v.kind === 'observation').map(v => v.observation);
const resolutions = line => (line.payload?.versions || []).filter(v => v.kind === 'resolution').map(v => v.resolution);

export function buildPhysicalQualification(snapshot, inputs = {}) {
  const { sourceDigest, ...source } = snapshot;
  if (snapshot.version !== 1 || sourceDigest !== physicalHash(source)) throw new Error('qualification_snapshot_integrity_refused');
  if (!['fixture','consented_pilot','test'].includes(inputs.cohort || 'test')) throw new Error('qualification_cohort_required');
  if (inputs.sourceDigest && inputs.sourceDigest !== sourceDigest) throw new Error('qualification_input_revision_refused');
  const problems = [];
  const paired = inputs.pairedGroundTruth || [];
  const keys = paired.map(p => `${p.sessionId}:${p.lineId}:${p.observationDigest}`);
  if (new Set(keys).size !== keys.length) throw new Error('qualification_duplicate_pair');
  const allRows = [];
  const sessions = snapshot.sessions.map(session => {
    const lines = snapshot.lines.filter(l => id(l.count_session_id) === id(session.id));
    const asks = snapshot.asks.filter(a => id(a.request_payload?.physical_session_id) === id(session.id));
    const rows = lines.map(line => {
      const observation = line.physical_observation;
      const resolution = line.physical_resolution;
      const attempts = observations(line);
      if (observation && !attempts.some(o=>o.inputDigest===observation.inputDigest)) attempts.push(observation);
      const history = resolutions(line);
      const expected = number(line.expected_quantity), quantity = number(observation?.quantity);
      const refs = observation?.evidenceRefs || [];
      const changedEvidence = refs.some(ref => !snapshot.documents.some(d => d.id === ref.documentId && d.checksum_sha256 === ref.checksum && d.storage_object_key));
      const laterMovements = snapshot.operations.filter(op => op.item_id === line.item_id && op.location_id === line.location_id
        && !(line.physical_basis?.operationIds || []).includes(id(op.id)) && id(op.id) !== id(resolution?.operationId));
      const staleReasons = [changedEvidence && 'evidence_changed_or_missing', laterMovements.length > 0 && 'movement_after_pinned_basis',
        observation && observation.expectedDigest !== line.physical_basis?.inputDigest && 'observation_basis_changed'].filter(Boolean);
      const confirmed = Boolean(observation?.humanConfirmed && !observation.uncertain && quantity !== null);
      const sufficient = confirmed && refs.length > 0 && !staleReasons.length && !['dismissed','recount_required','uncertain'].includes(line.physical_status);
      const cost = line.physical_basis?.valuation;
      const carryingValue = cost?.status === 'priced' ? number(cost.carryingValue) : null;
      const unitCost = cost?.status === 'priced' ? number(cost.unitCost) : null;
      const ownAsks = asks.filter(a => id(a.request_payload?.physical_count_line_id) === id(line.id));
      const activeAsks = ownAsks.filter(a => ['draft','open','replied'].includes(a.status));
      const accounting = resolution?.accounting;
      const physicalTerminal = ['matched','applied'].includes(line.physical_status);
      const accountingComplete = line.physical_status === 'matched' || (line.physical_status === 'applied'
        && ['posted','replayed','no_journal_required'].includes(accounting?.status)
        && (!accounting.reconciliation || accounting.reconciliation.verdict?.reconciliation_status === 'reconciled'));
      const workflowComplete = physicalTerminal && accountingComplete && !activeAsks.length && !line.payload?.owner;
      const pairs = paired.filter(p => id(p.sessionId) === id(session.id) && id(p.lineId) === id(line.id)).map(truth => {
        const observed = attempts.find(o=>o.inputDigest===truth.observationDigest);
        const original = (line.payload?.versions || []).find(v=>v.before?.basis?.inputDigest===truth.expectationDigest)?.before?.basis;
        const pinned = original || (observed?.expectedDigest===line.physical_basis?.inputDigest ? line.physical_basis : null);
        const pairExpected = pinned?.expectedQuantity ?? (observed?.variance != null && observed.quantity != null ? observed.quantity-observed.variance : pinned === line.physical_basis ? expected : null);
        const valid = inputs.sourceDigest === sourceDigest && observed && truth.expectationDigest === observed.expectedDigest
          && pairExpected !== null && number(truth.quantity) !== null && Number(truth.quantity) >= 0
          && truth.actorId && truth.actorId !== observed.actorId && truth.blind === true && truth.sourceReference
          && truth.independent === true && Number.isFinite(Date.parse(truth.observedAt)) && truth.environment && truth.failureClass
          && Date.parse(truth.observedAt) >= Date.parse(pinned?.cutoff) && Date.parse(truth.observedAt) <= Date.parse(snapshot.asOf);
        if (!valid) { problems.push(`pair:${session.id}:${line.id}:${truth.observationDigest}`); return unavailable('invalid_or_unbound_independent_pair'); }
        // Both counters must describe the same physical state. A later move
        // does not invalidate historical counts, but a move outside their pinned
        // basis and before either count finished requires a new pair, not a bridge.
        const pairedEnd = Math.max(Date.parse(observed.observedAt), Date.parse(truth.observedAt));
        const incompatibleMovement = snapshot.operations.some(op => op.item_id === line.item_id && op.location_id === line.location_id
          && !(pinned?.operationIds || []).includes(id(op.id))
          && (!Number.isFinite(Date.parse(op.occurred_at)) || Date.parse(op.occurred_at) <= pairedEnd));
        if (!Number.isFinite(pairedEnd) || incompatibleMovement) {
          problems.push(`pair_movement:${session.id}:${line.id}:${truth.observationDigest}`);
          return unavailable('paired_window_movement_or_timing_unknown');
        }
        const discrepancy = Number(truth.quantity) !== Number(pairExpected);
        const pairConfirmed = observed.humanConfirmed && !observed.uncertain && number(observed.quantity) !== null;
        const detected = pairConfirmed && observed.quantity !== Number(pairExpected);
        return { status: 'available', observationDigest: observed.inputDigest, expectationDigest: truth.expectationDigest,
          sourceReference: truth.sourceReference, actorId: truth.actorId, observedAt: truth.observedAt,
          environment: truth.environment, failureClass: truth.failureClass, quantity: Number(truth.quantity), discrepancy,
          value: pinned?.valuation?.status === 'priced' && number(pinned.valuation.unitCost) !== null ? {
            currency: pinned.valuation.currency, truthVariance: ((Number(truth.quantity)-Number(pairExpected))*Number(pinned.valuation.unitCost)) || 0,
            observedVariance: number(observed.quantity) === null ? null : ((observed.quantity-Number(pairExpected))*Number(pinned.valuation.unitCost)) || 0
          } : unavailable('paired_cost_basis_unavailable'),
          detected: discrepancy && detected, falseSupported: discrepancy && pairConfirmed && observed.quantity === Number(pairExpected),
          falseAlarm: !discrepancy && detected, exactCountAgreement: pairConfirmed && observed.quantity === Number(truth.quantity),
          material: typeof truth.material === 'boolean' && inputs.materialityPolicyReference ? truth.material : null,
          attentionRaised: observed.uncertain || observed.variance !== 0, confidence: observed.confidence ?? null };
      });
      const pair = pairs.find(p=>p.observationDigest===observation?.inputDigest) || unavailable('independent_paired_ground_truth_missing');
      const independentValidation = pair.status !== 'available' || !confirmed ? 'unknown' : pair.exactCountAgreement ? 'corroborated' : 'contradicted';
      // Workflow termination is persisted fact; an independently contradicted
      // count is not a successful reconciliation. Missing pairing stays unknown.
      const complete = workflowComplete && independentValidation !== 'contradicted';
      const reportedReviewSeconds = history.map(r => number(r.learning?.reviewer?.seconds));
      const row = { sessionId: id(session.id), lineId: id(line.id), itemId: line.item_id, locationId: line.location_id, uomId: line.uom_id,
        status: line.physical_status, expected, quantity, uncertain: !confirmed, workflowComplete, independentValidation, complete,
        coverage: { sufficientAtPinnedBasis: sufficient && (pair.status !== 'available' || pair.exactCountAgreement), carryingValue, unitCost, currency: cost?.currency || null,
          unavailableCostBasis: carryingValue === null, currentFreshness: staleReasons.length ? 'detected_stale' : 'not_fully_evaluated', staleReasons,
          limitation: 'Admitted confirmed-quantity coverage at the pinned basis; independent pairing may still be missing. Current policy, identity, UOM and accounting changes require existing apply-time revalidation.' },
        versions: { expectationDigest: line.physical_basis?.inputDigest, observationDigest: observation?.inputDigest || null,
          protocol: line.physical_basis?.protocol || null, observationVersion: observation?.version || null,
          modelStatus: observation?.modelStatus || 'not_used', modelReceipt: observation?.modelReceipt || null,
          observationAttempts: attempts.map(o => ({ digest: o.inputDigest, version: o.version, receivedAt: o.receivedAt, uncertain: o.uncertain, quantity: o.quantity })) },
        evidence: attempts.flatMap(o=>o.evidenceRefs || []).map(r => ({ documentId: r.documentId, checksum: r.checksum, size: number(r.size), sourceGroup: r.sourceGroup, receivedAt: r.receivedAt })),
        observationAttempts: attempts.length, repeatedAttempts: Math.max(0, attempts.length - 1),
        timing: { firstReceiptAt: attempts[0]?.receivedAt || null, latestReceiptAt: observation?.receivedAt || null,
          reviewWaitSeconds: duration(observation?.receivedAt, resolution?.resolvedAt), reportedReviewSeconds,
          activeWorkerSeconds: unavailable('notes.active_seconds is elapsed mount time, not an activity clock'),
          activeReviewerSeconds: unavailable('reviewSeconds is client-reported elapsed mount time; includes idle/background time') },
        asks: ownAsks.map(a => ({ id: a.id, status: a.status, audience: a.audience, recipient: a.addressee_principal_id,
          sendCount: number(a.send_count), acknowledged: physicalAskAcknowledged(a), dueAt: a.due_at,
          overdue: ['draft','open','replied'].includes(a.status) && Date.parse(a.due_at) < Date.parse(snapshot.asOf) })),
        consequence: { operationId: resolution?.operationId || null, accounting: accounting || { status: 'not_applied' },
          laterOutcome: line.payload?.laterOutcome || resolution?.learning?.laterOutcome || { status: 'unknown' },
          reuse: resolution?.learning?.reuse || { eligible: false, exclusionReason: 'No adjudicated resolution.' } }, pairs, pair };
      allRows.push(row); return row;
    });
    const priced = rows.filter(r => r.coverage.carryingValue !== null);
    const currencies = [...new Set(priced.map(r => r.coverage.currency))];
    const selectedValue = currencies.length === 1 && priced.length === rows.length && rows.length ? priced.reduce((s,r) => s+r.coverage.carryingValue,0) : null;
    const observedValue = selectedValue === null ? null : rows.filter(r => r.coverage.sufficientAtPinnedBasis).reduce((s,r) => s+r.coverage.carryingValue,0);
    const population = (inputs.populations || []).find(p => id(p.sessionId) === id(session.id));
    const sameBasis = population && inputs.sourceDigest === sourceDigest && population.sourceReference
      && population.currency === currencies[0] && number(population.totalCarryingValue) !== null && selectedValue !== null && Number(population.totalCarryingValue) >= selectedValue
      && population.basisDigest === physicalHash(lines.map(l => ({ lineId: id(l.id), digest: l.physical_basis?.inputDigest })).sort((a,b)=>a.lineId.localeCompare(b.lineId)));
    const receiptTimes = rows.map(r => r.timing.latestReceiptAt);
    const lastReceipt = receiptTimes.every(t => t && Number.isFinite(Date.parse(t))) && rows.length ? receiptTimes.slice().sort().at(-1) : null;
    return { sessionId: id(session.id), state: session.state, admittedAt: session.opened_at, closedAt: session.closed_at,
      scope: session.scope, selectedItems: rows.length, sufficientItems: rate(rows.filter(r => r.coverage.sufficientAtPinnedBasis).length, rows.length),
      // Quantities in different UOMs are never added into a meaningless total.
      quantityCoverageByUom: [...new Set(rows.map(r=>r.uomId))].map(uomId => {
        const group = rows.filter(r=>r.uomId===uomId), known = group.filter(r=>r.expected !== null && r.expected >= 0);
        return { uomId, unknownItems: group.length-known.length, expectedUnits: known.reduce((s,r)=>s+r.expected,0),
          coveredExpectedUnits: known.filter(r=>r.coverage.sufficientAtPinnedBasis).reduce((s,r)=>s+r.expected,0) };
      }),
      valueCoverage: { currency: currencies.length === 1 ? currencies[0] : null, selectedValue, observedValue,
        unknownCostItems: rows.length-priced.length, selectedCoverage: selectedValue === null ? unavailable('missing_or_mixed_cost_basis') : rate(observedValue, selectedValue),
        populationCoverage: sameBasis && observedValue !== null ? { ...rate(observedValue, Number(population.totalCarryingValue)),
          untestedValue: Number(population.totalCarryingValue)-observedValue, sourceReference: population.sourceReference }
          : unavailable('complete_same_cutoff_population_cost_basis_missing_or_unbound') },
      complete: rows.length > 0 && rows.every(r=>r.complete), limitedItems: rows.filter(r=>r.status==='dismissed').length,
      incompleteItems: rows.filter(r=>!r.complete).length, staleItems: rows.filter(r=>r.coverage.staleReasons.length).length,
      timing: { elapsedToAllCurrentSubmissionsSeconds: duration(session.opened_at,lastReceipt),
        elapsedToPhysicalCloseSeconds: duration(session.opened_at,session.closed_at),
        limitation: 'Physical close may include dismissed items or outstanding accounting. Elapsed time includes all waiting.' }, rows };
  });
  for (const truth of paired) if (!allRows.some(r=>r.sessionId===id(truth.sessionId)&&r.lineId===id(truth.lineId))) problems.push(`unknown_pair:${truth.sessionId}:${truth.lineId}`);
  const validPairs = allRows.flatMap(r=>r.pairs.filter(p=>p.status==='available').map(pair=>({...r,pair})));
  const pairedLines = new Set(validPairs.map(r=>`${r.sessionId}:${r.lineId}`)).size;
  const knownDiscrepancies = validPairs.filter(r=>r.pair.discrepancy===true);
  const asks = allRows.flatMap(r=>r.asks);
  const evidence = new Map(allRows.flatMap(r=>r.evidence).map(e=>[`${e.documentId}:${e.checksum}`,e]));
  const observationAttempts = allRows.reduce((s,r)=>s+r.observationAttempts,0);
  const reported = allRows.flatMap(r=>r.timing.reportedReviewSeconds);
  // Separately supplied operator measurements are labelled as such. Do not
  // transform browser mount timers into active work, costs or baseline speed.
  const measurements = (inputs.sessionMeasurements || []).filter(m => {
    const valid = inputs.sourceDigest === sourceDigest && sessions.some(s=>s.sessionId===id(m.sessionId)) && m.actorId && m.sourceReference;
    if (!valid) problems.push(`measurement:${m.sessionId}`);
    return valid;
  });
  if (new Set(measurements.map(m=>id(m.sessionId))).size !== measurements.length) throw new Error('qualification_duplicate_measurement');
  const measured = field => summary(sessions.map(s=>{
    const value=number(measurements.find(m=>id(m.sessionId)===s.sessionId)?.[field]);
    return value !== null && value>=0 ? value : null;
  }),sessions.length);
  const externalMeasurements = { provenance: 'separately_supplied_attributable_operator_records; not inferred from persisted application events',
    ownerActiveTime: measured('ownerActiveSeconds'), reviewerActiveTime: measured('reviewerActiveSeconds'),
    manualBaselineTime: measured('manualBaselineSeconds'),
    costs: sessions.map(s=>{
      const m=measurements.find(m=>id(m.sessionId)===s.sessionId),costs=m?.costs;
      const amount=field=>{const value=number(costs?.[field]);return value!==null&&value>=0?value:null;};
      return { sessionId:s.sessionId, currency:/^[A-Z]{3}$/.test(costs?.currency || '')?costs.currency:null,
        inferenceAmount:amount('inferenceAmount'), mediaStorageAmount:amount('mediaStorageAmount'), operatorAmount:amount('operatorAmount'),
        sourceReference:m?.sourceReference || null, actorId:m?.actorId || null };
    }), records: measurements };
  return { version: 1, sourceDigest, inputDigest: physicalHash(inputs), asOf: snapshot.asOf, scope: snapshot.scope,
    cohort: inputs.cohort || 'test', qualificationStatus: 'pending_human_ratification_and_real_pilot_evidence',
    sample: { admittedSessions: sessions.length, admittedLines: allRows.length, pairedLines, pairedObservations: validPairs.length, admittedObservations: allRows.reduce((n,r)=>n+r.observationAttempts,0),
      missingPairs: allRows.length-pairedLines, unpairedObservations: allRows.reduce((n,r)=>n+r.observationAttempts,0)-validPairs.length, environments: [...new Set(validPairs.map(r=>r.pair.environment))],
      protocols: [...new Set(allRows.map(r=>r.versions.protocol))] },
    completion: { sessions: rate(sessions.filter(s=>s.complete).length,sessions.length),
      lines: rate(allRows.filter(r=>r.complete).length,allRows.length), limitedLines: allRows.filter(r=>r.status==='dismissed').length,
      staleLines: allRows.filter(r=>r.coverage.staleReasons.length).length,
      submissionTime: summary(sessions.map(s=>s.timing.elapsedToAllCurrentSubmissionsSeconds),sessions.length),
      physicalCloseTime: summary(sessions.map(s=>s.timing.elapsedToPhysicalCloseSeconds),sessions.length),
      reviewWaitTime: summary(allRows.map(r=>r.timing.reviewWaitSeconds),allRows.length),
      reportedReviewTime: summary(reported, reported.length), reportedReviewTotalSeconds: reported.reduce((s,v)=>s+(v || 0),0),
      activeWorkerTime: unavailable('no persisted active intervals'), activeReviewTime: unavailable('no persisted active intervals') },
    detection: { knownDiscrepancies: knownDiscrepancies.length, detection: rate(knownDiscrepancies.filter(r=>r.pair.detected).length,knownDiscrepancies.length),
      falseSupported: rate(knownDiscrepancies.filter(r=>r.pair.falseSupported).length,knownDiscrepancies.length),
      falseAlarms: rate(validPairs.filter(r=>r.pair.falseAlarm).length,validPairs.filter(r=>r.pair.discrepancy===false).length),
      exactCountAgreement: rate(validPairs.filter(r=>r.pair.exactCountAgreement).length,validPairs.length),
      materialDetection: rate(knownDiscrepancies.filter(r=>r.pair.material===true&&r.pair.detected).length,knownDiscrepancies.filter(r=>r.pair.material===true).length),
      valueDetection: rate(knownDiscrepancies.filter(r=>r.pair.value.status!=='unavailable'&&r.pair.value.truthVariance!==0&&r.pair.detected&&r.pair.value.observedVariance!==0).length,
        knownDiscrepancies.filter(r=>r.pair.value.status!=='unavailable'&&r.pair.value.truthVariance!==0).length),
      valueBasisUnavailablePairs: validPairs.filter(r=>r.pair.value.status==='unavailable').length,
      materialFalseSupported: validPairs.filter(r=>r.pair.material===true&&r.pair.falseSupported).length,
      materialityUnknown: validPairs.filter(r=>r.pair.material===null).length,
      byFailureClass: [...new Set(validPairs.map(r=>r.pair.failureClass))].map(failureClass=>({ failureClass,
        paired: validPairs.filter(r=>r.pair.failureClass===failureClass).length,
        discrepancies: validPairs.filter(r=>r.pair.failureClass===failureClass&&r.pair.discrepancy===true).length,
        detected: validPairs.filter(r=>r.pair.failureClass===failureClass&&r.pair.detected).length })) },
    burden: { observationAttempts, repeatedAttempts: allRows.reduce((s,r)=>s+r.repeatedAttempts,0),
      admittedAsks: asks.length, acknowledgedAsks: asks.filter(a=>a.acknowledged).length,
      undeliveredAsks: asks.filter(a=>!a.acknowledged).length, activeAsks: asks.filter(a=>['draft','open','replied'].includes(a.status)).length,
      overdueAsks: asks.filter(a=>a.overdue).length,
      byAudience: [...new Set(asks.map(a=>a.audience || 'unknown'))].map(audience=>({audience,count:asks.filter(a=>(a.audience || 'unknown')===audience).length})),
      uniqueEvidenceDocuments: evidence.size, knownBytes: [...evidence.values()].reduce((s,e)=>s+(e.size || 0),0),
      unknownSizeDocuments: [...evidence.values()].filter(e=>e.size===null).length,
      independence: 'Repeated photos/counts from the same source group do not increase independence.',
      failedUploads: unavailable('failed uploads before admission are not persisted'),
      staleApplyRefusalRate: unavailable('refused attempts roll back; successful command receipts cannot supply the denominator') },
    noChange: { humanCounts: rate(allRows.filter(r=>r.complete&&r.status==='matched'&&r.versions.modelStatus==='not_used'&&!resolutions(snapshot.lines.find(l=>id(l.id)===r.lineId)).length).length,observationAttempts),
      adjustmentAutomation: unavailable('pilot adjustments require independent human acceptance'),
      repeatExceptionAutomation: unavailable('no paired subsequent-occurrence quality validation') },
    externalMeasurements,
    missingInputs: [!inputs.sourceDigest && 'revision_bound_external_inputs', validPairs.length < observationAttempts && 'independent_paired_ground_truth_for_all_observation_versions',
      sessions.some(s=>s.valueCoverage.populationCoverage.status==='unavailable') && 'complete_same_cutoff_population_value_basis',
      (externalMeasurements.ownerActiveTime.unknown || externalMeasurements.reviewerActiveTime.unknown) && 'active_worker_and_reviewer_intervals',
      'failed_upload_and_apply_attempt_denominators',
      externalMeasurements.costs.some(c=>!c.currency || c.inferenceAmount===null || c.mediaStorageAmount===null || c.operatorAmount===null) && 'inference_storage_and_operator_costs',
      'compatible_device_session_denominator', 'real_iOS_Safari_and_Android_Chrome_results', 'consent_retention_transfer_and_staffing_ratifications',
      'two_consecutive_real_close_receipts_and_domain_reviewer_acceptance', 'switching_retention_and_post_close_correction_evidence'].filter(Boolean),
    inputProblems: problems, sessions,
    limitations: ['Fixture and automated test results are not pilot success.', 'Coverage is not assurance; no statistical assurance from zero observed errors.',
      'Current pinned counts do not support historical periods or service sign-off.', 'No customer enrollment, inference, stock or ledger writes.'] };
}

export function renderPhysicalQualification(report) {
  const display = v => v === null ? 'Unknown' : String(v);
  const fraction = r => `${r.numerator}/${r.denominator}${r.fraction === null ? ' (undefined)' : ` (${(r.fraction*100).toFixed(1)}%)`}`;
  return [ '# Donna physical pilot qualification', '', `Cohort: ${report.cohort}. Status: ${report.qualificationStatus}.`,
    `Snapshot: ${report.sourceDigest}. As of: ${report.asOf}.`, '',
    `Admitted: ${report.sample.admittedSessions} sessions, ${report.sample.admittedLines} lines. Independent pairs: ${report.sample.pairedLines}; missing/invalid: ${report.sample.missingPairs}.`,
    `Completed reconciliation workflow without known contradiction: ${fraction(report.completion.sessions)} sessions; ${fraction(report.completion.lines)} lines. Limited lines: ${report.completion.limitedLines}; detected stale: ${report.completion.staleLines}.`,
    `Quantity discrepancy detection: ${fraction(report.detection.detection)}. False-supported: ${fraction(report.detection.falseSupported)}. False alarms: ${fraction(report.detection.falseAlarms)}.`,
    'Completed workflow is not independent validation: missing pairs remain unknown.',
    `Material false-supported: ${report.detection.materialFalseSupported}; paired materiality unknown: ${report.detection.materialityUnknown}.`,
    `Material discrepancy detection: ${fraction(report.detection.materialDetection)}. Nonzero value discrepancy detection: ${fraction(report.detection.valueDetection)}; paired cost unavailable: ${report.detection.valueBasisUnavailablePairs}.`,
    `Submission elapsed p50/p90 seconds: ${display(report.completion.submissionTime.p50Seconds)}/${display(report.completion.submissionTime.p90Seconds)}; samples ${report.completion.submissionTime.samples}/${report.completion.submissionTime.denominator}. Active time unavailable.`,
    `Reported review seconds: ${report.completion.reportedReviewTotalSeconds}; unknown entries ${report.completion.reportedReviewTime.unknown}. These are reported elapsed times, not active reviewer minutes.`,
    `Separately logged active time: owner samples ${report.externalMeasurements.ownerActiveTime.samples}/${report.sample.admittedSessions}; reviewer samples ${report.externalMeasurements.reviewerActiveTime.samples}/${report.sample.admittedSessions}; manual baseline samples ${report.externalMeasurements.manualBaselineTime.samples}/${report.sample.admittedSessions}. See attributable records in the JSON report.`,
    `Evidence: ${report.burden.uniqueEvidenceDocuments} documents; ${report.burden.knownBytes} known bytes; ${report.burden.unknownSizeDocuments} unknown sizes. Attempts: ${report.burden.observationAttempts}; repeated ${report.burden.repeatedAttempts}.`,
    `Asks: ${report.burden.admittedAsks}; acknowledged ${report.burden.acknowledgedAsks}; undelivered ${report.burden.undeliveredAsks}; active ${report.burden.activeAsks}; overdue ${report.burden.overdueAsks}.`, '',
    '| Session | Complete | Sufficient selected items | Selected value | Observed value | Population coverage |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.sessions.map(s=>`| ${s.sessionId} | ${s.complete} | ${fraction(s.sufficientItems)} | ${display(s.valueCoverage.selectedValue)} ${s.valueCoverage.currency || ''} | ${display(s.valueCoverage.observedValue)} | ${s.valueCoverage.populationCoverage.status === 'unavailable' ? 'Unavailable' : fraction(s.valueCoverage.populationCoverage)} |`),
    '', '| Session | Cost currency | Inference | Media/storage | Operator |', '| --- | --- | --- | --- | --- |',
    ...report.externalMeasurements.costs.map(c=>`| ${c.sessionId} | ${c.currency || 'Unknown'} | ${display(c.inferenceAmount)} | ${display(c.mediaStorageAmount)} | ${display(c.operatorAmount)} |`),
    '', 'Missing qualification inputs:', ...report.missingInputs.map(v=>`- ${v}`),
    ...report.inputProblems.map(v=>`- Invalid input: ${v}`), '', ...report.limitations.map(v=>`- ${v}`), '' ].join('\n');
}
