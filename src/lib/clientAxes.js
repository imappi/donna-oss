// Shared constants + helpers for the three client-axis fields stored on
// clients.profile jsonb: services_engaged, jurisdiction, accounting_system.
// Imported by both the firm workspace (FirmClientWorkspace.jsx) and the
// dossier portal (donna-client-portal.jsx) so service ↔ tile mappings,
// service labels, and jurisdiction-aware tile copy live in exactly one
// place.
//
// See docs/jurisdiction-services-accounting-plan.md for the full design.

import {
  ENTITY_TYPE_LABEL,
  ENTITY_TYPES_BY_JURISDICTION,
  legalFormCompatibility
} from './legalForms.js';

export { ENTITY_TYPE_LABEL, ENTITY_TYPES_BY_JURISDICTION } from './legalForms.js';

// ── Services ─────────────────────────────────────────────────────────────────
// services_engaged is the firm's commercial scope for the client. Operator-
// set at intake, no auto-detection. Order here is the canonical display
// order on the firm-side card.
export const SERVICES = [
  {
    id: 'bank_reconciliation',
    labelId: 'mounted.workspace.service.bank',
    descriptionId: 'mounted.workspace.service.bankDesc',
    label: 'Bank reconciliation',
    description: 'We ingest bank statements and reconcile.'
  },
  {
    id: 'sales_invoicing',
    labelId: 'mounted.workspace.service.sales',
    descriptionId: 'mounted.workspace.service.salesDesc',
    label: 'Sales invoicing',
    description: 'We ingest sales invoices and AR.'
  },
  {
    id: 'bills_and_expenses',
    labelId: 'mounted.workspace.service.bills',
    descriptionId: 'mounted.workspace.service.billsDesc',
    label: 'Supplier bills & expenses',
    description: 'We ingest bills, receipts, expense claims.'
  },
  {
    id: 'payroll',
    labelId: 'mounted.workspace.service.payroll',
    descriptionId: 'mounted.workspace.service.payrollDesc',
    label: 'Payroll',
    description: 'We run payroll for them.'
  },
  {
    id: 'loan_tracking',
    labelId: 'mounted.workspace.service.loans',
    descriptionId: 'mounted.workspace.service.loansDesc',
    label: 'Loan tracking',
    description: 'We track loan / lease facilities.'
  },
  {
    id: 'tax_filing',
    labelId: 'mounted.workspace.service.tax',
    descriptionId: 'mounted.workspace.service.taxDesc',
    label: 'Tax filing',
    description: 'We prepare and file tax returns.'
  },
  {
    id: 'compliance_filings',
    labelId: 'mounted.workspace.service.compliance',
    descriptionId: 'mounted.workspace.service.complianceDesc',
    label: 'Compliance filings',
    description: 'Annual return + jurisdiction-specific filings.'
  },
  {
    id: 'secretarial',
    labelId: 'mounted.workspace.service.secretarial',
    descriptionId: 'mounted.workspace.service.secretarialDesc',
    label: 'Secretarial',
    description: 'Corp sec — register of officers, board minutes.'
  },
  {
    id: 'management_accounts',
    labelId: 'mounted.workspace.service.management',
    descriptionId: 'mounted.workspace.service.managementDesc',
    label: 'Management accounts',
    description: 'Periodic management accounts / advisory reporting.'
  }
];

export const SERVICE_IDS = SERVICES.map((s) => s.id);
const SERVICE_ID_SET = new Set(SERVICE_IDS);

// ── Service ↔ tile mapping ──────────────────────────────────────────────────
// The dossier portal renders tiles, not services. Phase 1 covers the five
// services that have a portal tile today; tax_filing / compliance_filings /
// secretarial / management_accounts have no portal counterpart yet — those
// are firm-side workflows. The Xero tile is connector-driven (Phase 3),
// not a service, so it's not in this map.
export const SERVICE_TO_TILE = {
  bank_reconciliation: 'bank',
  sales_invoicing: 'sales',
  bills_and_expenses: 'bills',
  payroll: 'payroll',
  loan_tracking: 'loans'
};

