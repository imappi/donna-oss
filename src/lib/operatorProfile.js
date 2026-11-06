// Operator profile — the person at this machine, as THEY name themselves.
// Local display identity only (sidebar user card, menus): it does NOT feed
// audit attribution — the authenticated principal does that server-side
// (operator-safety substrate #1). Stored per-device in localStorage; the
// desktop shell has no sign-in (the proxy injects credentials main-side),
// so this is the honest home for "what should Donna call you."

const PROFILE_KEY = 'donna.operator_profile.v1';

export const getOperatorProfile = () => {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROFILE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const name = String(parsed.name || '').trim();
    if (!name) return null;
    return { name, initials: String(parsed.initials || '').trim() || initialsFromName(name) };
  } catch {
    return null;
  }
};

export const saveOperatorProfile = ({ name, initials } = {}) => {
  if (typeof window === 'undefined') return;
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    window.localStorage.removeItem(PROFILE_KEY);
    return;
  }
  const cleanInitials = String(initials || '').trim().slice(0, 3).toUpperCase()
    || initialsFromName(cleanName);
  window.localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: cleanName, initials: cleanInitials }));
};

export const initialsFromName = (name = '') => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};
