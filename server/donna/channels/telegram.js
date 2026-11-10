import { resolveAssistantName } from '../assistantIdentity.js';

const env = (key, envObj = process.env) => String(envObj?.[key] || '').trim();

// Telegram Bot API — a single bot token (from @BotFather) authenticates every
// call; the URL carries it. NO business verification, NO template review, NO
// allowlist: outbound is free-form text. That is the whole reason this channel
// exists (see docs/session-handoff-2026-07-15-telegram-channel.md).
export const telegramApiUrl = ({ botToken = env('TELEGRAM_BOT_TOKEN'), method = 'sendMessage' } = {}) =>
  `https://api.telegram.org/bot${botToken}/${encodeURIComponent(method)}`;

export const isTelegramConfigured = ({ envObj = process.env } = {}) => Boolean(env('TELEGRAM_BOT_TOKEN', envObj));

// Coarse channel gate. Mirrors whatsappEnvAllowsClient / smsEnvAllowsClient —
// a sync env pair (TELEGRAM_ENABLED + TELEGRAM_CLIENTS allowlist). This is the
// same LEGACY env-pair shape its WhatsApp/SMS siblings use; per the
// Retained byte-identically as the stage-1 config-plane fallback. The inbound
// adapters prefetch snapshots before the shared reconcile core, so its gate
// remains synchronous without retaining a second enablement mechanism.
export const telegramEnvAllowsClient = (clientId, envObj = process.env) => {
  if (env('TELEGRAM_ENABLED', envObj).toLowerCase() !== 'true') return false;
  const allow = env('TELEGRAM_CLIENTS', envObj).split(',').map((value) => value.trim()).filter(Boolean);
  return allow.length > 0 && allow.includes(String(clientId || '').trim());
};

