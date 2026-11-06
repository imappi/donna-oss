// The Arabic/RTL rendering probes (UAE lane — the honest engine test).
//
// The AE manifest declares the complete AR-4F Arabic Preview Alpha catalog.
// These probes feed its strings through the REAL render paths — the invoice
// email (renderPackTemplate + buildLinesBlock) and the PDF artifact
// (renderInvoicePdfArtifact) — and PIN what the engine does.
// AR-4A flips the old zero-isolate finding into a positive mint-time proof;
// AR-4B1 flips the old Helvetica failure into a production Unicode-font,
// shaping, bidi and right-anchor proof; AR-4B2 adds a mainstream PDF.js
// copy/search and accessibility-structure proof. Fixture status lives in
// docs/design-donna-rtl-readiness.md; this file is the machine check that
// keeps them honest. When a later fix lands (font embedding or a
// language-keyed statutory title), the probe pinning the old behavior FAILS
// — update the probe and the readiness note in the same commit.
//
// Layer discipline (invoicePdfArtifact.test.js): content is pinned at the
// template layer; the PDF layer is pinned through its real embedded font,
// vector glyphs, viewer text layer, logical structure tree and loadable page
// geometry. CreditNote remains an in-memory, send-inert fixture; the ordinary
// invoice/quote/email probes use the shipping AE v6 pack directly.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  renderCreditNotePdfArtifact, renderInvoicePdfArtifact, invoicePdfFilename
} from './invoicePdfArtifact.js';
import { buildAttachmentManifest } from './emailArtifact.js';
import {
  ARABIC_PDF_FONT_SHA256, ARABIC_PDF_FONT_URL, bidiVisualRuns,
  positionArabicPdfVisualRuns, wrapArabicPdfLine
} from './arabicPdfText.js';
import { buildLinesBlock, documentTitleForInvoice } from './issuance.js';
import { buildInvoiceStatutoryValues } from './invoiceStatutoryValues.js';
import {
  loadOutboundPack, renderPackTemplate, formatPackAmount, formatPackDate
} from './packs.js';
import {
  FSI, LRI, PDI, bidiSafeRenderValues, containsRtl,
  stripBidiControls
} from './bidiText.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Real AE-shaped strings: an Arabic legal name (ذ.م.م = LLC), an Arabic line
// description, the Arabic statutory title (فاتورة ضريبية = Tax Invoice), and
// the LTR values the bidi algorithm must not scramble inside them — a
// 15-digit TRN, an AE IBAN, AED amounts.
const AR_PARTY = 'شركة الخليج للتجارة ذ.م.م';
const AR_LINE_DESCRIPTION = 'خدمات استشارية';
const AR_TAX_INVOICE_TITLE = 'فاتورة ضريبية';
const AR_TRN_LABEL = 'الرقم الضريبي';
const TRN = '100234567890003';
const AE_IBAN = 'AE07 0331 2345 6789 0123 456';

const BIDI_CONTROLS_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

const collectStructureSpans = (node, spans = []) => {
  if (typeof node?.alt === 'string') spans.push({ text: node.alt, lang: node.lang || null });
  for (const child of node?.children || []) collectStructureSpans(child, spans);
  return spans;
};

// PDF.js is the shipping Firefox PDF engine and supplies the text layer used
// for selection and search. Exercise that consumer rather than decoding Donna's
// own PDF syntax, and inspect the same page structure exposed to accessibility.
const inspectPdfInteroperability = async (content) => {
  const loadingTask = getDocument({
    data: new Uint8Array(content),
    useSystemFonts: false
  });
  const pdf = await loadingTask.promise;
  const pageTexts = [];
  const structureSpans = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let pageText = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        if (item.hasEOL) pageText += '\n';
      }
      pageTexts.push(pageText);
      collectStructureSpans(await page.getStructTree(), structureSpans);
    }
  } finally {
    await pdf.destroy();
  }
  return {
    pageTexts,
    structureSpans,
    text: pageTexts.join('\n')
  };
};

const aePack = () => loadOutboundPack('ae', { bypassCache: true });

