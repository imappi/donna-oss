// ── Shared neutral primitives ───────────────────────────────────────────────
// One definition of the paper/ink neutrals, referenced by D, V and T alike.
// V and T were oatmeal (#F5F1E8 and #FBF8EC — two different oatmeals); Kari's
// 2026-07-28 call removed oatmeal from the product entirely, so their NEUTRAL
// entries now resolve to these instead of their old warm values.
//
// Why this is safe where a blanket hue swap would not be: a background is a
// background and a rule is a rule, so retargeting neutrals cannot collapse two
// different signals into one. The HUES (V.accent/pos/neg/intel,
// T.accent/alert/amber/ok) are NOT retargeted here — those are semantically
// ambiguous (accent vs alarm vs categorical) and still need per-usage
// decisions. See the handoff.
const INK = 'oklch(0.08 0 0)';
const INK_SOFT = 'oklch(0.08 0 0 / 0.72)';
// The previous 48% neutral rendered at 3.69:1 on white and failed WCAG AA for
// the small secondary labels used throughout the mounted interface. Keep this
// visually subordinate to INK_SOFT while retaining at least 4.5:1 contrast.
const INK_MUTE = 'oklch(0.08 0 0 / 0.56)';
// The ground is a bright warm off-white — "tokyo white" / alabaster, #FBFBF8 —
// NOT a neutral grey. This matters: a pure-neutral ground (chroma 0) reads as
// dim grey no matter how light it is, which is exactly how the first attempt at
// oklch(0.98 0 0) / #F8F8F8 came across. The fix is a whisper of chroma, not
// more lightness.
//
// Calibration, so nobody drifts this back toward oatmeal: T's oatmeal was
// #FBF8EC at chroma ~0.020. This is chroma 0.004 — five times less warm. Enough
// to stop it reading grey, nowhere near enough to read beige. If you raise the
// chroma here, you are heading back to oatmeal.
//
// Lightness: raised 0.987 → 0.994 (Kari, 2026-08-05 — "the white is too
// grey") once the panels-on-ground shell landed: the tinted GROUND now does
// the panel-vs-window separation, so paper can sit a whisper below pure
// white and CARD still pops via its borders/shadows plus the remaining step.
const PAPER = 'oklch(0.994 0.004 95)';
const PAPER_DEEP = 'oklch(0.975 0.004 95)';
const CARD = 'oklch(1 0 0)';
const RULE = 'oklch(0.08 0 0 / 0.15)';
const RULE_SOFT = 'oklch(0.08 0 0 / 0.08)';

// ── Sunset-family categorical ramp ──────────────────────────────────────────
// V and T each carried a full status vocabulary in hues D does not have: green
// (pos/ok), amber, violet (accent/intel) and two different reds. Kari's
// 2026-07-28 call is white + black + a SUBTLE sunset accent, so those hues are
// retargeted onto one ramp derived from the landing gradient's own stops.
//
// They are NOT all collapsed to ink, and that is deliberate. Several call sites
// need these to stay mutually distinguishable — e.g. financials renders
// `fillColors = [T.ink, T.amber, T.accent, T.ok, T.alert]` as a five-way chart
// palette, and a naive collapse would silently render four of the five
// identical. The ramp keeps five separable steps while staying inside the
// black -> graphite -> gold -> orange -> brick sunset family.
//
// Each *Soft entry is the low-alpha wash of its own solid, so a chip's
// { bg, fg } pair stays internally consistent wherever it is used.
const GRAPHITE = 'oklch(0.42 0 0)';                 // settled / informational
const GRAPHITE_WASH = 'oklch(0.08 0 0 / 0.06)';
const GOLD = 'oklch(0.48 0.10 75)';                 // attention (was amber); AA on GOLD_WASH
const GOLD_WASH = 'oklch(0.70 0.13 75 / 0.15)';
const ORANGE = 'oklch(0.58 0.15 45)';               // active / in-flight (was violet)
const ORANGE_WASH = 'oklch(0.65 0.16 45 / 0.13)';
const BRICK = 'oklch(0.45 0.13 25)';                // genuine failure
const BRICK_WASH = 'oklch(0.45 0.13 25 / 0.10)';

