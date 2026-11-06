// The loud-death receipt for the authority plane (2026-08-06, Kari's call).
//
// Client deletion is a single FK cascade, and that cascade takes the AUTHORITY
// PLANE with it: client_capability_config stage rows and
// reconciliation_authority_grants both declare `references clients(id) on
// delete cascade`. Dying fail-closed is intended — a client reset must never
// silently RE-ARM authority. Dying SILENTLY is the bug: on 2026-08-06 a
// honeybee re-run disarmed LEDGER_AUTO_POST and RECONCILIATION_MATERIAL_AUTO_FYI
// with no trace, and the loss presented as two unrelated product bugs (material
// matches resting at `suggested`, accepted lines never posting).
//
// This module receipts what is about to die, INSIDE the client-delete
// transaction, BEFORE the cascade — one audit event carrying full row
// snapshots, so re-staging is a checklist instead of forensics. It is a
// receipt, not a restore: nothing here survives, revives, or re-seeds
// authority. audit_events.client_id is `on delete set null`, so the receipt
// outlives the cascade with the client id preserved in resource_id.

export const AUTHORITY_PLANE_PURGE_AUDIT_ACTION = 'client.authority_plane_purged';

// 42P01-proofing, same pattern as firmFacts.firmFactsTablePresent: this runs
// inside the delete transaction, so a pre-migration deploy must skip the
// receipt rather than abort the deletion. Closed table list — never interpolate
// caller input here.
const RECEIPTED_TABLES = Object.freeze([
  'client_capability_config', 'reconciliation_authority_grants',
  'action_authority_grants', 'client_assignments'
]);
const tablePresent = async (client, table) => {
  if (!RECEIPTED_TABLES.includes(table)) return false;
  const res = await client.query(`select to_regclass('public.${table}') as present`);
  return Boolean(res.rows[0]?.present);
};

// Column-presence probe for 117's client_assignments extension: the TABLE is
// day-one, the specialist columns are not, and a failed query inside the
// delete transaction would abort the deletion — so probe before reading (a
// caught error is not enough; it poisons the transaction).
const columnPresent = async (client, table, column) => {
  if (!RECEIPTED_TABLES.includes(table)) return false;
  const res = await client.query(
    `select 1 as present from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column]
  );
  return Boolean(res.rows[0]?.present);
};

// Read the authority-plane rows the cascade would take: LIVE flag stage rows
// (valid_to null — superseded history dies unreceipted, it was already
// superseded), ALL grants regardless of status (a suspended grant is a
// correction record; its death belongs on the receipt too — same for the
// generalized action_authority_grants store), and the bench's specialist role
// assignments (S2: a client reset un-hires the team — employment dies
// fail-closed WITH its envelope and grants, and this receipt is how it dies
// loudly).
export const snapshotAuthorityPlaneForClient = async ({ client, firmId, clientId } = {}) => {
  const snapshot = { flags: [], grants: [], action_grants: [], role_assignments: [] };
  if (!client || !firmId || !clientId) return snapshot;
  if (await tablePresent(client, 'client_capability_config')) {
    const res = await client.query(
      `select flag_key, stage, source, reason, set_by_actor_type, set_by_actor_id, valid_from
         from client_capability_config
        where firm_id = $1 and client_id = $2 and valid_to is null
        order by flag_key`,
      [firmId, clientId]
    );
    snapshot.flags = res.rows;
  }
  if (await tablePresent(client, 'reconciliation_authority_grants')) {
    const res = await client.query(
      `select id, scope_kind, scope_key, archetype, action, amount_ceiling, currency, status, source
         from reconciliation_authority_grants
        where firm_id = $1 and client_id = $2
        order by created_at`,
      [firmId, clientId]
    );
    snapshot.grants = res.rows;
  }
  if (await tablePresent(client, 'action_authority_grants')) {
    const res = await client.query(
      `select id, domain, action_type, scope_kind, scope_key, amount_ceiling, currency, status, source, provenance
         from action_authority_grants
        where firm_id = $1 and client_id = $2
        order by created_at`,
      [firmId, clientId]
    );
    snapshot.action_grants = res.rows;
  }
  if (await tablePresent(client, 'client_assignments')
    && await columnPresent(client, 'client_assignments', 'assignment_kind')) {
    const res = await client.query(
      `select id, role, principal_type, principal_id, ai_profile, status
         from client_assignments
        where firm_id = $1 and client_id = $2 and assignment_kind = 'specialist_role'
        order by role`,
      [firmId, clientId]
    );
    snapshot.role_assignments = res.rows;
  }
  return snapshot;
};

export const recordAuthorityPlaneWipeReceipt = async ({ client, firmId, clientId, logger = console } = {}) => {
  if (!client || !firmId || !clientId) {
    return { recorded: false, flags: 0, grants: 0, action_grants: 0, role_assignments: 0 };
  }
  const snapshot = await snapshotAuthorityPlaneForClient({ client, firmId, clientId });
  const counts = {
    flags: snapshot.flags.length,
    grants: snapshot.grants.length,
    action_grants: snapshot.action_grants.length,
    role_assignments: snapshot.role_assignments.length
  };
  if (!counts.flags && !counts.grants && !counts.action_grants && !counts.role_assignments) {
    return { recorded: false, ...counts };
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'client', $2, $4::jsonb)`,
    [firmId, clientId, AUTHORITY_PLANE_PURGE_AUDIT_ACTION, JSON.stringify({
      note: 'Authority-plane rows died with the client (FK cascade). Fail-closed by design; re-stage deliberately — this receipt is the checklist.',
      ...snapshot
    })]
  );
  // The console line leads with what an operator actually staged: seed rows
  // (source 'default') re-appear on the next create/boot seed, but a manual
  // canary does NOT — those are the rows whose silent loss cost a debugging
  // session.
  const staged = snapshot.flags.filter((f) => f.source !== 'default');
  const stagedLine = staged.length
    ? staged.map((f) => `${f.flag_key}(${f.stage})`).join(', ')
    : 'baseline seeds only';
  const benchLine = counts.role_assignments
    ? `, ${counts.role_assignments} role assignments (bench un-hired: ${snapshot.role_assignments.map((r) => r.role).join(', ')})`
    : '';
  logger.log?.(
    `[client-delete] authority plane died with client ${clientId}: ${counts.flags} flag rows (staged: ${stagedLine}), ${counts.grants + counts.action_grants} grants${benchLine} — re-stage deliberately (receipt: ${AUTHORITY_PLANE_PURGE_AUDIT_ACTION})`
  );
  return { recorded: true, ...counts };
};
