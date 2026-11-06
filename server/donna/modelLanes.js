// Donna — the model-lane registry, slice Q1 (descent ladder).
//
// Spec: docs/design-donna-qwen-descent-ladder.md §1 (the inventory) and
// §2.3. A LANE is a production model call site with one job, one parser
// contract, and one deciding model; this registry is the machine-readable
// form of the spec's inventory and the coordinate system every later slice
// (challenger, gates, model-policy feed) keys on. Coverage is
// machine-checked: modelLanes.test.js walks server/ with the same census
// predicate as llmCall.test.js's ratchet and refuses any provider-calling
// module that no lane claims — so a new call site cannot appear
// un-inventoried.
//
// REGISTRY FIELDS AND WHAT THEY GOVERN:
//  - `decidingModel: null` — each module's own default (+ its env override)
//    still governs which model runs. The registry becomes authoritative for
//    a lane only when that lane resolves its model THROUGH the seam;
//    until then a non-null value here would be a second config source that
//    can silently drift from reality (the OPENAI_MODEL incident's shape).
//  - `qualified` — the model-policy feed (Q6, spec §5.4), live per lane.
//    null = the lane is NOT yet governed by the feed; [] = governed and
//    nothing qualified; a non-empty frozen list = the ALLOWED deciding
//    models for the lane. The feed governs the allowed SET, not which
//    model runs: until a lane resolves its model through the seam, the
//    module's own default (+ its env override) still picks the runtime
//    model — and a receipt showing a deciding model OUTSIDE the qualified
//    set is exactly the drift tripwire (modelLaneGate.js flags it; the
//    OPENAI_MODEL incident is the shape being caught). Extending a
//    qualified set is a dated, human-signed change riding a promotion
//    verdict — never an edit that follows an env bump after the fact.
//    User model choice renders ONLY within a lane's qualified set; the
//    free picker is REJECTED (spec §10.6, re-confirmed 2026-08-11).
//  - `experimental` — explicit configured-model eligibility for a bounded,
//    client-scoped trial with active member authority. It does not populate
//    the qualified set or authorize promotion.
//  - `challenger` — lanes flip eligible one at a time (Q4+), each flip in
//    the same commit as its wiring, behind the config-plane flag AND the
//    fail-closed cap. First flip: bank_line_classification (2026-08-12;
//    lane retired in RT-14, 2026-09-02 — its sweep was env-dark everywhere).
//
// `ledger_commit` has NO lane and never will — the ledger post path is
// permanently unroutable to any model (spec §1.3, CLAUDE.md). Pinned by
// test.

export const LANE_KINDS = Object.freeze(['deciding', 'bulk_filter', 'capability_probe']);

const lane = ({ id, title, kind, endpointClass, providers = null, promptVersion = null, modules, challenger = null, qualified = null, experimental = null, desktopDefault = null, note = null }) => Object.freeze({
  id,
  title,
  kind,
  endpointClass,
  // RT-12: the endpoint classes that may serve the lane — `endpointClass`
  // is the primary (the one a receipt names when every provider is dark);
  // a provider-agnostic lane lists more than one and Host Certificate A
  // reads the lane as LIT when ANY of them holds a credential.
  providers: Object.freeze(providers ? [...providers] : [endpointClass]),
  // RT-12 (audit F-12): the lane's current prompt version — the string
  // constant its module stamps on every receipt (value-synced by test).
  promptVersion,
  modules: Object.freeze(modules),
  decidingModel: null,
  qualified: qualified ? Object.freeze([...qualified]) : null,
  experimental: experimental ? Object.freeze({ ...experimental }) : null,
  desktopDefault: desktopDefault ? Object.freeze({ ...desktopDefault }) : null,
  challenger: challenger
    ? Object.freeze({ eligible: true, sampling: Object.freeze({ ...challenger.sampling }) })
    : Object.freeze({ eligible: false }),
  note
});

