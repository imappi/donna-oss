// Owner pending-actions digest (M1, G9 — execution plan A4/D2, digest-first).
// The owner-visible half of two-terminal-states for the outbound pipeline:
// everything resting on the owner is gathered into ONE daily email —
//
//   NEEDS YOUR APPROVAL — hold_for_approval actions, each with one-tap
//     approve / don't-send links (the 093 bearer tokens; D10: email is the
//     US workbench until the G15 workspace lands);
//   MUST REVIEW — failed sends (provider refusals, surfaced until acted on),
//     stale executing leases (a possibly-sent send is NEVER auto-retried),
//     and escalated cases (cadence out of road — the owner decides what's
//     next);
//   NEEDS INFO — open cases resting on a named gap (no recipient email, no
//     payment instructions…): business facts only the owner can supply.
//
// Change-detection: a content hash over the gathered sets. An unchanged
// digest is NOT re-sent daily (owner-interruption rate is a decider metric);
// a stale unchanged one re-surfaces after RESURFACE_MS so nothing silently
// ages out. Every delivery lands in outbound_digests (093) + an audit event.
//
// Gate: the digest sends only for clients where at least one OUTBOUND_* flag
// ACTS — a dark or shadow pipeline surfaces nothing to owners.
//
// Owner-locale note: digest copy is owner-surface English, the tree's
// current owner-channel posture (gap-11 debt, tracked — not a pack concern:
// this is Donna talking to her OWNER, not a counterparty document).
//
// Keep-layer posture: deterministic gathers + rendering. No LLM.

import { createHash, randomUUID } from 'node:crypto';

import { readClientConfigSnapshot } from '../clientConfig.js';
import {
  outboundGateMode, OUTBOUND_ACTION_TYPES, OWNER_DIRECTED_ACTION_TYPES
} from './actionGate.js';
import { readInvoiceIssuanceRefusal } from './issuance.js';
import { listStaleExecutingActions } from './actionStore.js';
import { gatherEarnedAutoStates } from './earnedAutoLadder.js';
import { listReceivableCases } from './receivableCases.js';
import { resolveOwnerDigestReplyTo } from './replyIngestionCore.js';
import {
  buildOutboundApprovalUrl, buildOwnerWorkspaceUrl, outboundPublicBaseUrl,
  resolveOwnerReplyTo
} from './sendingIdentity.js';
import { loadOutboundPack } from './packs.js';
import { resolveOutboundActionLanguage } from './emailArtifact.js';

const RESURFACE_MS = 7 * 86400000;

const missingTables = (error) => error?.code === '42P01' || error?.code === '42703';

// Human phrasing for gate hold reasons (the receipt keeps the raw enum).
// Exported: the G15/D12 workspace Actions tab renders THE SAME copy off the
// same gather — one phrasing home, never a parallel copy table.
export const HOLD_REASON_COPY = Object.freeze({
  invoice_seller_jurisdiction_changed: 'The seller jurisdiction does not authorize this invoice; choose Don’t send to close it',
  invoice_tax_rendering_unsupported: 'Singapore tax-invoice rendering is not supported; this invoice cannot be sent',
  stage_below_auto: 'every send currently waits for your OK',
  confidence_below_auto_floor: 'every send currently waits for your OK',
  paid_truth_ambiguous: 'this invoice may already be paid — Donna held it for you to confirm',
  paid_truth_missing: 'Donna could not verify this is still unpaid, so she held it',
  requested_language_unavailable: 'the requested language is not available yet — choose an explicit supported fallback or don’t send',
  approved_delivery_contract_changed: 'the approved language or delivery contract changed — review this send again'
});

// Owner-surface copy has one home for the standing workspace and digest.
export const BLOCKED_RECURRENCE_COPY = Object.freeze({
  heading: 'Blocked recurring invoices',
  stop: 'Stop blocked recurrence',
  explanation: 'No invoice was created or sent for this period. Stop this blocked recurrence to end its automatic continuation; this does not record the invoice as completed.'
});

export const GAP_COPY = Object.freeze({
  no_recipient_channel: 'no email address on file for this customer — reply with their billing email',
  missing_payment_instructions: 'no payment instructions on file — tell Donna how customers should pay you',
  missing_invoice_number: 'the parsed invoice has no invoice number — check the document',
  missing_owner_business_name: 'your business name is missing from the venture profile'
});

