// FI-10 issuance-UX owner route: the WhatsApp conversation state machine around
// invoiceIssuance.js — owner-initiated entry (unanchored "laskuta …"), the
// confirm/cancel/correct round-trips, and the issue motion dispatch. Mirrors
// openingBalanceRoute.js: PURE + I/O-injectable (tests run without DB, LLM,
// WhatsApp, or email). Design: docs/design-donna-finland-fi10-issuance-ux.md.

import {
  buildCreditNoteArtifacts,
  buildIssuanceArtifacts,
  formatInvoiceNumber,
  issueConfirmedInvoice,
  runInvoiceIssuanceIntake
} from './invoiceIssuance.js';
// C-1 — the quote (tarjous) lane on the same spine: same ask kind, quote
// phases. Design: docs/design-donna-finland-c1-quote-send.md.
import {
  buildQuoteArtifacts,
  formatQuoteNumber,
  sendConfirmedQuote
} from './quoteIssuance.js';
// FI-13 13.4 PR3 — the issuance ALV activation: the route resolves the client's
// effective-dated registration + the FINLAND_ALV_INVOICING flag into the ONE
// alvContext for the invoice date. Flag off / no effective registration ⇒ the
// exempt context ⇒ byte-identical to the pre-ALV route.
import { resolveIssuanceAlvContext } from './alvInvoicing.js';

export const INVOICE_ISSUANCE_ASK_KIND = 'invoice_issuance';

const clean = (value) => String(value || '').trim();
const lower = (value) => clean(value).toLowerCase();

export const isInvoiceIssuanceAsk = (ask = {}) => {
  ask = ask || {};
  const payload = ask.request_payload || ask.payload || {};
  return Boolean(ask.kind === INVOICE_ISSUANCE_ASK_KIND
    || ask.evidence_type === INVOICE_ISSUANCE_ASK_KIND
    || payload.kind === INVOICE_ISSUANCE_ASK_KIND
    || payload.invoice_issuance);
};

// Conservative explicit yes/no — the FI-6 affirmative regex + a negative twin.
// Anything else is NEVER a send and NEVER a cancel (two-terminal-states: the ask
// stays open, on the owner).
const isAffirmative = (text) => /^(yes|y|kyllä|kylla|joo|juu|ok|okay|vahvistan)$/iu.test(lower(text));
const isNegative = (text) => /^(no|ei|peru|peruuta|peruutus|cancel|stop)$/iu.test(lower(text));

export const buildInvoiceIssuanceAuthorityBasis = ({ message = {}, phoneHash = null } = {}) => ({
  source: 'owner_whatsapp_invoice_confirmation',
  provider: 'whatsapp',
  providerMessageId: message.id || message.message_id || null,
  sentAt: message.timestamp || message.sent_at || message.received_at || null,
  phoneHash: phoneHash || null
});

export const buildQuoteIssuanceAuthorityBasis = ({ message = {}, phoneHash = null } = {}) => ({
  ...buildInvoiceIssuanceAuthorityBasis({ message, phoneHash }),
  source: 'owner_whatsapp_quote_confirmation'
});

// The confirm summary renders the PERSISTED draft (render-the-persisted-verdict).
// A credit-note draft (G-8) summarizes as HYVITYSLASKU with the owner-facing
// NEGATIVE amounts and the original-invoice reference (the model stays positive
// — D-G8-4; the summary shows what the buyer will see).
// Finnish rate display (decimal comma, no trailing zeros): 25.5 → "25,5".
const fiRateText = (value) => String(Number(value)).replace('.', ',');

export const summarizeInvoiceDraft = (draft = {}) => {
  const invoice = draft.invoice || {};
  const isCreditNote = invoice.kind === 'credit_note';
  const sign = isCreditNote ? -1 : 1;
  const currency = invoice.currency || 'EUR';
  // FI-13 13.4: registration-aware summary — renders the PERSISTED verdict
  // (invoice.alvExempt, set by buildInvoice from the resolved alvContext), never
  // a re-inference. An exempt draft keeps the AVL 3 § note byte-identically.
  const alv = invoice.alvExempt === false;
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const rendered = lines.map((l) => `• ${l.description} — ${(sign * (Number(l.net) || 0)).toFixed(2)} ${currency}${alv ? ` (alv ${fiRateText(l.alvRate || 0)} %)` : ''}`);
  const out = [
    isCreditNote
      ? `Hyvityslasku ${invoice.invoiceNumber} laskulle ${invoice.creditsInvoiceNumber || ''} — ${invoice.buyer?.name || ''}`.replace(/\s+/g, ' ').trim()
      : `Lasku ${invoice.invoiceNumber} — ${invoice.buyer?.name || draft.intent?.buyer_name || ''}`.trim()
  ];
  out.push(...rendered);
  out.push(alv
    ? `Yhteensä ${(sign * (Number(invoice.total) || 0)).toFixed(2)} ${currency} (sis. ALV ${(sign * (Number(invoice.alvTotal) || 0)).toFixed(2)} ${currency})`
    : `Yhteensä ${(sign * (Number(invoice.total) || 0)).toFixed(2)} ${currency} (ei ALV, AVL 3 §)`);
  if (!isCreditNote && invoice.dueDate) out.push(`Eräpäivä ${invoice.dueDate}`);
  // The summary says which artifact goes out (D-FI10-P1): a consumer buyer (no
  // Y-tunnus) gets the PDF lane; a missing format is a pre-PDF-lane XML draft.
  const artifactWord = isCreditNote ? 'hyvityslaskun' : (draft.transmit?.format === 'pdf' ? 'laskun' : 'verkkolaskun');
  out.push(draft.transmit?.format === 'pdf'
    ? `Lähetän ${artifactWord} PDF-muodossa sähköpostilla osoitteeseen ${draft.transmit?.to || ''}.`.trim()
    : `Lähetän ${artifactWord} sähköpostilla osoitteeseen ${draft.transmit?.to || ''}.`.trim());
  // C-1 conversion: the summary STATES the quote link + a read-time expiry note
  // (an expired quote still converts — the owner's kyllä is the call, D-C1-2).
  if (!isCreditNote && draft.from_quote_number) {
    out.push(`Tarjouksesta ${draft.from_quote_number}.`);
    if (draft.from_quote_expired) out.push('Huom: tarjouksen voimassaolo on päättynyt.');
  }
  return out.join('\n');
};

