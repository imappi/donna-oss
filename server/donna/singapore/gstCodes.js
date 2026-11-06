// SG-2 — Singapore GST rate set + tax-code vocabulary. Pure DATA + pure
// resolver, mirroring finland/alvCodes.js 1:1. This maps the strong coder's tax
// VERDICT to a Donna-native SG GST code — it does NOT re-decide the treatment
// (render-the-persisted-verdict / trust-the-strong-LLM: standard-vs-zero-vs-
// exempt-vs-reverse-charge is the model's judgment; this module only renders and
// box-maps it, and the deterministic F5 identities refuse a misfooted return).
//
// Singapore GST rates are DATE-EFFECTIVE: 7% through 2022-12-31, 8% during
// 2023 (first step of the two-step rate change), 9% from 2024-01-01. Both
// historical codes stay in the vocabulary permanently — time of supply decides
// (the rate-change transitional rules), and a 2023 document legitimately codes
// 8% after the cutover. The resolver renders the coder's rate verdict; it never
// re-decides a rate from a date.
//
// Shape of each entry (same as ALV_CODES):
//   { code, label_en, rate, direction, kind, return_boxes }
// - `direction` — 'out' (supply / sale), 'in' (purchase), or 'both'. Plain
//   accounting sense, same convention as alvCodes.js.
// - `kind` — 'standard' | 'zero' | 'exempt' | 'reverse_charge' | 'import' |
//   'import_scheme' | 'out_of_scope'.
// - `return_boxes` — which GST F5 boxes the code feeds and in what role:
//   `{ base, tax, deductible, scheme }`; base may be an array of box numbers.
//   `tax` on an input code is self-assessed output tax. Reverse charge has
//   conditional input recovery, never an automatic full-credit entitlement.
//   `requiresInputTaxAssessment` prevents the calculator assuming that credit
//   (reverse charge: recoverable share; import of goods: the permit amount, not
//   9% of a ledger expense).
//   `null` = not reported on the F5.

import { GST_ACCOUNT_CODES } from './sfrsChart.js';

// Provenance: SG_GST_RATES_BY_ERA['2024-01-01'] (section 16).
export const SG_STANDARD_RATE = 9;

// Date-effective standard rates. Transitional time-of-supply rules still
// determine which persisted rate applies; this table is not that classifier.
export const SG_GST_RATES_BY_ERA = Object.freeze({
  "2023-01-01": Object.freeze({
    "standard": 8,
    "confirmedAgainstPrimary": true,
    "url": "https://sso.agc.gov.sg/Act/GSTA1993#pr16-",
    "title": "Goods and Services Tax Act 1993 — section 16",
    "quote": "8% for the period from 1 January 2023 to 31 December 2023",
    "as_of": "2026-09-24",
    "source": "IRAS GST Rate Change for Consumers; statutory section 16 read live.",
    "iras_url": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-rate-change/gst-rate-change-for-consumers1"
  }),
  "2024-01-01": Object.freeze({
    "standard": 9,
    "confirmedAgainstPrimary": true,
    "url": "https://sso.agc.gov.sg/Act/GSTA1993#pr16-",
    "title": "Goods and Services Tax Act 1993 — section 16",
    "quote": "9% from and including 1 January 2024",
    "as_of": "2026-09-24",
    "source": "IRAS GST Rate Change for Consumers; statutory section 16 read live.",
    "iras_url": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-rate-change/gst-rate-change-for-consumers1"
  })
});

const ERA_STARTS = Object.keys(SG_GST_RATES_BY_ERA).sort();

// sgGstRateForDate(dateISO) — the standard rate in force on a date:
// { era, standard, confirmedAgainstPrimary, source, exact }. A date before the
// first era returns the first era with exact:false (the pre-2023 7 % rate is
// out of vocabulary by design — Donna's SG books start after it); an invalid/
// absent date resolves to the latest era (current law) with exact:false.
export const sgGstRateForDate = (dateISO) => {
  const d = String(dateISO || '').slice(0, 10);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(d);
  let era = valid ? ERA_STARTS[0] : ERA_STARTS[ERA_STARTS.length - 1];
  let exact = valid && d >= ERA_STARTS[0];
  if (valid) for (const start of ERA_STARTS) if (d >= start) era = start;
  return { era, exact, ...SG_GST_RATES_BY_ERA[era] };
};

