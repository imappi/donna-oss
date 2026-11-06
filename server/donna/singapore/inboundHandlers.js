// Country-owned owner-reply adapters. Keep text-only refusals, writer injection,
// mandates, sender authority and delivery receipts identical to the channel path.
import { isGstReturnAsk, resolveGstReturnInbound } from './gstReturnRoute.js';
export { createIrasSubmitGstF5 } from './iras/submitGstF5.js';

const runGstReturnReply = async ({ descriptor, sendText, from, config, deps, firmId, anchor, ask, text, message, actorId, env, recordLedger }) => {
    // SG-3 slice P: the GST F5 filing confirm is a text-only conversation
    // (yes / no) — the same posture as the ALV branch above. A media reply must
    // NOT fall through to the generic evidence path.
    if (descriptor) {
      await sendText({ to: from, text: config.copy.gstReturnTextOnly || 'Reply with text: "yes" or "no".' });
      return { status: 'nudged', reason: 'gst_return_media' };
    }
    const gstFlagActs = typeof deps.gstFilingFlagActs === 'function'
      ? await deps.gstFilingFlagActs({ firmId, clientId: anchor.clientId })
      : false;
    const resolveGst = deps.resolveGstReturnInbound || resolveGstReturnInbound;
    const result = await resolveGst({
      firmId,
      clientId: anchor.clientId,
      ask,
      replyText: text,
      message,
      phoneHash: anchor.phoneHash,
      provider: config.provider,
      actorId,
      flagActs: gstFlagActs,
      getGstReturnImpl: deps.getGstReturn,
      // SG G-3: the CorpPass authorization lookup for the transmit gate.
      // Fail-closed — an unwired lookup means no mandate, and the transmit
      // refuses typed (SG_FILING_CORPPASS_REQUIRED).
      getMandateImpl: deps.getCorpPassMandate,
      markFiledImpl: deps.markGstReturnFiled,
      cancelImpl: deps.cancelGstReturn,
      // The seam payload carries no client identity; bind it here so the IRAS
      // adapter can resolve the filer's UEN from the client profile.
      submitReturn: typeof deps.submitGstF5 === 'function'
        ? (payload) => deps.submitGstF5({ ...payload, firmId, clientId: anchor.clientId })
        : deps.submitGstF5,
      resolveAsk: deps.resolveGstReturnAsk,
      sendText: ({ text: outbound, ask: outboundAsk }) => sendText({ to: from, text: outbound, ask: outboundAsk })
    });
    await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: anchor.askId, provider_payload: { inbound: { type: 'text', anchor: anchor.source, gst_return: result.action } } } });
    return { status: 'gst_return', askId: anchor.askId, result };

};

export const COUNTRY_INBOUND_ADAPTER = Object.freeze({
  jurisdiction: 'sg',
  replies: Object.freeze([
    Object.freeze({ id: 'gst_return', matches: (ask) => isGstReturnAsk(ask), run: runGstReturnReply })
  ])
});
