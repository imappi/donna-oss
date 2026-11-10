// M2 — issuance generalized OUT of finland/ into the pack-consuming pipeline
// (docs/design-donna-outbound-actions-execution-plan.md §1 M2). The
// confirm/issue/transmit motion FI runs inside finland/invoiceIssuance.js
// becomes outbound actions on THE pipeline: a draft persists (the same
// issued_invoices / issued_quotes tables + counters — INV-1: existing named
// writers, never a second accounting backend), an `issue_invoice` /
// `send_quote` action mints through THE gate, the owner's approval carries
// the send (hold_for_approval IS the confirm step — the digest's one-tap
// links replace the FI "kyllä"), and the executor transmits + flips the
// lifecycle + receipts in one finalize transaction.
//
// The FI modules keep serving FI unchanged — finland/ is not imported here
// and not edited by M2; the shared substrate is the TABLES and the firmDb
// __*WithClient writers (country-neutral, caller's-handle, no begin/commit),
// which this module routes through via lazy injection.
//
// US invoice = the simpler subset, said by PACK DATA (packs/us: no reference
// scheme, no e-invoice lane, no VAT breakdown mandate in
// documents.mandatory_fields). The invoice email renders from the pack's
// invoice_issue template; the payment block is the standing
// profile.payment_instructions value until a D4 pay-link exists, at which
// point the executor swaps in the pack's localized payment_link block.
//
// Quote follow-ups are scheduled actions: pack quote_follow_up_cadence entry
// N rides the SAME send_quote action type at cadence step N+1 (step 1 = the
// send). Recurring invoicing is a cadence on an action (the M0 mechanic):
// payload.recurrence mints next period's draft + action after each executed
// issue.
//
// Honesty notes, named on purpose:
//   - The AR ledger leg (postIssuanceArLeg → firmDb's
//     postOutboundArJournalWithClient) landed with the AR-post slice, closing
//     M2's 'not_wired_outbound_m2' line: an issued invoice posts DR AR / CR
//     revenue from the client's ROLE-RESOLVED chart, savepoint-guarded so a
//     books refusal (cash basis, declared tax, missing/ambiguous role
//     accounts, locked period) is a NAMED receipted skip — never a blocked
//     send, never a guessed posting. The issued row + paid-truth guard remain
//     the AR truth the dunning loop reads; the journal is bookkeeping.
//   - No PDF artifact for the US lane yet: the pack-templated email IS the
//     invoice document v1 (every pack-mandatory field renders in the body);
//     a pack-driven PDF renderer is a named follow-up.
//
// Keep-layer posture: deterministic validation, totals arithmetic
// (subtotal + tax == total), closed lifecycles, refusals. No LLM here — the
// strong model drafts upstream (chat/workspace surfaces); this is the
// machinery that refuses to let a draft mis-foot or a send skip the gate.

import { readClientConfigSnapshot } from '../clientConfig.js';
import { isDeepStrictEqual } from 'node:util';
import {
  formatPackAmount, formatPackDate, quoteNumberPrefixForPack,
  quoteFollowUpCadenceForPack, statutoryTitlesForPack, languageForEntity,
  loadOutboundPack, resolvePackIdForJurisdiction
} from './packs.js';
import { classifyOutboundAction, outboundGateMode } from './actionGate.js';
import { resolvePartyCandidate, listPartyChannels, getPartyById, findPartyByBusinessId,
  findPartyByNormalizedName, normalizePartyName, setPartyAttribute, getPartyTaxRegistration } from './partyStore.js';
import { hasBuyerRegistrationFloor, resolveBuyerRegistration, buyerRegistrationQuestion } from './buyerRegistration.js';
import { normalizeProfileJurisdiction } from '../profileValidation.js';
import { resolveOwnerInvoiceSellerContext } from '../ownerInvoiceSellerContext.js';
import { buildInvoiceStatutoryValues, buildInvoiceTaxLineSuffix } from './invoiceStatutoryValues.js';
import { isOutboundSuppressed, mintOutboundAction, insertOutboundReceipt } from './actionStore.js';
import { payLinksGateMode } from './payLinks.js';
import { mintPackReferenceNumber } from './referenceSchemes.js';
import {
  assertWellFormedBidiIsolation, bidiIsolate, containsRtl,
  hasBidiControls, isolateLtr
} from './bidiText.js';
import { toLocalIsoDay, toUtcIsoDay } from '../dates.js';

const DAY_MS = 86400000;

const clean = (v) => String(v ?? '').trim();
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// A conflicting legacy profile can make seller resolution unavailable. The
// canonical stored country still determines whether this guard must run;
// unresolved identity must not become an escape from a declared floor.
const buyerFloorApplies = (pack, context, row) => {
  if (hasBuyerRegistrationFloor(pack) || hasBuyerRegistrationFloor(context.pack)) return true;
  const canonicalPackId = resolvePackIdForJurisdiction(normalizeProfileJurisdiction(row?.jurisdiction));
  return canonicalPackId ? hasBuyerRegistrationFloor(loadOutboundPack(canonicalPackId)) : false;
};

// SG-1A: the declared seller floor cannot yet be rendered without inventing
// a buyer-registration requirement. This is a bounded capability refusal,
// not a tax decision. Retained typed facts cannot be laundered by a later
// deregistration, and zero-rated lines are still tax-invoice facts.
const isSingaporeInvoice = (pack, sellerRow) => pack?.pack?.id === 'sg'
  || normalizeProfileJurisdiction(pack?.pack?.country) === 'sg'
  || normalizeProfileJurisdiction(sellerRow?.jurisdiction) === 'sg'
  // Historical profile identity scopes refusal only; it never authorizes a country.
  || normalizeProfileJurisdiction(sellerRow?.profile?.jurisdiction) === 'sg';

const singaporeInvoiceRefusal = ({ pack, currentSeller, sellerRow, seller = {}, lines = [], taxTotal = 0 }) => {
  const singaporePack = pack?.pack?.id === 'sg' || normalizeProfileJurisdiction(pack?.pack?.country) === 'sg';
  if (!isSingaporeInvoice(pack, sellerRow)) return null;
  if (currentSeller.seller.taxRegistered !== false || seller.taxRegistered !== false
    || clean(seller.taxRegistrationId) || Number(taxTotal) !== 0
    || lines.some((line) => line.tax_rate != null || line.tax_amount != null
      || line.taxRate != null || line.taxAmount != null)) return 'invoice_tax_rendering_unsupported';
  if (currentSeller.jurisdiction !== 'sg' || !singaporePack) return 'invoice_seller_jurisdiction_changed';
  return null;
};

const invoiceRefusalError = (reason) => Object.assign(new Error(reason === 'invoice_tax_rendering_unsupported'
  ? 'Singapore tax-invoice rendering is not supported. No invoice was created or sent.'
  : 'The current seller jurisdiction does not support this invoice pack.'), {
  code: 'OUTBOUND_INVOICE_INVALID', reason
});

// Lazy firmDb writers (INV-1): the issued_invoices / issued_quotes stores are
// the ONE home of issuance persistence. Injected in tests; dynamic import in
// production so this module stays light to load.
const lazyFirmDbImpls = async () => {
  const firmDb = await import('../firmDb.js');
  return {
    createInvoiceDraft: firmDb.__createIssuedInvoiceDraftWithClient,
    markInvoiceIssued: firmDb.__markIssuedInvoiceIssuedWithClient,
    createQuoteDraft: firmDb.__createIssuedQuoteDraftWithClient,
    markQuoteSent: firmDb.__markIssuedQuoteSentWithClient,
    postArJournal: firmDb.postOutboundArJournalWithClient
  };
};

const resolveImpls = async (impls) => {
  if (impls && typeof impls.createInvoiceDraft === 'function') return impls;
  return { ...(await lazyFirmDbImpls()), ...(impls || {}) };
};

// Display numbers: <year><zero-padded per-client sequence> ("2026001"), the
// issued_invoice_counters series shared with the FI lane (one number chain
// per client, whatever the pack). Quotes take the PACK's prefix on their own
// series ("Q2026001" / "T2026001").
export const formatOutboundInvoiceNumber = ({ sequence, date }) =>
  `${String(date).slice(0, 4)}${String(sequence).padStart(3, '0')}`;

export const formatOutboundQuoteNumber = ({ pack, sequence, date }) =>
  `${quoteNumberPrefixForPack(pack) || ''}${String(date).slice(0, 4)}${String(sequence).padStart(3, '0')}`;

