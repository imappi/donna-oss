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
// The purchase side has the same hole: an uploaded supplier bill on an accrual
// book with no settling payment is journaled nowhere either. The same hook puts
// it on the owner through its own lane (supplier_bill_settlement), sharing the
// ask primitive and the never-twice check. There is no purchase-side census yet,
// so the drafts do not yet list such bills as excluded.
//
// Both questions are written in the owner's language (preferredOwnerTemplateLanguage)
// and invite the same two kinds of answer: how it was paid, or that it is
// still unpaid. "Still unpaid" is a real answer on both lanes: the owner-reply
// reader is told so (stillOpen below) and keeps the ask on the owner, re-asked
// after stillOpen.recheckDays instead of sending a clarification.
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

// classifySalesRecognitionGap — pure. Every in-scope uploaded sales invoice or
// credit note either is represented in the requested period's posted ledger or
// is an item here, with the state it rests in and who (if anyone) holds it.
export const classifySalesRecognitionGap = ({
  basis,
  period,
  documents = [],
  matches = [],
  transactionJournals = [],
  issuedJournals = [],
  applications = [],
  asks = []
} = {}) => {
  const applies = basis === 'accrual' || basis === 'unresolved';
  const base = { applies, basis, period: period ? { starts_on: period.starts_on, ends_on: period.ends_on } : null };
  if (!applies) return { ...base, status: 'not_applicable', items: [], totals: [] };

  const inPeriod = (d) => Boolean(d) && d >= period.starts_on && d <= period.ends_on;
  const journalsByTx = new Map();
  for (const j of transactionJournals) {
    const list = journalsByTx.get(j.source_id) || [];
    list.push(day(j.journal_date));
    journalsByTx.set(j.source_id, list);
  }
  const issuedNumbers = new Set(issuedJournals.map((j) => strip(j.source_id)).filter(Boolean));
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const items = [];

  for (const doc of documents) {
    const payload = obj(doc.payload);
    const reminder = obj(payload.reminder_obligation);
    // A reminder's principal is its original invoice; it is not a second sale.
    if (reminder.status === 'applied' && reminder.reminder_document_id === doc.id) continue;
    const date = day(doc.document_date);
    if (date && !inPeriod(date)) continue;
    const kind = String(doc.payment_status || '').trim().toLowerCase() === 'credit_note' ? 'credit_note' : 'invoice';
    const numbers = invoiceNumbersOf(doc);
    // The issued-invoice twin carries the revenue under its own journal.
    if (kind === 'invoice' && numbers.some((n) => issuedNumbers.has(n))) continue;

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
    const journalDates = txIds.flatMap((id) => journalsByTx.get(id) || []).filter(Boolean).sort();
    if (date && journalDates.some(inPeriod)) continue;

    // An invoice and the credit notes that cancel it in full, all inside the
    // period, net to nothing there: no settlement line exists to carry them.
    const credits = applications.filter((a) => (kind === 'invoice' ? a.invoice_document_id === doc.id : a.credit_document_id === doc.id));
    if (date && !txIds.length && credits.length && credits.every((a) => !a.settlement_match_id && inPeriod(day(a.counterpart_date)))
      && (kind === 'credit_note' || round2(credits.reduce((s, a) => s + Number(a.amount), 0)) === round2(Math.abs(Number(doc.total_amount))))) continue;

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
    items.push({
      document_id: doc.id,
      filename: doc.filename || null,
      kind,
      document_date: date,
      period_scope: date ? 'in_period' : 'period_unknown',
      customer: doc.customer_name || null,
      invoice_numbers: numbers,
      currency: String(doc.currency || '').trim().toUpperCase() || null,
      gross,
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
  return { ...base, status: items.length ? 'excluded' : 'none', items, totals: [...byCurrency.values()] };
};

const moneyText = (t) => `${t.net.toFixed(2)} ${t.currency || ''} net + ${t.tax.toFixed(2)} tax`.replace(/\s+/g, ' ');

// The one honest sentence a draft carries when the census is non-empty.
export const salesRecognitionStatement = (gap) => {
  if (!gap?.items?.length) return null;
  const n = gap.items.length;
  const amounts = gap.totals.map((t) => `${moneyText(t)}${t.tax_unknown_count ? ` (${t.tax_unknown_count} without a stated tax amount)` : ''}`).join('; ');
  return `${n} uploaded sales document${n === 1 ? ' is' : 's are'} not recognised in this period's posted ledger and ${n === 1 ? 'is' : 'are'} excluded from these figures: ${amounts}.`;
};

// The financial-statement draft reason (ledgerReadModel.buildReportDraftState).
export const salesRecognitionDraftReason = (gap) => {
  if (!gap?.items?.length) return null;
  return {
    code: SALES_RECOGNITION_BLOCKER,
    detail: salesRecognitionStatement(gap),
    count: gap.items.length,
    totals: gap.totals,
    document_ids: gap.items.map((i) => i.document_id)
  };
};

export const readSalesRecognitionGapWithClient = async ({ client, firmId, clientId, period } = {}) => {
  if (!period?.starts_on || !period?.ends_on) {
    throw Object.assign(new Error('A period is required for the sales recognition census.'), { code: 'SALES_RECOGNITION_PERIOD_REQUIRED', statusCode: 400 });
  }
  const clientRow = (await client.query('select profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
  const basis = clientRow ? basisOf(clientRow) : 'unresolved';
  if (basis === 'cash') return classifySalesRecognitionGap({ basis, period });
  const documents = (await client.query(
    `select id, filename, document_type, document_date, total_amount, tax_amount, currency, customer_name,
            payment_status, reference_number, structured_reference, parse_summary, payload
       from documents
      where firm_id = $1 and client_id = $2
        and document_type = 'sales_invoice'
        and parse_status = 'completed'
        and duplicate_of is null
        and total_amount is not null
        and (document_date is null or (document_date >= $3::date and document_date <= $4::date))
      order by document_date nulls last, id`,
    [firmId, clientId, period.starts_on, period.ends_on]
  )).rows;
  if (!documents.length) return classifySalesRecognitionGap({ basis, period });
  const docIds = documents.map((d) => d.id);
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
  const transactionJournals = txIds.length ? (await client.query(
    `select source_id, journal_date from ledger_journals
      where firm_id = $1 and client_id = $2 and source_type = 'transaction' and source_id = any($3::text[])
        and status in ('posted', 'closed') and reversed_at is null`,
    [firmId, clientId, txIds]
  )).rows : [];
  const issuedJournals = (await client.query(
    `select source_id from ledger_journals
      where firm_id = $1 and client_id = $2 and source_type = 'sales_invoice'
        and status in ('posted', 'closed') and reversed_at is null`,
    [firmId, clientId]
  )).rows;
  const asks = (await client.query(
    `select id, status, evidence_type, audience, transaction_id, request_payload
       from client_evidence_requests
      where firm_id = $1 and client_id = $2 and status in ('draft', 'open', 'replied')
        and (request_payload->>'document_id' = any($3::text[]) or transaction_id = any($4::text[]))`,
    [firmId, clientId, docIds, txIds]
  )).rows;
  return classifySalesRecognitionGap({ basis, period, documents, matches, transactionJournals, issuedJournals, applications, asks });
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

// How long an ask the owner answered "still unpaid" rests before the re-ask
// clock asks again (its due_at). A month: the next monthly statement normally
// arrives in that time, and a payment posted against the document closes the
// ask before then. Not the 7-day nudge: the owner did answer.
export const NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS = 30;

// One lane per obligation type that the scoped no-settlement negative leaves
// unrecorded on an accrual book (NO_SETTLEMENT_OBLIGATION_TYPES). The census
// above covers the sales lane only; the purchase-side census is not built yet.
// stillOpen is the lane's "still unpaid" answer, told to the owner-reply
// reader (documentDispositionLlm.runOwnerReplyRedisposition): what it means
// on this lane, and when to ask again.
const NO_SETTLEMENT_ASK_LANES = Object.freeze({
  sales_invoice: { lane: SALES_RECOGNITION_ASK_LANE, statsKey: 'sales_recognition_ask', buildQuestion: buildSalesRecognitionQuestion,
    recognition: 'unrecognised_uploaded_sales_invoice', refusal: 'not_an_uploaded_sales_invoice',
    stillOpen: Object.freeze({ meaning: 'the customer has not paid this sales invoice yet; the receivable is still open',
      recheckDays: NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS }) },
  supplier_bill: { lane: SUPPLIER_BILL_SETTLEMENT_ASK_LANE, statsKey: 'supplier_bill_settlement_ask', buildQuestion: buildSupplierBillSettlementQuestion,
    recognition: 'unrecorded_uploaded_supplier_bill', refusal: 'not_an_uploaded_supplier_bill',
    stillOpen: Object.freeze({ meaning: 'the business has not paid this supplier bill yet; the payable is still open',
      recheckDays: NO_SETTLEMENT_STILL_OPEN_RECHECK_DAYS }) }
});
export const noSettlementAskStatsKey = (documentType) => NO_SETTLEMENT_ASK_LANES[documentType]?.statsKey || null;
// The "still unpaid" answer an ask's lane (request_payload.lane) accepts, or
// null for every other lane.
export const noSettlementAskStillOpen = (askLane) => Object.values(NO_SETTLEMENT_ASK_LANES)
  .find((l) => l.lane === askLane)?.stillOpen || null;

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
