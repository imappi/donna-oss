// GB VAT posting-code vocabulary — the pin tests. Two jobs: trip CI on any
// silent rate/code edit, and pin the boundaries this module deliberately does
// NOT cross (the coder's treatment labels, a statutory control account). The
// INPUT half joined 2026-07-31 (audit §2 — Boxes 4/7 had no data producer);
// its enrichment/split chain is pinned below through the isolation-listed
// journal builder itself.
//   node --test server/donna/gb/vatCodes.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { GB_VAT_TAX_TREATMENT_OPTIONS } from '../gb/taxVocabulary.js';
import { alvOutputCodeForRate } from '../finland/alvCodes.js';
import { buildLedgerJournalForTransaction } from '../ledger.js';
import {
  GB_VAT_CODES,
  GB_VAT_OUTPUT_ROLE,
  GB_VAT_INPUT_ROLE,
  GB_VAT_RATE_PROVENANCE,
  GB_VAT_REDUCED_RATE,
  GB_VAT_STANDARD_RATE,
  gbVatOutputCodeForRate,
  gbVatInputCodeForRate,
  gbVatDirectionForTransaction,
  resolveGbVatCodeForCoding,
  gbVatControlAccountFromChart,
  applyGbVatCodingToCoding,
  splitGbVatGross,
  resolveGbVatSplitForPosting
} from './vatCodes.js';

test('the rate set and its codes resolve exactly (the silent-edit tripwire)', () => {
  assert.equal(GB_VAT_STANDARD_RATE, 20);
  assert.equal(GB_VAT_REDUCED_RATE, 5);
  assert.deepEqual(
    GB_VAT_CODES.filter((e) => e.code.endsWith('_OUTPUT') && ['standard', 'reduced', 'zero'].includes(e.kind)).map((e) => [e.code, e.rate, e.kind]),
    [
      ['VAT_SR_20_OUTPUT', 20, 'standard'],
      ['VAT_RR_5_OUTPUT', 5, 'reduced'],
      ['VAT_ZR_OUTPUT', 0, 'zero']
    ]
  );
  // Frozen — a closed vocabulary, not a growable list.
  assert.throws(() => { GB_VAT_CODES.push({ code: 'X' }); });
});

test('gbVatOutputCodeForRate maps each domestic rate and refuses everything else', () => {
  assert.equal(gbVatOutputCodeForRate(20), 'VAT_SR_20_OUTPUT');
  assert.equal(gbVatOutputCodeForRate(5), 'VAT_RR_5_OUTPUT');
  // A zero-rated supply is REPORTED, not uncoded revenue — the difference
  // between a correct Box 6 and a silently understated one.
  assert.equal(gbVatOutputCodeForRate(0), 'VAT_ZR_OUTPUT');
  assert.equal(gbVatOutputCodeForRate('20'), 'VAT_SR_20_OUTPUT', 'numeric strings resolve');

  // 17.5 % (the pre-2011 standard rate) and 12.5 % (the 2021-10 → 2022-03
  // hospitality rate) are real UK rates and deliberately OUT of vocabulary: this
  // map serves the AR-posting path, which codes invoices Donna ISSUES — always
  // current-dated. A historical rate belongs to a date-resolved table on a
  // purchase/extraction lane, not to an undated lookup here.
  assert.equal(gbVatOutputCodeForRate(17.5), null);
  assert.equal(gbVatOutputCodeForRate(12.5), null);
  assert.equal(gbVatOutputCodeForRate(-1), null);
  assert.equal(gbVatOutputCodeForRate('twenty'), null);
  assert.equal(gbVatOutputCodeForRate(undefined), null);

  // `null` resolves to the ZERO-RATED code, because Number(null) is 0. Pinned
  // deliberately rather than "fixed": it is byte-identical to both twins
  // (alvOutputCodeForRate, gstOutputCodeForRate), and the question it looks like
  // it raises — "should an ABSENT rate be treated as zero-rated?" — is settled
  // UPSTREAM, not here. The journal builder groups on
  // `roundedMoney(l.alvRate || 0)`, so an absent rate is already 0 by the time
  // this is called and null never reaches it; and the generic invoice model
  // refuses a partly-rated invoice outright (all-or-nothing per half), so a
  // registered seller's line cannot arrive rate-less in the first place.
  // Making this one twin stricter would buy no safety and cost the
  // interchangeability the injected profile depends on.
  assert.equal(gbVatOutputCodeForRate(null), 'VAT_ZR_OUTPUT');
  assert.equal(alvOutputCodeForRate(null), 'ALV_0_OUTPUT', 'the twin behaves identically — this is a convention, not a GB quirk');
});