// Firm/operator palette — oatmeal + hard red. BEING RETIRED onto D per Kari's
// 2026-07-28 design call (see the D block below). Do not start new surfaces on
// V, and do not delete it until zero importers remain — a half-migrated tree
// needs both. Check with: grep -rl "\bV\b" on the design-tokens imports.
export const V = {
  bg: PAPER,
  bgDeep: PAPER_DEEP,
  surface: CARD,
  surfaceAlt: PAPER_DEEP,
  surfaceHover: RULE_SOFT,

  border: RULE,
  borderSubtle: RULE_SOFT,

  t1: INK,
  t2: INK_SOFT,
  t3: INK_MUTE,
  t4: INK_MUTE,

  accent: ORANGE,
  accentSurface: ORANGE_WASH,
  pos: GRAPHITE,
  posSurface: GRAPHITE_WASH,
  neg: BRICK,
  negSurface: BRICK_WASH,
  // ORANGE, not graphite: `intel` is in-flight/AI-explained state and several
  // live call sites render `intel : pos` as a distinguishing ternary
  // (ReviewQueue, transaction-artifact, document-chat), so it must stay
  // separable from `pos`. It never appears alongside `accent` as a comparison
  // — there `accent` is only ever a button hover — so sharing that step is safe.
  intel: ORANGE,
  intelSurface: ORANGE_WASH
};

// Donna workspace palette — a second, different light oatmeal (#FBF8EC vs V's
// #F5F1E8). Used by the Profile / People / Compliance redesign and most
// financials panels. BEING RETIRED onto D per Kari's 2026-07-28 design call
// (see the D block below); same rule as V — no new surfaces, no deletion until
// zero importers remain.
export const T = {
  page: PAPER,
  paper: CARD,
  card: CARD,
  ink: INK,
  inkSoft: INK_SOFT,
  muted: INK_MUTE,
  mutedSoft: INK_MUTE,
  rule: RULE,
  ruleSoft: RULE_SOFT,
  ruleMicro: RULE_SOFT,
  alert: BRICK,
  alertSoft: BRICK_WASH,
  accent: ORANGE,
  accentSoft: ORANGE_WASH,
  amber: GOLD,
  amberSoft: GOLD_WASH,
  ok: GRAPHITE,
  okSoft: GRAPHITE_WASH,
  serif: "'Instrument Serif', 'Source Serif 4', Georgia, serif",
  sans: "var(--donna-content-font)",
  mono: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
};

