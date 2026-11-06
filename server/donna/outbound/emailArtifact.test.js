import assert from 'node:assert/strict';
import test from 'node:test';

import { bidiSafeRenderValues, stripBidiControls } from './bidiText.js';
import {
  OUTBOUND_DELIVERY_CONTRACT_VERSION,
  bidiPlainTextToHtml,
  buildAttachmentManifest,
  buildOutboundEmailArtifact,
  fingerprintOutboundDeliveryContract
} from './emailArtifact.js';
import { loadOutboundPack, resolveCorrespondenceLanguage } from './packs.js';

const syntheticArabicPack = () => {
  const pack = structuredClone(loadOutboundPack('ae', { bypassCache: true }));
  pack.pack.version = 99;
  return pack;
};

const htmlLogicalText = (html) => html
  .match(/<div style="white-space: pre-wrap">([\s\S]*)<\/div>/)?.[1]
  .replace(/<\/?bdi(?: dir="(?:ltr|rtl|auto)")?>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('plain text HTML escapes untrusted markup and maps validated bidi isolates to bdi', () => {
  const values = bidiSafeRenderValues({
    counterparty_name: 'شركة <script>alert("x")</script>',
    invoice_number: 'INV-2026-04&1'
  }, { force: true });
  const plain = `إلى: ${values.counterparty_name}\nرقم: ${values.invoice_number}`;
  const html = bidiPlainTextToHtml(plain);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<bdi dir="auto">/);
  assert.match(html, /<bdi dir="ltr">/);
  assert.equal(html.includes('\u2066'), false);
  assert.equal(html.includes('\u2068'), false);
});

test('malformed or double-isolated text refuses before HTML construction', () => {
  assert.throws(
    () => bidiPlainTextToHtml('\u2066\u2066INV\u2069\u2069'),
    (error) => error?.code === 'OUTBOUND_BIDI_ISOLATION_INVALID'
  );
  assert.throws(
    () => bidiPlainTextToHtml('\u202eINV'),
    (error) => error?.code === 'OUTBOUND_BIDI_ISOLATION_INVALID'
  );
});

test('Arabic email artifact keeps plain logical meaning, escaped HTML, attachment bytes and stable fingerprints', () => {
  const pack = syntheticArabicPack();
  const resolution = resolveCorrespondenceLanguage(pack, {
    requestedLanguage: 'ar', requestedSource: 'party_preference'
  });
  const values = bidiSafeRenderValues({
    counterparty_name: 'شركة النور ذ.م.م',
    invoice_number: 'AE-INV-2026-0041'
  }, { force: true });
  const text = `إلى: ${values.counterparty_name}\nفاتورة: ${values.invoice_number}`;
  const attachment = {
    filename: 'AE-INV-2026-0041.pdf',
    contentType: 'application/pdf',
    content: Buffer.from('%PDF synthetic fixture', 'utf8')
  };
  const first = buildOutboundEmailArtifact({
    recipient: 'Billing@Example-ae.EXAMPLE', subject: values.invoice_number, text,
    language: 'ar', languageResolution: resolution, pack,
    templateName: 'invoice_issue', statutoryTitle: 'فاتورة ضريبية',
    attachments: [attachment]
  });
  const second = buildOutboundEmailArtifact({
    recipient: 'Billing@Example-ae.EXAMPLE', subject: values.invoice_number, text,
    language: 'ar', languageResolution: resolution, pack,
    templateName: 'invoice_issue', statutoryTitle: 'فاتورة ضريبية',
    attachments: [attachment]
  });
  assert.match(first.html, /^<!doctype html><html lang="ar" dir="rtl">/);
  assert.ok(first.html.includes('<bdi dir="ltr">AE-INV-2026-0041</bdi>'));
  assert.equal(first.logicalText, stripBidiControls(text));
  assert.equal(htmlLogicalText(first.html), stripBidiControls(text),
    'decoding HTML and removing semantic bdi wrappers recovers the exact logical plain text');
  assert.deepEqual(first.attachmentManifest, [{
    filename: 'AE-INV-2026-0041.pdf', content_type: 'application/pdf',
    byte_length: 22,
    sha256: '31b53c6fcccae43eef32071dab05a0fb52e7a537a3a5cd3ffe2399fff6ba4bbf'
  }]);
  assert.equal(first.contentFingerprint, second.contentFingerprint);
  assert.equal(first.deliveryContractFingerprint, second.deliveryContractFingerprint);
});