// The coder-wiring flag. Config-plane stage (migration 042 pattern), read via
// clientFlagActs with envFallback () => false — never an env pair. Gates BOTH
// the coder's rich SG GST vocabulary and the posting-time GST code enrichment
// (applyGstCodingToCoding). Separate from SINGAPORE_GST_RETURN so coding can
// canary before any return is computed. NOTE the legacy default: an SG client
// WITHOUT this flag keeps today's simple vocabulary ('GST 9%' / 'No GST' /
// 'Out of scope' / 'GST check' — transactionLlm.js TAX_TREATMENT_OPTIONS) —
// byte-identical until the flag acts.
export const SINGAPORE_GST_CODING_FLAG_KEY = 'SINGAPORE_GST_CODING';

// The clientProfile.taxVocabulary marker firmDb threads to the coder when
// SINGAPORE_GST_CODING acts — transactionLlm routes its tax_treatment enum on
// it (the FI_ALV_TAX_VOCABULARY pattern).
export const SG_GST_TAX_VOCABULARY = 'sg_gst';

// The tax-treatment vocabulary the strong coder proposes from for a
// GST-registered Singapore client under SINGAPORE_GST_CODING. Each label is
// deliberately parsable by resolveGstCode below (the D-FI3-W2/W3 pattern: the
// treatment carries the rate/kind so the resolver renders, never re-decides).
// 'GST check' is the unsure marker — it maps to NO code, so the line posts
// uncoded and the uncoded-revenue blocker surfaces it. The legacy simple labels
// ('GST 9%', 'No GST', 'Out of scope') stay resolvable for continuity with the
// pre-vertical SG books.
export const SG_GST_TAX_TREATMENT_OPTIONS = [
  'GST 9%',
  'GST 8%',
  'Zero-rated (export / international services)',
  'Exempt supply',
  'Imported services (reverse charge)',
  'Import of goods (GST paid at import)',
  'Import under MES / approved scheme',
  'No GST (supplier not registered)',
  'Out of scope',
  'GST check'
];

export const SG_GST_TREATMENT_PROVENANCE = Object.freeze({
  "url": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst/completing-gst-returns",
  "title": "Completing GST Return",
  "quote": "taxable purchases",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": true,
  "source": "IRAS box mapping for an already established eligible treatment. Input claims require eligibility; import GST is the permit amount, not necessarily 9% of a ledger expense. Codes are Donna identifiers, not IRAS codes."
});

