// Jurisdiction → date format hint. Used by the extractor prompts to
// disambiguate locale-sensitive dates like "04/05/2026" — which a US
// reader treats as 5 April and a UK reader treats as 4 May.
//
// The hint is appended to the extractor's user-message turn as a
// supplementary instruction. The static `INSTRUCTIONS` system prompt
// stays untouched so the JSON schema contract is unchanged across
// jurisdictions.
//
// The hint we attach is narrow on purpose — it ONLY governs the
// ambiguous slash-separated case. ISO dates (YYYY-MM-DD), spelt-out
// dates ("4 May 2026"), printed statement periods, and unambiguous formats
// win regardless of jurisdiction. We don't try to override what the
// document plainly says.
//
// WHERE THE CONVENTION COMES FROM (RT-07, audit F-11 / F-23). Every
// authored country pack declares its convention in
// `packs/<cc>/manifest.json` → `locale.date_format` ('dmy' | 'mdy' |
// 'ymd', validated at pack load). The pack is the source of truth for
// any jurisdiction that has one — the engine follows the pack, never a
// code table that has to be kept in step by hand (the AE pack declared
// 'dmy' while this file's table had no AE entry, so UAE documents got no
// DD/MM hint). The legacy table below serves ONLY jurisdictions with no
// authored pack, and carries no entry a pack covers: one source of truth
// per jurisdiction, pinned by jurisdictionDate.test.js.

import { loadOutboundPack, resolvePackIdForJurisdiction } from './outbound/packs.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';

const KNOWN_CONVENTIONS = new Set(['dmy', 'mdy', 'ymd']);

// Legacy fallback — jurisdictions WITHOUT an authored pack only. Do not
// add a jurisdiction here once its pack exists; delete its row instead
// (the test enforces that no pack id appears in this table). Anything
// absent falls through to null (no hint emitted). Conservative on
// purpose: only hint when the convention is well-known.
export const LEGACY_JURISDICTION_TO_CONVENTION = Object.freeze({
  // DD/MM/YYYY-using jurisdictions.
  IE: 'dmy',
  AU: 'dmy',
  NZ: 'dmy',
  IN: 'dmy',
  ZA: 'dmy',
  MY: 'dmy',
  HK: 'dmy',
  FR: 'dmy',
  DE: 'dmy',
  ES: 'dmy',
  IT: 'dmy',
  PT: 'dmy',
  NL: 'dmy',
  BE: 'dmy',
  // MM/DD/YYYY-using jurisdictions.
  PH: 'mdy'
});

const normalize = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim().toUpperCase();
  if (!trimmed) return null;
  // Some firms store the country name spelt out — map the common
  // ones. Anything we don't recognise returns null.
  const aliases = {
    'UNITED KINGDOM': 'UK',
    'GREAT BRITAIN': 'GB',
    BRITAIN: 'GB',
    ENGLAND: 'GB',
    SCOTLAND: 'GB',
    WALES: 'GB',
    IRELAND: 'IE',
    AUSTRALIA: 'AU',
    'NEW ZEALAND': 'NZ',
    SINGAPORE: 'SG',
    INDIA: 'IN',
    'SOUTH AFRICA': 'ZA',
    MALAYSIA: 'MY',
    'HONG KONG': 'HK',
    FRANCE: 'FR',
    GERMANY: 'DE',
    SPAIN: 'ES',
    ITALY: 'IT',
    PORTUGAL: 'PT',
    NETHERLANDS: 'NL',
    BELGIUM: 'BE',
    'UNITED STATES': 'US',
    USA: 'US',
    AMERICA: 'US',
    PHILIPPINES: 'PH',
    FINLAND: 'FI',
    SUOMI: 'FI',
    'UNITED ARAB EMIRATES': 'AE',
    UAE: 'AE',
    EMIRATES: 'AE'
  };
  if (aliases[trimmed]) return aliases[trimmed];
  return trimmed;
};

// The pack's declared convention for a normalised jurisdiction code, or
// null when no pack is authored for it. Mirrors
// homeCurrencyForJurisdiction in outbound/packs.js: the stored alias
// ('UK' → 'gb') goes through the shared normalizeJurisdictionKey so the
// hint and the book currency resolve the same pack. A pack that fails
// to load resolves null here (the pack suite is where a broken manifest
// fails loudly); the caller then consults the legacy table, which by
// construction has no row for a pack-covered jurisdiction, so a broken
// pack yields NO hint rather than a stale one.
const packDateFormatConvention = (normalised, { packsRoot } = {}) => {
  const loadOpts = packsRoot === undefined ? {} : { packsRoot };
  const key = normalizeJurisdictionKey(normalised) || normalised;
  try {
    const packId = resolvePackIdForJurisdiction(key, loadOpts);
    if (!packId) return null;
    const convention = loadOutboundPack(packId, loadOpts)?.locale?.date_format;
    return KNOWN_CONVENTIONS.has(convention) ? convention : null;
  } catch {
    return null;
  }
};

// `packsRoot` exists for tests that stage a synthetic pack tree; callers
// in the pipeline never pass it.
export const dateFormatConventionForJurisdiction = (jurisdiction, { packsRoot } = {}) => {
  const norm = normalize(jurisdiction);
  if (!norm) return null;
  return packDateFormatConvention(norm, { packsRoot })
    || LEGACY_JURISDICTION_TO_CONVENTION[norm]
    || null;
};

const SLASH_DATE_EXAMPLE = '04/05/2026';
const exampleCalendarDate = (convention) => {
  const [first, second, year] = SLASH_DATE_EXAMPLE.split('/').map(Number);
  const [day, month] = convention === 'dmy' ? [first, second] : [second, first];
  // Render one calendar meaning from the convention instead of maintaining
  // a second, independently authored date in the prompt. UTC keeps this
  // example independent of the appliance's timezone.
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(Date.UTC(year, month - 1, day)));
};

// Returns a short prompt fragment to append after the per-extractor
// "Extract the … per the schema" turn. A 'ymd' convention has no
// ambiguous slash case to disambiguate, so it emits nothing.
export const dateFormatHintFor = (jurisdiction, { packsRoot } = {}) => {
  const convention = dateFormatConventionForJurisdiction(jurisdiction, { packsRoot });
  if (convention === 'dmy') {
    return `Locale note: this document is for a DD/MM/YYYY-convention jurisdiction. When the printed date is slash-separated and ambiguous (e.g. "${SLASH_DATE_EXAMPLE}"), read it as day/month/year (${exampleCalendarDate(convention)}), not month/day/year. Printed statement periods and unambiguous formats — ISO dates, spelt-out months, or dates where either number exceeds 12 — override this hint.`;
  }
  if (convention === 'mdy') {
    return `Locale note: this document is for a MM/DD/YYYY-convention jurisdiction. When the printed date is slash-separated and ambiguous (e.g. "${SLASH_DATE_EXAMPLE}"), read it as month/day/year (${exampleCalendarDate(convention)}), not day/month/year. Printed statement periods and unambiguous formats — ISO dates, spelt-out months, or dates where either number exceeds 12 — override this hint.`;
  }
  return '';
};
