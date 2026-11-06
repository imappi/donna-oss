import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  acceptClientEvidenceRequest,
  fetchClosePeriodPreview,
  formatFirmError,
  lockClosePeriod,
  postLedgerPeriod,
  rejectClientEvidenceRequest,
  runCloseChecks
} from '../../lib/firmApi.js';
import { D } from '../shared/design-tokens.js';
import { btnChip, btnDisabled, btnPrimary } from '../shared/buttons.js';
import { dayRangeLabel, snapshotDayString } from '../shared/snapshot-dates.js';

// C2b work artifact (as amended by Kari's 2026-08-26 canary feedback): the
// right rail IS the work area. A Period close row on Actions opens this
// artifact; everything the old inline card carried lives here — the
// persisted close-preview read-model, the close verbs (run checks / post
// approved / lock; lock resolves the row out of Actions), the lock-409
// blocking verdict, and the replied-evidence review moment.
//
// Render-the-persisted-verdict: the header renders the derived snapshot
// entry captured at open; the body reads fetchClosePeriodPreview (the same
// persisted read-model C1 renders); mutations are the existing close and
// evidence writers only — no new endpoint, no second close backend.

const STATUS_META = {
  ready: { label: 'Ready to lock', color: D.ink },
  review: { label: 'Review needed', color: D.accentWarmFlat },
  blocked: { label: 'Blocked', color: D.alert },
  unchecked: { label: 'Not checked yet', color: D.inkMute },
  locked: { label: 'Locked', color: D.ink }
};

const CHECK_LABEL = {
  ledger_balance: 'Ledger balance',
  posting_completeness: 'Posting completeness',
  client_evidence: 'Evidence answers',
  source_import: 'Source import',
  xero_mirror: 'Xero mirror'
};

const CHECK_STATUS_COLOR = {
  passed: D.ink,
  warning: D.accentWarmFlat,
  blocked: D.alert
};

// The read-model returns the live summary ALONGSIDE any persisted check row
// for the same check_type (the old tab deduped these too — rendering both is
// the doubled-list bug from the first canary pass). Prefer the persisted
// entry (it has an id).
const dedupeChecks = (checks = []) => {
  const byType = new Map();
  for (const check of checks) {
    if (!check?.check_type) continue;
    const existing = byType.get(check.check_type);
    if (!existing || (!existing.id && check.id)) {
      byType.set(check.check_type, check);
    }
  }
  return Array.from(byType.values());
};

