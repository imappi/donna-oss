import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SELLER_REGISTRATION_REGISTRY, createSellerRegistrationRegistry } from './sellerRegistrationRegistry.js';
import { resolveOwnerInvoiceSellerContext, resolveSellerTaxRegistration } from './ownerInvoiceSellerContext.js';
import { loadOutboundPack } from './outbound/packs.js';
import { buildOutboundInvoiceModel } from './outbound/issuance.js';

const day = '2026-09-05';
const regimes = { gb: 'gb_vat', ae: 'ae_vat', fi: 'fi_alv', sg: 'sg_gst', us: null, au: null };
const registrationKey = { gb: 'vat_registration', ae: 'vat_registration', fi: 'alv_registration', sg: 'gst_registration' };
const tax = (jurisdiction, profile, onDate = day) => resolveSellerTaxRegistration({ jurisdiction, profile, onDate });

test('all six seller countries preserve absence, explicit false and business-effective registration independently of outbound support', () => {
  assert.deepEqual(Object.keys(SELLER_REGISTRATION_REGISTRY).sort(), Object.keys(regimes).sort());
  for (const [jurisdiction, regime] of Object.entries(regimes)) {
    const absent = tax(jurisdiction, {});
    assert.equal(absent.taxRegistered, null, jurisdiction);
    assert.equal(absent.regime, regime);
    assert.equal(absent.reason, regime ? 'no_record' : 'no_regime_for_jurisdiction');
    const key = registrationKey[jurisdiction];
    if (key) {
      assert.equal(tax(jurisdiction, { [key]: { status: 'not_registered' } }).taxRegistered, false);
      const profile = { [key]: { status: 'registered', registered_from: day,
        vat_registration_number: jurisdiction === 'ae' ? '100123456789012' : 'GB123456789',
        gst_registration_number: 'M90312345A' } };
      assert.equal(tax(jurisdiction, profile, '2026-09-04').taxRegistered, false);
      assert.equal(tax(jurisdiction, profile).taxRegistered, true);
      assert.deepEqual(tax(jurisdiction, profile, new Date(2026, 8, 5)), tax(jurisdiction, profile), 'local date stays on effective day');
    }
    const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction, profile: {} }, { onDate: day });
    assert.equal(ctx.packId, jurisdiction === 'au' ? null : jurisdiction);
  }
});

test('seller context refuses conflicting identity, foreign legal form and explicit country clears before tax or pack resolution', () => {
  for (const jurisdiction of Object.keys(regimes)) {
    const other = jurisdiction === 'gb' ? 'ae' : 'gb';
    for (const row of [
      { jurisdiction, profile: { jurisdiction: other } },
      { jurisdiction, entity_type: `${other}-limited`, profile: {} },
      { jurisdiction, entity_type: `${jurisdiction}-limited`, profile: { entityType: `${jurisdiction}-sole_trader` } },
      { jurisdiction, profile: { entityType: `${jurisdiction}-limited`, entity_type: `${other}-limited` } }
    ]) {
      const ctx = resolveOwnerInvoiceSellerContext(row, { onDate: day });
      assert.equal(ctx.pack, null);
      assert.equal(ctx.seller.taxRegistered, null);
      assert.equal(ctx.taxRegistration.reason, 'jurisdiction_context_conflict');
    }
    for (const cleared of [null, '', 'unknown', 'bad country']) {
      const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction: cleared, profile: { jurisdiction } }, { onDate: day });
      assert.equal(ctx.jurisdiction, null, 'an explicit canonical clear cannot revive profile country');
      assert.equal(ctx.pack, null);
    }
  }
  assert.equal(resolveOwnerInvoiceSellerContext({ jurisdiction: 'GB', profile: { jurisdiction: 'uk' } }, { onDate: day }).packId, 'gb');
  assert.equal(resolveOwnerInvoiceSellerContext({ profile: { jurisdiction: 'gb' } }, { onDate: day }).packId, null, 'profile-only history cannot authorize seller operations');
});

test('invalid dates and malformed registration implementations never manufacture seller tax facts', () => {
  for (const onDate of [null, '', '2026-02-30', 'not a date', new Date(NaN)]) {
    const out = tax('gb', { vat_registration: { status: 'registered', registered_from: '2020-01-01' } }, onDate);
    assert.equal(out.taxRegistered, null);
    assert.equal(out.taxRegistrationId, null);
  }
  assert.throws(() => createSellerRegistrationRegistry({ GB: () => null }), TypeError);
  assert.throws(() => createSellerRegistrationRegistry({ gb: {} }), TypeError);
  for (const resolver of [() => { throw new Error('unavailable'); }, () => ({ taxRegistered: 'yes' }),
    () => ({ taxRegistered: false, taxRegistrationId: 'foreign-id', regime: 'test', reason: 'no', confirmedAgainstPrimary: false })]) {
    const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction: 'gb', profile: {} }, {
      onDate: day, registrationRegistry: createSellerRegistrationRegistry({ gb: resolver })
    });
    assert.equal(ctx.seller.taxRegistered, null);
    assert.equal(ctx.pack, null, 'a broken implementation refuses the whole operation');
    assert.match(ctx.taxRegistration.reason, /^seller_registration_(invalid|unavailable)$/);
  }
});

test('a new registration adapter plus declared pack builds through the existing seller and invoice entry points', () => {
  const packsRoot = mkdtempSync(path.join(tmpdir(), 'donna-seller-registration-'));
  try {
    const dir = path.join(packsRoot, 'nz');
    mkdirSync(dir);
    const manifest = structuredClone(loadOutboundPack('gb'));
    manifest.pack.id = 'nz';
    manifest.pack.country = 'NZ';
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify({ outbound: { manifest: 'manifest.json' } }));
    const calls = [];
    const registrationRegistry = createSellerRegistrationRegistry({
      ...SELLER_REGISTRATION_REGISTRY,
      nz: ({ profile, onDate }) => {
        calls.push({ profile, onDate });
        return { taxRegistered: false, taxRegistrationId: null, regime: 'fixture_only',
          reason: profile.fixture_registration === 'no' ? 'not_registered' : 'fixture_error', confirmedAgainstPrimary: false };
      }
    });
    const profile = { jurisdiction: 'nz', address: '1 Example Street', fixture_registration: 'no' };
    const ctx = resolveOwnerInvoiceSellerContext({ jurisdiction: 'NZ', company_name: 'Fixture seller', profile }, {
      onDate: new Date(2026, 8, 5), packsRoot, registrationRegistry
    });
    assert.equal(ctx.packId, 'nz');
    assert.equal(ctx.taxRegistration.regime, 'fixture_only');
    assert.deepEqual(calls, [{ profile, onDate: day }]);
    const built = buildOutboundInvoiceModel({
      pack: ctx.pack, seller: ctx.seller, buyer: { name: 'Fixture buyer', address: '2 Example Street' },
      invoiceNumber: 'INV-1', date: day, supplyDate: day, dueDate: '2026-09-19', paymentInstructionsResolved: true,
      lines: [{ description: 'Work', quantity: 1, unit_price: 100 }], taxTotal: 0
    });
    assert.equal(built.ok, true, JSON.stringify(built.errors));
    assert.equal(built.invoice.seller.taxRegistered, false);
    assert.equal(built.invoice.total, 100);
  } finally { rmSync(packsRoot, { recursive: true, force: true }); }
});
