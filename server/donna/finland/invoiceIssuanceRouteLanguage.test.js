// The owner's language on the Finnish invoice-issuance lane (invoices, credit
// notes, quotes). A Finnish company whose owner chose English read every line
// of this lane in Finnish. The language is the one resolver's
// (preferredOwnerTemplateLanguage), passed in by the channel; absent ⇒ the
// lane's historical Finnish copy, unchanged. The invoice and quote documents
// themselves are not owner texts and do not change.
// node --test server/donna/finland/invoiceIssuanceRouteLanguage.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INVOICE_ISSUANCE_ASK_KIND,
  resolveInvoiceIssuanceInbound,
  startInvoiceIssuance,
  summarizeInvoiceDraft,
  summarizeQuoteDraft
} from './invoiceIssuanceRoute.js';
import { classifyCreditNoteIssuance, classifyInvoiceIssuance } from './invoiceIssuance.js';
import { classifyQuoteDecline, classifyQuoteIssuance } from './quoteIssuance.js';
import { COUNTRY_INBOUND_ADAPTER } from './inboundHandlers.js';

const NOW = '2026-07-11T10:00:00.000Z';

const invoiceDraft = ({ alv = false, format = 'pdf', credit = false } = {}) => ({
  invoice: {
    kind: credit ? 'credit_note' : 'invoice',
    invoiceNumber: credit ? '2026004' : '2026003',
    creditsInvoiceNumber: credit ? '2026003' : undefined,
    buyer: { name: 'Asiakas Oy' },
    currency: 'EUR',
    alvExempt: !alv,
    lines: [{ description: 'konsultointi', net: 500, alvRate: alv ? 25.5 : 0 }],
    total: alv ? 627.5 : 500,
    alvTotal: alv ? 127.5 : 0,
    dueDate: '2026-07-25'
  },
  transmit: { channel: 'email', to: 'osto@asiakas-fi.example', format },
  intent: { buyer_name: 'Asiakas Oy' }
});

test('invoice summary: English for an owner who chose English; Finnish unchanged otherwise', () => {
  assert.equal(summarizeInvoiceDraft(invoiceDraft(), { language: 'en' }), [
    'Invoice 2026003 — Asiakas Oy',
    '• konsultointi — 500.00 EUR',
    'Total 500.00 EUR (no VAT, AVL 3 §)',
    'Due date 2026-07-25',
    'I will email the invoice as a PDF to osto@asiakas-fi.example.'
  ].join('\n'));
  assert.equal(summarizeInvoiceDraft(invoiceDraft({ alv: true, format: 'finvoice_xml' }), { language: 'en' }), [
    'Invoice 2026003 — Asiakas Oy',
    '• konsultointi — 500.00 EUR (VAT 25.5 %)',
    'Total 627.50 EUR (incl. VAT 127.50 EUR)',
    'Due date 2026-07-25',
    'I will email the e-invoice to osto@asiakas-fi.example.'
  ].join('\n'));
  assert.equal(summarizeInvoiceDraft(invoiceDraft({ credit: true }), { language: 'en' }).split('\n')[0], 'Credit note 2026004 for invoice 2026003 — Asiakas Oy');
  // Finnish: the historical copy, byte-identical (default and explicit).
  const fi = [
    'Lasku 2026003 — Asiakas Oy',
    '• konsultointi — 500.00 EUR (alv 25,5 %)',
    'Yhteensä 627.50 EUR (sis. ALV 127.50 EUR)',
    'Eräpäivä 2026-07-25',
    'Lähetän verkkolaskun sähköpostilla osoitteeseen osto@asiakas-fi.example.'
  ].join('\n');
  assert.equal(summarizeInvoiceDraft(invoiceDraft({ alv: true, format: 'finvoice_xml' })), fi);
  assert.equal(summarizeInvoiceDraft(invoiceDraft({ alv: true, format: 'finvoice_xml' }), { language: 'fi' }), fi);

  const quoteDraft = {
    quote: { quoteNumber: 'T2026002', buyer: { name: 'Asiakas Oy' }, currency: 'EUR', lines: [{ description: 'verkkosivut', net: 2500 }], total: 2500, validUntil: '2026-08-10' },
    transmit: { to: 'osto@asiakas-fi.example' }
  };
  assert.equal(summarizeQuoteDraft(quoteDraft, { language: 'en' }), [
    'Quote T2026002 — Asiakas Oy',
    '• verkkosivut — 2500.00 EUR',
    'Total 2500.00 EUR (no VAT, AVL 3 §)',
    'Valid until 2026-08-10',
    'I will email the quote as a PDF to osto@asiakas-fi.example.'
  ].join('\n'));
});

