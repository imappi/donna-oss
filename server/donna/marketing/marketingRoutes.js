// Marketing outbound HTTP surface (slice 1). Two handlers, wired in api.js:
//
//   - handleMarketingAdminApi — STAFF-ONLY (under the protected
//     /api/donna/marketing/admin prefix): overview, generate drafts, approve-
//     and-send one draft, reject one draft. The actor on every decision is the
//     authenticated principal (operator attribution, pod-safety rule #1) —
//     never 'system'.
//   - handleMarketingUnsubscribe — PUBLIC (the recipient clicks it from their
//     inbox): resolves the per-draft token, suppresses the address, confirms
//     in plain HTML. Unsubscribe must never require auth.
//
// Send invariants live at the writers (suppression check, approved-only send,
// receipt-or-no-sent-flip); this layer authenticates, parses, and reports.

import { getReceivedEmail, isEmailEnabled, sendEmail } from '../email/resendClient.js';
import {
  MARKETING_CHANNELS,
  renderForSend,
  resolveAuthorityStage,
  validateDraftCopy
} from './marketingOutbound.js';
import {
  FORWARDED_CLASSIFICATIONS,
  HANDLED_INBOUND_EVENTS,
  classifyInbound,
  parseThreading,
  planInboundActions,
  verifySvixSignature
} from './marketingInbound.js';
import {
  insertInboundMessage,
  listInboundMessages,
  matchInboundSender,
  recordInboundHandling
} from './marketingInboundDb.js';
import { buildReplyThreadingHeaders } from './replyTriage.js';
import { getInboundMessageById } from './replyTriageDb.js';
import { runReplyTriageSweep } from './replyTriageSweep.js';
import { SOCIAL_CHAR_LIMIT_DEFAULT } from './socialPost.js';
import { draftSocialPosts } from './socialPostDrafter.js';
import {
  decideSocialPost,
  insertSocialPost,
  listSocialPosts,
  markSocialPostPublished
} from './socialPostDb.js';
import {
  addSuppression,
  finalizeSend,
  getDraft,
  getDraftByUnsubscribeToken,
  insertDraft,
  isSuppressed,
  listAuthorityRows,
  listDrafts,
  listNurtureLeads,
  listReceipts,
  markApproved,
  markSendError,
  rejectDraft,
  touchLead
} from './marketingOutboundDb.js';
import { draftNurtureEmail } from './nurtureDrafter.js';
import { draftProspectDossier } from './dossierDrafter.js';
import { CH_SOURCE_BY_MODE, runCompaniesHouseScan } from './companiesHouseSource.js';
import { MANUAL_UPLOAD_SOURCE, parseManualUploadList } from './manualUploadSource.js';
import { envVar } from './openAiConfig.js';
import { PROSPECT_TIERS, REJECT_REASONS } from './prospectLab.js';
import { summarizeDueness } from './prospectClock.js';
import {
  attachDossier,
  finishSourceRun,
  getProspect,
  holdProspect,
  listClockProspects,
  listProspects,
  listSourceRuns,
  mintProspect,
  startSourceRun,
  transitionProspect
} from './prospectLabDb.js';

const MAX_BODY_BYTES = 64 * 1024;
const GENERATE_BATCH_LIMIT = 5;
// Dossier investigations are slow (web-search calls) and Kari's review budget
// is ~10/week — a small batch per click keeps the queue honest and the
// request inside serverless time limits.
const INVESTIGATE_BATCH_LIMIT = 3;
const UPLOAD_ROWS_LIMIT = 200;

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

// Raw body reader — the inbound webhook verifies its Svix signature over the
// EXACT bytes received (parsing first breaks the signature).
const RAW_BODY_LIMIT = 512 * 1024;
const readRawBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > RAW_BODY_LIMIT) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });

// Operator attribution: the authenticated principal's email, or the named
// shared-token principal. Never blank, never 'system' — a marketing decision
// always has a who.
const actorFrom = (req) => {
  const auth = req.donnaAuth || {};
  if (auth.type === 'supabase_user' && auth.email) return auth.email;
  if (auth.type === 'access_token') return 'firm_access_token';
  return 'unknown';
};

