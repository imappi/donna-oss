// Donna Loops — the auto-send PRODUCER for client ask-batches (Slice 2 of the
// autonomous-loop demo; see docs/session-handoff-2026-06-23-autonomous-loop-autosend.md).
//
// The strong-LLM ask pipeline already DRAFTS the client's open questions (the
// intelligence — askPipeline.js / draftClientAskBatchInDb). Sending that drafted
// batch to the client is `client_visible_message`, a V1-FORBIDDEN action: forbidden
// to autonomy at EVERY graduation tier BY DESIGN. The contract's only escape hatch
// is an explicit `human_authorized` criterion — and Slice 1 wired exactly that as the
// firm setting `auto_send_client_asks` (loopExecutionGate.FRIENDLY_AUTHORIZATION_FLAGS).
//
// This producer is the Keep-layer plumbing that lets that standing human "yes" ACT: on
// each cron tick it finds the firm's current sendable draft and — ONLY when the firm is
// at an autonomous tier (canary+) AND has turned the toggle on — delivers it through the
// EXISTING send path (__sendClientAskBatchWithClient). It decides NOTHING the model
// didn't already draft; it only authorizes delivery. CLAUDE.md trust-the-strong-LLM:
// no intelligence-substituting scaffolding — the gate is a system-correctness control
// (who may act, how far), not a re-judgement of what to ask.
//
// Gating (the Slice-2 split — get this right):
//   - auto-DRAFT a question = `proposal_creation` (Slice 3) — canary+ via the tier gate.
//   - auto-SEND the drafted batch = `client_visible_message` (V1-forbidden) — canary+
//     AND the `auto_send_client_asks` authorization. A canary firm drafts on its own,
//     but only SENDS on its own once the human toggle is on.
//
// Idempotent + safe:
//   - Master-gated by isLoopSystemEnabled(env): loops off → a clean skip (no-op).
//   - RE-GATES per firm right before each send — a firm suspension (or a tier/toggle
//     change) landing between draft and tick stops the spend (decideLoopExecution).
//   - Sends through the existing path, which FOR UPDATE-locks the row and validates
//     status='draft' (409 otherwise). A second tick finds no live draft → no-op; a
//     batch superseded/sent by a concurrent tick raises ASK_BATCH_NOT_DRAFT, swallowed
//     as the idempotent no-op it is.
//   - Empty / nothing-to-ask drafts are skipped (a draft that would create no client
//     evidence request is not delivered).

import {
  isLoopSystemEnabled, decideLoopExecution, readFirmExecutionContext
} from './loopExecutionGate.js';
import { clientFlagActs, readClientConfigSnapshot } from './clientConfig.js';
import { RETRACTION_AUTOSEND_FLAG_KEY } from './reconciliationTwinAging.js';
import { __sendClientAskBatchWithClient } from './firmDb.js';

const LOG_TAG = 'askAutoSendProducer';

// The per-loop tier key (loops['coding_ask_batch_resolution'].tier may override the
// firm-wide loops.tier). Matches the loop that owns the ask-batch resolution goal.
const LOOP_KEY = 'coding_ask_batch_resolution';

// The bounded §13.8 action this producer performs: delivering a client-visible message.
// V1-forbidden → permitted only with the standing human authorization AND at canary+.
const REQUESTED_ACTION = 'client_visible_message';

// The receipt stamped on the send audit so an autonomous send is distinguishable from a
// firm operator's click in audit_events (`firm_setting:<the toggle that authorized it>`).
const AUTHORIZED_BY = 'firm_setting:auto_send_client_asks';

const DEFAULT_LIMIT = 25;

