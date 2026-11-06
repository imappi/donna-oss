// Reconciliation PR 11 — safe supplier-bill auto-explain.
//
// AP-side sibling of PR 10's `salesInvoiceAutoExplain.js`. Structural
// shape is identical; the four substitutions that differentiate it:
//
//   1. matched_object_type='supplier_bill' (vs. 'sales_invoice').
//   2. payload->>'source' = 'bill_reconciliation' (vs.
//      'sales_invoice_reconciliation').
//   3. Transaction-side guard is `money_out > 0` AND NOT `money_in > 0`
//      (vs. AR's `money_in > 0` invariant).
//   4. Materiality cap default is TIGHTER — 5,000 vs. AR's 10,000.
//      The AP false-positive cost is asymmetric: a missed AR
//      auto-explain hurts customer trust (firm chases someone who
//      already paid); a missed AP auto-explain hits real money (firm
//      thinks it paid the vendor but didn't → late fees, SaaS
//      lockout, utility shutoff). The default reflects the asymmetry.
//      Per-firm `auto_explain.supplier_bill_max_amount` raises it.
//
// One additional strengthening over PR 10: the CURRENCY_MISMATCH gate
// fires whenever currencies cannot be confirmed equal (missing on
// either side OR unequal). PR 10's gate only fires on explicit
// mismatch. The cap is denominated in the bill's currency; inferring
// value across currencies is exactly the failure mode the cap exists
// to prevent, so unconfirmed currency must block.
//
// Cascade reuses the F2 helper `applyDocumentPaymentStatusAfterMatch`
// from firmDb.js, which already routes 'supplier_bill' through the
// same sum-based arithmetic as sales invoices (firmDb.js:2332). A tx
// that completes the settlement flips the bill to 'paid'; an earlier
// installment flips it to 'partial'. NEVER hardcoded.
//
// PII policy: audit metadata is IDs + categorical enums + bounded
// numbers only. No vendor names, references, descriptions.

import { applyDocumentPaymentStatusAfterMatch } from './firmDb.js';

// Policy version stamped onto every audit row.
export const AP_AUTO_EXPLAIN_POLICY_VERSION = 'supplier_bill_auto_explain_v1';

// Default materiality cap in the bill's currency. Per-firm override
// at `firms.metadata.auto_explain.supplier_bill_max_amount`. Set the
// per-firm value to `null` or the string `"unlimited"` to disable
// the cap entirely. Default is tighter than AR's by design (Q3).
const DEFAULT_AP_MAX_AUTO_EXPLAIN_AMOUNT = 5000;

// Default extraction-confidence floor. Shared with PR 3 / PR 10 via
// the `firms.metadata.auto_explain.confidence_floor` key.
const DEFAULT_EXTRACTION_CONFIDENCE_FLOOR = 0.85;

// `parse_summary.warnings` tokens that act as hard blockers.
const RED_FLAG_PARSE_WARNINGS = new Set([
  'amount_mismatch',
  'orphaned_lines_kept',
  'no_lines_detected'
]);

// `transactions.reconciliation_status` values that mean "already
// resolved" — PR 11 will not auto-explain past the soft state.
// Notably includes 'explained': if PR 89's bank-line auto-explain
// already moved the tx to 'explained', the firm has seen and accepted
// the no-receipt path; PR 11 must not silently override it (Q7).
const RESOLVED_TX_STATUSES = new Set([
  'explained',
  'auto_reconciled',
  'reconciled',
  'posted'
]);

const REQUIRED_PARSE_STATUS = 'completed';

