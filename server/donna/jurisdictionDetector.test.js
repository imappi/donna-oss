// Pure-function unit tests for the bank-statement jurisdiction
// detector. Synthetic inputs only — no real-statement fixtures
// required per the plan; per-jurisdiction full-statement fixtures land
// later, when there's a real client with a real statement.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectJurisdictionSignals,
  combineJurisdictionSignals,
  detectJurisdictionFromBankStatement,
  CONFIDENCE_RANK
} from './jurisdictionDetector.js';

// ── Individual signal kinds ────────────────────────────────────────────────

await test('bank name: DBS Bank → SG (high)', () => {
  const sigs = collectJurisdictionSignals({ bankName: 'DBS Bank Singapore Ltd' });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, 'bank_name');
  assert.equal(sigs[0].jurisdiction, 'sg');
  assert.equal(sigs[0].confidence, 'high');
});

await test('bank name: longest-match wins (HSBC UK vs bare HSBC)', () => {
  // Bare HSBC isn't in the table (multi-country brand) — only the
  // country-suffixed forms are. So "HSBC UK Plc" hits gb, but a bare
  // "HSBC Bank" produces no bank_name signal.
  const ukHit = collectJurisdictionSignals({ bankName: 'HSBC UK Plc' });
  assert.equal(ukHit[0].jurisdiction, 'gb');

  const noHit = collectJurisdictionSignals({ bankName: 'HSBC Bank' });
  assert.equal(noHit.length, 0);
});

await test('IBAN prefix: GB22 BARC → GB (high)', () => {
  const sigs = collectJurisdictionSignals({ accountNumber: 'GB22 BARC 2006 0512 3456 78' });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, 'iban');
  assert.equal(sigs[0].jurisdiction, 'gb');
  assert.equal(sigs[0].confidence, 'high');
});

await test('IBAN prefix: only registered prefixes count', () => {
  // CH = Switzerland, not in our table → no signal.
  const sigs = collectJurisdictionSignals({ accountNumber: 'CH93 0076 2011 6238 5295 7' });
  assert.equal(sigs.length, 0);
});

await test('currency: SGD → SG (medium), single-jurisdiction match', () => {
  const sigs = collectJurisdictionSignals({ currency: 'SGD' });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, 'currency');
  assert.equal(sigs[0].jurisdiction, 'sg');
  assert.equal(sigs[0].confidence, 'medium');
});

await test('currency: USD is non-discriminating → no signal', () => {
  // USD is widely used as a functional currency outside the US (HK,
  // SG, … all hold USD accounts). The table omits it on purpose.
  const sigs = collectJurisdictionSignals({ currency: 'USD' });
  assert.equal(sigs.length, 0);
});

await test('date format: MM/DD/YYYY → US (low)', () => {
  const sigs = collectJurisdictionSignals({ dateFormat: 'MM/DD/YYYY' });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].kind, 'date_format');
  assert.equal(sigs[0].jurisdiction, 'us');
  assert.equal(sigs[0].confidence, 'low');
});

await test('date format: DD/MM/YYYY is non-discriminating → no signal', () => {
  // DD/MM is the default everywhere except the US, so it's not a
  // jurisdiction-discriminating signal on its own.
  const sigs = collectJurisdictionSignals({ dateFormat: 'DD/MM/YYYY' });
  assert.equal(sigs.length, 0);
});

await test('tax id: UEN, ABN, EIN, GB VAT, NZBN, Companies House', () => {
  const cases = [
    { text: 'UEN: 201912345N', expect: 'sg' },
    { text: 'ABN 33 051 775 556', expect: 'au' },
    { text: 'EIN: 12-3456789', expect: 'us' },
    { text: 'VAT no. GB123456789', expect: 'gb' },
    { text: 'NZBN: 9429000001234', expect: 'nz' },
    { text: 'Company number: 12345678', expect: 'gb' }
  ];
  for (const { text, expect } of cases) {
    const sigs = collectJurisdictionSignals({ text });
    assert.equal(sigs.length, 1, `expected one signal for "${text}"`);
    assert.equal(sigs[0].kind, 'tax_id');
    assert.equal(sigs[0].jurisdiction, expect, `wrong jurisdiction for "${text}"`);
    assert.equal(sigs[0].confidence, 'high');
  }
});

await test('tax id: scans statementAddress + taxIdentifier as well', () => {
  const fromAddress = collectJurisdictionSignals({ statementAddress: 'ABN 33 051 775 556' });
  assert.equal(fromAddress[0].jurisdiction, 'au');

  const fromIdField = collectJurisdictionSignals({ taxIdentifier: 'UEN: 201912345N' });
  assert.equal(fromIdField[0].jurisdiction, 'sg');
});

// ── Combination logic ──────────────────────────────────────────────────────

