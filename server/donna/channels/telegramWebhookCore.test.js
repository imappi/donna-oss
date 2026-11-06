// Telegram webhook core — the first tests on this handler's pure layer
// (the 2026-07-30 audit found NO webhook handler had any test). The
// load-bearing piece is telegramSenderVerdict (audit L5): before it, identity
// was chat.id alone, so any member of a group containing the bot spoke as the
// bound owner.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTelegramStartToken,
  isBareTelegramStart,
  telegramChatKey,
  telegramSenderVerdict,
  verifyTelegramWebhookSecret
} from './telegramWebhookCore.js';

const privateMessage = (overrides = {}) => ({
  message_id: 1,
  chat: { id: 42, type: 'private' },
  from: { id: 42, is_bot: false },
  text: 'hello',
  ...overrides
});

test('telegramSenderVerdict accepts the legitimate private-chat owner message', () => {
  assert.deepEqual(telegramSenderVerdict(privateMessage()), { ok: true, reason: null });
});

test('telegramSenderVerdict refuses group and supergroup chats (the L5 hole)', () => {
  // A group's chat.id is shared by every member — if that id were bound, any
  // member's message would have spoken as the owner.
  for (const type of ['group', 'supergroup', 'channel']) {
    const verdict = telegramSenderVerdict({
      chat: { id: -100123, type },
      from: { id: 777, is_bot: false },
      text: 'recategorize everything as personal'
    });
    assert.equal(verdict.ok, false, `${type} must not reach the owner loop`);
    assert.equal(verdict.reason, 'group_chat_unsupported');
  }
});

test('telegramSenderVerdict refuses a missing chat.type rather than assuming private', () => {
  const verdict = telegramSenderVerdict({ chat: { id: 42 }, from: { id: 42 }, text: 'hi' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'group_chat_unsupported');
});

test('telegramSenderVerdict refuses bot senders and sender/chat mismatches', () => {
  assert.equal(
    telegramSenderVerdict(privateMessage({ from: { id: 42, is_bot: true } })).reason,
    'bot_sender'
  );
  assert.equal(
    telegramSenderVerdict(privateMessage({ from: { id: 999, is_bot: false } })).reason,
    'sender_chat_mismatch'
  );
});

test('telegramSenderVerdict tolerates an absent from on a private chat', () => {
  // Telegram always sends `from` on private messages; if it is ever absent the
  // chat.type === 'private' check is the guard that still holds.
  assert.equal(telegramSenderVerdict(privateMessage({ from: undefined })).ok, true);
});

test('start-token extraction stays strict and the chat key is a trimmed string', () => {
  assert.equal(extractTelegramStartToken('/start abcdefgh12345678'), 'abcdefgh12345678');
  assert.equal(extractTelegramStartToken('/start short'), '');
  assert.equal(isBareTelegramStart('/start'), true);
  assert.equal(telegramChatKey(42), '42');
});

test('webhook secret verification fails closed without a configured secret', () => {
  assert.equal(verifyTelegramWebhookSecret({ header: 'anything', secret: '' }), false);
  assert.equal(verifyTelegramWebhookSecret({ header: 's3cret', secret: 's3cret' }), true);
  assert.equal(verifyTelegramWebhookSecret({ header: 'wrong', secret: 's3cret' }), false);
});
