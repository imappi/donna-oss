// Client-side marketing admin calls. Thin wrappers over the staff-only
// /api/donna/marketing/admin/* endpoints, reusing firmFetch so the console's
// auth headers apply exactly as they do for every other firm request.
//
// This surface renders PERSISTED state (drafts, receipts, authority stages)
// and issues the two decisions a draft can take: approve-and-send (the
// per-send approval — v1's only send authority) or reject.

import { firmFetch, coerceErrorMessage } from './firmApi.js';

const parseOrThrow = async (response, fallback) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(coerceErrorMessage(body.error, fallback));
    error.status = response.status;
    error.code = body.code;
    error.violations = body.violations;
    throw error;
  }
  return body;
};

export const fetchMarketingOverview = async ({ signal } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/overview', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseOrThrow(response, `Marketing overview failed with ${response.status}`);
};

export const generateNurtureDrafts = async ({ leadEmail } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/drafts/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(leadEmail ? { lead_email: leadEmail } : {})
  });
  return parseOrThrow(response, `Draft generation failed with ${response.status}`);
};

export const approveAndSendDraft = async (draftId) => {
  const response = await firmFetch(
    `/api/donna/marketing/admin/drafts/${encodeURIComponent(draftId)}/approve-send`,
    { method: 'POST', headers: { Accept: 'application/json' } }
  );
  return parseOrThrow(response, `Send failed with ${response.status}`);
};

export const rejectDraft = async (draftId) => {
  const response = await firmFetch(
    `/api/donna/marketing/admin/drafts/${encodeURIComponent(draftId)}/reject`,
    { method: 'POST', headers: { Accept: 'application/json' } }
  );
  return parseOrThrow(response, `Reject failed with ${response.status}`);
};

// Manual reply-triage sweep (M4). The hourly cron runs the same sweep; this
// is the button. Optional messageId forces a re-triage of one message.
export const triageInbound = async ({ messageId } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/inbound/triage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messageId ? { message_id: messageId } : {})
  });
  return parseOrThrow(response, `Reply triage failed with ${response.status}`);
};

// ── Social (B1 — per-post approval, manual publish with URL receipt) ─────────

export const generateSocialPosts = async ({ count, topicHint } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/social/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ count, topic_hint: topicHint })
  });
  return parseOrThrow(response, `Social post generation failed with ${response.status}`);
};

export const decideSocialPost = async (postId, action) => {
  const response = await firmFetch(
    `/api/donna/marketing/admin/social/${encodeURIComponent(postId)}/${action === 'approve' ? 'approve' : 'reject'}`,
    { method: 'POST', headers: { Accept: 'application/json' } }
  );
  return parseOrThrow(response, `Social post decision failed with ${response.status}`);
};

export const markSocialPublished = async (postId, url) => {
  const response = await firmFetch(
    `/api/donna/marketing/admin/social/${encodeURIComponent(postId)}/mark-published`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url })
    }
  );
  return parseOrThrow(response, `Publish receipt failed with ${response.status}`);
};

// ── Prospecting Lab (P0 — dossiers only, zero sends) ─────────────────────────

export const fetchProspectsOverview = async ({ signal } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/prospects/overview', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  return parseOrThrow(response, `Prospects overview failed with ${response.status}`);
};

export const uploadProspects = async ({ text, campaigns, tier, jurisdiction, filename } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/prospects/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text, campaigns, tier, jurisdiction, filename })
  });
  return parseOrThrow(response, `Prospect upload failed with ${response.status}`);
};

export const scanCompaniesHouse = async ({ mode, sicCodes, campaigns, dryRun } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/prospects/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ mode, sic_codes: sicCodes, campaigns, dry_run: dryRun === true })
  });
  return parseOrThrow(response, `Companies House scan failed with ${response.status}`);
};

export const investigateProspects = async ({ prospectId } = {}) => {
  const response = await firmFetch('/api/donna/marketing/admin/prospects/investigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(prospectId ? { prospect_id: prospectId } : {})
  });
  return parseOrThrow(response, `Investigation failed with ${response.status}`);
};

export const decideProspect = async (prospectId, { action, rejectReasons, nextActionAt } = {}) => {
  const response = await firmFetch(
    `/api/donna/marketing/admin/prospects/${encodeURIComponent(prospectId)}/decide`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action, reject_reasons: rejectReasons, next_action_at: nextActionAt })
    }
  );
  return parseOrThrow(response, `Decision failed with ${response.status}`);
};
