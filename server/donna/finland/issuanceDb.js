// Finnish invoice/quote lifecycle and settlement operations. These are the existing
// named writers, moved intact; historical asks and drafts keep this operation owner.
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { FINLAND_INVOICING_FLAG_KEY } from './tilikausi.js';
import { sellerContextFromClientRow } from './invoiceIssuance.js';
import { buildIssuedInvoiceBannerFi } from './issuedInvoiceSettlement.js';
import { evaluateIssuedInvoiceSettlement, paymentMatchesInvoice, summarizeIssuedInvoices } from '../issuedInvoiceSettlementMath.js';
import { FINLAND_EINVOICE_RECEIVE_FLAG_KEY } from './verkkolaskuReceive.js';
import { FINLAND_QUOTES_FLAG_KEY, summarizeQuoteFunnel } from './quoteIssuance.js';
import { FINLAND_ALV_INVOICING_FLAG_KEY } from './alvInvoicing.js';
import { withFirmDbClient } from '../db/pool.js';
import { shortHash } from '../db/shared.js';
import { DEFAULT_FIRM_ID, requireClientInFirm, updateClientProfileInDb } from '../db/clients.js';
import { rowToClientEvidenceRequestPayload } from '../db/asks.js';
import { resolveSellerJurisdiction } from '../ownerInvoiceSellerContext.js';

// Admission for NEW unanchored work only. Historical anchored replies continue
// through the original raw flag readers and retained Finnish operation below.
const entryActs = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}, flagKey) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const { rows } = await client.query('select * from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId]);
    if (resolveSellerJurisdiction(rows[0]).jurisdiction !== 'fi') return false;
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return Boolean(clientFlagActs({ flagKey, snapshot, envFallback: () => false }));
  });
};
export const finlandInvoiceIssuanceEntryActsInDb = (args) => entryActs(args, FINLAND_INVOICING_FLAG_KEY);
export const finlandEInvoiceReceiveEntryActsInDb = (args) => entryActs(args, FINLAND_EINVOICE_RECEIVE_FLAG_KEY);

// ---------------------------------------------------------------------------------
// FI-10 issuance UX — the issued-invoice lifecycle store (migration 065) + the
// invoice_issuance ask writer + the inbound-hook flag gate.
// Design: docs/design-donna-finland-fi10-issuance-ux.md. The lifecycle enum is
// CLOSED (draft_pending_confirmation | issued | cancelled) and every transition is
// audit-as-precondition (the receipt records in the SAME txn — no record, no move).
// ---------------------------------------------------------------------------------

export const finlandInvoicingWhatsAppFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return Boolean(clientFlagActs({ flagKey: FINLAND_INVOICING_FLAG_KEY, snapshot, envFallback: () => false }));
  });
};

// FI-9 (R) — does FINLAND_EINVOICE_RECEIVE act for this client? Gates the
// WhatsApp unanchored-media receive hook (inboundCore.maybeReceiveEInvoiceMedia);
// the parse worker reads the SAME key off its own per-run snapshot, so the two
// surfaces can never disagree on whether the lane is live.
export const finlandEInvoiceReceiveWhatsAppFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return Boolean(clientFlagActs({ flagKey: FINLAND_EINVOICE_RECEIVE_FLAG_KEY, snapshot, envFallback: () => false }));
  });
};

// C-1 — does FINLAND_QUOTES act for this client? Gates every quote (tarjous)
// lane in the WhatsApp issuance conversation (design:
// docs/design-donna-finland-c1-quote-send.md, D-C1-6). Dark at birth; depends
// structurally on FINLAND_INVOICING (the hook it rides only fires there).
export const finlandQuotesWhatsAppFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return Boolean(clientFlagActs({ flagKey: FINLAND_QUOTES_FLAG_KEY, snapshot, envFallback: () => false }));
  });
};

// FI-13 13.4 — does FINLAND_ALV_INVOICING act for this client? Gates the ALV
// side of invoice issuance (the route additionally requires an effective
// alv_registration covering the invoice date — the flag alone never adds VAT;
// flag off ⇒ the exempt path, byte-identical to pre-ALV issuance).
export const finlandAlvInvoicingWhatsAppFlagActsInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return false;
  return withFirmDbClient(async (client) => {
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    return Boolean(clientFlagActs({ flagKey: FINLAND_ALV_INVOICING_FLAG_KEY, snapshot, envFallback: () => false }));
  });
};

