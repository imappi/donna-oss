import { createHash } from 'node:crypto';

import { normalizeLedgerPeriod } from './ledgerReadModel.js';

export const CLOSE_ARCHIVE_SCHEMA_VERSION = 'donna.close_archive.v1';

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const sha256Object = (value) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export const canonicalJsonString = (value) => canonicalJson(value);

const countFor = (value) => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value == null ? 0 : 1;
};

const section = ({ path, type = 'application/json', description, data }) => ({
  path,
  type,
  description,
  checksum_sha256: sha256Object(data),
  count: countFor(data)
});

const stripReadModelGeneratedAt = (value) => {
  if (Array.isArray(value)) return value.map(stripReadModelGeneratedAt);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'generated_at')
        .map(([key, item]) => [key, stripReadModelGeneratedAt(item)])
    );
  }
  return value;
};

const readmeFor = ({ client = {}, period = {}, retention = null } = {}) => [
  `# Donna Close Archive - ${client.company_name || client.companyName || client.id || 'Client'} ${period.period_start} to ${period.period_end}`,
  '',
  'This archive is an accountant-readable export of Donna close evidence for the period.',
  '',
  'Donna is the accounting truth layer for this close package. Xero data is included only as mirror/output evidence.',
  '',
  'Continuity promise: the client should be able to give this package to another accountant without needing Donna.',
  '',
  'Verify integrity by recomputing SHA-256 over each canonical JSON section and comparing it to manifest.json.',
  // Statutory retention commitment (FI-15 G-9): present only when the caller
  // supplies a jurisdiction retention block (Finland: KPL 2:10 via
  // finland/retention.js). The builder stays jurisdiction-agnostic.
  ...(retention ? ['', `Retention commitment (${retention.statute}):`, retention.commitment_fi, retention.commitment_en] : [])
].join('\n');

const compactClient = (client = {}) => ({
  id: client.id || null,
  company_name: client.company_name || client.companyName || client.name || null,
  uen: client.uen || null,
  entity_type: client.entity_type || client.entityType || null,
  jurisdiction: client.jurisdiction ?? null,
  default_currency: client.default_currency || client.defaultCurrency || null
});

const documentManifest = (documents = []) =>
  documents.map((document) => ({
    document_id: document.id,
    filename: document.filename || null,
    document_type: document.document_type || document.type || 'unknown',
    status: document.status || null,
    source: document.source || null,
    file_url: document.file_url || null,
    document_date: document.document_date || null,
    uploaded_at: document.uploaded_at || null,
    metadata_checksum_sha256: sha256Object(document)
  }));

const buildSections = ({
  client = {},
  period,
  ledgerPreview = {},
  closeDiagnostics = {},
  closeExceptions = {},
  documents = [],
  transactions = [],
  transactionReviewQueue = [],
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  closePeriod = null,
  closeChecks = [],
  auditEvents = [],
  retention = null
} = {}) => {
  const entity = compactClient(client);
  const readme = readmeFor({ client: entity, period, retention });
  return {
    readme,
    entity,
    period: {
      period_start: period.period_start,
      period_end: period.period_end,
      close_status: ledgerPreview.close_preview?.status || closePeriod?.status || 'unknown',
      lockable: Boolean(ledgerPreview.close_preview?.lockable),
      locked_at: closePeriod?.locked_at || closePeriod?.payload?.locked_at || null,
      closed_at: closePeriod?.closed_at || null,
      closed_by: closePeriod?.closed_by || null,
      // Additive, only when supplied — absent for non-statutory books so
      // existing archives' checksums and shapes are untouched.
      ...(retention ? { retention } : {})
    },
    ledger: {
      chart_of_accounts: ledgerAccounts,
      journals: ledgerJournals,
      lines: ledgerLines,
      trial_balance: stripReadModelGeneratedAt(ledgerPreview.trial_balance || null),
      profit_and_loss: stripReadModelGeneratedAt(ledgerPreview.profit_and_loss || null),
      cash: stripReadModelGeneratedAt(ledgerPreview.cash || null),
      ledger_period: stripReadModelGeneratedAt(ledgerPreview.ledger_period || null)
    },
    close: {
      close_period: closePeriod,
      checks: closeChecks,
      preview_checks: stripReadModelGeneratedAt(ledgerPreview.close_preview?.checks || []),
      exceptions: stripReadModelGeneratedAt(closeExceptions)
    },
    source: {
      documents,
      document_manifest: documentManifest(documents),
      transactions,
      transaction_review_queue: transactionReviewQueue,
      import_diagnostics: stripReadModelGeneratedAt(closeDiagnostics.source_import || null)
    },
    xero_mirror: {
      summary: stripReadModelGeneratedAt(ledgerPreview.xero_mirror || null),
      diff: stripReadModelGeneratedAt(closeDiagnostics.xero_mirror_diff || null),
      note: 'Xero is a mirror/output adapter. Donna ledger data is the source of accounting truth.'
    },
    audit: {
      events: auditEvents
    }
  };
};