const shortDate = (value) => {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const metaStyle = {
  fontFamily: D.ui,
  fontSize: 12,
  color: D.inkMute,
  ...D.tabular
};

const StatusDot = ({ color }) => (
  <span
    aria-hidden="true"
    style={{
      width: 7,
      height: 7,
      borderRadius: 999,
      background: color,
      display: 'inline-block',
      flex: 'none'
    }}
  />
);

const evidenceDateOf = (request) =>
  request?.request_payload?.date
  || request?.responded_at
  || request?.updated_at
  || request?.created_at
  || null;

const ClosePeriodArtifact = ({ artifact, onRefreshRef }) => {
  const data = artifact?.data || {};
  const { clientId, label } = data;
  // TZ-safe calendar days (snapshot-dates.js): a stale snapshot can still
  // hand this artifact a shifted serialized date column — normalizing HERE
  // means every read AND every close writer below gets the true period, so
  // a shifted day can never mint a second close_periods row server-side.
  const periodStart = snapshotDayString(data.periodStart) || data.periodStart;
  const periodEnd = snapshotDayString(data.periodEnd) || data.periodEnd;

  const [preview, setPreview] = useState(null);
  const [previewStatus, setPreviewStatus] = useState('idle');
  const [previewError, setPreviewError] = useState(null);
  const [busy, setBusy] = useState(null); // 'checks' | 'post' | 'lock' | <evidence id>
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [blockedChecks, setBlockedChecks] = useState(null);
  const [lockedNow, setLockedNow] = useState(false);
  // Evidence rows are captured into the artifact at open; a handled row is
  // hidden locally (the next open re-captures fresh snapshot state).
  const [handledEvidenceIds, setHandledEvidenceIds] = useState(() => new Set());
  const [reaskFor, setReaskFor] = useState(null);
  const [reaskNote, setReaskNote] = useState('');
  const abortRef = useRef(null);

  const loadPreview = useCallback(async () => {
    if (!clientId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPreviewStatus('loading');
    setPreviewError(null);
    try {
      const next = await fetchClosePeriodPreview({
        clientId,
        periodStart,
        periodEnd,
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      setPreview(next || null);
      setPreviewStatus('ready');
    } catch (err) {
      if (controller.signal.aborted) return;
      setPreviewError(formatFirmError(err, 'Could not load the close state.'));
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

  const applySnapshot = (payload) => {
    if (payload?.source === 'database' && typeof data.onDatabaseSnapshot === 'function') {
      data.onDatabaseSnapshot(payload);
    }
  };

  const act = async (key, fn, noticeFor) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    setBlockedChecks(null);
    try {
      const payload = await fn();
      applySnapshot(payload);
      if (noticeFor) setNotice(noticeFor(payload));
      await loadPreview();
    } catch (err) {
      // The lock writer re-runs checks and answers "not lockable" with the
      // blocking checks under details — render that verdict, not a generic
      // failure line.
      if (err?.code === 'CLOSE_PERIOD_NOT_LOCKABLE' || (err?.status === 409 && err?.details?.checks)) {
        const blocking = err?.details?.checks || [];
        setBlockedChecks(Array.isArray(blocking) ? dedupeChecks(blocking) : []);
        await loadPreview();
      } else {
        setError(formatFirmError(err, 'Action failed.'));
      }
    } finally {
      setBusy(null);
    }
  };

  const onRunChecks = () => act(
    'checks',
    () => runCloseChecks({ clientId, periodStart, periodEnd }),
    () => 'Close checks run.'
  );

  const onPost = () => act(
    'post',
    () => postLedgerPeriod({ clientId, periodStart, periodEnd, dryRun: false }),
    (payload) => {
      const s = payload?.ledger_period_posting || {};
      const requested = s.requested_count ?? s.requested ?? 0;
      const posted = s.posted_count ?? s.posted ?? 0;
      const skipped = s.skipped_count ?? s.skipped ?? 0;
      const errors = s.error_count ?? s.errors ?? 0;
      return `Posted ${posted} of ${requested} · ${skipped} skipped · ${errors} errors`;
    }
  );

  const onLock = () => act(
    'lock',
    () => lockClosePeriod({ clientId, periodStart, periodEnd }),
    () => {
      setLockedNow(true);
      return 'Locked. The month now carries its Locked badge in Material — the badge opens the close receipt.';
    }
  );

  const onAcceptEvidence = (request) => act(
    request.id,
    () => acceptClientEvidenceRequest({
      evidenceRequestId: request.id,
      reviewState: 'accepted',
      resolutionNote: 'Evidence accepted for close.'
    }),
    () => {
      setHandledEvidenceIds((prev) => new Set(prev).add(request.id));
      return 'Answer accepted — the line is ready for posting.';
    }
  );

  const onReaskEvidence = (request) => act(
    request.id,
    () => rejectClientEvidenceRequest({
      evidenceRequestId: request.id,
      rejectionReason: String(reaskNote || '').trim(),
      followUpQuestion: request.question || request.request_payload?.evidence_request?.question || ''
    }),
    () => {
      setHandledEvidenceIds((prev) => new Set(prev).add(request.id));
      setReaskFor(null);
      setReaskNote('');
      return 'Asked again — the question went back out.';
    }
  );

  const replied = useMemo(() => {
    const requests = Array.isArray(data.evidenceRequests) ? data.evidenceRequests : [];
    return requests
      .filter((request) => {
        if (request?.status !== 'replied') return false;
        if (handledEvidenceIds.has(request?.id)) return false;
        const date = evidenceDateOf(request);
        if (!date) return true;
        const day = String(date).slice(0, 10);
        return day >= String(periodStart || '') && day <= String(periodEnd || '');
      })
      .sort((a, b) => {
        const at = Date.parse(a?.responded_at || a?.updated_at || '') || 0;
        const bt = Date.parse(b?.responded_at || b?.updated_at || '') || 0;
        return bt - at;
      });
  }, [data.evidenceRequests, handledEvidenceIds, periodStart, periodEnd]);

  if (!clientId) return null;

  const closePreview = preview?.close_preview || null;
  const status = lockedNow
    ? 'locked'
    : (closePreview?.status || data.status || 'review');
  const meta = STATUS_META[status] || STATUS_META.review;
  const checks = dedupeChecks(Array.isArray(closePreview?.checks) ? closePreview.checks : []);
  const reviewCounts = preview?.review_counts || null;
  const lockable = !lockedNow && closePreview?.lockable === true;
  const unposted = Number(reviewCounts?.unposted ?? data.counts?.unposted ?? 0);
  const checkedAt = shortDate(preview?.generated_at || data.checkedAt);

  return (
    <div style={{ padding: '16px 20px 24px', fontFamily: D.ui, fontSize: 13, color: D.inkSoft }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusDot color={meta.color} />
        <span style={{ fontSize: 16, fontWeight: 700, color: D.ink }}>{label || 'Period close'}</span>
        <span style={{ fontSize: 12, color: D.inkMute }}>{meta.label}</span>
      </div>
      <div style={{ ...metaStyle, padding: '4px 0 0' }}>
        {dayRangeLabel(periodStart, periodEnd)}
        {checkedAt ? ` · checked ${checkedAt}` : ''}
      </div>

      <div style={{ marginTop: 12, borderTop: `1px solid ${D.ruleSoft}`, paddingTop: 12 }}>
        {previewStatus === 'loading' || previewStatus === 'idle' ? (
          <div style={metaStyle}>Loading close state…</div>
        ) : previewStatus === 'error' ? (
          <div style={{ ...metaStyle, color: D.alert }}>{previewError}</div>
        ) : (
          <>
            {checks.length ? (
              <div style={{ display: 'grid', gap: 6 }}>
                {checks.map((check, index) => (
                  <div
                    key={check?.check_type || index}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}
                  >
                    <StatusDot color={CHECK_STATUS_COLOR[check?.status] || D.inkMute} />
                    <span style={{ color: D.ink }}>
                      {CHECK_LABEL[check?.check_type] || check?.check_type}
                    </span>
                    <span style={{ color: D.inkMute }}>{check?.summary || check?.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={metaStyle}>No checks have run for this period yet.</div>
            )}
            {reviewCounts ? (
              <div style={{ ...metaStyle, padding: '8px 0 0' }}>
                {`posted ${Number(reviewCounts.posted || 0)} · unposted ${Number(reviewCounts.unposted || 0)} · waiting ${Number(reviewCounts.waiting || 0) + Number(reviewCounts.asked_client || 0) + Number(reviewCounts.held || 0)}`}
              </div>
            ) : null}
            {!lockedNow ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
                <button
                  type="button"
                  style={busy ? btnDisabled : btnChip}
                  disabled={!!busy}
                  onClick={onRunChecks}
                >
                  {busy === 'checks' ? 'Running…' : 'Run checks'}
                </button>
                {unposted > 0 ? (
                  <button
                    type="button"
                    style={busy ? btnDisabled : btnChip}
                    disabled={!!busy}
                    onClick={onPost}
                  >
                    {busy === 'post' ? 'Posting…' : 'Post approved rows'}
                  </button>
                ) : null}
                {lockable ? (
                  <button
                    type="button"
                    style={busy ? btnDisabled : btnPrimary}
                    disabled={!!busy}
                    onClick={onLock}
                  >
                    {busy === 'lock' ? 'Locking…' : 'Lock period'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      {blockedChecks ? (
        <div
          style={{
            margin: '12px 0 0',
            padding: '8px 12px',
            borderRadius: 8,
            background: D.alertWash,
            fontSize: 12.5,
            color: D.inkSoft
          }}
        >
          <div style={{ fontWeight: 600, color: D.ink }}>Cannot lock — checks blocking</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {blockedChecks.map((check, index) => (
              <li key={check?.check_type || index}>
                {(CHECK_LABEL[check?.check_type] || check?.check_type || 'check')}
                {check?.summary ? ` — ${check.summary}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {replied.length ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.ink, paddingBottom: 6 }}>
            Answers to review ({replied.length})
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {replied.slice(0, 6).map((request) => {
              const isBusy = busy === request.id;
              const note = request?.response_payload?.note
                || request?.response_payload?.client_note
                || null;
              return (
                <div
                  key={request.id}
                  style={{
                    border: `1px solid ${D.ruleSoft}`,
                    borderRadius: 8,
                    padding: '8px 12px',
                    fontSize: 12.5
                  }}
                >
                  <div style={{ color: D.ink }}>
                    {request.question || 'Evidence request'}
                  </div>
                  <div style={metaStyle}>
                    {`Replied ${shortDate(request.responded_at || request.updated_at) || ''}`}
                    {note ? ` · “${note}”` : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 8, paddingTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {reaskFor === request.id ? (
                      <>
                        <input
                          value={reaskNote}
                          onChange={(event) => setReaskNote(event.target.value)}
                          placeholder="Why it needs another pass"
                          aria-label="Re-ask reason"
                          style={{
                            font: 'inherit',
                            fontSize: 12,
                            padding: '6px 9px',
                            borderRadius: 6,
                            border: `1px solid ${D.rule}`,
                            background: D.card,
                            color: D.inkSoft,
                            flex: '1 1 160px',
                            minWidth: 140
                          }}
                        />
                        <button
                          type="button"
                          style={busy ? btnDisabled : btnPrimary}
                          disabled={!!busy}
                          onClick={() => onReaskEvidence(request)}
                        >
                          {isBusy ? 'Sending…' : 'Send'}
                        </button>
                        <button
                          type="button"
                          style={btnChip}
                          onClick={() => { setReaskFor(null); setReaskNote(''); }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          style={busy ? btnDisabled : btnPrimary}
                          disabled={!!busy}
                          onClick={() => onAcceptEvidence(request)}
                        >
                          {isBusy ? 'Accepting…' : 'Accept'}
                        </button>
                        <button
                          type="button"
                          style={busy ? btnDisabled : btnChip}
                          disabled={!!busy}
                          onClick={() => { setReaskFor(request.id); setReaskNote(''); }}
                        >
                          Ask again
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {replied.length > 6 ? (
              <div style={metaStyle}>
                +{replied.length - 6} more replied · review the visible ones to surface them
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {notice ? <div style={{ ...metaStyle, padding: '10px 0 0', color: D.inkSoft }}>{notice}</div> : null}
      {error ? <div style={{ ...metaStyle, padding: '10px 0 0', color: D.alert }}>{error}</div> : null}
    </div>
  );
};

export default ClosePeriodArtifact;
