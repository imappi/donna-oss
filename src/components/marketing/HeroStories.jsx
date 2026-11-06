// Donna landing — hero "stories" (the right brand panel's product carousel).
//
// Kari, 2026-08-28: the hero should FEATURE THE APP, IG-stories style — a
// segmented progress bar on top of the right container, slides advancing one
// by one. The slide set is the two-terminal-states doctrine told as a story
// (CLAUDE.md): (1) the desktop app working the feed, (2) the one question only
// the owner can answer, (3) the month closed with a receipt. Same demo entity
// (Honeybee Hills Apiary) threads through all three so it reads as one close,
// not three stock screens.
//
// No binary assets, deliberately — the slides are JSX recreations, same
// approach as the /fi WhatsApp iPhone in DonnaLanding.jsx: crisp at any DPI,
// no megabyte screenshots, and the copy stays under the honest-promise test
// (honestPromiseCopy.test.js pins this file). The app-window slide uses the
// app's own type doctrine (system face + tabular numerals, design-tokens.js);
// the ask and receipt cards are brand surfaces (body/serif/mono).
//
// Interaction, IG semantics: auto-advance with per-slide durations; hover or
// press-and-hold pauses; left third = previous, right two-thirds = next; the
// bar segments jump. prefers-reduced-motion: no timers, no entrance
// animations, manual navigation still works. All content is illustrative demo
// data, not metrics.

import { memo, useEffect, useRef, useState } from 'react';

import { D } from '../shared/design-tokens.js';

const inkA = (alpha) => `oklch(0.08 0 0 / ${alpha})`;
// The landing's "good news" green — same value family as DonnaLanding's
// NoticeMsg. Positive amounts in the app mock and the CLOSED stamp use it.
const GREEN = 'oklch(0.52 0.11 150)';

export const STORY_COUNT = 3;
// app · ask · close — the app slide is denser, the receipt settles fastest.
const DURATIONS = [7500, 7200, 6400];
const TICK_MS = 100;

const monoCaps = { fontFamily: D.mono, textTransform: 'uppercase' };

// ── Slide 1 — the desktop app (Electron window, reconcile/Material view) ────
const ENTITIES = [
  { name: 'Aurora Grid', dot: 'oklch(0.58 0.10 250)' },
  { name: 'Merlion Studio', dot: 'oklch(0.58 0.10 310)' },
  { name: 'Tanjong Trading', dot: 'oklch(0.66 0.11 75)' },
  { name: 'Northwind Ventures', dot: 'oklch(0.50 0.06 250)' },
  { name: 'Lakeshore Oy', dot: 'oklch(0.55 0.10 150)' },
  { name: 'Cactus Blossom Café Corp', dot: 'oklch(0.64 0.13 45)', count: 14 },
  { name: 'Honeybee Hills Apiary LLC', dot: 'oklch(0.64 0.13 45)', count: 14, active: true }
];

// [date, memo, amount, chip, positive?] — bank-memo caps, − is U+2212.
const OPEN_ROWS = [
  ['25 Jun', 'BRANCH DEPOSIT', '+USD 1,999.45', 'Revenue', true],
  ['18 Jun', 'OWNER DISTRIBUTION · 905026', '−USD 3,339.14', 'Suspense', false],
  ['16 Jun', 'SQUARE INC · 99623697367', '+USD 865.05', 'Revenue', true],
  ['12 Jun', 'SHOPIFY INC · 889512', '+USD 2,283.87', 'Revenue', true],
  ['02 Jun', 'LAND LEASE PMT · 801743248367', '−USD 831.35', 'Suspense', false]
];
const DONE_ROWS = [
  ['30 Jun', 'INTEREST EARNED', '+USD 1.36', 'Interest income', true],
  ['28 Jun', 'FARMERS MKT BOOTH FEE', '−USD 26.37', 'Marketing', false],
  ['26 Jun', 'SHELL OIL 61998', '−USD 32.49', 'Travel', false],
  ['21 Jun', 'TRACTOR SUPPLY #99840', '−USD 24.42', 'Office expenses', false],
  ['05 Jun', 'PROGRESSIVE · 442224208561', '−USD 285.47', 'Insurance', false]
];

const appRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3.5px 0',
  minWidth: 0
};
const appChip = {
  fontFamily: D.ui,
  fontSize: 8.5,
  lineHeight: 1,
  color: inkA(0.62),
  background: inkA(0.055),
  borderRadius: 999,
  padding: '3px 7px',
  whiteSpace: 'nowrap'
};

const AppFeedRow = ({ row, open, delay }) => {
  const [date, memo, amount, chip, positive] = row;
  return (
    <div className="dl2-story-row" style={{ ...appRowStyle, animationDelay: `${delay}ms` }}>
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          flex: 'none',
          background: open ? 'oklch(0.66 0.16 47)' : inkA(0.22)
        }}
      />
      <span style={{ fontFamily: D.ui, fontSize: 9, color: inkA(0.42), width: 34, flex: 'none', ...D.tabular }}>{date}</span>
      <span
        style={{
          fontFamily: D.ui,
          fontSize: 9.5,
          fontWeight: 500,
          color: inkA(0.78),
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {memo}
      </span>
      <span
        style={{
          fontFamily: D.ui,
          fontSize: 9.5,
          fontWeight: 500,
          color: positive ? GREEN : inkA(0.82),
          flex: 'none',
          ...D.tabular
        }}
      >
        {amount}
      </span>
      <span style={{ width: 88, flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
        <span style={appChip}>{chip}</span>
      </span>
    </div>
  );
};

const AppSectionHead = ({ label, count, delay }) => (
  <div
    className="dl2-story-row"
    style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '9px 0 3px', animationDelay: `${delay}ms` }}
  >
    <span style={{ fontFamily: D.ui, fontSize: 9.5, fontWeight: 600, color: inkA(0.8) }}>{label}</span>
    <span style={{ fontFamily: D.ui, fontSize: 9, color: inkA(0.4), ...D.tabular }}>{count}</span>
  </div>
);

