// Tests for the jurisdiction → date-format mapping. Two layers:
//
//   1. `dateFormatConventionForJurisdiction(jurisdiction)` returns a
//      categorical 'dmy' / 'mdy' / null. Pinning this directly means
//      we don't have to grep regex'es over the prompt fragments to
//      verify a new jurisdiction takes the right path.
//
//   2. `dateFormatHintFor(jurisdiction)` returns the actual prompt
//      string. Tested for non-empty/empty and for the
//      always-true-regardless-of-locale escape clauses (ISO dates,
//      spelt-out months, either-number-exceeds-12, printed periods) so a prompt
//      tweak that breaks those guards trips CI.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listAvailablePackIds, loadOutboundPack } from './outbound/packs.js';
import {
  LEGACY_JURISDICTION_TO_CONVENTION,
  dateFormatConventionForJurisdiction,
  dateFormatHintFor
} from './jurisdictionDate.js';

const PACKS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs');

describe('dateFormatConventionForJurisdiction', () => {
  test('DD/MM/YYYY jurisdictions resolve to "dmy"', () => {
    for (const j of [
      'UK', 'GB', 'IE', 'AU', 'NZ', 'SG', 'IN', 'ZA', 'MY', 'HK',
      'FR', 'DE', 'ES', 'IT', 'PT', 'NL', 'BE'
    ]) {
      assert.equal(dateFormatConventionForJurisdiction(j), 'dmy', `${j} → dmy`);
    }
  });

  test('MM/DD/YYYY jurisdictions resolve to "mdy"', () => {
    assert.equal(dateFormatConventionForJurisdiction('US'), 'mdy');
    assert.equal(dateFormatConventionForJurisdiction('PH'), 'mdy');
  });

  test('case-insensitive — lowercase and mixed-case still resolve', () => {
    assert.equal(dateFormatConventionForJurisdiction('uk'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('Gb'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('us'), 'mdy');
  });

  test('whitespace tolerated', () => {
    assert.equal(dateFormatConventionForJurisdiction('  UK  '), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('\tUS\n'), 'mdy');
  });

  test('common spelt-out names map to canonical codes', () => {
    assert.equal(dateFormatConventionForJurisdiction('United Kingdom'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('Singapore'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('Australia'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('United States'), 'mdy');
    assert.equal(dateFormatConventionForJurisdiction('USA'), 'mdy');
  });

  test('unknown / unset returns null (no hint)', () => {
    assert.equal(dateFormatConventionForJurisdiction(null), null);
    assert.equal(dateFormatConventionForJurisdiction(undefined), null);
    assert.equal(dateFormatConventionForJurisdiction(''), null);
    assert.equal(dateFormatConventionForJurisdiction('  '), null);
    assert.equal(dateFormatConventionForJurisdiction('Atlantis'), null);
    assert.equal(dateFormatConventionForJurisdiction('XX'), null);
  });
});

describe('dateFormatHintFor', () => {
  test('DD/MM jurisdictions emit a DD/MM hint', () => {
    const hint = dateFormatHintFor('UK');
    assert.match(hint, /DD\/MM\/YYYY/);
    assert.match(hint, /day\/month\/year/);
  });

  test('MM/DD jurisdictions emit a MM/DD hint', () => {
    const hint = dateFormatHintFor('US');
    assert.match(hint, /MM\/DD\/YYYY/);
    assert.match(hint, /month\/day\/year/);
  });

  test('the emitted slash example has the correct calendar meaning for AE, GB and US', () => {
    // Read the example from the production prompt, then check calendar
    // components against fixed evidence. This catches reversed examples even
    // when the format label itself is correct.
    for (const [jurisdiction, expected] of [
      ['AE', { year: 2026, month: 5, day: 4 }],
      ['GB', { year: 2026, month: 5, day: 4 }],
      ['US', { year: 2026, month: 4, day: 5 }]
    ]) {
      const hint = dateFormatHintFor(jurisdiction);
      assert.match(hint, /"04\/05\/2026"/);
      const writtenDate = hint.match(/read it as [a-z/]+ \((\d+) ([A-Za-z]+) (\d{4})\)/);
      assert.ok(writtenDate, `${jurisdiction} has a calendar example`);
      const [, day, monthName, year] = writtenDate;
      const month = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'].indexOf(monthName) + 1;
      assert.deepEqual({ year: Number(year), month, day: Number(day) }, expected, jurisdiction);
    }
  });

  test('both hints carry the unambiguous-format escape clauses', () => {
    // The hint MUST tell the LLM that ISO dates, spelt-out months,
    // printed statement periods, and dates with either number > 12
    // override the locale rule. A prompt change that drops these clauses would silently
    // mis-extract dates when the document is plainly unambiguous.
    for (const j of ['AE', 'GB', 'US']) {
      const hint = dateFormatHintFor(j);
      assert.match(hint, /ISO dates/i,
        `${j} hint must mention ISO dates as an override`);
      assert.match(hint, /spelt-out months/i,
        `${j} hint must mention spelt-out months`);
      assert.match(hint, /either number exceeds 12/i,
        `${j} hint must mention the >12 unambiguous case`);
      assert.match(hint, /Printed statement periods .* override this hint/,
        `${j} hint must yield to the document's printed period`);
    }
  });

  test('unknown jurisdiction returns empty string (no hint attached)', () => {
    assert.equal(dateFormatHintFor(null), '');
    assert.equal(dateFormatHintFor(undefined), '');
    assert.equal(dateFormatHintFor(''), '');
    assert.equal(dateFormatHintFor('  '), '');
    assert.equal(dateFormatHintFor('XX'), '');
    assert.equal(dateFormatHintFor('Atlantis'), '');
  });

  test('hints stay under 500 chars — they\'re appended to every parse', () => {
    // Cheap budget for the prompt addition. If a future change pushes
    // these into kilobyte territory we'd want to revisit (token cost
    // multiplied across every parse adds up).
    assert.ok(dateFormatHintFor('UK').length < 500);
    assert.ok(dateFormatHintFor('US').length < 500);
  });
});

// ─── RT-07: the convention comes from the pack, not a code table ───────
//
// Every authored pack declares `locale.date_format` in its manifest
// (packs/<cc>/manifest.json). The engine used to ignore it and keep a
// hand-written jurisdiction → convention table with no AE entry, so UAE
// documents got no DD/MM hint (audit F-11 / F-23). The pack is now the
// source of truth for every jurisdiction that has one; the table only
// serves jurisdictions with no authored pack.

describe('pack-declared date convention (RT-07)', () => {
  test('every authored pack yields its declared locale.date_format', () => {
    for (const packId of listAvailablePackIds()) {
      const declared = loadOutboundPack(packId).locale.date_format;
      assert.equal(
        dateFormatConventionForJurisdiction(packId.toUpperCase()),
        declared,
        `${packId} → ${declared} (declared by packs/${packId}/manifest.json)`
      );
    }
  });

  test('AE resolves to dmy and gets the DD/MM hint (the F-23 defect)', () => {
    assert.equal(dateFormatConventionForJurisdiction('AE'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('ae'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('United Arab Emirates'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('UAE'), 'dmy');
    const hint = dateFormatHintFor('AE');
    assert.match(hint, /DD\/MM\/YYYY/);
    assert.match(hint, /day\/month\/year/);
  });

  test('FI resolves to dmy from its pack (it was never in the code table)', () => {
    assert.equal(dateFormatConventionForJurisdiction('FI'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('Finland'), 'dmy');
    assert.match(dateFormatHintFor('fi'), /DD\/MM\/YYYY/);
  });

  test('the stored UK alias reaches the gb pack', () => {
    // clients.jurisdiction may carry 'UK' (the stored alias for gb); the
    // pack resolver keys on 'gb'. The alias is the shared
    // normalizeJurisdictionKey, so the hint follows the pack for both.
    assert.equal(dateFormatConventionForJurisdiction('UK'), 'dmy');
    assert.equal(dateFormatConventionForJurisdiction('United Kingdom'), 'dmy');
  });

  test('the pack wins over the legacy table; a ymd pack yields no slash hint', () => {
    // A synthetic packs root: the real gb manifest with only
    // locale.date_format changed. Proves the value is READ from the pack
    // (a table would still say dmy) and that the schema's third
    // convention, ymd, is honoured as "no ambiguous slash case to hint".
    const root = mkdtempSync(path.join(tmpdir(), 'rt07-packs-'));
    try {
      const manifest = JSON.parse(readFileSync(path.join(PACKS_ROOT, 'gb', 'manifest.json'), 'utf8'));
      mkdirSync(path.join(root, 'gb'));
      manifest.locale.date_format = 'mdy';
      writeFileSync(path.join(root, 'gb', 'capabilities.json'), JSON.stringify({ outbound: { manifest: 'manifest.json' } }));
      writeFileSync(path.join(root, 'gb', 'manifest.json'), JSON.stringify(manifest));
      assert.equal(dateFormatConventionForJurisdiction('GB', { packsRoot: root }), 'mdy');
      assert.match(dateFormatHintFor('UK', { packsRoot: root }), /MM\/DD\/YYYY/);

      const ymdRoot = path.join(root, 'ymd');
      mkdirSync(path.join(ymdRoot, 'gb'), { recursive: true });
      manifest.locale.date_format = 'ymd';
      writeFileSync(path.join(ymdRoot, 'gb', 'capabilities.json'), JSON.stringify({ outbound: { manifest: 'manifest.json' } }));
      writeFileSync(path.join(ymdRoot, 'gb', 'manifest.json'), JSON.stringify(manifest));
      assert.equal(dateFormatConventionForJurisdiction('GB', { packsRoot: ymdRoot }), 'ymd');
      assert.equal(dateFormatHintFor('GB', { packsRoot: ymdRoot }), '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a jurisdiction with no authored pack falls back to the legacy table', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rt07-nopacks-'));
    try {
      // Empty packs root: nothing resolves via a pack, so only the table
      // answers. PH remains table-only; SG/GB/US are pack-only now.
      assert.equal(dateFormatConventionForJurisdiction('SG', { packsRoot: root }), null);
      assert.equal(dateFormatConventionForJurisdiction('PH', { packsRoot: root }), 'mdy');
      assert.equal(dateFormatConventionForJurisdiction('AE', { packsRoot: root }), null);
      assert.equal(dateFormatConventionForJurisdiction('GB', { packsRoot: root }), null);
      assert.equal(dateFormatConventionForJurisdiction('US', { packsRoot: root }), null);
      for (const jurisdiction of ['AE', 'GB', 'US', 'SG']) {
        assert.equal(dateFormatHintFor(jurisdiction, { packsRoot: root }), '',
          `${jurisdiction} without its policy must not receive a foreign convention`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the legacy table carries no jurisdiction an authored pack covers', () => {
    // One source of truth per jurisdiction: once a pack is authored its
    // table entry is deleted, so a pack edit can never be shadowed.
    for (const packId of listAvailablePackIds()) {
      assert.equal(
        LEGACY_JURISDICTION_TO_CONVENTION[packId.toUpperCase()],
        undefined,
        `${packId.toUpperCase()} must not be in the legacy table`
      );
    }
    assert.equal(LEGACY_JURISDICTION_TO_CONVENTION.UK, undefined);
  });
});
