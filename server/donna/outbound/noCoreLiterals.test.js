// The no-core-literals lint (M0.1; execution plan A7 + risk #9 "US-first
// shape creep"). Runs from the FIRST pipeline commit and scans EVERY
// non-test module in server/donna/outbound/ — new pipeline files are covered
// automatically, so the guard is structural, not vigilance.
//
// What it refuses (the gap-12 debt classes, kept out of the new pipeline):
//   1. imports of transactionLlm.js and its SG core defaults
//      (TAX_TREATMENT_OPTIONS / XERO_ACCOUNT_OPTIONS) — packs name tax
//      vocabularies as data; core resolves them;
//   2. quoted ISO-4217 currency literals — the pack's currency.home is the
//      only home currency, the pipeline has no default;
//   3. quoted BCP-47 locale tags and locale-literal Intl/toLocale* calls —
//      locale is pack data (A7);
//   4. quoted bare language codes — language is a per-entity attribute
//      falling back to the pack default, never a code literal.
//
// Comments are stripped before scanning so prose may name examples; string
// literals are the enforcement surface. Tests and fixtures are excluded (a
// fixture IS pack data).

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUTBOUND_DIR = fileURLToPath(new URL('.', import.meta.url));

const pipelineModules = () =>
  readdirSync(OUTBOUND_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort();

// Strip // line comments and /* block */ comments while preserving line
// numbering (block comment interiors are blanked line by line). A minimal
// scanner — good enough for this repo's comment styles; string contents are
// deliberately KEPT (they are what we lint).
const stripComments = (source) => {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | single | double | template
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch; i += 1; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch;
      i += 1; continue;
    }
    // Inside a string: honour escapes, close on the matching quote.
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
    if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"')
      || (mode === 'template' && ch === '`')) mode = 'code';
    out += ch; i += 1;
  }
  return out;
};

const RULES = [
  {
    name: 'core-default import (transactionLlm SG defaults)',
    re: /from\s+['"][^'"]*transactionLlm(\.js)?['"]|\bTAX_TREATMENT_OPTIONS\b|\bXERO_ACCOUNT_OPTIONS\b/
  },
  {
    name: 'quoted currency literal (currency is pack data: currency.home)',
    re: /['"](USD|EUR|GBP|SGD|AUD|NZD|CAD|SEK|NOK|DKK)['"]/
  },
  {
    name: 'quoted locale tag (locale is pack data: locale.number_locale)',
    re: /['"][a-z]{2}-[A-Z]{2}['"]/
  },
  {
    name: 'locale-literal Intl/toLocale* call (locale is pack data)',
    re: /Intl\.(NumberFormat|DateTimeFormat)\s*\(\s*['"]|toLocale(Date|Time)?String\s*\(\s*['"]/
  },
  {
    name: 'quoted bare language code (language is entity data with a pack-default fallback)',
    re: /['"](en|fi|sv|de|fr|es)['"]/
  }
];

test('outbound pipeline modules carry no pack-bypassing core literals', () => {
  const modules = pipelineModules();
  assert.ok(modules.length > 0, 'expected at least one pipeline module in server/donna/outbound/');
  const violations = [];
  for (const file of modules) {
    const source = readFileSync(path.join(OUTBOUND_DIR, file), 'utf8');
    const code = stripComments(source);
    const lines = code.split('\n');
    lines.forEach((line, idx) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          violations.push(`${file}:${idx + 1} — ${rule.name}\n    ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(
    violations, [],
    `pack-bypassing literals in pipeline modules (move the value into packs/<cc>/manifest.json):\n${violations.join('\n')}`
  );
});

test('the lint covers every current pipeline module', () => {
  // Pin the scanned set so a reviewer sees coverage change in the diff when a
  // module is added — the set growing is expected; it silently shrinking is not.
  const modules = pipelineModules();
  assert.ok(modules.includes('packs.js'));
});

// ── gap 8: the `finland/` import edges, pinned ──────────────────────────────
//
// `outbound/` is the jurisdiction-neutral engine; `finland/` is a country
// module. An import in this direction puts a market UPSTREAM of the engine and
// is what `docs/donna-country-pack-contract-gaps.md` gap 8 tracks. The list
// below is an ALLOWLIST of the edges that remain, not a target: it may shrink
// freely, and growing it is a decision that has to be made in a diff rather
// than by adding an import.
//
// History: four edges. `ledger.js`'s was deleted 2026-07-27 by the `taxPosting`
// injection (#1129). `paidTruthGuard.js`'s and `referenceCapture.js`'s were
// deleted 2026-07-27 — the first by relocating jurisdiction-neutral arithmetic
// to `issuedInvoiceSettlementMath.js` with a re-export shim left in `finland/`,
// the second by routing through the single reference-scheme registry. What is
// left is `referenceSchemes.js`, and it is a DIFFERENT KIND of edge: the
// viitenumero check digit is genuinely Finnish statutory arithmetic, so the
// answer there is to invert the binding (register it) rather than relocate it,
// which is beyond the relocation bound and needs its own decision.
const FINLAND_IMPORT_ALLOWLIST = Object.freeze(['referenceSchemes.js']);

test('gap 8 — no outbound module imports finland/ except the pinned allowlist', () => {
  const offenders = [];
  for (const file of pipelineModules()) {
    const code = stripComments(readFileSync(path.join(OUTBOUND_DIR, file), 'utf8'));
    if (!/from\s+['"]\.\.\/finland\//.test(code)) continue;
    if (FINLAND_IMPORT_ALLOWLIST.includes(file)) continue;
    offenders.push(file);
  }
  assert.deepEqual(
    offenders, [],
    'these outbound modules import finland/, putting a country module upstream of '
    + `the engine (gap 8): ${offenders.join(', ')}`
  );
});

test('gap 8 — every allowlisted edge still exists (the list shrinks by deletion, not by rot)', () => {
  for (const file of FINLAND_IMPORT_ALLOWLIST) {
    const code = stripComments(readFileSync(path.join(OUTBOUND_DIR, file), 'utf8'));
    assert.match(
      code, /from\s+['"]\.\.\/finland\//,
      `${file} is on the gap-8 allowlist but no longer imports finland/ — remove it `
      + 'from the allowlist in the same commit that closed the edge.'
    );
  }
});
