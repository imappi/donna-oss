// C-1 — quote (tarjous) issuance: the pure intake-classify + artifact + send
// layer, the sibling of invoiceIssuance.js on the same spine.
// Design: docs/design-donna-finland-c1-quote-send.md.
//
// A tarjous books NOTHING and is never reconciliation subject matter (D-C1-4):
// there is no ledger writer here, no tositenumero, no viitenumero, no payment
// block. The one lane is a TARJOUS PDF over email (D-C1-3). The ledger loop is
// quote→invoice conversion: mergeQuoteIntoInvoiceIntent pre-fills the FI-10
// invoice intake from the PERSISTED quote draft, and everything after that is
// the unchanged issuance machinery.

import { buildInvoice } from './invoice.js';
import { buildInvoicePdfModel, transmitInvoicePdfEmail } from './invoicePdf.js';
import { toUtcIsoDay } from '../dates.js';

export const FINLAND_QUOTES_FLAG_KEY = 'FINLAND_QUOTES';

export const DEFAULT_QUOTE_VALIDITY_DAYS = 30;

// The non-ALV note phrased for a quote (the invoice's AVL 3 § note says
// "laskulla" — on the invoice — which a tarjous is not).
export const QUOTE_ALV_NOTE = 'Ei arvonlisäverovelvollinen (AVL 3 §). Hintoihin ei lisätä arvonlisäveroa.';

const clean = (v) => String(v ?? '').trim();
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v));

const addDays = (isoDate, days) => {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  // UTC on purpose: calendar arithmetic on a bare day in Date.UTC space.
  return toUtcIsoDay(Date.UTC(y, m - 1, d + Number(days || 0)));
};

// Display quote number: 'T' + year + zero-padded per-client sequence
// ("T2026001"). The T prefix makes a quote number unmistakably NOT a
// laskunumero on every surface (D-C1-1); the sequence comes from
// issued_quote_counters, a series the invoice counter never sees.
export const formatQuoteNumber = ({ sequence, date }) =>
  `T${String(date).slice(0, 4)}${String(sequence).padStart(3, '0')}`;

// Normalize an owner-typed quote reference ("T2026001", "2026001", "tarjous 1")
// for the DB lookup: the display number without the T, or a bare sequence int.
export const normalizeQuoteNumber = (raw) => {
  const s = clean(raw).toUpperCase().replace(/^T/, '');
  return s || null;
};

// Read-time expiry annotation — never stored (D-C1-2).
export const quoteIsExpired = ({ validUntil, today }) =>
  Boolean(validUntil && today && String(today).slice(0, 10) > String(validUntil).slice(0, 10));

// ---------------------------------------------------------------------------------
// buildQuoteArtifacts — the KEEP layer. Reuses buildInvoice for line/total math
// (totals must foot exactly like the invoice this quote converts into), then
// projects a finvoice-SHAPED model with typeCode 'TARJOUS' for the PDF lane.
// The TARJOUS typeCode is internal-only: it is never rendered as Finvoice XML
// and never enters the FI-9 receive parser's world. No payment details exist.
// ---------------------------------------------------------------------------------
export const buildQuoteArtifacts = ({
  intent = {},
  sellerContext = {},
  quoteNumber,
  date
} = {}) => {
  const seller = {
    name: sellerContext.name,
    businessId: sellerContext.businessId || intent.seller_business_id || null,
    address: sellerContext.address || null
  };
  const buyer = {
    name: intent.buyer_name,
    businessId: intent.buyer_business_id || null,
    email: intent.buyer_email || null
  };

  const built = buildInvoice({
    seller: { name: seller.name, businessId: seller.businessId },
    buyer: { name: buyer.name, businessId: buyer.businessId },
    lines: (intent.lines || []).map((l) => ({ description: l.description, quantity: l.quantity || 1, unitPrice: l.unit_price })),
    invoiceNumber: String(quoteNumber),
    date,
    dueDate: null,
    currency: 'EUR',
    alvRegistered: false,
    locale: 'fi'
  });
  if (!built.ok) return { ok: false, errors: built.errors, artifacts: null };
  if (!(built.invoice.total > 0)) {
    return { ok: false, errors: ['quote total must be positive'], artifacts: null };
  }

  const validityDaysRaw = Number(intent.quote?.validity_days);
  const validityDays = Number.isFinite(validityDaysRaw) && validityDaysRaw > 0
    ? Math.round(validityDaysRaw)
    : DEFAULT_QUOTE_VALIDITY_DAYS;
  const validUntil = addDays(date, validityDays);

  const quoteModel = {
    schema: 'tarjous-1.0',
    sellerParty: { name: seller.name, businessId: seller.businessId, address: seller.address },
    buyerParty: { name: buyer.name, businessId: buyer.businessId },
    invoiceDetails: {
      typeCode: 'TARJOUS',
      invoiceNumber: String(quoteNumber),
      invoiceDate: date,
      dueDate: null,
      validUntil,
      currency: built.invoice.currency,
      subtotal: built.invoice.subtotal,
      alvTotal: built.invoice.alvTotal,
      total: built.invoice.total,
      alvExempt: true,
      exemptionNote: QUOTE_ALV_NOTE
    },
    rows: built.invoice.lines.map((l) => ({
      articleName: l.description,
      deliveredQuantity: l.quantity,
      unitPriceAmount: l.unitPrice,
      rowAmount: l.net
    })),
    paymentDetails: {}
  };

  const pdfModel = buildInvoicePdfModel({ finvoice: quoteModel });
  if (!pdfModel.ok) return { ok: false, errors: pdfModel.errors, artifacts: null };

  return {
    ok: true,
    errors: [],
    artifacts: {
      quote: {
        ...built.invoice,
        kind: 'quote',
        quoteNumber: String(quoteNumber),
        validUntil,
        validityDays
      },
      finvoice: quoteModel,
      transmit: { channel: 'email', to: buyer.email, format: 'pdf' }
    }
  };
};

