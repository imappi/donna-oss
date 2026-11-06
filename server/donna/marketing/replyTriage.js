// Reply triage — M4 of the closed-commercial-loop arc, RESCOPED 2026-07-24
// (Kari): reply triage + drafted responses; bookings are a non-goal (see
// design-donna-sales-marketing.md, M-arc dated calls). This module is the
// PURE half: vocabulary, the deterministic class→action Keep layer, prompt +
// schema builders, and reply-threading header assembly. No DB, no network.
//
// Doctrine split (trust-the-strong-LLM):
//   - The STRONG MODEL does the semantic work: what does this reply mean,
//     what should happen next, how should Donna answer. Its verdict persists
//     append-only on marketing_reply_triage with the provider-returned model
//     id (the receipt); surfaces render the persisted verdict, never re-infer.
//   - The KEEP LAYER here is deterministic refusal, not judgment: escalate-
//     only classes can NEVER mint a draft whatever the model recommends;
//     snoozes are clamped; suppression maps onto the sanctioned reason enum;
//     drafts pass validateDraftCopy and rest 'proposed' — per-send approval
//     is the only send authority (no stage writer exists; nothing auto-sends).

export const SEMANTIC_CLASSES = Object.freeze([
  'positive_interest', // wants to move forward → draft a reply toward signup
  'question', // asks something about Donna/pricing/fit → draft an answer
  'objection', // pushes back (price, trust, AI) → draft an honest response
  'referral', // points at someone else — surfaced, never auto-minted (v1 non-action)
  'not_now', // timing decline → brief ack draft + a capped snooze on the prospect
  'wrong_person', // not the right contact — recorded, surfaced
  'hostile_or_sensitive', // angry/legal/distressed — ESCALATE ONLY, never drafted
  'investor_or_press', // a different conversation — ESCALATE ONLY, Kari's voice not Donna's
  'other'
]);

export const TRIAGE_CONFIDENCES = Object.freeze(['low', 'medium', 'high']);

export const RECOMMENDED_TRIAGE_ACTIONS = Object.freeze([
  'draft_reply',
  'escalate_to_kari',
  'record_only',
  'suppress' // an opt-out phrased past M3's deterministic patterns
]);

// The Keep layer's allowlist: a draft can be minted ONLY when the class is
// here AND the model recommended draft_reply — both must agree.
export const DRAFTABLE_CLASSES = Object.freeze([
  'positive_interest',
  'question',
  'objection',
  'not_now'
]);

// These classes never produce a Donna draft, whatever the verdict recommends.
// M3 already forwarded the mail to Kari's inbox; the verdict flags it in the UI.
export const ESCALATE_ONLY_CLASSES = Object.freeze([
  'hostile_or_sensitive',
  'investor_or_press'
]);

export const SNOOZE_DAYS_MIN = 1;
export const SNOOZE_DAYS_MAX = 90;
export const SNOOZE_DAYS_DEFAULT = 30;

// Source tag for the sweep's marketing_source_run receipts (RUN_SOURCES in
// prospectLabDb.js includes it; mintProspect still validates against
// PROSPECT_SOURCES alone — a triage receipt can never mint a prospect).
export const TRIAGE_SOURCE = 'reply_triage';

export const clampSnoozeDays = (value) => {
  if (value == null || value === '') return SNOOZE_DAYS_DEFAULT;
  const days = Number(value);
  if (!Number.isFinite(days)) return SNOOZE_DAYS_DEFAULT;
  return Math.min(SNOOZE_DAYS_MAX, Math.max(SNOOZE_DAYS_MIN, Math.round(days)));
};

// ── The deterministic action plan ───────────────────────────────────────────
// Decide what the Keep layer will DO about a verdict. Pure: returns a plan of
// tagged actions; the sweep executes each through the sanctioned writers and
// receipts the outcome in applied_actions. Refusals here are structural —
// they hold even against a confused verdict.
export const decideTriageActions = ({ verdict = {}, message = {}, prospectId = null } = {}) => {
  const actions = [];
  const semanticClass = verdict.semantic_class;
  const fromEmail = String(message.from_email || '').trim().toLowerCase();

  if (!SEMANTIC_CLASSES.includes(semanticClass)) return actions;

  // Suppression: safe-direction (it only ever STOPS sends), so a model-
  // recommended opt-out is honored — through the sanctioned writer.
  if (verdict.recommended_action === 'suppress' && fromEmail) {
    actions.push({ action: 'suppress', email: fromEmail, reason: 'unsubscribed' });
    return actions; // an opt-out ends the conversation; nothing else happens
  }

  if (ESCALATE_ONLY_CLASSES.includes(semanticClass)) {
    // Structural refusal: no draft, whatever the verdict recommends. M3
    // already forwarded the mail; the verdict row is the flag.
    return actions;
  }

  if (
    DRAFTABLE_CLASSES.includes(semanticClass) &&
    verdict.recommended_action === 'draft_reply' &&
    fromEmail
  ) {
    actions.push({ action: 'mint_draft' });
  }

  if (semanticClass === 'not_now' && prospectId) {
    actions.push({
      action: 'snooze',
      prospect_id: prospectId,
      days: clampSnoozeDays(verdict.suggested_snooze_days)
    });
  }

  return actions;
};

// ── Reply threading (RFC 5322) ──────────────────────────────────────────────
// Build the headers that make our response a genuine reply in the recipient's
// thread, from the inbound row's STORED fields (M3 parsed them at ingestion).
export const buildReplyThreadingHeaders = (inboundMessage = {}) => {
  const messageId = String(inboundMessage.message_id || '').trim();
  if (!messageId) return {};
  const priorReferences = String(inboundMessage.references_header || '').trim();
  return {
    'In-Reply-To': messageId,
    References: priorReferences ? `${priorReferences} ${messageId}` : messageId
  };
};

