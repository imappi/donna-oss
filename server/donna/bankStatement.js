import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractBizfilePdfTextCandidatesFromBase64,
  extractBizfilePdfTextFromBase64
} from './bizfilePdf.js';
import {
  extractStructuredFromOpenAiVisionPaginated,
  extractStructuredFromStatementText,
  isOpenAiVisionConfigured,
  ocrPdfWithOpenAiVision
} from './bankStatementVision.js';
import { toUtcIsoDay } from './dates.js';

const OCR_SCRIPT_PATH = fileURLToPath(new URL('./pdfOcr.swift', import.meta.url));
const OCR_MAX_PAGES = 80;
const OCR_TIMEOUT_MS = 240000;
const SWIFT_MODULE_CACHE_DIR = join(tmpdir(), 'donna-swift-module-cache');

// Local Swift OCR (Apple Vision) is a dev-Mac convenience tier that also
// bounds the OpenAI vision bill on cloud hosts. On the DESKTOP host the
// product's target hardware IS a Mac, so this tier fires for every scanned
// statement and — because a result that merely "looks like a statement"
// ships — preempts the strong structured-vision tier with regex-parsed OCR
// text (findings §4b-vii: the corrupted Honeybee/Ozark statement — Cyrillic
// OCR glyphs, balance-column amounts, merged rows). Default: OFF when the
// desktop host gate is set (the same DONNA_DESKTOP_BLOB_DIR signal
// isInngestConfigured keys on), ON elsewhere. BANK_STATEMENT_LOCAL_OCR
// overrides both ways: explicit off kills the tier anywhere (incident
// response), explicit on restores it on desktop (debugging).
export const isLocalOcrEnabled = (env = process.env) => {
  const raw = env?.BANK_STATEMENT_LOCAL_OCR;
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  }
  return !env?.DONNA_DESKTOP_BLOB_DIR;
};

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

const BANK_LINE_NOISE =
  /\b(opening balance|closing balance|balance brought forward|balance b\/f|b\/f balance|brought forward|brought fwd|available balance|ledger balance|account balance|current balance|previous balance|new balance|total balance|date\s+description|transaction date|statement date|account number|page\s+\d+|total debit|total credit)\b/i;
const BANK_STATEMENT_TEXT_HINT =
  /\b(account statement|bank statement|statement of account|transaction date|transaction details|withdrawal|deposit|balance|debit|credit|paynow|giro|fast transfer|funds transfer|payment|receipt)\b/i;

const amountPattern =
  /(?<![A-Z\d/.-])(?:S\$|AED|SGD|USD|EUR|GBP|[£€$])?\s*\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\)?\s*(?:CR|DR)?(?![A-Z\d/.-])/gi;

const toIsoDate = (year, monthIndex, day) => {
  const numericYear = Number(year);
  const numericMonth = Number(monthIndex);
  const numericDay = Number(day);
  const parsed = new Date(Date.UTC(numericYear, numericMonth, numericDay));
  if (Number.isNaN(parsed.getTime())) return '';
  // Date.UTC rolls invalid calendar input into the next month (31/02 becomes
  // March). A parser must refuse that row, not quietly manufacture a date.
  if (
    parsed.getUTCFullYear() !== numericYear ||
    parsed.getUTCMonth() !== numericMonth ||
    parsed.getUTCDate() !== numericDay
  ) {
    return '';
  }
  // UTC on purpose: the day was built with Date.UTC(y, m, d) and validated
  // with UTC getters — the host zone must not move it.
  return toUtcIsoDay(parsed);
};

const normalizeYear = (year) => {
  const numeric = Number(year);
  if (!Number.isFinite(numeric)) return new Date().getFullYear();
  if (numeric < 100) return numeric >= 70 ? 1900 + numeric : 2000 + numeric;
  return numeric;
};

const inferYear = (filename = '') => {
  const dateMatch = String(filename).match(/(20\d{2})[-/.]\d{2}[-/.]\d{2}/);
  if (dateMatch) return Number(dateMatch[1]);
  const match = String(filename).match(/(?:^|[^\d])(20\d{2})(?=[^\d]|$)/);
  return match ? Number(match[1]) : new Date().getFullYear();
};

const normalizeSpace = (value = '') =>
  String(value).replace(/\s+/g, ' ').trim();

// Headless-Chrome print headers/footers are document transport furniture,
// never transaction evidence. PDF text layers can collapse or space every
// glyph, so compare a compact form as well as the visible line.
const isPdfPageFurnitureLine = (line = '') => {
  const visible = String(line).replace(/ﬁ/g, 'fi');
  const compact = visible.replace(/\s+/g, '');
  if (/file:\/{2,}/i.test(compact)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4},?\d{1,2}:\d{2}(?:AM|PM).*(?:bank|account)?statement/i.test(compact)) return true;
  if (/^[A-Z]{2,}_STMT_[A-Z0-9_\-]+$/i.test(visible.trim())) return true;
  if (/^(?:\d+|[ru])(?:[\s\dru]+)$/i.test(visible.trim())) return true;
  return /^(?:please\s+(?:verify|review)|this\s+statement\s+(?:is|was)|report\s+discrepancies)\b/i.test(visible.trim());
};

const normalizeStatementTextLine = (line = '') =>
  String(line).replace(
    /^(\s*\d{1,2}[-/.]\d)\s+(\d)(?=\s+[A-Z])/,
    '$1$2'
  );

const sanitizeStatementText = (text = '') =>
  String(text)
    .split(/\r?\n/)
    .filter((line) => !isPdfPageFurnitureLine(line))
    .map(normalizeStatementTextLine)
    .join('\n');

const parseStatementPeriod = (text = '') => {
  const clean = sanitizeStatementText(text);
  const monthNameRange = clean.match(
    /\b(0?[1-9]|[12]\d|3[01])\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+((?:19|20)\d{2})\s*(?:-|–|—|to)\s*(0?[1-9]|[12]\d|3[01])\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+((?:19|20)\d{2})\b/i
  );
  if (monthNameRange) {
    const start = toIsoDate(monthNameRange[3], MONTHS[monthNameRange[2].toLowerCase()], monthNameRange[1]);
    const end = toIsoDate(monthNameRange[6], MONTHS[monthNameRange[5].toLowerCase()], monthNameRange[4]);
    if (start && end && start <= end) return { start, end, source: 'printed_period' };
  }

  const monthFirstRange = clean.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\s*(?:-|–|—|to)\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/i
  );
  if (monthFirstRange) {
    const start = toIsoDate(monthFirstRange[3], MONTHS[monthFirstRange[1].toLowerCase()], monthFirstRange[2]);
    const end = toIsoDate(monthFirstRange[6], MONTHS[monthFirstRange[4].toLowerCase()], monthFirstRange[5]);
    if (start && end && start <= end) return { start, end, source: 'printed_period' };
  }

  const isoRange = clean.match(
    /\b((?:19|20)\d{2}-\d{2}-\d{2})\s*(?:-|–|—|to)\s*((?:19|20)\d{2}-\d{2}-\d{2})\b/i
  );
  if (isoRange && isoRange[1] <= isoRange[2]) {
    return { start: isoRange[1], end: isoRange[2], source: 'printed_period' };
  }
  return null;
};

const dateWithinPeriod = (iso = '', period = null) =>
  Boolean(iso && period?.start && period?.end && iso >= period.start && iso <= period.end);

const chooseNumericDate = ({ first, second, year, period = null }) => {
  const dmy = toIsoDate(year, Number(second) - 1, first);
  const mdy = toIsoDate(year, Number(first) - 1, second);
  if (dmy && !mdy) return dmy;
  if (mdy && !dmy) return mdy;
  if (!dmy && !mdy) return '';
  if (dmy === mdy) return dmy;

  const dmyInPeriod = dateWithinPeriod(dmy, period);
  const mdyInPeriod = dateWithinPeriod(mdy, period);
  if (dmyInPeriod !== mdyInPeriod) return dmyInPeriod ? dmy : mdy;
  // Preserve the established DMY fallback when the document itself does not
  // disambiguate. Jurisdiction is only a hint; the printed period is evidence.
  return dmy;
};

