// G-5 (FI-15) — ennakkovero (prepayment tax): forecast-and-warn, bounded
// honesty (docs/design-donna-finland-production-readiness.md). Donna forecasts
// the BUSINESS PROFIT trajectory from the posted ledger, records what the
// owner tells it about Vero's prepayment decision (profile.ennakkovero,
// written through updateClientProfileInDb's validated patch path), and warns
// when the two diverge — pointing at OmaVero, never at a Donna-computed tax
// figure. The bounded-honesty invariant, pin-tested: NO code path ever
// computes a tax amount. The final tax depends on the owner's other income
// and deductions, which Donna cannot see; the 5 % yrittäjävähennys appears in
// FORECASTS ONLY (Vero computes it in assessment); and the copy never claims
// the tax is "handled".
//
// Deterministic KEEP-layer module, no model call. The DB caller reads the
// calendar-year P&L from the posted ledger (the ennakkovero tax year for a
// private trader is the calendar year, independent of tilikausi) plus
// Verohallinto-matching debits from the bank feed; THIS module maps them onto
// a CLOSED status enum.

// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback
// () => false; dark by default, canary per client.
export const FINLAND_ENNAKKOVERO_WATCH_FLAG_KEY = 'FINLAND_ENNAKKOVERO_WATCH';

// The entrepreneur deduction (yrittäjävähennys, TVL 30 a §) — applied to the
// FORECAST display only. Vero applies it itself in assessment; Donna showing
// it pre-deducted would double-count in the owner's head.
export const YRITTAJAVAHENNYS_RATE = 0.05;

// Thresholds are SERVICE-SCOPE policy (when a forecast is loud enough to
// nudge), NOT tax-law figures — re-tune only on Kari's dated call.
//   • MIN_FORECAST_DAYS — before this many days of the year have elapsed, an
//     annualization is noise; confidence stays 'early' and no divergence or
//     materiality verdict fires.
//   • DIVERGENCE_RATIO / DIVERGENCE_MIN_EUR — forecast vs the decision's
//     income basis must differ by BOTH >25 % and >€3,000 to warn.
//   • MATERIAL_PROFIT_EUR — annualized-profit floor for nudging a book that
//     has NO recorded decision ("check OmaVero whether prepayments are due").
export const ENNAKKOVERO_MIN_FORECAST_DAYS = 90;
export const ENNAKKOVERO_DIVERGENCE_RATIO = 0.25;
export const ENNAKKOVERO_DIVERGENCE_MIN_EUR = 3000;
export const ENNAKKOVERO_MATERIAL_PROFIT_EUR = 8000;

// Closed status enum. Resting semantics: 'on_track' / 'not_configured' /
// 'not_liable' are quiet; everything else renders a nudge on the watch
// surface (and quiet statuses can still carry an informational flag note).
//   • not_configured — no decision recorded, no Vero debits, forecast not
//     material (or too early): silence, not a nag.
//   • payments_detected_unconfigured — Verohallinto debits in the feed but no
//     recorded decision: record the decision's basis + amount from OmaVero.
//   • forecast_material_unconfigured — no decision recorded but the
//     annualized profit forecast is material: check OmaVero.
//   • on_track — decision recorded, forecast within tolerance (or too early
//     to judge).
//   • review_recommended — forecast diverges from the decision's income basis
//     beyond tolerance, or the recorded decision is for a prior year.
//   • not_liable — owner recorded that Vero has set no prepayments; quiet,
//     but flags fire if payments or material profit then appear.
export const ENNAKKOVERO_STATUSES = Object.freeze([
  'not_configured',
  'payments_detected_unconfigured',
  'forecast_material_unconfigured',
  'on_track',
  'review_recommended',
  'not_liable'
]);

// Closed flag side-channel (never allegations — every note carries the
// innocent explanation first where one exists).
export const ENNAKKOVERO_FLAGS = Object.freeze([
  'decision_stale',
  'forecast_above_basis',
  'forecast_below_basis',
  'payment_gap',
  'payments_while_not_liable',
  'material_profit_while_not_liable'
]);

// The honesty boundary, stated verbatim on every warning that could otherwise
// read as tax advice. Pin-tested: this note (and never a "handled" claim) is
// what keeps the forecast on the right side of the bounded-honesty line.
export const ENNAKKOVERO_HONESTY_NOTE_FI =
  'Ennuste kattaa vain liiketoiminnan tuloksen (5 %:n yrittäjävähennys on huomioitu vain ennusteessa — Verohallinto laskee sen verotuksessa). Lopulliseen veroon vaikuttavat myös muut tulot ja vähennykset, joita Donna ei näe — tarkista kokonaiskuva OmaVerosta. Donna ei laske veron määrää.';

// Verohallinto debit detection over bank-feed descriptions. Conservative and
// INFORMATIONAL only (a Vero debit can be ALV or other taxes, not necessarily
// ennakkovero — the copy says "Verohallinnon veloituksia", never more).
// 'vero' standalone is word-bounded so 'verkkokauppa'/'veroton' stay out;
// \m / \M are the Postgres word boundaries. Keep the two forms in lockstep.
export const ENNAKKOVERO_PAYMENT_PATTERN = /ennakkovero|verohallinto|\bvero\b/i;
export const ENNAKKOVERO_PAYMENT_SQL_PATTERN = String.raw`ennakkovero|verohallinto|\mvero\M`;