// Dossier palette — paper + ink editorial aesthetic, OKLCH only. THE TARGET
// SYSTEM for every surface: landing, client portal, and (as of 2026-07-28) the
// operator/admin surfaces too.
//
// This comment used to read "Do not migrate operator surfaces to D without an
// explicit design call — Firms / Profile / People / Compliance remain on T / V."
// Kari made that call on 2026-07-28: white, black, and the sunset gradient used
// subtly, bigger type, aligned across the whole system — so V and T surfaces are
// migrating to D. The rail is retired, not violated.
//
// Two things it was protecting still hold:
//   - The gradient stays scarce. Operator surfaces use the FLAT accent
//     (D.accentWarmFlat / D.noiseGold); D.gradientGrain and D.landingGradient
//     are for the landing's big moments. One gradient moment per screen at most.
//   - D is paper + ink + warm. It has no green, no amber, no violet. When you
//     migrate a coloured V/T chip, decide whether it is ACCENT or ALARM: accent
//     is the warm token, alarm is D.alert, and settled/quiet states are ink at
//     full/48% opacity. Do not smuggle a fifth hue back in.
export const D = {
  // The ground is OFF-white and containers are PURE white, so cards pop off the
  // page rather than being outlined on it (Kari, 2026-07-28). This is what the
  // landing already does — its cards are literal '#fff' sitting on a grey hero
  // panel. An earlier pass set card == page and separated by rule only; that
  // was wrong for this system.
  paper: PAPER,
  paperDeep: PAPER_DEEP,
  card: CARD,
  ink: INK,
  inkSoft: INK_SOFT,
  inkMute: INK_MUTE,
  accentWarm: 'oklch(0.72 0.12 65 / 0.92)',
  accentWarmFlat: 'oklch(0.72 0.12 65)',
  // Deep brick red for genuine failure states (errors, statements that don't
  // foot). Financial-statement surfaces must NOT use the warm accent as an
  // alarm color — amounts stay ink, negatives render in parentheses, and this
  // token is reserved for the rare true problem.
  alert: 'oklch(0.45 0.13 25)',

  // Soft washes for chip/badge backgrounds. Added when the shared primitives
  // moved off V/T, which both carried their own *Soft surface colours — without
  // these every migrated call site would invent its own alpha and the drift
  // would start again. Pair each wash with its solid token as the foreground.
  accentWash: 'oklch(0.72 0.12 65 / 0.14)',
  alertWash: 'oklch(0.45 0.13 25 / 0.10)',

  rule: RULE,
  ruleSoft: RULE_SOFT,

  display: "'Anton', 'Anton Local', Impact, 'Arial Narrow', sans-serif",
  body: "var(--donna-body-font)",
  // The platform UI face — CHROME ONLY (sidebars, rails, menus, settings
  // screens). Kari, 2026-08-07: DM Sans at 500/600 reads "almost bolded"
  // in chrome — it's a rounded geometric that saturates at medium weights —
  // while the references (Codex, Claude Code, Buzz) all run the system
  // font there. Content/data surfaces KEEP T.sans (DM Sans, the editorial
  // voice — "bookkeeping data screens, inbox content look nice"); do not
  // sweep content onto this token without a dated call.
  ui: "var(--donna-ui-font)",
  mono: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",

  // ── The two-voice type doctrine (Kari, 2026-08-08) ───────────────────
  // AMENDS the CHROME-ONLY scope on `ui` above, after an external design
  // review Kari accepted. That review's charge: three typographic voices
  // plus 508 mono references (~a third of visible type) read editorial and
  // constructed — "an expensive invoicing SaaS", not an operating
  // environment. The destination is TWO voices in the app, with the brand
  // keeping the third:
  //
  //   D.ui   — the native system face, the app's ~98%. Hierarchy comes from
  //            size, weight and spacing, never from switching typefaces.
  //            Deliberately not Inter: a Google Font reads as "a designer
  //            picked this"; the system face reads as software.
  //   D.mono — the MACHINE voice only. The rule, so it cannot drift back:
  //            mono is for what you would paste into a bug report — ids,
  //            model ids, receipts, JSON, logs — plus the mascot's visor,
  //            which is character language. Money is NOT machine output:
  //            amounts align through D.tabular, never through a face swap.
  //
  // D.serif / D.display stay for the BRAND (landing, emails, onboarding).
  // Donna the brand may be expressive; Donna the working environment is
  // boringly authoritative — the accounting-runtime rail in CLAUDE.md,
  // applied to type. Serif is OUT of the app (Kari, 2026-08-08).
  //
  // HONEST TENSION, recorded rather than resolved silently: the 2026-08-07
  // note above keeps content/data surfaces on T.sans because DM Sans
  // "looks nice" there. Today's call points content at D.ui too. Chrome is
  // authorized under BOTH calls and has moved; CONTENT (feed rows, tables,
  // chat bodies) is staged separately so Kari judges it on screen before it
  // sweeps. If he prefers DM Sans for data after seeing it, that is a live
  // option — do not treat the content sweep as settled.
  //
  // T.sans and D.body retire onto this token as surfaces migrate (the same
  // treatment V and T are under): no new surfaces on them, no deletion
  // until zero importers remain.

  // Spread into any style that renders figures — amounts, counts, dates.
  // This is what replaces mono for alignment: same face as its label, but
  // digits of equal width so columns line up and a live count doesn't
  // jitter. Accounting ≠ monospace; that was a 1970s constraint, not a
  // design decision.
  tabular: { fontVariantNumeric: 'tabular-nums' },

  // Icon geometry. Icons used to read as tiny website glyphs beside their
  // labels (15px at 1.8 stroke in a 15px slot) and visually disappeared.
  // One weight everywhere: selection is carried by ink and background,
  // never by a heavier icon.
  icon: { size: 18, slot: 22, stroke: 1.8, gap: 11 },

  // Left-rail width. ONE definition, because this number is not private to
  // the sidebar: the settings rail and drop overlay both size against it, so
  // a rail that widens without them leaves navigation and drop zones behind.
  // It used to
  // live as `260` inline in FirmSidebar plus two hand-copied SIDEBAR_WIDTH
  // consts carrying "keep in sync" comments — which is a trap, not a
  // contract. Read this token; never re-copy the number.
  //
  // 296, up from 260 (Kari, 2026-08-08, ~14% — entity names like "Honeybee
  // Hills Apiary LLC" were ellipsizing in a rail with room to spare). 260
  // was itself up from 220 on 2026-08-05.
  rail: 296,
  // Workspace content measure. The ONE width every entity tab and subtab
  // caps and centers at — applied once in FirmOpsConsole below the entity
  // toolbar, so no tab can bleed while a sibling caps. 1240 is the measured
  // correction from the 2026-08-10 side-by-side: the 1120 cap rendered about
  // 10% narrower than the Claude reference once the desktop pane and display
  // scale were accounted for. This is deliberately still below the same-day
  // 1520 full-pane detour. Read the token, never re-copy the number.
  measure: 1240,
  // Editorial heading serif. D shipped without this: DonnaLanding.jsx — the
  // reference implementation of the target look — defined the identical stack
  // as a LOCAL const because there was no token for it, and T carried its own
  // copy as T.serif. Three copies of one decision. The landing's h1 now reads
  // this token, so operator headings migrating off T.serif keep the same face
  // instead of being forced onto Anton, which is display-only.
  serif: "'Instrument Serif', 'Source Serif 4', Georgia, serif",
  // Distinct from `serif` on purpose — Georgia-first, for italic asides.
  serifItalic: "Georgia, 'Source Serif 4', serif",

  // ── Type scale ────────────────────────────────────────────────────────
  // STATUS: defined but NOT YET APPLIED anywhere. A first pass moved call
  // sites onto it and got the emphasis wrong — it enlarged CHROME (sidebar,
  // tab strip, chips), which was already fine, while the text that actually
  // needs help (body copy inside content — review-queue items, chat and
  // message bodies, case narrative) was left alone. That pass was reverted;
  // Kari is redoing typography surgically. The scale is kept because the
  // measurement below still holds and a scale is still the right shape for
  // the fix — but treat these values as a STARTING POINT to argue with, not
  // as settled. Do not bulk-apply it again.
  //
  // The single source of font sizes for D surfaces. Before this existed the
  // tree carried 20 ad-hoc `rem` sizes AND ~1,170 raw px sizes, 92% of them
  // at 13px or below (563 usages sat at 10–11px). "Bigger fonts for
  // readability" is therefore a MISSING SCALE, not a set of numbers to bump:
  // bumping call sites without a scale just rebuilds the same mess one size
  // larger. Add sizes here; do not reintroduce ad-hoc values at call sites.
  //
  // All values are rem so the whole system honours the user's browser font
  // size. `base` is the body floor — 1rem. Nothing that carries a sentence
  // the operator must READ may go below it; the two sub-base steps are for
  // chips, table meta, and mono eyebrows only.
  //
  // Migration map from the legacy px values (use this when moving a call
  // site, so the same source size lands on the same step everywhere):
  //
  //     9, 10, 10.5 px  → micro (12px)   mono caps, eyebrows, column heads
  //     11 px           → xs    (13px)   chips, badges, dense table meta
  //     12 px           → sm    (14px)   secondary text, table cells
  //     13, 13.5, 14 px → base  (16px)   body — the floor
  //     15, 16 px       → md    (18px)   emphasised body, lead-in
  //     18 px           → lg    (21px)   card values, section headings
  //     22, 24, 26 px   → xl    (26px)   panel titles
  //     28, 30 px       → xxl   (32px)   screen titles
  //     34, 36 px       → xxxl  (40px)   hero figures
  //
  // Display type (Anton) stays on `displayClamp` — it is fluid, not stepped.
  text: {
    micro: '0.75rem',    // 12px — floor for mono caps/eyebrows. Never body.
    xs: '0.8125rem',     // 13px — chips, badges, dense table meta.
    sm: '0.875rem',      // 14px — secondary text, table cells.
    base: '1rem',        // 16px — BODY FLOOR. Default for readable prose.
    md: '1.125rem',      // 18px — emphasised body, lead-in paragraphs.
    lg: '1.3125rem',     // 21px — card values, section headings.
    xl: '1.625rem',      // 26px — panel titles.
    xxl: '2rem',         // 32px — screen titles.
    xxxl: '2.5rem'       // 40px — hero figures.
  },

  tracking: {
    tighter: '-0.025em',
    tight: '-0.01em',
    body: '0',
    wide: '0.025em',
    widest: '0.1em',
    // Mono caps default tightened from the spec's 0.25em to 0.18em
    // per the v2 critique: micro labels in dossier were "too tiny and
    // spaced out" to read at task speed. monoExtra (0.25em) stays for
    // the rare cases that need the original cadence.
    mono: '0.18em',
    monoExtra: '0.25em'
  },
  leading: {
    display: 0.85,
    displayLoose: 0.95,
    body: 1.5,
    mono: 1.2
  },
  pad: {
    x: '1.5rem',
    xLg: '2.5rem',
    sectionY: '6rem',
    sectionYLg: '10rem',
    gapTight: '1.5rem',
    gap: '2.5rem'
  },
  container: '80rem',
  radius: '0.25rem',
  ease: 'cubic-bezier(0.2, 0, 0, 1)'
};

