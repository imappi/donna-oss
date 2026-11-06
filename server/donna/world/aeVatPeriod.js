import { validateAeEntityTaxContextWorld } from './aeEntityTaxContext.js';
import { validateWorldSpec } from './worldSchema.js';
import { utcIsoDay } from './utcDay.js';

export const AE_VAT_PERIOD_WORLD_VERSION = 'ae.vat-period-world.v1';

const TRN = /^\d{15}$/;
const EMIRATES = new Set(['AUH', 'DXB', 'SHJ', 'AJM', 'UAQ', 'RAK', 'FUJ']);
const DOCUMENT_TYPES = new Set([
  'full_tax_invoice',
  'simplified_tax_invoice',
  'tax_credit_note',
  'deposit_tax_invoice',
  'imported_service_invoice',
  'customs_import_declaration',
]);
const LANE_BY_TYPE = Object.freeze({
  full_tax_invoice: new Set(['domestic_sale', 'domestic_purchase']),
  simplified_tax_invoice: new Set(['domestic_sale', 'domestic_purchase']),
  tax_credit_note: new Set(['domestic_sale', 'domestic_purchase']),
  deposit_tax_invoice: new Set(['domestic_sale']),
  imported_service_invoice: new Set(['imported_service_rcm']),
  customs_import_declaration: new Set(['customs_declared_goods']),
});
const RECOVERY_BASES = new Set(['direct_taxable', 'direct_exempt', 'residual_standard_method', 'blocked']);
const SOURCE_KINDS = new Set(['tax_invoice', 'tax_credit_note', 'deposit_tax_invoice', 'foreign_supplier_invoice', 'customs_import_declaration']);

export function evaluateAeVatPeriodWorld(worldSpec) {
  const errors = [];
  const shape = validateWorldSpec(worldSpec);
  if (!shape.ok) {
    for (const message of shape.errors) add(errors, 'AE_VAT_WORLD_SCHEMA_INVALID', 'worldSpec', message);
    return result(errors);
  }
  if (worldSpec.manifest.jurisdiction !== 'AE') {
    add(errors, 'AE_VAT_JURISDICTION_REQUIRED', 'manifest.jurisdiction', 'AE VAT period worlds require jurisdiction AE.');
  }
  if (worldSpec.manifest.capabilityId !== 'prepare_ae_vat_period') {
    add(errors, 'AE_VAT_PERIOD_CAPABILITY_REQUIRED', 'manifest.capabilityId', 'Expected prepare_ae_vat_period.');
  }

  const contextResult = validateAeEntityTaxContextWorld(worldSpec);
  for (const error of contextResult.errors || []) errors.push(error);
  const context = contextResult.contexts?.[0] || null;
  if ((contextResult.contexts?.length || 0) !== 1) {
    add(errors, 'AE_VAT_SINGLE_ENTITY_REQUIRED', 'entities', 'A VAT period world must contain exactly one resolved entity context.');
  }

  const artifacts = new Map((worldSpec.artifacts || []).map((artifact) => [artifact.id, artifact]));
  const policySources = new Map((worldSpec.policySources || []).map((source) => [source.id, source]));
  const observed = new Map();
  for (const observation of worldSpec.observations || []) {
    if (observation.artifactId && (!observed.has(observation.artifactId) || observation.observedAt < observed.get(observation.artifactId))) {
      observed.set(observation.artifactId, observation.observedAt);
    }
  }

  const periodKey = text(worldSpec.vatPeriodKey);
  const period = context?.ftaVatPeriods?.find((entry) => entry.periodKey === periodKey) || null;
  if (!periodKey || !period) {
    add(errors, 'AE_VAT_RECORDED_PERIOD_REQUIRED', 'vatPeriodKey', 'The world must select an exact FTA-assigned period recorded on the entity.');
  }
  if (period && worldSpec.returnDueOn !== period.dueOn) {
    add(errors, 'AE_VAT_DUE_DATE_NOT_RECORDED', 'returnDueOn', 'The due date must equal the recorded FTA period due date; it must not be inferred from cadence.');
  }

  const documents = Array.isArray(worldSpec.vatDocuments) ? worldSpec.vatDocuments : [];
  if (documents.length === 0) add(errors, 'AE_VAT_DOCUMENTS_REQUIRED', 'vatDocuments', 'At least one VAT document is required.');
  const ids = new Set();
  const accepted = [];
  for (const [index, document] of documents.entries()) {
    const path = document?.id ? `vatDocuments.${document.id}` : `vatDocuments[${index}]`;
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      add(errors, 'AE_VAT_DOCUMENT_INVALID', path, 'VAT documents must be objects.');
      continue;
    }
    if (!text(document.id) || ids.has(document.id)) {
      add(errors, ids.has(document.id) ? 'AE_VAT_DOCUMENT_ID_DUPLICATE' : 'AE_VAT_DOCUMENT_ID_REQUIRED', `${path}.id`, 'Each VAT document requires a unique id.');
      continue;
    }
    ids.add(document.id);
    const before = errors.length;
    validateEvidence(document, path, { artifacts, observed, effectiveDate: worldSpec.effectiveDate, errors });
    validateDocument(document, path, { documents, period, context, policySources, errors });
    if (errors.length === before) accepted.push(document);
  }

  validateCrossDocumentReferences(documents, errors);
  const projection = projectDocuments(accepted);
  const expectedJournalLines = accepted.flatMap(expectedJournalForDocument);
  validateCandidateJournal({
    candidateLines: worldSpec.candidateJournalLines,
    expectedLines: expectedJournalLines,
    knownDocumentIds: ids,
    errors,
  });

  return result(errors, {
    period: period ? clone(period) : null,
    entityId: context?.entityId || null,
    establishmentEmirate: context?.freeZoneStanding?.emirate || null,
    projection,
    expectedJournalLines,
  });
}

