import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_TOPIC_REMINDERS_FLAG_KEY,
  buildEvidenceTopicReminderState,
  buildEvidenceTopicReminderText,
  runEvidenceTopicReminderSweep,
  selectDueEvidenceTopicReminders,
  sendEvidenceTopicReminderViaBoundChannel
} from './evidenceTopicReminders.js';

// A db-client fake for the bound-channel sender: binding readers query
// client_whatsapp_bindings by channel; the responder map answers per channel
// and everything else (delivery ledger insert) gets { rows: [] }.
const bindingDbClient = (bindings = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/client_whatsapp_bindings/.test(sql)) {
        if (/'telegram'/.test(sql)) return { rows: bindings.telegram ? [bindings.telegram] : [] };
        if (/'sms'/.test(sql)) return { rows: bindings.sms ? [bindings.sms] : [] };
        return { rows: bindings.whatsapp ? [bindings.whatsapp] : [] };
      }
      return { rows: [] };
    }
  };
};

const openTopicRequest = (overrides = {}) => ({
  id: overrides.id || 'ask-1',
  firm_id: overrides.firm_id || 'firm-1',
  client_id: overrides.client_id || 'client-1',
  status: overrides.status || 'open',
  question: overrides.question || 'Please send the Exxon receipt.',
  request_payload: {
    evidence_topic: {
      version: 1,
      status: 'open',
      current_need: 'Please send the Exxon receipt.',
      last_owner_message_at: '2026-07-12T10:00:00.000Z',
      last_donna_message_at: null,
      last_assessment: { outcome: 'defer_later', can_resolve: false, still_missing: ['receipt'], reason: 'owner_deferred_evidence' },
      turns: [{ reply_excerpt: "I'll send it tomorrow", outcome: 'defer_later' }],
      ...(overrides.topic || {})
    },
    ...(overrides.payload || {})
  }
});

test('selectDueEvidenceTopicReminders filters to quiet open evidence topics', () => {
  const due = selectDueEvidenceTopicReminders({
    now: '2026-07-14T10:00:00.000Z',
    requests: [
      openTopicRequest({ id: 'due' }),
      openTopicRequest({ id: 'recent-owner', topic: { last_owner_message_at: '2026-07-14T09:00:00.000Z' } }),
      openTopicRequest({ id: 'recent-donna', topic: { last_donna_message_at: '2026-07-14T09:00:00.000Z' } }),
      openTopicRequest({ id: 'answered', topic: { status: 'answered' } }),
      openTopicRequest({ id: 'resolved', status: 'resolved' })
    ]
  });
  assert.deepEqual(due.map((item) => item.request.id), ['due']);
});

test('buildEvidenceTopicReminderState stamps Donna reminder metadata without closing the topic', () => {
  const next = buildEvidenceTopicReminderState({
    topic: { status: 'open', reminder_count: 1, current_need: 'Need receipt' },
    now: '2026-07-14T10:00:00.000Z',
    messageId: 'wamid.reminder'
  });
  assert.equal(next.status, 'open');
  assert.equal(next.reminder_count, 2);
  assert.equal(next.last_donna_message_at, '2026-07-14T10:00:00.000Z');
  assert.equal(next.last_reminder_message_id, 'wamid.reminder');
});

test('buildEvidenceTopicReminderText is short and anchored to the current need', () => {
  const text = buildEvidenceTopicReminderText({
    request: openTopicRequest(),
    topic: openTopicRequest().request_payload.evidence_topic
  });
  assert.match(text, /Quick reminder/);
  assert.match(text, /Exxon receipt/);
});

test('runEvidenceTopicReminderSweep is born dark on the config plane', async () => {
  let sent = 0;
  const result = await runEvidenceTopicReminderSweep({
    firmId: 'firm-1',
    now: '2026-07-14T10:00:00.000Z',
    deps: {
      listOpenEvidenceTopics: async () => [openTopicRequest()],
      sendReminder: async () => { sent += 1; return { message_id: 'm1' }; },
      stampReminder: async () => { throw new Error('must not stamp while flag is dark'); },
      withFirmDbClient: async () => ({})
    }
  });
  assert.equal(EVIDENCE_TOPIC_REMINDERS_FLAG_KEY, 'EVIDENCE_TOPIC_REMINDERS');
  assert.equal(result.held, 1);
  assert.equal(result.sent, 0);
  assert.equal(sent, 0);
});

test('a Telegram-only client is no longer skipped: third rung after WhatsApp and SMS, chat id from the binding', async () => {
  const db = bindingDbClient({
    telegram: { phone_e164: 'tg-chat-42', phone_hash: 'hash-tg', channel: 'telegram' }
  });
  const sentTelegram = [];
  const result = await sendEvidenceTopicReminderViaBoundChannel({
    firmId: 'firm-1',
    clientId: 'client-1',
    evidenceRequestId: 'ask-1',
    text: 'Quick reminder: Please send the Exxon receipt.',
    now: '2026-07-14T10:00:00.000Z',
    env: { TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'client-1' },
    deps: {
      withFirmDbClient: async (fn) => fn(db),
      sendWhatsAppText: async () => { throw new Error('whatsapp must not send for an unbound channel'); },
      sendSmsText: async () => { throw new Error('sms must not send for an unbound channel'); },
      sendTelegramText: async (args) => { sentTelegram.push(args); return { ok: true, id: 'tg-msg-1' }; }
    }
  });
  assert.equal(result.channel, 'telegram');
  assert.equal(result.message_id, 'tg-msg-1');
  assert.equal(sentTelegram[0].chatId, 'tg-chat-42');
  // The delivery ledger row rides the telegram provider.
  const ledgerWrite = db.queries.find((entry) => /message_delivery/.test(entry.sql) || /insert/.test(entry.sql));
  assert.ok(ledgerWrite, 'a delivery ledger row is recorded');
});