// Editorial display clamp — fluid Anton sizing per spec (hero defaults to
// 4rem → 15vw → 13rem, sub-headlines smaller).
D.displayClamp = (minRem, vw, maxRem) => `clamp(${minRem}rem, ${vw}vw, ${maxRem}rem)`;

// SVG fractal-noise data URIs. Spec values: noise-gold (CTA accent surfaces)
// baseFrequency=1.2 / numOctaves=3 / opacity=0.18 with multiply blend; grain
// (page background) baseFrequency=0.9 / numOctaves=2 / opacity=0.08. Kept as
// URL-encoded UTF-8 so they paste cleanly into background-image.
const noiseGoldSvg =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>" +
      "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='3' stitchTiles='stitch'/></filter>" +
      "<rect width='100%' height='100%' filter='url(#n)' opacity='0.18'/>" +
      "</svg>"
  );
const grainSvg =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 240'>" +
      "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter>" +
      "<rect width='100%' height='100%' filter='url(#n)' opacity='0.08'/>" +
      "</svg>"
  );

// Returns inline-style fragment for an accent surface — flat accent base with
// the gold-noise SVG laid over it in multiply blend. Spread into a style object.
D.noiseGold = (overrides = {}) => ({
  backgroundColor: D.accentWarmFlat,
  backgroundImage: `url("${noiseGoldSvg}")`,
  backgroundBlendMode: 'multiply',
  backgroundSize: '200px 200px',
  ...overrides
});

