// Unicode Arabic typesetting for outbound PDFs.
//
// pdf-lib's standard fonts are intentionally retained for every LTR-only
// document. When rendered pack text contains Arabic, this module supplies
// the missing Keep-layer mechanics: an offline Unicode font, Unicode Bidi
// Algorithm run ordering, OpenType shaping through PDFKit/fontkit, right
// anchoring for RTL paragraphs, logical-line wrapping and pagination.
//
// The run builder never reverses source strings. bidi-js computes visual run
// order under UAX #9; each run is restored to logical character order before
// fontkit applies contextual Arabic shaping. Visible glyphs are vector
// outlines; a separate tagged nominal-glyph layer keeps Unicode copy/search
// and assistive-technology order logical across PDF consumers. Arabic is still
// not a declared pack language: this is only the rendering substrate needed
// before that later contract can open.

import bidiFactory from 'bidi-js';
import { readFile } from 'node:fs/promises';
import { create as createFont } from 'fontkit';
import PDFDocument from 'pdfkit';

import {
  assertWellFormedBidiIsolation, hasBidiControls, stripBidiControls
} from './bidiText.js';

const bidi = bidiFactory();

export const ARABIC_PDF_FONT_URL = new URL(
  './fonts/NotoSansArabic-wdth-wght.ttf', import.meta.url
);
export const ARABIC_PDF_FONT_SHA256 =
  '63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e';

const SEMANTIC_FONT_PREFIX = 'DonnaNotoSansArabicSemantic';
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const ARABIC_SCRIPT_RE = /\p{Script=Arabic}/u;
const COMBINING_MARK_RE = /\p{Mark}/u;
const LRI = '\u2066';
const FSI = '\u2068';
const ISOLATE_OPENERS = new Set([LRI, '\u2067', FSI]);
const PDI = '\u2069';
const INK = '#1a1c21';
const SEMANTIC_CARRIER_GLYPHS = Object.freeze([
  '.', ',', ':', ';', '!', '?', '+', '=', '*', '#', '@', '%', '&'
]);
const ARABIC_GRAPHEME_SEGMENTER = new Intl.Segmenter('ar', {
  granularity: 'grapheme'
});
const SEMANTIC_SEGMENT_CODE_POINTS = 12;

// The semantic carrier maps neutral nominal glyphs to complete logical
// chunks. Noto Sans Arabic decomposes dotted letters and applies positional
// forms during ordinary shaping; those glyphs are visually correct but cannot
// provide a stable ToUnicode map. Disable every fontkit default feature for the
// invisible carrier only. The visible outline path remains fully shaped.
const SEMANTIC_FONT_FEATURES = Object.freeze({
  ccmp: false,
  locl: false,
  rlig: false,
  isol: false,
  init: false,
  medi: false,
  fina: false,
  mark: false,
  mkmk: false,
  rvrn: false,
  ltra: false,
  ltrm: false,
  frac: false,
  numr: false,
  dnom: false,
  fin2: false,
  fin3: false,
  med2: false,
  mset: false,
  calt: false,
  clig: false,
  liga: false,
  rclt: false,
  curs: false,
  kern: false
});

let fontResourcePromise = null;

const layoutError = (reason) => {
  const error = new Error(`Arabic PDF layout refused: ${reason}`);
  error.code = 'OUTBOUND_ARABIC_PDF_LAYOUT_UNSAFE';
  return error;
};

const loadFontResource = async () => {
  if (!fontResourcePromise) {
    fontResourcePromise = readFile(ARABIC_PDF_FONT_URL).then((bytes) => ({
      bytes,
      font: createFont(bytes)
    }));
  }
  return fontResourcePromise;
};

const reverseRange = (values, start, end) => {
  while (start < end) {
    [values[start], values[end]] = [values[end], values[start]];
    start += 1;
    end -= 1;
  }
};

const firstStrongDirection = (value) => {
  for (const char of stripBidiControls(value)) {
    const type = bidi.getBidiCharTypeName(char);
    if (type === 'R' || type === 'AL') return 'rtl';
    if (type === 'L') return 'ltr';
  }
  return 'ltr';
};