const isLikelyAmountToken = (value = '') =>
  /(?:S\$|SGD|USD|EUR|GBP|[£€$]|,|\.\d{2}|\bCR\b|\bDR\b|\(|-)/i.test(String(value));

const parseAmount = (value = '') => {
  const raw = String(value).trim();
  const isNegative = raw.includes('(') || raw.includes('-') || /\bDR\b/i.test(raw);
  const numericText = raw.replace(/[^\d.,]/g, '');
  // European grouped decimals are disjoint from dot-decimal and comma-only
  // forms: dots must form thousands groups and the final comma has 2 digits.
  // Keep this branch before the existing comma-decimal/comma-thousands split.
  const isEuropeanGroupedDecimal = /^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(numericText);
  const normalizedNumeric = isEuropeanGroupedDecimal
    ? numericText.replace(/\./g, '').replace(',', '.')
    : numericText.includes(',') && !numericText.includes('.') && /,\d{2}$/.test(numericText)
      ? numericText.replace(',', '.')
      : numericText.replace(/,/g, '');
  const numeric = Number(normalizedNumeric);
  if (!Number.isFinite(numeric)) return 0;
  return isNegative ? -numeric : numeric;
};

const currencyCodes = new Set(Intl.supportedValuesOf('currency'));
const currencyCodesIn = (text = '') => [...String(text).matchAll(/\b[A-Z]{3}\b/g)]
  .map((match) => match[0]).filter((code) => currencyCodes.has(code));
const headerCurrencies = (text = '') => [...new Set([
  ...String(text).matchAll(/^(?:account |statement )?currency\s*[:=]?\s*([A-Z]{3})\b/gmi),
  ...String(text).matchAll(/\b(?:opening|closing|ending|starting)\s+balance\s*[:=]?\s*([A-Z]{3})\s*[\d,.]/gmi)
].map((match) => match[1].toUpperCase()).filter((code) => currencyCodes.has(code)))];
const printedCurrencies = (text = '') => {
  // Currency syntax, not arbitrary ISO-looking words in merchant prose.
  const codes = [
    ...String(text).matchAll(/^\s*([A-Z]{3})\s+[\d,]+\.\d{2}(?:\s|$)/gm),
    ...String(text).matchAll(/\d[\d,.]*\s+([A-Z]{3})\s*$/gm)
  ].map((match) => match[1]).filter((code) => currencyCodes.has(code));
  if (/£\s*\d/.test(text)) codes.push('GBP');
  if (/€\s*\d/.test(text)) codes.push('EUR');
  if (/S\$\s*\d/.test(text)) codes.push('SGD');
  return [...new Set(codes)];
};
const inferStatementCurrency = (_filename = '', text = '') => {
  const header = headerCurrencies(text);
  const candidates = header.length ? header : printedCurrencies(text);
  return candidates.length === 1 ? candidates[0] : '';
};

const delimitedCurrencies = (text = '') => {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = findHeaderIndex(lines);
  if (headerIndex === -1) return [];
  const delimiter = detectDelimiter(lines[headerIndex]);
  if (!delimiter) return [];
  const headers = splitDelimitedLine(lines[headerIndex], delimiter);
  const currencyIndex = findColumn(headers, [/^currency$/i]);
  const evidence = new Set();
  headers.forEach((header) => {
    currencyCodesIn(header).forEach((code) => evidence.add(code));
  });
  if (currencyIndex >= 0) {
    lines.slice(headerIndex + 1).forEach((line) => {
      const value = splitDelimitedLine(line, delimiter)[currencyIndex] || '';
      if (currencyCodes.has(value.trim().toUpperCase())) evidence.add(value.trim().toUpperCase());
    });
  }
  return [...evidence];
};

const extractAmountMatches = (line = '') =>
  Array.from(String(line).matchAll(amountPattern))
    .filter((match) => isLikelyAmountToken(match[0]))
    .filter((match) => {
      const token = String(match[0]).trim();
      if (!/^-\d+$/.test(token)) return true;
      // A spaced OCR rendering of "T-884712" can become "T -884712".
      // That bare identifier is not a movement amount; real signed money in
      // these table rows carries decimals, grouping, or a currency marker.
      const before = String(line).slice(0, match.index || 0);
      return !/[A-Z]\s*$/i.test(before);
    })
    .map((match) => ({
      token: match[0],
      index: match.index || 0,
      amount: parseAmount(match[0])
    }));

const extractDate = (line = '', filename = '', period = null) => {
  const year = inferYear(filename);

  let match = line.match(/\b((?:19|20)\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (match) {
    return {
      raw: match[0],
      iso: toIsoDate(match[1], Number(match[2]) - 1, match[3])
    };
  }

  match = line.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|[12]\d|3[01])[-/.]((?:19|20)?\d{2})\b/);
  if (match) {
    return {
      raw: match[0],
      iso: chooseNumericDate({
        first: match[1],
        second: match[2],
        year: normalizeYear(match[3]),
        period
      })
    };
  }

  match = line.match(
    /\b(0?[1-9]|[12]\d|3[01])[-\s]*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s-]*((?:19|20)?\d{2})?\b/i
  );
  if (match) {
    const monthIndex = MONTHS[match[2].toLowerCase()];
    return {
      raw: match[0],
      iso: toIsoDate(match[3] ? normalizeYear(match[3]) : year, monthIndex, match[1])
    };
  }

  match = line.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s-]*(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[,\s-]*((?:19|20)?\d{2})?\b/i
  );
  if (match) {
    const monthIndex = MONTHS[match[1].toLowerCase()];
    return {
      raw: match[0],
      iso: toIsoDate(match[3] ? normalizeYear(match[3]) : year, monthIndex, match[2])
    };
  }

  match = line.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|[12]\d|3[01])\b(?![-/.]\d|\s+\d)/);
  if (match) {
    return {
      raw: match[0],
      iso: chooseNumericDate({ first: match[1], second: match[2], year, period })
    };
  }

  match = line.match(
    /\b(0?[1-9]|[12]\d|3[01])\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s*((?:19|20)?\d{2})?\b/i
  );
  if (match) {
    const monthIndex = MONTHS[match[2].toLowerCase()];
    return {
      raw: match[0],
      iso: toIsoDate(match[3] ? normalizeYear(match[3]) : year, monthIndex, match[1])
    };
  }

  return null;
};

const directionForLine = (line, token, amount) => {
  if (/\bCR\b/i.test(token) || /\b(credit|deposit|receipt|received|incoming|transfer in|interest received|refund)\b/i.test(line)) {
    return 'in';
  }
  if (/\bDR\b/i.test(token) || amount < 0 || /\b(debit|payment|payout|withdrawal|fee|charge|transfer out|giro|paynow|fast payment)\b/i.test(line)) {
    return 'out';
  }
  return 'out';
};

const hasOutflowWords = (line = '') =>
  /\b(debit|payment|payout|withdrawal|fee|charge|transfer out|giro|fast payment|card|supplier)\b/i.test(line);

const hasInflowWords = (line = '') =>
  /\b(credit|deposit|receipt|incoming|refund|capital|investment|investor)\b/i.test(line);

const isWeakBalanceLine = (description = '', amountMatches = []) => {
  const normalized = normalizeSpace(description).toLowerCase();
  if (!normalized) return true;
  if (/\b(balance|b\/f|brought forward|carried forward|available|ledger)\b/i.test(normalized)) return true;
  return amountMatches.length === 1 && normalized.split(/\s+/).length <= 2;
};

const isLowInfoDescription = (description = '') =>
  /^(?:payout|deposit|transfer|payment|receipt)(?:\s+(?:eur|sgd|usd|gbp))?$/i.test(normalizeSpace(description));

const extractWiseDetailDescription = (line = '') => {
  const normalized = normalizeSpace(line);
  const payMatch = normalized.match(
    /\bpay\s+(?:[A-Z]{3}\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\s+(?:[A-Z]{3}\s+)?to\s+(.+?)(?=\s+(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})|\s*$)/i
  );
  if (payMatch?.[1]) return `Pay to ${normalizeSpace(payMatch[1])}`;

  const receiveMatch = normalized.match(
    /\b(?:receive|received)\s+(?:[A-Z]{3}\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?\s+(?:[A-Z]{3}\s+)?from\s+(.+?)(?=\s+(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})|\s*$)/i
  );
  if (receiveMatch?.[1]) return `Receive from ${normalizeSpace(receiveMatch[1])}`;

  return '';
};

const extractWiseDetail = (line = '') => {
  const normalized = normalizeSpace(line);
  const amountSource = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{2})?';
  const payMatch = normalized.match(
    new RegExp(`\\bpay\\s+(?:([A-Z]{3})\\s+)?(${amountSource})(?:\\s+([A-Z]{3}))?\\s+to\\s+(.+?)(?=\\s+${amountSource}|\\s*$)`, 'i')
  );
  if (payMatch?.[2] && payMatch?.[4]) {
    return {
      description: `Pay to ${normalizeSpace(payMatch[4])}`,
      amount: parseAmount(payMatch[2]),
      currency: (payMatch[1] || payMatch[3] || '').toUpperCase(),
      direction: 'out'
    };
  }

  const receiveMatch = normalized.match(
    new RegExp(`\\b(?:receive|received)\\s+(?:([A-Z]{3})\\s+)?(${amountSource})(?:\\s+([A-Z]{3}))?\\s+from\\s+(.+?)(?=\\s+${amountSource}|\\s*$)`, 'i')
  );
  if (receiveMatch?.[2] && receiveMatch?.[4]) {
    return {
      description: `Receive from ${normalizeSpace(receiveMatch[4])}`,
      amount: parseAmount(receiveMatch[2]),
      currency: (receiveMatch[1] || receiveMatch[3] || '').toUpperCase(),
      direction: 'in'
    };
  }

  return null;
};

const findCurrencyAmount = (line = '', currency = '') => {
  if (!currency) return null;
  const amountSource = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{2})?';
  const escapedCurrency = currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(
    normalizeSpace(line).matchAll(
      new RegExp(`(?:\\b${escapedCurrency}\\s+(${amountSource})|(${amountSource})\\s+${escapedCurrency}\\b)`, 'gi')
    )
  );
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return parseAmount(last[1] || last[2] || '');
};

const parseLineTransaction = (line, filename, period = null) => {
  const cleaned = normalizeSpace(line);
  if (!cleaned || cleaned.length < 8 || BANK_LINE_NOISE.test(cleaned)) return null;

  const date = extractDate(cleaned, filename, period);
  if (!date?.iso) return null;

  const amountMatches = extractAmountMatches(cleaned);

  if (!amountMatches.length) return null;

  const transactionAmount = (() => {
    if (amountMatches.length >= 3) {
      const [debit, credit] = amountMatches.slice(-3, -1);
      if (Math.abs(debit.amount) > 0) return { ...debit, direction: 'out' };
      if (Math.abs(credit.amount) > 0) return { ...credit, direction: 'in' };
    }
    if (amountMatches.length === 2) {
      const [first, second] = amountMatches;
      if (
        amountsNearlyEqual(Math.abs(first.amount), Math.abs(second.amount)) &&
        (hasInflowWords(cleaned) || !hasOutflowWords(cleaned))
      ) {
        return { ...first, direction: 'in' };
      }
      if (Math.abs(first.amount) === 0 && Math.abs(second.amount) > 0) {
        return { ...second, direction: 'in' };
      }
      if (/\b(?:CR|DR)\b/i.test(second.token) && !/\b(?:CR|DR)\b/i.test(first.token)) {
        return {
          ...second,
          direction: directionForLine(cleaned, second.token, second.amount)
        };
      }
    }
    const selected = amountMatches.length >= 2 ? amountMatches[amountMatches.length - 2] : amountMatches[0];
    return {
      ...selected,
      direction: directionForLine(cleaned, selected.token, selected.amount)
    };
  })();

  const balance = amountMatches.length >= 2 ? amountMatches[amountMatches.length - 1].amount : null;
  const withoutDate = normalizeSpace(cleaned.replace(date.raw, ' '));
  const rawDescription = normalizeSpace(
    amountMatches.reduce((text, match) => text.replace(match.token, ' '), withoutDate)
  );
  const wiseDetailDescription = extractWiseDetailDescription(cleaned);
  const description =
    wiseDetailDescription && (/^(?:payout|deposit|transfer|payment|receipt)\b/i.test(rawDescription) || isLowInfoDescription(rawDescription))
      ? wiseDetailDescription
      : rawDescription;

  if (!description || Math.abs(transactionAmount.amount) === 0) return null;
  if (isLowInfoDescription(description)) return null;
  if (isWeakBalanceLine(description, amountMatches)) return null;

  const amount = Math.abs(transactionAmount.amount);
  return {
    date: date.iso,
    description,
    money_in: transactionAmount.direction === 'in' ? amount : 0,
    money_out: transactionAmount.direction === 'out' ? amount : 0,
    balance,
    confidence: amountMatches.length >= 2 ? 'medium' : 'low',
    parser_flags: amountMatches.length === 1 ? ['single_amount_row'] : [],
    source_line: cleaned
  };
};

