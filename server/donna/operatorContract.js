// The Operator Contract — Phase 0 fixtures.
//
// Source docs (this module is their executable form — a disagreement
// between this file and the docs is a bug in one of them):
//   - docs/donna-operator-loop-plan.md §3 (the Operator Contract; §3.5
//     invariants; the triage-is-a-field doctrine in §3.1)
//   - docs/donna-operator-runtime-contract.md §3 (ProposalCard v2),
//     §4 (ApplyReceipt v2), §6 (CheckReport)
//   - docs/donna-operator-loop-prd.md FR-1 (triage), FR-5 (cards),
//     FR-21 (check reports) — R0 release-gate groundwork.
//
// What this module is: importable, JSON-serializable schema fixtures +
// a bounded validator that future card/apply/triage code validates
// against. What it is NOT: product behaviour. Nothing here runs on a
// request path yet; later phases import these shapes instead of
// re-inventing them per surface.
//
// Shape decisions not literally spelled in the docs (each chosen so a
// receipt stays reconstructible without prose):
//   - Envelopes are closed (additionalProperties: false); the card's
//     type-specific payload (account, question, pattern, …) lives in
//     the open `detail` object so the envelope cannot silently grow.
//   - `rows_touched` is a list of object ids, not a count — a count is
//     derivable from the list, never the reverse.
//   - `per_target` carries the plan §3.3 per-target outcome with the
//     #381 field naming (`applied` / `error`) already shipping in
//     feedChatApply receipts.
//   - `prompt_version` / `context_snapshot_id` are nullable until the
//     FR-26 replay machinery populates them everywhere.
//   - `before_after` is bounded (first N rows); `before_after_total`
//     carries the true count so truncation is visible on the card.

function deepFreeze(node) {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) deepFreeze(value);
    Object.freeze(node);
  }
  return node;
}

// ─── Enums ───────────────────────────────────────────────────────────────

// The seven intents (plan §3.1). Triage is a structured field of the
// SAME strong call that drafts the reply — never a separate cheaper
// classifier (the documentRouter/Failure-A shape).
export const OPERATOR_INTENTS = Object.freeze([
  'diagnostic',
  'state_correction',
  'memory_candidate',
  'policy_request',
  'engineering_escalation',
  'unsupported',
  'question'
]);

// Check statuses (contract §6), ordered by severity: index IS severity.
// `fail` blocks; `requires_review` escalates the review mode;
// `warning` renders.
export const CHECK_STATUSES = Object.freeze([
  'pass',
  'warning',
  'requires_review',
  'fail'
]);

// Reversibility vocabulary (plan §3.2). Null on a card only for
// non-writing proposals (future_action).
export const REVERSIBILITY_CLASSES = Object.freeze([
  'recode_before_posting',
  'reversible_via_adjustment',
  'irreversible_external'
]);

// Review modes (contract §11). Specified now; they collapse onto a
// one-person firm until the first hire.
export const REVIEW_MODES = Object.freeze([
  'operator_one_click',
  'accountant_approval',
  'client_confirmation',
  'second_reviewer',
  'engineering'
]);

// ─── Untrusted-content boundary (contract §6 / INV-12) ───────────────────────
//
// Firm/operator instructions may control Donna's tools. Client replies and
// document/OCR/PDF/bank text are bookkeeping EVIDENCE only — never tool control.
// The boundary is enforced at the tool/authority layer (untrustedContent.js),
// NOT by weakening the model: the strong model still reasons over the evidence
// freely. These two frozen sets are the canonical vocabulary.

// Sources whose content is untrusted AS A TOOL-CONTROL INPUT.
export const UNTRUSTED_SOURCES = Object.freeze([
  'client_reply',
  'ocr_text',
  'invoice_description',
  'pdf_hidden_text',
  'email_body',
  'merchant_text',
  'bank_description',
  'client_supplied_metadata'
]);

// The verbs an untrusted source may NEVER directly invoke (it may only
// INFLUENCE candidate facts/classifications/matches/asks). remember_fact is on
// the list because untrusted content can never mint ACTIVE memory — at most it
// seeds a candidate a human later activates.
export const AUTONOMY_FORBIDDEN_VERBS = Object.freeze([
  'apply_category',
  'send_ask_batch',
  'remember_fact',
  'activate_policy',
  'post_to_xero',
  'confirm_match',
  'resolve_accountant_judgment'
]);