// Page-level grain overlay. Spread into the outermost wrapper's style so the
// texture sits above the paper base. Does not change the base color.
D.grainBg = (overrides = {}) => ({
  backgroundColor: D.paper,
  backgroundImage: `url("${grainSvg}")`,
  backgroundSize: '240px 240px',
  backgroundRepeat: 'repeat',
  ...overrides
});

// ── The shell ground + panel (panels-on-ground, Kari 2026-08-05) ────────────
// The desktop window's own surface, on which the workspace surfaces float as
// panels (the Buzz-reference architecture, in Donna's own palette): the
// sidebar is transparent chrome on the ground; the workspace is a rounded
// PAPER panel with gutters showing the ground; inner cards stay pure white
// popping off paper — the existing three-level doctrine, promoted one level
// up to the shell.
//
// The ground is the SUNSET family at whisper strength: the landing gradient's
// own hue stops (gold → orange → red-ish) at ground lightness/chroma. This is
// ground, not a gradient moment — the "gradient stays scarce" rail still
// governs painted accents, and the full-strength sweep remains landing-only.
// If you raise the chroma here much past 0.02 you are painting the admin
// chrome with the landing gradient; don't.
const groundGradient =
  'linear-gradient(160deg, ' +
  'oklch(0.972 0.016 85) 0%, ' + // whisper gold
  'oklch(0.960 0.018 58) 55%, ' + // whisper orange
  'oklch(0.945 0.020 40) 100%)'; // whisper red-ish