// Staff gate: the shared access token is the founder/console credential; a
// Supabase principal must be on the staff allowlist. Self-serve OWNERS are
// authenticated users too — they must never reach lead data.
const requireStaff = (req, res) => {
  const auth = req.donnaAuth || {};
  if (auth.type === 'access_token') return true;
  if (auth.type === 'supabase_user' && auth.staff) return true;
  sendJson(res, 403, { code: 'MARKETING_STAFF_ONLY', error: 'Marketing admin is staff-only.' });
  return false;
};

// Absolute base URL for unsubscribe links, from the request that triggered the
// send (matches the deployment the recipient will hit). Env override for
// non-standard fronting.
const baseUrlFrom = (req) => {
  const envBase = String(process.env.MARKETING_PUBLIC_BASE_URL || '').trim();
  if (envBase) return envBase;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
};

// ── Staff admin surface ──────────────────────────────────────────────────────

export const handleMarketingAdminApi = async (req, res, requestUrl) => {
  if (!requireStaff(req, res)) return;
  const subPath = requestUrl.pathname.replace(/^\/api\/donna\/marketing\/admin/, '') || '/';

  try {
    // GET /overview — leads + live drafts + receipts + authority stages.
    // Renders PERSISTED state only (render-the-persisted-verdict rail).
    if (subPath === '/overview' && req.method === 'GET') {
      const [leads, proposed, sent, receipts, authorityRows, inbound, socialOpen, socialSettled] = await Promise.all([
        listNurtureLeads({ limit: 100 }),
        listDrafts({ statuses: ['proposed', 'approved'] }),
        listDrafts({ statuses: ['sent', 'rejected'], limit: 25 }),
        listReceipts({ limit: 25 }),
        listAuthorityRows(),
        listInboundMessages({ limit: 15 }),
        listSocialPosts({ statuses: ['proposed', 'approved'] }),
        listSocialPosts({ statuses: ['published', 'rejected'], limit: 15 })
      ]);
      sendJson(res, 200, {
        leads,
        drafts_open: proposed,
        drafts_settled: sent,
        receipts,
        inbound,
        social_open: socialOpen,
        social_settled: socialSettled,
        authority: MARKETING_CHANNELS.map((channel) => ({
          channel,
          stage: resolveAuthorityStage(authorityRows, channel)
        })),
        email_enabled: isEmailEnabled()
      });
      return;
    }

    // POST /drafts/generate — draft nurture proposals for un-drafted,
    // un-suppressed leads (bounded batch). Every draft passes the claim
    // checklist or is refused (reported, not silently dropped).
    if (subPath === '/drafts/generate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const onlyEmail = String(body.lead_email || '').trim().toLowerCase();
      const leads = (await listNurtureLeads({ limit: 50, undraftedOnly: true }))
        .filter((lead) => !lead.suppressed)
        .filter((lead) => (onlyEmail ? String(lead.email).toLowerCase() === onlyEmail : true))
        .slice(0, GENERATE_BATCH_LIMIT);

      const minted = [];
      const refused = [];
      for (const lead of leads) {
        try {
          const draft = await draftNurtureEmail({ lead });
          const violations = validateDraftCopy(draft);
          if (violations.length > 0) {
            refused.push({ lead_email: lead.email, violations });
            continue;
          }
          const result = await insertDraft({
            leadEmail: lead.email,
            segment: lead.reason,
            subject: draft.subject,
            body: draft.body,
            model: draft.model
          });
          if (result.ok) minted.push(result.draft);
          else refused.push({ lead_email: lead.email, violations: [result.refused] });
        } catch (error) {
          refused.push({ lead_email: lead.email, violations: [error.message || 'draft failed'] });
        }
      }
      sendJson(res, 200, { minted, refused, considered: leads.length });
      return;
    }

    // POST /drafts/:id/approve-send — the per-send approval. Re-checks
    // suppression and the claim checklist at send time, sends via Resend,
    // then flips sent + receipt in one transaction.
    const approveMatch = subPath.match(/^\/drafts\/([^/]+)\/approve-send$/);
    if (approveMatch && req.method === 'POST') {
      const draftId = approveMatch[1];
      const actor = actorFrom(req);

      const draft = await getDraft(draftId);
      if (!draft) return sendJson(res, 404, { error: 'Draft not found.' });
      if (await isSuppressed(draft.lead_email)) {
        return sendJson(res, 409, { code: 'SUPPRESSED', error: 'This address is suppressed; the send is refused.' });
      }
      // A channel-'reply' draft linked to a real inbound message may carry a
      // genuine "Re:" — the deceptive-threading refusal stays for cold drafts.
      const isReply = draft.channel === 'reply' && Boolean(draft.inbound_message_id);
      const violations = validateDraftCopy(draft, { isReply });
      if (violations.length > 0) {
        return sendJson(res, 409, { code: 'CLAIM_CHECKLIST', error: 'Draft violates the claim checklist.', violations });
      }
      if (!isEmailEnabled()) {
        return sendJson(res, 503, { code: 'EMAIL_NOT_CONFIGURED', error: 'Resend is not configured; cannot send.' });
      }

      const approved = await markApproved({ draftId, actor });
      if (!approved) {
        return sendJson(res, 409, { code: 'NOT_PROPOSED', error: 'Draft already decided (stale view?).' });
      }

      const rendered = renderForSend({ draft: approved, baseUrl: baseUrlFrom(req) });
      // Reply drafts thread into the recipient's mailbox via the inbound
      // row's STORED RFC fields (In-Reply-To/References) — persisted at M3
      // ingestion, never re-derived here.
      let threadingHeaders = {};
      if (isReply) {
        const inboundMessage = await getInboundMessageById(approved.inbound_message_id);
        threadingHeaders = buildReplyThreadingHeaders(inboundMessage || {});
      }
      const sendResult = await sendEmail({
        to: approved.lead_email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: { ...rendered.headers, ...threadingHeaders }
      });
      if (!sendResult.ok) {
        await markSendError({ draftId, error: sendResult.error || sendResult.reason || 'send failed' });
        return sendJson(res, 502, {
          code: 'SEND_FAILED',
          error: sendResult.error || sendResult.reason || 'Resend send failed.',
          draft_status: 'approved'
        });
      }

      const finalized = await finalizeSend({
        draftId,
        approvedBy: actor,
        authority: 'per_send',
        transportMessageId: sendResult.id,
        renderedSubject: rendered.subject,
        renderedBody: rendered.text
      });
      if (!finalized.ok) {
        // The email LEFT but the receipt transaction failed — surface loudly;
        // this must never pass silently.
        return sendJson(res, 500, {
          code: 'RECEIPT_FAILED',
          error: `Email was sent (transport id ${sendResult.id}) but the receipt could not be recorded: ${finalized.error}`
        });
      }
      sendJson(res, 200, { ok: true, draft: finalized.draft, receipt_id: finalized.receiptId, transport_message_id: sendResult.id });
      return;
    }

    // POST /drafts/:id/reject — terminal; the rejection is training signal.
    const rejectMatch = subPath.match(/^\/drafts\/([^/]+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      const rejected = await rejectDraft({ draftId: rejectMatch[1], actor: actorFrom(req) });
      if (!rejected) return sendJson(res, 409, { code: 'NOT_PROPOSED', error: 'Draft already decided.' });
      await touchLead({ email: rejected.lead_email });
      sendJson(res, 200, { ok: true, draft: rejected });
      return;
    }

    // POST /inbound/triage — the manual M4 sweep button (the hourly cron runs
    // the same sweep). Optional body.message_id forces one specific message —
    // including a RE-triage of an already-verdicted one (append-only verdicts;
    // latest wins). Everything it drafts rests 'proposed'; nothing sends.
    if (subPath === '/inbound/triage' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const summary = await runReplyTriageSweep({
        messageId: String(body.message_id || '').trim() || null,
        limit: Number(body.limit) > 0 ? Number(body.limit) : null
      });
      sendJson(res, 200, summary);
      return;
    }

    // ── Social (B1 of the buzz charter — per-post approval, manual publish) ──

    // POST /social/generate — draft a batch of diagnostic-content post
    // proposals. Every post passes validateSocialPostCopy at the mint or is
    // refused (reported, not silently dropped). Nothing publishes itself.
    if (subPath === '/social/generate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const maxChars = Number(process.env.MARKETING_SOCIAL_CHAR_LIMIT) || SOCIAL_CHAR_LIMIT_DEFAULT;
      const siteUrl = String(process.env.MARKETING_PUBLIC_BASE_URL || '').trim() || null;
      const { posts, model } = await draftSocialPosts({
        count: body.count,
        maxChars,
        siteUrl,
        topicHint: String(body.topic_hint || '').trim() || null
      });
      const minted = [];
      const refused = [];
      for (const post of posts) {
        const result = await insertSocialPost({
          body: post.body,
          sourceContext: { angle: post.angle },
          model,
          maxChars
        });
        if (result.ok) minted.push(result.post);
        else refused.push({ body: post.body.slice(0, 120), violations: result.violations });
      }
      sendJson(res, 200, { minted, refused, model });
      return;
    }

    // POST /social/:id/approve | /social/:id/reject — the per-post decision.
    const socialDecideMatch = subPath.match(/^\/social\/([^/]+)\/(approve|reject)$/);
    if (socialDecideMatch && req.method === 'POST') {
      const decided = await decideSocialPost({
        postId: socialDecideMatch[1],
        to: socialDecideMatch[2] === 'approve' ? 'approved' : 'rejected',
        actor: actorFrom(req)
      });
      if (!decided) return sendJson(res, 409, { code: 'NOT_PROPOSED', error: 'Post already decided (stale view?).' });
      sendJson(res, 200, { ok: true, post: decided });
      return;
    }

    // POST /social/:id/mark-published — the manual-publish receipt: Kari
    // pasted the approved post on X and pastes the live URL back here.
    const socialPublishMatch = subPath.match(/^\/social\/([^/]+)\/mark-published$/);
    if (socialPublishMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await markSocialPostPublished({
        postId: socialPublishMatch[1],
        url: body.url,
        actor: actorFrom(req)
      });
      if (!result.ok) return sendJson(res, 409, { code: 'PUBLISH_RECEIPT', error: result.error });
      sendJson(res, 200, { ok: true, post: result.post });
      return;
    }

    // ── Prospecting Lab (P0 — dossiers only, ZERO sends) ────────────────────

    // GET /prospects/overview — every live prospect + recent source runs +
    // the decision vocabulary (so the UI renders the persisted taxonomy, not
    // a hardcoded copy) + the clock's due view (M2 — deterministic arithmetic
    // over persisted rows, recomputed per render; the hourly cron nudges when
    // this page isn't open).
    if (subPath === '/prospects/overview' && req.method === 'GET') {
      const [prospects, sourceRuns, clockProspects] = await Promise.all([
        listProspects({ limit: 200 }),
        listSourceRuns({ limit: 10 }),
        listClockProspects()
      ]);
      sendJson(res, 200, {
        prospects,
        source_runs: sourceRuns,
        due: summarizeDueness(clockProspects),
        vocab: { reject_reasons: REJECT_REASONS, tiers: PROSPECT_TIERS }
      });
      return;
    }

    // POST /prospects/upload — the manual-upload source module (P0C). CSV or
    // one-company-per-line text in; candidates minted under a source-run
    // receipt. Nothing silent: skipped lines and already-live dedups are
    // reported back, and the run receipt records the counts.
    if (subPath === '/prospects/upload' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const tier = String(body.tier || 'green').toLowerCase();
      if (!PROSPECT_TIERS.includes(tier)) {
        return sendJson(res, 400, { error: `tier must be one of ${PROSPECT_TIERS.join('/')}` });
      }
      const defaults = {
        defaultTier: tier,
        defaultJurisdiction: String(body.jurisdiction || 'UK').toUpperCase(),
        defaultCampaigns: Array.isArray(body.campaigns)
          ? body.campaigns.map((tag) => String(tag).trim()).filter(Boolean)
          : String(body.campaigns || '').split(/[;,|]/).map((tag) => tag.trim()).filter(Boolean)
      };
      const parsed = parseManualUploadList(body.text, defaults);
      if (parsed.candidates.length === 0) {
        return sendJson(res, 400, { error: 'No mintable rows in the upload.', mode: parsed.mode, skipped: parsed.skipped });
      }
      if (parsed.candidates.length > UPLOAD_ROWS_LIMIT) {
        return sendJson(res, 400, { error: `Upload carries ${parsed.candidates.length} rows; the per-run cap is ${UPLOAD_ROWS_LIMIT}.` });
      }

      const run = await startSourceRun({
        source: MANUAL_UPLOAD_SOURCE,
        params: {
          filename: String(body.filename || '').trim() || null,
          mode: parsed.mode,
          tier,
          campaigns: defaults.defaultCampaigns,
          rows: parsed.candidates.length,
          skipped: parsed.skipped.length
        },
        startedBy: actorFrom(req)
      });

      const minted = [];
      const alreadyLive = [];
      try {
        for (const candidate of parsed.candidates) {
          const result = await mintProspect({ ...candidate, source: MANUAL_UPLOAD_SOURCE, sourceRunId: run.id });
          (result.inserted ? minted : alreadyLive).push(result.prospect);
        }
        await finishSourceRun({
          runId: run.id,
          candidatesFound: parsed.candidates.length,
          prospectsMinted: minted.length
        });
      } catch (error) {
        await finishSourceRun({ runId: run.id, candidatesFound: parsed.candidates.length, prospectsMinted: minted.length, error: error.message });
        throw error;
      }
      sendJson(res, 200, {
        run_id: run.id,
        mode: parsed.mode,
        minted,
        already_live: alreadyLive.map((p) => ({ id: p.id, company_name: p.company_name, status: p.status })),
        skipped: parsed.skipped
      });
      return;
    }

    // POST /prospects/scan — the Companies House source modules (P0B).
    // mode: overdue | first_filing. dry_run performs the search + profile
    // reads and reports what WOULD mint, without writing prospects — use it
    // for the first keyed run to validate the live API shapes (the module
    // asserts them and surfaces the provider's own error body on mismatch).
    // Every run (dry or not) leaves a source-run receipt.
    if (subPath === '/prospects/scan' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const mode = String(body.mode || '').trim();
      const source = CH_SOURCE_BY_MODE[mode];
      if (!source) return sendJson(res, 400, { error: 'mode must be overdue or first_filing.' });
      const sicCodes = (Array.isArray(body.sic_codes) ? body.sic_codes : String(body.sic_codes || '').split(/[;,|\s]+/))
        .map((code) => String(code).trim())
        .filter(Boolean);
      const campaigns = Array.isArray(body.campaigns)
        ? body.campaigns.map((tag) => String(tag).trim()).filter(Boolean)
        : String(body.campaigns || '').split(/[;,|]/).map((tag) => tag.trim()).filter(Boolean);
      const dryRun = body.dry_run === true;

      const run = await startSourceRun({
        source,
        params: { mode, sic_codes: sicCodes, campaigns, dry_run: dryRun },
        startedBy: actorFrom(req)
      });

      let scan;
      try {
        scan = await runCompaniesHouseScan({ mode, sicCodes, apiKey: envVar('COMPANIES_HOUSE_API_KEY') });
      } catch (error) {
        await finishSourceRun({ runId: run.id, error: error.message });
        return sendJson(res, error.statusCode || 502, { code: error.code || 'SCAN_FAILED', error: error.message, run_id: run.id });
      }

      const minted = [];
      const alreadyLive = [];
      try {
        if (!dryRun) {
          for (const candidate of scan.candidates) {
            const result = await mintProspect({ ...candidate, campaigns, source, sourceRunId: run.id });
            (result.inserted ? minted : alreadyLive).push(result.prospect);
          }
        }
        await finishSourceRun({ runId: run.id, candidatesFound: scan.candidates.length, prospectsMinted: minted.length });
      } catch (error) {
        await finishSourceRun({ runId: run.id, candidatesFound: scan.candidates.length, prospectsMinted: minted.length, error: error.message });
        throw error;
      }
      sendJson(res, 200, {
        run_id: run.id,
        dry_run: dryRun,
        searched: scan.searched,
        candidates: dryRun ? scan.candidates : undefined,
        minted,
        already_live: alreadyLive.map((p) => ({ id: p.id, company_name: p.company_name, status: p.status })),
        skipped: scan.skipped
      });
      return;
    }

    // POST /prospects/investigate — drain candidates through the dossier
    // stage: candidate → investigating → (validated dossier) → on_kari. A
    // drafter failure or validator refusal leaves the prospect at
    // `investigating` (a transient hop the next run retries) and is REPORTED,
    // never swallowed.
    if (subPath === '/prospects/investigate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const onlyId = String(body.prospect_id || '').trim();
      const actor = actorFrom(req);
      let targets;
      if (onlyId) {
        const one = await getProspect(onlyId);
        if (!one) return sendJson(res, 404, { error: 'Prospect not found.' });
        targets = [one];
      } else {
        // Retry stranded `investigating` rows first (earlier refusals), then
        // fresh candidates, up to the batch cap.
        const stranded = await listProspects({ statuses: ['investigating'], limit: INVESTIGATE_BATCH_LIMIT });
        const fresh = await listProspects({ statuses: ['candidate'], limit: INVESTIGATE_BATCH_LIMIT });
        targets = [...stranded, ...fresh].slice(0, INVESTIGATE_BATCH_LIMIT);
      }

      const onKari = [];
      const refused = [];
      for (const prospect of targets) {
        try {
          const investigating = prospect.status === 'investigating'
            ? prospect
            : await transitionProspect({ prospectId: prospect.id, from: 'candidate', to: 'investigating', actor });
          if (!investigating) {
            refused.push({ prospect_id: prospect.id, company_name: prospect.company_name, violations: ['not in a drainable state (stale view?)'] });
            continue;
          }
          const { dossier, model } = await draftProspectDossier({ prospect: investigating });
          const attached = await attachDossier({
            prospectId: prospect.id,
            dossier,
            model,
            contactEmail: dossier?.contact?.email || null
          });
          if (attached.ok) onKari.push(attached.prospect);
          else refused.push({ prospect_id: prospect.id, company_name: prospect.company_name, violations: attached.violations });
        } catch (error) {
          refused.push({ prospect_id: prospect.id, company_name: prospect.company_name, violations: [error.message || 'investigation failed'] });
        }
      }
      sendJson(res, 200, { on_kari: onKari, refused, considered: targets.length });
      return;
    }

    // POST /prospects/:id/decide — Kari's per-dossier decision (§6 card
    // actions). approve → approved_for_draft (P0 stops here: ZERO sends until
    // P1's jurisdiction/deliverability gates exist); reject → unfit with
    // mandatory §10A reasons; research_only → the deliberate parking lane;
    // hold → stays on_kari with an optional revisit date.
    const decideMatch = subPath.match(/^\/prospects\/([^/]+)\/decide$/);
    if (decideMatch && req.method === 'POST') {
      const prospectId = decideMatch[1];
      const body = await readJsonBody(req);
      const action = String(body.action || '').trim();
      const actor = actorFrom(req);

      if (action === 'hold') {
        const held = await holdProspect({ prospectId, actor, nextActionAt: body.next_action_at || null });
        if (!held) return sendJson(res, 409, { code: 'NOT_ON_KARI', error: 'Prospect is not in your queue (stale view?).' });
        return sendJson(res, 200, { ok: true, prospect: held });
      }

      const to = { approve: 'approved_for_draft', reject: 'unfit', research_only: 'research_only' }[action];
      if (!to) {
        return sendJson(res, 400, { error: 'action must be approve / reject / hold / research_only.' });
      }
      const rejectReasons = Array.isArray(body.reject_reasons) ? body.reject_reasons.filter(Boolean) : [];
      if (action === 'reject' && rejectReasons.length === 0) {
        return sendJson(res, 400, { code: 'REJECT_REASON_REQUIRED', error: 'A rejection must carry at least one §10A reason — rejections are the lab\'s learning output.' });
      }
      const updated = await transitionProspect({
        prospectId,
        from: 'on_kari',
        to,
        actor,
        patch: action === 'reject' ? { rejectReasons } : {}
      });
      if (!updated) return sendJson(res, 409, { code: 'NOT_ON_KARI', error: 'Prospect is not in your queue (stale view?).' });
      sendJson(res, 200, { ok: true, prospect: updated });
      return;
    }

    sendJson(res, 404, { error: 'Unknown marketing admin route.' });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      code: error.code || 'MARKETING_ERROR',
      error: error.message || 'Marketing request failed.'
    });
  }
};

