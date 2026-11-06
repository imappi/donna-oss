import { useState } from 'react';
import { Badge, RiskBadge } from './Badge.jsx';
import {
  QUEUE_BADGE_VARIANT,
  QUEUE_LABELS,
  TRIGGER_FRIENDLY,
  FIRM_PATTERN_LABELS,
  REVIEW_REASONS,
  RETURN_TO_OPS_REASONS
} from '../lib/constants.js';
import { formatTimeAgo } from '../lib/formatting.js';
import { triageCase } from '../lib/inference.js';

const isCustomerRole = (role = '') => ['user', 'customer', 'client'].includes(String(role).toLowerCase());

const queueReasonText = (item, firmMode) => {
  if (item.queue_reason) return item.queue_reason;
  if (item.queue_label === 'auto_send') return 'Safe routine reply. Donna would normally send this automatically.';
  if (firmMode && item.queue_label === 'ops_review') return 'Client intake review. Check the follow-up before sending.';
  if (firmMode && item.queue_label === 'expert_review') return 'Compliance review. Donna should not make the final judgment.';
  if (firmMode && item.queue_label === 'execution_queue') return 'Xero/accounting handoff. Action is needed before the client can move forward.';
  if (item.queue_label === 'ops_review') return 'Needs review. Check the reply before sending.';
  if (item.queue_label === 'expert_review') return 'Specialist review. Donna should not make the final judgment.';
  if (item.queue_label === 'execution_queue') return 'Action required in the client account.';
  return '';
};

const primaryActionLabel = (item, firmMode) => {
  if (!firmMode) return 'Looks good — send it';
  if (item.queue_label === 'expert_review') return 'Approve final answer';
  if (item.queue_label === 'auto_send') return 'Approve auto-send';
  if (item.queue_label === 'execution_queue') return 'Approve handoff';
  return 'Approve client reply';
};

const responseLabel = (item, firmMode) =>
  firmMode && item.queue_label === 'expert_review' ? 'Donna draft:' : 'Donna suggests:';

const feedbackPrompt = (item, firmMode) =>
  firmMode && item.queue_label === 'expert_review'
    ? 'What should change before the final answer?'
    : "What's wrong with Donna's answer?";

const sendEditedLabel = (item, firmMode) =>
  firmMode && item.queue_label === 'expert_review'
    ? 'Approve corrected answer'
    : 'Send corrected version';

const canReturnToClientOps = (item, firmMode) =>
  firmMode && item.queue_label === 'expert_review';

const causeLabel = (item, firmMode) =>
  firmMode
    ? FIRM_PATTERN_LABELS[item.pattern_category] || TRIGGER_FRIENDLY[item.trigger_type] || item.trigger_type
    : TRIGGER_FRIENDLY[item.trigger_type] || item.trigger_type;

const getInlineContext = (conversation = []) => {
  if (!Array.isArray(conversation) || conversation.length === 0) return [];

  const latestUserIndex = conversation.reduce(
    (latest, entry, index) => (isCustomerRole(entry.role) ? index : latest),
    -1
  );
  const anchorIndex = latestUserIndex === -1 ? conversation.length - 1 : latestUserIndex;
  const startIndex = Math.max(0, anchorIndex - 2);

  return conversation.slice(startIndex, anchorIndex + 1).map((entry, offset) => ({
    ...entry,
    sourceIndex: startIndex + offset,
    isLatestCustomer: startIndex + offset === latestUserIndex
  }));
};

