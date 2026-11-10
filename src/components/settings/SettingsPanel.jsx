import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

import { T, D } from '../shared/design-tokens.js';
import { btnPrimary, btnChip } from '../shared/buttons.js';
import { Toggle } from '../shared/Toggle.jsx';
import {
  dismissFirmFact, fetchDesktopBackups, fetchFirmFacts, fetchFirmHealth, fetchMcpExposure, fetchModelLanes, runDesktopBackup, setMcpEntityExposure, setModelLanePolicy
} from '../../lib/firmApi.js';
import { describeLastBackup, humanizeBackupCron } from '../../lib/backupsView.js';
import { isDesktopShell } from '../../lib/desktopShell.js';
import {
  clearProviderKey,
  fetchProviderKeyStatus,
  providerKeyStorageSupported,
  saveProviderKeys
} from '../../lib/providerKeys.js';
import { getOperatorProfile, saveOperatorProfile, initialsFromName } from '../../lib/operatorProfile.js';
import { BidiText, FormattedValue, IdentifierText } from '../../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.jsx';
import { PRODUCTION_INTERFACE_LOCALES } from '../../i18n/localeRegistry.js';
import AccountingImportCard from './AccountingImportCard.jsx';
import PhysicalReconciliationPanel from '../inventory/PhysicalReconciliationPanel.jsx';
import FinnishPilotSetupCard from './FinnishPilotSetupCard.jsx';
import RuntimeRepairsCard from './RuntimeRepairsCard.jsx';

// Settings content pane. The NOT-WIRED-tag law was RETIRED for this
// buildout (Kari, 2026-08-07: UI-first — "we are developing these things");
// controls run on local state until their writers land, and the wiring
// follows the screens. Two limits survive the retirement: never fake DATA
// that a live-book decision would rest on (billing samples are fine, a
// fabricated ledger number is not), and never fake PERSISTENCE of something
// the user hands over — a key that silently evaporates is worse than a
// disabled field. Wired for real so far: Memory (firm_facts + dismiss),
// ask auto-send, and the BYO provider keys below.
// Authority-plane flags (auto-post, material FYIs, canaries) deliberately
// have NO surface here: they stage per-venture on the audited script path
// with receipts (the config control plane rail). The one sanctioned
// firm-level toggle is ask auto-send (updateFirmAutoSendSetting). The one
// sanctioned PER-VENTURE toggle is AI chat access (MCP_ENTITY_EXPOSE) —
// design-donna-mcp-surface.md §8 item 1 makes the settings screen the
// consent path, writing through the SAME audited config-plane writer the
// enable script used; it is a data-routing consent, not ledger authority.

// Renderer-side build receipt — injected by vite.config's `define` at build
// time. The typeof guard keeps this module importable outside vite (tests,
// node). Rendered on About: when "my merged UI change doesn't show", this
// row says which bundle the window is actually running (2026-08-07 — the
// day stale dist / packaged app / Electron cache were indistinguishable).
const UI_BUILD = typeof __DONNA_UI_BUILD__ !== 'undefined' ? __DONNA_UI_BUILD__ : 'dev';
// WHAT the bundle was built from (branch @ sha), not just when. The
// 2026-08-07 ping-pong was a fresh, clean build of a stale branch — the
// WHEN stamp read fine while the source was old. Together the two rows
// answer both halves of "is this window running my change".
const UI_SOURCE = typeof __DONNA_UI_SOURCE__ !== 'undefined' ? __DONNA_UI_SOURCE__ : 'dev';

const SECTION_TITLES = {
  profile: ['mounted.settings.section.profile', 'mounted.settings.section.profile.subtitle'],
  notifications: ['mounted.settings.section.notifications', 'mounted.settings.section.notifications.subtitle'],
  shortcuts: ['mounted.settings.section.shortcuts', 'mounted.settings.section.shortcuts.subtitle'],
  firm: ['mounted.settings.section.firm', 'mounted.settings.section.firm.subtitle'],
  autonomy: ['mounted.settings.section.autonomy', 'mounted.settings.section.autonomy.subtitle'],
  claude: ['mounted.settings.section.claude', 'mounted.settings.section.claude.subtitle'],
  memory: ['mounted.settings.section.memory', 'mounted.settings.section.memory.subtitle'],
  billing: ['mounted.settings.section.billing', 'mounted.settings.section.billing.subtitle'],
  ai: ['mounted.settings.section.ai', 'mounted.settings.section.ai.subtitle'],
  data: ['mounted.settings.section.data', 'mounted.settings.section.data.subtitle'],
  about: ['mounted.settings.section.about', 'mounted.settings.section.about.subtitle']
};

// Card group (Kari, 2026-08-07: Buzz's reference, at Buzz's actual scale —
// the first card pass was too timid: white-on-paper cards were invisible
// and the type barely moved). The card is a WASH block on the paper pane —
// paperDeep fill, no border, no divider lines inside; rhythm comes from
// row padding. This is Buzz's grey-fill group translated to Donna's warm
// neutrals; the pure-white content card stays the doctrine elsewhere.
const Card = ({ children }) => (
  <div
    className="settings-card"
    style={{
      background: D.paperDeep,
      borderRadius: 16,
      padding: '8px 24px',
      marginBottom: 16
    }}
  >
    {children}
  </div>
);

const Row = ({ label, desc, children }) => (
  <div
    className="settings-row"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 28,
      padding: '14px 0'
    }}
  >
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 15.5, fontWeight: 600, color: D.ink, letterSpacing: '-0.005em' }}>{label}</div>
      {desc && (
        <div style={{ fontSize: 15, color: D.inkSoft, lineHeight: 1.5, marginTop: 2, maxWidth: 620 }}>
          {desc}
        </div>
      )}
    </div>
    {children}
  </div>
);

const FactValue = ({ children, mono = false }) => (
  <span
    style={{
      fontSize: mono ? 13 : 15,
      fontFamily: mono ? D.mono : 'inherit',
      color: D.ink,
      textAlign: 'end',
      overflowWrap: 'anywhere',
      flex: '0 0 auto',
      maxWidth: 320
    }}
  >
    {children}
  </span>
);

// (The NOT-WIRED tag idiom retired 2026-08-07 — Kari: UI-first, full
// experiences; controls run on local state until their writers land.)

