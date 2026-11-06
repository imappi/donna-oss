// Social-post persistence (migration 099). Thin SQL over the shared pool;
// firm-agnostic (047's line). Write discipline at the writers:
//   - Minting validates copy AND the kind gate (B1 mints diagnostic_content
//     only — the ping lane is B2's, design-first).
//   - Guarded status hops with operator attribution on every decision.
//   - 'published' REQUIRES the pasted post URL — the manual publish's
//     receipt. No URL, no published (two-terminal-states: terminal rests
//     carry receipts).

import { randomUUID } from 'node:crypto';

import { queryFirmDb } from '../firmDb.js';
import {
  MINTABLE_POST_KINDS,
  SOCIAL_POST_STATUSES,
  validateSocialPostCopy
} from './socialPost.js';

export const insertSocialPost = async ({ kind = 'diagnostic_content', body, sourceContext = null, model, maxChars } = {}) => {
  if (!MINTABLE_POST_KINDS.includes(kind)) {
    return { ok: false, violations: [`kind '${kind}' is not mintable in B1 (the ping lane is design-first-gated)`] };
  }
  const violations = validateSocialPostCopy({ body, kind }, maxChars ? { maxChars } : {});
  if (violations.length > 0) return { ok: false, violations };
  if (!String(model || '').trim()) {
    return { ok: false, violations: ['missing model id (the receipt)'] };
  }
  const { rows } = await queryFirmDb(
    `insert into marketing_social_post (id, kind, body, source_context, model)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [randomUUID(), kind, String(body).trim(), sourceContext ? JSON.stringify(sourceContext) : null, String(model)]
  );
  return { ok: true, post: rows[0] };
};

export const listSocialPosts = async ({ statuses = ['proposed', 'approved'], limit = 50 } = {}) => {
  const wanted = statuses.filter((s) => SOCIAL_POST_STATUSES.includes(s));
  if (wanted.length === 0) return [];
  const { rows } = await queryFirmDb(
    `select * from marketing_social_post where status = any($1) order by proposed_at desc limit $2`,
    [wanted, limit]
  );
  return rows;
};

// Guarded proposed→approved / proposed→rejected hops. Null = stale click.
export const decideSocialPost = async ({ postId, to, actor } = {}) => {
  if (!['approved', 'rejected'].includes(to)) return null;
  const { rows } = await queryFirmDb(
    `update marketing_social_post
        set status = $2, decided_by = $3, decided_at = now()
      where id = $1 and status = 'proposed'
      returning *`,
    [postId, to, String(actor || 'unknown')]
  );
  return rows[0] || null;
};

// The manual-publish receipt: approved→published, URL mandatory.
export const markSocialPostPublished = async ({ postId, url, actor } = {}) => {
  const cleanUrl = String(url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(cleanUrl)) {
    return { ok: false, error: 'A published post needs its live URL (the receipt of the paste).' };
  }
  const { rows } = await queryFirmDb(
    `update marketing_social_post
        set status = 'published', published_url = $2, published_at = now(), published_by = $3
      where id = $1 and status = 'approved'
      returning *`,
    [postId, cleanUrl, String(actor || 'unknown')]
  );
  if (!rows[0]) return { ok: false, error: 'Post is not in the approved state (stale view?).' };
  return { ok: true, post: rows[0] };
};