const arabicInvoiceValues = (pack, language = pack.languages.default) => bidiSafeRenderValues({
  ...buildInvoiceStatutoryValues({
    pack,
    language,
    invoice: {
      seller: { address: 'Dubai, United Arab Emirates', taxRegistered: true, taxRegistrationId: TRN },
      buyer: { address: 'أبوظبي، الإمارات العربية المتحدة', taxRegistered: true, taxRegistrationId: '100987654321009' },
      supplyDate: '2026-08-31', currency: pack.currency.home, subtotal: 3000, taxTotal: 150
    }
  }),
  owner_business_name: 'Gulf Coast Consulting FZ-LLC',
  counterparty_name: AR_PARTY,
  invoice_number: '2026-014',
  invoice_total: '3,150.00',
  currency: pack.currency.home,
  issue_date: '31 Aug 2026',
  due_date: '14 Sep 2026',
  lines_block: buildLinesBlock({
    pack,
    lines: [{ description: AR_LINE_DESCRIPTION, quantity: 2, unitPrice: 1500, taxRate: 5 }],
    currency: pack.currency.home
  }),
  payment_instructions: [
    `IBAN ${AE_IBAN}`,
    `${AR_TRN_LABEL}: ${TRN}`,
    'البريد الإلكتروني: billing@example-ae.example',
    'الرابط: https://example-ae.example/invoices/INV-2026-014'
  ].join('\n'),
  document_title: 'Tax Invoice'
});

const syntheticArabicPack = () => structuredClone(aePack());

const syntheticArabicCreditNotePack = () => {
  const pack = syntheticArabicPack();
  pack.documents.credit_note_pdf = {
    page: 'a4',
    titles_by_language: { en: 'Credit Note', ar: 'إشعار دائن' }
  };
  const body = '{{owner_business_name}}\nإلى: {{counterparty_name}}\nمرجع الفاتورة الأصلية: {{original_invoice_reference}}\nسبب التعديل: {{adjustment_reason}}\nتاريخ الإصدار: {{issue_date}}\nالرقم الضريبي للبائع: {{seller_tax_registration_number}}\nالرقم الضريبي للمشتري: {{buyer_tax_registration_number}}\nرقم الحساب المصرفي: {{seller_iban}}\n\n{{lines_block}}\n\nالمجموع الفرعي: {{credit_note_subtotal_amount}} {{currency}}\nالضريبة: {{credit_note_tax_amount}} {{currency}}\nإجمالي الإشعار الدائن: {{credit_note_total_amount}} {{currency}}';
  pack.documents.templates.credit_note_pdf = {
    en: { subject: '{{document_title}} {{credit_note_number}}', body },
    ar: { subject: '{{document_title}} {{credit_note_number}}', body }
  };
  return pack;
};

// ── The email path: Arabic VALUES through the shipping en templates ─────────

test('AR-4A proof: the email renderer preserves logical Arabic and emits production bidi isolation', () => {
  const pack = aePack();
  const values = arabicInvoiceValues(pack);
  const rendered = renderPackTemplate(pack, {
    template: 'invoice_issue', language: pack.languages.default, values
  });
  // Arabic remains logical-order source text after controls are removed.
  assert.ok(rendered.body.includes(AR_PARTY), 'the Arabic party name reaches the body intact');
  assert.ok(rendered.body.includes(AR_LINE_DESCRIPTION), 'the Arabic line description too');
  assert.ok(rendered.body.includes(TRN), 'the TRN survives beside Arabic text');
  assert.ok(!`${rendered.subject}\n${rendered.body}`.includes('{{'), 'no leaked placeholders');
  assert.ok(
    BIDI_CONTROLS_RE.test(`${rendered.subject}\n${rendered.body}`),
    'the old zero-isolate finding has flipped'
  );
  assert.ok(rendered.body.includes(`${FSI}${AR_PARTY}${PDI}`), 'party name is first-strong isolated');
  assert.ok(rendered.body.includes(`${LRI}${TRN}${PDI}`), 'TRN is an LTR island');
  assert.equal(
    stripBidiControls(rendered.body).includes(AR_PARTY), true,
    'stripping presentation controls preserves logical prose'
  );
});

