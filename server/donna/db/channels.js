// server/donna/db/channels.js — plane S delivery state — WhatsApp / SMS / Telegram bindings, inbound claims, the delivery ledger, owner-media summaries and the per-channel ask deliveries.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { resolveAssistantName } from '../assistantIdentity.js';
import { clientFlagActs, configSnapshotId, readClientConfigSnapshot } from '../clientConfig.js';
import { hashPhoneE164, normalizePhoneE164, shortAskRef, whatsappBindingId, whatsappEnvAllowsClient } from '../channels/whatsappWebhookCore.js';
import { prepareOwnerAskQuestion } from '../channels/askSafety.js';
import { askAffordances, renderAskAffordanceTail } from '../askIdentity.js';
// Sensitive-ask portal fallback (self-knowledge slice 3): the blocked-ask
// notice copy + the OWNER_PORTAL_LINK gate + the deterministic deep link all
// live in selfKnowledge.js (the Keep layer's single home for owner portal-link
// delivery). selfKnowledge.js is a leaf module (registry + config + identity
// imports only), so this import cannot cycle back into firmDb.
import { OWNER_PORTAL_LINK_FLAG_KEY, recordOwnerPortalLinkShare, resolveOwnerPortalLink, SENSITIVE_ASK_NOTICE_TEMPLATE, SENSITIVE_ASK_NOTICE_VERSION, SENSITIVE_ASK_WA_ITEM_PARAM, SENSITIVE_ASK_WA_TEMPLATE, sensitiveAskPortalNoticeText } from '../selfKnowledge.js';
import { smsEnvAllowsClient } from '../channels/sms.js';
import { buildTelegramAskDigestText, TELEGRAM_ASK_DIGEST_TEMPLATE, telegramEnvAllowsClient } from '../channels/telegram.js';
import { OWNER_TEMPLATE_FALLBACK_LANGUAGE, preferredOwnerTemplateLanguage } from '../ownerLanguage.js';

import { senderWithDisplayName } from '../email/resendClient.js';
import { withFirmDbClient } from './pool.js';
import { DEFAULT_FIRM_ID } from './clients.js';

// ── WhatsApp owner-channel binding + delivery receipts (slice 1) ───────────
export const __mintWhatsAppBindTokenWithClient = async ({
  client, firmId = DEFAULT_FIRM_ID, clientId, collaboratorId = null, actorId, tokenHash, expiresAt
} = {}) => {
  if (!client || !clientId || !actorId || !tokenHash || !expiresAt) {
    const error = new Error('client, clientId, actorId, tokenHash, and expiresAt are required.');
    error.statusCode = 400;
    throw error;
  }
  const result = await client.query(
    `insert into client_whatsapp_bind_tokens (token_hash, firm_id, client_id, collaborator_id, created_by, expires_at)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [tokenHash, firmId, clientId, collaboratorId, actorId, expiresAt]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'whatsapp.bind_token.created', 'client_whatsapp_bind_token', $4, $5::jsonb)`,
    [firmId, clientId, actorId, tokenHash, JSON.stringify({ collaborator_id: collaboratorId, expires_at: expiresAt })]
  );
  return result.rows[0];
};

export const mintWhatsAppBindTokenInDb = async (args = {}) =>
  withFirmDbClient((client) => __mintWhatsAppBindTokenWithClient({ client, ...args }));

// A single binding table backs all owner channels via the `channel`
// discriminator (migration 059 added it; 088 admits 'telegram'). WhatsApp and
// SMS keep their exact prior behaviour; 'telegram' gets its own binding-id
// prefix and writes the chat_id into a dedicated profile slot (never the
// phone_e164 slot — a Telegram chat_id is not a phone number). For Telegram,
// phoneE164 carries the chat_id string (hashed with the SAME hashPhoneE164 the
// inbound anchor uses, so both sides agree).
export const __redeemWhatsAppBindTokenWithClient = async ({ client, tokenHash, phoneE164, actorId = 'whatsapp:webhook', channel = 'whatsapp' } = {}) => {
  const phone = normalizePhoneE164(phoneE164);
  if (!client || !tokenHash || !phone) {
    const error = new Error('client, tokenHash, and phoneE164 are required.');
    error.statusCode = 400;
    throw error;
  }
  await client.query('begin');
  try {
    const tokenResult = await client.query(
      `select * from client_whatsapp_bind_tokens where token_hash = $1 for update`,
      [tokenHash]
    );
    const token = tokenResult.rows[0];
    if (!token || token.redeemed_at || token.revoked_at || new Date(token.expires_at).getTime() < Date.now()) {
      const error = new Error('WhatsApp binding token is invalid or expired.');
      error.statusCode = 409;
      error.code = 'WHATSAPP_BIND_TOKEN_INVALID';
      throw error;
    }
    const phoneHash = hashPhoneE164(phone);
    const baseBindingId = whatsappBindingId({ firmId: token.firm_id, clientId: token.client_id, collaboratorId: token.collaborator_id, phoneHash });
    const idPrefix = channel === 'sms' ? 'smsb_' : channel === 'telegram' ? 'tgb_' : 'wab_';
    const id = baseBindingId.replace(/^wab_/, idPrefix);
    const bindingResult = await client.query(
      `insert into client_whatsapp_bindings (id, firm_id, client_id, collaborator_id, phone_e164, phone_hash, verified_set_by, opted_in_set_by, channel)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $8)
       on conflict (firm_id, client_id, collaborator_id, phone_hash, channel)
       do update set revoked_at = null, revoked_by = null, verified_at = now(), opted_in_at = now(), updated_at = now(), verified_set_by = excluded.verified_set_by, opted_in_set_by = excluded.opted_in_set_by
       returning *`,
      [id, token.firm_id, token.client_id, token.collaborator_id, phone, phoneHash, token.created_by, channel]
    );
    await client.query(
      `update client_whatsapp_bind_tokens set redeemed_at = now(), redeemed_phone_e164 = $2 where token_hash = $1`,
      [tokenHash, phone]
    );
    if (channel === 'telegram') {
      // Telegram identity lives under its own profile slot — the chat_id is not
      // a phone number and must not land in the phone_e164 field.
      await client.query(
        `update clients set profile = jsonb_set(jsonb_set(coalesce(profile, '{}'::jsonb), '{telegram,chat_id}', to_jsonb($3::text), true), '{telegram,verified_set_by}', to_jsonb($4::text), true), updated_at = now()
         where firm_id = $1 and id = $2`,
        [token.firm_id, token.client_id, phone, token.created_by]
      );
    } else {
      await client.query(
        `update clients set profile = jsonb_set(jsonb_set(coalesce(profile, '{}'::jsonb), '{whatsapp,phone_e164}', to_jsonb($3::text), true), '{whatsapp,verified_set_by}', to_jsonb($4::text), true), updated_at = now()
         where firm_id = $1 and id = $2`,
        [token.firm_id, token.client_id, phone, token.created_by]
      );
    }
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'client', $3, 'whatsapp.binding.verified', 'client_whatsapp_binding', $4, $5::jsonb)`,
      [token.firm_id, token.client_id, actorId, bindingResult.rows[0].id, JSON.stringify({ collaborator_id: token.collaborator_id, phone_hash: phoneHash, channel })]
    );
    await client.query('commit');
    return bindingResult.rows[0];
  } catch (error) { await client.query('rollback'); throw error; }
};

export const redeemWhatsAppBindTokenInDb = async (args = {}) =>
  withFirmDbClient((client) => __redeemWhatsAppBindTokenWithClient({ client, ...args }));

export const __revokeWhatsAppBindingWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId, bindingId, actorId } = {}) => {
  if (!client) {
    const error = new Error('client is required.');
    error.statusCode = 400;
    throw error;
  }
  const result = await client.query(
    `update client_whatsapp_bindings set revoked_at = now(), revoked_by = $4, updated_at = now()
     where firm_id = $1 and client_id = $2 and id = $3 and revoked_at is null returning *`,
    [firmId, clientId, bindingId, actorId]
  );
  if (result.rows[0]) {
    await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
      values ($1, $2, 'client', $3, 'whatsapp.binding.revoked', 'client_whatsapp_binding', $4, '{}'::jsonb)`, [firmId, clientId, actorId, bindingId]);
  }
  return result.rows[0] || null;
};

export const revokeWhatsAppBindingInDb = async (args = {}) =>
  withFirmDbClient((client) => __revokeWhatsAppBindingWithClient({ client, ...args }));

export const __getActiveWhatsAppBindingForClientWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  const result = await client.query(
    `select * from client_whatsapp_bindings where firm_id = $1 and client_id = $2 and coalesce(channel, 'whatsapp') = 'whatsapp' and revoked_at is null order by verified_at desc limit 1`,
    [firmId, clientId]
  );
  return result.rows[0] || null;
};