const AppWindowSlide = () => (
  <div className="dl2-story-scale" style={{ width: 'min(660px, 92%)' }}>
    <div
      className="dl2-story-card"
      style={{
        borderRadius: 12,
        overflow: 'hidden',
        background: '#fff',
        border: `1px solid ${inkA(0.14)}`,
        boxShadow: '0 44px 80px -32px rgba(35, 16, 4, 0.5), 0 12px 28px -12px rgba(35, 16, 4, 0.28)'
      }}
    >
      {/* macOS titlebar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 10px',
          background: '#F7F5F1',
          borderBottom: `1px solid ${inkA(0.08)}`
        }}
      >
        {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
          <span key={c} aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: c, flex: 'none' }} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'stretch', minWidth: 0 }}>
        {/* sidebar */}
        <div
          className="dl2-story-appside"
          style={{
            width: 148,
            flex: 'none',
            background: '#F7F5F1',
            borderRight: `1px solid ${inkA(0.08)}`,
            padding: '8px 8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 1
          }}
        >
          {[
            ['Inbox', 28],
            ['Team', null],
            ['Feedback', null]
          ].map(([label, count]) => (
            <div
              key={label}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3.5px 7px' }}
            >
              <span style={{ fontFamily: D.ui, fontSize: 9.5, color: inkA(0.72) }}>{label}</span>
              {count != null && <span style={{ fontFamily: D.ui, fontSize: 8.5, color: inkA(0.4), ...D.tabular }}>{count}</span>}
            </div>
          ))}
          <div style={{ ...monoCaps, fontSize: 7, letterSpacing: '0.14em', color: inkA(0.38), padding: '8px 7px 3px' }}>
            Entities
          </div>
          {ENTITIES.map((e) => (
            <div
              key={e.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '3.5px 7px',
                borderRadius: 6,
                background: e.active ? '#fff' : 'transparent',
                border: `1px solid ${e.active ? inkA(0.1) : 'transparent'}`
              }}
            >
              <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: e.dot, flex: 'none' }} />
              <span
                style={{
                  fontFamily: D.ui,
                  fontSize: 9,
                  fontWeight: e.active ? 600 : 400,
                  color: inkA(e.active ? 0.85 : 0.66),
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {e.name}
              </span>
              {e.count != null && (
                <span style={{ fontFamily: D.ui, fontSize: 8.5, color: inkA(0.4), flex: 'none', ...D.tabular }}>{e.count}</span>
              )}
            </div>
          ))}
        </div>

        {/* content — the Material reconcile view */}
        <div style={{ flex: 1, minWidth: 0, padding: '10px 16px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: D.ui, fontSize: 10.5, fontWeight: 600, color: inkA(0.88) }}>
              Honeybee Hills Apiary LLC
            </span>
            <span aria-hidden="true" style={{ fontFamily: D.ui, fontSize: 10, color: inkA(0.35), letterSpacing: '0.12em' }}>
              …
            </span>
          </div>

          {/* Actions | Material segmented control */}
          <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 7px' }}>
            <div style={{ display: 'flex', gap: 2, background: inkA(0.05), borderRadius: 7, padding: 2 }}>
              {[
                ['Actions', 1, false],
                ['Material', 25, true]
              ].map(([label, count, active]) => (
                <span
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 4,
                    padding: '3px 9px',
                    borderRadius: 5,
                    background: active ? '#fff' : 'transparent',
                    border: `1px solid ${active ? inkA(0.12) : 'transparent'}`,
                    fontFamily: D.ui,
                    fontSize: 9,
                    fontWeight: active ? 600 : 400,
                    color: inkA(active ? 0.85 : 0.55)
                  }}
                >
                  {label}
                  <span style={{ fontSize: 8, color: inkA(0.42), ...D.tabular }}>{count}</span>
                </span>
              ))}
            </div>
          </div>

          <div
            className="dl2-story-row"
            style={{
              textAlign: 'center',
              fontFamily: D.ui,
              fontSize: 9,
              color: inkA(0.45),
              animationDelay: '200ms',
              ...D.tabular
            }}
          >
            {'15 finished · 10 processing · '}
            <span style={{ fontWeight: 600, color: inkA(0.78) }}>0 need you</span>
          </div>

          <AppSectionHead label="Open" count={10} delay={300} />
          {OPEN_ROWS.map((row, i) => (
            <AppFeedRow key={row[1]} row={row} open delay={380 + i * 90} />
          ))}

          <AppSectionHead label="Reconciled" count={15} delay={860} />
          <div
            className="dl2-story-row"
            style={{ fontFamily: D.ui, fontSize: 8.5, color: inkA(0.4), margin: '0 0 2px', animationDelay: '900ms' }}
          >
            June 2025
          </div>
          {DONE_ROWS.map((row, i) => (
            <AppFeedRow key={row[1]} row={row} open={false} delay={940 + i * 80} />
          ))}
        </div>
      </div>
    </div>
  </div>
);

// ── Slide 2 — the one question (ask the owner a business fact) ──────────────
const DonnaMark = ({ size = 20 }) => (
  <span
    aria-hidden="true"
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, oklch(0.78 0.13 70), oklch(0.60 0.19 36))',
      color: '#FAFAFA',
      fontFamily: D.display,
      fontSize: size * 0.55,
      letterSpacing: '0.02em'
    }}
  >
    D
  </span>
);

const askChip = {
  fontFamily: D.body,
  fontSize: 12,
  lineHeight: 1,
  color: D.ink,
  background: '#fff',
  border: `1px solid ${inkA(0.3)}`,
  borderRadius: 999,
  padding: '8px 13px',
  whiteSpace: 'nowrap'
};

