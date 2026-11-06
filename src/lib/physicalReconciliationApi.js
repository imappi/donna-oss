import { firmFetch, coerceErrorMessage } from './firmApi.js';
import { uploadEvidenceObject } from './evidenceStorage.js';
const base = '/api/donna/firms/inventory/physical-reconciliation';
const refusals = {
  second_reviewer_required: 'A different authorized reviewer must approve this stock change.',
  stale_expectation: 'Stock movements changed this check. Request a fresh count.',
  stale_observation: 'The observation changed while you were reviewing it. Reload the check before accepting.',
  human_confirmation_required: 'Confirm a reliable count before accepting a stock change. Request a recount if uncertain.',
  found_stock_requires_cause_review: 'Found stock needs a documented cause. Keep it assigned for review.',
  found_stock_shrinkage_source_required: 'Select the original documented shortage before reversing it.',
  missing_valuation_basis: 'The item has no supported cost basis. Resolve the cost evidence before adjusting stock.',
  apply_flag_disabled: 'Inventory corrections are not enabled for this client.',
  accounting_refused: 'Accounting checks refused this correction. Stock has not changed; ask the authorized reviewer to inspect the cause.',
  flag_disabled: 'Inventory checks are paused for this client.',
  session_closed: 'This check is already closed. Reload it to see its saved result.'
};
export const physicalRequest = async ({ firmId, clientId, sessionId, action, data, signal }) => {
  const suffix = sessionId ? `/${encodeURIComponent(sessionId)}${action ? `/${action}` : ''}` : action ? `/${action}` : '';
  const query = new URLSearchParams({ firm_id: firmId, client_id: clientId });
  const response = await firmFetch(`${base}${suffix}?${query}`, { method: data ? 'POST' : 'GET', signal,
    headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify({ ...data, firm_id: firmId, client_id: clientId }) } : {}) });
  const result = await response.json();
  if (!response.ok || result.applied === false) throw Object.assign(new Error(coerceErrorMessage(result.error || result.message,
    refusals[result.reason] || 'The physical check could not be completed. Reload it and try again.')), { code: result.code || result.reason, status: response.status, details: result });
  return result;
};
const fileBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onerror = () => reject(new Error('The photo could not be read.'));
  reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
});
export const uploadPhysicalPhoto = async ({ firmId, clientId, file }) => {
  if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a JPEG, PNG or WebP photo up to 10 MB.');
  const stored = await uploadEvidenceObject({ firmId, clientId, filename: file.name, mimeType: file.type, base64: await fileBase64(file) });
  const result = await physicalRequest({ firmId, clientId, action: 'evidence', data: { document: {
    id: crypto.randomUUID(), client_id: clientId, filename: file.name, mime_type: stored.content_type,
    file_size: stored.size, storage_provider: stored.provider, storage_bucket: stored.bucket,
    storage_object_key: stored.key, checksum_sha256: stored.checksum_sha256
  } } });
  return { documentId: result.document.id, checksum: result.document.checksum_sha256 };
};
