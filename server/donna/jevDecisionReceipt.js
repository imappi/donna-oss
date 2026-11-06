// Jev owner questions a DOCUMENT answers (evidence_type 'supporting_document');
// every other owner question is answered only by the owner. Both ask writers
// (the auto-post sweep and the correction lane) read this one list.
export const JEV_DOCUMENT_ASK_SELECTIONS = Object.freeze(['ask_statutory_source', 'ask_sales_source', 'ask_source_document']);

// A persisted, typed Jev resolution is the semantic decision. Its raw
// probability remains a receipt; it is not rewritten to satisfy an old floor.
export const hasJevResolvedCoding = (suggestion = {}) => suggestion.source === 'jev'
  && suggestion.decision_engine === 'jev'
  && suggestion.jev_decision?.terminal === 'resolved'
  && typeof suggestion.jev_decision.model === 'string'
  && suggestion.jev_decision.model === suggestion.model
  && Number.isFinite(suggestion.jev_decision.probability)
  && suggestion.jev_decision.probability >= 0 && suggestion.jev_decision.probability <= 1
  && (suggestion.posting_requirement === 'single_account' || (
    suggestion.posting_requirement === 'document_allocation'
    && suggestion.jev_decision.action === 'document_allocation'
    && Array.isArray(suggestion.document_allocations)
    && suggestion.jev_decision.coverage?.complete === true
    && suggestion.jev_decision.coverage.source_components > 0
    && suggestion.jev_decision.coverage.source_components === suggestion.document_allocations?.length
    && suggestion.jev_decision.coverage.selected_components === suggestion.document_allocations.length
    && new Set(suggestion.document_allocations.map(line => line?.line_handle)).size === suggestion.document_allocations.length
    && suggestion.document_allocations.every(line => line?.line_handle && line.account && line.tax_treatment)
  ))
  && suggestion.evidence_required === false;
