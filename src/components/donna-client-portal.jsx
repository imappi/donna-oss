import { summarizePortalDocuments } from '../lib/portalDocumentReceipt.js';
import AeOpeningBalances from './ae-opening-balances.jsx';
// Donna Client Portal redesign — owner-facing intake.
// Direct port of project/Client Portal.html from the design bundle: single
// column, big drop zone, six-tile checklist, activity feed with batched
// receipt questions, and a reply modal (Photo / Note / Forward email).
//
// UI-first shell with a BE-wired evidence loop: real client evidence requests
// render when database mode is active; mock questions remain only for local
// demo mode.

import { useState, useEffect, useMemo, useRef } from 'react';
import { useIntl } from 'react-intl';

import { BidiText, FormattedValue, IdentifierText } from '../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';
import { PRODUCTION_INTERFACE_LOCALES } from '../i18n/localeRegistry.js';
import {
  PORTAL_DOCUMENT_TYPE_MESSAGE_IDS,
  PORTAL_LEGAL_FORM_MESSAGE_IDS
} from '../i18n/catalogs/remainingSurfaces.en.js';
import { D } from './shared/design-tokens.js';
import {
  resolveClientEvidenceRequest,
  registerFirmDocuments,
  updateFirmClientProfile,
  connectXero,
  downloadFirmDocument,
  formatFirmError
  , fetchWhatsAppBindingState, createWhatsAppConnectToken, revokeWhatsAppBinding, fetchFiscalPeriods, registerFiscalPeriod, fetchTelegramBindingState, createTelegramConnectToken, revokeTelegramBinding, fetchOwnerVatReturn
} from '../lib/firmApi.js';
import { clearFirmAccess } from '../lib/accessToken.js';
import { getBookSessionIdentity } from '../lib/bookSessionIdentity.js';
import { buildDocumentRecord, classifyDocumentFile, DOCUMENT_TYPE_LABELS, getClientUploadStatus } from '../lib/firmDocuments.js';
import { uploadEvidenceObject } from '../lib/evidenceStorage.js';
import { mapWithConcurrency, UPLOAD_CONCURRENCY } from '../lib/uploadConcurrency.js';
import { requireEveryEvidenceFile, requireEveryRegistration } from '../lib/evidenceReply.js';
import { JURISDICTIONS, readPortalTileState, readJurisdiction, readEntityType, readAccountingSystem, accountingConnectorTile, entityTypeCaptureState, entityTypeRequiresIncorporationDate, entityTypeRequiresExplicitFiscalPeriod, entityTypeLabel } from '../lib/clientAxes.js';
import { channelConnectPending, deriveSetupWizard, jurisdictionCaptureState, persistedClientIdentity, entityTypeIdentityConflict } from '../lib/onboardingSetup.js';
import { ownerVatReturnCardState } from '../lib/gbVatReturnView.js';
import { deriveClientPortalPeriod } from '../lib/clientPortalPeriod.js';
import {
  setRowRegistered,
  loadTrayState,
  registrationRequiresFreshUpload,
  setRowRegisterFailed,
  setRowUploaded,
  setRowUploadFailed,
  startTrayBatch
} from '../lib/uploadTray.js';
import UploadTray from './UploadTray.jsx';
import ClientReports from './donna-client-reports.jsx';
import ClientBookInspection from './client-book-inspection.jsx';
import ClientPortalChatPanel from './ClientPortalChatPanel.jsx';

const QUESTIONS = [
  { id: 'q1', kind: 'Receipt', desc: 'CITY GYM, LISBON · Card **1111', date: '2026-10-14', amount: 9.15, currency: 'EUR', card: '**1111', tag: 'café' },
  { id: 'q2', kind: 'Receipt', desc: 'CITY GYM, LISBON · Card **1111', date: '2026-10-12', amount: 34.20, currency: 'EUR', card: '**1111', tag: 'café' },
  { id: 'q3', kind: 'Receipt', desc: 'CAFÉ AURORA · Card **1111', date: '2026-10-13', amount: 6.8, currency: 'EUR', card: '**1111', tag: 'café' },
  { id: 'q4', kind: 'FX', desc: 'Conversion buy USD 1,000 — confirm rate', date: '2026-10-10', amount: 12.5, currency: 'EUR', card: null, tag: 'fx' },
  { id: 'q5', kind: 'Receipt', desc: 'METRO LISBOA · Card **1111', date: '2026-10-07', amount: 11.4, currency: 'EUR', card: '**1111', tag: 'transport' },
  { id: 'q6', kind: 'Receipt', desc: 'PADARIA ROSA · Card **1111', date: '2026-10-06', amount: 13.25, currency: 'EUR', card: '**1111', tag: 'café' },
  { id: 'q7', kind: 'Receipt', desc: 'PADARIA CENTRAL · Card **1111', date: '2026-10-05', amount: 9.6, currency: 'EUR', card: '**1111', tag: 'café' }
];

const openEvidenceStatuses = new Set(['draft', 'open']);
const MAX_EVIDENCE_FILE_BYTES = 6 * 1024 * 1024;
const MAX_EVIDENCE_UPLOAD_BYTES = 7 * 1024 * 1024;

const formatFileSize = (size = 0, formatMessage = null) => {
  const numeric = Number(size || 0);
  const message = (id, values, fallback) => typeof formatMessage === 'function'
    ? formatMessage({ id }, values)
    : fallback;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return message('portal.file.size.zero', {}, '0 KB');
  }
  if (numeric >= 1024 * 1024) {
    const sizeInMb = Number((numeric / (1024 * 1024)).toFixed(1));
    return message('portal.file.size.megabytes', { size: sizeInMb }, `${sizeInMb} MB`);
  }
  const sizeInKb = Math.max(1, Math.round(numeric / 1024));
  return message('portal.file.size.kilobytes', { size: sizeInKb }, `${sizeInKb} KB`);
};

const fileToDataUrl = (file, readError = 'Could not read uploaded file.') =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(readError));
    reader.readAsDataURL(file);
  });

// ── § 03 "Your uploads" helpers (DB mode) ───────────────────────────────
// Pure presentation. The list reads live `documents` rows scoped to the
// client; these only format what's already there — no inference.

// "30 Apr 2025" — the year is included because this is a historical list
// that can span years, unlike the live tray's same-session timestamps.
const formatUploadDate = (value, formatter = null) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (typeof formatter === 'function') {
    const calendarDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return formatter(calendarDate, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// Short type badge from the filename extension (PDF / JPG / CSV …). The
// documents table carries no per-file size column, so the badge is just
// the type, falling back to DOC when there's no recognizable extension.
const fileExtensionBadge = (filename = '') => {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'DOC';
  return name.slice(dot + 1, dot + 5).toUpperCase();
};

// Plain-language document type. DOCUMENT_TYPE_LABELS covers the common
// vocabulary; anything outside it (e.g. a newer code-table type) is
// humanized from the raw value rather than mislabelled "Needs sorting".
const humanizeDocumentType = (type) => {
  const raw = String(type || '').trim();
  if (!raw) return 'Document';
  return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ');
};

// Persisted-verdict tone → dossier colour. The D palette is paper + ink +
// warm only (no red), so attention states (reading / couldn't read) use the
// warm accent, resolved (filed) uses ink, and quiet states (received / on
// file) use muted ink. Mirrors UploadTray's TONE_STYLES_DOSSIER vocabulary.
const UPLOAD_STATUS_TONE_COLOR = {
  pending: D.inkMute,
  progress: D.accentWarmFlat,
  success: D.ink,
  error: D.accentWarmFlat,
  warning: D.accentWarmFlat,
  muted: D.inkMute
};

const dataUrlToPayload = (dataUrl = '', fallbackMime = '') => {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
  return {
    mimeType: match?.[1] || fallbackMime || '',
    base64: match?.[2] || String(dataUrl).split(',').pop() || ''
  };
};

const compressImageFile = async (file, formatMessage = null) => {
  const message = (id, fallback) => typeof formatMessage === 'function'
    ? formatMessage({ id })
    : fallback;
  const dataUrl = await fileToDataUrl(file, message('portal.error.fileRead', 'Could not read uploaded file.'));
  const imageType = String(file?.type || '').toLowerCase();
  const canCanvasCompress = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(imageType);
  if (!canCanvasCompress || file.size < 900 * 1024) {
    return dataUrlToPayload(dataUrl, file?.type);
  }

  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(message('portal.error.imagePrepare', 'Could not prepare image for upload.')));
    img.src = dataUrl;
  });
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(image.width || maxSide, image.height || maxSide));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((image.width || maxSide) * scale));
  canvas.height = Math.max(1, Math.round((image.height || maxSide) * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return dataUrlToPayload(canvas.toDataURL('image/jpeg', 0.82), 'image/jpeg');
};

const formatMoney = (amount, currency = 'EUR', formatter = null) => {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric) || numeric === 0) return '';
  if (typeof formatter === 'function') return formatter(numeric, { currency: currency || 'EUR' });
  return `${numeric.toFixed(2)} ${currency || 'EUR'}`;
};

const formatShortDate = (value, formatter = null) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  if (typeof formatter === 'function') {
    const calendarDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return formatter(calendarDate, { day: '2-digit', month: 'short', year: undefined });
  }
  return String(value).slice(0, 10);
};

// Period label/title formatting + the books-vs-evidence-request derivation
// now live in ../lib/clientPortalPeriod.js (deriveClientPortalPeriod), so the
// "is this month a chosen close target or just the newest bank line?" rule is
// unit-tested. formatPeriodKey below stays here — it keys persisted state to
// the CALENDAR month, deliberately, not to the books' period.

// Stable YYYY-MM key for persisted per-period state (dismissed tiles).
// Locale-agnostic and sortable — June 2026 becomes "2026-06" regardless
// of the device's date locale.
const formatPeriodKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

// Compact relative time for the "last from Kari" strip. Falls back to a
// localized short date once we're past a week — the dossier label space
// is tight and "23 days ago" reads worse than "16 May".
const formatRelativeContact = (value, { formatMessage = null, formatDate = null } = {}) => {
  if (!value) return '';
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return '';
  const diffMs = Date.now() - then.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor(diffMs / dayMs);
  const message = (id, values, fallback) => typeof formatMessage === 'function'
    ? formatMessage({ id }, values)
    : fallback;
  if (diffMs < 0) return message('portal.relative.justNow', {}, 'Just now');
  if (diffMs < 60 * 60 * 1000 || days === 0) return message('portal.relative.today', {}, 'Today');
  if (days === 1) return message('portal.relative.yesterday', {}, 'Yesterday');
  if (days < 7) return message('portal.relative.daysAgo', { count: days }, `${days} days ago`);
  return formatUploadDate(then, formatDate);
};

const EVIDENCE_KIND_MESSAGE_IDS = Object.freeze({
  Statement: 'portal.evidence.kind.statement',
  Payment: 'portal.evidence.kind.payment',
  Receipt: 'portal.evidence.kind.receipt',
  Purpose: 'portal.evidence.kind.purpose',
  Evidence: 'portal.evidence.kind.evidence'
});

const PORTAL_PARSE_STATUS_MESSAGE_IDS = Object.freeze({
  pending: 'portal.parseStatus.received',
  processing: 'portal.parseStatus.reading',
  completed: 'portal.parseStatus.filed',
  failed: 'portal.parseStatus.couldNotRead',
  skipped: 'portal.parseStatus.onFile',
  duplicate_pending: 'portal.parseStatus.duplicate'
});

const PORTAL_VAT_BLOCKER_MESSAGE_IDS = Object.freeze({
  GB_VAT_REGISTRATION_NOT_ESTABLISHED: 'portal.vat.blocker.registrationMissing',
  GB_VAT_REGISTRATION_PARTIAL_PERIOD: 'portal.vat.blocker.partialPeriod'
});

const evidenceKind = (request = {}) => {
  const type = String(request.evidence_type || request.request_payload?.evidence_type || '').toLowerCase();
  if (/statement/.test(type)) return 'Statement';
  // Doc-first drain (Slice 3): "how was this paid?" asks for a receipt with
  // no bank line. documentTypeForQuestion leaves the upload's type alone.
  if (/payment|method/.test(type)) return 'Payment';
  if (/receipt|document|support/.test(type)) return 'Receipt';
  if (/fx|rate/.test(type)) return 'FX';
  if (/purpose/.test(type)) return 'Purpose';
  return 'Evidence';
};


const evidenceTopicSummary = (request = {}) => {
  const topic = request.request_payload?.evidence_topic;
  if (!topic || typeof topic !== 'object' || topic.status !== 'open') return null;
  const assessment = topic.last_assessment && typeof topic.last_assessment === 'object' ? topic.last_assessment : null;
  const turns = Array.isArray(topic.turns) ? topic.turns : [];
  const lastTurn = turns.at(-1) || null;
  const outcome = String(assessment?.outcome || lastTurn?.outcome || '').replace(/_/g, ' ');
  return {
    status: 'open',
    channel: topic.channel || null,
    outcome: outcome || null,
    lastReplyExcerpt: lastTurn?.reply_excerpt || null,
    lastOwnerMessageAt: topic.last_owner_message_at || null,
    currentNeed: topic.current_need || request.question || null
  };
};

const buildQuestionFromEvidenceRequest = (request = {}, formatters = {}) => {
  const payload = request.request_payload || {};
  const message = (id, values, fallback) => typeof formatters.formatMessage === 'function'
    ? formatters.formatMessage({ id }, values)
    : fallback;
  const question = request.question
    || payload.evidence_request?.question
    || message('portal.evidence.confirmTransaction', {}, 'Please confirm this transaction.');
  const amount = payload.amount ?? payload.transaction_amount;
  const currency = payload.currency || 'EUR';
  const date = payload.date || request.due_at || request.created_at || request.updated_at;
  // Counterpart-statement requests anchor on the TRANSFER line (so the
  // reply threads to a transaction), but the thing being requested is
  // the OTHER account's statement. Headlining the anchor's description
  // ("ONLINE TRANSFER TO CHECKING 0760549…") reads absurd to the client
  // — that line is literally on the statement they already sent. Lead
  // with the requested account instead; the anchor's date/amount stay
  // as context for finding the transfer.
  const kind = evidenceKind(request);
  const accountReference = String(payload.account_reference || '').trim();
  const anchorDescription = payload.transaction_description || payload.description || question;
  return {
    id: request.id,
    evidence_request_id: request.id,
    transaction_id: request.transaction_id || payload.transaction_id || null,
    kind,
    desc: kind === 'Statement' && accountReference
      ? message('portal.evidence.statementFor', { period: accountReference }, `Statement for ${accountReference}`)
      : anchorDescription,
    text: question,
    when: formatShortDate(date, formatters.formatDate),
    amt: formatMoney(amount, currency, formatters.formatAmount),
    card: payload.card || null,
    tag: request.evidence_type || 'evidence',
    status: request.status,
    due_at: request.due_at || null,
    topic: evidenceTopicSummary(request)
  };
};

const documentTypeForQuestion = (question = {}, fallback = 'unknown') => {
  const kind = String(question.kind || question.tag || '').toLowerCase();
  if (kind.includes('receipt')) return 'receipt';
  if (kind.includes('purpose')) return fallback === 'unknown' ? 'receipt' : fallback;
  return fallback;
};


// Build a document record and PUT bytes to Supabase Storage. The
// returned `document` carries enough metadata to register against the
// async-parse pipeline (storage_bucket / storage_object_key / checksum)
// and to render locally before the BE confirms the row. Synchronous
// statement extraction has been removed — the worker handles it; the
// upload tray surfaces progress and lands the parsed transactions in
// the firm console as soon as parsing completes.
const buildEvidenceDocument = async ({ file, clientId, question, reply, index = 0, trayRowId, formatMessage = null }) => {
  if (!file) return null;
  if (file.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(typeof formatMessage === 'function'
      ? formatMessage(
          { id: 'portal.error.fileTooLarge' },
          { filename: file.name || 'File', limit: formatFileSize(MAX_EVIDENCE_FILE_BYTES, formatMessage) }
        )
      : `${file.name || 'File'} is larger than ${formatFileSize(MAX_EVIDENCE_FILE_BYTES)}.`);
  }
  const base = buildDocumentRecord(file, clientId, { index, uploadedAt: Date.now() });
  const prepared = await compressImageFile(file, formatMessage);
  const filenameGuessedType = documentTypeForQuestion(question, base.document_type);
  const filename = file.name || base.filename;
  const mimeType = prepared.mimeType || file.type || base.mime_type || 'application/octet-stream';
  let stored;
  try {
    stored = await uploadEvidenceObject({
      clientId,
      evidenceRequestId: question?.evidence_request_id || null,
      transactionId: question?.transaction_id || null,
      filename,
      base64: prepared.base64,
      mimeType
    });
  } catch (uploadErr) {
    if (trayRowId) {
      setRowUploadFailed({
        rowId: trayRowId,
        message: uploadErr?.message || (typeof formatMessage === 'function'
          ? formatMessage({ id: 'portal.error.upload' })
          : 'Upload failed.')
      });
    }
    throw uploadErr;
  }
  if (trayRowId) {
    setRowUploaded({
      rowId: trayRowId,
      storageBucket: stored.bucket,
      storageObjectKey: stored.key,
      checksum: stored.checksum_sha256,
          storedSize: stored.size,
          mimeType: stored.content_type
    });
  }

  // Filename hint is enough for an initial classification — the worker
  // will upgrade to `bank_statement` if its extractor recognises the
  // file. Async parsing means we don't need the speculative inline
  // extraction call any more (see PR 2 of docs/async-parsing-plan.md).
  const documentType = filenameGuessedType;

  const document = {
    ...base,
    document_type: documentType,
    document_label: DOCUMENT_TYPE_LABELS[documentType] || base.document_label || DOCUMENT_TYPE_LABELS.unknown,
    status: 'needs_review',
    source: question?.evidence_request_id ? 'client_evidence_reply' : 'client_upload',
    evidence_request_id: question?.evidence_request_id || null,
    transaction_id: question?.transaction_id || null,
    client_reply: reply || '',
    file_url: null,
    file_storage: {
      mode: 'object_storage',
      provider: stored.provider,
      bucket: stored.bucket,
      key: stored.key,
      checksum_sha256: stored.checksum_sha256,
      filename,
      mime_type: stored.content_type,
      size: stored.size,
      note: 'Client-uploaded evidence file stored in Supabase object storage; Donna stores only metadata and checksum.'
    },
    storage_provider: stored.provider,
    storage_bucket: stored.bucket,
    storage_object_key: stored.key,
    storage_key: stored.key,
    checksum_sha256: stored.checksum_sha256,
    file_size: stored.size,
    mime_type: stored.content_type,
    evidence_context: {
      request_id: question?.evidence_request_id || null,
      transaction_id: question?.transaction_id || null,
      question: question?.text || '',
      reply: reply || ''
    },
    donna_note: 'Client uploaded this file as supporting evidence for a close request.'
  };

  return document;
};

const assertUploadBatchSize = (files = [], formatMessage = null) => {
  const total = Array.from(files).reduce((sum, file) => sum + Number(file?.size || 0), 0);
  if (total > MAX_EVIDENCE_UPLOAD_BYTES) {
    throw new Error(typeof formatMessage === 'function'
      ? formatMessage(
          { id: 'portal.evidence.uploadTooLarge' },
          { limit: formatFileSize(MAX_EVIDENCE_UPLOAD_BYTES, formatMessage) }
        )
      : `Upload is larger than ${formatFileSize(MAX_EVIDENCE_UPLOAD_BYTES)}. Send one or two smaller files at a time.`);
  }
};

// Tile state model — formal three-state. `state` drives visual
// treatment in the tile grid; `statusDetail`, when present, renders
// as the body sub-line of the card ("Received: BBVA EUR · Still need:
// all other operating accounts for June.") which is how PARTIAL is
// expressed visually without inventing a per-pile substructure.
//
// `desc` is a template — `{period}` and `{periodTitle}` get substituted
// with the lowercase / title-case month name at render time so a
// statement-period claim ("June statements…") tracks the calendar
// rather than drifting against the hero copy.
//
// `dismissible: true` opts the tile into the "not applicable" escape
// hatch — for piles that genuinely don't apply to every owner
// (Payroll for solo operators, Loans for the un-leveraged, Xero if
// they don't use it yet). Dismissed tiles flip to a calm "Not
// applicable" state and count toward complete in the master count,
// so the page doesn't keep nagging about a pile the owner already
// declared n/a.
const TILES = [
  {
    id: 'bank',
    titleId: 'portal.tile.bank.title',
    descId: 'portal.tile.bank.description',
    state: 'partial',
    statusDetailId: 'portal.tile.bank.partialDescription',
    statusId: 'portal.tile.status.partial',
    ctaId: 'portal.tile.action.addRest'
  },
  {
    id: 'sales',
    titleId: 'portal.tile.sales.title',
    descId: 'portal.tile.sales.description',
    state: 'missing',
    statusId: 'portal.tile.status.missing',
    ctaId: 'portal.tile.action.upload'
  },
  {
    id: 'bills',
    titleId: 'portal.tile.bills.title',
    descId: 'portal.tile.bills.description',
    state: 'missing',
    statusId: 'portal.tile.status.missing',
    ctaId: 'portal.tile.action.upload'
  },
  {
    id: 'payroll',
    titleId: 'portal.tile.payroll.title',
    descId: 'portal.tile.payroll.description',
    dismissedDescId: 'portal.tile.payroll.dismissed',
    state: 'missing',
    statusId: 'portal.tile.status.missing',
    ctaId: 'portal.tile.action.upload',
    dismissible: true,
    dismissId: 'portal.tile.payroll.dismiss'
  },
  {
    id: 'loans',
    titleId: 'portal.tile.loans.title',
    descId: 'portal.tile.loans.description',
    dismissedDescId: 'portal.tile.loans.dismissed',
    state: 'missing',
    statusId: 'portal.tile.status.missing',
    ctaId: 'portal.tile.action.upload',
    dismissible: true,
    dismissId: 'portal.tile.loans.dismiss'
  },
  {
    id: 'xero',
    titleId: 'portal.axis.accounting.xero.title',
    descId: 'portal.axis.accounting.xero.description',
    dismissedDescId: 'portal.axis.accounting.xero.dismissed',
    state: 'missing',
    statusId: 'portal.tile.status.missing',
    ctaId: 'portal.tile.action.connect',
    dismissible: true,
    dismissId: 'portal.axis.accounting.xero.none'
  }
];

