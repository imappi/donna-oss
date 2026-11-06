// UploadTray — persistent per-file progress tray for the async-parse
// pipeline. See docs/async-parsing-plan.md → "Frontend — upload tray
// with live progress".
//
// Rendering only — all state lives in src/lib/uploadTray.js (and via
// it, localStorage). This component subscribes to changes and polls
// /parse-status for non-terminal rows at the cadence the plan
// specifies (2s for first 30s, 6s thereafter).

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useIntl } from 'react-intl';
import { getBookSessionIdentity } from '../lib/bookSessionIdentity.js';

import {
  applyParseStatusUpdate,
  clearRowActionError,
  collectAllDocumentIds,
  canRetryRegistration,
  collectPollableDocumentIds,
  collectPreRegisterRetryRows,
  dismissAllRows,
  dismissAllTerminalRows,
  dismissTrayRow,
  dismissTrayRowsByDocumentIds,
  dismissTrayRowsByRowIds,
  duplicateResolveStateForRow,
  hideSettledRowsFromPreviousSessions,
  isTerminalRowExport,
  labelForTrayRow,
  loadTrayState,
  partitionTrayRowsForClient,
  setRowActionError,
  setRowRegistered,
  setRowRegisterFailed,
  subscribeToTrayChanges
} from '../lib/uploadTray.js';
import {
  fetchFirmDocumentsParseStatus,
  registerFirmDocuments,
  resolveDocumentDuplicate,
  retryFirmDocumentParse
} from '../lib/firmApi.js';
import { holdsRetainedUpload, reconcileOrphanedUploads, retryRetainedUpload } from '../lib/retainedUploads.js';
import { D } from './shared/design-tokens.js';
import { classifyDocumentFile } from '../lib/firmDocuments.js';
import { BidiText, FormattedValue } from '../i18n/BidiText.jsx';
import { useInterfaceLocale } from '../i18n/LocaleProvider.jsx';

const uiMessage = (intl, id, values) => intl.formatMessage({ id }, values);

const TONE_STYLES = {
  pending: { color: '#6b7280' },
  progress: { color: '#2563eb' },
  success: { color: '#15803d' },
  error: { color: '#b91c1c' },
  warning: { color: '#b45309' },
  muted: { color: '#6b7280' }
};

const EMPTY_ROW_IDS = new Set();
const noop = () => {};