export function projectAeVatDocuments(documents = []) {
  return projectDocuments(documents);
}

function validateEvidence(document, path, { artifacts, observed, effectiveDate, errors }) {
  const artifact = artifacts.get(document.sourceArtifactId);
  if (!artifact) {
    add(errors, 'AE_VAT_DOCUMENT_SOURCE_REQUIRED', `${path}.sourceArtifactId`, 'Every document fact requires a source artifact.');
    return;
  }
  if (!SOURCE_KINDS.has(artifact.kind)) {
    add(errors, 'AE_VAT_DOCUMENT_SOURCE_KIND_INVALID', `${path}.sourceArtifactId`, 'The source artifact kind does not support this VAT document.');
  }
  const observedAt = observed.get(document.sourceArtifactId);
  if (!observedAt || observedAt > effectiveDate) {
    add(errors, 'AE_VAT_DOCUMENT_NOT_OBSERVED', `${path}.sourceArtifactId`, 'The source artifact must be observed by the world effective date.');
  }
  if (artifact.fields?.documentId && artifact.fields.documentId !== document.id) {
    add(errors, 'AE_VAT_DOCUMENT_IDENTITY_MISMATCH', `${path}.sourceArtifactId`, 'The artifact document identity must match the structured VAT fact.');
  }
}