export const SG_GST_CODES = [
  // Standard-rated 9% (from 2024-01-01)
  { code: 'GST_SR_9_OUTPUT', label_en: 'Standard-rated supply 9%', rate: 9, direction: 'out', kind: 'standard', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: { base: '1', tax: '6' } },
  { code: 'GST_SR_9_INPUT', label_en: 'Standard-rated purchase 9%', rate: 9, direction: 'in', kind: 'standard', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: { base: '5', deductible: '7' } },
  // Standard-rated 8% (2023 era; kept — time of supply / rate-change
  // transitional rules legitimately code 8% after the cutover)
  { code: 'GST_SR_8_OUTPUT', label_en: 'Standard-rated supply 8% (2023)', rate: 8, direction: 'out', kind: 'standard', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: { base: '1', tax: '6' } },
  { code: 'GST_SR_8_INPUT', label_en: 'Standard-rated purchase 8% (2023)', rate: 8, direction: 'in', kind: 'standard', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: { base: '5', deductible: '7' } },
  // Zero-rated supplies — export of goods / international services (s.21(3))
  { code: 'GST_ZR_OUTPUT', label_en: 'Zero-rated supply (export / international services)', rate: 0, direction: 'out', kind: 'zero', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: { base: '2' } },
  // Exempt supplies — specified financial services / residential property /
  // investment precious metals / digital payment tokens (Fourth Schedule).
  // Zero here means no output tax, not the statutory zero-rated treatment.
  { code: 'GST_EXEMPT_OUTPUT', label_en: 'Exempt supply', rate: 0, direction: 'out', kind: 'exempt', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: { base: '3' } },
  // Import of goods with GST paid at import (claimable input tax)
  // GST on an import is the amount on the import permit, not 9% of the ledger expense, so the
  // input credit is never inferred: the return blocks (like reverse charge) until the permit
  // amount is persisted (SG-8, unbuilt).
  { code: 'GST_IMPORT_TAXABLE', label_en: 'Import of goods (GST paid at import)', rate: 9, direction: 'in', kind: 'import', provenance: SG_GST_TREATMENT_PROVENANCE, requiresInputTaxAssessment: true, return_boxes: { base: '5', deductible: '7' } },
  // Import under Major Exporter Scheme / other approved schemes — GST suspended;
  // the import value is reported (boxes 5 + 9), no tax moves.
  { code: 'GST_IMPORT_MES', label_en: 'Import under MES / approved scheme (GST suspended)', rate: 0, direction: 'in', kind: 'import_scheme', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: { base: '5', scheme: '9' } },
  // Imported services subject to reverse charge (RC business-to-business rules,
  // in force since 2020; LVG extension 2023). Self-assessed output tax + input
  // tax credit only to the extent recoverable under the input-tax rules.
  { code: 'GST_RC_IMPORTED_SERVICES', label_en: 'Imported services (reverse charge, self-assessed)', rate: 9, direction: 'in', kind: 'reverse_charge', provenance: { ...SG_GST_TREATMENT_PROVENANCE, section: 'Boxes 1, 5, 6, 7 and 14', quote: 'portion', source: 'Reverse-charge value in boxes 1, 5 and 14; output tax in 6; only recoverable input tax in 7. Calculator requires review until recovery is assessed.' }, requiresInputTaxAssessment: true, return_boxes: { base: ['1', '5', '14'], tax: '6', deductible: '7' } },
  // Purchase with no GST (supplier not GST-registered) — not reported on the F5.
  { code: 'GST_NO_GST_INPUT', label_en: 'Purchase with no GST (supplier not registered)', rate: 0, direction: 'in', kind: 'out_of_scope', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: null },
  // Out of scope (e.g. third-country sales); private use may instead trigger
  // deemed-supply rules, so it must not be blanket-classified out of scope.
  { code: 'GST_OUT_OF_SCOPE', label_en: 'Outside the scope of GST', rate: 0, direction: 'both', kind: 'out_of_scope', provenance: SG_GST_TREATMENT_PROVENANCE, return_boxes: null }
];

// ---------------------------------------------------------------------------------
// The GST F5 box vocabulary. `role` is what the box carries: 'tax' (output or
// self-assessed tax), 'deductible' (input tax), 'base' (a reported value, no
// tax), 'net' (the computed box 8), 'total' (the computed box 4), 'revenue'
// (box 13 — accounting revenue, independent of GST coding), 'scheme' (box 9 —
// imports under approved schemes, memo value).
//
// Numeric subset only: boxes 10-12, 15-17 and IGDS 18-21 are unsupported.
// The published return also has Yes/No answers for conditional boxes such as
// box 14. Confirming the represented boxes does not confirm filing coverage,
// the native wire envelope, or the calculator's tax-recovery assumptions.
export const GST_F5_BOX_PROVENANCE = Object.freeze({
  "url": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/filing-gst/completing-gst-returns",
  "title": "Completing GST Return",
  "quote": "Revenue",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": true,
  "source": "Represented boxes and identities confirmed. This is a partial numeric map, not a complete electronic F5 schema or confirmation of the aggregation/transport.",
  "scope": "Boxes 10-12, 15-17 and conditional IGDS 18-21 are outside this vocabulary. Box 14 is its value component; the official form also asks Yes/No."
});

