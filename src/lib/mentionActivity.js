// Pure interaction laws for the universal @mention composer.
//
// The UI has two agent paths:
//   - @Donna addresses the artifact's existing Donna chat turn directly.
//   - a hired specialist is an ASK and may answer asynchronously through the
//     agent-answer runtime.
//
// Human seats remain ordinary mention/assign/ask addressees. Keeping these
// decisions in a pure leaf lets both mounted artifact surfaces share the same
// behavior without duplicating another mention grammar.

export const isAgentMention = (ref) => ref?.actor_type === 'agent';

export const isDonnaMention = (ref) =>
  isAgentMention(ref) && String(ref?.agent_id || '').trim().toLowerCase() === 'donna';

export const isDirectDonnaMention = (mentions = []) =>
  Array.isArray(mentions) && mentions.length === 1 && isDonnaMention(mentions[0]);

// Agents are single-addressee interactions. Picking one replaces any staged
// humans and selects the only actionable flavor for that agent. Donna's
// `mention` flavor is intercepted by the mounted chat and becomes a direct
// Donna turn; hired specialists use the durable ASK runtime.
export const nextMentionSelection = ({ current = [], picked } = {}) => {
  if (!picked) return { mentions: Array.isArray(current) ? current : [], flavor: 'mention' };
  if (isAgentMention(picked)) {
    return {
      mentions: [picked],
      flavor: isDonnaMention(picked) ? 'mention' : 'ask'
    };
  }
  const humans = (Array.isArray(current) ? current : []).filter((ref) => !isAgentMention(ref));
  return {
    mentions: humans.some((ref) => ref?.key === picked.key) ? humans : [...humans, picked],
    flavor: 'mention'
  };
};

// Do not let the typeahead stage a raw token that the structured selection
// will immediately discard. Agent interactions are deliberately singular;
// remove their chip before addressing somebody else. Human FYIs may fan out
// to several humans, but cannot be mixed with an agent execution request.
export const filterMentionOptionsForSelection = ({ current = [], options = [] } = {}) => {
  const staged = Array.isArray(current) ? current : [];
  const candidates = Array.isArray(options) ? options : [];
  if (staged.some((ref) => isAgentMention(ref))) return [];
  if (staged.length > 0) return candidates.filter((ref) => !isAgentMention(ref));
  return candidates;
};

// Agent ASK comments carry their evidence-request id. The runtime's answer or
// escalation comment carries the same id and role=assistant. Deriving pending
// state from persisted rows means the working indicator survives a refresh and
// disappears only when the reply itself is visible in the chat.
export const pendingAgentMentionAsks = (messages = []) => {
  const pending = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const payload = message?.payload || {};
    const askId = String(payload.ask_id || '').trim();
    if (!askId) continue;
    if (message?.role === 'assistant') {
      pending.delete(askId);
      continue;
    }
    const agent = (Array.isArray(payload.mentions) ? payload.mentions : [])
      .find((ref) => isAgentMention(ref));
    if (payload.kind === 'comment' && payload.flavor === 'ask' && agent) {
      pending.set(askId, {
        ask_id: askId,
        agent_id: agent.agent_id || null,
        display: agent.display || agent.agent_id || 'Agent'
      });
    }
  }
  return [...pending.values()];
};
