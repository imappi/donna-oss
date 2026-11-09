// Donna — the open-ask re-ask cadence (F9; design
// docs/design-2026-07-06-loop-clock-decisions-twin-aging.md §3, Kari's dated
// answer 2026-07-06: nudge at 7d, again at 14d, then escalate to Kari's queue
// as a named exception).
//
// Terminal 2 ("on the owner") gets its bounded clock here: an open
// client_evidence_requests row may rest on the owner, but never invisibly
// forever. The columns already exist and are maintained (send_count / due_at /
// last_sent_at — the mint and every re-send path bump them); this module only
// adds the CLOCK: a bounded sweep that re-arms overdue asks and, when the
// owner channel has gone dead (two nudges unanswered), stops re-asking and
// hands the exception to the FIRM — the one legitimate firm-side resting
// place, because Kari IS the human the system escalates to when the owner is
// unresponsive. The escalation is receipted ('evidence_request.escalated_to_firm'
// + the request_payload.escalated_to_firm marker) and surfaced as a firm-owned
// blocker on the request's evidence case (the EXISTING bookkeeping_cases
// queue substrate — no new table, no third spine).
//
// A "nudge" is a REAL reminder: the sweep routes the ask through
// deliverEvidenceAsksOnAllChannels (db/asks.js), the same one fan-out the first
// send used, so every per-channel gate (WhatsApp/SMS/Telegram env allowlist +
// binding, OWNER_EMAIL_ASKS, the sensitive-identifier guard, the
// delivery-unknown rail) applies unchanged and each attempt lands in the
// message_delivery_ledger. The deliverer is the one that moves send_count /
// last_sent_at (108), and only on a genuine send. The client-level gates the
// first send applies before its fan-out — pilot send containment
// (INTERNAL_PILOT_SEND_DISABLED) and entity-readiness admission at 'ask_send'
// — are the ONE shared gate (ownerAskDelivery.js), checked here once per
// client sweep and again by the fan-out itself; while either refuses, nothing
// is sent and nothing is counted (the ask stays open on the owner, the refusal
// is receipted 'evidence_request.send_refused', and the next tick re-checks).
//
// A delivered reminder is never repeated by a lost write: the clock runs from
// the LATER of due_at and the last genuine send (last_sent_at, which only the
// deliverer moves, in the same write as its ledger receipt). If the sweep's own
// re-arm write after a successful delivery fails, the deliverer's stamp alone
// keeps the ask off the next tick's overdue list.
//
// When no channel delivered, the portal is the only surface left. It counts
// as a reminder ONLY if a customer-side person can actually see it there (an
// active, signed-in, client-scoped owner assigned to this client): then the
// sweep refreshes the request_payload.evidence_request envelope the portal
// renders and counts the send, as before. When nobody can be reached at all,
// re-asking is meaningless: the ask is escalated to the firm at once
// ('owner_unreachable'), never left to age on an invisible clock.
//
// One owner for channel reminders: while this cadence ACTS for a client, the
// evidence-topic reminder sweep (channels/evidenceTopicReminders.js) defers
// to it, so an ask is never reminded by both.
//
// Keep-layer plumbing only: no LLM, no re-judging the question, no re-wording
// (the drafted question stands verbatim).
//
// Flag, born on the plane (CLAUDE.md rail): ASK_REASK_CADENCE via
// clientFlagActs with envFallback () => false. Ladder: off → shadow (count +
// receipt the would-nudge/would-escalate) → canary → auto. The nudge interval
// is a tuning knob (ASK_REASK_NUDGE_DAYS, default 7 — env-legitimate).

import {
  clientFlagActs, clientFlagObserves, readClientConfigSnapshot
} from './clientConfig.js';
import {
  escalateAskToFirmWithClient, gateOwnerSendWithClient, hasPortalRecipientWithClient
} from './ownerAskDelivery.js';

export const REASK_CADENCE_FLAG_KEY = 'ASK_REASK_CADENCE';