// The owner questions the quote gates ask, per owner language
// (preferredOwnerTemplateLanguage, passed in as `language`). A Finnish lane: an
// absent language keeps the historical Finnish copy, unchanged.
const QUOTE_INTAKE_COPY = Object.freeze({
  fi: Object.freeze({
    unreadable: 'En saanut tarjousohjeesta selvää — kerro kenelle tarjous tehdään, mistä ja mihin hintaan (esim. "tee tarjous Asiakas Oy:lle 2500 € verkkosivuista").',
    incomplete: 'Kerro vielä kenelle tarjous tehdään ja mistä summasta (esim. "tee tarjous Asiakas Oy:lle 2500 € verkkosivuista").',
    missingBuyerEmail: 'Mihin sähköpostiosoitteeseen lähetän tarjouksen?',
    artifactInvalid: (errors) => `Tarjouksessa on korjattavaa: ${errors}`,
    declineUnreadable: 'En saanut viestistä selvää — minkä tarjouksen asiakas hylkäsi? Kerro tarjouksen numero (esim. "asiakas hylkäsi tarjouksen T2026001").',
    missingQuoteNumber: 'Minkä tarjouksen asiakas hylkäsi? Kerro tarjouksen numero (esim. "T2026001").',
    unknownSentQuote: (number) => `En löytänyt lähetettyä tarjousta numerolla ${number}. Tarkista numero.`,
    notDeclinable: (number, status) => `Tarjousta ${number} ei voi merkitä hylätyksi (tila: ${status}).`
  }),
  en: Object.freeze({
    unreadable: 'I couldn\'t make out the quote instructions. Tell me who the quote is for, what it covers and the price (for example "make a quote to Asiakas Oy for 2500 € for a website").',
    incomplete: 'Tell me who the quote is for and the amount (for example "make a quote to Asiakas Oy for 2500 € for a website").',
    missingBuyerEmail: 'Which email address should I send the quote to?',
    artifactInvalid: (errors) => `The quote needs fixing: ${errors}`,
    declineUnreadable: 'I couldn\'t make out the message. Which quote did the customer turn down? Tell me the quote number (for example "the customer turned down quote T2026001").',
    missingQuoteNumber: 'Which quote did the customer turn down? Tell me the quote number (for example "T2026001").',
    unknownSentQuote: (number) => `I couldn't find a sent quote with the number ${number}. Please check the number.`,
    notDeclinable: (number, status) => `Quote ${number} can't be marked as declined (status: ${status}).`
  })
});
const quoteIntakeCopyFor = (language) => QUOTE_INTAKE_COPY[language] || QUOTE_INTAKE_COPY.fi;

