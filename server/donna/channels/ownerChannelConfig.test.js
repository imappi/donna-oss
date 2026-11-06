import test from 'node:test';
import assert from 'node:assert/strict';

import { whatsappEnvAllowsClient } from './whatsappWebhookCore.js';
import { telegramEnvAllowsClient } from './telegram.js';
import { smsEnvAllowsClient } from './sms.js';
import { ownerChannelAllowsClient, prefetchOwnerChannelGateContext, OWNER_CHANNEL_FLAG_KEYS } from './ownerChannelConfig.js';
import { processAnchoredInboundMessage } from './inboundCore.js';

const channels = [
  ['whatsapp', whatsappEnvAllowsClient, 'WHATSAPP_ENABLED', 'WHATSAPP_CLIENTS'],
  ['telegram', telegramEnvAllowsClient, 'TELEGRAM_ENABLED', 'TELEGRAM_CLIENTS'],
  ['sms', smsEnvAllowsClient, 'SMS_ENABLED', 'SMS_CLIENTS']
];

for (const [channel, legacy, masterKey, clientsKey] of channels) {
  test(`${channel}: stage-1 fallback is byte-identical across the exhaustive legacy truth table`, async () => {
    const clientIds = [undefined, '', 'included', 'excluded'];
    const masters = [undefined, 'false', 'true', ' TRUE '];
    const allowlists = [undefined, '', '   ', 'included', ' included ', 'other, included ,third', 'other,third'];
    for (const master of masters) for (const allowlist of allowlists) for (const clientId of clientIds) {
      const env = { [masterKey]: master, [clientsKey]: allowlist };
      const bindings = clientId ? [{ client_id: clientId }] : [];
      const gateContext = await prefetchOwnerChannelGateContext({ bindings, loadSnapshot: async () => null });
      assert.equal(
        ownerChannelAllowsClient({ channel, clientId, gateContext, envFallback: legacy, env }),
        legacy(clientId, env),
        JSON.stringify({ master, allowlist, clientId })
      );
    }
    assert.equal(legacy('included', { [masterKey]: 'true', [clientsKey]: '' }), false, 'empty allowlist is explicitly false');
  });
}

test('prefetch deduplicates candidates, freezes state, and soft-fails to null (never {})', async () => {
  const calls = [];
  const context = await prefetchOwnerChannelGateContext({
    firmId: 'firm-1',
    bindings: [{ client_id: 'a' }, { client_id: 'a' }, { client_id: 'b' }],
    loadSnapshot: async ({ clientId }) => { calls.push(clientId); if (clientId === 'b') throw new Error('down'); return { OWNER_CHANNEL_SMS: { stage: 'canary' } }; }
  });
  assert.deepEqual(calls.sort(), ['a', 'b']);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.snapshotsByClient), true);
  assert.equal(context.snapshotsByClient.b, null);
});

test('real anchor wiring persists only the DB-included client delivery', async () => {
  const persisted = [];
  const claimed = [];
  const config = {
    provider: 'test', channel: 'sms', source: 'sms', actorFallback: 'test:webhook',
    copy: { textResolved: 'done', topicOpen: 'open', unbound: 'unbound', unanchored: 'unanchored', voiceDeferred: 'voice' },
    extractText: (message) => message.text, extractContextId: () => '', mediaDescriptor: () => null,
    allowsClient: (clientId, gateContext, env) => ownerChannelAllowsClient({ channel: 'sms', clientId, gateContext, envFallback: smsEnvAllowsClient, env })
  };
  const run = (stage) => processAnchoredInboundMessage({
    message: { id: `message-${stage}`, text: 'answer Ref: ASK1' }, from: '+1', firmId: 'firm-1', env: { SMS_ENABLED: 'false' }, config,
    deps: {
      getBindingsByPhoneHash: async () => [{ client_id: 'client-1', collaborator_id: 'owner-1' }],
      loadClientConfigSnapshot: async () => ({ [OWNER_CHANNEL_FLAG_KEYS.sms]: { stage } }),
      getOpenAskByRef: async () => ({ id: 'ask-1', client_id: 'client-1', question: 'question' }),
      claimInboundMessage: async (args) => { claimed.push(args); return { claimed: true }; },
      resolveEvidenceRequest: async () => ({ id: 'ask-1' }),
      recordLedger: async ({ entry }) => { persisted.push(entry); return entry; },
      sendText: async () => ({ ok: true })
    }
  });
  assert.deepEqual(await run('off'), { status: 'skipped', reason: 'flag_off' });
  assert.equal(claimed.length, 0, 'excluded candidate is not claimed');
  assert.equal(persisted.length, 0, 'excluded candidate has no persisted delivery');
  assert.equal((await run('canary')).status, 'resolved');
  assert.equal(claimed.length, 1, 'included candidate reaches the claim call site');
  assert.equal(persisted.length, 1, 'included candidate reaches the persisted delivery call site');
  assert.equal(persisted[0].client_id, 'client-1');
});

test('all four live guards fail closed at the synchronous call site', async () => {
  const env = { SMS_ENABLED: 'true', SMS_CLIENTS: 'client-1' };
  const included = await prefetchOwnerChannelGateContext({ bindings: [{ client_id: 'client-1' }], loadSnapshot: async () => ({ OWNER_CHANNEL_SMS: { stage: 'canary' } }) });
  const missingRow = await prefetchOwnerChannelGateContext({ bindings: [{ client_id: 'client-1' }], loadSnapshot: async () => null });
  const noCandidate = await prefetchOwnerChannelGateContext({ bindings: [], loadSnapshot: async () => ({ OWNER_CHANNEL_SMS: { stage: 'canary' } }) });
  assert.equal(ownerChannelAllowsClient({ channel: 'sms', clientId: 'client-1', gateContext: missingRow, envFallback: () => false, env }), false, 'removing DB row exposes the fallback guard');
  assert.equal(ownerChannelAllowsClient({ channel: 'sms', clientId: 'client-1', gateContext: missingRow, envFallback: smsEnvAllowsClient, env }), true, 'env fallback is live');
  assert.equal(ownerChannelAllowsClient({ channel: 'sms', clientId: 'client-1', gateContext: included, envFallback: smsEnvAllowsClient, env: { ...env, CLIENT_CONFIG_FORCE_DISABLE: 'OWNER_CHANNEL_SMS' } }), false, 'force-disable kills a DB allow');
  assert.equal(ownerChannelAllowsClient({ channel: 'sms', clientId: 'client-1', gateContext: noCandidate, envFallback: smsEnvAllowsClient, env }), false, 'candidate membership is required');
});