function validateDocument(document, path, { period, context, policySources, errors }) {
  if (!DOCUMENT_TYPES.has(document.documentType)) {
    add(errors, 'AE_VAT_DOCUMENT_TYPE_UNSUPPORTED', `${path}.documentType`, 'The document type is outside the AE-2 contract.');
    return;
  }
  if (!LANE_BY_TYPE[document.documentType].has(document.lane)) {
    add(errors, 'AE_VAT_IMPORT_LANE_MISMATCH', `${path}.lane`, 'Document family and VAT lane disagree; customs goods and imported services must remain separate.');
  }
  const policySource = policySources.get(document.policySourceId);
  if (!text(document.policySourceId) || !policySource) {
    add(errors, 'AE_VAT_DOCUMENT_POLICY_REQUIRED', `${path}.policySourceId`, 'A load-bearing VAT document needs a policy source present in this world.');
  }

  const reportDate = document.documentType === 'tax_credit_note' ? document.issueDate : document.dateOfSupply;
  if (policySource && isoDay(reportDate)
    && (policySource.effectiveFrom > reportDate || policySource.asOf < reportDate)) {
    add(errors, 'AE_VAT_POLICY_NOT_EFFECTIVE', `${path}.policySourceId`, 'The cited policy source must cover the document tax point.');
  }
  if (!isoDay(document.issueDate) || !isoDay(document.dateOfSupply)) {
    add(errors, 'AE_VAT_DOCUMENT_DATES_REQUIRED', path, 'Issue date and date of supply must be ISO days.');
  } else if (period && (reportDate < period.startsOn || reportDate > period.endsOn)) {
    add(errors, 'AE_VAT_DOCUMENT_OUTSIDE_PERIOD', path, 'The document tax point must fall inside the selected recorded FTA period.');
  }

  const taxable = money(document.taxableAmountAed);
  const vat = money(document.vatAmountAed);
  const gross = money(document.grossAmountAed);
  if ([taxable, vat, gross].some((value) => value === null)) {
    add(errors, 'AE_VAT_DOCUMENT_MONEY_INVALID', path, 'AED taxable, VAT and gross amounts require exact two-decimal strings.');
  } else {
    const credit = document.documentType === 'tax_credit_note';
    if ((!credit && (taxable < 0n || vat < 0n || gross < 0n)) || (credit && (taxable >= 0n || vat >= 0n || gross >= 0n))) {
      add(errors, 'AE_VAT_DOCUMENT_SIGN_INVALID', path, 'Invoices are non-negative and tax credit notes are negative adjustments.');
    }
    if (taxable + vat !== gross) add(errors, 'AE_VAT_DOCUMENT_TOTAL_MISMATCH', path, 'Taxable amount plus VAT must equal gross amount.');
    if (vat !== roundDiv(taxable * 5n, 100n)) add(errors, 'AE_VAT_DOCUMENT_RATE_MISMATCH', `${path}.vatAmountAed`, 'The pinned standard-rate document must carry exactly 5% VAT to the nearest fils.');
  }

  if (document.documentType !== 'customs_import_declaration') {
    validateParties(document, path, errors);
    if (!text(document.description)) add(errors, 'AE_VAT_DOCUMENT_DESCRIPTION_REQUIRED', `${path}.description`, 'A supplied good or service description is required.');
  }
  if (['full_tax_invoice', 'simplified_tax_invoice', 'deposit_tax_invoice'].includes(document.documentType)
    && document.title !== 'Tax Invoice') {
    add(errors, 'AE_VAT_TAX_INVOICE_TITLE_REQUIRED', `${path}.title`, 'The phrase Tax Invoice must be displayed.');
  }
  if (document.documentType === 'tax_credit_note') validateCreditNote(document, path, errors);
  if (document.documentType === 'full_tax_invoice') validateFullInvoice(document, path, errors);
  if (document.documentType === 'simplified_tax_invoice') validateSimplifiedInvoice(document, path, gross, errors);
  if (document.documentType === 'deposit_tax_invoice') validateDeposit(document, path, errors);
  if (document.documentType === 'imported_service_invoice') validateImportedService(document, path, errors);
  if (document.documentType === 'customs_import_declaration') validateCustomsImport(document, path, errors);

  validateCurrency(document, path, taxable, vat, errors);
  validateRecovery(document, path, vat, errors);

  if (document.lane === 'domestic_sale') {
    if (!EMIRATES.has(document.emirate)) add(errors, 'AE_VAT_SUPPLY_EMIRATE_REQUIRED', `${path}.emirate`, 'A standard-rated domestic supply requires one of the seven emirates.');
    const established = context?.freeZoneStanding?.emirate;
    if (established && document.emirate !== established) {
      add(errors, 'AE_VAT_SUPPLY_EMIRATE_CONFLICT', `${path}.emirate`, 'This single-establishment world must use its recorded establishment emirate.');
    }
  }
}

function validateParties(document, path, errors) {
  const seller = document.seller || {};
  const buyer = document.buyer || {};
  if (!text(seller.name) || !text(seller.address)) add(errors, 'AE_VAT_SELLER_IDENTITY_REQUIRED', `${path}.seller`, 'Seller name and address are required.');
  const domesticSeller = document.lane !== 'imported_service_rcm';
  if (domesticSeller && !TRN.test(text(seller.trn))) add(errors, 'AE_VAT_SELLER_TRN_REQUIRED', `${path}.seller.trn`, 'A UAE taxable supplier requires a 15-digit TRN.');
  if (buyer.vatRegistered === true && (!text(buyer.name) || !text(buyer.address) || !TRN.test(text(buyer.trn)))) {
    add(errors, 'AE_VAT_REGISTERED_BUYER_DETAILS_REQUIRED', `${path}.buyer`, 'A VAT-registered buyer requires name, address and 15-digit TRN.');
  }
}

