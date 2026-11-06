import { useEffect, useRef, useState } from 'react';
import { physicalRequest, uploadPhysicalPhoto } from '../../lib/physicalReconciliationApi.js';
import { fetchFirmDocumentDownload } from '../../lib/firmApi.js';
import './physical-reconciliation.css';
import CaptureTaskAssignment from './CaptureTaskAssignment.jsx';

const terminal = new Set(['matched', 'dismissed', 'applied']);
const needsAttention = line => !terminal.has(line.physical_status) || Boolean(line.payload?.owner)
  || (line.physical_status === 'applied' && !['posted', 'replayed', 'no_journal_required'].includes(line.physical_resolution?.accounting?.status));
const label = value => String(value || 'Not recorded').replaceAll('_', ' ');
const fmt = value => value == null ? 'Unknown' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });

function CountLine({ line, item, scope, run, refresh, busy }) {
  const [quantity, setQuantity] = useState('');
  const [file, setFile] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [reason, setReason] = useState('');
  const [failureClass, setFailureClass] = useState('quantity_difference');
  const [alternateAction, setAlternateAction] = useState('manual_recount');
  const [countCause, setCountCause] = useState(''), [priorShrinkage, setPriorShrinkage] = useState('');
  const start = useRef(Date.now());
  // Retain a request key on an ambiguous transport failure; deliberate edits mint a new attempt.
  const pending = useRef(null), uploadAttempt = useRef(null);
  const requestKey = payload => {
    const digest = JSON.stringify(payload);
    if (pending.current?.digest !== digest) pending.current = { digest, key: crypto.randomUUID(), reviewSeconds: Math.round((Date.now() - start.current) / 1000) };
    return pending.current.key;
  };
  const observation = line.physical_observation;
  const resolution = line.physical_resolution;
  const ask = line.payload?.owner?.ask;
  const isDone = terminal.has(line.physical_status);
  const needsCount = !observation || ['recount_required','awaiting_observation'].includes(line.physical_status);
  const submit = async e => {
    e.preventDefault();
    await run(async () => {
      if (uploadAttempt.current?.file !== file || uploadAttempt.current?.quantity !== quantity || uploadAttempt.current?.uncertain !== uncertain) {
        uploadAttempt.current = { file, quantity, uncertain, observedAt: new Date().toISOString(), evidence: null };
      }
      const attempt = uploadAttempt.current;
      attempt.evidence ||= await uploadPhysicalPhoto({ ...scope, file });
      const evidence = attempt.evidence;
      const data = { line_id: line.id, observed_quantity: quantity === '' ? null : Number(quantity), evidence_refs: [evidence],
        observed_at: attempt.observedAt, confidence: null, uncertain, human_confirmed: true,
        notes: { source_kind: 'browser_photo_upload', active_seconds: Math.round((Date.parse(attempt.observedAt) - start.current) / 1000), blind_count: true } };
      const result = await physicalRequest({ ...scope, action: 'observations', data: { ...data, idempotency_key: requestKey(data) } });
      refresh(result); pending.current = null; uploadAttempt.current = null; setFile(null); setQuantity('');
    });
  };
  const resolve = action => run(async () => {
    const data = { line_id: line.id, action, reason, expected_observation_digest: observation?.inputDigest, reverses_count_operation_id: priorShrinkage || null, count_cause: countCause || null,
      failure_class: failureClass, alternate_action: alternateAction };
    const idempotencyKey = requestKey(data);
    const result = await physicalRequest({ ...scope, action: 'resolutions', data: { ...data, review_seconds: pending.current.reviewSeconds, idempotency_key: idempotencyKey } });
    refresh(result); pending.current = null;
  });
  const evidence = observation?.evidenceRefs || observation?.evidence_refs || [];
  const download = ref => run(async () => {
    const result = await fetchFirmDocumentDownload({ documentId: ref.documentId || ref.document_id });
    if (result.signed_url) window.open(result.signed_url, '_blank', 'noopener,noreferrer');
  });
  const observed = observation?.quantity ?? observation?.observedQuantity ?? observation?.observed_quantity ?? line.counted_quantity;
  return <article className="physical-line" aria-label={item?.name || item?.sku || line.item_id}>
    <h4>{item?.name || item?.sku || line.item_id} <small>{item?.sku}</small></h4>
    <p className="physical-status">{label(line.physical_status)}{line.case_id ? ` · Case ${line.case_id}` : ''}</p>
    {ask && <aside><p>{ask.question}</p><p>Assigned to: {ask.recipient?.principalId} · Due: {line.payload?.owner?.dueAt || ask.dueAt || 'See case'}</p>
      {ask.deliveryStatus === 'not_delivered' && <button disabled={busy} onClick={() => run(async () => {
        await physicalRequest({ ...scope, action: 'acknowledgements', data: { line_id: line.id, ask_id: ask.id } });
        refresh(await physicalRequest(scope));
      })}>Acknowledge count request</button>}</aside>}
    {needsCount && !isDone ? <form onSubmit={submit}>
      <p>Count all units of this item at this location. The expected count appears after submission.</p>
      <label>Counted quantity ({item?.base_uom_id || 'base units'})<input aria-label={`Counted quantity for ${item?.sku || line.item_id}`} type="number" min="0" step="any" required={!uncertain} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
      <label>Photo of item and label<input aria-label={`Photo for ${item?.sku || line.item_id}`} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required onChange={e => setFile(e.target.files?.[0] || null)} /></label>
      <label className="physical-check"><input type="checkbox" checked={uncertain} onChange={e => setUncertain(e.target.checked)} />Some stock is hidden or the count is uncertain (leave quantity blank if unknown)</label>
      <button disabled={busy || !file || (quantity === '' && !uncertain)}>Confirm count and compare</button>
      <p className="physical-note">This photo is uploaded evidence, not proof of a live capture. Avoid faces and personal information. Your authorized client reviewers can inspect it.</p>
    </form> : <>
      <dl className="physical-facts"><div><dt>Expected</dt><dd>{fmt(line.expected_quantity)}</dd></div><div><dt>Counted</dt><dd>{fmt(observed)}</dd></div><div><dt>Difference</dt><dd>{line.expected_quantity == null || observed == null ? 'Unknown' : fmt(Number(observed) - Number(line.expected_quantity))}</dd></div></dl>
      <p>Observed {observation?.observedAt || observation?.observed_at || 'time not recorded'} · Human count · No model used</p>
      <div>{evidence.map((ref, index) => <button type="button" key={ref.documentId || ref.document_id || index} disabled={busy} onClick={() => download(ref)}>View photo {index + 1}</button>)}</div>
      <p>Estimated difference value: {line.physical_basis?.valuation?.unitCost == null || observed == null || line.expected_quantity == null ? 'Unknown' : fmt((Number(observed) - Number(line.expected_quantity)) * Number(line.physical_basis.valuation.unitCost))} {line.physical_basis?.valuation?.currency || ''}</p>
      <p>Accounting: {label(resolution?.accounting_status || resolution?.accounting?.status || 'not_applied')}</p>
      {resolution?.accounting?.ledger_journal_id && <p>Journal: {resolution.accounting.ledger_journal_id}</p>}
      {resolution?.operationId && <p>Inventory operation: {resolution.operationId}</p>}
      {!isDone && <div className="physical-review"><p>A different authorized reviewer must approve stock changes. Count submitted by {observation?.actorId || observation?.actor_id || 'the named counter'}.</p>
        <label>Reason and factual basis<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
        <label>What went wrong?<select value={failureClass} onChange={e => setFailureClass(e.target.value)}><option value="quantity_difference">Quantity difference</option><option value="occluded_stock">Hidden stock</option><option value="identity_uncertain">Uncertain item identity</option><option value="stale_evidence">Movements since count</option><option value="other">Other</option></select></label>
        <label>Next evidence route<select value={alternateAction} onChange={e => setAlternateAction(e.target.value)}><option value="manual_recount">Manual recount</option><option value="dated_count_sheet">Dated count sheet</option><option value="label_photo">Clear item label photo</option><option value="none">No further evidence needed</option></select></label>
        <label>Confirmed found-stock cause<select value={countCause} onChange={e => setCountCause(e.target.value)}><option value="">Unexplained / awaiting review</option><option value="reversal_of_shrinkage">Reversal of a documented prior shortage</option></select></label>
        {countCause === 'reversal_of_shrinkage' && <label>Prior shortage operation reference<input value={priorShrinkage} onChange={e => setPriorShrinkage(e.target.value)} required /></label>}
        <div className="physical-actions">
          <button disabled={busy || !reason.trim()} onClick={() => resolve('recount_required')}>Request recount</button>
          <button disabled={busy || !reason.trim()} onClick={() => resolve('uncertain')}>Keep with named owner</button>
          <button disabled={busy || !reason.trim()} onClick={() => resolve('dismissed')}>Dismiss with reason</button>
          <button disabled={busy || !reason.trim() || observed == null || observation?.uncertain} onClick={() => resolve(Number(observed) < Number(line.expected_quantity) ? 'confirmed_shortage' : Number(observed) > Number(line.expected_quantity) ? 'confirmed_found_stock' : 'matched')}>Accept reviewed result</button>
        </div>
      </div>}
    </>}
    <details><summary>Evidence and movement history</summary>
      <p>Owner: {line.payload?.owner?.actorId || 'See linked case'}</p>
      <p>Value basis: {label(line.physical_basis?.valuation?.status || 'unknown')}. Unit cost: {fmt(line.physical_basis?.valuation?.unitCost)} {line.physical_basis?.valuation?.currency}. Carrying value: {fmt(line.physical_basis?.valuation?.carryingValue)}. New movements require a fresh count.</p>
      {(line.movements || []).map(m => <p key={m.id}>{m.effective_at || m.created_at} · {label(m.kind || m.operation_type)} · {fmt(m.quantity_base || m.quantity)}</p>)}
      {(line.payload?.versions || []).filter(v => v.kind === 'observation').map(v => v.observation).map((o, i) => <p key={o.id || i}>Attempt {i + 1}: {fmt(o.quantity ?? o.observedQuantity ?? o.observed_quantity)} · {o.observedAt || o.observed_at} · {label(o.uncertain ? 'uncertain' : 'human_confirmed')}</p>)}
      {!line.movements?.length && <p>No movements returned for this check.</p>}
    </details>
  </article>;
}