const PORTAL_PAYROLL_MESSAGE_IDS = Object.freeze({
  sg: ['portal.axis.payroll.sg.title', 'portal.axis.payroll.sg.description'],
  gb: ['portal.axis.payroll.gb.title', 'portal.axis.payroll.gb.description'],
  au: ['portal.axis.payroll.au.title', 'portal.axis.payroll.au.description'],
  us: ['portal.axis.payroll.us.title', 'portal.axis.payroll.us.description'],
  hk: ['portal.axis.payroll.hk.title', 'portal.axis.payroll.hk.description'],
  ae: ['portal.axis.payroll.ae.title', 'portal.axis.payroll.ae.description'],
  default: ['portal.axis.payroll.default.title', 'portal.axis.payroll.default.description']
});

const PORTAL_CONNECTOR_MESSAGE_IDS = Object.freeze({
  xero: Object.freeze({
    titleId: 'portal.axis.accounting.xero.title',
    descId: 'portal.axis.accounting.xero.description',
    dismissedDescId: 'portal.axis.accounting.xero.dismissed',
    ctaId: 'portal.axis.accounting.xero.connect',
    dismissId: 'portal.axis.accounting.xero.none'
  }),
  qbo: Object.freeze({
    titleId: 'portal.axis.accounting.qbo.title',
    descId: 'portal.axis.accounting.qbo.description',
    dismissedDescId: 'portal.axis.accounting.qbo.dismissed',
    ctaId: 'portal.axis.accounting.qbo.connect',
    dismissId: 'portal.axis.accounting.qbo.none'
  }),
  default: Object.freeze({
    titleId: 'portal.axis.accounting.default.title',
    descId: 'portal.axis.accounting.default.description',
    dismissedDescId: 'portal.axis.accounting.default.dismissed',
    ctaId: 'portal.axis.accounting.default.connect',
    dismissId: 'portal.axis.accounting.default.none'
  })
});

// Reads the persisted dismissed-tile list for a single period (YYYY-MM)
// from clients.profile.dismissed_tiles. Same dual-path read as
// readPortalTileFilter: getFirmSnapshotFromDb spreads `row.profile`
// onto the client so the top-level access is the primary path, but a
// nested `profile` object is honoured for local-demo fixtures.
const readDismissedTilesForPeriod = (client = {}, periodKey = '') => {
  if (!periodKey) return new Set();
  const fromTop = client?.dismissed_tiles?.[periodKey];
  const fromProfile = client?.profile?.dismissed_tiles?.[periodKey];
  const list = Array.isArray(fromTop) ? fromTop : Array.isArray(fromProfile) ? fromProfile : [];
  return new Set(list.filter(Boolean).map(String));
};

// Pulls the full per-period dismissed_tiles map (every period, not just
// the current one) off the client record so a profile write can patch
// just the current period without dropping historical entries.
const readDismissedTilesMap = (client = {}) => {
  const fromTop = client?.dismissed_tiles;
  const fromProfile = client?.profile?.dismissed_tiles;
  const source = fromTop && typeof fromTop === 'object' && !Array.isArray(fromTop)
    ? fromTop
    : fromProfile && typeof fromProfile === 'object' && !Array.isArray(fromProfile)
      ? fromProfile
      : {};
  return { ...source };
};

// Collapse threshold for the § 02 list. Below this, every question
// keeps its own top-level row. At or above, runs of consecutive same-
// kind questions fold into a single group row that expands to reveal
// the underlying list. Tuned for "a normal close has 1–3 questions
// per category; a busy close has 5–10 receipts in one stack".
const QUESTION_GROUP_THRESHOLD = 5;

// "Receipt" → "Receipts", "FX" stays "FX", anything else gets an "s"
// unless it already ends in one. Tilted toward the actual evidence
// kinds the operator drafts today; new kinds will land as plain
// "Foo" → "Foos" until we explicitly override.
const pluraliseQuestionKind = (kind = 'Question') => {
  if (!kind) return 'Questions';
  if (kind === 'FX') return 'FX';
  if (kind.endsWith('s')) return kind;
  return `${kind}s`;
};

// Builds the flat list of rows for § 02 from the raw question + tile
// inputs, applying the consecutive-same-kind grouping rule. Pure —
// the component memoises the result.
//
// Item shapes:
//   { type: 'question', key, q, kindLabel, primary, meta, status }
//   { type: 'tile',     key, tile, kindLabel, primary, meta, status }
//   { type: 'group',    key, kind, kindLabel, questions, meta }
const buildListItems = ({ questions = [], effectiveTiles = [], tileIsComplete, formatMessage = null }) => {
  const message = (id, values, fallback) => typeof formatMessage === 'function'
    ? formatMessage({ id }, values)
    : fallback;
  const questionKind = (kind, plural = false) => {
    if (kind === 'Receipt') {
      return message(
        plural ? 'portal.list.kind.receipts' : 'portal.list.kind.receipt',
        {},
        plural ? 'Receipts' : 'Receipt'
      );
    }
    if (kind === 'FX') return message('portal.list.kind.fx', {}, 'FX');
    const messageId = EVIDENCE_KIND_MESSAGE_IDS[kind];
    if (messageId) return message(messageId, {}, kind);
    return kind || message(
      plural ? 'portal.question.plural' : 'portal.question.singular',
      {},
      plural ? 'Questions' : 'Question'
    );
  };
  const items = [];
  let i = 0;
  while (i < questions.length) {
    const startKind = questions[i].kind || 'Question';
    let j = i;
    while (j < questions.length && (questions[j].kind || 'Question') === startKind) {
      j += 1;
    }
    const run = questions.slice(i, j);
    if (run.length >= QUESTION_GROUP_THRESHOLD) {
      const dates = run.map((q) => q.when).filter(Boolean);
      const dateRange = dates.length >= 2
        ? `${dates[dates.length - 1]} – ${dates[0]}`
        : dates[0] || '';
      const kindLabel = questionKind(startKind, true) || pluraliseQuestionKind(startKind);
      items.push({
        type: 'group',
        key: `g-${startKind}-${run[0].id}`,
        kind: startKind,
        kindLabel,
        questions: run,
        primary: message('portal.list.groupPrimary', { count: run.length, kind: kindLabel }, `${run.length} ${kindLabel}`),
        meta: dateRange,
        dateStart: dates.at(-1) || '',
        dateEnd: dates[0] || '',
        status: message('portal.question.open', {}, 'OPEN')
      });
    } else {
      for (const q of run) {
        items.push({
          type: 'question',
          key: `q-${q.id}`,
          q,
          kindLabel: questionKind(q.kind),
          primary: q.desc || q.text || message('portal.question.forYou', {}, 'Question for you'),
          meta: [q.amt, q.when].filter(Boolean).join(' · '),
          amount: q.amt || '',
          date: q.when || '',
          status: message('portal.question.open', {}, 'OPEN')
        });
      }
    }
    i = j;
  }
  for (const tile of effectiveTiles) {
    if (typeof tileIsComplete === 'function' && tileIsComplete(tile)) continue;
    items.push({
      type: 'tile',
      key: `t-${tile.id}`,
      tile,
      kindLabel: message('portal.list.fileGroup', {}, 'File group'),
      primary: tile.title,
      meta: tile.dismissible ? message('portal.list.ifApplicable', {}, 'If applicable') : '',
      status: tile.state === 'partial'
        ? message('portal.list.partial', {}, 'Partial')
        : message('portal.list.missing', {}, 'Missing')
    });
  }
  return items;
};

// ── SVG glyphs (Feather-style) ───────────────────────────────────────────────

const UploadGlyph = (props) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 16V4M6 10l6-6 6 6" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

const CheckGlyph = (props) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M5 12l5 5L20 7" />
  </svg>
);

const CameraGlyph = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="6" width="18" height="14" rx="2" />
    <circle cx="12" cy="13" r="4" />
    <path d="M8 6l1.5-2h5L16 6" />
  </svg>
);

const NoteGlyph = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 4h12l4 4v12H4z" />
    <path d="M16 4v4h4" />
    <path d="M8 12h8M8 16h6" />
  </svg>
);

const EmailGlyph = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </svg>
);

const FolderGlyph = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 7v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2z" />
  </svg>
);

const ClipboardGlyph = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="8" y="4" width="10" height="16" rx="2" />
    <path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2" />
  </svg>
);

