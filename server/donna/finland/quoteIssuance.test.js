// C-1 — the pure quote (tarjous) layer: intake vocabulary, classify gates,
// KEEP-layer artifacts, the TARJOUS PDF fork, conversion pre-fill, and the
// confirm-send motion. node --test server/donna/finland/quoteIssuance.test.js
// Design: docs/design-donna-finland-c1-quote-send.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_QUOTE_VALIDITY_DAYS,
  QUOTE_ALV_NOTE,
  FINLAND_QUOTES_FLAG_KEY,
  buildQuoteArtifacts,
  classifyQuoteDecline,
  classifyQuoteIssuance,
  formatQuoteNumber,
  mergeQuoteIntoInvoiceIntent,
  normalizeQuoteNumber,
  quoteIsExpired,
  sendConfirmedQuote,
  annotateQuoteForRead,
  summarizeQuoteFunnel
} from './quoteIssuance.js';
import { parseIssuanceResponse, runInvoiceIssuanceIntake } from './invoiceIssuance.js';
import { buildInvoicePdfModel, renderInvoicePdf } from './invoicePdf.js';

const SELLER = { name: 'Koodi Ky', businessId: '0737546-2', iban: 'FI2112345600000785', address: 'Katu 1, Helsinki' };
const QUOTE_INTENT = {
  ok: true,
  intent: 'quote',
  buyer_name: 'Asiakas Oy',
  buyer_email: 'osto@asiakas-fi.example',
  lines: [{ description: 'verkkosivujen uudistus', quantity: 1, unit_price: 2500 }],
  quote: { number: null, validity_days: null, reason: null },
  model: 'claude-opus-4-8-test'
};

const fakeTransport = (payload) => async ({ parse }) => ({ ...parse(JSON.stringify(payload)), model: 'claude-opus-4-8-test' });

// ----- number formatting + expiry -------------------------------------------------

test('formatQuoteNumber carries the T prefix — never mistakable for a laskunumero', () => {
  assert.equal(formatQuoteNumber({ sequence: 1, date: '2026-07-11' }), 'T2026001');
  assert.equal(formatQuoteNumber({ sequence: 42, date: '2026-07-11' }), 'T2026042');
});

test('normalizeQuoteNumber accepts T2026001 / 2026001 / bare int', () => {
  assert.equal(normalizeQuoteNumber('T2026001'), '2026001');
  assert.equal(normalizeQuoteNumber('t2026001'), '2026001');
  assert.equal(normalizeQuoteNumber(' 2026001 '), '2026001');
  assert.equal(normalizeQuoteNumber(''), null);
});

test('quoteIsExpired is a read-time annotation on valid_until', () => {
  assert.equal(quoteIsExpired({ validUntil: '2026-08-10', today: '2026-08-10' }), false);
  assert.equal(quoteIsExpired({ validUntil: '2026-08-10', today: '2026-08-11' }), true);
  assert.equal(quoteIsExpired({ validUntil: null, today: '2026-08-11' }), false);
});

// ----- artifacts (KEEP layer) ------------------------------------------------------

test('buildQuoteArtifacts: footed totals, 30-day default validity, TARJOUS model, no payment block', () => {
  const built = buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' });
  assert.equal(built.ok, true);
  assert.equal(built.artifacts.quote.total, 2500);
  assert.equal(built.artifacts.quote.kind, 'quote');
  assert.equal(built.artifacts.quote.validityDays, DEFAULT_QUOTE_VALIDITY_DAYS);
  assert.equal(built.artifacts.quote.validUntil, '2026-08-10');
  const d = built.artifacts.finvoice.invoiceDetails;
  assert.equal(d.typeCode, 'TARJOUS');
  assert.equal(d.invoiceNumber, 'T2026001');
  assert.equal(d.validUntil, '2026-08-10');
  assert.equal(d.dueDate, null);
  assert.equal(d.exemptionNote, QUOTE_ALV_NOTE);
  assert.deepEqual(built.artifacts.finvoice.paymentDetails, {});
  assert.deepEqual(built.artifacts.transmit, { channel: 'email', to: 'osto@asiakas-fi.example', format: 'pdf' });
});

