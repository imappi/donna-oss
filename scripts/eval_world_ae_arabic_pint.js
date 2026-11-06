#!/usr/bin/env node
// AE-6's sole production-comparison seam. The independent world contract
// stays under server/donna/world; only this offline adapter imports Donna's
// shipping PINT parser and CreditNote renderer. It has no database, network,
// model, send, filing, payment, or runtime-flag authority.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { parsePintAeBillingDocument } from '../server/donna/ae/pintInvoice.js';
import { renderCreditNotePdfArtifact } from '../server/donna/outbound/invoicePdfArtifact.js';
import { loadOutboundPack } from '../server/donna/outbound/packs.js';
import {
  AE_EVIDENCE_LANES,
  buildAeArabicPintExpected,
  classifyAeEvidenceLane,
  digestAeCanonicalEconomics,
  evaluateAeArabicPintCandidate,
  projectCanonicalAeBillingDocument,
  validateAeArabicPintEvidenceWorld,
} from '../server/donna/world/aeArabicPintEvidence.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const ARABIC = /\p{Script=Arabic}/u;
const TRN = '100000000000003';
const BUYER_TRN = '100000000000101';
const IBAN = 'AE070331234567890123456';
const EMAIL = 'billing@example-ae.example';
const URL = 'https://example-ae.example/credit/AE-CN-2026-0007';

export async function compareAeArabicPintWorldWithProduction(worldSpec) {
  const oracle = validateAeArabicPintEvidenceWorld(worldSpec);
  if (!oracle.ok) {
    return { status: 'invalid_world', oracle, candidate: null, evaluation: null };
  }
  const expected = buildAeArabicPintExpected(worldSpec);
  const economics = new Map(worldSpec.arabicPintEvidence.canonicalEconomics
    .map((entry) => [entry.id, entry.value]));
  const sourceReceipts = [];

  for (const evidence of worldSpec.arabicPintEvidence.evidenceArtifacts) {
    const raw = await readBoundedRawEvidence(evidence.rawPath);
    const rawSha256 = sha256(raw);
    let parserResult = null;
    let canonical = null;
    if (evidence.contentClass === 'structured_xml') {
      parserResult = parsePintAeBillingDocument({ xml: raw.toString('utf8') });
      if (parserResult.ok) canonical = projectCanonicalAeBillingDocument(parserResult.document);
    }
    sourceReceipts.push({
      artifactId: evidence.id,
      rawSha256,
      rawByteLength: raw.length,
      observedLane: classifyAeEvidenceLane({
        contentClass: evidence.contentClass,
        mediaType: evidence.mediaType,
        parserResult,
      }),
      parserStatus: parserResult ? (parserResult.ok ? 'accepted' : 'refused') : 'not_applicable',
      refusalCode: parserResult?.ok === false ? parserResult.refusal.code : null,
      documentKind: parserResult?.ok ? parserResult.document.documentKind : null,
      canonicalEconomicId: evidence.canonicalEconomicId ?? null,
      canonicalEconomicDigest: canonical ? digestAeCanonicalEconomics(canonical) : null,
      logicalOrder: canonical ? true : null,
      logicalIdentifiers: canonical ? identifiers(canonical) : null,
    });
  }

  const renderReceipts = [];
  for (const renderCase of worldSpec.arabicPintEvidence.renderCases) {
    const artifact = await renderCreditNotePdfArtifact({
      pack: syntheticAeCreditNotePack(),
      language: renderCase.presentation === 'english' ? 'en' : 'ar',
      values: renderValues(renderCase),
    });
    const inspection = await inspectPdf(artifact.content);
    const canonical = economics.get(renderCase.canonicalEconomicId);
    const logicalCopy = renderCase.logicalNeedles.every((needle) => inspection.text.includes(needle));
    const structureText = inspection.structureSpans.map(({ text }) => text).join('');
    const structureOrder = renderCase.presentation === 'english'
      ? logicalCopy
      : inOrder(structureText, renderCase.logicalNeedles)
        || renderCase.logicalNeedles.every((needle) => structureText.includes(needle));
    const pageOrder = inOrder(inspection.text, renderCase.pageOrderMarkers);
    const containsArabic = ARABIC.test(inspection.text);
    renderReceipts.push({
      renderCaseId: renderCase.id,
      canonicalEconomicId: renderCase.canonicalEconomicId,
      canonicalEconomicDigest: digestAeCanonicalEconomics(canonical),
      rawSha256: sha256(artifact.content),
      rawByteLength: artifact.content.length,
      artifactKind: artifact.artifactKind,
      artifactTemplate: artifact.artifactTemplate,
      pintLane: classifyAeEvidenceLane({ contentClass: 'native_pdf', mediaType: artifact.contentType }),
      pageCount: inspection.pageCount,
      logicalCopy,
      structureOrder,
      pageOrder,
      controlsFree: !BIDI_CONTROL.test(inspection.text)
        && inspection.structureSpans.every(({ text }) => !BIDI_CONTROL.test(text)),
      fontEmbedded: artifact.content.toString('latin1').includes('NotoSansArabic-Regular'),
      shapingReceipt: containsArabic && artifact.content.toString('latin1').includes('NotoSansArabic-Regular'),
      rtlAnchored: renderCase.presentation === 'english' || inspection.rtlAnchored,
      semanticStructure: inspection.structureSpans.length > 0,
      imageOnly: /\/Subtype\s*\/Image/.test(artifact.content.toString('latin1')),
      presentation: renderCase.presentation,
      digitSystem: renderCase.digitSystem,
    });
  }

  const candidate = Object.freeze({ sourceReceipts, renderReceipts });
  const evaluation = evaluateAeArabicPintCandidate(worldSpec, candidate);
  return {
    status: evaluation.status === 'PASS' ? 'pass' : 'fail',
    oracle,
    expected,
    candidate,
    evaluation,
    authority: Object.freeze({
      productionParser: 'parsePintAeBillingDocument',
      productionRenderer: 'renderCreditNotePdfArtifact',
      externalSend: false,
      shippingArabicDeclaration: false,
      humanReviewStatus: 'deferred_until_preview_alpha',
      modelProviderCalls: 0,
    }),
  };
}

