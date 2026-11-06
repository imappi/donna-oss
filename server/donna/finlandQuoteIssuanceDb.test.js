// C-1 — the issued_quotes store writers against a pattern-matching fake pg
// client (the finlandInvoiceIssuanceDb.test.js template): the SEPARATE quote
// counter, audit-as-precondition, the closed lifecycle's guarded transitions,
// and the conversion flip inside the invoice's issue transaction.
// node --test server/donna/finlandQuoteIssuanceDb.test.js
// Design: docs/design-donna-finland-c1-quote-send.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFinlandQuotesFromDb,
  __cancelIssuedQuoteWithClient,
  __createIssuedQuoteDraftWithClient,
  __declineIssuedQuoteWithClient,
  __markIssuedInvoiceIssuedWithClient,
  __markIssuedQuoteSentWithClient,
  __supersedeIssuedQuoteDraftWithClient
} from './firmDb.js';

const fakeClient = ({ nextQuoteNo = 1, transitionMatches = true, quoteFlipMatches = true, issuedDraft = null } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('insert into issued_quote_counters')) {
        return { rows: [{ quote_no: nextQuoteNo }] };
      }
      if (sql.includes('insert into issued_quotes')) {
        // params: [id, firmId, clientId, quoteNumber, draft, buyerName, buyerEmail, validUntil, actorId]
        return { rows: [{ id: params[0], firm_id: params[1], client_id: params[2], quote_number: params[3], status: 'draft_pending_confirmation', draft: JSON.parse(params[4]), buyer_name: params[5], buyer_email: params[6], valid_until: params[7] }] };
      }
      if (sql.includes('update issued_quotes')) {
        // The conversion flip inside the INVOICE issue txn returns quote_number only.
        if (sql.includes("'converted'")) {
          return quoteFlipMatches ? { rows: [{ quote_number: 2 }] } : { rows: [] };
        }
        if (!transitionMatches) return { rows: [] };
        const status = sql.includes("'sent'") && sql.includes('sent_at')
          ? 'sent'
          : sql.includes("'declined'") ? 'declined' : sql.includes("'cancelled'") ? 'cancelled' : 'draft_pending_confirmation';
        return { rows: [{ id: params[2], firm_id: params[0], client_id: params[1], quote_number: 2, status, valid_until: '2026-08-10', draft: { model: 'claude-opus-4-8-test', quote: { quoteNumber: 'T2026002' } } }] };
      }
      if (sql.includes('update issued_invoices')) {
        return { rows: [{ id: params[2], firm_id: params[0], client_id: params[1], invoice_number: 7, status: 'issued', draft: issuedDraft || { model: 'claude-opus-4-8-test' } }] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 42 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const wroteAudit = (client, action) => client.queries.some((q) => q.sql.includes('insert into audit_events') && q.sql.includes(action));

test('quote draft create: allocates from the SEPARATE quote counter, builds WITH the sequence, audits in-txn', async () => {
  const client = fakeClient({ nextQuoteNo: 2 });
  const seen = [];
  const row = await __createIssuedQuoteDraftWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    actorId: 'owner-1',
    buildDraft: ({ sequence }) => {
      seen.push(sequence);
      return {
        draft: { quote: { quoteNumber: `T2026${String(sequence).padStart(3, '0')}`, total: 2500 }, model: 'claude-opus-4-8-test' },
        buyerName: 'Asiakas Oy',
        buyerEmail: 'osto@asiakas-fi.example',
        validUntil: '2026-08-10'
      };
    }
  });
  assert.deepEqual(seen, [2]);
  assert.equal(row.quote_number, 2);
  assert.equal(row.status, 'draft_pending_confirmation');
  assert.equal(row.id, 'issued-quote-firm-1-client-1-2');
  assert.equal(row.valid_until, '2026-08-10');
  const counter = client.queries.find((q) => q.sql.includes('issued_quote_counters'));
  // The quote counter — NEVER issued_invoice_counters (D-C1-1: a tarjous must
  // not consume a laskunumero).
  assert.match(counter.sql, /issued_quote_counters/);
  assert.match(counter.sql, /on conflict \(firm_id, client_id\)/);
  assert.match(counter.sql, /next_quote_no \+ 1/);
  assert.match(counter.sql, /returning next_quote_no - 1/);
  assert.equal(client.queries.some((q) => q.sql.includes('issued_invoice_counters')), false);
  assert.equal(wroteAudit(client, 'quote.draft_created'), true);
  const audit = client.queries.find((q) => q.sql.includes('audit_events'));
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.quote_number, 2);
  assert.equal(metadata.valid_until, '2026-08-10');
  assert.equal(metadata.model, 'claude-opus-4-8-test');
});

