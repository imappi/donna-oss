// C-1 — the quote (tarjous) phases of the WhatsApp issuance state machine:
// draft → confirm ask → kyllä/ei/correction, the decline motion, and the
// two-terminal-states discipline (every quote rests terminal-with-receipt or
// under an OPEN ask on the owner).
// node --test server/donna/finland/quoteIssuanceRoute.test.js
// Design: docs/design-donna-finland-c1-quote-send.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INVOICE_ISSUANCE_ASK_KIND,
  resolveInvoiceIssuanceInbound,
  startInvoiceIssuance,
  summarizeQuoteDraft
} from './invoiceIssuanceRoute.js';
import { buildQuoteArtifacts } from './quoteIssuance.js';

const NOW = '2026-07-11T10:00:00.000Z';
const SELLER = { name: 'Koodi Ky', businessId: '0737546-2', iban: 'FI2112345600000785' };
const QUOTE_INTENT = {
  ok: true,
  intent: 'quote',
  buyer_name: 'Asiakas Oy',
  buyer_email: 'osto@asiakas-fi.example',
  lines: [{ description: 'verkkosivujen uudistus', quantity: 1, unit_price: 2500 }],
  quote: { number: null, validity_days: null, reason: null },
  model: 'claude-opus-4-8-test'
};

const quoteDraftVerdict = () => ({
  terminal: 'quote_draft',
  intent: QUOTE_INTENT,
  artifacts: buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026001', date: '2026-07-11' }).artifacts,
  model: 'claude-opus-4-8-test'
});

// A fake quote store: createQuoteDraftImpl allocates sequence 2 and persists
// EXACTLY what the route's buildDraft returns (the DB-writer contract).
const makeQuoteStore = () => {
  const rows = new Map();
  return {
    rows,
    createQuoteDraftImpl: async ({ firmId, clientId, buildDraft }) => {
      const built = buildDraft({ sequence: 2 });
      const row = {
        id: `issued-quote-${firmId}-${clientId}-2`,
        quote_number: 2,
        status: 'draft_pending_confirmation',
        draft: built.draft,
        buyer_name: built.buyerName,
        buyer_email: built.buyerEmail,
        valid_until: built.validUntil
      };
      rows.set(row.id, row);
      return row;
    },
    supersedeQuoteDraftImpl: async ({ quoteId, draft, buyerName, buyerEmail, validUntil }) => {
      const row = rows.get(quoteId);
      if (!row || row.status !== 'draft_pending_confirmation') throw Object.assign(new Error('not pending'), { code: 'ISSUED_QUOTE_TRANSITION_REFUSED' });
      Object.assign(row, { draft, buyer_name: buyerName, buyer_email: buyerEmail, valid_until: validUntil });
      return row;
    },
    cancelQuoteImpl: async ({ quoteId }) => {
      const row = rows.get(quoteId);
      row.status = 'cancelled';
      return row;
    },
    markQuoteSentImpl: async ({ quoteId, transmitReceipt }) => {
      const row = rows.get(quoteId);
      row.status = 'sent';
      row.transmit_receipt = transmitReceipt;
      return row;
    },
    getQuoteImpl: async ({ quoteId }) => rows.get(quoteId) || null
  };
};

const collectText = () => {
  const sent = [];
  return { sent, sendText: async ({ text }) => sent.push(text) };
};

const openAsks = [];
const makeCreateAsk = () => {
  openAsks.length = 0;
  return async (args) => {
    const ask = { id: `ask-${openAsks.length + 1}`, ...args };
    openAsks.push(ask);
    return ask;
  };
};

// ----- start: the quote draft + confirm ask -----------------------------------------

