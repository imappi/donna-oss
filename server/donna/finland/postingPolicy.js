// Country-owned composition of the existing ALV posting rules. No writer lives here.
import {
  ALV_SPLIT_CONTROL, FINLAND_ALV_CODING_FLAG_KEY, KNOWN_ALV_CODES,
  alvDirectionForTransaction, alvOutputCodeForRate, applyAlvCodingToCoding, resolveAlvCode,
  resolveAlvSplitForPosting, splitAlvGross, withFinlandAlvSettlementAccount, resolveAlvEntry
} from './alvCodes.js';
import { SALES_INVOICE_RECEIVABLE_ACCOUNT, SUPPLIER_BILL_PAYABLES_ACCOUNT, ledgerAccountTypeFor } from '../ledger.js';
import { documentSourceComponents } from '../documentAllocationComponents.js';
import { planArSettlement } from './issuedInvoiceSettlement.js';
import { assertSalesSourceTaxRegistration, assertTaxSourceEvidence } from '../taxSourceEvidence.js';
import { ALV_REGISTRATION_STATUSES, normalizeAlvRegistrationProfile, resolveAlvRegistrationAsOf } from './alvRegistration.js';
import { isRegistrationRecord } from '../sellerRegistration.js';
import { toIsoDay } from '../dates.js';

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const refuse = (code, message, details) => { throw Object.assign(new Error(message), { code, statusCode: 409, ...(details ? { details } : {}) }); };

// ALV registration on a date, tri-state as the invoice seller reads it
// (finland/sellerRegistration.js): only a recorded, effective registration is
// `true`; a recorded not-registered, not-yet-effective or ended record is
// `false`; no record, or one whose status is outside the closed vocabulary,
// is `null` (unknown). alvRegistration.js reads a garbage record as not
// registered because its invoice path is fail-safe; here unknown and
// not-registered both refuse, so the distinction only names the reason.
export const resolveFiAlvRegistrationOnDate = ({ registration = null, onDate = null } = {}) => {
  const at = toIsoDay(onDate);
  if (!at) return { registered: null, reason: 'no_as_of_date' };
  if (!isRegistrationRecord(registration)) return { registered: null, reason: 'no_record' };
  if (!ALV_REGISTRATION_STATUSES.includes(registration.status)) return { registered: null, reason: 'invalid_record' };
  const resolved = resolveAlvRegistrationAsOf({ registration, asOf: at });
  if (resolved.registered === true) return { registered: true, reason: 'registered' };
  if (resolved.status === 'not_registered') return { registered: false, reason: 'not_registered' };
  if (resolved.registered_from && at < resolved.registered_from) return { registered: false, reason: 'not_yet_effective' };
  return { registered: false, reason: resolved.status === 'deregistered' ? 'deregistered' : 'not_registered' };
};