test('WhatsApp precedence is byte-identical: a WhatsApp-bound client never consults the Telegram binding', async () => {
  const db = bindingDbClient({
    whatsapp: { phone_e164: '+447700900000', phone_hash: 'hash-wa', channel: 'whatsapp' },
    telegram: { phone_e164: 'tg-chat-42', phone_hash: 'hash-tg', channel: 'telegram' }
  });
  const result = await sendEvidenceTopicReminderViaBoundChannel({
    firmId: 'firm-1',
    clientId: 'client-1',
    evidenceRequestId: 'ask-1',
    text: 'Quick reminder: Please send the Exxon receipt.',
    env: {},
    deps: {
      withFirmDbClient: async (fn) => fn(db),
      sendWhatsAppText: async () => ({ ok: true, id: 'wa-msg-1' }),
      sendSmsText: async () => { throw new Error('sms must not send when whatsapp is bound'); },
      sendTelegramText: async () => { throw new Error('telegram must not send when whatsapp is bound'); }
    }
  });
  assert.equal(result.channel, 'whatsapp');
  assert.equal(db.queries.filter((entry) => /'telegram'/.test(entry.sql)).length, 0, 'telegram binding never read');
});

test('a Telegram binding with the channel env gate dark skips by name, never sends', async () => {
  const db = bindingDbClient({
    telegram: { phone_e164: 'tg-chat-42', phone_hash: 'hash-tg', channel: 'telegram' }
  });
  const result = await sendEvidenceTopicReminderViaBoundChannel({
    firmId: 'firm-1',
    clientId: 'client-1',
    evidenceRequestId: 'ask-1',
    text: 'Quick reminder: Please send the Exxon receipt.',
    env: {},
    deps: {
      withFirmDbClient: async (fn) => fn(db),
      sendTelegramText: async () => { throw new Error('must not send while the env gate is dark'); }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'telegram_env_dark');
});

test('a sensitive-identifier reminder is blocked on EVERY channel, same as the ask deliverers', async () => {
  const db = bindingDbClient({
    whatsapp: { phone_e164: '+447700900000', phone_hash: 'hash-wa', channel: 'whatsapp' }
  });
  const result = await sendEvidenceTopicReminderViaBoundChannel({
    firmId: 'firm-1',
    clientId: 'client-1',
    evidenceRequestId: 'ask-1',
    text: 'Quick reminder: please reply with your passport number.',
    env: {},
    deps: {
      withFirmDbClient: async (fn) => fn(db),
      sendWhatsAppText: async () => { throw new Error('a blocked text must never send'); }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sensitive_ask_portal_only');
});

test('runEvidenceTopicReminderSweep sends and stamps when the config-plane flag acts', async () => {
  const sent = [];
  const stamped = [];
  const result = await runEvidenceTopicReminderSweep({
    firmId: 'firm-1',
    now: '2026-07-14T10:00:00.000Z',
    deps: {
      listOpenEvidenceTopics: async () => [openTopicRequest()],
      sendReminder: async (args) => { sent.push(args); return { message_id: 'msg-reminder' }; },
      stampReminder: async (args) => { stamped.push(args); return { evidence_topic: args.topicState }; },
      withFirmDbClient: async (fn) => fn({
        query: async () => ({ rows: [{ flag_key: EVIDENCE_TOPIC_REMINDERS_FLAG_KEY, stage: 'canary', source: 'test', client_id: 'client-1' }] })
      })
    }
  });
  assert.equal(result.sent, 1);
  assert.equal(sent[0].clientId, 'client-1');
  assert.equal(stamped[0].topicState.status, 'open');
  assert.equal(stamped[0].topicState.last_reminder_message_id, 'msg-reminder');
});

test('one owner for channel reminders: where the re-ask cadence acts, this sweep defers to it', async () => {
  let sent = 0;
  const result = await runEvidenceTopicReminderSweep({
    firmId: 'firm-1',
    now: '2026-07-14T10:00:00.000Z',
    deps: {
      listOpenEvidenceTopics: async () => [openTopicRequest()],
      sendReminder: async () => { sent += 1; return { message_id: 'm1' }; },
      stampReminder: async () => { throw new Error('must not stamp a deferred reminder'); },
      withFirmDbClient: async (fn) => fn({
        query: async () => ({ rows: [
          { flag_key: EVIDENCE_TOPIC_REMINDERS_FLAG_KEY, stage: 'canary', source: 'test', client_id: 'client-1' },
          { flag_key: 'ASK_REASK_CADENCE', stage: 'canary', source: 'test', client_id: 'client-1' }
        ] })
      })
    }
  });
  assert.equal(sent, 0, 'no second reminder');
  assert.equal(result.deferred, 1);
  assert.equal(result.sent, 0);
});
