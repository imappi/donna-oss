// Delegated authority for ledger auto-export — the grant store (INT-6,
// docs/donna-ledger-integrations-finish-plan.md §2; Kari decision #2,
// 2026-07-06). The 040 pattern (reconciliationAuthorityGrants.js) applied to
// sync: a grant is a SCOPED, standing, AUTHORITY-minted record that lets the
// drain executor (inngest/ledgerAutoExport.js) export ALREADY-POSTED Donna
// ledger journals to the client's connected accounting system unattended, with
// a full receipt per export (actor = the grant id, actor_type =
// 'authority_grant').
//
// This module is the AUTHORITY layer only. It decides WHETHER the executor may
// export; it NEVER decides WHAT gets posted — posting, coding, and corrections
// stay human/authorized upstream (the loopExecutionPolicy doctrine carve is
// export_posted_journal ONLY). Every check fails CLOSED: a doubt means no
// unattended export; the entry stays on the operator card's pending-export
// count (INT-4d) — visible, never silently dropped.
//
// Mirrors the 040 store conventions: deterministic id, upsert + audit on
// genuine insert, pre-migration soft-fail (42P01/42703), auto-suspend on
// correction with the enforcement side in the row guard (correction_count > 0
// fails closed). A grant dies with its client via the client_id FK cascade
// (migration 054). It does not import firmDb (no cycle): every entry point
// takes a live pg `client` handed in by the caller.

import crypto from 'node:crypto';

export const LEDGER_SYNC_GRANT_SYSTEMS = ['xero', 'qbo'];
export const LEDGER_SYNC_GRANT_ACTIONS = ['export_posted_journal'];
export const LEDGER_SYNC_GRANT_STATUSES = ['proposed', 'active', 'suspended', 'revoked'];
export const LEDGER_SYNC_GRANT_SOURCES = ['operator_one_click', 'accountant_approval'];

// The rollout flag for the drain executor — born on the config control plane
// (clientFlagActs/clientFlagObserves, envFallback () => false; never an env
// pair). Stages: off → shadow (log what would export) → canary (Honeybee) →
// auto. Kill via CLIENT_CONFIG_FORCE_DISABLE.
export const LEDGER_AUTO_EXPORT_FLAG_KEY = 'LEDGER_AUTO_EXPORT';

// Runtime mint requires a firm-side AUTHORITY actor. `system` is deliberately
// EXCLUDED so the system can never grant ITSELF standing export authority —
// the 040 guard 5.1. `system` may mint only on the audited migration path,
// with an originating human authority recorded in provenance.
export const RUNTIME_MINT_ACTOR_TYPES = ['firm_operator', 'accountant', 'admin'];

const toEpoch = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const normalizeCurrency = (value) => String(value || '').trim().toUpperCase();

const normalizeSystem = (value) => String(value || '').trim().toLowerCase();

// Deterministic id: the same grant (firm + client + system + action) upserts
// into the same row — ONE standing grant per connected system per client, so
// suspend/revoke governance always has a single row to act on.
export const buildLedgerSyncGrantId = ({ firmId, clientId, accountingSystem, action } = {}) => {
  const hash = crypto
    .createHash('sha256')
    .update([firmId, clientId, normalizeSystem(accountingSystem), action].join('|'))
    .digest('hex')
    .slice(0, 16);
  const slug = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'unknown';
  return ['sync-grant', slug(clientId), normalizeSystem(accountingSystem) || 'unknown', hash].join('-');
};

