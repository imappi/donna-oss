// GB VAT tax-code vocabulary — posting/return DATA + pure resolvers.
// resolver. The third instance of the convention `finland/alvCodes.js` and
// `singapore/gstCodes.js` already carry: a per-rate posting code that rides a
// revenue leg's `tax_type`, so a VAT return engine's base-code walk can see the
// sale rather than reconstructing a rate split from a posted journal.
//
// Design + the decision that put it here: docs/design-donna-gb-vat-ar-posting.md
// §4a. Cleared by Kari 2026-07-27 over the alternative (post `tax_type: 'NONE'`
// on GB revenue legs until an MTD return engine exists).
//
// THREE THINGS THIS MODULE DELIBERATELY IS NOT — read them before extending it:
//
// 1. **Not the coder's vocabulary.** `taxVocabularies.js`
//    (`GB_VAT_TAX_TREATMENT_OPTIONS`: 'VAT 20%', 'Zero-rated 0%', …) holds
//    model-facing TREATMENT LABELS whose downstream is a Xero tax type
//    (`xeroAccountMatcher.js:resolveCoderTaxType`). These are POSTING codes for
//    a journal line. Two different vocabularies; conflating them is the whole
//    reason this file is not a section of that one.
//
// 2. **The input half is preparation vocabulary, not a posting writer.** The
//    return engine consumes persisted tax_type verdicts. Nothing here posts a
//    journal or guesses a treatment; an unknown code is a named refusal.
//
// 3. **Not a control-account home.** FI and SG each carry a `*_SPLIT_CONTROL`
//    with a hardcoded account code (tilikartta 2939, SFRS 2950) because each
//    market ships a STATUTORY chart of accounts. The UK ships none, so GB's
//    control leg resolves from the client's own chart by the canonical role
//    `liability.sales_tax_payable` (gap 10) rather than from a code invented
//    here. Only the line ROLE lives in this module.
//
// Rates carry provenance and an as_of, per the pack rail's D5 footing.
// `confirmedAgainstPrimary` is FALSE: gov.uk returns 403 through this
// environment's egress proxy (the same posture as vero.fi for FI and iras.gov.sg
// for SG). A network-open session should do the primary read — the same
// outstanding pass as GB's £90k/£88k registration thresholds.

import { taxSideForCoding } from '../taxSourceEvidence.js';

export const GB_VAT_STANDARD_RATE = 20;
export const GB_VAT_REDUCED_RATE = 5;

// The line ROLE the control leg carries (the cross-check's persisted handle — it
// rides `ledger_lines.payload.role`). The FI/SG twin of `alv_output` /
// `gst_output`. The control leg itself carries `tax_type: 'NONE'`: the VAT code
// stays on the BASE line only, so the "no tax code on a control account"
// invariant holds uniformly across all three markets.
export const GB_VAT_OUTPUT_ROLE = 'vat_output';
export const GB_VAT_INPUT_ROLE = 'vat_input_deductible';

export const GB_VAT_RATE_PROVENANCE = Object.freeze({
  authority: 'HM Revenue & Customs',
  source: 'Value Added Tax Act 1994, sections 2 and 29A with Schedules 7A and 8 — the standard rate (20%, in force since 2011-01-04), the reduced rate (5%) and zero-rated supplies (Schedule 8)',
  as_of: '2026-07-27',
  confirmedAgainstPrimary: false,
  note: 'Training-corpus + secondary confirmation 2026-07-27; primary fetch blocked (gov.uk returns 403 through the egress proxy). A pin test trips CI on any silent rate edit either way.'
});

export const GB_VAT_BOX_PROVENANCE = Object.freeze({
  authority: 'HM Revenue & Customs',
  source: 'VAT Notice 700/12: filling in and submitting your VAT Return',
  as_of: '2026-07-29',
  confirmedAgainstPrimary: false,
  note: 'Nine-box mechanics and treatment mapping await a network-open primary-source check; gov.uk returned 403 through the session proxy. The engine therefore carries this provenance and refuses unknown treatments.'
});