// UTC on purpose (here and in nextMonthlyIssueDate): calendar arithmetic on
// a bare day in Date.UTC space — the host zone must not move the day.
const addDays = (isoDate, days) => {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return toUtcIsoDay(Date.UTC(y, m - 1, d + Number(days || 0)));
};

// Next monthly issue date, day-of-month clamped (Jan 31 → Feb 28).
export const nextMonthlyIssueDate = (isoDate) => {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const daysInNext = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 0)).getUTCDate();
  return toUtcIsoDay(Date.UTC(y, m - 1 + 1, Math.min(d, daysInNext)));
};

// ── The pack-consuming model builder (the Keep layer) ────────────────────────
// Validates lines + totals arithmetic and the PACK's mandatory-field list.
// Tax is a declared amount, never computed here — sales-tax treatment is
// knowledge-layer work, not invoice arithmetic; a wrong declared tax still
// foots, a mis-foot refuses.
export const buildOutboundInvoiceModel = ({
  pack, seller = {}, buyer = {}, lines = [],
  invoiceNumber, date, dueDate = null, taxTotal = 0,
  currency = null,
  paymentInstructionsResolved = false,
  // The pack-scheme payment reference (FI: the viitenumero minted from the
  // invoice number via the referenceSchemes registry). Scheme-less packs
  // (US) pass null and nothing changes — reference_number is not in their
  // mandatory list.
  referenceNumber = null,
  // The date of supply (GB: the VAT tax point; FI: toimituspäivä). Packs whose
  // statutory floor requires it declare `supply_date`; the rest never see it.
  // It deliberately does NOT default to `date` — the time of supply and the
  // issue date are genuinely different facts, and defaulting one to the other
  // would be the Keep layer guessing a statutory value.
  supplyDate = null,
  // The pack's mandatory-field list binds the INVOICE document; the quote
  // builder reuses the arithmetic without it (a quote is not an invoice).
  applyMandatoryFields = true
} = {}) => {
  // gap 9 — the seller's tax-registration status, which selects WHICH statutory
  // floor applies. Read off the seller rather than taken as a separate argument
  // because it is a fact ABOUT the seller, and it must be resolved, never
  // inferred: presence of a tax registration id is NOT proof of registration
  // (it may simply be unrecorded), and defaulting an unknown to "not
  // registered" would silently issue a non-VAT invoice for a registered
  // business — understating output VAT, which is a statutory error rather than
  // a cosmetic one. Tri-state on purpose: true / false / null-for-unknown, and
  // a pack with a conditional floor REFUSES on unknown (below).
  const sellerTaxRegistered = typeof seller?.taxRegistered === 'boolean' ? seller.taxRegistered : null;
  const errors = [];
  if (!pack?.currency?.home) errors.push('pack with a home currency is required');
  if (currency != null && clean(currency).toUpperCase() !== pack?.currency?.home) {
    errors.push('invoice currency is unsupported: only the declared pack home currency can be issued');
  }
  if (!isNonEmptyString(invoiceNumber)) errors.push('invoiceNumber is required');
  if (!isNonEmptyString(date)) errors.push('date is required');
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push('at least one invoice line is required');
  } else {
    lines.forEach((l, i) => {
      if (!isNonEmptyString(l?.description)) errors.push(`line ${i + 1}: description is required`);
      else {
        try {
          assertWellFormedBidiIsolation(l.description);
        } catch {
          errors.push(`line ${i + 1}: description has invalid bidi isolation`);
        }
      }
      const q = Number(l?.quantity ?? 1);
      const u = Number(l?.unit_price);
      if (!Number.isFinite(q) || q <= 0) errors.push(`line ${i + 1}: quantity must be > 0`);
      if (!Number.isFinite(u) || u < 0) errors.push(`line ${i + 1}: unit_price must be >= 0`);
      // Per-line tax (gap 2). Both halves are DECLARED, never computed — same
      // posture as taxTotal: rate × net is not always the tax (rounding rules,
      // margin schemes), and computing it here would be the Keep layer
      // inventing a statutory number.
      if (l?.tax_rate !== undefined && l?.tax_rate !== null) {
        const rate = Number(l.tax_rate);
        if (!Number.isFinite(rate) || rate < 0) errors.push(`line ${i + 1}: tax_rate must be >= 0`);
      }
      if (l?.tax_amount !== undefined && l?.tax_amount !== null) {
        const amount = Number(l.tax_amount);
        if (!Number.isFinite(amount) || amount < 0) errors.push(`line ${i + 1}: tax_amount must be >= 0`);
      }
    });
    // All-or-nothing, per half. A half-declared invoice is ambiguous — is the
    // undeclared line zero-rated, or did the caller forget? — and guessing
    // either way puts a wrong rate on a statutory document.
    const rated = lines.filter((l) => l?.tax_rate !== undefined && l?.tax_rate !== null).length;
    const amounted = lines.filter((l) => l?.tax_amount !== undefined && l?.tax_amount !== null).length;
    if (rated > 0 && rated !== lines.length) {
      errors.push('tax_rate must be declared on every line or none (a partly-rated invoice is ambiguous — declare 0 for a zero-rated line)');
    }
    if (amounted > 0 && amounted !== lines.length) {
      errors.push('tax_amount must be declared on every line or none (declare 0 for a zero-rated line)');
    }
  }
  const tax = round2(Number(taxTotal) || 0);
  if (tax < 0) errors.push('taxTotal cannot be negative');
  if (errors.length) return { ok: false, errors, invoice: null };

  const computedLines = lines.map((l) => {
    const quantity = Number(l.quantity ?? 1);
    const unitPrice = Number(l.unit_price);
    const hasRate = l.tax_rate !== undefined && l.tax_rate !== null;
    const hasAmount = l.tax_amount !== undefined && l.tax_amount !== null;
    return {
      description: l.description.trim(), quantity, unitPrice,
      net: round2(quantity * unitPrice),
      // null (not absent) so a pack/renderer can tell "no per-line tax on this
      // invoice" from "zero-rated", and so the shape is stable across lines.
      taxRate: hasRate ? Number(l.tax_rate) : null,
      taxAmount: hasAmount ? round2(Number(l.tax_amount)) : null
    };
  });
  const subtotal = round2(computedLines.reduce((s, l) => s + l.net, 0));
  const total = round2(subtotal + tax);
  // The totals identity is arithmetic, not intelligence — assert it.
  if (round2(subtotal + tax) !== total) {
    return { ok: false, errors: ['totals invariant failed: subtotal + taxTotal != total'], invoice: null };
  }
  // ...and where per-line tax IS declared, the line tax must foot to the
  // declared total. Same class of check: a wrong declared tax still foots, a
  // mis-foot refuses. This is what makes a mixed-rate invoice safe to issue —
  // without it, per-line rates would be decoration over an unchecked total.
  const linesCarryTax = computedLines.every((l) => l.taxAmount !== null);
  if (linesCarryTax) {
    const lineTaxTotal = round2(computedLines.reduce((s, l) => s + l.taxAmount, 0));
    if (lineTaxTotal !== tax) {
      return {
        ok: false,
        errors: [`totals invariant failed: line tax amounts sum to ${lineTaxTotal}, declared taxTotal is ${tax}`],
        invoice: null
      };
    }
  }
  if (!(total > 0)) return { ok: false, errors: ['invoice total must be positive'], invoice: null };

  const invoice = {
    invoiceNumber: clean(invoiceNumber),
    date, dueDate,
    currency: pack.currency.home,
    supplyDate: supplyDate || null,
    // `businessId` is the company registration (Companies House number,
    // Y-tunnus); `taxRegistrationId` is the separate tax registration a VAT/GST
    // market requires on the face of the invoice. Additive — a pack that does
    // not declare them never notices they exist.
    seller: {
      name: seller.name || null,
      businessId: seller.businessId || null,
      address: seller.address || null,
      taxRegistrationId: seller.taxRegistrationId || null,
      // gap 9 — carried onto the built model so a downstream surface renders
      // the RESOLVED status rather than re-deriving it from the presence of an
      // id (which would answer a different question). Tri-state: null = unknown.
      taxRegistered: sellerTaxRegistered
    },
    buyer: {
      name: buyer.name || null,
      businessId: buyer.businessId || null,
      address: buyer.address || null,
      email: buyer.email || null,
      ...(hasBuyerRegistrationFloor(pack) ? {
        partyId: buyer.partyId || null,
        taxRegistration: buyer.taxRegistration || null,
        ...(() => {
          const fact = resolveBuyerRegistration({ pack, fact: buyer.taxRegistration, onDate: supplyDate || date });
          return { taxRegistered: fact.taxRegistered, taxRegistrationId: fact.taxRegistrationId };
        })()
      } : {})
    },
    lines: computedLines,
    subtotal, taxTotal: tax, total,
    // The scheme-neutral home the reminder lane already coalesces
    // (receivableCases surfaces draft.invoice.referenceNumber whatever the
    // pack) — persisting it here means a Donna-issued FI invoice chases with
    // its viite and no owner gap, zero further edits.
    referenceNumber: clean(referenceNumber) || null
  };

  // The pack's mandatory-field list is the statutory floor (US: the simple
  // subset; a stricter pack refuses more).
  if (!applyMandatoryFields) return { ok: true, errors: [], invoice };
  // Every key in packs.KNOWN_INVOICE_MANDATORY_FIELDS must be resolvable here.
  // The pack-load validator refuses an unknown field, so the two lists are kept
  // together by a test rather than by hope (packs.test.js pins the pairing).
  // A zero `tax_amount` is a legitimate value (a zero-rated supply), and the
  // emptiness check below only rejects null/undefined/'' — so it passes.
  const fieldValues = {
    invoice_number: invoice.invoiceNumber,
    issue_date: invoice.date,
    supply_date: invoice.supplyDate,
    due_date: invoice.dueDate,
    total: invoice.total,
    total_excluding_tax: invoice.subtotal,
    tax_amount: invoice.taxTotal,
    currency: invoice.currency,
    seller_name: invoice.seller.name,
    seller_address: invoice.seller.address,
    seller_business_id: invoice.seller.businessId,
    seller_tax_registration_id: invoice.seller.taxRegistrationId,
    buyer_name: invoice.buyer.name,
    buyer_address: invoice.buyer.address,
    buyer_business_id: invoice.buyer.businessId,
    buyer_tax_registration_id: invoice.buyer.taxRegistrationId,
    // Line descriptions are already validated non-empty above; this key exists
    // so a pack can declare the statutory requirement explicitly rather than
    // relying on an invariant it cannot see.
    line_description: invoice.lines.every((l) => isNonEmptyString(l.description)) ? 'present' : null,
    // gap 13: the quantity and unit price a tax invoice must show against each
    // line (AE Art. 59; GB VAT Notice 700 §16). Same posture as
    // line_description — the builder has always validated both (quantity > 0,
    // unit_price >= 0, net = quantity × unit_price footing into the checked
    // subtotal) and rendered both (buildLinesBlock, the PDF); these keys make
    // the statutory requirement DECLARABLE. The quantity default of 1 is not a
    // hidden guess: it renders on the document and is arithmetically bound
    // into the checked net.
    line_quantity: invoice.lines.every((l) => Number.isFinite(l.quantity) && l.quantity > 0) ? 'present' : null,
    line_unit_price: invoice.lines.every((l) => Number.isFinite(l.unitPrice) && l.unitPrice >= 0) ? 'present' : null,
    // gap 2: a UK VAT invoice covering supplies at more than one rate must show
    // the rate against each line. A pack declaring this refuses an invoice
    // whose lines do not carry rate AND tax — and the line-tax foots-to-total
    // invariant above is what makes the resulting mixed-rate invoice safe.
    line_tax_rate: invoice.lines.every((l) => l.taxRate !== null && l.taxAmount !== null) ? 'present' : null,
    reference_number: invoice.referenceNumber,
    payment_instructions: paymentInstructionsResolved ? 'resolved' : null
  };
  const mandatory = pack?.documents?.mandatory_fields || {};
  const whenRegistered = mandatory.invoice_when_tax_registered || [];
  const forbiddenWhenNot = mandatory.invoice_forbidden_when_not_tax_registered || [];
  const hasConditionalFloor = whenRegistered.length > 0 || forbiddenWhenNot.length > 0;
  if (hasBuyerRegistrationFloor(pack) && sellerTaxRegistered === true) {
    const buyerFact = resolveBuyerRegistration({ pack, fact: buyer.taxRegistration, onDate: supplyDate || date });
    if (buyerFact.reason) errors.push(buyerFact.reason);
  }

  // gap 9 — fail closed on an unresolved status. A pack that declares a
  // conditional floor cannot be applied without knowing which limb applies, and
  // guessing is precisely the silent-wrongness the leg exists to prevent. Packs
  // with no conditional floor (FI, US) never reach this and are unaffected.
  if (hasConditionalFloor && sellerTaxRegistered === null) {
    errors.push(
      `pack '${pack?.pack?.id}' declares a tax-registration-conditional invoice floor, `
      + 'so seller.taxRegistered must be true or false (it cannot be inferred)'
    );
    return { ok: false, errors, invoice: null };
  }

  const required = [
    ...(mandatory.invoice || []),
    ...(sellerTaxRegistered === true ? whenRegistered : []),
    ...(sellerTaxRegistered === true && invoice.buyer.taxRegistered === true
      ? mandatory.invoice_when_buyer_tax_registered || [] : [])
  ];
  for (const field of required) {
    const value = fieldValues[field];
    if (value === null || value === undefined || value === '') {
      errors.push(`pack '${pack?.pack?.id}' requires invoice field '${field}'`);
    }
  }

  // The forbidden half. Only a NON-registered seller is constrained, and the
  // constraint is ABSENCE: a business that is not tax-registered must not
  // present a tax registration id or a per-line tax rate, because showing
  // either misrepresents its status to the counterparty. A zero rate is not a
  // safe substitute for saying nothing.
  if (sellerTaxRegistered === false) {
    for (const field of forbiddenWhenNot) {
      const value = fieldValues[field];
      if (value !== null && value !== undefined && value !== '') {
        errors.push(
          `pack '${pack?.pack?.id}' forbids invoice field '${field}' for a seller that is not tax-registered`
        );
      }
    }
  }

  if (errors.length) return { ok: false, errors, invoice: null };
  return { ok: true, errors: [], invoice };
};

