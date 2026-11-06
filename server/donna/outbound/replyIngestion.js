// reply_if_wrong v2 — email-reply ingestion (the named D1 v2 follow-up;
// the DB/network half — vocabulary and builders live in
// replyIngestionCore.js).
//
// TWO halves, one posture:
//
//   WEBHOOK (ingestOutboundReplyEvent, mounted by outboundRoutes.js):
//   deterministic, no LLM. Accepts Resend email.received events for the
//   lane's inbound address, attributes the reply to exactly one
//   (firm, client) — digest-thread match on
//   outbound_digests.provider_message_id first, else a UNIQUE owner-email
//   match across clients — and stores it. Unattributed mail is acked and
//   never stored (no guessed binding). Storage is flag-blind on purpose:
//   mail only reaches the inbound address because a digest carried it as
//   reply-to (which the lane's flag gated at send time), and a stored row
//   under a since-darkened flag simply rests until the flag returns —
//   never dropped. An optional human-mailbox forward
//   (OUTBOUND_REPLY_FORWARD_TO) copies every stored reply out, so
//   ingestion is additive to today's mail flow, never subtractive. The
//   webhook also computes the sender-auth verdict (DMARC/SPF/DKIM from the
//   receiving MTA's Authentication-Results stamp — the v2 hardening) for
//   its receipt and the forwarded copy's warning line; storage still
//   happens whatever the verdict (additive), enforcement lives in the
//   sweep.
//
//   SWEEP (processOwnerReplies, riding the hourly outbound cron): the LLM
//   surface, at extraction trust level — the reply body is untrusted DATA
//   (UNTRUSTED_CONTENT_PROMPT_GUARD pinned; strict structured outputs; the
//   Keep layer discards any action id outside the gathered candidate set,
//   and an affirmative dmarc=fail sender-auth verdict terminates the row
//   receipted BEFORE the classifier ever runs — spoof-flagged mail never
//   marks and never surfaces to the owner).
//   A confident "this send was wrong" routes THROUGH
//   markOwnerAutoSentWrong → markExecutedOutboundActionWrong (the D1
//   recorder lives INSIDE that writer — no surface can skip it), actor
//   'owner' via the email channel. Everything un-actable terminates
//   honestly: no_action with the persisted verdict as receipt, or
//   needs_owner — surfaced once in the next owner digest and on the
//   workspace Actions tab. Shadow classifies and receipts would-mark
//   counts with ZERO marking and ZERO owner-visible surface.
//
// Candidate set = THE digest gather's auto-sent window
// (gatherOwnerDigest includeNotifiedAutoSent — one gather, one phrasing
// home, never a parallel query). Model convention: strong model by
// default (the marketing-drafter/askPipeline shape), OPENAI_MODEL as the
// override knob; the provider-RETURNED model id persists on the row (the
// model id is part of the receipt).

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { queryFirmDb } from '../firmDb.js';
import { readClientConfigSnapshot } from '../clientConfig.js';
import { getReceivedEmail, sendEmail } from '../email/resendClient.js';
import {
  MAX_CLASSIFY_ATTEMPTS,
  REPLY_CLASSIFIER_SCHEMA_NAME,
  buildReplyClassifierInput,
  buildReplyClassifierInstructions,
  buildReplyClassifierSchema,
  constrainVerdictToCandidates,
  extractMessageIdCandidates,
  headerValueFrom,
  outboundReplyForwardTo,
  outboundReplyInboundAddress,
  parseSenderAuthVerdict,
  resolveReplyIngestionLane,
  senderAuthBlocksAction
} from './replyIngestionCore.js';
import { describePendingAction, gatherOwnerDigest } from './ownerDigest.js';
import { markOwnerAutoSentWrong } from './ownerActionsSurface.js';
import { gateRoleSurfaceOperation } from '../roles/roleAuthority.js';

const SWEEP_LIMIT = 20;

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

// ── Model config (strong by default; OPENAI_MODEL the override knob) ─────────

const DEFAULT_MODEL = 'gpt-5.4';

