import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { QUEUE_LABELS } from '../lib/constants.js';
import { T, D } from './shared/design-tokens.js';
import {
  BANK_FEED_SECTION_COUNT_STYLE,
  BANK_FEED_SECTION_HEADING_STYLE
} from './shared/bank-feed-list-style.js';
import { BidiText, IdentifierText } from '../i18n/BidiText.jsx';

const KIND_META = {
  ops_review: { key: 'intake', labelId: 'mounted.actions.kind.intake', color: T.amber, bg: T.amberSoft },
  expert_review: { key: 'compliance', labelId: 'mounted.actions.kind.compliance', color: T.alert, bg: T.alertSoft },
  execution_queue: { key: 'mirror', labelId: 'mounted.actions.kind.mirror', color: T.accent, bg: T.accentSoft },
  auto_send: { key: 'auto', labelId: 'mounted.actions.kind.auto', color: T.ok, bg: T.okSoft }
};

// Composer fields are borderless-by-design (Gmail-style inline editing), so
// they previously set outline:none and gave a keyboard user no focus signal.
// :focus-visible restores an accessible ring on keyboard focus (and on click-
// into-text, which is the expected "you're editing here" affordance) without
// a permanent border that would fight the inline look.
const WAP_STYLES = `
  .wap-field:focus-visible {
    outline: 2px solid var(--focus-ring, #1A1815);
    outline-offset: 3px;
    border-radius: 4px;
  }
  /* Hover feedback on triage rows — non-active rows leave bg unset so this
     tint shows the "about to click" state; the active row keeps its inline bg. */
  .wap-row:hover { background: var(--surface-hover, #F5F3F0); }
`;

const queueKind = (item = {}) =>
  KIND_META[item.queue_label]?.key || 'intake';

const queueMeta = (item = {}) =>
  KIND_META[item.queue_label] || KIND_META.ops_review;

const shortClientName = (item = {}, clientFallback = 'Client') =>
  String(item.client_name || item.clientName || item.client_id || clientFallback)
    .replace(/\s+(pte\.?\s*ltd\.?|private\s+limited)\.?\s*$/i, '')
    .trim() || clientFallback;

const ageLabel = (createdAt, message) => {
  if (!createdAt) return message('mounted.actions.ago.now');
  const created = Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.parse(createdAt);
  if (!Number.isFinite(created)) return message('mounted.actions.ago.now');
  const diff = Math.max(0, Date.now() - created);
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return message('mounted.actions.ago.now');
  if (hours < 24) return message('mounted.actions.ago.hours', { count: hours });
  const days = Math.floor(hours / 24);
  return message('mounted.actions.ago.days', { count: days });
};

const urgencyFor = (item = {}) => {
  if (item.escalation_flag || item.queue_label === 'expert_review' || item.confidence === 'low') return 'high';
  if (item.queue_label === 'execution_queue' || item.confidence === 'medium') return 'medium';
  return 'low';
};

const interestFor = (item = {}) => {
  if (item.queue_label === 'expert_review') return 70;
  if (item.queue_label === 'execution_queue') return 45;
  if (item.confidence === 'low') return 65;
  if (item.confidence === 'medium') return 50;
  return 35;
};

const sourceLabel = (item = {}) => {
  if (item.trigger_type?.includes('bizfile')) return ['Bizfile', 'Intake'];
  if (item.trigger_type?.includes('compliance')) return ['Bizfile', 'CDD'];
  if (item.trigger_type?.includes('xero')) return ['Donna', 'Mirror maintenance'];
  if (item.pattern_category?.includes('bookkeeping')) return ['Client evidence', 'Close'];
  return ['Donna', QUEUE_LABELS[item.queue_label] || 'Review'];
};