export const TILE_TO_SERVICE = Object.fromEntries(
  Object.entries(SERVICE_TO_TILE).map(([service, tile]) => [tile, service])
);

// ── Reads off the client snapshot ───────────────────────────────────────────
// getFirmSnapshotFromDb spreads `...row.profile` onto the client, so the
// top-level key is the primary path. Nested `profile` is honoured for
// local-demo fixtures.

export const readServicesEngaged = (client = {}) => {
  const fromTop = client?.services_engaged;
  const fromNested = client?.profile?.services_engaged;
  const list = Array.isArray(fromTop) ? fromTop : Array.isArray(fromNested) ? fromNested : null;
  if (!list) return null;
  return list.filter((id) => SERVICE_ID_SET.has(String(id))).map(String);
};

// Legacy applicable_intake_categories — kept for one deploy cycle as a
// read fallback. Operator-set, tile-id valued (not service-id valued).
export const readApplicableIntakeCategoriesLegacy = (client = {}) => {
  const fromTop = client?.applicable_intake_categories;
  const fromNested = client?.profile?.applicable_intake_categories;
  const list = Array.isArray(fromTop) ? fromTop : Array.isArray(fromNested) ? fromNested : null;
  if (!list || !list.length) return null;
  return list.filter(Boolean).map(String);
};

// Portal tile filter — Set of tile ids to render, or null when no filter
// is set (= render every tile, the backward-compat shim documented in
// the plan). Prefers services_engaged; falls back to legacy
// applicable_intake_categories for one deploy cycle.
//
// NOTE: this is the "filter only" view and intentionally collapses the
// explicit-empty and absent cases to null (all tiles). For the Phase 1.5
// new-vs-legacy cohort split use readPortalTileState below.
export const readPortalTileFilter = (client = {}) => {
  const services = readServicesEngaged(client);
  if (services && services.length) {
    const ids = services.map((id) => SERVICE_TO_TILE[id]).filter(Boolean);
    return new Set(ids);
  }
  const legacy = readApplicableIntakeCategoriesLegacy(client);
  if (legacy && legacy.length) {
    return new Set(legacy);
  }
  return null;
};

// Phase 1.5 — cohort-aware portal-tile resolution. Distinguishes three
// states so a freshly-created client isn't silently shown every tile:
//   - 'scoped'   : services_engaged is a non-empty array → render the
//                  mapped tiles (tiles = Set of tile ids).
//   - 'unscoped' : services_engaged is an explicit empty array → the
//                  client exists but hasn't been scoped with the firm
//                  yet. The portal shows a "not scoped yet" placeholder
//                  (no tiles) and the firm card shows a warning. New
//                  clients are created with [] (see createClientInDb), so
//                  this is the new-client state.
//   - 'all'      : services_engaged key absent → legacy / backward-compat
//                  shim. Falls back to applicable_intake_categories when
//                  present, else renders every tile (tiles = null).
//                  Existing clients keep this until backfilled to an
//                  explicit services_engaged.
export const readPortalTileState = (client = {}) => {
  const services = readServicesEngaged(client); // null (absent) | [] | [ids]
  if (Array.isArray(services)) {
    if (services.length === 0) return { mode: 'unscoped', tiles: new Set() };
    const ids = services.map((id) => SERVICE_TO_TILE[id]).filter(Boolean);
    return { mode: 'scoped', tiles: new Set(ids) };
  }
  const legacy = readApplicableIntakeCategoriesLegacy(client);
  if (legacy && legacy.length) {
    return { mode: 'scoped', tiles: new Set(legacy) };
  }
  return { mode: 'all', tiles: null };
};

