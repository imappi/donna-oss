// The issuance PDF artifacts plus AR-4B3's standalone, send-inert CreditNote
// seam (the named M2 honest-scope follow-ups: "pack
// email IS the invoice v1" — these are v2, the printable/archivable form of
// the SAME pack-authored content). Pack-driven by construction: each artifact
// typesets its pack TEMPLATE ('invoice_pdf' for invoices, 'quote_pdf' for
// quotes, and optionally 'credit_note_pdf') — subject = the document title
// line, body = the document-toned
// content — rendered through THE template renderer (same closed token
// vocabulary, same fail-closed refusal on an unresolved token, same
// per-entity language selection at the call site). The physical page is pack
// data too (documents.invoice_pdf.page / documents.quote_pdf.page, validated
// against KNOWN_PDF_PAGE_SIZES at load) — a size default in core would be
// exactly the shape creep risk #9 names. The quote artifact carries no
// reference and no payment block (a quote is not payable yet) — that is
// template DATA, enforced by what the pack authors, not by code.
//
// Deterministic typesetting, no external calls, no LLM — pure Keep layer.
// The FI-only finland/invoicePdf.js lane (G11, with the virtuaaliviivakoodi)
// is a SEPARATE artifact for the finland/ issuance lane and stays untouched.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { typesetArabicPdfTemplate } from './arabicPdfText.js';
import { bidiSafeRenderValues, containsRtl, hasBidiControls } from './bidiText.js';
import {
  CREDIT_NOTE_PDF_ALLOWED_TOKENS,
  CREDIT_NOTE_PDF_REQUIRED_TOKENS,
  correspondenceLocaleForPack,
  creditNotePdfPageForPack,
  creditNotePdfTitleForPack,
  invoicePdfPageForPack,
  quotePdfPageForPack,
  renderPackTemplate,
  textDirectionForLocale
} from './packs.js';

// Physical page dimensions in PDF points, keyed by the pack-declared size.
const PAGE_DIMENSIONS = Object.freeze({
  a4: Object.freeze([595.28, 841.89]),
  letter: Object.freeze([612, 792])
});

const MARGIN = 56;
const TITLE_SIZE = 16;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 16;

// Greedy word wrap at the content width; a single overlong word is hard-cut
// so it can never overflow the page.
const wrapLine = (line, { font, size, maxWidth }) => {
  const text = String(line ?? '');
  if (!text.trim()) return [''];
  const out = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    let piece = word;
    while (font.widthOfTextAtSize(piece, size) > maxWidth) {
      let cut = piece.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(piece.slice(0, cut), size) > maxWidth) cut -= 1;
      out.push(current ? `${current} ${piece.slice(0, cut)}`.trim() : piece.slice(0, cut));
      current = '';
      piece = piece.slice(cut);
    }
    const candidate = current ? `${current} ${piece}` : piece;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      out.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  out.push(current);
  return out;
};

// Filename from the document number alone (no words — nothing to localize):
// path-hostile characters collapse to '-', with the action id as the
// fallback stem when the number yields nothing usable.
const pdfFilenameFromNumber = (number, fallbackStem) => {
  const stem = String(number ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return `${stem || String(fallbackStem ?? 'document')}.pdf`;
};

export const invoicePdfFilename = ({ invoiceNumber, fallbackStem }) =>
  pdfFilenameFromNumber(invoiceNumber, fallbackStem ?? 'invoice');

export const quotePdfFilename = ({ quoteNumber, fallbackStem }) =>
  pdfFilenameFromNumber(quoteNumber, fallbackStem ?? 'quote');

export const creditNotePdfFilename = ({ creditNoteNumber, fallbackStem }) =>
  pdfFilenameFromNumber(creditNoteNumber, fallbackStem ?? 'credit-note');

const creditNoteContractError = (code, reason) => {
  const error = new Error(`CreditNote PDF contract refused: ${reason}`);
  error.code = code;
  return error;
};

// Typeset a rendered template onto the pack-declared page. Throws on an
// unresolved token (the renderer's fail-closed contract) or a pack without
// the template/page declaration — callers decide the degrade posture.
const typesetPackTemplate = async ({ pack, template, page, language, values }) => {
  const rendered = renderPackTemplate(pack, { template, language, values });
  const dimensions = PAGE_DIMENSIONS[page];
  if (!dimensions) {
    throw new Error(`${template} page size '${page}' is not typesettable`);
  }
  const [width, height] = dimensions;

  // Keep the existing byte/semantic path untouched for every LTR-only
  // document. Only a document that actually contains RTL text crosses the
  // Unicode font + shaping + UAX #9 boundary.
  if (containsRtl(`${rendered.subject}\n${rendered.body}`)
      || hasBidiControls(`${rendered.subject}\n${rendered.body}`)) {
    return typesetArabicPdfTemplate({
      rendered, dimensions, margin: MARGIN,
      titleSize: TITLE_SIZE, bodySize: BODY_SIZE, lineHeight: LINE_HEIGHT,
      language
    });
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.11, 0.13);
  const maxWidth = width - MARGIN * 2;

  let sheet = pdf.addPage([width, height]);
  let y = height - MARGIN;
  const ensureRoom = (needed) => {
    if (y - needed >= MARGIN) return;
    sheet = pdf.addPage([width, height]);
    y = height - MARGIN;
  };

  for (const titleLine of wrapLine(rendered.subject, { font: bold, size: TITLE_SIZE, maxWidth })) {
    ensureRoom(TITLE_SIZE + 8);
    sheet.drawText(titleLine, { x: MARGIN, y, size: TITLE_SIZE, font: bold, color: ink });
    y -= TITLE_SIZE + 8;
  }
  y -= LINE_HEIGHT / 2;

  for (const rawLine of String(rendered.body).split('\n')) {
    for (const line of wrapLine(rawLine, { font, size: BODY_SIZE, maxWidth })) {
      ensureRoom(LINE_HEIGHT);
      if (line) sheet.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font, color: ink });
      y -= LINE_HEIGHT;
    }
  }

  const bytes = await pdf.save();
  return { content: Buffer.from(bytes), contentType: 'application/pdf' };
};