const KeyChip = ({ children }) => (
  <kbd
    style={{
      fontFamily: D.mono,
      fontSize: 13,
      color: D.ink,
      background: 'oklch(0.08 0 0 / 0.04)',
      border: `1px solid ${D.ruleSoft}`,
      borderRadius: 6,
      padding: '3px 9px',
      whiteSpace: 'nowrap'
    }}
  >
    {children}
  </kbd>
);

const FootNote = ({ children }) => (
  <p style={{ fontSize: 14, color: D.inkMute, lineHeight: 1.55, margin: '6px 4px 0', maxWidth: 620 }}>
    {children}
  </p>
);

const inputStyle = {
  font: 'inherit',
  fontSize: 15,
  color: D.ink,
  background: D.card,
  border: `1px solid ${D.rule}`,
  borderRadius: 9,
  padding: '9px 13px',
  width: '100%',
  boxSizing: 'border-box'
};

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
  width: 'auto',
  paddingInlineEnd: 30
};

// ── Sections ────────────────────────────────────────────────────────────────

const ProfileSection = ({ authEmail }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const stored = getOperatorProfile();
  const [name, setName] = useState(stored?.name || '');
  const [initials, setInitials] = useState(stored?.initials || '');
  const [saved, setSaved] = useState(false);

  const save = () => {
    saveOperatorProfile({ name, initials });
    const next = getOperatorProfile();
    setName(next?.name || '');
    setInitials(next?.initials || '');
    setSaved(true);
  };

  if (!isDesktopShell()) return (
    <Card>
      <Row label={message('mounted.settings.profile.account')} desc={message(authEmail ? 'mounted.settings.profile.accountSignedIn' : 'mounted.settings.profile.accountLoading')}>
        {authEmail ? <FactValue mono>{authEmail}</FactValue> : <span style={{ fontSize: 15, color: D.inkMute }}>—</span>}
      </Row>
    </Card>
  );

  return (
    <>
      <Card>
        <Row
          label={message('mounted.settings.profile.displayName')}
          desc={message('mounted.settings.profile.displayNameDesc')}
        >
          <div style={{ flex: '0 0 220px' }}>
            <input
              value={name}
              placeholder={message('mounted.settings.profile.namePlaceholder')}
              onChange={(e) => { setName(e.target.value); setSaved(false); }}
              style={inputStyle}
              aria-label={message('mounted.settings.profile.displayName')}
            />
          </div>
        </Row>
        <Row label={message('mounted.settings.profile.initials')} desc={message('mounted.settings.profile.initialsDesc')}>
          <div style={{ flex: '0 0 90px' }}>
            <input
              value={initials}
              placeholder={initialsFromName(name) === '·' ? 'KH' : initialsFromName(name)}
              maxLength={3}
              onChange={(e) => { setInitials(e.target.value.toUpperCase()); setSaved(false); }}
              style={{ ...inputStyle, fontFamily: D.mono, textTransform: 'uppercase', textAlign: 'center' }}
              aria-label={message('mounted.settings.profile.initials')}
            />
          </div>
        </Row>
        <Row
          label={message('mounted.settings.profile.account')}
          desc={authEmail
            ? message('mounted.settings.profile.accountSignedIn')
            : message('mounted.settings.profile.accountAppliance')}
        >
          {authEmail ? <FactValue mono>{authEmail}</FactValue> : <span style={{ fontSize: 15, color: D.inkMute }}>—</span>}
        </Row>
      </Card>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 18 }}>
        <button type="button" style={btnPrimary} onClick={save} disabled={!name.trim()}>
          {message('mounted.settings.profile.save')}
        </button>
        {saved && <span style={{ fontSize: 14, color: T.ok }}>{message('mounted.settings.profile.saved')}</span>}
      </div>
    </>
  );
};

const LanguageRegionSection = () => {
  const intl = useIntl();
  const {
    locale,
    localeLabEnabled,
    numberStyle,
    setInterfaceLocale,
    setNumberStyle,
    formatAmount,
    formatDate
  } = useInterfaceLocale();
  const message = (id) => intl.formatMessage({ id });

  const previewRows = [
    ['settings.language.preview.amount', <FormattedValue>{formatAmount(1234.56, { currency: 'AED' })}</FormattedValue>],
    ['settings.language.preview.negative', <FormattedValue>{formatAmount(-25, { currency: 'AED' })}</FormattedValue>],
    ['settings.language.preview.date', <FormattedValue>{formatDate('2026-08-31', { timeZone: 'Asia/Dubai' })}</FormattedValue>],
    ['settings.language.preview.invoice', <IdentifierText>INV-2026-001</IdentifierText>],
    ['settings.language.preview.iban', <IdentifierText>AE070331234567890123456</IdentifierText>]
  ];

  return (
    <>
      <Card>
        <Row
          label={message('settings.language.interface.label')}
          desc={message('settings.language.interface.description')}
        >
          <select
            data-interface-locale-selector="true"
            value={locale}
            onChange={(event) => setInterfaceLocale(event.target.value)}
            style={selectStyle}
            aria-label={message('settings.language.interface.label')}
          >
            {PRODUCTION_INTERFACE_LOCALES.map((entry) => (
              <option key={entry.tag} value={entry.tag} lang={entry.tag} dir={entry.direction}>
                {entry.productionLabel}
              </option>
            ))}
            {localeLabEnabled ? (
              <option value="ar-XB" lang="ar-XB" dir="rtl">
                {message('settings.language.interface.pseudo')}
              </option>
            ) : null}
          </select>
        </Row>
        <Row
          label={message('settings.language.numbers.label')}
          desc={message('settings.language.numbers.description')}
        >
          <select
            value={numberStyle}
            onChange={(event) => setNumberStyle(event.target.value)}
            style={selectStyle}
            aria-label={message('settings.language.numbers.label')}
          >
            <option value="locale">{message('settings.language.numbers.locale')}</option>
            <option value="arab">{message('settings.language.numbers.arab')}</option>
            <option value="latn">{message('settings.language.numbers.latn')}</option>
          </select>
        </Row>
      </Card>
      <Card>
        <Row
          label={message('settings.language.preview.title')}
        >
          <span />
        </Row>
        {previewRows.map(([labelId, value]) => (
          <Row key={labelId} label={message(labelId)}>
            <FactValue mono>{value}</FactValue>
          </Row>
        ))}
      </Card>
      <FootNote>{message('settings.language.note')}</FootNote>
    </>
  );
};