const normalizeAction = (item = {}, message) => {
  const [sourceA, sourceB] = sourceLabel(item);
  return {
    ...item,
    id: item.id || `${item.client_id || 'client'}-${item.problem_summary || item.queue_label || 'action'}`,
    kind: queueKind(item),
    meta: queueMeta(item),
    age: ageLabel(item.created_at, message),
    urgency: urgencyFor(item),
    title: item.problem_summary || item.user_stuck_on || QUEUE_LABELS[item.queue_label] || message('mounted.actions.reviewAction'),
    subtitle: `${item.client_name || item.clientName || message('mounted.actions.client')} · ${QUEUE_LABELS[item.queue_label] || item.queue_label || message('mounted.actions.review')}`,
    one: item.queue_reason || item.root_cause?.hypothesis || item.donna_response || message('mounted.actions.reviewMove'),
    their: item.user_stuck_on || item.conversation?.findLast?.((entry) => entry.role === 'Client')?.text || '',
    move: item.queue_reason || item.root_cause?.hypothesis || message('mounted.actions.reviewDraft'),
    draft: item.donna_response || '',
    sourceA,
    sourceB,
    interest: interestFor(item),
    clientShort: shortClientName(item, message('mounted.actions.client'))
  };
};

function RecipientChip({ name, email, role }) {
  const intl = useIntl();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 4px 3px 8px',
        borderRadius: 999,
        background: D.paper,
        border: `1px solid ${T.ruleSoft}`,
        fontSize: 12,
        maxWidth: '100%'
      }}
    >
      <span style={{ color: T.ink, fontWeight: 500, whiteSpace: 'nowrap' }}><BidiText direction="auto">{name || intl.formatMessage({ id: 'mounted.actions.contact' })}</BidiText></span>
      <span style={{ color: T.mutedSoft, fontFamily: T.mono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <IdentifierText>{email || intl.formatMessage({ id: 'mounted.actions.notSet' })}</IdentifierText>
      </span>
      {role && (
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 9.5,
            padding: '1px 5px',
            borderRadius: 3,
            background: T.ruleSoft,
            color: T.muted,
            letterSpacing: '0.06em',
            textTransform: 'uppercase'
          }}
        >
          {role}
        </span>
      )}
    </span>
  );
}

// Format a "23 documents · 18 ready, 2 parsing, 3 failed" breakdown line
// from a rollup row. Builds the parts conditionally so a healthy batch
// just reads "23 documents · 23 ready". See docs/async-parsing-plan.md
// → PR 4 firm-side activity feed.
const formatBatchBreakdown = (batch = {}, message) => {
  const total = Number(batch.total || 0);
  if (!total) return '';
  const parts = [];
  if (batch.completed) parts.push(message('mounted.actions.batch.ready', { count: batch.completed }));
  if (batch.parsing) parts.push(message('mounted.actions.batch.parsing', { count: batch.parsing }));
  if (batch.failed) parts.push(message('mounted.actions.batch.failed', { count: batch.failed }));
  if (batch.duplicate_pending) parts.push(message('mounted.actions.batch.duplicate', { count: batch.duplicate_pending }));
  if (batch.skipped) parts.push(message('mounted.actions.batch.skipped', { count: batch.skipped }));
  return message('mounted.actions.batch', { total, details: parts.length ? parts.join(', ') : 'none' });
};

const formatRelativeTime = (iso, message) => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const deltaMs = Date.now() - t;
  if (deltaMs < 60_000) return message('mounted.actions.ago.now');
  if (deltaMs < 60 * 60_000) return message('mounted.actions.ago.minutes', { count: Math.floor(deltaMs / 60_000) });
  if (deltaMs < 24 * 60 * 60_000) return message('mounted.actions.ago.hours', { count: Math.floor(deltaMs / (60 * 60_000)) });
  return message('mounted.actions.ago.days', { count: Math.floor(deltaMs / (24 * 60 * 60_000)) });
};