const pendingRow = () => ({ id: 'inv-1', status: 'draft_pending_confirmation', kind: 'invoice', invoice_number: 3, draft: invoiceDraft() });
const confirmAsk = { id: 'ask-1', evidence_type: INVOICE_ISSUANCE_ASK_KIND, request_payload: { kind: INVOICE_ISSUANCE_ASK_KIND, invoice_issuance: { phase: 'confirm_request', invoice_id: 'inv-1' } } };
const message = { id: 'wamid.reply-1', timestamp: NOW };

const resolveEn = async ({ replyText, row = pendingRow(), extra = {} }) => {
  const sent = [];
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f', clientId: 'c', ask: confirmAsk, replyText, message, phoneHash: 'ph', actorId: 'owner-1', flagActs: true,
    now: () => NOW,
    getInvoiceImpl: async () => row,
    cancelImpl: async () => ({ ...row, status: 'cancelled' }),
    resolveAsk: async () => {},
    sendText: async ({ text }) => sent.push(text),
    language: 'en',
    ...extra
  });
  return { result, sent };
};

test('invoice confirm replies: a Finnish company whose owner chose English gets English; the invited words are read', async () => {
  const issued = await resolveEn({ replyText: 'yes', extra: { issueImpl: async () => ({ tositeNumber: 12, invoice: { draft: invoiceDraft() } }) } });
  assert.equal(issued.result.action, 'confirm_and_issue');
  assert.deepEqual(issued.sent, ['Invoice 2026003 sent to osto@asiakas-fi.example. Recorded as money the customer owes you (voucher #12).']);
  const cash = await resolveEn({ replyText: 'yes', extra: { issueImpl: async () => ({ cashBasisSkip: true, invoice: { draft: invoiceDraft() } }) } });
  assert.deepEqual(cash.sent, ['Invoice 2026003 sent to osto@asiakas-fi.example. The income is recorded when the payment reaches your account (cash-basis bookkeeping).']);
  const failed = await resolveEn({ replyText: 'yes', extra: { issueImpl: async () => { throw new Error('smtp down'); } } });
  assert.deepEqual(failed.sent, ['Sending the invoice did not go through. Reply “yes” and I will try again, or “no” and I will cancel the invoice.']);
  const cancelled = await resolveEn({ replyText: 'no' });
  assert.equal(cancelled.result.action, 'cancelled');
  assert.deepEqual(cancelled.sent, ['Invoice 2026003 cancelled.']);
  const nudged = await resolveEn({ replyText: 'hmm', extra: { runIntakeImpl: async () => ({ terminal: 'not_invoice' }) } });
  assert.deepEqual(nudged.sent, ['Reply “yes” and I will send the invoice, or “no” and I will cancel it. You can also correct the invoice (for example “change the amount to 600 €”).']);
  const stale = await resolveEn({ replyText: 'yes', row: { ...pendingRow(), status: 'issued' } });
  assert.deepEqual(stale.sent, ['This invoice has already been handled.']);
  for (const run of [issued, cash, failed, cancelled, nudged, stale]) {
    assert.doesNotMatch(run.sent.join(' '), /[äö]|Vastaa|lähetetty|peruttu/, 'no Finnish reaches the English owner');
  }
});