// C-1: the quote confirm summary renders the PERSISTED quote draft.
export const summarizeQuoteDraft = (draft = {}) => {
  const quote = draft.quote || {};
  const currency = quote.currency || 'EUR';
  const lines = Array.isArray(quote.lines) ? quote.lines : [];
  const out = [`Tarjous ${quote.quoteNumber} — ${quote.buyer?.name || draft.intent?.buyer_name || ''}`.trim()];
  out.push(...lines.map((l) => `• ${l.description} — ${(Number(l.net) || 0).toFixed(2)} ${currency}`));
  out.push(`Yhteensä ${(Number(quote.total) || 0).toFixed(2)} ${currency} (ei ALV, AVL 3 §)`);
  if (quote.validUntil) out.push(`Voimassa ${quote.validUntil} asti`);
  out.push(`Lähetän tarjouksen PDF-muodossa sähköpostilla osoitteeseen ${draft.transmit?.to || ''}.`.trim());
  return out.join('\n');
};

const CONFIRM_INSTRUCTION = 'Vahvista vastaamalla “kyllä”. Peru vastaamalla “ei”. Voit myös korjata laskua (esim. “muuta summaksi 600 €”).';
const NUDGE_CONFIRM = `Vastaa “kyllä” niin lähetän laskun, tai “ei” niin perun sen. ${'Voit myös korjata laskua (esim. “muuta summaksi 600 €”).'}`;
const ISSUE_FAILED_TEXT = 'Laskun lähetys ei onnistunut. Vastaa “kyllä” niin yritän uudelleen, tai “ei” niin perun laskun.';
const QUOTE_CONFIRM_INSTRUCTION = 'Vahvista vastaamalla “kyllä”. Peru vastaamalla “ei”. Voit myös korjata tarjousta (esim. “muuta summaksi 3000 €”).';
const NUDGE_QUOTE_CONFIRM = 'Vastaa “kyllä” niin lähetän tarjouksen, tai “ei” niin perun sen. Voit myös korjata tarjousta (esim. “muuta summaksi 3000 €”).';
const QUOTE_SEND_FAILED_TEXT = 'Tarjouksen lähetys ei onnistunut. Vastaa “kyllä” niin yritän uudelleen, tai “ei” niin perun tarjouksen.';

// The ask payload is the ONLY conversation state source; the issued_invoices row is
// the ONLY draft source. Flat state (the FI-6 lesson): phase/invoice_id/request live
// directly under payload.invoice_issuance.
const stateFromAsk = ({ ask }) => {
  const payload = ask?.request_payload || ask?.payload || {};
  const raw = payload.invoice_issuance || {};
  return raw.state && typeof raw.state === 'object' ? { kind: raw.kind, ...raw.state } : raw;
};

const createIssuanceAsk = async ({ createAsk, firmId, clientId, parentAsk, kind, question, state, actorId }) => {
  if (typeof createAsk !== 'function') return { question, kind, state };
  return createAsk({
    firmId,
    clientId,
    parentAskId: parentAsk?.id || null,
    kind: INVOICE_ISSUANCE_ASK_KIND,
    evidenceType: INVOICE_ISSUANCE_ASK_KIND,
    question,
    actorId,
    requestPayload: {
      kind: INVOICE_ISSUANCE_ASK_KIND,
      // Flat state — stateFromAsk spreads payload.invoice_issuance directly.
      invoice_issuance: { kind, ...state }
    }
  });
};

// Merge the live profile context with the context persisted on the draft: the
// persisted answers (owner-supplied IBAN/Y-tunnus mid-conversation) survive, the
// live profile wins where it has a value.
const mergeSellerContext = (persisted = {}, live = {}) => {
  const merged = { ...(persisted || {}) };
  for (const [key, value] of Object.entries(live || {})) {
    if (value != null && value !== '') merged[key] = value;
  }
  return merged;
};

