import { useIntl } from 'react-intl';

import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import { T, D } from './design-tokens.js';
import {
  BANK_FEED_AMOUNT_STYLE,
  BANK_FEED_DATE_STYLE,
  BANK_FEED_DOT_STYLE,
  BANK_FEED_PRIMARY_STYLE,
  BANK_FEED_ROW_STYLE,
  BANK_FEED_STATUS_STYLE,
  BANK_FEED_TRAILING_CELL_STYLE,
  bankFeedPillStyle
} from './bank-feed-list-style.js';
export {
  DONNA_WORKING,
  OWNER_SCOPE_OF_BUCKET,
  entityOwnerCounts,
  isPeriodOwnedDecision,
  isUserDecidable,
  periodOwnedDecisionItems,
  presentFeedBuckets
} from './entity-owner-inventory.js';

// The feed-list grammar — buckets + rows — shared by the home Inbox
// (donna-firm-feed-panel.jsx, pane-scroll) and the entity Actions tab
// (financials/ask-batch-panel.jsx, document-scroll). One grammar, one
// classifier: both surfaces render the SAME buildFirmFeed dispositions
// with the same labels, dots, and row anatomy — the entity view is the
// Inbox scoped to one venture, not a sibling design.
//
// Bucket labels are action-oriented: each one answers "whose move?"
// from the operator's point of view. Internal disposition keys stay
// the canonical close-engine names so the classifier + tests are
// untouched; only the visible strings change.
//
// Three-voice calm (Kari, 2026-08-05): labels render in INK, the dot
// carries the voice, and only the top "your move" bucket speaks in the
// warm accent — one loud element per screen.
export const BUCKET_META = {
  operator_blocker: { label: 'Needs your decision', labelId: 'firm.bucket.operatorBlocker', actor: 'me', dot: D.accentWarmFlat },
  client_info_needed: { label: 'Waiting on client', labelId: 'firm.bucket.clientInfoNeeded', actor: 'client', dot: D.inkMute },
  donna_working: { label: "In Donna's hands", labelId: 'firm.bucket.donnaWorking', actor: 'system', dot: D.inkMute },
  auto_cleared: { label: 'Recently handled', labelId: 'firm.bucket.autoCleared', actor: 'system', dot: D.inkMute }
};

export const FEED_BUCKET_ORDER = ['operator_blocker', 'client_info_needed', 'donna_working', 'auto_cleared'];

// auto_cleared is the audit-trail bucket — items the system already
// handled. donna_working is Donna's own open workload — visible on
// request, never padding the user's queue. Neither should be scrolled
// past to find real work, so both start collapsed.
export const COLLAPSED_BY_DEFAULT = new Set(['donna_working', 'auto_cleared']);

// ── The presentation partition (Kari, 2026-08-07) ───────────────────────────
// The classifier's operator_blocker bucket mixes two different things: items
// the operator can actually DECIDE (a failed parse to re-upload, a judgment
// escalation, a draft to review) and items that are Donna's own unfinished
// work (unmatched lines, uncategorized codings, totals checks, suggestions
// awaiting confirmation). Rendering the second kind as "Needs your decision"
// hands the user a 195-row queue with no decidable question on it — the
// nausea inbox. The split below is PRESENTATION over persisted verdicts:
// close-engine dispositions are untouched, those rows still block close and
// still count as hanging under two-terminal-states. They just stop
// masquerading as the user's to-do list — they are Donna's.
// Re-buckets a buildFirmFeed `buckets` object for presentation: every
// operator_blocker item that is not user-decidable moves to donna_working.
// Pure and shape-preserving — both feed projections call this before
// rendering, so the partition can never diverge between Inbox and Actions.
// ── Owner scopes (external review, Kari accepted 2026-08-09) ────────────────
// "Every item has exactly one owner and one state: For you / Waiting /
// Donna working / Done." A PROJECTION of the five buckets onto four owners —
// the classifier and the bucket keys are untouched; this is presentation,
// same law as presentFeedBuckets above.
//
// Only genuine operator blockers are "for you". A confirmable transaction is
// an underlying accounting line, not a daily firm task; treating every one as
// a required click recreates the firm-side limbo state prohibited by the
// two-terminal-states rail. It stays visible under the collapsed Donna-owned
// bucket and in the venture's Open feed, while Actions carries actual decisions.
// THE one formula for owner counts, shared by the entity toolbar's Actions
// badge (FirmOpsConsole) and the Actions panel's section counts
// (ask-batch-panel.jsx). The badge and panel counts MUST come from this
// helper, never from parallel arithmetic — the pre-review badge counted
// open evidence requests (items WAITING on the client) while the panel
// said "N for you", two different concepts wearing the same number.
const stripLegalSuffix = (name = '') => String(name)
  .replace(/\s+(pte\.?\s*ltd\.?|private\s+limited|llc|inc|corp)\.?\s*$/i, '')
  .trim();