export const buildOutboundQuoteModel = ({
  pack, seller = {}, buyer = {}, lines = [],
  quoteNumber, date, validityDays = 30
} = {}) => {
  const built = buildOutboundInvoiceModel({
    pack, seller, buyer,
    // A quote is an offer, not a tax document: it declares no tax total, so a
    // declared per-line tax AMOUNT would not foot (the invoice invariant) and
    // is dropped. The RATE is kept, because "£800 + VAT at 20%" is exactly what
    // a quote should say — the same reason a quote carries no payment
    // reference but does carry line descriptions.
    lines: (lines || []).map((l) => {
      const { tax_amount: _taxAmount, ...rest } = l || {};
      return rest;
    }),
    invoiceNumber: quoteNumber, date, dueDate: null, taxTotal: 0,
    applyMandatoryFields: false
  });
  if (!built.ok) return { ok: false, errors: built.errors, quote: null };
  const days = Number.isFinite(Number(validityDays)) && Number(validityDays) > 0
    ? Math.round(Number(validityDays)) : 30;
  // A quote carries no payment reference (nothing to pay yet) — the viite is
  // minted for the invoice that follows acceptance, never the offer.
  const { invoiceNumber, dueDate: _dueDate, referenceNumber: _referenceNumber, ...rest } = built.invoice;
  return {
    ok: true,
    errors: [],
    quote: {
      ...rest,
      kind: 'quote',
      quoteNumber: invoiceNumber,
      validityDays: days,
      validUntil: addDays(date, days)
    }
  };
};

// gap 11: the statutory document title for a built invoice, or null when the
// pack declares none. Selected by the seller's registered limb — which the
// build already resolved fail-closed, since any statutory-title declaration
// requires a conditional floor (packs.js validates the pairing) and a
// conditional-floor build refuses an unknown status before any title is
// resolved. The value rides render_values into every invoice template that
// declares {{document_title}}, including the statutory PDF artifact.
export const documentTitleForInvoice = ({ pack, invoice, language = null }) => {
  const titles = statutoryTitlesForPack(pack, language);
  if (!titles) return null;
  if (typeof invoice?.seller?.taxRegistered !== 'boolean') {
    const error = new Error(
      `pack '${pack?.pack?.id}' requires a resolved seller.taxRegistered before selecting a statutory title`
    );
    error.code = 'OUTBOUND_INVOICE_TITLE_REGISTRATION_UNRESOLVED';
    throw error;
  }
  return invoice.seller.taxRegistered ? titles.whenTaxRegistered : titles.otherwise;
};