function ScopedPhysicalReconciliationPanel({ firmId, clientId }) {
  const [catalog, setCatalog] = useState(null), [check, setCheck] = useState(null), [location, setLocation] = useState('');
  const [selected, setSelected] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [showDone, setShowDone] = useState(false), [copied, setCopied] = useState(false);
  const epoch = useRef(0), openKey = useRef(null);
  useEffect(() => {
    const controller = new AbortController(), generation = ++epoch.current;
    setCatalog(null); setCheck(null); setSelected([]); setError('');
    if (firmId && clientId) physicalRequest({ firmId, clientId, signal: controller.signal }).then(result => {
      if (generation === epoch.current) { setCatalog(result); setLocation(result.locations?.[0]?.id || ''); }
    }).catch(e => { if (e.name !== 'AbortError' && e.code !== 'PHYSICAL_RECONCILIATION_DISABLED' && generation === epoch.current) setError(e.message); });
    return () => { ++epoch.current; controller.abort(); };
  }, [firmId, clientId]);
  const run = async work => { const generation = epoch.current; setBusy(true); setError(''); try { await work(); } catch(e) { if (generation === epoch.current) setError(e.message); } finally { if (generation === epoch.current) setBusy(false); } };
  const refresh = result => { setCheck(result); setCopied(false); };
  if (!catalog && !error) return null;
  const scope = { firmId, clientId }, lines = check?.lines || [], complete = lines.filter(l => terminal.has(l.physical_status)).length;
  const open = () => run(async () => {
    const digest = JSON.stringify([location, selected]);
    if (openKey.current?.digest !== digest) openKey.current = { digest, key: crypto.randomUUID() };
    const result = await physicalRequest({ ...scope, data: { location_id: location, item_ids: selected, idempotency_key: openKey.current.key } });
    refresh(result); openKey.current = null;
  });
  const copySummary = () => run(async () => {
    const rows = lines.map(line => {
      const item = catalog.items?.find(i => i.id === line.item_id), observation = line.physical_observation;
      const detail = observation ? `Counted ${fmt(observation.quantity)}; expected ${fmt(line.expected_quantity)}; difference ${fmt(observation.variance)}. Observed ${observation.observedAt}.`
        : 'Awaiting a physical count.';
      const accounting = line.physical_resolution?.accounting;
      return `${item?.name || item?.sku || line.item_id}: ${detail} ${label(line.physical_status)}.${accounting ? ` Accounting: ${label(accounting.status)}.` : ''}${line.payload?.owner ? ` Assigned to ${line.payload.owner.actorId}.` : ''}`;
    });
    await navigator.clipboard.writeText([`Donna physical check ${check.session.id}`, `${complete} of ${lines.length} selected items physically resolved; ${lines.filter(needsAttention).length} still need attention.`, ...rows,
      'Uploaded photos and human counts only. Unselected stock has not been checked. No service sign-off or professional assurance has been issued.'].join('\n'));
    setCopied(true);
  });
  return <section className="physical-panel" aria-label="Physical inventory check"><h3>Physical inventory check</h3>
    <p>Check selected stock with a photo and your count. Differences stay visible until reviewed.</p>
    {error && <p role="alert">{error}</p>}
    {!catalog && error && <button disabled={busy} onClick={() => run(async () => {
      const result = await physicalRequest({ firmId, clientId });
      setCatalog(result); setLocation(result.locations?.[0]?.id || '');
    })}>Retry loading checks</button>}
    {check?.session?.state === 'open' && <CaptureTaskAssignment firmId={firmId} clientId={clientId} sessionId={check.session.id} />}
    {catalog && !check && <>
      <label>Location<select value={location} onChange={e => setLocation(e.target.value)}>{catalog.locations?.map(l => <option key={l.id} value={l.id}>{l.name || l.id}</option>)}</select></label>
      <fieldset><legend>Choose 5–20 known items</legend>{catalog.items?.map(item => <label className="physical-check" key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && selected.length >= 20} onChange={e => setSelected(e.target.checked ? [...selected,item.id] : selected.filter(id => id !== item.id))} />{item.name} · {item.sku}</label>)}</fieldset>
      <button disabled={busy || selected.length < 5 || !location} onClick={open}>Start physical check</button>
      {catalog.sessions?.length > 0 && <div><h4>Previous checks</h4>{catalog.sessions.map(s => <button key={s.id} disabled={busy} onClick={() => run(async () => refresh(await physicalRequest({ ...scope, sessionId: s.id })))}>{s.created_at ? new Date(s.created_at).toLocaleString() : s.id} · {label(s.state || s.status)}</button>)}</div>}
    </>}
    {check && <><p role="status">{complete} of {lines.length} selected items resolved. Unselected stock has not been checked.</p>
      <button disabled={busy} onClick={copySummary}>Copy check summary</button>{copied && <p role="status">Summary copied for sharing in chat.</p>}
      <label className="physical-check"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />Show resolved items</label>
      {lines.filter(l => showDone || needsAttention(l)).map(line => <CountLine key={`${check.session.id}-${line.id}`} line={line} item={catalog.items?.find(i => i.id === line.item_id)} scope={{ ...scope, sessionId: check.session.id }} busy={busy} run={run} refresh={refresh} />)}
      <button disabled={busy} onClick={() => run(async () => { setCatalog(await physicalRequest(scope)); setCheck(null); })}>Back to checks</button>
    </>}
  </section>;
}

// A changed tenant unmounts all old requests and drafts; stale completions cannot populate another book.
export default function PhysicalReconciliationPanel({ firmId, clientId }) {
  return <ScopedPhysicalReconciliationPanel key={`${firmId}:${clientId}`} firmId={firmId} clientId={clientId} />;
}
