import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AE_ARABIC_PINT_EVIDENCE_VERSION,
  AE_EVIDENCE_LANES,
  buildAeArabicPintExpected,
  classifyAeEvidenceLane,
  digestAeCanonicalEconomics,
  evaluateAeArabicPintCandidate,
  projectCanonicalAeBillingDocument,
  validateAeArabicPintEvidenceWorld,
} from './aeArabicPintEvidence.js';
import { validateAeEntityTaxContextWorld } from './aeEntityTaxContext.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { validateWorldSpec } from './worldSchema.js';
import { validateCausalWorld } from './worldValidity.js';

const fixtureUrl = new URL('../../../data/worlds/ae/ae-arabic-pint-evidence.json', import.meta.url);
const repoUrl = new URL('../../../', import.meta.url);

test('AE-6 fixture composes through schema, causality, AE-1 facts, world rendering, and its evidence contract', async () => {
  const world = await loadWorld();
  assert.deepEqual(validateWorldSpec(world), { ok: true, errors: [] });
  assert.deepEqual(validateCausalWorld(world), {
    ok: true, version: 'proof0.validity.v1', errors: [],
  });
  assert.equal(validateAeEntityTaxContextWorld(world).ok, true);
  assert.deepEqual(validateAeArabicPintEvidenceWorld(world), {
    ok: true,
    version: AE_ARABIC_PINT_EVIDENCE_VERSION,
    errors: [],
    counts: { economics: 2, evidence: 11, renderCases: 4 },
  });
  const rendered = await renderWorldArtifacts(world);
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  assert.equal(rendered.artifacts.length, 15);
});

test('every checked-in raw payload byte length and SHA-256 matches its immutable fixture receipt', async () => {
  const world = await loadWorld();
  for (const evidence of world.arabicPintEvidence.evidenceArtifacts) {
    const raw = await readFile(new URL(evidence.rawPath, repoUrl));
    assert.equal(raw.length, evidence.rawByteLength, evidence.id);
    assert.equal(createHash('sha256').update(raw).digest('hex'), evidence.rawSha256, evidence.id);
  }
});

test('only validated structured XML can enter PINT; PDF, image, scan, email and failed XML cannot', () => {
  const accepted = {
    ok: true,
    document: { schema: 'pint-ae-ubl', validationAssurance: 'bounded_application' },
  };
  assert.equal(classifyAeEvidenceLane({
    contentClass: 'structured_xml', mediaType: 'application/xml', parserResult: accepted,
  }), AE_EVIDENCE_LANES.PINT);
  assert.equal(classifyAeEvidenceLane({
    contentClass: 'structured_xml', mediaType: 'application/xml', parserResult: { ok: false },
  }), AE_EVIDENCE_LANES.REFUSED);
  for (const [contentClass, mediaType] of [
    ['native_pdf', 'application/pdf'],
    ['scan_image', 'image/svg+xml'],
    ['email', 'message/rfc822'],
  ]) {
    assert.equal(classifyAeEvidenceLane({ contentClass, mediaType, parserResult: accepted }),
      AE_EVIDENCE_LANES.ORDINARY, contentClass);
  }
  assert.equal(classifyAeEvidenceLane({
    contentClass: 'structured_xml', mediaType: 'application/pdf', parserResult: accepted,
  }), AE_EVIDENCE_LANES.ORDINARY, 'MIME lookalikes do not enter PINT');
});

test('the independent canonical projector excludes language copy but pins signed kind, identifiers, and economics', () => {
  const shared = {
    schema: 'pint-ae-ubl', validationAssurance: 'bounded_application',
    documentKind: 'credit_note', documentNumber: 'AE-CN-1', typeCode: '381',
    issueDate: '2026-08-12', dueDate: '2026-09-11', currency: 'AED', taxCurrency: null,
    supplier: { name: 'شركة', trn: '100000000000003' },
    buyer: { name: 'Buyer', trn: '100000000000101' },
    creditNoteReason: { code: 'DL8.61.1.A', label: 'copy may change language' },
    precedingInvoiceReferences: ['AE-INV-1'],
    lines: [{ linePosition: 1, lineId: '1', description: 'معدات معادة', quantity: -5,
      unitPrice: 100, lineNet: -500, vatCategory: 'S', vatRatePercent: 5 }],
    totals: { lineTotal: -500, subtotal: -500, vatTotal: -25,
      vatTotalInTaxCurrency: null, total: -525, payable: -525 },
    vatBreakdown: [{ category: 'S', ratePercent: 5, taxableAmount: -500, taxAmount: -25 }],
  };
  const arabic = projectCanonicalAeBillingDocument(shared);
  const english = projectCanonicalAeBillingDocument({
    ...shared,
    supplier: { ...shared.supplier, name: 'Gulf Trading LLC' },
    lines: [{ ...shared.lines[0], description: 'Returned equipment' }],
  });
  assert.deepEqual(arabic, english);
  assert.equal(arabic.documentKind, 'credit_note');
  assert.equal(arabic.lines[0].lineNet, '-500.00');
  assert.equal(arabic.totals.total, '-525.00');
  assert.equal(arabic.precedingInvoiceReferences[0], 'AE-INV-1');
  assert.equal(digestAeCanonicalEconomics(arabic), digestAeCanonicalEconomics(english));
});

