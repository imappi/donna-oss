import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

import { D } from './shared/design-tokens.js';
import { StatusChip } from './shared/StatusChip.jsx';
import { Btn } from './shared/btn.jsx';
import { presentFeedBuckets } from './shared/feed-list.jsx';
import { getOperatorProfile, initialsFromName } from '../lib/operatorProfile.js';
import { getAuthSession } from '../lib/accessToken.js';
import { fetchRoleRoster, hireFirmRole, endFirmRole, fetchFirmSeats, inviteFirmSeat, resendFirmSeatInvite } from '../lib/firmApi.js';
import {
  roleChipMessage, roleCtaMessage, roleStatusMessage, hireConfirmMessage, narrateTeamworkEventMessage,
  grantSummaryParts, isRoleHired, ROLE_PERSONA_LABELS
} from '../lib/teamRosterView.js';
import { BidiText, IdentifierText } from '../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';

// The Team screen — the bench made visible (design-donna-specialist-roles.md
// §4/§6). Buzz scale kept from the S3 preview: big cards, big mascots, one
// short line of copy per card, generous air.
//
// S3: behind the SPECIALIST_ROLE_BENCH_UI flag the cards render PERSISTED
// state — the roster read off client_assignments, the config plane, and the
// grant store. Status lines are ownership projections (INV-S8: 'All handled'
// or 'N waiting on you'), chips follow the certification claim ladder
// (INV-S9), and the hire/end controls land on the S2 employment writers
// server-side (INV-S10: hiring authorizes nothing).
//
// TEAM-SCREEN RECEDE (Kari, 2026-08-14): this screen is the org chart and
// hiring, nothing else. No per-role thread and no authority forms live here —
// all teammate interaction, including approving/revoking standing authority,
// happens in the chat (the approve_role_grant / revoke_role_grant proposals).
// The hired-card detail renders authority READ-ONLY. With the flag off (or in
// local mode) the screen stays the static preview.

const FIRM_MOVE_BUCKETS = ['operator_blocker'];

const feedWaitingOnYou = (feed) => {
  const presented = presentFeedBuckets(feed?.buckets);
  return FIRM_MOVE_BUCKETS.reduce((sum, bucket) => sum + (presented[bucket]?.length || 0), 0);
};

// Mascot avatar on the donna-buddy pipeline (firm-dock.jsx): renders the PNG
// under public/ as-is (tight square crop, transparent background, no circular
// crop); falls back to an initials circle until the file lands or on 404.
const Avatar = ({ src = null, label, filled = false, imgSize = 128, circleSize = 88 }) => {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
        style={{ width: imgSize, height: imgSize, objectFit: 'contain', flex: '0 0 auto' }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      style={{
        width: circleSize,
        height: circleSize,
        borderRadius: 999,
        background: filled ? D.ink : D.ruleSoft,
        color: filled ? D.paper : D.inkSoft,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: circleSize >= 72 ? 22 : 14,
        fontWeight: 600,
        flex: '0 0 auto'
      }}
    >
      {label}
    </div>
  );
};

// Status label pill — a stated plan or state, deliberately not a <button>:
// a control that does nothing would be a fake; a label cannot lie.
const LabelPill = ({ children }) => (
  <span
    style={{
      display: 'inline-block',
      padding: '7px 16px',
      borderRadius: 999,
      background: D.ruleSoft,
      color: D.inkMute,
      fontSize: 13,
      fontWeight: 600,
      whiteSpace: 'nowrap'
    }}
  >
    {children}
  </span>
);

const GroupLabel = ({ children }) => (
  <div style={{ fontSize: 13.5, fontWeight: 600, color: D.inkMute, margin: '44px 2px 14px' }}>
    {children}
  </div>
);

const cardBase = {
  background: D.paperDeep,
  borderRadius: 18,
  padding: '26px 24px 22px'
};

