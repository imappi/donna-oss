// Country-owned owner-reply adapters. Keep text-only refusals, writer injection,
// mandates, sender authority and delivery receipts identical to the channel path.
import { isInvoiceIssuanceAsk, resolveInvoiceIssuanceInbound } from './invoiceIssuanceRoute.js';
import { isAlvReturnAsk, resolveAlvReturnInbound } from './alvReturnRoute.js';
import { isOpeningBalanceAsk, resolveOpeningBalanceInbound } from './openingBalanceRoute.js';
export { startInvoiceIssuance } from './invoiceIssuanceRoute.js';
export { sniffEInvoiceXml, FINLAND_EINVOICE_RECEIVE_FLAG_KEY, receiveEInvoiceDocument } from './verkkolaskuReceive.js';
export { createIlmoitinSubmitAlvReturn } from './omavero/submitAlvReturn.js';

const runInvoiceIssuanceReply = async ({ descriptor, sendText, from, config, deps, firmId, anchor, ask, text, message, actorId, env, recordLedger }) => {
    // Invoice-issuance asks are text-only conversations (kyllä / ei / a correction).
    // A media reply must NOT fall through to the generic evidence path — that would
    // resolve the confirm ask without any confirmation.
    if (descriptor) {
      await sendText({ to: from, text: config.copy.invoiceTextOnly || 'Vastaa tekstillä: “kyllä”, “ei” tai korjaus.' });
      return { status: 'nudged', reason: 'invoice_issuance_media' };
    }
    const invoiceFlagActs = typeof deps.invoiceIssuanceFlagActs === 'function'
      ? await deps.invoiceIssuanceFlagActs({ firmId, clientId: anchor.clientId })
      : false;
    // C-1: the quote gate for corrections/conversions inside the conversation.
    let anchoredQuotesEnabled = false;
    if (typeof deps.quoteIssuanceFlagActs === 'function') {
      try {
        anchoredQuotesEnabled = await deps.quoteIssuanceFlagActs({ firmId, clientId: anchor.clientId });
      } catch {
        anchoredQuotesEnabled = false;
      }
    }
    // FI-13 13.4: the ALV gate for corrections/rebuilds inside the conversation
    // — same fail-closed posture as the unanchored hook.
    let anchoredAlvFlagActs = false;
    if (typeof deps.alvInvoicingFlagActs === 'function') {
      try {
        anchoredAlvFlagActs = await deps.alvInvoicingFlagActs({ firmId, clientId: anchor.clientId });
      } catch {
        anchoredAlvFlagActs = false;
      }
    }
    const sellerContext = typeof deps.getInvoiceSellerContext === 'function'
      ? await deps.getInvoiceSellerContext({ firmId, clientId: anchor.clientId })
      : {};
    const resolveIssuance = deps.resolveInvoiceIssuanceInbound || resolveInvoiceIssuanceInbound;
    const result = await resolveIssuance({
      firmId,
      clientId: anchor.clientId,
      ask,
      replyText: text,
      message,
      phoneHash: anchor.phoneHash,
      actorId,
      flagActs: invoiceFlagActs,
      alvFlagActs: anchoredAlvFlagActs,
      sellerContext,
      getInvoiceImpl: deps.getIssuedInvoice,
      persistSellerIdentityImpl: deps.persistFinlandSellerIdentity,
      createDraftImpl: deps.createIssuedInvoiceDraft,
      supersedeDraftImpl: deps.supersedeIssuedInvoiceDraft,
      cancelImpl: deps.cancelIssuedInvoice,
      markIssuedImpl: deps.markIssuedInvoiceIssued,
      postImpl: deps.postSalesInvoiceJournal,
      // G-8: the credit-note lanes — the original-invoice lookup for the intake
      // and the AR-reversal writer for the issue motion.
      postCreditNoteImpl: deps.postCreditNoteJournal,
      resolveCreditContext: typeof deps.getIssuedInvoiceCreditContext === 'function'
        ? ({ originalInvoiceNumber }) => deps.getIssuedInvoiceCreditContext({ firmId, clientId: anchor.clientId, originalInvoiceNumber })
        : null,
      // C-1: the quote (tarjous) lanes.
      quotesEnabled: anchoredQuotesEnabled,
      resolveQuoteContext: typeof deps.getIssuedQuoteContext === 'function'
        ? ({ quoteNumber }) => deps.getIssuedQuoteContext({ firmId, clientId: anchor.clientId, quoteNumber })
        : null,
      getQuoteImpl: deps.getIssuedQuote,
      createQuoteDraftImpl: deps.createIssuedQuoteDraft,
      supersedeQuoteDraftImpl: deps.supersedeIssuedQuoteDraft,
      cancelQuoteImpl: deps.cancelIssuedQuote,
      markQuoteSentImpl: deps.markIssuedQuoteSent,
      transmitImpl: deps.transmitFinvoice,
      transmitPdfImpl: deps.transmitInvoicePdf,
      sendEmail: deps.sendInvoiceEmail,
      createAsk: deps.createInvoiceIssuanceAsk,
      resolveAsk: deps.resolveInvoiceIssuanceAsk,
      sendText: ({ text: outbound, ask: outboundAsk }) => sendText({ to: from, text: outbound, ask: outboundAsk }),
      apiKey: env.ANTHROPIC_API_KEY,
      fetchImpl: deps.fetchImpl
    });
    await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: anchor.askId, provider_payload: { inbound: { type: 'text', anchor: anchor.source, invoice_issuance: result.action } } } });
    return { status: 'invoice_issuance', askId: anchor.askId, result };

};

