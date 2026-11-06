import { useEffect, useRef, useState } from 'react';
import { manageCapture } from '../../lib/captureTaskApi.js';

export default function CaptureTaskAssignment({ firmId, clientId, sessionId }) {
  const [catalog, setCatalog] = useState(null), [worker, setWorker] = useState(''), [name, setName] = useState('Inventory count');
  const [link, setLink] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const attempt = useRef(null), epoch = useRef(0);
  const scope = { firmId, clientId, sessionId };
  useEffect(() => {
    const controller = new AbortController(), generation = ++epoch.current;
    setCatalog(null); setLink(''); setError(''); setBusy(false); setLoading(true); attempt.current = null;
    manageCapture({ ...scope, signal: controller.signal }).then(result => { if (epoch.current === generation) setCatalog(result); })
      .catch(failure => { if (failure.name !== 'AbortError' && failure.code !== 'CAPTURE_DISABLED' && epoch.current === generation) setError(failure.message); })
      .finally(() => { if (epoch.current === generation) setLoading(false); });
    return () => { ++epoch.current; controller.abort(); };
  }, [firmId, clientId, sessionId, reload]);
  const run = async work => {
    const generation = epoch.current; setBusy(true); setError('');
    try { const result = await work(); if (generation === epoch.current) { setCatalog(result.catalog); setLink(result.link || ''); } }
    catch (failure) { if (epoch.current === generation) setError(failure.message); }
    finally { if (epoch.current === generation) setBusy(false); }
  };
  if (!catalog) return loading ? <p role="status">Loading capture assignments…</p> : error ? <aside aria-label="Assign capture task">
    <p role="alert">{error}</p><button onClick={() => setReload(value => value + 1)}>Retry loading assignments</button></aside> : null;
  const current = catalog.tasks.find(task => !task.revoked_at);
  const issue = async taskId => {
    const result = await manageCapture({ ...scope, taskId, action: 'invitation', data: { idempotency_key: crypto.randomUUID() } });
    return { catalog: await manageCapture(scope), link: result.invitation ? `${window.location.origin}/capture#invitation=${result.invitation}` : '' };
  };
  return <aside className="physical-line" aria-label="Assign capture task"><h4>Assign capture task</h4>
    <p>Use an existing eligible account. This invitation permits photos and counts for this check only.</p>
    {error && <p role="alert">{error}</p>}
    {current ? <><p>{current.name} · {catalog.workers.find(w => w.principalId === current.principal_id)?.name || 'Assigned worker'}</p>
      <button disabled={busy} onClick={() => run(() => issue(current.id))}>Create fresh invitation</button>
      <button disabled={busy} onClick={() => run(async () => { await manageCapture({ ...scope, taskId: current.id, action: 'revoke', data: { idempotency_key: crypto.randomUUID() } }); return { catalog: await manageCapture(scope) }; })}>Revoke task access</button>
    </> : <form onSubmit={event => { event.preventDefault(); run(async () => {
      const recipient = catalog.workers.find(w => `${w.principalType}:${w.principalId}` === worker);
      if (!recipient) throw new Error('Choose a worker.');
      const digest = JSON.stringify([worker, name]);
      if (attempt.current?.digest !== digest) attempt.current = { digest, key: crypto.randomUUID() };
      const task = await manageCapture({ ...scope, data: { session_id: sessionId, name, principal_type: recipient.principalType, principal_id: recipient.principalId, idempotency_key: attempt.current.key } });
      return issue(task.taskId);
    }); }}>
      <label>Task name<input required maxLength="120" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Worker<select required value={worker} onChange={e => setWorker(e.target.value)}><option value="">Choose a worker</option>{catalog.workers.map(w => <option key={`${w.principalType}:${w.principalId}`} value={`${w.principalType}:${w.principalId}`}>{w.name}</option>)}</select></label>
      <button disabled={busy || !worker}>Assign and create invitation</button>
    </form>}
    {link && <><label>Private invitation (expires in 15 minutes)<input readOnly value={link} /></label><button onClick={() => navigator.clipboard.writeText(link).catch(() => setError('Copy the invitation from the field.'))}>Copy invitation</button></>}
  </aside>;
}
