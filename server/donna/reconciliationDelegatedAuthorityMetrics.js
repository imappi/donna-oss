// Delegated authority — the §14 metrics that GATE the Slice-6 canary rollout.
// docs/proposal-2026-06-23-delegated-authority-material-matches.md §14.
//
// Pure OBSERVABILITY: this reads only persisted state (the grant store 040, the
// authorization-request store 041, and the delegated-accept receipt on
// reconciliation_matches 002). It adds NO matching, scoring, or inference
// (trust-the-strong-LLM) — it counts what the pipeline already decided so the
// rollout can be reasoned about honestly. In V1 (canary off) every counter is
// expected to read ZERO and MEAN it: no grants minted, no asks opened, no
// delegated accepts. A non-zero high-risk-archetype counter is a leak to chase.
//
// THE MODEL ID IS THE RECEIPT (CLAUDE.md): every model id is read FROM THE DATA
// (`reconciliation_authority_grants.model`, `..._requests.model`, and the
// delegated-accept receipt's `payload.authorization->>'model'`), never from a
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
const ZERO_REQUESTS = {
  total: 0, open: 0, open_sla_breached: 0, confirmed: 0, granted: 0, declined: 0,
  declined_recurred: 0, one_time_confirm_recurred: 0, reopened_total: 0, high_risk: 0,
  above_ceiling: 0, expired_recurrence: 0, models: []
};
const ZERO_ACCEPTS = { count: 0, avg_amount: 0, models: [] };

