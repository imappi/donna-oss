// The D1 earned-auto ladder (execution plan §4 D1 — RESOLVED, Kari
// 2026-07-24: no internal review lane; decide-and-notify with an earned-auto
// ladder). Per action type × per client: count owner-approved sends that pass
// WITHOUT correction; at N clean the client's flag graduates to 'auto'
// THROUGH THE EXISTING AUDITED STAGE WRITER (clientConfig.setClientFlagStage)
// and the owner digest flips from "approve these" to "sent these — reply if
// wrong" (ownerDigest.js renders the flip; the notify is a courtesy FYI,
// never a click queue).
//
// AUTO_FORBIDDEN interlock (the two-terminal home): the config plane still
// refuses 'auto' for every OUTBOUND_* flag until Kari approves each terminal
// individually (a deliberate PR removing the flag from AUTO_FORBIDDEN_FLAGS).
// A ladder that reaches its target while the terminal is vetoed rests at
// state='earned' — recorded (100 row + audit event), digest-visible (the
// owner digest FYI line + the §3 metrics detail), ON KARI. It graduates
// automatically on a later sweep only once the veto is lifted. The ladder
// NEVER calls the writer for a forbidden flag — the writer's own refusal
// (assertStageAllowedForFlag) stays the enforcing backstop.
//
// THE COUNTED SET (explicit — the PR must not shade it):
//   Clean send — an executed action whose send receipt cites authority
//   'per_send_owner_approval': the owner approved the exact draft and it went
//   out unchanged. Auto-lane and grant-carried sends do NOT count (the ladder
//   counts owner approvals only, per D1).
//   Corrections (each resets clean_streak to 0; post-graduation each also
//   suspends a LADDER-MINTED 'auto' row back to 'canary' — the 040/095
//   auto-suspend-on-correction pattern; a manually-staged 'auto' is Kari's
//   deliberate terminal call and is never touched):
//     - 'declined_held_draft'  — owner declined a held draft (wired: the
//       cancel writer records it when a non-system principal cancels a
//       hold_for_approval row);
//     - 'cancelled_pre_send'   — owner cancelled a scheduled/approved action
//       before it went out (wired: same writer, non-held statuses);
//     - 'edited_held_draft'    — owner edited a held draft before approving
//       (wired: editHeldOutboundActionDraft records it inside the writer —
//       G15/D12's edit verb; no surface can skip it);
//     - 'reply_if_wrong'       — owner said a notified (auto-sent) send was
//       wrong (wired: markExecutedOutboundActionWrong records it inside the
//       writer — the workspace "this was wrong" verb is v1 of this kind;
//       v2 email-reply ingestion is ALSO wired and routes through the same
//       writer: outbound/replyIngestion.js classifies stored owner replies
//       and calls markOwnerAutoSentWrong with channel 'email_reply');
//     - 'post_send_reversal'   — owner reversal of an executed send's AR
//       ledger post (wired: reverseExecutedOutboundArPost records it inside
//       the writer — the workspace "undo the books entry" verb on invoice
//       sent-FYI rows; the reversal routes through firmDb's correction
//       machinery; the email-reply channel never triggers it). ALL FIVE
//       kinds are now wired at their writers — none reserved.
//   NOT counted (deliberately): counterparty unsubscribes/complaints (not an
//   owner correction), owner pauses of a chase (a scheduling choice), and
//   counterparty disputes (a dispute about the invoice, not about Donna's
//   send being wrong).
//
// D1's confidence clause lives in actionGate.js (a deterministic paid-truth
// verdict satisfies the auto confidence floor) — not here.
//
// Failure posture: every recorder is savepoint-guarded so a pre-100 database
// (or the un-deployed source-CHECK widening) can never poison the caller's
// transaction — the send/decline commits; the ladder skips and logs. The
// ladder under-counts on failure, never wrongly graduates (fail-closed).
//
// Keep-layer posture: deterministic counters, audited state transitions,
// writer-guarded graduation. No LLM anywhere.

