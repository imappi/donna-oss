// PR 3 of docs/invoice-receipt-parsing-plan.md. Firm-side PATCH
// `/api/donna/firms/documents/<id>/lines/<line_id>` — edits a single
// document_lines row and, when `review_status='accepted'`, closes
// the matching transaction_review_queue rows in the SAME transaction.
//
// Three invariants drive the implementation:
//
//   1. Cross-firm reads / writes are blocked. The handler asserts
//      assertFirmAccess + getDocumentForParseInDb at the API layer;
//      the SQL also predicates on (firm_id, document_id, id) so a
//      mis-scoped call returns 0 rows updated and we throw 404.
//   2. Firm decisions are sticky. Setting account_code or category
//      (or any structural field) by hand stamps coding_source =
//      'firm_override' + coding_confidence = 1.00 — invariant 3 of
//      the re-parse merge contract.
//   3. Queue closure is atomic with the row PATCH. If the queue
//      UPDATE throws, the row UPDATE rolls back too. Tests pin this
//      (out-of-band closure would leave the firm with phantom queue
//      rows pointing at an accepted line).
//
// PATCH does NOT mint a new parse_run_id — it updates one row by
// (firm_id, document_id, id) and returns the new state plus the ids
// of any queue rows that were closed.

import { buildClientRuleId, DEFAULT_FIRM_ID, withFirmDbClient } from './firmDb.js';
import { lineFingerprint } from './lineFingerprint.js';
import { emitReviewAudit } from './reviewItem.js';
import { canonicalMerchantPattern } from './transactionIntel.js';

const MIN_RULE_PATTERN_LENGTH = 3;

const ALLOWED_REVIEW_STATUSES = new Set(['needs_review', 'accepted', 'deferred']);
const STRUCTURAL_FIELDS = new Set([
  'description',
  'quantity',
  'unit_price',
  'amount',
  'tax_rate'
]);
const CODING_FIELDS = new Set(['account_code', 'category']);

const toIso = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

const lineRowToDto = (row) => ({
  id: row.id,
  document_id: row.document_id,
  line_no: row.line_no,
  description: row.description,
  quantity: row.quantity == null ? null : Number(row.quantity),
  unit_price: row.unit_price == null ? null : Number(row.unit_price),
  amount: row.amount == null ? null : Number(row.amount),
  tax_rate: row.tax_rate == null ? null : Number(row.tax_rate),
  fingerprint: row.fingerprint,
  account_code: row.account_code,
  category: row.category,
  coding_confidence: row.coding_confidence == null ? null : Number(row.coding_confidence),
  coding_source: row.coding_source,
  review_status: row.review_status || 'needs_review',
  payload: row.payload || null,
  created_at: toIso(row.created_at),
  updated_at: toIso(row.updated_at)
});

const buildNotFound = () => {
  const error = new Error('Document line was not found.');
  error.statusCode = 404;
  error.code = 'DOCUMENT_LINE_NOT_FOUND';
  return error;
};

const buildInvalidReviewStatus = (value) => {
  const error = new Error(`Invalid review_status: ${value}`);
  error.statusCode = 400;
  error.code = 'INVALID_LINE_REVIEW_STATUS';
  error.details = { allowed: [...ALLOWED_REVIEW_STATUSES] };
  return error;
};

const buildMakeRuleRequiresCoding = () => {
  const error = new Error('make_rule requires both account_code and category in the patch body.');
  error.statusCode = 400;
  error.code = 'MAKE_RULE_REQUIRES_CODING';
  return error;
};

const buildMakeRuleRequiresVendor = () => {
  const error = new Error('make_rule requires the parent document to have a non-empty vendor_name.');
  error.statusCode = 400;
  error.code = 'MAKE_RULE_REQUIRES_VENDOR';
  return error;
};

