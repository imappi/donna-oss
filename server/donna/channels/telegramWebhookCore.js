import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

const env = (key, envObj = process.env) => String(envObj?.[key] || '').trim();

export const telegramJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

// Telegram's webhook auth is a shared secret, NOT an HMAC over the body (unlike
// Meta). When you register the webhook you pass secret_token=<X>; Telegram then
// echoes it verbatim in the X-Telegram-Bot-Api-Secret-Token header on every
// delivery. We compare in constant time. Fail-closed: no configured secret ⇒
// reject (never accept an unauthenticated update).
export const verifyTelegramWebhookSecret = ({ header = '', secret = env('TELEGRAM_WEBHOOK_SECRET') } = {}) => {
  if (!secret) return false;
  const expected = Buffer.from(String(secret));
  const submitted = Buffer.from(String(header || ''));
  return expected.length === submitted.length && timingSafeEqual(expected, submitted);
};

// The Telegram deep-link binding hop: t.me/<bot>?start=<token> makes the client
// send the bot exactly "/start <token>" (optionally "/start@BotName <token>").
// Extract the token so the webhook can redeem it BEFORE anchored processing.
// Kept deliberately strict (whole-message match, 16+ url-safe chars) so a stray
// "/start" with chatter doesn't get misread as a token.
export const extractTelegramStartToken = (text) => {
  const match = String(text || '').trim().match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,})$/);
  return match?.[1] || '';
};

// A bare "/start" with no payload — the user opened the bot without a deep-link
// token. Worth a friendly nudge rather than an unanchored dead-end.
export const isBareTelegramStart = (text) => /^\/start(?:@\w+)?\s*$/.test(String(text || '').trim());

// Telegram's chat_id is a stable integer identifying the conversation. It is the
// binding key (stored as a string). It is not a phone number / PII, but we hash
// it with the SAME hashPhoneE164 the inbound anchor uses so both sides agree
// (see whatsappWebhookCore.phoneHashSalt). Callers pass String(chat_id).
export const telegramChatKey = (chatId) => String(chatId ?? '').trim();

// The inbound idempotency / document id for a Telegram message. Telegram's
// message_id is a per-CHAT counter, and message_delivery_ledger is unique on
// (provider, message_id) across every firm, so the id must carry the chat:
// two chats' "message 57" are different messages, while a redelivery inside one
// chat is the same id and still dedupes. (Ids stored before this scoping were
// `tg_<message_id>`; Telegram only redelivers recent unacked updates, so no
// backfill is needed.)
export const telegramInboundMessageId = ({ chatId, messageId } = {}) =>
  messageId == null ? undefined : `tg_${telegramChatKey(chatId)}_${messageId}`;

// Audit L5 — the owner-loop identity guard. The whole loop keys identity off
// chat.id alone; in a group chat every member shares that chat.id, so ANY
// member of a group containing the bot could speak as the bound owner. The
// binding, anchored replies and owner chat are all 1:1 surfaces, so only
// private chats participate. In a private chat Telegram guarantees
// from.id === chat.id — enforced anyway (anonymous/channel-backed senders),
// and bot-authored messages never participate. Returns { ok, reason }.
export const telegramSenderVerdict = (message) => {
  const chatType = message?.chat?.type || '';
  const sender = message?.from || null;
  if (chatType !== 'private') return { ok: false, reason: 'group_chat_unsupported' };
  if (sender?.is_bot === true) return { ok: false, reason: 'bot_sender' };
  if (sender?.id != null && String(sender.id) !== String(message?.chat?.id)) {
    return { ok: false, reason: 'sender_chat_mismatch' };
  }
  return { ok: true, reason: null };
};
