import { useIntl } from 'react-intl';
import { BidiText, IdentifierText } from '../../i18n/BidiText.jsx';
import { T } from '../shared/design-tokens.js';
import { BANK_FEED_SECTION_HEADING_STYLE, BANK_FEED_SECTION_COUNT_STYLE } from '../shared/bank-feed-list-style.js';
import { btnChip } from '../shared/buttons.js';
import { customerReference } from '../../lib/customerFailure.js';

const CAUSE_KEYS = new Set([
  'PROVIDER_KEY_MISSING', 'PROVIDER_UNAUTHORIZED', 'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED_REQUEST', 'PROVIDER_TIMEOUT',
  'PROVIDER_NETWORK', 'PROVIDER_INVALID_OUTPUT'
]);
// A cause the code alone would misstate: PROVIDER_TIMEOUT for a step the
// job's remaining budget could not hold was never sent to the provider.
const CAUSE_REASON_KEYS = new Set(['PROVIDER_TIMEOUT.execution_budget_insufficient']);
const causeKeyOf = (failure) => {
  const byReason = `${failure.code}.${failure.reason}`;
  if (CAUSE_REASON_KEYS.has(byReason)) return byReason;
  return CAUSE_KEYS.has(failure.code) ? failure.code : 'unknown';
};
const RECOVERY_KEYS = new Set(['awaiting_retry', 'retry_in_progress', 'retry_pending', 'recovery_wait', 'recovery_failed']);

// Renders only when a provider failure receipt actually exists (Kari,
// 2026-09-23: the empty "Provider failures 0 · No active provider failure
// receipts" block was noise above every list). A real failure is still shown,
// with a stale-refresh warning if one applies; the console's background
// refresh keeps polling either way.
//
// FI-05 (2026-10-15): two audiences, one read model. The firm's own Actions
// view is a CUSTOMER surface under self-service, so it gets the customer
// projection — the step, "saved, taking longer", and a reference — and never
// the provider, HTTP status, internal code, credential wording or retry
// bookkeeping. The full diagnostic rendering below is the operator's, mounted
// on /firms/operator (OperatorProviderFailures.jsx).
function CustomerProviderFailures({ failures, refreshing, stale, onRefresh, message, intl }) {
  return (
    <section aria-label={message('customer.title')} aria-busy={refreshing} style={{ padding: '12px 0', borderBottom: `1px solid ${T.ruleSoft}` }}>
      <div style={{ ...BANK_FEED_SECTION_HEADING_STYLE, gap: 10, flexWrap: 'wrap' }}>
        <span>{message('customer.title')}</span>
        <span style={BANK_FEED_SECTION_COUNT_STYLE}>{intl.formatNumber(failures.length)}</span>
        <button type="button" onClick={onRefresh} disabled={refreshing} style={{ ...btnChip, marginInlineStart: 'auto' }}>{message('refresh')}</button>
      </div>
      {stale && <p role="status" style={{ color: T.muted, fontSize: 13 }}>{message('customer.stale')}</p>}
      {failures.map((failure) => {
        const reference = customerReference(failure.source_id || failure.id);
        return (
          <article key={failure.id} data-provider-failure={failure.id} style={{ padding: '12px 0', borderTop: `1px solid ${T.ruleSoft}`, overflowWrap: 'anywhere' }}>
            <strong style={{ fontSize: 14 }}><BidiText>{failure.label || message(`lane.${failure.lane}`)}</BidiText></strong>
            <p style={{ margin: '6px 0', fontSize: 13 }}>{message('customer.body')}</p>
            {reference && <p style={{ margin: 0, fontSize: 12, color: T.muted }}>{message('customer.reference')} <IdentifierText>{reference}</IdentifierText></p>}
          </article>
        );
      })}
    </section>
  );
}

export default function ProviderFailurePanel({ failures, refreshing, stale, onRefresh, audience = 'customer' }) {
  const intl = useIntl();
  const message = (key, values) => intl.formatMessage({ id: `operator.providerFailure.${key}` }, values);
  if (!failures?.length) return null;
  if (audience !== 'operator') {
    return <CustomerProviderFailures failures={failures} refreshing={refreshing} stale={stale} onRefresh={onRefresh} message={message} intl={intl} />;
  }
  return (
    <section aria-label={message('title')} aria-busy={refreshing} style={{ padding: '12px 0', borderBottom: `1px solid ${T.ruleSoft}` }}>
      <div style={{ ...BANK_FEED_SECTION_HEADING_STYLE, gap: 10, flexWrap: 'wrap' }}>
        <span>{message('title')}</span>
        <span style={BANK_FEED_SECTION_COUNT_STYLE}>{intl.formatNumber(failures.length)}</span>
        <button type="button" onClick={onRefresh} disabled={refreshing} style={{ ...btnChip, marginInlineStart: 'auto' }}>{message('refresh')}</button>
      </div>
      {stale && <p role="status" style={{ color: T.alert, fontSize: 13 }}>{message('stale')}</p>}
      {failures.map((failure) => (
        <article key={failure.id} data-provider-failure={failure.id} style={{ padding: '12px 0', borderTop: `1px solid ${T.ruleSoft}`, overflowWrap: 'anywhere' }}>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', fontSize: 14 }}>
            <strong><BidiText>{failure.label || message(`lane.${failure.lane}`)}</BidiText></strong>
            <span style={{ color: failure.owner === 'operator' ? T.alert : T.amber }}>{message(failure.owner === 'operator' ? 'operator' : 'queue')}</span>
          </div>
          <p style={{ margin: '6px 0', fontSize: 13 }}>
            {message(`cause.${causeKeyOf(failure)}`)}
          </p>
          <p style={{ margin: '6px 0', fontSize: 13, color: T.muted }}>
            {failure.owner === 'operator' && failure.recovery_status !== 'recovery_failed' && <>{message(
              failure.code === 'PROVIDER_KEY_MISSING' || failure.code === 'PROVIDER_UNAUTHORIZED' ? 'credentialAction' : 'operatorAction'
            )} </>}
            {message(`recovery.${RECOVERY_KEYS.has(failure.recovery_status) ? failure.recovery_status : 'awaiting_retry'}`)}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12, color: T.muted }}>
            <span>{message(`lane.${failure.lane}`)}</span>
            <IdentifierText>{[failure.provider, failure.code, failure.status, failure.reason].filter(Boolean).join(' · ')}</IdentifierText>
            {failure.recovery_error_code && <IdentifierText>{failure.recovery_error_code}</IdentifierText>}
            {failure.queue_attempts != null
              ? <span>{message('queueAttempts', { count: failure.queue_attempts })}</span>
              : failure.attempts != null && <span>{message('attempts', { count: failure.attempts })}</span>}
            {failure.last_failed_at && <span>{intl.formatDate(failure.last_failed_at, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' })}</span>}
          </div>
        </article>
      ))}
    </section>
  );
}