// buildDraft callback for the store writer: the invoice number is allocated inside
// the draft transaction, so the final artifacts are built there with the real
// number (the classify dry-run already validated the same inputs). A
// 'credit_draft' verdict (G-8) rebuilds through buildCreditNoteArtifacts and
// stamps kind + the original-invoice link onto the row.
const isCreditVerdict = (verdict) => verdict?.terminal === 'credit_draft';
const isDraftVerdict = (verdict) => verdict?.terminal === 'draft' || isCreditVerdict(verdict);

const rebuildArtifacts = ({ verdict, sellerContext, invoiceNumber, today, timestamp, alvContext = null }) =>
  isCreditVerdict(verdict)
    ? buildCreditNoteArtifacts({
        originalDraft: verdict.creditContext?.originalDraft || {},
        priorCreditedTotal: verdict.creditContext?.priorCreditedTotal || 0,
        credit: verdict.intent?.credit || {},
        invoiceNumber,
        date: today,
        timestamp
      })
    : buildIssuanceArtifacts({ intent: verdict.intent, sellerContext, invoiceNumber, date: today, timestamp, alvContext });

// C-1 conversion: the quote link rides the invoice draft jsonb (no
// issued_invoices schema change) — the issue transaction flips the quote on it.
const quoteLinkFields = (verdict) => (verdict?.quoteContext?.fromQuoteId
  ? {
      from_quote_id: verdict.quoteContext.fromQuoteId,
      from_quote_number: verdict.quoteContext.fromQuoteNumber || null,
      from_quote_expired: verdict.quoteContext.expired === true
    }
  : {});

const draftBuilder = ({ verdict, sellerContext, requestText, today, timestamp, alvContext = null }) => ({ sequence }) => {
  const invoiceNumber = formatInvoiceNumber({ sequence, date: today });
  const rebuilt = rebuildArtifacts({ verdict, sellerContext, invoiceNumber, today, timestamp, alvContext });
  if (!rebuilt.ok) {
    const error = new Error(`Invoice draft failed to rebuild with its allocated number: ${rebuilt.errors.join('; ')}`);
    error.code = 'INVOICE_DRAFT_REBUILD_FAILED';
    throw error;
  }
  const credit = isCreditVerdict(verdict);
  return {
    draft: {
      ...rebuilt.artifacts,
      intent: verdict.intent,
      sellerContext,
      request_text: requestText,
      model: verdict.model || null,
      ...quoteLinkFields(verdict)
    },
    buyerName: (credit ? rebuilt.artifacts.invoice?.buyer?.name : verdict.intent.buyer_name) || null,
    buyerEmail: (credit ? rebuilt.artifacts.transmit?.to : verdict.intent.buyer_email) || null,
    kind: credit ? 'credit_note' : 'invoice',
    creditsInvoiceId: credit ? (verdict.creditContext?.creditsInvoiceId || null) : null
  };
};

// C-1: the quote twin of draftBuilder — rebuilds the TARJOUS artifacts with the
// allocated quote number inside the draft transaction.
const isQuoteDraftVerdict = (verdict) => verdict?.terminal === 'quote_draft';

const quoteDraftBuilder = ({ verdict, sellerContext, requestText, today }) => ({ sequence }) => {
  const quoteNumber = formatQuoteNumber({ sequence, date: today });
  const rebuilt = buildQuoteArtifacts({ intent: verdict.intent, sellerContext, quoteNumber, date: today });
  if (!rebuilt.ok) {
    const error = new Error(`Quote draft failed to rebuild with its allocated number: ${rebuilt.errors.join('; ')}`);
    error.code = 'QUOTE_DRAFT_REBUILD_FAILED';
    throw error;
  }
  return {
    draft: {
      ...rebuilt.artifacts,
      intent: verdict.intent,
      sellerContext,
      request_text: requestText,
      model: verdict.model || null
    },
    buyerName: verdict.intent.buyer_name || null,
    buyerEmail: verdict.intent.buyer_email || null,
    validUntil: rebuilt.artifacts.quote?.validUntil || null
  };
};

const requestConfirmation = async ({
  firmId, clientId, parentAsk, actorId, createAsk, sendText, row
}) => {
  const summary = summarizeInvoiceDraft(row.draft);
  const question = `${summary}\n\n${CONFIRM_INSTRUCTION}`;
  const confirmationAsk = await createIssuanceAsk({
    createAsk,
    firmId,
    clientId,
    parentAsk,
    kind: 'confirm_request',
    question,
    actorId,
    state: { phase: 'confirm_request', invoice_id: row.id, summary }
  });
  if (typeof sendText === 'function') await sendText({ text: question, ask: confirmationAsk });
  return { action: 'request_confirmation', ask: { ...confirmationAsk, summary, question }, invoice: row };
};

// C-1: the quote confirm ask — same ask kind, quote phase + quote_id state.
const requestQuoteConfirmation = async ({
  firmId, clientId, parentAsk, actorId, createAsk, sendText, row
}) => {
  const summary = summarizeQuoteDraft(row.draft);
  const question = `${summary}\n\n${QUOTE_CONFIRM_INSTRUCTION}`;
  const confirmationAsk = await createIssuanceAsk({
    createAsk,
    firmId,
    clientId,
    parentAsk,
    kind: 'quote_confirm_request',
    question,
    actorId,
    state: { phase: 'quote_confirm_request', quote_id: row.id, summary }
  });
  if (typeof sendText === 'function') await sendText({ text: question, ask: confirmationAsk });
  return { action: 'request_quote_confirmation', ask: { ...confirmationAsk, summary, question }, quote: row };
};