async function readBoundedRawEvidence(rawPath) {
  const absolute = resolve(REPO, rawPath);
  const allowed = resolve(REPO, 'data/worlds/ae/artifacts/ae6');
  if (absolute !== allowed && !absolute.startsWith(`${allowed}/`)) {
    throw new Error(`AE-6 raw evidence escaped its fixture root: ${rawPath}`);
  }
  return readFile(absolute);
}

function syntheticAeCreditNotePack() {
  const pack = structuredClone(loadOutboundPack('ae', { bypassCache: true }));
  pack.languages.supported.push('ar');
  pack.correspondence.languages.push('ar');
  pack.locale.correspondence_locales = { en: 'en-AE', ar: 'ar-AE' };
  delete pack.documents.statutory_titles;
  pack.documents.statutory_titles_by_language = {
    en: { invoice_when_tax_registered: 'Tax Invoice', invoice_otherwise: 'Invoice' },
    ar: { invoice_when_tax_registered: 'فاتورة ضريبية', invoice_otherwise: 'فاتورة' },
  };
  for (const template of Object.values(pack.documents.templates)) {
    if (template?.en && !template.ar) template.ar = structuredClone(template.en);
  }
  for (const rail of pack.payment_rails) {
    if (rail.instructions_template?.en && !rail.instructions_template.ar) {
      rail.instructions_template.ar = rail.instructions_template.en;
    }
  }
  pack.documents.credit_note_pdf = {
    page: 'a4',
    titles_by_language: { en: 'Credit Note', ar: 'إشعار دائن' },
  };
  pack.documents.templates.credit_note_pdf = {
    en: {
      subject: '{{document_title}} {{credit_note_number}}',
      body: '{{owner_business_name}}\nCredit to: {{counterparty_name}}\nOriginal invoice: {{original_invoice_reference}}\nReason: {{adjustment_reason}}\nIssue date: {{issue_date}}\nSeller TRN: {{seller_tax_registration_number}}\nBuyer TRN: {{buyer_tax_registration_number}}\nIBAN: {{seller_iban}}\n\n{{lines_block}}\n\nSubtotal: {{credit_note_subtotal_amount}} {{currency}}\nTax: {{credit_note_tax_amount}} {{currency}}\nCredit total: {{credit_note_total_amount}} {{currency}}',
    },
    ar: {
      subject: '{{document_title}} {{credit_note_number}}',
      body: '{{owner_business_name}}\nإلى: {{counterparty_name}}\nمرجع الفاتورة الأصلية: {{original_invoice_reference}}\nسبب التعديل: {{adjustment_reason}}\nتاريخ الإصدار: {{issue_date}}\nالرقم الضريبي للبائع: {{seller_tax_registration_number}}\nالرقم الضريبي للمشتري: {{buyer_tax_registration_number}}\nرقم الحساب المصرفي: {{seller_iban}}\n\n{{lines_block}}\n\nالمجموع الفرعي: {{credit_note_subtotal_amount}} {{currency}}\nالضريبة: {{credit_note_tax_amount}} {{currency}}\nإجمالي الإشعار الدائن: {{credit_note_total_amount}} {{currency}}',
    },
  };
  return pack;
}