test('AR-4A proof: an Arabic-described line keeps the complete math tail in one LTR island', () => {
  const pack = aePack();
  const line = buildLinesBlock({
    pack,
    lines: [{ description: AR_LINE_DESCRIPTION, quantity: 2, unitPrice: 1500, taxRate: 5 }],
    currency: pack.currency.home
  });
  const logical = `${AR_LINE_DESCRIPTION} — 2 × 1,500.00 = 3,000.00 AED (5.00 %)`;
  assert.equal(stripBidiControls(line), logical, 'logical text is byte-for-byte unchanged');
  assert.equal(
    line,
    `${FSI}${AR_LINE_DESCRIPTION}${PDI} — ${LRI}2 × 1,500.00 = 3,000.00 AED (5.00 %)${PDI}`
  );
});

test('AR-4A regression: LTR AE/FI/GB/US line semantics and bytes stay unchanged', () => {
  for (const packId of ['ae', 'fi', 'gb', 'us']) {
    const pack = loadOutboundPack(packId, { bypassCache: true });
    const unit = formatPackAmount(pack, 500);
    const net = formatPackAmount(pack, 1000);
    const line = buildLinesBlock({
      pack,
      lines: [{ description: 'Consulting', quantity: 2, unitPrice: 500, net: 1000 }],
      currency: pack.currency.home
    });
    assert.equal(line, `Consulting — 2 × ${unit} = ${net} ${pack.currency.home}`, packId);
    assert.equal(BIDI_CONTROLS_RE.test(line), false, `${packId}: no gratuitous controls`);
  }
});

// ── The PDF artifact path: Unicode shaping + UAX #9 ─────────────────────────

test('AR-4B2 production proof: shipping AE PDF.js copy/search and structure stay logical', async () => {
  const pack = aePack();
  const artifact = await renderInvoicePdfArtifact({
    pack, language: pack.languages.default, values: arabicInvoiceValues(pack)
  });
  const pdf = await PDFDocument.load(artifact.content);
  assert.equal(Math.round(pdf.getPages()[0].getWidth()), 595, 'AE remains A4');
  assert.match(artifact.content.toString('latin1'), /NotoSansArabic-Regular/);
  assert.doesNotMatch(artifact.content.toString('latin1'), /Helvetica/);
  assert.match(artifact.content.toString('latin1'), /\/StructTreeRoot/);
  assert.match(artifact.content.toString('latin1'), /\/Artifact/);

  const interoperability = await inspectPdfInteroperability(artifact.content);
  const logicalLine = `${AR_LINE_DESCRIPTION} — 2 × 1,500.00 = 3,000.00 AED (5.00 %)`;
  for (const expected of [
    `Billed to: ${AR_PARTY}`,
    logicalLine,
    TRN,
    AE_IBAN,
    '2026-014',
    '31 Aug 2026',
    'billing@example-ae.example',
    'https://example-ae.example/invoices/INV-2026-014'
  ]) {
    assert.ok(interoperability.text.includes(expected), `PDF.js search text includes ${expected}`);
  }
  assert.equal(BIDI_CONTROLS_RE.test(interoperability.text), false,
    'viewer text is control-free logical Unicode');

  const structuredText = interoperability.structureSpans.map(({ text }) => text).join('');
  assert.ok(structuredText.includes(AR_PARTY), 'screen-reader structure keeps the Arabic party');
  assert.ok(structuredText.includes(logicalLine), 'structure keeps the mixed formula logical');
  assert.ok(interoperability.structureSpans.some(({ text, lang }) => (
    /\p{Script=Arabic}/u.test(text) && lang === 'ar'
  )), 'Arabic structure spans declare their language');
  assert.ok(interoperability.structureSpans.some(({ text, lang }) => (
    text.includes(TRN) && lang === 'en'
  )), 'the TRN stays a language-scoped LTR semantic island');
  assert.ok(interoperability.structureSpans.every(({ text }) => !BIDI_CONTROLS_RE.test(text)),
    'structure ActualText is control-free');
});

