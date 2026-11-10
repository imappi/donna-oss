// The one line an owner-reply lane tells the owner about what Donna did with
// their answer, and the one place it is kept.
//
// A lane adapter on the structured owner-reply worker (structuredOwnerReply.js)
// may return, with its outcome:
//   owner_notice            the line as said in reply to the owner's own
//                           message (a chat channel speaks it in-band:
//                           channels/inboundCore.js buildResolvedReplyText).
//                           It may end with an invitation to reply.
//   owner_notice_statement  the same line without any invitation to reply:
//                           what was done (or not done), nothing more. This is
//                           what a surface without a reply on the closed
//                           question shows (the client portal's answered
//                           questions). An adapter whose line invites no reply
//                           returns the same text in both.
// The adapter owns the wording (the country's, in the owner's language); the
// worker owns keeping it: it writes both on the answered question's
// response_payload in the same transaction as the outcome, so every surface
// renders the stored line and none composes its own. No line, no write. The
// notice names the reply it answers (owner_notice_reply_key): a later reply on
// the same question supersedes it until that reply is processed.
export const OWNER_NOTICE_MAX_LENGTH = 500;

const clean = (value) => (typeof value === 'string' ? value.trim().slice(0, OWNER_NOTICE_MAX_LENGTH) : '');

// The notice an outcome carries, or null. A statement is required: a line that
// may promise a reply is never shown where no reply exists.
export const ownerNoticeFromOutcome = (outcome, { replyKey = null } = {}) => {
  if (!outcome || typeof outcome !== 'object' || outcome.needsClarification) return null;
  const text = clean(outcome.owner_notice);
  const statement = clean(outcome.owner_notice_statement);
  if (!text || !statement || !replyKey) return null;
  return { owner_notice: text, owner_notice_statement: statement, owner_notice_reply_key: replyKey };
};

// The statement a surface without a reply may show for this question: only
// for the reply it answers, once that reply is processed. Null otherwise.
export const ownerNoticeStatementOf = (request) => {
  const payload = request?.response_payload || {};
  const statement = clean(payload.owner_notice_statement);
  if (!statement || !['replied', 'resolved'].includes(request?.status)) return null;
  if (payload.reply_processing?.state !== 'completed' || !payload.owner_notice_reply_key
    || payload.reply_processing.reply_key !== payload.owner_notice_reply_key) return null;
  return statement;
};

// Inside the worker's transaction, after the lane's writer: the notice on the
// answered question it is about.
export const recordOwnerNoticeWithClient = async ({ client, firmId, clientId, evidenceRequestId, notice }) => {
  if (!notice) return null;
  await client.query(`update client_evidence_requests set response_payload = response_payload || $4::jsonb
    where firm_id = $1 and client_id = $2 and id = $3`,
  [firmId, clientId, evidenceRequestId, JSON.stringify(notice)]);
  return notice;
};
