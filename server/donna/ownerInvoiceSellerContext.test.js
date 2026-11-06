import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jurisdictionForClientRow,
  resolveSellerTaxRegistration,
  resolveOwnerInvoiceSellerContext
} from './ownerInvoiceSellerContext.js';
import { buildOutboundInvoiceModel } from './outbound/issuance.js';

const TODAY = '2026-07-27';

const gbClientRow = ({ profile: profileOver = {}, ...over } = {}) => ({
  id: 'client-gb',
  company_name: 'Bramble Studio',
  jurisdiction: 'gb',
  ...over,
  profile: {
    address: '12 Fore St, Exeter',
    businessId: '12345678',
    payment_instructions: 'Sort 04-00-04, account 12345678',
    ...profileOver
  }
});

// ── Jurisdiction resolution ────────────────────────────────────────────────

test('jurisdiction reads either home and normalises the uk alias; never defaults', () => {
  assert.equal(jurisdictionForClientRow({ jurisdiction: 'GB' }), 'gb');
  assert.equal(jurisdictionForClientRow({ profile: { jurisdiction: 'uk' } }), null);
  assert.equal(jurisdictionForClientRow({ jurisdiction: 'fi' }), 'fi');
  assert.equal(jurisdictionForClientRow({}), null);
  assert.equal(jurisdictionForClientRow({ jurisdiction: 'unknown' }), null);
  assert.equal(jurisdictionForClientRow({ jurisdiction: 'britain' }), null);
});

// ── The one per-market fact ────────────────────────────────────────────────

test('GB: no record is UNKNOWN, so the conditional floor refuses rather than guessing', () => {
  const out = resolveSellerTaxRegistration({ jurisdiction: 'gb', profile: {}, onDate: TODAY });
  assert.equal(out.taxRegistered, null);
  assert.equal(out.regime, 'gb_vat');
  assert.equal(out.reason, 'no_record');
});

test('GB: a recorded not_registered is a real FALSE, and carries no VAT number', () => {
  const out = resolveSellerTaxRegistration({
    jurisdiction: 'gb', onDate: TODAY,
    profile: { vat_registration: { status: 'not_registered' } }
  });
  assert.equal(out.taxRegistered, false);
  assert.equal(out.taxRegistrationId, null);
});

test('GB: an effective registration resolves TRUE with its VAT number', () => {
  const out = resolveSellerTaxRegistration({
    jurisdiction: 'gb', onDate: TODAY,
    profile: {
      vat_registration: {
        status: 'registered', registered_from: '2025-04-01',
        vat_registration_number: 'GB123456789', verified_at: '2026-07-01'
      }
    }
  });
  assert.equal(out.taxRegistered, true);
  assert.equal(out.taxRegistrationId, 'GB123456789');
  assert.equal(out.confirmedAgainstPrimary, true);
});

// The FI/UK parallel-build forcing question, answered rather than deferred:
// the SAME three lines serve the other first-class market.
test('FI: the other first-class market resolves through the same dispatch', () => {
  const absent = resolveSellerTaxRegistration({ jurisdiction: 'fi', profile: {}, onDate: TODAY });
  assert.equal(absent.taxRegistered, null, 'absence is unknown here too — the fail-safe stays inside finland/');
  assert.equal(absent.regime, 'fi_alv');

  const registered = resolveSellerTaxRegistration({
    jurisdiction: 'fi', onDate: TODAY,
    profile: { alv_registration: { status: 'registered', registered_from: '2025-01-01' } }
  });
  assert.equal(registered.taxRegistered, true);

  const not = resolveSellerTaxRegistration({
    jurisdiction: 'fi', onDate: TODAY,
    profile: { alv_registration: { status: 'not_registered' } }
  });
  assert.equal(not.taxRegistered, false);
});

test('SG: the third registration regime resolves through the same dispatch', () => {
  const out = resolveSellerTaxRegistration({
    jurisdiction: 'sg', onDate: TODAY,
    profile: {
      gst_registration: {
        status: 'registered', registered_from: '2025-01-01',
        gst_registration_number: 'M90312345A'
      }
    }
  });
  assert.equal(out.taxRegistered, true);
  assert.equal(out.taxRegistrationId, 'M90312345A');
  assert.equal(resolveSellerTaxRegistration({ jurisdiction: 'sg', profile: {}, onDate: TODAY }).taxRegistered, null);
});

