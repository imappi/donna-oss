// AE statutory obligation `ae_vat_registration_threshold` — the UAE VAT
// registration-threshold watch for a NOT-YET-VAT-REGISTERED Emirati client.
// The direct sibling of gb/vatRegistrationThreshold.js and, through it, of
// finland/alvRegistrationThreshold.js — the same duty shape, a third market,
// one engine. Deliberately its own module rather than a re-parameterisation of
// GB's: the numbers, the citations, the currency, and the notification rule
// are all AE facts that must carry their own provenance.
//
// Pure KEEP-layer arithmetic: no model call, no I/O, no clock. The watch never
// registers anybody, never touches the books, and never asserts that a
// liability HAS arisen — it makes a client quietly crossing a statutory
// boundary into an owner conversation instead of a compliance surprise.
//
// ── Why this lives in server/donna/ae/ ──────────────────────────────────────
//
// A VAT registration threshold has no generic form — it is irreducibly
// country-specific — and the obligations leg exists precisely so such an
// implementation can bind BY NAME into a jurisdiction-neutral engine
// (`ae_vat_threshold_escalation`). The two standing anti-patterns hold:
// `outbound/` must never import `ae/` directly, and there is no country-named
// cron task.
//
// ── Scope guard ─────────────────────────────────────────────────────────────
//
// The watch applies ONLY to a client that is NOT already VAT-registered. GB
// gates that on its return-lane flag (HMRC_MTD_VAT); the AE return lane does
// not exist yet, so the AE drain gates on the registration RECORD instead
// (ae/vatRegistration.js, resolved on the watch date): a recorded `registered`
// is skipped — its duties belong to the return lane (ae_vat_return, still
// declared_unbuilt). `false` AND `null`-unknown both run the watch, on
// purpose: the escalation ask itself asks "have you already registered?", so
// an unknown resolves through the owner rather than being silently guessed
// either way. The DB caller enforces that; this module is pure.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// The watch runs UNCONDITIONALLY for every AE-jurisdiction client — the
// born-dark AE_VAT_THRESHOLD_WATCH flag was deleted 2026-08-31 (Kari,
// "nothing dark"; flag terminal state 1 of the rollout-flags rail — deleted
// because the behavior is unconditional). An ask-minting watch is outside
// the canary-reserved lanes of the 2026-08-27 rail: a wrong version mints a
// deduped owner ask, never a ledger write.

// ── The statutory numbers ───────────────────────────────────────────────────
//
// AED 375,000 mandatory / AED 187,500 voluntary, both unchanged since VAT
// commenced on 2018-01-01. The two are DIFFERENT NUMBERS for DIFFERENT LEGAL
// EFFECTS and conflating them is the obvious bug in this file: the voluntary
// threshold creates a RIGHT to register (Article 17 — commonly exercised to
// recover input tax), never a duty, and it plays no part in the registration
// test below. It is declared here so a later voluntary-registration surface
// (or the mandatory-deregistration rule, which keys on the same number) does
// not re-derive it from memory, and it is deliberately never read by
// buildAeVatRegistrationWatch.
export const VAT_MANDATORY_REGISTRATION_THRESHOLD_AED = 375000;
export const VAT_VOLUNTARY_REGISTRATION_THRESHOLD_AED = 187500;

export const AE_VAT_THRESHOLD_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  asOf: '2026-08-30',
  authority: 'Federal Tax Authority',
  source: 'Federal Decree-Law No. 8 of 2017 on Value Added Tax, Article 13 (mandatory registration: taxable supplies and '
    + 'imports exceed the mandatory threshold over the previous 12 months, or are anticipated to exceed it within the '
    + 'coming 30 days) and Article 17 (voluntary registration above the voluntary threshold), with the Executive '
    + 'Regulation (Cabinet Decision No. 52 of 2017). Mandatory threshold AED 375,000, voluntary threshold AED 187,500, '
    + 'both unchanged since VAT commenced 2018-01-01. CORROBORATED 2026-08-30 across the FTA\'s own registration page as '
    + 'surfaced in search extraction (tax.gov.ae) plus multiple independent secondary sources (EGSH, BCL, DASA, Zola, '
    + 'Sphere). Byte-level primary read of tax.gov.ae PENDING: the domain is blocked by this environment\'s egress proxy. '
    + 'Same posture, and same honesty boundary, as the GB watch\'s VAT_THRESHOLD_PROVENANCE — VERIFY against primary '
    + 'before any AE client is onboarded onto a statutory lane.'
});