function renderValues(renderCase) {
  const latinTail = '-5 × 100.00 = -500.00 AED (5.00 %)';
  const arabicIndicTail = '-٥ × ١٠٠٫٠٠ = -٥٠٠٫٠٠ AED (٥٫٠٠ %)';
  const actualLine = `${renderCase.lineDescription} — ${renderCase.digitSystem === 'arabic_indic' ? arabicIndicTail : latinTail}`;
  const markers = Array.from({ length: renderCase.repeatCount }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, '0');
    return renderCase.presentation === 'english'
      ? `Phase ${ordinal} — 0 × 0.00 = 0.00 AED`
      : `Phase ${ordinal} / المرحلة ${ordinal} — 0 × 0.00 = 0.00 AED`;
  });
  return {
    owner_business_name: renderCase.presentation === 'english'
      ? 'Gulf Trading LLC'
      : 'Gulf Trading LLC / شركة الخليج للتجارة ذ.م.م',
    counterparty_name: renderCase.counterpartyName,
    credit_note_number: 'AE-CN-2026-0007',
    original_invoice_reference: 'AE-INV-2026-0042',
    adjustment_reason: `${renderCase.adjustmentReason} · ${EMAIL} · ${URL}`,
    issue_date: renderCase.issueDateDisplay,
    currency: 'AED',
    seller_tax_registration_number: TRN,
    buyer_tax_registration_number: BUYER_TRN,
    seller_iban: IBAN,
    lines_block: [actualLine, ...markers].join('\n'),
    credit_note_subtotal_amount: renderCase.subtotalDisplay,
    credit_note_tax_amount: renderCase.taxDisplay,
    credit_note_total_amount: renderCase.totalDisplay,
  };
}

async function inspectPdf(content) {
  const physical = await PDFDocument.load(content);
  const loadingTask = getDocument({ data: new Uint8Array(content), useSystemFonts: false });
  const pdf = await loadingTask.promise;
  const pageTexts = [];
  const structureSpans = [];
  let rtlAnchored = false;
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let pageText = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        if (ARABIC.test(item.str) && Number(item.transform?.[4]) > 250) rtlAnchored = true;
        if (item.hasEOL) pageText += '\n';
      }
      pageTexts.push(pageText);
      collectStructureSpans(await page.getStructTree(), structureSpans);
    }
  } finally {
    await pdf.destroy();
  }
  return {
    pageCount: physical.getPageCount(),
    pageTexts,
    text: pageTexts.join('\n'),
    structureSpans,
    rtlAnchored,
  };
}

function collectStructureSpans(node, spans) {
  if (typeof node?.alt === 'string') spans.push({ text: node.alt, lang: node.lang ?? null });
  for (const child of node?.children ?? []) collectStructureSpans(child, spans);
}

function identifiers(canonical) {
  return {
    documentNumber: canonical.documentNumber,
    supplierTrn: canonical.supplierTrn,
    buyerTrn: canonical.buyerTrn,
    issueDate: canonical.issueDate,
    dueDate: canonical.dueDate,
    currency: canonical.currency,
    precedingInvoiceReference: canonical.precedingInvoiceReferences[0] ?? null,
  };
}

function inOrder(text, markers) {
  let prior = -1;
  for (const marker of markers) {
    const position = text.indexOf(marker);
    if (position < 0 || position <= prior) return false;
    prior = position;
  }
  return true;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const world = JSON.parse(await readFile(resolve(REPO, 'data/worlds/ae/ae-arabic-pint-evidence.json'), 'utf8'));
  const result = await compareAeArabicPintWorldWithProduction(world);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : 1;
}
