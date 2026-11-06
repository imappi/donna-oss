// PINT AE (UBL 2.1) billing-document parsing, PURE COMPUTE.
//
// This module is the bounded application-validation core described by
// docs/design-donna-ae-pint-credit-note.md. It deliberately has no caller in
// the receive pipeline and no writer, worker, database, network, model, flag,
// transport or accounting authority. It reuses the shared dependency-
// free XML reader and adds only a namespace index over the returned tree.
//
// Trust-the-strong-LLM: namespace, cardinality, decimal, identifier, sign and
// footing checks are Keep-layer invariants. Vendor resolution, coding, VAT
// treatment, matching and original-invoice resolution remain downstream work.

import { parseXml } from '../xmlReader.js';
import { isValidAeTrn } from './vatRegistration.js';
import { AE_VAT_STANDARD_RATE } from './vatCodes.js';

export const PINT_AE_CUSTOMIZATION_ID = 'urn:peppol:pint:billing-1@ae-1';
export const PINT_AE_PROFILE_ID = 'urn:peppol:bis:billing';

export const PINT_AE_INVOICE_NAMESPACE =
  'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
export const PINT_AE_CREDIT_NOTE_NAMESPACE =
  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2';
export const UBL_CBC_NAMESPACE =
  'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
export const UBL_CAC_NAMESPACE =
  'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';

const deepFreeze = (value, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
};