// ── Jurisdiction-aware tile copy ────────────────────────────────────────────
// Per-jurisdiction title + description for tiles whose copy varies by
// country. Phase 2a populates payroll; other tiles stay jurisdiction-
// neutral for now.
export const TILE_COPY = {
  payroll: {
    sg: {
      title: 'Payroll & CPF',
      desc: 'Only if you paid employees in {periodTitle} — payroll files, CPF statements, payslips.'
    },
    gb: {
      title: 'Payroll & PAYE',
      desc: 'Only if you paid employees in {periodTitle} — PAYE / RTI submissions, payslips.'
    },
    au: {
      title: 'Payroll & STP',
      desc: 'Only if you paid employees in {periodTitle} — STP-finalised payslips, super statements.'
    },
    us: {
      title: 'Payroll & 941',
      desc: 'Only if you paid employees in {periodTitle} — Form 941, W-2 / 1099, state filings.'
    },
    hk: {
      title: 'Payroll & MPF',
      desc: 'Only if you paid employees in {periodTitle} — payroll files, MPF statements, payslips.'
    },
    ae: {
      title: 'Payroll & WPS',
      desc: 'Only if you paid employees in {periodTitle} — WPS payroll files, payslips, gratuity statements.'
    },
    default: {
      title: 'Payroll',
      desc: 'Only if you paid employees in {periodTitle} — payroll files and payslips.'
    }
  }
};

// ── Jurisdiction registry ───────────────────────────────────────────────────
// Storage form: ISO 3166-1 alpha-2 lowercased. UI display label may
// differ — e.g. `gb` renders as "UK" because the product audience says
// "UK" not "GB". The validator (server/donna/clientProfileSchema.js)
// normalises `uk` → `gb` on write so the storage form is ISO-correct.
export const JURISDICTIONS = [
  { code: 'sg', label: 'Singapore' },
  { code: 'us', label: 'United States' },
  { code: 'gb', label: 'United Kingdom', shortLabel: 'UK' },
  { code: 'hk', label: 'Hong Kong' },
  { code: 'au', label: 'Australia' },
  { code: 'nz', label: 'New Zealand' },
  { code: 'my', label: 'Malaysia' },
  { code: 'ca', label: 'Canada' },
  // FI-13 — Finland (the toiminimi book plus, invite-only, the osakeyhtiö).
  { code: 'fi', label: 'Finland' },
  // AE (2026-08-30) — the UAE backend lane.
  { code: 'ae', label: 'United Arab Emirates', shortLabel: 'UAE' }
];

const JURISDICTION_BY_CODE = Object.fromEntries(
  JURISDICTIONS.map((j) => [j.code, j])
);

// ── Entity types ────────────────────────────────────────────────────────────
// Jurisdiction-prefixed so US LLC and SG LLC don't collide. The bounded
// canonical vocabulary and intake aliases live in legalForms.js; unknown forms
// are reported for correction rather than silently persisted.
// Entity-number label is derived from (jurisdiction, entity_type), not
// jurisdiction alone — e.g. US LLCs and C-corps both use EIN but US
// sole proprietors typically don't (SSN or optional EIN); UK sole
// traders register a UTR with HMRC, not a CRN with Companies House.
export const ENTITY_NO_LABEL = {
  'sg-pte': 'UEN', 'sg-llc': 'UEN', 'sg-llp': 'UEN', 'sg-sole-prop': 'UEN',
  'us-llc': 'EIN', 'us-c-corp': 'EIN', 'us-s-corp': 'EIN',
  'us-sole-prop': 'Tax ID',
  'us-partnership': 'EIN',
  'gb-ltd': 'CRN', 'gb-llp': 'CRN',
  'gb-sole-trader': 'UTR',
  'gb-partnership': 'CRN',
  'hk-ltd': 'BR no.',
  'hk-sole-prop': 'BR no.',
  'au-pty-ltd': 'ABN',
  'au-sole-trader': 'ABN',
  'nz-limited': 'NZBN',
  'nz-sole-trader': 'NZBN',
  'my-sdn-bhd': 'SSM no.',
  'my-sole-prop': 'SSM no.',
  'ca-inc': 'Business no.',
  'ca-sole-prop': 'Business no.',
  // Both Finnish forms register a Y-tunnus (business ID) with YTJ.
  'fi-toiminimi': 'Y-tunnus',
  'fi-oy': 'Y-tunnus',
  // Every UAE form holds a trade licence from its licensing authority (an
  // emirate DED or a free zone authority); the TRN is the TAX registration,
  // stored separately — same split as GB's CRN vs VAT number.
  'ae-llc': 'Licence no.',
  'ae-free-zone-co': 'Licence no.',
  'ae-sole-establishment': 'Licence no.'
};