test('AR-4F production proof: the shipping Arabic PDF paginates and remains searchable', async () => {
  const pack = syntheticArabicPack();
  const proofLines = [
    `${AR_LINE_DESCRIPTION} — 0 × 0.00 = 0.00 AED (0.00 %)`,
    'تسوية دائنة — -1 × 125.50 = -125.50 AED (0.00 %)',
    'أرقام عربية هندية — ١٢٣٤٥٦٧٨٩٠',
    ...Array.from({ length: 45 }, (_, index) => (
      `${AR_LINE_DESCRIPTION} للمرحلة ${index + 1} — 2 × 1,500.00 = 3,000.00 AED (5.00 %)`
    ))
  ];
  const values = bidiSafeRenderValues({
    ...arabicInvoiceValues(pack, 'ar'),
    document_title: documentTitleForInvoice({
      pack, invoice: { seller: { taxRegistered: true } }, language: 'ar'
    }),
    payment_instructions: [
      `${AR_TRN_LABEL}: ${TRN}`,
      `IBAN ${AE_IBAN}`,
      'البريد الإلكتروني: billing@example-ae.example',
      'الرابط: https://example-ae.example/invoices/INV-2026-014'
    ].join('\n'),
    lines_block: proofLines.join('\n')
  });
  // Email/string layer: an RTL TEMPLATE works today — the renderer treats
  // template text and values alike. The Arabic statutory title lands in the
  // subject line.
  const rendered = renderPackTemplate(pack, { template: 'invoice_pdf', language: 'ar', values });
  assert.equal(stripBidiControls(rendered.subject), `${AR_TAX_INVOICE_TITLE} 2026-014`);
  assert.ok(rendered.subject.includes(`${FSI}${AR_TAX_INVOICE_TITLE}${PDI}`));
  assert.ok(rendered.body.includes('تفاصيل الدفع'), 'Arabic template copy renders');
  assert.ok(rendered.body.includes(`${LRI}${AE_IBAN}${PDI}`), 'the AE IBAN is one LTR island');
  // PDF layer: the same shipping variant is shaped and paginated. This
  // proves the engine against the shipping Arabic declaration.
  const artifact = await renderInvoicePdfArtifact({ pack, language: 'ar', values });
  const pdf = await PDFDocument.load(artifact.content);
  assert.ok(pdf.getPageCount() >= 2, 'long Arabic logical lines paginate on A4');
  const interoperability = await inspectPdfInteroperability(artifact.content);
  assert.ok(interoperability.text.startsWith(`${AR_TAX_INVOICE_TITLE} 2026-014`));
  assert.ok(interoperability.text.includes(`تاريخ الإصدار: 31 Aug 2026`),
    'date is one logical LTR island');
  assert.ok(interoperability.text.includes('billing@example-ae.example'), 'email remains logical');
  assert.ok(interoperability.text.includes('https://'), 'URL remains logical');
  assert.ok(interoperability.text.includes(proofLines[0]), 'zero values remain logical');
  assert.ok(interoperability.text.includes(proofLines[1]), 'negative values remain logical');
  assert.ok(interoperability.text.includes(proofLines[2]), 'Arabic-Indic numerals remain logical');
  const structuredText = interoperability.structureSpans.map(({ text }) => text).join('');
  assert.ok(structuredText.includes(AR_TAX_INVOICE_TITLE), 'screen-reader structure is present');
  assert.deepEqual(aePack().languages.supported, ['en', 'ar'], 'the shipping manifest declares the complete Arabic catalog');
});

