// G-11 (FI-15) — the formal accounting-to-tax adjustment layer for the Finnish
// sole-trader annual return (elinkeinonharjoittajan veroilmoitus). Design:
// docs/design-donna-finland-fi15-g10-g14-p2-batch.md (D-P2-2/D-P2-3).
//
// The records are TRANSCRIBED human judgment (the G-5 ennakkovero pattern):
// the firm/owner records that a booked item's TAX treatment differs from its
// accounting treatment (edustuskulut 50 %, a fine, a private-use share, a
// depreciation difference), and THIS module applies the closed, deterministic
// rule for that type — arithmetic only, KEEP-layer, never a model judgment.
// Donna does not auto-detect adjustments (follow-up F-G11-1 would only ever
// PROPOSE a record; the record stays human-confirmed).
//
// Writes ride the validated profile-patch path only: clientProfileSchema.js
// routes `profile.tax_adjustments` through normalizeTaxAdjustmentsProfile —
// no new write route, no migration. Consumption is read-time in
// getFinlandAnnualReturnFromDb → buildAnnualReturnFromReadModel, per-item
// surfaced (render-the-persisted-verdict), absent ⇒ byte-identical return.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// EVL 8 § 1 mom 8 k: 50 % of edustusmenot (representation expenses) is
// deductible — the add-back is the other 50 % of the booked amount.
export const REPRESENTATION_DEDUCTIBLE_SHARE = 0.5;

// Statutory-rate provenance (the G-9/G-2 discipline applied to statutes):
// corroborated against unanimous secondary sources 2026-07-11; finlex.fi is
// proxy-blocked from this container class, so primary verification is
// F-P2-V on the F-FI8-R1 network-open checklist — flip this flag in the same
// commit as the primary read.
export const TAX_ADJUSTMENT_PROVENANCE = Object.freeze({
  statute: 'EVL 8 § 1 mom 8 k (edustusmenot 50 %); EVL 16 § (vähennyskelvottomat); EVL 30 § (menojäännöspoistot)',
  confirmedAgainstPrimary: false,
  corroboratedOn: '2026-07-11',
  source: 'Edustusmenot 50 % re-corroborated via search extraction 2026-07-11 (vero.fi syventävä ohje "Edustusmenot tuloverotuksessa" titles + Tilisanomat/eTasku); byte-level primary read pending (F-P2-V, network-open checklist)'
});

// The CLOSED adjustment vocabulary. `direction`:
//   add_back   — increases the taxable result vs the books
//   deduction  — decreases it
//   signed     — the recorded amount's sign decides (positive ⇒ add-back)
// `noteRequired` types carry judgment that must be stated, not implied.
export const TAX_ADJUSTMENT_TYPES = Object.freeze([
  {
    type: 'representation_expenses',
    direction: 'add_back',
    rate: 1 - REPRESENTATION_DEDUCTIBLE_SHARE,
    noteRequired: false,
    label_fi: 'Edustuskulut (50 % vähennyskelpoinen)',
    rule: 'add back 50% of the recorded representation expenses (EVL 8 § 1 mom 8 k)'
  },
  {
    type: 'non_deductible',
    direction: 'add_back',
    rate: 1,
    noteRequired: true,
    label_fi: 'Vähennyskelvoton erä',
    rule: 'add back 100% of the recorded amount (fines/sanctions, private-use share, other non-deductible)'
  },
  {
    type: 'additional_deduction',
    direction: 'deduction',
    rate: 1,
    noteRequired: true,
    label_fi: 'Verotuksessa vähennettävä lisäerä',
    rule: 'deduct 100% of the recorded amount (a tax-side deduction not in the books, e.g. työhuonevähennys)'
  },
  {
    type: 'depreciation_difference',
    direction: 'signed',
    rate: 1,
    noteRequired: true,
    label_fi: 'Poistoero (kirjanpito vs. EVL)',
    rule: 'signed: positive = book depreciation exceeds the EVL maximum (add back); negative = extra tax depreciation (deduct)'
  }
]);

const TYPES_BY_KEY = new Map(TAX_ADJUSTMENT_TYPES.map((t) => [t.type, t]));

export const TAX_ADJUSTMENT_TYPE_KEYS = Object.freeze(TAX_ADJUSTMENT_TYPES.map((t) => t.type));

const badRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const MAX_ADJUSTMENT_ITEMS = 200;
const MAX_ABS_AMOUNT = 10000000;

// normalizeTaxAdjustmentsProfile(value) — the validated write shape for
// profile.tax_adjustments (clientProfileSchema.js delegates here). A bounded
// list of { tax_year, type, amount_eur, note?, account_code? }; null clears.
// Throws statusCode-400 errors on a bad shape — a record that cannot apply
// deterministically REFUSES at the write, never rests silently ignored
// (two-terminal-states, applied to the record itself).
export const normalizeTaxAdjustmentsProfile = (value) => {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw badRequest('tax_adjustments must be an array or null.');
  }
  if (value.length > MAX_ADJUSTMENT_ITEMS) {
    throw badRequest(`tax_adjustments is limited to ${MAX_ADJUSTMENT_ITEMS} items.`);
  }
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest('Each tax adjustment must be an object.');
    }
    const spec = TYPES_BY_KEY.get(String(raw.type || '').trim());
    if (!spec) {
      throw badRequest(`Unknown tax adjustment type: ${JSON.stringify(raw.type)}. Known: ${TAX_ADJUSTMENT_TYPE_KEYS.join(', ')}.`);
    }
    const taxYear = Number(raw.tax_year);
    if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
      throw badRequest('Each tax adjustment needs a four-digit tax_year.');
    }
    const amount = Number(raw.amount_eur);
    if (!Number.isFinite(amount) || Math.abs(amount) > MAX_ABS_AMOUNT) {
      throw badRequest('Each tax adjustment needs a finite amount_eur.');
    }
    if (spec.direction !== 'signed' && amount < 0) {
      throw badRequest(`${spec.type} amount_eur must be non-negative (only depreciation_difference is signed).`);
    }
    const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 500) : null;
    if (spec.noteRequired && !note) {
      throw badRequest(`${spec.type} requires a note stating the judgment behind the record.`);
    }
    const item = { tax_year: taxYear, type: spec.type, amount_eur: round2(amount) };
    if (note) item.note = note;
    if (typeof raw.account_code === 'string' && raw.account_code.trim()) {
      item.account_code = raw.account_code.trim().slice(0, 12);
    }
    out.push(item);
  }
  return out.length ? out : null;
};

// evaluateTaxAdjustments({ items, taxYear }) → { items, totalAddBacks,
// totalDeductions } | null. Pure, deterministic: applies each type's closed
// rule to the records for THE tax year. Unknown/garbage items are dropped
// (the validator upstream refuses them at write time; read-time garbage in a
// legacy profile must not crash the return). Returns null when nothing
// applies — the annual return stays byte-identical.
export const evaluateTaxAdjustments = ({ items = [], taxYear } = {}) => {
  const year = Number(taxYear);
  if (!Number.isInteger(year)) return null;
  const applied = [];
  let totalAddBacks = 0;
  let totalDeductions = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (Number(raw.tax_year) !== year) continue;
    const spec = TYPES_BY_KEY.get(String(raw.type || '').trim());
    if (!spec) continue;
    const amount = Number(raw.amount_eur);
    if (!Number.isFinite(amount)) continue;

    let addBack = 0;
    let deduction = 0;
    if (spec.direction === 'add_back') addBack = round2(Math.abs(amount) * spec.rate);
    else if (spec.direction === 'deduction') deduction = round2(Math.abs(amount) * spec.rate);
    else if (amount >= 0) addBack = round2(amount * spec.rate);
    else deduction = round2(-amount * spec.rate);

    totalAddBacks = round2(totalAddBacks + addBack);
    totalDeductions = round2(totalDeductions + deduction);
    applied.push({
      tax_year: year,
      type: spec.type,
      label_fi: spec.label_fi,
      rule: spec.rule,
      amount_eur: round2(amount),
      note: typeof raw.note === 'string' && raw.note ? raw.note : null,
      account_code: typeof raw.account_code === 'string' && raw.account_code ? raw.account_code : null,
      add_back_eur: addBack,
      deduction_eur: deduction
    });
  }
  if (!applied.length) return null;
  return { items: applied, totalAddBacks, totalDeductions, provenance: TAX_ADJUSTMENT_PROVENANCE };
};
