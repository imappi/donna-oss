// Reconciliation PR 3 — safe receipt auto-explain.
//
// Deterministic policy layer. Combines PR 1's `auto_match_passed`
// signal with PR 2's classifier output and per-firm config to decide
// whether a `reconciliation_matches` row should be promoted from
// `suggested` to `auto_matched`. Promotion cascades through three
// state rows (the match, the bank transaction, the document) and one
// audit row inside the same writer transaction.
//
// "Use LLMs for semantic understanding. Use deterministic code for
// final action." PR 3 is the deterministic policy half. The
// classifier provides metadata; the policy decides. Every gate is a
// hard veto; the gate evaluates every blocker (no short-circuit) so
// the audit log carries the full diagnostic list.
//
// PII policy mirrors PR 1 / PR 2: audits carry IDs + categorical
// enums + bounded numbers only. No vendor names, descriptions,
// reference numbers, merchant_display_name, or needs_human_reason
// text crosses into the audit metadata.

// Policy version — stamped onto every audit row. PR 5's rule-learning
// pass will read this from past audit rows to decide which decisions
// are stable enough to learn from.
export const AUTO_EXPLAIN_POLICY_VERSION = 'auto_explain_v1';

// Version-compatibility constants. Exact string equality (NOT semver).
// If PR 2 ever bumps its version constants, PR 3 stops auto-explaining
// until this map is bumped to match.
export const AUTO_EXPLAIN_CLASSIFIER_VERSION = 'receipt_semantic_v1';
export const AUTO_EXPLAIN_PROMPT_VERSION = 'receipt_semantic_prompt_v1';

// Safe list — auto-explain is allowed for these kinds when every other
// gate passes. Mirrors `SAFE_EXPENSE_KINDS` in receiptClassifier.js;
// kept inline so a future PR 2 bump can't silently widen the safe set.
const SAFE_EXPENSE_KINDS = new Set([
  'taxi',
  'public_transport',
  'parking_toll',
  'courier_postage',
  'software_subscription',
  'office_supplies'
]);

// Cautious list — these kinds NEVER auto-explain regardless of
// confidence. Restaurant/hotel/fuel/etc. carry too much tax-treatment
// nuance for a deterministic gate to handle.
const CAUTIOUS_EXPENSE_KINDS = new Set([
  'restaurant_cafe',
  'hotel_travel',
  'fuel',
  'bank_fee',
  'groceries'
]);

// PR 2 classifier warnings that act as hard blockers. The rest of the
// `SEMANTIC_WARNINGS` enum (missing_business_purpose, generic_merchant,
// duplicate_line_items_detected, classifier_fallback) is advisory —
// other gates already cover them.
const RED_FLAG_CLASSIFIER_WARNINGS = new Set([
  'personal_expense_likely',
  'currency_unusual',
  'date_in_future',
  'multiple_kinds_detected',
  'high_amount_for_category'
]);

// `parse_summary.warnings` tokens that act as hard blockers. Only the
// stable enum tokens emitted by the writer / extractor merge step are
// listed here — free-text LLM-emitted warnings are ignored for this
// gate (they are capped to 200 chars and have no categorical meaning).
const RED_FLAG_PARSE_WARNINGS = new Set([
  'amount_mismatch',
  'orphaned_lines_kept'
]);

// `transactions.reconciliation_status` values that mean "already
// resolved" — PR 3 will not auto-explain a transaction that has
// already moved past the soft state.
const RESOLVED_TX_STATUSES = new Set([
  'explained',
  'reconciled',
  'posted',
  'auto_reconciled'
]);

// Categorical blocker enum — PR 4's review UI renders these as
// human-readable hints. Canonical definition lives in
// `src/lib/receiptAutoExplainBlockers.js` so the FE bundle never
// imports server-side modules; both sides re-use the same frozen
// object.
import { AUTO_EXPLAIN_BLOCKERS } from '../../src/lib/receiptAutoExplainBlockers.js';
export { AUTO_EXPLAIN_BLOCKERS };

const DEFAULT_AMOUNT_LIMITS = Object.freeze({
  taxi: 50,
  public_transport: 25,
  parking_toll: 25,
  courier_postage: 50,
  software_subscription: 250,
  office_supplies: 25
});

