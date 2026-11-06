// SG-3 slice P — the GST F5 filing owner route: the messaging confirm/cancel
// state machine around a persisted gst_returns draft. Mirrors
// finland/alvReturnRoute.js 1:1: PURE + I/O-injectable (tests run without DB,
// Telegram/WhatsApp, or a filing channel). Compute-and-file — the owner's "yes"
// IS the filing authority (a scoped, audited grant, never a bare thumbs-up),
// and the transmit channel behind it is the injected IRAS adapter.
//
// Channel note: SG is English-first and Telegram/WhatsApp are the live
// channels (the handoff's "channel is already solved" call) — the route is
// channel-agnostic through the same processAnchoredInboundMessage seam; the
// provider stamps into the authority basis from the message context.
//
// Deliberately NO correction flow: a wrong return is not correctable by prose —
// the owner answers "no", the books get fixed (recode / evidence), and the lane
// re-runs a fresh compute. Only yes / no / nudge exist here.

import { transmitGstReturnFiling } from './gstReturnTransmit.js';
import { CORPPASS_SCOPE_GST } from './corpPassMandate.js';

export const GST_RETURN_ASK_KIND = 'gst_return';

const clean = (value) => String(value || '').trim();
const lower = (value) => clean(value).toLowerCase();

export const isGstReturnAsk = (ask = {}) => {
  ask = ask || {};
  const payload = ask.request_payload || ask.payload || {};
  return Boolean(ask.kind === GST_RETURN_ASK_KIND
    || ask.evidence_type === GST_RETURN_ASK_KIND
    || payload.kind === GST_RETURN_ASK_KIND
    || payload.gst_return);
};

