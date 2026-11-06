// FI-2 — Finnish ALV (VAT) rate set + tax-code vocabulary. Pure DATA + pure
// resolver, mirroring the shape/precedence of `xeroAccountMatcher.js`'s
// `TAX_TYPE_LABELS` / `resolveCoderTaxType` but as a standalone FI module so the
// SG matcher is untouched. This maps the strong coder's tax VERDICT to a Donna-
// native FI ALV code — it does NOT re-decide the rate (render-the-persisted-
// verdict). Wiring these codes into a jurisdiction-routed coder path is a later
// slice; this ships the vocabulary + resolver only.
//
// Finnish rates are DATE-EFFECTIVE (FI-15 G-1, docs/design-donna-finland-g1-alv-
// rate-table.md): standard 25.5% since 2024-09-01 (raised from 24%); reduced-1
// 14% through 2025-12-31 and 13.5% from 2026-01-01 (time of supply decides —
// goods delivered / services performed / advance payments received before 2026
// stay 14%); reduced-2 10% (newspapers/periodicals only since the 2025 scope
// reform); plus 0%/exempt/reverse-charge/EU treatments. Both reduced-1 codes
// stay in the vocabulary permanently — the resolver renders the coder's rate
// verdict, it never re-decides a rate from a date.
//
// Shape of each entry:
//   { code, label_fi, label_en, rate, direction, kind }
// - `code`      — Donna-native FI ALV code (the internal ledger is the book of
//                 record now, so these are ours, not a foreign system's codes).
// - `rate`      — the ALV percentage as a number (0 for 0%/exempt/out-of-scope;
//                 null for 'blocked', which claims no rate — see its entry).
// - `direction` — 'out' (myynti / output / sale), 'in' (osto / input / purchase),
//                 or 'both'. NOTE: this is the plain accounting sense (output =
//                 sale), deliberately NOT the SG matcher's inverted `direction`
//                 convention — a standalone module reads clearer with the obvious
//                 meaning. `resolveAlvCode` normalizes many spellings.
// - `kind`      — coarse class for grouping: 'standard' | 'reduced' | 'zero' |
//                 'exempt' | 'reverse_charge' | 'eu' | 'out_of_scope' | 'import' |
//                 'blocked' (non-deductible input VAT — GB's VAT_BLOCKED_INPUT twin).
// - `return_boxes` — FI-3: which ALV-return fields (VSRALVKV) the code feeds and
//                 in what role: `{ base, tax, deductible }`, each a field number
//                 string or absent. `tax` on an input-direction code means
//                 SELF-ASSESSED output tax (EU acquisition / import / reverse
//                 charge) — such codes also carry `deductible: '307'` under the
//                 v1 full-deduction-right default (D-FI3-A2,
//                 docs/design-donna-finland-fi3-alv-return.md). `null` = the
//                 code is not reported on the return (exempt / out-of-scope).

import { ALV_ACCOUNT_CODES } from './tilikartta.js';
import { ledgerAccountTypeFor } from '../ledger.js';

export const FI_STANDARD_RATE = 25.5;

// FI-15 G-1 — the date-effective rate table (FI-11's by-year pattern:
// effective-from keyed rows, per-row provenance). `confirmedAgainstPrimary`
// stays FALSE until follow-up F-G1-V re-confirms the rows byte-level against
// the Arvonlisäverolaki / vero.fi primaries from a network-open session (the
// 2026 row is search-extraction grade: vero.fi newsroom title + parliament
// approval via multiple independent secondaries, 2026-07-11 — same evidence
// tier as ALV_RETURN_BOX_PROVENANCE below). The pin test trips CI on any
// silent rate edit either way.
export const FI_ALV_RATES_BY_ERA = Object.freeze({
  '2024-09-01': Object.freeze({
    standard: 25.5,
    reduced: Object.freeze([14, 10]),
    confirmedAgainstPrimary: false,
    source: 'Arvonlisäverolaki: standard 24 → 25.5 % effective 2024-09-01; reduced 14/10 unchanged. Search extraction 2026-07-11; primary fetch blocked (F-G1-V)'
  }),
  '2026-01-01': Object.freeze({
    standard: 25.5,
    reduced: Object.freeze([13.5, 10]),
    confirmedAgainstPrimary: false,
    source: 'Reduced-1 14 → 13.5 % effective 2026-01-01 (parliament-approved; time of supply decides, pre-2026 advance payments stay 14 %); Yle broadcasting 10 → 13.5 % (scope, not encoded); 10 % remains for newspapers/periodicals. vero.fi newsroom + Marosa/vatcalc/BDO/Svalner via search extraction 2026-07-11; primary fetch blocked (F-G1-V)'
  })
});

