// Donna Loops — the case spine manager (Phase 1, shadow-only).
//
// A Donna Loop is a bounded, event-driven bookkeeping case: it wakes on a
// domain event, reads persisted state, records WORKFLOW state, and sleeps. It
// does NOT keep thinking. This module is the Keep-layer substrate:
//   - openOrFindCase   — idempotent case creation (the DB unique index defeats
//                        worker races; a deterministic id is the second belt)
//   - appendCaseEvent  — append-only event log (no update/delete helpers)
//   - linkObject       — normalized case<->object links (idempotent)
//   - openBlocker / resolveBlocker — normalized blockers
//   - rebuildCaseStatus — the status PROJECTION (INV-7): an explicit terminal
//        verdict outranks anything else; otherwise the most-severe open blocker
//        decides the wait. Never a fresh inference (rail #1).
//   - getCaseDebugSnapshot / listShadowCasesForClient — read-only debug
//   - reopenCase        — goal-regression reopen (§13.10): workflow-only, no judge
//   - purgeLoopsShadowForDeletedClient — client-delete purge (rail #5)
//
// Phase 1: no LLM, no external calls, no accounting writes. Vocabulary is the
// canonical reconciled set in docs/donna-loops-phase-0-contract.md.

import crypto from 'node:crypto';

import { purgeMemoryCandidatesForDeletedClient } from './memoryCandidates.js';
import { purgeLoopGoalsForDeletedClient } from './loopGoalStore.js';
import { purgeCaseSuspensionsForDeletedClient } from './caseSuspension.js';

// 'sync' (migration 053, INT-4): external-sync failure/drift cases anchored on
// the transaction/journal whose export broke — a dedicated type so the
// deterministic id never collides with (and never hides behind) a terminal
// reconciliation case on the same object.
export const LOOP_CASE_TYPES = ['evidence', 'coding', 'reconciliation', 'upload', 'sync'];

export const LOOP_CASE_STATUSES = [
  'open', 'waiting_client', 'waiting_firm', 'waiting_accountant', 'waiting_policy',
  'waiting_system', 'blocked', 'resolved', 'superseded', 'unsupported',
  'engineering_escalated', 'abandoned'
];

// Terminal states: a case at one of these is done (resolved/superseded/
// unsupported) or stopped by a human's explicit word (abandoned).
export const LOOP_TERMINAL_STATUSES = ['resolved', 'superseded', 'unsupported', 'abandoned'];

export const LOOP_OWNER_TYPES = ['client', 'firm', 'accountant', 'system', 'engineer', 'external_connector'];

export const LOOP_BLOCKER_TYPES = [
  'missing_client_answer', 'missing_document', 'missing_bank_statement',
  'parse_pending', 'parse_failed', 'parse_stale', 'unclear_category',
  'unclear_match', 'conflicting_memory', 'accountant_judgment_required',
  'firm_approval_required', 'external_sync_pending', 'external_sync_failed',
  'unsupported_connector_capability', 'engineering_investigation_required'
];

export const LOOP_BLOCKER_STATUSES = ['open', 'resolved', 'superseded', 'cancelled'];

export const LOOP_LINK_ROLES = [
  'primary', 'evidence', 'candidate_match', 'blocking_transaction',
  'blocking_document', 'client_reply', 'proposal', 'receipt',
  'memory_candidate', 'external_sync', 'monthly_close', 'related_case'
];

// A system/external-owned hard failure parks the case in 'blocked'; softer
// system waits (pending / stale / sync-pending) are 'waiting_system'.
const HARD_FAIL_BLOCKERS = new Set([
  'parse_failed', 'external_sync_failed', 'unsupported_connector_capability'
]);

// Severity order so the most-pressing open blocker decides the case's wait.
const STATUS_SEVERITY = {
  blocked: 6,
  engineering_escalated: 5,
  waiting_accountant: 4,
  waiting_client: 3,
  waiting_firm: 2,
  waiting_system: 1,
  open: 0
};

const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