const DEFAULT_CONFIDENCE_FLOOR = 0.8;

// Global kill switch. Default off — every firm starts dark even if the
// per-firm flag is on, until the env var is set in production. Mirrors
// the `RECEIPT_CLASSIFIER_ENABLED` pattern at parseDocument.js:74.
const isAutoExplainGloballyEnabled = () =>
  String(process.env.RECEIPT_AUTO_EXPLAIN_ENABLED || '').toLowerCase() === 'true';

// Pure firm-config resolver. Reads `firm.metadata.auto_explain` and
// merges over defaults. Defaults `receipt_enabled` to false so new
// firms start disabled even when the global kill switch is on.
export const resolveAutoExplainConfig = (firm = {}) => {
  const meta = (firm && typeof firm === 'object' && firm.metadata && typeof firm.metadata === 'object')
    ? firm.metadata
    : {};
  const raw = (meta.auto_explain && typeof meta.auto_explain === 'object')
    ? meta.auto_explain
    : {};
  const rawLimits = (raw.amount_limits && typeof raw.amount_limits === 'object')
    ? raw.amount_limits
    : {};
  const floor = typeof raw.confidence_floor === 'number'
    && raw.confidence_floor >= 0
    && raw.confidence_floor <= 1
    ? raw.confidence_floor
    : DEFAULT_CONFIDENCE_FLOOR;
  return {
    receipt_enabled: raw.receipt_enabled === true,
    confidence_floor: floor,
    amount_limits: { ...DEFAULT_AMOUNT_LIMITS, ...rawLimits }
  };
};

// Async firm-config resolver. ONE SELECT on `firms.metadata`. Caller
// is the entry point — the writer never invokes this directly because
// the global kill switch is checked first.
export const resolveFirmAutoExplainConfig = async (client, firmId) => {
  const result = await client.query('select metadata from firms where id = $1', [firmId]);
  return resolveAutoExplainConfig(result.rows[0] || {});
};

// Bucketed amount band — categorical, PII-safe for audit metadata.
const amountBand = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 25) return '<25';
  if (n < 50) return '<50';
  if (n < 100) return '<100';
  if (n < 250) return '<250';
  return '>=250';
};

const numericOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Pure gate. NEVER reads from the DB. Receives PR 1's match row,
// PR 2's semantic sub-object, the bank transaction, the document, the
// parse warnings, and the resolved firm config. Returns the verdict
// + a categorical blocker list. Evaluates EVERY blocker — no
// short-circuit — so the audit carries the full diagnostic list.
export const evaluateAutoExplainEligibility = ({
  match,
  document,
  transaction,
  semantic,
  parseWarnings,
  firmConfig
} = {}) => {
  const blockers = [];

  // Render the persisted verdict: the matcher stamps payload.cross_entity when
  // the document's own side does not match the book's identity
  // (crossEntityGuard.js). A stamped match must never settle a bank line —
  // the correct terminal is the owner ask carrying the relation.
  if (match?.payload?.cross_entity?.detected === true) {
    blockers.push(AUTO_EXPLAIN_BLOCKERS.CROSS_ENTITY_MISMATCH);
  }

  // Per-firm kill switch. Independent gate so the audit clearly shows
  // "the firm is dark" vs. any classifier-side reason.
  if (!firmConfig || firmConfig.receipt_enabled !== true) {
    blockers.push(AUTO_EXPLAIN_BLOCKERS.FIRM_DISABLED);
  }

  // Match status — only `suggested` rows are eligible. Sticky
  // protection for confirmed/rejected/auto_matched.
  if (!match || match.status !== 'suggested') {
    blockers.push(AUTO_EXPLAIN_BLOCKERS.MATCH_NOT_SUGGESTED);
  }

  // PR 1 deterministic verdict.
  const matchReason = (match && match.payload && match.payload.match_reason) || {};
  if (matchReason.auto_match_passed !== true) {
    blockers.push(AUTO_EXPLAIN_BLOCKERS.PR1_NOT_ELIGIBLE);
  }

  // Classifier presence + version + fallback + expense_kind + the
  // numeric gates. Bundled inside the `semantic` truthy branch so a
  // missing classifier produces ONE blocker (CLASSIFIER_MISSING)
  // instead of seven.
  if (!semantic || typeof semantic !== 'object') {
    blockers.push(AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_MISSING);
  } else {
    if (
      semantic.classifier_version !== AUTO_EXPLAIN_CLASSIFIER_VERSION ||
      semantic.prompt_version !== AUTO_EXPLAIN_PROMPT_VERSION
    ) {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_STALE_VERSION);
    }

    if (semantic.used_fallback === true || semantic.provider !== 'openai') {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_FALLBACK);
    }

    const expenseKind = semantic.expense_kind;
    if (expenseKind === 'unknown') {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.EXPENSE_KIND_UNKNOWN);
    } else if (CAUTIOUS_EXPENSE_KINDS.has(expenseKind)) {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.EXPENSE_KIND_CAUTIOUS);
    } else if (!SAFE_EXPENSE_KINDS.has(expenseKind)) {
      // Defensive — sanitizer should never emit an out-of-enum value,
      // but a hostile/buggy payload arriving here gets routed to
      // review the same way `unknown` would.
      blockers.push(AUTO_EXPLAIN_BLOCKERS.EXPENSE_KIND_UNKNOWN);
    }

    const floor = (firmConfig && typeof firmConfig.confidence_floor === 'number')
      ? firmConfig.confidence_floor
      : DEFAULT_CONFIDENCE_FLOOR;
    if (typeof semantic.confidence !== 'number' || semantic.confidence < floor) {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.CONFIDENCE_BELOW_FLOOR);
    }

    if (semantic.evidence_sufficient_signal !== true) {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.EVIDENCE_INSUFFICIENT);
    }

    if (semantic.materiality_risk !== 'low') {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.MATERIALITY_NOT_LOW);
    }

    const warnings = Array.isArray(semantic.warnings) ? semantic.warnings : [];
    if (warnings.some((w) => RED_FLAG_CLASSIFIER_WARNINGS.has(w))) {
      blockers.push(AUTO_EXPLAIN_BLOCKERS.CLASSIFIER_WARNING);
    }

    // Amount-vs-firm-limit check. Only applies when the expense_kind
    // is in the safe list (cautious / unknown kinds never reach the
    // amount gate because they already blocked above). Amount limit
    // defaults are merged in `resolveAutoExplainConfig`.
    if (SAFE_EXPENSE_KINDS.has(expenseKind)) {
      const limit = firmConfig && firmConfig.amount_limits && firmConfig.amount_limits[expenseKind];
      const amount = Number(document && document.total_amount);
      if (
        typeof limit !== 'number' ||
        !Number.isFinite(amount) ||
        amount > limit
      ) {
        blockers.push(AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_LIMIT);
      }
    }
  }

  // Parse-summary warnings — deterministic enum tokens only.
  const pw = Array.isArray(parseWarnings) ? parseWarnings : [];
  if (pw.some((w) => RED_FLAG_PARSE_WARNINGS.has(w))) {
    blockers.push(AUTO_EXPLAIN_BLOCKERS.PARSE_WARNING);
  }

  // Transaction-side resolved-status protection. We don't auto-explain
  // a transaction the firm (or a prior pass) has already moved past
  // the soft state. The state writes downstream are predicate-guarded
  // too, but blocking here keeps the audit honest.
  if (transaction && RESOLVED_TX_STATUSES.has(transaction.reconciliation_status)) {
    blockers.push(AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED);
  }

  return { passed: blockers.length === 0, blockers };
};

