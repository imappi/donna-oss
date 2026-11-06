import assert from 'node:assert/strict';
import test from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildOutboundInvoiceModel, buildLinesBlock, documentTitleForInvoice } from './issuance.js';
import { buildInvoiceStatutoryValues, buildInvoiceTaxLineSuffix } from './invoiceStatutoryValues.js';
import { loadOutboundPack, renderPackTemplate, formatPackAmount, formatPackDate,
  validateOutboundPackManifest, resolveCorrespondenceLanguage } from './packs.js';
import { renderInvoicePdfArtifact } from './invoicePdfArtifact.js';
import { bidiSafeRenderValues, stripBidiControls, assertWellFormedBidiIsolation, LRI, PDI } from './bidiText.js';
import { buildOutboundEmailArtifact } from './emailArtifact.js';

const pack = loadOutboundPack('ae');
const fact = (registered) => ({
  status: registered ? 'registered' : 'not_registered', jurisdiction: 'ae',
  registrationId: registered ? '100987654321003' : null,
  effectiveFrom: '2026-01-01', source: 'owner_statement'
});
const invoiceFor = ({ registeredSeller = true, registeredBuyer = true } = {}) => {
  const built = buildOutboundInvoiceModel({
    pack,
    seller: { name: 'Desert Studio', address: '10 Palm Street, Dubai',
      taxRegistered: registeredSeller,
      taxRegistrationId: registeredSeller ? '100123456789003' : null },
    buyer: { name: 'Coastal Buyer', address: '20 Bay Street, Abu Dhabi',
      taxRegistration: registeredSeller ? fact(registeredBuyer) : null },
    invoiceNumber: '2026001', date: '2026-09-09', supplyDate: '2026-09-08', dueDate: '2026-09-23',
    lines: [{ description: 'Consulting', quantity: 2, unit_price: 5000,
      ...(registeredSeller ? { tax_rate: 5, tax_amount: 500 } : {}) }],
    taxTotal: registeredSeller ? 500 : 0, paymentInstructionsResolved: true
  });
  assert.equal(built.ok, true, built.errors.join('; '));
  return built.invoice;
};
const valuesFor = (invoice, language) => ({
  ...buildInvoiceStatutoryValues({ pack, invoice, language }),
  owner_business_name: invoice.seller.name, counterparty_name: invoice.buyer.name,
  document_title: documentTitleForInvoice({ pack, invoice, language }),
  invoice_number: invoice.invoiceNumber,
  invoice_total: formatPackAmount(pack, invoice.total, language), currency: invoice.currency,
  issue_date: formatPackDate(pack, invoice.date, language),
  due_date: formatPackDate(pack, invoice.dueDate, language),
  lines_block: buildLinesBlock({ pack, lines: invoice.lines, currency: invoice.currency, language }),
  payment_instructions: 'IBAN AE070331234567890123456'
});

for (const language of ['en', 'ar']) {
  test(`AE ${language}: registered invoice statutory facts survive email and real PDF rendering`, async () => {
    const invoice = invoiceFor();
    const values = bidiSafeRenderValues(valuesFor(invoice, language), { force: language === 'ar' });
    const rendered = renderPackTemplate(pack, { template: 'invoice_issue', language, values });
    const email = buildOutboundEmailArtifact({
      recipient: 'buyer@example-ae.example', subject: rendered.subject, text: rendered.body,
      language, languageResolution: resolveCorrespondenceLanguage(pack, { requestedLanguage: language }),
      pack, templateName: 'invoice_issue'
    });
    const pdf = await renderInvoicePdfArtifact({ pack, language, values });
    const document = await getDocument({ data: new Uint8Array(pdf.content), useSystemFonts: false }).promise;
    let text = '';
    try {
      assert.equal(document.numPages, 1);
      for (let i = 1; i <= document.numPages; i++) {
        const content = await (await document.getPage(i)).getTextContent();
        text += content.items.map((item) => (item.str || '') + (item.hasEOL ? '\n' : '')).join('');
      }
      for (const value of [invoice.seller.taxRegistrationId, invoice.buyer.taxRegistrationId,
        invoice.seller.address, invoice.buyer.address, formatPackAmount(pack, 10500, language),
        formatPackAmount(pack, 500, language), formatPackDate(pack, invoice.supplyDate, language)]) {
        assert.ok(stripBidiControls(email.logicalText).includes(value), `email contains ${value}`);
        assert.ok(stripBidiControls(text).includes(value), `PDF contains ${value}; got ${text}`);
      }
      const title = documentTitleForInvoice({ pack, invoice, language });
      assert.ok(stripBidiControls(rendered.subject).includes(title));
      assert.ok(stripBidiControls(email.logicalText).includes(title));
      assert.ok(stripBidiControls(text).includes(title));
      assert.ok(text.includes(pack.documents.invoice_statutory_labels[language].line_payable));
      assert.ok(!email.logicalText.includes('{{'));
      assert.ok(!text.includes('{{'));
    } finally { await document.destroy(); }
  });

  test(`AE ${language}: nonregistered buyer and ordinary invoice have empty optional tax blocks`, () => {
    const buyerNotRegistered = invoiceFor({ registeredBuyer: false });
    const buyerValues = valuesFor(buyerNotRegistered, language);
    assert.equal(buyerValues.buyer_tax_registration_block, '');
    const registered = renderPackTemplate(pack, { template: 'invoice_issue', language, values: buyerValues });
    assert.ok(!registered.body.includes(pack.documents.invoice_statutory_labels[language].buyer_tax_registration));
    const ordinary = invoiceFor({ registeredSeller: false });
    const values = valuesFor(ordinary, language);
    assert.equal(values.seller_tax_registration_block, '');
    assert.equal(values.buyer_tax_registration_block, '');
    assert.equal(values.invoice_tax_totals_block, '');
    for (const template of ['invoice_pdf', 'invoice_issue']) {
      const rendered = renderPackTemplate(pack, { template, language,
        values: bidiSafeRenderValues(values, { force: language === 'ar' }) });
      assert.ok(!rendered.body.includes(pack.documents.invoice_statutory_labels[language].tax_total));
      assert.ok(!rendered.body.includes('undefined'));
      assert.ok(!rendered.body.includes('null'));
      assert.ok(!rendered.subject.includes(pack.documents.statutory_titles_by_language[language].invoice_when_tax_registered));
    }
  });
}