const formatFileSize = (size = 0) => {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const pickPollInterval = (state, mountedAt) => {
  const ids = collectPollableDocumentIds(state);
  if (!ids.length) return { ids: [], intervalMs: 0 };
  const elapsed = Date.now() - mountedAt;
  return { ids, intervalMs: elapsed < 30_000 ? 2000 : 6000 };
};

const matchRowByDocumentId = (state, documentId) => {
  for (const batch of state.batches || []) {
    for (const row of batch.rows || []) {
      if (row.document_id === documentId) return row;
    }
  }
  return null;
};

// Dossier-styled tone palette used when the tray renders inline inside
// the client portal. Same semantic mapping as TONE_STYLES — pending /
// progress / success / error / warning / muted — but expressed in the
// portal's paper + ink vocabulary so the inline list sits cleanly
// against the dossier surrounding it.
const TONE_STYLES_DOSSIER = {
  pending: { color: D.inkMute },
  progress: { color: D.accentWarmFlat },
  success: { color: D.ink },
  error: { color: D.ink },
  warning: { color: D.accentWarmFlat },
  muted: { color: D.inkMute }
};

// Dossier inline renderer. Same rows, same actions, no floating
// panel — sits inline in the client portal directly under the drop
// box so "uploads in progress" is part of the same surface as the
// upload affordance instead of a separate bottom-right window. Paper +
// ink vocabulary throughout: hairline grid dividers, mono caps labels,
// no rounded corners, no shadows. Progress bars use the same
// noise-gold fill as the tile-grid progress in § 03.
const renderInlineDossier = ({
  intl,
  formatAmount,
  rows,
  hasTerminal,
  hasNonTerminal,
  retryingIds,
  resolvingIds,
  recheckingIds,
  handleRetry,
  handleRecheck,
  handleResolveDuplicate,
  clearFinished = dismissAllTerminalRows,
  clearAll = dismissAllRows
}) => (
  <div
    role="status"
    aria-live="polite"
    style={{
      backgroundColor: D.paper,
      border: `1px solid ${D.rule}`,
      fontFamily: D.body,
      color: D.ink
    }}
  >
    {/* Header strip — mono caps count on the left; Clear-finished /
        Clear-all action links on the right. Same affordance set as
        the floating tray, just dossier-styled. */}
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '0.85rem 1.1rem',
        borderBottom: `1px solid ${D.rule}`,
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
          fontWeight: 500
        }}
      >
        {uiMessage(intl, 'upload.title', { count: rows.length })}
      </span>
      <span style={{ display: 'inline-flex', gap: '0.75rem' }}>
        {hasTerminal && hasNonTerminal && (
          <button
            type="button"
            onClick={() => clearFinished()}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              padding: '0.15rem 0',
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
            {uiMessage(intl, 'upload.clear.finished')}
          </button>
        )}
        <button
          type="button"
          onClick={() => clearAll()}
          style={{
            appearance: 'none',
            background: 'transparent',
            border: 'none',
            padding: '0.15rem 0',
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
          {uiMessage(intl, 'upload.clear.all')}
        </button>
      </span>
    </div>
    {/* Row list — hairline grid via 1px gap pattern. Each row's bg is
        D.paper; the parent's D.rule background shows through the gap
        as a hairline divider. */}
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
      {rows.map((row) => {
        const meta = labelForTrayRow(row, intl.formatMessage, formatAmount);
        const tone = TONE_STYLES_DOSSIER[meta.tone] || TONE_STYLES_DOSSIER.muted;
        const isRetrying = retryingIds.has(row.document_id || row.row_id);
        const isResolving = row.document_id && resolvingIds.has(row.document_id);
        const isRechecking = row.document_id && recheckingIds.has(row.document_id);
        const duplicateResolveState = duplicateResolveStateForRow(row, intl.formatMessage);
        const isError = meta.tone === 'error';
        // "Re-check" affordance — shows up on rows whose label tone is
        // `pending` AND the BE knows about them (document_id set). One
        // click forces a /parse-status fetch for this row, applies the
        // result. Catches the case where the local row missed a poll
        // tick and is wedged at "Queued" while the BE has long since
        // moved it to duplicate_pending / completed / etc.
        const showRecheck = meta.tone === 'pending' && Boolean(row.document_id);
        return (
          <li
            key={row.row_id}
            style={{
              backgroundColor: D.paper,
              padding: '0.85rem 1.1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              // Hairline left rule signals errored rows without a
              // bg shift — same scan pattern as a partial tile.
              borderInlineStart: isError ? `3px solid ${D.ink}` : 'none',
              paddingInlineStart: isError ? `calc(1.1rem - 3px)` : '1.1rem'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: '0.75rem'
              }}
            >
              <span
                title={row.filename}
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: D.body,
                  fontSize: '0.9375rem',
                  fontWeight: 500,
                  color: D.ink
                }}
              >
                <BidiText direction="auto">{row.filename}</BidiText>
              </span>
              {row.size ? (
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
                  <FormattedValue>{formatFileSize(row.size)}</FormattedValue>
                </span>
              ) : null}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
                flexWrap: 'wrap'
              }}
            >
              <span
                style={{
                  fontFamily: D.mono,
                  fontSize: 11,
                  letterSpacing: D.tracking.mono,
                  textTransform: 'uppercase',
                  fontWeight: 500,
                  color: tone.color
                }}
              >
                {meta.label}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                {showRecheck && (
                  <button
                    type="button"
                    onClick={() => handleRecheck(row)}
                    disabled={isRechecking}
                    style={{
                      appearance: 'none',
                      background: 'transparent',
                      border: 'none',
                      padding: '0.3rem 0.25rem',
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      fontWeight: 500,
                      color: isRechecking ? D.inkMute : D.inkSoft,
                      textDecoration: 'underline',
                      textUnderlineOffset: '0.2em',
                      cursor: isRechecking ? 'wait' : 'pointer'
                    }}
                  >
                    {uiMessage(intl, isRechecking ? 'upload.checking' : 'upload.recheck')}
                  </button>
                )}
                {meta.retryable && (row.document_id || row.storage_object_key || holdsRetainedUpload(row.row_id)) && (
                  <button
                    type="button"
                    onClick={() => handleRetry(row)}
                    disabled={isRetrying}
                    style={{
                      fontFamily: D.mono,
                      fontSize: 11,
                      letterSpacing: D.tracking.mono,
                      textTransform: 'uppercase',
                      fontWeight: 500,
                      padding: '0.3rem 0.7rem',
                      border: `1px solid ${isRetrying ? D.rule : D.ink}`,
                      background: 'transparent',
                      color: isRetrying ? D.inkMute : D.ink,
                      cursor: isRetrying ? 'wait' : 'pointer'
                    }}
                  >
                    {uiMessage(intl, isRetrying ? 'upload.retrying' : 'upload.retry')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => dismissTrayRow({ rowId: row.row_id })}
                  aria-label={uiMessage(intl, 'upload.dismiss.file', { filename: row.filename })}
                  style={{
                    appearance: 'none',
                    background: 'transparent',
                    border: 'none',
                    padding: '0 0.3rem',
                    fontFamily: D.mono,
                    fontSize: 16,
                    lineHeight: 1,
                    color: D.inkSoft,
                    cursor: 'pointer'
                  }}
                >
                  ×
                </button>
              </span>
            </div>
            {row.upload_state === 'uploading' && (
              <div
                aria-hidden="true"
                style={{
                  height: 3,
                  position: 'relative',
                  backgroundColor: D.rule
                }}
              >
                <div
                  style={{
                    ...D.noiseGold(),
                    position: 'absolute',
                    insetBlockStart: 0,
                    insetInlineStart: 0,
                    height: '100%',
                    width: `${Math.round((row.upload_progress || 0) * 100)}%`,
                    transition: `width 200ms ${D.ease}`
                  }}
                />
              </div>
            )}
            {duplicateResolveState && row.document_id && (
              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  alignItems: 'center'
                }}
              >
                <button
                  type="button"
                  onClick={() => handleResolveDuplicate(row, 'create')}
                  disabled={isResolving}
                  title={uiMessage(intl, 'upload.duplicate.createTooltip')}
                  style={{
                    fontFamily: D.mono,
                    fontSize: 11,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    padding: '0.3rem 0.7rem',
                    border: `1px solid ${isResolving ? D.rule : D.ink}`,
                    background: 'transparent',
                    color: isResolving ? D.inkMute : D.ink,
                    cursor: isResolving ? 'wait' : 'pointer'
                  }}
                >
                  {uiMessage(intl, 'upload.duplicate.create')}
                </button>
                <button
                  type="button"
                  onClick={() => handleResolveDuplicate(row, 'replace')}
                  disabled={isResolving || duplicateResolveState.replace_blocked}
                  title={
                    duplicateResolveState.replace_blocked
                      ? duplicateResolveState.replace_blocked_tooltip
                      : uiMessage(intl, 'upload.duplicate.replaceTooltip')
                  }
                  style={{
                    fontFamily: D.mono,
                    fontSize: 11,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    padding: '0.3rem 0.7rem',
                    border: `1px solid ${duplicateResolveState.replace_blocked || isResolving ? D.rule : D.ink}`,
                    background: 'transparent',
                    color: duplicateResolveState.replace_blocked || isResolving ? D.inkMute : D.ink,
                    cursor: duplicateResolveState.replace_blocked
                      ? 'not-allowed'
                      : isResolving
                        ? 'wait'
                        : 'pointer'
                  }}
                >
                  {uiMessage(intl, duplicateResolveState.replace_blocked ? 'upload.duplicate.replaceBlocked' : 'upload.duplicate.replace')}
                </button>
                <button
                  type="button"
                  onClick={() => handleResolveDuplicate(row, 'cancel')}
                  disabled={isResolving}
                  title={uiMessage(intl, 'upload.duplicate.discardTooltip')}
                  style={{
                    fontFamily: D.mono,
                    fontSize: 11,
                    letterSpacing: D.tracking.mono,
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    padding: '0.3rem 0.7rem',
                    border: `1px solid ${isResolving ? D.rule : D.ink}`,
                    background: 'transparent',
                    color: isResolving ? D.inkMute : D.ink,
                    cursor: isResolving ? 'wait' : 'pointer'
                  }}
                >
                  {uiMessage(intl, 'upload.duplicate.cancel')}
                </button>
              </div>
            )}
            {row.action_error?.message && (
              <div
                role="alert"
                style={{
                  fontFamily: D.body,
                  fontSize: '0.8125rem',
                  lineHeight: D.leading.body,
                  color: D.ink,
                  backgroundColor: D.paperDeep,
                  border: `1px solid ${D.rule}`,
                  padding: '0.5rem 0.75rem'
                }}
              >
                <BidiText direction="auto">{row.action_error.message}</BidiText>
              </div>
            )}
            {row.parse_progress_total > 0 && row.parse_status === 'processing' && (
              <div
                aria-hidden="true"
                style={{
                  height: 3,
                  position: 'relative',
                  backgroundColor: D.rule
                }}
              >
                <div
                  style={{
                    ...D.noiseGold(),
                    position: 'absolute',
                    insetBlockStart: 0,
                    insetInlineStart: 0,
                    height: '100%',
                    width: `${Math.round(
                      ((row.parse_progress_current || 0) / row.parse_progress_total) * 100
                    )}%`,
                    transition: `width 200ms ${D.ease}`
                  }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  </div>
);

// Firm-dock activity renderer. It shares the tray's real state and actions,
// but not the client portal's dossier styling: compact system type, quiet
// dividers, one status voice, and controls only where the row needs a choice.
const renderInlineDock = ({
  intl,
  formatAmount,
  rows,
  hasSettled,
  retryingIds,
  resolvingIds,
  recheckingIds,
  handleRetry,
  handleRecheck,
  handleResolveDuplicate,
  handleDismiss,
  clearSettled,
  collapsed = false,
  onToggleCollapsed = null
}) => {
  const dockCardStyle = {
    border: `1px solid ${D.ruleSoft}`,
    borderRadius: 12,
    background: D.card,
    overflow: 'hidden',
    boxShadow: '0 3px 14px rgba(15, 15, 15, 0.035)',
    fontFamily: D.ui,
    color: D.ink
  };
  const tones = rows.map((row) => labelForTrayRow(row, intl.formatMessage, formatAmount).tone);
  const inFlightCount = tones.filter((tone) => tone === 'progress' || tone === 'pending').length;
  const failedCount = tones.filter((tone) => tone === 'error').length;
  // Collapsed (the default in the dock): upload activity is ONE line —
  // count, in-flight/failed summary, expand hint (Kari, 2026-09-01: the
  // 40%-of-rail tray block split the rail; the rail is one continuous
  // chat). The per-file list is one click away.
  if (collapsed) {
    return (
      <section aria-label={uiMessage(intl, 'upload.activity.aria')} style={dockCardStyle}>
        <button
          type="button"
          onClick={onToggleCollapsed || undefined}
          style={{
            width: '100%',
            minHeight: 36,
            padding: '7px 11px 6px',
            border: 'none',
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: D.ui,
            color: D.ink,
            cursor: onToggleCollapsed ? 'pointer' : 'default',
            textAlign: 'start'
          }}
        >
          <span
            aria-hidden="true"
            className={inFlightCount > 0 ? 'donna-working-dot' : undefined}
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              flex: '0 0 auto',
              background: failedCount > 0 ? D.alert : inFlightCount > 0 ? D.accentWarmFlat : D.inkMute,
              opacity: failedCount > 0 ? 1 : inFlightCount > 0 ? 0.9 : 0.55,
              animation: inFlightCount > 0 ? 'dotPulse 1.2s ease-in-out infinite' : 'none'
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 620 }}>
            {uiMessage(intl, 'upload.title', { count: rows.length })}
          </span>
          {inFlightCount > 0 && (
            <span style={{ fontSize: 12, color: D.inkMute }}>
              {uiMessage(intl, 'upload.strip.inFlight', { count: inFlightCount })}
            </span>
          )}
          {failedCount > 0 && (
            <span style={{ fontSize: 12, color: D.alert }}>
              {uiMessage(intl, 'upload.strip.failed', { count: failedCount })}
            </span>
          )}
          <span style={{ marginInlineStart: 'auto', fontSize: 12, color: D.inkMute }}>
            {uiMessage(intl, 'common.show')}
          </span>
        </button>
      </section>
    );
  }
  return (
  <section
    aria-label={uiMessage(intl, 'upload.activity.aria')}
    style={dockCardStyle}
  >
    <div
      style={{
        minHeight: 36,
        padding: '7px 11px 6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12
      }}
    >
      <button
        type="button"
        onClick={onToggleCollapsed || undefined}
        style={{
          border: 'none',
          background: 'transparent',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: D.ui,
          color: D.ink,
          cursor: onToggleCollapsed ? 'pointer' : 'default'
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 620 }}>
          {uiMessage(intl, 'upload.title', { count: rows.length })}
        </span>
        {onToggleCollapsed && (
          <span style={{ fontSize: 12, color: D.inkMute, fontWeight: 400 }}>
            {uiMessage(intl, 'common.hide')}
          </span>
        )}
      </button>
      {hasSettled && (
        <button
          type="button"
          onClick={() => clearSettled()}
          style={{
            border: 'none',
            background: 'transparent',
            padding: '3px 0',
            color: D.inkMute,
            fontFamily: D.ui,
            fontSize: 12,
            cursor: 'pointer'
          }}
        >
          {uiMessage(intl, 'upload.clear.done')}
        </button>
      )}
    </div>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map((row) => {
        const meta = labelForTrayRow(row, intl.formatMessage, formatAmount);
        const isRetrying = retryingIds.has(row.document_id || row.row_id);
        const isResolving = row.document_id && resolvingIds.has(row.document_id);
        const isRechecking = row.document_id && recheckingIds.has(row.document_id);
        const duplicateResolveState = duplicateResolveStateForRow(row, intl.formatMessage);
        const duplicateOfSameName = duplicateResolveState
          && row.parse_summary?.existing_filename === row.filename;
        const statusLabel = duplicateOfSameName ? uiMessage(intl, 'upload.status.alreadyUploaded') : meta.label;
        const showRecheck = meta.tone === 'pending' && Boolean(row.document_id);
        const working = meta.tone === 'progress' || meta.tone === 'pending';
        const failed = meta.tone === 'error';
        const warning = meta.tone === 'warning';
        const progress = row.upload_state === 'uploading'
          ? Math.max(0, Math.min(1, row.upload_progress || 0))
          : row.parse_status === 'processing' && row.parse_progress_total > 0
            ? Math.max(0, Math.min(1, (row.parse_progress_current || 0) / row.parse_progress_total))
            : null;
        return (
          <li
            key={row.row_id}
            style={{
              padding: '10px 11px 11px',
              borderTop: `1px solid ${D.ruleSoft}`
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span
                aria-hidden="true"
                className={working ? 'donna-working-dot' : undefined}
                style={{
                  width: 7,
                  height: 7,
                  marginTop: 5,
                  borderRadius: '50%',
                  flex: '0 0 auto',
                  background: failed ? D.alert : (warning || working) ? D.accentWarmFlat : D.inkMute,
                  opacity: failed || warning ? 1 : working ? 0.9 : 0.55,
                  animation: working ? 'dotPulse 1.2s ease-in-out infinite' : 'none'
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  title={row.filename}
                  style={{
                    color: D.ink,
                    fontSize: 13,
                    fontWeight: 500,
                    lineHeight: 1.35,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <BidiText direction="auto">{row.filename}</BidiText>
                </div>
                <div role="status" aria-live="polite" style={{ marginTop: 2, color: failed ? D.alert : warning ? D.inkSoft : D.inkMute, fontSize: 12, lineHeight: 1.4 }}>
                  <BidiText direction="auto">{statusLabel}{meta.detail ? ` · ${meta.detail}` : ''}</BidiText>
                </div>
              </div>
              {row.size ? (
                <span style={{ flex: '0 0 auto', color: D.inkMute, fontSize: 11.5, ...D.tabular }}>
                  <FormattedValue>{formatFileSize(row.size)}</FormattedValue>
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => handleDismiss(row)}
                aria-label={uiMessage(intl, 'upload.dismiss.file', { filename: row.filename })}
                style={{
                  border: 'none',
                  background: 'transparent',
                  paddingBlock: 0,
                  paddingInlineStart: 3,
                  paddingInlineEnd: 0,
                  color: D.inkMute,
                  fontFamily: D.ui,
                  fontSize: 15,
                  lineHeight: 1,
                  cursor: 'pointer'
                }}
              >
                ×
              </button>
            </div>
            {progress != null && (
              <div style={{ height: 2, marginBlockStart: 9, marginInlineStart: 17, marginInlineEnd: 25, background: D.ruleSoft, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.round(progress * 100)}%`,
                    height: '100%',
                    background: D.accentWarmFlat,
                    transition: `width 200ms ${D.ease}`
                  }}
                />
              </div>
            )}
            {(showRecheck || (meta.retryable && (row.document_id || row.storage_object_key || holdsRetainedUpload(row.row_id)))) && (
              <div style={{ display: 'flex', gap: 14, marginBlockStart: 8, marginInlineStart: 17 }}>
                {showRecheck && (
                  <button
                    type="button"
                    onClick={() => handleRecheck(row)}
                    disabled={isRechecking}
                    style={{ border: 'none', background: 'transparent', padding: 0, color: D.inkSoft, fontFamily: D.ui, fontSize: 12, cursor: isRechecking ? 'wait' : 'pointer' }}
                  >
                    {uiMessage(intl, isRechecking ? 'upload.checking' : 'upload.recheckNow')}
                  </button>
                )}
                {meta.retryable && (row.document_id || row.storage_object_key || holdsRetainedUpload(row.row_id)) && (
                  <button
                    type="button"
                    onClick={() => handleRetry(row)}
                    disabled={isRetrying}
                    style={{ border: 'none', background: 'transparent', padding: 0, color: D.inkSoft, fontFamily: D.ui, fontSize: 12, cursor: isRetrying ? 'wait' : 'pointer' }}
                  >
                    {uiMessage(intl, isRetrying ? 'upload.retrying' : 'upload.retry')}
                  </button>
                )}
              </div>
            )}
            {duplicateResolveState && row.document_id && (
              <div role="group" aria-label={uiMessage(intl, 'upload.duplicate.aria', { filename: row.filename })} style={{ display: 'inline-flex', maxWidth: 'calc(100% - 17px)', marginBlockStart: 9, marginInlineStart: 17, border: `1px solid ${D.rule}`, borderRadius: 8, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => handleResolveDuplicate(row, 'create')}
                  disabled={isResolving}
                  style={{ border: 'none', borderInlineEnd: `1px solid ${D.ruleSoft}`, background: D.ink, padding: '5px 9px', color: D.card, fontFamily: D.ui, fontSize: 11.5, fontWeight: 550, cursor: isResolving ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
                >
                  {uiMessage(intl, 'upload.duplicate.keepBoth')}
                </button>
                <button
                  type="button"
                  onClick={() => handleResolveDuplicate(row, 'replace')}
                  disabled={isResolving || duplicateResolveState.replace_blocked}
                  title={duplicateResolveState.replace_blocked ? duplicateResolveState.replace_blocked_tooltip : uiMessage(intl, 'upload.duplicate.replaceTooltip')}
                  style={{ border: 'none', borderInlineEnd: `1px solid ${D.ruleSoft}`, background: D.card, padding: '5px 9px', color: duplicateResolveState.replace_blocked ? D.inkMute : D.inkSoft, fontFamily: D.ui, fontSize: 11.5, cursor: duplicateResolveState.replace_blocked ? 'not-allowed' : isResolving ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
                >
                  {uiMessage(intl, duplicateResolveState.replace_blocked ? 'upload.duplicate.replaceUnavailable' : 'upload.duplicate.replaceEarlier')}
                </button>
                <button
                  type="button"
                  onClick={() => handleResolveDuplicate(row, 'cancel')}
                  disabled={isResolving}
                  style={{ border: 'none', background: D.card, padding: '5px 9px', color: D.inkMute, fontFamily: D.ui, fontSize: 11.5, cursor: isResolving ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
                >
                  {uiMessage(intl, 'upload.duplicate.discard')}
                </button>
              </div>
            )}
            {row.action_error?.message && (
              <div role="alert" style={{ marginBlockStart: 8, marginInlineStart: 17, color: D.alert, fontSize: 12, lineHeight: 1.4 }}>
                <BidiText direction="auto">{row.action_error.message}</BidiText>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  </section>
  );
};

export const UploadActivityRows = ({ rows }) => {
  const intl = useIntl();
  const { formatAmount } = useInterfaceLocale();
  return renderInlineDock({
    intl,
    formatAmount,
    rows,
    hasSettled: true,
    retryingIds: EMPTY_ROW_IDS,
    resolvingIds: EMPTY_ROW_IDS,
    recheckingIds: EMPTY_ROW_IDS,
    handleRetry: noop,
    handleRecheck: noop,
    handleResolveDuplicate: noop,
    handleDismiss: noop,
    clearSettled: noop
  });
};

const UploadTray = ({
  onSnapshotInvalidated,
  dataSource = 'database',
  inline = false,
  inlineVariant = 'dossier',
  activeClientId = '',
  // Client portal only: hide rows that settled (completed / skipped) in
  // an earlier page session — they're already listed under "Previous
  // uploads", so leaving them on the landing until the 24h TTL just
  // duplicates that tab. Render-time filter, no storage mutation; rows
  // needing action (failed / duplicate) and in-flight rows always show.
  hideSettledFromPreviousSessions = false,
  // Firm workspace: a parse that completed has its visible outcome in the
  // feed itself, so the tray row is done informing — drop it instead of
  // leaving an "Uploads · 1" panel parked over the workspace (Kari,
  // 2026-08-03). Only 'completed' auto-clears: failed / skipped /
  // duplicate_pending rows still need the user's eyes or a click, and
  // in-flight rows keep the never-silent guarantee.
  autoDismissCompleted = false,
  // Dock variant only: render the one-line activity strip instead of the
  // per-file list (the host owns the toggle state — the component stays
  // mounted either way so its parse-status poller keeps running).
  collapsed = false,
  onToggleCollapsed = null
}) => {
  const intl = useIntl();
  const { formatAmount } = useInterfaceLocale();
  const formatMessageRef = useRef(intl.formatMessage);
  formatMessageRef.current = intl.formatMessage;
  const [state, setState] = useState(() => loadTrayState());
  const [retryingIds, setRetryingIds] = useState(() => new Set());
  const [resolvingIds, setResolvingIds] = useState(() => new Set());
  // Per-row "checking now" set so the manual Re-check button can show
  // an in-flight state and prevent double-clicks. Distinct from the
  // steady-state poll because a Re-check is a user-initiated targeted
  // fetch — not part of the cadenced background loop.
  const [recheckingIds, setRecheckingIds] = useState(() => new Set());
  // Floating tray collapse — the expanded panel covers the bottom-right
  // of whatever workspace is open, so it opens as a one-line pill by
  // default and the user expands it when they want the detail; during a
  // long batch they can re-park it as a pill.
  const [minimized, setMinimized] = useState(true);
  const mountedAtRef = useRef(Date.now());

  useEffect(() => subscribeToTrayChanges(setState), []);

  // Mount-time revalidation: terminal rows (completed / failed / skipped
  // / duplicate_pending) don't participate in the steady-state poll, so
  // a between-session entity wipe would leave stale "2 transactions
  // imported" rows visible against documents the BE has dropped, AND a
  // BE state transition (e.g. /register returned 'pending' but the
  // worker raced ahead and moved the row to 'duplicate_pending' before
  // the FE polled) would leave a locally-stale "Queued" forever.
  //
  // The mount pass now does both jobs: dismiss missing IDs AND apply
  // the latest parse_status to every row the BE returned. The poll
  // loop only updates non-terminal rows; this pass closes the gap for
  // anything the local state already marked terminal but the BE moved
  // elsewhere, and also catches the inverse — local 'pending' that
  // should be 'duplicate_pending' / 'completed' / etc.
  // A row still 'uploading'/'held' with no uploader left (its page closed or
  // reloaded before the bytes were stored) becomes an explicit "not uploaded"
  // instead of resting at "Uploading 0%" (stability lane, 2026-09-23).
  useEffect(() => {
    reconcileOrphanedUploads();
  }, []);

  useEffect(() => {
    if (dataSource !== 'database') return;
    let cancelled = false;
    (async () => {
      const ids = collectAllDocumentIds(loadTrayState());
      if (!ids.length) return;
      try {
        const response = await fetchFirmDocumentsParseStatus({ ids });
        if (cancelled) return;
        const remoteRows = response?.documents || [];
        const returnedIds = new Set(remoteRows.map((row) => row.id));
        const missingIds = ids.filter((id) => !returnedIds.has(id));
        if (missingIds.length) dismissTrayRowsByDocumentIds({ documentIds: missingIds });
        const trayState = loadTrayState();
        const completedIds = [];
        for (const remote of remoteRows) {
          const localRow = matchRowByDocumentId(trayState, remote.id);
          if (!localRow) continue;
          applyParseStatusUpdate({ rowId: localRow.row_id, parseStatus: remote });
          if (remote.parse_status === 'completed') completedIds.push(remote.id);
        }
        // Auto-clear mode also sweeps rows that completed in an earlier
        // session — the stale "Uploads · 1" a relaunch would otherwise
        // resurrect from localStorage.
        if (autoDismissCompleted && completedIds.length) {
          dismissTrayRowsByDocumentIds({ documentIds: completedIds });
        }
      } catch {
        // Network hiccup — the regular poll picks up non-terminal rows
        // and we revalidate again on the next mount.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataSource, autoDismissCompleted]);

  // The same registration consumer owns mount recovery, a newly failed
  // batch on this page, and the explicit Retry button. One automatic attempt
  // per row per mount; failures stay actionable without an unbounded loop.
  const retryRegistrationRef = useRef(null);
  const registrationSession = getBookSessionIdentity();
  useEffect(() => {
    if (dataSource !== 'database') return;
    let cancelled = false;
    let running = false;
    const attempted = new Set();
    const queued = new Map();
    const controllers = new Set();
    const isCurrent = () => !cancelled && getBookSessionIdentity() === registrationSession;
    let retryingRow = null;
    const registerOne = async (orphan) => {
      retryingRow = orphan.row_id;
      const controller = new AbortController();
      controllers.add(controller);
      const deadline = setTimeout(() => controller.abort(), 15000);
      setRetryingIds(prev => new Set(prev).add(orphan.row_id));
      try {
        const response = await registerFirmDocuments({ signal: controller.signal, documents: [{
          id: orphan.row_id, client_id: orphan.client_id, filename: orphan.filename,
          document_type: orphan.document_type && orphan.document_type !== 'unknown'
            ? orphan.document_type : (classifyDocumentFile({ filename: orphan.filename }) || 'unknown'),
          storage_bucket: orphan.storage_bucket, storage_object_key: orphan.storage_object_key,
          checksum_sha256: orphan.checksum_sha256 || null,
          file_size: orphan.stored_size, mime_type: orphan.mime_type, batch_id: orphan.batch_id || null
        }] });
        if (!isCurrent()) return;
        const doc = response?.documents?.[0];
        if (!doc?.id || doc.client_id !== orphan.client_id
          || doc.storage_bucket !== orphan.storage_bucket || doc.storage_object_key !== orphan.storage_object_key) {
          throw new Error(formatMessageRef.current({ id: 'upload.error.register' }));
        }
        setRowRegistered({ rowId: orphan.row_id, document: doc });
      } catch (err) {
        if (isCurrent()) setRowRegisterFailed({ rowId: orphan.row_id,
          message: err?.message || formatMessageRef.current({ id: 'upload.error.register' }), code: err?.code });
      } finally {
        clearTimeout(deadline);
        controllers.delete(controller);
        retryingRow = null;
        if (isCurrent()) setRetryingIds(prev => { const next = new Set(prev); next.delete(orphan.row_id); return next; });
      }
    };
    const drain = async () => {
      if (running || !isCurrent()) return;
      running = true;
      try {
        while (queued.size && isCurrent()) {
          const [id] = queued.entries().next().value;
          queued.delete(id);
          // Another registration may have completed while this row waited.
          const current = collectPreRegisterRetryRows(loadTrayState()).find(row => row.row_id === id);
          if (current && canRetryRegistration(current)) await registerOne(current);
        }
      } finally { running = false; }
    };
    const enqueue = (orphan, manual = false) => {
      if (!isCurrent() || !canRetryRegistration(orphan) || queued.has(orphan.row_id) || retryingRow === orphan.row_id) return;
      if (!manual && attempted.has(orphan.row_id)) return;
      attempted.add(orphan.row_id);
      queued.set(orphan.row_id, orphan);
      void drain();
    };
    // Coalesce manual clicks with the sequential consumer, including its
    // currently awaited request (state rendering can lag the first click).
    retryRegistrationRef.current = row => {
      const orphan = collectPreRegisterRetryRows(loadTrayState()).find(item => item.row_id === row.row_id);
      if (orphan) enqueue(orphan, true);
    };
    const schedule = (initial = false) => {
      for (const orphan of collectPreRegisterRetryRows(loadTrayState())) {
        if (initial || orphan.register_warning) enqueue(orphan);
      }
    };
    const unsubscribe = subscribeToTrayChanges(() => schedule());
    schedule(true);
    return () => {
      cancelled = true;
      unsubscribe();
      queued.clear();
      for (const controller of controllers) controller.abort();
      retryRegistrationRef.current = null;
    };
  }, [dataSource, registrationSession]);

  const pollOnce = useCallback(async ({ signal, isCurrent }) => {
    if (dataSource !== 'database') return;
    const ids = collectPollableDocumentIds(loadTrayState());
    if (!ids.length) return;
    try {
      const response = await fetchFirmDocumentsParseStatus({ ids, signal });
      if (!isCurrent()) return;
      const currentState = loadTrayState();
      const remoteRows = response?.documents || [];
      // Any id we asked about and didn't get back is gone server-side
      // (entity deleted, duplicate cancel-resolved, manual prune).
      // Drop those rows from the tray instead of letting them poll
      // forever with stale "Queued" copy.
      const returnedIds = new Set(remoteRows.map((row) => row.id));
      const missingIds = ids.filter((id) => !returnedIds.has(id));
      if (missingIds.length) {
        dismissTrayRowsByDocumentIds({ documentIds: missingIds });
      }
      let anyCompletedThisTick = false;
      const completedIds = [];
      for (const remote of remoteRows) {
        const localRow = matchRowByDocumentId(currentState, remote.id);
        if (!localRow) continue;
        const wasTerminal = isTerminalRowExport(localRow);
        applyParseStatusUpdate({ rowId: localRow.row_id, parseStatus: remote });
        if (remote.parse_status === 'completed') {
          completedIds.push(remote.id);
          if (!wasTerminal) anyCompletedThisTick = true;
        }
      }
      if (autoDismissCompleted && completedIds.length) {
        dismissTrayRowsByDocumentIds({ documentIds: completedIds });
      }
      if (anyCompletedThisTick && typeof onSnapshotInvalidated === 'function') {
        // Plan §Polling: "Snapshot refetch in background whenever any
        // doc flips to completed (the new transactions show up in the
        // entity workspace)."
        try { await onSnapshotInvalidated(); } catch { /* non-fatal */ }
      }
    } catch {
      // Poll errors are non-fatal — the next tick retries. Network
      // hiccups shouldn't tear down the tray.
    }
  }, [dataSource, onSnapshotInvalidated, autoDismissCompleted]);

  // Polling loop. Cadence reads back from state on each tick so a fresh
  // upload that lands mid-loop gets picked up immediately.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const controller = new AbortController();
    const identity = getBookSessionIdentity();
    const isCurrent = () => !cancelled && identity === getBookSessionIdentity();
    const tick = async () => {
      if (!isCurrent()) return;
      await pollOnce({ signal: controller.signal, isCurrent });
      // State updates and slow snapshot reads can outlive this effect. An
      // obsolete tick must never recreate a timer after cleanup/unmount.
      if (!isCurrent()) return;
      const { intervalMs } = pickPollInterval(loadTrayState(), mountedAtRef.current);
      timer = setTimeout(tick, intervalMs || 2000);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [pollOnce]);

  // Distill an error from /resolve-duplicate or /retry-parse into a
  // single-line user-facing message. The BE returns
  // 409 { code, error, details } for the known business-rule blocks
  // (REPLACE_BLOCKED_REVIEWED_TX, REPLACE_CANONICAL_MISSING, …); those get
  // code-keyed copy, everything else the generic catalog line. The server's
  // `error` text is never rendered (FI-05): it can carry storage, provider
  // or database detail.
  const friendlyActionError = (err) => {
    const code = err?.code || err?.body?.code || null;
    if (code === 'REPLACE_BLOCKED_REVIEWED_TX') {
      return { code, message: uiMessage(intl, 'upload.error.replaceReviewed') };
    }
    if (code === 'REPLACE_CANONICAL_MISSING') {
      return { code, message: uiMessage(intl, 'upload.error.canonicalMissing') };
    }
    if (code === 'REPLACE_NO_CANONICAL') {
      return { code, message: uiMessage(intl, 'upload.error.noCanonical') };
    }
    if (code === 'DOCUMENT_NOT_FOUND') {
      return { code, message: uiMessage(intl, 'upload.error.documentMissing') };
    }
    // FI-05: an uncatalogued failure (storage, provider, database, network)
    // is never shown as its raw message — the catalog's generic copy only.
    return { code, message: uiMessage(intl, 'upload.error.generic') };
  };

  const handleResolveDuplicate = async (row, action) => {
    if (!row.document_id) return;
    if (resolvingIds.has(row.document_id)) return;
    clearRowActionError({ rowId: row.row_id });
    setResolvingIds((prev) => {
      const next = new Set(prev);
      next.add(row.document_id);
      return next;
    });
    try {
      const response = await resolveDocumentDuplicate({
        documentId: row.document_id,
        action
      });
      if (action === 'cancel') {
        // BE deleted the row. Drop the tray entry — there's nothing to
        // poll for anymore.
        dismissTrayRow({ rowId: row.row_id });
        return;
      }
      if (response?.applied && response?.document) {
        applyParseStatusUpdate({
          rowId: row.row_id,
          parseStatus: {
            parse_status: response.document.parse_status || 'pending',
            parse_stage: response.document.parse_stage || null,
            parse_progress_current: null,
            parse_progress_total: null,
            parse_summary: null,
            parse_error: null,
            duplicate_of: null
          }
        });
      }
      // applied=false → idempotent no-op. The next poll tick will
      // reconcile whatever state the doc is in now.
    } catch (err) {
      // Inline error on the row so a 409 from the resolver doesn't
      // disappear into the void. applyParseStatusUpdate on the next
      // poll tick clears it once the BE has caught up.
      const { code, message } = friendlyActionError(err);
      setRowActionError({ rowId: row.row_id, message, code });
    } finally {
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.document_id);
        return next;
      });
    }
  };

  // Targeted /parse-status fetch for a single row. Used by the "Re-check"
  // button surfaced on rows whose label tone is `pending` and the row
  // has a document_id (so the BE knows about it). The steady-state poll
  // does this on a cadence; this gives the user a one-click resync when
  // a row has been "Queued" longer than they expect — most often
  // because the BE moved the row to duplicate_pending after register
  // returned 'pending', and the local row didn't catch the update for
  // whatever reason (closure capture, browser tab inactive, dropped
  // tick, etc.).
  const handleRecheck = async (row) => {
    if (!row.document_id) return;
    if (recheckingIds.has(row.document_id)) return;
    clearRowActionError({ rowId: row.row_id });
    setRecheckingIds((prev) => {
      const next = new Set(prev);
      next.add(row.document_id);
      return next;
    });
    try {
      const response = await fetchFirmDocumentsParseStatus({ ids: [row.document_id] });
      const remote = (response?.documents || [])[0];
      if (!remote) {
        // BE no longer knows about this id — same semantics as the
        // steady-state poll: dismiss the row.
        dismissTrayRowsByDocumentIds({ documentIds: [row.document_id] });
        return;
      }
      applyParseStatusUpdate({ rowId: row.row_id, parseStatus: remote });
      // Completed rows leave the poll set, so without this a Re-check
      // that lands on 'completed' would park the row forever.
      if (autoDismissCompleted && remote.parse_status === 'completed') {
        dismissTrayRowsByDocumentIds({ documentIds: [row.document_id] });
      }
    } catch (err) {
      setRowActionError({
        rowId: row.row_id,
        message: uiMessage(intl, 'upload.error.refresh'),
        code: 'RECHECK_FAILED'
      });
    } finally {
      setRecheckingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.document_id);
        return next;
      });
    }
  };

  const handleRetry = async (row) => {
    // Bytes never reached storage but this page still holds the file (a
    // refused or failed upload): re-send it — no re-selecting the file.
    if (!row.document_id && !row.storage_object_key && holdsRetainedUpload(row.row_id)) {
      await retryRetainedUpload(row.row_id);
      return;
    }
    if (!row.document_id) { retryRegistrationRef.current?.(row); return; }
    if (retryingIds.has(row.document_id)) return;
    clearRowActionError({ rowId: row.row_id });
    setRetryingIds((prev) => {
      const next = new Set(prev);
      next.add(row.document_id);
      return next;
    });
    try {
      await retryFirmDocumentParse({ documentIds: [row.document_id] });
      applyParseStatusUpdate({
        rowId: row.row_id,
        parseStatus: { parse_status: 'pending', parse_stage: null, parse_error: null, parse_summary: null }
      });
    } catch (err) {
      const { code, message } = friendlyActionError(err);
      setRowActionError({ rowId: row.row_id, message, code });
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.document_id);
        return next;
      });
    }
  };

  // Scope the tray to the open client workspace — uploading one
  // client's documents must not blanket another client's view (sighted:
  // 45 Honeybee uploads covering the pilot client's transaction chat). Uploads
  // for other clients keep running and keep polling; they render here
  // only as a one-line count.
  const { visible, otherCount } = useMemo(
    () => partitionTrayRowsForClient(state, activeClientId),
    [state, activeClientId]
  );
  const rows = useMemo(
    () => (hideSettledFromPreviousSessions ? hideSettledRowsFromPreviousSessions(visible) : visible),
    [hideSettledFromPreviousSessions, visible]
  );
  if (!rows.length && !otherCount) return null;

  const hasTerminal = rows.some(isTerminalRowExport);
  const hasNonTerminal = rows.some((row) => !isTerminalRowExport(row));
  const dockSettledRows = rows.filter((row) => row.parse_status === 'completed' || row.parse_status === 'skipped');

  // Clear buttons act on the rows the user can SEE. Unscoped mounts
  // keep the global wipes.
  const clearFinished = () => {
    if (!activeClientId) return dismissAllTerminalRows();
    dismissTrayRowsByRowIds({ rowIds: rows.filter(isTerminalRowExport).map((row) => row.row_id) });
  };
  const clearAll = () => {
    if (!activeClientId) return dismissAllRows();
    dismissTrayRowsByRowIds({ rowIds: rows.map((row) => row.row_id) });
  };

  if (inline) {
    if (!rows.length) return null;
    if (inlineVariant === 'dock') {
      return renderInlineDock({
        intl,
        formatAmount,
        rows,
        hasSettled: dockSettledRows.length > 0,
        retryingIds,
        resolvingIds,
        recheckingIds,
        handleRetry,
        handleRecheck,
        handleResolveDuplicate,
        handleDismiss: (row) => dismissTrayRow({ rowId: row.row_id }),
        clearSettled: () => dismissTrayRowsByRowIds({ rowIds: dockSettledRows.map((row) => row.row_id) }),
        collapsed,
        onToggleCollapsed
      });
    }
    return renderInlineDossier({
      intl,
      formatAmount,
      rows,
      hasTerminal,
      hasNonTerminal,
      retryingIds,
      resolvingIds,
      recheckingIds,
      handleRetry,
      handleRecheck,
      handleResolveDuplicate,
      clearFinished,
      clearAll
    });
  }

  // Pill mode: minimized by hand, or nothing to show for THIS client
  // while other clients' uploads run in the background.
  if (minimized || !rows.length) {
    const label = rows.length
      ? uiMessage(intl, otherCount ? 'upload.title.withOther' : 'upload.title', { count: rows.length, otherCount })
      : uiMessage(intl, 'upload.title.otherClients', { count: otherCount });
    return (
      <button
        type="button"
        onClick={rows.length ? () => setMinimized(false) : undefined}
        title={uiMessage(intl, rows.length ? 'upload.show' : 'upload.show.other')}
        style={{
          position: 'fixed',
          insetInlineEnd: 16,
          insetBlockEnd: 16,
          zIndex: 50,
          border: '1px solid rgba(15, 15, 15, 0.08)',
          borderRadius: 9999,
          background: '#fff',
          boxShadow: '0 6px 18px rgba(15, 15, 15, 0.10)',
          padding: '8px 14px',
          fontSize: 12,
          fontWeight: 600,
          color: '#374151',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          cursor: rows.length ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        {hasNonTerminal && (
          <span
            aria-hidden="true"
            style={{ width: 7, height: 7, borderRadius: '50%', background: '#2563eb' }}
          />
        )}
        {label}
      </button>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        insetInlineEnd: 16,
        insetBlockEnd: 16,
        zIndex: 50,
        width: 340,
        maxHeight: '60vh',
        overflowY: 'auto',
        background: '#fff',
        borderRadius: 10,
        boxShadow: '0 10px 30px rgba(15, 15, 15, 0.12)',
        border: '1px solid rgba(15, 15, 15, 0.08)',
        padding: 12,
        fontSize: 13,
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8
        }}
      >
        <strong style={{ fontWeight: 600 }}>{uiMessage(intl, 'upload.title', { count: rows.length })}</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasTerminal && hasNonTerminal && (
            <button
              type="button"
              onClick={clearFinished}
              style={{
                border: 'none',
                background: 'transparent',
                color: '#6b7280',
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              {uiMessage(intl, 'upload.clear.finished')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMinimized(true)}
            title={uiMessage(intl, 'upload.minimize')}
            aria-label={uiMessage(intl, 'upload.minimize.aria')}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#6b7280',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            {uiMessage(intl, 'upload.minimize')}
          </button>
          <button
            type="button"
            onClick={clearAll}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#6b7280',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            {uiMessage(intl, 'upload.clear.all')}
          </button>
        </div>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row) => {
          const meta = labelForTrayRow(row, intl.formatMessage, formatAmount);
          const tone = TONE_STYLES[meta.tone] || TONE_STYLES.muted;
          const isRetrying = retryingIds.has(row.document_id || row.row_id);
          const isResolving = row.document_id && resolvingIds.has(row.document_id);
          // Duplicate-pending rows surface the 3-way resolver inline.
          // `replace_blocked` is computed BE-side and stored in
          // parse_summary; the BE re-checks under FOR UPDATE locks
          // inside resolveDuplicateInDb, so this flag is just a UX
          // pre-disable — not the source of truth.
          const duplicateResolveState = duplicateResolveStateForRow(row, intl.formatMessage);
          return (
            <li
              key={row.row_id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '8px 10px',
                borderRadius: 8,
                background: '#fafaf9'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span
                  title={row.filename}
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: 500
                  }}
                >
                  <BidiText direction="auto">{row.filename}</BidiText>
                </span>
                {row.size ? (
                  <span style={{ color: '#9ca3af', fontSize: 11, flex: '0 0 auto' }}>
                    <FormattedValue>{formatFileSize(row.size)}</FormattedValue>
                  </span>
                ) : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ ...tone, fontSize: 12 }}>{meta.label}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {meta.retryable && (row.document_id || row.storage_object_key || holdsRetainedUpload(row.row_id)) && (
                    <button
                      type="button"
                      onClick={() => handleRetry(row)}
                      disabled={isRetrying}
                      style={{
                        background: 'transparent',
                        border: '1px solid #d4d4d8',
                        borderRadius: 6,
                        padding: '2px 8px',
                        fontSize: 11,
                        cursor: isRetrying ? 'wait' : 'pointer',
                        color: isRetrying ? '#9ca3af' : '#111827'
                      }}
                    >
                      {uiMessage(intl, isRetrying ? 'upload.retrying' : 'upload.retry')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => dismissTrayRow({ rowId: row.row_id })}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#9ca3af',
                      fontSize: 14,
                      cursor: 'pointer',
                      padding: '0 2px'
                    }}
                    aria-label={uiMessage(intl, 'upload.dismiss.file', { filename: row.filename })}
                  >
                    ×
                  </button>
                </div>
              </div>
              {row.upload_state === 'uploading' && (
                <div
                  aria-hidden="true"
                  style={{
                    height: 3,
                    borderRadius: 2,
                    background: '#e5e7eb',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((row.upload_progress || 0) * 100)}%`,
                      height: '100%',
                      background: '#2563eb',
                      transition: 'width 200ms ease'
                    }}
                  />
                </div>
              )}
              {duplicateResolveState && row.document_id && (
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                    alignItems: 'center'
                  }}
                >
                  <button
                    type="button"
                    onClick={() => handleResolveDuplicate(row, 'create')}
                    disabled={isResolving}
                    style={{
                      background: 'transparent',
                      border: '1px solid #d4d4d8',
                      borderRadius: 6,
                      padding: '2px 8px',
                      fontSize: 11,
                      cursor: isResolving ? 'wait' : 'pointer',
                      color: isResolving ? '#9ca3af' : '#111827'
                    }}
                    title={uiMessage(intl, 'upload.duplicate.createTooltip')}
                  >
                    {uiMessage(intl, 'upload.duplicate.create')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResolveDuplicate(row, 'replace')}
                    disabled={isResolving || duplicateResolveState.replace_blocked}
                    title={
                      duplicateResolveState.replace_blocked
                        ? duplicateResolveState.replace_blocked_tooltip
                        : uiMessage(intl, 'upload.duplicate.replaceTooltip')
                    }
                    style={{
                      background: 'transparent',
                      border: '1px solid #d4d4d8',
                      borderRadius: 6,
                      padding: '2px 8px',
                      fontSize: 11,
                      cursor: duplicateResolveState.replace_blocked
                        ? 'not-allowed'
                        : isResolving
                          ? 'wait'
                          : 'pointer',
                      color: duplicateResolveState.replace_blocked
                        ? '#9ca3af'
                        : isResolving
                          ? '#9ca3af'
                          : '#111827'
                    }}
                  >
                    {uiMessage(intl, duplicateResolveState.replace_blocked ? 'upload.duplicate.replaceBlocked' : 'upload.duplicate.replace')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResolveDuplicate(row, 'cancel')}
                    disabled={isResolving}
                    style={{
                      background: 'transparent',
                      border: '1px solid #d4d4d8',
                      borderRadius: 6,
                      padding: '2px 8px',
                      fontSize: 11,
                      cursor: isResolving ? 'wait' : 'pointer',
                      color: isResolving ? '#9ca3af' : '#111827'
                    }}
                    title={uiMessage(intl, 'upload.duplicate.discardTooltip')}
                  >
                    {uiMessage(intl, 'upload.duplicate.cancel')}
                  </button>
                </div>
              )}
              {row.action_error?.message && (
                <div
                  role="alert"
                  style={{
                    fontSize: 11,
                    color: '#b91c1c',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 6,
                    padding: '4px 8px'
                  }}
                >
                  <BidiText direction="auto">{row.action_error.message}</BidiText>
                </div>
              )}
              {row.parse_progress_total > 0 && row.parse_status === 'processing' && (
                <div
                  aria-hidden="true"
                  style={{
                    height: 3,
                    borderRadius: 2,
                    background: '#e5e7eb',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(
                        ((row.parse_progress_current || 0) / row.parse_progress_total) * 100
                      )}%`,
                      height: '100%',
                      background: '#2563eb',
                      transition: 'width 200ms ease'
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {otherCount > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(15, 15, 15, 0.06)', color: '#9ca3af', fontSize: 11 }}>
          {uiMessage(intl, 'upload.otherClients', { count: otherCount })}
        </div>
      )}
    </div>
  );
};

export default UploadTray;