// Build the categorical audit metadata for a passed or blocked
// decision. Strictly enum / numeric / UUID — no free text. Mirrors
// PR 2's `document.classifier.completed` PII discipline.
const buildAuditMetadata = ({
  match,
  document,
  semantic,
  firmId,
  clientId,
  documentId,
  parseRunId,
  blockers
}) => {
  const sem = (semantic && typeof semantic === 'object') ? semantic : {};
  return {
    parse_run_id: parseRunId || null,
    pr3_policy_version: AUTO_EXPLAIN_POLICY_VERSION,
    match_id: match.id,
    bank_transaction_id: match.bank_transaction_id,
    matched_object_id: documentId,
    firm_id: firmId,
    client_id: clientId,
    document_id: documentId,
    classifier_version: sem.classifier_version || null,
    prompt_version: sem.prompt_version || null,
    expense_kind: sem.expense_kind || null,
    tax_sensitivity: sem.tax_sensitivity || null,
    materiality_risk: sem.materiality_risk || null,
    confidence: typeof sem.confidence === 'number' ? sem.confidence : null,
    match_confidence: numericOrNull(match.match_confidence),
    amount_band: amountBand(document && document.total_amount),
    currency: (document && document.currency) || null,
    blockers
  };
};

// Async entry point. NEVER throws — every failure path leaves the
// transaction in a consistent state by letting the caller's
// `commit`/`rollback` win. Runs inside the writer's existing
// transaction so all PR 3 writes commit (or roll back) atomically
// with the parse.
export const autoExplainReceiptForDocument = async ({
  client,
  firmId,
  clientId,
  documentId,
  parseRunId = null
} = {}) => {
  const zero = { evaluated: 0, auto_explained: 0, blocked_reasons: {} };

  // Global kill switch — checked BEFORE any DB read. When off, the
  // entire module is dormant. Test 21 pins this.
  if (!isAutoExplainGloballyEnabled()) return zero;
  if (!client || !firmId || !clientId || !documentId) return zero;

  // 1. Per-firm config — one SELECT on `firms.metadata`. Defaults
  //    `receipt_enabled: false` for firms without the key.
  const firmConfig = await resolveFirmAutoExplainConfig(client, firmId);

  // 2. Load match rows for this document. We don't pre-filter by
  //    status — the gate's MATCH_NOT_SUGGESTED blocker handles that
  //    case and the audit log records it.
  const matchResult = await client.query(
    `select id, status, bank_transaction_id, matched_object_id, match_confidence, payload
       from reconciliation_matches
      where firm_id = $1 and client_id = $2
        and matched_object_type = 'receipt'
        and matched_object_id = $3
        and payload->>'source' = 'receipt_reconciliation'`,
    [firmId, clientId, documentId]
  );
  const matches = matchResult.rows || [];
  if (!matches.length) return zero;

  // 3. Load the document header. parse_summary.semantic is PR 2's
  //    sub-object; parse_summary.warnings is the deterministic-token
  //    list the gate inspects.
  const docResult = await client.query(
    `select id, total_amount, currency, payment_status, parse_summary
       from documents
      where firm_id = $1 and id = $2`,
    [firmId, documentId]
  );
  const document = (docResult.rows || [])[0];
  if (!document) return zero;

  const parseSummary = (document.parse_summary && typeof document.parse_summary === 'object')
    ? document.parse_summary
    : {};
  const semantic = (parseSummary.semantic && typeof parseSummary.semantic === 'object')
    ? parseSummary.semantic
    : null;
  const parseWarnings = Array.isArray(parseSummary.warnings) ? parseSummary.warnings : [];

  // 4. Load the bank transactions referenced by these matches. One
  //    SELECT, joined by ANY(text[]) — no N+1.
  const bankTxIds = Array.from(new Set(matches.map((m) => m.bank_transaction_id))).filter(Boolean);
  const txById = new Map();
  if (bankTxIds.length) {
    const txResult = await client.query(
      `select id, reconciliation_status, currency
         from transactions
        where firm_id = $1 and id = any($2::text[])`,
      [firmId, bankTxIds]
    );
    for (const row of (txResult.rows || [])) txById.set(row.id, row);
  }

  const stats = { evaluated: 0, auto_explained: 0, blocked_reasons: {} };

  for (const match of matches) {
    stats.evaluated += 1;

    const transaction = txById.get(match.bank_transaction_id) || null;
    const verdict = evaluateAutoExplainEligibility({
      match,
      document,
      transaction,
      semantic,
      parseWarnings,
      firmConfig
    });

    const evaluatedAt = new Date().toISOString();

    if (verdict.passed) {
      // Combined flip + payload merge. The `status='suggested'`
      // predicate makes the UPDATE a no-op on re-parse (the row has
      // since flipped to `auto_matched`), which suppresses the audit
      // emit below — that's how Test 2 (idempotent re-write) passes.
      const flipResult = await client.query(
        `update reconciliation_matches
            set status = 'auto_matched',
                payload = payload || $3::jsonb,
                updated_at = now()
          where id = $1 and firm_id = $2 and status = 'suggested'`,
        [
          match.id,
          firmId,
          JSON.stringify({
            auto_explain_blockers: [],
            auto_explain_evaluated_at: evaluatedAt
          })
        ]
      );

      const flipped = (flipResult && flipResult.rowCount > 0) ||
        (flipResult && Array.isArray(flipResult.rows) && flipResult.rows.length > 0);

      if (!flipped) {
        // Either the row was raced (auto_matched already) or the
        // writer is on a re-parse. Either way, suppress the cascade
        // + audit — the durable state already reflects the decision.
        continue;
      }

      stats.auto_explained += 1;

      // Transactions cascade. Predicate preserves any stronger status
      // the firm already set (`reconciled`, `posted`, `auto_reconciled`)
      // and is also idempotent on re-runs (`explained` excluded too,
      // so a second run no-ops cleanly).
      await client.query(
        `update transactions
            set reconciliation_status = 'explained',
                payload = payload || $3::jsonb,
                updated_at = now()
          where id = $1 and firm_id = $2
            and reconciliation_status is distinct from 'reconciled'
            and reconciliation_status is distinct from 'posted'
            and reconciliation_status is distinct from 'auto_reconciled'
            and reconciliation_status is distinct from 'explained'`,
        [
          match.bank_transaction_id,
          firmId,
          JSON.stringify({
            reconciliation_status: 'explained',
            reconciliation_match_id: match.id,
            reconciliation_match_type: 'receipt',
            reconciliation_match_object_id: documentId,
            auto_explained: true
          })
        ]
      );

      // Documents cascade. Tightened predicate (Q1b): only set
      // `paid` when the current status is unset/empty/unknown —
      // never overwrite an explicit firm-set `unpaid` / `partial`.
      // Excluding `paid` from the predicate also keeps the UPDATE
      // truly idempotent on re-parse.
      await client.query(
        `update documents
            set payment_status = 'paid',
                payload = payload || $3::jsonb,
                updated_at = now()
          where id = $1 and firm_id = $2
            and (payment_status is null or payment_status in ('', 'unknown'))`,
        [
          documentId,
          firmId,
          JSON.stringify({
            payment_status: 'paid',
            reconciliation_match_id: match.id,
            auto_explained: true
          })
        ]
      );

      // Audit. Emits once per FRESH flip — re-parses suppress via the
      // `continue` above.
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'reconciliation.auto_explained', 'reconciliation_match', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          match.id,
          JSON.stringify(
            buildAuditMetadata({
              match,
              document,
              semantic,
              firmId,
              clientId,
              documentId,
              parseRunId,
              blockers: []
            })
          )
        ]
      );
    } else {
      for (const blocker of verdict.blockers) {
        stats.blocked_reasons[blocker] = (stats.blocked_reasons[blocker] || 0) + 1;
      }

      // Always-on payload merge — PR 4's review UI reads
      // `payload.auto_explain_blockers` straight off the snapshot.
      await client.query(
        `update reconciliation_matches
            set payload = payload || $3::jsonb,
                updated_at = now()
          where id = $1 and firm_id = $2`,
        [
          match.id,
          firmId,
          JSON.stringify({
            auto_explain_blockers: verdict.blockers,
            auto_explain_evaluated_at: evaluatedAt
          })
        ]
      );

      // Blocked-path audit. Always emits — confirmed Q8 trade-off
      // (no dedupe across re-parses). `parse_run_id` in the metadata
      // makes downstream noise analysis tractable if it ever becomes
      // a problem.
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'reconciliation.auto_explain.blocked', 'reconciliation_match', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          match.id,
          JSON.stringify(
            buildAuditMetadata({
              match,
              document,
              semantic,
              firmId,
              clientId,
              documentId,
              parseRunId,
              blockers: verdict.blockers
            })
          )
        ]
      );
    }
  }

  return stats;
};