// Persona names live on the AI occupant, never the role (AIProfile in the
// specialist-roles doc §1): the card leads with the name, the ROLE stays the
// subtitle, so a future human occupant slots into the same card shape.
// roleId keys each card into the server roster (roleRegistry ids).
const TEAMMATES = [
  {
    id: 'collections',
    roleId: 'invoicing_collections',
    name: ROLE_PERSONA_LABELS.invoicing_collections,
    roleIdMessage: 'mounted.team.role.collections',
    initials: 'C',
    descId: 'mounted.team.role.collectionsDesc'
  },
  {
    id: 'tax',
    roleId: 'tax',
    name: ROLE_PERSONA_LABELS.tax,
    roleIdMessage: 'mounted.team.role.tax',
    initials: 'V',
    descId: 'mounted.team.role.taxDesc'
  },
  {
    id: 'inventory',
    roleId: 'inventory_purchasing',
    name: ROLE_PERSONA_LABELS.inventory_purchasing,
    roleIdMessage: 'mounted.team.role.inventory',
    initials: 'M',
    descId: 'mounted.team.role.inventoryDesc'
  }
];

// The hired role's card detail — READ-ONLY since the team-screen recede
// (Kari, 2026-08-14): the Team screen is the org chart and hiring, nothing
// else. All interaction with a teammate — including approving or revoking
// standing authority — happens in the chat (approve_role_grant /
// revoke_role_grant proposals through the one apply spine). This detail
// renders the persisted authority state and keeps End role; it holds no
// thread and no forms.
const RoleDesk = ({ mate, role, busy, onAction, onClose }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const grants = role?.grants || [];

  return (
    <div style={{ ...cardBase, marginTop: 18, padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 17, fontWeight: 700 }}><BidiText direction="auto">{mate.name}</BidiText></span>
        <span style={{ fontSize: 13.5, color: D.inkMute }}>{message(mate.roleIdMessage)}</span>
        <StatusChip label={message('mounted.team.supervised')} tone="ok" />
        <div style={{ marginInlineStart: 'auto' }}>
          <Btn small onClick={onClose}>{message('mounted.team.close')}</Btn>
        </div>
      </div>

      <div style={{ fontSize: 13.5, fontWeight: 600, color: D.inkMute, margin: '20px 0 8px' }}>
        {message('mounted.team.authority')}
      </div>
      {grants.length === 0 && (
        <div style={{ fontSize: 13.5, color: D.inkSoft }}>
          {message('mounted.team.authorityNone', { name: mate.name })}
        </div>
      )}
      {grants.map((grant) => (
        <div key={grant.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
          <span style={{ fontSize: 13.5, color: D.ink, ...D.tabular }}>{(() => {
            const parts = grantSummaryParts(grant);
            let summary = parts.scopeKey
              ? message('mounted.team.grant.scope', { action: parts.action, scope: parts.scopeKey })
              : parts.action;
            if (parts.amount != null && parts.currency) summary = message('mounted.team.grant.ceiling', { summary, amount: parts.amount, currency: parts.currency });
            if (parts.expiresAt) summary = message('mounted.team.grant.until', { summary, date: parts.expiresAt });
            else if (parts.reviewAfter) summary = message('mounted.team.grant.review', { summary, date: parts.reviewAfter });
            return summary;
          })()}</span>
          {grant.status !== 'active' && <StatusChip label={grant.status} tone="amber" />}
        </div>
      ))}
      <div style={{ fontSize: 12.5, color: D.inkMute, marginTop: 10 }}>
        {message('mounted.team.authorityChat', { name: mate.name })}
      </div>

      <div style={{ marginTop: 20 }}>
        <Btn
          small
          danger
          disabled={busy}
          onClick={() => {
            if (window.confirm(message('mounted.team.endConfirm', { name: mate.name }))) {
              onAction('end', {});
            }
          }}
        >
          {message('mounted.team.endRole')}
        </Btn>
      </div>
    </div>
  );
};

// ── Human seats (docs/design-donna-seats-roles-access.md §6) ────────────────

const SEAT_ROLE_LABELS = {
  owner: 'mounted.team.owner', partner: 'mounted.team.partner', senior: 'mounted.team.senior', junior: 'mounted.team.junior'
};
const SEAT_STATUS_TONE = { active: 'ok', invited: 'amber', suspended: 'muted' };

const SeatCard = ({ seat, entities = [], onResendInvite = null, resendBusy = false }) => {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const entityName = (id) => entities.find((entity) => entity.id === id)?.company_name || id;
  const scopeLine = seat.client_ids == null
    ? message('mounted.team.allVentures')
    : seat.client_ids.length === 0
      ? message('mounted.team.noEntities')
      : seat.client_ids.map(entityName).join(' · ');
  // The invite-email receipt (migration 125): a send that skipped or failed
  // is a durable roster fact, not a transient notice — and while the seat is
  // still pending, the owner can resend from here.
  const emailStatus = seat.status === 'invited' ? seat.invite_email_status : null;
  return (
    <div style={{ ...cardBase, display: 'flex', flexDirection: 'column' }}>
      <div style={{ margin: '6px auto 20px' }}>
        <Avatar label={initialsFromName(seat.name || seat.email)} filled={seat.seat_role === 'owner'} circleSize={88} />
      </div>
      <div style={{ fontSize: 16.5, fontWeight: 600, letterSpacing: '-0.005em' }}><BidiText direction="auto">{seat.name || seat.email}</BidiText></div>
      <div style={{ marginTop: 5, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusChip label={SEAT_ROLE_LABELS[seat.seat_role] ? message(SEAT_ROLE_LABELS[seat.seat_role]) : seat.seat_role} tone="ok" />
        {seat.status !== 'active' && (
          <StatusChip
            label={message(seat.status === 'invited' ? 'mounted.team.invited' : 'mounted.team.suspended')}
            tone={SEAT_STATUS_TONE[seat.status] || 'muted'}
          />
        )}
        {/* The External badge is mandatory fencing visibility (build spec
            §4.5): everywhere the seat appears, the affiliation shows. */}
        {seat.affiliation === 'external' && <StatusChip label={message('mounted.team.external')} tone="amber" />}
        {emailStatus && emailStatus !== 'sent' && (
          <span title={seat.invite_email_reason || undefined}>
            <StatusChip label={message('mounted.team.inviteEmailStatus', { status: emailStatus })} tone="amber" />
          </span>
        )}
      </div>
      <div style={{ fontSize: 13.5, color: D.inkMute, marginTop: 10 }}><IdentifierText>{seat.email}</IdentifierText></div>
      <div style={{ fontSize: 13, color: D.inkMute, marginTop: 6 }}><BidiText direction="auto">{scopeLine}</BidiText></div>
      {seat.ends_at && (
        <div style={{ fontSize: 12.5, color: D.inkMute, marginTop: 4 }}>
          {message('mounted.team.engagementUntil', { date: formatDate(String(seat.ends_at).slice(0, 10)) })}
        </div>
      )}
      {seat.status === 'invited' && onResendInvite && (
        <div style={{ marginTop: 12 }}>
          <Btn small disabled={resendBusy} onClick={() => onResendInvite(seat)}>
            {message(resendBusy ? 'mounted.team.resending' : 'mounted.team.resend')}
          </Btn>
        </div>
      )}
    </div>
  );
};

const inviteFieldStyle = {
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${D.rule}`,
  borderRadius: 8,
  padding: '8px 10px',
  background: D.paper,
  color: D.ink,
  fontFamily: D.ui,
  fontSize: 13.5
};

const SeatInviteCard = ({ form, setForm, entities = [], busy, valid, error, onCancel, onSubmit }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  const external = form.affiliation === 'external';
  const toggleEntity = (id) => set({
    clientIds: form.clientIds.includes(id)
      ? form.clientIds.filter((existing) => existing !== id)
      : [...form.clientIds, id]
  });
  return (
    <div style={{ ...cardBase, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{message('mounted.team.invite')}</div>
      <input
        style={inviteFieldStyle}
        placeholder={message('mounted.team.name')}
        dir="auto"
        value={form.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      <input
        style={inviteFieldStyle}
        placeholder={message('mounted.team.email')}
        dir="ltr"
        type="email"
        value={form.email}
        onChange={(event) => set({ email: event.target.value })}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <select
          style={{ ...inviteFieldStyle, flex: 1 }}
          value={form.seatRole}
          onChange={(event) => set({ seatRole: event.target.value })}
        >
          <option value="junior">{message('mounted.team.junior')}</option>
          <option value="senior">{message('mounted.team.senior')}</option>
          <option value="partner">{message('mounted.team.partner')}</option>
        </select>
        <select
          style={{ ...inviteFieldStyle, flex: 1 }}
          value={form.affiliation}
          onChange={(event) => set({ affiliation: event.target.value })}
        >
          <option value="internal">{message('mounted.team.internal')}</option>
          <option value="external">{message('mounted.team.external')}</option>
        </select>
      </div>
      {entities.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 132, overflowY: 'auto' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: D.inkMute }}>
            {message(external ? 'mounted.team.entitiesExternal' : 'mounted.team.entitiesDefault')}
          </div>
          {entities.map((entity) => (
            <label key={entity.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: D.inkSoft }}>
              <input
                type="checkbox"
                checked={form.clientIds.includes(entity.id)}
                onChange={() => toggleEntity(entity.id)}
              />
              <BidiText direction="auto">{entity.company_name || entity.id}</BidiText>
            </label>
          ))}
        </div>
      )}
      <label style={{ fontSize: 12.5, fontWeight: 600, color: D.inkMute }}>
        {message(external ? 'mounted.team.endDateRequired' : 'mounted.team.endDateOptional')}
        <input
          style={{ ...inviteFieldStyle, marginTop: 4 }}
          type="date"
          value={form.endsAt}
          onChange={(event) => set({ endsAt: event.target.value })}
        />
      </label>
      {error && <div style={{ fontSize: 13, color: D.alert }}><BidiText direction="auto">{error}</BidiText></div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <Btn small onClick={onCancel} disabled={busy}>{message('mounted.venture.cancel')}</Btn>
        <Btn small primary onClick={onSubmit} disabled={busy || !valid}>
          {message(busy ? 'mounted.team.inviting' : 'mounted.team.sendInvite')}
        </Btn>
      </div>
    </div>
  );
};

const TeamPanel = ({
  clients = [],
  feed = null,
  selectedClientId = null,
  dataSource = 'local',
  onSnapshotApplied = null
}) => {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const profile = getOperatorProfile();
  const authEmail = getAuthSession()?.user?.email || '';
  const operatorName = profile?.name || (authEmail ? authEmail.split('@')[0] : message('mounted.team.operator'));
  const operatorInitials = profile?.initials || initialsFromName(operatorName);
  const waitingOnYou = feed ? feedWaitingOnYou(feed) : null;

  // The roster is per venture; default to the workspace selection.
  const [ventureOverride, setVentureOverride] = useState(null);
  const clientId = ventureOverride || selectedClientId || clients[0]?.id || null;

  const [roster, setRoster] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [openRoleId, setOpenRoleId] = useState(null);

  const reload = useCallback(async ({ signal } = {}) => {
    if (dataSource !== 'database' || !clientId) {
      setRoster(null);
      return;
    }
    try {
      const data = await fetchRoleRoster({ clientId, signal });
      setRoster(data?.roster || null);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // A dark lane (404/503) degrades to the static preview, silently.
      setRoster(null);
    }
  }, [dataSource, clientId]);

  useEffect(() => {
    const controller = new AbortController();
    reload({ signal: controller.signal });
    return () => controller.abort();
  }, [reload]);

  const benchMode = roster?.bench?.mode || 'off';
  const rosterRole = (roleId) => roster?.roles?.find((role) => role.id === roleId) || null;

  // Human seats (docs/design-donna-seats-roles-access.md §6): the FIRM-level
  // roster behind "Your people", plus the invite flow the Add member card
  // opens. Local mode (or a fenced/denied read) degrades to the local
  // operator card — the pre-seats rendering, unchanged.
  const [seatRoster, setSeatRoster] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState(null);
  const [inviteNotice, setInviteNotice] = useState(null);
  const emptyInvite = { name: '', email: '', seatRole: 'junior', affiliation: 'internal', clientIds: [], endsAt: '' };
  const [inviteForm, setInviteForm] = useState(emptyInvite);
  const [resendingSeatId, setResendingSeatId] = useState(null);

  const reloadSeats = useCallback(async ({ signal } = {}) => {
    if (dataSource !== 'database') {
      setSeatRoster(null);
      return;
    }
    try {
      const data = await fetchFirmSeats({ signal });
      setSeatRoster(data && Array.isArray(data.seats) ? data : null);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setSeatRoster(null); // dark lane or the external-seat fence: static card
    }
  }, [dataSource]);

  useEffect(() => {
    const controller = new AbortController();
    reloadSeats({ signal: controller.signal });
    return () => controller.abort();
  }, [reloadSeats]);

  const inviteIsExternal = inviteForm.affiliation === 'external';
  const inviteValid = Boolean(
    inviteForm.name.trim() && /@/.test(inviteForm.email)
    && (!inviteIsExternal || (inviteForm.clientIds.length > 0 && inviteForm.endsAt))
  );

  const submitInvite = async () => {
    if (inviteBusy || !inviteValid) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const result = await inviteFirmSeat({
        name: inviteForm.name.trim(),
        email: inviteForm.email.trim(),
        seatRole: inviteForm.seatRole,
        affiliation: inviteForm.affiliation,
        clientIds: inviteForm.clientIds,
        endsAt: inviteForm.endsAt ? new Date(`${inviteForm.endsAt}T23:59:59Z`).toISOString() : null
      });
      const emailStatus = result?.invite_email?.status || 'skipped';
      setInviteNotice(message(
        emailStatus === 'sent' ? 'mounted.team.inviteSent' : 'mounted.team.inviteStatus',
        { email: result?.seat?.email || '', status: emailStatus }
      ));
      setInviteOpen(false);
      setInviteForm(emptyInvite);
      await reloadSeats();
    } catch (err) {
      setInviteError(err?.message || message('mounted.team.inviteFailed'));
    } finally {
      setInviteBusy(false);
    }
  };

  const resendInvite = async (seat) => {
    if (resendingSeatId) return;
    setResendingSeatId(seat.id);
    setInviteError(null);
    try {
      const result = await resendFirmSeatInvite({ seatId: seat.id });
      const emailStatus = result?.invite_email?.status || 'skipped';
      setInviteNotice(message(
        emailStatus === 'sent' ? 'mounted.team.resendSent' : 'mounted.team.resendStatus',
        { email: seat.email, status: emailStatus, reason: result?.invite_email?.reason || 'none' }
      ));
      await reloadSeats();
    } catch (err) {
      setInviteError(err?.message || message('mounted.team.resendFailed'));
    } finally {
      setResendingSeatId(null);
    }
  };

  const runAction = async (mate, kind, params = {}) => {
    if (!clientId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      if (kind === 'hire') await hireFirmRole({ clientId, roleId: mate.roleId });
      else if (kind === 'end') {
        await endFirmRole({ clientId, roleId: mate.roleId });
        setOpenRoleId(null);
      }
      await reload();
    } catch (err) {
      setActionError(err?.message || message('mounted.team.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const openMate = openRoleId ? TEAMMATES.find((mate) => mate.roleId === openRoleId) : null;
  const openRole = openRoleId ? rosterRole(openRoleId) : null;

  // S5: teamwork narration — deterministic renderings of the persisted role
  // events on the roster read (INV-S5: the narration renders events; there is
  // no channel). Unknown shapes render nothing.
  const teamworkLines = benchMode !== 'off'
    ? (roster?.teamwork || []).map(narrateTeamworkEventMessage).filter(Boolean)
    : [];

  const donnaCounts = [
    message('mounted.team.ventures', { count: clients.length }),
    ...(waitingOnYou !== null
      ? [waitingOnYou === 0 ? message('mounted.team.waiting.none') : message('mounted.team.waiting.count', { count: waitingOnYou })]
      : [])
  ].join(' · ');

  return (
    <section
      aria-label={message('mounted.team.aria')}
      style={{
        maxWidth: 1020,
        fontFamily: D.ui,
        color: D.ink,
        padding: '40px 48px 96px',
        lineHeight: 1.5
      }}
    >
      <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.015em', margin: '0 0 5px' }}>{message('mounted.team.title')}</h2>
      <p style={{ fontSize: 15.5, color: D.inkMute, margin: '0 0 30px' }}>
        {message('mounted.team.subtitle')}
      </p>

      {/* Donna, the manager. Full-width card so the hierarchy reads at a
          glance; the counts line renders from the feed's firm-move buckets. */}
      <div style={{ ...cardBase, display: 'flex', alignItems: 'center', gap: 26, padding: '26px 30px' }}>
        <Avatar src="/donna-buddy.png" label="D" filled imgSize={124} circleSize={84} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.01em' }}>{message('mounted.team.donna')}</span>
            <StatusChip label={message('mounted.team.autoEngaged')} tone="ok" />
          </div>
          <div style={{ fontSize: 14.5, color: D.inkMute, marginTop: 3 }}>{message('mounted.team.manager')}</div>
          <div style={{ fontSize: 14, color: D.inkSoft, marginTop: 14, ...D.tabular }}>{donnaCounts}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <GroupLabel>{message('mounted.team.ai')}</GroupLabel>
        {roster && clients.length > 1 && (
          <select
            value={clientId || ''}
            onChange={(event) => { setOpenRoleId(null); setVentureOverride(event.target.value); }}
            style={{
              padding: '3px 8px', borderRadius: 6, border: `1px solid ${D.rule}`,
              background: D.paper, color: D.inkSoft, fontFamily: D.ui, fontSize: 12.5
            }}
          >
            {clients.map((client) => (
              <option key={client.id} value={client.id}>{client.name || client.id}</option>
            ))}
          </select>
        )}
      </div>
      {actionError && (
        <div style={{ fontSize: 13.5, color: D.alert, margin: '0 2px 12px' }}><BidiText direction="auto">{actionError}</BidiText></div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
          gap: 18
        }}
      >
        {TEAMMATES.map((mate) => {
          const role = rosterRole(mate.roleId);
          const hired = isRoleHired(role);
          const chip = role ? roleChipMessage(role) : null;
          const statusLine = role ? roleStatusMessage(role) : null;
          const cta = role && benchMode !== 'off'
            ? roleCtaMessage(role, benchMode)
            : { kind: 'label', labelId: 'mounted.team.comingSoon' };
          return (
            <div key={mate.id} style={{ ...cardBase, display: 'flex', flexDirection: 'column' }}>
              <div style={{ margin: '6px auto 20px' }}>
                <Avatar src={`/team-${mate.id}.png`} label={mate.initials} imgSize={132} circleSize={88} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16.5, fontWeight: 600, letterSpacing: '-0.005em' }}><BidiText direction="auto">{mate.name}</BidiText></span>
                {chip && <StatusChip label={message(chip.labelId)} tone={chip.tone} />}
              </div>
              <div style={{ fontSize: 13.5, color: D.inkMute, marginTop: 3 }}>{message(mate.roleIdMessage)}</div>
              <p style={{ fontSize: 14, color: D.inkSoft, margin: '10px 0 18px' }}>
                {statusLine ? message(statusLine.id, statusLine.values) : message(mate.descId)}
              </p>
              <div style={{ marginTop: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                {hired && benchMode === 'act' && (
                  <Btn
                    small
                    primary
                    disabled={busy}
                    onClick={() => setOpenRoleId(openRoleId === mate.roleId ? null : mate.roleId)}
                  >
                    {message(openRoleId === mate.roleId ? 'mounted.team.closeDesk' : 'mounted.team.openDesk')}
                  </Btn>
                )}
                {hired && benchMode !== 'act' && <LabelPill>{message('mounted.team.onTeam')}</LabelPill>}
                {cta?.kind === 'hire' && (
                  <Btn
                    small
                    disabled={busy}
                    onClick={() => {
                      const confirmation = hireConfirmMessage({ role });
                      const lanes = confirmation.staged.length
                        ? confirmation.staged.map((flag) => message('mounted.team.laneChange', {
                            flag: flag.flag_key,
                            from: flag.from ?? message('mounted.team.laneOff'),
                            to: flag.to
                          })).join('\n')
                        : message('mounted.team.noLaneChanges');
                      if (window.confirm(message('mounted.team.hireConfirm', { ...confirmation, lanes }))) runAction(mate, 'hire');
                    }}
                  >
                    {message('mounted.team.hire')}
                  </Btn>
                )}
                {cta?.kind === 'label' && <LabelPill>{message(cta.labelId)}</LabelPill>}
              </div>
            </div>
          );
        })}
      </div>

      {openMate && openRole && isRoleHired(openRole) && benchMode === 'act' && (
        <RoleDesk
          key={openRoleId}
          mate={openMate}
          role={openRole}
          busy={busy}
          onAction={(kind, params) => runAction(openMate, kind, params)}
          onClose={() => setOpenRoleId(null)}
        />
      )}

      {/* S5: team activity — persisted role events narrated as teamwork.
          Every line is a deterministic rendering of a receipted handoff;
          nothing here is generated or freeform (INV-S5). */}
      {teamworkLines.length > 0 && (
        <>
          <GroupLabel>{message('mounted.team.activity')}</GroupLabel>
          <div style={{ ...cardBase, padding: '18px 24px' }}>
            {teamworkLines.map((row) => (
              <div
                key={row.id}
                style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '5px 0' }}
              >
                <span style={{ fontSize: 13.5, color: D.inkSoft }}><BidiText direction="auto">{message(row.messageId, {
                  ...row.values,
                  thing: row.values?.thingId ? message(row.values.thingId) : undefined
                })}</BidiText></span>
                {row.at && (
                  <span style={{ marginInlineStart: 'auto', fontSize: 12, color: D.inkMute, ...D.tabular }}>
                    {formatDate(String(row.at).slice(0, 10))}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <GroupLabel>{message('mounted.team.people')}</GroupLabel>
      {inviteNotice && (
        <div style={{ fontSize: 13.5, color: D.inkSoft, margin: '0 2px 12px' }}><BidiText direction="auto">{inviteNotice}</BidiText></div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
          gap: 18
        }}
      >
        {seatRoster?.seats?.length > 0 ? (
          seatRoster.seats.map((seat) => (
            <SeatCard
              key={`${seat.source}-${seat.id}`}
              seat={seat}
              entities={seatRoster.entities || []}
              onResendInvite={resendInvite}
              resendBusy={resendingSeatId === seat.id}
            />
          ))
        ) : (
          <div style={{ ...cardBase, display: 'flex', flexDirection: 'column' }}>
            <div style={{ margin: '6px auto 20px' }}>
              <Avatar label={operatorInitials} filled circleSize={88} />
            </div>
            <div style={{ fontSize: 16.5, fontWeight: 600, letterSpacing: '-0.005em' }}><BidiText direction="auto">{operatorName}</BidiText></div>
            <div style={{ marginTop: 5 }}>
              <StatusChip label={message('mounted.team.owner')} tone="ok" />
            </div>
            {authEmail && (
              <div style={{ fontSize: 13.5, color: D.inkMute, marginTop: 10 }}><IdentifierText>{authEmail}</IdentifierText></div>
            )}
          </div>
        )}

        {/* Add member — live against the seats API in database mode (invite →
            sign-in activates); local mode keeps the stated-plan card (a div,
            not a button: it states the plan instead of faking the flow). */}
        {dataSource === 'database' && !inviteOpen ? (
          <button
            type="button"
            onClick={() => { setInviteError(null); setInviteOpen(true); }}
            style={{
              border: `1.5px dashed ${D.rule}`,
              background: 'transparent',
              borderRadius: 18,
              padding: '26px 24px 22px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              minHeight: 220,
              color: D.inkMute,
              cursor: 'pointer',
              fontFamily: D.ui
            }}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <div style={{ fontSize: 15, fontWeight: 600, color: D.inkSoft }}>{message('mounted.team.addMember')}</div>
            <div style={{ fontSize: 13 }}>{message('mounted.team.inviteSeat')}</div>
          </button>
        ) : dataSource !== 'database' ? (
          <div
            style={{
              border: `1.5px dashed ${D.rule}`,
              borderRadius: 18,
              padding: '26px 24px 22px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              minHeight: 220,
              color: D.inkMute
            }}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <div style={{ fontSize: 15, fontWeight: 600, color: D.inkSoft }}>{message('mounted.team.addMember')}</div>
            <div style={{ fontSize: 13 }}>{message('mounted.team.comingSoon')}</div>
          </div>
        ) : null}

        {inviteOpen && (
          <SeatInviteCard
            form={inviteForm}
            setForm={setInviteForm}
            entities={seatRoster?.entities || []}
            busy={inviteBusy}
            valid={inviteValid}
            error={inviteError}
            onCancel={() => { setInviteOpen(false); setInviteError(null); }}
            onSubmit={submitInvite}
          />
        )}
      </div>
    </section>
  );
};

export default TeamPanel;