export const GST_F5_BOXES = Object.freeze({
  1: { label_en: 'Total value of standard-rated supplies', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 1", quote: "standard-rated" }, role: 'base' },
  2: { label_en: 'Total value of zero-rated supplies', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 2", quote: "zero-rated" }, role: 'base' },
  3: { label_en: 'Total value of exempt supplies', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 3", quote: "exempt" }, role: 'base' },
  4: { label_en: 'Total value of boxes (1) + (2) + (3)', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 4", quote: "(1) + (2) + (3)" }, role: 'total' },
  5: { label_en: 'Total value of taxable purchases', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 5", quote: "taxable purchases" }, role: 'base' },
  6: { label_en: 'Output tax due', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 6", quote: "Output tax" }, role: 'tax' },
  7: { label_en: 'Input tax and refunds claimed', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 7", quote: "refunds claimed" }, role: 'deductible' },
  8: { label_en: 'Net GST to be paid to / (claimed from) IRAS', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 8", quote: "difference" }, role: 'net' },
  9: { label_en: 'Total value of goods imported under MES / approved schemes', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 9", quote: "MES" }, role: 'scheme' },
  13: { label_en: 'Revenue', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 13", quote: "Revenue" }, role: 'revenue' },
  14: { label_en: 'Value of imported services / LVG subject to reverse charge (Yes/No also required)', provenance: { ...GST_F5_BOX_PROVENANCE, section: "Box 14", quote: "reverse charge" }, role: 'base' }
});

// The box-4 identity: 4 = 1 + 2 + 3. The box-8 identity: 8 = 6 − 7. Both are
// deterministic F5 validation rules (KEEP-layer), not judgment.
export const GST_SUPPLY_BOXES_IN_4 = Object.freeze(['1', '2', '3']);

// The set of known SG GST codes — used to recognise a coder-supplied code that
// is ALREADY a real SG code (honour it verbatim).
export const KNOWN_SG_GST_CODES = new Set(SG_GST_CODES.map((e) => e.code));

const BY_CODE = new Map(SG_GST_CODES.map((e) => [e.code, e]));

// resolveGstEntry(code) — return the full descriptor for a code, or null.
export const resolveGstEntry = (code) => {
  if (code === null || code === undefined) return null;
  return BY_CODE.get(String(code).trim().toUpperCase()) || null;
};

// gstOutputCodeForRate(rate) — the domestic OUTPUT (supply) GST code for a rate,
// or null. Pure data lookup over the standard/zero output codes only. Rate 0
// resolves to GST_ZR_OUTPUT (a zero-rated supply is reported in box 2, never
// uncoded revenue). Never throws.
export const gstOutputCodeForRate = (rate) => {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const entry = SG_GST_CODES.find((e) => e.direction === 'out'
    && (e.kind === 'standard' || e.kind === 'zero')
    && Number(e.rate) === r);
  return entry ? entry.code : null;
};

// Normalize free-text direction into the accounting sense.
const normalizeDirection = (direction = '') => {
  const d = String(direction || '').trim().toLowerCase();
  if (['out', 'output', 'sale', 'sales', 'supply', 'supplies'].includes(d)) return 'out';
  if (['in', 'input', 'purchase', 'purchases', 'buy'].includes(d)) return 'in';
  return '';
};

const normalizeText = (value = '') => String(value || '').trim().toLowerCase();

// resolveGstCode({ taxType, taxTreatment, direction }) — mirror resolveAlvCode's
// precedence: an explicit, real SG code wins; else the prose `tax_treatment` is
// mapped; unknown → '' so the caller leaves the line uncoded (the blockers
// surface it). This plumbs the model's decision to a code — never re-decides it.
//
// The LEGACY simple vocabulary stays first-class: 'GST 9%' (the pre-vertical
// default treatment), 'No GST', 'Out of scope' all resolve — continuity for
// every existing SG book. 'GST check' (the unsure marker) maps to NO code.
export const resolveGstCode = ({ taxType = '', taxTreatment = '', direction = '' } = {}) => {
  const explicit = String(taxType || '').trim().toUpperCase();
  if (explicit && KNOWN_SG_GST_CODES.has(explicit)) return explicit;

  const treatment = normalizeText(taxTreatment);
  if (!treatment) return '';

  const dir = normalizeDirection(direction);
  const isSale = dir === 'out';
  const isPurchase = dir === 'in';

  // The unsure marker: never a code (checked FIRST so 'GST check' can't fall
  // into the rate matcher below).
  if (/gst\s*check/.test(treatment)) return '';

  // Imported services under reverse charge — the most specific signal first.
  if (/(reverse\s*charge|imported\s*services|imported\s*service|\brc\b)/.test(treatment)) {
    return 'GST_RC_IMPORTED_SERVICES';
  }
  // Import under MES / approved scheme (GST suspended).
  if (/(mes\b|major\s*exporter|approved\s*scheme|import\s*gst\s*suspen)/.test(treatment)) {
    return 'GST_IMPORT_MES';
  }
  // Import of goods with GST paid at import.
  if (/(import)/.test(treatment)) return 'GST_IMPORT_TAXABLE';
  // Zero-rated — exports / international services.
  if (/(zero[- ]?rated|export|international\s*service)/.test(treatment)) return 'GST_ZR_OUTPUT';
  // Exempt supplies.
  if (/(exempt)/.test(treatment)) return 'GST_EXEMPT_OUTPUT';
  // Purchases from non-registered suppliers.
  if (/(no\s*gst|supplier\s*not\s*(gst[- ]?)?registered|not\s*registered)/.test(treatment)) {
    return 'GST_NO_GST_INPUT';
  }
  // Out of scope / not subject.
  if (/(out\s*of\s*scope|not\s*subject|not\s*applicable)/.test(treatment)) return 'GST_OUT_OF_SCOPE';

  // Rate-carrying prose ('GST 9%' / 'GST 8%') — the legacy default treatment
  // included. Direction picks the side; an unknown direction returns '' (never
  // guess which side of the return a rate lands on).
  const rated = treatment.match(/(?:gst|vat)\s*(9|8)\s*%?/);
  if (rated) {
    if (!isSale && !isPurchase) return '';
    const suffix = isSale ? 'OUTPUT' : 'INPUT';
    return `GST_SR_${rated[1]}_${suffix}`;
  }

  return '';
};

// gstDirectionForTransaction(transaction) — the plain accounting direction of a
// bank transaction for GST purposes: money IN is a supply ('out' in this
// module's convention), money OUT is a purchase ('in'). Same convention as
// alvDirectionForTransaction.
export const gstDirectionForTransaction = (transaction = {}) => {
  if (Number(transaction?.money_in || 0) > 0) return 'out';
  if (Number(transaction?.money_out || 0) > 0) return 'in';
  return '';
};

// applyGstCodingToCoding({ coding, transaction }) — the posting-preview
// enrichment for a GST-registered Singapore client under SINGAPORE_GST_CODING
// (the applyAlvCodingToCoding twin). Renders the coder's persisted tax verdict
// to a Donna-native GST code and stamps it where the journal builder already
// reads — so the code reaches ledger_lines.tax_type with ZERO changes to the
// isolation-listed writers. Unresolvable verdicts ('GST check', unknown prose,
// unknown direction) leave the coding untouched: the line posts uncoded and
// the return engine's blockers surface it.
export const applyGstCodingToCoding = ({ coding = {}, transaction = {} } = {}) => {
  // A coding that TARGETS a GST control account (the IRAS settlement's DR 2950,
  // or a manual clearing entry) must never carry a GST code — a code resting on
  // a control account is exactly the incompatible-line blocker. Same posture as
  // the split's control leg: tax_type 'NONE'.
  const targetAccountCode = String(coding.xero_account_code || coding.account_code || '').trim();
  if (GST_ACCOUNT_CODES.has(targetAccountCode)) {
    return { ...coding, tax_type: 'NONE', xero_tax_type: 'NONE' };
  }
  const code = resolveGstCode({
    taxType: coding.tax_type || coding.xero_tax_type || '',
    taxTreatment: coding.tax_treatment || '',
    direction: gstDirectionForTransaction(transaction)
  });
  if (!code) return coding;
  const entry = resolveGstEntry(code);
  return {
    ...coding,
    tax_type: code,
    xero_tax_type: code,
    // Label reflects what is ACTUALLY posted (the resolved code) so chips/
    // history read true.
    tax_treatment: entry?.label_en || coding.tax_treatment || ''
  };
};

// ---------------------------------------------------------------------------------
// The GST split-posting convention (the D-FI3-S1..S3 twin).
// ---------------------------------------------------------------------------------
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// The two in-period GST control accounts (sfrsChart 2950/2951) + the line ROLE
// each split leg carries. The role is the cross-check's persisted handle (it
// rides ledger_lines.payload.role); the control leg itself carries tax_type
// 'NONE' — the GST code stays on the BASE line only, so the "no GST code on a
// control account" invariant keeps holding.
export const GST_SPLIT_CONTROL = Object.freeze({
  in: Object.freeze({
    role: 'gst_input_claimable',
    account: Object.freeze({ code: '2951', name: 'GST input tax claimable', account_type: 'liability', normal_balance: 'debit' })
  }),
  out: Object.freeze({
    role: 'gst_output',
    account: Object.freeze({ code: '2950', name: 'GST output tax payable', account_type: 'liability', normal_balance: 'credit' })
  })
});

// The account the IRAS settlement payment clears: the SAME 2950 the output
// splits credit (DR 2950 / CR bank; a refund FROM IRAS is the mirror image).
export const SINGAPORE_GST_SETTLEMENT_ACCOUNT = GST_SPLIT_CONTROL.out.account;

// Union helper for the account universe / coder menu of a GST-coding client:
// ensure the canonical settlement account row is present (by code or normalized
// name) without duplicating a chart row a prior post already minted. Mirrors
// withFinlandAlvSettlementAccount exactly, including the in-memory code
// backfill for a name-matched code-less historical row.
export const withSingaporeGstSettlementAccount = (ledgerAccounts = []) => {
  const rows = Array.isArray(ledgerAccounts) ? ledgerAccounts : [];
  const settlementName = SINGAPORE_GST_SETTLEMENT_ACCOUNT.name.toLowerCase();
  const codeOf = (account) => String(account?.code || account?.account_code || '').trim();
  const nameMatches = (account) =>
    String(account?.name || account?.account_name || '').trim().toLowerCase() === settlementName;
  if (rows.some((account) => codeOf(account) === SINGAPORE_GST_SETTLEMENT_ACCOUNT.code)) return rows;
  if (rows.some(nameMatches)) {
    return rows.map((account) => (nameMatches(account) && !codeOf(account)
      ? {
        ...account,
        code: SINGAPORE_GST_SETTLEMENT_ACCOUNT.code,
        account_type: account.account_type || SINGAPORE_GST_SETTLEMENT_ACCOUNT.account_type,
        normal_balance: account.normal_balance || SINGAPORE_GST_SETTLEMENT_ACCOUNT.normal_balance
      }
      : account));
  }
  return [...rows, { ...SINGAPORE_GST_SETTLEMENT_ACCOUNT, status: 'active', source: 'singapore_sfrs_chart' }];
};

// The kinds that split a GROSS amount into net base + GST: the domestic
// standard-rated codes only. Zero/exempt/out-of-scope carry no GST in the
// price; imports and reverse-charge purchases are billed NET (their tax is
// self-assessed on the return / paid at the border, deliberately NOT split in
// v1 — the D-FI3-S1 posture).
const GST_SPLITTING_KINDS = new Set(['standard']);

// splitGstGross({ gross, code }) — pure arithmetic, never throws. A splitting
// standard-rated code on a positive gross → { code, rate, direction, gross,
// net, gst, role, controlAccount }; anything else → null (the amount IS the
// base). gst = gross − net absorbs the rounding cent, so net + gst == gross by
// construction (the journal builders VERIFY this, they never recompute it).
export const splitGstGross = ({ gross, code } = {}) => {
  const entry = resolveGstEntry(code);
  if (!entry || !GST_SPLITTING_KINDS.has(entry.kind) || !(entry.rate > 0)) return null;
  if (entry.direction !== 'in' && entry.direction !== 'out') return null;
  const grossAmount = round2(gross);
  if (!(grossAmount > 0)) return null;
  const net = round2((grossAmount * 100) / (100 + entry.rate));
  const gst = round2(grossAmount - net);
  // Cent-level gross where the GST share rounds to 0.00: at two-decimal
  // resolution the amount IS the base — post unsplit rather than hand the
  // journal builder a zero tax leg it must refuse.
  if (!(net > 0) || !(gst > 0)) return null;
  const control = GST_SPLIT_CONTROL[entry.direction];
  return {
    code: entry.code,
    rate: entry.rate,
    direction: entry.direction,
    gross: grossAmount,
    net,
    gst,
    role: control.role,
    controlAccount: { ...control.account }
  };
};

// resolveGstSplitForPosting({ coding, transaction }) — the ONE derivation both
// the posting preview and the commit-time journal build call (the D-FI3-S2
// twin: the journal is REBUILT from the coding at commit, so deriving the split
// from the same coding object keeps preview and post consistent by
// construction). Splits ONLY when the coding already carries a resolved SG GST
// code (which can only get there via applyGstCodingToCoding under
// SINGAPORE_GST_CODING) AND the code's direction matches the transaction's.
export const resolveGstSplitForPosting = ({ coding = {}, transaction = {} } = {}) => {
  const code = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
  const entry = resolveGstEntry(code);
  if (!entry) return null;
  const direction = gstDirectionForTransaction(transaction);
  if (!direction || entry.direction !== direction) return null;
  const gross = direction === 'in' ? transaction.money_out : transaction.money_in;
  return splitGstGross({ gross: Math.abs(Number(gross || 0)), code });
};
