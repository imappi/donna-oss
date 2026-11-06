// Storage cleanup receipts — the audit rows the `storage_orphans` cron task
// writes around a destructive object delete (DMEM-R1 W1, 2026-09-04; doctrine
// INV-15; audit F-12 cleanup leg, S11/L1 + L3).
//
// Two receipts, both written BEFORE or INSTEAD of a delete — never after the
// fact as a best-effort log line:
//   - `storage.cleanup_authorized` — the object's firm (and client, when it is
//     one on this book) is resolved and the delete is authorized in the trail;
//     if THIS insert fails the object is kept (fail closed). The post-delete
//     `storage.orphan_cleaned` row (parseDocumentsDb.js) then names the object
//     that is actually gone.
//   - `storage.cleanup_refused_foreign_prefix` — the key's prefix is not a firm
//     on this book, so the object is KEPT; the refusal is receipted on the book's
//     sole firm when there is exactly one (audit_events.firm_id is a NOT NULL
//     FK), and always in the run summary.
//
// Deliberately NOT a chat-apply audit (those go through the spine): this is the
// cron task's own receipt, kept out of api.js so the "zero raw audit inserts in
// api.js" ratchet (chatApplySpine.test.js) keeps meaning what it says.

import { queryFirmDb } from './firmDb.js';

export const STORAGE_CLEANUP_AUTHORIZED_ACTION = 'storage.cleanup_authorized';
export const STORAGE_CLEANUP_REFUSED_ACTION = 'storage.cleanup_refused_foreign_prefix';

export const logStorageCleanupAuthorizedInDb = async ({ firmId, clientId = null, bucket, key, size = 0, ageMs = 0, authorizedAs = 'unknown' } = {}) => {
  if (!firmId || !bucket || !key) throw new Error('storage cleanup authorization needs a firm, a bucket and a key');
  await queryFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'storage_object', $4, $5::jsonb)`,
    [firmId, clientId, STORAGE_CLEANUP_AUTHORIZED_ACTION, key, JSON.stringify({ bucket, key, size: Number(size || 0), age_ms: Number(ageMs || 0), authorized_as: authorizedAs })]
  );
};

export const logStorageCleanupRefusedInDb = async ({ firmId, bucket, key, size = 0, ageMs = 0, firmPrefix = null } = {}) => {
  if (!firmId || !bucket || !key) throw new Error('storage cleanup refusal needs a firm, a bucket and a key');
  await queryFirmDb(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, null, 'system', $2, 'storage_object', $3, $4::jsonb)`,
    [firmId, STORAGE_CLEANUP_REFUSED_ACTION, key, JSON.stringify({ bucket, key, size: Number(size || 0), age_ms: Number(ageMs || 0), firm_prefix: firmPrefix, kept: true })]
  );
};