export const AP_AUTO_EXPLAIN_BLOCKERS = Object.freeze({
  GLOBAL_DISABLED: 'global_disabled',
  FIRM_DISABLED: 'firm_disabled',
  MATCH_NOT_SUGGESTED: 'match_not_suggested',
  MATCH_NOT_AP: 'match_not_ap',
  BILL_MATCHER_NOT_ELIGIBLE: 'bill_matcher_not_eligible',
  DOCUMENT_PARSE_NOT_COMPLETED: 'document_parse_not_completed',
  DOCUMENT_DUPLICATE: 'document_duplicate',
  TRANSACTION_MISSING: 'transaction_missing',
  TRANSACTION_ALREADY_RESOLVED: 'transaction_already_resolved',
  TRANSACTION_NOT_MONEY_OUT: 'transaction_not_money_out',
  EXTRACTION_CONFIDENCE_BELOW_FLOOR: 'extraction_confidence_below_floor',
  PARSE_WARNING: 'parse_warning',
  AMOUNT_ABOVE_CAP: 'amount_above_cap',
  CURRENCY_MISMATCH: 'currency_mismatch',
  // Cross-entity guard (2026-08-04, §4b-xvi): the matcher stamped the match
  // as belonging to a DIFFERENT entity's document — never settle it.
  CROSS_ENTITY_MISMATCH: 'cross_entity_mismatch'
});

const isGloballyEnabled = () =>
  String(process.env.BILL_AUTO_EXPLAIN_ENABLED || '').toLowerCase() === 'true';

// Pure firm-config resolver — reads `firm.metadata.auto_explain`
// and merges over defaults. Default `supplier_bill_enabled: false`
// so every firm starts dark even when the global flag is on.
export const resolveBillAutoExplainConfig = (firm = {}) => {
  const meta = (firm && typeof firm === 'object' && firm.metadata && typeof firm.metadata === 'object')
    ? firm.metadata
    : {};
  const raw = (meta.auto_explain && typeof meta.auto_explain === 'object')
    ? meta.auto_explain
    : {};
  const floor = typeof raw.confidence_floor === 'number'
    && raw.confidence_floor >= 0
    && raw.confidence_floor <= 1
    ? raw.confidence_floor
    : DEFAULT_EXTRACTION_CONFIDENCE_FLOOR;
  // Materiality cap: number → use it; explicit null or "unlimited"
  // → no cap; anything else (including non-finite) → default.
  let cap;
  if (raw.supplier_bill_max_amount === null || raw.supplier_bill_max_amount === 'unlimited') {
    cap = null;
  } else if (typeof raw.supplier_bill_max_amount === 'number' && Number.isFinite(raw.supplier_bill_max_amount)) {
    cap = raw.supplier_bill_max_amount;
  } else {
    cap = DEFAULT_AP_MAX_AUTO_EXPLAIN_AMOUNT;
  }
  return {
    supplier_bill_enabled: raw.supplier_bill_enabled === true,
    extraction_confidence_floor: floor,
    supplier_bill_max_amount: cap
  };
};

export const resolveFirmBillAutoExplainConfig = async (client, firmId) => {
  const result = await client.query('select metadata from firms where id = $1', [firmId]);
  return resolveBillAutoExplainConfig(result.rows[0] || {});
};

// Bucketed amount band — categorical, PII-safe for audit metadata.
const amountBand = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 100) return '<100';
  if (n < 500) return '<500';
  if (n < 1000) return '<1000';
  if (n < 5000) return '<5000';
  if (n < 10000) return '<10000';
  if (n < 50000) return '<50000';
  return '>=50000';
};

const numericOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Pure gate — NEVER reads from the DB. Returns the verdict + a
// categorical blocker list. Evaluates EVERY blocker (no short-circuit)
// so the audit carries the full diagnostic list.
export const evaluateBillAutoExplainEligibility = ({
  match,
  document,
  transaction,
  parseWarnings = [],
  firmConfig
} = {}) => {
  const blockers = [];

  // Render the persisted verdict: the matcher stamps payload.cross_entity when
  // the document's own side does not match the book's identity
  // (crossEntityGuard.js). A stamped match must never settle a bank line —
  // the correct terminal is the owner ask carrying the relation.
  if (match?.payload?.cross_entity?.detected === true) {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.CROSS_ENTITY_MISMATCH);
  }

  if (!firmConfig || firmConfig.supplier_bill_enabled !== true) {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.FIRM_DISABLED);
  }

  // Match-side guards.
  if (!match || match.status !== 'suggested') {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.MATCH_NOT_SUGGESTED);
  }
  if (!match || match.matched_object_type !== 'supplier_bill') {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.MATCH_NOT_AP);
  }
  const matchReason = (match && match.payload && match.payload.match_reason) || {};
  if (matchReason.auto_match_passed !== true) {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.BILL_MATCHER_NOT_ELIGIBLE);
  }

  // Document-side guards.
  if (!document) {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_PARSE_NOT_COMPLETED);
  } else {
    if (document.parse_status !== REQUIRED_PARSE_STATUS) {
      blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_PARSE_NOT_COMPLETED);
    }
    if (document.duplicate_of) {
      blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.DOCUMENT_DUPLICATE);
    }
    const confidence = numericOrNull(document.extraction_confidence);
    const floor = firmConfig && typeof firmConfig.extraction_confidence_floor === 'number'
      ? firmConfig.extraction_confidence_floor
      : DEFAULT_EXTRACTION_CONFIDENCE_FLOOR;
    if (confidence === null || confidence < floor) {
      blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.EXTRACTION_CONFIDENCE_BELOW_FLOOR);
    }
  }

  // Parse-warning red flags.
  const warnings = Array.isArray(parseWarnings) ? parseWarnings : [];
  if (warnings.some((w) => RED_FLAG_PARSE_WARNINGS.has(w))) {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.PARSE_WARNING);
  }

  // Transaction-side guards.
  if (!transaction) {
    blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_MISSING);
  } else {
    if (RESOLVED_TX_STATUSES.has(transaction.reconciliation_status)) {
      blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_ALREADY_RESOLVED);
    }
    const moneyIn = Number(transaction.money_in || 0);
    const moneyOut = Number(transaction.money_out || 0);
    // AP direction invariant: money_out > 0 AND NOT money_in > 0.
    // Defense in depth — the bill matcher's SELECT already filters
    // for money_out, but if a match row arrived via another write
    // path the gate still refuses.
    if (!(moneyOut > 0) || moneyIn > 0) {
      blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.TRANSACTION_NOT_MONEY_OUT);
    }
    // Strict same-currency invariant — STRONGER than PR 10's. PR 11
    // requires both sides to declare a currency AND for them to
    // match. Missing on either side fires the blocker. The cap is
    // denominated in the bill's currency; inferring value across
    // currencies is exactly the failure mode the cap exists to
    // prevent.
    const docCurrency = document && document.currency
      ? String(document.currency).toUpperCase()
      : null;
    const txCurrency = transaction.currency
      ? String(transaction.currency).toUpperCase()
      : null;
    if (!docCurrency || !txCurrency || docCurrency !== txCurrency) {
      blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.CURRENCY_MISMATCH);
    }
  }

  // Materiality cap (Q3 — default 5,000, tighter than AR). Applied
  // against the DOCUMENT total_amount (firm exposure is the bill
  // value, not the bank-side partial). When the cap is null the gate
  // doesn't fire.
  if (firmConfig && firmConfig.supplier_bill_max_amount !== null && document) {
    const docAmount = numericOrNull(document.total_amount);
    const cap = Number(firmConfig.supplier_bill_max_amount);
    if (
      docAmount === null ||
      !Number.isFinite(cap) ||
      docAmount > cap
    ) {
      blockers.push(AP_AUTO_EXPLAIN_BLOCKERS.AMOUNT_ABOVE_CAP);
    }
  }

  return { passed: blockers.length === 0, blockers };
};

const buildAuditMetadata = ({
  match,
  document,
  firmId,
  clientId,
  documentId,
  parseRunId,
  blockers
}) => {
  const matchReason = (match && match.payload && match.payload.match_reason) || {};
  return {
    parse_run_id: parseRunId || null,
    pr11_policy_version: AP_AUTO_EXPLAIN_POLICY_VERSION,
    match_id: match.id,
    bank_transaction_id: match.bank_transaction_id,
    matched_object_id: documentId,
    match_kind: 'supplier_bill',
    firm_id: firmId,
    client_id: clientId,
    document_id: documentId,
    confidence_tier: matchReason.confidence_tier || null,
    match_confidence: numericOrNull(match.match_confidence),
    extraction_confidence: numericOrNull(document && document.extraction_confidence),
    amount_band: amountBand(document && document.total_amount),
    currency: (document && document.currency) || null,
    partial_completion: matchReason.partial_completion === true,
    blockers
  };
};