await test('combine: single high signal → high', () => {
  const result = combineJurisdictionSignals([
    { kind: 'bank_name', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS' }
  ]);
  assert.equal(result.jurisdiction, 'sg');
  assert.equal(result.confidence, 'high');
});

await test('combine: two agreeing mediums → bumped to high', () => {
  // The "currency + bank-name + date-format agreement → high" case
  // generalised: any two signals on the same jurisdiction bump.
  const result = combineJurisdictionSignals([
    { kind: 'currency', jurisdiction: 'gb', confidence: 'medium', evidence: 'GBP' },
    { kind: 'date_format', jurisdiction: 'gb', confidence: 'low', evidence: 'DD/MM' }
  ]);
  assert.equal(result.jurisdiction, 'gb');
  assert.equal(result.confidence, 'high');
});

await test('combine: single medium → medium, single low → low', () => {
  assert.equal(
    combineJurisdictionSignals([{ kind: 'currency', jurisdiction: 'sg', confidence: 'medium', evidence: 'SGD' }]).confidence,
    'medium'
  );
  assert.equal(
    combineJurisdictionSignals([{ kind: 'date_format', jurisdiction: 'us', confidence: 'low', evidence: 'MM/DD' }]).confidence,
    'low'
  );
});

await test('combine: two HIGH signals on different jurisdictions → conflicted', () => {
  const result = combineJurisdictionSignals([
    { kind: 'tax_id', jurisdiction: 'au', confidence: 'high', evidence: 'ABN ...' },
    { kind: 'tax_id', jurisdiction: 'us', confidence: 'high', evidence: 'EIN ...' }
  ]);
  assert.equal(result.jurisdiction, null);
  assert.equal(result.confidence, 'conflicted');
  assert.match(result.evidence, /ABN/);
  assert.match(result.evidence, /EIN/);
});

await test('combine: HIGH + medium on different jurisdictions → HIGH wins (not conflicted)', () => {
  // Only HIGH-vs-HIGH triggers conflict. A medium on a competing
  // jurisdiction shouldn't dethrone a high.
  const result = combineJurisdictionSignals([
    { kind: 'bank_name', jurisdiction: 'sg', confidence: 'high', evidence: 'DBS' },
    { kind: 'currency', jurisdiction: 'hk', confidence: 'medium', evidence: 'HKD' }
  ]);
  assert.equal(result.jurisdiction, 'sg');
  assert.equal(result.confidence, 'high');
});

await test('combine: empty signals → null', () => {
  assert.equal(combineJurisdictionSignals([]), null);
  assert.equal(combineJurisdictionSignals(), null);
});

// ── End-to-end via the public entry point ──────────────────────────────────

await test('detect: DBS Bank + SGD + DD/MM → SG (high, via 2× agreement)', () => {
  const result = detectJurisdictionFromBankStatement({
    bankName: 'DBS Bank Singapore Ltd',
    currency: 'SGD',
    dateFormat: 'DD/MM/YYYY' // non-discriminating, no signal
  });
  assert.equal(result.jurisdiction, 'sg');
  assert.equal(result.confidence, 'high');
  assert.equal(result.signals.length, 2);
});

await test('detect: Chase + USD + MM/DD/YYYY → US (high, via date format + … wait, only one signal)', () => {
  // Chase isn't ambiguous (US-only in our table) — that gives one
  // high signal. USD doesn't contribute. MM/DD/YYYY is one low signal
  // for US. So we have 2 signals on US → bumped to high.
  const result = detectJurisdictionFromBankStatement({
    bankName: 'JPMorgan Chase',
    currency: 'USD',
    dateFormat: 'MM/DD/YYYY'
  });
  assert.equal(result.jurisdiction, 'us');
  assert.equal(result.confidence, 'high');
});

await test('detect: ABN + EIN in the same text → conflicted', () => {
  const result = detectJurisdictionFromBankStatement({
    text: 'Acme Holdings ABN 33 051 775 556 / EIN: 12-3456789'
  });
  assert.equal(result.jurisdiction, null);
  assert.equal(result.confidence, 'conflicted');
});

await test('detect: lone non-discriminating inputs → null', () => {
  // No signals at all from a non-discriminating set.
  assert.equal(
    detectJurisdictionFromBankStatement({
      bankName: 'Unknown Bank',
      currency: 'USD',
      dateFormat: 'DD/MM/YYYY'
    }),
    null
  );
});

await test('CONFIDENCE_RANK ordering', () => {
  assert.equal(CONFIDENCE_RANK.high > CONFIDENCE_RANK.medium, true);
  assert.equal(CONFIDENCE_RANK.medium > CONFIDENCE_RANK.low, true);
  assert.equal(CONFIDENCE_RANK.low > CONFIDENCE_RANK.conflicted, true);
});