// FI-06 (2026-10-15): notification delivery has no preference store and no
// consumer yet, so this section says so instead of offering switches that
// reset on reload. Wire real toggles here only with the store that keeps them.
const NotificationsSection = () => {
  const intl = useIntl();
  return (
    <Card>
      <Row
        label={intl.formatMessage({ id: 'mounted.settings.unavailable' })}
        desc={intl.formatMessage({ id: 'mounted.settings.notifications.unavailable' })}
      >
        <span />
      </Row>
    </Card>
  );
};

const SHORTCUTS = [
  { keys: ['⌘', ','], whatId: 'mounted.settings.shortcuts.open', whereId: 'mounted.settings.shortcuts.anywhere' },
  { keys: ['J', 'K'], whatId: 'mounted.settings.shortcuts.rows', whereId: 'mounted.settings.shortcuts.inbox' },
  { keys: ['↵'], whatId: 'mounted.settings.shortcuts.row', whereId: 'mounted.settings.shortcuts.inbox' },
  { keys: ['ESC'], whatId: 'mounted.settings.shortcuts.close', whereId: 'mounted.settings.shortcuts.anywhere' }
];

const ShortcutsSection = () => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  return (
  <>
    <Card>
      {SHORTCUTS.map((s, i) => (
        <Row key={s.whatId} label={message(s.whatId)} desc={message(s.whereId)}>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            {s.keys.map((k) => <KeyChip key={k}>{k}</KeyChip>)}
          </span>
        </Row>
      ))}
    </Card>
    <FootNote>{message('mounted.settings.shortcuts.drag')}</FootNote>
  </>
  );
};

const FirmSection = ({ firm, clientCount, dataSource }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  return (
  <>
    <Card>
      <Row label={message('mounted.settings.firm.name')}><FactValue><BidiText direction="auto">{firm?.name || '—'}</BidiText></FactValue></Row>
      <Row label={message('mounted.settings.firm.id')}><FactValue mono><IdentifierText>{firm?.id || '—'}</IdentifierText></FactValue></Row>
      <Row label={message('mounted.settings.firm.jurisdiction')}>
        <FactValue>{firm?.jurisdiction ? String(firm.jurisdiction).toUpperCase() : '—'}</FactValue>
      </Row>
      <Row label={message('mounted.settings.firm.currency')}>
        <FactValue>{firm?.default_currency ? String(firm.default_currency).toUpperCase() : '—'}</FactValue>
      </Row>
      <Row label={message('mounted.settings.firm.ventures')}><FactValue>{intl.formatNumber(clientCount)}</FactValue></Row>
      <Row label={message('mounted.settings.firm.data')}>
        <FactValue>{message(dataSource === 'database' ? 'mounted.settings.firm.live' : 'mounted.settings.firm.demo')}</FactValue>
      </Row>
    </Card>
    <FootNote>
      {message('mounted.settings.firm.note')}
    </FootNote>
  </>
  );
};

const AutonomySection = ({ firmAutoSend, onSaveFirmAutoSend }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const [autoSend, setAutoSend] = useState(Boolean(firmAutoSend));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setAutoSend(Boolean(firmAutoSend)); }, [firmAutoSend]);

  const toggle = async (next) => {
    if (!onSaveFirmAutoSend || pending) return;
    setAutoSend(next);
    setPending(true);
    setError('');
    try {
      await onSaveFirmAutoSend(next);
    } catch (err) {
      setAutoSend(!next);
      setError(err?.message || message('mounted.settings.autonomy.error'));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Card>
        <Row
          label={message('mounted.settings.autonomy.autoSend')}
          desc={
            <>
              {message('mounted.settings.autonomy.autoSendDesc')}
              {error && <span style={{ display: 'block', color: D.alert, marginTop: 4 }}><BidiText direction="auto">{error}</BidiText></span>}
            </>
          }
        >
          {onSaveFirmAutoSend ? (
            <Toggle on={autoSend} busy={pending} onChange={toggle} label={message('mounted.settings.autonomy.autoSend')} />
          ) : (
            <span style={{ fontSize: 14, color: D.inkMute }}>{message('mounted.settings.autonomy.liveOnly')}</span>
          )}
        </Row>
      </Card>
      <Card>
        <Row
          label={message('mounted.settings.autonomy.deeper')}
          desc={message('mounted.settings.autonomy.deeperDesc')}
        >
          <span style={{ fontSize: 14, color: D.inkMute, whiteSpace: 'nowrap' }}>{message('mounted.settings.autonomy.receipted')}</span>
        </Row>
      </Card>
    </>
  );
};

const KEY_DESCRIPTIONS = {
  openai: 'mounted.settings.keys.openaiDesc',
  anthropic: 'mounted.settings.keys.anthropicDesc'
};