test('start: a quote_draft verdict persists through the QUOTE writer and asks the quote confirm', async () => {
  const store = makeQuoteStore();
  const { sent, sendText } = collectText();
  const createAsk = makeCreateAsk();
  const result = await startInvoiceIssuance({
    firmId: 'f',
    clientId: 'c',
    messageText: 'tee tarjous Asiakas Oy:lle 2500 € verkkosivuista',
    actorId: 'owner-1',
    sellerContext: SELLER,
    now: () => NOW,
    runIntakeImpl: async ({ quotesEnabled }) => {
      assert.equal(quotesEnabled, true);
      return quoteDraftVerdict();
    },
    quotesEnabled: true,
    createQuoteDraftImpl: store.createQuoteDraftImpl,
    createAsk,
    sendText
  });
  assert.equal(result.action, 'request_quote_confirmation');
  const row = store.rows.get('issued-quote-f-c-2');
  // Rebuilt WITH the allocated number — not the classify placeholder.
  assert.equal(row.draft.quote.quoteNumber, 'T2026002');
  assert.equal(row.draft.finvoice.invoiceDetails.typeCode, 'TARJOUS');
  assert.equal(row.valid_until, '2026-08-10');
  const ask = openAsks[0];
  assert.equal(ask.kind, INVOICE_ISSUANCE_ASK_KIND);
  assert.equal(ask.requestPayload.invoice_issuance.kind, 'quote_confirm_request');
  assert.equal(ask.requestPayload.invoice_issuance.quote_id, row.id);
  assert.match(sent[0], /Tarjous T2026002 — Asiakas Oy/);
  assert.match(sent[0], /Voimassa 2026-08-10 asti/);
  assert.match(sent[0], /kyllä/);
});

test('start: a quote intent without the quote writer wired falls back to the standard nudge', async () => {
  const result = await startInvoiceIssuance({
    firmId: 'f',
    clientId: 'c',
    messageText: 'tee tarjous …',
    actorId: 'owner-1',
    now: () => NOW,
    runIntakeImpl: async () => quoteDraftVerdict(),
    quotesEnabled: true
    // no createQuoteDraftImpl
  });
  assert.equal(result.action, 'not_invoice');
});

test('start: a quote_decline verdict flips the sent quote with a receipt text (no confirm needed — reporting, not outbound)', async () => {
  const { sent, sendText } = collectText();
  const declined = [];
  const result = await startInvoiceIssuance({
    firmId: 'f',
    clientId: 'c',
    messageText: 'asiakas hylkäsi tarjouksen T2026002',
    actorId: 'owner-1',
    now: () => NOW,
    message: { id: 'wamid.5', timestamp: NOW },
    phoneHash: 'ph-1',
    runIntakeImpl: async () => ({
      terminal: 'quote_decline',
      quoteRow: { id: 'issued-quote-f-c-2', status: 'sent', draft: { quote: { quoteNumber: 'T2026002' } } },
      reason: 'liian kallis'
    }),
    quotesEnabled: true,
    declineQuoteImpl: async (args) => { declined.push(args); return { draft: { quote: { quoteNumber: 'T2026002' } }, status: 'declined' }; },
    sendText
  });
  assert.equal(result.action, 'quote_declined');
  assert.equal(declined[0].quoteId, 'issued-quote-f-c-2');
  assert.equal(declined[0].reason, 'liian kallis');
  assert.equal(declined[0].authorityBasis.source, 'owner_whatsapp_quote_confirmation');
  assert.match(sent[0], /Merkitsin tarjouksen T2026002 hylätyksi\./);
});

// ----- resolve: the quote confirm phase ----------------------------------------------

const quoteAsk = (quoteId) => ({
  id: 'ask-q-1',
  kind: INVOICE_ISSUANCE_ASK_KIND,
  request_payload: {
    kind: INVOICE_ISSUANCE_ASK_KIND,
    invoice_issuance: { kind: 'quote_confirm_request', phase: 'quote_confirm_request', quote_id: quoteId, summary: 's' }
  }
});

const seedPendingQuote = (store) => {
  const draft = {
    ...buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026002', date: '2026-07-11' }).artifacts,
    intent: QUOTE_INTENT,
    sellerContext: SELLER,
    model: 'claude-opus-4-8-test'
  };
  const row = { id: 'issued-quote-f-c-2', quote_number: 2, status: 'draft_pending_confirmation', draft };
  store.rows.set(row.id, row);
  return row;
};