function validateFullInvoice(document, path, errors) {
  if (!text(document.invoiceNumber)) add(errors, 'AE_VAT_INVOICE_NUMBER_REQUIRED', `${path}.invoiceNumber`, 'A full invoice requires a sequential or unique number.');
  if (!Array.isArray(document.lines) || document.lines.length === 0) {
    add(errors, 'AE_VAT_FULL_INVOICE_LINES_REQUIRED', `${path}.lines`, 'A full invoice requires item price, quantity, VAT rate and AED amount lines.');
    return;
  }
  for (const [index, line] of document.lines.entries()) {
    if (!text(line.description) || money(line.unitPriceAed) === null || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || line.vatRatePercent !== '5.00') {
      add(errors, 'AE_VAT_FULL_INVOICE_LINE_INVALID', `${path}.lines[${index}]`, 'Each line requires description, exact AED unit price, positive integer quantity and the 5.00 VAT rate.');
    }
  }
  if (money(document.discountAed) === null) add(errors, 'AE_VAT_FULL_INVOICE_DISCOUNT_REQUIRED', `${path}.discountAed`, 'A full invoice records the discount, including 0.00.');
}

function validateSimplifiedInvoice(document, path, gross, errors) {
  if (!text(document.description)) return;
  const buyerRegistered = document.buyer?.vatRegistered === true;
  if (buyerRegistered && gross !== null && absolute(gross) > 1_000_000n) {
    add(errors, 'AE_VAT_SIMPLIFIED_INVOICE_NOT_PERMITTED', path, 'A registered recipient may receive a simplified invoice only when VAT-inclusive consideration is AED 10,000 or less.');
  }
}

function validateCreditNote(document, path, errors) {
  if (document.title !== 'Tax Credit Note') add(errors, 'AE_VAT_CREDIT_NOTE_TITLE_REQUIRED', `${path}.title`, 'The phrase Tax Credit Note must be displayed.');
  if (!text(document.originalDocumentId) || !text(document.adjustmentReason)) {
    add(errors, 'AE_VAT_CREDIT_NOTE_REFERENCE_REQUIRED', path, 'A tax credit note must identify the original supply and explain the adjustment.');
  }
}

function validateDeposit(document, path, errors) {
  if (!isoDay(document.paymentReceivedOn) || document.dateOfSupply !== document.paymentReceivedOn) {
    add(errors, 'AE_VAT_DEPOSIT_TAX_POINT_INVALID', `${path}.paymentReceivedOn`, 'A deposit received as part-payment is reported at its recorded payment tax point.');
  }
}

function validateImportedService(document, path, errors) {
  if (document.reverseCharge !== true || document.customsDeclarationNumber) {
    add(errors, 'AE_VAT_IMPORTED_SERVICE_RCM_REQUIRED', path, 'An imported service requires reverse charge and must not carry a customs goods declaration.');
  }
}

function validateCustomsImport(document, path, errors) {
  if (!text(document.customsDeclarationNumber) || document.reverseChargeLane === 'imported_service_rcm') {
    add(errors, 'AE_VAT_CUSTOMS_DECLARATION_REQUIRED', path, 'Customs-declared goods require their customs declaration and cannot use the imported-service lane.');
  }
  if (document.portalBox !== 'goods_imports') {
    add(errors, 'AE_VAT_CUSTOMS_PORTAL_BOX_INVALID', `${path}.portalBox`, 'Customs-declared goods must remain in the portal-populated goods-imports semantic field.');
  }
}

function validateCurrency(document, path, taxable, vat, errors) {
  if (document.currency === 'AED') return;
  const foreign = foreignMoney(document.foreignTaxableAmount);
  const rate = decimal(document.exchangeRate?.aedPerUnit, 6);
  if (!text(document.currency) || foreign === null || rate === null || document.exchangeRate?.authority !== 'Central Bank of the UAE'
    || document.exchangeRate?.rateDate !== document.dateOfSupply) {
    add(errors, 'AE_VAT_FX_RATE_EVIDENCE_REQUIRED', `${path}.exchangeRate`, 'Foreign-currency VAT requires the CBUAE AED rate for the date of supply and the foreign taxable amount.');
    return;
  }
  const expectedAed = roundDiv(foreign * rate, 1_000_000n);
  if (taxable !== expectedAed || vat !== roundDiv(expectedAed * 5n, 100n)) {
    add(errors, 'AE_VAT_FX_AED_MISMATCH', path, 'Foreign-currency taxable value and VAT must convert into AED using the recorded date-of-supply rate.');
  }
}

