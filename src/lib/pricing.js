// Donna pricing — single source of truth.
//
// One product, one promise: Donna runs the books within the owner's rules,
// shows what she did, and asks only when owner facts, approval, or specialist
// judgment are needed. No hidden human reviewer checks every close. Two shapes
// of money (Kari, 2026-07-03 — "bands
// one-off, $99/mo recurring"):
//   - one_month / catch_up: billed PER CLOSE at the volume band's price.
//   - recurring: a flat RECURRING_MONTHLY_PRICE subscription, same price for
//     every qualified band.
// The volume bands remain the QUALIFICATION gate either way — >1,000 tx/mo is
// unfit, never a band — so a valid bandId is required even where it no longer
// moves the price.
//
// Import this everywhere a price is shown or computed. The customer's
// qualification answers resolve a `bandId`; the band and kind resolve a price;
// the price is shown to them — they never pick a price.
//
// Repricing note (2026-07-03): Stripe amounts are built inline as `price_data`
// at checkout (stripeBilling.js), so a change here reprices NEW checkouts
// only; existing subscriptions keep the price they were created at —
// grandfathered by construction, no migration needed.

export const BANDS = [
  { id: 'lt200', label: 'under 200', maxTx: 200, price: 50 },
  { id: '200-500', label: '200–500', maxTx: 500, price: 90 },
  { id: '500-1k', label: '500–1,000', maxTx: 1000, price: 150 }
  // > 1,000 tx is NOT a band — it routes to the unfit gate.
];

export const getBand = (bandId) => BANDS.find((b) => b.id === bandId) || null;

// Per-close price for a band, or null for an unknown/unfit band.
export const priceForBand = (bandId) => getBand(bandId)?.price ?? null;

// The flat monthly subscription price ("keep me current"), the same for every
// qualified band.
export const RECURRING_MONTHLY_PRICE = 99;

// Checkout price book by ISO-2 billing jurisdiction. USD retains the recorded
// offer amounts above. FI/GB deliberately carry no amounts until Kari makes the
// price-point decision: resolving the currency is safe; charging a guessed
// amount is not. Add decided amounts here, in the one shared source, before
// enabling those checkouts.
export const BILLING_PRICE_BOOK = Object.freeze({
  US: Object.freeze({ currency: 'usd', recurring: RECURRING_MONTHLY_PRICE, bands: Object.freeze(Object.fromEntries(BANDS.map(({ id, price }) => [id, price]))) }),
  FI: Object.freeze({ currency: 'eur', recurring: null, bands: null }),
  GB: Object.freeze({ currency: 'gbp', recurring: null, bands: null })
});

export const billingPriceBookForJurisdiction = (jurisdiction) =>
  BILLING_PRICE_BOOK[String(jurisdiction || '').trim().toUpperCase()] || null;

export const billingUnitPriceFor = ({ jurisdiction, kind, bandId } = {}) => {
  const book = billingPriceBookForJurisdiction(jurisdiction);
  if (!book) return { ok: false, reason: 'jurisdiction_unknown', book: null, price: null };
  const price = kind === 'recurring' ? book.recurring : book.bands?.[bandId];
  if (!Number.isFinite(price)) return { ok: false, reason: 'price_unconfirmed', book, price: null };
  return { ok: true, reason: null, book, price };
};

// Per-unit price for an offer kind: the band's per-close price for one-off
// kinds, the flat monthly price for recurring. Null for an unknown/unfit band
// regardless of kind — the band is the qualification, not just the price.
export const unitPriceFor = (kind, bandId) => {
  const bandPrice = priceForBand(bandId);
  if (bandPrice == null) return null;
  return kind === 'recurring' ? RECURRING_MONTHLY_PRICE : bandPrice;
};

// No backlog premium: catch-up months bill at the same per-close band price, so
// the total is simply price × months.
export const catchUpTotal = (bandId, months) => {
  const price = priceForBand(bandId);
  if (price == null) return null;
  const n = Math.max(1, Math.round(Number(months) || 0));
  return price * n;
};

