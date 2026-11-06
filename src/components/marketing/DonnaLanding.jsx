// Donna — public marketing landing page (v2).
//
// Ported from the Donna Landing v2 design (Claude Design file
// `Donna Landing v2.dc.html`). Single-viewport, two-column screen: a paper
// "entry" column on the left that steps through the funnel
// (entry → qualify → pick-months → checkout, or sign-in) and an animated
// gold→red brand panel on the right, which runs the hero product stories —
// the desktop app, the one ask, the close receipt — behind an IG-style
// segmented bar (HeroStories.jsx; Kari, 2026-08-28). Selecting a plan swaps
// to a two-pane detail screen: left = cover art + plan write-up, right =
// checkout.
//
// Auth wiring ("real auth, honest checkout"): the funnel lives IN this page
// rather than redirecting to the firm workspace gate. Sign-in / create-account
// call the REAL Supabase auth (`startGoogleSignIn` / `signInWithPassword` /
// `signUp`); on success the authenticated user lands on `/firms` (the app).
//
// Payments ("honest checkout, card capture on Stripe's hosted page"): Stripe IS
// wired now — hosted Checkout via the billing endpoints, verified in prod. A
// hand-rolled card form would be a PCI / SCA liability, so the LANDING captures
// NO card data: the checkout creates a real account (email + password) and the
// card slot stays an honest placeholder. ClientPortalGate then redeems the
// stashed offer into Stripe's hosted Checkout on the next step (see the
// offer-stash / ClientPortalGate note below). No card ever touches our code.
//
// Trust-the-strong-LLM principle — still in force (see CLAUDE.md and
// docs/donna-llm-trust-strategy.md): no fake "Secured by Stripe" / live card
// capture; the brand panel art is decorative illustration, not metrics.

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { D } from '../shared/design-tokens.js';
import { HeroStories } from './HeroStories.jsx';
import {
  signInWithPassword,
  signUp,
  startGoogleSignIn,
  requestPasswordReset,
  resendConfirmation,
  updatePassword
} from '../../lib/supabaseAuth.js';
import {
  BANDS as PRICE_BANDS,
  getBand,
  priceForBand,
  RECURRING_MONTHLY_PRICE,
  unitPriceFor,
  amountFor,
  fmt,
  fmtEur,
  FINLAND_PILOT_MONTHLY_PRICE_EUR,
  finlandBandPriceEur,
  CATCH_UP_MIN,
  CATCH_UP_MAX,
  CATCH_UP_DEFAULT
} from '../../lib/pricing.js';
import { submitWaitlist } from '../../lib/waitlist.js';
import { qualificationDecision } from '../../lib/qualificationGate.js';
import { stashPendingOffer } from '../../lib/pendingOffer.js';
import { stashConfirmEmail, readConfirmEmail, clearConfirmEmail } from '../../lib/pendingConfirm.js';
import { trackEvent } from '../../lib/analytics.js';

// Entry price shown under the hero CTA. Derived from pricing.js (the single
// source of truth) — the cheapest band — so it can't drift from the real
// price. "From $50" not "$50": it's the under-200-tx band; bigger books bill
// more. fmt() yields the "$50" form.
const STARTING_PRICE = fmt(Math.min(...PRICE_BANDS.map((b) => b.price)));

