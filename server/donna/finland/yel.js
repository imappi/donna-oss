// G-4 (FI-15) — YEL (yrittäjän eläkevakuutus): track / remind / flag — NEVER
// determine income. The external review's bounded framing, adopted verbatim
// (docs/design-donna-finland-production-readiness.md): Donna records what the
// owner tells it (insurer, confirmed YEL work income, payment cadence),
// reminds when the confirmation goes stale, and flags premium payments it can
// see in the bank feed — and it never once computes, suggests, or validates
// what the YEL income SHOULD be. That number is set between the entrepreneur
// and their insurer; every note below points there ("tarkista vakuutusyhtiöstä
// / OmaVero"), never at a Donna-derived figure.
//
// Deterministic KEEP-layer module, no model call. The DB caller reads the
// client profile (`profile.yel`, written through updateClientProfileInDb's
// validated patch path) + insurer-matching debits from the bank feed; THIS
// module maps them onto a CLOSED status enum.

// Config-plane flag (migration 042 pattern) — clientFlagActs, envFallback
// () => false; dark by default, canary per client.
export const FINLAND_YEL_WATCH_FLAG_KEY = 'FINLAND_YEL_WATCH';

// The four YEL insurers (työeläkevakuutusyhtiöt). Closed registry: id is the
// stored vocabulary, pattern detects premium debits in bank-feed descriptions.
// 'elo'/'varma' are ordinary Finnish words — word-bounded patterns + the
// money_out>0 filter keep detection conservative; detection only ever FLAGS.
export const YEL_INSURERS = Object.freeze([
  { id: 'ilmarinen', label: 'Ilmarinen', pattern: /ilmarinen/i },
  { id: 'varma', label: 'Varma', pattern: /\bvarma\b/i },
  { id: 'elo', label: 'Elo', pattern: /\belo\b/i },
  { id: 'veritas', label: 'Veritas', pattern: /veritas/i }
]);

// The same registry as ONE case-insensitive Postgres alternation (`~*`);
// \m / \M are Postgres word boundaries. Keep in lockstep with YEL_INSURERS.
export const YEL_INSURER_SQL_PATTERN = String.raw`ilmarinen|\mvarma\M|\melo\M|veritas`;

export const YEL_INSURER_IDS = Object.freeze(YEL_INSURERS.map((i) => i.id));

// Payment cadence is informational (it shapes the reminder tone, never a
// computation). Closed set; null = not recorded.
export const YEL_CADENCES = Object.freeze(['monthly', 'quarterly', 'biannual', 'annual']);

// Closed status enum. Resting semantics: 'active' / 'exempt' are quiet;
// everything else renders a nudge on the watch surface.
//   • not_configured — no YEL profile recorded, no premiums seen.
//   • premiums_detected_unconfigured — YEL-insurer debits in the feed but no
//     recorded profile: record insurer + confirmed income (track half).
//   • active — profile recorded, confirmation fresh (≤ 12 months).
//   • review_due — the confirmed income is stale (> 12 months) or undated:
//     remind the owner to CHECK it against their actual work with the insurer
//     (remind half — the check is theirs, never Donna's).
//   • exempt — the owner has recorded they are not YEL-liable; quiet, but the
//     flag half still fires if premiums then appear.
export const YEL_STATUSES = Object.freeze([
  'not_configured',
  'premiums_detected_unconfigured',
  'active',
  'review_due',
  'exempt'
]);

export const YEL_REVIEW_INTERVAL_DAYS = 365;
// Premium-gap flag horizon: two quarters with no visible premium debit.
export const YEL_PREMIUM_GAP_DAYS = 185;

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

// matchYelInsurers(descriptions) → sorted unique insurer ids found.
export const matchYelInsurers = (descriptions = []) => {
  const found = new Set();
  for (const raw of descriptions) {
    const text = String(raw || '');
    if (!text) continue;
    for (const { id, pattern } of YEL_INSURERS) {
      if (pattern.test(text)) found.add(id);
    }
  }
  return [...found].sort();
};

