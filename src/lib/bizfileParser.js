const LABEL_STOP_WORDS = [
  'uen',
  'entity type',
  'company type',
  'company status',
  'registered office',
  'date of incorporation',
  'incorporation date',
  'financial year end',
  'fye',
  'last agm',
  'last annual return',
  'share capital',
  'officers',
  'shareholders'
];

const cleanValue = (value = '') =>
  value
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:])/g, '$1')
    .trim();

// Some Bizfile PDFs (especially when each glyph is positioned individually in
// the source PDF) extract as "letter-spaced" text — every character separated
// by a single space, with word boundaries marked by two or more spaces. The
// downstream label patterns ("Name of Company", "UEN", …) never match in that
// shape, so we de-space these lines before further normalization. We only
// touch a line if it looks predominantly single-character to avoid mangling
// normal prose.
const dezspaceLine = (line = '') => {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return line;
  const singleCharCount = tokens.filter((t) => t.length === 1).length;
  if (singleCharCount / tokens.length < 0.6) return line;
  // Split on 2+ space runs (treated as word boundaries) and join intra-word
  // single chars. If a line has no multi-space gaps, this still produces a
  // single smashed word which is fine — downstream matching is
  // whitespace-tolerant.
  return line
    .split(/\s{2,}/)
    .map((piece) => piece.replace(/\s+/g, ''))
    .filter(Boolean)
    .join(' ');
};

const normalizeText = (text = '') =>
  text
    .replace(/\r/g, '\n')
    .split('\n')
    .map(dezspaceLine)
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const textLines = (text = '') =>
  normalizeText(text)
    .split('\n')
    .map(cleanValue)
    .filter(Boolean);

const isLikelyLabel = (line = '') => {
  const lower = line.toLowerCase();
  return LABEL_STOP_WORDS.some((word) => lower === word || lower.startsWith(`${word} `));
};

// Build a regex from a label string that matches case-insensitively and
// tolerates any amount of whitespace between every character. So "Name of
// Company" matches "Name of Company", "Name  of  Company", "NameofCompany",
// and "N a m e  o f  C o m p a n y" alike. The trailing `\s*:` requirement
// stops generic labels like "FYE" or "Status" from claiming neighbouring
// label lines (e.g. "FYE As At Date of Last AR:") that don't actually carry
// a value for the matched field.
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;
const flexLabelRegex = (label = '') => {
  const escaped = label
    .replace(/\s+/g, ' ')
    .split('')
    .map((c) => (c === ' ' ? '' : c.replace(REGEX_ESCAPE, '\\$&')))
    .join('\\s*');
  return new RegExp(`${escaped}\\s*:`, 'i');
};

const lineValueAfter = (lines, labels) => {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let matchIndex = -1;
    let matchLength = 0;
    for (const candidate of labels) {
      const regex = flexLabelRegex(candidate);
      const match = line.match(regex);
      if (match && match.index != null) {
        matchIndex = match.index;
        matchLength = match[0].length;
        break;
      }
    }
    if (matchIndex < 0) continue;

    // Bizfile values are always inline on the same line as the label
    // ("Label: value"). If the value slot is empty, the field is empty —
    // don't reach into the next line, that would leak the next label's
    // text into this field (especially when text is smashed and
    // isLikelyLabel can't recognise the boundary).
    const inline = cleanValue(
      line.slice(matchIndex + matchLength).replace(/^[:\-–\s]+/, '')
    );
    if (inline && inline.length > 1) return inline;
  }

  return '';
};

const matchValue = (text, patterns) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanValue(match[1]);
  }

  return '';
};

const slugify = (value = 'entity') =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'entity';