test('email artifact refuses mismatched language or locale direction', () => {
  const pack = syntheticArabicPack();
  const resolution = resolveCorrespondenceLanguage(pack, { requestedLanguage: 'ar' });
  assert.throws(() => buildOutboundEmailArtifact({
    recipient: 'billing@example-ae.example', subject: 'x', text: 'x', language: 'en',
    languageResolution: resolution, pack, templateName: 'invoice_issue'
  }), /must equal/);
  assert.throws(() => buildOutboundEmailArtifact({
    recipient: 'billing@example-ae.example', subject: 'x', text: 'x', language: 'ar',
    languageResolution: { ...resolution, direction: 'ltr' }, pack,
    templateName: 'invoice_issue'
  }), /incoherent/);
  assert.throws(() => buildOutboundEmailArtifact({
    recipient: 'billing@example-ae.example', subject: '\u202eunsafe', text: 'x', language: 'ar',
    languageResolution: resolution, pack, templateName: 'invoice_issue'
  }), (error) => error?.code === 'OUTBOUND_BIDI_ISOLATION_INVALID');
});

test('delivery-contract fingerprint is versioned and changes with language, template or pack version', () => {
  const base = {
    recipient: 'billing@example-ae.example', packId: 'ae', packVersion: 4,
    templateName: 'invoice_issue', requestedLanguage: 'ar', actualLanguage: 'en',
    languageSource: 'party_explicit_fallback', fallbackBasis: 'party_fallback_language:en',
    correspondenceLocale: 'en-AE', direction: 'ltr', statutoryTitle: 'Tax Invoice'
  };
  const value = fingerprintOutboundDeliveryContract(base);
  assert.equal(OUTBOUND_DELIVERY_CONTRACT_VERSION, 2);
  assert.match(value, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(value, fingerprintOutboundDeliveryContract({ ...base, packVersion: 5 }));
  assert.notEqual(value, fingerprintOutboundDeliveryContract({ ...base, templateName: 'reminder_step_1' }));
  assert.notEqual(value, fingerprintOutboundDeliveryContract({ ...base, actualLanguage: 'ar', correspondenceLocale: 'ar-AE', direction: 'rtl' }));
});

test('exact-content fingerprint changes with provider envelope bytes and keeps empty manifests explicit', () => {
  const pack = loadOutboundPack('ae');
  const resolution = resolveCorrespondenceLanguage(pack, { requestedLanguage: 'en' });
  const build = (overrides = {}) => buildOutboundEmailArtifact({
    recipient: 'billing@example-ae.example', from: 'Donna <donna@example-ae.example>',
    replyTo: 'owner@example-ae.example', headers: { 'X-Trace': 'one' },
    subject: 'Invoice AE-41', text: 'Plain text', language: 'en',
    languageResolution: resolution, pack, templateName: 'invoice_issue',
    ...overrides
  });
  const baseline = build();
  assert.deepEqual(baseline.attachmentManifest, []);
  assert.notEqual(baseline.contentFingerprint, build({ from: 'Donna <other@example-ae.example>' }).contentFingerprint);
  assert.notEqual(baseline.contentFingerprint, build({ headers: { 'X-Trace': 'two' } }).contentFingerprint);
  assert.notEqual(baseline.contentFingerprint, build({
    attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') }]
  }).contentFingerprint);
});

test('AR-4B3: attachment receipts copy only the exact complete CreditNote identity pair', () => {
  const content = Buffer.from('credit-note-pdf');
  assert.deepEqual(buildAttachmentManifest([{
    filename: 'CN-4.pdf', contentType: 'application/pdf', content,
    artifactKind: 'credit_note_pdf', artifactTemplate: 'credit_note_pdf'
  }]), [{
    filename: 'CN-4.pdf', content_type: 'application/pdf', byte_length: 15,
    sha256: 'c9a44d7d2f1eda61f0612fa00d1b813a08ad9f61b6d14fa249332d67faf583d2',
    artifact_kind: 'credit_note_pdf', artifact_template: 'credit_note_pdf'
  }]);

  for (const identity of [
    { artifactKind: 'credit_note_pdf' },
    { artifactTemplate: 'credit_note_pdf' },
    { artifactKind: 'invoice_pdf', artifactTemplate: 'credit_note_pdf' },
    { artifactKind: 'credit_note_pdf', artifactTemplate: 'invoice_pdf' },
    { artifactKind: null, artifactTemplate: null }
  ]) {
    assert.throws(
      () => buildAttachmentManifest([{
        filename: 'CN-4.pdf', contentType: 'application/pdf', content, ...identity
      }]),
      (error) => error?.code === 'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID'
    );
  }
});

test('AR-4B3: ordinary attachment manifest bytes remain exactly unchanged without identity fields', () => {
  const attachment = {
    filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('pdf')
  };
  assert.equal(
    JSON.stringify(buildAttachmentManifest([attachment])),
    '[{"filename":"invoice.pdf","content_type":"application/pdf","byte_length":3,"sha256":"c35b21d6ca39aa7cc3b79a705d989f1a6e88b99ab43988d74048799e3db926a3"}]'
  );
});
