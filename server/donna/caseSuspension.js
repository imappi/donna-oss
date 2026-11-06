// Donna Loops — the case-level suspension source (goal-first uplift, Step 6 done).
//
// Step 6 (#542) shipped the execution gate. decideLoopExecution already honours a
// CASE-level suspension (decideExecution.caseSuspension -> 'case_suspended'), but
// bookkeeping_cases had NO source for it, so loopInboxWorker.dispatchLoopWake passed
// null — a forward-compatible hook with nothing behind it. This is that source: the
// thin store BETWEEN the pure gate (loopExecutionPolicy — what a suspension MEANS)
// and migration 038 (bookkeeping_case_suspensions — where the actions live). It does
// nothing intelligent: it records a human authority's pause/resume/cancel and reads
// back the case's CURRENT effective suspension for the gate.
//
// VOCABULARY (pinned to migration 038's CHECK by migrations.test.js in lockstep):
// the three case-autonomy ACTIONS an authority may take —
//   pause   -> SUSPEND          a resumable kill switch (the wake stops until lifted)
//   resume  -> LIFT             clears the suspension (the wake resumes next trigger)
//   cancel  -> TERMINAL CLOSURE the case's autonomy is closed for good (irreversible)
// readActiveCaseSuspension reports the LATEST action's effect: pause/cancel -> an
// active suspension object the gate blocks on; resume / no rows -> null. The object
// is shaped for decideExecution.caseSuspension (any truthy object -> blocked) and
// carries `mode` (paused|cancelled) + `terminal` so the Step 7 dispatcher can tell a
// HOLD (retry on the next trigger) from a terminal DROP at dispatch-time re-gate.
//
// GOVERNANCE (design §13.6 / Phase 0 §3g): only an AUTHORITY may suspend/resume/
// cancel — reuses loopExecutionPolicy.isAuthority. An owner (e.g. a `client`) may
// supply evidence but can never govern a case's autonomy. APPEND-ONLY (INV-17): a
// resume/cancel never mutates a prior pause, it appends a superseding action.
//
// Patterned on loopGoalStore.js: an injected `client`, a to_regclass presence guard
// so a pre-038 deploy degrades to a clean no-op (never an aborting 42P01 inside the
// worker's per-event transaction), idempotent writes, and an explicit client-delete
// purge. It imports ONLY loopExecutionPolicy.js (a dependency-free leaf) so it stays
// cycle-free for the worker / caseManager to import without widening an import cycle.

import crypto from 'node:crypto';

import { isAuthority } from './loopExecutionPolicy.js';

// The pinned vocabulary — kept in lockstep with migration 038's action CHECK.
export const CASE_SUSPENSION_ACTIONS = ['pause', 'resume', 'cancel'];

// The effective MODE a non-resume action puts the case in (what the gate /
// dispatcher reads). pause is a resumable HOLD; cancel is a terminal DROP.
const ACTION_MODE = Object.freeze({ pause: 'paused', cancel: 'cancelled' });

const newId = () => `case-susp-${crypto.randomUUID()}`;

// to_regclass returns null (never throws) for a missing relation, so this is a
// transaction-safe presence check: a 037-but-not-038 deploy degrades to a no-op
// instead of aborting the surrounding (worker per-event) transaction with 42P01 —
// the exact reason loopGoalTablesPresent exists.
export const caseSuspensionTablePresent = async (client) => {
  if (!client) return false;
  const present = await client.query(
    "select to_regclass('public.bookkeeping_case_suspensions') as present"
  );
  return Boolean(present.rows[0]?.present);
};