test('statutory display refuses missing facts instead of rendering fabricated IDs or amounts', () => {
  for (const mutate of [
    (invoice) => { invoice.seller.taxRegistrationId = null; },
    (invoice) => { invoice.buyer.taxRegistrationId = ''; },
    (invoice) => { invoice.buyer.taxRegistered = null; },
    (invoice) => { invoice.taxTotal = null; },
    (invoice) => { invoice.subtotal = undefined; },
    (invoice) => { invoice.buyer.address = ''; }
  ]) {
    const invoice = invoiceFor(); mutate(invoice);
    assert.throws(() => buildInvoiceStatutoryValues({ pack, invoice, language: 'en' }), /requires/);
  }
  const invoice = invoiceFor(); invoice.taxTotal = 0;
  assert.match(buildInvoiceStatutoryValues({ pack, invoice, language: 'en' }).invoice_tax_totals_block, /VAT total: 0\.00 AED/);
});

test('optional blocks are explicit invoice-only values and require complete localized labels', () => {
  const values = valuesFor(invoiceFor(), 'en');
  for (const absent of [null, undefined]) {
    assert.throws(() => renderPackTemplate(pack, { template: 'invoice_issue', language: 'en',
      values: { ...values, buyer_tax_registration_block: absent } }), /unresolved/);
  }
  const badScope = structuredClone(pack);
  badScope.documents.templates.quote_send.en.body += '{{buyer_tax_registration_block}}';
  assert.ok(validateOutboundPackManifest(badScope).errors.some((error) => error.includes('invoice-only')));
  const badLabels = structuredClone(pack);
  delete badLabels.documents.invoice_statutory_labels.ar.tax_total;
  assert.ok(validateOutboundPackManifest(badLabels).errors.some((error) => error.includes('invoice_statutory_labels.ar.tax_total')));
});

test('Arabic multiline addresses and optional blocks keep per-line bidi isolation and empty semantics', () => {
  const invoice = invoiceFor({ registeredBuyer: false });
  invoice.seller.address = 'شارع النخيل\nدبي';
  invoice.buyer.address = 'شارع الساحل\nأبوظبي';
  const values = valuesFor(invoice, 'ar');
  const safe = bidiSafeRenderValues(values, { force: true });
  assert.equal(safe.buyer_tax_registration_block, '');
  assert.deepEqual(bidiSafeRenderValues(safe, { force: true }), safe);
  for (const key of ['seller_address', 'buyer_address', 'invoice_tax_totals_block']) {
    for (const line of safe[key].split('\n')) assert.doesNotThrow(() => assertWellFormedBidiIsolation(line));
    assert.equal(stripBidiControls(safe[key]), stripBidiControls(values[key]));
  }
});

test('Arabic statutory amounts keep thousands separators and currency within one LTR atom', () => {
  const invoice = invoiceFor();
  const values = buildInvoiceStatutoryValues({ pack, invoice, language: 'ar' });
  const suffix = buildInvoiceTaxLineSuffix({ pack, line: invoice.lines[0], currency: 'AED', language: 'ar' });
  assert.ok(values.invoice_tax_totals_block.includes(`${LRI}10,000.00 AED${PDI}`));
  assert.ok(values.invoice_tax_totals_block.includes(`${LRI}500.00 AED${PDI}`));
  assert.ok(suffix.includes(`${LRI}10,500.00 AED${PDI}`));
  assert.deepEqual(bidiSafeRenderValues(values, { force: true }).invoice_tax_totals_block,
    values.invoice_tax_totals_block);
});

test('undeclared FI/GB/US packs acquire no new render values or template bytes', () => {
  for (const id of ['fi', 'gb', 'us']) {
    const legacy = loadOutboundPack(id);
    const before = JSON.stringify(legacy.documents.templates);
    assert.deepEqual(buildInvoiceStatutoryValues({ pack: legacy, invoice: {}, language: 'en' }), {});
    assert.equal(JSON.stringify(legacy.documents.templates), before);
    assert.ok(!before.includes('tax_registration_block'));
  }
});