export const getActiveWhatsAppBindingForClientInDb = async ({ client = null, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (client) return __getActiveWhatsAppBindingForClientWithClient({ client, firmId, clientId });
  return withFirmDbClient((dbClient) => __getActiveWhatsAppBindingForClientWithClient({ client: dbClient, firmId, clientId }));
};

export const __getActiveWhatsAppBindingsByPhoneHashWithClient = async ({ client, phoneHash } = {}) => {
  const result = await client.query(
    `select * from client_whatsapp_bindings where phone_hash = $1 and coalesce(channel, 'whatsapp') = 'whatsapp' and revoked_at is null order by verified_at desc limit 20`, [phoneHash]
  );
  return result.rows;
};

export const getActiveWhatsAppBindingsByPhoneHashInDb = async ({ phoneHash } = {}) =>
  withFirmDbClient((client) => __getActiveWhatsAppBindingsByPhoneHashWithClient({ client, phoneHash }));

export const __getActiveSmsBindingForClientWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  const result = await client.query(
    `select * from client_whatsapp_bindings where firm_id = $1 and client_id = $2 and coalesce(channel, 'whatsapp') = 'sms' and revoked_at is null order by verified_at desc limit 1`,
    [firmId, clientId]
  );
  return result.rows[0] || null;
};

export const getActiveSmsBindingForClientInDb = async ({ client = null, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (client) return __getActiveSmsBindingForClientWithClient({ client, firmId, clientId });
  return withFirmDbClient((dbClient) => __getActiveSmsBindingForClientWithClient({ client: dbClient, firmId, clientId }));
};

export const __getActiveSmsBindingsByPhoneHashWithClient = async ({ client, phoneHash } = {}) => {
  const result = await client.query(
    `select * from client_whatsapp_bindings where phone_hash = $1 and coalesce(channel, 'whatsapp') = 'sms' and revoked_at is null order by verified_at desc limit 20`, [phoneHash]
  );
  return result.rows;
};

export const getActiveSmsBindingsByPhoneHashInDb = async ({ phoneHash } = {}) =>
  withFirmDbClient((client) => __getActiveSmsBindingsByPhoneHashWithClient({ client, phoneHash }));

// Telegram bindings share the client_whatsapp_bindings table via channel =
// 'telegram' (migration 088). Same shape as the WhatsApp/SMS readers; phone_e164
// carries the chat_id string and phone_hash = hashPhoneE164(chat_id).
export const __getActiveTelegramBindingForClientWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  const result = await client.query(
    `select * from client_whatsapp_bindings where firm_id = $1 and client_id = $2 and coalesce(channel, 'whatsapp') = 'telegram' and revoked_at is null order by verified_at desc limit 1`,
    [firmId, clientId]
  );
  return result.rows[0] || null;
};

export const getActiveTelegramBindingForClientInDb = async ({ client = null, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (client) return __getActiveTelegramBindingForClientWithClient({ client, firmId, clientId });
  return withFirmDbClient((dbClient) => __getActiveTelegramBindingForClientWithClient({ client: dbClient, firmId, clientId }));
};

export const __getActiveTelegramBindingsByPhoneHashWithClient = async ({ client, phoneHash } = {}) => {
  const result = await client.query(
    `select * from client_whatsapp_bindings where phone_hash = $1 and coalesce(channel, 'whatsapp') = 'telegram' and revoked_at is null order by verified_at desc limit 20`, [phoneHash]
  );
  return result.rows;
};

export const getActiveTelegramBindingsByPhoneHashInDb = async ({ phoneHash } = {}) =>
  withFirmDbClient((client) => __getActiveTelegramBindingsByPhoneHashWithClient({ client, phoneHash }));

// Reader for the owner-media post-parse summary (channels/ownerMediaParseSummary.js):
// the persisted parse verdict plus the owner-initiated markers, nothing else. The
// summary RENDERS this row — it never re-infers (render-the-persisted-verdict rail).
export const getOwnerMediaDocForSummaryInDb = async ({ firmId = DEFAULT_FIRM_ID, documentId } = {}) => {
  if (!documentId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select id, client_id, document_type, filename, vendor_name, document_date,
              currency, total_amount, parse_status, parse_summary, payload, uploaded_at
         from documents
        where firm_id = $1 and id = $2
        limit 1`,
      [firmId, documentId]
    );
    return result.rows[0] || null;
  });
};

// Exactly-once claim for the owner-media summary send: the parse worker's legs
// retry (Inngest re-runs a failed leg), and a proactive outbound must not
// double-send. Same conflict-key discipline as the inbound telegram claim.
export const claimOwnerMediaSummarySendInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId = null, documentId, phoneHash = null } = {}) => {
  const cleanDocId = String(documentId || '').trim();
  if (!cleanDocId) return { claimed: false, reason: 'missing_document_id' };
  const messageId = `tg_summary_${cleanDocId}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `insert into message_delivery_ledger (id, message_id, channel, provider, client_id, recipient_phone_hash, provider_payload)
       values ($1, $2, 'telegram', 'telegram', $3, $4, $5::jsonb)
       on conflict (provider, message_id) do nothing
       returning id`,
      [`mdl_telegram_${messageId}`, messageId, clientId, phoneHash, JSON.stringify({ kind: 'owner_media_parse_summary', document_id: cleanDocId })]
    );
    return { claimed: Boolean(result.rows[0]), message_id: messageId };
  });
};

// Gather for the terminal-summary sweep (F-2, docs/donna-telegram-receipt-
// silence-diagnostic.md §7): owner-initiated Telegram documents whose parse
// landed in a terminal state the worker's post-parse legs never speak for —
// `failed` (the leg planner only fires legs on completed parses, and the
// cron STUCK flip happens outside the worker entirely) and `duplicate_pending`
// (a byte-dup placeholder never fires a parse at all; the inline reply at
// registration normally covers it, this sweep is the missed-send net).
// The not-exists mirrors claimOwnerMediaSummarySendInDb's message-id shape, so
// a doc whose summary already sent (or whose claim burned on a send failure)
// is excluded; the send path re-claims regardless, so this filter is an
// optimization, never the exactly-once guarantee. The lookback bounds the
// sweep AND permanently excludes pre-feature history: a doc that failed
// before the window opened is never messaged about retroactively.
export const listOwnerMediaDocsNeedingTerminalSummaryInDb = async ({ firmId = DEFAULT_FIRM_ID, lookbackHours = 48, limit = 20 } = {}) => {
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select d.id, d.client_id, d.parse_status
         from documents d
        where d.firm_id = $1
          and d.parse_status in ('failed', 'duplicate_pending')
          and d.created_at > now() - make_interval(hours => $2::int)
          and (
            d.payload->>'owner_initiated' = 'true'
            or d.payload->'payload'->>'owner_initiated' = 'true'
          )
          and lower(coalesce(
                d.payload->>'channel', d.payload->>'source',
                d.payload->'payload'->>'channel', d.payload->'payload'->>'source',
                ''
              )) = 'telegram'
          and not exists (
            select 1 from message_delivery_ledger mdl
             where mdl.provider = 'telegram'
               and mdl.message_id = 'tg_summary_' || d.id
          )
        order by d.created_at asc
        limit $3`,
      [firmId, lookbackHours, limit]
    );
    return result.rows;
  });
};

// Group-level exactly-once claim for Telegram albums (multi-file sends).
// An album arrives as N separate webhook updates sharing media_group_id;
// without a group claim each member acked and summarized on its own (the
// 2026-07-21 "silly repetition" report). kind 'ack' gates the single
// upload ack (first member to claim speaks); kind 'summary' gates the one
// combined post-parse summary. Same conflict-key discipline as the
// per-document claim above; clientId is part of the key so group ids
// can never collide across chats.
export const claimOwnerMediaGroupSendInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId = null, mediaGroupId, kind = 'summary', phoneHash = null } = {}) => {
  const cleanGroup = String(mediaGroupId || '').trim();
  const cleanKind = kind === 'ack' ? 'ack' : 'summary';
  if (!cleanGroup) return { claimed: false, reason: 'missing_media_group_id' };
  const messageId = `tg_group_${cleanKind}_${clientId || 'unknown'}_${cleanGroup}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `insert into message_delivery_ledger (id, message_id, channel, provider, client_id, recipient_phone_hash, provider_payload)
       values ($1, $2, 'telegram', 'telegram', $3, $4, $5::jsonb)
       on conflict (provider, message_id) do nothing
       returning id`,
      [`mdl_telegram_${messageId}`, messageId, clientId, phoneHash, JSON.stringify({ kind: `owner_media_group_${cleanKind}`, media_group_id: cleanGroup })]
    );
    return { claimed: Boolean(result.rows[0]), message_id: messageId };
  });
};

