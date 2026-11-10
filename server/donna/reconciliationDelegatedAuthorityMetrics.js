// Delegated authority — the §14 metrics that GATE the Slice-6 canary rollout.
// docs/proposal-2026-06-23-delegated-authority-material-matches.md §14.
//
// Pure OBSERVABILITY: this reads only persisted state (the grant store 040 and
// the authorization receipts on reconciliation_matches 002 — the held matches
// and the delegated accepts). It adds NO matching, scoring, or inference
// (trust-the-strong-LLM) — it counts what the pipeline already decided so the
// rollout can be reasoned about honestly. In V1 (canary off) every grant and
// delegated-accept counter is expected to read ZERO and MEAN it; the held
// counters are live (a material match the ceiling holds exists with or
// without the canary). A non-zero high-risk-archetype counter is a leak to chase.
//
// THE MODEL ID IS THE RECEIPT (CLAUDE.md): every model id is read FROM THE DATA
// (`reconciliation_authority_grants.model` and the match receipt's
// `payload.authorization->>'model'`), never from a
// code default — so a silently-downgraded model is visible when scoring quality.
//
// Fail-closed/soft: each aggregate is independent and a missing table
// (pre-migration 42P01/42703) zeroes only its own slice, never throwing into a
// caller. Conventions mirror the sibling stores (firmFacts / authority grants).

const V1_ARCHETYPES = ['recurring_rent_lease', 'verified_card_payment', 'internal_transfer'];

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
// A rate in [0, 1]; 0 when the denominator is 0 (no activity, not a div-by-zero).
const rate = (numerator, denominator) => {
  const d = num(denominator);
  return d > 0 ? num(numerator) / d : 0;
};
const toModels = (value) => (Array.isArray(value) ? value.filter((m) => m != null && m !== '') : []);

const isMissingTable = (error) => error?.code === '42P01' || error?.code === '42703';

const ZERO_GRANTS = {
  total: 0, active: 0, revoked: 0, suspended: 0, used: 0, corrected: 0, high_risk: 0, models: []
};
const ZERO_HELD = { total: 0, open: 0, confirmed: 0, one_time_confirmed: 0, rejected: 0, models: [] };
const ZERO_ACCEPTS = { count: 0, avg_amount: 0, models: [] };

const scopeClause = (clientId, baseParams) => {
  // Optional client narrowing. The grants and matches tables are both
  // (firm_id, client_id)-keyed, so the same $-shape works for each.
  if (clientId == null || clientId === '') return { where: '', params: baseParams };
  return { where: ' and client_id = $2', params: [...baseParams, clientId] };
};

const queryGrants = async (client, firmId, clientId) => {
  const { where, params } = scopeClause(clientId, [firmId]);
  try {
    const res = await client.query(
      `select
          count(*)::int as total,
          count(*) filter (where status = 'active')::int as active,
          count(*) filter (where status = 'revoked')::int as revoked,
          count(*) filter (where status = 'suspended')::int as suspended,
          count(*) filter (where use_count > 0)::int as used,
          count(*) filter (where correction_count > 0)::int as corrected,
          count(*) filter (where archetype <> all($${params.length + 1}::text[]))::int as high_risk,
          coalesce(array_agg(distinct model) filter (where model is not null), '{}') as models
         from reconciliation_authority_grants
        where firm_id = $1${where}`,
      [...params, V1_ARCHETYPES]
    );
    const row = res.rows[0] || {};
    return {
      total: num(row.total), active: num(row.active), revoked: num(row.revoked),
      suspended: num(row.suspended), used: num(row.used), corrected: num(row.corrected),
      high_risk: num(row.high_risk), models: toModels(row.models)
    };
  } catch (error) {
    if (isMissingTable(error)) return { ...ZERO_GRANTS };
    throw error;
  }
};