export const MODEL_LANES = Object.freeze([
  lane({ id:'jev_reconciliation',title:'Jev first accounting decisions',kind:'deciding',endpointClass:'typesafe',
    modules:['server/donna/jevProvider.js', 'server/donna/jevShadow.js'],
    qualified: ['jev-1.13.0'], // Kari, 2026-09-20: default for every desktop book.
    experimental: { modelEnvironmentKey: 'TYPESAFE_MODEL', clientOnly: true, authority: 'active_firm_member' },
    desktopDefault: { modelEnvironmentKey: 'TYPESAFE_MODEL', flagKey: 'JEV_RECONCILIATION', authority: 'desktop_host_default', approvedOn: '2026-09-20' },
    challenger: { sampling: { fraction: 0.05 } },
    note:'JEV_RECONCILIATION config-scoped first decisions for matching, bank/document disposition, coding and material exceptions. Existing writers; stronger reasoning only after an explicit Jev handoff; provider failures never imply a semantic verdict.' }),
  lane({ id:'host_provider_probe',title:'Hosted provider transport check',kind:'capability_probe',endpointClass:'openai',
    providers:['openai','anthropic'],modules:['server/donna/cloudPilotOperations.js'],
    note:'Explicit operator-only synthetic transport request. No accounting verdict, no customer prompt, no automatic Host A spend.' }),
  // ── deciding lanes (load-bearing; strong model holds until a gate says otherwise) ──
  lane({
    id: 'unified_extraction',
    title: 'Unified document extraction',
    kind: 'deciding',
    endpointClass: 'anthropic',
    // RT-12 (decision D1, 2026-09-02): the appliance DEFAULT for every
    // reconcilable type, provider-agnostic through llmCall — anthropic
    // preferred when both keys are present, openai otherwise; the model id
    // on the receipt is the response's. The qualified set names the two
    // providers' strong defaults (value-synced with
    // UNIFIED_EXTRACTOR_DEFAULT_MODELS by test); extending it stays a dated,
    // human-signed change.
    providers: ['anthropic', 'openai'],
    promptVersion: 'unified-extraction-v8',
    qualified: ['claude-opus-4-8', 'gpt-5.4'],
    modules: ['server/donna/unifiedExtractor.js'],
    note: 'THE load-bearing extraction call — the appliance default since RT-12; the per-type family below serves the cloud for one release, then deletes.'
  }),
  lane({
    id: 'reconciliation_reasoning',
    title: 'Reconciliation reasoning',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/reconciliationLlmCore.js'],
    challenger: { sampling: { fraction: 1 } },
    // Q7 (Kari's dated model-lab call, 2026-08-16): governed for the
    // Honeybee lab experiment — the cloud dense 27B may be seated
    // EXPERIMENT-basis as the deciding model, with the exact production
    // prompts, parser, authorization gates and cascade unchanged, and the
    // strong default (Opus) reverse-shadowing every seated decision
    // (reconciliationReasoningChallenger.js, receipt-only). The policy
    // reaches the document-match families threaded so far (supplier_bill,
    // sales_invoice via their wrappers); other core callers keep the
    // strong default regardless of policy — named partial coverage, not
    // an accident. Product-wide promotion still requires the signed gate
    // verdict ("flips last" governs the DEFAULT, not the lab seat). The
    // cloud id is the qualification identity (OpenRouter, AkashML bf16,
    // ZDR; disposition gold 20/20 2026-08-16); the local
    // Qwen3.8-27B-UD-Q4_K_XL artifact identity stays separate and is NOT
    // qualified here.
    qualified: ['claude-opus-4-8', 'qwen/qwen3.8-27b'],
    note: 'Isolation-list file; the product-wide DEFAULT flips last. Q7 (2026-08-16): experiment policies may seat a qualified rung as decider on a lab book; Opus then runs as the reverse shadow.'
  }),
  lane({
    id: 'transaction_coding',
    title: 'Transaction coding',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/transactionLlm.js'],
    // Q9 (Kari's dated sole-model lab call, 2026-08-16: "whenever Donna or
    // any part of its workflow invokes an LLM, it needs to be qwen 27B —
    // everything else is a bug"): the coding lane joins the feed so the
    // cloud dense 27B can be policy-seated as the coding decider on the lab
    // firm — the same experiment basis, transport pattern (compatible
    // chat/completions via llmCall, mismatch guard, response-proven model
    // id in the ai_suggestion receipt) and per-flip receipts as Q6c/Q7.
    // Product-wide promotion still requires the signed §5.2 gate verdict.
    qualified: ['gpt-5.4', 'qwen/qwen3.8-27b'],
    note: 'Q9 (2026-08-16): governed for the sole-model lab — experiment policies may seat the qualified 27B as the coding decider; the strong default (gpt-5.4) holds absent a policy row.'
  }),
  lane({
    id: 'type_extractors_legacy',
    title: 'Type-specific extractors (legacy family)',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: [
      'server/donna/salesInvoice.js',
      'server/donna/supplierBill.js',
      'server/donna/receipt.js',
      'server/donna/contract.js',
      'server/donna/genericDocument.js',
      // RT-18 (2026-09-02): the payout / deposit-slip family's extractor.
      // Born on the llmCall envelope (no direct fetch), same OpenAI
      // strict-schema shape as its siblings; RT-12's unified extractor is
      // its destination like theirs.
      'server/donna/payoutStatement.js'
    ],
    note: 'Slice-B retirement candidates — the cloud path and the appliance fall-through for ONE release after RT-12 (2026-09-02); the deletion PR removes them. No challenger investment.'
  }),
  lane({
    id: 'bank_statement_vision',
    title: 'Bank-statement vision extraction',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/bankStatementVision.js']
  }),
  lane({
    id: 'chat_engine',
    title: 'Shared structured chat engine (feed/transaction/portal)',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/transactionChat.js', 'server/donna/ownerReplyInterpreter.js', 'server/donna/ae/vatPostingAutomation.js'],
    note: 'Shared surface with the god-mode lane; registered owner replies use its strong model through the shared envelope. Coordinate before any challenger wiring.'
  }),
  lane({
    id: 'document_chat',
    title: 'Document chat',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/documentChat.js']
  }),
  lane({
    id: 'intent_compilation',
    title: 'Chat intent compilation',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/intentCompiler.js'],
    note: 'Carries the tree\'s gold-set precedent (intentCompilerGoldSet.js).'
  }),
  lane({
    id: 'ask_drafting',
    title: 'Ask drafting',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/askPipeline.js']
  }),
  lane({
    id: 'knowledge_compose',
    title: 'K1 knowledge compose',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/knowledgeCompose.js'],
    note: 'K1 grounds, never governs — the allowlist boundary applies to any challenger wiring here.'
  }),
  lane({
    id: 'memory_extraction',
    title: 'Memory extraction (firm/entity facts)',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/firmFacts.js'],
    note: 'Mints durable memory — the clearest evidence-only test case for challengers. (entityFacts.js, the env-dark statutory-record extractor, was deleted in RT-14, 2026-09-02.)'
  }),
  lane({
    id: 'reconciliation_triage',
    title: 'Reconciliation triage',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/reconciliationTriage.js']
  }),
  lane({
    id: 'merchant_lookup',
    title: 'Merchant lookup',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/merchantLookup.js']
  }),
  lane({
    id: 'louis_qa',
    title: 'Louis QA evaluator',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/louisPipeline.js'],
    note: 'Deliberately independent from the lanes it reviews; a challenger here must never share the rung with the lane under review.'
  }),
  lane({
    id: 'owner_invoice_command_read',
    title: 'Owner invoice command read',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/ownerInvoiceCommandRead.js'],
    note: 'Fully envelope-adopted (the M3 pass-1 site).'
  }),
  lane({
    id: 'client_intake_draft',
    title: 'Client intake draft',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/clientIntakeDraft.js']
  }),
  lane({
    id: 'marketing_drafting',
    title: 'Marketing drafters + reply ingestion',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: [
      'server/donna/marketing/dossierDrafter.js',
      'server/donna/marketing/nurtureDrafter.js',
      'server/donna/marketing/replyDrafter.js',
      'server/donna/marketing/socialPostDrafter.js',
      'server/donna/outbound/replyIngestion.js'
    ],
    note: 'Outbound is the most-dangerous surface; promotion here needs its own Kari call.'
  }),
  lane({
    id: 'parser_repair',
    title: 'Parser repair',
    kind: 'deciding',
    endpointClass: 'openai',
    modules: ['server/donna/parserRepair.js']
  }),
  lane({
    id: 'canonical_role_resolution',
    title: 'Canonical-role resolution (chart of accounts)',
    kind: 'deciding',
    endpointClass: 'anthropic',
    modules: ['server/donna/canonicalRoleResolutionDb.js'],
    note: 'Envelope-adopted whole-chart proposer.'
  }),
  lane({
    id: 'bank_line_disposition',
    title: 'Bank-line disposition',
    kind: 'deciding',
    endpointClass: 'anthropic',
    // Q6c: the deciding module joined the census — it now carries its own
    // llmCall( for the model-lab compatible deciding path (the default
    // strong path still rides reconciliationLlmCore's transport, claimed
    // by reconciliation_reasoning).
    modules: ['server/donna/bankLineDispositionChallenger.js', 'server/donna/bankLineDispositionLlm.js'],
    challenger: { sampling: { fraction: 1 } },
    // Q6a: governed like the B2 pilot — the core's deciding default stays
    // qualified (value-synced by test). Q6c (Kari's dated model-lab call,
    // 2026-08-16): the §9.5 staged candidate joins the set for the
    // EXPERIMENT basis — selectable via the policy feed on a lab book,
    // receipted per flip; a PROMOTION onto the deciding seat product-wide
    // still requires the signed gate verdict. Further rungs join here by
    // the same dated-commit path once their exact artifact ids are named.
    // 2026-08-16 (Kari, model-lab follow-up; CORRECTED by Kari's same-day
    // call): Qwen3.5-35B-A3B is the HOSTED small-MoE comparison rung — the
    // nearest small same-family rung the hosted provider serves. It is NOT
    // the 27B-class rung, and its results never stand in for the dense
    // 27B (the earlier "the 27B-class rung resolves to 35B-A3B" claim let
    // a provider-menu limitation redefine the candidate; retracted).
    // 2026-08-16 (Kari): the 27B-class rung is Qwen3.8-27B-UD-Q4_K_XL —
    // the dense 27B, quantized, served LOCALLY by llama-server over the
    // openai_compatible endpoint (--alias gives the stable id; base URL
    // via OPENAI_COMPATIBLE_BASE_URL). Admitted for the model-lab
    // EXPERIMENT basis only — this line certifies and promotes nothing.
    // The alias proves model-NAME agreement, not weight-file identity:
    // artifact-grade local receipts (GGUF digest, quantization, runtime
    // version, execution_mode=local, egress) are a named follow-up
    // REQUIRED before any promotion/certification claim for this rung.
    // 2026-08-16 (Kari's all-entities lab call): the CLOUD dense 27B id
    // joins — qualification receipts exist (gold 20/20 first candidate
    // ever; live reasoning-lane agreement data) and the same-day call
    // seats qwen firm-wide as the lab decider. Cloud id ≠ the local
    // Q4_K_XL artifact id — the identities never alias.
    qualified: ['claude-opus-4-8', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.8-27B-UD-Q4_K_XL', 'qwen/qwen3.8-27b'],
    note: 'PILOT LANE since Q6a (2026-08-13, superseding B2): the LIVE bare-bank-line decider (auto_explain / needs_human / chase_*), swept by the hourly cron and the loops terminal drain. Text-only, pure exported prompt builders + parser — the challenger replays the exact deciding observation via bankLineDispositionChallenger.js, post-stamp. Q6c (2026-08-16): model-lab experiment policies can seat a qualified rung as the decider (modelLanePolicy.js); the strong default then runs as the REVERSE shadow.'
  }),

  // ── bulk-filter lanes (cheap tier doctrine-blessed; expected first movers) ──
  lane({
    id: 'document_routing',
    title: 'Document routing / classification',
    kind: 'bulk_filter',
    endpointClass: 'openai',
    modules: ['server/donna/documentRouter.js'],
    note: 'Was the spec table\'s rung-1 pilot pick; superseded 2026-08-12 — its deciding call is multimodal (Responses API + PDF data URL), which a chat/completions rung cannot replay at parity. Challenger-eligible once a vision/file-capable rung exists.'
  }),
  lane({
    id: 'receipt_classification',
    title: 'Receipt classification',
    kind: 'bulk_filter',
    endpointClass: 'openai',
    modules: ['server/donna/receiptClassifier.js'],
    note: 'Already on the cheapest tier — the existence proof that bulk lanes descend safely.'
  })
]);

export const getLane = (id) => MODEL_LANES.find((entry) => entry.id === id) || null;

// A lane's deciding-model flip is a CONFIG-PLANE staged change (spec §6:
// `LANE_MODEL_<LANE>` through clientFlagActs, never an env pair). This
// helper is the single spelling of that key. No lane reads it yet — the
// first flip wires the read, the staged rows, AND the qualified-set
// extension in the same commit, with the signed promotion verdict attached
// (Q6 builds the machinery; the flip is its own Kari go).
export const laneModelFlagKey = (laneId) => `LANE_MODEL_${String(laneId).toUpperCase()}`;

// Reverse index: module path → lane. Built once; a module claimed by two
// lanes is a registry bug the test refuses.
const MODULE_TO_LANE = new Map();
for (const entry of MODEL_LANES) {
  for (const modulePath of entry.modules) {
    if (!MODULE_TO_LANE.has(modulePath)) MODULE_TO_LANE.set(modulePath, entry);
  }
}
export const laneForModule = (modulePath) => MODULE_TO_LANE.get(modulePath) || null;