test('resolve kyllä: transmit + flip + ask closed + the conversion tip in the receipt copy', async () => {
  const store = makeQuoteStore();
  seedPendingQuote(store);
  const { sent, sendText } = collectText();
  const resolvedAsks = [];
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f',
    clientId: 'c',
    ask: quoteAsk('issued-quote-f-c-2'),
    replyText: 'kyllä',
    message: { id: 'wamid.7', timestamp: NOW },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    now: () => NOW,
    quotesEnabled: true,
    getQuoteImpl: store.getQuoteImpl,
    markQuoteSentImpl: store.markQuoteSentImpl,
    cancelQuoteImpl: store.cancelQuoteImpl,
    sendEmail: async () => ({ id: 'resend-1' }),
    resolveAsk: async ({ askId, resolutionNote }) => resolvedAsks.push([askId, resolutionNote]),
    sendText
  });
  assert.equal(result.action, 'confirm_and_send_quote');
  assert.equal(store.rows.get('issued-quote-f-c-2').status, 'sent');
  assert.equal(store.rows.get('issued-quote-f-c-2').transmit_receipt.format, 'pdf');
  assert.deepEqual(resolvedAsks, [['ask-q-1', 'quote_sent']]);
  assert.match(sent[0], /Tarjous T2026002 lähetetty osoitteeseen osto@asiakas-fi\.example\./);
  assert.match(sent[0], /tee lasku tarjouksesta T2026002/);
});

test('resolve kyllä with a failing transmit: row stays pending, ask stays OPEN, next kyllä retries', async () => {
  const store = makeQuoteStore();
  seedPendingQuote(store);
  const { sent, sendText } = collectText();
  const resolvedAsks = [];
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f',
    clientId: 'c',
    ask: quoteAsk('issued-quote-f-c-2'),
    replyText: 'kyllä',
    message: { id: 'wamid.7', timestamp: NOW },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    now: () => NOW,
    quotesEnabled: true,
    getQuoteImpl: store.getQuoteImpl,
    markQuoteSentImpl: store.markQuoteSentImpl,
    sendEmail: async () => { throw new Error('resend down'); },
    resolveAsk: async ({ askId, resolutionNote }) => resolvedAsks.push([askId, resolutionNote]),
    sendText
  });
  assert.equal(result.action, 'quote_send_failed');
  assert.equal(store.rows.get('issued-quote-f-c-2').status, 'draft_pending_confirmation');
  assert.equal(resolvedAsks.length, 0); // the ask is still open — on the owner
  assert.match(sent[0], /Tarjouksen lähetys ei onnistunut/);
});

test('resolve ei: cancel with receipt, ask closed', async () => {
  const store = makeQuoteStore();
  seedPendingQuote(store);
  const { sent, sendText } = collectText();
  const resolvedAsks = [];
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f',
    clientId: 'c',
    ask: quoteAsk('issued-quote-f-c-2'),
    replyText: 'ei',
    message: { id: 'wamid.8', timestamp: NOW },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    now: () => NOW,
    quotesEnabled: true,
    getQuoteImpl: store.getQuoteImpl,
    cancelQuoteImpl: store.cancelQuoteImpl,
    resolveAsk: async ({ askId, resolutionNote }) => resolvedAsks.push([askId, resolutionNote]),
    sendText
  });
  assert.equal(result.action, 'quote_cancelled');
  assert.equal(store.rows.get('issued-quote-f-c-2').status, 'cancelled');
  assert.deepEqual(resolvedAsks, [['ask-q-1', 'quote_cancelled']]);
  assert.match(sent[0], /Tarjous T2026002 peruttu\./);
});