// Registry source line on the firm Profile card.
export const REGISTRY_SOURCE = {
  sg: 'Bizfile · ACRA',
  us: 'Secretary of State',
  gb: 'Companies House',
  hk: 'IRD Companies Registry',
  au: 'ASIC',
  nz: 'NZ Companies Office',
  my: 'SSM',
  ca: 'Corporations Canada',
  fi: 'YTJ · PRH / Verohallinto',
  ae: 'DED · Free zone authority'
};

// Tax label per jurisdiction. Drives the GST / VAT / Sales Tax label
// on tax-related UI surfaces. Null means "no broad-based consumption
// tax" (US is the conspicuous case — sales tax is state-level).
export const TAX_LABEL = {
  sg: 'GST',
  gb: 'VAT',
  au: 'GST',
  nz: 'GST',
  my: 'SST',
  hk: null,
  us: 'Sales Tax', // state-dependent, see jurisdiction_subdivision
  ca: 'GST/HST',
  fi: 'ALV',
  ae: 'VAT'
};

// Entity types whose jurisdiction has an annual-filing ritual that
// the firm side workspace surfaces as the Compliance card. SG sole
// proprietors and US partnerships have their own filing rituals but
// the firm-side card is scoped to the "annual return / confirmation
// statement" cadence — partnerships and sole proprietors are out of
// scope for the card.
export const COMPLIANCE_CARD_ELIGIBLE = new Set([
  'sg-pte', 'sg-llc', 'sg-llp',           // AGM + annual return
  'gb-ltd', 'gb-llp',                      // confirmation statement
  'hk-ltd',                                 // annual return + audit
  'au-pty-ltd',                             // ASIC review
  'nz-limited',                             // annual return
  'my-sdn-bhd',                             // annual return
  'ca-inc'                                  // annual return + state filings
  // US c-corp / s-corp / llc compliance is state-dependent — gated on
  // jurisdiction_subdivision in a future phase. Not eligible yet.
]);

// ── Reads for jurisdiction + entity_type ────────────────────────────────────

export const readJurisdiction = (client = {}) => {
  const fromTop = client?.jurisdiction;
  const fromNested = client?.profile?.jurisdiction;
  const value = typeof fromTop === 'string' ? fromTop : typeof fromNested === 'string' ? fromNested : null;
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (!lower || lower === 'unknown') return null;
  // Normalise the `uk` alias on read so consumers don't have to think
  // about it. Storage form is `gb` per ISO 3166-1; the validator
  // converts on write but historical rows might still carry `uk`.
  if (lower === 'uk') return 'gb';
  return lower;
};

export const readJurisdictionSubdivision = (client = {}) => {
  const fromTop = client?.jurisdiction_subdivision;
  const fromNested = client?.profile?.jurisdiction_subdivision;
  const value = typeof fromTop === 'string' ? fromTop : typeof fromNested === 'string' ? fromNested : null;
  if (!value) return null;
  return value.trim().toLowerCase() || null;
};