// The footer "Firms" target — the bookkeeper/firm console.
const APP_ROUTE = '/firms';
// Where the SIGNUP funnel sends a business owner after auth. Not /firms: owners
// aren't firm members and the firm console only 401s them. /start provisions
// their client workspace and forwards to /client/:id → Checkout → portal.
// NOTE: this path must be in Supabase Auth → URL configuration → Redirect URLs,
// or GoTrue ignores the Google redirect_to and falls back to the Site URL.
const POST_AUTH_ROUTE = '/start';
// Footer informational links now resolve to real routed pages
// (src/components/marketing/MarketingPage.jsx), not mailto stubs.
const FOOTER_LINKS = [
  { label: 'FAQ', href: '/faq' },
  { label: 'Terms', href: '/terms' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Security', href: '/security' },
  { label: 'Claude', href: '/claude' },
  { label: 'Firms', href: APP_ROUTE, strong: true }
];

// ── Qualification (Screen 1) ─────────────────────────────────────────────────
// Four single-select questions filter for fit BEFORE any price is shown.
// Service and commerce businesses with a real volume band are eligible;
// everything else routes to the unfit waitlist gate — no down-tier, no cheaper
// option, no card form for an unfit visitor.
//
// Gate revision (Kari, 2026-07-05 — docs/design-donna-prospecting.md §3B/§11.10,
// P0E): the products/inventory business type is no longer a hard reject — it is
// a SCOPING gate. Commerce is accepted with the promise scoped to payout/bank
// reconciliation and monthly closes; unscoped inventory/COGS accounting is
// explicitly NOT promised (flagged and escalated, never silently guessed).
// Creators count as service businesses, with the merch-is-inventory nuance
// stated in the copy below. The volume (>1,000/mo) and remediation screens are
// UNTOUCHED — kinder gate, never looser.
const BIZ_TYPES = [
  { id: 'service', label: 'Service business, incl. creators & agencies', eligible: true },
  { id: 'products', label: 'Sells physical products / inventory', eligible: true, scoped: true },
  { id: 'restaurant', label: 'Restaurant / food', eligible: false, reason: 'restaurant' },
  { id: 'other', label: 'Something else', eligible: false, reason: 'other' }
];
const COMMERCE_SCOPE_NOTE =
  'Commerce scope, said up front: Donna reconciles your payouts, fees, refunds, and bank evidence, and closes the month. ' +
  'Full inventory/COGS accounting (stock valuation, landed cost) isn’t part of the promise. Anything beyond scope is raised to you, never guessed.';
const CREATOR_GATE_NOTE =
  'Creators, coaches, and platform sellers of services count as service businesses, unless selling merch or products is the main business.';
// Volume options map onto the pricing bands; "more than 1,000" is intentionally
// NOT a band — it is the unfit/volume gate.
const VOLUME_OPTIONS = [
  ...PRICE_BANDS.map((b) => ({ id: b.id, label: capitalizeFirst(b.label), bandId: b.id })),
  { id: 'over', label: 'More than 1,000', bandId: null, reason: 'volume' }
];
const COUNTRY_OPTIONS = [
  { id: 'FI', label: 'Finland' },
  { id: 'GB', label: 'United Kingdom' },
  { id: 'other', label: 'Another country' }
];
const SWITCHER_OPTIONS = [
  { id: 'no', label: 'No — these are new books' },
  { id: 'yes', label: 'Yes — switching mid-year' }
];

// Offer presentation per kind (the three doors / the checkout cover). The
// badge on all three carries the AI-operated honest promise (CLAUDE.md,
// Kari 2026-07-13): Donna runs the books, you decide. No hidden human back
// office reviews every transaction.
//
// History: launch copy said "Human-reviewed", then "Human-monitored" (the
// monitor-and-correct framing). Both are RETIRED: the 2026-07-13 AI-operated
// re-amendment removed the human-monitoring layer entirely. Do NOT drift back
// to "human-monitored" / "human-reviewed" / "a human checks" language; the
// human in the loop is the OWNER (facts, approval, decisions), never a Donna
// bookkeeper.
const KIND_META = {
  one_month: { idx: '01', word: 'CLOSE', title: 'One month' },
  catch_up: { idx: '02', word: 'CATCH UP', title: 'Catch me up' },
  recurring: { idx: '03', word: 'CURRENT', title: 'Keep me current' }
};
const OFFER_BADGE = 'You decide, Donna runs it';

// ── Finnish localization (lang='fi', the /fi route) ─────────────────────────
// Same component, same funnel, same behavior — Finnish copy + euro prices. The
// English path is byte-identical: L() returns the source string when lang!=='fi'
// (or when a key is missing), and money() falls back to USD fmt(). Keys are the
// exact English source strings so a missing translation degrades to English
// rather than a blank. Copy discipline (CLAUDE.md rails): the AI-operated honest
// promise (Kari 2026-07-13) — Donna runs the books herself, no hidden human back
// office reviews every transaction, she asks the owner only when a fact,
// approval, or decision is theirs to give. Do NOT use "ihmisen valvoma" /
// "ihminen tarkistaa" (the retired human-monitored framing). ALV/tilinpäätös
// framed as coming, not a live fact; prices from pricing.js only.
// The English source keys now carry the same AI-operated honest promise (the
// English/root honest-promise + em-dash sweep, 2026-07-13); a few Finnish
// VALUES still contain em dashes, pending the separate /fi em-dash sweep.
const FI_COPY = {
  // Entry
  'AI bookkeeping that asks only when you’re needed': 'Tekoälykirjanpito, joka kysyy vain kun sinua tarvitaan',
  'Drop your docs. Donna closes your books.': 'Lähetä tositteet. Donna sulkee kirjanpitosi.',
  'Close my first month': 'Sulje ensimmäinen kuukauteni',
  'Already set up?': 'Onko tili jo olemassa?',
  'Sign in': 'Kirjaudu sisään',
  'Statements, receipts, invoices, send them however. Donna codes every line and posts double-entry to your own Xero or QuickBooks. She asks you only when your facts or a decision are needed. You don’t need to know debits from credits.':
    'Tiliotteet, kuitit, laskut: lähetä miten haluat. Donna kirjaa jokaisen rivin ja vie kahdenkertaisen kirjauksen omaan Xeroosi tai QuickBooksiisi. Hän kysyy sinulta vain, kun tarvitaan tietosi tai päätöksesi. Sinun ei tarvitse tuntea debetiä ja krediittiä.',
  'For single-owner service and commerce businesses. Inventory accounting only when scoped.':
    'Yhden omistajan palvelu- ja kaupan yrityksille. Varastokirjanpito vain erikseen sovittaessa.',
  // Sign in
  'Welcome back.': 'Tervetuloa takaisin.',
  'Sign in to pick up where Donna left off.': 'Kirjaudu ja jatka siitä mihin Donna jäi.',
  'Continue with Google': 'Jatka Googlella',
  Email: 'Sähköposti',
  Password: 'Salasana',
  'Your password': 'Salasanasi',
  'Signing in…': 'Kirjaudutaan…',
  'Continue with email': 'Jatka sähköpostilla',
  'Forgot password?': 'Unohtuiko salasana?',
  'Resend confirmation email': 'Lähetä vahvistusviesti uudelleen',
  'New to Donna?': 'Uusi Donnan käyttäjä?',
  'Get your books done': 'Hoida kirjanpitosi',
  // Forgot / reset
  Back: 'Takaisin',
  'Back to sign in': 'Takaisin kirjautumiseen',
  'Reset your password.': 'Nollaa salasanasi.',
  'Enter your email and we’ll send a link to set a new password.':
    'Anna sähköpostisi, niin lähetämme linkin uuden salasanan asettamiseen.',
  'Sending…': 'Lähetetään…',
  'Send reset link': 'Lähetä nollauslinkki',
  'Set a new password.': 'Aseta uusi salasana.',
  'Choose a new password for your account. You’ll be signed in right after.':
    'Valitse tilillesi uusi salasana. Sinut kirjataan sisään heti sen jälkeen.',
  'New password': 'Uusi salasana',
  'At least 8 characters': 'Vähintään 8 merkkiä',
  'Saving…': 'Tallennetaan…',
  'Save password & sign in': 'Tallenna salasana ja kirjaudu',
  'Need a fresh reset link?': 'Tarvitsetko uuden nollauslinkin?',
  // Qualify
  'Two quick questions.': 'Kaksi nopeaa kysymystä.',
  'So Donna only takes on books she can close cleanly.':
    'Jotta Donna ottaa vain kirjat, jotka se pystyy sulkemaan siististi.',
  'What kind of business?': 'Millainen yritys?',
  'Service business, incl. creators & agencies': 'Palveluyritys — myös luovat alat ja toimistot',
  'Sells physical products / inventory': 'Myy fyysisiä tuotteita / varasto',
  'Restaurant / food': 'Ravintola / ruoka',
  'Something else': 'Jokin muu',
  'Creators, coaches, and platform sellers of services count as service businesses, unless selling merch or products is the main business.':
    'Sisällöntuottajat, valmentajat ja palveluiden alustamyyjät lasketaan palveluyrityksiksi — ellei oheistuotteiden tai tavaroiden myynti ole päätoimintaa.',
  'Typical monthly transactions': 'Tyypilliset kuukausittaiset tapahtumat',
  'See my price': 'Näytä hintani',
  'Under 200': 'Alle 200',
  '500–1,000': '500–1 000',
  'More than 1,000': 'Yli 1 000',
  // Unfit
  'Donna isn’t the right fit yet': 'Donna ei ole vielä oikea valinta',
  'Donna’s built for single-entity service and commerce businesses on cash or accrual. Yours has complexity Donna can’t close cleanly today, and we’d rather tell you now than after you’ve paid.':
    'Donna on rakennettu yhden yksikön palvelu- ja kaupan yrityksille (kassa- tai suoriteperuste). Sinun kirjoissasi on monimutkaisuutta, jota Donna ei tänään sulje siististi — kerromme sen mieluummin nyt kuin maksun jälkeen.',
  'Thanks. We’ll be in touch when Donna can take this on.':
    'Kiitos. Otamme yhteyttä, kun Donna voi ottaa tämän hoitaakseen.',
  'Notify me': 'Ilmoita minulle',
  // Months / doors
  'How far do you want Donna to go?': 'Kuinka pitkälle haluat Donnan menevän?',
  'One month': 'Yksi kuukausi',
  'Close one month. Try Donna, or just handle the month you care about.':
    'Sulje yksi kuukausi. Kokeile Donnaa tai hoida vain se kuukausi, joka on tärkeä.',
  'one monthly close': 'yksi kuukausisulku',
  Start: 'Aloita',
  'Catch me up': 'Ota kiinni',
  'most firms here': 'suosituin',
  'Behind on your books? Tell Donna how many months, she closes them all and hands you clean books.':
    'Kirjat rästissä? Kerro Donnalle montako kuukautta, se sulkee kaikki ja antaa sinulle valmiit kirjat.',
  'Months behind': 'Kuukausia rästissä',
  'Keep me current': 'Pidä ajan tasalla',
  'Donna closes every month as it comes. Stop anytime, one tap, no cancel maze.':
    'Donna sulkee jokaisen kuukauden sitä mukaa. Lopeta milloin vain, yhdellä napautuksella, ei peruutussokkeloa.',
  'per month · Donna closes every month': 'kuukaudessa · Donna sulkee joka kuukauden',
  'Donna handles the close and shows you what she did. She asks you only when your facts, approval, or a decision are needed. No hidden back office reviews your books.':
    'Donna hoitaa sulun ja näyttää mitä teki. Hän kysyy sinulta vain, kun tarvitaan tietosi, hyväksyntäsi tai päätöksesi. Kirjojasi ei tarkista piilotettu taustatiimi.',
  // Detail / checkout
  Months: 'Kuukaudet',
  'One monthly close': 'Yksi kuukausisulku',
  'Donna asks you only when the decision is yours': 'Donna kysyy sinulta vain, kun päätös on sinun',
  'Real double-entry posted to your own Xero (QuickBooks in rollout)':
    'Aito kahdenkertainen kirjaus omaan Xeroosi (QuickBooks tulossa)',
  'Donna codes and matches; exceptions come to you to decide':
    'Donna hoitaa kirjaukset ja täsmäytykset, poikkeukset sinun päätettäviksesi',
  'Donna asks only when the decision is yours, and that’s on every option.':
    'Donna kysyy vain, kun päätös on sinun, ja se kuuluu jokaiseen vaihtoehtoon.',
  'Your order': 'Tilauksesi',
  'Business name': 'Yrityksen nimi',
  'Your business name': 'Yrityksesi nimi',
  'Work email': 'Työsähköposti',
  'Choose a password': 'Valitse salasana',
  Payment: 'Maksu',
  'Create your account now. You’ll complete secure card payment via Stripe on the next step.':
    'Luo tili nyt. Otamme sinuun yhteyttä ja käynnistämme pilotin — korttimaksua ei nyt tarvita.',
  'Creating account…': 'Luodaan tiliä…',
  'Create your account': 'Luo tili',
  'Cancel anytime · we email you a confirmation link': 'Peru milloin vain · lähetämme vahvistuslinkin sähköpostiisi',
  // Confirm
  'Confirm your email': 'Vahvista sähköpostisi',
  'Check your inbox.': 'Tarkista sähköpostisi.',
  'your email': 'sähköpostiisi',
  'Didn’t get it?': 'Etkö saanut viestiä?',
  // Footer
  FAQ: 'UKK',
  Terms: 'Käyttöehdot',
  Privacy: 'Tietosuoja',
  Security: 'Tietoturva',
  // Badge + notes
  'You decide, Donna runs it': 'Sinä päätät, Donna hoitaa',
  'Commerce scope, said up front: Donna reconciles your payouts, fees, refunds, and bank evidence, and closes the month. Full inventory/COGS accounting (stock valuation, landed cost) isn’t part of the promise. Anything beyond scope is raised to you, never guessed.':
    'Kaupan laajuus, kerrottuna heti: Donna täsmäyttää maksut, palkkiot, hyvitykset ja pankkitodisteet ja sulkee kuukauden. Täysi varasto-/hankintakirjanpito (varaston arvostus, hankintameno) ei kuulu lupaukseen. Kaikki laajuuden ulkopuolinen nostetaan sinulle, ei koskaan arvata.'
};

function capitalizeFirst(text) {
  const s = String(text || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Brand-panel animation data (ported from the v2 `.dc.html`) ──────────────
// The Asking detail says ONE judgment call, matching the ask story slide
// (HeroStories.jsx) the ticker pins to — one close, one question, one voice.
const STATUSES = [
  ['Reading', 'bank_statement_03.pdf'],
  ['Coding', '142 lines · in context'],
  ['Asking', '1 judgment call'],
  ['Posting', 'real double-entry → Xero'],
  ['Clean', 'books up to date']
];
// While the app story runs, the ticker cycles only the "Donna working"
// statuses (Reading/Coding/Posting); the ask and receipt slides pin their own.
const WORKING_STATUS_IDXS = [0, 1, 3];
const TERMS = [
  'CLIENT EVIDENCE',
  'TRANSACTION CODING',
  'firm-fact-client-Joes-automobile-414b70ecc71b22f6',
  'RECONCILIATION EXCEPTIONS',
  'XERO MIRRORING',
  'JUDGMENT CALL · FLAGGED',
  'DOUBLE-ENTRY POSTED',
  'evidence-blob-7f3a91c2',
  'CHART OF ACCOUNTS MATCH',
  'VAT TREATMENT · REVIEWED',
  'ACCRUAL vs CASH',
  'bank_statement_03.pdf → coded',
  'TRIAL BALANCE · FOOTED',
  'case-resume-2026-06-19',
  'INTERCOMPANY ELIMINATION',
  'CLOSE-READINESS CHECK'
];
// The typewriter channels: vertical band, peak opacity, size, and an x-zone
// (xMin% + a random spread of xRange%) so terms populate BOTH sides of the
// panel — the first four lean left, the last two sit on the right.
const BANDS = [
  { top: '18%', base: 0.92, size: '14px', xMin: 5, xRange: 40 },
  { top: '37%', base: 0.7, size: '12px', xMin: 6, xRange: 42 },
  { top: '56%', base: 0.86, size: '13px', xMin: 8, xRange: 40 },
  { top: '75%', base: 0.6, size: '11px', xMin: 5, xRange: 44 },
  { top: '29%', base: 0.6, size: '12px', xMin: 52, xRange: 32 },
  { top: '64%', base: 0.66, size: '11px', xMin: 50, xRange: 34 }
];

// Ink at an arbitrary alpha, same OKLCH family as D.ink.
const inkA = (alpha) => `oklch(0.08 0 0 / ${alpha})`;

// Same stack as before, now sourced from the token module instead of being a
// local copy — see D.serif. Byte-identical value, no visual change.
const serif = D.serif;
const monoCaps = { fontFamily: D.mono, textTransform: 'uppercase' };
const arrow = { fontSize: '1.05rem', lineHeight: 1 };

// ── Form / control styles ───────────────────────────────────────────────────
const field = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: D.body,
  fontSize: '0.95rem',
  padding: '0.9rem 1.1rem',
  border: `1px solid ${inkA(0.28)}`,
  borderRadius: '6px',
  background: '#fff',
  color: D.ink,
  outline: 'none'
};
const labelStyle = { ...monoCaps, fontSize: 10, letterSpacing: '0.2em', color: inkA(0.5) };
const h1Style = {
  fontFamily: serif,
  fontWeight: 400,
  fontSize: 'clamp(2rem, 3.4vw, 2.6rem)',
  lineHeight: 1.05,
  letterSpacing: '-0.01em',
  margin: '0 0 0.5rem'
};
const subStyle = {
  fontFamily: D.body,
  fontSize: '0.95rem',
  lineHeight: 1.5,
  color: inkA(0.6),
  margin: '0 0 1.5rem'
};
const textLink = {
  color: D.ink,
  fontWeight: 600,
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer'
};
// Back control — a circular ghost button. Quiet at rest (thin ink ring), but
// on hover it fills with the sunset sweep and the arrow nudges left, so it
// reads as a real affordance instead of a faint mono label.
const backBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 42,
  height: 42,
  borderRadius: '999px',
  color: D.ink,
  background: '#fff',
  border: `1px solid ${inkA(0.2)}`,
  padding: 0,
  marginBottom: '1.5rem',
  cursor: 'pointer'
};
const googleBtn = {
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.75rem',
  fontFamily: D.body,
  fontSize: '0.95rem',
  fontWeight: 600,
  padding: '0.95rem 1.4rem',
  border: `1px solid ${inkA(0.28)}`,
  borderRadius: '6px',
  background: '#fff',
  color: D.ink,
  cursor: 'pointer'
};
// Qualification single-select chip — laid out in a 2-col grid (not a long
// stack) so the two questions read as compact choosers, not an exhausting list.
// Selected state is the warm sunset accent, not flat ink, for a bit of life.
const QUAL_ACCENT = 'oklch(0.66 0.18 47)';
// Brand sunset (gold→orange→red), vertical — a thin 4px ACCENT EDGE down the left
// of the selected chip, not a full fill (the gradient stays "big & sparingly").
const SUNSET_EDGE =
  'linear-gradient(180deg, oklch(0.80 0.12 78), oklch(0.70 0.17 50), oklch(0.58 0.20 32))';
const optionChip = (selected) => ({
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.6rem',
  textAlign: 'left',
  padding: '0.85rem 1rem',
  borderRadius: '8px',
  cursor: 'pointer',
  fontFamily: D.body,
  fontSize: '0.92rem',
  lineHeight: 1.3,
  color: D.ink,
  border: `1px solid ${selected ? QUAL_ACCENT : inkA(0.22)}`,
  // Selected: a 4px sunset edge down the left over the faint warm tint — no inset
  // ring, so the gradient reads as an accent edge, not a full fill.
  background: selected
    ? `${SUNSET_EDGE} left center / 4px 100% no-repeat, ${QUAL_ACCENT.replace(')', ' / 0.08)')}`
    : '#fff',
  boxShadow: 'none'
});

// One of the three "pick months" doors. `featured` is the Catch-me-up card.
// Featured gets a true sunset gradient BORDER (gradient on border-box, white on
// padding-box) plus a soft warm glow — the flat-orange 2px border read as cheap.
const doorCard = (featured) =>
  featured
    ? {
        width: '100%',
        textAlign: 'left',
        padding: 'clamp(1.1rem, 2vw, 1.4rem)',
        borderRadius: '12px',
        color: D.ink,
        border: '2px solid transparent',
        background: `linear-gradient(#fff, #fff) padding-box, ${D.landingGradient} border-box`,
        boxShadow: '0 10px 30px oklch(0.62 0.18 45 / 0.13)'
      }
    : {
        width: '100%',
        textAlign: 'left',
        padding: 'clamp(1.1rem, 2vw, 1.4rem)',
        borderRadius: '12px',
        background: '#fff',
        color: D.ink,
        border: `1px solid ${inkA(0.16)}`
      };

// Prominent price: a big serif number + a small mono unit. The old mono-11px
// line read as fine print, which made the price feel sketchy. Mirrors the
// confident treatment already used on the checkout detail screen.
const priceRow = { display: 'flex', alignItems: 'baseline', gap: '0.55rem', flexWrap: 'wrap', margin: '0.8rem 0 1rem' };
const priceAmount = { fontFamily: serif, fontSize: '1.85rem', lineHeight: 1, letterSpacing: '-0.01em', color: D.ink };
const priceUnit = { ...monoCaps, fontSize: 10, letterSpacing: '0.14em', color: inkA(0.5) };

// Catch-up stepper +/- buttons.
const stepBtn = (disabled) => ({
  width: 34,
  height: 34,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '6px',
  border: `1px solid ${inkA(0.28)}`,
  background: '#fff',
  color: D.ink,
  fontSize: '1.2rem',
  lineHeight: 1,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1
});

// ── Small presentational helpers ────────────────────────────────────────────
const DarkButton = ({ onClick, type = 'button', disabled = false, style, children }) => (
  <button
    type={type}
    onClick={onClick}
    disabled={disabled}
    className="dl2-cta"
    style={{
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '1rem',
      ...monoCaps,
      fontSize: 12,
      letterSpacing: '0.16em',
      padding: '1.05rem 1.4rem',
      border: `1px solid ${D.ink}`,
      borderRadius: '6px',
      background: D.ink,
      color: D.paper,
      opacity: disabled ? 0.55 : 1,
      cursor: disabled ? 'default' : 'pointer',
      ...style
    }}
  >
    {children}
  </button>
);

const BackButton = ({ onClick, label = 'Back' }) => (
  <button type="button" className="dl2-back" aria-label={label} onClick={onClick} style={backBtn}>
    <span aria-hidden="true" className="dl2-back-arrow" style={{ fontSize: '1.25rem', lineHeight: 1 }}>
      ←
    </span>
  </button>
);

const ErrorMsg = ({ children }) => (
  <p style={{ margin: '0.85rem 0 0', fontFamily: D.body, fontSize: 13, lineHeight: 1.45, color: 'oklch(0.55 0.20 25)' }}>
    {children}
  </p>
);

const NoticeMsg = ({ children }) => (
  <p style={{ margin: '0.85rem 0 0', fontFamily: D.body, fontSize: 13, lineHeight: 1.45, color: 'oklch(0.52 0.11 150)' }}>
    {children}
  </p>
);

const Divider = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', margin: '1.4rem 0' }}>
    <div style={{ flex: 1, height: 1, background: inkA(0.16) }} />
    <span style={{ ...monoCaps, fontSize: 10, letterSpacing: '0.3em', color: inkA(0.45) }}>OR</span>
    <div style={{ flex: 1, height: 1, background: inkA(0.16) }} />
  </div>
);