const AskSlide = () => (
  <div className="dl2-story-scale" style={{ width: 'min(440px, 90%)' }}>
    <div
      className="dl2-story-card"
      style={{
        background: '#fff',
        border: `1px solid ${inkA(0.13)}`,
        borderRadius: 14,
        padding: '1.05rem 1.15rem 1.15rem',
        boxShadow: '0 40px 76px -30px rgba(35, 16, 4, 0.5), 0 10px 26px -12px rgba(35, 16, 4, 0.26)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <DonnaMark />
        <span style={{ ...monoCaps, fontSize: 8.5, letterSpacing: '0.18em', color: inkA(0.48) }}>
          Donna · Honeybee Hills · June
        </span>
      </div>

      <p
        className="dl2-story-row"
        style={{
          fontFamily: D.body,
          fontSize: 13.5,
          lineHeight: 1.5,
          color: D.ink,
          margin: '0.8rem 0 0',
          animationDelay: '250ms'
        }}
      >
        One thing needs you. <strong>LAND LEASE PMT</strong>, USD 831.35, paid June 2. What is this payment for?
      </p>

      <div className="dl2-story-row" style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '0.85rem 0 0', animationDelay: '1300ms' }}>
        <span className="dl2-story-tap" style={{ ...askChip, animationDelay: '3000ms' }}>
          The apiary field lease
        </span>
        <span className="dl2-story-dim" style={{ ...askChip, animationDelay: '3000ms' }}>
          Something else
        </span>
      </div>

      <div
        className="dl2-story-row"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0.95rem 0 0', animationDelay: '4100ms' }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 15,
            height: 15,
            borderRadius: '50%',
            flex: 'none',
            marginTop: 1,
            border: `1.5px solid ${GREEN}`,
            color: GREEN,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            lineHeight: 1
          }}
        >
          ✓
        </span>
        <span style={{ fontFamily: D.body, fontSize: 12.5, lineHeight: 1.5, color: inkA(0.75) }}>
          Done. Coded to Rent and lease, double-entry posted to your Xero. I’ll remember the field lease.
        </span>
      </div>
    </div>
  </div>
);

// ── Slide 3 — the close receipt ─────────────────────────────────────────────
const RECEIPT_ROWS = [
  ['Lines coded', '142'],
  ['Material reconciled', '25'],
  ['Asked you', 'once'],
  ['Posted to Xero', '✓'],
  ['Trial balance', 'footed']
];

const CloseSlide = () => (
  <div className="dl2-story-scale" style={{ width: 'min(370px, 84%)' }}>
    <div
      className="dl2-story-card"
      style={{
        position: 'relative',
        background: '#fff',
        border: `1px solid ${inkA(0.13)}`,
        borderRadius: 12,
        padding: '1.15rem 1.3rem 1.25rem',
        boxShadow: '0 40px 76px -30px rgba(35, 16, 4, 0.5), 0 10px 26px -12px rgba(35, 16, 4, 0.26)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ ...monoCaps, fontSize: 8.5, letterSpacing: '0.2em', color: inkA(0.48) }}>Donna · close receipt</span>
        <span style={{ ...monoCaps, fontSize: 8.5, letterSpacing: '0.14em', color: inkA(0.4) }}>Jun 2025</span>
      </div>
      <div style={{ ...monoCaps, fontSize: 9.5, letterSpacing: '0.16em', color: inkA(0.78), margin: '0.55rem 0 0' }}>
        Honeybee Hills Apiary LLC
      </div>

      <div
        style={{
          fontFamily: D.serif,
          fontSize: '1.9rem',
          lineHeight: 1.05,
          letterSpacing: '-0.01em',
          color: D.ink,
          margin: '0.65rem 0 0.9rem'
        }}
      >
        June, closed.
      </div>

      <div style={{ borderTop: `1px dashed ${inkA(0.25)}`, margin: '0 0 0.55rem' }} />
      {RECEIPT_ROWS.map(([label, value], i) => (
        <div
          key={label}
          className="dl2-story-row"
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: '3px 0',
            animationDelay: `${450 + i * 160}ms`
          }}
        >
          <span style={{ ...monoCaps, fontSize: 9.5, letterSpacing: '0.1em', color: inkA(0.62), flex: 'none' }}>{label}</span>
          <span aria-hidden="true" style={{ flex: 1, borderBottom: `1px dotted ${inkA(0.22)}`, transform: 'translateY(-2px)' }} />
          <span style={{ fontFamily: D.mono, fontSize: 10, color: inkA(0.85), flex: 'none', ...D.tabular }}>{value}</span>
        </div>
      ))}
      <div style={{ borderTop: `1px dashed ${inkA(0.25)}`, margin: '0.55rem 0 0.7rem' }} />

      <div className="dl2-story-row" style={{ ...monoCaps, fontSize: 8.5, letterSpacing: '0.18em', color: inkA(0.5), animationDelay: '1400ms' }}>
        Nothing waiting on you
      </div>

      <span
        className="dl2-story-stamp"
        style={{
          position: 'absolute',
          top: '2.5rem',
          right: '1.1rem',
          ...monoCaps,
          fontSize: 11.5,
          fontWeight: 600,
          letterSpacing: '0.22em',
          color: GREEN,
          border: `2px solid ${GREEN}`,
          borderRadius: 5,
          padding: '0.28rem 0.55rem 0.24rem',
          opacity: 0.9,
          animationDelay: '1700ms'
        }}
      >
        Closed
      </span>
    </div>
  </div>
);