// Kari's recorded cadence (2026-07-06): 7 days between sends.
export const askReaskNudgeDays = (env = process.env) => {
  const n = Number(env?.ASK_REASK_NUDGE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

// send 1 (the mint) → nudge at 7d (send_count 2) → nudge at 14d (send_count 3)
// → still unanswered past the 14d nudge → escalate, stop re-asking.
export const ASK_REASK_MAX_SEND_COUNT = 3;

const DEFAULT_LIMIT = 25;

// Sends the owner has not answered. An owner who answered "still unpaid"
// (request_payload.obligation_open_acknowledged, written by the owner-reply
// reader with the send_count at that answer) is not unresponsive: only the
// sends after that answer count toward the escalation bound.
const unansweredSendCount = (row) => Number(row.send_count || 0)
  - Number(row.request_payload?.obligation_open_acknowledged?.send_count || 0);

// Overdue open asks: past due_at (when set — the flag-gated mint path sets it)
// AND at least the nudge interval past the LAST GENUINE SEND, so the recorded
// cadence ("7 days between sends") holds even when a re-arm write was lost.
// Escalated requests are excluded: their clock is stopped, the exception is on
// the firm.
//
// DMEM-R1 W1 (INV-14, audit F-11): the re-ask clock runs from a send a
// deliverer made — `send_count > 0` and `last_sent_at` (108: only a deliverer
// bumps the count). A `draft` was never sent and is not here; a legacy `open`
// row whose stamps are the mint's (send_count 0) has no honest clock to age
// from and is LR-2's to repair, not this sweep's to nudge. `created_at` is no
// longer a clock base: minting is not sending.
const OVERDUE_ASKS_SQL = `
  select id, transaction_id, question, evidence_type, send_count,
         due_at, last_sent_at, first_sent_at, created_at, request_payload
    from client_evidence_requests
   where firm_id = $1
     and client_id = $2
     and status = 'open'
     and audience = 'client'
     and send_count > 0
     and last_sent_at is not null
     and coalesce(request_payload->>'escalated_to_firm', '') = ''
     -- greatest() skips a null due_at; the last genuine send always counts, so
     -- a delivered reminder whose re-arm write was lost is not due again.
     and greatest(
           due_at,
           last_sent_at + ($3 || ' days')::interval
         ) < $4::timestamptz
   order by coalesce(due_at, last_sent_at) asc
   limit $5`;

const defaultDeliver = async (args) => {
  const { deliverEvidenceAsksOnAllChannels } = await import('./db/asks.js');
  return deliverEvidenceAsksOnAllChannels(args);
};

// The bounded per-client sweep the daily cron runs. Per-item posture: each
// overdue row is handled in its OWN short transaction, so one poisoned row
// never rolls back the rest (the F5 lesson); the caller holds no open txn.
// The channel fan-out is a network side effect and runs OUTSIDE any
// transaction (as the batch send and the operator resend run it).
// Returns { skipped?, considered, nudged, delivered, portal, held, escalated,
// shadow?, errors }.
export const runAskReaskSweep = async ({
  client, firmId, clientId, env = process.env, now = Date.now(), limit = DEFAULT_LIMIT, deps = {}
} = {}) => {
  if (!client || !firmId || !clientId) return { skipped: true, reason: 'missing_args' };
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const acts = clientFlagActs({
    flagKey: REASK_CADENCE_FLAG_KEY, snapshot, envFallback: () => false, env
  });
  const observes = clientFlagObserves({
    flagKey: REASK_CADENCE_FLAG_KEY, snapshot, envFallback: () => false, env
  });
  if (!acts && !observes) return { skipped: true, reason: 'flag_off' };

  const nudgeDays = askReaskNudgeDays(env);
  const bounded = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 200);
  const nowIso = new Date(now).toISOString();
  let overdue;
  try {
    overdue = await client.query(OVERDUE_ASKS_SQL, [
      firmId, clientId, String(nudgeDays), nowIso, bounded
    ]);
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return { skipped: true, reason: 'tables_absent' };
    }
    throw error;
  }
  const rows = overdue.rows || [];
  const stats = {
    skipped: false, considered: rows.length, nudged: 0, delivered: 0, portal: 0, held: 0, escalated: 0, errors: 0
  };
  if (!rows.length) return stats;

  if (!acts) {
    // Shadow stage: receipt the would-run, touch nothing.
    const wouldNudge = rows.filter((r) => unansweredSendCount(r) < ASK_REASK_MAX_SEND_COUNT).length;
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'evidence_request.reask_would_run', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({
          considered: rows.length,
          would_nudge: wouldNudge,
          would_escalate: rows.length - wouldNudge,
          request_ids: rows.map((r) => r.id)
        })]
      );
    } catch { /* best-effort shadow receipt */ }
    return { ...stats, shadow: true };
  }

  const deliver = deps.deliver || defaultDeliver;
  let sendGate;
  let portalVisible;

  for (const row of rows) {
    const sendCount = Number(row.send_count || 0);
    try {
      if (unansweredSendCount(row) >= ASK_REASK_MAX_SEND_COUNT) {
        // The owner had every reminder the cadence allows and answered none.
        await escalateAskToFirmWithClient(client, { firmId, clientId, row, nowIso, reason: 'owner_unresponsive' });
        stats.escalated += 1;
        continue;
      }

      // The first send's client-level gates. Refused ⇒ nothing sent, nothing
      // counted, no envelope rewrite: the ask stays open on the owner and the
      // next tick re-checks.
      if (sendGate === undefined) {
        sendGate = await gateOwnerSendWithClient({
          client, firmId, clientId, surface: 'ask_reask',
          evidenceRequestIds: rows.filter((r) => unansweredSendCount(r) < ASK_REASK_MAX_SEND_COUNT).map((r) => r.id),
          deps
        });
      }
      if (!sendGate.allowed) {
        stats.held += 1;
        continue;
      }

      // NUDGE — the same one fan-out the first send used. Only a channel that
      // genuinely delivered moves send_count (the deliverer's 108 bump), so
      // the re-read below is an honest execution verifier.
      const channelFanout = await deliver({
        client, firmId, clientId, evidenceRequestIds: [row.id], surface: 'ask_reask'
      }).catch((error) => ({ error: error?.message || 'fanout_failed' }));
      const after = await client.query(
        'select send_count from client_evidence_requests where firm_id = $1 and id = $2 limit 1',
        [firmId, row.id]
      );
      const afterCount = Number(after.rows?.[0]?.send_count ?? sendCount);
      const delivered = afterCount > sendCount;
      if (!delivered && channelFanout?.refused) {
        // The fan-out's own gate refused (the client was contained between the
        // sweep's check and this send): held, exactly like the check above.
        stats.held += 1;
        continue;
      }

      let surface = delivered ? 'channel' : null;
      if (!delivered) {
        if (portalVisible === undefined) portalVisible = await hasPortalRecipientWithClient(client, { firmId, clientId });
        if (portalVisible) surface = 'portal';
      }
      if (!surface) {
        // No channel delivered and nobody can see the ask in the portal: a
        // reminder cannot reach anyone, so the exception goes to the firm now.
        await escalateAskToFirmWithClient(client, { firmId, clientId, row, nowIso, reason: 'owner_unreachable' });
        stats.escalated += 1;
        continue;
      }

      const nextSendCount = surface === 'portal' ? sendCount + 1 : afterCount;
      const nextDueIso = new Date(now + nudgeDays * 86400000).toISOString();
      await client.query('begin');
      if (surface === 'portal') {
        // The portal is the delivery surface for this reminder: the bumped
        // send stamp in the envelope it renders IS what the owner sees.
        const envelope = {
          ...(row.request_payload?.evidence_request || {}),
          id: row.id,
          status: 'open',
          question: row.question || row.request_payload?.evidence_request?.question || '',
          sent_at: now,
          send_count: nextSendCount,
          nudged_at: now
        };
        await client.query(
          `update client_evidence_requests
              set send_count = $3,
                  last_sent_at = $4::timestamptz,
                  due_at = $5::timestamptz,
                  request_payload = request_payload || $6::jsonb,
                  updated_at = now()
            where firm_id = $1 and id = $2 and status = 'open'`,
          [firmId, row.id, nextSendCount, nowIso, nextDueIso,
            JSON.stringify({ evidence_request: envelope })]
        );
      } else {
        // The deliverer already stamped send_count / last_sent_at and the
        // envelope; the sweep only re-arms the clock and marks the nudge.
        await client.query(
          `update client_evidence_requests
              set due_at = $3::timestamptz,
                  request_payload = request_payload || jsonb_build_object('evidence_request',
                    coalesce(request_payload->'evidence_request', '{}'::jsonb)
                    || jsonb_build_object('nudged_at', $4::bigint)),
                  updated_at = now()
            where firm_id = $1 and id = $2 and status = 'open'`,
          [firmId, row.id, nextDueIso, now]
        );
      }
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'evidence_request.nudged', 'client_evidence_request', $3, $4::jsonb)`,
        [firmId, clientId, row.id, JSON.stringify({
          transaction_id: row.transaction_id || null,
          send_count: nextSendCount,
          due_at: nextDueIso,
          nudge_days: nudgeDays,
          surface,
          channel_fanout: channelFanout
        })]
      );
      await client.query('commit');
      stats.nudged += 1;
      if (surface === 'portal') stats.portal += 1; else stats.delivered += 1;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      try {
        console.warn(`[askReaskCadence] request ${row.id} sweep failed: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }
  return stats;
};
