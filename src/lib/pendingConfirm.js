// Pending email-confirmation marker — lets the signup funnel's "Check your
// inbox" screen survive a page refresh.
//
// The confirm screen (DonnaLanding view==='confirm') is otherwise pure React
// state with no URL of its own, so a refresh drops a brand-new signup back onto
// the marketing landing ("wait, did my signup work?"). The funnel writes
// ?auth=confirm to the URL when it enters that screen; this module stashes the
// address the link was sent to, so on refresh we can re-show "we sent a link to
// <email>" AND keep the "resend confirmation" button working (it needs the
// address). The email never goes in the URL — only here.
//
// Convenience, not a record: storage failures are swallowed and the screen
// degrades to a generic "your email" (see DonnaLanding). One key, one shape,
// one accessor — same discipline as pendingOffer.js.

export const PENDING_CONFIRM_KEY = 'donna.pending_confirm.v1';

export const stashConfirmEmail = (email) => {
  try {
    const value = String(email || '').trim();
    if (!value) return;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PENDING_CONFIRM_KEY, value);
    }
  } catch {
    /* storage unavailable — non-fatal; the screen falls back to generic copy. */
  }
};

export const readConfirmEmail = () => {
  try {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(PENDING_CONFIRM_KEY) || '';
  } catch {
    return '';
  }
};

export const clearConfirmEmail = () => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(PENDING_CONFIRM_KEY);
    }
  } catch {
    /* non-fatal */
  }
};
