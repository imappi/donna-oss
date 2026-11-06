// Exact persisted reply identity. An inference may only settle the answer it read.
import { createHash } from 'node:crypto';
export const ownerReplyIdentity = (request = {}) => {
  const response = request.response_payload || {};
  return createHash('sha256').update(JSON.stringify([
    request.id, response.responded_at || request.responded_at || null,
    response.reply || '', [...(response.document_ids || [])].sort()
  ])).digest('hex');
};
export const assertCurrentOwnerReply = (request, expectedReplyKey) => {
  if (!request || request.status !== 'replied' || ownerReplyIdentity(request) !== expectedReplyKey) {
    const error = new Error('The owner reply changed while coding was running.');
    error.code = 'OWNER_REPLY_SUPERSEDED';
    throw error;
  }
};
