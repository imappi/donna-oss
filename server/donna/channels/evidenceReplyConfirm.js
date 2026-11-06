// The "booked ✓" follow-up for an owner who answered an evidence ask with a
// PHOTO/DOCUMENT over WhatsApp.
//
// Why this exists as a separate proactive send (unlike the text-answer path):
// a text reply reconciles SYNCHRONOUSLY inside resolveClientEvidenceRequestInDb,
// so the webhook replies in-band with the consequence line (buildResolvedReplyText).
// A photo parses ASYNChronously — the recode + internal ledger post land later,
// on parse-completion, via resumeEvidenceRecodeAfterParseInDb. By then the inbound
// webhook has long since acked ("reading that now"). So the moment the async
// recode AUTO-RECONCILES the line, we send the owner a second message telling them
// what Donna booked.
//
// Discipline (a new proactive outbound surface — the most dangerous kind):
//   - BORN DARK on the config control plane: clientFlagActs with envFallback:()=>false.
//     Off for every client until a canary row is staged. No env pair.
//   - Defense-in-depth master gate: whatsappEnvAllowsClient (WHATSAPP_ENABLED +
//     the WHATSAPP_CLIENTS allowlist), the same gate the outbound ask send honours.
//   - Only to an ACTIVE WhatsApp binding (opt-in + STOP respected).
//   - Honest: the line is rendered from the persisted recode verdict; we never
//     claim a booking that did not happen. No account resolved ⇒ we say nothing.
//   - Best-effort / no-throw: a send failure must not break the reconcile. Every
//     attempt (sent OR failed) is receipted in the delivery ledger.
//   - Idempotent by construction: the caller only invokes this on the single
//     recode.applied transition (the resume's already-settled guard prevents a
//     second apply), so the confirmation fires at most once per reconcile.
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { ownerChannelAllowsClient, prefetchOwnerChannelGateContext } from './ownerChannelConfig.js';
import {
  getActiveWhatsAppBindingForClientInDb,
  getActiveTelegramBindingForClientInDb,
  recordMessageDeliveryLedgerInDb,
  withFirmDbClient
} from '../firmDb.js';
import { sendWhatsAppText } from './whatsapp.js';
import { sendTelegramText, telegramEnvAllowsClient } from './telegram.js';
import { whatsappEnvAllowsClient } from './whatsappWebhookCore.js';
import { buildResolvedReplyText } from './inboundCore.js';

export const EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY = 'EVIDENCE_REPLY_RECONCILED_CONFIRM';

export const sendReplyReconciledConfirmation = async ({
  firmId,
  clientId,
  transactionId,
  evidenceRequestId = null,
  channel = 'whatsapp',
  recode = {},
  now = new Date().toISOString(),
  env = process.env,
  deps = {}
} = {}) => {
  // Only speak when the line actually reconciled.
  if (!recode || recode.applied !== true) return { skipped: 'not_applied' };
  if (!clientId) return { skipped: 'no_client' };

  // The honest consequence line — the SAME builder the in-band text reply uses.
  // No resolvable account ⇒ nothing to say (never "booked to ").
  const text = buildResolvedReplyText({ resolved: { recode }, fallback: '' });
  if (!text) return { skipped: 'no_consequence_text' };

  const normalizedChannel = String(channel || 'whatsapp').trim().toLowerCase();
  const channelConfig = normalizedChannel === 'telegram'
    ? { channel: 'telegram', provider: 'telegram', envFallback: telegramEnvAllowsClient, getBindingDep: 'getActiveTelegramBinding', defaultGetBinding: getActiveTelegramBindingForClientInDb, sendDep: 'sendTelegramText', defaultSendText: sendTelegramText }
    : { channel: 'whatsapp', provider: 'meta', envFallback: whatsappEnvAllowsClient, getBindingDep: 'getActiveWhatsAppBinding', defaultGetBinding: getActiveWhatsAppBindingForClientInDb, sendDep: 'sendWhatsAppText', defaultSendText: sendWhatsAppText };

  const withClient = deps.withFirmDbClient || withFirmDbClient;
  const readSnapshot = deps.readClientConfigSnapshot || readClientConfigSnapshot;
  const getBinding = deps[channelConfig.getBindingDep] || channelConfig.defaultGetBinding;
  const recordLedger = deps.recordMessageDeliveryLedger || recordMessageDeliveryLedgerInDb;
  const sendText = deps[channelConfig.sendDep] || channelConfig.defaultSendText;
  const loadSnapshot = ({ firmId: scopedFirmId, clientId: scopedClientId }) => withClient((client) => readSnapshot(client, { firmId: scopedFirmId, clientId: scopedClientId }));
  const gateContext = await prefetchOwnerChannelGateContext({ bindings: [{ client_id: clientId }], firmId, loadSnapshot });
  if (!ownerChannelAllowsClient({ channel: channelConfig.channel, clientId, gateContext, envFallback: channelConfig.envFallback, env })) return { skipped: 'channel_off' };

  return withClient(async (client) => {
    const snapshot = gateContext.snapshotsByClient[clientId];
    const acts = clientFlagActs({
      flagKey: EVIDENCE_REPLY_RECONCILED_CONFIRM_FLAG_KEY,
      snapshot,
      envFallback: () => false,
      env
    });
    if (!acts) return { skipped: 'flag_off' };

    const binding = await getBinding({ client, firmId, clientId });
    if (!binding || !binding.phone_e164) return { skipped: 'unbound' };

    const result = await sendText({ to: binding.phone_e164, text });
    const sent = result?.ok === true;
    const messageId = result?.id || result?.message_id || `evidence_reply_confirm_${transactionId}`;
    await recordLedger({
      client,
      entry: {
        message_id: messageId,
        channel: channelConfig.channel,
        provider: channelConfig.provider,
        ask_id: evidenceRequestId || null,
        client_id: clientId,
        recipient_phone_hash: binding.phone_hash,
        template_name: 'evidence_reply_reconciled_confirm_v1',
        sent_at: sent ? now : null,
        failed_at: sent ? null : now,
        failure_reason: sent ? null : (result?.reason || result?.error || 'SEND_FAILED'),
        provider_payload: {
          reply_reconciled_confirm: {
            status: sent ? 'sent' : 'failed',
            transaction_id: transactionId || null,
            posted: recode.posted === true
          }
        }
      }
    });
    return { sent, message_id: messageId, channel: channelConfig.channel, text };
  });
};