// F-U1 — persist the owner's OWN seller identity (Y-tunnus / IBAN) to the client
// profile when the invoice-issuance chat surfaced it and the profile lacked it,
// so Donna stops re-asking for it on the next invoice. Goes through the audited,
// schema-validated profile writer (client.profile.update receipt). The CALLER
// (invoiceIssuanceRoute) only passes the fields the profile was missing, so this
// is a first-write, not an overwrite; empty patches are a no-op.
export const persistFinlandSellerIdentityInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  sellerIdentity = {},
  actorId = null
} = {}) => {
  if (!clientId) return null;
  const profilePatch = {};
  if (typeof sellerIdentity.businessId === 'string' && sellerIdentity.businessId.trim()) {
    profilePatch.businessId = sellerIdentity.businessId.trim();
  }
  if (typeof sellerIdentity.iban === 'string' && sellerIdentity.iban.trim()) {
    profilePatch.iban = sellerIdentity.iban.trim();
  }
  if (!Object.keys(profilePatch).length) return null;
  // Who gave these details: the chat's actorId is the binding's owner
  // collaborator when the binding has one, else the binding's verifier or the
  // transport's fallback id ('whatsapp:webhook'), neither of whom typed them.
  // The row names the owner only when actorId is an active collaborator holding
  // this book; otherwise it stays 'system' with the id it was given.
  const owner = actorId ? await withFirmDbClient(async (client) => (await client.query(
    `select fc.id from firm_collaborators fc join client_assignments ca
        on ca.firm_id = fc.firm_id and ca.principal_type = 'firm_collaborator' and ca.principal_id = fc.id
      where fc.firm_id = $1 and fc.id = $2 and ca.client_id = $3 and fc.status = 'active' and ca.status = 'active'
      limit 1`, [firmId, actorId, clientId])).rows[0] || null) : null;
  return updateClientProfileInDb({ firmId, clientId, profilePatch, actorId,
    ...(owner ? { principal: { principalType: 'firm_collaborator', principalId: owner.id } } : {}) });
};

export const createInvoiceIssuanceEvidenceRequestInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  question,
  requestPayload = {},
  actorId = 'system'
} = {}) => {
  const cleanClientId = String(clientId || '').trim();
  const cleanQuestion = String(question || '').trim();
  if (!cleanClientId || !cleanQuestion) {
    const error = new Error('Client id and question are required for an invoice-issuance ask.');
    error.statusCode = 400;
    throw error;
  }
  const requestId = `invoice-issuance-${firmId}-${cleanClientId}-${shortHash(`${Date.now()}:${cleanQuestion}`)}`;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `insert into client_evidence_requests (
         id, firm_id, client_id, status, evidence_type, question, request_payload,
         first_sent_at, last_sent_at, send_count, created_by
       )
       values ($1, $2, $3, 'open', 'invoice_issuance', $4, $5::jsonb, now(), now(), 1, $6)
       returning *`,
      [
        requestId,
        firmId,
        cleanClientId,
        cleanQuestion,
        JSON.stringify({ kind: 'invoice_issuance', ...(requestPayload || {}) }),
        actorId
      ]
    );
    return rowToClientEvidenceRequestPayload(result.rows[0]);
  });
};

const rowToIssuedInvoicePayload = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    invoice_number: row.invoice_number != null ? Number(row.invoice_number) : null,
    status: row.status,
    kind: row.kind || 'invoice',
    credits_invoice_id: row.credits_invoice_id || null,
    draft: row.draft || {},
    buyer_name: row.buyer_name || null,
    buyer_email: row.buyer_email || null,
    ar_journal_id: row.ar_journal_id || null,
    cash_basis_skip: row.cash_basis_skip === true,
    transmit_receipt: row.transmit_receipt || null,
    authority_basis: row.authority_basis || null,
    issued_at: row.issued_at || null,
    cancelled_at: row.cancelled_at || null,
    cancel_reason: row.cancel_reason || null,
    created_by: row.created_by || null,
    issued_by: row.issued_by || null
  };
};

// G-8 (D-G8-3) — the in-transaction credit-cap guard. A credit note may only
// rest against an ISSUED original of this client, and the sum of its credit
// notes (pending drafts INCLUDED — two concurrent drafts cannot jointly
// over-credit; a cancelled draft frees its share) must stay <= the original's
// total. Refuses with typed errors, never shades.
const __assertCreditNoteCapWithClient = async ({
  client,
  firmId,
  clientId,
  creditsInvoiceId,
  creditTotal,
  excludeInvoiceId = null
}) => {
  const original = await client.query(
    `select id, status, kind, (draft->'invoice'->>'total')::numeric as total
       from issued_invoices
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1`,
    [firmId, clientId, creditsInvoiceId]
  );
  const row = original.rows[0];
  if (!row || row.status !== 'issued' || (row.kind || 'invoice') !== 'invoice') {
    const error = new Error('A credit note must reference an ISSUED invoice of the same client.');
    error.statusCode = 409;
    error.code = 'CREDIT_NOTE_ORIGINAL_NOT_ISSUED';
    throw error;
  }
  const priorResult = await client.query(
    `select coalesce(sum((draft->'invoice'->>'total')::numeric), 0) as credited
       from issued_invoices
      where firm_id = $1 and client_id = $2
        and credits_invoice_id = $3
        and kind = 'credit_note'
        and status in ('draft_pending_confirmation', 'issued')
        and ($4::text is null or id <> $4)`,
    [firmId, clientId, creditsInvoiceId, excludeInvoiceId]
  );
  const prior = Number(priorResult.rows[0]?.credited) || 0;
  const total = Number(row.total) || 0;
  if (!(Number(creditTotal) > 0) || prior + Number(creditTotal) > total + 0.01) {
    const error = new Error(`Credit cap exceeded: ${prior} already credited/pending of ${total}; cannot add ${creditTotal}.`);
    error.statusCode = 409;
    error.code = 'CREDIT_NOTE_CAP_EXCEEDED';
    throw error;
  }
};

export const __createIssuedInvoiceDraftWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  draft = null,
  buyerName = null,
  buyerEmail = null,
  kind = 'invoice',
  creditsInvoiceId = null,
  // buildDraft({ sequence }) → { draft, buyerName, buyerEmail, kind?,
  // creditsInvoiceId? }: lets the caller build the final artifacts WITH the
  // allocated invoice number, inside this txn.
  buildDraft = null,
  actorId = 'system'
} = {}) => {
  if (!clientId || (!draft && typeof buildDraft !== 'function')) {
    const error = new Error('Client id and a draft payload (or buildDraft) are required to create an issued-invoice draft.');
    error.statusCode = 400;
    throw error;
  }
  // Atomic per-client sequential allocation: the single upsert both seeds and
  // bumps the counter; `next_invoice_no - 1` is the number this draft takes.
  const allocated = await client.query(
    `insert into issued_invoice_counters (firm_id, client_id, next_invoice_no)
     values ($1, $2, 2)
     on conflict (firm_id, client_id)
     do update set next_invoice_no = issued_invoice_counters.next_invoice_no + 1
     returning next_invoice_no - 1 as invoice_no`,
    [firmId, clientId]
  );
  const invoiceNumber = Number(allocated.rows[0]?.invoice_no);
  if (!Number.isInteger(invoiceNumber) || invoiceNumber < 1) {
    const error = new Error('Invoice number allocation failed.');
    error.statusCode = 500;
    throw error;
  }
  if (typeof buildDraft === 'function') {
    const built = buildDraft({ sequence: invoiceNumber });
    draft = built?.draft || {};
    buyerName = built?.buyerName ?? buyerName;
    buyerEmail = built?.buyerEmail ?? buyerEmail;
    kind = built?.kind || kind;
    creditsInvoiceId = built?.creditsInvoiceId ?? creditsInvoiceId;
  }
  kind = kind === 'credit_note' ? 'credit_note' : 'invoice';
  if (kind === 'credit_note') {
    if (!creditsInvoiceId) {
      const error = new Error('A credit-note draft requires the original invoice id it credits.');
      error.statusCode = 400;
      error.code = 'CREDIT_NOTE_ORIGINAL_REQUIRED';
      throw error;
    }
    await __assertCreditNoteCapWithClient({
      client, firmId, clientId, creditsInvoiceId,
      creditTotal: Number(draft?.invoice?.total) || 0
    });
  } else {
    creditsInvoiceId = null;
  }
  const id = `issued-invoice-${firmId}-${clientId}-${invoiceNumber}`;
  const inserted = await client.query(
    `insert into issued_invoices (
       id, firm_id, client_id, invoice_number, status, kind, credits_invoice_id, draft, buyer_name, buyer_email, created_by
     )
     values ($1, $2, $3, $4, 'draft_pending_confirmation', $5, $6, $7::jsonb, $8, $9, $10)
     returning *`,
    [id, firmId, clientId, invoiceNumber, kind, creditsInvoiceId, JSON.stringify(draft), buyerName, buyerEmail, actorId]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'invoice.draft_created', 'issued_invoice', $4, $5::jsonb)`,
    [firmId, clientId, actorId, id, JSON.stringify({
      invoice_number: invoiceNumber,
      kind,
      credits_invoice_id: creditsInvoiceId,
      buyer_name: buyerName,
      total: draft?.invoice?.total ?? null,
      model: draft?.model || null
    })]
  );
  return rowToIssuedInvoicePayload(inserted.rows[0]);
};

export const createIssuedInvoiceDraftInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __createIssuedInvoiceDraftWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// Guarded transition helper: the WHERE clause enforces the closed lifecycle —
// only a pending draft moves; anything else is a typed refusal, never a shade.
const issuedInvoiceTransitionRefusal = () => {
  const error = new Error('Issued-invoice transition refused: the row is not a pending draft.');
  error.statusCode = 409;
  error.code = 'ISSUED_INVOICE_NOT_PENDING';
  return error;
};

export const __supersedeIssuedInvoiceDraftWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  invoiceId,
  draft = {},
  buyerName = null,
  buyerEmail = null,
  kind = 'invoice',
  creditsInvoiceId = null,
  actorId = 'system'
} = {}) => {
  kind = kind === 'credit_note' ? 'credit_note' : 'invoice';
  if (kind === 'credit_note') {
    if (!creditsInvoiceId) {
      const error = new Error('A credit-note draft requires the original invoice id it credits.');
      error.statusCode = 400;
      error.code = 'CREDIT_NOTE_ORIGINAL_REQUIRED';
      throw error;
    }
    // The superseded row's own prior share is excluded — the correction
    // replaces it, it doesn't stack on it.
    await __assertCreditNoteCapWithClient({
      client, firmId, clientId, creditsInvoiceId,
      creditTotal: Number(draft?.invoice?.total) || 0,
      excludeInvoiceId: invoiceId
    });
  } else {
    creditsInvoiceId = null;
  }
  const updated = await client.query(
    `update issued_invoices
        set draft = $5::jsonb, buyer_name = $6, buyer_email = $7,
            kind = $8, credits_invoice_id = $9, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, invoiceId, 'draft_pending_confirmation', JSON.stringify(draft), buyerName, buyerEmail, kind, creditsInvoiceId]
  );
  if (!updated.rows.length) throw issuedInvoiceTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'invoice.draft_superseded', 'issued_invoice', $4, $5::jsonb)`,
    [firmId, clientId, actorId, invoiceId, JSON.stringify({
      invoice_number: updated.rows[0].invoice_number,
      kind,
      credits_invoice_id: creditsInvoiceId,
      buyer_name: buyerName,
      total: draft?.invoice?.total ?? null,
      model: draft?.model || null
    })]
  );
  return rowToIssuedInvoicePayload(updated.rows[0]);
};

export const supersedeIssuedInvoiceDraftInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __supersedeIssuedInvoiceDraftWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

export const __cancelIssuedInvoiceWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  invoiceId,
  reason = 'owner_declined',
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update issued_invoices
        set status = 'cancelled', cancelled_at = now(), cancel_reason = $5,
            authority_basis = $6::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, invoiceId, 'draft_pending_confirmation', String(reason || 'owner_declined'), JSON.stringify(authorityBasis || null)]
  );
  if (!updated.rows.length) throw issuedInvoiceTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'invoice.cancelled', 'issued_invoice', $4, $5::jsonb)`,
    [firmId, clientId, actorId, invoiceId, JSON.stringify({
      invoice_number: updated.rows[0].invoice_number,
      reason: String(reason || 'owner_declined'),
      authority_basis: authorityBasis || null
    })]
  );
  return rowToIssuedInvoicePayload(updated.rows[0]);
};

export const cancelIssuedInvoiceInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __cancelIssuedInvoiceWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

export const __markIssuedInvoiceIssuedWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  invoiceId,
  arJournalId = null,
  cashBasisSkip = false,
  transmitReceipt = null,
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  if (!authorityBasis || !authorityBasis.source) {
    const error = new Error('Issuing an invoice requires the owner\'s authority basis (the confirmation receipt).');
    error.statusCode = 400;
    error.code = 'ISSUED_INVOICE_AUTHORITY_REQUIRED';
    throw error;
  }
  const updated = await client.query(
    `update issued_invoices
        set status = 'issued', issued_at = now(), issued_by = $5,
            ar_journal_id = $6, cash_basis_skip = $7,
            transmit_receipt = $8::jsonb, authority_basis = $9::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, invoiceId, 'draft_pending_confirmation', actorId, arJournalId, cashBasisSkip === true, JSON.stringify(transmitReceipt || null), JSON.stringify(authorityBasis)]
  );
  if (!updated.rows.length) throw issuedInvoiceTransitionRefusal();
  // C-1 conversion: an invoice drafted FROM a quote flips that quote to
  // 'converted' in this SAME transaction (invoice-issued ⟺ quote-converted).
  // Guarded on status='sent': if the quote left 'sent' between drafting and
  // this kyllä (owner declined it mid-flight), the flip is SKIPPED and the
  // skip recorded on the issue receipt — never silent, never blocking a
  // legitimate invoice over quote-state drift.
  const fromQuoteId = updated.rows[0]?.draft?.from_quote_id || null;
  let quoteConversion = null;
  if (fromQuoteId) {
    const flipped = await client.query(
      `update issued_quotes
          set status = 'converted', converted_invoice_id = $4, converted_at = now(), updated_at = now()
        where firm_id = $1 and client_id = $2 and id = $3 and status = 'sent'
        returning quote_number`,
      [firmId, clientId, fromQuoteId, invoiceId]
    );
    quoteConversion = flipped.rows.length ? 'converted' : 'skipped_not_sent';
    if (flipped.rows.length) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'client', $3, 'quote.converted', 'issued_quote', $4, $5::jsonb)`,
        [firmId, clientId, actorId, fromQuoteId, JSON.stringify({
          quote_number: flipped.rows[0].quote_number,
          converted_invoice_id: invoiceId,
          invoice_number: updated.rows[0].invoice_number
        })]
      );
    }
  }
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'invoice.issued', 'issued_invoice', $4, $5::jsonb)`,
    [firmId, clientId, actorId, invoiceId, JSON.stringify({
      invoice_number: updated.rows[0].invoice_number,
      ar_journal_id: arJournalId,
      cash_basis_skip: cashBasisSkip === true,
      transmit_message_id: transmitReceipt?.message_id || null,
      authority_basis: authorityBasis,
      ...(fromQuoteId ? { from_quote_id: fromQuoteId, quote_conversion: quoteConversion } : {}),
      // The model id is part of the receipt (the intake model rides the draft).
      model: updated.rows[0]?.draft?.model || null
    })]
  );
  return rowToIssuedInvoicePayload(updated.rows[0]);
};

export const markIssuedInvoiceIssuedInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __markIssuedInvoiceIssuedWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// ---------------------------------------------------------------------------------
// G-8 — the credit-note intake's original-invoice lookup: resolve an ISSUED
// invoice by its DISPLAY number ("2026001" — the persisted draft's number, not
// the sequence int) plus the prior credited sum (pending drafts INCLUDED, the
// same set the D-G8-3 cap guards, so classify and the persist gate agree).
// ---------------------------------------------------------------------------------
export const getIssuedInvoiceCreditContextInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  originalInvoiceNumber,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  const displayNumber = String(originalInvoiceNumber || '').trim();
  if (!clientId || !displayNumber) return { originalRow: null, priorCreditedTotal: 0 };
  return withFirmDbClientFn(async (client) => {
    const original = await client.query(
      `select * from issued_invoices
        where firm_id = $1 and client_id = $2
          and status = 'issued'
          and coalesce(kind, 'invoice') = 'invoice'
          and draft->'invoice'->>'invoiceNumber' = $3
        limit 1`,
      [firmId, clientId, displayNumber]
    );
    const row = original.rows[0] || null;
    if (!row) return { originalRow: null, priorCreditedTotal: 0 };
    const prior = await client.query(
      `select coalesce(sum((draft->'invoice'->>'total')::numeric), 0) as credited
         from issued_invoices
        where firm_id = $1 and client_id = $2
          and credits_invoice_id = $3
          and kind = 'credit_note'
          and status in ('draft_pending_confirmation', 'issued')`,
      [firmId, clientId, row.id]
    );
    return {
      originalRow: rowToIssuedInvoicePayload(row),
      priorCreditedTotal: Number(prior.rows[0]?.credited) || 0
    };
  });
};

// ---------------------------------------------------------------------------------
// C-1 — the issued-quote (tarjous) lifecycle store (migration 070). The sibling
// of the issued-invoice store above, on its OWN numbering series
// (issued_quote_counters — quotes never consume laskunumero, D-C1-1). The
// lifecycle enum is CLOSED (draft_pending_confirmation | sent | converted |
// declined | cancelled); every transition is audit-as-precondition. No ledger
// writer exists here — a tarjous books nothing (D-C1-4); the 'converted' flip
// lives inside __markIssuedInvoiceIssuedWithClient (the converting invoice's
// issue transaction). Design: docs/design-donna-finland-c1-quote-send.md.
// ---------------------------------------------------------------------------------

const rowToIssuedQuotePayload = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    firm_id: row.firm_id,
    client_id: row.client_id,
    quote_number: row.quote_number != null ? Number(row.quote_number) : null,
    status: row.status,
    draft: row.draft || {},
    buyer_name: row.buyer_name || null,
    buyer_email: row.buyer_email || null,
    valid_until: row.valid_until || null,
    transmit_receipt: row.transmit_receipt || null,
    authority_basis: row.authority_basis || null,
    sent_at: row.sent_at || null,
    converted_invoice_id: row.converted_invoice_id || null,
    converted_at: row.converted_at || null,
    declined_at: row.declined_at || null,
    decline_reason: row.decline_reason || null,
    cancelled_at: row.cancelled_at || null,
    cancel_reason: row.cancel_reason || null,
    created_by: row.created_by || null,
    sent_by: row.sent_by || null
  };
};

const issuedQuoteTransitionRefusal = (expected = 'a pending draft') => {
  const error = new Error(`Issued-quote transition refused: the row is not ${expected}.`);
  error.statusCode = 409;
  error.code = 'ISSUED_QUOTE_TRANSITION_REFUSED';
  return error;
};

export const __createIssuedQuoteDraftWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  draft = null,
  buyerName = null,
  buyerEmail = null,
  validUntil = null,
  // buildDraft({ sequence }) → { draft, buyerName, buyerEmail, validUntil }:
  // the caller builds the final artifacts WITH the allocated quote number,
  // inside this txn (the issued-invoice pattern).
  buildDraft = null,
  actorId = 'system'
} = {}) => {
  if (!clientId || (!draft && typeof buildDraft !== 'function')) {
    const error = new Error('Client id and a draft payload (or buildDraft) are required to create an issued-quote draft.');
    error.statusCode = 400;
    throw error;
  }
  const allocated = await client.query(
    `insert into issued_quote_counters (firm_id, client_id, next_quote_no)
     values ($1, $2, 2)
     on conflict (firm_id, client_id)
     do update set next_quote_no = issued_quote_counters.next_quote_no + 1
     returning next_quote_no - 1 as quote_no`,
    [firmId, clientId]
  );
  const quoteNumber = Number(allocated.rows[0]?.quote_no);
  if (!Number.isInteger(quoteNumber) || quoteNumber < 1) {
    const error = new Error('Quote number allocation failed.');
    error.statusCode = 500;
    throw error;
  }
  if (typeof buildDraft === 'function') {
    const built = buildDraft({ sequence: quoteNumber });
    draft = built?.draft || {};
    buyerName = built?.buyerName ?? buyerName;
    buyerEmail = built?.buyerEmail ?? buyerEmail;
    validUntil = built?.validUntil ?? validUntil;
  }
  const id = `issued-quote-${firmId}-${clientId}-${quoteNumber}`;
  const inserted = await client.query(
    `insert into issued_quotes (
       id, firm_id, client_id, quote_number, status, draft, buyer_name, buyer_email, valid_until, created_by
     )
     values ($1, $2, $3, $4, 'draft_pending_confirmation', $5::jsonb, $6, $7, $8, $9)
     returning *`,
    [id, firmId, clientId, quoteNumber, JSON.stringify(draft), buyerName, buyerEmail, validUntil, actorId]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'quote.draft_created', 'issued_quote', $4, $5::jsonb)`,
    [firmId, clientId, actorId, id, JSON.stringify({
      quote_number: quoteNumber,
      buyer_name: buyerName,
      total: draft?.quote?.total ?? null,
      valid_until: validUntil,
      model: draft?.model || null
    })]
  );
  return rowToIssuedQuotePayload(inserted.rows[0]);
};

export const createIssuedQuoteDraftInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __createIssuedQuoteDraftWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

export const __supersedeIssuedQuoteDraftWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  quoteId,
  draft = {},
  buyerName = null,
  buyerEmail = null,
  validUntil = null,
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update issued_quotes
        set draft = $5::jsonb, buyer_name = $6, buyer_email = $7, valid_until = $8, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, quoteId, 'draft_pending_confirmation', JSON.stringify(draft), buyerName, buyerEmail, validUntil]
  );
  if (!updated.rows.length) throw issuedQuoteTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'quote.draft_superseded', 'issued_quote', $4, $5::jsonb)`,
    [firmId, clientId, actorId, quoteId, JSON.stringify({
      quote_number: updated.rows[0].quote_number,
      buyer_name: buyerName,
      total: draft?.quote?.total ?? null,
      valid_until: validUntil,
      model: draft?.model || null
    })]
  );
  return rowToIssuedQuotePayload(updated.rows[0]);
};

export const supersedeIssuedQuoteDraftInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __supersedeIssuedQuoteDraftWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

export const __cancelIssuedQuoteWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  quoteId,
  reason = 'owner_declined',
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update issued_quotes
        set status = 'cancelled', cancelled_at = now(), cancel_reason = $5,
            authority_basis = $6::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, quoteId, 'draft_pending_confirmation', String(reason || 'owner_declined'), JSON.stringify(authorityBasis || null)]
  );
  if (!updated.rows.length) throw issuedQuoteTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'quote.cancelled', 'issued_quote', $4, $5::jsonb)`,
    [firmId, clientId, actorId, quoteId, JSON.stringify({
      quote_number: updated.rows[0].quote_number,
      reason: String(reason || 'owner_declined'),
      authority_basis: authorityBasis || null
    })]
  );
  return rowToIssuedQuotePayload(updated.rows[0]);
};

