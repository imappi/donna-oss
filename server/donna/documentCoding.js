// PR 4 of docs/invoice-receipt-parsing-plan.md — rules-only coding pass.
//
// Runs inside the writer's transaction (between the parse_run_id gate
// UPDATE and `mergeDocumentLinesForRun`) and, when an active rule
// exists for the receipt's canonical vendor, stamps every extracted
// line with the rule's account_code + accepted state. The merge then
// honours those values on its no-match and needs_review-match branches
// — see `mergeDocumentLinesForRun` in parseDocumentsDb.js for the
// branch matrix. Accepted/deferred matches stay sticky regardless.
//
// Hard invariants (mirror the PR 4 handoff):
//   2. Rule-coded lines enter the merge with review_status='accepted'.
//      This is the FIRST non-firm writer of accepted status, so the
//      merge's protect-edits contract (invariant 1/3) is the sole
//      safety net for retries.
//   4. Audit metadata stays PII-safe — rule_id + canonical pattern +
//      counts only. No account_code, no raw vendor name.
//   5. The pass lives inside the writer's transaction; a rollback
//      above us (e.g. stale parse_run_id) means our SELECTs never
//      fire because the caller short-circuits before invoking us.
//   7. Re-parse never clears coding_source='client_rule' from
//      accepted rows. The accepted-branch in the merge stays verbatim
//      from PR 3 — we only stamp here; preservation belongs to the
//      merge.

import { canonicalMerchantPattern } from './transactionIntel.js';

const MIN_PATTERN_LENGTH = 3;

// Returns the input lines unchanged when there's no rule to apply,
// or a new array with each entry shallow-merged with the rule's
// coding fields when one fires. The caller passes the resulting
// array into the merge.
//
// Audit: emits exactly one `document.line.rule_applied` per document
// when a rule fires (never per-line — that would noise the log
// without adding signal; the rule_id correlates to all coded lines
// via parse_summary). Skipped entirely when no rule matches or the
// line set is empty.
// Strip any coding fields that might have ridden in on raw extractor
// output. The LLM is untrusted as a writer of coding state — only the
// coding pass (which reads from `client_rules` inside the writer
// transaction) is allowed to stamp `coding_source='client_rule'` /
// `matched_client_rule_id` / `review_status='accepted'`. Anything the
// extractor put on those keys gets dropped before the merge sees it.
const stripCodingFields = (line) => {
  if (!line || typeof line !== 'object') return line;
  const {
    coding_source: _cs,
    coding_confidence: _cc,
    review_status: _rs,
    account_code: _ac,
    category: _cat,
    matched_client_rule_id: _mid,
    ...rest
  } = line;
  return rest;
};

export const codeDocumentLinesByRule = async ({
  client,
  firmId,
  clientId,
  documentId,
  vendorName,
  lines
} = {}) => {
  const sanitized = Array.isArray(lines) ? lines.map(stripCodingFields) : [];
  // The caller passes `sanitized` into the merge regardless of whether
  // a rule fires — this guarantees the merge never sees extractor-
  // supplied coding fields. `codedLines` starts as `sanitized` and is
  // overwritten in-place if a rule applies.
  const codedLines = sanitized.slice();
  if (!codedLines.length) {
    return { codedLines, ruleMatches: 0, ruleId: null, vendorPattern: '' };
  }
  if (!firmId || !clientId || !documentId) {
    return { codedLines, ruleMatches: 0, ruleId: null, vendorPattern: '' };
  }

  const vendorPattern = canonicalMerchantPattern(vendorName);
  if (!vendorPattern || vendorPattern.length < MIN_PATTERN_LENGTH) {
    return { codedLines, ruleMatches: 0, ruleId: null, vendorPattern: '' };
  }

  // Merchant resolution: canonical name first, alias fallback. A vendor
  // that exists in `merchants` AND in `merchant_aliases` (self-alias)
  // collapses to a single hit via UNION ALL + rank ordering. Returns
  // null when the vendor is unknown — first-time merchant creation
  // belongs to PR 6.
  const merchantResult = await client.query(
    `select id from (
       select id, 1 as rank from merchants
        where firm_id=$1 and normalized_name=$2
       union all
       select merchant_id as id, 2 as rank from merchant_aliases
        where firm_id=$1 and normalized_alias=$2
     ) m order by rank asc limit 1`,
    [firmId, vendorPattern]
  );
  const merchantId = merchantResult.rows[0]?.id || null;

  // Active rule lookup. Two attachment paths — direct merchant_id (PR 6+)
  // or pattern_text equality (today's transaction-side rules). The
  // updated_at DESC + LIMIT 1 gives a deterministic tiebreak when a
  // firm has overlapping rules; PR 5 will refine with confidence.
  const rulesResult = await client.query(
    `select id, account_code, category_override, payload
       from client_rules
      where firm_id=$1
        and client_id=$2
        and rule_type='merchant_category'
        and status='active'
        and ( ($3::text is not null and merchant_id=$3)
              or pattern_text=$4 )
      order by updated_at desc
      limit 1`,
    [firmId, clientId, merchantId, vendorPattern]
  );
  if (!rulesResult.rows.length) {
    return { codedLines, ruleMatches: 0, ruleId: null, vendorPattern };
  }
  const rule = rulesResult.rows[0];
  // Defensive: a rule without an account_code can't code anything.
  // Belt-and-suspenders — the merge's honour-input guard checks the
  // same thing, but bailing here keeps the audit clean.
  if (!rule.account_code) {
    return { codedLines, ruleMatches: 0, ruleId: null, vendorPattern };
  }

  const label = rule.payload?.account_label || rule.category_override || null;
  for (let i = 0; i < codedLines.length; i++) {
    codedLines[i] = {
      ...codedLines[i],
      account_code: rule.account_code,
      category: label,
      coding_source: 'client_rule',
      coding_confidence: 1.00,
      review_status: 'accepted',
      matched_client_rule_id: rule.id
    };
  }

  // One audit per document. Metadata is rule_id + canonical pattern +
  // count — no account_code value (invariant 4), no raw vendor name
  // (the pattern is the rule's matching scope; raw vendor lives on
  // the documents row already).
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'document.line.rule_applied', 'document', $3, $4::jsonb)`,
    [
      firmId,
      clientId,
      documentId,
      JSON.stringify({
        rule_id: rule.id,
        vendor_normalized_pattern: vendorPattern,
        lines_coded: codedLines.length
      })
    ]
  );

  return {
    codedLines,
    ruleMatches: codedLines.length,
    ruleId: rule.id,
    vendorPattern
  };
};
