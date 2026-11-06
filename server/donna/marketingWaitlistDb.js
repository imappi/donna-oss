// Marketing waitlist persistence (migration 047). Lead capture from the
// purchase-flow qualification gate's unfit path. Pre-account, firm-agnostic, so
// it lives in its own thin module over queryFirmDb rather than in the firm
// engine.

import { randomUUID } from 'node:crypto';

import { queryFirmDb } from './firmDb.js';

// 'inventory' is legacy vocabulary as of the P0E gate revision (Kari,
// 2026-07-05): the products business type is now a scoping gate, not a hard
// reject, so the qualification gate no longer mints inventory-reason leads.
// The value stays valid for the existing rows (their nurture segment) and any
// out-of-band capture.
const VALID_REASONS = new Set(['inventory', 'restaurant', 'volume', 'jurisdiction', 'switcher', 'other']);

export const addToWaitlist = async ({ email, reason, deps = {} } = {}) => {
  const query = deps.query || queryFirmDb;
  const makeId = deps.randomUUID || randomUUID;
  const clean = String(email || '').trim().toLowerCase();
  // Minimal validation — this is a public, unauthenticated endpoint.
  if (!clean || clean.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    const error = new Error('A valid email is required.');
    error.statusCode = 400;
    error.code = 'INVALID_EMAIL';
    throw error;
  }
  const tag = VALID_REASONS.has(reason) ? reason : 'other';

  await query(
    `insert into marketing_waitlist (id, email, reason, source)
     values ($1, $2, $3, 'qualification_gate')
     on conflict (lower(email)) do update
       set reason = excluded.reason, created_at = now()`,
    [makeId(), clean, tag]
  );
  return { ok: true };
};