// normalizeYelProfile(value) — the validated write shape for profile.yel
// (clientProfileSchema.js delegates here). Throws statusCode-400 errors on a
// bad shape; null clears the profile. NOTE what is deliberately absent: any
// derivation of the income figure — the writer stores what the owner SAID.
export const normalizeYelProfile = (value) => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('yel must be an object or null.');
    error.statusCode = 400;
    throw error;
  }
  const out = {};
  if (value.exempt === true) {
    out.exempt = true;
    if (typeof value.note === 'string' && value.note.trim()) out.note = value.note.trim().slice(0, 500);
    return out;
  }
  const insurer = typeof value.insurer === 'string' ? value.insurer.trim().toLowerCase() : '';
  if (insurer) {
    if (!YEL_INSURER_IDS.includes(insurer)) {
      const error = new Error(`Unknown YEL insurer: ${JSON.stringify(value.insurer)}.`);
      error.statusCode = 400;
      throw error;
    }
    out.insurer = insurer;
  }
  if (value.confirmed_income_eur !== undefined && value.confirmed_income_eur !== null) {
    const income = Number(value.confirmed_income_eur);
    if (!Number.isFinite(income) || income < 0 || income > 1000000) {
      const error = new Error('confirmed_income_eur must be a non-negative number.');
      error.statusCode = 400;
      throw error;
    }
    out.confirmed_income_eur = Math.round(income * 100) / 100;
  }
  const confirmedOn = value.confirmed_on === undefined || value.confirmed_on === null ? null : dateOnly(value.confirmed_on);
  if (value.confirmed_on !== undefined && value.confirmed_on !== null && !confirmedOn) {
    const error = new Error('confirmed_on must be an ISO date (YYYY-MM-DD).');
    error.statusCode = 400;
    throw error;
  }
  if (confirmedOn) out.confirmed_on = confirmedOn;
  if (value.cadence !== undefined && value.cadence !== null) {
    const cadence = String(value.cadence).trim().toLowerCase();
    if (!YEL_CADENCES.includes(cadence)) {
      const error = new Error(`cadence must be one of ${YEL_CADENCES.join('/')}.`);
      error.statusCode = 400;
      throw error;
    }
    out.cadence = cadence;
  }
  return Object.keys(out).length ? out : null;
};

// evaluateYelStatus({ profile, premiumInsurersDetected, lastPremiumOn, onDate })
// → { status, flags, insurersDetected, lastPremiumOn, profile, notes_fi }.
// Pure, never throws on garbage. `flags` is a closed side-channel:
//   • premiums_while_exempt — recorded exempt but insurer debits visible.
//   • premium_gap — active profile but no visible premium debit for two
//     quarters (informational: many books pay YEL from a personal account —
//     the note says exactly that instead of alleging a missed payment).
//   • insurer_mismatch — detected insurer differs from the recorded one.
export const evaluateYelStatus = ({
  profile = null,
  premiumInsurersDetected = [],
  lastPremiumOn = null,
  onDate
} = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('evaluateYelStatus requires an onDate (ISO date or timestamp).');
  const detected = Array.isArray(premiumInsurersDetected) ? premiumInsurersDetected.filter(Boolean) : [];
  const lastPremium = dateOnly(lastPremiumOn);
  const flags = [];
  const notes = [];

  const envelope = (status) => ({
    status,
    flags,
    insurersDetected: [...detected].sort(),
    lastPremiumOn: lastPremium,
    profile: profile || null,
    notes_fi: notes
  });

  if (profile?.exempt === true) {
    if (detected.length) {
      flags.push('premiums_while_exempt');
      notes.push('Profiilissa lukee, ettei YEL-velvollisuutta ole, mutta tiliotteelta löytyy työeläkeyhtiön veloituksia — tarkistetaan tilanne.');
    }
    return envelope('exempt');
  }

  if (!profile || (!profile.insurer && profile.confirmed_income_eur === undefined)) {
    if (detected.length) {
      notes.push('Tiliotteelta löytyy YEL-vakuutusmaksuja, mutta YEL-tietoja (yhtiö, vahvistettu työtulo) ei ole kirjattu — täydennetään profiili.');
      return envelope('premiums_detected_unconfigured');
    }
    notes.push('YEL-tietoja ei ole kirjattu. Jos YEL-vakuutus on voimassa, kirjataan yhtiö ja vahvistettu työtulo; jos ei, merkitään peruste.');
    return envelope('not_configured');
  }

  if (profile.insurer && detected.length && !detected.includes(profile.insurer)) {
    flags.push('insurer_mismatch');
    notes.push('Tiliotteen työeläkeyhtiö ei täsmää kirjattuun YEL-yhtiöön — tarkistetaan kumpi on ajantasainen.');
  }
  if (lastPremium ? (daysBetween(lastPremium, at) ?? 0) > YEL_PREMIUM_GAP_DAYS : detected.length === 0) {
    flags.push('premium_gap');
    notes.push('YEL-maksuja ei näy liiketilillä viime kuukausilta. Jos maksat YEL:n henkilökohtaiselta tililtä, tämä on kunnossa — muuten tarkista maksutilanne vakuutusyhtiöstä.');
  }

  const confirmedOn = dateOnly(profile.confirmed_on);
  const staleDays = confirmedOn ? daysBetween(confirmedOn, at) : null;
  if (!confirmedOn || (staleDays ?? 0) > YEL_REVIEW_INTERVAL_DAYS) {
    notes.push('Vahvistetun YEL-työtulon tarkistuksesta on yli vuosi (tai päiväys puuttuu). Tarkista vakuutusyhtiösi kanssa, että työtulo vastaa todellista työpanostasi — työtulo vaikuttaa eläkkeeseen ja sosiaaliturvaan. Donna ei määritä työtuloa.');
    return envelope('review_due');
  }
  return envelope('active');
};
