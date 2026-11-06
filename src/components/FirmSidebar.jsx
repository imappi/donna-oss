// Firm sidebar — Donna venture rail. Inline-styled against the T token set
// to match workspace/sidebar.jsx from the design bundle exactly. The previous
// CSS-driven version (.firm-rail, .firm-rail-entity, …) is no longer used by
// this component but the classes remain in styles.css for any other consumers.

import { T, D } from './shared/design-tokens.js';
import { OverflowMenu } from './shared/OverflowMenu.jsx';
import { presentFeedBuckets } from './shared/feed-list.jsx';
import { getOperatorProfile, initialsFromName } from '../lib/operatorProfile.js';
import { isDesktopShell } from '../lib/desktopShell.js';
import { getAuthSession } from '../lib/accessToken.js';
import { useIntl } from 'react-intl';
import { BidiText } from '../i18n/BidiText.jsx';

const STATUS_RANK = { blocked: 3, review: 2, pending: 1, complete: 0 };

const clientRisk = (client) =>
  (client.intakeChecklist || []).reduce(
    (highest, item) =>
      STATUS_RANK[item.status] > STATUS_RANK[highest] ? item.status : highest,
    'complete'
  );

const clientOpenCount = (queue, clientId) =>
  queue.filter((item) => item.client_id === clientId).length;

// Inbox counts, live-feed variant: "whose move = the firm's" — the
// PRESENTED operator_blocker bucket from /firms/feed
// (presentFeedBuckets moves Donna's own unfinished work out of the
// user's count; a badge of 195 undecidable rows was the nausea inbox).
// Waiting-on-client rows deliberately don't badge the rail: they're the
// on-the-client terminal, not a firm action point. Falls back to the
// legacy queue counts when no feed is loaded (mock/demo mode).
const FIRM_MOVE_BUCKETS = ['operator_blocker'];

const feedFirmMoveItems = (feed) => {
  const presented = presentFeedBuckets(feed?.buckets);
  return FIRM_MOVE_BUCKETS.flatMap((bucket) => presented[bucket] || []);
};

const feedFirmMoveCount = (feed, clientId) =>
  feedFirmMoveItems(feed).filter((item) => !clientId || item.client_id === clientId).length;

// Venture dot palette — keeps prior colour assignments stable.
const VENTURE_DOT = ['#8B6914', '#2D5F8A', '#D4764E', '#6B4FA0', '#2A7D5F', '#A0522D', '#B8860B', '#1A3C2A'];

const colorForClient = (client, index) =>
  client.color || VENTURE_DOT[index % VENTURE_DOT.length];

const shortClientName = (name = '') =>
  name.replace(/\s+(pte\.?\s*ltd\.?|private\s+limited)\.?\s*$/i, '').trim() || name;

// Selected wash — the rail is transparent chrome on the shell ground
// (panels-on-ground, 2026-08-05), so a paper/white "selected" fill would
// fight the ground; an 8%-ink wash reads on any light surface.
const SELECTED_WASH = 'oklch(0.08 0 0 / 0.06)';

// Inbox tray glyph — the rail's one nav icon (Kari's 2026-08-05 sidebar
// pass; venture rows carry their colour dots instead).
const InboxIcon = ({ size = D.icon.size }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={D.icon.stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flex: '0 0 auto' }}
  >
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

// Team glyph — the bench (TeamPanel): Donna + AI teammates + your people.
// Feather-style two-person outline, same geometry rules as the other rail
// icons (selection carried by wash, never a heavier icon).
const TeamIcon = ({ size = D.icon.size }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={D.icon.stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flex: '0 0 auto' }}
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

// Feedback speech-bubble glyph — the "tell the maker" entry under Inbox
// (Kari's 2026-08-05 ask). A bubble, not a bug: the lane takes ideas and
// thoughts too, and a bug glyph would narrow it to defect reports.
const FeedbackIcon = ({ size = D.icon.size }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={D.icon.stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flex: '0 0 auto' }}
  >
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
);

