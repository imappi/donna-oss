// Donna owner actor attribution — stable durable ids for owner-authored artifacts.
//
// Durable runtime records must not fall back to email addresses or sentinel actor ids such
// as "client" / "system". Prefer stable principal/collaborator/user ids from the auth
// principal and record an explicit unknown shape when none is present.

const clean = (value) => {
  const s = String(value || '').trim();
  return s || null;
};

const forbiddenSentinels = new Set(['client', 'system', 'owner', 'user', 'unknown']);
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const stable = (value) => {
  const s = clean(value);
  if (!s) return null;
  if (looksLikeEmail(s)) return null;
  if (forbiddenSentinels.has(s.toLowerCase())) return null;
  return s;
};

export const ownerActorAttribution = ({ principal = null, auth = null, fallback = null } = {}) => {
  const collaboratorId = stable(principal?.collaborator?.id) || stable(principal?.collaboratorId);
  if (collaboratorId) {
    return { actor_id: collaboratorId, actor_type: 'owner', basis: 'collaborator_id', unknown: false };
  }
  const principalId = stable(principal?.principalId) || stable(principal?.id);
  if (principalId) {
    return { actor_id: principalId, actor_type: 'owner', basis: 'principal_id', unknown: false };
  }
  const userId = stable(principal?.userId) || stable(auth?.userId) || stable(auth?.sub) || stable(fallback?.userId);
  if (userId) {
    return { actor_id: userId, actor_type: 'owner', basis: 'user_id', unknown: false };
  }
  return { actor_id: null, actor_type: 'owner', basis: 'unknown', unknown: true };
};