const ID_PATTERN = String.raw`(?:[STFG]\d{7}[A-Z]|[A-Z]{2}\d{7,}|T\d{2}[A-Z]{2}\d{4}[A-Z]?)`;
const OFFICER_ROW_PATTERN = new RegExp(
  String.raw`^(.+?)(${ID_PATTERN})([A-Z ]+?)(DIRECTOR|SECRETARY|MANAGER|CEO|AUDITOR)(\d{1,2}\s+[A-Z]{3}\s+\d{4})$`,
  'i'
);
// Position-aware PDF extraction puts every cell on its own line, so a single
// officer's data is split across ~3-5 lines: name, address line(s), then a
// "tail" line with everything from the right-hand columns smashed together
// (ID + nationality + position + date). This pattern matches just that tail.
const OFFICER_TAIL_PATTERN = new RegExp(
  String.raw`^(${ID_PATTERN})\s*([A-Z]+?)\s*(DIRECTOR|SECRETARY|MANAGER|CEO|AUDITOR)\s*(\d{1,2}\s+[A-Z]{3}\s+\d{4})$`,
  'i'
);
const SHAREHOLDER_ROW_PATTERN = new RegExp(
  String.raw`^(.+?)(${ID_PATTERN})([A-Z ]+?)([\d,]+(?:\.\d+)?)$`,
  'i'
);
// Tail-only equivalent for multi-line shareholder rows.
const SHAREHOLDER_TAIL_PATTERN = new RegExp(
  String.raw`^(${ID_PATTERN})\s*([A-Z]+?)\s*([\d,]+(?:\.\d+)?)$`,
  'i'
);

const isNoiseTableLine = (line = '') => {
  const normalized = cleanValue(line);
  if (!normalized) return true;
  if (/^\d+$/.test(normalized)) return true;
  if (/^\(?ordinary\)?$/i.test(normalized)) return true;
  if (/^(euro|member|countries|euro member|euro member countries)$/i.test(normalized)) return true;
  if (/^shareholder\(s\)$/i.test(normalized)) return true;
  if (/^officer\(s\)$/i.test(normalized)) return true;
  if (/^name/i.test(normalized)) return true;
  if (/^number/i.test(normalized)) return true;
  if (/^address(currency)?$/i.test(normalized)) return true;
  if (/^citizenship/i.test(normalized)) return true;
  if (/^position/i.test(normalized)) return true;
  if (/^appointment/i.test(normalized)) return true;
  if (/^place of /i.test(normalized)) return true;
  if (/^changed$/i.test(normalized)) return true;
  if (/^shares?$/i.test(normalized)) return true;
  if (/^currency$/i.test(normalized)) return true;
  if (/^identification$/i.test(normalized)) return true;
  if (/^nationality\/?$/i.test(normalized)) return true;
  if (/^includes /i.test(normalized)) return true;
  if (/^abbreviation$/i.test(normalized)) return true;
  if (/^verify document instantly$/i.test(normalized)) return true;
  if (/^check if this document is issued/i.test(normalized)) return true;
  if (/^business profile \(company\)/i.test(normalized)) return true;
  if (/^date:\s/i.test(normalized)) return true;
  if (/^page\s+\d+\s+of\s+\d+$/i.test(normalized)) return true;
  if (/^by acra/i.test(normalized)) return true;
  if (/^https?:/i.test(normalized)) return true;
  if (/^accounting and corporate/i.test(normalized)) return true;
  if (/^whilst every endeavor/i.test(normalized)) return true;
  if (/^liability for any damage/i.test(normalized)) return true;
  if (/^\([A-Z0-9]{9,}\)/i.test(normalized)) return true;
  if (/^\d[\d,.]*\s*\d[\d,.]*\s*euro/i.test(normalized)) return true;
  return false;
};

