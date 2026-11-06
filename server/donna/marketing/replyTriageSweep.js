// The reply-triage sweep — M4's orchestration: drain untriaged human inbound
// (M3's 'reply'/'unmatched' received rows) through the strong-model triage,
// persist the verdict (append-only, model id on the row), then let the
// deterministic Keep layer act: mint a PROPOSED response draft (per-send
// approval is the only send authority — nothing here sends), snooze a
// not_now prospect (capped), honor an opt-out via the sanctioned suppression
// writer. Every sweep that did work leaves a `reply_triage` source-run
// receipt; a quiet sweep (nothing untriaged) leaves nothing.
//
// Failure posture: a triage failure leaves the message UNTRIAGED (retried
// next sweep) and is reported in the summary + run receipt, never swallowed.
// A drafter failure after a persisted verdict is recorded ON the verdict row
// (error + no draft_id) — the verdict stands; Kari can re-run via the manual
// endpoint. Kill switch: MARKETING_TRIAGE_FORCE_DISABLE (env may KILL a
// behavior, never enable one). Batch knob: MARKETING_TRIAGE_BATCH_LIMIT.
//
// Injectable impls keep the tests pure (no pg, no OpenAI, no Resend).

import { validateDraftCopy } from './marketingOutbound.js';
import { addSuppression, insertDraft } from './marketingOutboundDb.js';
import { getProspect, finishSourceRun, startSourceRun } from './prospectLabDb.js';
import { decideTriageActions, ESCALATE_ONLY_CLASSES, TRIAGE_SOURCE } from './replyTriage.js';
import {
  getInboundMessageById,
  getWaitlistLead,
  insertTriageVerdict,
  listUntriagedInbound,
  recordTriageHandling,
  snoozeProspect
} from './replyTriageDb.js';
import { draftInboundReply, triageInboundMessage } from './replyDrafter.js';
import { getOpenAiConfig } from './openAiConfig.js';

const isDisabled = (env) => {
  const v = String(env.MARKETING_TRIAGE_FORCE_DISABLE || '').toLowerCase();
  return v === '1' || v === 'true';
};

