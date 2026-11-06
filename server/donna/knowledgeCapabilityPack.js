// Donna — the knowledge.*.v1 domain pack (K1-4).
//
// ONE capability: `knowledge.retrieve.v1`, the sourced-knowledge retrieval
// strategy, registered under the governed contract alongside `memory.retrieve.v2`
// (design-donna-knowledge-base.md §9 — "all retrieval through the governed
// contract with registered strategies", the memory map's rail). Registering it
// here rather than letting the answer path call the module directly is the whole
// point: an unregistered read path is a private API, and the map's rail exists
// because K1 is exactly the kind of substrate that grows one.
//
// THERE IS DELIBERATELY NO knowledge.* WRITE CAPABILITY. Curation is a human act
// run by a curator against a reviewed corpus (§8), not a capability the runtime
// may invoke — "a model-generated knowledge base is a laundering machine".
// knowledgeBaseDb.js's writers are reachable only from a curation session, and
// registering them here would make them look like something Donna can call.
//
// PURE LEAF — AND IT IMPORTS THE STRATEGY NOT AT ALL, ON PURPOSE. Following
// memoryCapabilityPack.js, the executor is named as a STRING. That convention
// turns out to be load-bearing here rather than stylistic: the registry is
// imported by the accounting-system adapters, which reach the ledger writers, so
// an `import` of knowledgeRetrieval.js from this file would put a K1 module on
// the import graph of a posting path and trip §2's GROUND-vs-GOVERN boundary
// (knowledgeRetrievalBoundary.test.js caught exactly that). Declaring a
// capability must never drag its executor into every consumer of the registry.
//
// The cost is that the capability id and the purpose-derived eval ids are
// literals here and constants there. knowledgeCapabilityPack.test.js pins the
// two together — a test may import both without creating a runtime edge.

const closed = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties
});

const S = Object.freeze({
  id: { type: 'string' },
  text: { type: 'string' },
  object: { type: 'object' }
});

export const knowledgeCapabilityPack = () => Object.freeze([
  {
    capability: 'knowledge.retrieve.v1',
    domain: 'knowledge',
    verb: 'retrieve',
    version: 1,
    input_schema: closed({
      // Server-authenticated context. `legal_entity` is load-bearing and is NOT
      // a caller claim: jurisdiction resolves from the clients row the case
      // belongs to, never from the tenant or the asking user (§9) — one owner
      // may hold entities in both markets.
      trusted_context: closed({
        legal_entity: S.object,              // { client_id, jurisdiction }
        resolved_audience: S.object,
        consumer_capability_id: S.id,
        source_event_id: S.id,
        occurred_at: S.text,                 // the authoritative clock (staleness is measured against it)
        model_id: S.id,                      // the ANSWERING model — recorded, never inferred
        config_snapshot: S.object,
        config_snapshot_id: S.id
      }, ['legal_entity', 'resolved_audience', 'consumer_capability_id', 'occurred_at']),
      request: closed({
        purpose_id: S.id,                    // closed + registered — never caller prose
        question_text: S.text,               // lexical ranking ONLY; never an instruction
        topics: { type: 'array', items: S.text },
        decision_date: S.text,               // transaction/tax-point date; else the clock
        budget_override: S.object            // may only LOWER the registered maximum
      }, ['purpose_id'])
    }),
    output_schema: closed({
      // Grounding + a single complete receipt. There is no split receipt here
      // and that is deliberate: K1 rows are published statute with no tenant and
      // no confidentiality class, so there is nothing to withhold from the
      // person whose question they failed to answer (see knowledgeRetrieval.js).
      grounding: S.object,
      receipt: S.object
    }),
    schema_status: 'declared',
    access: 'read',
    side_effect_class: 'none',
    // Risk is classified by DATA ACCESS, not side effects. Unlike
    // memory.retrieve.v2 this reads NO tenant data — the corpus is public
    // statute and official guidance — so the confidentiality risk that made
    // that capability 'high' is genuinely absent here. It is not 'low' either:
    // what this read grounds is a tax answer an owner will act on, and the
    // failure mode the whole design exists to prevent (confident and wrong) runs
    // straight through it.
    risk_class: 'medium',
    data_access_class: 'public',
    reversibility: null,
    dry_run: 'unsupported',                  // a read IS its own preview
    idempotency: 'natural_key',              // the retrieval_id
    authority_requirements: {
      // Reading public statute changes nothing and authorizes nothing (§2,
      // GROUND vs GOVERN), so a loop may do it autonomously. The gate that
      // matters is the born-off rollout flag, not an authority grant.
      autonomy_class: 'workflow',
      required_capability_class: 'viewer',
      grant_required: 'none'
    },
    legacy_entrypoint_bindings: { surfaces: [] },   // K1-4 ships uncalled; wiring is K1-5
    executor: 'retrieveKnowledge',
    execution_verifier: null,
    // HONEST GAP, and the honest reason. There is no audit row: `audit_events`
    // requires a NOT NULL firm_id cascading from firms (migration 001), and a
    // tenant-free plane must not borrow a tenant to write one — the same
    // constraint that kept K1-1's curation trail in the rows. The retrieval
    // receipt IS the record, returned complete on every call including refusals,
    // and it is persisted by the answer path (K1-5) on a surface that HAS a
    // tenant. If a queryable knowledge-answer log is ever wanted, it needs its
    // own tenant-free table — never a borrowed firm_id.
    audit_record: 'gap',
    execution_receipt: 'live',
    preflight: 'none',
    preflight_alternative: 'deterministic_read_projection',
    // The gold set is K1-7, built alongside the corpora while the curation
    // context is loaded. Named here as the ids this capability will be scored
    // on; the scenarios themselves land with the corpus, and an empty list on a
    // READ capability is permitted by the registry lint (the legacy-gap rules
    // bind writes).
    eval_scenarios: ['knowledge_owner_knowledge_answer', 'knowledge_operator_knowledge_answer']
  }
]);