const escalate = async ({
  firmId, clientId, parentAsk, actorId, createAsk, sendText, escalation, state
}) => {
  const question = escalation?.question || 'Kerro vielä laskun tiedot, niin jatkan.';
  const escalationAsk = await createIssuanceAsk({
    createAsk,
    firmId,
    clientId,
    parentAsk,
    kind: 'clarification',
    question,
    actorId,
    state: { phase: 'clarification', ...state }
  });
  if (typeof sendText === 'function') await sendText({ text: question, ask: escalationAsk });
  return { action: 'escalate', ask: { ...escalationAsk, question } };
};

// ---------------------------------------------------------------------------------
// startInvoiceIssuance — the owner-initiated (UNANCHORED) entry. The caller has
// already bound the phone to exactly one client, checked FINLAND_INVOICING, and
// claimed the inbound message (dedup). Returns { action: 'not_invoice' } when the
// message is not an invoicing instruction — the caller falls through to the
// existing nudge byte-identically.
// ---------------------------------------------------------------------------------
export const startInvoiceIssuance = async ({
  firmId,
  clientId,
  messageText = '',
  actorId = null,
  flagActs = true,
  // FI-13 13.4 PR3: does FINLAND_ALV_INVOICING act for this client? Default
  // false ⇒ the exempt alvContext ⇒ byte-identical to the pre-ALV route. The
  // flag alone never adds VAT — an effective registration must also cover the
  // invoice date (resolveIssuanceAlvContext).
  alvFlagActs = false,
  sellerContext = {},
  now = () => new Date().toISOString(),
  runIntakeImpl = runInvoiceIssuanceIntake,
  createDraftImpl,
  createAsk,
  sendText,
  apiKey,
  model,
  fetchImpl,
  transport,
  // G-8: resolves the original issued invoice + prior credit sum for a
  // credit-note intent ({ originalInvoiceNumber } → { originalRow,
  // priorCreditedTotal }). Optional — without it a credit intent escalates.
  resolveCreditContext = null,
  // C-1: the FINLAND_QUOTES gate + the quote lanes. quotesEnabled=false keeps
  // every quote intent byte-identical to not_invoice (zero side effects).
  quotesEnabled = false,
  resolveQuoteContext = null,
  createQuoteDraftImpl = null,
  declineQuoteImpl = null,
  message = {},
  phoneHash = null
} = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };
  const timestamp = now();
  const today = timestamp.slice(0, 10);
  // The ONE ALV verdict for this invoice date, from the LIVE profile's
  // registration record — exempt unless the flag acts AND the registration is
  // effective today.
  const alvContext = resolveIssuanceAlvContext({
    registration: sellerContext?.alvRegistration || null,
    asOf: today,
    flagActs: alvFlagActs === true
  });
  const verdict = await runIntakeImpl({
    messageText,
    priorDraft: null,
    sellerContext,
    today,
    timestamp,
    alvContext,
    apiKey,
    model,
    fetchImpl,
    transport,
    resolveCreditContext,
    quotesEnabled,
    resolveQuoteContext
  });

  if (verdict.terminal === 'not_invoice') return { action: 'not_invoice', verdict };

  if (verdict.terminal === 'escalate') {
    const result = await escalate({
      firmId, clientId, parentAsk: null, actorId, createAsk, sendText,
      escalation: verdict.escalation,
      state: { request: clean(messageText) }
    });
    return { ...result, verdict };
  }

  // C-1: a quote draft persists through the QUOTE writer (its own numbering
  // series) and confirms through the quote phase.
  if (isQuoteDraftVerdict(verdict)) {
    if (typeof createQuoteDraftImpl !== 'function') return { action: 'not_invoice', reason: 'quote_writer_missing', verdict };
    const row = await createQuoteDraftImpl({
      firmId,
      clientId,
      actorId,
      buildDraft: quoteDraftBuilder({ verdict, sellerContext, requestText: clean(messageText), today })
    });
    const result = await requestQuoteConfirmation({ firmId, clientId, parentAsk: null, actorId, createAsk, sendText, row });
    return { ...result, verdict };
  }

  // C-1: the owner REPORTS the customer's rejection — a receipted status flip,
  // nothing is sent (no confirm needed; decline is reporting, not outbound).
  if (verdict.terminal === 'quote_decline') {
    if (typeof declineQuoteImpl !== 'function') return { action: 'not_invoice', reason: 'quote_writer_missing', verdict };
    const authorityBasis = buildQuoteIssuanceAuthorityBasis({ message, phoneHash });
    const declined = await declineQuoteImpl({
      firmId,
      clientId,
      quoteId: verdict.quoteRow.id,
      reason: verdict.reason || 'customer_declined',
      authorityBasis,
      actorId
    });
    const quoteNumber = declined?.draft?.quote?.quoteNumber || verdict.quoteRow.draft?.quote?.quoteNumber || '';
    if (typeof sendText === 'function') await sendText({ text: `Merkitsin tarjouksen ${quoteNumber} hylätyksi.`.replace(/\s+/g, ' ').trim() });
    return { action: 'quote_declined', quote: declined, verdict };
  }

  const row = await createDraftImpl({
    firmId,
    clientId,
    actorId,
    buildDraft: draftBuilder({ verdict, sellerContext, requestText: clean(messageText), today, timestamp, alvContext })
  });
  const result = await requestConfirmation({ firmId, clientId, parentAsk: null, actorId, createAsk, sendText, row });
  return { ...result, verdict };
};