// Plain-text lines block for the email body ({{lines_block}}). Numbers are
// pack-locale formatted at compose time so the send-time renderer stays a
// dumb token substituter.
export const buildLinesBlock = ({ pack, lines = [], currency, language = null }) =>
  lines.map((l) => {
    const qty = Number(l.quantity ?? 1);
    const unit = formatPackAmount(pack, l.unitPrice ?? l.unit_price, language);
    const net = formatPackAmount(
      pack, l.net ?? round2(qty * Number(l.unitPrice ?? l.unit_price)), language
    );
    const description = String(l.description ?? '');
    // gap 2: where the invoice carries per-line tax, the rate rides the line it
    // belongs to. A mixed-rate invoice whose email body showed only a single
    // total would be exactly the document the statutory floor refuses.
    const rate = l.taxRate ?? l.tax_rate;
    const math = rate === undefined || rate === null
      ? `${qty} × ${unit} = ${net} ${currency}`
      : `${qty} × ${unit} = ${net} ${currency} (${formatPackAmount(pack, rate, language)} %)`;
    const suffix = buildInvoiceTaxLineSuffix({ pack, line: l, currency, language: language || pack.languages.default });
    // AR-4A: only a mixed-direction line changes bytes. The description is
    // first-strong; the COMPLETE math tail is one LTR island so '=' cannot
    // swap its operands. A pre-isolated description makes the operation
    // idempotent, while malformed/double isolation fails closed in the helper.
    if (containsRtl(description + suffix) || hasBidiControls(description + suffix)) {
      return `${bidiIsolate(description)} — ${isolateLtr(math)}${suffix}`;
    }
    return `${description} — ${math}${suffix}`;
  }).join('\n');

// ── Draft creation + mint (the propose half; approval is the confirm) ────────
// Both creators run on the CALLER's client handle inside the caller's
// transaction (M0 store posture). The action mints hold_for_approval at
// canary (every third-party send holds until the earned terminal), so the
// draft rests ON THE OWNER — the digest's approve tap is the confirm.

const resolveBuyerParty = async (client, { firmId, clientId, buyer, sourceRef, source }) => {
  if (buyer.partyId) {
    const party = await getPartyById(client, { firmId, clientId, partyId: buyer.partyId });
    return party?.status === 'active' ? party : null;
  }
  const resolved = await resolvePartyCandidate(client, {
    firmId, clientId,
    candidate: {
      displayName: buyer.name, email: buyer.email || null,
      businessId: buyer.businessId || null,
      isCustomer: true, source, sourceRef
    }
  });
  return resolved.party || null;
};

const mintIssuanceAction = async (client, {
  firmId, clientId, actionType, party, anchorType, anchorId,
  pack, template, payload, amount, currency, snapshot, env,
  scheduledFor, cadenceStep, createdBy
}) => {
  const channels = await listPartyChannels(client, {
    firmId, clientId, partyId: party.id, activeOnly: true
  });
  const emails = channels.filter((c) => c.channel_kind === 'email');
  const recipient = (emails.find((c) => c.is_primary) || emails[0])?.normalized_value || null;
  const suppressed = recipient
    ? await isOutboundSuppressed(client, { firmId, clientId, channelKind: 'email', value: recipient })
    : false;
  const gate = classifyOutboundAction({
    actionType, snapshot, env,
    suppressed, doNotContact: Boolean(party.do_not_contact),
    hasRecipient: Boolean(recipient), paidTruth: null, confidence: null
  });
  const minted = await mintOutboundAction(client, {
    firmId, clientId, actionType, targetPartyId: party.id,
    anchorType, anchorId, packId: pack.pack.id, template,
    language: party.preferred_language || null,
    payload, amount, currency, confidence: null,
    gate, scheduledFor, cadenceStep, createdBy
  });
  return { minted, gate };
};