export const cancelIssuedQuoteInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __cancelIssuedQuoteWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

export const __markIssuedQuoteSentWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  quoteId,
  validUntil = null,
  transmitReceipt = null,
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  if (!authorityBasis || !authorityBasis.source) {
    const error = new Error('Sending a quote requires the owner\'s authority basis (the confirmation receipt).');
    error.statusCode = 400;
    error.code = 'ISSUED_QUOTE_AUTHORITY_REQUIRED';
    throw error;
  }
  const updated = await client.query(
    `update issued_quotes
        set status = 'sent', sent_at = now(), sent_by = $5,
            valid_until = coalesce($6, valid_until),
            transmit_receipt = $7::jsonb, authority_basis = $8::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, quoteId, 'draft_pending_confirmation', actorId, validUntil, JSON.stringify(transmitReceipt || null), JSON.stringify(authorityBasis)]
  );
  if (!updated.rows.length) throw issuedQuoteTransitionRefusal();
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'quote.sent', 'issued_quote', $4, $5::jsonb)`,
    [firmId, clientId, actorId, quoteId, JSON.stringify({
      quote_number: updated.rows[0].quote_number,
      valid_until: updated.rows[0].valid_until || null,
      transmit_message_id: transmitReceipt?.message_id || null,
      authority_basis: authorityBasis,
      // The model id is part of the receipt (the intake model rides the draft).
      model: updated.rows[0]?.draft?.model || null
    })]
  );
  return rowToIssuedQuotePayload(updated.rows[0]);
};