import { randomUUID } from 'node:crypto';

import {
  AUTO_FORBIDDEN_FLAGS, readClientConfigSnapshot, setClientFlagStage, stageActs
} from '../clientConfig.js';
import { outboundFlagKeyForAction, OUTBOUND_ACTION_TYPES } from './actionGate.js';
import { gateRoleSurfaceOperation } from '../roles/roleAuthority.js';

// N — the clean-send target. Default sits mid-band of D1's 5–10; the
// config-plane override is the per-row clean_target column, set through the
// audited setter below (never an env pair — the rollout-flags rail).
export const DEFAULT_CLEAN_SEND_TARGET = 7;

export const EARNED_AUTO_STATES = Object.freeze(['counting', 'earned', 'graduated']);

export const OUTBOUND_CORRECTION_KINDS = Object.freeze([
  'declined_held_draft', 'cancelled_pre_send', 'edited_held_draft',
  'reply_if_wrong', 'post_send_reversal'
]);

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';
// 23514 = check_violation: the 100 source-CHECK widening hasn't run yet.
const recoverable = (error) => missingTables(error) || error?.code === '23514';

export const cleanSendTargetFor = (row) => {
  const override = Number(row?.clean_target);
  return Number.isInteger(override) && override >= 1 ? override : DEFAULT_CLEAN_SEND_TARGET;
};

