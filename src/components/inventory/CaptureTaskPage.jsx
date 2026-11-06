import { useCallback, useEffect, useRef, useState } from 'react';
import { signInWithPassword } from '../../lib/supabaseAuth.js';
import { getAuthSession } from '../../lib/accessToken.js';
import { captureFileBase64, capturePhotoError, captureRequest, exchangeCapture } from '../../lib/captureTaskApi.js';
import './physical-reconciliation.css';

// Strip the fragment before any rendering/analytics. It stays in this page's
// memory only, never local storage, URLs sent to a server, or a return link.
let invitation = typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.slice(1)).get('invitation') : null;
if (typeof window !== 'undefined' && window.location.pathname === '/capture' && window.location.hash) {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

function CaptureItem({ item, taskId, csrf, refresh, accessReady }) {
  const [quantity, setQuantity] = useState(''), [uncertain, setUncertain] = useState(false), [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(null);
  const submit = async event => {
    event.preventDefault();
    if (busy || !accessReady) return;
    setBusy(true); setError('');
    try {
      if (capturePhotoError(file)) throw new Error(capturePhotoError(file));
      if (pending.current?.file !== file || pending.current?.quantity !== quantity || pending.current?.uncertain !== uncertain) {
        pending.current = { file, quantity, uncertain, uploadKey: crypto.randomUUID(), responseKey: crypto.randomUUID(), observedAt: new Date().toISOString(), evidence: null };
      }
      const attempt = pending.current;
      if (!attempt.evidence) {
        const upload = await captureRequest({ taskId, action: 'uploads', csrf, data: { line_id: item.lineId,
          filename: file.name, mime_type: file.type, base64: await captureFileBase64(file), idempotency_key: attempt.uploadKey } });
        attempt.evidence = upload.evidence;
      }
      await captureRequest({ taskId, action: 'responses', csrf, data: { line_id: item.lineId,
        observed_quantity: quantity === '' ? null : Number(quantity), uncertain, human_confirmed: true,
        observed_at: attempt.observedAt, evidence_refs: [attempt.evidence], idempotency_key: attempt.responseKey } });
      await refresh();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <article className="physical-line"><h2>{item.name}</h2><p>{item.sku} · {item.location} · {item.unit}</p>
    {item.received ? <p role="status">Count received. Any review stays with the assigned reviewers.</p> : <form onSubmit={submit}>
      <p>Count all units at the named location. If you cannot safely count them, mark the count uncertain.</p>
      <label>Counted quantity<input type="number" min="0" step="any" required={!uncertain} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
      <label className="physical-check"><input type="checkbox" checked={uncertain} onChange={e => setUncertain(e.target.checked)} />Count uncertain or some stock hidden</label>
      <label>Item and label photo<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required onChange={e => {
        const selected = e.target.files?.[0] || null; setFile(selected); setError(selected ? capturePhotoError(selected) : '');
      }} /></label>
      <button disabled={busy || !accessReady || Boolean(capturePhotoError(file)) || (quantity === '' && !uncertain)}>{busy ? 'Sending…' : 'Confirm count and send'}</button>
      {error && <p role="alert">{error}</p>}
    </form>}
  </article>;
}
export default function CaptureTaskPage() {
  const [invitationSecret, setInvitationSecret] = useState(invitation);
  const invitationEpoch = useRef(0);
  const opening = useRef(null), activeTask = useRef(null);
  const [taskId, setTaskId] = useState(() => new URLSearchParams(window.location.search).get('task'));
  const [task, setTask] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false), [accessReady, setAccessReady] = useState(false);
  const load = useRef(null);
  const [signedIn, setSignedIn] = useState(Boolean(getAuthSession()?.access_token));
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [notice, setNotice] = useState(false);
  const invitationGeneration = invitationEpoch.current;
  const refresh = useCallback(async () => {
    if (!taskId || activeTask.current !== taskId || invitationGeneration !== invitationEpoch.current) throw Object.assign(new Error('Task access changed.'), { name: 'AbortError' });
    load.current?.abort();
    const controller = new AbortController(); load.current = controller;
    setLoading(true); setAccessReady(false); setError('');
    try {
      const result = await captureRequest({ taskId, signal: controller.signal });
      if (load.current === controller && !controller.signal.aborted) { setTask(result); setAccessReady(true); }
    } catch (failure) {
      if (load.current === controller && !controller.signal.aborted) {
        // Keep the same forms and in-memory request identities across transient
        // reads. An authority refusal removes scope immediately.
        if ([401, 403, 404].includes(failure.status)) setTask(null);
        setError(failure.message);
      }
      throw failure;
    } finally {
      if (load.current === controller && !controller.signal.aborted) setLoading(false);
    }
  }, [taskId, invitationGeneration]);
  useEffect(() => {
    if (!taskId) return;
    activeTask.current = taskId;
    setTask(null);
    refresh().catch(() => {});
    return () => { activeTask.current = null; load.current?.abort(); };
  }, [taskId, refresh]);
  useEffect(() => {
    const replacement = () => {
      const next = new URLSearchParams(window.location.hash.slice(1)).get('invitation');
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (!next) return;
      // A replacement link can navigate within this document. Consume its
      // fragment before sign-in/network work, and disarm the prior task view.
      invitation = null;
      ++invitationEpoch.current;
      opening.current?.abort(); activeTask.current = null;
      load.current?.abort();
      window.history.replaceState(null, '', '/capture');
      setInvitationSecret(next); setTaskId(null); setTask(null); setError('');
      setLoading(false); setAccessReady(false); setNotice(false); setBusy(false);
    };
    window.addEventListener('hashchange', replacement);
    return () => { ++invitationEpoch.current; opening.current?.abort(); window.removeEventListener('hashchange', replacement); };
  }, []);
  const start = async event => {
    const generation = invitationEpoch.current;
    const controller = new AbortController(); opening.current?.abort(); opening.current = controller;
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!signedIn) {
        await signInWithPassword({ email, password });
        if (generation !== invitationEpoch.current) return;
        setPassword(''); setSignedIn(true);
      }
      if (!notice) throw new Error('Confirm the photo notice before opening the task.');
      const result = await exchangeCapture(invitationSecret, { signal: controller.signal });
      if (generation !== invitationEpoch.current) return;
      invitation = null;
      setInvitationSecret(null);
      window.history.replaceState(null, '', `/capture?task=${result.taskId}`);
      setTaskId(result.taskId);
    } catch (failure) {
      if (generation === invitationEpoch.current) { setSignedIn(Boolean(getAuthSession()?.access_token)); setError(failure.message); }
    } finally { if (generation === invitationEpoch.current) setBusy(false); }
  };
  return <main className="physical-panel capture-task" style={{ maxWidth: 640, margin: '24px auto', padding: 20 }}>
    <h1>Donna Capture</h1>
    <p>Photos and factual counts for one assigned inventory check. Avoid faces and personal information. Uploaded photos are evidence, with no claim of live capture.</p>
    {error && <p role="alert">{error}</p>}
    {taskId && <><p role="status">{loading ? 'Checking task access…' : !accessReady ? 'Task access could not be checked. Reconnect and retry, or request a new invitation if access has ended.' : ''}</p>
      <button disabled={loading} onClick={() => refresh().catch(() => {})}>{loading ? 'Checking…' : task ? 'Refresh task access' : 'Retry loading task'}</button></>}
    {task ? <><h2>{task.name || 'Task complete'}</h2><p role="status">{task.completed ? 'This task is complete. Capture access has ended.' : `${task.items.filter(item => item.received).length} of ${task.items.length} counts received.`}</p>
      <p>Your authorized entity reviewers receive the photos. Evidence remains under the existing retention policy after this access expires.</p>
      {task.items.map(item => <CaptureItem key={`${taskId}:${item.lineId}`} item={item} taskId={taskId} csrf={task.csrf} refresh={refresh} accessReady={accessReady} />)}
      <p>You can now return to the conversation where this task was assigned.</p>
    </> : invitationSecret ? <form onSubmit={start}>
      {signedIn && <><p>Signed in as {getAuthSession()?.user?.email || 'your current account'}.</p><button type="button" disabled={busy} onClick={() => setSignedIn(false)}>Use a different account</button></>}
      {!signedIn && <><label>Email<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label></>}
      <label className="physical-check"><input type="checkbox" required checked={notice} onChange={e => setNotice(e.target.checked)} />I understand the photos go to this entity’s authorized reviewers.</label>
      <button disabled={busy || !notice}>{busy ? 'Opening…' : 'Open my assigned task'}</button>
    </form> : !taskId && <p>Open a current invitation from the person who assigned your task.</p>}
  </main>;
}