test('quote draft create refuses without a draft or buildDraft', async () => {
  const client = fakeClient();
  await assert.rejects(
    __createIssuedQuoteDraftWithClient({ client, firmId: 'f', clientId: 'c' }),
    (e) => e.statusCode === 400
  );
  assert.equal(client.queries.length, 0);
});

test('quote supersede updates only a pending draft and audits; a terminal row refuses', async () => {
  const ok = fakeClient();
  await __supersedeIssuedQuoteDraftWithClient({ client: ok, firmId: 'f', clientId: 'c', quoteId: 'q-1', draft: { quote: { total: 3000 } }, validUntil: '2026-08-20', actorId: 'owner-1' });
  const update = ok.queries.find((q) => q.sql.includes('update issued_quotes'));
  assert.equal(update.params[3], 'draft_pending_confirmation');
  assert.equal(wroteAudit(ok, 'quote.draft_superseded'), true);

  const stale = fakeClient({ transitionMatches: false });
  await assert.rejects(
    __supersedeIssuedQuoteDraftWithClient({ client: stale, firmId: 'f', clientId: 'c', quoteId: 'q-1', draft: {}, actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_QUOTE_TRANSITION_REFUSED' && e.statusCode === 409
  );
  assert.equal(wroteAudit(stale, 'quote.draft_superseded'), false);
});

test('quote cancel flips a pending draft to cancelled with the receipt; a terminal row refuses', async () => {
  const ok = fakeClient();
  const row = await __cancelIssuedQuoteWithClient({ client: ok, firmId: 'f', clientId: 'c', quoteId: 'q-1', reason: 'owner_declined', authorityBasis: { source: 's', providerMessageId: 'wamid.1' }, actorId: 'owner-1' });
  assert.equal(row.status, 'cancelled');
  assert.equal(wroteAudit(ok, 'quote.cancelled'), true);
  const audit = ok.queries.find((q) => q.sql.includes('audit_events'));
  assert.equal(JSON.parse(audit.params[4]).authority_basis.providerMessageId, 'wamid.1');

  const stale = fakeClient({ transitionMatches: false });
  await assert.rejects(
    __cancelIssuedQuoteWithClient({ client: stale, firmId: 'f', clientId: 'c', quoteId: 'q-1', actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_QUOTE_TRANSITION_REFUSED'
  );
});

test('mark sent requires the authority basis (no receipt, no terminal state)', async () => {
  const client = fakeClient();
  await assert.rejects(
    __markIssuedQuoteSentWithClient({ client, firmId: 'f', clientId: 'c', quoteId: 'q-1', actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_QUOTE_AUTHORITY_REQUIRED'
  );
  assert.equal(client.queries.length, 0);
});

test('mark sent carries the transmit receipt + model id into the audit (in-txn); no post leg exists', async () => {
  const client = fakeClient();
  const row = await __markIssuedQuoteSentWithClient({
    client,
    firmId: 'f',
    clientId: 'c',
    quoteId: 'q-1',
    validUntil: '2026-08-10',
    transmitReceipt: { message_id: 'T2026002-2026-07-11', channel: 'email' },
    authorityBasis: { source: 'owner_whatsapp_quote_confirmation', providerMessageId: 'wamid.9' },
    actorId: 'owner-1'
  });
  assert.equal(row.status, 'sent');
  assert.equal(wroteAudit(client, 'quote.sent'), true);
  const audit = client.queries.find((q) => q.sql.includes('audit_events'));
  assert.equal(audit.params[2], 'owner-1');
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.transmit_message_id, 'T2026002-2026-07-11');
  assert.equal(metadata.authority_basis.providerMessageId, 'wamid.9');
  assert.equal(metadata.model, 'claude-opus-4-8-test');
  // A tarjous books nothing — the send touches no ledger surface (D-C1-4).
  assert.equal(client.queries.some((q) => /ledger|journal|tosite/i.test(q.sql)), false);
});

test('mark sent on a non-pending row refuses (the closed lifecycle has no re-send)', async () => {
  const client = fakeClient({ transitionMatches: false });
  await assert.rejects(
    __markIssuedQuoteSentWithClient({ client, firmId: 'f', clientId: 'c', quoteId: 'q-1', authorityBasis: { source: 's' }, actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_QUOTE_TRANSITION_REFUSED'
  );
  assert.equal(wroteAudit(client, 'quote.sent'), false);
});

test('decline flips only a SENT quote (the owner reporting the customer\'s no) and audits', async () => {
  const ok = fakeClient();
  const row = await __declineIssuedQuoteWithClient({ client: ok, firmId: 'f', clientId: 'c', quoteId: 'q-1', reason: 'liian kallis', actorId: 'owner-1' });
  assert.equal(row.status, 'declined');
  const update = ok.queries.find((q) => q.sql.includes('update issued_quotes'));
  assert.equal(update.params[3], 'sent');
  assert.equal(wroteAudit(ok, 'quote.declined'), true);
  assert.equal(JSON.parse(ok.queries.find((q) => q.sql.includes('audit_events')).params[4]).reason, 'liian kallis');

  const notSent = fakeClient({ transitionMatches: false });
  await assert.rejects(
    __declineIssuedQuoteWithClient({ client: notSent, firmId: 'f', clientId: 'c', quoteId: 'q-1', actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_QUOTE_TRANSITION_REFUSED'
  );
});

// ----- The conversion flip inside the INVOICE issue transaction (D-C1-5) -----------

test('issuing an invoice drafted FROM a quote flips the quote to converted in the SAME txn and audits both', async () => {
  const client = fakeClient({ issuedDraft: { model: 'claude-opus-4-8-test', from_quote_id: 'issued-quote-f-c-2' } });
  await __markIssuedInvoiceIssuedWithClient({
    client,
    firmId: 'f',
    clientId: 'c',
    invoiceId: 'inv-7',
    arJournalId: 'journal-7',
    transmitReceipt: { message_id: 'm-1' },
    authorityBasis: { source: 'owner_whatsapp_invoice_confirmation' },
    actorId: 'owner-1'
  });
  const flip = client.queries.find((q) => q.sql.includes('update issued_quotes'));
  assert.ok(flip, 'the quote flip runs inside the issue transaction');
  assert.match(flip.sql, /status = 'converted'/);
  assert.match(flip.sql, /status = 'sent'/); // guarded: only a sent quote converts
  assert.equal(flip.params[3], 'inv-7'); // converted_invoice_id
  assert.equal(wroteAudit(client, 'quote.converted'), true);
  assert.equal(wroteAudit(client, 'invoice.issued'), true);
  const issueAudit = client.queries.filter((q) => q.sql.includes('audit_events')).find((q) => q.sql.includes('invoice.issued'));
  const metadata = JSON.parse(issueAudit.params[4]);
  assert.equal(metadata.from_quote_id, 'issued-quote-f-c-2');
  assert.equal(metadata.quote_conversion, 'converted');
});

test('a quote that left sent mid-flight: the flip is SKIPPED and the skip recorded on the issue receipt', async () => {
  const client = fakeClient({ quoteFlipMatches: false, issuedDraft: { model: 'claude-opus-4-8-test', from_quote_id: 'issued-quote-f-c-2' } });
  await __markIssuedInvoiceIssuedWithClient({
    client,
    firmId: 'f',
    clientId: 'c',
    invoiceId: 'inv-7',
    authorityBasis: { source: 'owner_whatsapp_invoice_confirmation' },
    actorId: 'owner-1'
  });
  assert.equal(wroteAudit(client, 'quote.converted'), false);
  const issueAudit = client.queries.filter((q) => q.sql.includes('audit_events')).find((q) => q.sql.includes('invoice.issued'));
  const metadata = JSON.parse(issueAudit.params[4]);
  assert.equal(metadata.quote_conversion, 'skipped_not_sent'); // never silent
});

test('an invoice with no quote link never touches issued_quotes (byte-identical to before C-1)', async () => {
  const client = fakeClient({ issuedDraft: { model: 'claude-opus-4-8-test' } });
  await __markIssuedInvoiceIssuedWithClient({
    client,
    firmId: 'f',
    clientId: 'c',
    invoiceId: 'inv-7',
    authorityBasis: { source: 'owner_whatsapp_invoice_confirmation' },
    actorId: 'owner-1'
  });
  assert.equal(client.queries.some((q) => q.sql.includes('issued_quotes')), false);
  const issueAudit = client.queries.find((q) => q.sql.includes('audit_events'));
  const metadata = JSON.parse(issueAudit.params[4]);
  assert.equal('quote_conversion' in metadata, false);
});

// ----- getFinlandQuotesFromDb (C-1c, the read surface) ------------------------------

const quoteReadRow = (over = {}) => ({
  id: 'issued-quote-firm-1-client-1-2',
  firm_id: 'firm-1',
  client_id: 'client-1',
  quote_number: 2,
  status: 'sent',
  buyer_name: 'Asiakas Oy',
  valid_until: '2026-07-31',
  draft: { quote: { quoteNumber: 'T2026002', total: 620, currency: 'EUR' } },
  sent_at: '2026-07-01T10:00:00.000Z',
  ...over
});

const fakeQuoteReadClient = ({ flags = { FINLAND_QUOTES: 'auto' }, quotes = [] } = {}) => ({
  async query(sql) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('from issued_quotes')) return { rows: quotes };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const callQuotesRead = (client) => getFinlandQuotesFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-07-11T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client)
});

test('quotes read: flag off is a typed 403 (the surface hides)', async () => {
  await assert.rejects(
    callQuotesRead(fakeQuoteReadClient({ flags: {} })),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_QUOTES_DISABLED'
  );
});

test('quotes read: rows annotate at read time and fold into the funnel envelope', async () => {
  const envelope = await callQuotesRead(fakeQuoteReadClient({
    quotes: [
      quoteReadRow({ id: 'q1', quote_number: 3, status: 'draft_pending_confirmation', draft: { quote: { quoteNumber: 'T2026003', total: 100 } } }),
      quoteReadRow(), // sent, valid until 07-31, read 07-11 ⇒ live
      quoteReadRow({ id: 'q0', quote_number: 1, valid_until: '2026-07-01', draft: { quote: { quoteNumber: 'T2026001', total: 300 } } }) // sent, expired at read
    ]
  }));
  const { quotes, funnel, line_fi } = envelope.issued_quotes;
  assert.equal(quotes.length, 3);
  assert.deepEqual(funnel, { open: 1, sent: 2, sent_expired: 1, converted: 0, declined: 0, cancelled: 0, total: 3 });
  const expired = quotes.find((q) => q.id === 'q0');
  assert.equal(expired.expired, true);
  assert.equal(expired.status, 'sent'); // read-time annotation, never stored
  assert.equal(expired.display_number, 'T2026001');
  assert.match(line_fi, /1 luonnos odottaa vahvistusta/);
  assert.match(line_fi, /2 lähetettyä \(1 vanhentunut\)/);
  assert.equal(envelope.provenance.deterministic, true);
  assert.equal(envelope.provenance.source, 'issued_quotes');
});

test('quotes read: no quotes ⇒ a quiet envelope (line_fi null)', async () => {
  const envelope = await callQuotesRead(fakeQuoteReadClient({ quotes: [] }));
  assert.deepEqual(envelope.issued_quotes.quotes, []);
  assert.equal(envelope.issued_quotes.funnel.total, 0);
  assert.equal(envelope.issued_quotes.line_fi, null);
});
