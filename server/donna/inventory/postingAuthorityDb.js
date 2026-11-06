// Donna Inventory I4·posting — P7 §13 delegated-authority ceilings (the READ-ONLY reader).
//
// The pure fail-closed decision lives in postingAuthority.js; this module is its read-side shell:
// it loads the active migration-083 grants for a client and computes how much has ALREADY been
// posted UNDER EACH GRANT within the day / period window (the aggregate the §13 ceilings bound),
// then runs the pure check. It is strictly READ-ONLY — no INSERT/UPDATE/DELETE, no ledger write,
// no posting. Wiring the resulting verdict into the executor post-path is a later isolation-class
// slice (like P6b's consumption primitive, the authority ships ready and the trigger wires later).
//
// The aggregate is keyed on inventory_posting_attempts.authority_grant_id and sums the debit side
// of each linked, balanced ledger journal over POSTED attempts — the amount actually authorized to
// the ledger under that grant. Reversals post their own attempts, so a reversed pair is counted
// GROSS; that
// over-counts grant usage, which is the fail-safe direction (more likely to escalate, never to
// silently over-authorize).

import { checkInventoryPostingAuthority } from './postingAuthority.js';

const isMissingRelation = (error) => error?.code === '42P01' || error?.code === '42703';

// Active grants for the client, most-recently-updated first (the covering-grant search order,
// mirror 040's findActiveAuthorityGrant). READ-ONLY.
export const loadActiveInventoryPostingGrants = async (client, firmId, clientId) => {
  const res = await client.query(
    `select * from inventory_posting_authority_grants
      where firm_id = $1 and client_id = $2 and status = 'active'
      order by updated_at desc`,
    [firmId, clientId]
  );
  return res.rows || [];
};

// Posted-amount aggregates per authority_grant_id, for the day (journalDate) and the period
// (periodStart..periodEnd inclusive). Two grouped SELECTs; returns { daily, period } as
// Map<grantId, number>. A grant with no posts yet is simply absent (→ 0 in the check). READ-ONLY.
export const readPostedAggregatesByGrant = async (client, firmId, clientId, { journalDate = null, periodStart = null, periodEnd = null } = {}) => {
  const daily = new Map();
  const period = new Map();
  const sumBy = async (dateClause, params) => {
    const res = await client.query(
      `select a.authority_grant_id as grant_id, coalesce(sum(journal_totals.amount), 0) as total
         from inventory_posting_attempts a
         join inventory_posting_journals j on j.posting_attempt_id = a.id
         join ledger_journals lj on lj.id = j.ledger_journal_id
         join lateral (
           select coalesce(sum(ll.debit), 0) as amount
             from ledger_lines ll
            where ll.journal_id = lj.id
         ) journal_totals on true
        where a.firm_id = $1 and a.client_id = $2
          and a.outcome = 'posted'
          and a.authority_grant_id is not null
          and ${dateClause}
        group by a.authority_grant_id`,
      params
    );
    return res.rows || [];
  };
  if (journalDate != null) {
    for (const r of await sumBy('lj.journal_date = $3', [firmId, clientId, journalDate])) daily.set(String(r.grant_id), Number(r.total));
  }
  if (periodStart != null && periodEnd != null) {
    for (const r of await sumBy('lj.journal_date >= $3 and lj.journal_date <= $4', [firmId, clientId, periodStart, periodEnd])) period.set(String(r.grant_id), Number(r.total));
  }
  return { daily, period };
};

// gatherInventoryPostingAuthorityState — load the active grants + the per-grant posted aggregates
// for the proposal's windows. Degrades to an empty read pre-migration (083 absent) rather than
// throwing into the caller — no grant then, so the proposal escalates (fail-closed). READ-ONLY.
export const gatherInventoryPostingAuthorityState = async ({
  client, firmId, clientId, journalDate = null, periodStart = null, periodEnd = null
} = {}) => {
  if (!client || !firmId || !clientId) throw new Error('gatherInventoryPostingAuthorityState requires client, firmId, clientId');
  let grants = [];
  let aggregates = { daily: new Map(), period: new Map() };
  try {
    grants = await loadActiveInventoryPostingGrants(client, firmId, clientId);
    aggregates = await readPostedAggregatesByGrant(client, firmId, clientId, { journalDate, periodStart, periodEnd });
  } catch (error) {
    if (!isMissingRelation(error)) throw error; // pre-083: no grants → escalate (fail-closed)
  }
  return { grants, aggregates };
};

// authorizeInventoryPosting — the read-side authorization entry point. Gathers the active grants +
// their aggregates, then runs the PURE check against each grant (most-recent first) until one
// AUTHORIZES; returns that verdict (with the covering grant). If none authorizes, returns the
// verdict from the FIRST grant tried (the most specific breach) or a bare `no_grant` when there is
// no active grant at all — always fail-closed, never a silent authorize. READ-ONLY: it returns a
// verdict; nothing posts. `asOf` is injected (the caller owns the clock).
export const authorizeInventoryPosting = async ({
  client, firmId, clientId, proposed = {}, journalDate = null, periodStart = null, periodEnd = null, asOf = null
} = {}) => {
  const { grants, aggregates } = await gatherInventoryPostingAuthorityState({
    client, firmId, clientId, journalDate, periodStart, periodEnd
  });
  if (!grants.length) return { authorized: false, reason: 'no_grant', detail: {}, grant: null };

  let firstVerdict = null;
  for (const grant of grants) {
    const verdict = checkInventoryPostingAuthority({
      grant, proposed, asOf,
      aggregates: {
        dailyPosted: aggregates.daily.get(String(grant.id)) ?? 0,
        periodPosted: aggregates.period.get(String(grant.id)) ?? 0
      }
    });
    if (verdict.authorized) return { ...verdict, grant };
    if (firstVerdict == null) firstVerdict = { ...verdict, grant };
  }
  return firstVerdict;
};
