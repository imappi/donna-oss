import { createHash } from 'node:crypto';

import { validateAeEntityTaxContextWorld } from './aeEntityTaxContext.js';
import { canonicalJson } from './unitExecutionReceipt.js';
import { validateCausalWorld } from './worldValidity.js';
import { validateWorldSpec } from './worldSchema.js';

export const AE_ARABIC_PINT_EVIDENCE_VERSION = 'ae.arabic-pint-evidence.v1';

export const AE_EVIDENCE_LANES = Object.freeze({
  PINT: 'pint_ae_structured',
  REFUSED: 'structured_refused',
  ORDINARY: 'ordinary_evidence',
});

const CONTENT_CLASSES = new Set([
  'structured_xml', 'native_pdf', 'scan_image', 'email',
]);
const MEDIA_BY_CLASS = Object.freeze({
  structured_xml: new Set(['application/xml', 'text/xml']),
  native_pdf: new Set(['application/pdf']),
  scan_image: new Set(['image/svg+xml', 'image/png', 'image/jpeg']),
  email: new Set(['message/rfc822']),
});
const PRESENTATIONS = new Set(['english', 'arabic', 'bilingual']);
const DIGIT_SYSTEMS = new Set(['western', 'arabic_indic']);
const RAW_PATH = /^data\/worlds\/ae\/artifacts\/ae6\/[A-Za-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_MONEY = /^-?(?:0|[1-9]\d*)\.\d{2}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TRN = /^\d{15}$/;
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

const PROTECTED_FAILURES = Object.freeze([
  'digit_system_alters_amount_or_date',
  'bidi_control_alters_identifier',
  'copied_visual_order_used_as_logical',
  'page_order_reversed',
  'missing_font_or_shaping_receipt',
  'invoice_credit_lane_swapped',
  'malformed_structured_payload_promoted',
  'pdf_image_or_email_promoted_to_pint',
  'raw_payload_hash_mismatch',
  'language_changes_accounting',
  'cross_artifact_identity_leak',
]);

export function validateAeArabicPintEvidenceWorld(world) {
  const errors = [];
  const shape = validateWorldSpec(world);
  if (!shape.ok) {
    for (const message of shape.errors) add(errors, 'AE6_WORLD_SCHEMA_INVALID', 'worldSpec', message);
    return validation(errors);
  }
  const causal = validateCausalWorld(world);
  if (!causal.ok) {
    for (const message of causal.errors) add(errors, 'AE6_CAUSAL_WORLD_INVALID', 'worldSpec', message);
  }
  const context = validateAeEntityTaxContextWorld(world);
  if (!context.ok) errors.push(...context.errors);

  if (world.manifest.capabilityId !== 'certify_ae_arabic_pint_evidence') {
    add(errors, 'AE6_CAPABILITY_REQUIRED', 'manifest.capabilityId', 'AE-6 requires certify_ae_arabic_pint_evidence.');
  }
  if (world.manifest.maximumAuthority !== 'evidence_only_no_send') {
    add(errors, 'AE6_AUTHORITY_TOO_WIDE', 'manifest.maximumAuthority', 'AE-6 is evidence-only and send-inert.');
  }
  for (const failure of PROTECTED_FAILURES) {
    if (!world.manifest.protectedFailures.includes(failure)) {
      add(errors, 'AE6_PROTECTED_FAILURE_REQUIRED', 'manifest.protectedFailures', `Missing protected failure ${failure}.`);
    }
  }

  const contract = world.arabicPintEvidence;
  if (!plain(contract)) {
    add(errors, 'AE6_CONTRACT_REQUIRED', 'arabicPintEvidence', 'The AE-6 evidence contract is required.');
    return validation(errors);
  }
  if (contract.version !== AE_ARABIC_PINT_EVIDENCE_VERSION) {
    add(errors, 'AE6_VERSION_INVALID', 'arabicPintEvidence.version', `Expected ${AE_ARABIC_PINT_EVIDENCE_VERSION}.`);
  }
  if (contract.shippingArabicDeclaration !== false || contract.humanReviewStatus !== 'deferred_until_preview_alpha') {
    add(errors, 'AE6_ARABIC_DECLARATION_FORBIDDEN', 'arabicPintEvidence', 'AE-6 must keep Arabic undeclared and record the deferred human-review gate.');
  }

  const artifactIndex = new Map(world.artifacts.map((artifact) => [artifact?.id, artifact]));
  const observations = new Set(world.observations.map((observation) => observation?.artifactId));
  const economics = validateEconomics(contract.canonicalEconomics, errors);
  const evidenceIds = new Set();
  for (const [index, evidence] of array(contract.evidenceArtifacts).entries()) {
    const path = evidence?.id ? `arabicPintEvidence.evidenceArtifacts.${evidence.id}` : `arabicPintEvidence.evidenceArtifacts[${index}]`;
    if (!plain(evidence) || !nonEmpty(evidence.id) || evidenceIds.has(evidence.id)) {
      add(errors, 'AE6_EVIDENCE_ID_INVALID', `${path}.id`, 'Evidence ids must be unique non-empty strings.');
      continue;
    }
    evidenceIds.add(evidence.id);
    if (!artifactIndex.has(evidence.id) || !observations.has(evidence.id)) {
      add(errors, 'AE6_EVIDENCE_NOT_OBSERVED', path, 'Each evidence payload must be a known observed world artifact.');
    }
    if (!RAW_PATH.test(evidence.rawPath ?? '') || !SHA256.test(evidence.rawSha256 ?? '')
        || !Number.isSafeInteger(evidence.rawByteLength) || evidence.rawByteLength <= 0) {
      add(errors, 'AE6_RAW_RECEIPT_INVALID', path, 'Raw evidence needs a bounded path, SHA-256, and positive byte length.');
    }
    if (!CONTENT_CLASSES.has(evidence.contentClass)
        || !MEDIA_BY_CLASS[evidence.contentClass]?.has(evidence.mediaType)) {
      add(errors, 'AE6_CONTENT_CLASS_INVALID', path, 'Content class and media type must agree.');
    }
    if (!PRESENTATIONS.has(evidence.presentation) || !DIGIT_SYSTEMS.has(evidence.digitSystem)) {
      add(errors, 'AE6_PRESENTATION_INVALID', path, 'Presentation and digit system must be explicit.');
    }
    const pint = evidence.pintExpectation;
    if (!plain(pint) || !['accepted', 'refused', 'not_applicable'].includes(pint.status)) {
      add(errors, 'AE6_PINT_EXPECTATION_INVALID', `${path}.pintExpectation`, 'A closed PINT expectation is required.');
      continue;
    }
    if (evidence.contentClass !== 'structured_xml') {
      if (evidence.expectedLane !== AE_EVIDENCE_LANES.ORDINARY || pint.status !== 'not_applicable') {
        add(errors, 'AE6_LOOKALIKE_LANE_INVALID', path, 'PDF, image, scan, and email evidence must remain ordinary evidence.');
      }
    } else if (pint.status === 'accepted') {
      if (evidence.expectedLane !== AE_EVIDENCE_LANES.PINT
          || !['invoice', 'credit_note'].includes(pint.documentKind)
          || !economics.has(evidence.canonicalEconomicId)) {
        add(errors, 'AE6_ACCEPTED_PINT_CONTRACT_INVALID', path, 'Accepted structured evidence needs an immutable kind and canonical economics.');
      }
    } else if (pint.status === 'refused') {
      if (evidence.expectedLane !== AE_EVIDENCE_LANES.REFUSED || !nonEmpty(pint.refusalCode)) {
        add(errors, 'AE6_REFUSED_PINT_CONTRACT_INVALID', path, 'A structured near-miss needs a stable refusal and no PINT admission.');
      }
    } else {
      add(errors, 'AE6_STRUCTURED_EXPECTATION_REQUIRED', path, 'Structured XML must be either accepted or refused.');
    }
  }

  const renderIds = new Set();
  for (const [index, renderCase] of array(contract.renderCases).entries()) {
    const path = renderCase?.id ? `arabicPintEvidence.renderCases.${renderCase.id}` : `arabicPintEvidence.renderCases[${index}]`;
    if (!plain(renderCase) || !nonEmpty(renderCase.id) || renderIds.has(renderCase.id)) {
      add(errors, 'AE6_RENDER_CASE_ID_INVALID', `${path}.id`, 'Render-case ids must be unique.');
      continue;
    }
    renderIds.add(renderCase.id);
    if (!economics.has(renderCase.canonicalEconomicId) || !PRESENTATIONS.has(renderCase.presentation)
        || !DIGIT_SYSTEMS.has(renderCase.digitSystem)) {
      add(errors, 'AE6_RENDER_CASE_CONTRACT_INVALID', path, 'Render cases need known economics, presentation, and digit system.');
    }
    if (!Array.isArray(renderCase.logicalNeedles) || renderCase.logicalNeedles.some((value) => !nonEmpty(value))) {
      add(errors, 'AE6_RENDER_LOGICAL_TEXT_REQUIRED', `${path}.logicalNeedles`, 'Logical copy/search needles are required.');
    }
    if (!Array.isArray(renderCase.pageOrderMarkers) || renderCase.pageOrderMarkers.some((value) => !nonEmpty(value))) {
      add(errors, 'AE6_RENDER_PAGE_MARKERS_REQUIRED', `${path}.pageOrderMarkers`, 'Page-order markers must be explicit.');
    }
  }

  return validation(errors, {
    counts: { economics: economics.size, evidence: evidenceIds.size, renderCases: renderIds.size },
  });
}

export function classifyAeEvidenceLane({ contentClass, mediaType, parserResult } = {}) {
  if (contentClass !== 'structured_xml' || !MEDIA_BY_CLASS.structured_xml.has(mediaType)) {
    return AE_EVIDENCE_LANES.ORDINARY;
  }
  return parserResult?.ok === true
    && parserResult.document?.schema === 'pint-ae-ubl'
    && parserResult.document?.validationAssurance === 'bounded_application'
    ? AE_EVIDENCE_LANES.PINT
    : AE_EVIDENCE_LANES.REFUSED;
}

export function projectCanonicalAeBillingDocument(document) {
  if (!plain(document) || !['invoice', 'credit_note'].includes(document.documentKind)) {
    throw new TypeError('A normalized AE Invoice or CreditNote is required.');
  }
  const fixed = (value, { nullable = false } = {}) => {
    if (value == null && nullable) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)
        || !Number.isSafeInteger(Math.round(value * 100))) {
      throw new TypeError(`Unsafe canonical decimal: ${String(value)}`);
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    return normalized.toFixed(2);
  };
  return freeze({
    schema: 'ae.canonical-billing-economics.v1',
    documentKind: document.documentKind,
    documentNumber: document.documentNumber,
    typeCode: document.typeCode,
    issueDate: document.issueDate,
    dueDate: document.dueDate,
    currency: document.currency,
    taxCurrency: document.taxCurrency,
    supplierTrn: document.supplier?.trn ?? null,
    buyerTrn: document.buyer?.trn ?? null,
    creditNoteReasonCode: document.creditNoteReason?.code ?? null,
    precedingInvoiceReferences: [...array(document.precedingInvoiceReferences)],
    lines: array(document.lines).map((line) => ({
      linePosition: line.linePosition,
      lineId: line.lineId,
      quantity: fixed(line.quantity),
      unitPrice: fixed(line.unitPrice),
      lineNet: fixed(line.lineNet),
      vatCategory: line.vatCategory,
      vatRatePercent: fixed(line.vatRatePercent, { nullable: true }),
    })),
    totals: Object.fromEntries(Object.entries(document.totals ?? {}).map(([key, value]) => [
      key, fixed(value, { nullable: true }),
    ])),
    vatBreakdown: array(document.vatBreakdown).map((entry) => ({
      category: entry.category,
      ratePercent: fixed(entry.ratePercent, { nullable: true }),
      taxableAmount: fixed(entry.taxableAmount),
      taxAmount: fixed(entry.taxAmount),
    })),
  });
}

