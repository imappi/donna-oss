// Reply-triage sweep (M4) — orchestration coverage with injected impls (no
// pg, no OpenAI, no Resend): verdict-first persistence, the Keep layer's
// action execution + receipts, the failure postures (triage failure leaves
// the message untriaged; drafter failure is recorded ON the verdict), the
// kill switch, and the quiet-sweep/no-receipt invariant.

import assert from 'node:assert/strict';
import test from 'node:test';

import { UNSUBSCRIBE_PLACEHOLDER } from './marketingOutbound.js';
import { runReplyTriageSweep } from './replyTriageSweep.js';

const MESSAGE = {
  id: 'm1',
  from_email: 'owner@example.com',
  subject: 'Interested',
  text_body: 'Tell me more.',
  classification: 'reply',
  matched_lead_email: null,
  matched_prospect_id: null
};

const CLEAN_DRAFT = {
  subject: 'Re: Interested',
  body: `Happy to explain. No more emails? ${UNSUBSCRIBE_PLACEHOLDER}`,
  model: 'gpt-5.4-2026-06-01'
};

const harness = ({ verdict, message = MESSAGE, draft = CLEAN_DRAFT, overrides = {} } = {}) => {
  const calls = { verdicts: [], handled: [], drafts: [], suppressions: [], snoozes: [], runs: [] };
  const impls = {
    env: {},
    getOpenAiConfigImpl: () => ({ apiKey: 'k', model: 'gpt-5.4' }),
    listUntriagedInboundImpl: async () => [message],
    getInboundMessageByIdImpl: async () => message,
    getWaitlistLeadImpl: async () => null,
    getProspectImpl: async () => null,
    triageInboundMessageImpl: async () => ({ verdict, model: 'gpt-5.4-2026-06-01' }),
    insertTriageVerdictImpl: async (row) => {
      calls.verdicts.push(row);
      return { id: 't1', ...row };
    },
    recordTriageHandlingImpl: async (row) => {
      calls.handled.push(row);
    },
    draftInboundReplyImpl: async () => draft,
    insertDraftImpl: async (row) => {
      calls.drafts.push(row);
      return { ok: true, draft: { id: 'd1', ...row } };
    },
    addSuppressionImpl: async (row) => {
      calls.suppressions.push(row);
      return { ok: true };
    },
    snoozeProspectImpl: async (row) => {
      calls.snoozes.push(row);
      return { id: row.prospectId, next_action_at: '2026-08-23T00:00:00Z' };
    },
    startSourceRunImpl: async (row) => {
      calls.runs.push(row);
      return { id: 'run1' };
    },
    finishSourceRunImpl: async (row) => {
      calls.runs.push({ finished: row });
    },
    ...overrides
  };
  return { calls, impls };
};

const QUESTION_VERDICT = {
  semantic_class: 'question',
  confidence: 'high',
  summary: 'Wants to know more.',
  recommended_action: 'draft_reply',
  suggested_snooze_days: null,
  referred_contact: null
};

test('happy path: verdict persists FIRST, draft mints proposed on channel reply, receipt records it', async () => {
  const { calls, impls } = harness({ verdict: QUESTION_VERDICT });
  const summary = await runReplyTriageSweep(impls);
  assert.equal(summary.triaged, 1);
  assert.equal(summary.drafts_minted, 1);
  assert.equal(summary.receipt_run_id, 'run1');
  assert.deepEqual(summary.errors, []);
  // Verdict carries the provider-returned model id (the receipt).
  assert.equal(calls.verdicts[0].model, 'gpt-5.4-2026-06-01');
  // The draft is a channel-'reply' mint linked to its inbound message.
  assert.equal(calls.drafts[0].channel, 'reply');
  assert.equal(calls.drafts[0].inboundMessageId, 'm1');
  assert.equal(calls.drafts[0].segment, 'question');
  // The handling receipt links the draft on the verdict row.
  assert.equal(calls.handled[0].draftId, 'd1');
  assert.deepEqual(calls.handled[0].appliedActions, [{ action: 'mint_draft', draft_id: 'd1' }]);
  // The run receipt uses the reply_triage source.
  assert.equal(calls.runs[0].source, 'reply_triage');
});