// A line that's a plausible Bizfile name. Names are all uppercase, can
// include apostrophes/hyphens/slashes/parentheses, and have at least two
// words OR a recognisable corporate suffix. Address lines are excluded
// because they contain digits or commas.
const NAME_LINE_PATTERN = /^[A-Z][A-Z\s'\/\-.&]+$/;
const CORPORATE_SUFFIX_PATTERN =
  /\b(OY|AB|LTD|LIMITED|PTE|LLP|INC|CORP|HOLDINGS|GROUP|PLC|GMBH|SA|SARL|BV|NV|AG|KG|SAS|SRL|SL|AS|SPA)\b/i;
const isPlausibleNameLine = (line = '') => {
  const normalized = cleanValue(line);
  if (!normalized || normalized.length < 3) return false;
  if (isNoiseTableLine(normalized)) return false;
  if (!NAME_LINE_PATTERN.test(normalized)) return false;
  const words = normalized.split(/\s+/);
  if (words.length >= 2) return true;
  return CORPORATE_SUFFIX_PATTERN.test(normalized);
};

// Walk back from a tail line to find the most recent plausible name line,
// collecting any address-like lines in between. Stops at noise or another
// tail. Returns null if no name found within maxLookBack lines.
const findNameAndAddressBefore = (lines, tailIdx, maxLookBack = 6) => {
  const between = [];
  for (let j = tailIdx - 1; j >= Math.max(0, tailIdx - maxLookBack); j -= 1) {
    const candidate = cleanValue(lines[j]);
    if (!candidate) continue;
    if (isNoiseTableLine(candidate)) continue;
    if (isPlausibleNameLine(candidate)) {
      return { name: candidate, addressLines: between.reverse() };
    }
    between.push(candidate);
  }
  return null;
};

// Join address lines with a space, not a comma. Lines from a wrapped
// address can end with a comma (a real field separator — keep the comma)
// or end with a word (a wrapped continuation — words like "YUNG" / "KUANG"
// must stay adjacent). Always joining with ", " produces "YUNG, KUANG"
// which corrupts the address; joining with " " preserves both cases.
const joinAddressLines = (parts = []) =>
  parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*,/g, ',')
    .trim();

// Parse a smashed "AmountSharesCurrency" line from the share capital table.
// Real Bizfile lines look like "120,450.50100,000EURO MEMBER COUNTRIES" with
// no separators between the columns. Amount has a decimal, shares is an
// integer. Try the most-likely interpretations (2 / 1 / 0 decimal places)
// and pick the first one where the share count doesn't start with a zero,
// which is the heuristic indicator we split at the right point.
const parseShareCapitalLine = (line = '') => {
  const candidates = [
    /^([\d,]+\.\d{2})([\d,]+)([A-Z][A-Z\s]+?)$/,
    /^([\d,]+\.\d{1})([\d,]+)([A-Z][A-Z\s]+?)$/,
    /^([\d,]+\.\d{2})([\d,]+)$/,
    /^([\d,]+\.\d{1})([\d,]+)$/
  ];
  for (const re of candidates) {
    const m = line.match(re);
    // If shares starts with "0X" the split was wrong (a 0 from the amount's
    // cents got pushed into shares). Skip and try a different split.
    if (m && !/^0\d/.test(m[2])) {
      return {
        amount: m[1],
        shares: m[2],
        currency: cleanValue(m[3] || '')
      };
    }
  }
  return null;
};

// Find the share capital section header and pull the first parseable
// data line out of the next few lines.
const extractShareCapital = (lines = []) => {
  const headerPattern = /^(issued\s+share\s+capital|paid[\s-]*up\s+capital)$/i;
  for (let i = 0; i < lines.length; i += 1) {
    if (!headerPattern.test(cleanValue(lines[i]))) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      const parsed = parseShareCapitalLine(cleanValue(lines[j]));
      if (!parsed) continue;
      const currency = parsed.currency.replace(/\s+/g, ' ').trim() || '';
      return currency
        ? `${parsed.amount} ${currency} (${parsed.shares} shares)`
        : `${parsed.amount} (${parsed.shares} shares)`;
    }
  }
  return '';
};

const toTitleCaseName = (value = '') =>
  cleanValue(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\b(Pte|Ltd|Oy|Ab|C\/O)\b/g, (match) => match.toUpperCase());