// ---------------------------------------------------------------------------------
// classifyQuoteIssuance — DETERMINISTIC (the quote twin of
// classifyInvoiceIssuance). Gates escalate the ONE question only the owner can
// answer. No seller-IBAN / seller-Y-tunnus gates: a quote carries no payment
// block and no OVT lane exists to want the buyer's Y-tunnus.
// ---------------------------------------------------------------------------------
export const classifyQuoteIssuance = ({ parsed = {}, sellerContext = {}, today = null, timestamp = null, language = 'fi' } = {}) => {
  const copy = quoteIntakeCopyFor(language);
  today = today || (timestamp ? String(timestamp).slice(0, 10) : null);
  if (!parsed.ok || parsed.unextractable_reason) {
    return { terminal: 'escalate', escalation: { reason: parsed.unextractable_reason || 'unreadable', question: copy.unreadable }, model: parsed.model || null };
  }
  if (parsed.intent !== 'quote') return { terminal: 'not_invoice', model: parsed.model || null };

  const ask = (reason, question) => ({ terminal: 'escalate', escalation: { reason, question }, intent: parsed, model: parsed.model || null });

  if (!isNonEmptyString(parsed.buyer_name) || !(parsed.lines || []).length || !(parsed.lines || []).every((l) => isNonEmptyString(l.description) && Number.isFinite(l.unit_price) && l.unit_price > 0)) {
    return ask('incomplete_instruction', copy.incomplete);
  }
  if (!isEmail(parsed.buyer_email)) {
    return ask('missing_buyer_email', copy.missingBuyerEmail);
  }

  // KEEP-layer dry run with a placeholder number: an unfooted or unrenderable
  // draft never reaches a confirm ask. The real number is allocated at persist
  // time and the artifacts rebuilt with it (same validated inputs).
  const dryRun = buildQuoteArtifacts({
    intent: parsed,
    sellerContext,
    quoteNumber: formatQuoteNumber({ sequence: 1, date: today }),
    date: today
  });
  if (!dryRun.ok) {
    return ask('artifact_invalid', copy.artifactInvalid(dryRun.errors.join('; ')));
  }
  return { terminal: 'quote_draft', intent: parsed, artifacts: dryRun.artifacts, model: parsed.model || null };
};

// ---------------------------------------------------------------------------------
// classifyQuoteDecline — DETERMINISTIC. The owner REPORTS the customer's
// rejection ("asiakas hylkäsi tarjouksen T2026001"); nothing is sent. The
// caller supplies the resolved quote row (or null).
// ---------------------------------------------------------------------------------
export const classifyQuoteDecline = ({ parsed = {}, quoteRow = null, language = 'fi' } = {}) => {
  const copy = quoteIntakeCopyFor(language);
  if (!parsed.ok || parsed.unextractable_reason) {
    return { terminal: 'escalate', escalation: { reason: parsed.unextractable_reason || 'unreadable', question: copy.declineUnreadable }, model: parsed.model || null };
  }
  if (parsed.intent !== 'quote_decline') return { terminal: 'not_invoice', model: parsed.model || null };

  const ask = (reason, question) => ({ terminal: 'escalate', escalation: { reason, question }, intent: parsed, model: parsed.model || null });

  const number = parsed.quote?.number || null;
  if (!isNonEmptyString(number)) {
    return ask('missing_quote_number', copy.missingQuoteNumber);
  }
  if (!quoteRow) {
    return ask('unknown_quote', copy.unknownSentQuote(number));
  }
  if (quoteRow.status !== 'sent') {
    return ask('quote_not_declinable', copy.notDeclinable(quoteRow.draft?.quote?.quoteNumber || number, quoteRow.status));
  }
  return {
    terminal: 'quote_decline',
    intent: parsed,
    quoteRow,
    reason: parsed.quote?.reason || null,
    model: parsed.model || null
  };
};

// ---------------------------------------------------------------------------------
// mergeQuoteIntoInvoiceIntent — the conversion pre-fill (D-C1-5). The PERSISTED
// quote draft is the base (render-the-persisted-verdict); the owner's message
// fields win only where they carry a value (the normal correction semantics).
// Pure; the FI-10 classify + dry-run re-validate everything downstream.
// ---------------------------------------------------------------------------------
export const mergeQuoteIntoInvoiceIntent = ({ parsed = {}, quoteRow = null } = {}) => {
  const q = quoteRow?.draft?.quote || {};
  const quoteLines = Array.isArray(q.lines)
    ? q.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unitPrice }))
    : [];
  return {
    ...parsed,
    buyer_name: parsed.buyer_name || q.buyer?.name || null,
    buyer_business_id: parsed.buyer_business_id || q.buyer?.businessId || null,
    buyer_email: parsed.buyer_email || quoteRow?.draft?.transmit?.to || null,
    lines: (parsed.lines || []).length ? parsed.lines : quoteLines
  };
};