const dateOnly = (value) => {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

const daysBetween = (fromIso, toIso) => {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86400000);
};

const round2 = (n) => Math.round(n * 100) / 100;

// hasEnnakkoveroPayments(descriptions) → true if any description matches the
// Verohallinto pattern (JS mirror of the SQL pattern, for evaluator inputs
// that arrive pre-fetched).
export const hasEnnakkoveroPayments = (descriptions = []) =>
  descriptions.some((raw) => ENNAKKOVERO_PAYMENT_PATTERN.test(String(raw || '')));

// forecastBusinessProfit({ ytdRevenueEur, ytdExpensesEur, onDate })
// → { year, days_elapsed, days_in_year, ytd_revenue_eur, ytd_expenses_eur,
//     ytd_profit_eur, annualized_profit_eur,
//     taxable_after_yrittajavahennys_eur, confidence }.
// Linear calendar-year annualization of the posted-ledger YTD result — a
// PLANNING figure, deliberately naive (no seasonality). Everything here is
// profit-scale; no field is ever a tax amount.
export const forecastBusinessProfit = ({ ytdRevenueEur = 0, ytdExpensesEur = 0, onDate } = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('forecastBusinessProfit requires an onDate (ISO date or timestamp).');
  const year = Number(at.slice(0, 4));
  const daysInYear = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
  const daysElapsed = (daysBetween(`${year}-01-01`, at) ?? 0) + 1;
  const revenue = round2(Number(ytdRevenueEur) || 0);
  const expenses = round2(Number(ytdExpensesEur) || 0);
  const profit = round2(revenue - expenses);
  const annualized = round2(profit * (daysInYear / daysElapsed));
  return {
    year,
    days_elapsed: daysElapsed,
    days_in_year: daysInYear,
    ytd_revenue_eur: revenue,
    ytd_expenses_eur: expenses,
    ytd_profit_eur: profit,
    annualized_profit_eur: annualized,
    // Forecast display ONLY — Vero computes the deduction in assessment.
    taxable_after_yrittajavahennys_eur: round2(Math.max(0, annualized) * (1 - YRITTAJAVAHENNYS_RATE)),
    confidence: daysElapsed >= ENNAKKOVERO_MIN_FORECAST_DAYS ? 'ok' : 'early'
  };
};

// normalizeEnnakkoveroProfile(value) — the validated write shape for
// profile.ennakkovero (clientProfileSchema.js delegates here). Throws
// statusCode-400 errors on a bad shape; null clears the profile. The writer
// stores what the owner SAID about Vero's decision — the income basis
// (assessed_income_eur) and the annual prepayment total (annual_amount_eur)
// are transcribed FROM the decision, never derived by Donna.
export const normalizeEnnakkoveroProfile = (value) => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('ennakkovero must be an object or null.');
    error.statusCode = 400;
    throw error;
  }
  const out = {};
  if (value.not_liable === true) {
    out.not_liable = true;
    if (typeof value.note === 'string' && value.note.trim()) out.note = value.note.trim().slice(0, 500);
    return out;
  }
  if (value.tax_year !== undefined && value.tax_year !== null) {
    const taxYear = Number(value.tax_year);
    if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
      const error = new Error('tax_year must be a four-digit year.');
      error.statusCode = 400;
      throw error;
    }
    out.tax_year = taxYear;
  }
  for (const key of ['assessed_income_eur', 'annual_amount_eur']) {
    if (value[key] === undefined || value[key] === null) continue;
    const amount = Number(value[key]);
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) {
      const error = new Error(`${key} must be a non-negative number.`);
      error.statusCode = 400;
      throw error;
    }
    out[key] = round2(amount);
  }
  const decidedOn = value.decided_on === undefined || value.decided_on === null ? null : dateOnly(value.decided_on);
  if (value.decided_on !== undefined && value.decided_on !== null && !decidedOn) {
    const error = new Error('decided_on must be an ISO date (YYYY-MM-DD).');
    error.statusCode = 400;
    throw error;
  }
  if (decidedOn) out.decided_on = decidedOn;
  if (typeof value.note === 'string' && value.note.trim()) out.note = value.note.trim().slice(0, 500);
  return Object.keys(out).length ? out : null;
};