const parseOfficerRows = (lines = []) => {
  const rows = [];
  const seenAt = new Set();

  lines.forEach((line, idx) => {
    const normalized = cleanValue(line);

    // Single-line form: "NAME ID NAT POSITION DATE" (original synthetic test
    // fixture, and some Bizfile variants where the whole row stays on one
    // line).
    const fullMatch = normalized.match(OFFICER_ROW_PATTERN);
    if (fullMatch) {
      rows.push({
        name: toTitleCaseName(fullMatch[1]),
        badge: fullMatch[4].toUpperCase(),
        items: [
          { label: 'Role', value: toTitleCaseName(fullMatch[4]) },
          { label: 'Nationality', value: toTitleCaseName(fullMatch[3]) },
          { label: 'Appointed', value: fullMatch[5].toUpperCase() }
        ]
      });
      seenAt.add(idx);
      return;
    }

    // Multi-line form (real ACRA Bizfile after position-aware extraction):
    // the right-hand columns end up on a "tail" line like
    // "S0000001AMALAYSIANSECRETARY12 MAR 2024", and the NAME + ADDRESS sit
    // on the preceding lines.
    const tailMatch = normalized.match(OFFICER_TAIL_PATTERN);
    if (!tailMatch) return;
    const found = findNameAndAddressBefore(lines, idx);
    if (!found) return;

    const items = [
      { label: 'Role', value: toTitleCaseName(tailMatch[3]) },
      { label: 'Nationality', value: toTitleCaseName(tailMatch[2]) },
      { label: 'Appointed', value: tailMatch[4].toUpperCase() }
    ];
    if (found.addressLines.length) {
      items.push({ label: 'Address', value: toTitleCaseName(joinAddressLines(found.addressLines)) });
    }
    rows.push({
      name: toTitleCaseName(found.name),
      badge: tailMatch[3].toUpperCase(),
      items
    });
  });

  return rows;
};

const parseShareholderRows = (lines = []) => {
  const rows = [];

  lines.forEach((line, idx) => {
    const normalized = cleanValue(line);
    if (isNoiseTableLine(normalized)) return;

    // Single-line form.
    const fullMatch = normalized.match(SHAREHOLDER_ROW_PATTERN);
    if (fullMatch) {
      rows.push({
        name: toTitleCaseName(fullMatch[1]),
        badge: CORPORATE_SUFFIX_PATTERN.test(fullMatch[1]) ? 'Corporate shareholder' : 'Shareholder',
        items: [
          { label: 'Origin', value: toTitleCaseName(fullMatch[3]) },
          { label: 'Shares', value: fullMatch[4] }
        ]
      });
      return;
    }

    // Multi-line form: tail line has "IDORIGINSHARES" smashed together,
    // name/address are above.
    const tailMatch = normalized.match(SHAREHOLDER_TAIL_PATTERN);
    if (!tailMatch) return;
    const found = findNameAndAddressBefore(lines, idx);
    if (!found) return;

    const items = [
      { label: 'Origin', value: toTitleCaseName(tailMatch[2]) },
      { label: 'Shares', value: tailMatch[3] }
    ];
    if (found.addressLines.length) {
      items.push({ label: 'Address', value: toTitleCaseName(joinAddressLines(found.addressLines)) });
    }
    rows.push({
      name: toTitleCaseName(found.name),
      badge: CORPORATE_SUFFIX_PATTERN.test(found.name) ? 'Corporate shareholder' : 'Shareholder',
      items
    });
  });

  return rows;
};

const extractPeopleAndOwnership = (lines = []) => {
  const officerRows = parseOfficerRows(lines);
  const shareholderRows = parseShareholderRows(lines);

  return {
    officers: officerRows,
    shareholders: shareholderRows
  };
};

const decodePdfLiteral = (value = '') =>
  value
    .replace(/\\([nrtbf()\\])/g, (_, escaped) => {
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      return escapes[escaped] || escaped;
    })
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

const decodePdfHex = (value = '') => {
  const normalized = value.length % 2 === 0 ? value : `${value}0`;
  const bytes = normalized.match(/.{1,2}/g)?.map((pair) => parseInt(pair, 16)) || [];
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let decoded = '';
    for (let index = 2; index < bytes.length; index += 2) {
      decoded += String.fromCharCode((bytes[index] << 8) + (bytes[index + 1] || 0));
    }
    return decoded;
  }

  return new TextDecoder('windows-1252').decode(new Uint8Array(bytes));
};

