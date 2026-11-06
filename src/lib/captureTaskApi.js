import { firmFetch } from './firmApi.js';
import { getAuthSession } from './accessToken.js';
const base = '/api/donna/physical';
const read = async response => {
  const result = await response.json().catch(() => {
    if (response.ok) throw new Error('The task response could not be read. Retry the request.');
    return {};
  });
  if (!response.ok) throw Object.assign(new Error(result.code?.includes('DISABLED') ? 'Capture access is paused.'
    : result.code?.includes('CREDENTIAL') ? 'This task access expired or was revoked. Ask the person who assigned it for a new invitation.'
    : result.code?.includes('INVITATION') ? 'This invitation expired or was already used. Request a new invitation.'
    : result.code === 'CAPTURE_ALREADY_RECEIVED' ? 'This count was already received. Refresh task access to see its progress.'
    : 'The task request could not be completed. Check your access and retry.'), { code: result.code, status: response.status });
  return result;
};
export const manageCapture = async ({ firmId, clientId, sessionId, taskId, action, data, signal }) => {
  const query = new URLSearchParams({ firm_id: firmId, client_id: clientId, ...(sessionId ? { session_id: sessionId } : {}) });
  return read(await firmFetch(`${base}/tasks${taskId ? `/${taskId}/${action}` : ''}?${query}`, {
    method: data ? 'POST' : 'GET', signal, headers: { 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify({ ...data, firm_id: firmId, client_id: clientId }) } : {}) }));
};
export const exchangeCapture = async (invitation, { signal } = {}) => {
  const token = getAuthSession()?.access_token;
  if (!token) throw new Error('Sign in with the account this task was assigned to.');
  return read(await firmFetch(`${base}/capture/exchange`, { method: 'POST', signal, credentials: 'same-origin', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ invitation }) }));
};
export const captureRequest = async ({ taskId, action, data, csrf, signal }) => {
  const result = await read(await fetch(`${base}/capture/tasks/${taskId}${action ? `/${action}` : ''}`, { credentials: 'same-origin', referrerPolicy: 'no-referrer', signal,
    method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Donna-Capture-CSRF': csrf } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) }));
  if (!action && (!result || !Array.isArray(result.items))) throw new Error('The task response could not be read. Retry the request.');
  return result;
};
export const capturePhotoError = file => !file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
  || file.size > 2 * 1024 * 1024 || !file.size ? 'Choose a JPEG, PNG or WebP photo up to 2 MB.' : '';
export const captureFileBase64 = file => new Promise((resolve, reject) => {
  const error = capturePhotoError(file);
  if (error) { reject(new Error(error)); return; }
  const reader = new FileReader(); reader.onerror = () => reject(new Error('The photo could not be read.'));
  reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
});