// ── Public unsubscribe ───────────────────────────────────────────────────────

const UNSUB_HTML = (message) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Donna</title></head>` +
  `<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">` +
  `<h1 style="font-size:1.3rem;">Donna</h1><p>${message}</p></body></html>`;

export const handleMarketingUnsubscribe = async (req, res, requestUrl) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const token = String(requestUrl.searchParams.get('token') || '').trim();
    const draft = token ? await getDraftByUnsubscribeToken(token) : null;
    if (!draft) {
      res.statusCode = 404;
      res.end(UNSUB_HTML('That unsubscribe link is not valid. Email support@books.example and a human will remove you.'));
      return;
    }
    await addSuppression({ email: draft.lead_email, reason: 'unsubscribed', source: `draft:${draft.id}` });
    res.statusCode = 200;
    res.end(UNSUB_HTML("You're unsubscribed — no more emails from us. If you ever want back in, just write to support@books.example."));
  } catch {
    res.statusCode = 500;
    res.end(UNSUB_HTML('Something went wrong. Email support@books.example and a human will remove you.'));
  }
};

// ── Inbound webhook (M3 — reply ingestion) ───────────────────────────────────
// PUBLIC endpoint; the Svix signature IS the auth, verified over the RAW body.
// Fail-closed without a configured secret. Svix retries any non-2xx: an
// email.received whose body retrieval fails returns 502 WITHOUT inserting, so
// redelivery retries the whole unit; the (provider, event_type, email_id)
// dedupe index makes redelivery of an already-handled event a receipted no-op
// (no double suppression, no double forward).

