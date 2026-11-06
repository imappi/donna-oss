// FI-10 issuance UX — the issued_invoices store writers against a
// pattern-matching fake pg client (same style as finlandSalesInvoicePostDb.test.js):
// atomic counter allocation, audit-as-precondition, and the closed lifecycle's
// guarded transitions. node --test server/donna/finlandInvoiceIssuanceDb.test.js
// Design: docs/design-donna-finland-fi10-issuance-ux.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __cancelIssuedInvoiceWithClient,
  __createIssuedInvoiceDraftWithClient,
  __markIssuedInvoiceIssuedWithClient,
  __supersedeIssuedInvoiceDraftWithClient
} from './firmDb.js';

const fakeClient = ({ nextInvoiceNo = 1, transitionMatches = true, capOriginal = null, capPrior = 0 } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('insert into issued_invoice_counters')) {
        return { rows: [{ invoice_no: nextInvoiceNo }] };
      }
      // G-8 cap guard: the original lookup + the prior-credit sum.
      if (sql.includes('from issued_invoices') && sql.includes("(draft->'invoice'->>'total')::numeric as total")) {
        return { rows: capOriginal ? [capOriginal] : [] };
      }
      if (sql.includes('from issued_invoices') && sql.includes('coalesce(sum(')) {
        return { rows: [{ credited: capPrior }] };
      }
      if (sql.includes('insert into issued_invoices')) {
        // params: [id, firmId, clientId, invoiceNumber, kind, creditsInvoiceId, draft, buyerName, buyerEmail, actorId]
        return { rows: [{ id: params[0], firm_id: params[1], client_id: params[2], invoice_number: params[3], status: 'draft_pending_confirmation', kind: params[4], credits_invoice_id: params[5], draft: JSON.parse(params[6]), buyer_name: params[7], buyer_email: params[8] }] };
      }
      if (sql.includes('update issued_invoices')) {
        if (!transitionMatches) return { rows: [] };
        const status = sql.includes("'issued'") ? 'issued' : sql.includes("'cancelled'") ? 'cancelled' : 'draft_pending_confirmation';
        return { rows: [{ id: params[2], firm_id: params[0], client_id: params[1], invoice_number: 3, status, draft: { model: 'claude-opus-4-8-test' } }] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 42 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const wroteAudit = (client, action) => client.queries.some((q) => q.sql.includes('insert into audit_events') && q.sql.includes(action));

test('draft create: allocates from the counter atomically, builds WITH the allocated sequence, audits in-txn', async () => {
  const client = fakeClient({ nextInvoiceNo: 3 });
  const seen = [];
  const row = await __createIssuedInvoiceDraftWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    actorId: 'owner-1',
    buildDraft: ({ sequence }) => {
      seen.push(sequence);
      return { draft: { invoice: { invoiceNumber: `2026${String(sequence).padStart(3, '0')}`, total: 500 }, model: 'claude-opus-4-8-test' }, buyerName: 'Asiakas Oy', buyerEmail: 'lasku@asiakas-fi.example' };
    }
  });
  assert.deepEqual(seen, [3]);
  assert.equal(row.invoice_number, 3);
  assert.equal(row.status, 'draft_pending_confirmation');
  assert.equal(row.id, 'issued-invoice-firm-1-client-1-3');
  const counter = client.queries.find((q) => q.sql.includes('issued_invoice_counters'));
  assert.match(counter.sql, /on conflict \(firm_id, client_id\)/);
  assert.match(counter.sql, /next_invoice_no \+ 1/);
  assert.match(counter.sql, /returning next_invoice_no - 1/);
  assert.equal(wroteAudit(client, 'invoice.draft_created'), true);
  const audit = client.queries.find((q) => q.sql.includes('audit_events'));
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.invoice_number, 3);
  assert.equal(metadata.model, 'claude-opus-4-8-test');
});

test('draft create refuses without a draft or buildDraft', async () => {
  const client = fakeClient();
  await assert.rejects(
    __createIssuedInvoiceDraftWithClient({ client, firmId: 'f', clientId: 'c' }),
    (e) => e.statusCode === 400
  );
  assert.equal(client.queries.length, 0);
});

