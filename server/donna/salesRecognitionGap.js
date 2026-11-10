// FI-09 pilot minimum — uploaded sales invoices the books do not yet recognise.
//
// The tree recognises an UPLOADED sales invoice only through the bank line that
// settles it (the settlement journal on that line), or through the issued-
// invoice journal when Donna issued it herself (postSalesInvoiceJournalWithClient,
// natural key sales_invoice/<number>). An uploaded credit note is never journaled
// on its own either (creditNoteApplications.js). Under ACCRUAL books that leaves
// three holes, each a silent omission from the issue period's sales and VAT:
//   - the invoice is unpaid (no settling line at all);
//   - the settling line is matched but not posted (it rests on a question, a
//     hold or a proposal);
//   - the invoice was paid in a later period, so revenue lands there instead.
// Kultalanka February 2025 (data/evals/fixtures/fi-kultalanka-2025-02, CG-1) is
// the reproducing case: Lumikki invoice 1002, 720,00 + 183,60 ALV, missing from
// February while every bank line converges.
//
// This module does not recognise anything. It is the deterministic census that
// lets every draft built from the posted ledger SAY what it leaves out, and the
// one hook that puts an unpaid invoice in front of a named human through the
// existing doc-anchored payment-method ask. Recognition at issuance is the
// follow-up (the PR that adds this module describes it).
//
// Jurisdiction-neutral by construction: the inputs are the client's accounting
// basis, the persisted documents, matches, credit applications and the posted
// ledger. A GB or US accrual book has the same hole and reads the same census.
// Cash-basis books are unchanged: there income is recognised at settlement.
//
// The purchase side has the same hole: an uploaded supplier bill or supplier
// credit note on an accrual book is recognised only through the bank line that
// settles it, or through the owner-funds settlement journal when the owner paid
// it in cash or on a personal card (documentSettlementEntry.js, source_type
// document_settlement). The same census covers it (side 'purchase'): the same
// resting states, the same holders, its own blocker
// (unrecognized_purchase_documents), so a draft names the expense and input
// VAT it leaves out next to, never mixed with, the sales it leaves out. The
// same hook puts an unpaid bill on the owner through its own lane
// (supplier_bill_settlement), sharing the ask primitive and the never-twice check.
//
// A document paid in part inside the period (one instalment in, the rest
// later or never) is recognised only as far as its posted lines go: the
// census sums the decided matches' match_amount on lines posted in the period
// (with the credit applications riding them), in cents from the stored
// decimals, and names the unpaid remainder with its gross, net and tax
// (rests part_settled_in_period). Same sum, same 1-cent epsilon as the
// sum-based payment_status (db/documents.js).
//
// A supplier credit note deducted from a bill's payment is linked to the bill
// only by a supplier-side credit application (document_credit_applications,
// side 'supplier'). Donna never infers the deduction from amounts that happen
// to add up: until the row exists the census names the bill's unpaid remainder
// and the credit note side by side, and the owner is asked about the credit
// note on the supplier lane with its own question (deducted, refunded or still
// open). The owner's clear answer "deducted from bill X" is recorded as that
// application (creditNoteApplications.applyOwnerStatedSupplierCreditWithClient,
// the one credit-application writer and its checks), and both documents are
// then represented. Recording it posts nothing.
//
// A sales payment short of its invoice is not guessed to be a fee. Donna
// persists, per match, the bank line's amount and currency and the matcher's
// hop labels (match_reason.hops); no fee amount. A shortfall counts as a bank
// fee only through an amount-bearing record on the match
// (payload.settlement_shortfall, kind 'bank_fee', in the invoice's currency).
// Without one, the remainder stays named and the owner is asked "bank fee or
// part-payment?" (ensureSettlementShortfallAsksWithClient, on the sales lane);
// "bank fee" writes that record (recordOwnerStatedBankFeeWithClient) and the
// invoice is represented net of it; "part-payment" is the lane's still-open
// answer for the remainder.
//
// Both questions are written in the owner's language (preferredOwnerTemplateLanguage)
// and invite the same two kinds of answer: how it was paid, or that it is
// still unpaid. "Still unpaid" is a real answer on both lanes: the owner-reply
// reader is told so (stillOpen below) and keeps the ask on the owner, re-asked
// after stillOpen.recheckDays instead of sending a clarification.
//
// Keep-layer posture: read-only SQL plus pure classification; no model call.
// The writes are the asks (the canonical ask primitive) and the two records an
// owner answer settles (a credit application through its writer; the bank-fee
// record on the match), each receipted. No ledger row is written here.

import { invoiceNumbersOf, toCents, centsText, applyOwnerStatedSupplierCreditWithClient } from './creditNoteApplications.js';
import { clientAccountingBasisFromProfile } from './db/clients.js';
import { __createClientEvidenceRequestWithClient } from './db/asks.js';
import { readClientConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY } from './documentDispositionShape.js';
import { toIsoDay } from './dates.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';

export const SALES_RECOGNITION_ASK_LANE = 'sales_invoice_recognition';
// Its purchase-side sibling: an uploaded supplier bill with no settling payment.
export const SUPPLIER_BILL_SETTLEMENT_ASK_LANE = 'supplier_bill_settlement';
// The existing doc-anchored settlement lane: resolved by the ledger writer when
// a journal posts against the document (resolveOpenSettlementRequestsForDocument),
// answered through the existing doc-ask reply consumer.
export const SALES_RECOGNITION_ASK_EVIDENCE_TYPE = 'payment_method';
export const SALES_RECOGNITION_BLOCKER = 'unrecognized_sales_documents';
export const PURCHASE_RECOGNITION_BLOCKER = 'unrecognized_purchase_documents';
// part_settled_in_period: one or more instalments are posted inside the
// period but they do not cover the document; the item carries only the unpaid
// remainder (remainder below), never the whole document and never nothing.
export const SALES_RECOGNITION_RESTS = Object.freeze([
  'no_settlement', 'settlement_proposed', 'settlement_unposted', 'settled_outside_period', 'part_settled_in_period'
]);