// AR-4A classifies canonical dates as LTR values because their digits and
// punctuation must remain one island in surrounding Arabic prose. Once AR-4D
// localizes the month name, however, that same island contains a strong Arabic
// run: forcing the inside of the island LTR places the year before the month.
// Keep the existing isolate boundary, but let UAX #9 choose the direction of a
// mixed-script LRI from its own first strong character for PDF layout. Pure LTR
// identifiers, amounts, formulae and English-month dates remain unchanged.
const visualBidiSource = (source) => {
  const characters = [...source];
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== LRI) continue;
    const end = characters.indexOf(PDI, index + 1);
    const inner = characters.slice(index + 1, end).join('');
    if (ARABIC_SCRIPT_RE.test(inner)) characters[index] = FSI;
    index = end;
  }
  return characters.join('');
};

// Resolve visual-order directional runs while retaining their source spans.
// The public helper below intentionally exposes only direction/text; the PDF
// semantic layer also needs source order and the unmirrored logical text.
const bidiLayoutRuns = (value) => {
  const source = String(value ?? '');
  if (hasBidiControls(source)) assertWellFormedBidiIsolation(source);
  if (!source) return { direction: 'ltr', logicalText: '', runs: [] };

  const paragraphDirection = firstStrongDirection(source);
  const layoutSource = visualBidiSource(source);
  const embedding = bidi.getEmbeddingLevels(layoutSource, paragraphDirection);
  const visualIndices = Array.from({ length: layoutSource.length }, (_, index) => index);
  for (const [start, end] of bidi.getReorderSegments(layoutSource, embedding)) {
    reverseRange(visualIndices, start, end);
  }
  const mirrored = bidi.getMirroredCharactersMap(layoutSource, embedding);
  const runs = [];
  let pending = null;

  const flush = () => {
    if (!pending) return;
    const indices = [...pending.indices].sort((a, b) => a - b);
    const text = indices.map((index) => mirrored.get(index) || source[index]).join('');
    const logicalText = indices.map((index) => source[index]).join('');
    if (text) {
      runs.push({
        direction: pending.direction,
        text,
        logicalText,
        sourceStart: indices[0],
        sourceEnd: indices[indices.length - 1]
      });
    }
    pending = null;
  };

  for (const index of visualIndices) {
    const char = layoutSource[index];
    if (BIDI_CONTROL_RE.test(char)) {
      flush();
      continue;
    }
    const direction = (embedding.levels[index] & 1) ? 'rtl' : 'ltr';
    const step = direction === 'rtl' ? -1 : 1;
    const contiguous = pending
      && pending.direction === direction
      && index === pending.indices[pending.indices.length - 1] + step;
    if (!contiguous) {
      flush();
      pending = { direction, indices: [] };
    }
    pending.indices.push(index);
  }
  flush();

  return {
    direction: paragraphDirection,
    logicalText: stripBidiControls(source),
    runs
  };
};

// Return visual-order directional runs while keeping every run's characters
// in logical order for the shaping engine. Direction is the paragraph's
// resolved first-strong base direction.
export const bidiVisualRuns = (value) => {
  const layout = bidiLayoutRuns(value);
  return {
    direction: layout.direction,
    logicalText: layout.logicalText,
    runs: layout.runs.map(({ direction, text }) => ({ direction, text }))
  };
};

const shapingFragmentsForRun = (run) => {
  if (run.direction !== 'ltr') return [run.text];
  const fragments = run.text.split(/(\s+)/u).filter(Boolean);
  return fragments.length ? fragments : [run.text];
};

// Position the exact visual fragments consumed by the outline painter. An LTR
// run advances word-by-word in logical order while each word retains ordinary
// LTR shaping; no source string is reversed. The renderer calls this helper
// directly, so tests can pin x-order without interpreting vector outlines.
export const positionArabicPdfVisualRuns = (
  value,
  { measure, lineStart = 0 }
) => {
  const layout = bidiLayoutRuns(value);
  const runs = [];
  const fragments = [];
  let x = lineStart;
  for (const run of layout.runs) {
    const runX = x;
    for (const text of shapingFragmentsForRun(run)) {
      const fragment = { direction: run.direction, text };
      const width = measure(fragment);
      fragments.push({ ...fragment, x, width });
      x += width;
    }
    runs.push({ ...run, x: runX, width: x - runX });
  }
  return {
    direction: layout.direction,
    logicalText: layout.logicalText,
    totalWidth: x - lineStart,
    runs,
    fragments
  };
};