// A genuine reply subject: "Re: <their subject>" (single Re:, no pile-up).
export const buildReplySubject = (inboundSubject = '') => {
  const base = String(inboundSubject || '')
    .replace(/^\s*((re|fwd?)\s*:\s*)+/i, '')
    .trim();
  return base ? `Re: ${base}` : 'Re: your note to Donna';
};

// ── Verdict shape validation (writer precondition) ──────────────────────────
// The provider's strict structured outputs should make violations impossible;
// this is the belt to that suspender — the DB writer refuses anything else.
export const validateTriageVerdict = (verdict = {}) => {
  const violations = [];
  if (!SEMANTIC_CLASSES.includes(verdict.semantic_class)) {
    violations.push(`unknown semantic_class: ${verdict.semantic_class}`);
  }
  if (!TRIAGE_CONFIDENCES.includes(verdict.confidence)) {
    violations.push(`unknown confidence: ${verdict.confidence}`);
  }
  if (!String(verdict.summary || '').trim()) {
    violations.push('summary is required');
  }
  if (!RECOMMENDED_TRIAGE_ACTIONS.includes(verdict.recommended_action)) {
    violations.push(`unknown recommended_action: ${verdict.recommended_action}`);
  }
  return violations;
};

// ── Prompt + schema builders (used by replyDrafter.js) ──────────────────────

const TRIAGE_BODY_CHARS = 6000;

export const buildTriageInstructions = () => [
  'You triage inbound email for Donna, a done-for-you AI bookkeeping service for small single-entity service businesses (US, UK, Singapore, Australia), run by a hands-on founder (Kari, Donna). Donna is 100% self-service: she runs the books herself, there is no human back office, and the conversion event is a self-serve signup — never a sales call.',
  '',
  'You are given one inbound email (sender, subject, body — the body may include quoted history below the reply) plus whatever we know about the sender (a waitlist lead, a live prospect, or nothing). Classify what THIS reply means and recommend what should happen next.',
  '',
  'The classes:',
  '- positive_interest: they want to move forward, learn more, or try Donna.',
  '- question: they ask something concrete (pricing, fit, how it works, security).',
  '- objection: they push back — price, trusting an AI with books, a bad past experience.',
  '- referral: they point at someone else who might fit.',
  '- not_now: a timing decline ("check back next quarter"). Suggest a snooze in days.',
  '- wrong_person: we reached someone who is not the right contact.',
  '- hostile_or_sensitive: anger, legal threats, distress, anything a human founder must read first.',
  '- investor_or_press: an investor, journalist, or partnership approach — a different conversation, in the founder\'s voice, not Donna\'s.',
  '- other: none of the above fits.',
  '',
  'Recommended actions:',
  '- draft_reply: Donna should draft a response (a human approves every send — nothing you recommend sends anything).',
  '- escalate_to_kari: the founder must handle this personally. ALWAYS use this for hostile_or_sensitive and investor_or_press.',
  '- record_only: no response warranted (e.g. wrong_person with nothing to act on).',
  '- suppress: they are asking to stop hearing from us, in any phrasing. When in doubt about an opt-out, choose suppress — stopping is always the safe direction.',
  '',
  'Rules:',
  '- Judge the NEW text at the top, not the quoted history below it.',
  '- The summary is 1-2 plain sentences: what they said and what they want. It is what the founder reads first — be specific, never generic.',
  '- referral: put the referred person/company into referred_contact verbatim (name and address only if THEY wrote it; never invent contact details).',
  '- not_now: put a sensible suggested_snooze_days (their stated timing if given, else 30).',
  '- Confidence is your honest read: low when the email is ambiguous or you are guessing.'
].join('\n');

export const buildTriageSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: [
    'semantic_class',
    'confidence',
    'summary',
    'recommended_action',
    'suggested_snooze_days',
    'referred_contact'
  ],
  properties: {
    semantic_class: { type: 'string', enum: [...SEMANTIC_CLASSES] },
    confidence: { type: 'string', enum: [...TRIAGE_CONFIDENCES] },
    summary: { type: 'string', description: '1-2 sentences: what they said, what they want.' },
    recommended_action: { type: 'string', enum: [...RECOMMENDED_TRIAGE_ACTIONS] },
    suggested_snooze_days: {
      type: ['integer', 'null'],
      description: 'For not_now: days until we should resurface this prospect. Null otherwise.'
    },
    referred_contact: {
      type: ['string', 'null'],
      description: 'For referral: the referred person/company as written in the email. Null otherwise.'
    }
  }
});

export const buildTriageInput = ({ message = {}, lead = null, prospect = null } = {}) => ({
  email: {
    from: message.from_email || null,
    to: message.to_email || null,
    subject: message.subject || null,
    text_body: String(message.text_body || '').slice(0, TRIAGE_BODY_CHARS) || null,
    received_at: message.received_at || null,
    m3_classification: message.classification || null
  },
  sender_context: {
    known_waitlist_lead: lead
      ? { email: lead.email, disqualify_reason: lead.reason || null, status: lead.status || null }
      : null,
    known_prospect: prospect
      ? {
          company_name: prospect.company_name,
          jurisdiction: prospect.jurisdiction,
          status: prospect.status,
          tier: prospect.tier,
          why_now: prospect.dossier?.why_now || null
        }
      : null
  }
});