test('AR-4B3 production proof: standalone Arabic CreditNote is distinct, signed, multipage and logical', async () => {
  const pack = syntheticArabicCreditNotePack();
  const markers = Array.from({ length: 48 }, (_, index) => (
    `بند المرحلة ${String(index + 1).padStart(2, '0')} لخدمات استشارية متخصصة — 1 × -10.00 = -10.00 AED`
  ));
  const westernPresentation = 'عرض بالأرقام الغربية 1234567890';
  const arabicIndicPresentation = 'عرض بالأرقام العربية الهندية ١٢٣٤٥٦٧٨٩٠';
  const values = {
    owner_business_name: 'شركة الساحل للاستشارات ذ.م.م',
    counterparty_name: AR_PARTY,
    credit_note_number: 'AE-CN-2026-0042',
    original_invoice_reference: 'AE-INV-2026-014',
    adjustment_reason: 'تصحيح مقابل خدمات أُعيدت إلى العميل',
    issue_date: '1 Sep 2026',
    currency: 'AED',
    seller_tax_registration_number: TRN,
    buyer_tax_registration_number: '100987654321009',
    seller_iban: AE_IBAN,
    lines_block: [
      'خدمة ملغاة — 0 × 0.00 = 0.00 AED',
      'تسوية دائنة — 1 × -875.25 = -875.25 AED',
      westernPresentation,
      arabicIndicPresentation,
      ...markers
    ].join('\n'),
    credit_note_subtotal_amount: '-1,000.00',
    credit_note_tax_amount: '-50.00',
    credit_note_total_amount: '-1,050.00'
  };
  const artifact = await renderCreditNotePdfArtifact({ pack, language: 'ar', values });
  const isolatedValues = bidiSafeRenderValues(values, { force: true });
  assert.equal(isolatedValues.seller_iban, `${LRI}${values.seller_iban}${PDI}`,
    'the public renderer uses the existing IBAN LTR classifier');
  assert.deepEqual(bidiSafeRenderValues(isolatedValues, { force: true }), isolatedValues,
    'the renderer boundary is byte-idempotent for already isolated values');
  assert.equal(artifact.filename, 'AE-CN-2026-0042.pdf');
  assert.equal(artifact.artifactKind, 'credit_note_pdf');
  assert.equal(artifact.artifactTemplate, 'credit_note_pdf');
  assert.match(artifact.content.toString('latin1'), /NotoSansArabic-Regular/);
  assert.doesNotMatch(artifact.content.toString('latin1'), /Helvetica/);
  assert.match(artifact.content.toString('latin1'), /\/StructTreeRoot/);
  assert.doesNotMatch(artifact.content.toString('latin1'), /\/Subtype\s*\/Image/,
    'semantic text is not rasterized');

  const pdf = await PDFDocument.load(artifact.content);
  assert.equal(pdf.getPageCount(), 2, 'joining-sensitive Arabic CreditNote has the pinned page count');
  const interoperability = await inspectPdfInteroperability(artifact.content);
  for (const expected of [
    'إشعار دائن', values.owner_business_name, values.counterparty_name,
    'خدمة ملغاة', values.adjustment_reason, values.credit_note_number,
    values.original_invoice_reference, values.credit_note_subtotal_amount,
    values.credit_note_tax_amount, values.credit_note_total_amount,
    values.seller_tax_registration_number, values.buyer_tax_registration_number,
    values.seller_iban, values.currency, values.issue_date,
    westernPresentation, arabicIndicPresentation
  ]) {
    assert.ok(interoperability.text.includes(expected), `CreditNote PDF.js text includes ${expected}`);
  }
  assert.equal(BIDI_CONTROLS_RE.test(interoperability.text), false,
    'CreditNote PDF text is control-free logical Unicode');
  assert.equal(interoperability.text.includes('إجمالي الإشعار الدائن: 1,050.00'), false,
    'the signed total is never duplicated as a positive payable amount');
  let prior = -1;
  for (const marker of markers) {
    const index = interoperability.text.indexOf(marker);
    assert.ok(index > prior, `pagination preserves marker order for ${marker}`);
    assert.equal(interoperability.text.split(marker).length - 1, 1,
      `pagination neither drops nor duplicates ${marker}`);
    prior = index;
  }
  const structuredText = interoperability.structureSpans.map(({ text }) => text).join('');
  assert.ok(structuredText.includes(values.adjustment_reason));
  assert.ok(structuredText.includes(markers.at(-1)));
  assert.ok(interoperability.structureSpans.every(({ text }) => !BIDI_CONTROLS_RE.test(text)));

  const manifest = buildAttachmentManifest([artifact]);
  assert.deepEqual(manifest, [{
    filename: artifact.filename,
    content_type: 'application/pdf',
    byte_length: artifact.content.length,
    sha256: createHash('sha256').update(artifact.content).digest('hex'),
    artifact_kind: 'credit_note_pdf',
    artifact_template: 'credit_note_pdf'
  }]);
  assert.deepEqual(aePack().languages.supported, ['en', 'ar'],
    'the shipping AE manifest declares Arabic');
});

