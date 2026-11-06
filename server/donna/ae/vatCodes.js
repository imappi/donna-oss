// AE VAT posting-code vocabulary — posting/return DATA + pure resolvers.
// Fourth instance of the convention `finland/alvCodes.js`, `singapore/
// gstCodes.js` and `gb/vatCodes.js` carry: per-treatment posting codes that
// ride a ledger line's `tax_type`, so the VAT201 return engine's base-code
// walk can see the supply rather than reconstructing a rate split from a
// posted journal. Scoped by docs/design-donna-ae-vat-return.md (the
// preparation-first bind); the compute-half consumer is `ae/vatReturn.js`.
//
// Three deliberate boundaries, same as GB's (read that header before
// extending either):
//
// 1. **Not the coder's vocabulary.** `taxVocabularies.js`
//    (`AE_VAT_TAX_TREATMENT_OPTIONS`: 'VAT 5% (standard rated)', …) holds the
//    model-facing TREATMENT labels. These are POSTING codes for a journal
//    line. Two vocabularies, deliberately separate.
// 2. **Preparation vocabulary, not a posting writer.** The return engine
//    consumes persisted `tax_type` verdicts; nothing here posts a journal or
//    guesses a treatment, and an unknown code is a named refusal.
// 3. **Not a control-account home.** The AE pack ships a FALLBACK chart, not
//    a statutory one, so like GB the control leg resolves from the client's
//    chart by the canonical role `liability.sales_tax_payable` (gap 10) —
//    only the line ROLE lives here.
//
// RETURN FIELDS ARE SEMANTIC KEYS, NOT BOX NUMBERS — a deliberate departure
// from GB's '1'..'9', recorded here so nobody "fixes" it: the secondaries
// corroborating form VAT201 agree on the sales-side structure (standard-rated
// by emirate, tourist refunds, reverse charge, zero-rated, exempt,
// customs-linked goods imports) but CONFLICT on the numeric labelling of the
// later boxes, and the FTA's VAT Returns User Guide is unreachable from this
// environment (tax.gov.ae egress-blocked). Numeric labels are display
// concerns to attach after the primary read; the engine keys on meaning.

export const AE_VAT_STANDARD_RATE = 5;

// Market-neutral line roles, the SAME strings GB uses on purpose: the role
// marks what the leg IS (an output-VAT control leg, a deductible-input
// control leg); the jurisdiction comes from the client, never from the
// string. A per-market role alias would be vocabulary for its own sake.
export const AE_VAT_OUTPUT_ROLE = 'vat_output';
export const AE_VAT_INPUT_ROLE = 'vat_input_deductible';

export const AE_VAT_RATE_PROVENANCE = Object.freeze({
  authority: 'Federal Tax Authority',
  source: 'Federal Decree-Law No. 8 of 2017 on Value Added Tax, Article 3 — a single standard rate of 5% since 2018-01-01, with zero-rating (Article 45) and exemptions (Article 46); input-tax recovery restrictions per Article 53 of the Executive Regulation (Cabinet Decision No. 52 of 2017)',
  as_of: '2026-08-30',
  confirmedAgainstPrimary: false,
  note: 'Training-corpus + multi-secondary confirmation 2026-08-30; tax.gov.ae is blocked by the session egress proxy (the same boundary as the AED 375k threshold watch). A pin test trips CI on any silent rate edit either way.'
});

export const AE_VAT201_FIELD_PROVENANCE = Object.freeze({
  authority: 'Federal Tax Authority',
  source: "Form VAT201 and the FTA VAT Returns User Guide — standard-rated supplies reported per emirate, tourist refunds, reverse-charge supplies, zero-rated and exempt supplies, customs-linked goods imports, standard-rated expenses and reverse-charge recoveries",
  as_of: '2026-08-30',
  confirmedAgainstPrimary: false,
  note: 'Secondaries agree on the field STRUCTURE but conflict on numeric box labels past the sales section, so the engine keys on semantic field ids and carries no box numbers; attach numeric labels only after a primary read of the VAT Returns User Guide. Two named nuances also awaiting primary confirmation: (1) zero-rated/exempt/outside-scope PURCHASES are understood not to be reported on VAT201 (no total-purchases box, unlike the UK Box 7); (2) blocked input VAT (Art. 53 ER) is never recoverable and its net is likewise unreported.'
});

// The seven emirates, keyed for the standard-rated-supplies split. The
// attribution rule the compute-half applies is the GENERAL one — the fixed
// establishment most closely related to the supply — which for the
// single-establishment ICP collapses to one profile fact. The
// destination-emirate rule for qualifying e-commerce registrants (supplies
// over AED 100M/year, VATP033, in force 2023-07-01) is deliberately
// UNSUPPORTED: the engine refuses rather than silently
// establishment-attributes (docs/design-donna-ae-freezone-and-wafeq.md §1).
export const AE_EMIRATES = Object.freeze({
  AUH: 'Abu Dhabi',
  DXB: 'Dubai',
  SHJ: 'Sharjah',
  AJM: 'Ajman',
  UAQ: 'Umm Al Quwain',
  RAK: 'Ras Al Khaimah',
  FUJ: 'Fujairah'
});