// ─── Invariants (plan §3.5) — citable data, enforced by code review ─────

export const OPERATOR_CONTRACT_INVARIANTS = deepFreeze([
  {
    id: 'INV-1',
    rule: 'No new state mutation paths unless the state itself is new — proposals route to existing named writers; the grammar is a router, never a second accounting backend.'
  },
  {
    id: 'INV-2',
    rule: "No unattended behaviour from chat-created memory — only approval_state='active' policy rows read by exact key change unattended behaviour."
  },
  {
    id: 'INV-3',
    rule: 'Every load-bearing model call records its receipt: model id in the data (never code defaults), facts/examples available and used.'
  },
  {
    id: 'INV-4',
    rule: 'Terminal rows are re-verified at write time — a proposal flag is never trusted alone.'
  },
  {
    id: 'INV-5',
    rule: 'Diagnostics are read-only; remedial verbs are separately guarded and counted.'
  }
]);

// ─── Schemas ─────────────────────────────────────────────────────────────

// Triage receipt (plan §3.1) — persisted on the assistant message.
// `not_handled_as` is the safety line: what the message was NOT treated
// as, and why, so the grammar cannot silently absorb every request.
export const TRIAGE_RECEIPT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['triage', 'not_handled_as', 'reason'],
  properties: {
    triage: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: OPERATOR_INTENTS }
    },
    not_handled_as: {
      type: 'array',
      items: { type: 'string', enum: OPERATOR_INTENTS }
    },
    reason: { type: 'string' }
  }
});

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'status', 'detail'],
  properties: {
    name: { type: 'string' },
    status: { type: 'string', enum: CHECK_STATUSES },
    detail: { type: ['string', 'null'] }
  }
};

// CheckReport (contract §6) — `status` is the worst of the member
// checks (use summarizeCheckReport; severity = CHECK_STATUSES order).
export const CHECK_REPORT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'checks'],
  properties: {
    status: { type: 'string', enum: CHECK_STATUSES },
    checks: { type: 'array', items: CHECK_SCHEMA }
  }
});

const BEFORE_AFTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'before', 'after'],
  properties: {
    target: { type: 'string' },
    before: { type: 'object' },
    after: { type: 'object' }
  }
};

// Optimistic-concurrency precondition (contract §13). The expected_*
// keys vary by object kind, so the precondition object stays open with
// `object` as the one required anchor.
const PRECONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['object'],
  properties: {
    object: { type: 'string' },
    expected_updated_at: { type: ['string', 'null'] }
  }
};

// ProposalCard v2 (contract §3, extending plan §3.2). `type` is the
// verb name — deliberately NOT an enum here: the grammar grows by
// phase and new verbs enter via the tool registry (FR-20), not by
// editing this fixture. `checks: null` means "preflight has not run";
// such a card is not appliable (see proposalCardIsAppliable).
export const PROPOSAL_CARD_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'proposal_id',
    'type',
    'triage_source',
    'plan_id',
    'targets',
    'blast_radius',
    'writer',
    'reversibility',
    'before_after',
    'before_after_total',
    'checks',
    'preconditions',
    'review_mode',
    'detail',
    'warnings'
  ],
  properties: {
    proposal_id: { type: 'string' },
    type: { type: 'string' },
    triage_source: { type: 'string', enum: OPERATOR_INTENTS },
    plan_id: { type: ['string', 'null'] },
    targets: { type: 'array', items: { type: 'string' } },
    blast_radius: {
      type: 'object',
      additionalProperties: false,
      required: [
        'transactions',
        'documents',
        'decided_rows',
        'client_visible',
        'unattended_future_behavior'
      ],
      properties: {
        transactions: { type: 'integer' },
        documents: { type: 'integer' },
        decided_rows: { type: 'integer' },
        client_visible: { type: 'boolean' },
        unattended_future_behavior: { type: 'boolean' }
      }
    },
    writer: { type: ['string', 'null'] },
    reversibility: {
      type: ['string', 'null'],
      enum: [...REVERSIBILITY_CLASSES, null]
    },
    before_after: { type: 'array', items: BEFORE_AFTER_SCHEMA },
    before_after_total: { type: 'integer' },
    checks: { anyOf: [CHECK_REPORT_SCHEMA, { type: 'null' }] },
    preconditions: { type: 'array', items: PRECONDITION_SCHEMA },
    review_mode: { type: 'string', enum: REVIEW_MODES },
    detail: { type: 'object' },
    warnings: { type: 'array', items: { type: 'string' } }
  }
});