// Would sending this draft create ≥1 client evidence request? The send path
// (__sendClientAskBatchWithClient) materializes one request per ask-disposition item
// (with a transaction_id), one per statement_request that kept an anchor line, and one
// per document_asks ask (doc-first drain Slice 3 — a genuine owner question, so it
// counts) — so a "sendable" draft is one with at least one of those. A draft whose
// model output asks nothing (all items resolved/notify, no anchored statement request,
// no doc ask) is NOT delivered — explained-document FYIs deliberately do NOT count,
// same standard-digest posture as the other pure-FYI populations.
// Read straight off the persisted draft, never re-inferred (render the verdict).
export const draftAskCount = (payload) => {
  const draft = payload?.draft || {};
  const askItems = Array.isArray(draft.items)
    ? draft.items.filter((item) => item?.disposition === 'ask' && item?.transaction_id).length
    : 0;
  const statementRequests = Array.isArray(draft.statement_requests)
    ? draft.statement_requests.filter((req) => (req?.anchor_transaction_ids || [])[0]).length
    : 0;
  const documentAsks = Array.isArray(draft.document_asks)
    ? draft.document_asks.filter((item) => item?.disposition === 'ask' && item?.document_id).length
    : 0;
  return askItems + statementRequests + documentAsks;
};

export const isSendableDraft = (payload) => draftAskCount(payload) > 0;

// Retraction auto-send (RECONCILE_RETRACTION_AUTOSEND on the plane — RT-11 converted the
// RECONCILE_RETRACTION_AUTOSEND_ENABLED env pair; envFallback false, seeded auto on
// desktop, env can only KILL it via CLIENT_CONFIG_FORCE_DISABLE): a draft whose only new
// content is the all-clear for previously-asked items the matcher / Donna's own
// auto_explain has since handled (draft.retracted_items, written by the flag-gated draft
// builder) carries no `ask` item, so isSendableDraft scores it 0. But the question chased
// the client autonomously, so the resolution should too — count retractions toward
// sendability when the flag acts for this client. Resolved per (firm, client) per tick
// off the same memoized snapshot as the other plane flags below.
export const draftRetractionCount = (payload) =>
  Array.isArray(payload?.draft?.retracted_items) ? payload.draft.retracted_items.length : 0;

// F7 — the 7-day FYI send floor (design 2026-07-06 §2; Kari's dated answer:
// a pure-FYI batch may wait at most 7 days before it sends on its own). A
// draft with no genuine ask is normally NOT delivered (isSendableDraft = 0),
// so the material auto-FYIs it carries rest undelivered until the next real
// question comes along. The floor closes that: when the OLDEST undelivered
// material FYI in the draft is older than the floor, the pure-FYI draft
// becomes sendable on its own. Flag on the plane (ASK_FYI_SEND_FLOOR,
// envFallback false); the floor length is a tuning knob
// (ASK_FYI_SEND_FLOOR_DAYS, default 7 — env-legitimate).
//
// Scope note: the floor is keyed on the material auto-FYI receipts
// (posted_fyi_match_ids → material_auto_fyi.owner_notified=false), the F7
// population Q3(a) was asked about. A draft whose ONLY content is other FYI
// lanes (explained docs / settlements / coding FYIs) does not trip the floor
// yet — a named follow-up, not silently covered.
export const FYI_SEND_FLOOR_FLAG_KEY = 'ASK_FYI_SEND_FLOOR';

