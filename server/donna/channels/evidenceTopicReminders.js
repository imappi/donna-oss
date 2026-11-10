import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import {
  getActiveSmsBindingForClientInDb,
  getActiveTelegramBindingForClientInDb,
  getActiveWhatsAppBindingForClientInDb,
  getClientOwnerLanguageInDb,
  listOpenEvidenceTopicsForReminderInDb,
  recordMessageDeliveryLedgerInDb,
  stampEvidenceTopicReminderInDb,
  withFirmDbClient
} from '../firmDb.js';
import { REASK_CADENCE_FLAG_KEY } from '../askReaskCadence.js';
import { gateOwnerSendWithClient } from '../ownerAskDelivery.js';
import { prepareOwnerAskQuestion } from './askSafety.js';
import { sendSmsText } from './sms.js';
import { sendTelegramText, telegramEnvAllowsClient } from './telegram.js';
import { sendWhatsAppText } from './whatsapp.js';

export const EVIDENCE_TOPIC_REMINDERS_FLAG_KEY = 'EVIDENCE_TOPIC_REMINDERS';

const DEFAULT_LIMIT = 25;
const DEFAULT_OWNER_QUIET_HOURS = 24;
const DEFAULT_REMINDER_QUIET_HOURS = 48;
const MS_PER_HOUR = 60 * 60 * 1000;

const asDateMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const clean = (value = '', max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

// Reminder wording per owner language (preferredOwnerTemplateLanguage). English
// is the historical copy, unchanged; 'fi' is everyday sinä-form Finnish.
const fiNeed = (need) => (/[.?!]$/.test(need) ? need : `${need}.`);
const EVIDENCE_TOPIC_REMINDER_COPY = Object.freeze({
  en: Object.freeze({
    needFallback: 'that open item',
    deferLater: (need) => `Quick reminder: ${need}. Send the answer or attach the evidence when you have it.`,
    clarification: (need) => `Quick reminder: ${need}. If the question was unclear, reply here and I’ll keep it with the open request.`,
    general: (need) => `Quick reminder: ${need}. Reply here or in the portal when you have it.`
  }),
  fi: Object.freeze({
    needFallback: 'avoin asia',
    deferLater: (need) => `Pieni muistutus: ${fiNeed(need)} Lähetä vastaus tai liitä tosite, kun se on sinulla.`,
    clarification: (need) => `Pieni muistutus: ${fiNeed(need)} Jos kysymys oli epäselvä, vastaa tähän, niin liitän viestisi avoimeen pyyntöön.`,
    general: (need) => `Pieni muistutus: ${fiNeed(need)} Vastaa tähän tai portaalissa, kun sinulla on vastaus.`
  })
});

export const buildEvidenceTopicReminderText = ({ request = {}, topic = {}, language = 'en' } = {}) => {
  const copy = EVIDENCE_TOPIC_REMINDER_COPY[language] || EVIDENCE_TOPIC_REMINDER_COPY.en;
  const need = clean(topic.current_need || request.question || copy.needFallback, 240);
  const outcome = clean(topic.last_assessment?.outcome || '', 80).replace(/_/g, ' ');
  if (outcome === 'defer later') return copy.deferLater(need);
  if (outcome === 'clarification requested') return copy.clarification(need);
  return copy.general(need);
};

export const selectDueEvidenceTopicReminders = ({
  requests = [],
  now,
  ownerQuietHours = DEFAULT_OWNER_QUIET_HOURS,
  reminderQuietHours = DEFAULT_REMINDER_QUIET_HOURS,
  limit = DEFAULT_LIMIT
} = {}) => {
  const nowMs = asDateMs(now);
  if (nowMs == null) return [];
  const ownerQuietMs = Math.max(Number(ownerQuietHours) || DEFAULT_OWNER_QUIET_HOURS, 0) * MS_PER_HOUR;
  const reminderQuietMs = Math.max(Number(reminderQuietHours) || DEFAULT_REMINDER_QUIET_HOURS, 0) * MS_PER_HOUR;
  const boundedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 200);

  return (Array.isArray(requests) ? requests : [])
    .filter((request) => request?.status === 'open')
    .map((request) => {
      const topic = request.request_payload?.evidence_topic;
      if (!topic || typeof topic !== 'object' || topic.status !== 'open') return null;
      const lastOwnerMs = asDateMs(topic.last_owner_message_at);
      const lastDonnaMs = asDateMs(topic.last_donna_message_at);
      if (lastOwnerMs != null && nowMs - lastOwnerMs < ownerQuietMs) return null;
      if (lastDonnaMs != null && nowMs - lastDonnaMs < reminderQuietMs) return null;
      return { request, topic };
    })
    .filter(Boolean)
    .slice(0, boundedLimit);
};