const logicalWrapTokens = (value) => {
  const source = String(value ?? '');
  if (hasBidiControls(source)) assertWellFormedBidiIsolation(source);
  const tokens = [];
  let plain = '';
  let isolateGroup = 0;
  const flushPlain = () => {
    if (plain) tokens.push({ text: plain, opener: null, group: null });
    plain = '';
  };

  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (/\s/u.test(char)) {
      flushPlain();
      index += 1;
      continue;
    }
    if (!ISOLATE_OPENERS.has(char)) {
      plain += char;
      index += 1;
      continue;
    }

    flushPlain();
    const end = source.indexOf(PDI, index + 1);
    const inner = source.slice(index + 1, end);
    isolateGroup += 1;
    // LTR data islands (dates, identifiers, formulas, email addresses and
    // URLs) are indivisible. Free prose may wrap at spaces; each resulting
    // line keeps one shared RTL/first-strong boundary so an embedded Latin
    // phrase such as a bilingual business name retains its internal order.
    if (char === '\u2066') {
      tokens.push({ text: inner, opener: char, group: isolateGroup });
    } else {
      for (const word of inner.trim().split(/\s+/u).filter(Boolean)) {
        tokens.push({ text: word, opener: char, group: isolateGroup });
      }
    }
    index = end + 1;
  }
  flushPlain();
  return tokens;
};

const serializeWrapTokens = (tokens) => {
  const chunks = [];
  for (const token of tokens) {
    const previous = chunks[chunks.length - 1];
    if (token.group !== null && previous?.group === token.group) {
      previous.text += ` ${token.text}`;
      continue;
    }
    chunks.push({ ...token });
  }
  return chunks.map(({ text, opener }) => (
    opener ? `${opener}${text}${PDI}` : text
  )).join(' ');
};