D.groundColor = 'oklch(0.960 0.018 58)';
// Grain over the gradient, same texture the landing ground carries.
D.groundImage = `url("${grainSvg}"), ${groundGradient}`;
D.groundSize = '240px 240px, cover';
D.groundRepeat = 'repeat, no-repeat';
D.groundBg = (overrides = {}) => ({
  backgroundColor: D.groundColor,
  backgroundImage: D.groundImage,
  backgroundSize: D.groundSize,
  backgroundRepeat: D.groundRepeat,
  ...overrides
});

// The floating-panel treatment for a workspace surface on the ground.
D.shellGutter = '10px';
D.panelRadius = '14px';
D.panelShadow = '0 1px 2px oklch(0.08 0 0 / 0.04), 0 8px 28px oklch(0.08 0 0 / 0.07)';

// Marketing signature surface — the landing page's gold→orange→red sweep with
// the gold-noise SVG laid over it in `multiply` so it reads gritty, not glossy.
// The operator/portal surfaces use the FLAT accent (`noiseGold`); this gradient
// is landing-only and intentionally used big and sparingly (hero backdrop,
// closing CTA band). Operator surfaces get ONE gradient moment per screen at
// most — everything else uses the flat accent.
//
// These stops were previously attributed to
// docs/donna-landing-page-design-handoff.md §2.1. That file has never existed
// in this repo; the citation was dangling and cost a later session a search.
// THIS FILE IS THE SPEC — the values below are authoritative, not a copy.
// Spread into a style object.
const landingGradient =
  'linear-gradient(135deg, ' +
  'oklch(0.80 0.12 78) 0%, ' + // warm gold
  'oklch(0.70 0.17 50) 48%, ' + // orange
  'oklch(0.58 0.20 32) 100%)'; // red-ish
D.gradientGrain = (overrides = {}) => ({
  backgroundColor: D.accentWarmFlat,
  backgroundImage: `url("${noiseGoldSvg}"), ${landingGradient}`,
  backgroundBlendMode: 'multiply, normal',
  backgroundSize: '200px 200px, cover',
  backgroundRepeat: 'repeat, no-repeat',
  ...overrides
});

// The raw gold→orange→red sweep (no grain), for smaller accents that want the
// sunset color but not the gritty multiply texture — gradient borders, badges,
// the back-button hover. Same spec stops as `gradientGrain` above.
D.landingGradient = landingGradient;

// Subtle sunset moment for operator surfaces: a 1px gradient BORDER with a
// flat fill inside, so the sweep reads as a hairline accent rather than a
// painted panel. Same padding-box/border-box technique the landing uses on its
// pricing card. This is the sanctioned way to put the gradient on an admin
// control — do not fill admin chrome with `gradientGrain`.
D.gradientBorder = (fill = CARD) => ({
  background: `linear-gradient(${fill}, ${fill}) padding-box, ${landingGradient} border-box`,
  border: '1px solid transparent'
});

export const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Anton' +
  '&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400' +
  '&family=Inter:wght@400;500;600;700' +
  '&family=Instrument+Serif:ital@0;1' +
  '&family=JetBrains+Mono:wght@400;500;600&display=swap';