export const readEntityType = (client = {}) => {
  const fromTop = client?.entity_type;
  const fromNested = client?.profile?.entity_type;
  const fromCamel = client?.entityType ?? client?.profile?.entityType;
  const value = typeof fromTop === 'string'
    ? fromTop
    : typeof fromNested === 'string'
      ? fromNested
      : typeof fromCamel === 'string' ? fromCamel : null;
  if (!value) return null;
  return value.trim().toLowerCase() || null;
};

// The incorporation date lives in two homes and two spellings: the
// clients.incorporation_date column (surfaced camelCase on the snapshot,
// possibly as a full ISO timestamp once a pg DATE round-trips through JSON)
// and the profile blob (snake_case from the profile-patch route, camelCase
// from the provision path). Normalise to YYYY-MM-DD or null.
export const readIncorporationDate = (client = {}) => {
  const candidates = [
    client?.incorporation_date,
    client?.incorporationDate,
    client?.profile?.incorporation_date,
    client?.profile?.incorporationDate
  ];
  const value = candidates.find((entry) => typeof entry === 'string' && entry.trim());
  return value ? value.trim().slice(0, 10) : null;
};

// GB incorporated forms derive their accounting reference period from the
// incorporation date (server: resolveGbFiscalYearForEntity refuses a ltd/llp
// without one — GB_ACCOUNTING_PERIOD_REQUIRES_PERSISTED). Capturing the form
// without the date would flip those clients from the legacy calendar fallback
// straight into that refusal, so the capture card collects both together.
export const ENTITY_TYPES_REQUIRING_INCORPORATION_DATE = Object.freeze(['gb-ltd', 'gb-llp']);

export const entityTypeRequiresIncorporationDate = (entityType) =>
  ENTITY_TYPES_REQUIRING_INCORPORATION_DATE.includes(entityType);

// The registry-first legal forms: statute cannot derive their fiscal period
// from the calendar alone. An fi-oy tilikausi is off-calendar-capable
// (FISCAL_YEAR_OY_REQUIRES_PERSISTED_PERIOD); a UK company's accounting
// reference period is set per company and a PERSISTED row is what the
// opening-balance lane requires. Sole traders / toiminimi / partnerships
// resolve from statute (calendar / 6-April) and are never asked — "asks only
// when you're needed."
export const ENTITY_TYPES_REQUIRING_EXPLICIT_FISCAL_PERIOD = Object.freeze(['fi-oy', 'gb-ltd', 'gb-llp', 'ae-llc']);

export const entityTypeRequiresExplicitFiscalPeriod = (entityType) =>
  ENTITY_TYPES_REQUIRING_EXPLICIT_FISCAL_PERIOD.includes(entityType);

// Drives the portal's entity-type capture card. Show when the client's
// jurisdiction has a declared legal-form vocabulary and the stored
// entity_type is not canonical in it — which covers missing, free-form
// legacy strings ("limited company"), non-prefixed FI legacy forms
// ('toiminimi' — the explicit fi-* backfill finland/entity.js names as the
// prerequisite for its fail-closed stage), and a form belonging to another
// jurisdiction. A jurisdiction without a vocabulary never shows the card.
export const entityTypeCaptureState = (client = {}) => {
  const jurisdiction = readJurisdiction(client);
  const options = ENTITY_TYPES_BY_JURISDICTION[jurisdiction] || [];
  const storedEntityType = readEntityType(client);
  const compatibility = legalFormCompatibility({ jurisdiction, entityType: storedEntityType });
  return {
    show: options.length > 0 && compatibility.status !== 'canonical',
    jurisdiction,
    options,
    storedEntityType,
    compatibilityStatus: compatibility.status,
    suggestedEntityType: compatibility.status === 'alias' ? compatibility.canonical : null,
    incorporationDate: readIncorporationDate(client)
  };
};

// ── Detector reads (server-written, never operator-written) ─────────────────
// Phase 2b — the bank-statement detector writes these onto the profile
// jsonb. The FE surfaces them on the "Confirm jurisdiction" warning so
// the operator gets a one-click confirm instead of starting blank.