test('it never throws — an unmapped rate is the CALLER\'s typed refusal, not an exception here', () => {
  for (const input of [NaN, Infinity, {}, [], () => {}, Symbol.iterator.toString()]) {
    assert.doesNotThrow(() => gbVatOutputCodeForRate(input));
  }
});

test('the line role is the FI/SG twin, and every VAT code has a return map', () => {
  assert.equal(GB_VAT_OUTPUT_ROLE, 'vat_output');
  assert.ok(GB_VAT_CODES.some((e) => e.direction === 'in'));
  assert.ok(GB_VAT_CODES.every((e) => e.return_boxes));
});

test('these are POSTING codes, and share no value with the coder\'s TREATMENT labels', () => {
  // The confusion this separation exists to prevent: taxVocabularies.js holds
  // model-facing treatment labels ('VAT 20%') whose downstream is a Xero tax
  // type. These are ledger-line tax_type codes. Disjoint by construction.
  const codes = new Set(GB_VAT_CODES.map((e) => e.code));
  for (const label of GB_VAT_TAX_TREATMENT_OPTIONS) {
    assert.ok(!codes.has(label), `treatment label '${label}' must not double as a posting code`);
  }
});

test('the CONTRACT matches its FI twin, so the injected profile is genuinely interchangeable', () => {
  // Not the same ANSWERS — the rate sets are properly different, which is the
  // whole reason each market has its own map. The same CONTRACT: a rate in, a
  // non-empty string or null out, never a throw. That is what lets ledger.js
  // hold one split branch instead of a per-market fork.
  for (const rate of [0, 5, 10, 20, 24, 25.5, 17.5, NaN, 'x']) {
    for (const resolve of [gbVatOutputCodeForRate, alvOutputCodeForRate]) {
      const out = resolve(rate);
      assert.ok(out === null || (typeof out === 'string' && out.length > 0), `${rate}: string-or-null`);
    }
  }
  assert.equal(gbVatOutputCodeForRate(25.5), null, 'an FI rate is not a GB rate — the maps are genuinely separate');
  assert.equal(alvOutputCodeForRate(20), null, '...and vice versa: 20 % is not a Finnish ALV rate');
});

test('rates carry provenance and an honest unconfirmed flag', () => {
  assert.equal(GB_VAT_RATE_PROVENANCE.authority, 'HM Revenue & Customs');
  assert.ok(GB_VAT_RATE_PROVENANCE.source.includes('Value Added Tax Act 1994'));
  assert.match(GB_VAT_RATE_PROVENANCE.as_of, /^\d{4}-\d{2}-\d{2}$/);
  // gov.uk returns 403 through this environment's egress proxy — the same
  // posture as vero.fi and iras.gov.sg. A network-open session should do the
  // primary read; until then the flag says so rather than implying confirmation.
  assert.equal(GB_VAT_RATE_PROVENANCE.confirmedAgainstPrimary, false);
});

// ── The input half (audit §2 — the Box 4/7 data producer) ──────────────────