const FirmSidebar = ({
  clients,
  selectedClientId,
  queue,
  feed = null,
  isHomeSelected,
  activeTab,
  onSelectClient,
  onHome,
  onTeam = null,
  onNewEntity,
  onSettings,
  onFeedback,
  onLogout = null,
  firmName = ''
}) => {
  const intl = useIntl();
  const homeCount = feed ? feedFirmMoveCount(feed) : queue.length;
  const countForClient = (clientId) =>
    feed ? feedFirmMoveCount(feed, clientId) : clientOpenCount(queue, clientId);
  // When the firm has zero ventures, the "All ventures" home button + an
  // empty list + a dashed "+ Add venture" reads as a debug placeholder. In
  // that case, suppress the duplicate home button and promote Add venture
  // into the primary CTA so the rail tells the same story as the canvas.
  const isEmpty = clients.length === 0;
  return (
  <aside
    className="firm-sidebar"
    aria-label={intl.formatMessage({ id: 'mounted.sidebar.aria' })}
    style={{
      // One definition, in design-tokens.js — the settings rail and drop
      // overlay read the same token, so widening the rail cannot leave either
      // behind.
      width: D.rail,
      flex: `0 0 ${D.rail}px`,
      // Top: clears the desktop shell's traffic lights + nav controls, which
      // float over this rail's empty top strip (--donna-titlebar-h is unset
      // on web, where 12px fallback + 16px lands on a normal page inset).
      // With the wordmark removed (Kari's 2026-08-05 pass) the stack starts
      // right below the band.
      // Bottom: 12 rather than 28 — with the footer's own 14px that left 42px
      // of dead space under the user card, which read as the rail failing to
      // reach the bottom of the window.
      padding: 'calc(16px + var(--donna-titlebar-h, 12px)) 0 12px',
      display: 'flex',
      flexDirection: 'column',
      position: 'sticky',
      top: 0,
      height: '100vh',
      // Transparent chrome on the shell ground (panels-on-ground): the
      // window's sunset ground shows through; the workspace panel to the
      // right provides the visual edge, so no border-right either.
      background: 'transparent',
      // Chrome runs the platform face at regular weight; DM Sans stays the
      // content voice (see D.ui in design-tokens.js).
      fontFamily: D.ui,
      color: D.ink
    }}
  >
    {/* No wordmark — the rail starts straight at the nav (Kari's 2026-08-05
        sidebar pass; the brand lives on the landing, not the chrome). */}

    {/* Section header is only rendered in the empty-firm case — when ventures
        exist, the "Inbox" home button below already serves as the
        section label. With both rendered, the inactive home button (plain
        text styling) reads as a duplicate of the header on entity views. */}
    {isEmpty && (
      <div style={{ padding: '0 14px 6px 22px', fontSize: 12, color: D.inkMute, marginBottom: 4, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span>{intl.formatMessage({ id: 'mounted.sidebar.inbox' })}</span>
        <span style={{ fontSize: 12, color: D.inkMute, ...D.tabular }}>0</span>
      </div>
    )}

    <nav style={{ display: 'flex', flexDirection: 'column', padding: '0 8px' }} aria-label={intl.formatMessage({ id: 'mounted.sidebar.scope' })}>
      {/* Inbox (Home) — the cross-venture worklist. Hidden when the firm has
          zero ventures so the rail doesn't echo a duplicate placeholder
          above an empty list. */}
      {!isEmpty && (
        <button
          type="button"
          onClick={onHome}
          style={{
            font: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: D.icon.gap,
            padding: '8px 14px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            textAlign: 'start',
            background: isHomeSelected ? SELECTED_WASH : 'transparent',
            color: D.ink,
            fontSize: 15,
            lineHeight: 1.35,
            // Selection is carried by the background wash ALONE — the same
            // rule D.icon already states for icons ("selection is carried by
            // ink and background, never by a heavier icon"), now true of the
            // label too (Kari, 2026-08-08). A weight that changes on click
            // makes the row reflow by a hair and reads as emphasis where the
            // wash has already said it.
            fontWeight: 400
          }}
        >
          <InboxIcon />
          <span style={{ flex: 1 }}>{intl.formatMessage({ id: 'mounted.sidebar.inbox' })}</span>
          {homeCount > 0 && (
            <span style={{ fontSize: 12, color: D.inkMute, ...D.tabular }}>{homeCount}</span>
          )}
        </button>
      )}

      {/* Team — the bench screen (Donna, AI teammates, your people). Rendered
          in the empty-firm case too: the team exists before the first venture
          does, and the screen is part of how the concept is explained. */}
      {onTeam && (
        <button
          type="button"
          onClick={onTeam}
          style={{
            font: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: D.icon.gap,
            padding: '8px 14px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            textAlign: 'start',
            background: activeTab === 'team' ? SELECTED_WASH : 'transparent',
            color: D.ink,
            fontSize: 15,
            lineHeight: 1.35,
            fontWeight: 400
          }}
        >
          <TeamIcon />
          <span style={{ flex: 1 }}>{intl.formatMessage({ id: 'mounted.sidebar.team' })}</span>
        </button>
      )}

      {/* Feedback — the "tell the maker" lane (bug / idea / thought), directly
          under Inbox per Kari's 2026-08-05 ask. Opens the FeedbackModal; not a
          tab, so it carries no selected state. Rendered in the empty-firm case
          too — feedback must be reachable before the first venture exists. */}
      {onFeedback && (
        <button
          type="button"
          onClick={onFeedback}
          style={{
            font: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: D.icon.gap,
            padding: '8px 14px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            textAlign: 'start',
            background: 'transparent',
            color: D.ink,
            fontSize: 15,
            lineHeight: 1.35,
            fontWeight: 400
          }}
        >
          <FeedbackIcon />
          <span style={{ flex: 1 }}>{intl.formatMessage({ id: 'mounted.sidebar.feedback' })}</span>
        </button>
      )}

      {/* The entities section: grey title row whose add button reveals on
          hover/focus of the section (`.firm-rail-entities` in styles.css) —
          replacing the old always-visible "+ Add venture" text row. */}
      {!isEmpty && (
        <div className="firm-rail-entities" style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 22 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 8px 4px 14px',
              // 12/500, no tracking — the old 11.5/600 + letterspacing
              // read as tiny pseudo-enterprise chrome (2026-08-08).
              fontSize: 12,
              fontWeight: 500,
              color: D.inkMute
            }}
          >
            <span>{intl.formatMessage({ id: 'mounted.sidebar.entities' })}</span>
            <button
              type="button"
              className="firm-rail-entities__add"
              onClick={onNewEntity}
              title={intl.formatMessage({ id: 'mounted.sidebar.addVenture' })}
              aria-label={intl.formatMessage({ id: 'mounted.sidebar.addVenture' })}
              style={{
                width: 20,
                height: 20,
                padding: 0,
                border: 'none',
                borderRadius: 999,
                background: SELECTED_WASH,
                color: D.inkSoft,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: '0 0 auto'
              }}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>

          {clients.map((client, index) => {
            const openCount = countForClient(client.id);
            const risk = clientRisk(client);
            const selected = activeTab === 'queue' && !isHomeSelected && selectedClientId === client.id;
            const dormant = risk === 'complete' && openCount === 0;
            const dot = colorForClient(client, index);

            return (
              <button
                key={client.id}
                type="button"
                onClick={() => onSelectClient(client.id)}
                style={{
                  font: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                  gap: D.icon.gap,
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'start',
                  background: selected ? SELECTED_WASH : 'transparent',
                  color: D.ink,
                  fontSize: 14.5,
                  lineHeight: 1.35,
                  // Same weight selected or not — see the Inbox button above.
                  fontWeight: 400,
                  opacity: dormant ? 0.5 : 1
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 6, height: 6, borderRadius: 999, background: dot, flex: '0 0 auto' }}
                />
                <span
                  title={client.companyName}
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <BidiText direction="auto">{shortClientName(client.companyName)}</BidiText>
                </span>
                {/* Count stays visible on the selected venture — losing the
                    number exactly where you're working was a bug, not a style. */}
                {openCount > 0 && (
                  <span style={{ fontSize: 12, color: D.inkMute, ...D.tabular }}>{openCount}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </nav>

    {/* "Add venture" as the rail's primary CTA only when there are no
        ventures yet — matched by the EmptyFirmState card on the canvas.
        With ventures present the add affordance is the Entities header's
        hover button above. */}
    {isEmpty && (
      <div style={{ padding: '14px 22px' }}>
        <button
          type="button"
          onClick={onNewEntity}
          style={{
            font: 'inherit',
            fontSize: 12.5,
            fontWeight: 500,
            color: D.paper,
            background: D.ink,
            border: 'none',
            padding: '8px 14px',
            borderRadius: 999,
            cursor: 'pointer',
            letterSpacing: '0.02em'
          }}
        >
          + {intl.formatMessage({ id: 'mounted.sidebar.addVenture' })}
        </button>
      </div>
    )}

    <div style={{ flex: 1 }} />

    {/* The user card opens the user menu (Kari, 2026-08-07: the native
        pattern — Settings, shortcuts, feedback, and sign-out group behind
        the identity card instead of the card being a bare Settings link).
        Identity: the operator profile (Settings → Profile, local to this
        machine); subtitle is the signed-in email on web, the firm name on
        the desktop appliance (which has no sign-in — the proxy injects
        credentials main-side, so there's no account and no Log out). */}
    {(() => {
      const profile = isDesktopShell() ? getOperatorProfile() : null;
      const authEmail = getAuthSession()?.user?.email || '';
      const displayName = profile?.name || (authEmail
        ? authEmail.split('@')[0]
        : intl.formatMessage({ id: 'mounted.sidebar.operator' }));
      const displayInitials = profile?.initials || initialsFromName(displayName);
      const subtitle = authEmail || firmName || 'Donna';
      const menuItems = [
        { id: 'settings', label: intl.formatMessage({ id: 'mounted.sidebar.settings' }), hint: '⌘,', onSelect: () => onSettings?.() },
        { id: 'shortcuts', label: intl.formatMessage({ id: 'mounted.sidebar.shortcuts' }), onSelect: () => onSettings?.('shortcuts') },
        ...(onFeedback ? [{ id: 'feedback', label: intl.formatMessage({ id: 'mounted.sidebar.sendFeedback' }), onSelect: onFeedback }] : []),
        ...(onLogout ? [{ id: 'logout', label: intl.formatMessage({ id: 'mounted.sidebar.logOut' }), separatorBefore: true, onSelect: onLogout }] : [])
      ];
      return (
        <div style={{ padding: '0 8px' }}>
          <OverflowMenu
            label={intl.formatMessage({ id: 'mounted.sidebar.userMenu' })}
            placement="up"
            align="start"
            header={
              <div style={{ minWidth: 210 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.ink }}><BidiText direction="auto">{displayName}</BidiText></div>
                <div style={{ fontSize: 11.5, color: D.inkMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <BidiText direction="auto">{subtitle}</BidiText>
                </div>
              </div>
            }
            items={menuItems}
            renderTrigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-label={intl.formatMessage({ id: 'mounted.sidebar.userMenu' })}
                aria-haspopup="menu"
                aria-expanded={open}
                title={displayName}
                style={{
                  font: 'inherit',
                  width: '100%',
                  padding: '10px 8px',
                  border: 'none',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: D.icon.gap,
                  cursor: 'pointer',
                  textAlign: 'start',
                  background: open || activeTab === 'settings' ? SELECTED_WASH : 'transparent'
                }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 999,
                    background: D.ink,
                    color: D.paper,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 600,
                    flex: '0 0 auto'
                  }}
                >
                  {displayInitials}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <BidiText direction="auto">{displayName}</BidiText>
                  </div>
                  <div style={{ fontSize: 11.5, color: D.inkMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <BidiText direction="auto">{subtitle}</BidiText>
                  </div>
                </div>
                {/* Native popover convention: the paired up/down caret. */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke={D.inkMute}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flex: '0 0 auto' }}
                >
                  <polyline points="7 9 12 4 17 9" />
                  <polyline points="7 15 12 20 17 15" />
                </svg>
              </button>
            )}
          />
        </div>
      );
    })()}
  </aside>
  );
};

export default FirmSidebar;