// Pure guard, amount-INDEPENDENT: is THIS grant row live for THIS system right
// now? Every clause fails closed. The per-journal materiality check is
// grantCoversAmount below — split so the executor can hold one live grant and
// filter candidates by ceiling without re-running the window checks per item.
export const ledgerSyncGrantIsLive = (
  grant,
  { accountingSystem, action = 'export_posted_journal', asOf = new Date() } = {}
) => {
  if (!grant || typeof grant !== 'object') return false;
  if (action !== 'export_posted_journal') return false;
  if (grant.action !== 'export_posted_journal') return false;
  if (normalizeSystem(grant.accounting_system) !== normalizeSystem(accountingSystem)) return false;
  // Only an ACTIVE grant executes — proposed / suspended / revoked never do.
  if (grant.status !== 'active') return false;
  // A grant whose export was later corrected/reversed is unusable until
  // re-reviewed (the enforcement side of auto-suspend-on-correction).
  if (Number(grant.correction_count) > 0) return false;
  // TIME-BOUNDED is a hard property of a sync grant (plan §2 INT-6): a row
  // with neither expires_at nor review_after is unbounded and fails closed,
  // even if a migration/manual insert produced one.
  const expiresAt = toEpoch(grant.expires_at);
  const reviewAfter = toEpoch(grant.review_after);
  if (expiresAt == null && reviewAfter == null) return false;
  const now = toEpoch(asOf);
  if (now == null) return false;
  const validFrom = toEpoch(grant.valid_from);
  if (validFrom != null && validFrom > now) return false;
  if (expiresAt != null && expiresAt <= now) return false;
  if (reviewAfter != null && reviewAfter <= now) return false;
  return true;
};

// Pure guard, per-journal: does the grant's OPTIONAL materiality ceiling cover
// this amount? No ceiling ⇒ covered (the grant is unbounded by amount, bounded
// by time + scope). A ceiling with an unknown amount or a currency mismatch
// fails closed — that journal stays on the operator's pending-export surface.
export const ledgerSyncGrantCoversAmount = (grant, { amount = null, currency = null } = {}) => {
  if (!grant || typeof grant !== 'object') return false;
  const ceiling = grant.amount_ceiling == null ? null : Number(grant.amount_ceiling);
  if (ceiling == null) return true;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (value > ceiling) return false;
  if (normalizeCurrency(grant.currency) !== normalizeCurrency(currency)) return false;
  return true;
};