const ERA_STARTS = Object.keys(FI_ALV_RATES_BY_ERA).sort();

// fiAlvRateSetForDate(dateISO) — the rate set in force on a date:
// { era, standard, reduced, confirmedAgainstPrimary, source, exact }. A date
// before the first era returns the first era with exact:false (the pre-2024-09
// 24 % standard rate is out of vocabulary by design); an invalid/absent date
// resolves to the latest era (current law) with exact:false.
export const fiAlvRateSetForDate = (dateISO) => {
  const d = String(dateISO || '').slice(0, 10);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(d);
  let era = valid ? ERA_STARTS[0] : ERA_STARTS[ERA_STARTS.length - 1];
  let exact = valid && d >= ERA_STARTS[0];
  if (valid) for (const start of ERA_STARTS) if (d >= start) era = start;
  return { era, exact, ...FI_ALV_RATES_BY_ERA[era] };
};

// FI-3 slice W — the coder-wiring flag. Config-plane stage (migration 042
// pattern), read via clientFlagActs with envFallback () => false — never an env
// pair. Gates BOTH the coder's Finnish tax vocabulary and the posting-time ALV
// code enrichment (applyAlvCodingToCoding). Separate from FINLAND_ALV_RETURN so
// coding can canary before any return is computed.
export const FINLAND_ALV_CODING_FLAG_KEY = 'FINLAND_ALV_CODING';

// The clientProfile.taxVocabulary marker firmDb threads to the coder when
// FINLAND_ALV_CODING acts — transactionLlm routes its tax_treatment enum on it.
export const FI_ALV_TAX_VOCABULARY = 'fi_alv';
// The coder's unsure marker — maps to NO code, ever (see FI_ALV_TAX_TREATMENT_OPTIONS).
export const FI_ALV_UNSURE_MARKER = 'ALV-tarkistus';

// FI-3 slice W (D-FI3-W2) — the tax-treatment vocabulary the strong coder
// proposes from for an ALV-registered Finnish client. Mirrors the SG
// TAX_TREATMENT_OPTIONS role (schema enum + chat menu), but each label is
// deliberately parsable by resolveAlvCode below: the treatment carries the rate
// because the FI chart has no per-account default rate to fall back to
// (D-FI3-W3). 'ALV-tarkistus' is the unsure marker — it maps to NO code, so the
// line posts uncoded and the D-FI3-A4 uncoded-revenue blocker surfaces it.
export const FI_ALV_TAX_TREATMENT_OPTIONS = [
  'ALV 25,5 %',
  'ALV 13,5 %',
  'ALV 14 %',
  'ALV 10 %',
  'ALV 0 % / vienti',
  'Veroton toiminta (ALV-vapaa)',
  'EU-tavaramyynti',
  'EU-palvelumyynti',
  'EU-tavaraosto',
  'EU-palveluosto',
  'Maahantuonti EU:n ulkopuolelta',
  'Rakennusalan käännetty ALV',
  // FIK-V (docs/plan-2026-09-22-fi-jev-decision-knowledge.md §8): a purchase
  // whose charged ALV the client may not deduct. Without it the only
  // expressible verdicts were a rate (a wrong 307 deduction), 'Ei
  // ALV-käsittelyä' (relabelling a taxed purchase out of scope) or the unsure
  // marker (a stall). WHICH purchases qualify is knowledge, not vocabulary —
  // reviewed guidance for it is FIK-1's, never encoded here.
  'Vähennyskelvoton ALV (osto)',
  'Ei ALV-käsittelyä',
  'ALV-tarkistus'
];

