const gbp = (value) => `£${Math.abs(Number(value) || 0).toFixed(2)}`;

// Which prep refusals the OWNER should see, and as what. A missing VAT
// registration is THEIR fact (an honest ask); a partial-period registration is
// a hold they should know about. Everything else — no HMRC period persisted
// yet, uncoded or misfooted ledger lines, not registered across the period —
// is Donna's work-in-progress or a genuine nothing-due, and rendering it at
// the owner would be noise they cannot act on. Those return null: no card.
const OWNER_VISIBLE_REFUSALS = {
  GB_VAT_REGISTRATION_NOT_ESTABLISHED:
    'Donna needs your VAT registration status before she can prepare a return. Tell her whether (and from when) the business is VAT-registered.',
  GB_VAT_REGISTRATION_PARTIAL_PERIOD:
    'Your VAT registration covers only part of this period, so Donna is holding the return for review instead of preparing a partial one.'
};

// The portal card's whole verdict from the owner envelope
// ({ surface_acts, prepared, refusal }). Null means render nothing.
export const ownerVatReturnCardState = (envelope) => {
  if (!envelope?.surface_acts) return null;
  const view = buildGbVatReturnViewModel(envelope.prepared);
  if (view?.status === 'prepared') return { kind: 'prepared', view };
  const message = OWNER_VISIBLE_REFUSALS[envelope.refusal?.code];
  return message ? { kind: 'blocked', code: envelope.refusal.code, message } : null;
};

export const buildGbVatReturnViewModel = (prepared) => {
  if (!prepared?.period || !prepared?.vatReturn) return null;
  const { period, vatReturn } = prepared;
  const boxes = vatReturn.boxes || {};
  if (Object.keys(boxes).length !== 9) return { status: 'refused', honesty: 'VAT return not prepared — filing not connected', boxRows: [] };
  return {
    status: 'prepared',
    honesty: 'Prepared — filing not connected',
    period: period.periodKey || null,
    startsOn: period.startsOn || null,
    endsOn: period.endsOn || null,
    periodRange: `${period.startsOn} to ${period.endsOn}`,
    dueDate: period.dueOn || null,
    currency: 'GBP',
    boxRows: Array.from({ length: 9 }, (_, index) => ({
      box: String(index + 1),
      amount: Number(boxes[String(index + 1)]) || 0,
      display: gbp(boxes[String(index + 1)])
    })),
    outcome: vatReturn.outcome === 'repayment' ? 'repayment' : 'due',
    netVat: Number(vatReturn.netVat) || 0,
    outcomeLabel: vatReturn.outcome === 'repayment' ? `Repayment ${gbp(vatReturn.netVat)}` : `VAT due ${gbp(vatReturn.netVat)}`
  };
};
