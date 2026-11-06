// Donna — per-transaction duplicate-candidate index (Accounting Runtime Hardening, Slice F flag source).
//
// The case snapshot's `duplicate_risk` flag asks: "does a duplicate-candidate signal exist for
// the focus transaction?" (operatorCaseSnapshot.deriveCaseRiskFlags step 5). The snapshot already
// CONSUMES `context.duplicateCandidateIds` — it just needs that array supplied. This read is the
// source: it finds OTHER transactions for the same client that plausibly represent the SAME
// economic event as the focus row, and returns their ids.
//
// What "the same event" means here — and why it is NOT the synthetic primary key. The
// `transactions.id` ON CONFLICT key (firmDb.js / parseDocumentsDb.js) already collapses an exact
// re-import of the SAME line; a row sharing the focus row's `id` IS the focus row. A duplicate
// RISK is the opposite case: a DIFFERENT `id` standing for the same charge — a bank-feed re-import
// under a fresh id, or the same payment entered twice. `transactions` carries no `duplicate_of`
// column (that lives on `documents` only), so there is no persisted verdict to render; this read
// computes the candidate set from the two human-spottable identities:
//   1. STRONG — a shared non-null `external_transaction_id` (the bank's own stable id). Two rows
//      with the same external id under different `id`s are almost certainly one line imported twice.
//   2. SPOTTABLE — same `transaction_date` + same `money_in` + same `money_out` + same `currency`,
//      with at least one amount non-zero (so all-zero rows don't match every other zero row). This
//      is the "you entered this twice" a reviewer catches in a second.
// Currency is matched with `is not distinct from` so a null currency matches a null, but a
// cross-currency same-amount pair is NOT a candidate. Status is deliberately NOT filtered: a
// duplicate at any review state is still worth surfacing — this is a candidate signal for the
// strong model / reviewer to judge, never a decision.
//
// A candidate INDEX, never a verdict (the two-terminal-states + trust-the-strong-LLM rails): it
// reports which rows look alike, it never decides which is the duplicate to drop. Injected `client`
// (unit-testable with a mock).
//
// Return contract — note this differs DELIBERATELY from clientAccountHistory's:
//   - success, candidates found  → [id, …]  (a real "duplicate signal exists" → snapshot flags)
//   - success, none found        → []        (a real "no duplicate" signal → snapshot clears)
//   - missing args / schema soft-fail → null (caller leaves the input ABSENT → snapshot UNKNOWN)
// For first_use_account an empty result means "no history → everything is first-use" — flagging,
// the conservative direction — so [] on soft-fail is safe there. Here an empty result CLEARS the
// risk, so returning [] on a soft-fail would falsely assert "no duplicate." We therefore return
// `null` (→ honest `unknown`) whenever we could not actually answer, reserving `[]` for a query
// that genuinely ran and found nothing. (Pre-migration is theoretical — every column here is
// migration ≤ 002 — but the asymmetry is the load-bearing point; verified against sqlWriterLint.)

export const loadDuplicateCandidateIdsForTransaction = async ({
  client, firmId, clientId, transactionId
} = {}) => {
  if (!client || !firmId || !clientId || !transactionId) return null;
  let result;
  try {
    // Self-join: anchor on the focus row (firm + client + id), match OTHER rows of the same
    // client by the strong id or the spottable amount+date+currency identity. Fully parameterized;
    // LIMIT bounds the candidate array.
    result = await client.query(
      `select other.id as id
         from transactions focus
         join transactions other
           on other.firm_id = focus.firm_id
          and other.client_id = focus.client_id
          and other.id <> focus.id
          and (
               (focus.external_transaction_id is not null
                 and other.external_transaction_id is not null
                 and other.external_transaction_id = focus.external_transaction_id)
            or ((focus.money_in <> 0 or focus.money_out <> 0)
                 and focus.transaction_date is not null
                 and other.transaction_date = focus.transaction_date
                 and other.money_in = focus.money_in
                 and other.money_out = focus.money_out
                 and other.currency is not distinct from focus.currency)
             )
        where focus.firm_id = $1
          and focus.client_id = $2
          and focus.id = $3
        limit 50`,
      [firmId, clientId, transactionId]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null; // pre-migration → unknown
    throw error;
  }
  const ids = new Set();
  for (const row of result.rows || []) {
    const id = typeof row.id === 'string' ? row.id.trim() : (row.id != null ? String(row.id).trim() : '');
    if (id) ids.add(id);
  }
  return [...ids];
};