test('supersede updates only a pending draft and audits; a terminal row refuses', async () => {
  const ok = fakeClient();
  await __supersedeIssuedInvoiceDraftWithClient({ client: ok, firmId: 'f', clientId: 'c', invoiceId: 'inv-1', draft: { invoice: { total: 600 } }, actorId: 'owner-1' });
  const update = ok.queries.find((q) => q.sql.includes('update issued_invoices'));
  assert.equal(update.params[3], 'draft_pending_confirmation');
  assert.equal(wroteAudit(ok, 'invoice.draft_superseded'), true);

  const stale = fakeClient({ transitionMatches: false });
  await assert.rejects(
    __supersedeIssuedInvoiceDraftWithClient({ client: stale, firmId: 'f', clientId: 'c', invoiceId: 'inv-1', draft: {}, actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_INVOICE_NOT_PENDING' && e.statusCode === 409
  );
  assert.equal(wroteAudit(stale, 'invoice.draft_superseded'), false);
});

test('cancel flips a pending draft to cancelled with the receipt; a terminal row refuses', async () => {
  const ok = fakeClient();
  const row = await __cancelIssuedInvoiceWithClient({ client: ok, firmId: 'f', clientId: 'c', invoiceId: 'inv-1', reason: 'owner_declined', authorityBasis: { source: 's', providerMessageId: 'wamid.1' }, actorId: 'owner-1' });
  assert.equal(row.status, 'cancelled');
  assert.equal(wroteAudit(ok, 'invoice.cancelled'), true);
  const audit = ok.queries.find((q) => q.sql.includes('audit_events'));
  assert.equal(JSON.parse(audit.params[4]).authority_basis.providerMessageId, 'wamid.1');

  const stale = fakeClient({ transitionMatches: false });
  await assert.rejects(
    __cancelIssuedInvoiceWithClient({ client: stale, firmId: 'f', clientId: 'c', invoiceId: 'inv-1', actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_INVOICE_NOT_PENDING'
  );
});

test('mark issued requires the authority basis (no receipt, no terminal state)', async () => {
  const client = fakeClient();
  await assert.rejects(
    __markIssuedInvoiceIssuedWithClient({ client, firmId: 'f', clientId: 'c', invoiceId: 'inv-1', actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_INVOICE_AUTHORITY_REQUIRED'
  );
  assert.equal(client.queries.length, 0);
});

test('mark issued carries AR journal + transmit receipt + model id into the audit (in-txn)', async () => {
  const client = fakeClient();
  const row = await __markIssuedInvoiceIssuedWithClient({
    client,
    firmId: 'f',
    clientId: 'c',
    invoiceId: 'inv-1',
    arJournalId: 'journal-1',
    cashBasisSkip: false,
    transmitReceipt: { message_id: '2026003-2026-07-09', channel: 'email' },
    authorityBasis: { source: 'owner_whatsapp_invoice_confirmation', providerMessageId: 'wamid.9' },
    actorId: 'owner-1'
  });
  assert.equal(row.status, 'issued');
  assert.equal(wroteAudit(client, 'invoice.issued'), true);
  const audit = client.queries.find((q) => q.sql.includes('audit_events'));
  assert.equal(audit.params[2], 'owner-1');
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.ar_journal_id, 'journal-1');
  assert.equal(metadata.transmit_message_id, '2026003-2026-07-09');
  assert.equal(metadata.authority_basis.providerMessageId, 'wamid.9');
  assert.equal(metadata.model, 'claude-opus-4-8-test');
});

test('mark issued on a non-pending row refuses (the closed lifecycle has no re-issue)', async () => {
  const client = fakeClient({ transitionMatches: false });
  await assert.rejects(
    __markIssuedInvoiceIssuedWithClient({ client, firmId: 'f', clientId: 'c', invoiceId: 'inv-1', authorityBasis: { source: 's' }, actorId: 'owner-1' }),
    (e) => e.code === 'ISSUED_INVOICE_NOT_PENDING'
  );
  assert.equal(wroteAudit(client, 'invoice.issued'), false);
});

// ----- G-8: credit-note drafts + the in-txn cap guard (D-G8-3) ----------------------

const issuedOriginal = () => ({ id: 'orig-1', status: 'issued', kind: 'invoice', total: '500' });

test('a credit-note draft persists kind + the original link and audits both', async () => {
  const client = fakeClient({ nextInvoiceNo: 4, capOriginal: issuedOriginal(), capPrior: 100 });
  const row = await __createIssuedInvoiceDraftWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    actorId: 'owner-1',
    buildDraft: ({ sequence }) => ({
      draft: { invoice: { invoiceNumber: `2026${String(sequence).padStart(3, '0')}`, kind: 'credit_note', total: 200 }, model: 'claude-opus-4-8-test' },
      buyerName: 'Asiakas Oy',
      buyerEmail: 'lasku@asiakas-fi.example',
      kind: 'credit_note',
      creditsInvoiceId: 'orig-1'
    })
  });
  assert.equal(row.kind, 'credit_note');
  assert.equal(row.credits_invoice_id, 'orig-1');
  const audit = client.queries.find((q) => q.sql.includes('audit_events'));
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.kind, 'credit_note');
  assert.equal(metadata.credits_invoice_id, 'orig-1');
});

test('the cap guard refuses over-crediting inside the draft transaction (pending drafts INCLUDED)', async () => {
  // 100 already credited/pending of 500 → a 450 credit exceeds the cap.
  const client = fakeClient({ nextInvoiceNo: 5, capOriginal: issuedOriginal(), capPrior: 100 });
  await assert.rejects(
    __createIssuedInvoiceDraftWithClient({
      client,
      firmId: 'firm-1',
      clientId: 'client-1',
      actorId: 'owner-1',
      buildDraft: () => ({ draft: { invoice: { total: 450 } }, kind: 'credit_note', creditsInvoiceId: 'orig-1' })
    }),
    (e) => e.code === 'CREDIT_NOTE_CAP_EXCEEDED' && e.statusCode === 409
  );
  assert.equal(client.queries.some((q) => q.sql.includes('insert into issued_invoices')), false);
});

test('the cap guard refuses a non-issued or non-invoice original', async () => {
  const pendingOriginal = fakeClient({ capOriginal: { id: 'orig-1', status: 'draft_pending_confirmation', kind: 'invoice', total: '500' } });
  await assert.rejects(
    __createIssuedInvoiceDraftWithClient({
      client: pendingOriginal, firmId: 'f', clientId: 'c', actorId: 'o',
      buildDraft: () => ({ draft: { invoice: { total: 100 } }, kind: 'credit_note', creditsInvoiceId: 'orig-1' })
    }),
    (e) => e.code === 'CREDIT_NOTE_ORIGINAL_NOT_ISSUED'
  );
  const missingOriginal = fakeClient({ capOriginal: null });
  await assert.rejects(
    __createIssuedInvoiceDraftWithClient({
      client: missingOriginal, firmId: 'f', clientId: 'c', actorId: 'o',
      buildDraft: () => ({ draft: { invoice: { total: 100 } }, kind: 'credit_note', creditsInvoiceId: 'orig-1' })
    }),
    (e) => e.code === 'CREDIT_NOTE_ORIGINAL_NOT_ISSUED'
  );
});

test('a credit-note draft without the original id refuses before any write', async () => {
  const client = fakeClient({ nextInvoiceNo: 6 });
  await assert.rejects(
    __createIssuedInvoiceDraftWithClient({
      client, firmId: 'f', clientId: 'c', actorId: 'o',
      buildDraft: () => ({ draft: { invoice: { total: 100 } }, kind: 'credit_note' })
    }),
    (e) => e.code === 'CREDIT_NOTE_ORIGINAL_REQUIRED'
  );
  assert.equal(client.queries.some((q) => q.sql.includes('insert into issued_invoices')), false);
});

test('a credit-note supersede re-checks the cap EXCLUDING its own prior share', async () => {
  const client = fakeClient({ capOriginal: issuedOriginal(), capPrior: 0 });
  await __supersedeIssuedInvoiceDraftWithClient({
    client, firmId: 'f', clientId: 'c', invoiceId: 'inv-2',
    draft: { invoice: { total: 300 } },
    kind: 'credit_note', creditsInvoiceId: 'orig-1',
    actorId: 'owner-1'
  });
  const capQuery = client.queries.find((q) => q.sql.includes('coalesce(sum('));
  assert.equal(capQuery.params[3], 'inv-2'); // excludeInvoiceId — the correction replaces, it doesn't stack
  const update = client.queries.find((q) => q.sql.includes('update issued_invoices'));
  assert.ok(update.sql.includes('credits_invoice_id'));
});