const compactBlockDescription = (blockLines = [], amountMatches = [], dateRaw = '') => {
  const amountTokens = new Set(amountMatches.map((match) => match.token));
  return normalizeSpace(
    blockLines
      .map((line) => line.replace(dateRaw, ' '))
      .map((line) => {
        let next = line;
        amountTokens.forEach((token) => {
          next = next.replace(token, ' ');
        });
        return next;
      })
      .join(' ')
      .replace(/\b(?:Deposit|Payout|Payment|Transfer|Pay|Receive|Received)\b/gi, ' ')
      .replace(/\b(?:EUR|SGD|USD|GBP)\b/g, ' ')
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{13,}\b/gi, ' ')
      .replace(/\s*\|\s*$/g, ' ')
  );
};

const parseTransactionBlock = (blockLines = [], filename = '', statementSummary = null, period = null) => {
  const joined = normalizeSpace(blockLines.join(' '));
  const date = extractDate(joined, filename, period);
  if (!date?.iso || BANK_LINE_NOISE.test(joined)) return null;

  const amountMatches = extractAmountMatches(joined);
  if (!amountMatches.length) return null;

  const wiseDetail = extractWiseDetail(joined);
  const statementCurrency = inferStatementCurrency(filename, joined);
  const accountCurrencyAmount =
    wiseDetail?.currency && statementCurrency && wiseDetail.currency !== statementCurrency
      ? findCurrencyAmount(joined, statementCurrency)
      : null;
  const typeText = blockLines.slice(0, 3).join(' ');
  const hasDepositType = /\bdeposit\b/i.test(typeText);
  const hasPayoutType = /\bpayout\b/i.test(typeText);
  const direction = wiseDetail?.direction || (hasDepositType ? 'in' : hasPayoutType ? 'out' : directionForLine(joined, amountMatches[0].token, amountMatches[0].amount));
  const amount = Math.abs(accountCurrencyAmount || wiseDetail?.amount || amountMatches[0].amount);
  if (!amount) return null;

  const lastAmount = amountMatches.length >= 2 ? Math.abs(amountMatches[amountMatches.length - 1].amount) : null;
  const balance = wiseDetail && amountsNearlyEqual(lastAmount, amount) ? null : lastAmount;
  const description = wiseDetail?.description || compactBlockDescription(blockLines, amountMatches, date.raw);
  if (!description || isLowInfoDescription(description)) return null;

  return {
    date: date.iso,
    description,
    money_in: direction === 'in' ? amount : 0,
    money_out: direction === 'out' ? amount : 0,
    balance,
    confidence: wiseDetail || hasDepositType || hasPayoutType ? 'high' : 'medium',
    parser_flags: statementSummary ? ['block_parser'] : [],
    source_line: joined
  };
};

const buildDateBlocks = (text = '', filename = '', period = null) => {
  const blocks = [];
  let current = [];
  text.split(/\r?\n/).map(normalizeSpace).filter(Boolean).forEach((line) => {
    if (startsWithDate(line, filename, period)) {
      if (current.length) blocks.push(current);
      current = [line];
      return;
    }
    if (current.length) current.push(line);
  });
  if (current.length) blocks.push(current);
  return blocks;
};