// ApplyReceipt v2 (contract §4 + plan §3.3). One shape for both
// proposal-generation and apply receipts: `operator_words` and
// `proposal_id` are null on generation receipts. Self-reported fields
// (facts_used etc.) are telemetry and governance inputs ONLY — no gate
// may consume them (the self-licensing rule).
export const APPLY_RECEIPT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'proposal_id',
    'model',
    'prompt_version',
    'context_snapshot_id',
    'candidate_ids_seen',
    'candidate_ids_rejected',
    'facts_available',
    'facts_used',
    'facts_conflicted',
    'examples_available',
    'examples_used',
    'playbooks_used',
    'policies_used',
    'checks',
    'final_writer',
    'audit_event_ids',
    'rows_touched',
    'per_target',
    'operator_words'
  ],
  properties: {
    proposal_id: { type: ['string', 'null'] },
    model: { type: 'string' },
    prompt_version: { type: ['string', 'null'] },
    context_snapshot_id: { type: ['string', 'null'] },
    candidate_ids_seen: { type: 'array', items: { type: 'string' } },
    candidate_ids_rejected: { type: 'array', items: { type: 'string' } },
    facts_available: { type: 'array', items: { type: 'string' } },
    facts_used: { type: 'array', items: { type: 'string' } },
    facts_conflicted: { type: 'array', items: { type: 'string' } },
    examples_available: { type: 'array', items: { type: 'string' } },
    examples_used: { type: 'array', items: { type: 'string' } },
    playbooks_used: { type: 'array', items: { type: 'string' } },
    policies_used: { type: 'array', items: { type: 'string' } },
    checks: { anyOf: [CHECK_REPORT_SCHEMA, { type: 'null' }] },
    final_writer: { type: ['string', 'null'] },
    audit_event_ids: { type: 'array', items: { type: 'string' } },
    rows_touched: { type: 'array', items: { type: 'string' } },
    per_target: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'applied', 'error'],
        properties: {
          target: { type: 'string' },
          applied: { type: 'boolean' },
          error: { type: ['string', 'null'] }
        }
      }
    },
    operator_words: { type: ['string', 'null'] }
  }
});

export const OPERATOR_CONTRACT_SCHEMAS = Object.freeze({
  triage_receipt: TRIAGE_RECEIPT_SCHEMA,
  check_report: CHECK_REPORT_SCHEMA,
  proposal_card: PROPOSAL_CARD_SCHEMA,
  apply_receipt: APPLY_RECEIPT_SCHEMA
});

// ─── Validator ───────────────────────────────────────────────────────────
// Bounded JSON-Schema subset: type (incl. integer + type arrays), enum,
// required, properties, additionalProperties:false, items, minItems,
// anyOf. Exactly what the fixtures above use — extend it WITH a fixture
// that needs more, never speculatively.

function typeMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}

function validateNode(schema, value, path, errors) {
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((branch) => {
      const branchErrs = [];
      validateNode(branch, value, path, branchErrs);
      return branchErrs;
    });
    if (!branchErrors.some((errs) => errs.length === 0)) {
      errors.push(`${path}: matched no anyOf branch (${branchErrors.map((errs) => errs[0]).join(' | ')})`);
    }
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in the enum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required key missing`);
    }
    const props = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (key in props) {
        validateNode(props[key], child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unknown key (closed envelope)`);
      }
    }
  }
}

