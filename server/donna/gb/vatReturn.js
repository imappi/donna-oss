// GB VAT return preparation. Deterministic nine-box arithmetic over persisted
// ledger tax verdicts; no model and no HMRC transport.

import { GB_VAT_BOX_PROVENANCE, resolveGbVatCode } from './vatCodes.js';
import { toIsoDay } from '../dates.js';

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const amount = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const gbVatRefusal = (code, message, statusCode = 422, details = undefined) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
};

export const resolveGbVatPeriod = ({ periods = [], periodKey, asOf } = {}) => {
  const candidates = periods.filter((period) => {
    if (periodKey !== undefined) return period.period_key === periodKey || period.periodKey === periodKey;
    return asOf && String(period.start_date || period.startDate) <= asOf
      && String(period.end_date || period.endDate) >= asOf;
  });
  if (candidates.length === 0) {
    throw gbVatRefusal('GB_VAT_PERIOD_NOT_ESTABLISHED', 'No persisted HMRC VAT period matches the request.');
  }
  if (candidates.length !== 1) {
    throw gbVatRefusal('GB_VAT_PERIOD_NOT_UNIQUE', 'More than one persisted HMRC VAT period matches the request.');
  }
  const row = candidates[0];
  for (const field of ['period_key', 'start_date', 'end_date', 'due_date']) {
    const camel = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!row[field] && !row[camel]) {
      throw gbVatRefusal('GB_VAT_PERIOD_INCOMPLETE', `Persisted VAT period is missing ${field}.`);
    }
  }
  return {
    id: row.id,
    periodKey: row.period_key ?? row.periodKey,
    // date columns arrive as Date objects from pg — String(Date) is not an ISO day.
    startsOn: toIsoDay(row.start_date ?? row.startDate),
    endsOn: toIsoDay(row.end_date ?? row.endDate),
    dueOn: toIsoDay(row.due_date ?? row.dueDate),
    status: row.status
  };
};

const lineRef = (line) => ({
  journalId: line.journal_id ?? null,
  lineNo: line.line_no ?? null,
  accountCode: line.account_code ?? null,
  taxType: line.tax_type ?? null
});

export const assertGbVatReturnFoots = (vatReturn = {}) => {
  const box = vatReturn.boxes || {};
  const expected3 = round2(amount(box['1']) + amount(box['2']));
  const expected5 = round2(Math.abs(expected3 - amount(box['4'])));
  if (round2(box['3']) !== expected3) {
    throw gbVatRefusal('GB_VAT_RETURN_MISFOOT_BOX_3', `VAT Box 3 must equal Box 1 + Box 2 (${expected3}).`);
  }
  if (round2(box['5']) !== expected5) {
    throw gbVatRefusal('GB_VAT_RETURN_MISFOOT_BOX_5', `VAT Box 5 must equal |Box 3 - Box 4| (${expected5}).`);
  }
  return true;
};

