// Single, fail-safe entry point for product analytics (Vercel Web Analytics).
//
// Why a wrapper and not a bare `track()` import at each call site:
//   1. Analytics is best-effort. A blocked/unloaded beacon (ad-blocker, no
//      consent runtime, SSR) must NEVER throw into a user flow — signup and
//      checkout have to proceed regardless. The try/catch here guarantees that.
//   2. One import, one place the event vocabulary lives, so the funnel code
//      can't drift on event names. Same "one accessor" discipline as
//      pendingOffer.js / pendingConfirm.js.
//
// Privacy: this is a bookkeeping product. Do NOT pass PII (email, names,
// amounts) as event props — Vercel Web Analytics is cookieless and we keep it
// that way by only sending coarse, non-identifying dimensions (e.g. offer kind).
import { track } from '@vercel/analytics';

export const trackEvent = (name, props) => {
  try {
    if (!name) return;
    if (props && typeof props === 'object') track(name, props);
    else track(name);
  } catch {
    /* best-effort — analytics must never break a user flow. */
  }
};