// Async entry point. Runs inside the writer's existing transaction
// so all PR 11 writes commit (or roll back) atomically with the
// parse. Caller (parseDocumentsDb.js) wraps this in a soft-degrade
// try/catch.
export const autoExplainBillForDocument = async ({
  client,
  firmId,
  clientId,
  documentId,
  parseRunId = null
} = {}) => {
  const zero = { evaluated: 0, auto_explained: 0, blocked_reasons: {} };

  // Global kill switch — checked BEFORE any DB read.
  if (!isGloballyEnabled()) return zero;
  if (!client || !firmId || !clientId || !documentId) return zero;

  // 1. Per-firm config — one SELECT on firms.metadata.
  const firmConfig = await resolveFirmBillAutoExplainConfig(client, firmId);

  // 2. Load PR 9 matcher's `'suggested'` match rows for this bill.
  //    Type + source filters narrow to AP matcher output. The
  //    `firm_manual_link` source intentionally bypasses this pass —
  //    those rows are already confirmed by a human.
  const matchResult = await client.query(
    `select id, status, bank_transaction_id, matched_object_id, matched_object_type,
            match_confidence, payload
       from reconciliation_matches
      where firm_id = $1 and client_id = $2
        and matched_object_type = 'supplier_bill'
        and matched_object_id = $3
        and payload->>'source' = 'bill_reconciliation'`,
    [firmId, clientId, documentId]
  );
  const matches = matchResult.rows || [];
  if (!matches.length) return zero;

  // 3. Load the bill header.
  const docResult = await client.query(
    `select id, total_amount, currency, payment_status, parse_status,
            extraction_confidence, parse_summary, duplicate_of
       from documents
      where firm_id = $1 and id = $2`,
    [firmId, documentId]
  );
  const document = (docResult.rows || [])[0];
  if (!document) return zero;

  const parseSummary = (document.parse_summary && typeof document.parse_summary === 'object')
    ? document.parse_summary
    : {};
  const parseWarnings = Array.isArray(parseSummary.warnings) ? parseSummary.warnings : [];

  // 4. Load the bank transactions referenced by these matches in
  //    one SELECT.
  const bankTxIds = Array.from(new Set(matches.map((m) => m.bank_transaction_id))).filter(Boolean);
  const txById = new Map();
  if (bankTxIds.length) {
    const txResult = await client.query(
      `select id, reconciliation_status, currency, money_in, money_out
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
    const verdict = evaluateBillAutoExplainEligibility({
      match,
      document,
      transaction,
      parseWarnings,
      firmConfig
    });

    const evaluatedAt = new Date().toISOString();

    if (verdict.passed) {
      // Promotion flip — predicate-guarded on prior status='suggested'
      // for idempotency. Re-parses and races no-op cleanly.
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
        // Race or re-parse — durable state already reflects the
        // decision. Suppress the cascade + audit.
        continue;
      }

      stats.auto_explained += 1;

      // Transaction cascade. Predicate preserves stronger statuses
      // and stays idempotent on re-runs. Mirrors PR 10's chain.
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
            reconciliation_match_type: 'supplier_bill',
            reconciliation_match_object_id: documentId,
            auto_explained: true
          })
        ]
      );

      // Document cascade — route through the F2 helper. Sum-based for
      // supplier_bill: a tx that completes the settlement flips to
      // 'paid'; an earlier installment flips to 'partial'. NEVER
      // hardcoded.
      await applyDocumentPaymentStatusAfterMatch({
        client,
        firmId,
        matchId: match.id,
        matchedObjectType: 'supplier_bill',
        documentId
      });

      // Audit. Emits once per FRESH flip — re-parses suppress via
      // the `continue` above.
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

      // Always-on payload merge — review UI reads
      // `payload.auto_explain_blockers` off the snapshot.
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

      // Blocked-path audit. Always emits — same trade-off as PR 10.
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
