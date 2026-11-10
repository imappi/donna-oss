import FinnishCompanyDetails from './FinnishCompanyDetails.jsx';
import ClientOwnerAccessCard from './ClientOwnerAccessCard.jsx';
import ReconciliationAuthorityGrants from './ReconciliationAuthorityGrants.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readAccountingProfile } from '../lib/accountingProfile.js';
import { useIntl } from 'react-intl';
import DonnaFinancialsPanel from './financials/donna-financials-panel.jsx';
import { T, D } from './shared/design-tokens.js';
import { updateFirmClientProfile, connectXero, disconnectAccounting, syncXeroReferenceData, syncProcountorReferenceData, mirrorLedgerToAccounting, connectProcountorWithApiKey } from '../lib/firmApi.js';
import { createCoalescedAutosave } from '../lib/autosave.js';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { BidiText, FormattedValue, IdentifierText } from '../i18n/BidiText.jsx';
import { PORTAL_LEGAL_FORM_MESSAGE_IDS } from '../i18n/catalogs/remainingSurfaces.en.js';
import {
  SERVICES,
  SERVICE_IDS,
  readServicesEngaged,
  readJurisdiction,
  readEntityType,
  readJurisdictionDetected,
  readJurisdictionDetectedConfidence,
  readLatestJurisdictionSignal,
  JURISDICTIONS,
  ENTITY_TYPES_BY_JURISDICTION,
  entityTypeLabel,
  entityNumberLabel,
  shouldRenderComplianceCard,
  ACCOUNTING_SYSTEMS,
  readAccountingSystem,
  readAccountingSystemConnection,
  readJurisdictionConfirmation,
  readAccountingSystemProvenance,
  readServicesEngagedProvenance
} from '../lib/clientAxes.js';

// Server-stamped provenance (jurisdiction_confirmed_*, accounting_system_set_*)
// renders as a single small mono-caps line. ISO date → YYYY-MM-DD slice
// (matches the connection.last_synced_at pattern; locale-independent and
// good enough for an audit-style line). Returns null when both fields are
// nullish so the caller can render nothing.
const formatProvenanceLine = (provenance, { message, formatDate, verbId }) => {
  if (!provenance) return null;
  const { by, at } = provenance;
  if (!by && !at) return null;
  const date = at
    ? formatDate(String(at).slice(0, 10), { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  const verb = message(verbId);
  if (by && date) return message('mounted.workspace.provenance.byDate', { verb, actor: by, date });
  if (by) return message('mounted.workspace.provenance.by', { verb, actor: by });
  if (date) return message('mounted.workspace.provenance.onDate', { verb, date });
  return null;
};

const JURISDICTION_MESSAGE_IDS = Object.freeze({
  sg: 'mounted.workspace.jurisdiction.sg',
  us: 'mounted.workspace.jurisdiction.us',
  gb: 'mounted.workspace.jurisdiction.gb',
  hk: 'mounted.workspace.jurisdiction.hk',
  au: 'mounted.workspace.jurisdiction.au',
  nz: 'mounted.workspace.jurisdiction.nz',
  my: 'mounted.workspace.jurisdiction.my',
  ca: 'mounted.workspace.jurisdiction.ca',
  fi: 'mounted.workspace.jurisdiction.fi',
  ae: 'mounted.workspace.jurisdiction.ae'
});

const ENTITY_NUMBER_MESSAGE_IDS = Object.freeze({
  UEN: 'mounted.workspace.entityNumber.uen',
  EIN: 'mounted.workspace.entityNumber.ein',
  'Tax ID': 'mounted.workspace.entityNumber.taxId',
  CRN: 'mounted.workspace.entityNumber.crn',
  UTR: 'mounted.workspace.entityNumber.utr',
  BRN: 'mounted.workspace.entityNumber.brn',
  ABN: 'mounted.workspace.entityNumber.abn',
  NZBN: 'mounted.workspace.entityNumber.nzbn',
  NEQ: 'mounted.workspace.entityNumber.neq',
  'Business ID': 'mounted.workspace.entityNumber.businessId',
  TRN: 'mounted.workspace.entityNumber.trn',
  'Entity number': 'mounted.workspace.entityNumber.generic'
});

const REGISTRY_SOURCE_MESSAGE_IDS = Object.freeze({
  sg: 'mounted.workspace.registrySource.sg',
  us: 'mounted.workspace.registrySource.us',
  gb: 'mounted.workspace.registrySource.gb',
  hk: 'mounted.workspace.registrySource.hk',
  au: 'mounted.workspace.registrySource.au',
  nz: 'mounted.workspace.registrySource.nz',
  my: 'mounted.workspace.registrySource.my',
  ca: 'mounted.workspace.registrySource.ca',
  fi: 'mounted.workspace.registrySource.fi',
  ae: 'mounted.workspace.registrySource.ae'
});

const PROVENANCE_STYLE = {
  fontFamily: T.mono,
  fontSize: 10.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: T.mutedSoft
};

// ── Status mapping ────────────────────────────────────────────────────────────

const STATUS_BADGE = {
  complete: { bg: T.okSoft, fg: T.ok, labelId: 'mounted.workspace.complete' },
  review: { bg: T.amberSoft, fg: T.amber, labelId: 'mounted.workspace.review' },
  blocked: { bg: T.alertSoft, fg: T.alert, labelId: 'mounted.workspace.blocked' },
  pending: { bg: 'rgba(46,42,34,0.05)', fg: T.muted, labelId: 'mounted.workspace.missing' },
  missing: { bg: 'rgba(46,42,34,0.05)', fg: T.muted, labelId: 'mounted.workspace.missing' }
};

const STATUS_RANK = { blocked: 3, review: 2, pending: 1, complete: 0 };

const countStatuses = (items = []) =>
  items.reduce(
    (counts, item) => {
      counts.total += 1;
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    },
    { total: 0, complete: 0, pending: 0, review: 0, blocked: 0 }
  );

// ── Reusable bits ─────────────────────────────────────────────────────────────

const SectionLabel = ({ children, count }) => (
  <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
    {children}
    {count != null && <span style={{ marginInlineStart: 6 }}>· {count}</span>}
  </div>
);

const Card = ({ label, title, sub, accent, children }) => (
  <section
    style={{
      background: T.card,
      border: `1px solid ${T.rule}`,
      borderRadius: 14,
      padding: 22,
      borderInlineStart: accent ? `3px solid ${accent}` : `1px solid ${T.rule}`
    }}
  >
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6, gap: 12 }}>
      <div>
        <SectionLabel>{label}</SectionLabel>
        <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2, color: T.ink }}>{title}</div>
      </div>
      {sub && <div style={{ fontSize: 11.5, color: T.mutedSoft, fontFamily: T.mono }}>{sub}</div>}
    </div>
    {children}
  </section>
);

const Field = ({ label, value, sub, missing }) => (
  <div
    style={{
      paddingTop: 12,
      paddingBottom: 12,
      borderBottom: `1px solid ${T.ruleMicro}`,
      display: 'grid',
      gridTemplateColumns: '180px 1fr',
      gap: 16,
      alignItems: 'baseline'
    }}
  >
    <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>
      <BidiText direction="auto">{label}</BidiText>
    </div>
    <div>
      <div style={{ fontSize: 13.5, color: missing ? T.alert : T.ink, fontStyle: missing ? 'italic' : 'normal' }}>
        <BidiText direction="auto">{value}</BidiText>
      </div>
      {sub && <div style={{ fontSize: 11.5, color: T.mutedSoft, marginTop: 2 }}><BidiText direction="auto">{sub}</BidiText></div>}
    </div>
  </div>
);

const StatusBadge = ({ kind }) => {
  const intl = useIntl();
  const s = STATUS_BADGE[kind] || STATUS_BADGE.pending;
  return (
    <span
      style={{
        fontFamily: T.mono,
        fontSize: 11,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '3px 9px',
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        fontWeight: 500
      }}
    >
      {intl.formatMessage({ id: s.labelId })}
    </span>
  );
};

// ── Profile tab ───────────────────────────────────────────────────────────────

const FILING_KEYS = /(agm|annual return|fye|financial year)/i;

const splitProfileFacts = (facts = []) => {
  const filing = [];
  const summary = [];
  const capital = [];
  facts.forEach((fact) => {
    const label = fact.label || '';
    if (FILING_KEYS.test(label)) filing.push(fact);
    else if (/share capital|paid[- ]up|issued/i.test(label)) capital.push(fact);
    else summary.push(fact);
  });
  return { summary, filing, capital };
};