function validateRecovery(document, path, vat, errors) {
  if (!['domestic_purchase', 'imported_service_rcm', 'customs_declared_goods'].includes(document.lane)) return;
  const recovery = document.inputRecovery;
  if (!recovery || !RECOVERY_BASES.has(recovery.basis)) {
    add(errors, 'AE_VAT_INPUT_RECOVERY_BASIS_REQUIRED', `${path}.inputRecovery`, 'Input VAT requires a direct, residual or blocked recovery basis.');
    return;
  }
  let expectedBps = null;
  if (recovery.basis === 'direct_taxable') expectedBps = 10000;
  if (recovery.basis === 'direct_exempt' || recovery.basis === 'blocked') expectedBps = 0;
  if (recovery.basis === 'residual_standard_method') {
    const numerator = money(recovery.taxableUseAed);
    const denominator = money(recovery.totalUseAed);
    if (numerator === null || denominator === null || numerator < 0n || denominator <= 0n || numerator > denominator) {
      add(errors, 'AE_VAT_APPORTIONMENT_FACTS_REQUIRED', `${path}.inputRecovery`, 'Residual recovery needs exact taxable-use and total-use amounts.');
    } else if ((numerator * 10000n) % denominator !== 0n) {
      add(errors, 'AE_VAT_APPORTIONMENT_PRECISION_UNRESOLVED', `${path}.inputRecovery`, 'This deterministic fixture requires an exact basis-point ratio; a statutory rounding judgment must remain sourced, not guessed.');
    } else {
      expectedBps = Number((numerator * 10000n) / denominator);
    }
  }
  if (expectedBps !== null && recovery.recoveryBps !== expectedBps) {
    add(errors, 'AE_VAT_APPORTIONMENT_RATE_MISMATCH', `${path}.inputRecovery.recoveryBps`, 'The recovery basis does not support the recorded recovery percentage.');
  }
  const recovered = money(recovery.recoverableVatAed);
  if (vat !== null && expectedBps !== null && recovered !== roundDiv(vat * BigInt(expectedBps), 10000n)) {
    add(errors, 'AE_VAT_RECOVERABLE_AMOUNT_MISMATCH', `${path}.inputRecovery.recoverableVatAed`, 'Recoverable VAT must equal incurred VAT times the supported recovery percentage.');
  }
}

function validateCrossDocumentReferences(documents, errors) {
  const valid = documents.filter((document) => document && typeof document === 'object' && !Array.isArray(document));
  const byId = new Map(valid.map((document) => [document.id, document]));
  for (const document of valid) {
    if (document.documentType !== 'tax_credit_note') continue;
    const original = byId.get(document.originalDocumentId);
    if (!original || original.documentType === 'tax_credit_note') {
      add(errors, 'AE_VAT_CREDIT_NOTE_ORIGINAL_REQUIRED', `vatDocuments.${document.id}.originalDocumentId`, 'The credit note must reference an original invoice in this bounded world.');
    } else if (document.issueDate < original.issueDate) {
      add(errors, 'AE_VAT_CREDIT_NOTE_PRECEDES_ORIGINAL', `vatDocuments.${document.id}.issueDate`, 'A credit note cannot precede its original invoice.');
    }
  }
}

