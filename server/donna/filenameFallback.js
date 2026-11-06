const SCANNER_NOISE = new Set([
  'scan', 'img', 'doc', 'copy', 'final', 'draft', 'page', 'file',
  'document', 'invoice', 'receipt', 'bill', 'statement', 'attachment',
  'download', 'export', 'print', 'temp', 'tmp', 'new', 'old'
]);

const MIN_VENDOR_TOKEN_LENGTH = 4;
const CURRENT_YEAR = new Date().getFullYear();

const parseDate = (raw) => {
  if (!raw) return null;
  const fourDigit = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (fourDigit) {
    const [, y, m, d] = fourDigit;
    const year = Number(y);
    if (year < 2000 || year > CURRENT_YEAR + 1) return null;
    const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getTime() > Date.now() + 86400000 * 365) return null;
    return `${y}-${m}-${d}`;
  }
  const twoDigit = raw.match(/^(\d{2})-(\d{2})-(\d{2})/);
  if (twoDigit) {
    const [, yy, m, d] = twoDigit;
    const year = 2000 + Number(yy);
    if (year < 2020 || year > CURRENT_YEAR + 1) return null;
    const pad = String(year);
    const date = new Date(`${pad}-${m}-${d}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getTime() > Date.now() + 86400000 * 365) return null;
    return `${pad}-${m}-${d}`;
  }
  return null;
};

const parseAmount = (raw) => {
  if (!raw) return null;
  const match = raw.match(/(\d+\.\d{2})$/);
  if (match) {
    const num = Number(match[1]);
    if (!Number.isFinite(num) || num <= 0 || num > 10_000_000) return null;
    return num;
  }
  return null;
};

const parseVendor = (raw) => {
  if (!raw) return null;
  const cleaned = raw.replace(/_/g, ' ').trim();
  if (cleaned.length < MIN_VENDOR_TOKEN_LENGTH) return null;

  const tokens = cleaned.toLowerCase().split(/\s+/);
  const meaningful = tokens.filter((t) => !SCANNER_NOISE.has(t) && t.length >= 2);
  if (!meaningful.length) return null;

  const titleCase = cleaned
    .split(/\s+/)
    .filter((t) => !SCANNER_NOISE.has(t.toLowerCase()) || cleaned.split(/\s+/).length === 1)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim();

  if (titleCase.length < MIN_VENDOR_TOKEN_LENGTH) return null;
  return titleCase;
};

export const extractFieldsFromFilename = (filename) => {
  const result = { vendor_name: null, document_date: null, total_amount: null };
  if (!filename || typeof filename !== 'string') return result;

  const base = filename.replace(/\.[^.]+$/, '');

  let remaining = base;
  let hasDatePrefix = false;
  // Donna's filename convention sometimes carries a numeric sequence
  // ID before the date (e.g. `05_2026-04-05_Dominos_receipt.pdf` —
  // the `05_` is a per-upload ordering prefix the conversational
  // intake assigns). Strip a short numeric prefix (1-3 digits + a
  // separator) before looking for the date so the date-aware path
  // still fires on those filenames.
  const seqMatch = remaining.match(/^(\d{1,3})[_\s-]+(?=\d{2,4}-\d{2}-\d{2})/);
  if (seqMatch) {
    remaining = remaining.slice(seqMatch[0].length);
  }
  const dateMatch = remaining.match(/^(\d{2,4}-\d{2}-\d{2})/);
  if (dateMatch) {
    result.document_date = parseDate(dateMatch[1]);
    // A prefix that LOOKS like a date but does not parse means this layer has
    // misread the filename's shape — e.g. a UK/EU day-first filename
    // `05-04-2026_Tesco_12.99.pdf`, where the regex grabs `05-04-20`, the
    // parser rejects it, and the "remaining" tokens are mangled remnants
    // (`26_Tesco`), not a vendor (audit 2026-07-30 L9: garbage vendor
    // candidates fed to the matchers). Refuse EVERYTHING rather than emit
    // them. Deliberately NOT taught to parse day-first dates instead: this
    // whole layer is intelligence-substituting scaffolding on the retirement
    // path (trust-the-strong-LLM, CLAUDE.md) — it withdraws where it is not
    // confident; it does not grow a third jurisdiction's date grammar.
    if (!result.document_date) {
      return { vendor_name: null, document_date: null, total_amount: null };
    }
    remaining = remaining.slice(dateMatch[0].length).replace(/^[_\s-]+/, '');
    hasDatePrefix = true;
  }

  const amountMatch = remaining.match(/[_\s-](\d+\.\d{2})$/);
  if (amountMatch) {
    result.total_amount = parseAmount(amountMatch[1]);
    remaining = remaining.slice(0, remaining.length - amountMatch[0].length);
  }

  if (hasDatePrefix) {
    result.vendor_name = parseVendor(remaining);
  }

  return result;
};

// Returns true when two YYYY-MM-DD strings are the SAME date with
// month and day transposed (e.g. 2026-05-04 and 2026-04-05). False
// when either side isn't a valid ISO date, when years differ, when
// the day-month pair is identical (e.g. 2026-05-05), or when the
// swap would produce an invalid date. Calendar-aware: 2026-02-30
// swapped from 2026-30-02 is not detected because 30 isn't a valid
// month — both directions must pass the parser.
export const isDayMonthSwap = (a, b) => {
  if (!a || !b) return false;
  const matchA = String(a).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const matchB = String(b).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matchA || !matchB) return false;
  if (matchA[1] !== matchB[1]) return false;
  const [, , monthA, dayA] = matchA;
  const [, , monthB, dayB] = matchB;
  if (monthA === dayA) return false; // identical positions — no swap to detect
  if (monthA !== dayB || dayA !== monthB) return false;
  // Both date forms must be valid calendar dates — otherwise a swap
  // could "succeed" against e.g. 2026-30-02 which is never a real
  // date. Use UTC Date and check round-trip to catch invalid
  // months/days the parser would silently coerce.
  const valid = (year, month, day) => {
    const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return (
      d.getUTCFullYear() === Number(year) &&
      d.getUTCMonth() === Number(month) - 1 &&
      d.getUTCDate() === Number(day)
    );
  };
  return valid(matchA[1], monthA, dayA) && valid(matchB[1], monthB, dayB);
};

// Returns true when two YYYY-MM-DD strings share the SAME month and day
// but their years differ by ≥10. Symptomatic of the LLM reading a
// "MM/DD/YY" receipt and resolving the two-digit year to the wrong
// decade/century while the filename's YY prefix unambiguously names the
// year (e.g. Chevron receipt printed "08/19/13" extracted as 2013-08-19
// vs filename `25-08-19_Chevron_26.83.pdf` naming 2025-08-19). Symmetric
// in form; the "filename wins" semantic is encoded at the call site.
//
// The 10-year threshold avoids overriding small honest disagreements
// where the LLM could plausibly be reading a different date field (e.g.
// an issue date vs a due date one year apart). Both inputs must parse
// as valid calendar dates.
export const isYearMisreadSwap = (a, b) => {
  if (!a || !b) return false;
  const matchA = String(a).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const matchB = String(b).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matchA || !matchB) return false;
  const [, yearA, monthA, dayA] = matchA;
  const [, yearB, monthB, dayB] = matchB;
  if (monthA !== monthB || dayA !== dayB) return false;
  if (Math.abs(Number(yearA) - Number(yearB)) < 10) return false;
  const valid = (year, month, day) => {
    const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return (
      d.getUTCFullYear() === Number(year) &&
      d.getUTCMonth() === Number(month) - 1 &&
      d.getUTCDate() === Number(day)
    );
  };
  return valid(yearA, monthA, dayA) && valid(yearB, monthB, dayB);
};

const CONFIDENCE_BANDS = Object.freeze({
  llm_high: 0.9,
  llm_medium: 0.7,
  filename: 0.6,
  llm_repair: 0.65
});

const llmConfidence = (extractionConfidence) => {
  const score = Number(extractionConfidence);
  if (!Number.isFinite(score)) return CONFIDENCE_BANDS.llm_medium;
  return score >= 0.8 ? CONFIDENCE_BANDS.llm_high : CONFIDENCE_BANDS.llm_medium;
};

const buildCandidates = (llmValue, filenameValue, extractionConfidence, field) => {
  const candidates = [];
  if (llmValue != null && llmValue !== '') {
    candidates.push({
      value: llmValue,
      source: 'llm_extraction',
      confidence: llmConfidence(extractionConfidence)
    });
  }
  if (filenameValue != null && filenameValue !== '') {
    const isDuplicate = candidates.some((c) =>
      String(c.value).toLowerCase().trim() === String(filenameValue).toLowerCase().trim()
    );
    if (!isDuplicate) {
      candidates.push({
        value: filenameValue,
        source: 'filename',
        confidence: CONFIDENCE_BANDS.filename
      });
    }
  }
  return candidates;
};

// AR document types — the firm IS the vendor, so the filename-derived
// party is the customer (e.g. the tenant on a rent receipt), not the
// vendor. Used to route the filename-derived counterparty into the
// right column. Driven off `summary.document_type` which the AR
// extractor (`salesInvoice.js:mapExtractionToWriterShape`) populates.
const AR_DOCUMENT_TYPES = new Set(['sales_invoice', 'issued_receipt']);

export const applyPostExtractionEnrichment = ({ header, summary, filename }) => {
  if (!header || !summary) return { filled: [] };

  const filenameFields = extractFieldsFromFilename(filename);
  const filled = [];
  const isAr = AR_DOCUMENT_TYPES.has(summary?.document_type);

  // For AR docs the structurally-correct vendor_name is null (the firm
  // is the vendor); the filename party can only be a customer candidate. Build the
  // provenance array under the matching key without filling a missing buyer.
  const counterpartyCandidates = isAr
    ? buildCandidates(
        header.customer_name, filenameFields.vendor_name,
        header.extraction_confidence, 'customer_name'
      )
    : buildCandidates(
        header.vendor_name, filenameFields.vendor_name,
        header.extraction_confidence, 'vendor_name'
      );
  const dateCandidates = buildCandidates(
    header.document_date, filenameFields.document_date,
    header.extraction_confidence, 'document_date'
  );
  const amountCandidates = buildCandidates(
    header.total_amount, filenameFields.total_amount,
    header.extraction_confidence, 'total_amount'
  );

  // A filename is provenance, not evidence of the buyer's identity. Preserve
  // an omitted AR party as null; the candidate remains visible below without
  // becoming an authoritative customer field in the writer or matcher.
  if (!isAr && !header.vendor_name && filenameFields.vendor_name) {
    header.vendor_name = filenameFields.vendor_name;
    filled.push('vendor_name');
    if (!Array.isArray(summary.warnings)) summary.warnings = [];
    summary.warnings.push('vendor_from_filename');
  }
  if (!header.document_date && filenameFields.document_date) {
    header.document_date = filenameFields.document_date;
    filled.push('document_date');
    if (!Array.isArray(summary.warnings)) summary.warnings = [];
    summary.warnings.push('date_from_filename');
  } else if (
    header.document_date &&
    filenameFields.document_date &&
    header.document_date !== filenameFields.document_date
  ) {
    // LLM and filename disagree. The most common cause we've seen in
    // production is a locale-ambiguous date on the receipt (e.g.
    // "04/05/2026" — UK reads 5 April, US reads 4 May) where the LLM
    // guessed the wrong format. The user-typed filename date is a
    // stronger signal than the LLM's interpretation, so when the two
    // dates are exactly an MM↔DD swap we correct the header and tag
    // the audit trail.
    //
    // Documented case: Domino's receipt
    // `05_2026-04-05_Dominos_receipt.pdf` extracted with
    // document_date='2026-05-04'. The filename's `2026-04-05` matches
    // the LLM date with month and day swapped — a textbook
    // locale-format ambiguity.
    //
    // For non-swap disagreements (different days, not just a
    // transposition) we DON'T overwrite — the LLM might be reading a
    // different date field than the filename was named after (e.g.
    // a multi-page statement filename with an extraction-date prefix).
    // We still attach a `date_filename_mismatch` warning so the
    // reviewer can decide.
    if (isDayMonthSwap(header.document_date, filenameFields.document_date)) {
      const original = header.document_date;
      header.document_date = filenameFields.document_date;
      filled.push('document_date');
      if (!Array.isArray(summary.warnings)) summary.warnings = [];
      summary.warnings.push('date_corrected_from_filename_swap');
      // Replace the LLM candidate's value in the audit trail with the
      // ORIGINAL llm reading so the reviewer can see what was
      // overridden and why.
      if (Array.isArray(dateCandidates)) {
        const llmCandidate = dateCandidates.find((c) => c.source === 'llm_extraction');
        if (llmCandidate) {
          llmCandidate.value = original;
          llmCandidate.overridden = true;
          llmCandidate.override_reason = 'filename_dd_mm_swap';
        }
      }
    } else if (isYearMisreadSwap(header.document_date, filenameFields.document_date)) {
      // Documented case: Chevron receipt `25-08-19_Chevron_26.83.pdf`
      // printed "08/19/13" on the slip; the LLM resolved the YY to
      // 2013 (extracted document_date='2013-08-19') while the filename
      // unambiguously names 2025. Day and month agree exactly; only
      // the year is off, and by ≥10 — the YY-misread signature, not an
      // honest issue-vs-due-date disagreement.
      const original = header.document_date;
      header.document_date = filenameFields.document_date;
      filled.push('document_date');
      if (!Array.isArray(summary.warnings)) summary.warnings = [];
      summary.warnings.push('date_corrected_from_filename_year_swap');
      if (Array.isArray(dateCandidates)) {
        const llmCandidate = dateCandidates.find((c) => c.source === 'llm_extraction');
        if (llmCandidate) {
          llmCandidate.value = original;
          llmCandidate.overridden = true;
          llmCandidate.override_reason = 'filename_year_swap';
        }
      }
    } else {
      if (!Array.isArray(summary.warnings)) summary.warnings = [];
      summary.warnings.push('date_filename_mismatch');
    }
  }
  if (header.total_amount == null && filenameFields.total_amount != null) {
    header.total_amount = filenameFields.total_amount;
    filled.push('total_amount');
    if (!Array.isArray(summary.warnings)) summary.warnings = [];
    summary.warnings.push('amount_from_filename');
  }

  if (counterpartyCandidates.length) {
    // Mirror AP/AR direction in the audit key so downstream consumers
    // (reconciliationTriage, bill/receipt matchers) don't see a
    // misleading vendor_candidates entry on an AR row. The AR matchers
    // can pick up customer_candidates when they grow that affordance.
    if (isAr) summary.customer_candidates = counterpartyCandidates;
    else summary.vendor_candidates = counterpartyCandidates;
  }
  if (dateCandidates.length) summary.date_candidates = dateCandidates;
  if (amountCandidates.length) summary.amount_candidates = amountCandidates;

  return { filled };
};