export const runReplyTriageSweep = async ({
  now = new Date(),
  logger,
  env = process.env,
  limit = null,
  messageId = null, // manual endpoint: force one specific message (re-triage allowed)
  listUntriagedInboundImpl = listUntriagedInbound,
  getInboundMessageByIdImpl = getInboundMessageById,
  getWaitlistLeadImpl = getWaitlistLead,
  getProspectImpl = getProspect,
  triageInboundMessageImpl = triageInboundMessage,
  insertTriageVerdictImpl = insertTriageVerdict,
  recordTriageHandlingImpl = recordTriageHandling,
  draftInboundReplyImpl = draftInboundReply,
  insertDraftImpl = insertDraft,
  addSuppressionImpl = addSuppression,
  snoozeProspectImpl = snoozeProspect,
  startSourceRunImpl = startSourceRun,
  finishSourceRunImpl = finishSourceRun,
  getOpenAiConfigImpl = getOpenAiConfig
} = {}) => {
  const log = logger || console;
  const batchLimit = Number(limit || env.MARKETING_TRIAGE_BATCH_LIMIT || 10);
  const summary = {
    disabled: false,
    skipped_no_provider: false,
    considered: 0,
    triaged: 0,
    drafts_minted: 0,
    draft_refusals: 0,
    snoozed: 0,
    suppressed: 0,
    escalations: 0,
    receipt_run_id: null,
    errors: []
  };

  if (isDisabled(env)) {
    summary.disabled = true;
    return summary;
  }
  if (!getOpenAiConfigImpl().apiKey) {
    // A cron without a provider key must not 500 hourly forever — skip loudly.
    summary.skipped_no_provider = true;
    return summary;
  }

  let messages = [];
  try {
    if (messageId) {
      const one = await getInboundMessageByIdImpl(messageId);
      messages = one ? [one] : [];
    } else {
      messages = await listUntriagedInboundImpl({ limit: batchLimit });
    }
  } catch (err) {
    log.error?.('reply-triage: listing failed', { error: err?.message });
    summary.errors.push({ stage: 'list', message: err?.message || String(err) });
    return summary;
  }
  summary.considered = messages.length;
  if (messages.length === 0) return summary; // quiet sweep: no receipt

  let run;
  try {
    run = await startSourceRunImpl({
      source: TRIAGE_SOURCE,
      params: { considered: messages.length, forced_message_id: messageId || null },
      startedBy: messageId ? 'staff:manual_triage' : 'system:reply_triage'
    });
    summary.receipt_run_id = run.id;
  } catch (err) {
    summary.errors.push({ stage: 'receipt', message: err?.message || String(err) });
    return summary;
  }

  const signupUrl = String(env.MARKETING_PUBLIC_BASE_URL || '').trim() || null;

  for (const message of messages) {
    try {
      const [lead, prospect] = await Promise.all([
        message.matched_lead_email ? getWaitlistLeadImpl(message.matched_lead_email) : null,
        message.matched_prospect_id ? getProspectImpl(message.matched_prospect_id) : null
      ]);

      // 1) The strong model's verdict — persisted FIRST (the receipt), before
      //    any action (M3's insert→act→record pattern).
      const { verdict, model } = await triageInboundMessageImpl({ message, lead, prospect });
      const triageRow = await insertTriageVerdictImpl({
        inboundMessageId: message.id,
        verdict,
        model
      });
      summary.triaged += 1;
      if (ESCALATE_ONLY_CLASSES.includes(verdict.semantic_class)) summary.escalations += 1;

      // 2) The deterministic Keep layer decides what the verdict may cause.
      const plan = decideTriageActions({ verdict, message, prospectId: prospect?.id || null });
      const applied = [];
      let draftId = null;
      let handlingError = null;

      for (const action of plan) {
        try {
          if (action.action === 'suppress') {
            await addSuppressionImpl({ email: action.email, reason: action.reason, source: 'reply_triage' });
            applied.push(action);
            summary.suppressed += 1;
          } else if (action.action === 'snooze') {
            const snoozed = await snoozeProspectImpl({ prospectId: action.prospect_id, days: action.days, now });
            if (snoozed) {
              applied.push({ ...action, next_action_at: snoozed.next_action_at });
              summary.snoozed += 1;
            }
          } else if (action.action === 'mint_draft') {
            const draft = await draftInboundReplyImpl({ message, verdict, lead, prospect, signupUrl });
            const violations = validateDraftCopy(draft, { isReply: true });
            if (violations.length > 0) {
              summary.draft_refusals += 1;
              handlingError = `draft refused: ${violations.join('; ')}`;
              continue;
            }
            const minted = await insertDraftImpl({
              leadEmail: message.from_email,
              segment: verdict.semantic_class,
              channel: 'reply',
              subject: draft.subject,
              body: draft.body,
              model: draft.model,
              inboundMessageId: message.id,
              prospectId: prospect?.id || null
            });
            if (minted.ok) {
              draftId = minted.draft.id;
              applied.push({ action: 'mint_draft', draft_id: draftId });
              summary.drafts_minted += 1;
            } else {
              summary.draft_refusals += 1;
              handlingError = `draft refused: ${minted.refused}`;
            }
          }
        } catch (err) {
          handlingError = [handlingError, `${action.action}: ${err?.message || err}`].filter(Boolean).join('; ');
        }
      }

      await recordTriageHandlingImpl({ triageId: triageRow.id, appliedActions: applied, draftId, error: handlingError });
      if (handlingError) {
        summary.errors.push({ stage: 'handle', message_id: message.id, message: handlingError });
      }
    } catch (err) {
      // Verdict never persisted → the message stays untriaged and the next
      // sweep retries it. Reported, never swallowed.
      summary.errors.push({ stage: 'triage', message_id: message.id, message: err?.message || String(err) });
    }
  }

  try {
    await finishSourceRunImpl({
      runId: run.id,
      candidatesFound: summary.considered,
      prospectsMinted: 0,
      error: summary.errors.length > 0 ? summary.errors.map((e) => e.message).join(' | ').slice(0, 500) : null
    });
  } catch (err) {
    summary.errors.push({ stage: 'receipt_finish', message: err?.message || String(err) });
  }

  return summary;
};