// Create a US-lane (pack-lane) invoice draft + its issue_invoice action.
// Refuses (throws with a named code) rather than persisting anything that
// cannot reach a valid send: the caller surfaces the refusal to the owner.
export const createOutboundInvoiceDraft = async (client, {
  firmId, clientId, pack, snapshot = null, env = process.env,
  seller = {}, buyer = {}, lines = [],
  dueDays = 14, taxTotal = 0, issueDate = null,
  currency = null, sourceMessageId = null, sourceChannel = null,
  supplyDate = null,
  paymentInstructions = null, recurrence = null,
  actorType = 'owner', actorId = 'owner', now = Date.now(), impls = null
} = {}) => {
  snapshot = snapshot || await readClientConfigSnapshot(client, { firmId, clientId });
  const { mode } = outboundGateMode({ actionType: 'issue_invoice', snapshot, env });
  if (mode !== 'act') {
    // A dark or shadow pipeline persists nothing (shadow leaves one
    // would-draft receipt; the M0 refuse-at-mint posture).
    if (mode === 'shadow') {
      try {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'outbound_invoice.would_draft', 'client', $2, $3::jsonb)`,
          [firmId, clientId, JSON.stringify({ buyer_name: buyer.name || null, line_count: (lines || []).length })]
        );
      } catch { /* best-effort shadow receipt */ }
    }
    return { refused: mode === 'shadow' ? 'shadow_mode' : 'flag_off', draft: null, action: null };
  }

  if (!isEmail(buyer.email)) {
    const error = new Error('An invoice draft needs the buyer\'s email address.');
    error.code = 'OUTBOUND_INVOICE_NO_BUYER_EMAIL';
    throw error;
  }
  // Payment block must be resolvable: a standing instructions value, or the
  // D4 pay-link lane switched on (the link is ensured before/at send).
  const standingInstructions = clean(paymentInstructions);
  const payLinksOn = payLinksGateMode({ snapshot, env }) === 'act';
  if (!standingInstructions && !payLinksOn) {
    const error = new Error('An invoice needs a payment block: set payment instructions or enable pay-links.');
    error.code = 'OUTBOUND_INVOICE_NO_PAYMENT_BLOCK';
    throw error;
  }

  // The issue date defaults to the HOST's calendar day — the day the owner
  // reads on the wall clock, never the UTC day (audit F-11).
  const date = issueDate || toLocalIsoDay(now);
  const dueDate = addDays(date, dueDays || 14);
  const sellerRow = (await client.query(
    'select * from clients where firm_id = $1 and id = $2 for share', [firmId, clientId]
  )).rows[0];
  const currentSeller = resolveOwnerInvoiceSellerContext(sellerRow, { onDate: supplyDate || date });
  const refusal = singaporeInvoiceRefusal({ pack, currentSeller, sellerRow, seller, lines, taxTotal });
  if (refusal) throw invoiceRefusalError(refusal);
  if (buyerFloorApplies(pack, currentSeller, sellerRow)) {
    if (buyer.taxRegistration !== undefined && (!actorId || ['owner', 'system'].includes(actorId))) {
      const error = new Error('Recording buyer tax facts requires the authenticated owner or member identity.');
      error.code = 'OUTBOUND_INVOICE_INVALID'; throw error;
    }
    if (recurrence) {
      const error = new Error('Recurring tax invoices need a separately confirmed supply date and current buyer facts. Please create each invoice separately.');
      error.code = 'OUTBOUND_INVOICE_INVALID'; throw error;
    }
    // Canonical persisted seller facts authorize the document, not caller
    // snapshots. Only packs opting into this contract acquire these reads.
    if (!currentSeller.pack || currentSeller.packId !== pack.pack.id) {
      const error = new Error('The current seller jurisdiction does not support this invoice pack.');
      error.code = 'OUTBOUND_INVOICE_INVALID'; throw error;
    }
    if (pack.currency.home !== currentSeller.pack.currency.home) {
      const error = new Error('Invoice currency is unsupported by the current declared pack.');
      error.code = 'OUTBOUND_INVOICE_CURRENCY_UNSUPPORTED'; throw error;
    }
    pack = currentSeller.pack;
    seller = currentSeller.seller;
    let existing = null;
    if (buyer.partyId) existing = await getPartyById(client, { firmId, clientId, partyId: buyer.partyId });
    else if (buyer.businessId) existing = await findPartyByBusinessId(client, { firmId, clientId, businessId: buyer.businessId });
    else existing = await findPartyByNormalizedName(client, { firmId, clientId, normalizedName: normalizePartyName(buyer.name) });
    if (buyer.partyId && (!existing || existing.status !== 'active')) {
      const error = new Error('The buyer is not an active party of this client.');
      error.code = 'OUTBOUND_INVOICE_PARTY_UNRESOLVABLE'; throw error;
    }
    if (existing) {
      const params = [firmId, clientId, existing.id];
      existing = (await (buyer.taxRegistration === undefined
        ? client.query('select * from client_parties where firm_id = $1 and client_id = $2 and id = $3 for share', params)
        : client.query('select * from client_parties where firm_id = $1 and client_id = $2 and id = $3 for update', params))).rows[0];
    }
    buyer = { ...buyer, ...(existing ? { partyId: existing.id } : {}),
      taxRegistration: buyer.taxRegistration === undefined
        ? await getPartyTaxRegistration(client, { firmId, clientId, party: existing }) : buyer.taxRegistration };
    if (seller.taxRegistered === true) {
      const resolved = resolveBuyerRegistration({ pack, fact: buyer.taxRegistration, onDate: supplyDate || date });
      if (resolved.reason) {
        const error = new Error(buyerRegistrationQuestion(resolved.reason));
        error.code = 'OUTBOUND_INVOICE_BUYER_FACTS_REQUIRED';
        error.missing = [resolved.reason]; error.question = error.message;
        throw error;
      }
    }
  }
  // Dry-run with a placeholder number: an unfooted draft never allocates.
  // The pack-scheme reference is minted from the same number (FI: viite base
  // = invoice number), so the dry run exercises the real mandatory-field
  // check; the allocation below re-mints from the ALLOCATED number.
  const placeholderNumber = formatOutboundInvoiceNumber({ sequence: 1, date });
  const dryRun = buildOutboundInvoiceModel({
    pack, seller, buyer, lines,
    invoiceNumber: placeholderNumber,
    date, dueDate, supplyDate, taxTotal, currency, paymentInstructionsResolved: true,
    referenceNumber: mintPackReferenceNumber({ pack, invoiceNumber: placeholderNumber }).referenceNumber
  });
  if (!dryRun.ok) {
    const error = new Error(`Invoice draft invalid: ${dryRun.errors.join('; ')}`);
    error.code = 'OUTBOUND_INVOICE_INVALID';
    throw error;
  }

  // Party + recipient BEFORE any persistence: a blocked recipient
  // (suppressed / do-not-contact) refuses the whole draft — nothing may rest
  // as a pending draft whose only action is a dead cancel.
  const party = await resolveBuyerParty(client, {
    firmId, clientId, buyer, sourceRef: null, source: 'outbound_invoice_draft'
  });
  if (!party) {
    const error = new Error('Could not resolve the buyer into the party store.');
    error.code = 'OUTBOUND_INVOICE_PARTY_UNRESOLVABLE';
    throw error;
  }
  const suppressedRecipient = await isOutboundSuppressed(client, {
    firmId, clientId, channelKind: 'email', value: clean(buyer.email)
  });
  if (suppressedRecipient || party.do_not_contact) {
    const error = new Error('This recipient has unsubscribed or is marked do-not-contact.');
    error.code = 'OUTBOUND_INVOICE_RECIPIENT_BLOCKED';
    throw error;
  }
  const language = languageForEntity(pack, party.preferred_language);
  if (hasBuyerRegistrationFloor(pack)) buyer = { ...buyer, partyId: party.id,
    name: party.display_name, businessId: party.business_id || null };
  if (hasBuyerRegistrationFloor(pack) && buyer.taxRegistration) {
    const current = party.detail?.tax_registration;
    if (!isDeepStrictEqual(current, buyer.taxRegistration)) {
      await setPartyAttribute(client, { firmId, clientId, partyId: party.id,
        attribute: 'tax_registration', value: { ...buyer.taxRegistration,
          sourceMessageId, sourceChannel }, source: 'owner_statement', actorType, actorId });
      const refreshed = await getPartyById(client, { firmId, clientId, partyId: party.id });
      buyer = { ...buyer, taxRegistration: refreshed.detail.tax_registration };
    }
  }

  const io = await resolveImpls(impls);
  let model = null;
  const row = await io.createInvoiceDraft({
    client, firmId, clientId, actorId,
    buildDraft: ({ sequence }) => {
      const allocatedNumber = formatOutboundInvoiceNumber({ sequence, date });
      const built = buildOutboundInvoiceModel({
        pack, seller, buyer, lines,
        invoiceNumber: allocatedNumber,
        date, dueDate, supplyDate, taxTotal, currency, paymentInstructionsResolved: true,
        referenceNumber: mintPackReferenceNumber({ pack, invoiceNumber: allocatedNumber }).referenceNumber
      });
      if (!built.ok) throw new Error(`Invoice draft invalid at allocation: ${built.errors.join('; ')}`);
      model = built.invoice;
      return {
        draft: {
          invoice: model,
          pack_id: pack.pack.id,
          origin: 'outbound_m2',
          recurrence: recurrence || null,
          transmit: { channel: 'email', to: clean(buyer.email), format: 'pack_email' }
        },
        buyerName: buyer.name || null,
        buyerEmail: clean(buyer.email)
      };
    }
  });

  const { minted, gate } = await mintIssuanceAction(client, {
    firmId, clientId, actionType: 'issue_invoice', party,
    anchorType: 'issued_invoice', anchorId: row.id,
    pack, template: 'invoice_issue',
    payload: {
      issue_date: date, due_date: dueDate,
      recurrence: recurrence || null,
      render_values: {
        ...buildInvoiceStatutoryValues({ pack, invoice: model, language }),
        owner_business_name: seller.name || undefined,
        invoice_number: model.invoiceNumber,
        invoice_total: formatPackAmount(pack, model.total, language),
        issue_date: formatPackDate(pack, date, language),
        due_date: formatPackDate(pack, dueDate, language),
        lines_block: buildLinesBlock({
          pack, lines: model.lines, currency: model.currency, language
        }),
        payment_instructions: standingInstructions || undefined,
        // Pack-scheme reference (FI viite): the issue email states it so the
        // buyer pays with the allocation instruction from day one.
        reference_number: model.referenceNumber || undefined,
        // gap 11: the statutory document title ('Tax Invoice' / 'Invoice' by
        // the seller's registered limb), for packs that declare one. Rides
        // into the invoice email AND the PDF artifact; a recurrence re-mints
        // through this same path, so a mid-recurrence registration change
        // re-titles the next period's document correctly.
        document_title: documentTitleForInvoice({
          pack, invoice: model, language
        }) || undefined
      }
    },
    amount: model.total, currency: model.currency,
    snapshot, env, scheduledFor: new Date(now).toISOString(),
    cadenceStep: 1, createdBy: 'outbound_invoice_draft'
  });
  return { draft: row, action: minted.action, gate, refused: null };
};

export const createOutboundQuoteDraft = async (client, {
  firmId, clientId, pack, snapshot = null, env = process.env,
  seller = {}, buyer = {}, lines = [],
  validityDays = 30, issueDate = null,
  actorId = 'owner', now = Date.now(), impls = null
} = {}) => {
  snapshot = snapshot || await readClientConfigSnapshot(client, { firmId, clientId });
  const { mode } = outboundGateMode({ actionType: 'send_quote', snapshot, env });
  if (mode !== 'act') {
    if (mode === 'shadow') {
      try {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'outbound_quote.would_draft', 'client', $2, $3::jsonb)`,
          [firmId, clientId, JSON.stringify({ buyer_name: buyer.name || null, line_count: (lines || []).length })]
        );
      } catch { /* best-effort shadow receipt */ }
    }
    return { refused: mode === 'shadow' ? 'shadow_mode' : 'flag_off', draft: null, action: null };
  }

  if (!isEmail(buyer.email)) {
    const error = new Error('A quote draft needs the buyer\'s email address.');
    error.code = 'OUTBOUND_QUOTE_NO_BUYER_EMAIL';
    throw error;
  }
  const date = issueDate || toLocalIsoDay(now); // host-local day, as for an invoice
  const dryRun = buildOutboundQuoteModel({
    pack, seller, buyer, lines,
    quoteNumber: formatOutboundQuoteNumber({ pack, sequence: 1, date }),
    date, validityDays
  });
  if (!dryRun.ok) {
    const error = new Error(`Quote draft invalid: ${dryRun.errors.join('; ')}`);
    error.code = 'OUTBOUND_QUOTE_INVALID';
    throw error;
  }

  const party = await resolveBuyerParty(client, {
    firmId, clientId, buyer, sourceRef: null, source: 'outbound_quote_draft'
  });
  if (!party) {
    const error = new Error('Could not resolve the buyer into the party store.');
    error.code = 'OUTBOUND_QUOTE_PARTY_UNRESOLVABLE';
    throw error;
  }
  const suppressedRecipient = await isOutboundSuppressed(client, {
    firmId, clientId, channelKind: 'email', value: clean(buyer.email)
  });
  if (suppressedRecipient || party.do_not_contact) {
    const error = new Error('This recipient has unsubscribed or is marked do-not-contact.');
    error.code = 'OUTBOUND_QUOTE_RECIPIENT_BLOCKED';
    throw error;
  }
  const language = languageForEntity(pack, party.preferred_language);

  const io = await resolveImpls(impls);
  let model = null;
  const row = await io.createQuoteDraft({
    client, firmId, clientId, actorId,
    buildDraft: ({ sequence }) => {
      const built = buildOutboundQuoteModel({
        pack, seller, buyer, lines,
        quoteNumber: formatOutboundQuoteNumber({ pack, sequence, date }),
        date, validityDays
      });
      if (!built.ok) throw new Error(`Quote draft invalid at allocation: ${built.errors.join('; ')}`);
      model = built.quote;
      return {
        draft: {
          quote: model,
          pack_id: pack.pack.id,
          origin: 'outbound_m2',
          transmit: { channel: 'email', to: clean(buyer.email), format: 'pack_email' }
        },
        buyerName: buyer.name || null,
        buyerEmail: clean(buyer.email),
        validUntil: model.validUntil
      };
    }
  });

  const { minted, gate } = await mintIssuanceAction(client, {
    firmId, clientId, actionType: 'send_quote', party,
    anchorType: 'issued_quote', anchorId: row.id,
    pack, template: 'quote_send',
    payload: {
      issue_date: date,
      render_values: {
        owner_business_name: seller.name || undefined,
        quote_number: model.quoteNumber,
        quote_total: formatPackAmount(pack, model.total, language),
        issue_date: formatPackDate(pack, date, language),
        valid_until: formatPackDate(pack, model.validUntil, language),
        lines_block: buildLinesBlock({
          pack, lines: model.lines, currency: model.currency, language
        })
      }
    },
    amount: model.total, currency: model.currency,
    snapshot, env, scheduledFor: new Date(now).toISOString(),
    cadenceStep: 1, createdBy: 'outbound_quote_draft'
  });
  return { draft: row, action: minted.action, gate, refused: null };
};