// CURRENT rates only, and that is a deliberate scope, not an omission. This
// vocabulary is consumed by the AR-POSTING path, which codes invoices Donna
// ISSUES — always current-dated. The UK's historical rates (the 12.5%
// hospitality rate of 2021-10 → 2022-03, the pre-2011 17.5%) belong to a
// purchase/document-extraction lane that can meet an old document, and would be
// added there with their own effective-date table (the FI_ALV_RATES_BY_ERA /
// SG_GST_RATES_BY_ERA shape). Adding them now would be a rate table no caller
// can date-resolve against.
//
// Entry shape (the ALV_CODES/GST_CODES shape, minus `return_boxes` — see
// header note 2):
//   { code, label_en, rate, direction, kind }
const code = (code, label_en, rate, direction, kind, boxes) => Object.freeze({
  code, label_en, rate, direction, kind, return_boxes: Object.freeze(boxes)
});

export const GB_VAT_CODES = Object.freeze([
  code('VAT_SR_20_OUTPUT', 'Standard-rated supply 20%', 20, 'out', 'standard', { net: '6', tax: '1' }),
  code('VAT_RR_5_OUTPUT', 'Reduced-rated supply 5%', 5, 'out', 'reduced', { net: '6', tax: '1' }),
  code('VAT_ZR_OUTPUT', 'Zero-rated supply 0%', 0, 'out', 'zero', { net: '6' }),
  code('VAT_EXEMPT_OUTPUT', 'Exempt supply', 0, 'out', 'exempt', {}),
  code('VAT_OUTSIDE_SCOPE_OUTPUT', 'Outside-scope receipt', 0, 'out', 'outside_scope', {}),
  code('VAT_SR_20_INPUT', 'Standard-rated purchase 20%', 20, 'in', 'standard', { net: '7', tax: '4' }),
  code('VAT_RR_5_INPUT', 'Reduced-rated purchase 5%', 5, 'in', 'reduced', { net: '7', tax: '4' }),
  code('VAT_ZR_INPUT', 'Zero-rated purchase 0%', 0, 'in', 'zero', { net: '7' }),
  // An exempt purchase carries no reclaimable VAT but its net still belongs in
  // Box 7 (total value of purchases) — without this code an exempt purchase
  // was indistinguishable from an uncoded line and Box 7 understated.
  code('VAT_EXEMPT_INPUT', 'Exempt purchase', 0, 'in', 'exempt', { net: '7' }),
  code('VAT_OUTSIDE_SCOPE_INPUT', 'Outside-scope payment', 0, 'in', 'outside_scope', {}),
  // Blocked input VAT (business entertainment, most car purchases): the VAT is
  // real but never reclaimable, so there is NO Box 4 entry, no split, and no
  // control leg — the irrecoverable VAT stays in the expense, which is the
  // accounting reality. The posted (gross) amount rides Box 7; whether HMRC's
  // Box 7 wants net-of-irrecoverable-VAT instead is a named knowledge point the
  // provenance carries as unconfirmed (design-donna-gb-input-vat-boxes-4-7.md
  // §3, IV-2a). Without this code, a coder facing a blocked purchase could only
  // say 'VAT 20%' — a wrong-reclaim path — or 'VAT check' (manual). rate 20 is
  // documentation of the blocked VAT's rate, deliberately NOT consulted by the
  // return engine (kind 'blocked' is not standard/reduced) nor by the split
  // (not a splitting kind) nor by the rate maps (which match standard/reduced/
  // zero only).
  code('VAT_BLOCKED_INPUT', 'Blocked purchase (no reclaim)', 20, 'in', 'blocked', { net: '7' }),
  code('VAT_REVERSE_CHARGE_20_INPUT', 'Reverse-charge purchase 20%', 20, 'in', 'reverse_charge', { net: '7', output_tax: '1', input_tax: '4' }),
  code('VAT_EU_SUPPLY_OUTPUT', 'Supply to EU member state', 0, 'out', 'eu_supply', { net: '6', eu_net: '8' }),
  code('VAT_EU_ACQUISITION_20_INPUT', 'Acquisition from EU member state 20%', 20, 'in', 'eu_acquisition', { net: '7', acquisition_net: '9', acquisition_tax: '2', input_tax: '4' })
]);

const BY_CODE = new Map(GB_VAT_CODES.map((entry) => [entry.code, entry]));
export const resolveGbVatCode = (value) => BY_CODE.get(String(value || '').trim().toUpperCase()) || null;