export const buildGbVatReturnFromLedgerLines = ({ period, lines = [] } = {}) => {
  if (!period?.periodKey || !period?.startsOn || !period?.endsOn) {
    throw gbVatRefusal('GB_VAT_PERIOD_NOT_ESTABLISHED', 'A persisted, bounded HMRC VAT period is required.');
  }
  const totals = new Map();
  const unknown = [];
  const controlLegs = [];
  for (const line of lines) {
    const debit = amount(line.debit);
    const credit = amount(line.credit);
    if (debit === credit) continue;
    const role = String(line.role || '').trim();
    if (role === 'vat_output' || role === 'vat_input_deductible') {
      controlLegs.push({
        role,
        signed: role === 'vat_output' ? credit - debit : debit - credit
      });
      continue;
    }
    const taxType = String(line.tax_type || '').trim().toUpperCase();
    const accountType = String(line.account_type || '').toLowerCase();
    if (!taxType || taxType === 'NONE') {
      // Purchases of fixed assets can carry deductible input VAT just like
      // ordinary expenses.  Other asset movements (for example transfers
      // between bank accounts) remain legitimately outside this completeness
      // gate: their account type alone does not make them VATable.
      if (accountType === 'revenue' || accountType === 'expense' || accountType === 'fixed_asset') unknown.push(lineRef(line));
      continue;
    }
    const entry = resolveGbVatCode(taxType);
    if (!entry) {
      unknown.push(lineRef(line));
      continue;
    }
    if ((entry.direction === 'out' && accountType === 'expense')
      || (entry.direction === 'in' && accountType === 'revenue')) {
      throw gbVatRefusal('GB_VAT_TREATMENT_DIRECTION_MISMATCH', 'A VAT treatment conflicts with its ledger account direction.', 422, lineRef(line));
    }
    const net = entry.direction === 'out' ? credit - debit : debit - credit;
    totals.set(entry.code, round2((totals.get(entry.code) || 0) + net));
  }
  if (unknown.length) {
    throw gbVatRefusal('GB_VAT_TREATMENT_NOT_ESTABLISHED', 'Every revenue and purchase line requires a supported persisted VAT treatment.', 422, unknown);
  }

  const boxes = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), 0]));
  let expectedDomesticOutput = 0;
  let expectedDomesticInput = 0;
  for (const [taxType, net] of totals) {
    const entry = resolveGbVatCode(taxType);
    const tax = round2(net * entry.rate / 100);
    if (entry.kind === 'standard' || entry.kind === 'reduced') {
      if (entry.direction === 'out') expectedDomesticOutput = round2(expectedDomesticOutput + tax);
      else expectedDomesticInput = round2(expectedDomesticInput + tax);
    }
    const map = entry.return_boxes;
    if (map.net) boxes[map.net] = round2(boxes[map.net] + net);
    if (map.tax) boxes[map.tax] = round2(boxes[map.tax] + tax);
    if (map.output_tax) boxes[map.output_tax] = round2(boxes[map.output_tax] + tax);
    if (map.input_tax) boxes[map.input_tax] = round2(boxes[map.input_tax] + tax);
    if (map.eu_net) boxes[map.eu_net] = round2(boxes[map.eu_net] + net);
    if (map.acquisition_net) boxes[map.acquisition_net] = round2(boxes[map.acquisition_net] + net);
    if (map.acquisition_tax) boxes[map.acquisition_tax] = round2(boxes[map.acquisition_tax] + tax);
  }
  boxes['3'] = round2(boxes['1'] + boxes['2']);

  // The base-code walk and the role-marked control legs are independent
  // records of domestic VAT.  Compare their period totals so a pre-split
  // journal, a missing leg, or a hand edit cannot silently alter the return.
  // Self-assessed reverse-charge/EU acquisition VAT has no control leg in the
  // current posting contract and is deliberately excluded from this check.
  const actualDomesticOutput = round2(controlLegs
    .filter((leg) => leg.role === 'vat_output')
    .reduce((sum, leg) => sum + leg.signed, 0));
  const actualDomesticInput = round2(controlLegs
    .filter((leg) => leg.role === 'vat_input_deductible')
    .reduce((sum, leg) => sum + leg.signed, 0));
  const controlTolerance = Math.max(0.02, round2(0.01 * controlLegs.length));
  if (Math.abs(round2(actualDomesticOutput - expectedDomesticOutput)) > controlTolerance
    || Math.abs(round2(actualDomesticInput - expectedDomesticInput)) > controlTolerance) {
    throw gbVatRefusal(
      'GB_VAT_CONTROL_ACCOUNT_MISMATCH',
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
  const signedNetVat = round2(boxes['3'] - boxes['4']);
  boxes['5'] = round2(Math.abs(signedNetVat));
  const vatReturn = {
    boxes,
    netVat: signedNetVat,
    outcome: signedNetVat < 0 ? 'repayment' : 'payment',
    nilReturn: totals.size === 0,
    provenance: { ...GB_VAT_BOX_PROVENANCE }
  };
  assertGbVatReturnFoots(vatReturn);
  return { period, vatReturn, review: { status: 'ready', refusals: [] } };
};