const SLIDES = [AppWindowSlide, AskSlide, CloseSlide];

// ── Keyframes / responsive rules (scoped to this layer) ─────────────────────
const STORY_STYLES = (`
  @keyframes dl2StoryUp { from { opacity: 0; transform: translateY(16px) scale(0.985); } to { opacity: 1; transform: none; } }
  @keyframes dl2StoryRow { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  @keyframes dl2StoryStamp {
    0% { opacity: 0; transform: rotate(-8deg) scale(1.6); }
    60% { opacity: 0.9; transform: rotate(-8deg) scale(0.94); }
    100% { opacity: 0.9; transform: rotate(-8deg) scale(1); }
  }
  @keyframes dl2StoryTap { to { background: ${D.ink}; border-color: ${D.ink}; color: ${D.paper}; } }
  @keyframes dl2StoryDim { to { opacity: 0.35; } }
  .dl2-story-card { animation: dl2StoryUp 0.55s ${D.ease} both; }
  .dl2-story-row { animation: dl2StoryRow 0.4s ${D.ease} both; }
  .dl2-story-stamp { transform: rotate(-8deg); animation: dl2StoryStamp 0.45s ${D.ease} both; }
  .dl2-story-tap { animation: dl2StoryTap 0.3s ease both; }
  .dl2-story-dim { animation: dl2StoryDim 0.3s ease both; }
  .dl2-story-fill { transition: transform 120ms linear; }
  .dl2-story-zone { -webkit-tap-highlight-color: transparent; }
  @media (max-width: 820px) {
    .dl2-story-appside { display: none !important; }
    .dl2-story-scale { transform: scale(0.86); }
    .dl2-story-slidewrap { padding: 2.9rem 0.9rem 1rem !important; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dl2-story-card, .dl2-story-row, .dl2-story-stamp, .dl2-story-tap, .dl2-story-dim { animation: none !important; }
    .dl2-story-fill { transition: none !important; }
  }
`);

