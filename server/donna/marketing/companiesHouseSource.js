// Companies House source modules (P0B of docs/design-donna-prospecting.md
// §3.1/§3.2): the overdue-accounts scan (public disorder — the government
// publishes the signal on purpose) and the first-filing-approaching scan
// (lifecycle/preventive). Thin by design (§5A): this module yields candidate
// references + their signal hypotheses; ALL intelligence lives in the shared
// dossier stage.
//
// API shape discipline (LEAD LESSON): the endpoint, `sic_codes` /
// `company_status` / `company_type` params, and the canonical
// `accounts.next_accounts.*` block are confirmed against public references
// (paper §3.1 v4, re-checked 2026-07-06); the incorporation-window param
// names could not be re-quoted from the live spec from this container, so
// EVERY response passes a shape assertion and a mismatch surfaces the
// provider's own error body — the scan refuses loudly, it never guesses. Use
// the route's dry_run on the FIRST keyed run to validate the live shapes
// without minting anything.
//
// Legal posture baked in (§4): UK PECR corporate-subscriber safe harbor —
// only limited-company/LLP types pass; anything else is skipped WITH a
// reason. Rate posture: one search page + a capped number of profile reads
// per run keeps a scan around ~50 requests, far under the ~600 req/5min
// class limit.

import { toLocalIsoDay, toUtcIsoDay } from '../dates.js';

const CH_BASE = 'https://api.company-information.service.gov.uk';

export const CH_SOURCE_BY_MODE = Object.freeze({
  overdue: 'companies_house_overdue',
  first_filing: 'companies_house_first_filing'
});

// PECR corporate subscribers we scan (Companies House profile `type` values).
// Conservative allowlist — everything else is reported, not silently dropped.
const PECR_SAFE_TYPES = new Set([
  'ltd',
  'plc',
  'llp',
  'private-limited-guarant-nsc',
  'private-limited-guarant-nsc-limited-exemption',
  'private-limited-shares-section-30-exemption'
]);

// First-filing window (§3.2): companies this age have no incumbent bookkeeper
// and a knowable deadline. Bounds in months relative to scan time.
const FIRST_FILING_MIN_AGE_MONTHS = 8;
const FIRST_FILING_MAX_AGE_MONTHS = 14;

