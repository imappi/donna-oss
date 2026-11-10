// What Donna did with the owner's answers: the stored line for each answered
// question that has one (server/donna/ownerReplyNotice.js). The portal lists
// only open questions, so without this an answered question disappears and
// the owner never sees what was recorded. Nothing here composes wording: each
// row is the line the lane wrote and the worker kept, in the owner's
// language, without an invitation to reply (the closed question has no reply).
import { useIntl } from 'react-intl';
import { D } from './shared/design-tokens.js';
import { BidiText } from '../i18n/BidiText.jsx';
import { ownerNoticeStatementOf } from '../../server/donna/ownerReplyNotice.js';

export const ANSWERED_NOTICE_LIMIT = 5;

const answeredAt = (request) => request?.resolved_at || request?.responded_at || request?.updated_at || '';

// The answered questions of this client with a line to show, newest first.
export const answeredOwnerNotices = (requests = [], { clientId = null, limit = ANSWERED_NOTICE_LIMIT } = {}) =>
  (Array.isArray(requests) ? requests : [])
    .filter((request) => request && (!clientId || request.client_id === clientId))
    .map((request) => ({ id: request.id, statement: ownerNoticeStatementOf(request), at: answeredAt(request) }))
    .filter((row) => row.statement)
    .sort((left, right) => String(right.at).localeCompare(String(left.at)) || String(left.id).localeCompare(String(right.id)))
    .slice(0, limit);

export default function AnsweredOwnerNotices({ requests = [], clientId = null }) {
  const intl = useIntl();
  const rows = answeredOwnerNotices(requests, { clientId });
  if (!rows.length) return null;
  return (
    <section
      aria-label={intl.formatMessage({ id: 'portal.answered.title' })}
      data-testid="answered-owner-notices"
      style={{ paddingBlock: '1.5rem', borderBottom: `1px solid ${D.rule}` }}
    >
      <h2 style={{ margin: 0, fontFamily: D.mono, fontSize: 11, letterSpacing: D.tracking.mono, textTransform: 'uppercase', color: D.inkSoft, fontWeight: 400 }}>
        {intl.formatMessage({ id: 'portal.answered.title' })}
      </h2>
      <ul style={{ listStyle: 'none', margin: '0.75rem 0 0', padding: 0, display: 'grid', gap: '0.5rem' }}>
        {rows.map((row) => (
          <li key={row.id} data-evidence-request-id={row.id} style={{ fontFamily: D.body, fontSize: '0.9375rem', lineHeight: D.leading.body, color: D.ink, maxWidth: '40em' }}>
            <BidiText direction="auto">{row.statement}</BidiText>
          </li>
        ))}
      </ul>
    </section>
  );
}