// All owner-media documents registered from one Telegram album. The
// registrar persists media_group_id inside the payload; both the flat and
// the nested persisted shapes are accepted (same reader discipline as the
// owner-media summary markers).
export const listOwnerMediaGroupDocsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, mediaGroupId } = {}) => {
  const cleanGroup = String(mediaGroupId || '').trim();
  if (!clientId || !cleanGroup) return [];
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select id, client_id, filename, vendor_name, document_date, currency, total_amount,
              parse_status, parse_summary, uploaded_at
         from documents
        where firm_id = $1 and client_id = $2
          and coalesce(payload->>'media_group_id', payload->'payload'->>'media_group_id') = $3
          and (payload->>'owner_initiated' = 'true' or payload->'payload'->>'owner_initiated' = 'true')
        order by uploaded_at asc, id asc`,
      [firmId, clientId, cleanGroup]
    );
    return result.rows;
  });
};

// Which of these documents already have their per-document summary claim
// taken (an inline duplicate reply, an earlier single send). The combined
// group summary excludes them so nothing is said twice.
export const listOwnerMediaSummaryClaimedDocIdsInDb = async ({ documentIds = [] } = {}) => {
  const ids = documentIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return [];
  const messageIds = ids.map((id) => `tg_summary_${id}`.replace(/[^a-zA-Z0-9_:-]/g, '_'));
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select message_id from message_delivery_ledger
        where provider = 'telegram' and message_id = any($1::text[])`,
      [messageIds]
    );
    const taken = new Set(result.rows.map((row) => row.message_id));
    return ids.filter((id, index) => taken.has(messageIds[index]));
  });
};

export const __getWhatsAppDeliveryByMessageIdWithClient = async ({ client, messageId } = {}) => {
  if (!client || !messageId) return null;
  const result = await client.query(
    `select * from message_delivery_ledger
      where provider = 'meta' and message_id = $1
      limit 1`,
    [messageId]
  );
  return result.rows[0] || null;
};

export const getWhatsAppDeliveryByMessageIdInDb = async ({ client = null, messageId } = {}) => {
  if (client) return __getWhatsAppDeliveryByMessageIdWithClient({ client, messageId });
  return withFirmDbClient((dbClient) => __getWhatsAppDeliveryByMessageIdWithClient({ client: dbClient, messageId }));
};

// Telegram tapped-reply anchoring: the inbound reply_to_message.message_id maps
// to the outbound ask's message_id, recorded here by deliverTelegramEvidenceAsksAfterSend.
export const __getTelegramDeliveryByMessageIdWithClient = async ({ client, messageId } = {}) => {
  if (!client || !messageId) return null;
  const result = await client.query(
    `select * from message_delivery_ledger
      where provider = 'telegram' and message_id = $1
      limit 1`,
    [messageId]
  );
  return result.rows[0] || null;
};

export const getTelegramDeliveryByMessageIdInDb = async ({ client = null, messageId } = {}) => {
  if (client) return __getTelegramDeliveryByMessageIdWithClient({ client, messageId });
  return withFirmDbClient((dbClient) => __getTelegramDeliveryByMessageIdWithClient({ client: dbClient, messageId }));
};

export const __getOpenWhatsAppEvidenceRequestsForClientWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!client || !clientId) return [];
  // 122 — owner-channel surface: client-audience asks only. A colleague/agent
  // ask must never match an inbound WhatsApp Ref or render in the owner list.
  const result = await client.query(
    `select * from client_evidence_requests
      where firm_id = $1 and client_id = $2 and status = 'open' and audience = 'client'
      order by created_at asc
      limit 50`,
    [firmId, clientId]
  );
  return result.rows;
};

export const getOpenWhatsAppEvidenceRequestsForClientInDb = async ({ client = null, firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (client) return __getOpenWhatsAppEvidenceRequestsForClientWithClient({ client, firmId, clientId });
  return withFirmDbClient((dbClient) => __getOpenWhatsAppEvidenceRequestsForClientWithClient({ client: dbClient, firmId, clientId }));
};

export const __getOpenWhatsAppEvidenceRequestByRefWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId, askRef } = {}) => {
  const cleanRef = String(askRef || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!cleanRef) return null;
  const rows = await __getOpenWhatsAppEvidenceRequestsForClientWithClient({ client, firmId, clientId });
  const direct = rows.find((row) => shortAskRef(row.id) === cleanRef);
  if (direct) return direct;
  // 108: an already-issued Ref must keep resolving after its ask is merged into
  // a canonical twin. The owner may still have the losing Ref sitting in his
  // chat history, and a reply quoting it has to land on the LIVE question rather
  // than dead-ending. Merged rows are not deleted precisely so this lookup works:
  // find the merged row by Ref, then follow merged_into to the survivor.
  const merged = await client.query(
    `select r.merged_into
       from client_evidence_requests r
      where r.firm_id = $1 and r.client_id = $2
        and r.merged_into is not null
        and right(upper(regexp_replace(r.id, '[^a-zA-Z0-9]', '', 'g')), 8) = $3
      order by r.updated_at desc
      limit 1`,
    [firmId, clientId, cleanRef]
  ).catch(() => ({ rows: [] }));
  const survivorId = merged.rows?.[0]?.merged_into || null;
  if (!survivorId) return null;
  return rows.find((row) => row.id === survivorId) || null;
};

// A deliverer loads each ask by id right before it sends, and sends only an ask
// still waiting on the owner (a never-sent draft or an open question; the
// same AWAITING_OWNER_STATUSES ownerAskDelivery.js names). An answer that
// landed between a sweep's select and this send — replied, resolved,
// cancelled, merged — is skipped, and the skip is reported
// (`skipped_not_awaiting`), never reminded once more.
const AWAITING_OWNER_ASK_SQL = `select * from client_evidence_requests
  where firm_id = $1 and client_id = $2 and id = $3 and audience = 'client'
    and status in ('draft', 'open')
  limit 1`;
const skippedNotAwaiting = (ids) => (ids.length ? { skipped_not_awaiting: ids } : {});

// The same read for a sender outside this file (the evidence-topic reminder):
// the ask as it stands right before the send, or null when it is no longer
// waiting on the owner.
export const __readAwaitingOwnerAskWithClient = async ({ client, firmId, clientId, askId } = {}) => {
  if (!client || !firmId || !clientId || !askId) return null;
  const res = await client.query(AWAITING_OWNER_ASK_SQL, [firmId, clientId, askId]);
  return res.rows[0] || null;
};

// 108 — the ONLY place send_count moves. Minting is a bookkeeping act the owner
// never sees; a prompt is what he actually receives, and the re-ask cadence
// (askReaskCadence.js) escalates off this count, so it must mean prompts. Called
// by every owner-ask deliverer AFTER a send has genuinely succeeded, never
// before and never on a failed send.
// DMEM-R1 W1 (INV-14, audit F-11): this is ALSO the only place an ask leaves
// `draft` — the mint (db/asks.js) writes no sent stamp and no `open`; the first
// genuine send stamps first_sent_at, bumps the count, mirrors the stamp into
// the envelope the portal renders, and flips the row draft → open in one write.
export const __bumpEvidenceRequestSendCountWithClient = async ({ client, firmId, clientId, askIds = [], at = null } = {}) => {
  const ids = (Array.isArray(askIds) ? askIds : []).filter(Boolean);
  if (!client || !firmId || !clientId || !ids.length) return { bumped: 0 };
  const stamp = at || new Date().toISOString();
  const stampMs = new Date(stamp).getTime();
  const res = await client.query(
    `update client_evidence_requests
        set send_count = send_count + 1,
            first_sent_at = coalesce(first_sent_at, $4::timestamptz),
            last_sent_at = $4::timestamptz,
            status = case when status = 'draft' then 'open' else status end,
            request_payload = coalesce(request_payload, '{}'::jsonb)
              || jsonb_build_object('evidence_request',
                   coalesce(request_payload->'evidence_request', '{}'::jsonb)
                   || jsonb_build_object(
                        'status', case when status = 'draft' then 'open' else status end,
                        'sent_at', $5::bigint,
                        -- the mint writes a JSON null here (never a stamp), so the
                        -- first genuine send is the first NUMBER, not the first key
                        'first_sent_at', case
                          when jsonb_typeof(request_payload->'evidence_request'->'first_sent_at') = 'number'
                            then request_payload->'evidence_request'->'first_sent_at'
                          else to_jsonb($5::bigint) end,
                        'send_count', send_count + 1)),
            updated_at = now()
      where firm_id = $1 and client_id = $2 and id = any($3::text[])
      returning id`,
    [firmId, clientId, ids, stamp, stampMs]
  ).catch(() => ({ rows: [] }));
  return { bumped: (res.rows || []).length };
};

// INV-29: an attempt whose outcome the provider never settled — the request may
// have left, the answer never came (a thrown transport error, a timeout) — is
// neither a send nor a failure. It is recorded as `delivery_unknown`: a ledger
// row with that failure_reason and a marker on the ask, no send stamp, no
// count bump, and no automatic retry from here (the next send is a deliberate
// act that can see the marker). A provider that answered `ok: false` is a
// plain failure, as before.
export const DELIVERY_UNKNOWN_REASON = 'delivery_unknown';

const attemptDelivery = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, unknown: true, reason: DELIVERY_UNKNOWN_REASON, error: error?.message || String(error) };
  }
};

const failureReasonFor = (result, fallback) => (result?.unknown ? DELIVERY_UNKNOWN_REASON : (result?.reason || result?.error || fallback));

