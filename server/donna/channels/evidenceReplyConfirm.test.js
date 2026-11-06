import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendReplyReconciledConfirmation,
  EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY
} from './evidenceReplyConfirm.js';

const CHANNEL_ON = { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client-1' };
const TELEGRAM_ON = { TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'client-1' };
const appliedRecode = { applied: true, posted: true, suggestion: { account_label: 'Meals & Entertainment' } };

const makeDeps = ({ binding = { phone_e164: '+358401234567', phone_hash: 'hash-1' }, telegramBinding = { phone_e164: '987654321', phone_hash: 'hash-tg' }, stage = 'canary', sendResult = { ok: true, id: 'wamid.confirm' }, telegramSendResult = { ok: true, id: 'tg.confirm' } } = {}) => {
  const ledger = [];
  const sent = [];
  const deps = {
    withFirmDbClient: async (fn) => fn({}),
    readClientConfigSnapshot: async () => (stage ? { [EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY]: { stage } } : {}),
    getActiveWhatsAppBinding: async () => binding,
    getActiveTelegramBinding: async () => telegramBinding,
    recordMessageDeliveryLedger: async ({ entry }) => { ledger.push(entry); return entry; },
    sendWhatsAppText: async (args) => { sent.push({ ...args, via: 'whatsapp' }); return sendResult; },
    sendTelegramText: async (args) => { sent.push({ ...args, via: 'telegram' }); return telegramSendResult; }
  };
  return { deps, ledger, sent };
};

test('does nothing when the recode did not apply', async () => {
  const { deps, sent } = makeDeps();
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', recode: { applied: false }, env: CHANNEL_ON, deps });
  assert.equal(r.skipped, 'not_applied');
  assert.equal(sent.length, 0);
});

test('does nothing when no account resolved — never says "booked to "', async () => {
  const { deps, sent } = makeDeps();
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', recode: { applied: true, suggestion: {} }, env: CHANNEL_ON, deps });
  assert.equal(r.skipped, 'no_consequence_text');
  assert.equal(sent.length, 0);
});

test('does nothing when the master WhatsApp channel gate is off', async () => {
  const { deps, sent } = makeDeps();
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', recode: appliedRecode, env: { WHATSAPP_ENABLED: 'false' }, deps });
  assert.equal(r.skipped, 'channel_off');
  assert.equal(sent.length, 0);
});

test('does nothing when the born-dark flag is off (default)', async () => {
  const { deps, sent } = makeDeps({ stage: null });
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', recode: appliedRecode, env: CHANNEL_ON, deps });
  assert.equal(r.skipped, 'flag_off');
  assert.equal(sent.length, 0);
});

test('shadow stage observes but does not act — still no send', async () => {
  const { deps, sent } = makeDeps({ stage: 'shadow' });
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', recode: appliedRecode, env: CHANNEL_ON, deps });
  assert.equal(r.skipped, 'flag_off');
  assert.equal(sent.length, 0);
});

test('does nothing when the owner has no active WhatsApp binding', async () => {
  const { deps, sent } = makeDeps({ binding: null });
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', recode: appliedRecode, env: CHANNEL_ON, deps });
  assert.equal(r.skipped, 'unbound');
  assert.equal(sent.length, 0);
});

test('flag acts + bound: sends the consequence line and receipts it', async () => {
  const { deps, sent, ledger } = makeDeps();
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', evidenceRequestId: 'ask-1', recode: appliedRecode, env: CHANNEL_ON, deps });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+358401234567');
  assert.match(sent[0].text, /booked to Meals & Entertainment/);
  assert.match(sent[0].text, /on your books now/);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].ask_id, 'ask-1');
  assert.equal(ledger[0].channel, 'whatsapp');
  assert.equal(ledger[0].provider_payload.reply_reconciled_confirm.status, 'sent');
  assert.ok(ledger[0].sent_at);
  assert.equal(ledger[0].failed_at, null);
});

test('a failed send is receipted as failed, never thrown', async () => {
  const { deps, ledger } = makeDeps({ sendResult: { ok: false, error: 'WhatsApp returned 500.' } });
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', recode: appliedRecode, env: CHANNEL_ON, deps });
  assert.equal(r.sent, false);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].provider_payload.reply_reconciled_confirm.status, 'failed');
  assert.equal(ledger[0].failure_reason, 'WhatsApp returned 500.');
  assert.equal(ledger[0].sent_at, null);
});


test('flag acts + Telegram-bound document sends the async consequence over Telegram', async () => {
  const { deps, sent, ledger } = makeDeps();
  const r = await sendReplyReconciledConfirmation({ firmId: 'f', clientId: 'client-1', transactionId: 'tx-1', evidenceRequestId: 'ask-1', channel: 'telegram', recode: appliedRecode, env: TELEGRAM_ON, deps });
  assert.equal(r.sent, true);
  assert.equal(r.channel, 'telegram');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].via, 'telegram');
  assert.equal(sent[0].to, '987654321');
  assert.match(sent[0].text, /booked to Meals & Entertainment/);
  assert.equal(ledger[0].channel, 'telegram');
  assert.equal(ledger[0].provider, 'telegram');
  assert.equal(ledger[0].recipient_phone_hash, 'hash-tg');
});