const DECIDED = new Set(['auto_matched', 'confirmed']);
const LIVE = new Set(['suggested', 'auto_matched', 'confirmed']);
const OPEN_ASK = new Set(['draft', 'open', 'replied']);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const strip = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const day = (v) => (v ? toIsoDay(v) : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Money as integer cents, read from the stored decimal text (numeric(14,2)
// arrives from pg as a string) — never through a floating-point product.
// One helper for the census and the credit-application writer.
export { toCents };
const fromCents = (c) => c / 100;
// The tax share of a settled part, in cents: round half up of tax × part / gross.
// BigInt keeps the product exact at any amount.
const taxShareCents = (taxCents, partCents, grossCents) => {
  if (!grossCents) return 0;
  const n = 2n * BigInt(taxCents) * BigInt(partCents) + BigInt(grossCents);
  return Number(n / (2n * BigInt(grossCents)));
};
// The same 1-cent epsilon the sum-based payment_status uses
// (db/documents.js computeSumBasedPaymentStatus): settled + 1 cent >= total is paid.
const PAID_EPSILON_CENTS = 1;

const basisOf = (clientRow) => {
  try {
    return clientAccountingBasisFromProfile(clientRow);
  } catch {
    // An unresolved method is not permission to assume cash: the census still
    // reports, and the drafts say the basis is unresolved.
    return 'unresolved';
  }
};

// The two sides of the census. Everything else (the resting states, the
// holders, the reconciliation) is the same code for both.
//   - documentType: the uploaded document the side reads;
//   - counterparty: the column naming the other party, and the item key it rides;
//   - issuedJournalType: a journal Donna writes for a document she issued herself
//     (only sales; a supplier bill is never issued by the book);
//   - noun / amounts: the draft sentence.
const RECOGNITION_SIDES = Object.freeze({
  sales: { documentType: 'sales_invoice', counterparty: 'customer_name', itemKey: 'customer', blocker: SALES_RECOGNITION_BLOCKER,
    issuedJournalType: 'sales_invoice', noun: 'sales document', amounts: (net, tax, ccy) => `${net} ${ccy} net + ${tax} tax`,
    fi: { noun: ['myyntiasiakirja', 'myyntiasiakirjaa'], amounts: (net, tax, ccy) => `${net} ${ccy} nettomyyntiä + ${tax} ALV` } },
  purchase: { documentType: 'supplier_bill', counterparty: 'vendor_name', itemKey: 'vendor', blocker: PURCHASE_RECOGNITION_BLOCKER,
    issuedJournalType: null, noun: 'supplier document', amounts: (net, tax, ccy) => `${net} ${ccy} expense + ${tax} input tax`,
    fi: { noun: ['ostoasiakirja', 'ostoasiakirjaa'], amounts: (net, tax, ccy) => `${net} ${ccy} kuluja + ${tax} vähennettävää ALV:tä` } }
});
const sideOf = (side) => {
  const known = RECOGNITION_SIDES[side];
  if (!known) throw Object.assign(new Error(`Unknown recognition census side: ${side}`), { code: 'RECOGNITION_SIDE_INVALID' });
  return known;
};

// The bank fee a match records as part of its settlement, in cents, or 0. Only
// an amount-bearing record counts (payload.settlement_shortfall: kind
// 'bank_fee', a positive amount, in the document's currency); the matcher's
// hop labels name no amount and are never read as one.
export const recordedBankFeeCents = (match, currency) => {
  const record = obj(obj(match?.payload).settlement_shortfall);
  if (record.kind !== 'bank_fee') return 0;
  if (String(record.currency || '').trim().toUpperCase() !== currency) return 0;
  const cents = toCents(record.amount);
  return cents != null && cents > 0 ? cents : 0;
};

// The part of a document the period's posted bank lines and credit
// applications settle, in cents, or null when they settle it all (or when an
// amount is not stated in the document's currency, so a part cannot be told
// from the whole). A bank fee recorded on a posted line counts with it
// (feeCents, feeMatchIds). Pure; read only from persisted amounts.
const partSettledInPeriod = ({ doc, kind, decided, applications, inPeriod, journalsByTx, fees = null }) => {
  const grossCents = Math.abs(toCents(doc.total_amount) ?? 0);
  if (!grossCents) return null;
  const currency = String(doc.currency || '').trim().toUpperCase();
  const postedInPeriod = (m) => (journalsByTx.get(m.bank_transaction_id) || []).some(inPeriod);
  let settledCents = 0;
  let feeCents = 0;
  const feeMatchIds = [];
  const ownMatchIds = [];
  const postedMatchIds = new Set();
  // Every decided own line is posted in the period: nothing else is known to
  // pay the rest (a later instalment answers it; no question about it).
  let allOwnInPeriod = true;
  for (const m of decided) {
    if (!postedInPeriod(m)) { if (m.matched_object_id === doc.id) allOwnInPeriod = false; continue; }
    postedMatchIds.add(m.id);
    // A line reached only through a credit application settles the other
    // document; the credit's own amount is counted from the application below.
    const reminder = obj(obj(m.payload).reminder_obligation);
    const own = m.matched_object_id === doc.id;
    if (!own && !(kind === 'invoice' && reminder.status === 'applied' && reminder.invoice_document_id === doc.id)) continue;
    const bankCurrency = String(m.bank_currency || '').trim().toUpperCase();
    if (bankCurrency && currency && bankCurrency !== currency) return null;
    const amount = toCents(own ? m.match_amount : reminder.principal_amount);
    if (amount == null) return null;
    settledCents += Math.abs(amount);
    if (own) {
      ownMatchIds.push(m.id);
      const fee = recordedBankFeeCents(m, currency);
      if (fee) { feeCents += fee; feeMatchIds.push(m.id); }
    }
  }
  for (const a of applications) {
    if ((kind === 'credit_note' ? a.credit_document_id : a.invoice_document_id) !== doc.id) continue;
    const rides = a.settlement_match_id ? postedMatchIds.has(a.settlement_match_id) : inPeriod(day(a.counterpart_date));
    if (!rides) continue;
    const amount = toCents(a.amount);
    if (amount == null) return null;
    settledCents += Math.abs(amount);
  }
  if (settledCents + feeCents + PAID_EPSILON_CENTS >= grossCents) {
    if (fees && feeCents && settledCents + PAID_EPSILON_CENTS < grossCents) fees.set(doc.id, { cents: feeCents, match_ids: feeMatchIds });
    return null;
  }
  settledCents += feeCents;
  const taxCents = doc.tax_amount != null ? Math.abs(toCents(doc.tax_amount) ?? 0) : 0;
  const remainingCents = grossCents - settledCents;
  return { grossCents, settledCents, remainingCents, remainingTaxCents: taxCents - taxShareCents(taxCents, settledCents, grossCents), ownMatchIds, allOwnInPeriod };
};

// classifyRecognitionGap — pure. Every in-scope uploaded document of the side
// (sales: sales invoices and credit notes; purchase: supplier bills and supplier
// credit notes) either is represented in the requested period's posted ledger
// (listed in `represented` with what represents it) or is an item here, with the
// state it rests in and who (if anyone) holds it. Nothing is in both lists, and
// a document is one entry however many lines settle it.
export const classifyRecognitionGap = ({
  side = 'sales',
  basis,
  period,
  documents = [],
  matches = [],
  transactionJournals = [],
  documentJournals = [],
  issuedJournals = [],
  applications = [],
  asks = []
} = {}) => {
  const spec = sideOf(side);
  const applies = basis === 'accrual' || basis === 'unresolved';
  const base = { side, blocker: spec.blocker, applies, basis, period: period ? { starts_on: period.starts_on, ends_on: period.ends_on } : null };
  if (!applies) return { ...base, status: 'not_applicable', items: [], totals: [], represented: [] };

  const inPeriod = (d) => Boolean(d) && d >= period.starts_on && d <= period.ends_on;
  const datesBySource = (journals) => {
    const map = new Map();
    for (const j of journals) map.set(j.source_id, [...(map.get(j.source_id) || []), day(j.journal_date)]);
    return map;
  };
  const journalsByTx = datesBySource(transactionJournals);
  const journalsByDoc = datesBySource(documentJournals);
  const issuedNumbers = new Set(spec.issuedJournalType ? issuedJournals.map((j) => strip(j.source_id)).filter(Boolean) : []);
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const items = [];
  const represented = [];
  // Documents a recorded bank fee completes: represented net of that fee.
  const fees = new Map();

  for (const doc of documents) {
    if (doc.document_type && doc.document_type !== spec.documentType) continue;
    const date = day(doc.document_date);
    if (date && !inPeriod(date)) continue;
    const payload = obj(doc.payload);
    const reminder = obj(payload.reminder_obligation);
    // A reminder's principal is its original invoice; it is not a second sale.
    if (reminder.status === 'applied' && reminder.reminder_document_id === doc.id) {
      represented.push({ document_id: doc.id, by: 'reminder_of_invoice' });
      continue;
    }
    const kind = String(doc.payment_status || '').trim().toLowerCase() === 'credit_note' ? 'credit_note' : 'invoice';
    const numbers = invoiceNumbersOf(doc);
    // The issued-invoice twin carries the revenue under its own journal.
    if (kind === 'invoice' && numbers.some((n) => issuedNumbers.has(n))) {
      represented.push({ document_id: doc.id, by: 'issued_invoice_journal' });
      continue;
    }

    const settling = matches.filter((m) => m.matched_object_id === doc.id
      || (kind === 'invoice' && obj(obj(m.payload).reminder_obligation).status === 'applied'
        && obj(obj(m.payload).reminder_obligation).invoice_document_id === doc.id));
    for (const a of applications) {
      const linked = kind === 'credit_note' ? a.credit_document_id === doc.id : a.invoice_document_id === doc.id;
      const m = linked && a.settlement_match_id ? matchById.get(a.settlement_match_id) : null;
      if (m && !settling.includes(m)) settling.push(m);
    }
    const decided = settling.filter((m) => DECIDED.has(m.status));
    const txIds = [...new Set(decided.map((m) => m.bank_transaction_id))];
    // A bill paid in instalments is one document: every settling line's journal
    // counts toward the same entry, never one entry per instalment.
    const journalDates = [...txIds.flatMap((id) => journalsByTx.get(id) || []), ...(journalsByDoc.get(doc.id) || [])].filter(Boolean).sort();
    // How much of the document the period's posted ledger carries. The
    // owner-funds journal (document_settlement) settles the whole document; a
    // bank line carries its match_amount (a reminder line its principal), plus
    // the credit applications that ride a posted line (or, with no line, a
    // credit note dated inside the period). The same sum and the same 1-cent
    // epsilon as the sum-based payment_status. When any posted line's amount
    // is not stated in the document's currency the census cannot tell a part
    // from the whole and keeps the whole document represented, as before.
    const partial = date && journalDates.some(inPeriod) && !(journalsByDoc.get(doc.id) || []).some(inPeriod)
      ? partSettledInPeriod({ doc, kind, decided, applications, inPeriod, journalsByTx, fees })
      : null;
    if (date && journalDates.some(inPeriod) && !partial) {
      const fee = fees.get(doc.id);
      represented.push({ document_id: doc.id, by: 'settlement_journal',
        ...(fee ? { net_of_bank_fee: { amount: fromCents(fee.cents), match_ids: fee.match_ids } } : {}) });
      continue;
    }

    // An invoice and the credit notes that cancel it in full, all inside the
    // period, net to nothing there: no settlement line exists to carry them.
    const credits = applications.filter((a) => (kind === 'invoice' ? a.invoice_document_id === doc.id : a.credit_document_id === doc.id));
    if (date && !txIds.length && credits.length && credits.every((a) => !a.settlement_match_id && inPeriod(day(a.counterpart_date)))
      && (kind === 'credit_note' || round2(credits.reduce((s, a) => s + Number(a.amount), 0)) === round2(Math.abs(Number(doc.total_amount))))) {
      represented.push({ document_id: doc.id, by: 'credit_netted_in_period' });
      continue;
    }

    let rests = 'no_settlement';
    if (partial) rests = 'part_settled_in_period';
    else if (journalDates.length) rests = 'settled_outside_period';
    else if (decided.length) rests = 'settlement_unposted';
    else if (settling.some((m) => LIVE.has(m.status))) rests = 'settlement_proposed';

    const heldBy = asks.filter((a) => OPEN_ASK.has(a.status)
      && (obj(a.request_payload).document_id === doc.id || (a.transaction_id && settling.some((m) => m.bank_transaction_id === a.transaction_id))))
      .map((a) => ({ id: a.id, status: a.status, evidence_type: a.evidence_type, audience: a.audience || 'client',
        anchor: obj(a.request_payload).document_id === doc.id ? 'document' : 'transaction' }));
    const sign = kind === 'credit_note' ? -1 : 1;
    const taxKnown = doc.tax_amount != null && Number.isFinite(Number(doc.tax_amount));
    // A part-settled document is named by its unpaid remainder only.
    const gross = partial ? fromCents(sign * partial.remainingCents) : round2(sign * Math.abs(Number(doc.total_amount)));
    const tax = !taxKnown ? null : partial ? fromCents(sign * partial.remainingTaxCents) : round2(sign * Math.abs(Number(doc.tax_amount)));
    const counterparty = doc[spec.counterparty] || null;
    items.push({
      document_id: doc.id,
      filename: doc.filename || null,
      side,
      kind,
      document_date: date,
      period_scope: date ? 'in_period' : 'period_unknown',
      [spec.itemKey]: counterparty,
      counterparty,
      invoice_numbers: numbers,
      currency: String(doc.currency || '').trim().toUpperCase() || null,
      gross,
      // Sales: revenue net of output tax. Purchase: expense net of input tax.
      net: taxKnown ? round2(gross - tax) : null,
      tax,
      rests,
      ...(partial ? { remainder: { document_gross: fromCents(sign * partial.grossCents), settled_in_period: fromCents(sign * partial.settledCents),
        remaining_gross: gross, remaining_tax: tax } } : {}),
      // A sales invoice paid short on its own posted lines, with nothing that
      // says why and no other decided line for the rest: the shortfall the
      // owner is asked about (bank fee or part-payment), in cents as stored
      // text, and the lines it was short on.
      ...(partial && side === 'sales' && kind === 'invoice' && partial.ownMatchIds.length && partial.allOwnInPeriod
        ? { shortfall: { amount: centsText(partial.remainingCents), match_ids: partial.ownMatchIds } } : {}),
      settlement: { transaction_ids: txIds, journal_dates: journalDates },
      held_by: heldBy,
      on_nobody: heldBy.length === 0
    });
  }

  const byCurrency = new Map();
  for (const item of items) {
    const key = item.currency || 'UNKNOWN';
    const t = byCurrency.get(key) || { currency: item.currency, count: 0, gross: 0, net: 0, tax: 0, tax_unknown_count: 0 };
    t.count += 1;
    t.gross = round2(t.gross + item.gross);
    if (item.tax == null) t.tax_unknown_count += 1;
    else { t.net = round2(t.net + item.net); t.tax = round2(t.tax + item.tax); }
    byCurrency.set(key, t);
  }
  return { ...base, status: items.length ? 'excluded' : 'none', items, totals: [...byCurrency.values()], represented };
};

// The one honest sentence a draft carries when a side of the census is non-empty,
// in English (the default) or Finnish. A part-paid document counts by its
// unpaid remainder, and the sentence says so.
export const recognitionStatement = (gap, { language = 'en' } = {}) => {
  if (!gap?.items?.length) return null;
  const spec = sideOf(gap.side || 'sales');
  const n = gap.items.length;
  const parts = gap.items.filter((i) => i.rests === 'part_settled_in_period').length;
  const money = (v) => amountText(v, null, language);
  if (language === 'fi') {
    const amounts = gap.totals.map((t) => `${spec.fi.amounts(money(t.net), money(t.tax), t.currency || '').replace(/\s+/g, ' ')}`
      + `${t.tax_unknown_count ? ` (${t.tax_unknown_count} ilman ilmoitettua veron määrää)` : ''}`).join('; ');
    const noun = `${n} ladattu${n === 1 ? '' : 'a'} ${spec.fi.noun[n === 1 ? 0 : 1]}`;
    if (!parts) return `${noun} ei ole kirjattu tämän kauden kirjanpitoon, ja ${n === 1 ? 'se on' : 'ne on'} jätetty pois näistä luvuista: ${amounts}.`;
    return `${noun} ei ole kirjattu kokonaan tämän kauden kirjanpitoon; kirjaamaton osa on jätetty pois näistä luvuista: ${amounts}. `
      + `${n === 1 ? 'Se on' : `Niistä ${parts} on`} maksettu tällä kaudella vain osittain; mukana on vain maksamaton loppuosa.`;
  }
  const amounts = gap.totals.map((t) => `${spec.amounts(t.net.toFixed(2), t.tax.toFixed(2), t.currency || '').replace(/\s+/g, ' ')}`
    + `${t.tax_unknown_count ? ` (${t.tax_unknown_count} without a stated tax amount)` : ''}`).join('; ');
  if (!parts) return `${n} uploaded ${spec.noun}${n === 1 ? ' is' : 's are'} not recognised in this period's posted ledger and ${n === 1 ? 'is' : 'are'} excluded from these figures: ${amounts}.`;
  return `${n} uploaded ${spec.noun}${n === 1 ? ' is' : 's are'} not fully recognised in this period's posted ledger; the unrecognised part is excluded from these figures: ${amounts}. `
    + `${parts} of them ${parts === 1 ? 'is' : 'are'} paid only in part in this period; only ${parts === 1 ? 'its' : 'their'} unpaid remainder is counted here.`;
};

// The financial-statement draft reason (ledgerReadModel.buildReportDraftState),
// one per side, each under its own code.
export const recognitionDraftReason = (gap, { language = 'en' } = {}) => {
  if (!gap?.items?.length) return null;
  return {
    code: sideOf(gap.side || 'sales').blocker,
    detail: recognitionStatement(gap, { language }),
    count: gap.items.length,
    totals: gap.totals,
    document_ids: gap.items.map((i) => i.document_id)
  };
};

// The census loader: one read for both sides. Returns { sales, purchase }, each
// the classification of its side. A cash book reads nothing and both sides are
// not_applicable.
export const readRecognitionGapWithClient = async ({ client, firmId, clientId, period } = {}) => {
  if (!period?.starts_on || !period?.ends_on) {
    throw Object.assign(new Error('A period is required for the recognition census.'), { code: 'SALES_RECOGNITION_PERIOD_REQUIRED', statusCode: 400 });
  }
  const clientRow = (await client.query('select profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
  const basis = clientRow ? basisOf(clientRow) : 'unresolved';
  const both = (inputs = {}) => ({
    sales: classifyRecognitionGap({ side: 'sales', basis, period, ...inputs }),
    purchase: classifyRecognitionGap({ side: 'purchase', basis, period, ...inputs })
  });
  if (basis === 'cash') return both();
  const documents = (await client.query(
    `select id, filename, document_type, document_date, total_amount::text as total_amount, tax_amount::text as tax_amount, currency, customer_name, vendor_name,
            payment_status, reference_number, structured_reference, parse_summary, payload
       from documents
      where firm_id = $1 and client_id = $2
        and document_type in ('sales_invoice', 'supplier_bill')
        and parse_status = 'completed'
        and duplicate_of is null
        and total_amount is not null
        and (document_date is null or (document_date >= $3::date and document_date <= $4::date))
      order by document_date nulls last, id`,
    [firmId, clientId, period.starts_on, period.ends_on]
  )).rows;
  if (!documents.length) return both();
  const docIds = documents.map((d) => d.id);
  // Credit applications of both sides (creditNoteApplications.js): the AR
  // matcher's customer credits and the owner-stated supplier credits. The
  // read is not filtered by side: an application nets the credit into its
  // document's posted line (or, with no line, into the period by date).
  const applications = (await client.query(
    `select a.credit_document_id, a.invoice_document_id, a.amount::text as amount, a.settlement_match_id,
            case when a.credit_document_id = any($3::text[]) then inv.document_date else cr.document_date end as counterpart_date
       from document_credit_applications a
       join documents inv on inv.id = a.invoice_document_id
       join documents cr on cr.id = a.credit_document_id
      where a.firm_id = $1 and a.client_id = $2 and a.status = 'applied'
        and (a.credit_document_id = any($3::text[]) or a.invoice_document_id = any($3::text[]))`,
    [firmId, clientId, docIds]
  )).rows;
  // match_amount and the bank line's currency: how much of a document each
  // posted line carries (a part-paid document names its unpaid remainder).
  const matches = (await client.query(
    `select m.id, m.bank_transaction_id, m.matched_object_id, m.status, m.match_amount::text as match_amount, m.payload,
            t.currency as bank_currency
       from reconciliation_matches m
       left join transactions t on t.firm_id = m.firm_id and t.id = m.bank_transaction_id
      where m.firm_id = $1 and m.client_id = $2 and m.status in ('suggested', 'auto_matched', 'confirmed')
        and (m.matched_object_id = any($3::text[])
          or m.payload->'reminder_obligation'->>'invoice_document_id' = any($3::text[])
          or m.id = any($4::text[]))`,
    [firmId, clientId, docIds, applications.map((a) => a.settlement_match_id).filter(Boolean)]
  )).rows;
  const txIds = [...new Set(matches.map((m) => m.bank_transaction_id).filter(Boolean))];
  const settlementJournals = (await client.query(
    `select source_type, source_id, journal_date from ledger_journals
      where firm_id = $1 and client_id = $2 and status in ('posted', 'closed') and reversed_at is null
        and ((source_type = 'transaction' and source_id = any($3::text[]))
          or (source_type = 'document_settlement' and source_id = any($4::text[]))
          or source_type = 'sales_invoice')`,
    [firmId, clientId, txIds, docIds]
  )).rows;
  const asks = (await client.query(
    `select id, status, evidence_type, audience, transaction_id, request_payload
       from client_evidence_requests
      where firm_id = $1 and client_id = $2 and status in ('draft', 'open', 'replied')
        and (request_payload->>'document_id' = any($3::text[]) or transaction_id = any($4::text[]))`,
    [firmId, clientId, docIds, txIds]
  )).rows;
  const ofType = (type) => settlementJournals.filter((j) => j.source_type === type);
  return both({ documents, matches, applications, asks,
    transactionJournals: ofType('transaction'), documentJournals: ofType('document_settlement'), issuedJournals: ofType('sales_invoice') });
};

export const amountText = (value, currency, language = 'en') => {
  const fixed = Number(value).toFixed(2);
  return `${language === 'fi' ? fixed.replace('.', ',') : fixed}${currency ? ` ${currency}` : ''}`;
};
// Finnish owners read 12.2.2025, not 2025-02-12.
export const dayText = (iso, language = 'en') => {
  if (!iso || language !== 'fi') return iso;
  const [y, m, d] = iso.split('-');
  return `${Number(d)}.${Number(m)}.${y}`;
};

const printedInvoiceNumber = (document = {}) => {
  const refs = Array.isArray(obj(document.parse_summary).references) ? document.parse_summary.references : [];
  const printed = refs.find((r) => r?.type === 'invoice_number' && String(r.value || '').trim());
  return String(printed?.value || document.reference_number || '').trim();
};

// The Finnish header names the counterparty inside the brackets so no company
// name has to be inflected: "Myyntilasku 1002 (Lumikki Oy, 903,60 EUR, päivätty 12.2.2025)".
const finnishHeader = ({ label, document, counterparty }) => {
  const number = printedInvoiceNumber(document) ? ` ${printedInvoiceNumber(document)}` : '';
  const date = day(document.document_date);
  const parts = [counterparty, amountText(document.total_amount, document.currency, 'fi'), date ? `päivätty ${dayText(date, 'fi')}` : null].filter(Boolean);
  return `${label}${number} (${parts.join(', ')})`;
};

export const buildSalesRecognitionQuestion = ({ document = {}, language = 'en' } = {}) => {
  if (language === 'fi') {
    return `${finnishHeader({ label: 'Myyntilasku', document, counterparty: document.customer_name })}: `
      + 'Donnalla olevissa tiliotteissa ei näy tälle laskulle maksua. Donna ei vielä kirjaa maksamatonta myyntilaskua kirjanpitoon, '
      + 'joten se jää pois sen kauden myynnistä ja arvonlisäverosta, ja luonnoksissa se näkyy pois jätettynä. '
      + 'Onko asiakas maksanut laskun? Jos se on maksettu, kerro milloin ja mille tilille. Jos se on vielä maksamatta, vastaa "vielä maksamatta".';
  }
  const number = printedInvoiceNumber(document) ? ` ${printedInvoiceNumber(document)}` : '';
  const customer = document.customer_name ? ` to ${document.customer_name}` : '';
  const date = day(document.document_date);
  return `Sales invoice${number}${customer} (${amountText(document.total_amount, document.currency)}${date ? `, dated ${date}` : ''}) `
    + 'has no payment on the bank statements Donna holds. Donna does not yet record an unpaid sales invoice in the books, '
    + 'so it is left out of that period\'s sales and VAT figures, and the drafts list it as excluded. '
    + 'Has the customer paid it? If it has been paid, reply when and into which account. If it is still unpaid, reply "still unpaid".';
};

// The purchase-side question. It invites only answers the doc-ask reply path
// consumes (runOwnerReplyRedisposition): an account and a date (matched once
// that statement arrives, or a statement request for an account Donna lacks),
// the owner's own cash or personal card (the documentSettlementEntry
// owner-funds journal), or "still unpaid" (the lane's stillOpen answer: the
// question stays open and is asked again later). The ledger post against the
// bill's bank line resolves it (resolveOpenSettlementRequestsForDocument).
export const buildSupplierBillSettlementQuestion = ({ document = {}, language = 'en' } = {}) => {
  if (language === 'fi') {
    return `${finnishHeader({ label: 'Ostolasku', document, counterparty: document.vendor_name })}: `
      + 'Donnalla olevissa tiliotteissa ei näy tälle laskulle maksua. Donna ei vielä kirjaa maksamatonta ostolaskua kirjanpitoon, '
      + 'joten se puuttuu sen kauden kuluista ja arvonlisäverosta. '
      + 'Onko lasku maksettu? Jos se on maksettu, kerro milloin ja miltä tililtä, tai jos maksoit sen omilla rahoillasi käteisellä tai omalla kortillasi, kerro kumpi. '
      + 'Jos se on vielä maksamatta, vastaa "vielä maksamatta".';
  }
  const number = printedInvoiceNumber(document) ? ` ${printedInvoiceNumber(document)}` : '';
  const vendor = document.vendor_name ? ` from ${document.vendor_name}` : '';
  const date = day(document.document_date);
  return `Supplier bill${number}${vendor} (${amountText(document.total_amount, document.currency)}${date ? `, dated ${date}` : ''}) `
    + 'has no payment on the bank statements Donna holds. Donna does not yet record an unpaid supplier bill in the books, '
    + 'so it is missing from that period\'s expenses and VAT. '
    + 'Has it been paid? If it has been paid, reply when and from which account, or, if you paid it with your own money in cash or on a personal card, say which. '
    + 'If it is still unpaid, reply "still unpaid".';
};

// The purchase-side question for a supplier credit note the books do not
// recognise. Donna keeps no record that ties a supplier credit note to the
// bill it was deducted from (document_credit_applications is written for
// customer credit notes only), so a bill paid net of a credit looks, to the
// census, like a part-paid bill and an unused credit. Donna does not infer
// the deduction from amounts that happen to add up: the owner is asked, on
// the supplier lane, whether the credit was deducted from a payment, refunded,
// or is still open. "Still open" is the lane's stillOpen answer for a credit.
export const buildSupplierCreditNoteQuestion = ({ document = {}, language = 'en' } = {}) => {
  const credit = { ...document, total_amount: Math.abs(Number(document.total_amount)) };
  if (language === 'fi') {
    return `${finnishHeader({ label: 'Ostohyvityslasku', document: credit, counterparty: document.vendor_name })}: `
      + 'Donnalla olevissa tiliotteissa ei näy tälle hyvitykselle palautusta, eikä Donnalla ole tietoa siitä, että se olisi vähennetty jonkin laskun maksusta. '
      + 'Donna ei vielä kirjaa avointa ostohyvityslaskua kirjanpitoon, joten se puuttuu sen kauden kuluista ja arvonlisäverosta. '
      + 'Onko hyvitys vähennetty toimittajalle maksetusta laskusta, vai onko se palautettu sinulle? '
      + 'Jos se on vähennetty, kerro minkä laskun maksusta ja milloin maksu tehtiin. Jos se on palautettu, kerro milloin ja mille tilille. '
      + 'Jos hyvitys on vielä käyttämättä, vastaa "vielä avoin".';
  }
  const number = printedInvoiceNumber(document) ? ` ${printedInvoiceNumber(document)}` : '';
  const vendor = document.vendor_name ? ` from ${document.vendor_name}` : '';
  const date = day(document.document_date);
  return `Supplier credit note${number}${vendor} (${amountText(credit.total_amount, document.currency)}${date ? `, dated ${date}` : ''}) `
    + 'has no refund on the bank statements Donna holds, and nothing Donna holds shows it deducted from a payment of a bill. '
    + 'Donna does not yet record an open supplier credit note in the books, so it is missing from that period\'s expenses and VAT. '
    + 'Was it deducted from a payment to the supplier, or refunded to you? '
    + 'If it was deducted, reply which bill\'s payment it was deducted from and when that payment was made. If it was refunded, reply when and into which account. '
    + 'If it is still open, reply "still open".';
};

// The sales-side question for a payment short of its invoice when nothing
// persisted says why (no bank fee recorded on the match). Donna does not
// guess: the owner is asked whether the difference was a bank fee or a
// part-payment. "Bank fee" is recorded on the match (the lane's bankFee
// answer); "part-payment" is the lane's still-open answer for the remainder.
export const buildSettlementShortfallQuestion = ({ document = {}, shortfall = {}, language = 'en' } = {}) => {
  const short = amountText(shortfall.amount, document.currency, language);
  const received = shortfall.settled != null ? amountText(shortfall.settled, document.currency, language) : null;
  if (language === 'fi') {
    return `${finnishHeader({ label: 'Myyntilasku', document, counterparty: document.customer_name })}: `
      + `tälle laskulle kirjattu maksu oli ${short} laskua pienempi${received ? ` (saatu ${received})` : ''}. `
      + 'Donna ei tiedä, mistä erotus johtuu, joten se puuttuu toistaiseksi kauden myynnistä ja arvonlisäverosta. '
      + 'Oliko erotus pankin palvelumaksu vai osamaksu? Jos se oli pankin palvelumaksu, vastaa "pankin palvelumaksu". '
      + 'Jos asiakas maksoi vain osan ja loput on vielä maksamatta, vastaa "osamaksu".';
  }
  const number = printedInvoiceNumber(document) ? ` ${printedInvoiceNumber(document)}` : '';
  const customer = document.customer_name ? ` to ${document.customer_name}` : '';
  const date = day(document.document_date);
  return `Sales invoice${number}${customer} (${amountText(document.total_amount, document.currency)}${date ? `, dated ${date}` : ''}): `
    + `the payment recorded for it was ${short} short${received ? ` (${received} received)` : ''}. `
    + 'Donna does not know why, so for now the difference is left out of that period\'s sales and VAT. '
    + 'Was it a bank fee or a part-payment? If it was a bank fee, reply "bank fee". '
    + 'If the customer paid only part and the rest is still unpaid, reply "part-payment".';
};

// How long an ask the owner answered "still unpaid" rests before the re-ask
// clock asks again (its due_at). A month: the next monthly statement normally
// arrives in that time, and a payment posted against the document closes the
// ask before then. Not the 7-day nudge: the owner did answer.
export const NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS = 30;

// One lane per obligation type that the scoped no-settlement negative leaves
// unrecorded on an accrual book (NO_SETTLEMENT_OBLIGATION_TYPES). The census
// above covers both lanes (side sales and side purchase).
// stillOpen is the lane's "still unpaid" answer, told to the owner-reply
// reader (documentDispositionLlm.runOwnerReplyRedisposition): what it means
// on this lane, and when to ask again.
const NO_SETTLEMENT_ASK_LANES = Object.freeze({
  sales_invoice: { lane: SALES_RECOGNITION_ASK_LANE, statsKey: 'sales_recognition_ask', buildQuestion: buildSalesRecognitionQuestion,
    recognition: 'unrecognised_uploaded_sales_invoice', refusal: 'not_an_uploaded_sales_invoice',
    stillOpen: Object.freeze({ meaning: 'the customer has not paid this sales invoice yet; the receivable is still open',
      recheckDays: NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS }),
    // A sales invoice paid short with nothing recorded about why rides the
    // same lane with its own question. It is asked about a document that has
    // a decided bank line by design, so a live match does not make it moot.
    shortfall: Object.freeze({ buildQuestion: buildSettlementShortfallQuestion, recognition: 'unexplained_settlement_shortfall',
      matchedDocument: true,
      stillOpen: Object.freeze({ meaning: 'the payment was a part-payment: the customer paid only part of this sales invoice and the rest is still unpaid',
        recheckDays: NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS }),
      bankFee: Object.freeze({ meaning: 'the shortfall was a bank fee (the bank or payment service kept it), so the customer paid the invoice in full' }) }) },
  supplier_bill: { lane: SUPPLIER_BILL_SETTLEMENT_ASK_LANE, statsKey: 'supplier_bill_settlement_ask', buildQuestion: buildSupplierBillSettlementQuestion,
    recognition: 'unrecorded_uploaded_supplier_bill', refusal: 'not_an_uploaded_supplier_bill',
    stillOpen: Object.freeze({ meaning: 'the business has not paid this supplier bill yet; the payable is still open',
      recheckDays: NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS }),
    // A supplier credit note rides the same lane with its own question and
    // its own meaning of "still open" (request_payload.recognition tells them apart).
    creditNote: Object.freeze({ buildQuestion: buildSupplierCreditNoteQuestion, recognition: 'unrecorded_uploaded_supplier_credit_note',
      stillOpen: Object.freeze({ meaning: 'the supplier has neither refunded this credit note nor had it deducted from a payment yet; the credit is still open',
        recheckDays: NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS }),
      // "Deducted from bill X": recorded as a supplier credit application.
      creditDeducted: Object.freeze({ meaning: 'the credit note was deducted from the payment of a supplier bill, and the owner names that bill by its number' }) }) }
});
export const noSettlementAskStatsKey = (documentType) => NO_SETTLEMENT_ASK_LANES[documentType]?.statsKey || null;
// The "still unpaid" answer an ask's lane (request_payload.lane) accepts, or
// null for every other lane. A credit-note ask (request_payload.recognition)
// accepts "still open" in the credit note's sense.
const askedKindOf = (askLane, recognition) => {
  const lane = Object.values(NO_SETTLEMENT_ASK_LANES).find((l) => l.lane === askLane);
  if (!lane) return null;
  for (const sub of [lane.creditNote, lane.shortfall]) if (sub && recognition === sub.recognition) return sub;
  return lane;
};
export const noSettlementAskStillOpen = (askLane, recognition = null) => askedKindOf(askLane, recognition)?.stillOpen || null;
// The answers beyond "still open" that an ask's question invites, each with
// what it means and the record it settles (read by the owner-reply reader,
// documentDispositionLlm.runOwnerReplyRedisposition), or null:
//   - creditDeducted: "deducted from bill X" (a supplier credit-note ask);
//   - bankFee: "it was a bank fee" (a sales shortfall ask);
//   - matchedDocument: the ask is about a document with a decided bank line,
//     so that line does not make the ask moot.
export const noSettlementAskLaneAnswers = (askLane, recognition = null) => {
  const asked = askedKindOf(askLane, recognition);
  if (!asked || !(asked.creditDeducted || asked.bankFee)) return null;
  return Object.freeze({
    ...(asked.creditDeducted ? { creditDeducted: asked.creditDeducted } : {}),
    ...(asked.bankFee ? { bankFee: asked.bankFee } : {}),
    matchedDocument: asked.matchedDocument === true
  });
};

// The ask hook. Called where the runtime concludes that no supplied payment
// settles an uploaded sales invoice or supplier bill (jevReconciliation's
// scoped negative). On an accrual book where the doc-ask lane acts, the
// document becomes ONE doc-anchored payment-method question to the owner, in
// the owner's language, through the canonical ask primitive. Never re-asked
// once its lane asked it (an answered question stays answered; for a sales
// invoice the census keeps listing it on every draft).
export const ensureNoSettlementAskWithClient = async ({ client, firmId, clientId, documentId, documentType, reason = 'no_settlement', actorId = 'system' } = {}) => {
  const lane = NO_SETTLEMENT_ASK_LANES[documentType];
  if (!lane) return { minted: false, reason: 'not_a_no_settlement_obligation' };
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, snapshot, envFallback: () => false })) {
    return { minted: false, reason: 'flag_off' };
  }
  const clientRow = (await client.query('select jurisdiction, profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
  if (!clientRow || basisOf(clientRow) !== 'accrual') return { minted: false, reason: 'not_accrual' };
  const document = (await client.query(
    `select id, document_type, parse_status, duplicate_of, payment_status, customer_name, vendor_name, total_amount, currency,
            document_date, reference_number, structured_reference, parse_summary
       from documents where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, documentId]
  )).rows[0];
  const isCreditNote = String(document?.payment_status || '').toLowerCase() === 'credit_note';
  // A customer credit note is settled through its persisted application
  // (creditNoteApplications.js), never asked here; a supplier credit note has
  // no such record, so it is asked on the supplier lane with its own question.
  const asking = isCreditNote ? lane.creditNote : lane;
  if (!document || document.document_type !== documentType || document.parse_status !== 'completed'
    || document.duplicate_of || !asking) {
    return { minted: false, reason: lane.refusal };
  }
  const prior = (await client.query(
    `select id from client_evidence_requests
      where firm_id = $1 and client_id = $2 and request_payload->>'document_id' = $3
        and request_payload->>'lane' = $4
      limit 1`,
    [firmId, clientId, documentId, lane.lane]
  )).rows[0];
  if (prior) return { minted: false, reason: 'already_asked', evidence_request_id: prior.id };
  const mintOutcome = {};
  const request = await __createClientEvidenceRequestWithClient({
    client, firmId, clientId, documentId,
    question: asking.buildQuestion({ document, language: preferredOwnerTemplateLanguage(clientRow.profile, clientRow) }),
    evidenceType: SALES_RECOGNITION_ASK_EVIDENCE_TYPE,
    actorId,
    markTransactionNeedsClient: false,
    requestContext: { lane: lane.lane, reason, recognition: asking.recognition },
    mintOutcome
  });
  return { minted: mintOutcome.minted ?? Boolean(request), reason, evidence_request_id: request?.id || null };
};

// The shortfall hook. For each sales invoice the census names as paid short on
// its own posted lines in the period (item.shortfall) and that nobody holds,
// the owner gets ONE question on the sales lane: bank fee or part-payment.
// Called where the runtime turns the census into owner questions (the ALV
// filing start, finland/statutoryDb.js). Not asked when a customer credit note
// of the same customer is itself listed in the period (it may be what the
// difference is; it is asked about on its own) or on a cash book. Never twice
// per invoice. Returns { asked: [ids], skipped: [{ document_id, reason }] }.
export const ensureSettlementShortfallAsksWithClient = async ({ client, firmId, clientId, period, actorId = 'system' } = {}) => {
  const out = { asked: [], skipped: [] };
  const lane = NO_SETTLEMENT_ASK_LANES.sales_invoice;
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, snapshot, envFallback: () => false })) return { ...out, reason: 'flag_off' };
  const clientRow = (await client.query('select jurisdiction, profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
  if (!clientRow || basisOf(clientRow) !== 'accrual') return { ...out, reason: 'not_accrual' };
  const { sales } = await readRecognitionGapWithClient({ client, firmId, clientId, period });
  const creditCustomers = new Set(sales.items.filter((i) => i.kind === 'credit_note').map((i) => strip(i.customer)));
  for (const item of sales.items) {
    if (!item.shortfall) continue;
    if (!item.on_nobody) { out.skipped.push({ document_id: item.document_id, reason: 'already_held' }); continue; }
    if (creditCustomers.has(strip(item.customer))) { out.skipped.push({ document_id: item.document_id, reason: 'customer_credit_note_listed' }); continue; }
    const prior = (await client.query(
      `select id from client_evidence_requests
        where firm_id = $1 and client_id = $2 and request_payload->>'document_id' = $3
          and request_payload->>'lane' = $4 and request_payload->>'recognition' = $5
        limit 1`,
      [firmId, clientId, item.document_id, lane.lane, lane.shortfall.recognition]
    )).rows[0];
    if (prior) { out.skipped.push({ document_id: item.document_id, reason: 'already_asked' }); continue; }
    const document = (await client.query(
      `select id, document_type, customer_name, total_amount::text as total_amount, currency, document_date, reference_number, structured_reference, parse_summary
         from documents where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, item.document_id]
    )).rows[0];
    if (!document) continue;
    const shortfall = { amount: item.shortfall.amount, currency: item.currency, match_ids: item.shortfall.match_ids,
      settled: centsText(toCents(document.total_amount) - toCents(item.shortfall.amount)), period: sales.period };
    const mintOutcome = {};
    const request = await __createClientEvidenceRequestWithClient({
      client, firmId, clientId, documentId: item.document_id,
      question: lane.shortfall.buildQuestion({ document, shortfall, language: preferredOwnerTemplateLanguage(clientRow.profile, clientRow) }),
      evidenceType: SALES_RECOGNITION_ASK_EVIDENCE_TYPE,
      actorId,
      markTransactionNeedsClient: false,
      requestContext: { lane: lane.lane, reason: 'settlement_shortfall', recognition: lane.shortfall.recognition, shortfall },
      mintOutcome
    });
    if (request?.id && (mintOutcome.minted ?? true)) out.asked.push(request.id);
    else out.skipped.push({ document_id: item.document_id, reason: 'collapsed_onto_live_ask' });
  }
  return out;
};

// The owner said a supplier credit note was deducted from bill X: recorded as
// a supplier credit application by the one credit-application writer, with
// its checks. A refusal records nothing.
export const recordOwnerStatedCreditDeductionWithClient = ({ client, firmId, clientId, documentId, billNumber, actorId, evidenceRequestId }) =>
  applyOwnerStatedSupplierCreditWithClient({ client, firmId, clientId, creditDocumentId: documentId, billNumber, actorId, evidenceRequestId });

// The owner said the shortfall they were asked about was a bank fee: the fee
// is recorded on the match it was short on (payload.settlement_shortfall), the
// amount-bearing record the census reads, with an audit receipt. Revalidated
// under a row lock against the ask: the same single decided line, in the
// invoice's currency, and the invoice still short by exactly the amount the
// owner was asked about (integer cents from the stored decimals). Anything
// else records nothing ({ recorded: false, reason }). Posts nothing.
export const recordOwnerStatedBankFeeWithClient = async ({ client, firmId, clientId, documentId, request, actorId = 'system' }) => {
  const asked = obj(obj(request?.request_payload).shortfall);
  const askedCents = toCents(asked.amount);
  const matchIds = Array.isArray(asked.match_ids) ? asked.match_ids : [];
  if (askedCents == null || askedCents <= 0 || matchIds.length !== 1) return { recorded: false, reason: 'shortfall_not_on_one_line' };
  const document = (await client.query(
    `select id, document_type, payment_status, total_amount::text as total_amount, currency from documents
      where firm_id = $1 and client_id = $2 and id = $3 for update`,
    [firmId, clientId, documentId]
  )).rows[0];
  if (!document || document.document_type !== 'sales_invoice' || document.payment_status === 'credit_note') return { recorded: false, reason: 'not_a_sales_invoice' };
  const currency = String(document.currency || '').trim().toUpperCase();
  const decided = (await client.query(
    `select m.id, m.match_amount::text as match_amount, m.payload, t.currency as bank_currency
       from reconciliation_matches m
       left join transactions t on t.firm_id = m.firm_id and t.id = m.bank_transaction_id
      where m.firm_id = $1 and m.client_id = $2 and m.matched_object_id = $3 and m.status in ('confirmed', 'auto_matched')
      order by m.id for update of m`,
    [firmId, clientId, documentId]
  )).rows;
  const line = decided.find((m) => m.id === matchIds[0]);
  if (!line) return { recorded: false, reason: 'line_no_longer_decided' };
  if (String(line.bank_currency || '').trim().toUpperCase() !== currency) return { recorded: false, reason: 'cross_currency' };
  if (decided.some((m) => toCents(m.match_amount) == null)) return { recorded: false, reason: 'amount_unstated' };
  const credits = toCents((await client.query(
    `select coalesce(sum(amount), 0)::text as applied from document_credit_applications
      where firm_id = $1 and invoice_document_id = $2 and status = 'applied'`, [firmId, documentId])).rows[0]?.applied) ?? 0;
  const fees = decided.reduce((sum, m) => sum + recordedBankFeeCents(m, currency), 0);
  const short = (toCents(document.total_amount) ?? 0) - decided.reduce((sum, m) => sum + Math.abs(toCents(m.match_amount)), 0) - credits - fees;
  if (short !== askedCents) return { recorded: false, reason: 'shortfall_changed' };
  const record = { kind: 'bank_fee', amount: centsText(askedCents), currency, source: 'owner_reply',
    evidence_request_id: request.id, actor_id: actorId, at: new Date().toISOString() };
  await client.query(
    `update reconciliation_matches set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('settlement_shortfall', $4::jsonb), updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, line.id, JSON.stringify(record)]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'reconciliation.settlement_shortfall_recorded', 'reconciliation_match', $4, $5::jsonb)`,
    [firmId, clientId, actorId, line.id, JSON.stringify({ document_id: documentId, ...record })]
  );
  return { recorded: true, match_id: line.id, amount: record.amount };
};