export const ALV_CODES = [
  // Standard-rated 25.5%
  { code: 'ALV_25_5_OUTPUT', label_fi: 'Myynti, yleinen verokanta 25,5 %', label_en: 'Sales, standard rate 25.5%', rate: 25.5, direction: 'out', kind: 'standard', return_boxes: { tax: '301' } },
  { code: 'ALV_25_5_INPUT', label_fi: 'Osto, yleinen verokanta 25,5 %', label_en: 'Purchase, standard rate 25.5%', rate: 25.5, direction: 'in', kind: 'standard', return_boxes: { deductible: '307' } },
  // Reduced-rated 13.5% (reduced-1 from 2026-01-01; G-1)
  { code: 'ALV_13_5_OUTPUT', label_fi: 'Myynti, alennettu verokanta 13,5 %', label_en: 'Sales, reduced rate 13.5%', rate: 13.5, direction: 'out', kind: 'reduced', return_boxes: { tax: '302' } },
  { code: 'ALV_13_5_INPUT', label_fi: 'Osto, alennettu verokanta 13,5 %', label_en: 'Purchase, reduced rate 13.5%', rate: 13.5, direction: 'in', kind: 'reduced', return_boxes: { deductible: '307' } },
  // Reduced-rated 14% (reduced-1 through 2025-12-31; kept — time of supply
  // legitimately codes 14% after the cutover: pre-2026 supplies/advances)
  { code: 'ALV_14_OUTPUT', label_fi: 'Myynti, alennettu verokanta 14 %', label_en: 'Sales, reduced rate 14%', rate: 14, direction: 'out', kind: 'reduced', return_boxes: { tax: '302' } },
  { code: 'ALV_14_INPUT', label_fi: 'Osto, alennettu verokanta 14 %', label_en: 'Purchase, reduced rate 14%', rate: 14, direction: 'in', kind: 'reduced', return_boxes: { deductible: '307' } },
  // Reduced-rated 10%
  { code: 'ALV_10_OUTPUT', label_fi: 'Myynti, alennettu verokanta 10 %', label_en: 'Sales, reduced rate 10%', rate: 10, direction: 'out', kind: 'reduced', return_boxes: { tax: '303' } },
  { code: 'ALV_10_INPUT', label_fi: 'Osto, alennettu verokanta 10 %', label_en: 'Purchase, reduced rate 10%', rate: 10, direction: 'in', kind: 'reduced', return_boxes: { deductible: '307' } },
  // Zero-rated (exports outside EU / 0% supplies)
  { code: 'ALV_0_OUTPUT', label_fi: 'Veroton myynti / vienti 0 %', label_en: 'Zero-rated sales / export 0%', rate: 0, direction: 'out', kind: 'zero', return_boxes: { base: '309' } },
  // Exempt (veroton toiminta — healthcare, financial, insurance, education)
  { code: 'ALV_EXEMPT', label_fi: 'Veroton toiminta (ALV-vapaa)', label_en: 'Exempt activity (no ALV)', rate: 0, direction: 'both', kind: 'exempt', return_boxes: null },
  // Reverse charge (käännetty verovelvollisuus — rakennusala / construction)
  { code: 'ALV_REVERSE_CHARGE_SALES', label_fi: 'Rakennusalan käännetty ALV, myynti', label_en: 'Construction reverse charge, sale', rate: 0, direction: 'out', kind: 'reverse_charge', return_boxes: { base: '319' } },
  { code: 'ALV_REVERSE_CHARGE_PURCHASE', label_fi: 'Rakennusalan käännetty ALV, osto', label_en: 'Construction reverse charge, purchase (self-assessed)', rate: 25.5, direction: 'in', kind: 'reverse_charge', return_boxes: { base: '320', tax: '318', deductible: '307' } },
  // EU intra-community — goods
  { code: 'ALV_EU_SUPPLY', label_fi: 'Tavaran yhteisömyynti 0 %', label_en: 'Intra-EU supply of goods 0%', rate: 0, direction: 'out', kind: 'eu', return_boxes: { base: '311' } },
  { code: 'ALV_EU_ACQUISITION', label_fi: 'Tavaran yhteisöhankinta (käännetty)', label_en: 'Intra-EU acquisition of goods (self-assessed)', rate: 25.5, direction: 'in', kind: 'eu', return_boxes: { base: '313', tax: '305', deductible: '307' } },
  // EU intra-community — services (FI-3: the return reports services separately)
  { code: 'ALV_EU_SERVICE_SUPPLY', label_fi: 'Palvelun myynti muihin EU-maihin 0 %', label_en: 'Intra-EU supply of services 0%', rate: 0, direction: 'out', kind: 'eu', return_boxes: { base: '312' } },
  { code: 'ALV_EU_SERVICE_ACQUISITION', label_fi: 'Palveluosto muista EU-maista (käännetty)', label_en: 'Intra-EU purchase of services (self-assessed)', rate: 25.5, direction: 'in', kind: 'eu', return_boxes: { base: '314', tax: '306', deductible: '307' } },
  // Import of goods from outside the EU (maahantuonti — self-assessed since 2018)
  { code: 'ALV_IMPORT', label_fi: 'Tavaran maahantuonti EU:n ulkopuolelta (käännetty)', label_en: 'Import of goods from outside the EU (self-assessed)', rate: 25.5, direction: 'in', kind: 'import', return_boxes: { base: '310', tax: '304', deductible: '307' } },
  // Non-deductible input VAT (FIK-V; kind 'blocked', GB VAT_BLOCKED_INPUT's
  // twin). The VAT is real but the client has no deduction right, so there is
  // no split, no 2940 control leg and no 307 entry: the gross stays in the
  // expense (or asset) line, which is the accounting reality. VSRALVKV has no
  // field for domestic purchases, so the code is not reported (return_boxes
  // null) — but it is a CODED verdict, unlike an uncoded expense, and it is
  // input-only, unlike ALV_OUT_OF_SCOPE. `rate` is null by design: the charged
  // rate is the source's fact, never a deduction this code claims, so every
  // rate-gated guard (evidence-for-deduction, whole-document rate conflict,
  // stated-VAT arithmetic, component split) correctly stands aside.
  // Self-assessed purchases (EU, import, reverse charge) with a restricted
  // deduction are NOT this code: their output tax is still due, so the
  // resolver refuses that combination instead of dropping the tax.
  { code: 'ALV_NONDEDUCTIBLE_INPUT', label_fi: 'Osto, vähennyskelvoton arvonlisävero', label_en: 'Purchase, non-deductible VAT (no deduction)', rate: null, direction: 'in', kind: 'blocked', return_boxes: null },
  // Out of scope (ALV:n soveltamisalan ulkopuolella)
  { code: 'ALV_OUT_OF_SCOPE', label_fi: 'ALV:n soveltamisalan ulkopuolella', label_en: 'Outside the scope of ALV', rate: 0, direction: 'both', kind: 'out_of_scope', return_boxes: null }
];

