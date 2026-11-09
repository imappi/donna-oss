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
// Both questions are written in the owner's language (preferredOwnerTemplateLanguage).
//
// Keep-layer posture: read-only SQL plus pure classification; no model call.

import { invoiceNumbersOf } from './creditNoteApplications.js';
import { clientAccountingBasisFromProfile } from './db/clients.js';
import { __createClientEvidenceRequestWithClient } from './db/asks.js';
import { readClientConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY } from './documentDispositionShape.js';
import { toIsoDay } from './dates.js';
import { preferredOwnerTemplateLanguage } from './db/channels.js';

export const SALES_RECOGNITION_ASK_LANE = 'sales_invoice_recognition';
// Its purchase-side sibling: an uploaded supplier bill with no settling payment.
export const SUPPLIER_BILL_SETTLEMENT_ASK_LANE = 'supplier_bill_settlement';
// The existing doc-anchored settlement lane: resolved by the ledger writer when
// a journal posts against the document (resolveOpenSettlementRequestsForDocument),
// answered through the existing doc-ask reply consumer.
export const SALES_RECOGNITION_ASK_EVIDENCE_TYPE = 'payment_method';
export const SALES_RECOGNITION_BLOCKER = 'unrecognized_sales_documents';
export const PURCHASE_RECOGNITION_BLOCKER = 'unrecognized_purchase_documents';
export const SALES_RECOGNITION_RESTS = Object.freeze([
  'no_settlement', 'settlement_proposed', 'settlement_unposted', 'settled_outside_period'
]);