const auditEvent = async (client, {
  firmId, clientId, actorType = 'system', actorId = null,
  action, resourceId, metadata = {}
}) => {
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, $4, $5, 'outbound_earned_auto', $6, $7::jsonb)`,
    [firmId, clientId, actorType, actorId, action, resourceId, JSON.stringify(metadata)]
  );
};

// Run `fn` under a savepoint when a transaction is open, plain otherwise.
// A recoverable failure (absent table/column, un-widened CHECK) rolls back to
// the savepoint and reports skipped — the caller's transaction stays healthy.
const guarded = async (client, name, fn) => {
  let savepointed = false;
  try {
    await client.query(`savepoint ${name}`);
    savepointed = true;
  } catch {
    savepointed = false;
  }
  try {
    const result = await fn();
    if (savepointed) await client.query(`release savepoint ${name}`);
    return result;
  } catch (error) {
    if (savepointed) {
      try { await client.query(`rollback to savepoint ${name}`); } catch { /* best-effort */ }
    }
    if (recoverable(error)) return { skipped: true, reason: `unavailable:${error.code}` };
    throw error;
  }
};

// ── Reads ────────────────────────────────────────────────────────────────────

export const gatherEarnedAutoStates = async (client, { firmId, clientId }) => {
  try {
    const { rows } = await client.query(
      `select * from outbound_earned_auto
        where firm_id = $1 and client_id = $2
        order by action_type asc`,
      [firmId, clientId]
    );
    return rows;
  } catch (error) {
    if (missingTables(error)) return [];
    throw error;
  }
};

// ── The tuning writer (config-plane value for N; audited) ────────────────────

export const setEarnedAutoCleanTarget = async (client, {
  firmId, clientId, actionType, target,
  actorType = 'system', actorId = null, reason = null
}) => {
  if (!OUTBOUND_ACTION_TYPES.includes(actionType)) {
    throw new Error(`setEarnedAutoCleanTarget: unknown action_type '${actionType}'`);
  }
  const n = Number(target);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('setEarnedAutoCleanTarget: target must be an integer >= 1');
  }
  const id = randomUUID();
  const { rows } = await client.query(
    `insert into outbound_earned_auto (id, firm_id, client_id, action_type, clean_target)
     values ($1, $2, $3, $4, $5)
     on conflict (firm_id, client_id, action_type) do update set
       clean_target = excluded.clean_target, updated_at = now()
     returning *`,
    [id, firmId, clientId, actionType, n]
  );
  await auditEvent(client, {
    firmId, clientId, actorType, actorId,
    action: 'outbound_earned_auto.target_set', resourceId: rows[0].id,
    metadata: { action_type: actionType, clean_target: n, reason }
  });
  return rows[0];
};

// ── Graduation (through the audited config-plane writer, never around it) ────

// `setStageFn` exists for tests only (the real AUTO_FORBIDDEN set makes a live
// OUTBOUND graduation unreachable until Kari's veto-lift PR, so tests inject a
// spy); runtime callers never pass it — the default IS the audited writer.
const maybeGraduate = async (client, {
  firmId, clientId, actionType, ladderRow, snapshot = null,
  forbiddenFlags = AUTO_FORBIDDEN_FLAGS, setStageFn = setClientFlagStage
}) => {
  const flagKey = outboundFlagKeyForAction(actionType);
  if (!flagKey || !ladderRow || ladderRow.state !== 'earned') {
    return { graduated: false, reason: 'not_earned' };
  }
  // The veto: the terminal is not approved — the earned state RESTS ON KARI.
  // Never call the writer here; its own refusal stays the backstop.
  if (forbiddenFlags.has(flagKey)) {
    return { graduated: false, reason: 'terminal_not_approved', flagKey };
  }
  const stage = snapshot && typeof snapshot === 'object' && snapshot[flagKey]
    ? snapshot[flagKey].stage : null;
  if (stage === 'auto') {
    // Kari already staged the terminal manually — the ladder's work is moot;
    // record graduated without a duplicate config write.
    const { rows } = await client.query(
      `update outbound_earned_auto
          set state = 'graduated', graduated_at = now(), updated_at = now()
        where id = $1 and state = 'earned'
        returning *`,
      [ladderRow.id]
    );
    if (rows[0]) {
      await auditEvent(client, {
        firmId, clientId,
        action: 'outbound_earned_auto.graduated', resourceId: ladderRow.id,
        metadata: { action_type: actionType, flag_key: flagKey, basis: 'stage_already_auto' }
      });
    }
    return { graduated: Boolean(rows[0]), reason: 'stage_already_auto', flagKey };
  }
  if (!stageActs(stage)) {
    // Clean sends only happen at an acting stage; a snapshot that no longer
    // acts (owner turned the flag off/down) must never be broadened by the
    // ladder — graduation waits.
    return { graduated: false, reason: 'stage_not_acting', flagKey, stage };
  }
  await setStageFn(client, {
    firmId, clientId, flagKey, stage: 'auto',
    source: 'earned_auto',
    reason: `earned-auto ladder: ${ladderRow.clean_streak} clean owner-approved '${actionType}' sends (target ${cleanSendTargetFor(ladderRow)})`,
    actorType: 'system', actorId: 'earned_auto_ladder'
  });
  const { rows } = await client.query(
    `update outbound_earned_auto
        set state = 'graduated', graduated_at = now(), updated_at = now()
      where id = $1 and state = 'earned'
      returning *`,
    [ladderRow.id]
  );
  await auditEvent(client, {
    firmId, clientId,
    action: 'outbound_earned_auto.graduated', resourceId: ladderRow.id,
    metadata: {
      action_type: actionType, flag_key: flagKey,
      clean_streak: ladderRow.clean_streak, target: cleanSendTargetFor(ladderRow)
    }
  });
  return { graduated: Boolean(rows[0]), reason: 'graduated', flagKey };
};

// ── The clean-send recorder (executor finalize path) ─────────────────────────
// Call when a send finalizes with authority 'per_send_owner_approval'.
// Savepoint-guarded: a pre-100 DB skips without poisoning the finalize txn.

export const recordCleanApprovedSend = async (client, {
  firmId, clientId, actionType, actionId = null, receiptId = null,
  snapshot = null, forbiddenFlags = AUTO_FORBIDDEN_FLAGS, setStageFn = setClientFlagStage
}) => {
  if (!OUTBOUND_ACTION_TYPES.includes(actionType)) return { skipped: true, reason: 'unknown_action_type' };
  return guarded(client, 'earned_auto_clean', async () => {
    const id = randomUUID();
    const { rows } = await client.query(
      `insert into outbound_earned_auto
         (id, firm_id, client_id, action_type, clean_streak, total_clean, last_clean_receipt_id)
       values ($1, $2, $3, $4, 1, 1, $5)
       on conflict (firm_id, client_id, action_type) do update set
         clean_streak = outbound_earned_auto.clean_streak + 1,
         total_clean = outbound_earned_auto.total_clean + 1,
         last_clean_receipt_id = excluded.last_clean_receipt_id,
         updated_at = now()
       returning *`,
      [id, firmId, clientId, actionType, receiptId]
    );
    let row = rows[0];
    if (!row) return { skipped: true, reason: 'no_row' };
    const target = cleanSendTargetFor(row);
    let earnedNow = false;
    if (row.state === 'counting' && Number(row.clean_streak) >= target) {
      const earned = await client.query(
        `update outbound_earned_auto
            set state = 'earned', earned_at = now(), updated_at = now()
          where id = $1 and state = 'counting'
          returning *`,
        [row.id]
      );
      if (earned.rows[0]) {
        row = earned.rows[0];
        earnedNow = true;
        const flagKey = outboundFlagKeyForAction(actionType);
        await auditEvent(client, {
          firmId, clientId,
          action: 'outbound_earned_auto.earned', resourceId: row.id,
          metadata: {
            action_type: actionType, flag_key: flagKey,
            clean_streak: Number(row.clean_streak), target,
            terminal_approved: !forbiddenFlags.has(flagKey),
            action_id: actionId
          }
        });
      }
    }
    let graduation = { graduated: false, reason: 'not_earned' };
    if (row.state === 'earned') {
      graduation = await maybeGraduate(client, {
        firmId, clientId, actionType, ladderRow: row, snapshot, forbiddenFlags, setStageFn
      });
    }
    return {
      skipped: false, row, earnedNow,
      graduated: graduation.graduated, graduationReason: graduation.reason
    };
  });
};

// ── The correction recorder (writer-wired; see the counted set above) ────────

export const recordOutboundCorrection = async (client, {
  firmId, clientId, actionType, kind, refType = null, refId = null,
  actorType = 'owner', actorId = null
}) => {
  if (!OUTBOUND_ACTION_TYPES.includes(actionType)) return { skipped: true, reason: 'unknown_action_type' };
  const correctionKind = OUTBOUND_CORRECTION_KINDS.includes(kind) ? kind : 'cancelled_pre_send';
  return guarded(client, 'earned_auto_correction', async () => {
    const id = randomUUID();
    const correction = {
      kind: correctionKind, ref_type: refType, ref_id: refId,
      actor_type: actorType, actor_id: actorId, at: new Date().toISOString()
    };
    const { rows } = await client.query(
      `insert into outbound_earned_auto
         (id, firm_id, client_id, action_type, clean_streak, corrections_count, last_correction)
       values ($1, $2, $3, $4, 0, 1, $5::jsonb)
       on conflict (firm_id, client_id, action_type) do update set
         clean_streak = 0,
         corrections_count = outbound_earned_auto.corrections_count + 1,
         last_correction = excluded.last_correction,
         updated_at = now()
       returning *`,
      [id, firmId, clientId, actionType, JSON.stringify(correction)]
    );
    const row = rows[0];
    if (!row) return { skipped: true, reason: 'no_row' };
    await auditEvent(client, {
      firmId, clientId, actorType, actorId,
      action: 'outbound_earned_auto.correction_recorded', resourceId: row.id,
      metadata: { action_type: actionType, ...correction }
    });

    let suspended = false;
    if (row.state === 'earned' || row.state === 'graduated') {
      const wasGraduated = row.state === 'graduated';
      await client.query(
        `update outbound_earned_auto
            set state = 'counting', updated_at = now()
          where id = $1`,
        [row.id]
      );
      if (wasGraduated) {
        // Auto-suspend-on-correction (040/095 pattern), scoped HONESTLY: only
        // a LADDER-MINTED 'auto' row (source 'earned_auto') is demoted. A
        // manual 'auto' row is Kari's deliberate per-terminal call — never
        // overridden by machinery.
        const flagKey = outboundFlagKeyForAction(actionType);
        const active = await client.query(
          `select stage, source from client_capability_config
            where firm_id = $1 and client_id = $2 and flag_key = $3
              and valid_to is null`,
          [firmId, clientId, flagKey]
        ).then((r) => r.rows[0] || null);
        if (active && active.stage === 'auto' && active.source === 'earned_auto') {
          await setClientFlagStage(client, {
            firmId, clientId, flagKey, stage: 'canary',
            source: 'earned_auto',
            reason: `earned-auto suspended after correction: ${correctionKind}`,
            actorType: 'system', actorId: 'earned_auto_ladder'
          });
          suspended = true;
        }
        await auditEvent(client, {
          firmId, clientId,
          action: 'outbound_earned_auto.auto_suspended', resourceId: row.id,
          metadata: {
            action_type: actionType, flag_key: flagKey, kind: correctionKind,
            config_demoted: suspended,
            kept_stage: !suspended && active ? `${active.stage}:${active.source}` : null
          }
        });
      } else {
        await auditEvent(client, {
          firmId, clientId,
          action: 'outbound_earned_auto.earned_reset', resourceId: row.id,
          metadata: { action_type: actionType, kind: correctionKind }
        });
      }
    }
    return { skipped: false, row: { ...row, state: 'counting' }, suspended };
  });
};

// ── The sweep hook: graduate earned rows the moment a veto lifts ─────────────
// Runs per client on the hourly sweep (autocommit; cheap indexed read). This
// is what turns "Kari removed the flag from AUTO_FORBIDDEN in a deliberate
// PR" into graduation WITHOUT waiting for the next owner-approved send.

export const sweepEarnedAutoGraduations = async (client, {
  firmId, clientId, snapshot = null, forbiddenFlags = AUTO_FORBIDDEN_FLAGS,
  setStageFn = setClientFlagStage, env = process.env, logger = console
}) => {
  let earnedRows = [];
  try {
    earnedRows = await client.query(
      `select * from outbound_earned_auto
        where firm_id = $1 and client_id = $2 and state = 'earned'`,
      [firmId, clientId]
    ).then((r) => r.rows);
  } catch (error) {
    if (missingTables(error)) return { skipped: true, graduated: 0 };
    throw error;
  }
  if (!earnedRows.length) return { skipped: false, graduated: 0, earned_pending: 0 };
  const resolvedSnapshot = snapshot
    || await readClientConfigSnapshot(client, { firmId, clientId });
  // S1 role leash (INV-S2): graduation is an authority PROMOTION and belongs
  // to Donna core's authority plane BY LAW — no role may ever claim this verb
  // (validateRoleRegistry refuses the claim), so the converged decision here
  // pins the attribution rather than narrowing it. The real write guard stays
  // the audited config-plane writer + the AUTO_FORBIDDEN veto.
  const roleGate = await gateRoleSurfaceOperation({
    actionType: 'graduate_earned_auto', snapshot: resolvedSnapshot, env,
    seam: 'outbound_sweep', firmId, clientId, logger,
    query: (sql, params) => client.query(sql, params)
  });
  if (!roleGate.proceed) return { skipped: true, graduated: 0, reason: 'role_leash_denied' };
  let graduated = 0;
  for (const row of earnedRows) {
    const result = await guarded(client, 'earned_auto_sweep', () => maybeGraduate(client, {
      firmId, clientId, actionType: row.action_type, ladderRow: row,
      snapshot: resolvedSnapshot, forbiddenFlags, setStageFn
    }));
    if (result?.graduated) graduated += 1;
  }
  return { skipped: false, graduated, earned_pending: earnedRows.length - graduated };
};