let dotEnvCache = null;
const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Best-effort dotenv fallback for local development.
  }
  dotEnvCache = vars;
  return vars;
};

const getOpenAiConfig = () => {
  const dotEnv = readDotEnv();
  return {
    apiKey: process.env.OPENAI_API_KEY || dotEnv.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || dotEnv.OPENAI_MODEL || DEFAULT_MODEL
  };
};

export const isReplyClassifierConfigured = () => Boolean(getOpenAiConfig().apiKey);

const outputTextFromResponse = (payload) => {
  if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
};

// One reply → one strict-schema verdict. Returns { verdict, model } with the
// RAW model verdict — the caller applies constrainVerdictToCandidates (the
// Keep layer stays visible at the call site). Throws on transport/parse
// failure; the sweep counts attempts and fails toward the owner.
export const classifyOwnerReply = async ({
  reply, candidates = [], fetchImpl = fetch, openAiConfig = null
} = {}) => {
  const config = openAiConfig || getOpenAiConfig();
  if (!config.apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      instructions: buildReplyClassifierInstructions(),
      input: buildReplyClassifierInput({ reply, candidates }),
      text: {
        format: {
          type: 'json_schema',
          name: REPLY_CLASSIFIER_SCHEMA_NAME,
          strict: true,
          schema: buildReplyClassifierSchema()
        }
      }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI returned ${response.status}`);
  }
  const verdict = JSON.parse(outputTextFromResponse(payload));
  return { verdict, model: payload.model || config.model };
};

// ── Webhook half (deterministic; no LLM) ─────────────────────────────────────

const extractAddress = (value) => {
  const raw = typeof value === 'string' ? value : value?.email || '';
  const angled = raw.match(/<([^>]+)>/);
  return String(angled ? angled[1] : raw).trim().toLowerCase() || null;
};

// Attribution: digest thread first (deterministic — works for multi-venture
// owners), else a UNIQUE owner-email match. Zero or ambiguous ⇒ null (the
// caller acks without storing; never a guessed binding).
const attributeReply = async ({ query, fromAddr, inReplyTo }) => {
  const threadIds = extractMessageIdCandidates(inReplyTo);
  if (threadIds.length) {
    const result = await query(
      `select firm_id, client_id from outbound_digests
        where provider_message_id = any($1::text[])
        order by sent_at desc limit 1`,
      [threadIds]
    ).catch((error) => {
      if (missingTables(error)) return { rows: [] };
      throw error;
    });
    const row = result.rows?.[0];
    if (row) return { firmId: row.firm_id, clientId: row.client_id, matchedVia: 'digest_thread' };
  }
  if (!fromAddr) return null;
  const result = await query(
    `select firm_id, id from clients
      where lower(trim(coalesce(profile->>'email', ''))) = $1
         or lower(trim(coalesce(profile->>'contact_email', ''))) = $1
         or lower(trim(coalesce(profile->>'owner_email', ''))) = $1
      limit 3`,
    [fromAddr]
  );
  const rows = result.rows || [];
  if (rows.length !== 1) return null;
  return { firmId: rows[0].firm_id, clientId: rows[0].id, matchedVia: 'owner_email' };
};

// Ingest one Resend email.received event. Returns { retriable, body } (the
// marketing inbound webhook's contract: non-2xx makes Svix redeliver, and the
// dedupe index makes redelivery of a handled event a receipted no-op).
export const ingestOutboundReplyEvent = async ({ event, eventType, deps = {} } = {}) => {
  const query = deps.query || queryFirmDb;
  const getEmail = deps.getEmail || getReceivedEmail;
  const send = deps.send || sendEmail;
  const env = deps.env || process.env;

  const inboundAddress = outboundReplyInboundAddress(env).toLowerCase();
  if (!inboundAddress) {
    // No inbound address deployed ⇒ no digest ever pointed replies here ⇒
    // whatever arrived is not this lane's mail.
    return { retriable: false, body: { ok: true, ignored: 'inbound_address_unconfigured' } };
  }

  const data = event?.data || {};
  const providerEmailId = data.email_id || data.id || null;
  const fromAddr = extractAddress(data.from);
  const recipients = (Array.isArray(data.to) ? data.to : [data.to])
    .filter(Boolean).map(extractAddress).filter(Boolean);
  if (!recipients.includes(inboundAddress)) {
    // Another lane's mail on a shared inbound stream (e.g. marketing) — ack,
    // never ingest.
    return { retriable: false, body: { ok: true, ignored: 'not_for_this_lane' } };
  }

  const retrieved = await getEmail(providerEmailId);
  if (!retrieved.ok) {
    return {
      retriable: true,
      body: { code: 'RETRIEVAL_FAILED', error: retrieved.error || retrieved.reason || 'body retrieval failed' }
    };
  }
  const email = retrieved.email || {};
  const headers = email.headers ?? null;
  const inReplyTo = headerValueFrom(headers, 'in-reply-to');
  // Sender-auth verdict from the receiving MTA's Authentication-Results
  // stamp (the v2 hardening). Computed HERE so the webhook receipt and the
  // forwarded human copy carry it; the sweep re-derives the same verdict
  // from the persisted headers with the same parser — one rule, one home.
  const senderAuth = parseSenderAuthVerdict(headers);

  const match = await attributeReply({ query, fromAddr, inReplyTo });
  if (!match) {
    // Zero or ambiguous binding: ack without storing — the mail keeps
    // resting in today's mailbox flow, never under a guessed client.
    return { retriable: false, body: { ok: true, ignored: 'unattributed' } };
  }

  const inserted = await query(
    `insert into outbound_owner_replies
       (id, firm_id, client_id, provider, event_type, provider_email_id, from_email,
        to_email, subject, text_body, html_body, headers, message_id, in_reply_to,
        references_header, matched_via, raw_payload, received_at)
     values ($1, $2, $3, 'resend', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
             $14, $15, $16::jsonb, $17)
     on conflict do nothing
     returning id`,
    [randomUUID(), match.firmId, match.clientId, eventType, providerEmailId, fromAddr,
      recipients[0] || null, data.subject || null, email.text ?? null, email.html ?? null,
      headers ? JSON.stringify(headers) : null,
      headerValueFrom(headers, 'message-id'), inReplyTo,
      headerValueFrom(headers, 'references'),
      match.matchedVia, JSON.stringify(event ?? {}), event?.created_at || null]
  ).catch((error) => {
    if (missingTables(error)) return { rows: [], skipped: true };
    throw error;
  });
  if (inserted.skipped) {
    return { retriable: false, body: { ok: true, ignored: 'tables_absent' } };
  }
  const insertedId = inserted.rows?.[0]?.id || null;
  if (!insertedId) return { retriable: false, body: { ok: true, duplicate: true } };

  // Optional human-mailbox backstop — best-effort, stamped on the row.
  const forwardTo = outboundReplyForwardTo(env);
  if (forwardTo) {
    const fwd = await send({
      to: forwardTo,
      subject: `[Donna owner reply] ${data.subject || '(no subject)'}`,
      text: [
        `Owner reply ingested for client ${match.clientId} (via ${match.matchedVia}).`,
        `From: ${fromAddr || 'unknown'}`,
        `Sender auth: dmarc=${senderAuth.dmarc} spf=${senderAuth.spf} dkim=${senderAuth.dkim}`,
        ...(senderAuthBlocksAction(senderAuth)
          ? ['WARNING: sender authentication FAILED (dmarc=fail) — likely spoofed; the sweep will not act on this reply.']
          : []),
        '',
        String(email.text ?? '(no text body retrieved)').slice(0, 5000)
      ].join('\n')
    });
    if (fwd.ok) {
      await query(
        `update outbound_owner_replies
            set forwarded_to = $2, forwarded_at = now(), updated_at = now()
          where id = $1`,
        [insertedId, forwardTo]
      ).catch(() => { /* best-effort stamp */ });
    }
  }

  return {
    retriable: false,
    body: { ok: true, id: insertedId, matched_via: match.matchedVia, sender_auth: senderAuth }
  };
};

// ── Sweep half (the LLM surface; rides the hourly outbound cron) ─────────────

export const processOwnerReplies = async ({
  client, firmId, clientId, env = process.env, snapshot = null,
  classifier = null, markWrong = markOwnerAutoSentWrong,
  limit = SWEEP_LIMIT, logger = console
} = {}) => {
  const stats = {
    skipped: false, scanned: 0, marked_wrong: 0, already_marked: 0,
    no_action: 0, needs_owner: 0, shadow_would_mark: 0, auth_failed: 0, errors: 0
  };
  if (!client || !firmId || !clientId) return { ...stats, skipped: true, reason: 'missing_args' };

  const snap = snapshot || await readClientConfigSnapshot(client, { firmId, clientId });
  const lane = resolveReplyIngestionLane({ snapshot: snap, env });
  if (!lane.acts && !lane.observes) return { ...stats, skipped: true, reason: 'flag_off' };

  // S1 role leash (INV-S2): recording D1 corrections off owner replies is
  // the invoicing_collections role's audited surface operation
  // (conservative-direction — it only ever demotes automation).
  const roleGate = await gateRoleSurfaceOperation({
    actionType: 'record_reply_correction', snapshot: snap, env, seam: 'outbound_sweep',
    firmId, clientId, logger, query: (sql, params) => client.query(sql, params)
  });
  if (!roleGate.proceed) return { ...stats, skipped: true, reason: 'role_leash_denied' };
  const classify = classifier
    || (({ reply, candidates }) => classifyOwnerReply({ reply, candidates }));
  if (!classifier && !isReplyClassifierConfigured()) {
    // Rows rest 'stored' (no attempts burned) until the key exists — an
    // unconfigured model must never march every reply to needs_owner.
    return { ...stats, skipped: true, reason: 'llm_unconfigured' };
  }

  const bounded = Math.min(Math.max(Number(limit) || SWEEP_LIMIT, 1), 100);
  let rows;
  try {
    rows = await client.query(
      `select id, subject, text_body, from_email, headers, attempts
         from outbound_owner_replies
        where firm_id = $1 and client_id = $2 and status = 'stored'
        order by created_at asc
        limit $3`,
      [firmId, clientId, bounded]
    ).then((r) => r.rows);
  } catch (error) {
    if (missingTables(error)) return { ...stats, skipped: true, reason: 'tables_absent' };
    throw error;
  }
  stats.scanned = rows.length;
  if (!rows.length) return stats;

  // THE candidate set: the digest gather's auto-sent window (one gather,
  // one phrasing home — the G15 rail).
  const digest = await gatherOwnerDigest(client, {
    firmId, clientId, includeNotifiedAutoSent: true
  });
  const candidates = (digest.autoSent || []).map((action) => ({
    id: String(action.id),
    description: describePendingAction(action),
    sent_at: action.receipt_created_at || null
  }));

  const processedIds = [];
  for (const row of rows) {
    try {
      // Sender-auth gate (the v2 hardening) — deterministic, BEFORE the LLM:
      // an affirmative dmarc=fail terminates receipted no_action in every
      // lane. The reply never reaches the classifier, never marks, and never
      // surfaces to the owner (a spoofer must not be able to inject digest
      // lines) — but it is never silent either: the verdict IS the receipt,
      // and the webhook's forwarded human copy carried the warning. Absence
      // of a verdict (pre-hardening rows, an AR-less provider) never blocks.
      const senderAuth = parseSenderAuthVerdict(row.headers);
      if (senderAuthBlocksAction(senderAuth)) {
        await client.query(
          `update outbound_owner_replies
              set status = 'no_action', classification = $4::jsonb,
                  classified_at = now(), updated_at = now()
            where id = $1 and firm_id = $2 and client_id = $3`,
          [row.id, firmId, clientId,
            JSON.stringify({ outcome: 'sender_auth_failed', sender_auth: senderAuth })]
        );
        stats.auth_failed += 1;
        stats.no_action += 1;
        processedIds.push(row.id);
        continue;
      }

      let verdict;
      let model = null;
      try {
        const result = await classify({ reply: row, candidates });
        verdict = constrainVerdictToCandidates(result?.verdict, candidates);
        model = result?.model || null;
      } catch (error) {
        const attempts = (Number(row.attempts) || 0) + 1;
        const exhausted = attempts >= MAX_CLASSIFY_ATTEMPTS;
        // Exhausted classification fails TOWARD the owner (acting lane) —
        // never a silent poison-row loop; shadow terminates quietly.
        const status = exhausted ? (lane.acts ? 'needs_owner' : 'no_action') : 'stored';
        await client.query(
          `update outbound_owner_replies
              set attempts = $4, status = $5,
                  classification = case when $6 then $7::jsonb else classification end,
                  classified_at = case when $6 then now() else classified_at end,
                  updated_at = now()
            where id = $1 and firm_id = $2 and client_id = $3`,
          [row.id, firmId, clientId, attempts, status, exhausted,
            JSON.stringify({
              error: String(error?.message || error).slice(0, 300),
              sender_auth: senderAuth
            })]
        );
        if (exhausted) {
          if (lane.acts) stats.needs_owner += 1;
          else stats.no_action += 1;
          processedIds.push(row.id);
        }
        stats.errors += 1;
        continue;
      }

      let status = 'no_action';
      let markedActionId = null;
      // The sender-auth verdict rides every classification receipt — the
      // model id is part of the receipt, and so is the auth verdict now.
      const classification = { ...verdict, sender_auth: senderAuth, ...(model ? { model } : {}) };
      if (verdict.intent === 'send_was_wrong' && verdict.action_id) {
        if (lane.acts) {
          const marked = await markWrong(client, {
            firmId, clientId, actionId: verdict.action_id,
            actorType: 'owner', actorId: row.from_email, channel: 'email_reply'
          });
          if (marked.marked) {
            status = 'marked_wrong';
            markedActionId = verdict.action_id;
          } else if (marked.already === 'marked') {
            status = 'already_marked';
            markedActionId = verdict.action_id;
          } else {
            status = 'no_action';
            classification.outcome = `target_${marked.already || 'unavailable'}`;
          }
        } else {
          classification.shadow_would_mark = true;
          stats.shadow_would_mark += 1;
        }
      } else if (verdict.intent !== 'acknowledgement_or_other') {
        // A wrong-claim without one confident target, or a question Donna
        // cannot act on by email: rests ON THE OWNER (digest line + the
        // workspace Actions tab). Shadow keeps zero owner-visible surface.
        if (lane.acts) status = 'needs_owner';
      }

      await client.query(
        `update outbound_owner_replies
            set status = $4, classification = $5::jsonb, classified_at = now(),
                marked_action_id = $6, attempts = attempts + 1, updated_at = now()
          where id = $1 and firm_id = $2 and client_id = $3`,
        [row.id, firmId, clientId, status, JSON.stringify(classification), markedActionId]
      );
      if (status === 'marked_wrong') stats.marked_wrong += 1;
      else if (status === 'already_marked') stats.already_marked += 1;
      else if (status === 'needs_owner') stats.needs_owner += 1;
      else stats.no_action += 1;
      processedIds.push(row.id);
    } catch (error) {
      try {
        logger.warn?.(`[replyIngestion] reply ${row.id} failed: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }

  // Nothing silent: one aggregate receipt per sweep that classified anything.
  if (processedIds.length || stats.shadow_would_mark) {
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'client', $2, $4::jsonb)`,
        [firmId, clientId,
          lane.acts ? 'outbound.owner_reply_ingestion' : 'outbound.owner_reply_ingestion_would_act',
          JSON.stringify({
            scanned: stats.scanned, marked_wrong: stats.marked_wrong,
            already_marked: stats.already_marked, no_action: stats.no_action,
            needs_owner: stats.needs_owner, shadow_would_mark: stats.shadow_would_mark,
            auth_failed: stats.auth_failed, errors: stats.errors, reply_ids: processedIds
          })]
      );
    } catch { /* best-effort receipt */ }
  }
  return stats;
};
