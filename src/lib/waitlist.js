// Marketing waitlist capture for the qualification gate's unfit path.
//
// A signed-out visitor who doesn't qualify (restaurant / volume / other) never
// reaches a card form — we capture their email here, tagged with the
// disqualifying reason, for later segmentation. Public endpoint (no auth):
// the caller is an anonymous marketing visitor. 'inventory' is legacy as of
// the P0E gate revision (products is a scoping gate now, not a reject) — kept
// for existing rows.

const VALID_REASONS = new Set(['inventory', 'restaurant', 'volume', 'jurisdiction', 'switcher', 'other']);

export const submitWaitlist = async ({ email, reason }) => {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) throw new Error('Email is required.');
  const tag = VALID_REASONS.has(reason) ? reason : 'other';

  const response = await fetch('/api/donna/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: cleanEmail, reason: tag })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `Waitlist signup failed with ${response.status}`);
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return response.json().catch(() => ({ ok: true }));
};