test('stable mutation certificates refuse every protected AE-6 language, identity, order, lane, and receipt failure', async () => {
  const world = await loadWorld();
  const expected = buildAeArabicPintExpected(world);
  const pristine = {
    sourceReceipts: expected.sourceReceipts.map((entry) => ({
      ...entry,
      observedLane: entry.expectedLane,
      logicalOrder: entry.canonicalEconomicId ? true : null,
    })),
    renderReceipts: expected.renderReceipts.map((entry) => ({
      ...entry,
      rawSha256: 'a'.repeat(64), rawByteLength: 1,
      artifactKind: 'credit_note_pdf', artifactTemplate: 'credit_note_pdf',
      pintLane: AE_EVIDENCE_LANES.ORDINARY,
      logicalCopy: true, structureOrder: true, pageOrder: true, controlsFree: true,
      fontEmbedded: true, shapingReceipt: true, rtlAnchored: true,
      semanticStructure: true, imageOnly: false,
    })),
  };
  assert.equal(evaluateAeArabicPintCandidate(world, pristine).status, 'PASS');

  const cases = [
    ['AE_PINT_DIGIT_SYSTEM_ALTERS_ECONOMICS', (value) => {
      value.renderReceipts.find(({ digitSystem }) => digitSystem === 'arabic_indic').canonicalEconomicDigest = 'b'.repeat(64);
    }],
    ['AE_PINT_BIDI_CONTROL_ALTERS_IDENTIFIER', (value) => {
      value.sourceReceipts.find(({ canonicalEconomicId }) => canonicalEconomicId)
        .logicalIdentifiers.documentNumber = '\u2066AE-INV-2026-0042\u2069';
    }],
    ['AE_PINT_VISUAL_ORDER_USED_AS_LOGICAL', (value) => {
      value.sourceReceipts.find(({ canonicalEconomicId }) => canonicalEconomicId).logicalOrder = false;
    }],
    ['AE_PINT_PAGE_ORDER_REVERSED', (value) => {
      value.renderReceipts.find(({ renderCaseId }) => renderCaseId.includes('multipage')).pageOrder = false;
    }],
    ['AE_PINT_RENDER_RECEIPT_MISSING', (value) => {
      value.renderReceipts.find(({ presentation }) => presentation === 'arabic').fontEmbedded = false;
    }],
    ['AE_PINT_DOCUMENT_KIND_SWAPPED', (value) => {
      value.sourceReceipts.find(({ documentKind }) => documentKind === 'credit_note').documentKind = 'invoice';
    }],
    ['AE_PINT_MALFORMED_STRUCTURED_PROMOTED', (value) => {
      value.sourceReceipts.find(({ parserStatus }) => parserStatus === 'refused').observedLane = AE_EVIDENCE_LANES.PINT;
    }],
    ['AE_PINT_LOOKALIKE_PROMOTED', (value) => {
      value.sourceReceipts.find(({ expectedLane }) => expectedLane === AE_EVIDENCE_LANES.ORDINARY).observedLane = AE_EVIDENCE_LANES.PINT;
    }],
    ['AE_PINT_RAW_HASH_MISMATCH', (value) => { value.sourceReceipts[0].rawSha256 = '0'.repeat(64); }],
    ['AE_PINT_LANGUAGE_ALTERS_ACCOUNTING', (value) => {
      value.sourceReceipts.find(({ artifactId }) => artifactId === 'artifact/pint-invoice-ar').canonicalEconomicDigest = 'c'.repeat(64);
    }],
    ['AE_PINT_CROSS_ARTIFACT_IDENTITY_LEAK', (value) => {
      value.renderReceipts[0].canonicalEconomicId = 'economics/invoice-1250';
    }],
  ];
  for (const [code, mutate] of cases) {
    const candidate = clone(pristine);
    mutate(candidate);
    const result = evaluateAeArabicPintCandidate(world, candidate);
    assert.equal(result.status, 'FAIL', code);
    assert.ok(result.failures.some((failure) => failure.code === code),
      `${code}: ${JSON.stringify(result.failures)}`);
  }
});

test('world contract refuses an Arabic shipping declaration and malformed raw evidence receipts', async () => {
  const declaration = await loadWorld();
  declaration.arabicPintEvidence.shippingArabicDeclaration = true;
  assert.ok(codes(declaration).includes('AE6_ARABIC_DECLARATION_FORBIDDEN'));

  const traversal = await loadWorld();
  traversal.arabicPintEvidence.evidenceArtifacts[0].rawPath = '../../secret.xml';
  assert.ok(codes(traversal).includes('AE6_RAW_RECEIPT_INVALID'));

  const lookalike = await loadWorld();
  lookalike.arabicPintEvidence.evidenceArtifacts.find(({ contentClass }) => contentClass === 'email')
    .expectedLane = AE_EVIDENCE_LANES.PINT;
  assert.ok(codes(lookalike).includes('AE6_LOOKALIKE_LANE_INVALID'));
});

async function loadWorld() { return JSON.parse(await readFile(fixtureUrl, 'utf8')); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function codes(world) { return validateAeArabicPintEvidenceWorld(world).errors.map(({ code }) => code); }