const assertFontCoverage = (font, value) => {
  for (const char of stripBidiControls(value)) {
    if (char === '\n' || char === '\r' || char === '\t') continue;
    if (!font.hasGlyphForCodePoint(char.codePointAt(0))) {
      throw layoutError(`font has no glyph for U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
};

// Wrap in logical word order, then run UAX #9 independently on every visual
// line as required by rule L1. A word that cannot fit is refused rather than
// cut through a joining sequence, URL or identifier.
export const wrapArabicPdfLine = (value, { measure, maxWidth }) => {
  const text = String(value ?? '');
  if (!text.trim()) return [''];
  const words = logicalWrapTokens(text);
  const lines = [];
  let current = [];
  for (const word of words) {
    if (measure(serializeWrapTokens([word])) > maxWidth) {
      throw layoutError(`unbreakable token exceeds ${maxWidth.toFixed(2)}pt`);
    }
    const candidate = [...current, word];
    if (current.length && measure(serializeWrapTokens(candidate)) > maxWidth) {
      lines.push(serializeWrapTokens(current));
      current = [word];
    } else {
      current = candidate;
    }
  }
  lines.push(serializeWrapTokens(current));
  return lines;
};

const collectPdf = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const drawGlyphOutline = ({ doc, glyph, position, cursorX, baselineY, scale }) => {
  const transform = (x, y) => [
    cursorX + (position.xOffset + x) * scale,
    baselineY - (position.yOffset + y) * scale
  ];
  for (const command of glyph.path.commands) {
    const points = [];
    for (let index = 0; index < command.args.length; index += 2) {
      points.push(...transform(command.args[index], command.args[index + 1]));
    }
    if (command.command === 'moveTo') doc.moveTo(...points);
    else if (command.command === 'lineTo') doc.lineTo(...points);
    else if (command.command === 'quadraticCurveTo') doc.quadraticCurveTo(...points);
    else if (command.command === 'bezierCurveTo') doc.bezierCurveTo(...points);
    else if (command.command === 'closePath') doc.closePath();
    else throw layoutError(`unsupported font path command ${command.command}`);
  }
};

const drawShapedRunOutline = ({ doc, font, run, x, y, size }) => {
  const shaped = font.layout(run.text, undefined, undefined, undefined, run.direction);
  const scale = size / font.unitsPerEm;
  const baselineY = y + font.ascent * scale;
  let cursorX = x;
  for (let index = 0; index < shaped.glyphs.length; index += 1) {
    drawGlyphOutline({
      doc,
      glyph: shaped.glyphs[index],
      position: shaped.positions[index],
      cursorX,
      baselineY,
      scale
    });
    cursorX += shaped.positions[index].xAdvance * scale;
  }
};

const createSemanticFont = (
  font,
  language,
  identity,
  replacementSegments
) => new Proxy(font, {
  get(target, property) {
    // PDFKit normally de-duplicates fontkit objects with identical source
    // tables. A distinct semantic identity prevents dotted Arabic composites
    // from sharing one subset CID with their undotted base character.
    if (property === '_tables') {
      const tables = Reflect.get(target, property, target);
      return {
        ...tables,
        name: {
          ...tables.name,
          records: {
            ...tables.name?.records,
            donnaSemanticIdentity: identity
          }
        }
      };
    }
    if (property === 'layout') {
      return (text) => {
        const run = target.layout(
          text,
          { ...SEMANTIC_FONT_FEATURES },
          undefined,
          language,
          'ltr'
        );
        run.glyphs = run.glyphs.map((glyph, index) => new Proxy(glyph, {
          get(glyphTarget, glyphProperty) {
            if (glyphProperty === 'codePoints') {
              return [...(replacementSegments[index] || '')]
                .map((char) => char.codePointAt(0));
            }
            return Reflect.get(glyphTarget, glyphProperty, glyphTarget);
          }
        }));
        return run;
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }
});

const semanticTokensForRun = (run) => {
  if (run.direction === 'ltr' || !ARABIC_SCRIPT_RE.test(run.logicalText)) {
    return [run.logicalText];
  }
  // One carrier object per directional run keeps base letters and every
  // combining mark in the same PDF text object. Reassemble through the
  // segmenter so a future token-boundary change cannot split an extended
  // grapheme by accident.
  return [[...ARABIC_GRAPHEME_SEGMENTER.segment(run.logicalText)]
    .map(({ segment }) => segment)
    .join('')];
};

const semanticCarrierSegments = (value, hasArabic) => {
  if (!hasArabic) return [value];
  const embedding = bidi.getEmbeddingLevels(value, 'rtl');
  const visualCodePoints = [...bidi.getReorderedString(value, embedding)];
  if (!COMBINING_MARK_RE.test(value)) return [visualCodePoints.join('')];
  const segments = [];
  for (let start = 0; start < visualCodePoints.length;) {
    let end = Math.min(
      start + SEMANTIC_SEGMENT_CODE_POINTS,
      visualCodePoints.length
    );
    // UAX #9 places a mark before its base in the visual carrier sequence.
    // Never cut between that pair: PDF.js must see them in one text object and
    // one ToUnicode destination before it restores logical reading order.
    while (end < visualCodePoints.length && /\p{Mark}/u.test(visualCodePoints[end - 1])) {
      end -= 1;
    }
    if (end === start) end = Math.min(start + 2, visualCodePoints.length);
    segments.push(visualCodePoints.slice(start, end).join(''));
    start = end;
  }
  return segments;
};

// Typeset already-rendered pack content. Page dimensions and typography are
// passed by invoicePdfArtifact so there is still one document layout policy.
export const typesetArabicPdfTemplate = async ({
  rendered, dimensions, margin, titleSize, bodySize, lineHeight, language
}) => {
  const [width, height] = dimensions;
  const logicalDocument = `${rendered.subject}\n${rendered.body}`;
  const { bytes, font } = await loadFontResource();
  // fontkit glyph objects retain the source code points assigned by the most
  // recent shaping substitution. Keep the nominal semantic font on a separate
  // instance so visual decomposition (for example ذ -> د + dot) cannot mutate
  // its ToUnicode evidence.
  const semanticBaseFont = createFont(bytes);
  assertFontCoverage(font, logicalDocument);

  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: false,
    pdfVersion: '1.7',
    tagged: true,
    fontLayoutCache: false,
    lang: language,
    info: {
      Title: stripBidiControls(rendered.subject),
      Creator: 'Donna',
      Producer: 'Donna outbound PDF renderer'
    }
  });
  const completed = collectPdf(doc);
  const documentStructure = doc.struct('Document', { lang: language });
  doc.addStructure(documentStructure);
  let semanticFontIndex = 0;

  // Keep measurement on the same direction-pinned fontkit layout that paints
  // the outlines. Registering this shaped font with PDFKit would let PDFKit
  // de-duplicate the later nominal semantic font by PostScript name, silently
  // restoring the broken contextual-glyph ToUnicode map.
  const widthOfRun = (run, size) => (
    font.layout(run.text, undefined, undefined, undefined, run.direction).advanceWidth
      * size / font.unitsPerEm
  );
  const visualWidth = (value, size) => positionArabicPdfVisualRuns(value, {
    measure: (run) => widthOfRun(run, size)
  }).totalWidth;

  let y;
  const addPage = () => {
    doc.addPage({ size: [width, height], margin: 0 });
    doc.fillColor(INK);
    y = margin;
  };
  addPage();

  const ensureRoom = (needed) => {
    if (y + needed <= height - margin) return;
    addPage();
  };

  const drawLogicalLine = (line, size, structureType) => {
    const measuredLayout = positionArabicPdfVisualRuns(line, {
      measure: (run) => widthOfRun(run, size)
    });
    const { totalWidth } = measuredLayout;
    const lineX = measuredLayout.direction === 'rtl'
      ? width - margin - totalWidth
      : margin;

    if (measuredLayout.logicalText) {
      const positionedLayout = positionArabicPdfVisualRuns(line, {
        measure: (run) => widthOfRun(run, size),
        lineStart: lineX
      });
      const positionedRuns = positionedLayout.runs;

      // Visible content is vector-only so broken ToUnicode guesses from
      // contextual Arabic glyphs cannot leak into selection/search. The same
      // reviewed fontkit layout and positions still paint the page.
      doc.markContent('Artifact', {
        type: 'Layout',
        bbox: [lineX, y, lineX + totalWidth, y + size + 4]
      });
      for (const fragment of positionedLayout.fragments) {
        drawShapedRunOutline({ doc, font, run: fragment, x: fragment.x, y, size });
      }
      doc.fill(INK);
      doc.endMarkedContent();

      // Real tagged content follows source order. Each directional run maps
      // through an unshaped nominal carrier whose UAX #9 visual sequence is
      // assembled from whole graphemes. PDF consumers recover logical text,
      // while the structure tree exposes logical ActualText and language.
      const semanticRuns = [...positionedRuns].sort(
        (left, right) => left.sourceStart - right.sourceStart
      );
      const semanticChunks = [];
      for (const run of semanticRuns) {
        const tokens = semanticTokensForRun(run);
        const measured = tokens.map((token) => widthOfRun({
          direction: run.direction,
          text: token
        }, size));
        const measuredTotal = measured.reduce((sum, tokenWidth) => sum + tokenWidth, 0);
        const fit = measuredTotal > 0 ? run.width / measuredTotal : 1;
        tokens.forEach((logicalText, index) => {
          const targetWidth = measured[index] * fit;
          if (/^\s+$/u.test(logicalText) && semanticChunks.length > 0) {
            const previous = semanticChunks[semanticChunks.length - 1];
            previous.logicalText += logicalText;
            previous.targetWidth += targetWidth;
            previous.trailingGapWidth += targetWidth;
            return;
          }
          const hasArabic = ARABIC_SCRIPT_RE.test(logicalText);
          const leadingWhitespace = run.direction === 'rtl' && !hasArabic
            ? logicalText.match(/^\s+/u)?.[0] || ''
            : '';
          const leadingGapWidth = leadingWhitespace
            ? widthOfRun({ direction: run.direction, text: leadingWhitespace }, size) * fit
            : 0;
          const trailingWhitespace = hasArabic
            ? logicalText.match(/\s+$/u)?.[0] || ''
            : '';
          const trailingGapWidth = trailingWhitespace
            ? widthOfRun({ direction: run.direction, text: trailingWhitespace }, size) * fit
            : 0;
          const extractionSource = trailingWhitespace
            ? logicalText.slice(0, -trailingWhitespace.length)
            : logicalText;
          const extractionText = trailingWhitespace
            ? extractionSource
            : logicalText.slice(leadingWhitespace.length);
          semanticChunks.push({
            direction: run.direction,
            logicalText,
            extractionText,
            extractionSegments: semanticCarrierSegments(extractionText, hasArabic),
            language: hasArabic ? 'ar' : language,
            leadingGapWidth,
            targetWidth,
            trailingGapWidth
          });
        });
      }

      // A PDF.js text item whose logical value begins with a combining mark
      // has zero inferred width. If a later carrier follows on the same line,
      // PDF.js inserts a synthetic boundary between the base/mark word and the
      // rest of the sentence. Keep any marked logical line in one carrier so
      // the only inferred boundary is the real line boundary. The carrier's
      // source and ActualText remain control-free logical text.
      if (COMBINING_MARK_RE.test(measuredLayout.logicalText)) {
        const logicalText = measuredLayout.logicalText;
        semanticChunks.splice(0, semanticChunks.length, {
          direction: measuredLayout.direction,
          logicalText,
          extractionText: logicalText,
          extractionSegments: semanticCarrierSegments(logicalText, true),
          language: 'ar',
          leadingGapWidth: 0,
          targetWidth: totalWidth,
          trailingGapWidth: 0
        });
      }

      // Content-stream geometry follows logical reading order too. PDF.js
      // treats a leftward jump as a new visual fragment and drops intervening
      // whitespace; laying the invisible carriers across the same line box in
      // source order keeps phrase search and copy/paste byte-meaningful.
      let semanticX = lineX;
      for (const chunk of semanticChunks) {
        chunk.logicalX = semanticX;
        chunk.x = semanticX + chunk.leadingGapWidth;
        chunk.carrierWidth = chunk.targetWidth
          - chunk.leadingGapWidth
          - chunk.trailingGapWidth;
        semanticX += chunk.targetWidth;
      }

      const block = doc.struct(structureType, {
        lang: language,
        bbox: [lineX, y, lineX + totalWidth, y + size + 4]
      });
      documentStructure.add(block);
      for (const chunk of semanticChunks) {
        const span = doc.struct('Span', {
          actual: chunk.logicalText,
          lang: chunk.language,
          bbox: [chunk.logicalX, y, chunk.logicalX + chunk.targetWidth, y + size + 4]
        });
        block.add(span);
        const content = doc.markStructureContent('Span', {
          actual: chunk.logicalText,
          lang: chunk.language
        });
        const semanticKey = `${chunk.direction}:${semanticFontIndex}:${chunk.extractionText}`;
        const semanticFontName = `${SEMANTIC_FONT_PREFIX}${semanticFontIndex}`;
        if (chunk.extractionSegments.length > SEMANTIC_CARRIER_GLYPHS.length) {
          throw layoutError('semantic text exceeds carrier capacity');
        }
        const carrierText = SEMANTIC_CARRIER_GLYPHS
          .slice(0, chunk.extractionSegments.length)
          .join('');
        semanticFontIndex += 1;
        doc.registerFont(
          semanticFontName,
          createSemanticFont(
            semanticBaseFont,
            chunk.language,
            semanticKey,
            chunk.extractionSegments
          )
        );
        doc.font(semanticFontName).fontSize(size);
        const semanticWidth = doc.widthOfString(carrierText);
        const horizontalScaling = semanticWidth > 0
          ? (chunk.carrierWidth / semanticWidth)
            * 100
          : 100;
        doc.fillOpacity(0);
        doc.text(carrierText, chunk.x, y, {
          horizontalScaling,
          lineBreak: false
        });
        doc.fillOpacity(1);
        doc.endMarkedContent();
        span.add(content).end();
      }
      block.end();
    }
  };

  const drawWrapped = (rawLine, size, advance, structureType) => {
    const lines = wrapArabicPdfLine(rawLine, {
      measure: (value) => visualWidth(value, size),
      maxWidth: width - margin * 2
    });
    for (const line of lines) {
      ensureRoom(advance);
      if (line) drawLogicalLine(line, size, structureType);
      y += advance;
    }
  };

  drawWrapped(rendered.subject, titleSize, titleSize + 8, 'H1');
  y += lineHeight / 2;
  for (const rawLine of String(rendered.body).split('\n')) {
    drawWrapped(rawLine, bodySize, lineHeight, 'P');
  }

  documentStructure.end();
  doc.end();
  return {
    content: await completed,
    contentType: 'application/pdf'
  };
};
