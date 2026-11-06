// AE ae_vat_return — the deadline watch's PURE half: the two ask kinds,
// deterministic classification against the recorded due date, and the
// owner-voiced question builders. The drain that sweeps these
// (drainAeVatReturnDeadlineEscalations, firmDb.js) is bound by name on the
// jurisdiction-neutral obligation sweep — core never imports ae/ directly.
// Design: docs/design-donna-ae-vat-return.md (build-state 2026-08-30).
//
// Two-terminal-states, applied: a due period is either FILED (the owner's
// act — Donna prepared the figures and says so) or blocked on a NAMED fact
// only the owner can supply; both asks land on the owner. Nothing here rests
// on Donna or on nobody.

// The watch runs UNCONDITIONALLY for every AE-jurisdiction client — the
// born-dark AE_VAT_RETURN_WATCH flag was deleted 2026-08-31 (Kari, "nothing
// dark"; flag terminal state 1 of the rollout-flags rail). Registrant
// scoping comes from the registration RECORD, not a flag; a wrong version
// mints a deduped owner ask, never a ledger write.

// Market-neutral evidence types and ask-id shapes, the threshold drain's
// convention ('vat_threshold_review' / 'vat-threshold-…'): one duty across
// markets, one id family, dedupe by construction.
export const AE_VAT_RETURN_DEADLINE_EVIDENCE_TYPE = 'vat_return_deadline';
export const AE_VAT_RETURN_PERIOD_INTAKE_EVIDENCE_TYPE = 'vat_return_period_intake';

// How far ahead of the recorded due date the deadline ask mints. The return
// window is 28 days from period end; 14 days of lead leaves the owner half
// the window with prepared figures (or a named blocker) in hand. A
// deterministic product constant, not a statutory number.
export const AE_VAT_RETURN_DEADLINE_LEAD_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const dateOnly = (value) => String(value || '').slice(0, 10);

// classifyAeVatReturnPeriodDeadline({ period, asOf }) → { state, daysUntilDue }.
// state: 'scheduled' (outside the lead window — the sweep stays silent),
// 'due_soon' (inside it), 'overdue' (past the recorded due date). Pure
// calendar arithmetic against the RECORDED due date — the business-day shift
// is already baked into what EmaraTax stated at record time.
export const classifyAeVatReturnPeriodDeadline = ({ period = {}, asOf } = {}) => {
  const due = dateOnly(period.dueOn || period.due_date);
  const at = dateOnly(asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    throw new Error('classifyAeVatReturnPeriodDeadline requires ISO dates for the due date and asOf.');
  }
  const daysUntilDue = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${at}T00:00:00Z`)) / DAY_MS);
  if (daysUntilDue < 0) return { state: 'overdue', daysUntilDue };
  if (daysUntilDue <= AE_VAT_RETURN_DEADLINE_LEAD_DAYS) return { state: 'due_soon', daysUntilDue };
  return { state: 'scheduled', daysUntilDue };
};

// One deadline ask per (firm, client, recorded period) — a period's due date
// never recurs, so the period row id IS the year-equivalent dedupe key.
export const aeVatReturnDeadlineAskId = ({ firmId, clientId, periodId }) =>
  `vat-return-deadline-${firmId}-${clientId}-${periodId}`;

// One intake ask per (client, calendar year): a registered client the watch
// covers but with NO open recorded period is a client whose assigned periods
// Donna cannot see — the missing fact is the owner's to supply.
export const aeVatReturnPeriodIntakeAskId = ({ firmId, clientId, year }) =>
  `vat-return-period-intake-${firmId}-${clientId}-${year}`;

const aed = (value) => `AED ${Math.abs(Number(value) || 0).toFixed(2)}`;

// buildAeVatReturnDeadlineQuestion({ period, classification, vatReturn,
// refusal }) — the owner ask for a due or overdue period. Exactly one of
// `vatReturn` (the prepared verdict envelope) or `refusal` ({ code, message })
// rides in: prepared states the figures and asks the owner to file;
// blocked names what Donna still needs. Donna never files — the honesty
// boundary stated in the ask itself. Returns null for a 'scheduled'
// classification (the caller must not ask).
export const buildAeVatReturnDeadlineQuestion = ({ period = {}, classification = {}, vatReturn = null, refusal = null } = {}) => {
  if (!classification || classification.state === 'scheduled' || classification.state === undefined) return null;
  const key = period.periodKey || period.period_key;
  const due = dateOnly(period.dueOn || period.due_date);
  const opening = classification.state === 'overdue'
    ? `Your UAE VAT return for ${key} was due ${due} and is now overdue — late filing carries FTA penalties. `
    : `Your UAE VAT return for ${key} is due ${due}. `;
  if (vatReturn) {
    const position = vatReturn.outcome === 'refund'
      ? `a refund position of ${aed(vatReturn.netVat)}`
      : `net VAT payable of ${aed(vatReturn.netVat)}`;
    return (
      opening
      + `I have prepared the figures from your books: ${position}. `
      + 'Before filing, confirm the customs-populated goods-imports figure EmaraTax shows against your records. '
      + 'You file the return in EmaraTax — I cannot file on your behalf. Reply "filed" once it is in and I will close the period, or reply here if any figure looks wrong.'
    );
  }
  const blocker = refusal?.message
    ? `I cannot finish preparing it yet: ${refusal.message} `
    : 'I cannot finish preparing it yet. ';
  return (
    opening
    + blocker
    + 'Reply here with the missing piece and I will have the figures ready for you to file in EmaraTax — I cannot file on your behalf.'
  );
};

// buildAeVatReturnPeriodIntakeQuestion() — the ask for a registered client
// with no recorded open period: the FTA assigns periods per registrant, so
// only the owner's EmaraTax view can answer.
export const buildAeVatReturnPeriodIntakeQuestion = () => (
  'You are VAT-registered, and the FTA assigns your VAT return periods and due dates individually — EmaraTax shows them under your TRN. '
  + 'I do not have your current tax period on file, so I cannot watch the filing deadline for you yet. '
  + 'Reply with your current VAT return period (start and end dates) and the due date EmaraTax shows — a screenshot works — and I will track every deadline and prepare the figures from your books.'
);