const slug = (value) => String(value || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

// Deterministic id for a primary-object-anchored case, so a duplicate trigger
// upserts the same row (belt-and-braces with the DB unique partial index).
// Cases with no primary object get a random id.
export const buildCaseId = ({ firmId, clientId, caseType, primaryObjectType, primaryObjectId } = {}) => {
  if (!primaryObjectType || !primaryObjectId) return null;
  const hash = crypto.createHash('sha256')
    .update([firmId, clientId, caseType, primaryObjectType, primaryObjectId].join('|'))
    .digest('hex').slice(0, 16);
  return ['case', slug(caseType), hash].join('-');
};

// to_regclass returns null (never throws) for a missing relation, so callers
// can presence-check before writing inside a transaction (e.g. the
// client-delete purge) without risking a 42P01 abort on a pre-migration deploy.
export const loopsTablesPresent = async (client) => {
  if (!client) return false;
  const present = await client.query("select to_regclass('public.bookkeeping_cases') as present");
  return Boolean(present.rows[0]?.present);
};

// The Phase 2 proposal tables ship in a SEPARATE migration (034) from the spine
// (033), so probe them independently — a 033-but-not-034 deploy must still purge
// the spine without a 42P01 on the proposal deletes.
export const proposalLoopsTablesPresent = async (client) => {
  if (!client) return false;
  const present = await client.query("select to_regclass('public.proposal_cards') as present");
  return Boolean(present.rows[0]?.present);
};

const statusForBlocker = ({ ownerType, blockerType }) => {
  if (ownerType === 'engineer') return 'engineering_escalated';
  if (ownerType === 'accountant') return 'waiting_accountant';
  if (ownerType === 'client') return 'waiting_client';
  if (ownerType === 'firm') return 'waiting_firm';
  // system / external_connector
  if (HARD_FAIL_BLOCKERS.has(blockerType)) return 'blocked';
  return 'waiting_system';
};

const writeCaseStatus = async ({ client, caseId, status }) => {
  await client.query(
    `update bookkeeping_cases
       set status = $2,
           terminal_state = case when $2 = any($3::text[]) then $2 else terminal_state end,
           closed_at = case when $2 = any($3::text[]) then coalesce(closed_at, now()) else closed_at end,
           last_activity_at = now(),
           updated_at = now()
     where id = $1`,
    [caseId, status, LOOP_TERMINAL_STATUSES]
  );
};

// Idempotent open-or-find. A primary-object-anchored case uses a deterministic
// id + ON CONFLICT DO NOTHING: a racing duplicate insert no-ops, then we fetch.
export const openOrFindCase = async ({
  client, firmId, clientId, caseType,
  primaryObject = null, title = null, summary = null, openedEventId = null
} = {}) => {
  if (!client || !firmId || !clientId || !LOOP_CASE_TYPES.includes(caseType)) return null;
  const primaryObjectType = primaryObject?.type ? String(primaryObject.type) : null;
  const primaryObjectId = primaryObject?.id ? String(primaryObject.id) : null;
  const id = buildCaseId({ firmId, clientId, caseType, primaryObjectType, primaryObjectId }) || newId('case');
  const inserted = await client.query(
    `insert into bookkeeping_cases
       (id, firm_id, client_id, case_type, status, title, summary,
        primary_object_type, primary_object_id, opened_event_id,
        last_activity_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, now(), now(), now())
     on conflict (id) do nothing
     returning *`,
    [id, firmId, clientId, caseType, title, summary, primaryObjectType, primaryObjectId, openedEventId]
  );
  if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
  const existing = await client.query(
    `select * from bookkeeping_cases where id = $1 limit 1`,
    [id]
  );
  return existing.rows[0] ? { ...existing.rows[0], created: false } : null;
};

// Append-only: insert an event, bump the case's activity clock. Never mutates
// or deletes prior events.
export const appendCaseEvent = async ({
  client, firmId, clientId, caseId, eventType, actorType = 'system', actorId = null,
  triggerEventId = null, objectType = null, objectId = null, snapshotId = null,
  proposalId = null, receiptId = null, payload = {}, modelName = null, promptVersion = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId || !eventType) return null;
  if (!LOOP_OWNER_TYPES.includes(actorType)) return null;
  const id = newId('case-event');
  const result = await client.query(
    `insert into bookkeeping_case_events
       (id, firm_id, client_id, case_id, event_type, actor_type, actor_id, trigger_event_id,
        object_type, object_id, snapshot_id, proposal_id, receipt_id, payload,
        model_name, prompt_version, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, now())
     returning id`,
    [id, firmId, clientId, caseId, eventType, actorType, actorId, triggerEventId,
     objectType, objectId, snapshotId, proposalId, receiptId, JSON.stringify(payload || {}), modelName, promptVersion]
  );
  await client.query(
    `update bookkeeping_cases set last_activity_at = now(), updated_at = now() where id = $1`,
    [caseId]
  );
  return result.rows[0]?.id ? { id: result.rows[0].id } : null;
};

// Idempotent link (unique on case_id, object_type, object_id, role).
export const linkObject = async ({
  client, firmId, clientId, caseId, objectType, objectId, role, objectVersion = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId || !objectType || !objectId) return null;
  if (!LOOP_LINK_ROLES.includes(role)) return null;
  const id = newId('case-link');
  const result = await client.query(
    `insert into bookkeeping_case_links
       (id, firm_id, client_id, case_id, object_type, object_id, role, object_version, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (case_id, object_type, object_id, role) do nothing
     returning id`,
    [id, firmId, clientId, caseId, objectType, objectId, role, objectVersion]
  );
  return { id: result.rows[0]?.id || null, created: Boolean(result.rows[0]?.id) };
};

// Open a blocker (no equivalent-open duplicate), append the resulting wait
// event, and refresh the case status to the most-severe open blocker.
export const openBlocker = async ({
  client, firmId, clientId, caseId, blockerType, ownerType,
  objectType = null, objectId = null, reason = null, dueAt = null, createdEventId = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId) return null;
  if (!LOOP_BLOCKER_TYPES.includes(blockerType) || !LOOP_OWNER_TYPES.includes(ownerType)) return null;
  const existing = await client.query(
    `select id from bookkeeping_case_blockers
      where case_id = $1 and blocker_type = $2 and owner_type = $3 and status = 'open'
        and coalesce(object_type, '') = coalesce($4, '')
        and coalesce(object_id, '') = coalesce($5, '')
      limit 1`,
    [caseId, blockerType, ownerType, objectType, objectId]
  );
  let blockerId = existing.rows[0]?.id || null;
  let created = false;
  if (!blockerId) {
    blockerId = newId('case-blocker');
    await client.query(
      `insert into bookkeeping_case_blockers
         (id, firm_id, client_id, case_id, blocker_type, owner_type, status,
          object_type, object_id, reason, due_at, created_event_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10::timestamptz, $11, now(), now())`,
      [blockerId, firmId, clientId, caseId, blockerType, ownerType, objectType, objectId, reason, dueAt, createdEventId]
    );
    created = true;
  }
  const status = await rebuildCaseStatus({ client, caseId });
  await appendCaseEvent({
    client, firmId, clientId, caseId,
    eventType: `case.${status}`,
    objectType, objectId,
    payload: { blocker_type: blockerType, owner_type: ownerType, blocker_id: blockerId, reason: reason || null }
  });
  await writeCaseStatus({ client, caseId, status });
  return { id: blockerId, created, status };
};

export const resolveBlocker = async ({
  client, blockerId, resolutionEventId = null, reason = null
} = {}) => {
  if (!client || !blockerId) return { resolved: false };
  const updated = await client.query(
    `update bookkeeping_case_blockers
       set status = 'resolved', resolved_at = now(), resolution_event_id = $2,
           reason = coalesce($3, reason), updated_at = now()
     where id = $1 and status = 'open'
     returning case_id, firm_id, client_id, blocker_type, owner_type`,
    [blockerId, resolutionEventId, reason]
  );
  const row = updated.rows[0];
  if (!row) return { resolved: false };
  await appendCaseEvent({
    client, firmId: row.firm_id, clientId: row.client_id, caseId: row.case_id,
    eventType: 'case.blocker_resolved',
    payload: { blocker_id: blockerId, blocker_type: row.blocker_type, owner_type: row.owner_type, reason: reason || null }
  });
  const status = await rebuildCaseStatus({ client, caseId: row.case_id });
  await appendCaseEvent({
    client, firmId: row.firm_id, clientId: row.client_id, caseId: row.case_id,
    eventType: `case.${status}`,
    payload: { via: 'blocker_resolved' }
  });
  await writeCaseStatus({ client, caseId: row.case_id, status });
  return { resolved: true, caseId: row.case_id, status };
};

// The status PROJECTION. Deterministic and read-only:
//   1. An explicit terminal verdict (latest case.resolved/superseded/
//      unsupported/abandoned, unless a later case.reopened) wins — a persisted
//      verdict outranks anything else (rail #1).
//   2. Otherwise the most-severe OPEN blocker decides the wait.
//   3. Otherwise 'open'. (Phase 1 has no proposals; waiting_policy is set by an
//      explicit event in later phases.)
export const rebuildCaseStatus = async ({ client, caseId } = {}) => {
  if (!client || !caseId) return null;
  const terminal = await client.query(
    `select event_type from bookkeeping_case_events
      where case_id = $1
        and event_type in ('case.resolved', 'case.superseded', 'case.unsupported', 'case.abandoned', 'case.reopened')
      order by created_at desc, id desc
      limit 1`,
    [caseId]
  );
  const latest = terminal.rows[0]?.event_type || null;
  if (latest && latest !== 'case.reopened') return latest.replace('case.', '');

  const blockers = await client.query(
    `select blocker_type, owner_type from bookkeeping_case_blockers
      where case_id = $1 and status = 'open'`,
    [caseId]
  );
  let best = null;
  let bestSeverity = -1;
  for (const b of blockers.rows) {
    const s = statusForBlocker({ ownerType: b.owner_type, blockerType: b.blocker_type });
    const sev = STATUS_SEVERITY[s] ?? 0;
    if (sev > bestSeverity) { bestSeverity = sev; best = s; }
  }
  return best || 'open';
};

// Reopen a (possibly terminal) case after a goal regression (design §13.10 —
// "met once" is not "met forever"). WORKFLOW-ONLY, Keep-layer: it appends the
// case.reopened receipt (which rebuildCaseStatus §1 lets OUTRANK the prior
// terminal verdict), re-projects + writes the status, and bumps case_version to
// invalidate any in-flight run (INV-16). It NEVER judges — the fresh evaluateGoal
// + the SUPERSEDING GoalReport are the engine's job on re-wake (the loopRunEngine
// boundary stays intact); the prior met report is left immutable (INV-17). The
// Step 7 dispatcher calls this, then enqueues the re-wake inbox event. Returns
// { caseId, status, caseVersion, reopenedEventId } or null.
export const reopenCase = async ({
  client, firmId, clientId, caseId,
  reason = null, supersededReportId = null, regressionKey = null,
  triggerEventId = null, nextCaseVersion = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId) return null;
  const reopened = await appendCaseEvent({
    client, firmId, clientId, caseId,
    eventType: 'case.reopened', triggerEventId,
    payload: { reason, superseded_report_id: supersededReportId, regression_key: regressionKey }
  });
  // case.reopened is the latest terminal-set event, so rebuildCaseStatus drops the
  // prior verdict and re-projects from open blockers (default 'open').
  const status = await rebuildCaseStatus({ client, caseId });
  await appendCaseEvent({
    client, firmId, clientId, caseId,
    eventType: `case.${status}`, payload: { via: 'goal_regression' }
  });
  await writeCaseStatus({ client, caseId, status });
  // Bump the single-flight version (INV-16): a run that leased the prior version can
  // no longer commit a competing verdict, so the regression can't race a stale wake.
  const bumped = await client.query(
    `update bookkeeping_cases set case_version = case_version + 1, updated_at = now()
      where id = $1 returning case_version`,
    [caseId]
  ).catch(() => ({ rows: [] }));
  return {
    caseId, status,
    caseVersion: bumped.rows[0]?.case_version ?? nextCaseVersion ?? null,
    reopenedEventId: reopened?.id || null
  };
};

// Terminalize a case with an explicit resolved verdict (workflow-only,
// Keep-layer — the dual of reopenCase). Appends the `case.resolved` event that
// rebuildCaseStatus §1 treats as the outranking terminal verdict, then writes
// the projected status. For cases with no registered goal (e.g. 'sync'), this
// is the honest two-terminal close: without it, a case whose last blocker
// resolved would rest at 'open' — on nobody, which is the violation. It never
// judges: callers invoke it only on a verified external fact (a successful
// re-export, a clean mirror verify).
export const markCaseResolved = async ({
  client, firmId, clientId, caseId, reason = null, triggerEventId = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId) return null;
  const resolved = await appendCaseEvent({
    client, firmId, clientId, caseId,
    eventType: 'case.resolved', triggerEventId,
    payload: { reason: reason || null }
  });
  if (!resolved?.id) return null;
  const status = await rebuildCaseStatus({ client, caseId });
  await writeCaseStatus({ client, caseId, status });
  return { caseId, status, resolvedEventId: resolved.id };
};

// ── Read-only debug helpers (NOT mounted in user UI) ────────────────────────

export const getCaseDebugSnapshot = async ({ client, caseId } = {}) => {
  if (!client || !caseId) return null;
  const caseRow = await client.query(`select * from bookkeeping_cases where id = $1 limit 1`, [caseId]);
  if (!caseRow.rows[0]) return null;
  const events = await client.query(
    `select id, event_type, actor_type, object_type, object_id, model_name, prompt_version, created_at
       from bookkeeping_case_events where case_id = $1 order by created_at asc, id asc`,
    [caseId]
  );
  const links = await client.query(
    `select object_type, object_id, role, object_version from bookkeeping_case_links where case_id = $1`,
    [caseId]
  );
  const blockers = await client.query(
    `select id, blocker_type, owner_type, status, object_type, object_id, reason
       from bookkeeping_case_blockers where case_id = $1`,
    [caseId]
  );
  const projectedStatus = await rebuildCaseStatus({ client, caseId });
  return {
    case: caseRow.rows[0],
    projected_status: projectedStatus,
    events: events.rows,
    links: links.rows,
    blockers: blockers.rows
  };
};

// ── Phase 4: the read-only close-blocker dashboard projection ────────────────
//
// Lists a client's OPEN close blockers — the non-terminal cases that still hold
// at least one open blocker, each carrying its open blockers. This is the first
// Loops read path that drives UI (Phase 1 deferred all reads); it is mounted on
// the live feed behind LOOPS_SHADOW + a presence guard at the endpoint.
//
// Rail #1 (render the persisted verdict): it reads the case's PERSISTED `status`
// column — the projection writeCaseStatus already wrote — never a fresh
// rebuildCaseStatus inference. The dashboard groups by that status (who we wait
// on); each blocker also carries its own owner_type + reason (the reason string
// carries the diagnose-don't-guess detail for parse/upload blockers, rail #3).
// Scoped to (firm, client); ordered by most-recent activity.
export const listCloseBlockersForClient = async ({
  client, firmId, clientId, limit = 200
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  const bounded = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const cases = await client.query(
    `select c.id, c.case_type, c.status, c.title, c.summary,
            c.primary_object_type, c.primary_object_id, c.due_at, c.last_activity_at
       from bookkeeping_cases c
      where c.firm_id = $1 and c.client_id = $2
        and not (c.status = any($3::text[]))
        and exists (
          select 1 from bookkeeping_case_blockers b
           where b.case_id = c.id and b.status = 'open')
      order by c.last_activity_at desc
      limit $4`,
    [firmId, clientId, LOOP_TERMINAL_STATUSES, bounded]
  );
  if (cases.rows.length === 0) return [];
  const caseIds = cases.rows.map((r) => r.id);
  const blockers = await client.query(
    `select id, case_id, blocker_type, owner_type, reason, object_type, object_id,
            due_at, created_at
       from bookkeeping_case_blockers
      where case_id = any($1::text[]) and status = 'open'
      order by created_at asc, id asc`,
    [caseIds]
  );
  const byCase = new Map();
  for (const b of blockers.rows) {
    if (!byCase.has(b.case_id)) byCase.set(b.case_id, []);
    byCase.get(b.case_id).push({
      id: b.id,
      blocker_type: b.blocker_type,
      owner_type: b.owner_type,
      reason: b.reason || null,
      object_type: b.object_type || null,
      object_id: b.object_id || null,
      due_at: b.due_at || null,
      created_at: b.created_at
    });
  }
  return cases.rows.map((c) => ({
    id: c.id,
    case_type: c.case_type,
    status: c.status,
    title: c.title || null,
    summary: c.summary || null,
    primary_object_type: c.primary_object_type || null,
    primary_object_id: c.primary_object_id || null,
    due_at: c.due_at || null,
    last_activity_at: c.last_activity_at,
    blockers: byCase.get(c.id) || []
  }));
};

export const listShadowCasesForClient = async ({
  client, firmId, clientId, status = null, caseType = null, limit = 100
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const conditions = ['firm_id = $1', 'client_id = $2'];
  const params = [firmId, clientId];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (caseType) { params.push(caseType); conditions.push(`case_type = $${params.length}`); }
  params.push(bounded);
  const result = await client.query(
    `select id, case_type, status, title, primary_object_type, primary_object_id, last_activity_at, created_at
       from bookkeeping_cases
      where ${conditions.join(' and ')}
      order by last_activity_at desc
      limit $${params.length}`,
    params
  );
  return result.rows;
};

// Client-delete purge (rail #5). client_id has no clients FK (the firm_facts
// pattern), so the delete cascade does not reach these rows — this explicit
// purge, run inside the client-delete transaction, is load-bearing. Children
// first, then cases, then the independent inbox/outbox; the Phase 2 proposal
// tables (034) are purged under their own presence probe so a 033-only deploy
// still clears the spine. Table-presence guarded so a pre-migration deploy can
// never block a client deletion.
export const purgeLoopsShadowForDeletedClient = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return { deleted: 0 };
  if (!(await loopsTablesPresent(client))) return { deleted: 0 };
  let deleted = 0;

  // Goal layer (037: loop_goal_reports / loop_runs / bookkeeping_case_dependencies)
  // FIRST — before the case_events/cases deletes below. Those goal tables FK back
  // to bookkeeping_cases / bookkeeping_case_events with ON DELETE CASCADE, but
  // loop_runs + loop_goal_reports are APPEND-ONLY: their guard trigger rejects a
  // DELETE — including a cascaded one — unless donna.allow_append_only_purge is
  // set. purgeLoopGoals sets that flag (set local, transaction-scoped, honoured
  // for the rest of this txn) and clears the rows explicitly, so nothing is left
  // to cascade into the guard when the case/event rows go. Its own 037 presence
  // probe means a pre-037 deploy is a clean no-op. Firm memory dies with its
  // client (rail #5), goal reports included.
  const goals = await purgeLoopGoalsForDeletedClient({ client, firmId, clientId });
  deleted += (goals.goal_reports || 0) + (goals.runs || 0) + (goals.dependencies || 0);

  // Case suspensions (038) — also FIRST, before the case/event deletes below. The
  // table FKs bookkeeping_cases / bookkeeping_case_events ON DELETE CASCADE and is
  // APPEND-ONLY (037's guard, reused), so a cascaded DELETE is rejected unless the
  // purge hatch is open — clear it explicitly here (purgeCaseSuspensions opens the
  // same set-local hatch) so nothing is left to cascade into the guard. Its own 038
  // presence probe means a pre-038 deploy is a clean no-op. Firm memory dies with
  // its client (rail #5), suspensions included.
  const suspensions = await purgeCaseSuspensionsForDeletedClient({ client, firmId, clientId });
  deleted += suspensions.suspensions || 0;

  const blockers = await client.query(
    `delete from bookkeeping_case_blockers where firm_id = $1 and client_id = $2`, [firmId, clientId]);
  const links = await client.query(
    `delete from bookkeeping_case_links where firm_id = $1 and client_id = $2`, [firmId, clientId]);
  const events = await client.query(
    `delete from bookkeeping_case_events where firm_id = $1 and client_id = $2`, [firmId, clientId]);
  const cases = await client.query(
    `delete from bookkeeping_cases where firm_id = $1 and client_id = $2`, [firmId, clientId]);
  const inbox = await client.query(
    `delete from loop_event_inbox where firm_id = $1 and client_id = $2`, [firmId, clientId]);
  const outbox = await client.query(
    `delete from loop_event_outbox where firm_id = $1 and client_id = $2`, [firmId, clientId]);
  for (const r of [blockers, links, events, cases, inbox, outbox]) deleted += r.rowCount || 0;

  // Phase 2 proposal tables (children before the card; all proposal_id-keyed
  // rows are FK-free plain columns, so the explicit delete is load-bearing).
  if (await proposalLoopsTablesPresent(client)) {
    const targets = await client.query(
      `delete from proposal_targets where firm_id = $1 and client_id = $2`, [firmId, clientId]);
    const reports = await client.query(
      `delete from check_reports where firm_id = $1 and client_id = $2`, [firmId, clientId]);
    const receipts = await client.query(
      `delete from apply_receipts where firm_id = $1 and client_id = $2`, [firmId, clientId]);
    const cards = await client.query(
      `delete from proposal_cards where firm_id = $1 and client_id = $2`, [firmId, clientId]);
    for (const r of [targets, reports, receipts, cards]) deleted += r.rowCount || 0;
  }

  // Phase 6 memory_candidates ship in their own migration (036), so purge them
  // under an independent presence probe — a 033/034/035-but-not-036 deploy must
  // still clear the spine without a 42P01 on the memory delete. Firm memory dies
  // with its client (rail #5), candidates included.
  const memcand = await purgeMemoryCandidatesForDeletedClient({ client, firmId, clientId });
  deleted += memcand.deleted || 0;
  return { deleted };
};
