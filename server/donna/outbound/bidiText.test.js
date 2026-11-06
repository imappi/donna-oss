// bidiText.js — the UAX #9 isolate helpers. Pins:
//   - containsRtl triggers on strong RTL-script characters only (Arabic and
//     Hebrew yes; Latin text, digits, and punctuation no);
//   - each isolate wraps the exact value in the right control pair
//     (LRI/RLI/FSI ... PDI), and applying the same operation twice is
//     byte-identical;
//   - malformed, legacy and double/nested controls fail closed;
//   - mixed structured values keep logical text while isolating their LTR
//     identifiers, and LTR-only render values remain byte-identical;
//   - stripBidiControls removes every bidi formatting character (isolates,
//     marks, and the legacy embeddings it never emits) and round-trips the
//     wrapped value back to its raw text;
//   - a wrapped value survives the fail-closed template renderer — the
//     controls are payload bytes to it, not tokens or emptiness. That is the
//     seam the AR-4A mint-time wiring uses.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LRI, RLI, FSI, PDI,
  containsRtl, isolateLtr, isolateRtl, bidiIsolate, stripBidiControls,
  assertWellFormedBidiIsolation, bidiSafeRenderValues, isolateStructuredText,
  stripBidiControlsFromValues
} from './bidiText.js';
import { loadOutboundPack, renderPackTemplate } from './packs.js';

const ARABIC_NAME = 'شركة الخليج للتجارة ذ.م.م';
const HEBREW = 'חשבונית';

test('containsRtl: strong RTL scripts trigger; Latin, digits, and neutrals do not', () => {
  assert.equal(containsRtl(ARABIC_NAME), true, 'Arabic');
  assert.equal(containsRtl(HEBREW), true, 'Hebrew');
  assert.equal(containsRtl(`Invoice for ${ARABIC_NAME}`), true, 'Arabic embedded in Latin text');
  assert.equal(containsRtl('Acme LLC'), false, 'Latin');
  assert.equal(containsRtl('1,234.56 — × ='), false, 'digits and neutral punctuation');
  assert.equal(containsRtl(''), false, 'empty');
  assert.equal(containsRtl(null), false, 'null-tolerant like the renderer');
});

test('the isolates wrap the exact value in the right control pair', () => {
  assert.equal(isolateLtr('AE07 0331 2345 6789 0123 456'), `${LRI}AE07 0331 2345 6789 0123 456${PDI}`);
  assert.equal(isolateRtl(ARABIC_NAME), `${RLI}${ARABIC_NAME}${PDI}`);
  assert.equal(bidiIsolate(ARABIC_NAME), `${FSI}${ARABIC_NAME}${PDI}`);
  assert.equal(bidiIsolate(2026004), `${FSI}2026004${PDI}`, 'non-strings stringify');
  assert.equal(isolateLtr(null), `${LRI}${PDI}`, 'null stringifies to empty, not "null"');
});

test('isolation is idempotent, while malformed or double-isolated input fails closed', () => {
  const ltr = isolateLtr('INV-2026-014');
  const auto = bidiIsolate(ARABIC_NAME);
  assert.equal(isolateLtr(ltr), ltr, 'LTR wrapping twice is byte-identical');
  assert.equal(bidiIsolate(auto), auto, 'first-strong wrapping twice is byte-identical');
  assert.equal(assertWellFormedBidiIsolation(`${auto} — ${ltr}`), `${auto} — ${ltr}`);

  for (const malformed of [
    `${LRI}${LRI}INV-14${PDI}${PDI}`,
    `${LRI}INV-14`,
    `INV-14${PDI}`,
    `\u200FINV-14`
  ]) {
    assert.throws(
      () => assertWellFormedBidiIsolation(malformed),
      (error) => error.code === 'OUTBOUND_BIDI_ISOLATION_INVALID'
    );
  }
  assert.throws(
    () => isolateLtr(bidiIsolate('INV-14')),
    (error) => error.code === 'OUTBOUND_BIDI_ISOLATION_INVALID',
    'a differently isolated value is refused rather than silently rewrapped'
  );
});