export const __recordDeliveryUnknownWithClient = async ({ client, firmId, clientId, askIds = [], channel = null, at = null, error = null } = {}) => {
  const ids = (Array.isArray(askIds) ? askIds : []).filter(Boolean);
  if (!client || !firmId || !clientId || !ids.length) return { recorded: 0 };
  const stamp = at || new Date().toISOString();
  const res = await client.query(
    `update client_evidence_requests
        set request_payload = coalesce(request_payload, '{}'::jsonb)
              || jsonb_build_object('delivery_unknown', jsonb_build_object('channel', $4::text, 'at', $5::text, 'error', $6::text)),
            updated_at = now()
      where firm_id = $1 and client_id = $2 and id = any($3::text[])
      returning id`,
    [firmId, clientId, ids, channel, stamp, error]
  ).catch(() => ({ rows: [] }));
  return { recorded: (res.rows || []).length };
};

const recordUnknownIfIndeterminate = async ({ client, firmId, clientId, askIds, channel, result, at = null }) => {
  if (!result?.unknown) return;
  await __recordDeliveryUnknownWithClient({ client, firmId, clientId, askIds, channel, at, error: result.error || null });
};

export const getOpenWhatsAppEvidenceRequestByRefInDb = async ({ client = null, firmId = DEFAULT_FIRM_ID, clientId, askRef } = {}) => {
  if (client) return __getOpenWhatsAppEvidenceRequestByRefWithClient({ client, firmId, clientId, askRef });
  return withFirmDbClient((dbClient) => __getOpenWhatsAppEvidenceRequestByRefWithClient({ client: dbClient, firmId, clientId, askRef }));
};

export const __claimInboundWhatsAppMessageWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  inboundMessageId,
  clientId = null,
  phoneHash = null,
  providerPayload = {}
} = {}) => {
  const cleanMessageId = String(inboundMessageId || '').trim();
  if (!client || !cleanMessageId) return { claimed: false, reason: 'missing_message_id' };
  const id = `mdl_meta_${cleanMessageId}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
  const result = await client.query(
    `insert into message_delivery_ledger (id, message_id, channel, provider, client_id, recipient_phone_hash, inbound_reply_id, provider_payload)
     values ($1, $2, 'whatsapp', 'meta', $3, $4, $2, $5::jsonb)
     on conflict (provider, message_id) do nothing
     returning *`,
    [id, cleanMessageId, clientId, phoneHash, JSON.stringify(providerPayload || {})]
  );
  const claimed = Boolean(result.rows[0]);
  if (claimed) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'client', $3, 'whatsapp.inbound.received', 'message_delivery_ledger', $4, $5::jsonb)`,
      [firmId, clientId, providerPayload?.actor_id || 'whatsapp:webhook', id, JSON.stringify({ inbound_reply_id: cleanMessageId })]
    );
  }
  return { claimed, ledger: result.rows[0] || null };
};

export const claimInboundWhatsAppMessageInDb = async (args = {}) =>
  withFirmDbClient((client) => __claimInboundWhatsAppMessageWithClient({ client, ...args }));

export const __claimInboundSmsMessageWithClient = async ({
  client, firmId = DEFAULT_FIRM_ID, inboundMessageId, clientId = null, phoneHash = null, providerPayload = {}
} = {}) => {
  const cleanMessageId = String(inboundMessageId || '').trim();
  if (!client || !cleanMessageId) return { claimed: false, reason: 'missing_message_id' };
  const id = `mdl_twilio_${cleanMessageId}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
  const result = await client.query(
    `insert into message_delivery_ledger (id, message_id, channel, provider, client_id, recipient_phone_hash, inbound_reply_id, provider_payload)
     values ($1, $2, 'sms', 'twilio', $3, $4, $2, $5::jsonb)
     on conflict (provider, message_id) do nothing
     returning *`,
    [id, cleanMessageId, clientId, phoneHash, JSON.stringify(providerPayload || {})]
  );
  const claimed = Boolean(result.rows[0]);
  if (claimed) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'client', $3, 'sms.inbound.received', 'message_delivery_ledger', $4, $5::jsonb)`,
      [firmId, clientId, providerPayload?.actor_id || 'sms:webhook', id, JSON.stringify({ inbound_reply_id: cleanMessageId })]
    );
  }
  return { claimed, ledger: result.rows[0] || null };
};

export const claimInboundSmsMessageInDb = async (args = {}) =>
  withFirmDbClient((client) => __claimInboundSmsMessageWithClient({ client, ...args }));

export const __claimInboundTelegramMessageWithClient = async ({
  client, firmId = DEFAULT_FIRM_ID, inboundMessageId, clientId = null, phoneHash = null, providerPayload = {}
} = {}) => {
  const cleanMessageId = String(inboundMessageId || '').trim();
  if (!client || !cleanMessageId) return { claimed: false, reason: 'missing_message_id' };
  const id = `mdl_telegram_${cleanMessageId}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
  const result = await client.query(
    `insert into message_delivery_ledger (id, message_id, channel, provider, client_id, recipient_phone_hash, inbound_reply_id, provider_payload)
     values ($1, $2, 'telegram', 'telegram', $3, $4, $2, $5::jsonb)
     on conflict (provider, message_id) do nothing
     returning *`,
    [id, cleanMessageId, clientId, phoneHash, JSON.stringify(providerPayload || {})]
  );
  const claimed = Boolean(result.rows[0]);
  if (claimed) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'client', $3, 'telegram.inbound.received', 'message_delivery_ledger', $4, $5::jsonb)`,
      [firmId, clientId, providerPayload?.actor_id || 'telegram:webhook', id, JSON.stringify({ inbound_reply_id: cleanMessageId })]
    );
  }
  return { claimed, ledger: result.rows[0] || null };
};

export const claimInboundTelegramMessageInDb = async (args = {}) =>
  withFirmDbClient((client) => __claimInboundTelegramMessageWithClient({ client, ...args }));

