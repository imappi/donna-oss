// Donna — the firm_facts → memory.v1 ONE-WAY compatibility projection (BizOS Slice 2a).
//
// NOT "lossless in both directions" (Kari amendment 5): a firm_facts row does not carry
// the v2 model's confidences, sensitivity, visibility, truth validity, review horizon,
// asserting actor, or relations — so this view maps what the legacy row ACTUALLY says and
// marks everything else `legacy_unspecified` (or null where the contract allows null).
// Nothing is invented: legacy `confidence` stays `legacy_confidence` (one historical field
// must not acquire two new meanings), `truth_confidence` is null, and consumers FAIL CLOSED
// on `legacy_unspecified` wherever the missing value matters (the 2c retrieval service
// treats unspecified sensitivity as confidential/personal for filtering).
//
// The honest round trip — the ONLY equivalence claimed:
//     firm_fact → firmFactAsMemoryView → legacyFirmFactProjection === original firm_fact
// proving every legacy field is preserved. There is no memory.v1 → firm_facts direction.
//
// Lifecycle mapping (amendment 4): a client-scoped fact DIES WITH ITS CLIENT today
// (purgeFirmFactsForDeletedClient), so it projects to a legal_entity-rooted lifecycle —
// never `organisation`. Merchant/jurisdiction/firm-scoped facts are practice memory and
// project to the organisation lifecycle rooted at the firm.
//
// firm_facts stays FROZEN (no new features) and authoritative for its lifecycle until the
// §7 graduation criteria are met. Pure leaf: no imports.

export const FIRM_FACT_MEMORY_VIEW_VERSION = 'firm_fact_memory_view.v1';
export const LEGACY_UNSPECIFIED = 'legacy_unspecified';

// scope → subject_type is invertible by construction (the round-trip hinge).
const LEGACY_SUBJECT_TYPES = Object.freeze({
  merchant: 'legacy_merchant_pattern',   // a MATCHER, not an entity identity (§3)
  client: 'legacy_client_key',           // UEN/name key — an external identifier
  jurisdiction: 'legacy_jurisdiction_code',
  firm: 'legacy_firm'
});
const LEGACY_SCOPES_BY_SUBJECT_TYPE = Object.freeze(
  Object.fromEntries(Object.entries(LEGACY_SUBJECT_TYPES).map(([scope, type]) => [type, scope]))
);

export const firmFactAsMemoryView = (fact = {}) => {
  if (!fact || typeof fact !== 'object' || !fact.id || !fact.firm_id) {
    throw new Error('firmFactAsMemoryView requires a firm_facts row with id and firm_id');
  }
  if (!LEGACY_SUBJECT_TYPES[fact.scope]) {
    throw new Error(`firmFactAsMemoryView: unknown legacy scope "${fact.scope}"`);
  }
  const clientRooted = fact.scope === 'client';
  const provenanceClientId = fact.provenance && typeof fact.provenance === 'object'
    ? (fact.provenance.client_id || null)
    : null;
  return Object.freeze({
    view_version: FIRM_FACT_MEMORY_VIEW_VERSION,
    source_fact_id: fact.id,

    tenant_id: fact.firm_id,
    scope_type: clientRooted ? 'legal_entity' : 'organisation',
    scope_id: clientRooted ? (provenanceClientId || LEGACY_UNSPECIFIED) : fact.firm_id,
    lifecycle_owner_type: clientRooted ? 'legal_entity' : 'organisation',
    lifecycle_owner_id: clientRooted ? (provenanceClientId || LEGACY_UNSPECIFIED) : fact.firm_id,

    subject_type: LEGACY_SUBJECT_TYPES[fact.scope],
    subject_id: fact.subject,

    kind: 'assertion',
    predicate: 'legacy_fact',
    source_text: fact.fact,
    structured_value: null,

    asserted_by_principal_id: LEGACY_UNSPECIFIED,
    assertion_origin: LEGACY_UNSPECIFIED,
    transport_actor: null,
    extraction_model_id: fact.model ?? null,
    creation_provenance: fact.provenance ?? {},

    legacy_confidence: fact.confidence,   // preserved AS ITSELF — never split into two
    assertion_confidence: LEGACY_UNSPECIFIED,
    truth_confidence: null,               // unknown is honest; invented is not

    confidentiality: LEGACY_UNSPECIFIED,  // consumers fail closed (treat as confidential)
    personal_data_class: LEGACY_UNSPECIFIED, // consumers fail closed (treat as personal)

    valid_from: null,
    valid_until: null,
    review_after: null,
    retain_until: null,

    record_state: fact.status,            // 'active' | 'dismissed' — same words, same meaning
    epistemic_state: 'asserted',

    recorded_at: fact.created_at,
    legacy_updated_at: fact.updated_at
  });
};

// The inverse over the view's LEGACY-DERIVED fields — proves preservation, nothing more.
export const legacyFirmFactProjection = (view = {}) => {
  if (view?.view_version !== FIRM_FACT_MEMORY_VIEW_VERSION) {
    throw new Error('legacyFirmFactProjection requires a firm_fact_memory_view.v1 object');
  }
  const scope = LEGACY_SCOPES_BY_SUBJECT_TYPE[view.subject_type];
  if (!scope) throw new Error(`legacyFirmFactProjection: unknown subject_type "${view.subject_type}"`);
  return {
    id: view.source_fact_id,
    firm_id: view.tenant_id,
    scope,
    subject: view.subject_id,
    fact: view.source_text,
    provenance: view.creation_provenance,
    confidence: view.legacy_confidence,
    model: view.extraction_model_id,
    status: view.record_state,
    created_at: view.recorded_at,
    updated_at: view.legacy_updated_at
  };
};