export const markIssuedQuoteSentInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __markIssuedQuoteSentWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// The owner REPORTS the customer's rejection — sent → declined, receipted.
export const __declineIssuedQuoteWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  quoteId,
  reason = 'customer_declined',
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  const updated = await client.query(
    `update issued_quotes
        set status = 'declined', declined_at = now(), decline_reason = $5, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = $4
      returning *`,
    [firmId, clientId, quoteId, 'sent', String(reason || 'customer_declined')]
  );
  if (!updated.rows.length) throw issuedQuoteTransitionRefusal('a sent quote');
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'client', $3, 'quote.declined', 'issued_quote', $4, $5::jsonb)`,
    [firmId, clientId, actorId, quoteId, JSON.stringify({
      quote_number: updated.rows[0].quote_number,
      reason: String(reason || 'customer_declined'),
      authority_basis: authorityBasis || null
    })]
  );
  return rowToIssuedQuotePayload(updated.rows[0]);
};

export const declineIssuedQuoteInDb = async (args = {}) => {
  return withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const result = await __declineIssuedQuoteWithClient({ client, ...args });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
};

// The quote lookups the intake needs: by id (the confirm phase) and by the
// owner-typed display number ("T2026001" / "2026001" / a bare sequence).
export const getIssuedQuoteByIdInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  quoteId,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId || !quoteId) return null;
  return withFirmDbClientFn(async (client) => {
    const result = await client.query(
      `select * from issued_quotes where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
      [firmId, clientId, quoteId]
    );
    return rowToIssuedQuotePayload(result.rows[0] || null);
  });
};

export const getIssuedQuoteContextInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  quoteNumber,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  const raw = String(quoteNumber || '').trim().toUpperCase();
  const withoutPrefix = raw.replace(/^T/, '');
  if (!clientId || !withoutPrefix) return { quoteRow: null };
  return withFirmDbClientFn(async (client) => {
    const result = await client.query(
      `select * from issued_quotes
        where firm_id = $1 and client_id = $2
          and (upper(coalesce(draft->'quote'->>'quoteNumber', '')) in ($3, 'T' || $3)
               or quote_number::text = $3)
        order by created_at desc
        limit 1`,
      [firmId, clientId, withoutPrefix]
    );
    return { quoteRow: rowToIssuedQuotePayload(result.rows[0] || null) };
  });
};

// C-1c — the quotes read surface (D-C1-8's named follow-up). READ-ONLY and
// deterministic: every issued_quotes row annotated at read time by the pure
// module (expiry computes here, never stored — D-C1-2) and folded into the
// open/sent/converted funnel with the panel's Finnish summary line. Gate:
// FINLAND_QUOTES as its typed 403 — the read surface of the quote capability,
// same fail-closed contract as the write lane; no new flag.
export const getFinlandQuotesFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the quotes report.');
    error.statusCode = 400;
    throw error;
  }
  const at = readAt || new Date().toISOString();
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const quotesAct = clientFlagActs({ flagKey: FINLAND_QUOTES_FLAG_KEY, snapshot, envFallback: () => false });
    if (!quotesAct) {
      const error = new Error('The Finland quotes report requires FINLAND_QUOTES for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_QUOTES_DISABLED';
      throw error;
    }
    const result = await client.query(
      `select * from issued_quotes
        where firm_id = $1 and client_id = $2
        order by quote_number desc`,
      [firmId, clientId]
    );
    const summary = summarizeQuoteFunnel({
      rows: result.rows.map(rowToIssuedQuotePayload),
      today: String(at).slice(0, 10)
    });
    return {
      issued_quotes: summary,
      provenance: { source: 'issued_quotes', readAt: at, deterministic: true }
    };
  });
};