export const buildEvidenceTopicReminderState = ({ topic = {}, now, messageId = null } = {}) => ({
  ...topic,
  last_donna_message_at: now,
  reminder_count: Math.max(Number(topic.reminder_count) || 0, 0) + 1,
  last_reminder_message_id: messageId || topic.last_reminder_message_id || null
});

export const sendEvidenceTopicReminderViaBoundChannel = async ({
  firmId,
  clientId,
  evidenceRequestId,
  text,
  language = null,
  now = new Date().toISOString(),
  env = process.env,
  deps = {}
} = {}) => {
  const withClient = deps.withFirmDbClient || withFirmDbClient;
  const sendWhatsApp = deps.sendWhatsAppText || sendWhatsAppText;
  const sendSms = deps.sendSmsText || sendSmsText;
  const sendTelegram = deps.sendTelegramText || sendTelegramText;
  return withClient(async (client) => {
    const whatsapp = await getActiveWhatsAppBindingForClientInDb({ client, firmId, clientId });
    const sms = whatsapp ? null : await getActiveSmsBindingForClientInDb({ client, firmId, clientId });
    // Telegram is the THIRD rung, consulted only when neither phone channel is
    // bound — the WhatsApp→SMS precedence above stays byte-identical. Before
    // this branch a Telegram-only client was skipped 'unbound' forever (audit
    // §4: the sweep "targets WhatsApp/SMS but never Telegram").
    const telegram = (whatsapp || sms) ? null : await getActiveTelegramBindingForClientInDb({ client, firmId, clientId });
    const binding = whatsapp || sms || telegram;
    const channel = whatsapp ? 'whatsapp' : (sms ? 'sms' : (telegram ? 'telegram' : null));
    if (!binding || !channel) return { ok: false, skipped: true, reason: 'unbound' };
    // The Telegram channel's own env allowlist gate (legacy pair, retained as
    // the stage-1 config-plane fallback) — same as every other Telegram send.
    if (channel === 'telegram' && !telegramEnvAllowsClient(clientId, env)) {
      return { ok: false, skipped: true, reason: 'telegram_env_dark' };
    }
    // The sensitive-identifier guard every ask DELIVERER already applies
    // (deliverWhatsApp/Sms/TelegramEvidenceAsksAfterSend) — a reminder repeats
    // the same question content over the same channels, so it takes the same
    // guard: a blocked text is skipped by name, never sent.
    const safe = prepareOwnerAskQuestion(text);
    if (safe.blocked) return { ok: false, skipped: true, reason: safe.reason || 'sensitive_ask_portal_only' };
    const sendText = safe.text;
    const result = channel === 'whatsapp'
      ? await sendWhatsApp({ to: binding.phone_e164, text: sendText })
      : channel === 'sms'
        ? await sendSms({ to: binding.phone_e164, text: sendText })
        // Telegram bindings store the chat id in phone_e164 (migration 088).
        : await sendTelegram({ chatId: binding.phone_e164, text: sendText });
    const messageId = result?.id || result?.message_id || `evidence_topic_reminder_${evidenceRequestId}`;
    await recordMessageDeliveryLedgerInDb({
      client,
      entry: {
        message_id: messageId,
        channel,
        provider: channel === 'whatsapp' ? 'meta' : (channel === 'sms' ? 'twilio' : 'telegram'),
        ask_id: evidenceRequestId,
        client_id: clientId,
        recipient_phone_hash: binding.phone_hash,
        template_name: 'evidence_topic_reminder_v1',
        sent_at: result?.ok === false ? null : now,
        failed_at: result?.ok === false ? now : null,
        failure_reason: result?.ok === false ? (result.reason || result.error || 'SEND_FAILED') : null,
        provider_payload: { reminder: { status: result?.ok === false ? 'failed' : 'sent', ...(language ? { language } : {}) } }
      }
    });
    return { ...result, id: messageId, message_id: messageId, channel };
  });
};