test('resolve correction: a quote_draft verdict supersedes the SAME row and re-asks (number preserved)', async () => {
  const store = makeQuoteStore();
  seedPendingQuote(store);
  const { sent, sendText } = collectText();
  const createAsk = makeCreateAsk();
  const resolvedAsks = [];
  const amendedIntent = { ...QUOTE_INTENT, lines: [{ description: 'verkkosivujen uudistus', quantity: 1, unit_price: 3000 }] };
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f',
    clientId: 'c',
    ask: quoteAsk('issued-quote-f-c-2'),
    replyText: 'muuta summaksi 3000 €',
    message: { id: 'wamid.9', timestamp: NOW },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    now: () => NOW,
    quotesEnabled: true,
    runIntakeImpl: async ({ priorDraft }) => {
      assert.equal(priorDraft.intent, 'quote'); // corrections re-intake against the persisted draft
      return { terminal: 'quote_draft', intent: amendedIntent, artifacts: {}, model: 'claude-opus-4-8-test' };
    },
    getQuoteImpl: store.getQuoteImpl,
    createQuoteDraftImpl: store.createQuoteDraftImpl,
    supersedeQuoteDraftImpl: store.supersedeQuoteDraftImpl,
    createAsk,
    resolveAsk: async ({ askId, resolutionNote }) => resolvedAsks.push([askId, resolutionNote]),
    sendText
  });
  assert.equal(result.action, 'request_quote_confirmation');
  assert.equal(result.superseded, true);
  const row = store.rows.get('issued-quote-f-c-2');
  assert.equal(row.draft.quote.total, 3000);
  assert.equal(row.draft.quote.quoteNumber, 'T2026002'); // the number never re-allocates on a correction
  assert.deepEqual(resolvedAsks, [['ask-q-1', 'quote_draft_superseded']]);
  assert.match(sent[0], /3000\.00 EUR/);
});

test('resolve ambiguous reply: quote nudge, ask stays open (never a send, never a cancel)', async () => {
  const store = makeQuoteStore();
  seedPendingQuote(store);
  const { sent, sendText } = collectText();
  const resolvedAsks = [];
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f',
    clientId: 'c',
    ask: quoteAsk('issued-quote-f-c-2'),
    replyText: 'hmm ehkä',
    message: { id: 'wamid.10', timestamp: NOW },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    now: () => NOW,
    quotesEnabled: true,
    runIntakeImpl: async () => ({ terminal: 'not_invoice' }),
    getQuoteImpl: store.getQuoteImpl,
    resolveAsk: async (args) => resolvedAsks.push(args),
    sendText
  });
  assert.equal(result.action, 'nudge');
  assert.equal(store.rows.get('issued-quote-f-c-2').status, 'draft_pending_confirmation');
  assert.equal(resolvedAsks.length, 0);
  assert.match(sent[0], /tarjouksen/);
});

test('resolve on a stale quote ask: closed with the already-handled copy', async () => {
  const store = makeQuoteStore();
  const row = seedPendingQuote(store);
  row.status = 'sent';
  const { sent, sendText } = collectText();
  const resolvedAsks = [];
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f',
    clientId: 'c',
    ask: quoteAsk('issued-quote-f-c-2'),
    replyText: 'kyllä',
    message: { id: 'wamid.11', timestamp: NOW },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    now: () => NOW,
    quotesEnabled: true,
    getQuoteImpl: store.getQuoteImpl,
    resolveAsk: async ({ askId, resolutionNote }) => resolvedAsks.push([askId, resolutionNote]),
    sendText
  });
  assert.equal(result.action, 'stale');
  assert.deepEqual(resolvedAsks, [['ask-q-1', 'quote_issuance_stale_ask']]);
  assert.match(sent[0], /jo käsitelty/);
});

// ----- two-terminal-states machine check over the quote lifecycle --------------------

test('two-terminal-states: every quote motion ends terminal-with-receipt or with an OPEN ask on the owner', async () => {
  // Walk the machine through draft → failed send → send: at every rest the row
  // is either draft_pending_confirmation WITH an open ask, or a terminal state
  // (sent/cancelled/declined/converted) with its receipt.
  const store = makeQuoteStore();
  seedPendingQuote(store);
  let askOpen = true; // the confirm ask exists when a pending draft exists
  const resolveAsk = async () => { askOpen = false; };

  const attempt = (sendEmail) => resolveInvoiceIssuanceInbound({
    firmId: 'f', clientId: 'c',
    ask: quoteAsk('issued-quote-f-c-2'),
    replyText: 'kyllä',
    message: { id: 'wamid.12', timestamp: NOW },
    phoneHash: 'ph-1', actorId: 'owner-1', now: () => NOW,
    quotesEnabled: true,
    getQuoteImpl: store.getQuoteImpl,
    markQuoteSentImpl: store.markQuoteSentImpl,
    sendEmail,
    resolveAsk,
    sendText: async () => {}
  });

  await attempt(async () => { throw new Error('down'); });
  let row = store.rows.get('issued-quote-f-c-2');
  assert.equal(row.status, 'draft_pending_confirmation');
  assert.equal(askOpen, true); // NOT terminal ⇒ the ask must still be open

  await attempt(async () => ({ id: 'resend-2' }));
  row = store.rows.get('issued-quote-f-c-2');
  assert.equal(row.status, 'sent');
  assert.ok(row.transmit_receipt); // terminal ⇒ receipt
  assert.equal(askOpen, false); // the answered ask resolved — nothing rests on the firm
});

