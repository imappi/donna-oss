// Decision lineage (audit spine) — traces every flat-column write and
// workflow action back to source claims, validators, and policy gates.
//
// Stored in `parse_summary.decision_lineage[]`. No migration needed.
//
// Usage:
//   const lineage = createLineageBuilder({ model_id, prompt_version });
//   lineage.record({
//     target: 'documents.total_amount',
//     value: 433.33,
//     source_claim: { role: 'amount_paid', raw_value: '£433.00', page: 2 },
//     confidence,
//     validator_outcomes: [...],
//     policy_blockers_considered: ['disallowed_amount_role'],
//     decision_lane: 'auto_write'
//   });
//   const entries = lineage.entries();

export const createLineageBuilder = ({ model_id = 'unknown', prompt_version = 'unknown' } = {}) => {
  const records = [];

  const record = ({
    target,
    value,
    source_claim = null,
    confidence = null,
    validator_outcomes = [],
    policy_blockers_considered = [],
    policy_blockers_triggered = [],
    decision_lane = 'auto_write'
  }) => {
    records.push({
      target,
      value: value ?? null,
      source_claim: source_claim ? {
        role: source_claim.role || null,
        raw_value: source_claim.raw_value || source_claim.value || null,
        page: source_claim.page || null,
        snippet: source_claim.snippet || null,
        source: source_claim.source || null
      } : null,
      confidence: confidence ? {
        normalized: confidence.normalized_confidence ?? confidence.normalized ?? null,
        band: confidence.decision_band ?? confidence.band ?? null
      } : null,
      validator_outcomes: validator_outcomes
        .filter((o) => o && typeof o === 'object')
        .map((o) => ({
          code: o.code || null,
          severity: o.severity || null,
          passed: o.passed ?? null
        })),
      model_id,
      prompt_version,
      policy_blockers_considered,
      policy_blockers_triggered,
      decision_lane,
      decided_at: new Date().toISOString()
    });
  };

  const recordSkip = ({ target, reason, policy_blockers_triggered = [] }) => {
    records.push({
      target,
      value: null,
      source_claim: null,
      confidence: null,
      validator_outcomes: [],
      model_id,
      prompt_version,
      policy_blockers_considered: [],
      policy_blockers_triggered,
      decision_lane: 'skipped',
      skip_reason: reason,
      decided_at: new Date().toISOString()
    });
  };

  const entries = () => [...records];

  return { record, recordSkip, entries };
};

export const buildLineageForGenericProjection = ({
  header,
  parties,
  amounts,
  dates,
  validationOutcomes = [],
  confidence = null,
  model_id = 'unknown',
  prompt_version = 'unknown'
} = {}) => {
  const lineage = createLineageBuilder({ model_id, prompt_version });

  if (header.vendor_name != null) {
    const sourceClaim = (parties || []).find(
      (p) => p.role === 'supplier' || p.role === 'merchant'
    );
    lineage.record({
      target: 'documents.vendor_name',
      value: header.vendor_name,
      source_claim: sourceClaim ? { role: sourceClaim.role, raw_value: sourceClaim.name } : null,
      confidence,
      validator_outcomes: validationOutcomes,
      policy_blockers_considered: ['disallowed_party_role'],
      decision_lane: 'auto_write'
    });
  } else if ((parties || []).length > 0) {
    lineage.recordSkip({
      target: 'documents.vendor_name',
      reason: 'no_party_with_allowed_role',
      policy_blockers_triggered: ['disallowed_party_role']
    });
  }

  if (header.total_amount != null) {
    const sourceClaim = (amounts || []).find(
      (a) => a.role === 'amount_paid' || a.role === 'amount_due' || a.role === 'total_gross'
    );
    lineage.record({
      target: 'documents.total_amount',
      value: header.total_amount,
      source_claim: sourceClaim ? { role: sourceClaim.role, raw_value: String(sourceClaim.value) } : null,
      confidence,
      validator_outcomes: validationOutcomes,
      policy_blockers_considered: ['disallowed_amount_role'],
      decision_lane: 'auto_write'
    });
  } else if ((amounts || []).length > 0) {
    lineage.recordSkip({
      target: 'documents.total_amount',
      reason: 'no_amount_with_allowed_role',
      policy_blockers_triggered: ['disallowed_amount_role']
    });
  }

  if (header.document_date != null) {
    const sourceClaim = (dates || []).find(
      (d) => d.role === 'document_date' || d.role === 'issue_date' || d.role === 'payment_date'
    );
    lineage.record({
      target: 'documents.document_date',
      value: header.document_date,
      source_claim: sourceClaim ? { role: sourceClaim.role, raw_value: sourceClaim.value } : null,
      confidence,
      validator_outcomes: validationOutcomes,
      policy_blockers_considered: ['disallowed_date_role'],
      decision_lane: 'auto_write'
    });
  }

  if (header.due_date != null) {
    const sourceClaim = (dates || []).find((d) => d.role === 'due_date');
    lineage.record({
      target: 'documents.due_date',
      value: header.due_date,
      source_claim: sourceClaim ? { role: sourceClaim.role, raw_value: sourceClaim.value } : null,
      confidence,
      validator_outcomes: validationOutcomes,
      policy_blockers_considered: [],
      decision_lane: 'auto_write'
    });
  }

  return lineage.entries();
};