// Compact list of rolled-up upload batches. Rendered next to / above
// the actions queue so the firm can see "Alice just uploaded 23 docs ·
// 18 ready, 2 parsing, 3 failed" at a glance — one entry per batch,
// not one per file.
const RecentUploadBatches = ({ batches = [], clientName = null, limit = 5 }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  if (!batches.length) return null;
  const visible = batches.slice(0, limit);
  return (
    <div
      style={{
        marginBottom: 16,
        padding: '14px 16px',
        background: T.card,
        border: `1px solid ${T.rule}`,
        borderRadius: 10
      }}
    >
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 10.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: T.muted,
          marginBottom: 8
        }}
      >
        {message('mounted.actions.recentUploads')}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map((batch) => {
          const breakdown = formatBatchBreakdown(batch, message);
          const when = formatRelativeTime(batch.last_activity_at, message);
          const needsAttention = (batch.failed || 0) + (batch.duplicate_pending || 0) > 0;
          return (
            <li
              key={batch.batch_id}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
                fontSize: 13,
                color: T.inkSoft,
                lineHeight: 1.4
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ color: needsAttention ? T.alert : T.ink, fontWeight: 500 }}>{breakdown}</span>
                {clientName && (
                  <span style={{ color: T.muted, marginInlineStart: 6 }}>· <BidiText direction="auto">{clientName}</BidiText></span>
                )}
                {batch.latest_filename && !clientName && (
                  <span style={{ color: T.muted, marginInlineStart: 6 }}>
                    · <IdentifierText>{batch.latest_filename}</IdentifierText>
                  </span>
                )}
              </span>
              {when && (
                <span style={{ color: T.mutedSoft, fontFamily: T.mono, fontSize: 11, flex: '0 0 auto' }}>{when}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const EmptyActions = ({ firmMessages = [], clientId = null, recentUploadBatches = [], clientName = null, embedded = false }) => {
  const intl = useIntl();
  const t = (id, values) => intl.formatMessage({ id }, values);
  const recentSent = firmMessages
    .filter((m) => !clientId || m.client_id === clientId)
    .slice(0, 3);
  const hasSent = recentSent.length > 0;
  if (embedded && !hasSent && recentUploadBatches.length === 0) return null;
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 1080,
        margin: '0 auto',
        padding: embedded ? 0 : '0 0 60px',
        background: D.paper,
        color: T.ink,
        fontFamily: D.ui
      }}
    >
      <RecentUploadBatches batches={recentUploadBatches} clientName={clientName} />
      {!embedded && (
        <div style={BANK_FEED_SECTION_HEADING_STYLE}>
          <span>{t('mounted.actions.title')}</span>
          <span style={BANK_FEED_SECTION_COUNT_STYLE}>0</span>
        </div>
      )}
      {(!embedded || hasSent) && <div style={{ padding: embedded ? '0 0 28px' : '28px 16px', color: T.muted, fontSize: 13.5, lineHeight: 1.55 }}>
        <p style={{ margin: 0 }}>
          {hasSent
            ? t('mounted.actions.waiting', { client: recentSent[0].client_name || t('mounted.actions.theClient') })
            : t('mounted.actions.noneVenture')}
        </p>
        {hasSent && (
          <div style={{ marginTop: 18, maxWidth: 520 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 8 }}>
              {t('mounted.actions.recentlySent')}
            </div>
            {recentSent.map((message) => (
              <div key={message.id} style={{ padding: '10px 0', borderTop: `1px solid ${T.ruleSoft}`, fontSize: 13, color: T.inkSoft }}>
                <div style={{ fontWeight: 500, color: T.ink }}><BidiText direction="auto">{message.subject || t('mounted.actions.messageSent')}</BidiText></div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{t('mounted.actions.toClient', { client: message.client_name || t('mounted.actions.client') })}</div>
              </div>
            ))}
          </div>
        )}
      </div>}
    </div>
  );
};