export function validateOperatorContract(schema, value) {
  const errors = [];
  validateNode(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
}

export function assertMatchesOperatorContract(schemaName, value) {
  const schema = OPERATOR_CONTRACT_SCHEMAS[schemaName];
  if (!schema) throw new Error(`Unknown operator-contract schema: ${schemaName}`);
  const { ok, errors } = validateOperatorContract(schema, value);
  if (!ok) throw new Error(`${schemaName} contract violation: ${errors.join('; ')}`);
  return value;
}

// ─── Check-report helpers ────────────────────────────────────────────────

// Severity is CHECK_STATUSES order; an unrecognized status fails closed
// (a gate must never become more permissive via a typo).
export function worstCheckStatus(statuses) {
  let worst = 0;
  for (const status of statuses || []) {
    const index = CHECK_STATUSES.indexOf(status);
    const severity = index === -1 ? CHECK_STATUSES.length - 1 : index;
    if (severity > worst) worst = severity;
  }
  return CHECK_STATUSES[worst];
}

export function summarizeCheckReport(checks) {
  const list = Array.isArray(checks) ? checks : [];
  return {
    status: worstCheckStatus(list.map((check) => check?.status)),
    checks: list
  };
}

// Contract §3: a card is not appliable until its CheckReport exists,
// and a card whose checks include `fail` cannot render an Apply button.
// The most severe of the rolled-up status and the member checks wins —
// an inconsistent report never errs permissive. `requires_review` stays
// appliable (it escalates the review mode; it does not block).
export function proposalCardIsAppliable(card) {
  const report = card?.checks;
  if (!report || !Array.isArray(report.checks)) return false;
  const observed = worstCheckStatus([
    report.status,
    ...report.checks.map((check) => check?.status)
  ]);
  return observed !== 'fail';
}

// ─── Canonical examples (the docs' own examples, kept validating) ───────

export const EXAMPLE_TRIAGE_RECEIPT = deepFreeze({
  triage: ['state_correction', 'memory_candidate'],
  not_handled_as: ['policy_request'],
  reason: 'operator recoded current rows and stated a durable settlement behavior, but did not request unattended auto-apply'
});

export const EXAMPLE_CHECK_REPORT = deepFreeze({
  status: 'warning',
  checks: [
    { name: 'targets_exist', status: 'pass', detail: null },
    { name: 'no_target_already_decided', status: 'pass', detail: null },
    { name: 'period_not_locked', status: 'warning', detail: 'txn_2 posts within 7 days of the open-period boundary.' }
  ]
});

export const EXAMPLE_PROPOSAL_CARD = deepFreeze({
  proposal_id: 'prop_example_1',
  type: 'apply_category',
  triage_source: 'state_correction',
  plan_id: null,
  targets: ['txn_1', 'txn_2'],
  blast_radius: {
    transactions: 2,
    documents: 0,
    decided_rows: 0,
    client_visible: false,
    unattended_future_behavior: false
  },
  writer: 'updateTransactionReviewItemInDb',
  reversibility: 'recode_before_posting',
  before_after: [
    {
      target: 'txn_1',
      before: { account: 'Suspense', review_state: 'suggested' },
      after: { account: 'Consulting revenue', review_state: 'accepted' }
    }
  ],
  before_after_total: 2,
  checks: EXAMPLE_CHECK_REPORT,
  preconditions: [
    { object: 'txn_1', expected_review_state: 'suggested', expected_updated_at: '2026-06-12T10:00:00Z' },
    { object: 'txn_2', expected_review_state: 'suggested', expected_updated_at: '2026-06-12T10:00:00Z' }
  ],
  review_mode: 'operator_one_click',
  detail: { account: 'Consulting revenue' },
  warnings: []
});

export const EXAMPLE_APPLY_RECEIPT = deepFreeze({
  proposal_id: 'prop_example_1',
  model: 'claude-opus-4-7',
  prompt_version: null,
  context_snapshot_id: null,
  candidate_ids_seen: ['txn_1', 'txn_2', 'txn_9'],
  candidate_ids_rejected: ['txn_9'],
  facts_available: ['fact_vendor_apa'],
  facts_used: ['fact_vendor_apa'],
  facts_conflicted: [],
  examples_available: [],
  examples_used: [],
  playbooks_used: [],
  policies_used: [],
  checks: EXAMPLE_CHECK_REPORT,
  final_writer: 'updateTransactionReviewItemInDb',
  audit_event_ids: ['evt_feed_chat_apply_1'],
  rows_touched: ['txn_1'],
  per_target: [
    { target: 'txn_1', applied: true, error: null },
    { target: 'txn_2', applied: false, error: 'no_review_item' }
  ],
  operator_words: 'code the two NORTHWIND lines to consulting revenue'
});
