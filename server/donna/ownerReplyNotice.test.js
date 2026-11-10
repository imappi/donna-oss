// The one owner of the owner-reply notice: what an outcome must carry to be
// kept, and when a surface without a reply may show it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerNoticeFromOutcome, ownerNoticeStatementOf, OWNER_NOTICE_MAX_LENGTH } from './ownerReplyNotice.js';

test('an outcome is kept only with both the line and a statement, for a named reply, never for a clarification', () => {
  const outcome = { owner_notice: ' We recorded X. Reply here if that is not right. ', owner_notice_statement: 'We recorded X.' };
  assert.deepEqual(ownerNoticeFromOutcome(outcome, { replyKey: 'ask-1:k' }),
    { owner_notice: 'We recorded X. Reply here if that is not right.', owner_notice_statement: 'We recorded X.', owner_notice_reply_key: 'ask-1:k' });
  assert.equal(ownerNoticeFromOutcome(outcome), null, 'no reply key');
  assert.equal(ownerNoticeFromOutcome({ owner_notice: 'We recorded X. Reply here.' }, { replyKey: 'k' }), null, 'a line that may promise a reply needs its statement');
  assert.equal(ownerNoticeFromOutcome({ ...outcome, needsClarification: true }, { replyKey: 'k' }), null);
  assert.equal(ownerNoticeFromOutcome({ applied: true }, { replyKey: 'k' }), null);
  assert.equal(ownerNoticeFromOutcome(null, { replyKey: 'k' }), null);
  assert.equal(ownerNoticeFromOutcome({ owner_notice: 'x'.repeat(900), owner_notice_statement: 'y'.repeat(900) }, { replyKey: 'k' }).owner_notice.length, OWNER_NOTICE_MAX_LENGTH);
});

test('a surface shows the statement only for the processed reply it answers', () => {
  const stored = (patch = {}, processing = { state: 'completed', reply_key: 'k1' }) => ({ status: 'resolved',
    response_payload: { owner_notice: 'Line. Reply here.', owner_notice_statement: 'Line.', owner_notice_reply_key: 'k1', reply_processing: processing, ...patch } });
  assert.equal(ownerNoticeStatementOf(stored()), 'Line.');
  assert.equal(ownerNoticeStatementOf({ ...stored(), status: 'replied' }), 'Line.', 'answered, resting with a person');
  assert.equal(ownerNoticeStatementOf({ ...stored(), status: 'open' }), null);
  assert.equal(ownerNoticeStatementOf(stored({}, { state: 'pending', reply_key: 'k2' })), null, 'a later reply supersedes it');
  assert.equal(ownerNoticeStatementOf(stored({}, { state: 'completed', reply_key: 'k2' })), null, 'a later processed reply without a line');
  assert.equal(ownerNoticeStatementOf(stored({ owner_notice_reply_key: undefined })), null);
  assert.equal(ownerNoticeStatementOf(stored({ owner_notice_statement: '  ' })), null);
  assert.equal(ownerNoticeStatementOf(null), null);
});