// Deterministic fi-style grouping (space thousands separator) — no
// toLocaleString, whose separator characters vary across ICU builds.
const formatEurApprox = (amount) => {
  const rounded = Math.round((Number(amount) || 0) / 100) * 100;
  const sign = rounded < 0 ? '\u2212' : '';
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${digits}\u00A0\u20AC`;
};

// evaluateEnnakkoveroStatus({ profile, forecast, paymentsDetected,
// lastPaymentOn }) → { status, flags, forecast, lastPaymentOn, profile,
// notes_fi }. Pure. `forecast` is forecastBusinessProfit's output (required —
// the DB caller always builds it). Quiet statuses return empty notes; every
// divergence/materiality note is followed by the honesty boundary.
export const evaluateEnnakkoveroStatus = ({
  profile = null,
  forecast,
  paymentsDetected = false,
  lastPaymentOn = null
} = {}) => {
  if (!forecast || typeof forecast !== 'object' || !Number.isFinite(forecast.year)) {
    throw new Error('evaluateEnnakkoveroStatus requires a forecast (forecastBusinessProfit output).');
  }
  const flags = [];
  const notes = [];
  const envelope = (status) => ({
    status,
    flags,
    forecast,
    lastPaymentOn: dateOnly(lastPaymentOn),
    profile: profile || null,
    notes_fi: notes
  });

  const confident = forecast.confidence === 'ok';
  const material = confident && forecast.annualized_profit_eur >= ENNAKKOVERO_MATERIAL_PROFIT_EUR;

  if (profile?.not_liable === true) {
    if (paymentsDetected) {
      flags.push('payments_while_not_liable');
      notes.push('Profiilin mukaan ennakkoveroa ei ole määrätty, mutta tiliotteella näkyy Verohallinnon veloituksia — tarkistetaan kumpi pitää paikkansa.');
    }
    if (material) {
      flags.push('material_profit_while_not_liable');
      notes.push(`Liiketoiminnan tulosennuste on noin ${formatEurApprox(forecast.annualized_profit_eur)} vuodelle ${forecast.year}, vaikka ennakkoveroa ei profiilin mukaan ole määrätty — tarkista OmaVerosta, pitäisikö ennakkoveroa hakea. ${ENNAKKOVERO_HONESTY_NOTE_FI}`);
    }
    return envelope('not_liable');
  }

  const hasDecision = Boolean(profile) && (
    profile.tax_year !== undefined ||
    profile.assessed_income_eur !== undefined ||
    profile.annual_amount_eur !== undefined
  );
  if (!hasDecision) {
    if (paymentsDetected) {
      notes.push('Tiliotteella näkyy Verohallinnon veloituksia, mutta ennakkoveropäätöstä ei ole kirjattu — kirjataan päätöksen tiedot OmaVerosta (veron peruste ja vuosimäärä).');
      return envelope('payments_detected_unconfigured');
    }
    if (material) {
      notes.push(`Liiketoiminnan tulosennuste on noin ${formatEurApprox(forecast.annualized_profit_eur)} vuodelle ${forecast.year}, eikä ennakkoveropäätöstä ole kirjattu. Tarkista OmaVerosta, onko ennakkovero määrätty — jos on, kirjataan päätöksen tiedot; jos ei, ennakon hakeminen voi säästää jäännösverolta. ${ENNAKKOVERO_HONESTY_NOTE_FI}`);
      return envelope('forecast_material_unconfigured');
    }
    return envelope('not_configured');
  }

  if (Number.isInteger(profile.tax_year) && profile.tax_year < forecast.year) {
    flags.push('decision_stale');
    notes.push(`Kirjattu ennakkoveropäätös koskee vuotta ${profile.tax_year} — tarkista OmaVerosta kuluvan vuoden ${forecast.year} päätös ja päivitetään tiedot.`);
  }
  if (confident && typeof profile.assessed_income_eur === 'number') {
    const diff = forecast.annualized_profit_eur - profile.assessed_income_eur;
    const tolerance = Math.max(profile.assessed_income_eur * ENNAKKOVERO_DIVERGENCE_RATIO, ENNAKKOVERO_DIVERGENCE_MIN_EUR);
    if (diff > tolerance) {
      flags.push('forecast_above_basis');
      notes.push(`Liiketoiminnan tulosennuste (noin ${formatEurApprox(forecast.annualized_profit_eur)}) on selvästi ennakkoveropäätöksen perustetta (${formatEurApprox(profile.assessed_income_eur)}) suurempi — ennakon korottaminen OmaVerossa voi säästää jäännösverolta ja sen korolta.`);
    } else if (-diff > tolerance) {
      flags.push('forecast_below_basis');
      notes.push(`Liiketoiminnan tulosennuste (noin ${formatEurApprox(forecast.annualized_profit_eur)}) on selvästi ennakkoveropäätöksen perustetta (${formatEurApprox(profile.assessed_income_eur)}) pienempi — ennakkoa voi todennäköisesti alentaa OmaVerossa.`);
    }
  }
  // Informational, never a downgrade: many owners pay ennakkovero from a
  // personal account or by e-invoice, which this book never sees.
  if (confident && !paymentsDetected && (profile.annual_amount_eur ?? 0) > 0) {
    flags.push('payment_gap');
    notes.push('Ennakkoveron eriä ei näy liiketilillä tänä vuonna. Jos maksat ne henkilökohtaiselta tililtä tai e-laskulla, tämä on kunnossa — muuten tarkista maksutilanne OmaVerosta.');
  }

  if (flags.includes('decision_stale') || flags.includes('forecast_above_basis') || flags.includes('forecast_below_basis')) {
    notes.push(ENNAKKOVERO_HONESTY_NOTE_FI);
    return envelope('review_recommended');
  }
  return envelope('on_track');
};