const runAlvReturnReply = async ({ descriptor, sendText, from, config, deps, firmId, anchor, ask, text, message, actorId, env, recordLedger }) => {
    // FI-3 slice P: the ALV filing confirm is a text-only conversation (kyllä /
    // ei). A media reply must NOT fall through to the generic evidence path —
    // that would resolve the confirm ask without any confirmation.
    if (descriptor) {
      await sendText({ to: from, text: config.copy.alvReturnTextOnly || 'Vastaa tekstillä: “kyllä” tai “ei”.' });
      return { status: 'nudged', reason: 'alv_return_media' };
    }
    const alvFlagActs = typeof deps.alvFilingFlagActs === 'function'
      ? await deps.alvFilingFlagActs({ firmId, clientId: anchor.clientId })
      : false;
    const resolveAlv = deps.resolveAlvReturnInbound || resolveAlvReturnInbound;
    const result = await resolveAlv({
      firmId,
      clientId: anchor.clientId,
      ask,
      replyText: text,
      message,
      phoneHash: anchor.phoneHash,
      actorId,
      flagActs: alvFlagActs,
      getAlvReturnImpl: deps.getAlvReturn,
      // G-3: the Suomi.fi mandate lookup for the transmit gate. Fail-closed —
      // an unwired lookup means no mandate, and the transmit refuses typed.
      getMandateImpl: deps.getSuomifiMandate,
      // The overlap check before transmit (fail-closed when unwired).
      assertFileableImpl: deps.assertAlvReturnFileable,
      markFiledImpl: deps.markAlvReturnFiled,
      cancelImpl: deps.cancelAlvReturn,
      // The seam payload carries no client identity; bind it here so the FI-8
      // adapter can resolve the filer's Y-tunnus from the client profile.
      submitReturn: typeof deps.submitAlvReturn === 'function'
        ? (payload) => deps.submitAlvReturn({ ...payload, firmId, clientId: anchor.clientId })
        : deps.submitAlvReturn,
      resolveAsk: deps.resolveAlvReturnAsk,
      sendText: ({ text: outbound, ask: outboundAsk }) => sendText({ to: from, text: outbound, ask: outboundAsk })
    });
    await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: anchor.askId, provider_payload: { inbound: { type: 'text', anchor: anchor.source, alv_return: result.action } } } });
    return { status: 'alv_return', askId: anchor.askId, result };

};

const readOpeningEntityType = async ({ deps, firmId, clientId }) => {
  let entityType = 'toiminimi';
  if (typeof deps.getClientEntityType === 'function') {
    try {
      const axis = await deps.getClientEntityType({ firmId, clientId });
      if (axis === 'oy' || axis === 'toiminimi') entityType = axis;
    } catch (error) {
      console.warn('[inboundCore] opening-balance entity-type read failed', error?.message || error);
    }
  }
  return entityType;
};

export const COUNTRY_INBOUND_ADAPTER = Object.freeze({
  jurisdiction: 'fi',
  replies: Object.freeze([
    Object.freeze({ id: 'invoice_issuance', matches: (ask) => isInvoiceIssuanceAsk(ask), run: runInvoiceIssuanceReply }),
    Object.freeze({ id: 'alv_return', matches: (ask) => isAlvReturnAsk(ask), run: runAlvReturnReply })
  ]),
  opening: Object.freeze({ matches: (ask) => isOpeningBalanceAsk(ask),
    flagReaderKey: 'openingBalanceFlagActs', resolverKey: 'resolveOpeningBalanceInbound',
    createAskKey: 'createOpeningBalanceAsk', postKey: 'postOpeningBalanceJournal',
    resolve: (args) => resolveOpeningBalanceInbound(args), readEntityType: readOpeningEntityType })
});