export const chAuthHeader = (apiKey) =>
  `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

const addMonths = (date, months) => {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export const buildAdvancedSearchUrl = ({ mode, sicCodes, size = 50, startIndex = 0, now = new Date() } = {}) => {
  const params = new URLSearchParams();
  params.set('company_status', 'active');
  params.set('sic_codes', sicCodes.join(','));
  params.set('size', String(size));
  params.set('start_index', String(startIndex));
  if (mode === 'first_filing') {
    // UTC on purpose: the window is UTC month arithmetic on `now`, and a day
    // either way only nudges a Companies House search window.
    params.set('incorporated_from', toUtcIsoDay(addMonths(now, -FIRST_FILING_MAX_AGE_MONTHS)));
    params.set('incorporated_to', toUtcIsoDay(addMonths(now, -FIRST_FILING_MIN_AGE_MONTHS)));
  }
  return `${CH_BASE}/advanced-search/companies?${params.toString()}`;
};

export const buildProfileUrl = (companyNumber) =>
  `${CH_BASE}/company/${encodeURIComponent(companyNumber)}`;

// Live-shape assertions — a mismatch is a refusal with the observed shape,
// never a guess off a legacy field.
export const assertSearchShape = (payload) => {
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error(`Companies House search response has no items array (keys: ${Object.keys(payload || {}).join(', ') || 'none'}) — live shape assertion failed.`);
  }
  for (const item of payload.items.slice(0, 1)) {
    if (!item.company_number || !item.company_name) {
      throw new Error('Companies House search items carry no company_number/company_name — live shape assertion failed.');
    }
  }
};

// Evaluate one company profile against the mode's signal. Returns
// { eligible: true, signalNote } or { eligible: false, reason }. Reads ONLY
// the canonical accounts.next_accounts block (paper §3.1 v4 — the top-level
// accounts.overdue/next_due are legacy).
export const evaluateProfile = ({ profile, mode, now = new Date(), dueWithinDays = 120 } = {}) => {
  const name = profile?.company_name || 'unknown';
  if (profile?.company_status !== 'active') {
    return { eligible: false, reason: `${name}: company_status is ${profile?.company_status || 'missing'}, not active` };
  }
  if (!PECR_SAFE_TYPES.has(profile?.type)) {
    return { eligible: false, reason: `${name}: company type "${profile?.type || 'missing'}" is outside the PECR corporate-subscriber allowlist` };
  }
  const next = profile?.accounts?.next_accounts;
  if (!next || typeof next.overdue !== 'boolean') {
    return { eligible: false, reason: `${name}: profile carries no accounts.next_accounts.overdue boolean — live shape assertion failed (never guess off legacy fields)` };
  }

  const checked = toLocalIsoDay(now); // the host-local day the profile was checked on
  if (mode === 'overdue') {
    if (next.overdue !== true) {
      return { eligible: false, reason: `${name}: accounts are not overdue` };
    }
    const period = next.period_start_on || next.period_end_on
      ? ` for period ${next.period_start_on || '?'} to ${next.period_end_on || '?'}`
      : '';
    return {
      eligible: true,
      signalNote: `Accounts overdue at Companies House${period}: due ${next.due_on || 'unknown'}, profile shows accounts.next_accounts.overdue=true as of ${checked}. Late-filing penalties escalate with lateness (verify the current schedule on gov.uk before quoting it).`
    };
  }

  if (mode === 'first_filing') {
    if (next.overdue === true) {
      return { eligible: false, reason: `${name}: already overdue — belongs to the overdue campaign, not preventive` };
    }
    if (!next.due_on) {
      return { eligible: false, reason: `${name}: no accounts.next_accounts.due_on on the profile` };
    }
    const dueOn = new Date(`${next.due_on}T00:00:00Z`);
    if (Number.isNaN(dueOn.getTime()) || dueOn < now || dueOn > addDays(now, dueWithinDays)) {
      return { eligible: false, reason: `${name}: first accounts due ${next.due_on}, outside the next ${dueWithinDays} days` };
    }
    return {
      eligible: true,
      signalNote: `First accounts due ${next.due_on} (incorporated ${profile.date_of_creation || 'unknown'}; accounts.next_accounts checked ${checked}). Preventive angle: no filing yet, no incumbent bookkeeper relationship likely.`
    };
  }

  return { eligible: false, reason: `unknown scan mode ${mode}` };
};

const chError = (message, statusCode = 502) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = 'COMPANIES_HOUSE_ERROR';
  return error;
};

// One paced scan: a single advanced-search page, then profile reads capped at
// profileCap. Returns { candidates, skipped, searched } — the route wraps it
// with the source-run receipt and the mint writer. Pure of DB; network via
// fetchImpl for tests.
export const runCompaniesHouseScan = async ({
  mode,
  sicCodes = [],
  apiKey,
  fetchImpl = fetch,
  now = new Date(),
  size = 50,
  profileCap = 25,
  dueWithinDays = 120
} = {}) => {
  if (!CH_SOURCE_BY_MODE[mode]) throw chError(`Unknown scan mode: ${mode}`, 400);
  if (!Array.isArray(sicCodes) || sicCodes.length === 0) {
    throw chError('At least one SIC code is required — a scan without an industry filter is a list, not a signal.', 400);
  }
  if (!apiKey) {
    throw chError('COMPANIES_HOUSE_API_KEY is not configured; the scan refuses honestly.', 503);
  }

  const headers = { Authorization: chAuthHeader(apiKey), Accept: 'application/json' };
  const searchUrl = buildAdvancedSearchUrl({ mode, sicCodes, size, now });
  const searchResponse = await fetchImpl(searchUrl, { headers });
  if (!searchResponse.ok) {
    const body = await searchResponse.text().catch(() => '');
    throw chError(`Companies House advanced search failed with ${searchResponse.status}: ${body.slice(0, 300)}`);
  }
  const searchPayload = await searchResponse.json();
  assertSearchShape(searchPayload);

  const candidates = [];
  const skipped = [];
  const items = searchPayload.items.slice(0, profileCap);
  if (searchPayload.items.length > profileCap) {
    skipped.push({ reason: `search returned ${searchPayload.items.length} companies; profile checks capped at ${profileCap} this run (pacing)` });
  }

  for (const item of items) {
    const profileResponse = await fetchImpl(buildProfileUrl(item.company_number), { headers });
    if (!profileResponse.ok) {
      skipped.push({ company_number: item.company_number, reason: `${item.company_name}: profile fetch failed with ${profileResponse.status}` });
      continue;
    }
    const profile = await profileResponse.json();
    const verdict = evaluateProfile({ profile, mode, now, dueWithinDays });
    if (!verdict.eligible) {
      skipped.push({ company_number: item.company_number, reason: verdict.reason });
      continue;
    }
    candidates.push({
      companyName: profile.company_name || item.company_name,
      companyNumber: item.company_number,
      jurisdiction: 'UK',
      website: null,
      contactEmail: null,
      sourceNote: verdict.signalNote,
      tier: 'green'
    });
  }

  return { candidates, skipped, searched: searchPayload.items.length };
};
