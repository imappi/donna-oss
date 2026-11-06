// PINT-AE Invoice/CreditNote bounded-parser contract tests.
// Pure and offline: node --test server/donna/ae/pintInvoice.test.js
//
// The CreditNote shape is derived from the standard PINT AE 1.0.4 example
// pinned in docs/design-donna-ae-pint-credit-note.md. Purpose-built minimal
// mutations below exercise only the bounded fields this core consumes. No test
// downloads a schema, Schematron, example or current web page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePintAeBillingDocument,
  parsePintAeInvoice,
  parsePintAeCreditNote,
  PINT_AE_CUSTOMIZATION_ID,
  PINT_AE_PROFILE_ID,
  PINT_AE_INVOICE_NAMESPACE,
  PINT_AE_CREDIT_NOTE_NAMESPACE,
  UBL_CBC_NAMESPACE,
  UBL_CAC_NAMESPACE,
  PINT_AE_SPEC_PROVENANCE,
  PINT_AE_CREDIT_NOTE_REASONS,
  AE_VAT_CATEGORY_CODES,
  PINT_REFUSAL_VOCABULARY_VERSION,
  PINT_REFUSAL_CODES
} from './pintInvoice.js';

const SUPPLIER_TRN = '100000000000003';
const BUYER_TRN = '100000000000101';

const tag = (prefix, localName) => prefix ? `${prefix}:${localName}` : localName;
const declaration = (prefix, namespaceUri) => {
  if (namespaceUri == null) return '';
  return prefix ? `xmlns:${prefix}="${namespaceUri}"` : `xmlns="${namespaceUri}"`;
};

const invoiceLines = () => [
  {
    id: '1', description: 'Office chairs', quantity: '10', unitPrice: '100.00',
    lineNet: '1000.00', category: 'S', rate: '5'
  },
  {
    id: '2', description: 'Export freight', quantity: '1', unitPrice: '200.00',
    lineNet: '200.00', category: 'Z', rate: '0'
  }
];

const invoiceBreakdowns = () => [
  { taxable: '1000.00', tax: '50.00', category: 'S', rate: '5' },
  { taxable: '200.00', tax: '0.00', category: 'Z', rate: '0' }
];

const creditLines = () => [
  {
    id: '1', description: 'Returned equipment', quantity: '5', unitPrice: '100.00',
    lineNet: '500.00', category: 'S', rate: '5'
  }
];

const creditBreakdowns = () => [
  { taxable: '500.00', tax: '25.00', category: 'S', rate: '5' }
];