test('escalate-only verdict: persisted + counted, NO draft, no actions', async () => {
  const { calls, impls } = harness({
    verdict: { ...QUESTION_VERDICT, semantic_class: 'investor_or_press', recommended_action: 'escalate_to_kari' }
  });
  const summary = await runReplyTriageSweep(impls);
  assert.equal(summary.triaged, 1);
  assert.equal(summary.escalations, 1);
  assert.equal(summary.drafts_minted, 0);
  assert.equal(calls.drafts.length, 0);
  assert.deepEqual(calls.handled[0].appliedActions, []);
});

test('a rail-violating draft is refused at the mint and recorded on the verdict, never minted', async () => {
  const { calls, impls } = harness({
    verdict: QUESTION_VERDICT,
    draft: { subject: 'Re: Interested', body: 'We guarantee perfect books. No opt-out.', model: 'm' }
  });
  const summary = await runReplyTriageSweep(impls);
  assert.equal(summary.triaged, 1);
  assert.equal(summary.drafts_minted, 0);
  assert.equal(summary.draft_refusals, 1);
  assert.equal(calls.drafts.length, 0);
  assert.match(calls.handled[0].error, /draft refused/);
});

test('a triage failure leaves the message untriaged (no verdict row) and is reported', async () => {
  const { calls, impls } = harness({
    verdict: QUESTION_VERDICT,
    overrides: {
      triageInboundMessageImpl: async () => {
        throw new Error('provider down');
      }
    }
  });
  const summary = await runReplyTriageSweep(impls);
  assert.equal(summary.triaged, 0);
  assert.equal(calls.verdicts.length, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].message, /provider down/);
});

test('not_now on a matched prospect snoozes it and still mints the ack draft', async () => {
  const { calls, impls } = harness({
    verdict: { ...QUESTION_VERDICT, semantic_class: 'not_now', suggested_snooze_days: 45 },
    message: { ...MESSAGE, matched_prospect_id: 'p1' },
    overrides: {
      getProspectImpl: async () => ({ id: 'p1', company_name: 'Acme', jurisdiction: 'US', status: 'contacted_awaiting_reply' })
    }
  });
  const summary = await runReplyTriageSweep(impls);
  assert.equal(summary.snoozed, 1);
  assert.equal(summary.drafts_minted, 1);
  assert.equal(calls.snoozes[0].days, 45);
  assert.equal(calls.drafts[0].prospectId, 'p1');
});

test('a suppress verdict goes through the sanctioned writer and nothing else happens', async () => {
  const { calls, impls } = harness({
    verdict: { ...QUESTION_VERDICT, semantic_class: 'other', recommended_action: 'suppress' }
  });
  const summary = await runReplyTriageSweep(impls);
  assert.equal(summary.suppressed, 1);
  assert.equal(summary.drafts_minted, 0);
  assert.deepEqual(calls.suppressions[0], { email: 'owner@example.com', reason: 'unsubscribed', source: 'reply_triage' });
});

test('kill switch, missing provider key, and an empty queue all return quietly — no receipt', async () => {
  const killed = await runReplyTriageSweep(harness({ verdict: QUESTION_VERDICT, overrides: { env: { MARKETING_TRIAGE_FORCE_DISABLE: '1' } } }).impls);
  assert.equal(killed.disabled, true);

  const keyless = harness({ verdict: QUESTION_VERDICT, overrides: { getOpenAiConfigImpl: () => ({ apiKey: '', model: 'x' }) } });
  const noProvider = await runReplyTriageSweep(keyless.impls);
  assert.equal(noProvider.skipped_no_provider, true);
  assert.equal(keyless.calls.runs.length, 0);

  const empty = harness({ verdict: QUESTION_VERDICT, overrides: { listUntriagedInboundImpl: async () => [] } });
  const quiet = await runReplyTriageSweep(empty.impls);
  assert.equal(quiet.considered, 0);
  assert.equal(empty.calls.runs.length, 0, 'a quiet sweep leaves no receipt');
});

test('a forced message_id re-triages one message, attributed to the manual actor', async () => {
  const { calls, impls } = harness({ verdict: QUESTION_VERDICT });
  const summary = await runReplyTriageSweep({ ...impls, messageId: 'm1' });
  assert.equal(summary.triaged, 1);
  assert.equal(calls.runs[0].startedBy, 'staff:manual_triage');
  assert.equal(calls.runs[0].params.forced_message_id, 'm1');
});