// Warn early enough that the owner can act before the crossing, late enough to
// not cry wolf on every small book. Same fraction as the FI and GB watches.
export const AE_VAT_THRESHOLD_APPROACH_FRACTION = 0.8;

export const AE_VAT_THRESHOLD_STATUSES = Object.freeze(['ok', 'approaching', 'exceeded']);

// The two limbs, named from the statute's own shape (Article 13's "previous
// 12-month period" and "coming 30 days") rather than HMRC's backward/forward
// vocabulary — the receipt should read the way the imposing law does.
export const AE_VAT_THRESHOLD_LIMBS = Object.freeze(['preceding_12_months', 'next_30_days']);

// The evidence type the exceeded-escalation ask carries — the SAME value the
// GB watch uses, on purpose: it is one duty shape across markets and the ask
// surfaces are uniform; the client's jurisdiction disambiguates.
export const AE_VAT_THRESHOLD_EVIDENCE_TYPE = 'vat_threshold_review';

const limbVerdict = ({ amount, threshold }) => {
  const value = Math.max(0, round2(num(amount)));
  const fraction = round2(value / threshold);
  const status = value > threshold
    ? 'exceeded'
    : (value >= threshold * AE_VAT_THRESHOLD_APPROACH_FRACTION ? 'approaching' : 'ok');
  return { value, fraction, status, headroomAed: round2(Math.max(0, threshold - value)) };
};