export const readJurisdictionDetected = (client = {}) => {
  const fromTop = client?.jurisdiction_detected;
  const fromNested = client?.profile?.jurisdiction_detected;
  const value = typeof fromTop === 'string' ? fromTop : typeof fromNested === 'string' ? fromNested : null;
  if (!value) return null;
  return value.trim().toLowerCase() || null;
};

export const readJurisdictionDetectedConfidence = (client = {}) => {
  const fromTop = client?.jurisdiction_detected_confidence;
  const fromNested = client?.profile?.jurisdiction_detected_confidence;
  const value = typeof fromTop === 'string' ? fromTop : typeof fromNested === 'string' ? fromNested : null;
  if (!value) return null;
  return value.trim().toLowerCase() || null;
};

// Returns the most recent entry from the jurisdiction_signals ring
// buffer, or null when none exists. The list is append-ordered;
// entries are bounded server-side via JURISDICTION_SIGNAL_RING_SIZE.
export const readLatestJurisdictionSignal = (client = {}) => {
  const fromTop = client?.jurisdiction_signals;
  const fromNested = client?.profile?.jurisdiction_signals;
  const list = Array.isArray(fromTop) ? fromTop : Array.isArray(fromNested) ? fromNested : null;
  if (!list || !list.length) return null;
  return list[list.length - 1] || null;
};

// Server-stamped on the snapshot when the operator confirms a
// jurisdiction (jurisdiction_confirmed_by / _at; see firmDb's
// stampProfileProvenance). Read-only for the FE — operator writes to
// these keys are 400'd by clientProfileSchema. Returns `{ by, at }` only
// when at least one is set; either field may be null in isolation (a
// system-initiated write can record `at` without a known `by`).
const readPair = (client, byKey, atKey) => {
  const byFromTop = client?.[byKey];
  const byFromNested = client?.profile?.[byKey];
  const atFromTop = client?.[atKey];
  const atFromNested = client?.profile?.[atKey];
  const by = typeof byFromTop === 'string' ? byFromTop : typeof byFromNested === 'string' ? byFromNested : null;
  const at = typeof atFromTop === 'string' ? atFromTop : typeof atFromNested === 'string' ? atFromNested : null;
  if (!by && !at) return null;
  return { by: by || null, at: at || null };
};

export const readJurisdictionConfirmation = (client = {}) =>
  readPair(client, 'jurisdiction_confirmed_by', 'jurisdiction_confirmed_at');

// Server-stamped on the snapshot when the operator writes
// services_engaged (services_engaged_set_by/_at; see firmDb's
// stampProfileProvenance). Same `{ by, at }` shape as the jurisdiction
// + accounting_system readers. Stamped for any operator write —
// including an explicit empty list (the "not scoped yet" state from
// Phase 1.5), because choosing nothing IS still a deliberate choice.
export const readServicesEngagedProvenance = (client = {}) =>
  readPair(client, 'services_engaged_set_by', 'services_engaged_set_at');