// The twin of gb/postingPolicy.js assertGbVatRegistered (#45). ALV
// registration, not FINLAND_ALV_CODING, decides whether an ALV code may post:
// the switch only turns the Finnish coding lane on. A business that is not
// registered charges no ALV and deducts none, so an ALV code on its books
// misstates the expense and a return it does not file. The record is the one
// Finland already keeps and reads (clients.profile.alv_registration, read by
// the invoice seller and the ALV return), on the line's own date. Only
// `registered === true` posts. The line is never posted with its code
// dropped: it stays unposted with this named refusal until the record is
// corrected or the coding changes.
//
// Which codes: only those that put ALV on the books or claim a deduction —
// read from each code's own ALV_CODES entry (alvCodes.js), never a list kept
// here: an entry whose return boxes carry output/self-assessed tax (`tax`) or
// an input deduction (`deductible`). Today: the rated domestic sale and
// purchase codes, ALV_REVERSE_CHARGE_PURCHASE, ALV_EU_ACQUISITION,
// ALV_EU_SERVICE_ACQUISITION and ALV_IMPORT. The codes that only classify
// carry neither and post as before: ALV_0_OUTPUT, ALV_EU_SUPPLY,
// ALV_EU_SERVICE_SUPPLY, ALV_REVERSE_CHARGE_SALES (a reported base, no tax),
// ALV_EXEMPT, ALV_OUT_OF_SCOPE and ALV_NONDEDUCTIBLE_INPUT (no box at all).
export const alvCodeNeedsRegistration = (code) => {
  const entry = resolveAlvEntry(code);
  return Boolean(entry && (entry.return_boxes?.tax || entry.return_boxes?.deductible));
};
const assertFiAlvRegistered = ({ profile = null, onDate, code, refusalCode, subject }) => {
  if (!alvCodeNeedsRegistration(code)) return;
  const at = toIsoDay(onDate);
  const resolution = resolveFiAlvRegistrationOnDate({ registration: profile?.alv_registration ?? null, onDate: at });
  if (resolution.registered === true) return;
  refuse(refusalCode, `${subject} would post the ALV code ${code}, but the business is ${resolution.registered === false ? 'not ALV-registered' : 'not recorded as ALV-registered'} on ${at || 'an unknown date'} (${resolution.reason}). A business that is not registered charges and deducts no ALV, so nothing was posted; record the ALV registration (or correct the coding) and post again.`,
    { vat_code: code, as_of: at || null, registered: resolution.registered, registration_reason: resolution.reason });
};
// Input codes with a tax return box assess tax on the buyer's net base;
// their statutory rate is not VAT charged by the supplier.
const supplierTaxRate = entry => entry?.direction === 'in' && entry.return_boxes?.tax ? 0 : entry?.rate;
const taxPosting = Object.freeze({ outputCodeForRate: alvOutputCodeForRate, control: ALV_SPLIT_CONTROL.out });
// The registration declaration the shared coder contract reads
// (postingPolicy.js taxRegistration; transactionLlm.js): a bank line refused
// with TRANSACTION_ALV_REGISTRATION_REQUIRED becomes a question to the owner
// for the fact only they know — whether, and from when, the business is in
// the Finnish VAT register (arvonlisäverorekisteri). It asks no tax judgement.
// How the owner's own sales document is named in the owner's language: its
// file name and date, and the VAT it shows (the printed amount, or the printed
// rates when only the lines carry tax).
const fiSalesSourceWords = ({ language = 'fi', source = {} } = {}) => {
  const fi = language === 'fi';
  const file = source.filename ? ` ${source.filename}` : '';
  const date = toIsoDay(source.document_date);
  const dated = date ? (fi ? ` (päivätty ${date})` : ` (dated ${date})`) : '';
  const amount = source.tax_amount != null ? (fi ? `${Number(source.tax_amount).toFixed(2).replace('.', ',')}${source.currency ? ` ${source.currency}` : ''}`
    : `${Number(source.tax_amount).toFixed(2)}${source.currency ? ` ${source.currency}` : ''}`) : '';
  const rates = (source.rates || []).map((rate) => `${fi ? String(rate).replace('.', ',') : rate} %`).join(fi ? ' ja ' : ' and ');
  const document = source.document_type === 'issued_receipt' ? (fi ? 'kuitissanne' : 'your receipt') : (fi ? 'myyntilaskussanne' : 'your sales invoice');
  const shows = amount ? (fi ? `arvonlisäveroa ${amount}` : `VAT of ${amount}`) : (fi ? `arvonlisäveroa (${rates})` : `VAT (${rates})`);
  return { invoice: `${document}${file}${dated}`, shows };
};
const FI_TAX_REGISTRATION = Object.freeze({
  refusalCodes: Object.freeze(['TRANSACTION_ALV_REGISTRATION_REQUIRED', 'SUPPLIER_BILL_ALV_REGISTRATION_REQUIRED',
    'TRANSACTION_ALV_SALE_SOURCE_SHOWS_VAT_UNREGISTERED']),
  onDate: ({ profile = null, onDate = null } = {}) =>
    resolveFiAlvRegistrationOnDate({ registration: profile?.alv_registration ?? null, onDate }),
  ownerQuestion: ({ language = 'fi', lineLabel = '', onDate = null, registered = null } = {}) => {
    const at = toIsoDay(onDate) || '';
    const line = lineLabel ? `${lineLabel}: ` : '';
    if (language === 'fi') return registered === false
      ? `${line}tietojemme mukaan yritys ei ollut arvonlisäverorekisterissä ${at}. Onko yritys merkitty arvonlisäverorekisteriin sen jälkeen? Jos on, mistä päivästä alkaen?`
      : `${line}meillä ei ole tietoa siitä, onko yritys arvonlisäverorekisterissä. Onko yritys merkitty arvonlisäverorekisteriin? Jos on, mistä päivästä alkaen?`;
    return registered === false
      ? `${line}our records say the business was not in the Finnish VAT register (arvonlisäverorekisteri) on ${at}. Has the business been entered in the register since then? If so, from what date?`
      : `${line}we have no record of whether the business is in the Finnish VAT register (arvonlisäverorekisteri). Is the business entered in the register? If so, from what date?`;
  },
  // Recording the owner's answer (taxRegistrationReply.js): the one record
  // Finland keeps, written through the profile writer, whose Finnish intake
  // guard (profileIntake.js) refuses a change to a fact pilot preparation bound.
  profileField: 'alv_registration',
  recordLockedCodes: Object.freeze(['FI_PROFILE_PILOT_PREPARED']),
  // The checked answer as the record, through alvRegistration.js's own
  // normaliser. A stated end makes it deregistered (registered within the
  // window); a plain "no" is not_registered. The filing cadence and basis the
  // firm recorded stay with a registered record; the owner did not speak to them.
  // An owner answer is not primary verification, so verified_* are never set.
  recordFromAnswer: ({ current = null, registered, registeredFrom = null, registeredUntil = null, source = '' } = {}) => {
    const status = registeredUntil ? 'deregistered' : registered ? 'registered' : 'not_registered';
    const kept = status !== 'not_registered' && current && typeof current === 'object' && !Array.isArray(current)
      ? Object.fromEntries(['tax_period', 'registration_basis'].filter((key) => current[key] != null).map((key) => [key, current[key]])) : {};
    return normalizeAlvRegistrationProfile({ ...kept, status, registered_from: registeredFrom, registered_until: registeredUntil,
      ...(source ? { note: source } : {}) });
  },
  // The bounded follow-up: 'date' when the owner said yes without a usable
  // date, 'unclear' when the reply did not settle yes or no, 'exhausted' once
  // the follow-up was spent (the question stays on the owner).
  answerQuestion: ({ language = 'fi', kind = 'unclear' } = {}) => {
    if (language === 'fi') return kind === 'date'
      ? 'Kiitos. Mistä päivästä alkaen yritys on ollut arvonlisäverorekisterissä? Kerro tarkka päivämäärä (esimerkiksi 1.3.2026) niin kuin se lukee Verohallinnon päätöksessä tai YTJ:ssä.'
      : kind === 'exhausted'
        ? 'Emme vielä pysty kirjaamaan arvonlisäverorekisteröintiä. Kerro rekisteröinnin tarkka alkamispäivä tai lähetä kopio Verohallinnon päätöksestä tai YTJ-otteesta.'
        : 'Kiitos vastauksesta. Emme saaneet siitä varmaa tietoa: onko yritys arvonlisäverorekisterissä? Vastaa kyllä tai ei, ja jos kyllä, kerro rekisteröinnin alkamispäivä.';
    return kind === 'date'
      ? 'Thanks. From what date has the business been in the Finnish VAT register? Please give the exact date (for example 1 March 2026) as it appears on the Tax Administration decision or in the business register.'
      : kind === 'exhausted'
        ? 'We cannot record the VAT registration yet. Please tell us the exact date the registration started, or send a copy of the Tax Administration decision or a business register extract.'
        : 'Thanks for your reply. We could not tell from it whether the business is in the Finnish VAT register. Please answer yes or no, and if yes, the date the registration started.';
  },
  // The other side of the rule above: on a date the record says the business
  // is not registered, it charges no ALV and deducts none, whatever a
  // supplier's receipt prints, and the gross amount is the cost or the
  // revenue. This is Donna's knowledge, never an owner question. The shared
  // coder contract (transactionLlm.js) tells the coder this fact and these
  // treatments; the ledger still decides with alvCodeNeedsRegistration.
  // Read from the code table (alvCodes.js), the two treatments that carry no
  // tax box and no deduction:
  //  - a purchase: 'Vähennyskelvoton ALV (osto)' → ALV_NONDEDUCTIBLE_INPUT.
  //    The supplier's ALV is real but the buyer has no deduction right; the
  //    gross stays on the expense, no 307 entry, no split, and its null rate
  //    keeps every rate-gated guard aside. 'Ei ALV-käsittelyä' would relabel a
  //    taxed purchase out of scope (the vocabulary's own FIK-V note).
  //  - a sale: 'Ei ALV-käsittelyä' → ALV_OUT_OF_SCOPE. An unregistered seller's
  //    sale is outside the ALV it accounts for: no 301–303 tax, and not
  //    ALV_0_OUTPUT (a zero-rated sale reports its base in 309) or ALV_EXEMPT
  //    (an exempt activity by its nature, whoever sells it).
  withoutTax: Object.freeze({
    treatments: Object.freeze({ purchase: 'Vähennyskelvoton ALV (osto)', sale: 'Ei ALV-käsittelyä' }),
    instruction: ({ onDate = null } = {}) => `The business is not in the Finnish VAT register (arvonlisäverorekisteri) on ${toIsoDay(onDate) || 'this date'}. It charges no ALV on its sales and deducts no ALV on its purchases, whatever ALV a supplier's receipt or invoice prints: the gross amount is the cost or the revenue, with no ALV leg.`,
    // The treatment the ledger refuses for an unregistered business (the rule
    // above, on the code the treatment renders to).
    needsRegistration: ({ taxType = '', taxTreatment = '', direction = '' } = {}) =>
      alvCodeNeedsRegistration(resolveAlvCode({ taxType, taxTreatment, direction }))
  }),
  // A sale whose own sales invoice or receipt shows ALV, on a date the record
  // says the business is not in the register (taxSourceEvidence.js
  // assertSalesSourceTaxRegistration refuses it with refusalCode). The owner is
  // asked the registration fact with what was seen: which document, the ALV it
  // shows, and what the record says. A plain "no" leaves the document showing
  // ALV that the books cannot carry, so the owner is asked for the corrected
  // invoice or the credit note (correctionRequest). Neither wording says
  // whether the ALV shown is owed or how it is reported: no statutory rule is
  // encoded here, and a person decides that with the corrected document.
  // correctionAsk 'document_discrepancy': Finland's corrected-document
  // question (the reply's corrected invoice replaces the held source,
  // db/reconcile.js) carries the request where the held source is verified.
  salesSourceShowsTax: Object.freeze({
    refusalCode: 'TRANSACTION_ALV_SALE_SOURCE_SHOWS_VAT_UNREGISTERED',
    correctionAsk: 'document_discrepancy',
    ownerQuestion: ({ language = 'fi', lineLabel = '', onDate = null, source = {} } = {}) => {
      const at = toIsoDay(onDate) || '';
      const line = lineLabel ? `${lineLabel}: ` : '';
      const { invoice, shows } = fiSalesSourceWords({ language, source });
      if (language === 'fi') return `${line}${invoice} näkyy ${shows}, mutta tietojemme mukaan yritys ei ollut arvonlisäverorekisterissä ${at}. Oliko yritys tuolloin merkitty arvonlisäverorekisteriin? Jos oli, mistä päivästä alkaen?`;
      return `${line}${invoice} shows ${shows}, but our records say the business was not in the Finnish VAT register (arvonlisäverorekisteri) on ${at}. Was the business in the register then? If so, from what date?`;
    },
    correctionRequest: ({ language = 'fi', lineLabel = '', onDate = null, source = {} } = {}) => {
      const at = toIsoDay(onDate) || '';
      const line = lineLabel ? `${lineLabel}: ` : '';
      const { invoice, shows } = fiSalesSourceWords({ language, source });
      if (language === 'fi') return `${line}${invoice} näkyy ${shows}, mutta yritys ei ollut arvonlisäverorekisterissä ${at}. Lähetä meille korjattu lasku tai hyvityslasku, jolla lasku on korjattu.`;
      return `${line}${invoice} shows ${shows}, but the business was not in the Finnish VAT register (arvonlisäverorekisteri) on ${at}. Please send us the corrected invoice, or the credit note that corrects it.`;
    }
  }),
  // replyInvitation: false drops the closing invitation, for a surface where
  // the closed question has no reply (ownerReplyNotice.js).
  recordedNotice: ({ language = 'fi', record = null, replyInvitation = true } = {}) => {
    const from = record?.registered_from || '', until = record?.registered_until || '';
    if (language === 'fi') return `${record?.status === 'not_registered' ? 'Kirjasimme, että yritys ei ole arvonlisäverorekisterissä.'
      : until ? `Kirjasimme, että yritys oli arvonlisäverorekisterissä ${from ? `${from} – ` : ''}${until}.` : `Kirjasimme, että yritys on arvonlisäverorekisterissä ${from} alkaen.`}${replyInvitation ? ' Vastaa tähän, jos tieto ei ole oikein.' : ''}`;
    return `${record?.status === 'not_registered' ? 'We recorded that the business is not in the Finnish VAT register.'
      : until ? `We recorded that the business was in the Finnish VAT register ${from ? `from ${from} ` : ''}until ${until}.` : `We recorded that the business has been in the Finnish VAT register since ${from}.`}${replyInvitation ? ' Reply here if that is not right.' : ''}`;
  },
  // The answer was saved but not recorded: the record is locked or the answer
  // would remove registered days it holds (taxRegistrationReply.js). One fixed
  // line for both; a person must check it before the record changes.
  notRecordedNotice: ({ language = 'fi' } = {}) => (language === 'fi'
    ? 'Vastauksesi on tallennettu, mutta emme muuttaneet yrityksen arvonlisäverorekisteröinnistä olevaa tietoa. Kirjanpitäjän on tarkistettava asia ennen kuin tietoa muutetaan.'
    : 'Your answer is saved, but we did not change the Finnish VAT register details we hold for the business. Your accountant needs to check it before the record is changed.')
});