test('AE: the fourth registration regime resolves through the same dispatch — tri-state like GB', () => {
  // The AE pack declares a conditional floor, so absence is UNKNOWN, never a
  // quiet not-registered. Same profile key as GB; jurisdiction dispatches.
  const absent = resolveSellerTaxRegistration({ jurisdiction: 'ae', profile: {}, onDate: TODAY });
  assert.equal(absent.taxRegistered, null);
  assert.equal(absent.regime, 'ae_vat');
  assert.equal(absent.reason, 'no_record');

  const registered = resolveSellerTaxRegistration({
    jurisdiction: 'ae', onDate: TODAY,
    profile: {
      vat_registration: {
        status: 'registered', registered_from: '2026-01-01',
        vat_registration_number: '100123456789012', verified_at: '2026-02-01'
      }
    }
  });
  assert.equal(registered.taxRegistered, true);
  assert.equal(registered.taxRegistrationId, '100123456789012');
  assert.equal(registered.confirmedAgainstPrimary, true);

  const not = resolveSellerTaxRegistration({
    jurisdiction: 'ae', onDate: TODAY,
    profile: { vat_registration: { status: 'not_registered' } }
  });
  assert.equal(not.taxRegistered, false);
  assert.equal(not.taxRegistrationId, null);
});

test('a market with no registration regime is UNKNOWN and inert', () => {
  const out = resolveSellerTaxRegistration({ jurisdiction: 'us', profile: {}, onDate: TODAY });
  assert.equal(out.taxRegistered, null);
  assert.equal(out.reason, 'no_regime_for_jurisdiction');
  // Inert because only a pack declaring a CONDITIONAL floor reads the answer —
  // pinned by the US build below.
});

// ── The seller context ─────────────────────────────────────────────────────

test('a GB client resolves its pack, its own identity and its payment block', () => {
  const ctx = resolveOwnerInvoiceSellerContext(gbClientRow(), { onDate: TODAY });
  assert.equal(ctx.packId, 'gb');
  assert.equal(ctx.pack.pack.id, 'gb');
  assert.equal(ctx.jurisdiction, 'gb');
  assert.equal(ctx.seller.name, 'Bramble Studio');
  assert.equal(ctx.seller.address, '12 Fore St, Exeter');
  assert.equal(ctx.seller.businessId, '12345678');
  assert.equal(ctx.paymentInstructions, 'Sort 04-00-04, account 12345678');
  assert.equal(ctx.dueDays, null, 'no authored pack declares a default term — we do not invent one');
});

test('a jurisdiction with no authored pack resolves pack null — the adapter refuses by name', () => {
  const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction: 'de', company_name: 'Muster GmbH' }, { onDate: TODAY });
  assert.equal(ctx.pack, null);
  assert.equal(ctx.packId, null);
  // runOwnerInvoiceCommand turns a null pack into 'no_pack_for_jurisdiction'.
});

test('an unknown-jurisdiction client resolves pack null rather than a default market', () => {
  const ctx = resolveOwnerInvoiceSellerContext({ company_name: 'Nowhere Ltd' }, { onDate: TODAY });
  assert.equal(ctx.pack, null);
  assert.equal(ctx.jurisdiction, null);
});

test('a client with no name resolves seller.name null — the adapter refuses issuer_not_configured', () => {
  const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction: 'gb', profile: {} }, { onDate: TODAY });
  assert.equal(ctx.seller.name, null);
});

test('the context is pure and never throws on junk', () => {
  for (const row of [undefined, {}, { profile: 'garbage' }, { profile: [] }, { jurisdiction: 5 }]) {
    const ctx = resolveOwnerInvoiceSellerContext(row, { onDate: TODAY });
    assert.equal(typeof ctx, 'object');
    assert.equal(ctx.seller.taxRegistered, null);
  }
});

// ── The result that matters for the canary ─────────────────────────────────
//
// End to end on the PURE path: a GB client's own persisted profile → the seller
// context → a built invoice. This is the join gap 9 left open — the contract
// could ask for `seller.taxRegistered` and nothing in the tree could answer it.