// Determine whether a field is set in the patch (presence-aware).
const hasKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export const __patchDocumentLineWithClient = async ({
  client,
  firmId,
  documentId,
  lineId,
  patch = {}
}) => {
  if (!firmId || !documentId || !lineId) throw buildNotFound();

  await client.query('begin');
  try {
    const existingResult = await client.query(
      `select id, firm_id, client_id, document_id, line_no,
              description, quantity, unit_price, amount, tax_rate,
              fingerprint, account_code, category,
              coding_confidence, coding_source, review_status,
              payload, created_at, updated_at
         from document_lines
        where firm_id=$1 and document_id=$2 and id=$3
        for update`,
      [firmId, documentId, lineId]
    );
    if (!existingResult.rows.length) {
      await client.query('rollback');
      throw buildNotFound();
    }
    const existing = existingResult.rows[0];
    const clientId = existing.client_id;

    // Validate review_status if present.
    let nextReviewStatus = existing.review_status || 'needs_review';
    if (hasKey(patch, 'review_status')) {
      const requested = String(patch.review_status || '').trim();
      if (!ALLOWED_REVIEW_STATUSES.has(requested)) {
        await client.query('rollback');
        throw buildInvalidReviewStatus(patch.review_status);
      }
      nextReviewStatus = requested;
    }

    // PR 4 — Make-a-rule preconditions. Validate BEFORE the line
    // UPDATE so a 400 leaves the DB untouched. The rule INSERT itself
    // runs after the line UPDATE + queue close, inside the same
    // transaction (invariant 3 — firm decisions are atomic). Failure
    // there triggers the outer try/catch rollback.
    const wantsRule = patch?.make_rule === true;
    let rulePattern = '';
    if (wantsRule) {
      const ruleAccountCode = hasKey(patch, 'account_code') ? patch.account_code : null;
      const ruleCategory = hasKey(patch, 'category') ? patch.category : null;
      if (!ruleAccountCode || !String(ruleAccountCode).trim() ||
          !ruleCategory || !String(ruleCategory).trim()) {
        await client.query('rollback');
        throw buildMakeRuleRequiresCoding();
      }
      // Re-read the parent document's vendor_name inside the
      // transaction — never trust client-supplied vendor data.
      const docResult = await client.query(
        `select vendor_name from documents where firm_id=$1 and id=$2`,
        [firmId, documentId]
      );
      const docVendor = docResult.rows[0]?.vendor_name || '';
      rulePattern = canonicalMerchantPattern(docVendor);
      if (!rulePattern || rulePattern.length < MIN_RULE_PATTERN_LENGTH) {
        await client.query('rollback');
        throw buildMakeRuleRequiresVendor();
      }
    }

    // Structural updates (description/quantity/unit_price/amount/tax_rate)
    // are present-aware: only fields included in the patch get
    // overwritten. Same for coding fields.
    const nextDescription = hasKey(patch, 'description') ? patch.description : existing.description;
    const nextQuantity    = hasKey(patch, 'quantity')    ? patch.quantity    : existing.quantity;
    const nextUnitPrice   = hasKey(patch, 'unit_price')  ? patch.unit_price  : existing.unit_price;
    const nextAmount      = hasKey(patch, 'amount')      ? patch.amount      : existing.amount;
    const nextTaxRate     = hasKey(patch, 'tax_rate')    ? patch.tax_rate    : existing.tax_rate;
    const nextAccountCode = hasKey(patch, 'account_code') ? patch.account_code : existing.account_code;
    const nextCategory    = hasKey(patch, 'category')    ? patch.category    : existing.category;

    // Did the firm touch anything (structural or coding)? Firm-touch
    // stamps coding_source='firm_override' + coding_confidence=1.00 so
    // the re-parse merge preserves the row and PR 5's re-suggest
    // refuses to overwrite. Invariant 3.
    const touchedCoding = [...CODING_FIELDS].some((key) => hasKey(patch, key));
    const touchedStructural = [...STRUCTURAL_FIELDS].some((key) => hasKey(patch, key));
    const isFirmTouched = touchedCoding || touchedStructural;

    let nextCodingSource = existing.coding_source;
    let nextCodingConfidence = existing.coding_confidence;
    if (isFirmTouched) {
      nextCodingSource = 'firm_override';
      nextCodingConfidence = 1.00;
    }

    // Recompute the fingerprint when any field that feeds into it
    // changed. The algorithm is locked; this is mostly a no-op write
    // but stays defensive against amount/qty/desc edits.
    const fpInputs = {
      description: nextDescription,
      quantity: nextQuantity,
      unit_price: nextUnitPrice,
      amount: nextAmount,
      currency: existing.payload?.currency || null
    };
    const nextFingerprint = isFirmTouched
      ? lineFingerprint(fpInputs)
      : existing.fingerprint;

    const updated = await client.query(
      `update document_lines
         set description=$4,
             quantity=$5,
             unit_price=$6,
             amount=$7,
             tax_rate=$8,
             account_code=$9,
             category=$10,
             review_status=$11,
             coding_source=$12,
             coding_confidence=$13,
             fingerprint=$14,
             updated_at=now()
       where firm_id=$1 and document_id=$2 and id=$3
       returning id, document_id, line_no, description, quantity,
                 unit_price, amount, tax_rate, fingerprint,
                 account_code, category, coding_confidence,
                 coding_source, review_status, payload,
                 created_at, updated_at`,
      [
        firmId, documentId, lineId,
        nextDescription, nextQuantity, nextUnitPrice, nextAmount, nextTaxRate,
        nextAccountCode, nextCategory,
        nextReviewStatus, nextCodingSource, nextCodingConfidence,
        nextFingerprint
      ]
    );

    // Queue-row handling. Invariant 5 — same transaction as the row
    // UPDATE so a throw rolls both back.
    let closedReviewItemIds = [];
    if (nextReviewStatus === 'accepted') {
      const closeResult = await client.query(
        `update transaction_review_queue
            set status='resolved',
                payload = coalesce(payload, '{}'::jsonb) || $3::jsonb,
                updated_at = now()
          where firm_id=$1
            and item_type='document_line'
            and item_id=$2
            and status='open'
          returning id`,
        [firmId, lineId, JSON.stringify({ closed_by: 'firm_patch', closed_via: 'line_accept' })]
      );
      closedReviewItemIds = closeResult.rows.map((r) => r.id);
    } else if (nextReviewStatus === 'deferred' && hasKey(patch, 'notes')) {
      await client.query(
        `update transaction_review_queue
            set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb,
                updated_at = now()
          where firm_id=$1
            and item_type='document_line'
            and item_id=$2
            and status='open'`,
        [firmId, lineId, JSON.stringify({ notes: patch.notes })]
      );
    }

    // PR 4 — Make-a-rule INSERT. Same transaction as the line UPDATE
    // + queue close; if this throws, the outer catch rolls everything
    // back (invariant 3). Idempotency: rule id is derived from
    // (clientId, normalizedPattern, accountCode) so a second Make-a-rule
    // on the same vendor + account hits `on conflict (id) do update`
    // and re-affirms the rule instead of duplicating it.
    let createdRuleId = null;
    let ruleExistedBefore = false;
    if (wantsRule) {
      const ruleAccountCode = String(patch.account_code).trim();
      const ruleCategory = String(patch.category).trim();
      createdRuleId = buildClientRuleId({
        clientId,
        normalizedPattern: rulePattern,
        accountCode: ruleAccountCode
      });
      const existingRuleResult = await client.query(
        `select id, status from client_rules where id=$1 and firm_id=$2`,
        [createdRuleId, firmId]
      );
      ruleExistedBefore = existingRuleResult.rows.length > 0;
      const rulePayload = {
        source: 'document_line_override',
        source_document_id: documentId,
        source_line_id: lineId,
        merchant_pattern: rulePattern,
        account_code: ruleAccountCode,
        account_label: ruleCategory,
        label: `${rulePattern} -> ${ruleAccountCode}`,
        confidence: 1.00
      };
      await client.query(
        `insert into client_rules (
           id, firm_id, client_id, rule_type, pattern_text, category_override,
           account_code, reconciliation_behavior, notes, created_by, status, payload
         )
         values ($1, $2, $3, 'merchant_category', $4, null, $5, null, $6, 'human', 'active', $7::jsonb)
         on conflict (id) do update set
           pattern_text = excluded.pattern_text,
           account_code = excluded.account_code,
           notes = excluded.notes,
           status = 'active',
           payload = client_rules.payload || excluded.payload,
           updated_at = now()`,
        [
          createdRuleId,
          firmId,
          clientId,
          rulePattern,
          ruleAccountCode,
          `Use ${ruleAccountCode} for ${rulePattern}.`,
          JSON.stringify(rulePayload)
        ]
      );
      // Dedicated audit for the rule mutation. This is a new vocabulary
      // — the transaction-side `saveMerchantRuleForPayload` doesn't
      // emit one today (rule mutations there ride along on
      // `transaction.update` patch_keys). PR 4 establishes
      // `client_rule.created` as the canonical event for rule creates
      // from any surface. Metadata: rule_id + source pointers +
      // canonical pattern (not raw vendor — invariant 4) +
      // existed_before so test 13's idempotency is observable.
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'client_rule.created', 'client_rule', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          createdRuleId,
          JSON.stringify({
            source: 'document_line_override',
            source_document_id: documentId,
            source_line_id: lineId,
            vendor_normalized_pattern: rulePattern,
            account_code: ruleAccountCode,
            existed_before: ruleExistedBefore
          })
        ]
      );
    }

    // Audit. PR 3 vocabulary — no legacy alias to dual-emit (this is a
    // brand-new endpoint). Metadata stays IDs/counts only per the
    // plan's PII policy: no description text, no account_code value,
    // no notes text.
    let auditAction = null;
    if (hasKey(patch, 'review_status')) {
      if (nextReviewStatus === 'accepted') {
        auditAction = touchedCoding ? 'review.overridden' : 'review.accepted';
      } else if (nextReviewStatus === 'deferred') {
        auditAction = 'review.deferred';
      }
    }
    if (auditAction) {
      await emitReviewAudit(client, {
        firmId,
        clientId,
        itemType: 'document_line',
        itemId: lineId,
        action: auditAction,
        metadata: {
          document_id: documentId,
          review_status: nextReviewStatus,
          coding_source: nextCodingSource,
          coding_confidence:
            nextCodingConfidence == null ? null : Number(nextCodingConfidence)
        }
      });
    }
    // Always emit a structural edit audit when the firm changed fields
    // but didn't change review_status — captures inline cell edits.
    if (!auditAction && touchedStructural) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'document.line.edited', 'document_line', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          lineId,
          JSON.stringify({
            document_id: documentId,
            coding_source: nextCodingSource,
            // Boolean flags only — values stay out of audit metadata.
            edited_structural: true
          })
        ]
      );
    }

    await client.query('commit');
    return {
      line: lineRowToDto(updated.rows[0]),
      closed_review_item_ids: closedReviewItemIds,
      created_rule_id: createdRuleId,
      rule_existed_before: createdRuleId ? ruleExistedBefore : null
    };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  }
};

export const patchDocumentLineInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  documentId,
  lineId,
  patch = {}
} = {}) =>
  withFirmDbClient(async (client) =>
    __patchDocumentLineWithClient({ client, firmId, documentId, lineId, patch })
  );