// Operator card on the Profile tab — nine checkboxes that write through
// to clients.profile.services_engaged. The dossier portal reads the same
// field via readPortalTileFilter (in src/lib/clientAxes.js) and renders
// only the tiles whose service is engaged, so unticking Payroll here
// makes the Payroll tile vanish from /client/<id>. Autosave on every
// toggle, mirrors the dismissedTiles optimistic-with-revert pattern in
// donna-client-portal.
//
// Empty / unset services_engaged is a backward-compat shim that renders
// all tiles in the portal — Phase 1.5 will flip new clients to require
// explicit configuration. See
// docs/jurisdiction-services-accounting-plan.md.
const ServicesEngagedCard = ({ clientId, profile, onDatabaseSnapshot }) => {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id) => intl.formatMessage({ id });
  const provenance = readServicesEngagedProvenance(profile);
  const persistedKey = useMemo(() => {
    const list = readServicesEngaged(profile);
    if (!list) return '*';
    const arr = list.map(String);
    arr.sort();
    return arr.join(',');
  }, [profile]);

  // Phase 1.5 — an explicit empty services_engaged ([]) is a real,
  // distinct state ("scoped to nothing yet"), not the same as the key
  // being absent. Empty array → nothing ticked + a warning; absent key
  // (legacy) → all ticked (the backward-compat shim).
  const computeInitial = () => {
    const list = readServicesEngaged(profile);
    if (Array.isArray(list)) return new Set(list.map(String));
    return new Set(SERVICE_IDS);
  };

  const [selected, setSelected] = useState(computeInitial);
  // 'idle' before any write, 'saving' while a POST is in-flight, 'ok'
  // after a successful write, 'error' when the last write failed (we
  // also revert the optimistic state in that branch).
  const [status, setStatus] = useState('idle');

  // Latest values for the autosave's async completions — the writer is
  // created once and outlives renders.
  const selectedRef = useRef(selected);
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;
  const snapshotCbRef = useRef(onDatabaseSnapshot);
  snapshotCbRef.current = onDatabaseSnapshot;
  const revertRef = useRef(computeInitial);
  revertRef.current = computeInitial;

  // Serialized + coalescing writer (src/lib/autosave.js). Three quick
  // ticks used to fire three CONCURRENT full-array PATCHes — last
  // commit won with whatever array it carried, and each snapshot echo
  // reset the optimistic boxes mid-flight (ticks 2 and 3 visibly
  // unticked themselves). Now at most one write is in flight, a
  // follow-up carries the latest full set, and only the FINAL
  // snapshot is applied.
  const autosaveRef = useRef(null);
  if (!autosaveRef.current) {
    autosaveRef.current = createCoalescedAutosave({
      write: (services) =>
        updateFirmClientProfile({
          clientId: clientIdRef.current,
          profilePatch: { services_engaged: services }
        }),
      onSuccess: (snapshot) => {
        setStatus('ok');
        if (snapshot?.source === 'database' && typeof snapshotCbRef.current === 'function') {
          snapshotCbRef.current(snapshot);
        }
      },
      onError: (error) => {
        console.error('Failed to persist services_engaged', error);
        // Revert to the last persisted truth — multiple coalesced
        // toggles may ride the failed write, so the pre-click set of
        // any single toggle is not a safe restore point.
        const reverted = revertRef.current();
        selectedRef.current = reverted;
        setSelected(reverted);
        setStatus('error');
      }
    });
  }

  useEffect(() => {
    // While a write is in flight or queued, the local set is NEWER
    // than any snapshot echo — re-syncing here is exactly what
    // unticked boxes 2 and 3 while box 1's response landed.
    if (autosaveRef.current?.isBusy()) return;
    const init = computeInitial();
    selectedRef.current = init;
    setSelected(init);
    setStatus('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedKey, clientId]);

  const toggle = (id) => {
    if (!clientId) return;
    const next = new Set(selectedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedRef.current = next;
    setSelected(next);
    setStatus('saving');
    autosaveRef.current.push(SERVICE_IDS.filter((sid) => next.has(sid)));
  };

  const statusCopy =
    status === 'saving' ? message('mounted.workspace.autosaveSaving')
    : status === 'error' ? message('mounted.workspace.autosaveError')
    : status === 'ok' ? message('mounted.workspace.autosaveOk')
    : message('mounted.workspace.autosaved');
  const statusColor = status === 'error' ? T.alert : T.mutedSoft;

  const noneSelected = selected.size === 0;

  return (
    <Card label={message('mounted.workspace.services')} title={message('mounted.workspace.servicesTitle')}>
      <p style={{ margin: '4px 0 14px', fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
        {message('mounted.workspace.servicesDesc')}
      </p>
      {noneSelected && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            padding: '8px 12px',
            marginBottom: 12,
            borderRadius: 8,
            border: `1px dashed ${T.amber}`,
            background: T.amberSoft
          }}
        >
          <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.amber, flex: '0 0 auto' }}>
            ⚠ {message('mounted.workspace.notScoped')}
          </span>
          <span style={{ fontSize: 12.5, color: T.inkSoft, lineHeight: 1.45 }}>
            {message('mounted.workspace.notScopedDesc')}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {SERVICES.map((service, i) => {
          const checked = selected.has(service.id);
          const interactive = Boolean(clientId);
          return (
            <label
              key={service.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '11px 2px',
                borderTop: i === 0 ? 'none' : `1px solid ${T.ruleMicro}`,
                fontSize: 13.5,
                color: T.ink,
                cursor: interactive ? 'pointer' : 'not-allowed'
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(service.id)}
                disabled={!interactive}
                style={{
                  width: 16,
                  height: 16,
                  marginTop: 2,
                  accentColor: T.ok,
                  cursor: interactive ? 'pointer' : 'not-allowed',
                  flex: '0 0 auto'
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div>{message(service.labelId)}</div>
                <div style={{ fontSize: 11.5, color: T.mutedSoft, marginTop: 2 }}>
                  {message(service.descriptionId)}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      {(() => {
        const line = formatProvenanceLine(provenance, {
          message,
          formatDate,
          verbId: 'mounted.workspace.set'
        });
        return line ? <div style={{ ...PROVENANCE_STYLE, marginTop: 12 }}><BidiText direction="auto">{line}</BidiText></div> : null;
      })()}
      <div
        style={{
          marginTop: 14,
          fontFamily: T.mono,
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: statusColor
        }}
      >
        {statusCopy}
      </div>
    </Card>
  );
};

// Inline jurisdiction + entity-type picker on the Profile card. Writes
// through to clients.profile.jurisdiction / entity_type via the partial-
// merge endpoint. Optimistic toggle with revert on failure, mirroring
// ServicesEngagedCard above.
//
// Defaults to `null` (unset) — the firm card surfaces a "Confirm
// jurisdiction" warning until an operator picks one. We don't silently
// inherit SG anymore; legacy clients still render the SG-shaped facts
// (UEN, Bizfile) because their fixture rows carry those fields, but the
// jurisdiction itself stays unconfirmed until the operator clicks.
const JurisdictionEntityRow = ({
  clientId,
  jurisdiction,
  entityType,
  detectedJurisdiction,
  detectedConfidence,
  latestSignal,
  jurisdictionConfirmation,
  onDatabaseSnapshot
}) => {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [local, setLocal] = useState({ jurisdiction, entityType });
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    setLocal({ jurisdiction, entityType });
    setStatus('idle');
  }, [jurisdiction, entityType, clientId]);

  const persist = (patch, revert) => {
    if (!clientId) return;
    setStatus('saving');
    updateFirmClientProfile({ clientId, profilePatch: patch })
      .then((snapshot) => {
        setStatus('ok');
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      })
      .catch((error) => {
        console.error('Failed to persist jurisdiction/entity_type', error);
        setLocal(revert);
        setStatus('error');
      });
  };

  const onJurisdictionChange = (next) => {
    const value = next || null;
    const prev = local;
    // Changing jurisdiction invalidates entity_type (the prefixes differ).
    // Clearing here keeps storage consistent; the operator picks a new
    // entity type on the next dropdown.
    setLocal({ jurisdiction: value, entityType: null });
    persist({ jurisdiction: value, entity_type: null }, prev);
  };

  const onEntityTypeChange = (next) => {
    const value = next || null;
    const prev = local;
    setLocal({ ...local, entityType: value });
    persist({ entity_type: value }, prev);
  };

  const acceptDetected = () => {
    if (!detectedJurisdiction) return;
    onJurisdictionChange(detectedJurisdiction);
  };

  const unconfirmed = !local.jurisdiction;
  const entityOptions = local.jurisdiction
    ? (ENTITY_TYPES_BY_JURISDICTION[local.jurisdiction] || [])
    : [];

  // Detector suggestion banner — surfaces when the operator has not
  // confirmed yet AND the bank-statement detector has written
  // jurisdiction_detected onto the profile. 'conflicted' rendering
  // calls out the disagreement explicitly instead of pretending we
  // have a suggestion.
  const showDetectorBanner = unconfirmed && (detectedJurisdiction || detectedConfidence === 'conflicted');
  const detectedLabel = detectedJurisdiction
    ? message(JURISDICTION_MESSAGE_IDS[detectedJurisdiction] || 'mounted.workspace.jurisdiction.unknown')
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginTop: 6,
        marginBottom: 14,
        padding: unconfirmed ? '10px 12px' : '0',
        border: unconfirmed ? `1px dashed ${T.amber}` : 'none',
        borderRadius: 8,
        background: unconfirmed ? T.amberSoft : 'transparent'
      }}
    >
      {unconfirmed && (
        <div style={{
          fontFamily: T.mono,
          fontSize: 10.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: T.amber
        }}>
          ⚠ {message('mounted.workspace.confirmJurisdiction')}
        </div>
      )}
      {showDetectorBanner && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 8px',
          borderRadius: 6,
          background: T.card,
          border: `1px solid ${T.rule}`,
          fontSize: 12.5,
          color: T.inkSoft,
          flexWrap: 'wrap'
        }}>
          {detectedConfidence === 'conflicted' ? (
            <span>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.12em', color: T.alert, textTransform: 'uppercase', marginInlineEnd: 6 }}>
                {message('mounted.workspace.signalsDisagree')}
              </span>
              <BidiText direction="auto">{latestSignal?.evidence || message('mounted.workspace.detectorConflict')}</BidiText>
            </span>
          ) : (
            <span>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: '0.12em', color: T.muted, textTransform: 'uppercase', marginInlineEnd: 6 }}>
                {message('mounted.workspace.detected', {
                  jurisdiction: detectedLabel,
                  confidence: detectedConfidence || message('mounted.workspace.unknown')
                })}
              </span>
              {latestSignal?.evidence && (
                <span style={{ color: T.mutedSoft }}>{latestSignal.evidence}</span>
              )}
            </span>
          )}
          {detectedJurisdiction && (
            <button
              type="button"
              onClick={acceptDetected}
              disabled={!clientId}
              style={{
                font: 'inherit',
                fontSize: 11.5,
                padding: '4px 10px',
                borderRadius: 999,
                border: `1px solid ${T.ink}`,
                background: T.ink,
                color: T.paper,
                cursor: clientId ? 'pointer' : 'not-allowed',
                marginInlineStart: 'auto'
              }}
            >
                {message('mounted.workspace.confirmDetected', { jurisdiction: detectedLabel })}
            </button>
          )}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em', color: T.muted, textTransform: 'uppercase' }}>
            {message('mounted.workspace.jurisdiction')}
          </span>
          <select
            value={local.jurisdiction || ''}
            onChange={(e) => onJurisdictionChange(e.target.value)}
            disabled={!clientId}
            style={{
              font: 'inherit',
              fontSize: 13,
              padding: '6px 10px',
              borderRadius: 6,
              border: `1px solid ${T.rule}`,
              background: T.card,
              color: T.ink,
              cursor: clientId ? 'pointer' : 'not-allowed'
            }}
          >
            <option value="">{message('mounted.workspace.unknownOption')}</option>
            {JURISDICTIONS.map((j) => (
              <option key={j.code} value={j.code}>
                {message(JURISDICTION_MESSAGE_IDS[j.code] || 'mounted.workspace.jurisdiction.unknown')}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em', color: T.muted, textTransform: 'uppercase' }}>
            {message('mounted.workspace.entityType')}
          </span>
          <select
            value={local.entityType || ''}
            onChange={(e) => onEntityTypeChange(e.target.value)}
            disabled={!clientId || !local.jurisdiction}
            style={{
              font: 'inherit',
              fontSize: 13,
              padding: '6px 10px',
              borderRadius: 6,
              border: `1px solid ${T.rule}`,
              background: T.card,
              color: T.ink,
              cursor: clientId && local.jurisdiction ? 'pointer' : 'not-allowed'
            }}
          >
            <option value="">{message('mounted.workspace.pickOne')}</option>
            {entityOptions.map((id) => (
              <option key={id} value={id}>
                {PORTAL_LEGAL_FORM_MESSAGE_IDS[id]
                  ? message(PORTAL_LEGAL_FORM_MESSAGE_IDS[id])
                  : entityTypeLabel(id)}
              </option>
            ))}
          </select>
        </label>
        {status === 'saving' && (
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mutedSoft, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            {message('mounted.workspace.saving')}
          </span>
        )}
        {status === 'error' && (
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.alert, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            {message('mounted.workspace.writeFailed')}
          </span>
        )}
      </div>
      {(() => {
        const line = formatProvenanceLine(jurisdictionConfirmation, {
          message,
          formatDate,
          verbId: 'mounted.workspace.confirmed'
        });
        return line ? <div style={PROVENANCE_STYLE}><BidiText direction="auto">{line}</BidiText></div> : null;
      })()}
    </div>
  );
};

// Operator card on the Profile tab — picks the downstream accounting
// connector (clients.profile.accounting_system: xero | qbo | none). Replaces
// the hardcoded "Xero" assumption: the portal connector tile and the
// firm-side writeback verbs read this choice via the shared module. The
// connection STATUS is never stored on the profile — it's derived from
// xero_connections at snapshot read time and arrives as
// profile.accounting_system_connection. Autosave + optimistic revert,
// mirroring ServicesEngagedCard.
const ACCOUNTING_CONNECTION_COPY = {
  connected: { labelId: 'mounted.workspace.connected', fg: T.ok, bg: T.okSoft },
  disconnected: { labelId: 'mounted.workspace.notConnected', fg: T.muted, bg: T.ruleSoft },
  expired: { labelId: 'mounted.workspace.tokenExpired', fg: T.amber, bg: T.amberSoft },
  error: { labelId: 'mounted.workspace.connectionError', fg: T.alert, bg: T.alertSoft }
};

const ACCOUNTING_SYSTEM_SUBLINE = {
  xero: 'mounted.workspace.connector.xero',
  qbo: 'mounted.workspace.connector.qbo',
  procountor: 'mounted.workspace.connector.procountor',
  none: 'mounted.workspace.connector.none'
};

// Same profile writer as the surrounding setup cards; view and method never
// share a select value. Saving a request does not claim readiness or file books.
export const AccountingProfileCard = ({ clientId, profile, onDatabaseSnapshot }) => {
  const intl = useIntl();
  const message = (key) => intl.formatMessage({ id: `mounted.workspace.accountingProfile.${key}` });
  const persisted = readAccountingProfile(profile?.profile || profile || {});
  const [view, setView] = useState(persisted.view.value || '');
  const [method, setMethod] = useState(persisted.method.value || '');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  useEffect(() => {
    setView(persisted.view.value || '');
    setMethod(persisted.method.value || '');
    setStatus('idle');
    setError(null);
  }, [clientId, persisted.view.value, persisted.method.value]);
  const changedView = view !== (persisted.view.value || '');
  const changedMethod = method !== (persisted.method.value || '');
  const save = async (event) => {
    event.preventDefault();
    setStatus('saving');
    setError(null);
    try {
      const snapshot = await updateFirmClientProfile({ clientId, profilePatch: {
        ...(changedView ? { accounting_view: view || null } : {}),
        ...(changedMethod ? { accountingBasis: method || null } : {})
      } });
      onDatabaseSnapshot?.(snapshot);
      setStatus('saved');
    } catch (failure) { setError(failure.message); setStatus('error'); }
  };
  return (
    <Card label={message('label')} title={message('title')}>
      <p style={{ color: T.muted, fontSize: 13 }}>{message('scope')}</p>
      <form onSubmit={save}>
        <label style={{ display: 'block', marginBlock: 12 }}>
          {message('view')}
          <select aria-label={message('view')} value={view} disabled={status === 'saving'} onChange={(event) => setView(event.target.value)} style={{ display: 'block', width: '100%', marginBlockStart: 6 }}>
            <option value="">{message('unknown')}</option>
            <option value="management_books">{message('management')}</option>
            <option value="statutory_books">{message('statutory')}</option>
          </select>
        </label>
        <label style={{ display: 'block', marginBlock: 12 }}>
          {message('method')}
          <select aria-label={message('method')} value={method} disabled={status === 'saving'} onChange={(event) => setMethod(event.target.value)} style={{ display: 'block', width: '100%', marginBlockStart: 6 }}>
            <option value="">{message('unknown')}</option>
            <option value="cash">{message('cash')}</option>
            <option value="accrual">{message('accrual')}</option>
          </select>
        </label>
        {view === 'statutory_books' && <p role="status" style={{ color: T.alert }}>{message('unsupported')}</p>}
        <button type="submit" disabled={!clientId || status === 'saving' || (!changedView && !changedMethod)}>{message(status === 'saving' ? 'saving' : 'save')}</button>
        {status === 'saved' && <p role="status">{message('saved')}</p>}
        {error && <p role="alert">{error}</p>}
      </form>
    </Card>
  );
};

const AccountingSystemCard = ({ clientId, profile, onDatabaseSnapshot }) => {
  const intl = useIntl();
  const { formatDate } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const persisted = readAccountingSystem(profile);
  const connection = readAccountingSystemConnection(profile);
  const provenance = readAccountingSystemProvenance(profile);
  const [selected, setSelected] = useState(persisted);
  const [status, setStatus] = useState('idle');
  const [connectBusy, setConnectBusy] = useState(false);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncNote, setSyncNote] = useState(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [connectError, setConnectError] = useState(null);
  // Procountor connects via a pasted M2M API key (no OAuth redirect).
  const [procountorApiKey, setProcountorApiKey] = useState('');

  useEffect(() => {
    setSelected(persisted);
    setStatus('idle');
    setSyncNote(null);
    setConnectError(null);
  }, [persisted, clientId]);

  // The QBO/Procountor callback redirects back here with ?qbo=connected /
  // ?procountor=connected on success, or ?procountor_error=<message> on failure
  // (the callback used to dead-end on a raw error page — same-tab connect gave
  // the operator no clue what broke). That return is a full page load, so the
  // snapshot already carries any new connection status (rendered inline by the
  // pill below); here we surface a failure message and strip the one-shot flags
  // so a manual refresh doesn't keep them around.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const procountorError = params.get('procountor_error');
    const connected = params.get('qbo') === 'connected' || params.get('procountor') === 'connected';
    if (!connected && !procountorError) return;
    if (procountorError) {
      setConnectError(message('mounted.workspace.connectFailedDetail', {
        system: 'Procountor',
        detail: procountorError
      }));
    }
    params.delete('qbo');
    params.delete('qbo_realm');
    params.delete('procountor');
    params.delete('procountor_company');
    params.delete('procountor_error');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, []);

  // Same-tab connect navigates away, so a browser-back restores this page from
  // the bfcache with connectBusy still true — the button reads "Opening…"
  // forever. Clear it on bfcache restore so the action row reflects real state.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPageShow = (event) => {
      if (event.persisted) {
        setConnectBusy(false);
        setDisconnectBusy(false);
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // Whether the operator can pick this connector. QBO is selectable + connect-
  // able (connectable) before it is fully wired (available); everything else
  // falls back to `available`.
  const isSelectable = (sys) => sys.connectable ?? sys.available;

  // A live (non-disconnected) connection row exists for the chosen system.
  const isConnected = Boolean(connection) && connection.status !== 'disconnected';
  // INT-4d — server-derived posted-not-exported count (snapshot-time, from
  // accounting_system_connection). >0 turns the Mirror action into an explicit
  // "Export N" call-to-action with an amber count line: posted entries resting
  // un-exported are a violation to drain, not a neutral state.
  const pendingExportCount = Number(connection?.pending_export_count) || 0;
  // Refresh/API failure flipped the row to 'expired'/'error' server-side —
  // sync and mirror will keep failing until OAuth is re-run, so surface a
  // Reconnect action next to them (re-connect upserts the row back to
  // 'connected').
  const needsReauth =
    isConnected && (connection.status === 'expired' || connection.status === 'error');

  // The chosen connector's display name. The connect/sync/mirror/disconnect
  // verbs all dispatch by the client's accounting_system server-side, so the
  // same handlers drive both — only the labels differ.
  const systemLabel = selected === 'xero' ? 'Xero' : selected === 'procountor' ? 'Procountor' : 'QuickBooks';

  // Procountor is a capability trial that has graduated verb-by-verb: connect,
  // reference sync, AND ledger writeback (verb 2.1c) are now live, so it shows
  // Connect + Sync + Mirror + Disconnect like Xero/QBO. (A Procountor mirror
  // exports posted journals as UNFINISHED ledger-receipt drafts the firm verifies
  // in Procountor — the API has no journal-verify step.) Split the flags so each
  // button gates independently.
  const connectorHasSync = selected === 'xero' || selected === 'qbo' || selected === 'procountor';
  const connectorHasMirror = selected === 'xero' || selected === 'qbo' || selected === 'procountor';
  const connectorShowsActions = selected === 'xero' || selected === 'qbo' || selected === 'procountor';

  const handleConnectQbo = () => {
    if (!clientId) return;
    setConnectBusy(true);
    setConnectError(null);
    const returnTo =
      typeof window !== 'undefined'
        ? `${window.location.pathname}${window.location.search}`
        : undefined;
    // connectXero hits /xero/connect, which dispatches by the client's
    // accounting_system — for a QBO client it returns the QBO authorize URL.
    connectXero({ clientId, returnTo })
      .then((data) => {
        if (!data?.authorizeUrl) throw new Error(message('mounted.workspace.noAuthorizeUrl'));
        window.location.assign(data.authorizeUrl);
      })
      .catch((err) => {
        setConnectError(err?.message || message('mounted.workspace.couldNotStartConnect', { system: systemLabel }));
        setConnectBusy(false);
      });
  };

  // Procountor M2M: submit the pasted API key. The server mints a token from it,
  // reads the company, and stores the connection — no redirect. On success the
  // returned snapshot flips the card to Connected via onDatabaseSnapshot.
  const handleConnectProcountor = () => {
    if (!clientId) return;
    const apiKey = procountorApiKey.trim();
    if (!apiKey) {
      setConnectError(message('mounted.workspace.procountorKey'));
      return;
    }
    setConnectBusy(true);
    setConnectError(null);
    connectProcountorWithApiKey({ clientId, apiKey })
      .then((snapshot) => {
        setConnectBusy(false);
        setProcountorApiKey('');
        setSyncNote(message('mounted.workspace.procountorConnected'));
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      })
      .catch((err) => {
        setConnectBusy(false);
        setConnectError(err?.message || message('mounted.workspace.procountorError'));
      });
  };

  const handleDisconnectQbo = () => {
    if (!clientId) return;
    setDisconnectBusy(true);
    setConnectError(null);
    // disconnectAccounting posts to /xero/disconnect, which dispatches by the
    // client's accounting_system — for a Xero client it tears down the Xero
    // connection, for a QBO client the QBO one.
    disconnectAccounting({ clientId, connectionId: connection?.connection_id })
      .then((snapshot) => {
        setDisconnectBusy(false);
        // The route returns a fresh source:'database' snapshot; hand it up so
        // the card re-renders against the now-disconnected status.
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      })
      .catch((err) => {
        setConnectError(err?.message || message('mounted.workspace.couldNotDisconnect', { system: systemLabel }));
        setDisconnectBusy(false);
      });
  };

  const handleSyncQbo = () => {
    if (!clientId) return;
    setSyncBusy(true);
    setSyncNote(null);
    setConnectError(null);
    // Reference sync dispatches by the client's accounting_system server-side.
    // Xero/QBO ride /xero/sync-reference-data; Procountor has its own path/verb
    // (procountorAdapter.syncReferenceData → pulls coa/dimensions/business
    // partners/bank accounts). Both return the fresh source:'database' snapshot,
    // so the inline pill's "synced <date>" detail refreshes the same way.
    const syncReferenceData =
      selected === 'procountor' ? syncProcountorReferenceData : syncXeroReferenceData;
    syncReferenceData({ clientId, connectionId: connection?.connection_id })
      .then((snapshot) => {
        setSyncBusy(false);
        setSyncNote(message('mounted.workspace.referenceSynced', { system: systemLabel }));
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      })
      .catch((err) => {
        setSyncBusy(false);
        setConnectError(err?.message || message('mounted.workspace.couldNotSync', { system: systemLabel }));
      });
  };

  const handleMirrorQbo = () => {
    if (!clientId) return;
    setMirrorBusy(true);
    setSyncNote(null);
    setConnectError(null);
    // Mirrors every posted ledger journal (transactions + adjustments) to QBO
    // JournalEntry. Rides /xero/writeback-transactions (dispatches by system).
    mirrorLedgerToAccounting({ clientId, connectionId: connection?.connection_id })
      .then((snapshot) => {
        setMirrorBusy(false);
        const counts = snapshot?.xero_writeback_batch?.counts;
        if (counts) {
          const bits = [message('mounted.workspace.mirroredCount', { count: counts.synced })];
          if (counts.errors) bits.push(message('mounted.workspace.errorCount', { count: counts.errors }));
          else if (!counts.candidates) bits.push(message('mounted.workspace.nothingMirror'));
          setSyncNote(message('mounted.workspace.ledgerMirrorResult', {
            system: systemLabel,
            summary: bits.join(' · ')
          }));
        } else {
          setSyncNote(message('mounted.workspace.ledgerMirrored', { system: systemLabel }));
        }
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      })
      .catch((err) => {
        setMirrorBusy(false);
        setConnectError(err?.message || message('mounted.workspace.couldNotMirror', { system: systemLabel }));
      });
  };

  const choose = (id) => {
    if (!clientId) return;
    const sys = ACCOUNTING_SYSTEMS.find((a) => a.id === id);
    if (!sys || !isSelectable(sys) || id === selected) return;
    const prev = selected;
    setSelected(id);
    setStatus('saving');
    updateFirmClientProfile({
      clientId,
      // Provenance (set_by/set_at) is server-stamped from the
      // authenticated operator; the card sends only the choice.
      profilePatch: { accounting_system: id }
    })
      .then((snapshot) => {
        setStatus('ok');
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      })
      .catch((error) => {
        console.error('Failed to persist accounting_system', error);
        setSelected(prev);
        setStatus('error');
      });
  };

  const statusCopy =
    status === 'saving' ? message('mounted.workspace.autosaveSaving')
    : status === 'error' ? message('mounted.workspace.autosaveError')
    : status === 'ok' ? message('mounted.workspace.autosaveOk')
    : message('mounted.workspace.autosaved');
  const statusColor = status === 'error' ? T.alert : T.mutedSoft;

  // Connection sub-line only renders against the connector-backed system
  // (Xero today); 'none' has no connection and QBO isn't wired.
  const connCopy = connection ? (ACCOUNTING_CONNECTION_COPY[connection.status] || ACCOUNTING_CONNECTION_COPY.disconnected) : null;
  const connDetail = connection
    ? [
        connection.tenant_name,
        connection.last_synced_at
          ? message('mounted.workspace.syncedOn', {
              date: formatDate(String(connection.last_synced_at).slice(0, 10), {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
              })
            })
          : null
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <Card label={message('mounted.workspace.accounting')} title={message('mounted.workspace.accountingTitle')}>
      <p style={{ margin: '4px 0 14px', fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
        {message('mounted.workspace.accountingDesc')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {ACCOUNTING_SYSTEMS.map((sys, i) => {
          const checked = selected === sys.id;
          const interactive = Boolean(clientId) && isSelectable(sys);
          // Inline connection-status pill next to whichever connector is the
          // chosen one (Xero or QBO; 'none' has no connection). The snapshot
          // surfaces the chosen system's connection as accounting_system_connection.
          const showConn = checked && sys.id !== 'none' && Boolean(connection);
          return (
            <label
              key={sys.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '11px 2px',
                borderTop: i === 0 ? 'none' : `1px solid ${T.ruleMicro}`,
                fontSize: 13.5,
                color: T.ink,
                cursor: interactive ? 'pointer' : 'not-allowed'
              }}
            >
              <input
                type="radio"
                name={`accounting-system-${clientId || 'none'}`}
                checked={checked}
                onChange={() => choose(sys.id)}
                disabled={!interactive}
                style={{
                  width: 16,
                  height: 16,
                  marginTop: 2,
                  accentColor: T.ok,
                  cursor: interactive ? 'pointer' : 'not-allowed',
                  flex: '0 0 auto'
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ color: isSelectable(sys) ? T.ink : T.mutedSoft }}>
                    {message(sys.labelId || 'mounted.workspace.accountingSystem.unknown')}
                  </span>
                  {!sys.available && (
                    <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.mutedSoft }}>
                      {message(sys.connectable ? 'mounted.workspace.connectSync' : 'mounted.workspace.comingSoon')}
                    </span>
                  )}
                  {showConn && connCopy && (
                    <span
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        padding: '2px 8px',
                        borderRadius: 999,
                        background: connCopy.bg,
                        color: connCopy.fg
                      }}
                    >
                      {message(connCopy.labelId)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: T.mutedSoft, marginTop: 2 }}>
                  {showConn && connDetail ? <BidiText direction="auto">{connDetail}</BidiText> : message(ACCOUNTING_SYSTEM_SUBLINE[sys.id])}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      {connectorShowsActions && clientId && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {isConnected ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {needsReauth && (
                <button
                  type="button"
                  onClick={handleConnectQbo}
                  disabled={connectBusy}
                  style={{
                    font: 'inherit',
                    fontSize: 12.5,
                    padding: '7px 14px',
                    borderRadius: 999,
                    border: `1px solid ${T.amber}`,
                    background: connectBusy ? T.card : T.amberSoft,
                    color: connectBusy ? T.mutedSoft : T.ink,
                    cursor: connectBusy ? 'wait' : 'pointer'
                  }}
                >
                  {message(connectBusy ? 'mounted.workspace.openingSystem' : 'mounted.workspace.reconnect', { system: systemLabel })}
                </button>
              )}
              {connectorHasSync && (
                <button
                  type="button"
                  onClick={handleSyncQbo}
                  disabled={syncBusy}
                  style={{
                    font: 'inherit',
                    fontSize: 12.5,
                    padding: '7px 14px',
                    borderRadius: 999,
                    border: `1px solid ${T.ink}`,
                    background: syncBusy ? T.card : T.ink,
                    color: syncBusy ? T.muted : T.paper,
                    cursor: syncBusy ? 'wait' : 'pointer'
                  }}
                >
                  {message(syncBusy ? 'mounted.workspace.syncing' : 'mounted.workspace.sync', { system: systemLabel })}
                </button>
              )}
              {connectorHasMirror && (
                <button
                  type="button"
                  onClick={handleMirrorQbo}
                  disabled={mirrorBusy}
                  style={{
                    font: 'inherit',
                    fontSize: 12.5,
                    padding: '7px 14px',
                    borderRadius: 999,
                    border: `1px solid ${T.ink}`,
                    background: T.card,
                    color: mirrorBusy ? T.mutedSoft : T.ink,
                    cursor: mirrorBusy ? 'wait' : 'pointer'
                  }}
                >
                  {mirrorBusy
                    ? message('mounted.workspace.mirroring')
                    : pendingExportCount > 0
                      ? message('mounted.workspace.exportCount', { count: pendingExportCount, system: systemLabel })
                      : message('mounted.workspace.mirrorLedger', { system: systemLabel })}
                </button>
              )}
              <button
                type="button"
                onClick={handleDisconnectQbo}
                disabled={disconnectBusy}
                style={{
                  font: 'inherit',
                  fontSize: 12.5,
                  padding: '7px 14px',
                  borderRadius: 999,
                  border: `1px solid ${T.alert}`,
                  background: T.card,
                  color: disconnectBusy ? T.mutedSoft : T.alert,
                  cursor: disconnectBusy ? 'wait' : 'pointer'
                }}
              >
                {message(disconnectBusy ? 'mounted.workspace.disconnecting' : 'mounted.workspace.disconnect', { system: systemLabel })}
              </button>
            </div>
          ) : selected === 'procountor' ? (
            // Procountor connects with a pasted M2M API key (no OAuth redirect).
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="password"
                value={procountorApiKey}
                onChange={(e) => setProcountorApiKey(e.target.value)}
                placeholder={message('mounted.workspace.apiKey')}
                autoComplete="off"
                spellCheck={false}
                disabled={connectBusy}
                style={{
                  font: 'inherit',
                  fontSize: 12.5,
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: `1px solid ${T.rule}`,
                  background: T.paper,
                  color: T.ink,
                  width: '100%',
                  maxWidth: 420
                }}
              />
              <button
                type="button"
                onClick={handleConnectProcountor}
                disabled={connectBusy}
                style={{
                  font: 'inherit',
                  fontSize: 12.5,
                  padding: '7px 14px',
                  borderRadius: 999,
                  border: `1px solid ${T.ink}`,
                  background: connectBusy ? T.card : T.ink,
                  color: connectBusy ? T.muted : T.paper,
                  cursor: connectBusy ? 'wait' : 'pointer',
                  alignSelf: 'flex-start'
                }}
              >
                {message(connectBusy ? 'mounted.workspace.connecting' : 'mounted.workspace.connectProcountor')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleConnectQbo}
              disabled={connectBusy}
              style={{
                font: 'inherit',
                fontSize: 12.5,
                padding: '7px 14px',
                borderRadius: 999,
                border: `1px solid ${T.ink}`,
                background: connectBusy ? T.card : T.ink,
                color: connectBusy ? T.muted : T.paper,
                cursor: connectBusy ? 'wait' : 'pointer',
                alignSelf: 'flex-start'
              }}
            >
              {message(connectBusy ? 'mounted.workspace.openingSystem' : 'mounted.workspace.connect', { system: systemLabel })}
            </button>
          )}
          {isConnected && pendingExportCount > 0 && (
            <span style={{ fontSize: 11.5, color: T.amber }}>
              {message('mounted.workspace.pendingExports', { count: pendingExportCount, system: systemLabel })}
            </span>
          )}
          {connectError && (
            <span style={{ fontSize: 11.5, color: T.alert }}>{connectError}</span>
          )}
          {syncNote && !connectError && (
            <span style={{ fontSize: 11.5, color: T.ok }}>{syncNote}</span>
          )}
          <span style={{ fontSize: 11.5, color: T.mutedSoft }}>
            {selected === 'procountor'
              ? isConnected
                ? message('mounted.workspace.procountorConnectedHelp')
                : message('mounted.workspace.procountorConnectHelp')
              : connectorHasMirror
                ? isConnected
                  ? message('mounted.workspace.connectorConnectedHelp', { system: systemLabel })
                  : message('mounted.workspace.connectorConnectHelp')
                : isConnected
                  ? message('mounted.workspace.capabilityConnectedHelp', { system: systemLabel })
                  : message('mounted.workspace.capabilityConnectHelp', { system: systemLabel })}
          </span>
        </div>
      )}
      {(() => {
        const line = formatProvenanceLine(provenance, {
          message,
          formatDate,
          verbId: 'mounted.workspace.set'
        });
        return line ? <div style={{ ...PROVENANCE_STYLE, marginTop: 12 }}><BidiText direction="auto">{line}</BidiText></div> : null;
      })()}
      <div
        style={{
          marginTop: 14,
          fontFamily: T.mono,
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: statusColor
        }}
      >
        {statusCopy}
      </div>
    </Card>
  );
};

const ProfileTab = ({ profile, queue, onRequestDelete, onDatabaseSnapshot }) => {
  const intl = useIntl();
  const { formatNumber } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const facts = profile.bizfile?.facts || [];
  const { summary, filing, capital } = splitProfileFacts(facts);
  const openCompliance = queue.filter((item) => item.queue_label === 'expert_review').length;
  const officersCount = (profile.bizfile?.tables || []).find((t) => /officer/i.test(t.title))?.records?.length;
  const shareholdersCount = (profile.bizfile?.tables || []).find((t) => /shareholder/i.test(t.title))?.records?.length;

  // Jurisdiction-aware copy. Operator-set on the inline picker; null
  // until confirmed. The entity-number pill label and the Card source
  // line both fall through to neutral defaults until a jurisdiction +
  // entity type are set.
  const jurisdiction = readJurisdiction(profile);
  const entityType = readEntityType(profile);
  const servicesEngaged = readServicesEngaged(profile);
  const entityNoLabelText = message(
    ENTITY_NUMBER_MESSAGE_IDS[entityNumberLabel(entityType)] || 'mounted.workspace.entityNumber.generic'
  );
  const registrySource = profile.bizfile?.source || message(
    REGISTRY_SOURCE_MESSAGE_IDS[jurisdiction] || 'mounted.workspace.registrySource.manual'
  );
  const showComplianceCard = filing.length > 0 && shouldRenderComplianceCard({
    services: servicesEngaged,
    jurisdiction,
    entityType
  });
  // Phase 2b — detector-side suggestion. Surfaced on the
  // JurisdictionEntityRow warning state when the operator hasn't
  // confirmed yet. Server writes these; never operator-written.
  const detectedJurisdiction = readJurisdictionDetected(profile);
  const detectedConfidence = readJurisdictionDetectedConfidence(profile);
  const latestSignal = readLatestJurisdictionSignal(profile);
  const jurisdictionConfirmation = readJurisdictionConfirmation(profile);

  return (
    <div
      style={{
        padding: '28px 0 60px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 320px',
        gap: 24,
        alignItems: 'flex-start'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
        <Card label={message('mounted.workspace.registry')} title={message('mounted.workspace.companySnapshot')} sub={<BidiText direction="auto">{registrySource}</BidiText>}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10, marginBottom: 14 }}>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 11,
                padding: '4px 9px',
                borderRadius: 4,
                background: T.okSoft,
                color: T.ok,
                letterSpacing: '0.06em'
              }}
            >
              ● <BidiText direction="auto">{profile.stage || message('mounted.workspace.live')}</BidiText>
            </span>
            {profile.uen && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 11,
                  padding: '4px 9px',
                  borderRadius: 4,
                  background: T.ruleSoft,
                  color: T.inkSoft,
                  letterSpacing: '0.06em'
                }}
              >
                {entityNoLabelText} <IdentifierText>{profile.uen}</IdentifierText>
              </span>
            )}
            {entityType && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 11,
                  padding: '4px 9px',
                  borderRadius: 4,
                  background: T.ruleSoft,
                  color: T.inkSoft,
                  letterSpacing: '0.06em'
                }}
              >
                {PORTAL_LEGAL_FORM_MESSAGE_IDS[entityType]
                  ? message(PORTAL_LEGAL_FORM_MESSAGE_IDS[entityType])
                  : <BidiText direction="auto">{entityTypeLabel(entityType)}</BidiText>}
              </span>
            )}
            {!entityType && profile.entityType && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 11,
                  padding: '4px 9px',
                  borderRadius: 4,
                  background: T.ruleSoft,
                  color: T.inkSoft,
                  letterSpacing: '0.06em'
                }}
              >
                <BidiText direction="auto">{profile.entityType}</BidiText>
              </span>
            )}
            {jurisdiction && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 11,
                  padding: '4px 9px',
                  borderRadius: 4,
                  background: T.accentSoft,
                  color: T.accent,
                  letterSpacing: '0.06em'
                }}
              >
                {message(JURISDICTION_MESSAGE_IDS[jurisdiction] || 'mounted.workspace.jurisdiction.unknown')}
              </span>
            )}
          </div>
          <JurisdictionEntityRow
            clientId={profile.id}
            jurisdiction={jurisdiction}
            entityType={entityType}
            detectedJurisdiction={detectedJurisdiction}
            detectedConfidence={detectedConfidence}
            latestSignal={latestSignal}
            jurisdictionConfirmation={jurisdictionConfirmation}
            onDatabaseSnapshot={onDatabaseSnapshot}
          />
          {summary.length > 0
            ? summary.map((f) => <Field key={f.label} label={f.label} value={f.value || '—'} />)
            : <div style={{ padding: '12px 0', fontSize: 13, color: T.muted }}>{message('mounted.workspace.noRegistry')}</div>}
        </Card>

        <ServicesEngagedCard
          clientId={profile.id}
          profile={profile}
          onDatabaseSnapshot={onDatabaseSnapshot}
        />

        <FinnishCompanyDetails profile={profile} onDatabaseSnapshot={onDatabaseSnapshot} />

        <AccountingProfileCard clientId={profile.id} profile={profile} onDatabaseSnapshot={onDatabaseSnapshot} />

        <AccountingSystemCard
          clientId={profile.id}
          profile={profile}
          onDatabaseSnapshot={onDatabaseSnapshot}
        />

        <ReconciliationAuthorityGrants clientId={profile.id} />

        {showComplianceCard && (
          <Card label={message('mounted.workspace.filing')} title={message('mounted.workspace.returnReadiness')} accent={T.alert}>
            <p style={{ margin: '4px 0 12px', fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
              {message('mounted.workspace.filingHelp')}
            </p>
            {filing.map((f) => (
              <Field
                key={f.label}
                label={f.label}
                value={f.value && !/blank|missing|n\/a|—/i.test(f.value) ? f.value : message('mounted.workspace.blankRegistry')}
                missing={!f.value || /blank|missing|n\/a|—/i.test(f.value)}
              />
            ))}
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <button
                style={{
                  font: 'inherit',
                  fontSize: 12.5,
                  padding: '7px 14px',
                  borderRadius: 999,
                  border: 'none',
                  background: T.ink,
                  color: T.paper,
                  cursor: 'pointer'
                }}
              >
                {message('mounted.workspace.askClient')}
              </button>
              <button
                style={{
                  font: 'inherit',
                  fontSize: 12.5,
                  padding: '7px 14px',
                  borderRadius: 999,
                  border: `1px solid ${T.rule}`,
                  background: T.card,
                  color: T.inkSoft,
                  cursor: 'pointer'
                }}
              >
                {message('mounted.workspace.notApplicable')}
              </button>
            </div>
          </Card>
        )}

        {capital.length > 0 && (
          <Card label={message('mounted.workspace.shareCapital')} title={message('mounted.workspace.shareCapitalTitle')}>
            <div style={{ marginTop: 6 }}>
              {capital.map((f) => <Field key={f.label} label={f.label} value={f.value || '—'} />)}
            </div>
          </Card>
        )}
      </div>

      <aside style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 24 }}>
        <div style={{ background: T.card, border: `1px solid ${T.rule}`, borderRadius: 12, padding: 16 }}>
          <SectionLabel>{message('mounted.workspace.source')}</SectionLabel>
          <div style={{ marginTop: 8, fontSize: 13, color: T.inkSoft, lineHeight: 1.5 }}>
            <BidiText direction="auto">{profile.bizfile?.source || message('mounted.workspace.bizfileSource')}</BidiText>
          </div>
          {profile.incorporationDate && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: T.muted, fontFamily: T.mono }}>
              {profile.incorporationDate}
            </div>
          )}
        </div>

        <div style={{ background: T.card, border: `1px solid ${T.rule}`, borderRadius: 12, padding: 16 }}>
          <SectionLabel>{message('mounted.workspace.quickStats')}</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            {[
              officersCount != null && {
                k: message('mounted.workspace.officers'),
                v: String(officersCount),
                s: message('mounted.workspace.onBizfile')
              },
              shareholdersCount != null && {
                k: message('mounted.workspace.shareholders'),
                v: String(shareholdersCount),
                s: message('mounted.workspace.onRegister')
              },
              {
                k: message('mounted.workspace.openCompliance'),
                v: String(openCompliance),
                s: message('mounted.workspace.reviewItems'),
                alert: openCompliance > 0
              }
            ].filter(Boolean).map((s) => (
              <div key={s.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <div style={{ fontSize: 12.5, color: T.inkSoft }}>{s.k}</div>
                  <div style={{ fontSize: 11, color: T.mutedSoft }}>{s.s}</div>
                </div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 18,
                    fontWeight: 500,
                    color: s.alert ? T.alert : T.ink
                  }}
                >
                  <FormattedValue>{formatNumber(Number(s.v))}</FormattedValue>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: T.paper, border: `1px dashed ${T.rule}`, borderRadius: 12, padding: 16 }}>
          <SectionLabel>{message('mounted.workspace.danger')}</SectionLabel>
          <p style={{ margin: '8px 0 10px', fontSize: 12, color: T.muted, lineHeight: 1.5 }}>
            {message('mounted.workspace.deleteEntityDesc')}
          </p>
          <button
            type="button"
            onClick={onRequestDelete}
            disabled={!onRequestDelete}
            style={{
              font: 'inherit',
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: 999,
              border: `1px solid ${T.alert}`,
              background: 'transparent',
              color: T.alert,
              cursor: onRequestDelete ? 'pointer' : 'not-allowed',
              opacity: onRequestDelete ? 1 : 0.5
            }}
          >
            {message('mounted.workspace.deleteEntity')}
          </button>
        </div>
      </aside>
    </div>
  );
};

