import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compareAeArabicPintWorldWithProduction } from './eval_world_ae_arabic_pint.js';

const fixtureUrl = new URL('../data/worlds/ae/ae-arabic-pint-evidence.json', import.meta.url);

test('AE-6 runner proves the real PINT parser and real CreditNote renderer against the independent world', async () => {
  const result = await compareAeArabicPintWorldWithProduction(await loadWorld());
  assert.equal(result.status, 'pass', JSON.stringify(result.evaluation));
  assert.equal(result.evaluation.status, 'PASS');
  assert.deepEqual(result.evaluation.failures, []);
  assert.deepEqual(result.authority, {
    productionParser: 'parsePintAeBillingDocument',
    productionRenderer: 'renderCreditNotePdfArtifact',
    externalSend: false,
    shippingArabicDeclaration: false,
    humanReviewStatus: 'deferred_until_preview_alpha',
    modelProviderCalls: 0,
  });
});

test('English, Arabic, and bilingual PINT Invoices have one byte-stable economic digest; CreditNote remains signed and distinct', async () => {
  const result = await compareAeArabicPintWorldWithProduction(await loadWorld());
  const sources = result.candidate.sourceReceipts;
  const invoices = sources.filter(({ artifactId }) => artifactId.startsWith('artifact/pint-invoice-'));
  assert.equal(invoices.length, 3);
  assert.equal(new Set(invoices.map(({ canonicalEconomicDigest }) => canonicalEconomicDigest)).size, 1);
  assert.ok(invoices.every(({ observedLane, documentKind, logicalOrder }) =>
    observedLane === 'pint_ae_structured' && documentKind === 'invoice' && logicalOrder));
  const credit = sources.find(({ artifactId }) => artifactId === 'artifact/pint-credit-note-ar');
  assert.equal(credit.documentKind, 'credit_note');
  assert.equal(credit.logicalIdentifiers.precedingInvoiceReference, 'AE-INV-2026-0042');
  const creditEconomics = result.expected.renderReceipts[0].canonicalEconomicDigest;
  assert.equal(credit.canonicalEconomicDigest, creditEconomics);
});

test('semantic near-misses refuse while scan, email, and native PDF lookalikes remain ordinary evidence', async () => {
  const result = await compareAeArabicPintWorldWithProduction(await loadWorld());
  const sources = result.candidate.sourceReceipts;
  assert.deepEqual(sources.filter(({ parserStatus }) => parserStatus === 'refused')
    .map(({ refusalCode }) => refusalCode), ['not_pint_ae', 'amount_mismatch', 'missing_mandatory']);
  assert.ok(sources.filter(({ parserStatus }) => parserStatus === 'not_applicable')
    .every(({ observedLane }) => observedLane === 'ordinary_evidence'));
  assert.ok(result.candidate.renderReceipts
    .every(({ pintLane }) => pintLane === 'ordinary_evidence'));
});

test('production Arabic PDFs prove font, shaping, RTL anchoring, logical copy/structure, both digit systems, and pagination', async () => {
  const result = await compareAeArabicPintWorldWithProduction(await loadWorld());
  const renders = result.candidate.renderReceipts;
  assert.equal(renders.length, 4);
  const arabic = renders.filter(({ presentation }) => presentation !== 'english');
  assert.ok(arabic.every((receipt) => receipt.fontEmbedded && receipt.shapingReceipt
    && receipt.rtlAnchored && receipt.semanticStructure && !receipt.imageOnly));
  assert.ok(renders.every((receipt) => receipt.logicalCopy && receipt.structureOrder
    && receipt.pageOrder && receipt.controlsFree && /^[a-f0-9]{64}$/.test(receipt.rawSha256)));
  const western = renders.find(({ renderCaseId }) => renderCaseId === 'render/credit-note-ar-western');
  const arabicIndic = renders.find(({ digitSystem }) => digitSystem === 'arabic_indic');
  assert.equal(western.canonicalEconomicDigest, arabicIndic.canonicalEconomicDigest);
  assert.equal(renders.find(({ renderCaseId }) => renderCaseId.includes('multipage')).pageCount, 2);
  assert.equal(renders.find(({ presentation }) => presentation === 'english').fontEmbedded, false,
    'English remains on the unchanged LTR renderer');
});

async function loadWorld() { return JSON.parse(await readFile(fixtureUrl, 'utf8')); }