// BYO keys — REALLY WIRED (the UI-first debt from 2026-08-07, paid). The key
// goes to the OS keychain through the shell's main process and is handed to
// the runtime child as env on the next start; the renderer never holds it
// again after the save call and cannot read it back. Two states this card
// must never fake: a machine with no keychain (Donna refuses to store rather
// than writing a dotfile) and a key shadowed by the launch environment (the
// stored one is doing nothing, and saying so is the whole point).
const ProviderKeysCard = ({ status, onStatus }) => {
  const intl = useIntl();
  const { formatTimestamp } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [drafts, setDrafts] = useState({ openai: '', anthropic: '', typesafe: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  if (!providerKeyStorageSupported()) {
    return (
      <FootNote>
        {message('mounted.settings.keys.unavailable')}
      </FootNote>
    );
  }

  const applyResult = (result) => {
    if (result?.status) onStatus(result.status);
    if (result?.ok) {
      setError('');
      setNote(message(result.restarting ? 'mounted.settings.keys.savedRestart' : 'mounted.settings.keys.saved'));
      setDrafts({ openai: '', anthropic: '', typesafe: '' });
    } else {
      setNote('');
      setError(result?.error || message('mounted.settings.keys.error'));
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      applyResult(await saveProviderKeys(drafts));
    } catch (err) {
      setNote('');
      setError(err?.message || message('mounted.settings.keys.error'));
    } finally {
      setBusy('');
    }
  };

  const remove = async (provider) => {
    setBusy(provider);
    try {
      const result = await clearProviderKey(provider);
      if (result?.status) onStatus(result.status);
      if (result?.ok) {
        setError('');
        setNote(message('mounted.settings.keys.removed'));
      } else {
        setError(result?.error || message('mounted.settings.keys.error'));
      }
    } catch (err) {
      setError(err?.message || message('mounted.settings.keys.error'));
    } finally {
      setBusy('');
    }
  };

  const providers = status?.providers || [];
  const keychainOff = status ? status.available === false : false;
  const hasDraft = Object.values(drafts).some((value) => value.trim());

  return (
    <Card>
      {!status && (
        <div style={{ padding: '16px 0', fontSize: 14, color: D.inkMute }}>{message('mounted.settings.keys.reading')}</div>
      )}
      {providers.map((provider) => (
        <Row key={provider.id} label={message('mounted.settings.keys.label', { provider: provider.label })} desc={KEY_DESCRIPTIONS[provider.id] ? message(KEY_DESCRIPTIONS[provider.id]) : undefined}>
          <div style={{ flex: '0 0 260px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <input
              type="password"
              value={drafts[provider.id]}
              placeholder={provider.saved ? message('mounted.settings.keys.replace') : 'sk-…'}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [provider.id]: e.target.value }))}
              style={{ ...inputStyle, fontFamily: D.mono }}
              aria-label={message('mounted.settings.keys.label', { provider: provider.label })}
              autoComplete="off"
              spellCheck={false}
              disabled={keychainOff}
            />
            {provider.saved && !provider.unreadable && (
              <span style={{ fontFamily: D.mono, fontSize: 11.5, color: D.inkMute }}>
                {provider.preview}
                {provider.savedAt ? <> · {message('mounted.settings.keys.savedAt', { date: formatTimestamp(provider.savedAt, { second: null, timeZoneName: null }) })}</> : ''}
              </span>
            )}
            {provider.unreadable && (
              <span style={{ fontSize: 13, color: D.alert, textAlign: 'end' }}>
                {message('mounted.settings.keys.unreadable')}
              </span>
            )}
            {provider.shadowedByEnv && (
              <span style={{ fontSize: 13, color: D.accentWarmFlat, textAlign: 'end' }}>
                {message('mounted.settings.keys.shadowed', { environment: provider.env })}
              </span>
            )}
            {provider.envSetButEmpty && (
              <span style={{ fontSize: 13, color: D.accentWarmFlat, textAlign: 'end' }}>
                {message('mounted.settings.keys.emptyEnv', { environment: provider.env, saved: provider.saved ? 'yes' : 'no' })}
              </span>
            )}
            {provider.saved && (
              <button
                type="button"
                style={{ ...btnChip, opacity: busy === provider.id ? 0.5 : 1 }}
                disabled={Boolean(busy)}
                onClick={() => remove(provider.id)}
              >
                {message(busy === provider.id ? 'mounted.settings.keys.removing' : 'mounted.settings.keys.remove')}
              </button>
            )}
          </div>
        </Row>
      ))}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0 14px' }}>
        <button
          type="button"
          style={btnPrimary}
          disabled={!hasDraft || keychainOff || Boolean(busy)}
          onClick={save}
        >
          {message(busy === 'save' ? 'mounted.settings.keys.saving' : 'mounted.settings.keys.save')}
        </button>
        {note && !error && <span style={{ fontSize: 14, color: T.ok }}>{note}</span>}
        {error && <span style={{ fontSize: 14, color: D.alert }}>{error}</span>}
      </div>
      <FootNote>
        {keychainOff
          ? status.reason
          : message('mounted.settings.keys.note')}
      </FootNote>
    </Card>
  );
};