// ---------------------------------------------------------------------------------
// FI-3 — the ALV-return field vocabulary (Veroilmoitus oma-aloitteisista veroista,
// arvonlisäveron tiedot / VSRALVKV). `role` is what the field carries: 'tax'
// (output or self-assessed tax), 'deductible' (input tax), 'base' (a reported
// value, no tax), 'net' (the computed 308). Field 317 (alarajahuojennus) was
// abolished for periods from 2025 and is deliberately NOT encoded.
//
// Provenance: field numbers, labels, and the 308 identity cross-confirmed
// 2026-07-10 against the Verohallinto VSRALVKV record description (27.2.2026
// revision) + vero.fi completion instructions via search extraction and two
// secondary sources (Procountor, Netvisor docs). The container's network policy
// blocked a direct byte-level read of the primary PDF, so
// `confirmedAgainstPrimary` stays FALSE until follow-up F-FI3-1 re-confirms from
// a network-open session (see docs/design-donna-finland-fi3-alv-return.md). The
// pin-test trips CI on any silent edit either way.
export const ALV_RETURN_BOX_PROVENANCE = Object.freeze({
  confirmedAgainstPrimary: false,
  source: 'Verohallinto tietuekuvaus VSRALVKV (27.2.2026) + vero.fi täyttöohje, via search extraction 2026-07-10; primary fetch blocked by network policy (F-FI3-1)'
});

export const ALV_RETURN_BOXES = Object.freeze({
  301: { label_fi: 'Vero kotimaan myynnistä verokannoittain — yleinen verokanta 25,5 %', role: 'tax' },
  // G-1: era-neutral label — both reduced-1 rates (14 % through 2025, 13,5 %
  // from 2026) report in field 302; per-code tax stays computed per rate.
  302: { label_fi: 'Vero kotimaan myynnistä verokannoittain — alennettu verokanta 14 % / 13,5 %', role: 'tax' },
  303: { label_fi: 'Vero kotimaan myynnistä verokannoittain — alennettu verokanta 10 %', role: 'tax' },
  304: { label_fi: 'Vero tavaroiden maahantuonnista EU:n ulkopuolelta', role: 'tax' },
  305: { label_fi: 'Vero tavaraostoista muista EU-maista', role: 'tax' },
  306: { label_fi: 'Vero palveluostoista muista EU-maista', role: 'tax' },
  307: { label_fi: 'Kohdekauden vähennettävä vero', role: 'deductible' },
  308: { label_fi: 'Maksettava vero / Palautukseen oikeuttava vero (−)', role: 'net' },
  309: { label_fi: '0-verokannan alainen liikevaihto', role: 'base' },
  310: { label_fi: 'Tavaroiden maahantuonnit EU:n ulkopuolelta', role: 'base' },
  311: { label_fi: 'Tavaroiden myynnit muihin EU-maihin', role: 'base' },
  312: { label_fi: 'Palveluiden myynnit muihin EU-maihin', role: 'base' },
  313: { label_fi: 'Tavaraostot muista EU-maista', role: 'base' },
  314: { label_fi: 'Palveluostot muista EU-maista', role: 'base' },
  318: { label_fi: 'Vero rakentamispalvelun ja metalliromun ostoista (käännetty verovelvollisuus)', role: 'tax' },
  319: { label_fi: 'Rakentamispalvelun ja metalliromun myynnit', role: 'base' },
  320: { label_fi: 'Rakentamispalvelun ja metalliromun ostot', role: 'base' }
});