// Compute the charge for any offer kind. one_month bills one close at the band
// price; catch_up bills `months` closes at the band price; recurring bills the
// flat monthly subscription. `amount` is always derived here — never
// user-entered.
export const amountFor = ({ kind, bandId, months = 1 }) => {
  const price = unitPriceFor(kind, bandId);
  if (price == null) return null;
  if (kind === 'catch_up') return catchUpTotal(bandId, months);
  return price; // one_month (band per-close) | recurring (flat monthly)
};

export const fmt = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();

// ── Finnish pilot lane (Phase 1, non-ALV toiminimi) ─────────────────────────
// D7 (Kari, 2026-07-12): €29/mo competitor parity, shown ex-VAT ("+ alv") per the
// Finnish B2B convention. This is a DIFFERENT, smaller product than the $99
// US/UK/SG/AUS DFY line (a public €29 "Donna Toiminimi" must never read as "$99
// Donna, discounted" — the anchor-bleed guard, memo D7). It is DISPLAY-ONLY for
// now: the landing shows this number, but there is no self-serve EUR checkout —
// admitted pilots onboard via the pilot channel, free-or-founder-invoiced. The
// live EUR Stripe path (stripeBilling.js `price_data` currency) lands with the
// FI-L3 checkout slice, not here. Keeping the number HERE (not hardcoded in the
// landing JSX) preserves the single-source-of-truth rail.
export const FINLAND_PILOT_MONTHLY_PRICE_EUR = 29;

// Per-close EUR prices for the Finnish pilot's one-off doors (One month /
// Catch me up), keyed to the SAME volume bands as the USD line so the funnel
// behaves identically. ⚠️ PROPOSED starting figures (Claude, 2026-07-12) —
// pending Kari's dated confirmation. Only the €29/mo recurring is a decided
// number (D7); these one-off euro amounts are a proposal to adjust, not a
// dated call. Display-only (no EUR checkout yet — FI-L3).
export const FINLAND_PILOT_BANDS_EUR = [
  { id: 'lt200', price: 39 },
  { id: '200-500', price: 59 },
  { id: '500-1k', price: 99 }
];
export const finlandBandPriceEur = (bandId) =>
  FINLAND_PILOT_BANDS_EUR.find((b) => b.id === bandId)?.price ?? null;

// Finnish euro formatter: "29 €" (space + symbol after the amount, fi-FI
// grouping/decimals). The "+ alv" ex-VAT suffix is copy, applied at the display
// site, not baked in here.
export const fmtEur = (n) =>
  Math.round(Number(n) || 0).toLocaleString('fi-FI') + ' €';

// Catch-up stepper bounds (months behind).
export const CATCH_UP_MIN = 1;
export const CATCH_UP_MAX = 24;
export const CATCH_UP_DEFAULT = 4;

// The three doors. one_month / catch_up are bought once (a one-off payment);
// recurring renews monthly (a subscription). The billing layer maps these to
// Stripe modes — never the customer-facing copy.
export const VALID_KINDS = ['one_month', 'catch_up', 'recurring'];
export const isValidKind = (kind) => VALID_KINDS.includes(kind);

export const clampCatchUpMonths = (months) => {
  const n = Math.round(Number(months));
  if (!Number.isFinite(n)) return CATCH_UP_DEFAULT; // missing/NaN → stepper default
  return Math.min(CATCH_UP_MAX, Math.max(CATCH_UP_MIN, n)); // 0/negative floor to 1
};

// Validate + normalize a purchase offer into the canonical, server-trusted
// shape. Returns null for an unfit/unknown band or an invalid kind — this is the
// SINGLE place the funnel and the server agree on what a chargeable offer is.
// `amount` is ALWAYS derived here, never accepted from the caller (the customer
// picks months, not a price — pricing guardrail #3).
export const resolveOffer = ({ kind, bandId, months } = {}) => {
  if (!isValidKind(kind)) return null;
  const price = unitPriceFor(kind, bandId);
  if (price == null) return null;
  const resolvedMonths = kind === 'catch_up' ? clampCatchUpMonths(months) : 1;
  const amount = amountFor({ kind, bandId, months: resolvedMonths });
  if (amount == null) return null;
  return { kind, bandId, months: resolvedMonths, price, amount };
};