// Conservative explicit yes/no. Anything else is NEVER a filing and NEVER a
// cancel (two-terminal-states: the ask stays open, on the owner).
const isAffirmative = (text) => /^(yes|y|yup|yeah|ok|okay|confirm|confirmed|file it|proceed)$/iu.test(lower(text));
const isNegative = (text) => /^(no|n|nope|cancel|stop|don'?t|hold)$/iu.test(lower(text));

export const buildGstFilingAuthorityBasis = ({ message = {}, phoneHash = null, provider = 'messaging' } = {}) => ({
  source: 'owner_messaging_gst_filing_confirmation',
  provider: provider || 'messaging',
  providerMessageId: message.id || message.message_id || null,
  sentAt: message.timestamp || message.sent_at || message.received_at || null,
  phoneHash: phoneHash || null
});

const sgd = (n) => `S$${(Number(n) || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The confirm summary renders the PERSISTED verdict (render-the-persisted-
// verdict) — the same boxes the filing will transmit, never a re-compute.
export const summarizeGstF5Verdict = ({ periodKey = '', verdict = {} } = {}) => {
  const gstReturn = verdict.gstReturn || {};
  const out = [`GST F5 return, accounting period ${periodKey}`];
  if (gstReturn.nilReturn) out.push('No GST activity in the period — nil return.');
  else if (gstReturn.refund) out.push(`Net GST claimable from IRAS: ${sgd(Math.abs(gstReturn.payable))}.`);
  else out.push(`Net GST payable to IRAS: ${sgd(gstReturn.payable)}.`);
  const boxes = gstReturn.boxes || {};
  if (!gstReturn.nilReturn) {
    out.push(`Output tax ${sgd(boxes['6'])} · Input tax claimed ${sgd(boxes['7'])}.`);
  }
  return out.join('\n');
};

const CONFIRM_INSTRUCTION = 'Reply "yes" to confirm and I\'ll file the F5 with IRAS. Reply "no" to cancel.';
const NUDGE_CONFIRM = 'Reply "yes" and I\'ll file the GST F5 with IRAS, or "no" and I\'ll cancel it.';
const FILE_FAILED_TEXT = 'The GST F5 filing didn\'t go through. Reply "yes" to retry, or "no" to cancel the return.';
// The CorpPass authorization is the one filing precondition only the OWNER can
// fix — assigning the filer access to the IRAS GST e-Service happens in
// CorpPass, not in Donna. The ask stays open; the next "yes" retries after the
// grant.
const CORPPASS_MISSING_TEXT = 'I can\'t file the GST F5 yet: the CorpPass authorization for IRAS GST e-Services is missing or not in force. Grant it in CorpPass (assign the GST digital service), then reply "yes" again and I\'ll file.';

export const gstReturnConfirmQuestion = ({ periodKey, verdict }) =>
  `${summarizeGstF5Verdict({ periodKey, verdict })}\n\n${CONFIRM_INSTRUCTION}`;

// The owner-facing reason for EVERY blocker the calculator can raise — a
// needs_review return escalates to the owner (terminal 2), so each blocker must
// carry an answerable question, never just "isn't ready". Counts come from the
// persisted review; an unknown future blocker still yields a non-empty generic
// line rather than a silent omission.
const GST_BLOCKER_QUESTIONS = {
  uncoded_revenue_lines: (review) => `${review.uncodedRevenueLines?.length || 0} income line(s) have no GST treatment — tell me what these sales were.`,
  incompatible_tax_lines: (review) => `${review.incompatibleLines?.length || 0} entry(ies) carry a GST code that doesn't fit the account — I'll check them with you.`,
  reverse_charge_input_tax_assessment_required: (review) =>
    `${review.inputTaxAssessmentLines?.length || 0} purchase(s) are imports or reverse-charge services whose GST you can only claim back in part or at the permit amount — send me the import permit (or the supplier's details and how the service is used) so I can work out what you can claim.`,
  gst_not_coded_at_posting: () =>
    'Your expenses were booked without a GST treatment, so the input tax to claim can\'t be worked out — tell me which purchases had GST on them (supplier invoices with the GST shown).',
  control_account_mismatch: (review) =>
    `The GST I recorded when posting (${review.controlCheck?.outputTax?.actual ?? '?'} output tax) doesn't agree with what the return computes (${review.controlCheck?.outputTax?.expected ?? '?'}) — I'll go through the entries with you to find which one is wrong.`,
  negative_return_box: (review) =>
    `Credit notes or adjustments made box ${(review.negativeBoxes || []).join(', ')} negative for the period — tell me which credit notes or refunds these were and which sale or purchase they relate to.`
};

export const gstReviewQuestion = (computed = {}) => {
  const review = computed.review || {};
  const reasons = (review.blockers || [])
    .map((blocker) => GST_BLOCKER_QUESTIONS[blocker]?.(review) || `Something in this return needs your input (${blocker}).`);
  return [`The GST F5 for ${computed.period?.key} isn't ready to file yet.`, ...reasons].join(' ');
};

// The ask payload is the ONLY conversation state source; the gst_returns row is
// the ONLY verdict source. Flat state under payload.gst_return (the FI-6 lesson).
const stateFromAsk = ({ ask }) => {
  const payload = ask?.request_payload || ask?.payload || {};
  const raw = payload.gst_return || {};
  return raw.state && typeof raw.state === 'object' ? { kind: raw.kind, ...raw.state } : raw;
};

// fileConfirmedGstReturn — the filing motion: transmit (re-footed, refused
// without authority/CorpPass/channel) → mark filed with the receipt (audit-as-
// precondition, in-txn). The channel must be idempotent per period — the
// persisted row flips only after a successful transmit, so a crash between the
// two legs retries the transmit on the next "yes".
export const fileConfirmedGstReturn = async ({
  firmId,
  clientId,
  row,
  authorityBasis,
  actorId,
  mandate = null,
  transmitImpl = transmitGstReturnFiling,
  submitReturn,
  markFiledImpl
} = {}) => {
  const { receipt } = await transmitImpl({
    verdict: row.verdict,
    period: { key: row.period_key, type: row.period_type, starts_on: row.starts_on, ends_on: row.ends_on },
    authorityBasis,
    actorId,
    model: row.model || null,
    mandate,
    submitReturn
  });
  const filed = await markFiledImpl({
    firmId,
    clientId,
    gstReturnId: row.id,
    filingReceipt: receipt,
    authorityBasis,
    actorId
  });
  return { gstReturn: filed, receipt };
};

// resolveGstReturnInbound — anchored replies to a gst_return confirm ask.
// Every terminal transition resolves the ANSWERED ask (two-terminal-states:
// each pending row keeps exactly ONE open ask); a nudge or a failed filing leg
// leaves the ask open — still on the owner, the next "yes" retries.
export const resolveGstReturnInbound = async ({
  firmId,
  clientId,
  ask = {},
  replyText = '',
  message = {},
  phoneHash = null,
  provider = 'messaging',
  actorId = null,
  flagActs = true,
  getGstReturnImpl,
  getMandateImpl,
  markFiledImpl,
  cancelImpl,
  fileImpl = fileConfirmedGstReturn,
  transmitImpl,
  submitReturn,
  resolveAsk,
  sendText
} = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };

  const state = stateFromAsk({ ask });
  const text = clean(replyText);

  const closeAnsweredAsk = async (resolutionNote) => {
    if (typeof resolveAsk === 'function' && ask?.id) {
      await resolveAsk({ firmId, askId: ask.id, resolutionNote, actorId });
    }
  };

  const row = state.gst_return_id && typeof getGstReturnImpl === 'function'
    ? await getGstReturnImpl({ firmId, clientId, gstReturnId: state.gst_return_id })
    : null;
  if (!row || row.status !== 'draft_pending_confirmation') {
    // The row already reached a terminal (filed/cancelled) — the ask is stale.
    await closeAnsweredAsk('gst_return_stale_ask');
    if (typeof sendText === 'function') await sendText({ text: 'This GST return has already been handled.' });
    return { action: 'stale', gstReturnId: state.gst_return_id || null };
  }

  if (isAffirmative(text)) {
    const authorityBasis = buildGstFilingAuthorityBasis({ message, phoneHash, provider });
    if (!authorityBasis.providerMessageId || !authorityBasis.phoneHash || !actorId) {
      throw Object.assign(
        new Error('GST filing confirmation requires provider message id, phone hash, and owner actor id.'),
        { code: 'GST_FILING_AUTHORITY_REQUIRED' }
      );
    }
    // Resolve the client's CorpPass authorization (iras_gst) for the transmit
    // gate. Fail-closed: no lookup wired ⇒ no mandate ⇒ the transmit refuses
    // typed — a statutory filing never rides an unverified authorization.
    const mandate = typeof getMandateImpl === 'function'
      ? await getMandateImpl({ firmId, clientId, scope: CORPPASS_SCOPE_GST })
      : null;
    let filed;
    try {
      filed = await fileImpl({
        firmId,
        clientId,
        row,
        authorityBasis,
        actorId,
        mandate,
        ...(transmitImpl ? { transmitImpl } : {}),
        submitReturn,
        markFiledImpl
      });
    } catch (error) {
      // Any failed leg leaves the row pending and the ask OPEN (still on the
      // owner) — the next "yes" retries against an idempotent channel. A
      // channel REJECTION carries its reason verbatim: the owner must see what
      // IRAS refused, not a paraphrase. A missing/invalid CorpPass grant gets
      // its own copy — granting it is an OWNER action, so the ask legitimately
      // rests on them.
      if (typeof sendText === 'function') {
        const reason = error?.code === 'SG_FILING_CORPPASS_REQUIRED'
          ? CORPPASS_MISSING_TEXT
          : (error?.code === 'GST_FILING_REJECTED' && error?.channelReason
            ? `IRAS did not accept the F5: ${error.channelReason}\n\n${FILE_FAILED_TEXT}`
            : FILE_FAILED_TEXT);
        await sendText({ text: reason });
      }
      return { action: 'file_failed', error: error?.code || error?.message || 'unknown', ask };
    }
    await closeAnsweredAsk('gst_return_filed');
    if (typeof sendText === 'function') {
      const payable = row.verdict?.gstReturn?.payable || 0;
      const parts = [`GST F5 (${row.period_key}) filed with IRAS.`];
      if (row.verdict?.gstReturn?.nilReturn) parts.push('Nil return.');
      else if (payable < 0) parts.push(`Refund expected: ${sgd(Math.abs(payable))}.`);
      else parts.push(`Amount payable: ${sgd(payable)} — payment via GIRO or myTax Portal by the due date.`);
      await sendText({ text: parts.join(' ') });
    }
    return { action: 'confirm_and_file', authorityBasis, actorId, ...filed };
  }

  if (isNegative(text)) {
    const authorityBasis = buildGstFilingAuthorityBasis({ message, phoneHash, provider });
    const cancelled = await cancelImpl({
      firmId, clientId, gstReturnId: row.id, reason: 'owner_declined', authorityBasis, actorId
    });
    await closeAnsweredAsk('gst_return_cancelled');
    if (typeof sendText === 'function') {
      await sendText({ text: `GST F5 (${row.period_key}) cancelled. I'll fix the books and recompute it.` });
    }
    return { action: 'cancelled', gstReturn: cancelled };
  }

  // Neither yes nor no: a statutory filing takes only an explicit answer.
  if (typeof sendText === 'function') await sendText({ text: NUDGE_CONFIRM });
  return { action: 'nudge', reason: 'ambiguous_confirmation', ask };
};