test('buildQuoteArtifacts honors an owner-stated validity', () => {
  const built = buildQuoteArtifacts({
    intent: { ...QUOTE_INTENT, quote: { validity_days: 14 } },
    sellerContext: SELLER,
    quoteNumber: 'T2026001',
    date: '2026-07-11'
  });
  assert.equal(built.ok, true);
  assert.equal(built.artifacts.quote.validUntil, '2026-07-25');
});

test('buildQuoteArtifacts refuses an empty or non-positive quote', () => {
  const noLines = buildQuoteArtifacts({ intent: { ...QUOTE_INTENT, lines: [] }, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' });
  assert.equal(noLines.ok, false);
  const zero = buildQuoteArtifacts({ intent: { ...QUOTE_INTENT, lines: [{ description: 'x', quantity: 1, unit_price: 0 }] }, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' });
  assert.equal(zero.ok, false);
});

// ----- the TARJOUS PDF fork --------------------------------------------------------

test('buildInvoicePdfModel TARJOUS fork: title, validity meta, no payment block, no viitenumero', () => {
  const built = buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' });
  const model = buildInvoicePdfModel({ finvoice: built.artifacts.finvoice });
  assert.equal(model.ok, true);
  assert.equal(model.model.title, 'TARJOUS');
  assert.equal(model.model.buyerLabel, 'Vastaanottaja');
  assert.deepEqual(model.model.payment, []);
  const labels = model.model.meta.map((m) => m.label);
  assert.deepEqual(labels, ['Tarjouksen numero', 'Päiväys', 'Voimassa asti']);
  assert.equal(model.model.meta[2].value, '10.8.2026');
  assert.equal(JSON.stringify(model.model).includes('Viitenumero'), false);
  assert.equal(model.model.exemptionNote, QUOTE_ALV_NOTE);
});

test('a TARJOUS model without a validity date refuses to render', () => {
  const built = buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' });
  const broken = JSON.parse(JSON.stringify(built.artifacts.finvoice));
  broken.invoiceDetails.validUntil = null;
  const model = buildInvoicePdfModel({ finvoice: broken });
  assert.equal(model.ok, false);
  assert.ok(model.errors.some((e) => e.includes('validity')));
});

test('renderInvoicePdf draws the TARJOUS model', async () => {
  const built = buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' });
  const rendered = await renderInvoicePdf({ finvoice: built.artifacts.finvoice });
  assert.equal(rendered.ok, true);
  assert.ok(rendered.bytes.length > 500);
});

test('the invoice PDF lane stays byte-identical: no TARJOUS strings leak into a LASKU model', () => {
  // A plain invoice finvoice still renders with the invoice requirements —
  // regression guard on the fork.
  const invoiceModel = {
    schema: 'finvoice-3.0',
    sellerParty: { name: 'Koodi Ky', businessId: '1234567-8' },
    buyerParty: { name: 'Asiakas Oy' },
    invoiceDetails: { typeCode: 'INV01', invoiceNumber: '2026001', invoiceDate: '2026-07-11', dueDate: '2026-07-25', currency: 'EUR', total: 500, alvExempt: true, exemptionNote: 'Ei ALV (AVL 3 §).' },
    rows: [{ articleName: 'konsultointi', deliveredQuantity: 1, unitPriceAmount: 500, rowAmount: 500 }],
    paymentDetails: { iban: 'FI4950009420028730', referenceNumber: '20260013', amountToPay: 500, dueDate: '2026-07-25' }
  };
  const model = buildInvoicePdfModel({ finvoice: invoiceModel });
  assert.equal(model.ok, true);
  assert.equal(model.model.title, 'LASKU');
  assert.equal(model.model.buyerLabel, 'Laskutettava');
  assert.ok(model.model.payment.length > 0);
});

// ----- parse: the intent family grows ----------------------------------------------

test('parseIssuanceResponse reads quote / quote_decline intents + the conversion reference', () => {
  const quote = parseIssuanceResponse(JSON.stringify({
    intent: 'quote', buyer_name: 'Asiakas Oy', buyer_email: 'osto@asiakas-fi.example',
    lines: [{ description: 'työ', quantity: 1, unit_price: 100 }],
    quote: { number: null, validity_days: 14, reason: null }
  }));
  assert.equal(quote.ok, true);
  assert.equal(quote.intent, 'quote');
  assert.equal(quote.quote.validity_days, 14);

  const decline = parseIssuanceResponse(JSON.stringify({
    intent: 'quote_decline', quote: { number: 'T2026001', reason: 'liian kallis' }
  }));
  assert.equal(decline.intent, 'quote_decline');
  assert.equal(decline.quote.number, 'T2026001');
  assert.equal(decline.quote.reason, 'liian kallis');

  const conversion = parseIssuanceResponse(JSON.stringify({
    intent: 'invoice', from_quote_number: 'T2026001', lines: []
  }));
  assert.equal(conversion.intent, 'invoice');
  assert.equal(conversion.from_quote_number, 'T2026001');

  // Invoice/credit intents never carry the quote block (closed shape).
  const invoice = parseIssuanceResponse(JSON.stringify({ intent: 'invoice', lines: [] }));
  assert.equal(invoice.quote, null);
  assert.equal(invoice.from_quote_number, null);
});

// ----- classify gates ---------------------------------------------------------------

test('classifyQuoteIssuance escalates the ONE missing piece; a complete instruction drafts', () => {
  const incomplete = classifyQuoteIssuance({ parsed: { ...QUOTE_INTENT, lines: [] }, sellerContext: SELLER, today: '2026-07-11' });
  assert.equal(incomplete.terminal, 'escalate');
  assert.equal(incomplete.escalation.reason, 'incomplete_instruction');

  const noEmail = classifyQuoteIssuance({ parsed: { ...QUOTE_INTENT, buyer_email: null }, sellerContext: SELLER, today: '2026-07-11' });
  assert.equal(noEmail.terminal, 'escalate');
  assert.equal(noEmail.escalation.reason, 'missing_buyer_email');

  const draft = classifyQuoteIssuance({ parsed: QUOTE_INTENT, sellerContext: SELLER, today: '2026-07-11' });
  assert.equal(draft.terminal, 'quote_draft');
  assert.equal(draft.artifacts.transmit.format, 'pdf');
  assert.equal(draft.model, 'claude-opus-4-8-test');
});

test('classifyQuoteIssuance has NO seller-IBAN / Y-tunnus gates (no payment block exists)', () => {
  const draft = classifyQuoteIssuance({ parsed: QUOTE_INTENT, sellerContext: { name: 'Koodi Ky' }, today: '2026-07-11' });
  assert.equal(draft.terminal, 'quote_draft');
});

test('classifyQuoteDecline: missing number / unknown / not-sent escalate; a sent quote declines', () => {
  const parsed = { ok: true, intent: 'quote_decline', quote: { number: 'T2026001', reason: null }, model: 'm' };
  assert.equal(classifyQuoteDecline({ parsed: { ...parsed, quote: { number: null } } }).escalation.reason, 'missing_quote_number');
  assert.equal(classifyQuoteDecline({ parsed, quoteRow: null }).escalation.reason, 'unknown_quote');
  assert.equal(classifyQuoteDecline({ parsed, quoteRow: { status: 'converted', draft: {} } }).escalation.reason, 'quote_not_declinable');
  const ok = classifyQuoteDecline({ parsed, quoteRow: { id: 'q-1', status: 'sent', draft: {} } });
  assert.equal(ok.terminal, 'quote_decline');
  assert.equal(ok.quoteRow.id, 'q-1');
});

// ----- conversion pre-fill ----------------------------------------------------------

const SENT_QUOTE_ROW = {
  id: 'issued-quote-f-c-1',
  status: 'sent',
  valid_until: '2026-08-10',
  draft: {
    quote: {
      quoteNumber: 'T2026001',
      validUntil: '2026-08-10',
      buyer: { name: 'Asiakas Oy', businessId: null },
      lines: [{ description: 'verkkosivujen uudistus', quantity: 1, unitPrice: 2500, net: 2500 }],
      total: 2500
    },
    transmit: { to: 'osto@asiakas-fi.example', format: 'pdf' }
  }
};

test('mergeQuoteIntoInvoiceIntent: the persisted quote is the base; the message wins where it speaks', () => {
  const bare = mergeQuoteIntoInvoiceIntent({ parsed: { intent: 'invoice', lines: [], buyer_name: null, buyer_email: null }, quoteRow: SENT_QUOTE_ROW });
  assert.equal(bare.buyer_name, 'Asiakas Oy');
  assert.equal(bare.buyer_email, 'osto@asiakas-fi.example');
  assert.deepEqual(bare.lines, [{ description: 'verkkosivujen uudistus', quantity: 1, unit_price: 2500 }]);

  const amended = mergeQuoteIntoInvoiceIntent({
    parsed: { intent: 'invoice', lines: [{ description: 'uudistus, sovittu hinta', quantity: 1, unit_price: 2200 }], buyer_name: null, buyer_email: null },
    quoteRow: SENT_QUOTE_ROW
  });
  assert.equal(amended.lines[0].unit_price, 2200);
  assert.equal(amended.buyer_name, 'Asiakas Oy');
});

// ----- the intake dispatcher (flag gate + conversion) --------------------------------

const QUOTE_MODEL_JSON = {
  intent: 'quote',
  buyer_name: 'Asiakas Oy',
  buyer_email: 'osto@asiakas-fi.example',
  lines: [{ description: 'verkkosivujen uudistus', quantity: 1, unit_price: 2500 }],
  quote: { number: null, validity_days: null, reason: null }
};

test('intake: a quote intent with FINLAND_QUOTES off is byte-identical to not_invoice (zero side effects)', async () => {
  let resolved = 0;
  const verdict = await runInvoiceIssuanceIntake({
    messageText: 'tee tarjous Asiakas Oy:lle 2500 € verkkosivuista',
    sellerContext: SELLER,
    today: '2026-07-11',
    apiKey: 'k',
    transport: fakeTransport(QUOTE_MODEL_JSON),
    quotesEnabled: false,
    resolveQuoteContext: async () => { resolved += 1; return { quoteRow: null }; }
  });
  assert.equal(verdict.terminal, 'not_invoice');
  assert.equal(resolved, 0);
});

test('intake: a quote intent with the flag on drafts through classifyQuoteIssuance', async () => {
  const verdict = await runInvoiceIssuanceIntake({
    messageText: 'tee tarjous Asiakas Oy:lle 2500 € verkkosivuista',
    sellerContext: SELLER,
    today: '2026-07-11',
    apiKey: 'k',
    transport: fakeTransport(QUOTE_MODEL_JSON),
    quotesEnabled: true
  });
  assert.equal(verdict.terminal, 'quote_draft');
  assert.equal(verdict.artifacts.finvoice.invoiceDetails.typeCode, 'TARJOUS');
});

test('intake: conversion resolves the quote, pre-fills the invoice, stamps quoteContext', async () => {
  const verdict = await runInvoiceIssuanceIntake({
    messageText: 'tee lasku tarjouksesta T2026001',
    sellerContext: SELLER,
    today: '2026-07-11',
    apiKey: 'k',
    transport: fakeTransport({ intent: 'invoice', from_quote_number: 'T2026001', lines: [] }),
    quotesEnabled: true,
    resolveQuoteContext: async ({ quoteNumber }) => {
      assert.equal(quoteNumber, 'T2026001');
      return { quoteRow: SENT_QUOTE_ROW };
    }
  });
  assert.equal(verdict.terminal, 'draft');
  assert.equal(verdict.intent.buyer_name, 'Asiakas Oy');
  assert.equal(verdict.artifacts.invoice.total, 2500);
  assert.deepEqual(verdict.quoteContext, { fromQuoteId: 'issued-quote-f-c-1', fromQuoteNumber: 'T2026001', expired: false });
});

test('intake: conversion of an expired quote proceeds with expired STATED (the owner decides)', async () => {
  const expiredRow = JSON.parse(JSON.stringify(SENT_QUOTE_ROW));
  expiredRow.draft.quote.validUntil = '2026-07-01';
  const verdict = await runInvoiceIssuanceIntake({
    messageText: 'asiakas hyväksyi tarjouksen T2026001, tee lasku',
    sellerContext: SELLER,
    today: '2026-07-11',
    apiKey: 'k',
    transport: fakeTransport({ intent: 'invoice', from_quote_number: 'T2026001', lines: [] }),
    quotesEnabled: true,
    resolveQuoteContext: async () => ({ quoteRow: expiredRow })
  });
  assert.equal(verdict.terminal, 'draft');
  assert.equal(verdict.quoteContext.expired, true);
});

test('intake: conversion escalates on unknown / already-converted quotes', async () => {
  const unknown = await runInvoiceIssuanceIntake({
    messageText: 'tee lasku tarjouksesta T2026009',
    sellerContext: SELLER,
    today: '2026-07-11',
    apiKey: 'k',
    transport: fakeTransport({ intent: 'invoice', from_quote_number: 'T2026009', lines: [] }),
    quotesEnabled: true,
    resolveQuoteContext: async () => ({ quoteRow: null })
  });
  assert.equal(unknown.terminal, 'escalate');
  assert.equal(unknown.escalation.reason, 'unknown_quote');

  const converted = await runInvoiceIssuanceIntake({
    messageText: 'tee lasku tarjouksesta T2026001',
    sellerContext: SELLER,
    today: '2026-07-11',
    apiKey: 'k',
    transport: fakeTransport({ intent: 'invoice', from_quote_number: 'T2026001', lines: [] }),
    quotesEnabled: true,
    resolveQuoteContext: async () => ({ quoteRow: { ...SENT_QUOTE_ROW, status: 'converted' } })
  });
  assert.equal(converted.terminal, 'escalate');
  assert.equal(converted.escalation.reason, 'quote_not_convertible');
});

test('intake: with quotes disabled a from_quote_number is IGNORED — the invoice classifies as before', async () => {
  let resolved = 0;
  const verdict = await runInvoiceIssuanceIntake({
    messageText: 'laskuta Asiakas Oy 500 € konsultoinnista',
    sellerContext: SELLER,
    today: '2026-07-11',
    apiKey: 'k',
    transport: fakeTransport({
      intent: 'invoice', from_quote_number: 'T2026001',
      buyer_name: 'Asiakas Oy', buyer_email: 'osto@asiakas-fi.example',
      lines: [{ description: 'konsultointi', quantity: 1, unit_price: 500 }]
    }),
    quotesEnabled: false,
    resolveQuoteContext: async () => { resolved += 1; return { quoteRow: SENT_QUOTE_ROW }; }
  });
  assert.equal(resolved, 0);
  assert.equal(verdict.terminal, 'draft');
  assert.equal(verdict.quoteContext, undefined);
});

// ----- sendConfirmedQuote ------------------------------------------------------------

const pendingQuoteRow = () => ({
  id: 'issued-quote-f-c-1',
  status: 'draft_pending_confirmation',
  draft: buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' }).artifacts
});

test('sendConfirmedQuote refuses without authority basis / actor (the outbound rail)', async () => {
  await assert.rejects(
    sendConfirmedQuote({ firmId: 'f', clientId: 'c', row: pendingQuoteRow(), actorId: null, authorityBasis: null, markSentImpl: async () => ({}) }),
    (e) => e.code === 'QUOTE_SEND_AUTHORITY_REQUIRED'
  );
});

test('sendConfirmedQuote refuses a non-pending row and an incomplete draft', async () => {
  await assert.rejects(
    sendConfirmedQuote({ firmId: 'f', clientId: 'c', row: { ...pendingQuoteRow(), status: 'sent' }, authorityBasis: { source: 's' }, actorId: 'o', markSentImpl: async () => ({}) }),
    (e) => e.code === 'ISSUED_QUOTE_NOT_PENDING'
  );
  const incomplete = pendingQuoteRow();
  delete incomplete.draft.finvoice;
  await assert.rejects(
    sendConfirmedQuote({ firmId: 'f', clientId: 'c', row: incomplete, authorityBasis: { source: 's' }, actorId: 'o', markSentImpl: async () => ({}) }),
    (e) => e.code === 'QUOTE_SEND_DRAFT_INCOMPLETE'
  );
});

test('sendConfirmedQuote: transmit then flip, receipt carries actor + basis + model id', async () => {
  const row = pendingQuoteRow();
  row.draft.model = 'claude-opus-4-8-test';
  const calls = [];
  const result = await sendConfirmedQuote({
    firmId: 'f',
    clientId: 'c',
    row,
    authorityBasis: { source: 'owner_whatsapp_quote_confirmation', providerMessageId: 'wamid.1' },
    actorId: 'owner-1',
    sendEmail: async (args) => { calls.push(['email', args]); return { id: 'resend-1' }; },
    markSentImpl: async (args) => { calls.push(['markSent', args]); return { ...row, status: 'sent' }; }
  });
  assert.equal(result.quote.status, 'sent');
  assert.equal(calls[0][0], 'email');
  assert.match(calls[0][1].subject, /^Tarjous T2026001$/);
  assert.match(calls[0][1].attachments[0].filename, /^tarjous-T2026001\.pdf$/);
  assert.equal(calls[1][0], 'markSent');
  assert.equal(calls[1][1].validUntil, '2026-08-10');
  assert.equal(result.transmitReceipt.format, 'pdf');
  assert.equal(result.transmitReceipt.actor_id, 'owner-1');
  assert.equal(result.transmitReceipt.model, 'claude-opus-4-8-test');
  assert.equal(result.transmitReceipt.authority_basis.providerMessageId, 'wamid.1');
});

test('a failed transmit throws — the row never flips (the ask stays open, on the owner)', async () => {
  const row = pendingQuoteRow();
  let flipped = 0;
  await assert.rejects(
    sendConfirmedQuote({
      firmId: 'f',
      clientId: 'c',
      row,
      authorityBasis: { source: 's' },
      actorId: 'o',
      sendEmail: async () => { throw new Error('resend down'); },
      markSentImpl: async () => { flipped += 1; return {}; }
    })
  );
  assert.equal(flipped, 0);
});

test('the flag key is the config-plane constant (never an env pair)', () => {
  assert.equal(FINLAND_QUOTES_FLAG_KEY, 'FINLAND_QUOTES');
});

// ----- C-1c — the quotes read surface (annotate + funnel) --------------------------

const readRow = (over = {}) => ({
  id: 'issued-quote-f-c-2',
  quote_number: 2,
  status: 'sent',
  buyer_name: 'Asiakas Oy',
  valid_until: '2026-07-31',
  draft: { quote: { quoteNumber: 'T2026002', total: 620, currency: 'EUR' } },
  sent_at: '2026-07-01T10:00:00.000Z',
  ...over
});

test('annotate: the pending draft reads as open; expiry annotates ONLY a sent row at read time', () => {
  const open = annotateQuoteForRead({ row: readRow({ status: 'draft_pending_confirmation', valid_until: '2026-01-01' }), today: '2026-07-11' });
  assert.equal(open.read_state, 'open');
  assert.equal(open.expired, false); // a stale draft is on the owner, not "expired"

  const live = annotateQuoteForRead({ row: readRow(), today: '2026-07-11' });
  assert.equal(live.read_state, 'sent');
  assert.equal(live.expired, false);
  assert.equal(live.display_number, 'T2026002');
  assert.equal(live.total, 620);

  const stale = annotateQuoteForRead({ row: readRow({ valid_until: '2026-07-01' }), today: '2026-07-11' });
  assert.equal(stale.expired, true);
  assert.equal(stale.status, 'sent'); // annotation, never a lifecycle state
});

test('annotate: an unknown status surfaces as itself; a draft-less row falls back to T+sequence', () => {
  const odd = annotateQuoteForRead({ row: readRow({ status: 'weird', draft: {} }), today: '2026-07-11' });
  assert.equal(odd.read_state, 'weird');
  assert.equal(odd.display_number, 'T2');
  assert.equal(odd.total, null);
});

test('funnel: counts fold by read state, sent_expired counts inside sent, and the fi line uses count grammar', () => {
  const { quotes, funnel, line_fi } = summarizeQuoteFunnel({
    rows: [
      readRow({ id: 'q1', status: 'draft_pending_confirmation' }),
      readRow({ id: 'q2' }),
      readRow({ id: 'q3', valid_until: '2026-07-01' }),
      readRow({ id: 'q4', status: 'converted' }),
      readRow({ id: 'q5', status: 'declined' })
    ],
    today: '2026-07-11'
  });
  assert.equal(quotes.length, 5);
  assert.deepEqual(funnel, { open: 1, sent: 2, sent_expired: 1, converted: 1, declined: 1, cancelled: 0, total: 5 });
  assert.equal(line_fi, '1 luonnos odottaa vahvistusta · 2 lähetettyä (1 vanhentunut) · 1 laskutettu · 1 hylätty');
});

test('funnel: no quotes ⇒ a quiet envelope (line_fi null, zero counts)', () => {
  const { quotes, funnel, line_fi } = summarizeQuoteFunnel({ rows: [], today: '2026-07-11' });
  assert.deepEqual(quotes, []);
  assert.equal(funnel.total, 0);
  assert.equal(line_fi, null);
});
