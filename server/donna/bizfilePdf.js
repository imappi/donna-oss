import zlib from 'node:zlib';

const ASCII_DECODER = new TextDecoder('latin1');

const normalizeText = (text = '') =>
  text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const bufferIndexOf = (buffer, token, from = 0) => buffer.indexOf(Buffer.from(token), from);

const isSkippableBinaryStream = (dictionary = '') =>
  /\/Subtype\s*\/Image/.test(dictionary) ||
  /\/Length1\b/.test(dictionary) ||
  /\/Type\s*\/ObjStm/.test(dictionary) ||
  /\/Type\s*\/XRef/.test(dictionary) ||
  /<<\s*\/N\s+\d+\s*\/Filter/.test(dictionary);

const streamDataStart = (buffer, streamIndex) => {
  let start = streamIndex + 'stream'.length;
  if (buffer[start] === 13 && buffer[start + 1] === 10) return start + 2;
  if (buffer[start] === 13 || buffer[start] === 10) return start + 1;
  return start;
};

const readPdfStreams = (buffer) => {
  const streams = [];
  let searchFrom = 0;
  let streamIndex = bufferIndexOf(buffer, 'stream', searchFrom);

  while (streamIndex !== -1) {
    const dictionaryStart = buffer.lastIndexOf(Buffer.from('<<'), streamIndex);
    const endStreamIndex = bufferIndexOf(buffer, 'endstream', streamIndex);
    if (dictionaryStart === -1 || endStreamIndex === -1) break;

    const dictionary = ASCII_DECODER.decode(buffer.slice(dictionaryStart, streamIndex));
    const declaredLength = Number(dictionary.match(/\/Length\s+(\d+)/)?.[1] || 0);
    const dataStart = streamDataStart(buffer, streamIndex);
    let dataEnd = declaredLength
      ? Math.min(dataStart + declaredLength, endStreamIndex)
      : endStreamIndex;

    while (dataEnd > dataStart && (buffer[dataEnd - 1] === 13 || buffer[dataEnd - 1] === 10)) {
      dataEnd -= 1;
    }

    const raw = buffer.slice(dataStart, dataEnd);
    let content = null;

    if (!isSkippableBinaryStream(dictionary)) {
      try {
        const decoded = dictionary.includes('/FlateDecode') ? zlib.inflateSync(raw) : raw;
        content = ASCII_DECODER.decode(decoded);
      } catch {
        content = null;
      }
    }

    if (content) streams.push({ dictionary, content });

    searchFrom = endStreamIndex + 'endstream'.length;
    streamIndex = bufferIndexOf(buffer, 'stream', searchFrom);
  }

  return streams;
};

const unicodeFromHex = (hex = '') => {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length === 2) {
    const codePoint = parseInt(clean, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
  }

  const codeUnits = [];
  for (let index = 0; index + 3 < clean.length; index += 4) {
    const codeUnit = parseInt(clean.slice(index, index + 4), 16);
    if (Number.isFinite(codeUnit)) codeUnits.push(codeUnit);
  }
  return codeUnits.length ? String.fromCharCode(...codeUnits) : '';
};

const unicodeRangeValue = (hex = '', offset = 0) => {
  const clean = hex.replace(/\s+/g, '');
  const codePoint = parseInt(clean, 16);
  if (!Number.isFinite(codePoint)) return '';
  return String.fromCodePoint(codePoint + offset);
};

const cmapCodeWidths = (cmap) => {
  if (!cmap?.size) return [4];
  return Array.from(
    new Set(
      Array.from(cmap.keys(), (code) => {
        if (code <= 0xff) return 2;
        if (code <= 0xffff) return 4;
        if (code <= 0xffffff) return 6;
        return 8;
      })
    )
  ).sort((a, b) => b - a);
};

const decodeHexString = (hex = '', cmap = null) => {
  const clean = hex.replace(/\s+/g, '');
  const values = [];
  const widths = cmapCodeWidths(cmap);
  const fallbackWidth = widths[widths.length - 1] || 2;
  let index = 0;

  while (index < clean.length) {
    const width =
      widths.find((candidate) => {
        if (index + candidate > clean.length) return false;
        return cmap?.has(parseInt(clean.slice(index, index + candidate), 16));
      }) || fallbackWidth;
    const pair = clean.slice(index, index + width);
    if (pair.length === width) values.push(parseInt(pair, 16));
    index += width;
  }

  return values;
};