// ── Executor hooks (called inside the executor's transactions) ───────────────

// Approval/edit and both owner surfaces read the same capability admission as
// mint/send, using persisted identity and draft facts. No model or rendered copy
// may grant authority. The caller's transaction owns locks on mutation paths.
export const readInvoiceIssuanceRefusal = async (client, { firmId, clientId, action }) => {
  if (action.action_type !== 'issue_invoice' || action.payload?.recurrence_refusal) return null;
  const sellerRow = (await client.query(
    'select * from clients where firm_id = $1 and id = $2 for share', [firmId, clientId]
  )).rows[0];
  let pack = null;
  try { pack = loadOutboundPack(action.pack_id); } catch { /* Unknown pack grants no SG authority. */ }
  if (!isSingaporeInvoice(pack, sellerRow)) return null;
  const anchor = (await client.query(
    'select draft from issued_invoices where id = $1 and firm_id = $2 and client_id = $3',
    [action.anchor_id, firmId, clientId]
  )).rows[0];
  const invoice = anchor?.draft?.invoice;
  const currentSeller = resolveOwnerInvoiceSellerContext(sellerRow, { onDate: invoice?.supplyDate || invoice?.date });
  return singaporeInvoiceRefusal({ pack, currentSeller, sellerRow,
    seller: invoice?.seller, lines: invoice?.lines, taxTotal: invoice?.taxTotal });
};

// The claim transaction is the apply boundary. Current seller and buyer facts
// must still authorize exactly the approved document; a refreshed fact never
// rewrites an invoice or inherits its previous approval.
export const checkCurrentInvoiceFacts = async (client, { firmId, clientId, action, pack, anchorRow }) => {
  if (action.action_type !== 'issue_invoice') return { ok: true };
  if (action.payload?.recurrence_refusal) return { ok: false, reason: 'invoice_recurrence_blocked' };
  const invoice = anchorRow?.draft?.invoice;
  const sellerRow = (await client.query(
    'select * from clients where firm_id = $1 and id = $2 for share', [firmId, clientId]
  )).rows[0];
  const sellerContext = resolveOwnerInvoiceSellerContext(sellerRow, { onDate: invoice?.supplyDate || invoice?.date });
  const refusal = singaporeInvoiceRefusal({ pack, currentSeller: sellerContext, sellerRow,
    seller: invoice?.seller, lines: invoice?.lines, taxTotal: invoice?.taxTotal });
  if (refusal) return { ok: false, reason: refusal };
  if (!buyerFloorApplies(pack, sellerContext, sellerRow)) return { ok: true };
  if (action.payload?.recurrence) return { ok: false, reason: 'invoice_recurrence_requires_current_facts' };
  if (!invoice || invoice.currency !== pack?.currency.home || action.currency !== pack?.currency.home) {
    return { ok: false, reason: 'invoice_currency_unsupported' };
  }
  if (sellerContext.packId !== pack.pack.id) return { ok: false, reason: 'invoice_seller_jurisdiction_changed' };
  const party = (await client.query(
    'select * from client_parties where firm_id = $1 and client_id = $2 and id = $3 for share',
    [firmId, clientId, action.target_party_id]
  )).rows[0];
  if (!party || party.status !== 'active') return { ok: false, reason: 'invoice_buyer_unavailable' };
  if (invoice.buyer?.partyId !== party.id || invoice.buyer?.name !== party.display_name
    || (invoice.buyer?.businessId || null) !== (party.business_id || null)) {
    return { ok: false, reason: 'invoice_buyer_identity_changed' };
  }
  const fact = await getPartyTaxRegistration(client, { firmId, clientId, party });
  if (sellerContext.seller.taxRegistered === true) {
    const resolved = resolveBuyerRegistration({ pack, fact, onDate: invoice.supplyDate || invoice.date });
    if (resolved.reason) return { ok: false, reason: resolved.reason };
  }
  if (!isDeepStrictEqual(invoice.seller, sellerContext.seller)
    || !isDeepStrictEqual(invoice.buyer?.taxRegistration || null, fact)) {
    return { ok: false, reason: 'invoice_registration_facts_changed' };
  }
  const rebuilt = buildOutboundInvoiceModel({ pack, seller: sellerContext.seller,
    buyer: { ...invoice.buyer, taxRegistration: fact },
    lines: (invoice.lines || []).map((line) => ({ description: line.description,
      quantity: line.quantity, unit_price: line.unitPrice,
      tax_rate: line.taxRate, tax_amount: line.taxAmount })),
    invoiceNumber: invoice.invoiceNumber, date: invoice.date, dueDate: invoice.dueDate,
    supplyDate: invoice.supplyDate, taxTotal: invoice.taxTotal, currency: invoice.currency,
    referenceNumber: invoice.referenceNumber, paymentInstructionsResolved: true });
  if (!rebuilt.ok || !isDeepStrictEqual(rebuilt.invoice, invoice)) {
    return { ok: false, reason: 'invoice_statutory_floor_invalid' };
  }
  return { ok: true };
};