// The 308 identity: payable = sum of these tax fields − 307. A deterministic
// KEEP-layer rule (VSRALVKV validation), not a judgment.
export const ALV_TAX_FIELDS_IN_308 = Object.freeze(['301', '302', '303', '304', '305', '306', '318']);

// The set of known FI ALV codes — used to recognise a coder-supplied code that is
// ALREADY a real FI code (honour it verbatim), mirroring KNOWN_TAX_TYPE_CODES.
export const KNOWN_ALV_CODES = new Set(ALV_CODES.map((e) => e.code));

const BY_CODE = new Map(ALV_CODES.map((e) => [e.code, e]));

// resolveAlvEntry(code) — return the full descriptor for a code, or null.
export const resolveAlvEntry = (code) => {
  if (code === null || code === undefined) return null;
  return BY_CODE.get(String(code).trim().toUpperCase()) || null;
};

// alvOutputCodeForRate(rate) — the domestic OUTPUT (myynti) ALV code for a rate,
// or null if the rate is not a domestic-rate output code in the vocabulary. Pure
// data lookup over the standard/reduced/zero output codes only (an EU/reverse-
// charge/import code is never a plain domestic rate) — the sales-invoice journal
// builder consumes this to code each per-rate revenue leg so the ALV-return
// base-code walk sees the sale; an unmapped positive rate makes the caller REFUSE
// (typed), never guess a code. Rate 0 resolves to ALV_0_OUTPUT (a zero-rated
// sale is reported, not uncoded revenue). Never throws.
export const alvOutputCodeForRate = (rate) => {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const entry = ALV_CODES.find((e) => e.direction === 'out'
    && (e.kind === 'standard' || e.kind === 'reduced' || e.kind === 'zero')
    && Number(e.rate) === r);
  return entry ? entry.code : null;
};

// Normalize free-text direction into the accounting sense. 'out'/sale/output/
// myynti → out; 'in'/purchase/input/osto → in; anything else → '' (unknown).
const normalizeDirection = (direction = '') => {
  const d = String(direction || '').trim().toLowerCase();
  if (['out', 'output', 'sale', 'sales', 'supply', 'myynti'].includes(d)) return 'out';
  if (['in', 'input', 'purchase', 'buy', 'osto', 'hankinta'].includes(d)) return 'in';
  return '';
};

const normalizeText = (value = '') => String(value || '').trim().toLowerCase();