const buildManifest = ({ archiveId, firmId, clientId, generatedAt, generatedBy, period, sections }) => {
  const files = [
    section({
      path: 'README.md',
      type: 'text/markdown',
      description: 'Human-readable explanation of the close archive.',
      data: sections.readme
    }),
    section({
      path: 'entity.json',
      description: 'Client/entity metadata.',
      data: sections.entity
    }),
    section({
      path: 'period.json',
      description: 'Close period metadata and lock state.',
      data: sections.period
    }),
    section({
      path: 'ledger.json',
      description: 'Chart of accounts, journals, ledger lines, trial balance, P&L, and cash summary.',
      data: sections.ledger
    }),
    section({
      path: 'close.json',
      description: 'Close checks and normalized close exceptions.',
      data: sections.close
    }),
    section({
      path: 'source.json',
      description: 'Source documents, imported transactions, classifications, and review queue.',
      data: sections.source
    }),
    section({
      path: 'xero_mirror.json',
      description: 'Xero mirror evidence only; not the accounting source of truth.',
      data: sections.xero_mirror
    }),
    section({
      path: 'audit.json',
      description: 'Audit events relevant to the close period.',
      data: sections.audit
    })
  ];
  const manifest = {
    source: 'donna_close_archive_manifest',
    schema_version: CLOSE_ARCHIVE_SCHEMA_VERSION,
    archive_id: archiveId,
    firm_id: firmId,
    client_id: clientId,
    period_start: period.period_start,
    period_end: period.period_end,
    generated_at: generatedAt,
    generated_by: generatedBy || 'system',
    custody_statement: 'Donna is the source of truth, but never the single point of custody.',
    files
  };
  return {
    ...manifest,
    manifest_checksum_sha256: sha256Object(manifest)
  };
};

export const buildCloseArchivePackage = ({
  archiveId,
  firmId,
  clientId,
  periodStart,
  periodEnd,
  generatedAt = new Date().toISOString(),
  generatedBy = 'system',
  client = {},
  ledgerPreview = {},
  closeDiagnostics = {},
  closeExceptions = {},
  documents = [],
  transactions = [],
  transactionReviewQueue = [],
  ledgerAccounts = [],
  ledgerJournals = [],
  ledgerLines = [],
  closePeriod = null,
  closeChecks = [],
  auditEvents = [],
  retention = null
} = {}) => {
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const sections = buildSections({
    retention,
    client,
    period,
    ledgerPreview,
    closeDiagnostics,
    closeExceptions,
    documents,
    transactions,
    transactionReviewQueue,
    ledgerAccounts,
    ledgerJournals,
    ledgerLines,
    closePeriod,
    closeChecks,
    auditEvents
  });
  const resolvedArchiveId = archiveId ||
    ['close-archive', firmId, clientId, period.period_start, period.period_end, sha256Object(sections).slice(0, 16)]
      .filter(Boolean)
      .join('-')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .slice(0, 180);
  const manifest = buildManifest({
    archiveId: resolvedArchiveId,
    firmId,
    clientId,
    generatedAt,
    generatedBy,
    period,
    sections
  });
  return {
    source: 'close_archive_preview',
    schema_version: CLOSE_ARCHIVE_SCHEMA_VERSION,
    archive_id: resolvedArchiveId,
    firm_id: firmId,
    client_id: clientId,
    period_start: period.period_start,
    period_end: period.period_end,
    generated_at: generatedAt,
    generated_by: generatedBy || 'system',
    manifest_checksum_sha256: manifest.manifest_checksum_sha256,
    manifest,
    sections
  };
};

export const buildCloseArchiveExportBundle = ({
  archive,
  sections = archive?.sections || archive?.payload?.sections || {},
  manifest = archive?.manifest || {},
  storageStatus = archive?.storage_status || archive?.storageStatus || 'not_configured',
  storageDestination = archive?.storage_destination || archive?.storageDestination || null,
  handoff = null
} = {}) => {
  const files = {
    'manifest.json': manifest,
    'README.md': sections.readme || '',
    'entity.json': sections.entity || {},
    'period.json': sections.period || {},
    'ledger.json': sections.ledger || {},
    'close.json': sections.close || {},
    'source.json': sections.source || {},
    'xero_mirror.json': sections.xero_mirror || {},
    'audit.json': sections.audit || {}
  };
  const bundle = {
    source: 'donna_close_archive_export',
    schema_version: archive?.schema_version || manifest?.schema_version || CLOSE_ARCHIVE_SCHEMA_VERSION,
    archive_id: archive?.archive_id || archive?.id || manifest?.archive_id || null,
    client_id: archive?.client_id || manifest?.client_id || null,
    period_start: archive?.period_start || manifest?.period_start || null,
    period_end: archive?.period_end || manifest?.period_end || null,
    generated_at: archive?.generated_at || manifest?.generated_at || null,
    generated_by: archive?.generated_by || manifest?.generated_by || 'system',
    custody_statement: manifest?.custody_statement ||
      'Donna is the source of truth, but never the single point of custody.',
    storage: {
      status: storageStatus,
      destination: storageDestination,
      note: storageDestination
        ? 'Archive bundle is prepared for client-owned storage handoff.'
        : 'Client-owned storage destination is not configured yet.'
    },
    handoff,
    files,
    manifest_checksum_sha256: archive?.manifest_checksum_sha256 ||
      archive?.manifest_checksum ||
      manifest?.manifest_checksum_sha256 ||
      sha256Object(manifest),
    bundle_checksum_sha256: sha256Object(files)
  };
  return {
    ...bundle,
    filename: [
      'donna-close-archive',
      bundle.client_id,
      bundle.period_start,
      bundle.period_end,
      String(bundle.archive_id || '').slice(-12)
    ].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '-') + '.json'
  };
};