// ── People & ownership tab ────────────────────────────────────────────────────

const ROLE_TINT = (role = '') => {
  if (/secretary/i.test(role)) return { bg: T.accentSoft, fg: T.accent };
  if (/director/i.test(role)) return { bg: T.amberSoft, fg: T.amber };
  return { bg: T.ruleSoft, fg: T.inkSoft };
};

const KIND_TINT = (kind = '') => {
  if (/individual/i.test(kind)) return { bg: T.okSoft, fg: T.ok };
  return { bg: 'rgba(46,42,34,0.06)', fg: T.inkSoft };
};

const initialsOf = (name = '') => {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[parts.length - 1]?.[0] || '')).toUpperCase();
};

const recordItem = (record, ...labels) => {
  const items = record.items || [];
  for (const label of labels) {
    const found = items.find((it) => new RegExp(label, 'i').test(it.label || ''));
    if (found?.value) return found.value;
  }
  return null;
};

const numberFromRecord = (record) => {
  const raw = recordItem(record, 'shares', 'holding') || '';
  const match = String(raw).match(/[\d,]+/);
  return match ? Number(match[0].replace(/,/g, '')) : 0;
};

const OfficerCard = ({ record }) => {
  const intl = useIntl();
  const role = record.badge || record.badges?.[0] || intl.formatMessage({ id: 'mounted.workspace.officerFallback' });
  const tint = ROLE_TINT(role);
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            background: D.paper,
            color: T.inkSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '0.04em',
            flex: '0 0 auto'
          }}
        >
          {initialsOf(record.name || '')}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}><BidiText direction="auto">{record.name}</BidiText></div>
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                padding: '2px 7px',
                borderRadius: 4,
                background: tint.bg,
                color: tint.fg,
                fontWeight: 500
              }}
            >
              <BidiText direction="auto">{role}</BidiText>
            </span>
          </div>
        </div>
      </div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 7, columnGap: 12, fontSize: 12.5 }}>
        {(record.items || []).slice(0, 5).map((item) => (
          <div key={`${item.label}-${item.value}`} style={{ display: 'contents' }}>
            <dt
              style={{
                color: T.muted,
                fontFamily: T.mono,
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                paddingTop: 2
              }}
            >
              <BidiText direction="auto">{item.label}</BidiText>
            </dt>
            <dd style={{ margin: 0, color: T.inkSoft, lineHeight: 1.4 }}><BidiText direction="auto">{item.value}</BidiText></dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

const PeopleTab = ({ profile }) => {
  const intl = useIntl();
  const { formatNumber } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const tables = profile.bizfile?.tables || [];
  const officers = tables.find((t) => /officer/i.test(t.title))?.records || [];
  const shareholders = tables.find((t) => /shareholder/i.test(t.title))?.records || [];
  const fillColors = [T.ink, T.amber, T.accent, T.ok, T.alert];

  const totalShares = shareholders.reduce((sum, s) => sum + numberFromRecord(s), 0);

  if (officers.length === 0 && shareholders.length === 0) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center', color: T.muted, fontSize: 14 }}>
        {message('mounted.workspace.noPeople')}
      </div>
    );
  }

  return (
    <div style={{ padding: '28px 0 60px', display: 'flex', flexDirection: 'column', gap: 36 }}>
      {officers.length > 0 && (
        <section>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <SectionLabel>{intl.formatMessage({ id: 'mounted.workspace.officers' })}</SectionLabel>
              <div style={{ marginTop: 2, fontSize: 13, color: T.muted }}>
                {message('mounted.workspace.records', { count: officers.length })}
              </div>
            </div>
            <button
              style={{
                font: 'inherit',
                fontSize: 12,
                padding: '6px 12px',
                borderRadius: 999,
                border: `1px solid ${T.rule}`,
                background: T.card,
                color: T.inkSoft,
                cursor: 'pointer'
              }}
            >
              + {message('mounted.workspace.addOfficer')}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            {officers.map((record, i) => <OfficerCard key={record.name || i} record={record} />)}
          </div>
        </section>
      )}

      {shareholders.length > 0 && (
        <section>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <SectionLabel>{intl.formatMessage({ id: 'mounted.workspace.shareholdersTitle' })}</SectionLabel>
              <div style={{ marginTop: 2, fontSize: 13, color: T.muted }}>
                {intl.formatMessage(
                  { id: 'mounted.workspace.shareRecord' },
                  { recordCount: shareholders.length, shares: totalShares > 0 ? totalShares : 0 }
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                style={{
                  font: 'inherit',
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: `1px solid ${T.rule}`,
                  background: T.card,
                  color: T.inkSoft,
                  cursor: 'pointer'
                }}
              >
                {message('mounted.workspace.exportRegister')}
              </button>
              <button
                style={{
                  font: 'inherit',
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: 'none',
                  background: T.ink,
                  color: T.paper,
                  cursor: 'pointer'
                }}
              >
                {message('mounted.workspace.requestUbo')}
              </button>
            </div>
          </div>

          {totalShares > 0 && (
            <div style={{ background: T.card, border: `1px solid ${T.rule}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
              <div
                style={{
                  height: 14,
                  borderRadius: 4,
                  overflow: 'hidden',
                  display: 'flex',
                  background: T.ruleSoft
                }}
              >
                {shareholders.map((s, i) => {
                  const shares = numberFromRecord(s);
                  const pct = (shares / totalShares) * 100;
                  if (pct === 0) return null;
                  return (
                    <div
                      key={s.name || i}
                      title={`${s.name} · ${formatNumber(pct / 100, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      style={{ width: `${pct}%`, background: fillColors[i % fillColors.length] }}
                    />
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                {[0, 0.25, 0.5, 0.75, 1].map((value) => (
                  <FormattedValue key={value}>{formatNumber(value, { style: 'percent', maximumFractionDigits: 0 })}</FormattedValue>
                ))}
              </div>
            </div>
          )}

          <div style={{ background: T.card, border: `1px solid ${T.rule}`, borderRadius: 12, overflow: 'hidden' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 2fr 130px 110px minmax(0, 1fr)',
                gap: 16,
                padding: '10px 18px',
                fontFamily: T.mono,
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
                color: T.mutedSoft,
                borderBottom: `1px solid ${T.ruleSoft}`
              }}
            >
              <span />
              <span>{intl.formatMessage({ id: 'mounted.workspace.holder' })}</span>
              <span style={{ textAlign: 'end' }}>{intl.formatMessage({ id: 'mounted.workspace.shares' })}</span>
              <span style={{ textAlign: 'end' }}>%</span>
              <span>{intl.formatMessage({ id: 'mounted.workspace.idAddress' })}</span>
            </div>
            {shareholders.map((s, i) => {
              const kind = s.badge || s.badges?.[0] || message('mounted.workspace.holderFallback');
              const tint = KIND_TINT(kind);
              const shares = numberFromRecord(s);
              const pct = totalShares > 0 ? (shares / totalShares) * 100 : 0;
              const idValue = recordItem(s, 'id number', 'identifier', 'id');
              const addr = recordItem(s, 'address');
              return (
                <div
                  key={s.name || i}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 2fr 130px 110px minmax(0, 1fr)',
                    gap: 16,
                    padding: '14px 18px',
                    borderBottom: i === shareholders.length - 1 ? 'none' : `1px solid ${T.ruleMicro}`,
                    alignItems: 'center'
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: fillColors[i % fillColors.length] }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500, color: T.ink }}><BidiText direction="auto">{s.name}</BidiText></span>
                      <span
                        style={{
                          fontFamily: T.mono,
                          fontSize: 10,
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: tint.bg,
                          color: tint.fg
                        }}
                      >
                        <BidiText direction="auto">{kind}</BidiText>
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'end' }}>
                    <div style={{ fontFamily: T.mono, fontSize: 13, fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: T.ink }}>
                      {shares > 0 ? <FormattedValue>{formatNumber(shares)}</FormattedValue> : '—'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'end' }}>
                    <div style={{ fontFamily: T.mono, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: T.inkSoft, fontWeight: 500 }}>
                      {pct > 0
                        ? <FormattedValue>{formatNumber(pct / 100, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 })}</FormattedValue>
                        : '—'}
                    </div>
                    {pct > 0 && (
                      <div style={{ height: 3, background: T.ruleSoft, borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: fillColors[i % fillColors.length] }} />
                      </div>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    {idValue && <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.inkSoft }}><IdentifierText>{idValue}</IdentifierText></div>}
                    {addr && (
                      <div
                        title={addr}
                        style={{
                          fontSize: 11.5,
                          color: T.muted,
                          lineHeight: 1.45,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        <BidiText direction="auto">{addr}</BidiText>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};

// ── Compliance tab ────────────────────────────────────────────────────────────

const ComplianceTab = ({ profile, queue }) => {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const checklist = profile.intakeChecklist || [];
  const mismatches = profile.bizfile?.mismatches || [];
  const counts = countStatuses(checklist);
  const openCompliance = queue.filter((item) => item.queue_label === 'expert_review').length;
  const openIntake = queue.filter((item) => item.queue_label === 'ops_review').length;
  const followUps = checklist.filter((c) => STATUS_RANK[c.status] >= 1).length;

  return (
    <div
      style={{
        padding: '24px 0 60px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 320px',
        gap: 36,
        alignItems: 'flex-start'
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
          <div>
            <SectionLabel>{message('mounted.workspace.intakeChecklist')}</SectionLabel>
            <div style={{ marginTop: 2, fontSize: 13, color: T.muted }}>
              {followUps > 0 && <span style={{ color: T.alert }}>{followUps} client follow-up{followUps === 1 ? '' : 's'}</span>}
              {openIntake > 0 && (followUps > 0 ? ' · ' : '')}
              {openIntake > 0 && `${openIntake} open question${openIntake === 1 ? '' : 's'}`}
              {followUps === 0 && openIntake === 0 && 'All requests resolved.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{
                font: 'inherit',
                fontSize: 12,
                padding: '6px 12px',
                borderRadius: 999,
                border: `1px solid ${T.rule}`,
                background: T.card,
                color: T.inkSoft,
                cursor: 'pointer'
              }}
            >
              Re-extract Bizfile
            </button>
            <button
              style={{
                font: 'inherit',
                fontSize: 12,
                padding: '6px 12px',
                borderRadius: 999,
                border: 'none',
                background: T.ink,
                color: T.paper,
                cursor: 'pointer'
              }}
            >
              Send client request
            </button>
          </div>
        </div>

        <div style={{ background: T.card, border: `1px solid ${T.rule}`, borderRadius: 12, overflow: 'hidden' }}>
          {checklist.map((item, i) => (
            <div
              key={item.id || item.label}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) 110px 110px',
                gap: 18,
                padding: '16px 20px',
                borderBottom: i === checklist.length - 1 ? 'none' : `1px solid ${T.ruleSoft}`,
                alignItems: 'flex-start'
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 4 }}>{item.label}</div>
                <p style={{ margin: 0, fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>{item.detail}</p>
              </div>
              <div />
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingTop: 2 }}>
                <StatusBadge kind={item.status} />
              </div>
            </div>
          ))}
        </div>

        {mismatches.length > 0 && (
          <>
            <div style={{ marginTop: 36, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <SectionLabel>{message('mounted.workspace.mismatches')}</SectionLabel>
                <div style={{ marginTop: 2, fontSize: 13, color: T.muted }}>
                  <span style={{ color: T.alert }}>{mismatches.length} open</span> · Bizfile extract vs. intake responses
                </div>
              </div>
              <button
                style={{
                  font: 'inherit',
                  fontSize: 12,
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: `1px solid ${T.rule}`,
                  background: T.card,
                  color: T.inkSoft,
                  cursor: 'pointer'
                }}
              >
                Resolve all
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {mismatches.map((m) => (
                <div
                  key={m.field}
                  style={{
                    background: T.card,
                    border: `1px solid ${T.rule}`,
                    borderRadius: 12,
                    padding: 18,
                    borderInlineStart: `3px solid ${T.alert}`
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{m.field}</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        style={{
                          font: 'inherit',
                          fontSize: 12,
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: `1px solid ${T.rule}`,
                          background: 'transparent',
                          color: T.muted,
                          cursor: 'pointer'
                        }}
                      >
                        Snooze
                      </button>
                      <button
                        style={{
                          font: 'inherit',
                          fontSize: 12,
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: 'none',
                          background: T.ink,
                          color: T.paper,
                          cursor: 'pointer'
                        }}
                      >
                        Resolve
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 24px 1fr', gap: 12, alignItems: 'stretch' }}>
                    <div style={{ padding: '10px 12px', background: D.paper, borderRadius: 8, border: `1px solid ${T.ruleSoft}` }}>
                      <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.mutedSoft, marginBottom: 4 }}>
                        Bizfile
                      </div>
                      <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.5 }}>{m.bizfile}</div>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: T.mutedSoft,
                        fontFamily: T.mono,
                        fontSize: 14
                      }}
                    >
                      ≠
                    </div>
                    <div style={{ padding: '10px 12px', background: D.paper, borderRadius: 8, border: `1px solid ${T.ruleSoft}` }}>
                      <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.mutedSoft, marginBottom: 4 }}>
                        Intake
                      </div>
                      <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.5 }}>{m.intake}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <aside style={{ position: 'sticky', top: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SectionLabel>{message('mounted.workspace.status')}</SectionLabel>

        <div style={{ background: T.card, border: `1px solid ${T.rule}`, borderRadius: 12, padding: 18 }}>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 8 }}>{message('mounted.workspace.complianceReviews')}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 36,
                fontWeight: 500,
                color: openCompliance > 0 ? T.alert : T.ink,
                letterSpacing: '-0.01em'
              }}
            >
              {openCompliance}
            </span>
            <span style={{ fontSize: 12, color: T.muted }}>{message('mounted.workspace.open')}</span>
          </div>
          {counts.total > 0 && (
            <>
              <div style={{ height: 4, background: T.ruleSoft, borderRadius: 2, marginTop: 12, overflow: 'hidden', display: 'flex' }}>
                {counts.complete > 0 && <div style={{ flex: counts.complete, background: T.ok }} />}
                {counts.review > 0 && <div style={{ flex: counts.review, background: T.amber }} />}
                {counts.blocked > 0 && <div style={{ flex: counts.blocked, background: T.alert }} />}
                {counts.pending > 0 && <div style={{ flex: counts.pending, background: 'rgba(46,42,34,0.08)' }} />}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, fontFamily: T.mono, color: T.muted }}>
                <span>{counts.complete} ✓</span>
                <span>{counts.review} review</span>
                <span>{counts.blocked} blocked</span>
                <span>{counts.pending} missing</span>
              </div>
            </>
          )}
        </div>

        <div style={{ background: T.card, border: `1px solid ${T.rule}`, borderRadius: 12, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: T.muted }}>{message('mounted.workspace.intake')}</span>
            <span style={{ fontFamily: T.mono, fontSize: 20, color: T.ink, fontWeight: 500 }}>
              {counts.complete}
              <span style={{ color: T.mutedSoft, fontSize: 14 }}>/{counts.total}</span>
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: counts.pending + counts.blocked > 0 ? T.alert : T.muted }}>
            {message('mounted.workspace.openFields', { count: counts.pending + counts.blocked })}
          </div>
        </div>
      </aside>
    </div>
  );
};

// ── Component shell ──────────────────────────────────────────────────────────

const FirmClientWorkspace = ({
  profile,
  firmId = null,
  firmDataSource = 'local',
  queue = [],
  documents = [],
  transactions = [],
  reconciliationMatches = [],
  clientRules = [],
  transactionReviewQueue = [],
  clientEvidenceRequests = [],
  periodOwnerDecisions = [],
  onActivatePeriodOwnerDecision = null,
  convergenceMetrics = null,
  transactionAiBatch = null,
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  onArtifact,
  onRefreshTransactionIntel,
  onSuggestTransactionCoding,
  onBatchSuggestTransactionCoding,
  onUpdateReconciliationMatch,
  onUpdateClientRule,
  onUpdateTransactionReviewItem,
  onDatabaseSnapshot,
  onRegisterFeedApplyLifecycle,
  onRegisterFeedViewMenu,
  onUpdateTransaction,
  onApproveTransaction,
  onRequestDelete,
  // Per-doc actions for the feed's doc-anchored Open rows (two-surface IA
  // stage D): manual link + delete + the doc artifact's chat, threaded from
  // FirmOpsConsole exactly as the Documents tab received them.
  baseCurrency = '',
  onCreateManualLink = null,
  onChatActionSnapshotApplied = null,
  onDeleteDocument = null,
  // Stage C (C2a): closed-period rows for the Reconciled list's month
  // grouping + locked badges. C2c adds the close_archives rows the Locked
  // badge's receipt artifact renders — both ride the same snapshot thread.
  closePeriods = [],
  closeArchives = [],
  activeTab = 'profile'
}) => {
  const intl = useIntl();
  if (!profile) return null;

  if (activeTab === 'accounting') {
    return (
      <section
        className="firm-workspace firm-workspace--financials"
        aria-label={intl.formatMessage({ id: 'mounted.workspace.bankAria' })}
        style={{
          width: '100%',
          display: 'block'
        }}
      >
        <DonnaFinancialsPanel
          profile={profile}
          firmId={firmId}
          firmDataSource={firmDataSource}
          documents={documents}
          transactions={transactions}
          reconciliationMatches={reconciliationMatches}
          clientRules={clientRules}
          transactionReviewQueue={transactionReviewQueue}
          clientEvidenceRequests={clientEvidenceRequests}
          periodOwnerDecisions={periodOwnerDecisions}
          onActivatePeriodOwnerDecision={onActivatePeriodOwnerDecision}
          convergenceMetrics={convergenceMetrics}
          transactionAiBatch={transactionAiBatch}
          ledgerAccounts={ledgerAccounts}
          ledgerJournals={ledgerJournals}
          ledgerLines={ledgerLines}
          onRefreshTransactionIntel={onRefreshTransactionIntel}
          onSuggestTransactionCoding={onSuggestTransactionCoding}
          onBatchSuggestTransactionCoding={onBatchSuggestTransactionCoding}
          onUpdateReconciliationMatch={onUpdateReconciliationMatch}
          onUpdateClientRule={onUpdateClientRule}
          onUpdateTransactionReviewItem={onUpdateTransactionReviewItem}
          onDatabaseSnapshot={onDatabaseSnapshot}
          onRegisterFeedApplyLifecycle={onRegisterFeedApplyLifecycle}
          onRegisterFeedViewMenu={onRegisterFeedViewMenu}
          onArtifact={onArtifact}
          onUpdateTransaction={onUpdateTransaction}
          onApproveTransaction={onApproveTransaction}
          baseCurrency={baseCurrency}
          onCreateManualLink={onCreateManualLink}
          onChatActionSnapshotApplied={onChatActionSnapshotApplied}
          onDeleteDocument={onDeleteDocument}
          closePeriods={closePeriods}
          closeArchives={closeArchives}
        />
      </section>
    );
  }

  return (
    <section
      className="firm-workspace firm-workspace--bizfile"
      aria-label={intl.formatMessage({ id: 'mounted.workspace.clientAria' })}
      style={{
        color: T.ink,
        fontFamily: T.sans,
        maxWidth: 1180,
        width: '100%',
        marginInline: 'auto',
        display: 'block'
      }}
    >
      {activeTab === 'profile' && (
        <ProfileTab
          profile={profile}
          queue={queue}
          onRequestDelete={onRequestDelete}
          onDatabaseSnapshot={onDatabaseSnapshot}
        />
      )}
      {activeTab === 'people' && (
        <>
          <ClientOwnerAccessCard clientId={profile?.id} enabled={firmDataSource === 'database'} />
          <PeopleTab profile={profile} />
        </>
      )}
    </section>
  );
};

export default FirmClientWorkspace;