const readableScore = (text = '') =>
  (text.match(/[A-Za-z0-9 ,./&()#:$-]/g) || []).length -
  (text.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length * 20;

const decodePdfLiteralString = (value = '') =>
  String(value)
    .replace(/\\\r?\n/g, '')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\([()\\])/g, '$1');

const decodeHexBytes = (hex = '') => {
  const clean = hex.replace(/\s+/g, '');
  const bytes = [];
  for (let index = 0; index < clean.length; index += 2) {
    const pair = clean.slice(index, index + 2);
    if (pair.length === 2) bytes.push(parseInt(pair, 16));
  }

  if (!bytes.length) return '';

  const latin = ASCII_DECODER.decode(Buffer.from(bytes)).replace(/\u0000/g, '');
  const utf16 = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const code = bytes[index] * 256 + bytes[index + 1];
    if (code > 0) utf16.push(String.fromCodePoint(code));
  }
  const utf16Text = utf16.join('');

  return readableScore(utf16Text) > readableScore(latin) ? utf16Text : latin;
};

const parseCMap = (content = '') => {
  const map = new Map();

  for (const block of content.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(match[1], 16), unicodeFromHex(match[2]));
    }
  }

  for (const block of content.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+\[((?:\s*<[0-9A-Fa-f]+>\s*)+)\]/g)) {
      const start = parseInt(match[1], 16);
      const end = parseInt(match[2], 16);
      const values = Array.from(match[3].matchAll(/<([0-9A-Fa-f]+)>/g), (valueMatch) =>
        unicodeFromHex(valueMatch[1])
      );
      for (let code = start; code <= end; code += 1) {
        map.set(code, values[code - start] || '');
      }
    }

    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(match[1], 16);
      const end = parseInt(match[2], 16);
      for (let code = start; code <= end; code += 1) {
        map.set(code, unicodeRangeValue(match[3], code - start));
      }
    }
  }

  return map;
};

const permutations = (items) => {
  if (items.length <= 1) return [items];
  const results = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    permutations(rest).forEach((tail) => results.push([item, ...tail]));
  });
  return results;
};

const decodeCodes = (codes, cmap) =>
  codes.map((code) => cmap?.get(code) || '').join('');

const decodeHexText = (hex, cmap) => {
  const mapped = cmap ? decodeCodes(decodeHexString(hex, cmap), cmap) : '';
  const decoded = decodeHexBytes(hex);
  return readableScore(mapped) >= readableScore(decoded) ? mapped : decoded;
};

// TJ-array adjustment threshold: numbers in a TJ array are position
// adjustments in 1/1000 em. Per PDF spec, a positive number subtracts from
// the x-coordinate (tighter kerning) and a negative number widens the gap.
// Letter-spacing kerns are typically tiny (e.g. -50). A number more negative
// than this threshold is interpreted as a word boundary and emits a space.
const TJ_WORD_BOUNDARY_THRESHOLD = -150;

const decodeTextArray = (content = '', cmap) => {
  const parts = [];
  for (const match of content.matchAll(
    /\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>|(-?\d+(?:\.\d+)?)/g
  )) {
    const token = match[0];
    if (token.startsWith('<')) {
      parts.push(decodeHexText(match[1], cmap));
    } else if (token.startsWith('(')) {
      parts.push(decodePdfLiteralString(token.slice(1, -1)));
    } else if (parseFloat(token) < TJ_WORD_BOUNDARY_THRESHOLD) {
      parts.push(' ');
    }
  }
  return parts.join('');
};