const DECIDED = new Set(['auto_matched', 'confirmed']);
const LIVE = new Set(['suggested', 'auto_matched', 'confirmed']);
const OPEN_ASK = new Set(['draft', 'open', 'replied']);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const strip = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const day = (v) => (v ? toIsoDay(v) : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

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
    issuedJournalType: 'sales_invoice', noun: 'sales document', amounts: (net, tax, ccy) => `${net} ${ccy} net + ${tax} tax` },
  purchase: { documentType: 'supplier_bill', counterparty: 'vendor_name', itemKey: 'vendor', blocker: PURCHASE_RECOGNITION_BLOCKER,
    issuedJournalType: null, noun: 'supplier document', amounts: (net, tax, ccy) => `${net} ${ccy} expense + ${tax} input tax` }
});
const sideOf = (side) => {
  const known = RECOGNITION_SIDES[side];
  if (!known) throw Object.assign(new Error(`Unknown recognition census side: ${side}`), { code: 'RECOGNITION_SIDE_INVALID' });
  return known;
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
    if (date && journalDates.some(inPeriod)) {
      represented.push({ document_id: doc.id, by: 'settlement_journal' });
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
    if (journalDates.length) rests = 'settled_outside_period';
    else if (decided.length) rests = 'settlement_unposted';
    else if (settling.some((m) => LIVE.has(m.status))) rests = 'settlement_proposed';

    const heldBy = asks.filter((a) => OPEN_ASK.has(a.status)
      && (obj(a.request_payload).document_id === doc.id || (a.transaction_id && settling.some((m) => m.bank_transaction_id === a.transaction_id))))
      .map((a) => ({ id: a.id, status: a.status, evidence_type: a.evidence_type, audience: a.audience || 'client',
        anchor: obj(a.request_payload).document_id === doc.id ? 'document' : 'transaction' }));
    const sign = kind === 'credit_note' ? -1 : 1;
    const gross = round2(sign * Math.abs(Number(doc.total_amount)));
    const taxKnown = doc.tax_amount != null && Number.isFinite(Number(doc.tax_amount));
    const tax = taxKnown ? round2(sign * Math.abs(Number(doc.tax_amount))) : null;
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

// The one honest sentence a draft carries when a side of the census is non-empty.
export const recognitionStatement = (gap) => {
  if (!gap?.items?.length) return null;
  const spec = sideOf(gap.side || 'sales');
  const n = gap.items.length;
  const amounts = gap.totals.map((t) => `${spec.amounts(t.net.toFixed(2), t.tax.toFixed(2), t.currency || '').replace(/\s+/g, ' ')}`
    + `${t.tax_unknown_count ? ` (${t.tax_unknown_count} without a stated tax amount)` : ''}`).join('; ');
  return `${n} uploaded ${spec.noun}${n === 1 ? ' is' : 's are'} not recognised in this period's posted ledger and ${n === 1 ? 'is' : 'are'} excluded from these figures: ${amounts}.`;
};

// The financial-statement draft reason (ledgerReadModel.buildReportDraftState),
// one per side, each under its own code.
export const recognitionDraftReason = (gap) => {
  if (!gap?.items?.length) return null;
  return {
    code: sideOf(gap.side || 'sales').blocker,
    detail: recognitionStatement(gap),
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
    `select id, filename, document_type, document_date, total_amount, tax_amount, currency, customer_name, vendor_name,
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
  // Credit applications are a sales-side writer (creditNoteApplications.js);
  // they never name a supplier bill, so the purchase side reads none.
  const applications = (await client.query(
    `select a.credit_document_id, a.invoice_document_id, a.amount, a.settlement_match_id,
            case when a.credit_document_id = any($3::text[]) then inv.document_date else cr.document_date end as counterpart_date
       from document_credit_applications a
       join documents inv on inv.id = a.invoice_document_id
       join documents cr on cr.id = a.credit_document_id
      where a.firm_id = $1 and a.client_id = $2 and a.status = 'applied'
        and (a.credit_document_id = any($3::text[]) or a.invoice_document_id = any($3::text[]))`,
    [firmId, clientId, docIds]
  )).rows;
  const matches = (await client.query(
    `select id, bank_transaction_id, matched_object_id, status, payload
       from reconciliation_matches
      where firm_id = $1 and client_id = $2 and status in ('suggested', 'auto_matched', 'confirmed')
        and (matched_object_id = any($3::text[])
          or payload->'reminder_obligation'->>'invoice_document_id' = any($3::text[])
          or id = any($4::text[]))`,
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

const amountText = (value, currency, language = 'en') => {
  const fixed = Number(value).toFixed(2);
  return `${language === 'fi' ? fixed.replace('.', ',') : fixed}${currency ? ` ${currency}` : ''}`;
};
// Finnish owners read 12.2.2025, not 2025-02-12.
const dayText = (iso, language = 'en') => {
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
      + 'Onko asiakas maksanut laskun? Jos on, milloin ja mille tilille? Jos lasku on vielä maksamatta, vastaa "vielä maksamatta".';
  }
  const number = printedInvoiceNumber(document) ? ` ${printedInvoiceNumber(document)}` : '';
  const customer = document.customer_name ? ` to ${document.customer_name}` : '';
  const date = day(document.document_date);
  return `Sales invoice${number}${customer} (${amountText(document.total_amount, document.currency)}${date ? `, dated ${date}` : ''}) `
    + 'has no payment on the bank statements Donna holds. Donna does not yet record an unpaid sales invoice in the books, '
    + 'so it is left out of that period\'s sales and VAT figures, and the drafts list it as excluded. '
    + 'Has the customer paid it? If so, when, and into which account? If it is still unpaid, reply "still unpaid".';
};

// The purchase-side question. It invites only answers the doc-ask reply path
// consumes (runOwnerReplyRedisposition): an account and a date (matched once
// that statement arrives, or a statement request for an account Donna lacks),
// or the owner's own cash or personal card (the documentSettlementEntry
// owner-funds journal). A "still unpaid" reply has no consumer there, so it is
// not invited: an unpaid bill keeps this question open, and the ledger post
// against the bill's bank line resolves it (resolveOpenSettlementRequestsForDocument).
export const buildSupplierBillSettlementQuestion = ({ document = {}, language = 'en' } = {}) => {
  if (language === 'fi') {
    return `${finnishHeader({ label: 'Ostolasku', document, counterparty: document.vendor_name })}: `
      + 'Donnalla olevissa tiliotteissa ei näy tälle laskulle maksua. Donna ei vielä kirjaa maksamatonta ostolaskua kirjanpitoon, '
      + 'joten se puuttuu sen kauden kuluista ja arvonlisäverosta. '
      + 'Onko lasku maksettu? Jos on, milloin ja miltä tililtä? Jos maksoit sen omilla rahoillasi käteisellä tai omalla kortillasi, kerro kumpi. '
      + 'Jos lasku on vielä maksamatta, sinun ei tarvitse vastata nyt: kysymys sulkeutuu itsestään, kun maksu näkyy tiliotteella, jonka lähetät.';
  }
  const number = printedInvoiceNumber(document) ? ` ${printedInvoiceNumber(document)}` : '';
  const vendor = document.vendor_name ? ` from ${document.vendor_name}` : '';
  const date = day(document.document_date);
  return `Supplier bill${number}${vendor} (${amountText(document.total_amount, document.currency)}${date ? `, dated ${date}` : ''}) `
    + 'has no payment on the bank statements Donna holds. Donna does not yet record an unpaid supplier bill in the books, '
    + 'so it is missing from that period\'s expenses and VAT. '
    + 'Has it been paid? If so, when, and from which account? If you paid it with your own money, in cash or on a personal card, say which. '
    + 'If it is still unpaid, you don\'t need to reply now: this question closes on its own once the payment shows on a bank statement you send.';
};

// One lane per obligation type that the scoped no-settlement negative leaves
// unrecorded on an accrual book (NO_SETTLEMENT_OBLIGATION_TYPES). The census
// above covers both lanes (side sales and side purchase).
const NO_SETTLEMENT_ASK_LANES = Object.freeze({
  sales_invoice: { lane: SALES_RECOGNITION_ASK_LANE, statsKey: 'sales_recognition_ask', buildQuestion: buildSalesRecognitionQuestion,
    recognition: 'unrecognised_uploaded_sales_invoice', refusal: 'not_an_uploaded_sales_invoice' },
  supplier_bill: { lane: SUPPLIER_BILL_SETTLEMENT_ASK_LANE, statsKey: 'supplier_bill_settlement_ask', buildQuestion: buildSupplierBillSettlementQuestion,
    recognition: 'unrecorded_uploaded_supplier_bill', refusal: 'not_an_uploaded_supplier_bill' }
});
export const noSettlementAskStatsKey = (documentType) => NO_SETTLEMENT_ASK_LANES[documentType]?.statsKey || null;

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
  const clientRow = (await client.query('select profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
  if (!clientRow || basisOf(clientRow) !== 'accrual') return { minted: false, reason: 'not_accrual' };
  const document = (await client.query(
    `select id, document_type, parse_status, duplicate_of, payment_status, customer_name, vendor_name, total_amount, currency,
            document_date, reference_number, structured_reference, parse_summary
       from documents where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, documentId]
  )).rows[0];
  if (!document || document.document_type !== documentType || document.parse_status !== 'completed'
    || document.duplicate_of || String(document.payment_status || '').toLowerCase() === 'credit_note') {
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
    question: lane.buildQuestion({ document, language: preferredOwnerTemplateLanguage(clientRow.profile) }),
    evidenceType: SALES_RECOGNITION_ASK_EVIDENCE_TYPE,
    actorId,
    markTransactionNeedsClient: false,
    requestContext: { lane: lane.lane, reason, recognition: lane.recognition },
    mintOutcome
  });
  return { minted: mintOutcome.minted ?? Boolean(request), reason, evidence_request_id: request?.id || null };
};