// AI runtime — harness + model policy + BYO keys. The doctrine shapes the
// OPTIONS: no policy drops load-bearing calls below the eval bar, and ledger
// commits are never model-routable — those are facts on this screen, not
// knobs. Harness and policy are still local state (their persistence is the
// next wiring slice, and it meets hostRuntimeDefaults.js); the KEYS are real.
// Descent ladder (Q5) — the honest ladder view: which lanes run shadow
// challengers, on which candidate models, and what the receipts say.
// Read-only BY DESIGN (challenger output is evidence, never a control),
// wired to /model-lanes for real — an empty book renders the empty state,
// never sample numbers. Model ids come from the receipts.
const LadderCard = ({ firm }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [policyBusy, setPolicyBusy] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchModelLanes({ firmId: firm?.id, signal: ctrl.signal })
      .then((data) => setReport(data || null))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err?.message || message('mounted.settings.ai.lanesReadError'));
      });
    return () => ctrl.abort();
  }, [firm?.id, reloadTick]);

  // Q6c (the model lab): flip a governed lane's deciding model — WITHIN its
  // qualified set only (the server refuses anything else; the dropdown is a
  // selector inside the feed, never a free picker). '' clears back to the
  // strong default. Every flip is receipted server-side.
  const onPolicyChange = async (laneId, model) => {
    setPolicyBusy(laneId);
    setError('');
    try {
      await setModelLanePolicy({ firmId: firm?.id, lane: laneId, model: model || null });
      setReloadTick((t) => t + 1);
    } catch (err) {
      setError(err?.message || message('mounted.settings.ai.lanesWriteError'));
    } finally {
      setPolicyBusy('');
    }
  };

  if (error) {
    return (
      <Card>
        <Row label={message('mounted.settings.ai.challengers')} desc={message('mounted.settings.ai.challengersShort')}>
          <FactValue>{error}</FactValue>
        </Row>
      </Card>
    );
  }
  if (!report) return null;

  const eligible = (report.lanes || []).filter((lane) => lane.challenger?.eligible);
  const dormant = (report.lanes || []).length - eligible.length;
  return (
    <Card>
      {/* §7 disclosure (bridge register, providers PLURAL, host named per the
          §9.5 data-terms call 2026-08-12): challenger runs send the same case
          text to an ADDITIONAL provider. The provider name here moves in the
          same PR as KNOWN_PROVIDER_HOSTS — copy and registry never drift. */}
      <Row
        label={message('mounted.settings.ai.challengers')}
        desc={message('mounted.settings.ai.challengersLong')}
      >
        <FactValue>{eligible.length ? message('mounted.settings.ai.lanesTesting', { count: eligible.length }) : message('mounted.settings.ai.noLanes')}</FactValue>
      </Row>
      {eligible.map((lane) => {
        const stats = lane.stats || {};
        const runs = stats.runs || 0;
        const matchRate = runs ? Math.round((stats.match / runs) * 100) : null;
        const models = (stats.challenger_models || []).join(', ');
        return (
          <Row
            key={lane.id}
            label={lane.title}
            desc={runs
              ? message('mounted.settings.ai.laneStats', {
                  runs,
                  models: models || 'none',
                  matchRate,
                  divergences: stats.divergence || 0
                })
              : message('mounted.settings.ai.laneEnabled')}
          >
            <FactValue mono>{runs ? message('mounted.settings.ai.match', { percent: matchRate }) : '—'}</FactValue>
          </Row>
        );
      })}
      {/* 2026-11-10 (modelLanes.js SELF_HOSTED_DECISION): one notice per
          active self-hosted seat — an UNQUALIFIED model decides that lane for
          that company. Read-only here: the seat is set and cleared only by
          scripts/seat_local_model.js; the dropdown below stays a selector
          within the qualified set. */}
      {(report.lanes || []).flatMap((lane) => (lane.policies || [])
        .filter((policy) => policy.basis === 'self_hosted_unqualified')
        .map((policy) => (
          <Row
            key={`${lane.id}-${policy.client_id}-unqualified`}
            label={message('mounted.settings.ai.unqualifiedSeat')}
            desc={message('mounted.settings.ai.unqualifiedSeatDesc', {
              model: policy.deciding_model, lane: lane.title, client: policy.client_id,
              date: policy.valid_from ? policy.valid_from.slice(0, 10) : '—'
            })}
          >
            <FactValue mono>{policy.deciding_model}</FactValue>
          </Row>
        )))}
      {(report.lanes || []).filter((lane) => Array.isArray(lane.qualified)).map((lane) => {
        const activePolicy = (lane.policies || []).filter((policy) => policy.basis !== 'self_hosted_unqualified')[0] || null;
        const verdictRows = (lane.comparison?.verdicts_by_model || []);
        const pairs = (lane.comparison?.agreement_pairs || []);
        return (
          <Row
            key={`${lane.id}-policy`}
            label={message('mounted.settings.ai.decidingModel', { lane: lane.title })}
            desc={
              message('mounted.settings.ai.policyFeed')
              + (verdictRows.length
                ? ` · ${message('mounted.settings.ai.verdicts', { details: verdictRows.map((v) => {
                  const mix = Object.entries(v.dispositions).map(([d, n]) => `${d}:${n}`).join(' ');
                  return `${v.model} (${v.total}: ${mix})`;
                }).join(' · ') })}`
                : '')
              + (pairs.length
                ? ` · ${message('mounted.settings.ai.agreement', { details: pairs.map((p) => {
                  const compared = p.match + p.divergence + p.parse_failure;
                  const pct = compared ? Math.round((p.match / compared) * 100) : null;
                  return message('mounted.settings.ai.pair', {
                    deciding: p.deciding_model || '?', challenger: p.challenger_model || '?',
                    percent: pct == null ? '—' : `${pct}%`, runs: p.runs
                  });
                }).join(' · ') })}`
                : '')
            }
          >
            <select
              value={activePolicy?.deciding_model || ''}
              onChange={(e) => onPolicyChange(lane.id, e.target.value)}
              disabled={policyBusy === lane.id}
              style={selectStyle}
              aria-label={message('mounted.settings.ai.decidingAria', { lane: lane.title })}
            >
              <option value="">{message('mounted.settings.ai.defaultStrong')}</option>
              {lane.qualified.map((model) => (
                <option key={model} value={model}>
                  {model}{activePolicy?.deciding_model === model && activePolicy?.basis === 'experiment' ? ` — ${message('mounted.settings.ai.experiment')}` : ''}
                </option>
              ))}
            </select>
          </Row>
        );
      })}
      <Row
        label={message('mounted.settings.ai.dormant')}
        desc={message('mounted.settings.ai.dormantDesc')}
      >
        <FactValue>{message('mounted.settings.ai.laneCount', { count: dormant })}</FactValue>
      </Row>
    </Card>
  );
};