// The materiality-held matches — the LIVE source of "a held line no grant
// covered". (This slice used to count reconciliation_authorization_requests,
// migration 041: the firm authorization ask was RETIRED in E2 (2026-06-24) and
// nothing writes that table any more, so every counter read from it was a
// permanent zero that meant nothing.) A held match is the persisted receipt
// itself: payload.authorization with band 'suggested' and reasons EXACTLY
// ['above_materiality_ceiling'] (reconciliationLlmCore.isMatchedPendingAuthority).
// A one-time confirm or a rejection keeps that receipt (the confirm adds an
// authority_receipt beside it), so the receipt also says how each held line
// was decided; a grant-backed accept rewrites it to ['delegated_authority'] and
// is counted by queryDelegatedAccepts instead.
const queryHeldMatches = async (client, firmId, clientId) => {
  const { where, params } = scopeClause(clientId, [firmId]);
  try {
    const res = await client.query(
      `select
          count(*)::int as total,
          count(*) filter (where status = 'suggested')::int as open,
          count(*) filter (where status = 'confirmed')::int as confirmed,
          count(*) filter (where status = 'confirmed'
            and payload->'authorization'->'authority_receipt'->>'kind' = 'one_time_confirm')::int as one_time_confirmed,
          count(*) filter (where status = 'rejected')::int as rejected,
          coalesce(array_agg(distinct payload->'authorization'->>'model')
                   filter (where payload->'authorization'->>'model' is not null), '{}') as models
         from reconciliation_matches
        where firm_id = $1${where}
          and payload->'authorization'->>'band' = 'suggested'
          and payload->'authorization'->'reasons' = '["above_materiality_ceiling"]'::jsonb`,
      params
    );
    const row = res.rows[0] || {};
    return {
      total: num(row.total), open: num(row.open), confirmed: num(row.confirmed),
      one_time_confirmed: num(row.one_time_confirmed), rejected: num(row.rejected),
      models: toModels(row.models)
    };
  } catch (error) {
    if (isMissingTable(error)) return { ...ZERO_HELD };
    throw error;
  }
};

const queryDelegatedAccepts = async (client, firmId, clientId) => {
  const { where, params } = scopeClause(clientId, [firmId]);
  try {
    // A delegated accept is a settled match whose persisted receipt grantAuthority
    // wrote: reason EXACTLY ['delegated_authority']. Read the model off the same
    // receipt (the deploy-vintage id), never a code default.
    const res = await client.query(
      `select
          count(*)::int as count,
          coalesce(avg(match_amount), 0)::float as avg_amount,
          coalesce(array_agg(distinct payload->'authorization'->>'model')
                   filter (where payload->'authorization'->>'model' is not null), '{}') as models
         from reconciliation_matches
        where firm_id = $1${where}
          and status in ('auto_matched', 'confirmed')
          and payload->'authorization'->'reasons' = '["delegated_authority"]'::jsonb`,
      params
    );
    const row = res.rows[0] || {};
    return { count: num(row.count), avg_amount: num(row.avg_amount), models: toModels(row.models) };
  } catch (error) {
    if (isMissingTable(error)) return { ...ZERO_ACCEPTS };
    throw error;
  }
};

// Compute the §14 metric bundle for a firm (optionally a single client). Returns
// a flat, JSON-serialisable object of counts + rates + the model-id provenance.
// `client` is a pg-style { query } (the server's RLS-exempt owner connection);
// callers borrow it via withFirmDbClient. Never throws on a missing table.
export const computeDelegatedAuthorityMetrics = async ({ client, firmId, clientId = null } = {}) => {
  if (!client || !firmId) return null;
  const [grants, held, accepts] = await Promise.all([
    queryGrants(client, firmId, clientId),
    queryHeldMatches(client, firmId, clientId),
    queryDelegatedAccepts(client, firmId, clientId)
  ]);

  return {
    firm_id: firmId,
    client_id: clientId,
    // ── Effectiveness ──────────────────────────────────────────────────────
    grant_count: grants.total,
    grant_active_count: grants.active,
    grant_creation_count: grants.total, // every grant row is a mint (§8)
    grant_revocation_rate: rate(grants.revoked, grants.total),
    // hit rate = auto-accepted by a standing grant ÷ (auto-accepted + every
    // material match the ceiling held because no grant covered it — still
    // held, confirmed once by a person, or rejected).
    grant_hit_rate: rate(accepts.count, accepts.count + held.total),
    // a corrected grant auto-suspends (Slice-5 producer); the rate is over grants
    // that were actually used, so an untouched grant never dilutes it.
    post_grant_correction_rate: rate(grants.corrected, grants.used),
    avg_amount_auto_matched_by_grant: accepts.avg_amount,
    delegated_accept_count: accepts.count,
    // ── High-risk archetype guards (expected ZERO in V1) ───────────────────
    high_risk_archetype_grant_count: grants.high_risk,
    // No persisted column for "new account involved" — it is guarded fail-closed
    // upstream (findActiveAuthorityGrant `firstUseAccountInvolved`), so a grant
    // can never carry it; surfaced as a constant 0 for the §14 completeness.
    new_account_grant_count: 0,
    // ── Held for authority (the live queue: matches, not asks) ──────────────
    // A held match rests hanging on its bank line
    // (matched_pending_authority_no_grant) until a grant covers it or a person
    // decides; these count what the receipts say happened to each one.
    held_for_authority_open_count: held.open,
    held_for_authority_total: held.total,
    held_one_time_confirm_count: held.one_time_confirmed,
    held_confirmed_count: held.confirmed,
    held_rejected_count: held.rejected,
    // ── Provenance: the model id is the receipt ────────────────────────────
    models: {
      grants: grants.models,
      held_matches: held.models,
      delegated_accepts: accepts.models
    }
  };
};
