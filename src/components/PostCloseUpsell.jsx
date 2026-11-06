// Screen 3 — earned recurring (post-close upsell).
//
// Fires ONLY after a one-off or catch-up customer's first close has been
// delivered — never pre-purchase. This is the trust play: recurring is offered
// because they've seen one real close, not forced up front.
//
// Self-contained and presentational: the parent owns the trigger ("has this
// customer's first close just been delivered?") and the two actions. It is
// intentionally NOT wired into the close engine here — that surface is on the
// parallel reconcile/close track. Mount it from the portal once a delivered
// close is observed. The recurring price is the flat monthly subscription from
// pricing.js — no price prop to pass.
//
// Guardrails honored: recurring is opt-in (no pre-checked box); dismissing is
// penalty-free and must not re-prompt in a loop (the parent should not re-mount
// after onDismiss in the same session).

import { D } from './shared/design-tokens.js';
import { fmt, RECURRING_MONTHLY_PRICE } from '../lib/pricing.js';

export default function PostCloseUpsell({ month, onKeepCurrent, onDismiss }) {
  const monthLabel = month ? String(month) : 'latest';
  return (
    <section
      style={{
        maxWidth: 460,
        padding: 'clamp(1.25rem, 3vw, 1.75rem)',
        border: `1px solid ${D.rule}`,
        borderRadius: 12,
        background: D.paper,
        color: D.ink,
        fontFamily: D.body
      }}
    >
      <p
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontFamily: D.mono,
          fontSize: 11,
          letterSpacing: D.tracking.mono,
          textTransform: 'uppercase',
          color: 'oklch(0.52 0.11 150)',
          margin: 0
        }}
      >
        <span aria-hidden="true">✓</span>
        Your {monthLabel} books are closed.
      </p>

      <h2 style={{ fontFamily: D.body, fontSize: '1.3rem', fontWeight: 600, lineHeight: 1.25, margin: '0.85rem 0 0.5rem' }}>
        Want Donna to just keep doing this?
      </h2>
      <p style={{ fontSize: '0.95rem', lineHeight: 1.55, color: D.inkSoft, margin: 0 }}>
        No more remembering to come back. Stop anytime, one tap. We&apos;re offering this now because you&apos;ve seen
        one real close — not before.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '1.25rem' }}>
        <button
          type="button"
          onClick={onKeepCurrent}
          style={{
            appearance: 'none',
            width: '100%',
            border: 'none',
            borderRadius: 6,
            padding: '0.9rem 1.25rem',
            background: D.accentWarmFlat,
            color: D.ink,
            fontFamily: D.mono,
            fontSize: 12,
            letterSpacing: D.tracking.mono,
            textTransform: 'uppercase',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Keep me current — {fmt(RECURRING_MONTHLY_PRICE)}/mo
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            appearance: 'none',
            width: '100%',
            border: `1px solid ${D.rule}`,
            borderRadius: 6,
            padding: '0.8rem 1.25rem',
            background: 'transparent',
            color: D.inkSoft,
            fontFamily: D.body,
            fontSize: '0.9rem',
            cursor: 'pointer'
          }}
        >
          I&apos;ll come back if I need to
        </button>
      </div>
    </section>
  );
}