// Row-context venture identity: the legal suffix ("LLC", "Pte Ltd") is
// registry noise at list density — strip it for the inline prefix, keep the
// full legal name in the hover title.
export const clientDisplayName = (name = '') => stripLegalSuffix(name) || String(name).trim();

export const clientTag = (name = '') => {
  if (!name) return 'CLIENT';
  return (stripLegalSuffix(name) || 'CLIENT').slice(0, 6).toUpperCase();
};

export const shortDate = (iso, formatter = null) => {
  if (!iso) return '';
  if (typeof formatter === 'function') {
    const calendarDate = String(iso).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(calendarDate)) {
      try {
        return formatter(calendarDate, { year: undefined, month: 'short', day: '2-digit' });
      } catch { /* retain the stable English fallback below */ }
    }
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
};

export const formatAmount = (amount, formatter = null, currency = 'USD') => {
  if (amount == null) return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  if (typeof formatter === 'function') {
    try {
      return formatter(n, { currency: currency || 'USD', negativeStyle: 'minus' });
    } catch { /* retain the stable English fallback below */ }
  }
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// Pipeline reason strings, humanized for the row's shorthand column. Raw
// enums and sentence-length internal statuses must never reach the screen
// (the amount_mismatch/amount_mismatch rows were exactly this leak). The
// persisted verdict is untouched — this maps display strings only.
const REASON_LABELS = {
  amount_mismatch: ['firm.feed.reason.amountMismatch', "totals don't add up"],
  'Unmatched and uncategorized bank transaction.': ['firm.feed.reason.awaitingMatch', 'awaiting match'],
  'No supporting document or transfer match found.': ['firm.feed.reason.noDocument', 'no document yet'],
  'Suggested reconciliation needs reviewer confirmation.': ['firm.feed.reason.suggestionPending', 'suggestion pending']
};

export const humanReason = (reason, formatMessage = null) => {
  if (!reason) return '';
  const known = REASON_LABELS[reason];
  if (!known) return String(reason);
  return typeof formatMessage === 'function'
    ? formatMessage({ id: known[0], defaultMessage: known[1] })
    : known[1];
};

// The row's title cell. Descriptor (merchant/description/filename) wins;
// a reason is a fallback and always renders humanized, so a row without
// context degrades to a legible phrase instead of a bare enum.
export const feedTitle = (item, formatMessage = null) => item.descriptor || humanReason(item.reason, formatMessage) || '—';

export const reasonShorthand = (item, formatMessage = null) => {
  const v = item.verdict || {};
  // Ask-lane rows: the reason field already carries the legible string —
  // the drafted question, or the draft's "not sent" summary. It beats any
  // classifier shorthand (and the machine-y disclosure_reason) for scanning.
  if (item.kind === 'client_evidence_request' || item.kind === 'ask_batch_draft') {
    return item.reason || '';
  }
  if (v.risk_class === 'tax_sensitive') return formatMessage?.({ id: 'firm.feed.reason.taxSensitive' }) || 'tax-sensitive';
  if (v.risk_class === 'owner_personal') return formatMessage?.({ id: 'firm.feed.reason.ownerPersonal' }) || 'owner personal';
  if (v.risk_class === 'contractor_classification') return formatMessage?.({ id: 'firm.feed.reason.contractor' }) || 'contractor';
  if (item.kind === 'reconciliation_match' && item.matched_object_type) {
    return `↦ ${item.matched_object_type.replace(/_/g, ' ')}`;
  }
  if (v.disclosure_reason) return humanReason(v.disclosure_reason, formatMessage);
  if (item.reason) return humanReason(item.reason, formatMessage);
  if (v.reason_code) return v.reason_code.replace(/_/g, ' ');
  return '';
};

// Decision-grain grouping (2026-08-07) is RETIRED (Kari, 2026-09-01: the
// "N items · Show" group rows switched label vocabularies mid-list and put a
// toggle where a pill belongs). Its premise moved out from under it: it was
// built for a 195-row decidable queue, but presentFeedBuckets since emptied
// "Needs your decision", so grouping mostly fired in Waiting on client — an
// audit trail where compression hides dates and amounts and saves no
// decisions. Every row now renders individually, the same grammar as the
// entity month stream; bucket headings collapse instead.

// ── Inbox state pills (Kari, 2026-09-01) ────────────────────────────────────
// The trailing pill carries STATE only, in the same vocabulary as the entity
// screen's stream pills — never the reason/question sentence (that rides the
// hover title; full detail lives in the artifact). Keyed by the PRESENTED
// bucket: the caller passes the bucket it renders the row under, so the pill
// can never disagree with the section heading above it. Recently-handled rows
// stay quiet — the section already says it.
export const STATE_PILL_OF_BUCKET = {
  operator_blocker: { labelId: 'lifecycle.needsInput', defaultMessage: 'Needs input', voice: 'warm' },
  client_info_needed: { labelId: 'lifecycle.awaitingReply', defaultMessage: 'Awaiting reply', voice: 'muted' },
  donna_working: { labelId: 'lifecycle.processing', defaultMessage: 'Processing', voice: 'muted' },
  auto_cleared: null
};

// Hover feedback for triage rows — inline styles can't express :hover, and
// the non-active rows leave their bg unset (see FeedRow) so this tint can
// apply. Only non-active rows hover; the active row keeps its inline bg.
// Each mounting surface renders this once inside a <style> tag.
export const FEED_ROW_HOVER_CSS = `
  .wff-row:hover { background: var(--surface-hover, #F5F3F0); }
`;

const ROW_GRID_TAGGED = '14px 64px 56px 92px minmax(0, 1fr) minmax(0, 200px)';
const ROW_GRID_UNTAGGED = '14px 56px 92px minmax(0, 1fr) minmax(0, 200px)';

// One feed row. `showClientTag` is for the firm-wide Inbox (which venture?);
// in Bank Feed layout that identity sits quietly inside the primary cell so
// it does not invent a fifth column. The entity Actions view drops it — a
// list of identical venture names is noise, not information.
//
// `stateBucket` (Inbox): the presented bucket this row renders under. It
// selects the row's STATE pill from STATE_PILL_OF_BUCKET; the verbose
// reason/question moves to the pill's hover title (Kari, 2026-09-01 — the
// sentence-long clipped pills). Callers passing explicit `trailingContent`
// (the entity Actions rows) are untouched.
export const FeedRow = ({
  item,
  isActive,
  onActivate,
  onOpen,
  rowRef,
  showClientTag = true,
  padX = 20,
  layout = 'feed',
  trailingContent = null,
  stateBucket = null
}) => {
  const intl = useIntl();
  const { formatAmount: formatLocaleAmount, formatDate } = useInterfaceLocale();
  const v = item.verdict || {};
  const blocks = Boolean(v.blocks_close);
  const title = feedTitle(item, intl.formatMessage);
  const bankFeedLayout = layout === 'bank-feed';
  // A row with no descriptor falls back to its reason as the title; the
  // shorthand column repeating the same string was the doubled-enum bug.
  const rawShorthand = reasonShorthand(item, intl.formatMessage);
  const shorthand = rawShorthand === title ? '' : rawShorthand;
  const statePill = stateBucket ? STATE_PILL_OF_BUCKET[stateBucket] : undefined;
  const renderedTrailing = trailingContent
    || (statePill !== undefined
      ? (statePill && (
        <span title={shorthand || undefined} style={bankFeedPillStyle(statePill.voice)}>
          {intl.formatMessage({ id: statePill.labelId, defaultMessage: statePill.defaultMessage })}
        </span>
      ))
      : (bankFeedLayout && shorthand
        ? <span style={bankFeedPillStyle(blocks ? 'warm' : 'muted')}>{shorthand}</span>
        : shorthand));
  return (
    <button
      ref={rowRef}
      type="button"
      className="wff-row"
      onClick={onActivate}
      onDoubleClick={onOpen}
      style={{
        border: 'none',
        ...(bankFeedLayout
          ? BANK_FEED_ROW_STYLE
          : {
              display: 'grid',
              gridTemplateColumns: showClientTag ? ROW_GRID_TAGGED : ROW_GRID_UNTAGGED,
              alignItems: 'center',
              gap: 12,
              padding: `8px ${padX}px`,
              borderBottom: `1px solid ${T.ruleSoft}`
            }),
        // Active wins via a bright card highlight; non-active rows MUST set
        // 'transparent' explicitly — leaving a <button> bg unset renders the
        // native OS button-face grey (the muddy band), not the page cream.
        // The CSS :hover tint (FEED_ROW_HOVER_CSS) still shows an "about to
        // click" state on non-active rows.
        background: isActive ? T.card : 'transparent',
        borderInlineStart: bankFeedLayout ? 'none' : `2px solid ${isActive ? T.ink : 'transparent'}`,
        cursor: 'pointer',
        font: bankFeedLayout ? undefined : 'inherit',
        textAlign: 'start',
        width: '100%'
      }}
    >
      <span
        aria-label={intl.formatMessage({ id: blocks ? 'firm.feed.blocksClose' : 'firm.feed.doesNotBlockClose' })}
        style={{
          ...(bankFeedLayout
            ? BANK_FEED_DOT_STYLE
            : { width: 8, height: 8, borderRadius: '50%' }),
          background: blocks ? D.accentWarmFlat : 'transparent',
          border: blocks ? 'none' : `1.5px solid ${T.mutedSoft}`,
          justifySelf: bankFeedLayout ? 'auto' : 'center'
        }}
      />
      {showClientTag && !bankFeedLayout && (
        // Identity is INK, never hue (Kari, 2026-08-05): the venture tag is
        // a neutral mono chip — the old 8-hue tinted pills read as cheap
        // decoration, not information. Wash at 4% (the 8% ruleSoft read as
        // heavy grey blocks dominating the row — Kari's second pass), label
        // at full ink so the tag stays crisp on the whisper ground.
        <span
          title={item.verdict?.context?.client_name || ''}
          style={{
            fontFamily: T.mono,
            fontSize: 10.5,
            padding: '2px 6px',
            background: 'oklch(0.08 0 0 / 0.04)',
            color: T.ink,
            borderRadius: 3,
            letterSpacing: '0.05em',
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          <IdentifierText>{item._clientTag}</IdentifierText>
        </span>
      )}
      <span style={bankFeedLayout ? BANK_FEED_DATE_STYLE : { fontFamily: T.mono, fontSize: 11.5, color: T.muted }}>
        <FormattedValue>{shortDate(item.transaction_date, formatDate)}</FormattedValue>
      </span>
      {bankFeedLayout && (
        // ONE line, one ellipsis (Kari, 2026-09-01: the title rendered as a
        // block element after the inline venture prefix, wrapping every
        // Inbox row onto two lines). The venture prefix is muted ink with
        // its legal suffix stripped; the full legal name + title ride the
        // hover title.
        <span
          title={showClientTag ? `${item.verdict?.context?.client_name || item._clientTag} · ${title}` : undefined}
          style={{
            ...BANK_FEED_PRIMARY_STYLE,
            minWidth: 0,
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {showClientTag && (
            <span style={{ color: T.muted }}>
              <BidiText direction="auto">{clientDisplayName(item.verdict?.context?.client_name || item._clientTag)}</BidiText>
              {' · '}
            </span>
          )}
          <BidiText direction="auto">{title}</BidiText>
        </span>
      )}
      <span
        style={{
          ...(bankFeedLayout
            ? BANK_FEED_AMOUNT_STYLE
            : { fontFamily: T.mono, fontSize: 12, textAlign: 'end' }),
          color: T.ink,
          ...D.tabular
        }}
      >
        <FormattedValue>{formatAmount(item.amount, formatLocaleAmount, item.currency || item.account_currency || 'USD')}</FormattedValue>
      </span>
      {!bankFeedLayout && <span
        style={{
          fontSize: 13,
          color: T.ink,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        <BidiText direction="auto">{title}</BidiText>
      </span>}
      <span
        style={{
          ...(bankFeedLayout
            ? (renderedTrailing
                ? {
                    ...BANK_FEED_TRAILING_CELL_STYLE,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end'
                  }
                : BANK_FEED_STATUS_STYLE)
            : { fontSize: 11.5, color: T.muted, fontFamily: T.mono }),
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'end'
        }}
      >
        <BidiText direction="auto">{renderedTrailing}</BidiText>
      </span>
    </button>
  );
};

// Bucket header — dot · mono caps label · count, sticky to its scroller.
// `top` is 0 in the Inbox pane (its own scroller), STACKED_STRIP_TOP in
// the entity workspace (document scroll under the 48px pinned toolbar).
export const BucketHeader = ({ meta, count, collapsible = false, expanded = true, onToggle, first = false, padX = 20, top = 0 }) => {
  const intl = useIntl();
  const HeaderTag = collapsible ? 'button' : 'div';
  return (
    <HeaderTag
      type={collapsible ? 'button' : undefined}
      onClick={collapsible ? onToggle : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: `10px ${padX}px`,
        background: D.paper,
        borderBottom: `1px solid ${T.ruleSoft}`,
        borderTop: first ? 'none' : `1px solid ${T.rule}`,
        borderInlineStart: 'none',
        borderInlineEnd: 'none',
        position: 'sticky',
        top,
        zIndex: 1,
        width: '100%',
        font: 'inherit',
        textAlign: 'start',
        cursor: collapsible ? 'pointer' : 'default'
      }}
      aria-expanded={collapsible ? expanded : undefined}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: meta.dot
        }}
      />
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10.5,
          color: T.ink,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600
        }}
      >
        {intl.formatMessage({ id: meta.labelId, defaultMessage: meta.label })}
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.mutedSoft }}>
        ({count})
      </span>
      {collapsible && (
        <span
          style={{
            marginInlineStart: 'auto',
            fontFamily: T.mono,
            fontSize: 10.5,
            color: T.mutedSoft,
            letterSpacing: '0.04em'
          }}
        >
          {intl.formatMessage({ id: expanded ? 'common.hide' : 'common.show' })}
        </span>
      )}
    </HeaderTag>
  );
};