// resolveAlvCode({ taxType, taxTreatment, direction }) — mirror
// resolveCoderTaxType's precedence: an explicit, real FI code wins; else the prose
// `tax_treatment` is mapped; standard/taxable/unknown → '' so the caller falls
// back to the account's default rate (which carries the standard rate). This
// plumbs the model's decision to a code — it does not re-decide it.
//
// Direction only disambiguates output vs input where the treatment is
// direction-sensitive (reverse charge, EU). When direction is unknown, the
// resolver picks the OUTPUT/supply variant for sale-shaped treatments and the
// self-assessed INPUT variant for acquisition-shaped ones, matching how the SG
// resolver defaults.
export const resolveAlvCode = ({ taxType = '', taxTreatment = '', direction = '' } = {}) => {
  const explicit = String(taxType || '').trim().toUpperCase();
  if (explicit && KNOWN_ALV_CODES.has(explicit)) return explicit;

  const treatment = normalizeText(taxTreatment);
  if (!treatment) return '';

  const dir = normalizeDirection(direction);
  const isSale = dir === 'out';
  const isPurchase = dir === 'in';

  // FIK-V — non-deductible input VAT, checked FIRST: the marker overrides any
  // rate the prose also names ('ALV 25,5 %, vähennyskelvoton' claims nothing).
  // Purchase side only (a sale has no input deduction to deny — never guess).
  // Combined with a self-assessed treatment it resolves to nothing: an EU
  // acquisition, import or reverse charge still owes its output tax, and this
  // code would silently drop it.
  if (/(v[aä]hennyskelvoton|ei v[aä]hennyskelpoinen|non[- ]?deductible|not deductible|no deduction|blocked input)/.test(treatment)) {
    if (/(yhteis[oö]|intra[- ]?(community|eu)|\beu\b|eu[- ]|maahantuonti|import|k[aä]{2}nnett|reverse\s*charge|rakennusala)/.test(treatment)) return '';
    return isPurchase ? 'ALV_NONDEDUCTIBLE_INPUT' : '';
  }

  // EU intra-community supply / acquisition — checked BEFORE reverse charge:
  // EU self-assessment prose routinely says "käännetty" too (FI-2's own label is
  // 'Tavaran yhteisöhankinta (käännetty)'), and the EU markers are the more
  // specific signal. Services report on their own return fields (312/314/306),
  // so the prose fork carries goods vs services.
  if (/(yhteis[oö]|intra[- ]?community|intra[- ]?eu|eu[- ]?ma(ihin|ista)|eu[- ]?(tavara|palvelu)|eu\s*(supply|acquisition|sale|purchase|service))/.test(treatment)) {
    const isService = /palvelu|service/.test(treatment);
    if (isPurchase || /hankinta|acquisition|purchase|osto/.test(treatment)) {
      return isService ? 'ALV_EU_SERVICE_ACQUISITION' : 'ALV_EU_ACQUISITION';
    }
    return isService ? 'ALV_EU_SERVICE_SUPPLY' : 'ALV_EU_SUPPLY';
  }
  // Import of goods from outside the EU (self-assessed import VAT).
  if (/(maahantuonti|import)/.test(treatment)) return 'ALV_IMPORT';
  // Reverse charge (käännetty verovelvollisuus / construction).
  if (/(k[aä]{2}nnett|reverse\s*charge|rakennusala)/.test(treatment)) {
    if (isSale) return 'ALV_REVERSE_CHARGE_SALES';
    if (isPurchase) return 'ALV_REVERSE_CHARGE_PURCHASE';
    return 'ALV_REVERSE_CHARGE_PURCHASE'; // self-assessment is the material side
  }
  // Zero-rated / export.
  if (/(zero\s*rated|nolla|vienti|export|veroton myynti)/.test(treatment)) return 'ALV_0_OUTPUT';
  // Exempt activity.
  if (/(exempt|alv-?vapaa|veroton toiminta)/.test(treatment)) return 'ALV_EXEMPT';
  // Out of scope / not subject / not registered.
  if (/(out of scope|soveltamisalan ulkopuolella|not subject|not applicable|not registered|ei alv)/.test(treatment)) return 'ALV_OUT_OF_SCOPE';

  // D-FI3-W3 — rate-carrying prose ('ALV 25,5 %' / 'ALV 13,5 %' / 'ALV 14 %' /
  // 'ALV 10 %'). The FI vocabulary encodes the rate IN the treatment because
  // the FI chart has no per-account default rate to fall back to. Direction
  // picks the side; an unknown direction returns '' (never guess which side of
  // the return a rate lands on). 'ALV-tarkistus' (the unsure marker) matches
  // none of these. G-1: the decimal normalizes to an underscore (13,5 → 13_5).
  const rated = treatment.match(/(?:alv|vat)\s*(25[,.]5|13[,.]5|14|10)\s*%?/);
  if (rated) {
    if (!isSale && !isPurchase) return '';
    const suffix = isSale ? 'OUTPUT' : 'INPUT';
    return `ALV_${rated[1].replace(/[,.]/, '_')}_${suffix}`;
  }

  // Standard / taxable / unknown → let the caller fall back to the account default.
  return '';
};

// Tax side follows the resolved P&L coding, including refunds. Cash direction
// still determines the journal's debit/credit orientation, not whether a coded
// expense becomes a sale. Callers without a resolved P&L account retain the
// historical cash-side fallback; explicit native codes remain authoritative.
export const alvDirectionForTransaction = (transaction = {}, coding = {}) => {
  const type = ledgerAccountTypeFor(coding);
  if (type === 'expense') return 'in';
  if (type === 'revenue') return 'out';
  if (Number(transaction?.money_in || 0) > 0) return 'out';
  if (Number(transaction?.money_out || 0) > 0) return 'in';
  return '';
};