const decodePdfTextTokens = (source = '') => {
  const chunks = [];
  const tokenPattern = /\((?:\\.|[^\\)])*\)|<([0-9a-fA-F\s]+)>/g;
  let match;

  while ((match = tokenPattern.exec(source))) {
    const token = match[0];
    if (token.startsWith('(')) {
      chunks.push(decodePdfLiteral(token.slice(1, -1)));
    } else {
      chunks.push(decodePdfHex(token.slice(1, -1).replace(/\s+/g, '')));
    }
  }

  return chunks.join(' ');
};

const extractTextOperators = (content = '') => {
  const chunks = [];
  const literalPattern = /(\((?:\\.|[^\\)])*\)|<[\da-fA-F\s]+>)\s*Tj/g;
  const arrayPattern = /\[((?:.|\n)*?)\]\s*TJ/g;
  let match;

  while ((match = literalPattern.exec(content))) {
    chunks.push(decodePdfTextTokens(match[1]));
  }

  while ((match = arrayPattern.exec(content))) {
    chunks.push(decodePdfTextTokens(match[1]));
  }

  return chunks.join('\n');
};

const inflatePdfStream = async (bytes) => {
  if (typeof window === 'undefined' || typeof DecompressionStream === 'undefined') return null;

  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const inflated = new Response(stream).arrayBuffer();
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(null), 500);
    });
    const buffer = await Promise.race([inflated, timeout]);
    return buffer ? new Uint8Array(buffer) : null;
  } catch {
    return null;
  }
};

const streamBytesFromBinary = (value = '') => {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
};

export const extractPdfText = async (file) => {
  if (typeof window === 'undefined') return '';

  const bytes = new Uint8Array(await file.arrayBuffer());
  const binary = new TextDecoder('latin1').decode(bytes);
  const chunks = [];
  let searchFrom = 0;
  let streamIndex = binary.indexOf('stream', searchFrom);

  while (streamIndex !== -1) {
    const dictionaryStart = binary.lastIndexOf('<<', streamIndex);
    const endStreamIndex = binary.indexOf('endstream', streamIndex);
    if (dictionaryStart === -1 || endStreamIndex === -1) break;

    const dictionary = binary.slice(dictionaryStart, streamIndex);
    const declaredLength = Number(dictionary.match(/\/Length\s+(\d+)/)?.[1] || 0);
    const isImageStream = /\/Subtype\s*\/Image/.test(dictionary);
    const isFontStream = /\/Length1\b/.test(dictionary);
    const isObjectStream = /\/Type\s*\/ObjStm/.test(dictionary);
    const isXrefStream = /\/Type\s*\/XRef/.test(dictionary);
    const isProfileStream = /<<\s*\/N\s+\d+\s*\/Filter/.test(dictionary);
    const mightContainText =
      /\/Length\b/.test(dictionary) &&
      !isImageStream &&
      !isFontStream &&
      !isObjectStream &&
      !isXrefStream &&
      !isProfileStream;
    let dataStart = streamIndex + 'stream'.length;
    if (binary[dataStart] === '\r' && binary[dataStart + 1] === '\n') {
      dataStart += 2;
    } else if (binary[dataStart] === '\r' || binary[dataStart] === '\n') {
      dataStart += 1;
    }

    let dataEnd = declaredLength
      ? Math.min(dataStart + declaredLength, endStreamIndex)
      : endStreamIndex;
    while (dataEnd > dataStart && (binary[dataEnd - 1] === '\r' || binary[dataEnd - 1] === '\n')) {
      dataEnd -= 1;
    }

    const streamBytes = streamBytesFromBinary(binary.slice(dataStart, dataEnd));
    const decodedBytes = mightContainText && dictionary.includes('/FlateDecode')
      ? await inflatePdfStream(streamBytes)
      : mightContainText
        ? streamBytes
        : null;

    if (!decodedBytes) continue;
    const content = new TextDecoder('latin1').decode(decodedBytes);
    const text = extractTextOperators(content);
    if (text) chunks.push(text);

    searchFrom = endStreamIndex + 'endstream'.length;
    streamIndex = binary.indexOf('stream', searchFrom);
  }

  return normalizeText(chunks.join('\n'));
};