export const isKnownAeEmirate = (value) =>
  Object.prototype.hasOwnProperty.call(AE_EMIRATES, String(value || '').trim().toUpperCase());

// Entry shape (the GB shape with semantic return fields):
//   { code, label_en, rate, direction, kind, return_fields }
// return_fields keys the compute walk understands:
//   net        — the base amount lands in this sales/expense field
//   tax        — the code's own-rate VAT lands in the same-named field
//   output_tax — self-assessed output VAT (reverse charge, sales side)
//   input_net / input_tax — the recovery side of a reverse-charge purchase
const code = (code, label_en, rate, direction, kind, fields) => Object.freeze({
  code, label_en, rate, direction, kind, return_fields: Object.freeze(fields)
});

export const AE_VAT_CODES = Object.freeze([
  code('AE_VAT_SR_5_OUTPUT', 'Standard-rated supply 5%', 5, 'out', 'standard', { net: 'standard_rated_supplies', tax: 'standard_rated_supplies' }),
  code('AE_VAT_ZR_OUTPUT', 'Zero-rated supply 0%', 0, 'out', 'zero', { net: 'zero_rated_supplies' }),
  code('AE_VAT_EXEMPT_OUTPUT', 'Exempt supply', 0, 'out', 'exempt', { net: 'exempt_supplies' }),
  code('AE_VAT_OUTSIDE_SCOPE_OUTPUT', 'Outside-scope receipt', 0, 'out', 'outside_scope', {}),
  code('AE_VAT_SR_5_INPUT', 'Standard-rated expense 5%', 5, 'in', 'standard', { net: 'standard_rated_expenses', tax: 'standard_rated_expenses' }),
  // Zero-rated / exempt / outside-scope purchases carry no recoverable VAT
  // and — per the provenance note above — no VAT201 field at all; the codes
  // exist so a coded purchase is distinguishable from an UNCODED line, which
  // is a named refusal in the return engine.
  code('AE_VAT_ZR_INPUT', 'Zero-rated purchase 0%', 0, 'in', 'zero', {}),
  code('AE_VAT_EXEMPT_INPUT', 'Exempt purchase', 0, 'in', 'exempt', {}),
  code('AE_VAT_OUTSIDE_SCOPE_INPUT', 'Outside-scope payment', 0, 'in', 'outside_scope', {}),
  // Blocked input VAT (Article 53 ER: entertainment, certain motor vehicles):
  // the VAT is real but never recoverable, so there is no recovery entry and
  // no control leg — the irrecoverable VAT stays in the expense. rate 5 is
  // documentation of the blocked VAT's rate, deliberately NOT consulted by
  // the return engine (kind 'blocked' is not 'standard').
  code('AE_VAT_BLOCKED_INPUT', 'Blocked purchase (no recovery)', 5, 'in', 'blocked', {}),
  // Reverse charge (imported services and RCM goods): the supply value and
  // self-assessed output VAT report on the sales side; the recovery (subject
  // to normal recoverability) on the expense side. No control leg — the
  // self-assessment has no posted split in the current contract, same as GB.
  code('AE_VAT_RCM_5_INPUT', 'Reverse-charge purchase 5%', 5, 'in', 'reverse_charge', { net: 'reverse_charge_supplies', output_tax: 'reverse_charge_supplies', input_net: 'reverse_charge_expenses', input_tax: 'reverse_charge_expenses' })
]);

const BY_CODE = new Map(AE_VAT_CODES.map((entry) => [entry.code, entry]));
export const resolveAeVatCode = (value) => BY_CODE.get(String(value || '').trim().toUpperCase()) || null;

// aeVatOutputCodeForRate(rate) — the domestic OUTPUT (supply) code for a rate,
// or null. Pure data lookup, the exact twin of alvOutputCodeForRate /
// gstOutputCodeForRate / gbVatOutputCodeForRate: a future AE AR-posting split
// consumes it to code per-rate revenue legs, and an unmapped rate makes the
// caller REFUSE (typed) rather than guess. Rate 0 resolves to the zero-rated
// code — exempt/outside-scope are treatment decisions, never rate lookups.
export const aeVatOutputCodeForRate = (rate) => {
  // A missing rate must NOT coerce to 0 and silently zero-rate the supply —
  // only an explicit numeric rate resolves.
  if (rate === null || rate === undefined || String(rate).trim() === '') return null;
  const numeric = Number(rate);
  if (!Number.isFinite(numeric)) return null;
  if (numeric === AE_VAT_STANDARD_RATE) return 'AE_VAT_SR_5_OUTPUT';
  if (numeric === 0) return 'AE_VAT_ZR_OUTPUT';
  return null;
};
