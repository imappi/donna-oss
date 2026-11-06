// Shared optimistic-turn helpers for the mounted artifact chats.
//
// Sending is a chat interaction, so the human's bubble belongs in the stream
// immediately. The server still owns the durable id/timestamp/actor receipt;
// once it answers, replace the local placeholder in place with those persisted
// rows. Polling is paused while a send is in flight, so this helper never has
// to guess against a concurrent server snapshot.

export const buildOptimisticUserMessage = ({ id, content, payload = {} } = {}) => ({
  id,
  role: 'user',
  content: String(content || '').trim(),
  payload: payload && typeof payload === 'object' ? payload : {},
  actor_type: 'firm',
  actor_id: null,
  viewer_is_actor: true,
  created_at: null,
  optimistic: true
});

export const settleOptimisticChatTurn = (messages = [], optimisticId, additions = []) => {
  const current = Array.isArray(messages) ? messages : [];
  const incoming = (Array.isArray(additions) ? additions : []).filter(Boolean);
  const incomingIds = new Set(incoming.map((message) => String(message?.id || '')).filter(Boolean));
  const withoutServerDuplicates = current.filter(
    (message) => !incomingIds.has(String(message?.id || ''))
  );
  const index = withoutServerDuplicates.findIndex(
    (message) => String(message?.id || '') === String(optimisticId || '')
  );
  if (index < 0) return [...withoutServerDuplicates, ...incoming];
  return [
    ...withoutServerDuplicates.slice(0, index),
    ...incoming,
    ...withoutServerDuplicates.slice(index + 1)
  ];
};

export const removeOptimisticChatTurn = (messages = [], optimisticId) =>
  (Array.isArray(messages) ? messages : []).filter(
    (message) => String(message?.id || '') !== String(optimisticId || '')
  );
