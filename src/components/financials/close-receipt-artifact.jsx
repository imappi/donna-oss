import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createCloseArchive,
  fetchCloseArchiveExport,
  fetchCloseArchivePreview,
  formatFirmError
} from '../../lib/firmApi.js';
import { buildTositeIndex, formatTositeLabel } from '../../lib/tositeNumber.js';
import { D } from '../shared/design-tokens.js';
import { btnChip, btnDisabled, btnPrimary } from '../shared/buttons.js';
import { dayRangeLabel } from '../shared/snapshot-dates.js';

// C2c — the close receipt artifact (two-surface IA stage C,
// docs/design-donna-two-surface-ia.md §7): the §2 "receipt when it closes".
// Opened from the Locked month badge in Material's Reconciled list, it is the
// standing home for what the Close tab uniquely carried on the receipt side:
// the locked-at receipt, the continuity package (generate / re-generate /
// download, custody statement, manifest checksums), and the period's
// statutory voucher (tosite) numbers.
//
// Render-the-persisted-verdict: the header and voucher list render rows the
// snapshot already carries (close_periods row + payload, close_archives row,
// the period's ledger_journals — captured into artifact.data by the opener);
// the archive block's merge rule mirrors the retired close tab: the
// PERSISTED close_archives row wins for "what is saved", the dry-run
// archive-preview fetch describes what a (re)generation would contain, and a
// generation this session folds its returned row over both.

const sectionTitleStyle = {
  fontFamily: D.ui,
  fontSize: 12,
  fontWeight: 600,
  color: D.ink,
  padding: '14px 0 6px'
};

const metaStyle = {
  fontFamily: D.ui,
  fontSize: 12,
  color: D.inkMute,
  ...D.tabular
};

const kvRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  fontFamily: D.ui,
  fontSize: 12.5,
  padding: '3px 0'
};

const monoValueStyle = {
  fontFamily: D.mono,
  fontSize: 11,
  color: D.inkSoft,
  wordBreak: 'break-all',
  textAlign: 'right'
};

const fmtDateTime = (value) => {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  });
};

const Kv = ({ label, value, mono = false }) => (
  value == null || value === '' ? null : (
    <div style={kvRowStyle}>
      <span style={{ color: D.inkMute }}>{label}</span>
      <span style={mono ? monoValueStyle : { color: D.inkSoft, textAlign: 'right' }}>{value}</span>
    </div>
  )
);