const billingXml = ({
  kind = 'invoice',
  rootPrefix = '',
  cbcPrefix = 'cbc',
  cacPrefix = 'cac',
  rootNamespace = kind === 'invoice'
    ? PINT_AE_INVOICE_NAMESPACE
    : PINT_AE_CREDIT_NOTE_NAMESPACE,
  cbcNamespace = UBL_CBC_NAMESPACE,
  cacNamespace = UBL_CAC_NAMESPACE,
  customizationId = PINT_AE_CUSTOMIZATION_ID,
  profileId = PINT_AE_PROFILE_ID,
  customizationMarkup = null,
  profileMarkup = null,
  documentNumber = kind === 'invoice' ? 'AE-INV-2026-0042' : 'AE-CN-2026-0007',
  issueDate = '2026-08-12',
  dueDate = '2026-09-11',
  typeCode = kind === 'invoice' ? '380' : '381',
  typeLocalName = kind === 'invoice' ? 'InvoiceTypeCode' : 'CreditNoteTypeCode',
  lineLocalName = kind === 'invoice' ? 'InvoiceLine' : 'CreditNoteLine',
  quantityLocalName = kind === 'invoice' ? 'InvoicedQuantity' : 'CreditedQuantity',
  currency = 'AED',
  taxCurrency = null,
  supplierTrn = SUPPLIER_TRN,
  buyerTrn = BUYER_TRN,
  supplierName = 'Gulf Trading LLC',
  buyerName = 'Desert Bloom Trading FZE',
  lines = kind === 'invoice' ? invoiceLines() : creditLines(),
  breakdowns = kind === 'invoice' ? invoiceBreakdowns() : creditBreakdowns(),
  lineTotal = kind === 'invoice' ? '1200.00' : '500.00',
  subtotal = kind === 'invoice' ? '1200.00' : '500.00',
  vatTotal = kind === 'invoice' ? '50.00' : '25.00',
  total = kind === 'invoice' ? '1250.00' : '525.00',
  payable = kind === 'invoice' ? '1250.00' : '525.00',
  secondaryTaxAmount = null,
  reasonCode = 'DL8.61.1.A',
  reasonMarkup = null,
  references = [],
  referencesMarkup = null,
  rootExtra = ''
} = {}) => {
  const rootLocalName = kind === 'invoice' ? 'Invoice' : 'CreditNote';
  const rootTag = tag(rootPrefix, rootLocalName);
  const cbc = (localName) => tag(cbcPrefix, localName);
  const cac = (localName) => tag(cacPrefix, localName);
  const attrs = [
    declaration(rootPrefix, rootNamespace),
    declaration(cbcPrefix, cbcNamespace),
    declaration(cacPrefix, cacNamespace)
  ].filter(Boolean).join('\n         ');

  const renderedLines = lines.map((line) => `  <${cac(lineLocalName)}>
    <${cbc('ID')}>${line.id}</${cbc('ID')}>
    <${cbc(quantityLocalName)} unitCode="C62">${line.quantity}</${cbc(quantityLocalName)}>
    <${cbc('LineExtensionAmount')} currencyID="${currency}">${line.lineNet}</${cbc('LineExtensionAmount')}>
    <${cac('Item')}>
      <${cbc('Name')}>${line.description}</${cbc('Name')}>
      <${cac('ClassifiedTaxCategory')}>
        <${cbc('ID')}>${line.category}</${cbc('ID')}>
        ${line.rate == null ? '' : `<${cbc('Percent')}>${line.rate}</${cbc('Percent')}>`}
      </${cac('ClassifiedTaxCategory')}>
    </${cac('Item')}>
    <${cac('Price')}><${cbc('PriceAmount')} currencyID="${currency}">${line.unitPrice}</${cbc('PriceAmount')}></${cac('Price')}>
  </${cac(lineLocalName)}>`).join('\n');

  const renderedBreakdowns = breakdowns.map((breakdown) => `    <${cac('TaxSubtotal')}>
      <${cbc('TaxableAmount')} currencyID="${currency}">${breakdown.taxable}</${cbc('TaxableAmount')}>
      <${cbc('TaxAmount')} currencyID="${currency}">${breakdown.tax}</${cbc('TaxAmount')}>
      <${cac('TaxCategory')}>
        <${cbc('ID')}>${breakdown.category}</${cbc('ID')}>
        ${breakdown.rate == null ? '' : `<${cbc('Percent')}>${breakdown.rate}</${cbc('Percent')}>`}
      </${cac('TaxCategory')}>
    </${cac('TaxSubtotal')}>`).join('\n');

  const renderedReason = kind !== 'credit_note'
    ? ''
    : reasonMarkup ?? `  <${cac('DiscrepancyResponse')}><${cbc('ResponseCode')}>${reasonCode}</${cbc('ResponseCode')}></${cac('DiscrepancyResponse')}>`;
  const renderedReferences = kind !== 'credit_note'
    ? ''
    : referencesMarkup ?? references.map((reference) => `  <${cac('BillingReference')}><${cac('InvoiceDocumentReference')}><${cbc('ID')}>${reference}</${cbc('ID')}></${cac('InvoiceDocumentReference')}></${cac('BillingReference')}>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<${rootTag} ${attrs}>
  ${customizationMarkup ?? `<${cbc('CustomizationID')}>${customizationId}</${cbc('CustomizationID')}>`}
  ${profileMarkup ?? `<${cbc('ProfileID')}>${profileId}</${cbc('ProfileID')}>`}
  <${cbc('ID')}>${documentNumber}</${cbc('ID')}>
  <${cbc('IssueDate')}>${issueDate}</${cbc('IssueDate')}>
  <${cbc('DueDate')}>${dueDate}</${cbc('DueDate')}>
  <${cbc(typeLocalName)}>${typeCode}</${cbc(typeLocalName)}>
  <${cbc('DocumentCurrencyCode')}>${currency}</${cbc('DocumentCurrencyCode')}>
  ${taxCurrency == null ? '' : `<${cbc('TaxCurrencyCode')}>${taxCurrency}</${cbc('TaxCurrencyCode')}>`}
${renderedReason}
${renderedReferences}
  <${cac('AccountingSupplierParty')}><${cac('Party')}>
    <${cac('PartyName')}><${cbc('Name')}>Gulf Trading</${cbc('Name')}></${cac('PartyName')}>
    ${supplierTrn == null ? '' : `<${cac('PartyTaxScheme')}><${cbc('CompanyID')}>${supplierTrn}</${cbc('CompanyID')}></${cac('PartyTaxScheme')}>`}
    <${cac('PartyLegalEntity')}><${cbc('RegistrationName')}>${supplierName}</${cbc('RegistrationName')}></${cac('PartyLegalEntity')}>
  </${cac('Party')}></${cac('AccountingSupplierParty')}>
  <${cac('AccountingCustomerParty')}><${cac('Party')}>
    ${buyerTrn == null ? '' : `<${cac('PartyTaxScheme')}><${cbc('CompanyID')}>${buyerTrn}</${cbc('CompanyID')}></${cac('PartyTaxScheme')}>`}
    <${cac('PartyLegalEntity')}><${cbc('RegistrationName')}>${buyerName}</${cbc('RegistrationName')}></${cac('PartyLegalEntity')}>
  </${cac('Party')}></${cac('AccountingCustomerParty')}>
  <${cac('TaxTotal')}>
    <${cbc('TaxAmount')} currencyID="${currency}">${vatTotal}</${cbc('TaxAmount')}>
${renderedBreakdowns}
  </${cac('TaxTotal')}>
  ${secondaryTaxAmount == null ? '' : `<${cac('TaxTotal')}><${cbc('TaxAmount')} currencyID="${taxCurrency || 'AED'}">${secondaryTaxAmount}</${cbc('TaxAmount')}></${cac('TaxTotal')}>`}
  <${cac('LegalMonetaryTotal')}>
    <${cbc('LineExtensionAmount')} currencyID="${currency}">${lineTotal}</${cbc('LineExtensionAmount')}>
    <${cbc('TaxExclusiveAmount')} currencyID="${currency}">${subtotal}</${cbc('TaxExclusiveAmount')}>
    <${cbc('TaxInclusiveAmount')} currencyID="${currency}">${total}</${cbc('TaxInclusiveAmount')}>
    <${cbc('PayableAmount')} currencyID="${currency}">${payable}</${cbc('PayableAmount')}>
  </${cac('LegalMonetaryTotal')}>
${renderedLines}
${rootExtra}
</${rootTag}>`;
};

const sharedRefusal = (xml, code) => {
  const result = parsePintAeBillingDocument({ xml });
  assert.equal(result.ok, false);
  assert.equal(result.document, null);
  assert.equal(result.refusal.vocabularyVersion, PINT_REFUSAL_VOCABULARY_VERSION);
  assert.equal(result.refusal.code, code);
  assert.deepEqual(result.warnings, []);
  return result.refusal;
};

const wrapperRefusal = (parse, field, xml, code) => {
  const result = parse({ xml });
  assert.equal(result.ok, false);
  assert.equal(result[field], null);
  assert.equal(result.refusal.vocabularyVersion, PINT_REFUSAL_VOCABULARY_VERSION);
  assert.equal(result.refusal.code, code);
  assert.deepEqual(result.warnings, []);
  return result.refusal;
};

const replaceOnce = (xml, from, to) => {
  assert.ok(xml.includes(from), `fixture must contain ${from}`);
  return xml.replace(from, to);
};

test('the v2 refusal vocabulary is exact, closed and frozen', () => {
  assert.equal(PINT_REFUSAL_VOCABULARY_VERSION, 'pint-ae-billing-refusal-v2');
  assert.deepEqual(PINT_REFUSAL_CODES, [
    'empty_input',
    'xml_malformed',
    'unsupported_billing_document',
    'invalid_ubl_namespace',
    'not_pint_ae',
    'document_kind_mismatch',
    'duplicate_mandatory',
    'missing_mandatory',
    'invalid_decimal',
    'invalid_document_type_code',
    'invalid_monetary_sign',
    'invalid_supplier_trn',
    'invalid_buyer_trn',
    'invalid_vat_category',
    'invalid_credit_note_reason',
    'amount_mismatch'
  ]);
  assert.ok(Object.isFrozen(PINT_REFUSAL_CODES));
  assert.ok(!PINT_REFUSAL_CODES.includes('not_ubl_invoice'));
});

test('offline PINT AE 1.0.4 replay provenance exactly matches the approved pins', () => {
  assert.deepEqual(PINT_AE_SPEC_PROVENANCE, {
    pintAeVersion: '1.0.4',
    pintVersion: '1.1.3',
    releaseDate: '2026-06-02',
    resourcesPublicationDate: '2026-06-03',
    sourceUrls: {
      releaseNotes: 'https://docs.peppol.eu/poac/ae/pint-ae/specialized-release-notes/',
      bis: 'https://docs.peppol.eu/poac/ae/pint-ae/bis/',
      invoiceTransaction: 'https://docs.peppol.eu/poac/ae/pint-ae/trn-invoice/',
      creditNoteTransaction: 'https://docs.peppol.eu/poac/ae/pint-ae/trn-creditnote/',
      creditNoteSyntax: 'https://docs.peppol.eu/poac/ae/pint-ae/trn-creditnote/syntax/',
      creditReasonCodeList: 'https://docs.peppol.eu/poac/ae/pint-ae/trn-creditnote/codelist/CreditReason/',
      resourcesArchive: 'https://docs.peppol.eu/poac/ae/pint-ae/resources.zip'
    },
    resourcesArchiveSha256: '3ff692b1ab184c582d11c9817be1679f83fe691e99b142c1b69b1f65583f58d8',
    schematronSha256: {
      sharedPreprocessed: 'c073dd645db0401a3276cfa31f381750d35f7fde8381b19b92b8bceee236f534',
      jurisdictionAligned: 'd0e767f246fa8e90749060a51fea5a22e03659ae83ec66aff9cfd3b932168a3e'
    }
  });
  assert.ok(Object.isFrozen(PINT_AE_SPEC_PROVENANCE));
  assert.ok(Object.isFrozen(PINT_AE_SPEC_PROVENANCE.sourceUrls));
  assert.ok(Object.isFrozen(PINT_AE_SPEC_PROVENANCE.schematronSha256));
});

test('Invoice root dispatch preserves the historical wrapper shape and meanings additively', () => {
  const xml = billingXml();
  const shared = parsePintAeBillingDocument({ xml });
  const wrapped = parsePintAeInvoice({ xml });
  assert.equal(shared.ok, true);
  assert.equal(wrapped.ok, true);
  assert.deepEqual(shared.warnings, []);
  assert.deepEqual(wrapped.warnings, []);
  assert.equal('document' in wrapped, false);

  const document = shared.document;
  const invoice = wrapped.invoice;
  assert.equal(document.documentKind, 'invoice');
  assert.equal(document.validationAssurance, 'bounded_application');
  assert.equal(document.documentNumber, 'AE-INV-2026-0042');
  assert.equal(document.creditNoteReason, null);
  assert.deepEqual(document.precedingInvoiceReferences, []);
  assert.equal(invoice.invoiceNumber, document.documentNumber);
  assert.equal(invoice.documentKind, 'invoice');
  assert.equal(invoice.validationAssurance, 'bounded_application');
  assert.equal('documentNumber' in invoice, false);
  assert.equal('creditNoteReason' in invoice, false);
  assert.equal('precedingInvoiceReferences' in invoice, false);
  assert.deepEqual(invoice.lines, [
    {
      linePosition: 1, lineId: '1', description: 'Office chairs', quantity: 10,
      unitPrice: 100, lineNet: 1000, vatCategory: 'S', vatRatePercent: 5
    },
    {
      linePosition: 2, lineId: '2', description: 'Export freight', quantity: 1,
      unitPrice: 200, lineNet: 200, vatCategory: 'Z', vatRatePercent: 0
    }
  ]);
  assert.deepEqual(invoice.totals, {
    lineTotal: 1200,
    subtotal: 1200,
    vatTotal: 50,
    vatTotalInTaxCurrency: null,
    total: 1250,
    payable: 1250
  });
  assert.deepEqual(invoice.vatBreakdown, [
    { category: 'S', ratePercent: 5, taxableAmount: 1000, taxAmount: 50 },
    { category: 'Z', ratePercent: 0, taxableAmount: 200, taxAmount: 0 }
  ]);
  assert.deepEqual(invoice.sourceEconomics.totals, invoice.totals);
});

test('CreditNote dispatch and wrapper expose root-neutral identity and canonical negative economics', () => {
  const xml = billingXml({ kind: 'credit_note', references: ['AE-INV-2026-0004'] });
  const shared = parsePintAeBillingDocument({ xml });
  const wrapped = parsePintAeCreditNote({ xml });
  assert.equal(shared.ok, true);
  assert.equal(wrapped.ok, true);
  assert.equal('document' in wrapped, false);
  assert.deepEqual(wrapped.creditNote, shared.document);

  const creditNote = wrapped.creditNote;
  assert.equal(creditNote.documentKind, 'credit_note');
  assert.equal(creditNote.validationAssurance, 'bounded_application');
  assert.equal(creditNote.documentNumber, 'AE-CN-2026-0007');
  assert.equal('invoiceNumber' in creditNote, false);
  assert.deepEqual(creditNote.creditNoteReason, {
    code: 'DL8.61.1.A', label: 'supply cancelled'
  });
  assert.deepEqual(creditNote.precedingInvoiceReferences, ['AE-INV-2026-0004']);
  assert.equal(creditNote.lines[0].quantity, -5);
  assert.equal(creditNote.lines[0].unitPrice, 100);
  assert.equal(creditNote.lines[0].lineNet, -500);
  assert.deepEqual(creditNote.totals, {
    lineTotal: -500,
    subtotal: -500,
    vatTotal: -25,
    vatTotalInTaxCurrency: null,
    total: -525,
    payable: -525
  });
  assert.deepEqual(creditNote.vatBreakdown, [
    { category: 'S', ratePercent: 5, taxableAmount: -500, taxAmount: -25 }
  ]);
  assert.equal(creditNote.sourceEconomics.lines[0].quantity, 5);
  assert.equal(creditNote.sourceEconomics.lines[0].lineNet, 500);
  assert.deepEqual(creditNote.sourceEconomics.totals, {
    lineTotal: 500,
    subtotal: 500,
    vatTotal: 25,
    vatTotalInTaxCurrency: null,
    total: 525,
    payable: 525
  });
});

test('all current Invoice and CreditNote type-code lanes dispatch', () => {
  for (const typeCode of ['380', '389', '480']) {
    const result = parsePintAeBillingDocument({ xml: billingXml({ typeCode }) });
    assert.equal(result.ok, true, `Invoice type ${typeCode}`);
    assert.equal(result.document.documentKind, 'invoice');
    assert.equal(result.document.typeCode, typeCode);
  }
  for (const typeCode of ['381', '261', '81']) {
    const result = parsePintAeBillingDocument({
      xml: billingXml({ kind: 'credit_note', typeCode })
    });
    assert.equal(result.ok, true, `CreditNote type ${typeCode}`);
    assert.equal(result.document.documentKind, 'credit_note');
    assert.equal(result.document.typeCode, typeCode);
  }
});

test('the exact existing AE VAT category set is accepted and remains frozen', () => {
  assert.deepEqual(AE_VAT_CATEGORY_CODES, ['S', 'Z', 'E', 'AE', 'O']);
  assert.ok(Object.isFrozen(AE_VAT_CATEGORY_CODES));
  for (const category of AE_VAT_CATEGORY_CODES) {
    const rate = category === 'S' ? '5' : '0';
    const tax = category === 'S' ? '5.00' : '0.00';
    const total = category === 'S' ? '105.00' : '100.00';
    const result = parsePintAeBillingDocument({
      xml: billingXml({
        lines: [{
          id: '1', description: `Category ${category}`, quantity: '1',
          unitPrice: '100.00', lineNet: '100.00', category, rate
        }],
        breakdowns: [{ taxable: '100.00', tax, category, rate }],
        lineTotal: '100.00',
        subtotal: '100.00',
        vatTotal: tax,
        total,
        payable: total
      })
    });
    assert.equal(result.ok, true, category);
    assert.equal(result.document.lines[0].vatCategory, category);
    assert.equal(result.document.vatBreakdown[0].category, category);
  }
});

test('prefixes are irrelevant when every expanded name remains exact', () => {
  for (const kind of ['invoice', 'credit_note']) {
    const xml = billingXml({
      kind,
      rootPrefix: 'billing',
      cbcPrefix: 'basic',
      cacPrefix: 'aggregate'
    });
    const result = parsePintAeBillingDocument({ xml });
    assert.equal(result.ok, true);
    assert.equal(result.document.documentKind, kind);
  }
});

test('all six PINT AE CreditReason values map to the exact stable labels', () => {
  assert.ok(Object.isFrozen(PINT_AE_CREDIT_NOTE_REASONS));
  assert.deepEqual(Object.keys(PINT_AE_CREDIT_NOTE_REASONS), [
    'DL8.61.1.A', 'DL8.61.1.B', 'DL8.61.1.C',
    'DL8.61.1.D', 'DL8.61.1.E', 'VD'
  ]);
  for (const [code, label] of Object.entries(PINT_AE_CREDIT_NOTE_REASONS)) {
    const result = parsePintAeCreditNote({
      xml: billingXml({ kind: 'credit_note', reasonCode: code })
    });
    assert.equal(result.ok, true, code);
    assert.deepEqual(result.creditNote.creditNoteReason, { code, label });
  }
});

test('zero, one and multiple distinct preceding-Invoice references preserve order', () => {
  for (const references of [[], ['INV-1'], ['INV-2', 'INV-1', 'INV-3']]) {
    const result = parsePintAeCreditNote({
      xml: billingXml({ kind: 'credit_note', references })
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.creditNote.precedingInvoiceReferences, references);
  }
});

test('one negative source CreditNote line reverses once while the aggregate credit stays negative', () => {
  const lines = [
    {
      id: '1', description: 'Returned equipment', quantity: '6', unitPrice: '100.00',
      lineNet: '600.00', category: 'S', rate: '5'
    },
    {
      id: '2', description: 'Reversal of original discount', quantity: '-1',
      unitPrice: '100.00', lineNet: '-100.00', category: 'S', rate: '5'
    }
  ];
  const result = parsePintAeCreditNote({
    xml: billingXml({ kind: 'credit_note', lines })
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.creditNote.sourceEconomics.lines, [
    { linePosition: 1, quantity: 6, unitPrice: 100, lineNet: 600 },
    { linePosition: 2, quantity: -1, unitPrice: 100, lineNet: -100 }
  ]);
  assert.equal(result.creditNote.lines[0].quantity, -6);
  assert.equal(result.creditNote.lines[0].lineNet, -600);
  assert.equal(result.creditNote.lines[1].quantity, 1);
  assert.equal(result.creditNote.lines[1].lineNet, 100);
  assert.equal(result.creditNote.totals.total, -525);
});

test('success documents, discriminants, nested collections and provenance are deeply immutable', () => {
  const shared = parsePintAeBillingDocument({ xml: billingXml({ kind: 'credit_note' }) });
  const wrapped = parsePintAeCreditNote({ xml: billingXml({ kind: 'credit_note' }) });
  assert.equal(shared.ok, true);
  const document = shared.document;
  for (const value of [
    document,
    document.supplier,
    document.lines,
    document.lines[0],
    document.totals,
    document.vatBreakdown,
    document.sourceEconomics,
    document.sourceEconomics.lines,
    document.precedingInvoiceReferences,
    wrapped.creditNote,
    PINT_AE_SPEC_PROVENANCE,
    PINT_AE_SPEC_PROVENANCE.sourceUrls
  ]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { document.documentKind = 'invoice'; }, TypeError);
  assert.throws(() => { document.lines[0].lineNet = 500; }, TypeError);
  assert.throws(() => { document.lines.push({}); }, TypeError);
  assert.throws(() => { PINT_AE_SPEC_PROVENANCE.pintAeVersion = 'latest'; }, TypeError);
});

test('foreign-currency Invoice keeps the former primary/secondary TaxTotal meanings', () => {
  const result = parsePintAeInvoice({
    xml: billingXml({
      currency: 'USD',
      taxCurrency: 'AED',
      secondaryTaxAmount: '183.65'
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.invoice.currency, 'USD');
  assert.equal(result.invoice.taxCurrency, 'AED');
  assert.equal(result.invoice.totals.vatTotal, 50);
  assert.equal(result.invoice.totals.vatTotalInTaxCurrency, 183.65);
  assert.deepEqual(result.warnings, []);
});

test('valid-Invoice warnings retain deterministic former ordering', () => {
  const result = parsePintAeInvoice({
    xml: billingXml({
      currency: 'USD',
      breakdowns: [
        { taxable: '1000.00', tax: '48.00', category: 'S', rate: '5' },
        { taxable: '200.00', tax: '0.00', category: 'Z', rate: '0' }
      ],
      vatTotal: '48.00',
      total: '1248.00',
      payable: '1200.00'
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0], /1000 × 5% = 50, declared 48/);
  assert.match(result.warnings[1], /payable amount/);
  assert.match(result.warnings[2], /no TaxCurrencyCode/);
});

test('empty, truncated and malformed XML refuse at the first precedence class', () => {
  for (const xml of [undefined, null, '', '   ']) sharedRefusal(xml, 'empty_input');
  for (const xml of [
    '<Invoice>',
    '<Invoice><cbc:ID>broken</Invoice>',
    '<Invoice><![CDATA[unterminated'
  ]) sharedRefusal(xml, 'xml_malformed');
});

test('Finvoice and arbitrary roots are unsupported billing documents', () => {
  for (const xml of [
    '<Finvoice Version="3.0"><InvoiceDetails/></Finvoice>',
    '<Anything xmlns="urn:example:other"><ID>1</ID></Anything>'
  ]) sharedRefusal(xml, 'unsupported_billing_document');
});

test('missing, wrong and swapped root namespaces fail before field validation', () => {
  for (const xml of [
    billingXml({ rootNamespace: null }),
    billingXml({ rootNamespace: 'urn:attacker:invoice' }),
    billingXml({ rootNamespace: PINT_AE_CREDIT_NOTE_NAMESPACE }),
    billingXml({ kind: 'credit_note', rootNamespace: PINT_AE_INVOICE_NAMESPACE })
  ]) sharedRefusal(xml, 'invalid_ubl_namespace');
});

test('missing, wrong and rebound cbc/cac namespaces cannot enter by local-name lookalike', () => {
  const reboundId = replaceOnce(
    billingXml(),
    '<cbc:ID>AE-INV-2026-0042</cbc:ID>',
    '<evil:ID xmlns:evil="urn:attacker:cbc">AE-INV-2026-0042</evil:ID>'
  );
  const defaultNamespaceId = replaceOnce(
    billingXml(),
    '<cbc:ID>AE-INV-2026-0042</cbc:ID>',
    '<ID>AE-INV-2026-0042</ID>'
  );
  for (const xml of [
    billingXml({ cbcNamespace: null }),
    billingXml({ cbcNamespace: 'urn:attacker:cbc' }),
    billingXml({ cacNamespace: null }),
    billingXml({ cacNamespace: 'urn:attacker:cac' }),
    reboundId,
    defaultNamespaceId
  ]) sharedRefusal(xml, 'invalid_ubl_namespace');
});

test('Invoice and CreditNote wrappers reject the opposite valid root with expected/found kinds', () => {
  const invoiceRefusal = wrapperRefusal(
    parsePintAeInvoice,
    'invoice',
    billingXml({ kind: 'credit_note' }),
    'document_kind_mismatch'
  );
  assert.deepEqual(invoiceRefusal.details, {
    expectedKind: 'invoice', foundKind: 'credit_note', elementPaths: []
  });
  const creditRefusal = wrapperRefusal(
    parsePintAeCreditNote,
    'creditNote',
    billingXml(),
    'document_kind_mismatch'
  );
  assert.deepEqual(creditRefusal.details, {
    expectedKind: 'credit_note', foundKind: 'invoice', elementPaths: []
  });
});

test('root/type-element, line and quantity lane swaps fail in both directions', () => {
  const mutations = [
    billingXml({ typeLocalName: 'CreditNoteTypeCode', typeCode: '381' }),
    billingXml({ lineLocalName: 'CreditNoteLine' }),
    billingXml({ quantityLocalName: 'CreditedQuantity' }),
    billingXml({ kind: 'credit_note', typeLocalName: 'InvoiceTypeCode', typeCode: '380' }),
    billingXml({ kind: 'credit_note', lineLocalName: 'InvoiceLine' }),
    billingXml({ kind: 'credit_note', quantityLocalName: 'InvoicedQuantity' })
  ];
  for (const xml of mutations) {
    const refusal = sharedRefusal(xml, 'document_kind_mismatch');
    assert.ok(refusal.details.elementPaths.length >= 1);
  }
});

test('opposite-lane type values mismatch while unknown type values use their own refusal', () => {
  for (const [kind, typeCode, foundKind] of [
    ['invoice', '381', 'credit_note'],
    ['credit_note', '380', 'invoice']
  ]) {
    const refusal = sharedRefusal(
      billingXml({ kind, typeCode }),
      'document_kind_mismatch'
    );
    assert.equal(refusal.details.foundKind, foundKind);
  }
  for (const [kind, typeCode] of [['invoice', '999'], ['credit_note', '999']]) {
    sharedRefusal(billingXml({ kind, typeCode }), 'invalid_document_type_code');
  }
});

test('missing/empty mandatory paths are complete and fixed-order', () => {
  let xml = billingXml();
  xml = replaceOnce(xml, '<cbc:ID>AE-INV-2026-0042</cbc:ID>', '');
  xml = replaceOnce(xml, '<cbc:IssueDate>2026-08-12</cbc:IssueDate>', '<cbc:IssueDate> </cbc:IssueDate>');
  xml = replaceOnce(xml, '<cbc:RegistrationName>Gulf Trading LLC</cbc:RegistrationName>', '');
  const refusal = sharedRefusal(xml, 'missing_mandatory');
  assert.deepEqual(refusal.details.paths.slice(0, 3), [
    'cbc:ID',
    'cbc:IssueDate',
    'cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'
  ]);
});

test('duplicate mandatory wins over missing and details retain fixed schema order', () => {
  let xml = billingXml();
  xml = replaceOnce(
    xml,
    '<cbc:ID>AE-INV-2026-0042</cbc:ID>',
    '<cbc:ID>AE-INV-2026-0042</cbc:ID><cbc:ID>AE-INV-DUP</cbc:ID>'
  );
  xml = replaceOnce(
    xml,
    '<cbc:IssueDate>2026-08-12</cbc:IssueDate>',
    '<cbc:IssueDate>2026-08-12</cbc:IssueDate><cbc:IssueDate>2026-08-13</cbc:IssueDate>'
  );
  xml = replaceOnce(xml, '<cbc:DocumentCurrencyCode>AED</cbc:DocumentCurrencyCode>', '');
  const refusal = sharedRefusal(xml, 'duplicate_mandatory');
  assert.deepEqual(refusal.details.paths, ['cbc:ID', 'cbc:IssueDate']);
});

test('duplicate customization/profile and consumed optional singletons fail closed', () => {
  const cases = [
    replaceOnce(
      billingXml(),
      `<cbc:CustomizationID>${PINT_AE_CUSTOMIZATION_ID}</cbc:CustomizationID>`,
      `<cbc:CustomizationID>${PINT_AE_CUSTOMIZATION_ID}</cbc:CustomizationID><cbc:CustomizationID>${PINT_AE_CUSTOMIZATION_ID}</cbc:CustomizationID>`
    ),
    replaceOnce(
      billingXml(),
      `<cbc:ProfileID>${PINT_AE_PROFILE_ID}</cbc:ProfileID>`,
      `<cbc:ProfileID>${PINT_AE_PROFILE_ID}</cbc:ProfileID><cbc:ProfileID>${PINT_AE_PROFILE_ID}</cbc:ProfileID>`
    ),
    replaceOnce(
      billingXml(),
      '<cbc:DueDate>2026-09-11</cbc:DueDate>',
      '<cbc:DueDate>2026-09-11</cbc:DueDate><cbc:DueDate>2026-09-12</cbc:DueDate>'
    )
  ];
  for (const xml of cases) sharedRefusal(xml, 'duplicate_mandatory');
});

test('party, total, line and VAT-breakdown mandatory cardinality is enforced', () => {
  const cases = [
    replaceOnce(
      billingXml(),
      '<cbc:RegistrationName>Gulf Trading LLC</cbc:RegistrationName>',
      '<cbc:RegistrationName></cbc:RegistrationName>'
    ),
    replaceOnce(
      billingXml(),
      '<cbc:TaxExclusiveAmount currencyID="AED">1200.00</cbc:TaxExclusiveAmount>',
      ''
    ),
    billingXml({ lines: [] }),
    replaceOnce(
      billingXml(),
      '<cbc:ID>1</cbc:ID>',
      '<cbc:ID>1</cbc:ID><cbc:ID>1b</cbc:ID>'
    ),
    billingXml({ breakdowns: [] }),
    billingXml({ lines: [{ ...invoiceLines()[0], rate: null }] })
  ];
  for (const xml of cases) {
    const result = parsePintAeBillingDocument({ xml });
    assert.equal(result.ok, false);
    assert.ok(['duplicate_mandatory', 'missing_mandatory'].includes(result.refusal.code));
  }
});

test('CreditNote reason missing, empty, unknown, duplicated and whitespace-altered all refuse', () => {
  const cases = [
    '',
    '<cac:DiscrepancyResponse><cbc:ResponseCode></cbc:ResponseCode></cac:DiscrepancyResponse>',
    '<cac:DiscrepancyResponse><cbc:ResponseCode>UNKNOWN</cbc:ResponseCode></cac:DiscrepancyResponse>',
    '<cac:DiscrepancyResponse><cbc:ResponseCode>VD</cbc:ResponseCode><cbc:ResponseCode>VD</cbc:ResponseCode></cac:DiscrepancyResponse>',
    '<cac:DiscrepancyResponse><cbc:ResponseCode> VD </cbc:ResponseCode></cac:DiscrepancyResponse>',
    '<cac:DiscrepancyResponse><cbc:ResponseCode>VD</cbc:ResponseCode></cac:DiscrepancyResponse><cac:DiscrepancyResponse><cbc:ResponseCode>VD</cbc:ResponseCode></cac:DiscrepancyResponse>'
  ];
  for (const reasonMarkup of cases) {
    sharedRefusal(
      billingXml({ kind: 'credit_note', reasonMarkup }),
      'invalid_credit_note_reason'
    );
  }
});

test('malformed and duplicated preceding-Invoice references fail structurally', () => {
  const cases = [
    {
      markup: '<cac:BillingReference></cac:BillingReference>',
      code: 'missing_mandatory'
    },
    {
      markup: '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID></cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>',
      code: 'missing_mandatory'
    },
    {
      markup: '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-1</cbc:ID><cbc:ID>INV-2</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>',
      code: 'duplicate_mandatory'
    },
    {
      markup: '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-1</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-1</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>',
      code: 'duplicate_mandatory'
    }
  ];
  for (const { markup, code } of cases) {
    sharedRefusal(
      billingXml({ kind: 'credit_note', referencesMarkup: markup }),
      code
    );
  }
});

test('decimal comma, exponent, grouping, NaN, Infinity, sign-only and unsafe precision refuse', () => {
  for (const value of [
    '100,00',
    '1e2',
    '1 000.00',
    'NaN',
    'Infinity',
    '-',
    '90071992547409.92'
  ]) {
    const lines = invoiceLines();
    lines[0].unitPrice = value;
    const refusal = sharedRefusal(billingXml({ lines }), 'invalid_decimal');
    assert.equal(refusal.details.values[0].path, 'cac:InvoiceLine[1]/cac:Price/cbc:PriceAmount');
  }
});

test('a present blank optional decimal is invalid_decimal rather than silently null', () => {
  let xml = billingXml();
  xml = replaceOnce(xml, '<cbc:Percent>0</cbc:Percent>', '<cbc:Percent> </cbc:Percent>');
  sharedRefusal(xml, 'invalid_decimal');
});

test('invalid decimal details are collected in deterministic schema order', () => {
  const lines = invoiceLines();
  lines[0].quantity = '1e1';
  lines[0].unitPrice = '1,00';
  const refusal = sharedRefusal(billingXml({ lines }), 'invalid_decimal');
  assert.deepEqual(refusal.details.values.map((entry) => entry.path), [
    'cac:InvoiceLine[1]/cbc:InvoicedQuantity',
    'cac:InvoiceLine[1]/cac:Price/cbc:PriceAmount'
  ]);
});

test('zero/nonpositive prices and invalid aggregate source signs refuse before arithmetic', () => {
  const zeroPriceLines = invoiceLines();
  zeroPriceLines[0].unitPrice = '0.00';
  sharedRefusal(billingXml({ lines: zeroPriceLines }), 'invalid_monetary_sign');
  sharedRefusal(billingXml({ total: '-1250.00' }), 'invalid_monetary_sign');
  sharedRefusal(billingXml({ total: '-0.004' }), 'invalid_monetary_sign');
  sharedRefusal(billingXml({
    lines: [{
      id: '1', description: 'Non-zero line', quantity: '1', unitPrice: '1.00',
      lineNet: '1.00', category: 'Z', rate: '0'
    }],
    breakdowns: [{ taxable: '1.00', tax: '0.00', category: 'Z', rate: '0' }],
    lineTotal: '1.00', subtotal: '1.00', vatTotal: '0.00', total: '0.00', payable: '0.00'
  }), 'invalid_monetary_sign');
});

test('supplier TRN is mandatory/valid and malformed present buyer TRN now refuses', () => {
  sharedRefusal(billingXml({ supplierTrn: 'AE-12345' }), 'invalid_supplier_trn');
  sharedRefusal(billingXml({ buyerTrn: '999' }), 'invalid_buyer_trn');
  const absentBuyer = parsePintAeInvoice({ xml: billingXml({ buyerTrn: null }) });
  assert.equal(absentBuyer.ok, true);
  assert.equal(absentBuyer.invoice.buyer.trn, null);
});

test('unknown line and VAT-breakdown categories refuse with exact paths', () => {
  const lines = invoiceLines();
  lines[1].category = 'K';
  const breakdowns = invoiceBreakdowns();
  breakdowns[1].category = 'L';
  const refusal = sharedRefusal(
    billingXml({ lines, breakdowns }),
    'invalid_vat_category'
  );
  assert.deepEqual(refusal.details.allowed, AE_VAT_CATEGORY_CODES);
  assert.deepEqual(refusal.details.found.map((entry) => entry.value), ['K', 'L']);
});

test('line, header and VAT-breakdown footing failures are all reported deterministically', () => {
  const refusal = sharedRefusal(billingXml({
    lineTotal: '1100.00',
    total: '1300.00',
    payable: '1300.00',
    breakdowns: [
      { taxable: '1000.00', tax: '40.00', category: 'S', rate: '5' },
      { taxable: '200.00', tax: '0.00', category: 'Z', rate: '0' }
    ]
  }), 'amount_mismatch');
  assert.deepEqual(refusal.details.mismatches, [
    'subtotal (1200) + VAT (50) != total (1300)',
    'line net sum (1200) != line extension total (1100)',
    'VAT breakdown sum (40) != VAT total (50)'
  ]);
});

test('customization/profile missing, case and whitespace near-misses fail exactly as not_pint_ae', () => {
  const cases = [
    billingXml({ customizationMarkup: '' }),
    billingXml({ customizationId: PINT_AE_CUSTOMIZATION_ID.toUpperCase() }),
    billingXml({ customizationId: ` ${PINT_AE_CUSTOMIZATION_ID} ` }),
    billingXml({ profileMarkup: '' }),
    billingXml({ profileId: PINT_AE_PROFILE_ID.toUpperCase() }),
    billingXml({ profileId: `${PINT_AE_PROFILE_ID} ` })
  ];
  for (const xml of cases) sharedRefusal(xml, 'not_pint_ae');
});

test('refusal precedence is stable across compound adversarial mutations', () => {
  const duplicateId = replaceOnce(
    billingXml(),
    '<cbc:ID>AE-INV-2026-0042</cbc:ID>',
    '<cbc:ID>AE-INV-2026-0042</cbc:ID><cbc:ID>DUP</cbc:ID>'
  );
  const oppositeElement = billingXml({
    typeLocalName: 'CreditNoteTypeCode',
    typeCode: '381',
    customizationId: 'wrong'
  });
  const invalidDecimalAndType = billingXml({
    typeCode: '999',
    lines: [{ ...invoiceLines()[0], unitPrice: '1e2' }, invoiceLines()[1]]
  });
  const invalidReasonAndTrn = billingXml({
    kind: 'credit_note',
    reasonCode: 'UNKNOWN',
    supplierTrn: 'bad'
  });
  const invalidTrnAndVat = billingXml({
    supplierTrn: 'bad',
    lines: [invoiceLines()[0], { ...invoiceLines()[1], category: 'K' }]
  });
  const cases = [
    [billingXml({ cbcNamespace: 'urn:bad', customizationId: 'wrong' }), 'invalid_ubl_namespace'],
    [oppositeElement, 'document_kind_mismatch'],
    [billingXml({ customizationId: 'wrong', rootExtra: '<cbc:ID>DUP</cbc:ID>' }), 'not_pint_ae'],
    [replaceOnce(duplicateId, '<cbc:IssueDate>2026-08-12</cbc:IssueDate>', ''), 'duplicate_mandatory'],
    [invalidDecimalAndType, 'invalid_decimal'],
    [billingXml({ kind: 'credit_note', typeCode: '999', reasonCode: 'UNKNOWN' }), 'invalid_document_type_code'],
    [invalidReasonAndTrn, 'invalid_credit_note_reason'],
    [invalidTrnAndVat, 'invalid_supplier_trn'],
    [billingXml({ total: '-1300.00' }), 'invalid_monetary_sign']
  ];
  for (const [xml, code] of cases) sharedRefusal(xml, code);
});

const refusalFixtures = () => ({
  empty_input: { kind: 'invoice', xml: '' },
  xml_malformed: { kind: 'invoice', xml: '<Invoice>' },
  unsupported_billing_document: { kind: 'invoice', xml: '<Finvoice></Finvoice>' },
  invalid_ubl_namespace: { kind: 'invoice', xml: billingXml({ rootNamespace: 'urn:bad' }) },
  not_pint_ae: { kind: 'invoice', xml: billingXml({ customizationId: 'wrong' }) },
  document_kind_mismatch: { kind: 'invoice', xml: billingXml({ typeCode: '381' }) },
  duplicate_mandatory: {
    kind: 'invoice',
    xml: replaceOnce(
      billingXml(),
      '<cbc:ID>AE-INV-2026-0042</cbc:ID>',
      '<cbc:ID>AE-INV-2026-0042</cbc:ID><cbc:ID>DUP</cbc:ID>'
    )
  },
  missing_mandatory: {
    kind: 'invoice',
    xml: replaceOnce(billingXml(), '<cbc:IssueDate>2026-08-12</cbc:IssueDate>', '')
  },
  invalid_decimal: {
    kind: 'invoice',
    xml: billingXml({ lines: [{ ...invoiceLines()[0], unitPrice: '1e2' }, invoiceLines()[1]] })
  },
  invalid_document_type_code: { kind: 'invoice', xml: billingXml({ typeCode: '999' }) },
  invalid_monetary_sign: { kind: 'invoice', xml: billingXml({ total: '-1250.00' }) },
  invalid_supplier_trn: { kind: 'invoice', xml: billingXml({ supplierTrn: 'bad' }) },
  invalid_buyer_trn: { kind: 'invoice', xml: billingXml({ buyerTrn: 'bad' }) },
  invalid_vat_category: {
    kind: 'invoice',
    xml: billingXml({ lines: [invoiceLines()[0], { ...invoiceLines()[1], category: 'K' }] })
  },
  invalid_credit_note_reason: {
    kind: 'credit_note',
    xml: billingXml({ kind: 'credit_note', reasonCode: 'UNKNOWN' })
  },
  amount_mismatch: { kind: 'invoice', xml: billingXml({ total: '1300.00' }) }
});

const PARTIAL_FIELD_NAMES = new Set([
  'lines',
  'totals',
  'vatBreakdown',
  'supplier',
  'buyer',
  'creditNoteReason',
  'precedingInvoiceReferences',
  'sourceEconomics',
  'documentNumber',
  'invoiceNumber'
]);

const assertNoPartialDocumentData = (value, path = '$') => {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!PARTIAL_FIELD_NAMES.has(key), `${path}.${key} must not carry partial document data`);
    assertNoPartialDocumentData(nested, `${path}.${key}`);
  }
};

test('every refusal code recursively guarantees zero partial document output in shared and wrapper envelopes', () => {
  const fixtures = refusalFixtures();
  assert.deepEqual(Object.keys(fixtures), PINT_REFUSAL_CODES);
  for (const [code, fixture] of Object.entries(fixtures)) {
    const shared = parsePintAeBillingDocument({ xml: fixture.xml });
    assert.equal(shared.ok, false, code);
    assert.equal(shared.document, null, code);
    assert.equal(shared.refusal.code, code);
    assert.deepEqual(shared.warnings, []);
    assertNoPartialDocumentData(shared.refusal, `${code}.refusal`);
    assertNoPartialDocumentData(shared.warnings, `${code}.warnings`);

    const parse = fixture.kind === 'credit_note' ? parsePintAeCreditNote : parsePintAeInvoice;
    const field = fixture.kind === 'credit_note' ? 'creditNote' : 'invoice';
    const wrapped = parse({ xml: fixture.xml });
    assert.equal(wrapped.ok, false, code);
    assert.equal(wrapped[field], null, code);
    assert.equal(wrapped.refusal.code, code);
    assert.deepEqual(wrapped.warnings, []);
    assertNoPartialDocumentData(wrapped.refusal, `${code}.wrapper.refusal`);
    assertNoPartialDocumentData(wrapped.warnings, `${code}.wrapper.warnings`);
  }
});