test('AR-4B1 UAX proof: Arabic paragraphs right-anchor and LTR islands keep logical run order', () => {
  const date = bidiVisualRuns(`تاريخ الإصدار: ${LRI}31 Aug 2026${PDI}`);
  assert.equal(date.direction, 'rtl');
  assert.deepEqual(date.runs, [
    { direction: 'ltr', text: '31 Aug 2026' },
    { direction: 'rtl', text: 'تاريخ الإصدار: ' }
  ]);
  const formula = bidiVisualRuns(
    `${FSI}${AR_LINE_DESCRIPTION}${PDI} — ${LRI}2 × 1,500.00 = 3,000.00 AED (5.00 %)${PDI}`
  );
  assert.equal(formula.direction, 'rtl', 'control-free first strong sets the paragraph anchor');
  assert.deepEqual(formula.runs, [
    { direction: 'ltr', text: '2 × 1,500.00 = 3,000.00 AED (5.00 %)' },
    { direction: 'rtl', text: ' — ' },
    { direction: 'rtl', text: AR_LINE_DESCRIPTION }
  ]);
});

test('AR-4F renderer closure: bilingual names and Arabic-month dates keep visual x-order', () => {
  const measure = (run) => stripBidiControls(run.text).length;
  const [nameLine] = wrapArabicPdfLine(
    `مُعدّ لصالح: ${FSI}مؤسسة النور للتجارة / Al Noor Trading${PDI}`,
    { measure: (value) => stripBidiControls(value).length, maxWidth: 200 }
  );
  assert.equal(
    nameLine,
    `مُعدّ لصالح: ${FSI}مؤسسة النور للتجارة / Al Noor Trading${PDI}`,
    'wrapping keeps a same-line bilingual value inside one first-strong isolate'
  );
  const name = positionArabicPdfVisualRuns(
    nameLine,
    { measure, lineStart: 100 }
  );
  assert.equal(name.direction, 'rtl');
  assert.deepEqual(
    name.fragments
      .filter(({ text }) => text.trim())
      .sort((left, right) => left.x - right.x)
      .map(({ text, direction }) => ({ text, direction })),
    [
      { text: 'Al', direction: 'ltr' },
      { text: 'Noor', direction: 'ltr' },
      { text: 'Trading', direction: 'ltr' },
      { text: 'مؤسسة النور للتجارة / ', direction: 'rtl' },
      { text: 'مُعدّ لصالح: ', direction: 'rtl' }
    ],
    'Latin words advance left-to-right while the enclosing Arabic phrase reads from the right'
  );

  for (const [date, month] of [
    ['31 أغسطس 2026', ' أغسطس '],
    ['14 سبتمبر 2026', ' سبتمبر ']
  ]) {
    const [dateLine] = wrapArabicPdfLine(
      `التاريخ: ${LRI}${date}${PDI}`,
      { measure: (value) => stripBidiControls(value).length, maxWidth: 200 }
    );
    const positioned = positionArabicPdfVisualRuns(
      dateLine,
      { measure, lineStart: 100 }
    );
    assert.deepEqual(
      positioned.fragments
        .filter(({ text }) => text.trim())
        .sort((left, right) => left.x - right.x)
        .map(({ text }) => text),
      ['2026', month, date.slice(0, 2), 'التاريخ: '],
      `${date} keeps day → month → year in RTL reading order`
    );
  }
});