// applyAlvCodingToCoding({ coding, transaction }) — FI-3 slice W (D-FI3-W4): the
// posting-preview enrichment for an ALV-registered Finnish client. Renders the
// coder's persisted tax verdict (coding.tax_treatment, or an explicit FI code) to
// a Donna-native ALV code and stamps it where the journal builder already reads
// (`ledgerAccountFromCoding` prefers coding.xero_tax_type, falling back to
// coding.tax_type) — so the code reaches ledger_lines.tax_type with ZERO changes
// to the isolation-listed writers. Unresolvable verdicts ('ALV-tarkistus',
// unknown prose, unknown direction) leave the coding untouched: the line posts
// uncoded and the return engine's D-FI3-A4/A5 blockers surface it.
export const applyAlvCodingToCoding = ({ coding = {}, transaction = {} } = {}) => {
  // 308-settlement follow-up (slice-S design §what-this-does-NOT-do): a coding
  // that TARGETS an ALV control account (the OmaVero settlement's DR 2939, or a
  // manual clearing entry) must never carry an ALV code — a code resting on a
  // control account is exactly the D-FI3-A5 blocker. Same posture as the
  // split's control leg: tax_type 'NONE'; the movement stays visible through
  // the cross-check's unmarked-control-movement INFO lane.
  const targetAccountCode = String(coding.xero_account_code || coding.account_code || '').trim();
  if (ALV_ACCOUNT_CODES.has(targetAccountCode)) {
    return { ...coding, tax_type: 'NONE', xero_tax_type: 'NONE' };
  }
  const code = resolveAlvCode({
    taxType: coding.tax_type || coding.xero_tax_type || '',
    taxTreatment: coding.tax_treatment || '',
    direction: alvDirectionForTransaction(transaction, coding)
  });
  if (!code) return coding;
  const entry = resolveAlvEntry(code);
  return {
    ...coding,
    tax_type: code,
    xero_tax_type: code,
    // Label reflects what is ACTUALLY posted (the resolved code), mirroring
    // xeroFieldsFor's posture, so chips/history read true.
    tax_treatment: entry?.label_fi || coding.tax_treatment || ''
  };
};

// ---------------------------------------------------------------------------------
// FI-3 slice S — the ALV split-posting convention (D-FI3-S1..S3).
// Design: docs/design-donna-finland-fi3-alv-split.md.
// ---------------------------------------------------------------------------------
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// The two in-period ALV control accounts (tilikartta 2940/2939) + the line ROLE
// each split leg carries (D-FI3-S3). The role is the cross-check's persisted
// handle (it rides ledger_lines.payload.role); the control leg itself carries
// tax_type 'NONE' — the ALV code stays on the BASE line only, so D-FI3-A5's
// "no ALV code on a control account" invariant keeps holding.
export const ALV_SPLIT_CONTROL = Object.freeze({
  in: Object.freeze({
    role: 'alv_input_deductible',
    account: Object.freeze({ code: '2940', name: 'Vähennettävä arvonlisävero', account_type: 'liability', normal_balance: 'debit' })
  }),
  out: Object.freeze({
    role: 'alv_output',
    account: Object.freeze({ code: '2939', name: 'Suoritettava arvonlisävero', account_type: 'liability', normal_balance: 'credit' })
  })
});

// 308-settlement follow-up — the account the OmaVero settlement payment clears:
// the SAME 2939 the output splits credit (DR 2939 / CR bank; a refund FROM
// Verohallinto is the mirror image). Exposed by name so the coder's account
// menu can offer it and the writeback universe can resolve the name to the
// CODED control account instead of minting a code-less row the return engine's
// control tracking (keyed on account_code) would never see.
export const FINLAND_ALV_SETTLEMENT_ACCOUNT = ALV_SPLIT_CONTROL.out.account;