const extractAddress = (value) => {
  const raw = typeof value === 'string' ? value : value?.email || '';
  const angled = raw.match(/<([^>]+)>/);
  return String(angled ? angled[1] : raw).trim().toLowerCase() || null;
};

const forwardBodyFor = ({ classification, fromAddr, subject, textBody, match }) => [
  `Inbound ${classification.replace(/_/g, ' ')} via the marketing inbound webhook.`,
  `From: ${fromAddr || 'unknown'}`,
  `Matched: ${match.leadEmail ? `lead ${match.leadEmail}` : ''}${match.prospectId ? ` prospect ${match.prospectId}` : ''}`.trim() || 'Matched: nothing known',
  `Subject: ${subject || '(no subject)'}`,
  '',
  String(textBody || '(no text body retrieved)').slice(0, 5000)
].join('\n');

const ingestInboundEvent = async ({ event, eventType }) => {
  const data = event?.data || {};
  const providerEmailId = data.email_id || data.id || null;
  const fromAddr = extractAddress(data.from);
  const recipients = (Array.isArray(data.to) ? data.to : [data.to]).filter(Boolean).map(extractAddress).filter(Boolean);

  let textBody = null;
  let htmlBody = null;
  let headers = null;
  let threading = { message_id: null, in_reply_to: null, references_header: null };
  if (eventType === 'email.received') {
    const retrieved = await getReceivedEmail(providerEmailId);
    if (!retrieved.ok) {
      return {
        retriable: true,
        body: { code: 'RETRIEVAL_FAILED', error: retrieved.error || retrieved.reason || 'body retrieval failed' }
      };
    }
    textBody = retrieved.email?.text ?? null;
    htmlBody = retrieved.email?.html ?? null;
    headers = retrieved.email?.headers ?? null;
    threading = parseThreading(headers);
  }

  const match = await matchInboundSender(fromAddr);
  const matched = Boolean(match.leadEmail || match.prospectId);
  const classification = classifyInbound({ eventType, subject: data.subject, textBody, headers, matched });

  const inserted = await insertInboundMessage({
    eventType,
    providerEmailId,
    fromEmail: fromAddr,
    toEmail: recipients[0] || null,
    subject: data.subject || null,
    textBody,
    htmlBody,
    headers,
    messageId: threading.message_id,
    inReplyTo: threading.in_reply_to,
    referencesHeader: threading.references_header,
    classification,
    matchedLeadEmail: match.leadEmail,
    matchedProspectId: match.prospectId,
    rawPayload: event,
    receivedAt: event?.created_at || null
  });
  if (!inserted) return { retriable: false, body: { ok: true, duplicate: true } };

  // Deterministic actions, each receipted on the row. Bounce/complaint
  // suppress OUR recipient(s); an unsubscribe request suppresses the sender.
  const handled = [];
  let handlingError = null;
  for (const action of planInboundActions({ classification, fromEmail: fromAddr, recipients })) {
    try {
      await addSuppression({ email: action.email, reason: action.reason, source: 'inbound_webhook' });
      handled.push(action);
    } catch (error) {
      handlingError = `suppress ${action.email}: ${error?.message || error}`;
    }
  }

  // Human mail reaches the founder's real inbox (preserves the "replies are
  // Kari's conversation" posture once reply-to points at the inbound domain).
  let forwardedTo = null;
  const forwardTo = envVar('MARKETING_INBOUND_FORWARD_TO');
  if (forwardTo && FORWARDED_CLASSIFICATIONS.includes(classification)) {
    const fwd = await sendEmail({
      to: forwardTo,
      subject: `[Donna inbound · ${classification}] ${data.subject || '(no subject)'}`,
      text: forwardBodyFor({ classification, fromAddr, subject: data.subject, textBody, match })
    });
    if (fwd.ok) {
      forwardedTo = forwardTo;
      handled.push({ action: 'forward', to: forwardTo });
    } else {
      handlingError = [handlingError, `forward: ${fwd.error || fwd.reason || 'send failed'}`].filter(Boolean).join('; ');
    }
  }

  await recordInboundHandling({ messageId: inserted.id, handledActions: handled, forwardedTo, error: handlingError });
  if (match.leadEmail && classification === 'reply') await touchLead({ email: match.leadEmail });

  return { retriable: false, body: { ok: true, id: inserted.id, classification } };
};

