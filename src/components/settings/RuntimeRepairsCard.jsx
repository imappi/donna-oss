import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { fetchRuntimePolicyIncidents, actOnRuntimePolicyIncident } from '../../lib/firmApi.js';
import { D } from '../shared/design-tokens.js';
import { btnChip } from '../shared/buttons.js';
import { BidiText, IdentifierText } from '../../i18n/BidiText.jsx';

export default function RuntimeRepairsCard({ firm }) {
  const intl = useIntl();
  const message = (key) => intl.formatMessage({ id: `mounted.settings.repairs.${key}` });
  const [report, setReport] = useState(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(null);
  const [revision, setRevision] = useState(0);
  const [after, setAfter] = useState(null);
  const [notice, setNotice] = useState(null);
  const [notes, setNotes] = useState({});
  const keys = useRef(new Map());
  const activeFirm = useRef(firm?.id);
  activeFirm.current = firm?.id;

  useEffect(() => {
    setBusy(null);
    setNotes({});
    setAfter(null);
    keys.current.clear();
  }, [firm?.id]);

  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    setError(false);
    setNotice(null);
    fetchRuntimePolicyIncidents({ firmId: firm?.id, signal: controller.signal, after })
      .then((data) => { if (!controller.signal.aborted) setReport(data); })
      .catch((failure) => {
        if (failure?.name !== 'AbortError') setError(true);
      });
    return () => controller.abort();
  }, [firm?.id, revision, after]);

  const act = async (incident, action) => {
    if (busy) return;
    const firmId = firm?.id;
    const key = `${firmId}:${incident.failure_id}`;
    setBusy(incident.failure_id);
    setError(false);
    setNotice(null);
    if (!keys.current.has(key)) keys.current.set(key, crypto.randomUUID());
    try {
      const result = await actOnRuntimePolicyIncident({
        firmId, failureId: incident.failure_id, action,
        idempotencyKey: keys.current.get(key), repairNote: notes[incident.failure_id]
      });
      if (activeFirm.current !== firmId) return;
      // Preserve an uncertain request's key for a network retry. A received
      // attempt result permits an explicitly new repair attempt.
      keys.current.delete(key);
      const fresh = await fetchRuntimePolicyIncidents({ firmId, after });
      if (activeFirm.current !== firmId) return;
      setReport(fresh);
      setNotice(action === 'claim' ? 'claimedNotice' : result.recovered ? 'recoveredNotice' : 'pendingNotice');
    } catch {
      if (activeFirm.current === firmId) setError(true);
    } finally {
      if (activeFirm.current === firmId) setBusy(null);
    }
  };

  return (
    <section aria-label={message('title')} style={{ background: D.paperDeep, borderRadius: 16, padding: 24, marginBlockEnd: 16 }}>
      <h3 style={{ marginBlock: '0 8px', fontSize: 18 }}>{message('title')}</h3>
      <p style={{ color: D.inkSoft, fontSize: 14 }}>{message('description')}</p>
      {notice && <p role="status">{message(notice)}</p>}
      {error && <p role="alert">{message('error')}</p>}
      {!report && !error && <p role="status">{message('loading')}</p>}
      {report?.incidents?.length === 0 && <p>{message('empty')}</p>}
      {(report?.incidents || []).map((incident) => {
        const mine = incident.claimant?.id === report.member_id;
        const canClaim = !incident.claimant || incident.claimant.active === false;
        const processingOnly = incident.reason_code === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE';
        const pending = incident.latest_retry?.lease_active && !incident.latest_retry?.completion_id;
        return (
          <article key={incident.failure_id} style={{ borderBlockStart: `1px solid ${D.rule}`, paddingBlock: 16 }}>
            <div><BidiText>{incident.company_name}</BidiText> · <IdentifierText>{incident.transaction_id || incident.evidence_request_id}</IdentifierText></div>
            <p style={{ fontSize: 14 }}><BidiText>{incident.description}</BidiText></p>
            <p style={{ fontSize: 14 }}>{message(processingOnly ? 'processingPosting' : incident.operation === 'owner_reply' ? 'ownerReply' : incident.operation === 'posting' ? 'posting' : 'coding')}</p>
            {incident.unlock_condition && <p style={{ fontSize: 14 }}><BidiText>{processingOnly ? message('processingUnlock') : incident.unlock_condition}</BidiText></p>}
            <details style={{ fontSize: 13, marginBlockEnd: 12 }}>
              <summary>{message('details')}</summary>
              <p><IdentifierText>{incident.reason_code}</IdentifierText>{incident.reason_detail && <> · <IdentifierText>{incident.reason_detail}</IdentifierText></>}</p>
              {incident.error && <p><BidiText>{incident.error}</BidiText></p>}
              {incident.latest_retry?.error_code && <p>{message('lastAttempt')} <IdentifierText>{incident.latest_retry.error_code}</IdentifierText></p>}
            </details>
            <p style={{ fontSize: 14 }}>
              {message(canClaim ? 'unclaimed' : 'claimed')} {incident.claimant && <BidiText>{incident.claimant.name || incident.claimant.id}</BidiText>}
            </p>
            {mine && !canClaim && incident.can_retry !== false && <label style={{ display: 'block', marginBlockEnd: 12 }}>
              {message('note')}
              <textarea value={notes[incident.failure_id] || ''} maxLength={1000} dir="auto"
                onChange={(event) => setNotes((value) => ({ ...value, [incident.failure_id]: event.target.value }))}
                style={{ display: 'block', width: '100%', boxSizing: 'border-box', font: 'inherit', marginBlockStart: 6 }} />
            </label>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {canClaim && <button type="button" style={btnChip} disabled={!!busy} onClick={() => act(incident, 'claim')}>{message('claim')}</button>}
              {mine && !canClaim && incident.can_retry !== false && <button type="button" style={btnChip} disabled={!!busy || pending || !notes[incident.failure_id]?.trim()} onClick={() => act(incident, 'retry')}>{message(busy === incident.failure_id || pending ? 'retrying' : 'retry')}</button>}
            </div>
          </article>
        );
      })}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" style={btnChip} disabled={!!busy} onClick={() => { setAfter(null); setRevision((value) => value + 1); }}>{message('refresh')}</button>
        {report?.next_cursor && <button type="button" style={btnChip} disabled={!!busy} onClick={() => setAfter(report.next_cursor)}>{message('next')}</button>}
      </div>
    </section>
  );
}