// Union helper for the Donna account universe / coder menu of an ALV-coding
// client: ensure the canonical settlement account row is present (by code or
// normalized name) without duplicating a chart row a prior post already minted.
// A name-matched row that carries NO code (a historical mint-by-name artifact —
// exactly what this union exists to prevent) gets the canonical code backfilled
// IN-MEMORY: resolving to a code-less row would bypass the control-account
// guard, the return engine's control tracking, and the unmarked-movement INFO
// lane, all of which key on account_code. The posting-time account upsert then
// mints/updates the properly coded row (its id derives from the code).
export const withFinlandAlvSettlementAccount = (ledgerAccounts = []) => {
  const rows = Array.isArray(ledgerAccounts) ? ledgerAccounts : [];
  const settlementName = FINLAND_ALV_SETTLEMENT_ACCOUNT.name.toLowerCase();
  const codeOf = (account) => String(account?.code || account?.account_code || '').trim();
  const nameMatches = (account) =>
    String(account?.name || account?.account_name || '').trim().toLowerCase() === settlementName;
  if (rows.some((account) => codeOf(account) === FINLAND_ALV_SETTLEMENT_ACCOUNT.code)) return rows;
  if (rows.some(nameMatches)) {
    return rows.map((account) => (nameMatches(account) && !codeOf(account)
      ? {
        ...account,
        code: FINLAND_ALV_SETTLEMENT_ACCOUNT.code,
        account_type: account.account_type || FINLAND_ALV_SETTLEMENT_ACCOUNT.account_type,
        normal_balance: account.normal_balance || FINLAND_ALV_SETTLEMENT_ACCOUNT.normal_balance
      }
      : account));
  }
  return [...rows, { ...FINLAND_ALV_SETTLEMENT_ACCOUNT, status: 'active', source: 'finland_tilikartta' }];
};

// The kinds that split a GROSS amount into net base + VAT (D-FI3-S1): the
// domestic-rate codes only. Zero/exempt/out-of-scope carry no VAT in the price;
// EU acquisitions, imports, and reverse-charge purchases are billed NET (their
// tax is self-assessed on the return, deliberately NOT posted in v1).
const ALV_SPLITTING_KINDS = new Set(['standard', 'reduced']);

// splitAlvGross({ gross, code }) — pure arithmetic, never throws. A splitting
// domestic-rate code on a positive gross → { code, rate, direction, gross, net,
// vat, role, controlAccount }; anything else → null (the amount IS the base).
// vat = gross − net absorbs the rounding cent, so net + vat == gross by
// construction (the journal builders VERIFY this, they never recompute it).
export const splitAlvGross = ({ gross, code } = {}) => {
  const entry = resolveAlvEntry(code);
  if (!entry || !ALV_SPLITTING_KINDS.has(entry.kind) || !(entry.rate > 0)) return null;
  if (entry.direction !== 'in' && entry.direction !== 'out') return null;
  const grossAmount = round2(gross);
  if (!(grossAmount > 0)) return null;
  const net = round2((grossAmount * 100) / (100 + entry.rate));
  const vat = round2(grossAmount - net);
  // Cent-level gross where the VAT share rounds to 0.00 (e.g. 0,02 € at 25,5 %,
  // anything ≤ 0,05 € at 10 %): at two-decimal resolution the amount IS the
  // base — post unsplit rather than hand the journal builder a zero VAT leg it
  // must refuse (a deterministic LEDGER_ALV_SPLIT_UNBALANCED wedge).
  if (!(net > 0) || !(vat > 0)) return null;
  const control = ALV_SPLIT_CONTROL[entry.direction];
  return {
    code: entry.code,
    rate: entry.rate,
    direction: entry.direction,
    gross: grossAmount,
    net,
    vat,
    role: control.role,
    controlAccount: { ...control.account }
  };
};

// resolveAlvSplitForPosting({ coding, transaction }) — the ONE derivation both
// the posting preview and the commit-time journal build call (D-FI3-S2: the
// journal is REBUILT from the coding at commit, so deriving the split from the
// same coding object keeps preview and post consistent by construction). Splits
// ONLY when the coding already carries a resolved FI ALV code (which can only
// get there via applyAlvCodingToCoding under FINLAND_ALV_CODING — a Xero/QBO
// tax type never resolves, so every other client is byte-identical) AND the
// code's tax side matches the resolved coding (cash direction alone is only
// the fallback without a P&L type). Refunds mirror the existing split through
// the journal builder's normal debit/credit orientation, retaining its VAT role.
export const resolveAlvSplitForPosting = ({ coding = {}, transaction = {} } = {}) => {
  const code = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
  const entry = resolveAlvEntry(code);
  if (!entry) return null;
  const direction = alvDirectionForTransaction(transaction, coding);
  if (!direction || entry.direction !== direction) return null;
  const gross = Number(transaction.money_in || 0) > 0 ? transaction.money_in : transaction.money_out;
  return splitAlvGross({ gross: Math.abs(Number(gross || 0)), code });
};
