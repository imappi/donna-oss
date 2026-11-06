// Presentation-only recognition for the compact chart-of-accounts treatment.
// Middots also occur in ordinary Donna prose, so punctuation alone is not a
// sufficient signal that a sentence is an account menu.
export const accountMenuParts = (text = '') => {
  const value = String(text).trim();
  if (!value || value.includes('\n')) return null;

  const colonIndex = value.indexOf(':');
  const firstMiddotIndex = value.indexOf(' · ');
  if (colonIndex < 0 || colonIndex > firstMiddotIndex) return null;

  const lead = value.slice(0, colonIndex + 1).trim();
  if (!/\b(?:chart of accounts|accounts?|account menu)\b/i.test(lead)) return null;

  const items = value.slice(colonIndex + 1).split(' · ').map((item) => item.trim()).filter(Boolean);
  return items.length >= 3 ? { lead, items } : null;
};