test('structured Arabic text isolates TRN, IBAN, reference, email and URL as LTR islands', () => {
  const logical = [
    'الرقم الضريبي: 100234567890003',
    'IBAN AE07 0331 2345 6789 0123 456',
    'المرجع: INV-2026-014',
    'البريد: billing@example-ae.example',
    'الرابط: https://example-ae.example/invoices/INV-2026-014'
  ].join('\n');
  const isolated = isolateStructuredText(logical);
  for (const value of [
    '100234567890003', 'AE07 0331 2345 6789 0123 456', 'INV-2026-014',
    'billing@example-ae.example', 'https://example-ae.example/invoices/INV-2026-014'
  ]) {
    assert.ok(isolated.includes(`${LRI}${value}${PDI}`), `${value} is one LTR island`);
  }
  assert.equal(stripBidiControls(isolated), logical, 'logical content is unchanged');
  assert.equal(isolateStructuredText(isolated), isolated, 'composed text is idempotent');
});

test('render-value composition activates only for bidi content and PDF stripping is shallow', () => {
  const ltrOnly = {
    owner_business_name: 'Roofline Co', invoice_number: 'INV-14',
    invoice_total: '1,250.00', issue_date: '31 Aug 2026'
  };
  assert.deepEqual(bidiSafeRenderValues(ltrOnly), ltrOnly, 'LTR-only output remains byte-identical');

  const mixed = bidiSafeRenderValues({
    ...ltrOnly,
    counterparty_name: ARABIC_NAME,
    lines_block: `${ARABIC_NAME} — 1 × 1,250.00 = 1,250.00 AED`
  });
  assert.equal(mixed.counterparty_name, `${FSI}${ARABIC_NAME}${PDI}`);
  assert.equal(mixed.invoice_number, `${LRI}INV-14${PDI}`);
  assert.deepEqual(bidiSafeRenderValues(mixed), mixed, 'whole composition is idempotent');
  assert.deepEqual(stripBidiControlsFromValues(mixed), {
    ...ltrOnly,
    counterparty_name: ARABIC_NAME,
    lines_block: `${ARABIC_NAME} — 1 × 1,250.00 = 1,250.00 AED`
  });
});

test('stripBidiControls round-trips a wrapped value and clears legacy controls too', () => {
  assert.equal(stripBidiControls(bidiIsolate(ARABIC_NAME)), ARABIC_NAME);
  assert.equal(stripBidiControls(isolateLtr('100234567890003')), '100234567890003');
  // Legacy embeddings/overrides and marks (never emitted here, but strippable):
  // LRE + RLM + ALM + text + PDF (the pop character, U+202C).
  assert.equal(stripBidiControls('\u202A\u200F\u061Cx\u202C'), 'x');
  assert.equal(stripBidiControls('plain'), 'plain', 'no-op on clean text');
});

test('an isolated value passes the fail-closed template renderer intact', () => {
  const pack = loadOutboundPack('ae', { bypassCache: true });
  const rendered = renderPackTemplate(pack, {
    template: 'invoice_issue',
    language: pack.languages.default,
    values: {
      owner_business_name: 'Gulf Coast Consulting FZ-LLC',
      counterparty_name: bidiIsolate(ARABIC_NAME),
      invoice_number: '2026-014',
      document_title: 'Tax Invoice',
      seller_address: '1 Palm Street, Dubai', buyer_address: '2 Bay Street, Dubai',
      supply_date: '31 Aug 2026',
      seller_tax_registration_block: 'Seller TRN: 100123456789003',
      buyer_tax_registration_block: 'Buyer TRN: 100987654321003',
      invoice_tax_totals_block: 'Total excluding tax: 3,000.00 AED\nVAT total: 150.00 AED',
      invoice_total: '3,150.00',
      currency: pack.currency.home,
      issue_date: '31 Aug 2026',
      due_date: '14 Sep 2026',
      lines_block: `${bidiIsolate('خدمات استشارية')} — 2 × 1,500.00 = 3,000.00 ${pack.currency.home}`,
      payment_instructions: `IBAN ${isolateLtr('AE07 0331 2345 6789 0123 456')}`
    }
  });
  assert.ok(rendered.body.includes(`${FSI}${ARABIC_NAME}${PDI}`), 'the isolated name reaches the body byte-for-byte');
  assert.ok(rendered.body.includes(`${LRI}AE07 0331 2345 6789 0123 456${PDI}`), 'the isolated IBAN too');
  assert.ok(!`${rendered.subject}\n${rendered.body}`.includes('{{'), 'no leaked placeholders');
});
