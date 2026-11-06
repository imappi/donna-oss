// FI production-readiness P0 (docs/design-donna-finland-production-readiness.md)
// — the ALV registration-threshold watch for a NON-ALV-registered Finnish
// client. Pure KEEP-layer arithmetic: calendar-year turnover vs the statutory
// registration threshold, three closed statuses, no model call anywhere. The
// watch never registers anybody and never touches the books — it is a
// deterministic read whose job is to make sure a client quietly crossing the
// threshold becomes an owner conversation instead of a compliance surprise.
//
// Scope guard: the watch applies ONLY where FINLAND_ALV_CODING does NOT act —
// an ALV-registered client's obligations are watched by the return engine
// (FI-3). The DB caller enforces that; this module is pure.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Config-plane flag (migration 042 pattern) — read via clientFlagActs with
// envFallback () => false, never an env pair. Canary per client.
export const FINLAND_ALV_THRESHOLD_WATCH_FLAG_KEY = 'FINLAND_ALV_THRESHOLD_WATCH';

// The registration threshold: €20,000 (Arvonlisäverolaki, in force from 2025 —
// raised from €15,000; the same figure the tilikartta's dormant-ALV posture
// already cites). The AMOUNT is well-established; the crossing MECHANICS under
// the 2025 EU small-business scheme (calendar-year basis, the prior-year
// condition, no retroactive liability from the start of the year) must be
// re-confirmed against vero.fi primaries from a network-open session — the
// same F-FI8-R1/F-FI3-1 pass that confirms the 2026 rate set. Until then the
// watch stays deliberately CONSERVATIVE: it warns on either year's turnover,
// and it only ever warns — it never asserts liability.
export const ALV_REGISTRATION_THRESHOLD_EUR = 20000;
export const ALV_THRESHOLD_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  source: 'Arvonlisäverolaki €20,000 registration threshold (2025) via secondary confirmation; crossing mechanics CORROBORATED via search extraction 2026-07-11 (vero.fi small-business guidance 48658 titles + vatcalc/Marosa/Vaasa-region): exemption requires BOTH current AND previous calendar year ≤ €20k, liability starts AT the crossing date (no retroactivity to year start), sales exceeding the threshold taxable in full — the conservative warn-on-either-year watch matches. Byte-level primary read pending (network policy, F-FI8-R1 pass)'
});

// Warn early enough that the owner can act before the crossing, late enough to
// not cry wolf on every small book.
export const ALV_THRESHOLD_APPROACH_FRACTION = 0.8;

export const ALV_THRESHOLD_STATUSES = Object.freeze(['ok', 'approaching', 'exceeded']);

// The evidence type the exceeded-escalation ask carries (the G-6 pattern —
// a closed constant, matched by the deterministic ask id in the drain).
export const ALV_THRESHOLD_EVIDENCE_TYPE = 'alv_threshold_review';

// buildAlvThresholdEscalationQuestion({ watch }) — the owner ask minted when
// the watch says `exceeded` (D-G2E-4, docs/design-donna-finland-g2-threshold-
// escalation.md). Finnish-first, states the numbers, carries the honesty
// boundary verbatim: registration happens in OmaVero by the OWNER — Donna
// never registers anybody, and no ALV goes on invoices before registration.
// Returns null for any non-exceeded watch (the caller must not ask).
export const buildAlvThresholdEscalationQuestion = ({ watch } = {}) => {
  if (!watch || watch.status !== 'exceeded') return null;
  const euro = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;
  return (
    `Liikevaihtosi (${euro(watch.drivingTurnover)}) ylittää ALV-rekisteröinnin rajan (${euro(watch.thresholdEur)}). ` +
    `Rekisteröintivelvollisuus pitää selvittää heti OmaVerossa — Donna ei voi rekisteröidä puolestasi, ` +
    `eikä laskuihin saa lisätä ALV:tä ennen rekisteröintiä. ` +
    `Oletko jo rekisteröitynyt ALV-velvolliseksi tai laittanut rekisteröinnin vireille? ` +
    `Vastaa tähän viestiin, niin hoidetaan kirjanpito sen mukaan. ` +
    `(Your turnover has crossed the €20,000 VAT registration threshold — please confirm your OmaVero registration status by replying here.)`
  );
};

// buildAlvRegistrationWatch({ year, currentYearTurnover, priorYearTurnover })
// → the watch verdict. Pure, never throws. Turnovers are the calendar-year
// revenue sums (credit − debit over revenue-type lines) the DB caller reads
// from the posted ledger; negative sums clamp to 0 (a refund-heavy period is
// not negative turnover for threshold purposes — conservative).
export const buildAlvRegistrationWatch = ({
  year,
  currentYearTurnover = 0,
  priorYearTurnover = 0,
  thresholdEur = ALV_REGISTRATION_THRESHOLD_EUR
} = {}) => {
  const current = Math.max(0, round2(num(currentYearTurnover)));
  const prior = Math.max(0, round2(num(priorYearTurnover)));
  const threshold = num(thresholdEur) > 0 ? round2(num(thresholdEur)) : ALV_REGISTRATION_THRESHOLD_EUR;
  const driving = Math.max(current, prior);
  const fraction = round2(driving / threshold);
  const status = driving >= threshold
    ? 'exceeded'
    : (driving >= threshold * ALV_THRESHOLD_APPROACH_FRACTION ? 'approaching' : 'ok');
  const euro = (n) => `${n.toFixed(2).replace('.', ',')} €`;
  const note = status === 'exceeded'
    ? `Liikevaihto (${euro(driving)}) ylittää ALV-rekisteröinnin rajan (${euro(threshold)}) — rekisteröintivelvollisuus on selvitettävä heti (OmaVero). Laskuihin ei saa lisätä ALV:tä ennen rekisteröintiä.`
    : status === 'approaching'
      ? `Liikevaihto (${euro(driving)}) lähestyy ALV-rekisteröinnin rajaa (${euro(threshold)}, ${Math.round(fraction * 100)} %). Seuraa kertymää ja valmistaudu rekisteröintiin.`
      : null;
  return {
    applicable: true,
    year: num(year) || null,
    thresholdEur: threshold,
    currentYearTurnover: current,
    priorYearTurnover: prior,
    drivingTurnover: driving,
    fraction,
    headroomEur: round2(Math.max(0, threshold - driving)),
    status,
    note,
    provenance: { ...ALV_THRESHOLD_PROVENANCE }
  };
};