// ---------------------------------------------------------------------------------
// resolveInvoiceIssuanceInbound — anchored replies to an invoice_issuance ask.
// Phases: 'confirm_request' (kyllä → issue motion; ei → cancel; else correction)
// and 'clarification' (feed the answer back into the intake).
// Every transition resolves the ANSWERED ask (two-terminal-states: each pending
// row keeps exactly ONE open ask); a nudge leaves the ask open — still on the owner.
// ---------------------------------------------------------------------------------
export const resolveInvoiceIssuanceInbound = async ({
  firmId,
  clientId,
  ask = {},
  replyText = '',
  message = {},
  phoneHash = null,
  actorId = null,
  flagActs = true,
  // FI-13 13.4 PR3 — see startInvoiceIssuance: false ⇒ exempt ⇒ byte-identical.
  alvFlagActs = false,
  sellerContext = {},
  now = () => new Date().toISOString(),
  runIntakeImpl = runInvoiceIssuanceIntake,
  issueImpl = issueConfirmedInvoice,
  // F-U1 — persist the owner's OWN seller identity (Y-tunnus / IBAN) to the
  // profile after a successful issue when the profile lacked it. Best-effort;
  // null ⇒ skip (keeps the route pure for tests that don't exercise it).
  persistSellerIdentityImpl = null,
  getInvoiceImpl,
  createDraftImpl,
  supersedeDraftImpl,
  cancelImpl,
  markIssuedImpl,
  postImpl,
  postCreditNoteImpl,
  resolveCreditContext = null,
  transmitImpl,
  transmitPdfImpl,
  sendEmail,
  createAsk,
  resolveAsk,
  sendText,
  apiKey,
  model,
  fetchImpl,
  transport,
  // C-1: the quote lanes (same ask kind, quote phases). quotesEnabled=false
  // keeps quote intents byte-identical to not_invoice.
  quotesEnabled = false,
  resolveQuoteContext = null,
  getQuoteImpl,
  createQuoteDraftImpl,
  supersedeQuoteDraftImpl,
  cancelQuoteImpl,
  markQuoteSentImpl,
  sendQuoteImpl = sendConfirmedQuote
} = {}) => {
  if (!flagActs) return { action: 'skipped', reason: 'flag_off' };

  const state = stateFromAsk({ ask });
  const phase = state.phase || state.kind || 'clarification';
  const text = clean(replyText);
  const timestamp = now();
  const today = timestamp.slice(0, 10);
  // The ALV verdict for corrections/rebuilds in this conversation turn. From the
  // LIVE profile's registration (never a persisted copy) — a registration or
  // flag change between turns takes effect on the next rebuild.
  const alvContext = resolveIssuanceAlvContext({
    registration: sellerContext?.alvRegistration || null,
    asOf: today,
    flagActs: alvFlagActs === true
  });

  const closeAnsweredAsk = async (resolutionNote) => {
    if (typeof resolveAsk === 'function' && ask?.id) {
      await resolveAsk({ firmId, askId: ask.id, resolutionNote, actorId });
    }
  };

  const loadRow = async (invoiceId) => {
    if (!invoiceId || typeof getInvoiceImpl !== 'function') return null;
    return getInvoiceImpl({ firmId, clientId, invoiceId });
  };

  const runIntake = ({ messageText, priorDraft, ctx }) => runIntakeImpl({
    messageText,
    priorDraft,
    sellerContext: ctx,
    today,
    timestamp,
    alvContext,
    apiKey,
    model,
    fetchImpl,
    transport,
    resolveCreditContext,
    quotesEnabled,
    resolveQuoteContext
  });

  const loadQuoteRow = async (quoteId) => {
    if (!quoteId || typeof getQuoteImpl !== 'function') return null;
    return getQuoteImpl({ firmId, clientId, quoteId });
  };

  // C-1: persist a quote_draft verdict — supersede the row this conversation
  // already holds, else create a fresh one (allocating its quote number).
  const persistQuoteDraft = async ({ verdict, ctx, requestText, existingRow }) => {
    if (existingRow && typeof supersedeQuoteDraftImpl === 'function') {
      const quoteNumber = existingRow.draft?.quote?.quoteNumber
        || formatQuoteNumber({ sequence: existingRow.quote_number, date: today });
      const rebuilt = buildQuoteArtifacts({ intent: verdict.intent, sellerContext: ctx, quoteNumber, date: today });
      if (!rebuilt.ok) {
        const error = new Error(`Quote draft failed to rebuild: ${rebuilt.errors.join('; ')}`);
        error.code = 'QUOTE_DRAFT_REBUILD_FAILED';
        throw error;
      }
      return supersedeQuoteDraftImpl({
        firmId,
        clientId,
        quoteId: existingRow.id,
        draft: { ...rebuilt.artifacts, intent: verdict.intent, sellerContext: ctx, request_text: requestText, model: verdict.model || null },
        buyerName: verdict.intent.buyer_name || null,
        buyerEmail: verdict.intent.buyer_email || null,
        validUntil: rebuilt.artifacts.quote?.validUntil || null,
        actorId
      });
    }
    return createQuoteDraftImpl({
      firmId,
      clientId,
      actorId,
      buildDraft: quoteDraftBuilder({ verdict, sellerContext: ctx, requestText, today })
    });
  };

  // Persist a complete verdict: supersede the row this conversation already holds,
  // else create a fresh one (allocating its number). Credit-note verdicts (G-8)
  // rebuild through buildCreditNoteArtifacts and stamp kind + the original link.
  const persistDraft = async ({ verdict, ctx, requestText, existingRow }) => {
    const credit = isCreditVerdict(verdict);
    if (existingRow) {
      const invoiceNumber = existingRow.draft?.invoice?.invoiceNumber
        || formatInvoiceNumber({ sequence: existingRow.invoice_number, date: today });
      const rebuilt = rebuildArtifacts({ verdict, sellerContext: ctx, invoiceNumber, today, timestamp, alvContext });
      if (!rebuilt.ok) {
        const error = new Error(`Invoice draft failed to rebuild: ${rebuilt.errors.join('; ')}`);
        error.code = 'INVOICE_DRAFT_REBUILD_FAILED';
        throw error;
      }
      // A correction must not lose an existing quote-conversion link: the prior
      // link survives unless the fresh verdict carries its own (else the quote
      // would rest 'sent' forever after the invoice issues).
      const priorQuoteLink = existingRow.draft?.from_quote_id
        ? {
            from_quote_id: existingRow.draft.from_quote_id,
            from_quote_number: existingRow.draft.from_quote_number || null,
            from_quote_expired: existingRow.draft.from_quote_expired === true
          }
        : {};
      return supersedeDraftImpl({
        firmId,
        clientId,
        invoiceId: existingRow.id,
        draft: { ...rebuilt.artifacts, intent: verdict.intent, sellerContext: ctx, request_text: requestText, model: verdict.model || null, ...priorQuoteLink, ...quoteLinkFields(verdict) },
        buyerName: (credit ? rebuilt.artifacts.invoice?.buyer?.name : verdict.intent.buyer_name) || null,
        buyerEmail: (credit ? rebuilt.artifacts.transmit?.to : verdict.intent.buyer_email) || null,
        kind: credit ? 'credit_note' : 'invoice',
        creditsInvoiceId: credit ? (verdict.creditContext?.creditsInvoiceId || null) : null,
        actorId
      });
    }
    return createDraftImpl({
      firmId,
      clientId,
      actorId,
      buildDraft: draftBuilder({ verdict, sellerContext: ctx, requestText, today, timestamp, alvContext })
    });
  };

  // C-1: the quote confirm phase — kyllä sends the TARJOUS PDF (no post leg),
  // ei cancels, anything else is a correction against the persisted draft.
  if (phase === 'quote_confirm_request') {
    const row = await loadQuoteRow(state.quote_id);
    if (!row || row.status !== 'draft_pending_confirmation') {
      await closeAnsweredAsk('quote_issuance_stale_ask');
      if (typeof sendText === 'function') await sendText({ text: 'Tämä tarjous on jo käsitelty.' });
      return { action: 'stale', quoteId: state.quote_id || null };
    }

    if (isAffirmative(text)) {
      const authorityBasis = buildQuoteIssuanceAuthorityBasis({ message, phoneHash });
      if (!authorityBasis.providerMessageId || !authorityBasis.phoneHash || !actorId) {
        throw Object.assign(new Error('Quote confirmation requires provider message id, phone hash, and owner actor id.'), { code: 'QUOTE_SEND_AUTHORITY_REQUIRED' });
      }
      let sent;
      try {
        sent = await sendQuoteImpl({
          firmId,
          clientId,
          row,
          authorityBasis,
          actorId,
          transmitPdfImpl,
          sendEmail,
          markSentImpl: markQuoteSentImpl
        });
      } catch (error) {
        // A failed send leaves the row pending and the ask OPEN (still on the
        // owner) — the next "kyllä" retries.
        if (typeof sendText === 'function') await sendText({ text: QUOTE_SEND_FAILED_TEXT });
        return { action: 'quote_send_failed', error: error?.code || error?.message || 'unknown', ask };
      }
      await closeAnsweredAsk('quote_sent');
      const quoteNumber = row.draft?.quote?.quoteNumber || '';
      const validUntil = row.draft?.quote?.validUntil || null;
      const parts = [`Tarjous ${quoteNumber} lähetetty osoitteeseen ${row.draft?.transmit?.to}.`];
      if (validUntil) parts.push(`Voimassa ${validUntil} asti.`);
      parts.push(`Kun asiakas hyväksyy, sano vaikka "tee lasku tarjouksesta ${quoteNumber}".`);
      if (typeof sendText === 'function') await sendText({ text: parts.join(' ') });
      return { action: 'confirm_and_send_quote', authorityBasis, actorId, ...sent };
    }

    if (isNegative(text)) {
      const authorityBasis = buildQuoteIssuanceAuthorityBasis({ message, phoneHash });
      const cancelled = await cancelQuoteImpl({ firmId, clientId, quoteId: row.id, reason: 'owner_declined', authorityBasis, actorId });
      await closeAnsweredAsk('quote_cancelled');
      if (typeof sendText === 'function') await sendText({ text: `Tarjous ${row.draft?.quote?.quoteNumber || ''} peruttu.`.replace(/\s+/g, ' ').trim() });
      return { action: 'quote_cancelled', quote: cancelled };
    }

    // Neither yes nor no: a possible correction against the persisted draft.
    const ctx = mergeSellerContext(row.draft?.sellerContext, sellerContext);
    const verdict = await runIntake({ messageText: text, priorDraft: row.draft?.intent || null, ctx });
    if (isQuoteDraftVerdict(verdict)) {
      const updated = await persistQuoteDraft({ verdict, ctx, requestText: text, existingRow: row });
      await closeAnsweredAsk('quote_draft_superseded');
      const result = await requestQuoteConfirmation({ firmId, clientId, parentAsk: ask, actorId, createAsk, sendText, row: updated });
      return { ...result, superseded: true, verdict };
    }
    if (verdict.terminal === 'escalate') {
      const result = await escalate({
        firmId, clientId, parentAsk: ask, actorId, createAsk, sendText,
        escalation: verdict.escalation,
        state: { quote_id: row.id, request: `${clean(row.draft?.request_text || '')}\n${text}`.trim() }
      });
      await closeAnsweredAsk('quote_issuance_clarification_requested');
      return { ...result, verdict };
    }
    if (typeof sendText === 'function') await sendText({ text: NUDGE_QUOTE_CONFIRM });
    return { action: 'nudge', reason: 'ambiguous_quote_confirmation', ask };
  }

  if (phase === 'confirm_request') {
    const row = await loadRow(state.invoice_id);
    if (!row || row.status !== 'draft_pending_confirmation') {
      // The row already reached a terminal (issued/cancelled) — the ask is stale.
      await closeAnsweredAsk('invoice_issuance_stale_ask');
      if (typeof sendText === 'function') await sendText({ text: 'Tämä lasku on jo käsitelty.' });
      return { action: 'stale', invoiceId: state.invoice_id || null };
    }

    if (isAffirmative(text)) {
      const authorityBasis = buildInvoiceIssuanceAuthorityBasis({ message, phoneHash });
      if (!authorityBasis.providerMessageId || !authorityBasis.phoneHash || !actorId) {
        throw Object.assign(new Error('Invoice confirmation requires provider message id, phone hash, and owner actor id.'), { code: 'INVOICE_ISSUE_AUTHORITY_REQUIRED' });
      }
      let issued;
      try {
        issued = await issueImpl({
          firmId,
          clientId,
          row,
          authorityBasis,
          actorId,
          postImpl,
          postCreditNoteImpl,
          transmitImpl,
          transmitPdfImpl,
          sendEmail,
          markIssuedImpl
        });
      } catch (error) {
        // Any failed leg leaves the row pending and the ask OPEN (still on the
        // owner) — the next "kyllä" retries; the post leg is idempotent.
        if (typeof sendText === 'function') await sendText({ text: ISSUE_FAILED_TEXT });
        return { action: 'issue_failed', error: error?.code || error?.message || 'unknown', ask };
      }
      await closeAnsweredAsk('invoice_issued');
      // F-U1: if the owner supplied their OWN Y-tunnus / IBAN in the conversation
      // because the profile lacked it, persist it now (audited) so the next
      // invoice doesn't re-ask. Best-effort — a failed profile write must never
      // fail an already-issued invoice. Only the fields the profile was MISSING
      // are persisted (a first-write, not an overwrite of a firm-set value).
      if (typeof persistSellerIdentityImpl === 'function') {
        const priorContext = row.draft?.sellerContext || {};
        const issuedIntent = row.draft?.intent || {};
        const sellerIdentity = {};
        if (!priorContext.businessId && issuedIntent.seller_business_id) sellerIdentity.businessId = issuedIntent.seller_business_id;
        if (!priorContext.iban && issuedIntent.seller_iban) sellerIdentity.iban = issuedIntent.seller_iban;
        if (Object.keys(sellerIdentity).length) {
          try {
            await persistSellerIdentityImpl({ firmId, clientId, sellerIdentity, actorId });
          } catch (err) {
            console.warn('[invoice-issuance] seller identity persist failed (invoice still issued)', err?.message || err);
          }
        }
      }
      const invoiceNumber = issued.invoice?.draft?.invoice?.invoiceNumber || row.draft?.invoice?.invoiceNumber;
      const isCreditRow = (row.kind || row.draft?.invoice?.kind) === 'credit_note';
      const parts = [`${isCreditRow ? 'Hyvityslasku' : 'Lasku'} ${invoiceNumber} lähetetty osoitteeseen ${row.draft?.transmit?.to}.`];
      if (issued.cashBasisSkip) {
        parts.push(isCreditRow
          ? 'Hyvitys huomioidaan maksuperusteisessa kirjanpidossa maksutapahtumien kautta.'
          : 'Tulo kirjataan, kun maksu saapuu tilille (maksuperusteinen kirjanpito).');
      } else if (issued.tositeNumber != null) {
        parts.push(`${isCreditRow ? 'Myyntisaaminen hyvitetty' : 'Kirjattu myyntisaamisiin'} (tosite #${issued.tositeNumber}).`);
      } else {
        parts.push(isCreditRow ? 'Myyntisaaminen hyvitetty.' : 'Kirjattu myyntisaamisiin.');
      }
      if (typeof sendText === 'function') await sendText({ text: parts.join(' ') });
      return { action: 'confirm_and_issue', authorityBasis, actorId, ...issued };
    }

    if (isNegative(text)) {
      const authorityBasis = buildInvoiceIssuanceAuthorityBasis({ message, phoneHash });
      const cancelled = await cancelImpl({ firmId, clientId, invoiceId: row.id, reason: 'owner_declined', authorityBasis, actorId });
      await closeAnsweredAsk('invoice_cancelled');
      if (typeof sendText === 'function') await sendText({ text: `Lasku ${row.draft?.invoice?.invoiceNumber || ''} peruttu.`.replace('  ', ' ') });
      return { action: 'cancelled', invoice: cancelled };
    }

    // Neither yes nor no: treat as a possible correction against the persisted draft.
    const ctx = mergeSellerContext(row.draft?.sellerContext, sellerContext);
    const verdict = await runIntake({ messageText: text, priorDraft: row.draft?.intent || null, ctx });
    if (isDraftVerdict(verdict)) {
      const updated = await persistDraft({ verdict, ctx, requestText: text, existingRow: row });
      await closeAnsweredAsk('invoice_draft_superseded');
      const result = await requestConfirmation({ firmId, clientId, parentAsk: ask, actorId, createAsk, sendText, row: updated });
      return { ...result, superseded: true, verdict };
    }
    if (verdict.terminal === 'escalate') {
      const result = await escalate({
        firmId, clientId, parentAsk: ask, actorId, createAsk, sendText,
        escalation: verdict.escalation,
        state: { invoice_id: row.id, request: `${clean(row.draft?.request_text || '')}\n${text}`.trim() }
      });
      await closeAnsweredAsk('invoice_issuance_clarification_requested');
      return { ...result, verdict };
    }
    if (typeof sendText === 'function') await sendText({ text: NUDGE_CONFIRM });
    return { action: 'nudge', reason: 'ambiguous_confirmation', ask };
  }

  // Clarification phase: the reply answers the one open question; feed it back.
  // A quote clarification carries state.quote_id (C-1); an invoice one carries
  // state.invoice_id; a fresh escalation carries neither — the verdict decides.
  const existingQuoteRow = await loadQuoteRow(state.quote_id);
  const existingRow = await loadRow(state.invoice_id);
  const ctx = mergeSellerContext((existingQuoteRow || existingRow)?.draft?.sellerContext, sellerContext);
  const combined = `${clean(state.request || '')}\n${text}`.trim();
  const verdict = await runIntake({
    messageText: combined,
    priorDraft: (existingQuoteRow || existingRow)?.draft?.intent || null,
    ctx
  });

  if (isDraftVerdict(verdict)) {
    const row = await persistDraft({ verdict, ctx, requestText: combined, existingRow: existingRow && existingRow.status === 'draft_pending_confirmation' ? existingRow : null });
    await closeAnsweredAsk('invoice_draft_ready');
    const result = await requestConfirmation({ firmId, clientId, parentAsk: ask, actorId, createAsk, sendText, row });
    return { ...result, verdict };
  }
  if (isQuoteDraftVerdict(verdict) && typeof createQuoteDraftImpl === 'function') {
    const row = await persistQuoteDraft({
      verdict,
      ctx,
      requestText: combined,
      existingRow: existingQuoteRow && existingQuoteRow.status === 'draft_pending_confirmation' ? existingQuoteRow : null
    });
    await closeAnsweredAsk('quote_draft_ready');
    const result = await requestQuoteConfirmation({ firmId, clientId, parentAsk: ask, actorId, createAsk, sendText, row });
    return { ...result, verdict };
  }
  if (verdict.terminal === 'escalate') {
    const result = await escalate({
      firmId, clientId, parentAsk: ask, actorId, createAsk, sendText,
      escalation: verdict.escalation,
      state: {
        ...(state.invoice_id ? { invoice_id: state.invoice_id } : {}),
        ...(state.quote_id ? { quote_id: state.quote_id } : {}),
        request: combined
      }
    });
    await closeAnsweredAsk('invoice_issuance_clarification_requested');
    return { ...result, verdict };
  }
  // not_invoice mid-flow: keep the ask open and re-ask — still on the owner.
  if (typeof sendText === 'function') await sendText({ text: ask?.question || 'Kerro vielä laskun tiedot, niin jatkan.' });
  return { action: 'nudge', reason: 'clarification_unresolved', ask };
};
