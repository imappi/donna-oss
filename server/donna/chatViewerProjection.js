// Viewer-relative chat direction is a read projection, never persisted state.
// The same comment row is "mine" for its author and inbound for every other
// eligible seat. Keep that distinction out of the durable event and annotate
// it only as the API shapes a thread for the authenticated principal.

const norm = (value) => String(value || '').trim().toLowerCase();

export const projectChatMessageForViewer = (message, viewerActorId) => {
  const actorType = norm(message?.actor_type);
  const humanAuthored = actorType === 'firm' || actorType === 'client';
  return {
    ...message,
    viewer_is_actor: Boolean(
      humanAuthored
      && norm(viewerActorId)
      && norm(message?.actor_id) === norm(viewerActorId)
    )
  };
};

export const projectChatMessagesForViewer = (messages = [], viewerActorId) =>
  (Array.isArray(messages) ? messages : []).map((message) =>
    projectChatMessageForViewer(message, viewerActorId));