const extractGlyphs = (contentStreams, fontMaps) => {
  const glyphs = [];
  let currentFont = null;
  let currentX = 0;
  let currentY = 0;

  const tokenPattern =
    /\/([\w.-]+)\s+[\d.]+\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+T[Dd]|\[((?:\((?:\\.|[^\\()])*\)|<[^>]+>|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;

  contentStreams.forEach((content, pageIndex) => {
    let match;
    while ((match = tokenPattern.exec(content))) {
      if (match[1]) {
        currentFont = match[1];
        continue;
      }

      if (match[6] && match[7]) {
        currentX = Number(match[6]);
        currentY = Number(match[7]) + pageIndex * 10000;
        continue;
      }

      if (match[8] && match[9]) {
        currentX += Number(match[8]);
        currentY += Number(match[9]);
        continue;
      }

      const cmap = fontMaps[currentFont];
      const text =
        (match[10] && decodeTextArray(match[10], cmap)) ||
        (match[11] && decodePdfLiteralString(match[11])) ||
        (match[12] && decodeHexText(match[12], cmap));
      if (text) {
        glyphs.push({ text, x: currentX, y: currentY });
        currentX += text.length * 4;
      }
    }
  });

  return glyphs;
};

// Distinguishing intra-line glyph repositioning from real line breaks is
// the key thing this extractor has to get right. PDFs that position every
// glyph individually (Bizfile is one example) issue a `Td` between every
// character — these are tiny x-only moves, not newlines. We only break
// the line on T*, or on Tm/Td whose y delta is non-trivial. Without this
// distinction, per-glyph PDFs produce one character per line.
const LINE_BREAK_Y_THRESHOLD = 2;

const extractTextInContentOrder = (contentStreams, fontMaps) => {
  const lines = [];
  let currentFont = null;
  let currentLine = '';
  let currentY = null;

  const pushLine = () => {
    const line = currentLine.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    currentLine = '';
  };

  const appendText = (text = '') => {
    if (!text) return;
    // Append verbatim. The previous behavior of auto-inserting a space
    // between consecutive Tj operations made per-glyph-positioned PDFs
    // (each character a separate Tj, Bizfile-style) extract as letter-
    // spaced gibberish ("K O I V U V E N T U R E S"). Now we trust the
    // text content itself — spaces come from real space glyphs (mapped
    // via CMap) and TJ-array adjustments emit spaces at word boundaries.
    currentLine += text;
  };

  const tokenPattern =
    /\/([\w.-]+)\s+[\d.]+\s+Tf|(?:-?[\d.]+\s+){4}(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+T[Dd]|T\*|\[((?:\((?:\\.|[^\\()])*\)|<[^>]+>|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;

  contentStreams.forEach((content) => {
    let match;
    let blockY = null;
    while ((match = tokenPattern.exec(content))) {
      // 1 = font name (Tf)
      // 2,3 = Tm absolute x,y (last two of the 6-number matrix)
      // 4,5 = Td/TD relative dx,dy
      // 6 = TJ array
      // 7 = Tj string literal
      // 8 = Tj hex
      // T* matches literally as match[0] with no captures.
      if (match[1]) {
        currentFont = match[1];
        continue;
      }
      if (match[2] != null && match[3] != null) {
        const newY = Number(match[3]);
        if (blockY !== null && Math.abs(newY - blockY) > LINE_BREAK_Y_THRESHOLD) {
          pushLine();
        }
        blockY = newY;
        currentY = newY;
        continue;
      }
      if (match[4] != null && match[5] != null) {
        const dy = Number(match[5]);
        if (Math.abs(dy) > LINE_BREAK_Y_THRESHOLD) {
          pushLine();
          if (currentY !== null) currentY += dy;
        }
        continue;
      }
      if (match[0] === 'T*') {
        pushLine();
        continue;
      }

      const cmap = fontMaps[currentFont];
      const text =
        (match[6] && decodeTextArray(match[6], cmap)) ||
        (match[7] && decodePdfLiteralString(match[7])) ||
        (match[8] && decodeHexText(match[8], cmap));
      if (text) appendText(text);
    }
    pushLine();
  });

  return lines.join('\n');
};

const glyphsToLines = (glyphs) => {
  const lineMap = new Map();

  glyphs.forEach((glyph) => {
    const key = Math.round(glyph.y);
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push(glyph);
  });

  return Array.from(lineMap.entries())
    .sort(([yA], [yB]) => yA - yB)
    .map(([, lineGlyphs]) => {
      let previousRight = null;
      return lineGlyphs
        .sort((a, b) => a.x - b.x)
        .map((glyph) => {
          const needsSpace =
            previousRight !== null &&
            glyph.x - previousRight > 3 &&
            !/^\s/.test(glyph.text);
          previousRight = glyph.x + glyph.text.length * 4;
          return `${needsSpace ? ' ' : ''}${glyph.text}`;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    })
    .filter(Boolean)
    .join('\n');
};

const scoreText = (text = '') => {
  const labels = [
    'uen',
    'company',
    'entity',
    'registered',
    'office',
    'address',
    'share',
    'capital',
    'director',
    'secretary',
    'shareholder',
    'pte',
    'ltd',
    'statement',
    'transaction',
    'date',
    'description',
    'balance',
    'debit',
    'credit',
    'withdrawal',
    'deposit'
  ];
  const lower = text.toLowerCase();
  const labelScore = labels.reduce((score, label) => score + (lower.includes(label) ? 100 : 0), 0);
  const readableScore = (text.match(/[A-Za-z0-9 ,./&()#-]/g) || []).length;
  const unknownPenalty = (text.match(/\?/g) || []).length * 25;
  // Reward "real word" tokens (length >= 3) heavily — this is the cleanest
  // signal that text has correct word boundaries. Letter-spaced extraction
  // ("K O I V U V E N T U R E S") produces almost no real-word tokens and
  // gets crushed by this. We want it crushed, because the position-aware
  // extractor produces strictly better-shaped output when it works.
  const realWords = text.split(/\s+/).filter((t) => t.length >= 3).length;
  const wordScore = realWords * 50;
  return labelScore + wordScore + readableScore - unknownPenalty;
};

const uniqueNormalizedTexts = (texts = []) => {
  const seen = new Set();
  return texts
    .map(normalizeText)
    .filter(Boolean)
    .filter((text) => {
      const key = text.slice(0, 2000);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const buildFontAssignments = (fonts, cmaps) => {
  if (!fonts.length || !cmaps.length) return [];
  const cmapIndexes = cmaps.map((_, index) => index);
  const possibleOrders = cmaps.length <= 6 ? permutations(cmapIndexes) : [cmapIndexes];

  return possibleOrders.map((order) =>
    Object.fromEntries(fonts.map((font, index) => [font, cmaps[order[index] ?? order[order.length - 1]]]))
  );
};

export const extractBizfilePdfTextCandidates = (buffer) => {
  const streams = readPdfStreams(buffer);
  const cmaps = streams
    .filter((stream) => stream.content.includes('begincmap'))
    .map((stream) => parseCMap(stream.content))
    .filter((map) => map.size > 0);
  const contentStreams = streams
    .filter((stream) => /\bT[Jj]\b/.test(stream.content))
    .map((stream) => stream.content);
  const fonts = Array.from(
    new Set(
      contentStreams
        .flatMap((content) => Array.from(content.matchAll(/\/([\w.-]+)\s+[\d.]+\s+Tf/g), (match) => match[1]))
    )
  );

  const assignments = buildFontAssignments(fonts, cmaps);
  const fallbackAssignment = Object.fromEntries(fonts.map((font) => [font, null]));
  const candidateAssignments = assignments.length > 0 ? assignments : [fallbackAssignment];
  const candidates = candidateAssignments.flatMap((assignment) => [
    extractTextInContentOrder(contentStreams, assignment),
    glyphsToLines(extractGlyphs(contentStreams, assignment))
  ]);

  return uniqueNormalizedTexts(candidates);
};

export const extractBizfilePdfText = (buffer) => {
  const candidates = extractBizfilePdfTextCandidates(buffer);
  const best = candidates.reduce(
    (winner, text) => {
      const score = scoreText(text);
      return score > winner.score ? { text, score } : winner;
    },
    { text: '', score: -Infinity }
  );

  return normalizeText(best.text);
};

export const extractBizfilePdfTextFromBase64 = (base64) =>
  extractBizfilePdfText(Buffer.from(String(base64 || ''), 'base64'));

export const extractBizfilePdfTextCandidatesFromBase64 = (base64) =>
  extractBizfilePdfTextCandidates(Buffer.from(String(base64 || ''), 'base64'));
