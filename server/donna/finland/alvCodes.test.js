import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALV_CODES,
  ALV_RETURN_BOXES,
  ALV_RETURN_BOX_PROVENANCE,
  ALV_TAX_FIELDS_IN_308,
  FI_ALV_RATES_BY_ERA,
  FI_ALV_TAX_TREATMENT_OPTIONS,
  KNOWN_ALV_CODES,
  FI_STANDARD_RATE,
  fiAlvRateSetForDate,
  alvDirectionForTransaction,
  applyAlvCodingToCoding,
  resolveAlvCode,
  resolveAlvEntry,
  FINLAND_ALV_SETTLEMENT_ACCOUNT,
  resolveAlvSplitForPosting,
  splitAlvGross,
  withFinlandAlvSettlementAccount,
  alvOutputCodeForRate
} from './alvCodes.js';

test('every ALV code is unique', () => {
  const codes = ALV_CODES.map((e) => e.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate ALV code(s)');
});

test('every ALV code has a numeric rate, a valid direction, a kind, and both labels', () => {
  for (const e of ALV_CODES) {
    // 'blocked' (non-deductible) claims no rate by design — null, never 0.
    if (e.kind === 'blocked') assert.equal(e.rate, null, `${e.code} blocked rate must be null`);
    else assert.equal(typeof e.rate, 'number', `${e.code} rate not numeric`);
    assert.ok(['in', 'out', 'both'].includes(e.direction), `${e.code} direction ${e.direction} invalid`);
    assert.ok(e.kind && e.kind.trim().length > 0, `${e.code} missing kind`);
    assert.ok(e.label_fi && e.label_en, `${e.code} missing bilingual label`);
  }
});

test('the 2024 standard rate is 25.5% (not 24%), and is present in the vocabulary', () => {
  assert.equal(FI_STANDARD_RATE, 25.5);
  const std = ALV_CODES.filter((e) => e.kind === 'standard');
  assert.ok(std.length >= 2, 'expected output+input standard codes');
  for (const e of std) assert.equal(e.rate, 25.5, `${e.code} standard rate should be 25.5`);
});

test('the reduced rates 13.5%, 14%, and 10% are all present (G-1: both reduced-1 eras codeable)', () => {
  const rates = new Set(ALV_CODES.filter((e) => e.kind === 'reduced').map((e) => e.rate));
  assert.ok(rates.has(13.5), 'missing 13.5% reduced rate');
  assert.ok(rates.has(14), 'missing 14% reduced rate');
  assert.ok(rates.has(10), 'missing 10% reduced rate');
});

// ── FI-15 G-1 — the date-effective rate table ────────────────────────────────
// docs/design-donna-finland-g1-alv-rate-table.md. The FI-11 rate-pin pattern:
// a silent edit to a statutory rate must trip CI; update ONLY with provenance
// in the same commit.

test('G-1 pin: the rate eras are 2024-09-01 (25.5/14/10) and 2026-01-01 (25.5/13.5/10)', () => {
  assert.deepEqual(Object.keys(FI_ALV_RATES_BY_ERA).sort(), ['2024-09-01', '2026-01-01']);
  assert.equal(FI_ALV_RATES_BY_ERA['2024-09-01'].standard, 25.5);
  assert.deepEqual([...FI_ALV_RATES_BY_ERA['2024-09-01'].reduced], [14, 10]);
  assert.equal(FI_ALV_RATES_BY_ERA['2026-01-01'].standard, 25.5);
  assert.deepEqual([...FI_ALV_RATES_BY_ERA['2026-01-01'].reduced], [13.5, 10]);
  // Honest provenance: search-extraction grade; flipping to true requires the
  // F-G1-V byte-level primary confirmation in the same commit.
  for (const era of Object.values(FI_ALV_RATES_BY_ERA)) {
    assert.equal(era.confirmedAgainstPrimary, false);
    assert.ok(era.source && era.source.length > 0);
  }
});

test('G-1: fiAlvRateSetForDate resolves the era by date; the boundary is exact', () => {
  assert.equal(fiAlvRateSetForDate('2025-12-31').era, '2024-09-01');
  assert.deepEqual([...fiAlvRateSetForDate('2025-12-31').reduced], [14, 10]);
  assert.equal(fiAlvRateSetForDate('2026-01-01').era, '2026-01-01');
  assert.deepEqual([...fiAlvRateSetForDate('2026-07-11').reduced], [13.5, 10]);
  assert.equal(fiAlvRateSetForDate('2026-07-11').exact, true);
  // Timestamps resolve by their date part.
  assert.equal(fiAlvRateSetForDate('2026-01-01T09:30:00Z').era, '2026-01-01');
  // Before the first era: the first era, flagged inexact (24% is out of vocabulary).
  const early = fiAlvRateSetForDate('2024-06-30');
  assert.equal(early.era, '2024-09-01');
  assert.equal(early.exact, false);
  // Invalid/absent dates: current law, flagged inexact.
  for (const bad of [null, undefined, '', 'not-a-date']) {
    const set = fiAlvRateSetForDate(bad);
    assert.equal(set.era, '2026-01-01', String(bad));
    assert.equal(set.exact, false, String(bad));
  }
});

test('resolveAlvEntry returns the descriptor for a known code, null otherwise', () => {
  const entry = resolveAlvEntry('ALV_25_5_OUTPUT');
  assert.equal(entry.rate, 25.5);
  assert.equal(entry.direction, 'out');
  assert.equal(resolveAlvEntry('alv_25_5_output').code, 'ALV_25_5_OUTPUT'); // case-insensitive
  assert.equal(resolveAlvEntry('NOT_A_CODE'), null);
  assert.equal(resolveAlvEntry(null), null);
});

test('resolveAlvCode honours an explicit known code verbatim', () => {
  assert.equal(resolveAlvCode({ taxType: 'ALV_14_INPUT' }), 'ALV_14_INPUT');
  assert.equal(resolveAlvCode({ taxType: 'alv_14_input' }), 'ALV_14_INPUT');
  assert.ok(KNOWN_ALV_CODES.has('ALV_14_INPUT'));
});

test('resolveAlvCode maps reverse-charge prose (FI + EN), direction-sensitive', () => {
  assert.equal(resolveAlvCode({ taxTreatment: 'rakennusalan käännetty verovelvollisuus', direction: 'out' }), 'ALV_REVERSE_CHARGE_SALES');
  assert.equal(resolveAlvCode({ taxTreatment: 'reverse charge', direction: 'purchase' }), 'ALV_REVERSE_CHARGE_PURCHASE');
  // Unknown direction defaults to the self-assessed (material) purchase side.
  assert.equal(resolveAlvCode({ taxTreatment: 'käännetty verovelvollisuus' }), 'ALV_REVERSE_CHARGE_PURCHASE');
});

test('resolveAlvCode maps EU intra-community supply vs acquisition', () => {
  assert.equal(resolveAlvCode({ taxTreatment: 'tavaran yhteisömyynti', direction: 'sale' }), 'ALV_EU_SUPPLY');
  assert.equal(resolveAlvCode({ taxTreatment: 'intra-community acquisition', direction: 'purchase' }), 'ALV_EU_ACQUISITION');
  assert.equal(resolveAlvCode({ taxTreatment: 'yhteisöhankinta' }), 'ALV_EU_ACQUISITION');
});

test('resolveAlvCode maps zero-rated, exempt, and out-of-scope prose', () => {
  assert.equal(resolveAlvCode({ taxTreatment: 'veroton myynti / vienti' }), 'ALV_0_OUTPUT');
  assert.equal(resolveAlvCode({ taxTreatment: 'exempt activity' }), 'ALV_EXEMPT');
  assert.equal(resolveAlvCode({ taxTreatment: 'out of scope' }), 'ALV_OUT_OF_SCOPE');
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV:n soveltamisalan ulkopuolella' }), 'ALV_OUT_OF_SCOPE');
});

test('resolveAlvCode returns empty for standard/taxable/unknown so the caller falls back', () => {
  assert.equal(resolveAlvCode({ taxTreatment: 'standard rated' }), '');
  assert.equal(resolveAlvCode({ taxTreatment: 'taxable' }), '');
  assert.equal(resolveAlvCode({ taxTreatment: '' }), '');
  assert.equal(resolveAlvCode({}), '');
  assert.equal(resolveAlvCode({ taxType: 'SOME_UNKNOWN_CODE' }), '');
});

// --- FI-3 return-box vocabulary ---

test('FI-3 pin: the return-box map matches the VSRALVKV field set exactly', () => {
  // A silent edit to a statutory field number/label must trip CI (the FI-11
  // rate-pin pattern). Update ONLY with provenance in the same commit.
  assert.deepEqual(Object.keys(ALV_RETURN_BOXES).sort(), [
    '301', '302', '303', '304', '305', '306', '307', '308', '309', '310',
    '311', '312', '313', '314', '318', '319', '320'
  ]);
  assert.deepEqual(ALV_TAX_FIELDS_IN_308, ['301', '302', '303', '304', '305', '306', '318']);
  assert.equal(ALV_RETURN_BOXES['308'].role, 'net');
  assert.equal(ALV_RETURN_BOXES['307'].role, 'deductible');
  assert.equal(ALV_RETURN_BOXES['301'].label_fi.includes('25,5'), true);
  // Honest provenance: primary fetch was blocked; flipping this to true requires
  // the F-FI3-1 re-confirmation (design doc) in the same commit.
  assert.equal(ALV_RETURN_BOX_PROVENANCE.confirmedAgainstPrimary, false);
});

test('FI-3 every code return_boxes references only real fields, matching roles', () => {
  for (const e of ALV_CODES) {
    assert.notEqual(e.return_boxes, undefined, `${e.code} missing return_boxes`);
    if (e.return_boxes === null) continue; // exempt / out-of-scope: not reported
    for (const [role, field] of Object.entries(e.return_boxes)) {
      const box = ALV_RETURN_BOXES[field];
      assert.ok(box, `${e.code} references unknown field ${field}`);
      if (role === 'tax') assert.equal(box.role, 'tax', `${e.code} tax field ${field} has role ${box.role}`);
      if (role === 'deductible') assert.equal(field, '307', `${e.code} deductible must be 307`);
      if (role === 'base') assert.equal(box.role, 'base', `${e.code} base field ${field} has role ${box.role}`);
    }
    // Self-assessed codes (input-direction with a tax box) must also deduct.
    if (e.direction === 'in' && e.return_boxes.tax) {
      assert.equal(e.return_boxes.deductible, '307', `${e.code} self-assessed without deduction`);
    }
  }
});

test('FI-3 resolveAlvCode maps EU services and imports to the new codes', () => {
  assert.equal(resolveAlvCode({ taxTreatment: 'palvelun myynti muihin EU-maihin' }), 'ALV_EU_SERVICE_SUPPLY');
  assert.equal(resolveAlvCode({ taxTreatment: 'intra-EU service purchase' }), 'ALV_EU_SERVICE_ACQUISITION');
  assert.equal(resolveAlvCode({ taxTreatment: 'palveluosto muista EU-maista (käännetty)' }), 'ALV_EU_SERVICE_ACQUISITION');
  assert.equal(resolveAlvCode({ taxTreatment: 'tavaran maahantuonti EU:n ulkopuolelta' }), 'ALV_IMPORT');
  assert.equal(resolveAlvCode({ taxTreatment: 'import of goods' }), 'ALV_IMPORT');
});

test('FI-3 EU prose with "käännetty" routes to the EU codes, not domestic reverse charge', () => {
  // FI-2's own label 'Tavaran yhteisöhankinta (käännetty)' says käännetty; the
  // EU markers are the more specific signal and must win.
  assert.equal(resolveAlvCode({ taxTreatment: 'tavaran yhteisöhankinta (käännetty)' }), 'ALV_EU_ACQUISITION');
  // Plain domestic reverse charge still routes as before.
  assert.equal(resolveAlvCode({ taxTreatment: 'rakennusalan käännetty verovelvollisuus', direction: 'out' }), 'ALV_REVERSE_CHARGE_SALES');
});

// --- FI-3 slice W — coder wiring ---

test('W: rate-carrying prose resolves direction-sensitively; unknown direction never guesses', () => {
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 25,5 %', direction: 'out' }), 'ALV_25_5_OUTPUT');
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 25.5%', direction: 'in' }), 'ALV_25_5_INPUT');
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 14 %', direction: 'myynti' }), 'ALV_14_OUTPUT');
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 10 %', direction: 'osto' }), 'ALV_10_INPUT');
  // G-1: the 2026 reduced-1 rate, comma and dot decimals.
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 13,5 %', direction: 'myynti' }), 'ALV_13_5_OUTPUT');
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 13.5%', direction: 'in' }), 'ALV_13_5_INPUT');
  // No direction → no code (which side of the return a rate lands on is not guessable).
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 14 %' }), '');
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 13,5 %' }), '');
});

test('W: every FI coder vocabulary option resolves as designed (or deliberately stays uncoded)', () => {
  const dir = 'out';
  const expectations = {
    'ALV 25,5 %': 'ALV_25_5_OUTPUT',
    'ALV 13,5 %': 'ALV_13_5_OUTPUT',
    'ALV 14 %': 'ALV_14_OUTPUT',
    'ALV 10 %': 'ALV_10_OUTPUT',
    'ALV 0 % / vienti': 'ALV_0_OUTPUT',
    'Veroton toiminta (ALV-vapaa)': 'ALV_EXEMPT',
    'EU-tavaramyynti': 'ALV_EU_SUPPLY',
    'EU-palvelumyynti': 'ALV_EU_SERVICE_SUPPLY',
    'EU-tavaraosto': 'ALV_EU_ACQUISITION',
    'EU-palveluosto': 'ALV_EU_SERVICE_ACQUISITION',
    'Maahantuonti EU:n ulkopuolelta': 'ALV_IMPORT',
    'Rakennusalan käännetty ALV': 'ALV_REVERSE_CHARGE_SALES',
    // Purchase-only: a sale has no input deduction to deny, so no code.
    'Vähennyskelvoton ALV (osto)': '',
    'Ei ALV-käsittelyä': 'ALV_OUT_OF_SCOPE',
    // The unsure marker: NO code → the line posts uncoded → D-FI3-A4 blocker.
    'ALV-tarkistus': ''
  };
  assert.deepEqual(Object.keys(expectations), FI_ALV_TAX_TREATMENT_OPTIONS);
  for (const [treatment, expected] of Object.entries(expectations)) {
    assert.equal(resolveAlvCode({ taxTreatment: treatment, direction: dir }), expected, treatment);
  }
  // Purchase-direction spot checks for the direction-sensitive labels.
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 25,5 %', direction: 'in' }), 'ALV_25_5_INPUT');
  assert.equal(resolveAlvCode({ taxTreatment: 'Rakennusalan käännetty ALV', direction: 'in' }), 'ALV_REVERSE_CHARGE_PURCHASE');
  assert.equal(resolveAlvCode({ taxTreatment: 'Vähennyskelvoton ALV (osto)', direction: 'in' }), 'ALV_NONDEDUCTIBLE_INPUT');
});

// --- FIK-V — non-deductible input VAT (docs/plan-2026-09-22-fi-jev-decision-knowledge.md §8) ---

test('FIK-V: the non-deductible code is input-only, unreported, unsplit, and not out of scope', () => {
  const entry = resolveAlvEntry('ALV_NONDEDUCTIBLE_INPUT');
  assert.deepEqual({ ...entry }, { code: 'ALV_NONDEDUCTIBLE_INPUT', label_fi: 'Osto, vähennyskelvoton arvonlisävero',
    label_en: 'Purchase, non-deductible VAT (no deduction)', rate: null, direction: 'in', kind: 'blocked', return_boxes: null });
  assert.notEqual(entry.code, 'ALV_OUT_OF_SCOPE');
  assert.equal(splitAlvGross({ gross: 125.5, code: 'ALV_NONDEDUCTIBLE_INPUT' }), null);
  assert.equal(resolveAlvSplitForPosting({ coding: { tax_type: 'ALV_NONDEDUCTIBLE_INPUT', account_type: 'expense' }, transaction: { money_out: 125.5 } }), null);
  assert.equal(alvOutputCodeForRate(25.5), 'ALV_25_5_OUTPUT', 'the output-rate lookup never lands on it');
});

test('FIK-V: the resolver maps every non-deductible spelling on the purchase side only', () => {
  for (const prose of ['Vähennyskelvoton ALV (osto)', 'Osto, vähennyskelvoton arvonlisävero', 'ALV 25,5 %, ei vähennyskelpoinen', 'non-deductible VAT', 'blocked input']) {
    assert.equal(resolveAlvCode({ taxTreatment: prose, direction: 'in' }), 'ALV_NONDEDUCTIBLE_INPUT', prose);
    assert.equal(resolveAlvCode({ taxTreatment: prose, direction: 'out' }), '', `${prose} on a sale`);
    assert.equal(resolveAlvCode({ taxTreatment: prose }), '', `${prose} with no direction`);
  }
  // The marker beats a rate the prose also names: the rate is not claimed.
  assert.equal(resolveAlvCode({ taxTreatment: 'ALV 14 % vähennyskelvoton', direction: 'in' }), 'ALV_NONDEDUCTIBLE_INPUT');
  // An explicit code is honoured verbatim, like every other FI code.
  assert.equal(resolveAlvCode({ taxType: 'alv_nondeductible_input' }), 'ALV_NONDEDUCTIBLE_INPUT');
});

test('FIK-V: a restricted deduction on a self-assessed purchase resolves to nothing, never drops its output tax', () => {
  for (const prose of ['EU-tavaraosto, vähennyskelvoton', 'EU-palveluosto ei vähennyskelpoinen', 'non-deductible import VAT',
    'Maahantuonti EU:n ulkopuolelta (vähennyskelvoton)', 'Rakennusalan käännetty ALV, vähennyskelvoton', 'reverse charge, not deductible']) {
    assert.equal(resolveAlvCode({ taxTreatment: prose, direction: 'in' }), '', prose);
  }
});

test('FIK-V: applyAlvCodingToCoding stamps the code and its label; the settlement account still wins', () => {
  const applied = applyAlvCodingToCoding({ coding: { proposed_account: 'Meals and entertainment', account_type: 'expense', tax_treatment: 'Vähennyskelvoton ALV (osto)' }, transaction: { money_out: 125.5 } });
  assert.equal(applied.tax_type, 'ALV_NONDEDUCTIBLE_INPUT');
  assert.equal(applied.xero_tax_type, 'ALV_NONDEDUCTIBLE_INPUT');
  assert.equal(applied.tax_treatment, 'Osto, vähennyskelvoton arvonlisävero');
  // The stamped label re-resolves to the same code (preview → commit rebuild).
  assert.equal(resolveAlvCode({ taxTreatment: applied.tax_treatment, direction: 'in' }), 'ALV_NONDEDUCTIBLE_INPUT');
  const refund = applyAlvCodingToCoding({ coding: { account_type: 'expense', tax_treatment: 'Vähennyskelvoton ALV (osto)' }, transaction: { money_in: 25.1 } });
  assert.equal(refund.tax_type, 'ALV_NONDEDUCTIBLE_INPUT', 'a refund keeps the purchase side');
  const onSale = applyAlvCodingToCoding({ coding: { account_type: 'revenue', tax_treatment: 'Vähennyskelvoton ALV (osto)' }, transaction: { money_in: 100 } });
  assert.equal(onSale.tax_type, undefined, 'a sale is left uncoded, never stamped');
});

test('W: alvDirectionForTransaction reads the transaction in the plain accounting sense', () => {
  assert.equal(alvDirectionForTransaction({ money_in: 500 }), 'out'); // sale
  assert.equal(alvDirectionForTransaction({ money_out: 120 }), 'in'); // purchase
  assert.equal(alvDirectionForTransaction({}), '');
  // Not yet in the chart: a known account name carries its canonical class,
  // so a purchase refund on its expense account stays on the input side.
  assert.equal(alvDirectionForTransaction({ money_in: 49.9 }, { proposed_account: 'Operating supplies' }), 'in');
  assert.equal(alvDirectionForTransaction({ money_out: 49.9 }, { proposed_account: 'Other income' }), 'out');
  // A stored chart type wins; an unknown name keeps the cash-side fallback.
  assert.equal(alvDirectionForTransaction({ money_in: 49.9 }, { proposed_account: 'Operating supplies', account_type: 'revenue' }), 'out');
  assert.equal(alvDirectionForTransaction({ money_in: 49.9 }, { proposed_account: 'Synthetic custom account' }), 'out');
});

test('W: applyAlvCodingToCoding stamps the code on both fields the journal builder reads', () => {
  const coding = { proposed_account: 'Myynti', tax_treatment: 'ALV 25,5 %', xero_tax_type: null };
  const applied = applyAlvCodingToCoding({ coding, transaction: { money_in: 620 } });
  assert.equal(applied.tax_type, 'ALV_25_5_OUTPUT');
  assert.equal(applied.xero_tax_type, 'ALV_25_5_OUTPUT');
  // The label reflects what is actually posted.
  assert.equal(applied.tax_treatment, 'Myynti, yleinen verokanta 25,5 %');
  // A stale SG chart default must not outrank the resolved ALV code.
  const overStale = applyAlvCodingToCoding({
    coding: { tax_treatment: 'ALV 14 %', xero_tax_type: 'NONE' },
    transaction: { money_out: 80 }
  });
  assert.equal(overStale.xero_tax_type, 'ALV_14_INPUT');
});

test('W: applyAlvCodingToCoding leaves unresolvable verdicts untouched (uncoded escalates downstream)', () => {
  const unsure = { proposed_account: 'Myynti', tax_treatment: 'ALV-tarkistus' };
  assert.deepEqual(applyAlvCodingToCoding({ coding: unsure, transaction: { money_in: 100 } }), unsure);
  const sgProse = { tax_treatment: 'GST 9%' };
  assert.deepEqual(applyAlvCodingToCoding({ coding: sgProse, transaction: { money_out: 10 } }), sgProse);
});

// ── FI-3 slice S — the split-posting arithmetic (D-FI3-S1..S3) ──────────────
// docs/design-donna-finland-fi3-alv-split.md

test('S: splitAlvGross pins — domestic rates split, vat absorbs the rounding cent', () => {
  const purchase = splitAlvGross({ gross: 125.5, code: 'ALV_25_5_INPUT' });
  assert.deepEqual(purchase, {
    code: 'ALV_25_5_INPUT', rate: 25.5, direction: 'in', gross: 125.5, net: 100, vat: 25.5,
    role: 'alv_input_deductible',
    controlAccount: { code: '2940', name: 'Vähennettävä arvonlisävero', account_type: 'liability', normal_balance: 'debit' }
  });
  const sale = splitAlvGross({ gross: 251, code: 'ALV_25_5_OUTPUT' });
  assert.equal(sale.net, 200);
  assert.equal(sale.vat, 51);
  assert.equal(sale.role, 'alv_output');
  assert.equal(sale.controlAccount.code, '2939');
  // Rounding-cent absorption: net + vat == gross ALWAYS.
  for (const gross of [0.09, 1.01, 99.99, 620, 1234.56]) {
    for (const code of ['ALV_25_5_INPUT', 'ALV_13_5_INPUT', 'ALV_14_INPUT', 'ALV_10_OUTPUT']) {
      const split = splitAlvGross({ gross, code });
      assert.equal(Math.round((split.net + split.vat) * 100) / 100, gross, `${code} @ ${gross}`);
    }
  }
  const reduced = splitAlvGross({ gross: 114, code: 'ALV_14_INPUT' });
  assert.equal(reduced.net, 100);
  assert.equal(reduced.vat, 14);
  // G-1: the 2026 reduced-1 rate splits identically through the same arithmetic.
  const reduced2026 = splitAlvGross({ gross: 113.5, code: 'ALV_13_5_INPUT' });
  assert.equal(reduced2026.net, 100);
  assert.equal(reduced2026.vat, 13.5);
  assert.equal(reduced2026.controlAccount.code, '2940');
  const sale2026 = splitAlvGross({ gross: 227, code: 'ALV_13_5_OUTPUT' });
  assert.equal(sale2026.net, 200);
  assert.equal(sale2026.vat, 27);
  assert.equal(sale2026.controlAccount.code, '2939');
});

test('S: non-splitting codes and invalid grosses return null — the amount IS the base', () => {
  for (const code of ['ALV_0_OUTPUT', 'ALV_EXEMPT', 'ALV_OUT_OF_SCOPE', 'ALV_EU_ACQUISITION', 'ALV_EU_SERVICE_ACQUISITION', 'ALV_IMPORT', 'ALV_REVERSE_CHARGE_PURCHASE', 'ALV_EU_SUPPLY']) {
    assert.equal(splitAlvGross({ gross: 100, code }), null, code);
  }
  assert.equal(splitAlvGross({ gross: 0, code: 'ALV_25_5_INPUT' }), null);
  assert.equal(splitAlvGross({ gross: -50, code: 'ALV_25_5_INPUT' }), null);
  assert.equal(splitAlvGross({ gross: 100, code: 'NOT_A_CODE' }), null);
  // Cent-level gross whose VAT share rounds to 0.00: the amount IS the base at
  // two-decimal resolution — null (post unsplit), never a zero VAT leg the
  // journal builder would have to refuse (a deterministic posting wedge).
  for (const [gross, code] of [
    [0.01, 'ALV_25_5_INPUT'], [0.02, 'ALV_25_5_INPUT'],
    [0.01, 'ALV_14_INPUT'], [0.03, 'ALV_14_INPUT'],
    [0.02, 'ALV_10_OUTPUT'], [0.05, 'ALV_10_OUTPUT']
  ]) {
    assert.equal(splitAlvGross({ gross, code }), null, `${code} @ ${gross}`);
  }
  // The smallest splitting grosses still foot by construction.
  const tiny = splitAlvGross({ gross: 0.03, code: 'ALV_25_5_INPUT' });
  assert.deepEqual({ net: tiny.net, vat: tiny.vat }, { net: 0.02, vat: 0.01 });
});

test('S: resolveAlvSplitForPosting derives from the APPLIED coding + transaction direction only', () => {
  // The coding carries a resolved FI code (what applyAlvCodingToCoding stamps).
  const split = resolveAlvSplitForPosting({
    coding: { tax_type: 'ALV_25_5_INPUT', xero_tax_type: 'ALV_25_5_INPUT' },
    transaction: { money_out: 125.5 }
  });
  assert.equal(split.net, 100);
  assert.equal(split.vat, 25.5);
  // Direction mismatch (an output code on a spend) does NOT split — the
  // D-FI3-A5 blockers surface it downstream, never a guessed control leg.
  assert.equal(resolveAlvSplitForPosting({ coding: { tax_type: 'ALV_25_5_OUTPUT' }, transaction: { money_out: 125.5 } }), null);
  // A Xero/QBO tax type never resolves → every non-FI client is byte-identical.
  assert.equal(resolveAlvSplitForPosting({ coding: { xero_tax_type: 'INPUTY24' }, transaction: { money_out: 125.5 } }), null);
  // Unresolved / uncoded → no split.
  assert.equal(resolveAlvSplitForPosting({ coding: {}, transaction: { money_out: 125.5 } }), null);
});

// ── 308-settlement follow-up (slice-S design §what-this-does-NOT-do) ─────────
// The OmaVero settlement payment: DR 2939 / CR bank, never an ALV code on the
// control account.

test('308: applyAlvCodingToCoding never stamps an ALV code onto a control-account coding', () => {
  // The settlement shape: coded to 2939 with the out-of-scope treatment.
  const settlement = applyAlvCodingToCoding({
    coding: { proposed_account: 'Suoritettava arvonlisävero', account_code: '2939', tax_treatment: 'Ei ALV-käsittelyä' },
    transaction: { money_out: 812.4 }
  });
  assert.equal(settlement.tax_type, 'NONE');
  assert.equal(settlement.xero_tax_type, 'NONE');
  // Even a (wrong) rate-carrying verdict on a control account posts uncoded —
  // a code on a control account is the D-FI3-A5 blocker, never something we post.
  for (const accountCode of ['2939', '2940', '1763']) {
    const guarded = applyAlvCodingToCoding({
      coding: { account_code: accountCode, tax_treatment: 'ALV 25,5 %' },
      transaction: { money_out: 125.5 }
    });
    assert.equal(guarded.tax_type, 'NONE', accountCode);
    assert.equal(guarded.xero_tax_type, 'NONE', accountCode);
  }
  // And the guarded coding never yields a split.
  assert.equal(resolveAlvSplitForPosting({ coding: settlement, transaction: { money_out: 812.4 } }), null);
  // Non-control accounts keep the slice-W behavior byte-identically.
  const normal = applyAlvCodingToCoding({
    coding: { account_code: '4400', tax_treatment: 'ALV 25,5 %' },
    transaction: { money_out: 125.5 }
  });
  assert.equal(normal.tax_type, 'ALV_25_5_INPUT');
});

test('308: withFinlandAlvSettlementAccount unions the canonical 2939 row exactly once', () => {
  assert.deepEqual(FINLAND_ALV_SETTLEMENT_ACCOUNT, {
    code: '2939', name: 'Suoritettava arvonlisävero', account_type: 'liability', normal_balance: 'credit'
  });
  const chart = [{ code: '4400', name: 'Ulkopuoliset palvelut' }];
  const unioned = withFinlandAlvSettlementAccount(chart);
  assert.equal(unioned.length, 2);
  assert.equal(unioned[1].code, '2939');
  assert.equal(unioned[1].status, 'active');
  // The input array is not mutated.
  assert.equal(chart.length, 1);
  // Present by code → unchanged (same reference, no duplicate).
  const withCode = [{ code: '2939', name: 'Suoritettava arvonlisävero', id: 'acc-1' }];
  assert.equal(withFinlandAlvSettlementAccount(withCode), withCode);
  // A name-matched row WITHOUT a code (a historical mint-by-name artifact) gets
  // the canonical code backfilled in-memory — resolving to a code-less row
  // would bypass the control-account guard, the return engine's control
  // tracking, and the unmarked-movement INFO lane (all keyed on account_code).
  const withName = [{ code: '', name: 'suoritettava arvonlisävero', id: 'acc-legacy' }];
  const healed = withFinlandAlvSettlementAccount(withName);
  assert.equal(healed.length, 1, 'no duplicate row');
  assert.equal(healed[0].code, '2939', 'canonical code backfilled');
  assert.equal(healed[0].id, 'acc-legacy', 'the existing row is kept, not replaced');
  assert.equal(healed[0].account_type, 'liability');
  // The input array is not mutated by the backfill.
  assert.equal(withName[0].code, '');
});
