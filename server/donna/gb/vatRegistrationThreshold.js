// GB statutory obligation `gb_vat_registration_threshold` — the UK VAT
// registration-threshold watch for a NOT-YET-VAT-REGISTERED British client.
// The direct sibling of finland/alvRegistrationThreshold.js, and deliberately
// its own module rather than a re-parameterisation of it: the UK duty has TWO
// independent limbs and the second has no Finnish analogue at all.
//
// Pure KEEP-layer arithmetic: no model call, no I/O, no clock. The watch never
// registers anybody, never touches the books, and never asserts that a
// liability HAS arisen — it makes a client quietly crossing a statutory
// boundary into an owner conversation instead of a compliance surprise.
//
// ── Why this lives in server/donna/gb/ ──────────────────────────────────────
//
// A VAT registration threshold has no generic form — it is irreducibly
// country-specific — and the obligations leg exists precisely so such an
// implementation can bind BY NAME into a jurisdiction-neutral engine. This is
// therefore not the G12 anti-pattern (which objects to generic business motion
// forked into a country namespace). The two anti-patterns to keep avoiding:
// `outbound/` must never import `gb/` directly, and there must be no
// country-named cron task.
//
// ── Scope guard ─────────────────────────────────────────────────────────────
//
// The watch applies ONLY to a client that is NOT already VAT-registered — i.e.
// ONLY where HMRC_MTD_VAT does not act, that flag being the GB analogue of the
// FI watch's FINLAND_ALV_CODING guard: a client on the MTD VAT lane is
// VAT-registered by definition, and its obligations belong to the return lane
// (gb_vat_return_mtd, still declared_unbuilt). The DB caller enforces that;
// this module is pure.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Config-plane flag (migration 042/043 pattern) — read via clientFlagActs with
// envFallback () => false, NEVER an env pair (the rollout-flags rail). Born
// dark: no stage rows are seeded anywhere, so the drain finds zero candidates
// until someone deliberately enables it per client.
export const GB_VAT_THRESHOLD_WATCH_FLAG_KEY = 'GB_VAT_THRESHOLD_WATCH';

// ── The statutory numbers ───────────────────────────────────────────────────
//
// £90,000 registration / £88,000 deregistration, both unchanged since
// 1 April 2024. The two are DIFFERENT NUMBERS for DIFFERENT DUTIES and
// conflating them is the obvious bug in this file: deregistration is a
// voluntary right that arises when turnover falls BELOW £88,000, and it plays
// no part in the registration test below. It is declared here only so that a
// later deregistration watch does not re-derive it from memory, and it is
// deliberately never read by buildGbVatRegistrationWatch.
export const VAT_REGISTRATION_THRESHOLD_GBP = 90000;
export const VAT_DEREGISTRATION_THRESHOLD_GBP = 88000;

export const VAT_THRESHOLD_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  asOf: '2026-07-27',
  authority: 'HM Revenue & Customs',
  source: 'Value Added Tax Act 1994, Schedule 1 para 1(1)(a) (backward look) and para 1(1)(b) (forward look). '
    + 'Registration threshold £90,000, deregistration threshold £88,000, both unchanged since 1 April 2024. '
    + 'CORROBORATED 2026-07-27 across multiple independent secondary sources (Xero UK, THP, AVASK, Protax, salarytax.uk) '
    + 'plus HMRC internal manuals VATREG18200 (the forward look) and VATREG18300 (notification deadlines) as surfaced in search extraction. '
    + 'Byte-level primary read of legislation.gov.uk/ukpga/1994/23/schedule/1 and gov.uk/vat-registration PENDING: '
    + 'gov.uk returns HTTP 403 through this environment\'s egress proxy. Same posture, and same honesty boundary, '
    + 'as the FI watch\'s ALV_THRESHOLD_PROVENANCE — VERIFY against primary before any GB client is onboarded onto a statutory lane.'
});

// Warn early enough that the owner can act before the crossing, late enough to
// not cry wolf on every small book. Same fraction as the FI watch.
export const VAT_THRESHOLD_APPROACH_FRACTION = 0.8;

export const GB_VAT_THRESHOLD_STATUSES = Object.freeze(['ok', 'approaching', 'exceeded']);

// The two limbs, named. `backward_look` and `forward_look` are HMRC's own
// vocabulary (VATREG18100/18200), kept verbatim so the receipt reads the way
// the manual does.
export const GB_VAT_THRESHOLD_LIMBS = Object.freeze(['backward_look', 'forward_look']);

// The evidence type the exceeded-escalation ask carries (the G-6 pattern — a
// closed constant, matched by the deterministic ask id in the drain).
export const GB_VAT_THRESHOLD_EVIDENCE_TYPE = 'vat_threshold_review';

const limbVerdict = ({ amount, threshold }) => {
  const value = Math.max(0, round2(num(amount)));
  const fraction = round2(value / threshold);
  const status = value > threshold
    ? 'exceeded'
    : (value >= threshold * VAT_THRESHOLD_APPROACH_FRACTION ? 'approaching' : 'ok');
  return { value, fraction, status, headroomGbp: round2(Math.max(0, threshold - value)) };
};