// Exact offline replay receipt for PINT AE 1.0.4 / PINT 1.1.3. These are the
// primary URLs and byte pins approved in the binding design; this module never
// fetches them and never claims that the publishers signed the recorded hashes.
export const PINT_AE_SPEC_PROVENANCE = deepFreeze({
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

export const AE_VAT_CATEGORY_CODES = Object.freeze(['S', 'Z', 'E', 'AE', 'O']);

export const PINT_AE_CREDIT_NOTE_REASONS = deepFreeze({
  'DL8.61.1.A': 'supply cancelled',
  'DL8.61.1.B': 'tax treatment changed because the nature of supply changed',
  'DL8.61.1.C': 'agreed consideration altered, including bad-debt relief',
  'DL8.61.1.D': 'goods or services returned in full or part, with consideration returned in full or part',
  'DL8.61.1.E': 'tax charged or tax treatment applied in error',
  VD: 'volume discount'
});

export const PINT_REFUSAL_VOCABULARY_VERSION = 'pint-ae-billing-refusal-v2';
export const PINT_REFUSAL_CODES = Object.freeze([
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

const DOCUMENT_KINDS = deepFreeze({
  invoice: {
    rootLocalName: 'Invoice',
    rootNamespace: PINT_AE_INVOICE_NAMESPACE,
    typeLocalName: 'InvoiceTypeCode',
    lineLocalName: 'InvoiceLine',
    quantityLocalName: 'InvoicedQuantity',
    allowedTypeCodes: ['380', '389', '480'],
    oppositeKind: 'credit_note',
    oppositeTypeLocalName: 'CreditNoteTypeCode',
    oppositeLineLocalName: 'CreditNoteLine',
    oppositeQuantityLocalName: 'CreditedQuantity'
  },
  credit_note: {
    rootLocalName: 'CreditNote',
    rootNamespace: PINT_AE_CREDIT_NOTE_NAMESPACE,
    typeLocalName: 'CreditNoteTypeCode',
    lineLocalName: 'CreditNoteLine',
    quantityLocalName: 'CreditedQuantity',
    allowedTypeCodes: ['381', '261', '81'],
    oppositeKind: 'invoice',
    oppositeTypeLocalName: 'InvoiceTypeCode',
    oppositeLineLocalName: 'InvoiceLine',
    oppositeQuantityLocalName: 'InvoicedQuantity'
  }
});

const ROOT_KIND_BY_LOCAL_NAME = Object.freeze({
  Invoice: 'invoice',
  CreditNote: 'credit_note'
});

const CBC_LOCAL_NAMES = new Set([
  'CustomizationID', 'ProfileID', 'ID', 'IssueDate', 'DueDate',
  'InvoiceTypeCode', 'CreditNoteTypeCode', 'DocumentCurrencyCode',
  'TaxCurrencyCode', 'Name', 'RegistrationName', 'CompanyID',
  'TaxAmount', 'TaxableAmount', 'LineExtensionAmount',
  'TaxExclusiveAmount', 'TaxInclusiveAmount', 'PayableAmount',
  'InvoicedQuantity', 'CreditedQuantity', 'PriceAmount', 'Percent',
  'ResponseCode'
]);

const CAC_LOCAL_NAMES = new Set([
  'AccountingSupplierParty', 'AccountingCustomerParty', 'Party', 'PartyName',
  'PartyLegalEntity', 'PartyTaxScheme', 'TaxTotal', 'TaxSubtotal',
  'TaxCategory', 'LegalMonetaryTotal', 'InvoiceLine', 'CreditNoteLine',
  'Item', 'ClassifiedTaxCategory', 'Price', 'DiscrepancyResponse',
  'BillingReference', 'InvoiceDocumentReference'
]);

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0;
const rawText = (node) => (node ? String(node.text || '') : '');
const text = (node) => rawText(node).trim();
const round2 = (number) =>
  Math.round((Number(number) + Number.EPSILON) * 100) / 100;
const namespacePrefix = (name) =>
  name.includes(':') ? name.slice(0, name.indexOf(':')) : '';

const canonicalElementName = (node) => {
  if (CBC_LOCAL_NAMES.has(node.localName)) return `cbc:${node.localName}`;
  if (CAC_LOCAL_NAMES.has(node.localName)) return `cac:${node.localName}`;
  return node.localName;
};

// parseXml intentionally remains the one XML reader. This index resolves each
// node's expanded name from in-scope xmlns declarations, retaining prefix
// independence while detecting missing, wrong and rebound component namespaces.
const indexNamespaces = (root) => {
  const metadata = new WeakMap();
  const orderedNodes = [];

  const visit = (node, inheritedScope, canonicalPath) => {
    const scope = new Map(inheritedScope);
    for (const [attribute, value] of Object.entries(node.attrs || {})) {
      if (attribute === 'xmlns') scope.set('', value);
      else if (attribute.startsWith('xmlns:')) scope.set(attribute.slice(6), value);
    }

    const prefix = namespacePrefix(node.name);
    const namespaceUri = scope.get(prefix) || null;
    metadata.set(node, { namespaceUri, canonicalPath });
    orderedNodes.push(node);

    const localOrdinals = new Map();
    for (const child of node.children || []) {
      const ordinal = (localOrdinals.get(child.localName) || 0) + 1;
      localOrdinals.set(child.localName, ordinal);
      visit(
        child,
        scope,
        `${canonicalPath}/${canonicalElementName(child)}[${ordinal}]`
      );
    }
  };

  visit(root, new Map(), `/${root.localName}`);
  return {
    orderedNodes,
    namespaceOf: (node) => metadata.get(node)?.namespaceUri || null,
    pathOf: (node) => metadata.get(node)?.canonicalPath || null
  };
};

const childrenIn = (node, namespaceIndex, namespaceUri, localName) =>
  (node?.children || []).filter(
    (child) => child.localName === localName && namespaceIndex.namespaceOf(child) === namespaceUri
  );

const makeRefusal = (code, message, details = null) => {
  if (!PINT_REFUSAL_CODES.includes(code)) {
    throw new Error(`Unknown PINT AE refusal code: ${code}`);
  }
  return deepFreeze({
    ok: false,
    refusal: {
      vocabularyVersion: PINT_REFUSAL_VOCABULARY_VERSION,
      code,
      message,
      details
    },
    warnings: [],
    document: null
  });
};

const parseDecimal = (node, canonicalPath) => {
  const lexical = rawText(node).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(lexical)) {
    return {
      ok: false,
      detail: { path: canonicalPath, value: lexical, issue: 'invalid_lexeme' }
    };
  }
  const value = Number(lexical);
  const maxCentMagnitude = Number.MAX_SAFE_INTEGER / 100;
  if (
    !Number.isFinite(value) ||
    value > maxCentMagnitude ||
    value < -maxCentMagnitude ||
    !Number.isSafeInteger(Math.round(value * 100))
  ) {
    return {
      ok: false,
      detail: { path: canonicalPath, value: lexical, issue: 'unsafe_cent_precision' }
    };
  }
  return { ok: true, value: Object.is(value, -0) ? 0 : value };
};

const kindSigned = (documentKind, value) => {
  if (value == null || documentKind === 'invoice') return value;
  return value === 0 ? 0 : -value;
};

const parseBillingDocument = ({ xml } = {}, expectedKind = null) => {
  if (!isNonEmptyString(xml)) {
    return makeRefusal('empty_input', 'No PINT AE billing-document XML was provided.');
  }

  let root;
  try {
    root = parseXml(xml);
  } catch (error) {
    return makeRefusal(
      'xml_malformed',
      'The input could not be read as well-formed XML.',
      { parserCode: error?.code || 'XML_ERROR' }
    );
  }

  const documentKind = ROOT_KIND_BY_LOCAL_NAME[root.localName] || null;
  const namespaceIndex = indexNamespaces(root);
  if (!documentKind) {
    return makeRefusal(
      'unsupported_billing_document',
      'The XML root is not a supported UBL Invoice or CreditNote.',
      {
        path: namespaceIndex.pathOf(root),
        rootLocalName: root.localName,
        namespaceUri: namespaceIndex.namespaceOf(root)
      }
    );
  }

  const kind = DOCUMENT_KINDS[documentKind];
  const rootNamespace = namespaceIndex.namespaceOf(root);
  if (rootNamespace !== kind.rootNamespace) {
    return makeRefusal(
      'invalid_ubl_namespace',
      'The billing-document root does not use the required UBL namespace.',
      {
        elements: [{
          path: namespaceIndex.pathOf(root),
          expectedNamespace: kind.rootNamespace,
          foundNamespace: rootNamespace
        }]
      }
    );
  }

  if (expectedKind && expectedKind !== documentKind) {
    return makeRefusal(
      'document_kind_mismatch',
      'The billing document does not match the requested document kind.',
      { expectedKind, foundKind: documentKind, elementPaths: [] }
    );
  }

  const namespaceIssues = [];
  for (const node of namespaceIndex.orderedNodes.slice(1)) {
    let expectedNamespace = null;
    if (CBC_LOCAL_NAMES.has(node.localName)) expectedNamespace = UBL_CBC_NAMESPACE;
    else if (CAC_LOCAL_NAMES.has(node.localName)) expectedNamespace = UBL_CAC_NAMESPACE;
    if (!expectedNamespace) continue;
    const foundNamespace = namespaceIndex.namespaceOf(node);
    if (foundNamespace !== expectedNamespace) {
      namespaceIssues.push({
        path: namespaceIndex.pathOf(node),
        expectedNamespace,
        foundNamespace
      });
    }
  }
  if (namespaceIssues.length) {
    return makeRefusal(
      'invalid_ubl_namespace',
      'A consumed UBL component does not use its required namespace.',
      { elements: namespaceIssues }
    );
  }

  const oppositeElementPaths = namespaceIndex.orderedNodes
    .filter((node) =>
      (node.localName === kind.oppositeTypeLocalName && namespaceIndex.namespaceOf(node) === UBL_CBC_NAMESPACE) ||
      (node.localName === kind.oppositeLineLocalName && namespaceIndex.namespaceOf(node) === UBL_CAC_NAMESPACE) ||
      (node.localName === kind.oppositeQuantityLocalName && namespaceIndex.namespaceOf(node) === UBL_CBC_NAMESPACE)
    )
    .map((node) => namespaceIndex.pathOf(node));
  if (oppositeElementPaths.length) {
    return makeRefusal(
      'document_kind_mismatch',
      'The root and root-specific PINT billing elements belong to different document kinds.',
      {
        expectedKind: documentKind,
        foundKind: kind.oppositeKind,
        elementPaths: oppositeElementPaths
      }
    );
  }

  const customizationNodes = childrenIn(
    root, namespaceIndex, UBL_CBC_NAMESPACE, 'CustomizationID'
  );
  const customizationFound = customizationNodes[0]
    ? rawText(customizationNodes[0])
    : null;
  if (customizationFound !== PINT_AE_CUSTOMIZATION_ID) {
    return makeRefusal(
      'not_pint_ae',
      'The billing document does not declare the exact PINT AE customization.',
      {
        path: 'cbc:CustomizationID',
        expected: PINT_AE_CUSTOMIZATION_ID,
        found: customizationFound
      }
    );
  }

  const profileNodes = childrenIn(root, namespaceIndex, UBL_CBC_NAMESPACE, 'ProfileID');
  const profileFound = profileNodes[0] ? rawText(profileNodes[0]) : null;
  if (profileFound !== PINT_AE_PROFILE_ID) {
    return makeRefusal(
      'not_pint_ae',
      'The billing document does not declare the exact PINT billing profile.',
      {
        path: 'cbc:ProfileID',
        expected: PINT_AE_PROFILE_ID,
        found: profileFound
      }
    );
  }

  const duplicatePaths = [];
  const missingPaths = [];
  const duplicateSet = new Set();
  const missingSet = new Set();
  const decimalFields = [];

  const addDuplicate = (canonicalPath) => {
    if (!duplicateSet.has(canonicalPath)) {
      duplicateSet.add(canonicalPath);
      duplicatePaths.push(canonicalPath);
    }
  };
  const addMissing = (canonicalPath) => {
    if (!missingSet.has(canonicalPath)) {
      missingSet.add(canonicalPath);
      missingPaths.push(canonicalPath);
    }
  };
  const singleton = (
    parent,
    namespaceUri,
    localName,
    canonicalPath,
    { required = true } = {}
  ) => {
    const nodes = childrenIn(parent, namespaceIndex, namespaceUri, localName);
    if (nodes.length > 1) addDuplicate(canonicalPath);
    const node = nodes[0] || null;
    // Aggregate components are structural containers and legitimately have no
    // direct text. Basic components are the consumed scalar singletons whose
    // mandatory occurrences must also contain non-whitespace text.
    if (
      required &&
      (!node || (namespaceUri === UBL_CBC_NAMESPACE && !isNonEmptyString(rawText(node))))
    ) {
      addMissing(canonicalPath);
    }
    return node;
  };
  const group = (parent, namespaceUri, localName, canonicalPath, { required = true } = {}) => {
    const nodes = childrenIn(parent, namespaceIndex, namespaceUri, localName);
    if (required && nodes.length === 0) addMissing(canonicalPath);
    return nodes;
  };
  const decimal = (node, canonicalPath) => {
    if (node) decimalFields.push({ node, canonicalPath });
    return node;
  };

  // Root singleton order is the fixed refusal-detail order.
  singleton(root, UBL_CBC_NAMESPACE, 'CustomizationID', 'cbc:CustomizationID');
  singleton(root, UBL_CBC_NAMESPACE, 'ProfileID', 'cbc:ProfileID');
  const documentNumberNode = singleton(root, UBL_CBC_NAMESPACE, 'ID', 'cbc:ID');
  const issueDateNode = singleton(root, UBL_CBC_NAMESPACE, 'IssueDate', 'cbc:IssueDate');
  const dueDateNode = singleton(
    root, UBL_CBC_NAMESPACE, 'DueDate', 'cbc:DueDate', { required: false }
  );
  const typeCodeNode = singleton(
    root, UBL_CBC_NAMESPACE, kind.typeLocalName, `cbc:${kind.typeLocalName}`
  );
  const currencyNode = singleton(
    root, UBL_CBC_NAMESPACE, 'DocumentCurrencyCode', 'cbc:DocumentCurrencyCode'
  );
  const taxCurrencyNode = singleton(
    root, UBL_CBC_NAMESPACE, 'TaxCurrencyCode', 'cbc:TaxCurrencyCode', { required: false }
  );

  const supplierWrapper = singleton(
    root, UBL_CAC_NAMESPACE, 'AccountingSupplierParty', 'cac:AccountingSupplierParty'
  );
  const supplierParty = singleton(
    supplierWrapper, UBL_CAC_NAMESPACE, 'Party',
    'cac:AccountingSupplierParty/cac:Party'
  );
  const supplierLegal = singleton(
    supplierParty, UBL_CAC_NAMESPACE, 'PartyLegalEntity',
    'cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity'
  );
  const supplierNameNode = singleton(
    supplierLegal, UBL_CBC_NAMESPACE, 'RegistrationName',
    'cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'
  );
  const supplierTaxSchemes = childrenIn(
    supplierParty, namespaceIndex, UBL_CAC_NAMESPACE, 'PartyTaxScheme'
  );
  const supplierTrnNodes = supplierTaxSchemes.flatMap((scheme) =>
    childrenIn(scheme, namespaceIndex, UBL_CBC_NAMESPACE, 'CompanyID')
  );
  const supplierTrnPath =
    'cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID';
  if (supplierTrnNodes.length > 1) addDuplicate(supplierTrnPath);
  if (supplierTrnNodes.length === 0 || !isNonEmptyString(rawText(supplierTrnNodes[0]))) {
    addMissing(supplierTrnPath);
  }
  const supplierTrnNode = supplierTrnNodes[0] || null;

  const buyerWrapper = singleton(
    root, UBL_CAC_NAMESPACE, 'AccountingCustomerParty', 'cac:AccountingCustomerParty'
  );
  const buyerParty = singleton(
    buyerWrapper, UBL_CAC_NAMESPACE, 'Party',
    'cac:AccountingCustomerParty/cac:Party'
  );
  const buyerLegal = singleton(
    buyerParty, UBL_CAC_NAMESPACE, 'PartyLegalEntity',
    'cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity'
  );
  const buyerNameNode = singleton(
    buyerLegal, UBL_CBC_NAMESPACE, 'RegistrationName',
    'cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName'
  );
  const buyerTaxSchemes = childrenIn(
    buyerParty, namespaceIndex, UBL_CAC_NAMESPACE, 'PartyTaxScheme'
  );
  const buyerTrnNodes = buyerTaxSchemes.flatMap((scheme) =>
    childrenIn(scheme, namespaceIndex, UBL_CBC_NAMESPACE, 'CompanyID')
  );
  const buyerTrnPath =
    'cac:AccountingCustomerParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID';
  if (buyerTrnNodes.length > 1) addDuplicate(buyerTrnPath);
  const buyerTrnNode = buyerTrnNodes[0] || null;
  if (buyerTrnNode && !isNonEmptyString(rawText(buyerTrnNode))) addMissing(buyerTrnPath);

  const taxTotals = group(root, UBL_CAC_NAMESPACE, 'TaxTotal', 'cac:TaxTotal');
  const breakdownBearingTaxTotals = taxTotals.filter(
    (taxTotal) => childrenIn(
      taxTotal, namespaceIndex, UBL_CAC_NAMESPACE, 'TaxSubtotal'
    ).length > 0
  );
  if (breakdownBearingTaxTotals.length > 1) addDuplicate('cac:TaxTotal[primary]');
  const primaryTaxTotal = breakdownBearingTaxTotals[0] || taxTotals[0] || null;
  const secondaryTaxTotals = taxTotals.filter((taxTotal) => taxTotal !== primaryTaxTotal);
  if (secondaryTaxTotals.length > 1) addDuplicate('cac:TaxTotal[secondary]');
  const primaryTaxAmountNode = decimal(singleton(
    primaryTaxTotal, UBL_CBC_NAMESPACE, 'TaxAmount', 'cac:TaxTotal/cbc:TaxAmount'
  ), 'cac:TaxTotal/cbc:TaxAmount');
  const secondaryTaxAmountNode = secondaryTaxTotals[0]
    ? decimal(singleton(
      secondaryTaxTotals[0], UBL_CBC_NAMESPACE, 'TaxAmount',
      'cac:TaxTotal[secondary]/cbc:TaxAmount'
    ), 'cac:TaxTotal[secondary]/cbc:TaxAmount')
    : null;

  const legalTotal = singleton(
    root, UBL_CAC_NAMESPACE, 'LegalMonetaryTotal', 'cac:LegalMonetaryTotal'
  );
  const lineTotalNode = decimal(singleton(
    legalTotal, UBL_CBC_NAMESPACE, 'LineExtensionAmount',
    'cac:LegalMonetaryTotal/cbc:LineExtensionAmount'
  ), 'cac:LegalMonetaryTotal/cbc:LineExtensionAmount');
  const subtotalNode = decimal(singleton(
    legalTotal, UBL_CBC_NAMESPACE, 'TaxExclusiveAmount',
    'cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount'
  ), 'cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount');
  const totalNode = decimal(singleton(
    legalTotal, UBL_CBC_NAMESPACE, 'TaxInclusiveAmount',
    'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount'
  ), 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount');
  const payableNode = decimal(singleton(
    legalTotal, UBL_CBC_NAMESPACE, 'PayableAmount',
    'cac:LegalMonetaryTotal/cbc:PayableAmount'
  ), 'cac:LegalMonetaryTotal/cbc:PayableAmount');

  const lineNodes = group(
    root, UBL_CAC_NAMESPACE, kind.lineLocalName, `cac:${kind.lineLocalName}`
  );
  const lineFields = lineNodes.map((lineNode, index) => {
    const base = `cac:${kind.lineLocalName}[${index + 1}]`;
    const lineIdNode = singleton(lineNode, UBL_CBC_NAMESPACE, 'ID', `${base}/cbc:ID`);
    const quantityNode = decimal(singleton(
      lineNode, UBL_CBC_NAMESPACE, kind.quantityLocalName,
      `${base}/cbc:${kind.quantityLocalName}`
    ), `${base}/cbc:${kind.quantityLocalName}`);
    const lineNetNode = decimal(singleton(
      lineNode, UBL_CBC_NAMESPACE, 'LineExtensionAmount',
      `${base}/cbc:LineExtensionAmount`
    ), `${base}/cbc:LineExtensionAmount`);
    const itemNode = singleton(lineNode, UBL_CAC_NAMESPACE, 'Item', `${base}/cac:Item`);
    const descriptionNode = singleton(
      itemNode, UBL_CBC_NAMESPACE, 'Name', `${base}/cac:Item/cbc:Name`
    );
    const categoryNode = singleton(
      itemNode, UBL_CAC_NAMESPACE, 'ClassifiedTaxCategory',
      `${base}/cac:Item/cac:ClassifiedTaxCategory`
    );
    const categoryIdNode = singleton(
      categoryNode, UBL_CBC_NAMESPACE, 'ID',
      `${base}/cac:Item/cac:ClassifiedTaxCategory/cbc:ID`
    );
    const rateRequired = rawText(categoryIdNode) === 'S';
    const rateNode = decimal(singleton(
      categoryNode, UBL_CBC_NAMESPACE, 'Percent',
      `${base}/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent`,
      { required: rateRequired }
    ), `${base}/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent`);
    const priceNode = singleton(lineNode, UBL_CAC_NAMESPACE, 'Price', `${base}/cac:Price`);
    const unitPriceNode = decimal(singleton(
      priceNode, UBL_CBC_NAMESPACE, 'PriceAmount', `${base}/cac:Price/cbc:PriceAmount`
    ), `${base}/cac:Price/cbc:PriceAmount`);
    return {
      linePosition: index + 1,
      lineIdNode,
      descriptionNode,
      quantityNode,
      unitPriceNode,
      lineNetNode,
      categoryIdNode,
      rateNode,
      unitPricePath: `${base}/cac:Price/cbc:PriceAmount`
    };
  });

  const subtotalNodes = group(
    primaryTaxTotal, UBL_CAC_NAMESPACE, 'TaxSubtotal',
    'cac:TaxTotal/cac:TaxSubtotal'
  );
  const breakdownFields = subtotalNodes.map((subtotalGroup, index) => {
    const base = `cac:TaxTotal/cac:TaxSubtotal[${index + 1}]`;
    const taxableAmountNode = decimal(singleton(
      subtotalGroup, UBL_CBC_NAMESPACE, 'TaxableAmount', `${base}/cbc:TaxableAmount`
    ), `${base}/cbc:TaxableAmount`);
    const taxAmountNode = decimal(singleton(
      subtotalGroup, UBL_CBC_NAMESPACE, 'TaxAmount', `${base}/cbc:TaxAmount`
    ), `${base}/cbc:TaxAmount`);
    const categoryNode = singleton(
      subtotalGroup, UBL_CAC_NAMESPACE, 'TaxCategory', `${base}/cac:TaxCategory`
    );
    const categoryIdNode = singleton(
      categoryNode, UBL_CBC_NAMESPACE, 'ID', `${base}/cac:TaxCategory/cbc:ID`
    );
    const rateRequired = rawText(categoryIdNode) === 'S';
    const rateNode = decimal(singleton(
      categoryNode, UBL_CBC_NAMESPACE, 'Percent', `${base}/cac:TaxCategory/cbc:Percent`,
      { required: rateRequired }
    ), `${base}/cac:TaxCategory/cbc:Percent`);
    return {
      position: index + 1,
      taxableAmountNode,
      taxAmountNode,
      categoryIdNode,
      rateNode
    };
  });

  const precedingInvoiceReferenceIds = [];
  if (documentKind === 'credit_note') {
    const billingReferences = childrenIn(
      root, namespaceIndex, UBL_CAC_NAMESPACE, 'BillingReference'
    );
    billingReferences.forEach((billingReference, index) => {
      const base = `cac:BillingReference[${index + 1}]`;
      const invoiceReference = singleton(
        billingReference, UBL_CAC_NAMESPACE, 'InvoiceDocumentReference',
        `${base}/cac:InvoiceDocumentReference`
      );
      const idNode = singleton(
        invoiceReference, UBL_CBC_NAMESPACE, 'ID',
        `${base}/cac:InvoiceDocumentReference/cbc:ID`
      );
      if (idNode && isNonEmptyString(rawText(idNode))) {
        precedingInvoiceReferenceIds.push(text(idNode));
      }
    });
    const seenReferenceIds = new Set();
    for (const referenceId of precedingInvoiceReferenceIds) {
      if (seenReferenceIds.has(referenceId)) {
        addDuplicate('cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID');
      }
      seenReferenceIds.add(referenceId);
    }
  }

  if (duplicatePaths.length) {
    return makeRefusal(
      'duplicate_mandatory',
      'A singleton PINT AE element or reference occurs more than once.',
      { paths: duplicatePaths }
    );
  }
  if (missingPaths.length) {
    return makeRefusal(
      'missing_mandatory',
      'One or more mandatory PINT AE elements are missing or empty.',
      { paths: missingPaths }
    );
  }

  const decimalValues = new WeakMap();
  const invalidDecimals = [];
  for (const field of decimalFields) {
    const parsed = parseDecimal(field.node, field.canonicalPath);
    if (!parsed.ok) invalidDecimals.push(parsed.detail);
    else decimalValues.set(field.node, parsed.value);
  }
  if (invalidDecimals.length) {
    return makeRefusal(
      'invalid_decimal',
      'A consumed PINT AE decimal has an invalid or unsafe lexical value.',
      { values: invalidDecimals }
    );
  }

  const typeCode = rawText(typeCodeNode);
  const oppositeTypeCodes = DOCUMENT_KINDS[kind.oppositeKind].allowedTypeCodes;
  if (oppositeTypeCodes.includes(typeCode)) {
    return makeRefusal(
      'document_kind_mismatch',
      'The root-specific type code belongs to the opposite billing-document kind.',
      {
        expectedKind: documentKind,
        foundKind: kind.oppositeKind,
        elementPaths: [`cbc:${kind.typeLocalName}`]
      }
    );
  }
  if (!kind.allowedTypeCodes.includes(typeCode)) {
    return makeRefusal(
      'invalid_document_type_code',
      'The billing-document type code is outside the supported PINT AE lane.',
      {
        path: `cbc:${kind.typeLocalName}`,
        value: typeCode,
        allowed: kind.allowedTypeCodes
      }
    );
  }

  let creditNoteReason = null;
  if (documentKind === 'credit_note') {
    const responseGroups = childrenIn(
      root, namespaceIndex, UBL_CAC_NAMESPACE, 'DiscrepancyResponse'
    );
    const reasonNodes = responseGroups.flatMap((groupNode) =>
      childrenIn(groupNode, namespaceIndex, UBL_CBC_NAMESPACE, 'ResponseCode')
    );
    const reasonValues = reasonNodes.map((node) => rawText(node));
    const reasonCode = reasonValues[0] ?? null;
    if (
      responseGroups.length !== 1 ||
      reasonNodes.length !== 1 ||
      !isNonEmptyString(reasonCode) ||
      !Object.prototype.hasOwnProperty.call(PINT_AE_CREDIT_NOTE_REASONS, reasonCode)
    ) {
      return makeRefusal(
        'invalid_credit_note_reason',
        'The CreditNote must carry exactly one current PINT AE credit reason code.',
        {
          path: 'cac:DiscrepancyResponse/cbc:ResponseCode',
          groupCount: responseGroups.length,
          codeCount: reasonNodes.length,
          found: reasonValues,
          allowed: Object.keys(PINT_AE_CREDIT_NOTE_REASONS)
        }
      );
    }
    creditNoteReason = {
      code: reasonCode,
      label: PINT_AE_CREDIT_NOTE_REASONS[reasonCode]
    };
  }

  const supplierTrn = text(supplierTrnNode);
  if (!isValidAeTrn(supplierTrn)) {
    return makeRefusal(
      'invalid_supplier_trn',
      'The supplier TRN is not a structurally valid 15-digit FTA TRN.',
      { path: supplierTrnPath, value: supplierTrn }
    );
  }
  const buyerTrn = buyerTrnNode ? text(buyerTrnNode) : null;
  if (buyerTrn && !isValidAeTrn(buyerTrn)) {
    return makeRefusal(
      'invalid_buyer_trn',
      'The buyer TRN is present but is not a structurally valid 15-digit FTA TRN.',
      { path: buyerTrnPath, value: buyerTrn }
    );
  }

  const badVatCategories = [];
  for (const line of lineFields) {
    const value = rawText(line.categoryIdNode);
    if (!AE_VAT_CATEGORY_CODES.includes(value)) {
      badVatCategories.push({
        path: `cac:${kind.lineLocalName}[${line.linePosition}]/cac:Item/cac:ClassifiedTaxCategory/cbc:ID`,
        value
      });
    }
  }
  for (const breakdown of breakdownFields) {
    const value = rawText(breakdown.categoryIdNode);
    if (!AE_VAT_CATEGORY_CODES.includes(value)) {
      badVatCategories.push({
        path: `cac:TaxTotal/cac:TaxSubtotal[${breakdown.position}]/cac:TaxCategory/cbc:ID`,
        value
      });
    }
  }
  if (badVatCategories.length) {
    return makeRefusal(
      'invalid_vat_category',
      'A VAT category code is outside the closed AE category set.',
      { allowed: AE_VAT_CATEGORY_CODES, found: badVatCategories }
    );
  }

  const sourceLines = lineFields.map((line) => ({
    linePosition: line.linePosition,
    lineId: text(line.lineIdNode),
    description: text(line.descriptionNode),
    quantity: decimalValues.get(line.quantityNode),
    unitPrice: decimalValues.get(line.unitPriceNode),
    lineNet: decimalValues.get(line.lineNetNode),
    vatCategory: rawText(line.categoryIdNode),
    vatRatePercent: line.rateNode ? decimalValues.get(line.rateNode) : null
  }));
  const sourceVatBreakdown = breakdownFields.map((breakdown) => ({
    category: rawText(breakdown.categoryIdNode),
    ratePercent: breakdown.rateNode ? decimalValues.get(breakdown.rateNode) : null,
    taxableAmount: decimalValues.get(breakdown.taxableAmountNode),
    taxAmount: decimalValues.get(breakdown.taxAmountNode)
  }));
  const sourceTotalRawValues = {
    lineTotal: decimalValues.get(lineTotalNode),
    subtotal: decimalValues.get(subtotalNode),
    vatTotal: decimalValues.get(primaryTaxAmountNode),
    vatTotalInTaxCurrency: secondaryTaxAmountNode
      ? decimalValues.get(secondaryTaxAmountNode)
      : null,
    total: decimalValues.get(totalNode),
    payable: decimalValues.get(payableNode)
  };
  const sourceTotals = Object.fromEntries(
    Object.entries(sourceTotalRawValues).map(([field, value]) => [
      field,
      value == null ? null : round2(value)
    ])
  );

  const signIssues = [];
  for (const line of lineFields) {
    const unitPrice = decimalValues.get(line.unitPriceNode);
    if (unitPrice <= 0) {
      signIssues.push({ path: line.unitPricePath, value: unitPrice, rule: 'positive_rate' });
    }
  }
  const totalSourcePaths = {
    lineTotal: 'cac:LegalMonetaryTotal/cbc:LineExtensionAmount',
    subtotal: 'cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount',
    vatTotal: 'cac:TaxTotal/cbc:TaxAmount',
    vatTotalInTaxCurrency: 'cac:TaxTotal[secondary]/cbc:TaxAmount',
    total: 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount',
    payable: 'cac:LegalMonetaryTotal/cbc:PayableAmount'
  };
  for (const [field, value] of Object.entries(sourceTotalRawValues)) {
    if (value != null && value < 0) {
      signIssues.push({
        path: totalSourcePaths[field],
        value,
        rule: 'non_negative_document_total'
      });
    }
  }
  const anyAggregateValue = Object.values(sourceTotalRawValues).some(
    (value) => value != null && value !== 0
  );
  if (anyAggregateValue && sourceTotalRawValues.total === 0) {
    signIssues.push({
      path: totalSourcePaths.total,
      value: sourceTotals.total,
      rule: 'positive_non_zero_document_total'
    });
  }
  if (signIssues.length) {
    return makeRefusal(
      'invalid_monetary_sign',
      'The PINT AE source economics contain an invalid aggregate or price sign.',
      { values: signIssues }
    );
  }

  const mismatches = [];
  if (round2(sourceTotals.subtotal + sourceTotals.vatTotal) !== sourceTotals.total) {
    mismatches.push(
      `subtotal (${sourceTotals.subtotal}) + VAT (${sourceTotals.vatTotal}) != total (${sourceTotals.total})`
    );
  }
  const lineSum = round2(sourceLines.reduce((sum, line) => sum + line.lineNet, 0));
  if (lineSum !== sourceTotals.lineTotal) {
    mismatches.push(
      `line net sum (${lineSum}) != line extension total (${sourceTotals.lineTotal})`
    );
  }
  const breakdownVat = round2(
    sourceVatBreakdown.reduce((sum, breakdown) => sum + breakdown.taxAmount, 0)
  );
  if (breakdownVat !== sourceTotals.vatTotal) {
    mismatches.push(
      `VAT breakdown sum (${breakdownVat}) != VAT total (${sourceTotals.vatTotal})`
    );
  }
  if (mismatches.length) {
    return makeRefusal(
      'amount_mismatch',
      'The numbers on this PINT AE billing document do not foot.',
      { mismatches }
    );
  }

  // Warnings preserve the former valid-Invoice order. They are emitted only
  // after every refusal gate, so a refusal can never carry extracted data.
  const warnings = [];
  for (const breakdown of sourceVatBreakdown) {
    if (breakdown.ratePercent == null) continue;
    const computed = round2((breakdown.taxableAmount * breakdown.ratePercent) / 100);
    const drift = computed - breakdown.taxAmount;
    if (drift > 0.01 || drift < -0.01) {
      warnings.push(
        `VAT breakdown ${breakdown.category}: ${breakdown.taxableAmount} × ${breakdown.ratePercent}% = ${computed}, declared ${breakdown.taxAmount}`
      );
    }
  }
  for (const line of sourceLines) {
    if (line.vatCategory === 'S' && line.vatRatePercent !== AE_VAT_STANDARD_RATE) {
      warnings.push(
        `line ${line.linePosition}: standard rated at ${line.vatRatePercent}%, expected ${AE_VAT_STANDARD_RATE}%`
      );
    }
  }
  if (sourceTotals.payable !== sourceTotals.total) {
    warnings.push(
      `payable amount (${sourceTotals.payable}) differs from tax-inclusive total (${sourceTotals.total}) — prepaid/rounding elements are outside this bounded parser`
    );
  }
  const currency = text(currencyNode);
  const taxCurrency = taxCurrencyNode ? text(taxCurrencyNode) : null;
  if (currency !== 'AED' && !taxCurrency) {
    warnings.push(
      `invoice currency is ${currency} with no TaxCurrencyCode — expected AED VAT reporting amounts`
    );
  }
  if (taxCurrency && taxCurrency !== 'AED') {
    warnings.push(`tax currency is ${taxCurrency}, expected AED`);
  }

  const canonicalLines = sourceLines.map((line) => ({
    ...line,
    quantity: kindSigned(documentKind, line.quantity),
    lineNet: kindSigned(documentKind, line.lineNet)
  }));
  const canonicalTotals = Object.fromEntries(
    Object.entries(sourceTotals).map(([field, value]) => [
      field,
      kindSigned(documentKind, value)
    ])
  );
  const canonicalVatBreakdown = sourceVatBreakdown.map((breakdown) => ({
    ...breakdown,
    taxableAmount: kindSigned(documentKind, breakdown.taxableAmount),
    taxAmount: kindSigned(documentKind, breakdown.taxAmount)
  }));
  const sourceEconomics = {
    lines: sourceLines.map((line) => ({
      linePosition: line.linePosition,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineNet: line.lineNet
    })),
    totals: sourceTotals,
    vatBreakdown: sourceVatBreakdown.map((breakdown) => ({
      category: breakdown.category,
      ratePercent: breakdown.ratePercent,
      taxableAmount: breakdown.taxableAmount,
      taxAmount: breakdown.taxAmount
    }))
  };

  const document = deepFreeze({
    schema: 'pint-ae-ubl',
    validationAssurance: 'bounded_application',
    documentKind,
    customizationId: PINT_AE_CUSTOMIZATION_ID,
    profileId: PINT_AE_PROFILE_ID,
    documentNumber: text(documentNumberNode),
    typeCode,
    issueDate: text(issueDateNode),
    dueDate: dueDateNode ? text(dueDateNode) : null,
    currency,
    taxCurrency,
    supplier: { name: text(supplierNameNode), trn: supplierTrn },
    buyer: { name: text(buyerNameNode), trn: buyerTrn },
    creditNoteReason,
    precedingInvoiceReferences: documentKind === 'credit_note'
      ? precedingInvoiceReferenceIds
      : [],
    lines: canonicalLines,
    totals: canonicalTotals,
    vatBreakdown: canonicalVatBreakdown,
    sourceEconomics
  });

  return deepFreeze({ ok: true, warnings, document });
};

// Root-neutral entry point. Document kind comes only from the exact expanded
// root name and is immutable in the returned normalized document.
export const parsePintAeBillingDocument = ({ xml } = {}) =>
  parseBillingDocument({ xml });

const wrapperFailure = (result, field) => deepFreeze({
  ok: false,
  refusal: result.refusal,
  warnings: result.warnings,
  [field]: null
});

// Backward-compatible Invoice-only envelope. It intentionally has no second
// `document` alias and adds only the approved compatibility fields to the
// formerly valid Invoice shape.
export const parsePintAeInvoice = ({ xml } = {}) => {
  const result = parseBillingDocument({ xml }, 'invoice');
  if (!result.ok) return wrapperFailure(result, 'invoice');
  const document = result.document;
  const invoice = deepFreeze({
    schema: document.schema,
    validationAssurance: document.validationAssurance,
    documentKind: document.documentKind,
    customizationId: document.customizationId,
    profileId: document.profileId,
    invoiceNumber: document.documentNumber,
    typeCode: document.typeCode,
    issueDate: document.issueDate,
    dueDate: document.dueDate,
    currency: document.currency,
    taxCurrency: document.taxCurrency,
    supplier: document.supplier,
    buyer: document.buyer,
    lines: document.lines,
    totals: document.totals,
    vatBreakdown: document.vatBreakdown,
    sourceEconomics: document.sourceEconomics
  });
  return deepFreeze({ ok: true, warnings: result.warnings, invoice });
};

// Symmetric CreditNote-only envelope. The root-neutral documentNumber name is
// retained because a CreditNote is not an Invoice.
export const parsePintAeCreditNote = ({ xml } = {}) => {
  const result = parseBillingDocument({ xml }, 'credit_note');
  if (!result.ok) return wrapperFailure(result, 'creditNote');
  return deepFreeze({ ok: true, warnings: result.warnings, creditNote: result.document });
};