const AiSection = ({ firm }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const [harness, setHarness] = useState('managed');
  const [keyStatus, setKeyStatus] = useState(null);
  // Own keys exist only where the desktop keychain bridge does; in the web
  // session the choice had no consumer, so it renders as the fact it is.
  const keysSupported = providerKeyStorageSupported();

  // A machine with keys already stored IS on its own keys — open the screen
  // on the truth rather than on the default.
  useEffect(() => {
    let live = true;
    fetchProviderKeyStatus()
      .then((status) => {
        if (!live || !status) return;
        setKeyStatus(status);
        if (status.providers?.some((provider) => provider.saved)) setHarness('byo');
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <>
      <Card>
        <Row
          label={message('mounted.settings.ai.harness')}
          desc={message('mounted.settings.ai.harnessLong')}
        >
          {keysSupported ? (
            <select
              value={harness}
              onChange={(e) => setHarness(e.target.value)}
              style={selectStyle}
              aria-label={message('mounted.settings.ai.harness')}
            >
              <option value="managed">{message('mounted.settings.ai.managed')}</option>
              <option value="byo">{message('mounted.settings.ai.ownKeys')}</option>
            </select>
          ) : (
            <FactValue>{message('mounted.settings.ai.managed')}</FactValue>
          )}
        </Row>
      </Card>
      {harness === 'byo' && <ProviderKeysCard status={keyStatus} onStatus={setKeyStatus} />}
      <LadderCard firm={firm} />
      <RuntimeRepairsCard firm={firm} />
      <Card>
        <Row
          label={message('mounted.settings.ai.receipts')}
          desc={message('mounted.settings.ai.receiptsDesc')}
        >
          <FactValue>{message('mounted.settings.ai.everyVerdict')}</FactValue>
        </Row>
        <Row
          label={message('mounted.settings.ai.ledger')}
          desc={message('mounted.settings.ai.ledgerDesc')}
        >
          <FactValue>{message('mounted.settings.ai.neverModel')}</FactValue>
        </Row>
      </Card>
    </>
  );
};

// Billing (FI-06, 2026-10-15): checkout, entitlement and usage metering are
// not wired, so nothing here may look purchasable or metered. The section
// says so plainly; it grows real rows only with the billing build behind them.
const BillingSection = () => {
  const intl = useIntl();
  return (
    <Card>
      <Row
        label={intl.formatMessage({ id: 'mounted.settings.unavailable' })}
        desc={intl.formatMessage({ id: 'mounted.settings.billing.unavailable' })}
      >
        <span />
      </Row>
    </Card>
  );
};

// Memory — Donna's learned facts, live from firm_facts: what she knows,
// where she learned it, and the recorded "no" (dismiss) when she's wrong.
// The correction loop made visible.
const MemorySection = ({ firm }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [facts, setFacts] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    fetchFirmFacts({ firmId: firm?.id, signal: ctrl.signal })
      .then((data) => setFacts(Array.isArray(data?.facts) ? data.facts : []))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err?.message || message('mounted.settings.memory.readError'));
        setFacts([]);
      });
    return () => ctrl.abort();
  }, [firm?.id]);

  const dismiss = async (factId) => {
    setBusyId(factId);
    setError('');
    try {
      await dismissFirmFact({ factId, firmId: firm?.id });
      setFacts((prev) => (prev || []).map((f) => (f.id === factId ? { ...f, status: 'dismissed' } : f)));
    } catch (err) {
      setError(err?.message || message('mounted.settings.memory.dismissError'));
    } finally {
      setBusyId('');
    }
  };

  const active = (facts || []).filter((f) => f.status === 'active');
  const dismissed = (facts || []).filter((f) => f.status === 'dismissed');
  const factMeta = (fact) => [
    fact.scope,
    fact.confidence != null ? message('mounted.settings.memory.confidence', { percent: Math.round(Number(fact.confidence) * 100) }) : null,
    fact.model || null
  ].filter(Boolean).join(' · ');

  return (
    <>
      <Card>
        {facts === null && (
          <div style={{ padding: '16px 0', fontSize: 14, color: D.inkMute }}>{message('mounted.settings.memory.reading')}</div>
        )}
        {facts !== null && active.length === 0 && (
          <div style={{ padding: '16px 0', fontSize: 14, color: D.inkMute }}>
            {message('mounted.settings.memory.emptyDesc')}
          </div>
        )}
        {active.map((fact) => (
          <Row key={fact.id} label={fact.subject || fact.scope || message('mounted.settings.memory.learnedFact')} desc={
            <>
              {fact.fact}
              {factMeta(fact) && (
                <span style={{ display: 'block', fontFamily: D.mono, fontSize: 11.5, color: D.inkMute, marginTop: 4 }}>
                  {factMeta(fact)}
                </span>
              )}
            </>
          }>
            <button
              type="button"
              style={{ ...btnChip, opacity: busyId === fact.id ? 0.5 : 1 }}
              disabled={Boolean(busyId)}
              onClick={() => dismiss(fact.id)}
            >
              {message(busyId === fact.id ? 'mounted.settings.memory.dismissing' : 'mounted.settings.memory.dismiss')}
            </button>
          </Row>
        ))}
      </Card>
      {dismissed.length > 0 && (
        <Card>
          {dismissed.map((fact) => (
            <Row key={fact.id} label={fact.subject || fact.scope || message('mounted.settings.memory.dismissedFact')} desc={fact.fact}>
              <span style={{ fontFamily: D.mono, fontSize: 11, color: D.inkMute, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {message('mounted.settings.memory.dismiss')}
              </span>
            </Row>
          ))}
        </Card>
      )}
      {error && <FootNote><span style={{ color: D.alert }}>{error}</span></FootNote>}
      <FootNote>
        {message('mounted.settings.memory.footer')}
      </FootNote>
    </>
  );
};

// Backups — REALLY WIRED (the second piece of UI-first debt paid; the BYO
// keys were the first). The card renders the packages actually on disk and
// the cron actually configured; "Back up now" runs the same create → verify
// → rotate machinery as the nightly job, so a manual backup and a scheduled
// one are the same artifact. The previous card's hardcoded "Last backup:
// Today 03:00" was a fake fact on a data-safety surface — the one kind of
// fake the UI-first amendment itself forbids. The fake toggle + cadence
// selects went with it: a switch that pretends to disarm a cron that runs
// regardless is the same lie as a switch that pretends to arm one.
const BackupsCard = ({ firm }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const [state, setState] = useState(null); // { enabled, backups, cron }
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [ranOk, setRanOk] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDesktopBackups({ firmId: firm?.id, signal: ctrl.signal })
      .then((data) => setState(data || { enabled: false, backups: [] }))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err?.message || message('mounted.settings.backup.readError'));
        setState({ enabled: false, backups: [] });
      });
    return () => ctrl.abort();
  }, [firm?.id]);

  const runNow = async () => {
    setRunning(true);
    setError('');
    setRanOk(false);
    try {
      const result = await runDesktopBackup({ firmId: firm?.id });
      setState(result);
      setRanOk(Boolean(result?.created?.verified));
    } catch (err) {
      setError(err?.message || message('mounted.settings.backup.error'));
    } finally {
      setRunning(false);
    }
  };

  if (state && !state.enabled) {
    return (
      <FootNote>
        {message('mounted.settings.backup.desktopOnly')}
      </FootNote>
    );
  }

  const last = describeLastBackup(state?.backups);
  const kept = (state?.backups || []).filter((entry) => entry.manifest_ok).length;

  return (
    <Card>
      <Row
        label={message('mounted.settings.backup.automatic')}
        desc={message('mounted.settings.backup.desc')}
      >
        <FactValue mono>{state ? (humanizeBackupCron(state.cron) || '…') : '…'}</FactValue>
      </Row>
      <Row
        label={message('mounted.settings.backup.last')}
        desc={last.ok && last.detail ? last.detail : message('mounted.settings.backup.lastDesc')}
      >
        <FactValue mono>{state === null ? '…' : last.label}</FactValue>
      </Row>
      {state !== null && (
        <Row label={message('mounted.settings.backup.kept')}>
          <FactValue mono>{String(kept)}</FactValue>
        </Row>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0 14px' }}>
        <button type="button" style={btnPrimary} disabled={running || state === null} onClick={runNow}>
          {message(running ? 'mounted.settings.backup.running' : 'mounted.settings.backup.now')}
        </button>
        {ranOk && !error && (
          <span style={{ fontSize: 14, color: T.ok }}>{message('mounted.settings.backup.success')}</span>
        )}
        {error && <span style={{ fontSize: 14, color: D.alert }}>{error}</span>}
      </div>
    </Card>
  );
};

// AI chat access — the MCP per-entity consent screen (REALLY WIRED; it
// replaces scripts/enable_mcp_entity_expose.js as the consent path —
// design-donna-mcp-surface.md §8 item 1; generalized from "Claude access"
// in the hosted chat surface's slice 4, design-donna-chatgpt-app-build-
// brief.md §4.4). ONE consent per venture covers every chat surface
// (MCP_SURFACES, listed from the server: the Claude Desktop extension, the
// ChatGPT app, the Claude connector) — the flag stays MCP_ENTITY_EXPOSE, a
// client-specific canary row, off by default. Every toggle is a data-routing
// decision: what a connected chat app reads reaches whichever chat provider
// the owner connected (the 2026-08-11 copy register: say that plainly; no
// custody slogans here). The write is the audited config-plane writer —
// client-specific row, canary to expose / off to revoke — and the row
// renders back from persisted state, never optimistically. The kill switch
// (CLIENT_CONFIG_FORCE_DISABLE) is rendered honestly: consent stays
// recorded, exposure reads dead.
const AiChatAccessSection = ({ firm }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [state, setState] = useState(null); // { force_disabled, entities, surfaces }
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    const ctrl = new AbortController();
    fetchMcpExposure({ firmId: firm?.id, signal: ctrl.signal })
      .then((data) => setState({
        force_disabled: Boolean(data?.force_disabled),
        entities: Array.isArray(data?.entities) ? data.entities : [],
        // The surfaces this ONE consent covers, as the server lists them
        // (MCP_SURFACES labels) — never a client-side copy of the list.
        surfaces: Array.isArray(data?.surfaces) ? data.surfaces : []
      }))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err?.message || message('mounted.settings.claude.readError'));
        setState({ force_disabled: false, entities: [], surfaces: [] });
      });
    return () => ctrl.abort();
  }, [firm?.id]);

  const toggle = async (entity, next) => {
    setBusyId(entity.id);
    setError('');
    try {
      const result = await setMcpEntityExposure({ firmId: firm?.id, clientId: entity.id, expose: next });
      setState((prev) => ({
        ...prev,
        entities: (prev?.entities || []).map((e) => (
          e.id === entity.id ? { ...e, stage: result.stage, exposed: Boolean(result.exposed) } : e
        ))
      }));
    } catch (err) {
      setError(err?.message || message('mounted.settings.claude.changeError'));
    } finally {
      setBusyId('');
    }
  };

  const entityDesc = (entity) => {
    if (entity.exposed) return message('mounted.settings.claude.visible');
    if (entity.stage === 'canary' && state?.force_disabled) {
      return message('mounted.settings.claude.forceEntity');
    }
    if (entity.stage === null) return message('mounted.settings.claude.neverExposed');
    return message('mounted.settings.claude.notVisible');
  };

  const surfaceLabels = (state?.surfaces || []).map((s) => s.label).filter(Boolean);
  const surfacesText = surfaceLabels.length
    ? surfaceLabels.join(', ')
    : 'the chat apps you connect';

  return (
    <>
      <Card>
        <Row
          label={message('mounted.settings.claude.what')}
          desc={message('mounted.settings.claude.whatDesc', { surfaces: surfacesText })}
        >
          <span style={{ fontSize: 14, color: D.inkMute, whiteSpace: 'nowrap' }}>{message('mounted.settings.claude.readOnly')}</span>
        </Row>
        <Row
          label={message('mounted.settings.claude.where')}
          desc={message('mounted.settings.claude.whereDesc')}
        >
          <span style={{ fontSize: 14, color: D.inkMute, whiteSpace: 'nowrap' }}>{message('mounted.settings.claude.perVenture')}</span>
        </Row>
      </Card>
      {state?.force_disabled && (
        <Card>
          <Row
            label={message('mounted.settings.claude.forceTitle')}
            desc={message('mounted.settings.claude.forceDesc')}
          >
            <span style={{ fontSize: 14, color: D.alert, whiteSpace: 'nowrap' }}>{message('mounted.settings.claude.killSwitch')}</span>
          </Row>
        </Card>
      )}
      <Card>
        {state === null && (
          <div style={{ padding: '16px 0', fontSize: 14, color: D.inkMute }}>{message('mounted.settings.claude.reading')}</div>
        )}
        {state !== null && state.entities.length === 0 && (
          <div style={{ padding: '16px 0', fontSize: 14, color: D.inkMute }}>
            {message('mounted.settings.claude.noVentures')}
          </div>
        )}
        {(state?.entities || []).map((entity) => (
          <Row key={entity.id} label={entity.name} desc={entityDesc(entity)}>
            <Toggle
              on={entity.exposed}
              busy={busyId === entity.id}
              disabled={Boolean(state?.force_disabled) || (Boolean(busyId) && busyId !== entity.id)}
              onChange={(next) => toggle(entity, next)}
              label={message('mounted.settings.claude.expose', { venture: entity.name })}
            />
          </Row>
        ))}
      </Card>
      {error && <FootNote><span style={{ color: D.alert }}>{error}</span></FootNote>}
      <FootNote>
        {message('mounted.settings.claude.footer')}
      </FootNote>
    </>
  );
};