const RANK = { ok: 0, approaching: 1, exceeded: 2 };
const gbp = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// buildGbVatRegistrationWatch({ ... }) → the watch verdict. Pure, never throws.
//
//   rollingTurnover      the BACKWARD look: taxable turnover over the trailing
//                        12 months ending at `asOf`. Rolling, NOT a tax year and
//                        NOT a calendar year — this is the single biggest shape
//                        difference from the FI watch, which is calendar-year.
//   committedNext30Days  the FORWARD look: the value of taxable supplies the
//                        client is already COMMITTED to make in the 30 days
//                        beginning at `asOf` — that window ALONE, never an
//                        annualised run-rate. See the honesty note below.
//
// Negative sums clamp to 0 (a refund-heavy period is not negative turnover for
// threshold purposes — conservative).
//
// ── The forward look is a belief, and Donna cannot observe a belief ─────────
//
// Para 1(1)(b) turns on whether there are "reasonable grounds for believing"
// that taxable supplies in the next 30 days alone will exceed the threshold.
// That is a fact about the OWNER'S EXPECTATION. Donna cannot read it from a
// ledger, so this watch does NOT pretend to: `committedNext30Days` is the
// deterministic, strictly-conservative floor the caller CAN observe (already-
// committed supplies dated into the window). A quiet forward limb therefore
// means "nothing committed that we can see", NEVER "no liability" — which is
// exactly why the owner ask asks the owner about their expectation rather than
// telling them what it is. This is the FACT-vs-KNOWLEDGE fork applied: Donna
// answers the knowledge half herself (what the threshold is, what the duty is,
// what the deadline is) and asks the owner only the half only they can know.
export const buildGbVatRegistrationWatch = ({
  asOf = null,
  rollingTurnover = 0,
  committedNext30Days = 0,
  thresholdGbp = VAT_REGISTRATION_THRESHOLD_GBP
} = {}) => {
  const threshold = num(thresholdGbp) > 0 ? round2(num(thresholdGbp)) : VAT_REGISTRATION_THRESHOLD_GBP;
  // Both limbs test "exceeds", strictly — turnover EQUAL to the threshold does
  // not trigger registration under either paragraph.
  const backward = limbVerdict({ amount: rollingTurnover, threshold });
  const forward = limbVerdict({ amount: committedNext30Days, threshold });

  const status = RANK[backward.status] >= RANK[forward.status] ? backward.status : forward.status;
  const drivingLimb = status === 'ok'
    ? null
    : (RANK[backward.status] >= RANK[forward.status] ? 'backward_look' : 'forward_look');

  let note = null;
  if (status === 'exceeded' && drivingLimb === 'backward_look') {
    note = `Taxable turnover for the 12 months to ${asOf || 'the watch date'} (${gbp(backward.value)}) exceeds the VAT registration threshold (${gbp(threshold)}). `
      + 'Registration is compulsory: HMRC must be notified within 30 days of the end of the month in which the threshold was crossed. Donna cannot register on your behalf.';
  } else if (status === 'exceeded' && drivingLimb === 'forward_look') {
    note = `Taxable supplies already committed for the 30 days from ${asOf || 'the watch date'} (${gbp(forward.value)}) exceed the VAT registration threshold (${gbp(threshold)}) in that 30-day window alone. `
      + 'Registration is compulsory from the date the expectation arose, and HMRC must be notified within 30 days of it. Donna cannot register on your behalf.';
  } else if (status === 'approaching' && drivingLimb === 'backward_look') {
    note = `Taxable turnover for the trailing 12 months (${gbp(backward.value)}) is approaching the VAT registration threshold (${gbp(threshold)}, ${Math.round(backward.fraction * 100)}%). Watch the rolling total and prepare to register.`;
  } else if (status === 'approaching') {
    note = `Taxable supplies committed for the next 30 days (${gbp(forward.value)}) are approaching the VAT registration threshold (${gbp(threshold)}, ${Math.round(forward.fraction * 100)}%) in that window alone.`;
  }

  return {
    applicable: true,
    asOf: asOf || null,
    thresholdGbp: threshold,
    backward: { limb: 'backward_look', ...backward },
    forward: { limb: 'forward_look', ...forward },
    // Convenience mirrors of the driving numbers, so a receipt or a panel does
    // not have to know which limb won.
    rollingTurnover: backward.value,
    committedNext30Days: forward.value,
    status,
    drivingLimb,
    note,
    provenance: { ...VAT_THRESHOLD_PROVENANCE }
  };
};

// buildGbVatThresholdEscalationQuestion({ watch }) — the owner ask minted when
// the watch says `exceeded`. States the numbers, names the deadline, and
// carries the honesty boundary verbatim: registration happens with HMRC BY THE
// OWNER — Donna never registers anybody, and no VAT goes on invoices before
// the registration is effective. Returns null for any non-exceeded watch (the
// caller must not ask).
export const buildGbVatThresholdEscalationQuestion = ({ watch } = {}) => {
  if (!watch || watch.status !== 'exceeded') return null;
  const threshold = gbp(watch.thresholdGbp);
  if (watch.drivingLimb === 'forward_look') {
    return (
      `You already have ${gbp(watch.committedNext30Days)} of work committed for the next 30 days, which is above the VAT registration threshold (${threshold}) in that 30-day window on its own. `
      + 'If you expect to bill more than that threshold in the next 30 days alone, VAT registration becomes compulsory from the date you formed that expectation, and HMRC must be notified within 30 days of it. '
      + 'Do you expect your taxable sales in the next 30 days to exceed the threshold, and have you already registered for VAT or started the registration? '
      + 'Reply here and I will set the bookkeeping up to match. I cannot register on your behalf, and no VAT can go on your invoices until the registration is effective.'
    );
  }
  return (
    `Your taxable turnover for the last 12 months (${gbp(watch.rollingTurnover)}) has crossed the VAT registration threshold (${threshold}). `
    + 'Registration is compulsory once the rolling 12-month total goes over it, and HMRC must be notified within 30 days of the end of the month in which you crossed. '
    + 'Have you already registered for VAT, or started the registration? '
    + 'Reply here and I will set the bookkeeping up to match. I cannot register on your behalf, and no VAT can go on your invoices until the registration is effective.'
  );
};
