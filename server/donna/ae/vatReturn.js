// AE VAT return preparation — the compute-half. Deterministic VAT201 field
// arithmetic over persisted ledger tax verdicts; no model, no EmaraTax
// transport, no persistence. The fourth member of the return-computation
// family (finland/alvReturn.js, gb/vatReturn.js — SG's sits in its transmit
// lane) and the first slice of the preparation-first bind scoped in
// docs/design-donna-ae-vat-return.md: Donna computes and re-foots the
// figures; the OWNER files in EmaraTax until a transmit channel slice lands.
//
// KEEP-layer: field arithmetic (tax = base × 5% per code over the period
// sums), the footing identities and the control-leg reconciliation are
// deterministic form rules, not model judgment. The engine reads the
// persisted `tax_type` verdicts the coder wrote (render-the-persisted-
// verdict) and REFUSES by name at every unestablished fact: an uncoded
// revenue/expense line, a missing establishment emirate while standard-rated
// supplies exist, a qualifying e-commerce registrant (destination-emirate
// reporting deliberately unsupported — refuse, never silently
// establishment-attribute), a control-leg mismatch.
//
// Field ids are SEMANTIC KEYS, not box numbers — see the provenance note in
// ./vatCodes.js before "fixing" that.

import {
  AE_EMIRATES,
  AE_VAT201_FIELD_PROVENANCE,
  AE_VAT_INPUT_ROLE,
  AE_VAT_OUTPUT_ROLE,
  isKnownAeEmirate,
  resolveAeVatCode
} from './vatCodes.js';

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const amount = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const aeVatRefusal = (code, message, statusCode = 422, details = undefined) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
};

const lineRef = (line) => ({
  journalId: line.journal_id ?? null,
  lineNo: line.line_no ?? null,
  accountCode: line.account_code ?? null,
  taxType: line.tax_type ?? null
});

// The three declared-zero fields the compute-half carries but never computes,
// each with its honesty note rendered to the owner alongside the figures.
const declaredZero = (note) => ({ amount: 0, vat: 0, declared_zero: true, note });
const TOURIST_REFUNDS_NOTE = 'Tax refunds provided to tourists apply only to registered retailers in the FTA tourist-refund scheme — outside the ICP; declared zero. Participation is flag-and-escalate, never computed.';
const GOODS_IMPORTS_NOTE = 'Goods imported via UAE customs auto-populate in EmaraTax from customs declarations; the book does not compute this field. VERIFY the portal figure against the book before filing.';
const GOODS_IMPORTS_ADJUSTMENTS_NOTE = 'Adjustments to customs-linked goods imports are portal-side entries; declared zero here.';

export const assertAeVatReturnFoots = (vatReturn = {}) => {
  const fields = vatReturn.fields || {};
  const sr = fields.standard_rated_supplies || {};
  const byEmirate = sr.by_emirate || {};
  const emirateAmount = round2(Object.values(byEmirate).reduce((sum, row) => sum + amount(row?.amount), 0));
  const emirateVat = round2(Object.values(byEmirate).reduce((sum, row) => sum + amount(row?.vat), 0));
  if (round2(sr.total?.amount) !== emirateAmount || round2(sr.total?.vat) !== emirateVat) {
    throw aeVatRefusal('AE_VAT_RETURN_MISFOOT_EMIRATES', 'Standard-rated totals must equal the sum of the per-emirate rows.');
  }
  const expectedOutput = round2(
    emirateVat
    + amount(fields.reverse_charge_supplies?.vat)
    + amount(fields.goods_imports?.vat)
    - amount(fields.tourist_refunds?.vat)
  );
  if (round2(vatReturn.totals?.output_vat) !== expectedOutput) {
    throw aeVatRefusal('AE_VAT_RETURN_MISFOOT_OUTPUT', `Total output VAT must foot to its components (${expectedOutput}).`);
  }
  const expectedRecoverable = round2(
    amount(fields.standard_rated_expenses?.recoverable_vat)
    + amount(fields.reverse_charge_expenses?.recoverable_vat)
  );
  if (round2(vatReturn.totals?.recoverable_vat) !== expectedRecoverable) {
    throw aeVatRefusal('AE_VAT_RETURN_MISFOOT_RECOVERABLE', `Total recoverable VAT must foot to its components (${expectedRecoverable}).`);
  }
  const expectedNet = round2(expectedOutput - expectedRecoverable);
  if (round2(vatReturn.netVat) !== expectedNet) {
    throw aeVatRefusal('AE_VAT_RETURN_MISFOOT_NET', `Net VAT must equal output minus recoverable (${expectedNet}).`);
  }
  const expectedOutcome = expectedNet < 0 ? 'refund' : 'payment';
  if (vatReturn.outcome !== expectedOutcome) {
    throw aeVatRefusal('AE_VAT_RETURN_MISFOOT_OUTCOME', `Outcome must follow the net sign (${expectedOutcome}).`);
  }
  return true;
};

