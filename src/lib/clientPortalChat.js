// Client-portal chat — pure view helpers for the owner ↔ Donna panel
// (src/components/ClientPortalChatPanel.jsx). Kept out of the component
// so the mapping logic is testable as a plain node script, the same
// pattern as documentChat.js / transactionChat.js in this directory.

// The server persists three roles. The portal renders two speakers plus
// a quiet inline notice for system rows — the owner never sees a raw
// failure payload, but a failed turn is not silently dropped either
// (the notice is the honest receipt that a reply didn't arrive).
export const portalChatDisplayMessages = (messages = []) =>
  (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (!message || !message.id) return null;
      if (message.role === 'user') {
        return { id: message.id, speaker: 'you', text: String(message.content || ''), at: message.created_at || null };
      }
      if (message.role === 'assistant') {
        return { id: message.id, speaker: 'donna', text: String(message.content || ''), at: message.created_at || null };
      }
      if (message.role === 'system') {
        // Failure rows carry payload.failure_code; anything else system-
        // injected renders as the same quiet notice style.
        return {
          id: message.id,
          speaker: 'notice',
          messageId: message.payload?.failure_code ? 'portal.chat.error.reply' : null,
          text: message.payload?.failure_code
            ? 'Donna could not reply just then. Ask again in a moment.'
            : String(message.content || ''),
          at: message.created_at || null
        };
      }
      return null;
    })
    .filter(Boolean)
    .filter((entry) => entry.text.trim().length > 0);

// The confirmable answer cards riding an assistant message
// (payload.actions, Slice 2's one verb). Each card carries the indexes
// the apply endpoint needs plus a render state:
//   'proposed'   → live Confirm button
//   'applied'    → quiet "filed" receipt
//   'superseded' → a newer answer replaced it; no button
//   anything else (declined/failed) → no button, label the state
export const portalChatActionCards = (message) => {
  if (!message || message.role !== 'assistant') return [];
  const actions = Array.isArray(message.payload?.actions) ? message.payload.actions : [];
  return actions
    .map((action, index) => {
      if (!action || action.type !== 'answer_evidence_request') return null;
      const status = action.status || 'proposed';
      return {
        messageId: message.id,
        actionIndex: index,
        status,
        confirmable: status === 'proposed',
        replyText: String(action.reply_text || ''),
        evidenceRequestId: action.evidence_request_id || null
      };
    })
    .filter(Boolean);
};


export const portalChatOwnerIntentCandidateCards = (candidates = []) =>
  (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      if (!candidate || !candidate.proposal_id) return null;
      const status = candidate.status || 'proposed';
      return {
        proposalId: candidate.proposal_id,
        status,
        intentKind: candidate.intent_kind || null,
        summary: String(candidate.summary || '').trim(),
        parseConfidence: candidate.parse_confidence || null,
        sourceMessageId: candidate.source_message_id || null,
        compileId: candidate.compile_id || null,
        memoryCandidate: candidate.memory_candidate || null,
        preflight: candidate.preflight || null,
        warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
        unmetCapabilityNeeds: Array.isArray(candidate.unmet_capability_needs) ? candidate.unmet_capability_needs : [],
        reviewMode: candidate.review_mode || null,
        checkStatus: candidate.check_status || null
      };
    })
    .filter(Boolean)
    .filter((card) => card.status === 'proposed')
    .filter((card) => card.summary.length > 0);


const topicOutcomeLabel = (outcome = '') => String(outcome || '').replace(/_/g, ' ').trim();

export const portalEvidenceTopicCards = (topics = []) =>
  (Array.isArray(topics) ? topics : [])
    .map((topic) => {
      if (!topic || !topic.evidence_request_id) return null;
      const status = String(topic.status || 'open');
      const assessment = topic.last_assessment && typeof topic.last_assessment === 'object' ? topic.last_assessment : null;
      const recentTurns = Array.isArray(topic.recent_turns) ? topic.recent_turns : [];
      return {
        evidenceRequestId: topic.evidence_request_id,
        status,
        channel: topic.channel || null,
        currentNeed: String(topic.current_need || '').trim(),
        lastOwnerMessageAt: topic.last_owner_message_at || null,
        outcome: assessment?.outcome || null,
        outcomeLabel: topicOutcomeLabel(assessment?.outcome),
        reason: assessment?.reason || null,
        stillMissing: Array.isArray(assessment?.still_missing) ? assessment.still_missing : [],
        lastReplyExcerpt: String(recentTurns.at(-1)?.reply_excerpt || '').trim()
      };
    })
    .filter(Boolean)
    .filter((card) => card.status === 'open')
    .filter((card) => card.currentNeed || card.lastReplyExcerpt || card.outcome);

// One friendly line for a failed send. The server's 402 (billing
// backstop) and 5xx bodies carry technical copy; the owner gets plain
// words and the console keeps the real error.
export const portalChatErrorCopy = (error) => {
  const status = error?.status || error?.statusCode || null;
  if (status === 402) return 'Your plan is not active, so chat is paused. Check your billing to continue.';
  if (status === 401 || status === 403) return 'Your session expired. Refresh the page and sign in again.';
  return 'That message did not go through. Try again in a moment.';
};