// Finnish evidence rule: every rated purchase code needs its settled source,
// whoever decided it; a machine's rated sale on money in needs a sales source.
const FI_TAX_EVIDENCE = Object.freeze({
  refusalCode: 'TRANSACTION_ALV_EVIDENCE_REQUIRED', inputRuleCoversAcceptedCoding: true,
  resolveEntry: ({ taxType = '', taxTreatment = '', direction = '' } = {}) => resolveAlvEntry(resolveAlvCode({ taxType, taxTreatment, direction })),
  deductibleInput: entry => entry.direction === 'in' && entry.rate > 0,
  taxedOutput: entry => entry.direction === 'out' && entry.rate > 0
});

export const FI_POSTING_POLICY = Object.freeze({
  jurisdiction: 'fi', policyId: 'fi_posting', policyVersion: 1,
  postingTaxCodingFlagKey: FINLAND_ALV_CODING_FLAG_KEY,
  supplierBillAdmissionFlagKey: 'FINLAND_EINVOICE_RECEIVE', supplierBillNeedsChart: false,
  nativeTaxCodePrefixes: Object.freeze(['ALV_']), nativeTaxCodes: Object.freeze([...KNOWN_ALV_CODES]),
  salesInvoiceChannels: Object.freeze(['finland']), salesTaxControlRole: null,
  taxEvidence: FI_TAX_EVIDENCE,
  taxRegistration: FI_TAX_REGISTRATION,
  capabilities: Object.freeze({ prepareLedgerAccounts: true, enrichCoding: true, transactionSplit: true,
    salesInvoiceTaxPosting: true, supplierBillTaxPosting: true,
    planArSettlement: true, arSettlementReceivableCoding: true, assertPostableTaxCoding: true, sourceTaxPosting: true }),
  arSettlementFlagKey: 'FINLAND_AR_SETTLEMENT',
  planArSettlement,
  arSettlementReceivableCoding: () => ({
    account_code: SALES_INVOICE_RECEIVABLE_ACCOUNT.code,
    account_name: SALES_INVOICE_RECEIVABLE_ACCOUNT.name,
    account_type: SALES_INVOICE_RECEIVABLE_ACCOUNT.type,
    account_label: `${SALES_INVOICE_RECEIVABLE_ACCOUNT.code} · ${SALES_INVOICE_RECEIVABLE_ACCOUNT.name}`
  }),
  prepareLedgerAccounts: ({ ledgerAccounts = [], taxCodingEnabled = false } = {}) =>
    taxCodingEnabled ? withFinlandAlvSettlementAccount(ledgerAccounts) : ledgerAccounts,
  enrichCoding: ({ coding = {}, sourceCoding = coding, transaction = {}, taxCodingEnabled = false } = {}) =>
    taxCodingEnabled ? applyAlvCodingToCoding({ coding: { ...coding,
      // Account defaults are context, never a replacement for this line's
      // authored tax decision. The preview may already contain that default.
      tax_type: sourceCoding.tax_type || sourceCoding.xero_tax_type || '',
      xero_tax_type: sourceCoding.xero_tax_type || sourceCoding.tax_type || '',
      tax_treatment: sourceCoding.tax_treatment || ''
    }, transaction }) : coding,
  // RT-23 — the AR/bank-line twin of SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED. After
  // enrichCoding, a coding that targets a P&L account (revenue or expense —
  // the legs the ALV return reads) for an ALV-coding client must carry a
  // resolved ALV code; 'ALV-tarkistus' (the coder's own unsure marker), an
  // unknown prose treatment or a missing one refuses by name. Balance-sheet
  // codings (a loan repayment, TyEL payable, owner funds) are not VAT legs
  // and post as before; an ALV control account already carries 'NONE'.
  assertPostableTaxCoding: ({ coding = {}, transaction = {}, taxCodingEnabled = false, profile = null, matchedDocument: document = null, autonomousCoding = false } = {}) => {
    const stamped = String(coding.xero_tax_type || coding.tax_type || '').trim().toUpperCase();
    const entry = resolveAlvEntry(stamped);
    const registration = (code) => assertFiAlvRegistered({ profile, onDate: transaction.date || transaction.transaction_date, code,
      refusalCode: 'TRANSACTION_ALV_REGISTRATION_REQUIRED', subject: 'This bank line' });
    // With the switch off nothing renders a treatment to a code, but an
    // explicit ALV code already on the coding still posts: registration binds it too.
    if (!taxCodingEnabled) {
      if (entry) registration(entry.code);
      return coding;
    }
    // A sale whose own sales document shows ALV, for a business the record
    // says is not registered: refused whatever treatment the coding carries
    // (a rated one would only meet the registration rule below).
    assertSalesSourceTaxRegistration({ registration: FI_TAX_REGISTRATION, profile, transaction, coding, document });
    const suggestion = transaction.ai_suggestion || {};
    // The component writer validates every selected code against the locked source.
    // Its complete plan, rather than the summary account's tax, owns this journal.
    // Each component carries its own explicit ALV treatment (documentAllocation.js
    // refuses one without); registration binds every component code that
    // charges or deducts ALV, on the line's tax side (the writer refines a
    // component's side by its account; a rated treatment needs registration on
    // either side).
    if (suggestion.posting_requirement === 'document_allocation') {
      const direction = alvDirectionForTransaction(transaction, coding);
      for (const item of Array.isArray(suggestion.document_allocations) ? suggestion.document_allocations : []) {
        registration(resolveAlvCode({ taxType: '', taxTreatment: item?.tax_treatment || suggestion.tax_treatment || '', direction }));
      }
      return coding;
    }
    if (['revenue', 'expense'].includes(ledgerAccountTypeFor(coding)) && entry && entry.direction !== 'both' && entry.direction !== alvDirectionForTransaction(transaction, coding)) {
      refuse('TRANSACTION_ALV_ACCOUNT_INCOMPATIBLE',
        'The explicit ALV code conflicts with the resolved expense or revenue account. Correct the coding before posting.');
    }
    const gross = Math.abs(Number(transaction.money_out || 0)) || Math.abs(Number(transaction.money_in || 0));
    // Enrichment deliberately stamps control settlements NONE. Do not revive
    // the discarded rate-bearing suggestion while checking source evidence.
    const selectedCode = stamped === 'NONE' ? 'NONE' : resolveAlvCode({ taxType: coding.xero_tax_type || coding.tax_type || '',
      taxTreatment: transaction.tax_treatment || suggestion.tax_treatment || '', direction: alvDirectionForTransaction(transaction, coding) });
    const selectedEntry = resolveAlvEntry(selectedCode);
    // The code the journal would carry: the stamped one, or the one the
    // coding's or the line's treatment renders to (enrichCoding stamps it
    // before this runs; a caller that skipped enrichment is bound the same way).
    const carried = entry || (stamped === 'NONE' ? null : resolveAlvEntry(resolveAlvCode({ taxType: '',
      taxTreatment: coding.tax_treatment || '', direction: alvDirectionForTransaction(transaction, coding) }))) || selectedEntry;
    if (carried) registration(carried.code);
    assertTaxSourceEvidence({ rule: FI_TAX_EVIDENCE, entry: selectedEntry, transaction, document, autonomousCoding });
    if (document && !document.matched_line_id && suggestion.posting_requirement !== 'document_allocation'
      && Math.round(Number(document.total_amount) * 100) === Math.round(gross * 100)) {
      const source = documentSourceComponents(document);
      if (source.complete && source.components.some(line => line.rate != null && selectedEntry?.rate > 0 && Math.abs(line.rate - supplierTaxRate(selectedEntry)) > 0.00001)) {
        throw Object.assign(new Error('The selected whole-document tax treatment differs from the source components. Recode the valid source with its component treatments; a replacement receipt is not required.'),
          { code: 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT', statusCode: 409,
            details: { source_validation: source, selected_tax_treatment: selectedCode, recovery: 'recode_current_evidence' } });
      }
      const statedTax = source.complete ? source.source_tax : document.tax_amount;
      const split = splitAlvGross({ gross, code: selectedCode });
      const expectedSupplierTax = selectedEntry?.direction === 'in' && selectedEntry.return_boxes?.tax ? 0 : split?.vat;
      if (statedTax != null && expectedSupplierTax != null && Math.abs(expectedSupplierTax - Number(statedTax)) > 0.02) {
        throw Object.assign(new Error(`The source states ${statedTax} VAT but the selected coding calculates ${expectedSupplierTax}. Reconsider the coding using the source validation; this comparison does not establish a source arithmetic defect.`),
          { code: source.complete || document.parse_summary?.totals_validation?.matches ? 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT' : 'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH', statusCode: 409,
            details: { source_validation: source, selected_tax_treatment: selectedCode, recovery: 'recode_current_evidence' } });
      }
    }
    if (!['revenue', 'expense'].includes(ledgerAccountTypeFor(coding))) return coding;
    if (stamped === 'NONE' || entry) return coding;
    // Resolvability, not stamping: a treatment enrichCoding would render to a
    // code passes even when the caller skipped enrichment; the unsure marker,
    // unknown prose and a missing treatment resolve to nothing.
    const code = resolveAlvCode({ taxType: stamped, taxTreatment: coding.tax_treatment || '', direction: alvDirectionForTransaction(transaction, coding) });
    if (code) return coding;
    const treatment = String(coding.tax_treatment || '').trim();
    refuse('TRANSACTION_ALV_TREATMENT_UNRESOLVED',
      `An ALV-coding client's ${ledgerAccountTypeFor(coding)} post requires a resolved ALV treatment — the coding says ${treatment ? `'${treatment}'` : 'nothing'}, which maps to no ALV code. Posting uncoded would leave the ALV return blind to this line; the line stays proposed until the treatment is resolved.`);
  },
  sourceTaxPosting: ({ taxType = '', taxTreatment = '', direction = '', gross = 0 } = {}) => {
    const code = resolveAlvCode({ taxType, taxTreatment, direction });
    const entry = resolveAlvEntry(code);
    return { code, taxType: code === 'ALV_OUT_OF_SCOPE' ? 'NONE' : code,
      rate: entry?.rate ?? null, sourceRate: supplierTaxRate(entry) ?? null,
      inputDeductible: entry?.direction === 'in' && Number(entry.rate) > 0 && Boolean(entry.return_boxes?.deductible),
      outputTaxed: entry?.direction === 'out' && Number(entry.rate) > 0,
      inputTaxRoles: ['alv_input', ALV_SPLIT_CONTROL.in.role],
      controlAccounts: Object.values(ALV_SPLIT_CONTROL).map(control => control.account),
      splitRequired: ['standard','reduced'].includes(entry?.kind) && entry.rate > 0,
      split: splitAlvGross({ gross, code }) };
  },
  transactionSplit: resolveAlvSplitForPosting,
  salesInvoiceTaxPosting: ({ channel = 'finland' } = {}) => channel === 'finland' ? taxPosting : null,
  supplierBillTaxPosting: ({ verdict = {}, document = {}, taxCodingEnabled = false, profile = null } = {}) => {
    let expenseTaxType = verdict.tax_type || verdict.xero_tax_type;
    const registration = (code) => assertFiAlvRegistered({ profile, onDate: document.document_date, code,
      refusalCode: 'SUPPLIER_BILL_ALV_REGISTRATION_REQUIRED', subject: 'This supplier bill' });
    if (!taxCodingEnabled) {
      const explicit = resolveAlvEntry(expenseTaxType);
      if (explicit) registration(explicit.code);
      return { expenseTaxType, alvSplit: null, payablesAccount: SUPPLIER_BILL_PAYABLES_ACCOUNT };
    }
    const code = resolveAlvCode({ taxType: expenseTaxType || '', taxTreatment: verdict.tax_treatment || '', direction: 'in' });
    if (!code) refuse('SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED', "An ALV-coding client's AP post requires a resolvable ALV treatment on the coding verdict — posting gross would forfeit the input-VAT deduction.");
    registration(code);
    expenseTaxType = code;
    let alvSplit = splitAlvGross({ gross: document.total_amount, code });
    const statedVat = round2(document.tax_amount);
    if (alvSplit && statedVat > 0) {
      if (Math.abs(statedVat - alvSplit.vat) > 0.02) refuse('SUPPLIER_BILL_ALV_AMOUNT_MISMATCH',
        `The bill states ${statedVat} VAT but the ${alvSplit.rate}% coding computes ${alvSplit.vat} — refusing rather than guessing which is right.`);
      alvSplit = { ...alvSplit, vat: statedVat, net: round2(round2(document.total_amount) - statedVat) };
    }
    return { expenseTaxType, alvSplit, payablesAccount: SUPPLIER_BILL_PAYABLES_ACCOUNT };
  }
});