test('CANARY: a non-VAT-registered GB client builds an invoice from its persisted profile alone', () => {
  const row = gbClientRow({ profile: { vat_registration: { status: 'not_registered' } } });
  const ctx = resolveOwnerInvoiceSellerContext(row, { onDate: TODAY });
  assert.equal(ctx.seller.taxRegistered, false);

  const built = buildOutboundInvoiceModel({
    pack: ctx.pack,
    seller: ctx.seller,
    buyer: { name: 'Acme Ltd', address: '5 High St, Leeds' },
    invoiceNumber: 'INV-1', date: TODAY, supplyDate: TODAY, dueDate: '2026-08-10',
    paymentInstructionsResolved: true,
    lines: [{ description: 'Design work', quantity: 1, unit_price: 800 }],
    taxTotal: 0
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.invoice.total, 800);
  assert.equal(built.invoice.seller.taxRegistered, false);
  assert.equal(built.invoice.seller.taxRegistrationId, null, 'the forbidden field stays absent');
});

test('CANARY: the SAME client with no vat_registration record REFUSES, by name', () => {
  const ctx = resolveOwnerInvoiceSellerContext(gbClientRow(), { onDate: TODAY });
  assert.equal(ctx.seller.taxRegistered, null);

  const built = buildOutboundInvoiceModel({
    pack: ctx.pack,
    seller: ctx.seller,
    buyer: { name: 'Acme Ltd', address: '5 High St, Leeds' },
    invoiceNumber: 'INV-1', date: TODAY, supplyDate: TODAY, dueDate: '2026-08-10',
    paymentInstructionsResolved: true,
    lines: [{ description: 'Design work', quantity: 1, unit_price: 800 }],
    taxTotal: 0
  });
  assert.equal(built.ok, false, 'an unrecorded status must never be guessed into a limb');
  assert.ok(built.errors.some((e) => e.includes('seller.taxRegistered must be true or false')));
});

test('CANARY: a VAT-registered GB client builds the full VAT-invoice floor from its profile', () => {
  const row = gbClientRow({
    profile: {
      vat_registration: {
        status: 'registered', registered_from: '2025-04-01', vat_registration_number: 'GB123456789'
      }
    }
  });
  const ctx = resolveOwnerInvoiceSellerContext(row, { onDate: TODAY });
  assert.equal(ctx.seller.taxRegistered, true);
  assert.equal(ctx.seller.taxRegistrationId, 'GB123456789');

  const built = buildOutboundInvoiceModel({
    pack: ctx.pack,
    seller: ctx.seller,
    buyer: { name: 'Acme Ltd', address: '5 High St, Leeds' },
    invoiceNumber: 'INV-1', date: TODAY, supplyDate: TODAY, dueDate: '2026-08-10',
    paymentInstructionsResolved: true,
    lines: [{ description: 'Design work', quantity: 1, unit_price: 800, tax_rate: 20, tax_amount: 160 }],
    taxTotal: 160
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.invoice.seller.taxRegistrationId, 'GB123456789');
  // NOTE the invoice BUILDS. Its AR post is still blocked behind gap 8 — the
  // VAT-split post lives in finland/ — which is why the recommended canary shape
  // is the non-registered one above.
});

test('a registration that is not yet effective on the invoice date builds the NON-VAT limb', () => {
  const row = gbClientRow({
    profile: {
      vat_registration: {
        status: 'registered', registered_from: '2026-09-01', vat_registration_number: 'GB123456789'
      }
    }
  });
  const ctx = resolveOwnerInvoiceSellerContext(row, { onDate: TODAY });
  assert.equal(ctx.seller.taxRegistered, false, 'effective-dated, not a standing boolean');
  assert.equal(ctx.seller.taxRegistrationId, null, 'and the number it will later use stays off the invoice');
});

// The AE mirror of the GB canaries: the fourth market's conditional floor,
// registration record, and pack all meeting on the pure path.
const aeClientRow = ({ profile: profileOver = {}, ...over } = {}) => ({
  id: 'client-ae',
  company_name: 'Saffron Trading LLC',
  jurisdiction: 'ae',
  ...over,
  profile: {
    address: 'Office 402, Marina Plaza, Dubai',
    payment_instructions: 'IBAN AE070331234567890123456',
    ...profileOver
  }
});

test('CANARY: a non-VAT-registered AE client builds an invoice from its persisted profile alone', () => {
  const row = aeClientRow({ profile: { vat_registration: { status: 'not_registered' } } });
  const ctx = resolveOwnerInvoiceSellerContext(row, { onDate: TODAY });
  assert.equal(ctx.packId, 'ae');
  assert.equal(ctx.seller.taxRegistered, false);

  const built = buildOutboundInvoiceModel({
    pack: ctx.pack,
    seller: ctx.seller,
    buyer: { name: 'Falcon Ventures FZE', address: 'DMCC, Dubai', taxRegistration: { status: 'not_registered', jurisdiction: 'ae', registrationId: null, effectiveFrom: '2026-01-01', effectiveUntil: null, source: 'owner_statement' } },
    invoiceNumber: 'INV-1', date: TODAY, supplyDate: TODAY, dueDate: '2026-08-10',
    paymentInstructionsResolved: true,
    lines: [{ description: 'Consulting', quantity: 1, unit_price: 5000 }],
    taxTotal: 0
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.invoice.total, 5000);
  assert.equal(built.invoice.seller.taxRegistrationId, null, 'the forbidden field stays absent');
});

test('CANARY: the SAME AE client with no vat_registration record REFUSES, by name', () => {
  const ctx = resolveOwnerInvoiceSellerContext(aeClientRow(), { onDate: TODAY });
  assert.equal(ctx.seller.taxRegistered, null);

  const built = buildOutboundInvoiceModel({
    pack: ctx.pack,
    seller: ctx.seller,
    buyer: { name: 'Falcon Ventures FZE', address: 'DMCC, Dubai', taxRegistration: { status: 'not_registered', jurisdiction: 'ae', registrationId: null, effectiveFrom: '2026-01-01', effectiveUntil: null, source: 'owner_statement' } },
    invoiceNumber: 'INV-1', date: TODAY, supplyDate: TODAY, dueDate: '2026-08-10',
    paymentInstructionsResolved: true,
    lines: [{ description: 'Consulting', quantity: 1, unit_price: 5000 }],
    taxTotal: 0
  });
  assert.equal(built.ok, false, 'an unrecorded status must never be guessed into a limb');
  assert.ok(built.errors.some((e) => e.includes('seller.taxRegistered must be true or false')));
});

test('CANARY: a VAT-registered AE client builds the full tax-invoice floor with its TRN', () => {
  const row = aeClientRow({
    profile: {
      vat_registration: {
        status: 'registered', registered_from: '2026-01-01',
        vat_registration_number: '100123456789012'
      }
    }
  });
  const ctx = resolveOwnerInvoiceSellerContext(row, { onDate: TODAY });
  assert.equal(ctx.seller.taxRegistered, true);
  assert.equal(ctx.seller.taxRegistrationId, '100123456789012');

  const built = buildOutboundInvoiceModel({
    pack: ctx.pack,
    seller: ctx.seller,
    buyer: { name: 'Falcon Ventures FZE', address: 'DMCC, Dubai', taxRegistration: { status: 'not_registered', jurisdiction: 'ae', registrationId: null, effectiveFrom: '2026-01-01', effectiveUntil: null, source: 'owner_statement' } },
    invoiceNumber: 'INV-1', date: TODAY, supplyDate: TODAY, dueDate: '2026-08-10',
    paymentInstructionsResolved: true,
    lines: [{ description: 'Consulting', quantity: 1, unit_price: 5000, tax_rate: 5, tax_amount: 250 }],
    taxTotal: 250
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.invoice.seller.taxRegistrationId, '100123456789012');
});

test('FI and US clients are untouched: neither pack declares a conditional floor', () => {
  for (const jurisdiction of ['fi', 'us']) {
    const ctx = resolveOwnerInvoiceSellerContext(
      { jurisdiction, company_name: 'Seller', profile: { address: 'Street 1' } },
      { onDate: TODAY }
    );
    assert.equal(ctx.packId, jurisdiction);
    assert.equal(ctx.seller.taxRegistered, null);
    const built = buildOutboundInvoiceModel({
      pack: ctx.pack,
      seller: ctx.seller,
      buyer: { name: 'Buyer Oy', email: 'ap@buyer.test' },
      invoiceNumber: 'INV-1', date: TODAY, dueDate: '2026-08-10',
      paymentInstructionsResolved: true,
      referenceNumber: '1234561',
      lines: [{ description: 'Work', quantity: 1, unit_price: 500 }],
      taxTotal: 0
    });
    assert.equal(built.ok, true, `${jurisdiction}: ${JSON.stringify(built.errors)}`);
  }
});