test('the owner language reaches the intake, and its escalation questions are English for an English owner', async () => {
  const seen = [];
  const sent = [];
  await startInvoiceIssuance({
    firmId: 'f', clientId: 'c', messageText: 'invoice Asiakas Oy', actorId: 'owner-1', now: () => NOW,
    runIntakeImpl: async (input) => {
      seen.push(input.language);
      return classifyInvoiceIssuance({ parsed: { ok: true, intent: 'invoice', buyer_name: 'Asiakas Oy', lines: [] }, language: input.language });
    },
    createAsk: async (args) => ({ id: 'ask-esc', ...args }),
    sendText: async ({ text }) => sent.push(text),
    language: 'en'
  });
  assert.deepEqual(seen, ['en']);
  assert.deepEqual(sent, ['Tell me who to invoice and the amount (for example "invoice Asiakas Oy 500 € for consulting").']);

  // Absent a language, the start keeps its Finnish copy and the intake is told Finnish.
  const seenFi = [];
  await startInvoiceIssuance({
    firmId: 'f', clientId: 'c', messageText: 'laskuta', actorId: 'owner-1', now: () => NOW,
    runIntakeImpl: async (input) => { seenFi.push(input.language); return { terminal: 'escalate', escalation: null }; },
    createAsk: async (args) => ({ id: 'ask-esc', ...args }),
    sendText: async () => {}
  });
  assert.deepEqual(seenFi, ['fi']);

  const q = (verdict) => verdict.escalation.question;
  const seller = { businessId: '0737546-2', iban: 'FI2112345600000785' };
  const line = [{ description: 'konsultointi', quantity: 1, unit_price: 500 }];
  assert.equal(q(classifyInvoiceIssuance({ parsed: { ok: false }, language: 'en' })),
    'I couldn\'t make out the invoice instructions. Tell me who to invoice, for what and how much (for example "invoice Asiakas Oy 500 € for consulting").');
  assert.equal(q(classifyInvoiceIssuance({ parsed: { ok: true, intent: 'invoice', buyer_name: 'Asiakas Oy', lines: line }, language: 'en' })),
    'I need your own Business ID (Y-tunnus) for the invoice. What is it?');
  assert.equal(q(classifyInvoiceIssuance({ parsed: { ok: true, intent: 'invoice', buyer_name: 'Asiakas Oy', lines: line }, sellerContext: { businessId: seller.businessId }, language: 'en' })),
    'Which IBAN account should the invoice be paid to? Tell me your account number.');
  assert.equal(q(classifyInvoiceIssuance({ parsed: { ok: true, intent: 'invoice', buyer_name: 'Asiakas Oy', lines: line }, sellerContext: seller, language: 'en' })),
    'Which email address should I send the invoice to?');
  assert.equal(q(classifyInvoiceIssuance({ parsed: { ok: true, intent: 'invoice', buyer_name: 'Asiakas Oy', lines: line }, sellerContext: seller })),
    'Mihin sähköpostiosoitteeseen lähetän laskun?', 'Finnish unchanged by default');
  assert.equal(q(classifyCreditNoteIssuance({ parsed: { ok: true, intent: 'credit_note', credit: {} }, language: 'en' })),
    'Which invoice do you want to credit? Tell me the invoice number (for example "credit invoice 2026001").');
  assert.equal(q(classifyCreditNoteIssuance({ parsed: { ok: true, intent: 'credit_note', credit: { original_invoice_number: '2026009' } }, language: 'en' })),
    'I couldn\'t find a sent invoice with the number 2026009. Please check the number and I will make the credit note.');
  assert.equal(q(classifyQuoteIssuance({ parsed: { ok: true, intent: 'quote', buyer_name: 'Asiakas Oy', lines: line }, language: 'en' })),
    'Which email address should I send the quote to?');
  assert.equal(q(classifyQuoteDecline({ parsed: { ok: true, intent: 'quote_decline', quote: { number: 'T2026009' } }, language: 'en' })),
    'I couldn\'t find a sent quote with the number T2026009. Please check the number.');
});

test('the inbound adapter passes the channel\'s owner language to both Finnish reply lanes, and the media nudges follow it', async () => {
  const [invoiceLane, alvLane] = COUNTRY_INBOUND_ADAPTER.replies;
  const args = (language, extra = {}) => {
    const sent = [];
    return {
      sent,
      run: {
        descriptor: null, sendText: async ({ text }) => sent.push(text), from: '+358000000000',
        config: { copy: {}, provider: 'meta', channel: 'whatsapp', ...(language ? { language } : {}) },
        deps: {}, firmId: 'f', anchor: { clientId: 'c', askId: 'ask-1', phoneHash: 'ph', source: 'ref' }, ask: confirmAsk, text: 'yes',
        message, actorId: 'owner-1', env: {}, recordLedger: async () => {}, ...extra
      }
    };
  };
  const languages = [];
  const capture = (input) => { languages.push(input.language); return { action: 'skipped' }; };
  await invoiceLane.run({ ...args('en').run, deps: { resolveInvoiceIssuanceInbound: capture } });
  await alvLane.run({ ...args('en').run, deps: { resolveAlvReturnInbound: capture } });
  await invoiceLane.run({ ...args(null).run, deps: { resolveInvoiceIssuanceInbound: capture } });
  assert.deepEqual(languages, ['en', 'en', 'fi']);

  const media = { kind: 'image', id: 'm1' };
  const en = args('en', { descriptor: media });
  await invoiceLane.run(en.run);
  await alvLane.run(en.run);
  assert.deepEqual(en.sent, ['Please reply in text: “yes”, “no” or a correction.', 'Please reply in text: “yes” or “no”.']);
  const fi = args('fi', { descriptor: media });
  await invoiceLane.run(fi.run);
  await alvLane.run(fi.run);
  assert.deepEqual(fi.sent, ['Vastaa tekstillä: “kyllä”, “ei” tai korjaus.', 'Vastaa tekstillä: “kyllä” tai “ei”.']);
});
