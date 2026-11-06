// Manual-upload source module (P0C of docs/design-donna-prospecting.md).
//
// The manual-upload source is FIRST-CLASS, not a fallback (§5A): Kari (or a
// session) drops in a CSV or plain list of leads found anywhere — a directory
// he browsed, a conference list, a hunch — and the lab investigates them
// exactly like API-sourced candidates. This module is deliberately thin: it
// yields candidate references plus their signal hypotheses and tags; ALL
// intelligence lives in the shared dossier stage.
//
// Pure module (no DB, no network): text in → { candidates, skipped, mode }.
// The route wraps it with a source-run receipt and the mint writer.

export const MANUAL_UPLOAD_SOURCE = 'manual_upload';

// Header cell → canonical field. A first line is a header when at least one
// cell matches; otherwise the whole text is treated as one-company-per-line.
const HEADER_ALIASES = Object.freeze({
  company_name: 'companyName',
  name: 'companyName',
  company: 'companyName',
  company_number: 'companyNumber',
  number: 'companyNumber',
  registration_number: 'companyNumber',
  jurisdiction: 'jurisdiction',
  country: 'jurisdiction',
  website: 'website',
  url: 'website',
  email: 'contactEmail',
  contact: 'contactEmail',
  contact_email: 'contactEmail',
  note: 'sourceNote',
  notes: 'sourceNote',
  signal: 'sourceNote',
  signal_note: 'sourceNote',
  why: 'sourceNote',
  campaigns: 'campaigns',
  campaign: 'campaigns',
  tags: 'campaigns',
  tier: 'tier'
});

const JURISDICTION_SYNONYMS = Object.freeze({
  UK: 'UK',
  GB: 'UK',
  GBR: 'UK',
  'UNITED KINGDOM': 'UK',
  US: 'US',
  USA: 'US',
  'UNITED STATES': 'US',
  SG: 'SG',
  SGP: 'SG',
  SINGAPORE: 'SG',
  AU: 'AUS',
  AUS: 'AUS',
  AUSTRALIA: 'AUS'
});

const TIERS = new Set(['green', 'yellow', 'red']);

const normalizeHeaderCell = (cell) =>
  String(cell || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

// Minimal CSV line splitter with double-quote support ("" escapes a quote).
// One record per line — multi-line quoted fields are out of scope for v1 and
// surface as a skipped row, never a silent misparse.
const splitCsvLine = (line, delimiter) => {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return { cells: cells.map((c) => c.trim()), unterminated: inQuotes };
};

const normalizeJurisdiction = (value, fallback) => {
  const key = String(value || '').trim().toUpperCase();
  if (!key) return fallback;
  return JURISDICTION_SYNONYMS[key] || key;
};

const normalizeCampaigns = (value, defaults) => {
  const parsed = String(value || '')
    .split(/[;|]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const merged = [...defaults, ...parsed];
  return [...new Set(merged)];
};

// Parse an uploaded CSV/list into mintable candidates. Nothing silent: every
// dropped line comes back in `skipped` with its line number and reason, and
// in-upload duplicates are skipped (the writer dedups against the DB).
export const parseManualUploadList = (
  text,
  { defaultJurisdiction = 'UK', defaultTier = 'green', defaultCampaigns = [] } = {}
) => {
  const lines = String(text || '').split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstIndex === -1) {
    return { mode: 'empty', candidates: [], skipped: [] };
  }

  const firstLine = lines[firstIndex];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const headerCells = splitCsvLine(firstLine, delimiter).cells.map(normalizeHeaderCell);
  const isCsv = headerCells.some((cell) => HEADER_ALIASES[cell]);

  const candidates = [];
  const skipped = [];
  const seen = new Set();

  const push = (lineNumber, raw) => {
    if (!String(raw.companyName || '').trim()) {
      skipped.push({ line: lineNumber, reason: 'missing company name' });
      return;
    }
    const tierValue = String(raw.tier || '').trim().toLowerCase();
    if (tierValue && !TIERS.has(tierValue)) {
      skipped.push({ line: lineNumber, reason: `unknown tier "${raw.tier}" (green/yellow/red)` });
      return;
    }
    const email = String(raw.contactEmail || '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped.push({ line: lineNumber, reason: `"${raw.contactEmail}" does not look like an email` });
      return;
    }
    const candidate = {
      companyName: String(raw.companyName).trim(),
      companyNumber: String(raw.companyNumber || '').trim().toUpperCase() || null,
      jurisdiction: normalizeJurisdiction(raw.jurisdiction, defaultJurisdiction),
      website: String(raw.website || '').trim() || null,
      contactEmail: email || null,
      sourceNote: String(raw.sourceNote || '').trim() || null,
      campaigns: normalizeCampaigns(raw.campaigns, defaultCampaigns),
      tier: tierValue || defaultTier
    };
    const dedupKey = candidate.companyNumber
      ? `${candidate.jurisdiction}#${candidate.companyNumber}`
      : `${candidate.jurisdiction}#name:${candidate.companyName.toLowerCase()}`;
    if (seen.has(dedupKey)) {
      skipped.push({ line: lineNumber, reason: `duplicate of an earlier row (${candidate.companyName})` });
      return;
    }
    seen.add(dedupKey);
    candidates.push(candidate);
  };

  if (isCsv) {
    for (let i = firstIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const lineNumber = i + 1;
      const { cells, unterminated } = splitCsvLine(line, delimiter);
      if (unterminated) {
        skipped.push({ line: lineNumber, reason: 'unterminated quote (multi-line fields are not supported)' });
        continue;
      }
      const raw = {};
      headerCells.forEach((header, index) => {
        const field = HEADER_ALIASES[header];
        if (field) raw[field] = cells[index] ?? '';
      });
      push(lineNumber, raw);
    }
    return { mode: 'csv', candidates, skipped };
  }

  // Plain-lines mode: every non-empty line is one company name.
  for (let i = firstIndex; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    push(i + 1, { companyName: line });
  }
  return { mode: 'lines', candidates, skipped };
};