// buildAeVatReturnFromLedgerLines({ period, lines, establishmentEmirate,
// qualifyingEcommerceRegistrant }) → { period, vatReturn, review }.
//
// `period` is the FTA-assigned tax period ({ periodKey, startsOn, endsOn,
// dueOn? }) — per-registrant DATA, never a pack constant; its persistence
// home is the next slice's design point (the MTD-shaped `vat_periods` table
// is deliberately not reused). `establishmentEmirate` is the client's
// fixed-establishment emirate (AUH/DXB/…), required only when standard-rated
// supplies exist. `qualifyingEcommerceRegistrant` true refuses outright.
export const buildAeVatReturnFromLedgerLines = ({
  period,
  lines = [],
  establishmentEmirate = null,
  qualifyingEcommerceRegistrant = null
} = {}) => {
  if (!period?.periodKey || !period?.startsOn || !period?.endsOn) {
    throw aeVatRefusal('AE_VAT_PERIOD_NOT_ESTABLISHED', 'A bounded FTA-assigned tax period is required.');
  }
  if (qualifyingEcommerceRegistrant === true) {
    throw aeVatRefusal(
      'AE_VAT_QUALIFYING_REGISTRANT_UNSUPPORTED',
      'Qualifying e-commerce registrants (supplies over AED 100M) must report standard-rated supplies by destination emirate — unsupported; the return must not silently attribute to the establishment.'
    );
  }
  const emirate = establishmentEmirate === null || establishmentEmirate === undefined
    ? null
    : String(establishmentEmirate).trim().toUpperCase();
  if (emirate !== null && !isKnownAeEmirate(emirate)) {
    throw aeVatRefusal('AE_VAT_EMIRATE_UNKNOWN', 'The recorded establishment emirate is not one of the seven emirates.', 422, { establishmentEmirate });
  }

  const totals = new Map();
  const unknown = [];
  const controlLegs = [];
  for (const line of lines) {
    const debit = amount(line.debit);
    const credit = amount(line.credit);
    if (debit === credit) continue;
    const role = String(line.role || '').trim();
    if (role === AE_VAT_OUTPUT_ROLE || role === AE_VAT_INPUT_ROLE) {
      controlLegs.push({
        role,
        signed: role === AE_VAT_OUTPUT_ROLE ? credit - debit : debit - credit
      });
      continue;
    }
    const taxType = String(line.tax_type || '').trim().toUpperCase();
    const accountType = String(line.account_type || '').toLowerCase();
    if (!taxType || taxType === 'NONE') {
      // Same completeness gate as GB: revenue, expense and fixed-asset lines
      // must carry a verdict; other asset movements (bank transfers) are
      // legitimately outside it.
      if (accountType === 'revenue' || accountType === 'expense' || accountType === 'fixed_asset') unknown.push(lineRef(line));
      continue;
    }
    const entry = resolveAeVatCode(taxType);
    if (!entry) {
      unknown.push(lineRef(line));
      continue;
    }
    if ((entry.direction === 'out' && accountType === 'expense')
      || (entry.direction === 'in' && accountType === 'revenue')) {
      throw aeVatRefusal('AE_VAT_TREATMENT_DIRECTION_MISMATCH', 'A VAT treatment conflicts with its ledger account direction.', 422, lineRef(line));
    }
    const net = entry.direction === 'out' ? credit - debit : debit - credit;
    totals.set(entry.code, round2((totals.get(entry.code) || 0) + net));
  }
  if (unknown.length) {
    throw aeVatRefusal('AE_VAT_TREATMENT_NOT_ESTABLISHED', 'Every revenue and purchase line requires a supported persisted VAT treatment.', 422, unknown);
  }

  const acc = {
    standard_rated_supplies: { amount: 0, vat: 0 },
    zero_rated_supplies: 0,
    exempt_supplies: 0,
    reverse_charge_supplies: { amount: 0, vat: 0 },
    standard_rated_expenses: { amount: 0, recoverable_vat: 0 },
    reverse_charge_expenses: { amount: 0, recoverable_vat: 0 }
  };
  let expectedDomesticOutput = 0;
  let expectedDomesticInput = 0;
  for (const [taxType, net] of totals) {
    const entry = resolveAeVatCode(taxType);
    const tax = round2(net * entry.rate / 100);
    if (entry.kind === 'standard') {
      if (entry.direction === 'out') expectedDomesticOutput = round2(expectedDomesticOutput + tax);
      else expectedDomesticInput = round2(expectedDomesticInput + tax);
    }
    const fields = entry.return_fields;
    if (fields.net === 'standard_rated_supplies') {
      acc.standard_rated_supplies.amount = round2(acc.standard_rated_supplies.amount + net);
      if (fields.tax) acc.standard_rated_supplies.vat = round2(acc.standard_rated_supplies.vat + tax);
    }
    if (fields.net === 'zero_rated_supplies') acc.zero_rated_supplies = round2(acc.zero_rated_supplies + net);
    if (fields.net === 'exempt_supplies') acc.exempt_supplies = round2(acc.exempt_supplies + net);
    if (fields.net === 'standard_rated_expenses') {
      acc.standard_rated_expenses.amount = round2(acc.standard_rated_expenses.amount + net);
      if (fields.tax) acc.standard_rated_expenses.recoverable_vat = round2(acc.standard_rated_expenses.recoverable_vat + tax);
    }
    if (fields.net === 'reverse_charge_supplies') {
      acc.reverse_charge_supplies.amount = round2(acc.reverse_charge_supplies.amount + net);
      if (fields.output_tax) acc.reverse_charge_supplies.vat = round2(acc.reverse_charge_supplies.vat + tax);
    }
    if (fields.input_net === 'reverse_charge_expenses') {
      acc.reverse_charge_expenses.amount = round2(acc.reverse_charge_expenses.amount + net);
      if (fields.input_tax) acc.reverse_charge_expenses.recoverable_vat = round2(acc.reverse_charge_expenses.recoverable_vat + tax);
    }
  }

  // The standard-rated split by emirate: the general attribution rule (fixed
  // establishment) collapses every supply onto the client's establishment
  // emirate. The fact is required exactly when the split has something to
  // split — a purely zero-rated/exempt/nil period must not block on it.
  const hasStandardRatedSupplies = acc.standard_rated_supplies.amount !== 0 || acc.standard_rated_supplies.vat !== 0;
  if (hasStandardRatedSupplies && emirate === null) {
    throw aeVatRefusal('AE_VAT_EMIRATE_NOT_ESTABLISHED', "Standard-rated supplies require the client's establishment emirate; record it (or the qualifying-registrant status) before preparing the return.");
  }
  const byEmirate = Object.fromEntries(Object.keys(AE_EMIRATES).map((key) => [key, { amount: 0, vat: 0 }]));
  if (hasStandardRatedSupplies) {
    byEmirate[emirate] = { amount: acc.standard_rated_supplies.amount, vat: acc.standard_rated_supplies.vat };
  }

  // The base-code walk and the role-marked control legs are independent
  // records of domestic VAT; reconcile their period totals so a pre-split
  // journal, a missing leg or a hand edit cannot silently alter the return.
  // Self-assessed reverse-charge VAT has no control leg in the posting
  // contract and is deliberately excluded, as in GB.
  const actualDomesticOutput = round2(controlLegs
    .filter((leg) => leg.role === AE_VAT_OUTPUT_ROLE)
    .reduce((sum, leg) => sum + leg.signed, 0));
  const actualDomesticInput = round2(controlLegs
    .filter((leg) => leg.role === AE_VAT_INPUT_ROLE)
    .reduce((sum, leg) => sum + leg.signed, 0));
  const controlTolerance = Math.max(0.02, round2(0.01 * controlLegs.length));
  if (Math.abs(round2(actualDomesticOutput - expectedDomesticOutput)) > controlTolerance
    || Math.abs(round2(actualDomesticInput - expectedDomesticInput)) > controlTolerance) {
    throw aeVatRefusal(
      'AE_VAT_CONTROL_ACCOUNT_MISMATCH',
      'Posted VAT control legs do not reconcile to the coded domestic VAT lines.',
      422,
      {
        outputTax: { expected: expectedDomesticOutput, actual: actualDomesticOutput },
        inputTax: { expected: expectedDomesticInput, actual: actualDomesticInput },
        tolerance: controlTolerance,
        legCount: controlLegs.length
      }
    );
  }

  const fields = {
    standard_rated_supplies: {
      by_emirate: byEmirate,
      total: { amount: acc.standard_rated_supplies.amount, vat: acc.standard_rated_supplies.vat }
    },
    tourist_refunds: declaredZero(TOURIST_REFUNDS_NOTE),
    reverse_charge_supplies: acc.reverse_charge_supplies,
    zero_rated_supplies: { amount: acc.zero_rated_supplies },
    exempt_supplies: { amount: acc.exempt_supplies },
    goods_imports: declaredZero(GOODS_IMPORTS_NOTE),
    goods_imports_adjustments: declaredZero(GOODS_IMPORTS_ADJUSTMENTS_NOTE),
    standard_rated_expenses: acc.standard_rated_expenses,
    reverse_charge_expenses: acc.reverse_charge_expenses
  };
  const outputVat = round2(
    fields.standard_rated_supplies.total.vat
    + fields.reverse_charge_supplies.vat
    + fields.goods_imports.vat
    - fields.tourist_refunds.vat
  );
  const recoverableVat = round2(
    fields.standard_rated_expenses.recoverable_vat
    + fields.reverse_charge_expenses.recoverable_vat
  );
  const netVat = round2(outputVat - recoverableVat);
  const vatReturn = {
    currency: 'AED',
    fields,
    totals: { output_vat: outputVat, recoverable_vat: recoverableVat },
    netVat,
    outcome: netVat < 0 ? 'refund' : 'payment',
    nilReturn: totals.size === 0,
    provenance: { ...AE_VAT201_FIELD_PROVENANCE }
  };
  assertAeVatReturnFoots(vatReturn);
  return { period, vatReturn, review: { status: 'ready', refusals: [] } };
};