// Fresh anchor-state interlock at send time (the issuance twin of the
// paid-truth re-check): a drifted anchor CANCELS with a named reason — never
// a stale send, never a silent skip. Returns { ok, row } | { cancel }.
export const checkIssuanceAnchorState = async (client, { firmId, clientId, action, now = Date.now() }) => {
  // A blocked next period has no invoice draft. Keep its owner hold intact
  // even if a stale consumer schedules it; current-facts validation refuses it.
  if (action.action_type === 'issue_invoice' && action.payload?.recurrence_refusal) return { ok: true, row: null };
  if (action.action_type === 'issue_invoice') {
    const row = await client.query(
      `select * from issued_invoices
        where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, action.anchor_id]
    ).then((r) => r.rows[0] || null);
    if (!row) return { cancel: 'anchor_missing' };
    if (row.status !== 'draft_pending_confirmation') return { cancel: `anchor_${row.status}` };
    return { ok: true, row };
  }
  if (action.action_type === 'send_quote') {
    const row = await client.query(
      `select * from issued_quotes
        where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, action.anchor_id]
    ).then((r) => r.rows[0] || null);
    if (!row) return { cancel: 'anchor_missing' };
    const step = Number(action.cadence_step) || 1;
    if (step <= 1) {
      if (row.status !== 'draft_pending_confirmation') return { cancel: `anchor_${row.status}` };
      return { ok: true, row };
    }
    // Follow-ups only chase a quote that is still OUT with the customer.
    if (row.status !== 'sent') return { cancel: `quote_${row.status}` };
    const validUntil = String(row.valid_until || row.draft?.quote?.validUntil || '').slice(0, 10);
    const today = toLocalIsoDay(now); // host-local day, as the quote's own date was
    if (/^\d{4}-\d{2}-\d{2}$/.test(validUntil) && today > validUntil) {
      return { cancel: 'quote_expired' };
    }
    return { ok: true, row };
  }
  return { ok: true, row: null };
};

// The AR ledger leg for an issued invoice, run inside the executor's FINALIZE
// transaction BEFORE the send receipt is written (so the receipt can carry the
// outcome). Savepoint-guarded: a books refusal NEVER blocks the lifecycle flip
// — the send already happened; blocking the finalize would strand an executed
// action on a stale lease (and a possibly-sent send must never re-send). Every
// non-posted outcome is a NAMED skip the caller receipts; the named set:
//   cash_basis_no_ar_post   — income books at settlement (D-FI10-S1)
//   sales_tax_unwired       — a NOT-registered seller declared a tax total (the
//                             D-FI10-S2 mirror). Until 2026-07-27 this also
//                             covered every VAT-registered GB invoice, which
//                             meant a real invoice sent and never booked; the
//                             tax leg now posts and the four skips below carry
//                             what genuinely cannot.
//   tax_registration_unknown / no_sales_tax_account /
//   ambiguous_sales_tax_account / sales_tax_unwired_market — the tax leg's own
//                             named refusals (see SKIP_REASONS_BY_CODE)
//   no_receivable_account / no_revenue_account / ambiguous_* — the client's
//                             chart has zero or many role-resolved accounts
//   outbound_invoicing_dark — the writer's own flag gate refused
//   draft_invoice_missing / ar_writer_unavailable / error:<code> — structural
export const postIssuanceArLeg = async (client, {
  firmId, clientId, action, anchorRow = null, authority, approvedBy, impls = null
}) => {
  if (action.action_type !== 'issue_invoice') return null;
  const io = await resolveImpls(impls);
  if (typeof io.postArJournal !== 'function') {
    return { status: 'skipped', reason: 'ar_writer_unavailable' };
  }
  const invoice = anchorRow?.draft?.invoice || null;
  if (!invoice) return { status: 'skipped', reason: 'draft_invoice_missing' };
  const SKIP_REASONS_BY_CODE = {
    SALES_INVOICE_CASH_BASIS_NO_AR_POST: 'cash_basis_no_ar_post',
    SALES_INVOICE_ALV_UNSUPPORTED: 'sales_tax_unwired',
    OUTBOUND_AR_NO_RECEIVABLE_ACCOUNT: 'no_receivable_account',
    OUTBOUND_AR_AMBIGUOUS_RECEIVABLE_ACCOUNT: 'ambiguous_receivable_account',
    OUTBOUND_AR_NO_REVENUE_ACCOUNT: 'no_revenue_account',
    OUTBOUND_AR_AMBIGUOUS_REVENUE_ACCOUNT: 'ambiguous_revenue_account',
    // The tax leg's own refusals (2026-07-27). Named rather than left to the
    // `error:<code>` fallthrough, because each has a different subject:
    //   tax_registration_unknown — the CLIENT's registration record is missing.
    //     Unlike every other skip here this one has an OWNER-answerable subject,
    //     so it is a candidate for an owner ask rather than a firm-side rest.
    //   no_sales_tax_account / ambiguous_sales_tax_account — the client's chart
    //     has zero or many liability.sales_tax_payable rows (gap 10's role).
    //   sales_tax_unwired_market — the seller IS registered and the invoice
    //     carries tax, but no code map is wired for that jurisdiction. Distinct
    //     from `sales_tax_unwired`, which now means only "the seller is not
    //     registered yet declared a tax", a different bug entirely.
    SALES_INVOICE_TAX_REGISTRATION_UNKNOWN: 'tax_registration_unknown',
    OUTBOUND_AR_NO_SALES_TAX_ACCOUNT: 'no_sales_tax_account',
    OUTBOUND_AR_AMBIGUOUS_SALES_TAX_ACCOUNT: 'ambiguous_sales_tax_account',
    SALES_INVOICE_TAX_POSTING_UNAVAILABLE: 'sales_tax_unwired_market',
    OUTBOUND_INVOICING_DISABLED: 'outbound_invoicing_dark',
    LEDGER_LOCKED_PERIOD_IMMUTABLE: 'locked_period',
    // The invoice is dated inside a filed VAT return and its journal changes
    // what that return reads (db/ledger.js assertJournalDateOutsideFiledReturn).
    LEDGER_JOURNAL_DATE_IN_FILED_RETURN: 'filed_return_period'
  };
  await client.query('savepoint outbound_ar_post');
  try {
    const posted = await io.postArJournal({
      client, firmId, clientId, invoice,
      authorityBasis: {
        source: authority, approved_by: approvedBy,
        action_id: action.id, channel: 'outbound_pipeline'
      },
      model: action.model || null,
      actorId: action.approved_by_actor_id || 'outbound_executor'
    });
    await client.query('release savepoint outbound_ar_post');
    return {
      status: 'posted',
      journal_id: posted.journal_id,
      tosite_number: posted.tosite_number ?? null
    };
  } catch (error) {
    await client.query('rollback to savepoint outbound_ar_post');
    const reason = SKIP_REASONS_BY_CODE[error?.code] || `error:${error?.code || 'unknown'}`;
    return { status: 'skipped', reason };
  }
};

// Lifecycle flip inside the executor's FINALIZE transaction (send happened):
// invoice → issued, quote step 1 → sent; both through the firmDb writers so
// audits + refusals live in one place. The authority basis records the
// pipeline's authority chain — and states plainly what the ledger leg did
// (posted with its journal id, or a NAMED skip; the M2 'not_wired_outbound_m2'
// line is CLOSED by the AR-post slice — quotes state not_applicable).
export const finalizeIssuanceAnchor = async (client, {
  firmId, clientId, action, anchorRow = null, approvedBy, authority,
  recipient, providerMessageId = null, arPost = null, impls = null
}) => {
  const io = await resolveImpls(impls);
  const actorId = action.approved_by_actor_id || 'outbound_executor';
  const authorityBasis = {
    source: authority,
    approved_by: approvedBy,
    action_id: action.id,
    channel: 'outbound_pipeline',
    ledger_posting: action.action_type === 'issue_invoice'
      ? (arPost?.status === 'posted'
          ? `posted:${arPost.journal_id}`
          : `skipped:${arPost?.reason || 'ar_leg_not_run'}`)
      : 'not_applicable_quote'
  };
  const transmitReceipt = {
    channel: 'email', to: recipient,
    message_id: providerMessageId, action_id: action.id
  };
  if (action.action_type === 'issue_invoice') {
    return io.markInvoiceIssued({
      client, firmId, clientId, invoiceId: action.anchor_id,
      arJournalId: arPost?.status === 'posted' ? arPost.journal_id : null,
      cashBasisSkip: arPost?.reason === 'cash_basis_no_ar_post',
      transmitReceipt, authorityBasis, actorId
    });
  }
  if (action.action_type === 'send_quote' && (Number(action.cadence_step) || 1) <= 1) {
    return io.markQuoteSent({
      client, firmId, clientId, quoteId: action.anchor_id,
      // The writer persists valid_until on the sent flip — carry the draft
      // row's own value through, never null it.
      validUntil: anchorRow?.valid_until || anchorRow?.draft?.quote?.validUntil || null,
      transmitReceipt, authorityBasis, actorId
    });
  }
  return null;
};