const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}>
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.94H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.06l3.01-2.34Z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58Z" />
  </svg>
);

// Code-only cover art for a plan — echoes the brand panel (gradient grain,
// grid, oversized cropped wordmark) in a contained card. No binary assets.
const CoverArt = ({ idx, word, badge = null }) => {
  return (
    <div
      style={{
        position: 'relative',
        height: 'clamp(170px, 22vh, 230px)',
        borderRadius: '10px',
        overflow: 'hidden',
        ...D.gradientGrain()
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            `repeating-linear-gradient(90deg, ${inkA(0.08)} 0, ${inkA(0.08)} 1px, transparent 1px, transparent 64px), ` +
            `repeating-linear-gradient(0deg, ${inkA(0.08)} 0, ${inkA(0.08)} 1px, transparent 1px, transparent 64px)`
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-0.04em',
          bottom: '-0.2em',
          fontFamily: D.display,
          fontSize: 'clamp(64px, 11vw, 116px)',
          lineHeight: 0.8,
          letterSpacing: '-0.02em',
          color: inkA(0.14),
          whiteSpace: 'nowrap',
          userSelect: 'none'
        }}
      >
        {word}
      </div>
      <div
        style={{
          position: 'absolute',
          top: '1.05rem',
          left: '1.15rem',
          ...monoCaps,
          fontSize: 11,
          letterSpacing: '0.18em',
          color: inkA(0.72)
        }}
      >
        DONNA · {idx}
      </div>
      {badge && (
        <div
          style={{
            position: 'absolute',
            top: '1.05rem',
            right: '1.15rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.45rem',
            ...monoCaps,
            fontSize: 10,
            letterSpacing: '0.14em',
            color: inkA(0.75)
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 15,
              height: 15,
              borderRadius: '50%',
              border: `1.5px solid ${inkA(0.6)}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              lineHeight: 1
            }}
          >
            ✓
          </span>
          {badge}
        </div>
      )}
    </div>
  );
};

// ── Typewriter channel logic (ported 1:1 from the v2 DCLogic component) ──────
const makeChannels = () =>
  BANDS.map((b, i) => ({
    full: '',
    text: '',
    pos: 0,
    phase: 'idle',
    ticks: 4 + i * 9 + Math.floor(Math.random() * 14),
    top: b.top,
    base: b.base,
    size: b.size,
    xMin: b.xMin,
    xRange: b.xRange,
    left: '8%',
    opacity: 0,
    cursor: false,
    z: 0
  }));

const pickTerm = (channels) => {
  const active = new Set(channels.map((c) => c.full));
  let term;
  let guard = 0;
  do {
    term = TERMS[Math.floor(Math.random() * TERMS.length)];
    guard += 1;
  } while (active.has(term) && guard < 12);
  return term;
};

const stepChannels = (channels, tick) => {
  const cursorOn = Math.floor(tick / 5) % 2 === 0;
  for (const c of channels) {
    c.ticks -= 1;
    if (c.phase === 'idle') {
      if (c.ticks <= 0) {
        c.full = pickTerm(channels);
        c.text = '';
        c.pos = 0;
        c.left = `${(c.xMin + Math.random() * c.xRange).toFixed(1)}%`;
        // Random depth so terms float at varied Z — 3D vibe. No yaw: rotateY
        // shears off-center terms under the shared perspective and slopes the
        // baseline, which reads as a bug.
        c.z = Math.round(-260 + Math.random() * 440);
        c.opacity = c.base;
        c.phase = 'typing';
      }
    } else if (c.phase === 'typing') {
      c.pos += 1;
      c.text = c.full.slice(0, c.pos);
      if (c.pos >= c.full.length) {
        c.phase = 'holding';
        c.ticks = 28 + Math.floor(Math.random() * 22);
      }
    } else if (c.phase === 'holding') {
      if (c.ticks <= 0) {
        c.phase = 'fading';
        c.ticks = 9;
      }
    } else if (c.phase === 'fading') {
      c.opacity = Math.max(0, c.base * (c.ticks / 9));
      if (c.ticks <= 0) {
        c.phase = 'idle';
        c.ticks = 6 + Math.floor(Math.random() * 34);
        c.text = '';
        c.opacity = 0;
      }
    }
    c.cursor = (c.phase === 'typing' || c.phase === 'holding') && cursorOn;
  }
};

const staticChannels = () =>
  BANDS.map((b, i) => ({
    text: TERMS[i % TERMS.length],
    top: b.top,
    base: b.base,
    size: b.size,
    left: `${(b.xMin + b.xRange * 0.18).toFixed(1)}%`,
    opacity: b.base,
    cursor: false,
    z: [140, -150, 70, -120, 170, -80][i] || 0
  }));

// ── Right column — the animated brand panel (funnel layout only) ────────────
// Root/English: the gradient stage (grain, grid, cropped wordmark, typewriter
// terms, status ticker) with the HeroStories layer on top — the app window,
// the ask, and the close receipt cycling under an IG-style segmented bar.
// ── WhatsApp brand-panel (lang='fi' / the /fi route) ────────────────────────
// The right panel becomes an iPhone showing a looping Donna WhatsApp chat, to
// cash the /fi positioning ("Anna tehtävät WhatsAppissa"). The script is honest
// and on-doctrine (AI-operated model, Kari 2026-07-13): Donna handles what she
// can and asks the owner exactly ONE judgment call (two-terminal-states), then
// posts and shows what she did. There is NO hidden human reviewer, so the closer
// says Donna asks only if a decision is still the owner's, never "a human
// checks". No em dashes (Kari). Design ported from Kari's approved Donna_Landing4
// mockup.
const WA_CHAT = [
  { side: 'out', doc: true, text: 'Moi Donna! Tässä huhtikuun kuitit 📎', time: '9.41' },
  { side: 'in', text: 'Kiitos, sain ne 🙌 Käyn ne läpi ja kirjaan rivit.', time: '9.41' },
  { side: 'in', text: '14 kuittia kirjattu. Yksi vaatii sinua: Ravintola Nokka 62 €. Asiakastapaaminen vai oma lounas?', time: '9.43' },
  { side: 'out', text: 'Asiakaslounas', time: '9.44' },
  { side: 'in', text: 'Selvä, kirjasin edustuskuluksi. Huhtikuu on nyt täsmätty ✅', time: '9.44' },
  { side: 'in', text: 'Raportti on valmis, näet siitä mitä tein. Kysyn vain, jos jokin vaatii vielä päätöstäsi.', time: '9.45' }
];
const WA_PANEL_GRADIENT =
  'linear-gradient(135deg, oklch(0.88 0.06 80) 0%, oklch(0.81 0.09 58) 52%, oklch(0.74 0.11 40) 100%)';
const WA_NOISE_BG =
  "url(\"data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%20200%20200%27%3E%3Cfilter%20id=%27n%27%3E%3CfeTurbulence%20type=%27fractalNoise%27%20baseFrequency=%271.2%27%20numOctaves=%273%27%20stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect%20width=%27100%25%27%20height=%27100%25%27%20filter=%27url%28%23n%29%27%20opacity=%270.16%27/%3E%3C/svg%3E\")";

const BrandPanel = memo(function BrandPanel({ isFi = false }) {
  const channelsRef = useRef(null);
  if (channelsRef.current === null) channelsRef.current = makeChannels();
  const tickRef = useRef(0);
  const [, setFrame] = useState(0);
  const [statusIdx, setStatusIdx] = useState(0);
  // Which hero story is showing (HeroStories reports back) — drives the
  // status-ticker pinning below. Callback stays stable for the memoized child.
  const [storySlide, setStorySlide] = useState(0);
  const handleStorySlide = useCallback((i) => setStorySlide(i), []);
  // WhatsApp chat state (only used on /fi).
  const [chatCount, setChatCount] = useState(0);
  const [chatTyping, setChatTyping] = useState(false);
  const [chatOpacity, setChatOpacity] = useState(1);
  const chatRef = useRef(null);

  useEffect(() => {
    // The /fi panel shows the WhatsApp phone, not the terms/status ticker — skip
    // the animation loop entirely there so no wasted work behind the phone.
    if (isFi) return undefined;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduce) {
      channelsRef.current = staticChannels();
      setFrame((f) => f + 1);
      return undefined;
    }

    const terms = setInterval(() => {
      tickRef.current += 1;
      stepChannels(channelsRef.current, tickRef.current);
      setFrame((f) => (f + 1) % 1e9);
    }, 60);
    const status = setInterval(() => {
      setStatusIdx((i) => (i + 1) % STATUSES.length);
    }, 2200);

    return () => {
      clearInterval(terms);
      clearInterval(status);
    };
  }, [isFi]);

  // Looping WhatsApp chat animation (/fi only). Types each Donna reply behind a
  // typing indicator, holds the finished thread, fades, and loops. Reduced-motion
  // renders the full thread statically. Timers are cleared on unmount.
  useEffect(() => {
    if (!isFi) return undefined;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setChatCount(WA_CHAT.length);
      setChatTyping(false);
      setChatOpacity(1);
      return undefined;
    }
    let alive = true;
    const timers = [];
    const wait = (ms) => new Promise((res) => timers.push(setTimeout(res, ms)));
    const run = async () => {
      while (alive) {
        setChatCount(0);
        setChatTyping(false);
        setChatOpacity(1);
        await wait(1400);
        for (let k = 0; k < WA_CHAT.length; k++) {
          if (!alive) return;
          const m = WA_CHAT[k];
          if (m.side === 'in') {
            setChatTyping(true);
            await wait(900 + Math.min(m.text.length * 7, 600));
            if (!alive) return;
            setChatTyping(false);
            setChatCount(k + 1);
          } else {
            await wait(1300);
            if (!alive) return;
            setChatCount(k + 1);
          }
          await wait(750);
        }
        await wait(3600);
        if (!alive) return;
        setChatOpacity(0);
        await wait(750);
      }
    };
    run();
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [isFi]);

  // Keep the thread pinned to the newest bubble as it grows.
  useEffect(() => {
    if (isFi && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  });

  if (isFi) {
    const strokeInk = inkA(0.55);
    return (
      <div
        className="dl2-panel"
        style={{ position: 'relative', height: '100vh', overflow: 'hidden', background: WA_PANEL_GRADIENT }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            mixBlendMode: 'multiply',
            backgroundImage: WA_NOISE_BG,
            backgroundSize: '200px 200px'
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1.5rem',
            padding: '3vh 2rem'
          }}
        >
          <div
            style={{
              position: 'relative',
              height: 'min(680px, 82%)',
              maxWidth: '86%',
              aspectRatio: '9 / 19.3',
              borderRadius: 54,
              background: '#0d0d0f',
              boxShadow: '0 50px 90px -35px rgba(35,16,4,.55), 0 0 0 1px rgba(255,255,255,.10) inset'
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 9,
                borderRadius: 45,
                overflow: 'hidden',
                background: '#EFE7DB',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              {/* status bar + chat header */}
              <div style={{ flex: 'none', background: '#F7F5F1', borderBottom: `1px solid ${inkA(0.08)}` }}>
                <div
                  style={{
                    position: 'relative',
                    height: 38,
                    display: 'flex',
                    alignItems: 'flex-end',
                    justifyContent: 'space-between',
                    padding: '0 24px 3px'
                  }}
                >
                  <span style={{ fontFamily: D.body, fontSize: 13, fontWeight: 600, color: '#121212' }}>9.41</span>
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: 9,
                      transform: 'translateX(-50%)',
                      width: 80,
                      height: 22,
                      borderRadius: 12,
                      background: '#0d0d0f'
                    }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
                      <rect x="0" y="6" width="3" height="4" rx="0.8" fill="#121212" />
                      <rect x="4.3" y="4" width="3" height="6" rx="0.8" fill="#121212" />
                      <rect x="8.6" y="2" width="3" height="8" rx="0.8" fill="#121212" />
                      <rect x="12.9" y="0" width="3" height="10" rx="0.8" fill="#121212" />
                    </svg>
                    <svg width="15" height="11" viewBox="0 0 15 11" aria-hidden="true">
                      <path d="M7.5 10.4 5 7.8a3.6 3.6 0 0 1 5 0Z" fill="#121212" />
                      <path d="M2.9 5.6a6.6 6.6 0 0 1 9.2 0l-1.5 1.6a4.4 4.4 0 0 0-6.2 0Z" fill="#121212" fillOpacity=".85" />
                      <path d="M.6 3.2a9.9 9.9 0 0 1 13.8 0l-1.5 1.6a7.7 7.7 0 0 0-10.8 0Z" fill="#121212" fillOpacity=".7" />
                    </svg>
                    <svg width="23" height="11" viewBox="0 0 23 11" aria-hidden="true">
                      <rect x="0.5" y="0.5" width="19" height="10" rx="2.8" fill="none" stroke="#121212" strokeOpacity=".4" />
                      <rect x="2" y="2" width="14" height="7" rx="1.6" fill="#121212" />
                      <path d="M21.5 3.6v3.8a2 2 0 0 0 0-3.8Z" fill="#121212" fillOpacity=".45" />
                    </svg>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 12px 9px' }}>
                  <svg width="11" height="18" viewBox="0 0 11 18" aria-hidden="true" style={{ flex: 'none' }}>
                    <path d="M9.5 1.5 2 9l7.5 7.5" fill="none" stroke="#0A7CFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <div
                    style={{
                      flex: 'none',
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'linear-gradient(135deg, oklch(0.78 0.13 70), oklch(0.60 0.19 36))',
                      color: '#FAFAFA',
                      fontFamily: D.display,
                      fontSize: 16,
                      letterSpacing: '0.02em'
                    }}
                  >
                    D
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: D.body, fontSize: 14.5, fontWeight: 600, color: '#121212', lineHeight: 1.15 }}>Donna</div>
                    <div style={{ fontFamily: D.body, fontSize: 11, color: inkA(0.5), lineHeight: 1.2 }}>paikalla</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingRight: 2 }}>
                    <svg width="21" height="14" viewBox="0 0 21 14" aria-hidden="true">
                      <rect x="0.9" y="0.9" width="13.2" height="12.2" rx="3" fill="none" stroke="#0A7CFF" strokeWidth="1.8" />
                      <path d="M14.8 5.4 19.4 2.6a.5.5 0 0 1 .76.43v7.94a.5.5 0 0 1-.76.43L14.8 8.6Z" fill="#0A7CFF" />
                    </svg>
                    <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true">
                      <path
                        d="M4.9 1.2 6.9 3.7c.4.5.3 1.2-.2 1.7l-1 1c.7 1.6 2.3 3.2 3.9 3.9l1-1c.5-.5 1.2-.6 1.7-.2l2.5 2c.6.5.7 1.4.1 2l-1 1c-.7.7-1.8 1-2.8.6C7.5 13.3 3.7 9.5 2.3 5.9c-.4-1-.1-2.1.6-2.8l1-1c.6-.6 1.5-.5 2 .1Z"
                        fill="none"
                        stroke="#0A7CFF"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              {/* chat thread */}
              <div
                ref={chatRef}
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '12px 10px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  opacity: chatOpacity,
                  transition: 'opacity .6s ease'
                }}
              >
                <div
                  style={{
                    alignSelf: 'center',
                    flex: 'none',
                    fontFamily: D.body,
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: inkA(0.45),
                    background: 'rgba(255,255,255,.8)',
                    borderRadius: 7,
                    padding: '3px 9px',
                    marginBottom: 4
                  }}
                >
                  Tänään
                </div>
                {WA_CHAT.slice(0, chatCount).map((m, i) => {
                  const out = m.side === 'out';
                  return (
                    <div key={i} style={{ flex: 'none', display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start' }}>
                      <div
                        className="dl2-wa-bubble"
                        style={{
                          maxWidth: '78%',
                          padding: m.doc ? '5px 6px 7px' : '7px 10px 8px',
                          borderRadius: out ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                          background: out ? '#D9FDD3' : '#FFFFFF',
                          boxShadow: '0 1px 1px rgba(0,0,0,.08)'
                        }}
                      >
                        {m.doc && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 9,
                              background: inkA(0.06),
                              borderRadius: 8,
                              padding: '9px 11px',
                              marginBottom: 5,
                              maxWidth: '100%',
                              minWidth: 0
                            }}
                          >
                            <svg width="26" height="32" viewBox="0 0 26 32" aria-hidden="true" style={{ flex: 'none' }}>
                              <path d="M2 3a3 3 0 0 1 3-3h12l7 7v22a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3Z" fill="#E45B4F" />
                              <path d="M17 0l7 7h-6a1 1 0 0 1-1-1Z" fill="#B23F35" />
                              <text x="13" y="24" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="8.5" fontWeight="700" fill="#FFFFFF">
                                PDF
                              </text>
                            </svg>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontFamily: D.body, fontSize: 13, fontWeight: 600, color: '#121212', lineHeight: 1.2 }}>kuitit.pdf</div>
                              <div style={{ fontFamily: D.body, fontSize: 10.5, color: inkA(0.5), lineHeight: 1.3 }}>3 tiedostoa · PDF</div>
                            </div>
                          </div>
                        )}
                        <span style={{ fontFamily: D.body, fontSize: 13, lineHeight: 1.35, color: '#121212', wordBreak: 'break-word' }}>{m.text}</span>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            float: 'right',
                            margin: '7px -2px -2px 9px',
                            transform: 'translateY(3px)'
                          }}
                        >
                          <span style={{ fontFamily: D.body, fontSize: 10, color: inkA(0.45) }}>{m.time}</span>
                          {out && (
                            <svg width="15" height="9" viewBox="0 0 16 10" aria-hidden="true">
                              <path d="M1 5.4 4 8.4 9.6 1.6" fill="none" stroke="#53BDEB" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M7 5.8 9.4 8.4 15 1.6" fill="none" stroke="#53BDEB" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {chatTyping && (
                  <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-start' }}>
                    <div
                      className="dl2-wa-bubble"
                      style={{
                        background: '#FFFFFF',
                        borderRadius: '12px 12px 12px 4px',
                        padding: '11px 13px',
                        boxShadow: '0 1px 1px rgba(0,0,0,.08)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4
                      }}
                    >
                      <span className="dl2-wa-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: inkA(0.4) }} />
                      <span className="dl2-wa-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: inkA(0.4), animationDelay: '.2s' }} />
                      <span className="dl2-wa-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: inkA(0.4), animationDelay: '.4s' }} />
                    </div>
                  </div>
                )}
              </div>

              {/* input bar */}
              <div
                style={{
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '8px 12px 4px',
                  background: '#F7F5F1',
                  borderTop: `1px solid ${inkA(0.08)}`
                }}
              >
                <svg width="19" height="19" viewBox="0 0 19 19" aria-hidden="true" style={{ flex: 'none' }}>
                  <path d="M9.5 3v13M3 9.5h13" stroke="#0A7CFF" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <div
                  style={{
                    flex: 1,
                    background: '#FFFFFF',
                    border: `1px solid ${inkA(0.12)}`,
                    borderRadius: 16,
                    padding: '7px 13px',
                    fontFamily: D.body,
                    fontSize: 13,
                    color: inkA(0.4)
                  }}
                >
                  Viesti
                </div>
                <svg width="20" height="17" viewBox="0 0 20 17" aria-hidden="true" style={{ flex: 'none' }}>
                  <rect x="0.8" y="3" width="18.4" height="13.2" rx="3" fill="none" stroke={strokeInk} strokeWidth="1.6" />
                  <path d="M6.5 3 8 0.9h4L13.5 3" fill="none" stroke={strokeInk} strokeWidth="1.6" strokeLinejoin="round" />
                  <circle cx="10" cy="9.4" r="3.4" fill="none" stroke={strokeInk} strokeWidth="1.6" />
                </svg>
                <svg width="13" height="19" viewBox="0 0 13 19" aria-hidden="true" style={{ flex: 'none' }}>
                  <rect x="3.6" y="0.8" width="5.8" height="10.4" rx="2.9" fill="none" stroke={strokeInk} strokeWidth="1.6" />
                  <path d="M1 8.8a5.5 5.5 0 0 0 11 0M6.5 14.6v3.4" fill="none" stroke={strokeInk} strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
              <div style={{ flex: 'none', height: 17, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F5F1' }}>
                <div style={{ width: 104, height: 4, borderRadius: 2, background: inkA(0.85) }} />
              </div>
            </div>
          </div>

          <div style={{ ...monoCaps, fontSize: 10.5, letterSpacing: '0.22em', color: inkA(0.55) }}>Aina tavoitettavissa · WhatsApp</div>
        </div>
      </div>
    );
  }

  const grid = inkA(0.09);
  const gridImage =
    `repeating-linear-gradient(90deg, ${grid} 0, ${grid} 1px, transparent 1px, transparent 120px), ` +
    `repeating-linear-gradient(0deg, ${grid} 0, ${grid} 1px, transparent 1px, transparent 120px)`;
  // Ticker follows the story: app slide → cycle the working statuses; ask
  // slide → pin Asking; close slide → pin Clean.
  const displayStatusIdx =
    storySlide === 1 ? 2 : storySlide === 2 ? 4 : WORKING_STATUS_IDXS[statusIdx % WORKING_STATUS_IDXS.length];
  const [statusLabel, statusDetail] = STATUSES[displayStatusIdx] || STATUSES[0];

  return (
    <div
      className="dl2-panel"
      style={{ position: 'relative', height: '100vh', overflow: 'hidden', perspective: '1000px', ...D.gradientGrain() }}
    >
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 1, backgroundImage: gridImage }} />
      <div
        aria-hidden="true"
        style={{ position: 'absolute', top: 0, bottom: 0, left: '34%', width: 1, zIndex: 1, background: inkA(0.16) }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '-2.5vw',
          bottom: '-7vh',
          zIndex: 2,
          fontFamily: D.display,
          fontSize: '31vw',
          lineHeight: 0.78,
          letterSpacing: '-0.02em',
          color: inkA(0.11),
          whiteSpace: 'nowrap',
          userSelect: 'none'
        }}
      >
        DONNA
      </div>

      {(channelsRef.current || []).map((c, i) => (
        <div
          key={i}
          aria-hidden="true"
          style={{
            position: 'absolute',
            zIndex: 3,
            left: c.left,
            top: c.top,
            opacity: c.opacity,
            transform: `translateZ(${c.z || 0}px)`,
            willChange: 'transform',
            fontFamily: D.mono,
            fontSize: c.size,
            letterSpacing: '0.1em',
            lineHeight: 1,
            color: inkA(0.82),
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
          }}
        >
          {c.text + (c.cursor ? '▌' : '')}
        </div>
      ))}

      <div
        style={{
          position: 'absolute',
          top: 'clamp(2rem, 4vh, 3rem)',
          left: 'clamp(2rem, 4vw, 3.5rem)',
          zIndex: 4,
          display: 'flex',
          alignItems: 'center',
          gap: '0.7rem'
        }}
      >
        <span
          className="dl2-pulse"
          style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: inkA(0.4) }}
        />
        <span style={{ ...monoCaps, fontSize: 11, letterSpacing: '0.18em', color: inkA(0.82) }}>{statusLabel}</span>
        <span style={{ fontFamily: D.mono, fontSize: 11, letterSpacing: '0.04em', color: inkA(0.52) }}>
          {statusDetail}
        </span>
      </div>

      {/* The product stories — the app at work, the one ask, the close
          receipt — IG-style segmented bar on top (Kari, 2026-08-28). */}
      <HeroStories onSlideChange={handleStorySlide} />
    </div>
  );
});

// Initial funnel view + email prefill from ?auth=signup|signin & ?email=…
//
// The /onboarding path is a one-click deep-link into the funnel for
// testers/reviewers. With no params it opens the qualification gate; with
// ?band=lt200|200-500|500-1k (and optional ?kind=one_month|catch_up|recurring)
// it jumps straight to the checkout detail with the offer pre-resolved, so the
// account-creation screen is reachable without clicking through every step.
const VALID_KINDS = ['one_month', 'catch_up', 'recurring'];

// The owner purchase funnel (qualify → months → detail/checkout) is retired
// (Kari, 2026-10-21: "take the owner checkout down"). Requests for
// these views, from the URL or a button, open sign-in instead, and the server
// refuses /billing/checkout. The views' code is dead and can be deleted.
const PURCHASE_VIEWS = new Set(['qualify', 'months', 'detail']);

// The chosen offer is carried into account creation by stashing it (see
// pendingOffer.js), so the post-signup app picks it up — including across the
// Google OAuth round-trip — and ClientPortalGate redeems it into a real Stripe
// Checkout once the clientId is known. This funnel creates the account; the
// stashed offer is the bridge to real checkout.
const readQuery = () => {
  const base = { view: 'entry', email: '', bandId: null, kind: null };
  if (typeof window === 'undefined') return base;
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  const bandParam = params.get('band');
  const bandId = getBand(bandParam) ? bandParam : null;
  const kindParam = params.get('kind');
  const kind = VALID_KINDS.includes(kindParam) ? kindParam : null;
  const email = params.get('email') || '';
  // ?auth=confirm is the "Check your inbox" screen reflected into the URL so a
  // refresh re-shows it instead of dropping a brand-new signup back on the
  // landing. It wins over the path-based init below (signup can be reached from
  // '/', '/welcome' or '/onboarding'); the address is restored from the stash,
  // never carried in the URL.
  if (auth === 'confirm') return { view: 'confirm', email, bandId, kind };
  const path = window.location.pathname.toLowerCase().replace(/\/+$/, '');
  // /onboarding and ?auth=signup used to open the purchase funnel; they open
  // sign-in now.
  if (path === '/onboarding') return { view: 'signin', email, bandId: null, kind: null };
  return {
    view: auth === 'signup' || auth === 'signin' ? 'signin' : 'entry',
    email,
    bandId,
    kind
  };
};

// Reflect / unreflect the "Check your inbox" screen in the URL (?auth=confirm)
// without a reload, preserving any other query params. Pairs with readQuery's
// auth==='confirm' branch so a refresh restores the screen. The email lives in
// the stash, never the URL.
const writeConfirmMarkerToUrl = () => {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  params.set('auth', 'confirm');
  params.delete('email');
  const qs = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
};
const clearConfirmMarkerFromUrl = () => {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('auth') !== 'confirm') return;
  params.delete('auth');
  const qs = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
};

const SCOPED_STYLES = (`
  @keyframes dl2Pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .dl2-pulse { animation: dl2Pulse 1.6s ease-in-out infinite; }
  @keyframes donnaBubbleIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @keyframes donnaDot { 0%, 60%, 100% { opacity: .25; transform: none; } 30% { opacity: 1; transform: translateY(-2px); } }
  .dl2-wa-bubble { animation: donnaBubbleIn .28s ease-out; }
  .dl2-wa-dot { animation: donnaDot 1.2s ease-in-out infinite; }
  .dl2-cta { transition: background 160ms ${D.ease}, transform 120ms ${D.ease}; }
  .dl2-cta:not(:disabled):hover { background: #2b2723; transform: translateY(-1px); }
  .dl2-cta:not(:disabled):active { transform: translateY(0); }
  .dl2-google { transition: background 160ms ${D.ease}; }
  .dl2-google:not(:disabled):hover { background: ${inkA(0.04)}; }
  .dl2-field { transition: border-color 160ms ${D.ease}; }
  .dl2-field:focus { border-color: ${D.ink}; }
  .dl2-link { transition: color 160ms ${D.ease}; }
  .dl2-link:hover { color: ${D.ink}; }
  .dl2-textbtn:hover { opacity: 0.65; }
  .dl2-back { transition: border-color 180ms ${D.ease}, box-shadow 220ms ${D.ease}, transform 180ms ${D.ease}; }
  .dl2-back:hover { border-color: transparent; background-image: ${D.landingGradient}; color: #fff; box-shadow: 0 8px 22px oklch(0.62 0.18 45 / 0.32); transform: translateY(-1px); }
  .dl2-back:active { transform: translateY(0); }
  .dl2-back-arrow { display: inline-block; transition: transform 200ms ${D.ease}; }
  .dl2-back:hover .dl2-back-arrow { transform: translateX(-3px); }
  .dl2-plan { transition: border-color 160ms ${D.ease}, background 160ms ${D.ease}; }
  @media (max-width: 820px) {
    .dl2-root { grid-template-columns: 1fr !important; height: auto !important; min-height: 100vh !important; overflow: visible !important; }
    .dl2-entry { height: auto !important; }
    /* 56vh, up from 42vh: the panel now carries the product stories (and the
       /fi phone), which need the height to read — 42vh cropped the app window
       to its titlebar. */
    .dl2-panel { height: 56vh !important; min-height: 430px !important; }
  }
  @media (max-width: 860px) {
    .dl2-detailgrid { grid-template-columns: 1fr !important; }
    .dl2-checkout { position: static !important; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dl2-pulse { animation: none !important; }
    .dl2-wa-bubble, .dl2-wa-dot { animation: none !important; }
    .dl2-cta { transition: none !important; }
    .dl2-back, .dl2-back-arrow { transition: none !important; }
    .dl2-back:hover { transform: none !important; }
    .dl2-back:hover .dl2-back-arrow { transform: none !important; }
  }
`);

// ── Page ────────────────────────────────────────────────────────────────────
const DonnaLanding = ({ oauthRedirect = null, lang = 'en' } = {}) => {
  const initial = readQuery();
  // Localization. English path is a no-op: L() returns the source string,
  // money() uses USD fmt(), prices come from the USD bands. Finnish (/fi) swaps
  // copy + euro prices (pricing.js Finnish pilot values). Same funnel/behavior.
  const isFi = lang === 'fi';
  const L = (s) => (isFi ? (FI_COPY[s] ?? s) : s);
  const money = (n) => (isFi ? fmtEur(n) : fmt(n));
  const bandPriceLocalized = (bid) => (isFi ? finlandBandPriceEur(bid) : priceForBand(bid));
  const recurringDisplayPrice = isFi ? FINLAND_PILOT_MONTHLY_PRICE_EUR : RECURRING_MONTHLY_PRICE;
  const amountLocalized = ({ kind: k, bandId: b, months: m = 1 }) => {
    if (!isFi) return amountFor({ kind: k, bandId: b, months: m });
    const p = k === 'recurring' ? FINLAND_PILOT_MONTHLY_PRICE_EUR : finlandBandPriceEur(b);
    if (p == null) return null;
    if (k === 'catch_up') return p * Math.max(1, Math.round(Number(m) || 0));
    return p;
  };
  const startingPriceDisplay = isFi
    ? fmtEur(Math.min(...PRICE_BANDS.map((b) => finlandBandPriceEur(b.id)).filter((n) => n != null)))
    : STARTING_PRICE;
  // /reset-password is the GoTrue recovery landing. A recovery session present →
  // show the set-new-password form; an expired/used link (or a direct visit) →
  // show the request-a-reset form with an explanation.
  const isResetRoute =
    typeof window !== 'undefined' &&
    window.location.pathname.toLowerCase().replace(/\/+$/, '') === '/reset-password';
  const resetExpired = isResetRoute && Boolean(oauthRedirect?.error);
  const initialView = isResetRoute ? (oauthRedirect?.recovery ? 'reset' : 'forgot') : initial.view;

  const [view, setView] = useState(initialView);
  const [email, setEmail] = useState(initial.email);
  const [password, setPassword] = useState('');
  // Business name captured at checkout so the workspace + portal read the real
  // venture name instead of falling back to the email prefix / Google display
  // name (which produced "How kari is doing"). Stashed with the offer and sent
  // to /self-provision; the server falls back to the email prefix if blank.
  const [businessName, setBusinessName] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(
    resetExpired ? 'That reset link has expired or was already used. Request a fresh one below.' : ''
  );
  const [authNotice, setAuthNotice] = useState('');
  // Restored from the stash when a refresh re-opens the confirm screen
  // (?auth=confirm) so "we sent a link to <email>" + resend keep working.
  const [confirmEmail, setConfirmEmail] = useState(
    initialView === 'confirm' ? readConfirmEmail() : ''
  );

  // Qualification (Screen 1) answers.
  const [bizType, setBizType] = useState(null);
  const [volume, setVolume] = useState(initial.bandId); // a band id, 'over', or null
  const [jurisdiction, setJurisdiction] = useState(null);
  const [gbEntityType, setGbEntityType] = useState('');
  const [incorporationDate, setIncorporationDate] = useState('');
  const [switching, setSwitching] = useState(null);

  // Resolved offer (Screens 2–3).
  const [kind, setKind] = useState(initial.kind); // one_month | catch_up | recurring
  const [months, setMonths] = useState(CATCH_UP_DEFAULT);

  // Unfit waitlist capture.
  const [waitEmail, setWaitEmail] = useState('');
  const [waitStatus, setWaitStatus] = useState('idle'); // idle | sending | done | error

  // Derived qualification state. A real band id resolves a price; 'over' and
  // the ineligible business types (restaurant / something-else) are the unfit
  // gate. Products/commerce is eligible WITH the scoped promise (P0E).
  const selectedBiz = BIZ_TYPES.find((b) => b.id === bizType) || null;
  const selectedVolume = VOLUME_OPTIONS.find((v) => v.id === volume) || null;
  const bandId = selectedVolume?.bandId || null;
  const band = getBand(bandId);
  const price = bandPriceLocalized(bandId);
  const { unfit, eligible, disqualifyReason } = qualificationDecision({
    businessEligible: selectedBiz?.eligible,
    bandId,
    volumeReason: selectedVolume?.reason,
    businessReason: selectedBiz?.reason,
    jurisdiction,
    switching
  });

  const busy = status === 'checking';
  const go = (requested) => {
    // The owner purchase funnel is retired (Kari, 2026-10-21: "take the owner
    // checkout down"). Any path that still asks for it lands on sign-in.
    const next = PURCHASE_VIEWS.has(requested) ? 'signin' : requested;
    setError('');
    setAuthNotice('');
    // Leaving the confirm screen: drop the URL marker + stashed address so a
    // later refresh doesn't resurrect a stale "check your inbox".
    if (view === 'confirm' && next !== 'confirm') {
      clearConfirmEmail();
      clearConfirmMarkerFromUrl();
    }
    setView(next);
  };

  // Forgot-password: request a reset email. GoTrue returns 200 regardless of
  // whether the email exists, so the notice is deliberately non-committal.
  const onForgot = async (event) => {
    event.preventDefault();
    if (busy || !email.trim()) return;
    setStatus('checking');
    setError('');
    setAuthNotice('');
    try {
      await requestPasswordReset({ email: email.trim() });
      setStatus('idle');
      setAuthNotice('If that email has an account, a reset link is on its way. Check your inbox (and spam).');
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Could not send the reset email.');
    }
  };

  // Reset landing: set the new password using the recovery session, then go in.
  const onResetPassword = async (event) => {
    event.preventDefault();
    if (busy || !password) return;
    setStatus('checking');
    setError('');
    try {
      await updatePassword({ password });
      window.location.assign(APP_ROUTE);
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Could not update your password.');
    }
  };

  // Resend the signup confirmation email (from the confirm screen or a failed
  // sign-in that looks like an unconfirmed account).
  const onResendConfirmation = async () => {
    const target = (confirmEmail || email).trim();
    if (busy || !target) return;
    setStatus('checking');
    setError('');
    setAuthNotice('');
    try {
      await resendConfirmation({ email: target, redirectPath: POST_AUTH_ROUTE });
      setStatus('idle');
      setAuthNotice(`Confirmation email re-sent to ${target}.`);
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Could not resend the confirmation email.');
    }
  };

  // A door on Screen 2 was chosen → carry the offer into checkout.
  const chooseOffer = (nextKind) => {
    trackEvent('offer_selected', { kind: nextKind });
    setKind(nextKind);
    go('detail');
  };

  const onWaitlist = async (event) => {
    event.preventDefault();
    if (waitStatus === 'sending' || !waitEmail.trim()) return;
    setWaitStatus('sending');
    try {
      await submitWaitlist({ email: waitEmail.trim(), reason: disqualifyReason });
      setWaitStatus('done');
    } catch {
      // Capture is best-effort; don't strand the visitor on a failure.
      setWaitStatus('done');
    }
  };

  const onGoogle = () => {
    setError('');
    stashOfferIfDetail();
    try {
      startGoogleSignIn(POST_AUTH_ROUTE);
    } catch (err) {
      setError(err.message || 'Google sign-in is unavailable.');
    }
  };

  const onSignIn = async (event) => {
    event.preventDefault();
    if (busy) return;
    setStatus('checking');
    setError('');
    try {
      await signInWithPassword({ email: email.trim(), password });
      window.location.assign(POST_AUTH_ROUTE);
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Sign in failed.');
    }
  };

  // Persist the chosen offer at checkout so the post-signup app can pick it up.
  const stashOfferIfDetail = () => {
    if (view !== 'detail' || !kind || !bandId) return;
    stashPendingOffer({
      kind,
      bandId,
      price: unitPriceFor(kind, bandId),
      months: kind === 'catch_up' ? months : 1,
      amount: amountFor({ kind, bandId, months }),
      companyName: businessName.trim() || null,
      jurisdiction,
      entityType: jurisdiction === 'GB' ? gbEntityType || null : null,
      incorporationDate: jurisdiction === 'GB' ? incorporationDate || null : null
    });
  };

  const onCreate = async (event) => {
    event.preventDefault();
    if (busy) return;
    setStatus('checking');
    setError('');
    stashOfferIfDetail();
    trackEvent('signup_started', { kind: kind || 'none' });
    try {
      const result = await signUp({ email: email.trim(), password, redirectPath: POST_AUTH_ROUTE });
      if (result?.confirmationRequired) {
        setStatus('idle');
        const trimmed = email.trim();
        setConfirmEmail(trimmed);
        // Persist so a refresh of the confirm screen survives (URL marker +
        // stashed address); see readQuery's auth==='confirm' branch.
        stashConfirmEmail(trimmed);
        writeConfirmMarkerToUrl();
        trackEvent('signup_confirmation_sent');
        setView('confirm');
        return;
      }
      trackEvent('signup_completed');
      window.location.assign(POST_AUTH_ROUTE);
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Sign up failed.');
    }
  };

  // Resolved offer for the checkout detail screen.
  const kindMeta = kind ? KIND_META[kind] : null;
  const amount = kind ? amountLocalized({ kind, bandId, months }) : null;
  const offerSubtitle = (() => {
    if (kind === 'one_month') return L('One monthly close');
    if (kind === 'catch_up') {
      return isFi
        ? `${months} kk · Donna sulkee kaikki`
        : `${months} month${months === 1 ? '' : 's'} · Donna closes them all`;
    }
    if (kind === 'recurring') {
      return isFi
        ? `${money(recurringDisplayPrice)} / kk · Donna sulkee joka kuukauden`
        : `${fmt(RECURRING_MONTHLY_PRICE)} / month · Donna closes every month`;
    }
    return '';
  })();

  // ===== Offer detail + checkout (two-pane) =====
  // Only reachable once an offer is chosen on Screen 2 (or deep-linked with a
  // resolved ?band=). Falls back to the qualification gate if the band is gone.
  if (view === 'detail' && kindMeta && band && amount != null) {
    return (
      <>
        <style>{SCOPED_STYLES}</style>
        <div
          style={{
            minHeight: '100vh',
            background: D.paper,
            color: D.ink,
            fontFamily: D.body,
            WebkitFontSmoothing: 'antialiased',
            display: 'flex',
            justifyContent: 'center',
            padding: 'clamp(1.5rem, 4vh, 3rem) clamp(1.25rem, 3vw, 2.5rem)'
          }}
        >
          <div style={{ width: '100%', maxWidth: '1180px' }}>
            <BackButton onClick={() => go('months')} label={L('Months')} />
            <div
              className="dl2-detailgrid"
              style={{
                display: 'grid',
                gridTemplateColumns: '1.05fr 0.95fr',
                gap: 'clamp(1.75rem, 4vw, 3.5rem)',
                alignItems: 'start'
              }}
            >
              {/* LEFT — cover art + offer write-up */}
              <div>
                <CoverArt idx={kindMeta.idx} word={kindMeta.word} badge={L(OFFER_BADGE)} />
              <h2
                style={{
                  fontFamily: D.display,
                  fontSize: 'clamp(26px, 3.4vw, 38px)',
                  letterSpacing: '0.01em',
                  lineHeight: 1,
                  textTransform: 'uppercase',
                  margin: '1.6rem 0 0'
                }}
              >
                {L(kindMeta.title)}
              </h2>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', margin: '0.9rem 0 0', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: D.mono, fontSize: 'clamp(1.7rem, 3vw, 2.3rem)', fontWeight: 600 }}>{money(amount)}</span>
                <span style={{ ...monoCaps, fontSize: 11, letterSpacing: '0.14em', color: inkA(0.55) }}>{offerSubtitle}</span>
              </div>
              <p style={{ fontFamily: D.body, fontSize: '1rem', lineHeight: 1.55, color: inkA(0.72), margin: '1.2rem 0 0', maxWidth: '44ch' }}>
                {isFi
                  ? `${selectedBiz?.scoped ? 'Kaupan yritys (maksut täsmäytetään; varastokirjanpito vain sovittaessa)' : 'Palveluyritys'}, ${band.label} tapahtumaa.`
                  : <>{selectedBiz?.scoped ? 'Commerce business (payouts reconciled; inventory accounting only when scoped)' : 'Service business'}, {band.label} transactions.</>}
                {kind === 'recurring'
                  ? (isFi
                      ? ` ${money(recurringDisplayPrice)} kuukaudessa, kiinteä. Donna sulkee jokaisen kuukauden sitä mukaa; lopeta milloin vain, yhdellä napautuksella.`
                      : ` ${fmt(RECURRING_MONTHLY_PRICE)} a month, flat. Donna closes every month as it comes; stop anytime, one tap.`)
                  : (isFi ? ` Se on ${money(price)} sulku.` : ` That's the ${fmt(price)} close.`)}
                {kind === 'catch_up' && (isFi ? ` ${months} kuukautta samaan sulkuhintaan, ei rästilisää.` : ` ${months} months at the same per-close price, no backlog premium.`)}
                {kind === 'one_month' && (isFi ? ' Yksi sulku, tehtynä puolestasi. Kokeile Donnaa tai hoida vain se kuukausi, joka on tärkeä.' : ' One close, done for you. Try Donna, or just handle the month you care about.')}
              </p>
              <ul style={{ listStyle: 'none', margin: '1.5rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {[
                  'Donna asks you only when the decision is yours',
                  'Real double-entry posted to your own Xero (QuickBooks in rollout)',
                  'Donna codes and matches; exceptions come to you to decide'
                ].map((f) => (
                  <li
                    key={f}
                    style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start', fontFamily: D.body, fontSize: '0.95rem', color: inkA(0.8) }}
                  >
                    <span aria-hidden="true" style={{ color: D.accentWarmFlat, lineHeight: 1.5 }}>
                      —
                    </span>
                    <span>{L(f)}</span>
                  </li>
                ))}
              </ul>
              <p style={{ fontStyle: 'italic', fontFamily: D.body, fontSize: '0.92rem', lineHeight: 1.5, color: inkA(0.55), margin: '1.6rem 0 0', maxWidth: '48ch' }}>
                {L('Donna asks only when the decision is yours, and that’s on every option.')}
              </p>
            </div>

            {/* RIGHT — checkout: create account now; ClientPortalGate redeems the
                stashed offer into Stripe Checkout once the clientId exists. */}
            <div
              className="dl2-checkout"
              style={{
                position: 'sticky',
                top: 'clamp(1.5rem, 4vh, 3rem)',
                border: `1px solid ${inkA(0.14)}`,
                borderRadius: '12px',
                background: '#fff',
                padding: 'clamp(1.4rem, 2.5vw, 2rem)'
              }}
            >
              <div style={{ ...monoCaps, fontSize: 10, letterSpacing: '0.2em', color: inkA(0.5) }}>{L('Your order')}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem', margin: '0.5rem 0 0' }}>
                <span style={{ fontFamily: D.body, fontWeight: 600, fontSize: '1.05rem' }}>{L(kindMeta.title)}</span>
                <span style={{ fontFamily: D.mono, fontSize: '1.05rem', fontWeight: 600 }}>{money(amount)}</span>
              </div>
              <div style={{ ...monoCaps, fontSize: 10, letterSpacing: '0.12em', color: inkA(0.45), margin: '0.25rem 0 0' }}>{offerSubtitle}</div>
              <div style={{ height: 1, background: inkA(0.1), margin: '1.2rem 0' }} />

              {/* Business name — captured above the auth buttons so it's set
                  whichever way the owner signs up (Google or email). Drives the
                  workspace + portal venture name; without it we fell back to the
                  email prefix. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.9rem' }}>
                <label style={labelStyle}>{L('Business name')}</label>
                <input
                  className="dl2-field"
                  type="text"
                  autoComplete="organization"
                  placeholder={L('Your business name')}
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  style={field}
                />
              </div>

              <button type="button" className="dl2-google" style={googleBtn} onClick={onGoogle} disabled={busy}>
                <GoogleMark />
                <span>{L('Continue with Google')}</span>
              </button>
              <Divider />

              <form onSubmit={onCreate} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={labelStyle}>{L('Work email')}</label>
                  <input
                    className="dl2-field"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company-com.example"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={field}
                    required
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={labelStyle}>{L('Choose a password')}</label>
                  <input
                    className="dl2-field"
                    type="password"
                    autoComplete="new-password"
                    placeholder={L('At least 8 characters')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={field}
                    minLength={8}
                    required
                  />
                </div>

                {/* Card — honest Stripe placeholder; becomes a Payment Element later */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <label style={labelStyle}>{L('Payment')}</label>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.65rem',
                      border: `1px dashed ${inkA(0.28)}`,
                      borderRadius: '6px',
                      padding: '0.85rem 1.1rem',
                      background: inkA(0.02)
                    }}
                  >
                    <span aria-hidden="true" style={{ width: 26, height: 17, borderRadius: '3px', border: `1.5px solid ${inkA(0.35)}`, flex: 'none' }} />
                    <span style={{ fontFamily: D.body, fontSize: '0.85rem', lineHeight: 1.4, color: inkA(0.6) }}>
                      {L('Create your account now. You’ll complete secure card payment via Stripe on the next step.')}
                    </span>
                  </div>
                </div>

                <DarkButton type="submit" disabled={busy || !email.trim() || !password} style={{ marginTop: '0.3rem' }}>
                  <span>{busy ? L('Creating account…') : L('Create your account')}</span>
                  <span aria-hidden="true" style={arrow}>
                    →
                  </span>
                </DarkButton>
              </form>
              {error && <ErrorMsg>{error}</ErrorMsg>}

              <p style={{ fontFamily: D.mono, fontSize: 10, letterSpacing: '0.06em', color: inkA(0.45), margin: '1rem 0 0' }}>
                {L('Cancel anytime · we email you a confirmation link')}
              </p>
            </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ===== Funnel (entry / sign-in / qualify / months / confirm) + brand panel =====
  return (
    <>
      <style>{SCOPED_STYLES}</style>
      <div
        className="dl2-root"
        style={{
          display: 'grid',
          gridTemplateColumns: 'clamp(380px, 40%, 600px) 1fr',
          height: '100vh',
          overflow: 'hidden',
          background: D.paper,
          color: D.ink,
          fontFamily: D.body,
          WebkitFontSmoothing: 'antialiased'
        }}
      >
        {/* ============ LEFT — THE ENTRY / FUNNEL ============ */}
        <div
          className="dl2-entry"
          style={{
            position: 'relative',
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 'clamp(2rem, 4vh, 3rem)',
            padding: 'clamp(2.5rem, 4vh, 3.75rem) clamp(2rem, 3.5vw, 3.5rem)',
            overflowY: 'auto',
            overflowX: 'hidden'
          }}
        >
          {/* logo (persistent) — left-aligned brand anchor */}
          <div>
            <div
              style={{
                fontFamily: D.display,
                fontSize: 'clamp(28px, 3vw, 34px)',
                letterSpacing: '0.04em',
                lineHeight: 1,
                color: D.ink
              }}
            >
              DONNA
            </div>
          </div>

          {/* middle (funnel state) */}
          <div style={{ width: '100%', maxWidth: '30rem' }}>
            {view === 'entry' && (
              <>
                {/* This page sells nothing: whoever runs Donna signs in here. */}
                <h1 style={{ ...h1Style, margin: '0 0 0.6rem' }}>
                  {isFi ? 'Tekoälykirjanpidon moottori.' : 'An AI bookkeeping engine.'}
                </h1>
                <p
                  style={{
                    fontFamily: D.body,
                    fontSize: '1.02rem',
                    lineHeight: 1.5,
                    color: inkA(0.72),
                    maxWidth: '38ch',
                    margin: '0 0 1.5rem'
                  }}
                >
                  {isFi
                    ? 'Kirjaudu sisään tai avaa linkki, jonka sait.'
                    : 'Sign in, or open the link you were sent.'}
                </p>
                <DarkButton onClick={() => go('signin')}>
                  <span>{L('Sign in')}</span>
                  <span aria-hidden="true" style={arrow}>
                    →
                  </span>
                </DarkButton>
              </>
            )}

            {view === 'signin' && (
              <>
                <BackButton onClick={() => go('entry')} label={L('Back')} />
                <h1 style={h1Style}>{L('Welcome back.')}</h1>
                <p style={{ ...subStyle, margin: '0 0 1.75rem' }}>{L('Sign in to pick up where Donna left off.')}</p>

                <button type="button" className="dl2-google" style={googleBtn} onClick={onGoogle} disabled={busy}>
                  <GoogleMark />
                  <span>{L('Continue with Google')}</span>
                </button>

                <Divider />

                <form onSubmit={onSignIn} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                  <label style={labelStyle}>{L('Email')}</label>
                  <input
                    className="dl2-field"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company-com.example"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={field}
                    required
                  />
                  <label style={labelStyle}>{L('Password')}</label>
                  <input
                    className="dl2-field"
                    type="password"
                    autoComplete="current-password"
                    placeholder={L('Your password')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={field}
                    required
                  />
                  <DarkButton type="submit" disabled={busy || !email.trim() || !password} style={{ marginTop: '0.3rem' }}>
                    <span>{busy ? L('Signing in…') : L('Continue with email')}</span>
                    <span aria-hidden="true" style={arrow}>
                      →
                    </span>
                  </DarkButton>
                </form>
                {error && <ErrorMsg>{error}</ErrorMsg>}
                {authNotice && <NoticeMsg>{authNotice}</NoticeMsg>}

                <div style={{ marginTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.25rem' }}>
                  <button type="button" className="dl2-textbtn" style={textLink} onClick={() => go('forgot')}>
                    {L('Forgot password?')}
                  </button>
                  <button
                    type="button"
                    className="dl2-textbtn"
                    style={textLink}
                    onClick={onResendConfirmation}
                    disabled={busy || !email.trim()}
                  >
                    {L('Resend confirmation email')}
                  </button>
                </div>

              </>
            )}

            {/* Forgot password — request a reset email. */}
            {view === 'forgot' && (
              <>
                <BackButton onClick={() => go('signin')} label={L('Back to sign in')} />
                <h1 style={h1Style}>{L('Reset your password.')}</h1>
                <p style={{ ...subStyle, margin: '0 0 1.5rem' }}>
                  {L('Enter your email and we’ll send a link to set a new password.')}
                </p>

                <form onSubmit={onForgot} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                  <label style={labelStyle}>{L('Email')}</label>
                  <input
                    className="dl2-field"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company-com.example"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={field}
                    required
                  />
                  <DarkButton type="submit" disabled={busy || !email.trim()} style={{ marginTop: '0.3rem' }}>
                    <span>{busy ? L('Sending…') : L('Send reset link')}</span>
                    <span aria-hidden="true" style={arrow}>→</span>
                  </DarkButton>
                </form>
                {error && <ErrorMsg>{error}</ErrorMsg>}
                {authNotice && <NoticeMsg>{authNotice}</NoticeMsg>}
              </>
            )}

            {/* Reset landing — set a new password from the recovery session. */}
            {view === 'reset' && (
              <>
                <h1 style={h1Style}>{L('Set a new password.')}</h1>
                <p style={{ ...subStyle, margin: '0 0 1.5rem' }}>
                  {L('Choose a new password for your account. You’ll be signed in right after.')}
                </p>

                <form onSubmit={onResetPassword} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                  <label style={labelStyle}>{L('New password')}</label>
                  <input
                    className="dl2-field"
                    type="password"
                    autoComplete="new-password"
                    placeholder={L('At least 8 characters')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={field}
                    minLength={8}
                    required
                  />
                  <DarkButton type="submit" disabled={busy || password.length < 8} style={{ marginTop: '0.3rem' }}>
                    <span>{busy ? L('Saving…') : L('Save password & sign in')}</span>
                    <span aria-hidden="true" style={arrow}>→</span>
                  </DarkButton>
                </form>
                {error && <ErrorMsg>{error}</ErrorMsg>}
                <div style={{ marginTop: '1rem' }}>
                  <button type="button" className="dl2-textbtn" style={textLink} onClick={() => go('forgot')}>
                    {L('Need a fresh reset link?')}
                  </button>
                </div>
              </>
            )}

            {/* Screen 1 — qualification gate (before any price). Eligible →
                resolve a band → Screen 2. Unfit → waitlist panel, no card form. */}
            {view === 'qualify' && !unfit && (
              <>
                <BackButton onClick={() => { setBizType(null); setVolume(null); setJurisdiction(null); setSwitching(null); go('entry'); }} label={L('Back')} />
                <h1 style={h1Style}>{L('Four quick questions.')}</h1>
                <p style={subStyle}>{L('So Donna only takes on books she can close cleanly.')}</p>

                <div style={{ ...labelStyle, marginBottom: '0.6rem' }}>{L('What kind of business?')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {BIZ_TYPES.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className="dl2-plan"
                      onClick={() => setBizType(b.id)}
                      style={optionChip(bizType === b.id)}
                    >
                      <span>{L(b.label)}</span>
                      {bizType === b.id && <span aria-hidden="true" style={{ color: QUAL_ACCENT, flex: 'none' }}>✓</span>}
                    </button>
                  ))}
                </div>
                <p style={{ fontFamily: D.body, fontSize: '0.78rem', lineHeight: 1.5, color: inkA(0.5), margin: '0.6rem 0 0', maxWidth: '52ch' }}>
                  {L(CREATOR_GATE_NOTE)}
                </p>
                {selectedBiz?.scoped && (
                  <p style={{ fontFamily: D.body, fontSize: '0.82rem', lineHeight: 1.55, color: inkA(0.68), margin: '0.8rem 0 0', maxWidth: '52ch', borderLeft: `2px solid ${QUAL_ACCENT}`, paddingLeft: '0.7rem' }}>
                    {L(COMMERCE_SCOPE_NOTE)}
                  </p>
                )}

                <div style={{ ...labelStyle, margin: '1.4rem 0 0.6rem' }}>{L('Typical monthly transactions')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {VOLUME_OPTIONS.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="dl2-plan"
                      onClick={() => setVolume(v.id)}
                      style={optionChip(volume === v.id)}
                    >
                      <span>{L(v.label)}</span>
                      {volume === v.id && <span aria-hidden="true" style={{ color: QUAL_ACCENT, flex: 'none' }}>✓</span>}
                    </button>
                  ))}
                </div>

                <div style={{ ...labelStyle, margin: '1.4rem 0 0.6rem' }}>{L('Where is your business registered?')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {COUNTRY_OPTIONS.map((country) => (
                    <button key={country.id} type="button" className="dl2-plan" onClick={() => setJurisdiction(country.id)} style={optionChip(jurisdiction === country.id)}>
                      <span>{L(country.label)}</span>
                      {jurisdiction === country.id && <span aria-hidden="true" style={{ color: QUAL_ACCENT, flex: 'none' }}>✓</span>}
                    </button>
                  ))}
                </div>

                {jurisdiction === 'GB' && (
                  <div style={{ marginTop: '1rem' }}>
                    <div style={{ ...labelStyle, marginBottom: '0.6rem' }}>{L('What kind of UK business is this?')}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                      {[['ltd', 'Limited company'], ['sole_trader', 'Sole trader']].map(([id, label]) => (
                        <button key={id} type="button" className="dl2-plan" onClick={() => setGbEntityType(id)} style={optionChip(gbEntityType === id)}>
                          <span>{L(label)}</span>
                        </button>
                      ))}
                    </div>
                    {gbEntityType === 'ltd' && (
                      <label style={{ ...labelStyle, display: 'block', marginTop: '0.8rem' }}>
                        {L('Incorporation date')}
                        <input type="date" value={incorporationDate} onChange={(event) => setIncorporationDate(event.target.value)} style={{ display: 'block', marginTop: '0.4rem' }} />
                      </label>
                    )}
                  </div>
                )}

                <div style={{ ...labelStyle, margin: '1.4rem 0 0.6rem' }}>{L('Are you switching from an existing bookkeeper mid-year?')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {SWITCHER_OPTIONS.map((answer) => (
                    <button key={answer.id} type="button" className="dl2-plan" onClick={() => setSwitching(answer.id)} style={optionChip(switching === answer.id)}>
                      <span>{L(answer.label)}</span>
                      {switching === answer.id && <span aria-hidden="true" style={{ color: QUAL_ACCENT, flex: 'none' }}>✓</span>}
                    </button>
                  ))}
                </div>

                <DarkButton onClick={() => go('months')} disabled={!eligible || (jurisdiction === 'GB' && !gbEntityType)} style={{ marginTop: '1.5rem' }}>
                  <span>{L('See my price')}</span>
                  <span aria-hidden="true" style={arrow}>→</span>
                </DarkButton>
              </>
            )}

            {/* Unfit gate — no price, no card form, ever. Capture the email to a
                waitlist tagged with the disqualifying reason. */}
            {view === 'qualify' && unfit && (
              <>
                <BackButton onClick={() => { setBizType(null); setVolume(null); setJurisdiction(null); setSwitching(null); setWaitStatus('idle'); }} label={L('Back')} />
                <h1 style={h1Style}>{L('Donna isn’t the right fit yet')}</h1>
                <p style={{ ...subStyle, maxWidth: '40ch' }}>
                  {L('Donna’s built for single-entity service and commerce businesses on cash or accrual. Yours has complexity Donna can’t close cleanly today, and we’d rather tell you now than after you’ve paid.')}
                </p>
                {waitStatus === 'done' ? (
                  <p style={{ ...monoCaps, fontSize: 11, letterSpacing: '0.16em', color: 'oklch(0.52 0.11 150)' }}>
                    {L('Thanks. We’ll be in touch when Donna can take this on.')}
                  </p>
                ) : (
                  <form onSubmit={onWaitlist} style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem', maxWidth: '24rem' }}>
                    <input
                      className="dl2-field"
                      type="email"
                      autoComplete="email"
                      placeholder="you@company-com.example"
                      value={waitEmail}
                      onChange={(e) => setWaitEmail(e.target.value)}
                      style={field}
                      required
                    />
                    <DarkButton type="submit" disabled={waitStatus === 'sending' || !waitEmail.trim()}>
                      <span>{waitStatus === 'sending' ? L('Saving…') : L('Notify me')}</span>
                      <span aria-hidden="true" style={arrow}>→</span>
                    </DarkButton>
                  </form>
                )}
              </>
            )}

            {/* Screen 2 — pick months. Three doors; recurring is presented last
                and never pre-selected. Falls back to qualify if no band resolved. */}
            {view === 'months' && band && (
              isFi ? (
              /* Screen 2 (fi) — subscription-primary (D8 "AI employee"). Donna as
                 the ongoing hire leads; the one-off closes are demoted to a
                 secondary block. Agentic scope (kirjanpito, laskutus, tarjoukset,
                 toimittaja-asiat) so the funnel stops reading bookkeeper-only,
                 with bookkeeping still the anchor. Root/English is the untouched
                 : branch below. Kari, 2026-07-13. No em dashes. */
              <>
                <BackButton onClick={() => go('qualify')} label={L('Back')} />
                <h1 style={{ ...h1Style, fontSize: 'clamp(1.7rem, 3vw, 2.2rem)' }}>Kuinka pitkälle haluat Donnan menevän?</h1>
                <p style={{ ...subStyle, maxWidth: '42ch' }}>
                  {`${selectedBiz?.scoped ? 'Kaupan yritys (maksut täsmäytetään; varastokirjanpito vain sovittaessa)' : 'Palveluyritys'}, ${L(capitalizeFirst(band.label))} tapahtumaa. Anna Donnan hoitaa homma jatkuvasti tai ota vain yksittäiset kuukaudet. Ei sitoutumista.`}
                </p>

                {/* PRIMARY — the subscription: Donna as your AI employee. */}
                <div style={doorCard(true)}>
                  <div style={{ ...monoCaps, fontSize: 12, letterSpacing: '0.12em', fontWeight: 600 }}>Ota Donna töihin</div>
                  <p style={{ fontFamily: D.body, fontSize: '0.95rem', lineHeight: 1.5, color: inkA(0.72), margin: '0.5rem 0 0' }}>
                    Donna hoitaa yrityksesi juoksevat työt WhatsAppissa: kirjanpito, laskutus, tarjoukset ja toimittaja-asiat. Hän näyttää mitä teki ja kysyy sinulta vain, kun tarvitaan päätöstäsi.
                  </p>
                  <div style={priceRow}>
                    <span style={priceAmount}>{money(recurringDisplayPrice)}</span>
                    <span style={priceUnit}>kuukaudessa · lopeta milloin vain</span>
                  </div>
                  <DarkButton onClick={() => chooseOffer('recurring')}>
                    <span>Aloita</span>
                    <span aria-hidden="true" style={arrow}>→</span>
                  </DarkButton>
                </div>

                {/* SECONDARY — one-off closes, demoted below the employee offer. */}
                <div style={{ marginTop: '1.6rem', paddingTop: '1.2rem', borderTop: `1px solid ${inkA(0.1)}`, maxWidth: '42ch' }}>
                  <div style={{ fontFamily: D.body, fontSize: '0.85rem', lineHeight: 1.5, color: inkA(0.55), margin: '0 0 0.9rem' }}>
                    Tarvitsetko vain kirjat kuntoon? Sulje yksittäisiä kuukausia tai ota rästit kiinni.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                    <div style={doorCard(false)}>
                      <div style={{ ...monoCaps, fontSize: 12, letterSpacing: '0.12em', fontWeight: 600 }}>Yksi kuukausi</div>
                      <p style={{ fontFamily: D.body, fontSize: '0.9rem', lineHeight: 1.5, color: inkA(0.65), margin: '0.5rem 0 0' }}>
                        Sulje yksi kuukausi. Kokeile Donnaa tai hoida vain se kuukausi, joka on tärkeä.
                      </p>
                      <div style={priceRow}>
                        <span style={priceAmount}>{money(price)}</span>
                        <span style={priceUnit}>yksi kuukausisulku</span>
                      </div>
                      <DarkButton onClick={() => chooseOffer('one_month')}>
                        <span>Aloita</span>
                        <span aria-hidden="true" style={arrow}>→</span>
                      </DarkButton>
                    </div>
                    <div style={doorCard(false)}>
                      <div style={{ ...monoCaps, fontSize: 12, letterSpacing: '0.12em', fontWeight: 600 }}>Ota kiinni</div>
                      <p style={{ fontFamily: D.body, fontSize: '0.9rem', lineHeight: 1.5, color: inkA(0.65), margin: '0.5rem 0 0' }}>
                        Kirjat rästissä? Kerro Donnalle montako kuukautta, se sulkee kaikki ja antaa sinulle valmiit kirjat.
                      </p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', margin: '0.9rem 0' }}>
                        <span style={{ ...labelStyle }}>Kuukausia rästissä</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                          <button type="button" aria-label="Yksi kuukausi vähemmän" onClick={() => setMonths((n) => Math.max(CATCH_UP_MIN, n - 1))} disabled={months <= CATCH_UP_MIN} style={stepBtn(months <= CATCH_UP_MIN)}>–</button>
                          <span style={{ fontFamily: D.mono, fontSize: '1.15rem', fontWeight: 600, minWidth: '1.5rem', textAlign: 'center' }}>{months}</span>
                          <button type="button" aria-label="Yksi kuukausi lisää" onClick={() => setMonths((n) => Math.min(CATCH_UP_MAX, n + 1))} disabled={months >= CATCH_UP_MAX} style={stepBtn(months >= CATCH_UP_MAX)}>+</button>
                        </div>
                      </div>
                      <div style={{ ...priceRow, margin: '0 0 1rem' }}>
                        <span style={priceAmount}>{money(price * months)}</span>
                        <span style={priceUnit}>{`${months} ${months === 1 ? 'sulku' : 'sulkua'} · Donna sulkee kaikki`}</span>
                      </div>
                      <DarkButton onClick={() => chooseOffer('catch_up')}>
                        <span>Aloita</span>
                        <span aria-hidden="true" style={arrow}>→</span>
                      </DarkButton>
                    </div>
                  </div>
                </div>

                <p style={{ fontFamily: D.body, fontSize: '0.85rem', lineHeight: 1.5, color: inkA(0.55), margin: '1.25rem 0 0', maxWidth: '42ch' }}>
                  Donna näyttää aina mitä teki ja kysyy sinulta vain, kun tarvitaan tietosi, hyväksyntäsi tai päätöksesi. Kirjojasi ei tarkista piilotettu taustatiimi.
                </p>
              </>
              ) : (
              <>
                <BackButton onClick={() => go('qualify')} label={L('Back')} />
                <h1 style={{ ...h1Style, fontSize: 'clamp(1.7rem, 3vw, 2.2rem)' }}>{L('How far do you want Donna to go?')}</h1>
                <p style={{ ...subStyle, maxWidth: '40ch' }}>
                  {isFi
                    ? `${selectedBiz?.scoped ? 'Kaupan yritys (maksut täsmäytetään; varastokirjanpito vain sovittaessa)' : 'Palveluyritys'}, ${band.label} tapahtumaa. Se on ${money(price)} sulku. Valitse haluamasi kuukaudet. Ei tilausta ellet pyydä.`
                    : `${selectedBiz?.scoped ? 'Commerce business (payouts reconciled; inventory accounting only when scoped)' : 'Service business'}, ${band.label} transactions. That's the ${fmt(price)} close. Pick the months you want. No subscription unless you ask for one.`}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  {/* Door 1 — One month */}
                  <div style={doorCard(false)}>
                    <div style={{ ...monoCaps, fontSize: 12, letterSpacing: '0.12em', fontWeight: 600 }}>{L('One month')}</div>
                    <p style={{ fontFamily: D.body, fontSize: '0.9rem', lineHeight: 1.5, color: inkA(0.65), margin: '0.5rem 0 0' }}>
                      {L('Close one month. Try Donna, or just handle the month you care about.')}
                    </p>
                    <div style={priceRow}>
                      <span style={priceAmount}>{money(price)}</span>
                      <span style={priceUnit}>{L('one monthly close')}</span>
                    </div>
                    <DarkButton onClick={() => chooseOffer('one_month')}>
                      <span>{L('Start')}</span>
                      <span aria-hidden="true" style={arrow}>→</span>
                    </DarkButton>
                  </div>

                  {/* Door 2 — Catch me up (featured) */}
                  <div style={doorCard(true)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                      <div style={{ ...monoCaps, fontSize: 12, letterSpacing: '0.12em', fontWeight: 600 }}>{L('Catch me up')}</div>
                      <span
                        style={{
                          ...monoCaps,
                          fontSize: 9,
                          fontWeight: 600,
                          letterSpacing: '0.12em',
                          padding: '0.22rem 0.5rem',
                          borderRadius: '999px',
                          backgroundImage: D.landingGradient,
                          color: '#fff'
                        }}
                      >
                        {L('most firms here')}
                      </span>
                    </div>
                    <p style={{ fontFamily: D.body, fontSize: '0.9rem', lineHeight: 1.5, color: inkA(0.65), margin: '0.5rem 0 0' }}>
                      {L('Behind on your books? Tell Donna how many months, she closes them all and hands you clean books.')}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', margin: '0.9rem 0' }}>
                      <span style={{ ...labelStyle }}>{L('Months behind')}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <button
                          type="button"
                          aria-label="One fewer month"
                          onClick={() => setMonths((n) => Math.max(CATCH_UP_MIN, n - 1))}
                          disabled={months <= CATCH_UP_MIN}
                          style={stepBtn(months <= CATCH_UP_MIN)}
                        >
                          –
                        </button>
                        <span style={{ fontFamily: D.mono, fontSize: '1.15rem', fontWeight: 600, minWidth: '1.5rem', textAlign: 'center' }}>
                          {months}
                        </span>
                        <button
                          type="button"
                          aria-label="One more month"
                          onClick={() => setMonths((n) => Math.min(CATCH_UP_MAX, n + 1))}
                          disabled={months >= CATCH_UP_MAX}
                          style={stepBtn(months >= CATCH_UP_MAX)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <div style={{ ...priceRow, margin: '0 0 1rem' }}>
                      <span style={priceAmount}>{money(price * months)}</span>
                      <span style={priceUnit}>{isFi ? `${months} ${months === 1 ? 'sulku' : 'sulkua'} · Donna sulkee kaikki` : `${months} ${months === 1 ? 'close' : 'closes'} · Donna closes them all`}</span>
                    </div>
                    <DarkButton onClick={() => chooseOffer('catch_up')}>
                      <span>{L('Start')}</span>
                      <span aria-hidden="true" style={arrow}>→</span>
                    </DarkButton>
                  </div>

                  {/* Door 3 — Keep me current (recurring; last, never default) */}
                  <div style={doorCard(false)}>
                    <div style={{ ...monoCaps, fontSize: 12, letterSpacing: '0.12em', fontWeight: 600 }}>{L('Keep me current')}</div>
                    <p style={{ fontFamily: D.body, fontSize: '0.9rem', lineHeight: 1.5, color: inkA(0.65), margin: '0.5rem 0 0' }}>
                      {L('Donna closes every month as it comes. Stop anytime, one tap, no cancel maze.')}
                    </p>
                    <div style={priceRow}>
                      <span style={priceAmount}>{money(recurringDisplayPrice)}</span>
                      <span style={priceUnit}>{L('per month · Donna closes every month')}</span>
                    </div>
                    <DarkButton onClick={() => chooseOffer('recurring')}>
                      <span>{L('Start')}</span>
                      <span aria-hidden="true" style={arrow}>→</span>
                    </DarkButton>
                  </div>
                </div>

                <p style={{ fontFamily: D.body, fontSize: '0.85rem', lineHeight: 1.5, color: inkA(0.55), margin: '1.25rem 0 0', maxWidth: '40ch' }}>
                  {L('Donna handles the close and shows you what she did. She asks you only when your facts, approval, or a decision are needed. No hidden back office reviews your books.')}
                </p>
              </>
              )
            )}

            {view === 'confirm' && (
              <>
                <p style={{ ...monoCaps, fontSize: 11, letterSpacing: '0.18em', color: 'oklch(0.52 0.11 150)', margin: '0 0 0.85rem' }}>
                  {L('Confirm your email')}
                </p>
                <h1 style={h1Style}>{L('Check your inbox.')}</h1>
                <p style={{ ...subStyle, margin: '0 0 1.5rem' }}>
                  {isFi ? 'Lähetimme vahvistuslinkin osoitteeseen ' : 'We sent a confirmation link to '}
                  <strong style={{ color: D.ink }}>{confirmEmail || L('your email')}</strong>
                  {isFi ? '. Avaa se aktivoidaksesi tilisi ja kirjaudu sitten tästä.' : '. Open it to activate your account, then sign in here.'}
                </p>
                <DarkButton
                  onClick={() => {
                    setConfirmEmail('');
                    setPassword('');
                    go('signin');
                  }}
                >
                  <span>{L('Back to sign in')}</span>
                  <span aria-hidden="true" style={arrow}>
                    →
                  </span>
                </DarkButton>
                <div style={{ marginTop: '1rem', fontFamily: D.body, fontSize: '0.9rem', color: inkA(0.6) }}>
                  {L('Didn’t get it?')}{' '}
                  <button type="button" className="dl2-textbtn" style={textLink} onClick={onResendConfirmation} disabled={busy}>
                    {L('Resend confirmation email')}
                  </button>
                </div>
                {error && <ErrorMsg>{error}</ErrorMsg>}
                {authNotice && <NoticeMsg>{authNotice}</NoticeMsg>}
              </>
            )}
          </div>

          {/* footer (persistent) */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '1.1rem 1.5rem',
              ...monoCaps,
              fontSize: 10.5,
              letterSpacing: '0.18em'
            }}
          >
            {FOOTER_LINKS
              // /fi is a consumer landing; the firm/bookkeeper console link is
              // dropped there (Kari, 2026-07-13). Root/English keeps it.
              .filter((link) => !(isFi && link.label === 'Firms'))
              .map((link) => (
                <a
                  key={link.label}
                  className="dl2-link"
                  href={link.href}
                  style={{
                    color: link.strong ? inkA(0.78) : inkA(0.5),
                    fontWeight: link.strong ? 500 : 400,
                    textDecoration: 'none'
                  }}
                >
                  {L(link.label)}
                </a>
              ))}
          </div>
        </div>

        {/* ============ RIGHT — THE BRAND PANEL ============ */}
        <BrandPanel isFi={isFi} />
      </div>
    </>
  );
};

export default DonnaLanding;