// ---------------------------------------------------------------------------------
// sendConfirmedQuote — the ONE confirm motion for a quote: transmit the TARJOUS
// PDF (refuses without authority basis + actor — the outbound rail), then the
// lifecycle flip with the receipt. Any throw leaves the row a pending draft and
// the confirm ask open (still on the owner) — the next "kyllä" retries. There
// is NO post leg: a tarjous books nothing (D-C1-4).
// ---------------------------------------------------------------------------------
export const sendConfirmedQuote = async ({
  firmId,
  clientId,
  row,
  authorityBasis = null,
  actorId = null,
  transmitPdfImpl = transmitInvoicePdfEmail,
  sendEmail,
  markSentImpl
} = {}) => {
  if (!row || row.status !== 'draft_pending_confirmation') {
    const error = new Error('Only a pending quote draft can be sent.');
    error.statusCode = 409;
    error.code = 'ISSUED_QUOTE_NOT_PENDING';
    throw error;
  }
  if (!authorityBasis || !authorityBasis.source || !actorId) {
    const error = new Error('Sending a quote requires the owner\'s confirmation receipt (authority basis) and actor id.');
    error.code = 'QUOTE_SEND_AUTHORITY_REQUIRED';
    throw error;
  }
  const draft = row.draft || {};
  if (!draft.quote || !draft.finvoice || draft.finvoice?.invoiceDetails?.typeCode !== 'TARJOUS' || !isEmail(draft.transmit?.to)) {
    const error = new Error('The persisted quote draft is incomplete; it cannot be sent.');
    error.code = 'QUOTE_SEND_DRAFT_INCOMPLETE';
    throw error;
  }
  if (typeof markSentImpl !== 'function') {
    const error = new Error('sendConfirmedQuote requires an injected markSentImpl.');
    error.code = 'QUOTE_SEND_NO_IO';
    throw error;
  }

  const { receipt } = await transmitPdfImpl({
    finvoice: draft.finvoice,
    to: draft.transmit.to,
    authorityBasis,
    actorId,
    model: draft.model || null,
    sendEmail
  });

  const updated = await markSentImpl({
    firmId,
    clientId,
    quoteId: row.id,
    validUntil: draft.quote.validUntil || null,
    transmitReceipt: receipt,
    authorityBasis,
    actorId
  });

  return { quote: updated, transmitReceipt: receipt };
};

// ---------------------------------------------------------------------------------
// C-1c — the quotes read surface (D-C1-8's named follow-up). Pure: annotate the
// persisted issued_quotes rows with the read-time state and fold them into the
// open/sent/converted funnel. Expiry computes HERE at read time and only
// annotates a SENT row (never stored, never a lifecycle state — D-C1-2); every
// other state is the row's own closed lifecycle, labelled verbatim.
// ---------------------------------------------------------------------------------

// The closed lifecycle → the funnel's read-state vocabulary. Only the pending
// draft renames (open — it is ON THE OWNER via its accompanying ask); an
// unknown status renders as itself, surfacing beats prettiness.
const QUOTE_READ_STATES = {
  draft_pending_confirmation: 'open',
  sent: 'sent',
  converted: 'converted',
  declined: 'declined',
  cancelled: 'cancelled'
};

export const annotateQuoteForRead = ({ row = {}, today = null } = {}) => {
  const status = String(row.status || '');
  const readState = QUOTE_READ_STATES[status] || status;
  const draftQuote = row.draft?.quote || {};
  const total = Number(draftQuote.total);
  return {
    id: row.id || null,
    quote_number: row.quote_number ?? null,
    display_number: draftQuote.quoteNumber
      || (row.quote_number != null ? `T${row.quote_number}` : null),
    status,
    read_state: readState,
    buyer_name: row.buyer_name || null,
    total: Number.isFinite(total) ? total : null,
    currency: draftQuote.currency || 'EUR',
    valid_until: row.valid_until || null,
    expired: readState === 'sent' && quoteIsExpired({ validUntil: row.valid_until, today }),
    sent_at: row.sent_at || null,
    converted_invoice_id: row.converted_invoice_id || null,
    converted_at: row.converted_at || null,
    declined_at: row.declined_at || null,
    cancelled_at: row.cancelled_at || null
  };
};

// Finnish count grammar: 1 takes the singular, >1 the partitive.
const fiCount = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const summarizeQuoteFunnel = ({ rows = [], today = null } = {}) => {
  const quotes = rows.map((row) => annotateQuoteForRead({ row, today }));
  const funnel = { open: 0, sent: 0, sent_expired: 0, converted: 0, declined: 0, cancelled: 0, total: quotes.length };
  for (const q of quotes) {
    if (Object.prototype.hasOwnProperty.call(funnel, q.read_state)) funnel[q.read_state] += 1;
    if (q.expired) funnel.sent_expired += 1;
  }
  const line_fi = quotes.length
    ? [
        funnel.open ? `${fiCount(funnel.open, 'luonnos', 'luonnosta')} odottaa vahvistusta` : '',
        funnel.sent
          ? `${fiCount(funnel.sent, 'lähetetty', 'lähetettyä')}${funnel.sent_expired ? ` (${fiCount(funnel.sent_expired, 'vanhentunut', 'vanhentunutta')})` : ''}`
          : '',
        funnel.converted ? fiCount(funnel.converted, 'laskutettu', 'laskutettua') : '',
        funnel.declined ? fiCount(funnel.declined, 'hylätty', 'hylättyä') : '',
        funnel.cancelled ? fiCount(funnel.cancelled, 'peruttu', 'peruttua') : ''
      ].filter(Boolean).join(' · ')
    : null;
  return { quotes, funnel, line_fi };
};