// ── Accounting system (downstream connector) ────────────────────────────────
// accounting_system is the operator's chosen downstream connector for the
// client's books: 'xero' | 'qbo' | 'none'. Operator-set on the Profile tab,
// validated server-side (clientProfileSchema.js). Connection STATUS is never
// cached here — it's derived at snapshot read time from xero_connections.status
// and surfaced as client.accounting_system_connection (see
// getFirmSnapshotFromDb). The profile only stores the chosen connector + its
// provenance (set_at).
export const ACCOUNTING_SYSTEMS = [
  {
    id: 'xero',
    labelId: 'mounted.workspace.accountingSystem.xero',
    label: 'Xero',
    available: true,
    // Portal connector-tile copy when this system is chosen but not yet
    // connected. Null connector = no portal tile (Donna ledger only).
    connector: {
      title: 'Xero access',
      desc: "Existing Xero login or invite me as advisor — or mark it n/a and I'll set one up for you.",
      dismissedDesc: "You marked this as not applicable — I'll set up Xero for you.",
      cta: 'Connect Xero',
      dismissLabel: 'No Xero yet'
    }
  },
  {
    id: 'qbo',
    labelId: 'mounted.workspace.accountingSystem.qbo',
    label: 'QuickBooks Online',
    // Connect (2.1a), reference sync (2.1b) AND ledger→JournalEntry writeback
    // (2.1c — writeback/batch/retry/verify) are all live. `available` stays false
    // until the writeback path is validated against the live QBO sandbox and
    // deliberately flipped to GA (2.1d). The card gates selectability +
    // connect/disconnect/sync/mirror on `connectable`; the "fully wired" badge on
    // `available`.
    available: false,
    connectable: true,
    connector: {
      title: 'QuickBooks access',
      desc: 'Invite me to your QuickBooks Online company as an accountant user.',
      dismissedDesc: 'You marked this as not applicable.',
      cta: 'Connect QuickBooks',
      dismissLabel: 'No QuickBooks yet'
    }
  },

  {
    id: 'procountor',
    labelId: 'mounted.workspace.accountingSystem.procountor',
    label: 'Procountor',
    region: 'Finland',
    available: false,
    connectable: true,
    helperText: 'Capability trial connector: connectable for validation, not GA for served geographies.',
    badge: 'Capability trial'
  },
  {
    id: 'none',
    labelId: 'mounted.workspace.accountingSystem.none',
    label: 'None yet',
    available: true,
    connector: null // Donna ledger only — no external connector tile.
  }
];

const ACCOUNTING_SYSTEM_BY_ID = Object.fromEntries(
  ACCOUNTING_SYSTEMS.map((a) => [a.id, a])
);

// Connector inherited when accounting_system is unset. Phase 3a keeps the
// historical hardcoded-Xero assumption for one deploy cycle so existing SG
// clients keep their connector tile until an operator picks explicitly.
export const DEFAULT_ACCOUNTING_SYSTEM = 'xero';

// Connection statuses, mirrored from the xero_connections CHECK constraint.
export const ACCOUNTING_CONNECTION_STATUSES = ['connected', 'disconnected', 'expired', 'error'];

export const readAccountingSystem = (client = {}) => {
  const fromTop = client?.accounting_system;
  const fromNested = client?.profile?.accounting_system;
  const value = typeof fromTop === 'string' ? fromTop : typeof fromNested === 'string' ? fromNested : null;
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  return ACCOUNTING_SYSTEM_BY_ID[lower] ? lower : null;
};

// Server-derived connection status, joined from xero_connections at snapshot
// read time (never cached on the profile). Shape:
//   { status, connection_id, tenant_name, last_synced_at, last_error }
// Null when no connection row exists for the client.
export const readAccountingSystemConnection = (client = {}) => {
  const fromTop = client?.accounting_system_connection;
  const fromNested = client?.profile?.accounting_system_connection;
  const value = fromTop && typeof fromTop === 'object' && !Array.isArray(fromTop)
    ? fromTop
    : fromNested && typeof fromNested === 'object' && !Array.isArray(fromNested)
      ? fromNested
      : null;
  if (!value || typeof value.status !== 'string' || !value.status) return null;
  return value;
};

export const isAccountingSystemConnected = (client = {}) => {
  const conn = readAccountingSystemConnection(client);
  return Boolean(conn && conn.status === 'connected');
};

// Server-stamped on the snapshot when the operator picks an
// accounting_system (accounting_system_set_by / _at; see firmDb's
// stampProfileProvenance). Same shape + null-handling as
// readJurisdictionConfirmation.
export const readAccountingSystemProvenance = (client = {}) =>
  readPair(client, 'accounting_system_set_by', 'accounting_system_set_at');

export const accountingSystemLabel = (id) => {
  if (!id) return null;
  return ACCOUNTING_SYSTEM_BY_ID[id]?.label || id;
};