// ── The stories layer ───────────────────────────────────────────────────────
// Self-contained: owns the timer, the bar, the tap zones, and the active
// slide. `onSlideChange` lets BrandPanel pin its status ticker to the slide
// (Asking on the ask slide, Clean on the receipt). Memoized so the parent's
// 60ms typewriter re-renders don't cascade here; keep the callback stable.
export const HeroStories = memo(function HeroStories({ onSlideChange }) {
  const [reduce] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  // run increments on every navigation so a re-shown slide remounts and its
  // entrance animation replays (each loop restarts like an IG story).
  const [nav, setNav] = useState({ slide: 0, run: 0 });
  const [progress, setProgress] = useState(0); // 0..1 of the ACTIVE segment
  const slideRef = useRef(0);
  const elapsedRef = useRef(0);
  const pausedRef = useRef(false);

  const goTo = (index) => {
    const next = ((index % STORY_COUNT) + STORY_COUNT) % STORY_COUNT;
    slideRef.current = next;
    elapsedRef.current = 0;
    setProgress(0);
    setNav((n) => ({ slide: next, run: n.run + 1 }));
    if (onSlideChange) onSlideChange(next);
  };

  useEffect(() => {
    if (reduce) return undefined;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      elapsedRef.current += TICK_MS;
      const duration = DURATIONS[slideRef.current] || DURATIONS[0];
      if (elapsedRef.current >= duration) {
        goTo(slideRef.current + 1);
      } else {
        setProgress(elapsedRef.current / duration);
      }
    }, TICK_MS);
    return () => clearInterval(id);
    // goTo is stable in behavior (refs + setState); deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  const Slide = SLIDES[nav.slide];
  const pause = (on) => {
    pausedRef.current = on;
  };

  const zone = (left) => ({
    position: 'absolute',
    top: '2.6rem',
    bottom: 0,
    left: left ? 0 : '32%',
    width: left ? '32%' : '68%',
    zIndex: 2,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer'
  });

  return (
    <div
      style={{ position: 'absolute', inset: 0, zIndex: 4 }}
      onMouseEnter={() => pause(true)}
      onMouseLeave={() => pause(false)}
      onPointerDown={() => pause(true)}
      onPointerUp={() => pause(false)}
      onPointerCancel={() => pause(false)}
    >
      <style>{STORY_STYLES}</style>

      {/* active slide */}
      <div
        className="dl2-story-slidewrap"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4.4rem 1.5rem 2rem',
          pointerEvents: 'none'
        }}
      >
        <Slide key={`s${nav.slide}-r${nav.run}`} />
      </div>

      {/* IG tap zones — left third back, right two-thirds forward */}
      <button
        type="button"
        className="dl2-story-zone"
        aria-label="Previous story"
        style={zone(true)}
        onClick={() => goTo(nav.slide > 0 ? nav.slide - 1 : 0)}
      />
      <button
        type="button"
        className="dl2-story-zone"
        aria-label="Next story"
        style={zone(false)}
        onClick={() => goTo(nav.slide + 1)}
      />

      {/* segmented progress bar (the stories bar) */}
      <div
        style={{
          position: 'absolute',
          top: '0.85rem',
          left: 'clamp(1rem, 2.5vw, 1.6rem)',
          right: 'clamp(1rem, 2.5vw, 1.6rem)',
          zIndex: 3,
          display: 'flex',
          gap: 5
        }}
      >
        {SLIDES.map((_, i) => (
          <button
            key={i}
            type="button"
            className="dl2-story-zone"
            aria-label={`Story ${i + 1} of ${STORY_COUNT}`}
            aria-current={i === nav.slide ? 'true' : undefined}
            onClick={() => goTo(i)}
            style={{ flex: 1, background: 'transparent', border: 'none', padding: '5px 0', cursor: 'pointer' }}
          >
            <span
              style={{
                display: 'block',
                height: 3,
                borderRadius: 999,
                overflow: 'hidden',
                background: inkA(0.18)
              }}
            >
              <span
                className={i === nav.slide ? 'dl2-story-fill' : undefined}
                style={{
                  display: 'block',
                  height: '100%',
                  borderRadius: 999,
                  background: inkA(0.75),
                  transformOrigin: 'left center',
                  transform: `scaleX(${i < nav.slide ? 1 : i === nav.slide ? (reduce ? 1 : progress) : 0})`
                }}
              />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
});

export default HeroStories;