// gbVatOutputCodeForRate(rate) — the domestic OUTPUT (supply) VAT code for a
// rate, or null if the rate is not a domestic-rate output code in the
// vocabulary. Pure data lookup, the exact twin of `alvOutputCodeForRate` and
// `gstOutputCodeForRate`: the sales-invoice journal builder consumes it to code
// each per-rate revenue leg, and an unmapped rate makes the caller REFUSE
// (typed) rather than guess a code. Rate 0 resolves to VAT_ZR_OUTPUT — a
// zero-rated supply is REPORTED, not uncoded revenue, and that distinction is
// the difference between a correct Box 6 and a silently understated one.
//
// Exempt and outside-the-scope supplies are NOT here on purpose: neither is a
// rate, both are treatments, and an invoice line carrying one has no VAT to
// split. A pack whose invoice declares such a line declares `tax_rate: 0` and
// codes as zero-rated; distinguishing exempt from zero-rated in the LEDGER is
// a return-engine concern (they land in different boxes) and lands with the box
// map, not before it. Never throws.
export const gbVatOutputCodeForRate = (rate) => {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const entry = GB_VAT_CODES.find((e) => e.direction === 'out'
    && (e.kind === 'standard' || e.kind === 'reduced' || e.kind === 'zero')
    && Number(e.rate) === r);
  return entry ? entry.code : null;
};

// gbVatInputCodeForRate(rate) — the domestic INPUT (purchase) twin: the code
// whose net lands in Box 7 and whose tax (where reclaimable) lands in Box 4.
// Same contract as the output half: unmapped rate → null, caller refuses.
export const gbVatInputCodeForRate = (rate) => {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const entry = GB_VAT_CODES.find((e) => e.direction === 'in'
    && (e.kind === 'standard' || e.kind === 'reduced' || e.kind === 'zero')
    && Number(e.rate) === r);
  return entry ? entry.code : null;
};

// ---------------------------------------------------------------------------------
// The GB posting-enrichment + split convention — the third instance of the
// FI-3 W/S design (finland/alvCodes.js) after singapore/gstCodes.js. Pure:
// the DB wiring (flag gate, chart read, control-role resolution) stays in
// firmDb.js; everything here is data → data.
// ---------------------------------------------------------------------------------
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// gbVatDirectionForTransaction(transaction, coding) — the VAT side of a bank
// line: 'in' (purchase) or 'out' (supply). The FI twin's rule, shared
// (taxSourceEvidence.js): the resolved account's class decides — an expense
// gives the purchase side, revenue the supply side — and the cash direction
// (money in = supply, money out = purchase) only when the class is unknown.
// So a supplier refund coded to its expense account reverses input VAT; it
// never becomes a standard-rated sale.
export const gbVatDirectionForTransaction = (transaction = {}, coding = {}) => taxSideForCoding(transaction, coding);

// resolveGbVatCodeForCoding({ taxType, taxTreatment, direction }) — render a
// coder verdict (a GB machine code, or a GB_VAT_TAX_TREATMENT_OPTIONS label)
// to the vocabulary code for the transaction's direction. '' when it cannot
// decide — 'VAT check' (the unsure marker), unknown prose, or an unknown
// direction never stamp a code (the line posts uncoded and escalates).
//
// A reverse-charge SALE deliberately resolves '' in v1: the vocabulary carries
// no output reverse-charge code yet (domestic-RC construction sales report net
// in Box 6 with no output tax) — an honest gap that escalates rather than a
// guessed code. The purchase side resolves VAT_REVERSE_CHARGE_20_INPUT.
// The treatment of a business that is not VAT-registered on the line's date
// (gb/taxVocabulary.js): it renders to no VAT code. Enrichment stamps it NONE
// (applyGbVatCodingToCoding) and the posting policy admits that NONE only
// while the registration record says not registered on the date.
export const GB_NOT_REGISTERED_TREATMENT = 'No VAT (not VAT-registered)';
export const isGbNotRegisteredTreatment = (taxTreatment = '') =>
  String(taxTreatment || '').trim().toLowerCase().replace(/\s+/g, ' ') === GB_NOT_REGISTERED_TREATMENT.toLowerCase();

