// Pending purchase offer — the bridge from the signed-out marketing funnel to
// the real Stripe checkout that can only run once a client exists.
//
// The funnel (DonnaLanding) lets a visitor pick an offer { kind, bandId, price,
// months, amount } and then creates an account. Account creation can't charge
// yet (no client/workspace exists at that instant), so the offer is stashed
// here and REDEEMED later — by ClientPortalGate, the first authenticated surface
// that knows the clientId — into a hosted Stripe Checkout Session.
//
// One key, one shape, one accessor: the funnel and the gate must not drift on
// where this lives, so both import from this module rather than re-declaring the
// localStorage key.

export const PENDING_OFFER_KEY = 'donna.pending_offer.v1';

export const stashPendingOffer = (offer) => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PENDING_OFFER_KEY, JSON.stringify(offer));
    }
  } catch {
    /* storage unavailable — non-fatal; the offer is a convenience, not a record. */
  }
};

// Read the stashed offer, or null if absent/corrupt. Only the fields the server
// re-validates ({ kind, bandId, months }) are load-bearing — price/amount are
// re-derived server-side and never trusted from here.
export const readPendingOffer = () => {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(PENDING_OFFER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.kind || !parsed.bandId) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const clearPendingOffer = () => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(PENDING_OFFER_KEY);
    }
  } catch {
    /* non-fatal */
  }
};