export const askFyiSendFloorDays = (env = process.env) => {
  const n = Number(env?.ASK_FYI_SEND_FLOOR_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

// Age (days) of the OLDEST still-undelivered material auto-FYI this draft
// summarises, read off the PERSISTED receipts — never re-inferred: the match
// rows' updated_at is the auto-FYI accept stamp (the upsert's status CASE
// freezes an auto_matched row until the send chokepoint flips
// owner_notified). Returns null when the draft carries no undelivered
// material FYI (or the read soft-fails) — the floor then never trips.
export const oldestUndeliveredFyiAgeDays = async ({ client, firmId, payload, now = Date.now() } = {}) => {
  const ids = Array.isArray(payload?.posted_fyi_match_ids)
    ? payload.posted_fyi_match_ids.filter(Boolean)
    : [];
  if (!client || !firmId || !ids.length) return null;
  const res = await client.query(
    `select min(updated_at) as oldest
       from reconciliation_matches
      where firm_id = $1
        and id = any($2::text[])
        and status = 'auto_matched'
        and coalesce(payload->'authorization'->'material_auto_fyi'->>'owner_notified', '') = 'false'`,
    [firmId, ids]
  ).catch(() => ({ rows: [] }));
  const oldest = res.rows?.[0]?.oldest ? new Date(res.rows[0].oldest).getTime() : null;
  if (!Number.isFinite(oldest) || !oldest) return null;
  return (now - oldest) / 86400000;
};

// ── The settle gate (B1 + B2, the 2026-07-29 receipt-upload burst) ──────────
//
// Reported: uploading ONE receipt after a quiet period produced five ask
// messages, one of which asked for a photo of the very receipt just sent.
//
// Both halves are the SAME bug. The chain is upload → parse → reconcile → the
// post-reconcile seam files a draft request → drainAskDraftRequests re-drafts
// the client's WHOLE open-ask set → this producer sends it, same tick. The
// send therefore lands while the owner's upload is still being read.
//
// The obvious narrow fix — "just don't ask about the line the receipt covers" —
// is IMPOSSIBLE. An owner-initiated upload is registered with
// `transaction_id: null` (channels/inboundCore.js:585); nothing knows which
// bank line it answers until it has been parsed AND reconciled. At draft time
// the in-flight photo is unattributable by construction.
//
// So the only correct rule is client-scoped, and it is one sentence: if the
// owner has just sent evidence and we do not yet know what it answers, do not
// ask them anything until we do. One tick later the parse has settled, the
// seam has re-drafted (the draft pipeline supersedes, so it is idempotent), and
// the answered questions are simply no longer in the batch.
//
// This DEFERS, it never drops: the batch stays a live draft and the next tick
// reconsiders it. Two bounds keep that honest —
//   1. a staleness ceiling, so a parse stuck in 'processing' (the "READING ·
//      1 OF 1" bug class is real in this tree) can NEVER silence a client's
//      asks indefinitely. Past the ceiling an in-flight doc stops holding.
//   2. fail-OPEN on any read error: an unreadable gate sends exactly as it
//      does today. Holding on uncertainty is the failure mode that would turn
//      a diagnostic gap into an owner who never hears from Donna again.
export const ASK_SEND_SETTLE_FLAG_KEY = 'ASK_SEND_SETTLE_GATE';

// Tuning knob, env-legitimate per the rollout-flags rail (the ROLLOUT gate is
// the config-plane flag above; this is just how long "in flight" may last).
export const askSendSettleMinutes = (env = process.env) => {
  const n = Number(env?.ASK_SEND_SETTLE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 20;
};

// Pure decision, so the policy is testable without a database.
//   inFlight  — count of the client's owner-initiated uploads still being read
//               and not yet past the staleness ceiling
//   flagActs  — does ASK_SEND_SETTLE_GATE act for this client
//   readFailed— the count could not be established
export const shouldHoldForSettle = ({ inFlight = 0, flagActs = false, readFailed = false } = {}) => {
  if (!flagActs) return false;
  if (readFailed) return false; // fail open, never silence an owner on uncertainty
  return Number(inFlight) > 0;
};

// How many owner-initiated documents is this client still reading?
//
// 'pending' and 'processing' are the two non-terminal parse states
// (db/migrations/011: pending, processing, completed, failed, skipped,
// duplicate_pending). The owner_initiated predicate mirrors
// listOwnerMediaDocsNeedingTerminalSummaryInDb's byte for byte — a document
// registered by the owner-media lane carries the marker at either nesting
// depth. Returns { count, readFailed } so the caller can fail open explicitly
// rather than confuse "nothing in flight" with "could not tell".
export const countSettlingOwnerUploads = async ({ client, firmId, clientId, settleMinutes } = {}) => {
  if (!client || !firmId || !clientId) return { count: 0, readFailed: false };
  const res = await client.query(
    `select count(*)::int as in_flight
       from documents d
      where d.firm_id = $1
        and d.client_id = $2
        and d.parse_status in ('pending', 'processing')
        and d.created_at > now() - ($3::int * interval '1 minute')
        and (
          d.payload->>'owner_initiated' = 'true'
          or d.payload->'payload'->>'owner_initiated' = 'true'
        )`,
    [firmId, clientId, settleMinutes]
  ).catch(() => null);
  if (!res) return { count: 0, readFailed: true };
  return { count: Number(res.rows?.[0]?.in_flight || 0), readFailed: false };
};

const tablePresent = async (client, regclass) => {
  const res = await client.query('select to_regclass($1) as present', [regclass])
    .catch(() => ({ rows: [] }));
  return Boolean(res.rows[0]?.present);
};

// The firm's current LIVE drafts (status='draft' — a superseded draft is already
// 'superseded', so this is implicitly the non-superseded set). Oldest first so a
// backlog drains in order. Optionally scoped to one firm/client.
const readDraftBatches = async ({ client, firmId, clientId, limit }) => {
  const conditions = ["status = 'draft'"];
  const params = [];
  if (firmId) { params.push(firmId); conditions.push(`firm_id = $${params.length}`); }
  if (clientId) { params.push(clientId); conditions.push(`client_id = $${params.length}`); }
  params.push(limit);
  const res = await client.query(
    `select id, firm_id, client_id, payload, status
       from client_ask_batches
      where ${conditions.join(' and ')}
      order by created_at asc
      limit $${params.length}`,
    params
  );
  return res.rows;
};

// Drain up to `limit` live ask-batch drafts for (firm?, client?) and auto-send the ones
// a firm has authorized. Returns a summary. Master-gated (loops off / pre-ask-pipeline
// → a clean skip). No-throw per row: a send that fails (other than the idempotent 409)
// is counted and the drain continues — one poisoned batch never stalls the rest.
//
// sendFn is injectable for unit tests; in prod it is the real __sendClientAskBatchWithClient,
// which runs its own short txn on the SAME client (the producer holds no open txn).
export const drainAutoSendAskBatches = async ({
  client, firmId = null, clientId = null, limit = DEFAULT_LIMIT,
  env = process.env, sendFn = __sendClientAskBatchWithClient,
  requestRedraftFn = null
} = {}) => {
  if (!isLoopSystemEnabled(env)) return { skipped: true, reason: 'loops_off' };
  if (!client) return { skipped: true, reason: 'no_client' };
  if (!(await tablePresent(client, 'public.client_ask_batches'))) {
    return { skipped: true, reason: 'tables_absent' };
  }

  const bounded = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 200);
  const rows = await readDraftBatches({ client, firmId, clientId, limit: bounded });
  const stats = {
    skipped: false, considered: rows.length,
    sent: 0, empty: 0, held: 0, stale: 0, idempotent: 0, failed: 0, fyi_floor: 0, settling: 0
  };

  // The firm's gate decision is stable across one tick — resolve it once per firm.
  const gateByFirm = new Map();
  // The per-(firm, client) config snapshot for the FYI-floor flag — resolved at
  // most once per pair per tick (mirrors gateByFirm).
  const configByPair = new Map();
  const floorFlagActsFor = async (firmIdForRow, clientIdForRow) => {
    const key = `${firmIdForRow}:${clientIdForRow}`;
    if (!configByPair.has(key)) {
      configByPair.set(key, await readClientConfigSnapshot(client, {
        firmId: firmIdForRow, clientId: clientIdForRow
      }));
    }
    return clientFlagActs({
      flagKey: FYI_SEND_FLOOR_FLAG_KEY,
      snapshot: configByPair.get(key),
      envFallback: () => false,
      env
    });
  };
  // Same memoized snapshot, different flag: the settle gate rolls out per
  // client like every other behaviour change on this plane.
  const settleFlagActsFor = async (firmIdForRow, clientIdForRow) => {
    const key = `${firmIdForRow}:${clientIdForRow}`;
    if (!configByPair.has(key)) {
      configByPair.set(key, await readClientConfigSnapshot(client, {
        firmId: firmIdForRow, clientId: clientIdForRow
      }));
    }
    return clientFlagActs({
      flagKey: ASK_SEND_SETTLE_FLAG_KEY,
      snapshot: configByPair.get(key),
      envFallback: () => false,
      env
    });
  };
  // Same memoized snapshot, the retraction lane's flag (RT-11).
  const retractionFlagActsFor = async (firmIdForRow, clientIdForRow) => {
    const key = `${firmIdForRow}:${clientIdForRow}`;
    if (!configByPair.has(key)) {
      configByPair.set(key, await readClientConfigSnapshot(client, {
        firmId: firmIdForRow, clientId: clientIdForRow
      }));
    }
    return clientFlagActs({
      flagKey: RETRACTION_AUTOSEND_FLAG_KEY,
      snapshot: configByPair.get(key),
      envFallback: () => false,
      env
    });
  };

  for (const row of rows) {
    // Skip an empty / nothing-to-ask draft — never deliver a message with no question.
    // A retraction-only draft (the autonomous all-clear) is sendable when the flag is on.
    let sendable = isSendableDraft(row.payload)
      || (draftRetractionCount(row.payload) > 0 && await retractionFlagActsFor(row.firm_id, row.client_id));
    // F7 floor — a pure-FYI draft whose oldest undelivered material FYI has
    // aged past the floor sends on its own (flag-gated per client; the send
    // authority below still gates delivery exactly like any other send).
    if (!sendable && await floorFlagActsFor(row.firm_id, row.client_id)) {
      const age = await oldestUndeliveredFyiAgeDays({
        client, firmId: row.firm_id, payload: row.payload
      });
      if (age != null && age >= askFyiSendFloorDays(env)) {
        sendable = true;
        stats.fyi_floor += 1;
      }
    }
    if (!sendable) { stats.empty += 1; continue; }

    // Settle gate — hold this client's batch while their own upload is still
    // being read. Resolved at most once per (firm, client) per tick, on the
    // same memoized snapshot the FYI floor uses. A hold leaves the draft live,
    // so the next tick sends it against a batch that no longer contains the
    // questions the upload just answered.
    if (await settleFlagActsFor(row.firm_id, row.client_id)) {
      const { count, readFailed } = await countSettlingOwnerUploads({
        client, firmId: row.firm_id, clientId: row.client_id,
        settleMinutes: askSendSettleMinutes(env)
      });
      if (shouldHoldForSettle({ inFlight: count, flagActs: true, readFailed })) {
        stats.settling += 1;
        continue;
      }
    }

    // RE-GATE per firm right before sending: a suspension, a tier drop, or the toggle
    // being switched off AFTER the draft was written all stop the send here. A send is
    // permitted ONLY when the firm explicitly authorized client_visible_message AND is
    // at an autonomous tier — actionAllowed && humanAuthorized (Slice 1's receipt).
    let gate = gateByFirm.get(row.firm_id);
    if (!gate) {
      const { firmMetadata } = await readFirmExecutionContext(client, row.firm_id);
      gate = decideLoopExecution({
        loopKey: LOOP_KEY, firmMetadata, requestedAction: REQUESTED_ACTION, env
      });
      gateByFirm.set(row.firm_id, gate);
    }
    if (!(gate.actionAllowed === true && gate.humanAuthorized === true)) {
      stats.held += 1;
      continue;
    }

    try {
      await sendFn({
        client,
        firmId: row.firm_id,
        batchId: row.id,
        clientId: row.client_id,
        actorId: 'system',
        autoSend: true,
        authorizedBy: AUTHORIZED_BY
      });
      stats.sent += 1;
    } catch (error) {
      // Apply-time freshness is enforced by the send writer while holding the
      // batch row lock. A matcher/coder result that landed after drafting makes
      // the batch terminally superseded before anything is minted or delivered.
      // Ask for one fresh draft; the producer coalesces it with any already-live
      // request, so this heals the exact draft/model/send race without fan-out.
      if (error?.code === 'ASK_BATCH_STALE') {
        stats.stale += 1;
        if (typeof requestRedraftFn === 'function') {
          try {
            await requestRedraftFn({
              client,
              firmId: row.firm_id,
              clientId: row.client_id,
              env
            });
          } catch (redraftError) {
            try {
              console.warn(`[${LOG_TAG}] stale batch ${row.id} redraft request failed: ${redraftError?.message || redraftError}`);
            } catch { /* never throw from the logger */ }
          }
        }
        continue;
      }
      // A batch superseded/sent by a concurrent tick (or the firm) raises
      // ASK_BATCH_NOT_DRAFT (409): that's the idempotent no-op, not a failure.
      if (error?.code === 'ASK_BATCH_NOT_DRAFT') { stats.idempotent += 1; continue; }
      try { console.warn(`[${LOG_TAG}] batch ${row.id} send failed: ${error?.message || error}`); }
      catch { /* never throw from the logger */ }
      stats.failed += 1;
    }
  }

  return stats;
};