// The invoice artifact: the pack's 'invoice_pdf' template on the pack's
// invoice page.
export const renderInvoicePdfArtifact = async ({ pack, language, values = {} }) => {
  const typeset = await typesetPackTemplate({
    pack, template: 'invoice_pdf', page: invoicePdfPageForPack(pack), language, values
  });
  return {
    filename: invoicePdfFilename({ invoiceNumber: values.invoice_number, fallbackStem: null }),
    ...typeset
  };
};

// The quote artifact: the pack's 'quote_pdf' template on the pack's quote
// page. Same typesetting, same degrade contract at the caller.
export const renderQuotePdfArtifact = async ({ pack, language, values = {} }) => {
  const typeset = await typesetPackTemplate({
    pack, template: 'quote_pdf', page: quotePdfPageForPack(pack), language, values
  });
  return {
    filename: quotePdfFilename({ quoteNumber: values.quote_number, fallbackStem: null }),
    ...typeset
  };
};

// AR-4B3's standalone, send-inert CreditNote artifact. This entry point owns
// only deterministic presentation: the caller supplies already-authorized,
// signed economics and the pack supplies the exact title/template/page.
export const renderCreditNotePdfArtifact = async ({ pack, language, values = {} }) => {
  const page = creditNotePdfPageForPack(pack);
  const documentTitle = creditNotePdfTitleForPack(pack, language);
  const suppliedTitle = values?.document_title;
  if (suppliedTitle !== undefined && suppliedTitle !== null
      && String(suppliedTitle).trim() !== '' && String(suppliedTitle) !== documentTitle) {
    throw creditNoteContractError(
      'OUTBOUND_CREDIT_NOTE_PDF_TITLE_MISMATCH',
      'caller-supplied document_title does not byte-equal the pack title'
    );
  }

  const renderValues = { ...(values || {}), document_title: documentTitle };
  for (const key of Object.keys(renderValues)) {
    if (!CREDIT_NOTE_PDF_ALLOWED_TOKENS.includes(key)) {
      throw creditNoteContractError(
        'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID',
        `render value '${key}' is outside the closed CreditNote vocabulary`
      );
    }
  }
  for (const key of CREDIT_NOTE_PDF_REQUIRED_TOKENS) {
    const value = renderValues[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw creditNoteContractError(
        'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID',
        `required render value '${key}' is unresolved`
      );
    }
  }

  const locale = correspondenceLocaleForPack(pack, language);
  const direction = textDirectionForLocale(locale);
  if (!locale || !['ltr', 'rtl'].includes(direction)) {
    throw creditNoteContractError(
      'OUTBOUND_CREDIT_NOTE_PDF_CONTRACT_INVALID',
      `language '${String(language || '')}' has no coherent locale/direction`
    );
  }
  const safeValues = bidiSafeRenderValues(renderValues, { force: direction === 'rtl' });
  const typeset = await typesetPackTemplate({
    pack, template: 'credit_note_pdf', page, language, values: safeValues
  });
  return Object.freeze({
    filename: creditNotePdfFilename({
      creditNoteNumber: renderValues.credit_note_number,
      fallbackStem: null
    }),
    ...typeset,
    artifactKind: 'credit_note_pdf',
    artifactTemplate: 'credit_note_pdf'
  });
};