// Neutral connector copy for a client who has NOT chosen an accounting system
// yet (the self-serve default). The per-system copy presumes one platform, so
// for the unset case we offer Xero OR QuickBooks and don't presume Xero. Most
// self-serve owners mark it n/a and we set one up.
export const DEFAULT_CONNECTOR = {
  title: 'Xero or QuickBooks access',
  desc: "Already on Xero or QuickBooks? Connect it. If not, mark it n/a and I'll set one up for you.",
  dismissedDesc: "You marked this as not applicable — I'll set up your books for you.",
  cta: 'Connect',
  dismissLabel: "I don't have one yet"
};

// Portal connector-tile descriptor, or null when no connector tile should
// render. Decoupled from the service→tile filter — connecting the books is
// orthogonal to which document piles the firm collects. Rules:
//   - connection status 'connected' → null (the tile has done its job).
//   - accounting_system UNSET → neutral "Xero or QuickBooks access" copy (a
//     self-serve owner never chose a system; don't presume Xero).
//   - accounting_system 'none' → null (Donna ledger only).
//   - otherwise → the chosen system's connector copy.
// The tile keeps id 'xero' so the portal's dismissed_tiles persistence stays
// stable across systems.
export const accountingConnectorTile = (client = {}) => {
  if (isAccountingSystemConnected(client)) return null;
  const explicit = readAccountingSystem(client);
  if (!explicit) {
    return { id: 'xero', system: DEFAULT_ACCOUNTING_SYSTEM, ...DEFAULT_CONNECTOR };
  }
  const def = ACCOUNTING_SYSTEM_BY_ID[explicit];
  if (!def || !def.connector) return null;
  return { id: 'xero', system: explicit, ...def.connector };
};

// ── Display-label helpers ───────────────────────────────────────────────────

export const jurisdictionDisplayLabel = (code) => {
  if (!code) return null;
  const j = JURISDICTION_BY_CODE[code];
  if (!j) return code.toUpperCase();
  return j.shortLabel || j.label;
};

export const jurisdictionLongLabel = (code) => {
  if (!code) return null;
  const j = JURISDICTION_BY_CODE[code];
  return j ? j.label : code.toUpperCase();
};

export const entityTypeLabel = (entityType) => {
  if (!entityType) return null;
  return ENTITY_TYPE_LABEL[entityType] || entityType;
};

// Entity-number label. Falls back to a neutral "Entity number" when
// the (jurisdiction, entity_type) pair is unknown — same fallback as
// for `unknown` jurisdiction.
export const entityNumberLabel = (entityType) => {
  if (entityType && ENTITY_NO_LABEL[entityType]) return ENTITY_NO_LABEL[entityType];
  return 'Entity number';
};

export const registrySourceFor = (jurisdiction) => {
  if (jurisdiction && REGISTRY_SOURCE[jurisdiction]) return REGISTRY_SOURCE[jurisdiction];
  return 'Manual entry';
};

export const taxLabelFor = (jurisdiction) => {
  if (!jurisdiction) return null;
  return TAX_LABEL[jurisdiction] || null;
};

export const payrollTileCopy = (jurisdiction) => {
  const code = jurisdiction || 'default';
  return TILE_COPY.payroll[code] || TILE_COPY.payroll.default;
};

// Compliance card render condition — three clauses per the plan:
//   1. services_engaged includes 'compliance_filings'
//   2. jurisdiction is set (not null / 'unknown')
//   3. entity_type is in COMPLIANCE_CARD_ELIGIBLE for that jurisdiction
// Centralised here so the workspace + portal stay aligned on
// when the card surfaces.
export const shouldRenderComplianceCard = ({ services, jurisdiction, entityType } = {}) => {
  if (!services || !services.includes('compliance_filings')) return false;
  if (!jurisdiction) return false;
  if (!entityType) return false;
  return COMPLIANCE_CARD_ELIGIBLE.has(entityType);
};