export default function DonnaActionsPanel({
  queue = [],
  setQueue,
  history = [],
  setHistory,
  firmMessages = [],
  setFirmMessages,
  client = null,
  recentUploadBatches = [],
  embedded = false
}) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const actions = useMemo(
    // PR 3: review queue vocabulary is now `open | resolved | cancelled`.
    // Legacy aliases (`closed | dismissed`) are still tolerated for rows
    // written before migration 014 or sent in flight.
    () => queue.filter((item) =>
      item?.status !== 'resolved' && item?.status !== 'cancelled'
      && item?.status !== 'closed' && item?.status !== 'dismissed'
    ).map((item) => normalizeAction(item, (id, values) => intl.formatMessage({ id }, values))),
    [queue, intl]
  );
  const [activeId, setActiveId] = useState('');
  const [draft, setDraft] = useState({});
  const [tone] = useState('Neutral');
  const [length] = useState('Standard');
  const [sendOpen, setSendOpen] = useState(false);
  const [showSubject, setShowSubject] = useState(false);
  const sendRef = useRef(null);

  const active = actions.find((action) => action.id === activeId) || actions[0] || null;
  const [subject, setSubject] = useState('');

  useEffect(() => {
    if (!actions.length) {
      setActiveId('');
      return;
    }
    if (!activeId || !actions.some((action) => action.id === activeId)) {
      setActiveId(actions[0].id);
    }
  }, [actions, activeId]);

  useEffect(() => {
    if (!active) return;
    // Prefer the action's own subject when it's a real client message
    // (welcome, follow-ups). Fall back to the auto-generated
    // "Title - Source" string for legacy review items.
    if (active.subject) setSubject(active.subject);
    else setSubject(`${active.title} - ${active.subtitle.split(' · ')[0]}`);
  }, [active]);

  useEffect(() => {
    function onDoc(event) {
      if (sendRef.current && !sendRef.current.contains(event.target)) setSendOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const clientLabel = client?.companyName || client?.name || null;
  if (!actions.length) {
    return (
      <EmptyActions
        firmMessages={firmMessages}
        clientId={client?.id || null}
        recentUploadBatches={recentUploadBatches}
        clientName={clientLabel}
        embedded={embedded}
      />
    );
  }

  const draftText = draft[active?.id] ?? active?.draft ?? '';
  const hasDraft = draftText.trim().length > 0;

  const removeActive = (outcome) => {
    if (!active) return;
    // Capture what the firm actually sent (edited subject + body), not
    // the original draft. The client portal renders these from
    // firmMessages, so without this snapshot any edits would silently
    // disappear.
    const sentBody = (draft[active.id] ?? active.draft ?? '').trim();
    const sentSubject = (subject || active.subject || active.title || '').trim();
    const stamp = Date.now();
    setQueue?.((prev) => prev.filter((item) => item.id !== active.id));
    setHistory?.([
      {
        id: `history-${active.id}-${stamp}`,
        client_id: active.client_id,
        client_name: active.client_name,
        outcome,
        payload: {
          ...active,
          sent_subject: sentSubject,
          sent_body: sentBody
        },
        happened_at: stamp
      },
      ...history
    ]);
    // Outbound client-facing messages also land in firmMessages, which
    // is the durable store for the client portal's "Messages from your
    // firm" feed. Lives in localStorage and survives BE snapshots.
    if (outcome === 'approved' && sentBody && setFirmMessages) {
      setFirmMessages((prev) => [
        {
          id: `msg-${active.id}-${stamp}`,
          client_id: active.client_id,
          client_name: active.client_name,
          subject: sentSubject,
          body: sentBody,
          sent_at: stamp,
          from: 'Donna · Senior accountant'
        },
        ...prev
      ]);
    }
  };

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 1080,
        marginInline: 'auto',
        padding: embedded ? '0 0 28px' : '0 0 60px',
        background: D.paper,
        color: T.ink,
        fontFamily: D.ui
      }}
    >
      <style>{WAP_STYLES}</style>
      <RecentUploadBatches batches={recentUploadBatches} clientName={clientLabel} />
      <div style={BANK_FEED_SECTION_HEADING_STYLE}>
        <span>{message('mounted.actions.needsDecision')}</span>
        <span style={BANK_FEED_SECTION_COUNT_STYLE}>{actions.length}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) minmax(0, 1fr)', gap: 24, alignItems: 'flex-start' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            background: T.card,
            border: `1px solid ${T.rule}`,
            borderRadius: 12,
            overflow: 'hidden'
          }}
        >
          {actions.map((action) => {
            const isActive = active?.id === action.id;
            return (
              <button
                key={action.id}
                type="button"
                className="wap-row"
                onClick={() => setActiveId(action.id)}
                style={{
                  font: 'inherit',
                  textAlign: 'start',
                  padding: '14px 16px',
                  // Active wins via inline bg; non-active rows leave bg unset so
                  // the CSS :hover tint can show an "about to click" state.
                  background: isActive ? D.paper : undefined,
                  border: 'none',
                  borderInlineStart: `3px solid ${isActive ? T.ink : 'transparent'}`,
                  borderBottom: `1px solid ${T.ruleMicro}`,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      padding: '2px 7px',
                      borderRadius: 4,
                      background: action.meta.bg,
                      color: action.meta.color,
                      fontWeight: 500
                    }}
                  >
                    {message(action.meta.labelId)}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{action.clientShort}</span>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 11,
                      color: action.urgency === 'high' ? T.alert : T.mutedSoft
                    }}
                  >
                    {action.urgency === 'high' ? '●' : '○'} {action.age}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: T.ink, lineHeight: 1.35 }}>{action.title}</div>
                <div
                  style={{
                    fontSize: 12,
                    color: T.muted,
                    lineHeight: 1.45,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical'
                  }}
                >
                  {action.one}
                </div>
              </button>
            );
          })}
        </div>

        {active && (
          <div
            style={{
              background: T.card,
              border: `1px solid ${T.rule}`,
              borderRadius: 12,
              overflow: 'hidden',
              minWidth: 0
            }}
          >
            <div
              style={{
                padding: '22px 26px 18px',
                borderBottom: `1px solid ${T.ruleSoft}`,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 16
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 19, fontWeight: 600, color: T.ink, letterSpacing: 0, lineHeight: 1.3 }}>
                  {active.title}
                </div>
                <div style={{ marginTop: 6, fontSize: 12.5, color: T.muted, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{active.subtitle}</span>
                  <span style={{ color: T.mutedSoft }}>·</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11.5 }}>{active.sourceA} {'->'} {active.sourceB}</span>
                  <span style={{ color: T.mutedSoft }}>·</span>
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 11.5,
                      color: active.interest >= 60 ? T.ok : active.interest >= 40 ? T.amber : T.alert
                    }}
                  >
                    {message('mounted.actions.reviewSignal', { percent: active.interest })}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 2, flex: '0 0 auto' }}>
                <button
                  type="button"
                  title={message('mounted.actions.snooze')}
                  style={{
                    font: 'inherit',
                    fontSize: 12,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    color: T.muted,
                    cursor: 'pointer'
                  }}
                >
                  {message('mounted.actions.snooze')}
                </button>
                <button
                  type="button"
                  title={message('mounted.actions.dismiss')}
                  onClick={() => removeActive('dismissed')}
                  style={{
                    font: 'inherit',
                    fontSize: 12,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    color: T.muted,
                    cursor: 'pointer'
                  }}
                >
                  {message('mounted.actions.dismiss')}
                </button>
              </div>
            </div>

            <div style={{ padding: '18px 26px', borderBottom: `1px solid ${T.ruleSoft}`, background: D.paper }}>
              {active.their && (
                <div
                  style={{
                    fontSize: 14,
                    color: T.ink,
                    lineHeight: 1.55,
                    marginBottom: 10,
                    paddingInlineStart: 12,
                    borderInlineStart: `2px solid ${T.ruleSoft}`
                  }}
                >
                  {active.their}
                </div>
              )}
              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.55 }}>
                <span
                  style={{
                    color: T.amber,
                    fontFamily: T.mono,
                    fontSize: 11,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    marginInlineEnd: 8
                  }}
                >
                  Donna
                </span>
                {active.move}
              </div>
            </div>

            <div>
              <div
                style={{
                  padding: '14px 26px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                  fontSize: 12.5
                }}
              >
                <span style={{ color: T.muted }}>{message('mounted.actions.to')}</span>
                <RecipientChip name={active.client_name || active.clientShort} email={active.contact_email || message('mounted.actions.contactMissing')} />
                <span style={{ flex: 1 }} />
                {!showSubject && (
                  <button type="button" onClick={() => setShowSubject(true)} style={{ font: 'inherit', fontSize: 11.5, color: T.mutedSoft, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                    {message('mounted.actions.subject')}
                  </button>
                )}
              </div>
              {showSubject && (
                <div style={{ padding: '0 26px 6px' }}>
                  <input
                    className="wap-field"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    placeholder={message('mounted.actions.subject')}
                    style={{ width: '100%', font: 'inherit', fontSize: 13, fontWeight: 500, color: T.ink, border: 'none', background: 'transparent', padding: '6px 0' }}
                  />
                </div>
              )}

              <div style={{ padding: '6px 26px 14px' }}>
                <textarea
                  className="wap-field"
                  value={draftText}
                  placeholder={message('mounted.actions.writeFollowUp')}
                  onChange={(event) => setDraft({ ...draft, [active.id]: event.target.value })}
                  style={{ width: '100%', minHeight: 180, font: 'inherit', fontSize: 14, lineHeight: 1.6, color: T.ink, padding: 0, border: 'none', background: 'transparent', resize: 'vertical' }}
                />
                <div style={{ marginTop: 4, fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
                  {message('mounted.actions.signoff')}
                  <br />
                  Kari Lehto
                  <br />
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.mutedSoft }}>{message('mounted.actions.seniorAccountant')}</span>
                </div>
              </div>

              <div
                style={{
                  padding: '14px 26px 18px',
                  borderTop: `1px solid ${T.ruleSoft}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11.5, color: T.mutedSoft, fontFamily: T.mono, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 5, height: 5, borderRadius: 999, background: hasDraft ? T.ok : T.mutedSoft }} />
                    {message(hasDraft ? 'mounted.actions.draftReady' : 'mounted.actions.noDraft')}
                  </span>
                  <button type="button" title={message('mounted.actions.toneLength')} style={{ font: 'inherit', fontFamily: T.mono, fontSize: 11.5, color: T.muted, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
                    {message('mounted.actions.tone', { tone: tone.toLowerCase(), length: length.toLowerCase() })}
                  </button>
                </div>
                <div ref={sendRef} style={{ position: 'relative', display: 'inline-flex' }}>
                  <button
                    type="button"
                    onClick={() => removeActive('approved')}
                    disabled={!hasDraft}
                    style={{
                      font: 'inherit',
                      fontSize: 13,
                      padding: '9px 18px',
                      borderRadius: '999px 0 0 999px',
                      border: 'none',
                      background: hasDraft ? T.ink : T.rule,
                      color: hasDraft ? T.paper : T.muted,
                      cursor: hasDraft ? 'pointer' : 'default',
                      fontWeight: 500
                    }}
                  >
                    {message('mounted.actions.send')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSendOpen(!sendOpen)}
                    disabled={!hasDraft}
                    aria-label={message('mounted.actions.moreSend')}
                    style={{
                      font: 'inherit',
                      padding: '9px 10px',
                      borderRadius: '0 999px 999px 0',
                      border: 'none',
                      borderInlineStart: '1px solid rgba(255,255,255,0.15)',
                      background: hasDraft ? T.ink : T.rule,
                      color: hasDraft ? T.paper : T.muted,
                      cursor: hasDraft ? 'pointer' : 'default',
                      display: 'inline-flex',
                      alignItems: 'center'
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {sendOpen && (
                    <div style={{ position: 'absolute', insetBlockEnd: 'calc(100% + 6px)', insetInlineEnd: 0, width: 220, background: T.card, border: `1px solid ${T.rule}`, borderRadius: 10, boxShadow: '0 12px 32px -8px rgba(26,24,21,0.18)', overflow: 'hidden', zIndex: 10 }}>
                      {[
                        { label: message('mounted.actions.sendNow'), sub: message('mounted.actions.sendNowDesc') },
                        { label: message('mounted.actions.sendSnooze'), sub: message('mounted.actions.sendSnoozeDesc') },
                        { label: message('mounted.actions.schedule'), sub: message('mounted.actions.scheduleDesc') },
                        { label: message('mounted.actions.saveDraft'), sub: message('mounted.actions.saveDraftDesc') }
                      ].map((option, index) => (
                        <button
                          key={option.label}
                          type="button"
                          style={{ font: 'inherit', display: 'block', width: '100%', textAlign: 'start', padding: '9px 12px', border: 'none', background: 'transparent', cursor: 'pointer', borderBlockEnd: index < 3 ? `1px solid ${T.ruleMicro}` : 'none' }}
                        >
                          <div style={{ fontSize: 12.5, color: T.ink }}>{option.label}</div>
                          <div style={{ fontSize: 11, color: T.mutedSoft, marginTop: 1 }}>{option.sub}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
