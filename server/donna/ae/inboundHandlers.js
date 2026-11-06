import { actAeOpeningFromDb } from './openingBalanceDb.js';
// The persisted AE ask kind keeps its consumer after profile changes. The
// consumer reloads authoritative identity; it can never rebind to another market.
export const COUNTRY_INBOUND_ADAPTER = Object.freeze({
  jurisdiction: 'ae',
  replies: Object.freeze([{
    id: 'ae_opening_balance', matches: ask => ask?.evidence_type === 'ae_opening_balance',
    run: async ({ descriptor, sendText, from, firmId, anchor, ask, text, message, actorId, recordLedger }) => {
      if (descriptor) {
        await sendText({to:from,text:'Use the opening trial-balance form to declare the complete balances and select this source document. Then confirm the exact proposal here.'});
        return {status:'opening_balance',askId:ask.id,result:{action:'missing'}};
      }
      const result=await actAeOpeningFromDb({firmId,clientId:anchor.clientId,askId:ask.id,action:'reply',reply:text,actorId,
        authorityBasis:{source:'owner_channel_confirmation',provider_message_id:message.id,phone_hash:anchor.phoneHash}});
      await recordLedger({entry:{message_id:message.id,ask_id:ask.id,client_id:anchor.clientId,
        inbound_reply_id:message.id,resolved_request_id:['posted','cancelled'].includes(result.action)?ask.id:null,
        provider_payload:{opening_balance:result.action}}});
      await sendText({to:from,text:result.action==='posted'?'The confirmed opening trial balance is posted.':result.action==='cancelled'?'The opening proposal is cancelled.':'Complete the opening trial-balance form, or reply cancel.'});
      return {status:'opening_balance',askId:ask.id,result};
    }
  }])
});