export const runEvidenceTopicReminderSweep = async ({
  firmId,
  clientId = null,
  now = new Date().toISOString(),
  limit = DEFAULT_LIMIT,
  env = process.env,
  deps = {}
} = {}) => {
  const listOpenEvidenceTopics = deps.listOpenEvidenceTopics || listOpenEvidenceTopicsForReminderInDb;
  const stampReminder = deps.stampReminder || stampEvidenceTopicReminderInDb;
  const sendReminder = deps.sendReminder || ((args) => sendEvidenceTopicReminderViaBoundChannel({ ...args, now, env, deps }));
  const withClient = deps.withFirmDbClient || withFirmDbClient;
  const getOwnerLanguage = deps.getOwnerLanguage || getClientOwnerLanguageInDb;

  const requests = await listOpenEvidenceTopics({ firmId, clientId, limit });
  const candidates = selectDueEvidenceTopicReminders({ requests, now, limit });
  const stats = { skipped: false, considered: candidates.length, sent: 0, held: 0, deferred: 0, refused: 0, failed: 0 };
  const snapshots = new Map();
  const sendGates = new Map();
  // The owner's language, read once per client (wording only).
  const languages = new Map();

  for (const candidate of candidates) {
    const request = candidate.request;
    const key = `${request.firm_id || firmId}:${request.client_id}`;
    if (!snapshots.has(key)) {
      const snapshot = await withClient((client) => readClientConfigSnapshot(client, {
        firmId: request.firm_id || firmId,
        clientId: request.client_id
      })).catch(() => ({}));
      snapshots.set(key, snapshot);
    }
    const acts = clientFlagActs({
      flagKey: EVIDENCE_TOPIC_REMINDERS_FLAG_KEY,
      snapshot: snapshots.get(key),
      envFallback: () => false,
      env
    });
    if (!acts) {
      stats.held += 1;
      continue;
    }
    // One owner for owner-channel reminders: where the re-ask cadence ACTS
    // for this client, its sweep (askReaskCadence.js) reminds every overdue
    // open ask through the first-send fan-out and escalates the unanswered
    // ones. Reminding here as well would message the owner twice about the
    // same question, so this sweep defers to it.
    if (clientFlagActs({ flagKey: REASK_CADENCE_FLAG_KEY, snapshot: snapshots.get(key), envFallback: () => false, env })) {
      stats.deferred += 1;
      continue;
    }
    // The ONE owner-send gate every owner message passes (ownerAskDelivery.js:
    // pilot send containment + entity-readiness admission at 'ask_send'), read
    // once per client per sweep. Refused ⇒ nothing sent, nothing stamped, and
    // the refusal is receipted for the operator ('evidence_request.send_refused').
    if (!sendGates.has(key)) {
      const clientCandidateIds = candidates
        .filter((c) => `${c.request.firm_id || firmId}:${c.request.client_id}` === key)
        .map((c) => c.request.id);
      const gate = await withClient((client) => gateOwnerSendWithClient({
        client, firmId: request.firm_id || firmId, clientId: request.client_id,
        surface: 'evidence_topic_reminder', evidenceRequestIds: clientCandidateIds, deps
      })).catch(() => ({ allowed: false, code: 'SEND_GATE_UNREADABLE' }));
      sendGates.set(key, gate);
    }
    if (!sendGates.get(key).allowed) {
      stats.refused += 1;
      continue;
    }

    try {
      if (!languages.has(key)) {
        languages.set(key, await getOwnerLanguage({ firmId: request.firm_id || firmId, clientId: request.client_id }).catch(() => 'en'));
      }
      const language = languages.get(key);
      const delivery = await sendReminder({
        firmId: request.firm_id || firmId,
        clientId: request.client_id,
        evidenceRequestId: request.id,
        text: buildEvidenceTopicReminderText({ request, topic: candidate.topic, language }),
        language,
        request,
        topic: candidate.topic
      });
      if (delivery?.ok === false) throw new Error(delivery.reason || delivery.error || 'SEND_FAILED');
      const nextTopic = buildEvidenceTopicReminderState({
        topic: candidate.topic,
        now,
        messageId: delivery?.message_id || delivery?.id || null
      });
      await stampReminder({
        firmId: request.firm_id || firmId,
        evidenceRequestId: request.id,
        topicState: nextTopic,
        actorId: 'evidence_topic_reminder_sweep'
      });
      stats.sent += 1;
    } catch {
      stats.failed += 1;
    }
  }
  return stats;
};