export const handleMarketingInboundWebhook = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only.' });
  const secret = envVar('MARKETING_INBOUND_WEBHOOK_SECRET');
  if (!secret) {
    return sendJson(res, 503, {
      code: 'WEBHOOK_NOT_CONFIGURED',
      error: 'MARKETING_INBOUND_WEBHOOK_SECRET is not set; the inbound webhook refuses honestly.'
    });
  }
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message || 'bad request body' });
  }
  const verdict = verifySvixSignature({
    secret,
    svixId: req.headers['svix-id'],
    svixTimestamp: req.headers['svix-timestamp'],
    svixSignature: req.headers['svix-signature'],
    rawBody
  });
  if (!verdict.ok) return sendJson(res, 401, { code: 'BAD_SIGNATURE', error: verdict.reason });

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { error: 'Body is not valid JSON.' });
  }
  const eventType = String(event?.type || '');
  if (!HANDLED_INBOUND_EVENTS.includes(eventType)) {
    // Acknowledged, not stored — an unknown event must never 500 (Svix would
    // retry it forever) and never silently grow the stored vocabulary.
    return sendJson(res, 200, { ok: true, ignored: eventType || 'unknown' });
  }
  try {
    const result = await ingestInboundEvent({ event, eventType });
    return sendJson(res, result.retriable ? 502 : 200, result.body);
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || 'inbound ingestion failed' });
  }
};
