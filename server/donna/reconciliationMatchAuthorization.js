// Donna — per-transaction reconciliation-match authorization reader (Slice G consumer).
//
// Slice G's `renderAuthorityEnvelopeFromAuthorization` (authorityEnvelope.js) RENDERS the
// matcher's PERSISTED authorization receipt (`reconciliation_matches.payload.authorization`:
// band + reasons, written by grantAuthority / autoFyiAuthority / authorizeMatch) into the
// two-terminal-states envelope — but it had no live source. This read is that source: given a
// focus bank transaction, it returns the authorization receipt the matcher persisted for it, so
// the shadow Operator-Contract receipt's `matchVerdict` (preflight's `match_reconciles` check)
// RENDERS the persisted reconciliation verdict instead of always being `null`.
//
// A match links to the bank line via `reconciliation_matches.bank_transaction_id =
// transactions.id` (migration 002). `payload->'authorization'` carries the receipt; it can be
// null even when a match row exists (a pre-authorization match), in which case there is nothing
// to render and the caller emits NO check — the honest "render the persisted verdict, not the
// legacy layer" posture (CLAUDE.md). It NEVER recomputes the gates or the grant lookup; it only
// reads the persisted receipt. Injected `client` (unit-testable with a mock).
//
// Return contract (deliberately simpler than the duplicate reader's []/null asymmetry — here
// BOTH "no match" and "could not answer" collapse to the same SAFE outcome, no check):
//   - a match with a persisted authorization → the authorization object
//   - no match, or a match with no authorization → null (→ no match check)
//   - missing args / schema soft-fail → null (→ no match check)
// `null` is the conservative direction for a match check: an unmatched / unauthorized line
// must NOT manufacture a "does not reconcile" verdict out of a read failure.

export const loadMatchAuthorizationForTransaction = async ({
  client, firmId, clientId, transactionId
} = {}) => {
  if (!client || !firmId || !clientId || !transactionId) return null;
  let result;
  try {
    // The latest match for the focus bank line; render only the persisted authorization receipt.
    result = await client.query(
      `select payload->'authorization' as authorization
         from reconciliation_matches
        where firm_id = $1
          and client_id = $2
          and bank_transaction_id = $3
        order by created_at desc
        limit 1`,
      [firmId, clientId, transactionId]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null; // pre-migration → no check
    throw error;
  }
  const authorization = result.rows?.[0]?.authorization ?? null;
  return authorization && typeof authorization === 'object' ? authorization : null;
};
