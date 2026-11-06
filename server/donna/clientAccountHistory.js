// Donna — client account-coding history (Accounting Runtime Hardening, Slice F flag source).
//
// The case snapshot's `first_use_account` risk flag asks: "is this the first time this
// account is proposed for the client?" (operatorCaseSnapshot.deriveCaseRiskFlags). To answer
// it the snapshot needs the set of accounts the client has ALREADY been coded to — the
// `knownAccountKeys` riskContext input. Absent that set the flag resolves the honest
// `unknown`; this read supplies it so the flag can resolve clear/flagged.
//
// PERSISTED codings only. The "coded account" identifiers come from the persisted
// `account_code` column and the persisted payload fields (`payload.account_code` /
// `payload.account_name`) — NOT `payload.ai_suggestion.proposed_account`, which is the
// model's volatile PROPOSAL. Including the proposal would let a not-yet-applied suggestion
// make its own account look "known", defeating the first-use signal. (Note: `transactions`
// has no `account_name` COLUMN — that identifier lives only in the JSON payload — so the
// column read is `account_code` only; verified against migration 002 + sqlWriterLint.) The
// focus transaction is excluded so a row can't count itself as its own precedent.
//
// A history aggregate, never a decision: it reads what accounts exist, it never decides
// whether a coding is right. Injected `client` (unit-testable with a mock); pre-migration
// soft-fail (42P01/42703 → []), matching the other runtime reads.

export const loadKnownAccountKeysForClient = async ({
  client, firmId, clientId, excludeTransactionId = null
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  let result;
  try {
    // Select the three candidate identifiers (only real columns: the `account_code` column
    // + two payload fields); DISTINCT trims the row count, the dedupe across the three
    // fields happens in JS below. Fully parameterized.
    result = await client.query(
      `select distinct
              t.account_code as code,
              t.payload->>'account_code' as payload_code,
              t.payload->>'account_name' as payload_name
         from transactions t
        where t.firm_id = $1
          and t.client_id = $2
          and ($3::text is null or t.id <> $3)`,
      [firmId, clientId, excludeTransactionId]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return [];
    throw error;
  }
  const keys = new Set();
  for (const row of result.rows || []) {
    for (const v of [row.code, row.payload_code, row.payload_name]) {
      const k = typeof v === 'string' ? v.trim() : (v != null ? String(v).trim() : '');
      if (k) keys.add(k);
    }
  }
  return [...keys];
};