const RANK = { ok: 0, approaching: 1, exceeded: 2 };
const aed = (n) => `AED ${Number(n).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// buildAeVatRegistrationWatch({ ... }) → the watch verdict. Pure, never throws.
//
//   rollingTurnover      the PRECEDING-12-MONTHS limb: taxable turnover over
//                        the trailing 12 months ending at `asOf`. Rolling —
//                        the same window shape as GB, NOT the FI calendar year.
//   committedNext30Days  the NEXT-30-DAYS limb: the value of taxable supplies
//                        the client is already COMMITTED to make in the 30
//                        days beginning at `asOf` — that window ALONE, never
//                        an annualised run-rate.
//
// Negative sums clamp to 0 (a refund-heavy period is not negative turnover for
// threshold purposes — conservative).
//
// ── The forward limb is a belief, and Donna cannot observe a belief ─────────
//
// Article 13's forward test turns on whether it is ANTICIPATED that supplies
// will exceed the threshold in the coming 30 days. That is a fact about the
// OWNER'S EXPECTATION — the same honesty note as the GB watch, carried over
// whole: `committedNext30Days` is the deterministic, strictly-conservative
// floor the caller CAN observe (already-committed supplies dated into the
// window). A quiet forward limb means "nothing committed that we can see",
// NEVER "no liability" — which is why the owner ask asks the owner about
// their expectation rather than telling them what it is. The FACT-vs-KNOWLEDGE
// fork applied: Donna answers the knowledge half herself (what the threshold
// is, what the duty is) and asks the owner only the half only they can know.
export const buildAeVatRegistrationWatch = ({
  asOf = null,
  rollingTurnover = 0,
  committedNext30Days = 0,
  thresholdAed = VAT_MANDATORY_REGISTRATION_THRESHOLD_AED
} = {}) => {
  const threshold = num(thresholdAed) > 0 ? round2(num(thresholdAed)) : VAT_MANDATORY_REGISTRATION_THRESHOLD_AED;
  // Both limbs test "exceeds", strictly — turnover EQUAL to the threshold does
  // not trigger registration under either limb.
  const backward = limbVerdict({ amount: rollingTurnover, threshold });
  const forward = limbVerdict({ amount: committedNext30Days, threshold });

  const status = RANK[backward.status] >= RANK[forward.status] ? backward.status : forward.status;
  const drivingLimb = status === 'ok'
    ? null
    : (RANK[backward.status] >= RANK[forward.status] ? 'preceding_12_months' : 'next_30_days');

  let note = null;
  if (status === 'exceeded' && drivingLimb === 'preceding_12_months') {
    note = `Taxable turnover for the 12 months to ${asOf || 'the watch date'} (${aed(backward.value)}) exceeds the mandatory VAT registration threshold (${aed(threshold)}). `
      + 'Registration is compulsory: an application to the Federal Tax Authority is due within 30 days of becoming required to register. Donna cannot register on your behalf.';
  } else if (status === 'exceeded' && drivingLimb === 'next_30_days') {
    note = `Taxable supplies already committed for the 30 days from ${asOf || 'the watch date'} (${aed(forward.value)}) exceed the mandatory VAT registration threshold (${aed(threshold)}) in that 30-day window alone. `
      + 'Registration becomes compulsory once crossing the threshold is anticipated, and the FTA application is due within 30 days of that. Donna cannot register on your behalf.';
  } else if (status === 'approaching' && drivingLimb === 'preceding_12_months') {
    note = `Taxable turnover for the trailing 12 months (${aed(backward.value)}) is approaching the mandatory VAT registration threshold (${aed(threshold)}, ${Math.round(backward.fraction * 100)}%). Watch the rolling total and prepare to register.`;
  } else if (status === 'approaching') {
    note = `Taxable supplies committed for the next 30 days (${aed(forward.value)}) are approaching the mandatory VAT registration threshold (${aed(threshold)}, ${Math.round(forward.fraction * 100)}%) in that window alone.`;
  }

  return {
    applicable: true,
    asOf: asOf || null,
    thresholdAed: threshold,
    backward: { limb: 'preceding_12_months', ...backward },
    forward: { limb: 'next_30_days', ...forward },
    // Convenience mirrors of the driving numbers, so a receipt or a panel does
    // not have to know which limb won.
    rollingTurnover: backward.value,
    committedNext30Days: forward.value,
    status,
    drivingLimb,
    note,
    provenance: { ...AE_VAT_THRESHOLD_PROVENANCE }
  };
};

// buildAeVatThresholdEscalationQuestion({ watch }) — the owner ask minted when
// the watch says `exceeded`. States the numbers, names the deadline, and
// carries the honesty boundary verbatim: registration happens with the FTA BY
// THE OWNER — Donna never registers anybody, and no VAT goes on invoices
// before the registration is effective (the conditional floor enforces that
// mechanically). Returns null for any non-exceeded watch (the caller must not
// ask).
export const buildAeVatThresholdEscalationQuestion = ({ watch } = {}) => {
  if (!watch || watch.status !== 'exceeded') return null;
  const threshold = aed(watch.thresholdAed);
  if (watch.drivingLimb === 'next_30_days') {
    return (
      `You already have ${aed(watch.committedNext30Days)} of work committed for the next 30 days, which is above the mandatory VAT registration threshold (${threshold}) in that 30-day window on its own. `
      + 'If you anticipate your taxable sales in the next 30 days alone will exceed that threshold, VAT registration becomes compulsory, and the application to the Federal Tax Authority is due within 30 days. '
      + 'Do you expect your taxable sales in the next 30 days to exceed the threshold, and have you already registered for VAT or started the registration on EmaraTax? '
      + 'Reply here and I will set the bookkeeping up to match. I cannot register on your behalf, and no VAT can go on your invoices until the registration is effective.'
    );
  }
  return (
    `Your taxable turnover for the last 12 months (${aed(watch.rollingTurnover)}) has crossed the mandatory VAT registration threshold (${threshold}). `
    + 'Registration is compulsory once the rolling 12-month total goes over it, and the application to the Federal Tax Authority is due within 30 days of becoming required to register. '
    + 'Have you already registered for VAT, or started the registration on EmaraTax? '
    + 'Reply here and I will set the bookkeeping up to match. I cannot register on your behalf, and no VAT can go on your invoices until the registration is effective.'
  );
};