// Owner-ask bodies render CODE-SIDE (like SMS's renderSmsTemplate, unlike
// WhatsApp's Meta-registered templates), so the assistant's per-client display
// name interpolates directly and there is no template variable dance. Keep the
// copy identical to renderSmsTemplate so the owner reads the same question
// regardless of channel. Callers without a client profile omit assistantName →
// 'Donna'.
//
// The copy follows the owner's language (preferredOwnerTemplateLanguage, passed
// in as `language`); anything but 'fi' gets the English copy, unchanged. The
// Finnish copy follows the Telegram voice rule (no em or en dashes). "Ref:"
// stays verbatim because extractAskRef anchors a reply on the word "ref".
const fiCount = (value, one, many) => `${value} ${String(value).trim() === '1' ? one : many}`;
const fiSentence = (text) => (/[.?!:]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()}.`);
const capitalize = (text) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : text);

const TELEGRAM_TEMPLATE_COPY = Object.freeze({
  en: Object.freeze({
    defaultTail: "reply with a photo, answer in words, or reply 'not sure'",
    donna_evidence_ask_v1: ({ name, period = 'this period', question = 'one thing', askRef = 'ASK', tail }) =>
      `${name} needs one thing for ${period}: ${question} — ${tail}. Ref: ${askRef}`,
    donna_close_queue_v1: ({ name, period = 'this period', openItems = '0', missingReceipts = '0' }) =>
      `${name} is almost ready to close ${period}. Open: ${openItems} questions, ${missingReceipts} missing receipts. Reply 'show' to go through them one by one.`,
    donna_decision_check_v1: ({ name, transactionShort = 'this transaction', category = 'the selected category', askRef = 'ASK' }) =>
      `${name} treated ${transactionShort} as ${category} based on your past rules. Reply 'correct' or 'wrong'. Ref: ${askRef}`
  }),
  fi: Object.freeze({
    defaultTail: "vastaa kuvalla, kirjoita vastaus tai vastaa 'en ole varma'",
    donna_evidence_ask_v1: ({ name, period = 'tämä kausi', question = 'yksi asia', askRef = 'ASK', tail }) =>
      `${name} tarvitsee sinulta yhden asian (${period}): ${fiSentence(question)} ${capitalize(tail)}. Ref: ${askRef}`,
    donna_close_queue_v1: ({ name, period = 'tämä kausi', openItems = '0', missingReceipts = '0' }) =>
      `${name} on melkein valmis sulkemaan kauden (${period}). Avoinna: ${fiCount(openItems, 'kysymys', 'kysymystä')}, ${fiCount(missingReceipts, 'puuttuva kuitti', 'puuttuvaa kuittia')}. Vastaa 'näytä', niin käydään ne läpi yksi kerrallaan.`,
    donna_decision_check_v1: ({ name, transactionShort = 'tämän tapahtuman', category = 'valittu luokka', askRef = 'ASK' }) =>
      `${name} kirjasi ${transactionShort} aiempien sääntöjesi perusteella näin: ${category}. Vastaa 'oikein' tai 'väärin'. Ref: ${askRef}`
  })
});

const telegramCopyFor = (language) => TELEGRAM_TEMPLATE_COPY[language] || TELEGRAM_TEMPLATE_COPY.en;

export const renderTelegramTemplate = ({ templateName, bodyParameters = [], assistantName = null, language = 'en' } = {}) => {
  const name = resolveAssistantName({ assistant_name: assistantName });
  const copy = telegramCopyFor(language);
  if (templateName === 'donna_evidence_ask_v1') {
    // The 4th parameter is the AFFORDANCE TAIL (askIdentity.renderAskAffordanceTail).
    // It is optional and defaults to the historical string, so every caller that
    // does not pass one renders byte-identically to before. Callers that DO pass
    // one can drop "reply with a photo" for a document-anchored ask, where Donna
    // is already holding the photo and asking for it reads as nonsense (the
    // 2026-07-29 KUILI report).
    const [period, question, askRef, affordanceTail = ''] = bodyParameters;
    const tail = String(affordanceTail || '').trim() || copy.defaultTail;
    return copy.donna_evidence_ask_v1({ name, period, question, askRef, tail });
  }
  if (templateName === 'donna_close_queue_v1') {
    const [period, openItems, missingReceipts] = bodyParameters;
    return copy.donna_close_queue_v1({ name, period, openItems, missingReceipts });
  }
  if (templateName === 'donna_decision_check_v1') {
    const [transactionShort, category, askRef] = bodyParameters;
    return copy.donna_decision_check_v1({ name, transactionShort, category, askRef });
  }
  return String(bodyParameters[0] || '');
};

// ── The consolidated ask digest ─────────────────────────────────────────────
//
// A batch of open questions used to fan out as ONE TELEGRAM MESSAGE PER ASK
// (deliverTelegramEvidenceAsksAfterSend looped `for (const askId of ids)`), so
// waking a quiet client could dump five or more separate messages into the
// owner's chat at once. The email deliverer right beside it had already made
// the opposite call, and said why: "ONE email per batch (email is a workbench,
// not a chat stream)". A chat is even less of a worklist than an inbox, so the
// same rule applies here.
//
// This composes the batch into a single numbered message. Each item keeps its
// own Ref, which is what lets an owner answer just one of them, and the portal
// link rides along as the alternative surface for anyone who would rather do
// them all at once (or on another device) than answer in chat.
//
// Pure: no I/O, no env, no clock. The caller resolves the link and the flag.
export const TELEGRAM_ASK_DIGEST_TEMPLATE = 'donna_evidence_ask_digest_v1';

// Telegram's hard limit is 4096 characters. Stay well under it and spill the
// remainder to the portal rather than risk a send failure that would lose the
// whole batch: an owner who sees eight of twelve questions plus "the rest are
// in your portal" is strictly better served than one who sees none.
export const TELEGRAM_ASK_DIGEST_MAX_ITEMS = 8;
export const TELEGRAM_ASK_DIGEST_MAX_CHARS = 3500;

const plural = (count, one, many) => (count === 1 ? one : many);

// Digest wording per owner language. English is the historical copy, unchanged.
const TELEGRAM_DIGEST_COPY = Object.freeze({
  en: Object.freeze({
    periodFallback: 'this period',
    headerPeriod: (name, count, period) => `${name} needs ${count} ${plural(count, 'thing', 'things')} for ${period}:`,
    headerMixed: (name, count) => `${name} needs ${count} ${plural(count, 'thing', 'things')} from you:`,
    replyHint: "Reply here with a photo or in words. If you're answering just one, mention its Ref.",
    remaining: (count) => `${count} more ${plural(count, 'question is', 'questions are')} waiting in your portal.`,
    portal: 'You can also answer them all in your portal:'
  }),
  fi: Object.freeze({
    periodFallback: 'tämä kausi',
    headerPeriod: (name, count, period) => `${name} tarvitsee sinulta ${count} ${plural(count, 'asian', 'asiaa')} (${period}):`,
    headerMixed: (name, count) => `${name} tarvitsee sinulta ${count} ${plural(count, 'asian', 'asiaa')}:`,
    replyHint: 'Vastaa tähän kuvalla tai kirjoittamalla. Jos vastaat vain yhteen, mainitse sen Ref.',
    remaining: (count) => `${plural(count, 'Yksi kysymys', `${count} kysymystä`)} lisää odottaa portaalissasi.`,
    portal: 'Voit myös vastata kaikkiin portaalissasi:'
  })
});

// items: [{ question, askRef, period }] — question is already sanitized and
// length-capped by askSafety.prepareOwnerAskQuestion at the call site.
export const buildTelegramAskDigestText = ({
  assistantName = null,
  items = [],
  portalUrl = null,
  language = 'en',
  maxItems = TELEGRAM_ASK_DIGEST_MAX_ITEMS,
  maxChars = TELEGRAM_ASK_DIGEST_MAX_CHARS
} = {}) => {
  const name = resolveAssistantName({ assistant_name: assistantName });
  const copy = TELEGRAM_DIGEST_COPY[language] || TELEGRAM_DIGEST_COPY.en;
  const all = (Array.isArray(items) ? items : []).filter((item) => item && String(item.question || '').trim());
  if (!all.length) return '';

  // A period only earns a mention when the batch does NOT share one. Repeating
  // "for June 2026" on every line is noise when it is true of all of them.
  const periods = new Set(all.map((item) => String(item.period || '').trim() || copy.periodFallback));
  const commonPeriod = periods.size === 1 ? [...periods][0] : null;

  const shown = [];
  let budget = maxChars;
  for (const item of all) {
    if (shown.length >= maxItems) break;
    const question = String(item.question).replace(/\s+/g, ' ').trim();
    const ref = String(item.askRef || '').trim();
    const period = String(item.period || '').trim() || copy.periodFallback;
    const prefix = commonPeriod ? '' : `[${period}] `;
    const line = `${shown.length + 1}. ${prefix}${question}${ref ? ` Ref: ${ref}` : ''}`;
    if (line.length > budget) break;
    budget -= line.length + 1;
    shown.push(line);
  }
  // Nothing fit (a single pathologically long question): let the caller fall
  // back to the per-ask path rather than send an empty digest.
  if (!shown.length) return '';

  const remaining = all.length - shown.length;
  const header = commonPeriod
    ? copy.headerPeriod(name, all.length, commonPeriod)
    : copy.headerMixed(name, all.length);

  const footer = ['', copy.replyHint];
  if (remaining > 0) {
    footer.push(copy.remaining(remaining));
  }
  if (portalUrl) {
    footer.push(copy.portal);
    footer.push(portalUrl);
  }
  return [header, '', ...shown, ...footer].join('\n');
};

// Free-form send. `chatId` is Telegram's stable per-chat integer (stored as a
// string in the binding's phone_e164 slot). Callers on the inbound path pass
// `to` (= the chat_id string) to match the sendText({ to, text }) shape the
// reconcile core uses; both resolve to the same target. Returns the same
// { ok, id, body } shape as sendWhatsAppText / sendSmsText — id is the outbound
// message_id (stringified) so a tapped reply can anchor back to it.
export const sendTelegramMessage = async ({ chatId, to, text, deps = {} } = {}) => {
  const fetchImpl = deps.fetchImpl || fetch;
  const botToken = deps.botToken ?? env('TELEGRAM_BOT_TOKEN');
  const target = chatId ?? to;
  if (!botToken) return { ok: false, skipped: true, reason: 'TELEGRAM_NOT_CONFIGURED' };
  if (target == null || String(target).trim() === '' || !text) {
    return { ok: false, error: 'sendTelegramMessage requires `chatId` and `text`.' };
  }
  try {
    const response = await fetchImpl(telegramApiUrl({ botToken }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text })
    });
    const body = await response.json().catch(() => ({}));
    // Telegram signals application errors with ok:false + description even on a
    // 200, so check both the HTTP status and the body flag.
    if (!response.ok || body?.ok === false) {
      return { ok: false, status: response.status, error: body?.description || `Telegram returned ${response.status}.`, body };
    }
    const messageId = body?.result?.message_id;
    return { ok: true, id: messageId != null ? String(messageId) : null, body };
  } catch (error) {
    return { ok: false, error: error?.message || 'Telegram request failed.' };
  }
};

// sendText({ to, text }) adapter for the reconcile core's config.sendText.
export const sendTelegramText = ({ to, chatId, text, deps = {} } = {}) =>
  sendTelegramMessage({ chatId: chatId ?? to, text, deps });

// deliverOwnerMessage's TELEGRAM branch renders code-side then sends free-form.
export const sendTelegramTemplate = ({ to, chatId, templateName, bodyParameters = [], assistantName = null, language = 'en', deps = {} } = {}) =>
  sendTelegramMessage({ chatId: chatId ?? to, text: renderTelegramTemplate({ templateName, bodyParameters, assistantName, language }), deps });