const parseBlockTransactions = (text, filename, statementSummary, period = null) => {
  const seen = new Set();
  return buildDateBlocks(text, filename, period)
    .map((block) => parseTransactionBlock(block, filename, statementSummary, period))
    .filter(Boolean)
    .filter((transaction) => {
      const key = `${transaction.date}|${Number(transaction.money_in || transaction.money_out || 0).toFixed(2)}|${transaction.balance ?? ''}|${transaction.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.date.localeCompare(right.date));
};

const splitDelimitedLine = (line = '', delimiter = ',') => {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
};

// CSV permits a quoted cell to span physical lines. Keep the existing
// line-oriented parser unchanged for ordinary exports, but join physical
// continuations until their quote closes. An unterminated quote is ambiguous,
// so refuse the delimited interpretation rather than shifting later columns.
const splitDelimitedRecords = (text = '') => {
  const records = [];
  let current = '';
  let inQuotes = false;

  for (const line of String(text).split(/\r?\n/)) {
    current = current ? `${current}\n${line}` : line;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== '"') continue;
      if (line[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
    }
    if (!inQuotes) {
      if (current.trim()) records.push(current.trim());
      current = '';
    }
  }

  return inQuotes ? null : records;
};

const detectDelimiter = (line = '') => {
  if (line.includes('\t')) return '\t';
  if (line.includes(';')) return ';';
  if (line.includes(',')) return ',';
  return '';
};

const findHeaderIndex = (lines) =>
  lines.findIndex((line, index) => {
    if (index > 12) return false;
    const normalized = line.toLowerCase();
    return normalized.includes('date') && /(description|details|narrative|particulars|amount|debit|credit)/.test(normalized);
  });

const findColumn = (headers, patterns) =>
  headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));

const parseDelimitedTransactions = (text, filename, period = null) => {
  const lines = splitDelimitedRecords(text);
  if (lines === null) return null;
  const headerIndex = findHeaderIndex(lines);
  if (headerIndex === -1) return [];
  if (!detectDelimiter(lines[headerIndex])) return [];

  const delimiter = detectDelimiter(lines[headerIndex]);
  const headers = splitDelimitedLine(lines[headerIndex], delimiter).map((header) => header.toLowerCase());
  // Revolut supplies both Started Date and Completed Date; the completed date
  // is the posting date and must win even though it appears later in the row.
  const completedDateIndex = findColumn(headers, [/completed date/]);
  const dateIndex = completedDateIndex >= 0
    ? completedDateIndex
    : findColumn(headers, [/^date$/, /transaction date/, /posting date/, /value date/, /started date/]);
  const descriptionIndex = findColumn(headers, [/description/, /details/, /narrative/, /particulars/, /reference/]);
  const amountIndex = findColumn(headers, [/^amount\b/, /transaction amount/]);
  const debitIndex = findColumn(headers, [/debit/, /withdrawal/, /paid out/, /money out/]);
  const creditIndex = findColumn(headers, [/credit/, /deposit/, /paid in/, /money in/]);
  const balanceIndex = findColumn(headers, [/balance/]);

  if (dateIndex === -1 || (amountIndex === -1 && debitIndex === -1 && creditIndex === -1)) return [];

  return lines
    .slice(headerIndex + 1)
    .map((line) => ({ line, cells: splitDelimitedLine(line, delimiter) }))
    .map(({ line, cells }) => {
      const date = extractDate(cells[dateIndex] || '', filename, period);
      if (!date?.iso) return null;
      const debit = debitIndex >= 0 ? Math.abs(parseAmount(cells[debitIndex])) : 0;
      const credit = creditIndex >= 0 ? Math.abs(parseAmount(cells[creditIndex])) : 0;
      const amount = amountIndex >= 0 ? parseAmount(cells[amountIndex]) : 0;
      const moneyIn = credit || (amount > 0 ? amount : 0);
      const moneyOut = debit || (amount < 0 ? Math.abs(amount) : 0);
      if (!moneyIn && !moneyOut) return null;

      return {
        date: date.iso,
        description: normalizeSpace(cells[descriptionIndex] || 'Bank transaction'),
        money_in: moneyIn,
        money_out: moneyOut,
        balance: balanceIndex >= 0 ? parseAmount(cells[balanceIndex]) : null,
        confidence: descriptionIndex >= 0 ? 'high' : 'medium',
        source_line: line
      };
    })
    .filter(Boolean);
};

const startsWithDate = (line = '', filename = '', period = null) => {
  const cleaned = normalizeSpace(line);
  const date = extractDate(cleaned, filename, period);
  if (!date?.raw) return false;
  return cleaned.slice(0, Math.max(16, date.raw.length + 2)).includes(date.raw);
};

const isAirwallexStatement = (text = '') =>
  /\bAirwallex\b/i.test(text) && /\bDate\s+Details\s+Credit\s+Debit\s+Balance\b/i.test(text);

const isAirwallexNoiseLine = (line = '') =>
  /\b(Airwallex|airwallex\.com|Account Holder|Account Details|IBAN|Account Activity|Date Details Credit Debit Balance|Starting balance|Page \d+ of \d+)\b/i.test(line);

const isAirwallexTypeLine = (line = '') =>
  /^(Deposit|Payout|Conversion|Adjustment)$/i.test(normalizeSpace(line));

const extractAirwallexRowDate = (line = '', filename = '', period = null) => {
  const cleaned = normalizeSpace(line);
  const monthFirst = cleaned.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s-]*(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?[,\s-]+((?:19|20)\d{2})\b/i
  );
  if (monthFirst) {
    return {
      raw: monthFirst[0],
      iso: toIsoDate(monthFirst[3], MONTHS[monthFirst[1].toLowerCase()], monthFirst[2])
    };
  }

  const dayFirst = cleaned.match(
    /\b(0?[1-9]|[12]\d|3[01])[-\s]*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s-]+((?:19|20)\d{2})\b/i
  );
  if (dayFirst) {
    return {
      raw: dayFirst[0],
      iso: toIsoDate(dayFirst[3], MONTHS[dayFirst[2].toLowerCase()], dayFirst[1])
    };
  }

  return extractDate(cleaned, filename, period);
};

const extractCurrencyAmountMatches = (line = '', currency = '') => {
  const targetCurrency = currency || inferStatementCurrency('', line);
  if (!targetCurrency) return [];
  const amountSource = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{2})?';
  const escapedCurrency = targetCurrency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(
    normalizeSpace(line).matchAll(new RegExp(`(${amountSource})\\s+${escapedCurrency}\\b`, 'gi'))
  ).map((match) => ({
    token: match[0],
    index: match.index || 0,
    amount: parseAmount(match[1])
  }));
};

const stripTokens = (value = '', tokens = []) => {
  let next = String(value);
  tokens.forEach((token) => {
    next = next.replace(token, ' ');
  });
  return normalizeSpace(next);
};

const cleanAirwallexDescription = (value = '', dateRaw = '', amountTokens = []) =>
  stripTokens(String(value).replace(dateRaw, ' '), amountTokens)
    .replace(/\b(?:Deposit|Payout|Adjustment|Conversion)\b/gi, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{13,}\b/gi, ' ')
    .replace(/\s*\|\s*$/g, ' ')
    .trim();

const describeAirwallexRow = (row) => {
  const source = normalizeSpace([row.baseDescription, ...row.detailLines].join(' '));
  const wiseDetail = extractWiseDetailDescription(source);
  if (wiseDetail && /^(?:Payout|Pay)\b/i.test(row.type || row.baseDescription)) return wiseDetail;
  if (/^Adjustment$/i.test(row.type || row.baseDescription)) {
    const reason = row.detailLines.find((line) => /^Reason:/i.test(line));
    return reason ? normalizeSpace(`Adjustment ${reason}`) : 'Adjustment';
  }
  if (/^Conversion$/i.test(row.type || row.baseDescription)) {
    const buyLine = row.detailLines.find((line) => /^Buy\b/i.test(line));
    return buyLine ? normalizeSpace(`Conversion ${buyLine}`) : 'Conversion';
  }
  return cleanAirwallexDescription(source) || row.type || 'Bank transaction';
};

const parseAirwallexTransactions = (text = '', filename = '', statementSummary = null, period = null) => {
  if (!isAirwallexStatement(text)) return [];

  const currency = inferStatementCurrency(filename, text);
  const rows = [];
  let pendingType = '';
  let pendingPrefixLines = [];
  let current = null;

  const finalizeCurrent = () => {
    if (!current) return;
    rows.push(current);
    current = null;
  };

  text.split(/\r?\n/).map(normalizeSpace).filter(Boolean).forEach((line) => {
    if (isAirwallexNoiseLine(line)) return;

    if (isAirwallexTypeLine(line)) {
      finalizeCurrent();
      pendingType = normalizeSpace(line);
      pendingPrefixLines = [];
      return;
    }

    const date = extractAirwallexRowDate(line, filename, period);
    const currencyAmounts = extractCurrencyAmountMatches(line, currency);
    const isTransactionLine = date?.iso && currencyAmounts.length >= 2;

    if (isTransactionLine) {
      finalizeCurrent();
      const movementMatch = currencyAmounts[currencyAmounts.length - 2];
      const balanceMatch = currencyAmounts[currencyAmounts.length - 1];
      const lineBeforeMovement = line.slice(0, movementMatch.index);
      const inlineType = normalizeSpace(lineBeforeMovement).match(/\b(Deposit|Payout|Conversion|Adjustment)\b/i)?.[1] || '';
      const rowType = pendingType || inlineType;
      const baseDescription = normalizeSpace(
        [
          ...pendingPrefixLines,
          cleanAirwallexDescription(lineBeforeMovement, date.raw, [movementMatch.token, balanceMatch.token])
        ].join(' ')
      );
      current = {
        date: date.iso,
        type: rowType,
        baseDescription,
        detailLines: [],
        movement: Math.abs(movementMatch.amount),
        balance: balanceMatch.amount,
        source_line: normalizeSpace([...pendingPrefixLines, line].join(' '))
      };
      pendingType = '';
      pendingPrefixLines = [];
      return;
    }

    if (current) {
      current.detailLines.push(line);
      current.source_line = normalizeSpace(`${current.source_line} ${line}`);
      return;
    }

    if (pendingType && !isAirwallexNoiseLine(line)) {
      pendingPrefixLines.push(line);
    }
  });
  finalizeCurrent();

  let previousBalance = statementSummary?.starting_balance ?? null;
  return rows
    .filter((row) => row.date && row.movement > 0 && row.balance != null)
    .map((row) => {
      const delta = previousBalance == null ? null : Number(row.balance) - Number(previousBalance);
      const directionFromBalance =
        delta != null && amountsNearlyEqual(Math.abs(delta), row.movement)
          ? delta > 0 ? 'in' : 'out'
          : '';
      const direction =
        directionFromBalance ||
        (/Deposit|Adjustment/i.test(row.type) ? 'in' : 'out');
      previousBalance = row.balance;

      return {
        date: row.date,
        description: describeAirwallexRow(row),
        money_in: direction === 'in' ? row.movement : 0,
        money_out: direction === 'out' ? row.movement : 0,
        balance: row.balance,
        confidence: directionFromBalance ? 'high' : 'medium',
        parser_flags: ['airwallex_table'],
        source_line: row.source_line
      };
    });
};

const buildJoinedLineCandidates = (lines, filename, period = null) => {
  const candidates = [];
  const normalizedLines = lines.map(normalizeSpace).filter(Boolean);

  normalizedLines.forEach((line, index) => {
    if (!extractDate(line, filename, period) || BANK_LINE_NOISE.test(line)) return;

    let joined = line;
    let best = line;
    let bestAmountCount = extractAmountMatches(line).length;
    for (let offset = 1; offset <= 24; offset += 1) {
      const next = normalizedLines[index + offset];
      if (!next || BANK_LINE_NOISE.test(next)) break;
      if (startsWithDate(next, filename, period)) break;

      joined = normalizeSpace(`${joined} ${next}`);
      const matches = extractAmountMatches(joined);
      if (matches.length >= bestAmountCount) {
        best = joined;
        bestAmountCount = matches.length;
      }
      if (matches.length >= 3) break;
      if (
        matches.length >= 2 &&
        Math.abs(matches[0].amount) > 0 &&
        Math.abs(matches[1].amount) > 0
      ) {
        break;
      }
    }

    candidates.push(best);
  });

  return candidates;
};

const isTransactionTableHeader = (line = '') => {
  const compact = normalizeSpace(line).replace(/\s+/g, '').toLowerCase();
  return compact.includes('date') &&
    compact.includes('description') &&
    compact.includes('balance') &&
    /(withdrawal|deposit|debit|credit|moneyin|moneyout)/.test(compact);
};

const transactionTableText = (text = '') => {
  const lines = sanitizeStatementText(text).split(/\r?\n/);
  const headerIndex = lines.findIndex(isTransactionTableHeader);
  return (headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines).join('\n');
};

// Some PDF generators expose the summary values but drop their visual labels.
// Running balances still let us recover the printed opening balance without
// guessing: exactly one pre-table amount must equal first_balance ± first_row,
// and every subsequent printed balance delta must equal that row's movement.
// This proves direction only; no movement amount or missing row is synthesized.
const deriveBalanceChainSummary = (text = '', transactions = [], summary = null) => {
  if (!Array.isArray(transactions) || transactions.length === 0) return summary;

  const base = summary ? { ...summary } : {};
  const printedPeriod = parseStatementPeriod(text);
  if (printedPeriod) {
    base.period_start = base.period_start || printedPeriod.start;
    base.period_end = base.period_end || printedPeriod.end;
  }
  if (base.starting_balance != null) return base;

  const clean = sanitizeStatementText(text);
  const lines = clean.split(/\r?\n/);
  const headerIndex = lines.findIndex(isTransactionTableHeader);
  if (headerIndex < 0) return Object.keys(base).length ? base : null;

  const first = transactions[0];
  const firstBalance = Number(first?.balance);
  const firstMovement = Math.abs(Number(first?.money_in || 0) || Number(first?.money_out || 0));
  if (!Number.isFinite(firstBalance) || !firstMovement) return Object.keys(base).length ? base : null;

  const headerAmounts = extractAmountMatches(lines.slice(0, headerIndex).join('\n'))
    .map((match) => Math.abs(Number(match.amount)))
    .filter((amount) => Number.isFinite(amount));
  const possibleOpenings = [firstBalance - firstMovement, firstBalance + firstMovement];
  const matchedOpenings = possibleOpenings.filter((candidate, index) =>
    possibleOpenings.findIndex((other) => amountsNearlyEqual(other, candidate)) === index &&
    headerAmounts.some((printed) => amountsNearlyEqual(printed, Math.abs(candidate)))
  );
  if (matchedOpenings.length !== 1) return Object.keys(base).length ? base : null;

  const opening = matchedOpenings[0];
  let previousBalance = opening;
  for (const transaction of transactions) {
    const balance = Number(transaction?.balance);
    const movement = Math.abs(Number(transaction?.money_in || 0) || Number(transaction?.money_out || 0));
    if (
      !Number.isFinite(balance) ||
      !movement ||
      !amountsNearlyEqual(Math.abs(balance - previousBalance), movement)
    ) {
      return Object.keys(base).length ? base : null;
    }
    previousBalance = balance;
  }

  return {
    ...base,
    starting_balance: opening,
    ending_balance: previousBalance,
    balance_chain_proof: 'printed_header_opening_and_running_balances'
  };
};

const parseTextTransactions = (text, filename) => {
  const cleanText = sanitizeStatementText(text);
  const period = parseStatementPeriod(cleanText);
  const delimited = parseDelimitedTransactions(cleanText, filename, period);
  if (delimited === null) {
    // Unterminated quote. Refuse outright ONLY when the raw lines actually
    // look delimited (header + delimiter) — a genuinely malformed CSV must
    // not ship shifted columns. Anywhere else (PDF text, OCR, vision) a
    // stray quote is noise and the non-delimited parsers below must still
    // run (F-14B-STRAY-QUOTE-ZEROES-STATEMENT).
    const rawLines = cleanText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const rawHeaderIndex = findHeaderIndex(rawLines);
    if (rawHeaderIndex >= 0 && detectDelimiter(rawLines[rawHeaderIndex])) return [];
  } else if (delimited.length > 0) return delimited;

  const statementSummary = parseStatementSummary(cleanText);
  const airwallexTransactions = parseAirwallexTransactions(cleanText, filename, statementSummary, period);
  if (airwallexTransactions.length > 0) return airwallexTransactions.slice(0, 500);

  const tableText = transactionTableText(cleanText);
  const blockTransactions = parseBlockTransactions(tableText, filename, statementSummary, period);
  if (blockTransactions.length > 0 && /(?:^|\n)\s*(?:Deposit|Payout)\s*(?:\n|$)|\bpay\s+(?:[A-Z]{3}\s+)?\d/i.test(tableText)) {
    const provenSummary = deriveBalanceChainSummary(cleanText, blockTransactions, statementSummary);
    return inferDirectionFromBalances(blockTransactions, provenSummary).slice(0, 400);
  }
  const seen = new Set();
  const lines = tableText.split(/\r?\n/);
  // Joined candidates come first, but both sets retain source order. Sorting
  // candidates by amount-count used to scramble same-day running balances,
  // after which the balance repair shifted amounts between neighboring rows.
  const candidates = [...buildJoinedLineCandidates(lines, filename, period), ...lines];

  const parsed = candidates
    .map((line) => parseLineTransaction(line, filename, period))
    .filter(Boolean)
    .filter((transaction) => {
      const movement = Number(transaction.money_in || transaction.money_out || 0).toFixed(2);
      const balance = transaction.balance == null ? '' : Number(transaction.balance).toFixed(2);
      const descriptionKey = normalizeSpace(transaction.description).toLowerCase().slice(0, 48);
      const key = `${transaction.date}|${movement}|${balance}|${descriptionKey}`;
      const balanceKey = balance ? `${transaction.date}|balance:${balance}` : '';
      if (balanceKey && seen.has(balanceKey)) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      if (balanceKey) seen.add(balanceKey);
      return true;
    })
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, 400);

  const provenSummary = deriveBalanceChainSummary(cleanText, parsed, statementSummary);
  return inferDirectionFromBalances(parsed, provenSummary);
};

const amountsNearlyEqual = (left, right) =>
  Math.abs(Number(left || 0) - Number(right || 0)) < 0.01;

// Structured extraction is model judgment; running-balance arithmetic is a
// correctness invariant. A model can read the right amount from a statement
// but put it in the wrong debit/credit column. When the statement's opening
// balance and the row-by-row balances prove the sequence orientation, repair
// only those directions whose printed movement amount exactly equals the
// adjacent balance delta. We deliberately do not synthesize amounts or repair
// gaps: a missing/incorrect row must still fail the statement equation below.
//
// The regex and structured paths share this exact direction-only repair. A
// prior regex-only helper replaced the movement amount with the delta; that
// violated this invariant and shifted amounts after ambiguous dates reordered
// rows, so there is deliberately only one repair implementation now.
export const repairStructuredDirectionsFromBalances = (
  transactions = [],
  statementSummary = null
) => {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];
  if (statementSummary?.starting_balance == null) return transactions;
  const startingBalance = Number(statementSummary?.starting_balance);
  if (!Number.isFinite(startingBalance)) return transactions;

  const first = transactions[0];
  const firstBalance = first?.balance == null ? Number.NaN : Number(first.balance);
  const firstMovement = Math.abs(Number(first?.money_in || 0) || Number(first?.money_out || 0));
  // This proves that row 1 follows the printed opening balance. Without it,
  // the statement may be newest-first; applying forward deltas there would
  // "repair" every row in the wrong direction.
  if (
    !Number.isFinite(firstBalance) ||
    !firstMovement ||
    !amountsNearlyEqual(Math.abs(firstBalance - startingBalance), firstMovement)
  ) {
    return transactions;
  }

  return transactions.map((transaction, index) => {
    const previousBalance = index === 0
      ? startingBalance
      : transactions[index - 1]?.balance == null
        ? Number.NaN
        : Number(transactions[index - 1].balance);
    const balance = transaction?.balance == null ? Number.NaN : Number(transaction.balance);
    const movement = Math.abs(Number(transaction?.money_in || 0) || Number(transaction?.money_out || 0));
    if (
      !Number.isFinite(previousBalance) ||
      !Number.isFinite(balance) ||
      !movement
    ) {
      return transaction;
    }
    const delta = balance - previousBalance;
    if (!delta || !amountsNearlyEqual(Math.abs(delta), movement)) return transaction;

    const nextDirection = delta > 0 ? 'in' : 'out';
    const currentDirection = Number(transaction.money_in || 0) > 0 ? 'in' : 'out';
    if (nextDirection === currentDirection) return transaction;

    return {
      ...transaction,
      money_in: nextDirection === 'in' ? movement : 0,
      money_out: nextDirection === 'out' ? movement : 0,
      parser_flags: [...new Set([...(transaction.parser_flags || []), 'direction_from_balance'])]
    };
  });
};

const inferDirectionFromBalances = (transactions = [], statementSummary = null) =>
  repairStructuredDirectionsFromBalances(transactions, statementSummary);

const countLines = (text = '') => text.split(/\r?\n/).filter(Boolean).length;

const extractPdfTextWithLocalOcr = (base64) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'donna-statement-ocr-'));
  const pdfPath = join(tempDir, 'statement.pdf');

  try {
    mkdirSync(SWIFT_MODULE_CACHE_DIR, { recursive: true });
    writeFileSync(pdfPath, Buffer.from(String(base64 || ''), 'base64'));
    return execFileSync('/usr/bin/swift', [OCR_SCRIPT_PATH, pdfPath, String(OCR_MAX_PAGES)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: SWIFT_MODULE_CACHE_DIR,
        TMPDIR: tempDir
      },
      maxBuffer: 12 * 1024 * 1024,
      timeout: OCR_TIMEOUT_MS
    });
  } catch {
    return '';
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
};

// LLM-first tier over the PDF's own text layer. The regex tiers below
// are per-format scaffolding (English keywords, SG/UK layouts); a
// statement format the parser has never seen — one client's Finnish
// tiliote shipped every line as "Tilisiirto" — is exactly where the
// strong model with the semantic schema wins. Behind the
// BANK_STATEMENT_LLM_EXTRACTION config-plane flag (threaded here as
// `llmFirst`); any failure or empty result falls through to the legacy
// tiers unchanged, so the flag can only ADD extraction quality.
const tryLlmTextExtraction = async (text, filename, { bypassCache = false } = {}) => {
  const clean = sanitizeStatementText(text);
  if (!clean.trim() || !isOpenAiVisionConfigured()) return null;
  try {
    const startedAt = Date.now();
    const structured = await extractStructuredFromStatementText({
      text: clean,
      filename,
      periodHint: inferFilenamePeriod(filename), bypassCache
    });
    if (Array.isArray(structured?.transactions) && structured.transactions.length > 0) {
      return {
        text: clean,
        source: 'openai_text_structured',
        lineCount: countLines(clean),
        transactions: structured.transactions,
        statement_summary_hint: structured.statement_summary || null,
        extraction_model: structured.model || null,
        llm_elapsed_ms: Date.now() - startedAt,
        llm_cache_hit: Boolean(structured.cache_hit)
      };
    }
    console.warn('[bankStatement] llm-first text extraction returned no transactions — falling back to regex tiers', {
      filename
    });
  } catch (error) {
    console.warn('[bankStatement] llm-first text extraction failed — falling back to regex tiers', {
      filename,
      code: error?.code,
      message: error?.message
    });
  }
  return null;
};

const selectPdfExtraction = async (base64, filename, { llmFirst = false, bypassCache = false } = {}) => {
  const candidates = extractBizfilePdfTextCandidatesFromBase64(base64);
  const texts = candidates.length > 0
    ? candidates
    : [extractBizfilePdfTextFromBase64(base64)];

  if (llmFirst) {
    // The regex-oriented candidate scoring below optimizes for
    // parseability; the model just wants the fullest text.
    const llmText = texts.reduce(
      (best, candidate) => (String(candidate || '').length > String(best || '').length ? candidate : best),
      ''
    );
    const llmExtraction = await tryLlmTextExtraction(llmText, filename, { bypassCache });
    if (llmExtraction) return llmExtraction;
  }

  const scoreCandidate = (candidate) => {
    const uniqueDates = new Set(candidate.transactions.map((transaction) => transaction.date)).size;
    const uniqueDescriptions = new Set(
    candidate.transactions.map((transaction) => normalizeSpace(transaction.description).toLowerCase())
    ).size;
    const sourceAmountDensity = candidate.transactions.reduce(
      (total, transaction) => total + extractAmountMatches(transaction.source_line || '').length,
      0
    );
    return (
      candidate.transactions.length * 10000 +
      uniqueDates * 100 +
      uniqueDescriptions * 50 +
      sourceAmountDensity * 5 -
      candidate.lineCount * 0.1
    );
  };

  const bestTextLayer = texts
    .map((text) => ({
      text: sanitizeStatementText(text),
      source: 'text',
      lineCount: countLines(sanitizeStatementText(text)),
      transactions: parseTextTransactions(text, filename)
    }))
    .reduce(
      (winner, candidate) => {
        return scoreCandidate(candidate) > scoreCandidate(winner) ? candidate : winner;
      },
      { text: '', source: 'text', lineCount: 0, transactions: [] }
    );

  if (bestTextLayer.transactions.length > 0 || bestTextLayer.lineCount > 0) return bestTextLayer;

  // First OCR tier: local Swift OCR via Apple Vision framework. Only
  // works on macOS dev machines; on Vercel/Linux this returns empty.
  // Host-gated (see isLocalOcrEnabled above): skipped on the desktop
  // host so a scanned statement reaches structured vision on the
  // user's key instead of shipping regex-parsed OCR text.
  const ocrText = isLocalOcrEnabled() ? extractPdfTextWithLocalOcr(base64) : '';
  const ocrCandidate = {
    text: sanitizeStatementText(ocrText),
    source: 'ocr',
    lineCount: countLines(sanitizeStatementText(ocrText)),
    transactions: parseTextTransactions(ocrText, filename)
  };
  const ocrLooksLikeStatement = BANK_STATEMENT_TEXT_HINT.test(ocrText);
  const safeOcrCandidate = ocrLooksLikeStatement
    ? ocrCandidate
    : { ...ocrCandidate, transactions: [] };

  if (ocrLooksLikeStatement && scoreCandidate(ocrCandidate) > scoreCandidate(bestTextLayer)) {
    return ocrCandidate;
  }
  if (bestTextLayer.lineCount === 0 && safeOcrCandidate.lineCount > 0) {
    return safeOcrCandidate;
  }

  // Second OCR tier: cloud vision (OpenAI). The one that actually works
  // on Vercel. Only fire when both text-layer extraction and local OCR
  // gave us nothing useful — keeps the OpenAI bill bounded.
  //
  // We try structured-JSON extraction first (model returns transactions
  // directly via json_schema). If that succeeds, we skip the regex
  // pipeline entirely — the model has already done the structural work
  // the regex would have done. If structured extraction fails or
  // returns zero rows, we fall back to plain-text OCR + regex parser.
  if (bestTextLayer.lineCount === 0 && safeOcrCandidate.lineCount === 0 && isOpenAiVisionConfigured()) {
    const visionStart = Date.now();
    let visionTooLarge = null;
    // When structured vision already burned the per-chunk AbortController
    // budget (240s) by timing out or aborting, the plain-text vision
    // fallback would re-spend ANOTHER full 240s on the same source PDF.
    // For a 16-month statement that's two passes × 240s = 480s, well past
    // Vercel's 300s function ceiling — the parse dies before persisting
    // anything (Airwallex was reproducing this with `parse_summary=null`
    // and `parse_stage='extracting'`). When we detect a timeout/abort or
    // an OpenAI-side guardrail in the FIRST call, we skip the fallback
    // and surface a clear reason so the caller can render guidance
    // instead of waiting for the function-kill.
    let visionTimedOut = null;
    try {
      const structured = await extractStructuredFromOpenAiVisionPaginated({
        base64,
        filename,
        mimeType: 'application/pdf',
        periodHint: inferFilenamePeriod(filename), bypassCache
      });
      if (Array.isArray(structured?.transactions) && structured.transactions.length > 0) {
        return {
          text: '',
          source: 'openai_vision_structured',
          lineCount: structured.transactions.length,
          transactions: structured.transactions,
          statement_summary_hint: structured.statement_summary || null,
          vision_cache_hit: Boolean(structured.cache_hit),
          vision_elapsed_ms: Date.now() - visionStart
        };
      }
      console.warn('[bankStatement] structured vision returned no transactions', {
        filename,
        normalized: 0,
        raw_summary: structured?.statement_summary || null
      });
    } catch (error) {
      console.error('[bankStatement] structured vision threw', {
        filename,
        code: error?.code,
        name: error?.name,
        status: error?.statusCode,
        message: error?.message
      });
      // Size guardrail tripped — the plain-text vision fallback would
      // hit the same wall, so skip it and surface the size info so the
      // caller can render a clear warning.
      if (error?.code === 'OPENAI_VISION_PDF_TOO_LARGE') {
        visionTooLarge = {
          byteSize: error.byteSize,
          maxBytes: error.maxBytes,
          message: error.message
        };
      }
      // Timeout / abort — the structured call already burned its 240s
      // AbortController budget. Running plain-text vision next would
      // burn ANOTHER 240s; the function dies at 300s with no result.
      // Skip the fallback and surface the timeout so the caller can
      // render guidance and the worker can persist a useful reason.
      const isAbort = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
      if (isAbort) {
        visionTimedOut = {
          message: error?.message || 'Structured vision OCR timed out before returning a result.',
          elapsed_ms: Date.now() - visionStart
        };
      }
    }
    if (!visionTooLarge && !visionTimedOut) {
      try {
        const visionText = await ocrPdfWithOpenAiVision({
          base64,
          filename,
          mimeType: 'application/pdf'
        });
        if (visionText && visionText.trim().length > 0) {
          const transactions = parseTextTransactions(visionText, filename);
          console.log('[bankStatement] plain vision fallback ran', {
            filename,
            line_count: countLines(visionText),
            regex_transactions: transactions.length
          });
          return {
            text: sanitizeStatementText(visionText),
            source: 'openai_vision_text',
            lineCount: countLines(visionText),
            transactions,
            vision_elapsed_ms: Date.now() - visionStart
          };
        }
      } catch (error) {
        console.error('[bankStatement] plain vision OCR threw', {
          filename,
          code: error?.code,
          status: error?.statusCode,
          message: error?.message
        });
      }
    }
    if (visionTooLarge) {
      return {
        ...bestTextLayer,
        vision_skipped: 'pdf_too_large',
        vision_skipped_details: visionTooLarge,
        vision_elapsed_ms: Date.now() - visionStart
      };
    }
    if (visionTimedOut) {
      return {
        ...bestTextLayer,
        vision_skipped: 'timeout',
        vision_skipped_details: visionTimedOut,
        vision_elapsed_ms: Date.now() - visionStart
      };
    }
  }
  return bestTextLayer;
};

const inferPeriod = (transactions) => {
  if (!transactions.length) return '';
  const dates = transactions.map((transaction) => transaction.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return '';
  if (first.slice(0, 7) === last.slice(0, 7)) return first.slice(0, 7);
  return `${first} to ${last}`;
};

const inferFilenamePeriod = (filename = '') => {
  const matches = Array.from(String(filename).matchAll(/(20\d{2}-\d{2}-\d{2})/g)).map((match) => match[1]);
  if (matches.length < 2) return '';
  return `${matches[0]} to ${matches[matches.length - 1]}`;
};

const coverageWarning = (filenamePeriod = '', transactionPeriod = '') => {
  if (!filenamePeriod || !transactionPeriod || !transactionPeriod.includes(' to ')) return '';
  const [, filenameEnd] = filenamePeriod.split(' to ');
  const [, transactionEnd] = transactionPeriod.split(' to ');
  if (!filenameEnd || !transactionEnd || transactionEnd >= filenameEnd) return '';
  return `Extracted rows end on ${transactionEnd}, but the statement filename ends on ${filenameEnd}. Re-run extraction or review the missing pages before relying on transaction totals.`;
};

// Header-line patterns the jurisdiction detector consumes. The detector
// already reads `bank_name` / `account_number` / `iban` off
// statement_summary defensively (see parseDocument.js's detectorInput);
// before Phase 2.3 we surfaced none of them, so only the filename →
// bank-name fallback and the statement currency could ever fire. Cheap
// header-regex extraction over the first chunk of text lights up the
// dormant IBAN + tax-id signals without touching the detector.
const STATEMENT_HEADER_LINE_LIMIT = 30;

// "DBS Bank Ltd" / "Lloyds Bank plc" / "JPMorgan Chase Bank, N.A." — the
// first short header line that mentions "bank" or "banco" or "building
// society" and isn't a transaction-table column header (date / balance /
// debit / description / amount). Capped length is a coarse anti-noise
// guard for column-header lines that happen to include "bank" elsewhere.
const BANK_HEADER_LINE = /\b(?:bank|banco|building society)\b/i;
const BANK_HEADER_NOISE = /\b(?:date|description|balance|debit|credit|withdrawal|deposit|amount|transaction|statement of|page|opening|closing)\b/i;
const BANK_HEADER_MAX_CHARS = 80;

const parseStatementBankName = (text = '') => {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, STATEMENT_HEADER_LINE_LIMIT);
  for (const line of lines) {
    if (line.length > BANK_HEADER_MAX_CHARS) continue;
    if (BANK_HEADER_NOISE.test(line)) continue;
    if (BANK_HEADER_LINE.test(line)) return line;
  }
  return null;
};

// Account number / IBAN lookups read just the first chunk of text — bank
// statements put both in the customer-address block at the top, never
// inside the transaction table. Restricting the scan also avoids the
// "10-digit transaction reference looks like an account number" case.
// Both header patterns intentionally restrict internal whitespace to
// SPACE and TAB (not \s), so a regex starting on the "Account Number" /
// "IBAN" line can't bleed into the next line — banks sometimes follow
// the IBAN with a "VAT Reg. No." banner whose alphanumerics would
// otherwise extend the capture.
const ACCOUNT_NUMBER_HEADER = /(?:account|a\/c)[ \t]*(?:no\.?|number|#)?[ \t]*[:.\-]?[ \t]*([0-9](?:[0-9 \t\-]{6,24}[0-9]))/i;
const IBAN_HEADER = /\biban[ \t]*[:.\-]?[ \t]*([A-Z]{2}\d{2}(?:[ \t\-]?[A-Z0-9]){11,28})/i;

const parseStatementAccountNumber = (headerText = '') => {
  const match = String(headerText).match(ACCOUNT_NUMBER_HEADER);
  if (!match) return null;
  // Strip separators; preserve the canonical digits-only form. IBAN-shaped
  // values are captured by IBAN_HEADER separately and stored on their own
  // key, so we don't confuse that case here.
  const digits = match[1].replace(/[\s\-]+/g, '');
  return /^\d{6,}$/.test(digits) ? digits : null;
};

const parseStatementIban = (headerText = '') => {
  const match = String(headerText).match(IBAN_HEADER);
  if (!match) return null;
  const normalised = match[1].replace(/[\s\-]+/g, '').toUpperCase();
  // IBANs are 15-34 alphanumerics after the 2-letter country code +
  // 2-digit check; the broader regex above is permissive on length to
  // tolerate spacing variants — we tighten here so the detector sees a
  // clean prefix-able string.
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalised)) return null;
  return normalised;
};

// First chunk of text used for header extraction (bank name, account
// number, IBAN). Bank statements consistently put the customer-address
// block, account header, and any tax-id banners in the first page or
// two; later pages are transaction tables and footers we don't want to
// scan. Returns a stable substring so downstream consumers (the
// jurisdiction detector's text snippet) get a deterministic window.
const STATEMENT_HEADER_TEXT_LIMIT = 2000;
const statementHeaderText = (text = '') => {
  const lines = String(text).split(/\r?\n/).filter(Boolean).slice(0, STATEMENT_HEADER_LINE_LIMIT);
  return lines.join('\n').slice(0, STATEMENT_HEADER_TEXT_LIMIT);
};

const parseStatementSummary = (text = '') => {
  const cleanText = sanitizeStatementText(text);
  const parseSummaryAmount = (pattern) => {
    const match = cleanText.match(pattern);
    return match ? parseAmount(match[1]) : null;
  };

  const deposits = parseSummaryAmount(
    /total\s+(?:deposits|credits|money\s+in|inflows|additions)(?:\s+and\s+other\s+additions)?\s*(?:AED|EUR|GBP|SGD|USD)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)/i
  );
  const payouts = parseSummaryAmount(
    /total\s+(?:payouts|debits|money\s+out|outflows|withdrawals|subtractions)(?:\s+and\s+other\s+subtractions)?\s*(?:AED|EUR|GBP|SGD|USD)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)/i
  );
  const startingBalance = parseSummaryAmount(
    /(?:starting|opening)\s+balance(?:\s+on\s+[A-Za-z]{3,9}\s+\d{1,2}\s+\d{4})?\s*(?:AED|EUR|GBP|SGD|USD)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)/i
  );
  const endingBalance = parseSummaryAmount(
    /(?:ending|closing)\s+balance(?:\s+on\s+[A-Za-z]{3,9}\s+\d{1,2}\s+\d{4})?\s*(?:AED|EUR|GBP|SGD|USD)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)/i
  );

  const period = parseStatementPeriod(cleanText);
  const headerText = statementHeaderText(cleanText);
  const bankName = parseStatementBankName(cleanText);
  const accountNumber = parseStatementAccountNumber(headerText);
  const iban = parseStatementIban(headerText);

  const summary = {
    deposits,
    payouts,
    starting_balance: startingBalance,
    ending_balance: endingBalance,
    period_start: period?.start || null,
    period_end: period?.end || null,
    bank_name: bankName,
    account_number: accountNumber,
    iban
  };
  return Object.values(summary).some((value) => value != null) ? summary : null;
};

// Structured-vision extractions have no text layer for the regex summary
// parser; their header arrives on `statement_summary_hint` with the
// vision schema's key names (account_identifier, opening/closing_balance).
// Normalize into the text-path shape so the account fingerprint, the
// jurisdiction detector, and the ask-pipeline's statement-coverage gather
// see one canonical `statement_summary` regardless of extraction path —
// before this, every vision-parsed statement shipped a null summary.
// Exported for tests only.
export const __visionSummaryFromHint = (hint) => {
  if (!hint || typeof hint !== 'object') return null;
  const summary = {
    // Printed movement totals ("Panot/Otot yhteensä", "total deposits")
    // when the model extracted them — these arm the movement-mismatch
    // cross-check for statements the English-only regex summary parser
    // cannot read.
    deposits: hint.total_deposits ?? hint.deposits ?? null,
    payouts: hint.total_payouts ?? hint.payouts ?? null,
    starting_balance: hint.starting_balance ?? hint.opening_balance ?? null,
    ending_balance: hint.ending_balance ?? hint.closing_balance ?? null,
    period_start: hint.period_start ?? null,
    period_end: hint.period_end ?? null,
    bank_name: hint.bank_name || hint.bank || null,
    account_number: hint.account_number || hint.account_identifier || null,
    iban: hint.iban || null
  };
  return Object.values(summary).some((value) => value != null) ? summary : null;
};

const transactionMovementTotals = (transactions = []) =>
  transactions.reduce(
    (totals, transaction) => {
      totals.deposits += Number(transaction.money_in || 0);
      totals.payouts += Number(transaction.money_out || 0);
      return totals;
    },
    { deposits: 0, payouts: 0 }
  );

const withStatementCurrency = (transactions = [], currency = '', ledgerCurrency = '', resolution = null) =>
  transactions.map((transaction) => ({
    ...transaction,
    account_currency: currency,
    currency,
    ledger_currency: ledgerCurrency,
    currency_resolution: { ...resolution, row_candidate: transaction.currency ?? transaction.account_currency ?? null },
    ledger_conversion_status: currency && ledgerCurrency
      ? (currency !== ledgerCurrency ? 'needs_fx_rate' : 'native') : ''
  }));

const movementMismatchWarning = (summary, transactions = []) => {
  if (!summary || summary.deposits == null || summary.payouts == null || transactions.length === 0) return '';
  const totals = transactionMovementTotals(transactions);
  const tolerance = 1;
  const depositsOff = Math.abs(totals.deposits - summary.deposits) > tolerance;
  const payoutsOff = Math.abs(totals.payouts - summary.payouts) > tolerance;
  if (!depositsOff && !payoutsOff) return '';
  return `Parsed movement does not match statement summary: deposits ${totals.deposits.toFixed(2)} vs ${summary.deposits.toFixed(2)}, payouts ${totals.payouts.toFixed(2)} vs ${summary.payouts.toFixed(2)}.`;
};

const summaryBalanceWarning = (summary) => {
  if (
    !summary ||
    summary.starting_balance == null ||
    summary.ending_balance == null ||
    summary.deposits == null ||
    summary.payouts == null
  ) {
    return '';
  }

  const expectedEnding =
    Number(summary.starting_balance || 0) +
    Number(summary.deposits || 0) -
    Number(summary.payouts || 0);
  if (Math.abs(expectedEnding - Number(summary.ending_balance || 0)) <= 0.01) return '';
  return `Statement summary does not reconcile: starting balance plus deposits less payouts is ${expectedEnding.toFixed(2)}, but ending balance is ${Number(summary.ending_balance || 0).toFixed(2)}.`;
};

// The one arithmetic check that needs no printed totals and no English
// keywords: opening balance + Σ(money in) − Σ(money out) must equal the
// closing balance. Works on any statement in any language once the model
// has extracted the two balances — which is precisely the case the
// English-only regex summary parser could never validate.
const balanceEquationWarning = (summary, transactions = []) => {
  if (
    !summary ||
    summary.starting_balance == null ||
    summary.ending_balance == null ||
    transactions.length === 0
  ) {
    return '';
  }
  const totals = transactionMovementTotals(transactions);
  const expectedEnding = Number(summary.starting_balance) + totals.deposits - totals.payouts;
  if (Math.abs(expectedEnding - Number(summary.ending_balance)) <= 0.02) return '';
  return `Parsed transactions do not reconcile with statement balances: opening ${Number(summary.starting_balance).toFixed(2)} plus money in ${totals.deposits.toFixed(2)} less money out ${totals.payouts.toFixed(2)} is ${expectedEnding.toFixed(2)}, but closing balance is ${Number(summary.ending_balance).toFixed(2)}.`;
};

const runningBalanceWarning = (summary, transactions = []) => {
  if (summary?.starting_balance == null || !transactions.length) return '';
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index];
    const previousBalance = index === 0
      ? summary?.starting_balance
      : transactions[index - 1]?.balance;
    if (previousBalance == null || transaction?.balance == null) continue;
    const movement = Math.abs(Number(transaction.money_in || 0) || Number(transaction.money_out || 0));
    const delta = Math.abs(Number(transaction.balance) - Number(previousBalance));
    if (!movement || !Number.isFinite(delta) || !amountsNearlyEqual(delta, movement)) {
      return `Running balance does not prove transaction row ${index + 1}: printed movement ${movement.toFixed(2)} versus adjacent balance delta ${Number.isFinite(delta) ? delta.toFixed(2) : 'unknown'}.`;
    }
  }
  return '';
};

const statementPeriodWarning = (summary, transactions = []) => {
  if (!summary?.period_start || !summary?.period_end || !transactions.length) return '';
  const outside = transactions.find((transaction) =>
    !transaction?.date ||
    transaction.date < summary.period_start ||
    transaction.date > summary.period_end
  );
  if (!outside) return '';
  return `Transaction date ${outside.date || 'unknown'} falls outside the printed statement period ${summary.period_start} to ${summary.period_end}.`;
};

// Keep-layer acceptance for MODEL-extracted statements (vision + text).
// Replaces the earlier blanket "trust the model → skip validation"
// carve-out for structured vision, which misread the doctrine: trust is
// for judgment, not arithmetic — the model extracts (including the
// summary, in any language), deterministic arithmetic decides whether
// the rows commit. The regex-targeted checks that systematically
// withheld vision output (filename-period coverage) stay excluded; the
// checks here fire only on data the model actually extracted, so a
// statement with no printed balances still flows.
const validateLlmStructuredTransactions = ({ statementSummary, transactions }) => {
  // Only the balance equation — opening + Σ(rows) = closing — tests the
  // ROWS, so only it may withhold them. The other two checks compare the
  // statement's PRINTED totals against themselves or against the rows: a
  // mismatch there is evidence about the printed summary, not the rows
  // (the 2026-08-25 Honeybee receipt: rows footed to the cent against the
  // opening/closing balances while the statement's own printed payouts
  // total was 29.80 off against its own balances — a veto there withholds
  // proven-good rows over a decorative total). Those ride the receipt as
  // warnings instead.
  const equationWarning = balanceEquationWarning(statementSummary, transactions);
  const hardWarnings = [
    equationWarning,
    runningBalanceWarning(statementSummary, transactions),
    statementPeriodWarning(statementSummary, transactions)
  ].filter(Boolean);
  const softWarnings = [
    summaryBalanceWarning(statementSummary),
    movementMismatchWarning(statementSummary, transactions)
  ].filter(Boolean);
  return {
    hardWarnings,
    softWarnings,
    shouldWithholdTransactions: hardWarnings.length > 0 && transactions.length > 0
  };
};

const validateExtractedTransactions = ({
  statementSummary,
  transactions,
  filenamePeriod,
  transactionPeriod
}) => {
  const balanceWarning = summaryBalanceWarning(statementSummary);
  const mismatchWarning = movementMismatchWarning(statementSummary, transactions);
  const equationWarning = balanceEquationWarning(statementSummary, transactions);
  const rollWarning = runningBalanceWarning(statementSummary, transactions);
  const periodWarning = statementPeriodWarning(statementSummary, transactions);
  const coverageGapWarning = coverageWarning(filenamePeriod, transactionPeriod);
  const hasCompleteSummary =
    statementSummary?.starting_balance != null &&
    statementSummary?.ending_balance != null &&
    statementSummary?.deposits != null &&
    statementSummary?.payouts != null;
  const hardWarnings = [
    balanceWarning,
    mismatchWarning,
    equationWarning,
    rollWarning,
    periodWarning,
    coverageGapWarning && (!hasCompleteSummary || balanceWarning || mismatchWarning)
      ? coverageGapWarning
      : ''
  ].filter(Boolean);

  return {
    hardWarnings,
    shouldWithholdTransactions: hardWarnings.length > 0 && transactions.length > 0
  };
};

const redactCandidateTransaction = (transaction = {}, ledgerCurrency = '') => ({
  date: transaction.date || '',
  description: transaction.description || '',
  counterparty: transaction.counterparty ?? null,
  payment_method: transaction.payment_method ?? null,
  money_in: Number(transaction.money_in || 0),
  money_out: Number(transaction.money_out || 0),
  balance: transaction.balance ?? null,
  account_currency: transaction.account_currency || '',
  ledger_currency: transaction.ledger_currency || ledgerCurrency,
  ledger_conversion_status: transaction.ledger_conversion_status || '',
  currency_resolution: transaction.currency_resolution || null,
  currency: transaction.currency || '',
  confidence: transaction.confidence || 'low',
  parser_flags: transaction.parser_flags || [],
  source_line: transaction.source_line || ''
});

const pdfByteSize = (base64 = '') => {
  const clean = String(base64 || '').replace(/[\r\n\s]/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
};

// Machine-delimited uploads (CSV/TSV) keep the deterministic column
// parser even under the LLM-first flag: reading a machine format is
// mechanics, not judgment, and the delimited pins depend on it.
const isDelimitedUpload = (filename = '', mimeType = '') =>
  String(mimeType).includes('csv') ||
  String(mimeType).includes('tab-separated') ||
  /\.(csv|tsv)$/i.test(String(filename));

export const extractBankStatementFromBase64 = async ({ base64, filename = '', mimeType = '', ledgerCurrency = '', llmFirst = false, preferVision = false, bypassCache = false }) => {
  const startedAt = Date.now();
  // The client's explicit BOOK currency, independent of printed evidence.
  const normalizedLedger = String(ledgerCurrency || '').trim().toUpperCase();
  const bookCurrency = currencyCodes.has(normalizedLedger) ? normalizedLedger : '';
  const isPdf = mimeType.includes('pdf') || /\.pdf$/i.test(filename);
  const extraction = isPdf && preferVision
    ? await (async () => {
        const structured = await extractStructuredFromOpenAiVisionPaginated({
          base64, filename, mimeType, periodHint: inferFilenamePeriod(filename), bypassCache
        });
        return { text: '', source: 'openai_vision_structured',
          lineCount: structured.transactions.length, transactions: structured.transactions,
          statement_summary_hint: structured.statement_summary, extraction_model: structured.model,
          vision_cache_hit: structured.cache_hit };
      })()
    : isPdf
    ? await selectPdfExtraction(base64, filename, { llmFirst, bypassCache })
    : await (async () => {
        const text = Buffer.from(String(base64 || ''), 'base64').toString('utf8');
        if (llmFirst && !isDelimitedUpload(filename, mimeType)) {
          const llmExtraction = await tryLlmTextExtraction(text, filename, { bypassCache });
          if (llmExtraction) return llmExtraction;
        }
        return { text, lineCount: countLines(text), transactions: parseTextTransactions(text, filename) };
      })();
  const { text, transactions } = extraction;
  const lineCount = extraction.lineCount;
  const textLines = text.split(/\r?\n/).filter(Boolean);
  const printedPeriod = parseStatementPeriod(text);
  const dateLikeLineCount = textLines.filter((line) => extractDate(line, filename, printedPeriod)).length;
  const amountLikeLineCount = textLines.filter((line) => extractAmountMatches(line).length > 0).length;
  const parsedSummary = parseStatementSummary(text) || __visionSummaryFromHint(extraction.statement_summary_hint);
  const statementSummary = deriveBalanceChainSummary(text, transactions, parsedSummary);
  const delimitedCandidates = delimitedCurrencies(text);
  // A structured model header is evidence about the account, not a vote
  // against arbitrary currency mentions in transaction descriptions.
  const hintCurrencyRaw = String(extraction.statement_summary_hint?.currency || '').trim().toUpperCase();
  const hintCurrency = currencyCodes.has(hintCurrencyRaw) ? hintCurrencyRaw : '';
  const headerCandidates = headerCurrencies(text);
  const explicitCandidates = [...new Set([...headerCandidates, ...delimitedCandidates])];
  const printedCandidates = explicitCandidates.length ? explicitCandidates : hintCurrency ? [] : printedCurrencies(text);
  const candidates = [...new Set([...printedCandidates, ...(hintCurrency ? [hintCurrency] : [])])];
  const statementCurrency = candidates.length === 1 ? candidates[0] : '';
  const currencyResolution = {
    version: 1,
    currency: statementCurrency || null,
    ledger_currency: bookCurrency || null,
    source: statementCurrency ? (printedCandidates.length ? 'printed_document' : 'model_document_evidence') : candidates.length ? 'conflicting_document_evidence' : 'unresolved',
    candidates,
    printed_mentions: [...new Set(currencyCodesIn(text))],
    filename_candidates: currencyCodesIn(filename.replace(/[_-]/g, ' ')),
    model_candidate: hintCurrency || null
  };

  const isStructuredLlm =
    extraction.source === 'openai_vision_structured' ||
    extraction.source === 'openai_text_structured';
  const correctedTransactions = isStructuredLlm
    ? repairStructuredDirectionsFromBalances(transactions, statementSummary)
    : transactions;
  const transactionPeriod = inferPeriod(correctedTransactions);
  const filenamePeriod = inferFilenamePeriod(filename);
  const summaryPeriod = statementSummary?.period_start && statementSummary?.period_end
    ? `${statementSummary.period_start} to ${statementSummary.period_end}`
    : '';
  const periodLabel = filenamePeriod || summaryPeriod || transactionPeriod;
  const warnings = [];
  const validation = isStructuredLlm
    ? validateLlmStructuredTransactions({ statementSummary, transactions: correctedTransactions })
    : validateExtractedTransactions({
        statementSummary,
        transactions: correctedTransactions,
        filenamePeriod,
        transactionPeriod
      });
  warnings.push(...validation.hardWarnings, ...(validation.softWarnings || []));
  if (extraction.vision_skipped === 'pdf_too_large') {
    const details = extraction.vision_skipped_details || {};
    const sizeMb = details.byteSize ? (details.byteSize / 1024 / 1024).toFixed(1) : '?';
    const limitMb = details.maxBytes ? (details.maxBytes / 1024 / 1024).toFixed(0) : '?';
    warnings.push(
      `PDF is ${sizeMb} MB, which exceeds the ${limitMb} MB cloud OCR limit. Re-upload as a smaller file (e.g. split by month) or paste the statement text directly.`
    );
  } else if (extraction.vision_skipped === 'timeout') {
    // The structured vision call hit its per-chunk AbortController and
    // surfaced an AbortError. Without this branch the caller would fall
    // through to the generic "no readable text layer" message below,
    // which is misleading: the PDF was perfectly readable, the cloud
    // OCR just couldn't finish in time.
    warnings.push(
      'Cloud OCR could not finish reading this statement within the time budget. Try re-uploading it split into shorter periods (e.g. one year per file), or paste the statement text directly.'
    );
  }
  const annotatedTransactions = withStatementCurrency(correctedTransactions, statementCurrency, bookCurrency, currencyResolution);
  const currencyConflict = currencyResolution.source === 'conflicting_document_evidence';
  if (!statementCurrency) warnings.push(currencyConflict ? 'currency_conflicting_document_evidence' : 'currency_unresolved');
  if (!bookCurrency) warnings.push('ledger_currency_unresolved');
  const withholdTransactions = validation.shouldWithholdTransactions
    || (currencyConflict && delimitedCandidates.length === 0 && !isStructuredLlm);
  const safeTransactions = withholdTransactions ? [] : annotatedTransactions;
  // Suppress the generic "no readable text" / "no transactions detected"
  // warnings when we already surfaced a more specific guardrail reason
  // (pdf_too_large, timeout). Showing both is confusing — the user sees
  // contradictory hints. Keep just the targeted message.
  if (safeTransactions.length === 0 && !extraction.vision_skipped) {
    warnings.push(
      lineCount === 0
        ? 'No readable text layer was detected in the uploaded statement.'
        : currencyConflict
          ? `Donna retained ${correctedTransactions.length} candidate transaction rows, but their account currency is ambiguous in the source.`
          : validation.shouldWithholdTransactions
          ? `Donna found ${correctedTransactions.length} candidate transaction rows, but withheld them because the extraction failed statement-total validation.`
          : `No transaction rows were detected in ${lineCount} extracted text lines (${dateLikeLineCount} date-like lines, ${amountLikeLineCount} amount-like lines).`
    );
  }

  const extractionStatus = safeTransactions.length > 0
    ? 'validated'
    : correctedTransactions.length > 0
      ? 'needs_review'
      : 'failed';

  return {
    filename,
    text_length: text.length,
    line_count: lineCount,
    extraction_source: extraction.source,
    // The model id is part of the receipt — null on regex-only paths.
    extraction_model: extraction.extraction_model ?? null,
    date_line_count: dateLikeLineCount,
    amount_line_count: amountLikeLineCount,
    statement_summary: statementSummary,
    // Bounded head-of-statement slice consumed by the jurisdiction
    // detector's text-pool scan (tax-id regex). The full text is far
    // too large to ship downstream; the customer-address block + any
    // tax-id banners live in the first few pages, which fits inside
    // STATEMENT_HEADER_TEXT_LIMIT.
    text_snippet: statementHeaderText(text),
    statement_currency: statementCurrency,
    ledger_currency: bookCurrency,
    currency_resolution: currencyResolution,
    period_label: periodLabel,
    transactions: safeTransactions,
    candidate_transaction_count: correctedTransactions.length,
    candidate_transactions: withholdTransactions
      ? annotatedTransactions.slice(0, 80).map((tx) => redactCandidateTransaction(tx, bookCurrency))
      : [],
    extraction_status: extractionStatus,
    warnings,
    extraction_diagnostics: {
      total_ms: Date.now() - startedAt,
      pdf_byte_size: isPdf ? pdfByteSize(base64) : 0,
      vision_elapsed_ms: extraction.vision_elapsed_ms ?? null,
      vision_cache_hit: extraction.vision_cache_hit ?? null,
      vision_skipped: extraction.vision_skipped ?? null,
      llm_elapsed_ms: extraction.llm_elapsed_ms ?? null,
      llm_cache_hit: extraction.llm_cache_hit ?? null
    }
  };
};