function projectDocuments(documents) {
  const emirates = Object.fromEntries([...EMIRATES].map((emirate) => [emirate, pair()]));
  const fields = {
    standard_rated_supplies: { by_emirate: emirates, total: pair() },
    reverse_charge_supplies: pair(),
    goods_imports: pair(),
    standard_rated_expenses: { amount: '0.00', recoverable_vat: '0.00' },
    reverse_charge_expenses: { amount: '0.00', recoverable_vat: '0.00', imported_services: pair(), customs_goods: pair() },
  };
  let output = 0n;
  let recoverable = 0n;
  for (const document of documents) {
    const base = money(document.taxableAmountAed) || 0n;
    const vat = money(document.vatAmountAed) || 0n;
    const recovered = money(document.inputRecovery?.recoverableVatAed) || 0n;
    if (document.lane === 'domestic_sale') {
      bumpPair(fields.standard_rated_supplies.total, base, vat);
      bumpPair(fields.standard_rated_supplies.by_emirate[document.emirate], base, vat);
      output += vat;
    } else if (document.lane === 'domestic_purchase') {
      if (recovered !== 0n) {
        fields.standard_rated_expenses.amount = format(money(fields.standard_rated_expenses.amount) + base);
        fields.standard_rated_expenses.recoverable_vat = format(money(fields.standard_rated_expenses.recoverable_vat) + recovered);
        recoverable += recovered;
      }
    } else if (document.lane === 'imported_service_rcm') {
      bumpPair(fields.reverse_charge_supplies, base, vat);
      fields.reverse_charge_expenses.amount = format(money(fields.reverse_charge_expenses.amount) + base);
      fields.reverse_charge_expenses.recoverable_vat = format(money(fields.reverse_charge_expenses.recoverable_vat) + recovered);
      bumpPair(fields.reverse_charge_expenses.imported_services, base, recovered);
      output += vat;
      recoverable += recovered;
    } else if (document.lane === 'customs_declared_goods') {
      bumpPair(fields.goods_imports, base, vat);
      fields.reverse_charge_expenses.amount = format(money(fields.reverse_charge_expenses.amount) + base);
      fields.reverse_charge_expenses.recoverable_vat = format(money(fields.reverse_charge_expenses.recoverable_vat) + recovered);
      bumpPair(fields.reverse_charge_expenses.customs_goods, base, recovered);
      output += vat;
      recoverable += recovered;
    }
  }
  return {
    currency: 'AED',
    fields,
    totals: { output_vat: format(output), recoverable_vat: format(recoverable) },
    net_vat: format(output - recoverable),
    outcome: output - recoverable < 0n ? 'refund' : 'payment',
  };
}

function expectedJournalForDocument(document) {
  const base = money(document.taxableAmountAed) || 0n;
  const vat = money(document.vatAmountAed) || 0n;
  const gross = money(document.grossAmountAed) || 0n;
  const recovered = money(document.inputRecovery?.recoverableVatAed) || 0n;
  const lines = [];
  const push = (lineKind, normalSide, value, extra = {}) => {
    if (value === 0n) return;
    const side = value < 0n ? opposite(normalSide) : normalSide;
    lines.push({
      documentId: document.id,
      lineKind,
      debitAed: side === 'debit' ? format(absolute(value)) : '0.00',
      creditAed: side === 'credit' ? format(absolute(value)) : '0.00',
      ...extra,
    });
  };
  if (document.lane === 'domestic_sale') {
    push('counterparty', 'debit', gross, { accountType: 'asset', taxType: 'NONE' });
    push('taxable_base', 'credit', base, { accountType: 'revenue', taxType: 'AE_VAT_SR_5_OUTPUT' });
    push('vat_output', 'credit', vat, { accountType: 'liability', taxType: 'NONE', role: 'vat_output' });
  } else if (document.lane === 'domestic_purchase') {
    push('taxable_base', 'debit', base, { accountType: 'expense', taxType: document.inputRecovery?.basis === 'blocked' ? 'AE_VAT_BLOCKED_INPUT' : 'AE_VAT_SR_5_INPUT' });
    push('vat_input', 'debit', recovered, { accountType: 'liability', taxType: 'NONE', role: 'vat_input_deductible' });
    push('irrecoverable_vat', 'debit', vat - recovered, { accountType: 'expense', taxType: 'AE_VAT_BLOCKED_INPUT' });
    push('counterparty', 'credit', gross, { accountType: 'liability', taxType: 'NONE' });
  } else if (document.lane === 'imported_service_rcm') {
    push('taxable_base', 'debit', base, { accountType: 'expense', taxType: 'AE_VAT_RCM_5_INPUT' });
    push('counterparty', 'credit', base, { accountType: 'liability', taxType: 'NONE' });
    push('vat_input', 'debit', recovered, { accountType: 'liability', taxType: 'NONE', role: 'vat_rcm_input' });
    push('irrecoverable_vat', 'debit', vat - recovered, { accountType: 'expense', taxType: 'AE_VAT_BLOCKED_INPUT' });
    push('vat_output', 'credit', vat, { accountType: 'liability', taxType: 'NONE', role: 'vat_rcm_output' });
  } else if (document.lane === 'customs_declared_goods') {
    push('taxable_base', 'debit', base, { accountType: 'fixed_asset', taxType: 'AE_VAT_CUSTOMS_GOODS_INPUT' });
    push('counterparty', 'credit', base, { accountType: 'liability', taxType: 'NONE' });
    push('vat_input', 'debit', recovered, { accountType: 'liability', taxType: 'NONE', role: 'vat_import_input' });
    push('irrecoverable_vat', 'debit', vat - recovered, { accountType: 'fixed_asset', taxType: 'AE_VAT_BLOCKED_INPUT' });
    push('vat_output', 'credit', vat, { accountType: 'liability', taxType: 'NONE', role: 'vat_import_output' });
  }
  return lines;
}