export function digestAeCanonicalEconomics(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function buildAeArabicPintExpected(world) {
  const checked = validateAeArabicPintEvidenceWorld(world);
  if (!checked.ok) throw new TypeError(checked.errors.map(({ code, path }) => `${code}:${path}`).join('; '));
  const contract = world.arabicPintEvidence;
  const economics = new Map(contract.canonicalEconomics.map((entry) => [entry.id, entry.value]));
  return freeze({
    sourceReceipts: contract.evidenceArtifacts.map((entry) => ({
      artifactId: entry.id,
      rawSha256: entry.rawSha256,
      rawByteLength: entry.rawByteLength,
      expectedLane: entry.expectedLane,
      parserStatus: entry.pintExpectation.status,
      refusalCode: entry.pintExpectation.refusalCode ?? null,
      documentKind: entry.pintExpectation.documentKind ?? null,
      canonicalEconomicId: entry.canonicalEconomicId ?? null,
      canonicalEconomicDigest: entry.canonicalEconomicId
        ? digestAeCanonicalEconomics(economics.get(entry.canonicalEconomicId))
        : null,
      logicalIdentifiers: entry.canonicalEconomicId
        ? identifiers(economics.get(entry.canonicalEconomicId))
        : null,
    })),
    renderReceipts: contract.renderCases.map((entry) => ({
      renderCaseId: entry.id,
      canonicalEconomicId: entry.canonicalEconomicId,
      canonicalEconomicDigest: digestAeCanonicalEconomics(economics.get(entry.canonicalEconomicId)),
      presentation: entry.presentation,
      digitSystem: entry.digitSystem,
      arabicEngineRequired: entry.presentation !== 'english',
    })),
  });
}

export function evaluateAeArabicPintCandidate(world, candidate) {
  const validationResult = validateAeArabicPintEvidenceWorld(world);
  if (!validationResult.ok) return evaluation('INVALID_WORLD', validationResult.errors, []);
  const expected = buildAeArabicPintExpected(world);
  const failures = [];
  const actualSources = indexBy(candidate?.sourceReceipts, 'artifactId');
  const actualRenders = indexBy(candidate?.renderReceipts, 'renderCaseId');

  for (const expectedSource of expected.sourceReceipts) {
    const actual = actualSources.get(expectedSource.artifactId);
    if (!actual || actual.rawSha256 !== expectedSource.rawSha256
        || actual.rawByteLength !== expectedSource.rawByteLength) {
      fail(failures, 'AE_PINT_RAW_HASH_MISMATCH', expectedSource.artifactId);
      continue;
    }
    if (actual.observedLane !== expectedSource.expectedLane) {
      fail(failures,
        expectedSource.expectedLane === AE_EVIDENCE_LANES.ORDINARY
          ? 'AE_PINT_LOOKALIKE_PROMOTED'
          : expectedSource.expectedLane === AE_EVIDENCE_LANES.REFUSED
            ? 'AE_PINT_MALFORMED_STRUCTURED_PROMOTED'
            : 'AE_PINT_VALID_STRUCTURED_NOT_ADMITTED',
        expectedSource.artifactId);
    }
    if (actual.parserStatus !== expectedSource.parserStatus
        || actual.refusalCode !== expectedSource.refusalCode) {
      fail(failures, expectedSource.parserStatus === 'refused'
        ? 'AE_PINT_MALFORMED_STRUCTURED_PROMOTED'
        : 'AE_PINT_VALID_STRUCTURED_NOT_ADMITTED', expectedSource.artifactId);
    }
    if (actual.documentKind !== expectedSource.documentKind) {
      fail(failures, 'AE_PINT_DOCUMENT_KIND_SWAPPED', expectedSource.artifactId);
    }
    if (expectedSource.canonicalEconomicId) {
      if (actual.canonicalEconomicId !== expectedSource.canonicalEconomicId) {
        fail(failures, 'AE_PINT_CROSS_ARTIFACT_IDENTITY_LEAK', expectedSource.artifactId);
      }
      if (actual.canonicalEconomicDigest !== expectedSource.canonicalEconomicDigest) {
        fail(failures, 'AE_PINT_LANGUAGE_ALTERS_ACCOUNTING', expectedSource.artifactId);
      }
      if (!actual.logicalOrder) fail(failures, 'AE_PINT_VISUAL_ORDER_USED_AS_LOGICAL', expectedSource.artifactId);
      if (!same(actual.logicalIdentifiers, expectedSource.logicalIdentifiers)
          || Object.values(actual.logicalIdentifiers ?? {}).some((value) => BIDI_CONTROL.test(String(value ?? '')))) {
        fail(failures, 'AE_PINT_BIDI_CONTROL_ALTERS_IDENTIFIER', expectedSource.artifactId);
      }
    }
  }

  for (const expectedRender of expected.renderReceipts) {
    const actual = actualRenders.get(expectedRender.renderCaseId);
    if (!actual) {
      fail(failures, 'AE_PINT_RENDER_RECEIPT_MISSING', expectedRender.renderCaseId);
      continue;
    }
    if (actual.canonicalEconomicId !== expectedRender.canonicalEconomicId) {
      fail(failures, 'AE_PINT_CROSS_ARTIFACT_IDENTITY_LEAK', expectedRender.renderCaseId);
    }
    if (actual.canonicalEconomicDigest !== expectedRender.canonicalEconomicDigest) {
      fail(failures, expectedRender.digitSystem === 'arabic_indic'
        ? 'AE_PINT_DIGIT_SYSTEM_ALTERS_ECONOMICS'
        : 'AE_PINT_LANGUAGE_ALTERS_ACCOUNTING', expectedRender.renderCaseId);
    }
    if (!actual.rawSha256 || !SHA256.test(actual.rawSha256) || actual.rawByteLength <= 0) {
      fail(failures, 'AE_PINT_RAW_HASH_MISMATCH', expectedRender.renderCaseId);
    }
    if (!actual.logicalCopy || !actual.structureOrder || !actual.controlsFree) {
      fail(failures, 'AE_PINT_VISUAL_ORDER_USED_AS_LOGICAL', expectedRender.renderCaseId);
    }
    if (!actual.pageOrder) fail(failures, 'AE_PINT_PAGE_ORDER_REVERSED', expectedRender.renderCaseId);
    if (actual.artifactKind !== 'credit_note_pdf' || actual.pintLane !== AE_EVIDENCE_LANES.ORDINARY) {
      fail(failures, 'AE_PINT_LOOKALIKE_PROMOTED', expectedRender.renderCaseId);
    }
    if (expectedRender.arabicEngineRequired
        && (!actual.fontEmbedded || !actual.shapingReceipt || !actual.rtlAnchored
          || !actual.semanticStructure || actual.imageOnly)) {
      fail(failures, 'AE_PINT_RENDER_RECEIPT_MISSING', expectedRender.renderCaseId);
    }
  }

  return evaluation(failures.length ? 'FAIL' : 'PASS', [], failures);
}

function validateEconomics(value, errors) {
  const result = new Map();
  for (const [index, entry] of array(value).entries()) {
    const path = entry?.id ? `arabicPintEvidence.canonicalEconomics.${entry.id}` : `arabicPintEvidence.canonicalEconomics[${index}]`;
    if (!plain(entry) || !nonEmpty(entry.id) || result.has(entry.id) || !plain(entry.value)) {
      add(errors, 'AE6_CANONICAL_ECONOMICS_INVALID', path, 'Canonical economics need a unique id and object value.');
      continue;
    }
    const economic = entry.value;
    if (!['invoice', 'credit_note'].includes(economic.documentKind)
        || !nonEmpty(economic.documentNumber) || !ISO_DAY.test(economic.issueDate ?? '')
        || !/^[A-Z]{3}$/.test(economic.currency ?? '') || !TRN.test(economic.supplierTrn ?? '')) {
      add(errors, 'AE6_CANONICAL_IDENTITY_INVALID', path, 'Canonical kind, identifier, day, currency, and supplier TRN are required.');
    }
    for (const amount of moneyValues(economic)) {
      if (amount !== null && !EXACT_MONEY.test(amount)) {
        add(errors, 'AE6_CANONICAL_MONEY_INVALID', path, 'Canonical economics use exact signed two-decimal strings.');
        break;
      }
    }
    result.set(entry.id, economic);
  }
  return result;
}

function moneyValues(economic) {
  return [
    ...Object.values(economic.totals ?? {}),
    ...array(economic.lines).flatMap((line) => [line.quantity, line.unitPrice, line.lineNet, line.vatRatePercent]),
    ...array(economic.vatBreakdown).flatMap((line) => [line.ratePercent, line.taxableAmount, line.taxAmount]),
  ];
}

function identifiers(economic) {
  return {
    documentNumber: economic.documentNumber,
    supplierTrn: economic.supplierTrn,
    buyerTrn: economic.buyerTrn,
    issueDate: economic.issueDate,
    dueDate: economic.dueDate,
    currency: economic.currency,
    precedingInvoiceReference: economic.precedingInvoiceReferences?.[0] ?? null,
  };
}

function validation(errors, extra = {}) {
  return freeze({ ok: errors.length === 0, version: AE_ARABIC_PINT_EVIDENCE_VERSION, errors, ...extra });
}
function evaluation(status, errors, failures) {
  const body = { version: AE_ARABIC_PINT_EVIDENCE_VERSION, status, errors, failures };
  return freeze({ ...body, receiptDigest: digestAeCanonicalEconomics(body) });
}
function indexBy(value, key) { return new Map(array(value).filter(plain).map((entry) => [entry[key], entry])); }
function add(errors, code, path, message) { errors.push({ code, path, message }); }
function fail(failures, code, subjectId) {
  if (!failures.some((entry) => entry.code === code && entry.subjectId === subjectId)) failures.push({ code, subjectId });
}
function same(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== ''; }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function array(value) { return Array.isArray(value) ? value : []; }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