export const resolveGbVatCodeForCoding = ({ taxType = '', taxTreatment = '', direction = '' } = {}) => {
  const explicit = String(taxType || '').trim().toUpperCase();
  if (BY_CODE.has(explicit)) return explicit;
  const isSale = direction === 'out';
  const isPurchase = direction === 'in';
  const treatment = String(taxTreatment || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!treatment) return '';
  // The unsure marker refuses to guess, always.
  if (/vat check/.test(treatment)) return '';
  if (/reverse charge/.test(treatment)) return isPurchase ? 'VAT_REVERSE_CHARGE_20_INPUT' : '';
  // IV-2a/IV-2b (design-donna-gb-input-vat-boxes-4-7.md §3): both are
  // purchase-side treatments; on a sale (or unknown direction) they resolve ''
  // and the line escalates rather than guessing.
  if (/(vat blocked|blocked input|no reclaim)/.test(treatment)) return isPurchase ? 'VAT_BLOCKED_INPUT' : '';
  if (/(eu acquisition|acquisition from (an |the )?eu)/.test(treatment)) return isPurchase ? 'VAT_EU_ACQUISITION_20_INPUT' : '';
  if (/(outside the scope|out of scope|outside scope)/.test(treatment)) {
    if (isSale) return 'VAT_OUTSIDE_SCOPE_OUTPUT';
    if (isPurchase) return 'VAT_OUTSIDE_SCOPE_INPUT';
    return '';
  }
  if (/(zero-?rated|zero rated)/.test(treatment)) {
    if (isSale) return 'VAT_ZR_OUTPUT';
    if (isPurchase) return 'VAT_ZR_INPUT';
    return '';
  }
  if (/(vat exempt|exempt)/.test(treatment)) {
    if (isSale) return 'VAT_EXEMPT_OUTPUT';
    if (isPurchase) return 'VAT_EXEMPT_INPUT';
    return '';
  }
  // Rate-carrying labels ('VAT 20%' / 'VAT 5%'). Direction picks the side; an
  // unknown direction returns '' (never guess which side of the return a rate
  // lands on).
  const rated = treatment.match(/vat\s*(20|5)\s*%?/);
  if (rated) {
    if (!isSale && !isPurchase) return '';
    return rated[1] === '20'
      ? (isSale ? 'VAT_SR_20_OUTPUT' : 'VAT_SR_20_INPUT')
      : (isSale ? 'VAT_RR_5_OUTPUT' : 'VAT_RR_5_INPUT');
  }
  return '';
};

// The kinds that split a GROSS bank amount into net base + VAT: the domestic
// price-included rates only (the D-FI3-S1 posture). Zero/exempt/outside-scope
// carry no VAT in the price; reverse-charge and EU acquisitions are billed NET
// (their tax is self-assessed on the return, deliberately NOT posted in v1).
const GB_VAT_SPLITTING_KINDS = new Set(['standard', 'reduced']);

// gbVatControlAccountFromChart(ledgerAccounts, role) — resolve the client's
// VAT control account from its OWN chart by canonical role (the UK ships no
// statutory chart of accounts, so there is no hardcoded 2939/2950 twin —
// header note 3). Fail-closed BOTH ways to null: zero rows and more-than-one
// row each refuse to guess; the caller then posts unsplit/unstamped exactly as
// before enrichment existed. The role is caller-supplied (firmDb owns
// SALES_TAX_ACCOUNT_ROLE) so this leaf imports nothing.
export const gbVatControlAccountFromChart = (ledgerAccounts = [], role) => {
  if (!role) return null;
  const rows = (Array.isArray(ledgerAccounts) ? ledgerAccounts : [])
    .filter((a) => a && a.canonical_role === role && (a.status == null || a.status === 'active'));
  if (rows.length !== 1) return null;
  const row = rows[0];
  const codeStr = String(row.code || row.account_code || '').trim();
  if (!codeStr) return null;
  return {
    code: codeStr,
    name: row.name || row.account_name || '',
    account_type: row.account_type || row.type || 'liability',
    normal_balance: row.normal_balance || 'credit'
  };
};