// ----- the conversion link survives corrections ---------------------------------------

test('correcting a conversion invoice draft preserves the quote link even when the verdict drops it', async () => {
  // An invoice draft born from a quote carries from_quote_id; the owner then
  // corrects the amount and the fresh verdict has NO quoteContext. The
  // superseded draft must keep the link — else the quote rests 'sent' forever.
  const superseded = [];
  const INVOICE_INTENT = {
    ok: true,
    intent: 'invoice',
    buyer_name: 'Asiakas Oy',
    buyer_email: 'osto@asiakas-fi.example',
    lines: [{ description: 'verkkosivujen uudistus', quantity: 1, unit_price: 2200 }],
    due_days: null,
    model: 'claude-opus-4-8-test'
  };
  const existingInvoiceRow = {
    id: 'issued-invoice-f-c-7',
    invoice_number: 7,
    status: 'draft_pending_confirmation',
    kind: 'invoice',
    draft: {
      invoice: { invoiceNumber: '2026007', total: 2500, buyer: { name: 'Asiakas Oy' }, lines: [] },
      transmit: { to: 'osto@asiakas-fi.example', format: 'pdf' },
      intent: { ...INVOICE_INTENT, from_quote_number: 'T2026002' },
      sellerContext: SELLER,
      from_quote_id: 'issued-quote-f-c-2',
      from_quote_number: 'T2026002',
      from_quote_expired: false
    }
  };
  const result = await resolveInvoiceIssuanceInbound({
    firmId: 'f',
    clientId: 'c',
    ask: {
      id: 'ask-i-1',
      kind: INVOICE_ISSUANCE_ASK_KIND,
      request_payload: {
        kind: INVOICE_ISSUANCE_ASK_KIND,
        invoice_issuance: { kind: 'confirm_request', phase: 'confirm_request', invoice_id: existingInvoiceRow.id, summary: 's' }
      }
    },
    replyText: 'muuta summaksi 2200 €',
    message: { id: 'wamid.13', timestamp: NOW },
    phoneHash: 'ph-1',
    actorId: 'owner-1',
    now: () => NOW,
    quotesEnabled: true,
    runIntakeImpl: async () => ({ terminal: 'draft', intent: INVOICE_INTENT, artifacts: {}, model: 'claude-opus-4-8-test' }), // no quoteContext
    getInvoiceImpl: async () => existingInvoiceRow,
    supersedeDraftImpl: async (args) => { superseded.push(args); return { ...existingInvoiceRow, draft: args.draft }; },
    createAsk: async (args) => ({ id: 'ask-i-2', ...args }),
    resolveAsk: async () => {},
    sendText: async () => {}
  });
  assert.equal(result.action, 'request_confirmation');
  assert.equal(superseded[0].draft.from_quote_id, 'issued-quote-f-c-2');
  assert.equal(superseded[0].draft.from_quote_number, 'T2026002');
});

// ----- summary rendering -------------------------------------------------------------

test('summarizeQuoteDraft renders the persisted draft (number, lines, validity, PDF lane)', () => {
  const draft = buildQuoteArtifacts({ intent: QUOTE_INTENT, sellerContext: SELLER, quoteNumber: 'T2026002', date: '2026-07-11' }).artifacts;
  const summary = summarizeQuoteDraft(draft);
  assert.match(summary, /^Tarjous T2026002 — Asiakas Oy/);
  assert.match(summary, /verkkosivujen uudistus — 2500\.00 EUR/);
  assert.match(summary, /Yhteensä 2500\.00 EUR \(ei ALV, AVL 3 §\)/);
  assert.match(summary, /Voimassa 2026-08-10 asti/);
  assert.match(summary, /PDF-muodossa sähköpostilla osoitteeseen osto@asiakas-fi\.example/);
});