export const __recordMessageDeliveryLedgerWithClient = async ({ client, entry = {} } = {}) => {
  const id = entry.id || `mdl_${entry.provider || 'provider'}_${entry.message_id || entry.messageId || Date.now()}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
  const messageId = entry.message_id || entry.messageId;
  if (!messageId) return null;
  const result = await client.query(
    `insert into message_delivery_ledger (id, message_id, channel, provider, ask_id, client_id, recipient_phone_hash, template_name, sent_at, delivered_at, read_at, failed_at, failure_reason, fallback_triggered_at, inbound_reply_id, resolved_request_id, provider_payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
     on conflict (provider, message_id) do update set
       ask_id = coalesce(excluded.ask_id, message_delivery_ledger.ask_id),
       client_id = coalesce(excluded.client_id, message_delivery_ledger.client_id),
       recipient_phone_hash = coalesce(excluded.recipient_phone_hash, message_delivery_ledger.recipient_phone_hash),
       template_name = coalesce(excluded.template_name, message_delivery_ledger.template_name),
       delivered_at = coalesce(message_delivery_ledger.delivered_at, excluded.delivered_at),
       read_at = coalesce(message_delivery_ledger.read_at, excluded.read_at),
       failed_at = coalesce(message_delivery_ledger.failed_at, excluded.failed_at),
       failure_reason = coalesce(excluded.failure_reason, message_delivery_ledger.failure_reason),
       fallback_triggered_at = coalesce(message_delivery_ledger.fallback_triggered_at, excluded.fallback_triggered_at),
       inbound_reply_id = coalesce(excluded.inbound_reply_id, message_delivery_ledger.inbound_reply_id),
       resolved_request_id = coalesce(excluded.resolved_request_id, message_delivery_ledger.resolved_request_id),
       provider_payload = message_delivery_ledger.provider_payload || excluded.provider_payload,
       updated_at = now()
     returning *`,
    [id, messageId, entry.channel || 'whatsapp', entry.provider || 'meta', entry.ask_id || entry.askId || null, entry.client_id || entry.clientId || null, entry.recipient_phone_hash || null, entry.template_name || entry.templateName || null, entry.sent_at || null, entry.delivered_at || null, entry.read_at || null, entry.failed_at || null, entry.failure_reason || null, entry.fallback_triggered_at || null, entry.inbound_reply_id || null, entry.resolved_request_id || null, JSON.stringify(entry.provider_payload || {})]
  );
  return result.rows[0] || null;
};

export const recordMessageDeliveryLedgerInDb = async ({ client = null, entry = {} } = {}) => {
  if (client) return __recordMessageDeliveryLedgerWithClient({ client, entry });
  return withFirmDbClient((dbClient) => __recordMessageDeliveryLedgerWithClient({ client: dbClient, entry }));
};

// Owner-ask template language: prefer the client's locale-appropriate
// template, fall back to English. The preferred language is only ATTEMPTED —
// if Meta has not approved that language version of the template yet, the
// Cloud API returns error code 132001 ("template does not exist" for that
// language) and we retry in English, which is always registered. So
// registering a Finnish template is NON-BREAKING: sends keep succeeding in
// 'en' until the 'fi' version goes live, then switch automatically with no
// code change. The language actually sent is recorded in the delivery ledger
// (the send language is part of the receipt).
// The resolver itself lives in the leaf module ../ownerLanguage.js (shared with
// the ask drafter); re-exported here under the same names.
export { OWNER_TEMPLATE_FALLBACK_LANGUAGE, preferredOwnerTemplateLanguage };

// The period an ask names when its payload carries none, in the owner's
// language. It rides the message as a template parameter, so a Finnish owner
// must not read the English fallback inside a Finnish sentence.
const OWNER_ASK_PERIOD_FALLBACK = Object.freeze({ en: 'this period', fi: 'tämä kausi' });
const askPeriodFor = (request, language) => request.request_payload?.period || request.request_payload?.period_label
  || OWNER_ASK_PERIOD_FALLBACK[language] || OWNER_ASK_PERIOD_FALLBACK[OWNER_TEMPLATE_FALLBACK_LANGUAGE];

// One profile read per batch for the code-side channels (SMS/Telegram): the
// assistant display name ('Donna' fallback) and the owner's language ('en' on
// any read failure).
const readOwnerVoice = (client, { firmId, clientId }) => client.query('select profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId])
  .then((res) => ({ assistantName: resolveAssistantName(res.rows[0]?.profile), language: preferredOwnerTemplateLanguage(res.rows[0]?.profile) }))
  .catch(() => ({ assistantName: resolveAssistantName(null), language: OWNER_TEMPLATE_FALLBACK_LANGUAGE }));

// Meta Cloud API returns error code 132001 when the template exists but has no
// approved translation in the requested language. Treat that (and a defensive
// message match) as "this language isn't live yet" ⇒ safe to retry in English.
// Any OTHER failure (network, rate limit, bad params) is NOT a language issue,
// so we do not retry — the caller records it as a normal send failure.
const isOwnerTemplateLanguageUnavailable = (result) => {
  if (!result || result.ok) return false;
  if (Number(result.body?.error?.code) === 132001) return true;
  const message = String(result.body?.error?.message || result.error || '').toLowerCase();
  return /template.*(does not exist|not found|no.*translation)|translation.*(does not exist|not found)/.test(message);
};

// Send an owner template in the preferred language; on a language-unavailable
// error only, retry in English. Returns the result plus the language actually
// sent. A 132001 rejection means the message was NOT delivered, so the retry
// cannot double-send.
const deliverOwnerTemplateWithLanguageFallback = async ({ deliverOwnerMessage, channel, recipient, template, preferredLanguage }) => {
  const attempt = (languageCode) => deliverOwnerMessage({ channel, recipient, template: { ...template, languageCode } });
  const primary = await attempt(preferredLanguage);
  if (primary?.ok || preferredLanguage === OWNER_TEMPLATE_FALLBACK_LANGUAGE || !isOwnerTemplateLanguageUnavailable(primary)) {
    return { result: primary, languageCode: preferredLanguage, fellBack: false };
  }
  const fallback = await attempt(OWNER_TEMPLATE_FALLBACK_LANGUAGE);
  return { result: fallback, languageCode: OWNER_TEMPLATE_FALLBACK_LANGUAGE, fellBack: true };
};

// Sensitive-ask portal fallback (self-knowledge slice 3). A blocked sensitive
// ask must land ON THE OWNER, never rest in a silent firm-side failure row
// (two-terminal-states): when askSafety refuses an ask as
// 'sensitive_ask_portal_only', the three messaging deliverers below call this
// after recording the block. Gated by OWNER_PORTAL_LINK on the config plane
// (deliberately the SAME flag as the share_portal_link chat action, not a
// sibling: identical trust class — owner-directed portal-link delivery over a
// bound channel — so one staging lever covers both; flag dark ⇒ byte-identical
// silence, as before this slice). No model in this loop: the notice text and
// the deep link are deterministic (selfKnowledge.js), and the question content
// NEVER rides the channel. WhatsApp sends the registered portal-redirect
// template (a URL never rides a Meta template param; unregistered template ⇒
// a named ledger failure until it is registered, non-breaking); SMS/Telegram
// send the composed notice text code-side. Receipted twice per send: the
// delivery ledger (notice version, link status/path, snapshot id) and a
// best-effort owner_portal_link.shared audit row (actor_type 'system',
// trigger 'sensitive_ask_blocked').
export const deliverSensitiveAskPortalNotice = async ({
  client, firmId, clientId, request, binding, channel, provider,
  deliverOwnerMessage, OWNER_CHANNELS, assistantName = null,
  preferredLanguage = OWNER_TEMPLATE_FALLBACK_LANGUAGE, env = process.env
} = {}) => {
  let snapshot = {};
  try {
    snapshot = (await readClientConfigSnapshot(client, { firmId, clientId })) || {};
  } catch {
    snapshot = {};
  }
  if (!clientFlagActs({ flagKey: OWNER_PORTAL_LINK_FLAG_KEY, snapshot, envFallback: () => false, env })) {
    return { skipped: true, reason: 'flag_off' };
  }
  const link = resolveOwnerPortalLink({ clientId, env });
  const askRef = shortAskRef(request.id);
  let result;
  let templateName;
  let sentLanguage = preferredLanguage;
  if (channel === 'whatsapp') {
    templateName = SENSITIVE_ASK_WA_TEMPLATE;
    ({ result, languageCode: sentLanguage } = await deliverOwnerTemplateWithLanguageFallback({
      deliverOwnerMessage,
      channel: OWNER_CHANNELS.WHATSAPP,
      recipient: { phone_e164: binding.phone_e164 },
      template: { name: templateName, bodyParameters: [SENSITIVE_ASK_WA_ITEM_PARAM, askRef], metadata: { ask_id: request.id, client_id: clientId } },
      preferredLanguage
    }));
  } else {
    templateName = SENSITIVE_ASK_NOTICE_TEMPLATE;
    const text = sensitiveAskPortalNoticeText({ assistantName, url: link.url, askRef, language: preferredLanguage });
    result = await deliverOwnerMessage({
      channel: channel === 'sms' ? OWNER_CHANNELS.SMS : OWNER_CHANNELS.TELEGRAM,
      recipient: { phone_e164: binding.phone_e164 },
      template: { name: templateName, bodyParameters: [text], metadata: { ask_id: request.id, client_id: clientId }, assistantName, language: preferredLanguage }
    });
  }
  const at = new Date().toISOString();
  const snapshotId = configSnapshotId({ firmId, clientId, snapshot });
  await recordMessageDeliveryLedgerInDb({ client, entry: {
    message_id: result?.ok && result.id ? result.id : `${channel}_sensitive_notice_${request.id}`,
    channel, provider, ask_id: request.id, client_id: clientId,
    recipient_phone_hash: binding.phone_hash, template_name: templateName,
    ...(result?.ok
      ? { sent_at: at }
      : { failed_at: at, failure_reason: result?.reason || result?.error || 'SENSITIVE_NOTICE_SEND_FAILED', fallback_triggered_at: at }),
    provider_payload: {
      notice: SENSITIVE_ASK_NOTICE_VERSION,
      trigger: 'sensitive_ask_blocked',
      link_status: link.status,
      link_path: link.path,
      authority_basis: `config_stage:${OWNER_PORTAL_LINK_FLAG_KEY}`,
      config_snapshot_id: snapshotId,
      language: sentLanguage
    }
  } });
  try {
    await recordOwnerPortalLinkShare(client, {
      firmId, clientId, actorId: `ask:${request.id}`, actorType: 'system', channel,
      status: result?.ok ? link.status : 'send_failed',
      linkPath: link.path, trigger: 'sensitive_ask_blocked', askId: request.id,
      noticeVersion: SENSITIVE_ASK_NOTICE_VERSION, configSnapshotId: snapshotId
    });
  } catch (error) {
    console.warn('[sensitive-ask-notice] audit write failed', error?.message || error);
  }
  return result?.ok
    ? { sent: true, link_status: link.status }
    : { sent: false, reason: result?.reason || result?.error || 'send_failed' };
};

export const deliverWhatsAppEvidenceAsksAfterSend = async ({ client, firmId, clientId, evidenceRequestIds = [], env = process.env, deps = {} } = {}) => {
  if (!whatsappEnvAllowsClient(clientId, env)) return { skipped: true, reason: 'flag_off' };
  const binding = await getActiveWhatsAppBindingForClientInDb({ client, firmId, clientId });
  if (!binding) return { skipped: true, reason: 'unbound' };
  const channelModule = deps.channelModule || await import('../channels/index.js');
  const deliverOwnerMessage = deps.deliverOwnerMessage || channelModule.deliverOwnerMessage;
  const OWNER_CHANNELS = deps.OWNER_CHANNELS || channelModule.OWNER_CHANNELS;
  // One profile read per batch → the owner-ask template language (FI → 'fi',
  // with graceful 'en' fallback at send time if the Finnish template isn't
  // approved yet). 'en' on any read failure.
  const preferredLanguage = await client.query('select profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId])
    .then((res) => preferredOwnerTemplateLanguage(res.rows[0]?.profile))
    .catch(() => OWNER_TEMPLATE_FALLBACK_LANGUAGE);
  const ids = evidenceRequestIds.filter(Boolean);
  const notAwaiting = [];
  // The asks the provider accepted: `sent` reports these, never the attempts.
  const delivered = [];
  for (const askId of ids) {
    const requestResult = await client.query(AWAITING_OWNER_ASK_SQL, [firmId, clientId, askId]);
    const request = requestResult.rows[0];
    if (!request) { notAwaiting.push(askId); continue; }
    const period = askPeriodFor(request, preferredLanguage);
    const safeQuestion = prepareOwnerAskQuestion(request.question);
    if (safeQuestion.blocked) {
      // Sensitive-identifier ask: never send over WhatsApp — record a visible
      // portal/email fallback so the ask still reaches the owner.
      await recordMessageDeliveryLedgerInDb({ client, entry: {
        message_id: `fallback_${request.id}`, channel: 'whatsapp', provider: 'meta', ask_id: request.id, client_id: clientId,
        recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', failed_at: new Date().toISOString(), failure_reason: safeQuestion.reason, fallback_triggered_at: new Date().toISOString()
      } });
      // …and, when OWNER_PORTAL_LINK acts, tell the owner a question is
      // waiting in their portal (safe notice, no question content). Fail-soft:
      // a notice failure never breaks the ask batch.
      await deliverSensitiveAskPortalNotice({
        client, firmId, clientId, request, binding, channel: 'whatsapp', provider: 'meta',
        deliverOwnerMessage, OWNER_CHANNELS, preferredLanguage, env
      }).catch((error) => console.warn('[whatsapp-asks] sensitive-ask portal notice failed', error?.message || error));
      continue;
    }
    const { result, languageCode: sentLanguage } = await attemptDelivery(() => deliverOwnerTemplateWithLanguageFallback({
      deliverOwnerMessage,
      channel: OWNER_CHANNELS.WHATSAPP,
      recipient: { phone_e164: binding.phone_e164 },
      template: {
        name: 'donna_evidence_ask_v1',
        bodyParameters: [period, safeQuestion.text, shortAskRef(request.id)],
        metadata: { ask_id: request.id, client_id: clientId }
      },
      preferredLanguage
    })).then((out) => (out?.unknown ? { result: out, languageCode: preferredLanguage } : out));
    if (result?.ok) {
      await recordMessageDeliveryLedgerInDb({ client, entry: {
        message_id: result.id,
        channel: 'whatsapp', provider: 'meta', ask_id: request.id, client_id: clientId,
        recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', sent_at: new Date().toISOString(), provider_payload: { send: result.body || null, language: sentLanguage }
      } });
      // 108: send_count counts OUTBOUND PROMPTS, and every channel must bump it
      // or an ask delivered here would never age into the re-ask cadence.
      await __bumpEvidenceRequestSendCountWithClient({ client, firmId, clientId, askIds: [request.id] });
      delivered.push(request.id);
    } else {
      await recordMessageDeliveryLedgerInDb({ client, entry: {
        message_id: `fallback_${request.id}`, channel: 'whatsapp', provider: 'meta', ask_id: request.id, client_id: clientId,
        recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', failed_at: new Date().toISOString(), failure_reason: failureReasonFor(result, 'WHATSAPP_SEND_FAILED'), fallback_triggered_at: new Date().toISOString()
      } });
      await recordUnknownIfIndeterminate({ client, firmId, clientId, askIds: [request.id], channel: 'whatsapp', result });
    }
  }
  return { sent: delivered.length, delivered, ...skippedNotAwaiting(notAwaiting) };
};

export const deliverSmsEvidenceAsksAfterSend = async ({ client, firmId, clientId, evidenceRequestIds = [], env = process.env, deps = {} } = {}) => {
  if (!smsEnvAllowsClient(clientId, env)) return { skipped: true, reason: 'flag_off' };
  const binding = await getActiveSmsBindingForClientInDb({ client, firmId, clientId });
  if (!binding) return { skipped: true, reason: 'unbound' };
  const channelModule = deps.channelModule || await import('../channels/index.js');
  const deliverOwnerMessage = deps.deliverOwnerMessage || channelModule.deliverOwnerMessage;
  const OWNER_CHANNELS = deps.OWNER_CHANNELS || channelModule.OWNER_CHANNELS;
  const ids = evidenceRequestIds.filter(Boolean);
  const notAwaiting = [];
  const delivered = [];
  // D-PA-3: SMS bodies render code-side, so the owner's chosen assistant
  // name and the owner's language apply here. One profile read per batch.
  const { assistantName, language } = await readOwnerVoice(client, { firmId, clientId });
  for (const askId of ids) {
    const requestResult = await client.query(AWAITING_OWNER_ASK_SQL, [firmId, clientId, askId]);
    const request = requestResult.rows[0];
    if (!request) { notAwaiting.push(askId); continue; }
    const period = askPeriodFor(request, language);
    const safeQuestion = prepareOwnerAskQuestion(request.question);
    if (safeQuestion.blocked) {
      // Sensitive-identifier ask: never send over SMS — record a visible
      // portal/email fallback so the ask still reaches the owner.
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: `sms_fallback_${request.id}`, channel: 'sms', provider: 'twilio', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', failed_at: new Date().toISOString(), failure_reason: safeQuestion.reason, fallback_triggered_at: new Date().toISOString() } });
      // …and, when OWNER_PORTAL_LINK acts, a safe "this needs your portal"
      // notice with the deep link (no question content). Fail-soft.
      await deliverSensitiveAskPortalNotice({
        client, firmId, clientId, request, binding, channel: 'sms', provider: 'twilio',
        deliverOwnerMessage, OWNER_CHANNELS, assistantName, preferredLanguage: language, env
      }).catch((error) => console.warn('[sms-asks] sensitive-ask portal notice failed', error?.message || error));
      continue;
    }
    const result = await attemptDelivery(() => deliverOwnerMessage({
      channel: OWNER_CHANNELS.SMS,
      recipient: { phone_e164: binding.phone_e164 },
      template: { name: 'donna_evidence_ask_v1', bodyParameters: [period, safeQuestion.text, shortAskRef(request.id)], metadata: { ask_id: request.id, client_id: clientId }, assistantName, language }
    }));
    if (result?.ok) {
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: result.id, channel: 'sms', provider: 'twilio', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', sent_at: new Date().toISOString(), provider_payload: { send: result.body || null, language } } });
      await __bumpEvidenceRequestSendCountWithClient({ client, firmId, clientId, askIds: [request.id] });
      delivered.push(request.id);
    } else {
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: `sms_fallback_${request.id}`, channel: 'sms', provider: 'twilio', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', failed_at: new Date().toISOString(), failure_reason: failureReasonFor(result, 'SMS_SEND_FAILED'), fallback_triggered_at: new Date().toISOString(), provider_payload: { language } } });
      await recordUnknownIfIndeterminate({ client, firmId, clientId, askIds: [request.id], channel: 'sms', result });
    }
  }
  return { sent: delivered.length, delivered, ...skippedNotAwaiting(notAwaiting) };
};

// Telegram twin of deliverSmsEvidenceAsksAfterSend. Free-form send (no Meta
// template, no language fallback — that whole apparatus is WhatsApp-only), same
// coarse gate + active-binding + sensitive-ask-blocked discipline, and the
// outbound message_id is receipted so a tapped reply anchors back to the ask.
export const deliverTelegramEvidenceAsksAfterSend = async ({ client, firmId, clientId, evidenceRequestIds = [], env = process.env, deps = {} } = {}) => {
  if (!telegramEnvAllowsClient(clientId, env)) return { skipped: true, reason: 'flag_off' };
  const binding = await getActiveTelegramBindingForClientInDb({ client, firmId, clientId });
  if (!binding) return { skipped: true, reason: 'unbound' };
  const channelModule = deps.channelModule || await import('../channels/index.js');
  const deliverOwnerMessage = deps.deliverOwnerMessage || channelModule.deliverOwnerMessage;
  const OWNER_CHANNELS = deps.OWNER_CHANNELS || channelModule.OWNER_CHANNELS;
  const ids = evidenceRequestIds.filter(Boolean);
  const notAwaiting = [];
  // Telegram bodies render code-side, so the owner's chosen assistant name and
  // the owner's language apply here. One profile read per batch.
  const { assistantName, language } = await readOwnerVoice(client, { firmId, clientId });

  // Pass 1: load each ask and split it. A sensitive-identifier ask NEVER rides
  // the channel, batched or not, so it keeps its own per-ask handling exactly
  // as before; everything else becomes a digest candidate.
  const sendable = [];
  for (const askId of ids) {
    const requestResult = await client.query(AWAITING_OWNER_ASK_SQL, [firmId, clientId, askId]);
    const request = requestResult.rows[0];
    if (!request) { notAwaiting.push(askId); continue; }
    const period = askPeriodFor(request, language);
    const safeQuestion = prepareOwnerAskQuestion(request.question);
    if (safeQuestion.blocked) {
      // Sensitive-identifier ask: never send over Telegram — record a visible
      // portal/email fallback so the ask still reaches the owner.
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: `telegram_fallback_${request.id}`, channel: 'telegram', provider: 'telegram', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', failed_at: new Date().toISOString(), failure_reason: safeQuestion.reason, fallback_triggered_at: new Date().toISOString() } });
      // …and, when OWNER_PORTAL_LINK acts, a safe "this needs your portal"
      // notice with the deep link (no question content). Fail-soft.
      await deliverSensitiveAskPortalNotice({
        client, firmId, clientId, request, binding, channel: 'telegram', provider: 'telegram',
        deliverOwnerMessage, OWNER_CHANNELS, assistantName, preferredLanguage: language, env
      }).catch((error) => console.warn('[telegram-asks] sensitive-ask portal notice failed', error?.message || error));
      continue;
    }
    // 108: affordances are explicit per ask. A document/case-anchored ask must
    // not solicit the artifact Donna already holds.
    const affordanceTail = renderAskAffordanceTail(
      askAffordances({ anchor: request.canonical_anchor || '', evidenceType: request.evidence_type }),
      language
    );
    sendable.push({ request, period, question: safeQuestion.text, affordanceTail });
  }
  if (!sendable.length) return { sent: 0, delivered: [], ...skippedNotAwaiting(notAwaiting) };

  // ONE ask stays byte-identical to the pre-digest path: same template, same
  // bodyParameters, same bare-message_id receipt, so a tapped reply still
  // anchors straight back to that ask. Consolidation only earns its keep when
  // there is something to consolidate.
  if (sendable.length === 1) {
    const { request, period, question, affordanceTail } = sendable[0];
    const result = await attemptDelivery(() => deliverOwnerMessage({
      channel: OWNER_CHANNELS.TELEGRAM,
      recipient: { phone_e164: binding.phone_e164 },
      template: { name: 'donna_evidence_ask_v1', bodyParameters: [period, question, shortAskRef(request.id), affordanceTail], metadata: { ask_id: request.id, client_id: clientId }, assistantName, language }
    }));
    if (result?.ok) {
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: result.id, channel: 'telegram', provider: 'telegram', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', sent_at: new Date().toISOString(), provider_payload: { send: result.body || null, language } } });
      // 108: the prompt actually left, so this is a real send.
      await __bumpEvidenceRequestSendCountWithClient({ client, firmId, clientId, askIds: [request.id] });
    } else {
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: `telegram_fallback_${request.id}`, channel: 'telegram', provider: 'telegram', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', failed_at: new Date().toISOString(), failure_reason: failureReasonFor(result, 'TELEGRAM_SEND_FAILED'), fallback_triggered_at: new Date().toISOString(), provider_payload: { language } } });
      await recordUnknownIfIndeterminate({ client, firmId, clientId, askIds: [request.id], channel: 'telegram', result });
    }
    const delivered = result?.ok ? [request.id] : [];
    return { sent: delivered.length, delivered, ...skippedNotAwaiting(notAwaiting) };
  }

  // Two or more: ONE message. The pre-digest path looped here and sent a
  // separate Telegram message per ask, so waking a quiet client dumped the
  // whole open-ask set into the chat at once (the 2026-07-29 report: five
  // messages from one receipt upload). The email deliverer below already made
  // the opposite call for the same reason.
  //
  // The portal link rides along as the ALTERNATIVE surface, which is the point:
  // some owners would rather clear a list on a laptop than answer questions in
  // a chat, and a long batch is exactly when that preference matters. Resolved
  // deterministically and only when OWNER_PORTAL_LINK acts for this client, on
  // the same flag + resolver the sensitive-ask notice uses. A missing base URL
  // degrades to no link rather than a dead one, and the digest still sends.
  let portalLink = null;
  try {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    if (clientFlagActs({ flagKey: OWNER_PORTAL_LINK_FLAG_KEY, snapshot, envFallback: () => false, env })) {
      const resolved = resolveOwnerPortalLink({ clientId, env });
      if (resolved.status === 'sent' && resolved.url) portalLink = resolved;
    }
  } catch (error) {
    console.warn('[telegram-asks] portal link resolve failed', error?.message || error);
  }

  const text = buildTelegramAskDigestText({
    assistantName,
    items: sendable.map(({ request, period, question }) => ({ question, period, askRef: shortAskRef(request.id) })),
    portalUrl: portalLink?.url || null,
    language
  });
  // An empty digest means nothing fit the character budget. Rather than send a
  // useless message, fall back to the per-ask path so the asks still land.
  if (!text) {
    const delivered = [];
    for (const { request, period, question, affordanceTail } of sendable) {
      const one = await attemptDelivery(() => deliverOwnerMessage({
        channel: OWNER_CHANNELS.TELEGRAM,
        recipient: { phone_e164: binding.phone_e164 },
        template: { name: 'donna_evidence_ask_v1', bodyParameters: [period, question, shortAskRef(request.id), affordanceTail], metadata: { ask_id: request.id, client_id: clientId }, assistantName, language }
      }));
      if (one?.ok) {
        await __bumpEvidenceRequestSendCountWithClient({ client, firmId, clientId, askIds: [request.id] });
        delivered.push(request.id);
      }
      const at = new Date().toISOString();
      await recordMessageDeliveryLedgerInDb({ client, entry: one?.ok
        ? { message_id: one.id, channel: 'telegram', provider: 'telegram', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', sent_at: at, provider_payload: { send: one.body || null, language } }
        : { message_id: `telegram_fallback_${request.id}`, channel: 'telegram', provider: 'telegram', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: 'donna_evidence_ask_v1', failed_at: at, failure_reason: failureReasonFor(one, 'TELEGRAM_SEND_FAILED'), fallback_triggered_at: at, provider_payload: { language } } });
      await recordUnknownIfIndeterminate({ client, firmId, clientId, askIds: [request.id], channel: 'telegram', result: one, at });
    }
    return { sent: delivered.length, delivered, digest: false, reason: 'digest_empty', ...skippedNotAwaiting(notAwaiting) };
  }

  const result = await attemptDelivery(() => deliverOwnerMessage({
    channel: OWNER_CHANNELS.TELEGRAM,
    recipient: { phone_e164: binding.phone_e164 },
    template: { name: TELEGRAM_ASK_DIGEST_TEMPLATE, bodyParameters: [text], metadata: { ask_ids: sendable.map(({ request }) => request.id), client_id: clientId }, assistantName, language }
  }));
  const at = new Date().toISOString();
  // One ledger row PER ASK, exactly as the email deliverer does: the row is what
  // carries reply-anchoring and the fallback trail, and it is per-request. The
  // message_id is suffixed with the ask id because (provider, message_id) is
  // unique — the shared send id rides `batch_message_id` instead. A tapped reply
  // on a digest therefore finds no single ask to anchor to, which is correct:
  // it is genuinely ambiguous across N questions, so it falls through to the
  // general owner-chat lane, which has every open ask in its context and can
  // resolve the right one (or ask which). The per-item Refs stay the precise
  // route for an owner who wants to answer exactly one.
  for (const { request } of sendable) {
    await recordMessageDeliveryLedgerInDb({ client, entry: result?.ok
      ? { message_id: `${result.id || 'telegram_digest'}_${request.id}`, channel: 'telegram', provider: 'telegram', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: TELEGRAM_ASK_DIGEST_TEMPLATE, sent_at: at, provider_payload: { batch_message_id: result.id || null, digest_size: sendable.length, portal_link_status: portalLink ? 'sent' : 'absent', send: result.body || null, language } }
      : { message_id: `telegram_digest_fallback_${request.id}`, channel: 'telegram', provider: 'telegram', ask_id: request.id, client_id: clientId, recipient_phone_hash: binding.phone_hash, template_name: TELEGRAM_ASK_DIGEST_TEMPLATE, failed_at: at, failure_reason: failureReasonFor(result, 'TELEGRAM_SEND_FAILED'), fallback_triggered_at: at, provider_payload: { language } } });
  }
  if (result?.ok) {
    await __bumpEvidenceRequestSendCountWithClient({
      client, firmId, clientId, askIds: sendable.map(({ request }) => request.id), at
    });
  } else {
    await recordUnknownIfIndeterminate({ client, firmId, clientId, askIds: sendable.map(({ request }) => request.id), channel: 'telegram', result, at });
  }
  return result?.ok
    ? { sent: sendable.length, delivered: sendable.map(({ request }) => request.id), digest: true, portal_link: Boolean(portalLink), ...skippedNotAwaiting(notAwaiting) }
    : { sent: 0, delivered: [], digest: true, failed: sendable.length, ...skippedNotAwaiting(notAwaiting) };
};

// G14 (outbound-actions M1) — the owner-ask EMAIL deliverer. Email is the
// designated fallback channel the messaging deliverers' sensitive-ask guard
// points at ("record a visible portal/email fallback"), and D10 names email
// the US owner workbench — until now no evidence-ask ever actually reached
// an inbox. ONE email per batch (email is a workbench, not a chat stream),
// full un-truncated questions (the owner's own mailbox — the WA/SMS
// sensitive-identifier block does not apply), one ledger entry per ask so
// reply-anchoring and the fallback trail stay per-request.
//
// Gate: OWNER_EMAIL_ASKS on the config control plane (born 'off',
// envFallback () => false — the rollout-flags rail; NO env pair). Recipient:
// the owner email on the client profile (the billing ladder — email →
// contact_email → owner_email).
export const OWNER_EMAIL_ASKS_FLAG_KEY = 'OWNER_EMAIL_ASKS';

// Owner-ask email copy, per language. Pure: no I/O. 'fi' is everyday Finnish in
// the sinä form, the way a small accounting firm writes to its client; any
// other language gets the English copy. "(ref X)" stays verbatim in every
// language because extractAskRef anchors a reply on the literal word "ref".
// The reminder* lines replace subject and need when the re-ask sweep sends the
// same questions again (deps.askWording === 'reminder'); the first ask keeps
// its own wording.
const OWNER_EMAIL_ASK_COPY = Object.freeze({
  en: Object.freeze({
    periodFallback: OWNER_ASK_PERIOD_FALLBACK.en,
    count: (n) => `${n} question${n === 1 ? '' : 's'}`,
    subject: (count) => `${count} about your books`,
    reminderSubject: (count) => `${count} about your books (reminder)`,
    greeting: (name, firm) => `Hi — ${name} here${firm ? ` from ${firm}` : ''}.`,
    need: (n) => `To keep your books current I need ${n === 1 ? 'one answer' : 'a few answers'} only you can give:`,
    reminderNeed: (n) => `A quick reminder: I still need ${n === 1 ? 'one answer' : 'a few answers'} only you can give to keep your books current:`,
    closing: 'Just reply to this email with the answers (or photos/receipts attached) and I will take it from there.'
  }),
  fi: Object.freeze({
    periodFallback: OWNER_ASK_PERIOD_FALLBACK.fi,
    count: (n) => `${n} ${n === 1 ? 'kysymys' : 'kysymystä'}`,
    subject: (count) => `${count} kirjanpidostasi`,
    reminderSubject: (count) => `${count} kirjanpidostasi (muistutus)`,
    greeting: (name, firm) => `Hei! Täällä ${name}${firm ? `, ${firm}` : ''}.`,
    need: (n) => (n === 1
      ? 'Jotta kirjanpitosi pysyy ajan tasalla, tarvitsen sinulta vastauksen yhteen kysymykseen:'
      : 'Jotta kirjanpitosi pysyy ajan tasalla, tarvitsen sinulta vastauksia muutamaan kysymykseen:'),
    reminderNeed: (n) => (n === 1
      ? 'Muistutan vielä: tarvitsen sinulta vastauksen yhteen kysymykseen, jotta kirjanpitosi pysyy ajan tasalla:'
      : 'Muistutan vielä: tarvitsen sinulta vastauksia muutamaan kysymykseen, jotta kirjanpitosi pysyy ajan tasalla:'),
    closing: 'Vastaa vain tähän sähköpostiin (kuvat ja kuitit voit liittää mukaan), niin hoidan loput.'
  })
});

const buildOwnerEmailAskMessage = ({ language = OWNER_TEMPLATE_FALLBACK_LANGUAGE, assistantName, firmName = null, clientName = '', items = [], reminder = false } = {}) => {
  const copy = OWNER_EMAIL_ASK_COPY[language] || OWNER_EMAIL_ASK_COPY[OWNER_TEMPLATE_FALLBACK_LANGUAGE];
  const sender = firmName || assistantName;
  const lines = items.map((item, i) => `${i + 1}. [${item.period || copy.periodFallback}] ${item.question} (ref ${item.askRef})`);
  const subjectLine = reminder ? copy.reminderSubject : copy.subject;
  const needLine = reminder ? copy.reminderNeed : copy.need;
  const subject = `${sender}: ${subjectLine(copy.count(items.length))}${clientName ? ` — ${clientName}` : ''}`;
  const text = [
    `${copy.greeting(assistantName, firmName)} ${needLine(items.length)}`,
    '',
    ...lines,
    '',
    copy.closing
  ].join('\n');
  return { subject, text };
};

export const deliverEmailEvidenceAsksAfterSend = async ({ client, firmId, clientId, evidenceRequestIds = [], deps = {} } = {}) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: OWNER_EMAIL_ASKS_FLAG_KEY, snapshot, envFallback: () => false })) {
    return { skipped: true, reason: 'flag_off' };
  }
  const ids = evidenceRequestIds.filter(Boolean);
  const notAwaiting = [];
  if (!ids.length) return { sent: 0, delivered: [] };
  const clientRow = await client.query('select company_name, profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId])
    .then((res) => res.rows[0] || null).catch(() => null);
  const profile = clientRow?.profile && typeof clientRow.profile === 'object' ? clientRow.profile : {};
  const ownerEmail = String(profile.email || profile.contact_email || profile.owner_email || '').trim();
  if (!ownerEmail) return { skipped: true, reason: 'no_owner_email' };

  const requests = [];
  for (const askId of ids) {
    const requestResult = await client.query(AWAITING_OWNER_ASK_SQL, [firmId, clientId, askId]);
    if (requestResult.rows[0]) requests.push(requestResult.rows[0]);
    else notAwaiting.push(askId);
  }
  if (!requests.length) return { sent: 0, delivered: [], ...skippedNotAwaiting(notAwaiting) };

  const clientName = String(clientRow?.company_name || '').trim();
  // The owner is the FIRM's client and knows the firm, not the software: the
  // assistant name comes from the one shared resolver (as on Telegram/SMS) and
  // the firm is named as the one asking whenever firms.name is on file. The
  // wrapper copy follows the owner's language; the questions pass through as
  // the ask pipeline wrote them.
  const language = preferredOwnerTemplateLanguage(profile);
  const assistantName = resolveAssistantName(profile);
  const firmName = await client.query('select name from firms where id = $1 limit 1', [firmId])
    .then((res) => String(res.rows[0]?.name || '').trim() || null).catch(() => null);
  // The re-ask sweep (askReaskCadence.js) marks its sends through the deps the
  // fan-out forwards to every deliverer; the first send carries no marker.
  const reminder = deps.askWording === 'reminder';
  const { subject, text } = buildOwnerEmailAskMessage({
    language, assistantName, firmName, clientName, reminder,
    items: requests.map((request) => ({
      period: request.request_payload?.period || request.request_payload?.period_label || null,
      question: String(request.question || '').replace(/\s+/g, ' ').trim(),
      askRef: shortAskRef(request.id)
    }))
  });

  const channelModule = deps.channelModule || await import('../channels/index.js');
  const deliverOwnerMessage = deps.deliverOwnerMessage || channelModule.deliverOwnerMessage;
  const OWNER_CHANNELS = deps.OWNER_CHANNELS || channelModule.OWNER_CHANNELS;
  // The From display name names the firm the owner knows; the sender ADDRESS
  // stays exactly as configured (senderWithDisplayName keeps it verbatim).
  // No firm on file ⇒ the configured sender, unchanged.
  const from = firmName ? senderWithDisplayName(`${assistantName}, ${firmName}`) : null;
  const result = await attemptDelivery(() => deliverOwnerMessage({
    channel: OWNER_CHANNELS.EMAIL,
    recipient: { email: ownerEmail },
    email: { subject, text, ...(from ? { from } : {}) }
  }));
  const at = new Date().toISOString();
  for (const request of requests) {
    if (result?.ok) {
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: `${result.id || 'email'}_${request.id}`, channel: 'email', provider: 'resend', ask_id: request.id, client_id: clientId, template_name: 'donna_evidence_ask_email_v1', sent_at: at, provider_payload: { batch_message_id: result.id || null, language, ...(reminder ? { wording: 'reminder' } : {}) } } });
    } else {
      await recordMessageDeliveryLedgerInDb({ client, entry: { message_id: `email_fallback_${request.id}`, channel: 'email', provider: 'resend', ask_id: request.id, client_id: clientId, template_name: 'donna_evidence_ask_email_v1', failed_at: at, failure_reason: failureReasonFor(result, 'EMAIL_SEND_FAILED'), fallback_triggered_at: at, provider_payload: { language, ...(reminder ? { wording: 'reminder' } : {}) } } });
    }
  }
  if (result?.ok) {
    await __bumpEvidenceRequestSendCountWithClient({
      client, firmId, clientId, askIds: requests.map((r) => r.id), at
    });
  } else {
    await recordUnknownIfIndeterminate({ client, firmId, clientId, askIds: requests.map((r) => r.id), channel: 'email', result, at });
  }
  return result?.ok
    ? { sent: requests.length, delivered: requests.map((r) => r.id), ...skippedNotAwaiting(notAwaiting) }
    : { sent: 0, delivered: [], failed: requests.length, ...(result?.unknown ? { delivery_unknown: true } : {}), ...skippedNotAwaiting(notAwaiting) };
};