// applyGbVatCodingToCoding({ coding, transaction, controlAccount }) — the
// posting-preview enrichment for a JURISDICTION_TAX_CODING-routed GB client
// (the applyAlvCodingToCoding / applyGstCodingToCoding twin). Renders the
// coder's persisted treatment to a Donna-native VAT code and stamps it where
// the journal builder already reads (xero_tax_type / tax_type), so the code
// reaches ledger_lines.tax_type with ZERO changes to the isolation-listed
// writers. Two GB-specific rules:
//   - a coding that TARGETS the VAT control account never carries a VAT code
//     (tax_type 'NONE' — the code-on-control blocker posture);
//   - a SPLITTING-kind code (standard/reduced purchase or supply) without a
//     resolvable control account leaves the coding UNTOUCHED: stamping it
//     would post a gross amount wearing a net-coded face (P&L overstated by
//     reclaimable VAT), so the line posts as today and escalates instead.
// The resolved control account rides the coding as `gb_vat_control` so the
// commit-time journal rebuild (which re-derives the split from the coding
// alone, D-FI3-S2) needs no second chart read.
export const applyGbVatCodingToCoding = ({ coding = {}, transaction = {}, controlAccount = null } = {}) => {
  const targetAccountCode = String(coding.xero_account_code || coding.account_code || '').trim();
  if (controlAccount?.code && targetAccountCode === String(controlAccount.code).trim()) {
    return { ...coding, tax_type: 'NONE', xero_tax_type: 'NONE' };
  }
  // The not-registered treatment carries no VAT code: NONE, as a control
  // settlement is stamped. An explicit VAT code on the coding still wins (and
  // the posting policy refuses it for an unregistered business).
  if (isGbNotRegisteredTreatment(coding.tax_treatment) && !BY_CODE.has(String(coding.tax_type || coding.xero_tax_type || '').trim().toUpperCase())) {
    return { ...coding, tax_type: 'NONE', xero_tax_type: 'NONE' };
  }
  const code = resolveGbVatCodeForCoding({
    taxType: coding.tax_type || coding.xero_tax_type || '',
    taxTreatment: coding.tax_treatment || '',
    direction: gbVatDirectionForTransaction(transaction, coding)
  });
  if (!code) return coding;
  const entry = resolveGbVatCode(code);
  const splits = entry && GB_VAT_SPLITTING_KINDS.has(entry.kind) && entry.rate > 0;
  if (splits && !controlAccount?.code) return coding;
  return {
    ...coding,
    tax_type: code,
    xero_tax_type: code,
    // Label reflects what is ACTUALLY posted (the resolved code), so chips/
    // history read true.
    tax_treatment: entry?.label_en || coding.tax_treatment || '',
    ...(splits ? { gb_vat_control: { ...controlAccount } } : {})
  };
};

// splitGbVatGross({ gross, code }) — pure arithmetic, never throws. A splitting
// domestic-rate code on a positive gross → { code, rate, direction, gross,
// net, vat }; anything else → null (the amount IS the base). vat = gross − net
// absorbs the rounding penny so net + vat == gross by construction (the
// journal builder VERIFIES this, it never recomputes it).
export const splitGbVatGross = ({ gross, code } = {}) => {
  const entry = resolveGbVatCode(code);
  if (!entry || !GB_VAT_SPLITTING_KINDS.has(entry.kind) || !(entry.rate > 0)) return null;
  if (entry.direction !== 'in' && entry.direction !== 'out') return null;
  const grossAmount = round2(gross);
  if (!(grossAmount > 0)) return null;
  const net = round2((grossAmount * 100) / (100 + entry.rate));
  const vat = round2(grossAmount - net);
  // Penny-level gross where the VAT share rounds to 0.00: at two-decimal
  // resolution the amount IS the base — post unsplit rather than hand the
  // journal builder a zero VAT leg it must refuse.
  if (!(net > 0) || !(vat > 0)) return null;
  return { code: entry.code, rate: entry.rate, direction: entry.direction, gross: grossAmount, net, vat };
};

// resolveGbVatSplitForPosting({ coding, transaction }) — the ONE derivation
// both the posting preview and the commit-time journal rebuild call (the
// resolveAlvSplitForPosting twin, same call shape so the two ride the same
// seam). Splits ONLY when the coding carries a resolved GB VAT code AND the
// `gb_vat_control` account applyGbVatCodingToCoding stamped (both can only
// get there under JURISDICTION_TAX_CODING for a gb client — every other
// client is byte-identical) AND the code's direction matches the
// transaction's. Returns the verifiedAlvSplit-consumable shape: { net, vat,
// role, controlAccount }.
export const resolveGbVatSplitForPosting = ({ coding = {}, transaction = {} } = {}) => {
  const code = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
  const entry = resolveGbVatCode(code);
  if (!entry) return null;
  const control = coding.gb_vat_control;
  if (!control || !String(control.code || '').trim()) return null;
  const direction = gbVatDirectionForTransaction(transaction, coding);
  if (!direction || entry.direction !== direction) return null;
  // The gross is the bank movement, whichever way it ran: a refund on the
  // purchase side splits its money in into the reversed net and input VAT.
  const gross = Number(transaction.money_in || 0) > 0 ? transaction.money_in : transaction.money_out;
  const split = splitGbVatGross({ gross: Math.abs(Number(gross || 0)), code });
  if (!split) return null;
  return {
    ...split,
    role: direction === 'in' ? GB_VAT_INPUT_ROLE : GB_VAT_OUTPUT_ROLE,
    controlAccount: { ...control }
  };
};