// includeNotifiedAutoSent: the EMAIL digest FYIs each auto-send exactly once
// (the payload.notified_ids ledger below), so its gather EXCLUDES already-
// notified sends. The G15/D12 workspace tab renders the same gather as a
// STANDING view — there "recently auto-sent" means the whole 7-day window,
// notified or not. A read option on the ONE gather, never a parallel query;
// the digest path keeps the default and the ledger untouched.
export const gatherOwnerDigest = async (client, {
  firmId, clientId, includeNotifiedAutoSent = false, includeNotifiedOwnerReplies = false
}) => {
  const pending = await client.query(
    `select a.*, p.display_name as party_name,
            p.preferred_language as party_preferred_language,
            p.fallback_language as party_fallback_language
       from outbound_actions a
       left join client_parties p on p.id = a.target_party_id
      where a.firm_id = $1 and a.client_id = $2 and a.status = 'hold_for_approval'
      order by a.created_at asc
      limit 50`,
    [firmId, clientId]
  ).then((r) => r.rows).catch((error) => {
    if (missingTables(error)) return [];
    throw error;
  });

  for (const action of pending) {
    const refusal = await readInvoiceIssuanceRefusal(client, { firmId, clientId, action });
    if (refusal) action.invoice_admission_refusal = refusal;
  }

  const failed = await client.query(
    `select a.*, p.display_name as party_name
       from outbound_actions a
       left join client_parties p on p.id = a.target_party_id
      where a.firm_id = $1 and a.client_id = $2 and a.status = 'failed'
      order by a.updated_at desc
      limit 50`,
    [firmId, clientId]
  ).then((r) => r.rows).catch((error) => {
    if (missingTables(error)) return [];
    throw error;
  });

  let stale = [];
  try {
    stale = await listStaleExecutingActions(client, { firmId, clientId });
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  let escalated = [];
  let needsInput = [];
  try {
    escalated = await listReceivableCases(client, { firmId, clientId, statuses: ['escalated'] });
    const open = await listReceivableCases(client, { firmId, clientId, statuses: ['open'] });
    needsInput = open.filter((c) => c.status_reason);
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  // D1 decide-and-notify (the digest copy flip): third-party sends that went
  // out under EARNED authority (stage:auto or a standing grant) surface as a
  // courtesy FYI — "sent these, reply if wrong" — never a click queue.
  // Owner-directed sends (M4 payable notices) are excluded: the owner already
  // received that email directly. Only sends not yet notified in a prior
  // digest are listed, so the FYI fires once per send.
  let autoSent = [];
  try {
    const recent = await client.query(
      `select a.*, p.display_name as party_name, r.created_at as receipt_created_at
         from outbound_action_receipts r
         join outbound_actions a on a.id = r.action_id
         left join client_parties p on p.id = a.target_party_id
        where r.firm_id = $1 and r.client_id = $2
          and r.outcome = 'sent'
          and (r.authority like 'stage:auto:%' or r.authority like 'action_authority_grant:%')
          and r.created_at > now() - interval '7 days'
        order by r.created_at asc
        limit 50`,
      [firmId, clientId]
    ).then((r) => r.rows);
    const alreadyNotified = new Set();
    if (!includeNotifiedAutoSent) {
      const prior = await client.query(
        `select payload from outbound_digests
          where firm_id = $1 and client_id = $2
            and sent_at > now() - interval '14 days'`,
        [firmId, clientId]
      ).then((r) => r.rows).catch((error) => {
        if (missingTables(error)) return [];
        throw error;
      });
      for (const row of prior) {
        for (const id of (row.payload?.notified_ids || [])) alreadyNotified.add(id);
      }
    }
    autoSent = recent.filter((a) =>
      !OWNER_DIRECTED_ACTION_TYPES.includes(a.action_type) && !alreadyNotified.has(a.id));
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  // D1 earned state — the FYI that automatic sending is EARNED but resting on
  // the terminal approval (recorded, digest-visible; nothing for the owner to
  // do). Graduated rows need no line: their sends speak via autoSent above.
  let earned = [];
  try {
    earned = (await gatherEarnedAutoStates(client, { firmId, clientId }))
      .filter((row) => row.state === 'earned');
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  // reply_if_wrong v2 — owner email replies the ingestion sweep terminated ON
  // THE OWNER (a wrong-claim without one confident target, a question Donna
  // cannot act on by email, or a reply that kept failing classification).
  // The DIGEST notifies each once (owner_notified_at, stamped on send); the
  // workspace tab is the standing view (includeNotifiedOwnerReplies).
  let ownerReplies = [];
  try {
    ownerReplies = await client.query(
      `select id, subject, classification, received_at, created_at, owner_notified_at
         from outbound_owner_replies
        where firm_id = $1 and client_id = $2 and status = 'needs_owner'
          and (($3::boolean and created_at > now() - interval '7 days')
            or (not $3::boolean and owner_notified_at is null))
        order by created_at asc
        limit 20`,
      [firmId, clientId, Boolean(includeNotifiedOwnerReplies)]
    ).then((r) => r.rows);
  } catch (error) {
    if (!missingTables(error)) throw error;
  }

  return { pending, failed, stale, escalated, needsInput, autoSent, earned, ownerReplies };
};

// Deterministic content hash: ids + the states that would change what the
// owner sees. Same hash ⇒ same digest ⇒ don't re-send (until re-surface).
export const digestContentHash = (digest) => {
  const key = JSON.stringify({
    pending: digest.pending.map((a) => {
      const language = ownerActionLanguageFor(a);
      return `${a.id}:${a.invoice_admission_refusal || 'admitted'}:${language.reason || 'ok'}:${language.requested_language || ''}:${language.actual_language || ''}`;
    }).sort(),
    failed: digest.failed.map((a) => a.id).sort(),
    stale: digest.stale.map((a) => a.id).sort(),
    escalated: digest.escalated.map((c) => c.id).sort(),
    needsInput: digest.needsInput.map((c) => `${c.id}:${c.status_reason}`).sort(),
    // Earned rows are hashed (a new EARNED state should surface once);
    // autoSent is deliberately NOT hashed — its send-decision is "any new
    // auto-send triggers a digest", and hashing it would re-send an otherwise
    // unchanged digest when old FYIs age out of the window.
    earned: (digest.earned || []).map((r) => `${r.id}:${r.state}`).sort()
    // ownerReplies is deliberately NOT hashed (the autoSent shape): its
    // send-decision is "any un-notified reply triggers a digest" (the skip
    // guard below), and hashing it would re-send an otherwise unchanged
    // digest after the notified-once stamp flips the hash back.
  });
  return createHash('sha256').update(key).digest('hex');
};

export const isOwnerDigestEmpty = (digest) =>
  !digest.pending.length && !digest.failed.length && !digest.stale.length
  && !digest.escalated.length && !digest.needsInput.length
  && !(digest.autoSent || []).length && !(digest.earned || []).length
  && !(digest.ownerReplies || []).length;

export const ownerActionLanguageFor = (action) => {
  try {
    const pack = loadOutboundPack(action.pack_id);
    const ownerDirected = OWNER_DIRECTED_ACTION_TYPES.includes(action.action_type);
    const resolution = resolveOutboundActionLanguage({
      pack,
      actionLanguage: action.language,
      preferredLanguage: action.party_preferred_language,
      fallbackLanguage: action.party_fallback_language,
      ownerDirected
    });
    return {
      ok: resolution.ok,
      reason: resolution.reason,
      requested_language: resolution.requestedLanguage,
      actual_language: resolution.actualLanguage,
      source: resolution.languageSource,
      fallback_basis: resolution.fallbackBasis,
      locale: resolution.locale,
      direction: resolution.direction,
      fallback_options: ownerDirected ? [] : [...pack.correspondence.languages]
    };
  } catch {
    return {
      ok: false, reason: 'delivery_contract_unavailable',
      requested_language: action.language || null, actual_language: null,
      source: null, fallback_basis: null, locale: null, direction: null,
      fallback_options: []
    };
  }
};

export const holdCopyFor = (action) => {
  if (action.payload?.recurrence_refusal) return BLOCKED_RECURRENCE_COPY.explanation;
  if (action.invoice_admission_refusal) return HOLD_REASON_COPY[action.invoice_admission_refusal];
  const language = ownerActionLanguageFor(action);
  if (language.reason && HOLD_REASON_COPY[language.reason]) return HOLD_REASON_COPY[language.reason];
  const held = action.gate_basis?.held_at_send || action.gate_basis?.reasons || [];
  const reasons = Array.isArray(held) ? held : [];
  for (const reason of reasons) {
    if (HOLD_REASON_COPY[reason]) return HOLD_REASON_COPY[reason];
  }
  return HOLD_REASON_COPY.stage_below_auto;
};

export const describePendingAction = (action) => {
  if (action.payload?.recurrence_refusal) {
    return `Blocked next recurrence for ${action.party_name || 'the customer'} on ${action.payload.recurrence_refusal.next_issue_date}: invoice creation is unsupported`;
  }
  const step = Number(action.cadence_step) || 1;
  const amount = action.amount != null && action.currency
    ? ` — ${action.payload?.render_values?.amount_due || action.payload?.render_values?.invoice_total || action.payload?.render_values?.quote_total || action.amount} ${action.currency}` : '';
  const invoice = action.payload?.render_values?.invoice_number
    ? ` for invoice ${action.payload.render_values.invoice_number}` : '';
  const who = action.party_name || 'the customer';
  if (action.action_type === 'send_receivable_reminder') {
    return `Payment reminder (step ${step}) to ${who}${invoice}${amount}`;
  }
  // M2 issuance holds: approving these IS the confirm step (the FI "kyllä").
  if (action.action_type === 'issue_invoice') {
    const number = action.payload?.render_values?.invoice_number;
    return `Issue invoice${number ? ` ${number}` : ''} to ${who}${amount}`;
  }
  if (action.action_type === 'send_quote') {
    const number = action.payload?.render_values?.quote_number;
    return step > 1
      ? `Quote follow-up (step ${step - 1}) to ${who}${number ? ` on quote ${number}` : ''}${amount}`
      : `Send quote${number ? ` ${number}` : ''} to ${who}${amount}`;
  }
  // M4: owner-directed — the notice goes to YOU about this supplier's bill.
  if (action.action_type === 'send_payable_notice') {
    return `Bill-due notice to you: ${who}'s bill${amount}${action.payload?.render_values?.due_date ? ` due ${action.payload.render_values.due_date}` : ''}`;
  }
  return `${String(action.action_type).replace(/_/g, ' ')} to ${who}${invoice}${amount}`;
};

// reply_if_wrong v2 — the "about your reply" line (ONE phrasing home, reused
// by the workspace Actions tab). The copy names WHY Donna couldn't act, off
// the persisted classification verdict — never a re-inference.
export const describeOwnerReply = (reply) => {
  const when = reply.received_at || reply.created_at || null;
  const day = when ? String(when).slice(0, 10) : null;
  const prefix = `Your reply${day ? ` from ${day}` : ''}`;
  const classification = reply.classification || {};
  if (classification.error) {
    return `${prefix}: Donna couldn't process it — open your workspace to act on it.`;
  }
  if (classification.intent === 'send_was_wrong') {
    return `${prefix}: you said something Donna sent was wrong, but she couldn't tell which send you meant — open your workspace to mark it.`;
  }
  return `${prefix}: Donna read it but can't act on it over email yet — open your workspace to sort it out.`;
};

// Owner-surface labels for the earned-auto FYI lines (per action type).
export const ACTION_TYPE_LABELS = Object.freeze({
  send_receivable_reminder: 'Payment reminders',
  issue_invoice: 'Invoice sending',
  send_quote: 'Quote sending',
  send_payable_notice: 'Bill-due notices'
});

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Render the digest as { subject, text, html }. Fails soft on a missing base
// URL: the digest still renders, with the links replaced by an instruction —
// the owner surface must not go dark because a deployment knob is unset.
// clientId (optional) adds the G15/D12 workspace deep link — the Actions tab
// renders the same persisted state, so the digest can hand off to it; the
// one-tap approve links stay unchanged either way.
export const renderOwnerDigestEmail = ({ digest, baseUrl, clientName, clientId = null }) => {
  const autoSent = digest.autoSent || [];
  const earned = digest.earned || [];
  const ownerReplies = digest.ownerReplies || [];
  const total = digest.pending.length + digest.failed.length + digest.stale.length
    + digest.escalated.length + digest.needsInput.length + ownerReplies.length;
  // Decide-and-notify honesty in the subject line: a digest that is ONLY
  // courtesy FYIs must not claim anything "needs your attention".
  const subject = total > 0
    ? `Donna: ${total} item${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} your attention${clientName ? ` — ${clientName}` : ''}`
    : `Donna: sent ${autoSent.length ? `${autoSent.length} item${autoSent.length === 1 ? '' : 's'}` : 'an update'} — reply if anything looks wrong${clientName ? ` — ${clientName}` : ''}`;

  const textLines = [];
  const htmlLines = [];
  const pushBoth = (text, html = null) => {
    textLines.push(text);
    htmlLines.push(html ?? `${escapeHtml(text)}<br />`);
  };

  pushBoth(`Here's where things stand${clientName ? ` for ${clientName}` : ''}:`, undefined);
  pushBoth('');

  const pending = digest.pending.filter((action) => !action.payload?.recurrence_refusal && !action.invoice_admission_refusal);
  const blockedInvoices = digest.pending.filter((action) => action.invoice_admission_refusal);
  const blockedRecurrences = digest.pending.filter((action) => action.payload?.recurrence_refusal);
  if (blockedRecurrences.length) {
    pushBoth(`${BLOCKED_RECURRENCE_COPY.heading} (${blockedRecurrences.length})`);
    for (const action of blockedRecurrences) {
      pushBoth(`${describePendingAction(action)}. ${holdCopyFor(action)}`);
      const decline = buildOutboundApprovalUrl(baseUrl, action.approval_token, 'decline');
      if (decline) pushBoth(`${BLOCKED_RECURRENCE_COPY.stop}: ${decline}`,
        `<a href="${decline}">${BLOCKED_RECURRENCE_COPY.stop}</a><br />`);
      else pushBoth('Open your workspace to stop this blocked recurrence.');
    }
    pushBoth('');
  }
  if (blockedInvoices.length) {
    pushBoth(`Blocked invoices (${blockedInvoices.length})`);
    for (const action of blockedInvoices) {
      pushBoth(`${describePendingAction(action)}. ${holdCopyFor(action)}`);
      const decline = buildOutboundApprovalUrl(baseUrl, action.approval_token, 'decline');
      if (decline) pushBoth(`Don't send: ${decline}`, `<a href="${decline}">Don't send</a><br />`);
      else pushBoth('Open your workspace to close this blocked invoice.');
    }
    pushBoth('');
  }
  if (pending.length) {
    pushBoth(`NEEDS YOUR APPROVAL (${pending.length})`, `<h3>Needs your approval (${pending.length})</h3>`);
    pending.forEach((action, i) => {
      const line = `${i + 1}. ${describePendingAction(action)} — ${holdCopyFor(action)}.`;
      const approve = buildOutboundApprovalUrl(baseUrl, action.approval_token, 'approve');
      const decline = buildOutboundApprovalUrl(baseUrl, action.approval_token, 'decline');
      const languageBlocked = ownerActionLanguageFor(action).reason === 'requested_language_unavailable';
      pushBoth(line);
      if (!languageBlocked && approve && decline) {
        pushBoth(`   Approve: ${approve}`, `&nbsp;&nbsp;<a href="${approve}">Approve</a> · <a href="${decline}">Don't send</a><br />`);
        textLines.push(`   Don't send: ${decline}`);
      } else if (languageBlocked && decline) {
        pushBoth(`   Choose a fallback in your workspace, or don't send: ${decline}`,
          `&nbsp;&nbsp;Choose a fallback in your workspace · <a href="${decline}">Don't send</a><br />`);
      } else {
        pushBoth('   (Approve links unavailable — open your workspace or reply to act.)');
      }
    });
    pushBoth('');
  }

  const mustReview = digest.failed.length + digest.stale.length + digest.escalated.length;
  if (mustReview) {
    pushBoth(`MUST REVIEW (${mustReview})`, `<h3>Must review (${mustReview})</h3>`);
    for (const action of digest.failed) {
      pushBoth(`- ${describePendingAction(action)} FAILED to send (${action.send_error || 'provider error'}). Donna will not retry on her own — reply to retry or drop it.`);
    }
    for (const action of digest.stale) {
      pushBoth(`- A send to ${action.party_name || 'a customer'} started but never finished. It MAY have gone out, so Donna will not re-send it automatically — reply and she'll help you check.`);
    }
    for (const caseRow of digest.escalated) {
      pushBoth(`- Invoice ${caseRow.invoice_number || caseRow.anchor_id}: ${caseRow.current_step} reminder${caseRow.current_step === 1 ? '' : 's'} sent, still unpaid — the cadence is done. Your call now: phone them, extend terms, or write it off; reply and Donna will record it.`);
    }
    pushBoth('');
  }

  if (digest.needsInput.length) {
    pushBoth(`NEEDS INFO (${digest.needsInput.length})`, `<h3>Needs info (${digest.needsInput.length})</h3>`);
    for (const caseRow of digest.needsInput) {
      const gaps = String(caseRow.status_reason || '').split(',')
        .map((g) => GAP_COPY[g.trim()] || g.trim()).filter(Boolean).join('; ');
      pushBoth(`- Invoice ${caseRow.invoice_number || caseRow.anchor_id}${caseRow.amount ? ` (${caseRow.amount} ${caseRow.currency || ''})` : ''}: ${gaps}.`);
    }
    pushBoth('');
  }

  // reply_if_wrong v2: replies Donna read but could not act on — each rests
  // ON THE OWNER with the workspace as the named next step, notified once.
  if (ownerReplies.length) {
    pushBoth(`ABOUT YOUR REPLIES (${ownerReplies.length})`, `<h3>About your replies (${ownerReplies.length})</h3>`);
    for (const reply of ownerReplies) {
      pushBoth(`- ${describeOwnerReply(reply)}`);
    }
    pushBoth('');
  }

  // D1 decide-and-notify: the "approve these" → "sent these" copy flip. A
  // courtesy FYI — no links, no taps, nothing to click through.
  if (autoSent.length) {
    pushBoth(`SENT FOR YOU (${autoSent.length})`, `<h3>Sent for you (${autoSent.length})</h3>`);
    pushBoth('Donna sent these under your earned auto-approval — no action needed; reply if anything looks wrong:');
    for (const action of autoSent) {
      pushBoth(`- ${describePendingAction(action)}.`);
    }
    pushBoth('');
  }

  if (earned.length) {
    pushBoth('FYI', '<h3>FYI</h3>');
    for (const row of earned) {
      const label = ACTION_TYPE_LABELS[row.action_type] || String(row.action_type).replace(/_/g, ' ');
      pushBoth(`- ${label}: ${row.clean_streak} in a row approved with no corrections — automatic sending is earned and awaiting final approval. Nothing for you to do; Donna keeps asking until it switches on.`);
    }
    pushBoth('');
  }

  const workspaceUrl = buildOwnerWorkspaceUrl(baseUrl, clientId);
  if (workspaceUrl) {
    pushBoth(`See everything (and edit drafts) in your workspace: ${workspaceUrl}`,
      `<a href="${workspaceUrl}">See everything (and edit drafts) in your workspace</a><br />`);
  }
  pushBoth('Reply to this email and Donna will take it from there.');
  return {
    subject,
    text: textLines.join('\n'),
    html: htmlLines.join('\n')
  };
};

// The per-client digest step the daily cron runs. Returns stats; never sends
// when the pipeline is dark, the digest is empty, unchanged-and-fresh, or the
// owner has no email on file (that last one is audited — a digest that cannot
// reach its owner is itself a must-surface gap, not a silent skip).
export const sendOwnerDigestForClient = async ({
  client, firmId, clientId, env = process.env, now = Date.now(),
  deliverEmail, logger = console
} = {}) => {
  if (!client || !firmId || !clientId || typeof deliverEmail !== 'function') {
    return { skipped: true, reason: 'missing_args' };
  }
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const anyActs = OUTBOUND_ACTION_TYPES.some(
    (actionType) => outboundGateMode({ actionType, snapshot, env }).mode === 'act'
  );
  if (!anyActs) return { skipped: true, reason: 'pipeline_dark' };

  const digest = await gatherOwnerDigest(client, { firmId, clientId });
  if (isOwnerDigestEmpty(digest)) return { skipped: true, reason: 'nothing_pending' };

  const contentHash = digestContentHash(digest);
  const last = await client.query(
    `select content_hash, sent_at from outbound_digests
      where firm_id = $1 and client_id = $2
      order by sent_at desc limit 1`,
    [firmId, clientId]
  ).then((r) => r.rows[0] || null).catch((error) => {
    if (missingTables(error)) return null;
    throw error;
  });
  // An unchanged digest is not re-sent — UNLESS a new auto-send needs its
  // courtesy FYI (decide-and-notify: every notified send reaches the owner
  // exactly once; autoSent is already filtered to never-notified ids) or an
  // un-notified needs-owner reply is waiting (same notified-once mechanics).
  if (last && last.content_hash === contentHash
    && now - Date.parse(last.sent_at) < RESURFACE_MS
    && !(digest.autoSent || []).length
    && !(digest.ownerReplies || []).length) {
    return { skipped: true, reason: 'unchanged' };
  }

  const clientRow = await client.query(
    'select company_name, profile from clients where firm_id = $1 and id = $2',
    [firmId, clientId]
  ).then((r) => r.rows[0] || null);
  const ownerEmail = resolveOwnerReplyTo(clientRow?.profile);
  if (!ownerEmail) {
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'outbound_digest.no_owner_email', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ pending: digest.pending.length })]
      );
    } catch { /* best-effort */ }
    return { skipped: true, reason: 'no_owner_email' };
  }

  const rendered = renderOwnerDigestEmail({
    digest, baseUrl: outboundPublicBaseUrl(env),
    clientName: clientRow?.company_name || null, clientId
  });
  // reply_if_wrong v2: when the reply-ingestion lane at least observes for
  // this client AND the inbound-capable address is deployed, "reply to this
  // email" points at the ingestion webhook instead of the monitored-mailbox
  // default. Null keeps today's routing untouched (additive, never
  // subtractive).
  const replyTo = resolveOwnerDigestReplyTo({ snapshot, env });
  let providerMessageId = null;
  try {
    const result = await deliverEmail({
      to: ownerEmail, subject: rendered.subject, text: rendered.text, html: rendered.html,
      ...(replyTo ? { replyTo } : {})
    });
    providerMessageId = result?.providerMessageId || result?.id || null;
  } catch (error) {
    logger.warn?.(`[ownerDigest] delivery failed for client ${clientId}: ${error?.message || error}`);
    return { skipped: true, reason: 'delivery_failed', error: error?.message || String(error) };
  }

  const digestId = randomUUID();
  await client.query(
    `insert into outbound_digests
       (id, firm_id, client_id, channel, recipient, content_hash,
        pending_count, must_review_count, needs_input_count, provider_message_id, payload)
     values ($1, $2, $3, 'email', $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [digestId, firmId, clientId, ownerEmail, contentHash,
      digest.pending.length,
      digest.failed.length + digest.stale.length + digest.escalated.length,
      digest.needsInput.length,
      providerMessageId,
      JSON.stringify({
        pending_ids: digest.pending.map((a) => a.id),
        failed_ids: digest.failed.map((a) => a.id),
        stale_ids: digest.stale.map((a) => a.id),
        escalated_case_ids: digest.escalated.map((c) => c.id),
        needs_input_case_ids: digest.needsInput.map((c) => c.id),
        // The decide-and-notify ledger: ids FYI'd in THIS digest — the gather
        // excludes them from every later digest (notified exactly once).
        notified_ids: (digest.autoSent || []).map((a) => a.id),
        earned_ids: (digest.earned || []).map((r) => r.id),
        owner_reply_ids: (digest.ownerReplies || []).map((r) => r.id)
      })]
  );
  // The replies' own notified-once stamp (their ledger is the row, not the
  // digest payload): stamped only after the digest actually went out.
  if ((digest.ownerReplies || []).length) {
    await client.query(
      `update outbound_owner_replies
          set owner_notified_at = now(), updated_at = now()
        where firm_id = $1 and client_id = $2 and id = any($3::text[])
          and owner_notified_at is null`,
      [firmId, clientId, digest.ownerReplies.map((r) => r.id)]
    ).catch((error) => {
      if (!missingTables(error)) throw error;
    });
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', 'outbound_digest.sent', 'outbound_digest', $3, $4::jsonb)`,
    [firmId, clientId, digestId, JSON.stringify({
      pending: digest.pending.length,
      must_review: digest.failed.length + digest.stale.length + digest.escalated.length,
      needs_input: digest.needsInput.length,
      provider_message_id: providerMessageId
    })]
  );
  return {
    skipped: false, sent: true, digestId,
    pending: digest.pending.length,
    must_review: digest.failed.length + digest.stale.length + digest.escalated.length,
    needs_input: digest.needsInput.length
  };
};