const CloseReceiptArtifact = ({ artifact, onRefreshRef }) => {
  const data = artifact?.data || {};
  const {
    clientId,
    periodStart,
    periodEnd,
    label,
    closePeriod,
    archiveRecord,
    periodJournals
  } = data;

  // The freshest archive state this session knows: a row generated here wins
  // over the snapshot's persisted row, which wins over the dry-run preview.
  const [generatedArchive, setGeneratedArchive] = useState(null);
  const [archivePreview, setArchivePreview] = useState(null);
  const [previewStatus, setPreviewStatus] = useState('idle');
  const [busy, setBusy] = useState(null); // 'generate' | 'download' | null
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const abortRef = useRef(null);

  const loadPreview = useCallback(async () => {
    if (!clientId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPreviewStatus('loading');
    try {
      const preview = await fetchCloseArchivePreview({
        clientId,
        periodStart,
        periodEnd,
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      setArchivePreview(preview || null);
      setPreviewStatus('ready');
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(formatFirmError(err, 'Could not load the continuity-package preview.'));
      setPreviewStatus('error');
    }
  }, [clientId, periodStart, periodEnd]);

  useEffect(() => {
    loadPreview();
    return () => abortRef.current?.abort();
  }, [loadPreview]);

  useEffect(() => {
    if (!onRefreshRef) return undefined;
    onRefreshRef.current = loadPreview;
    return () => { onRefreshRef.current = null; };
  }, [onRefreshRef, loadPreview]);

  const archive = generatedArchive || archiveRecord || null;
  const manifest = archive?.manifest || archivePreview?.manifest || null;
  const custody = archive?.payload?.custody_statement
    || manifest?.custody_statement
    || archivePreview?.sections?.custody_statement
    || null;
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const isGenerated = !!archive && archive.status !== 'preview';
  const exportHandoff = archive?.payload?.export_handoff || null;

  const vouchers = useMemo(() => {
    const journals = Array.isArray(periodJournals) ? periodJournals : [];
    const index = buildTositeIndex(journals);
    return journals
      .slice()
      .sort((a, b) => String(a?.journal_date || '').localeCompare(String(b?.journal_date || '')))
      .map((journal) => ({
        id: journal?.id ?? null,
        date: journal?.journal_date ?? null,
        memo: journal?.memo || journal?.description || null,
        tosite: formatTositeLabel(index.get(journal?.id))
      }));
  }, [periodJournals]);

  const onGenerate = async () => {
    if (!clientId) return;
    setBusy('generate');
    setError(null);
    setNotice(null);
    try {
      const response = await createCloseArchive({ clientId, periodStart, periodEnd });
      const row = response?.close_archive || response?.archive || response || null;
      if (row) setGeneratedArchive(row);
      setNotice('Continuity package generated.');
      await loadPreview();
    } catch (err) {
      setError(formatFirmError(err, 'Could not generate the continuity package.'));
    } finally {
      setBusy(null);
    }
  };

  const onDownload = async () => {
    if (!clientId) return;
    setBusy('download');
    setError(null);
    setNotice(null);
    try {
      const bundle = await fetchCloseArchiveExport({
        clientId,
        archiveId: archive?.id || archive?.archive_id || undefined,
        periodStart,
        periodEnd
      });
      const filename = bundle?.filename
        || `donna-close-archive-${clientId}-${periodStart}-${periodEnd}.json`;
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      // The export writer stamps delivery on the archive row — fold the
      // handoff receipt over the local state so the block reflects it
      // without waiting for the next snapshot. Only over an EXISTING
      // archive: a preview-only download must not fabricate a
      // "Generated" state.
      if (bundle?.handoff && archive) {
        setGeneratedArchive({
          ...archive,
          storage_status: bundle.storage?.status || 'delivered',
          payload: {
            ...(archive.payload || {}),
            export_handoff: bundle.handoff
          }
        });
      }
      setNotice('Continuity package downloaded.');
    } catch (err) {
      setError(formatFirmError(err, 'Could not download the continuity package.'));
    } finally {
      setBusy(null);
    }
  };

  if (!clientId) return null;

  const payload = closePeriod?.payload && typeof closePeriod.payload === 'object'
    ? closePeriod.payload
    : {};
  const lockedAt = fmtDateTime(closePeriod?.locked_at);

  return (
    <div style={{ padding: '16px 20px 24px', fontFamily: D.ui, fontSize: 13, color: D.inkSoft }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: D.ink }}>{label || 'Closed period'}</span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            fontFamily: D.mono,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: D.ink,
            background: D.ruleSoft,
            padding: '2px 8px',
            borderRadius: 999
          }}
        >
          Locked
        </span>
      </div>
      <div style={{ ...metaStyle, padding: '4px 0 0' }}>
        {dayRangeLabel(periodStart, periodEnd)}
        {lockedAt ? ` · locked ${lockedAt}` : ''}
        {closePeriod?.closed_by ? ` · by ${closePeriod.closed_by}` : ''}
      </div>

      <div style={sectionTitleStyle}>Period summary</div>
      <Kv label="Posted journals" value={payload.posted_journal_count ?? null} />
      <Kv label="Ledger lines" value={payload.ledger_line_count ?? null} />
      <Kv
        label="Trial balance"
        value={payload.trial_balance
          ? (payload.trial_balance.balanced ? 'Balanced' : `Imbalance ${payload.trial_balance.imbalance}`)
          : null}
      />
      <Kv label="Net income" value={payload.profit_and_loss?.net_income ?? null} />
      <Kv label="Cash on hand" value={payload.cash?.total ?? null} />

      {vouchers.length ? (
        <>
          <div style={sectionTitleStyle}>Vouchers ({vouchers.length})</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {vouchers.slice(0, 12).map((voucher, index) => (
              <div key={voucher.id || index} style={{ ...kvRowStyle, gap: 8 }}>
                <span style={{ color: D.inkSoft }}>
                  {voucher.tosite || (voucher.id ? `Journal ${String(voucher.id).slice(0, 8)}` : 'Journal')}
                </span>
                <span style={metaStyle}>
                  {voucher.date || ''}
                  {voucher.memo ? ` · ${voucher.memo}` : ''}
                </span>
              </div>
            ))}
            {vouchers.length > 12 ? (
              <div style={metaStyle}>
                +{vouchers.length - 12} more · the continuity package carries the full list
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <div style={sectionTitleStyle}>Continuity package</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            fontFamily: D.mono,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: isGenerated ? D.ink : D.inkMute,
            background: isGenerated ? D.ruleSoft : 'transparent',
            border: isGenerated ? 'none' : `1px solid ${D.ruleSoft}`,
            padding: '2px 8px',
            borderRadius: 999
          }}
        >
          {isGenerated ? 'Generated' : 'Ready to generate'}
        </span>
        {previewStatus === 'loading' ? <span style={metaStyle}>Loading preview…</span> : null}
      </div>
      {custody ? (
        <div style={{ ...metaStyle, padding: '0 0 6px', lineHeight: 1.5 }}>{custody}</div>
      ) : null}
      <Kv label="Archive id" value={archive?.id || archive?.archive_id || null} mono />
      <Kv label="Generated at" value={fmtDateTime(archive?.generated_at)} />
      <Kv label="Generated by" value={archive?.generated_by || null} />
      <Kv label="Manifest sha-256" value={archive?.manifest_checksum || archive?.manifest_checksum_sha256 || null} mono />
      <Kv label="Delivery" value={exportHandoff ? `Delivered · manual download ${fmtDateTime(exportHandoff.exported_at) || ''}` : (archive?.storage_status || null)} />
      <Kv label="Files in package" value={files.length || null} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 10 }}>
        <button
          type="button"
          style={busy ? btnDisabled : (isGenerated ? btnChip : btnPrimary)}
          disabled={!!busy}
          onClick={onGenerate}
        >
          {busy === 'generate' ? 'Generating…' : isGenerated ? 'Re-generate package' : 'Generate package'}
        </button>
        <button
          type="button"
          style={busy ? btnDisabled : (isGenerated ? btnPrimary : btnChip)}
          disabled={!!busy}
          onClick={onDownload}
        >
          {busy === 'download' ? 'Preparing…' : isGenerated ? 'Download package' : 'Download preview'}
        </button>
      </div>

      {notice ? <div style={{ ...metaStyle, padding: '10px 0 0', color: D.inkSoft }}>{notice}</div> : null}
      {error ? <div style={{ ...metaStyle, padding: '10px 0 0', color: D.alert }}>{error}</div> : null}
    </div>
  );
};

export default CloseReceiptArtifact;