// THE reader the gate consumes (loopInboxWorker.dispatchLoopWake today; the Step 7
// dispatcher's dispatch-time re-gate next). Reads the case's LATEST suspension
// action and reports the effective suspension for decideExecution.caseSuspension:
//   latest = pause  -> { scope:'case', mode:'paused',    terminal:false, ... }  (blocks; resumable)
//   latest = cancel -> { scope:'case', mode:'cancelled', terminal:true,  ... }  (blocks; terminal)
//   latest = resume | no rows -> null  (not suspended)
// A pre-038 deploy -> null (the presence guard), so the gate stays permissive
// exactly as before this slice (the worker passed null). No re-judging at read time
// (INV-13): this reads a persisted action, it never decides one.
export const readActiveCaseSuspension = async ({ client, firmId, clientId, caseId } = {}) => {
  if (!client || !firmId || !clientId || !caseId) return null;
  if (!(await caseSuspensionTablePresent(client))) return null;
  const res = await client.query(
    `select id, action, reason, authorized_by_actor_type, authorized_by_actor_id,
            authority_level, created_at
       from bookkeeping_case_suspensions
      where firm_id = $1 and client_id = $2 and case_id = $3
      order by created_at desc, id desc
      limit 1`,
    [firmId, clientId, caseId]
  );
  const row = res.rows[0];
  if (!row || row.action === 'resume') return null; // lifted (or never suspended)
  return {
    scope: 'case',
    mode: ACTION_MODE[row.action],       // 'paused' | 'cancelled'
    terminal: row.action === 'cancel',   // dispatcher: terminal DROP vs resumable HOLD
    reason: row.reason || row.action,
    authorizedByActorType: row.authorized_by_actor_type || null,
    authorizedByActorId: row.authorized_by_actor_id || null,
    authorityLevel: row.authority_level || null,
    suspensionId: row.id,
    raisedAt: row.created_at || null
  };
};

// Record one suspension lifecycle action (the WRITE half of the source table; the
// Step 8 pause/resume/cancel controls call this). Authority-checked (§13.6): throws
// unless an authority raised it. APPEND-ONLY — always an INSERT; a resume/cancel
// supersedes a prior pause by being the newer row, never an UPDATE. `cancel` is
// terminal: once a case is cancelled, further pause/resume actions are rejected (the
// closure is final). Returns { id, action } or null on a pre-038 deploy (a missing
// table never blocks the caller).
export const recordCaseSuspension = async ({
  client, firmId, clientId, caseId, action,
  actorType, actorId = null, authorityLevel = null, reason = null, eventId = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId) return null;
  if (!CASE_SUSPENSION_ACTIONS.includes(action)) {
    throw new Error(
      `recordCaseSuspension: unknown action "${action}" (expected ${CASE_SUSPENSION_ACTIONS.join('/')})`
    );
  }
  if (!isAuthority(actorType)) {
    throw new Error(
      `recordCaseSuspension: ${actorType || 'an owner'} may not ${action} a case — authority required (§13.6)`
    );
  }
  if (!(await caseSuspensionTablePresent(client))) return null; // pre-038: no-op

  // cancel is terminal — a cancelled case can never be re-paused or resumed.
  const active = await readActiveCaseSuspension({ client, firmId, clientId, caseId });
  if (active?.terminal) {
    throw new Error(
      `recordCaseSuspension: case ${caseId} is cancelled (terminal); no further ${action} permitted`
    );
  }

  const id = newId();
  await client.query(
    `insert into bookkeeping_case_suspensions
       (id, firm_id, client_id, case_id, action, reason,
        authorized_by_actor_type, authorized_by_actor_id, authority_level, event_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [id, firmId, clientId, caseId, action, reason, actorType, actorId, authorityLevel, eventId]
  );
  return { id, action };
};

// Client-delete purge (CLAUDE.md "firm memory dies with its client"). The plain
// client_id column means the clients-delete cascade misses these rows, so this
// explicit hard-delete — run INSIDE the client-delete transaction (folded into
// caseManager.purgeLoopsShadowForDeletedClient) — is load-bearing. The table is
// APPEND-ONLY: open the same session-local escape hatch the goal-layer purge uses
// (donna.allow_append_only_purge) so 038's guard trigger permits the one sanctioned
// DELETE. Presence-guarded so a pre-038 deploy never blocks a client deletion.
export const purgeCaseSuspensionsForDeletedClient = async ({ client, firmId, clientId } = {}) => {
  const summary = { suspensions: 0 };
  if (!client || !firmId || !clientId) return summary;
  if (!(await caseSuspensionTablePresent(client))) return summary;
  // Open the append-only escape hatch for THIS transaction only.
  await client.query("set local donna.allow_append_only_purge = 'on'");
  const res = await client.query(
    'delete from bookkeeping_case_suspensions where firm_id = $1 and client_id = $2',
    [firmId, clientId]
  );
  summary.suspensions = res.rowCount || 0;
  return summary;
};