test('AR-4B1 wrap is joining-safe and malformed or oversized islands fail closed', () => {
  const wrapped = wrapArabicPdfLine(
    `${FSI}خدمات استشارية طويلة للعميل${PDI} — ${LRI}2 × 1,500.00 = 3,000.00 AED${PDI}`,
    { measure: (value) => stripBidiControls(value).length, maxWidth: 45 }
  );
  assert.ok(wrapped.length > 1);
  assert.equal(stripBidiControls(wrapped.join(' ')),
    'خدمات استشارية طويلة للعميل — 2 × 1,500.00 = 3,000.00 AED');
  assert.throws(
    () => wrapArabicPdfLine(`${LRI}${'A'.repeat(40)}${PDI}`, {
      measure: (value) => stripBidiControls(value).length, maxWidth: 20
    }),
    (error) => error?.code === 'OUTBOUND_ARABIC_PDF_LAYOUT_UNSAFE'
  );
  assert.throws(
    () => bidiVisualRuns(`${LRI}${LRI}INV${PDI}${PDI}`),
    (error) => error?.code === 'OUTBOUND_BIDI_ISOLATION_INVALID'
  );
});

test('AR-4B1 font asset is the reviewed official OFL byte payload', async () => {
  const bytes = await readFile(ARABIC_PDF_FONT_URL);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ARABIC_PDF_FONT_SHA256);
});

test('AR-4B1 missing font coverage refuses instead of drawing tofu', async () => {
  const pack = aePack();
  await assert.rejects(
    () => renderInvoicePdfArtifact({
      pack,
      language: pack.languages.default,
      values: {
        ...arabicInvoiceValues(pack),
        counterparty_name: bidiSafeRenderValues({ name: `${AR_PARTY} 🧾` }).name
      }
    }),
    (error) => error?.code === 'OUTBOUND_ARABIC_PDF_LAYOUT_UNSAFE'
      && /U\+1F9FE/.test(error.message)
  );
});

// ── Engine-contract probes: what an ar declaration would require ────────────

test('AR-4F production proof: the statutory title follows the selected shipping language', () => {
  const pack = syntheticArabicPack();
  const title = documentTitleForInvoice({
    pack, invoice: { seller: { taxRegistered: true } }, language: 'ar'
  });
  assert.equal(title, AR_TAX_INVOICE_TITLE);
  assert.ok(containsRtl(title));
  assert.equal(documentTitleForInvoice({
    pack, invoice: { seller: { taxRegistered: false } }, language: 'ar'
  }), 'فاتورة');
  assert.equal(documentTitleForInvoice({
    pack: aePack(), invoice: { seller: { taxRegistered: true } }, language: 'ar'
  }), AR_TAX_INVOICE_TITLE);
  assert.deepEqual(aePack().languages.supported, ['en', 'ar']);
});

test('AR-4F production proof: the shipping ar-AE locale keeps Western digits and uses Arabic month names', () => {
  // The shipping Arabic limb states ar-AE explicitly in the same production
  // contract used by issuance. Pinned
  // against the toolchain's own CLDR (48 at recording): ar-AE resolves
  // numberingSystem 'latn' — amounts keep ASCII digits, matching UAE
  // commercial practice — while month names come back in Arabic script,
  // which drags RTL text into every {{issue_date}}/{{due_date}} value. If a
  // CLDR update flips either of these, AE documents change script — this
  // probe is the canary.
  const arPack = syntheticArabicPack();
  const amount = formatPackAmount(arPack, 1234.56, 'ar');
  assert.equal(amount, '1,234.56', 'Western digits under ar-AE');
  assert.ok(!containsRtl(amount), 'no Arabic-Indic digits in amounts');
  const date = formatPackDate(arPack, '2026-08-31', 'ar');
  assert.ok(containsRtl(date), `ar-AE month names are Arabic script (got: ${date})`);
  // The English limb remains en-AE alongside Arabic.
  const enDate = formatPackDate(aePack(), '2026-08-31');
  assert.equal(enDate, '31 Aug 2026');
});

test('probe: an Arabic invoice number degrades the PDF filename to the fallback stem', () => {
  // The sanitizer strips everything outside [A-Za-z0-9._-]; an all-Arabic
  // number leaves nothing, so the fallback stem names the file. Safe (no
  // mojibake filenames) but lossy — recorded, acceptable as-is.
  assert.equal(
    invoicePdfFilename({ invoiceNumber: 'فاتورة-٢٠٢٦', fallbackStem: 'a-12' }),
    'a-12.pdf'
  );
  assert.equal(invoicePdfFilename({ invoiceNumber: `INV-2026 ${AR_PARTY}` }), 'INV-2026.pdf');
});