const DataSection = ({
  firm,
  clients,
  selectedClientId,
  dataSource,
  health,
  healthState,
  accountingImportRequest,
  onAccountingImportRequestConsumed
}) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  const [exportScope, setExportScope] = useState('all');
  const [exportState, setExportState] = useState('idle');
  const runExport = () => {
    setExportState('preparing');
    window.setTimeout(() => setExportState('ready'), 1400);
  };
  return (
    <>
      <Card>
        <Row label={message('mounted.settings.data.source')}>
          <FactValue>{message(dataSource === 'database' ? 'mounted.settings.data.live' : 'mounted.settings.data.demo')}</FactValue>
        </Row>
        <Row label={message('mounted.settings.data.localDatabase')} desc={message('mounted.settings.data.localDatabaseDesc')}>
          <FactValue>
            {healthState === 'loading' ? '…'
              : healthState === 'error' ? message('mounted.settings.data.unreachable')
              : health?.database_configured ? message('mounted.settings.data.connected') : message('mounted.settings.data.notConfigured')}
          </FactValue>
        </Row>
        <Row
          label={message('mounted.settings.data.location')}
          desc={isDesktopShell()
            ? message('mounted.settings.data.machineDesc')
            : message('mounted.settings.data.workspaceDesc')}
        >
          <FactValue>{message(isDesktopShell() ? 'mounted.settings.data.machine' : 'mounted.settings.data.workspace')}</FactValue>
        </Row>
      </Card>
      <FinnishPilotSetupCard firm={firm} clients={clients} dataSource={dataSource} />
      {dataSource === 'database' && firm?.id && selectedClientId && <PhysicalReconciliationPanel key={`${firm.id}-${selectedClientId}`} firmId={firm.id} clientId={selectedClientId} />}
      <AccountingImportCard
        firm={firm}
        clients={clients}
        initialClientId={selectedClientId}
        dataSource={dataSource}
        accountingImportRequest={accountingImportRequest}
        onAccountingImportRequestConsumed={onAccountingImportRequestConsumed}
      />
      <Card>
        <Row
          label={message('mounted.settings.data.export')}
          desc={message('mounted.settings.data.exportDesc')}
        >
          <select
            value={exportScope}
            onChange={(e) => setExportScope(e.target.value)}
            style={selectStyle}
            aria-label={message('mounted.settings.data.exportScope')}
          >
            <option value="all">{message('mounted.settings.data.allVentures')}</option>
            <option value="selected">{message('mounted.settings.data.selectedVenture')}</option>
          </select>
        </Row>
        <Row label={message('mounted.settings.data.format')}>
          <FactValue>{message('mounted.settings.data.formatValue')}</FactValue>
        </Row>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0 14px' }}>
          <button
            type="button"
            style={btnPrimary}
            disabled={exportState === 'preparing'}
            onClick={runExport}
          >
            {message(exportState === 'preparing' ? 'mounted.settings.data.preparing' : 'mounted.settings.data.exportAction')}
          </button>
          {exportState === 'ready' && (
            <button type="button" style={btnChip}>{message('mounted.settings.data.download')}</button>
          )}
        </div>
      </Card>
      <BackupsCard firm={firm} />
    </>
  );
};