// The executor's lookup. Returns the live grant row for (firm, client, system)
// or null (→ nothing exports; the pending count stays on the operator card).
// Fails closed on every doubt; pre-migration soft-fail (42P01/42703 → null).
export const findActiveLedgerSyncGrant = async ({
  client,
  firmId,
  clientId,
  accountingSystem,
  action = 'export_posted_journal',
  asOf = new Date()
} = {}) => {
  if (!client || !firmId || !clientId) return null;
  if (!LEDGER_SYNC_GRANT_SYSTEMS.includes(normalizeSystem(accountingSystem))) return null;
  let result;
  try {
    result = await client.query(
      `select * from ledger_sync_authority_grants
        where firm_id = $1 and client_id = $2 and accounting_system = $3
        order by updated_at desc`,
      [firmId, clientId, normalizeSystem(accountingSystem)]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }
  for (const grant of result.rows || []) {
    if (ledgerSyncGrantIsLive(grant, { accountingSystem, action, asOf })) return grant;
  }
  return null;
};

// Mint (or idempotently upsert) a grant — the FOUNDER ACTION (plan §2 INT-6a),
// driven by scripts/mint_ledger_sync_authority_grant.js. Enforces the authority
// boundary, the mandatory time bound, and the ceiling/currency pairing before
// any write. Returns { id, inserted, status } or null when a guard rejects.
export const mintLedgerSyncGrant = async ({
  client,
  firmId,
  clientId,
  accountingSystem,
  action = 'export_posted_journal',
  amountCeiling = null,
  currency = null,
  authorizedByActorType,
  authorizedByActorId = null,
  source,
  provenance = {},
  status = 'active',
  validFrom = null,
  expiresAt = null,
  reviewAfter = null,
  policyVersion = null,
  model = null,
  // Audited migration/backfill path: the ONLY way `system` may appear as the
  // authorizing actor, and only with provenance.originating_authority set.
  isMigration = false
} = {}) => {
  if (!client || !firmId || !clientId) return null;
  const system = normalizeSystem(accountingSystem);
  if (!LEDGER_SYNC_GRANT_SYSTEMS.includes(system)) return null;
  if (!LEDGER_SYNC_GRANT_ACTIONS.includes(action)) return null;
  if (!LEDGER_SYNC_GRANT_SOURCES.includes(source)) return null;
  if (!LEDGER_SYNC_GRANT_STATUSES.includes(status)) return null;

  // Authority guard: runtime mint requires firm_operator/accountant/admin.
  const runtimeAuthority = RUNTIME_MINT_ACTOR_TYPES.includes(authorizedByActorType);
  const migrationSystem =
    isMigration &&
    authorizedByActorType === 'system' &&
    !!provenance &&
    !!provenance.originating_authority;
  if (!runtimeAuthority && !migrationSystem) return null;

  // TIME-BOUNDED is mandatory: refuse a mint with neither expires_at nor
  // review_after — no accidental perpetual export authority.
  if (!expiresAt && !reviewAfter) return null;

  // Ceiling is optional, but a set ceiling must be a real positive cap WITH a
  // currency to compare against; a bare number would fail closed at runtime
  // anyway (ledgerSyncGrantCoversAmount), so refuse the confusing mint here.
  let ceiling = null;
  if (amountCeiling != null) {
    ceiling = Number(amountCeiling);
    if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
    if (!normalizeCurrency(currency)) return null;
  }

  const id = buildLedgerSyncGrantId({ firmId, clientId, accountingSystem: system, action });

  let result;
  try {
    result = await client.query(
      `insert into ledger_sync_authority_grants (
         id, firm_id, client_id, accounting_system, action,
         amount_ceiling, currency, authorized_by_actor_type, authorized_by_actor_id,
         source, provenance, status, valid_from, expires_at, review_after,
         policy_version, model
       ) values (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11::jsonb, $12, coalesce($13, now()), $14, $15,
         $16, $17
       )
       on conflict (id) do update set
         amount_ceiling = excluded.amount_ceiling,
         currency = excluded.currency,
         authorized_by_actor_type = excluded.authorized_by_actor_type,
         authorized_by_actor_id = excluded.authorized_by_actor_id,
         source = excluded.source,
         provenance = ledger_sync_authority_grants.provenance || excluded.provenance,
         status = excluded.status,
         expires_at = excluded.expires_at,
         review_after = excluded.review_after,
         policy_version = excluded.policy_version,
         model = excluded.model,
         updated_at = now()
       returning id, (xmax = 0) as inserted, status`,
      [
        id,
        firmId,
        clientId,
        system,
        action,
        ceiling,
        currency ? normalizeCurrency(currency) : null,
        authorizedByActorType,
        authorizedByActorId,
        source,
        JSON.stringify(provenance || {}),
        status,
        validFrom,
        expiresAt,
        reviewAfter,
        policyVersion,
        model
      ]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }

  const inserted = Boolean(result.rows[0]?.inserted);
  if (inserted) {
    // Audit only on a genuine insert (idempotent re-mint doesn't spam the
    // trail), same discipline as 040. The minting authority is the actor.
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, 'ledger_sync_authority_grant.minted', 'ledger_sync_authority_grant', $5, $6::jsonb)`,
      [
        firmId,
        clientId,
        authorizedByActorType,
        authorizedByActorId,
        id,
        JSON.stringify({
          accounting_system: system,
          action,
          amount_ceiling: ceiling,
          currency: currency ? normalizeCurrency(currency) : null,
          source,
          status,
          expires_at: expiresAt,
          review_after: reviewAfter,
          model
        })
      ]
    );
  }
  return { id, inserted, status: result.rows[0]?.status || status };
};

// The PRODUCER side of auto-suspend-on-correction (plan §2 INT-6a: "auto-
// suspended on any export correction/reversal", the 040 Slice-5 semantics).
// Called post-commit + no-throw from the ledger correction writer
// (postLedgerAdjustmentInDb) when the corrected journal had been EXPORTED:
// suspend EVERY non-revoked grant for the (firm, client) so the next
// findActiveLedgerSyncGrant fails closed — a human just told us an export was
// wrong, so unattended exporting stops until an authority re-reviews. A
// REVOKED grant stays revoked (a stronger "no") but still has its
// correction_count bumped for the metric. The enforcement side lives in
// ledgerSyncGrantIsLive (`correction_count > 0` fails closed).
export const suspendLedgerSyncGrantsAfterExportCorrection = async ({
  client,
  firmId,
  clientId,
  journalId = null,
  reason = 'export_correction'
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  let result;
  try {
    result = await client.query(
      `update ledger_sync_authority_grants
          set correction_count = correction_count + 1,
              status = case when status = 'revoked' then 'revoked' else 'suspended' end,
              updated_at = now()
        where firm_id = $1 and client_id = $2
        returning id, status, correction_count`,
      [firmId, clientId]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return [];
    throw error;
  }
  const rows = result.rows || [];
  for (const row of rows) {
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'ledger_sync_authority_grant.auto_suspended', 'ledger_sync_authority_grant', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          row.id,
          JSON.stringify({
            reason,
            journal_id: journalId,
            correction_count: Number(row.correction_count),
            status: row.status
          })
        ]
      );
    } catch (auditError) {
      // The suspend is the load-bearing write; a failed audit must not mask it.
      if (auditError?.code !== '42P01' && auditError?.code !== '42703') {
        console.warn('[ledgerSyncAuthorityGrants] auto-suspend audit failed', auditError?.message || auditError);
      }
    }
  }
  return rows.map((row) => ({ id: row.id, status: row.status, correction_count: Number(row.correction_count) }));
};

// The RECEIPT writer (plan §2 INT-6c): one audit row per attempted export,
// actor = the GRANT (actor_type 'authority_grant', actor_id = grant id) — the
// delegated authority IS the actor, reconstructable from the receipt alone.
// The export itself is deterministic (no LLM decides whether to push), so
// `model` is null by design; the coding model that shaped the journal rides
// the writer's own INT-3 receipt. Also bumps the grant's use_count once per
// batch. Best-effort by contract: a receipt failure is logged, never thrown —
// but it is COUNTED by the caller, so a receiptless export is visible in the
// sweep summary, not silent.
export const writeLedgerAutoExportReceipts = async ({
  client,
  firmId,
  clientId,
  grant,
  accountingSystem,
  flagStage = null,
  items = [],
  mirrorVerifyCounts = null
} = {}) => {
  if (!client || !firmId || !clientId || !grant?.id) return { receipts: 0 };
  let receipts = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const resourceType = item.journalId ? 'ledger_journal' : 'transaction';
    const resourceId = item.journalId || item.transactionId || null;
    if (!resourceId) continue;
    const action = item.status === 'synced'
      ? 'ledger_sync.auto_exported'
      : 'ledger_sync.auto_export_failed';
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'authority_grant', $3, $4, $5, $6, $7::jsonb)`,
        [
          firmId,
          clientId,
          grant.id,
          action,
          resourceType,
          resourceId,
          JSON.stringify({
            accounting_system: normalizeSystem(accountingSystem),
            grant_id: grant.id,
            grant_amount_ceiling: grant.amount_ceiling == null ? null : Number(grant.amount_ceiling),
            flag_stage: flagStage,
            status: item.status || null,
            error: item.error || null,
            error_code: item.errorCode || null,
            amount: item.amount == null ? null : Number(item.amount),
            currency: item.currency || null,
            transaction_id: item.transactionId || null,
            journal_id: item.journalId || null,
            mirror_verify_counts: mirrorVerifyCounts,
            model: null
          })
        ]
      );
      receipts += 1;
    } catch (error) {
      if (error?.code !== '42P01' && error?.code !== '42703') {
        console.warn('[ledgerSyncAuthorityGrants] auto-export receipt failed', error?.message || error);
      }
    }
  }
  const used = items.filter((item) => item?.status === 'synced').length;
  if (used > 0) {
    try {
      await client.query(
        `update ledger_sync_authority_grants
            set use_count = use_count + $3, last_used_at = now(), updated_at = now()
          where firm_id = $1 and id = $2`,
        [firmId, grant.id, used]
      );
    } catch (error) {
      if (error?.code !== '42P01' && error?.code !== '42703') {
        console.warn('[ledgerSyncAuthorityGrants] use_count bump failed', error?.message || error);
      }
    }
  }
  return { receipts };
};