// ---------------------------------------------------------------------------------
// G-8 Half B — partial-payment awareness on issued invoices (closes FI-10's
// F-U4). READ-ONLY and deterministic: issued invoices + their ISSUED credit
// notes + money-in bank lines matched on viitenumero/display number, evaluated
// at read time by the pure module (finland/issuedInvoiceSettlement.js). No
// stored derived state, no LLM call, no reconciliation-engine coupling.
// Gate: FINLAND_INVOICING (the read surface of the invoicing capability —
// no new flag, D-G8-6). Design: docs/design-donna-finland-fi15-g8-credit-notes.md.
// ---------------------------------------------------------------------------------
export const getFinlandIssuedInvoicesFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  readAt = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for the issued-invoice report.');
    error.statusCode = 400;
    throw error;
  }
  const at = readAt || new Date().toISOString();
  return withFirmDbClientFn(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const invoicingActs = clientFlagActs({ flagKey: FINLAND_INVOICING_FLAG_KEY, snapshot, envFallback: () => false });
    if (!invoicingActs) {
      const error = new Error('The Finland issued-invoice report requires FINLAND_INVOICING for this client.');
      error.statusCode = 403;
      error.code = 'FINLAND_INVOICING_DISABLED';
      throw error;
    }

    const invoiceResult = await client.query(
      `select * from issued_invoices
        where firm_id = $1 and client_id = $2
          and status = 'issued'
          and coalesce(kind, 'invoice') = 'invoice'
        order by invoice_number`,
      [firmId, clientId]
    );
    const invoices = invoiceResult.rows.map(rowToIssuedInvoicePayload);
    if (!invoices.length) {
      return {
        issued_invoices: { invoices: [], summary: summarizeIssuedInvoices([]), banner_fi: null },
        provenance: { source: 'issued_invoices+bank_feed', readAt: at, deterministic: true }
      };
    }

    // Only ISSUED credit notes net a payment state (a pending draft credits
    // nothing yet — it is still on the owner).
    const creditResult = await client.query(
      `select credits_invoice_id,
              coalesce(sum((draft->'invoice'->>'total')::numeric), 0) as credited,
              array_agg(draft->'invoice'->>'invoiceNumber') as credit_note_numbers
         from issued_invoices
        where firm_id = $1 and client_id = $2
          and kind = 'credit_note'
          and status = 'issued'
          and credits_invoice_id is not null
        group by credits_invoice_id`,
      [firmId, clientId]
    );
    const creditsByOriginal = new Map(creditResult.rows.map((r) => [r.credits_invoice_id, r]));

    // Candidate money-in bank lines from the earliest invoice date onward; the
    // conservative reference matching happens in the pure module (testable, no
    // SQL string gymnastics).
    const earliestDate = invoices
      .map((inv) => String(inv.draft?.invoice?.date || '').slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()[0] || String(at).slice(0, 10);
    // G12: structured_reference (migration 098) joins the read so the panel
    // and the send-time guard agree on the same settlement truth. Pre-098
    // databases retry without the column — never an empty read.
    const settlementTxSelect = (withStructured) =>
      `select id, description, raw_description${withStructured ? ', structured_reference' : ''}, money_in, transaction_date
         from transactions
        where firm_id = $1 and client_id = $2
          and money_in > 0
          and (transaction_date is null or transaction_date >= $3)
        order by transaction_date nulls last
        limit 5000`;
    const txResult = await client.query(
      settlementTxSelect(true), [firmId, clientId, earliestDate]
    ).catch((error) => {
      if (error?.code !== '42703') throw error;
      return client.query(settlementTxSelect(false), [firmId, clientId, earliestDate]);
    });

    const enriched = invoices.map((inv) => {
      const draftInvoice = inv.draft?.invoice || {};
      const referenceNumber = inv.draft?.finvoice?.invoiceDetails?.referenceNumber
        || inv.draft?.finvoice?.paymentDetails?.referenceNumber
        || null;
      const matches = txResult.rows.filter((tx) => paymentMatchesInvoice(
        { referenceNumber, invoiceNumber: draftInvoice.invoiceNumber },
        tx
      ));
      const creditRow = creditsByOriginal.get(inv.id) || null;
      const settlement = evaluateIssuedInvoiceSettlement({
        total: Number(draftInvoice.total) || 0,
        dueDate: draftInvoice.dueDate || null,
        creditedTotal: creditRow ? Number(creditRow.credited) || 0 : 0,
        payments: matches.map((tx) => ({ amount: Number(tx.money_in) || 0, date: tx.transaction_date || null })),
        onDate: at
      });
      return {
        id: inv.id,
        invoice_number: draftInvoice.invoiceNumber || String(inv.invoice_number),
        buyer_name: inv.buyer_name,
        date: draftInvoice.date || null,
        due_date: draftInvoice.dueDate || null,
        total: Number(draftInvoice.total) || 0,
        currency: draftInvoice.currency || 'EUR',
        reference_number: referenceNumber,
        credit_note_numbers: creditRow ? (creditRow.credit_note_numbers || []).filter(Boolean) : [],
        matched_payment_count: matches.length,
        settlement
      };
    });

    const summary = summarizeIssuedInvoices(enriched);
    return {
      issued_invoices: { invoices: enriched, summary, banner_fi: buildIssuedInvoiceBannerFi(summary) },
      provenance: { source: 'issued_invoices+bank_feed', readAt: at, deterministic: true }
    };
  });
};

// Seller identity for the issuance route (D-FI10-U4): the client row's profile,
// read through the pure sellerContextFromClientRow. Missing pieces are the
// route's cue to ask the owner, never to guess.
export const getInvoiceSellerContextInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) => {
  if (!clientId) return {};
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select * from clients where firm_id = $1 and id = $2 limit 1`,
      [firmId, clientId]
    );
    return sellerContextFromClientRow(result.rows[0] || {});
  });
};

export const getIssuedInvoiceByIdInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, invoiceId } = {}) => {
  if (!clientId || !invoiceId) return null;
  return withFirmDbClient(async (client) => {
    const result = await client.query(
      `select * from issued_invoices where firm_id = $1 and client_id = $2 and id = $3 limit 1`,
      [firmId, clientId, invoiceId]
    );
    return rowToIssuedInvoicePayload(result.rows[0] || null);
  });
};