function validateCandidateJournal({ candidateLines, expectedLines, knownDocumentIds, errors }) {
  if (!Array.isArray(candidateLines)) {
    add(errors, 'AE_VAT_CANDIDATE_JOURNAL_REQUIRED', 'candidateJournalLines', 'The world must expose the candidate journal state.');
    return;
  }
  const lineIds = new Set();
  const validLines = [];
  for (const [index, line] of candidateLines.entries()) {
    const path = line?.id ? `candidateJournalLines.${line.id}` : `candidateJournalLines[${index}]`;
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      add(errors, 'AE_VAT_JOURNAL_LINE_INVALID', path, 'Journal lines must be objects.');
      continue;
    }
    validLines.push(line);
    if (!text(line.id) || lineIds.has(line.id)) add(errors, 'AE_VAT_JOURNAL_LINE_ID_INVALID', `${path}.id`, 'Journal line ids must be unique.');
    else lineIds.add(line.id);
    if (!knownDocumentIds.has(line?.documentId)) add(errors, 'AE_VAT_JOURNAL_DOCUMENT_UNKNOWN', `${path}.documentId`, 'Every journal line must cite a bounded VAT document.');
    if (money(line?.debitAed) === null || money(line?.creditAed) === null) add(errors, 'AE_VAT_JOURNAL_MONEY_INVALID', path, 'Journal amounts require exact AED strings.');
  }
  const actual = validLines.map(({ id: _id, ...line }) => line).sort(compareLine);
  const expected = expectedLines.map((line) => ({ ...line })).sort(compareLine);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    add(errors, 'AE_VAT_JOURNAL_MISMATCH', 'candidateJournalLines', 'Candidate journals must exactly express the VAT documents, including recoverable and irrecoverable VAT.');
  }
  const sums = new Map();
  for (const line of validLines) {
    const current = sums.get(line.documentId) || 0n;
    const debit = money(line.debitAed) || 0n;
    const credit = money(line.creditAed) || 0n;
    sums.set(line.documentId, current + debit - credit);
  }
  for (const [documentId, balance] of sums) {
    if (balance !== 0n) add(errors, 'AE_VAT_JOURNAL_UNBALANCED', `candidateJournalLines.${documentId}`, 'Every document journal must balance in AED.');
  }
}

function pair() { return { amount: '0.00', vat: '0.00' }; }
function bumpPair(target, base, vat) {
  target.amount = format(money(target.amount) + base);
  target.vat = format(money(target.vat) + vat);
}
function opposite(side) { return side === 'debit' ? 'credit' : 'debit'; }
function compareLine(left, right) {
  return [left.documentId, left.lineKind, left.debitAed, left.creditAed, left.accountType, left.taxType, left.role || '']
    .join('|').localeCompare([right.documentId, right.lineKind, right.debitAed, right.creditAed, right.accountType, right.taxType, right.role || ''].join('|'));
}
function money(value) { return decimal(value, 2); }
function foreignMoney(value) { return decimal(value, 2); }
function decimal(value, scale) {
  if (typeof value !== 'string' || !new RegExp(`^-?\\d+\\.\\d{${scale}}$`).test(value)) return null;
  const negative = value.startsWith('-');
  const raw = negative ? value.slice(1) : value;
  const [whole, fraction] = raw.split('.');
  const scaled = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(fraction);
  return negative ? -scaled : scaled;
}
function roundDiv(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  const value = absolute(numerator);
  return sign * ((value + denominator / 2n) / denominator);
}
function format(value) {
  const sign = value < 0n ? '-' : '';
  const raw = absolute(value);
  return `${sign}${raw / 100n}.${String(raw % 100n).padStart(2, '0')}`;
}
function absolute(value) { return value < 0n ? -value : value; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && utcIsoDay(parsed) === value;
}
function add(errors, code, path, message) { errors.push({ code, path, message }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function result(errors, extra = {}) {
  return { ok: errors.length === 0, version: AE_VAT_PERIOD_WORLD_VERSION, errors, ...extra };
}