export const parseBizfileText = (inputText = '', source = 'Bizfile import') => {
  const text = normalizeText(inputText);
  const lines = textLines(text);
  const compact = lines.join('\n');
  const people = extractPeopleAndOwnership(lines);
  const companyName =
    lineValueAfter(lines, ['Entity Name', 'Company Name', 'Name of Company', 'Name']) ||
    // PTE LTD fallback — `\s*` (not `\s+`) so it matches both
    // "EXAMPLE VENTURES PTE. LTD." and the smashed "EXAMPLEVENTURESPTE.LTD."
    // that letter-spaced PDFs collapse to after dezspaceLine.
    matchValue(compact, [/([A-Z0-9][A-Z0-9&.,'()\/\-\s]*PTE\.?\s*LTD\.?)/i]);
  const uen = lineValueAfter(lines, ['UEN', 'Unique Entity Number']) ||
    // UEN regex — Singapore registration formats. Allows a leading prefix
    // letter (S/T/F/G/R) as well as the all-digit 9+letter case.
    matchValue(compact, [
      /\b([STFGR]\d{9}[A-Z])\b/i,
      /\b([0-9]{8,9}[A-Z])\b/i
    ]);
  const entityType =
    lineValueAfter(lines, ['Entity Type', 'Company Type', 'Type of Company']) ||
    'Private company limited by shares';
  const incorporationDate =
    lineValueAfter(lines, ['Date of Incorporation', 'Incorporation Date', 'Registration Date']);
  const registeredOffice =
    lineValueAfter(lines, ['Registered Office Address', 'Registered Address', 'Registered Office']);
  // Order matters: flexLabelRegex matches sequences of chars, so a generic
  // label like "Status" hits early inside "Status of Company:". Put the
  // longest, most-specific phrasing first so it claims the line.
  const companyStatus = lineValueAfter(lines, ['Status of Company', 'Company Status', 'Entity Status', 'Status']);
  // Bizfile renders this field as "FYE As At Date of Last AR:". The
  // doc also has an abbreviations legend ("FYE: Financial Year End")
  // further down, which would match a generic `FYE` label and grab
  // the legend definition as the field's value. Match the long form
  // first; fall back to `Financial Year End` for atypical PDFs but
  // not the bare `FYE`.
  const fye = lineValueAfter(lines, [
    'FYE As At Date of Last AR',
    'FYE As At',
    'Financial Year End'
  ]);
  const lastAgm = lineValueAfter(lines, ['Last AGM', 'Date of Last AGM']);
  const lastAnnualReturn = lineValueAfter(lines, ['Last Annual Return', 'Date of Last AR', 'Last AR']);
  const shareCapital =
    extractShareCapital(lines) ||
    lineValueAfter(lines, ['Issued Share Capital', 'Paid Up Capital', 'Share Capital']) ||
    matchValue(compact, [/\b(SGD\s?[\d,]+(?:\.\d{2})?.{0,40}ordinary shares?)/i]);

  return {
    source,
    rawText: text,
    companyName: cleanValue(companyName) || 'New Singapore entity',
    uen: cleanValue(uen) || 'UEN pending',
    entityType: cleanValue(entityType),
    incorporationDate: cleanValue(incorporationDate),
    registeredOffice: cleanValue(registeredOffice),
    companyStatus: cleanValue(companyStatus),
    fye: cleanValue(fye),
    lastAgm: cleanValue(lastAgm),
    lastAnnualReturn: cleanValue(lastAnnualReturn),
    shareCapital: cleanValue(shareCapital),
    officers: people.officers,
    shareholders: people.shareholders
  };
};

export const buildProfileFromBizfile = (record, options = {}) => {
  const idBase = `${slugify(record.companyName)}-${record.uen.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  const id = options.id || idBase.replace(/-+$/, '') || `entity-${Date.now()}`;
  const addressMismatch =
    options.contactAddress &&
    record.registeredOffice &&
    cleanValue(options.contactAddress).toLowerCase() !== cleanValue(record.registeredOffice).toLowerCase();
  const hasCorporateShareholder = record.shareholders.some((row) =>
    /\b(pte|ltd|limited|llp|corp|holdings|oy|ab)\b/i.test(row.name || '')
  );
  const annualReturnMissing = !record.lastAgm || !record.lastAnnualReturn;
  const cddStatus = hasCorporateShareholder || !options.cddEvidenceReady ? 'blocked' : 'complete';

  return {
    id,
    companyName: record.companyName,
    uen: record.uen,
    entityType: record.entityType,
    incorporationDate: record.incorporationDate ? `Incorporated ${record.incorporationDate}` : 'Incorporation date not extracted',
    stage: 'Bizfile intake review',
    nextDeadline: annualReturnMissing ? 'Annual return fields need confirmation' : `Last AR ${record.lastAnnualReturn}`,
    intakeChecklist: [
      { id: 'company-basics', label: 'Company basics', detail: 'Company name, UEN, type, and status extracted', status: record.uen === 'UEN pending' ? 'review' : 'complete' },
      { id: 'registered-address', label: 'Registered office address', detail: addressMismatch ? 'Contact address differs from Bizfile' : 'Registered address extracted from Bizfile', status: addressMismatch ? 'review' : record.registeredOffice ? 'complete' : 'pending' },
      { id: 'officer-particulars', label: 'Officers', detail: record.officers.length ? `${record.officers.length} officer rows found` : 'Officer rows need review', status: record.officers.length ? 'review' : 'pending' },
      { id: 'shareholder-register', label: 'Shareholders', detail: record.shareholders.length ? `${record.shareholders.length} shareholder rows found` : 'Shareholder rows need review', status: hasCorporateShareholder ? 'blocked' : record.shareholders.length ? 'review' : 'pending' },
      { id: 'aml-cdd', label: 'AML/CDD evidence', detail: hasCorporateShareholder ? 'Corporate shareholder CDD needed' : 'Evidence status needs confirmation', status: cddStatus },
      { id: 'annual-return', label: 'Annual return readiness', detail: annualReturnMissing ? 'Last AGM or annual return value missing' : 'Annual return values extracted', status: annualReturnMissing ? 'pending' : 'complete' },
      { id: 'accounting-handoff', label: 'Accounting handoff', detail: options.xeroConnected ? 'Xero tenant marked connected' : 'Xero tenant and contact mapping pending', status: options.xeroConnected ? 'review' : 'pending' }
    ],
    bizfile: {
      source: record.source,
      facts: [
        { label: 'Company name', value: record.companyName },
        { label: 'UEN', value: record.uen },
        { label: 'Status', value: record.companyStatus || 'Not extracted' },
        { label: 'Registered office', value: record.registeredOffice || 'Not extracted' },
        { label: 'Share capital', value: record.shareCapital || 'Not extracted' },
        { label: 'FYE', value: record.fye || 'Not extracted' },
        { label: 'Last AGM', value: record.lastAgm || 'Not extracted' },
        { label: 'Last annual return', value: record.lastAnnualReturn || 'Not extracted' }
      ],
      sections: [
        {
          title: 'Annual return fields',
          meta: annualReturnMissing ? 'Needs confirmation' : 'Extracted',
          items: [
            { label: 'FYE', value: record.fye || 'Not extracted' },
            { label: 'Last AGM', value: record.lastAgm || 'Not extracted' },
            { label: 'Last AR', value: record.lastAnnualReturn || 'Not extracted' }
          ]
        }
      ],
      tables: [
        // Split officers and shareholders into two tables — the firm
        // workspace UI (FirmClientWorkspace.jsx) finds them by title-match
        // (`/officer/i`, `/shareholder/i`), so a combined table would
        // render as empty in the People & ownership tab.
        {
          title: 'Officers',
          meta: `${record.officers.length} extracted row${record.officers.length === 1 ? '' : 's'}`,
          records: record.officers.map((row) => ({
            name: row.name,
            badge: row.badge || 'Officer',
            items: row.items || []
          }))
        },
        {
          title: 'Shareholders',
          meta: `${record.shareholders.length} extracted row${record.shareholders.length === 1 ? '' : 's'}`,
          records: record.shareholders.map((row) => ({
            name: row.name,
            badge: row.badge || 'Shareholder',
            items: row.items || []
          }))
        }
      ],
      mismatches: addressMismatch
        ? [
            {
              field: 'Registered office vs contact address',
              bizfile: record.registeredOffice,
              intake: options.contactAddress
            }
          ]
        : []
    },
    xeroReadiness: [
      { id: 'profile-reviewed', label: 'Client profile reviewed', detail: 'Bizfile extraction created initial profile', status: 'review' },
      { id: 'compliance-clearance', label: 'Compliance clearance', detail: cddStatus === 'complete' ? 'CDD evidence marked ready' : 'CDD evidence needs review', status: cddStatus },
      { id: 'tenant-access', label: 'Xero tenant access', detail: options.xeroConnected ? 'Marked connected during intake' : 'Invite or connection required', status: options.xeroConnected ? 'complete' : 'pending' },
      { id: 'contact-mapping', label: 'Contact mapping', detail: options.billingEmail ? `Billing email: ${options.billingEmail}` : 'Billing email and contact address need confirmation', status: options.billingEmail ? 'review' : 'pending' }
    ]
  };
};

export const buildQueueFromBizfileProfile = (profile, options = {}) => {
  // After Bizfile intake the only action the firm sees is a drafted
  // welcome message to the new client. Firm-internal tracking (Xero
  // handoff, CDD evidence, annual-return readiness, address mismatch)
  // stays on the entity's intakeChecklist as a sidebar, not as urgent
  // actions in the queue — those used to flood the actions tab right
  // after intake and obscured the actual first step, which is to
  // engage the client and pull their existing trading documents.
  const createdAt = Date.now();
  const companyName = profile.companyName;
  const uen = profile.uen;
  const subject = `Welcome to Donna — getting ${companyName} set up`;
  const body = [
    `Hi there,`,
    ``,
    `Welcome to Donna. We've set up ${companyName}` +
      (uen && uen !== 'UEN pending' ? ` (UEN ${uen})` : '') +
      ` in our system from the ACRA Bizfile profile.`,
    ``,
    `To get accounting and compliance running cleanly, please share anything you already have from trading to date:`,
    ``,
    `• Bank statements (last 6-12 months, all accounts)`,
    `• Invoices issued and bills received`,
    `• Receipts for business expenses`,
    `• Existing financial agreements (loans, shareholder agreements, leases, service contracts)`,
    ``,
    `If ${companyName} hasn't traded yet, just reply "no trading yet" and we'll set up the basics so you're ready when activity starts.`,
    ``,
    `You can upload directly via the client portal or reply to this email with attachments.`
  ].join('\n');

  const action = {
    id: `${profile.id}-welcome-${createdAt}`,
    trigger_type: 'firm_client_welcome',
    trigger_id: 'first_contact',
    queue_label: 'ops_review',
    pattern_category: 'client_onboarding',
    hold_reason: 'awaiting_client_materials',
    confidence: 'high',
    problem_summary: `Welcome ${companyName} and request initial trading materials`,
    user_stuck_on: 'What does the firm need from us to get started?',
    donna_response: body,
    queue_reason: 'First client outreach: pull whatever trading documents the client already has so accounting and compliance work has real evidence to start from.',
    subject,
    client_id: profile.id,
    client_name: companyName,
    created_at: createdAt,
    conversation: [
      {
        role: 'Client',
        text: options.sourceFile
          ? `I uploaded ${options.sourceFile}.`
          : 'I added the Bizfile profile.'
      },
      {
        role: 'Firm',
        text: `Donna extracted the company profile for ${companyName}. Drafting the welcome message and asking for any trading documents the client already has.`
      }
    ],
    root_cause: {
      hypothesis: 'New venture intake — no trading materials yet on file.',
      evidence: ['Bizfile profile created.'],
      confidence: 'high'
    },
    proposed_fix: {
      owner: 'ops_review',
      steps: [
        'Review the drafted welcome message',
        'Confirm the client contact and send',
        'Wait for the client to upload materials via the portal'
      ]
    },
    evidence_requested: [
      'Bank statements',
      'Invoices and bills',
      'Receipts',
      'Existing financial agreements'
    ],
    escalation_flag: false
  };

  return [action];
};