const CONTROL = { code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit' };

test('gbVatInputCodeForRate maps the domestic purchase rates; exempt purchases carry a Box 7 code', () => {
  assert.equal(gbVatInputCodeForRate(20), 'VAT_SR_20_INPUT');
  assert.equal(gbVatInputCodeForRate(5), 'VAT_RR_5_INPUT');
  assert.equal(gbVatInputCodeForRate(0), 'VAT_ZR_INPUT');
  assert.equal(gbVatInputCodeForRate(17.5), null);
  // The exempt-purchase code exists so Box 7 (total purchases) can see an
  // exempt purchase at all — but it is a TREATMENT, not a rate, so the rate
  // map never resolves to it.
  const exemptIn = GB_VAT_CODES.find((e) => e.code === 'VAT_EXEMPT_INPUT');
  assert.deepEqual(exemptIn.return_boxes, { net: '7' });
});

test('resolveGbVatCodeForCoding renders each treatment label per direction and refuses the unsure marker', () => {
  const cases = [
    ['VAT 20%', 'in', 'VAT_SR_20_INPUT'],
    ['VAT 20%', 'out', 'VAT_SR_20_OUTPUT'],
    ['VAT 5%', 'in', 'VAT_RR_5_INPUT'],
    ['VAT 5%', 'out', 'VAT_RR_5_OUTPUT'],
    ['Zero-rated 0%', 'in', 'VAT_ZR_INPUT'],
    ['Zero-rated 0%', 'out', 'VAT_ZR_OUTPUT'],
    ['VAT exempt', 'in', 'VAT_EXEMPT_INPUT'],
    ['VAT exempt', 'out', 'VAT_EXEMPT_OUTPUT'],
    ['Outside the scope of VAT', 'in', 'VAT_OUTSIDE_SCOPE_INPUT'],
    ['Outside the scope of VAT', 'out', 'VAT_OUTSIDE_SCOPE_OUTPUT'],
    ['Reverse charge', 'in', 'VAT_REVERSE_CHARGE_20_INPUT'],
    // IV-2 (2026-08-02): the two labels that existed as posting codes with no
    // expressible verdict.
    ['EU acquisition', 'in', 'VAT_EU_ACQUISITION_20_INPUT'],
    ['VAT blocked (no reclaim)', 'in', 'VAT_BLOCKED_INPUT']
  ];
  for (const [label, direction, expected] of cases) {
    assert.equal(resolveGbVatCodeForCoding({ taxTreatment: label, direction }), expected, `${label} / ${direction}`);
  }
  // The unsure marker never stamps; a reverse-charge SALE is an honest v1 gap;
  // rate labels with no direction never guess a side.
  assert.equal(resolveGbVatCodeForCoding({ taxTreatment: 'VAT check', direction: 'in' }), '');
  assert.equal(resolveGbVatCodeForCoding({ taxTreatment: 'Reverse charge', direction: 'out' }), '');
  assert.equal(resolveGbVatCodeForCoding({ taxTreatment: 'VAT 20%', direction: '' }), '');
  // Both IV-2 treatments are purchase-side only: a sale resolves '' and
  // escalates rather than guessing.
  assert.equal(resolveGbVatCodeForCoding({ taxTreatment: 'EU acquisition', direction: 'out' }), '');
  assert.equal(resolveGbVatCodeForCoding({ taxTreatment: 'VAT blocked (no reclaim)', direction: 'out' }), '');
  // An explicit machine code passes through regardless of direction hints.
  assert.equal(resolveGbVatCodeForCoding({ taxType: 'VAT_SR_20_INPUT' }), 'VAT_SR_20_INPUT');
  // Foreign vocabularies never resolve (an SG/FI verdict posts uncoded).
  assert.equal(resolveGbVatCodeForCoding({ taxTreatment: 'GST 9%', direction: 'in' }), '');
  assert.equal(resolveGbVatCodeForCoding({ taxTreatment: 'ALV 25,5 %', direction: 'in' }), '');
});

test('gbVatControlAccountFromChart resolves exactly-one role row and refuses zero/many/code-less to null', () => {
  const role = 'liability.sales_tax_payable';
  const control = { code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit', canonical_role: role, status: 'active' };
  assert.deepEqual(
    gbVatControlAccountFromChart([{ code: '1000', canonical_role: 'asset.bank' }, control], role),
    { code: '2220', name: 'VAT control', account_type: 'liability', normal_balance: 'credit' }
  );
  assert.equal(gbVatControlAccountFromChart([], role), null, 'zero rows → null');
  assert.equal(gbVatControlAccountFromChart([control, { ...control, code: '2221' }], role), null, 'two rows → ambiguous → null');
  assert.equal(gbVatControlAccountFromChart([{ ...control, code: '' }], role), null, 'code-less row → null');
  assert.equal(gbVatControlAccountFromChart([control], undefined), null, 'no role → null');
});

test('applyGbVatCodingToCoding stamps code + control for splitting kinds and refuses to stamp them without a control', () => {
  const coding = { account_code: '5000', account_name: 'Office costs', tax_treatment: 'VAT 20%' };
  const spend = { money_out: 120 };
  const applied = applyGbVatCodingToCoding({ coding, transaction: spend, controlAccount: CONTROL });
  assert.equal(applied.tax_type, 'VAT_SR_20_INPUT');
  assert.equal(applied.xero_tax_type, 'VAT_SR_20_INPUT');
  assert.equal(applied.tax_treatment, 'Standard-rated purchase 20%', 'label reflects what is actually posted');
  assert.deepEqual(applied.gb_vat_control, CONTROL);

  // A splitting-kind verdict with NO resolvable control leaves the coding
  // untouched — stamping it would post gross wearing a net-coded face.
  assert.deepEqual(applyGbVatCodingToCoding({ coding, transaction: spend, controlAccount: null }), coding);

  // Non-splitting kinds stamp without needing a control (no VAT in the price).
  const zero = applyGbVatCodingToCoding({
    coding: { ...coding, tax_treatment: 'Zero-rated 0%' }, transaction: spend, controlAccount: null
  });
  assert.equal(zero.tax_type, 'VAT_ZR_INPUT');
  assert.equal(zero.gb_vat_control, undefined);

  // A coding that TARGETS the control account never carries a VAT code.
  const onControl = applyGbVatCodingToCoding({
    coding: { account_code: '2220', tax_treatment: 'VAT 20%' }, transaction: spend, controlAccount: CONTROL
  });
  assert.equal(onControl.tax_type, 'NONE');
  assert.equal(onControl.xero_tax_type, 'NONE');

  // The unsure marker and foreign vocabularies leave the coding untouched.
  const unsure = { ...coding, tax_treatment: 'VAT check' };
  assert.deepEqual(applyGbVatCodingToCoding({ coding: unsure, transaction: spend, controlAccount: CONTROL }), unsure);
});

test('splitGbVatGross splits price-included domestic rates only, absorbing the rounding penny', () => {
  assert.deepEqual(
    splitGbVatGross({ gross: 120, code: 'VAT_SR_20_INPUT' }),
    { code: 'VAT_SR_20_INPUT', rate: 20, direction: 'in', gross: 120, net: 100, vat: 20 }
  );
  const odd = splitGbVatGross({ gross: 99.99, code: 'VAT_SR_20_INPUT' });
  assert.equal(odd.net + odd.vat, 99.99, 'net + vat == gross by construction');
  assert.deepEqual(
    splitGbVatGross({ gross: 105, code: 'VAT_RR_5_OUTPUT' }).net, 100
  );
  // Zero/exempt/outside/reverse-charge/blocked never split (no reclaimable
  // VAT to book — blocked VAT stays inside the expense by design, IV-2a).
  for (const code of ['VAT_ZR_INPUT', 'VAT_EXEMPT_INPUT', 'VAT_OUTSIDE_SCOPE_INPUT', 'VAT_REVERSE_CHARGE_20_INPUT', 'VAT_BLOCKED_INPUT']) {
    assert.equal(splitGbVatGross({ gross: 120, code }), null, code);
  }
  // Penny-level gross where VAT rounds to zero posts unsplit.
  assert.equal(splitGbVatGross({ gross: 0.02, code: 'VAT_SR_20_INPUT' }), null);
});

test('SEAM: a GB expense coded VAT 20% books net base + role-marked input-VAT control leg through the journal builder', () => {
  // The full enrichment → split → post chain, through the ISOLATION-LISTED
  // builder itself: this is the Box 4/7 data actually reaching ledger lines.
  const transaction = { id: 'tx-gb', date: '2026-06-10', description: 'Screwfix', money_out: 120, account_currency: 'GBP' };
  const coding = applyGbVatCodingToCoding({
    coding: { account_code: '5000', account_name: 'Materials', xero_account_type: 'EXPENSE', tax_treatment: 'VAT 20%' },
    transaction,
    controlAccount: CONTROL
  });
  const split = resolveGbVatSplitForPosting({ coding, transaction });
  assert.equal(split.role, GB_VAT_INPUT_ROLE);
  const journal = buildLedgerJournalForTransaction({
    transaction, coding, bankAccount: { code: '1200', name: 'Barclays Current' }, alvSplit: split
  });
  assert.equal(journal.lines.length, 3);
  assert.equal(journal.lines[0].debit, 100, 'net base on the coded expense line');
  assert.equal(journal.lines[0].account.tax_type, 'VAT_SR_20_INPUT', 'the Box 7 net carries the input code');
  assert.equal(journal.lines[1].debit, 20, 'the reclaimable VAT (Box 4) on the control leg');
  assert.equal(journal.lines[1].account.code, '2220');
  assert.equal(journal.lines[1].account.role, 'vat_input_deductible');
  assert.equal(journal.lines[1].account.tax_type, 'NONE', 'the code stays on the BASE line only');
  assert.equal(journal.lines[2].credit, 120, 'bank stays gross');
});

test('SEAM: the split derivation is direction-safe and control-gated (never a guessed control leg)', () => {
  const transaction = { money_out: 120 };
  // No gb_vat_control stamp → no split, even with a splitting code.
  assert.equal(resolveGbVatSplitForPosting({ coding: { tax_type: 'VAT_SR_20_INPUT' }, transaction }), null);
  // Direction mismatch (an INPUT code on money-in) → no split.
  assert.equal(resolveGbVatSplitForPosting({
    coding: { tax_type: 'VAT_SR_20_INPUT', gb_vat_control: CONTROL }, transaction: { money_in: 120 }
  }), null);
  // FI/SG codes never resolve here (disjoint vocabularies — at most one of the
  // two split resolvers ever fires at the shared call sites).
  assert.equal(resolveGbVatSplitForPosting({
    coding: { tax_type: 'ALV_25_5_INPUT', gb_vat_control: CONTROL }, transaction
  }), null);
  // The output side books the supply twin.
  const out = resolveGbVatSplitForPosting({
    coding: { tax_type: 'VAT_SR_20_OUTPUT', gb_vat_control: CONTROL }, transaction: { money_in: 240 }
  });
  assert.equal(out.net, 200);
  assert.equal(out.vat, 40);
  assert.equal(out.role, GB_VAT_OUTPUT_ROLE);
});