const AboutSection = ({ health, healthState, onFeedback }) => {
  const intl = useIntl();
  const message = (id) => intl.formatMessage({ id });
  return <>
    <Card>
      <Row label={message('mounted.settings.about.build')}>
        <FactValue mono>
          {healthState === 'loading' ? '…' : (health?.commit_sha || message('mounted.settings.about.localBuild'))}
        </FactValue>
      </Row>
      <Row label={message('mounted.settings.about.environment')}>
        <FactValue>{health?.vercel_env || message(isDesktopShell() ? 'mounted.settings.about.appliance' : 'mounted.settings.about.local')}</FactValue>
      </Row>
      <Row label={message('mounted.settings.about.shell')}>
        <FactValue>{message(isDesktopShell() ? 'mounted.settings.about.desktop' : 'mounted.settings.about.web')}</FactValue>
      </Row>
      <Row label={message('mounted.settings.about.bundle')} desc={message('mounted.settings.about.bundleDesc')}>
        <FactValue mono>{UI_BUILD}</FactValue>
      </Row>
      <Row
        label={message('mounted.settings.about.commit')}
        desc={message('mounted.settings.about.commitDesc')}
      >
        <FactValue mono>{UI_SOURCE}</FactValue>
      </Row>
    </Card>
    {onFeedback && (
      <div style={{ marginTop: 18, marginBottom: 4 }}>
        <button type="button" style={btnChip} onClick={onFeedback}>
          {message('mounted.settings.about.feedback')}
        </button>
      </div>
    )}
    <FootNote>
      <KeyChip>⌘</KeyChip> <KeyChip>,</KeyChip> {message('mounted.settings.about.shortcut')}
    </FootNote>
  </>;
};

// ── Panel ───────────────────────────────────────────────────────────────────

const SettingsPanel = ({
  section = 'profile',
  firm = null,
  clients = [],
  selectedClientId = '',
  clientCount = 0,
  dataSource = null,
  firmAutoSend = null,
  onSaveFirmAutoSend = null,
  authEmail = '',
  onFeedback = null,
  accountingImportRequest = null,
  onAccountingImportRequestConsumed = null
}) => {
  const intl = useIntl();
  // One health read per Settings visit — About and Data both render it.
  const [health, setHealth] = useState(null);
  const [healthState, setHealthState] = useState('loading');
  useEffect(() => {
    const ctrl = new AbortController();
    fetchFirmHealth({ signal: ctrl.signal })
      .then((data) => { setHealth(data); setHealthState('ok'); })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setHealthState('error');
      });
    return () => ctrl.abort();
  }, []);

  const [titleId, subtitleId] = section === 'language'
    ? [
        'settings.language.title',
        'settings.language.subtitle'
      ]
    : SECTION_TITLES[section] || SECTION_TITLES.profile;

  return (
    <section
      className="settings-panel"
      aria-label={intl.formatMessage({ id: 'mounted.settings.aria' })}
      style={{
        maxWidth: 1020,
        // Settings is chrome: the platform face, not the content voice
        // (see D.ui in design-tokens.js). At SF Pro the 600 labels read
        // crisp like the Buzz reference, not fat like DM Sans 600 did.
        fontFamily: D.ui,
        color: D.ink,
        padding: '34px 40px 80px',
        lineHeight: 1.5
      }}
    >
      <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.015em', margin: '0 0 5px' }}>{intl.formatMessage({ id: titleId })}</h2>
      <p style={{ fontSize: 15.5, color: D.inkSoft, margin: '0 0 26px' }}>{intl.formatMessage({ id: subtitleId })}</p>

      {section === 'profile' && <ProfileSection authEmail={authEmail} />}
      {section === 'language' && <LanguageRegionSection />}
      {section === 'notifications' && <NotificationsSection />}
      {section === 'shortcuts' && <ShortcutsSection />}
      {section === 'firm' && <FirmSection firm={firm} clientCount={clientCount} dataSource={dataSource} />}
      {section === 'autonomy' && (
        <AutonomySection firmAutoSend={firmAutoSend} onSaveFirmAutoSend={onSaveFirmAutoSend} />
      )}
      {section === 'claude' && <AiChatAccessSection firm={firm} />}
      {section === 'memory' && <MemorySection firm={firm} />}
      {section === 'billing' && <BillingSection />}
      {section === 'ai' && <AiSection firm={firm} />}
      {section === 'data' && (
        <DataSection
          firm={firm}
          clients={clients}
          selectedClientId={selectedClientId}
          dataSource={dataSource}
          health={health}
          healthState={healthState}
          accountingImportRequest={accountingImportRequest}
          onAccountingImportRequestConsumed={onAccountingImportRequestConsumed}
        />
      )}
      {section === 'about' && <AboutSection health={health} healthState={healthState} onFeedback={onFeedback} />}
    </section>
  );
};

export default SettingsPanel;