// After an executed issuance action: mint what follows through the SAME gate.
//   - send_quote: the pack's quote follow-up cadence (entry N → action step
//     N+1), scheduled from the ORIGINAL send date;
//   - issue_invoice with payload.recurrence.interval='monthly': next period's
//     draft + action, scheduled at the next issue date.
// Returns { minted, kind } for the stats.
export const advanceIssuanceAfterSend = async (client, {
  firmId, clientId, action, pack, party, snapshot, env, now = Date.now(),
  recipient = null, impls = null, stats = {}
}) => {
  if (action.action_type === 'send_quote') {
    const cadence = quoteFollowUpCadenceForPack(pack);
    const step = Number(action.cadence_step) || 1;
    const next = cadence.find((c) => c.step === step); // entry N ↔ action step N+1
    if (!next) return { minted: null, kind: null };
    const sentDate = String(action.payload?.sent_date || toLocalIsoDay(now)).slice(0, 10);
    const suppressed = recipient
      ? await isOutboundSuppressed(client, { firmId, clientId, channelKind: 'email', value: recipient })
      : false;
    const gate = classifyOutboundAction({
      actionType: 'send_quote', snapshot, env,
      suppressed, doNotContact: Boolean(party?.do_not_contact),
      hasRecipient: Boolean(recipient), paidTruth: null, confidence: action.confidence
    });
    const minted = await mintOutboundAction(client, {
      firmId, clientId, actionType: 'send_quote',
      targetPartyId: action.target_party_id,
      anchorType: action.anchor_type, anchorId: action.anchor_id,
      packId: action.pack_id, template: next.template, language: action.language,
      payload: { ...action.payload, sent_date: sentDate },
      amount: action.amount, currency: action.currency,
      confidence: action.confidence, gate,
      scheduledFor: new Date(Date.parse(`${sentDate}T00:00:00Z`) + next.daysAfterSent * DAY_MS).toISOString(),
      cadenceStep: step + 1, createdBy: 'quote_follow_up_cadence'
    });
    if (minted.action && !minted.deduped && stats) {
      stats.issuance_follow_ups_minted = (stats.issuance_follow_ups_minted || 0) + 1;
    }
    return { minted: minted.action || null, kind: 'quote_follow_up' };
  }

  if (action.action_type === 'issue_invoice') {
    const recurrence = action.payload?.recurrence;
    if (action.payload?.recurrence_refusal) return { minted: null, kind: 'recurring_invoice_blocked' };
    if (!recurrence || recurrence.interval !== 'monthly') return { minted: null, kind: null };
    const invoiceRow = await client.query(
      `select * from issued_invoices
        where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, action.anchor_id]
    ).then((r) => r.rows[0] || null);
    const previous = invoiceRow?.draft?.invoice;
    if (!previous) return { minted: null, kind: null };
    const prevDate = String(previous.date || action.payload?.issue_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(prevDate)) return { minted: null, kind: null };
    const nextDate = nextMonthlyIssueDate(prevDate);
    // Re-driving finalization cannot reopen an owner-declined continuation,
    // even if the seller's facts subsequently change.
    const existingRefusal = (await client.query(
      `select * from outbound_actions where firm_id = $1 and client_id = $2
         and payload->'recurrence_refusal'->>'predecessor_action_id' = $3
         and payload->'recurrence_refusal'->>'next_issue_date' = $4`,
      [firmId, clientId, action.id, nextDate]
    )).rows[0];
    if (existingRefusal) return { minted: null, blocked: existingRefusal, kind: 'recurring_invoice_blocked' };
    const sellerRow = (await client.query(
      'select * from clients where firm_id = $1 and id = $2 for share', [firmId, clientId]
    )).rows[0];
    const currentSeller = resolveOwnerInvoiceSellerContext(sellerRow, { onDate: nextDate });
    const refusal = singaporeInvoiceRefusal({ pack, currentSeller, sellerRow,
      seller: previous.seller, lines: previous.lines, taxTotal: previous.taxTotal });
    if (refusal) {
      const gate = classifyOutboundAction({ actionType: 'issue_invoice', snapshot, env,
        hasRecipient: true, suppressed: false, doNotContact: false, confidence: null });
      // This is owed work from a completed send, so even a now-dark pipeline
      // must preserve it on its owner. Holding grants no sending authority.
      const blocked = await mintOutboundAction(client, {
        firmId, clientId, actionType: 'issue_invoice', targetPartyId: action.target_party_id,
        anchorType: action.anchor_type, anchorId: action.anchor_id,
        packId: action.pack_id, language: action.language, template: action.template,
        cadenceStep: (Number(action.cadence_step) || 1) + 1,
        payload: { recurrence_refusal: { reason: refusal, next_issue_date: nextDate,
          predecessor_action_id: action.id } },
        gate: { ...gate, verdict: 'hold_for_approval', reasons: [refusal] },
        createdBy: 'outbound_invoice_recurrence_refusal',
        model: action.model, configSnapshotId: action.config_snapshot_id
      });
      if (!blocked.deduped) await insertOutboundReceipt(client, {
        firmId, clientId, actionId: blocked.action.id, actionType: 'issue_invoice',
        targetPartyId: action.target_party_id, channel: 'email', outcome: 'refused', reason: refusal,
        approvedBy: 'system:recurrence_cadence', authority: 'issuance_admission_refusal',
        model: action.model || 'deterministic:gate', configSnapshotId: action.config_snapshot_id,
        checks: [{ check: 'next_invoice_admission', status: 'fail', detail: `${refusal}:${nextDate}` }]
      });
      return { minted: null, blocked: blocked.action, kind: 'recurring_invoice_blocked' };
    }
    const prevDue = String(previous.dueDate || '').slice(0, 10);
    const dueDays = /^\d{4}-\d{2}-\d{2}$/.test(prevDue)
      ? Math.max(1, Math.round((Date.parse(`${prevDue}T00:00:00Z`) - Date.parse(`${prevDate}T00:00:00Z`)) / DAY_MS))
      : 14;
    // Pre-check the payment block so a refusal can never abort the caller's
    // finalize transaction (the period that just SENT must finalize; a
    // blocked next period is audited, resting visibly, not a poisoned txn).
    const standingInstructions = clean(action.payload?.render_values?.payment_instructions);
    const payLinksOn = payLinksGateMode({ snapshot, env }) === 'act';
    if (!standingInstructions && !payLinksOn) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'outbound_invoice.recurrence_blocked', 'outbound_action', $3, $4::jsonb)`,
        [firmId, clientId, action.id, JSON.stringify({
          reason: 'no_payment_block', next_issue_date: nextDate,
          anchor: `${action.anchor_type}:${action.anchor_id}`
        })]
      );
      return { minted: null, kind: 'recurring_invoice_blocked' };
    }
    const { draft, action: nextAction } = await createOutboundInvoiceDraft(client, {
      firmId, clientId, pack, snapshot, env,
      seller: previous.seller || {},
      buyer: previous.buyer || {},
      // Per-line tax carries forward with the line (gap 2): dropping it would
      // silently downgrade a recurring mixed-rate invoice to an unrated one,
      // which its pack's statutory floor then refuses at the NEXT period —
      // long after the recurrence was set up.
      lines: (previous.lines || []).map((l) => ({
        description: l.description, quantity: l.quantity, unit_price: l.unitPrice,
        ...(l.taxRate === undefined || l.taxRate === null ? {} : { tax_rate: l.taxRate }),
        ...(l.taxAmount === undefined || l.taxAmount === null ? {} : { tax_amount: l.taxAmount })
      })),
      dueDays, taxTotal: previous.taxTotal || 0,
      issueDate: nextDate,
      paymentInstructions: action.payload?.render_values?.payment_instructions || null,
      recurrence,
      actorId: 'recurrence_cadence',
      now: Date.parse(`${nextDate}T00:00:00Z`),
      impls
    });
    // The next period's action executes AT the next issue date, not now.
    if (nextAction) {
      await client.query(
        `update outbound_actions set scheduled_for = $4, cadence_step = $5, updated_at = now()
          where id = $1 and firm_id = $2 and client_id = $3`,
        [nextAction.id, firmId, clientId,
          new Date(Date.parse(`${nextDate}T00:00:00Z`)).toISOString(),
          (Number(action.cadence_step) || 1) + 1]
      );
    }
    if (draft && stats) stats.recurrence_minted = (stats.recurrence_minted || 0) + 1;
    return { minted: nextAction || null, kind: 'recurring_invoice' };
  }

  return { minted: null, kind: null };
};