const CaseCard = ({
  item,
  nowValue,
  onApprove,
  onThumbsUp,
  onSendEdited,
  onEscalate,
  onReturnToOps,
  firmMode = false
}) => {
  const [showConversation, setShowConversation] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(item.donna_response);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackReason, setFeedbackReason] = useState('');
  const [feedbackNote, setFeedbackNote] = useState('');
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnReason, setReturnReason] = useState(RETURN_TO_OPS_REASONS[0].value);
  const [returnNote, setReturnNote] = useState('');
  const [starred, setStarred] = useState(false);

  const triage = triageCase(item);
  const inlineContext = getInlineContext(item.conversation);
  const inlineContextIndexes = new Set(inlineContext.map((entry) => entry.sourceIndex));
  const hiddenConversation = Array.isArray(item.conversation)
    ? item.conversation.filter((_, index) => !inlineContextIndexes.has(index))
    : [];
  const hasHiddenConversation = hiddenConversation.length > 0;
  const showSummary = !(firmMode && item.queue_label === 'expert_review');

  const handleSendEdit = () => {
    onSendEdited(item, editDraft, { reason: feedbackReason, note: feedbackNote });
    setIsEditing(false);
    setShowFeedback(false);
  };

  const handleReject = () => {
    setShowReturnForm(false);
    setIsEditing(true);
    setShowFeedback(true);
  };
  const handlePrimaryAction = () => onApprove(item);
  const handleOpenReturnForm = () => {
    setIsEditing(false);
    setShowFeedback(false);
    setShowReturnForm(true);
  };
  const handleCancelReturn = () => {
    setShowReturnForm(false);
    setReturnReason(RETURN_TO_OPS_REASONS[0].value);
    setReturnNote('');
  };
  const handleConfirmReturn = () => {
    onReturnToOps?.(item, { reason: returnReason, note: returnNote.trim() });
    handleCancelReturn();
  };

  const handleStar = (e) => {
    e.stopPropagation();
    if (!starred && onThumbsUp) {
      setStarred(true);
      onThumbsUp(item);
    }
  };

  return (
    <article className={`case-card risk-${triage.risk}`}>
      {/* Top bar */}
      <div className="case-card__top">
        <div className="case-card__badges">
          <RiskBadge level={triage.risk} firmMode={firmMode} />
          {item.queue_label && (
            <Badge variant={QUEUE_BADGE_VARIANT[item.queue_label] || 'muted'}>
              {QUEUE_LABELS[item.queue_label] || item.queue_label}
            </Badge>
          )}
          <Badge variant="muted">
            {causeLabel(item, firmMode)}
          </Badge>
          <span className="case-card__time">{formatTimeAgo(item.created_at, nowValue)}</span>
        </div>
        {triage.needsEscalation && !firmMode && (
          <span className="case-card__escalation-hint">Needs specialist</span>
        )}
      </div>

      {/* What the customer is stuck on */}
      <h3 className="case-card__stuck">{item.user_stuck_on}</h3>
      {showSummary && <p className="case-card__summary">{triage.summary}</p>}
      {queueReasonText(item, firmMode) && (
        <div className="case-card__queue-reason">
          <span className="case-card__queue-reason-label">Why this lane</span>
          <span>{queueReasonText(item, firmMode)}</span>
        </div>
      )}

      {/* Inline context for fast review */}
      {inlineContext.length > 0 && (
        <div className="case-card__context">
          <div className="case-card__context-header">
            <span className="case-card__context-label">Customer context</span>
            {hasHiddenConversation && (
              <span className="case-card__context-count">{item.conversation.length} messages</span>
            )}
          </div>
          <div className="case-card__context-lines">
            {inlineContext.map((entry, i) => (
              <div
                key={i}
                className={`case-card__context-line${entry.isLatestCustomer ? ' case-card__context-line--latest' : ''}`}
              >
                <span className="case-card__context-role">{entry.role}</span>
                <span className="case-card__context-text">{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Donna's suggested response */}
      <div className="case-card__response">
        <div className="case-card__response-label">{responseLabel(item, firmMode)}</div>
        {isEditing ? (
          <textarea
            className="case-card__editor"
            rows={6}
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
          />
        ) : (
          <div className="case-card__response-text">{item.donna_response}</div>
        )}
      </div>

      {/* Feedback form (shown when correcting) */}
      {showFeedback && (
        <div className="case-card__feedback">
          <label className="field-label">{feedbackPrompt(item, firmMode)}</label>
          <select value={feedbackReason} onChange={(e) => setFeedbackReason(e.target.value)}>
            <option value="">Pick a reason...</option>
            {REVIEW_REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <textarea
            className="case-card__feedback-note"
            rows={2}
            placeholder="Optional: add a note for Donna to learn from"
            value={feedbackNote}
            onChange={(e) => setFeedbackNote(e.target.value)}
          />
        </div>
      )}

      {showReturnForm && (
        <div className="case-card__return">
          <label className="field-label">Why should intake handle this first?</label>
          <select value={returnReason} onChange={(e) => setReturnReason(e.target.value)}>
            {RETURN_TO_OPS_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>{reason.label}</option>
            ))}
          </select>
          <textarea
            className="case-card__feedback-note"
            rows={2}
            placeholder="Optional note for intake"
            value={returnNote}
            onChange={(e) => setReturnNote(e.target.value)}
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="case-card__actions">
        {hasHiddenConversation ? (
          <button
            className="btn-text"
            onClick={() => setShowConversation((v) => !v)}
          >
            {showConversation ? 'Hide earlier conversation' : 'View earlier conversation'}
          </button>
        ) : <span />}

        <div className="case-card__buttons">
          {triage.needsEscalation && !firmMode && (
            <button className="btn btn-outline-red" onClick={() => onEscalate(item)}>
              Escalate
            </button>
          )}
          {showReturnForm ? (
            <>
              <button className="btn btn-outline" onClick={handleCancelReturn}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleConfirmReturn}>
                Return to intake
              </button>
            </>
          ) : !isEditing ? (
            <>
              {canReturnToClientOps(item, firmMode) && (
                <button className="btn btn-outline" onClick={handleOpenReturnForm}>
                  Return to intake
                </button>
              )}
              <button className="btn btn-outline" onClick={handleReject}>
                Correct
              </button>
              <button className="btn btn-primary" onClick={handlePrimaryAction}>
                {primaryActionLabel(item, firmMode)}
              </button>
              <button
                className={`case-card__star${starred ? ' case-card__star--active' : ''}`}
                onClick={handleStar}
                title={starred ? 'Marked as golden example' : 'Mark as golden example for training'}
              >
                {starred ? '★' : '☆'}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-outline" onClick={() => { setIsEditing(false); setShowFeedback(false); setEditDraft(item.donna_response); }}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSendEdit}>
                {sendEditedLabel(item, firmMode)}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Expandable conversation */}
      {showConversation && (
        <div className="case-card__conversation">
          {hiddenConversation.map((entry, i) => (
            <div key={i} className={`chat-line chat-${entry.role.toLowerCase()}`}>
              <span className="chat-role">{entry.role}</span>
              <span className="chat-text">{entry.text}</span>
            </div>
          ))}
          {item.root_cause && !firmMode && (
            <div className="case-card__root-cause">
              <strong>Root cause:</strong> {item.root_cause.hypothesis}
            </div>
          )}
        </div>
      )}
    </article>
  );
};

export default CaseCard;