const scopeClause = (clientId, baseParams) => {
  // Optional client narrowing. The grants/requests/matches tables are all
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
          count(*) filter (where g.status = 'active')::int as active,
          count(*) filter (where g.status = 'revoked')::int as revoked,
          count(*) filter (where g.status = 'suspended')::int as suspended,
          -- "used" = the grant authorised at least one acceptance, read from the
          -- persisted accept receipts (the same source the grants view reads,
          -- listAuthorityGrantsForClient). The use_count column is not maintained.
          count(*) filter (where exists (
            select 1 from reconciliation_matches m
             where m.firm_id = g.firm_id and m.client_id = g.client_id
               and m.payload->'authorization'->'delegated_authority'->>'grant_id' = g.id
          ))::int as used,
          count(*) filter (where g.correction_count > 0)::int as corrected,
          count(*) filter (where g.archetype <> all($${params.length + 1}::text[]))::int as high_risk,
          coalesce(array_agg(distinct g.model) filter (where g.model is not null), '{}') as models
         from reconciliation_authority_grants g
        where g.firm_id = $1${where ? ' and g.client_id = $2' : ''}`,
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

const queryRequests = async (client, firmId, clientId) => {
  const { where, params } = scopeClause(clientId, [firmId]);
  const aIdx = params.length + 1; // the V1-archetype array param position
  try {
    const res = await client.query(
      `select
          count(*)::int as total,
          count(*) filter (where status = 'open')::int as open,
          count(*) filter (where status = 'open' and sla_due_at is not null and sla_due_at <= now())::int as open_sla_breached,
          count(*) filter (where status = 'confirmed')::int as confirmed,
          count(*) filter (where status = 'granted')::int as granted,
          count(*) filter (where status = 'declined')::int as declined,
          -- §14 queue health: a deliberate "no" / one-time confirm that the same
          -- pattern blew past anyway (the request re-opened after its cooldown).
          count(*) filter (where status = 'declined' and reopened_count > 0)::int as declined_recurred,
          count(*) filter (where status = 'confirmed' and reopened_count > 0)::int as one_time_confirm_recurred,
          -- duplicate asks the producer coalesced onto an existing row instead of
          -- spawning a new one (the §13 idempotency key doing its job).
          coalesce(sum(reopened_count), 0)::int as reopened_total,
          count(*) filter (where archetype is not null and archetype <> all($${aIdx}::text[]))::int as high_risk,
          -- an OPEN ask whose amount sits above the ceiling of an otherwise
          -- covering active grant (amount drift, §4 path 2).
          count(*) filter (
            where status = 'open' and exists (
              select 1 from reconciliation_authority_grants g
               where g.firm_id = reconciliation_authorization_requests.firm_id
                 and g.client_id = reconciliation_authorization_requests.client_id
                 and g.archetype = reconciliation_authorization_requests.archetype
                 and g.scope_key = reconciliation_authorization_requests.scope_key
                 and g.status = 'active'
                 and reconciliation_authorization_requests.match_amount > g.amount_ceiling)
          )::int as above_ceiling,
          -- an OPEN ask whose pattern HAD a grant that has since expired / been
          -- suspended / passed review (the §4 path-3 recurrence).
          count(*) filter (
            where status = 'open' and exists (
              select 1 from reconciliation_authority_grants g
               where g.firm_id = reconciliation_authorization_requests.firm_id
                 and g.client_id = reconciliation_authorization_requests.client_id
                 and g.archetype = reconciliation_authorization_requests.archetype
                 and g.scope_key = reconciliation_authorization_requests.scope_key
                 and (g.status in ('suspended', 'revoked')
                      or (g.expires_at is not null and g.expires_at <= now())
                      or (g.review_after is not null and g.review_after <= now())))
          )::int as expired_recurrence,
          coalesce(array_agg(distinct model) filter (where model is not null), '{}') as models
         from reconciliation_authorization_requests
        where firm_id = $1${where}`,
      [...params, V1_ARCHETYPES]
    );
    const row = res.rows[0] || {};
    return {
      total: num(row.total), open: num(row.open), open_sla_breached: num(row.open_sla_breached),
      confirmed: num(row.confirmed), granted: num(row.granted), declined: num(row.declined),
      declined_recurred: num(row.declined_recurred),
      one_time_confirm_recurred: num(row.one_time_confirm_recurred),
      reopened_total: num(row.reopened_total), high_risk: num(row.high_risk),
      above_ceiling: num(row.above_ceiling), expired_recurrence: num(row.expired_recurrence),
      models: toModels(row.models)
    };
  } catch (error) {
    if (isMissingTable(error)) return { ...ZERO_REQUESTS };
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
  const [grants, requests, accepts] = await Promise.all([
    queryGrants(client, firmId, clientId),
    queryRequests(client, firmId, clientId),
    queryDelegatedAccepts(client, firmId, clientId)
  ]);

  // Resolved asks = those an authority acted on (confirm / grant / decline).
  const resolvedRequests = requests.confirmed + requests.granted + requests.declined;

  return {
    firm_id: firmId,
    client_id: clientId,
    // ── Effectiveness ──────────────────────────────────────────────────────
    grant_count: grants.total,
    grant_active_count: grants.active,
    grant_creation_count: grants.total, // every grant row is a mint (§8)
    grant_revocation_rate: rate(grants.revoked, grants.total),
    grant_rejection_rate: rate(requests.declined, resolvedRequests),
    // hit rate = auto-accepted by a standing grant ÷ (auto-accepted + every held
    // line that still had to open an ask because no grant covered it).
    grant_hit_rate: rate(accepts.count, accepts.count + requests.total),
    // a corrected grant auto-suspends (Slice-5 producer); the rate is over grants
    // that were actually used, so an untouched grant never dilutes it.
    post_grant_correction_rate: rate(grants.corrected, grants.used),
    avg_amount_auto_matched_by_grant: accepts.avg_amount,
    delegated_accept_count: accepts.count,
    // ── High-risk archetype guards (expected ZERO in V1) ───────────────────
    high_risk_archetype_grant_count: grants.high_risk,
    high_risk_archetype_request_count: requests.high_risk,
    // No persisted column for "new account involved" — it is guarded fail-closed
    // upstream (findActiveAuthorityGrant `firstUseAccountInvolved`), so a grant
    // can never carry it; surfaced as a constant 0 for the §14 completeness.
    new_account_grant_count: 0,
    // ── Queue health (does the bounded transition self-extinguish?) ─────────
    awaiting_authorization_open_count: requests.open,
    awaiting_authorization_sla_breach_count: requests.open_sla_breached,
    grant_declined_but_pattern_recurred_count: requests.declined_recurred,
    one_time_confirm_recurrence_count: requests.one_time_confirm_recurred,
    expired_grant_recurrence_count: requests.expired_recurrence,
    amount_above_grant_ceiling_count: requests.above_ceiling,
    duplicate_authorization_asks_suppressed: requests.reopened_total,
    // ── Provenance: the model id is the receipt ────────────────────────────
    models: {
      grants: grants.models,
      requests: requests.models,
      delegated_accepts: accepts.models
    }
  };
};