// ── Inline reply ─────────────────────────────────────────────────────────────
//
// Editorial reply panel rendered directly inside the expanded question row
// (no portal, no scrim). Same wiring as the prior ReplyModal — note + files
// + pane state, same submit handler — just inline. Fresh state per mount:
// React unmounts the panel when expandedKey changes to a different row, so
// a useEffect on question.id is not needed.
function InlineReply({ question, busy = false, error = '', initialPane = 'note', onSubmit, onSkip }) {
  const intl = useIntl();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const [pane, setPane] = useState(initialPane === 'photo' ? 'photo' : 'note');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [fileError, setFileError] = useState('');

  if (!question) return null;

  const reply = String(note || '').trim();
  const hasFiles = files.length > 0;
  const totalBytes = hasFiles ? files.reduce((sum, file) => sum + Number(file?.size || 0), 0) : 0;
  const canSubmit = (!!reply || hasFiles) && !busy;
  const readinessLabel = (() => {
    if (busy) {
      return hasFiles
        ? message('portal.reply.uploadingFiles', { count: files.length })
        : message('portal.reply.sending');
    }
    if (!reply && !hasFiles) return message('portal.reply.placeholder');
    const parts = [];
    if (reply) parts.push(message('portal.reply.noteReady'));
    if (hasFiles) {
      parts.push(`${message('portal.reply.filesReady', { count: files.length })} · ${formatFileSize(totalBytes, intl.formatMessage)}`);
    }
    return parts.join(' · ');
  })();

  const addFiles = (selectedFiles = []) => {
    const nextFiles = Array.from(selectedFiles || []);
    if (!nextFiles.length) return;
    const tooLarge = nextFiles.find((file) => file.size > MAX_EVIDENCE_FILE_BYTES);
    if (tooLarge) {
      setFileError(message('portal.error.fileTooLarge', {
        filename: tooLarge.name || 'File',
        limit: formatFileSize(MAX_EVIDENCE_FILE_BYTES, intl.formatMessage)
      }));
      return;
    }
    const nextTotal = [...files, ...nextFiles].reduce((sum, file) => sum + Number(file?.size || 0), 0);
    if (nextTotal > MAX_EVIDENCE_UPLOAD_BYTES) {
      setFileError(message('portal.evidence.uploadTooLarge', {
        limit: formatFileSize(MAX_EVIDENCE_UPLOAD_BYTES, intl.formatMessage)
      }));
      return;
    }
    setFileError('');
    setFiles((prev) => [...prev, ...nextFiles].slice(0, 5));
  };

  const pasteFromClipboard = async () => {
    setFileError('');
    try {
      const items = await navigator.clipboard?.read?.();
      const clipboardFiles = [];
      for (const item of items || []) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        clipboardFiles.push(new File([blob], `clipboard-${Date.now()}.${imageType.split('/').pop() || 'png'}`, { type: imageType }));
      }
      if (!clipboardFiles.length) throw new Error(message('portal.error.noClipboardImage'));
      addFiles(clipboardFiles);
    } catch (err) {
      setFileError(err?.message || message('portal.error.clipboardUnavailable'));
    }
  };

  return (
    <div
      style={{
        borderTop: `1px solid ${D.rule}`,
        backgroundColor: D.paperDeep,
        padding: 'clamp(1.25rem, 3vw, 1.75rem)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem'
      }}
    >
      {/* Tabs — mono caps, hairline divider beneath, ink-on-paper active. */}
      <div
        style={{
          display: 'flex',
          gap: '1.75rem',
          borderBottom: `1px solid ${D.rule}`,
          paddingBottom: '0.5rem',
          marginBottom: '0.25rem'
        }}
      >
        {[
          { id: 'note', label: message('portal.reply.tab.note'), Icon: NoteGlyph },
          // 'photo' id kept (pane wiring); label is "File" because the pane
          // accepts a photo OR a PDF (e.g. a bank statement isn't a photo).
          // The mobile "take a photo" camera affordance lives inside the pane.
          { id: 'photo', label: message('portal.reply.tab.file'), Icon: CameraGlyph }
        ].map(({ id, label, Icon }) => {
          const active = pane === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => !busy && setPane(id)}
              disabled={busy}
              style={{
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                padding: '0.25rem 0',
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                fontWeight: 500,
                color: active ? D.ink : D.inkMute,
                borderBottom: `2px solid ${active ? D.ink : 'transparent'}`,
                marginBottom: '-9px',
                cursor: busy ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <Icon /> {label}
            </button>
          );
        })}
      </div>

      {pane === 'note' && (
        <div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 280))}
            placeholder={message('portal.reply.example')}
            dir="auto"
            disabled={busy}
            style={{
              width: '100%',
              minHeight: 96,
              boxSizing: 'border-box',
              fontFamily: D.body,
              fontSize: '0.9375rem',
              lineHeight: D.leading.body,
              padding: '0.75rem 1rem',
              border: `1px solid ${D.rule}`,
              backgroundColor: D.paper,
              color: D.ink,
              resize: 'vertical',
              borderRadius: 0
            }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '0.5rem',
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              color: D.inkMute,
              gap: '1rem',
              flexWrap: 'wrap'
            }}
          >
            <span>{message('portal.reply.tip')}</span>
            <FormattedValue>{intl.formatNumber(note.length)} / {intl.formatNumber(280)}</FormattedValue>
          </div>
        </div>
      )}

      {pane === 'photo' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <label
            style={{
              border: `1px solid ${D.rule}`,
              backgroundColor: D.paper,
              padding: 'clamp(1.5rem, 4vw, 2.25rem)',
              cursor: busy ? 'not-allowed' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.75rem',
              opacity: busy ? 0.6 : 1,
              pointerEvents: busy ? 'none' : 'auto',
              textAlign: 'center'
            }}
          >
            <div style={{ color: D.ink, display: 'flex' }}>
              <CameraGlyph width="32" height="32" strokeWidth="1.4" />
            </div>
            <div
              style={{
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                color: D.ink,
                fontWeight: 500
              }}
            >
              {message('portal.reply.camera')}
            </div>
            <div
              style={{
                fontFamily: D.body,
                fontSize: '0.875rem',
                lineHeight: D.leading.body,
                color: D.inkSoft,
                maxWidth: '36em'
              }}
            >
              {message('portal.reply.cameraDescription')}
            </div>
            <input
              type="file"
              accept="image/*,application/pdf,.csv,text/csv"
              capture="environment"
              multiple
              disabled={busy}
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
              style={{ display: 'none' }}
            />
          </label>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '1px',
              backgroundColor: D.rule,
              border: `1px solid ${D.rule}`
            }}
          >
            <label
              style={{
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                fontWeight: 500,
                padding: '0.75rem 1rem',
                backgroundColor: D.paper,
                color: D.ink,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.55 : 1,
                pointerEvents: busy ? 'none' : 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem'
              }}
            >
              <FolderGlyph /> {message('portal.reply.pickFiles')}
              <input
                type="file"
                accept="image/*,application/pdf,.csv,text/csv"
                multiple
                disabled={busy}
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = '';
                }}
                style={{ display: 'none' }}
              />
            </label>
            <button
              type="button"
              onClick={pasteFromClipboard}
              disabled={busy}
              style={{
                appearance: 'none',
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                fontWeight: 500,
                padding: '0.75rem 1rem',
                backgroundColor: D.paper,
                color: D.ink,
                border: 'none',
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.55 : 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem'
              }}
            >
              <ClipboardGlyph /> {message('portal.reply.pasteClipboard')}
            </button>
          </div>

          {(files.length > 0 || fileError) && (
            <div
              style={{
                display: 'grid',
                gap: '1px',
                backgroundColor: D.rule,
                border: `1px solid ${D.rule}`
              }}
            >
              {files.map((file, fileIndex) => (
                <div
                  key={`${file.name}-${file.size}-${fileIndex}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    padding: '0.6rem 1rem',
                    backgroundColor: D.paper,
                    color: D.ink,
                    fontSize: '0.875rem'
                  }}
                >
                  <span
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <BidiText direction="auto">{file.name || message('portal.reply.uploadedEvidence')}</BidiText>
                  </span>
                  <span
                    style={{
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      color: D.inkMute,
                      flex: '0 0 auto'
                    }}
                  >
                    <FormattedValue>{formatFileSize(file.size, intl.formatMessage)}</FormattedValue>
                  </span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== fileIndex))}
                    disabled={busy}
                    aria-label={message('portal.reply.removeFile', { filename: file.name || 'file' })}
                    style={{
                      flex: '0 0 auto',
                      border: 'none',
                      background: 'transparent',
                      color: D.inkSoft,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase'
                    }}
                  >
                    {message('portal.reply.remove')}
                  </button>
                </div>
              ))}
              {fileError && (
                <div
                  role="alert"
                  style={{
                    backgroundColor: D.paperDeep,
                    color: D.ink,
                    fontFamily: D.body,
                    fontSize: '0.875rem',
                    lineHeight: D.leading.body,
                    padding: '0.6rem 1rem'
                  }}
                >
                  <BidiText direction="auto">{fileError}</BidiText>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            border: `1px solid ${D.rule}`,
            borderInlineStartWidth: '3px',
            borderInlineStartStyle: 'solid',
            borderInlineStartColor: D.ink,
            backgroundColor: D.paper,
            padding: '0.75rem 1rem',
            fontFamily: D.mono,
            fontSize: 11,
            letterSpacing: D.tracking.mono,
            textTransform: 'uppercase',
            color: D.ink
          }}
        >
          <BidiText direction="auto">{error}</BidiText>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
          paddingTop: '0.75rem',
          borderTop: `1px solid ${D.rule}`
        }}
      >
        <span
          aria-live="polite"
          style={{
            fontFamily: D.mono,
            fontSize: 11,
            letterSpacing: D.tracking.mono,
            textTransform: 'uppercase',
            color: busy ? D.ink : D.inkMute
          }}
        >
          {readinessLabel}
        </span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            onClick={() => !busy && onSkip?.()}
            disabled={busy}
            style={{
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              padding: '0.6rem 1.1rem',
              background: 'transparent',
              border: `1px solid ${D.rule}`,
              color: D.inkSoft,
              cursor: busy ? 'not-allowed' : 'pointer'
            }}
          >
            {message('portal.reply.skip')}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => canSubmit && onSubmit?.({ reply, mode: pane, files })}
            style={{
              ...(canSubmit ? D.noiseGold() : { backgroundColor: D.paperDeep }),
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              fontWeight: 500,
              padding: '0.6rem 1.25rem',
              border: `1px solid ${canSubmit ? D.ink : D.rule}`,
              color: canSubmit ? D.ink : D.inkMute,
              cursor: canSubmit ? 'pointer' : 'not-allowed'
            }}
          >
            {busy
              ? hasFiles ? message('portal.documents.staged.uploading') : message('portal.reply.sending')
              : hasFiles && reply
                ? message('portal.reply.sendNoteEvidence')
                : hasFiles
                  ? message('portal.reply.sendEvidence')
                  : message('portal.reply.sendNote')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export default function DonnaClientPortal({
  clients = [],
  clientId,
  documents = [],
  setDocuments,
  transactions = [],
  setTransactions,
  clientEvidenceRequests = [],
  firmMessages: firmMessagesProp = [],
  firmDataSource = 'local',
  onDatabaseSnapshot,
  onSnapshotInvalidated,
  previewState = null
} = {}) {
  const intl = useIntl();
  const {
    direction,
    formatAmount,
    formatDate,
    formatTimestamp,
    locale: interfaceLocale,
    setInterfaceLocale
  } = useInterfaceLocale();
  const message = (id, values) => intl.formatMessage({ id }, values);
  const previewMode = Boolean(previewState);
  const liveDatabaseMode = firmDataSource === 'database' && !previewMode;
  const databaseMode = liveDatabaseMode || previewMode;
  const selectedClient = useMemo(
    () => clientId ? clients.find((c) => c.id === clientId) || null : clients[0] || null,
    [clients, clientId]
  );
  // Messages from the firm = entries in firmMessages scoped to this
  // client. firmMessages is a separate App-level store that survives BE
  // snapshots (which used to wipe history on portal mount).
  const firmMessages = useMemo(
    () => (firmMessagesProp || [])
      .filter((m) => Boolean(selectedClient?.id) && m.client_id === selectedClient.id)
      .map((m) => ({
        id: m.id,
        subject: m.subject || message('portal.evidence.messageFromFirm'),
        body: m.body || '',
        sentAt: m.sent_at,
        from: m.from || message('portal.evidence.donnaRole')
      }))
      .filter((m) => m.body.trim().length > 0)
      // Newest first. Older messages (e.g. the original "Welcome to
      // Donna" onboarding note) slide to the bottom so the client's
      // attention lands on whatever the firm sent most recently.
      .sort((a, b) => {
        const aT = a.sentAt ? new Date(a.sentAt).getTime() : 0;
        const bT = b.sentAt ? new Date(b.sentAt).getTime() : 0;
        return bT - aT;
      }),
    [firmMessagesProp, selectedClient?.id, intl]
  );
  // Dismissed-tile persistence stays keyed to the calendar month —
  // re-keying it to the books' period would orphan rows persisted
  // under earlier calendar keys. The user-facing period labels are
  // derived below (see portalPeriod / ../lib/clientPortalPeriod.js).
  const periodKey = useMemo(() => formatPeriodKey(new Date()), []);
  const lastContactAt = firmMessages[0]?.sentAt || null;
  const lastContactRelative = lastContactAt
    ? formatRelativeContact(lastContactAt, { formatMessage: intl.formatMessage, formatDate })
    : '';
  // Scope transactions to the selected client. App.jsx passes firm-wide
  // firmTransactions — without this filter, a second client's bank data
  // bleeds into this portal view (confirmed: a pilot client's SGD transactions
  // appeared on the Honeybee Hills view).
  const clientTransactions = useMemo(
    () => (transactions || []).filter((tx) => Boolean(selectedClient?.id) && tx.client_id === selectedClient.id),
    [transactions, selectedClient?.id]
  );
  const clientDocuments = useMemo(
    () => (documents || []).filter((doc) => Boolean(selectedClient?.id) && doc.client_id === selectedClient.id),
    [documents, selectedClient?.id]
  );
  // § 03 "Your uploads" (DB mode): the client's source documents, newest
  // first. Renders the PERSISTED parse_status verdict only. Duplicate-
  // pending placeholders are a transient firm-side resolution state, not a
  // document the client uploaded, so they're hidden; every other state
  // (received / reading / filed / couldn't read / on file) is shown
  // honestly — a doc that failed to read must not silently vanish.
  const visibleUploads = useMemo(() => {
    const uploadedTime = (doc) => {
      const value = doc?.uploaded_at || doc?.created_at;
      const ms = value ? new Date(value).getTime() : 0;
      return Number.isNaN(ms) ? 0 : ms;
    };
    return (clientDocuments || [])
      .filter((doc) => (doc?.parse_status || 'completed') !== 'duplicate_pending')
      .slice()
      .sort((a, b) => uploadedTime(b) - uploadedTime(a));
  }, [clientDocuments]);
  // Scope evidence requests to the selected client BEFORE deriving the hero
  // period — a sibling client's requests must not set this client's close
  // period (the same cross-client bleed the clientTransactions filter above
  // guards against: a pilot client's SGD surfaced on the Honeybee view).
  const clientEvidenceRequestsScoped = useMemo(
    () => (clientEvidenceRequests || []).filter(
      (request) => Boolean(selectedClient?.id) && request.client_id === selectedClient.id
    ),
    [clientEvidenceRequests, selectedClient?.id]
  );
  // The period the hero may speak about. SPECIFIC only when an explicit
  // evidence-request period exists; a period merely INFERRED from the newest
  // bank line (e.g. a book with only Feb 2025 loaded) is NOT named — the hero
  // reads "your books" instead of asserting an unchosen close target. The
  // label/title still format the loaded month for tile copy; only the hero's
  // close claim gates on `periodSpecific`. See ../lib/clientPortalPeriod.js.
  const portalPeriod = useMemo(
    () => deriveClientPortalPeriod({
      evidenceRequests: clientEvidenceRequestsScoped,
      transactions: clientTransactions,
      now: new Date()
    }),
    [clientEvidenceRequestsScoped, clientTransactions]
  );
  const periodDate = portalPeriod.date;
  const periodCalendarDate = `${periodDate.getFullYear()}-${String(periodDate.getMonth() + 1).padStart(2, '0')}-01`;
  const periodTitle = formatDate(periodCalendarDate, {
    day: undefined,
    month: 'long',
    year: periodDate.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  });
  const periodLabel = periodTitle;
  const periodSpecific = portalPeriod.specific;
  const ventureLabel = selectedClient?.companyName || 'Your company';
  const liveQuestions = useMemo(
    () => clientEvidenceRequestsScoped
      .filter((request) => openEvidenceStatuses.has(request.status))
      .map((request) => buildQuestionFromEvidenceRequest(request, {
        formatAmount,
        formatDate,
        formatMessage: intl.formatMessage
      })),
    [clientEvidenceRequestsScoped, formatAmount, formatDate, intl]
  );
  const clientDocumentCount = clientDocuments.length;
  const questions = databaseMode
    ? liveQuestions
    : QUESTIONS.map((question) => ({
        ...question,
        when: formatShortDate(question.date, formatDate),
        amt: formatMoney(question.amount, question.currency, formatAmount)
      }));

  // Service selection describes scope, not missing evidence. Only persisted
  // owner asks may request documents in a live book; generic piles stay demo-only.
  // Per-client portal tile state — derived from clients.profile.services_engaged
  // via the shared module (Phase 1.5 cohort split), with a one-deploy-cycle
  // fallback to the legacy applicable_intake_categories field.
  //   mode 'all'      → tiles=null, render every tile (legacy / backward-compat)
  //   mode 'scoped'   → tiles=Set, render the mapped tiles
  //   mode 'unscoped' → explicit empty services_engaged: render the
  //                     "not scoped yet" placeholder instead of tiles
  // See docs/jurisdiction-services-accounting-plan.md.
  const portalTileState = useMemo(
    () => readPortalTileState(selectedClient || {}),
    [selectedClient]
  );
  const portalUnscoped = portalTileState.mode === 'unscoped';
  // Jurisdiction drives per-tile copy overrides — payroll today
  // (CPF / PAYE / STP / 941 / MPF / generic), more tiles later.
  // Null jurisdiction → generic copy.
  const clientJurisdiction = useMemo(
    () => readJurisdiction(selectedClient || {}),
    [selectedClient]
  );
  // Phase 3a — the connector tile is driven by clients.profile.accounting_system
  // + the live connection status joined onto the snapshot, NOT by the
  // service→tile filter (connecting the books is orthogonal to which document
  // piles the firm collects). Null when accounting_system is 'none' or the
  // connection is already live; unset inherits the historical Xero default for
  // one deploy cycle. See docs/jurisdiction-services-accounting-plan.md.
  const connectorTile = useMemo(
    () => accountingConnectorTile(selectedClient || {}),
    [selectedClient]
  );
  const connectorPresentationKey = readAccountingSystem(selectedClient || {}) || 'default';
  // Client-side "not applicable" set. Owners who genuinely don't have
  // payroll / loans / Xero can dismiss those tiles so the page stops
  // counting them as outstanding. Seeded from the persisted
  // clients.profile.dismissed_tiles[periodKey] list (DB mode) or
  // local-fixture equivalent; toggles are optimistic with a BE write
  // through updateFirmClientProfile and a revert-on-failure.
  const [dismissedTiles, setDismissedTiles] = useState(() =>
    readDismissedTilesForPeriod(selectedClient, periodKey)
  );
  // Reconcile local state when the upstream snapshot reports a different
  // persisted list for the current period (a successful write completes;
  // another surface mutated it; client switched). Stringify the list to
  // canonical sorted form so re-renders with the same data don't reset
  // optimistic state mid-flight.
  const persistedDismissedKey = useMemo(() => {
    const arr = Array.from(readDismissedTilesForPeriod(selectedClient, periodKey));
    arr.sort();
    return arr.join('');
  }, [selectedClient, periodKey]);
  useEffect(() => {
    setDismissedTiles(readDismissedTilesForPeriod(selectedClient, periodKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedDismissedKey, selectedClient?.id, periodKey]);

  const toggleTileDismissed = (id) => {
    let prevSet;
    let nextSet;
    setDismissedTiles((prev) => {
      prevSet = prev;
      nextSet = new Set(prev);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
    if (!liveDatabaseMode || !selectedClient?.id) return;
    const nextMap = readDismissedTilesMap(selectedClient);
    const nextList = Array.from(nextSet).sort();
    if (nextList.length) {
      nextMap[periodKey] = nextList;
    } else {
      delete nextMap[periodKey];
    }
    updateFirmClientProfile({
      clientId: selectedClient.id,
      profilePatch: { dismissed_tiles: nextMap }
    })
      .then((snapshot) => {
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      })
      .catch((error) => {
        console.error('Failed to persist dismissed tile state', error);
        setDismissedTiles(prevSet);
      });
  };

  // In-portal business-name rename. Self-provisioned owners arrive with an
  // email-prefix placeholder (e.g. "kari") captured at signup; this lets them
  // fix it without the firm. Persists via the same updateFirmClientProfile
  // partial-merge path the dismissed-tiles toggle uses (profile.companyName,
  // which the server also mirrors into the company_name column). The write
  // returns the refreshed snapshot, so on success we just close the editor and
  // let the snapshot refresh the displayed name — no optimistic local copy to
  // diverge. DB-mode only; the local demo has no client row to write.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const canEditName = liveDatabaseMode && Boolean(selectedClient?.id);
  const gbFilingFacts = selectedClient?.profile?.gb || selectedClient?.gb || {};
  const [previewCompletedSetup, setPreviewCompletedSetup] = useState(() => new Set());
  useEffect(() => { setPreviewCompletedSetup(new Set()); }, [selectedClient?.id, previewMode]);
  const previewStepDue = (id) => previewMode
    && Boolean(previewState?.setupDue?.includes(id))
    && !previewCompletedSetup.has(id);
  const jurisdictionCapture = jurisdictionCaptureState(selectedClient || {});
  const showJurisdictionCard = (databaseMode && Boolean(selectedClient?.id) && jurisdictionCapture.show)
    || previewStepDue('jurisdiction');
  const [jurisdictionDraft, setJurisdictionDraft] = useState('');
  const [jurisdictionSaving, setJurisdictionSaving] = useState(false);
  const [jurisdictionError, setJurisdictionError] = useState('');
  useEffect(() => {
    setJurisdictionDraft('');
    setJurisdictionError('');
  }, [selectedClient?.id]);
  const saveJurisdiction = () => {
    if (!jurisdictionDraft || jurisdictionSaving) return;
    setJurisdictionSaving(true);
    setJurisdictionError('');
    if (previewMode) {
      setPreviewCompletedSetup((previous) => new Set([...previous, 'jurisdiction']));
      setJurisdictionSaving(false);
      return;
    }
    updateFirmClientProfile({
      clientId: selectedClient.id,
      profilePatch: { jurisdiction: jurisdictionDraft, entity_type: null }
    }).then((snapshot) => {
      if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') onDatabaseSnapshot(snapshot);
    }).catch((error) => {
      setJurisdictionError(error?.message || message('portal.setup.jurisdiction.error'));
    }).finally(() => setJurisdictionSaving(false));
  };
  const showGbFilingCard = (databaseMode && clientJurisdiction === 'gb' && (
    !gbFilingFacts.vat_stagger ||
    !gbFilingFacts.confirmation_review_period_end ||
    !gbFilingFacts.accounting_period_end
  )) || previewStepDue('gb_filing');
  const [gbFilingDraft, setGbFilingDraft] = useState({ vat_stagger: '', confirmation_review_period_end: '', accounting_period_end: '' });
  const [gbFilingSaving, setGbFilingSaving] = useState(false);
  const [gbFilingError, setGbFilingError] = useState('');
  // Row-17 entity-type capture: shown whenever the stored entity_type is not
  // canonical for the client's jurisdiction (missing, free-form legacy, or
  // another market's form). The write goes through the same validated
  // profile-patch route as the filing card; the server canonicalizes (gb-*),
  // refuses unknown GB forms, and mirrors entity_type / incorporation_date to
  // their load-bearing columns so the fiscal-year and statutory dispatches see
  // the captured value. Incorporation date is REQUIRED for gb-ltd / gb-llp —
  // without it, storing the form would trade the calendar fallback for the
  // resolver's GB_ACCOUNTING_PERIOD_REQUIRES_PERSISTED refusal on every path.
  const entityCapture = useMemo(
    () => {
      const state = entityTypeCaptureState(persistedClientIdentity(selectedClient || {}));
      return { ...state, show: state.show || entityTypeIdentityConflict(selectedClient || {}) };
    },
    [selectedClient]
  );
  const showEntityTypeCard = (databaseMode && Boolean(selectedClient?.id) && entityCapture.show)
    || previewStepDue('entity_type');
  const [entityTypeDraft, setEntityTypeDraft] = useState({ entity_type: '', incorporation_date: '' });
  const [entityTypeSaving, setEntityTypeSaving] = useState(false);
  const [entityTypeError, setEntityTypeError] = useState('');
  useEffect(() => {
    // Re-seed the draft per client: a known incorporation date (e.g. from
    // provision) prefills; a known BF-2 legacy alias also prefills its exact
    // canonical replacement for explicit owner confirmation. A client switch
    // never carries a stale draft over.
    setEntityTypeDraft({
      entity_type: entityCapture.suggestedEntityType || '',
      incorporation_date: entityCapture.incorporationDate || ''
    });
    setEntityTypeError('');
  }, [selectedClient?.id, entityCapture.incorporationDate, entityCapture.suggestedEntityType]);
  const entityTypeNeedsDate = entityTypeRequiresIncorporationDate(entityTypeDraft.entity_type);
  // Row-17 fiscal-period step. Only the registry-first forms (fi-oy, gb-ltd,
  // gb-llp) are asked, only when the server says the intake ACTS (the flag
  // verdict comes from GET /fiscal-periods — never guessed here) and no
  // period is persisted yet. The card renders persisted state; a successful
  // save re-fetches rather than trusting a local echo.
  const storedEntityType = readEntityType(selectedClient || {});
  const clientNeedsFiscalPeriod = entityTypeRequiresExplicitFiscalPeriod(storedEntityType);
  const [fiscalPeriodState, setFiscalPeriodState] = useState(() => previewState?.fiscalPeriodState || null);
  useEffect(() => {
    if (previewMode) {
      setFiscalPeriodState(previewState?.fiscalPeriodState || null);
      return undefined;
    }
    setFiscalPeriodState(null);
    if (!liveDatabaseMode || !selectedClient?.id || !clientNeedsFiscalPeriod) return undefined;
    const controller = new AbortController();
    fetchFiscalPeriods({ clientId: selectedClient.id, signal: controller.signal }).then(setFiscalPeriodState).catch(() => setFiscalPeriodState(null));
    return () => controller.abort();
  }, [liveDatabaseMode, previewMode, previewState, selectedClient?.id, clientNeedsFiscalPeriod]);
  const showFiscalPeriodCard = (databaseMode && clientNeedsFiscalPeriod
    && Boolean(fiscalPeriodState?.intake_acts)
    && (fiscalPeriodState?.periods || []).length === 0) || previewStepDue('fiscal_period');
  const [fiscalPeriodDraft, setFiscalPeriodDraft] = useState({ starts_on: '', ends_on: '' });
  const [fiscalPeriodSaving, setFiscalPeriodSaving] = useState(false);
  const [fiscalPeriodError, setFiscalPeriodError] = useState('');
  useEffect(() => {
    setFiscalPeriodDraft({ starts_on: '', ends_on: '' });
    setFiscalPeriodError('');
  }, [selectedClient?.id]);
  const saveFiscalPeriod = () => {
    setFiscalPeriodSaving(true);
    setFiscalPeriodError('');
    if (previewMode) {
      setPreviewCompletedSetup((previous) => new Set([...previous, 'fiscal_period']));
      setFiscalPeriodSaving(false);
      return;
    }
    registerFiscalPeriod({
      clientId: selectedClient.id,
      startsOn: fiscalPeriodDraft.starts_on,
      endsOn: fiscalPeriodDraft.ends_on
    }).then(() => fetchFiscalPeriods({ clientId: selectedClient.id }).then(setFiscalPeriodState)).catch((error) => {
      console.error('Failed to save financial year', error);
      // The writer refuses by name (overlap, statutory too-long, conflict) —
      // surface its message so the owner sees WHY, not a generic shrug.
      setFiscalPeriodError(error?.message || message('portal.error.saveFinancialYear'));
    }).finally(() => setFiscalPeriodSaving(false));
  };
  const saveEntityType = () => {
    setEntityTypeSaving(true);
    setEntityTypeError('');
    if (previewMode) {
      setPreviewCompletedSetup((previous) => new Set([...previous, 'entity_type']));
      setEntityTypeSaving(false);
      return;
    }
    updateFirmClientProfile({
      clientId: selectedClient.id,
      profilePatch: {
        entity_type: entityTypeDraft.entity_type,
        ...(entityTypeDraft.incorporation_date ? { incorporation_date: entityTypeDraft.incorporation_date } : {})
      }
    }).then((snapshot) => {
      if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') onDatabaseSnapshot(snapshot);
    }).catch((error) => {
      console.error('Failed to save business legal form', error);
      setEntityTypeError(message('portal.error.saveLegalForm'));
    }).finally(() => setEntityTypeSaving(false));
  };
  const [whatsAppState, setWhatsAppState] = useState(() => previewState?.whatsAppState || null);
  const [whatsAppLink, setWhatsAppLink] = useState(() => previewState?.whatsAppLink || null);
  useEffect(() => {
    if (previewMode) {
      setWhatsAppState(previewState?.whatsAppState || null);
      setWhatsAppLink(previewState?.whatsAppLink || null);
      return undefined;
    }
    if (!liveDatabaseMode || !selectedClient?.id) return undefined;
    const controller = new AbortController();
    fetchWhatsAppBindingState({ clientId: selectedClient.id, signal: controller.signal }).then(setWhatsAppState).catch(() => setWhatsAppState(null));
    return () => controller.abort();
  }, [liveDatabaseMode, previewMode, previewState, selectedClient?.id]);
  // Telegram self-serve connect — same shape as the WhatsApp card above.
  // connect.start_command is the manual fallback when TELEGRAM_BOT_USERNAME
  // isn't configured (t_me_url null): the owner sends it to the bot directly.
  const [telegramState, setTelegramState] = useState(() => previewState?.telegramState || null);
  const [telegramConnect, setTelegramConnect] = useState(() => previewState?.telegramConnect || null);
  useEffect(() => {
    if (previewMode) {
      setTelegramState(previewState?.telegramState || null);
      setTelegramConnect(previewState?.telegramConnect || null);
      return undefined;
    }
    setTelegramConnect(null);
    if (!liveDatabaseMode || !selectedClient?.id) return undefined;
    const controller = new AbortController();
    fetchTelegramBindingState({ clientId: selectedClient.id, signal: controller.signal }).then(setTelegramState).catch(() => setTelegramState(null));
    return () => controller.abort();
  }, [liveDatabaseMode, previewMode, previewState, selectedClient?.id]);
  // Owner VAT-return card ("Donna prepares your return; you submit it to
  // HMRC"). The envelope is the server's whole verdict — flag stage (born
  // dark), jurisdiction, and prep refusals folded as data — so this surface
  // renders persisted state and never guesses. ownerVatReturnCardState decides
  // which refusals are the owner's to see; null renders nothing.
  const [ownerVatEnvelope, setOwnerVatEnvelope] = useState(() => previewState?.ownerVatEnvelope || null);
  useEffect(() => {
    if (previewMode) {
      setOwnerVatEnvelope(previewState?.ownerVatEnvelope || null);
      return undefined;
    }
    setOwnerVatEnvelope(null);
    if (!liveDatabaseMode || !selectedClient?.id) return undefined;
    const controller = new AbortController();
    fetchOwnerVatReturn({ clientId: selectedClient.id, signal: controller.signal }).then(setOwnerVatEnvelope).catch(() => setOwnerVatEnvelope(null));
    return () => controller.abort();
  }, [liveDatabaseMode, previewMode, previewState, selectedClient?.id]);
  const ownerVatCard = useMemo(() => ownerVatReturnCardState(ownerVatEnvelope), [ownerVatEnvelope]);

  // Row-17 wizard composition. The setup cards above each gate on PERSISTED
  // state; deriveSetupWizard only sequences the ones that are DUE into a
  // one-step-at-a-time flow (dependency order: the legal form decides whether
  // a fiscal year is even asked). Skips are session-local on purpose — setting
  // a step aside writes nothing, and the steps return next visit. With fewer
  // than two steps due the cards render as the plain stack they always were.
  // A BOUND channel is a settings card, not a step, so it stays visible below
  // regardless of the wizard; a pending (acting, unbound) channel folds into
  // the wizard's last step.
  const [setupSkipped, setSetupSkipped] = useState(() => new Set());
  useEffect(() => { setSetupSkipped(new Set()); }, [selectedClient?.id]);
  const whatsAppPending = databaseMode && Boolean(selectedClient?.id) && channelConnectPending(whatsAppState);
  const telegramPending = databaseMode && Boolean(selectedClient?.id) && channelConnectPending(telegramState);
  const setupWizard = deriveSetupWizard({
    due: {
      jurisdiction: showJurisdictionCard,
      entity_type: showEntityTypeCard,
      fiscal_period: showFiscalPeriodCard,
      gb_filing: showGbFilingCard,
      channel_connect: whatsAppPending || telegramPending
    },
    skipped: setupSkipped
  });
  const wizardOn = setupWizard.mode === 'wizard';
  // In wizard mode a due card renders only on its own step; in stack mode this
  // is a pass-through and every due card renders exactly as before.
  const setupStepVisible = (id) => !wizardOn || setupWizard.active?.id === id;
  const skipSetupStep = () => {
    if (setupWizard.active) setSetupSkipped((prev) => new Set([...prev, setupWizard.active.id]));
  };

  const completePreviewChannelStep = () => {
    setPreviewCompletedSetup((previous) => new Set([...previous, 'channel_connect']));
  };
  const disconnectWhatsApp = () => {
    if (previewMode) {
      setWhatsAppState((state) => ({ ...state, binding: null }));
      return;
    }
    revokeWhatsAppBinding({ clientId: selectedClient.id, bindingId: whatsAppState.binding.id })
      .then(() => setWhatsAppState((state) => ({ ...state, binding: null })));
  };
  const connectWhatsApp = () => {
    if (previewMode) {
      setWhatsAppState((state) => ({
        ...state,
        binding: { id: 'locale-preview-whatsapp', masked_phone: '+971 ••• ••• 2048' }
      }));
      setWhatsAppLink(null);
      completePreviewChannelStep();
      return;
    }
    createWhatsAppConnectToken({ clientId: selectedClient.id })
      .then((result) => setWhatsAppLink(result.wa_me_url));
  };
  const disconnectTelegram = () => {
    if (previewMode) {
      setTelegramState((state) => ({ ...state, binding: null }));
      return;
    }
    revokeTelegramBinding({ clientId: selectedClient.id, bindingId: telegramState.binding.id })
      .then(() => setTelegramState((state) => ({ ...state, binding: null })));
  };
  const connectTelegram = () => {
    if (previewMode) {
      setTelegramConnect({ start_command: '/start portal_ar2_preview', t_me_url: null });
      completePreviewChannelStep();
      return;
    }
    createTelegramConnectToken({ clientId: selectedClient.id }).then(setTelegramConnect);
  };

  const saveGbFilingFacts = () => {
    setGbFilingSaving(true);
    setGbFilingError('');
    if (previewMode) {
      setPreviewCompletedSetup((previous) => new Set([...previous, 'gb_filing']));
      setGbFilingSaving(false);
      return;
    }
    updateFirmClientProfile({
      clientId: selectedClient.id,
      profilePatch: {
        gb: {
          vat_stagger: Number(gbFilingDraft.vat_stagger),
          confirmation_review_period_end: gbFilingDraft.confirmation_review_period_end,
          accounting_period_end: gbFilingDraft.accounting_period_end
        }
      }
    }).then((snapshot) => {
      if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') onDatabaseSnapshot(snapshot);
    }).catch((error) => {
      console.error('Failed to save UK filing details', error);
      setGbFilingError(message('portal.error.saveFiling'));
    }).finally(() => setGbFilingSaving(false));
  };

  const beginEditName = () => {
    setNameDraft(selectedClient?.companyName || '');
    setNameError('');
    setEditingName(true);
  };
  const cancelEditName = () => {
    setEditingName(false);
    setNameError('');
  };
  const saveCompanyName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNameError(message('portal.error.businessNameRequired'));
      return;
    }
    if (trimmed === (selectedClient?.companyName || '')) {
      cancelEditName();
      return;
    }
    setNameSaving(true);
    setNameError('');
    updateFirmClientProfile({
      clientId: selectedClient.id,
      profilePatch: { companyName: trimmed }
    })
      .then((snapshot) => {
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
        setEditingName(false);
      })
      .catch((error) => {
        console.error('Failed to save business name', error);
        setNameError(message('portal.error.saveBusinessName'));
      })
      .finally(() => setNameSaving(false));
  };

  // Accounting-connector ("Xero access") tile CTA. The connector tile carries
  // id 'xero' regardless of the client's accounting_system; connectXero hits
  // /xero/connect, which dispatches server-side by that system and returns the
  // correct authorize URL (Xero or QBO). We redirect the browser to it; the
  // callback returns here (?xero=connected) so a full reload re-reads the
  // snapshot and drops the now-connected tile. The portal shares the firm
  // access token, so this is the same authed surface that already registers
  // documents — not a new auth path.
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState('');
  const handleConnectAccounting = () => {
    const cid = selectedClient?.id;
    if (!cid || connectBusy) return;
    if (!liveDatabaseMode) {
      setConnectError(message('portal.error.connectDemo'));
      return;
    }
    setConnectBusy(true);
    setConnectError('');
    const returnTo = typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}`
      : undefined;
    connectXero({ clientId: cid, returnTo })
      .then((data) => {
        if (!data?.authorizeUrl) throw new Error(message('portal.error.connectMissingUrl'));
        window.location.assign(data.authorizeUrl);
      })
      .catch((error) => {
        setConnectError(error?.message || message('portal.error.connect'));
        setConnectBusy(false);
      });
  };

  // Returning from the OAuth callback (?xero=connected / ?qbo=connected): the
  // connector tile is already gone once the full-page reload re-reads the
  // snapshot, but nudge a refresh in case it was cached and strip the transient
  // flag so it doesn't linger in the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('xero') || params.get('qbo');
    if (!flag) return;
    if (flag === 'connected' && typeof onSnapshotInvalidated === 'function') {
      onSnapshotInvalidated();
    }
    const url = new URL(window.location.href);
    ['xero', 'xero_tenants', 'qbo', 'qbo_realm'].forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effectiveTiles = useMemo(() => {
    // Phase 1.5 — an unscoped client (explicit empty services_engaged) shows
    // a placeholder instead of any tiles; suppress both document tiles and
    // the connector tile until the firm scopes the engagement.
    // Service-driven document tiles. The connector tile ('xero') is NOT a
    // service — it's derived from accounting_system below — so drop any
    // static 'xero' tile here and re-add it from connectorTile. This also
    // decouples it from the service filter (which never contained 'xero').
    const documentTiles = portalUnscoped || liveDatabaseMode
      ? []
      : (portalTileState.tiles
          ? TILES.filter((tile) => portalTileState.tiles.has(tile.id))
          : TILES
        ).filter((tile) => tile.id !== 'xero');
    const connectorIds = PORTAL_CONNECTOR_MESSAGE_IDS[connectorPresentationKey]
      || PORTAL_CONNECTOR_MESSAGE_IDS.default;
    const filtered = (!portalUnscoped && connectorTile)
      ? [...documentTiles, {
          ...connectorTile,
          ...connectorIds,
          state: 'missing',
          statusId: 'portal.tile.status.missing',
          dismissible: true
        }]
      : documentTiles;
    const withState = databaseMode
      ? filtered.map((tile) => ({
          ...tile,
          state: 'missing',
          statusDetailId: undefined,
          statusId: 'portal.tile.status.missing',
          ctaId: tile.id === 'xero' ? tile.ctaId : 'portal.tile.action.upload'
        }))
      : filtered;
    // Phase 2a — apply jurisdiction-aware copy overrides via the
    // shared TILE_COPY map. Only payroll varies today; the rest of the
    // tiles use their static copy from TILES[].
    const withJurisdictionCopy = withState.map((tile) => {
      if (tile.id !== 'payroll') return tile;
      const [titleId, descId] = PORTAL_PAYROLL_MESSAGE_IDS[clientJurisdiction]
        || PORTAL_PAYROLL_MESSAGE_IDS.default;
      return { ...tile, titleId, descId };
    });
    return withJurisdictionCopy.map((tile) => {
      const isDismissed = dismissedTiles.has(tile.id);
      const periodVars = {
        period: <FormattedValue>{periodLabel}</FormattedValue>,
        periodTitle: <FormattedValue>{periodTitle}</FormattedValue>
      };
      const descriptionId = isDismissed && tile.dismissedDescId
        ? tile.dismissedDescId
        : tile.descId;
      return {
        ...tile,
        isDismissed,
        title: message(tile.titleId),
        descResolved: descriptionId
          ? message(descriptionId, periodVars)
          : '',
        statusDetailResolved: tile.statusDetailId
          ? message(tile.statusDetailId, {
              receivedAccounts: <IdentifierText>BBVA EUR</IdentifierText>,
              ...periodVars
            })
          : undefined,
        statusLabel: message(tile.statusId || 'portal.tile.status.missing'),
        cta: message(tile.ctaId || 'portal.tile.action.upload'),
        dismissLabel: message(tile.dismissId || 'portal.tile.notApplicable'),
        received: tile.state === 'received'
      };
    });
  }, [portalTileState, portalUnscoped, connectorTile, connectorPresentationKey, clientJurisdiction, databaseMode, liveDatabaseMode, dismissedTiles, periodLabel, periodTitle, intl]);
  // Demo tiles and real connector setup leave the task count when received
  // or dismissed. This count is never a live book/period completion verdict.
  const tileIsComplete = (tile) => tile.state === 'received' || tile.isDismissed;
  const documentReceipt = useMemo(() => summarizePortalDocuments({ documents: visibleUploads, clientId: selectedClient?.id }), [visibleUploads, selectedClient?.id]);
  const receivedTilesCount = effectiveTiles.filter(tileIsComplete).length;
  const neededTilesCount = effectiveTiles.length - receivedTilesCount;
  // Hide the pre-populated BBVA "uploaded file" card and the fake "30 Apr at
  // 18:48" timestamp on a fresh server. Local-demo mode keeps them so the
  // accountant-portal hand-off is visible end-to-end.
  const showLegacyActivityFixture = !databaseMode || Boolean(previewState?.activity);
  const activityFixture = previewState?.activity || {
    filename: 'BBVA · ASR EUR · 2023-11 → 2025-03',
    extension: 'PDF',
    size: 62 * 1024,
    transactionCount: 143,
    uploadedAt: '2025-04-30T18:48:00Z'
  };

  // Single-open expansion key for the master "what I still need"
  // list. Strings of the form `q-${question.id}` for question rows
  // and `t-${tile.id}` for file-group rows. Clicking a collapsed
  // row sets the key; clicking the same row collapses it; clicking
  // another row replaces it (single-open, like an accordion). The
  // expanded panel branches on the prefix to render either the
  // question's InlineReply or the tile's detail + actions.
  const [expandedKey, setExpandedKey] = useState(null);
  // Second axis of expansion — which sub-question inside an open group
  // is showing its reply form. Cleared whenever the top-level key
  // changes (a different row opens, or the open row closes), so a
  // stale sub-key can never out-live its parent group.
  const [expandedSubKey, setExpandedSubKey] = useState(null);
  // Per-question reply state, keyed by question id, so one slow evidence-request
  // resolve no longer freezes the whole questionnaire — a client can open and
  // answer the next question while an earlier send is still in flight.
  const [replyBusyById, setReplyBusyById] = useState({});
  const [replyErrorById, setReplyErrorById] = useState({});
  const isReplyBusy = (questionId) => Boolean(replyBusyById[questionId]);
  const replyErrorFor = (questionId) => replyErrorById[questionId] || '';
  const [uploadMessage, setUploadMessage] = useState(() => previewState?.uploadError || '');
  const [uploadBusy, setUploadBusy] = useState(false);
  // Per-row download state for the § 03 "Your uploads" list (DB mode).
  // Tracks the document id currently downloading so its row button shows
  // progress + disables (one at a time), plus the latest download error.
  const [downloadingDocId, setDownloadingDocId] = useState('');
  const [downloadError, setDownloadError] = useState(() => previewState?.downloadError || '');
  // Document workspace tab (DB mode only): "upload" = drop zone + live
  // tray, "previous" = the historical uploads list. Default "upload"
  // keeps the primary action visible on load. In local-demo mode there's
  // no history, so no tabs render and the drop zone shows standalone.
  const [docTab, setDocTab] = useState('upload');
  const showUploadPane = !databaseMode || docTab === 'upload';
  const showPreviousPane = databaseMode && docTab === 'previous';
  // Staged-batch upload state. Files added via drag-drop or the
  // browse button accumulate here until the user clicks "Upload" —
  // this lets owners assemble a multi-file batch one drop at a time
  // (you almost always grab a few statements from one folder, then
  // a few receipts from another) rather than being forced to pick
  // everything in a single file picker invocation.
  const [stagedFiles, setStagedFiles] = useState([]);
  const [stagedError, setStagedError] = useState(() => previewState?.stagedError || '');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // Drag-leave fires when the cursor moves over a child element too,
  // so we use a counter to track "really left the drop zone" vs
  // "just crossed into a child."
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef(null);
  const registeredEvidenceRef = useRef(new WeakMap());
  // Mobile gets a dedicated camera affordance — capture="environment"
  // jumps straight to the rear camera, the 30-second receipt path.
  // The cell only renders below the md breakpoint so desktop browsers
  // (where the picker would just open as image-only) don't show it.
  const cameraInputRef = useRef(null);
  useEffect(() => {
    if (!previewMode) return;
    setUploadMessage(previewState?.uploadError || '');
    setDownloadError(previewState?.downloadError || '');
    setStagedError(previewState?.stagedError || '');
  }, [previewMode, previewState]);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => setIsMobile(mq.matches);
    update();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);
  const questionCount = questions.length;
  const hasLiveQuestions = questionCount > 0;
  // Master "things from you" count used by the page hero and the
  // mobile sticky bar. Sums outstanding tile groups (anything not
  // already received — partial still counts as work) plus open
  // questions.
  const totalThingsNeeded = neededTilesCount + questionCount;
  // An unscoped client whose book already has movement (transactions,
  // documents, open questions) is mid-engagement — the "Let's set up
  // your books" onboarding hero reads absurd there (sighted on
  // Honeybee with a 45-document book). Reserve onboarding copy for a
  // genuinely empty book; an active-but-unscoped book falls through
  // to the normal needs-driven headline and gets a calmer placeholder
  // below.
  const bookActive = clientTransactions.length > 0 || clientDocumentCount > 0 || hasLiveQuestions;
  const showOnboardingHero = portalUnscoped && !bookActive;

  // The unified row list — questions (possibly grouped) followed by
  // outstanding tiles. Derived from the same inputs the per-row
  // chrome reads, so a question being resolved / a tile being
  // dismissed cascades through everything in one render.
  const listItems = useMemo(
    () => buildListItems({
      questions,
      effectiveTiles,
      tileIsComplete,
      formatMessage: intl.formatMessage
    }),
    [questions, effectiveTiles, dismissedTiles, intl]
  );

  // Close the expanded panel if its underlying item went away — a
  // question got resolved server-side, a tile got dismissed /
  // received / filtered out, or a group dissolved because its run
  // dropped below the threshold. Prevents a stale panel hanging open
  // with no anchor.
  useEffect(() => {
    if (!expandedKey) return;
    const stillExists = listItems.some((item) => item.key === expandedKey);
    if (!stillExists) {
      setExpandedKey(null);
      return;
    }
    if (!expandedSubKey) return;
    const parent = listItems.find((item) => item.key === expandedKey);
    if (parent?.type !== 'group') {
      setExpandedSubKey(null);
      return;
    }
    const subStillThere = parent.questions.some((q) => `q-${q.id}` === expandedSubKey);
    if (!subStillThere) setExpandedSubKey(null);
  }, [expandedKey, expandedSubKey, listItems]);

  const toggleExpanded = (key) => {
    setExpandedKey((prev) => (prev === key ? null : key));
    setExpandedSubKey(null);
  };

  const toggleSubExpanded = (key) => {
    setExpandedSubKey((prev) => (prev === key ? null : key));
  };

  // Start a tray batch for each upload session so the tray can show
  // per-file progress. Tray rows live in localStorage (see
  // src/lib/uploadTray.js) and the BE writes parse_status async; here
  // we only stamp the local stages (uploading → uploaded → registered)
  // and the tray's polling loop fills in the BE state.
  const persistEvidenceFiles = async ({ question, reply, files = [] }) => {
    if (!selectedClient || !files.length) return [];
    assertUploadBatchSize(files, intl.formatMessage);
    if (previewMode) {
      return Array.from(files).map((file, index) => ({
        id: `locale-preview-document-${index + 1}`,
        client_id: selectedClient.id,
        filename: file?.name || message('portal.documents.defaultName'),
        document_type: classifyDocumentFile({ filename: file?.name || '', type: file?.type }) || 'unknown',
        file_size: Number(file?.size || 0),
        source: question?.evidence_request_id ? 'client_evidence_reply' : 'client_upload',
        client_reply: reply || ''
      }));
    }
    const uploadScope = JSON.stringify([getBookSessionIdentity(), selectedClient.id,
      question?.evidence_request_id || null, question?.transaction_id || null]);
    const batchId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const batchState = startTrayBatch({
      batchId,
      clientId: selectedClient.id,
      files: Array.from(files).map((file) => ({
        filename: file?.name || 'file',
        size: Number(file?.size || 0),
        // Seed the row with the same FE classifier the actual
        // registration request will use. Storing `null` here meant the
        // tray row started life as `unknown`, and a network blip between
        // the local insert and the /register call left an orphan row
        // that would later retry as `unknown` → server dispatched to
        // generic_document → bank feed empty (the pilot client's Airwallex case).
        // Seeding the classifier output keeps the row honest from the
        // first paint and survives the retry path.
        document_type: classifyDocumentFile({ filename: file?.name || 'file', type: file?.type }) || null
      }))
    });
    const batchRows =
      batchState.batches?.find((batch) => batch.id === batchId)?.rows || [];
    // Bounded concurrency, not Promise.all: an all-at-once PUT burst is what
    // pushed the desktop runtime over on the 2026-08-31 multi-file drop.
    // Per-file outcomes are kept, never swallowed: a file that fails to
    // upload fails the SEND (requireEveryEvidenceFile), so the owner's reply
    // cannot leave without its evidence and read back as an empty "Still
    // open after …" turn with nothing in the app (the 2026-09-04 Shopify
    // settlement case). The tray row already carries each file's own error
    // text; the question shows the first one.
    const uploadOutcomes = await mapWithConcurrency(
      Array.from(files),
      UPLOAD_CONCURRENCY,
      async (file, index) => {
        const cached = registeredEvidenceRef.current.get(file);
        const needsFreshUpload = cached?.scope === uploadScope && loadTrayState().batches.some(batch =>
          batch.rows.some(row => row.storage_object_key === cached.document.storage_object_key
            && registrationRequiresFreshUpload(row.register_error_code)));
        if (cached?.scope === uploadScope && !needsFreshUpload) {
          // Retry the same authorized registration intent, not a fresh upload
          // that would create a duplicate-resolution case for landed evidence.
          const doc = cached.document;
          setRowUploaded({ rowId: batchRows[index]?.row_id,
            storageBucket: doc.storage_bucket, storageObjectKey: doc.storage_object_key,
            checksum: doc.checksum_sha256, storedSize: doc.file_size, mimeType: doc.mime_type });
          return { document: doc };
        }
        return buildEvidenceDocument({
          file,
          clientId: selectedClient.id,
          question,
          reply,
          index,
          trayRowId: batchRows[index]?.row_id,
          formatMessage: intl.formatMessage
        }).then((document) => {
          // A successful PUT already has an authorized, reusable storage key.
          // Keep it even if registration only commits a prefix of this batch.
          registeredEvidenceRef.current.set(file, { scope: uploadScope, document });
          return { document };
        }, (error) => ({ error }));
      }
    );
    // Successful storage siblings are independently uploaded evidence. Queue
    // them even if another file failed; the all-files guard below still
    // prevents sending any partial owner reply.
    const cleanDocuments = uploadOutcomes.map((outcome) => outcome.document).filter(Boolean);
    if (!cleanDocuments.length) {
      return requireEveryEvidenceFile(uploadOutcomes, { fallbackMessage: message('portal.error.upload') });
    }

    if (firmDataSource !== 'database' && typeof setDocuments === 'function') {
      setDocuments((prev = []) => [
        ...cleanDocuments,
        ...prev.filter((document) => !cleanDocuments.some((next) => next.id === document.id))
      ]);
    }

    if (firmDataSource === 'database') {
      let registeredDocs = [];
      try {
        const response = await registerFirmDocuments({
          documents: cleanDocuments.map((doc) => ({
            id: doc.id,
            client_id: doc.client_id,
            filename: doc.filename,
            document_type: doc.document_type,
            uploaded_at: doc.uploaded_at,
            source: doc.source,
            storage_bucket: doc.storage_bucket,
            storage_object_key: doc.storage_object_key,
            checksum_sha256: doc.checksum_sha256,
            evidence_request_id: doc.evidence_request_id,
            transaction_id: doc.transaction_id,
            client_reply: doc.client_reply,
            evidence_context: doc.evidence_context,
            file_storage: doc.file_storage,
            batch_id: batchId
          }))
        });
        registeredDocs = response?.documents || [];
      } catch (err) {
        // Registration commits each file independently. Preserve the canonical
        // prefix before exposing the remaining same-key retries to the tray.
        registeredDocs = (err?.body?.partial_results || []).map((entry) => entry?.document);
        cleanDocuments.forEach((doc, idx) => {
          const slot = uploadOutcomes.findIndex((outcome) => outcome.document === doc);
          const rowId = batchRows[slot]?.row_id;
          const registered = registeredDocs[idx];
          if (registered?.id && registered.client_id === doc.client_id
            && registered.storage_bucket === doc.storage_bucket
            && registered.storage_object_key === doc.storage_object_key) {
            setRowRegistered({ rowId, document: registered });
            registeredEvidenceRef.current.set(Array.from(files)[slot], {
              scope: uploadScope, document: { ...doc, id: registered.id }
            });
          } else if (rowId) {
            setRowRegisterFailed({ rowId, message: err?.message || message('portal.error.queueParse'), code: err?.code });
            if (registrationRequiresFreshUpload(err?.code)) registeredEvidenceRef.current.delete(Array.from(files)[slot]);
          }
        });
        if (typeof setDocuments === 'function') {
          const landed = cleanDocuments.flatMap((doc, idx) => {
            const registered = registeredDocs[idx];
            return registered?.id && registered.client_id === doc.client_id
              && registered.storage_bucket === doc.storage_bucket && registered.storage_object_key === doc.storage_object_key
              ? [{ ...doc, ...registered }] : [];
          });
          setDocuments((prev = []) => [...landed, ...prev.filter(doc => !landed.some(next => next.id === doc.id))]);
        }
        // A background registration recovery is never permission to send a
        // partially completed owner reply. The owner must retry that action.
        throw err;
      }
      cleanDocuments.forEach((doc, idx) => {
        const slot = uploadOutcomes.findIndex((outcome) => outcome.document === doc);
        const trayRowId = batchRows[slot]?.row_id;
        const registered = registeredDocs[idx];
        if (trayRowId && registered) {
          setRowRegistered({ rowId: trayRowId, document: registered });
          registeredEvidenceRef.current.set(Array.from(files)[slot], { scope: uploadScope, document: { ...doc, id: registered.id } });
          cleanDocuments[idx] = { ...doc, id: registered.id };
        } else if (trayRowId) {
          setRowRegisterFailed({ rowId: trayRowId, message: message('portal.error.queueParse') });
        }
      });
      if (typeof setDocuments === 'function') {
        const landed = registeredDocs.map((doc, idx) => ({ ...cleanDocuments[idx], ...doc }));
        setDocuments((prev = []) => [...landed, ...prev.filter(doc => !landed.some(next => next.id === doc.id))]);
      }
      // One registered document per document sent, or the send fails here.
      requireEveryRegistration(cleanDocuments, registeredDocs, {
        fallbackMessage: message('portal.error.queueParse')
      });
    }
    requireEveryEvidenceFile(uploadOutcomes, { fallbackMessage: message('portal.error.upload') });
    return cleanDocuments;
  };

  const submitReply = async ({ question, reply, files = [], expansionKey = null }) => {
    if (!question) return;
    const questionId = question.id;
    // Per-question duplicate-submit guard — a second send of the SAME question is
    // ignored, but other questions stay free to send concurrently.
    if (replyBusyById[questionId]) return;
    setReplyBusyById((prev) => ({ ...prev, [questionId]: true }));
    setReplyErrorById((prev) => (prev[questionId] ? { ...prev, [questionId]: '' } : prev));
    try {
      const uploadedDocuments = await persistEvidenceFiles({ question, reply, files });
      if (firmDataSource === 'database' && question.evidence_request_id) {
        const snapshot = await resolveClientEvidenceRequest({
          evidenceRequestId: question.evidence_request_id,
          reply,
          documentIds: uploadedDocuments.map((document) => document.id),
          resolutionNote: uploadedDocuments.length
            ? 'Client replied from portal with supporting evidence.'
            : 'Client replied from portal.'
        });
        if (snapshot?.source === 'database' && typeof onDatabaseSnapshot === 'function') {
          onDatabaseSnapshot(snapshot);
        }
      }
      // Close ONLY the question that initiated this send: a slow resolve must not
      // collapse a different question the client opened while it was in flight.
      setExpandedKey((prev) => (prev === expansionKey ? null : prev));
      setExpandedSubKey((prev) => (prev === expansionKey ? null : prev));
    } catch (error) {
      setReplyErrorById((prev) => ({
        ...prev,
        [questionId]: error?.message || message('portal.error.sendAnswer')
      }));
    } finally {
      setReplyBusyById((prev) => {
        if (!prev[questionId]) return prev;
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    }
  };

  // Identity key for dedupe — same name + size + lastModified is
  // almost certainly the same file picked twice. Not a perfect hash
  // (two distinct files could collide) but cheap and good enough to
  // catch the common "accidentally clicked Browse again" case.
  const fileStagingKey = (file) =>
    `${file?.name || ''}::${Number(file?.size || 0)}::${Number(file?.lastModified || 0)}`;

  // Append files to the staged list, deduping against what's already
  // there and enforcing the batch-size cap so a user can't quietly
  // assemble a 50MB batch that fails on submit.
  const addStagedFiles = (incoming) => {
    setStagedError('');
    const candidates = Array.from(incoming || []).filter(Boolean);
    if (!candidates.length) return;
    setStagedFiles((prev) => {
      const seen = new Set(prev.map((entry) => entry.key));
      const next = [...prev];
      for (const file of candidates) {
        const key = fileStagingKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ key, file });
      }
      const total = next.reduce((sum, entry) => sum + Number(entry.file?.size || 0), 0);
      if (total > MAX_EVIDENCE_UPLOAD_BYTES) {
        setStagedError(
          message('portal.error.totalTooLarge', {
            total: formatFileSize(total, intl.formatMessage),
            limit: formatFileSize(MAX_EVIDENCE_UPLOAD_BYTES, intl.formatMessage)
          })
        );
      }
      return next;
    });
  };

  const removeStagedFile = (key) => {
    setStagedError('');
    setStagedFiles((prev) => {
      const next = prev.filter((entry) => entry.key !== key);
      const total = next.reduce((sum, entry) => sum + Number(entry.file?.size || 0), 0);
      // Recompute the size warning so removing files clears a stale
      // "over limit" error without waiting for another change.
      if (total > MAX_EVIDENCE_UPLOAD_BYTES) {
        setStagedError(
          message('portal.error.totalTooLarge', {
            total: formatFileSize(total, intl.formatMessage),
            limit: formatFileSize(MAX_EVIDENCE_UPLOAD_BYTES, intl.formatMessage)
          })
        );
      }
      return next;
    });
  };

  const clearStagedFiles = () => {
    setStagedFiles([]);
    setStagedError('');
  };

  const handleIntakeUpload = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    addStagedFiles(files);
  };

  // Re-download a source document's original via the short-lived signed
  // URL (assertFirmAccess + audit happen server-side). One at a time; the
  // failure surfaces inline rather than disappearing into a catch.
  const handleDownloadDocument = async (doc) => {
    if (!doc?.id || downloadingDocId) return;
    setDownloadingDocId(doc.id);
    setDownloadError('');
    if (previewMode) {
      setDownloadingDocId('');
      return;
    }
    try {
      await downloadFirmDocument({ documentId: doc.id });
    } catch (err) {
      setDownloadError(formatFirmError(err, message('portal.error.download')));
    } finally {
      setDownloadingDocId('');
    }
  };

  const handleDropZoneDragEnter = (event) => {
    event.preventDefault();
    if (uploadBusy) return;
    dragDepthRef.current += 1;
    setIsDraggingOver(true);
  };

  const handleDropZoneDragOver = (event) => {
    // Required for onDrop to fire on a non-input element.
    event.preventDefault();
    if (!uploadBusy && event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDropZoneDragLeave = (event) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingOver(false);
  };

  const handleDropZoneDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingOver(false);
    if (uploadBusy) return;
    const dropped = Array.from(event.dataTransfer?.files || []);
    if (!dropped.length) return;
    addStagedFiles(dropped);
  };

  const submitStagedFiles = async () => {
    if (!selectedClient || !stagedFiles.length || uploadBusy) return;
    const filesToUpload = stagedFiles.map((entry) => entry.file);
    try {
      assertUploadBatchSize(filesToUpload, intl.formatMessage);
    } catch (sizeErr) {
      setStagedError(sizeErr?.message || message('portal.error.batchTooLarge'));
      return;
    }
    setUploadBusy(true);
    setStagedError('');
    setUploadMessage('');
    try {
      await persistEvidenceFiles({
        question: { kind: 'Evidence', text: 'General client-uploaded close evidence.' },
        reply: '',
        files: filesToUpload
      });
      // No success copy — the inline tray below already lists every
      // file with live progress and a status label. A second mono-caps
      // "X files sent" line just repeats what the tray shows.
      clearStagedFiles();
    } catch (error) {
      setUploadMessage(error?.message || message('portal.error.uploadFile'));
    } finally {
      setUploadBusy(false);
    }
  };

  const stagedTotalBytes = stagedFiles.reduce(
    (sum, entry) => sum + Number(entry.file?.size || 0),
    0
  );
  const stagedOverLimit = stagedTotalBytes > MAX_EVIDENCE_UPLOAD_BYTES;
  const canSubmitStaged =
    stagedFiles.length > 0 && !uploadBusy && !stagedOverLimit && Boolean(selectedClient);

  return (
    <div
      className="donna-portal"
      style={{
        ...D.grainBg(),
        color: D.ink,
        fontFamily: D.body,
        minHeight: '100vh'
      }}
    >
      <style>{`
        /* The client portal uses the D (paper/ink) system, so its keyboard
           focus ring is ink — not the operator surfaces' warm --focus-ring
           (defined in :root). Scoping the variable here recolours every
           button / link / [role=button] ring the global :focus-visible rule
           already draws inside the portal; the input/textarea rule below
           covers the text fields that global selector doesn't match. */
        .donna-portal { --focus-ring: ${D.ink}; }
        .donna-portal :where(input, textarea):focus-visible {
          outline: 2px solid var(--focus-ring);
          outline-offset: 2px;
        }
        /* Hover affordance on the expand/collapse list rows — a faint ink
           wash that adapts to whatever paper/card surface the row sits on,
           so a client scanning the list gets an "about to open" cue. The
           rows carry no inline background, so this CSS hover applies. */
        .donna-portal__row { transition: background-color 140ms ${D.ease}; }
        .donna-portal__row:hover { background: oklch(0.08 0 0 / 0.05); }
        /* An already-open row isn't an "about to open" target, so drop the
           hover wash while it's expanded — the cue would just add noise over
           the revealed panel. */
        .donna-portal__row--open:hover { background: transparent; }
      `}</style>
      {/* Mobile-only sticky action strip. Sits above the utility strip
          on small viewports so the master task and its two action
          quick-links stay reachable while the client scrolls through
          the dossier. Hidden on desktop because the hero already
          owns the action affordance and the masthead is short enough
          to keep the same context in view. Also hidden when there's
          nothing outstanding so it doesn't ride along for free. */}
      {isMobile && totalThingsNeeded > 0 && (
        <div
          style={{
            position: 'sticky',
            insetBlockStart: 0,
            zIndex: 20,
            backgroundColor: D.paper,
            borderBottom: `1px solid ${D.rule}`,
            padding: '0.6rem clamp(1rem, 4vw, 1.5rem)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            flexWrap: 'wrap'
          }}
        >
          <span
            style={{
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              color: D.ink,
              fontWeight: 500,
              marginInlineEnd: 'auto'
            }}
          >
            {intl.formatMessage({ id: 'portal.mobile.fromYou' }, { count: totalThingsNeeded })}
          </span>
          <a
            href="#ask"
            onClick={(e) => {
              e.preventDefault();
              setDocTab('upload');
              document.getElementById('ask')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            style={{
              ...D.noiseGold(),
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              fontWeight: 500,
              padding: '0.4rem 0.85rem',
              border: `1px solid ${D.ink}`,
              color: D.ink,
              textDecoration: 'none'
            }}
          >
            {intl.formatMessage({ id: 'portal.mobile.upload' })}
          </a>
          {questionCount > 0 && (
            <a
              href="#list"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById('list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              style={{
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                fontWeight: 500,
                padding: '0.4rem 0.85rem',
                border: `1px solid ${D.ink}`,
                background: 'transparent',
                color: D.ink,
                textDecoration: 'none'
              }}
            >
              {intl.formatMessage({ id: 'portal.mobile.answer' })}
            </a>
          )}
        </div>
      )}
      <div
        style={{
          maxWidth: D.container,
          margin: '0 auto',
          padding: 'clamp(2rem, 5vw, 3.5rem) clamp(1.5rem, 4vw, 2.5rem) clamp(4rem, 10vw, 6rem)'
        }}
      >
        {/* Top utility strip — wide-tracked mono, hairline divider beneath.
            Firm identity left ("DONNA" is the brand clients hire;
            "books.example" is just the underlying platform / support inbox),
            help/locale right. Editorial framing. */}
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '0.75rem 1.5rem',
            paddingBottom: '1rem',
            borderBottom: `1px solid ${D.rule}`,
            fontFamily: D.mono,
            fontSize: 11,
            letterSpacing: D.tracking.mono,
            textTransform: 'uppercase',
            color: D.inkSoft
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.75em' }}>
            {/* DONNA wordmark — Anton, uppercase, tight tracking
                (-0.05em), line-height 0.85, ink-on-paper. Matches the
                marketing site's wordmark spec so the client portal
                masthead reads as the same brand instead of "small mono
                caps text that happens to spell Donna". The display
                font here intentionally breaks out of the surrounding
                mono utility strip — the strip is system chrome, the
                wordmark is the firm identity. */}
            <span
              style={{
                fontFamily: D.display,
                fontWeight: 400,
                fontSize: 22,
                letterSpacing: '-0.05em',
                lineHeight: 0.85,
                textTransform: 'uppercase',
                color: D.ink
              }}
            >
              Donna
            </span>
            <span aria-hidden="true">·</span>
            <span>{intl.formatMessage({ id: 'portal.documentsIntake' })}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.5rem 1.25rem', marginInlineStart: 'auto', minWidth: 0, maxWidth: '100%' }}>
          {/* Interface language — the owner's own choice, saved on this device;
              once made it wins over the portal's default (the owner's language,
              src/i18n/portalInterfaceLocale.js). Labels come from the registry:
              each ready locale's production label, alpha status included. */}
          <select
            value={interfaceLocale}
            onChange={(event) => setInterfaceLocale(event.target.value)}
            aria-label={message('settings.language.interface.label')}
            data-portal-language
            style={{
              appearance: 'none',
              background: 'none',
              border: 'none',
              borderBottom: `1px solid ${D.rule}`,
              borderRadius: 0,
              padding: 0,
              maxWidth: '100%',
              cursor: 'pointer',
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              color: D.inkSoft
            }}
          >
            {PRODUCTION_INTERFACE_LOCALES.map((entry) => (
              <option key={entry.tag} value={entry.tag} lang={entry.tag}>
                {entry.productionLabel}
              </option>
            ))}
          </select>
          {/* Sign out — clears the stored Supabase session + any Donna access
              token, then returns to the public landing. The owner's only exit
              from the portal; without it a shared/owned device stays logged in. */}
          <button
            type="button"
            onClick={() => {
              clearFirmAccess();
              window.location.assign('/');
            }}
            style={{
              appearance: 'none',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              color: D.inkSoft,
              borderBottom: `1px solid ${D.rule}`
            }}
          >
            {intl.formatMessage({ id: 'portal.logOut' })}
          </button>
          </span>
        </header>

        {/* Hierarchy pivot — task leads, identity becomes context.
            Client name shrinks to a small mono strip ABOVE the headline
            because the client knows who they are; what they don't know
            is what they owe. Big Anton H1 is now the master task:
            "I need N things before I can close {period}." Action quick
            links underneath jump to the drop zone or the open requests
            via in-page anchors so the client doesn't have to scroll
            blind to find the work. */}
        <section
          style={{
            padding: 'clamp(2rem, 5vw, 3rem) 0 clamp(1.5rem, 3vw, 2rem)',
            borderBottom: `1px solid ${D.rule}`
          }}
        >
          {/* Identity context strip — small mono caps. Drops the venture
              name + period + "last from Kari" into one wide-tracked
              line, then the task lands underneath. Margin-bottom
              tightened so the H1 sits closer to the strip and the
              whole hero block reads as one visual unit instead of
              four stacked elements with redundant spacing. */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem 1.5rem',
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              color: D.inkSoft,
              marginBottom: 'clamp(0.75rem, 2vw, 1rem)'
            }}
          >
            {editingName ? (
              // Inline rename editor — keeps the mono/caps strip styling so
              // it reads as an in-place edit of the name, not a modal.
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={nameDraft}
                  autoFocus
                  disabled={nameSaving}
                  maxLength={200}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveCompanyName();
                    if (event.key === 'Escape') cancelEditName();
                  }}
                  aria-label={intl.formatMessage({ id: 'portal.businessName.label' })}
                  dir="auto"
                  style={{
                    fontFamily: D.mono,
                    fontSize: 11,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    color: D.ink,
                    background: 'none',
                    border: 'none',
                    borderBottom: `1px solid ${D.ink}`,
                    padding: '0 0 2px',
                    minWidth: '12ch'
                  }}
                />
                <button
                  type="button"
                  onClick={saveCompanyName}
                  disabled={nameSaving}
                  style={{
                    appearance: 'none', background: 'none', border: 'none', padding: 0,
                    cursor: nameSaving ? 'default' : 'pointer', fontFamily: D.mono, fontSize: 11,
                    letterSpacing: D.tracking.mono, textTransform: 'uppercase', color: D.ink,
                    borderBottom: `1px solid ${D.rule}`
                  }}
                >
                  {intl.formatMessage({ id: nameSaving ? 'portal.businessName.saving' : 'portal.businessName.save' })}
                </button>
                <button
                  type="button"
                  onClick={cancelEditName}
                  disabled={nameSaving}
                  style={{
                    appearance: 'none', background: 'none', border: 'none', padding: 0,
                    cursor: 'pointer', fontFamily: D.mono, fontSize: 11,
                    letterSpacing: D.tracking.mono, textTransform: 'uppercase', color: D.inkSoft
                  }}
                >
                  {intl.formatMessage({ id: 'portal.businessName.cancel' })}
                </button>
                {nameError && <span style={{ color: D.inkSoft }}>{nameError}</span>}
              </span>
            ) : canEditName ? (
              // Click the name to rename. Hairline underline signals it's editable.
              <button
                type="button"
                onClick={beginEditName}
                title={intl.formatMessage({ id: 'portal.businessName.edit' })}
                style={{
                  appearance: 'none', background: 'none', border: 'none', padding: 0,
                  cursor: 'pointer', fontFamily: D.mono, fontSize: 11,
                  letterSpacing: D.tracking.mono, textTransform: 'uppercase',
                  color: D.ink, fontWeight: 500, borderBottom: `1px dotted ${D.rule}`
                }}
              >
                <BidiText direction="auto">{ventureLabel}</BidiText>
              </button>
            ) : (
              <BidiText direction="auto" style={{ color: D.ink, fontWeight: 500 }}>{ventureLabel}</BidiText>
            )}
            <span>
              {periodSpecific
                ? intl.formatMessage(
                    { id: 'portal.books.period' },
                    { period: <FormattedValue>{periodLabel}</FormattedValue> }
                  )
                : intl.formatMessage({ id: 'portal.books.all' })}
            </span>
            {lastContactRelative && (
              <span>
                {intl.formatMessage(
                  { id: 'portal.lastContact' },
                  { relative: <BidiText direction="auto">{lastContactRelative}</BidiText> }
                )}
              </span>
            )}
          </div>
          <h1
            style={{
              fontFamily: direction === 'rtl' ? D.body : D.display,
              fontWeight: direction === 'rtl' ? 650 : 400,
              fontSize: direction === 'rtl'
                ? D.displayClamp(2, 5, 4)
                : D.displayClamp(2.5, 8.5, 6),
              lineHeight: direction === 'rtl' ? 1.12 : D.leading.displayLoose,
              letterSpacing: direction === 'rtl' ? 'normal' : D.tracking.tighter,
              textTransform: direction === 'rtl' ? 'none' : 'uppercase',
              overflowWrap: 'anywhere',
              margin: 0,
              color: D.ink
            }}
          >
            {liveDatabaseMode && totalThingsNeeded === 0
              ? message(clientDocumentCount === 0 ? 'portal.documents.receipt.start' : 'portal.documents.receipt.noQuestions')
              : showOnboardingHero
              ? intl.formatMessage({ id: 'portal.hero.setup' })
              : totalThingsNeeded === 0
                ? (periodSpecific
                    ? intl.formatMessage(
                        { id: 'portal.hero.clearPeriod' },
                        { period: <FormattedValue>{periodLabel}</FormattedValue> }
                      )
                    : intl.formatMessage({ id: 'portal.hero.clearBooks' }))
                : (
                    <>
                      {intl.formatMessage({ id: 'portal.hero.needLead' })}{' '}
                      <span
                        style={{
                          backgroundImage: `linear-gradient(100deg, ${D.accentWarmFlat}, oklch(0.58 0.18 30))`,
                          WebkitBackgroundClip: 'text',
                          backgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          color: 'transparent'
                        }}
                      >
                        {intl.formatMessage({ id: 'portal.hero.thingCount' }, { count: totalThingsNeeded })}
                      </span>
                      {' '}
                      {periodSpecific
                        ? intl.formatMessage(
                            { id: 'portal.hero.beforeClosePeriod' },
                            { period: <FormattedValue>{periodLabel}</FormattedValue> }
                          )
                        : intl.formatMessage({ id: 'portal.hero.beforeCloseBooks' })}
                    </>
                  )}
          </h1>
          {/* Breakdown sub-line — sits right under the H1 with tight
              spacing. The progress count ("0 / 7 complete") was a
              third line here but it just restated what the § 02 mono
              label below says ("§ 02 · ... · 0 / 7"). Dropping it
              collapses the hero from four stacked elements to two and
              kills the dead vertical white-space the owner had to
              scroll past before hitting the list. */}
          {totalThingsNeeded > 0 && (
            <p
              style={{
                margin: '0.75rem 0 0',
                fontFamily: D.body,
                fontSize: '1rem',
                lineHeight: D.leading.body,
                color: D.inkSoft,
                maxWidth: '40em'
              }}
            >
              {[
                neededTilesCount > 0 && intl.formatMessage(
                  { id: liveDatabaseMode ? 'portal.documents.receipt.connections' : 'portal.hero.missingGroups' },
                  { count: neededTilesCount }
                ),
                questionCount > 0 && intl.formatMessage(
                  { id: 'portal.hero.openQuestions' },
                  { count: questionCount }
                )
              ]
                .filter(Boolean)
                .join(' · ')}
              .
            </p>
          )}
          {/* Hero buttons dropped along with the embedded checklist:
              the §02 expandable list sits directly below this section
              and IS the answer to "what do I have to do?", so a
              "Upload files / Answer the question" CTA pair turned into
              extra noise above the actual work surface. The list rows
              handle the action; the drop zone fallback sits below the
              list with its own affordance. Mobile sticky bar still
              carries Upload + Answer anchors for thumb-reach. */}
        </section>

        {wizardOn && setupWizard.active && (
          <section data-testid="setup-wizard-progress" style={{ padding: '1rem 1.5rem 0', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
            <p style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: D.inkSoft }}>
              {message('portal.setup.progress', {
                current: setupWizard.activeIndex + 1,
                total: setupWizard.steps.length
              })}
            </p>
            <button type="button" onClick={skipSetupStep} style={{ appearance: 'none', border: 'none', background: 'none', padding: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: D.inkSoft, cursor: 'pointer', textDecoration: 'underline' }}>
              {message('portal.setup.later')}
            </button>
          </section>
        )}
        {wizardOn && setupWizard.parked && (
          <section data-testid="setup-wizard-parked" style={{ padding: '1rem 1.5rem', borderBottom: `1px solid ${D.rule}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
            <p style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: D.inkSoft }}>
              {message('portal.setup.parked', { count: setupWizard.steps.length })}
            </p>
            <button type="button" onClick={() => setSetupSkipped(new Set())} style={{ appearance: 'none', border: 'none', background: 'none', padding: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: D.ink, cursor: 'pointer', textDecoration: 'underline' }}>
              {message('portal.setup.resume')}
            </button>
          </section>
        )}
        {showJurisdictionCard && setupStepVisible('jurisdiction') && (
          <section data-testid="jurisdiction-setup-card" style={{ padding: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2 style={{ marginBlockStart: 0 }}>{message('portal.setup.jurisdiction.title')}</h2>
            <p>{message(jurisdictionCapture.conflict ? 'portal.setup.jurisdiction.conflict' : 'portal.setup.jurisdiction.body')}</p>
            <label>{message('portal.setup.jurisdiction.country')}
              <select value={jurisdictionDraft} onChange={(event) => setJurisdictionDraft(event.target.value)} disabled={jurisdictionSaving}>
                <option value="">{message('portal.setup.jurisdiction.choose')}</option>
                {JURISDICTIONS.map(({ code }) => <option key={code} value={code}>{message(`portal.axis.jurisdiction.${code}`)}</option>)}
              </select>
            </label>
            <button type="button" disabled={!jurisdictionDraft || jurisdictionSaving} onClick={saveJurisdiction}>
              {message(jurisdictionSaving ? 'portal.setup.entity.saving' : 'portal.setup.entity.save')}
            </button>
            {jurisdictionError && <p role="alert">{jurisdictionError}</p>}
          </section>
        )}

        {showEntityTypeCard && setupStepVisible('entity_type') && (
          <section data-testid="entity-type-capture" style={{ padding: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2 style={{ marginBlockStart: 0 }}>{message('portal.setup.entity.title')}</h2>
            <p>{message('portal.setup.entity.body')}</p>
            {entityCapture.suggestedEntityType && (
              <p role="status">
                {message('portal.setup.entity.recognized', {
                  legalForm: <BidiText direction="auto">{entityCapture.storedEntityType}</BidiText>
                })}
              </p>
            )}
            {entityCapture.storedEntityType && !entityCapture.suggestedEntityType && (
              <p role="alert">
                {message('portal.setup.entity.unsupported', {
                  legalForm: <BidiText direction="auto">{entityCapture.storedEntityType}</BidiText>
                })}
              </p>
            )}
            <label>{message('portal.setup.entity.legalForm')}
              <select value={entityTypeDraft.entity_type} onChange={(event) => setEntityTypeDraft((draft) => ({ ...draft, entity_type: event.target.value }))}>
                <option value="">{message('portal.setup.entity.choose')}</option>
                {entityCapture.options.map((option) => (
                  <option key={option} value={option}>
                    {PORTAL_LEGAL_FORM_MESSAGE_IDS[option]
                      ? message(PORTAL_LEGAL_FORM_MESSAGE_IDS[option])
                      : entityTypeLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            {entityTypeNeedsDate && (
              <label>{message('portal.setup.entity.incorporationDate')}
                <input type="date" value={entityTypeDraft.incorporation_date} onChange={(event) => setEntityTypeDraft((draft) => ({ ...draft, incorporation_date: event.target.value }))} />
              </label>
            )}
            <button type="button" disabled={entityTypeSaving || !entityTypeDraft.entity_type || (entityTypeNeedsDate && !entityTypeDraft.incorporation_date)} onClick={saveEntityType}>
              {message(entityTypeSaving ? 'portal.setup.entity.saving' : 'portal.setup.entity.save')}
            </button>
            {entityTypeError && <p role="alert"><BidiText direction="auto">{entityTypeError}</BidiText></p>}
          </section>
        )}
        {liveDatabaseMode && storedEntityType === 'ae-llc' && selectedClient?.id && (
          <AeOpeningBalances key={selectedClient.id} clientId={selectedClient.id} periods={fiscalPeriodState?.periods || []} />
        )}
        {showFiscalPeriodCard && setupStepVisible('fiscal_period') && (
          <section data-testid="fiscal-period-capture" style={{ padding: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2 style={{ marginBlockStart: 0 }}>{message('portal.setup.fiscal.title')}</h2>
            <p>{message('portal.setup.fiscal.body')}</p>
            <label>{message('portal.setup.fiscal.firstDay')}
              <input type="date" value={fiscalPeriodDraft.starts_on} onChange={(event) => setFiscalPeriodDraft((draft) => ({ ...draft, starts_on: event.target.value }))} />
            </label>
            <label>{message('portal.setup.fiscal.lastDay')}
              <input type="date" value={fiscalPeriodDraft.ends_on} onChange={(event) => setFiscalPeriodDraft((draft) => ({ ...draft, ends_on: event.target.value }))} />
            </label>
            <button type="button" disabled={fiscalPeriodSaving || !fiscalPeriodDraft.starts_on || !fiscalPeriodDraft.ends_on} onClick={saveFiscalPeriod}>
              {message(fiscalPeriodSaving ? 'portal.setup.entity.saving' : 'portal.setup.fiscal.save')}
            </button>
            {fiscalPeriodError && <p role="alert"><BidiText direction="auto">{fiscalPeriodError}</BidiText></p>}
          </section>
        )}
        {showGbFilingCard && setupStepVisible('gb_filing') && (
          <section data-testid="gb-filing-details" style={{ padding: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2 style={{ marginBlockStart: 0 }}>{message('portal.setup.gb.title')}</h2>
            <p>{message('portal.setup.gb.body')}</p>
            <label>{message('portal.setup.gb.vatQuarterEnd')}
              <select value={gbFilingDraft.vat_stagger} onChange={(event) => setGbFilingDraft((draft) => ({ ...draft, vat_stagger: event.target.value }))}>
                <option value="">{message('portal.setup.gb.chooseMonths')}</option>
                <option value="1">{message('portal.setup.gb.quarterMar')}</option>
                <option value="2">{message('portal.setup.gb.quarterJan')}</option>
                <option value="3">{message('portal.setup.gb.quarterFeb')}</option>
              </select>
            </label>
            <label>{message('portal.setup.gb.confirmationPeriodEnd')}
              <input type="date" value={gbFilingDraft.confirmation_review_period_end} onChange={(event) => setGbFilingDraft((draft) => ({ ...draft, confirmation_review_period_end: event.target.value }))} />
            </label>
            <label>{message('portal.setup.gb.accountingPeriodEnd')}
              <input type="date" value={gbFilingDraft.accounting_period_end} onChange={(event) => setGbFilingDraft((draft) => ({ ...draft, accounting_period_end: event.target.value }))} />
            </label>
            <button type="button" disabled={gbFilingSaving || !gbFilingDraft.vat_stagger || !gbFilingDraft.confirmation_review_period_end || !gbFilingDraft.accounting_period_end} onClick={saveGbFilingFacts}>
              {message(gbFilingSaving ? 'portal.setup.entity.saving' : 'portal.setup.gb.save')}
            </button>
            {gbFilingError && <p role="alert"><BidiText direction="auto">{gbFilingError}</BidiText></p>}
          </section>
        )}
        {databaseMode && selectedClient?.id && whatsAppState && (whatsAppPending ? setupStepVisible('channel_connect') : true) && (
          <section data-testid="whatsapp-connect" style={{ padding: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2>{message('portal.channel.whatsapp.title')}</h2>
            {!whatsAppState.channel_acts ? (
              <p>{message('portal.channel.whatsapp.unavailable')}</p>
            ) : whatsAppState.binding ? (
              <>
                <p>{message('portal.channel.whatsapp.connected', {
                  phoneNumber: <IdentifierText>{whatsAppState.binding.masked_phone}</IdentifierText>
                })}</p>
                <button type="button" onClick={disconnectWhatsApp}>{message('portal.channel.whatsapp.disconnect')}</button>
              </>
            ) : (
              <>
                <button type="button" onClick={connectWhatsApp}>{message('portal.channel.whatsapp.connect')}</button>
                {whatsAppLink && <a href={whatsAppLink}>{message('portal.channel.whatsapp.open')}</a>}
              </>
            )}
          </section>
        )}
        {databaseMode && selectedClient?.id && telegramState && (telegramPending ? setupStepVisible('channel_connect') : true) && (
          <section data-testid="telegram-connect" style={{ padding: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2>{message('portal.channel.telegram.title')}</h2>
            {!telegramState.channel_acts ? (
              <p>{message('portal.channel.telegram.unavailable')}</p>
            ) : telegramState.binding ? (
              <>
                <p>{telegramState.binding.masked_chat_id
                  ? message('portal.channel.telegram.connected', {
                      chatId: <IdentifierText>{telegramState.binding.masked_chat_id}</IdentifierText>
                    })
                  : message('portal.channel.telegram.title')}</p>
                <button type="button" onClick={disconnectTelegram}>{message('portal.channel.telegram.disconnect')}</button>
              </>
            ) : (
              <>
                <button type="button" onClick={connectTelegram}>{message('portal.channel.telegram.connect')}</button>
                {telegramConnect?.t_me_url && <a href={telegramConnect.t_me_url}>{message('portal.channel.telegram.open')}</a>}
                {telegramConnect && !telegramConnect.t_me_url && (
                  <p>
                    {message('portal.channel.telegram.command')}{' '}
                    <code><IdentifierText>{telegramConnect.start_command}</IdentifierText></code>
                  </p>
                )}
              </>
            )}
          </section>
        )}
        {ownerVatCard && (
          <section data-testid="owner-vat-return" style={{ padding: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2 style={{ marginBlockStart: 0 }}>{message('portal.vat.title')}</h2>
            {ownerVatCard.kind === 'blocked' ? (
              <>
                <p>{message('portal.vat.status.refused')}</p>
                <p><BidiText direction="auto">
                  {PORTAL_VAT_BLOCKER_MESSAGE_IDS[ownerVatCard.code]
                    ? message(PORTAL_VAT_BLOCKER_MESSAGE_IDS[ownerVatCard.code])
                    : ownerVatCard.message}
                </BidiText></p>
              </>
            ) : (
              <>
                <p style={{ margin: '0 0 0.25rem', fontWeight: 600 }}>
                  {message('portal.vat.status.prepared')} · {message(
                    ownerVatCard.view.outcome === 'repayment'
                      ? 'portal.vat.amount.repayment'
                      : 'portal.vat.amount.due',
                    { amount: <FormattedValue>{formatAmount(Math.abs(ownerVatCard.view.netVat), { currency: ownerVatCard.view.currency })}</FormattedValue> }
                  )}
                </p>
                <p style={{ margin: '0 0 0.75rem', color: D.inkSoft }}>
                  {ownerVatCard.view.dueDate
                    ? message('portal.vat.periodDue', {
                        period: <>
                          {ownerVatCard.view.period && <IdentifierText>{ownerVatCard.view.period}</IdentifierText>}
                          {ownerVatCard.view.startsOn && ownerVatCard.view.endsOn && <> · <FormattedValue>{formatDate(ownerVatCard.view.startsOn)}</FormattedValue>–<FormattedValue>{formatDate(ownerVatCard.view.endsOn)}</FormattedValue></>}
                        </>,
                        dueDate: <FormattedValue>{formatDate(ownerVatCard.view.dueDate)}</FormattedValue>
                      })
                    : <BidiText direction="auto">{ownerVatCard.view.periodRange}</BidiText>}
                </p>
                <table style={{ borderCollapse: 'collapse' }}>
                  <tbody>
                    {ownerVatCard.view.boxRows.map((row) => (
                      <tr key={row.box}>
                        <td style={{ paddingBlock: '0.1rem', paddingInlineEnd: '0.75rem', color: D.inkSoft }}>
                          {message('portal.vat.box', { number: <IdentifierText>{row.box}</IdentifierText> })}
                        </td>
                        <td style={{ padding: '0.1rem 0', textAlign: 'end', fontVariantNumeric: 'tabular-nums' }}>
                          <FormattedValue>{formatAmount(row.amount, { currency: ownerVatCard.view.currency })}</FormattedValue>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ margin: '0.75rem 0 0', color: D.inkSoft }}>
                  {message('portal.vat.body')}
                </p>
              </>
            )}
          </section>
        )}

        {/* Demo-only Phase 1.5 unscoped placeholder. Live books use the
            neutral upload invitation and persisted receipt below.
            A legacy unscoped placeholder A client exists but the firm
            hasn't ticked any services_engaged yet (explicit empty array, the
            new-client state). Rather than show every upload tile by default,
            hold the page in a calm "we haven't scoped this yet" state until
            an operator picks services on the firm-side card. Replaces the
            §02 upload checklist while unscoped — but NOT direct firm
            questions: an evidence request the firm explicitly sent is
            scope-independent and must reach the client regardless. So the
            placeholder (whose copy says "nothing to do on this page") is
            suppressed when open questions exist; the §02 list below renders
            them instead. */}
        {portalUnscoped && !hasLiveQuestions && !liveDatabaseMode && (
          <section
            style={{
              paddingTop: 'clamp(1.5rem, 3vw, 2rem)',
              paddingBottom: 'clamp(2.5rem, 6vw, 4rem)',
              borderBottom: `1px solid ${D.rule}`
            }}
          >
            <div
              style={{
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                color: D.inkSoft
              }}
            >
              {intl.formatMessage({ id: bookActive ? 'portal.unscoped.clearTitle' : 'portal.unscoped.title' })}
            </div>
            <p
              style={{
                margin: '0.75rem 0 0',
                fontFamily: D.body,
                fontSize: '1rem',
                lineHeight: D.leading.body,
                color: D.inkSoft,
                maxWidth: '40em'
              }}
            >
              {intl.formatMessage({ id: bookActive ? 'portal.unscoped.clearBody' : 'portal.unscoped.body' })}
            </p>
          </section>
        )}

        {/* Section § 02 — What I still need from you. The master work
            surface. Combines what used to be § 02 Open requests + § 03
            Files I still need into one expandable list: each row is a
            collapsed task summary; clicking expands the row to reveal
            the InlineReply (for questions) or the upload + dismiss
            actions (for file groups). Single-open like an accordion.
            Drops two whole sections worth of duplication — owners
            scanned the hero count, scrolled past the drop zone, read
            § 02, scrolled, read § 03 — three IA chapters delivering
            one mental model. Now: one list. Owners hit a row, do the
            thing, collapse, move on. Anchored as #list so the mobile
            sticky bar "Answer" target lands here. */}
        {(hasLiveQuestions || (!portalUnscoped && totalThingsNeeded > 0)) && (
          <section
            id="list"
            style={{
              paddingTop: 'clamp(1.5rem, 3vw, 2rem)',
              paddingBottom: 'clamp(2.5rem, 6vw, 4rem)',
              borderBottom: `1px solid ${D.rule}`,
              scrollMarginTop: '4rem'
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: '0.75rem 1.5rem',
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                color: D.inkSoft,
                flexWrap: 'wrap'
              }}
            >
              <span style={{ color: D.ink }}>§ 02</span>
              <span>{intl.formatMessage({ id: 'portal.list.title' })}</span>
              <span style={{ marginInlineStart: 'auto', color: D.ink }}>
                {intl.formatMessage({ id: 'portal.list.progress' }, { complete: 0, total: totalThingsNeeded })}
              </span>
            </div>
            {/* Numbered task list — bordered grid pattern, hairline
                dividers via 1px gap. Each row is its own <article> so
                screen readers announce the kind/label/status set
                together. Expanded panel sits below the header inside
                the same <article>; collapsing slides the panel out of
                the DOM (preserves InlineReply's "fresh state per mount"
                guarantee from the previous structure). */}
            <ol
              style={{
                listStyle: 'none',
                margin: 'clamp(1.5rem, 4vw, 2rem) 0 0',
                padding: 0,
                border: `1px solid ${D.rule}`,
                display: 'grid',
                gap: '1px',
                backgroundColor: D.rule
              }}
            >
              {listItems.map((item, idx) => {
                const isExpanded = expandedKey === item.key;
                // "OPEN" for ungrouped questions; "N OPEN" for groups.
                // Both should render the warm-accent pill; tiles
                // (MISSING / PARTIAL) get the ink pill.
                const statusIsOpen = item.type === 'question' || item.type === 'group';
                return (
                  <li
                    key={item.key}
                    style={{ backgroundColor: D.paper }}
                  >
                    <article>
                      {/* Clickable header — full row is the toggle
                          target so the click affordance is large
                          (mobile thumb-friendly). The chevron is a
                          visual cue; keyboard users get aria-expanded
                          and Enter / Space activation. */}
                      <div
                        className={`donna-portal__row${isExpanded ? ' donna-portal__row--open' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        aria-controls={`${item.key}-panel`}
                        onClick={() => toggleExpanded(item.key)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleExpanded(item.key);
                          }
                        }}
                        style={{
                          padding: 'clamp(1rem, 2.5vw, 1.25rem) clamp(1rem, 3vw, 1.5rem)',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '1rem 1.25rem',
                          flexWrap: 'wrap',
                          cursor: 'pointer'
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            flex: '0 0 auto',
                            minWidth: '1.75rem',
                            fontFamily: D.mono,
                            fontSize: 11,
                            letterSpacing: D.tracking.mono,
                            color: D.inkMute,
                            fontVariantNumeric: 'tabular-nums',
                            lineHeight: 1.4
                          }}
                        >
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <div style={{ flex: '1 1 18rem', minWidth: 0 }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'baseline',
                              gap: '0.75rem',
                              flexWrap: 'wrap'
                            }}
                          >
                            {/* Kind badge — questions only. Tile rows
                                were all stamped "File group", which
                                added rectangle noise without value:
                                every file row says the same thing.
                                The status pill on the right already
                                differentiates MISSING / PARTIAL. */}
                            {item.type === 'question' && (
                              <span
                                style={{
                                  fontFamily: D.mono,
                                  fontSize: 9.5,
                                  letterSpacing: D.tracking.mono,
                                  textTransform: 'uppercase',
                                  fontWeight: 500,
                                  padding: '0.2rem 0.55rem',
                                  border: `1px solid ${item.q?.kind === 'FX' ? D.accentWarmFlat : D.ink}`,
                                  color: item.q?.kind === 'FX' ? D.accentWarmFlat : D.ink,
                                  flex: '0 0 auto'
                                }}
                              >
                                {item.kindLabel}
                              </span>
                            )}
                            <span
                              style={{
                                fontFamily: D.body,
                                fontSize: '0.9375rem',
                                color: D.ink,
                                fontWeight: 500,
                                wordBreak: 'break-word',
                                minWidth: 0,
                                lineHeight: 1.35
                              }}
                            >
                              <BidiText direction="auto">{item.primary}</BidiText>
                            </span>
                          </div>
                          {item.meta && (
                            <div
                              style={{
                                marginTop: '0.3rem',
                                fontFamily: D.mono,
                                fontSize: 11,
                                letterSpacing: D.tracking.mono,
                                textTransform: 'uppercase',
                                color: D.inkMute
                              }}
                            >
                              {item.type === 'question' ? (
                                <>
                                  {item.amount && <FormattedValue>{item.amount}</FormattedValue>}
                                  {item.amount && item.date && ' · '}
                                  {item.date && <FormattedValue>{item.date}</FormattedValue>}
                                </>
                              ) : item.type === 'group' ? (
                                <>
                                  {item.dateStart && <FormattedValue>{item.dateStart}</FormattedValue>}
                                  {item.dateStart && item.dateEnd && item.dateStart !== item.dateEnd && ' – '}
                                  {item.dateEnd && item.dateStart !== item.dateEnd && <FormattedValue>{item.dateEnd}</FormattedValue>}
                                </>
                              ) : <BidiText direction="auto">{item.meta}</BidiText>}
                            </div>
                          )}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            marginInlineStart: 'auto',
                            flex: '0 0 auto'
                          }}
                        >
                          {/* Status pill renders only for file-group rows
                              (MISSING / PARTIAL), which carry real status.
                              The "OPEN" / "N OPEN" pill on question rows was
                              redundant — being listed already means open, and
                              a group's count lives in its primary label
                              ("3 fx questions") — so it's dropped, leaving the
                              + as the single open/close affordance. */}
                          {!statusIsOpen && (
                            <span
                              style={{
                                fontFamily: D.mono,
                                fontSize: 10.5,
                                letterSpacing: D.tracking.mono,
                                textTransform: 'uppercase',
                                fontWeight: 500,
                                padding: '0.2rem 0.55rem',
                                border: `1px solid ${D.ink}`,
                                color: D.ink,
                                whiteSpace: 'nowrap'
                              }}
                            >
                              {item.status}
                            </span>
                          )}
                          <span
                            aria-hidden="true"
                            style={{
                              fontFamily: D.mono,
                              fontSize: 18,
                              lineHeight: 1,
                              color: D.inkSoft,
                              width: '1rem',
                              textAlign: 'center',
                              transform: isExpanded ? 'rotate(45deg)' : 'rotate(0deg)',
                              transition: `transform 180ms ${D.ease}`
                            }}
                          >
                            +
                          </span>
                        </div>
                      </div>

                      {isExpanded && item.type === 'question' && (
                        <div id={`${item.key}-panel`}>
                          {/* Operator-drafted question prose + the
                              binary affordance hint. The InlineReply
                              below picks up where the question ends:
                              Note tab = type a one-line answer, File
                              tab = upload supporting doc. Tabs ARE
                              the choice. */}
                          {item.q.text && (
                            <p
                              style={{
                                margin: 0,
                                paddingBlockEnd: 'clamp(0.75rem, 2vw, 1rem)',
                                paddingInlineEnd: 'clamp(1rem, 3vw, 1.5rem)',
                                paddingInlineStart: 'calc(clamp(1rem, 3vw, 1.5rem) + 1.75rem + 1.25rem)',
                                fontFamily: D.body,
                                fontSize: '0.9375rem',
                                lineHeight: D.leading.body,
                                color: D.inkSoft,
                                wordBreak: 'break-word'
                              }}
                            >
                              <BidiText direction="auto">{item.q.text}</BidiText>
                            </p>
                          )}
                          {item.q.topic && (
                            <div style={{
                              marginBlockEnd: 'clamp(0.75rem, 2vw, 1rem)',
                              marginInlineEnd: 'clamp(1rem, 3vw, 1.5rem)',
                              marginInlineStart: 'calc(clamp(1rem, 3vw, 1.5rem) + 1.75rem + 1.25rem)',
                              borderInlineStart: `1px solid ${D.rule}`,
                              paddingInlineStart: '0.75rem',
                              fontFamily: D.body,
                              fontSize: '0.8125rem',
                              lineHeight: D.leading.body,
                              color: D.inkSoft
                            }}>
                              {item.q.topic.lastOwnerMessageAt
                                ? message('portal.question.stillOpen', {
                                    date: <FormattedValue>{formatTimestamp(item.q.topic.lastOwnerMessageAt)}</FormattedValue>
                                  })
                                : message('portal.chat.open.title')}
                              {item.q.topic.lastReplyExcerpt && <> · {message('portal.chat.open.lastReply', {
                                reply: <BidiText direction="auto">{item.q.topic.lastReplyExcerpt}</BidiText>
                              })}</>}
                            </div>
                          )}
                          <InlineReply
                            question={item.q}
                            busy={isReplyBusy(item.q.id)}
                            error={replyErrorFor(item.q.id)}
                            initialPane="note"
                            onSubmit={({ reply, files }) =>
                              submitReply({ question: item.q, reply, files, expansionKey: item.key })
                            }
                            onSkip={() => setExpandedKey(null)}
                          />
                        </div>
                      )}

                      {isExpanded && item.type === 'group' && (
                        <div
                          id={`${item.key}-panel`}
                          style={{
                            borderTop: `1px solid ${D.rule}`,
                            backgroundColor: D.paperDeep,
                            display: 'grid',
                            gap: '1px'
                          }}
                        >
                          {item.questions.map((subQ, subIdx) => {
                            const subKey = `q-${subQ.id}`;
                            const isSubExpanded = expandedSubKey === subKey;
                            const subPrimary = subQ.desc || subQ.text || message('portal.question.forYou');
                            const subLetter = String.fromCharCode(97 + subIdx);
                            return (
                              <div
                                key={subKey}
                                style={{
                                  backgroundColor: D.paperDeep,
                                  borderTop: subIdx === 0 ? 'none' : `1px solid ${D.rule}`
                                }}
                              >
                                <div
                                  className={`donna-portal__row${isSubExpanded ? ' donna-portal__row--open' : ''}`}
                                  role="button"
                                  tabIndex={0}
                                  aria-expanded={isSubExpanded}
                                  aria-controls={`${subKey}-subpanel`}
                                  onClick={() => toggleSubExpanded(subKey)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      toggleSubExpanded(subKey);
                                    }
                                  }}
                                  style={{
                                    paddingBlock: 'clamp(0.75rem, 2vw, 1rem)',
                                    paddingInlineEnd: 'clamp(1rem, 3vw, 1.5rem)',
                                    paddingInlineStart: 'clamp(2.75rem, 6vw, 4.25rem)',
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: '1rem 1.25rem',
                                    flexWrap: 'wrap',
                                    cursor: 'pointer'
                                  }}
                                >
                                  <span
                                    aria-hidden="true"
                                    style={{
                                      flex: '0 0 auto',
                                      minWidth: '1.25rem',
                                      fontFamily: D.mono,
                                      fontSize: 11,
                                      letterSpacing: D.tracking.mono,
                                      color: D.inkMute,
                                      textTransform: 'lowercase',
                                      lineHeight: 1.4
                                    }}
                                  >
                                    {subLetter}
                                  </span>
                                  <div style={{ flex: '1 1 18rem', minWidth: 0 }}>
                                    <span
                                      style={{
                                        fontFamily: D.body,
                                        fontSize: '0.9375rem',
                                        color: D.ink,
                                        fontWeight: 500,
                                        wordBreak: 'break-word',
                                        lineHeight: 1.35
                                      }}
                                    >
                                      <BidiText direction="auto">{subPrimary}</BidiText>
                                    </span>
                                    {(subQ.amt || subQ.when) && (
                                      <div
                                        style={{
                                          marginTop: '0.3rem',
                                          fontFamily: D.mono,
                                          fontSize: 11,
                                          letterSpacing: D.tracking.mono,
                                          textTransform: 'uppercase',
                                          color: D.inkMute
                                        }}
                                      >
                                        {subQ.amt && <FormattedValue>{subQ.amt}</FormattedValue>}
                                        {subQ.amt && subQ.when && ' · '}
                                        {subQ.when && <FormattedValue>{subQ.when}</FormattedValue>}
                                      </div>
                                    )}
                                  </div>
                                  <span
                                    aria-hidden="true"
                                    style={{
                                      fontFamily: D.mono,
                                      fontSize: 18,
                                      lineHeight: 1,
                                      color: D.inkSoft,
                                      width: '1rem',
                                      textAlign: 'center',
                                      marginInlineStart: 'auto',
                                      transform: isSubExpanded ? 'rotate(45deg)' : 'rotate(0deg)',
                                      transition: `transform 180ms ${D.ease}`
                                    }}
                                  >
                                    +
                                  </span>
                                </div>
                                {isSubExpanded && (
                                  <div id={`${subKey}-subpanel`}>
                                    {subQ.text && (
                                      <p
                                        style={{
                                          margin: 0,
                                          paddingBlockEnd: 'clamp(0.75rem, 2vw, 1rem)',
                                          paddingInlineEnd: 'clamp(1rem, 3vw, 1.5rem)',
                                          paddingInlineStart: 'clamp(2.75rem, 6vw, 4.25rem)',
                                          fontFamily: D.body,
                                          fontSize: '0.9375rem',
                                          lineHeight: D.leading.body,
                                          color: D.inkSoft,
                                          wordBreak: 'break-word'
                                        }}
                                      >
                                        <BidiText direction="auto">{subQ.text}</BidiText>
                                      </p>
                                    )}
                                    {subQ.topic && (
                                      <div style={{
                                        marginBlockEnd: 'clamp(0.75rem, 2vw, 1rem)',
                                        marginInlineEnd: 'clamp(1rem, 3vw, 1.5rem)',
                                        marginInlineStart: 'clamp(2.75rem, 6vw, 4.25rem)',
                                        borderInlineStart: `1px solid ${D.rule}`,
                                        paddingInlineStart: '0.75rem',
                                        fontFamily: D.body,
                                        fontSize: '0.8125rem',
                                        lineHeight: D.leading.body,
                                        color: D.inkSoft
                                      }}>
                                        {subQ.topic.lastOwnerMessageAt
                                          ? message('portal.question.stillOpen', {
                                              date: <FormattedValue>{formatTimestamp(subQ.topic.lastOwnerMessageAt)}</FormattedValue>
                                            })
                                          : message('portal.chat.open.title')}
                                        {subQ.topic.lastReplyExcerpt && <> · {message('portal.chat.open.lastReply', {
                                          reply: <BidiText direction="auto">{subQ.topic.lastReplyExcerpt}</BidiText>
                                        })}</>}
                                      </div>
                                    )}
                                    <InlineReply
                                      question={subQ}
                                      busy={isReplyBusy(subQ.id)}
                                      error={replyErrorFor(subQ.id)}
                                      initialPane="note"
                                      onSubmit={({ reply, files }) =>
                                        submitReply({ question: subQ, reply, files, expansionKey: subKey })
                                      }
                                      onSkip={() => setExpandedSubKey(null)}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {isExpanded && item.type === 'tile' && (
                        <div
                          id={`${item.key}-panel`}
                          style={{
                            borderTop: `1px solid ${D.rule}`,
                            backgroundColor: D.paperDeep,
                            padding: 'clamp(1.25rem, 3vw, 1.75rem) clamp(1rem, 3vw, 1.5rem)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.875rem'
                          }}
                        >
                          <p
                            style={{
                              margin: 0,
                              fontFamily: D.body,
                              fontSize: '0.9375rem',
                              lineHeight: D.leading.body,
                              color: D.ink
                            }}
                          >
                            {item.tile.descResolved}
                          </p>
                          {item.tile.statusDetailResolved && (
                            <p
                              style={{
                                margin: 0,
                                fontFamily: D.body,
                                fontSize: '0.8125rem',
                                lineHeight: D.leading.body,
                                color: D.ink,
                                borderInlineStart: `1px solid ${D.rule}`,
                                paddingInlineStart: '0.75rem'
                              }}
                            >
                              {item.tile.statusDetailResolved}
                            </p>
                          )}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.5rem 0.75rem',
                              flexWrap: 'wrap'
                            }}
                          >
                            {/* Primary CTA. The connector ("Xero access")
                                tile starts the real OAuth connect; every
                                other tile jumps the owner to the drop zone
                                with the file picker already opened — routing
                                it through the existing drop zone is the
                                cheapest functional fix without duplicating
                                the staged-batch UI. */}
                            <button
                              type="button"
                              disabled={item.tile.id === 'xero' && connectBusy}
                              onClick={() => {
                                if (item.tile.id === 'xero') {
                                  handleConnectAccounting();
                                  return;
                                }
                                setDocTab('upload');
                                document.getElementById('ask')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                setTimeout(() => fileInputRef.current?.click(), 350);
                              }}
                              style={{
                                ...D.noiseGold(),
                                fontFamily: D.mono,
                                fontSize: 11,
                                letterSpacing: D.tracking.mono,
                                textTransform: 'uppercase',
                                fontWeight: 500,
                                padding: '0.6rem 1.25rem',
                                border: `1px solid ${D.ink}`,
                                color: D.ink,
                                cursor: item.tile.id === 'xero' && connectBusy ? 'wait' : 'pointer'
                              }}
                            >
                              {item.tile.id === 'xero' && connectBusy ? message('portal.tile.connector.opening') : item.tile.cta}
                            </button>
                            {item.tile.dismissible && (
                              <button
                                type="button"
                                onClick={() => {
                                  toggleTileDismissed(item.tile.id);
                                  // Collapse the row after the
                                  // dismiss — it's about to drop off
                                  // the list anyway, no point keeping
                                  // the panel open over an empty
                                  // animation frame.
                                  setExpandedKey(null);
                                }}
                                style={{
                                  appearance: 'none',
                                  background: 'transparent',
                                  border: 'none',
                                  padding: '0.6rem 0.25rem',
                                  fontFamily: D.mono,
                                  fontSize: 11,
                                  letterSpacing: D.tracking.mono,
                                  textTransform: 'uppercase',
                                  fontWeight: 500,
                                  color: D.inkSoft,
                                  cursor: 'pointer',
                                  borderBottom: `1px solid ${D.rule}`,
                                  lineHeight: 1
                                }}
                              >
                                {item.tile.dismissLabel || message('portal.tile.notApplicable')}
                              </button>
                            )}
                          </div>
                          {item.tile.id === 'xero' && connectError && (
                            <p
                              style={{
                                margin: '0.5rem 0 0',
                                fontFamily: D.mono,
                                fontSize: 11,
                                lineHeight: D.leading.body,
                                color: D.alert || '#b3261e'
                              }}
                            >
                              <BidiText direction="auto">{connectError}</BidiText>
                            </p>
                          )}
                        </div>
                      )}
                    </article>
                  </li>
                );
              })}
            </ol>
            {/* Dismissed-tile recovery strip. Once tiles get dismissed
                they fall off the list above, so the only way to undo
                without remembering which one would be a refresh. The
                strip lists dismissed tile titles with an inline
                "Mark as needed" link, so an owner who toggled
                "No payroll" by mistake can flip it back. */}
            {(() => {
              const dismissedList = effectiveTiles.filter((t) => t.isDismissed);
              if (!dismissedList.length) return null;
              return (
                <div
                  style={{
                    marginTop: 'clamp(1.5rem, 4vw, 2rem)',
                    padding: '1rem 1.25rem',
                    border: `1px solid ${D.ruleSoft}`,
                    backgroundColor: D.paperDeep,
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    gap: '0.5rem 1rem'
                  }}
                >
                  <span
                    style={{
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      color: D.inkMute,
                      flex: '0 0 auto'
                    }}
                  >
                    {message('portal.tile.markedNotApplicable')}
                  </span>
                  {dismissedList.map((tile, idx) => (
                    <span key={tile.id} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.5rem' }}>
                      <span
                        style={{
                          fontFamily: D.body,
                          fontSize: '0.875rem',
                          color: D.inkSoft
                        }}
                      >
                        {tile.title}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleTileDismissed(tile.id)}
                        style={{
                          appearance: 'none',
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          fontFamily: D.mono,
                          fontSize: 10.5,
                          letterSpacing: D.tracking.mono,
                          textTransform: 'uppercase',
                          color: D.ink,
                          cursor: 'pointer',
                          borderBottom: `1px solid ${D.rule}`,
                          lineHeight: 1
                        }}
                      >
                        {message('portal.tile.markNeeded')}
                      </button>
                      {idx < dismissedList.length - 1 && (
                        <span style={{ color: D.inkMute, fontFamily: D.mono, fontSize: 11 }}>·</span>
                      )}
                    </span>
                  ))}
                </div>
              );
            })()}
          </section>
        )}

        {/* All-clear state — when everything is done, the hero already
            says "All clear — June is ready to close." No need for an
            empty list section. */}

        {/* Messages from your firm — moved to the bottom of the page
            (was rendered here, right under the intro). The welcome
            note was dominating the top of the portal even when the
            firm's most recent action was a quick evidence question.
            Section now sits below the evidence-requests block so
            urgent items get the attention. */}

        {/* Document workspace tab strip (DB mode only). A long upload
            history can't sit always-expanded in a single column — it
            buries the reporting section below. So Upload + Previous
            uploads become two tabs (Upload default). The strip carries
            id="ask" — the scroll target for the mobile sticky "Upload"
            button and the § 02 tile CTAs — so those anchors survive even
            when the drop-zone pane is hidden; the CTAs also flip the tab
            back to Upload. Local-demo mode renders no strip (no history);
            the drop zone keeps id="ask" and shows standalone as before. */}
        {liveDatabaseMode && (
          <section aria-label={message('portal.documents.receipt.title')} style={{ paddingBlock: '1.5rem', borderBottom: `1px solid ${D.rule}` }}>
            <h2 style={{ margin: 0, fontFamily: D.body, fontSize: '1rem' }}>{message('portal.documents.receipt.title')}</h2>
            <p style={{ color: D.inkSoft, lineHeight: D.leading.body }}>
              {message(documentReceipt.total ? 'portal.documents.receipt.total' : 'portal.documents.receipt.empty', { count: documentReceipt.total })}
            </p>
            {documentReceipt.total > 0 && <p style={{ color: D.inkSoft, lineHeight: D.leading.body }}>
              {Object.entries(documentReceipt.statuses).filter(([, count]) => count > 0)
                .map(([status, count]) => message(`portal.documents.receipt.${status}`, { count })).join(' · ')}
            </p>}
          </section>
        )}
        {databaseMode && (
          <div
            id="ask"
            role="tablist"
            aria-label={message('portal.documents.tabs.aria')}
            style={{
              display: 'flex',
              gap: '1.75rem',
              alignItems: 'flex-end',
              paddingTop: 'clamp(2.5rem, 6vw, 4rem)',
              borderBottom: `1px solid ${D.rule}`
            }}
          >
            {[
              { key: 'upload', label: message('portal.documents.tabs.upload') },
              {
                key: 'previous',
                label: visibleUploads.length
                  ? message('portal.documents.tabs.previous', {
                      count: <FormattedValue>{intl.formatNumber(visibleUploads.length)}</FormattedValue>
                    })
                  : message('portal.documents.tabs.previousEmpty')
              }
            ].map((tab) => {
              const active = docTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setDocTab(tab.key)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `2px solid ${active ? D.ink : 'transparent'}`,
                    margin: 0,
                    padding: '0 0 0.75rem',
                    cursor: 'pointer',
                    fontFamily: D.mono,
                    fontSize: 12,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    color: active ? D.ink : D.inkMute
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Drop zone utility — the hero already says "I need N things
            before I can close June" and § 02 lists every specific
            thing, so this section reads as a "or drop everything in
            one go" fallback. Unlabeled (no § marker, no Anton head):
            it's a utility, not a chapter. Mobile gets a dedicated
            camera cell stacked above the drop area. In DB mode this is
            the "Upload" tab pane; id="ask" lives on the tab strip above
            so the anchor survives when the pane is hidden. */}
        {showUploadPane && (
        <section
          id={databaseMode ? undefined : 'ask'}
          style={{
            paddingTop: databaseMode ? 'clamp(1.5rem, 4vw, 2.5rem)' : 'clamp(2.5rem, 6vw, 4rem)',
            paddingBottom: 'clamp(2.5rem, 6vw, 4rem)',
            borderBottom: `1px solid ${D.rule}`,
            scrollMarginTop: '1rem'
          }}
        >
          {/* Intake grid: drop zone always; camera cell stacks above on
              mobile. Hairline divider between cells is the parent rule
              color showing through a 1px grid gap. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: '1px',
              backgroundColor: D.rule,
              border: `1px solid ${D.rule}`
            }}
          >
            {isMobile && (
              <button
                type="button"
                onClick={() => {
                  if (!uploadBusy) cameraInputRef.current?.click();
                }}
                disabled={uploadBusy}
                aria-label={intl.formatMessage({ id: 'portal.upload.cameraAria' })}
                style={{
                  appearance: 'none',
                  textAlign: 'start',
                  border: 'none',
                  cursor: uploadBusy ? 'wait' : 'pointer',
                  backgroundColor: D.paper,
                  padding: 'clamp(1.5rem, 4vw, 2rem)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1.25rem',
                  color: D.ink,
                  fontFamily: D.body,
                  transition: `background-color 160ms ${D.ease}`
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 44,
                    height: 44,
                    border: `1px solid ${D.rule}`,
                    color: D.ink,
                    flex: '0 0 auto'
                  }}
                >
                  <CameraGlyph />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span
                    style={{
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      color: D.inkSoft
                    }}
                  >
                    {intl.formatMessage({ id: 'portal.upload.camera' })}
                  </span>
                  <span
                    style={{
                      fontFamily: D.display,
                      fontSize: D.displayClamp(1.5, 6, 2.25),
                      lineHeight: D.leading.display,
                      letterSpacing: D.tracking.tighter,
                      textTransform: 'uppercase',
                      color: D.ink
                    }}
                  >
                    {intl.formatMessage({ id: 'portal.upload.openCamera' })}
                  </span>
                </span>
              </button>
            )}

            <div
              role="button"
              tabIndex={uploadBusy ? -1 : 0}
              onClick={() => {
                if (!uploadBusy) fileInputRef.current?.click();
              }}
              onKeyDown={(event) => {
                if (uploadBusy) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={handleDropZoneDragEnter}
              onDragOver={handleDropZoneDragOver}
              onDragLeave={handleDropZoneDragLeave}
              onDrop={handleDropZoneDrop}
              aria-busy={uploadBusy ? 'true' : undefined}
              aria-label={intl.formatMessage({ id: 'portal.upload.dropAria' })}
              style={{
                ...(isDraggingOver ? D.noiseGold() : { backgroundColor: D.paper }),
                // Dashed inner border + a visible upload glyph make
                // the affordance read as a drop target instead of
                // "another bordered rectangle". Border thickens to
                // solid ink-on-noise when files are being dragged
                // over so the active-drop state is unambiguous.
                border: `2px dashed ${isDraggingOver ? D.ink : D.rule}`,
                margin: 'clamp(0.5rem, 1.5vw, 0.75rem)',
                boxSizing: 'border-box',
                padding: 'clamp(1.75rem, 4vw, 2.5rem) clamp(1.5rem, 4vw, 2.5rem)',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '1.25rem 2rem',
                cursor: uploadBusy ? 'wait' : 'pointer',
                opacity: uploadBusy ? 0.7 : 1,
                transition: `background-color 200ms ${D.ease}, border-color 200ms ${D.ease}`
              }}
            >
              {/* Upload glyph — large enough to read as "drop here"
                  from across the page. Sits to the left of the text
                  block as its own flex item so it stays visible even
                  if the row wraps on narrow viewports. */}
              <div
                aria-hidden="true"
                style={{
                  flex: '0 0 auto',
                  width: 'clamp(48px, 8vw, 64px)',
                  height: 'clamp(48px, 8vw, 64px)',
                  border: `1.5px solid ${D.ink}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: D.ink,
                  pointerEvents: 'none'
                }}
              >
                <UploadGlyph width="28" height="28" strokeWidth="1.6" />
              </div>
              <div style={{ flex: '1 1 18rem', pointerEvents: 'none' }}>
                <div
                  style={{
                    fontFamily: D.display,
                    fontSize: D.displayClamp(2, 6, 3.5),
                    lineHeight: D.leading.display,
                    letterSpacing: D.tracking.tighter,
                    textTransform: 'uppercase',
                    color: D.ink
                  }}
                >
                  {intl.formatMessage({ id: isDraggingOver ? 'portal.upload.dropActive' : 'portal.upload.dropIdle' })}
                </div>
                <p
                  style={{
                    margin: '0.875rem 0 0',
                    fontSize: '0.95rem',
                    lineHeight: D.leading.body,
                    color: D.inkSoft,
                    maxWidth: '32em'
                  }}
                >
                  {intl.formatMessage(
                    { id: 'portal.upload.description' },
                    { period: <FormattedValue>{periodLabel}</FormattedValue> }
                  )}
                </p>
              </div>
              <div
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '0.75rem',
                  pointerEvents: 'none'
                }}
              >
                <span
                  style={{
                    fontFamily: D.mono,
                    fontSize: 11,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    padding: '0.75rem 1.25rem',
                    border: `1px solid ${D.ink}`,
                    color: D.ink,
                    backgroundColor: 'transparent'
                  }}
                >
                  {uploadBusy
                    ? intl.formatMessage({ id: 'portal.upload.uploading' })
                    : stagedFiles.length > 0
                      ? intl.formatMessage({ id: 'portal.upload.addMore' })
                      : intl.formatMessage({ id: 'portal.upload.choose' })}
                </span>
                <span
                  style={{
                    fontFamily: D.mono,
                    fontSize: 10,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    color: D.inkMute
                  }}
                >
                  {message('portal.documents.formats')}
                </span>
              </div>
              <input
                ref={fileInputRef}
                id="donna-intake-upload"
                type="file"
                multiple
                onChange={handleIntakeUpload}
                style={{ display: 'none' }}
              />
              <input
                ref={cameraInputRef}
                id="donna-camera-upload"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleIntakeUpload}
                style={{ display: 'none' }}
              />
            </div>
          </div>

          {/* Trust line — three sentences anchored just below the intake
              grid so the reassurance sits where it matters (right before
              the client commits files), not buried in the footer. The
              "no money can be moved" clause matters when the client
              connects bank access via the Xero tile downstream. */}
          <p
            style={{
              marginTop: '1rem',
              padding: '0.85rem 1rem',
              border: `1px solid ${D.rule}`,
              backgroundColor: D.paper,
              fontFamily: D.mono,
              fontSize: 11,
              letterSpacing: D.tracking.mono,
              textTransform: 'uppercase',
              color: D.inkSoft,
              lineHeight: 1.5,
              margin: '1rem 0 0'
            }}
          >
            {intl.formatMessage({ id: 'portal.upload.trust' })}
          </p>

          {/* Staged batch — bordered grid cell, no rounded corners, mono
              labels. Appears only when the user has staged at least one
              file. */}
          {stagedFiles.length > 0 && (
            <div
              style={{
                marginTop: '1.5rem',
                border: `1px solid ${D.rule}`,
                backgroundColor: D.paper
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: '1.5rem',
                  flexWrap: 'wrap',
                  padding: '1rem 1.25rem',
                  borderBottom: `1px solid ${D.rule}`
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span
                    style={{
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      color: D.ink,
                      fontWeight: 500
                    }}
                  >
                    {message('portal.documents.staged.title', { count: stagedFiles.length })}
                  </span>
                  <span
                    style={{
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      color: stagedOverLimit ? D.ink : D.inkMute
                    }}
                  >
                    {message('portal.documents.staged.limit', {
                      used: <FormattedValue>{formatFileSize(stagedTotalBytes, intl.formatMessage)}</FormattedValue>,
                      limit: <FormattedValue>{formatFileSize(MAX_EVIDENCE_UPLOAD_BYTES, intl.formatMessage)}</FormattedValue>
                    })}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={clearStagedFiles}
                    disabled={uploadBusy}
                    style={{
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      padding: '0.6rem 1.1rem',
                      background: 'transparent',
                      border: `1px solid ${D.rule}`,
                      color: D.inkSoft,
                      cursor: uploadBusy ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {message('portal.documents.staged.clear')}
                  </button>
                  <button
                    type="button"
                    onClick={submitStagedFiles}
                    disabled={!canSubmitStaged}
                    style={{
                      ...(canSubmitStaged ? D.noiseGold() : { backgroundColor: D.paperDeep }),
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      fontWeight: 500,
                      padding: '0.6rem 1.25rem',
                      border: `1px solid ${canSubmitStaged ? D.ink : D.rule}`,
                      color: canSubmitStaged ? D.ink : D.inkMute,
                      cursor: canSubmitStaged ? 'pointer' : 'not-allowed'
                    }}
                  >
                    {message(
                      uploadBusy ? 'portal.documents.staged.uploading' : 'portal.documents.staged.upload',
                      { count: stagedFiles.length }
                    )}
                  </button>
                </div>
              </div>
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'grid',
                  gap: '1px',
                  backgroundColor: D.rule
                }}
              >
                {stagedFiles.map((entry) => (
                  <li
                    key={entry.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.75rem 1.25rem',
                      backgroundColor: D.paper,
                      fontSize: '0.875rem',
                      color: D.ink
                    }}
                  >
                    <span
                      title={entry.file.name}
                      style={{
                        flex: '1 1 auto',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      <BidiText direction="auto">{entry.file.name}</BidiText>
                    </span>
                    <span
                      style={{
                        flex: '0 0 auto',
                        fontFamily: D.mono,
                        fontSize: 11,
                        letterSpacing: D.tracking.mono,
                        textTransform: 'uppercase',
                        color: D.inkMute
                      }}
                    >
                      <FormattedValue>{formatFileSize(Number(entry.file.size || 0), intl.formatMessage)}</FormattedValue>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeStagedFile(entry.key)}
                      disabled={uploadBusy}
                      aria-label={message('portal.reply.removeFile', { filename: entry.file.name })}
                      style={{
                        flex: '0 0 auto',
                        background: 'transparent',
                        border: 'none',
                        padding: '0.25rem 0.5rem',
                        fontSize: 18,
                        lineHeight: 1,
                        color: D.inkSoft,
                        cursor: uploadBusy ? 'not-allowed' : 'pointer'
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              {stagedError && (
                <div
                  role="alert"
                  style={{
                    padding: '0.75rem 1.25rem',
                    borderTop: `1px solid ${D.rule}`,
                    fontFamily: D.body,
                    fontSize: '0.875rem',
                    lineHeight: D.leading.body,
                    color: D.ink,
                    backgroundColor: D.paperDeep
                  }}
                >
                  <BidiText direction="auto">{stagedError}</BidiText>
                </div>
              )}
            </div>
          )}

          {uploadMessage && (
              <div
                role="status"
                style={{
                  marginTop: '1rem',
                  padding: '0.75rem 1rem',
                  border: `1px solid ${D.rule}`,
                  borderInlineStartWidth: '3px',
                  borderInlineStartStyle: 'solid',
                  borderInlineStartColor: D.ink,
                  backgroundColor: D.paper,
                  fontFamily: D.mono,
                  fontSize: 11,
                  letterSpacing: D.tracking.mono,
                  textTransform: 'uppercase',
                  color: D.ink
                }}
              >
                <BidiText direction="auto">{uploadMessage}</BidiText>
              </div>
          )}

          {/* Inline upload tray — replaces the bottom-right floating
              panel for the client portal. Files that have been sent
              (staged batch → "Upload" → tray rows) surface here with
              per-file progress, retry / dismiss controls, and the
              duplicate resolver. Same state machine as the floating
              tray (src/lib/uploadTray.js); the inline view just
              renders in the dossier vocabulary so the upload list
              reads as part of the same surface as the drop zone
              instead of a separate window in the bottom-right corner. */}
          <div style={{ marginTop: '1rem' }}>
            <UploadTray
              inline
              dataSource={previewMode ? 'local' : firmDataSource}
              activeClientId={selectedClient?.id || ''}
              onSnapshotInvalidated={onSnapshotInvalidated}
              hideSettledFromPreviousSessions
            />
          </div>
        </section>
        )}


        {/* Section § 03 — Activity (renumbered from § 04 after the
            old § 02 Open requests + § 03 Files sections collapsed
            into the single § 02 expandable list). Auto-hides entirely
            when the section has nothing concrete to show — i.e. DB
            mode, where no real doc-receipt activity feed is wired up
            server-side yet. In local-demo it surfaces the legacy
            BBVA fixture so the workbench still teaches the layout. */}
        {showLegacyActivityFixture && (
          <section
            style={{
              paddingTop: 'clamp(2.5rem, 6vw, 4rem)',
              paddingBottom: 'clamp(2.5rem, 6vw, 4rem)',
              borderBottom: `1px solid ${D.rule}`
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: '0.75rem 1.5rem',
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                color: D.inkSoft
              }}
            >
              <span style={{ color: D.ink }}>§ 03</span>
              <span>{message('portal.activity.title')}</span>
            </div>
            <p
              style={{
                margin: '1rem 0 0',
                fontFamily: D.body,
                fontSize: '1rem',
                lineHeight: D.leading.body,
                color: D.inkSoft,
                maxWidth: '40em'
              }}
            >
              {message('portal.activity.body')}
            </p>

            {/* Legacy BBVA fixture — bordered grid cell, no rounded
                corners, mono metadata. Only renders in local-demo
                mode (the parent section is gated on the same flag). */}
            <div
              style={{
                marginTop: 'clamp(2rem, 5vw, 3rem)',
                border: `1px solid ${D.rule}`,
                backgroundColor: D.paper,
                padding: 'clamp(1.25rem, 3vw, 1.75rem)',
                display: 'flex',
                gap: '1.25rem',
                alignItems: 'center',
                flexWrap: 'wrap'
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 56,
                  border: `1px solid ${D.rule}`,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: D.mono,
                  fontSize: 9,
                  color: D.inkMute,
                  letterSpacing: D.tracking.mono,
                  textTransform: 'uppercase',
                  flex: '0 0 auto'
                }}
              >
                <b style={{ color: D.ink, fontSize: 10, fontWeight: 500 }}>
                  <IdentifierText>{activityFixture.extension}</IdentifierText>
                </b>
                <span><FormattedValue>{formatFileSize(activityFixture.size, intl.formatMessage)}</FormattedValue></span>
              </div>
              <div style={{ flex: '1 1 12rem', minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '0.9375rem',
                    color: D.ink,
                    fontWeight: 500,
                    fontFamily: D.body,
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word'
                  }}
                >
                  <BidiText direction="auto">{activityFixture.filename}</BidiText>
                </div>
                <div
                  style={{
                    fontFamily: D.mono,
                    fontSize: 11,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    color: D.inkMute,
                    marginTop: '0.375rem'
                  }}
                >
                  {message('portal.activity.transactionCount', {
                    count: activityFixture.transactionCount,
                    date: <FormattedValue>{formatTimestamp(activityFixture.uploadedAt)}</FormattedValue>
                  })}
                </div>
              </div>
              <span
                style={{
                  marginInlineStart: 'auto',
                  fontFamily: D.mono,
                  fontSize: 10,
                  letterSpacing: D.tracking.mono,
                  textTransform: 'uppercase',
                  fontWeight: 500,
                  padding: '0.4rem 0.75rem',
                  border: `1px solid ${D.ink}`,
                  color: D.ink,
                  flex: '0 0 auto'
                }}
              >
                {message('portal.activity.received')}
              </span>
            </div>
          </section>
        )}

        {/* Section § 03 — Your uploads (DB mode). The real doc-receipt
            feed the legacy § 03 Activity comment above said was "not wired
            up server-side yet": every source document on file for this
            client's books, newest first, each with its PERSISTED
            parse_status verdict (never a re-inference) and a re-download of
            the ORIGINAL via the short-lived signed-URL endpoint. Mutually
            exclusive with the demo fixture above (that renders only when
            !databaseMode). Read-only — deletion stays a firm action with
            its existing safeguards. Duplicate-pending rows are hidden.
            Rendered as the "Previous uploads" tab pane (see the strip
            above), so it only shows when that tab is active. */}
        {showPreviousPane && (
          <section
            style={{
              paddingTop: 'clamp(1.5rem, 4vw, 2.5rem)',
              paddingBottom: 'clamp(2.5rem, 6vw, 4rem)',
              borderBottom: `1px solid ${D.rule}`
            }}
          >
            <p
              style={{
                margin: 0,
                fontFamily: D.body,
                fontSize: '1rem',
                lineHeight: D.leading.body,
                color: D.inkSoft,
                maxWidth: '40em'
              }}
            >
              {message('portal.documents.archive.body')}
            </p>

            {visibleUploads.length === 0 ? (
              <div
                style={{
                  marginTop: 'clamp(2rem, 5vw, 3rem)',
                  border: `1px solid ${D.rule}`,
                  backgroundColor: D.paper,
                  padding: 'clamp(1.25rem, 3vw, 1.75rem)',
                  fontFamily: D.body,
                  fontSize: '0.9375rem',
                  color: D.inkSoft
                }}
              >
                {message('portal.documents.archive.empty')}
              </div>
            ) : (
              <div
                style={{
                  marginTop: 'clamp(2rem, 5vw, 3rem)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  maxHeight: 'min(60vh, 34rem)',
                  overflowY: 'auto'
                }}
              >
                {visibleUploads.map((doc) => {
                  const status = getClientUploadStatus(PORTAL_PARSE_STATUS_MESSAGE_IDS[doc.parse_status] ? doc.parse_status : 'skipped');
                  const toneColor = UPLOAD_STATUS_TONE_COLOR[status.tone] || D.ink;
                  const typeMessageId = PORTAL_DOCUMENT_TYPE_MESSAGE_IDS[doc.document_type];
                  const typeLabel = typeMessageId
                    ? message(typeMessageId)
                    : humanizeDocumentType(doc.document_type);
                  const statusLabel = PORTAL_PARSE_STATUS_MESSAGE_IDS[doc.parse_status]
                    ? message(PORTAL_PARSE_STATUS_MESSAGE_IDS[doc.parse_status])
                    : message('portal.parseStatus.onFile');
                  const uploadedLabel = formatUploadDate(doc.uploaded_at || doc.created_at, formatDate);
                  const isDownloading = downloadingDocId === doc.id;
                  return (
                    <div
                      key={doc.id}
                      style={{
                        border: `1px solid ${D.rule}`,
                        backgroundColor: D.paper,
                        padding: 'clamp(1rem, 2.5vw, 1.5rem)',
                        display: 'flex',
                        gap: '1.25rem',
                        alignItems: 'center',
                        flexWrap: 'wrap'
                      }}
                    >
                      <div
                        style={{
                          width: 44,
                          height: 56,
                          border: `1px solid ${D.rule}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontFamily: D.mono,
                          fontSize: 10,
                          fontWeight: 500,
                          color: D.ink,
                          letterSpacing: D.tracking.mono,
                          textTransform: 'uppercase',
                          flex: '0 0 auto'
                        }}
                      >
                        <IdentifierText>{fileExtensionBadge(doc.filename)}</IdentifierText>
                      </div>
                      <div style={{ flex: '1 1 12rem', minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: '0.9375rem',
                            color: D.ink,
                            fontWeight: 500,
                            fontFamily: D.body,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          <BidiText direction="auto">{doc.filename || message('portal.documents.defaultName')}</BidiText>
                        </div>
                        <div
                          style={{
                            fontFamily: D.mono,
                            fontSize: 11,
                            letterSpacing: D.tracking.mono,
                            textTransform: 'uppercase',
                            color: D.inkMute,
                            marginTop: '0.375rem'
                          }}
                        >
                          {typeMessageId ? typeLabel : <IdentifierText>{typeLabel}</IdentifierText>}
                          {uploadedLabel && <> · {message('portal.documents.uploadedAt', {
                            size: <FormattedValue>{formatFileSize(doc.file_size, intl.formatMessage)}</FormattedValue>,
                            date: <FormattedValue>{uploadedLabel}</FormattedValue>
                          })}</>}
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.625rem',
                          marginInlineStart: 'auto',
                          flex: '0 0 auto'
                        }}
                      >
                        <span
                          style={{
                            fontFamily: D.mono,
                            fontSize: 10,
                            letterSpacing: D.tracking.mono,
                            textTransform: 'uppercase',
                            fontWeight: 500,
                            padding: '0.4rem 0.75rem',
                            border: `1px solid ${toneColor}`,
                            color: toneColor,
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {statusLabel}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDownloadDocument(doc)}
                          disabled={isDownloading}
                          style={{
                            fontFamily: D.mono,
                            fontSize: 10,
                            letterSpacing: D.tracking.mono,
                            textTransform: 'uppercase',
                            fontWeight: 500,
                            padding: '0.4rem 0.75rem',
                            border: `1px solid ${isDownloading ? D.inkMute : D.ink}`,
                            color: isDownloading ? D.inkMute : D.ink,
                            backgroundColor: 'transparent',
                            cursor: isDownloading ? 'default' : 'pointer',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {message(isDownloading ? 'portal.documents.downloading' : 'portal.documents.download')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {downloadError && (
              <p
                style={{
                  margin: '1rem 0 0',
                  fontFamily: D.body,
                  fontSize: '0.875rem',
                  color: D.alert
                }}
              >
                <BidiText direction="auto">{downloadError}</BidiText>
              </p>
            )}
          </section>
        )}

        {/* Section § 04 — Messages from Kari (renumbered from § 05). Drafted client-facing
            notes the firm sends from the actions panel. Sorted
            newest-first so the most recent message reads first;
            older notes (e.g. the original "Welcome to Donna"
            onboarding) slide to the bottom. Lives below the open
            requests so it never competes with an active question
            for the client's first scan. */}
        {firmMessages.length > 0 && (
          <section
            style={{
              paddingTop: 'clamp(2.5rem, 6vw, 4rem)',
              paddingBottom: 'clamp(2.5rem, 6vw, 4rem)',
              borderBottom: `1px solid ${D.rule}`
            }}
          >
            <div
              style={{
                display: 'flex',
                gap: '0.75rem 1.5rem',
                fontFamily: D.mono,
                fontSize: 11,
                letterSpacing: D.tracking.mono,
                textTransform: 'uppercase',
                color: D.inkSoft
              }}
            >
              <span style={{ color: D.ink }}>§ 04</span>
              <span>{message('portal.messages.title')}</span>
            </div>
            <h3
              style={{
                fontFamily: D.display,
                fontWeight: 400,
                fontSize: D.displayClamp(1.5, 5, 3),
                lineHeight: D.leading.displayLoose,
                letterSpacing: D.tracking.tighter,
                textTransform: 'uppercase',
                margin: '1rem 0 clamp(2rem, 5vw, 3rem)',
                color: D.ink,
                maxWidth: '22ch'
              }}
            >
              {message('portal.messages.count', { count: firmMessages.length })}
            </h3>
            <div
              style={{
                display: 'grid',
                gap: '1px',
                backgroundColor: D.rule,
                border: `1px solid ${D.rule}`
              }}
            >
              {firmMessages.map((message) => (
                <article
                  key={message.id}
                  style={{
                    backgroundColor: D.paper,
                    padding: 'clamp(1.25rem, 3vw, 1.75rem)'
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '1rem',
                      alignItems: 'baseline',
                      flexWrap: 'wrap',
                      marginBottom: '0.75rem'
                    }}
                  >
                    <div
                      style={{
                        fontFamily: D.mono,
                        fontSize: 11,
                        letterSpacing: D.tracking.mono,
                        textTransform: 'uppercase',
                        color: D.ink,
                        fontWeight: 500
                      }}
                    >
                      <BidiText direction="auto">{message.subject}</BidiText>
                    </div>
                    {message.sentAt && (
                      <div
                        style={{
                          fontFamily: D.mono,
                          fontSize: 11,
                          letterSpacing: D.tracking.mono,
                          textTransform: 'uppercase',
                          color: D.inkMute
                        }}
                      >
                        <FormattedValue>{formatUploadDate(message.sentAt, formatDate)}</FormattedValue>
                      </div>
                    )}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      font: 'inherit',
                      fontFamily: D.body,
                      fontSize: '0.9375rem',
                      lineHeight: D.leading.body,
                      color: D.ink,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }}
                  ><BidiText direction="auto">{message.body}</BidiText></pre>
                  <div
                    style={{
                      marginTop: '1rem',
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      color: D.inkMute
                    }}
                  >
                    — <BidiText direction="auto">{message.from}</BidiText>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Financial statements — P&L + Balance Sheet from Donna's own posted
            ledger (deterministic GL aggregation, footed server-side). The client
            sees the two headline statements with an honest draft banner and
            PDF/CSV downloads and supporting statements for checking the books. */}
        <ClientReports
          clientId={selectedClient?.id}
          databaseMode={liveDatabaseMode}
          ventureLabel={ventureLabel}
          defaultDate={portalPeriod.date}
          showSupportingStatements
        />

        <ClientBookInspection
          key={selectedClient?.id}
          clientId={selectedClient?.id}
          databaseMode={liveDatabaseMode}
          jurisdiction={selectedClient?.profile?.jurisdiction || selectedClient?.jurisdiction}
          defaultDate={portalPeriod.date}
        />

        {/* Editorial footer. Both lines render mono caps with wide
            tracking; the first reframes the support note in first
            person to match the rest of the page voice. */}
        <footer
          style={{
            marginTop: 'clamp(2rem, 5vw, 3rem)',
            paddingTop: '1.5rem',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '1rem',
            flexWrap: 'wrap',
            fontFamily: D.mono,
            fontSize: 11,
            letterSpacing: D.tracking.mono,
            textTransform: 'uppercase',
            color: D.inkMute
          }}
        >
          <span>{message('portal.footer.security')}</span>
        </footer>
      </div>

      {/* Donna chat — the owner's question surface (read-only Q&A,
          Slice 1). DB mode only: the thread and every answer come from
          the live workspace; there is no mock chat in local demo mode. */}
      {databaseMode && selectedClient?.id && (
        <ClientPortalChatPanel
          clientId={selectedClient.id}
          previewState={previewState?.chat || null}
          onBooksChanged={onSnapshotInvalidated}
          // Files dropped into the chat ride the SAME pipeline as the
          // drop box (tray batch → storage PUT → register → parse) — the
          // chat is another door, not a second upload path.
          onUploadFiles={(files) =>
            persistEvidenceFiles({
              question: { kind: 'Evidence', text: 'Uploaded in chat with Donna.' },
              reply: '',
              files
            })
          }
        />
      )}
    </div>
  );
}
